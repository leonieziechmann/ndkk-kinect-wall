// Person points: one instance per person pixel (personIndexBuffer), drawn as a soft dot. Lit with
// the surface normal from the neighboring depth pixels (shows folds, faces, hands), a rim light
// towards the viewer, the slot color and a scan band. With U.p0.w = 1 the same points are drawn
// mirrored below the floor (the reflection).

struct Uniforms {
  viewProj: mat4x4f, // room -> clip
  kin: mat4x4f,      // Kinect camera frame (mm) -> room (m, floor y = 0)
  eye: vec4f,        // xyz: eye in the room, w: time (s)
  viewport: vec4f,   // target width, height, 1/width, 1/height
  p0: vec4f,         // dot fill, fx of the depth camera, focal length of the view (px), mirror
  p1: vec4f,         // gain, IR detail, scan height (m, < 0 = off), floor fade (m)
  p2: vec4f,         // reflection strength, normal step (px), white mix, rim
  light: vec4f,      // direction to the key light (room), w: ambient
  colors: array<vec4f, 17>,
};
@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var<storage, read> indices: array<u32>; // person pixels
@group(0) @binding(2) var<storage, read> pdepth: array<u32>;  // u16 mm pairs, person pixels only
@group(0) @binding(3) var<storage, read> plabel: array<u32>;  // u8 slot quads
@group(0) @binding(4) var<storage, read> rays: array<vec2f>;  // undistorted ray per pixel
@group(0) @binding(5) var<storage, read> ir: array<u32>;      // u8 infrared quads

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
  @location(2) radiusPx: f32,
};

const CORNERS = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
                                vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));

fn depthAt(i: u32) -> f32 {
  let w = pdepth[i >> 1u];
  return f32(select(w & 0xffffu, w >> 16u, (i & 1u) == 1u));
}

fn labelAt(i: u32) -> u32 {
  return (plabel[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu;
}

fn irAt(i: u32) -> f32 {
  return f32((ir[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu) / 255.0;
}

fn camPoint(i: u32, d: f32) -> vec3f {
  let r = rays[i];
  return vec3f(r.x * d, r.y * d, d);
}

// neighbor at (u + du, v + dv) of the same person, depth-consistent: its point, else the center
fn neighbor(u: i32, v: i32, du: i32, dv: i32, slot: u32, d: f32, center: vec3f) -> vec3f {
  let x = u + du;
  let y = v + dv;
  if (x < 0 || x > 511 || y < 0 || y > 423) { return center; }
  let j = u32(y * 512 + x);
  let dj = depthAt(j);
  if (dj == 0.0 || labelAt(j) != slot || abs(dj - d) > 60.0 + 0.03 * d) { return center; }
  return camPoint(j, dj);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  var out: VSOut;
  out.pos = vec4f(0.0, 0.0, -1.0, 1.0); // outside the clip volume: not drawn
  out.uv = vec2f(0.0);
  out.color = vec3f(0.0);
  out.radiusPx = 1.0;
  let i = indices[ii];
  let d = depthAt(i);
  let slot = labelAt(i);
  if (d == 0.0 || slot == 0u || slot > 16u) { return out; }
  let u = i32(i % 512u);
  let v = i32(i / 512u);
  let p = camPoint(i, d);

  // surface normal (camera frame) from the neighbors, facing the sensor
  let s = i32(U.p2.y);
  let tx = neighbor(u, v, s, 0, slot, d, p) - neighbor(u, v, -s, 0, slot, d, p);
  let ty = neighbor(u, v, 0, s, slot, d, p) - neighbor(u, v, 0, -s, slot, d, p);
  var n = cross(tx, ty);
  if (dot(n, n) < 1e-6) { n = -p; }
  n = normalize(n);
  if (dot(n, p) > 0.0) { n = -n; }

  let mirror = U.p0.w > 0.5;
  var room = (U.kin * vec4f(p, 1.0)).xyz;
  var nr = normalize((U.kin * vec4f(n, 0.0)).xyz);
  let height = room.y;
  if (mirror) {
    room.y = -room.y;
    nr.y = -nr.y;
  }
  let clip = U.viewProj * vec4f(room, 1.0);
  if (clip.w < 0.05) { return out; }

  // dot radius: a share of the footprint of one sensor pixel, projected into the view
  var rPx = U.p0.x * (d / U.p0.y) * 0.001 * U.p0.z / clip.w;
  var energy = 1.0;
  let minPx = 0.75;
  if (rPx < minPx) { // tiny dots: minimum size with less light instead of flickering
    energy = rPx * rPx / (minPx * minPx);
    rPx = minPx;
  }

  // light: key light + ambient, rim towards the viewer, slot color going white where bright
  let base = U.colors[slot].rgb;
  let view = normalize(U.eye.xyz - room);
  let diffuse = max(dot(nr, U.light.xyz), 0.0);
  let facing = max(dot(nr, view), 0.0);
  let rim = pow(1.0 - facing, 2.2) * U.p2.w;
  var col = base * (U.light.w + diffuse) + mix(base, vec3f(1.0), 0.5) * rim;
  col = mix(col, vec3f(dot(col, vec3f(0.33))), -0.15) + vec3f(1.0) * U.p2.z * diffuse * diffuse;
  col *= mix(1.0, 0.55 + 0.9 * irAt(i), U.p1.y);
  // scan band moving up the bodies
  if (U.p1.z >= 0.0) {
    let b = (height - U.p1.z) / 0.035;
    col += mix(base, vec3f(1.0), 0.6) * exp(-b * b) * 1.4;
  }
  // fade into the floor (busts at a desk end softly, feet glow into their ring)
  energy *= smoothstep(-0.01, U.p1.w, height);
  if (mirror) {
    energy *= U.p2.x * exp(-height / 0.55);
  }

  let corner = CORNERS[vi];
  let extent = rPx + 1.0; // one extra pixel for the anti-aliased edge
  out.pos = vec4f(clip.xy + corner * extent * 2.0 * U.viewport.zw * clip.w, clip.z, clip.w);
  out.uv = corner * (extent / rPx);
  out.color = col * energy;
  out.radiusPx = rPx;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let r = length(in.uv);
  let cover = clamp((1.0 - r) * in.radiusPx + 0.5, 0.0, 1.0);
  if (cover <= 0.0) { discard; }
  let dome = 0.75 + 0.25 * sqrt(max(0.0, 1.0 - r * r)); // a slightly rounded dot
  return vec4f(in.color * cover * dome, 1.0);
}
