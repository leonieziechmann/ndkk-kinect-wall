// wall.js — the LED wall: one setup for every scene, a projection per scene, and the mapping from
// the Kinect to the wall. Reference: ../WALL.md. The runtime keeps one WallMap per scene as ctx.wall.
//
// Spaces (see WALL.md):
//   wall   meters: x from the wall's left edge (as the audience sees it), y above the floor,
//          z in front of the wall (towards the audience)
//   uv     0..1 over the LED image, y down;  px: LED pixels (setup.led.w × setup.led.h)
//   plan   meters on the floor: x from the wall's left edge (where people really stand), z in front of
//          the wall. The play field and the block zones live here.
//   norm   0..1 in the projection: x across the wall's target range, y its height range, z the play
//          field from front (0) to back (1)
//   room   meters: the floor is y = 0, origin on the floor below the sensor, z forward (persons.js)
//   world  meters, as ctx.persons and ctx.camera (x·xSign, y up, z forward)
//
// Setup (physical, one for the wall): LED pixels, size, where the Kinect stands, floor, color, block
// zones. Projection (per scene, over a default for all): how people are mapped onto the wall.
//   field    the play field on the floor: a trapezoid with a front and a back edge parallel to the
//            wall (field.near/far, m in front of the wall) and their left and right ends (plan x). A
//            box is "stretch the walk by a factor", the view cone "the edges of the view reach the
//            edges of the wall at every distance". Across the field u = 0..1 at every depth.
//   curve    a response curve per axis (x across, y height, z depth): monotone, 0 -> 0 and 1 -> 1,
//            baked into a 33-sample table that JS and WGSL share (identical results).
//   out      where u = 0..1 lands on the wall (m from the left and right edge), and the height range
//            field.low..high (m above the floor) -> out.bottom..top (m on the wall).
//   apply    'person': only each person's place goes through the mapping, the body keeps its shape
//            around it (× body.scale; body.fit 'height' scales everybody to the same height);
//            'points': every point goes through it (bodies get wider where the walk is stretched).
//   edge     what happens to a person's place beyond the wall's edges (keeps `margin` m inside):
//            'clamp', 'soft' (eases in), 'free'.
//   smoothing, predict   One-Euro filter and a look-ahead (s) on each person's place on the floor.
//   zone     who counts (inZone, wallPerson): near..far, m in front of the wall.
//   image    camera image scenes (kinectUv() on the LED image): the image as it falls on the wall for
//            things at image.distance, in true proportions or stretched like the people.
//
// Block zones (setup.blocks): polygons on the floor plan. A person whose feet stand in one is removed
// from the tracking result before any scene sees it: filterPersons(), used by the runtime.

export const WALL_DEFAULTS = Object.freeze({
  led: { w: 1008, h: 336 }, // LED pixels
  size: { w: 6, h: 2 }, // m
  bottom: 0, // m: lower edge of the LEDs above the floor
  cabinet: { w: 84, h: 84 }, // LED pixels per cabinet (test image)
  output: { x: 0, y: 0, fit: 'pixel', window: null }, // where the LED image sits in the output window
  sensor: { x: 0, front: 0.2, floor: 'auto', height: 0.85, tilt: 0 },
  // legacy (before the projection): older checkouts share setup.json and still read these; here they
  // only seed the default projection while there is no projection.json (projectionFromSetup())
  mirror: true,
  zone: { near: 0.5, far: 4.5 }, // m from the sensor
  map: { mode: 'fit', factor: 1.5, distance: 3, depth: 0, apply: 'person', clamp: true, margin: 0.3, lift: 0, scaleY: 1, image: 'true' },
  color: { brightness: 1, gamma: 1, r: 1, g: 1, b: 1 },
  // block zones: nobody standing in one is tracked. Polygons on the floor plan: [x, z] = m from the
  // wall's left edge (as the audience sees it, real place) and m in front of the wall
  blocks: [],
});

/** Every setting with its range and label (the control center builds its form from this; legacy ones are hidden). */
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

  { key: 'mirror', legacy: true },
  { key: 'zone.near', min: 0.3, max: 8, legacy: true },
  { key: 'zone.far', min: 0.5, max: 10, legacy: true },
  { key: 'map.mode', options: ['real', 'factor', 'fit'], legacy: true },
  { key: 'map.factor', min: 0.25, max: 5, legacy: true },
  { key: 'map.distance', min: 0.5, max: 10, legacy: true },
  { key: 'map.depth', min: 0, max: 1, legacy: true },
  { key: 'map.apply', options: ['person', 'points'], legacy: true },
  { key: 'map.clamp', legacy: true },
  { key: 'map.margin', min: 0, max: 2, legacy: true },
  { key: 'map.image', options: ['true', 'stretch'], legacy: true },
  { key: 'map.lift', min: -3, max: 3, legacy: true },
  { key: 'map.scaleY', min: 0.25, max: 4, legacy: true },

  { key: 'color.brightness', label: 'Helligkeit', min: 0, max: 2, step: 0.01, group: 'Farbe (nur Ausgabe)' },
  { key: 'color.gamma', label: 'Gamma', min: 0.3, max: 3, step: 0.01, group: 'Farbe (nur Ausgabe)' },
  { key: 'color.r', label: 'Rot', min: 0, max: 1.5, step: 0.01, group: 'Farbe (nur Ausgabe)' },
  { key: 'color.g', label: 'Grün', min: 0, max: 1.5, step: 0.01, group: 'Farbe (nur Ausgabe)' },
  { key: 'color.b', label: 'Blau', min: 0, max: 1.5, step: 0.01, group: 'Farbe (nur Ausgabe)' },
].map((f) => Object.freeze({ ...f, kind: f.options ? 'select' : typeof getPath(WALL_DEFAULTS, f.key) })));

/** A projection: how people are mapped onto the wall (see the top of this file and WALL.md). */
export const PROJECTION_DEFAULTS = Object.freeze({
  mirror: true,
  // the play field on the floor plan (m): front and back edge, their left and right ends
  field: { near: 0.8, far: 4.3, nearL: 1.6, nearR: 4.4, farL: 1.6, farR: 4.4, low: 0, high: 2 },
  // where it lands on the wall: m from the left and the right edge; height range on the wall (m)
  out: { left: 0, right: 0, bottom: 0, top: 2 },
  curve: { x: [], y: [], z: [] },
  apply: 'person',
  edge: 'clamp',
  margin: 0.3,
  smoothing: 0,
  predict: 0,
  body: { scale: 1, fit: 'real', height: 1.7 },
  zone: { near: 0.7, far: 4.7 }, // m in front of the wall
  image: { mode: 'true', distance: 3.3 }, // m in front of the wall
});

/** Every projection value with its range and label (control center form; per-scene overrides use these keys). */
export const PROJECTION_FIELDS = Object.freeze([
  { key: 'field.near', label: 'vorne (m vor der Wand)', min: 0, max: 15, step: 0.01, group: 'Spielfeld' },
  { key: 'field.far', label: 'hinten (m vor der Wand)', min: 0.2, max: 20, step: 0.01, group: 'Spielfeld' },
  { key: 'field.nearL', label: 'vorne links (m vom linken Wandrand)', min: -30, max: 60, step: 0.01, group: 'Spielfeld' },
  { key: 'field.nearR', label: 'vorne rechts', min: -30, max: 60, step: 0.01, group: 'Spielfeld' },
  { key: 'field.farL', label: 'hinten links', min: -30, max: 60, step: 0.01, group: 'Spielfeld' },
  { key: 'field.farR', label: 'hinten rechts', min: -30, max: 60, step: 0.01, group: 'Spielfeld' },
  { key: 'zone.near', label: 'Personen zählen ab (m vor der Wand)', min: 0, max: 15, step: 0.05, group: 'Spielfeld' },
  { key: 'zone.far', label: 'Personen zählen bis', min: 0.2, max: 20, step: 0.05, group: 'Spielfeld' },

  { key: 'out.left', label: 'Ziel: Abstand vom linken Wandrand (m)', min: -10, max: 30, step: 0.01, group: 'Auf der Wand' },
  { key: 'out.right', label: 'Ziel: Abstand vom rechten Wandrand (m)', min: -10, max: 30, step: 0.01, group: 'Auf der Wand' },
  { key: 'mirror', label: 'Spiegeln (jeder auf seiner Seite)', group: 'Auf der Wand' },
  { key: 'edge', label: 'Am Wandrand', options: { festhalten: 'clamp', 'weich abbremsen': 'soft', 'frei (darf hinaus)': 'free' }, group: 'Auf der Wand' },
  { key: 'margin', label: 'Randabstand der Körpermitte (m)', min: 0, max: 2, step: 0.01, group: 'Auf der Wand' },
  { key: 'field.low', label: 'Höhe im Raum von (m)', min: -1, max: 4, step: 0.01, group: 'Höhe' },
  { key: 'field.high', label: 'Höhe im Raum bis (m)', min: 0.2, max: 5, step: 0.01, group: 'Höhe' },
  { key: 'out.bottom', label: '→ auf der Wand von (m über dem Boden)', min: -5, max: 10, step: 0.01, group: 'Höhe' },
  { key: 'out.top', label: '→ auf der Wand bis (m)', min: -4, max: 12, step: 0.01, group: 'Höhe' },

  { key: 'apply', label: 'Abbilden', options: { 'die Position (Körper behält seine Form)': 'person', 'jeden Punkt (Körper wird mitgedehnt)': 'points' }, group: 'Körper und Bewegung' },
  { key: 'body.scale', label: 'Körpergröße (×)', min: 0.25, max: 3, step: 0.01, group: 'Körper und Bewegung' },
  { key: 'body.fit', label: 'Größe', options: { echt: 'real', 'alle gleich groß': 'height' }, group: 'Körper und Bewegung' },
  { key: 'body.height', label: 'Zielgröße (m)', min: 0.8, max: 2.6, step: 0.01, group: 'Körper und Bewegung' },
  { key: 'smoothing', label: 'Position glätten (0 aus … 1 stark)', min: 0, max: 1, step: 0.01, group: 'Körper und Bewegung' },
  { key: 'predict', label: 'Vorhersage (s, gegen Verzögerung)', min: 0, max: 0.3, step: 0.005, group: 'Körper und Bewegung' },

  { key: 'image.mode', label: 'Kamerabild-Szenen (kinectUv)', options: { 'echte Proportionen': 'true', 'wie die Personen dehnen': 'stretch' }, group: 'Kamerabild-Szenen' },
  { key: 'image.distance', label: 'Bezugsabstand (m vor der Wand)', min: 0.3, max: 15, step: 0.05, group: 'Kamerabild-Szenen' },

  { key: 'curve.x', label: 'Kurve quer', kind: 'curve' },
  { key: 'curve.y', label: 'Kurve Höhe', kind: 'curve' },
  { key: 'curve.z', label: 'Kurve Tiefe', kind: 'curve' },
].map((f) => Object.freeze({ ...f, kind: f.kind ?? (f.options ? 'select' : typeof getPath(PROJECTION_DEFAULTS, f.key)) })));

/** The Kinect v2 depth camera, until the hub sent its table: half the view as tan, pixel model. */
export const TAN_H = Math.tan((70.6 / 2) * (Math.PI / 180));
const KINECT_W = 512;
const KINECT_H = 424;
export const SLOTS = 17; // person slots 0..16 (0 = nobody)
const MIN_Z = 0.3;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function accepts(f, v) {
  if (f.kind === 'select') return optionValues(f.options).includes(v);
  if (f.kind === 'boolean') return typeof v === 'boolean';
  if (f.kind === 'curve') return Array.isArray(v);
  return typeof v === 'number' && Number.isFinite(v);
}

/** A complete, valid setup from anything (missing or broken values: the defaults). */
export function normalizeSetup(raw) {
  const out = structuredClone(WALL_DEFAULTS);
  for (const f of SETUP_FIELDS) {
    const v = getPath(raw, f.key);
    if (!accepts(f, v)) continue;
    setPath(out, f.key, f.kind === 'number' ? clamp(v, f.min, f.max) : v);
  }
  out.led.w = Math.round(out.led.w);
  out.led.h = Math.round(out.led.h);
  if (out.zone.far <= out.zone.near) out.zone.far = out.zone.near + 0.5;
  out.blocks = normalizeBlocks(raw?.blocks);
  const w = raw?.output?.window;
  if (w && ['left', 'top', 'width', 'height'].every((k) => Number.isFinite(w[k]))) {
    out.output.window = { left: Math.round(w.left), top: Math.round(w.top), width: Math.max(1, Math.round(w.width)), height: Math.max(1, Math.round(w.height)), label: String(w.label ?? '').slice(0, 80) };
  }
  return out;
}

const MAX_BLOCKS = 32;
const MAX_BLOCK_POINTS = 64;

/** Valid block zones: { id, name, enabled, points: [[x, z], ...] } with 3..64 points. */
export function normalizeBlocks(raw) {
  const out = [];
  for (const b of Array.isArray(raw) ? raw.slice(0, MAX_BLOCKS) : []) {
    const points = (Array.isArray(b?.points) ? b.points : [])
      .slice(0, MAX_BLOCK_POINTS)
      .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map((p) => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000]);
    if (points.length < 3) continue;
    out.push({
      id: typeof b.id === 'string' && /^[a-z0-9]{1,32}$/i.test(b.id) ? b.id : Math.random().toString(36).slice(2, 10),
      name: typeof b.name === 'string' ? b.name.slice(0, 60) : '',
      enabled: b.enabled !== false,
      points,
    });
  }
  return out;
}

/** Is [x, z] inside the polygon (list of [x, z])? */
export function inPolygon(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// ---------- curves ----------

export const LUT_N = 33; // samples of a curve table: t = 0, 1/32, ..., 1
const LUT_SEG = LUT_N - 1;
const MAX_CURVE_POINTS = 5;

/** Valid inner points of a curve: x strictly inside 0..1 and increasing, y 0..1 and not decreasing. */
export function normalizeCurve(raw) {
  const pts = (Array.isArray(raw) ? raw : [])
    .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p) => [clamp(p[0], 0.02, 0.98), clamp(p[1], 0, 1)])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const p of pts) {
    if (out.length && p[0] - out.at(-1)[0] < 0.03) continue;
    if (out.length >= MAX_CURVE_POINTS) break;
    out.push([Math.round(p[0] * 1000) / 1000, Math.round(Math.max(p[1], out.at(-1)?.[1] ?? 0) * 1000) / 1000]);
  }
  return out;
}

/** The curve through (0, 0), the inner points and (1, 1) as a table of LUT_N samples (monotone cubic). */
export function curveLut(inner, out = new Float32Array(LUT_N)) {
  const p = [[0, 0], ...normalizeCurve(inner), [1, 1]];
  const n = p.length;
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((p[i + 1][1] - p[i][1]) / (p[i + 1][0] - p[i][0]));
  const m = p.map((_, i) => (i === 0 ? d[0] : i === n - 1 ? d[n - 2] : d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2));
  // Fritsch-Carlson: no overshoot, so the curve stays monotone
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  let seg = 0;
  for (let k = 0; k < LUT_N; k++) {
    const x = k / LUT_SEG;
    while (seg < n - 2 && x > p[seg + 1][0]) seg++;
    const h = p[seg + 1][0] - p[seg][0];
    const t = (x - p[seg][0]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    out[k] = (2 * t3 - 3 * t2 + 1) * p[seg][1] + (t3 - 2 * t2 + t) * h * m[seg] + (-2 * t3 + 3 * t2) * p[seg + 1][1] + (t3 - t2) * h * m[seg + 1];
  }
  out[0] = 0;
  out[LUT_SEG] = 1;
  for (let k = 1; k < LUT_N; k++) out[k] = Math.max(out[k], out[k - 1]);
  return out;
}

/** The inverse of a monotone table (for the camera image: wall -> room). */
export function invertLut(lut, out = new Float32Array(LUT_N)) {
  let j = 0;
  for (let k = 0; k < LUT_N; k++) {
    const y = k / LUT_SEG;
    while (j < LUT_SEG - 1 && lut[j + 1] < y) j++;
    const a = lut[j];
    const b = lut[j + 1];
    out[k] = (j + (b > a ? clamp((y - a) / (b - a), 0, 1) : 0)) / LUT_SEG;
  }
  out[0] = 0;
  out[LUT_SEG] = 1;
  return out;
}

/** A table at t (0..1 between the samples; beyond it goes on along the end segments). Same as wallCurve() in WGSL. */
export function evalLut(lut, t) {
  if (t <= 0) return lut[0] + t * (lut[1] - lut[0]) * LUT_SEG;
  if (t >= 1) return lut[LUT_SEG] + (t - 1) * (lut[LUT_SEG] - lut[LUT_SEG - 1]) * LUT_SEG;
  const f = t * LUT_SEG;
  const i = Math.floor(f);
  return lut[i] + (lut[Math.min(i + 1, LUT_SEG)] - lut[i]) * (f - i);
}

/** Ready-made curves for the editor: inner points. */
export const CURVE_PRESETS = Object.freeze({
  linear: { label: 'linear', points: [] },
  edges: { label: 'Mitte ruhig, Ränder schnell', points: [[0.25, 0.32], [0.75, 0.68]] },
  center: { label: 'Mitte schnell, Ränder ruhig', points: [[0.25, 0.16], [0.75, 0.84]] },
  easeIn: { label: 'am Anfang fein', points: [[0.5, 0.32]] },
  easeOut: { label: 'am Ende fein', points: [[0.5, 0.68]] },
});

// ---------- projections ----------

/** A complete, valid projection from anything (missing or broken values: the defaults). */
export function normalizeProfile(raw) {
  const out = structuredClone(PROJECTION_DEFAULTS);
  for (const f of PROJECTION_FIELDS) {
    const v = getPath(raw, f.key);
    if (!accepts(f, v)) continue;
    setPath(out, f.key, f.kind === 'number' ? clamp(v, f.min, f.max) : f.kind === 'curve' ? normalizeCurve(v) : v);
  }
  const F = out.field;
  F.far = Math.max(F.far, F.near + 0.2);
  F.nearR = Math.max(F.nearR, F.nearL + 0.1);
  F.farR = Math.max(F.farR, F.farL + 0.1);
  F.high = Math.max(F.high, F.low + 0.1);
  if (Math.abs(out.out.top - out.out.bottom) < 0.1) out.out.top = out.out.bottom + 0.1;
  out.zone.far = Math.max(out.zone.far, out.zone.near + 0.2);
  return out;
}

/** The value of `key` from a projection override map: flat { 'body.scale': 0.6 } or nested { body: { scale } }. */
function overrideValue(o, key) {
  if (!o || typeof o !== 'object') return undefined;
  return key in o ? o[key] : getPath(o, key);
}

/** Valid per-scene overrides: { key: value } with the keys of PROJECTION_FIELDS (flat or nested input). */
export function normalizeOverrides(raw) {
  const out = {};
  for (const f of PROJECTION_FIELDS) {
    const v = overrideValue(raw, f.key);
    if (v === undefined || !accepts(f, v)) continue;
    out[f.key] = f.kind === 'number' ? clamp(v, f.min, f.max) : f.kind === 'curve' ? normalizeCurve(v) : v;
  }
  return out;
}

/** Every value of a projection as flat { key: value }. */
export function flattenProfile(p) {
  const out = {};
  for (const f of PROJECTION_FIELDS) out[f.key] = structuredClone(getPath(p, f.key));
  return out;
}

/** The trapezoid of the view cone (plan x of the left and right edge) at `z` m in front of the wall, `inset` m inside it. */
export function coneAt(setup, tanH, z, inset = 0) {
  const c = setup.size.w / 2 + setup.sensor.x;
  const half = Math.max(0.05, (z - setup.sensor.front) * tanH - inset);
  return [c - half, c + half];
}

/**
 * A play field from the view cone between `near` and `far` (m in front of the wall), `inset` m inside
 * the view (people at the edge of the view are tracked badly): { field.near, far, nearL, ... }.
 */
export function fieldFromCone(setup, tanH, near, far, inset = 0.25) {
  const cm = (v) => Math.round(v * 100) / 100;
  const [nearL, nearR] = coneAt(setup, tanH, near, inset).map(cm);
  const [farL, farR] = coneAt(setup, tanH, far, inset).map(cm);
  return { near, far, nearL, nearR, farL, farR };
}

/** The projection that maps like the old setup.map / zone / mirror did (to seed the default). */
export function projectionFromSetup(setup, tanH = TAN_H) {
  const s = normalizeSetup(setup);
  const m = s.map;
  const front = s.sensor.front;
  const c = s.size.w / 2 + s.sensor.x;
  const near = front + s.zone.near;
  const far = front + s.zone.far;
  // half the field's width at room distance z (from the sensor)
  let half;
  if (m.mode === 'real') half = () => null;
  else if (m.mode === 'factor') half = () => s.size.w / 2 / m.factor;
  else half = (z) => m.distance * tanH * (Math.max(z, MIN_Z) / m.distance) ** m.depth;
  const edges = (z) => {
    if (m.mode === 'real') return [0, s.size.w];
    const h = half(z);
    // 'factor' kept the sensor's place: the field is as asymmetric as the wall around it
    if (m.mode === 'factor') return [c - (s.size.w / 2 + s.sensor.x) / m.factor, c + (s.size.w / 2 - s.sensor.x) / m.factor];
    return [c - h, c + h];
  };
  const [nearL, nearR] = edges(s.zone.near);
  const [farL, farR] = edges(s.zone.far);
  const r2 = (v) => Math.round(v * 100) / 100;
  return normalizeProfile({
    mirror: s.mirror,
    field: { near: r2(near), far: r2(far), nearL: r2(nearL), nearR: r2(nearR), farL: r2(farL), farR: r2(farR), low: 0, high: 2 },
    out: { left: 0, right: 0, bottom: m.lift, top: m.lift + 2 * m.scaleY },
    apply: m.apply,
    edge: m.clamp ? 'clamp' : 'free',
    margin: m.margin,
    zone: { near: r2(near), far: r2(far) },
    image: { mode: m.image, distance: r2(front + m.distance) },
  });
}

/** The projection document (projection.json): { default: profile, scenes: { name: overrides } }. */
export function normalizeProjectionDoc(raw, setup) {
  const scenes = {};
  for (const [name, o] of Object.entries(raw?.scenes ?? {})) {
    if (!NAME_RE.test(name)) continue;
    const v = normalizeOverrides(o);
    if (Object.keys(v).length) scenes[name] = v;
  }
  return { default: raw?.default ? normalizeProfile(raw.default) : projectionFromSetup(setup), scenes };
}

/**
 * A scene's wish for its play field, relative to the sensor (so it fits any room), -> field values:
 *   'cone'                 the view cone itself (its edges reach the wall's edges at every distance)
 *   'real'                 the wall itself: everybody exactly in front of themselves (1:1)
 *   { depth: [near, far] } m from the sensor (front and back edge; else those of `base`), and
 *     width: m             a box that wide around the sensor, or [front, back] (a trapezoid)
 *     cone: inset          the view cone, `inset` m inside it
 *     real: true           the wall itself
 *   (depth alone keeps the shape of `base`, its edges carried to the new depths)
 */
export function fieldFromWish(wish, base, setup, tanH = TAN_H) {
  const s = normalizeSetup(setup);
  const w = typeof wish === 'string' ? { [wish]: wish === 'cone' ? 0 : true } : (wish ?? {});
  const c = s.size.w / 2 + s.sensor.x;
  const cm = (v) => Math.round(v * 100) / 100;
  const ok = Array.isArray(w.depth) && w.depth.length === 2 && w.depth.every(Number.isFinite);
  const near = ok ? cm(s.sensor.front + Math.max(0.3, Math.min(w.depth[0], w.depth[1] - 0.2))) : base.near;
  const far = ok ? cm(s.sensor.front + Math.max(w.depth[1], w.depth[0] + 0.2)) : base.far;
  if (w.real) return { near, far, nearL: 0, nearR: s.size.w, farL: 0, farR: s.size.w };
  if (Number.isFinite(w.cone)) return fieldFromCone(s, tanH, near, far, w.cone);
  const width = Number.isFinite(w.width) ? [w.width, w.width] : Array.isArray(w.width) && w.width.every(Number.isFinite) ? w.width : null;
  if (width) return { near, far, nearL: cm(c - width[0] / 2), nearR: cm(c + width[0] / 2), farL: cm(c - width[1] / 2), farR: cm(c + width[1] / 2) };
  // depth only: the base's edges, carried along to the new depths
  const at = (z, a, b) => a + ((b - a) * (z - base.near)) / Math.max(0.01, base.far - base.near);
  return { near, far, nearL: cm(at(near, base.nearL, base.farL)), nearR: cm(at(near, base.nearR, base.farR)), farL: cm(at(far, base.nearL, base.farL)), farR: cm(at(far, base.nearR, base.farR)) };
}

/**
 * The projection of scene `name`: the default for all scenes, then what the scene asks for in its
 * main.js (`projection: { ... }`), then what was set for it in the control center. The scene's
 * `field` may be a wish relative to the sensor (fieldFromWish(): 'cone', 'real', { depth, width });
 * that needs `env` = { setup, tanH }.
 */
export function resolveProjection(doc, name, sceneDefaults = null, env = null) {
  const p = structuredClone(doc.default);
  for (const [k, v] of Object.entries(normalizeOverrides(sceneDefaults))) setPath(p, k, v);
  const wish = sceneDefaults?.field;
  if (wish && (typeof wish === 'string' || ['depth', 'width', 'cone', 'real'].some((k) => k in wish)) && env?.setup) {
    Object.assign(p.field, fieldFromWish(wish, p.field, env.setup, env.tanH ?? TAN_H));
  }
  for (const [k, v] of Object.entries(doc.scenes?.[name] ?? {})) setPath(p, k, v);
  return normalizeProfile(p);
}

// ---------- room ----------

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
const U = { room: 0, roomInv: 16, led: 32, bottom: 36, mirror: 40, zone: 44, field: 48, field2: 52, out: 56, inv: 60, image: 64, curves: 68, slots: 68 + 5 * 36 };
const CURVE_X = 0;
const CURVE_Y = 1;
const CURVE_Z = 2;
const CURVE_IX = 3;
const CURVE_IY = 4;
export const WALL_UNIFORM_BYTES = (U.slots + SLOTS * 4) * 4;

/** WGSL: struct Wall, the binding and the mapping functions (same math as WallMap below). */
export function wallWgsl(group = 0, binding = 0) {
  return /* wgsl */ `
struct Wall {
  room: mat4x4f,     // world -> room
  roomInv: mat4x4f,  // room -> world
  led: vec2f,        // LED pixels
  size: vec2f,       // m
  bottom: f32, sensorX: f32, front: f32, xSign: f32,
  mirrorSign: f32, perPerson: f32, tanH: f32, ledImage: f32,
  near: f32, far: f32, side: f32, planX0: f32, // zone in room z (m from the sensor); side = wall x per room x
  fNear: f32, fFar: f32, nearL: f32, nearR: f32, // play field (plan m)
  farL: f32, farR: f32, low: f32, high: f32,
  outL: f32, outR: f32, outBottom: f32, outTop: f32,
  inv: vec4f,        // camera ray -> depth image pixel: u = x + y * rx, v = z + w * ry
  imageDist: f32, imageStretch: f32, margin: f32, pad0: f32,
  curves: array<vec4f, 45>, // 5 tables of 33 samples (x, y, z, inverse x, inverse y), 9 vec4 each
  slots: array<vec4f, ${SLOTS}>, // per person slot: x = wall x offset, y = body scale, z = 1 if visible, w = offset per second
};
@group(${group}) @binding(${binding}) var<uniform> WALL: Wall;

fn wallLut(c: u32, i: u32) -> f32 { return WALL.curves[c * 9u + i / 4u][i % 4u]; }
// curve c (0 x, 1 y, 2 z, 3 inverse x, 4 inverse y) at t; beyond 0..1 it goes on along the end segments
fn wallCurve(c: u32, t: f32) -> f32 {
  if (t <= 0.0) { let a = wallLut(c, 0u); return a + t * (wallLut(c, 1u) - a) * ${LUT_SEG}.0; }
  if (t >= 1.0) { let b = wallLut(c, ${LUT_SEG}u); return b + (t - 1.0) * (b - wallLut(c, ${LUT_SEG - 1}u)) * ${LUT_SEG}.0; }
  let f = t * ${LUT_SEG}.0;
  let i = min(u32(f), ${LUT_SEG - 1}u);
  return mix(wallLut(c, i), wallLut(c, i + 1u), f - f32(i));
}
// across the play field at a floor point (plan m): 0 at its left edge, 1 at its right edge (mirror: flipped)
fn wallFieldU(px: f32, pz: f32) -> f32 {
  let v = clamp((pz - WALL.fNear) / max(WALL.fFar - WALL.fNear, 0.01), -1.0, 2.0);
  let l = mix(WALL.nearL, WALL.farL, v);
  let r = mix(WALL.nearR, WALL.farR, v);
  let u = (px - l) / max(r - l, 0.05);
  return select(1.0 - u, u, WALL.mirrorSign > 0.0);
}
// floor point (plan m) -> wall x (m), without a person's place
fn wallMapX(px: f32, pz: f32) -> f32 { return WALL.outL + wallCurve(${CURVE_X}u, wallFieldU(px, pz)) * (WALL.outR - WALL.outL); }
// height above the floor (m) -> height on the wall (m)
fn wallMapY(y: f32) -> f32 { return WALL.outBottom + wallCurve(${CURVE_Y}u, (y - WALL.low) / max(WALL.high - WALL.low, 0.01)) * (WALL.outTop - WALL.outBottom); }
// height on the wall (m) -> height above the floor (m): the inverse of wallMapY
fn wallRoomY(y: f32) -> f32 { return WALL.low + wallCurve(${CURVE_IY}u, (y - WALL.outBottom) / (WALL.outTop - WALL.outBottom)) * (WALL.high - WALL.low); }
// depth in the play field: 0 at its front edge .. 1 at its back edge (after the curve)
fn wallFieldZ(pz: f32) -> f32 { return wallCurve(${CURVE_Z}u, (pz - WALL.fNear) / max(WALL.fFar - WALL.fNear, 0.01)); }
// world (m, as ctx.persons) -> room (floor y = 0)
fn wallRoom(world: vec3f) -> vec3f { return (WALL.room * vec4f(world, 1.0)).xyz; }
// room -> floor plan (m): x from the wall's left edge (real place), z in front of the wall
fn wallPlan(r: vec3f) -> vec2f { return vec2f(WALL.planX0 + WALL.xSign * r.x, WALL.front + r.z); }
// stretch factor (wall m per floor m) beside the sensor at \`lat\` m, \`z\` m from it
fn wallK(lat: f32, z: f32) -> f32 {
  let px = WALL.planX0 + lat;
  let pz = WALL.front + max(z, ${MIN_Z});
  return abs(wallMapX(px + 0.02, pz) - wallMapX(px - 0.02, pz)) / 0.04;
}
// room point of person \`slot\` (0 = nobody) -> wall: x from the left edge, y above the floor, z in front of the wall (m)
fn wallFromRoom(r: vec3f, slot: u32) -> vec3f {
  let p = wallPlan(r);
  let s = WALL.slots[min(slot, ${SLOTS - 1}u)];
  let person = WALL.perPerson > 0.5 && slot > 0u && s.z > 0.5;
  let x = select(wallMapX(p.x, p.y), s.x + WALL.mirrorSign * p.x * s.y, person);
  return vec3f(x, wallMapY(r.y * select(1.0, s.y, person)), p.y);
}
fn wallFromWorld(world: vec3f, slot: u32) -> vec3f { return wallFromRoom(wallRoom(world), slot); }
// 0..1 in the projection: across the wall's target range, up its height range, front to back of the field
fn wallNorm(r: vec3f, slot: u32) -> vec3f {
  let w = wallFromRoom(r, slot);
  return vec3f((w.x - WALL.outL) / (WALL.outR - WALL.outL), (w.y - WALL.outBottom) / (WALL.outTop - WALL.outBottom), wallFieldZ(w.z));
}
// velocity (room m/s) of the room point r of person \`slot\` -> on the wall (m/s: x right, y up, z towards
// the audience). The stretched walk moves along: a person walking 1 m/s moves k m/s on the wall.
fn wallVelocity(r: vec3f, v: vec3f, slot: u32) -> vec3f {
  let p = wallPlan(r);
  let s = WALL.slots[min(slot, ${SLOTS - 1}u)];
  let person = WALL.perPerson > 0.5 && slot > 0u && s.z > 0.5;
  let k = select(1.0, s.y, person);
  let gx = (wallMapX(p.x + 0.02, p.y) - wallMapX(p.x - 0.02, p.y)) / 0.04;
  let gz = (wallMapX(p.x, p.y + 0.02) - wallMapX(p.x, p.y - 0.02)) / 0.04;
  let vx = select(gx * WALL.xSign * v.x + gz * v.z, WALL.mirrorSign * WALL.xSign * v.x * s.y + s.w, person);
  let gy = (wallMapY(r.y * k + 0.01) - wallMapY(r.y * k - 0.01)) / 0.02;
  return vec3f(vx, gy * k * v.y, v.z);
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
// image.distance: in true proportions, or stretched like the people (image.mode).
fn wallToKinect(uv: vec2f) -> vec2f {
  let w = wallAt(uv);
  let pz = WALL.imageDist;
  var px = WALL.planX0 + WALL.mirrorSign * (w.x - WALL.planX0);
  if (WALL.imageStretch > 0.5) {
    var u = wallCurve(${CURVE_IX}u, (w.x - WALL.outL) / (WALL.outR - WALL.outL));
    u = select(1.0 - u, u, WALL.mirrorSign > 0.0);
    let v = (pz - WALL.fNear) / max(WALL.fFar - WALL.fNear, 0.01);
    let l = mix(WALL.nearL, WALL.farL, v);
    px = l + u * (mix(WALL.nearR, WALL.farR, v) - l);
  }
  let room = vec3f((px - WALL.planX0) * WALL.xSign, wallRoomY(w.y), pz - WALL.front);
  let world = (WALL.roomInv * vec4f(room, 1.0)).xyz;
  let c = vec3f(WALL.xSign * world.x, -world.y, max(world.z, 0.01));
  let p = vec2f(WALL.inv.x + WALL.inv.y * c.x / c.z, WALL.inv.z + WALL.inv.w * c.y / c.z);
  return (p + 0.5) / vec2f(${KINECT_W}.0, ${KINECT_H}.0);
}
`;
}

// ---------- the mapping (CPU) ----------

// One-Euro filter on a floor point: the cutoff grows with the speed (little lag when moving fast)
const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
function euro(f, x, dt, minCutoff, beta) {
  if (!f.x || dt <= 0) {
    f.x = x.slice();
    f.dx = [0, 0, 0];
    return f.x.slice();
  }
  const ad = alpha(1, dt);
  for (let j = 0; j < 3; j++) f.dx[j] += ad * ((x[j] - f.x[j]) / dt - f.dx[j]);
  const a = alpha(minCutoff + beta * Math.hypot(f.dx[0], f.dx[2]), dt);
  for (let j = 0; j < 3; j++) f.x[j] += a * (x[j] - f.x[j]);
  return f.x.slice();
}

const HEIGHT_WINDOW_S = 6; // body.fit 'height': standing height = 80th percentile of the last 6 s
const PERSON_KEEP_MS = 3000; // a person's filter state survives this long without them

/**
 * ctx.wall: the setup, the scene's projection and the mapping, updated by the runtime before every
 * frame(). Points are [x, y, z] arrays; every method takes an optional `out` array.
 */
export class WallMap {
  constructor(setup = WALL_DEFAULTS, projection = null) {
    this.setup = normalizeSetup(setup);
    this._luts = Array.from({ length: 5 }, () => new Float32Array(LUT_N));
    this._invZ = new Float32Array(LUT_N); // inverse depth curve (fieldDepth(); JS only)
    this.setProjection(projection ?? projectionFromSetup(this.setup));
    /** true when the canvas is the LED image (a wall scene, or the output window) */
    this.active = false;
    /** true in the output window (the one that goes to the LED controller) */
    this.output = false;
    this.xSign = -1;
    this.room = { matrix: manualRoom(0.85, 0), inverse: rigidInverse(manualRoom(0.85, 0)), found: false, height: 0.85, source: 'manual' };
    this.tanH = TAN_H;
    this.inv = [255.5, 365.5, 205.5, 365.5]; // u = a + b·rx, v = c + d·ry (pinhole until the table came)
    /** per person slot: wall x = offset + mirrorSign·planX·scale (apply 'person'), its change per second */
    this.offset = new Float32Array(SLOTS);
    this.scale = new Float32Array(SLOTS).fill(1);
    this.rate = new Float32Array(SLOTS);
    /** per person slot: how far its place is moved on the wall (m) and how fast (m/s); body scale 1 only */
    this.shift = new Float32Array(SLOTS);
    this.shiftRate = new Float32Array(SLOTS);
    this.visible = new Uint8Array(SLOTS);
    /** per visible person: where it is on the wall (see place()) */
    this.persons = [];
    /** persons removed by a block zone in the last tracking result: [{ id, slot, x, z }] (floor plan) */
    this.blockedPersons = [];
    /** the mouse on the wall: x, y (m), u, v, down; set by the runtime */
    this.pointer = { x: 0, y: 0, u: 0, v: 0, down: false, inside: false };
    this.version = 0; // +1 whenever the setup or the projection changes
    this._track = new Map(); // person id -> { euro, heights, est, at }
    this._t = 0;
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

  /** The scene's projection (a profile as resolveProjection() gives it). */
  setProjection(p) {
    this.projection = normalizeProfile(p);
    const c = this.projection.curve;
    curveLut(c.x, this._luts[CURVE_X]);
    curveLut(c.y, this._luts[CURVE_Y]);
    curveLut(c.z, this._luts[CURVE_Z]);
    invertLut(this._luts[CURVE_X], this._luts[CURVE_IX]);
    invertLut(this._luts[CURVE_Y], this._luts[CURVE_IY]);
    invertLut(this._luts[CURVE_Z], this._invZ);
    this.version++;
  }

  /** +1 or -1: the wall mirrors (everyone on their own side) or not */
  get mirrorSign() {
    return this.projection.mirror ? 1 : -1;
  }

  /** wall x per room x beside the sensor: +1 or -1 (mirror, and the view's xSign which the room frame carries) */
  get side() {
    return this.mirrorSign * this.xSign;
  }

  /** plan x of the sensor (m from the wall's left edge) */
  get planX0() {
    return this.setup.size.w / 2 + this.setup.sensor.x;
  }

  /** The zone in room z (m from the sensor, as rz in per-pixel loops): who counts. */
  get zone() {
    const z = this.projection.zone;
    const f = this.setup.sensor.front;
    return { near: z.near - f, far: z.far - f };
  }

  /** The wall x range the play field maps onto: [left, right] (m from the wall's left edge). */
  get target() {
    const o = this.projection.out;
    return [o.left, this.setup.size.w - o.right];
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
  update(view, xSign, now = performance.now()) {
    this.xSign = xSign;
    const s = this.setup.sensor;
    const r = view?.room;
    if (s.floor === 'auto' && r?.found) {
      this.room = { matrix: r.matrix, inverse: rigidInverse(r.matrix, this.room.inverse), found: true, height: r.height, source: 'floor' };
    } else {
      const m = manualRoom(s.height, s.tilt);
      this.room = { matrix: m, inverse: rigidInverse(m, this.room.inverse), found: false, height: s.height, source: 'manual' };
    }
    const dt = this._t ? clamp((now - this._t) / 1000, 0, 0.25) : 0;
    this._t = now;
    this.offset.fill(0);
    this.scale.fill(1);
    this.rate.fill(0);
    this.shift.fill(0);
    this.shiftRate.fill(0);
    this.visible.fill(0);
    const list = [];
    for (const p of view ?? []) {
      const info = this._place(p, dt, now);
      if (!info) continue;
      if (p.slot >= 1 && p.slot < SLOTS) {
        this.offset[p.slot] = info.offset;
        this.scale[p.slot] = info.scale;
        this.rate[p.slot] = info.rate;
        this.shift[p.slot] = info.shift;
        this.shiftRate[p.slot] = info.shiftRate;
        this.visible[p.slot] = 1;
      }
      list.push(info);
    }
    for (const [id, st] of this._track) if (now - st.at > PERSON_KEEP_MS) this._track.delete(id);
    this.persons = list;
    this._writeGpu();
  }

  // ----- the projection, step by step -----

  /** Across the play field at a floor point (plan m): 0 at its left edge, 1 at its right edge (mirror: flipped). */
  fieldU(px, pz) {
    const F = this.projection.field;
    const v = clamp((pz - F.near) / Math.max(F.far - F.near, 0.01), -1, 2);
    const l = F.nearL + (F.farL - F.nearL) * v;
    const r = F.nearR + (F.farR - F.nearR) * v;
    const u = (px - l) / Math.max(r - l, 0.05);
    return this.projection.mirror ? u : 1 - u;
  }

  /** The play field's left and right edge (plan x) at `pz` m in front of the wall. */
  fieldAt(pz, out = [0, 0]) {
    const F = this.projection.field;
    const v = (pz - F.near) / Math.max(F.far - F.near, 0.01);
    out[0] = F.nearL + (F.farL - F.nearL) * v;
    out[1] = F.nearR + (F.farR - F.nearR) * v;
    return out;
  }

  /** Floor point (plan m) -> wall x (m), without a person's place and without the edge. */
  mapX(px, pz) {
    const [l, r] = this.target;
    return l + evalLut(this._luts[CURVE_X], this.fieldU(px, pz)) * (r - l);
  }

  /** Height above the floor (m) -> height on the wall (m). */
  mapY(y) {
    const P = this.projection;
    return P.out.bottom + evalLut(this._luts[CURVE_Y], (y - P.field.low) / Math.max(P.field.high - P.field.low, 0.01)) * (P.out.top - P.out.bottom);
  }

  /** Height on the wall (m) -> height above the floor (m): the inverse of mapY(). */
  unmapY(y) {
    const P = this.projection;
    return P.field.low + evalLut(this._luts[CURVE_IY], (y - P.out.bottom) / (P.out.top - P.out.bottom)) * (P.field.high - P.field.low);
  }

  /** Depth in the play field: 0 at its front edge .. 1 at its back edge (after the curve; beyond: < 0, > 1). */
  fieldZ(pz) {
    const F = this.projection.field;
    return evalLut(this._luts[CURVE_Z], (pz - F.near) / Math.max(F.far - F.near, 0.01));
  }

  /** The inverse of fieldZ(): depth 0..1 in the play field -> m in front of the wall. */
  fieldDepth(t) {
    const F = this.projection.field;
    return F.near + evalLut(this._invZ, t) * (F.far - F.near);
  }

  /** A person's place on the wall at the edge: held `margin` m inside it ('clamp', 'soft'), or not ('free'). */
  edge(x) {
    const P = this.projection;
    if (P.edge === 'free') return x;
    const lo = Math.min(P.margin, this.setup.size.w / 2);
    const hi = Math.max(lo, this.setup.size.w - P.margin);
    if (P.edge === 'clamp') return clamp(x, lo, hi);
    const k = Math.min(0.6, (hi - lo) / 4);
    if (x > hi - k) return hi - k + k * Math.tanh((x - (hi - k)) / k);
    if (x < lo + k) return lo + k - k * Math.tanh((lo + k - x) / k);
    return x;
  }

  /** Wall m per floor m across, at a floor point (plan m). */
  gain(px, pz) {
    return Math.abs(this.mapX(px + 0.02, pz) - this.mapX(px - 0.02, pz)) / 0.04;
  }

  /** factor of the lateral stretch at distance z (m from the sensor), `lat` m beside it */
  k(lat, z) {
    return this.gain(this.planX0 + lat, this.setup.sensor.front + Math.max(z, MIN_Z));
  }

  // ----- points -----

  /** world (m, as ctx.persons) -> room */
  toRoom(world, out = [0, 0, 0]) {
    const p = apply(this.room.matrix, world);
    out[0] = p[0];
    out[1] = p[1];
    out[2] = p[2];
    return out;
  }

  /**
   * Room x, z of person `slot` -> wall x (m). For per-pixel loops over the person masks (rx, rz: the
   * room point, as ctx.wall.room.matrix gives it); fromRoom() does the same for a whole point.
   */
  roomX(rx, rz, slot = 0) {
    const px = this.planX0 + this.xSign * rx;
    if (this.projection.apply === 'person' && slot > 0 && slot < SLOTS && this.visible[slot]) return this.offset[slot] + this.mirrorSign * px * this.scale[slot];
    return this.mapX(px, this.setup.sensor.front + rz);
  }

  /** Room height of person `slot` -> wall y (m), for per-pixel loops. */
  roomY(ry, slot = 0) {
    const k = this.projection.apply === 'person' && slot > 0 && slot < SLOTS && this.visible[slot] ? this.scale[slot] : 1;
    return this.mapY(ry * k);
  }

  /** room point of person `slot` (or a Person; 0/null = nobody) -> wall [x, y, z] (m) */
  fromRoom(r, slot = 0, out = [0, 0, 0]) {
    const s = typeof slot === 'object' && slot ? slot.slot : slot | 0;
    const x = this.roomX(r[0], r[2], s);
    const y = this.roomY(r[1], s);
    out[0] = x;
    out[1] = y;
    out[2] = this.setup.sensor.front + r[2];
    return out;
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

  /** world point of person `slot` -> 0..1 in the projection: [across the target range, up the height range, front to back of the field] */
  norm(world, slot = 0, out = [0, 0, 0]) {
    const w = this.fromWorld(world, slot, out);
    return this._norm(w[0], w[1], w[2], out);
  }

  _norm(x, y, z, out) {
    const [l, r] = this.target;
    const o = this.projection.out;
    out[0] = (x - l) / (r - l);
    out[1] = (y - o.bottom) / (o.top - o.bottom);
    out[2] = this.fieldZ(z);
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
    const px = this.planX0 + this.xSign * r[0];
    const pz = this.setup.sensor.front + r[2];
    const person = this.projection.apply === 'person' && s > 0 && s < SLOTS && this.visible[s];
    const k = person ? this.scale[s] : 1;
    if (person) out[0] = this.mirrorSign * this.xSign * v[0] * k + this.rate[s];
    else {
      const gx = (this.mapX(px + 0.02, pz) - this.mapX(px - 0.02, pz)) / 0.04;
      const gz = (this.mapX(px, pz + 0.02) - this.mapX(px, pz - 0.02)) / 0.04;
      out[0] = gx * this.xSign * v[0] + gz * v[2];
    }
    out[1] = ((this.mapY(r[1] * k + 0.01) - this.mapY(r[1] * k - 0.01)) / 0.02) * k * v[1];
    out[2] = v[2];
    return out;
  }

  /** a joint's velocity on the wall (m/s) or null */
  jointVelocity(person, name, out = [0, 0, 0]) {
    const w = person?.joints?.[name];
    const m = person?.motion?.[name];
    return w && m ? this.velocity(w, m, person.slot, out) : null;
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
    const z = this.zone;
    return clamp((z.far - dist) / Math.max(0.01, z.far - z.near), 0, 1);
  }

  /** a joint of a person on the wall: [x, y, z] (m) or null */
  joint(person, name, out = [0, 0, 0]) {
    const w = person?.joints?.[name];
    return w ? this.fromWorld(w, person.slot, out) : null;
  }

  /**
   * Depth image pixel (u, v) -> wall [x, y] (m) as kinectUv() shows the camera image on the LED image:
   * the pixel's ray meets image.distance there (`rays`: ctx.kinect.lut.data). Null if the ray does not
   * reach it.
   */
  imageToWall(u, v, rays, out = [0, 0]) {
    const s = this.setup;
    const P = this.projection;
    const i = (clamp(Math.round(v), 0, KINECT_H - 1) * KINECT_W + clamp(Math.round(u), 0, KINECT_W - 1)) * 2;
    const rx = rays ? rays[i] : (u - this.inv[0]) / this.inv[1];
    const ry = rays ? rays[i + 1] : (v - this.inv[2]) / this.inv[3];
    const m = this.room.matrix;
    const d = apply(m, [this.xSign * rx, -ry, 1], 0);
    if (d[2] <= 1e-4) return null;
    const rz = P.image.distance - s.sensor.front;
    const t = (rz - m[14]) / d[2];
    const room = [m[12] + t * d[0], m[13] + t * d[1], rz];
    const px = this.planX0 + this.xSign * room[0];
    out[0] = P.image.mode === 'stretch' ? this.mapX(px, P.image.distance) : this.planX0 + this.mirrorSign * (px - this.planX0);
    out[1] = this.mapY(room[1]);
    return out;
  }

  /** where a person is on the wall (computed once per frame for the visible ones) */
  place(person) {
    return this.persons.find((p) => p.id === person?.id) ?? this._place(person, 0, 0, false);
  }

  /** wall point (m) -> mirror world behind the wall for 3D scenes: x from the wall center, y up, z = -distance */
  mirror(p, out = [0, 0, 0]) {
    out[0] = p[0] - this.setup.size.w / 2;
    out[1] = p[1];
    out[2] = -p[2];
    return out;
  }

  /** room point -> floor plan [x, z]: m from the wall's left edge (real place), m in front of the wall */
  plan(r, out = [0, 0]) {
    out[0] = this.planX0 + this.xSign * r[0];
    out[1] = this.setup.sensor.front + r[2];
    return out;
  }

  /** the enabled block zone at floor plan [x, z], or null */
  blockAt(x, z) {
    for (const b of this.setup.blocks) if (b.enabled && inPolygon(x, z, b.points)) return b;
    return null;
  }

  /**
   * Removes everybody standing in a block zone from a person tracking result (in place: list,
   * labels, depth, indices). Their feet decide (the point on the floor below them).
   * { exact: true }: an exact result of live + exact (no masks; blockedPersons stays as the live one set it).
   */
  filterPersons(result, { exact = false } = {}) {
    if (!result?.list?.length || !this.setup.blocks.some((b) => b.enabled)) {
      if (result && !exact) this.blockedPersons = [];
      return result;
    }
    const blocked = new Uint8Array(256);
    const gone = [];
    const r = [0, 0, 0];
    const xz = [0, 0];
    for (const c of result.list) {
      const p = c.ground ?? c.centroid;
      if (!p) continue;
      this.toRoom([(this.xSign * p[0]) / 1000, -p[1] / 1000, p[2] / 1000], r);
      this.plan(r, xz);
      if (!this.blockAt(xz[0], xz[1])) continue;
      blocked[c.slot & 255] = 1;
      gone.push({ id: c.id, slot: c.slot, x: xz[0], z: xz[1] });
    }
    if (!exact) this.blockedPersons = gone;
    if (!gone.length) return result;
    result.list = result.list.filter((c) => !blocked[c.slot & 255]);
    const { labels, depth, indices } = result;
    if (!labels || !depth || !indices) return result;
    let n = 0;
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      if (blocked[labels[i]]) {
        labels[i] = 0;
        depth[i] = 0;
      } else indices[n++] = i;
    }
    result.indices = indices.subarray(0, n);
    return result;
  }

  /** The standing height of a person (body.fit 'height'): 80th percentile of the last seconds. */
  _standing(st, person, now) {
    let h = person.height;
    if (!Number.isFinite(h) || h <= 0.3) {
      const head = person.head ? this.toRoom(person.head)[1] : null;
      h = head ? head + 0.1 : null;
    }
    if (h) {
      st.heights.push([now, h]);
      while (st.heights.length && now - st.heights[0][0] > HEIGHT_WINDOW_S * 1000) st.heights.shift();
    }
    if (!st.heights.length) return st.est ?? this.projection.body.height;
    const sorted = st.heights.map((x) => x[1]).sort((a, b) => a - b);
    const want = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.8))];
    st.est = st.est ? st.est + (want - st.est) * 0.05 : want;
    return st.est;
  }

  _place(person, dt, now, track = true) {
    const c = person?.center ?? person?.joints?.center ?? person?.ground;
    if (!c) return null;
    const s = this.setup;
    const P = this.projection;
    const front = s.sensor.front;
    const r = this.toRoom(c);
    let st = this._track.get(person.id);
    if (track && !st && person.id != null) {
      st = { euro: {}, heights: [], est: null, at: now };
      this._track.set(person.id, st);
    }
    if (track && st) st.at = now;
    // the place on the floor that is mapped: smoothed, and looked ahead along the walk
    let m = r;
    if (P.smoothing > 0 && st) {
      if (track) st.smooth = euro(st.euro, r, dt, 6 * 0.04 ** P.smoothing, 0.8);
      if (st.smooth) m = st.smooth;
    }
    const v = person.velocity ? apply(this.room.matrix, person.velocity, 0) : [0, 0, 0];
    const speed = Math.hypot(v[0], v[2]);
    const vs = speed > 3 ? 3 / speed : 1;
    if (P.predict > 0) m = [m[0] + v[0] * vs * P.predict, m[1], m[2] + v[2] * vs * P.predict];
    const realX = this.planX0 + this.xSign * r[0];
    const px = this.planX0 + this.xSign * m[0];
    const pz = front + m[2];
    const perPerson = P.apply === 'person';
    // with apply 'points' every point is mapped on its own: no edge (it would only move the label)
    const edge = (x) => (perPerson ? this.edge(x) : x);
    const x = edge(this.mapX(px, pz));
    // body size on the wall
    let k = P.body.scale;
    if (P.body.fit === 'height' && st) {
      const standing = track ? this._standing(st, person, now) : (st.est ?? P.body.height);
      k *= clamp(P.body.height / Math.max(0.5, standing), 0.55, 1.8);
    }
    // the body keeps its shape around its real center: wall x = offset + mirrorSign·planX·k
    const offset = x - this.mirrorSign * realX * k;
    // how fast the place moves on the wall while the person walks (0 when held at the edge)
    const ahead = 0.05;
    const vx = (edge(this.mapX(px + this.xSign * v[0] * vs * ahead, pz + v[2] * vs * ahead)) - x) / ahead;
    const rate = vx - this.mirrorSign * this.xSign * v[0] * k;
    const y = this.mapY(r[1] * (perPerson ? k : 1));
    const ground = person.ground ? this.toRoom(person.ground) : [r[0], 0, r[2]];
    const head = person.head ? this.toRoom(person.head) : null;
    const kk = perPerson ? k : 1;
    const uv = this.uv([x, y]);
    const lat = this.side * r[0];
    return {
      person,
      id: person.id,
      slot: person.slot,
      color: person.color,
      x, // m from the left edge (mapped)
      y, // m above the floor (body center)
      z: front + r[2], // m in front of the wall
      norm: this._norm(x, y, pz, [0, 0, 0]), // 0..1: across the target range, up the height range, front to back of the field
      plan: [realX, front + r[2]], // where the person really stands on the floor plan
      dist: r[2], // m from the sensor along the floor
      lateral: this.xSign * r[0], // m beside the sensor, as the audience sees it (+ = right)
      real: realX, // m from the left edge where the person really stands
      scale: kk, // body size on the wall (body.scale, body.fit)
      gain: this.gain(px, pz), // wall m per floor m across, here
      offset, // wall x = offset + mirrorSign·planX·scale for the person's points (apply 'person')
      rate, // m/s: how fast the offset changes
      shift: perPerson ? x - (this.planX0 + lat) : 0, // m: how far the person is moved on the wall
      shiftRate: perPerson ? vx - this.side * v[0] : 0, // m/s: how fast that changes
      vx, // m/s: the person's speed across the wall (stretched walk included)
      vy: ((this.mapY(r[1] * kk + 0.01) - this.mapY(r[1] * kk - 0.01)) / 0.02) * kk * v[1],
      u: uv[0],
      v: uv[1],
      px: uv[0] * s.led.w,
      py: uv[1] * s.led.h,
      feet: this.mapY(ground[1] * kk),
      top: head ? this.mapY((head[1] + 0.12) * kk) : y + 0.8 * kk,
      room: r,
      inZone: front + r[2] >= P.zone.near && front + r[2] <= P.zone.far,
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
    const P = this.projection;
    const F = P.field;
    const [outL, outR] = this.target;
    const zone = this.zone;
    d.set(this.room.matrix, U.room);
    d.set(this.room.inverse, U.roomInv);
    d.set([s.led.w, s.led.h, s.size.w, s.size.h], U.led);
    d.set([s.bottom, s.sensor.x, s.sensor.front, this.xSign], U.bottom);
    d.set([this.mirrorSign, P.apply === 'person' ? 1 : 0, this.tanH, this.active ? 1 : 0], U.mirror);
    d.set([zone.near, zone.far, this.side, this.planX0], U.zone);
    d.set([F.near, F.far, F.nearL, F.nearR], U.field);
    d.set([F.farL, F.farR, F.low, F.high], U.field2);
    d.set([outL, outR, P.out.bottom, P.out.top], U.out);
    d.set(this.inv, U.inv);
    d.set([P.image.distance, P.image.mode === 'stretch' ? 1 : 0, P.margin, 0], U.image);
    for (let c = 0; c < 5; c++) d.set(this._luts[c], U.curves + c * 36);
    for (let i = 0; i < SLOTS; i++) d.set([this.offset[i], this.scale[i], this.visible[i], this.rate[i]], U.slots + i * 4);
    this._device.queue.writeBuffer(this._buffer, 0, d);
  }

  destroy() {
    this._buffer?.destroy();
    this._buffer = null;
  }
}
