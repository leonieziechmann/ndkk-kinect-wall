// Stage 1, item 3: a short cable laid out again, done right. Ilse sits in her wheelchair at the FOH
// desk with a short over-under ring of a black charging cable (CHARGING preset, Ø 4 mm, 6 loops of
// Ø 9 cm, 2 m with the plugs) hanging from her left hand. Her right hand opens the velcro tie; the
// tie stays on the cable (it lives there, 14 cm from the plug of the start end). The right hand
// takes the start end next to its plug; the left hand opens and lets the ring go: the ring hangs
// from the right hand. The left hand takes the other end, which hangs out of the ring below. Both
// ends are outside the ring. She pulls her hands apart: the loops open one after the other, the
// cable ends up hanging calm between her hands, its middle on the desk, without curls (the +1 and
// -1 turns of the über and unter loops cancel).
//
// Everything is simulated except the tie (kinematic). Ilse's arms come from one RigTrack (people/
// rig.ts), the single source for the bake and the scene: the simulation's hand frames are the grip
// frames her hands really reached (pose.body.arms[i].grip), her hands are 22 collision capsules
// each (handColliders: a pinch or a bundle of the same hand lets its cable through), her forearms,
// torso and thighs are capsules too, and the desk top is the floor. Where the left hand takes the
// other end is planned in the running simulation (the end hangs where the dropped ring put it):
// the plan and the ring's geometry are recorded in the bake (vector "plan"), so the scene builds the
// same RigTrack (pullRig(plan)).
//
// Coordinates: Ilse sits at the origin facing +z (her left is +x); the desk's top at DESK.height.

import { Bundle, CHARGING, Capsule, Frame, Pinch, Quat, Rod, V3, add, cross, dot, normalize, quatFromAxisAngle, quatRotate, scale, smooth, sub } from '../sim';
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
/** the velcro tie: band length, width, thickness; where it sits on the start end (m from the plug's tip) */
export const TIE = { length: 0.18, width: 0.012, thickness: 0.0015, s: 0.119 };

/** the ring is turned this far about the vertical: its face looks at Ilse and to her right, the start end points to her right hand */
const TURN = (-3 * Math.PI) / 4;
const QRING: Quat = quatFromAxisAngle(0, 1, 0, TURN);
/** where the top of the ring (the middle of the bunch in her left hand) is */
const HOLD: V3 = [0.07, 1.13, 0.43];

/** shot times (s) */
export const PULL_T = {
  /** right hand to the tie's end, pinches it */
  reach: 0.25, pinch: 0.85,
  /** the tie's end out of the eyelet, the band unwound off the ring, let go */
  unfold: 1.15, unwrap: 2.0, letTie: 2.15,
  /** right hand to the start end, closes on it next to the plug */
  takeA: 2.95,
  /** left hand opens: the ring hangs from the right hand */
  drop: 3.25,
  /** where the other end hangs is looked up, the left hand goes there and closes on it */
  plan: 3.8, takeB: 4.75,
  /** both hands hold still with their ends (they are pointed out) */
  pull0: 5.9,
  /** hands apart: the loops open; then the hands sink a little, the cable lies calm */
  pull1: 8.9, lay1: 9.9,
  end: 11.2,
};
const T = PULL_T;

// ---------------------------------------------------------------- the plan (recorded in the bake)

/** slots of the plan vector: the ring's geometry (known when the shot is built) and the left hand's target (planned at T.plan) */
const SLOTS = {
  /** left hand on the ring: grip point; the ring's axis (stack) */
  left: 0, axis: 3,
  /** the tie: centre of the ellipse round the bunch, its two half axes, the strands' direction there */
  tieC: 6, tieA: 9, tieB: 10, tieW: 11,
  /** the start end where the right hand takes it: point and cable direction (towards the plug) */
  takeA: 14, dirA: 17,
  /** the other end where the left hand takes it (planned): point and direction (towards its plug) */
  takeB: 20, dirB: 23,
  size: 26,
} as const;
export type Plan = Float64Array;
const v3 = (p: Plan, k: number): V3 => [p[k], p[k + 1], p[k + 2]];
const put = (p: Plan, k: number, v: V3) => {
  p[k] = Math.fround(v[0]);
  p[k + 1] = Math.fround(v[1]);
  p[k + 2] = Math.fround(v[2]);
};

// ---------------------------------------------------------------- the ring

let cached: { ring: Ring; state: ReturnType<typeof placeRing> } | null = null;

/** the ring, laid out and pressed (deploy-ring.ts), turned and moved so its top is at HOLD */
export function shortRing() {
  if (cached) return cached;
  const ring = windRing(SHORT_RING);
  const d = sub(HOLD, add(quatRotate(QRING, sub(ring.top.c, FIST)), FIST));
  cached = { ring, state: placeRing(ring.state, d, QRING, DESK.height) };
  return cached;
}

// ---------------------------------------------------------------- the tie (kinematic)

/** the tie's ellipse round the bunch: centre c, half axes a (along the ring's axis u) and b (up, v), the strands' direction w */
interface TieGeo {
  c: V3;
  u: V3;
  v: V3;
  w: V3;
  a: number;
  b: number;
}
const tieGeo = (p: Plan): TieGeo => {
  const u = normalize(v3(p, SLOTS.axis)), w = normalize(v3(p, SLOTS.tieW));
  const v = normalize(cross(w, u));
  return { c: v3(p, SLOTS.tieC), u, v, w, a: p[SLOTS.tieA], b: p[SLOTS.tieB] };
};

/** a point of the ellipse at angle φ (0 = on top, where the eyelet sits), grown by `off` */
const onEllipse = (g: TieGeo, phi: number, off: number): V3 =>
  add(g.c, add(scale(g.u, (g.a + off) * Math.sin(phi)), scale(g.v, (g.b + off) * Math.cos(phi))));
const tangentAt = (g: TieGeo, phi: number): V3 => normalize(add(scale(g.u, g.a * Math.cos(phi)), scale(g.v, -g.b * Math.sin(phi))));

export interface TieShape {
  /** the band's centre line from the eyelet to its end (TIE_POINTS points) */
  pts: V3[];
  /** its end, where the right hand pinches it, and the band's direction there */
  tip: V3;
  dir: V3;
  /** the band's width direction */
  side: V3;
}
export const TIE_POINTS = 90;

/**
 * The tie at shot time t, while the ring is held still (until T.letTie + 0.4): wrapped once round
 * the bunch, its end through the eyelet and back over the band; pulled back out of the eyelet
 * (unfold), unwound off the bunch (the end circles the ring once, the right hand with it), let go:
 * it swings down and hangs from the eyelet. `root` moves the eyelet (from T.letTie on: the cable
 * point the tie lives on, from the bake).
 */
export function tieShape(p: Plan, t: number, root?: V3): TieShape {
  const g = tieGeo(p), th = TIE.thickness, L = TIE.length, n = TIE_POINTS, ds = L / (n - 1);
  const fold = 1 - smooth((t - T.pinch) / (T.unfold - T.pinch));
  const wrap = 1 - smooth((t - T.unfold) / (T.unwrap - T.unfold));
  const hang = smooth((t - T.letTie) / 0.4);
  // arc length of one turn (numerically)
  const M = 400;
  const arc = new Float64Array(M + 1);
  for (let k = 1; k <= M; k++) arc[k] = arc[k - 1] + Math.hypot(...sub(onEllipse(g, (2 * Math.PI * k) / M, th / 2), onEllipse(g, (2 * Math.PI * (k - 1)) / M, th / 2)));
  const turnLen = arc[M];
  const phiAt = (s: number) => {
    let k = 0;
    while (k < M && arc[k + 1] < s) k++;
    return ((k + (s - arc[k]) / Math.max(1e-9, arc[k + 1] - arc[k])) / M) * 2 * Math.PI;
  };
  const wrapped = turnLen * wrap;
  const eye = onEllipse(g, 0, th / 2);
  const pts: V3[] = [];
  for (let k = 0; k < n; k++) {
    const s = k * ds;
    let q: V3;
    if (s <= wrapped) q = onEllipse(g, phiAt(s), th / 2);
    else {
      // beyond the wrapped part: straight on along the tangent (unwound) …
      const phi = phiAt(wrapped), base = onEllipse(g, phi, th / 2), tan = tangentAt(g, phi);
      const out = normalize(add(tan, scale(normalize(sub(base, g.c)), 0.35)));
      const straight = add(base, scale(out, s - wrapped));
      // … or, while closed, through the eyelet and back round the bunch over the band
      const back = s - turnLen;
      const folded = back < 0.006 ? onEllipse(g, 2 * Math.PI + back * 0, th * (1.5 + back / 0.006)) : onEllipse(g, -(back - 0.006) / (g.a + g.b) * 1.1, th * 2.5);
      q = wrap > 0.999 ? lerpV(straight, folded, fold) : straight;
    }
    pts.push(q);
  }
  // let go: it swings down and hangs from the eyelet
  if (hang > 0) {
    const r = root ?? eye;
    for (let k = 0; k < n; k++) {
      const s = k * ds;
      const hung: V3 = add(r, add(scale(g.w, 0.006 * Math.sin(Math.min(1, s / 0.03) * Math.PI)), [0.01 * Math.sin(s * 9), -s, 0.004 * s]));
      const moved = add(pts[k], sub(r, eye));
      pts[k] = lerpV(moved, hung, hang);
    }
  }
  const tip = pts[n - 1];
  const dir = normalize(sub(pts[n - 1], pts[n - 4]));
  return { pts, tip, dir, side: g.w };
}

const lerpV = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];

// ---------------------------------------------------------------- Ilse's hands

const ease = (t: number, a: number, b: number) => smooth((t - a) / (b - a));
/** where the hands end: apart and up (the cable hangs, its middle on the desk), then lower */
const PULL_L: V3 = [0.46, 1.1, 0.43], PULL_R: V3 = [-0.46, 1.1, 0.43];
const LAY_L: V3 = [0.44, 1.03, 0.44], LAY_R: V3 = [-0.44, 1.03, 0.44];
/** the right hand at rest: open, on the desk's front edge (an open pinch, so every move is between grip frames) */
const REST_R = gripFrame([-0.19, DESK.height + 0.05, 0.36], normalize([0.2, -0.15, 1]), [0, 1, 0]);

/** a grip frame between two (p eased linearly by u, q slerped) */
const mixGrip = (a: Grip, b: Grip, u: number): Grip => ({ p: lerpV(a.p, b.p, u), q: slerpQ(a.q, b.q, u) });

/**
 * Ilse's rig at shot time t for a plan (ring geometry and the planned grip on the other end).
 * Pure: the bake and the scene call it with the same plan and get the same arms (RigTrack). Every
 * hand moves between grip frames (open or closed), so its target never jumps.
 */
export function pullRig(p: Plan) {
  // read the plan lazily: the bake fills in the other end's grip while it runs (T.plan)
  const axis = () => normalize(v3(p, SLOTS.axis));
  const leftGrip = () => gripFrame(v3(p, SLOTS.left), axis(), [0, 1, 0]);
  // the right hand: pads on the start end, the cable leaving past the thumb towards the plug; it
  // turns the plug outwards (to her right) as it pulls
  const gripA = () => gripFrame(v3(p, SLOTS.takeA), normalize(v3(p, SLOTS.dirA)), [0, 1, -0.3]);
  const pullA = gripFrame(PULL_R, [-1, 0.05, 0], [0, 1, -0.3]);
  // the left hand: the same on the other end, its plug out to her left
  const gripB = () => gripFrame(v3(p, SLOTS.takeB), normalize(v3(p, SLOTS.dirB)), [0, 1, -0.3]);
  const pullB = gripFrame(PULL_L, [1, 0.05, 0], [0, 1, -0.3]);
  /** the open left hand backs off the dropped ring a little and waits */
  const away = (): Grip => ({ p: add(leftGrip().p, [0.05, -0.05, -0.03]), q: leftGrip().q });
  const tieGrip = (t: number): Grip => {
    const s = tieShape(p, t);
    return gripFrame(s.tip, s.dir, [0, 1, 0]);
  };
  const PINCH = { hold: 'pinch' as const, radius: CHARGING.od / 2 };

  const right = (t: number): HandRig => {
    let g: Grip, open: number, radius: number = PINCH.radius, free = 0.7;
    if (t < T.pinch) {
      // from rest to the tie's end, opening on the way, closing on it
      g = mixGrip(REST_R, tieGrip(T.pinch), ease(t, T.reach, T.pinch));
      open = 1 - ease(t, T.pinch - 0.2, T.pinch);
      radius = TIE.thickness / 2;
      free = 1;
    } else if (t < T.letTie) {
      // the tie's end in the pinch: it unwinds the band, opens and lets go
      g = tieGrip(t);
      open = ease(t, T.unwrap, T.letTie);
      radius = TIE.thickness / 2;
      free = 1;
    } else if (t < T.takeA) {
      // to the start end next to its plug, closing on it
      g = mixGrip(tieGrip(T.letTie), gripA(), ease(t, T.letTie, T.takeA - 0.05));
      open = 1 - ease(t, T.takeA - 0.3, T.takeA);
    } else {
      g = mixGrip(mixGrip(gripA(), pullA, ease(t, T.pull0, T.pull1)), { p: LAY_R, q: pullA.q }, ease(t, T.pull1, T.lay1));
      open = 0;
      free = 0.5;
    }
    return { grip: g, ...PINCH, radius, open, free };
  };

  const left = (t: number): HandRig => {
    if (t < T.drop + 0.2) return { grip: leftGrip(), hold: 'coil', radius: 0.012, free: 0.5, open: ease(t, T.drop, T.drop + 0.2) };
    let g: Grip, open = 1;
    // open: back off and wait for the plan (the other end hangs where the dropped ring put it) …
    if (t < T.plan + 0.15) g = mixGrip(leftGrip(), away(), ease(t, T.drop + 0.2, T.plan));
    // … then to the other end, closing on it
    else if (t < T.takeB) {
      g = mixGrip(away(), gripB(), ease(t, T.plan + 0.15, T.takeB - 0.05));
      open = 1 - ease(t, T.takeB - 0.3, T.takeB);
    } else {
      g = mixGrip(mixGrip(gripB(), pullB, ease(t, T.pull0, T.pull1)), { p: LAY_L, q: pullB.q }, ease(t, T.pull1, T.lay1));
      open = 0;
    }
    return { grip: g, ...PINCH, open, free: t < T.takeB ? 0.7 : 0.5 };
  };

  const rig = (t: number): Rig => {
    const ring = v3(p, SLOTS.left);
    const look = t < T.pull0 ? lerpV(ring, [0.02, 1.0, 0.45], 0.3 * ease(t, T.drop, T.takeB)) : ([0, 1.0, 0.48] as V3);
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
export const pullTrack = (p: Plan) => new RigTrack(ILSE, pullRig(p).rig, 0, 60);

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
    const axis = quatRotate(QRING, [0, 0, 1]);
    const w = quatRotate(QRING, [1, 0, 0]);
    // the left hand on the top of the ring, on the part away from the start end; the tie between the
    // hand and where the start end leaves the bunch
    const top = (x: number): V3 => placePoint([FIST[0] + x, ring.top.c[1], ring.top.c[2]], sub(HOLD, add(quatRotate(QRING, sub(ring.top.c, FIST)), FIST)), QRING);
    put(plan, SLOTS.left, top(-0.012));
    put(plan, SLOTS.axis, axis);
    put(plan, SLOTS.tieW, w);
    // the tie's ellipse: round the strands near x = +1.1 cm (factory) at the top
    const tc = top(0.011);
    let a = 0, b = 0;
    for (let i = ring.loops[0][0]; i <= ring.loops[ring.loops.length - 1][1]; i++) {
      const d = sub(P(i), tc);
      if (Math.abs(dot(d, w)) > 0.005 || dot(d, [0, 1, 0]) < -0.025) continue;
      a = Math.max(a, Math.abs(dot(d, axis)));
      b = Math.max(b, Math.abs(d[1]));
    }
    put(plan, SLOTS.tieC, tc);
    plan[SLOTS.tieA] = Math.fround(a + ring.rc + 0.001);
    plan[SLOTS.tieB] = Math.fround(Math.max(b, 2 * ring.rc) + ring.rc + 0.001);

    // the hold: the left hand takes the top of every loop (the part of the factory's fist away from
    // the start end); the start end itself is free and droops
    const track = pullTrack(plan);
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
    const coil: Bundle = rod.bundle({ frame: (t) => reached(t, 0), hand: LEFT, blend: 0.001 });
    const fx = (j: number) => dot(sub([rod.c[3 * j], rod.c[3 * j + 1], rod.c[3 * j + 2]], top(0)), w);
    for (let j = rod.segmentAt(ring.sCable[0] + 0.02); j < rod.ns; j++) {
      const c: V3 = [rod.c[3 * j], rod.c[3 * j + 1], rod.c[3 * j + 2]];
      if (c[1] < top(0)[1] - 0.02 || fx(j) > 0.004 || fx(j) < -0.024) continue;
      coil.add(rod.sNode[j], rod.sNode[j + 1]);
    }
    // body: forearms, torso, thighs (not the hands: they are the 22 capsules each below)
    const caps = (t: number): Capsule[] => {
      const pose = poseAt(t);
      const body = capsulesOf(pose).filter((c) => c.part === 'torso' || c.part === 'legL' || c.part === 'legR');
      return [
        ...body,
        ...handColliders(pose, 0, { group: LEFT, soft: SOFT }),
        ...handColliders(pose, 1, { group: RIGHT, soft: SOFT }),
      ];
    };
    rod.setCapsules(caps);
    // let the ring hang still in the hand before the shot starts (the start end droops)
    rod.time = -1.5;
    for (let f = 0; f < 90; f++) rod.step(1 / 60, 40);
    rod.time = 0;
    // where the right hand takes the start end: 2.5 cm behind the plug, as it lies now
    const sA = ring.sCable[0] + 0.025;
    put(plan, SLOTS.takeA, rod.pointAt(sA));
    put(plan, SLOTS.dirA, scale(rod.tangentAt(sA), -1));
    // a first guess for the other end (planned again at T.plan, where the dropped ring put it)
    const sB = ring.sCable[1] - 0.025;
    put(plan, SLOTS.takeB, rod.pointAt(sB));
    put(plan, SLOTS.dirB, rod.tangentAt(sB));

    let pinA: Pinch | null = null, pinB: Pinch | null = null;
    let dropped = false, planned = false;
    const script = (r: Rod, t: number) => {
      if (!pinA && t >= T.takeA) pinA = r.pinch({ frame: (tt) => reached(tt, 1), s: sA, mode: 'held', hand: RIGHT, blend: 0.12 });
      if (!dropped && t >= T.drop) {
        coil.release(-Infinity, Infinity, 0.25);
        dropped = true;
      }
      if (!planned && t >= T.plan) {
        put(plan, SLOTS.takeB, r.pointAt(sB));
        put(plan, SLOTS.dirB, r.tangentAt(sB));
        planned = true;
      }
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
        gripA: () => (pinA ? pinA.gripDistance : -1),
        gripB: () => (pinB ? pinB.gripDistance : -1),
      },
      vectors: { plan: { size: SLOTS.size, fn: () => plan } },
    };
  },
};

