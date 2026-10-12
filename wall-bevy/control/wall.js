// wall.js — the LED wall as the control center draws and edits it: the setup (LEDs, size, the Kinect,
// block zones), the projections (how people are mapped onto the wall: the default and per scene)
// and the mapping itself (for the top and front views). The output (wall-bevy: wall/src/map.rs)
// does the same math for the wall.
//
// Spaces:
//   wall   meters: x from the wall's left edge (as the audience sees it), y above the floor,
//          z in front of the wall (towards the audience)
//   plan   meters on the floor: x from the wall's left edge (where people really stand), z in front of
//          the wall. The play field and the block zones live here.
//   norm   0..1 in the projection: x across the wall's target range, y its height range, z the play
//          field from front (0) to back (1)
//   room   meters: the floor is y = 0, origin on the floor below the sensor, z forward
//
// A projection:
//   field    the play field on the floor: a trapezoid with a front and a back edge parallel to the
//            wall (field.near/far, m in front of the wall) and their left and right ends (plan x).
//   curve    a response curve per axis (x across, y height, z depth): monotone, 0 -> 0 and 1 -> 1,
//            baked into a 33-sample table (the output uses the same table).
//   out      where u = 0..1 lands on the wall (m from the left and right edge), and the height range
//            field.low..high (m above the floor) -> out.bottom..top (m on the wall).
//   apply    'person': only each person's place goes through the mapping, the body keeps its shape
//            around it; 'points': every point goes through it.
//   edge     what happens to a person's place beyond the wall's edges: 'clamp', 'soft', 'free'.
//   zone     who counts: near..far, m in front of the wall.
//   image    camera image scenes: the image as it falls on the wall for things at image.distance.

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
 * declaration (wall::scene!: projection), then what was set for it in the control center. The scene's
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

const CURVE_X = 0;
const CURVE_Y = 1;
const CURVE_Z = 2;
const CURVE_IY = 4;

/** The mapping of one projection (the part of the output's WallMap that the views need). */
export class WallMap {
  constructor(setup = WALL_DEFAULTS, projection = null) {
    this.setup = normalizeSetup(setup);
    this._luts = Array.from({ length: 5 }, () => new Float32Array(LUT_N));
    this._invZ = new Float32Array(LUT_N);
    this.tanH = TAN_H;
    this.setProjection(projection ?? projectionFromSetup(this.setup));
  }

  get led() {
    return this.setup.led;
  }

  get size() {
    return this.setup.size;
  }

  setSetup(setup) {
    this.setup = normalizeSetup(setup);
  }

  /** The projection (a profile as resolveProjection() gives it). */
  setProjection(p) {
    this.projection = normalizeProfile(p);
    const c = this.projection.curve;
    curveLut(c.x, this._luts[CURVE_X]);
    curveLut(c.y, this._luts[CURVE_Y]);
    curveLut(c.z, this._luts[CURVE_Z]);
    invertLut(this._luts[CURVE_Y], this._luts[CURVE_IY]);
    invertLut(this._luts[CURVE_Z], this._invZ);
  }

  /** plan x of the sensor (m from the wall's left edge) */
  get planX0() {
    return this.setup.size.w / 2 + this.setup.sensor.x;
  }

  /** The wall x range the play field maps onto: [left, right] (m from the wall's left edge). */
  get target() {
    const o = this.projection.out;
    return [o.left, this.setup.size.w - o.right];
  }

  /** Across the play field at a floor point (plan m): 0 at its left edge, 1 at its right edge (mirror: flipped). */
  fieldU(px, pz) {
    const F = this.projection.field;
    const v = clamp((pz - F.near) / Math.max(F.far - F.near, 0.01), -1, 2);
    const l = F.nearL + (F.farL - F.nearL) * v;
    const r = F.nearR + (F.farR - F.nearR) * v;
    const u = (px - l) / Math.max(r - l, 0.05);
    return this.projection.mirror ? u : 1 - u;
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

  /** Depth in the play field: 0 at its front edge .. 1 at its back edge (after the curve). */
  fieldZ(pz) {
    const F = this.projection.field;
    return evalLut(this._luts[CURVE_Z], (pz - F.near) / Math.max(F.far - F.near, 0.01));
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
}
