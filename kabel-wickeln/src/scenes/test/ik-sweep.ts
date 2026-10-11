// The IK test choreography (pure TS, also loaded by tools/simtest/ik-continuity.mjs and
// ik-sweep-check.mjs): Noor's hands on the over-under path of the reference videos, as targets only
// (no cable). It also shows how to key the hands with the rig.ts API.
//
// Left hand: holds a coil in front of the left hip (palm towards the midline, the bundle pointing
// forward like a rod the loops hang on) and moves between the hip and the midline.
// Right hand: pinches the cable next to the left hand, the thumb tip towards the coil (the cable runs
// along the thumb: cross 0.3), slides out to the right hip with the pinch loosened (the cable turns
// across the thumb pad, cross 1.2, the fingers hang, the back of the hand forward: B 2.3), and comes
// back rolling the cable (over loop). For the under loop it turns over at the right hip by 145°: the
// grip frame the hand reached at the hip is turned about the forearm's axis (rig.ts
// turnWithForearm, free: 0), so the forearm supinates (palm up and forward, the thumb tip away from
// the coil) while elbow and shoulder stay low; on the way back the turn unwinds into the start pose.
//
// The cable direction d3 at the pinch is where the cable leaves past the thumb tip (body/hand.ts
// pinchAround). Turned over, the cable leaves the pads away from the coil and comes back to it over
// the back of the hand (the wrist in the loop).

import { V3, Quat, norm, quatCols, slerp } from '../../people/math';
import type { Pose } from '../../people/people';
import { NOOR } from '../../people/cast';
import { Grip, HandRig, Key, Rig, gripFrame, keys, rigPose, stand, turnWithForearm } from '../../people/rig';

/** one over loop and one under loop, s */
export const SWEEP_PERIOD = 6.6;

/** the beats of a period (s): used by the checks and the test scene */
export const SWEEP_BEATS = {
  /** pinched next to the left hand */
  start: 0.2,
  /** slid out, at the right hip */
  out: 1.35,
  /** over loop: laying the cable into the left hand */
  overIn: 2.7,
  /** the second slide out */
  out2: 4.55,
  /** turned over at the right hip (under loop) */
  turned: 5.1,
  /** coming back, still turned */
  back: 5.5,
  /** under loop: laying into the left hand */
  underIn: 6.2,
};

/**
 * How far the hand turns over for the under loop, rad: the forearm supinates from about 30° pronated
 * to its limit (115°), the wrist does the rest. With the elbow bent at the hip, the upper arm's
 * rotation would swing the forearm sideways rather than turn the hand, so more would lift the arm.
 */
export const UNDER_TURN = (145 * Math.PI) / 180;

const k = <T>(list: [number, T][]) => list as Key<T>[];

/** the right hand's pinch point */
const rightP = keys(k<V3>([
  [0.0, [-0.02, 0.88, -0.31]],
  [0.35, [0.0, 0.875, -0.31]],
  [1.35, [0.3, 0.84, -0.2]],
  [1.6, [0.31, 0.845, -0.2]],
  [2.7, [-0.01, 0.885, -0.32]],
  [3.3, [-0.02, 0.88, -0.31]],
  [3.65, [0.0, 0.875, -0.31]],
  [4.55, [0.3, 0.84, -0.2]],
  // turned over, the hand comes up a little (B 6.1)
  [5.1, [0.3, 0.9, -0.26]],
  [5.5, [0.2, 0.92, -0.32]],
  [6.2, [-0.01, 0.89, -0.32]],
  [6.6, [-0.02, 0.88, -0.31]],
]));

/** towards the coil from next to it: along the thumb, a little down into the loop between the hands */
const towards: V3 = norm([-1, -0.3, -0.35]);
/** at the right hip: the cable comes in from the coil, sagging, and runs down past the thumb tip */
const sagging: V3 = norm([-0.6, -1, -0.3]);
const rightDir = keys(k<V3>([
  [0, towards],
  [0.35, towards],
  [1.35, sagging],
  [1.6, sagging],
  [2.7, towards],
  [3.65, towards],
  [4.55, sagging],
  [6.2, towards],
]));
/**
 * The angle between thumb and cable (HandRig.cross): next to the coil the cable runs along the thumb
 * towards it (A 3.0/4.0); while the hand slides out it turns across the thumb pad, and at the hip it
 * crosses the pad at about 70° while the fingers hang and the thumb points down (B 2.3)
 */
const rightCross = keys(k<number>([[0, 0.3], [0.35, 0.3], [1.35, 1.2], [1.6, 1.2], [2.7, 0.3], [3.65, 0.3], [4.55, 1.2], [5.5, 1.2], [6.2, 0.3]]));
/** 0 next to the coil … 1 out at the hip */
const outside = keys(k<number>([[0, 0], [0.35, 0], [1.35, 1], [1.6, 1], [2.7, 0], [3.65, 0], [4.55, 1], [5.5, 1], [6.2, 0]]));
/** the palm's wish out at the hip: back towards the body and down (the back of the hand forward and out, B 2.3; the forearm pronated, so it has room to turn over) */
const PALM_IN: V3 = norm([-0.4, -0.3, 0.87]);

/** the roll of the cable between thumb and index finger on the way back (rad) */
const rightRoll = keys(k<number>([
  [0, 0], [1.6, 0], [2.7, 0.7], [3.3, 0], [5.2, 0], [6.2, -0.7], [6.6, 0],
]));
/** the pinch loosens while the hand slides out */
const rightOpen = keys(k<number>([
  [0, 0], [0.35, 0], [0.5, 0.6], [1.3, 0.6], [1.5, 0], [3.3, 0], [3.65, 0], [3.8, 0.6], [4.5, 0.6], [4.65, 0], [6.6, 0],
]));

/** the under loop (from out2 to the hand-over): the turn (0 … 1 of UNDER_TURN), and the way from the hip frame to the start frame */
const UNDER = [SWEEP_BEATS.out2, SWEEP_BEATS.underIn] as const;
const turn = keys(k<number>([[UNDER[0], 0], [SWEEP_BEATS.turned, 1], [SWEEP_BEATS.back, 1], [UNDER[1], 0]]));
const home = keys(k<number>([[SWEEP_BEATS.back, 0], [UNDER[1], 1]]));
/** how freely the hand may turn about the cable: the turn holds the whole frame (0), the rest only the cable's direction (1) */
const rightFree = keys(k<number>([[UNDER[0], 1], [UNDER[0] + 0.12, 0], [UNDER[1], 0], [UNDER[1] + 0.2, 1]]));

/** the left hand: in front of the left hip, towards the midline for every hand-over, out while the right slides */
const leftP = keys(k<V3>([
  [0.0, [-0.08, 0.9, -0.3]],
  [1.35, [-0.2, 0.87, -0.22]],
  [2.7, [-0.08, 0.9, -0.3]],
  [3.3, [-0.08, 0.9, -0.3]],
  [4.65, [-0.2, 0.87, -0.22]],
  [6.2, [-0.08, 0.9, -0.3]],
  [6.6, [-0.08, 0.9, -0.3]],
]));
/** the bundle lies across the fingers pointing forward (and up a little: the wrist stays straight), the palm faces the midline */
const LEFT_ALONG: V3 = norm([0.1, 0.4, -1]);
const LEFT_TO_PALM: V3 = [-1, 0.1, 0];

/** the right hand outside the under loop: the cable's direction, the hand free about it, wishes for the thumb and the palm */
function pinchAt(u: number, free = 1): HandRig {
  const p = rightP(u);
  const lp = leftP(u);
  // the thumb tip towards the coil (the left hand) next to it; out at the hip the palm towards the body
  const toCoil = norm([lp[0] - p[0], 0.4 * (lp[1] - p[1]), lp[2] - p[2]]);
  const out = outside(u);
  return {
    grip: gripFrame(p, norm(rightDir(u)), [0, 0, 1]),
    hold: 'pinch',
    radius: 0.0032,
    roll: rightRoll(u),
    open: rightOpen(u),
    cross: rightCross(u),
    free,
    thumbTo: toCoil,
    thumbWeight: 0.2 * (1 - out),
    prefer: [{ hand: [0, 1, 0], world: PALM_IN, weight: 0.3 * out }],
  };
}

const rigOf = (left: HandRig, right: HandRig): Rig => ({ ...stand(NOOR, [0, 0], 0, { width: 0.3 }), lean: 0.05, look: [0.05, 0.85, -0.35], hands: [left, right] });
const leftAt = (u: number): HandRig => ({ grip: gripFrame(leftP(u), LEFT_ALONG, LEFT_TO_PALM), hold: 'coil', radius: 0.012, free: 0.6 });

/**
 * The frames the right hand reaches at the hip before the under loop and next to the coil after it
 * (solved once, statelessly): the under loop turns the first about the forearm and ends in the second.
 */
const OUT_POSE = rigPose(NOOR, rigOf(leftAt(UNDER[0]), pinchAt(UNDER[0])));
const padsD1 = (pose: Pose): V3 => quatCols(pose.body.arms?.[1].pads?.q ?? [0, 0, 0, 1])[0];
/** at the hip: the cable's direction as asked, the hand's angle about it as reached */
const OUT_Q = gripFrame([0, 0, 0], sagging, padsD1(OUT_POSE)).q;
/** next to the coil after the under loop: the same */
const HOME_D1 = padsD1(rigPose(NOOR, rigOf(leftAt(UNDER[1]), pinchAt(UNDER[1]))));
const HOME_Q = gripFrame([0, 0, 0], towards, HOME_D1).q;

/** the hand targets at time t (s, periodic) */
export function sweepHands(t: number): { left: HandRig; right: HandRig } {
  const u = ((t % SWEEP_PERIOD) + SWEEP_PERIOD) % SWEEP_PERIOD;
  const left = leftAt(u);
  if (u <= UNDER[0]) return { left, right: pinchAt(u) };
  // the hand-over after the under loop: the frame it arrived in, then free about the cable again
  if (u >= UNDER[1]) return { left, right: { ...pinchAt(u, rightFree(u)), grip: { p: rightP(u), q: HOME_Q } } };
  // the under loop: the hip frame turned about the forearm (supination), unwinding into the start frame
  const base: Grip = { p: rightP(u), q: slerp(OUT_Q, HOME_Q, home(u)) };
  const pinch = pinchAt(u, rightFree(u));
  // the wishes fade while the frame takes over
  const prefer = (pinch.prefer ?? []).map((g) => ({ ...g, weight: (g.weight ?? 1) * rightFree(u) }));
  const right: HandRig = { ...pinch, grip: turnWithForearm(OUT_POSE, 1, base, UNDER_TURN * turn(u)), thumbTo: undefined, prefer };
  return { left, right };
}

/** Noor's whole rig on the sweep */
export function sweepRig(t: number): Rig {
  const h = sweepHands(t);
  return rigOf(h.left, h.right);
}

/** the right hand's grip as asked (for drawing the target in the test scene) */
export function sweepTarget(t: number): Grip {
  const g = sweepHands(t).right.grip;
  return g ?? { p: [0, 0, 0], q: [0, 0, 0, 1] as Quat };
}
