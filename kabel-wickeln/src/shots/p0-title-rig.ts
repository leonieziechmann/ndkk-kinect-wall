// The title (part p0-title): the load-out after a show. Where everybody is, what they do (rigs for
// people/rig.ts), and the cables and rings they handle. Pure TypeScript (no three.js): the part
// builds RigTracks and meshes from it, and a Node check can sample it.
//
// Rough animation (animatic): simple keyframes with smooth eases, a little overlap, breathing and
// weight shift, heads looking at what the hands do. The recorded takes (mocap/shots.json, see
// MOCAP_SLOTS in the part) replace the bodies later.
//
// The cables here are drawn, not simulated (KONZEPT allows a guided cable where its behaviour is
// not the point; here nobody is taught anything yet): Noor's cable is built every frame from her
// hands (the loops in her left hand, the loop between her hands as a circular arc of the right
// length, the cable down to the floor and along it, pulled in as she coils); the rings of Kofi, Mai
// and Ada are rigid. The one simulated cable is the clean ring on the flight case
// (shots/p0-title.ts).
//
// World: y up, metres; the wide camera stands on +z and looks towards -z; a person with yaw 0 faces -z.

import type { Quat, V3 } from '../people/math';
import { add, clamp, cross, dot, len, lerp, madd, mix3, norm, quatFromCols, scale, slerp, sub } from '../people/math';
import { ADA, ILSE, JONAS, KOFI, MAI, NOOR, ROBIN } from '../people/cast';
import { PersonSpec, yawFrame } from '../people/people';
import { HandRig, Rig, Waypoint, gripFrame, seated, squat, stand, walk } from '../people/rig';
import { HERO_CASE } from './p0-title';

// ===================================================================================== helpers

/** minimum-jerk ease 0 → 1 */
export const ease = (u: number) => {
  const x = clamp(u);
  return x * x * x * (10 - 15 * x + 6 * x * x);
};
/** 0 → 1 between a and b (eased) */
export const ramp = (t: number, a: number, b: number) => ease((t - a) / Math.max(1e-6, b - a));
const UP: V3 = [0, 1, 0];
const DOWN: V3 = [0, -1, 0];

/** a little breathing and weight shift: never quite still */
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

/** a point in a person's frame: x to the right, y up, z forward */
function bodyPoint(pos: [number, number], yaw: number, x: number, y: number, z: number): V3 {
  const f = yawFrame(yaw);
  return [pos[0] + f.r[0] * x + f.f[0] * z, y, pos[1] + f.r[2] * x + f.f[2] * z];
}

/** the wrist's height of an arm hanging relaxed (a little bent) for a person standing (pelvis `drop` lower) */
const hangY = (spec: PersonSpec, drop = 0) => 0.875 * (spec.height / 1.75) - drop;

/** a free hand hanging relaxed at the side (a rig the IK can move from and to without a jump) */
function hangingHand(spec: PersonSpec, pos: [number, number], yaw: number, side: -1 | 1, drop = 0, out = 0.21): HandRig {
  const f = yawFrame(yaw);
  const k = spec.height / 1.75;
  return freeHand(bodyPoint(pos, yaw, side * out * k * spec.build.shoulders, hangY(spec, drop), 0.03), add(DOWN, scale(f.f, 0.15)), scale(f.r, -side), 0.3, 0.5, 0.3);
}

/** a free hand: the wrist at `wrist`, soft wishes for the finger direction and the palm */
function freeHand(wrist: V3, dir: V3, palm: V3, curl = 0.35, wDir = 0.5, wPalm = 0.4, pinch = 0): HandRig {
  return { wrist, prefer: [{ hand: [1, 0, 0], world: norm(dir), weight: wDir }, { hand: [0, 1, 0], world: norm(palm), weight: wPalm }], curl, pinch };
}
/** between two free hands (made by freeHand or hangingHand) */
function blendHand(a: HandRig, b: HandRig, u: number): HandRig {
  const pa = a.prefer ?? [], pb = b.prefer ?? [];
  return {
    wrist: mix3(a.wrist as V3, b.wrist as V3, u),
    prefer: pa.map((g, i) => ({ hand: g.hand, world: norm(mix3(g.world, pb[i]?.world ?? g.world, u)), weight: lerp(g.weight ?? 1, pb[i]?.weight ?? 1, u) })),
    curl: lerp(a.curl ?? 0.3, b.curl ?? 0.3, u),
    pinch: lerp(a.pinch ?? 0, b.pinch ?? 0, u),
  };
}

/**
 * Where a rig's shoulder is (the joint), without solving the arms: the same construction as
 * rig.ts core() and armSetup() (pelvis from the drop, the spine from lean and bend, the chest
 * turned by twist). Good to a few millimetres while the feet reach the floor.
 */
export function shoulderOf(spec: PersonSpec, g: Rig, side: -1 | 1): { p: V3; r: V3; u: V3; f: V3 } {
  const k = spec.height / 1.75;
  const base = yawFrame(g.yaw);
  const lean = g.lean ?? 0, bend = g.bend ?? 0;
  const spine = norm([base.f[0] * Math.sin(lean) + base.r[0] * Math.sin(bend), Math.cos(lean) * Math.cos(bend), base.f[2] * Math.sin(lean) + base.r[2] * Math.sin(bend)]);
  const pelvis: V3 = [g.pos[0], 0.935 * k - (g.drop ?? 0), g.pos[1]];
  const neck = madd(pelvis, spine, 0.5 * k);
  const tw = g.twist ?? 0;
  const f0: V3 = [base.f[0] * Math.cos(tw) - base.r[0] * Math.sin(tw), 0, base.f[2] * Math.cos(tw) - base.r[2] * Math.sin(tw)];
  const r = norm(cross(f0, spine));
  const f = cross(spine, r);
  const p = add(add(add(neck, scale(r, side * 0.19 * k * spec.build.shoulders)), scale(spine, -0.04 * k)), scale(f, -0.01));
  return { p, r, u: spine, f };
}

// ===================================================================================== the set

/** where everything stands (x, z on the floor) */
export const SET = {
  noor: { pos: [-2.6, 0.55] as [number, number], yaw: Math.PI - 0.75 },
  jonas: { pos: [-0.35, -0.94] as [number, number], yaw: Math.PI },
  /** Jonas' case: a flight case with a hinged lid (hinge on the far side from him, towards the camera) */
  jcase: { x: -0.35, z: -0.5, width: 0.8, depth: 0.5, height: 0.5, lid: 0.13 },
  crate: { x: 1.85, z: -1.05, width: 0.6, depth: 0.4, height: 0.32 },
  mai: { pos: [1.29, -1.05] as [number, number], yaw: Math.PI / 2 },
  ada: { pos: [2.41, -1.05] as [number, number], yaw: -Math.PI / 2 },
  ilse: { seat: [-2.3, -2.2] as [number, number], yaw: Math.PI },
  desk: { x: -2.3, z: -1.58, width: 1.4, depth: 0.7, height: 0.74 },
  /** the mixing desk on the FOH table (centre of its footprint) */
  mixer: { x: -2.3, z: -1.68 },
  /** Kofi's and Robin's ways across (z), the stage at the back (its front edge) */
  kofiZ: -3.0,
  robinZ: 0.0,
  stageFront: -4.7,
  hero: HERO_CASE,
};

// ===================================================================================== Noor

const NOOR_F = yawFrame(SET.noor.yaw);
/** the coil's rod: forward, turned 15° to her right; the loops hang across it, every new loop in front */
const NOOR_N = norm(add(scale(NOOR_F.f, Math.cos(0.26)), scale(NOOR_F.r, Math.sin(0.26))));
/** across the loops, to her right */
const NOOR_E = norm(cross(NOOR_N, UP));

/** the cable she coils: drawn 12 mm thick in the wide shot (KONZEPT), 5 m, loops of ≈ 0.74 m */
export const COIL = {
  kinds: 'ououou',
  /** loops already in her hand when the part starts */
  done0: 2,
  /** the third loop starts here (part time, s) */
  t0: -0.6,
  period: { o: 2.4, u: 2.7 },
  /** in a loop's period: the right hand slides out until, brings it back until (fractions) */
  slide: 0.42,
  back: 0.9,
  lead: 0.25,
  total: 5.0,
  /** drawn radius (the wide shot) and the distance between the loops in her hand */
  r: 0.006,
  spacing: 0.0135,
  /** the loops of the two already in her hand */
  loop0: 0.64,
};

/** start time and period of loop k (k ≥ done0) */
function loopTimes(k: number) {
  let t = COIL.t0;
  for (let j = COIL.done0; j < k; j++) t += COIL.period[COIL.kinds[j] as 'o' | 'u'];
  return { start: t, period: COIL.period[COIL.kinds[k] as 'o' | 'u'] };
}

/** the coil's state at t: loops in the hand, the loop being made (or -1) and where in it (0 … 1) */
function coilState(t: number) {
  let n = COIL.done0, k = -1, u = 0;
  for (let j = COIL.done0; j < COIL.kinds.length; j++) {
    const { start, period } = loopTimes(j);
    if (t < start) break;
    const v = (t - start) / period;
    if (v >= COIL.back) {
      n = j + 1;
      continue;
    }
    k = j;
    u = v;
    break;
  }
  return { n, k, u };
}

/** her idle sway (also moves her hands a little) */
const noorSway = (t: number): V3 => [0.006 * Math.sin(0.9 * t), 0.004 * Math.sin(1.3 * t + 0.6), 0.005 * Math.sin(0.7 * t + 1.1)];

/** the left fist: where the top strands of the loops lie (the first loop's top) */
export function noorFist(t: number): V3 {
  return add(bodyPoint(SET.noor.pos, SET.noor.yaw, -0.13, 0.93, 0.33), noorSway(t));
}
/** the top of loop k in the fist */
const loopTop = (t: number, k: number): V3 => madd(noorFist(t), NOOR_N, COIL.spacing * k);
/** where the right hand hands a loop over: just right of its top */
const handOver = (t: number, k: number): V3 => add(madd(loopTop(t, k), NOOR_E, 0.055), [0, -0.012, 0]);

/** the right hand's pinch point (the cable runs through it) at t */
export function noorHand(t: number): V3 {
  const { n, k, u } = coilState(t);
  const kk = k >= 0 ? k : n;
  const rest = handOver(t, Math.min(kk, COIL.kinds.length - 1));
  if (k < 0) return rest;
  const hip = add(bodyPoint(SET.noor.pos, SET.noor.yaw, 0.42, 0.84, 0.07), noorSway(t));
  const mid = add(bodyPoint(SET.noor.pos, SET.noor.yaw, 0.2, 0.8, 0.22), noorSway(t));
  if (u < COIL.slide) return mix3(rest, hip, ease(u / COIL.slide));
  const v = ease((u - COIL.slide) / (COIL.back - COIL.slide));
  // back along a lower arc (a quadratic curve through mid)
  const a = mix3(hip, mid, v), b = mix3(mid, rest, v);
  return mix3(a, b, v);
}

/** the material between the loop's top and the right hand while it slides: a slight sag */
const SAG = 1.04;
/** the length of loop k (m): what was between the hands when the right hand stopped sliding */
function loopLength(k: number): number {
  if (k < COIL.done0) return COIL.loop0;
  const { start, period } = loopTimes(k);
  const ts = start + COIL.slide * period;
  return len(sub(noorHand(ts), loopTop(ts, k))) * SAG;
}

/**
 * A circular arc of length L from T to H that bulges towards `b` (⟂ to the chord): a slight sag
 * when the hands are apart, a full round loop when they meet. n + 1 points from T to H.
 */
function arc(T: V3, H: V3, L: number, bulge: V3, n: number): V3[] {
  const ch = sub(H, T);
  const d = Math.max(1e-4, len(ch));
  const c = scale(ch, 1 / d);
  const b = norm(madd(bulge, c, -dot(bulge, c)));
  // half angle α with sin α / α = d / L (α in (0, π))
  const q = Math.min(0.9999, d / Math.max(L, d * 1.0001));
  let lo = 1e-4, hi = Math.PI - 1e-4;
  for (let i = 0; i < 50; i++) {
    const m = (lo + hi) / 2;
    if (Math.sin(m) / m > q) lo = m;
    else hi = m;
  }
  const al = (lo + hi) / 2, rho = L / (2 * al);
  const M = scale(add(T, H), 0.5);
  const O = madd(M, b, -rho * Math.cos(al));
  const out: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const th = -al + (2 * al * i) / n;
    out.push(add(O, add(scale(b, rho * Math.cos(th)), scale(c, rho * Math.sin(th)))));
  }
  return out;
}

/** a cubic Bézier, n + 1 points */
function bezier(p0: V3, p1: V3, p2: V3, p3: V3, n: number): V3[] {
  const out: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, v = 1 - u;
    out.push(add(add(scale(p0, v * v * v), scale(p1, 3 * v * v * u)), add(scale(p2, 3 * v * u * u), scale(p3, u * u * u))));
  }
  return out;
}

/** length of a polyline */
export function polyLength(P: V3[]): number {
  let s = 0;
  for (let i = 1; i < P.length; i++) s += len(sub(P[i], P[i - 1]));
  return s;
}

/** the polyline cut to length L from its start */
function cut(P: V3[], L: number): V3[] {
  const out: V3[] = [P[0]];
  let s = 0;
  for (let i = 1; i < P.length; i++) {
    const l = len(sub(P[i], P[i - 1]));
    if (s + l >= L) {
      out.push(mix3(P[i - 1], P[i], (L - s) / Math.max(1e-9, l)));
      return out;
    }
    s += l;
    out.push(P[i]);
  }
  return out;
}

/** Catmull-Rom through control points, `per` points per span */
function catmull(C: V3[], per: number): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < C.length - 1; i++) {
    const p0 = C[Math.max(0, i - 1)], p1 = C[i], p2 = C[i + 1], p3 = C[Math.min(C.length - 1, i + 2)];
    for (let j = 0; j < per; j++) {
      const u = j / per, u2 = u * u, u3 = u2 * u;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]), f(p0[2], p1[2], p2[2], p3[2])]);
    }
  }
  out.push(C[C.length - 1]);
  return out;
}

/** the way the cable lies on the floor from her right foot outwards (fixed: the cable is pulled along it) */
const FLOOR_PATH: V3[] = (() => {
  const C = [[0.36, 0.12], [0.72, 0.22], [1.02, 0.52], [0.98, 0.98], [1.22, 1.42], [1.72, 1.58], [2.08, 1.96], [2.12, 2.46], [2.46, 2.86], [2.98, 2.98]].map(
    ([x, z]) => bodyPoint(SET.noor.pos, SET.noor.yaw, x, COIL.r, z),
  );
  return catmull(C, 30);
})();

/**
 * Noor's cable at t, from the start plug's tip to the end plug's tip (a dense polyline): the start
 * end out of the top of her fist, the loops in her left hand, the loop between her hands, the cable
 * down from her right hand to the floor and along the floor. Its length stays COIL.total.
 */
export function noorCable(t: number): V3[] {
  const { n, k } = coilState(t);
  const pts: V3[] = [];
  const T0 = loopTop(t, 0);
  // the start end: out of the top of the fist, up and to her left, the plug at its tip
  const leadDir = norm(add(add(scale(UP, 0.55), scale(NOOR_E, -0.6)), scale(NOOR_N, -0.25)));
  const tip = madd(T0, leadDir, COIL.lead);
  for (let i = 0; i <= 10; i++) pts.push(mix3(tip, T0, i / 10));
  // the loops in the hand: round, hanging from their tops
  for (let j = 0; j < n; j++) {
    const L = loopLength(j);
    const P = arc(loopTop(t, j), handOver(t, j), L, DOWN, 72);
    pts.push(...P.slice(1));
    // on to the next loop's top (in front of this one)
    if (j + 1 < COIL.kinds.length) pts.push(mix3(handOver(t, j), loopTop(t, j + 1), 0.5));
  }
  // the loop between the hands
  const H = noorHand(t);
  if (k >= 0) {
    const Tk = loopTop(t, k);
    const { start, period } = loopTimes(k);
    const u = (t - start) / period;
    const L = u < COIL.slide ? len(sub(H, Tk)) * SAG : loopLength(k);
    const P = arc(Tk, H, L, DOWN, 72);
    pts.push(...P.slice(1));
  }
  // from the right hand down to the floor and along it (what is left of the 5 m); when too little
  // is left to reach the floor, the end hangs along the same curve from the hand
  const rest = COIL.total - polyLength(pts);
  const g0 = norm(sub(FLOOR_PATH[3], FLOOR_PATH[0]));
  const F0 = FLOOR_PATH[0];
  const drop = Math.min(0.32, Math.max(0.05, H[1] - 0.25));
  const hang = bezier(H, add(H, [0, -drop, 0]), madd(F0, g0, -0.22), F0, 40).map((p): V3 => [p[0], Math.max(COIL.r, p[1]), p[2]]);
  const lh = polyLength(hang);
  if (rest <= lh) {
    pts.push(...cut(hang, Math.max(0.02, rest)).slice(1));
    return pts;
  }
  pts.push(...hang.slice(1));
  pts.push(...cut(FLOOR_PATH, rest - lh).slice(1));
  return pts;
}

/** Noor coiling (natural tempo, over-under): stance, the coil in her left hand, the right hand sliding out and bringing loops back */
export function noorRig(t: number): Rig {
  const { pos, yaw } = SET.noor;
  const base = stand(NOOR, pos, yaw, { width: 0.3, stagger: 0.05 });
  const { n, k, u } = coilState(t);
  const H = noorHand(t);
  const out = k >= 0 ? (u < COIL.slide ? ease(u / COIL.slide) : 1 - ease((u - COIL.slide) / (COIL.back - COIL.slide))) : 0;
  const under = k >= 0 && COIL.kinds[k] === 'u' && u > COIL.slide;
  const turnOver = under ? Math.sin((Math.PI * (u - COIL.slide)) / (COIL.back - COIL.slide)) : 0;
  // the left hand: the bundle of loop tops (stacked along N) in the hook of the fingers, palm up
  const mid = madd(noorFist(t), NOOR_N, COIL.spacing * Math.max(0, n - 1) * 0.5);
  const left: HandRig = { grip: gripFrame(mid, scale(NOOR_E, -1), norm(add(scale(NOOR_N, -0.85), [0, -0.45, 0]))), hold: 'coil', radius: 0.008 + 0.0055 * n, thumbAlong: 1, free: 0.4 };
  // the right hand: thumb and index finger round the cable (it slides through), the back of the hand
  // up; for an "unter" loop it turns over on the way back (palm up)
  const toFist = norm(sub(noorFist(t), H));
  const dir = norm(add(add(scale(toFist, 0.55), scale(NOOR_F.f, 0.35)), [0, -0.35, 0]));
  const palm = norm(madd(madd(scale(DOWN, 1 - turnOver), UP, turnOver * 0.9), NOOR_F.r, -0.3));
  const right: HandRig = { wrist: madd(H, dir, -0.075), prefer: [{ hand: [1, 0, 0], world: dir, weight: 0.4 }, { hand: [0, 1, 0], world: palm, weight: 0.5 }], curl: 0.55, pinch: 0.9 };
  const rig: Rig = {
    ...base,
    lean: 0.12,
    bend: 0.06 * out,
    twist: 0.06 * out,
    look: mix3(noorFist(t), H, 0.35 + 0.3 * out),
    reach: 0.6,
    hands: [left, right],
  };
  return withIdle(rig, t, 0.3);
}

// ===================================================================================== rings (rigid)

export interface RingShape {
  /** the polyline in the ring's frame: centre at 0, lying flat (stack along +y), the tie at +z on the rim */
  pts: V3[];
  /** the bundle at the tie (ring frame): centre, the strands' direction, radius */
  tie: { c: V3; axis: V3; radius: number };
  R: number;
}

/** a small deterministic irregularity, -1 … 1 */
const wob = (k: number, salt: number) => Math.sin(12.9898 * (k + 1) + 78.233 * salt) * 0.5 + Math.sin(4.1 * (k + 1) * (salt + 1.7)) * 0.5;

/**
 * A coiled ring as a rigid polyline: `loops` loops of radius R, the strands (drawn radius r) packed
 * `rows` across, layer on layer; the start end comes into the tie along +x, the end leaves it.
 */
export function ringShape(o: { R: number; loops: number; r: number; rows: number; lead: number; tail: number; seed?: number }): RingShape {
  const { R, loops, r, rows } = o;
  const gap = 2.15 * r;
  const at = (k: number) => {
    const row = k % rows, layer = Math.floor(k / rows);
    return { dr: (row - (rows - 1) / 2) * gap, y: r + layer * gap };
  };
  const pts: V3[] = [];
  const a0 = at(0);
  for (let i = 0; i <= 12; i++) pts.push([-o.lead + (o.lead * i) / 12, a0.y, R + a0.dr + 0.004 * (1 - i / 12)]);
  const per = 90;
  for (let k = 0; k < loops; k++) {
    const a = at(k), b = at(Math.min(loops - 1, k + 1));
    for (let i = 1; i <= per; i++) {
      const u = i / per;
      const th = 2 * Math.PI * u;
      // blend into the next loop's place over the last 18 %
      const v = k + 1 < loops ? clamp((u - 0.82) / 0.18) : 0;
      const w = v * v * (3 - 2 * v);
      const rr = R + lerp(a.dr, b.dr, w) + 0.006 * wob(k, 1 + (o.seed ?? 0)) * Math.sin(2 * th + k);
      pts.push([rr * Math.sin(th), lerp(a.y, b.y, w), rr * Math.cos(th)]);
    }
  }
  const z = at(loops - 1);
  for (let i = 1; i <= 14; i++) pts.push([(o.tail * i) / 14, z.y, R + z.dr + 0.006 * (i / 14)]);
  const top = at(loops - 1).y;
  return { pts, R, tie: { c: [0, (a0.y + top) / 2, R], axis: [1, 0, 0], radius: Math.max(rows * gap * 0.5, (top - a0.y) / 2 + r) + 0.002 } };
}

/** a rotation from three orthonormal columns (the ring frame's x, y, z in the world) */
export const frameQuat = (x: V3, y: V3, z: V3): Quat => quatFromCols(x, y, z);

/** rotates v by the unit quaternion q */
export function rot(q: Quat, v: V3): V3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
const quatYaw = (a: number): Quat => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
/** the rotation taking unit a to unit b */
function quatFromTo(a: V3, b: V3): Quat {
  const c = cross(a, b), d = dot(a, b);
  if (d < -0.9999) {
    const ax = norm(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
    return [ax[0], ax[1], ax[2], 0];
  }
  const w = 1 + d, l = Math.hypot(c[0], c[1], c[2], w);
  return [c[0] / l, c[1] / l, c[2] / l, w / l];
}
const quatMul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/** a ring in the world: the ring frame's origin (its centre) and rotation */
export interface RingPose {
  c: V3;
  q: Quat;
}

// ===================================================================================== Kofi

/** Kofi's 15 m XLR ring over his right shoulder (drawn 12 mm thick: 9 loops in a bundle of 3 × 3) */
export const KOFI_RING = ringShape({ R: 0.15, loops: 9, r: 0.006, rows: 3, lead: 0.16, tail: 0.14, seed: 2 });
// (one long way: from 0 to 8 s he walks the middle of it, at about 1.1 m/s, from x -4.5 to 4.5)
const KOFI_PATH: Waypoint[] = [
  { t: -8, x: -9, z: SET.kofiZ, yaw: Math.PI / 2 },
  { t: 16, x: 9, z: SET.kofiZ, yaw: Math.PI / 2 },
];
const kofiWalk = (t: number) => walk(KOFI, KOFI_PATH, t, 0.7);

/** the ring on his right shoulder: its top on the shoulder, hanging in the plane of his walk, the bottom a little out */
export function kofiRing(t: number, g: Rig = kofiWalk(t)): RingPose {
  const sh = shoulderOf(KOFI, g, 1);
  const zw = norm(madd(sh.u, sh.r, -0.22)); // ring centre → its top (on the shoulder), leaning in at the top
  const xw = norm(madd(sh.f, zw, -dot(sh.f, zw)));
  const yw = cross(zw, xw);
  const R = KOFI_RING.R;
  const c = add(add(sh.p, scale(zw, 0.055 - R)), scale(sh.r, 0.03));
  return { c, q: frameQuat(xw, yw, zw) };
}

/** Kofi crossing the back of the hall with a long ring over his right shoulder, his right hand on its front */
export function kofiRig(t: number): Rig {
  const w = kofiWalk(t);
  const ring = kofiRing(t, w);
  const R = KOFI_RING.R;
  const th = (100 * Math.PI) / 180;
  const p = add(ring.c, rot(ring.q, [R * Math.sin(th), 0.012, R * Math.cos(th)]));
  const tangent = norm(rot(ring.q, [Math.cos(th), 0, -Math.sin(th)]));
  const outward = norm(rot(ring.q, [Math.sin(th), 0, Math.cos(th)]));
  const right: HandRig = { grip: gripFrame(p, scale(tangent, -1), outward), hold: 'fist', radius: 0.02, free: 0.6 };
  const f = yawFrame(w.yaw).f;
  return { ...w, hands: [null, right], look: [w.pos[0] + f[0] * 3, 1.25, w.pos[1] + f[2] * 3 + 0.4], reach: 0.3 };
}

// ===================================================================================== Robin

// (Robin comes in from the right at about 0.8 m/s and slows down towards x -1.3)
const ROBIN_PATH: Waypoint[] = [
  { t: -3, x: 5.2, z: SET.robinZ, yaw: -Math.PI / 2 },
  { t: 10, x: -1.3, z: SET.robinZ, yaw: -Math.PI / 2 },
];
const robinWalk = (t: number) => walk(ROBIN, ROBIN_PATH, t, 2.1);
/** where Robin's left hand holds the stand's tube (stand frame, m above its feet) */
export const STAND_GRIP = 0.55;
/** the stand leans forward a little in Robin's hand (rad); turned about its tube so that one leg points outwards (rad) */
export const STAND_TILT = 0.06;
export const STAND_SPIN = Math.PI / 2 + Math.PI / 6;

/**
 * The mic stand Robin carries at the left side: the forearm forward, the tube upright in the fist
 * (thumb up), the stand off the floor. The grip (on the tube), the tube's direction, the stand's
 * rotation (yaw · tilt · spin) and its origin (between its feet).
 */
export function robinStand(t: number, g: Rig = robinWalk(t)) {
  const f = yawFrame(g.yaw);
  const k = ROBIN.height / 1.75;
  const y = 1.0 * k - (g.drop ?? 0) * 0.8;
  const grip: V3 = [g.pos[0] - f.r[0] * 0.3 * k + f.f[0] * 0.26 * k, y, g.pos[1] - f.r[2] * 0.3 * k + f.f[2] * 0.26 * k];
  const axis = norm(add(scale(UP, Math.cos(STAND_TILT)), scale(f.f, Math.sin(STAND_TILT))));
  const yaw = Math.atan2(f.f[0], f.f[2]);
  const q = quatMul(quatMul(quatYaw(yaw), [Math.sin(STAND_TILT / 2), 0, 0, Math.cos(STAND_TILT / 2)]), quatYaw(STAND_SPIN));
  return { grip, axis, q, origin: madd(grip, axis, -STAND_GRIP) };
}

/** Robin carrying a mic stand across the front, in the left hand (towards the camera) */
export function robinRig(t: number): Rig {
  const w = robinWalk(t);
  const st = robinStand(t, w);
  const f = yawFrame(w.yaw);
  const left: HandRig = { grip: gripFrame(st.grip, st.axis, f.r), hold: 'fist', radius: 0.0125, free: 0.6 };
  return { ...w, hands: [left, null], look: [w.pos[0] + f.f[0] * 3, 1.1, w.pos[1] + f.f[2] * 3], reach: 0.3 };
}

// ===================================================================================== Ilse

/** Ilse at the FOH desk: the left hand on the faders, the right on a knob; now and then she looks up at the stage */
export function ilseRig(t: number): Rig {
  const { seat, yaw } = SET.ilse;
  const base = seated(ILSE, seat, yaw, 0.5);
  const mx = SET.mixer;
  // a fader pulled down and pushed up again, a pause, another one
  const fader = 0.028 * (ramp(t, 0.6, 1.4) - ramp(t, 4.6, 5.4)) + 0.02 * (ramp(t, 7.0, 7.6) - ramp(t, 9.5, 10.1));
  const fx = -0.12 + 0.05 * ramp(t, 5.6, 6.2);
  const lw: V3 = [mx.x + fx, 0.835, mx.z - 0.19 + fader];
  const knob = 0.35 * Math.sin(1.4 * t) * (ramp(t, 1.5, 2.0) - ramp(t, 3.4, 3.9));
  const rw: V3 = [mx.x + 0.14, 0.845, mx.z - 0.13];
  const dirL = norm([0.08, -0.55, 1]);
  const dirR = norm([-0.12, -0.6, 1]);
  const left: HandRig = { wrist: lw, prefer: [{ hand: [1, 0, 0], world: dirL, weight: 0.4 }, { hand: [0, 1, 0], world: norm([0.15, -1, -0.3]), weight: 0.3 }], curl: 0.45, pinch: 0.3 };
  const right: HandRig = { wrist: rw, prefer: [{ hand: [1, 0, 0], world: dirR, weight: 0.4 }, { hand: [0, 1, 0], world: norm([-0.35 + knob, -0.9, -0.2]), weight: 0.3 }], curl: 0.55, pinch: 0.85 };
  const up = ramp(t, 2.6, 3.2) * (1 - ramp(t, 4.3, 4.9));
  const look = mix3([mx.x, 0.8, mx.z - 0.05], [mx.x + 1.2, 1.25, mx.z + 3.2], up);
  return withIdle({ ...base, lean: (base.lean ?? 0) + 0.12 - 0.06 * up, look, reach: 0.4, hands: [left, right] }, t, 1.7);
}

// ===================================================================================== Jonas

const JC = SET.jcase;
/** the lid's hinge (on the case's far side from Jonas, towards the camera): a line along x */
const HINGE: V3 = [JC.x, JC.height - JC.lid, JC.z + JC.depth / 2];
export const JONAS_T = { reach0: 0.25, reach1: 0.95, close0: 1.0, close1: 2.45, press1: 2.85, down0: 2.85, down1: 3.6, flipL: 3.85, flipR: 4.35, up0: 4.75, up1: 5.6 };
const LID_OPEN = (65 * Math.PI) / 180;
/** the lid's angle (rad, 0 = closed): opened about the hinge, its free edge up and over towards Jonas' side */
export const lidAngle = (t: number) => LID_OPEN * (1 - ramp(t, JONAS_T.close0, JONAS_T.close1));
/** a point of the lid (lid frame: x across, y up from its bottom face, z from the hinge towards Jonas) at angle φ */
export function lidPoint(phi: number, p: V3): V3 {
  // closed, the lid runs from the hinge towards -z (Jonas' side); opening turns it about +x
  const y = p[1] * Math.cos(phi) + p[2] * Math.sin(phi);
  const z = p[1] * Math.sin(phi) - p[2] * Math.cos(phi);
  return [HINGE[0] + p[0], HINGE[1] + y, HINGE[2] + z];
}
export const HINGE_POINT = HINGE;
/** the latches on Jonas' side (x offsets) and how far each is flipped (0 open … 1 closed) */
export const LATCHES = { x: [-0.24, 0.24], y: JC.height - JC.lid, z: JC.z - JC.depth / 2 };
export const latchClosed = (t: number, i: number) => ramp(t, i ? JONAS_T.flipR - 0.15 : JONAS_T.flipL - 0.15, i ? JONAS_T.flipR + 0.15 : JONAS_T.flipL + 0.15);

/** Jonas closing a flight case: reaches for the open lid, pulls it over and down, presses it, closes both latches, stands up */
export function jonasRig(t: number): Rig {
  const T = JONAS_T;
  const { pos, yaw } = SET.jonas;
  const phi = lidAngle(t);
  // he goes down with the lid (it ends at his hip height), lower still for the latches, then up
  const withLid = 0.45 * (1 - phi / LID_OPEN) * ramp(t, T.close0, T.close0 + 0.3);
  const down = Math.max(withLid, 0.8 * ramp(t, T.down0, T.down1)) * (1 - ramp(t, T.up0, T.up1));
  const st = down > 0.01 ? squat(JONAS, pos, yaw, down) : stand(JONAS, pos, yaw, { width: 0.34, stagger: 0.06 });
  const reach = ramp(t, T.reach0, T.reach1) * (1 - ramp(t, T.down0, T.down1));
  // on the lid: its free edge's top, a hand at each side, fingers over the edge, palm on the lid
  // (his right is -x: he faces +z)
  const xr = yawFrame(yaw).r[0];
  const lidHand = (side: -1 | 1): HandRig => {
    const edge = lidPoint(phi, [side * xr * 0.27, JC.lid, JC.depth - 0.03]);
    const n = norm(sub(lidPoint(phi, [0, 1, 0]), lidPoint(phi, [0, 0, 0])));
    const toHinge = norm(sub(lidPoint(phi, [0, 0, 0]), lidPoint(phi, [0, 0, 1])));
    return freeHand(add(madd(edge, n, 0.025), scale(toHinge, -0.06)), toHinge, scale(n, -1), 0.35, 0.6, 0.6);
  };
  // at a latch: the hand just behind it, fingers on it; a flick closes it
  const latchHand = (i: 0 | 1): HandRig => {
    // the left hand (i 0) closes the latch on his left, the right hand the one on his right
    const p: V3 = [JC.x + (i ? 1 : -1) * xr * Math.abs(LATCHES.x[0]), LATCHES.y + 0.01, LATCHES.z - 0.06];
    const flick = Math.sin(Math.PI * clamp((t - (i ? T.flipR : T.flipL) + 0.25) / 0.5));
    return freeHand(add(p, [0, 0.04 + 0.02 * flick, -0.02]), [0, -0.35 - 0.3 * flick, 1], [0, -1, -0.2], 0.4 + 0.3 * flick, 0.5, 0.4);
  };
  const sp = st.pos, drop = st.drop ?? 0;
  const hangL = hangingHand(JONAS, sp, yaw, -1, drop);
  const hangR = hangingHand(JONAS, sp, yaw, 1, drop);
  const latchOn = ramp(t, T.down0 + 0.2, T.down1) * (1 - ramp(t, T.up0, T.up0 + 0.5));
  const hands: [HandRig, HandRig] = [
    blendHand(blendHand(hangL, lidHand(-1), reach), latchHand(0), latchOn),
    blendHand(blendHand(hangR, lidHand(1), reach), latchHand(1), latchOn),
  ];
  const lean = (st.lean ?? 0) + 0.5 * reach + 0.2 * latchOn;
  const look: V3 = latchOn > 0.5 ? [JC.x, LATCHES.y, LATCHES.z] : mix3([JC.x, 0.5, JC.z], lidPoint(phi, [0, JC.lid, JC.depth]), reach);
  return withIdle({ ...st, lean, look, reach: 1, hands }, t, 2.4);
}

// ===================================================================================== Mai and Ada

/** the rings they put into the crate (rigid, drawn 12 mm thick) */
export const STACK_RING = ringShape({ R: 0.125, loops: 6, r: 0.006, rows: 2, lead: 0.12, tail: 0.1, seed: 5 });
const CR = SET.crate;
/** the floor of the crate and what already lies in it */
const CRATE_FLOOR = 0.014;
const LAYER_UP = 0.045;
export const CRATE_RINGS: RingPose[] = [
  { c: [CR.x - 0.15, CRATE_FLOOR, CR.z + 0.01], q: quatYaw(2.2) },
  { c: [CR.x + 0.15, CRATE_FLOOR, CR.z - 0.01], q: quatYaw(-0.7) },
  { c: [CR.x - 0.14, CRATE_FLOOR + LAYER_UP, CR.z - 0.02], q: quatYaw(0.4) },
  { c: [CR.x + 0.13, CRATE_FLOOR + LAYER_UP, CR.z + 0.02], q: quatYaw(1.4) },
  { c: [CR.x - 0.13, CRATE_FLOOR + 2 * LAYER_UP, CR.z + 0.01], q: quatYaw(-2.0) },
];

interface Stacker {
  spec: PersonSpec;
  pos: [number, number];
  yaw: number;
  side: -1 | 1;
  /** the ring on the floor (centre, the tie's direction from it) and where it goes in the crate */
  from: V3;
  fromYaw: number;
  to: V3;
  toYaw: number;
  /** when the cycle starts */
  t0: number;
}

/** the ring's tie (the grip) in the world for a ring pose */
const tieOf = (p: RingPose): V3 => add(p.c, rot(p.q, STACK_RING.tie.c));
/** a ring pose lying flat with its tie towards `yaw` (0: tie towards +z) */
const flat = (c: V3, yaw: number): RingPose => ({ c, q: quatYaw(yaw) });

const MAI_S: Stacker = {
  spec: MAI, pos: SET.mai.pos, yaw: SET.mai.yaw, side: 1,
  from: [CR.x - 0.41, 0, CR.z + 0.39], fromYaw: Math.PI + 0.35,
  to: [CR.x - 0.13, CRATE_FLOOR + LAYER_UP * 3, CR.z + 0.02], toYaw: -Math.PI / 2 - 0.2,
  t0: 0.0,
};
const ADA_S: Stacker = {
  spec: ADA, pos: SET.ada.pos, yaw: SET.ada.yaw, side: -1,
  from: [CR.x + 0.43, 0, CR.z + 0.39], fromYaw: Math.PI - 0.5,
  to: [CR.x + 0.14, CRATE_FLOOR + LAYER_UP * 2, CR.z - 0.01], toYaw: Math.PI / 2 + 0.25,
  t0: 1.5,
};
/** the beats of one cycle (s after t0) */
export const STACK_T = { down0: 0.2, grip: 1.15, up0: 1.3, up1: 2.25, over: 2.85, lay: 3.65, let: 3.85, back0: 3.9, back1: 4.7 };

/** the carried ring at time t (rigid): on the floor, lifted by its tie (hanging), laid flat into the crate */
function stackRing(S: Stacker, t: number): RingPose {
  const T = STACK_T, u = t - S.t0;
  const rest = flat(S.from, S.fromYaw), done = flat(S.to, S.toYaw);
  if (u < T.grip) return rest;
  if (u >= T.lay) return done;
  const hand = stackHand(S, t);
  const tieDir0 = rot(rest.q, [0, 0, 1]);
  // hanging from the tie: the centre straight below it
  const qHang = quatMul(quatFromTo(scale(tieDir0, -1), DOWN), rest.q);
  const lift = ramp(u, T.up0, T.up1), layIn = ramp(u, T.over, T.lay);
  let q = slerp(rest.q, qHang, lift);
  q = slerp(q, done.q, layIn);
  return { c: sub(hand, rot(q, STACK_RING.tie.c)), q };
}

/** the grip (the ring's tie) along the cycle: down to the floor ring, up, over the crate, down into it */
function stackHand(S: Stacker, t: number): V3 {
  const T = STACK_T, u = t - S.t0;
  const f = yawFrame(S.yaw);
  const g0 = tieOf(flat(S.from, S.fromYaw));
  const g3 = tieOf(flat(S.to, S.toYaw));
  const g1: V3 = add(add([S.pos[0], 0.78, S.pos[1]], scale(f.f, 0.3)), scale(f.r, S.side * 0.22));
  const g2: V3 = [g3[0], 0.62, g3[2]];
  if (u < T.up0) return g0;
  if (u < T.up1) return mix3(g0, g1, ramp(u, T.up0, T.up1));
  if (u < T.over) return mix3(g1, g2, ramp(u, T.up1, T.over));
  return mix3(g2, g3, ramp(u, T.over, T.lay));
}

/** Mai (left of the crate) or Ada (right of it): squat, take a ring by its tie, stand, lay it into the crate */
function stackRig(S: Stacker, t: number, seed: number): Rig {
  const T = STACK_T, u = t - S.t0;
  const f = yawFrame(S.yaw);
  const down = ramp(u, T.down0, T.grip - 0.15) * (1 - ramp(u, T.up0, T.up1)) + 0.75 * ramp(u, T.over - 0.2, T.lay - 0.2) * (1 - ramp(u, T.back0, T.back1));
  const st = squat(S.spec, S.pos, S.yaw, 0.85 * down);
  const g = stackHand(S, t);
  const ring = stackRing(S, t);
  const tangent = norm(rot(ring.q, [1, 0, 0]));
  const holding = u >= T.grip - 0.05 && u < T.let;
  const working = u > T.down0 && u < T.back1;
  const hang = hangingHand(S.spec, st.pos, S.yaw, S.side, st.drop ?? 0);
  let hand: HandRig;
  if (!working) hand = hang;
  else {
    // the fist round the ring's tie, from above (palm down onto it); open while it reaches and lets go
    const open = 1 - ramp(u, T.grip - 0.25, T.grip) + ramp(u, T.lay, T.let + 0.1);
    const toward = ramp(u, T.down0 + 0.25, T.grip - 0.1) * (1 - ramp(u, T.let, T.back1));
    const gripRig: HandRig = { grip: gripFrame(g, tangent, UP), hold: 'fist', radius: 0.018, free: 0.7, open: clamp(open) };
    hand = toward > 0.98 || holding ? gripRig : { ...gripRig, grip: { p: mix3(hang.wrist as V3, g, toward), q: gripRig.grip!.q }, open: 1 };
  }
  const other = hangingHand(S.spec, st.pos, S.yaw, (-S.side) as -1 | 1, st.drop ?? 0);
  const hands: [HandRig, HandRig] = S.side > 0 ? [other, hand] : [hand, other];
  const pick = ramp(u, T.down0, T.grip - 0.15) * (1 - ramp(u, T.up0, T.up1));
  const lean = (st.lean ?? 0) + 0.45 * pick + 0.25 * ramp(u, T.over - 0.2, T.lay - 0.2) * (1 - ramp(u, T.back0, T.back1));
  const twist = S.side * 0.25 * (ramp(u, T.down0, T.grip) * (1 - ramp(u, T.up1, T.over)));
  const look: V3 = u < T.up1 ? g : u < T.back1 ? mix3(g, [CR.x, 0.1, CR.z], 0.3) : [CR.x + f.f[0] * 0.2, 0.2, CR.z];
  return withIdle({ ...st, lean, twist, look, reach: 1, hands }, t, seed);
}

export const maiRig = (t: number) => stackRig(MAI_S, t, 0.9);
export const adaRig = (t: number) => stackRig(ADA_S, t, 2.7);
export const maiRing = (t: number) => stackRing(MAI_S, t);
export const adaRing = (t: number) => stackRing(ADA_S, t);

// ===================================================================================== all of them

/** every person in the title with their rig (RigTrack in the part, the checks in Node) */
export const CREW = [
  { spec: NOOR, rig: noorRig },
  { spec: KOFI, rig: kofiRig },
  { spec: ILSE, rig: ilseRig },
  { spec: JONAS, rig: jonasRig },
  { spec: MAI, rig: maiRig },
  { spec: ADA, rig: adaRig },
  { spec: ROBIN, rig: robinRig },
];

/** a kinematic polyline resampled every ds (m), for CableMesh */
export function resample(P: V3[], ds: number): V3[] {
  const out: V3[] = [P[0]];
  let need = ds, prev = P[0];
  for (let i = 1; i < P.length; i++) {
    let seg = len(sub(P[i], prev));
    while (seg >= need) {
      const p = mix3(prev, P[i], need / seg);
      out.push(p);
      prev = p;
      seg = len(sub(P[i], prev));
      need = ds;
    }
    need -= seg;
    prev = P[i];
  }
  if (len(sub(out[out.length - 1], P[P.length - 1])) > ds * 0.3) out.push(P[P.length - 1]);
  return out;
}
