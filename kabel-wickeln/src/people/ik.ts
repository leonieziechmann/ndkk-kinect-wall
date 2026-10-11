// Inverse kinematics for the arms, with the joints a real arm has and the ranges they really move in.
//
// Per arm nine angles (ArmAngles, radians; the left arm is the mirror image of the right, so the
// same angles mean the same movement on both sides):
//   clavicle   clavElev (shoulder up), clavProt (shoulder forward): a few degrees, following the arm
//   shoulder   flex/abd: the humerus direction as an "elevation vector" from hanging straight down,
//              forward (flexion; negative = extension) and sideways (abduction; negative = across
//              the body); its length is the elevation, its direction the plane of elevation.
//              rot: humeral rotation (+ external, - internal), relative to the arm carried from the
//              hanging pose along the shortest arc (0 with the elbow bent = forearm in that plane)
//   elbow      flexion (0 = straight)
//   forearm    pron: + pronation, - supination; 0 = thumb up with the elbow bent (mid-prone), the
//              palm facing the body's midline when the arm hangs. The twist happens between elbow
//              and wrist (the radius turns about the ulna), so the mesh twists along the forearm.
//   wrist      wflex (+ towards the palm, - extension), wdev (+ radial/thumb side, - ulnar)
//
// Limits (ARM_LIMITS, SHOULDER_CONE, the wrist ellipse) are hard: the solver never leaves them. On
// top, a comfort cost pulls every joint towards a relaxed middle and pushes it out of the outer 15 %
// of its range, so a person stays well inside the range when the task allows it.
//
// solveArm(setup, target, prev?) is a damped least-squares solver (Levenberg-Marquardt with
// projection onto the limits) over the nine angles. A target is a hand point that must reach a
// position (required) plus optional orientation goals (hand axes that should point along world
// directions, each with a weight: the full frame, or only the palm normal, the finger or the thumb
// direction) and an optional elbow direction. The solver picks the elbow swivel and distributes the
// rotation over shoulder, forearm and wrist. Without `prev` it starts from an analytic guess
// (two-bone IK with a natural elbow, the orientation goals fitted, everything clamped): a
// deterministic, continuous function of the target, so smooth target paths give smooth arms. With
// `prev` (the solution of the previous frame) it starts there and stays close to it (ArmIK keeps it
// between calls). Out of reach, the hand stops at the reachable point closest to the target.
//
// Conventions: world metres, y up. Arm-local coordinates (used inside): x forward, y up, z lateral
// (away from the body's midline); right-handed for the right arm, mirrored for the left. Hand frame
// as in body/hand.ts: x along the fingers (HandPose.fd), y out of the palm (HandPose.palm), z towards
// the thumb (thumb = side · fd × palm in the world).

import { V3, clamp, cross, dot, len, norm, sub } from './math';

export const DEG = Math.PI / 180;

/** the nine angles of an arm, rad (signs: see the file header) */
export interface ArmAngles {
  clavElev: number;
  clavProt: number;
  flex: number;
  abd: number;
  rot: number;
  elbow: number;
  pron: number;
  wflex: number;
  wdev: number;
}
export type ArmJoint = keyof ArmAngles;
export const ARM_JOINTS: ArmJoint[] = ['clavElev', 'clavProt', 'flex', 'abd', 'rot', 'elbow', 'pron', 'wflex', 'wdev'];
const NQ = 9;
const I = { clavElev: 0, clavProt: 1, flex: 2, abd: 3, rot: 4, elbow: 5, pron: 6, wflex: 7, wdev: 8 } as const;

export interface Range {
  min: number;
  max: number;
}

/**
 * Hard limits of the one-axis joints (adult; Kapandji, AAOS / Norkin & White). The shoulder's
 * elevation is limited by SHOULDER_CONE, the wrist's flexion and deviation together by an ellipse
 * through their four limits.
 */
export const ARM_LIMITS: Record<'clavElev' | 'clavProt' | 'rot' | 'elbow' | 'pron' | 'wflex' | 'wdev', Range> = {
  clavElev: { min: -5 * DEG, max: 12 * DEG },
  clavProt: { min: -6 * DEG, max: 12 * DEG },
  /** internal rotation 70°, external 90° */
  rot: { min: -70 * DEG, max: 90 * DEG },
  /** no hyperextension beyond 5° */
  elbow: { min: -5 * DEG, max: 145 * DEG },
  /** supination 85°, pronation 80° from thumb-up */
  pron: { min: -85 * DEG, max: 80 * DEG },
  /** extension 65°, flexion 75° */
  wflex: { min: -65 * DEG, max: 75 * DEG },
  /** ulnar deviation 35°, radial 20° */
  wdev: { min: -35 * DEG, max: 20 * DEG },
};

/**
 * The shoulder's maximal elevation (deg) per plane of elevation (deg): 0 forward (flexion 180),
 * 90 sideways (abduction 170), 180 backward (extension 50), -90 across the body (adduction: with
 * the arm in front of the body up to ~40°, more the higher it is raised, horizontal adduction
 * ~45° past the midline). Interpolated smoothly (periodic Catmull-Rom).
 */
export const SHOULDER_CONE: readonly [number, number][] = [
  [-180, 50], [-150, 42], [-120, 38], [-90, 40], [-60, 105], [-30, 160],
  [0, 180], [45, 175], [90, 170], [120, 120], [150, 65],
];

/** relaxed middle and scale (rad) per joint: the comfort cost is ((q - mid) / scale)² */
const COMFORT: Record<Exclude<ArmJoint, 'clavElev' | 'clavProt'>, [number, number]> = {
  flex: [8 * DEG, 75 * DEG],
  abd: [10 * DEG, 70 * DEG],
  rot: [-20 * DEG, 65 * DEG],
  elbow: [30 * DEG, 110 * DEG],
  pron: [15 * DEG, 60 * DEG],
  wflex: [-10 * DEG, 28 * DEG],
  wdev: [-6 * DEG, 13 * DEG],
};
const CLAV_SCALE = [3.5 * DEG, 4.5 * DEG];
/** the outer part of every range that costs extra */
const STRAIN = 0.15;
/** per joint the strained part at the low and the high end (a straight elbow is relaxed, only hyperextension strains) */
const STRAIN_AT: Record<'rot' | 'elbow' | 'pron', [number, number]> = { rot: [STRAIN, STRAIN], elbow: [0.03, STRAIN], pron: [STRAIN, STRAIN] };
const BOX = ['clavElev', 'clavProt', 'rot', 'elbow', 'pron'] as const;
const STRAINED = ['rot', 'elbow', 'pron'] as const;
const RELAXING = ['flex', 'abd', 'rot', 'elbow', 'pron', 'wflex', 'wdev'] as const;

// ---------------------------------------------------------------- setup

/** the fixed part of an arm for one frame: where it hangs from and how long it is */
export interface ArmSetup {
  side: -1 | 1;
  /** world: forward, up, lateral (= side · the chest's right) of the chest */
  F: V3;
  U: V3;
  L: V3;
  /** the sternoclavicular joint (world) */
  sc: V3;
  /** the clavicle at rest: sc → shoulder joint, arm-local */
  clav: V3;
  /** shoulder → elbow, elbow → wrist (m) */
  upper: number;
  fore: number;
  /** the torso the arm keeps out of: an elliptic cylinder around the spine (arm-local, from sc) */
  torso: { a: V3; b: V3; halfW: number; halfD: number };
}

/** world → arm-local (a direction) */
export function toLocal(s: ArmSetup, v: V3): V3 {
  return [dot(v, s.F), dot(v, s.U), dot(v, s.L)];
}

/** arm-local → world (a direction) */
export function toWorld(s: ArmSetup, v: ArrayLike<number>): V3 {
  return [
    s.F[0] * v[0] + s.U[0] * v[1] + s.L[0] * v[2],
    s.F[1] * v[0] + s.U[1] * v[1] + s.L[1] * v[2],
    s.F[2] * v[0] + s.U[2] * v[1] + s.L[2] * v[2],
  ];
}

const pointToWorld = (s: ArmSetup, v: ArrayLike<number>): V3 => {
  const w = toWorld(s, v);
  return [w[0] + s.sc[0], w[1] + s.sc[1], w[2] + s.sc[2]];
};

// ---------------------------------------------------------------- targets

/** an orientation goal: an axis of the hand frame should point along a world direction */
export interface AxisGoal {
  /** the axis in the hand frame: x along the fingers, y out of the palm, z towards the thumb */
  hand: V3;
  /** the world direction (normalised by the solver) */
  world: V3;
  /** 1 = firm (default); 0.1-0.3 = a mild preference that gives way to comfort */
  weight?: number;
}

export interface HandTarget {
  /** world position that the hand point `at` must reach */
  p: V3;
  /** the point of the hand that goes to p, in the hand frame (m; default [0, 0, 0], the wrist) */
  at?: V3;
  /** orientation goals (none: the hand takes the most comfortable orientation) */
  axes?: AxisGoal[];
  /** the elbow should point this way from the shoulder-wrist line (world direction) */
  elbow?: V3;
  /** weight of the elbow wish (default 1) */
  elbowWeight?: number;
}

/** a full hand frame as orientation goals: fingers along fd, palm out along palm */
export function frameGoals(fd: V3, palm: V3, weight = 1): AxisGoal[] {
  return [
    { hand: [1, 0, 0], world: fd, weight },
    { hand: [0, 1, 0], world: palm, weight },
  ];
}

// ---------------------------------------------------------------- results

export interface IkReport {
  /** distance between the hand point and the target, m */
  posError: number;
  /** false when the target is out of reach: the hand stops at the reachable point closest to it */
  reached: boolean;
  /** angle between the hand axis and its world direction, per goal (rad, same order as target.axes) */
  axisErrors: number[];
  /** joints at a hard limit: 'elbow:max', 'wrist:ellipse', 'shoulder:cone', … */
  atLimit: string[];
  /** joints in the outer 15 % of their range (uncomfortable but allowed) */
  strained: string[];
  /** solver iterations used */
  iterations: number;
  /** the total cost reached (position, orientation, comfort, strain …; lower is better, for comparing solutions) */
  cost: number;
}

export interface ArmSolution {
  /** the angles reached */
  angles: ArmAngles;
  /** world positions */
  shoulder: V3;
  elbow: V3;
  wrist: V3;
  /** the hand point (target.at) as reached */
  point: V3;
  /** the hand frame reached (world, unit): fingers, out of the palm, towards the thumb */
  hand: { fd: V3; palm: V3; thumb: V3 };
  /**
   * The forearm for the mesh (world, unit): its direction, the elbow's axis (lateral at the
   * elbow) and the radio-ulnar axis at the wrist (thumb side). The twist between them is the
   * pronation, spread along the forearm.
   */
  forearm: { dir: V3; elbowAxis: V3; wristAxis: V3; pron: number };
  report: IkReport;
}

// ---------------------------------------------------------------- kinematics (arm-local)

/** scratch for one forward evaluation, all arm-local, positions relative to sc */
interface Chain {
  sh: number[];
  el: number[];
  wr: number[];
  eff: number[];
  /** humerus: along (shoulder → elbow), its flex direction, the elbow axis */
  h: number[];
  b: number[];
  c: number[];
  /** forearm direction; at the wrist after pronation: palm, thumb side */
  fa: number[];
  palm1: number[];
  w1: number[];
  /** hand frame */
  fd: number[];
  palm: number[];
  w: number[];
}

const newChain = (): Chain => ({
  sh: [0, 0, 0], el: [0, 0, 0], wr: [0, 0, 0], eff: [0, 0, 0], h: [0, 0, 0], b: [0, 0, 0], c: [0, 0, 0],
  fa: [0, 0, 0], palm1: [0, 0, 0], w1: [0, 0, 0], fd: [0, 0, 0], palm: [0, 0, 0], w: [0, 0, 0],
});

/** rotates v by the unit quaternion (x, y, z, w) into out */
function qrot(qx: number, qy: number, qz: number, qw: number, vx: number, vy: number, vz: number, out: number[]) {
  // t = 2 q × v; v' = v + w t + q × t
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out[0] = vx + qw * tx + (qy * tz - qz * ty);
  out[1] = vy + qw * ty + (qz * tx - qx * tz);
  out[2] = vz + qw * tz + (qx * ty - qy * tx);
}

/** the humerus rotation (swing from hanging, then the twist about the arm) as a quaternion */
function humerusQuat(flex: number, abd: number, rot: number, out: number[] = [0, 0, 0, 0]): number[] {
  const th = Math.hypot(flex, abd);
  // swing about the horizontal axis (-abd, 0, flex)/θ by θ; sin(θ/2)/θ is smooth at 0
  const k = th > 1e-9 ? Math.sin(th / 2) / th : 0.5;
  const sx = -abd * k, sz = flex * k, sw = Math.cos(th / 2);
  // twist about (0, -1, 0) by rot
  const ty = -Math.sin(rot / 2), tw = Math.cos(rot / 2);
  // swing ⊗ twist (sy = 0, tx = tz = 0)
  out[0] = sx * tw - sz * ty;
  out[1] = sw * ty;
  out[2] = sz * tw + sx * ty;
  out[3] = sw * tw;
  return out;
}
const hq = [0, 0, 0, 0];

function fk(s: ArmSetup, q: ArrayLike<number>, at: V3, o: Chain) {
  // clavicle: elevate (about forward, raising the lateral end), then protract (about up)
  const ce = q[I.clavElev], cp = q[I.clavProt];
  const [cx, cy, cz] = s.clav;
  const y1 = cy * Math.cos(ce) + cz * Math.sin(ce);
  const z1 = -cy * Math.sin(ce) + cz * Math.cos(ce);
  o.sh[0] = cx * Math.cos(cp) + z1 * Math.sin(cp);
  o.sh[1] = y1;
  o.sh[2] = -cx * Math.sin(cp) + z1 * Math.cos(cp);
  // humerus
  const [hx, hy, hz, hw] = humerusQuat(q[I.flex], q[I.abd], q[I.rot], hq);
  qrot(hx, hy, hz, hw, 0, -1, 0, o.h);
  qrot(hx, hy, hz, hw, 1, 0, 0, o.b);
  qrot(hx, hy, hz, hw, 0, 0, 1, o.c);
  for (let k = 0; k < 3; k++) o.el[k] = o.sh[k] + s.upper * o.h[k];
  // elbow: the forearm turns from along the humerus towards b
  const ce2 = Math.cos(q[I.elbow]), se2 = Math.sin(q[I.elbow]);
  for (let k = 0; k < 3; k++) {
    o.fa[k] = o.h[k] * ce2 + o.b[k] * se2;
    o.wr[k] = o.el[k] + s.fore * o.fa[k];
  }
  // pronation: palm0 = -c (facing the midline when hanging), w0 = fa × palm0; turned about fa by -pron
  const fa = o.fa;
  const p0x = -o.c[0], p0y = -o.c[1], p0z = -o.c[2];
  const w0x = fa[1] * p0z - fa[2] * p0y, w0y = fa[2] * p0x - fa[0] * p0z, w0z = fa[0] * p0y - fa[1] * p0x;
  const cr = Math.cos(q[I.pron]), sr = Math.sin(q[I.pron]);
  o.palm1[0] = p0x * cr - w0x * sr;
  o.palm1[1] = p0y * cr - w0y * sr;
  o.palm1[2] = p0z * cr - w0z * sr;
  o.w1[0] = w0x * cr + p0x * sr;
  o.w1[1] = w0y * cr + p0y * sr;
  o.w1[2] = w0z * cr + p0z * sr;
  // wrist: deviation (fingers towards the thumb), then flexion (fingers towards the palm)
  const ck = Math.cos(q[I.wflex]), sk = Math.sin(q[I.wflex]);
  const cd = Math.cos(q[I.wdev]), sd = Math.sin(q[I.wdev]);
  for (let k = 0; k < 3; k++) {
    const e1 = cd * fa[k] + sd * o.w1[k];
    o.fd[k] = ck * e1 + sk * o.palm1[k];
    o.palm[k] = ck * o.palm1[k] - sk * e1;
    o.w[k] = -sd * fa[k] + cd * o.w1[k];
    o.eff[k] = o.wr[k] + o.fd[k] * at[0] + o.palm[k] * at[1] + o.w[k] * at[2];
  }
}

// ---------------------------------------------------------------- limits

/** the shoulder's elevation limit (rad) for a plane of elevation phi (rad) */
export function shoulderLimit(phi: number): number {
  const deg = (((phi / DEG + 180) % 360) + 360) % 360 - 180;
  const n = SHOULDER_CONE.length;
  let i = n - 1;
  for (let k = 0; k < n; k++) if (SHOULDER_CONE[k][0] <= deg) i = k;
  const a0 = SHOULDER_CONE[i][0];
  const a1 = i + 1 < n ? SHOULDER_CONE[i + 1][0] : SHOULDER_CONE[0][0] + 360;
  const u = (deg - a0) / (a1 - a0);
  const v = (k: number) => SHOULDER_CONE[(((i + k) % n) + n) % n][1];
  const p0 = v(-1), p1 = v(0), p2 = v(1), p3 = v(2);
  const u2 = u * u, u3 = u2 * u;
  const val = 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
  return val * DEG;
}

const wristAxes = (f: number, d: number) => [f / (f >= 0 ? ARM_LIMITS.wflex.max : -ARM_LIMITS.wflex.min), d / (d >= 0 ? ARM_LIMITS.wdev.max : -ARM_LIMITS.wdev.min)];

/** clamps the angles into the hard limits (in place) */
export function projectToLimits(q: Float64Array | number[]) {
  for (const j of BOX) q[I[j]] = clamp(q[I[j]], ARM_LIMITS[j].min, ARM_LIMITS[j].max);
  const th = Math.hypot(q[I.flex], q[I.abd]);
  const lim = shoulderLimit(Math.atan2(q[I.abd], q[I.flex]));
  if (th > lim) {
    q[I.flex] *= lim / th;
    q[I.abd] *= lim / th;
  }
  const [u, v] = wristAxes(q[I.wflex], q[I.wdev]);
  const e = Math.hypot(u, v);
  if (e > 1) {
    q[I.wflex] /= e;
    q[I.wdev] /= e;
  }
}

// The solver works on raw parameters that a smooth map squashes into the limits: inside the
// comfortable part of a range a raw parameter is the angle itself; towards a limit the angle
// approaches it ever more slowly (tanh) and never passes it. The cost is smooth everywhere, so the
// solver needs no projections, converges reliably and stays continuous along a path.

/** the soft part of each range at its low and high end (fractions of the range) */
const SOFT: Record<'clavElev' | 'clavProt' | 'rot' | 'elbow' | 'pron', [number, number]> = {
  clavElev: [0.3, 0.3],
  clavProt: [0.3, 0.3],
  rot: [0.2, 0.2],
  // a straight elbow is a common pose: only the last few degrees of hyperextension are soft
  elbow: [0.05, 0.2],
  pron: [0.2, 0.2],
};
/** where the soft part of the shoulder cone and the wrist ellipse starts (fraction of the limit) */
const SOFT_RADIAL = 0.8;

/** x squashed below m: itself up to a, then approaching m */
function softMax(x: number, a: number, m: number) {
  return x <= a ? x : a + (m - a) * Math.tanh((x - a) / (m - a));
}

/**
 * The inverse of softMax. An angle at or past m maps to a raw value only a little past the soft
 * zone, where the slope is still about a fifth: a start at a limit can still move back.
 */
function softMaxInv(y: number, a: number, m: number) {
  return y <= a ? y : a + (m - a) * Math.atanh(Math.min(0.9, (y - a) / (m - a)));
}

/** raw parameters → angles (always inside the limits) */
function toAngles(p: ArrayLike<number>, q: Float64Array) {
  for (const j of BOX) {
    const { min, max } = ARM_LIMITS[j];
    const w = max - min;
    const x = p[I[j]];
    const lo = min + SOFT[j][0] * w;
    const hi = max - SOFT[j][1] * w;
    q[I[j]] = x >= hi ? softMax(x, hi, max) : x <= lo ? -softMax(-x, -lo, -min) : x;
  }
  const fr = p[I.flex], ar = p[I.abd];
  const th = Math.hypot(fr, ar);
  const m = shoulderLimit(Math.atan2(ar, fr));
  const k = th > 1e-12 ? softMax(th, SOFT_RADIAL * m, m) / th : 1;
  q[I.flex] = fr * k;
  q[I.abd] = ar * k;
  const [u, v] = wristAxes(p[I.wflex], p[I.wdev]);
  const e = Math.hypot(u, v);
  const kw = e > 1e-12 ? softMax(e, SOFT_RADIAL, 1) / e : 1;
  q[I.wflex] = p[I.wflex] * kw;
  q[I.wdev] = p[I.wdev] * kw;
}

/** angles → raw parameters (angles outside the limits are clamped first) */
function toRaw(q0: ArrayLike<number>, p: Float64Array) {
  const q = Float64Array.from(q0);
  projectToLimits(q);
  for (const j of BOX) {
    const { min, max } = ARM_LIMITS[j];
    const w = max - min;
    const y = q[I[j]];
    const lo = min + SOFT[j][0] * w;
    const hi = max - SOFT[j][1] * w;
    p[I[j]] = y >= hi ? softMaxInv(y, hi, max) : y <= lo ? -softMaxInv(-y, -lo, -min) : y;
  }
  const th = Math.hypot(q[I.flex], q[I.abd]);
  const m = shoulderLimit(Math.atan2(q[I.abd], q[I.flex]));
  const k = th > 1e-12 ? softMaxInv(th, SOFT_RADIAL * m, m) / th : 1;
  p[I.flex] = q[I.flex] * k;
  p[I.abd] = q[I.abd] * k;
  const [u, v] = wristAxes(q[I.wflex], q[I.wdev]);
  const e = Math.hypot(u, v);
  const kw = e > 1e-12 ? softMaxInv(e, SOFT_RADIAL, 1) / e : 1;
  p[I.wflex] = q[I.wflex] * kw;
  p[I.wdev] = q[I.wdev] * kw;
}

/** the clavicle's relaxed angles for a humerus: it lifts with the raised arm and comes forward with a reach */
function clavicleRhythm(q: ArrayLike<number>): [number, number] {
  const th = Math.hypot(q[I.flex], q[I.abd]);
  const fwd = th > 1e-9 ? (q[I.flex] / th) * Math.sin(th) : 0;
  const med = th > 1e-9 ? (-q[I.abd] / th) * Math.sin(th) : 0;
  const elev = 0.11 * Math.max(0, th - 0.35);
  const prot = 0.1 * Math.max(0, fwd) + 0.12 * Math.max(0, med);
  return [clamp(elev, ARM_LIMITS.clavElev.min, ARM_LIMITS.clavElev.max), clamp(prot, ARM_LIMITS.clavProt.min, ARM_LIMITS.clavProt.max)];
}

/** 0 inside the comfortable part of [lo, hi], growing linearly to 1 at a limit (strained parts as fractions of the range) */
function strain(x: number, lo: number, hi: number, mlo: number, mhi: number) {
  const a = mlo * (hi - lo);
  const b = mhi * (hi - lo);
  if (x > hi - b) return (x - (hi - b)) / b;
  if (x < lo + a) return (lo + a - x) / a;
  return 0;
}

// ---------------------------------------------------------------- the cost

/** weights of the cost terms (residuals are squared and summed) */
const W = {
  /** per m of position error */
  pos: 1000,
  /** per rad of orientation error at goal weight 1 */
  axis: 20,
  /** per unit of strain (the outer 15 % of a range) */
  strain: 1.6,
  /** per unit of the comfort cost */
  comfort: 1,
  /** per m that a point of the arm is inside the torso */
  torso: 300,
  /** per unit of elbow direction error at weight 1 */
  elbow: 1.5,
  /** per rad of change against the previous frame */
  prev: 0.25,
  /** per rad that a raw parameter is past its squashed angle */
  drift: 0.15,
};

interface Problem {
  s: ArmSetup;
  /** target position, arm-local relative to sc */
  p: V3;
  at: V3;
  axes: { hand: V3; world: V3; w: number }[];
  elbow: V3 | null;
  elbowW: number;
  prev: Float64Array | null;
  chain: Chain;
  res: Float64Array;
  /** the angles of the raw parameters being evaluated */
  q: Float64Array;
  /** the cost of the last minimisation */
  cost: number;
}

const TORSO_MARGIN = 0.035;

/** how far a point is inside the torso (m, 0 outside) */
function insideTorso(s: ArmSetup, x: number, y: number, z: number) {
  const t = s.torso;
  const ax = t.b[0] - t.a[0], ay = t.b[1] - t.a[1], az = t.b[2] - t.a[2];
  const l2 = ax * ax + ay * ay + az * az;
  const px = x - t.a[0], py = y - t.a[1], pz = z - t.a[2];
  const u = (px * ax + py * ay + pz * az) / l2;
  if (u < 0 || u > 1) return 0;
  // across the spine: forward (x) and lateral (z) in the arm frame
  const dx = px - ax * u, dz = pz - az * u;
  const e = Math.hypot(dx / (t.halfD + TORSO_MARGIN), dz / (t.halfW + TORSO_MARGIN));
  return e < 1 ? (1 - e) * Math.min(t.halfD, t.halfW) : 0;
}

/** fills pr.res with the residuals at the raw parameters p; returns their count */
function residuals(pr: Problem, p: Float64Array): number {
  const q = pr.q;
  toAngles(p, q);
  const o = pr.chain;
  fk(pr.s, q, pr.at, o);
  const r = pr.res;
  let n = 0;
  // raw parameters do not drift far past their (squashed) angles
  for (let j = 0; j < NQ; j++) r[n++] = W.drift * (p[j] - q[j]);
  // position
  for (let k = 0; k < 3; k++) r[n++] = W.pos * (o.eff[k] - pr.p[k]);
  // orientation goals: the hand axis in the local frame against its target direction
  for (const g of pr.axes) {
    const [hx, hy, hz] = g.hand;
    const k = W.axis * g.w;
    for (let c = 0; c < 3; c++) r[n++] = k * (o.fd[c] * hx + o.palm[c] * hy + o.w[c] * hz - g.world[c]);
  }
  // the elbow's direction off the shoulder-wrist line
  if (pr.elbow) {
    const dx = o.wr[0] - o.sh[0], dy = o.wr[1] - o.sh[1], dz = o.wr[2] - o.sh[2];
    const dl = Math.hypot(dx, dy, dz) || 1;
    const ex = o.el[0] - o.sh[0], ey = o.el[1] - o.sh[1], ez = o.el[2] - o.sh[2];
    const k = (ex * dx + ey * dy + ez * dz) / (dl * dl);
    let px = ex - dx * k, py = ey - dy * k, pz = ez - dz * k;
    const pl = Math.hypot(px, py, pz) || 1;
    px /= pl;
    py /= pl;
    pz /= pl;
    const hk = (pr.elbow[0] * dx + pr.elbow[1] * dy + pr.elbow[2] * dz) / (dl * dl);
    let hx = pr.elbow[0] - dx * hk, hy = pr.elbow[1] - dy * hk, hz = pr.elbow[2] - dz * hk;
    const hl = Math.hypot(hx, hy, hz) || 1;
    hx /= hl;
    hy /= hl;
    hz /= hl;
    const w = W.elbow * pr.elbowW;
    r[n++] = w * (px - hx);
    r[n++] = w * (py - hy);
    r[n++] = w * (pz - hz);
  }
  // comfort: the clavicle follows the arm, the rest relaxes towards its middle
  const [ce, cp] = clavicleRhythm(q);
  r[n++] = (W.comfort * (q[I.clavElev] - ce)) / CLAV_SCALE[0];
  r[n++] = (W.comfort * (q[I.clavProt] - cp)) / CLAV_SCALE[1];
  for (const j of RELAXING) r[n++] = (W.comfort * (q[I[j]] - COMFORT[j][0])) / COMFORT[j][1];
  // strain near the limits
  for (const j of STRAINED) r[n++] = W.strain * strain(q[I[j]], ARM_LIMITS[j].min, ARM_LIMITS[j].max, STRAIN_AT[j][0], STRAIN_AT[j][1]);
  const th = Math.hypot(q[I.flex], q[I.abd]);
  r[n++] = W.strain * Math.max(0, th / shoulderLimit(Math.atan2(q[I.abd], q[I.flex])) - (1 - STRAIN)) / STRAIN;
  const [wu, wv] = wristAxes(q[I.wflex], q[I.wdev]);
  r[n++] = W.strain * Math.max(0, Math.hypot(wu, wv) - (1 - STRAIN)) / STRAIN;
  // keep the elbow, forearm and hand out of the torso
  r[n++] = W.torso * insideTorso(pr.s, o.el[0], o.el[1], o.el[2]);
  r[n++] = W.torso * insideTorso(pr.s, (o.el[0] + o.wr[0]) / 2, (o.el[1] + o.wr[1]) / 2, (o.el[2] + o.wr[2]) / 2);
  r[n++] = W.torso * insideTorso(pr.s, o.wr[0], o.wr[1], o.wr[2]);
  r[n++] = W.torso * insideTorso(pr.s, o.eff[0], o.eff[1], o.eff[2]);
  // stay with the previous frame
  if (pr.prev) for (let j = 0; j < NQ; j++) r[n++] = W.prev * (q[j] - pr.prev[j]);
  return n;
}

function costOf(pr: Problem, q: Float64Array) {
  const n = residuals(pr, q);
  let c = 0;
  for (let i = 0; i < n; i++) c += pr.res[i] * pr.res[i];
  return c;
}

/** solves A x = b (A symmetric positive definite, n × n, row-major) by Cholesky; false if singular */
function cholSolve(A: Float64Array, b: Float64Array, x: Float64Array, n: number): boolean {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (s <= 1e-300) return false;
        L[i * n + i] = Math.sqrt(s);
      } else L[i * n + j] = s / L[j * n + j];
    }
  }
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * x[k];
    x[i] = s / L[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return true;
}

/**
 * Levenberg-Marquardt on the raw parameters (numeric Jacobian); p is improved in place. With a box
 * (lo, hi), every step is clamped into it (the stateful solver's limit on the change per call).
 * Returns the iterations used.
 */
function minimise(pr: Problem, p: Float64Array, maxIter: number, box?: { lo: Float64Array; hi: Float64Array }): number {
  const keepIn = (x: Float64Array) => {
    if (box) for (let a = 0; a < NQ; a++) x[a] = clamp(x[a], box.lo[a], box.hi[a]);
  };
  keepIn(p);
  let cost = costOf(pr, p);
  const m = pr.res.length;
  const r0 = new Float64Array(m);
  const J = new Float64Array(m * NQ);
  const A = new Float64Array(NQ * NQ);
  const g = new Float64Array(NQ);
  const dp = new Float64Array(NQ);
  const pn = new Float64Array(NQ);
  const M = new Float64Array(NQ * NQ);
  let lambda = 1e-3;
  let it = 0;
  for (; it < maxIter; it++) {
    const n = residuals(pr, p);
    r0.set(pr.res.subarray(0, n));
    const h = 1e-6;
    for (let j = 0; j < NQ; j++) {
      const keep = p[j];
      p[j] = keep + h;
      residuals(pr, p);
      p[j] = keep;
      for (let i = 0; i < n; i++) J[i * NQ + j] = (pr.res[i] - r0[i]) / h;
    }
    A.fill(0);
    g.fill(0);
    for (let i = 0; i < n; i++) {
      const ri = r0[i];
      for (let a = 0; a < NQ; a++) {
        const ja = J[i * NQ + a];
        if (ja === 0) continue;
        g[a] += ja * ri;
        for (let b = 0; b <= a; b++) A[a * NQ + b] += ja * J[i * NQ + b];
      }
    }
    for (let a = 0; a < NQ; a++) for (let b = 0; b < a; b++) A[b * NQ + a] = A[a * NQ + b];
    let improved = false;
    while (lambda < 1e9) {
      M.set(A);
      for (let a = 0; a < NQ; a++) M[a * NQ + a] += lambda * (A[a * NQ + a] + 1e-6) + 1e-9;
      if (cholSolve(M, g, dp, NQ)) {
        for (let a = 0; a < NQ; a++) pn[a] = p[a] - dp[a];
        keepIn(pn);
        const cn = costOf(pr, pn);
        if (cn < cost) {
          let step = 0;
          for (let a = 0; a < NQ; a++) step = Math.max(step, Math.abs(pn[a] - p[a]));
          improved = cost - cn > 1e-11 * (1 + cost) && step > 1e-9;
          p.set(pn);
          cost = cn;
          lambda = Math.max(1e-7, lambda * 0.3);
          break;
        }
      }
      lambda *= 8;
    }
    if (!improved) break;
  }
  pr.cost = cost;
  return it;
}

// ---------------------------------------------------------------- the initial guess

/** rotation (columns) best mapping hand axes onto world directions (Davenport's q-method, power iteration) */
function fitFrame(goals: { hand: V3; world: V3; w: number }[]): [number[], number[], number[]] {
  // B = Σ w world handᵀ; K = [[S - tr·I, z], [zᵀ, tr]] with S = B + Bᵀ, z = Σ w world × hand
  const B = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const z = [0, 0, 0];
  let wsum = 0;
  for (const g of goals) {
    const v = g.world, u = g.hand;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) B[i * 3 + j] += g.w * v[i] * u[j];
    const c = cross(v, u);
    z[0] += g.w * c[0];
    z[1] += g.w * c[1];
    z[2] += g.w * c[2];
    wsum += g.w;
  }
  const tr = B[0] + B[4] + B[8];
  const K = [
    [2 * B[0] - tr, B[1] + B[3], B[2] + B[6], z[0]],
    [B[3] + B[1], 2 * B[4] - tr, B[5] + B[7], z[1]],
    [B[6] + B[2], B[7] + B[5], 2 * B[8] - tr, z[2]],
    [z[0], z[1], z[2], tr],
  ];
  // the eigenvector of the largest eigenvalue; shifting by Σw makes it the dominant one
  let x = [0.1, 0.2, 0.3, 0.9];
  for (let it = 0; it < 60; it++) {
    const y = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      y[i] = wsum * x[i];
      for (let j = 0; j < 4; j++) y[i] += K[i][j] * x[j];
    }
    const l = Math.hypot(y[0], y[1], y[2], y[3]) || 1;
    x = y.map((v) => v / l);
  }
  // q = (x, y, z, w) rotates hand axes into the world (for this sign convention of K, the conjugate)
  const [qx, qy, qz, qw] = [-x[0], -x[1], -x[2], x[3]];
  const c1 = [0, 0, 0], c2 = [0, 0, 0], c3 = [0, 0, 0];
  qrot(qx, qy, qz, qw, 1, 0, 0, c1);
  qrot(qx, qy, qz, qw, 0, 1, 0, c2);
  qrot(qx, qy, qz, qw, 0, 0, 1, c3);
  return [c1, c2, c3];
}

/** two-bone IK from the shoulder (local): elbow bends towards pole */
function twoBoneLocal(sh: number[], wr: number[], a: number, b: number, pole: number[]) {
  const d0 = [wr[0] - sh[0], wr[1] - sh[1], wr[2] - sh[2]];
  const dl = Math.hypot(d0[0], d0[1], d0[2]) || 1;
  const dir = d0.map((v) => v / dl);
  const d = clamp(dl, Math.abs(a - b) + 1e-3, a + b - 1e-4);
  const cos = (a * a + d * d - b * b) / (2 * a * d);
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
  const k = pole[0] * dir[0] + pole[1] * dir[1] + pole[2] * dir[2];
  let side = [pole[0] - dir[0] * k, pole[1] - dir[1] * k, pole[2] - dir[2] * k];
  const sl = Math.hypot(side[0], side[1], side[2]);
  side = sl > 1e-6 ? side.map((v) => v / sl) : [0, -dir[2], dir[1]];
  const el = [0, 1, 2].map((i) => sh[i] + a * (dir[i] * cos + side[i] * sin));
  const end = [0, 1, 2].map((i) => sh[i] + dir[i] * d);
  return { el, end };
}

/** angles from joint positions and a hand frame (all local); without a frame only shoulder and elbow */
function anglesFrom(sh: number[], el: number[], wr: number[], fd: number[] | null, palm: number[] | null, q: Float64Array) {
  const h = norm([el[0] - sh[0], el[1] - sh[1], el[2] - sh[2]]);
  const fa = norm([wr[0] - el[0], wr[1] - el[1], wr[2] - el[2]]);
  // humerus: elevation vector
  const th = Math.acos(clamp(-h[1], -1, 1));
  const hor = Math.hypot(h[0], h[2]);
  q[I.flex] = hor > 1e-9 ? (th * h[0]) / hor : 0;
  q[I.abd] = hor > 1e-9 ? (th * h[2]) / hor : 0;
  // twist: from the carried flex direction to the real one (blended to comfort when straight)
  const [hx, hy, hz, hw] = humerusQuat(q[I.flex], q[I.abd], 0);
  const bc = [0, 0, 0];
  qrot(hx, hy, hz, hw, 1, 0, 0, bc);
  const ce = dot(h, fa);
  q[I.elbow] = Math.acos(clamp(ce, -1, 1));
  const ba = [fa[0] - h[0] * ce, fa[1] - h[1] * ce, fa[2] - h[2] * ce];
  const bl = Math.hypot(ba[0], ba[1], ba[2]);
  const hb = cross(h, bc as V3);
  const rot = bl > 1e-9 ? Math.atan2(dot(hb, ba as V3), dot(bc as V3, ba as V3)) : COMFORT.rot[0];
  const bent = clamp(bl / 0.2);
  q[I.rot] = rot * bent + COMFORT.rot[0] * (1 - bent);
  if (!fd || !palm) return;
  // forearm and wrist: R = F0ᵀ H = Rx(-pron) Ry(-dev) Rz(flex)
  const [qx, qy, qz, qw] = humerusQuat(q[I.flex], q[I.abd], q[I.rot]);
  const c = [0, 0, 0];
  qrot(qx, qy, qz, qw, 0, 0, 1, c);
  // re-derive fa in this humerus frame (it equals the measured one when the twist was exact)
  const hh = [0, 0, 0], bb = [0, 0, 0];
  qrot(qx, qy, qz, qw, 0, -1, 0, hh);
  qrot(qx, qy, qz, qw, 1, 0, 0, bb);
  const fa2 = [0, 1, 2].map((k) => hh[k] * Math.cos(q[I.elbow]) + bb[k] * Math.sin(q[I.elbow])) as V3;
  const palm0 = [-c[0], -c[1], -c[2]] as V3;
  const w0 = cross(fa2, palm0);
  const w = cross(fd as V3, palm as V3);
  const F0 = [fa2, palm0, w0];
  const H = [fd as V3, palm as V3, w];
  const R = (i: number, j: number) => dot(F0[i], H[j]);
  const b = Math.asin(clamp(R(0, 2), -1, 1));
  q[I.pron] = -Math.atan2(-R(1, 2), R(2, 2));
  q[I.wdev] = -b;
  q[I.wflex] = Math.atan2(-R(0, 1), R(0, 0));
}

/** the most comfortable hand frame on this arm (local): comfort pronation and wrist */
function relaxedHand(s: ArmSetup, q: Float64Array): [number[], number[]] {
  const t = Float64Array.from(q);
  t[I.pron] = COMFORT.pron[0];
  t[I.wflex] = COMFORT.wflex[0];
  t[I.wdev] = COMFORT.wdev[0];
  const ch = newChain();
  fk(s, t, [0, 0, 0], ch);
  return [ch.fd.slice(), ch.palm.slice()];
}

/** where the elbow points in the starting guesses (arm-local): down, out and back; out and up; down and forward */
const POLES: V3[] = [norm([-0.25, -1, 0.45]), norm([-0.1, -0.35, 1]), norm([0.5, -1, 0.1])];

/**
 * An analytic starting point (elbow towards one of POLES; relaxed: the hand as relaxed as possible,
 * ignoring the orientation goals): a deterministic, continuous function of the target
 */
function initialGuess(pr: Problem, start = 0, relaxed = false): Float64Array {
  const s = pr.s;
  const q = new Float64Array(NQ);
  const sh = [...s.clav];
  // the elbow towards the pole, blended with the target's wish
  let pole = POLES[start];
  if (pr.elbow) {
    const k = clamp(pr.elbowW, 0, 1);
    pole = norm([0, 1, 2].map((i) => pole[i] * (1 - k) + pr.elbow![i] * k * 2) as V3);
  }
  // pass 1: the wrist at the target, a relaxed hand
  let ik = twoBoneLocal(sh, pr.p, s.upper, s.fore, pole);
  anglesFrom(sh, ik.el, ik.end, null, null, q);
  projectToLimits(q);
  const rel = relaxedHand(s, q);
  // the hand frame: the goals (none for the relaxed start), filled up with the relaxed frame
  const goals = [
    ...(relaxed ? [] : pr.axes),
    { hand: [1, 0, 0] as V3, world: rel[0] as V3, w: 0.08 },
    { hand: [0, 1, 0] as V3, world: rel[1] as V3, w: 0.08 },
  ];
  const [fd, palm] = fitFrame(goals);
  const w = cross(fd as V3, palm as V3);
  // pass 2: the wrist where the hand point lands on the target
  const wr = [0, 1, 2].map((k) => pr.p[k] - fd[k] * pr.at[0] - palm[k] * pr.at[1] - w[k] * pr.at[2]);
  ik = twoBoneLocal(sh, wr, s.upper, s.fore, pole);
  anglesFrom(sh, ik.el, ik.end, fd, palm, q);
  const [ce, cp] = clavicleRhythm(q);
  q[I.clavElev] = ce;
  q[I.clavProt] = cp;
  projectToLimits(q);
  return q;
}

// ---------------------------------------------------------------- solving

export interface SolveOptions {
  /** the previous frame's solution: start there and stay close (continuity) */
  prev?: ArmAngles | null;
  /** iteration cap (default 60) */
  maxIter?: number;
  /**
   * with prev: the most any joint may change in this call (rad). The arm then reconfigures over a
   * few frames instead of popping when the target asks for something far away (the hand lags
   * meanwhile, see the report); default: no limit
   */
  maxStep?: number;
}

/** iterations per start before the best start is finished */
const PROBE = 15;

const toArray = (a: ArmAngles) => Float64Array.from(ARM_JOINTS.map((j) => a[j]));
const fromArray = (q: ArrayLike<number>): ArmAngles => Object.fromEntries(ARM_JOINTS.map((j, i) => [j, q[i]])) as unknown as ArmAngles;

/** the arm reaching for a target (see the file header) */
export function solveArm(s: ArmSetup, target: HandTarget, o: SolveOptions = {}): ArmSolution {
  const rel = sub(target.p, s.sc);
  const axes = (target.axes ?? [])
    .filter((g) => (g.weight ?? 1) > 0 && len(g.world) > 1e-9)
    .map((g) => ({ hand: norm(g.hand), world: norm(toLocal(s, g.world)), w: g.weight ?? 1 }));
  const pr: Problem = {
    s,
    p: toLocal(s, rel),
    at: target.at ?? [0, 0, 0],
    axes,
    elbow: target.elbow ? toLocal(s, norm(target.elbow)) : null,
    elbowW: target.elbowWeight ?? 1,
    prev: o.prev ? toArray(o.prev) : null,
    chain: newChain(),
    res: new Float64Array(50 + 3 * axes.length),
    q: new Float64Array(NQ),
    cost: 0,
  };
  const maxIter = o.maxIter ?? 60;
  const p = new Float64Array(NQ);
  let iterations = 0;
  if (pr.prev) {
    toRaw(pr.prev, p);
    let box: { lo: Float64Array; hi: Float64Array } | undefined;
    if (o.maxStep !== undefined && Number.isFinite(o.maxStep)) {
      const step = o.maxStep;
      box = { lo: p.map((v) => v - step), hi: p.map((v) => v + step) };
    }
    iterations = minimise(pr, p, maxIter, box);
  } else {
    // starts with the elbow down, out and forward, and a relaxed hand with the elbow down; a few
    // iterations each, the best one is finished
    let best = Infinity;
    for (let k = 0; k <= POLES.length; k++) {
      const c = new Float64Array(NQ);
      toRaw(k < POLES.length ? initialGuess(pr, k) : initialGuess(pr, 0, true), c);
      iterations += minimise(pr, c, PROBE);
      if (pr.cost < best - 1e-9) {
        best = pr.cost;
        p.set(c);
      }
    }
    iterations += minimise(pr, p, maxIter);
  }
  const q = new Float64Array(NQ);
  toAngles(p, q);
  return finish(pr, q, iterations);
}

/** forward kinematics only: where an arm with these angles puts its joints and hand */
export function armPose(s: ArmSetup, angles: ArmAngles, at: V3 = [0, 0, 0]): ArmSolution {
  const pr: Problem = { s, p: [0, 0, 0], at, axes: [], elbow: null, elbowW: 0, prev: null, chain: newChain(), res: new Float64Array(50), q: new Float64Array(NQ), cost: 0 };
  const q = toArray(angles);
  const sol = finish(pr, q, 0);
  sol.report.posError = 0;
  sol.report.reached = true;
  return sol;
}

function finish(pr: Problem, q: Float64Array, iterations: number): ArmSolution {
  const s = pr.s;
  const o = pr.chain;
  fk(s, q, pr.at, o);
  const posError = Math.hypot(o.eff[0] - pr.p[0], o.eff[1] - pr.p[1], o.eff[2] - pr.p[2]);
  const axisErrors = pr.axes.map((g) => {
    const v = [0, 1, 2].map((c) => o.fd[c] * g.hand[0] + o.palm[c] * g.hand[1] + o.w[c] * g.hand[2]) as V3;
    return Math.acos(clamp(dot(v, g.world), -1, 1));
  });
  const atLimit: string[] = [];
  const strained: string[] = [];
  // the soft limits approach a limit without reaching it: within 1° (1 % of the cone or ellipse) counts
  const eps = 1 * DEG;
  for (const j of BOX) {
    const v = q[I[j]];
    const r = ARM_LIMITS[j];
    if (v <= r.min + eps) atLimit.push(`${j}:min`);
    else if (v >= r.max - eps) atLimit.push(`${j}:max`);
    else if (j !== 'clavElev' && j !== 'clavProt' && strain(v, r.min, r.max, STRAIN_AT[j][0], STRAIN_AT[j][1]) > 0) strained.push(j);
  }
  const th = Math.hypot(q[I.flex], q[I.abd]);
  const cone = th / shoulderLimit(Math.atan2(q[I.abd], q[I.flex]));
  if (cone >= 0.99) atLimit.push('shoulder:cone');
  else if (cone > 1 - STRAIN) strained.push('shoulder');
  const [wu, wv] = wristAxes(q[I.wflex], q[I.wdev]);
  const we = Math.hypot(wu, wv);
  if (we >= 0.99) atLimit.push('wrist:ellipse');
  else if (we > 1 - STRAIN) strained.push('wrist');
  // the forearm for the mesh: elbow axis (lateral, = c) and the wrist's radio-ulnar axis (w1)
  const angles = fromArray(q);
  return {
    angles,
    shoulder: pointToWorld(s, o.sh),
    elbow: pointToWorld(s, o.el),
    wrist: pointToWorld(s, o.wr),
    point: pointToWorld(s, o.eff),
    hand: { fd: norm(toWorld(s, o.fd)), palm: norm(toWorld(s, o.palm)), thumb: norm(toWorld(s, o.w)) },
    forearm: { dir: norm(toWorld(s, o.fa)), elbowAxis: norm(toWorld(s, o.c)), wristAxis: norm(toWorld(s, o.w1)), pron: q[I.pron] },
    report: { posError, reached: posError < 0.003, axisErrors, atLimit, strained, iterations, cost: pr.cost },
  };
}

/**
 * The stateful solver for frame-by-frame use (a bake computing the choreography frame after frame):
 * every solve starts from the last solution and stays close to it, and no joint changes by more than
 * maxStep (rad) per call (default 0.2: 12 rad/s at 60 frames per second, a fast but real arm), so
 * the arm never pops. reset() forgets the last solution.
 */
export class ArmIK {
  private last: ArmAngles | null = null;

  public constructor(public maxStep = 0.2) {}

  public solve(s: ArmSetup, target: HandTarget, maxIter?: number): ArmSolution {
    const sol = solveArm(s, target, { prev: this.last, maxIter, maxStep: this.maxStep });
    this.last = sol.angles;
    return sol;
  }

  public reset() {
    this.last = null;
  }

  public get previous(): ArmAngles | null {
    return this.last;
  }
}

/** a joint angle's limits as a description (deg), for reports and test sheets */
export function limitText(j: ArmJoint): string {
  if (j === 'flex' || j === 'abd') return 'shoulder cone';
  const r = ARM_LIMITS[j];
  return `${Math.round(r.min / DEG)}..${Math.round(r.max / DEG)}°`;
}
