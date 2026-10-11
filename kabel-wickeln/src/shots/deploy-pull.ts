// Stage 1, item 3: a short cable laid out again, done right. Ilse sits in her wheelchair at the FOH
// desk. On the desk in front of her lies a short over-under ring of a black charging cable
// (CHARGING preset, Ø 4 mm, 6 loops of Ø 9 cm, 2 m with the plugs), closed with a velcro tie that
// lives on its start end (12 cm from the plug). Her right hand pulls the tie's end back out of its
// eyelet: the band lies loose round the ring. The right hand takes the start end next to its plug
// and lifts it: the ring hangs from that hand (its loops slip out of the loose tie, which stays on
// the cable). The left hand takes the other end, which hangs out of the ring below. Both ends are
// outside the ring. She pulls her hands apart: the loops open one after the other, the cable ends
// up hanging calm between her hands, its middle on the desk, without curls (the +1 and -1 turns of
// the über and unter loops cancel).
//
// The grips were chosen with the IK (the comfortable ones, no joint at its limit, see the report):
// the ends are pinched with the cable leaving past the thumb towards the ring, the palm down.
//
// Everything is simulated except the tie (kinematic). Ilse's arms come from one RigTrack (people/
// rig.ts), the single source for the bake and the scene: the simulation's hand frames are the grip
// frames her hands really reached (pose.body.arms[i].grip), her hands are 22 collision capsules
// each (handColliders: a pinch of the same hand lets its cable through), her torso and thighs are
// capsules too, and the desk top is the floor. A hand going to an end follows that end where the
// simulation has it (a tenth of a second ago): the bake records both ends every frame (vectors
// "endA", "endB") and the ring's geometry ("plan"), so the scene builds the same RigTrack
// (pullTrack(plan, endsFrom(bake))).
//
// Coordinates: Ilse sits at the origin facing +z (her left is +x); the desk's top at DESK.height.

import { CHARGING, Capsule, Frame, Pinch, Quat, Rod, V3, add, cross, dot, normalize, quatRotate, scale, smooth, sub } from '../sim';
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

/** the ring: 6 loops over-under, Ø 9 cm, the start end 13 cm out of the hand, the end tail 16 cm */
export const SHORT_RING: RingSpec = { cable: CHARGING, loop: 0.29, pattern: 'ououou', lead: 0.13, tail: 0.16, spacing: 0.01, press: 0.5, pressTime: 3 };
/** the velcro tie: band length, width, thickness; where it lives on the start end (m from the plug's tip) */
export const TIE = { length: 0.18, width: 0.012, thickness: 0.0015, s: 0.119 };

/**
 * The ring lies flat on the desk: the factory's stack axis (z) points up, the side the hand held
 * (factory +y) away from her, so the start end (factory +x) lies to her right and the end tail
 * runs across the ring towards her. (180° about the axis (0, 1, 1) / √2.)
 */
const QRING: Quat = [0, Math.SQRT1_2, Math.SQRT1_2, 0];
/** where the ring's centre is put down (it then settles onto the desk) */
const LIE: V3 = [0.02, DESK.height, 0.42];

/** shot times (s) */
export const PULL_T = {
  /** right hand to the tie's end, pinches it, pulls it up out of the eyelet, lets go */
  reach: 0.2, pinch: 0.75, unfold: 1.25, letTie: 1.4,
  /** right hand over the start end, down onto it next to the plug, closes, lifts it: the ring hangs */
  clear: 1.75, takeA: 2.35, lift: 3.25,
  /** the left hand goes to the other end (following it where it hangs) and closes on it */
  follow: 3.35, takeB: 4.45,
  /** both hands hold still with their ends (they are pointed out) */
  pull0: 5.45,
  /** hands apart: the loops open; then the hands sink a little, the cable lies calm */
  pull1: 8.45, lay1: 9.45,
  end: 10.7,
};
const T = PULL_T;

// ---------------------------------------------------------------- the plan (recorded in the bake)

/** slots of the plan vector: the ring's geometry, measured when the shot is built */
const SLOTS = {
  /** the tie: centre of the ellipse round the bunch, its half axes up (the pile) and out of the ring */
  tieC: 0, tieA: 3, tieB: 4,
  size: 5,
} as const;
/**
 * Where the two ends are (grip frames of the cable 2.5 cm from each plug: the start end "endA" for
 * the right hand, the other "endB" for the left), recorded every frame. A hand going to an end
 * follows it with LAG: the bake knows that past, the scene reads it back from the bake.
 */
export type Ends = (which: 0 | 1, t: number) => Grip;
export const LAG = 0.1;
export type Plan = Float64Array;
const v3 = (p: Plan, k: number): V3 => [p[k], p[k + 1], p[k + 2]];
const put = (p: Plan, k: number, v: V3) => {
  p[k] = Math.fround(v[0]);
  p[k + 1] = Math.fround(v[1]);
  p[k + 2] = Math.fround(v[2]);
};

// ---------------------------------------------------------------- the ring

let cached: { ring: Ring; state: ReturnType<typeof placeRing>; d: V3 } | null = null;

/** the ring, laid out and pressed (deploy-ring.ts), turned flat and put down on the desk */
export function shortRing() {
  if (cached) return cached;
  const ring = windRing(SHORT_RING);
  // the ring's centre (factory) goes to LIE, its lowest strand 3 mm above the desk
  const centre: V3 = [FIST[0], FIST[1] - ring.R, (ring.top.z0 + ring.top.z1) / 2];
  const lowZ = ring.top.z0 - ring.rc;
  const d = sub(add(LIE, [0, centre[2] - lowZ + 0.003, 0]), add(quatRotate(QRING, sub(centre, FIST)), FIST));
  cached = { ring, state: placeRing(ring.state, d, QRING, DESK.height), d };
  return cached;
}

// ---------------------------------------------------------------- the tie (kinematic)

/** the tie's frame round the bunch on the desk: the pile's height (e, up), out of the ring (v, away from her), along the strands (w) */
const E: V3 = [0, 1, 0], V: V3 = [0, 0, 1], W: V3 = [-1, 0, 0];

/** a point of the ellipse round the bunch at angle φ (0 = outside, the eyelet), grown by `off`; never below the desk */
const onEllipse = (c: V3, a: number, b: number, phi: number, off: number): V3 => {
  const q = add(c, add(scale(E, (a + off) * Math.sin(phi)), scale(V, (b + off) * Math.cos(phi))));
  q[1] = Math.max(q[1], DESK.height + TIE.thickness / 2);
  return q;
};

export interface TieShape {
  /** the band's centre line from the eyelet to its end (TIE_POINTS points) */
  pts: V3[];
  /** its end, where the right hand pinches it, and the direction it sticks out */
  tip: V3;
  dir: V3;
  /** the band's width direction */
  side: V3;
}
export const TIE_POINTS = 90;
/** where the band's end sticks out once it is out of the eyelet: up, a little away from her */
const TIE_OUT = normalize([0, 1, 0.4]);

/**
 * The tie at shot time t. Closed: once round the bunch at the ring's top, its end through the
 * eyelet and back over the band. The right hand pulls the end back out of the eyelet (it then
 * sticks out forward and up) and lets go: the band droops, loose round the ring. When the ring drops
 * (T.drop) its loops slip out of the loose band, which then hangs from the cable it lives on: `root`
 * is that cable point and its direction (from the simulation; without it, the eyelet stays put).
 */
export function tieShape(p: Plan, t: number, root?: { p: V3; d: V3 }): TieShape {
  const c0 = v3(p, SLOTS.tieC), a = p[SLOTS.tieA], b = p[SLOTS.tieB];
  const th = TIE.thickness, L = TIE.length, n = TIE_POINTS, ds = L / (n - 1);
  const fold = 1 - smooth((t - T.pinch) / (T.unfold - T.pinch));
  const loose = smooth((t - T.letTie) / 0.4);
  const hang = smooth((t - T.takeA - 0.15) / 0.6);
  // the loose band lies wider round the bunch
  const c = add(c0, scale(V, 0.003 * loose)), off = th / 2 + 0.005 * loose;
  // arc length of one turn
  const M = 360;
  const arc = new Float64Array(M + 1);
  for (let k = 1; k <= M; k++) arc[k] = arc[k - 1] + Math.hypot(...sub(onEllipse(c, a, b, (2 * Math.PI * k) / M, off), onEllipse(c, a, b, (2 * Math.PI * (k - 1)) / M, off)));
  const turn = arc[M];
  const phiAt = (s: number) => {
    let k = 0;
    while (k < M - 1 && arc[k + 1] < s) k++;
    return ((k + (s - arc[k]) / Math.max(1e-9, arc[k + 1] - arc[k])) / M) * 2 * Math.PI;
  };
  const eye = onEllipse(c, a, b, 0, off);
  // the end: up while held, then it flops over, outwards onto the desk
  const down = normalize(add(V, scale(E, -0.9)));
  const pts: V3[] = [];
  for (let k = 0; k < n; k++) {
    const s = k * ds;
    if (s <= turn) {
      pts.push(onEllipse(c, a, b, phiAt(s), off));
      continue;
    }
    const e = s - turn;
    // through the eyelet and back over the band (closed) …
    const folded = e < 0.006 ? onEllipse(c, a, b, 0, th * (1.5 + e / 0.006)) : onEllipse(c, a, b, -(e - 0.006) / ((a + b) * 0.95), th * 2.6);
    // … or out of it, straight forward and up, drooping once let go
    const out = add(eye, scale(TIE_OUT, e));
    const droop = add(add(eye, scale(TIE_OUT, Math.min(e, 0.008))), scale(down, Math.max(0, e - 0.008)));
    const q = lerpV(lerpV(out, folded, fold), droop, loose);
    q[1] = Math.max(q[1], DESK.height + th / 2);
    pts.push(q);
  }
  // the ring is lifted out of it: the band hangs from the cable it lives on (a small loop round the
  // cable, then down)
  let side = W;
  if (hang > 0 && root) {
    const d = normalize(root.d), r = 2 * CHARGING.od / 2 + th;
    const e1 = normalize(sub(V, scale(d, dot(V, d)))), e2 = cross(d, e1);
    const loop = 2 * Math.PI * r;
    for (let k = 0; k < n; k++) {
      const s = k * ds;
      let h: V3;
      if (s < loop) {
        const ph = s / r;
        h = add(root.p, add(scale(e1, r * Math.cos(ph)), add(scale(e2, r * Math.sin(ph)), scale(d, 0.002 * ph))));
      } else {
        const e = s - loop, bottom = add(root.p, scale(e1, r));
        h = add(bottom, add([0, -e, 0], scale(e2, 0.02 * Math.sin(e * 12) * Math.min(1, e / 0.03))));
      }
      pts[k] = lerpV(add(pts[k], sub(root.p, eye)), h, hang);
      pts[k][1] = Math.max(pts[k][1], DESK.height + th / 2);
    }
    side = normalize(lerpV(W, d, hang));
  }
  const tip = pts[n - 1];
  return { pts, tip, dir: TIE_OUT, side };
}

const lerpV = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];

// ---------------------------------------------------------------- Ilse's hands

const ease = (t: number, a: number, b: number) => smooth((t - a) / (b - a));
/** palm down and towards her (the comfortable pinch for these grips, ik probes) */
const PALM: V3 = normalize([0, -0.7, 0.7]);
/** the hands at rest: open, on the desk's front edge (open pinches, so every move is between grip frames) */
const REST_R = gripFrame([-0.19, DESK.height + 0.05, 0.36], normalize([1, 0, 0.3]), normalize([0, -0.7, -0.7]));
const REST_L = gripFrame([0.2, DESK.height + 0.05, 0.36], normalize([-1, 0, 0.3]), normalize([0, -0.7, -0.7]));
/** the right hand has lifted the start end: the ring hangs below it */
const LIFT_R = gripFrame([-0.05, 1.15, 0.42], [1, 0, 0], PALM);
/** where the hands end: apart (the cable hangs, its middle on the desk), the cable leaving the pads forward and in; then a little lower */
const PULL_L = gripFrame([0.4, 1.08, 0.46], normalize([-0.7, 0, 0.7]), PALM), PULL_R = gripFrame([-0.4, 1.08, 0.46], normalize([0.7, 0, 0.7]), PALM);
const LAY_L: Grip = { p: [0.39, 1.0, 0.47], q: PULL_L.q }, LAY_R: Grip = { p: [-0.39, 1.0, 0.47], q: PULL_R.q };

/** a grip frame between two (p eased linearly by u, q slerped) */
const mixGrip = (a: Grip, b: Grip, u: number): Grip => ({ p: lerpV(a.p, b.p, u), q: slerpQ(a.q, b.q, u) });

/**
 * Ilse's rig at shot time t for the ring's geometry (plan) and the ends' recorded frames. Pure:
 * the bake and the scene call it with the same data and get the same arms (RigTrack). Every hand
 * moves between grip frames (open or closed), so its target never jumps.
 */
export function pullRig(p: Plan, ends: Ends) {
  /** an end where it was LAG ago, shifted (the hand comes from above or the side) */
  const end = (which: 0 | 1, t: number, off: V3 = [0, 0, 0]): Grip => {
    const g = ends(which, Math.max(0, t - LAG));
    return { p: add(g.p, off), q: g.q };
  };
  /** the tie's end in the pads */
  const tieGrip = (t: number): Grip => gripFrame(tieShape(p, t).tip, [1, 0, 0], [0, -1, 0]);
  const PINCH = { hold: 'pinch' as const, radius: CHARGING.od / 2 };

  const right = (t: number): HandRig => {
    if (t < T.reach) return { grip: REST_R, ...PINCH, open: 1, free: 0.6 };
    if (t < T.pinch) return { grip: mixGrip(REST_R, tieGrip(T.pinch), ease(t, T.reach, T.pinch - 0.05)), ...PINCH, radius: TIE.thickness / 2, open: 1 - ease(t, T.pinch - 0.2, T.pinch), free: 0.6 };
    if (t < T.letTie) return { grip: tieGrip(t), ...PINCH, radius: TIE.thickness / 2, open: ease(t, T.unfold, T.letTie), free: 0.6 };
    // over the start end (where it lies now), then down onto it from above, closing
    if (t < T.clear) return { grip: mixGrip(tieGrip(T.letTie), end(0, T.clear, [0, 0.05, 0]), ease(t, T.letTie, T.clear)), ...PINCH, open: 1, free: 0.6 };
    if (t < T.takeA) return { grip: end(0, t, [0, 0.05 * (1 - ease(t, T.clear, T.takeA - 0.1)), 0]), ...PINCH, open: 1 - ease(t, T.takeA - 0.25, T.takeA), free: 0.6 };
    // lift it: the ring comes up off the desk and hangs; then apart
    const lifted = mixGrip(end(0, T.takeA), LIFT_R, ease(t, T.takeA + 0.1, T.lift));
    const g = mixGrip(mixGrip(lifted, PULL_R, ease(t, T.pull0, T.pull1)), LAY_R, ease(t, T.pull1, T.lay1));
    return { grip: g, ...PINCH, open: 0, free: 0.5 };
  };

  const left = (t: number): HandRig => {
    if (t < T.follow) return { grip: REST_L, ...PINCH, open: 1, free: 0.6 };
    // to the other end, following it where it hangs, coming from her left, closing on it
    if (t < T.takeB) {
      const u = ease(t, T.follow, T.takeB - 0.1);
      return { grip: mixGrip(REST_L, end(1, t, [0.05 * (1 - u), 0, 0]), u), ...PINCH, open: 1 - ease(t, T.takeB - 0.25, T.takeB), free: 0.6 };
    }
    const g = mixGrip(mixGrip(end(1, T.takeB), PULL_L, ease(t, T.pull0, T.pull1)), LAY_L, ease(t, T.pull1, T.lay1));
    return { grip: g, ...PINCH, open: 0, free: 0.5 };
  };

  const rig = (t: number): Rig => {
    const ring = LIE;
    const look = t < T.pull0 ? lerpV(ring, [0.0, 1.0, 0.45], ease(t, T.takeA, T.lift)) : ([0, 1.0, 0.48] as V3);
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

/** the ends from a bake (the scene) */
export const endsFrom = (frame: (name: string, t: number) => Frame): Ends => (which, t) => frame(which ? 'endB' : 'endA', t);

// ---------------------------------------------------------------- the shot

/** the hands' capsule groups (pinch / bundle `hand`) */
const LEFT = 0, RIGHT = 1;
/** soft fingers (they give way to slow squeezes, PinchSpec docs) */
const SOFT = { index: 0.3, middle: 0.3, ring: 0.3, little: 0.3, thumb: 0.3 };

/** the plan from a bake (the scene): the vector "plan" at the end of the shot */
export const planFrom = (vector: (name: string, t: number) => ArrayLike<number>): Plan => Float64Array.from(vector('plan', T.end));

export const deployPull: ShotDef = {
  id: 'deploy-pull',
  duration: T.end,
  substeps: 40,
  iterations: 3,
  build() {
    const { ring, state } = shortRing();
    const rod = ringRod(ring, state, SHORT_RING);
    const plan: Plan = new Float64Array(SLOTS.size);
    const P = (i: number): V3 => [rod.x[3 * i], rod.x[3 * i + 1], rod.x[3 * i + 2]];

    // the ends, recorded every frame (float32, as the bake stores them) and read back with
    // BakedRod.vector's interpolation, so the bake's and the scene's rigs see the same numbers
    const sA = ring.sCable[0] + 0.025, sB = ring.sCable[1] - 0.025;
    const hist: [number[], number[]] = [[], []];
    const endFrame = (r: Rod, which: 0 | 1): Frame => {
      const sx = which ? sB : sA;
      // the cable leaving past the thumb towards the ring; palm down and towards her (A) or out to her left (B)
      const dir = which ? scale(r.tangentAt(sx), -1) : r.tangentAt(sx);
      return gripFrame(r.pointAt(sx), dir, which ? [-1, 0, 0] : normalize([0, -0.7, -0.7]));
    };
    const record = (r: Rod, which: 0 | 1): number[] => {
      const f = endFrame(r, which), v = [...f.p, ...f.q].map(Math.fround);
      hist[which].push(...v);
      return v;
    };
    const ends: Ends = (which, t) => {
      const h = hist[which], frames = h.length / 7;
      const u = Math.min(frames - 1, Math.max(0, t * 60)), f0 = Math.floor(u), f1 = Math.min(frames - 1, f0 + 1), a = u - f0;
      const o0 = 7 * f0, o1 = 7 * f1, o = new Array<number>(7);
      for (let i = 0; i < 7; i++) o[i] = h[o0 + i] + (h[o1 + i] - h[o0 + i]) * a;
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
    // body: torso, thighs (not the hands: they are the 22 capsules each below)
    const caps = (t: number): Capsule[] => {
      const pose = poseAt(t);
      const body = capsulesOf(pose).filter((c) => c.part === 'torso' || c.part === 'legL' || c.part === 'legR');
      return [...body, ...handColliders(pose, 0, { group: LEFT, soft: SOFT }), ...handColliders(pose, 1, { group: RIGHT, soft: SOFT })];
    };
    rod.setCapsules(caps);
    // the ring settles on the desk before the shot starts
    rod.time = -1.5;
    for (let f = 0; f < 90; f++) rod.step(1 / 60, 40);
    rod.time = 0;

    // the tie: round the bunch where the start end leaves it (factory x = +1.1 cm), measured as the ring lies now
    const tc0 = placePoint([FIST[0] + 0.011, FIST[1], 0], shortRing().d, QRING);
    const near: V3[] = [];
    for (let i = ring.loops[0][0]; i <= ring.loops[ring.loops.length - 1][1]; i++) {
      const q = P(i);
      if (Math.abs(q[0] - tc0[0]) < 0.004 && q[2] > LIE[2]) near.push(q);
    }
    // the strands at the far side of the ring (the top of the coil) within 2 cm of the outermost one
    const zMax = Math.max(...near.map((q) => q[2]));
    const bunch = near.filter((q) => q[2] > zMax - 0.02);
    const yLo = Math.min(...bunch.map((q) => q[1])), yHi = Math.max(...bunch.map((q) => q[1]));
    const zLo = Math.min(...bunch.map((q) => q[2]));
    put(plan, SLOTS.tieC, [tc0[0], (yLo + yHi) / 2, (zLo + zMax) / 2]);
    plan[SLOTS.tieA] = Math.fround((yHi - yLo) / 2 + ring.rc + 0.001);
    plan[SLOTS.tieB] = Math.fround((zMax - zLo) / 2 + ring.rc + 0.001);

    // the ends as they lie when the shot starts (frame 0 is recorded by the bake, after the script)
    record(rod, 0);
    record(rod, 1);
    hist[0].length = 0;
    hist[1].length = 0;

    let pinA: Pinch | null = null, pinB: Pinch | null = null;
    const script = (r: Rod, t: number) => {
      if (!pinA && t >= T.takeA) pinA = r.pinch({ frame: (tt) => reached(tt, 1), s: sA, mode: 'held', hand: RIGHT, blend: 0.12 });
      if (!pinB && t >= T.takeB) pinB = r.pinch({ frame: (tt) => reached(tt, 0), s: sB, mode: 'held', hand: LEFT, blend: 0.12 });
    };
    const lowest = (r: Rod) => {
      let m = Infinity;
      for (let i = ring.cable[0]; i <= ring.cable[1]; i++) m = Math.min(m, r.x[3 * i + 1]);
      return m - DESK.height;
    };
    return {
      rod,
      script,
      tracks: {
        cable0: () => ring.cable[0],
        tieNode: (r) => r.segmentAt(TIE.s),
        cable1: () => ring.cable[1],
        twist: (r) => r.twistTurns(),
        writhe: (r) => r.writhe(ring.cable[0], ring.cable[1]),
        low: lowest,
        // the arms: how far each hand is from its target (mm) and its cable direction off (°)
        ikL: (_, t) => (poseAt(t).body.arms?.[0].report.posError ?? 0) * 1000,
        ikR: (_, t) => (poseAt(t).body.arms?.[1].report.posError ?? 0) * 1000,
        axL: (_, t) => ((poseAt(t).body.arms?.[0].report.axisErrors[0] ?? 0) * 180) / Math.PI,
        axR: (_, t) => ((poseAt(t).body.arms?.[1].report.axisErrors[0] ?? 0) * 180) / Math.PI,
        gripA: () => (pinA ? pinA.gripDistance : -1),
        gripB: () => (pinB ? pinB.gripDistance : -1),
      },
      vectors: {
        plan: { size: SLOTS.size, fn: () => plan },
        endA: { size: 7, quats: [3], fn: (r) => record(r, 0) },
        endB: { size: 7, quats: [3], fn: (r) => record(r, 1) },
      },
    };
  },
};

