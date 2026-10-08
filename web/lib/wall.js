// wall.js — the LED wall: one setup for every scene, and the mapping from the Kinect to the wall.
// Reference: ../WALL.md. The runtime keeps one WallMap up to date as ctx.wall.
//
// Spaces (see WALL.md):
//   wall   meters: x from the wall's left edge (as the audience sees it), y above the floor,
//          z in front of the wall (towards the audience)
//   uv     0..1 over the LED image, y down;  px: LED pixels (setup.led.w × setup.led.h)
//   room   meters: the floor is y = 0, origin on the floor below the sensor, z forward (persons.js)
//   world  meters, as ctx.persons and ctx.camera (x·xSign, y up, z forward)
//
// The horizontal mapping ("Zuordnung"): the wall mirrors (everyone sees themselves on their own
// side), and walking can be stretched so the sensor's narrow view spans the whole wall:
//   real     1:1, everybody at their real place
//   factor   lateral distance from the sensor × factor
//   fit      the sensor's view at `distance` m spans the wall (factor = half the wall / half the view
//            there, per side); `depth` 0..1 blends towards the view angle (1: the view's edges map to
//            the wall's edges at every distance)
// With apply 'person' only each person's position is stretched and the body keeps its size (shift
// per person, from the body center); with 'points' every point is stretched (bodies get wider).
// Camera image effects (kinectUv() on the LED image, wallToKinect()) see the image as it falls on the
// wall at the reference distance: in true proportions, or (image 'stretch') as wide as the mapping.

export const WALL_DEFAULTS = Object.freeze({
  led: { w: 1008, h: 336 }, // LED pixels
  size: { w: 6, h: 2 }, // m
  bottom: 0, // m: lower edge of the LEDs above the floor
  cabinet: { w: 84, h: 84 }, // LED pixels per cabinet (test image)
  output: { x: 0, y: 0, fit: 'pixel', window: null }, // where the LED image sits in the output window
  sensor: { x: 0, front: 0.2, floor: 'auto', height: 0.85, tilt: 0 },
  mirror: true,
  zone: { near: 0.5, far: 4.5 }, // m from the sensor
  map: { mode: 'fit', factor: 1.5, distance: 3, depth: 0, apply: 'person', clamp: true, margin: 0.3, lift: 0, scaleY: 1, image: 'true' },
  color: { brightness: 1, gamma: 1, r: 1, g: 1, b: 1 },
});

/** Every setting with its range and label (the control center builds its form from this). */
export const SETUP_FIELDS = Object.freeze([
  { key: 'led.w', label: 'LEDs breit', min: 16, max: 7680, step: 1, group: 'LED-Wand' },
  { key: 'led.h', label: 'LEDs hoch', min: 16, max: 4320, step: 1, group: 'LED-Wand' },
  { key: 'size.w', label: 'Breite (m)', min: 0.5, max: 30, step: 0.01, group: 'LED-Wand' },
  { key: 'size.h', label: 'Höhe (m)', min: 0.2, max: 10, step: 0.01, group: 'LED-Wand' },
  { key: 'bottom', label: 'Unterkante über dem Boden (m)', min: 0, max: 5, step: 0.01, group: 'LED-Wand' },
  { key: 'cabinet.w', label: 'Kabinett breit (LEDs, Testbild)', min: 8, max: 1024, step: 1, group: 'LED-Wand' },
  { key: 'cabinet.h', label: 'Kabinett hoch (LEDs, Testbild)', min: 8, max: 1024, step: 1, group: 'LED-Wand' },

  { key: 'output.fit', label: 'Abbildung', options: { 'pixelgenau 1:1 (LED-Controller)': 'pixel', 'Fenster füllen (verzerrt)': 'stretch', 'einpassen (Vorschau)': 'fit' }, group: 'Ausgabe' },
  { key: 'output.x', label: 'Versatz x (Bildschirm-px)', min: 0, max: 7680, step: 1, group: 'Ausgabe' },
  { key: 'output.y', label: 'Versatz y (Bildschirm-px)', min: 0, max: 4320, step: 1, group: 'Ausgabe' },

  { key: 'sensor.x', label: 'Kinect seitlich der Wandmitte (m, + = rechts)', min: -15, max: 15, step: 0.01, group: 'Kinect' },
  { key: 'sensor.front', label: 'Kinect vor der Wand (m)', min: 0, max: 5, step: 0.01, group: 'Kinect' },
  { key: 'sensor.floor', label: 'Boden', options: { 'automatisch erkennen': 'auto', 'von Hand (Höhe, Neigung)': 'manual' }, group: 'Kinect' },
  { key: 'sensor.height', label: 'Höhe über dem Boden (m, von Hand)', min: 0, max: 4, step: 0.01, group: 'Kinect' },
  { key: 'sensor.tilt', label: 'Neigung nach unten (°, von Hand)', min: -45, max: 45, step: 0.5, group: 'Kinect' },
  { key: 'zone.near', label: 'Zone ab (m vom Sensor)', min: 0.3, max: 8, step: 0.05, group: 'Kinect' },
  { key: 'zone.far', label: 'Zone bis (m vom Sensor)', min: 0.5, max: 10, step: 0.05, group: 'Kinect' },

  { key: 'mirror', label: 'Spiegeln (jeder auf seiner Seite)', group: 'Zuordnung' },
  { key: 'map.mode', label: 'Seitlich', options: { 'echt 1:1': 'real', 'Faktor': 'factor', 'Sichtfeld füllt die Wand bei Abstand': 'fit' }, group: 'Zuordnung' },
  { key: 'map.factor', label: 'Faktor (×)', min: 0.25, max: 5, step: 0.01, group: 'Zuordnung' },
  { key: 'map.distance', label: 'Bezugsabstand (m vom Sensor)', min: 0.5, max: 10, step: 0.05, group: 'Zuordnung' },
  { key: 'map.depth', label: 'Tiefenausgleich (0 fest … 1 Winkel)', min: 0, max: 1, step: 0.01, group: 'Zuordnung' },
  { key: 'map.apply', label: 'Dehnen', options: { 'nur die Position (Körper bleibt gleich groß)': 'person', 'alle Punkte (Körper wird breiter)': 'points' }, group: 'Zuordnung' },
  { key: 'map.clamp', label: 'Personen am Wandrand halten', group: 'Zuordnung' },
  { key: 'map.margin', label: 'Randabstand (m)', min: 0, max: 2, step: 0.01, group: 'Zuordnung' },
  { key: 'map.image', label: 'Kamerabild-Szenen (kinectUv)', options: { 'echte Proportionen': 'true', 'in die Breite dehnen (füllt die Wand)': 'stretch' }, group: 'Zuordnung' },
  { key: 'map.lift', label: 'Höhenversatz (m)', min: -3, max: 3, step: 0.01, group: 'Zuordnung' },
  { key: 'map.scaleY', label: 'Höhe skalieren (×)', min: 0.25, max: 4, step: 0.01, group: 'Zuordnung' },

  { key: 'color.brightness', label: 'Helligkeit', min: 0, max: 2, step: 0.01, group: 'Farbe (nur Ausgabe)' },
  { key: 'color.gamma', label: 'Gamma', min: 0.3, max: 3, step: 0.01, group: 'Farbe (nur Ausgabe)' },
  { key: 'color.r', label: 'Rot', min: 0, max: 1.5, step: 0.01, group: 'Farbe (nur Ausgabe)' },
  { key: 'color.g', label: 'Grün', min: 0, max: 1.5, step: 0.01, group: 'Farbe (nur Ausgabe)' },
  { key: 'color.b', label: 'Blau', min: 0, max: 1.5, step: 0.01, group: 'Farbe (nur Ausgabe)' },
].map((f) => Object.freeze({ ...f, kind: f.options ? 'select' : typeof getPath(WALL_DEFAULTS, f.key) })));

/** The Kinect v2 depth camera, until the hub sent its table: half the view as tan, pixel model. */
const TAN_H = Math.tan((70.6 / 2) * (Math.PI / 180));
const KINECT_W = 512;
const KINECT_H = 424;
export const SLOTS = 17; // person slots 0..16 (0 = nobody)
const MIN_Z = 0.3;

export function getPath(obj, key) {
  let o = obj;
  for (const k of key.split('.')) {
    if (o === null || typeof o !== 'object') return undefined;
    o = o[k];
  }
  return o;
}

export function setPath(obj, key, value) {
  const parts = key.split('.');
  let o = obj;
  for (const k of parts.slice(0, -1)) {
    if (o[k] === null || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[parts.at(-1)] = value;
}

const optionValues = (o) => (Array.isArray(o) ? o : Object.values(o ?? {}));

function accepts(f, v) {
  if (f.kind === 'select') return optionValues(f.options).includes(v);
  if (f.kind === 'boolean') return typeof v === 'boolean';
  return typeof v === 'number' && Number.isFinite(v);
}

/** A complete, valid setup from anything (missing or broken values: the defaults). */
export function normalizeSetup(raw) {
  const out = structuredClone(WALL_DEFAULTS);
  for (const f of SETUP_FIELDS) {
    const v = getPath(raw, f.key);
    if (!accepts(f, v)) continue;
    setPath(out, f.key, f.kind === 'number' ? Math.min(f.max, Math.max(f.min, v)) : v);
  }
  out.led.w = Math.round(out.led.w);
  out.led.h = Math.round(out.led.h);
  if (out.zone.far <= out.zone.near) out.zone.far = out.zone.near + 0.5;
  const w = raw?.output?.window;
  if (w && ['left', 'top', 'width', 'height'].every((k) => Number.isFinite(w[k]))) {
    out.output.window = { left: Math.round(w.left), top: Math.round(w.top), width: Math.max(1, Math.round(w.width)), height: Math.max(1, Math.round(w.height)), label: String(w.label ?? '').slice(0, 80) };
  }
  return out;
}

/** World -> room without a found floor: the sensor `height` m above the floor, tilted down by `tiltDeg`. */
export function manualRoom(height, tiltDeg) {
  const t = (tiltDeg * Math.PI) / 180;
  const up = [0, Math.cos(t), -Math.sin(t)];
  const fwd = [0, Math.sin(t), Math.cos(t)];
  const m = new Float32Array(16);
  for (let j = 0; j < 3; j++) {
    m[j * 4] = j === 0 ? 1 : 0;
    m[j * 4 + 1] = up[j];
    m[j * 4 + 2] = fwd[j];
  }
  m[13] = height;
  m[15] = 1;
  return m;
}

/** Inverse of a rigid world -> room matrix (column-major). */
function rigidInverse(m, out = new Float32Array(16)) {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[c * 4 + r] = m[r * 4 + c];
    out[r * 4 + 3] = 0;
  }
  for (let r = 0; r < 3; r++) out[12 + r] = -(m[r * 4] * m[12] + m[r * 4 + 1] * m[13] + m[r * 4 + 2] * m[14]);
  out[15] = 1;
  return out;
}

const apply = (m, p, w = 1) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12] * w,
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13] * w,
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14] * w,
];

/**
 * Off-axis projection through the wall rectangle (for 3D scenes that look "through" the wall):
 * eye [x, y, z] in the 3D wall space (x from the wall center, y above the floor, z in front of the
 * wall), the wall from `bottom` to `bottom + h`. Returns a column-major projection matrix for a
 * camera at the eye looking along -z (WebGPU depth 0..1) and the view matrix (a translation).
 */
export function offAxisProjection(eye, wallW, wallH, bottom = 0, near = 0.05, far = 400) {
  const d = Math.max(1e-3, eye[2]);
  const l = ((-wallW / 2 - eye[0]) / d) * near;
  const r = ((wallW / 2 - eye[0]) / d) * near;
  const b = ((bottom - eye[1]) / d) * near;
  const t = ((bottom + wallH - eye[1]) / d) * near;
  const p = new Float32Array(16);
  p[0] = (2 * near) / (r - l);
  p[5] = (2 * near) / (t - b);
  p[8] = (r + l) / (r - l);
  p[9] = (t + b) / (t - b);
  p[10] = far / (near - far);
  p[11] = -1;
  p[14] = (near * far) / (near - far);
  const v = new Float32Array(16);
  v[0] = v[5] = v[10] = v[15] = 1;
  v[12] = -eye[0];
  v[13] = -eye[1];
  v[14] = -eye[2];
  return { projection: p, view: v, frustum: { l: l / near, r: r / near, t: t / near, b: b / near } };
}

// ---------- GPU ----------

// uniform layout (floats); WGSL struct Wall below
const U = { room: 0, roomInv: 16, led: 32, size: 34, bottom: 36, sensorX: 37, front: 38, side: 39, mode: 40, kRight: 41, kLeft: 42, dist: 43, depth: 44, perPerson: 45, xSign: 46, tanH: 47, lift: 48, scaleY: 49, near: 50, far: 51, inv: 52, active: 56, margin: 57, clampOn: 58, slots: 60 };
export const WALL_UNIFORM_BYTES = (U.slots + SLOTS * 4) * 4;

/** WGSL: struct Wall, the binding and the mapping functions (same math as WallMap below). */
export function wallWgsl(group = 0, binding = 0) {
  return /* wgsl */ `
struct Wall {
  room: mat4x4f,     // world -> room
  roomInv: mat4x4f,  // room -> world
  led: vec2f,        // LED pixels
  size: vec2f,       // m
  bottom: f32, sensorX: f32, front: f32, side: f32,
  mode: f32, kRight: f32, kLeft: f32, dist: f32,
  depthComp: f32, perPerson: f32, xSign: f32, tanH: f32,
  lift: f32, scaleY: f32, near: f32, far: f32,
  inv: vec4f,        // camera ray -> depth image pixel: u = x + y * rx, v = z + w * ry
  ledImage: f32, margin: f32, clampOn: f32, imageStretch: f32,
  slots: array<vec4f, ${SLOTS}>, // per person slot: x = shift on the wall (m), y = 1 if visible, z = shift per second
};
@group(${group}) @binding(${binding}) var<uniform> WALL: Wall;

// factor of the lateral stretch at distance z (m from the sensor) on the side of lat
fn wallK(lat: f32, z: f32) -> f32 {
  if (WALL.mode < 0.5) { return 1.0; }
  let k = select(WALL.kLeft, WALL.kRight, lat >= 0.0);
  if (WALL.mode < 1.5) { return k; }
  return k * pow(WALL.dist / max(z, ${MIN_Z}), WALL.depthComp);
}
// world (m, as ctx.persons) -> room (floor y = 0)
fn wallRoom(world: vec3f) -> vec3f { return (WALL.room * vec4f(world, 1.0)).xyz; }
// room point of person \`slot\` (0 = nobody) -> wall: x from the left edge, y above the floor, z in front of the wall (m)
fn wallFromRoom(r: vec3f, slot: u32) -> vec3f {
  let lat = WALL.side * r.x;
  let s = WALL.slots[min(slot, ${SLOTS - 1}u)];
  let x = select(lat * wallK(lat, r.z), lat + s.x, WALL.perPerson > 0.5 && slot > 0u && s.y > 0.5);
  return vec3f(WALL.size.x * 0.5 + WALL.sensorX + x, WALL.lift + WALL.scaleY * r.y, WALL.front + r.z);
}
fn wallFromWorld(world: vec3f, slot: u32) -> vec3f { return wallFromRoom(wallRoom(world), slot); }
// velocity (room m/s) of the room point r of person \`slot\` -> on the wall (m/s: x right, y up, z towards
// the audience). The stretched walk moves along: a person walking 1 m/s moves k m/s on the wall.
fn wallVelocity(r: vec3f, v: vec3f, slot: u32) -> vec3f {
  let lat = WALL.side * r.x;
  let s = WALL.slots[min(slot, ${SLOTS - 1}u)];
  let vx = select(WALL.side * v.x * wallK(lat, r.z), WALL.side * v.x + s.z, WALL.perPerson > 0.5 && slot > 0u && s.y > 0.5);
  return vec3f(vx, WALL.scaleY * v.y, v.z);
}
// the same for a world point and a world velocity (ctx.persons, pointAt())
fn wallVelocityWorld(world: vec3f, v: vec3f, slot: u32) -> vec3f { return wallVelocity(wallRoom(world), (WALL.room * vec4f(v, 0.0)).xyz, slot); }
// Kinect camera point in meters: (ray.x * z, ray.y * z, z) with the ray from lutTex
fn wallFromCamera(c: vec3f, slot: u32) -> vec3f { return wallFromWorld(vec3f(WALL.xSign * c.x, -c.y, c.z), slot); }
// wall (m) -> LED uv (0..1, y down) and LED pixels
fn wallUv(p: vec3f) -> vec2f { return vec2f(p.x / WALL.size.x, (WALL.bottom + WALL.size.y - p.y) / WALL.size.y); }
fn wallPx(p: vec3f) -> vec2f { return wallUv(p) * WALL.led; }
fn wallOnWall(uv: vec2f) -> bool { return all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0)); }
// LED uv -> wall (m): x from the left edge, y above the floor
fn wallAt(uv: vec2f) -> vec2f { return vec2f(uv.x * WALL.size.x, WALL.bottom + (1.0 - uv.y) * WALL.size.y); }
// in the zone (room z = m from the sensor)? and 1 at its near end .. 0 at its far end
fn wallInZone(r: vec3f) -> bool { return r.z >= WALL.near && r.z <= WALL.far; }
fn wallNear(r: vec3f) -> f32 { return saturate((WALL.far - r.z) / max(WALL.far - WALL.near, 0.01)); }
// wall (m) -> mirror world behind the wall for 3D scenes: x from the wall center, y up, z = -distance
fn wallMirror(p: vec3f) -> vec3f { return vec3f(p.x - WALL.size.x * 0.5, p.y, -p.z); }
// LED uv -> depth image uv (as kinectUv()): the camera image as it falls on the wall for things at
// the reference distance (map.distance): true proportions, or as wide as the mapping (map.image).
fn wallToKinect(uv: vec2f) -> vec2f {
  let w = wallAt(uv);
  let x = w.x - WALL.size.x * 0.5 - WALL.sensorX;
  let k = select(1.0, wallK(x, WALL.dist), WALL.imageStretch > 0.5);
  let room = vec3f(WALL.side * x / k, (w.y - WALL.lift) / WALL.scaleY, WALL.dist);
  let world = (WALL.roomInv * vec4f(room, 1.0)).xyz;
  let c = vec3f(WALL.xSign * world.x, -world.y, max(world.z, 0.01));
  let px = vec2f(WALL.inv.x + WALL.inv.y * c.x / c.z, WALL.inv.z + WALL.inv.w * c.y / c.z);
  return (px + 0.5) / vec2f(${KINECT_W}.0, ${KINECT_H}.0);
}
`;
}

// ---------- the mapping (CPU) ----------

/**
 * ctx.wall: the setup and the mapping, updated by the runtime before every frame().
 * Points are [x, y, z] arrays; every method takes an optional `out` array.
 */
export class WallMap {
  constructor(setup = WALL_DEFAULTS) {
    this.setup = normalizeSetup(setup);
    /** true when the canvas is the LED image (a wall scene, or the output window) */
    this.active = false;
    /** true in the output window (the one that goes to the LED controller) */
    this.output = false;
    this.xSign = -1;
    this.room = { matrix: manualRoom(0.85, 0), inverse: rigidInverse(manualRoom(0.85, 0)), found: false, height: 0.85, source: 'manual' };
    this.tanH = TAN_H;
    this.inv = [255.5, 365.5, 205.5, 365.5]; // u = a + b·rx, v = c + d·ry (pinhole until the table came)
    this.shift = new Float32Array(SLOTS);
    this.shiftRate = new Float32Array(SLOTS); // m/s: how fast the shift changes (the stretched walk)
    this.visible = new Uint8Array(SLOTS);
    /** per visible person: where it is on the wall (see place()) */
    this.persons = [];
    /** the mouse on the wall: x, y (m), u, v, down; set by the runtime */
    this.pointer = { x: 0, y: 0, u: 0, v: 0, down: false, inside: false };
    this.version = 0; // +1 whenever the setup changes
    this._data = new Float32Array(WALL_UNIFORM_BYTES / 4);
    this._buffer = null;
    this._device = null;
    this._raysFrom = null;
  }

  get led() {
    return this.setup.led;
  }

  get size() {
    return this.setup.size;
  }

  /** LED pixels per meter (horizontal, vertical). */
  get pxPerM() {
    return [this.setup.led.w / this.setup.size.w, this.setup.led.h / this.setup.size.h];
  }

  setSetup(setup) {
    this.setup = normalizeSetup(setup);
    this.version++;
  }

  /** wall x per room x: +1 or -1 (mirror, and the view's xSign which the room frame carries) */
  get side() {
    return (this.setup.mirror ? 1 : -1) * this.xSign;
  }

  /** The camera's real view from the hub's ray table (call when it changes). */
  setRays(lut) {
    if (!lut || lut === this._raysFrom || lut.length < KINECT_W * KINECT_H * 2) return;
    this._raysFrom = lut;
    const at = (u, v) => [lut[(v * KINECT_W + u) * 2], lut[(v * KINECT_W + u) * 2 + 1]];
    const row = KINECT_H >> 1;
    const col = KINECT_W >> 1;
    const [x0] = at(8, row);
    const [x1] = at(KINECT_W - 9, row);
    const [, y0] = at(col, 8);
    const [, y1] = at(col, KINECT_H - 9);
    if (![x0, x1, y0, y1].every(Number.isFinite) || Math.abs(x1 - x0) < 1e-3 || Math.abs(y1 - y0) < 1e-3) return;
    const bx = (KINECT_W - 17) / (x1 - x0);
    const by = (KINECT_H - 17) / (y1 - y0);
    this.inv = [8 - bx * x0, bx, 8 - by * y0, by];
    const e0 = Math.abs(at(0, row)[0]);
    const e1 = Math.abs(at(KINECT_W - 1, row)[0]);
    if (Number.isFinite(e0 + e1) && e0 + e1 > 0.2) this.tanH = (e0 + e1) / 2;
  }

  /** Runtime: once per animation frame, before the scene's frame(). */
  update(view, xSign) {
    this.xSign = xSign;
    const s = this.setup.sensor;
    const r = view?.room;
    if (s.floor === 'auto' && r?.found) {
      this.room = { matrix: r.matrix, inverse: rigidInverse(r.matrix, this.room.inverse), found: true, height: r.height, source: 'floor' };
    } else {
      const m = manualRoom(s.height, s.tilt);
      this.room = { matrix: m, inverse: rigidInverse(m, this.room.inverse), found: false, height: s.height, source: 'manual' };
    }
    this.shift.fill(0);
    this.shiftRate.fill(0);
    this.visible.fill(0);
    const list = [];
    for (const p of view ?? []) {
      const info = this._place(p);
      if (!info) continue;
      if (p.slot >= 1 && p.slot < SLOTS) {
        this.shift[p.slot] = info.shift;
        this.shiftRate[p.slot] = info.shiftRate;
        this.visible[p.slot] = 1;
      }
      list.push(info);
    }
    this.persons = list;
    this._writeGpu();
  }

  /** factor of the lateral stretch at distance z (m from the sensor), on the side of lat */
  k(lat, z) {
    const m = this.setup.map;
    if (m.mode === 'real') return 1;
    if (m.mode === 'factor') return m.factor;
    const half = this.setup.size.w / 2;
    const reach = Math.max(0.05, lat >= 0 ? half - this.setup.sensor.x : half + this.setup.sensor.x);
    const kD = reach / (m.distance * this.tanH);
    return m.depth ? kD * (m.distance / Math.max(z, MIN_Z)) ** m.depth : kD;
  }

  /** world (m, as ctx.persons) -> room */
  toRoom(world, out = [0, 0, 0]) {
    const p = apply(this.room.matrix, world);
    out[0] = p[0];
    out[1] = p[1];
    out[2] = p[2];
    return out;
  }

  /** room point of person `slot` (or a Person; 0/null = nobody) -> wall [x, y, z] (m) */
  fromRoom(r, slot = 0, out = [0, 0, 0]) {
    const s = typeof slot === 'object' && slot ? slot.slot : slot | 0;
    const lat = this.side * r[0];
    const perPerson = this.setup.map.apply === 'person' && s > 0 && s < SLOTS && this.visible[s];
    const x = perPerson ? lat + this.shift[s] : lat * this.k(lat, r[2]);
    out[0] = this.setup.size.w / 2 + this.setup.sensor.x + x;
    out[1] = this.setup.map.lift + this.setup.map.scaleY * r[1];
    out[2] = this.setup.sensor.front + r[2];
    return out;
  }

  /**
   * Velocity on the wall (m/s: x right, y up, z towards the audience) of a world point with a world
   * velocity (person.motion.rightHand, person.velocity) of person `slot`: the stretched walk counts.
   */
  velocity(world, vel, slot = 0, out = [0, 0, 0]) {
    const s = typeof slot === 'object' && slot ? slot.slot : slot | 0;
    const r = this.toRoom(world);
    const v = apply(this.room.matrix, vel, 0);
    const lat = this.side * r[0];
    const perPerson = this.setup.map.apply === 'person' && s > 0 && s < SLOTS && this.visible[s];
    out[0] = perPerson ? this.side * v[0] + this.shiftRate[s] : this.side * v[0] * this.k(lat, r[2]);
    out[1] = this.setup.map.scaleY * v[1];
    out[2] = v[2];
    return out;
  }

  /** a joint's velocity on the wall (m/s) or null */
  jointVelocity(person, name, out = [0, 0, 0]) {
    const w = person?.joints?.[name];
    const m = person?.motion?.[name];
    return w && m ? this.velocity(w, m, person.slot, out) : null;
  }

  /** world point (m, as ctx.persons) of person `slot` -> wall [x, y, z] (m) */
  fromWorld(world, slot = 0, out = [0, 0, 0]) {
    return this.fromRoom(this.toRoom(world, out), slot, out);
  }

  /** Kinect camera point in mm or m ([x, y, z] as ctx.kinect.persons.list / points) -> wall */
  fromCamera(c, slot = 0, mm = true, out = [0, 0, 0]) {
    const f = mm ? 0.001 : 1;
    return this.fromWorld([this.xSign * c[0] * f, -c[1] * f, c[2] * f], slot, out);
  }

  /** wall [x, y] (m) -> LED uv [u, v] (0..1, y down) */
  uv(p, out = [0, 0]) {
    out[0] = p[0] / this.setup.size.w;
    out[1] = (this.setup.bottom + this.setup.size.h - p[1]) / this.setup.size.h;
    return out;
  }

  /** wall [x, y] (m) -> LED pixels */
  px(p, out = [0, 0]) {
    this.uv(p, out);
    out[0] *= this.setup.led.w;
    out[1] *= this.setup.led.h;
    return out;
  }

  /** LED uv -> wall [x, y] (m) */
  fromUv(u, v, out = [0, 0]) {
    out[0] = u * this.setup.size.w;
    out[1] = this.setup.bottom + (1 - v) * this.setup.size.h;
    return out;
  }

  /** LED pixels -> wall [x, y] (m) */
  fromPx(x, y, out = [0, 0]) {
    return this.fromUv(x / this.setup.led.w, y / this.setup.led.h, out);
  }

  /** is the wall point on the LEDs? */
  onWall(p) {
    const s = this.setup;
    return p[0] >= 0 && p[0] < s.size.w && p[1] >= s.bottom && p[1] < s.bottom + s.size.h;
  }

  /** 1 at the zone's near end .. 0 at its far end (dist: m from the sensor) */
  near(dist) {
    const z = this.setup.zone;
    return Math.min(1, Math.max(0, (z.far - dist) / Math.max(0.01, z.far - z.near)));
  }

  /** a joint of a person on the wall: [x, y, z] (m) or null */
  joint(person, name, out = [0, 0, 0]) {
    const w = person?.joints?.[name];
    return w ? this.fromWorld(w, person.slot, out) : null;
  }

  /**
   * Depth image pixel (u, v) -> wall [x, y] (m) as kinectUv() shows the camera image on the LED image:
   * the pixel's ray meets the reference distance there (`rays`: ctx.kinect.lut.data). Null if the ray
   * does not reach it.
   */
  imageToWall(u, v, rays, out = [0, 0]) {
    const s = this.setup;
    const i = (Math.min(KINECT_H - 1, Math.max(0, Math.round(v))) * KINECT_W + Math.min(KINECT_W - 1, Math.max(0, Math.round(u)))) * 2;
    const rx = rays ? rays[i] : (u - this.inv[0]) / this.inv[1];
    const ry = rays ? rays[i + 1] : (v - this.inv[2]) / this.inv[3];
    const m = this.room.matrix;
    const d = apply(m, [this.xSign * rx, -ry, 1], 0);
    if (d[2] <= 1e-4) return null;
    const t = (s.map.distance - m[14]) / d[2];
    const room = [m[12] + t * d[0], m[13] + t * d[1], s.map.distance];
    const lat = this.side * room[0];
    const k = s.map.image === 'stretch' ? this.k(lat, s.map.distance) : 1;
    out[0] = s.size.w / 2 + s.sensor.x + lat * k;
    out[1] = s.map.lift + s.map.scaleY * room[1];
    return out;
  }

  /** where a person is on the wall (computed once per frame for the visible ones) */
  place(person) {
    return this.persons.find((p) => p.id === person?.id) ?? this._place(person);
  }

  /** wall point (m) -> mirror world behind the wall for 3D scenes: x from the wall center, y up, z = -distance */
  mirror(p, out = [0, 0, 0]) {
    out[0] = p[0] - this.setup.size.w / 2;
    out[1] = p[1];
    out[2] = -p[2];
    return out;
  }

  _place(person) {
    const c = person?.center ?? person?.joints?.center ?? person?.ground;
    if (!c) return null;
    const s = this.setup;
    const r = this.toRoom(c);
    const lat = this.side * r[0];
    const real = s.sensor.x + lat; // m from the wall center
    let mapped = s.sensor.x + lat * this.k(lat, r[2]);
    if (s.map.apply === 'person' && s.map.clamp) {
      const lim = Math.max(0, s.size.w / 2 - s.map.margin);
      mapped = Math.min(lim, Math.max(-lim, mapped));
    }
    const shift = s.map.apply === 'person' ? mapped - real : 0;
    // how fast the shift changes while the person walks (0 when held at the wall's edge)
    const v = person.velocity ? apply(this.room.matrix, person.velocity, 0) : [0, 0, 0];
    const vLat = this.side * v[0];
    const lim = Math.max(0, s.size.w / 2 - s.map.margin);
    const held = s.map.clamp && Math.abs(mapped) >= lim - 1e-6;
    const shiftRate = s.map.apply === 'person' && !held ? (this.k(lat, r[2]) - 1) * vLat : 0;
    const x = s.size.w / 2 + mapped;
    const y = s.map.lift + s.map.scaleY * r[1];
    const ground = person.ground ? this.toRoom(person.ground) : [r[0], 0, r[2]];
    const head = person.head ? this.toRoom(person.head) : null;
    const uv = this.uv([x, y]);
    return {
      person,
      id: person.id,
      slot: person.slot,
      color: person.color,
      x, // m from the left edge (mapped)
      y, // m above the floor (body center)
      z: s.sensor.front + r[2], // m in front of the wall
      dist: r[2], // m from the sensor along the floor
      lateral: lat, // m beside the sensor, as the audience sees it (real)
      real: s.size.w / 2 + real, // m from the left edge where the person really is
      shift, // m: how far the person is moved on the wall
      shiftRate, // m/s: how fast that changes
      vx: vLat + shiftRate, // m/s: the person's speed across the wall (stretched walk included)
      vy: s.map.scaleY * v[1],
      u: uv[0],
      v: uv[1],
      px: uv[0] * s.led.w,
      py: uv[1] * s.led.h,
      feet: s.map.lift + s.map.scaleY * ground[1],
      top: head ? s.map.lift + s.map.scaleY * (head[1] + 0.12) : y + 0.8,
      room: r,
      inZone: r[2] >= s.zone.near && r[2] <= s.zone.far,
      near: this.near(r[2]),
    };
  }

  // ---------- GPU ----------

  /** Uniform buffer with the mapping (WGSL: wallWgsl()); created on first use, updated every frame. */
  buffer(device) {
    if (this._buffer && this._device === device) return this._buffer;
    this._device = device;
    this._buffer = device.createBuffer({ label: 'wall', size: WALL_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this._writeGpu();
    return this._buffer;
  }

  /** WGSL for the uniform: struct Wall, var WALL at (group, binding), wallFromWorld() & co. */
  wgsl(group = 0, binding = 0) {
    return wallWgsl(group, binding);
  }

  _writeGpu() {
    if (!this._buffer) return;
    const d = this._data;
    const s = this.setup;
    d.set(this.room.matrix, U.room);
    d.set(this.room.inverse, U.roomInv);
    d.set([s.led.w, s.led.h, s.size.w, s.size.h, s.bottom, s.sensor.x, s.sensor.front, this.side], U.led);
    const mode = { real: 0, factor: 1, fit: 2 }[s.map.mode] ?? 0;
    // kRight/kLeft: the factors at the reference distance; wallK() adds the depth term
    d.set([mode, this.k(1, s.map.distance), this.k(-1, s.map.distance), s.map.distance, s.map.depth, s.map.apply === 'person' ? 1 : 0, this.xSign, this.tanH], U.mode);
    d.set([s.map.lift, s.map.scaleY, s.zone.near, s.zone.far], U.lift);
    d.set(this.inv, U.inv);
    d.set([this.active ? 1 : 0, s.map.margin, s.map.clamp ? 1 : 0, s.map.image === 'stretch' ? 1 : 0], U.active);
    for (let i = 0; i < SLOTS; i++) d.set([this.shift[i], this.visible[i], this.shiftRate[i], 0], U.slots + i * 4);
    this._device.queue.writeBuffer(this._buffer, 0, d);
  }

  destroy() {
    this._buffer?.destroy();
    this._buffer = null;
  }
}
