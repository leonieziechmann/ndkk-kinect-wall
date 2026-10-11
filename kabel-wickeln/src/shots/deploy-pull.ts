// Stage 1, item 3: a short cable laid out again, done right. Ilse sits in her wheelchair at the FOH
// desk with a short over-under ring of a black charging cable (CHARGING preset, Ø 4 mm, 4 loops of
// Ø 9 cm, 1.44 m with the plugs). She holds it at chest height, its top between the thumb and index
// finger of her left hand, its face towards her: the ring hangs from that hand. The start end runs
// through her fingers, its plug sticks out to her left. The ring is closed with a velcro tie that
// lives on that end (9 cm from the plug). Her right hand comes from above, pinches the tie's pull tab
// and pulls it up out of its eyelet: the band comes loose. The right hand goes round the ring to the
// other end, which hangs out of the ring below, and takes it. Both ends are outside the ring, and
// both are in her hands now. She holds still (the ends are pointed out), then pulls her hands apart:
// the right hand draws the last loop out of the loosened left hand, then the next, …, one after the
// other, each opening as it is pulled (the left hand keeps only the start end at the end). The cable
// hangs calm between her hands, without curls (the +1 and -1 turns of the über and unter loops
// cancel); she lowers her hands and its middle lies on the desk.
//
// The loops leave the left hand on a schedule computed from the planned hand paths when the right
// hand has the end (a loop goes when the cable already out would no longer reach between the hands
// with a little slack): what the pads of a loosened pinch do when the cable is pulled. Before that
// every loop is held (the left hand's pads, a bundle). The schedule is recorded in the plan, the
// rig uses it (the pads loosen as each loop goes), so the bake and the scene agree.
//
// The grips were chosen with the IK (stateless probes of rigPose: the comfortable ones, no joint at
// its limit): hands at chest height (Ilse's shoulders are at 0.99 m seated), the ring's top and
// the ends pinched with the cable leaving past the thumb towards the ring, the tie's end with the
// thumb up. Hands stay clear of the hanging loops: a 9 cm ring is smaller than a hand, every touch
// would push it.
//
// Everything is simulated except the tie (kinematic). Ilse's arms come from one RigTrack (people/
// rig.ts), the single source for the bake and the scene: the simulation's hand frames are the grip
// frames her hands really reached (pose.body.arms[i].grip), her hands are 22 collision capsules
// each (handColliders: a pinch or bundle of the same hand lets its cable through), her torso and
// thighs are capsules too, and the desk top is the floor. A hand going to an end follows that end
// where the simulation has it (a tenth of a second ago): the bake records the end every frame
// (vector "endB") and the ring's geometry and the loops' schedule ("plan"), so the scene builds the
// same RigTrack (pullTrack(plan, endsFrom(bake))).
//
// Coordinates: Ilse sits at the origin facing +z (her left is +x); the desk's top at DESK.height.

import { Bundle, CHARGING, Frame, Pinch, Quat, Rod, V3, add, length as len, normalize, quatRotate, scale, smooth, sub } from '../sim';
import { ILSE } from '../people/cast';
import { Grip, HandRig, Rig, RigTrack, gripFrame, seated } from '../people/rig';
import { handColliders } from '../people/colliders';
import { capsulesOf } from '../people/body3d';
import type { Pose } from '../people/people';
import type { ShotDef } from './types';
import { FIST, Ring, RingSpec, placePoint, placeRing, ringRod, windRing } from './deploy-ring';
import { TIE_POINTS, TieShape, tieAt } from './deploy-tie';

/** the FOH desk in front of Ilse: centre (x, z), size and the height of its top */
export const DESK = { x: 0, z: 0.62, width: 1.4, depth: 0.7, height: 0.74 };
/** where Ilse sits (pelvis over the floor) and her facing (+z) */
export const SEAT: [number, number] = [0, 0];
export const YAW = Math.PI;

/**
 * The ring: 4 loops over-under, Ø 9 cm, the start end 7 cm out of the hand's middle (plug
 * included), the end tail 21 cm (it hangs out of the ring below, its plug just above the desk),
 * 1.44 m in all: a common phone cable. (Seated, Ilse's hands get about 0.95 m apart at chest
 * height: a 1.8 m cable would stay a heap between them.)
 */
export const SHORT_RING: RingSpec = { cable: CHARGING, loop: 0.26, pattern: 'ouou', lead: 0.05, tail: 0.17, spacing: 0.01, press: 0.75, pressTime: 3 };
/** the velcro tie: band length, width, thickness; where it lives on the start end (m from the plug's tip) */
export const TIE = { length: 0.17, width: 0.012, thickness: 0.0015, s: 0.094 };

/** the ring as the factory made it: its face looks at Ilse, the start end sticks out to her left */
const QRING: Quat = [0, 0, 0, 1];
/** where the top of the ring (the middle of the bunch at the top) is: chest height, in front of her, over the desk's front edge */
const HOLD: V3 = [0.0, 0.96, 0.34];

/** shot times (s) */
export const PULL_T = {
  /** right hand from above to the tie's end, pinches it, pulls it up out of the eyelet, lets go */
  reach: 0.3, pinch: 0.9, unfold: 1.35, letTie: 1.5,
  /** the right hand goes round the ring (well clear of it, on her right) down to the other end, following it, and closes on it */
  side: 1.85, under: 2.3, takeB: 3.0,
  /** both hands hold still with their ends (they are pointed out) */
  pull0: 5.0,
  /** hands apart: the loops leave the left hand one after the other and open; then the hands sink, the cable's middle lies on the desk */
  pull1: 8.0, lay0: 8.4, lay1: 9.4,
  end: 10.6,
};
const T = PULL_T;

// ---------------------------------------------------------------- the plan (recorded in the bake)

/** slots of the plan vector: the ring's geometry, measured when the shot is built, and the loops' schedule */
const SLOTS = {
  /** the left hand's pinch on the ring's top */
  left: 0,
  /** the tie: centre of the ellipse round the bunch, its axes (e, v: v up, the eyelet's side), the strands' direction (w), half axes */
  tieC: 3, tieE: 6, tieV: 9, tieW: 12, tieA: 15, tieB: 16,
  /** when each loop leaves the left hand (0 = not yet planned), loop 0 (at the hand) … loop 3 (the front one, it goes first) */
  rel: 17,
  size: 21,
} as const;
const NLOOPS = SHORT_RING.pattern.length;
export type Plan = Float64Array;
const v3 = (p: Plan, k: number): V3 => [p[k], p[k + 1], p[k + 2]];
const put = (p: Plan, k: number, v: V3) => {
  p[k] = Math.fround(v[0]);
  p[k + 1] = Math.fround(v[1]);
  p[k + 2] = Math.fround(v[2]);
};
/** when loop k leaves the left hand (Infinity until planned) */
export const releaseAt = (p: Plan, k: number) => (p[SLOTS.rel + k] > 0 ? p[SLOTS.rel + k] : Infinity);
/**
 * Where the two ends are (grip frames of the cable 2.5 cm from each plug: the start end, 0, for the
 * right hand, the other, 1, for the left), recorded every frame. A hand going to an end follows it
 * with LAG: the bake knows that past, the scene reads it back from the bake.
 */
export type Ends = (which: 0 | 1, t: number) => Grip;
export const LAG = 4 / 60;

// ---------------------------------------------------------------- the ring

let cached: { ring: Ring; state: ReturnType<typeof placeRing>; d: V3 } | null = null;

/** the ring, laid out and pressed (deploy-ring.ts), turned and moved so its top is at HOLD */
export function shortRing() {
  if (cached) return cached;
  const ring = windRing(SHORT_RING);
  const d = sub(HOLD, add(quatRotate(QRING, sub(ring.top.c, FIST)), FIST));
  cached = { ring, state: placeRing(ring.state, d, QRING, DESK.height), d };
  return cached;
}

// ---------------------------------------------------------------- the tie (kinematic)

export type { TieShape };
export { TIE_POINTS };

/**
 * The tie at shot time t (deploy-tie.ts): round the bunch at the ring's top, the right hand pulls its
 * tab up out of the eyelet and lets go; when the last loop has left the left hand its band hangs from
 * the cable it lives on: `root` is that cable point and its direction (from the simulation; without
 * it the eyelet stays put).
 */
export function tieShape(p: Plan, t: number, root?: { p: V3; d: V3 }): TieShape {
  const g = { c: v3(p, SLOTS.tieC), e: v3(p, SLOTS.tieE), v: v3(p, SLOTS.tieV), w: v3(p, SLOTS.tieW), a: p[SLOTS.tieA], b: p[SLOTS.tieB] };
  return tieAt(g, TIE, { ...T, drop: releaseAt(p, 0) }, t, { root, cableR: CHARGING.od / 2, floorY: DESK.height });
}

const lerpV = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];

// ---------------------------------------------------------------- Ilse's hands

const ease = (t: number, a: number, b: number) => smooth((t - a) / (b - a));
/** palm down and towards her (the comfortable pinch for these grips, IK probes) */
const PALM: V3 = normalize([0, -0.7, 0.7]);
/** the right hand at rest: open, on the desk's front edge (an open pinch, so every move is between grip frames) */
const REST_R = gripFrame([-0.19, DESK.height + 0.05, 0.33], normalize([1, 0, 0.3]), normalize([0, -0.7, -0.7]));
/**
 * Where the hands end the pull: at chest height, wide apart in front of her (elbows still bent), the
 * cable leaving the pads towards the other hand and a little down (it hangs between them); then
 * lower: the cable's middle lies on the desk.
 */
const PULL_L = gripFrame([0.48, 0.95, 0.36], normalize([-0.7, -0.3, 0.8]), [0, -1, 0]);
const PULL_R = gripFrame([-0.5, 0.95, 0.36], normalize([0.7, -0.3, 0.8]), [0, -1, 0]);
const LAY_L = gripFrame([0.47, 0.9, 0.39], normalize([-1, -0.35, 0.3]), [0, -1, 0]), LAY_R = gripFrame([-0.49, 0.9, 0.39], normalize([1, -0.35, 0.3]), [0, -1, 0]);

/** a grip frame between two (p eased linearly by u, q slerped) */
const mixGrip = (a: Grip, b: Grip, u: number): Grip => ({ p: lerpV(a.p, b.p, u), q: slerpQ(a.q, b.q, u) });

/**
 * Ilse's rig at shot time t for the ring's geometry and schedule (plan) and the ends' recorded
 * frames. Pure: the bake and the scene call it with the same data and get the same arms (RigTrack).
 * Every hand moves between grip frames (open or closed), so its target never jumps.
 */
export function pullRig(p: Plan, ends: Ends) {
  /** left hand: a pinch on the ring's top, the cable leaving past the thumb towards her right (the ring) */
  const leftGrip = (): Grip => gripFrame(v3(p, SLOTS.left), normalize([-1, 0.15, 0]), PALM);
  /** an end where it was LAG ago, shifted (the hand comes from the side) */
  const end = (t: number, off: V3 = [0, 0, 0]): Grip => {
    const g = ends(1, Math.max(0, t - LAG));
    return { p: add(g.p, off), q: g.q };
  };
  /** the tie's end in the right hand's pads, thumb up, the hand on her right of it */
  const tieGrip = (t: number): Grip => gripFrame(add(tieShape(p, t).tip, [0, -0.01, 0]), normalize([0, 1, 0.3]), [1, 0, 0]);
  /**
   * On the way round the ring, open: up and out to her right of it, then down beside it to the
   * other end, 7 cm in front of it on her side, so the open pads come onto the cable from where
   * the gap between thumb and index finger faces (not across it)
   */
  const side = (): Grip => gripFrame(add(tieShape(p, T.letTie).tip, [-0.14, 0.0, -0.03]), normalize([0, 1, 0.3]), [1, 0, 0]);
  const under = (): Grip => {
    const g = end(T.side);
    return { p: add(g.p, [-0.02, 0, -0.07]), q: g.q };
  };
  const PINCH = { hold: 'pinch' as const, radius: CHARGING.od / 2 };

  /** the right hand's path from the end it took to the pull's end (out and up a little first, clear of the ring) */
  const pullR = (t: number): Grip => {
    const held = end(T.takeB);
    const u = ease(t, T.pull0, T.pull1);
    const g = mixGrip(held, PULL_R, u);
    // bow outwards a little at first: the hand moves away from the ring before it rises
    return { p: add(g.p, [-0.05 * Math.sin(Math.PI * u), 0, 0]), q: g.q };
  };
  const right = (t: number): HandRig => {
    if (t < T.reach) return { grip: REST_R, ...PINCH, open: 1, free: 0.6 };
    // up past the ring on her right, then from above to the tie's end, closing on it; up out of the
    // eyelet; let go. (The end sticks up 10 cm: the curled fingers below the pads stay clear of the loops.)
    const above: Grip = { p: add(tieGrip(T.pinch).p, [-0.09, 0.05, -0.02]), q: tieGrip(T.pinch).q };
    const tm = (T.reach + T.pinch) / 2;
    if (t < tm) return { grip: mixGrip(REST_R, above, ease(t, T.reach, tm)), ...PINCH, radius: TIE.thickness / 2, open: 1, free: 0.4 };
    if (t < T.pinch) return { grip: mixGrip(above, tieGrip(T.pinch), ease(t, tm, T.pinch - 0.05)), ...PINCH, radius: TIE.thickness / 2, open: 1 - ease(t, T.pinch - 0.2, T.pinch), free: 0.4 };
    if (t < T.letTie) return { grip: tieGrip(t), ...PINCH, radius: TIE.thickness / 2, open: ease(t, T.unfold, T.letTie), free: 0.4 };
    // round the ring, well clear of it, and down to the other end, following it, closing on it
    if (t < T.side) return { grip: mixGrip(tieGrip(T.letTie), side(), ease(t, T.letTie, T.side)), ...PINCH, open: 1, free: 0.6 };
    if (t < T.under) return { grip: mixGrip(side(), under(), ease(t, T.side, T.under)), ...PINCH, open: 1, free: 0.6 };
    if (t < T.takeB) {
      const u = ease(t, T.under, T.takeB - 0.1);
      return { grip: mixGrip(under(), end(t), u), ...PINCH, open: 1 - ease(t, T.takeB - 0.25, T.takeB), free: 0.6 };
    }
    const g = mixGrip(pullR(t), LAY_R, ease(t, T.lay0, T.lay1));
    return { grip: g, ...PINCH, open: 0, free: 0.5 };
  };

  const left = (t: number): HandRig => {
    // the ring's top in the pads (8 mm thick); every loop that goes loosens them a little (the pads
    // open, the bunch gets thinner), until only the start end is left between them
    let radius = 0.008, open = 0;
    for (let k = 0; k < NLOOPS; k++) {
      const r = releaseAt(p, k);
      if (t <= r) continue;
      radius -= ((0.008 - PINCH.radius) / NLOOPS) * ease(t, r, r + 0.4);
      // (the last one wider and longer: nothing is left to keep it between the pads but the start end)
      open += (k === 0 ? 0.8 : 0.45) * Math.sin(Math.PI * Math.min(1, (t - r) / (k === 0 ? 0.7 : 0.45)));
    }
    const g = mixGrip(mixGrip(leftGrip(), PULL_L, ease(t, T.pull0, T.pull1)), LAY_L, ease(t, T.lay0, T.lay1));
    return { grip: g, ...PINCH, radius, open: Math.min(0.8, open), free: 0.5 };
  };

  const rig = (t: number): Rig => {
    const ring = v3(p, SLOTS.tieC);
    const look = t < T.pull0 ? lerpV(ring, [0.0, 0.88, 0.45], 0.5 * ease(t, T.takeB, T.pull0)) : lerpV([0.0, 0.88, 0.45], [0, 0.78, 0.48], ease(t, T.pull1, T.lay1));
    return { ...seated(ILSE, SEAT, YAW, 0.5), look, hands: [left(t), right(t)] };
  };
  return { rig, left, right };
}

const slerpQ = (a: Quat, b: Quat, u: number): Quat => {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1;
  d *= s;
  if (d > 0.9995) {
    const q: Quat = [a[0] + (s * b[0] - a[0]) * u, a[1] + (s * b[1] - a[1]) * u, a[2] + (s * b[2] - a[2]) * u, a[3] + (s * b[3] - a[3]) * u];
    const l = Math.hypot(...q);
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  }
  const th = Math.acos(d), sn = Math.sin(th), wa = Math.sin((1 - u) * th) / sn, wb = (s * Math.sin(u * th)) / sn;
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb, a[3] * wa + b[3] * wb];
};

/** the RigTrack the bake and the scene share (60 fps, from 0) */
export const pullTrack = (p: Plan, ends: Ends) => new RigTrack(ILSE, pullRig(p, ends).rig, 0, 60);

/** the plan and the ends from a bake (the scene) */
export const planFrom = (vector: (name: string, t: number) => ArrayLike<number>): Plan => Float64Array.from(vector('plan', T.end));
export const endsFrom = (frame: (name: string, t: number) => Frame): Ends => (_which, t) => frame('endB', t);

/**
 * The loops' schedule: loop k (the front one first) leaves the left hand when the cable already
 * out (from the top of the loop behind it to the right hand) would not reach between the PLANNED
 * hand positions with a little slack any more; at least 0.4 s apart, so they open one after the
 * other. `free(k)`: that cable's length.
 */
function schedule(rig: ReturnType<typeof pullRig>, free: (k: number) => number): number[] {
  const out = new Array<number>(NLOOPS).fill(T.pull1);
  let tPrev = T.pull0 - 0.4;
  for (let k = NLOOPS - 1; k >= 0; k--) {
    let t = Math.max(T.pull0, tPrev + 0.4);
    for (; t < T.pull1; t += 1 / 120) {
      const span = len(sub(rig.right(t).grip?.p ?? [0, 0, 0], rig.left(t).grip?.p ?? [0, 0, 0]));
      // (the last loop a little earlier: the hands still have some way to go and pull it open)
      if (free(k) < 1.04 * span + (k === 0 ? 0.15 : 0.05)) break;
    }
    out[k] = Math.min(t, T.pull1);
    tPrev = out[k];
  }
  return out;
}

// ---------------------------------------------------------------- the shot

/** the hands' capsule groups (pinch / bundle `hand`) */
const LEFT = 0, RIGHT = 1;
/** soft fingers (they give way to slow squeezes, PinchSpec docs) */
const SOFT = { index: 0.3, middle: 0.3, ring: 0.3, little: 0.3, thumb: 0.3 };

/**
 * Frames of the ends recorded as the bake stores them (float32) and read back with
 * BakedRod.vector's interpolation, so the bake's and the scene's rigs see the same numbers.
 */
function endHistory() {
  const hist: [number[], number[]] = [[], []];
  const push = (which: 0 | 1, f: Frame): number[] => {
    const v = [...f.p, ...f.q].map(Math.fround);
    hist[which].push(...v);
    return v;
  };
  const ends: Ends = (which, t) => {
    const h = hist[which], frames = h.length / 7;
    const u = Math.min(frames - 1, Math.max(0, t * 60)), f0 = Math.floor(u), f1 = Math.min(frames - 1, f0 + 1), a = u - f0;
    const o0 = 7 * f0, o1 = 7 * f1, o = new Array<number>(7);
    for (let i = 0; i < 3; i++) o[i] = h[o0 + i] + (h[o1 + i] - h[o0 + i]) * a;
    // the quaternion as BakedRod.vector does it (nlerp the short way)
    const dq = h[o0 + 3] * h[o1 + 3] + h[o0 + 4] * h[o1 + 4] + h[o0 + 5] * h[o1 + 5] + h[o0 + 6] * h[o1 + 6], sg = dq < 0 ? -1 : 1;
    let l = 0;
    for (let i = 3; i < 7; i++) {
      o[i] = h[o0 + i] + (sg * h[o1 + i] - h[o0 + i]) * a;
      l += o[i] * o[i];
    }
    l = 1 / Math.sqrt(l || 1);
    return { p: [o[0], o[1], o[2]], q: [o[3] * l, o[4] * l, o[5] * l, o[6] * l] };
  };
  return { push, ends };
}

export const deployPull: ShotDef = {
  id: 'deploy-pull',
  duration: T.end,
  substeps: 40,
  iterations: 3,
  build() {
    const { ring, state, d } = shortRing();
    const rod = ringRod(ring, state, SHORT_RING);
    const plan: Plan = new Float64Array(SLOTS.size);
    const P = (i: number): V3 => [rod.x[3 * i], rod.x[3 * i + 1], rod.x[3 * i + 2]];
    /** a point of the ring's top in factory coordinates (x along the strands, from the middle of the bunch) */
    const top = (x: number): V3 => placePoint([FIST[0] + x, ring.top.c[1], ring.top.c[2]], d, QRING);
    // the left hand pinches the top on the start end's side (her left), where the start end and the
    // loops' ends come together; the tie sits on her right of the hand, round the loops' starts
    put(plan, SLOTS.left, top(0.012));
    const tc = top(-0.012);
    put(plan, SLOTS.tieC, tc);
    put(plan, SLOTS.tieE, [0, 0, 1]);
    put(plan, SLOTS.tieV, [0, 1, 0]);
    put(plan, SLOTS.tieW, [1, 0, 0]);

    // the other end: the cable 2.5 cm from its plug, leaving past the thumb up, towards the ring;
    // the palm out to her right
    const sB = ring.sCable[1] - 0.018;
    const endFrame = (r: Rod): Frame => gripFrame(r.pointAt(sB), scale(r.tangentAt(sB), -1), [1, 0, 0]);
    const { push, ends } = endHistory();

    const track = pullTrack(plan, ends);
    const rigF = pullRig(plan, ends);
    const poseCache = new Map<number, Pose>();
    const poseAt = (t: number): Pose => {
      let q = poseCache.get(t);
      if (!q) {
        if (poseCache.size > 8) poseCache.clear();
        q = track.pose(Math.max(0, t));
        poseCache.set(t, q);
      }
      return q;
    };
    const reached = (t: number, side: 0 | 1): Frame => {
      const g = poseAt(t).body.arms?.[side].grip;
      return g ? { p: g.p, q: g.q } : { p: [0, 0, 0], q: [0, 0, 0, 1] };
    };
    // the left hand holds the top of every loop and the start end between its pads (the part of
    // the factory's fist on the start end's side); the plug end itself is free and droops. The
    // pre-roll starts at -1.5 s: the hand holds from then on.
    rod.time = -1.5;
    const pads: Bundle = rod.bundle({ frame: (t) => reached(t, 0), hand: LEFT, blend: 0.001 });
    const t0 = top(0);
    for (let j = rod.segmentAt(ring.sCable[0] + 0.005); j < rod.ns; j++) {
      const c: V3 = [rod.c[3 * j], rod.c[3 * j + 1], rod.c[3 * j + 2]];
      const fx = c[0] - t0[0];
      if (c[1] < t0[1] - 0.02 || fx < -0.002 || fx > 0.026) continue;
      pads.add(rod.sNode[j], rod.sNode[j + 1]);
    }
    // body: torso, thighs (not the hands: they are the 22 capsules each)
    rod.setCapsules((t) => {
      const pose = poseAt(t);
      const body = capsulesOf(pose).filter((c) => c.part === 'torso' || c.part === 'legL' || c.part === 'legR');
      return [...body, ...handColliders(pose, 0, { group: LEFT, soft: SOFT }), ...handColliders(pose, 1, { group: RIGHT, soft: SOFT })];
    });
    // let the ring hang still in the hand before the shot starts (the plug end droops)
    for (let f = 0; f < 90; f++) rod.step(1 / 60, 40);
    rod.time = 0;
    // the tie's ellipse round the strands at its place, as they hang now (the right hand reads it
    // from T.reach on, nothing before)
    let a = 0, b = 0;
    for (let i = ring.cable[0]; i <= ring.cable[1]; i++) {
      const q = sub(P(i), tc);
      if (Math.abs(q[0]) > 0.005 || q[1] < -0.025 || Math.abs(q[2]) > 0.04) continue;
      a = Math.max(a, Math.abs(q[2]));
      b = Math.max(b, Math.abs(q[1]));
    }
    plan[SLOTS.tieA] = Math.fround(a + ring.rc + 0.001);
    plan[SLOTS.tieB] = Math.fround(Math.max(b, 2 * ring.rc) + ring.rc + 0.001);

    // the ends are held in pinches that let the cable turn in the pads (rolls: false): the hands
    // turn as they pull, but a pinch does not wring the cable
    let pinB: Pinch | null = null, pinA: Pinch | null = null;
    let planned = false;
    const gone = new Array<boolean>(NLOOPS).fill(false);
    const script = (r: Rod, t: number) => {
      if (!pinB && t >= T.takeB) pinB = r.pinch({ frame: (tt) => reached(tt, 1), s: sB, mode: 'held', hand: RIGHT, blend: 0.12, rolls: false });
      // the schedule, once the right hand has the end (its path from there is known): the cable
      // already out when loop k goes is from the top of loop k (its end, in the pads) to the right hand
      if (!planned && t >= T.takeB + 2 / 60) {
        const rel = schedule(rigF, (k) => sB - ring.sLoops[k][1] + 0.012);
        rel.forEach((x, k) => (plan[SLOTS.rel + k] = Math.fround(x)));
        planned = true;
      }
      if (!planned) return;
      for (let k = NLOOPS - 1; k >= 0; k--) {
        if (gone[k] || t < releaseAt(plan, k)) continue;
        // the loop slips out of the loosened pads (quickly: pieces a bundle still holds do not
        // collide with each other); the last one leaves only the start end, from now on a pinch
        const s0 = k === 0 ? ring.sCable[0] + 0.005 : ring.sLoops[k][0];
        if (k === 0) {
          const g = reached(t, 0);
          pinA = r.pinch({ frame: (tt) => reached(tt, 0), s: r.closestPoint(g.p, 0, ring.sLoops[0][0]).s, mode: 'held', hand: LEFT, blend: 0.3, rolls: false, maxGripDistance: 0.03 });
        }
        pads.release(s0, ring.sLoops[k][1] + (k === NLOOPS - 1 ? 1 : 0), 0.06);
        if (k === 0) pads.release(-Infinity, Infinity, 0.06);
        gone[k] = true;
      }
    };
    const lowest = (r: Rod) => {
      let m = Infinity;
      for (let i = ring.cable[0]; i <= ring.cable[1]; i++) m = Math.min(m, r.x[3 * i + 1]);
      return m - DESK.height;
    };
    const arm = (t: number, side: 0 | 1) => poseAt(t).body.arms?.[side].report;
    // twist and writhe once per recorded frame; the largest jump of their sum (the linking number of
    // the cable with its ends' frames) between two frames: a strand passing through another
    // changes it by ±2 at once, nothing else by more than a few hundredths
    let twr = { t: NaN, tw: 0, wr: 0 }, lkPrev: number | null = null, lkMax = 0;
    const tw_wr = (r: Rod, t: number) => {
      if (twr.t !== t) {
        twr = { t, tw: r.twistTurns(), wr: r.writhe(ring.cable[0], ring.cable[1]) };
        const lk = twr.tw + twr.wr;
        if (lkPrev !== null) lkMax = Math.max(lkMax, Math.abs(lk - lkPrev));
        lkPrev = lk;
      }
      return twr;
    };
    return {
      rod,
      script,
      tracks: {
        cable0: () => ring.cable[0],
        cable1: () => ring.cable[1],
        tieNode: (r) => r.segmentAt(TIE.s),
        twist: (r, t) => tw_wr(r, t).tw,
        writhe: (r, t) => tw_wr(r, t).wr,
        /** the largest jump of twist + writhe between two frames so far (turns): ≥ 1 is a strand passage */
        lkJump: (r, t) => (tw_wr(r, t), lkMax),
        low: lowest,
        /** loops still in the left hand */
        inHand: () => gone.filter((g) => !g).length,
        // the arms: how far each hand is from its target (mm) and its cable direction off (°)
        ikL: (_, t) => (arm(t, 0)?.posError ?? 0) * 1000,
        ikR: (_, t) => (arm(t, 1)?.posError ?? 0) * 1000,
        axL: (_, t) => ((arm(t, 0)?.axisErrors[0] ?? 0) * 180) / Math.PI,
        axR: (_, t) => ((arm(t, 1)?.axisErrors[0] ?? 0) * 180) / Math.PI,
        gripA: () => (pinA ? pinA.gripDistance : -1),
        gripB: () => (pinB ? pinB.gripDistance : -1),
      },
      vectors: {
        plan: { size: SLOTS.size, fn: () => plan },
        endB: { size: 7, quats: [3], fn: (r) => push(1, endFrame(r)) },
      },
    };
  },
};
