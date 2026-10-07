// Everything that touches the Kinect data directly, once per Kinect frame:
//   prep      depth + IR -> nearness, IR, depth at full resolution (camera image)
//   nearest   points -> nearest distance per wall cell
//   project   points of the front surface per wall cell -> number, distance, IR
//   scene     optical flow of the camera image (pixels) + depth -> 3D motion in m/s, put on the wall
//   collect   wall cells -> wall image (what is there, how near)
//   vcollect  wall cells -> wall motion (mean velocity per cell)
// Points are projected straight (orthographically) onto the wall plane: a person covers as much wall
// as they are wide and their speed counts in meters, whether they stand near the sensor or far away.
@group(0) @binding(1) var depthTex: texture_2d<f32>; // meters, 0 = no measurement
@group(0) @binding(2) var lutTex: texture_2d<f32>;   // rg: ray per pixel, point = (x*z, y*z, z)
@group(0) @binding(3) var irTex: texture_2d<f32>;
// per wall cell: nearest distance (mm), number of front points, sum of their distances (mm), sum of IR (0..255)
@group(0) @binding(4) var<storage, read_write> cells: array<atomic<u32>>;
@group(0) @binding(5) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var flowTex: texture_2d<f32>; // camera.wgsl lkFinal: rg flow (pixels/frame), a mean |flow|
@group(0) @binding(7) var sigTex: texture_2d<f32>;  // camera.wgsl camSignal: b front depth now, a before
// per wall cell: number of motion samples, sums of velocity x, y and of 3D speed (mm/s)
@group(0) @binding(8) var<storage, read_write> vcells: array<atomic<i32>>;
@group(0) @binding(9) var motionOut: texture_storage_2d<rgba16float, write>;

const FRONT_MM = 150u;
const EMPTY = 0xffffffffu;

fn gridSize() -> vec2u { return vec2u(u32(U.gridW), u32(U.gridH)); }
fn lut(p: vec2i) -> vec2f { return textureLoad(lutTex, clamp(p, vec2i(0), vec2i(textureDimensions(lutTex)) - 1), 0).rg; }

// ---- camera image: r nearness, g IR, b depth (m). Single pixels without a measurement are filled
// from their neighbours (they flicker at edges and would look like motion); larger holes stay empty.
@compute @workgroup_size(8, 8)
fn prep(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(depthTex));
  let p = vec2i(id.xy);
  if (p.x >= size.x || p.y >= size.y) { return; }
  var d = textureLoad(depthTex, p, 0).r;
  if (d <= 0.1) {
    var sum = 0.0;
    var n = 0.0;
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let q = textureLoad(depthTex, clamp(p + vec2i(x, y), vec2i(0), size - 1), 0).r;
        if (q > 0.1) {
          sum += q;
          n += 1.0;
        }
      }
    }
    d = select(0.0, sum / max(n, 1.0), n >= 3.0);
  }
  let near = select(0.0, nearness(d), d > 0.1);
  textureStore(outTex, p, vec4f(near, textureLoad(irTex, p, 0).r, d, 1.0));
}

struct Hit { cell: u32, mm: u32, ok: bool };
// camera point (m) -> wall cell and distance in mm; ok = inside the wall and the zone
fn hitWall(cam: vec3f) -> Hit {
  var h = Hit(0u, 0u, false);
  let w = toWall(cam);
  if (w.z < U.zoneNear || w.z > U.zoneFar || w.y < U.floorCut) { return h; }
  let uv = wallUv(w.xy);
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) { return h; }
  let g = vec2u(uv * vec2f(gridSize()));
  h.cell = g.y * gridSize().x + g.x;
  h.mm = u32(w.z * 1000.0);
  h.ok = true;
  return h;
}
fn hitPixel(p: vec2i) -> Hit {
  let z = textureLoad(depthTex, p, 0).r;
  if (z < 0.1) { return Hit(0u, 0u, false); }
  return hitWall(vec3f(lut(p) * z, z));
}

// ---- wall image, pass 1: nearest point per cell. Only the front-most surface of a cell counts
// (points up to FRONT_MM behind the nearest one): a person in front of furniture is not mixed with it.
@compute @workgroup_size(8, 8)
fn nearest(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(depthTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let h = hitPixel(vec2i(id.xy));
  if (h.ok) { atomicMin(&cells[h.cell * 4u], h.mm); }
}

// ---- wall image, pass 2: the points of the front surface
@compute @workgroup_size(8, 8)
fn project(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(depthTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  let h = hitPixel(p);
  if (!h.ok) { return; }
  let i = h.cell * 4u;
  if (h.mm > atomicLoad(&cells[i]) + FRONT_MM) { return; }
  atomicAdd(&cells[i + 1u], 1u);
  atomicAdd(&cells[i + 2u], h.mm);
  atomicAdd(&cells[i + 3u], u32(textureLoad(irTex, p, 0).r * 255.0));
}

// ---- 3D motion: one sample per optical flow cell of the camera image
@compute @workgroup_size(8, 8)
fn scene(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(flowTex));
  let p = vec2i(id.xy);
  if (p.x >= size.x || p.y >= size.y) { return; }
  let f = textureLoad(flowTex, p, 0);
  // the optical flow spreads the motion of an edge over its window (9x9 cells) on both sides; it
  // belongs to what is in front (the person, not the wall behind), so take the nearest depth around
  var z = 1e9;
  for (var y = -4; y <= 4; y++) {
    for (var x = -4; x <= 4; x++) {
      let zz = textureLoad(sigTex, clamp(p + vec2i(x, y), vec2i(0), size - 1), 0).b;
      if (zz > 0.1) { z = min(z, zz); }
    }
  }
  if (z > 100.0) { return; }
  // pixels -> meters: how much the camera ray turns per pixel here, times the depth
  let scale = vec2f(textureDimensions(lutTex)) / vec2f(size);
  let c = vec2i((vec2f(p) + 0.5) * scale);
  let rx = (lut(c + vec2i(2, 0)) - lut(c - vec2i(2, 0))) * 0.25;
  let ry = (lut(c + vec2i(0, 2)) - lut(c - vec2i(0, 2))) * 0.25;
  let fpx = f.rg * scale;
  // only steady motion counts sideways: |mean flow| / mean |flow| is near 1 for real motion and
  // small for noise, whose direction jumps from frame to frame
  let steady = smoothstep(U.coherence - 0.15, U.coherence + 0.15, length(f.rg) / max(f.a, 0.0001));
  // and only where the image actually changed since the last frame. Static edges next to something
  // moving can inherit its motion from the coarse optical flow levels (along an edge it cannot be
  // corrected), and far away they would turn into large speeds at the wrong place.
  var change = 0.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let s = textureLoad(sigTex, clamp(p + vec2i(x, y), vec2i(0), size - 1), 0);
      change = max(change, abs(s.r - s.g));
    }
  }
  let moving = smoothstep(0.004, 0.02, change);
  let side = (rx * fpx.x + ry * fpx.y) * z * KINECT_FPS * steady * moving;
  // depth change of this cell's own front surface since the last frame, where it came from
  let own = textureLoad(sigTex, p, 0).b;
  let before = textureLoad(sigTex, clamp(vec2i(round(vec2f(p) - f.rg)), vec2i(0), size - 1), 0).a;
  let dz = own - before;
  let vz = select(0.0, dz * KINECT_FPS, own > 0.1 && before > 0.1 && abs(dz) < 0.2);
  let v = roomAxes(vec3f(side, vz)); // x right, down, forward (m/s)

  let h = hitWall(vec3f(lut(c) * z, z));
  if (!h.ok || h.mm > atomicLoad(&cells[h.cell * 4u]) + FRONT_MM) { return; }
  let i = h.cell * 4u;
  atomicAdd(&vcells[i], 1);
  atomicAdd(&vcells[i + 1u], i32(v.x * 1000.0));
  atomicAdd(&vcells[i + 2u], i32(v.y * 1000.0));
  atomicAdd(&vcells[i + 3u], i32(length(v) * 1000.0));
}

// ---- wall cells -> wall image, and clears the cells for the next frame.
// r = something there (0..1), g = nearness of the front surface mixed with IR (0 where empty)
@compute @workgroup_size(8, 8)
fn collect(@builtin(global_invocation_id) id: vec3u) {
  let size = gridSize();
  if (id.x >= size.x || id.y >= size.y) { return; }
  let i = (id.y * size.x + id.x) * 4u;
  atomicStore(&cells[i], EMPTY);
  let n = f32(atomicExchange(&cells[i + 1u], 0u));
  let dist = f32(atomicExchange(&cells[i + 2u], 0u)) / max(n, 1.0) / 1000.0;
  let ir = f32(atomicExchange(&cells[i + 3u], 0u)) / max(n, 1.0) / 255.0;
  let there = smoothstep(0.5, 2.5, n);
  textureStore(outTex, vec2i(id.xy), vec4f(there, there * mix(nearness(dist), ir, U.irMix), 0.0, 1.0));
}

// ---- wall cells -> wall motion: rg mean velocity on the wall (m/s, y down), b mean 3D speed,
// a = 1 where there was a sample. Mean, not sum: near people give more samples per cell, but not more motion.
@compute @workgroup_size(8, 8)
fn vcollect(@builtin(global_invocation_id) id: vec3u) {
  let size = gridSize();
  if (id.x >= size.x || id.y >= size.y) { return; }
  let i = (id.y * size.x + id.x) * 4u;
  let n = f32(atomicExchange(&vcells[i], 0));
  let vx = f32(atomicExchange(&vcells[i + 1u], 0));
  let vy = f32(atomicExchange(&vcells[i + 2u], 0));
  let speed = f32(atomicExchange(&vcells[i + 3u], 0));
  let mean = vec3f(vx, vy, speed) / max(n, 1.0) / 1000.0;
  textureStore(motionOut, vec2i(id.xy), vec4f(mean, select(0.0, 1.0, n > 0.0)));
}
