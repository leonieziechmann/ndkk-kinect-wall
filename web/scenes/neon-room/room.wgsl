// The virtual room, computed per screen pixel from the view ray: a dark, glossy floor with a neon
// grid that fades into fog, a glowing horizon, a ring of light under every person, the field of
// view of the sensor on the floor, the reflection of the people. Then the person points (additive
// buffer, tone-mapped) and their glow on top, vignette and dither.

struct Room {
  invViewProj: mat4x4f,
  eye: vec4f,      // xyz: eye (room, m), w: time (s)
  res: vec4f,      // width, height, 1/width, 1/height
  grid: vec4f,     // rgb, strength
  horizon: vec4f,  // rgb, strength
  sky: vec4f,      // rgb (top of the sky), stage glow
  ground: vec4f,   // rgb (floor), reflection strength
  post: vec4f,     // gain, glow, vignette, field-of-view lines
  sensor: vec4f,   // x, z of the sensor on the floor, forward angle (rad), half field of view (rad)
  extra: vec4f,    // range (m), ring radius (m), grid size (m), ring strength
  persons: array<vec4f, 16>, // x, z (room), alpha, slot
  colors: array<vec4f, 17>,
};
@group(0) @binding(0) var<uniform> R: Room;
@group(0) @binding(1) var acc: texture_2d<f32>;
@group(0) @binding(2) var glow: texture_2d<f32>;
@group(0) @binding(3) var refl: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;

@vertex
fn vsFull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}

// anti-aliased grid lines: 1 on a line, 0 between; w = fwidth of the grid coordinate
fn gridLine(g: vec2f, w: vec2f, thickness: f32) -> f32 {
  let a = abs(fract(g - 0.5) - 0.5) / max(w, vec2f(1e-5));
  let l = 1.0 - clamp(min(a.x, a.y) - thickness, 0.0, 1.0);
  // lines thinner than a pixel fade out instead of aliasing
  return l * clamp(1.0 - 0.6 * max(w.x, w.y), 0.0, 1.0);
}

fn tonemap(x: vec3f, gain: f32) -> vec3f {
  return vec3f(1.0) - exp(-gain * x);
}

@fragment
fn fsRoom(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy * R.res.zw;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let pn = R.invViewProj * vec4f(ndc, 0.0, 1.0);
  let pf = R.invViewProj * vec4f(ndc, 1.0, 1.0);
  let ro = R.eye.xyz;
  let rd = normalize(pf.xyz / pf.w - pn.xyz / pn.w);
  let time = R.eye.w;

  // floor hit (computed everywhere: the derivatives below must not sit in a branch)
  let down = rd.y < -1e-4;
  let t = select(1e4, -ro.y / min(rd.y, -1e-4), down);
  let P = ro + rd * min(t, 300.0);
  let g1 = P.xz / R.extra.z;
  let g2 = P.xz / (R.extra.z * 4.0);
  let w1 = fwidth(g1);
  let w2 = fwidth(g2);
  let minor = gridLine(g1, w1, 0.0);
  let major = gridLine(g2, w2, 0.6);
  let sensorDist = length(P.xz - R.sensor.xy);
  let fovPx = max(fwidth(sensorDist), 0.002);

  // sky: dark, a glowing band at the horizon
  let up = max(rd.y, 0.0);
  var col = mix(R.horizon.rgb * 0.12, R.sky.rgb, smoothstep(0.0, 0.45, up));
  col += R.horizon.rgb * R.horizon.w * (exp(-abs(rd.y) * 26.0) * 0.9 + exp(-abs(rd.y) * 5.0) * 0.18);

  if (down) {
    let fog = exp(-t * 0.055);
    var floorCol = R.ground.rgb;
    // light pool around the people
    var stage = 0.0;
    var rings = vec3f(0.0);
    for (var k = 0u; k < 16u; k++) {
      let pp = R.persons[k];
      if (pp.z <= 0.001) { continue; }
      let c = R.colors[u32(pp.w)].rgb;
      let dv = P.xz - pp.xy;
      let dist = length(dv);
      let rr = R.extra.y;
      // the ring: a thin bright line, a soft halo, ticks turning slowly
      let line = exp(-pow((dist - rr) / 0.012, 2.0));
      let halo = exp(-pow((dist - rr) / 0.07, 2.0)) * 0.35;
      let inner = exp(-pow(dist / (rr * 0.9), 2.0)) * 0.22;
      let ang = atan2(dv.y, dv.x) + time * 0.35 + f32(k);
      let ticks = step(0.55, fract(ang * 24.0 / 6.2831853)) * exp(-pow((dist - rr * 1.22) / 0.018, 2.0)) * 0.8;
      rings += c * (line * 1.6 + halo + inner + ticks) * pp.z * R.extra.w;
      stage += exp(-dist * dist / 2.5) * pp.z;
    }
    floorCol += R.grid.rgb * (minor * 0.35 + major * 0.9) * R.grid.w * (0.55 + 0.45 * min(stage, 1.0) * R.sky.w);
    floorCol += R.grid.rgb * 0.05 * min(stage, 1.5) * R.sky.w;
    floorCol += rings;

    // field of view of the sensor: two lines and the arc at its range
    if (R.post.w > 0.0) {
      let dv = P.xz - R.sensor.xy;
      let dist = sensorDist;
      let ang = atan2(dv.x, dv.y) - R.sensor.z; // 0 = straight ahead of the sensor
      let px = fovPx;
      let inside = step(abs(ang), R.sensor.w) * step(dist, R.extra.x);
      let side = exp(-pow((abs(ang) - R.sensor.w) * dist / max(px * 1.5, 0.006), 2.0)) * step(dist, R.extra.x);
      let arc = exp(-pow((dist - R.extra.x) / max(px * 1.5, 0.006), 2.0)) * step(abs(ang), R.sensor.w);
      floorCol += vec3f(0.35, 0.75, 1.0) * (side + arc) * 0.45 * R.post.w;
      floorCol += vec3f(0.35, 0.75, 1.0) * inside * 0.018 * R.post.w;
    }

    // reflection of the people (mirrored render), stronger at grazing angles
    let rf = textureSampleLevel(refl, samp, uv, 0.0).rgb;
    let fresnel = 0.35 + 0.65 * pow(1.0 - min(abs(rd.y) * 1.2, 1.0), 3.0);
    floorCol += tonemap(rf, R.post.x) * R.ground.w * fresnel;

    // into the fog towards the horizon
    col = mix(col, floorCol, fog);
  }

  // the people: additive points, tone-mapped, and their glow
  let a = textureLoad(acc, vec2i(fc.xy), 0).rgb;
  let g = textureSampleLevel(glow, samp, uv, 0.0).rgb;
  let pts = tonemap(a, R.post.x);
  col = col * (1.0 - 0.8 * max(pts.r, max(pts.g, pts.b))) + pts;
  col += tonemap(g, R.post.x) * R.post.y;

  // vignette and dither
  let f = uv - 0.5;
  col *= 1.0 - R.post.z * dot(f, f) * 1.6;
  col += (hash(fc.xy + fract(time) * 31.0) - 0.5) / 255.0;
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}
