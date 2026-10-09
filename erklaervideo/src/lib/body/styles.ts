// The bodies around the skeleton, in three looks to choose from:
//   puppe    a wooden drawing mannequin: egg head, ball joints, tapered limbs, chest and pelvis blocks
//   lowpoly  stylized people with clothes and hair, few faces, flat shading
//   natur    soft people with clothes, hair and shoes, smoothly shaded
// The bodies are lofts (rings along a path, each a superellipse) and ellipsoids: one piece for the
// torso, one per limb from inside the torso out to the wrist or ankle, so there are no seams where a
// real body has none. Every look builds the same vertices in the same order for a person, whatever
// the pose, so a point on the body can be followed over time.

import { V3, clamp, cross, dot, norm } from '../math';
import type { Frame, Pose } from '../people';
import { MAT, Mesh, Ring, ellipsoid, loft, tubeRings } from './mesh';

export type BodyStyle = 'puppe' | 'lowpoly' | 'natur';
export const BODY_STYLES: BodyStyle[] = ['puppe', 'lowpoly', 'natur'];

/** the look used when nothing else is asked for (tools/harness.html?body=… sets it) */
export const DEFAULT_STYLE: BodyStyle = ((globalThis as { __BODY?: BodyStyle }).__BODY ?? 'natur') as BodyStyle;

const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const dirOf = (a: V3, b: V3) => norm(sub(b, a));
/** v without its part along the unit vector d */
const across = (v: V3, d: V3) => norm(add(v, d, -dot(v, d)));

/** a frame between two frames (t 0..1), kept orthonormal */
function between(a: Frame, b: Frame, t: number): Frame {
  const r = norm(lerp3(a.r, b.r, t));
  const u = norm(cross(r, norm(lerp3(a.f, b.f, t))));
  return { r, u, f: norm(cross(u, r)) };
}

/** a cross-section in a frame (x to the right, y forward): half-widths right, left, front, back */
function ringIn(c: V3, fr: Frame, right: number, left: number, front: number, back: number, p?: number): Ring {
  return { c, x: fr.r, y: fr.f, rx: right, rx2: left, ry: front, ry2: back, p };
}

interface Detail {
  torso: number;
  limb: number;
  head: number;
  hand: number;
  foot: number;
  flat: boolean;
}
const DETAIL: Record<'lowpoly' | 'natur', Detail> = {
  lowpoly: { torso: 9, limb: 6, head: 8, hand: 5, foot: 6, flat: true },
  natur: { torso: 26, limb: 14, head: 22, hand: 10, foot: 14, flat: false },
};

/** the mesh of a person's body in a look */
export function buildBody(p: Pose, style: BodyStyle = DEFAULT_STYLE): Mesh {
  return style === 'puppe' ? puppe(p) : clothed(p, DETAIL[style]);
}

// ---------------------------------------------------------------------------------- the skeleton

function skeleton(p: Pose) {
  const J = p.joints;
  const b = p.body;
  const k = b.k;
  const pelvis = J[18];
  const neck = J[17];
  const rise = 0.5 * k; // hip joints to the base of the neck
  /** a point on the spine, h (m) above the hip joints; the chest bulges a little forward */
  const spineAt = (h: number): V3 => {
    const s = h / rise;
    const c = lerp3(pelvis, neck, s);
    const bulge = 0.02 * Math.sin(Math.PI * clamp((s - 0.2) / 0.8)) * k;
    return add(c, b.chest.f, bulge);
  };
  /** the torso's frame at height h: the pelvis below, the chest above */
  const frameAt = (h: number) => between(b.pelvis, b.chest, clamp((h / rise - 0.15) / 0.6));
  return {
    J,
    b,
    k,
    pelvis,
    neck,
    head: J[19],
    spineAt,
    frameAt,
    arms: [
      { sh: J[5], el: J[7], wr: J[9], sign: -1 },
      { sh: J[6], el: J[8], wr: J[10], sign: 1 },
    ],
    legs: [
      { hip: J[11], knee: J[13], ankle: J[15], foot: b.footL },
      { hip: J[12], knee: J[14], ankle: J[16], foot: b.footR },
    ],
  };
}
type Skeleton = ReturnType<typeof skeleton>;

/**
 * A hand as a mitten with a thumb, along the forearm. Hanging, the palm faces the thigh and the thumb
 * points forward; the higher the forearm, the more the palm turns to the front.
 */
function hand(m: Mesh, s: Skeleton, arm: Skeleton['arms'][number], sides: number, mat: number, scale = 1) {
  const { k, b } = s;
  const fd = dirOf(arm.el, arm.wr);
  const raise = clamp((dot(fd, b.chest.u) + 0.35) / 1.1);
  const medial: V3 = [b.chest.r[0] * -arm.sign, b.chest.r[1] * -arm.sign, b.chest.r[2] * -arm.sign];
  const w = across(norm(lerp3(b.chest.f, medial, raise)), fd);
  const n = norm(cross(fd, w));
  const q = k * scale;
  const at = (t: number): V3 => add(arm.wr, fd, t * q);
  const R = (c: V3, wide: number, thick: number): Ring => ({ c, x: w, y: n, rx: wide * q, ry: thick * q });
  loft(m, [R(at(-0.01), 0.026, 0.02), R(at(0.035), 0.04, 0.017), R(at(0.085), 0.043, 0.015), R(at(0.13), 0.039, 0.013), R(at(0.16), 0.03, 0.011)], sides, mat, 2.3, 0.7);
  // the thumb
  const base = add(at(0.03), w, 0.026 * q);
  const tip = add(add(at(0.085), w, 0.05 * q), n, 0.01 * q);
  loft(m, tubeRings([base, lerp3(base, tip, 0.5), tip], [0.014 * q, 0.012 * q, 0.01 * q], w), Math.max(4, sides - 4), mat, 2, 0.6);
}

/** a shoe (or a foot): heel to toe along the foot, the sole flat */
function shoe(m: Mesh, s: Skeleton, leg: Skeleton['legs'][number], sides: number, mat: number, scale = 1) {
  const { k } = s;
  const fd = leg.foot;
  const side = norm(cross(fd, [0, 1, 0]));
  const u = norm(cross(side, fd));
  const q = k * scale;
  const R = (along: number, down: number, wide: number, high: number): Ring => ({
    c: add(add(leg.ankle, fd, along * q), u, -down * q),
    x: side,
    y: u,
    rx: wide * q,
    ry: high * q,
  });
  loft(m, [R(-0.05, 0.036, 0.028, 0.03), R(-0.03, 0.032, 0.036, 0.042), R(0.04, 0.04, 0.042, 0.036), R(0.115, 0.055, 0.047, 0.023), R(0.165, 0.06, 0.036, 0.017)], sides, mat, 2.6, 0.45);
}

// ---------------------------------------------------------------------------------- puppe

function puppe(p: Pose): Mesh {
  const m = new Mesh();
  const s = skeleton(p);
  const { k, b } = s;
  const W = MAT.wood;
  const JT = MAT.joint;
  // head: an egg, the narrow end down; and the neck
  ellipsoid(m, add(add(s.head, b.head.u, 0.006 * k), b.head.f, 0.004 * k), b.head.r, b.head.u, b.head.f, 0.07 * k, 0.1 * k, 0.083 * k, 18, 14, W);
  loft(m, tubeRings([add(s.neck, b.chest.u, -0.03 * k), add(s.head, b.head.u, -0.07 * k)], [0.031 * k, 0.028 * k], b.chest.r), 12, W, 2, 0.2);
  // chest, waist joint, pelvis
  const block = (sec: [number, number, number, number][], mat: number) =>
    loft(
      m,
      sec.map(([h, w, front, back]) => ringIn(s.spineAt(h * k), s.frameAt(h * k), w * k, w * k, front * k, back * k)),
      20,
      mat,
      2.7,
      0.3,
    );
  block([[0.26, 0.11, 0.08, 0.072], [0.33, 0.148, 0.102, 0.086], [0.41, 0.166, 0.096, 0.088], [0.465, 0.152, 0.078, 0.076], [0.505, 0.095, 0.054, 0.054]], W);
  ellipsoid(m, s.spineAt(0.205 * k), b.pelvis.r, b.spine, b.pelvis.f, 0.084 * k, 0.062 * k, 0.07 * k, 14, 10, JT);
  block([[0.15, 0.105, 0.072, 0.068], [0.07, 0.138, 0.085, 0.088], [-0.03, 0.148, 0.086, 0.1], [-0.1, 0.09, 0.06, 0.07]], W);
  // joints and limbs: spindles between balls, with a little gap
  const ball = (c: V3, r: number) => ellipsoid(m, c, b.chest.r, [0, 1, 0], b.chest.f, r * k, r * k, r * k, 12, 9, JT);
  const limb = (a: V3, c: V3, ra: number, rc: number, gapA: number, gapC: number, side: V3) => {
    const d = dirOf(a, c);
    const a2 = add(a, d, gapA * k);
    const c2 = add(c, d, -gapC * k);
    const pts = [a2, lerp3(a2, c2, 0.22), lerp3(a2, c2, 0.5), lerp3(a2, c2, 0.8), c2];
    const radii = [ra, ra * 1.13, ((ra + rc) / 2) * 1.08, rc * 1.06, rc].map((r) => r * k);
    loft(m, tubeRings(pts, radii, side), 14, W, 2, 0.55);
  };
  for (const a of s.arms) {
    ball(a.sh, 0.044);
    ball(a.el, 0.033);
    ball(a.wr, 0.024);
    limb(a.sh, a.el, 0.036, 0.029, 0.04, 0.03, b.chest.r);
    limb(a.el, a.wr, 0.029, 0.022, 0.03, 0.022, b.chest.r);
    hand(m, s, a, 10, W, 0.95);
  }
  for (const l of s.legs) {
    ball(l.hip, 0.054);
    ball(l.knee, 0.042);
    ball(l.ankle, 0.03);
    limb(l.hip, l.knee, 0.058, 0.044, 0.05, 0.04, b.pelvis.r);
    limb(l.knee, l.ankle, 0.043, 0.03, 0.04, 0.03, b.pelvis.r);
    shoe(m, s, l, 12, W, 0.95);
  }
  return m;
}

// ---------------------------------------------------------------------------------- lowpoly, natur

// torso cross-sections, bottom to top: height above the hip joints, half width, front, back (m for a
// person of 1.75 m), and what covers the part from this one up to the next
type Sec = [number, number, number, number, 'pants' | 'top'];
const TORSO_MALE: Sec[] = [
  [-0.07, 0.05, 0.05, 0.07, 'pants'],
  [-0.05, 0.11, 0.074, 0.095, 'pants'],
  [-0.036, 0.162, 0.08, 0.106, 'top'], // the shirt hangs over the hips
  [-0.026, 0.192, 0.104, 0.116, 'top'],
  [0.09, 0.168, 0.102, 0.1, 'top'],
  [0.17, 0.154, 0.102, 0.09, 'top'],
  [0.26, 0.158, 0.108, 0.091, 'top'],
  [0.34, 0.167, 0.116, 0.097, 'top'],
  [0.41, 0.172, 0.106, 0.099, 'top'],
  [0.455, 0.178, 0.092, 0.092, 'top'],
  [0.49, 0.176, 0.076, 0.082, 'top'], // the line of the shoulders
  [0.525, 0.104, 0.06, 0.066, 'top'],
  [0.552, 0.062, 0.052, 0.054, 'top'],
];
const TORSO_FEMALE: Sec[] = [
  [-0.095, 0.05, 0.035, 0.062, 'pants'],
  [-0.07, 0.105, 0.05, 0.094, 'pants'],
  [-0.02, 0.172, 0.074, 0.116, 'pants'],
  [0.03, 0.176, 0.09, 0.108, 'pants'],
  [0.12, 0.13, 0.083, 0.08, 'top'],
  [0.2, 0.134, 0.088, 0.079, 'top'],
  [0.27, 0.144, 0.106, 0.083, 'top'],
  [0.33, 0.149, 0.12, 0.087, 'top'],
  [0.39, 0.153, 0.103, 0.089, 'top'],
  [0.445, 0.162, 0.082, 0.082, 'top'],
  [0.48, 0.16, 0.066, 0.072, 'top'],
  [0.512, 0.092, 0.052, 0.058, 'top'],
  [0.535, 0.055, 0.047, 0.048, 'top'],
];
// the head, chin to crown: height above the head joint, forward shift, half width, front, back
type HeadSec = [number, number, number, number, number];
const HEAD: HeadSec[] = [
  [-0.104, 0.058, 0.022, 0.016, 0.02],
  [-0.094, 0.045, 0.039, 0.033, 0.034],
  [-0.072, 0.026, 0.055, 0.054, 0.05],
  [-0.04, 0.009, 0.065, 0.077, 0.07],
  [-0.006, -0.004, 0.072, 0.091, 0.087],
  [0.03, -0.01, 0.076, 0.094, 0.097],
  [0.064, -0.016, 0.073, 0.087, 0.103],
  [0.094, -0.022, 0.06, 0.066, 0.09],
  [0.112, -0.026, 0.034, 0.036, 0.052],
];
// hair over the head (at the front it stays inside the forehead, so the hairline is where it comes out)
const HAIR_SHORT: HeadSec[] = [
  [-0.07, -0.032, 0.052, 0.03, 0.072],
  [-0.03, -0.024, 0.068, 0.058, 0.092],
  [0.02, -0.016, 0.079, 0.074, 0.106],
  [0.06, -0.016, 0.081, 0.08, 0.11],
  [0.092, -0.02, 0.075, 0.081, 0.103],
  [0.115, -0.024, 0.06, 0.068, 0.087],
  [0.131, -0.026, 0.036, 0.042, 0.054],
];
const HAIR_LONG: HeadSec[] = [
  [-0.08, -0.034, 0.083, 0.03, 0.084],
  [-0.03, -0.024, 0.087, 0.058, 0.098],
  [0.02, -0.016, 0.086, 0.074, 0.108],
  [0.06, -0.016, 0.083, 0.081, 0.111],
  [0.092, -0.02, 0.076, 0.082, 0.104],
  [0.115, -0.024, 0.061, 0.069, 0.088],
  [0.131, -0.026, 0.037, 0.043, 0.055],
];
const HAIR_CURLY: HeadSec[] = [
  [-0.06, -0.036, 0.07, 0.03, 0.09],
  [-0.02, -0.03, 0.096, 0.06, 0.12],
  [0.03, -0.022, 0.106, 0.086, 0.132],
  [0.075, -0.02, 0.104, 0.1, 0.13],
  [0.112, -0.024, 0.09, 0.09, 0.114],
  [0.14, -0.028, 0.064, 0.064, 0.082],
  [0.157, -0.03, 0.034, 0.036, 0.044],
];

function clothed(p: Pose, d: Detail): Mesh {
  const m = new Mesh();
  m.flat = d.flat;
  const s = skeleton(p);
  const { k, b } = s;
  const spec = p.spec;
  const fem = !!spec.female;
  const dress = !!spec.dress;
  const top = dress ? MAT.dress : MAT.shirt;

  // torso: one piece from the crotch to the collar, pants below and the top above
  const torso = fem ? TORSO_FEMALE : TORSO_MALE;
  loft(
    m,
    torso.map(([h, w, front, back]) => ringIn(s.spineAt(h * k), s.frameAt(h * k), w * k, w * k, front * k, back * k)),
    d.torso,
    torso.slice(0, -1).map((sec) => (sec[4] === 'top' || dress ? top : MAT.pants)),
    2.25,
    0.25,
  );

  // a dress: from the waist down over the knees, wide enough that the legs stay inside
  if (dress) {
    const pf = b.pelvis;
    const kL = s.legs[0].knee;
    const kR = s.legs[1].knee;
    const hemY = Math.min(kL[1], kR[1]) - 0.03 * k;
    const mid = lerp3(kL, kR, 0.5);
    const hemC: V3 = [mid[0], hemY, mid[2]];
    const dx = Math.abs(dot(sub(kL, kR), pf.r)) / 2;
    const dz = Math.abs(dot(sub(kL, kR), pf.f)) / 2;
    const hw = Math.max(0.2 * k, dx + 0.085 * k);
    const hf = Math.max(0.16 * k, dz + 0.1 * k);
    const hip = s.spineAt(-0.02 * k);
    const midC = lerp3(hip, hemC, 0.5);
    loft(
      m,
      [
        ringIn(s.spineAt(0.13 * k), s.frameAt(0.13 * k), 0.136 * k, 0.136 * k, 0.088 * k, 0.085 * k),
        ringIn(s.spineAt(0.05 * k), s.frameAt(0.05 * k), 0.178 * k, 0.178 * k, 0.1 * k, 0.116 * k),
        ringIn(hip, pf, 0.19 * k, 0.19 * k, 0.104 * k, 0.126 * k),
        ringIn(midC, pf, (0.19 * k + hw) / 2 + 0.006 * k, (0.19 * k + hw) / 2 + 0.006 * k, (0.104 * k + hf) / 2 + 0.008 * k, (0.126 * k + hf) / 2 + 0.008 * k),
        ringIn(hemC, pf, hw, hw, hf, hf + 0.01 * k),
      ],
      d.torso,
      MAT.dress,
      2.1,
      0,
    );
  }

  // neck and head
  const neckR = (fem ? 0.047 : 0.055) * k;
  loft(
    m,
    tubeRings(
      [add(s.neck, b.chest.u, -0.06 * k), add(add(s.neck, b.chest.u, 0.045 * k), b.chest.f, 0.004 * k), add(add(s.head, b.head.u, -0.045 * k), b.head.f, -0.012 * k)],
      [neckR, neckR * 0.96, neckR * 0.9],
      b.chest.r,
    ),
    d.limb,
    MAT.skin,
    2,
    0.2,
  );
  const hk = (fem ? 0.95 : 1) * k;
  const headRings = (secs: HeadSec[]) =>
    secs.map(([h, fwd, w, front, back]) => ringIn(add(add(s.head, b.head.u, h * k), b.head.f, fwd * k), b.head, w * hk, w * hk, front * hk, back * hk));
  loft(m, headRings(HEAD), d.head, MAT.skin, 2.15, 0.45);
  if (!d.flat && (spec.hair ?? 'short') === 'short') {
    // the ears (longer hair covers them); no face: the people stay anonymous
    for (const side of [-1, 1]) ellipsoid(m, add(add(s.head, b.head.r, side * 0.074 * hk), b.head.f, -0.006 * k), b.head.r, b.head.u, b.head.f, 0.011 * hk, 0.03 * hk, 0.02 * hk, 8, 6, MAT.skin);
  }
  // hair
  const hair = spec.hair === 'curly' ? HAIR_CURLY : spec.hair === 'long' ? HAIR_LONG : HAIR_SHORT;
  loft(m, headRings(hair), d.head, MAT.hair, 2.1, 0.3);
  if (spec.hair === 'long') {
    // down the back to the shoulder blades
    const c = b.chest;
    const r1 = ringIn(add(add(s.head, b.head.u, -0.13 * k), b.head.f, -0.055 * k), b.head, 0.085 * hk, 0.085 * hk, 0.03 * k, 0.07 * k);
    const r2 = ringIn(add(add(s.neck, c.u, -0.04 * k), c.f, -0.07 * k), c, 0.092 * k, 0.092 * k, 0.02 * k, 0.045 * k);
    const r3 = ringIn(add(add(s.neck, c.u, -0.17 * k), c.f, -0.088 * k), c, 0.078 * k, 0.078 * k, 0.014 * k, 0.03 * k);
    loft(m, [headRings(HAIR_LONG)[1], r1, r2, r3], d.head, MAT.hair, 2.2, 0.4);
  }

  // arms: from inside the torso over the shoulder; sleeves, then skin
  const longSleeves = spec.sleeves === 'long';
  const ak = (fem ? 0.88 : 1) * k;
  for (const a of s.arms) {
    const up = sub(a.el, a.sh);
    const fa = sub(a.wr, a.el);
    // from just above the shoulder joint (its dome is the round top of the shoulder) down the arm
    const pts: V3[] = [a.sh, add(a.sh, up, 0.08), add(a.sh, up, 0.22)];
    const radii = [0.045, 0.05, 0.049];
    const mats: number[] = [top, top];
    if (longSleeves) {
      pts.push(add(a.sh, up, 0.6), a.el, add(a.el, fa, 0.3), add(a.el, fa, 0.85), add(a.el, fa, 0.9), a.wr);
      radii.push(0.048, 0.043, 0.046, 0.038, 0.029, 0.027);
      mats.push(top, top, top, top, top, top, MAT.skin);
    } else {
      pts.push(add(a.sh, up, 0.42), add(a.sh, up, 0.44), add(a.sh, up, 0.7), a.el, add(a.el, fa, 0.25), add(a.el, fa, 0.65), a.wr);
      radii.push(0.05, 0.042, 0.041, 0.035, 0.04, 0.032, 0.026);
      mats.push(top, top, MAT.skin, MAT.skin, MAT.skin, MAT.skin, MAT.skin);
    }
    loft(m, tubeRings(pts, radii.map((r) => r * ak), b.chest.f), d.limb, mats, 2, 0.5);
    hand(m, s, a, d.hand, MAT.skin, fem ? 0.86 : 0.93);
  }

  // legs: from inside the pelvis to the ankle; then the shoes
  for (const l of s.legs) {
    const th = sub(l.knee, l.hip);
    const sh = sub(l.ankle, l.knee);
    const pts: V3[] = [add(l.hip, b.spine, (dress ? -0.02 : 0.03) * k), l.hip, add(l.hip, th, 0.3), add(l.hip, th, 0.65), l.knee, add(l.knee, sh, 0.3), add(l.knee, sh, 0.72), add(l.knee, sh, 0.97)];
    const radii = dress ? [0.06, 0.068, 0.066, 0.058, 0.046, 0.05, 0.035, 0.03] : [0.066, 0.082, 0.082, 0.067, 0.056, 0.056, 0.047, 0.045];
    loft(m, tubeRings(pts, radii.map((r) => r * k), b.pelvis.r), d.limb, dress ? MAT.skin : MAT.pants, 2, 0.2);
    shoe(m, s, l, d.foot, MAT.shoes, fem ? 0.93 : 1);
  }
  return m;
}
