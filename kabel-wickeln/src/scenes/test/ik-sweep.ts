// The IK test choreography (pure TS, also loaded by tools/simtest/ik-continuity.mjs and
// ik-sweep-check.mjs): Noor's hands on the over-under path of the reference videos, as targets only
// (no cable). The left hand holds a coil in front of the left hip (palm towards the midline, the
// bundle pointing forward like a rod the loops hang on) and moves between the hip and the midline.
// The right hand pinches the cable next to it, the thumb tip towards the coil, slides out to the
// right hip (the pinch loosened), and comes back rolling the cable (over loop). For the under loop
// it turns over at the right hip by about 180° (palm up and forward, the thumb tip away from the
// coil: mostly forearm supination) and turns back on the way in.
//
// The cable direction d3 at the pinch is where the cable leaves past the thumb tip (body/hand.ts
// pinchAround): towards the coil while the thumb points there; turned over, the cable leaves the
// pinch away from the coil and comes back to it over the back of the hand (the wrist in the loop).

import { V3, Quat, norm } from '../../people/math';
import { NOOR } from '../../people/cast';
import { Grip, HandRig, Key, Rig, gripFrame, keys, stand } from '../../people/rig';

/** one over loop and one under loop, s */
export const SWEEP_PERIOD = 6.6;

/** the beats of a period (s): used by the checks and the test scene's captions */
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
  [5.1, [0.31, 0.88, -0.26]],
  [5.5, [0.2, 0.9, -0.32]],
  [6.2, [-0.01, 0.89, -0.32]],
  [6.6, [-0.02, 0.88, -0.31]],
]));

/** towards the coil from next to it: along the thumb, a little down into the loop between the hands */
const towards: V3 = norm([-1, -0.3, -0.35]);
/** from the right hip towards the coil: the cable spans the hands, sagging */
const sagging: V3 = norm([-1, -0.3, -0.3]);
/** turned over: the cable leaves the pads away from the coil and comes back over the back of the hand */
const away: V3 = norm([0.87, 0.5, 0]);
const rightDir = keys(k<V3>([
  [0, towards],
  [0.35, towards],
  [1.35, sagging],
  [1.6, sagging],
  [2.7, towards],
  [3.65, towards],
  [4.55, sagging],
  [5.1, away],
  [5.5, away],
  [6.2, towards],
]));
/**
 * The angle between thumb and cable (HandRig.cross): next to the coil the cable runs along the thumb
 * towards it (A 3.0/4.0); while the hand slides out it turns across the thumb pad, and at the hip it
 * crosses the pad nearly at right angles while the fingers hang and the thumb points down (B 2.3)
 */
const rightCross = keys(k<number>([[0, 0.3], [0.35, 0.3], [1.35, 1.5], [1.6, 1.5], [2.7, 0.3], [3.65, 0.3], [4.55, 1.5], [5.1, 0.9], [5.5, 0.9], [6.2, 0.3]]));

/** 0 = not turned, 1 = turned over (palm up and forward, thumb away) */
const turned = keys(k<number>([[0, 0], [4.55, 0], [5.1, 1], [5.5, 1], [6.2, 0]]));
/** 0 next to the coil … 1 out at the hip */
const outside = keys(k<number>([[0, 0], [0.35, 0], [1.35, 1], [1.6, 1], [2.7, 0], [3.65, 0], [4.55, 1], [5.5, 1], [6.2, 0]]));
/** the palm's wishes: towards the body at the hip (the back of the hand forward and out, B 2.3), up and forward turned over */
const PALM_IN: V3 = norm([-0.8, 0, 0.6]);
const PALM_UP: V3 = norm([0.6, 0.8, -0.1]);
const AWAY: V3 = norm([1, 0.2, -0.3]);

/** the roll of the cable between thumb and index finger on the way back (rad) */
const rightRoll = keys(k<number>([
  [0, 0], [1.6, 0], [2.7, 0.7], [3.3, 0], [5.2, 0], [6.2, -0.7], [6.6, 0],
]));
/** the pinch loosens while the hand slides out */
const rightOpen = keys(k<number>([
  [0, 0], [0.35, 0], [0.5, 0.6], [1.3, 0.6], [1.5, 0], [3.3, 0], [3.65, 0], [3.8, 0.6], [4.5, 0.6], [4.65, 0], [6.6, 0],
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

/** a blend of two directions, normalised */
const mix = (a: V3, b: V3, w: number): V3 => norm([a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w]);

/** the hand targets at time t (s, periodic) */
export function sweepHands(t: number): { left: HandRig; right: HandRig } {
  const u = ((t % SWEEP_PERIOD) + SWEEP_PERIOD) % SWEEP_PERIOD;
  const p = rightP(u);
  const tw = turned(u);
  const lp = leftP(u);
  // the thumb tip's wish: towards the coil (the left hand), turned over away from it
  const toCoil = norm([lp[0] - p[0], 0.4 * (lp[1] - p[1]), lp[2] - p[2]]);
  const out = outside(u);
  const right: HandRig = {
    grip: gripFrame(p, norm(rightDir(u)), [0, 0, 1]),
    hold: 'pinch',
    radius: 0.0032,
    roll: rightRoll(u),
    open: rightOpen(u),
    cross: rightCross(u),
    free: 1,
    // next to the coil the thumb tip points to it; turned over, away from it
    thumbTo: tw > 0 ? AWAY : toCoil,
    thumbWeight: 0.3 * Math.max(1 - out, tw),
    prefer: [{ hand: [0, 1, 0], world: tw > 0 ? PALM_UP : PALM_IN, weight: 0.3 * Math.max(out * (1 - tw), tw) }],
  };
  const left: HandRig = { grip: gripFrame(lp, LEFT_ALONG, LEFT_TO_PALM), hold: 'coil', radius: 0.012, free: 0.6 };
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
