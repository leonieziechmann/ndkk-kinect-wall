// Stage 7 (part p7-physics): Ilse's rough choreography at the experiment table, as rigs for
// people/rig.ts. Pure TypeScript (no three.js): the part builds RigTracks from it.
//
// Rough animation: her hands sit on the frames the simulation used (plugs, crank handle, sled
// handles, the clamp she puts on a tip, the clamp she opens); between them simple keyframes with
// smooth eases, a little breathing, the head looking at what matters. The recorded movements (mocap
// shots p7.*) replace all of it later.

import type { V3 } from '../sim';
import { ILSE } from '../people/cast';
import { Grip, HandRig, Rig, gripFrame, seated } from '../people/rig';
import { BAND, EDGE, KNOB, TABLE, knobTurns, ramp } from './p7-physics';

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const lerp = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const norm = (a: V3): V3 => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** facing +z (towards the table and the camera) */
const YAW = Math.PI;
const TOP = TABLE.height;

/** where she sits per beat (pelvis over the floor) */
export const SEATS = {
  centre: [0, -0.02] as [number, number],
  edge: [-0.3, -0.02] as [number, number],
  knob: [-0.28, -0.02] as [number, number],
  tension: [-1.38, -0.04] as [number, number],
};
export type Seat = keyof typeof SEATS;

/** breathing and small shifts (scene time s): never quite still */
function idle(s: number) {
  return {
    lean: 0.1 + 0.012 * Math.sin(1.2 * s) + 0.01 * Math.sin(0.33 * s + 1),
    bend: 0.012 * Math.sin(0.41 * s + 0.4),
    twist: 0.025 * Math.sin(0.27 * s + 2),
  };
}

/** a hand lying on the table (or on something on it) at p, fingers forward (+z), palm down */
export const restOn = (p: V3, side: -1 | 1, curl = 0.3): HandRig => ({ wrist: p, dir: norm([side * 0.25, -0.15, 1]), palm: [0, -1, 0], curl });
/** the hands' rest on the table edge in front of her (side +1 = her left, +x) */
export const restAt = (seat: Seat, side: -1 | 1): HandRig => {
  const s = SEATS[seat];
  return restOn([s[0] + side * 0.17, TOP + 0.035, TABLE.z - TABLE.depth / 2 + 0.07], side);
};

/** both hands in her lap (when the table is busy with an experiment she only watches) */
export const lapAt = (seat: Seat, side: -1 | 1): HandRig => {
  const s = SEATS[seat];
  return { wrist: [s[0] + side * 0.12, 0.64, s[1] + 0.2], dir: norm([-side * 0.45, -0.1, 1]), palm: [0, -1, 0.2], curl: 0.35 };
};

const base = (seat: Seat, s: number, look: V3, reach = 0.6): Rig => ({ ...seated(ILSE, SEATS[seat], YAW, 0.5), ...idle(s), look, reach, hands: [null, null] });

/** a fist round something along `along`, the palm towards `toPalm` */
const fist = (p: V3, along: V3, toPalm: V3, more: Partial<HandRig> = {}): HandRig => ({ grip: gripFrame(p, along, toPalm), hold: 'fist', radius: 0.009, free: 0.7, ...more });

// --------------------------------------------------------------------------------- intro / cards

export function introRig(s: number, seat: Seat = 'centre', look: V3 = [0, TOP + 0.05, 0.75]): Rig {
  return { ...base(seat, s, look), hands: [lapAt(seat, 1), lapAt(seat, -1)] };
}

// --------------------------------------------------------------------------------- 1 the edge

/**
 * For the edge the table and the three pieces are drawn EDGE_DX further to her left than the bake
 * has them (a different place at the same table, so that she reaches the tips): everything of the
 * edge beat is shifted by it (the bake's tips too: the part passes shifted tips).
 */
export const EDGE_DX = 0.25;
/** the book on the three pieces (her left hand rests on it) */
export const BOOK: V3 = [EDGE.edgeX + EDGE_DX + 0.12, TOP, 0.39];
/** where the clamps wait before she takes them (a little tray) */
export const TRAY: V3 = [EDGE.edgeX + EDGE_DX + 0.3, TOP, 0.3];

/** when her right hand sets off with clip k (the clip is in her hand from then on) */
export const edgeTake = (k: number) => {
  const at = [EDGE.clampAt.charging, EDGE.clampAt.xlr, EDGE.clampAt.power];
  return k === 0 ? 0.5 : at[k - 1] + 0.45;
};

/**
 * The edge: the left hand on the book, the right takes a clamp from the tray and puts it on each
 * tip in turn (EDGE.clampAt). tips(kind, t) = the tip node from the bake (the hand follows it down
 * while it lets go).
 */
export function edgeRig(t: number, s: number, tip: (k: number, t: number) => V3): Rig {
  const kinds = [0, 1, 2];
  const at = [EDGE.clampAt.charging, EDGE.clampAt.xlr, EDGE.clampAt.power];
  const left = restOn([BOOK[0] + 0.03, TOP + 0.06, BOOK[2] - 0.05], 1, 0.15);
  // the right hand: above the tray, down to it, to the tip, with the tip, back up
  const above = (p: V3, h = 0.06): V3 => add(p, [0, h, 0]);
  const pinch = (p: V3): HandRig => ({ grip: gripFrame(p, [0, 0, 1], [0, -1, 0]), hold: 'pinch', radius: 0.006, free: 0.7, open: 0 });
  let right: HandRig = pinch(above(TRAY, 0.05));
  let look: V3 = lerp(TRAY, [EDGE.edgeX + EDGE_DX - 0.08, TOP - 0.06, 0.39], 0.6);
  for (const k of kinds) {
    const a = at[k];
    // she takes the next clip and brings it over (the first from the tray, the others she already holds)
    const take0 = edgeTake(k), take1 = a - 0.35;
    if (t < take0) break;
    const tp = (tt: number) => add(tip(k, tt), [0, 0.022, 0]);
    if (t < take1) {
      const from = k === 0 ? above(TRAY, 0.05) : above(tp(at[k - 1] + 0.45), 0.03);
      const to = above(tp(a - 0.3), 0.05);
      const u = ramp(t, take0, take1);
      // a little arc up on the way
      right = { ...pinch(add(lerp(from, to, u), [0, 0.05 * Math.sin(Math.PI * u), 0])), open: 0 };
    } else if (t < a + 0.45) {
      // onto the tip, the clip closes, the hand lets go slowly (the clip's weight grows), opens, up
      const u = ramp(t, take1, a - 0.1);
      const p = t < a ? lerp(above(tp(a - 0.3), 0.05), tp(t), u) : add(tp(Math.min(t, a + 0.4)), [0, 0.03 * ramp(t, a + 0.3, a + 0.45), 0]);
      right = { ...pinch(p), open: ramp(t, a + 0.25, a + 0.4) };
    } else right = { ...pinch(above(tp(a + 0.45), 0.03 + 0.03 * ramp(t, a + 0.45, a + 0.9))), open: 1 };
    look = lerp(look, tip(k, Math.min(t, a + 0.5)), ramp(t, take0 - 0.3, take0 + 0.2));
  }
  // after the last clip: the hand goes to her lap (the pieces stay in view)
  const last = at[2] + 0.9, lap = lapAt('edge', -1);
  if (t > last) {
    const u = ramp(t, last, last + 1.0);
    const p0 = add(tip(2, last), [0, 0.07, 0]);
    right = u >= 1 ? lap : { ...pinch(lerp(p0, add(lap.wrist as V3, [0.02, 0.03, 0.05]), u)), open: 1 };
    look = lerp(look, [EDGE.edgeX + EDGE_DX - 0.06, TOP - 0.05, 0.39], u);
  }
  return { ...base('edge', s, look, 0.8), hands: [left, right] };
}

// --------------------------------------------------------------------------------- 1b the crank

/** the crank handle at shot time t: on the crank's disc, KNOB.arm off the axis */
export function crankHandle(t: number): V3 {
  const a = KNOB.crankOut;
  // two directions across the axis: one in the vertical plane, one along z
  const e1 = norm(cross(a, [0, 0, 1])), e2 = cross(a, e1);
  const ang = 2 * Math.PI * knobTurns(t) + 0.6;
  const hub = add(KNOB.crank, mul(a, 0.085));
  return add(add(hub, mul(e1, KNOB.arm * Math.cos(ang))), mul(e2, KNOB.arm * Math.sin(ang)));
}

export function knobRig(t: number, s: number, low: () => V3): Rig {
  const a = KNOB.crankOut;
  const h = add(crankHandle(t), mul(a, 0.03));
  // she brings her hand to the handle, turns, lets go when the loop is out
  const restR = restAt('knob', -1);
  const reach = ramp(t, 0.1, KNOB.t0 - 0.1);
  const done = ramp(t, KNOB.t0 + KNOB.turns / KNOB.rate + 0.5, KNOB.t0 + KNOB.turns / KNOB.rate + 1.4);
  const g = fist(h, a, norm(sub(add(KNOB.crank, mul(a, 0.1)), h)), { radius: 0.007, free: 1 });
  // (between the rest on the table and the handle the open hand glides, so the switch is small)
  const restP = add(restR.wrist as V3, [0, 0.03, 0.04]);
  const right: HandRig = reach < 1 ? (reach < 0.05 ? restR : { ...g, grip: gripFrame(lerp(restP, h, reach), a, [0, -1, 0]), open: 1 - reach }) : done > 0 ? (done < 1 ? { ...g, open: Math.min(1, 3 * done), grip: gripFrame(lerp(h, restP, done), a, [0, -1, 0]) } : restR) : g;
  // the left hand rests by the vise
  const left = restOn([KNOB.vise[0] + 0.05, TOP + 0.035, KNOB.z - 0.12], 1);
  const look = lerp(add(KNOB.crank, [0.05, -0.05, 0]), low(), ramp(t, KNOB.t0 + 1, KNOB.t0 + 3));
  return { ...base('knob', s, look, 0.7), hands: [left, right] };
}

// --------------------------------------------------------------------------------- 2 memory, 3 tension, 5 ring

/** a plug in a fist: p = plug centre, out = from the cable into the plug */
export const plugFist = (p: V3, out: V3, palm: V3, open = 0): HandRig => ({ grip: gripFrame(p, out, palm), hold: 'fist', radius: 0.009, free: 0.85, open, thumbAlong: 1 });

/** both hands on the plugs (frames from the bake), then open and away after `release` */
export function holdRig(seat: Seat, s: number, plugs: [{ p: V3; out: V3 }, { p: V3; out: V3 }], t: number, release: number | null, look: V3, away: [V3 | null, V3 | null] = [null, null], keepRight = false): Rig {
  const hands = ([0, 1] as const).map((i) => {
    const side = i === 0 ? 1 : -1;
    const pl = plugs[i];
    const palm: V3 = [0, -1, -0.2];
    if (release === null || t < release || (keepRight && i === 1)) return plugFist(pl.p, pl.out, palm);
    const u = ramp(t, release, release + 0.9);
    const to = away[i] ?? add(pl.p, [0, 0.06, -0.12]);
    if (u >= 1) return restAt(seat, side as -1 | 1);
    return plugFist(lerp(pl.p, to, u), pl.out, palm, Math.min(1, (t - release) / 0.15));
  }) as [HandRig, HandRig];
  return { ...base(seat, s, look, 0.7), hands };
}

// --------------------------------------------------------------------------------- 4 the bands

/** the sleds: two bars across the rails at ±half; their handles at the near rail */
export const SLED = { nearZ: 0.36, farZ: 1.24, handleY: TOP + 0.1 };
export const sledHandle = (half: number, side: -1 | 1): V3 => [side * half, SLED.handleY, SLED.nearZ - 0.03];

/**
 * Both hands on the sled handles (half = the clamps' half distance from the bake); at `release`
 * her left hand (+x) goes to the über band's clamp and opens it.
 */
export function bandRig(t: number, s: number, half: number, look: V3, release: number | null, hands = true): Rig {
  const handle = (side: -1 | 1): HandRig => fist(sledHandle(half, side), [0, 1, 0], [0, 0, 1], { radius: 0.011, free: 1 });
  let left = hands ? handle(1) : restAt('centre', 1);
  const right = hands ? handle(-1) : restAt('centre', -1);
  if (release !== null && hands) {
    const clamp: V3 = [half + 0.02, TOP + BAND.lift + 0.04, BAND.rows.over];
    const u = ramp(t, release - 1.0, release - 0.2);
    const lever = add(clamp, [0, 0.02, -0.02]);
    if (t > release - 1.0) {
      const p = t < release ? lerp(sledHandle(half, 1), lever, u) : lerp(lever, add(lever, [0.0, 0.05, -0.08]), ramp(t, release + 0.2, release + 0.9));
      left = { grip: gripFrame(p, [0, 0, 1], [0, -1, 0]), hold: 'pinch', radius: 0.005, free: 0.8, open: t < release - 0.1 ? 0.6 : Math.min(1, 0.2 + (t - release) / 0.3) };
    }
  }
  return { ...base('centre', s, look, 0.8), hands: [left, right] };
}
