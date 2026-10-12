// Stage 5.2 (part p5-eight): Noor's rough choreography for the eight shots (shots/eight.ts), as
// rigs for people/rig.ts. Pure TypeScript (no three.js): the part builds RigTracks from it.
//
// Rough animation: her hands sit on exactly the frames the simulation used (the left fist's frame,
// the right hand's pads), everything between is simple keyframes with smooth eases, a little
// breathing and weight shift, the head looking at what matters. The recorded movements (mocap
// shots p5.eight.*) replace all of it later.

import type { Frame, Quat, V3 } from '../sim';
import { NOOR } from '../people/cast';
import { Grip, HandRig, Rig, gripFrame, stand } from '../people/rig';
import { EIGHT_GEOM, HANG_T, ROLL_T, SNAP_T, ease, fistFrame, hangFist, layPads, rollAt, thumbOpenAt, thumbRollAt } from './eight';

export type EightShot = 'snap' | 'ok' | 'rev' | 'roll' | 'hang';

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const lerp = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const norm = (a: V3): V3 => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const ramp = (t: number, a: number, b: number) => ease((t - a) / (b - a));

function slerp(a: Quat, b: Quat, u: number): Quat {
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
const mixGrip = (a: Grip, b: Grip, u: number): Grip => ({ p: lerp(a.p, b.p, u), q: slerp(a.q, b.q, u) });

const G = EIGHT_GEOM;
const N = G.N, UP: V3 = [0, 1, 0];
/** across the strands, out to her left (lateral) */
const A: V3 = mul(G.E1, -1);
/** from the strands to the palm of the left fist: behind them (her side) and a little below */
const TO_PALM: V3 = (() => {
  const v = norm(add(mul(N, -0.9), mul(UP, -0.4)));
  return norm(sub(v, mul(A, dot(v, A))));
})();
/** the coil in the left fist: three strands (two earlier loops and the new one) */
export const COIL_R = 0.012;

/** the left hand's grip on the coil, for a fist frame of the simulation (its p: the new loop's strand) */
export function leftGrip(f: Frame): Grip {
  // the bundle's axis: behind the new strand (the earlier loops lie on her side of it)
  const p = add(f.p, add(mul(N, -0.011), mul(UP, -0.002)));
  return gripFrame(p, A, TO_PALM);
}

const RC = 0.0032;
const PINCH = { hold: 'pinch' as const, radius: RC, free: 1 };
/** her right hand resting beside her hip (an open hand, as if it held a hanging cable) */
export const REST_R: Grip = gripFrame([0.25, 0.8, -0.1], norm([0.1, -1, -0.2]), [-0.3, 0, -1]);
/** the right hand at the fist, open, after the hand-over (before it goes back to rest) */
const handOver = (kind: 'over' | 'under'): Grip => layPads(kind)(SNAP_T.back1);

/** the left hand's coil grip, open/closed etc. */
const leftRig = (f: Frame): HandRig => ({ grip: leftGrip(f), hold: 'coil', radius: COIL_R, thumbAlong: 1, free: 0.3 });

/** a little breathing and weight shift (scene time s): never quite still */
function idle(s: number) {
  return {
    lean: 0.05 + 0.012 * Math.sin(1.3 * s) + 0.008 * Math.sin(0.37 * s + 1),
    bend: 0.012 * Math.sin(0.41 * s + 0.4),
    twist: 0.02 * Math.sin(0.29 * s + 2),
    drop: 0.01 + 0.006 * Math.sin(1.3 * s + 0.6),
  };
}

const LOOK_LOOP: V3 = add(G.F, [0.03, -0.16, 0]);

/**
 * Extra data a rig needs from the bake: where the press touches the eight (the loop's most
 * standing-out point, followed while it is pressed in), and the plug (fix 3: she watches it).
 */
export interface RigInputs {
  /** the press's contact point at shot time t (snap only) */
  lobe?: (t: number) => V3;
  /** the plug at shot time t */
  plug?: (t: number) => V3;
}

/**
 * Noor's rig for an eight shot at shot time t (the cable's time) and scene time s (her idle motion,
 * which goes on while time stands still for the cable).
 */
export function eightRig(shot: EightShot, t: number, s: number, inp: RigInputs = {}): Rig {
  const base = { ...stand(NOOR, [0, 0], 0, { width: 0.26, stagger: 0.06 }), ...idle(s), reach: 0.6 };
  const fist = shot === 'hang' ? hangFist()(t) : fistFrame(G.F);
  const left = leftRig(fist);
  let right: HandRig | null = null;
  let look: V3 = LOOK_LOOP;
  const kind = shot === 'rev' ? 'under' : 'over';
  const T = SNAP_T;
  if (shot === 'hang') {
    // the right hand rests; she lifts the ring and watches the plug
    right = { grip: REST_R, ...PINCH, open: 1 };
    const pl = inp.plug ? inp.plug(t) : [0.1, 0.1, -0.3];
    look = lerp(LOOK_LOOP, lerp(fist.p, pl as V3, 0.7), ramp(t, HANG_T.lift0, HANG_T.lift1));
    return { ...base, look, hands: [left, right] };
  }
  const pads = layPads(kind);
  const open = shot === 'roll' ? ROLL_T.open : T.open;
  // under: the hand turned over, the palm up (it lays the loop over the back of the hand)
  const turned = shot === 'rev' ? { prefer: [{ hand: [0, 1, 0] as V3, world: [0, 1, 0] as V3, weight: 0.8 }] } : {};
  if (t < open) {
    const g = pads(t) as Grip;
    if (shot === 'roll') right = { grip: g, ...PINCH, roll: thumbRollAt(t), open: 0.6 * thumbOpenAt(t), free: 0.8 };
    else right = { grip: g, ...PINCH, open: 0, ...turned };
    // she watches the hand coming back, then the loop
    look = lerp(add(G.hip, [-0.1, 0.0, -0.1]), LOOK_LOOP, ramp(t, T.back0, T.back1));
  } else {
    // the pads open, the hand goes back to rest
    const away0 = open + 0.15, away1 = away0 + 0.85;
    const u = ramp(t, away0, away1);
    right = { grip: mixGrip(handOver(kind), REST_R, u), ...PINCH, open: Math.min(1, (t - open) / 0.15), ...(u < 0.5 ? turned : {}) };
    if (shot === 'snap' && inp.lobe && t > T.press0 - 0.9) {
      // the press: to the eight's front, fingers on it, pressing it back into the ring; then away
      const touch = inp.lobe(T.press0);
      const hover = add(touch, add(mul(N, 0.06), [0, 0.04, 0]));
      const pressG = (p: V3): Grip => gripFrame(p, [0, -1, 0], mul(N, -1));
      if (t < T.press0) right = { grip: mixGrip(REST_R, pressG(hover), ramp(t, T.press0 - 0.9, T.press0 - 0.15)), ...PINCH, open: 1 };
      else if (t < T.letGo) right = { grip: mixGrip(pressG(hover), pressG(inp.lobe(t)), ramp(t, T.press0, T.press0 + 0.25)), ...PINCH, open: 1 };
      else right = { grip: mixGrip(pressG(add(inp.lobe(T.letGo), mul(N, 0.03))), REST_R, ramp(t, T.letGo, T.letGo + 0.8)), ...PINCH, open: 1 };
    }
  }
  return { ...base, look, hands: [left, right] };
}

/** the cable's roll in the pads during eight-roll (turns), for the arrow */
export const rollTurns = (t: number) => rollAt(t) / (2 * Math.PI);
