// Over-under coiling as the user does it (scratchpad technique-ref): the geometry of Noor's coil,
// the pace of a loop and the beats of a coiling plan. Pure data and small helpers, shared by the
// controller that drives the simulation (coil-engine.ts), the shots (s1-coil.ts, later stage 3)
// and the scenes (labels, cameras, tally).
//
// The coil hangs like rings on a rod. The left hand holds the tops of the loops in the hook of its
// fingers, palm up and towards the midline, in front of the left hip; the strands run across the
// hand along the knuckles (from the little finger, low and medial, to the index finger, high and
// lateral), the thumb on top. The loops hang below the hand in planes facing forward and a little
// to the right; their axis N points away from the body, and every new loop is laid IN FRONT of the
// others (further along N, ~6.5 mm per loop: "von der Halterung Richtung Ende", never over
// everything). The cable comes out of the hand at its medial edge and runs to the right hand.
//
// A loop (the right hand never lets go of the cable, it only loosens the pinch):
//   1. slide: the pinch (thumb and index) loosens next to the left hand, the hand slides out along
//      the cable to the right hip until a loop length of cable has passed (then it holds); the left
//      hand moves out a little to the left
//   2. under only: at the hip the forearm turns over (supination ~140°), so the loop that forms falls
//      over the back of the hand and the wrist
//   3. return: the right hand comes back towards the left hand, rolling the cable a little between
//      thumb and index (over and under the other way round), first to a point ~18 cm medial of it
//      where the loop hangs open between the hands, then along the knuckle line to the left hand's
//      medial edge, laying the last ~9 cm of the loop across the open left hand (the loop's tangent
//      continues into the hand: the loop falls round); the left hand comes towards the midline to
//      meet it. Under: the hand turns back on the way, the wrist is still inside the new loop at the
//      hand-over and slips out on the next slide
//   4. give: the left hand closes over the new strand (the bundle takes it), the pinch stays on the
//      cable and loosens for the next loop

import type { V3 } from '../sim';

export type LoopKind = 'over' | 'under';

/** seconds of the phases of one loop */
export interface Pace {
  /** sliding out to the right hip (after the pinch loosened) */
  slide: number;
  /** holding at the hip */
  hold: number;
  /** under only: the forearm turns over at the hip */
  turn: number;
  /** back to the point where the loop hangs open between the hands */
  spread: number;
  /** from there along the knuckle line to the left hand's medial edge */
  approach: number;
  /** the left hand closes over the strand */
  give: number;
}

/** a slow loop for teaching: about 3.2 s (over) and 3.6 s (under) */
export const TEACH: Pace = { slide: 1.0, hold: 0.25, turn: 0.45, spread: 0.85, approach: 0.55, give: 0.45 };
/** the user's natural pace: about 2.1 s (over) and 2.4 s (under) */
export const NATURAL: Pace = { slide: 0.68, hold: 0.08, turn: 0.3, spread: 0.6, approach: 0.38, give: 0.28 };

/** time for the pinch to loosen before the hand moves */
export const LOOSEN = 0.1;

export interface CoilPlan {
  kinds: LoopKind[];
  /** one pace per loop */
  paces: Pace[];
  /** shot time when the first loop starts */
  start: number;
  /** cable per loop, from the left hand's medial edge to the next one [m] */
  loopLength: number;
}

/** the beats of one loop (absolute shot times) */
export interface LoopBeat {
  /** 1-based */
  k: number;
  kind: LoopKind;
  /** the pinch loosens */
  t0: number;
  /** the hand starts sliding out */
  tSlide: number;
  /** at the hip */
  tOut: number;
  /** held; under: the turn starts */
  tHeld: number;
  /** turned (= tHeld for over) */
  tTurned: number;
  /** the loop hangs open between the hands */
  tSpread: number;
  /** the strand lies across the left hand: the bundle takes it */
  tMeet: number;
  /** the left hand has closed: the next loop starts */
  t1: number;
}

export function beats(plan: CoilPlan): LoopBeat[] {
  const out: LoopBeat[] = [];
  let t = plan.start;
  plan.kinds.forEach((kind, i) => {
    const p = plan.paces[i];
    const t0 = t;
    const tSlide = t0 + LOOSEN;
    const tOut = tSlide + p.slide;
    const tHeld = tOut + p.hold;
    const tTurned = tHeld + (kind === 'under' ? p.turn : 0);
    const tSpread = tTurned + p.spread;
    const tMeet = tSpread + p.approach;
    const t1 = tMeet + p.give;
    out.push({ k: i + 1, kind, t0, tSlide, tOut, tHeld, tTurned, tSpread, tMeet, t1 });
    t = t1;
  });
  return out;
}

/** the loop (index into beats) going on at shot time t: the last one that started (-1 before the first) */
export function loopAt(bs: LoopBeat[], t: number): number {
  let k = -1;
  for (let i = 0; i < bs.length; i++) if (t >= bs[i].t0) k = i;
  return k;
}

const D = Math.PI / 180;
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** where the coil is (Noor stands at the origin facing -z, her right is +x) */
export const GEOM = (() => {
  /** the coil's axis: forward, turned 15° to her right (the loops face forward and a little right) */
  const N = norm([Math.sin(15 * D), 0, -Math.cos(15 * D)]);
  /** horizontal across the loops, pointing out (her left): up × N */
  const A = norm([N[2], 0, -N[0]]);
  /** the strands across the left hand: along the knuckles, the lateral (index) end 35° higher */
  const S = norm([A[0], Math.tan(35 * D), A[2]]);
  return {
    N,
    A,
    S,
    /** the left hand's grip point (the middle of the strands in the hand): resting in front of the left hip */
    leftRest: [-0.16, 0.94, -0.28] as V3,
    /** out to the left while the right hand slides out */
    leftOut: [-0.21, 0.925, -0.25] as V3,
    /** towards the midline to meet the right hand */
    leftMeet: [-0.1, 0.955, -0.315] as V3,
    /** the right hand at the hip, slid out */
    hip: [0.27, 0.86, -0.17] as V3,
    /** half the length of the strand in the left hand, along S [m] */
    half: 0.045,
    /** the stack: strand k (0 = the plug end, 1… the loops) lies this far along N from the hand's middle [m] */
    stack: (k: number) => -0.019 + 0.0065 * k,
    /** the bundle's radius for the hand shape [m] */
    bundle: 0.02,
    /** the right hand's pads this far beyond the left hand's medial edge at the hand-over [m] */
    gap: 0.025,
    /** how far the forearm turns over for "under" [rad] (the IK reaches ~136°: rig.ts turnWithForearm) */
    underTurn: 140 * D,
    /** the roll of the cable between thumb and index on the way back [rad]: over +, under − */
    roll: 0.6,
  };
})();
