// Stage 3, step 6 (the short ✗ comparison): what happens to the cable to the floor while the coil
// grows, wound the same way every time (✗) against over and under (✓). The 5 m XLR after two
// loops: ~3.4 m left, hanging from the coil at hip height down to the floor and lying on it, the
// plug at its far end.
//
// What is prescribed and what is simulated: every loop that lies flat in the hand puts one turn of
// twist into the cable beyond it (Călugăreanu: a flat loop pulled straight is one turn; the hand
// rolls it flat, the turn goes into the rest of the cable, KONZEPT stage 2/7). Wound the same way
// every loop puts the same turn in (+1, +1, +1, +1), over and under puts them in alternately
// (+1, −1, +1, −1). That input is prescribed: the cable's top is held where the coil is and turned
// by one turn per loop (pinch roll). How the hanging cable takes it (the stripe winding, whether
// it stays in the hanging part or runs out along the floor, a curl) is the simulation: the XLR
// preset, floor friction with rolling resistance, the plug's weight at the far end.
//
// The coiling hands are not part of this shot (the camera frames the cable below the coil); the
// stage 3 part shows the loops as a tally next to it. Mocap slot p3.wrong.same replaces it later
// with Noor's recorded same-way coiling.

import { TAU, V3, XLR, buildCable, frameTrack, gripFrame, normalize } from '../sim';
import type { Frame, Rod } from '../sim';
import type { ShotDef } from './types';

const RC = XLR.od / 2;

const minJerk = (u: number) => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * x * (10 - 15 * x + 6 * x * x);
};

/** the comparison's timing [s]: four loops, each turns the top of the cable in `turn` seconds, `period` apart */
export const TWIST = {
  /** the coil's underside, where the cable to the floor leaves it */
  top: [0, 0.9, 0] as V3,
  /** the cable on the floor runs this way from below the coil (to Noor's right front, away from the camera) */
  floorDir: normalize([0.55, 0, -0.84]),
  /** cable from the coil to the plug tip [m] (5 m less two loops and the plug strand) */
  length: 3.4,
  first: 1.0,
  period: 2.6,
  turn: 1.2,
  loops: 4,
  tail: 2.4,
} as const;

/** turns put into the cable by loop k (1-based): same way every time, or alternating */
export const loopSign = (alt: boolean, k: number) => (alt && k % 2 === 0 ? -1 : 1);

/** the turns put in by time t (prescribed): the sum of the loops so far, each eased over TWIST.turn */
export function turnsIn(alt: boolean, t: number): number {
  let s = 0;
  for (let k = 1; k <= TWIST.loops; k++) s += loopSign(alt, k) * minJerk((t - (TWIST.first + (k - 1) * TWIST.period)) / TWIST.turn);
  return s;
}

/** loop k (1-based) is laid from this time on (its turn has begun) */
export const loopStart = (k: number) => TWIST.first + (k - 1) * TWIST.period;

const duration = TWIST.first + TWIST.loops * TWIST.period + TWIST.tail;

/** the pads at the coil's underside, the cable running down from them */
const topFrame: Frame = gripFrame(TWIST.top, [0, -1, 0], [0, 0, 1]);

function twistShot(id: string, alt: boolean): ShotDef {
  return {
    id,
    duration,
    substeps: XLR.substeps,
    iterations: XLR.iterations,
    build() {
      // 4 cm of cable above the pads (inside the coil), straight down to a bend 7 cm above the
      // floor, then along the floor: a smooth start shape, settled before shot time 0
      const pts: V3[] = [];
      const top = TWIST.top, d = TWIST.floorDir, R = 0.08;
      const yBend = RC + R;
      const step = 0.004;
      for (let y = top[1] + 0.04; y > yBend; y -= step) pts.push([top[0], y, top[2]]);
      for (let i = 1; i <= 30; i++) {
        const a = (i / 30) * (Math.PI / 2);
        pts.push([top[0] + d[0] * R * (1 - Math.cos(a)), yBend - R * Math.sin(a), top[2] + d[2] * R * (1 - Math.cos(a))]);
      }
      const used = top[1] + 0.04 - yBend + (Math.PI / 2) * R;
      const last = pts[pts.length - 1];
      // the rest lies on the floor in a gentle bend to the side (as it came off the floor)
      const rest = TWIST.length + 0.04 - used;
      const side = normalize([-d[2], 0, d[0]]);
      for (let s = step; s <= rest; s += step) {
        const u = s / rest;
        const off = 0.25 * Math.sin(Math.PI * u) * u;
        pts.push([last[0] + d[0] * s + side[0] * off, RC, last[2] + d[2] * s + side[2] * off]);
      }
      const built = buildCable(XLR, pts, { plugs: 'end' });
      const rod = built.rod;
      rod.restFric?.fill(0);
      rod.setRestStraight();
      // settle (the pads hold from the start of the settling)
      const pre = 1.5;
      rod.time = -pre;
      const pin = rod.pinch({ frame: topFrame, hand: 1, mode: 'held', blend: 0.01, roll: (t) => TAU * turnsIn(alt, t) });
      for (let f = 0; f < Math.round(pre * 60); f++) rod.step(1 / 60, XLR.substeps);
      rod.time = 0;
      const sTop = pin.s;
      const seg = (r: Rod, s: number) => r.segmentAt(Math.max(0, Math.min(r.totalLength, s)));
      let printed = false;
      return {
        rod,
        vectors: { top: frameTrack(() => topFrame) },
        tracks: {
          cable0: () => built.cable[0],
          cable1: () => built.cable[1],
          /** turns put in so far (prescribed) */
          turnsIn: (_r, t) => turnsIn(alt, t),
          /** twist measured in the hanging part (the first 0.85 m below the coil) [turns] */
          twistHang: (r) => r.twistTurns(seg(r, sTop), seg(r, sTop + 0.85)),
          /** twist measured in the whole cable below the coil [turns] */
          twistAll: (r) => r.twistTurns(seg(r, sTop), r.ns - 1),
          /** twist in the cable on the floor beyond the first 0.4 m past the touchdown [turns] */
          twistFar: (r) => r.twistTurns(seg(r, sTop + 1.3), r.ns - 1),
          /** the material under the pads */
          sTop: () => sTop,
          loops: (_r, t) => {
            let n = 0;
            for (let k = 1; k <= TWIST.loops; k++) if (t >= loopStart(k)) n = k;
            return n;
          },
        },
        script: (r, t) => {
          if (!printed && t >= duration - 1.5 / 60) {
            printed = true;
            const hang = r.twistTurns(seg(r, sTop), seg(r, sTop + 0.85));
            const all = r.twistTurns(seg(r, sTop), r.ns - 1);
            console.log(`\n[${id}] in ${turnsIn(alt, t).toFixed(2)} turns; twist hanging ${hang.toFixed(2)}, whole ${all.toFixed(2)}; stats ${JSON.stringify(r.stats)}; warnings ${r.warnings.length}`);
          }
        },
      };
    },
  };
}

/** ✗ four loops the same way: +1 turn each */
export const twistSame = twistShot('p3-steps-same', false);
/** ✓ four loops over and under: +1, −1, +1, −1 */
export const twistAlt = twistShot('p3-steps-alt', true);

export const P3_SHOTS: ShotDef[] = [twistSame, twistAlt];
