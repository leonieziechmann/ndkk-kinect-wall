// Stage 5.3 (part p5-size): Noor's rough choreography for the size shots (shots/p5-size.ts), as
// rigs for people/rig.ts. Pure TypeScript (no three.js): the part builds RigTracks from it.
//
// Rough animation: her hands sit on exactly the frames the simulation used (the right hand around
// the cable where it leaves the guided supply, the left hand where the supply runs through it, the
// fist frame of the rings, the foot of the big ring); everything between is simple keyframes with
// smooth eases, a little breathing and weight shift, the head looking at what matters. The
// recorded movements (mocap shots p5.size.*) replace all of it later.

import type { V3 } from '../sim';
import { NOOR } from '../people/cast';
import { Grip, HandRig, Rig, gripFrame, stand } from '../people/rig';
import { RING_FIST, RING_N, RING_Q, RingKind, SINK, SINK_T, ease, rightFoot, ringFist, sinkLH, sinkRH, sinkSupply } from './p5-size';
import { EIGHT_GEOM, SNAP_T, fistFrame, layPads } from './eight';
import { COIL_R, REST_R, leftGrip } from './p5-eight-rig';

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
const lerp = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const ramp = (t: number, a: number, b: number) => ease((t - a) / (b - a));
const UP: V3 = [0, 1, 0];
const RC = 0.0032;

/** a little breathing and weight shift (scene time s): never quite still */
function idle(s: number) {
  return {
    lean: 0.05 + 0.012 * Math.sin(1.3 * s) + 0.008 * Math.sin(0.37 * s + 1),
    bend: 0.012 * Math.sin(0.41 * s + 0.4),
    twist: 0.02 * Math.sin(0.29 * s + 2),
    drop: 0.01 + 0.006 * Math.sin(1.3 * s + 0.6),
  };
}

/** the supply's direction at the point nearest p (its polyline at time t) */
function supplyDir(t: number, p: V3): V3 {
  const { P } = sinkSupply(t);
  let best = 0, d = Infinity;
  P.forEach((q, i) => {
    const e = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    if (e < d) { d = e; best = i; }
  });
  const a = P[Math.max(0, best - 2)], b = P[Math.min(P.length - 1, best + 2)];
  return norm(sub(b, a));
}

/** where the cable reaches the floor below her right hand (she watches it) */
const landing = (t: number): V3 => {
  const r = sinkRH(t);
  return [r[0] + 0.05, 0.02, r[2] - 0.05];
};

/**
 * Noor's rig for the sink at shot time t (scene time s for the idle motion). Her right hand is a
 * loosely closed fist round the cable, which runs down through it; the left hand holds the cable
 * from the floor loosely, so it slides through; she watches where it lands; then the left hand
 * comes to the front of her belly (the ghost loop will hang from it).
 */
export function sinkRig(t: number, s: number): Rig {
  // (she turns a little to her right as the right hand moves along)
  const yaw = 0.04 + 0.22 * ramp(t, SINK_T.feed0, SINK_T.feed1);
  const base = { ...stand(NOOR, [0, 0], yaw, { width: 0.28, stagger: 0.05 }), ...idle(s), reach: 0.6 };
  const rh = sinkRH(t), lh = sinkLH(t);
  // right: the cable leaves the fist downward; the palm toward her right and back (the hand behind the cable)
  const right: HandRig = { grip: gripFrame(rh, UP, norm([0.75, 0, 0.66])), hold: 'fist', radius: RC, thumbAlong: 1, open: 0.35, wrap: 0.4, free: 0.5 };
  // left: the cable runs through the loose fist (palm under it), toward the right hand
  const along = supplyDir(t, lh);
  const toPalm = norm(sub([0, -1, 0.25], mul(along, dot([0, -1, 0.25], along))));
  const left: HandRig = { grip: gripFrame(lh, mul(along, -1), toPalm), hold: 'fist', radius: RC, thumbAlong: 1, open: 0.4, wrap: 0.3, free: 0.85 };
  const lookFloor = landing(t);
  const lookHip: V3 = add(SINK.lhShow, [0, -0.12, -0.02]);
  const look = lerp(lookFloor, lookHip, ramp(t, SINK_T.lift0 - 0.3, SINK_T.lift0 + 0.6));
  const lean = base.lean + 0.1 * (1 - ramp(t, SINK_T.lift0, SINK_T.lift1));
  return { ...base, lean, look, hands: [left, right] };
}

/** the left hand's grip on a ring's top: strands through the fist (the factory's x), the palm behind them */
export function ringGrip(t: number): Grip {
  const along: V3 = qx();
  const tp = norm(add(mul(RING_N, -0.9), mul(UP, -0.4)));
  const toPalm = norm(sub(tp, mul(along, dot(tp, along))));
  // (the bundle's middle: a little in front of the first loop, on the strands)
  const p = add(ringFist(t), add(mul(RING_N, 0.03), [0, 0.004, 0]));
  return gripFrame(p, along, toPalm);
}

/** the factory's +x (along the strands at the top) turned like the ring */
function qx(): V3 {
  const [x, y, z, w] = RING_Q;
  // rotate [1, 0, 0] by the quaternion
  return norm([1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)]);
}

/**
 * Noor's rig for a ring shot at shot time t: she holds the ring by its top in her left fist, lowers
 * it from chest to hip height and holds it; the right hand hangs; with the big ring her right foot
 * steps onto the loop on the floor. She looks at the ring (at her foot while it steps).
 */
export function ringRig(kind: RingKind, t: number, s: number): Rig {
  const base = { ...stand(NOOR, [0, 0], 0, { width: 0.26, stagger: 0.0 }), ...idle(s), reach: 0.6 };
  const left: HandRig = { grip: ringGrip(t), hold: 'coil', radius: kind === 'small' ? 0.016 : 0.013, thumbAlong: 1, free: 0.5 };
  const foot = rightFoot(kind, t);
  const feet = base.feet;
  const f1 = { ankle: foot.ankle, dir: foot.dir };
  const ring = add(ringFist(t), [0.05, -0.25, -0.02]);
  let look: V3 = ring;
  if (kind === 'big') look = lerp(ring, add(foot.ankle, [0, 0, -0.15]), ramp(t, 2.2, 2.8) * (1 - 0.6 * ramp(t, 4.4, 5.2)));
  return { ...base, look, feet: [feet[0], f1], hands: [left, null], swing: [0, 0.05] };
}

/** where the fist is at the start of the ring shots (chest) and at the end (hip) */
export const RING_FIST_AT = RING_FIST;

// ===================================================================================== the bulge (POV)

/**
 * The bulge beat (kinematic cable, see the part): the timing. The right hand brings the cable back
 * from her hip to her fist as in stage 5.2 (eight.ts SNAP_T back0 → back1); the loop is too short
 * and bulges; she loosens the pinch and lets 5 cm more slide into the loop (letOut); then the fist
 * takes it, the pads open, the hand goes back to her side.
 */
export const MORE_T = {
  back0: SNAP_T.back0,
  back1: SNAP_T.back1,
  /** the loop bulges while the hand comes in (it is too short) */
  bulge0: 0.95,
  bulge1: 1.5,
  letOut0: 1.7,
  letOut1: 2.5,
  give: 2.75,
  open: 2.85,
  away0: 3.0,
  away1: 3.85,
  end: 4.6,
};

/** loop length while it is too short, and after 5 cm more [m] */
export const MORE_L = { short: 0.7, long: 0.75 };

/** Noor's rig for the bulge beat at shot time t (scene time s for the idle motion) */
export function moreRig(t: number, s: number): Rig {
  const base = { ...stand(NOOR, [0, 0], 0, { width: 0.26, stagger: 0.06 }), ...idle(s), reach: 0.6 };
  const G = EIGHT_GEOM;
  const left: HandRig = { grip: leftGrip(fistFrame(G.F)), hold: 'coil', radius: COIL_R, thumbAlong: 1, free: 0.3 };
  const pads = layPads('over');
  const PINCH = { hold: 'pinch' as const, radius: RC, free: 1 };
  let right: HandRig;
  if (t < MORE_T.open) {
    // (the pinch loosens while the cable slides through it)
    const loosen = ramp(t, MORE_T.letOut0 - 0.1, MORE_T.letOut0 + 0.15) * (1 - ramp(t, MORE_T.letOut1 - 0.15, MORE_T.letOut1 + 0.1));
    right = { grip: pads(Math.min(t, MORE_T.back1)) as Grip, ...PINCH, open: 0.45 * loosen };
  } else {
    const u = ramp(t, MORE_T.away0, MORE_T.away1);
    const g0 = pads(MORE_T.back1) as Grip;
    right = { grip: { p: lerp(g0.p, REST_R.p, u), q: u < 0.5 ? g0.q : REST_R.q }, ...PINCH, open: Math.min(1, (t - MORE_T.open) / 0.15) };
  }
  const look = lerp(add(G.hip, [-0.1, 0, -0.1]), add(G.F, [0.03, -0.16, 0]), ramp(t, MORE_T.back0, MORE_T.back1));
  return { ...base, look, hands: [left, right] };
}
