// Stage 6 "Dicke Kabel" (KONZEPT 6, part p6-thick): the simulated thick cables. Rough animation
// (animatic): the people's hands are simple keyframes (shots/p6-thick-rig.ts poses them on exactly
// the frames used here); the recorded movements (mocap shots p6.*) replace them later. The cables
// are the presets of sim/cables.ts, unchanged (both are estimates from data sheets; their sanity
// numbers are in the report of this part):
//   POWER_5G2_5  H07RN-F 5G2.5, Ø 16 mm, 0.32 kg/m, EI 0.015 N m², CEE 16 A plugs (red, 400 V)
//   POWER_5G16   H07RN-F 5G16, Ø 30 mm, 1.38 kg/m, EI 0.4 N m², CEE 63 A plugs (red)
//
// Shots (what is simulated and what is guided, KONZEPT "Pseudo-Simulation"):
//   p6-coil     Mai coils the 15 m 5G2.5 over-under, the first three loops (ü u ü): her left fist
//               holds the plug end and the loops (a bundle that takes each loop where it lies), her
//               right fist slides out along the cable (a loose pinch: the cable runs through it,
//               pulled up from the floor), closes, and brings the loop back to the fist; a soft
//               guide keeps the loop round while it is brought back (the hand shapes it) and fades
//               out after the hand-over; for "unter" the right hand turns over. Simulated: the
//               cable, its weight and stiffness, the loops hanging, the cable to the floor and the
//               15 m lying on the floor being pulled up.
//   p6-ring     the finished 15 m ring (the ring factory, deploy-ring.ts: 11 loops over-under of
//               1.3 m, pressed, remembering it) in Mai's left fist: she lifts it and carries it close
//               to the body; the loops swing and settle (simulated).
//   p6-fail     the 25 m 5G16: Mai picks up its end with both fists, stands up and tries to bring
//               the cable round into a loop in her hands; she lets go with the right: the loop
//               springs open (simulated: stiffness, strand friction, weight); she puts the end down.
//               6 m are simulated, the rest lies still on the floor (the scene draws it on).
//   p6-eights   the 25 m 5G16 laid on the floor in figure eights (one loop clockwise, one
//               counter-clockwise, Ø 70 cm): three eights lie already, Mai lays the fourth and fifth
//               and the end. Guided: where a piece of cable comes to lie on the floor (horizontal
//               guides that switch on as it reaches the floor and off 1.5 s later), and the supply
//               far away, which slides in along the floor as fast as cable is laid (a conveyor of
//               guides). Simulated: everything else: the cable between the floor and her fist and
//               from her fist to the supply, its twist, how the stack settles under its own weight
//               (heights come from contacts), the stripe.
//   p6-unroll   the stack from the end of p6-eights, straps off: Mai takes the end on top and walks
//               away with it; the cable comes off the top one loop after the other (simulated).
//
// Coordinates: y up, metres. Mai stands at the origin facing -z (yaw 0, her right +x).

import { Bundle, Frame, POWER_5G16, POWER_5G2_5, Pinch, Rod, RodState, TAU, V3, buildCable, frameTrack, gripFrame, quatConj, quatFromAxisAngle, quatMul, quatRotate } from '../sim';
import type { ShotDef } from './types';
import { RingSpec, placeRing, ringRod, windRing } from './deploy-ring';
import { roundLoop } from './eight';

// ------------------------------------------------------------------------------------- vectors

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => mul(a, 1 / (len(a) || 1));
const mix = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** minimum-jerk ease 0 → 1 */
export const ease = (u: number) => {
  const x = clamp01(u);
  return x * x * x * (10 - 15 * x + 6 * x * x);
};
const ramp = (t: number, a: number, b: number) => ease((t - a) / Math.max(1e-6, b - a));
const UP: V3 = [0, 1, 0];

/** keyframed point: [t, p] pairs, eased between them */
export function pathKeys(k: [number, V3][]): (t: number) => V3 {
  return (t) => {
    if (t <= k[0][0]) return k[0][1];
    for (let i = 1; i < k.length; i++) if (t < k[i][0]) return mix(k[i - 1][1], k[i][1], ease((t - k[i - 1][0]) / (k[i][0] - k[i - 1][0])));
    return k[k.length - 1][1];
  };
}

/** dense points along a polyline at spacing h (keeps the corners) */
function densify(P: V3[], h: number): V3[] {
  const out: V3[] = [P[0]];
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i], d = len(sub(b, a)), k = Math.max(1, Math.round(d / h));
    for (let j = 1; j <= k; j++) out.push(mix(a, b, j / k));
  }
  return out;
}

/** a few passes of neighbour averaging (rounds corners), keeping the points `keep` says */
function relax(P: V3[], passes: number, keep: (i: number) => boolean = () => false): V3[] {
  let A = P.map((p) => [...p] as V3);
  for (let r = 0; r < passes; r++) {
    const B = A.map((p) => [...p] as V3);
    for (let i = 1; i < A.length - 1; i++) if (!keep(i)) B[i] = mix(A[i], mul(add(A[i - 1], A[i + 1]), 0.5), 0.5);
    A = B;
  }
  return A;
}

/** arc length of a polyline up to each point */
function arcOf(P: V3[]): number[] {
  const s = [0];
  for (let i = 1; i < P.length; i++) s.push(s[i - 1] + len(sub(P[i], P[i - 1])));
  return s;
}

const node = (rod: Rod, i: number): V3 => [rod.x[3 * i], rod.x[3 * i + 1], rod.x[3 * i + 2]];

// ===================================================================================== eights

const R16 = POWER_5G16.od / 2;

/**
 * The figure-eight stack of the 25 m 5G16 (KONZEPT 6.2: "Achten ≥ 60 cm"). Two round lobes of
 * radius R (Ø 70 cm: the bend radius 35 cm is above 10 × Ø = 30 cm) whose centres are D = R·√2
 * apart from the middle, joined by straight pieces that cross in the middle at 90°. Laid in the
 * order: from the middle out to the right, round the right lobe clockwise (seen from above), back
 * through the middle, round the left lobe counter-clockwise, back into the middle, and so on.
 * The eight lies across in front of Mai, its long side from her left to her right. Each eight is a
 * little offset and turned against the one below (no stack is laid exactly on top of itself).
 * Plane coordinates (X, F): X to her right, F forward (away from her); world x = C.x + X, z = C.z - F.
 */
export const STACK = (() => {
  const R = 0.35;
  const D = R * Math.SQRT2;
  const alpha = Math.asin(R / D);
  const ell = Math.sqrt(D * D - R * R);
  const per = 2 * ell * 2 + 2 * R * (Math.PI + 2 * alpha);
  return {
    C: [0, 0, -0.95] as V3,
    R,
    D,
    alpha,
    /** cable per eight [m] */
    per,
    /** the start end (the CEE plug) lies under the stack, along the first straight piece: plug tip to the middle [m] */
    lead: 0.6,
    /** the cable [m] */
    total: 25,
    /** eights lying when p6-eights starts; laid in the shot */
    before: 3,
    laid: 2,
  };
})();

/** one eight in the plane, from the middle (s = 0) to the middle (s = per), with a small offset and turn per eight */
function eightPoint(s: number, k: number): { X: number; F: number; tX: number; tF: number; lobe: 0 | 1 | -1 } {
  const { R, D, alpha } = STACK;
  const ell = Math.sqrt(D * D - R * R);
  const arc = R * (Math.PI + 2 * alpha);
  const ca = Math.cos(alpha), sa = Math.sin(alpha);
  let X = 0, F = 0, tX = 0, tF = 0, lobe: 0 | 1 | -1 = 0;
  if (s < ell) {
    // middle → right lobe, up-right
    X = s * ca; F = s * sa; tX = ca; tF = sa;
  } else if (s < ell + arc) {
    // right lobe clockwise from 90° + alpha down to -(90° + alpha)
    const th = Math.PI / 2 + alpha - (s - ell) / R;
    X = D + R * Math.cos(th); F = R * Math.sin(th); tX = Math.sin(th); tF = -Math.cos(th);
    lobe = 1;
  } else if (s < 3 * ell + arc) {
    // right lobe → middle → left lobe, up-left
    const u = s - ell - arc;
    X = D - R * sa - u * ca; F = -R * ca + u * sa; tX = -ca; tF = sa;
  } else if (s < 3 * ell + 2 * arc) {
    // left lobe counter-clockwise from 90° - alpha up to 270° + alpha
    const th = Math.PI / 2 - alpha + (s - 3 * ell - arc) / R;
    X = -D + R * Math.cos(th); F = R * Math.sin(th); tX = -Math.sin(th); tF = Math.cos(th);
    lobe = -1;
  } else {
    // left lobe → middle, up-right
    const u = s - 3 * ell - 2 * arc;
    X = -D + R * sa + u * ca; F = -R * ca + u * sa; tX = ca; tF = sa;
  }
  // each eight a little off and turned (deterministic)
  const dx = 0.012 * Math.sin(2.1 * k + 0.4), df = 0.016 * Math.sin(1.7 * k + 1.1), rot = 0.035 * Math.sin(1.3 * k + 0.2);
  const c = Math.cos(rot), sn = Math.sin(rot);
  return { X: c * X - sn * F + dx, F: sn * X + c * F + df, tX: c * tX - sn * tF, tF: sn * tX + c * tF, lobe };
}

/** the stack's path in the plane at material coordinate s (0 = the start plug's tip) */
export function stackPlane(s: number): { X: number; F: number; tX: number; tF: number; eight: number; lobe: 0 | 1 | -1; u: number } {
  const { lead, per, alpha } = STACK;
  if (EIGHTS_CFG.rings && s >= lead) {
    // the control (experiments only): the same cable laid in circles, always clockwise
    const R = STACK.R + 0.1, L = 2 * Math.PI * R;
    const k = Math.floor((s - lead) / L);
    const th = Math.PI - (s - lead - k * L) / R;
    return { X: R * Math.cos(th) + R, F: R * Math.sin(th), tX: Math.sin(th), tF: -Math.cos(th), eight: k, lobe: 1, u: 0 };
  }
  if (s < lead) {
    const ca = Math.cos(alpha), sa = Math.sin(alpha);
    const e = eightPoint(0, 0);
    const d = lead - s;
    return { X: e.X - d * ca, F: e.F - d * sa, tX: ca, tF: sa, eight: -1, lobe: 0, u: 0 };
  }
  const k = Math.floor((s - lead) / per);
  const u = s - lead - k * per;
  const e = eightPoint(u, k);
  return { ...e, eight: k, u: u / per };
}

/** plane → world (on the floor, at height y) */
export const stackWorld = (X: number, F: number, y = 0): V3 => [STACK.C[0] + X, y, STACK.C[2] - F];
/** the material coordinate where eight k starts (the middle) */
export const eightStart = (k: number) => STACK.lead + k * STACK.per;
/** a lobe's centre in the world (k: eight, side 1 right / -1 left), for the arrows */
export function lobeCentre(k: number, side: 1 | -1): V3 {
  // the lobe's centre: the mean of its arc
  let X = 0, F = 0;
  const s0 = eightStart(k);
  for (let i = 0; i < 64; i++) {
    const p = stackPlane(s0 + ((i + 0.5) / 64) * STACK.per);
    if (p.lobe === side) {
      X += p.X;
      F += p.F;
    }
  }
  const m = 64 * (STACK.R * (Math.PI + 2 * STACK.alpha)) / STACK.per;
  return stackWorld(X / m, F / m, 0);
}

/**
 * Heights of a cable laid along a path, in order, each piece resting on what is already there
 * (2r apart from the strands below; a strand rising over another ramps up at most `slope`).
 */
function dropHeights(P: [number, number][], r: number, h: number, slope = 0.45): number[] {
  const y = new Array<number>(P.length).fill(r);
  const cell = 2 * r;
  const grid = new Map<string, number[]>();
  const key = (x: number, z: number) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  const skip = Math.ceil((5 * r) / h);
  for (let i = 0; i < P.length; i++) {
    const [x, z] = P[i];
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    let top = r;
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++) {
        const list = grid.get(`${cx + a},${cz + b}`);
        if (!list) continue;
        for (const j of list) {
          if (j > i - skip) continue;
          const d = Math.hypot(P[j][0] - x, P[j][1] - z);
          if (d < 2 * r) top = Math.max(top, y[j] + Math.sqrt(4 * r * r - d * d) * 0.97);
        }
      }
    y[i] = top;
    const k = key(x, z);
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  }
  // ramps: no strand climbs faster than `slope`
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < y.length; i++) y[i] = Math.max(y[i], y[i - 1] - slope * h);
    for (let i = y.length - 2; i >= 0; i--) y[i] = Math.max(y[i], y[i + 1] - slope * h);
  }
  return y;
}

/** p6-eights' beats [s] */
export const EIGHTS_T = {
  /** Mai starts laying (eight 4, the first one she lays in the shot) */
  start: 0.8,
  /** laying speed [m/s] */
  v: 0.62,
  /** a laid piece is guided onto its place for this long, then it is on its own */
  hold: 1.5,
  end: 19.5,
};
/** where the laying is (material coordinate under her fist's lower end: the cable reaches the floor here) at shot time t */
export function depositAt(t: number): number {
  const { start, v } = EIGHTS_T;
  const s0 = eightStart(STACK.before);
  const sEnd = STACK.total - POWER_5G16.plug!.length - 0.02;
  // eased start (0.5 s), constant speed, eased stop at the end of the cable
  const ta = 0.5;
  const u = t - start;
  let s = u <= 0 ? 0 : u < ta ? (v * u * u) / (2 * ta) : v * (u - ta / 2);
  s += s0;
  // the last metre: slow down onto the end
  const room = sEnd - s0;
  const sl = s - s0;
  if (sl > room - 0.6) s = s0 + room - 0.6 * Math.exp(-(sl - (room - 0.6)) / 0.6);
  return s;
}
/** the time the laying reaches material s (inverse of depositAt, by bisection) */
export function depositTime(s: number): number {
  let a = 0, b = 60;
  for (let i = 0; i < 50; i++) {
    const m = (a + b) / 2;
    if (depositAt(m) < s) a = m;
    else b = m;
  }
  return b;
}
/** cable laid per metre of path beyond the first eights: 1 / (1 - EIGHTS_CLIMB) */
const EIGHTS_CLIMB = 0.04;
/** the pre-roll of p6-eights starts at this shot time [s] */
const EIGHTS_PRE = -1.5;
/** settings the experiments vary (scratchpad p6/exp-*.mjs); the shots use them as they are */
export const EIGHTS_CFG = { laid: 2e-4, conv: 2e-4, convOn: true, rings: false };
/** her fist runs this far ahead of the laying point (material) and this high */
const FIST_AHEAD = 0.3, FIST_Y = 0.42;
/** her fist does not go over the far half of the stack (she stands at the near side): beyond this (plane F) it follows only a fifth as far */
const FIST_FAR = 0.04;
/** the supply comes from far in front of her, on the right, along the floor: where it enters (plane), its direction (world) */
const FEED_X = 1.05, FEED_F = 1.35;
const FEED_DIR: V3 = [0, 0, -1];

/** Mai's right fist while laying (the sim's pinch frame; the part poses her hand on it) */
export function eightsFist(t: number): Frame {
  const s = depositAt(t) + FIST_AHEAD;
  const p = stackPlane(s);
  const F = p.F > FIST_FAR ? FIST_FAR + 0.2 * (p.F - FIST_FAR) : p.F;
  const at = stackWorld(p.X, F, FIST_Y);
  // the cable runs through it along the path; the palm on top of it
  return gripFrame(at, [p.tX, 0, -p.tF], UP);
}

interface EightsBuilt {
  rod: Rod;
  pin: Pinch;
  /** the conveyor's first material coordinate at t = 0 */
  sConv0: number;
  /** the node positions as built */
  x0: Float64Array;
  /** material = plane path parameter + delta beyond the laid part (the laid strands climb over each other: a little more cable than path) */
  delta: number;
  /** when her fist let go of the end (shot time) */
  endAt: { t: number };
  /** the conveyor now: material at the feed point (only grows: the supply is pulled in, never pushed back) */
  conv: { s: number; v: number };
  /** sim in the loop, before each frame: her fist pulls the supply in as far as it needs */
  script: (rod: Rod, t: number) => void;
  /** nodes: the plug's end of the start, the cable proper [first, last] */
  cable: [number, number];
}

/** heights of the whole stack path, sampled every 1 cm (shared by the build and the checks) */
let heightsCache: { h: number; y: number[] } | null = null;
function stackHeights() {
  if (heightsCache) return heightsCache;
  const h = 0.01;
  const n = Math.ceil(STACK.total / h);
  const P: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const p = stackPlane(i * h);
    const w = stackWorld(p.X, p.F);
    P.push([w[0], w[2]]);
  }
  heightsCache = { h, y: dropHeights(P, R16, h) };
  return heightsCache;
}
const stackY = (s: number) => {
  const { h, y } = stackHeights();
  const i = Math.max(0, Math.min(y.length - 2, Math.floor(s / h)));
  const u = s / h - i;
  return y[i] + (y[i + 1] - y[i]) * u;
};
/** the laid stack at material s (world, with the height it gets from the strands below) */
export const stackPoint = (s: number): V3 => {
  const p = stackPlane(s);
  return stackWorld(p.X, p.F, stackY(s));
};

/** the cable as it lies when p6-eights starts: three eights, up to her fist, down and over to the supply */
function buildEights(): EightsBuilt {
  const h = 0.01;
  const s0 = depositAt(0);
  const pieces: V3[] = [];
  for (let s = 0; s <= s0 + 1e-9; s += h) pieces.push(stackPoint(s));
  // up into her fist: the cable leaves the floor at s0 and rises to the fist
  const fist = eightsFist(0).p;
  const fd = stackPlane(s0 + FIST_AHEAD);
  const tan: V3 = [fd.tX, 0, -fd.tF];
  const rise: V3[] = [];
  const a = pieces[pieces.length - 1];
  for (let k = 1; k <= 30; k++) {
    const u = k / 30;
    const q = mix(a, fist, u);
    q[1] = a[1] + (fist[1] - a[1]) * Math.sin((u * Math.PI) / 2);
    rise.push(q);
  }
  // beyond the fist: on along the path a little, down to the floor beyond the right lobe's far side,
  // along the floor to where the supply comes in
  const after = add(fist, mul(tan, 0.12));
  const down = stackWorld(0.75, 0.62, R16);
  const feed = stackWorld(FEED_X, FEED_F, R16);
  const mid = stackWorld(1.0, 0.95, R16);
  const over = densify([after, add(mix(after, down, 0.5), [0, 0.05, 0]), down, mid, feed], h);
  // the supply: straight on along the floor to the end
  const P0 = [...pieces, ...rise, ...over];
  const sFeed = arcOf(P0)[P0.length - 1];
  const rest = STACK.total - sFeed;
  const dir: V3 = FEED_DIR;
  const supply: V3[] = [];
  for (let s = h; s <= rest + 1e-9; s += h) supply.push(add(feed, mul(dir, s)));
  let P = [...P0, ...supply];
  const iA = pieces.length - 1, iF = pieces.length + rise.length - 1;
  // round the corners between the pieces (keep the laid part and the supply)
  P = relax(P, 10, (i) => i < iA - 10 || i > P0.length + 10 || Math.abs(i - iF) < 2);
  const built = buildCable(POWER_5G16, P, { plugs: 'both', up: UP });
  const rod = built.rod;
  // the pre-roll starts here (grips made now are closed from its first step)
  rod.time = EIGHTS_PRE;
  // the start end lies under the stack: held where it lies (the weight of five eights on it)
  const lock = rod.segmentAt(0.45);
  const lockFrame: Frame = { p: [0, 0, 0], q: [0, 0, 0, 1] };
  rod.addGrip({ nodes: [0, lock + 1], keepShape: true, frame: () => lockFrame, blend: 0.001 });
  // her fist: a loose grip the cable runs through
  const pin = rod.pinch({ frame: eightsFist, mode: 'loose', friction: 18, pad: 0.03, blend: 0.01, lostDistance: 0.14, lostAngle: 1.5, maxGripDistance: 0.05 });
  const sConv0 = rod.closestPoint(feed).s;
  const conv = { s: sConv0, v: 0 };
  const endAt = { t: Infinity };
  // the free cable from her fist to the feed point is at least 1.3 × their distance + 0.6 m: when
  // the fist goes away from the supply it pulls cable in; coming back it leaves slack on the floor
  // (pulled in smoothly: at most 1.5 m/s, accelerating at most 3 m/s²; not during the pre-roll)
  let last = -Infinity;
  let open = false;
  const script = (_r: Rod, t: number) => {
    // the end comes (the supply's far end is free, or the end is at her fist): her fist opens; the
    // last metre is laid by the guides, her hand goes with the end and puts it down
    if (!open && (pin.s > STACK.total - 0.55 || conv.s > STACK.total - 0.2)) {
      pin.release(0.25);
      open = true;
      endAt.t = t;
    }
    const d = len(sub(eightsFist(t).p, feed));
    const dt = Math.min(1 / 60, Math.max(0, t - last));
    last = t;
    if (t < 0) return;
    const want = Math.min(1.5, Math.max(0, 3 * (pin.s + 1.3 * d + 0.6 - conv.s)));
    conv.v += Math.max(-3 * dt, Math.min(3 * dt, want - conv.v));
    conv.s += Math.max(0, conv.v) * dt;
  };
  const delta = rod.closestPoint(stackPoint(s0), s0 - 0.5, s0 + 2).s - s0;
  return { rod, pin, sConv0, conv, script, cable: built.cable, x0: Float64Array.from(rod.x), delta, endAt };
}

/**
 * The guides of the laying: where the cable reaches the floor (material ≤ depositAt(t)) it is led
 * sideways onto its place in the stack (its height is left to gravity and contacts), from the moment
 * it gets there for EIGHTS_T.hold seconds; and the supply beyond the conveyor point slides in along
 * the floor as fast as cable is laid.
 */
function eightsGuides(rod: Rod, b: EightsBuilt, preRoll: boolean): number[] {
  const s0 = depositAt(0);
  const S = rod.sNode;
  /**
   * a node's place on the stack path (plane parameter): laid cable climbs over the strands below,
   * so it needs a little more cable than path (4 %); without that allowance the laying would pull
   * the fresh strands taut and drag the stack along
   */
  const sOf = (i: number) => {
    const p = S[Math.min(i, S.length - 1)] - b.delta;
    return p <= s0 ? p : s0 + (p - s0) * (1 - EIGHTS_CLIMB);
  };
  const tOf = new Float64Array(rod.n).map((_, i) => (sOf(i) <= s0 ? -10 : depositTime(sOf(i))));
  const laid = rod.addGuide({
    nodes: [rod.segmentAt(0.5), rod.n - 1],
    compliance: EIGHTS_CFG.laid,
    target: (i, t) => {
      const s = sOf(i);
      const td = tOf[i];
      // laid pieces: while the pre-roll settles everything, and for `hold` seconds after they reach the floor
      const on = s <= s0 ? (preRoll ? 1 : clamp01((EIGHTS_T.hold - t) / 0.6)) : t >= td ? 1 - clamp01((t - td - EIGHTS_T.hold) / 0.6) : 0;
      if (on <= 1e-3) return null;
      const q: V3 = s <= s0 ? [b.x0[3 * i], b.x0[3 * i + 1], b.x0[3 * i + 2]] : stackPoint(s), x = node(rod, i);
      // sideways only (the height comes from the strands below), eased in as it lands
      const w = on * (s <= s0 ? 1 : clamp01((t - td) / 0.35));
      return [x[0] + (q[0] - x[0]) * w, x[1], x[2] + (q[2] - x[2]) * w];
    },
  });
  // the conveyor: the supply beyond sConv(t) lies on its straight line and slides in
  // (each node of the supply slides along the line from where it lay at the start)
  const x0 = b.x0;
  const conv = rod.addGuide({
    nodes: [rod.segmentAt(b.sConv0), rod.n - 1],
    compliance: EIGHTS_CFG.conv,
    target: (i, t) => {
      const s = S[Math.min(i, S.length - 1)], sc = b.conv.s;
      void t;
      if (!EIGHTS_CFG.convOn || s < sc + 0.1) return null;
      const d = sc - b.sConv0;
      // (a soft edge: the nodes next to the free part are led only a little)
      const w = clamp01((s - sc - 0.1) / 0.6);
      const x = node(rod, i);
      const q: V3 = [x0[3 * i] - d * FEED_DIR[0], x0[3 * i + 1], x0[3 * i + 2] - d * FEED_DIR[2]];
      return [x[0] + (q[0] - x[0]) * w, x[1] + (q[1] - x[1]) * w, x[2] + (q[2] - x[2]) * w];
    },
  });
  return [laid, conv];
}

/** the eights' measurements: twist of the cable from the start to the laying point, and in the free part up to the supply */
function eightsTracks(b: EightsBuilt) {
  return {
    iC0: () => b.cable[0],
    iC1: () => b.cable[1],
    /** material coordinate where the cable reaches the floor (laying point) */
    sDep: (_r: Rod, t: number) => depositAt(t) + b.delta,
    /** twist from the start end (under the stack) to the laying point [turns] */
    twStack: (r: Rod, t: number) => r.twistTurns(r.segmentAt(0.45), r.segmentAt(depositAt(t) + b.delta)),
    /** twist from the laying point through her fist to the supply on the floor [turns] */
    twFree: (r: Rod, t: number) => r.twistTurns(r.segmentAt(depositAt(t) + b.delta), Math.min(r.ns - 1, r.segmentAt(b.conv.s))),
    /** writhe of the same free part */
    wrFree: (r: Rod, t: number) => r.writhe(r.segmentAt(depositAt(t) + b.delta), Math.min(r.n - 1, r.segmentAt(b.conv.s) + 1)),
    /** material at the feed point */
    sConv: () => b.conv.s,
    /** her fist's material coordinate */
    sFist: () => b.pin.s,
    /** her fist: 0 open, 0.5 loose (the cable runs through), 1 held */
    grip: (_r: Rod, t: number) => b.pin.level(t),
    /** the highest point of the stack (m) */
    top: (r: Rod) => {
      let y = 0;
      const e = r.segmentAt(depositAt(0) + b.delta);
      for (let i = 0; i <= e; i++) y = Math.max(y, r.x[3 * i + 1]);
      return y + R16;
    },
  };
}

/** p6-eights: the run as the bake does it (script then step), up to time T; returns the rod and the build */
function runEights(T: number | null, onFrame?: (rod: Rod, t: number) => void) {
  const b = buildEights();
  const { rod } = b;
  // pre-roll (not recorded, from EIGHTS_PRE): the laid eights settle under their weight, held sideways
  const pre = eightsGuides(rod, b, true);
  for (let f = 0; f < 90; f++) {
    b.script(rod, rod.time);
    rod.step(1 / 60, POWER_5G16.substeps);
    (globalThis as { __p6diag?: (r: Rod) => void }).__p6diag?.(rod);
  }
  // the guides again, for the shot
  for (const id of pre) rod.removeGuide(id);
  rod.time = 0;
  // (the strands remember the shape it was laid in; resetting that memory here would let go of
  // the moments the strand friction carries and the stiff cable would jump)
  eightsGuides(rod, b, false);
  if (T !== null) {
    const F = Math.round(T * 60);
    for (let f = 0; f <= F; f++) {
      b.script(rod, rod.time);
      if (f > 0) rod.step(1 / 60, POWER_5G16.substeps);
      onFrame?.(rod, rod.time);
    }
  }
  return b;
}

export const eightsShot: ShotDef = {
  id: 'p6-eights',
  duration: EIGHTS_T.end,
  substeps: POWER_5G16.substeps,
  build() {
    const b = runEights(null);
    // her fist: the sim's pinch; after it has let go, with the cable's end (her hand puts it down)
    const fist = (r: Rod, t: number): Frame => {
      const f = b.pin.frame(t);
      if (t < b.endAt.t) return f;
      const sE = r.totalLength - 0.2;
      const p = r.pointAt(sE), d = r.tangentAt(sE);
      const u = clamp01((t - b.endAt.t) / 0.5);
      const lift = clamp01((t - b.endAt.t - 2.6) / 1.2);
      const at = add(mix(f.p, add(p, [0, R16 + 0.03, 0]), u), [0, 0.35 * ease(lift), 0]);
      return gripFrame(at, norm([d[0], 0, d[2]]), UP);
    };
    return {
      rod: b.rod,
      script: b.script,
      tracks: eightsTracks(b),
      vectors: { fist: frameTrack(fist) },
    };
  },
};

/**
 * The stack as p6-eights leaves it (the state at its end), for p6-unroll. Running p6-eights takes
 * minutes: in Node the result is kept in bakes/cache/p6-stack-<hash>.json (keyed by the source of
 * this module's functions); deterministic either way.
 */
export function stackState(): RodState {
  const pr = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown; cwd: () => string } }).process;
  const get = pr?.getBuiltinModule;
  const F64 = ['L', 'c', 'q', 'v', 'om', 'rest', 'restNat', 'restFric', 'alpha1', 'alpha2', 'alphaT'] as const;
  let file: string | null = null;
  let fs: typeof import('node:fs') | null = null;
  if (pr && get) {
    fs = get('node:fs') as typeof import('node:fs');
    const path = get('node:path') as typeof import('node:path');
    const crypto = get('node:crypto') as typeof import('node:crypto');
    const key = crypto
      .createHash('sha1')
      .update([runEights, buildEights, eightsGuides, depositAt, stackPlane, eightPoint, dropHeights, buildCable, eightsFist, JSON.stringify(STACK), JSON.stringify(EIGHTS_T), JSON.stringify(POWER_5G16), JSON.stringify(EIGHTS_CFG), FIST_AHEAD, FIST_Y, FIST_FAR, FEED_X, FEED_F, EIGHTS_CLIMB].map(String).join('\n'))
      .digest('hex')
      .slice(0, 16);
    file = path.join(pr.cwd(), 'bakes', 'cache', `p6-stack-${key}.json`);
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const k of F64) if (j[k]) j[k] = Float64Array.from(j[k]);
      return j as RodState;
    }
  }
  const b = runEights(EIGHTS_T.end);
  const st = b.rod.saveState();
  if (fs && file) {
    const out: Record<string, unknown> = { ...st };
    for (const k of F64) if (st[k]) out[k] = Array.from(st[k] as Float64Array);
    fs.mkdirSync(file.replace(/[/\\][^/\\]*$/, ''), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out));
  }
  return st;
}

// ======================================================================================= coil

const R25 = POWER_5G2_5.od / 2;

/**
 * p6-coil: where everything is. The loops hang below the left fist in planes facing N (forward, a
 * little to her right); E1 runs across them from where a loop leaves the fist to where it comes
 * back. Each new loop lies in front of the others (+N, 2.2 cm per loop). For big loops both arms
 * spread: while the right fist slides out, the left fist goes out to the left a little.
 */
export const COIL = (() => {
  const N: V3 = norm([Math.sin(0.26), 0, -Math.cos(0.26)]);
  const E1: V3 = norm([-N[2], 0, N[0]]);
  const F: V3 = [-0.33, 1.0, -0.24];
  return {
    N,
    E1,
    /** the left fist at rest (the strands' entry), and spread out */
    F,
    Fout: add(F, [-0.16, 0.03, 0.04]) as V3,
    /** the right fist slid out (far end of the slide) */
    out: [0.72, 0.9, -0.05] as V3,
    /** layer distance of the loops in the fist */
    pitch: 0.022,
    /** wanted cable per loop [m] (laid round: Ø 43 cm) */
    loop: 1.36,
    kinds: ['over', 'under', 'over'] as ('over' | 'under')[],
  };
})();

/** p6-coil's beats per loop k (shot time) */
export function coilBeat(k: number) {
  const t0 = 0.6 + 2.75 * k + (k >= 2 ? 0.2 : 0);
  const under = COIL.kinds[k] === 'under';
  return {
    /** the slide out starts */
    slide0: t0,
    slide1: t0 + 1.05,
    /** back to the fist */
    back0: t0 + 1.15,
    back1: t0 + (under ? 2.35 : 2.2),
    /** the fist takes the strand, the right fist loosens */
    give: t0 + (under ? 2.4 : 2.25),
    end: t0 + (under ? 2.95 : 2.75),
  };
}
export const COIL_T = { loops: COIL.kinds.length, end: coilBeat(COIL.kinds.length - 1).end + 1.4 };

/** the left fist (the bundle's frame): spreads out while the right fist slides out */
export function coilFist(t: number): Frame {
  let u = 0;
  for (let k = 0; k < COIL.kinds.length; k++) {
    const b = coilBeat(k);
    if (t >= b.slide0 - 0.1 && t < b.end) u = Math.max(u, ramp(t, b.slide0, b.slide1) * (1 - ramp(t, b.back0, b.back1)));
  }
  return { p: mix(COIL.F, COIL.Fout, u), q: gripFrame(COIL.F, COIL.N, mul(COIL.E1, -1)).q };
}
/** a point given in the rest fist's frame, moved with the fist */
const withFist = (t: number, p: V3): V3 => add(p, sub(coilFist(t).p, COIL.F));
/** where the right fist hands loop k over (über: on her side of the new loop, unter: behind it) */
export function coilHandOver(k: number): V3 {
  const side = COIL.kinds[k] === 'over' ? -0.045 : 0.04;
  return add(add(COIL.F, mul(COIL.N, COIL.pitch * (k + 1) + side)), mul(COIL.E1, 0.085));
}
/** the right fist's resting place at the start: at the fist, where loop 1 starts */
const COIL_HOME: V3 = add(add(COIL.F, mul(COIL.N, -0.04)), mul(COIL.E1, 0.08));

/**
 * The right fist (the sim's pinch frame; the part poses her hand on it): slides out along the cable
 * to her right, closes, brings the loop back to the left fist and gives it over. For "unter" it turns
 * over on the way back (the palm comes up), and turns back while it slides out again.
 */
export function coilRight(t: number): Frame {
  const K = COIL.kinds.length;
  let p = COIL_HOME;
  let turn = 0;
  for (let k = 0; k < K; k++) {
    const b = coilBeat(k);
    const from = k === 0 ? COIL_HOME : coilHandOver(k - 1);
    if (t < b.slide0) break;
    const ho = coilHandOver(k);
    if (t < b.back0) {
      // out along the cable (a little up first, over the strand into the fist), then down a little
      const u = ramp(t, b.slide0, b.slide1);
      const mid = add(mix(from, COIL.out, 0.45), [0, 0.06, 0]);
      p = mix(mix(withFist(t, from), mid, u), mix(mid, COIL.out, u), u);
    } else {
      const u = ramp(t, b.back0, b.back1);
      const mid = add(mix(COIL.out, ho, 0.55), [0, 0.07, 0]);
      p = mix(mix(COIL.out, mid, u), mix(mid, withFist(t, ho), u), u);
    }
    const under = COIL.kinds[k] === 'under';
    if (under) turn = ramp(t, b.back0 - 0.05, b.back1 - 0.15);
    else if (k > 0 && COIL.kinds[k - 1] === 'under') turn = 1 - ramp(t, b.slide0, b.slide0 + 0.7);
    else turn = 0;
  }
  // the cable runs through the fist along E1 (out to her right); the palm faces back towards her and down
  const base = gripFrame(p, COIL.E1, norm([0, -0.35, 1]));
  // turned over: about the forearm (≈ the cable's direction here), 150°
  const q = quatMul(base.q, quatFromAxisAngle(0, 0, 1, (-150 * Math.PI) / 180 * turn));
  return { p, q };
}

interface CoilBuilt {
  rod: Rod;
  pin: Pinch;
  fist: Bundle;
  script: (rod: Rod, t: number) => void;
  /** material where each loop starts and ends (filled while it runs) */
  loops: { s0: number; s1: number }[];
  /** nodes of the cable proper (between the plugs) */
  cable: [number, number];
}

/** a round loop of cable length l hanging from a to b (in the vertical plane through them) */
function hangLoop(a: V3, b: V3, l: number, n: number): V3[] {
  return roundLoop(a, b, l, n);
}

function buildCoil(): CoilBuilt {
  const h = 0.01;
  const G = COIL;
  const lead = 0.36;
  // the start plug sticks out of the fist (start side), the cable runs through it to her right fist
  const tip = sub(G.F, mul(G.E1, lead - 0.02));
  const P0: V3[] = densify([tip, G.F, COIL_HOME], h);
  // down from the right fist to the floor, out to her right and forward
  const down: V3 = [0.12, R25, -0.55];
  const hang = densify([COIL_HOME, add(COIL_HOME, [0.04, -0.25, -0.02]), add(down, [0, 0.12, 0]), down], h).slice(1);
  // the rest lies on the floor in loose wide bends, to her right and forward
  const dir = norm([0.8, 0, -0.6] as V3), side = norm(cross(UP, dir));
  const floor: V3[] = [];
  const used = arcOf([...P0, ...hang]).pop()!;
  const rest = 15 - used;
  // arc-length parametrised meander
  let x = 0, acc = 0, prev = down;
  while (acc < rest) {
    x += 0.004;
    const q = add(add(down, mul(dir, x)), mul(side, 0.45 * Math.sin((2 * Math.PI * x) / 2.2)));
    acc += len(sub(q, prev));
    prev = q;
    if (floor.length === 0 || len(sub(q, floor[floor.length - 1])) >= h) floor.push(q);
  }
  let P = [...P0, ...hang.slice(0, -1), ...floor];
  const iHome = P0.length - 1;
  P = relax(P, 12, (i) => i < iHome - 2 || (i > iHome - 2 && i < iHome + 2));
  const built = buildCable(POWER_5G2_5, P, { plugs: 'both', up: UP });
  const rod = built.rod;
  rod.time = COIL_PRE;
  const sHome = rod.closestPoint(COIL_HOME).s;
  // the left fist holds the plug end
  const fist = rod.bundle({ frame: coilFist, hand: 0, blend: 0.01 });
  fist.add(0, sHome - 0.04, 0.01);
  // the right fist: closed on the cable next to the left fist
  const pin = rod.pinch({ frame: coilRight, mode: 'held', s: sHome, hand: 1, pad: 0.02, friction: 4, rolls: false, blend: 0.01, lostDistance: 0.06, lostAngle: 1.4, maxGripDistance: 0.03 });
  const loops: { s0: number; s1: number }[] = [];
  const guides: (number | null)[] = [];
  let state: 'rest' | 'slide' | 'held' | 'given' = 'rest';
  let k = -1;
  let sStart = sHome;
  const script = (r: Rod, t: number) => {
    const next = k + 1;
    if (next < G.kinds.length && t >= coilBeat(next).slide0 && (state === 'rest' || state === 'given')) {
      // slide out: loose, the cable runs through the fist
      k = next;
      sStart = k === 0 ? sHome : loops[k - 1].s1;
      loops.push({ s0: sStart, s1: sStart + G.loop });
      pin.set('loose', 0.12);
      state = 'slide';
    }
    if (k < 0) return;
    const b = coilBeat(k);
    if (state === 'slide' && (pin.s - sStart >= G.loop || t >= b.slide1 + 0.05)) {
      pin.set('held', 0.08);
      loops[k].s1 = pin.s;
      state = 'held';
      // the hand shapes the loop round while it brings it back (soft, fading in; off after the hand-over)
      const s0 = sStart, s1 = pin.s, L = s1 - s0;
      const ia = r.segmentAt(s0 + 0.06) + 1, ib = Math.max(ia + 2, r.segmentAt(s1 - 0.08));
      const nPts = 200;
      const tb0 = b.back0, tb1 = b.back1, tg = b.give;
      const kk = k;
      let memoT = NaN;
      let pts: V3[] = [];
      guides[k] = r.addGuide({
        nodes: [ia, ib],
        compliance: 2e-3,
        weight: (tt) => ramp(tt, tb0, tb1) * (1 - ramp(tt, tg + 0.1, tg + 0.9)),
        target: (i, tt) => {
          if (tt !== memoT) {
            const a = add(withFist(tt, G.F), mul(G.N, G.pitch * (kk + 1)));
            pts = hangLoop(a, pin.frame(tt).p, L, nPts);
            memoT = tt;
          }
          const u = (r.sNode[i] - s0) / L;
          const j = Math.max(0, Math.min(nPts, Math.round(u * nPts)));
          return pts[j];
        },
      });
    }
    if (state === 'held' && t >= b.give) {
      // the left fist takes the strand where it lies, the right one loosens
      // (not the material between the pads: they slide on from there)
      fist.add(pin.s - 0.16, pin.s - 0.035, 0.25);
      pin.set('loose', 0.2);
      loops[k].s1 = pin.s;
      state = 'given';
    }
    if (state === 'given' && k === G.kinds.length - 1 && t >= b.end) {
      // after the last loop the right fist holds again (the cable to the floor)
      pin.set('held', 0.15);
      state = 'rest';
      k = G.kinds.length;
    }
    for (let j = 0; j < guides.length; j++) {
      const g = guides[j];
      if (g !== null && g !== undefined && t > coilBeat(j).give + 1.0) {
        r.removeGuide(g);
        guides[j] = null;
      }
    }
  };
  return { rod, pin, fist, script, loops, cable: built.cable };
}

/** the pre-roll of p6-coil starts at this shot time [s] */
const COIL_PRE = -1.2;

/** loop k's shape: width across (E1) and height below the fist, and how far its plane is off N */
function loopShapeOf(r: Rod, s0: number, s1: number) {
  const a = r.segmentAt(s0), b = r.segmentAt(s1);
  let w0 = Infinity, w1 = -Infinity, y0 = Infinity;
  for (let i = a; i <= b; i++) {
    const x = node(r, i);
    const e = dot(x, COIL.E1);
    w0 = Math.min(w0, e);
    w1 = Math.max(w1, e);
    y0 = Math.min(y0, x[1]);
  }
  return { w: w1 - w0, h: COIL.F[1] - y0 };
}

export const coilShot: ShotDef = {
  id: 'p6-coil',
  duration: COIL_T.end,
  substeps: POWER_5G2_5.substeps,
  build() {
    const b = buildCoil();
    const { rod } = b;
    for (let f = 0; f < Math.round(-COIL_PRE * 60); f++) {
      b.script(rod, rod.time);
      rod.step(1 / 60, POWER_5G2_5.substeps);
    }
    rod.time = 0;
    const tracks: Record<string, (r: Rod, t: number) => number> = {
      /** nodes of the cable proper (the tube; the plugs lie beyond) */
      iC0: () => b.cable[0],
      iC1: () => b.cable[1],
      sFist: () => b.pin.s,
      /** the right fist: 0.5 loose (sliding), 1 held */
      grip: (_r, t) => b.pin.level(t),
      /** twist from the start plug to the right fist [turns] */
      twCoil: (r) => r.twistTurns(0, r.segmentAt(b.pin.s)),
      /** twist from the right fist to the far plug [turns] */
      twFloor: (r) => r.twistTurns(r.segmentAt(b.pin.s), r.ns - 1),
    };
    for (let k = 0; k < COIL.kinds.length; k++) {
      tracks[`loop${k}`] = () => (b.loops[k] ? b.loops[k].s1 - b.loops[k].s0 : 0);
      tracks[`loopW${k}`] = (r) => (b.loops[k] ? loopShapeOf(r, b.loops[k].s0, b.loops[k].s1).w : 0);
      tracks[`loopH${k}`] = (r) => (b.loops[k] ? loopShapeOf(r, b.loops[k].s0, b.loops[k].s1).h : 0);
      tracks[`loopS${k}`] = () => (b.loops[k] ? b.loops[k].s0 : 0);
    }
    return {
      rod,
      script: b.script,
      tracks,
      vectors: { right: frameTrack(() => b.pin.frame()), left: frameTrack((_r, t) => coilFist(t)) },
    };
  },
};

// ======================================================================================= ring

/**
 * The finished 15 m ring of the 5G2.5 (ring factory: 11 loops over-under of 1.3 m, Ø ≈ 41 cm, the
 * start plug in the fist, the end plug hanging out of the eye), pressed and stored.
 */
export const RING25: RingSpec = { cable: POWER_5G2_5, loop: 1.3, pattern: 'ouououououo', lead: 0.3, tail: 0.4, spacing: 0.036, press: 0.75, pressTime: 3, fist: 0.05, tear: 0.08, memoryRound: true };

/** p6-ring: Mai holds the finished ring at her left side; lifts it close to her body and walks two steps */
export const RING_T = { lift0: 0.6, lift1: 1.6, walk0: 2.0, walk1: 4.4, end: 6.0 };
/** the ring's fist (world): low at her left side, then up close to her body, then carried forward (-z) */
export function ringFist(t: number): Frame {
  const low: V3 = [-0.3, 1.0, -0.26];
  const close: V3 = [-0.26, 1.12, -0.12];
  const lift = ramp(t, RING_T.lift0, RING_T.lift1);
  const walked = 1.1 * ramp(t, RING_T.walk0, RING_T.walk1);
  // a little bob with the steps
  const bob = 0.012 * Math.sin(Math.PI * 4 * clamp01((t - RING_T.walk0) / (RING_T.walk1 - RING_T.walk0)));
  const p = add(mix(low, close, lift), [0, bob, -walked]);
  // the factory ring hangs in the x-y plane, stack along +z: turned so the loops face forward-right
  const q = quatFromAxisAngle(0, 1, 0, -0.45);
  return { p, q };
}

export const ringShot: ShotDef = {
  id: 'p6-ring',
  duration: RING_T.end,
  substeps: POWER_5G2_5.substeps,
  build() {
    const ring = windRing(RING25);
    const f0 = ringFist(0);
    const st = placeRing(ring.state, sub(f0.p, [0, 1.6, 0]), f0.q, 0);
    const rod = ringRod(ring, st, RING25);
    rod.time = 0;
    // the fist (and the strap round the top of the ring) holds what the factory's fist held
    const toFist = (t: number): Frame => {
      const f = ringFist(t);
      // placeRing moved the factory fist [0, 1.6, 0] to f0.p turned by f0.q: the bundle frame keeps that relation
      return { p: f.p, q: quatMul(f.q, quatConj(f0.q)) };
    };
    const fist = rod.bundle({ frame: (t) => {
      const f = toFist(t);
      return { p: f.p, q: f.q };
    }, hand: 0, blend: 0.001 });
    for (const [a, b] of ring.held) fist.add(a, b, 0.001);
    return {
      rod,
      tracks: {
        iC0: () => ring.cable[0],
        iC1: () => ring.cable[1],
        /** the lowest point of the ring above the floor [m] */
        low: (r) => {
          let y = Infinity;
          for (let i = 0; i < r.n; i++) y = Math.min(y, r.x[3 * i + 1]);
          return y;
        },
      },
      vectors: { fist: frameTrack((_r, t) => ringFist(t)) },
    };
  },
};

// ======================================================================================= fail

/**
 * p6-fail: the end of the 25 m 5G16 lies on the floor in front of Mai, running to her right. 8 m
 * are simulated (the scene draws the rest on along +x from the last node).
 */
export const FAIL = {
  /** the start plug's tip */
  tip: [-0.95, R16, -0.5] as V3,
  /** simulated length [m] (its far end is free: the cable gets dragged a little; the scene draws the rest on from it) */
  length: 8,
  /** where the fists take it (material from the plug's tip) */
  sL: 0.32,
  sR: 1.6,
};
export const FAIL_T = { reachL: 0.5, gripL: 1.4, upL: 2.5, reachR: 2.7, gripR: 3.6, loop0: 3.8, loop1: 5.3, letGo: 5.9, down0: 6.9, down1: 7.9, open: 8.0, end: 9.4 };

interface FailBuilt {
  rod: Rod;
  /** the fists' frames (decided as it runs: the right one goes where the cable lies) */
  left: (t: number) => Frame;
  right: (t: number) => Frame;
  script: (rod: Rod, t: number) => void;
  cable: [number, number];
}

function buildFail(): FailBuilt {
  const T = FAIL_T;
  const pts: V3[] = [];
  for (let s = 0; s <= FAIL.length + 1e-9; s += 0.01) pts.push(add(FAIL.tip, [s, 0, 0]));
  const built = buildCable(POWER_5G16, pts, { plugs: 'start', up: UP });
  const rod = built.rod;
  rod.time = 0;
  // the left fist: down to the cable, takes it, stands up with the end; at the end puts it down
  const pL = rod.pointAt(FAIL.sL);
  const fistOver = (p: V3): Frame => gripFrame(p, [1, 0, 0], UP);
  const hipL: V3 = [-0.12, 0.95, -0.42];
  const leftPos = pathKeys([
    [0, [-0.35, 0.75, -0.25]],
    [T.reachL, [-0.35, 0.75, -0.25]],
    [T.gripL, add(pL, [0, 0, 0])],
    [T.gripL + 0.15, add(pL, [0, 0, 0])],
    [T.upL, hipL],
    [T.down0, hipL],
    [T.down1, add(pL, [0.05, 0, 0.05])],
  ]);
  // her left fist holds the end level, the plug sticking out to her left, the cable leaving to her right and a little down
  const left = (t: number): Frame => {
    const u = ramp(t, T.gripL + 0.15, T.upL) * (1 - ramp(t, T.down0, T.down1));
    const along = norm(mix([1, 0, 0], [0.9, -0.35, -0.1], u));
    return gripFrame(leftPos(t), along, norm(mix(UP, [0, 0.4, 0.9], u)));
  };
  // the right fist: where the cable lies at T.reachR (sim in the loop), then up and round to the left fist
  let grabP: V3 | null = null, grabT: V3 = [1, 0, 0];
  const restR: V3 = [0.32, 0.8, -0.25];
  const right = (t: number): Frame => {
    if (!grabP || t < T.reachR) return fistOver(restR);
    // she brings the loop up next to the left fist (a hand's width off), then tries to close it
    const near: V3 = add(hipL, [0.3, 0.04, 0.02]);
    const shut: V3 = add(hipL, [0.15, 0.04, 0.03]);
    const top: V3 = add(mix(grabP, near, 0.55), [0, 0.25, 0]);
    if (t < T.gripR + 0.15) return gripFrame(mix(restR, grabP, ramp(t, T.reachR, T.gripR)), grabT, UP);
    const upIn: V3 = norm([-0.45, 0.9, 0.05]);
    if (t < T.letGo) {
      // up and over towards the left fist, the cable turning up through the fist (a loop between the fists)
      const u = ramp(t, T.loop0, T.loop1);
      const p = mix(mix(grabP, top, u), mix(top, near, u), u);
      const w = ramp(t, T.loop1, T.letGo - 0.1);
      return gripFrame(mix(p, shut, w), norm(mix(grabT, upIn, u)), norm(mix(UP, [0.9, 0.45, 0], u)));
    }
    // let go: the hand opens and backs off a little
    const v = ramp(t, T.letGo, T.letGo + 0.6);
    return gripFrame(add(shut, [0.14 * v, 0.06 * v, 0.1 * v]), upIn, [0.9, 0.45, 0]);
  };
  let gL: number | null = null, gR: number | null = null;
  const seg = (s: number) => rod.segmentAt(s);
  const script = (r: Rod, t: number) => {
    if (gL === null && t >= T.gripL) gL = r.addGrip({ nodes: [seg(FAIL.sL - 0.05), seg(FAIL.sL + 0.05) + 1], frame: left, blend: 0.15 });
    if (grabP === null && t >= T.reachR) {
      grabP = r.pointAt(FAIL.sR);
      grabT = r.tangentAt(FAIL.sR);
    }
    if (gR === null && t >= T.gripR) gR = r.addGrip({ nodes: [seg(FAIL.sR - 0.05), seg(FAIL.sR + 0.05) + 1], frame: right, blend: 0.15 });
    if (gR !== null && gR >= 0 && t >= T.letGo) {
      r.releaseGrip(gR);
      gR = -1;
    }
    if (gL !== null && gL >= 0 && t >= T.open) {
      r.releaseGrip(gL);
      gL = -1;
    }
  };
  return { rod, left, right, script, cable: built.cable };
}

export const failShot: ShotDef = {
  id: 'p6-fail',
  duration: FAIL_T.end,
  substeps: POWER_5G16.substeps,
  build() {
    const b = buildFail();
    return {
      rod: b.rod,
      script: b.script,
      tracks: {
        iC0: () => b.cable[0],
        iC1: () => b.cable[1],
        /** how far apart the loop's two ends are while she holds it, and its lowest point */
        low: (r) => {
          let y = Infinity;
          const e = r.segmentAt(FAIL.sR + 0.3);
          for (let i = 0; i <= e; i++) y = Math.min(y, r.x[3 * i + 1]);
          return y;
        },
        /** the tightest bend radius between the fists [m] */
        bend: (r) => {
          let k = 0;
          const a = r.segmentAt(FAIL.sL + 0.08), c = r.segmentAt(FAIL.sR - 0.08);
          for (let j = a + 1; j < c; j++) {
            const p0 = node(r, j - 1), p1 = node(r, j), p2 = node(r, j + 1);
            const t1 = norm(sub(p1, p0)), t2 = norm(sub(p2, p1));
            const ang = Math.acos(Math.max(-1, Math.min(1, dot(t1, t2))));
            k = Math.max(k, ang / (0.5 * (len(sub(p1, p0)) + len(sub(p2, p1)))));
          }
          return k > 0 ? 1 / k : 99;
        },
      },
      vectors: { left: frameTrack((_r, t) => b.left(t)), right: frameTrack((_r, t) => b.right(t)) },
    };
  },
};

// ===================================================================================== unroll

/** p6-unroll: Mai takes the end on top of the stack, lifts it and walks away to her right with it */
export const UNROLL_T = { grip: 0.6, lift: 1.4, walk0: 1.6, walk1: 12.0, end: 12.6 };
/** how far she walks away with the end [m] */
export const UNROLL_WALK = 5.0;
/** the stack's top end at the start (material from the start: the end plug and 25 cm of cable) */
const UNROLL_HOLD = 0.32;

interface UnrollBuilt {
  rod: Rod;
  fist: (t: number) => Frame;
  script: (rod: Rod, t: number) => void;
}

function buildUnroll(): UnrollBuilt {
  const st = stackState();
  const rod = Rod.fromState(st);
  // the plugs' masses are not part of a saved state
  plugMasses(rod, POWER_5G16);
  rod.time = 0;
  rod.v.fill(0);
  rod.om.fill(0);
  const T = UNROLL_T;
  const sEnd = rod.totalLength;
  const p0 = rod.pointAt(sEnd - UNROLL_HOLD / 2);
  const t0 = rod.tangentAt(sEnd - UNROLL_HOLD / 2);
  // up to chest height (the cable comes off the top, not across it), then away to her right (+x)
  const lifted: V3 = [p0[0] + 0.1, 1.05, p0[2] + 0.1];
  const dir: V3 = [1, 0, 0.12];
  const fist = (t: number): Frame => {
    if (t < T.grip) return gripFrame(add(p0, [0, 0.08 * (1 - ramp(t, 0, T.grip)), 0]), t0, UP);
    if (t < T.walk0) return gripFrame(mix(p0, lifted, ramp(t, T.grip + 0.1, T.lift)), norm(mix(t0, [1, 0.3, 0], ramp(t, T.grip + 0.1, T.lift))), UP);
    // walking away 5 m (eased in and out as people/rig.ts walk() moves between two waypoints, so her body and her fist go together)
    const u = Math.min(1, Math.max(0, (t - T.walk0) / (T.walk1 - T.walk0)));
    return gripFrame(add(lifted, mul(norm(dir), UNROLL_WALK * (1 - Math.cos(Math.PI * u)) / 2)), norm([1, 0.3, 0.1]), UP);
  };
  let g: number | null = null;
  const script = (r: Rod, t: number) => {
    if (g === null && t >= T.grip) g = r.addGrip({ nodes: [r.segmentAt(sEnd - UNROLL_HOLD), r.n - 1], frame: fist, blend: 0.2 });
  };
  return { rod, fist, script };
}

/** puts a preset's plug masses back on a rod built with plugs: 'both' (they are not part of RodState) */
function plugMasses(rod: Rod, spec: typeof POWER_5G16) {
  const plug = spec.plug;
  if (!plug) return;
  const S = rod.sNode, ns = rod.ns, total = rod.totalLength;
  const i0 = rod.segmentAt(plug.length - 1e-9) + 1, i1 = rod.segmentAt(total - plug.length + 1e-9);
  const spread = (j0: number, j1: number) => {
    const l = S[j1] - S[j0];
    for (let j = j0; j < j1; j++) rod.addMass(j, plug.mass * (rod.L[j] / l) - rod.m[j]);
  };
  spread(0, i0);
  spread(i1, ns);
}

export const unrollShot: ShotDef = {
  id: 'p6-unroll',
  duration: UNROLL_T.end,
  substeps: POWER_5G16.substeps,
  build() {
    const b = buildUnroll();
    const n0 = b.rod.n;
    return {
      rod: b.rod,
      script: b.script,
      tracks: {
        iC0: (r) => r.segmentAt(POWER_5G16.plug!.length - 1e-9) + 1,
        iC1: (r) => r.segmentAt(r.totalLength - POWER_5G16.plug!.length + 1e-9),
        /** twist in the cable pulled off the stack: from where it leaves the stack to her fist [turns] */
        twOut: (r) => {
          // where it leaves the stack: the last node (from the fist back) lower than 6 cm
          let i = r.n - 1;
          while (i > 0 && r.x[3 * i + 1] > 0.06) i--;
          return r.twistTurns(Math.max(0, r.segmentAt(r.sNode[i] - 0.0)), r.ns - 1);
        },
        /** twist in the whole cable from the start plug to her fist [turns] */
        twAll: (r) => r.twistTurns(0, r.ns - 1),
        /** material still lying on the stack (nodes within 1.2 m of the stack's centre, lower than 25 cm) [m] */
        onStack: (r) => {
          let c = 0;
          for (let i = 0; i < n0; i++) {
            const x = node(r, i);
            if (Math.hypot(x[0] - STACK.C[0], x[2] - STACK.C[2]) < 1.0 && x[1] < 0.25) c++;
          }
          return (c * r.totalLength) / n0;
        },
      },
      vectors: { fist: frameTrack((_r, t) => b.fist(t)) },
    };
  },
};

export const P6_SHOTS: ShotDef[] = [coilShot, ringShot, failShot, eightsShot, unrollShot];

// (helpers used by later shots; referenced here so the module type-checks while it grows)
void TAU;
void quatRotate;
void placeRing;
void ringRod;
void windRing;
export type { RingSpec };

/** @internal experiments (scratchpad) */
export const __debug = { buildEights, eightsGuides, stackHeights };
