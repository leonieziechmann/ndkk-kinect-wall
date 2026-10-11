// The IK test choreography (pure TS, also loaded by tools/simtest/ik-continuity.mjs): Noor's hands
// on the over-under path of the reference videos, as targets only (no cable). The left hand holds a
// coil in front of the left hip (palm towards the midline, the bundle pointing forward) and moves
// between the hip and the midline; the right hand pinches the cable next to it (thumb towards the
// coil), slides out to the right hip, comes back rolling the cable (over loop); for the under loop it
// turns over at the right hip (palm up, thumb away from the coil) and turns back on the way in.

import { V3, Quat, norm } from '../../people/math';
import { NOOR } from '../../people/cast';
import { Grip, HandRig, Key, Rig, gripFrame, keys, stand } from '../../people/rig';

/** one over loop and one under loop, s */
export const SWEEP_PERIOD = 6.6;

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
  [5.05, [0.31, 0.93, -0.3]],
  [5.55, [0.17, 0.94, -0.34]],
  [6.2, [-0.01, 0.89, -0.32]],
  [6.6, [-0.02, 0.88, -0.31]],
]));

/**
 * The cable's direction where the right hand pinches it (body/hand.ts pinchAround: it crosses the
 * thumb pad and leaves on the palm side towards +d3): towards the coil, a little down and forward
 * next to the left hand, more down at the hip where it sags. Turned over for the under loop, the
 * cable to the coil leaves over the back of the hand: +d3 points away from the coil.
 */
const towards: V3 = norm([-1, -0.3, -0.35]);
const sagging: V3 = norm([-1, -0.6, -0.35]);
const awayD3: V3 = norm([0.9, 0.25, -0.35]);
const rightDir = keys(k<V3>([
  [0, towards],
  [0.35, towards],
  [1.35, sagging],
  [1.6, sagging],
  [2.7, towards],
  [3.65, towards],
  [4.55, sagging],
  [5.05, awayD3],
  [5.55, awayD3],
  [6.2, towards],
]));

/** mild wishes for the right hand: the thumb on top while sliding, the palm forward and up when turned over */
const THUMB_UP: V3 = [0, 1, 0];
const PALM_FWD: V3 = norm([0, 0.5, -1]);
/** 0 = the thumb wish counts, 1 = the palm wish */
const turned = keys(k<number>([[0, 0], [4.55, 0], [5.05, 1], [5.55, 1], [6.2, 0]]));

/** the roll of the cable between thumb and index finger on the way back (rad) */
const rightRoll = keys(k<number>([
  [0, 0], [1.6, 0], [2.7, 0.7], [3.3, 0], [5.2, 0], [6.2, -0.7], [6.6, 0],
]));
/** the pinch loosens while the hand slides out */
const rightOpen = keys(k<number>([
  [0, 0], [0.35, 0], [0.5, 0.6], [1.3, 0.6], [1.5, 0], [3.3, 0], [3.65, 0], [3.8, 0.6], [4.6, 0.6], [4.8, 0], [6.6, 0],
]));

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

/** the hand targets at time t (s, periodic) */
export function sweepHands(t: number): { left: HandRig; right: HandRig } {
  const u = ((t % SWEEP_PERIOD) + SWEEP_PERIOD) % SWEEP_PERIOD;
  const p = rightP(u);
  const d3 = norm(rightDir(u));
  const tw = turned(u);
  const right: HandRig = {
    grip: gripFrame(p, d3, [0, 0, 1]),
    hold: 'pinch',
    radius: 0.0032,
    roll: rightRoll(u),
    open: rightOpen(u),
    free: 1,
    prefer: [
      { hand: [0, 0, 1], world: THUMB_UP, weight: 0.25 * (1 - tw) },
      { hand: [0, 1, 0], world: PALM_FWD, weight: 0.25 * tw },
    ],
  };
  const left: HandRig = { grip: gripFrame(leftP(u), LEFT_ALONG, LEFT_TO_PALM), hold: 'coil', radius: 0.012, free: 0.6 };
  return { left, right };
}

/** Noor's whole rig on the sweep */
export function sweepRig(t: number): Rig {
  const h = sweepHands(t);
  return { ...stand(NOOR, [0, 0], 0, { width: 0.3 }), lean: 0.05, look: [0.05, 0.85, -0.35], hands: [h.left, h.right] };
}

/** the right hand's grip as asked (for drawing the target in the test scene) */
export function sweepTarget(t: number): Grip {
  const g = sweepHands(t).right.grip;
  return g ?? { p: [0, 0, 0], q: [0, 0, 0, 1] as Quat };
}
