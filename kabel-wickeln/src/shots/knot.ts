// Stage 5.1 "Das Ende durch den Ring": an over-under coil (über, unter, über, unter) lies on a
// table, its outer end has fallen through the eye and comes out from under the coil. The left
// palm holds the coil down, the right hand pulls the end away slowly: the cable runs out through
// the eye, and in every second loop (the unter loops) an overhand knot tightens. Fully simulated:
// the coil is wound by the coil factory (wind.ts), so its crossings are real, and the knots come
// from the topology alone. tools/simtest/derisk-knot.mjs checks every frame: knot determinant
// (topology.ts) and how close strands come (pass-through detection).
//
// Four loops rather than three: threaded this way every unter loop knots (checked with the knot
// determinant: über-unter-über gives one knot, über-unter-über-unter two), and two knots show
// "every second loop" better than one.
//
// Coordinates: the table top is y = TABLE_Y, the coil lies centred on (0, TABLE_Y, 0); the start
// tail leaves the near rim (z < 0) along +x, the end is pulled toward +z.

import { Quat, Rod, RodState, V3, length, normalize, scale, smooth, sub } from '../sim';
import type { ShotDef } from './types';
import { tightKnots } from './topology';
import { placeState, windCoil } from './wind';

export const TABLE_Y = 0.75;
/** XLR in a close-up: 7 mm, contact radius 1.2 × r (tight knots without pass-throughs) */
export const KNOT_CABLE = { radius: 0.0035, collisionRadius: 0.0042, linearDensity: 0.05, EI: 2e-3, GJ: 1.5e-3, friction: 0.5, selfFriction: 0.3, damping: 1, angularDamping: 2 };
export const KNOT_PATTERN = 'ouou';
const SEG = 0.01, LOOP = 0.78;
/** node held by the left fingers: where the start tail (0.3 m) enters the coil */
const ANCHOR = 30;

/** shot times: the right hand reaches for the end at `take`; the bake ends at `end` */
export const KNOT_TIMES = { take: 0.4, end: 15 };
/**
 * The right hand pulls hand over hand: it grabs the cable near the coil, pulls it STROKE metres
 * away (and a little up) at up to SPEED, lets go and reaches back. It pulls like a soft spring
 * (COMPLIANCE [m/N], force = lag / COMPLIANCE) and slows down as the force nears FMAX [N]; when
 * it no longer gets anywhere (the knots are tight) it holds.
 */
const SPEED = 0.45, REACH = 0.9, STROKE = 0.5, FMAX = 6, COMPLIANCE = 0.004;
const PULL_DIR: V3 = normalize([0, 0.3, 1]);

let coil: { state: RodState; loops: [number, number][] } | null = null;

/** The threaded coil on the table (wound once per process). */
export function knotCoil() {
  if (!coil) {
    const c = windCoil({ cable: KNOT_CABLE, seg: SEG, loop: LOOP, pattern: KNOT_PATTERN, lead: 0.3, tail: 0.6, thread: true });
    coil = { state: placeState(c.state, [0, TABLE_Y, 0]), loops: c.loops };
  }
  return coil;
}

/**
 * Palm of the left hand pressing the coil onto the table where the loops pass at the near rim
 * (z = rimZ): a capsule across the loops, lowered in 0.5 s onto the second layer.
 */
export function knotPalm(rimZ: number) {
  return (t: number) => {
    const y = TABLE_Y + 0.028 + 0.03 * (1 - smooth(t / 0.5));
    return [{ a: [-0.05, y, rimZ] as V3, b: [0.05, y, rimZ] as V3, r: 0.02, mu: 0.5 }];
  };
}

/** Tracks knotKX, knotKY, knotKZ: the centre of the k-th tight knot (k from 1), NaN while there is none. */
function knotTrack(k: number): Record<string, (r: Rod) => number> {
  const at = (r: Rod, c: number) => tightKnots(r.x, r.n, SEG)[k]?.[c] ?? NaN;
  return { [`knot${k + 1}X`]: (r) => at(r, 0), [`knot${k + 1}Y`]: (r) => at(r, 1), [`knot${k + 1}Z`]: (r) => at(r, 2) };
}

/**
 * The shot: the palm holds the coil, the right hand pulls hand over hand until the knots are
 * tight and then holds. Tracks: handX/Y/Z (the right fist), grip (1 while it is closed on the
 * cable), force [N], knots (how many are pulled tight) and knot1X/Y/Z, knot2X/Y/Z (where), twist,
 * writhe.
 */
export const knotPull: ShotDef = {
  id: 'knot-pull',
  duration: KNOT_TIMES.end,
  substeps: 60,
  iterations: 3,
  build() {
    const { state, loops } = knotCoil();
    const rod = Rod.fromState(state);
    const n = rod.n, x = rod.x, e = n - 1;
    const node = (i: number): V3 => [x[3 * i], x[3 * i + 1], x[3 * i + 2]];
    // the left palm presses the coil onto the table at the near rim (where the loops cross x = 0)
    let rimZ = 0, farZ = 0;
    for (const [a, b] of loops) for (let i = a; i <= b; i++) {
      if (Math.abs(x[3 * i]) < 0.03) rimZ = Math.min(rimZ, x[3 * i + 2]);
      farZ = Math.max(farZ, x[3 * i + 2]);
    }
    rod.setCapsules(knotPalm(rimZ + 0.004));
    // under the palm the fingers also hold the start of the cable where it enters the coil
    const still = { p: [0, 0, 0] as V3, q: [0, 0, 0, 1] as Quat };
    rod.addGrip({ nodes: [ANCHOR - 2, ANCHOR + 2], keepShape: true, frame: () => still });

    // the right hand: position p at the last frame (time tp), velocity until the next frame
    const hand = { phase: 'wait' as 'wait' | 'reach' | 'pull' | 'hold', p: node(e), v: [0, 0, 0] as V3, tp: 0, grab: e, guide: 0, s: 0, speed: 0, stall: 0 };
    const regrab: V3 = [node(e)[0], TABLE_Y + 0.05, farZ + 0.12];
    const handAt = (t: number): V3 => {
      const dt = t - hand.tp;
      return [hand.p[0] + hand.v[0] * dt, hand.p[1] + hand.v[1] * dt, hand.p[2] + hand.v[2] * dt];
    };
    const force = (r: Rod, t: number) => {
      if (!hand.guide) return 0;
      const h = handAt(t), g = hand.grab;
      return Math.hypot(r.x[3 * g] - h[0], r.x[3 * g + 1] - h[1], r.x[3 * g + 2] - h[2]) / COMPLIANCE;
    };
    const step = 1 / 60;
    return {
      rod,
      script: (r, t) => {
        hand.p = handAt(t);
        hand.tp = t;
        hand.v = [0, 0, 0];
        if (hand.phase === 'wait' && t >= KNOT_TIMES.take) hand.phase = 'reach';
        if (hand.phase === 'reach') {
          // reach for the grab node where it is now (it may move while the hand comes)
          const target = node(hand.grab);
          const d = sub(target, hand.p), l = length(d);
          if (l < 0.003) {
            hand.guide = r.addGuide({ nodes: [hand.grab, hand.grab], compliance: COMPLIANCE, target: (_, tt) => handAt(tt) });
            hand.phase = 'pull';
            hand.s = 0;
            hand.speed = 0;
          } else hand.v = scale(d, Math.min(REACH, l / step) / l);
        }
        if (hand.phase === 'pull') {
          // speed up gently, slow down as the force nears FMAX
          const want = SPEED * Math.min(1, Math.max(0, (FMAX - force(r, t)) / (0.5 * FMAX)));
          hand.speed = Math.min(want, hand.speed + 0.03);
          hand.stall = hand.speed < 0.03 ? hand.stall + step : 0;
          if (hand.stall > 1) hand.phase = 'hold';
          else if (hand.s >= STROKE) {
            r.removeGuide(hand.guide);
            hand.guide = 0;
            hand.phase = 'reach';
            // the next grab: the cable nearest to where the hand takes it again, near the coil
            let best = Infinity;
            for (let i = ANCHOR + 10; i < n; i++) {
              const q = Math.hypot(r.x[3 * i] - regrab[0], r.x[3 * i + 1] - regrab[1], r.x[3 * i + 2] - regrab[2]);
              if (q < best) { best = q; hand.grab = i; }
            }
          } else {
            hand.v = scale(PULL_DIR, hand.speed);
            hand.s += hand.speed * step;
          }
        }
      },
      tracks: {
        handX: (_, t) => handAt(t)[0],
        handY: (_, t) => handAt(t)[1],
        handZ: (_, t) => handAt(t)[2],
        /** 1 while the right fist is closed on the cable */
        grip: () => (hand.phase === 'pull' || hand.phase === 'hold' ? 1 : 0),
        force,
        /** number of knots pulled tight, and where the first two are (NaN while there is none) */
        knots: (r) => tightKnots(r.x, r.n, SEG).length,
        ...knotTrack(0),
        ...knotTrack(1),
        twist: (r) => r.twistTurns(),
        writhe: (r) => r.writhe(),
      },
    };
  },
};
