// The bodies around the skeleton, in two looks:
//   lowpoly  stylized people with clothes and hair, few faces, flat shading (the one the video uses)
//   natur    the same people with many faces, smoothly shaded
// The bodies are lofts (rings along a path, each a superellipse) and ellipsoids: one piece for the
// torso, one per limb from inside the torso out to the wrist or ankle, so there are no seams where a
// real body has none. Every look builds the same vertices in the same order for a person, whatever
// the pose, so a point on the body can be followed over time.

import { V3, clamp, cross, dot, norm } from '../math';
import type { Frame, Pose } from '../people';
import { MAT, Mesh, Ring, ellipsoid, loft, tubeRings } from './mesh';

export type BodyStyle = 'lowpoly' | 'natur';
export const BODY_STYLES: BodyStyle[] = ['lowpoly', 'natur'];

/** the look used when nothing else is asked for (tools/harness.html?body=… sets it) */
export const DEFAULT_STYLE: BodyStyle = ((globalThis as { __BODY?: BodyStyle }).__BODY ?? 'lowpoly') as BodyStyle;

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
const DETAIL: Record<BodyStyle, Detail> = {
  lowpoly: { torso: 9, limb: 6, head: 8, hand: 5, foot: 6, flat: true },
  natur: { torso: 26, limb: 14, head: 22, hand: 10, foot: 14, flat: false },
};

/** the mesh of a person's body in a look */
export function buildBody(p: Pose, style: BodyStyle = DEFAULT_STYLE): Mesh {
  return clothed(p, DETAIL[style] ?? DETAIL.lowpoly);
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

/** a shoe: heel to toe along the foot, the sole flat on the floor; chunky ones are wider and higher */
function shoe(m: Mesh, s: Skeleton, leg: Skeleton['legs'][number], sides: number, mat: number, scale = 1, chunky = false) {
  const { k } = s;
  const fd = leg.foot;
  const side = norm(cross(fd, [0, 1, 0]));
  const u = norm(cross(side, fd));
  const q = k * scale;
  const up = chunky ? 0.008 : 0;
  const R = (along: number, down: number, wide: number, high: number): Ring => ({
    c: add(add(leg.ankle, fd, along * q), u, -(down - up) * q),
    x: side,
    y: u,
    rx: wide * q * (chunky ? 1.12 : 1),
    ry: (high + up) * q,
  });
  loft(m, [R(-0.05, 0.036, 0.028, 0.03), R(-0.03, 0.032, 0.036, 0.042), R(0.04, 0.04, 0.042, 0.036), R(0.115, 0.055, 0.047, 0.023), R(0.165, 0.06, 0.036, 0.017)], sides, mat, 2.6, 0.45);
}

// ---------------------------------------------------------------------------------- the people

// torso cross-sections, bottom to top: height above the hip joints, half width, front, back (m for a
// person of 1.75 m), and what covers the part from this one up to the next. The torso ends at the
// hips: below, the two legs are the pants, so the crotch is simply where the legs part.
type Sec = [number, number, number, number, 'pants' | 'top'];
const TORSO_MALE: Sec[] = [
  [-0.042, 0.13, 0.07, 0.09, 'top'], // the legs fill the hips; the shirt hangs loose over them
  [-0.036, 0.168, 0.08, 0.106, 'top'],
  [-0.026, 0.2, 0.106, 0.118, 'top'],
  [0.03, 0.196, 0.106, 0.112, 'top'],
  [0.1, 0.174, 0.103, 0.1, 'top'],
  [0.17, 0.154, 0.102, 0.09, 'top'],
  [0.26, 0.158, 0.108, 0.091, 'top'],
  [0.34, 0.167, 0.116, 0.097, 'top'],
  [0.41, 0.172, 0.106, 0.099, 'top'],
  [0.455, 0.178, 0.092, 0.092, 'top'],
  [0.49, 0.176, 0.076, 0.082, 'top'], // the line of the shoulders
  [0.525, 0.104, 0.06, 0.066, 'top'],
  [0.552, 0.062, 0.052, 0.054, 'top'],
];
// a wide, boxy shirt tucked into high-waisted pants (with the hips and shoulders of a woman)
const TORSO_BOXY: Sec[] = [
  [0.0, 0.12, 0.07, 0.09, 'pants'], // below, the legs make the hips
  [0.03, 0.178, 0.09, 0.11, 'pants'],
  [0.11, 0.142, 0.086, 0.086, 'pants'], // the high waistband
  [0.15, 0.138, 0.085, 0.083, 'top'],
  [0.17, 0.158, 0.1, 0.094, 'top'], // the shirt puffs out over it
  [0.24, 0.17, 0.108, 0.096, 'top'],
  [0.31, 0.176, 0.12, 0.098, 'top'],
  [0.38, 0.178, 0.12, 0.098, 'top'],
  [0.44, 0.176, 0.1, 0.095, 'top'],
  [0.48, 0.168, 0.074, 0.078, 'top'], // dropped shoulders
  [0.512, 0.1, 0.055, 0.062, 'top'],
  [0.535, 0.058, 0.049, 0.05, 'top'],
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
// pulled back tight into a ponytail
const HAIR_PULLED: HeadSec[] = [
  [-0.08, -0.034, 0.058, 0.03, 0.078],
  [-0.03, -0.024, 0.072, 0.058, 0.094],
  [0.02, -0.016, 0.078, 0.074, 0.105],
  [0.06, -0.016, 0.079, 0.079, 0.108],
  [0.092, -0.02, 0.073, 0.08, 0.101],
  [0.115, -0.024, 0.058, 0.066, 0.085],
  [0.131, -0.026, 0.035, 0.041, 0.053],
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
  const top = spec.top ?? 'tee';
  const wide = spec.pants === 'wide';
  const hairStyle = spec.hair ?? 'short';

  // torso: one piece from the crotch to the collar, pants below and the top above
  const torso = top === 'boxy' ? TORSO_BOXY : TORSO_MALE;
  loft(
    m,
    torso.map(([h, w, front, back]) => ringIn(s.spineAt(h * k), s.frameAt(h * k), w * k, w * k, front * k, back * k)),
    d.torso,
    torso.slice(0, -1).map((sec) => (sec[4] === 'top' ? MAT.shirt : MAT.pants)),
    top === 'boxy' ? 2.5 : 2.25,
    0.25,
  );

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
  if (!d.flat && hairStyle !== 'curly') {
    // the ears (curls cover them); no face: the people stay anonymous
    for (const side of [-1, 1]) ellipsoid(m, add(add(s.head, b.head.r, side * 0.074 * hk), b.head.f, -0.006 * k), b.head.r, b.head.u, b.head.f, 0.011 * hk, 0.03 * hk, 0.02 * hk, 8, 6, MAT.skin);
  }
  // hair
  const hair = hairStyle === 'curly' ? HAIR_CURLY : hairStyle === 'ponytail' ? HAIR_PULLED : HAIR_SHORT;
  loft(m, headRings(hair), d.head, MAT.hair, 2.1, 0.3);
  if (hairStyle === 'ponytail') {
    // tied high at the back of the head, hanging down behind the neck
    const back = norm([-b.head.f[0], 0, -b.head.f[2]]);
    const down: V3 = [0, -1, 0];
    const base = add(add(s.head, b.head.u, 0.07 * k), b.head.f, -0.085 * hk);
    const along = (bk: number, dn: number) => add(add(base, back, bk * k), down, dn * k);
    loft(
      m,
      tubeRings([along(-0.03, -0.01), base, along(0.035, 0.035), along(0.05, 0.11), along(0.045, 0.19), along(0.03, 0.26)], [0.026, 0.028, 0.034, 0.031, 0.025, 0.013].map((r) => r * k), b.head.r),
      d.limb,
      MAT.hair,
      2,
      0.5,
    );
  }

  // arms: from the shoulder joint (its dome is the round top of the shoulder) down to the wrist;
  // sleeves first, then skin
  const ak = (fem ? 0.88 : 1) * k;
  for (const a of s.arms) {
    const up = sub(a.el, a.sh);
    const fa = sub(a.wr, a.el);
    const pts: V3[] = [a.sh, add(a.sh, up, 0.08), add(a.sh, up, 0.22)];
    const radii = [0.045, 0.05, 0.049];
    const mats: number[] = [MAT.shirt, MAT.shirt];
    if (top === 'sweater') {
      pts.push(add(a.sh, up, 0.6), a.el, add(a.el, fa, 0.3), add(a.el, fa, 0.85), add(a.el, fa, 0.9), a.wr);
      radii.push(0.048, 0.043, 0.046, 0.038, 0.029, 0.027);
      mats.push(MAT.shirt, MAT.shirt, MAT.shirt, MAT.shirt, MAT.shirt, MAT.shirt, MAT.skin);
    } else if (top === 'boxy') {
      // a wide sleeve to the middle of the upper arm, the arm comes out of it
      pts.push(add(a.sh, up, 0.4), add(a.sh, up, 0.56), add(a.sh, up, 0.57), add(a.sh, up, 0.75), a.el, add(a.el, fa, 0.25), add(a.el, fa, 0.65), a.wr);
      radii.push(0.053, 0.058, 0.04, 0.04, 0.035, 0.039, 0.031, 0.026);
      mats.push(MAT.shirt, MAT.shirt, MAT.shirt, MAT.skin, MAT.skin, MAT.skin, MAT.skin, MAT.skin);
    } else {
      pts.push(add(a.sh, up, 0.42), add(a.sh, up, 0.44), add(a.sh, up, 0.7), a.el, add(a.el, fa, 0.25), add(a.el, fa, 0.65), a.wr);
      radii.push(0.05, 0.042, 0.041, 0.035, 0.04, 0.032, 0.026);
      mats.push(MAT.shirt, MAT.shirt, MAT.skin, MAT.skin, MAT.skin, MAT.skin, MAT.skin);
    }
    loft(m, tubeRings(pts, radii.map((r) => r * ak), b.chest.f), d.limb, mats, 2, 0.5);
    hand(m, s, a, d.hand, MAT.skin, fem ? 0.86 : 0.93);
  }

  // legs: from inside the pelvis to the ankle (wide pants down over the shoes); then the shoes. At
  // the hip joints they are as wide as half the hips and touch in the middle.
  for (const l of s.legs) {
    const th = sub(l.knee, l.hip);
    const sh = sub(l.ankle, l.knee);
    const pts: V3[] = [add(l.hip, b.spine, 0.06 * k), l.hip, add(l.hip, th, 0.3), add(l.hip, th, 0.65), l.knee, add(l.knee, sh, 0.3), add(l.knee, sh, 0.72), add(l.knee, sh, wide ? 1.07 : 0.97)];
    const radii = wide ? [0.078, 0.096, 0.091, 0.086, 0.083, 0.086, 0.093, 0.1] : [0.06, 0.084, 0.082, 0.067, 0.056, 0.056, 0.047, 0.045];
    loft(m, tubeRings(pts, radii.map((r) => r * k), b.pelvis.r), d.limb, MAT.pants, 2, wide ? 0.05 : 0.2);
    shoe(m, s, l, d.foot, MAT.shoes, fem ? 0.93 : 1, wide);
  }
  return m;
}
