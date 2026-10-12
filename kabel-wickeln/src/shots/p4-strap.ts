// Stage 4 (Klettband, part p4-strap): the simulated cable shots and Jonas' rough choreography.
// Pure TypeScript (sim and people only): tools/bake.mjs bakes the shots, the part builds the same
// RigTracks from the same functions (and the plans the bakes record).
//
//   p4-prep        the 5 m XLR (the user's Sommer SC-Stage 22 Highflex preset): Jonas holds the
//                  male plug (the one with the pins) in his left fist, the cable hangs from it to
//                  the floor and runs along the floor to a mic stand, where the female plug sits in
//                  the mic. His right hand puts the velcro tie on 13 cm below the plug's boot (the
//                  tie is kinematic: the part draws it on the cable where the bake has it), then
//                  pinches the tie and tugs it along the cable, down and up ("Zugprobe"): simulated,
//                  the cable follows the pinch (the tie cannot slide: it is drawn at its material
//                  point; the pinch's material coordinate is recorded: pinS).
//   p4-ring-ok     the same cable as an over-under ring (ring factory deploy-ring.ts, 6 loops
//   p4-ring-loose  Ø 23 cm, the tie on the start end 19 cm from its plug), held at its top in his
//                  left hand. The right hand brings the other end up beside the fist (the left hand
//                  takes it), wraps the tie round the whole ring next to the fist and closes it; then
//                  it lifts the ring by the tie, the left hand lets go, it shakes it a little and
//                  holds it. "ok": the closed tie holds every strand it encloses (a bundle: a firmly
//                  closed tie); "loose": the tie is a loose loop of capsules, 1.4 cm wider than the
//                  bundle, through which the strands can slide (simulated: whatever falls out does
//                  so by itself). The tie's band is kinematic in both.
//   p4-two         a 15 m XLR ring (16 loops, the ring of Kofi's throw) in his left hand, the first
//                  tie at the top; the right hand gathers the loops at the bottom (soft guides pull
//                  the strands there together: the hand's squeeze, guided) and the second tie holds
//                  them (a bundle).
//
// Coordinates: Jonas stands at the origin facing -z (yaw 0, his right is +x). The rings hang in
// planes facing N (forward, 55° to his right, as Noor's coil in stage 1), the strands at the top run
// across them (E1: lateral → medial), the start end sticks out of his fist to his left and forward.

import { Bundle, Capsule, Frame, Pinch, Quat, Rod, V3, XLR, add, buildCable, cross, dot, length as len, normalize, quatConj, quatFromFrame, quatRotate, scale, smooth, sub } from '../sim';
import { JONAS } from '../people/cast';
import { Grip, HandRig, Rig, RigTrack, gripFrame, stand } from '../people/rig';
import { capsulesOf } from '../people/body3d';
import type { Pose } from '../people/people';
import type { ShotDef } from './types';
import { FIST, Ring, RingSpec, placeRing, ringRod, windRing } from './deploy-ring';

// ===================================================================================== geometry

const D = Math.PI / 180;
const UP: V3 = [0, 1, 0];
export const RC = XLR.od / 2;
const mix3 = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
export const perp = (v: V3, a: V3): V3 => normalize(sub(v, scale(a, dot(v, a))));
export const ease = (u: number) => smooth(Math.max(0, Math.min(1, u)));
export const ramp = (t: number, a: number, b: number) => ease((t - a) / (b - a));

/** the rings' axis (the stack): forward, 55° to his right; the loops face this way */
export const N: V3 = normalize([Math.sin(55 * D), 0, -Math.cos(55 * D)]);
/** across the loops at their top, from the lateral side (where the start end comes in) to the medial side */
export const E1: V3 = normalize([-N[2], 0, N[0]]);
/** the strands' direction at the top of a ring, towards the start end (lateral) */
export const A: V3 = scale(E1, -1);
/** ring factory → world: x (towards the start end) → A, y → up, z (the stack) → N */
export const Q_RING: Quat = quatFromFrame(A, UP, N);
/** from the strands to the left palm: behind them (his side) and a little below (as Noor's coil grip) */
export const TO_PALM: V3 = perp(normalize(add(scale(N, -0.9), scale(UP, -0.4))), A);

/** the velcro tie: band length, width, thickness (m) */
export const STRAP = { length: 0.25, width: 0.02, thickness: 0.002 };
/** where the tie lives on the 5 m cable: m from the male plug's tip (13 cm from its boot: 10–30 cm before the plug) */
export const S_STRAP = 0.19;

/** the 5 m XLR as an over-under ring: 6 loops of 72 cm (Ø 23 cm), the start end 25 cm (the tie on it beside the fist), the end 25 cm */
export const P4_RING: RingSpec = { cable: XLR, loop: 0.72, pattern: 'ououou', lead: 0.25, tail: 0.25, spacing: 0.016, press: 0.6, pressTime: 3, fist: 0.04, tear: 0, memoryRound: true };
/** a long ring: 15 m XLR, 16 loops of 88 cm (the ring of Kofi's throw, throw.ts LONG_RING: the same ring cache) */
export const LONG_RING: RingSpec = { cable: XLR, loop: 0.88, pattern: 'ou'.repeat(8), lead: 0.4, tail: 0.5, spacing: 0.016, press: 0.6, pressTime: 3, fist: 0.04, tear: 0, memoryRound: true };

export type RingKind = 'p4' | 'long';
/** per ring: the middle of the stack at the top (factory z, checked against the wound ring), the tie's place on the strands (factory x) and its material coordinate */
export const RING_GEOM: Record<RingKind, { zMid: number; strapX: number; sStrap: number; coilR: number }> = {
  p4: { zMid: 0.0296, strapX: 0.062, sStrap: S_STRAP, coilR: 0.016 },
  long: { zMid: 0.0613, strapX: 0.062, sStrap: 0.338, coilR: 0.02 },
};
/** where the top of the ring (factory (0, 1.598, zMid)) sits: his left hand, in front of his belly */
export const RING_AT: Record<RingKind, V3> = { p4: [-0.1, 1.25, -0.36], long: [-0.1, 1.2, -0.38] };

/** factory point → world (the ring of `kind` placed in his left hand) */
export function ringPoint(kind: RingKind, pf: V3): V3 {
  const g = RING_GEOM[kind];
  const top: V3 = [0, FIST[1] - 0.002, g.zMid];
  const d = sub(sub(RING_AT[kind], FIST), quatRotate(Q_RING, sub(top, FIST)));
  return add(add(quatRotate(Q_RING, sub(pf, FIST)), FIST), d);
}
/** the translation placeRing needs for that */
const ringShift = (kind: RingKind): V3 => sub(ringPoint(kind, FIST), FIST);
/** factory direction → world */
export const ringDir = (v: V3): V3 => quatRotate(Q_RING, v);

/** the left hand's coil grip on the ring's top */
export const ringGrip = (kind: RingKind): Grip => gripFrame(RING_AT[kind], A, TO_PALM);
/** the left fist's frame for the simulation (the grip frame) */
export const ringFist = (kind: RingKind): Frame => {
  const g = ringGrip(kind);
  return { p: g.p, q: g.q };
};

/**
 * The tie's cross-section on a ring (world, at rest in the left hand): the middle of the strands
 * it encloses, the strands' direction, the direction from that middle to the start strand (the
 * eyelet's side) and the enclosed bundle's radius.
 */
export function strapSection(kind: RingKind) {
  const g = RING_GEOM[kind];
  // the start strand lies at the back of the stack (factory z ≈ 0.009) on top; the loops' strands
  // there, 6 cm from the fist's middle, have come down 1.5–2 cm
  const c = ringPoint(kind, [g.strapX, FIST[1] - 0.012, g.zMid]);
  const start = ringPoint(kind, [g.strapX, FIST[1], 0.009]);
  const u = normalize(sub(start, c));
  return { c, a: A, u, r: kind === 'p4' ? 0.022 : 0.034 };
}

// ===================================================================================== Jonas

export const SPEC = JONAS;
/** his right hand resting beside his hip (a pinch grip, open) */
export const REST_R: Grip = gripFrame([0.27, 0.96, -0.14], normalize([0.1, -1, -0.2]), [-0.3, 0, -1]);
/** his left hand resting beside his hip */
export const REST_L: Grip = gripFrame([-0.27, 0.96, -0.14], normalize([-0.1, -1, -0.2]), [0.3, 0, -1]);

/** a little breathing and weight shift: never quite still */
export function idle(s: number) {
  return {
    lean: 0.06 + 0.01 * Math.sin(1.25 * s) + 0.007 * Math.sin(0.37 * s + 1),
    bend: 0.01 * Math.sin(0.41 * s + 0.4),
    twist: 0.018 * Math.sin(0.29 * s + 2),
    drop: 0.012 + 0.005 * Math.sin(1.25 * s + 0.6),
  };
}
/** his stance and idle motion (scene seconds s) */
export const rigBase = (s: number): Omit<Rig, 'hands' | 'look'> => ({ ...stand(SPEC, [0, 0], 0, { width: 0.3, stagger: 0.05 }), ...idle(s), reach: 0.5 });

type Key = [number, Grip];
/** a grip track through keys (position lerped, orientation slerped, smooth in and out) */
export function gripPath(keys: Key[]) {
  return (t: number): Grip => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      if (t < keys[i][0]) {
        const [ta, a] = keys[i - 1], [tb, b] = keys[i];
        const u = ease((t - ta) / (tb - ta));
        return { p: mix3(a.p, b.p, u), q: slerpQ(a.q, b.q, u) };
      }
    }
    return keys[keys.length - 1][1];
  };
}
function slerpQ(a: Quat, b: Quat, u: number): Quat {
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
}
/** a value through keys, smooth */
export function valPath(keys: [number, number][]) {
  return (t: number): number => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) if (t < keys[i][0]) return keys[i - 1][1] + (keys[i][1] - keys[i - 1][1]) * ease((t - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]));
    return keys[keys.length - 1][1];
  };
}

/** a pinch grip of the right hand (pads on a cable or on the tie's band) */
export const pinchR = (g: Grip, open: number, radius = RC + 2 * STRAP.thickness, free = 0.5): HandRig => ({ grip: g, hold: 'pinch', radius, open, free });

// ===================================================================================== p4-prep

/** the scene of the first beat: the fist round the male plug's body, where the plug's tip points, the mic stand */
export const PREP = {
  /** the middle of the left fist (round the plug's body: 3.5 cm from its tip) */
  fist: [-0.1, 1.15, -0.32] as V3,
  /** the plug's axis towards its tip: up, a little towards him and to his left (the pins face him) */
  plugDir: normalize([-0.18, 0.9, 0.3]),
  /** the mic stand (x, z) and the height of its tube */
  stand: [0.95, -1.85] as [number, number],
  standH: 1.4,
  /** the mic's axis (tail → head): up and back towards where a singer stands */
  micDir: normalize([-0.3, 0.72, 0.62]),
};
/** the mic: the middle of its body, its tail (where the female plug sits) */
export const MIC = (() => {
  const c: V3 = [PREP.stand[0], PREP.standH + 0.05, PREP.stand[1]];
  return { c, tail: sub(c, scale(PREP.micDir, 0.075)), len: 0.15, r: 0.021 };
})();

/** shot times of p4-prep (s) */
export const PREP_T = {
  /** the right hand brings the tie to the cable, the eyelet against it */
  place0: 1.0, place1: 2.4,
  /** it slides along the band, takes the long end round the cable, through the eyelet, pulls it tight, lets go */
  wrap0: 3.0, wrap1: 4.6, thread1: 5.2, cinch1: 5.8, let: 6.0,
  /** the pull test: the pinch closes on the tie, tugs away from the plug (the cable above it goes taut: 4 mm), then 3 cm towards the plug, back, opens */
  reach: 7.6, close: 8.0, down1: 8.9, up1: 9.6, back1: 10.0, open: 10.2, rest: 11.0,
  end: 18.0,
};

/** the plan of p4-prep (recorded in the bake): the cable at the tie after settling: point, tangent (towards higher s), outward */
export interface PrepPlan {
  p: V3;
  t: V3;
  u: V3;
}
export const prepPlanFrom = (v: ArrayLike<number>): PrepPlan => ({ p: [v[0], v[1], v[2]], t: [v[3], v[4], v[5]], u: [v[6], v[7], v[8]] });

/** the left fist round the plug (grip frame: thumb towards the plug's tip) */
export const prepFist = (): Grip => gripFrame(PREP.fist, PREP.plugDir, perp([-1, 0, 0.15], PREP.plugDir));

/**
 * The right hand during p4-prep, and the tie's state it implies: the band's parameters for the part
 * (strap.ts shapes): phase and progress.
 */
export function prepHand(plan: PrepPlan) {
  const { p, t: T, u: U } = plan;
  const V = normalize(cross(T, U));
  const T_ = PREP_T;
  const at = (dt: number, du: number, dv: number): V3 => add(p, add(scale(T, dt), add(scale(U, du), scale(V, dv))));
  const g = (q: V3, along: V3, toPalm: V3): Grip => gripFrame(q, along, perp(toPalm, along));
  // the band hangs down from the pads while he carries it; the eyelet against the cable's outer side
  const ready = g(at(-0.01, 0.1, 0.03), T, U);
  const placed = g(at(0.015, RC + 0.016, 0), T, U);
  const slid = g(at(0.05, 0.03, 0.005), T, U);
  // round the cable (radius 4.5 cm), the band leaving the pads along the circle
  const round = (phi: number) => {
    const r: V3 = add(scale(U, Math.cos(phi)), scale(V, Math.sin(phi)));
    const tan: V3 = add(scale(U, -Math.sin(phi)), scale(V, Math.cos(phi)));
    return g(add(at(0.012, 0, 0), scale(r, 0.045)), tan, r);
  };
  const thread = g(at(0.0, RC + 0.03, 0), U, U);
  const pulled = g(at(0.0, 0.1, 0.0), U, U);
  const rest1 = g(at(0.1, 0.15, 0.04), T, U);
  const onTie = (d: number) => g(at(d, 0, 0), T, U);
  const keys: Key[] = [
    [0, ready], [T_.place0, ready], [T_.place1, placed], [T_.wrap0, slid],
  ];
  const n = 8;
  for (let k = 0; k <= n; k++) keys.push([T_.wrap0 + ((T_.wrap1 - T_.wrap0) * k) / n + 1e-3, round((2 * Math.PI * k) / n)]);
  keys.push([T_.thread1, thread], [T_.cinch1, pulled], [T_.let + 0.8, rest1], [T_.reach, rest1], [T_.close, onTie(0)], [T_.close + 0.25, onTie(0)],
    [T_.down1, onTie(0.004)], [T_.up1, onTie(-0.03)], [T_.back1, onTie(0)], [T_.open, onTie(0)], [T_.rest + 0.6, REST_R]);
  // (the wrap: a circle, so not eased between its keys)
  const path = gripPath(keys);
  const circle = (t: number) => round((2 * Math.PI * (t - T_.wrap0)) / (T_.wrap1 - T_.wrap0));
  const grip = (t: number): Grip => (t > T_.wrap0 + 0.15 && t < T_.wrap1 - 0.05 ? circle(t) : path(t));
  const open = valPath([[0, 0], [T_.let, 0], [T_.let + 0.2, 1], [T_.close - 0.05, 1], [T_.close + 0.1, 0], [T_.open, 0], [T_.open + 0.2, 1]]);
  return { grip, open };
}

/** where the tie is and what the band does (for the part): wrap / thread / cinch progress 0..1 */
export function prepStrap(t: number) {
  const T_ = PREP_T;
  return {
    /** 0: carried in the hand, 1: the eyelet against the cable */
    place: ramp(t, T_.place0, T_.place1),
    wrap: (t - T_.wrap0) / (T_.wrap1 - T_.wrap0),
    thread: ramp(t, T_.wrap1, T_.thread1),
    cinch: ramp(t, T_.thread1, T_.cinch1),
    /** the hand holds the band (0 = let go) */
    held: t < T_.let ? 1 : 1 - ramp(t, T_.let, T_.let + 0.25),
  };
}

export function prepRig(plan: PrepPlan) {
  const hand = prepHand(plan);
  const fist = prepFist();
  return (t: number): Rig => {
    const left: HandRig = { grip: fist, hold: 'fist', radius: 0.0095, wrap: 0.7, free: 0.2 };
    const right = pinchR(hand.grip(t), hand.open(t));
    const look = mix3(plan.p, add(plan.p, [0.4, -0.3, -0.9]), ramp(t, PREP_T.rest + 1.5, PREP_T.rest + 3.5));
    return { ...rigBase(t), look, hands: [left, right] };
  };
}
export const prepTrack = (plan: PrepPlan) => new RigTrack(SPEC, prepRig(plan), 0, 60);

/** the cable from the male plug's tip in the fist, down to the floor, along it and up to the mic, `total` long */
function prepPath(total: number): V3[] {
  const f = PREP.fist, d = PREP.plugDir;
  const tip = add(f, scale(d, 0.035));
  const boot = add(f, scale(d, -0.025));
  const bez = (p0: V3, p1: V3, p2: V3, p3: V3, n: number): V3[] => {
    const out: V3[] = [];
    for (let k = 1; k <= n; k++) {
      const u = k / n, a = (1 - u) ** 3, b = 3 * u * (1 - u) ** 2, c = 3 * u * u * (1 - u), e = u ** 3;
      out.push([a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1], a * p0[2] + b * p1[2] + c * p2[2] + e * p3[2]]);
    }
    return out;
  };
  const fl1: V3 = [f[0] + 0.12, RC, f[2] - 0.32];
  const st: V3 = [PREP.stand[0], 0, PREP.stand[1]];
  const fl2: V3 = [st[0] - 0.1, RC, st[2] + 0.2];
  const micBoot = add(MIC.tail, scale(PREP.micDir, -0.06));
  const run = normalize(sub(fl2, fl1));
  const down = bez(boot, add(boot, scale(d, -0.25)), add(fl1, [-run[0] * 0.3, 0.25, -run[2] * 0.3]), fl1, 60);
  const up = bez(fl2, add(fl2, scale(run, 0.18)), add(micBoot, add(scale(PREP.micDir, -0.4), [-0.03, 0, 0.03])), micBoot, 80);
  const side: V3 = normalize(cross(UP, run));
  const floorRun = (amp: number): V3[] => {
    const out: V3[] = [], L = len(sub(fl2, fl1)), K = 120;
    for (let k = 1; k < K; k++) {
      const u = k / K;
      out.push(add(add(fl1, scale(run, u * L)), scale(side, amp * Math.sin(2 * Math.PI * u) * Math.sin(Math.PI * u))));
    }
    return out;
  };
  const build = (amp: number) => [tip, boot, ...down, ...floorRun(amp), fl2, ...up, MIC.tail];
  const length = (pts: V3[]) => pts.reduce((s, q, i) => (i ? s + len(sub(q, pts[i - 1])) : 0), 0);
  // the floor run snakes just enough to use up the cable
  let lo = 0, hi = 1.2;
  for (let it = 0; it < 40; it++) {
    const m = (lo + hi) / 2;
    if (length(build(m)) < total) lo = m;
    else hi = m;
  }
  return build(lo);
}

/** the mic stand as capsules: tube and three legs (props.ts micStand) */
function standCapsules(): Capsule[] {
  const [x, z] = PREP.stand, hub = 0.3;
  const out: Capsule[] = [{ a: [x, hub, z], b: [x, PREP.standH, z], r: 0.0125 }];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
    out.push({ a: [x + Math.sin(a) * 0.02, hub, z + Math.cos(a) * 0.02], b: [x + Math.sin(a) * 0.36, 0.012, z + Math.cos(a) * 0.36], r: 0.009 });
  }
  return out;
}

const prepShot: ShotDef = {
  id: 'p4-prep',
  duration: PREP_T.end,
  fps: 60,
  substeps: XLR.substeps,
  build() {
    const total = 4.74;
    const { rod } = buildCable(XLR, prepPath(total), { plugs: 'both' });
    rod.restFric.fill(0);
    rod.setRestStraight();
    const L = rod.totalLength;
    const fist = prepFist();
    const fistF: Frame = { p: fist.p, q: fist.q };
    const PRE = -2.5;
    rod.time = PRE;
    const left: Bundle = rod.bundle({ frame: fistF, hand: 0, blend: 0.001 });
    left.add(0, 0.06);
    const mic: Bundle = rod.bundle({ frame: { p: [...MIC.tail] as V3, q: [0, 0, 0, 1] }, blend: 0.001 });
    mic.add(L - 0.06, L);
    const stand = standCapsules();
    // his body: the pose once (he stands still; the arms move, the cable hangs in front of his legs)
    const body = capsulesOf(new RigTrack(SPEC, (t) => ({ ...rigBase(t), look: PREP.fist, hands: [null, null] }), 0, 60).pose(0)).filter((c) => c.part === 'torso' || c.part === 'legL' || c.part === 'legR');
    rod.setCapsules(() => [...stand, ...body]);
    for (let f = 0; f < Math.round(-PRE * 60); f++) rod.step(1 / 60, XLR.substeps);
    rod.time = 0;
    rod.v.fill(0);
    rod.om.fill(0);
    // the plan: the cable at the tie, now that it hangs still
    const pS = rod.pointAt(S_STRAP), tS = normalize(rod.tangentAt(S_STRAP));
    const uS = perp([1, 0, 0.5], tS);
    const planVec = Float64Array.from([...pS, ...tS, ...uS].map((v) => Math.fround(v)));
    const hand = prepHand(prepPlanFrom(planVec));
    let pin: Pinch | null = null;
    const script = (r: Rod, t: number) => {
      if (!pin && t >= PREP_T.close) {
        // the pads close on the tie (the cable inside it): the cable follows them
        pin = r.pinch({ frame: (tt) => hand.grip(tt), s: S_STRAP, mode: 'held', blend: 0.1, hand: 1 });
      }
      if (pin && pin.state !== 'free' && t >= PREP_T.open) pin.release(0.12);
    };
    return {
      rod,
      script,
      tracks: {
        /** the material under the pads (the tie's place: it does not slide) */
        pinS: () => (pin ? pin.s : S_STRAP),
        /** how far the cable at the tie has moved from where it hung (m) */
        moved: (r) => len(sub(r.pointAt(S_STRAP), pS)),
        gap: (r) => r.maxJointGap() * 1000,
      },
      vectors: { plan: { size: 9, fn: () => planVec } },
    };
  },
};

// ===================================================================================== p4-ring-ok / -loose

export type Fit = 'ok' | 'loose';

/** shot times of the ring shots (s) */
export const RING_T = {
  /** the right hand goes to the other end (it hangs out of the ring below) and takes its plug */
  reach0: 2.4, grab: 3.25, lift1: 4.8, give: 4.85, let: 5.0,
  /** to the tie's end, round the whole ring (1.15 turns), pressed shut */
  tail0: 5.0, tail1: 5.9, wrap1: 7.8, press1: 8.4,
  /** the right hand takes the ring by the tie, the left lets go, lifts, shakes, holds */
  take: 9.2, release: 9.4, lifted: 10.7, shake0: 10.8, shake1: 13.2,
  end: 16.0,
};

/** the end plug's place before he takes it (recorded: it hangs where the simulation has it): middle, axis towards the tip */
export interface RingPlan {
  plugC: V3;
  plugD: V3;
}
export const ringPlanFrom = (v: ArrayLike<number>): RingPlan => ({ plugC: [v[0], v[1], v[2]], plugD: [v[3], v[4], v[5]] });

/** where the end plug goes: upright beside the tie, in front of the stack (factory → world) */
export function endPlugTarget(kind: RingKind) {
  const g = RING_GEOM[kind];
  const boot = ringPoint(kind, [g.strapX + 0.004, FIST[1] + 0.012, g.zMid + 0.03]);
  const d = normalize(ringDir([0.35, 1, 0.25]));
  return { c: add(boot, scale(d, 0.03)), d };
}

/** the tie's frame (world): its section's middle, turning with the fist; after the left hand lets go it is lifted and shaken */
export function tieFrame(kind: RingKind) {
  const sec = strapSection(kind);
  const q = ringFist(kind).q;
  const T = RING_T;
  return (t: number): Frame => {
    const lift = 0.08 * ramp(t, T.release, T.lifted);
    const env = ramp(t, T.shake0, T.shake0 + 0.4) * (1 - ramp(t, T.shake1 - 0.5, T.shake1));
    const sh = 0.028 * env * Math.sin(2 * Math.PI * 1.8 * (t - T.shake0));
    const sw = 0.012 * env * Math.sin(2 * Math.PI * 0.9 * (t - T.shake0) + 0.6);
    return { p: add(sec.c, add(scale(UP, lift + sh), scale(N, sw))), q };
  };
}

/** where the right hand starts round the bundle (rad from the eyelet's side towards V = A × u), how far it goes and how far the band lags behind it */
export const WRAP_PHI0 = 0.35, WRAP_TURNS = 1.15 * 2 * Math.PI, WRAP_LAG = 0.6;

/** the right hand in the ring shots (grip and openness) */
export function ringHand(kind: RingKind, plan: RingPlan) {
  const T = RING_T;
  const sec = strapSection(kind);
  const g = (q: V3, along: V3, toPalm: V3): Grip => gripFrame(q, along, perp(toPalm, along));
  const right: V3 = normalize([1, 0, 0.3]);
  // the end plug, hanging (fist round its body, thumb towards its tip), and upright beside the tie
  const atPlug = g(plan.plugC, plan.plugD, right);
  const tgt = endPlugTarget(kind);
  const lifted = g(tgt.c, tgt.d, perp(add(right, scale(N, -0.5)), tgt.d));
  // the tie's end hangs below its eyelet (beside the fist, lateral); round the whole ring: a circle about A
  const V = normalize(cross(A, sec.u));
  const R = sec.r + 0.035;
  const round = (phi: number) => {
    const r: V3 = add(scale(sec.u, Math.cos(phi)), scale(V, Math.sin(phi)));
    const tan: V3 = add(scale(sec.u, -Math.sin(phi)), scale(V, Math.cos(phi)));
    return g(add(sec.c, scale(r, R)), tan, r);
  };
  // the band hangs from the eyelet: its end about 17 cm below it
  const tailEnd = g(add(sec.c, add(scale(sec.u, 0.02), [0, -0.16, 0])), [0, -1, 0], perp(right, UP));
  /** the wrap starts just past the eyelet (the band leaves it along +V) */
  const phi0 = WRAP_PHI0;
  const turns = WRAP_TURNS;
  const wrapAt = (t: number) => round(phi0 + turns * ease((t - T.tail1) / (T.wrap1 - T.tail1)));
  // pressing the band's end onto the band where the wrap ended (on the outside of the bundle)
  const phiEnd = phi0 + turns;
  const pressed = g(add(sec.c, scale(add(scale(sec.u, Math.cos(phiEnd)), scale(V, Math.sin(phiEnd))), sec.r + 0.012)), add(scale(sec.u, -Math.sin(phiEnd)), scale(V, Math.cos(phiEnd))), add(scale(sec.u, Math.cos(phiEnd)), scale(V, Math.sin(phiEnd))));
  const tf = tieFrame(kind);
  // holding the ring by the tie: pads on the band at the top of the bundle, along the band
  const onTop = (t: number) => g(add(tf(t).p, scale(UP, sec.r + 0.01)), normalize(cross(A, UP)), UP);
  const keys: Key[] = [
    [0, REST_R], [T.reach0, REST_R], [T.grab - 0.15, atPlug], [T.grab + 0.1, atPlug], [T.lift1, lifted], [T.let + 0.05, lifted],
    [T.tail1 - 0.35, tailEnd], [T.tail1, round(phi0)],
  ];
  const before = gripPath(keys);
  const after = gripPath([[T.wrap1, wrapAt(T.wrap1)], [T.press1, pressed], [T.take - 0.1, onTop(T.take)]]);
  const grip = (t: number): Grip => {
    if (t < T.tail1) return before(t);
    if (t < T.wrap1) return wrapAt(t);
    if (t < T.take) return after(t);
    return onTop(t);
  };
  const open = valPath([[0, 1], [T.grab - 0.1, 1], [T.grab, 0], [T.give, 0], [T.let, 1], [T.tail1 - 0.1, 1], [T.tail1, 0], [T.wrap1, 0], [T.wrap1 + 0.2, 0.5], [T.take - 0.15, 0.6], [T.take, 0]]);
  /** what the pads hold: the plug's body, or the band */
  const radius = (t: number) => (t > T.grab - 0.5 && t < T.let + 0.4 ? 0.0095 : RC + 2 * STRAP.thickness);
  return { grip, open, radius };
}

/** the left hand in the ring shots: the coil grip, opened when the right hand has the ring, then down to rest */
export function ringLeft(kind: RingKind) {
  const T = RING_T;
  const grip = ringGrip(kind);
  const away = gripFrame(add(RING_AT[kind], [-0.08, -0.08, 0.1]), A, TO_PALM);
  const down = gripFrame(add(REST_L.p, [0.02, 0.06, -0.06]), A, TO_PALM);
  const path = gripPath([[T.release, grip], [T.release + 0.7, away], [T.lifted + 1.2, down]]);
  return { grip: path, open: (t: number) => ramp(t, T.release - 0.05, T.release + 0.2) };
}

export function ringRig(kind: RingKind, plan: RingPlan) {
  const hand = ringHand(kind, plan);
  const left = ringLeft(kind);
  const sec = strapSection(kind);
  return (t: number): Rig => {
    const l: HandRig = { grip: left.grip(t), hold: 'coil', radius: RING_GEOM[kind].coilR, thumbAlong: 1, free: 0.3 + 0.4 * left.open(t), open: left.open(t) };
    const r = pinchR(hand.grip(t), hand.open(t), hand.radius(t), 0.6);
    const look = mix3(add(sec.c, [0, -0.08, 0]), plan.plugC, ramp(t, RING_T.reach0 - 0.3, RING_T.grab) * (1 - ramp(t, RING_T.grab + 0.4, RING_T.lift1)));
    return { ...rigBase(t), look, hands: [l, r] };
  };
}
export const ringTrack = (kind: RingKind, plan: RingPlan) => new RigTrack(SPEC, ringRig(kind, plan), 0, 60);

/** the ring of `kind` placed in his left hand: a rod at rest, and the ring's data */
const ringCache: Partial<Record<RingKind, Ring>> = {};
export function placedRing(kind: RingKind) {
  const spec = kind === 'p4' ? P4_RING : LONG_RING;
  const ring = (ringCache[kind] ??= windRing(spec));
  const zMid = (ring.top.z0 + ring.top.z1) / 2;
  if (Math.abs(zMid - RING_GEOM[kind].zMid) > 0.002) throw new Error(`p4-strap: ring ${kind} stack middle ${zMid.toFixed(4)} m, RING_GEOM says ${RING_GEOM[kind].zMid}`);
  const rod = ringRod(ring, placeRing(ring.state, ringShift(kind), Q_RING, 0), spec);
  return { ring, rod, spec };
}

/** node ranges of the loops, the start end, the end tail (for checks and the part) */
export function ringNodes(ring: Ring) {
  return { loops: ring.loops, startEnd: [0, ring.loops[0][0]] as [number, number], tail: [ring.loops[ring.loops.length - 1][1] + 1, -1] as [number, number] };
}

function ringShot(fit: Fit): ShotDef {
  const T = RING_T;
  const kind: RingKind = 'p4';
  return {
    id: `p4-ring-${fit}`,
    duration: T.end,
    fps: 60,
    substeps: XLR.substeps,
    build() {
      const { ring, rod } = placedRing(kind);
      const n = rod.n, L = rod.totalLength;
      const fistF = ringFist(kind);
      const qInv = quatConj(fistF.q);
      const PRE = -0.6;
      rod.time = PRE;
      // the left fist holds the ring's top (still: it only lets go)
      const fist: Bundle = rod.bundle({ frame: fistF, hand: 0, blend: 0.001 });
      for (const [a, b] of ring.held) fist.add(a, b);
      for (let f = 0; f < Math.round(-PRE * 60); f++) rod.step(1 / 60, XLR.substeps);
      rod.time = 0;
      rod.v.fill(0);
      rod.om.fill(0);
      // the plan: the end plug where it hangs
      const tip = rod.pointAt(L), boot = rod.pointAt(L - 0.06);
      const plugD = normalize(sub(tip, boot)), plugC = add(boot, scale(plugD, 0.03));
      const planVec = Float64Array.from([...plugC, ...plugD].map((v) => Math.fround(v)));
      const plan = ringPlanFrom(planVec);
      const hand = ringHand(kind, plan);
      const tf = tieFrame(kind);
      const sec = strapSection(kind);
      const secL = { c: quatRotate(qInv, sub(sec.c, fistF.p)), a: quatRotate(qInv, sec.a) };
      let endHold: Bundle | null = null, tie: Bundle | null = null, tieOn = false, released = false;
      // the loose tie: two rings of capsules 16 mm apart (the band's width), 1.4 cm wider than the bundle
      const LOOSE_R = sec.r + 0.014, K = 16;
      const V0 = normalize(cross(sec.a, sec.u));
      const looseCaps = (t: number): Capsule[] => {
        const f = tf(t);
        const a = quatRotate(f.q, secL.a);
        const u = quatRotate(f.q, quatRotate(qInv, sec.u)), v = quatRotate(f.q, quatRotate(qInv, V0));
        const out: Capsule[] = [];
        for (const w of [-0.008, 0.008])
          for (let k = 0; k < K; k++) {
            const p = (j: number): V3 => add(add(f.p, scale(a, w)), add(scale(u, LOOSE_R * Math.cos((2 * Math.PI * j) / K)), scale(v, LOOSE_R * Math.sin((2 * Math.PI * j) / K))));
            out.push({ a: p(k), b: p(k + 1), r: 0.0012, mu: 0.6 });
          }
        return out;
      };
      rod.setCapsules((t) => (fit === 'loose' && tieOn ? looseCaps(t) : []));
      const inTie = (j: number) => {
        // a segment's middle in the tie's slab (2.4 cm wide along the strands) and within the bundle
        const c: V3 = [rod.c[3 * j], rod.c[3 * j + 1], rod.c[3 * j + 2]];
        const l = quatRotate(qInv, sub(c, fistF.p));
        const d = sub(l, secL.c);
        const along = dot(d, secL.a);
        const radial = len(sub(d, scale(secL.a, along)));
        return Math.abs(along) < 0.012 && radial < sec.r + 0.012;
      };
      const script = (r: Rod, t: number) => {
        if (!endHold && t >= T.grab) {
          // the right fist round the end plug's body
          endHold = r.bundle({ frame: (tt) => hand.grip(tt), hand: 1, blend: 0.12 });
          endHold.add(L - 0.06, L);
        }
        if (endHold && t >= T.give && !fist.holds(L - 0.075)) fist.add(L - 0.095, L - 0.06, 0.15);
        if (endHold && t >= T.let) {
          endHold.remove();
          endHold = null;
          rod.markKinematic();
        }
        if (!tieOn && t >= T.press1) {
          tieOn = true;
          if (fit === 'ok') {
            tie = r.bundle({ frame: tf, hand: 2, blend: 0.2 });
            for (let j = 0; j < r.ns; j++) if (inTie(j)) tie.add(r.sNode[j] + r.L[j] / 2 - 1e-6, r.sNode[j] + r.L[j] / 2 + 1e-6, 0.2);
          }
          r.markKinematic();
        }
        if (!released && t >= T.release) {
          released = true;
          fist.release(-Infinity, Infinity, 0.15);
        }
      };
      // checks: how far each loop's lowest point hangs below the tie, and the end plug
      const below = (r: Rod, t: number, a: number, b: number) => {
        const y = tf(t).p[1];
        let m = Infinity;
        for (let i = a; i <= b; i++) m = Math.min(m, r.x[3 * i + 1]);
        return y - m;
      };
      const tracks: Record<string, (r: Rod, t: number) => number> = {
        endBelow: (r, t) => tf(t).p[1] - r.x[3 * (n - 1) + 1],
        startBelow: (r, t) => tf(t).p[1] - r.x[1],
        gap: (r) => r.maxJointGap() * 1000,
        tieMembers: () => (tie ? tie.ranges().length : 0),
      };
      ring.loops.forEach(([a, b], k) => (tracks[`loop${k}`] = (r, t) => below(r, t, a, b)));
      return { rod, script, tracks, vectors: { plan: { size: 6, fn: () => planVec } } };
    },
  };
}

// ===================================================================================== p4-two

/** shot times of p4-two (s): the right hand to the bottom, gathers the loops, the second tie round them, back */
export const TWO_T = { reach0: 0.6, gather0: 1.2, gather1: 2.4, wrap1: 4.0, press1: 4.4, back0: 4.6, back1: 5.6, end: 7.5 };

/** the second tie's section: the bottom of the long ring, factory (0, bottom + r, zMid) */
export function bottomSection() {
  const g = RING_GEOM.long;
  const yb = FIST[1] - 2 * 0.136 + 0.004;
  const c = ringPoint('long', [0, yb + 0.02, g.zMid]);
  const a = normalize(ringDir([-1, 0, 0]));
  const u = normalize(ringDir([0, -1, 0]));
  return { c, a, u, r: 0.024 };
}

export function twoHand() {
  const T = TWO_T;
  const sec = bottomSection();
  const g = (q: V3, along: V3, toPalm: V3): Grip => gripFrame(q, along, perp(toPalm, along));
  const V = normalize(cross(sec.a, sec.u));
  const R = sec.r + 0.04;
  const round = (phi: number) => {
    const r: V3 = add(scale(sec.u, Math.cos(phi)), scale(V, Math.sin(phi)));
    const tan: V3 = add(scale(sec.u, -Math.sin(phi)), scale(V, Math.cos(phi)));
    return g(add(sec.c, scale(r, R)), tan, r);
  };
  const squeeze = g(add(sec.c, scale(V, -0.035)), sec.a, scale(V, -1));
  const keys: Key[] = [[0, REST_R], [T.reach0, REST_R], [T.gather0, squeeze], [T.gather1, g(add(sec.c, scale(V, -0.028)), sec.a, scale(V, -1))], [T.gather1 + 0.3, round(-Math.PI / 2)]];
  const path = gripPath(keys);
  const wrapAt = (t: number) => round(-Math.PI / 2 + 2.3 * Math.PI * ease((t - T.gather1 - 0.3) / (T.wrap1 - T.gather1 - 0.3)));
  const end = gripPath([[T.wrap1, wrapAt(T.wrap1)], [T.press1, g(add(sec.c, scale(sec.u, -(sec.r + 0.01))), V, scale(sec.u, -1))], [T.back1, REST_R]]);
  const grip = (t: number) => (t < T.gather1 + 0.3 ? path(t) : t < T.wrap1 ? wrapAt(t) : end(t));
  const open = valPath([[0, 1], [T.gather0 - 0.1, 1], [T.gather0, 0.3], [T.press1, 0.3], [T.back0, 1]]);
  return { grip, open };
}

export function twoRig() {
  const hand = twoHand();
  const sec = bottomSection();
  return (t: number): Rig => {
    const left: HandRig = { grip: ringGrip('long'), hold: 'coil', radius: RING_GEOM.long.coilR, thumbAlong: 1, free: 0.3 };
    const right = pinchR(hand.grip(t), hand.open(t), 0.02, 0.6);
    return { ...rigBase(t + 3), look: add(sec.c, [0, 0.06, 0]), hands: [left, right], reach: 0.8 };
  };
}
export const twoTrack = () => new RigTrack(SPEC, twoRig(), 0, 60);

const twoShot: ShotDef = {
  id: 'p4-two',
  duration: TWO_T.end,
  fps: 60,
  substeps: XLR.substeps,
  build() {
    const kind: RingKind = 'long';
    const { ring, rod } = placedRing(kind);
    const fistF = ringFist(kind);
    const qInv = quatConj(fistF.q);
    const PRE = -0.6;
    rod.time = PRE;
    const fist: Bundle = rod.bundle({ frame: fistF, hand: 0, blend: 0.001 });
    for (const [a, b] of ring.held) fist.add(a, b);
    for (let f = 0; f < Math.round(-PRE * 60); f++) rod.step(1 / 60, XLR.substeps);
    rod.time = 0;
    rod.v.fill(0);
    rod.om.fill(0);
    const sec = bottomSection();
    // the strands at the bottom: segments within 2 cm of the bottom's middle line (along the strands) and its lowest 6 cm
    const secL = { c: quatRotate(qInv, sub(sec.c, fistF.p)), a: quatRotate(qInv, sec.a), u: quatRotate(qInv, sec.u) };
    const sel: number[] = [];
    for (let i = 0; i < rod.n; i++) {
      const l = quatRotate(qInv, sub([rod.x[3 * i], rod.x[3 * i + 1], rod.x[3 * i + 2]], fistF.p));
      const d = sub(l, secL.c);
      if (Math.abs(dot(d, secL.a)) < 0.014 && dot(d, secL.u) > -0.05 && dot(d, secL.u) < 0.06) sel.push(i);
    }
    const selSet = new Set(sel);
    // the hand squeezes them together: each is pulled towards the section's middle line, to within the bundle's radius
    const start = new Map<number, V3>();
    for (const i of sel) start.set(i, [rod.x[3 * i], rod.x[3 * i + 1], rod.x[3 * i + 2]]);
    const T = TWO_T;
    const target = (i: number, t: number): V3 | null => {
      if (!selSet.has(i) || t < T.gather0) return null;
      const p0 = start.get(i) as V3;
      const d = sub(p0, sec.c);
      const along = dot(d, sec.a);
      const rad = sub(d, scale(sec.a, along));
      const rl = len(rad);
      const want = Math.min(rl, sec.r * 0.75);
      const u = ramp(t, T.gather0, T.gather1);
      return add(sec.c, add(scale(sec.a, along), scale(rad, rl > 1e-6 ? (rl + (want - rl) * u) / rl : 1)));
    };
    let guide = -1, tie: Bundle | null = null;
    void fist;
    const script = (r: Rod, t: number) => {
      if (guide < 0 && tie === null && t >= T.gather0 && sel.length) guide = r.addGuide({ nodes: [sel[0], sel[sel.length - 1]], target, compliance: 2e-3 });
      if (!tie && t >= T.gather1) {
        tie = r.bundle({ frame: fistF, hand: 2, blend: 0.3 });
        for (const i of sel) if (i < r.ns && selSet.has(i + 1)) tie.add(r.sNode[i] + r.L[i] / 2 - 1e-6, r.sNode[i] + r.L[i] / 2 + 1e-6, 0.3);
      }
      if (guide >= 0 && t >= T.gather1 + 0.35) {
        r.removeGuide(guide);
        guide = -2;
      }
    };
    return {
      rod,
      script,
      tracks: {
        gap: (r) => r.maxJointGap() * 1000,
        /** the spread of the gathered strands across the strands' direction (max distance from the middle line, m) */
        spread: (r) => {
          let m = 0;
          for (const i of sel) {
            const d = sub([r.x[3 * i], r.x[3 * i + 1], r.x[3 * i + 2]], sec.c);
            m = Math.max(m, len(sub(d, scale(sec.a, dot(d, sec.a)))));
          }
          return m;
        },
      },
    };
  },
};

export const P4_SHOTS: ShotDef[] = [prepShot, ringShot('ok'), ringShot('loose'), twoShot];
export const P4_ID = { prep: 'p4-prep', ok: 'p4-ring-ok', loose: 'p4-ring-loose', two: 'p4-two' } as const;
