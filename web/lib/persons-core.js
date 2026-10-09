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
//      persons are split at their body parts. A person's pixel that lies still outside its body
//      parts for seconds (a desk edge it touched) becomes background.
//   3. output: labels, the depth of the person pixels only, the list of person pixels, and per
//      person position, head, ground point, height, velocity, joints (3D) and keypoints (2D)
//   4. every 2 s: the floor (RANSAC on everything that is no person), else from the ankles
// Skeletons: every pose becomes a keyframe of its person, matched through the labels of the frame
// it was computed on (markPoseFrame); a pose whose skeleton does not cover the person's pixels
// (keypoints on the background) does not. Each frame follows the keypoints from the newest keyframe
// with the optical flow on the infrared image (persons-flow.js) and lifts them to 3D with its own
// depth, never onto someone else's pixels nor far in front of where the person just was (hidden
// behind someone); a joint it cannot place keeps its place, moved with the person. The flow often
// loses a fast arm, so the arms of every frame come from its mask once segmented (_arms): the
// person's pixels outside its trunk that connect to a shoulder, their far end the hand. finalize()
// makes the skeletons of a frame exact once the pose of a later frame is in: interpolated between
// the keyframes before and after it (delayed output, see persons-worker.js), the arms' depth
// measured on the person's pixels of that frame.
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
/** The points after the 17 joints in `extra` / `extraKeypoints`: derived from the joints. */
export const EXTRA = ['neck', 'pelvis', 'head', 'leftHand', 'rightHand'];
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
// the body parts that are no arm, the trunk first (an arm is what lies outside them)
const CORE_PARTS = [3, 4, 5, 6, 2, 1, 0, 13, 14, 15, 16, 17, 18];
// per capsule: ax, ay, az, bx, by, bz (mm), radius², reach radius², valid
const CAP = 9;
// bones whose middle is sampled to see whose pixels a pose lies on
const BODY_BONES = SKELETON.slice(0, 12);
const MAX_TRACKS = 32;
const MAX_LOST = 8; // a keypoint the flow could not follow for more frames is not used until the next pose
const KEEP_KEYS = 60; // frames a keyframe is kept after a newer one (finalize() looks back that far)
const HIDDEN = 800; // mm: a keypoint this far in front of the person's joints of a moment ago is hidden
// limb bones (parent, child) and their typical length (mm, joint center to joint center): a thin
// wrist or ankle whose depth does not fit its bone is put on its ray at the bone's length
const LIMBS = [[5, 7, 290], [7, 9, 250], [6, 8, 290], [8, 10, 250], [11, 13, 430], [13, 15, 420], [12, 14, 430], [14, 16, 420]];
const LIMB_LENGTHS = Float32Array.from(LIMBS, (l) => l[2]);
// arms (elbow, wrist, hand): their depth is measured on the person's own pixels (a window of
// ARM_WINDOW pixels around them), not set from the bone lengths
const ARM_WINDOW = 5;
// mm from the far end of an arm in the mask (the fingertips) to the wrist and to the hand point
const WRIST_TIP = 140;
const HAND_TIP = 50;
const HAND_INSET = 30; // mm: the hand point lies this far behind the surface it is seen on
const ARM_TRUST = 120; // mm: a mask's arm this near the pose's wrist (same frame) is right
const ARM_JUMP = 300; // mm from one frame to the next: a mask's arm that jumps is not trusted
const KEEP_ARMS = 40; // frames the mask's arms are remembered for the poses that come later
const ARM_NEAR = 900; // mm: nearer persons keep the arms of the flow
// keypoints the optical flow follows with lower demands (elbows, wrists: little texture, fast)
const RELAX_ARMS = Uint8Array.from({ length: 17 }, (_, k) => (k >= 7 && k <= 10 ? 1 : 0));
const BEHIND = 70; // mm: how far behind its bone a pixel of a body may lie (the far rim of a limb)
// learned background "nothing measured here": beyond the sensor's range, a window, black velvet.
// Anything measured there is in front of it.
const FAR = 65535;

export const DEFAULTS = Object.freeze({
  mode: 'full', // 'full': masks and skeletons; 'skeleton': skeletons only (no masks, a fraction of the work)
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
  staticSeconds: 8, // a person's pixel outside its body parts that has not moved for this long is background (a desk edge)
  floorClearance: 0.025, // m: pixels this close to the floor are floor, not feet
  confirmPoses: 2, // a new person shows after this many pose detections (one of them on measured depth)
  keepSeconds: 4, // a visible person the pose model does not find any more is kept this long
  lostSeconds: 1.5, // a hidden person (no pixels) without a matching pose for this long is gone
  staleSeconds: 0.5, // skeleton mode: a person without a pose for this long is not visible (but kept)
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
  const k2 = 2 * (0.15 * scale) ** 2;
  for (let k = 0; k < 17; k++) {
    if (a[3 * k + 2] < minConf || b[3 * k + 2] < minConf) continue;
    const du = a[3 * k] - b[3 * k];
    const dv = a[3 * k + 1] - b[3 * k + 1];
    s += Math.exp(-(du * du + dv * dv) / k2);
    n++;
  }
  return n ? s / n : 0;
}

/** Box around the confident keypoints, null if there are fewer than two. */
function keypointBox(kp, minConf) {
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  let n = 0;
  for (let k = 0; k < 17; k++) {
    if (kp[3 * k + 2] < minConf) continue;
    u0 = Math.min(u0, kp[3 * k]);
    v0 = Math.min(v0, kp[3 * k + 1]);
    u1 = Math.max(u1, kp[3 * k]);
    v1 = Math.max(v1, kp[3 * k + 1]);
    n++;
  }
  return n >= 2 ? [u0, v0, u1, v1] : null;
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
    this.prevList = new Int32Array(N); // those pixels
    this.prevCount = 0;
    this.prevDepth = new Uint16Array(N);
    this.bg = new Uint16Array(N); // learned background depth (mm), 0 = not known yet
    this.bgCand = new Uint16Array(N); // a depth that may become the background
    this.bgCount = new Uint8Array(N); // frames it has been seen
    this.nearPerson = new Uint8Array(N); // 1 = close to a person: unknown background is learned slowly
    this.uidIndex = new Int8Array(32768).fill(-1);
    this.window = new Float32Array(169);
    this.jScratch = new Float32Array(NJ * 4);
    this.uvScratch = new Float32Array(NJ * 3);
    this.capScratch = new Float64Array(NP * CAP);
    this.kpScratch = new Float32Array(51);
    this.ptsScratch = new Float32Array(34);
    this.useScratch = new Uint8Array(17);
    this.lostScratch = new Uint8Array(17);
    this.flow = new FlowTracker(W, H, { history: 24, relaxTexture: 10, relaxError: 2 });
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
    this.prevCount = 0;
  }

  /** Forgets the learned background (after the sensor was moved, say). */
  resetBackground() {
    this.bg.fill(0);
    this.bgCount.fill(0);
  }

  // ---------- 1. poses -> tracks ----------

  /** The pose model starts on this frame: keep its labels and depth to match the poses against. */
  markPoseFrame(seq) {
    this.snapSeq = seq;
  }

  /**
   * Poses of the pose model: [{ score, box: [u0, v0, u1, v1], kp: Float32Array(17*3) (u, v, conf) }]
   * in depth image pixels, computed on frame `seq` (as passed to markPoseFrame and process). Each
   * becomes a keyframe of its person, matched through the labels of the frame it was computed on
   * (markPoseFrame, before that frame's process()).
   */
  setPoses(poses, seq) {
    const o = this.options;
    const snap = this.snap && seq !== undefined && this.snap.seq === seq ? this.snap : null;
    const uidMap = snap ? snap.uid : this.prevUid;
    const depth = snap ? snap.depth : this.lastDepth;
    if (!depth) return;
    this.poseResults++;
    if (o.mode === 'skeleton') {
      this._matchSkeletons(poses, seq, depth, uidMap, snap);
      return;
    }
    // whose pixels each pose lies on, in the frame it was computed on
    const hits = poses.map((p) => this._hits(p, uidMap, depth));
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
      const t = this.tracks[ti];
      if (this._solid(hits[pi], t.uid)) t.solid = true;
      this._applyPose(t, poses[pi], depth, uidMap, snap, seq);
    }
    for (let pi = 0; pi < poses.length; pi++) {
      const p = poses[pi];
      if (usedP.has(pi) || p.score < o.minScore || this.tracks.length >= MAX_TRACKS) continue;
      // mostly on someone's pixels: a second pose of a known person, not a new one
      if (hits[pi].n && hits[pi].any > 0.5 * hits[pi].n) continue;
      const t = this._newTrack(p);
      t.solid = this._solid(hits[pi]);
      this._applyPose(t, p, depth, uidMap, snap, seq);
    }
  }

  /**
   * Skeleton mode (no labels): poses go to the person whose keypoints are most alike (they are a
   * few frames older than the person's current keypoints: a generous tolerance) or whose keypoint
   * box overlaps most; the others start new persons unless they overlap someone.
   */
  _matchSkeletons(poses, seq, depth, uidMap, snap) {
    const o = this.options;
    const mk = o.minKeypoint;
    const boxes = this.tracks.map((t) => (t.kpSeq === null ? null : keypointBox(t.kp, mk)));
    const pairs = [];
    for (let pi = 0; pi < poses.length; pi++) {
      const p = poses[pi];
      const scale = Math.sqrt(Math.max(1, (p.box[2] - p.box[0]) * (p.box[3] - p.box[1])));
      for (let ti = 0; ti < this.tracks.length; ti++) {
        const b = boxes[ti];
        if (!b) continue;
        const s = keypointSimilarity(p.kp, this.tracks[ti].kp, scale, mk) + 0.5 * iou(p.box, b);
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
      if (this._solid(this._hits(poses[pi], uidMap, depth))) t.solid = true;
      this._applyPose(t, poses[pi], depth, uidMap, snap, seq);
    }
    for (let pi = 0; pi < poses.length; pi++) {
      const p = poses[pi];
      if (usedP.has(pi) || p.score < o.minScore || this.tracks.length >= MAX_TRACKS) continue;
      if (boxes.some((b) => b && iou(p.box, b) > 0.3)) continue; // a second pose of someone known
      const t = this._newTrack(p);
      t.solid = this._solid(this._hits(p, uidMap, depth));
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
        solid: false, // a pose of it lay on measured depth: it may be confirmed
        keys: [], // the poses: { seq, kp }, oldest first (kept while needed)
        kp: new Float32Array(51), // keypoints (u, v, conf) in frame kpSeq
        kpSeq: null,
        kpKey: null, // the keyframe kp was followed from
        lost: new Uint8Array(17), // frames in a row the flow could not follow a keypoint
        jointAge: new Uint16Array(NJ), // frames in a row a joint was carried over (not seen)
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

  /**
   * Samples along a pose (keypoints, middles of the bones): how many lie on whose pixels, and which
   * lie on something solid: a surface the depth measures where a person may be (most of the five
   * points around the sample; solid: those on nobody's pixels, dense: per person).
   */
  _hits(p, uidMap, depth) {
    const { minKeypoint: mk, minDepth, maxDepth } = this.options;
    const kp = p.kp;
    const by = new Map();
    const dense = new Map();
    let n = 0;
    let any = 0;
    let solid = 0;
    const sample = (u, v) => {
      n++;
      const ui = Math.round(u);
      const vi = Math.round(v);
      let id = 0;
      let m = 0;
      for (let k = 0; k < 5; k++) {
        const x = ui + (k === 1 ? -2 : k === 2 ? 2 : 0);
        const y = vi + (k === 3 ? -2 : k === 4 ? 2 : 0);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (!id) id = uidMap[y * W + x];
        const d = depth[y * W + x];
        if (d >= minDepth && d <= maxDepth) m++;
      }
      if (!id) {
        if (m >= 3) solid++;
        return;
      }
      any++;
      by.set(id, (by.get(id) ?? 0) + 1);
      if (m >= 3) dense.set(id, (dense.get(id) ?? 0) + 1);
    };
    for (let k = 0; k < 17; k++) if (kp[3 * k + 2] >= mk) sample(kp[3 * k], kp[3 * k + 1]);
    for (const [a, b] of BODY_BONES) {
      if (kp[3 * a + 2] >= mk && kp[3 * b + 2] >= mk) sample((kp[3 * a] + kp[3 * b]) / 2, (kp[3 * a + 1] + kp[3 * b + 1]) / 2);
    }
    return { n, any, by, solid, dense };
  }

  /**
   * Whether a pose lies on something solid: of its samples on no other person (on the pixels of
   * person uid, or on nobody's), a third. The pose model also finds people where the depth measures
   * nothing (or only noise): beyond its reach, a reflection in a window or a glass door. Such a
   * person is followed but not confirmed (shown) before a pose of it lies on measured depth. The
   * learned background counts as solid: someone who stood still while nobody followed them is part
   * of it.
   */
  _solid(h, uid = 0) {
    const own = uid ? (h.by.get(uid) ?? 0) : 0;
    const ownSolid = uid ? (h.dense.get(uid) ?? 0) : 0;
    return 3 * (h.solid + ownSolid) >= h.n - h.any + own;
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
    const seen = this.options.mode !== 'skeleton' && (snap ? snap.tracks.has(t.uid) : t.pixels > 0);
    if (!this._lift(p.kp, depth, uidMap, t.uid, seen, this.jScratch, this.uvScratch, this._refZ(t))) return;
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
    // the arms the mask had in that frame (_arms): where the pose has them? Then they are used.
    const h = t.armHist?.find((a) => a.seq === seq);
    if (!h) return;
    for (let s = 0; s < 2; s++) {
      const w = h.w[s];
      const k = 9 + s;
      if (!w || kp[3 * k + 2] < this.options.minKeypoint) continue;
      const tol = Math.max(8, (ARM_TRUST * 370) / w[2]);
      t.armTrust[s] = Math.hypot(w[0] - kp[3 * k], w[1] - kp[3 * k + 1]) < tol ? 1 : 0;
    }
  }

  /**
   * The keypoints of a person in frame seq: from its newest keyframe up to it, followed by the
   * optical flow (finalize() makes them exact later, between the keyframes before and after).
   */
  _keypointsAt(t, seq) {
    const keys = t.keys;
    let i0 = -1;
    for (let i = 0; i < keys.length; i++) if (keys[i].seq <= seq) i0 = i;
    if (i0 < 0) return; // no pose up to this frame yet
    while (i0 > 0 && keys[0].seq < seq - KEEP_KEYS) {
      keys.shift();
      i0--;
    }
    const k0 = keys[i0];
    const kp = t.kp;
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
    // a visible person's arms are followed with lower demands; a hidden person's points get lost
    // (they would follow the background)
    if (this.flow.track(t.kpSeq, seq, pts, 17, use, t.lost, true, t.pixels ? RELAX_ARMS : null)) {
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
   * Depth at a keypoint: the near cluster of a small window (radius r; the person, not what is
   * behind). With `uidMap`, only the pixels of person `uid` count if the window has any (strict:
   * only they), and never the pixels of someone else (the person in front of it).
   */
  _depthNear(depth, u, v, uidMap = null, uid = 0, r = 3, strict = false) {
    const { minDepth, maxDepth } = this.options;
    const w = this.window;
    let n = 0;
    let lo = Infinity;
    const u0 = Math.max(0, Math.round(u) - r);
    const u1 = Math.min(W - 1, Math.round(u) + r);
    const v0 = Math.max(0, Math.round(v) - r);
    const v1 = Math.min(H - 1, Math.round(v) + r);
    for (let pass = uidMap ? 0 : 1; pass < (strict ? 1 : 2) && n < 3; pass++) {
      n = 0;
      lo = Infinity;
      for (let y = v0; y <= v1; y++) {
        for (let x = u0; x <= u1; x++) {
          const d = depth[y * W + x];
          if (d < minDepth || d > maxDepth) continue;
          if (uidMap && (pass === 0 ? uidMap[y * W + x] !== uid : uidMap[y * W + x] && uidMap[y * W + x] !== uid)) continue;
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
   * silhouette must not take the depth of the background behind it). refZ: median depth of its
   * joints a moment ago (0 = unknown). steady: { prev, z, n } (prev: the joints of the last frame)
   * damps implausible depth jumps (the background next to a thin wrist, motion blur): such a
   * joint keeps its depth along its new ray unless the new depth holds for three frames. measured:
   * uidMap are the labels of this very frame; the arms are then measured on the person's own pixels
   * only, without that damping and without the bone lengths: thin, fast and often in front of the
   * body, their depth is right where the keypoint is, and the bone lengths would move a right depth
   * to a wrong one. (The skeleton made at once gets its arms from the mask in _arms.)
   */
  _lift(kp, depth, uidMap, uid, seen, J, UV, refZ = 0, steady = null, measured = false) {
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
      const arm = measured && k >= 7 && k <= 10;
      let d = arm ? this._depthNear(depth, u, v, uidMap, uid, ARM_WINDOW, true) : this._depthNear(depth, u, v, seen ? uidMap : null, uid);
      if (!d && arm) d = this._depthNear(depth, u, v, uidMap, uid, 8, true);
      if (!d) continue;
      // far in front of where the person was a moment ago: something (someone) in front of it
      if (refZ && d + INSET[k] * 1000 < refZ - HIDDEN) continue;
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
      let z = J[4 * k + 2] + INSET[k] * 1000;
      if (steady?.prev && steady.prev[4 * k + 3] && !(measured && k >= 7 && k <= 10)) {
        const zp = steady.prev[4 * k + 2];
        const lim = 150 + 0.05 * zp;
        if (Math.abs(z - zp) > lim) {
          if (steady.n[k] && Math.abs(z - steady.z[k]) < lim / 2) steady.n[k]++;
          else {
            steady.z[k] = z;
            steady.n[k] = 1;
          }
          if (steady.n[k] < 3) z = zp;
          else steady.n[k] = 0;
        } else steady.n[k] = 0;
      }
      J[4 * k] = rays[2 * i] * z;
      J[4 * k + 1] = rays[2 * i + 1] * z;
      J[4 * k + 2] = z;
    }
    if (steady) this._limbs(J, UV, steady, measured);
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
    // hands: beyond the wrist, along the forearm (their depth measured where they are)
    const at = measured ? (u, v) => this._depthNear(depth, u, v, uidMap, uid, ARM_WINDOW, true) : null;
    if (J[4 * 7 + 3] && J[4 * 9 + 3]) this._hand(J, UV, 7, 9, LH, at);
    if (J[4 * 8 + 3] && J[4 * 10 + 3]) this._hand(J, UV, 8, 10, RH, at);
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
   * The hand: beyond the wrist w along the forearm (from elbow e), into J/UV point `out`.
   * depthAt(u, v) -> mm or 0: its depth measured there, used if it fits the wrist.
   */
  _hand(J, UV, e, w, out, depthAt = null) {
    for (let j = 0; j < 3; j++) J[4 * out + j] = J[4 * w + j] + 0.45 * (J[4 * w + j] - J[4 * e + j]);
    J[4 * out + 3] = 1;
    const u = UV[3 * w] + 0.45 * (UV[3 * w] - UV[3 * e]);
    const v = UV[3 * w + 1] + 0.45 * (UV[3 * w + 1] - UV[3 * e + 1]);
    UV[3 * out] = u;
    UV[3 * out + 1] = v;
    UV[3 * out + 2] = 1;
    if (!depthAt || u < 0 || v < 0 || u > W - 1 || v > H - 1) return;
    const d = depthAt(u, v);
    if (!d || Math.abs(d + HAND_INSET - J[4 * w + 2]) > 250) return;
    const i = Math.round(v) * W + Math.round(u);
    const z = d + HAND_INSET;
    J[4 * out] = this.rays[2 * i] * z;
    J[4 * out + 1] = this.rays[2 * i + 1] * z;
    J[4 * out + 2] = z;
  }

  /**
   * Limbs: each elbow, wrist, knee and ankle must lie its bone's length from its parent joint. A
   * joint whose measured depth does not fit (the depth next to a thin limb is often the background
   * or the body behind it) moves along its ray to the point at that distance nearest to where it
   * was a moment ago. The lengths are learned per person from the measurements that fit. Arms
   * measured on the person's own pixels (`arms`) only teach their lengths.
   */
  _limbs(J, UV, st, arms = false) {
    const rays = this.rays;
    st.bones ??= LIMB_LENGTHS.slice();
    for (let b = 0; b < LIMBS.length; b++) {
      const [a, c] = LIMBS[b];
      if (!J[4 * a + 3] || !J[4 * c + 3]) continue;
      const L = st.bones[b];
      const px = J[4 * a];
      const py = J[4 * a + 1];
      const pz = J[4 * a + 2];
      const len = Math.hypot(J[4 * c] - px, J[4 * c + 1] - py, J[4 * c + 2] - pz);
      if (Math.abs(len - L) < 0.3 * L) {
        if (Math.abs(len - L) < 0.15 * L) st.bones[b] = 0.97 * L + 0.03 * len; // learn the length
        continue;
      }
      if (arms && b < 4) continue;
      // the ray through the joint's pixel: point = z * (rx, ry, 1)
      const i = Math.round(UV[3 * c + 1]) * W + Math.round(UV[3 * c]);
      const rx = this.rays[2 * i];
      const ry = this.rays[2 * i + 1];
      const rr = rx * rx + ry * ry + 1;
      // |z r - P| = L  ->  rr z² - 2 (r·P) z + |P|² - L² = 0
      const rp = rx * px + ry * py + pz;
      const disc = rp * rp - rr * (px * px + py * py + pz * pz - L * L);
      let z;
      if (disc <= 0) z = rp / rr; // the bone cannot reach the ray: the nearest point on it
      else {
        // of the two points at that distance: the one nearer to where the joint was a moment ago
        // (else nearer to its parent's depth; the measurement is what is in doubt)
        const z1 = (rp - Math.sqrt(disc)) / rr;
        const z2 = (rp + Math.sqrt(disc)) / rr;
        const m = st.prev && st.prev[4 * c + 3] ? st.prev[4 * c + 2] : pz;
        z = Math.abs(z1 - m) < Math.abs(z2 - m) ? z1 : z2;
      }
      J[4 * c] = rx * z;
      J[4 * c + 1] = ry * z;
      J[4 * c + 2] = z;
    }
  }

  /**
   * The skeleton of the current frame: its keypoints (followed by the flow) lifted with this frame's
   * depth, the person's own pixels of the last frame preferred; its body parts. Keypoints the flow
   * lost for a while do not count. A joint that cannot be placed this frame (no pose for a while,
   * the flow lost it, hidden) keeps its place, moved along with the person's pixels, until the
   * person is gone: the body parts stay complete while the pose model looks away.
   */
  _place(t) {
    if (!t.lifted || t.kpSeq === null) return false;
    const kp = this.kpScratch;
    kp.set(t.kp);
    for (let k = 0; k < 17; k++) if (t.lost[k] > MAX_LOST) kp[3 * k + 2] = 0;
    const J = this.jScratch;
    const U = this.uvScratch;
    t.steady ??= { prev: null, z: new Float32Array(17), n: new Uint8Array(17) };
    t.steady.prev = t.lifted ? t.joints : null;
    if (!this._lift(kp, this.lastDepth, this.prevUid, t.uid, t.pixels > 0, J, U, this._refZ(t), t.steady)) {
      J.fill(0);
      U.fill(0);
    }
    const P = t.joints;
    const PU = t.uv;
    const d3 = t.dpos ?? [0, 0, 0];
    const d2 = t.dc2 ?? [0, 0];
    const keep = Math.round(this.options.keepSeconds * this.options.fps);
    for (let k = 0; k < NJ; k++) {
      if (J[4 * k + 3]) t.jointAge[k] = 0;
      else if (P[4 * k + 3] && ++t.jointAge[k] <= keep) {
        for (let j = 0; j < 3; j++) J[4 * k + j] = P[4 * k + j] + d3[j];
        J[4 * k + 3] = 1;
        U[3 * k] = PU[3 * k] + d2[0];
        U[3 * k + 1] = PU[3 * k + 1] + d2[1];
        U[3 * k + 2] = PU[3 * k + 2];
      }
    }
    t.joints.set(J);
    t.uv.set(U);
    return this._capsules(t.joints, t.capsules);
  }

  // ---------- 2b. arms from the mask ----------

  /**
   * Depth (mm) at an image point from the pixels of person q in this frame's mask (owner): the
   * near cluster of a small window, 0 if it has too few.
   */
  _maskDepth(depth, u, v, q, r = ARM_WINDOW) {
    const w = this.window;
    const owner = this.owner;
    let n = 0;
    let lo = Infinity;
    const u0 = Math.max(0, Math.round(u) - r);
    const u1 = Math.min(W - 1, Math.round(u) + r);
    const v0 = Math.max(0, Math.round(v) - r);
    const v1 = Math.min(H - 1, Math.round(v) + r);
    for (let y = v0; y <= v1; y++) {
      for (let x = u0; x <= u1; x++) {
        const i = y * W + x;
        if (owner[i] !== q || !depth[i]) continue;
        w[n++] = depth[i];
        if (depth[i] < lo) lo = depth[i];
      }
    }
    if (n < 3) return 0;
    let m = 0;
    for (let k = 0; k < n; k++) if (w[k] <= lo + 120) w[m++] = w[k];
    return w.subarray(0, m).sort()[m >> 1];
  }

  /**
   * The arms of this frame from its mask (after the segmentation). Between two poses the optical
   * flow often loses a fast wrist (little texture, motion blur), and the arm then stays behind
   * while the mask has it. The person's pixels outside its trunk, head and legs that connect to a
   * shoulder are its arm; when it reaches out, its far end (from the shoulder) is the fingertips,
   * and wrist, hand and elbow are cut out of it at their distances from there. Such an arm is
   * used once a pose has confirmed it (the mask's arm of that pose's frame was where the pose had
   * it) and while it does not jump. Otherwise the arm stays as the flow has it, with this frame's
   * depth; a wrist the flow lost that lies off the body hangs down along it. Corrects joints, image
   * points and the followed keypoints (the flow goes on from there).
   */
  _arms(depth, persons, seq) {
    const rays = this.rays;
    const mk = this.options.minKeypoint;
    const GW = W >> 1;
    const GH = H >> 1;
    const side = (this.armSide ??= new Int8Array(GW * GH));
    const dist = (this.armDist ??= new Float32Array(GW * GH));
    const gq = (this.armQueue ??= new Int32Array(GW * GH));
    const tipDist = (this.armTipDist ??= new Float32Array(GW * GH));
    const cells = [(this.armCells0 ??= new Int32Array(GW * GH)), (this.armCells1 ??= new Int32Array(GW * GH))];
    const cellIndex = (g) => {
      const gy = (g / GW) | 0;
      return 2 * gy * W + 2 * (g - gy * GW);
    };
    for (let q = 0; q < persons.length; q++) {
      const t = persons[q];
      // hidden a moment ago, or too near (little depth, holes in the mask): the arms stay as they are
      if (!t.pixels || this._refZ(t) < ARM_NEAR) continue;
      const J = t.joints;
      const U = t.uv;
      const C = t.capsules;
      const kp = t.kp;
      const bones = t.steady?.bones ?? LIMB_LENGTHS;
      const sh = [5, 6].map((k) => (J[4 * k + 3] ? [J[4 * k], J[4 * k + 1], J[4 * k + 2]] : null));
      const arm = [null, null]; // per side: wrist, hand, elbow as [u, v, depth] (the elbow may be null)
      if (sh[0] || sh[1]) {
        // the box the arms can reach, within the person's box of the last frame (with a margin
        // for a fast arm)
        const reach = [0, 1].map((s) => bones[2 * s] + bones[2 * s + 1] + 250);
        let u0 = W;
        let v0 = H;
        let u1 = 0;
        let v1 = 0;
        for (let s = 0; s < 2; s++) {
          if (!sh[s]) continue;
          const k = 5 + s;
          const px = (reach[s] * 370) / Math.max(400, sh[s][2] - 0.7 * reach[s]);
          u0 = Math.min(u0, U[3 * k] - px);
          u1 = Math.max(u1, U[3 * k] + px);
          v0 = Math.min(v0, U[3 * k + 1] - px);
          v1 = Math.max(v1, U[3 * k + 1] + px);
        }
        if (t.bbox) {
          u0 = Math.max(u0, t.bbox[0] - 24);
          v0 = Math.max(v0, t.bbox[1] - 24);
          u1 = Math.min(u1, t.bbox[2] + 24);
          v1 = Math.min(v1, t.bbox[3] + 24);
        }
        const g0 = Math.max(0, Math.floor(u0 / 2));
        const g1 = Math.min(GW - 1, Math.ceil(u1 / 2));
        const h0 = Math.max(0, Math.floor(v0 / 2));
        const h1 = Math.min(GH - 1, Math.ceil(v1 / 2));
        // below this height (mm above the floor) a pixel is a leg: on the floor, and below the
        // hips of someone crouching or sitting (the knees come up to the shoulders)
        const f = this.floor ?? this.feetFloor;
        const fn = f ? f.normal : [0, -1, 0];
        const fd = f ? f.d * 1000 : 0;
        let low = -Infinity;
        if (f) {
          low = 120;
          if (J[4 * HC + 3]) {
            const hip = fn[0] * J[4 * HC] + fn[1] * J[4 * HC + 1] + fn[2] * J[4 * HC + 2] + fd;
            if (hip < 700) low = Math.max(low, hip + 100);
          }
        }
        let tail = this._armCandidates(depth, q, C, sh, reach, bones, g0, g1, h0, h1, low, fn, fd);
        // each arm: the candidates connected to its shoulder's seeds without a depth jump
        const o = this.options;
        const nc = [0, 0];
        let head = 0;
        while (head < tail) {
          const g = gq[head++];
          const s = side[g] - 3;
          cells[s][nc[s]++] = g;
          const gy = (g / GW) | 0;
          const gx = g - gy * GW;
          const di = depth[2 * gy * W + 2 * gx];
          const tol = 2 * (o.joinMargin + o.joinSlope * di);
          for (let n = 0; n < 4; n++) {
            const nx = gx + (n === 0 ? -1 : n === 1 ? 1 : 0);
            const ny = gy + (n === 2 ? -1 : n === 3 ? 1 : 0);
            if (nx < g0 || nx > g1 || ny < h0 || ny > h1) continue;
            const h = ny * GW + nx;
            if (side[h] !== s + 1) continue;
            const dj = depth[2 * ny * W + 2 * nx];
            if (dj - di > tol || di - dj > tol) continue;
            side[h] = s + 3;
            gq[tail++] = h;
          }
        }
        for (let s = 0; s < 2; s++) {
          const n = nc[s];
          const list = cells[s];
          if (n < 12) continue;
          let dmax = 0;
          for (let c = 0; c < n; c++) dmax = Math.max(dmax, dist[list[c]]);
          // the hand reaches out: farther from the shoulder than the elbow could be
          if (dmax < bones[2 * s] + 0.5 * bones[2 * s + 1]) continue;
          // mean u, v, depth of the arm's cells whose key lies in [a, b]
          const slice = (key, a, b) => {
            let su = 0;
            let sv = 0;
            let sd = 0;
            let m = 0;
            for (let c = 0; c < n; c++) {
              const g = list[c];
              if (key[g] < a || key[g] > b) continue;
              const i = cellIndex(g);
              su += i % W;
              sv += (i / W) | 0;
              sd += depth[i];
              m++;
            }
            return m >= 3 ? [su / m, sv / m, sd / m] : null;
          };
          const tip = slice(dist, dmax - 40, Infinity);
          if (!tip) continue;
          const ti = Math.round(tip[1]) * W + Math.round(tip[0]);
          const tx = rays[2 * ti] * tip[2];
          const ty = rays[2 * ti + 1] * tip[2];
          for (let c = 0; c < n; c++) {
            const g = list[c];
            const i = cellIndex(g);
            const d = depth[i];
            const dx = rays[2 * i] * d - tx;
            const dy = rays[2 * i + 1] * d - ty;
            tipDist[g] = Math.sqrt(dx * dx + dy * dy + (d - tip[2]) * (d - tip[2]));
          }
          const w = slice(tipDist, WRIST_TIP - 20, WRIST_TIP + 20);
          const h = slice(tipDist, HAND_TIP - 20, HAND_TIP + 20);
          if (!w || !h) continue;
          const e = slice(tipDist, WRIST_TIP + bones[2 * s + 1] - 20, WRIST_TIP + bones[2 * s + 1] + 20);
          arm[s] = { w, h, e };
        }
      }
      // remembered: the next pose tells whether the mask's arms were right in this frame (_addKey)
      t.armHist ??= [];
      t.armHist.push({ seq, w: arm.map((a) => a && a.w) });
      if (t.armHist.length > KEEP_ARMS) t.armHist.shift();
      t.armTrust ??= [0, 0];
      t.armLast ??= [null, null];
      const place = (k, p, inset) => {
        const i = Math.round(p[1]) * W + Math.round(p[0]);
        const z = p[2] + inset;
        J[4 * k] = rays[2 * i] * z;
        J[4 * k + 1] = rays[2 * i + 1] * z;
        J[4 * k + 2] = z;
        J[4 * k + 3] = 1;
        U[3 * k] = p[0];
        U[3 * k + 1] = p[1];
        t.jointAge[k] = 0;
        if (k >= 17) {
          U[3 * k + 2] = 1;
          return;
        }
        U[3 * k + 2] = Math.max(U[3 * k + 2], mk);
        kp[3 * k] = p[0];
        kp[3 * k + 1] = p[1];
        kp[3 * k + 2] = Math.max(kp[3 * k + 2], mk);
        t.lost[k] = 0;
      };
      // the depth of a joint from this frame's mask, where it is
      const measured = (k) => {
        const u = U[3 * k];
        const v = U[3 * k + 1];
        if (!J[4 * k + 3] || !(u >= 0 && v >= 0 && u <= W - 1 && v <= H - 1)) return;
        const d = this._maskDepth(depth, u, v, q);
        if (!d) return;
        const i = Math.round(v) * W + Math.round(u);
        const z = d + INSET[k] * 1000;
        J[4 * k] = rays[2 * i] * z;
        J[4 * k + 1] = rays[2 * i + 1] * z;
        J[4 * k + 2] = z;
      };
      for (let s = 0; s < 2; s++) {
        const a = arm[s];
        const ke = 7 + s;
        const kw = 9 + s;
        const kh = LH + s;
        if (a) {
          // a mask's arm that jumps from one frame to the next is something else (a leg, the
          // hair) until the next pose says otherwise
          const i = Math.round(a.w[1]) * W + Math.round(a.w[0]);
          const p = [rays[2 * i] * a.w[2], rays[2 * i + 1] * a.w[2], a.w[2]];
          const last = t.armLast[s];
          if (last && seq - last.seq <= 2 && Math.hypot(p[0] - last.p[0], p[1] - last.p[1], p[2] - last.p[2]) > ARM_JUMP) t.armTrust[s] = 0;
          t.armLast[s] = { seq, p };
        } else t.armLast[s] = null;
        if (a && t.armTrust[s]) {
          place(kw, a.w, INSET[kw] * 1000);
          place(kh, a.h, HAND_INSET);
          // the elbow where the mask has it, if it fits the bones
          const S = sh[s];
          const E = a.e;
          let ok = false;
          if (E && S) {
            const i = Math.round(E[1]) * W + Math.round(E[0]);
            const z = E[2] + INSET[ke] * 1000;
            const ex = rays[2 * i] * z;
            const ey = rays[2 * i + 1] * z;
            const lu = Math.hypot(ex - S[0], ey - S[1], z - S[2]);
            const lf = Math.hypot(ex - J[4 * kw], ey - J[4 * kw + 1], z - J[4 * kw + 2]);
            ok = Math.abs(lu - bones[2 * s]) < 0.4 * bones[2 * s] && Math.abs(lf - bones[2 * s + 1]) < 0.4 * bones[2 * s + 1];
          }
          if (ok) place(ke, E, INSET[ke] * 1000);
          else measured(ke);
          continue;
        }
        measured(ke);
        measured(kw);
        // the flow lost the wrist and it lies off the body: the arm is not out (the mask would
        // have it), it hangs down along the body
        const S = sh[s];
        if (S && J[4 * kw + 3] && J[4 * SC + 3] && J[4 * HC + 3] && t.lost[kw] && !this._maskDepth(depth, U[3 * kw], U[3 * kw + 1], q, 6)) {
          const dir = [0, 1, 2].map((j) => J[4 * HC + j] - J[4 * SC + j]);
          const out = [0, 1, 2].map((j) => S[j] - J[4 * SC + j]);
          const ld = Math.hypot(...dir) || 1;
          const lo = Math.hypot(...out) || 1;
          for (let j = 0; j < 3; j++) dir[j] = dir[j] / ld + (0.15 * out[j]) / lo;
          const l = Math.hypot(...dir);
          for (const [k, len] of [[ke, bones[2 * s]], [kw, bones[2 * s] + bones[2 * s + 1]]]) {
            const P = [0, 1, 2].map((j) => S[j] + (len * dir[j]) / l);
            const [u, v] = this._project(P[0], P[1], P[2], U[3 * (5 + s)], U[3 * (5 + s) + 1]);
            if (u < 0 || v < 0 || u > W - 1 || v > H - 1) continue;
            const d = this._maskDepth(depth, u, v, q);
            place(k, [u, v, d || P[2] - INSET[k] * 1000], INSET[k] * 1000);
          }
        }
        if (J[4 * ke + 3] && J[4 * kw + 3]) this._hand(J, U, ke, kw, kh, (u, v) => this._maskDepth(depth, u, v, q));
      }
      this._capsules(J, C);
    }
  }

  /**
   * _arms: the candidates for the arms in the grid (every second row and column) of box g0..g1,
   * h0..h1: the person's pixels within reach of a shoulder, above `low` (mm over the floor
   * fn·p + fd), outside the other body parts. armSide = 1, 2 for the left, right arm (the nearer
   * shoulder), 3, 4 for the seeds on the upper arm next to it (also in armQueue); armDist = the
   * distance from that shoulder (mm). Returns the number of seeds.
   */
  _armCandidates(depth, q, C, sh, reach, bones, g0, g1, h0, h1, low, fn, fd) {
    const GW = W >> 1;
    const side = this.armSide;
    const dist = this.armDist;
    const gq = this.armQueue;
    const owner = this.owner;
    const rays = this.rays;
    const nx = fn[0];
    const ny = fn[1];
    const nz = fn[2];
    const sx0 = sh[0] ? sh[0][0] : 0;
    const sy0 = sh[0] ? sh[0][1] : 0;
    const sz0 = sh[0] ? sh[0][2] : -1e9;
    const sx1 = sh[1] ? sh[1][0] : 0;
    const sy1 = sh[1] ? sh[1][1] : 0;
    const sz1 = sh[1] ? sh[1][2] : -1e9;
    const r0 = reach[0] * reach[0];
    const r1 = reach[1] * reach[1];
    const seed0 = (0.75 * bones[0] + 100) ** 2;
    const seed1 = (0.75 * bones[2] + 100) ** 2;
    let tail = 0;
    for (let gy = h0; gy <= h1; gy++) {
      for (let gx = g0; gx <= g1; gx++) {
        const g = gy * GW + gx;
        side[g] = 0;
        const i = 2 * gy * W + 2 * gx;
        if (owner[i] !== q) continue;
        const d = depth[i];
        if (!d) continue;
        const x = rays[2 * i] * d;
        const y = rays[2 * i + 1] * d;
        const dl = (x - sx0) * (x - sx0) + (y - sy0) * (y - sy0) + (d - sz0) * (d - sz0);
        const dr = (x - sx1) * (x - sx1) + (y - sy1) * (y - sy1) + (d - sz1) * (d - sz1);
        const s = dl <= dr ? 0 : 1;
        const ds = s ? dr : dl;
        if (ds > (s ? r1 : r0) || nx * x + ny * y + nz * d + fd < low) continue;
        let core = false;
        for (let c = 0; c < CORE_PARTS.length && !core; c++) {
          const o = CAP * CORE_PARTS[c];
          if (C[o + 8] && seg(C, CORE_PARTS[c], x, y, d) <= C[o + 6]) core = true;
        }
        if (core) continue;
        side[g] = s + 1;
        dist[g] = Math.sqrt(ds);
        if (ds < (s ? seed1 : seed0)) {
          side[g] = s + 3;
          gq[tail++] = g;
        }
      }
    }
    return tail;
  }

  /** Image point of a camera point (mm), the rays linearized around pixel (u0, v0). */
  _project(x, y, z, u0, v0) {
    const r = this.rays;
    const uc = Math.min(W - 2, Math.max(1, Math.round(u0)));
    const vc = Math.min(H - 2, Math.max(1, Math.round(v0)));
    const i = vc * W + uc;
    const fx = 2 / (r[2 * (i + 1)] - r[2 * (i - 1)]);
    const fy = 2 / (r[2 * (i + W) + 1] - r[2 * (i - W) + 1]);
    return [uc + (x / z - r[2 * i]) * fx, vc + (y / z - r[2 * i + 1]) * fy];
  }

  /** Median depth (mm) of a person's joints in the last frame, 0 if none. */
  _refZ(t) {
    if (!t.lifted) return 0;
    const zs = [];
    for (let k = 0; k < 17; k++) if (t.joints[4 * k + 3]) zs.push(t.joints[4 * k + 2]);
    if (!zs.length) return 0;
    zs.sort((a, b) => a - b);
    return zs[zs.length >> 1];
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
    // seeds 2: the persons' pixels of the previous frame where the surface is still there, within
    // the box around the person's reach (cheap; what a person touched and left is cleaned up by the
    // background learning, see _learn)
    const wide = reachBoxes.map((b) => [b[0] - near, b[1] - near, b[2] - near, b[3] + near, b[4] + near, b[5] + near]);
    const prevList = this.prevList;
    for (let c = 0; c < this.prevCount; c++) {
      const i = prevList[c];
      if (owner[i] !== -1) continue;
      const q = index[prevUid[i]];
      if (q < 0) continue;
      const d = depth[i];
      const e = prevDepth[i];
      if (d < minDepth || d > maxDepth || (d > e ? d - e : e - d) > 60 + 0.03 * e) continue;
      const bd = bg[i];
      if (bd && (d > bd ? d - bd : bd - d) <= bgMargin + bgSlope * bd) continue;
      const x = rays[2 * i] * d;
      const y = rays[2 * i + 1] * d;
      if (f && fx * x + fy * y + fz * d + fd < 0) continue;
      const wb = wide[q];
      if (x < wb[0] || x > wb[3] || y < wb[1] || y > wb[4] || d < wb[2] || d > wb[5]) continue;
      if (others[q].length && foreign(q, x, y, d)) continue;
      owner[i] = q;
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

  /** nearPerson = 1 inside the persons' boxes (with a margin). */
  _personBoxes(persons) {
    const near = this.nearPerson;
    near.fill(0);
    for (const t of persons) {
      if (!t.bbox || !t.pos) continue;
      const pad = Math.ceil((250 * 370) / Math.max(500, t.pos[2]));
      const u0 = Math.max(0, t.bbox[0] - pad);
      const u1 = Math.min(W - 1, t.bbox[2] + pad);
      for (let v = Math.max(0, t.bbox[1] - pad), v1 = Math.min(H - 1, t.bbox[3] + pad); v <= v1; v++) near.fill(1, v * W + u0, v * W + u1 + 1);
    }
  }

  /**
   * Learns the background where no person is: what stays in place (see learnFrames & co.). Close
   * to a person, an unknown background takes as long as something new (the person's sleeve or
   * dress that the segmentation missed must not become background while they stand still).
   */
  _learn(depth, persons, active) {
    const { bgMargin, bgSlope, learnFrames, farFrames, nearFrames } = this.options;
    const still = (this.still ??= new Uint16Array(N)); // visits a person's pixel has kept its depth
    // every pixel is visited every second frame (half the work): counts are in visits
    const stillFrames = Math.round((this.options.staticSeconds * this.options.fps) / 2);
    const learnV = Math.ceil(learnFrames / 2);
    const farV = Math.ceil(farFrames / 2);
    const nearV = Math.ceil(nearFrames / 2);
    const rays = this.rays;
    const prev = this.prevDepth;
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
    for (let i = this.frame & 1; i < N; i += 2) {
      const q = owner[i];
      if (q !== -1) {
        count[i] = 0;
        // a person's pixel that has not moved for long: if it lies outside the person's body parts
        // it is a thing the person touched (the desk edge, the armrest), learned as background
        const dp = depth[i];
        const e = prev[i];
        if (q < 0 || !dp || !e) continue; // no measurement: the count waits
        if ((dp > e ? dp - e : e - dp) > 20 + 0.01 * e) {
          still[i] = 0;
          continue;
        }
        if (++still[i] < stillFrames) continue;
        still[i] = 0;
        if (fit(active[q].capsules, 0, rays[2 * i] * dp, rays[2 * i + 1] * dp, dp, true) < 0) bg[i] = dp;
        continue;
      }
      const d = depth[i] || FAR;
      const b = bg[i];
      if (b && (d > b ? d - b : b - d) <= bgMargin + bgSlope * b) {
        if (b !== FAR) bg[i] = b + Math.round((d - b) / 8);
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
      // a surface that stops answering may just be noisy: as slow as something new
      const need = !b ? (near[i] ? nearV : learnV) : cand[i] === FAR || cand[i] < b ? nearV : farV;
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

    // persons without a pose for too long are gone; the others get a slot once confirmed (enough
    // poses, one of them on measured depth)
    const lost = Math.round(o.lostSeconds * o.fps);
    const keep = Math.round(o.keepSeconds * o.fps);
    this.tracks = this.tracks.filter((t) => this.frame - t.lastPose <= (t.pixels ? keep : lost));
    if (o.mode === 'skeleton') for (const t of this.tracks) t.pixels = 0;
    const used = new Set(this.tracks.filter((t) => t.slot).map((t) => t.slot));
    for (const t of this.tracks) {
      if (!t.slot && t.poses >= o.confirmPoses && t.solid) {
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
    const masks = o.mode !== 'skeleton';
    if (masks) {
      this._segment(depth, active);
      this._arms(depth, active, seq);
    } else this.owner.fill(-1);

    // labels, statistics, the list of person pixels and the seeds of the next frame: one pass in
    // raster order (memory in order is several times faster than in the order the regions grew)
    const stats = active.map(() => ({ all: 0, n: 0, area: 0, sx: 0, sy: 0, sz: 0, su: 0, sv: 0, u0: W, v0: H, u1: -1, v1: -1, hMin: Infinity, hMax: -Infinity }));
    const f = this.floor ?? this.feetFloor;
    const upx = f ? f.normal[0] : 0;
    const upy = f ? f.normal[1] : -1;
    const upz = f ? f.normal[2] : 0;
    const up0 = f ? f.d * 1000 : 0;
    const rays = this.rays;
    const pa = this.pixArea;
    const owner = this.owner;
    const prevUid = this.prevUid;
    const prevList = this.prevList;
    for (let c = 0; c < this.prevCount; c++) prevUid[prevList[c]] = 0;
    const slots = active.map((t) => t.slot);
    const uids = active.map((t) => t.uid);
    let k = 0;
    let pc = 0;
    for (let i = 0; i < N; i++) {
      const q = owner[i];
      if (q < 0) {
        labels[i] = 0;
        masked[i] = 0;
        continue;
      }
      const d = depth[i];
      const slot = slots[q];
      labels[i] = slot;
      masked[i] = slot ? d : 0;
      if (slot) indices[k++] = i;
      prevUid[i] = uids[q];
      prevList[pc++] = i;
      const s = stats[q];
      s.all++;
      if (pc & 1) continue; // the statistics from every second pixel
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
    this.prevCount = pc;
    const stale = Math.round(o.staleSeconds * o.fps);
    for (const t of this.tracks) {
      const q = active.indexOf(t);
      if (masks) this._update(t, q >= 0 ? stats[q] : null);
      else this._updateSkeleton(t, q >= 0);
      t.visible = masks ? t.pixels > 0 : q >= 0 && this.frame - t.lastPose <= stale;
    }
    // the background is learned once the pose model runs (before, a person could become part of it)
    if (masks && this.poseResults) this._learn(depth, this.tracks, active);
    else if (!masks) this._personBoxes(this.tracks); // keeps the persons out of the floor estimate
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
    if (!s || s.n === 0 || s.all === 0) {
      t.pixels = 0;
      t.dpos = null;
      t.dc2 = null;
      return;
    }
    const c = [s.sx / s.n, s.sy / s.n, s.sz / s.n];
    if (t.pos && t.pixels) {
      for (let j = 0; j < 3; j++) t.vel[j] = 0.7 * t.vel[j] + 0.3 * (c[j] - t.pos[j]);
    }
    t.dpos = t.pos && t.pixels ? [c[0] - t.pos[0], c[1] - t.pos[1], c[2] - t.pos[2]] : null;
    t.pos = c;
    const c2 = [s.su / s.n, s.sv / s.n];
    t.dc2 = t.c2 && t.pixels ? [c2[0] - t.c2[0], c2[1] - t.c2[1]] : null;
    t.c2 = c2;
    t.pixels = s.all;
    t.area = (s.area * s.all) / s.n * 1e-6; // sampled on every second pixel
    t.bbox = [s.u0, s.v0, s.u1, s.v1];
    t.hMin = s.hMin;
    t.hMax = s.hMax;
  }

  /** Skeleton mode: position, motion, box and heights from the joints (there are no pixels). */
  _updateSkeleton(t, placed) {
    t.pixels = 0;
    t.area = 0;
    if (!placed) {
      t.dpos = null;
      t.dc2 = null;
      return;
    }
    const J = t.joints;
    const U = t.uv;
    let pick = [5, 6, 11, 12].filter((k) => J[4 * k + 3]);
    if (!pick.length) pick = [...Array(NJ).keys()].filter((k) => J[4 * k + 3]);
    if (!pick.length) return;
    const c = [0, 1, 2].map((j) => pick.reduce((a, k) => a + J[4 * k + j], 0) / pick.length);
    const c2 = [0, 1].map((j) => pick.reduce((a, k) => a + U[3 * k + j], 0) / pick.length);
    if (t.pos) for (let j = 0; j < 3; j++) t.vel[j] = 0.7 * t.vel[j] + 0.3 * (c[j] - t.pos[j]);
    t.dpos = t.pos ? [c[0] - t.pos[0], c[1] - t.pos[1], c[2] - t.pos[2]] : null;
    t.dc2 = t.c2 ? [c2[0] - t.c2[0], c2[1] - t.c2[1]] : null;
    t.pos = c;
    t.c2 = c2;
    const f = this.floor ?? this.feetFloor;
    const upx = f ? f.normal[0] : 0;
    const upy = f ? f.normal[1] : -1;
    const upz = f ? f.normal[2] : 0;
    const up0 = f ? f.d * 1000 : 0;
    let u0 = W;
    let v0 = H;
    let u1 = 0;
    let v1 = 0;
    let hMin = Infinity;
    let hMax = -Infinity;
    for (let k = 0; k < NJ; k++) {
      if (!J[4 * k + 3]) continue;
      u0 = Math.min(u0, U[3 * k]);
      v0 = Math.min(v0, U[3 * k + 1]);
      u1 = Math.max(u1, U[3 * k]);
      v1 = Math.max(v1, U[3 * k + 1]);
      const h = upx * J[4 * k] + upy * J[4 * k + 1] + upz * J[4 * k + 2] + up0;
      hMin = Math.min(hMin, h);
      hMax = Math.max(hMax, h);
    }
    const pu = 0.1 * (u1 - u0) + 4;
    const pv = 0.06 * (v1 - v0) + 4;
    t.bbox = [Math.max(0, Math.round(u0 - pu)), Math.max(0, Math.round(v0 - pv)), Math.min(W - 1, Math.round(u1 + pu)), Math.min(H - 1, Math.round(v1 + pv))];
    // the joints are inside the body: the top of the head lies above its center, the soles below the ankles
    t.hMin = hMin - 60;
    t.hMax = hMax + (J[4 * HEAD + 3] ? 110 : 0);
  }

  /**
   * joints, keypoints, head and ground point of a skeleton for the person list: J/U as _lift makes
   * them, kp the keypoints (u, v, conf), pos/hMin of the person's pixels (without ankles or floor).
   */
  _skeletonOut(J, U, kp, lost, pos, hMin, visible) {
    const f = this.floor ?? this.feetFloor;
    const mm = (p) => p.map((x) => Math.round(x));
    let ground;
    // where it stands: below the ankles (else below the center)
    const ankles = [15, 16].filter((k) => J[4 * k + 3]);
    const base = ankles.length ? [0, 1, 2].map((j) => ankles.reduce((a, k) => a + J[4 * k + j], 0) / ankles.length) : pos;
    if (f) {
      const h = f.normal[0] * base[0] + f.normal[1] * base[1] + f.normal[2] * base[2] + f.d * 1000;
      ground = [base[0] - f.normal[0] * h, base[1] - f.normal[1] * h, base[2] - f.normal[2] * h];
    } else {
      // no floor known: straight below the center, at the lowest point of the person
      ground = [pos[0], -hMin, pos[2]];
    }
    const joints = [];
    const keypoints = [];
    for (let k = 0; k < 17; k++) {
      const ok = J[4 * k + 3] && visible;
      joints.push([Math.round(J[4 * k]), Math.round(J[4 * k + 1]), Math.round(J[4 * k + 2]), ok ? Math.round(U[3 * k + 2] * 100) / 100 : 0]);
      const conf = lost && lost[k] > MAX_LOST ? 0 : kp[3 * k + 2];
      keypoints.push([Math.round(kp[3 * k] * 10) / 10, Math.round(kp[3 * k + 1] * 10) / 10, Math.round(conf * 100) / 100]);
    }
    const extra = [];
    const extraKeypoints = [];
    for (const k of [SC, HC, HEAD, LH, RH]) {
      const ok = J[4 * k + 3] && visible;
      extra.push([Math.round(J[4 * k]), Math.round(J[4 * k + 1]), Math.round(J[4 * k + 2]), ok ? Math.round(Math.max(0.01, U[3 * k + 2]) * 100) / 100 : 0]);
      extraKeypoints.push([Math.round(U[3 * k] * 10) / 10, Math.round(U[3 * k + 1] * 10) / 10, ok ? Math.round(Math.max(0.01, U[3 * k + 2]) * 100) / 100 : 0]);
    }
    const head = J[4 * HEAD + 3] ? [J[4 * HEAD], J[4 * HEAD + 1], J[4 * HEAD + 2]] : pos;
    return { joints, keypoints, extra, extraKeypoints, head: mm(head), ground: mm(ground) };
  }

  /**
   * The skeletons of a result of an earlier frame `seq`, now that the pose of a later frame is in:
   * keypoints interpolated between the poses before and after it, lifted to 3D with that frame's
   * depth and labels (delayed output: the masks were made at once, the skeletons are made exact
   * once the later pose arrived). Changes joints, keypoints, head and ground in result.persons.
   */
  finalize(result, seq, depth, labels) {
    const mk = this.options.minKeypoint;
    const kp = this.kpScratch;
    const J = this.jScratch;
    const U = this.uvScratch;
    for (const p of result.persons) {
      if (!p.visible) continue;
      const t = this.tracks.find((x) => x.id === p.id);
      if (!t) continue;
      let k0 = null;
      let k1 = null;
      for (const k of t.keys) {
        if (k.seq <= seq) k0 = k;
        else if (!k1) k1 = k;
      }
      if (!k0 || (!k1 && k0.seq !== seq)) continue; // no pose after it: the skeleton made at once stays
      if (k0.seq === seq || !k1) kp.set(k0.kp);
      else {
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
      }
      const zs = p.joints.filter((j) => j[3] > 0).map((j) => j[2]).sort((x, y) => x - y);
      const refZ = zs.length ? zs[zs.length >> 1] : 0;
      t.steadyFinal ??= { prev: null, z: new Float32Array(17), n: new Uint8Array(17), joints: new Float32Array(NJ * 4) };
      if (!this._lift(kp, depth, labels, p.slot, true, J, U, refZ, t.steadyFinal, true)) continue;
      // joints that do not lift in that frame keep the ones made at once
      for (let k = 0; k < 17; k++) {
        if (J[4 * k + 3] || !p.joints[k][3]) continue;
        J[4 * k] = p.joints[k][0];
        J[4 * k + 1] = p.joints[k][1];
        J[4 * k + 2] = p.joints[k][2];
        J[4 * k + 3] = 1;
        U[3 * k + 2] = p.joints[k][3];
      }
      t.steadyFinal.joints.set(J);
      t.steadyFinal.prev = t.steadyFinal.joints;
      const pos = p.centroid;
      const o = this._skeletonOut(J, U, kp, null, pos, -(p.ground?.[1] ?? 0), true);
      p.joints = o.joints;
      p.keypoints = o.keypoints;
      p.extra = o.extra;
      p.extraKeypoints = o.extraKeypoints;
      p.head = o.head;
      p.ground = o.ground;
    }
  }

  _describe(t) {
    const f = this.floor ?? this.feetFloor;
    const mm = (p) => p.map((x) => Math.round(x));
    const visible = !!t.visible;
    const { joints, keypoints, extra, extraKeypoints, head, ground } = this._skeletonOut(t.joints, t.uv, t.kp, t.lost, t.pos, t.hMin, visible);
    const fps = this.options.fps;
    return {
      id: t.id,
      slot: t.slot,
      visible,
      age: (this.frame - (t.since ?? this.frame)) / fps,
      score: Math.round((t.score ?? 0) * 100) / 100,
      pixels: t.pixels,
      area: Math.round((t.area ?? 0) * 1000) / 1000,
      centroid: mm(t.pos),
      head,
      ground,
      height: Math.round(f ? t.hMax : t.hMax - t.hMin) / 1000,
      velocity: mm(t.vel.map((x) => x * fps)),
      bbox: t.bbox ?? [0, 0, 0, 0],
      joints,
      keypoints,
      extra,
      extraKeypoints,
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
      const skel = this.options.mode === 'skeleton';
      this._samples ??= new Float32Array(3 * Math.ceil(N / 16 + 64));
      const S = this._samples;
      let n = 0;
      for (let v = 2; v < H; v += 4) {
        for (let u = 2; u < W; u += 4) {
          const i = v * W + u;
          const d = depth[i];
          if (owner[i] !== -1 || d < 400 || d > 7000 || (skel && this.nearPerson[i])) continue;
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
