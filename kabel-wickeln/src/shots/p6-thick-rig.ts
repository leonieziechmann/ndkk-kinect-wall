// Stage 6 (part p6-thick): Mai's and Ada's rough choreography as rigs for people/rig.ts. Pure
// TypeScript (no three.js): the part builds RigTracks from it.
//
// Rough animation: the hands sit on exactly the frames the simulation used (shots/p6-thick.ts: the
// fists' frames are functions of shot time there, or recorded vectors), everything else is simple
// keyframes with smooth eases, a little breathing and weight shift, the head looking at what
// matters. The recorded movements (mocap shots p6.*) replace all of it later.

import type { Frame, V3 } from '../sim';
import { ADA, MAI } from '../people/cast';
import { Grip, HandRig, LegRig, Rig, gripFrame, kneel, squat, stand, walk } from '../people/rig';
import { COIL, FAIL_T, RING_T, STACK, UNROLL_T, coilBeat, coilFist, ease, eightsFist, stackPlane, stackWorld } from './p6-thick';

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const mix = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const norm = (a: V3): V3 => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const ramp = (t: number, a: number, b: number) => ease((t - a) / Math.max(1e-6, b - a));
const UP: V3 = [0, 1, 0];

/** a little breathing and weight shift (scene time s): never quite still */
function idle(s: number, seed = 0) {
  return {
    lean: 0.012 * Math.sin(1.3 * s + seed) + 0.008 * Math.sin(0.37 * s + 1 + seed),
    bend: 0.012 * Math.sin(0.41 * s + 0.4 + seed),
    twist: 0.02 * Math.sin(0.29 * s + 2 + seed),
    drop: 0.006 * Math.sin(1.3 * s + 0.6 + seed),
  };
}
const withIdle = (r: Rig, s: number, seed = 0): Rig => {
  const i = idle(s, seed);
  return { ...r, lean: (r.lean ?? 0) + i.lean, bend: (r.bend ?? 0) + i.bend, twist: (r.twist ?? 0) + i.twist, drop: (r.drop ?? 0) + i.drop };
};

/** a hand hanging relaxed at the side (free hand), relative to a body at pos facing yaw */
function hangingHand(pos: [number, number], yaw: number, side: -1 | 1, y = 0.82): HandRig {
  const f: V3 = [Math.sin(yaw), 0, -Math.cos(yaw)], r: V3 = [Math.cos(yaw), 0, Math.sin(yaw)];
  const w: V3 = add([pos[0], y, pos[1]], add(mul(r, side * 0.24), mul(f, 0.04)));
  return { wrist: w, dir: norm(add([0, -1, 0], mul(f, 0.15))), palm: mul(r, -side), curl: 0.3 };
}

// ======================================================================================= coil

/** the bundle in her left fist: the loops' top strands run through it along E1, stacked along N */
function coilLeft(t: number): HandRig {
  const f = coilFist(t);
  let n = 0;
  for (let k = 0; k < COIL.kinds.length; k++) if (t >= coilBeat(k).give) n = k + 1;
  const p = add(add(f.p, mul(COIL.N, COIL.pitch * (n / 2 + 0.3))), [0, -0.004, 0]);
  const toPalm = norm(add(mul(COIL.N, -0.85), [0, -0.45, 0]));
  return { grip: gripFrame(p, mul(COIL.E1, -1), toPalm), hold: 'coil', radius: 0.012 + 0.006 * n, thumbAlong: 1, free: 0.35 };
}

/** Mai coiling the 5G2.5 (p6-coil at shot time t; s = scene time for her idle motion); right = the sim's fist frame */
export function coilRig(t: number, s: number, right: Frame): Rig {
  const base = stand(MAI, [0.0, 0.02], 0.08, { width: 0.32, stagger: 0.06 });
  // she leans a little towards the hand that goes out
  let out = 0;
  for (let k = 0; k < COIL.kinds.length; k++) {
    const b = coilBeat(k);
    out = Math.max(out, ramp(t, b.slide0, b.slide1) * (1 - ramp(t, b.back0, b.back1)));
  }
  const rig: Rig = {
    ...base,
    lean: 0.1,
    bend: 0.09 * out,
    twist: -0.05 + 0.08 * out,
    look: mix(add(COIL.F, [0.05, -0.2, 0]), add(right.p, [0, -0.1, 0]), 0.35 + 0.4 * out),
    reach: 0.8,
    hands: [coilLeft(t), { grip: right as Grip, hold: 'fist', radius: 0.008, free: 0.5 }],
  };
  return withIdle(rig, s);
}

// ======================================================================================= ring

/** Mai with the finished ring: lifts it close to her body and walks forward two steps */
export function ringRig(t: number, s: number, fist: Frame): Rig {
  const T = RING_T;
  const path = [
    { t: T.walk0, x: 0.0, z: 0.02, yaw: 0.0 },
    { t: T.walk1, x: 0.0, z: -1.08, yaw: 0.0 },
  ];
  const w = walk(MAI, path, t, 1);
  const n = 11;
  const p = add(fist.p, [0.03, -0.004, 0.01 * n]);
  // the top of the ring in her left fist (strands across, palm towards her), pulled in close
  const left: HandRig = { grip: gripFrame(p, norm([-0.9, 0, -0.45]), norm([0.3, -0.35, 0.9])), hold: 'coil', radius: 0.05, thumbAlong: 1, free: 0.5 };
  // the right hand steadies the ring from the front while she walks
  const lift = ramp(t, T.lift0, T.lift1);
  const rpos: V3 = add(fist.p, [0.18, -0.16, -0.12]);
  const right: HandRig = lift > 0.5 ? { wrist: rpos, dir: norm([-0.6, -0.5, -0.2]), palm: norm([-0.5, 0, 0.8]), curl: 0.45 } : hangingHand([w.pos[0], w.pos[1]], 0, 1);
  const rig: Rig = { ...w, lean: (w.lean ?? 0) + 0.04 - 0.03 * lift, look: add(fist.p, [0.1, -0.3, -0.4]), reach: 0.6, hands: [left, right] };
  return withIdle(rig, s, 1.3);
}

// ======================================================================================= fail

/** Mai trying a loop of the 5G16 in her hands (p6-fail); the fists from the sim (functions of shot time) */
export function failRig(t: number, s: number, left: (t: number) => Frame, right: (t: number) => Frame): Rig {
  const T = FAIL_T;
  const holdsL = t >= T.gripL - 0.1 && t < T.open + 0.1;
  const holdsR = t >= T.gripR - 0.1 && t < T.letGo + 0.05;
  const usesL = t > T.reachL && t < T.open + 0.25;
  const usesR = t > T.reachR - 0.2 && t < T.letGo + 0.9;
  // where she stands and how deep she goes: from the fists she uses (averaged over ±0.3 s: smooth)
  const at = (tt: number) => {
    const uL = tt > T.reachL && tt < T.open + 0.25, uR = tt > T.reachR - 0.2 && tt < T.letGo + 0.9;
    const pl = left(tt).p, pr = right(tt).p;
    const xs = uL && uR ? (pl[0] + pr[0]) / 2 : uR ? pr[0] - 0.2 : uL ? pl[0] + 0.25 : 0.05;
    const low = Math.min(uL ? pl[1] : 1.2, uR ? pr[1] : 1.2);
    return { x: xs, depth: Math.max(0, Math.min(0.95, (0.85 - low) / 0.6)) };
  };
  let x = 0, depth = 0;
  for (const dt of [-0.3, -0.15, 0, 0.15, 0.3]) {
    const a = at(t + dt);
    x += a.x / 5;
    depth += a.depth / 5;
  }
  const st = squat(MAI, [x, 0.08], 0, depth);
  const L: HandRig = usesL ? { grip: left(t) as Grip, hold: 'fist', radius: 0.015, free: 0.4, open: holdsL ? 0 : 0.8 } : hangingHand(st.pos, 0, -1, 0.82 - 0.4 * depth);
  const R: HandRig = usesR ? { grip: right(t) as Grip, hold: 'fist', radius: 0.015, free: 0.4, open: holdsR ? 0 : 0.9 } : hangingHand(st.pos, 0, 1, 0.82 - 0.4 * depth);
  // straining: the back a little more forward while the loop fights her
  const strain = ramp(t, T.loop0, T.loop1) * (1 - ramp(t, T.letGo, T.letGo + 0.5));
  const lp = left(t).p, rp = right(t).p;
  const rig: Rig = {
    ...st,
    lean: (st.lean ?? 0) + 0.08 + 0.06 * strain,
    look: t < T.reachR ? add(lp, [0.2, -0.3, 0]) : t < T.letGo + 1.5 ? mix(rp, lp, 0.5) : add(lp, [0.3, -0.4, 0]),
    reach: 1,
    hands: [L, R],
  };
  return withIdle(rig, s, 0.7);
}

// ===================================================================================== eights

/** where Mai stands while laying (in front of the stack's near side), following her fist */
const EIGHTS_Z = STACK.C[2] + 0.74;

/** Mai laying the eights (p6-eights at shot time t); fist = the sim's (recorded) fist frame, open = how far it has let go */
export function eightsRig(t: number, s: number, fist: Frame, open: number): Rig {
  // she follows her fist sideways, a little behind it, with small steps (smoothed)
  const sm = (dt: number) => eightsFist(t + dt).p[0];
  const fx = (sm(-0.6) + sm(-0.3) + sm(0) + sm(0.3) + sm(0.6)) / 5;
  const x = Math.max(-0.75, Math.min(0.75, 0.75 * fx + 0.12));
  const st = stand(MAI, [x, EIGHTS_Z], 0, { width: 0.42, stagger: 0.1 * Math.sin(1.2 * t) });
  const right: HandRig = { grip: fist as Grip, hold: 'fist', radius: 0.015, free: 0.5, open: 0.15 + 0.85 * open };
  // the left hand on her left thigh, supporting the bent-over back
  const left: HandRig = { wrist: [x - 0.2, 0.5, EIGHTS_Z - 0.3], dir: norm([0.15, -0.6, -0.8]), palm: [0.2, -0.9, 0.2], curl: 0.35 };
  const rig: Rig = { ...st, drop: 0.26, lean: 0.85, twist: 0.25 * Math.max(-1, Math.min(1, (fist.p[0] - x) / 0.5)), look: add(fist.p, [0, -0.3, -0.05]), reach: 1, hands: [left, right] };
  return withIdle(rig, s, 2.1);
}

// ===================================================================================== straps

/** the straps: where they go round the stack (the outer ends of both lobes) */
export const STRAP_AT: V3[] = [stackWorld(STACK.D + STACK.R - 0.02, 0.0, 0.0), stackWorld(-(STACK.D + STACK.R - 0.02), 0.0, 0.0)];
export const STRAPS_T = { kneel: 0.6, a0: 1.0, a1: 2.6, b0: 3.2, b1: 4.8, up: 5.4, end: 6.2 };

/** Mai kneeling at the stack, closing the two straps (kinematic): t = time in the straps beat */
export function strapsRig(t: number, s: number): Rig {
  const T = STRAPS_T;
  const which = t < T.b0 - 0.3 ? 0 : 1;
  const at = STRAP_AT[which];
  const goB = ramp(t, T.a1 + 0.1, T.b0);
  const x = lerp(STRAP_AT[0][0] - 0.25, STRAP_AT[1][0] + 0.25, goB);
  const kneelDown = ramp(t, 0, T.kneel) * (1 - ramp(t, T.up, T.end));
  const pos: [number, number] = [x, STACK.C[2] + 0.45];
  const st = kneelDown > 0.5 ? kneel(MAI, pos, 0, 'R') : stand(MAI, pos, 0, { width: 0.3 });
  const working = t > T.a0 - 0.2 && t < T.b1 + 0.2 && Math.abs(goB - Math.round(goB)) < 0.02;
  const u = (t - (which ? T.b0 : T.a0)) / (T.a1 - T.a0);
  const wrap = Math.max(0, Math.min(1, u));
  // the hands go round the bundle with the strap: under (near side), up over the top
  const near: V3 = add(at, [0, 0.06, 0.12]);
  const top: V3 = add(at, [0, 0.22, 0.0]);
  const hand = (side: -1 | 1): HandRig => {
    const p = add(mix(near, top, Math.sin((wrap * Math.PI) / 2)), [side * 0.07, 0, 0]);
    return { wrist: add(p, [0, 0.03, 0.09]), dir: norm([0, -0.5, -1]), palm: [0, -1, 0.2], curl: 0.5 };
  };
  const hy = 0.82 - 0.38 * kneelDown;
  const hands: [HandRig | null, HandRig | null] = working ? [hand(-1), hand(1)] : [hangingHand(pos, 0, -1, hy), hangingHand(pos, 0, 1, hy)];
  const rig: Rig = { ...st, lean: (st.lean ?? 0) + 0.35 * kneelDown, look: at, reach: 1, hands };
  return withIdle(rig, s, 0.4);
}

// ====================================================================================== carry

/**
 * Carrying the strapped stack together: Mai at its left end facing +x, Ada at its right end facing
 * -x. Both squat, grip, Mai counts down with her right hand (3, 2, 1), both stand up with a straight
 * back, carry it three small steps (Mai forwards, Ada backwards) and put it down.
 */
export const CARRY_T = { squat: 1.4, grip: 2.2, sign: 5.2, count: 0.7, lift0: 7.6, lift1: 9.0, walk0: 9.4, walk1: 12.0, down0: 12.4, down1: 13.6, end: 14.4 };
/** the stack's ends (where the hands hold it) at rest, and how far it travels */
export const CARRY = { ends: [-(STACK.D + STACK.R) - 0.02, STACK.D + STACK.R + 0.02], travel: 0.6, lift: 0.55 };

/** where the stack is during the carry: offset (x travel, y lift) at time t */
export function carryOffset(t: number): V3 {
  const T = CARRY_T;
  const up = ramp(t, T.lift0, T.lift1) * (1 - ramp(t, T.down0, T.down1));
  const go = ramp(t, T.walk0, T.walk1);
  return [CARRY.travel * go, CARRY.lift * up, 0];
}

/** which number Mai shows (3, 2, 1) or 0 */
export function carryCount(t: number): number {
  const T = CARRY_T;
  if (t < T.sign || t >= T.sign + 3 * T.count) return 0;
  return 3 - Math.floor((t - T.sign) / T.count);
}

/** feet shuffling along x: three small steps between a and b (the lead foot first) */
function shuffle(spec: typeof MAI, x0: number, x1: number, z: number, yaw: number, t: number, t0: number, t1: number, depth: number): Pick<Rig, 'pos' | 'yaw' | 'feet' | 'drop' | 'lean'> {
  const steps = 3;
  const u = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
  const k = spec.height / 1.75;
  const f: V3 = [Math.sin(yaw), 0, -Math.cos(yaw)], r: V3 = [Math.cos(yaw), 0, Math.sin(yaw)];
  // each foot moves in its own half of every step
  const footX = (lead: boolean) => {
    let x = x0;
    for (let i = 0; i < steps; i++) {
      const a = (i + (lead ? 0 : 0.5)) / steps, b = (i + (lead ? 0.5 : 1)) / steps;
      x += ((x1 - x0) / steps) * ease((u - a) / (b - a));
    }
    return x;
  };
  const lift = (lead: boolean) => {
    let h = 0;
    for (let i = 0; i < steps; i++) {
      const a = (i + (lead ? 0 : 0.5)) / steps, b = (i + (lead ? 0.5 : 1)) / steps;
      const v = (u - a) / (b - a);
      if (v > 0 && v < 1) h = Math.sin(Math.PI * v) * 0.05;
    }
    return h;
  };
  const sq = squat(spec, [x0, z], yaw, depth);
  const ankle = (side: -1 | 1, x: number, h: number): LegRig => ({
    ankle: add(add([x, 0.075 * k + h, z], mul(r, side * 0.14 * k)), mul(f, side * 0.05)),
    dir: norm(add(f, mul(r, side * 0.15))),
    knee: norm(add(f, mul(r, side * 0.3))),
  });
  // the lead foot is the one on the side the steps go to first (the left foot when facing +x)
  const xl = footX(true), xt = footX(false);
  const px = (xl + xt) / 2;
  return {
    pos: [px + (sq.pos[0] - x0), sq.pos[1]],
    yaw,
    drop: sq.drop,
    lean: sq.lean,
    feet: [ankle(-1, xl, lift(true)), ankle(1, xt, lift(false))],
  };
}

/** Mai (who = 0) or Ada (who = 1) carrying, at time t of the carry beat */
export function carryRig(who: 0 | 1, t: number, s: number): Rig {
  const T = CARRY_T;
  const spec = who ? ADA : MAI;
  const yaw = who ? -Math.PI / 2 : Math.PI / 2;
  const end = CARRY.ends[who];
  const off = carryOffset(t);
  // stand back from the stack's end, facing it
  const zC = STACK.C[2];
  const back = who ? 0.3 : -0.3;
  const depth = ramp(t, 0.3, T.squat) * (1 - ramp(t, T.lift0, T.lift1)) + ramp(t, T.down0, T.down1) * (1 - ramp(t, T.end - 0.3, T.end + 0.6));
  const x0 = end + back;
  const st = shuffle(spec, x0, x0 + CARRY.travel, zC, yaw, t, T.walk0, T.walk1, depth);
  // the hands under the stack's end, either side of it, close to the body
  const handAt = (side: -1 | 1): V3 => [end + off[0] + (who ? 0.02 : -0.02), 0.12 + off[1], zC + side * 0.1];
  const grips = t >= T.grip - 0.6 && t < T.down1 + 0.35;
  const toHand = (side: -1 | 1): HandRig => {
    const p = handAt(side);
    const reachIn = ramp(t, T.squat - 0.4, T.grip);
    const away: V3 = add(p, [who ? 0.25 : -0.25, 0.25, side * 0.08]);
    const at = mix(away, p, reachIn);
    // a fist round the strands at the end of the stack, from below and the side
    return { grip: gripFrame(at, [0, 0, side * 1], norm([who ? 0.6 : -0.6, -0.8, 0])), hold: 'fist', radius: 0.03, free: 0.6, open: 1 - ramp(t, T.grip - 0.3, T.grip) };
  };
  let hands: [HandRig | null, HandRig | null] = grips ? [toHand(who ? 1 : -1), toHand(who ? -1 : 1)] : [hangingHand(st.pos, yaw, -1), hangingHand(st.pos, yaw, 1)];
  // Mai's hand sign: the right hand up at her shoulder, towards Ada, then back to the load
  if (!who && t >= T.sign - 0.6 && t < T.sign + 3 * T.count + 0.4) {
    const n = carryCount(t) || (t < T.sign ? 3 : 1);
    const up = ramp(t, T.sign - 0.6, T.sign - 0.1) * (1 - ramp(t, T.sign + 3 * T.count, T.sign + 3 * T.count + 0.4));
    const f: V3 = [1, 0, 0];
    const shoulder: V3 = [st.pos[0] + 0.02, 0.95 - 0.35 * (1 - up), zC + 0.2];
    const fingers: [number, number, number, number] = n >= 3 ? [0, 0, 0, 1] : n === 2 ? [0, 0, 1, 1] : [0, 1, 1, 1];
    const sign: HandRig = { wrist: add(shoulder, mul(f, 0.25)), dir: norm([0.3, 1, 0]), palm: [1, 0, 0], fingers, curl: 0.2 };
    if (up > 0.05) hands = [hands[0], up > 0.5 ? sign : hands[1]];
  }
  const other: V3 = who ? [CARRY.ends[0] - 0.3 + off[0], 1.1, zC] : [CARRY.ends[1] + 0.3 + off[0], 1.1, zC];
  const look = t < T.lift0 && (who === 1 || t > T.sign - 0.8) ? other : add([end + off[0], 0.1 + off[1], zC], [who ? -0.4 : 0.4, 0, 0]);
  const rig: Rig = { ...st, lean: (st.lean ?? 0) * 0.85 + 0.05, look, reach: 0.8, hands };
  return withIdle(rig, s, who ? 3.1 : 0.2);
}

// ===================================================================================== unroll

/** Mai taking the end off the stack and walking away with it; fist = the sim's fist frame */
export function unrollRig(t: number, s: number, fist: Frame): Rig {
  const T = UNROLL_T;
  // she stands by the end, bends to take it, then walks away to her right (+x), the end in her right hand
  const p0 = fist.p;
  const start: [number, number] = [stackPlane(STACK.total).X + STACK.C[0] - 0.05, STACK.C[2] + 0.62];
  const bendDown = ramp(t, 0, T.grip) * (1 - ramp(t, T.grip + 0.1, T.lift));
  if (t < T.walk0) {
    const st = squat(MAI, start, Math.PI / 2 - 0.9, 0.55 * bendDown);
    const right: HandRig = { grip: fist as Grip, hold: 'fist', radius: 0.015, free: 0.5, open: 1 - ramp(t, T.grip - 0.2, T.grip) };
    return withIdle({ ...st, lean: (st.lean ?? 0) + 0.15 * bendDown, look: p0, reach: 1, hands: [hangingHand(st.pos, Math.PI / 2 - 0.9, -1), right] }, s, 1.7);
  }
  const path = [
    { t: T.walk0, x: start[0], z: start[1], yaw: Math.PI / 2 - 0.9 },
    { t: T.walk0 + 0.7, x: start[0] + 0.2, z: start[1] - 0.05 },
    { t: T.walk1, x: p0[0] - 0.2, z: p0[2] + 0.25 },
  ];
  const w = walk(MAI, path, Math.min(t, T.walk1 + 0.5), 4);
  const right: HandRig = { grip: fist as Grip, hold: 'fist', radius: 0.015, free: 0.7 };
  // she looks back at the stack now and then
  const back = 0.5 + 0.5 * Math.sin(1.1 * t);
  const look = mix(add(p0, [1.2, 0.5, 0]), [STACK.C[0], 0.1, STACK.C[2]], back);
  void dot;
  void sub;
  return withIdle({ ...w, look, reach: 0.8, hands: [null, right] }, s, 1.7);
}

export { ADA, MAI };
