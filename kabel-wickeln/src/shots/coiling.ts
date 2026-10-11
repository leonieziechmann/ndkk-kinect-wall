// Over-under coiling as the user does it (scratchpad technique-ref): the geometry of Noor's coil,
// the pace of a loop and the beats of a coiling plan. Pure data and small helpers, shared by the
// controller that drives the simulation (coil-engine.ts), the shots (s1-coil.ts, later stage 3)
// and the scenes (labels, cameras, tally).
//
// The coil hangs like rings on a rod ("von der Halterung Richtung Ende"). The left fist holds the
// tops of the loops in front of the left hip: the strands run through the fist along S (out to her
// left and forward), the palm behind and a little below them, the thumb on top along them pointing
// to the plug, which sticks out of the fist at the lateral end. The loops hang below the fist in
// planes that face forward and to her right (their axis N, 55° right of straight ahead); every new
// loop is laid IN FRONT of the others, further along N (7 mm per loop), never over everything.
// The cable comes out of the fist at its medial end and runs to the right hand.
//
// A loop (the right hand never lets go of the cable, it only loosens the pinch):
//   1. slide: the pinch (thumb and index) loosens next to the fist's medial end, the hand slides
//      out along the cable to the right hip until a loop length of cable has passed (then it
//      holds); the left hand moves out a little to the left
//   2. under only: at the hip the forearm turns over (supination ~135°): the cable towards the coil
//      now runs over the back of the hand and the wrist
//   3. back: the right hand comes back towards the left hand, rolling the cable a little between
//      thumb and index (over and under the other way round); the loop hangs open between the hands
//      (under: over the wrist), the left hand comes towards the midline to meet it
//   4. lay: the pads come down next to the fist's medial end, the thumb tip pointing along the
//      fist: the cable past it lies in the open fist, and the loop hangs round below it, coming up
//      at the fist's lateral end. Under: the hand turns back on the way, the wrist still in the loop
//   5. give: the fist closes over the new strand (the bundle takes it); the pinch stays on the
//      cable (under: the hand slips out of the loop) and loosens for the next loop
//
// Over and under differ only in where the cable to the floor crosses the new loop (KONZEPT): over,
// on Noor's side of it; under, behind it (the loop covers it).

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
  /** back to above the fist's medial end, the loop hanging open between the hands */
  back: number;
  /** down into the fist: the strand lies in it */
  lay: number;
  /** the fist closes over the strand */
  give: number;
}

/** a slow loop for teaching: about 3.4 s (over) and 3.9 s (under) */
export const TEACH: Pace = { slide: 1.0, hold: 0.2, turn: 0.5, back: 1.0, lay: 0.7, give: 0.4 };
/** the user's natural pace: about 2.4 s (over) and 2.7 s (under) */
export const NATURAL: Pace = { slide: 0.9, hold: 0.05, turn: 0.3, back: 0.62, lay: 0.48, give: 0.27 };

/** time for the pinch to loosen before the hand moves */
export const LOOSEN = 0.15;

export interface CoilPlan {
  kinds: LoopKind[];
  /** one pace per loop */
  paces: Pace[];
  /** shot time when the first loop starts */
  start: number;
  /** cable per loop, from the fist's medial end round to the next strand's medial end [m] */
  loopLength: number;
}

/** the beats of one loop (absolute shot times) */
export interface LoopBeat {
  /** 1-based */
  k: number;
  kind: LoopKind;
  /** the previous hand-over ends: the pinch loosens */
  t0: number;
  /** the hand starts sliding out */
  tSlide: number;
  /** at the hip */
  tOut: number;
  /** held; under: the turn starts */
  tHeld: number;
  /** turned (= tHeld for over) */
  tTurned: number;
  /** above the fist's medial end, the loop hanging open */
  tAbove: number;
  /** the strand lies in the fist: the bundle takes it */
  tMeet: number;
  /** the fist has closed: the next loop starts */
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
    const tAbove = tTurned + p.back;
    const tMeet = tAbove + p.lay;
    const t1 = tMeet + p.give;
    out.push({ k: i + 1, kind, t0, tSlide, tOut, tHeld, tTurned, tAbove, tMeet, t1 });
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
  /** the coil's axis: forward, turned 55° to her right (the loops face forward and to her right) */
  const N = norm([Math.sin(55 * D), 0, -Math.cos(55 * D)]);
  /** horizontal across the loops, pointing out (her left and forward): up × N */
  const A = norm([N[2], 0, -N[0]]);
  /** the strands in the fist: along A (out to her left and forward), level */
  const S = A;
  return {
    N,
    A,
    S,
    /** the left palm (where the strands rest against it): resting in front of the left hip */
    leftRest: [-0.15, 0.9, -0.27] as V3,
    /** out to the left a little while the right hand slides out */
    leftOut: [-0.27, 0.89, -0.3] as V3,
    /** towards the midline to meet the right hand */
    leftMeet: [-0.08, 0.91, -0.3] as V3,
    /** the right hand at the hip, slid out */
    hip: [0.45, 0.8, -0.05] as V3,
    /** half the length of a strand in the fist, along S [m] */
    half: 0.05,
    /** the stack: strand k (0 = the plug strand) lies this far from the palm, every new one further out (along N, in front) [m] */
    stack: (k: number) => 0.0038 + 0.006 * k,
    /** the fist's radius round strands 0 … k: from the palm to the outer side of strand k, halved [m] */
    fist: (k: number) => (0.0038 + 0.006 * k + 0.0032) / 2 + 0.0004,
    /**
     * the right hand lays the cable into the fist from her right: the cable past the pads runs this much
     * more to her left than the strands (a bend at the fist's medial end) and slopes down a little
     * into the fist (the arm's most comfortable way: no joint near a limit) [rad]
     */
    layYaw: 35 * D,
    laySlope: 6 * D,
    /** the right hand's pads this far beyond the fist's medial end at the hand-over [m] (a finger's width and room) */
    gap: 0.036,
    /**
     * where the pads are at the hand-over across the stack, relative to the new strand [m]: over, on
     * Noor's side of the new loop (the cable to the floor hangs between her and the loop); under, in
     * front of it (the wrist came through the loop: the cable to the floor hangs outside it)
     */
    padsDepth: { over: -0.035, under: 0.02 },
    /** how far the hand turns over for "under" [rad] (the arm hangs nearly straight at the hip: forearm and upper arm turn together; the video shows 150–180°) */
    underTurn: 150 * D,
    /** the roll of the cable between thumb and index on the way back [rad]: over +, under − */
    roll: 0.5,
  };
})();
