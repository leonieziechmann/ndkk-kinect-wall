// The people -> the wall, for every result of the person tracking (/lib/persons.js, PERSONS.md):
//   prep         the people only (mask): nearness, IR, depth at full resolution, for the optical flow
//   bodyScatter  person pixels -> the LEDs they cover on the wall (nearest point per LED)
//   bodyImage    -> the people's image on the wall, one texel per LED; bodyClear empties the LEDs
//   nearest      person pixels -> nearest distance (and its person) per wall cell
//   scene        optical flow (camera.wgsl, pixels) + depth -> 3D motion in m/s, put on the wall
//   vcollect     wall cells -> wall motion (mean velocity per cell), arms separately
// The wall cells of the motion are coarse (about 3 cm, as fine as the optical flow); what the people
// look like on the wall (where dye goes, its color) is in the LED image.
// Every person point is projected straight (orthographically) onto the wall: a person covers as much
// wall as they are wide and their speed counts in meters, whether near the sensor or far away. The
// wall mapping (wallFromRoom, wallVelocity) mirrors and shifts each person so their walk is stretched.
// The motion is measured on the masks, which are exact in every frame. The skeleton only says which
// pixels are arms (they count more): in live mode it can jump, the masks do not.
@group(0) @binding(1) var personDepth: texture_2d<f32>; // m, person pixels only
@group(0) @binding(2) var personLabel: texture_2d<u32>; // slot 1..16, 0 = nobody
@group(0) @binding(3) var lutTex: texture_2d<f32>;      // rg: ray per pixel, point = (x*z, y*z, z)
@group(0) @binding(4) var irTex: texture_2d<f32>;
// per wall cell: nearest distance (mm << 5 | slot), the front surface that hides what is behind it
@group(0) @binding(5) var<storage, read_write> cells: array<atomic<u32>>;
@group(0) @binding(6) var outTex: texture_storage_2d<rgba16float, write>;
// per wall cell, body and arms: number of motion samples, sums of velocity x, y (wall, y down) and of 3D speed (mm/s)
@group(0) @binding(7) var<storage, read_write> vcells: array<atomic<i32>>;
@group(0) @binding(8) var motionOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(9) var flowTex: texture_2d<f32>; // camera.wgsl lkFinal: rg flow (pixels/frame), a mean |flow|
@group(0) @binding(11) var sigTex: texture_2d<f32>; // camera.wgsl camSignal: r now, g before, b front depth, a before
@group(0) @binding(12) var armOut: texture_storage_2d<rgba16float, write>;
// per LED: the nearest person point, (mm << 13) | (ir << 5) | slot
@group(0) @binding(14) var<storage, read_write> bodyCells: array<atomic<u32>>;

const FRONT_MM = 150u;
const EMPTY = 0xffffffffu;

fn gridSize() -> vec2u { return vec2u(u32(U.gridW), u32(U.gridH)); }
fn lut(p: vec2i) -> vec2f { return textureLoad(lutTex, clamp(p, vec2i(0), vec2i(textureDimensions(lutTex)) - 1), 0).rg; }
fn worldPoint(p: vec2i, z: f32) -> vec3f {
  let ray = lut(p);
  return vec3f(WALL.xSign * ray.x * z, -ray.y * z, z);
}

// ---- the people only, for the optical flow (camera.wgsl camSignal). out: r nearness, g IR, b depth (m)
@compute @workgroup_size(8, 8)
fn prep(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(personDepth);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  let z = textureLoad(personDepth, p, 0).r;
  let on = textureLoad(personLabel, p, 0).r > 0u && z > 0.1;
  let ir = textureLoad(irTex, p, 0).r;
  let near = wallNear(wallRoom(worldPoint(p, z)));
  textureStore(outTex, p, select(vec4f(0.0), vec4f(near, ir, z, 1.0), on));
}

// ---- the people on the wall, one cell per LED. Every person pixel is drawn as the patch of wall it
// covers: near the sensor it is smaller than an LED, 4 m away about 2x2 LEDs, so the silhouette is as
// sharp as the sensor allows and has no holes at any distance. The nearest point of an LED wins.
@compute @workgroup_size(8, 8)
fn bodyScatter(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(personDepth);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  let slot = textureLoad(personLabel, p, 0).r;
  let z = textureLoad(personDepth, p, 0).r;
  if (slot == 0u || z < 0.1) { return; }
  let room = wallRoom(worldPoint(p, z));
  if (!wallInZone(room)) { return; }
  let led = vec2f(U.dyeW, U.dyeH);
  let c = wallUv(wallFromRoom(room, slot)) * led;
  // the patch: half the step to the neighbouring pixels (at the same depth) in each direction, in LEDs
  let dx = wallUv(wallFromRoom(wallRoom(worldPoint(p + vec2i(1, 0), z)), slot)) * led - c;
  let dy = wallUv(wallFromRoom(wallRoom(worldPoint(p + vec2i(0, 1), z)), slot)) * led - c;
  let half = min(0.5 * (abs(dx) + abs(dy)), vec2f(3.0));
  // the LEDs whose centers lie in the patch, at least the one under the pixel's center
  let at = vec2i(floor(c));
  let lo = max(min(vec2i(ceil(c - half - 0.5)), at), vec2i(0));
  let hi = min(max(vec2i(floor(c + half - 0.5)), at), vec2i(led) - 1);
  let mm = u32(clamp(room.z, 0.0, 60.0) * 1000.0);
  let ir = u32(saturate(textureLoad(irTex, p, 0).r) * 255.0);
  let v = (mm << 13u) | (ir << 5u) | min(slot, 31u);
  for (var y = lo.y; y <= hi.y; y++) {
    for (var x = lo.x; x <= hi.x; x++) {
      atomicMin(&bodyCells[u32(y) * u32(led.x) + u32(x)], v);
    }
  }
}

fn bodyCell(c: vec2i, size: vec2i) -> u32 {
  if (any(c < vec2i(0)) || any(c >= size)) { return EMPTY; }
  return atomicLoad(&bodyCells[u32(c.y * size.x + c.x)]);
}

// ---- LEDs -> the people's image on the wall (outTex, LED size): r covered, g distance from the
// sensor (m, room z), b slot, a IR. A single LED left out with people all around is filled.
@compute @workgroup_size(8, 8)
fn bodyImage(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(outTex));
  let c = vec2i(id.xy);
  if (c.x >= size.x || c.y >= size.y) { return; }
  var v = bodyCell(c, size);
  if (v == EMPTY) {
    var n = 0u;
    var best = EMPTY;
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let w = bodyCell(c + vec2i(x, y), size);
        if (w != EMPTY) {
          n++;
          best = min(best, w);
        }
      }
    }
    if (n >= 5u) { v = best; }
  }
  let body = vec4f(1.0, f32(v >> 13u) / 1000.0, f32(v & 31u), f32((v >> 5u) & 255u) / 255.0);
  textureStore(outTex, c, select(body, vec4f(0.0), v == EMPTY));
}

// ---- empties the LEDs for the next result (after bodyImage has read all of them)
@compute @workgroup_size(8, 8)
fn bodyClear(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2u(u32(U.dyeW), u32(U.dyeH));
  if (id.x >= size.x || id.y >= size.y) { return; }
  atomicStore(&bodyCells[id.y * size.x + id.x], EMPTY);
}

struct Hit { cell: u32, mm: u32, ok: bool };
// room point of person `slot` -> wall cell and distance in mm; ok = inside the wall and the zone
fn hitWall(room: vec3f, slot: u32) -> Hit {
  var h = Hit(0u, 0u, false);
  if (!wallInZone(room)) { return h; }
  let uv = wallUv(wallFromRoom(room, slot));
  if (!wallOnWall(uv)) { return h; }
  let g = vec2u(uv * vec2f(gridSize()));
  h.cell = g.y * gridSize().x + g.x;
  h.mm = u32(max(room.z, 0.0) * 1000.0);
  h.ok = true;
  return h;
}
struct Pixel { hit: Hit, slot: u32 };
fn personPixel(p: vec2i) -> Pixel {
  let slot = textureLoad(personLabel, p, 0).r;
  let z = textureLoad(personDepth, p, 0).r;
  if (slot == 0u || z < 0.1) { return Pixel(Hit(0u, 0u, false), 0u); }
  return Pixel(hitWall(wallRoom(worldPoint(p, z)), slot), slot);
}

// ---- nearest person point per wall cell (the slot rides along in the low bits). Only the front-most
// surface of a cell moves it: people overlapping on the wall are not mixed.
@compute @workgroup_size(8, 8)
fn nearest(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(personDepth);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let px = personPixel(vec2i(id.xy));
  if (px.hit.ok) { atomicMin(&cells[px.hit.cell], (px.hit.mm << 5u) | px.slot); }
}

// is this room point of the person on an arm? (nearest bone of their skeleton; false without one)
fn onArm(slot: u32, q: vec3f) -> bool {
  var best = 1e9;
  var arm = false;
  for (var b = 0u; b < BONE_COUNT; b++) {
    let a = joint(slot, BONES[b].x);
    let c = joint(slot, BONES[b].y);
    if (a.w <= 0.0 || c.w <= 0.0) { continue; }
    let ab = c.xyz - a.xyz;
    let t = saturate(dot(q - a.xyz, ab) / max(dot(ab, ab), 1e-6));
    let d = length(q - (a.xyz + t * ab));
    if (d < best) {
      best = d;
      arm = ((ARM_BONES >> b) & 1u) != 0u;
    }
  }
  return arm;
}

// ---- 3D motion: one sample per optical flow cell of the camera image
@compute @workgroup_size(8, 8)
fn scene(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(flowTex));
  let p = vec2i(id.xy);
  if (p.x >= size.x || p.y >= size.y) { return; }
  let f = textureLoad(flowTex, p, 0);
  // the optical flow spreads the motion of an edge over its window (9x9 cells) on both sides; it
  // belongs to what is in front, so take the nearest person depth around (and that person)
  var z = 1e9;
  var at = p;
  for (var y = -4; y <= 4; y++) {
    for (var x = -4; x <= 4; x++) {
      let q = clamp(p + vec2i(x, y), vec2i(0), size - 1);
      let zz = textureLoad(sigTex, q, 0).b;
      if (zz > 0.1 && zz < z) {
        z = zz;
        at = q;
      }
    }
  }
  if (z > 100.0) { return; }
  let scale = vec2f(textureDimensions(lutTex)) / vec2f(size);
  // whose motion: the nearest person in that cell's pixels (each person is shifted differently)
  var slot = 0u;
  var near = 1e9;
  let block = vec2i(vec2f(at) * scale);
  for (var y = 0; y < 4; y++) {
    for (var x = 0; x < 4; x++) {
      let q = clamp(block + vec2i(x, y), vec2i(0), vec2i(textureDimensions(personLabel)) - 1);
      let s = textureLoad(personLabel, q, 0).r;
      let d = textureLoad(personDepth, q, 0).r;
      if (s > 0u && d > 0.1 && d < near) {
        near = d;
        slot = s;
      }
    }
  }
  // pixels -> meters: how much the camera ray turns per pixel here, times the depth
  let c = vec2i((vec2f(p) + 0.5) * scale);
  let rx = (lut(c + vec2i(2, 0)) - lut(c - vec2i(2, 0))) * 0.25;
  let ry = (lut(c + vec2i(0, 2)) - lut(c - vec2i(0, 2))) * 0.25;
  let fpx = f.rg * scale;
  // only steady motion counts sideways: |mean flow| / mean |flow| is near 1 for real motion and
  // small for noise, whose direction jumps from frame to frame
  let steady = smoothstep(U.coherence - 0.15, U.coherence + 0.15, length(f.rg) / max(f.a, 0.0001));
  // and only where the image changed since the last frame: a body standing still next to a moving
  // arm can inherit the arm's motion from the coarse optical flow levels along its edges
  var change = 0.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let s = textureLoad(sigTex, clamp(p + vec2i(x, y), vec2i(0), size - 1), 0);
      change = max(change, abs(s.r - s.g));
    }
  }
  let moving = smoothstep(0.004, 0.02, change);
  let side = (rx * fpx.x + ry * fpx.y) * z * KINECT_FPS / U.frameStep * steady * moving;
  // depth change of this cell's own front surface since the last frame, where it came from
  let own = textureLoad(sigTex, p, 0).b;
  let before = textureLoad(sigTex, clamp(vec2i(round(vec2f(p) - f.rg)), vec2i(0), size - 1), 0).a;
  let dz = own - before;
  let vz = select(0.0, dz * KINECT_FPS / U.frameStep, own > 0.1 && before > 0.1 && abs(dz) < 0.2);
  // camera (x right, y down) -> world (x mirrored by xSign, y up) -> room
  let v = roomVector(vec3f(WALL.xSign * side.x, -side.y, vz));
  let room = wallRoom(worldPoint(c, z));

  let h = hitWall(room, slot);
  if (!h.ok || h.mm > (atomicLoad(&cells[h.cell]) >> 5u) + FRONT_MM) { return; }
  // arms count armGain times and get a wider reach on the wall (sim.wgsl wallMotion)
  let arm = slot > 0u && onArm(slot, room);
  // motion on the wall: x mirrored, walking stretched (the person's shift rate); y down; z (towards
  // the wall) only for the speed
  let wv = wallVelocity(room, v, slot);
  let w = vec3f(wv.x, -wv.y, wv.z) * select(1.0, U.armGain, arm);
  let i = h.cell * 8u + select(0u, 4u, arm);
  atomicAdd(&vcells[i], 1);
  atomicAdd(&vcells[i + 1u], i32(w.x * 1000.0));
  atomicAdd(&vcells[i + 2u], i32(w.y * 1000.0));
  atomicAdd(&vcells[i + 3u], i32(length(w) * 1000.0));
}

// ---- wall cells -> wall motion of the body (motionOut) and of the arms (armOut): rg mean velocity
// on the wall (m/s, y down), b mean 3D speed, a = 1 where there was a sample. Mean, not sum: near
// people give more samples per cell, but not more motion. Clears the cells for the next result.
fn collectMotion(i: u32) -> vec4f {
  let n = f32(atomicExchange(&vcells[i], 0));
  let vx = f32(atomicExchange(&vcells[i + 1u], 0));
  let vy = f32(atomicExchange(&vcells[i + 2u], 0));
  let speed = f32(atomicExchange(&vcells[i + 3u], 0));
  return vec4f(vec3f(vx, vy, speed) / max(n, 1.0) / 1000.0, select(0.0, 1.0, n > 0.0));
}
@compute @workgroup_size(8, 8)
fn vcollect(@builtin(global_invocation_id) id: vec3u) {
  let size = gridSize();
  if (id.x >= size.x || id.y >= size.y) { return; }
  let cell = id.y * size.x + id.x;
  textureStore(motionOut, vec2i(id.xy), collectMotion(cell * 8u));
  textureStore(armOut, vec2i(id.xy), collectMotion(cell * 8u + 4u));
  atomicStore(&cells[cell], EMPTY);
}
