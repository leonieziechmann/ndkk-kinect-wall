// persons-core.js — the people in the Kinect depth image: found by their skeletons, cut out of every
// depth frame. Plain JavaScript without DOM (runs in persons-worker.js, in Node for tests, and could
// move into the hub as is). The 2D poses come from a pose model on the infrared image
// (persons-pose.js, YOLO-pose): a few frames late, and only every few frames.
//
// The mask must not depend on how fresh the skeleton is (a waving arm moves 30 cm between two
// poses), so every depth frame is segmented on its own:
//   1. background: what stays in place is learned, only where no person is. A pixel that matches
//      it is never a person (chair, desk, wall, floor).
//   2. segmentation: region growing in the depth image, all persons at once, from the person
//      pixels of the previous frame (where the depth did not change) and from the bones of the
//      skeletons. A pixel joins if it is not background, connects without a depth jump and lies
//      within reach of the person's skeleton. Where the background is still unknown (someone stood
//      there from the start) a new pixel must lie inside one of the person's body parts. Touching
//      persons are split where their regions meet.
//   3. output: labels, the depth of the person pixels only, the list of person pixels, and per
//      person position, head, ground point, height, velocity, joints (3D) and keypoints (2D)
//   4. every 2 s: the floor (RANSAC on everything that is no person), else from the ankles
// Skeletons: every pose becomes a keyframe of its person. A frame between two keyframes gets its
// keypoints interpolated (delayed output: the frame waits for the later pose, see persons-worker.js);
// after the newest keyframe they follow the optical flow on the infrared image (persons-flow.js).
// Each frame lifts them to 3D with its own depth. Poses are matched to the persons through the
// labels of the frame they were computed on (markPoseFrame), or, for a frame not processed yet,
// through where the persons' keypoints will be then.
//
// Coordinates: Kinect camera frame, x right, y down, z forward. Depth and points in mm, the floor
// plane in meters: n·p + d = height above the floor (n points up, d = height of the sensor).

import { FlowTracker } from './persons-flow.js';

export const W = 512;
export const H = 424;
export const N = W * H;
/** Persons are labeled 1..MAX_PERSONS (slots); 0 = no person. */
export const MAX_PERSONS = 16;

/** The 17 joints (COCO order) of `joints` and `keypoints`; left/right are the person's own sides. */
export const JOINTS = [
  'nose', 'leftEye', 'rightEye', 'leftEar', 'rightEar', 'leftShoulder', 'rightShoulder', 'leftElbow',
  'rightElbow', 'leftWrist', 'rightWrist', 'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle',
];
/** Joint pairs to draw a skeleton. */
export const SKELETON = [
  [5, 6], [5, 7], [7, 9], [6, 8], [8, 10], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [0, 1], [0, 2], [1, 3], [2, 4], [3, 5], [4, 6],
];

// virtual joints after the 17: shoulder center, hip center, head, left hand, right hand
const SC = 17;
const HC = 18;
const HEAD = 19;
const LH = 20;
const RH = 21;
const NJ = 22;
// how far a joint center lies behind the visible surface where the keypoint is seen (m)
const INSET = [0.07, 0.07, 0.07, 0.07, 0.07, 0.05, 0.05, 0.035, 0.035, 0.03, 0.03, 0.07, 0.07, 0.05, 0.05, 0.04, 0.04];
// body parts: joint a, joint b, radius (m) of the capsule around them
const PARTS = [
  [HEAD, HEAD, 0.15], [HEAD, SC, 0.1], [5, 6, 0.1], [SC, HC, 0.17], [5, 11, 0.13], [6, 12, 0.13], [11, 12, 0.13],
  [5, 7, 0.09], [7, 9, 0.08], [9, LH, 0.09], [6, 8, 0.09], [8, 10, 0.08], [10, RH, 0.09],
  [11, 13, 0.11], [13, 15, 0.1], [15, 15, 0.12], [12, 14, 0.11], [14, 16, 0.1], [16, 16, 0.12],
];
const NP = PARTS.length;
// per capsule: ax, ay, az, bx, by, bz (mm), radius², reach radius², valid
const CAP = 9;
// bones whose middle is sampled to see whose pixels a pose lies on
const BODY_BONES = SKELETON.slice(0, 12);
const MAX_TRACKS = 32;
const MAX_LOST = 8; // a keypoint the flow could not follow for more frames is not used until the next pose
const BEHIND = 70; // mm: how far behind its bone a pixel of a body may lie (the far rim of a limb)

export const DEFAULTS = Object.freeze({
  minDepth: 400, // mm
  maxDepth: 4500, // mm: farther pixels never belong to a person
  minScore: 0.45, // pose confidence for a new person
  minKeypoint: 0.35, // keypoints below this confidence are not used
  margin: 0.045, // m added to every body part (clothes, hair, keypoint error)
  reach: 0.6, // m: how far a person's pixel may lie from its body parts where the background is known
  joinMargin: 50, // mm: neighbor pixels connect if their depths differ by less than
  joinSlope: 0.035, //      joinMargin + joinSlope * depth
  bgMargin: 40, // mm: a pixel is background if its depth is within bgMargin + bgSlope * depth
  bgSlope: 0.02, //      of the learned background
  learnFrames: 15, // where the background is unknown, a depth that stays this many frames is learned
  farFrames: 6, // ... a depth farther than the background (what was there has left)
  nearFrames: 150, // ... a depth nearer than the background (something new that is no person)
  floorClearance: 0.025, // m: pixels this close to the floor are floor, not feet
  confirmPoses: 2, // a new person shows after this many pose detections
  keepSeconds: 4, // a visible person the pose model does not find any more is kept this long
  lostSeconds: 1.5, // a hidden person (no pixels) without a matching pose for this long is gone
  floor: true, // estimate the floor plane
  maxPersons: MAX_PERSONS,
  fps: 30,
});

/** Rays of an ideal pinhole Kinect, until the real undistortion table is known. */
export function pinholeRays() {
  const r = new Float32Array(N * 2);
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      r[(v * W + u) * 2] = (u - 256) / 365.5;
      r[(v * W + u) * 2 + 1] = (v - 206) / 365.5;
    }
  }
  return r;
}

const now = () => (globalThis.performance ? performance.now() : Date.now());

function iou(a, b) {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]);
  const y1 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
  return inter / Math.max(1e-6, area(a) + area(b) - inter);
}

/** Similarity of two keypoint sets (0..1), like COCO's OKS with a fixed tolerance. */
function keypointSimilarity(a, b, scale, minConf) {
  let s = 0;
  let n = 0;
  const k2 = 2 * (0.12 * scale) ** 2;
  for (let k = 0; k < 17; k++) {
    if (a[3 * k + 2] < minConf || b[3 * k + 2] < minConf) continue;
    const du = a[3 * k] - b[3 * k];
    const dv = a[3 * k + 1] - b[3 * k + 1];
    s += Math.exp(-(du * du + dv * dv) / k2);
    n++;
  }
  return n ? s / n : 0;
}

// squared distance of a point (mm) to the bone of capsule p; segDz = how far it lies behind the bone
let segDz = 0;
function seg(C, p, x, y, z) {
  const o = CAP * p;
  const ax = C[o];
  const ay = C[o + 1];
  const az = C[o + 2];
  const bx = C[o + 3] - ax;
  const by = C[o + 4] - ay;
  const bz = C[o + 5] - az;
  const px = x - ax;
  const py = y - ay;
  const pz = z - az;
  const len2 = bx * bx + by * by + bz * bz;
  let s = len2 > 0 ? (px * bx + py * by + pz * bz) / len2 : 0;
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  const dx = px - s * bx;
  const dy = py - s * by;
  const dz = pz - s * bz;
  segDz = dz;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * The body part a point (mm) belongs to, -1 if none; `hint` is tried first. strict: inside the
 * part, and not clearly behind its bone (that is the backrest of the chair, the wall the person
 * leans on). Otherwise: within reach of the part (the skeleton may be a few frames old).
 */
function fit(C, hint, x, y, z, strict) {
  for (let k = -1; k < NP; k++) {
    const p = k < 0 ? hint : k;
    if (k === hint) continue;
    const o = CAP * p;
    if (!C[o + 8]) continue;
    const d2 = seg(C, p, x, y, z);
    if (strict ? d2 <= C[o + 6] && segDz <= BEHIND : d2 <= C[o + 7]) return p;
  }
  return -1;
}

export class PersonTracker {
  constructor(options = {}) {
    this.options = { ...DEFAULTS };
    this.configure(options);
    this.rays = null;
    this.pixArea = new Float32Array(N); // solid angle of a pixel: area in mm² = depth² * pixArea
    this.setRays(pinholeRays());
    this.owner = new Int8Array(N); // index of the person per pixel this frame, -1 = nobody
    this.partOf = new Uint8Array(N); // body part that admitted the pixel
    this.queue = new Int32Array(N);
    this.prevUid = new Int16Array(N); // the person (uid) per pixel in the previous frame, 0 = nobody
    this.prevDepth = new Uint16Array(N);
    this.bg = new Uint16Array(N); // learned background depth (mm), 0 = not known yet
    this.bgCand = new Uint16Array(N); // a depth that may become the background
    this.bgCount = new Uint8Array(N); // frames it has been seen
    this.nearPerson = new Uint8Array(N); // 1 = close to a person: unknown background is learned slowly
    this.uidIndex = new Int8Array(32768).fill(-1);
    this.window = new Float32Array(81);
    this.jScratch = new Float32Array(NJ * 4);
    this.uvScratch = new Float32Array(NJ * 3);
    this.capScratch = new Float64Array(NP * CAP);
    this.kpScratch = new Float32Array(51);
    this.ptsScratch = new Float32Array(34);
    this.useScratch = new Uint8Array(17);
    this.lostScratch = new Uint8Array(17);
    this.flow = new FlowTracker(W, H, { history: 24 });
    this.lastSeq = null;
    this.tracks = [];
    this.uids = 0;
    this.nextId = 1;
    this.frame = 0;
    this.poseResults = 0;
    this.snap = null; // labels and depth of the frame the pose model is looking at
    this.snapSeq = null;
    this.lastDepth = null;
    this.floor = null; // seen (RANSAC): heights, and the feet are cut off the floor
    this.feetFloor = null; // fallback: level, at the ankles
    this.feet = [];
    this._floorAt = -1e9;
    this._floorJob = null;
    this.rng = 0x2545f491;
    this.lastStats = null;
  }

  configure(options = {}) {
    for (const [k, v] of Object.entries(options)) {
      if (k in DEFAULTS && typeof v === typeof DEFAULTS[k]) this.options[k] = v;
    }
    this.options.maxPersons = Math.max(1, Math.min(MAX_PERSONS, Math.round(this.options.maxPersons)));
  }

  /** The undistortion table of the hub (f32 x,y per pixel): point = (x*z, y*z, z). */
  setRays(rays) {
    if (!rays || rays.length < N * 2) return;
    this.rays = rays;
    const a = this.pixArea;
    for (let v = 0; v < H; v++) {
      for (let u = 0; u < W; u++) {
        const i = v * W + u;
        const l = u > 0 ? i - 1 : i;
        const r = u < W - 1 ? i + 1 : i;
        const t = v > 0 ? i - W : i;
        const b = v < H - 1 ? i + W : i;
        const du = Math.hypot(rays[2 * r] - rays[2 * l], rays[2 * r + 1] - rays[2 * l + 1]) / (r - l);
        const dv = Math.hypot(rays[2 * b] - rays[2 * t], rays[2 * b + 1] - rays[2 * t + 1]) / ((b - t) / W);
        a[i] = du * dv;
      }
    }
  }

  /** Forgets all persons (the next poses start new ones). */
  reset() {
    this.tracks = [];
    this.prevUid.fill(0);
  }

  /** Forgets the learned background (after the sensor was moved, say). */
  resetBackground() {
    this.bg.fill(0);
    this.bgCount.fill(0);
  }

  // ---------- 1. poses -> tracks ----------

  /**
   * The infrared image of a frame as soon as it arrives, before process() (delayed output: poses of
   * frames that are not processed yet are matched along the flow up to them).
   */
  addInfrared(seq, ir) {
    if (!this.flow.has(seq)) this.flow.push(seq, ir);
  }

  /** The pose model starts on this frame: keep its labels and depth to match the poses against. */
  markPoseFrame(seq) {
    this.snapSeq = seq;
  }

  /**
   * Poses of the pose model: [{ score, box: [u0, v0, u1, v1], kp: Float32Array(17*3) (u, v, conf) }]
   * in depth image pixels, computed on frame `seq` (as passed to markPoseFrame and process). Each
   * becomes a keyframe of its person. The pose of a frame that is processed already is matched
   * through that frame's labels (markPoseFrame); one of a frame still to come (delayed output, see
   * addInfrared) through where the persons' keypoints will be then.
   */
  setPoses(poses, seq) {
    const o = this.options;
    if (seq !== undefined && this.lastSeq !== null && seq > this.lastSeq) {
      this.poseResults++;
      this._matchAhead(poses, seq);
      return;
    }
    const snap = this.snap && seq !== undefined && this.snap.seq === seq ? this.snap : null;
    const uidMap = snap ? snap.uid : this.prevUid;
    const depth = snap ? snap.depth : this.lastDepth;
    if (!depth) return;
    this.poseResults++;
    // whose pixels each pose lies on, in the frame it was computed on
    const hits = poses.map((p) => this._hits(p, uidMap));
    const pairs = [];
    for (let pi = 0; pi < poses.length; pi++) {
      const h = hits[pi];
      for (let ti = 0; ti < this.tracks.length; ti++) {
        const t = this.tracks[ti];
        let s = h.n ? (h.by.get(t.uid) ?? 0) / h.n : 0;
        if (s < 0.25 && t.pos && !(snap ? snap.tracks.has(t.uid) : t.pixels)) {
          // hidden then (behind someone, or not yet segmented): near where it was seen last
          const c = this._poseCenter(poses[pi], depth, uidMap, t.uid);
          if (c) {
            const dist = Math.hypot(c[0] - t.pos[0], c[1] - t.pos[1], c[2] - t.pos[2]);
            if (dist < 700) s = 0.25 + 0.25 * (1 - dist / 700);
          }
        }
        if (s >= 0.25) pairs.push({ pi, ti, s });
      }
    }
    pairs.sort((a, b) => b.s - a.s);
    const usedP = new Set();
    const usedT = new Set();
    for (const { pi, ti } of pairs) {
      if (usedP.has(pi) || usedT.has(ti)) continue;
      usedP.add(pi);
      usedT.add(ti);
      this._applyPose(this.tracks[ti], poses[pi], depth, uidMap, snap, seq);
    }
    for (let pi = 0; pi < poses.length; pi++) {
      const p = poses[pi];
      if (usedP.has(pi) || p.score < o.minScore || this.tracks.length >= MAX_TRACKS) continue;
      // mostly on someone's pixels: a second pose of a known person, not a new one
      if (hits[pi].n && hits[pi].any > 0.5 * hits[pi].n) continue;
      const t = this._newTrack(p);
      this._applyPose(t, p, depth, uidMap, snap, seq);
    }
  }

  _newTrack(p) {
    const t = {
        id: 0,
        uid: (this.uids = (this.uids % 32000) + 1),
        slot: 0,
        poses: 0,
        lastPose: this.frame,
        score: p.score,
        keys: [], // the poses: { seq, kp }, oldest first (kept while needed)
        kp: new Float32Array(51), // keypoints (u, v, conf) in frame kpSeq
        kpSeq: null,
        kpKey: null, // the keyframe kp was followed from
        lost: new Uint8Array(17), // frames in a row the flow could not follow a keypoint
        lifted: false, // has had a skeleton
        joints: new Float32Array(NJ * 4), // 3D skeleton (mm) of the current frame
        uv: new Float32Array(NJ * 3),
        capsules: new Float64Array(NP * CAP),
        pos: null,
        c2: null,
        dc2: null, // how its pixels moved in the image in the last frame
        vel: [0, 0, 0],
        pixels: 0,
      };
    this.tracks.push(t);
    return t;
  }

  /** Samples along a pose (keypoints, middles of the bones): how many lie on whose pixels. */
  _hits(p, uidMap) {
    const mk = this.options.minKeypoint;
    const kp = p.kp;
    const by = new Map();
    let n = 0;
    let any = 0;
    const sample = (u, v) => {
      n++;
      const ui = Math.round(u);
      const vi = Math.round(v);
      let id = 0;
      for (let k = 0; k < 5 && !id; k++) {
        const x = ui + (k === 1 ? -2 : k === 2 ? 2 : 0);
        const y = vi + (k === 3 ? -2 : k === 4 ? 2 : 0);
        if (x >= 0 && y >= 0 && x < W && y < H) id = uidMap[y * W + x];
      }
      if (!id) return;
      any++;
      by.set(id, (by.get(id) ?? 0) + 1);
    };
    for (let k = 0; k < 17; k++) if (kp[3 * k + 2] >= mk) sample(kp[3 * k], kp[3 * k + 1]);
    for (const [a, b] of BODY_BONES) {
      if (kp[3 * a + 2] >= mk && kp[3 * b + 2] >= mk) sample((kp[3 * a] + kp[3 * b]) / 2, (kp[3 * a + 1] + kp[3 * b + 1]) / 2);
    }
    return { n, any, by };
  }

  /** Median 3D position (mm) of a pose's keypoints that are no one else's pixels, null if none. */
  _poseCenter(p, depth, uidMap, uid) {
    const xs = [];
    const ys = [];
    const zs = [];
    const rays = this.rays;
    for (let k = 0; k < 17; k++) {
      if (p.kp[3 * k + 2] < this.options.minKeypoint) continue;
      const u = Math.round(p.kp[3 * k]);
      const v = Math.round(p.kp[3 * k + 1]);
      if (u < 0 || v < 0 || u > W - 1 || v > H - 1) continue;
      const i = v * W + u;
      if (uidMap[i] && uidMap[i] !== uid) continue;
      const d = this._depthNear(depth, u, v);
      if (!d) continue;
      xs.push(rays[2 * i] * d);
      ys.push(rays[2 * i + 1] * d);
      zs.push(d);
    }
    if (!zs.length) return null;
    const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
    return [med(xs), med(ys), med(zs)];
  }

  _applyPose(t, p, depth, uidMap, snap, seq) {
    t.score = p.score;
    t.poses++;
    t.lastPose = this.frame;
    // a pose that does not lift (all keypoints hidden), or a skeleton that does not cover the
    // person's pixels of that frame (keypoints on the background next to it): the person keeps its
    // keypoints
    const seen = snap ? snap.tracks.has(t.uid) : t.pixels > 0;
    if (!this._lift(p.kp, depth, uidMap, t.uid, seen, this.jScratch, this.uvScratch)) return;
    if (seen && t.lifted) {
      this._capsules(this.jScratch, this.capScratch);
      if (this._covers(this.capScratch, uidMap, depth, t.uid) < 0.7) return;
    }
    this._addKey(t, snap ? seq : (this.lastSeq ?? 0), p.kp);
  }

  _addKey(t, seq, kp) {
    t.keys.push({ seq, kp: Float32Array.from(kp) });
    t.keys.sort((a, b) => a.seq - b.seq);
    t.lifted = true;
  }

  /**
   * Poses of a frame that is not processed yet: matched to where the persons' keypoints will be
   * then (along the flow), and to the persons' pixels in the newest processed frame (a few frames
   * earlier: the body has hardly moved).
   */
  _matchAhead(poses, seq) {
    const o = this.options;
    const pred = this.tracks.map((t) => this._predict(t, seq));
    const hits = poses.map((p) => this._hits(p, this.prevUid));
    const pairs = [];
    for (let pi = 0; pi < poses.length; pi++) {
      const p = poses[pi];
      const h = hits[pi];
      const scale = Math.sqrt(Math.max(1, (p.box[2] - p.box[0]) * (p.box[3] - p.box[1])));
      for (let ti = 0; ti < this.tracks.length; ti++) {
        const q = pred[ti];
        const on = h.n ? (h.by.get(this.tracks[ti].uid) ?? 0) / h.n : 0;
        const s = (q ? keypointSimilarity(p.kp, q.kp, scale, o.minKeypoint) + 0.5 * iou(p.box, q.box) : 0) + on;
        if (s >= 0.3) pairs.push({ pi, ti, s });
      }
    }
    pairs.sort((a, b) => b.s - a.s);
    const usedP = new Set();
    const usedT = new Set();
    for (const { pi, ti } of pairs) {
      if (usedP.has(pi) || usedT.has(ti)) continue;
      usedP.add(pi);
      usedT.add(ti);
      const t = this.tracks[ti];
      t.score = poses[pi].score;
      t.poses++;
      t.lastPose = this.frame;
      this._addKey(t, seq, poses[pi].kp);
    }
    for (let pi = 0; pi < poses.length; pi++) {
      const p = poses[pi];
      if (usedP.has(pi) || p.score < o.minScore || this.tracks.length >= MAX_TRACKS) continue;
      // overlapping someone: a second pose of a known person, not a new one
      if (pred.some((q) => q && iou(p.box, q.box) > 0.3)) continue;
      if (hits[pi].n && hits[pi].any > 0.5 * hits[pi].n) continue;
      const t = this._newTrack(p);
      t.poses++;
      this._addKey(t, seq, p.kp);
    }
  }

  /** Where the keypoints of a person will be in frame seq (newest keyframe along the flow). */
  _predict(t, seq) {
    const last = t.keys.length ? t.keys[t.keys.length - 1] : null;
    let kp;
    let from;
    if (last && (t.kpSeq === null || last.seq >= t.kpSeq)) {
      kp = Float32Array.from(last.kp);
      from = last.seq;
    } else if (t.kpSeq !== null) {
      kp = Float32Array.from(t.kp);
      from = t.kpSeq;
    } else return null;
    const mk = this.options.minKeypoint;
    const pts = this.ptsScratch;
    const use = this.useScratch;
    const lost = this.lostScratch;
    lost.fill(0);
    for (let k = 0; k < 17; k++) {
      pts[2 * k] = kp[3 * k];
      pts[2 * k + 1] = kp[3 * k + 1];
      use[k] = kp[3 * k + 2] >= mk ? 1 : 0;
    }
    if (from < seq && this.flow.track(from, seq, pts, 17, use, lost)) {
      for (let k = 0; k < 17; k++) {
        kp[3 * k] = pts[2 * k];
        kp[3 * k + 1] = pts[2 * k + 1];
      }
    }
    let u0 = Infinity;
    let v0 = Infinity;
    let u1 = -Infinity;
    let v1 = -Infinity;
    for (let k = 0; k < 17; k++) {
      if (kp[3 * k + 2] < mk) continue;
      u0 = Math.min(u0, kp[3 * k]);
      v0 = Math.min(v0, kp[3 * k + 1]);
      u1 = Math.max(u1, kp[3 * k]);
      v1 = Math.max(v1, kp[3 * k + 1]);
    }
    if (!(u1 > u0)) return null;
    const pu = 0.15 * (u1 - u0) + 4;
    const pv = 0.1 * (v1 - v0) + 4;
    return { kp, box: [u0 - pu, v0 - pv, u1 + pu, v1 + pv] };
  }

  /**
   * The keypoints of a person in frame seq: between two keyframes interpolated (delayed output),
   * after the newest one followed by the optical flow.
   */
  _keypointsAt(t, seq) {
    const keys = t.keys;
    let i0 = -1;
    for (let i = 0; i < keys.length; i++) if (keys[i].seq <= seq) i0 = i;
    if (i0 < 0) return; // no pose up to this frame yet
    if (i0 > 0) keys.splice(0, i0);
    const k0 = keys[0];
    const k1 = keys.length > 1 ? keys[1] : null;
    const kp = t.kp;
    if (k1) {
      const mk = this.options.minKeypoint;
      const w = (seq - k0.seq) / (k1.seq - k0.seq);
      const a = k0.kp;
      const b = k1.kp;
      for (let j = 0; j < 51; j += 3) {
        if (a[j + 2] >= mk && b[j + 2] >= mk) {
          kp[j] = a[j] + w * (b[j] - a[j]);
          kp[j + 1] = a[j + 1] + w * (b[j + 1] - a[j + 1]);
          kp[j + 2] = Math.min(a[j + 2], b[j + 2]);
        } else {
          const c = w < 0.5 ? a : b;
          kp[j] = c[j];
          kp[j + 1] = c[j + 1];
          kp[j + 2] = c[j + 2];
        }
      }
      t.lost.fill(0);
      t.kpSeq = seq;
      t.kpKey = null;
      return;
    }
    if (t.kpKey !== k0) {
      kp.set(k0.kp);
      t.kpSeq = k0.seq;
      t.kpKey = k0;
      t.lost.fill(0);
    }
    this._advance(t, seq);
  }

  /** Moves the keypoints of a person to frame seq (optical flow on the infrared image). */
  _advance(t, seq) {
    if (t.kpSeq === null || t.kpSeq === seq) {
      t.kpSeq = seq;
      return;
    }
    const kp = t.kp;
    const pts = this.ptsScratch;
    const use = this.useScratch;
    const mk = this.options.minKeypoint;
    for (let k = 0; k < 17; k++) {
      pts[2 * k] = kp[3 * k];
      pts[2 * k + 1] = kp[3 * k + 1];
      use[k] = kp[3 * k + 2] >= mk ? 1 : 0;
    }
    if (this.flow.track(t.kpSeq, seq, pts, 17, use, t.lost)) {
      for (let k = 0; k < 17; k++) {
        kp[3 * k] = pts[2 * k];
        kp[3 * k + 1] = pts[2 * k + 1];
      }
    } else if (t.dc2) {
      // no infrared for these frames: the keypoints move with the person's pixels
      for (let k = 0; k < 17; k++) {
        kp[3 * k] += t.dc2[0];
        kp[3 * k + 1] += t.dc2[1];
      }
    }
    t.kpSeq = seq;
  }

  // ---------- 2. skeleton in 3D ----------

  /**
   * Depth at a keypoint: the near cluster of a small window (the person, not what is behind). With
   * `uidMap`, only the pixels of person `uid` count if the window has any.
   */
  _depthNear(depth, u, v, uidMap = null, uid = 0) {
    const { minDepth, maxDepth } = this.options;
    const r = 3;
    const w = this.window;
    let n = 0;
    let lo = Infinity;
    const u0 = Math.max(0, Math.round(u) - r);
    const u1 = Math.min(W - 1, Math.round(u) + r);
    const v0 = Math.max(0, Math.round(v) - r);
    const v1 = Math.min(H - 1, Math.round(v) + r);
    for (let pass = uidMap ? 0 : 1; pass < 2 && n < 3; pass++) {
      n = 0;
      lo = Infinity;
      for (let y = v0; y <= v1; y++) {
        for (let x = u0; x <= u1; x++) {
          const d = depth[y * W + x];
          if (d < minDepth || d > maxDepth || (pass === 0 && uidMap[y * W + x] !== uid)) continue;
          w[n++] = d;
          if (d < lo) lo = d;
        }
      }
    }
    if (n < 3) return 0;
    let m = 0;
    for (let k = 0; k < n; k++) if (w[k] <= lo + 120) w[m++] = w[k];
    const sub = w.subarray(0, m).sort();
    return sub[m >> 1];
  }

  /**
   * Keypoints (u, v, conf) -> 3D joints J (x, y, z mm, valid) and image points UV (u, v, conf).
   * seen: the person has pixels in uidMap (their depth is preferred: a keypoint next to the
   * silhouette must not take the depth of the background behind it).
   */
  _lift(kp, depth, uidMap, uid, seen, J, UV) {
    const o = this.options;
    const rays = this.rays;
    J.fill(0);
    UV.fill(0);
    const ds = [];
    for (let k = 0; k < 17; k++) {
      const c = kp[3 * k + 2];
      const u = kp[3 * k];
      const v = kp[3 * k + 1];
      UV[3 * k] = u;
      UV[3 * k + 1] = v;
      if (c < o.minKeypoint || u < 0 || v < 0 || u > W - 1 || v > H - 1) continue;
      // hidden behind someone else (that person owns the pixel): its depth is not ours
      const owner = uidMap[Math.round(v) * W + Math.round(u)];
      if (owner && owner !== uid) continue;
      const d = this._depthNear(depth, u, v, seen ? uidMap : null, uid);
      if (!d) continue;
      UV[3 * k + 2] = c;
      J[4 * k + 2] = d;
      J[4 * k + 3] = 1;
      ds.push(d);
    }
    // keypoints that hit the background through a gap: far from the rest of the body
    if (ds.length) {
      ds.sort((a, b) => a - b);
      const med = ds[ds.length >> 1];
      for (let k = 0; k < 17; k++) {
        if (J[4 * k + 3] && Math.abs(J[4 * k + 2] - med) > 900) {
          J[4 * k + 3] = 0;
          UV[3 * k + 2] = 0;
        }
      }
    }
    for (let k = 0; k < 17; k++) {
      if (!J[4 * k + 3]) continue;
      // the joint center lies a few cm behind the surface the keypoint is seen on
      const i = Math.round(UV[3 * k + 1]) * W + Math.round(UV[3 * k]);
      const z = J[4 * k + 2] + INSET[k] * 1000;
      J[4 * k] = rays[2 * i] * z;
      J[4 * k + 1] = rays[2 * i + 1] * z;
      J[4 * k + 2] = z;
    }
    const mid = (a, b, out) => {
      if (!J[4 * a + 3] || !J[4 * b + 3]) return;
      for (let j = 0; j < 3; j++) J[4 * out + j] = (J[4 * a + j] + J[4 * b + j]) / 2;
      J[4 * out + 3] = 1;
      UV[3 * out] = (UV[3 * a] + UV[3 * b]) / 2;
      UV[3 * out + 1] = (UV[3 * a + 1] + UV[3 * b + 1]) / 2;
      UV[3 * out + 2] = Math.min(UV[3 * a + 2], UV[3 * b + 2]);
    };
    mid(5, 6, SC);
    mid(11, 12, HC);
    // head: the face keypoints that were found
    let n = 0;
    for (let k = 0; k < 5; k++) {
      if (!J[4 * k + 3]) continue;
      for (let j = 0; j < 3; j++) J[4 * HEAD + j] += J[4 * k + j];
      UV[3 * HEAD] += UV[3 * k];
      UV[3 * HEAD + 1] += UV[3 * k + 1];
      n++;
    }
    if (n) {
      for (let j = 0; j < 3; j++) J[4 * HEAD + j] /= n;
      UV[3 * HEAD] /= n;
      UV[3 * HEAD + 1] /= n;
      UV[3 * HEAD + 2] = 1;
      J[4 * HEAD + 3] = 1;
    }
    // hands: beyond the wrist, along the forearm
    const hand = (e, w, out) => {
      if (!J[4 * e + 3] || !J[4 * w + 3]) return;
      for (let j = 0; j < 3; j++) J[4 * out + j] = J[4 * w + j] + 0.45 * (J[4 * w + j] - J[4 * e + j]);
      J[4 * out + 3] = 1;
      UV[3 * out] = UV[3 * w] + 0.45 * (UV[3 * w] - UV[3 * e]);
      UV[3 * out + 1] = UV[3 * w + 1] + 0.45 * (UV[3 * w + 1] - UV[3 * e + 1]);
      UV[3 * out + 2] = 1;
    };
    hand(7, 9, LH);
    hand(8, 10, RH);
    // legs that leave the image at the bottom: the shin continues the thigh to the image border
    const shin = (hip, knee, ankle) => {
      if (J[4 * ankle + 3] || !J[4 * hip + 3] || !J[4 * knee + 3]) return;
      const u = UV[3 * knee] + 0.9 * (UV[3 * knee] - UV[3 * hip]);
      const v = UV[3 * knee + 1] + 0.9 * (UV[3 * knee + 1] - UV[3 * hip + 1]);
      if (v < H - 12) return; // the ankle would be in the image: not found for a reason
      for (let j = 0; j < 3; j++) J[4 * ankle + j] = J[4 * knee + j] + 0.9 * (J[4 * knee + j] - J[4 * hip + j]);
      J[4 * ankle + 3] = 1;
      UV[3 * ankle] = u;
      UV[3 * ankle + 1] = v;
    };
    shin(11, 13, 15);
    shin(12, 14, 16);
    for (const [a, b] of PARTS) if (J[4 * a + 3] && J[4 * b + 3]) return true;
    return false;
  }

  /**
   * The skeleton of the current frame: its keypoints (followed by the flow) lifted with this frame's
   * depth, the person's own pixels of the last frame preferred; its body parts. Keypoints the flow
   * lost for a while do not count. Without any: the skeleton of the last frame.
   */
  _place(t) {
    if (!t.lifted || t.kpSeq === null) return false;
    const kp = this.kpScratch;
    kp.set(t.kp);
    for (let k = 0; k < 17; k++) if (t.lost[k] > MAX_LOST) kp[3 * k + 2] = 0;
    if (this._lift(kp, this.lastDepth, this.prevUid, t.uid, t.pixels > 0, this.jScratch, this.uvScratch)) {
      t.joints.set(this.jScratch);
      t.uv.set(this.uvScratch);
    }
    return this._capsules(t.joints, t.capsules);
  }

  /** Body part capsules of a skeleton; false if it has none. */
  _capsules(J, C) {
    const o = this.options;
    let any = false;
    for (let p = 0; p < NP; p++) {
      const [a, b, r] = PARTS[p];
      const ok = J[4 * a + 3] && J[4 * b + 3];
      C[CAP * p + 8] = ok ? 1 : 0;
      if (!ok) continue;
      any = true;
      for (let j = 0; j < 3; j++) {
        C[CAP * p + j] = J[4 * a + j];
        C[CAP * p + 3 + j] = J[4 * b + j];
      }
      const rr = (r + o.margin) * 1000;
      const rr2 = (r + o.margin + o.reach) * 1000;
      C[CAP * p + 6] = rr * rr;
      C[CAP * p + 7] = rr2 * rr2;
    }
    return any;
  }

  /** Share of the pixels of person `uid` (every 3rd row and column) within reach of capsules C. */
  _covers(C, uidMap, depth, uid) {
    const rays = this.rays;
    let n = 0;
    let ok = 0;
    let hint = 0;
    for (let v = 1; v < H; v += 3) {
      for (let u = 1; u < W; u += 3) {
        const i = v * W + u;
        if (uidMap[i] !== uid) continue;
        const d = depth[i];
        if (!d) continue;
        n++;
        const p = fit(C, hint, rays[2 * i] * d, rays[2 * i + 1] * d, d, false);
        if (p >= 0) {
          ok++;
          hint = p;
        }
      }
    }
    return n ? ok / n : 1;
  }

  // ---------- 3. segmentation ----------

  _segment(depth, persons) {
    const o = this.options;
    const rays = this.rays;
    const owner = this.owner;
    const partOf = this.partOf;
    const queue = this.queue;
    const prevUid = this.prevUid;
    const prevDepth = this.prevDepth;
    const bg = this.bg;
    const index = this.uidIndex;
    const { minDepth, maxDepth, joinMargin, joinSlope, bgMargin, bgSlope } = o;
    owner.fill(-1);
    let tail = 0;
    const f = this.floor;
    const fx = f ? f.normal[0] : 0;
    const fy = f ? f.normal[1] : 0;
    const fz = f ? f.normal[2] : 0;
    const fd = f ? (f.d - o.floorClearance) * 1000 : 0;
    // the depth at a pixel moved less than this: still the same surface
    const same = (d, e) => (d > e ? d - e : e - d) <= 60 + 0.03 * e;
    for (let q = 0; q < persons.length; q++) index[persons[q].uid] = q;

    // where each person may grow: its skeleton and its last pixels, plus its reach
    const boxes = [];
    for (const t of persons) {
      let u0 = W;
      let v0 = H;
      let u1 = -1;
      let v1 = -1;
      let z = Infinity;
      for (let k = 0; k < NJ; k++) {
        if (!t.joints[4 * k + 3]) continue;
        const u = t.uv[3 * k];
        const v = t.uv[3 * k + 1];
        if (u < u0) u0 = u;
        if (u > u1) u1 = u;
        if (v < v0) v0 = v;
        if (v > v1) v1 = v;
        if (t.joints[4 * k + 2] < z) z = t.joints[4 * k + 2];
      }
      if (t.pixels && t.bbox) {
        u0 = Math.min(u0, t.bbox[0]);
        v0 = Math.min(v0, t.bbox[1]);
        u1 = Math.max(u1, t.bbox[2]);
        v1 = Math.max(v1, t.bbox[3]);
      }
      const pad = Math.ceil(((o.reach + 0.25) * 1000 * 370) / Math.max(500, z)) + 4;
      boxes.push([
        Math.max(0, Math.floor(u0 - pad)),
        Math.max(0, Math.floor(v0 - pad)),
        Math.min(W - 1, Math.ceil(u1 + pad)),
        Math.min(H - 1, Math.ceil(v1 + pad)),
      ]);
    }

    // a pixel inside a body part of another person (and none of its own) is that person's: touching
    // persons, an arm around someone's shoulder. Cheap first tests: boxes around the body parts.
    const reachBoxes = persons.map((t) => {
      const C = t.capsules;
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let p = 0; p < NP; p++) {
        const c = CAP * p;
        if (!C[c + 8]) continue;
        const r = Math.sqrt(C[c + 6]);
        for (let j = 0; j < 3; j++) {
          b[j] = Math.min(b[j], C[c + j] - r, C[c + 3 + j] - r);
          b[3 + j] = Math.max(b[3 + j], C[c + j] + r, C[c + 3 + j] + r);
        }
      }
      return b;
    });
    // only persons whose body parts lie within reach of q's can take pixels from q
    const near = o.reach * 1000;
    const others = reachBoxes.map((a, q) =>
      reachBoxes
        .map((b, r) => (r !== q && b[0] < a[3] + near && b[3] > a[0] - near && b[1] < a[4] + near && b[4] > a[1] - near && b[2] < a[5] + near && b[5] > a[2] - near ? r : -1))
        .filter((r) => r >= 0),
    );
    const foreign = (q, x, y, z) => {
      const list = others[q];
      for (let k = 0; k < list.length; k++) {
        const r = list[k];
        const b = reachBoxes[r];
        if (x < b[0] || x > b[3] || y < b[1] || y > b[4] || z < b[2] || z > b[5]) continue;
        if (fit(persons[r].capsules, 0, x, y, z, true) < 0) continue;
        return fit(persons[q].capsules, 0, x, y, z, true) < 0;
      }
      return false;
    };

    // seeds 1: pixels along the bones that lie inside their body part (nearer persons first) and
    // are no one else's (someone whose surface is still there keeps it)
    for (let q = 0; q < persons.length; q++) {
      const t = persons[q];
      const C = t.capsules;
      const UV = t.uv;
      for (let p = 0; p < NP; p++) {
        if (!C[CAP * p + 8]) continue;
        const [a, b] = PARTS[p];
        const steps = Math.max(1, Math.ceil(Math.hypot(UV[3 * b] - UV[3 * a], UV[3 * b + 1] - UV[3 * a + 1]) / 2));
        for (let s = 0; s <= steps; s++) {
          const u = Math.round(UV[3 * a] + ((UV[3 * b] - UV[3 * a]) * s) / steps);
          const v = Math.round(UV[3 * a + 1] + ((UV[3 * b + 1] - UV[3 * a + 1]) * s) / steps);
          if (u < 0 || v < 0 || u >= W || v >= H) continue;
          const i = v * W + u;
          if (owner[i] !== -1) continue;
          const d = depth[i];
          if (d < minDepth || d > maxDepth) continue;
          const pu = prevUid[i];
          if (pu && pu !== t.uid && index[pu] >= 0 && same(d, prevDepth[i])) continue;
          const bd = bg[i];
          if (bd && (d > bd ? d - bd : bd - d) <= bgMargin + bgSlope * bd) continue;
          const x = rays[2 * i] * d;
          const y = rays[2 * i + 1] * d;
          if (f && fx * x + fy * y + fz * d + fd < 0) continue;
          if (seg(C, p, x, y, d) > C[CAP * p + 6] || segDz > BEHIND) continue;
          owner[i] = q;
          partOf[i] = p;
          queue[tail++] = i;
        }
      }
    }
    // seeds 2: the persons' pixels of the previous frame where the surface is still there
    for (let i = 0; i < N; i++) {
      const pu = prevUid[i];
      if (!pu || owner[i] !== -1) continue;
      const q = index[pu];
      if (q < 0) continue;
      const d = depth[i];
      if (d < minDepth || d > maxDepth || !same(d, prevDepth[i])) continue;
      const bd = bg[i];
      if (bd && (d > bd ? d - bd : bd - d) <= bgMargin + bgSlope * bd) continue;
      const x = rays[2 * i] * d;
      const y = rays[2 * i + 1] * d;
      if (f && fx * x + fy * y + fz * d + fd < 0) continue;
      const p = fit(persons[q].capsules, partOf[i] < NP ? partOf[i] : 0, x, y, d, false);
      if (p < 0 || (others[q].length && foreign(q, x, y, d))) continue;
      owner[i] = q;
      partOf[i] = p;
      queue[tail++] = i;
    }

    // grow all persons at once (breadth first): connected without depth jumps, no background,
    // within reach of the skeleton; where the background is unknown, inside a body part
    let head = 0;
    while (head < tail) {
      const i = queue[head++];
      const q = owner[i];
      const di = depth[i];
      const tol = joinMargin + joinSlope * di;
      const t = persons[q];
      const C = t.capsules;
      const uid = t.uid;
      const bx = boxes[q];
      const v = (i / W) | 0;
      const u = i - v * W;
      for (let n = 0; n < 4; n++) {
        let j;
        if (n === 0) {
          if (u <= bx[0]) continue;
          j = i - 1;
        } else if (n === 1) {
          if (u >= bx[2]) continue;
          j = i + 1;
        } else if (n === 2) {
          if (v <= bx[1]) continue;
          j = i - W;
        } else {
          if (v >= bx[3]) continue;
          j = i + W;
        }
        if (owner[j] !== -1) continue;
        const dj = depth[j];
        if (dj < minDepth || dj > maxDepth || dj - di > tol || di - dj > tol) continue;
        const bd = bg[j];
        if (bd && (dj > bd ? dj - bd : bd - dj) <= bgMargin + bgSlope * bd) continue;
        const x = rays[2 * j] * dj;
        const y = rays[2 * j + 1] * dj;
        if (f && fx * x + fy * y + fz * dj + fd < 0) continue; // on the floor
        const p = fit(C, partOf[i], x, y, dj, !bd && prevUid[j] !== uid);
        if (p < 0 || (others[q].length && foreign(q, x, y, dj))) continue;
        owner[j] = q;
        partOf[j] = p;
        queue[tail++] = j;
      }
    }
    for (const t of persons) index[t.uid] = -1;
    return tail;
  }

  // ---------- 4. background ----------

  /**
   * Learns the background where no person is: what stays in place (see learnFrames & co.). Close
   * to a person, an unknown background takes as long as something new (the person's sleeve or
   * dress that the segmentation missed must not become background while they stand still).
   */
  _learn(depth, persons) {
    const { bgMargin, bgSlope, learnFrames, farFrames, nearFrames } = this.options;
    const near = this.nearPerson;
    near.fill(0);
    for (const t of persons) {
      if (!t.pixels || !t.bbox) continue;
      const pad = Math.ceil((250 * 370) / Math.max(500, t.pos[2]));
      const u0 = Math.max(0, t.bbox[0] - pad);
      const u1 = Math.min(W - 1, t.bbox[2] + pad);
      for (let v = Math.max(0, t.bbox[1] - pad), v1 = Math.min(H - 1, t.bbox[3] + pad); v <= v1; v++) near.fill(1, v * W + u0, v * W + u1 + 1);
    }
    const owner = this.owner;
    const bg = this.bg;
    const cand = this.bgCand;
    const count = this.bgCount;
    for (let i = 0; i < N; i++) {
      if (owner[i] !== -1) {
        count[i] = 0;
        continue;
      }
      const d = depth[i];
      if (!d) continue;
      const b = bg[i];
      if (b && (d > b ? d - b : b - d) <= bgMargin + bgSlope * b) {
        bg[i] = b + Math.round((d - b) / 8);
        count[i] = 0;
        continue;
      }
      const c = cand[i];
      const n = count[i];
      if (n && (d > c ? d - c : c - d) <= bgMargin + bgSlope * c) {
        if (n < 255) count[i] = n + 1;
      } else if (n > 2) {
        count[i] = n - 2;
      } else {
        cand[i] = d;
        count[i] = 1;
      }
      const need = !b ? (near[i] ? nearFrames : learnFrames) : cand[i] > b ? farFrames : nearFrames;
      if (count[i] >= need) {
        bg[i] = cand[i];
        count[i] = 0;
      }
    }
  }

  // ---------- 5. per frame ----------

  /**
   * One depth frame (Uint16Array mm, 0 = no measurement) with the poses set so far. Writes into
   * out.labels (Uint8Array N), out.depth (Uint16Array N), out.indices (Uint32Array N) if given.
   * seq: the frame's number (markPoseFrame and setPoses refer to it); ir: its infrared image
   * (Uint8Array N), which lets the keypoints follow the persons between two poses.
   */
  process(depth, out = {}, seq = undefined, ir = null) {
    const t0 = now();
    const o = this.options;
    const labels = out.labels ?? new Uint8Array(N);
    const masked = out.depth ?? new Uint16Array(N);
    const indices = out.indices ?? new Uint32Array(N);
    this.frame++;
    seq ??= this.frame;
    this.lastDepth = depth;
    if (ir && !this.flow.has(seq)) this.flow.push(seq, ir);

    // persons without a pose for too long are gone; the others get a slot once confirmed
    const lost = Math.round(o.lostSeconds * o.fps);
    const keep = Math.round(o.keepSeconds * o.fps);
    this.tracks = this.tracks.filter((t) => this.frame - t.lastPose <= (t.pixels ? keep : lost));
    const used = new Set(this.tracks.filter((t) => t.slot).map((t) => t.slot));
    for (const t of this.tracks) {
      if (!t.slot && t.poses >= o.confirmPoses) {
        for (let s = 1; s <= o.maxPersons; s++) {
          if (!used.has(s)) {
            t.slot = s;
            t.id = this.nextId++;
            t.since = this.frame;
            used.add(s);
            break;
          }
        }
      }
    }
    for (const t of this.tracks) this._keypointsAt(t, seq);
    this.lastSeq = seq;
    const active = this.tracks.filter((t) => this._place(t));
    // nearer persons first: their seeds win where persons overlap in the image
    const near = (t) => {
      let z = Infinity;
      for (let k = 0; k < 17; k++) if (t.joints[4 * k + 3]) z = Math.min(z, t.joints[4 * k + 2]);
      return z;
    };
    active.sort((a, b) => near(a) - near(b));
    const count = this._segment(depth, active);

    // labels and statistics in one pass over the claimed pixels
    labels.fill(0);
    masked.fill(0);
    const stats = active.map(() => ({ n: 0, area: 0, sx: 0, sy: 0, sz: 0, su: 0, sv: 0, u0: W, v0: H, u1: -1, v1: -1, hMin: Infinity, hMax: -Infinity }));
    const f = this.floor ?? this.feetFloor;
    const upx = f ? f.normal[0] : 0;
    const upy = f ? f.normal[1] : -1;
    const upz = f ? f.normal[2] : 0;
    const up0 = f ? f.d * 1000 : 0;
    const rays = this.rays;
    const pa = this.pixArea;
    const queue = this.queue;
    const owner = this.owner;
    let k = 0;
    for (let c = 0; c < count; c++) {
      const i = queue[c];
      const q = owner[i];
      const t = active[q];
      const d = depth[i];
      if (t.slot) {
        labels[i] = t.slot;
        masked[i] = d;
        indices[k++] = i;
      }
      const s = stats[q];
      const x = rays[2 * i] * d;
      const y = rays[2 * i + 1] * d;
      const v = (i / W) | 0;
      const u = i - v * W;
      s.n++;
      s.area += d * d * pa[i];
      s.sx += x;
      s.sy += y;
      s.sz += d;
      s.su += u;
      s.sv += v;
      if (u < s.u0) s.u0 = u;
      if (u > s.u1) s.u1 = u;
      if (v < s.v0) s.v0 = v;
      if (v > s.v1) s.v1 = v;
      const h = upx * x + upy * y + upz * d + up0;
      if (h < s.hMin) s.hMin = h;
      if (h > s.hMax) s.hMax = h;
    }
    indices.subarray(0, k).sort(); // raster order: neighbors stay neighbors for the consumers
    const prevUid = this.prevUid;
    prevUid.fill(0);
    for (let c = 0; c < count; c++) prevUid[queue[c]] = active[owner[queue[c]]].uid;
    for (const t of this.tracks) {
      const q = active.indexOf(t);
      this._update(t, q >= 0 ? stats[q] : null);
    }
    // the background is learned once the pose model runs (before, a person could become part of it)
    if (this.poseResults) this._learn(depth, this.tracks);
    this.prevDepth.set(depth);
    if (seq !== undefined && seq === this.snapSeq) this._snapshot(seq, depth);

    if (o.floor) {
      this._floorStep(depth);
      if (!this.floor && this.frame % 15 === 0) this._feetStep();
    } else this.floor = this.feetFloor = null;

    const persons = this.tracks.filter((t) => t.slot && t.pos).map((t) => this._describe(t));
    this.lastStats = { ms: now() - t0, tracks: this.tracks.length, pixels: k };
    return {
      frame: this.frame,
      labels,
      depth: masked,
      indices: indices.subarray(0, k),
      count: k,
      persons,
      floor: this.floor ?? this.feetFloor,
      stats: this.lastStats,
    };
  }

  _snapshot(seq, depth) {
    const s = (this.snap ??= { seq: -1, uid: new Int16Array(N), depth: new Uint16Array(N), tracks: new Map() });
    s.seq = seq;
    s.uid.set(this.prevUid);
    s.depth.set(depth);
    s.tracks.clear();
    for (const t of this.tracks) if (t.pixels) s.tracks.set(t.uid, { pos: t.pos.slice(), c2: t.c2.slice() });
    this.snapSeq = null;
  }

  _update(t, s) {
    if (!s || s.n === 0) {
      t.pixels = 0;
      return;
    }
    const c = [s.sx / s.n, s.sy / s.n, s.sz / s.n];
    if (t.pos && t.pixels) {
      for (let j = 0; j < 3; j++) t.vel[j] = 0.7 * t.vel[j] + 0.3 * (c[j] - t.pos[j]);
    }
    t.pos = c;
    const c2 = [s.su / s.n, s.sv / s.n];
    t.dc2 = t.c2 && t.pixels ? [c2[0] - t.c2[0], c2[1] - t.c2[1]] : null;
    t.c2 = c2;
    t.pixels = s.n;
    t.area = s.area * 1e-6;
    t.bbox = [s.u0, s.v0, s.u1, s.v1];
    t.hMin = s.hMin;
    t.hMax = s.hMax;
  }

  _describe(t) {
    const f = this.floor ?? this.feetFloor;
    const mm = (p) => p.map((x) => Math.round(x));
    const J = t.joints;
    let ground;
    // where it stands: below the ankles (else below the center)
    const ankles = [15, 16].filter((k) => J[4 * k + 3]);
    const base = ankles.length ? [0, 1, 2].map((j) => ankles.reduce((a, k) => a + J[4 * k + j], 0) / ankles.length) : t.pos;
    if (f) {
      const h = f.normal[0] * base[0] + f.normal[1] * base[1] + f.normal[2] * base[2] + f.d * 1000;
      ground = [base[0] - f.normal[0] * h, base[1] - f.normal[1] * h, base[2] - f.normal[2] * h];
    } else {
      // no floor known: straight below the center, at the lowest point of the person
      ground = [t.pos[0], -t.hMin, t.pos[2]];
    }
    const joints = [];
    const keypoints = [];
    for (let k = 0; k < 17; k++) {
      const ok = J[4 * k + 3] && t.pixels;
      joints.push([Math.round(J[4 * k]), Math.round(J[4 * k + 1]), Math.round(J[4 * k + 2]), ok ? Math.round(t.uv[3 * k + 2] * 100) / 100 : 0]);
      const conf = t.lost[k] > MAX_LOST ? 0 : t.kp[3 * k + 2];
      keypoints.push([Math.round(t.kp[3 * k] * 10) / 10, Math.round(t.kp[3 * k + 1] * 10) / 10, Math.round(conf * 100) / 100]);
    }
    const head = J[4 * HEAD + 3] ? [J[4 * HEAD], J[4 * HEAD + 1], J[4 * HEAD + 2]] : t.pos;
    const fps = this.options.fps;
    return {
      id: t.id,
      slot: t.slot,
      visible: t.pixels > 0,
      age: (this.frame - (t.since ?? this.frame)) / fps,
      score: Math.round((t.score ?? 0) * 100) / 100,
      pixels: t.pixels,
      area: Math.round((t.area ?? 0) * 1000) / 1000,
      centroid: mm(t.pos),
      head: mm(head),
      ground: mm(ground),
      height: Math.round(f ? t.hMax : t.hMax - t.hMin) / 1000,
      velocity: mm(t.vel.map((x) => x * fps)),
      bbox: t.bbox ?? [0, 0, 0, 0],
      joints,
      keypoints,
    };
  }

  // ---------- 6. floor ----------

  _random() {
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    return this.rng / 4294967296;
  }

  /** Without a visible floor: level, a little below the ankles of the persons. */
  _feetStep() {
    for (const t of this.tracks) {
      if (!t.slot || !t.pixels) continue;
      for (const k of [15, 16]) {
        if (t.joints[4 * k + 3] && t.uv[3 * k + 2] > 0.5) this.feet.push(t.joints[4 * k + 1] + 70);
      }
    }
    if (this.feet.length > 240) this.feet.splice(0, this.feet.length - 240);
    if (this.feet.length < 12) return;
    const ys = this.feet.slice().sort((a, b) => a - b);
    const y = ys[ys.length >> 1];
    if (y < 250 || y > 3500) return;
    const old = this.feetFloor;
    const d = old ? 0.8 * old.d + 0.2 * (y / 1000) : y / 1000;
    this.feetFloor = { normal: [0, -1, 0], d, height: d, pitchDeg: 0, rollDeg: 0, support: 0, source: 'feet' };
  }

  /** Floor estimation, spread over a few frames (RANSAC on what is no person, 32 tries a frame). */
  _floorStep(depth) {
    const job = this._floorJob;
    if (!job) {
      if (this.frame - this._floorAt < (this.floor ? 60 : 15)) return;
      this._floorAt = this.frame;
      const rays = this.rays;
      const owner = this.owner;
      this._samples ??= new Float32Array(3 * Math.ceil(N / 16 + 64));
      const S = this._samples;
      let n = 0;
      for (let v = 2; v < H; v += 4) {
        for (let u = 2; u < W; u += 4) {
          const i = v * W + u;
          const d = depth[i];
          if (owner[i] !== -1 || d < 400 || d > 7000) continue;
          const z = d * 0.001;
          S[3 * n] = rays[2 * i] * z;
          S[3 * n + 1] = rays[2 * i + 1] * z;
          S[3 * n + 2] = z;
          n++;
        }
      }
      if (n >= 300) this._floorJob = { n, it: 0, best: null };
      return;
    }
    const S = this._samples;
    const n = job.n;
    const tol = 0.03;
    const cosMax = Math.cos((52 * Math.PI) / 180);
    for (let k = 0; k < 32 && job.it < 160; k++, job.it++) {
      const a = 3 * Math.floor(this._random() * n);
      const b = 3 * Math.floor(this._random() * n);
      const c = 3 * Math.floor(this._random() * n);
      const ux = S[b] - S[a];
      const uy = S[b + 1] - S[a + 1];
      const uz = S[b + 2] - S[a + 2];
      const vx = S[c] - S[a];
      const vy = S[c + 1] - S[a + 1];
      const vz = S[c + 2] - S[a + 2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-4) continue;
      nx /= len;
      ny /= len;
      nz /= len;
      if (ny > 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      if (-ny < cosMax) continue; // not horizontal enough (n points up = -y)
      // a sensor on a tripod: looks up to 15° up or 50° down, rolled by 15° at most
      if (nz > 0.26 || nz < -0.77 || Math.abs(nx) > 0.26) continue;
      const d = -(nx * S[a] + ny * S[a + 1] + nz * S[a + 2]);
      if (d < 0.25 || d > 3.5) continue; // the sensor is 0.25..3.5 m above it
      let inl = 0;
      let below = 0;
      for (let q = 0; q < n; q += 2) {
        const h = nx * S[3 * q] + ny * S[3 * q + 1] + nz * S[3 * q + 2] + d;
        if (h < tol && h > -tol) inl++;
        else if (h < -0.08) below++;
      }
      // the floor is the lowest large surface: hardly anything may lie below it
      const score = inl - 4 * below;
      if (score > 0 && (!job.best || score > job.best.score)) job.best = { nx, ny, nz, d, score };
    }
    if (job.it < 160) return;
    this._floorJob = null;
    const best = job.best;
    if (!best) return;
    // least squares refinement over the inliers: y = a x + b z + c
    let sxx = 0;
    let sxz = 0;
    let sx = 0;
    let szz = 0;
    let sz = 0;
    let sxy = 0;
    let szy = 0;
    let sy = 0;
    let m = 0;
    let below = 0;
    for (let q = 0; q < n; q++) {
      const x = S[3 * q];
      const y = S[3 * q + 1];
      const z = S[3 * q + 2];
      const h = best.nx * x + best.ny * y + best.nz * z + best.d;
      if (h < -0.08) below++;
      if (h >= tol || h <= -tol) continue;
      sxx += x * x;
      sxz += x * z;
      sx += x;
      szz += z * z;
      sz += z;
      sxy += x * y;
      szy += z * y;
      sy += y;
      m++;
    }
    if (m < Math.max(200, 0.05 * n) || below > 0.015 * n) return;
    // the inliers must cover an area (not a line along some edges): spread of x/z both ways
    const mx = sx / m;
    const mz = sz / m;
    const cxx = sxx / m - mx * mx;
    const czz = szz / m - mz * mz;
    const cxz = sxz / m - mx * mz;
    const minor = (cxx + czz) / 2 - Math.sqrt(((cxx - czz) / 2) ** 2 + cxz * cxz);
    if (!(minor > 0.2 * 0.2)) return;
    const sol = solve3([sxx, sxz, sx, sxz, szz, sz, sx, sz, m], [sxy, szy, sy]);
    if (!sol) return;
    const [pa, pb, pc] = sol;
    const len = Math.hypot(pa, 1, pb);
    const plane = { normal: [pa / len, -1 / len, pb / len], d: pc / len, support: m / n, source: 'seen' };
    if (plane.d < 0.2) return;
    const old = this.floor;
    if (old) {
      const dot = old.normal[0] * plane.normal[0] + old.normal[1] * plane.normal[1] + old.normal[2] * plane.normal[2];
      if (dot > Math.cos((3 * Math.PI) / 180) && Math.abs(old.d - plane.d) < 0.05) {
        // the same floor: smooth it
        const nn = old.normal.map((x, j) => 0.8 * x + 0.2 * plane.normal[j]);
        const l = Math.hypot(...nn);
        plane.normal = nn.map((x) => x / l);
        plane.d = 0.8 * old.d + 0.2 * plane.d;
      } else if (plane.support < 1.2 * (old.support ?? 0)) return; // keep the old one
    }
    const [x, y, z] = plane.normal;
    plane.height = plane.d;
    plane.pitchDeg = (Math.atan2(-z, -y) * 180) / Math.PI; // > 0: the sensor looks down
    plane.rollDeg = (Math.atan2(x, -y) * 180) / Math.PI;
    this.floor = plane;
  }
}

/** Solves the 3x3 system A x = b (A row-major), null if singular. */
function solve3(A, b) {
  const [a, bb, c, d, e, f, g, h, i] = A;
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const inv = [e * i - f * h, c * h - bb * i, bb * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, bb * g - a * h, a * e - bb * d];
  return [0, 1, 2].map((r) => (inv[3 * r] * b[0] + inv[3 * r + 1] * b[1] + inv[3 * r + 2] * b[2]) / det);
}
