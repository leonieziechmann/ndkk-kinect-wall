// Stage 1, item 3: a short cable laid out again, done right. Ilse sits in her wheelchair at the FOH
// desk with a short over-under ring of a black charging cable (CHARGING preset, Ø 4 mm, 6 loops of
// Ø 9 cm, 2 m with the plugs), holding it at its top between the thumb and index finger of her
// left hand, its face towards her; the start end runs through her fingers, its plug sticks out to
// her left. The ring is closed with a velcro tie that lives on that end (8 cm from the plug). Her
// right hand comes from above, pinches the tie's end and pulls it up out of its eyelet: the band
// comes loose. The right hand goes round the ring to the other end, which hangs out of the ring
// below, and takes it. Both ends are outside the ring. The left hand opens but keeps the start end:
// the loops slip out of the loose tie (it stays on the cable) and the ring hangs between the hands.
// She pulls her hands apart: the loops open one after the other, the cable ends up hanging calm
// between her hands, its middle on the desk, without curls (the +1 and -1 turns of the über and
// unter loops cancel).
//
// The grips were chosen with the IK (stateless probes of rigPose: the comfortable ones, no joint at
// its limit): the ring's top and the ends are pinched with the cable leaving past the thumb towards
// the ring, the tie's end with the thumb up. Hands stay clear of the hanging loops: a 9 cm ring is
// smaller than a hand, every touch would push it. (A ring this light, hung from its start end
// alone, unrolls under its own weight in the simulation: so the left hand keeps the loops until
// the right hand has the other end.)
//
// Everything is simulated except the tie (kinematic). Ilse's arms come from one RigTrack (people/
// rig.ts), the single source for the bake and the scene: the simulation's hand frames are the grip
// frames her hands really reached (pose.body.arms[i].grip), her hands are 22 collision capsules
// each (handColliders: a pinch or bundle of the same hand lets its cable through), her torso and
// thighs are capsules too, and the desk top is the floor. A hand going to an end follows that end
// where the simulation has it (a tenth of a second ago): the bake records the end every frame
// (vector "endB") and the ring's geometry ("plan"), so the scene builds the same RigTrack
// (pullTrack(plan, endsFrom(bake))).
//
// Coordinates: Ilse sits at the origin facing +z (her left is +x); the desk's top at DESK.height.

import { Bundle, CHARGING, Frame, Pinch, Quat, Rod, V3, add, cross, dot, normalize, quatFromAxisAngle, quatRotate, scale, smooth, sub } from '../sim';
import { ILSE } from '../people/cast';
import { Grip, HandRig, Rig, RigTrack, gripFrame, seated } from '../people/rig';
import { handColliders } from '../people/colliders';
import { capsulesOf } from '../people/body3d';
import type { Pose } from '../people/people';
import type { ShotDef } from './types';
import { FIST, Ring, RingSpec, placePoint, placeRing, ringRod, windRing } from './deploy-ring';

/** the FOH desk in front of Ilse: centre (x, z), size and the height of its top */
export const DESK = { x: 0, z: 0.62, width: 1.4, depth: 0.7, height: 0.74 };
/** where Ilse sits (pelvis over the floor) and her facing (+z) */
export const SEAT: [number, number] = [0, 0];
export const YAW = Math.PI;

/**
 * The ring: 4 loops over-under, Ø 9 cm, the start end 7 cm out of the hand's middle (plug
 * included), the end tail 22 cm (it hangs below the ring), 1.45 m in all: a common phone cable.
 * (Seated, Ilse's hands reach about 1.1 m apart: a 1.8 m cable would keep its last loop lying on
 * the desk, a curl; this one opens completely.)
 */
export const SHORT_RING: RingSpec = { cable: CHARGING, loop: 0.29, pattern: 'ouou', lead: 0.07, tail: 0.22, spacing: 0.01, press: 0.5, pressTime: 3 };
/** the velcro tie: band length, width, thickness; where it lives on the start end (m from the plug's tip) */
export const TIE = { length: 0.22, width: 0.012, thickness: 0.0015, s: 0.082 };

/** the ring as the factory made it: its face looks at Ilse, the start end sticks out to her left */
const QRING: Quat = [0, 0, 0, 1];
/** where the top of the ring (the middle of the bunch at the top) is */
const HOLD: V3 = [0.02, 1.13, 0.42];

/** shot times (s) */
export const PULL_T = {
  /** right hand from above to the tie's end, pinches it, pulls it up out of the eyelet, lets go */
  reach: 0.25, pinch: 0.85, unfold: 1.35, letTie: 1.5,
  /** the right hand goes round the ring (well clear of it, on her right) down to the other end, following it, and closes on it */
  side: 1.85, under: 2.3, takeB: 3.0,
  /** the right hand draws its end out to the side (not under the ring any more) */
  out: 3.6,
  /** the left hand opens but keeps the start end: the ring falls and hangs between the hands */
  drop: 3.7,
  /** both hands hold still with their ends (they are pointed out) */
  pull0: 4.9,
  /** hands apart: the loops open; then the hands sink a little, the cable lies calm */
  pull1: 7.9, lay1: 8.9,
  end: 10.2,
};
const T = PULL_T;

// ---------------------------------------------------------------- the plan (recorded in the bake)

/** slots of the plan vector: the ring's geometry, measured when the shot is built */
const SLOTS = {
  /** the left hand's pinch on the ring's top */
  left: 0,
  /** the tie: centre of the ellipse round the bunch, its axes (e, v: v up, the eyelet's side), the strands' direction (w), half axes */
  tieC: 3, tieE: 6, tieV: 9, tieW: 12, tieA: 15, tieB: 16,
  size: 17,
} as const;
export type Plan = Float64Array;
const v3 = (p: Plan, k: number): V3 => [p[k], p[k + 1], p[k + 2]];
const put = (p: Plan, k: number, v: V3) => {
  p[k] = Math.fround(v[0]);
  p[k + 1] = Math.fround(v[1]);
  p[k + 2] = Math.fround(v[2]);
};
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

/** a point of the ellipse round the bunch (centre c, axes e and v) at angle φ (0 = towards v, the eyelet), grown by `off` */
const onEllipse = (c: V3, e: V3, v: V3, a: number, b: number, phi: number, off: number): V3 => add(c, add(scale(e, (a + off) * Math.sin(phi)), scale(v, (b + off) * Math.cos(phi))));

export interface TieShape {
  /** the band's centre line from the eyelet to its end (TIE_POINTS points) */
  pts: V3[];
  /** its end, where the right hand pinches it */
  tip: V3;
  /** the band's width direction */
  side: V3;
}
export const TIE_POINTS = 90;

/**
 * The tie at shot time t. Closed: once round the bunch at the ring's top, its end through the
 * eyelet and back over the band. The right hand pulls the end up out of the eyelet and lets go: it
 * flops over, the band lies loose round the ring. When the ring is let go (T.drop) its loops slip
 * out of the loose band, which then hangs from the cable it lives on: `root` is that cable point and
 * its direction (from the simulation; without it the eyelet stays put).
 */
export function tieShape(p: Plan, t: number, root?: { p: V3; d: V3 }): TieShape {
  const c0 = v3(p, SLOTS.tieC), a = p[SLOTS.tieA], b = p[SLOTS.tieB];
  const E = v3(p, SLOTS.tieE), V = v3(p, SLOTS.tieV), W = v3(p, SLOTS.tieW);
  /** where the end sticks out once it is out of the eyelet: up */
  const out0 = normalize(add(V, [0, 1.5, 0]));
  const ell = (c: V3, phi: number, off: number) => onEllipse(c, E, V, a, b, phi, off);
  const th = TIE.thickness, L = TIE.length, n = TIE_POINTS, ds = L / (n - 1);
  const fold = 1 - smooth((t - T.pinch) / (T.unfold - T.pinch));
  const loose = smooth((t - T.letTie) / 0.4);
  const hang = smooth((t - T.drop - 0.1) / 0.5);
  // the loose band lies wider round the bunch and sags a little
  const c = add(c0, [0, -0.003 * loose, 0]), off = th / 2 + 0.005 * loose;
  const M = 360;
  const arc = new Float64Array(M + 1);
  for (let k = 1; k <= M; k++) arc[k] = arc[k - 1] + Math.hypot(...sub(ell(c, (2 * Math.PI * k) / M, off), ell(c, (2 * Math.PI * (k - 1)) / M, off)));
  const turn = arc[M];
  const phiAt = (s: number) => {
    let k = 0;
    while (k < M - 1 && arc[k + 1] < s) k++;
    return ((k + (s - arc[k]) / Math.max(1e-9, arc[k + 1] - arc[k])) / M) * 2 * Math.PI;
  };
  const eye = ell(c, 0, off);
  // once let go the end flops over, to her right and down
  const down = normalize([-0.5, -0.8, 0]);
  const pts: V3[] = [];
  for (let k = 0; k < n; k++) {
    const s = k * ds;
    if (s <= turn) {
      pts.push(ell(c, phiAt(s), off));
      continue;
    }
    const e = s - turn;
    // through the eyelet and back over the band (closed) …
    const folded = e < 0.006 ? ell(c, 0, th * (1.5 + e / 0.006)) : ell(c, -(e - 0.006) / ((a + b) * 0.95), th * 2.6);
    // … or out of it, straight up; flopped over once let go
    const out = add(eye, scale(out0, e));
    const flop = add(add(eye, scale(out0, Math.min(e, 0.01))), scale(down, Math.max(0, e - 0.01)));
    pts.push(lerpV(lerpV(out, folded, fold), flop, loose));
  }
  // the loops slipped out of it: the band hangs from the cable it lives on (a small loop round the
  // cable, then down)
  let side = W;
  if (hang > 0 && root) {
    const d = normalize(root.d), r = CHARGING.od / 2 + th;
    const e1 = normalize(sub([0, -1, 0], scale(d, -d[1]))), e2 = cross(d, e1);
    const loop = 2 * Math.PI * r;
    for (let k = 0; k < n; k++) {
      const s = k * ds;
      let h: V3;
      if (s < loop) {
        const ph = s / r;
        h = add(root.p, add(scale(e1, r * Math.cos(ph)), add(scale(e2, r * Math.sin(ph)), scale(d, 0.002 * ph))));
      } else {
        const e = s - loop, bottom = add(root.p, scale(e1, r));
        h = add(bottom, add([0, -e, 0], scale(e2, 0.012 * Math.sin(e * 14) * Math.min(1, e / 0.03))));
      }
      pts[k] = lerpV(add(pts[k], sub(root.p, eye)), h, hang);
      pts[k][1] = Math.max(pts[k][1], DESK.height + th / 2);
    }
    side = normalize(lerpV(W, d, hang));
  }
  return { pts, tip: pts[n - 1], side };
}

const lerpV = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];

// ---------------------------------------------------------------- Ilse's hands

const ease = (t: number, a: number, b: number) => smooth((t - a) / (b - a));
/** palm down and towards her (the comfortable pinch for these grips, IK probes) */
const PALM: V3 = normalize([0, -0.7, 0.7]);
/** the right hand at rest: open, on the desk's front edge (an open pinch, so every move is between grip frames) */
const REST_R = gripFrame([-0.19, DESK.height + 0.05, 0.36], normalize([1, 0, 0.3]), normalize([0, -0.7, -0.7]));
/** where the hands end: wide apart (the cable hangs free, all loops open), the cable leaving the pads forward; then lower: its middle lies on the desk */
const PULL_L = gripFrame([0.56, 1.2, 0.38], normalize([-0.3, -0.2, 1]), PALM), PULL_R = gripFrame([-0.56, 1.2, 0.38], normalize([0.3, -0.2, 1]), PALM);
const LAY_L: Grip = { p: [0.5, 1.03, 0.42], q: PULL_L.q }, LAY_R: Grip = { p: [-0.5, 1.03, 0.42], q: PULL_R.q };

/** a grip frame between two (p eased linearly by u, q slerped) */
const mixGrip = (a: Grip, b: Grip, u: number): Grip => ({ p: lerpV(a.p, b.p, u), q: slerpQ(a.q, b.q, u) });

/**
 * Ilse's rig at shot time t for the ring's geometry (plan) and the ends' recorded frames. Pure:
 * the bake and the scene call it with the same data and get the same arms (RigTrack). Every hand
 * moves between grip frames (open or closed), so its target never jumps.
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
  const tieGrip = (t: number): Grip => gripFrame(add(tieShape(p, t).tip, [0, -0.008, 0]), normalize([0, 1, 0.3]), [1, 0, 0]);
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
    const held = end(T.takeB), out: Grip = { p: add(held.p, [-0.07, 0.02, 0]), q: held.q };
    const g = mixGrip(mixGrip(mixGrip(held, out, ease(t, T.takeB + 0.1, T.out)), PULL_R, ease(t, T.pull0, T.pull1)), LAY_R, ease(t, T.pull1, T.lay1));
    return { grip: g, ...PINCH, open: 0, free: 0.5 };
  };

  const left = (t: number): HandRig => {
    // the ring's top in the pads (8 mm thick); then only the start end (it closes a little on it)
    const radius = 0.008 + (PINCH.radius - 0.008) * ease(t, T.drop, T.drop + 0.4);
    const g = mixGrip(mixGrip(leftGrip(), PULL_L, ease(t, T.pull0, T.pull1)), LAY_L, ease(t, T.pull1, T.lay1));
    return { grip: g, ...PINCH, radius, open: 0.3 * Math.sin(Math.PI * ease(t, T.drop, T.drop + 0.4)), free: 0.5 };
  };

  const rig = (t: number): Rig => {
    const ring = v3(p, SLOTS.tieC);
    const look = t < T.pull0 ? lerpV(ring, [0.0, 1.0, 0.45], 0.6 * ease(t, T.letTie, T.drop)) : ([0, 1.0, 0.48] as V3);
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
    let a = 0, b = 0;
    for (let i = ring.loops[0][0]; i <= ring.loops[ring.loops.length - 1][1]; i++) {
      const q = sub(P(i), tc);
      if (Math.abs(q[0]) > 0.005 || q[1] < -0.025) continue;
      a = Math.max(a, Math.abs(q[2]));
      b = Math.max(b, Math.abs(q[1]));
    }
    put(plan, SLOTS.tieC, tc);
    put(plan, SLOTS.tieE, [0, 0, 1]);
    put(plan, SLOTS.tieV, [0, 1, 0]);
    put(plan, SLOTS.tieW, [1, 0, 0]);
    plan[SLOTS.tieA] = Math.fround(a + ring.rc + 0.001);
    plan[SLOTS.tieB] = Math.fround(Math.max(b, 2 * ring.rc) + ring.rc + 0.001);

    // the other end: the cable 2.5 cm from its plug, leaving past the thumb up, towards the ring;
    // the palm out to her right
    const sB = ring.sCable[1] - 0.025;
    const endFrame = (r: Rod): Frame => gripFrame(r.pointAt(sB), scale(r.tangentAt(sB), -1), [1, 0, 0]);
    const { push, ends } = endHistory();

    const track = pullTrack(plan, ends);
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

    // the ends are held in pinches that let the cable turn in the pads (rolls: false): the hands
    // turn as they pull, but a pinch does not wring the cable
    let pinB: Pinch | null = null, pinA: Pinch | null = null;
    let dropped = false;
    const script = (r: Rod, t: number) => {
      if (!pinB && t >= T.takeB) pinB = r.pinch({ frame: (tt) => reached(tt, 1), s: sB, mode: 'held', hand: RIGHT, blend: 0.12, rolls: false });
      if (!dropped && t >= T.drop) {
        // the loops go; the start end stays between the pads (from now on as a pinch)
        const g = reached(t, 0);
        // (the pads held the whole bunch: the start end lies in it up to 2.5 cm from their middle)
        pinA = r.pinch({ frame: (tt) => reached(tt, 0), s: r.closestPoint(g.p, 0, ring.sLoops[0][0]).s, mode: 'held', hand: LEFT, blend: 0.3, rolls: false, maxGripDistance: 0.03 });
        pads.release(-Infinity, Infinity, 0.4);
        dropped = true;
      }
    };
    const lowest = (r: Rod) => {
      let m = Infinity;
      for (let i = ring.cable[0]; i <= ring.cable[1]; i++) m = Math.min(m, r.x[3 * i + 1]);
      return m - DESK.height;
    };
    const arm = (t: number, side: 0 | 1) => poseAt(t).body.arms?.[side].report;
    return {
      rod,
      script,
      tracks: {
        cable0: () => ring.cable[0],
        cable1: () => ring.cable[1],
        tieNode: (r) => r.segmentAt(TIE.s),
        twist: (r) => r.twistTurns(),
        writhe: (r) => r.writhe(ring.cable[0], ring.cable[1]),
        low: lowest,
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
