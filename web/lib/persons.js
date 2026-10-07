// persons.js — person tracking for scenes. A scene asks for it with `streams: ['persons']` (depth
// and infrared come with it). The runtime then runs one PersonStream per page, in two Web Workers:
// a pose model (YOLO-pose, persons-pose.js in persons-pose-worker.js) finds the skeletons in the
// infrared image, a few times a second; every depth frame is cut out on its own (persons-worker.js,
// persons-core.js: the persons
// of the previous frame grow into the new one, the learned background stays out), so the masks
// follow fast movements at the full 30 fps. The newest result is ctx.kinect.persons (null until the
// first one):
//
//   list      [{ id, slot, visible, age, score, pixels, area, centroid, head, ground, height, velocity,
//                bbox, joints, keypoints }]
//             id: unique per person, slot: 1..16 (label value, stable while the person is tracked),
//             centroid/head/ground: [x, y, z] mm in the Kinect camera frame (x right, y down, z forward),
//             height: m above the floor (top of the head; without a floor: visible height),
//             velocity: mm/s, bbox: [u0, v0, u1, v1] pixels, visible: false while briefly hidden,
//             joints: 17 × [x, y, z, confidence] (mm, camera frame; JOINTS names them, SKELETON
//             connects them), keypoints: 17 × [u, v, confidence] in depth image pixels
//   labels    Uint8Array 512×424: per pixel the slot of its person, 0 = no person
//   depth     Uint16Array 512×424: depth in mm of the person pixels only, 0 elsewhere
//   indices   Uint32Array: the person pixels (raster order); labels[i] is their slot
//   floor     { normal, d, height, pitchDeg, rollDeg } (camera frame, m) or null if not visible
//   seq, captureTimeUs   the depth frame it belongs to (labels and depth always match each other)
//   lag       ms it is shown after its depth frame arrived (0 when live)
//
// Delayed output (default, configure({ delay: 12 })): every frame is cut out as soon as it arrives,
// then its result waits for the pose of a later frame (at most `delay` frames, typically 4..8,
// about 130..270 ms) and its skeleton is interpolated between the poses before and after it: as
// exact as a pose of every frame. The results are played out at the pace of the frames, a constant
// time after each frame arrived: as short as the recent frames allow (it skips frames to catch up
// when the waits get shorter, e.g. after the model's slow first run). Meanwhile ctx.kinect.depth,
// .ir (and their GPU copies) show the same frame as the persons, so everything a scene draws fits
// together: a smooth, slightly delayed mirror. delay: 0 = live (the skeleton follows the optical
// flow from the last pose; the same masks, a less exact skeleton on fast limbs).
//
// The arrays are valid until the next but one result: copy what you want to keep longer.
// GPU copies: ctx.kinect.gpu.personLabelTexture/-Buffer, personDepthTexture/-Buffer, personIndexBuffer.

import { MAX_PERSONS, JOINTS, EXTRA, SKELETON, DEFAULTS as CORE_DEFAULTS } from './persons-core.js';

export { MAX_PERSONS, JOINTS, EXTRA, SKELETON };

const N = 512 * 424;
/** Frames the output may wait for a later pose (0 = live). */
export const DEFAULT_DELAY = 12;
/** What a scene can set with `persons: {...}` (its defaults; see PERSONS.md). */
export const PERSON_OPTIONS = Object.freeze({ ...CORE_DEFAULTS, delay: DEFAULT_DELAY });

/**
 * Every point of a person, in this order in Person.joints, in the GPU buffer and in WGSL (J_*):
 * the 17 COCO joints, then neck, pelvis, head, leftHand, rightHand (derived), center, ground.
 */
export const POINTS = Object.freeze([...JOINTS, ...EXTRA, 'center', 'ground']);
/** POINTS by name: POINT.leftHand === 20. */
export const POINT = Object.freeze(Object.fromEntries(POINTS.map((n, i) => [n, i])));
/** A stick figure: pairs of POINTS indices (head-neck-pelvis, shoulders, arms to the hands, legs). */
export const BONES = Object.freeze(
  [
    ['head', 'neck'], ['neck', 'leftShoulder'], ['neck', 'rightShoulder'], ['leftShoulder', 'leftElbow'],
    ['leftElbow', 'leftWrist'], ['leftWrist', 'leftHand'], ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'],
    ['rightWrist', 'rightHand'], ['neck', 'pelvis'], ['pelvis', 'leftHip'], ['pelvis', 'rightHip'], ['leftHip', 'leftKnee'],
    ['leftKnee', 'leftAnkle'], ['rightHip', 'rightKnee'], ['rightKnee', 'rightAnkle'],
  ].map(([a, b]) => [POINTS.indexOf(a), POINTS.indexOf(b)]),
);

/** One color per slot (1..16), neon on dark; index 0 is unused. Scenes may use their own. */
export const PERSON_COLORS = [
  '#ffffff', '#29e6ff', '#ff3fd0', '#ffc23a', '#7dff5c', '#9a6bff', '#ff7a3d', '#4d8dff', '#3dffc0',
  '#ff5c7a', '#d4ff3a', '#c58bff', '#00c2b8', '#ff9a6b', '#a8e6ff', '#ff8be8', '#ffe08a',
];

/** Color of a slot as [r, g, b] in 0..1. */
export function personColor(slot, out = [0, 0, 0]) {
  const hex = PERSON_COLORS[slot >= 1 && slot <= MAX_PERSONS ? slot : 0];
  const v = Number.parseInt(hex.slice(1), 16);
  out[0] = ((v >> 16) & 255) / 255;
  out[1] = ((v >> 8) & 255) / 255;
  out[2] = (v & 255) / 255;
  return out;
}

/** Kinect camera point in mm -> world in meters as used by ctx.camera (x·xSign, y up, z forward). */
export function toWorld(p, xSign = -1) {
  return [(xSign * p[0]) / 1000, -p[1] / 1000, p[2] / 1000];
}

/**
 * Room frame for 3D scenes: from the world (meters, as ctx.camera: sensor at the origin, x·xSign,
 * y up, z forward) to the room: the floor is y = 0, y points up, z runs forward along the floor,
 * the origin lies on the floor below the sensor. Without a floor the sensor counts as level and
 * `fallbackHeight` meters above the floor.
 *   room = matrix * (world, 1); matrix is a column-major Float32Array(16) (WGSL mat4x4f)
 */
export function roomFrame(floor, xSign = -1, fallbackHeight = 1) {
  let up = [0, 1, 0];
  let height = fallbackHeight;
  if (floor?.normal) {
    up = [xSign * floor.normal[0], -floor.normal[1], floor.normal[2]];
    height = floor.d;
  }
  // forward: the sensor's view direction along the floor
  const k = up[2];
  let fwd = [-k * up[0], -k * up[1], 1 - k * up[2]];
  const lf = Math.hypot(...fwd) || 1;
  fwd = fwd.map((x) => x / lf);
  const right = [up[1] * fwd[2] - up[2] * fwd[1], up[2] * fwd[0] - up[0] * fwd[2], up[0] * fwd[1] - up[1] * fwd[0]];
  const m = new Float32Array(16);
  for (let j = 0; j < 3; j++) {
    m[j * 4] = right[j];
    m[j * 4 + 1] = up[j];
    m[j * 4 + 2] = fwd[j];
  }
  m[13] = height;
  m[15] = 1;
  const apply = (w) => [
    right[0] * w[0] + right[1] * w[1] + right[2] * w[2],
    up[0] * w[0] + up[1] * w[1] + up[2] * w[2] + height,
    fwd[0] * w[0] + fwd[1] * w[1] + fwd[2] * w[2],
  ];
  return { matrix: m, height, up, forward: fwd, right, found: !!floor?.normal, apply };
}

// ---------- the persons as scenes like them (ctx.persons) ----------

const EMPTY_IMAGE = Object.freeze([0, 0, 0, 0]);

/**
 * The persons of a tracking result (ctx.kinect.persons) as scenes like them: Person objects with
 * named points in three spaces (see PERSONS.md). The runtime keeps one up to date as ctx.persons:
 *
 *   an Array of the visible persons (by slot), with
 *   .all       every tracked person, also those hidden for a moment (visible: false)
 *   .entered   persons seen for the first time in this update; .left: ids gone in this update
 *   .fresh     true in the animation frame of an update (entered/left are empty otherwise)
 *   .byId(id), .bySlot(slot), .room (roomFrame of the floor), .floor, .seq, .delayMs
 *
 * Person: id, slot, color [r,g,b] 0..1, css '#rrggbb', visible, age (s), score, height (m),
 *   pixels, area (m², 0 in skeleton mode)
 *   center, head, ground, velocity (m/s)       world: meters, x right, y up, z away from the sensor
 *                                               (the space of ctx.camera and pointAt(); key m mirrors)
 *   joints.<name> [x, y, z] or null (not seen); confidence.<name> 0..1; motion.<name> [vx, vy, vz]
 *                                               m/s or null; names: POINTS. Smoothed (One-Euro:
 *                                               steady when slow, no lag when fast; SMOOTHING)
 *   room.{center, head, ground, joints}         meters on the floor: y = 0 on the floor, y up,
 *                                               origin below the sensor, z forward along the floor
 *   image.{bbox, joints}                        depth image pixels (512×424, mirrored as the hub
 *                                               sends it): [u, v]; ctx.kinectToScreen() maps them
 *   camera                                      the raw entry of ctx.kinect.persons.list (mm)
 */
export function personView(result, { xSign = -1, previous = null, smooth = SMOOTHING } = {}) {
  const room = roomFrame(result?.floor, xSign);
  const before = new Map((previous?.all ?? []).map((p) => [p.id, p]));
  const dt = previous && result ? (result.captureTimeUs - previous.captureTimeUs) / 1e6 : 0;
  const all = (result?.list ?? []).map((c) => makePerson(c, xSign, room, before.get(c.id), dt, smooth));
  const visible = all.filter((p) => p.visible).sort((a, b) => a.slot - b.slot);
  const ids = new Set(all.map((p) => p.id));
  return Object.assign(visible, {
    all,
    entered: visible.filter((p) => !before.has(p.id) && !previous?.seenIds?.has(p.id)),
    left: [...before.keys()].filter((id) => !ids.has(id)),
    seenIds: new Set([...(previous?.seenIds ?? []), ...visible.map((p) => p.id)].slice(-256)),
    fresh: true,
    room,
    floor: result?.floor ?? null,
    seq: result?.seq ?? null,
    captureTimeUs: result?.captureTimeUs ?? 0,
    delayMs: result?.lag ?? 0,
    byId: (id) => all.find((p) => p.id === id) ?? null,
    bySlot: (slot) => all.find((p) => p.slot === slot) ?? null,
  });
}

/** One-Euro filter settings for the points (smooth when slow, quick when fast); null = raw. */
export const SMOOTHING = Object.freeze({ minCutoff: 1.2, beta: 0.6, dCutoff: 1.0 });

const alphaOf = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

/** One-Euro filter of a 3D point; the state lives in `f` (carried from person to person). */
function oneEuro(f, x, dt, cfg) {
  if (!f.x || !(dt > 0) || dt > 0.5) {
    f.x = x.slice();
    f.dx = [0, 0, 0];
    return f.x.slice();
  }
  const a = alphaOf(cfg.dCutoff, dt);
  for (let j = 0; j < 3; j++) f.dx[j] += a * ((x[j] - f.x[j]) / dt - f.dx[j]);
  const speed = Math.hypot(f.dx[0], f.dx[1], f.dx[2]);
  const b = alphaOf(cfg.minCutoff + cfg.beta * speed, dt);
  for (let j = 0; j < 3; j++) f.x[j] += b * (x[j] - f.x[j]);
  return f.x.slice();
}

function makePerson(c, xSign, room, prev, dt, smooth) {
  const w = (p) => (p ? [(xSign * p[0]) / 1000, -p[1] / 1000, p[2] / 1000] : null);
  const joints = {};
  const confidence = {};
  const image = {};
  // the filters travel from one Person of this id to the next
  const filters = prev?.filters && prev.xSign === xSign ? prev.filters : {};
  const steady = (name, p) => {
    if (!p) {
      delete filters[name];
      return null;
    }
    return smooth ? oneEuro((filters[name] ??= {}), p, dt, smooth) : p;
  };
  const camPoints = [...c.joints, ...(c.extra ?? [])];
  const imgPoints = [...c.keypoints, ...(c.extraKeypoints ?? [])];
  for (let k = 0; k < camPoints.length && k < POINTS.length; k++) {
    const name = POINTS[k];
    const conf = camPoints[k][3];
    joints[name] = steady(name, conf > 0 ? w(camPoints[k]) : null);
    confidence[name] = conf;
    image[name] = conf > 0 && imgPoints[k] ? [imgPoints[k][0], imgPoints[k][1]] : null;
  }
  const center = steady('center', w(c.centroid));
  const ground = steady('ground', w(c.ground));
  const head = joints.head ?? w(c.head);
  joints.center = center;
  joints.ground = ground;
  confidence.center = c.visible ? 1 : 0;
  confidence.ground = c.visible ? 1 : 0;
  image.center = c.bbox ? [(c.bbox[0] + c.bbox[2]) / 2, (c.bbox[1] + c.bbox[3]) / 2] : null;
  image.ground = null;
  const motion = {};
  for (const name of POINTS) {
    const a = prev?.joints[name];
    const b = joints[name];
    motion[name] = a && b && dt > 0 && dt < 0.5 ? [(b[0] - a[0]) / dt, (b[1] - a[1]) / dt, (b[2] - a[2]) / dt] : null;
  }
  const roomJoints = {};
  for (const name of POINTS) roomJoints[name] = joints[name] ? room.apply(joints[name]) : null;
  const color = personColor(c.slot);
  return {
    id: c.id,
    slot: c.slot,
    color,
    css: PERSON_COLORS[c.slot] ?? PERSON_COLORS[0],
    visible: c.visible,
    age: c.age,
    score: c.score,
    height: c.height,
    pixels: c.pixels,
    area: c.area,
    center,
    head,
    ground,
    velocity: c.velocity ? [(xSign * c.velocity[0]) / 1000, -c.velocity[1] / 1000, c.velocity[2] / 1000] : [0, 0, 0],
    joints,
    confidence,
    motion,
    room: { center: roomJoints.center, head: head ? room.apply(head) : null, ground: roomJoints.ground, joints: roomJoints },
    image: { bbox: c.bbox ?? EMPTY_IMAGE, center: image.center, joints: image },
    camera: c,
    filters,
    xSign,
  };
}

export class PersonStream {
  /** @param {(result) => void} onResult  called with every new result */
  constructor(onResult) {
    this.onResult = onResult;
    this.worker = null;
    this.enabled = false;
    this.latest = null;
    this.previous = null;
    this.inFlight = 0; // frames at the worker
    this.depthFrame = null; // newest frames; a pair with the same seq goes to the worker
    this.irFrame = null;
    this.sentSeq = -1;
    this.newestSeq = -1;
    this.inputs = [];
    this.irInputs = [];
    this.options = { ...PERSON_OPTIONS };
    this.waiting = []; // results to be played out (delayed output), oldest first
    this.lags = []; // recent ms from a frame's arrival to its result
    this.playDelay = 0; // ms after its arrival a frame is shown
    this.rays = null;
    this.error = null;
    this.provider = null;
    this.results = 0;
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    if (this.worker) return;
    try {
      this.worker = new Worker(new URL('./persons-worker.js', import.meta.url), { type: 'module', name: 'persons' });
      this.poseWorker = new Worker(new URL('./persons-pose-worker.js', import.meta.url), { type: 'module', name: 'persons-pose' });
    } catch (e) {
      this.error = e;
      return;
    }
    for (const w of [this.worker, this.poseWorker]) {
      w.onmessage = (e) => this._onMessage(e.data);
      w.onerror = (e) => {
        this.error = e.message || 'Fehler im Personen-Worker';
        console.error('persons worker', e);
      };
    }
    // the pose worker hands its poses straight to the tracker
    const ch = new MessageChannel();
    this.worker.postMessage({ type: 'port', port: ch.port1 }, [ch.port1]);
    this.poseWorker.postMessage({ type: 'port', port: ch.port2 }, [ch.port2]);
    this.worker.postMessage({ type: 'config', options: this.options });
    if (this.rays) this._sendRays();
  }

  /** Stops feeding frames (the worker and its model stay loaded for the next scene). */
  stop() {
    this.enabled = false;
  }

  dispose() {
    this.stop();
    this.worker?.terminate();
    this.poseWorker?.terminate();
    this.worker = null;
    this.poseWorker = null;
  }

  /**
   * delay (frames, see above) and the thresholds of persons-core.js (DEFAULTS there), e.g.
   * { delay: 0, maxDepth: 3500, maxPersons: 6 }.
   */
  configure(options) {
    Object.assign(this.options, options);
    this.worker?.postMessage({ type: 'config', options });
  }

  /** The output waits for later poses: ctx.kinect shows the frames that belong to the persons. */
  get delayed() {
    return this.enabled && this.options.delay > 0;
  }

  /** The hub's undistortion table. */
  setRays(rays) {
    this.rays = rays;
    if (this.worker) this._sendRays();
  }

  _sendRays() {
    this.worker.postMessage({ type: 'rays', rays: this.rays.slice().buffer });
  }

  /** A new depth frame (KinectStream frame). */
  push(frame) {
    this.depthFrame = frame;
    this._pump();
  }

  /** A new infrared frame (the pose model looks at it). */
  pushIr(frame) {
    this.irFrame = frame;
    this._pump();
  }

  _pump() {
    if (!this.enabled || !this.worker) return;
    const d = this.depthFrame;
    if (!d?.data || d.seq === this.sentSeq) return;
    this.newestSeq = d.seq;
    // delayed: every frame goes to the worker (it holds them back); live: one at a time
    if (this.inFlight >= (this.options.delay > 0 ? this.options.delay + 6 : 1)) return;
    const ir = this.irFrame;
    // depth and infrared of the same frame (the infrared follows right after the depth); a hub
    // without infrared gets depth alone after a while (then no poses are found, though)
    this.firstDepthAt ??= performance.now();
    if (ir?.seq !== d.seq && (ir || performance.now() - this.firstDepthAt < 1500)) return;
    const buf = this.inputs.pop() ?? new ArrayBuffer(N * 2);
    new Uint16Array(buf).set(d.data);
    const msg = { type: 'frame', seq: d.seq, captureTimeUs: d.captureTimeUs, arrived: d.receivedTimeMs, depth: buf };
    const transfer = [buf];
    if (ir?.seq === d.seq && ir.data) {
      const irBuf = this.irInputs.pop() ?? new ArrayBuffer(N);
      new Uint8Array(irBuf).set(ir.data);
      msg.ir = irBuf;
      transfer.push(irBuf);
    }
    this.inFlight++;
    this.sentSeq = d.seq;
    this.worker.postMessage(msg, transfer);
  }

  _onMessage(m) {
    if (m.type === 'status') {
      if (m.error) this.error = m.error;
      if (m.provider) {
        this.provider = m.provider;
        this.error = null;
      }
      return;
    }
    if (m.type !== 'result') return;
    if (m.input) this.inputs.push(m.input);
    if (m.inputIr) this.irInputs.push(m.inputIr);
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.results++;
    if (m.error) this.error = m.error;
    else if (this.provider) this.error = null; // the model runs (again)
    const r = {
      seq: m.seq,
      captureTimeUs: m.captureTimeUs,
      list: m.persons,
      labels: new Uint8Array(m.labels),
      depth: new Uint16Array(m.depth),
      indices: new Uint32Array(m.indices, 0, m.count),
      floor: m.floor,
      ms: m.ms,
      poseMs: m.poseMs,
      poseRuns: m.poseRuns,
      arrived: m.arrived ?? performance.now(),
      lag: 0,
    };
    if (this.options.delay > 0) {
      // played out by tick(): note how long this frame took
      this.lags.push(performance.now() - r.arrived);
      if (this.lags.length > 90) this.lags.shift();
      this.waiting.push(r);
    } else {
      for (const w of this.waiting.splice(0)) this._recycle(w);
      this._show(r);
    }
    this._pump();
  }

  /**
   * Once per animation frame (KinectData.beginFrame): shows the newest waiting result whose time
   * has come. The play-out delay is what nearly all frames of the last second needed: it grows
   * at once when frames come late, and when it may shrink by more than a frame it jumps down,
   * skipping the frames in between (catching up after the model's slow first run).
   */
  tick(now) {
    if (!this.waiting.length) return;
    const recent = this.lags.slice(-30).sort((a, b) => a - b);
    const want = recent[Math.floor(0.95 * (recent.length - 1))] + 12;
    if (want > this.playDelay || this.playDelay - want > 34) this.playDelay = want;
    else this.playDelay = Math.max(want, this.playDelay - 0.2);
    let pick = null;
    while (this.waiting.length && this.waiting[0].arrived + this.playDelay <= now) {
      if (pick) this._recycle(pick); // passed over: never shown
      pick = this.waiting.shift();
    }
    if (pick) {
      pick.lag = now - pick.arrived;
      this._show(pick);
    }
  }

  /** ms from a frame's arrival to its result, recent frames: { p50, p95, max } (null when live). */
  waitStats() {
    if (!this.lags.length) return null;
    const a = this.lags.slice(-30).sort((x, y) => x - y);
    const at = (q) => Math.round(a[Math.floor(q * (a.length - 1))]);
    return { p50: at(0.5), p95: at(0.95), max: at(1) };
  }

  _show(r) {
    // the result before the previous one goes back to the worker for reuse
    if (this.previous) this._recycle(this.previous);
    this.previous = this.latest;
    this.latest = r;
    this.onResult?.(r);
  }

  _recycle(r) {
    if (!this.worker || !r.labels.buffer.byteLength) return;
    const bufs = [r.labels.buffer, r.depth.buffer, r.indices.buffer];
    this.worker.postMessage({ type: 'recycle', labels: bufs[0], depth: bufs[1], indices: bufs[2] }, bufs);
  }

  /** Short German status line for the HUD. */
  get statusText() {
    if (this.error) return `Personen: ${this.error}`;
    const r = this.latest;
    if (!r || !this.provider) return 'Personen: lade das Pose-Modell …';
    const n = r.list.length;
    const lag = this.options.delay > 0 ? ` · ${Math.round(this.playDelay)} ms verzögert` : '';
    const mode = this.options.mode === 'skeleton' ? ' · nur Skelett' : '';
    return `${n} ${n === 1 ? 'Person' : 'Personen'} · Pose ${r.poseMs.toFixed(0)} ms (${this.provider})${mode}${lag}`;
  }
}
