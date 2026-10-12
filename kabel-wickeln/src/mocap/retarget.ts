// Retargeting: a recorded take (take.ts) moves one of our people (src/people/cast.ts), whatever their
// proportions. The result is a choreography like every other: `rigAt(t)` gives a rig.ts Rig for the
// scene time t, and RigTrack solves its arms once for bake and scene alike (the same source of truth
// as the hand-keyed shots: fund-ik-pov-final.md).
//
//   const take = readTakeSync('mocap/takes/p1.coil.teach_t1.json.gz')     // Node (bake)
//   const take = (yield loadTake('/mocap/takes/p1.coil.teach_t1.json.gz'))  // scene
//   const mc = new Mocap(take, NOOR, { pos: [0, 0], yaw: 0, from: 1.5, to: 9, at: 0 }, { holds })
//   const track = mc.track()            // a RigTrack: track.pose(t) in the bake (every substep) and the scene
//   mc.holding(t, 1)                    // the right hand's hold at t (null = free): then
//   pose.body.arms[1].grip              // is the cable frame for the simulation (PinchSpec.roll = 0)
//
// What is taken from the recording, and how it fits a person of other proportions:
//   root      the pelvis over the floor; the way walked is scaled by the ratio of the leg lengths
//             about the anchor. The facing from the hips' and the shoulders' lines (only as far as
//             they lie across the sensor's view: seen from the side, depth decides them), the face
//             and the feet, outliers dropped; the plan's sensor direction as a last hint. The pelvis
//             height from the recorded knee bend over the figure's feet, blended with the ratio of
//             the standing pelvis heights (standing stays standing, a squat stays a squat)
//   spine     lean and sideways bend from pelvis → middle of the shoulders (the clavicles' own lift
//             and reach taken out), the chest's twist from the shoulders' line (people/rig.ts core)
//   head      where the face looks (nose, eyes, ears fitted); the look point is solved against the
//             rig's own head (Rig.look)
//   legs      ankles relative to the pelvis (scaled), the foot's direction (heel → toes), the knee's
//             direction as the leg IK's pole (kept in front, within ±45° of the foot), the knee
//             never bent past 155°; feet that stand are locked to the floor (no sliding) and never
//             go through it
//   arms      the wrist relative to its shoulder in the chest's frame (measured from the shoulders'
//             middle: the hips are often hidden behind hands and ring), scaled by the ratio of the
//             arm lengths; two hands close together keep their real offset (a coil held in both
//             hands, a clap: hands that meet still meet); the elbow's direction as the IK's pole;
//             the hand's orientation (fitted to wrist, thumb base and knuckles) as orientation
//             wishes: the fingers' direction by its confidence, where the palm faces only when the
//             knuckles' line is sure (it is the noisy part); finger curls, the thumb tip and its last
//             bone as the hand's shape. The arm IK (people/ik.ts) keeps every joint in its range.
// Poor data: every signal carries its confidence; frames with little confidence take the value of
// their sure neighbours (a weighted window), or a fallback (relaxed hand, hanging arm, the face
// along the chest). Weak hand orientation fades the wishes out (the IK picks a comfortable hand,
// continuing the forearm), so the hand turns smoothly instead of following noise. A hip or shoulder
// that is hidden (the far side in a side view) is put behind the seen one; a wrist further from its
// shoulder than the arm is long does not count.
//
// Placement (Placement): position and facing in the scene, the played part of the take (s relative
// to the clap), scene time and speed or a time warp, mirroring (left-handed variants). Hand grips
// for the cable simulation: `holds` turn a hand into a rig.ts grip (pinch, fist, coil) at the frame
// the recorded hand gives; fingers blend into the grip's shape before it starts.
//
// Conventions as in src/people: metres, y up, a person with yaw 0 faces −z. Pure TypeScript.

import { V3, add, across, clamp, cross, dot, len, lerp, madd, mix3, norm, quatFromCols, scale, smooth, sub, turn } from '../people/math';
import { PersonSpec, Pose, UP } from '../people/people';
import { Grip, HandRig, Hold, LegRig, Rig, RigTrack, eyesOfRig, gripShape, rigPose, stand } from '../people/rig';
import type { AxisGoal } from '../people/ik';
import { Take } from './take';
import { SIDE, TAKE_JOINTS, takeJointsOf } from './joints';
import { BodyMeasure, elbowPole, forwardOf, horizontal, leanBendOf, measureBody, measureFoot, measureHand, rightOf, twistOf, yawBetween, yawOf } from './body';

const NJ = TAKE_JOINTS.length;
/** look points this far away (m): only their direction counts */
const LOOK_FAR = 100;

// ================================================================ the options

/** where and when a take plays in a scene */
export interface Placement {
  /** the performer's pelvis at the anchor lands here (x, z; default [0, 0]) */
  pos?: [number, number];
  /** and faces this way (rig yaw: 0 = towards −z, + turns right; default 0) */
  yaw?: number;
  /** take time of the anchor (s relative to the clap; default: `from`) */
  anchor?: number;
  /** the played part of the take (s relative to the clap; default: all of it) */
  from?: number;
  to?: number;
  /** the scene time at which `from` plays (default 0) */
  at?: number;
  /** playback speed (default 1; 0.25 = slow motion) */
  speed?: number;
  /** a time warp instead of at/speed: [scene time, take time relative to the clap] pairs (linear in between, held outside) */
  warp?: [number, number][];
  /** the mirror image: left and right swapped (a left-handed variant) */
  mirror?: boolean;
  /** the way the performer walks: scaled with the legs (default) or as recorded */
  travel?: 'scaled' | 'recorded';
  /**
   * instead of pos/yaw/anchor/mirror: the take's WORLD → scene as a 4 × 4 matrix, row-major, mm
   * (e.g. the inverse of a synthetic truth's rig_to_world, to compare with the original motion)
   */
  matrix?: number[];
}

/** a hand that holds the cable for a while (take times, s relative to the clap) */
export interface HoldSpec {
  /** the recording's hand (with Placement.mirror the figure's other hand holds) */
  side: 0 | 1 | 'left' | 'right';
  from: number;
  to: number;
  hold: Hold;
  /** what it holds, m (cable or bundle radius; default 3.2 mm) */
  radius?: number;
  /** how freely the hand turns about the cable (rig.ts HandRig.free; default from the hand data's confidence: sure 0.2 … unsure 1) */
  free?: number;
  /** the cable's direction (scene; or a function of the take time) instead of the one the recorded hand gives (needed when the recording has no hand points) */
  along?: V3 | ((tau: number) => V3);
  /** passed on to the HandRig: open, wrap, roll, cross, thumbAlong, thumbTo, thumbWeight, thumbLift */
  rig?: Partial<HandRig>;
  /** seconds over which the fingers blend into the grip's shape before and out of it after (default 0.2) */
  blend?: number;
}

export interface RetargetOptions {
  /**
   * 0 = hands relative to the shoulders, scaled to the figure (default); 1 = where the recorded
   * hands were in the room (a table, things on the floor); or a function of the take time
   */
  handsWorld?: number | ((tau: number) => number);
  /** two hands closer than [near, far] (m) keep their recorded offset unscaled (fully below near; default [0.25, 0.6]; [0, 0] = never) */
  together?: [number, number];
  holds?: HoldSpec[];
  /** lock standing feet to the floor (default true) */
  lockFeet?: boolean;
  /** extra smoothing of the positions, s (Gaussian σ; default 0: auswerten.py already smooths) */
  smooth?: number;
  /** solve rate of the arms (RigTrack, default 60) */
  fps?: number;
  /** how much the hand-orientation wishes count at full confidence (default 1, as HandRig.dir/palm) */
  handWeight?: number;
}

/** one hand and one leg of a retargeted frame (scene, m) */
interface SideFrame {
  /** the wrist's target and how sure */
  wrist: V3;
  wristC: number;
  /** wrist → knuckles, out of the palm, and the weights of these wishes */
  fd: V3;
  palm: V3;
  handW: number;
  palmW: number;
  /** the recorded forearm (elbow → wrist), the fallback for the hand */
  fore: V3;
  /** elbow pole and its weight */
  elbow: V3;
  elbowW: number;
  fingers: [number, number, number, number];
  thumb: V3;
  /** the thumb's last bone (hand frame) and how sure (below 0.5 the rig's own thumb chain is used) */
  thumbDir: V3;
  thumbDirC: number;
  ankle: V3;
  foot: V3;
  knee: V3;
  /** 0 … 1: how firmly the foot stands (locked) */
  lock: number;
}

/** one frame of the retargeted take */
export interface MocapFrame {
  /** take time relative to the clap */
  tau: number;
  pos: [number, number];
  yaw: number;
  drop: number;
  lean: number;
  bend: number;
  twist: number;
  /** the look direction given to the rig (from 1.5 k over the pelvis; solved so that the head faces the recorded way) */
  look: V3;
  sides: [SideFrame, SideFrame];
}

/** what the retargeting found about the take (for warnings and the test scene) */
export interface MocapQuality {
  /** performer → figure: arm, leg and pelvis height ratios, hand sizes */
  scale: { arm: number; leg: number; height: number; handPerformer: number; handFigure: number };
  /** per part: mean confidence over the played frames (0 … 1) */
  parts: Record<string, number>;
  /** share of the played frames whose hand orientation came from the data (weight ≥ 0.5) */
  handData: [number, number];
  /** share of the played frames with the foot locked */
  footLock: [number, number];
  warnings: string[];
}

// ================================================================ small helpers

const r3 = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
/** Catmull-Rom through four points */
function cr(p0: V3, p1: V3, p2: V3, p3: V3, u: number): V3 {
  const u2 = u * u;
  const u3 = u2 * u;
  const w0 = -0.5 * u3 + u2 - 0.5 * u;
  const w1 = 1.5 * u3 - 2.5 * u2 + 1;
  const w2 = -1.5 * u3 + 2 * u2 + 0.5 * u;
  const w3 = 0.5 * u3 - 0.5 * u2;
  return [0, 1, 2].map((k) => w0 * p0[k] + w1 * p1[k] + w2 * p2[k] + w3 * p3[k]) as V3;
}
const nlerp = (a: V3, b: V3, u: number): V3 => norm(r3(a, b, u));

function median(v: number[]): number {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(v: number[], p: number): number {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

/**
 * Confidence-weighted gap filling over frames: a frame keeps its own value when it is sure
 * (w ≥ 0.7), takes the Gaussian-weighted mean of its sure neighbours (σ frames) when unsure, and the
 * prior (if any) where no neighbour is sure; blended in between. Values are vectors of any size.
 */
function fill(vals: number[][], w: number[], sigma: number, prior?: (k: number) => number[], priorW = 0.02): number[][] {
  const n = vals.length;
  const out: number[][] = [];
  const R = Math.ceil(3 * sigma);
  for (let k = 0; k < n; k++) {
    const own = clamp((w[k] - 0.2) / 0.5);
    if (own >= 1) {
      out.push(vals[k]);
      continue;
    }
    const d = vals[k].length;
    const num = new Array<number>(d).fill(0);
    let den = 0;
    for (let j = Math.max(0, k - R); j <= Math.min(n - 1, k + R); j++) {
      const g = Math.exp(-((j - k) ** 2) / (2 * sigma * sigma)) * w[j];
      if (g <= 0) continue;
      den += g;
      for (let c = 0; c < d; c++) num[c] += g * vals[j][c];
    }
    const pv = prior?.(k);
    if (pv) {
      den += priorW;
      for (let c = 0; c < d; c++) num[c] += priorW * pv[c];
    }
    if (den <= 0) {
      // nothing sure around and no prior: the nearest sure frame, else as it is
      let best = -1;
      for (let r = 1; r < n && best < 0; r++) {
        if (k - r >= 0 && w[k - r] > 0.2) best = k - r;
        else if (k + r < n && w[k + r] > 0.2) best = k + r;
      }
      out.push(best >= 0 ? vals[best] : vals[k]);
      continue;
    }
    const f = num.map((x) => x / den);
    out.push(vals[k].map((x, c) => own * x + (1 - own) * f[c]));
  }
  return out;
}

/** Gaussian smoothing of a scalar series (σ frames; 0 = none) */
function gsmooth(v: number[], sigma: number): number[] {
  if (sigma <= 0) return v.slice();
  const R = Math.ceil(3 * sigma);
  return v.map((_, k) => {
    let s = 0, g = 0;
    for (let j = Math.max(0, k - R); j <= Math.min(v.length - 1, k + R); j++) {
      const w = Math.exp(-((j - k) ** 2) / (2 * sigma * sigma));
      s += w * v[j];
      g += w;
    }
    return s / g;
  });
}

const toV3 = (a: number[]): V3 => [a[0], a[1], a[2]];

// ================================================================ the transform into the scene

/** a rigid transform of the take's WORLD (m) into the scene (m) */
interface Rigid {
  R: number[];
  t: V3;
}
const applyR = (m: Rigid, p: V3): V3 => [
  m.R[0] * p[0] + m.R[1] * p[1] + m.R[2] * p[2] + m.t[0],
  m.R[3] * p[0] + m.R[4] * p[1] + m.R[5] * p[2] + m.t[1],
  m.R[6] * p[0] + m.R[7] * p[1] + m.R[8] * p[2] + m.t[2],
];
const rotR = (m: Rigid, v: V3): V3 => [
  m.R[0] * v[0] + m.R[1] * v[1] + m.R[2] * v[2],
  m.R[3] * v[0] + m.R[4] * v[1] + m.R[5] * v[2],
  m.R[6] * v[0] + m.R[7] * v[1] + m.R[8] * v[2],
];
/** a turn about +y by a (as people/math turn(v, UP, a)) followed by a translation */
function yawRigid(a: number, t: V3): Rigid {
  const c = Math.cos(a);
  const s = Math.sin(a);
  // turn(v, UP, a): x' = x c + z s, z' = −x s + z c
  return { R: [c, 0, s, 0, 1, 0, -s, 0, c], t };
}

// ================================================================ the figure

/** what a figure's rest pose looks like through the same measurements as the recording */
interface FigureRest {
  k: number;
  pelvisY: number;
  ankleY: number;
  arm: number;
  leg: number;
  hand: number;
  /** measured lean, bend, twist of the rest pose (the conventions' offsets) */
  lean0: number;
  bend0: number;
  twist0: number;
  /** rest shoulders and hanging wrists relative to the shoulders' middle, in the chest frame */
  shoulder: [V3, V3];
  hang: [V3, V3];
  /** the rest pose's hand shape (fingers, thumb) of a relaxed free hand */
  fingers: [number, number, number, number];
  thumb: V3;
}

/** the chest frame's coordinates of v */
const inChest = (m: { chest: BodyMeasure['chest'] }, v: V3): V3 => [dot(v, m.chest.r), dot(v, m.chest.u), dot(v, m.chest.f)];
const fromChest = (m: BodyMeasure, d: V3): V3 => add(add(scale(m.chest.r, d[0]), scale(m.chest.u, d[1])), scale(m.chest.f, d[2]));

function figureRest(spec: PersonSpec): FigureRest {
  const k = spec.height / 1.75;
  const rig: Rig = { ...stand(spec, [0, 0], 0), hands: [null, null] };
  const pose = rigPose(spec, rig);
  const J = takeJointsOf(pose);
  const c = J.map(() => 1);
  const m = measureBody(J, c);
  const f = forwardOf(0);
  const r = rightOf(0);
  const lb = leanBendOf(m.spine, f, r);
  const twist0 = twistOf(m.chest.f, m.spine, f);
  const S = SIDE;
  const rel = (j: number) => inChest(m, sub(J[j], m.shMid));
  const h = pose.body.hands[0];
  return {
    k,
    pelvisY: m.pelvis[1],
    ankleY: (J[S[0].ankle][1] + J[S[1].ankle][1]) / 2,
    arm: 0.545 * k,
    leg: 0.86 * k,
    hand: (spec.height / 1.75) * spec.build.hands,
    lean0: lb.lean,
    bend0: lb.bend,
    twist0,
    shoulder: [rel(S[0].shoulder), rel(S[1].shoulder)],
    hang: [rel(S[0].wrist), rel(S[1].wrist)],
    fingers: h.curl,
    thumb: h.thumb,
  };
}

// ================================================================ the retargeting

/** a hold as the code uses it: side as an index */
interface HoldIn extends HoldSpec {
  i: 0 | 1;
}

/**
 * A take on a figure: precomputes every frame of the played part (performer measured, scaled to
 * the figure, filled where unsure, feet locked), then rigAt(t) interpolates between frames.
 */
export class Mocap {
  public readonly take: Take;
  public readonly frames: MocapFrame[] = [];
  public readonly quality: MocapQuality;
  /** scene time of the first and the last played frame */
  public readonly start: number;
  public readonly end: number;
  /** take WORLD → scene (no scaling): where the recorded joints are drawn */
  public readonly toScene: (p: V3) => V3;
  public readonly dirToScene: (v: V3) => V3;
  private readonly taus: Float64Array;
  private readonly yawU: number[];
  private readonly holds: HoldIn[];
  private readonly rest: FigureRest;

  public constructor(
    take: Take,
    public readonly spec: PersonSpec,
    public readonly placement: Placement = {},
    public readonly options: RetargetOptions = {},
  ) {
    const pl = placement;
    this.take = pl.mirror && !pl.matrix ? take.mirror() : take;
    const T = this.take;
    const zero = T.zero;
    const from = pl.from ?? T.t0 - zero;
    const to = pl.to ?? T.t1 - zero;
    if (!(to > from)) throw new Error(`Mocap ${T.name}: leerer Abschnitt ${from} … ${to}`);
    this.rest = figureRest(spec);
    const rest = this.rest;
    // holds name the recording's hands: mirrored, the other hand of the figure holds
    this.holds = (options.holds ?? []).map((h) => {
      const i = h.side === 'left' || h.side === 0 ? 0 : 1;
      return { ...h, i: (this.take.mirrored !== take.mirrored ? 1 - i : i) as 0 | 1 };
    });

    // ---- the frames that play (a margin for the splines), measured in the take's WORLD
    const pad = 0.5;
    const i0 = T.frameAt(zero + from - pad).i;
    const i1 = Math.min(T.frames - 1, T.frameAt(zero + to + pad).i + 1);
    const idx: number[] = [];
    for (let i = i0; i <= i1; i++) idx.push(i);
    const raw = idx.map((i) => {
      const p: V3[] = [];
      const c: number[] = [];
      for (let j = 0; j < NJ; j++) {
        const q = T.at(i, j);
        p.push(q ?? [0, 0, 0]);
        c.push(q ? T.confAt(i, j) : 0);
      }
      return { p, c, tau: T.time[i] - zero };
    });

    // ---- the performer: lengths over the whole take (more data, same person)
    const perf = performerOf(T);

    // ---- placement: WORLD → scene
    // the pelvis and the facing around the anchor (±0.2 s): the performer's mark. The facing is the
    // robust one (below), measured here in the take's WORLD
    const anchor = pl.anchor ?? from;
    const sensorW = T.sensor ?? ([0, Number((T.doc.kinect as { height_m?: number } | undefined)?.height_m ?? 1.2), 0] as V3);
    // the plan says where the sensor stood as seen from the person (shots.json yaw_deg, + = on the right)
    const planYaw0 = Number((T.doc.kinect as { yaw_deg?: number } | undefined)?.yaw_deg);
    // (a mirrored take has the sensor on the other side)
    const planYaw = Number.isFinite(planYaw0) ? ((T.mirrored ? -1 : 1) * planYaw0 * Math.PI) / 180 : null;
    const armP = Number.isFinite(perf.arm) ? perf.arm : 0.55;
    // the frames around the anchor (it may lie outside the played part), measured as below
    const near: typeof raw = [];
    for (let i = T.frameAt(zero + anchor - 0.6).i; i <= Math.min(T.frames - 1, T.frameAt(zero + anchor + 0.6).i + 1); i++) {
      const p: V3[] = [];
      const c: number[] = [];
      for (let j = 0; j < NJ; j++) {
        const q = T.at(i, j);
        p.push(q ?? [0, 0, 0]);
        c.push(q ? T.confAt(i, j) : 0);
      }
      near.push({ p, c, tau: T.time[i] - zero });
    }
    const Mraw = near.map((fr) => measureBody(fr.p, fr.c));
    hiddenParts(near, Mraw, sensorW, armP);
    const facingW = robustFacing(near, Mraw, sensorW, armP, planYaw).facing;
    let sw = 0;
    const ap: V3 = [0, 0, 0];
    const af: V3 = [0, 0, 0];
    near.forEach((fr, k) => {
      if (Math.abs(fr.tau - anchor) > 0.2) return;
      const w = Math.max(1e-3, Mraw[k].pelvisC);
      sw += w;
      for (let i = 0; i < 3; i++) {
        ap[i] += w * Mraw[k].pelvis[i];
        af[i] += w * facingW[k][i];
      }
    });
    if (sw <= 0) {
      ap.splice(0, 3, ...Mraw[0].pelvis);
      af.splice(0, 3, ...facingW[0]);
      sw = 1;
    }
    const A = scale(ap, 1 / sw);
    let place: Rigid;
    if (pl.matrix) {
      const Mx = pl.matrix;
      place = { R: [Mx[0], Mx[1], Mx[2], Mx[4], Mx[5], Mx[6], Mx[8], Mx[9], Mx[10]], t: [Mx[3] / 1000, Mx[7] / 1000, Mx[11] / 1000] };
    } else {
      const Fa = horizontal(af) ?? [0, 0, 1];
      const a = yawBetween(Fa, forwardOf(pl.yaw ?? 0));
      const pos = pl.pos ?? [0, 0];
      const rot = yawRigid(a, [0, 0, 0]);
      const At = rotR(rot, [A[0], 0, A[2]]);
      place = { R: rot.R, t: [pos[0] - At[0], 0, pos[1] - At[2]] };
    }
    this.toScene = (p) => applyR(place, p);
    this.dirToScene = (v) => rotR(place, v);
    // the way walked is scaled about the anchor's pelvis (on the floor)
    const Aplaced = applyR(place, A);
    const anchorPos: V3 = [Aplaced[0], 0, Aplaced[2]];

    // ---- the performer placed in the scene (unscaled), measured
    const P = raw.map((fr) => ({ tau: fr.tau, p: fr.p.map((q) => applyR(place, q)), c: fr.c }));
    const n = P.length;
    const M: BodyMeasure[] = [];
    for (let k = 0; k < n; k++) M.push(measureBody(P[k].p, P[k].c, k ? M[k - 1].facing : undefined));
    hiddenParts(P, M, applyR(place, sensorW), armP);

    // ---- scales
    const sArm = Number.isFinite(perf.arm) ? rest.arm / perf.arm : 1;
    const sLeg = Number.isFinite(perf.leg) ? rest.leg / perf.leg : 1;
    const sY = Number.isFinite(perf.pelvisY) ? rest.pelvisY / perf.pelvisY : sLeg;
    const sTravel = pl.travel === 'recorded' ? 1 : sLeg;
    const sigma = (options.smooth ?? 0) * T.fps;

    // ---- torso: facing, spine, chest, head (filled where unsure)
    const { facing, crossC } = robustFacing(P, M, applyR(place, sensorW), armP, planYaw);
    const spine = fill(M.map((m) => m.spine), M.map((m) => m.spineC), 4, () => [0, 1, 0]).map((v) => norm(toV3(v)));
    // the chest's turn comes from the shoulders' line: only as sure as that line lies across the view
    const chestF = fill(M.map((m) => m.chest.f), M.map((m, k) => m.chestC * crossC[k]), 4, (k) => facing[k]).map((v) => norm(toV3(v)));
    // where the face looks; unsure: at the hands when they work in front of the body, else ahead and a little down
    const headPrior = (k: number): V3 => {
      const ahead = norm(madd(chestF[k], UP, -0.25));
      const { p, c } = P[k];
      const L = SIDE[0];
      const R = SIDE[1];
      if (Math.min(c[L.wrist], c[R.wrist]) < 0.3 || !(c[L.ear] > 0 || c[R.ear] > 0 || c[L.eye] > 0 || c[0] > 0)) return ahead;
      const eyes = M[k].shMid[1] + 0.25;
      const toHands = norm(sub(scale(add(p[L.wrist], p[R.wrist]), 0.5), [M[k].shMid[0], eyes, M[k].shMid[2]]));
      return dot(toHands, chestF[k]) > 0.2 ? norm(add(scale(toHands, 0.7), scale(ahead, 0.3))) : ahead;
    };
    const headF = fill(M.map((m) => m.headF ?? m.chest.f), M.map((m) => (m.headF ? m.headC : 0)), 4, headPrior, 0.05).map((v) => norm(toV3(v)));
    const pelvis = fill(M.map((m) => m.pelvis), M.map((m) => m.pelvisC), 3).map(toV3);
    // yaw unwrapped along the frames, smoothed with the positions
    const yawRaw: number[] = [];
    for (let k = 0; k < n; k++) {
      const y = yawOf(facing[k]);
      yawRaw.push(k ? yawRaw[k - 1] + Math.atan2(Math.sin(y - yawRaw[k - 1]), Math.cos(y - yawRaw[k - 1])) : y);
    }
    const yaw = gsmooth(yawRaw, sigma);
    const pelvisS = [0, 1, 2].map((c) => gsmooth(pelvis.map((p) => p[c]), sigma));

    // the performer's frame per frame from the filled values (pelvis, spine, chest)
    // (hands are measured from the shoulders' middle: the hips are often hidden behind hands and ring)
    const shMid = fill(M.map((m) => m.shMid), M.map((m) => m.chestC), 3).map(toV3);
    const perfFrame = spine.map((_, k) => {
      const u = spine[k];
      const f = across(chestF[k], u);
      return { origin: shMid[k], chest: { r: norm(cross(f, u)), u, f } };
    });
    const torso: { pel: V3; pos: [number, number]; yaw: number; lean: number; bend: number; twist: number; drop: number; look: V3 }[] = [];
    for (let k = 0; k < n; k++) {
      const f = forwardOf(yaw[k]);
      const r = rightOf(yaw[k]);
      const lb = leanBendOf(spine[k], f, r);
      const twist = twistOf(chestF[k], spine[k], f) - rest.twist0;
      const pel: V3 = [pelvisS[0][k], pelvisS[1][k], pelvisS[2][k]];
      const pos: [number, number] = [anchorPos[0] + sTravel * (pel[0] - anchorPos[0]), anchorPos[2] + sTravel * (pel[2] - anchorPos[2])];
      torso.push({
        pel,
        pos,
        yaw: yaw[k],
        lean: clamp(lb.lean - rest.lean0, -0.45, 1.35),
        bend: clamp(lb.bend - rest.bend0, -0.5, 0.5),
        twist: clamp(Math.atan2(Math.sin(twist), Math.cos(twist)), -0.9, 0.9),
        // the rig's pelvis stands at 0.935 k minus drop (then lowered until the feet reach)
        drop: 0.935 * rest.k - pel[1] * sY,
        look: headF[k],
      });
    }

    // ---- legs: ankles relative to the pelvis (scaled), feet, knees; then the locks
    const legs = [0, 1].map((s) => {
      const S = SIDE[s];
      const ankleC = P.map((fr) => fr.c[S.ankle]);
      const ankleW = fill(P.map((fr) => fr.p[S.ankle]), ankleC, 4, (k) => add(pelvis[k], scale(rightOf(yaw[k]), (s ? 1 : -1) * 0.1))).map(toV3);
      const ax = [0, 1, 2].map((c) => gsmooth(ankleW.map((p) => p[c]), sigma));
      const ankP = ankleW.map((_, k): V3 => [ax[0][k], ax[1][k], ax[2][k]]);
      const fm = P.map((fr) => measureFoot(fr.p, fr.c, s as 0 | 1));
      const footC = fm.map((f) => f?.conf ?? 0);
      const footRaw = fm.map((f, k) => f?.fd ?? forwardOf(yaw[k]));
      const out = (k: number): V3 => turn(forwardOf(yaw[k]), UP, (s ? -1 : 1) * 0.12);
      const foot = fill(footRaw, footC, 4, (k) => out(k), 0.05).map((v) => norm(toV3(v)));
      const kneeRaw = P.map((fr, k) => {
        const e = elbowPole(fr.p[S.hip], fr.p[S.knee], ankP[k]);
        return e ? e.dir : forwardOf(yaw[k]);
      });
      const kneeC = P.map((fr, k) => {
        const e = elbowPole(fr.p[S.hip], fr.p[S.knee], ankP[k]);
        return e ? Math.min(fr.c[S.knee], fr.c[S.hip]) * e.bent : 0;
      });
      const knee = fill(kneeRaw, kneeC, 6, (k) => add(forwardOf(yaw[k]), scale(rightOf(yaw[k]), (s ? 1 : -1) * 0.15)), 0.05).map((v) => norm(toV3(v)));
      // standing: the ankle near its floor height and slow (performer's own numbers)
      const a0 = perf.ankleY[s];
      const lock: number[] = ankP.map((a, k) => {
        const prev = ankP[Math.max(0, k - 1)];
        const next = ankP[Math.min(n - 1, k + 1)];
        const dt = (P[Math.min(n - 1, k + 1)].tau - P[Math.max(0, k - 1)].tau) || 1 / T.fps;
        const v = Math.hypot(next[0] - prev[0], next[2] - prev[2]) / dt;
        return a[1] < a0 + 0.035 && v < 0.3 && ankleC[k] > 0.2 ? 1 : 0;
      });
      // the knee's bend (rad): it decides how high the figure's pelvis stands over its feet
      const flexC = P.map((fr) => Math.min(fr.c[S.hip], fr.c[S.knee], fr.c[S.ankle]));
      const flexRaw = P.map((fr, k) => {
        const a = sub(fr.p[S.hip], fr.p[S.knee]);
        const b = sub(ankP[k], fr.p[S.knee]);
        return [Math.PI - Math.acos(clamp(dot(norm(a), norm(b)), -1, 1))];
      });
      const flex = fill(flexRaw, flexC, 4, () => [0.1], 0.05).map((v) => v[0]);
      return { ankP, foot, knee, lock, flex, flexC };
    });

    // the figure's ankle (scene) from the performer's, before locking
    const ankleOf = (s: 0 | 1, k: number): V3 => {
      const t = torso[k];
      const a = legs[s].ankP[k];
      return [t.pos[0] + sLeg * (a[0] - t.pel[0]), rest.ankleY + (a[1] - perf.ankleY[s]) * sLeg, t.pos[1] + sLeg * (a[2] - t.pel[2])];
    };
    const lockW: number[][] = [[], []];
    const ankles: V3[][] = [[], []];
    const feet: V3[][] = [[], []];
    for (const s of [0, 1] as const) {
      const L = legs[s];
      for (let k = 0; k < n; k++) {
        ankles[s].push(ankleOf(s, k));
        feet[s].push(L.foot[k]);
      }
      if (options.lockFeet === false) {
        lockW[s] = new Array<number>(n).fill(0);
        continue;
      }
      // contact intervals of at least 4 frames; the foot is held at the interval's mean, blended in and out over 3 frames
      const w = new Array<number>(n).fill(0);
      let k = 0;
      while (k < n) {
        if (!L.lock[k]) {
          k++;
          continue;
        }
        let e = k;
        while (e + 1 < n && L.lock[e + 1]) e++;
        if (e - k + 1 >= 4) {
          let sx = 0, sz = 0, fx = 0, fz = 0;
          for (let j = k; j <= e; j++) {
            sx += ankles[s][j][0];
            sz += ankles[s][j][2];
            const hf = horizontal(feet[s][j]) ?? forwardOf(torso[j].yaw);
            fx += hf[0];
            fz += hf[2];
          }
          const cnt = e - k + 1;
          const at: V3 = [sx / cnt, rest.ankleY, sz / cnt];
          const fdir = horizontal([fx, 0, fz]) ?? forwardOf(torso[k].yaw);
          for (let j = Math.max(0, k - 3); j <= Math.min(n - 1, e + 3); j++) {
            const u = j < k ? (j - (k - 4)) / 4 : j > e ? (e + 4 - j) / 4 : 1;
            if (u <= w[j]) continue;
            w[j] = u;
            ankles[s][j] = r3(ankles[s][j], at, u);
            feet[s][j] = nlerp(feet[s][j], fdir, u);
          }
        }
        k = e + 1;
      }
      lockW[s] = w;
    }

    // ---- the pelvis height from the knees: each leg's recorded bend over the figure's ankle gives a
    // height; standing legs count more. Blended with the scaled height (the knees near straight make
    // the height sensitive: a few mm of noise in the hips would otherwise bend the knees by 10°)
    {
      const kk = rest.k;
      const a = 0.44 * kk;
      const b = 0.42 * kk;
      const hipW = 0.095 * kk * spec.build.hips;
      const py: number[] = [];
      for (let k = 0; k < n; k++) {
        const t = torso[k];
        const r = rightOf(t.yaw);
        let sw = 0;
        let sy = 0;
        for (const s of [0, 1] as const) {
          const th = clamp(legs[s].flex[k], 0, (150 * Math.PI) / 180);
          const d = Math.sqrt(a * a + b * b + 2 * a * b * Math.cos(th));
          const an = ankles[s][k];
          const hx = Math.hypot(t.pos[0] + r[0] * (s ? 1 : -1) * hipW - an[0], t.pos[1] + r[2] * (s ? 1 : -1) * hipW - an[2]);
          const y = an[1] + Math.sqrt(Math.max(0, d * d - hx * hx));
          const w = legs[s].flexC[k] * (0.4 + 0.6 * lockW[s][k]);
          sw += w;
          sy += w * y;
        }
        const yRatio = 0.935 * kk - t.drop;
        const w = 0.85 * clamp(sw);
        py.push(sw > 0 ? yRatio + (sy / sw - yRatio) * w : yRatio);
      }
      const pys = gsmooth(py, 1.5);
      for (let k = 0; k < n; k++) torso[k].drop = 0.935 * kk - pys[k];
    }

    // ---- per frame: the figure's torso pose (hands down) for the shoulders, then the hands
    const together = options.together ?? [0.25, 0.6];
    const handsWorld = options.handsWorld ?? 0;
    const hw = (tau: number) => clamp(typeof handsWorld === 'function' ? handsWorld(tau) : handsWorld);
    // performer's rest shoulders (chest frame; never both seen: the figure's, scaled); the arm ratio
    // kept within 8 % of the body's (a few frames of bad arms)
    const sBody = median([sArm, sLeg, sY].filter(Number.isFinite));
    const shP = [0, 1].map((s) => perf.shoulder[s] ?? scale(rest.shoulder[s], 1 / sBody)) as [V3, V3];
    const sA = clamp(sArm, 0.92 * sBody, 1.08 * sBody);
    const hand = [0, 1].map((s) => ({ hm: P.map((fr) => measureHand(fr.p, fr.c, s as 0 | 1, SIDE[s].hand)) }));
    const qFig = rest.hand;
    // per frame and side: finger and thumb confidences, the hanging wrist (the fallback)
    const fingerC: number[][][] = [[], []];
    const thumbC: number[][] = [[], []];
    const hangAt: V3[][] = [[], []];
    const lookDir: V3[] = [];
    for (let k = 0; k < n; k++) {
      const t = torso[k];
      const feetRig = [0, 1].map((s) => this.legRig(s as 0 | 1, ankles[s][k], feet[s][k], legs[s].knee[k], t)) as [LegRig, LegRig];
      const body: Rig = { pos: t.pos, yaw: t.yaw, drop: t.drop, lean: t.lean, bend: t.bend, twist: t.twist, hands: [null, null], feet: feetRig };
      // the look point that turns the figure's head the recorded way (solved against the rig itself)
      body.look = this.lookFor(body, t.look);
      lookDir.push(norm(sub(body.look, this.lookBase(body))));
      const pose = rigPose(spec, body);
      const J = takeJointsOf(pose);
      const mc = measureBody(J, J.map(() => 1));
      // the performer's (filled) pelvis and chest frame; its hands in that frame
      const mp = perfFrame[k];
      const D = [0, 1].map((s) => {
        const S = SIDE[s];
        return { d: inChest(mp, sub(P[k].p[S.wrist], mp.origin)), c: P[k].c[S.wrist] };
      });
      const Dc = [0, 1].map((s) => add(rest.shoulder[s], scale(sub(D[s].d, shP[s]), sA)));
      // hands close together keep their real offset
      const gap = sub(D[1].d, D[0].d);
      const wTog = together[1] > together[0] ? smooth(together[1], together[0], len(gap)) * Math.min(D[0].c, D[1].c) : 0;
      if (wTog > 0) {
        const mid = scale(add(Dc[0], Dc[1]), 0.5);
        const off = r3(sub(Dc[1], Dc[0]), gap, wTog);
        Dc[0] = madd(mid, off, -0.5);
        Dc[1] = madd(mid, off, 0.5);
      }
      const sides = [0, 1].map((s): SideFrame => {
        const S = SIDE[s];
        let wrist = add(mc.shMid, fromChest(mc, Dc[s]));
        const w = hw(P[k].tau);
        if (w > 0) wrist = r3(wrist, P[k].p[S.wrist], w);
        if (wrist[1] < 0.05) wrist = [wrist[0], 0.05, wrist[2]];
        const hmk = hand[s].hm[k];
        const fore = norm(sub(P[k].p[S.wrist], P[k].p[S.elbow]));
        const pole = elbowPole(P[k].p[S.shoulder], P[k].p[S.elbow], P[k].p[S.wrist]);
        fingerC[s].push([1, 2, 3, 4].map((f) => (hmk?.curls[f] != null ? hmk.curlC[f] : 0)));
        thumbC[s].push(hmk?.thumb ? hmk.thumbC : 0);
        hangAt[s].push(add(mc.shMid, fromChest(mc, rest.hang[s])));
        return {
          wrist,
          // a wrist further from its shoulder than the arm is long is a bad measurement
          wristC: P[k].c[S.wrist] * (Number.isFinite(perf.arm) ? clamp((1.2 * perf.arm - len(sub(P[k].p[S.wrist], P[k].p[S.shoulder]))) / (0.1 * perf.arm)) : 1),
          fd: hmk?.fd ?? fore,
          palm: hmk?.palm ?? across(cross(fore, UP), fore),
          handW: hmk?.conf ?? 0,
          palmW: hmk?.rollConf ?? 0,
          fore,
          elbow: pole?.dir ?? [0, -1, 0],
          elbowW: pole ? Math.min(P[k].c[S.elbow], P[k].c[S.shoulder], P[k].c[S.wrist]) * pole.bent : 0,
          fingers: [1, 2, 3, 4].map((f) => hmk?.curls[f] ?? rest.fingers[f - 1]) as [number, number, number, number],
          thumb: hmk?.thumb ?? rest.thumb,
          thumbDir: hmk?.thumbDir ?? [0.6, 0.2, 0.77],
          thumbDirC: hmk?.thumbDir ? hmk.thumbC : 0,
          ankle: ankles[s][k],
          foot: feet[s][k],
          knee: legs[s].knee[k],
          lock: lockW[s][k],
        };
      });
      this.frames.push({ tau: P[k].tau, pos: t.pos, yaw: t.yaw, drop: t.drop, lean: t.lean, bend: t.bend, twist: t.twist, look: lookDir[k], sides: [sides[0], sides[1]] });
    }

    // ---- fill the hands where unsure: wrists (towards the hanging hand), orientation, fingers, thumb
    for (const s of [0, 1] as const) {
      const F = this.frames;
      const wC = F.map((f) => f.sides[s].wristC);
      const wr = fill(F.map((f) => f.sides[s].wrist), wC, 4, (k) => hangAt[s][k], 0.05);
      const wx = [0, 1, 2].map((c) => gsmooth(wr.map((p) => p[c]), sigma));
      const hW = F.map((f) => f.sides[s].handW);
      const fd = fill(F.map((f) => f.sides[s].fd), hW, 3, (k) => F[k].sides[s].fore, 0.05);
      const pW = F.map((f) => f.sides[s].palmW);
      const palm = fill(F.map((f) => f.sides[s].palm), pW, 3);
      const hWs = gsmooth(hW, 2);
      const pWs = gsmooth(pW, 2);
      const eW = gsmooth(F.map((f) => f.sides[s].elbowW), 2);
      const el = fill(F.map((f) => f.sides[s].elbow), F.map((f) => f.sides[s].elbowW), 4);
      const fing = fill(F.map((f) => f.sides[s].fingers), fingerC[s].map((c) => Math.min(...c)), 3, () => rest.fingers, 0.05);
      const th = fill(F.map((f) => f.sides[s].thumb), thumbC[s], 3, () => rest.thumb, 0.05);
      const tdC = F.map((f) => f.sides[s].thumbDirC);
      const td = fill(F.map((f) => f.sides[s].thumbDir), tdC, 3);
      const tdW = gsmooth(tdC, 2);
      F.forEach((f, k) => {
        const sf = f.sides[s];
        sf.wrist = [wx[0][k], wx[1][k], wx[2][k]];
        sf.fd = norm(toV3(fd[k]));
        sf.palm = across(toV3(palm[k]), sf.fd);
        sf.handW = clamp(hWs[k]);
        sf.palmW = clamp(pWs[k]);
        sf.elbowW = clamp(eW[k]);
        sf.elbow = norm(toV3(el[k]));
        sf.fingers = fing[k].map((x) => clamp(x)) as [number, number, number, number];
        sf.thumb = toV3(th[k]);
        sf.thumbDir = norm(toV3(td[k]));
        sf.thumbDirC = clamp(tdW[k]);
      });
    }

    this.taus = Float64Array.from(this.frames.map((f) => f.tau));
    this.yawU = this.frames.map((f) => f.yaw);
    // ---- scene times
    this.tauOf = makeTimeMap(pl, from, to);
    const span = pl.warp ? [pl.warp[0][0], pl.warp[pl.warp.length - 1][0]] : [pl.at ?? 0, (pl.at ?? 0) + (to - from) / (pl.speed ?? 1)];
    this.start = span[0];
    this.end = span[1];

    // ---- quality
    const played = P.map((fr, k) => (fr.tau >= from && fr.tau <= to ? k : -1)).filter((k) => k >= 0);
    const meanC = (js: number[]) => (played.length ? played.reduce((s, k) => s + Math.min(...js.map((j) => P[k].c[j])), 0) / played.length : 0);
    const L = SIDE[0];
    const R = SIDE[1];
    const parts: Record<string, number> = {
      Rumpf: meanC([L.shoulder, R.shoulder, L.hip, R.hip]),
      Kopf: played.length ? played.reduce((s, k) => s + M[k].headC, 0) / played.length : 0,
      'linker Arm': meanC([L.shoulder, L.elbow, L.wrist]),
      'rechter Arm': meanC([R.shoulder, R.elbow, R.wrist]),
      'linke Hand': played.length ? played.reduce((s, k) => s + (hand[0].hm[k]?.conf ?? 0), 0) / played.length : 0,
      'rechte Hand': played.length ? played.reduce((s, k) => s + (hand[1].hm[k]?.conf ?? 0), 0) / played.length : 0,
      Beine: meanC([L.knee, R.knee, L.ankle, R.ankle]),
      'Füße': meanC([L.heel, L.bigToe, R.heel, R.bigToe]),
    };
    const share = (f: (k: number) => boolean) => (played.length ? played.filter(f).length / played.length : 0);
    const handData: [number, number] = [share((k) => this.frames[k].sides[0].palmW >= 0.5), share((k) => this.frames[k].sides[1].palmW >= 0.5)];
    const footLock: [number, number] = [share((k) => lockW[0][k] >= 1), share((k) => lockW[1][k] >= 1)];
    const warnings: string[] = [];
    for (const [name, v] of Object.entries(parts)) if (v < 0.5) warnings.push(`${name}: im Mittel nur ${Math.round(v * 100)} % sicher`);
    handData.forEach((v, s) => {
      if (v < 0.5) warnings.push(`${s ? 'rechte' : 'linke'} Hand: Drehung nur in ${Math.round(v * 100)} % der Frames aus der Aufnahme, sonst bequem gewählt`);
    });
    if (T.markers.clap === null) warnings.push('kein Klatschen im Take: Zeiten zählen ab dem ersten Frame');
    this.quality = {
      scale: { arm: sA, leg: sLeg, height: sY, handPerformer: perf.hand, handFigure: qFig },
      parts,
      handData,
      footLock,
      warnings: [...warnings, ...T.warnings],
    };
  }

  /** scene time → take time relative to the clap */
  public readonly tauOf: (t: number) => number;

  /** where look directions start (far enough that the head's own position hardly matters) */
  private lookBase(g: { pos: [number, number] }): V3 {
    return [g.pos[0], 1.5 * this.rest.k, g.pos[1]];
  }

  /**
   * The look point for a rig whose head should face `want` (world): solved against rig.ts's own
   * head (eyesOfRig) by Newton steps on the look direction's yaw and pitch, so it holds whatever
   * conventions and limits the rig's head has.
   */
  private lookFor(g: Rig, want: V3): V3 {
    const base = this.lookBase(g);
    const dirOf = (y: number, p: number): V3 => [Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)];
    const angles = (f: V3) => [yawOf(f), Math.asin(clamp(f[1], -1, 1))];
    const head = (y: number, p: number) => angles(eyesOfRig(this.spec, { ...g, look: madd(base, dirOf(y, p), LOOK_FAR) }).f);
    const goal = angles(want);
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
    let [y, p] = goal;
    for (let it = 0; it < 6; it++) {
      const h0 = head(y, p);
      const e = [wrap(h0[0] - goal[0]), h0[1] - goal[1]];
      if (Math.hypot(e[0], e[1]) < 1e-4) break;
      const d = 1e-3;
      const hy = head(y + d, p);
      const hp = head(y, p + d);
      const J = [[wrap(hy[0] - h0[0]) / d, wrap(hp[0] - h0[0]) / d], [(hy[1] - h0[1]) / d, (hp[1] - h0[1]) / d]];
      // damped least squares: a direction the rig's limits hold (zero column) simply stays
      const a11 = J[0][0] * J[0][0] + J[1][0] * J[1][0] + 1e-4;
      const a12 = J[0][0] * J[0][1] + J[1][0] * J[1][1];
      const a22 = J[0][1] * J[0][1] + J[1][1] * J[1][1] + 1e-4;
      const g1 = J[0][0] * e[0] + J[1][0] * e[1];
      const g2 = J[0][1] * e[0] + J[1][1] * e[1];
      const det = a11 * a22 - a12 * a12;
      const dy = (a22 * g1 - a12 * g2) / det;
      const dp = (a11 * g2 - a12 * g1) / det;
      if (Math.hypot(dy, dp) < 1e-5) break;
      y -= clamp(dy, -0.5, 0.5);
      p = clamp(p - clamp(dp, -0.5, 0.5), -1.45, 1.45);
    }
    return madd(base, dirOf(y, p), LOOK_FAR);
  }

  /** a leg for the rig: the ankle raised so heel and toes stay above the floor, the knee in front, bent at most 155° */
  private legRig(s: 0 | 1, ankle: V3, foot: V3, knee: V3, t: { pos: [number, number]; yaw: number; drop: number }): LegRig {
    const k = this.rest.k;
    const q = k * this.spec.build.feet;
    // the foot points no steeper than 60° down or 40° up
    let fd = norm(foot);
    fd = norm([fd[0], clamp(fd[1], -0.87, 0.64), fd[2]]);
    // heel (−0.075 along, 0.05 down) and toes (0.18 along, 0.058 down) above the floor (jointsOf footPoints)
    const need = Math.max(0.05 * q + 0.075 * q * fd[1], 0.058 * q - 0.18 * q * fd[1]);
    const a: V3 = [ankle[0], Math.max(ankle[1], need), ankle[2]];
    // the knee's pole: in front of the leg, within ±45° of the foot's direction
    const ff = horizontal(fd) ?? forwardOf(t.yaw);
    let kh = horizontal(knee) ?? ff;
    let ang = yawBetween(ff, kh);
    if (Math.abs(ang) > Math.PI / 2) ang = Math.sign(ang) * (Math.PI - Math.abs(ang));
    ang = clamp(ang, -Math.PI / 4, Math.PI / 4);
    kh = turn(ff, UP, ang);
    const pole = norm(add(kh, [0, Math.max(-0.5, Math.min(0.5, knee[1])), 0]));
    // no more than 155° of knee bend: the ankle at least this far from the hip
    const thigh = 0.44 * k;
    const shin = 0.42 * k;
    const dMin = Math.sqrt(thigh * thigh + shin * shin - 2 * thigh * shin * Math.cos((25 * Math.PI) / 180));
    const hipY = 0.935 * k - t.drop;
    const hip: V3 = [t.pos[0] + rightOf(t.yaw)[0] * (s ? 1 : -1) * 0.095 * k, hipY, t.pos[1] + rightOf(t.yaw)[2] * (s ? 1 : -1) * 0.095 * k];
    const d = sub(a, hip);
    const dl = len(d);
    const ankleOk = dl < dMin && dl > 1e-6 ? madd(hip, d, dMin / dl) : a;
    return { ankle: [ankleOk[0], Math.max(ankleOk[1], need), ankleOk[2]], dir: fd, knee: pole };
  }

  /** the frame index and fraction at take time tau */
  private at(tau: number): { k: number; u: number } {
    const T = this.taus;
    const n = T.length;
    if (tau <= T[0]) return { k: 0, u: 0 };
    if (tau >= T[n - 1]) return { k: n - 1, u: 0 };
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (T[m] <= tau) lo = m;
      else hi = m;
    }
    return { k: lo, u: (tau - T[lo]) / (T[hi] - T[lo] || 1) };
  }

  /** the hold of a hand at scene time t, or null (free) */
  public holding(t: number, side: 0 | 1): HoldSpec | null {
    const tau = this.tauOf(t);
    return this.holds.find((h) => h.i === side && tau >= h.from && tau < h.to) ?? null;
  }

  /** the rig at scene time t (pass to RigTrack; a pure function of t) */
  public readonly rigAt = (t: number): Rig => {
    const tau = this.tauOf(t);
    const { k, u } = this.at(tau);
    const F = this.frames;
    const n = F.length;
    const a = F[k];
    const b = F[Math.min(n - 1, k + 1)];
    const a0 = F[Math.max(0, k - 1)];
    const b1 = F[Math.min(n - 1, k + 2)];
    const num = (x: number, y: number) => x + (y - x) * u;
    const pos = cr([a0.pos[0], 0, a0.pos[1]], [a.pos[0], 0, a.pos[1]], [b.pos[0], 0, b.pos[1]], [b1.pos[0], 0, b1.pos[1]], u);
    const yaw = num(this.yawU[k], this.yawU[Math.min(n - 1, k + 1)]);
    const look = nlerp(a.look, b.look, u);
    const sides = [0, 1].map((s) => {
      const A = a.sides[s];
      const B = b.sides[s];
      return {
        wrist: cr(a0.sides[s].wrist, A.wrist, B.wrist, b1.sides[s].wrist, u),
        fd: nlerp(A.fd, B.fd, u),
        palm: nlerp(A.palm, B.palm, u),
        handW: num(A.handW, B.handW),
        palmW: num(A.palmW, B.palmW),
        fore: nlerp(A.fore, B.fore, u),
        elbow: nlerp(A.elbow, B.elbow, u),
        elbowW: num(A.elbowW, B.elbowW),
        fingers: A.fingers.map((x, i) => num(x, B.fingers[i])) as [number, number, number, number],
        thumb: r3(A.thumb, B.thumb, u),
        thumbDir: nlerp(A.thumbDir, B.thumbDir, u),
        thumbDirC: num(A.thumbDirC, B.thumbDirC),
        ankle: cr(a0.sides[s].ankle, A.ankle, B.ankle, b1.sides[s].ankle, u),
        foot: nlerp(A.foot, B.foot, u),
        knee: nlerp(A.knee, B.knee, u),
      };
    });
    const t0 = { pos: [pos[0], pos[2]] as [number, number], yaw, drop: num(a.drop, b.drop) };
    const feet = [0, 1].map((s) => this.legRig(s as 0 | 1, sides[s].ankle, sides[s].foot, sides[s].knee, t0)) as [LegRig, LegRig];
    const hands = [0, 1].map((s) => this.handRig(s as 0 | 1, tau, sides[s])) as [HandRig, HandRig];
    return {
      pos: t0.pos,
      yaw,
      drop: t0.drop,
      lean: num(a.lean, b.lean),
      bend: num(a.bend, b.bend),
      twist: num(a.twist, b.twist),
      look: madd(this.lookBase({ pos: [pos[0], pos[2]] }), look, LOOK_FAR),
      hands,
      feet,
    };
  };

  /** a hand's rig: free (wrist, orientation wishes, elbow, fingers) or, during a hold, a grip at the recorded hand's frame */
  private handRig(s: 0 | 1, tau: number, h: { wrist: V3; fd: V3; palm: V3; handW: number; palmW: number; fore: V3; elbow: V3; elbowW: number; fingers: [number, number, number, number]; thumb: V3; thumbDir: V3; thumbDirC: number }): HandRig {
    const W = this.options.handWeight ?? 1;
    const prefer: AxisGoal[] = [
      { hand: [1, 0, 0], world: h.fd, weight: W * h.handW },
      { hand: [0, 1, 0], world: h.palm, weight: W * h.palmW },
      // unsure hands continue the forearm (a straight wrist), gently
      { hand: [1, 0, 0], world: h.fore, weight: 0.25 * (1 - h.handW) },
    ];
    const free: HandRig = { wrist: h.wrist, prefer, elbow: h.elbow, elbowWeight: h.elbowW, fingers: h.fingers, thumbTip: h.thumb, thumbDir: h.thumbDirC >= 0.5 ? h.thumbDir : undefined };
    const hold = this.holds.find((x) => x.i === s && tau >= x.from - (x.blend ?? 0.2) && tau < x.to + (x.blend ?? 0.2));
    if (!hold) return free;
    const base: HandRig = { hold: hold.hold, radius: hold.radius ?? 0.0032, ...hold.rig };
    const shape = gripShape(this.spec, s ? 1 : -1, base);
    if (tau < hold.from || tau >= hold.to) {
      // fingers blend into (or out of) the grip's shape
      const bl = hold.blend ?? 0.2;
      const u = tau < hold.from ? smooth(hold.from - bl, hold.from, tau) : smooth(hold.to + bl, hold.to, tau);
      return { ...free, fingers: h.fingers.map((x, i) => lerp(x, shape.curl[i], u)) as [number, number, number, number], thumbTip: mix3(h.thumb, shape.thumb, u) };
    }
    // the grip frame where a hand with the recorded orientation holds the cable
    const side = s ? 1 : -1;
    const fd = h.fd;
    const palm = across(h.palm, fd);
    const th = scale(norm(cross(fd, palm)), side);
    const toW = (v: V3): V3 => add(add(scale(fd, v[0]), scale(palm, v[1])), scale(th, v[2]));
    let d3 = norm(toW(shape.d3));
    let d1 = across(toW(shape.pads), d3);
    const p = add(h.wrist, toW(shape.p));
    if (hold.along) {
      const want = norm(typeof hold.along === 'function' ? hold.along(tau) : hold.along);
      // the smallest turn of the frame that lays d3 along the wanted direction
      const ax = cross(d3, want);
      const sn = len(ax);
      if (sn > 1e-6) {
        const ang = Math.atan2(sn, dot(d3, want));
        d1 = across(turn(d1, scale(ax, 1 / sn), ang), want);
      }
      d3 = want;
    }
    const grip: Grip = { p, q: quatFromCols(d1, cross(d3, d1), d3) };
    return { ...base, grip, free: hold.free ?? clamp(1 - 0.8 * h.palmW, 0.2, 1), elbow: h.elbow, elbowWeight: h.elbowW };
  }

  /** a RigTrack over the played part: THE source of the arms for bake and scene */
  public track(fps = this.options.fps ?? 60): RigTrack {
    return new RigTrack(this.spec, this.rigAt, this.start, fps);
  }

  /** the recorded joints at scene time t, placed in the scene but not scaled (for drawing and checks) */
  public recorded(t: number): { p: V3[]; c: number[] } {
    const s = this.take.sample(this.take.zero + this.tauOf(t));
    return { p: s.p.map(this.toScene), c: s.c };
  }

  /** the cable frame a holding hand holds in a solved pose (rig.ts ArmPose.grip), or null when free */
  public gripOf(pose: Pose, t: number, side: 0 | 1): Grip | null {
    return this.holding(t, side) ? pose.body.arms?.[side].grip ?? null : null;
  }

  /** a short German summary of the quality (for the scene and the console) */
  public report(): string {
    const q = this.quality;
    const pc = (v: number) => `${Math.round(v * 100)} %`;
    const lines = [
      `${this.take.shot} Take ${this.take.take}${this.take.mirrored ? ' (gespiegelt)' : ''} → ${this.spec.name}: Arme ×${q.scale.arm.toFixed(2)}, Beine ×${q.scale.leg.toFixed(2)}, Becken ×${q.scale.height.toFixed(2)}`,
      `sicher: ${Object.entries(q.parts).map(([k, v]) => `${k} ${pc(v)}`).join(', ')}`,
      `Handdrehung aus der Aufnahme: links ${pc(q.handData[0])}, rechts ${pc(q.handData[1])}; Füße fest: links ${pc(q.footLock[0])}, rechts ${pc(q.footLock[1])}`,
    ];
    if (q.warnings.length) lines.push(`Achtung: ${q.warnings.join('; ')}`);
    return lines.join('\n');
  }
}

/**
 * A hip or a shoulder hidden or unsure while the other one is sure: the hidden one from the seen
 * one and their usual offset (from the frames with both, in the facing's frame); never both seen (a
 * side view): the hidden one is behind the seen one, a body's width further along the view. The
 * frames are measured again with these (M is replaced; the joints themselves stay as recorded).
 */
function hiddenParts(P: { p: V3[]; c: number[] }[], M: BodyMeasure[], sensor: V3, arm: number) {
  const n = P.length;
  const pairs = [
    { a: SIDE[0].hip, b: SIDE[1].hip, width: 0.36 * arm },
    { a: SIDE[0].shoulder, b: SIDE[1].shoulder, width: 0.68 * arm },
  ];
  const local = (v: V3, f: V3): V3 => {
    const r = norm(cross(f, UP));
    return [dot(v, r), v[1], dot(v, f)];
  };
  const global = (o: V3, f: V3): V3 => {
    const r = norm(cross(f, UP));
    return add(add(scale(r, o[0]), [0, o[1], 0]), scale(f, o[2]));
  };
  const est = pairs.map((pr) => {
    // the other joint relative to a seen one, both ways (a → b, b → a)
    const offs: V3[][] = [[], []];
    for (let k = 0; k < n; k++) {
      const c = P[k].c;
      if (c[pr.a] < 0.5 || c[pr.b] < 0.5) continue;
      offs[0].push(local(sub(P[k].p[pr.b], P[k].p[pr.a]), M[k].facing));
      offs[1].push(local(sub(P[k].p[pr.a], P[k].p[pr.b]), M[k].facing));
    }
    const off = offs.map((o) => (o.length >= 5 ? ([0, 1, 2].map((i) => median(o.map((x) => x[i]))) as V3) : null));
    return P.map((fr, k) => {
      const c = fr.c;
      if (Math.min(c[pr.a], c[pr.b]) >= 0.3 || Math.max(c[pr.a], c[pr.b]) < 0.6) return null;
      const seenA = c[pr.a] >= c[pr.b];
      const seen = fr.p[seenA ? pr.a : pr.b];
      const o = off[seenA ? 0 : 1];
      const other = o ? add(seen, global(o, M[k].facing)) : madd(seen, horizontal(sub(seen, sensor)) ?? [0, 0, -1], pr.width);
      const pts: [V3, V3] = seenA ? [seen, other] : [other, seen];
      return { pts, c: 0.8 * Math.max(c[pr.a], c[pr.b]) };
    });
  });
  for (let k = 0; k < n; k++) {
    const hip = est[0][k];
    const sh = est[1][k];
    if (!hip && !sh) continue;
    M[k] = measureBody(P[k].p, P[k].c, M[k].facing, {
      pelvis: hip ? { p: scale(add(hip.pts[0], hip.pts[1]), 0.5), c: hip.c } : undefined,
      shoulders: sh ? { p: sh.pts, c: sh.c } : undefined,
    });
  }
}

/**
 * The facing per frame, robust in every view. Cues: the hips' and the shoulders' lines (each only
 * as far as it lies across the sensor's view: seen from the side, the depth decides it and depth is
 * the noisy part), the face, the feet. Cues that disagree with the slow facing (±0.17 s) by more
 * than 75° are dropped (a far hip in front of the near one), then lightly smoothed. Also gives, per
 * frame, how far the shoulders' line lies across the view (0 … 1) for the chest's turn.
 */
function robustFacing(P: { p: V3[]; c: number[] }[], M: BodyMeasure[], sensor: V3, arm: number, planYaw: number | null): { facing: V3[]; crossC: number[] } {
  const n = P.length;
  const L = SIDE[0];
  const R = SIDE[1];
  const cues: { f: V3; w: number }[][] = [];
  const crossC: number[] = [];
  const acrossView = (line: V3, view: V3) => clamp((Math.abs(line[0] * view[2] - line[2] * view[0]) - 0.25) / 0.45);
  // a line much shorter than the body is wide is a collapsed measurement (the far side guessed onto the near one)
  const wide = (v: V3, expected: number) => clamp((len(v) / expected - 0.6) / 0.25);
  for (let k = 0; k < n; k++) {
    const { p, c } = P[k];
    const m = M[k];
    const view = horizontal(sub(m.pelvis, sensor)) ?? [0, 0, -1];
    const list: { f: V3; w: number }[] = [];
    const hv = sub(p[R.hip], p[L.hip]);
    const hr = horizontal(hv);
    if (hr) list.push({ f: norm(cross(UP, hr)), w: Math.min(c[L.hip], c[R.hip]) * acrossView(hr, view) * wide(hv, 0.36 * arm) });
    const sv = sub(m.shoulders[1], m.shoulders[0]);
    const sr = horizontal(sv);
    const sc = sr ? acrossView(sr, view) * wide(sv, 0.68 * arm) : 0;
    crossC.push(sc);
    if (sr) list.push({ f: norm(cross(UP, sr)), w: 0.7 * Math.min(c[L.shoulder], c[R.shoulder]) * sc });
    const hf = m.headF ? horizontal(m.headF) : null;
    if (hf && m.headF && Math.abs(m.headF[1]) < 0.9) list.push({ f: hf, w: 0.2 * m.headC });
    const feet = [0, 1].map((s) => measureFoot(p, c, s as 0 | 1));
    const fd = feet.filter((f) => f && f.conf > 0.3).map((f) => horizontal(f!.fd)).filter(Boolean) as V3[];
    if (fd.length) list.push({ f: norm(fd.reduce((a, b) => add(a, b), [0, 0, 0])), w: 0.5 * Math.min(...feet.map((f) => f?.conf ?? 0)) });
    // the plan's geometry: the sensor at planYaw from the person's facing; a weak cue for when nothing else is sure
    if (planYaw !== null) list.push({ f: forwardOf(yawOf(scale(view, -1)) - planYaw), w: 0.1 });
    cues.push(list);
  }
  const sum = (list: { f: V3; w: number }[]) => list.reduce((a, q) => madd(a, q.f, q.w), [0, 0, 0] as V3);
  const F = cues.map(sum);
  const window = (V: V3[], sigma: number, k: number) => {
    const out: V3 = [0, 0, 0];
    const R0 = Math.ceil(3 * sigma);
    for (let j = Math.max(0, k - R0); j <= Math.min(n - 1, k + R0); j++) {
      const g = Math.exp(-((j - k) ** 2) / (2 * sigma * sigma));
      out[0] += g * V[j][0];
      out[2] += g * V[j][2];
    }
    return out;
  };
  // the slow facing, then the cues that agree with it
  const slow = F.map((_, k) => window(F, 5, k));
  const kept = cues.map((list, k) => {
    const s = horizontal(slow[k]);
    return sum(s ? list.filter((q) => dot(q.f, s) > Math.cos((75 * Math.PI) / 180)) : list);
  });
  const facing: V3[] = [];
  for (let k = 0; k < n; k++) {
    const f = horizontal(window(kept, 1.5, k)) ?? horizontal(slow[k]) ?? (k ? facing[k - 1] : M[k].facing);
    facing.push(f);
  }
  return { facing, crossC };
}

/** scene time → take time (relative to the clap): at/speed or a warp, held at the ends */
function makeTimeMap(pl: Placement, from: number, to: number): (t: number) => number {
  if (pl.warp && pl.warp.length >= 2) {
    const w = [...pl.warp].sort((a, b) => a[0] - b[0]);
    return (t: number) => {
      if (t <= w[0][0]) return w[0][1];
      for (let i = 1; i < w.length; i++) {
        if (t < w[i][0]) {
          const u = (t - w[i - 1][0]) / (w[i][0] - w[i - 1][0]);
          return w[i - 1][1] + (w[i][1] - w[i - 1][1]) * u;
        }
      }
      return w[w.length - 1][1];
    };
  }
  const at = pl.at ?? 0;
  const sp = pl.speed ?? 1;
  return (t: number) => clamp(from + (t - at) * sp, from, to);
}

// ================================================================ the performer

interface Performer {
  arm: number;
  leg: number;
  pelvisY: number;
  ankleY: [number, number];
  hand: number;
  /** rest shoulders relative to the shoulders' middle in the chest frame (null: never both seen) */
  shoulder: [V3 | null, V3 | null];
}

/** the performer's proportions from the whole take: medians of bone lengths, the standing pelvis height, the ankles' floor height */
export function performerOf(T: Take): Performer {
  const S = SIDE;
  const arm: number[] = [];
  const leg: number[] = [];
  const pel: number[] = [];
  const ank: number[][] = [[], []];
  const hand: number[] = [];
  const shAll: V3[][] = [[], []];
  const shHang: V3[][] = [[], []];
  const ok = (i: number, ...js: number[]) => js.every((j) => T.confAt(i, j) >= 0.5);
  for (let i = 0; i < T.frames; i++) {
    const p: V3[] = [];
    const c: number[] = [];
    for (let j = 0; j < NJ; j++) {
      p.push(T.at(i, j) ?? [0, 0, 0]);
      c.push(T.confAt(i, j));
    }
    for (const s of [0, 1]) {
      const X = S[s];
      if (ok(i, X.shoulder, X.elbow, X.wrist)) arm.push(len(sub(p[X.elbow], p[X.shoulder])) + len(sub(p[X.wrist], p[X.elbow])));
      if (ok(i, X.hip, X.knee, X.ankle)) leg.push(len(sub(p[X.knee], p[X.hip])) + len(sub(p[X.ankle], p[X.knee])));
      if (ok(i, X.ankle)) ank[s].push(p[X.ankle][1]);
      const hm = measureHand(p, c, s as 0 | 1, X.hand);
      if (hm && hm.conf >= 0.5) hand.push(hm.size);
    }
    if (ok(i, S[0].hip, S[1].hip)) pel.push((p[S[0].hip][1] + p[S[1].hip][1]) / 2);
    if (ok(i, S[0].hip, S[1].hip, S[0].shoulder, S[1].shoulder)) {
      const m = measureBody(p, c);
      for (const s of [0, 1]) {
        const X = S[s];
        const d = inChest(m, sub(m.shoulders[s], m.shMid));
        shAll[s].push(d);
        // the arm hangs: elbow well below the shoulder, wrist below the elbow
        if (ok(i, X.elbow, X.wrist) && p[X.elbow][1] < p[X.shoulder][1] - 0.18 && p[X.wrist][1] < p[X.elbow][1] - 0.15) shHang[s].push(d);
      }
    }
  }
  const med3 = (v: V3[]): V3 => [median(v.map((x) => x[0])), median(v.map((x) => x[1])), median(v.map((x) => x[2]))];
  const shoulder = [0, 1].map((s) => med3(shHang[s].length >= 5 ? shHang[s] : shAll[s])) as [V3, V3];
  const bones = (T.doc.meta?.bones_mm ?? null) as Record<string, number> | null;
  const fromBones = (a: string, b: string, c: string) => {
    if (!bones) return NaN;
    const v = [`left_${a}-left_${b}`, `left_${b}-left_${c}`, `right_${a}-right_${b}`, `right_${b}-right_${c}`].map((k) => bones[k]);
    return v.every((x) => x > 0) ? (v[0] + v[1] + v[2] + v[3]) / 2000 : NaN;
  };
  const a = arm.length >= 5 ? median(arm) : fromBones('shoulder', 'elbow', 'wrist');
  const l = leg.length >= 5 ? median(leg) : fromBones('hip', 'knee', 'ankle');
  const a0 = [0, 1].map((s) => (ank[s].length ? percentile(ank[s], 0.1) : 0.075)) as [number, number];
  return {
    arm: a,
    leg: l,
    pelvisY: pel.length ? percentile(pel, 0.9) : NaN,
    ankleY: a0,
    hand: hand.length ? median(hand) : NaN,
    shoulder: shoulder.map((v) => (v.every(Number.isFinite) ? v : null)) as [V3 | null, V3 | null],
  };
}

// ================================================================ suggested holds

/**
 * Where a hand probably holds something, from the recorded fingers (take times relative to the
 * clap): 'pinch' when the thumb tip is near the index finger with the index finger half curled,
 * 'fist' when all four fingers are curled. A suggestion for HoldSpec (the recording does not know
 * whether there is a cable in the hand); intervals shorter than `min` s are dropped.
 */
export function suggestHolds(T: Take, side: 0 | 1, min = 0.3): HoldSpec[] {
  const S = SIDE[side];
  const kind: (Hold | null)[] = [];
  for (let i = 0; i < T.frames; i++) {
    const p: V3[] = [];
    const c: number[] = [];
    for (let j = 0; j < NJ; j++) {
      p.push(T.at(i, j) ?? [0, 0, 0]);
      c.push(T.confAt(i, j));
    }
    const hm = measureHand(p, c, side, S.hand);
    if (!hm || hm.conf < 0.4) {
      kind.push(null);
      continue;
    }
    const curls = hm.curls.slice(1).map((x) => x ?? 0.25);
    // the thumb tip at the side of the index finger's middle bone (finger, thumb and a cable between them)
    const tip = p[S.hand + 4];
    const a = p[S.hand + 6];
    const ab = sub(p[S.hand + 7], a);
    const u = clamp(dot(sub(tip, a), ab) / Math.max(1e-9, dot(ab, ab)));
    const near = len(sub(tip, madd(a, ab, u))) / hm.size;
    if (c[S.hand + 4] > 0.4 && near < 0.035 && curls[0] > 0.2 && curls[0] < 0.9) kind.push('pinch');
    else if (Math.min(...curls) > 0.6) kind.push('fist');
    else kind.push(null);
  }
  const out: HoldSpec[] = [];
  let i = 0;
  while (i < kind.length) {
    const h = kind[i];
    if (!h) {
      i++;
      continue;
    }
    let e = i;
    // gaps of up to 0.5 s (a loosened pinch while the cable slides) do not end a hold
    const gap = Math.max(1, Math.round(0.5 * T.fps));
    while (e + 1 < kind.length && (kind[e + 1] === h || kind.slice(e + 1, e + 1 + gap).includes(h))) e++;
    const from = T.time[i] - T.zero;
    const to = T.time[e] - T.zero;
    if (to - from >= min) out.push({ side, from, to, hold: h });
    i = e + 1;
  }
  return out;
}
