// The bodies around the skeleton: low-poly people with clothes, hair and hands with fingers, built
// from lofts (rings along a path, each a superellipse) and ellipsoids. One piece for the torso, one
// per limb from inside the torso out to the wrist or ankle, so there are no seams where a real body
// has none. Ported from erklaervideo/src/lib/body/styles.ts and extended: body shapes (Build), work
// clothes (overshirt, open work jacket, lanyard with a crew pass), hair styles, a fitted sport hijab,
// cap, beard, glasses, gloves (work gloves and fingerless rigger gloves with a light palm and a dark
// back), painted nails, and the first-person split (the own head, torso and upper arms carry the
// layer SELF).
//
// A person always gives the same vertices and faces in the same order, whatever the pose, so a mesh
// is built once and then refilled in place (buildBody(pose, mesh)).

import { RGB, V3, across, add, clamp, cross, dot, hexRgb, lerp, local, madd, mix3, norm, scale, smooth, sub } from '../math';
import type { Frame, HandPose, PersonSpec, Pose } from '../people';
import { FINGERS, PALM_RINGS, THUMB, handJoints } from './hand';
import { MAT, MAT_COUNT, MatName, Mesh, Ring, SELF, ellipsoid, facing, loft, orientRings, tubeRings } from './mesh';

/** sides per loft */
const D = { torso: 16, limb: 10, neck: 10, head: 14, palm: 10, finger: 8, foot: 10, small: 6 };

/** the mesh of a person in a pose; pass the mesh of an earlier frame to refill it in place */
export function buildBody(p: Pose, into = new Mesh()): Mesh {
  into.begin();
  clothed(into, p);
  into.end();
  return into;
}

// ---------------------------------------------------------------------------------- colours

const shade = (c: RGB, f: number): RGB => [c[0] * f, c[1] * f, c[2] * f];
const blend = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** colours per material (MAT order, sRGB 0..1); what the spec leaves out is derived */
export function paletteOf(spec: PersonSpec): RGB[] {
  const c = spec.colors;
  const skin = hexRgb(c.skin);
  const hair = hexRgb(c.hair);
  const top = hexRgb(c.top);
  const pants = hexRgb(c.pants);
  const shoes = hexRgb(c.shoes);
  const derived: Record<MatName, RGB> = {
    skin,
    top,
    top2: shade(top, 0.8),
    pants,
    pants2: shade(pants, 0.84),
    shoes,
    sole: spec.shoes === 'sneakers' ? [0.93, 0.92, 0.9] : shade(shoes, 0.55),
    hair,
    hair2: blend(hair, skin, 0.35),
    nails: blend(skin, [0.97, 0.84, 0.8], 0.4),
    glove: [0.36, 0.38, 0.4],
    glove2: [0.16, 0.17, 0.18],
    pad: [0.17, 0.17, 0.18],
    cap: top,
    hijab: top,
    frame: [0.16, 0.15, 0.15],
    accent: [0.94, 0.93, 0.9],
    dye: hair,
  };
  const out: RGB[] = new Array(MAT_COUNT);
  for (const [name, i] of Object.entries(MAT) as [MatName, number][]) out[i] = c[name] ? hexRgb(c[name] as string) : derived[name];
  return out;
}

// ---------------------------------------------------------------------------------- the skeleton

/** a frame between two frames (t 0..1), kept orthonormal */
function between(a: Frame, b: Frame, t: number): Frame {
  const r = norm(mix3(a.r, b.r, t));
  const u = norm(cross(r, norm(mix3(a.f, b.f, t))));
  return { r, u, f: norm(cross(u, r)) };
}

/** a cross-section in a frame (x to the right, y forward): half-widths right, left, front, back */
function ringIn(c: V3, fr: Frame, right: number, left: number, front: number, back: number, p?: number): Ring {
  return { c, x: fr.r, y: fr.f, rx: right, rx2: left, ry: front, ry2: back, p };
}

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
    const c = mix3(pelvis, neck, s);
    const bulge = 0.02 * Math.sin(Math.PI * clamp((s - 0.2) / 0.8)) * k;
    return madd(c, b.chest.f, bulge);
  };
  /** the torso's frame at height h: the pelvis below, the chest above */
  const frameAt = (h: number) => between(b.pelvis, b.chest, clamp((h / rise - 0.15) / 0.6));
  return {
    b,
    k,
    B: p.spec.build,
    pelvis,
    neck,
    head: J[19],
    spineAt,
    frameAt,
    arms: [
      { sh: J[5], el: J[7], wr: J[9], sign: -1, hand: b.hands[0] },
      { sh: J[6], el: J[8], wr: J[10], sign: 1, hand: b.hands[1] },
    ],
    legs: [
      { hip: J[11], knee: J[13], ankle: J[15], foot: b.footL, sign: -1 },
      { hip: J[12], knee: J[14], ankle: J[16], foot: b.footR, sign: 1 },
    ],
  };
}
type Skeleton = ReturnType<typeof skeleton>;

/** 0 outside [a, b], 1 in the middle, smooth */
const bump = (h: number, a: number, b: number) => Math.sin(Math.PI * clamp((h - a) / (b - a))) ** 2;

// ---------------------------------------------------------------------------------- tables

// torso cross-sections, bottom to top: height above the hip joints, half width, front, back (m for the
// base body of 1.75 m). The torso ends at the hips: below, the two legs are the trousers, so the crotch
// is simply where the legs part. Segment 0 closes the bottom, 1-2 are the hem band, 4-5 the belly.
type Row = [number, number, number, number];
const TORSO: Row[] = [
  [-0.045, 0.12, 0.07, 0.09],
  [-0.04, 0.188, 0.1, 0.113],
  [-0.026, 0.193, 0.106, 0.117],
  [-0.012, 0.193, 0.107, 0.117],
  [0.03, 0.19, 0.106, 0.112],
  [0.1, 0.174, 0.103, 0.1],
  [0.17, 0.154, 0.102, 0.09],
  [0.26, 0.158, 0.108, 0.091],
  [0.34, 0.167, 0.116, 0.097],
  [0.41, 0.172, 0.106, 0.099],
  [0.455, 0.178, 0.092, 0.092],
  [0.49, 0.176, 0.076, 0.082], // the line of the shoulders
  [0.525, 0.104, 0.06, 0.066],
  [0.552, 0.062, 0.052, 0.054],
];

// head and everything on it, chin to crown: height above the head joint, forward shift, half width,
// front, back (m, base head)
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
// hair over the head: at the front it stays inside the forehead, so the hairline is where it comes out
const HAIR_SHORT: HeadSec[] = [
  [-0.07, -0.032, 0.052, 0.03, 0.072],
  [-0.03, -0.024, 0.068, 0.058, 0.092],
  [0.02, -0.016, 0.079, 0.074, 0.106],
  [0.06, -0.016, 0.081, 0.08, 0.11],
  [0.092, -0.02, 0.075, 0.081, 0.103],
  [0.115, -0.024, 0.06, 0.068, 0.087],
  [0.131, -0.026, 0.036, 0.042, 0.054],
];
// close to the head (buzz cut, the shaved sides of an undercut)
const HAIR_BUZZ: HeadSec[] = [
  [-0.06, -0.012, 0.06, 0.03, 0.075],
  [-0.03, -0.012, 0.07, 0.05, 0.088],
  [0.02, -0.012, 0.079, 0.07, 0.1],
  [0.06, -0.016, 0.077, 0.078, 0.106],
  [0.092, -0.021, 0.064, 0.072, 0.094],
  [0.113, -0.025, 0.044, 0.05, 0.062],
  [0.127, -0.026, 0.022, 0.024, 0.03],
];
// the longer top of an undercut, swept up and forward into a tousled quiff
const HAIR_TOP: HeadSec[] = [
  [0.045, -0.02, 0.074, 0.07, 0.092],
  [0.08, -0.012, 0.08, 0.095, 0.104],
  [0.112, -0.008, 0.074, 0.098, 0.096],
  [0.14, -0.008, 0.058, 0.09, 0.078],
  [0.162, -0.012, 0.034, 0.064, 0.05],
  [0.172, -0.014, 0.012, 0.024, 0.016],
];
// pulled back tight (ponytail, bun)
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
// a pixie cut: close at the nape and over the ears, fuller on top, a short fringe over the forehead
const HAIR_PIXIE: HeadSec[] = [
  [-0.055, -0.03, 0.062, 0.03, 0.078],
  [-0.02, -0.024, 0.077, 0.056, 0.096],
  [0.025, -0.016, 0.084, 0.078, 0.108],
  [0.058, -0.012, 0.085, 0.094, 0.114],
  [0.088, -0.016, 0.08, 0.094, 0.108],
  [0.114, -0.022, 0.066, 0.08, 0.092],
  [0.134, -0.026, 0.04, 0.05, 0.058],
];
// a cap's crown, a little outside the hair
const CAP: HeadSec[] = [
  [0.035, -0.012, 0.088, 0.104, 0.122],
  [0.07, -0.014, 0.087, 0.103, 0.124],
  [0.1, -0.018, 0.079, 0.095, 0.114],
  [0.125, -0.022, 0.062, 0.077, 0.092],
  [0.143, -0.025, 0.035, 0.047, 0.055],
];
// a short full beard along the jaw (at the back it stays inside the head)
// (the cheeks stay free: up there the front is inside the face, only the sides come out)
const BEARD: HeadSec[] = [
  [0.008, -0.008, 0.078, 0.05, 0.04],
  [-0.028, 0.0, 0.072, 0.07, 0.04],
  [-0.05, 0.016, 0.066, 0.078, 0.036],
  [-0.074, 0.03, 0.058, 0.064, 0.034],
  [-0.094, 0.044, 0.045, 0.045, 0.032],
  [-0.111, 0.05, 0.026, 0.026, 0.028],
];
// a fitted sport hijab over the head, snug at the face and over the ears, a little fuller at the back
// (over the hair); bottom to top like HEAD, sampled at HIJAB_ROWS. The low rows reach back far
// enough to cover the neck, which sits behind the head joint.
const HIJAB: HeadSec[] = [
  [-0.05, 0.013, 0.066, 0.08, 0.096],
  [-0.03, 0.005, 0.071, 0.088, 0.096],
  [-0.01, -0.002, 0.077, 0.097, 0.1],
  [0.02, -0.009, 0.082, 0.099, 0.11],
  [0.05, -0.013, 0.082, 0.095, 0.115],
  [0.078, -0.018, 0.078, 0.086, 0.112],
  [0.098, -0.021, 0.072, 0.078, 0.104],
  [0.116, -0.024, 0.062, 0.066, 0.088],
  [0.13, -0.026, 0.046, 0.05, 0.064],
];
/** heights of the hijab's rings over the head, top to bottom: fine around the face for a smooth edge */
const HIJAB_ROWS = [0.13, 0.116, 0.098, 0.082, 0.07, 0.06, 0.05, 0.04, 0.03, 0.02, 0.01, 0.0, -0.01, -0.02, -0.03, -0.04, -0.05];
/**
 * … then under the chin and around the neck into the collar: rings around the neck's axis, top to
 * bottom: position on the axis (0 the neck joint, 1 the top of the neck), and how far the fabric
 * stands off the neck: sides, front, back (m, base body). The top ring passes behind the chin.
 */
const HIJAB_NECK: [number, number, number, number][] = [
  [0.6, 0.012, 0.03, 0.012],
  [0.35, 0.008, 0.02, 0.01],
  [0.1, 0.01, 0.014, 0.012],
  [-0.2, 0.016, 0.01, 0.01],
];
/**
 * The face in the hijab, an oval over the head: centre height and half height (m above the head
 * joint, base head), half width as the angle from straight ahead (rad), and the soft edge: from
 * `edge[1]` in to `edge[0]` (in oval radii) the fabric comes down onto the face and lies on it, then
 * tucks in under the face's surface.
 */
const FACE = { h: -0.02, hh: 0.084, phi: 1.15, edge: [0.8, 1.12] };
/** sides of the hijab's rings */
const HIJAB_SIDES = 40;

/** a cross-section of `secs` (sorted bottom to top) at height h, linear between its rows */
function secAt(secs: HeadSec[], h: number): HeadSec {
  if (h <= secs[0][0]) return secs[0];
  for (let j = 1; j < secs.length; j++) {
    if (h <= secs[j][0]) {
      const a = secs[j - 1];
      const b = secs[j];
      const t = (h - a[0]) / (b[0] - a[0]);
      return a.map((v, i) => lerp(v, b[i], t)) as HeadSec;
    }
  }
  return secs[secs.length - 1];
}

// arms: position along the arm (0 shoulder, 1 elbow, 2 wrist), radius (m, base body), and what
// covers the segment from this point on
type ArmPt = [number, number, number];
const ARM_TEE: ArmPt[] = [
  [0, 0.045, MAT.top], [0.08, 0.05, MAT.top], [0.22, 0.049, MAT.top], [0.42, 0.05, MAT.top], [0.44, 0.042, MAT.skin], [0.7, 0.041, MAT.skin],
  [1, 0.035, MAT.skin], [1.25, 0.04, MAT.skin], [1.65, 0.032, MAT.skin], [2, 0.026, MAT.skin],
];
const ARM_LONG: ArmPt[] = [
  [0, 0.045, MAT.top], [0.08, 0.05, MAT.top], [0.22, 0.049, MAT.top], [0.6, 0.047, MAT.top], [1, 0.042, MAT.top], [1.3, 0.045, MAT.top],
  [1.76, 0.038, MAT.top], [1.86, 0.035, MAT.top], [1.9, 0.028, MAT.skin], [2, 0.026, MAT.skin],
];
// the same with a ribbed cuff
const ARM_CUFF: ArmPt[] = [
  [0, 0.046, MAT.top], [0.08, 0.052, MAT.top], [0.22, 0.051, MAT.top], [0.6, 0.049, MAT.top], [1, 0.045, MAT.top], [1.3, 0.047, MAT.top],
  [1.74, 0.039, MAT.top2], [1.86, 0.034, MAT.top2], [1.9, 0.028, MAT.skin], [2, 0.026, MAT.skin],
];
// long sleeves pushed up below the elbow
const ARM_PUSHED: ArmPt[] = [
  [0, 0.045, MAT.top], [0.08, 0.05, MAT.top], [0.22, 0.049, MAT.top], [0.6, 0.048, MAT.top], [1, 0.046, MAT.top], [1.12, 0.049, MAT.top],
  [1.2, 0.036, MAT.skin], [1.3, 0.039, MAT.skin], [1.65, 0.032, MAT.skin], [2, 0.026, MAT.skin],
];

/** where the first-person view's arm starts (along the arm: 0 shoulder, 1 elbow) */
const POV_CUT = 0.15;

/** more rings along the forearm (at most 0.12 apart), so its twist spreads evenly */
function densify(pts: ArmPt[]): ArmPt[] {
  const out: ArmPt[] = [];
  pts.forEach((pt, i) => {
    out.push(pt);
    const nx = pts[i + 1];
    if (!nx || pt[0] < 1) return;
    const n = Math.ceil((nx[0] - pt[0]) / 0.12);
    for (let j = 1; j < n; j++) {
      const u = j / n;
      out.push([lerp(pt[0], nx[0], u), lerp(pt[1], nx[1], u), pt[2]]);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------- the people

function clothed(m: Mesh, p: Pose) {
  const s = skeleton(p);
  const { k, b, B } = s;
  const spec = p.spec;
  const top = spec.top;
  const headwear = spec.headwear ?? 'none';
  const loose = clamp((top === 'hoodie' ? 0.5 : top === 'fleece' || top === 'jacket' ? 0.35 : top === 'overshirt' ? 0.25 : 0) + (spec.loose ?? 0), 0, 1.6);
  const banded = top === 'hoodie' || top === 'fleece';

  // ---- torso: one piece from the hem to the collar
  m.curLayer = SELF;
  const zone = (h: number) =>
    h <= 0.03
      ? B.hips
      : h <= 0.17
        ? lerp(B.hips, B.waist, (h - 0.03) / 0.14)
        : h <= 0.34
          ? lerp(B.waist, B.chest, (h - 0.17) / 0.17)
          : h <= 0.49
            ? lerp(B.chest, B.shoulders, clamp((h - 0.34) / 0.115))
            : lerp(B.shoulders, B.neck, (h - 0.49) / 0.062);
  const torsoRow = (j: number) => {
    const [h, w0, f0, bk0] = TORSO[j];
    const z = zone(h);
    const depth = 1 + (z - 1) * 0.6;
    const belly = B.belly * bump(h, -0.03, 0.27);
    const bust = B.bust * bump(h, 0.27, 0.44);
    const lw = 1 + (banded && j <= 2 ? 0.015 : 0.05) * loose;
    const w = (w0 * z + 0.025 * belly) * lw;
    return { h, w, front: (f0 * depth + 0.07 * belly + 0.05 * bust) * lw, back: bk0 * depth * lw + 0.006 * loose };
  };
  const rows = TORSO.map((_, j) => torsoRow(j));
  loft(
    m,
    rows.map((r) => ringIn(s.spineAt(r.h * k), s.frameAt(r.h * k), r.w * k, r.w * k, r.front * k, r.back * k)),
    D.torso,
    (j, i) => {
      // the bottom closes between the legs: the crotch of the trousers
      if (j === 0) return MAT.pants;
      if (banded && j <= 2) return MAT.top2;
      if (top === 'hoodie' && (j === 4 || j === 5) && facing(i, D.torso, 0, 1) > 0.55) return MAT.top2;
      // the open jacket shows the tee underneath
      if (top === 'jacket' && j >= 3 && j <= 10 && facing(i, D.torso, 0, 1) > 0.9) return MAT.top2;
      return MAT.top;
    },
    2.25,
    0.25,
  );
  /** a point on the front of the torso at height h (base m), x across (fraction of the half width) */
  const onFront = (h: number, x: number, out: number) => {
    const j = Math.max(0, TORSO.findIndex((r) => r[0] >= h) - 1);
    const a = rows[j];
    const c = rows[Math.min(rows.length - 1, j + 1)];
    const t = clamp((h - a.h) / (c.h - a.h || 1));
    const w = lerp(a.w, c.w, t) * k;
    const front = lerp(a.front, c.front, t) * k * Math.sqrt(Math.max(0, 1 - x * x));
    const fr = s.frameAt(h * k);
    return local(s.spineAt(h * k), fr.r, fr.u, fr.f, x * w, 0, front + out);
  };
  if (top === 'hoodie') {
    // the hood lies bunched around the back of the neck; drawstrings hang in front
    const pts: V3[] = [];
    const radii: number[] = [];
    for (let i = 0; i <= 8; i++) {
      const a = -1.95 + (3.9 * i) / 8;
      pts.push(local(s.neck, b.chest.r, b.chest.u, b.chest.f, Math.sin(a) * 0.09 * k, (0.012 * Math.cos(a) - 0.012) * k, (-Math.cos(a) * 0.078 - 0.01) * k));
      radii.push((0.016 + 0.032 * Math.cos(a / 2) ** 4) * k);
    }
    loft(m, tubeRings(pts, radii, b.chest.u, 0.75), D.small + 2, MAT.top, 2, 0.6);
    for (const x of [-0.22, 0.22]) {
      loft(m, tubeRings([onFront(0.5, x, 0.006 * k), onFront(0.44, x * 1.05, 0.01 * k), onFront(0.37, x * 1.1, 0.012 * k)], [0.0035, 0.0035, 0.004], b.chest.r), 4, MAT.accent, 2, 0.6);
    }
  }
  if (top === 'fleece') {
    // stand-up collar and a zip down the front
    const nr = 0.055 * k * B.neck;
    loft(
      m,
      tubeRings([madd(s.neck, b.chest.u, -0.03 * k), madd(s.neck, b.chest.u, 0.02 * k), madd(s.neck, b.chest.u, 0.05 * k)], [nr + 0.022 * k, nr + 0.014 * k, nr + 0.012 * k], b.chest.r),
      D.neck,
      MAT.top,
      2,
      0.1,
    );
    const zip: V3[] = [];
    for (const h of [-0.04, 0.05, 0.15, 0.25, 0.34, 0.42, 0.49]) zip.push(onFront(h, 0, 0.002 * k));
    zip.push(local(s.neck, b.chest.r, b.chest.u, b.chest.f, 0, 0.045 * k, nr + 0.014 * k));
    loft(m, tubeRings(zip, zip.map(() => 0.0035), b.chest.r, 0.6), 4, MAT.accent, 2, 0.3);
  }
  /** a thin rounded slab lying on the chest (pocket flap, crew pass): centre, half sizes across and up */
  const slab = (c: V3, x: V3, n: V3, rx: number, ry: number, thick: number, mat: number) => {
    const y = norm(cross(n, x));
    const ring = (out: number): Ring => ({ c: madd(c, n, out), x, y, rx, ry, p: 4 });
    loft(m, [ring(0), ring(thick)], D.small + 2, mat, 4, 0);
  };
  if (top === 'overshirt' || top === 'jacket') {
    // a collar lying folded around the base of the neck
    const nr = 0.055 * k * B.neck;
    const u = b.chest.u;
    loft(
      m,
      tubeRings([madd(s.neck, u, -0.02 * k), madd(s.neck, u, 0.018 * k), madd(s.neck, u, 0.04 * k)], [nr + 0.036 * k, nr + 0.024 * k, nr + 0.012 * k], b.chest.r, 0.95),
      D.neck,
      MAT.top,
      2,
      0.1,
    );
  }
  if (top === 'overshirt') {
    // the button placket down the front and two chest pocket flaps
    const plk: V3[] = [];
    for (const h of [-0.035, 0.06, 0.16, 0.26, 0.35, 0.43, 0.49]) plk.push(onFront(h, 0, 0.001 * k));
    loft(m, tubeRings(plk, plk.map(() => 0.009 * k), b.chest.r, 0.25), 4, MAT.top2, 2, 0.2);
    for (const sd of [-1, 1]) {
      const n = norm(madd(b.chest.f, b.chest.r, sd * 0.42));
      slab(onFront(0.385, sd * 0.48, 0.001 * k), across(b.chest.r, n), n, 0.042 * k, 0.017 * k, 0.005 * k, MAT.top2);
    }
  }
  if (spec.lanyard) {
    // a flat strap from the pass up over the collar, around the back of the neck and down again
    const g = (x: number, u: number, f: number) => local(s.neck, b.chest.r, b.chest.u, b.chest.f, x * k, u * k, f * k);
    const half: V3[] = [onFront(0.3, 0.02, 0.008 * k), onFront(0.4, 0.2, 0.009 * k), onFront(0.47, 0.36, 0.012 * k), g(0.075, 0.02, 0.035), g(0.075, 0.035, -0.035), g(0, 0.04, -0.07)];
    // the other side: mirrored at the body's middle plane
    const mirror = (q: V3) => madd(q, b.chest.r, -2 * dot(sub(q, s.neck), b.chest.r));
    const path = [...half, ...half.slice(0, -1).reverse().map(mirror)];
    loft(m, tubeRings(path, path.map(() => 0.006 * k), b.chest.r, 0.3), 4, MAT.frame, 2, 0);
    slab(onFront(0.28, 0, 0.009 * k), b.chest.r, b.chest.f, 0.024 * k, 0.034 * k, 0.003 * k, MAT.accent);
  }
  if (spec.beltGloves) {
    // a pair of gloves tucked into the waistband on the right hip, hanging down
    const pr = b.pelvis;
    const c = local(s.pelvis, pr.r, pr.u, pr.f, (0.095 * B.hips + 0.105) * k, -0.03 * k, 0.025 * k);
    ellipsoid(m, c, pr.f, pr.u, pr.r, 0.04 * k, 0.065 * k, 0.014 * k, D.small + 2, 4, MAT.glove);
    ellipsoid(m, madd(madd(c, pr.f, -0.012 * k), pr.r, 0.012 * k), pr.f, pr.u, pr.r, 0.038 * k, 0.058 * k, 0.012 * k, D.small + 2, 4, MAT.glove2);
  }

  // ---- neck and head
  const neckR = 0.055 * k * B.neck;
  loft(
    m,
    tubeRings(
      [madd(s.neck, b.chest.u, -0.06 * k), madd(madd(s.neck, b.chest.u, 0.045 * k), b.chest.f, 0.004 * k), madd(madd(s.head, b.head.u, -0.045 * k), b.head.f, -0.012 * k)],
      [neckR, neckR * 0.96, neckR * 0.9],
      b.chest.r,
    ),
    D.neck,
    MAT.skin,
    2,
    0.2,
  );
  const hk = k * B.head;
  const hp = (h: number, fwd: number) => madd(madd(s.head, b.head.u, h * hk), b.head.f, fwd * hk);
  const headRings = (secs: HeadSec[], grow = 1, bumps = 0): Ring[] =>
    secs.map(([h, fwd, w, front, back]) => ({ ...ringIn(hp(h, fwd), b.head, w * hk * grow, w * hk * grow, front * hk * grow, back * hk * grow), bumps: bumps * hk }));
  loft(m, headRings(HEAD), D.head, MAT.skin, 2.15, 0.45);
  // a small nose (no other face: the people stay anonymous)
  loft(
    m,
    tubeRings([hp(0.034, 0.07), hp(0.006, 0.093), hp(-0.022, 0.1), hp(-0.033, 0.092)], [0.009, 0.0105, 0.0125, 0.008].map((r) => r * hk), b.head.r, 0.75),
    D.small,
    MAT.skin,
    2,
    0.5,
  );
  const hair = spec.hair;
  const earsFree = headwear !== 'hijab' && !['curly', 'afro'].includes(hair);
  if (earsFree) {
    for (const sd of [-1, 1]) ellipsoid(m, madd(hp(-0.004, -0.008), b.head.r, sd * 0.074 * hk), b.head.r, b.head.u, b.head.f, 0.011 * hk, 0.029 * hk, 0.019 * hk, D.small + 2, 4, MAT.skin);
  }
  if (headwear !== 'hijab') {
    if (hair === 'short') loft(m, headRings(HAIR_SHORT), D.head, MAT.hair, 2.1, 0.3);
    else if (hair === 'buzz') loft(m, headRings(HAIR_BUZZ), D.head, MAT.hair, 2.1, 0.45);
    else if (hair === 'pixie') loft(m, headRings(HAIR_PIXIE, 1, 0.002), D.head, MAT.hair, 2.1, 0.3);
    else if (hair === 'coils') loft(m, headRings(HAIR_SHORT, 1.06, 0.005), D.head, MAT.hair, 2.1, 0.3);
    else if (hair === 'undercut') {
      // shaved sides, the longer top dyed at the tips
      loft(m, headRings(HAIR_BUZZ), D.head, MAT.hair2, 2.1, 0.45);
      loft(m, headRings(HAIR_TOP, 1, 0.008), D.head, (j) => (j >= 3 ? MAT.dye : MAT.hair), 2.3, 0.3);
    } else if (hair === 'curly') loft(m, headRings(HAIR_CURLY, 1, 0.006), D.head, MAT.hair, 2.1, 0.3);
    else if (hair === 'afro') loft(m, headRings(HAIR_CURLY, 1.25, 0.008), D.head, MAT.hair, 2, 0.3);
    else if (hair === 'ponytail' || hair === 'bun') loft(m, headRings(HAIR_PULLED), D.head, MAT.hair, 2.1, 0.3);
    if (hair === 'bun') {
      ellipsoid(m, hp(0.085, -0.115), b.head.r, b.head.u, b.head.f, 0.042 * hk, 0.038 * hk, 0.036 * hk, D.small + 4, 5, MAT.hair);
    }
    if (hair === 'ponytail') {
      // tied at the back of the head, hanging down the back, never inside it
      const capped = headwear === 'cap';
      const tie = capped ? hp(0.035, -0.125) : hp(-0.035, -0.104);
      const back = scale(b.chest.f, -1);
      const len = (capped ? 0.2 : 0.3) * k;
      const pts: V3[] = [madd(tie, b.head.f, 0.02 * hk), tie];
      const n = 5;
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const q = madd(madd(tie, [0, -1, 0], t * len), back, (0.018 + 0.012 * Math.sin(Math.PI * t)) * k);
        // keep it outside the back: at least this far behind the spine
        const sp = madd(s.neck, b.chest.u, -t * len);
        const behind = dot(sub(q, sp), back);
        const min = (0.1 + 0.04 * t) * k;
        pts.push(behind < min ? madd(q, back, min - behind) : q);
      }
      const r0 = capped ? 0.022 : 0.026;
      loft(m, tubeRings(pts, [r0, r0 + 0.002, r0 + 0.006, r0 + 0.004, r0, r0 - 0.006, r0 - 0.013].map((r) => r * k), b.head.r, 0.8), D.limb, MAT.hair, 2, 0.6);
    }
    if (spec.beard) {
      loft(m, headRings(BEARD, 1, 0.0025), D.head, MAT.hair, 2.1, 0.3);
    }
    if (headwear === 'cap') {
      loft(m, headRings(CAP), D.head, MAT.cap, 2.3, 0.3);
      // the brim: a thin slab sloping down a little at the front
      const bf = norm(madd(b.head.f, b.head.u, -0.18));
      const bu = norm(cross(b.head.r, bf));
      const c0 = hp(0.04, 0.05);
      const brim = (lift: number): Ring => ({ c: madd(c0, bu, lift * hk), x: b.head.r, y: bf, rx: 0.088 * hk, ry: 0.1 * hk, ry2: 0.03 * hk, p: 2.2 });
      loft(m, [brim(-0.003), brim(0.003)], D.head, MAT.cap, 2.2, 0);
      ellipsoid(m, hp(0.149, -0.025), b.head.r, b.head.u, b.head.f, 0.008 * hk, 0.004 * hk, 0.008 * hk, D.small, 3, MAT.cap);
    }
  } else {
    // the hijab: rings over the head, then around the neck down into the collar (no loose ends)
    const rings: Ring[] = HIJAB_ROWS.map((h) => {
      const [, fwd, w, front, back] = secAt(HIJAB, h);
      return ringIn(hp(h, fwd), b.head, w * hk, w * hk, front * hk, back * hk);
    });
    // the neck's axis: from the neck joint to where the neck meets the head
    const neckTop = madd(madd(s.head, b.head.u, -0.045 * hk), b.head.f, -0.012 * hk);
    for (const [at, w, front, back] of HIJAB_NECK) {
      const fr = between(b.chest, b.head, clamp(at));
      rings.push(ringIn(mix3(s.neck, neckTop, at), fr, neckR + w * k, neckR + w * k, neckR + front * k, neckR + back * k));
    }
    const start = m.vertexCount;
    loft(m, rings, HIJAB_SIDES, MAT.hijab, 2.15, 0.25);
    // the face oval: there the rings run just inside the head, so the face shows; around it the
    // fabric comes down onto the face over a soft band
    const e = 2 / 2.15;
    HIJAB_ROWS.forEach((h, j) => {
      const [, fwd, w, front, back] = secAt(HEAD, h);
      for (let i = 0; i < HIJAB_SIDES; i++) {
        const a = (2 * Math.PI * i) / HIJAB_SIDES;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        // the ring's +y is the head's forward: angle from straight ahead
        const d = Math.hypot((h - FACE.h) / FACE.hh, Math.atan2(ca, sa) / FACE.phi);
        const t = 1 - smooth(FACE.edge[0], FACE.edge[1], d);
        if (t <= 0) continue;
        const ux = Math.sign(ca) * Math.abs(ca) ** e;
        const uy = Math.sign(sa) * Math.abs(sa) ** e;
        /** the point of the head's surface in this direction, `out` m outside it */
        const onHead = (out: number) => madd(madd(hp(h, fwd), b.head.r, ux * (w * hk + out)), b.head.f, uy * ((uy >= 0 ? front : back) * hk + out));
        const o = (start + j * HIJAB_SIDES + i) * 3;
        const fab: V3 = [m.pos[o], m.pos[o + 1], m.pos[o + 2]];
        // down onto the face first, then tucked in gradually: the edge crosses the faces of the grid
        // smoothly instead of in steps
        const p = mix3(fab, onHead(lerp(0.003, -0.006, smooth(0.4, 1, t))), smooth(0, 0.4, t));
        m.pos[o] = p[0];
        m.pos[o + 1] = p[1];
        m.pos[o + 2] = p[2];
      }
    });
  }
  if (spec.glasses) {
    // two rims in front of the eyes, a bridge, temples back to the ears
    const g = (x: number, h: number, f: number) => local(s.head, b.head.r, b.head.u, b.head.f, x * hk, h * hk, f * hk);
    const tube = 0.0022 * hk;
    for (const sd of [-1, 1]) {
      const rim: V3[] = [];
      for (let i = 0; i <= 10; i++) {
        const a = (2 * Math.PI * i) / 10;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const cx = Math.sign(ca) * Math.abs(ca) ** 0.7;
        const cy = Math.sign(sa) * Math.abs(sa) ** 0.8;
        const xa = 0.035 + 0.021 * cx;
        // the outer half follows the face back a little
        rim.push(g(sd * xa, 0.02 + 0.015 * cy, 0.097 - 0.3 * Math.max(0, xa - 0.035)));
      }
      loft(m, tubeRings(rim, rim.map(() => tube), b.head.f), 4, MAT.frame, 2, 0);
      loft(m, tubeRings([g(sd * 0.056, 0.026, 0.09), g(sd * 0.08, 0.028, 0.07), g(sd * 0.081, 0.024, 0.0), g(sd * 0.076, 0.0, -0.02)], [tube, tube, tube, tube], b.head.u), 4, MAT.frame, 2, 0.5);
    }
    loft(m, tubeRings([g(-0.014, 0.024, 0.097), g(0, 0.028, 0.099), g(0.014, 0.024, 0.097)], [tube, tube, tube], b.head.u), 4, MAT.frame, 2, 0.5);
  }
  m.curLayer = 0;

  // ---- arms: from the shoulder joint (its dome is the round top of the shoulder) down to the wrist.
  // The first-person view sees them from just below the shoulder (layer 0, a hidden cap closes the
  // cut, at the edge of or outside its picture); the upper arm keeps the elbow's axis, the forearm twists from it to the wrist's radio-ulnar
  // axis along its length (pronation) and flattens towards the wrist.
  const sleeve = densify(top === 'tee' ? ARM_TEE : spec.pushed ? ARM_PUSHED : banded ? ARM_CUFF : ARM_LONG);
  const ak = k * B.limbs;
  s.arms.forEach((a, ai) => {
    const up = sub(a.el, a.sh);
    const fa = sub(a.wr, a.el);
    const at = (t: number) => (t <= 1 ? madd(a.sh, up, t) : madd(a.el, fa, t - 1));
    const sleeveLoose = (t: number, mat: number) => (mat === MAT.top ? 1 + 0.07 * loose * (t < 1.7 ? 1 : 0.4) : 1);
    const gloved = (spec.gloves ?? 'none') !== 'none';
    const radii = sleeve.map(([t, r, mat]) => r * ak * sleeveLoose(t, mat));
    const rings = tubeRings(sleeve.map(([t]) => at(t)), radii, b.chest.f);
    const arm = p.body.arms?.[ai];
    if (arm) {
      const fd = norm(fa);
      const e0 = across(arm.forearm.elbowAxis, fd);
      const w1 = across(arm.forearm.wristAxis, fd);
      const twist = Math.atan2(dot(fd, cross(e0, w1)), dot(e0, w1));
      // the vertices keep the elbow's axis all along (no sheared faces); the forearm's oval turns
      // with the pronation towards the wrist, a sleeve less than skin
      orientRings(
        rings,
        sleeve.map(() => arm.forearm.elbowAxis),
        sleeve.map(([t, , mat], i) => {
          if (t <= 1) return null;
          const f = (t - 1) * (mat === MAT.top ? 0.5 : 1);
          return [radii[i] * (1 + 0.16 * f), radii[i] * (1 - 0.1 * f), twist * (t - 1)];
        }),
      );
    }
    loft(
      m,
      rings,
      D.limb,
      // a glove's cuff covers the wrist
      sleeve.map(([t, , mat]) => (gloved && t >= 1.85 && mat === MAT.skin ? MAT.glove : mat)),
      2,
      0.5,
      (j) => (sleeve[j][0] < POV_CUT ? SELF : 0),
    );
    // the cap that closes the first-person view's cut, hidden inside the sleeve for everyone else
    const cut = rings[sleeve.findIndex(([t]) => t >= POV_CUT)];
    const cd = norm(up);
    ellipsoid(m, cut.c, cut.x, cd, cut.y, cut.rx * 0.97, cut.rx * 0.35, cut.ry * 0.97, D.limb, 3, sleeve[sleeve.findIndex(([t]) => t >= POV_CUT)][2]);
    hand(m, a.hand, a.sign, norm(fa), 0.026 * ak, spec);
  });

  // ---- legs (only outside views see them: layer SELF): from inside the pelvis to the ankle (wide
  // trousers down over the shoes), then the shoes
  m.curLayer = SELF;
  // ---- legs: from inside the pelvis to the ankle (wide trousers down over the shoes), then the shoes
  const wide = spec.pants === 'wide';
  const work = spec.pants === 'work';
  const lk = k * B.limbs ** 0.6;
  for (const l of s.legs) {
    const th = sub(l.knee, l.hip);
    const sh = sub(l.ankle, l.knee);
    const pts: V3[] = [madd(l.hip, b.spine, 0.06 * k), l.hip, madd(l.hip, th, 0.3), madd(l.hip, th, 0.65), l.knee, madd(l.knee, sh, 0.3), madd(l.knee, sh, 0.72), madd(l.knee, sh, wide ? 1.07 : 0.97)];
    const radii = wide
      ? [0.074, 0.09, 0.091, 0.086, 0.083, 0.086, 0.093, 0.1]
      : work
        ? [0.062, 0.083, 0.086, 0.073, 0.062, 0.062, 0.054, 0.052]
        : [0.058, 0.079, 0.081, 0.067, 0.056, 0.056, 0.047, 0.045];
    const hipK = k * (1 + (B.hips - 1) * 0.8);
    loft(
      m,
      tubeRings(pts, radii.map((r, i) => r * (i < 3 ? hipK : lk)), b.pelvis.r),
      D.limb,
      // a side pocket on work trousers
      (j, i) => (work && j === 2 && facing(i, D.limb, l.sign * 0.85, -0.5) > 0.72 ? MAT.pants2 : MAT.pants),
      2,
      wide ? 0.05 : 0.2,
    );
    if (spec.kneePads) {
      const a = norm(sub(l.hip, l.knee));
      const c = norm(sub(l.ankle, l.knee));
      const bis = add(a, c);
      const along = norm(sub(a, c));
      const fwd = across(mix3(b.pelvis.f, scale(norm(bis), -1), clamp(Math.hypot(bis[0], bis[1], bis[2]) / 0.4)), along);
      const sideA = norm(cross(along, fwd));
      ellipsoid(m, madd(l.knee, fwd, 0.052 * lk), sideA, along, fwd, 0.047 * lk, 0.064 * lk, 0.02 * lk, D.limb, 4, MAT.pad);
    }
    shoe(m, l, spec.shoes, k * B.feet, wide);
  }
  m.curLayer = 0;
}

// ---------------------------------------------------------------------------------- hands

/**
 * A hand with a palm, four fingers and a thumb, from its HandPose; it joins the forearm at the wrist.
 * Gloves cover it (rigger gloves leave the fingertips free), nails sit on the fingertips.
 */
function hand(m: Mesh, h: HandPose, side: number, fa: V3, wristR: number, spec: PersonSpec) {
  const gl = spec.gloves ?? 'none';
  const gloved = gl !== 'none';
  const thick = gloved ? 1.08 : 1;
  const hj = handJoints(h, side);
  m.curSmooth = 1;
  const { fd, palm, q } = h;
  const w = hj.w;
  const at = (x: number, y: number, z: number): V3 => [
    h.wrist[0] + (fd[0] * x + palm[0] * y + w[0] * z) * q,
    h.wrist[1] + (fd[1] * x + palm[1] * y + w[1] * z) * q,
    h.wrist[2] + (fd[2] * x + palm[2] * y + w[2] * z) * q,
  ];
  const skinOr = gloved ? MAT.glove : MAT.skin;
  // the palm side is the second glove colour (coated work glove, the leather palm of a rigger glove)
  const palmSide = (fy: number) => (gloved && fy > 0.3 ? MAT.glove2 : skinOr);

  // palm: from a ring on the forearm (round, across it) to the knuckles
  const fx = across(w, fa);
  const fy = norm(cross(fa, fx));
  const R = (x: number, wide: number, palmT: number, backT: number, z = -0.002): Ring => ({ c: at(x, (palmT - backT) / 2 - 0.001, z), x: w, y: palm, rx: wide * q * thick, ry: ((palmT + backT) / 2) * q * thick, p: 2.4 });
  const rings: Ring[] = [
    { c: madd(h.wrist, fa, -0.014 * q), x: fx, y: fy, rx: wristR, ry: wristR * 0.8 },
    ...PALM_RINGS.map(([x, wide, palmT, backT, z]) => R(x, wide, palmT, backT, z)),
  ];
  loft(m, rings, D.palm, (j, i) => (j === 0 ? skinOr : palmSide(facing(i, D.palm, 0, 1))), 2.4, 0.4);
  if (gloved) {
    // the cuff over the wrist
    loft(
      m,
      [
        { c: madd(h.wrist, fa, -0.06 * q), x: fx, y: fy, rx: wristR * 1.3, ry: wristR * 1.2 },
        { c: madd(h.wrist, fa, -0.012 * q), x: fx, y: fy, rx: wristR * 1.32, ry: wristR * 1.2 },
        { c: at(0.014, 0.002, -0.002), x: w, y: palm, rx: 0.033 * q, ry: 0.024 * q },
      ],
      D.palm,
      MAT.glove,
      2.2,
      0,
    );
  }

  // fingers: tubes along the joints; rings turn halfway at the joints
  const nailOf = (j: number, last: number, fy: number) => (j >= last - 1 && fy > 0.5 ? MAT.nails : -1);
  hj.fingers.forEach((fg, fi) => {
    const f = FINGERS[fi];
    const [K, J1, J2, T] = fg.p;
    const dirs = [norm(sub(J1, K)), norm(sub(J2, J1)), norm(sub(T, J2))];
    const pts: V3[] = [madd(K, fd, -0.016 * q), K, mix3(K, J1, 0.5), J1, mix3(J1, J2, 0.5), J2, mix3(J2, T, 0.5), madd(T, dirs[2], -f.r1 * 0.6 * q)];
    const rr = [f.r0 * 1.02, f.r0 * 1.06, f.r0 * 0.94, f.r0 * 0.95, (f.r0 + f.r1) * 0.47, f.r1 * 1.04, f.r1 * 0.95, f.r1 * 0.8];
    // per point: the direction and the back of the finger (halfway at the joints; at the knuckle
    // between the back of the hand and the first bone)
    const back = scale(palm, -1);
    const dIn = [fd, norm(add(fd, dirs[0])), dirs[0], norm(add(dirs[0], dirs[1])), dirs[1], norm(add(dirs[1], dirs[2])), dirs[2], dirs[2]];
    const nIn = [back, norm(add(back, fg.n[0])), fg.n[0], norm(add(fg.n[0], fg.n[1])), fg.n[1], norm(add(fg.n[1], fg.n[2])), fg.n[2], fg.n[2]];
    const fr: Ring[] = pts.map((c, i) => {
      const y = across(nIn[i], dIn[i]);
      const x = norm(cross(y, dIn[i]));
      return { c, x, y, rx: rr[i] * q * thick, ry: rr[i] * 0.9 * q * thick };
    });
    const last = pts.length - 2;
    loft(m, fr, D.finger, (j, i) => {
      const fy2 = facing(i, D.finger, 0, 1);
      const tipFree = gl === 'rigger' && j >= 5;
      if (!gloved || tipFree) {
        const nail = nailOf(j, last, fy2);
        if (nail >= 0) return nail;
        return MAT.skin;
      }
      return palmSide(-fy2);
    }, 2, 0.75);
  });

  // thumb: from the ball of the thumb in the palm out to the tip
  const [Bs, M, IP, T] = hj.thumb;
  const td = [norm(sub(M, Bs)), norm(sub(IP, M)), norm(sub(T, IP))];
  const tpts: V3[] = [Bs, mix3(Bs, M, 0.5), M, mix3(M, IP, 0.5), IP, mix3(IP, T, 0.5), madd(T, td[2], -THUMB.r[3] * 0.6 * q)];
  const tr = [THUMB.r[0], THUMB.r[0] * 0.95, THUMB.r[1], THUMB.r[1] * 0.95, THUMB.r[2], THUMB.r[3] * 1.04, THUMB.r[3] * 0.85];
  // the nail faces away from the palm and the fingers
  const tn = h.thumbNail;
  const back = tn ? norm([fd[0] * tn[0] + palm[0] * tn[1] + w[0] * tn[2], fd[1] * tn[0] + palm[1] * tn[1] + w[1] * tn[2], fd[2] * tn[0] + palm[2] * tn[1] + w[2] * tn[2]]) : norm(madd(scale(palm, -0.75), w, 0.65));
  const tbone = [0, 0, 1, 1, 2, 2, 2];
  const trings: Ring[] = tpts.map((c, i) => {
    const d = i === 2 ? norm(add(td[0], td[1])) : i === 4 ? norm(add(td[1], td[2])) : td[tbone[i]];
    const y = across(back, d);
    return { c, x: norm(cross(y, d)), y, rx: tr[i] * q * thick, ry: tr[i] * 0.88 * q * thick };
  });
  loft(m, trings, D.finger, (j, i) => {
    const fy2 = facing(i, D.finger, 0, 1);
    if (!gloved || (gl === 'rigger' && j >= 4)) return j >= 4 && fy2 > 0.5 ? MAT.nails : MAT.skin;
    return palmSide(-fy2);
  }, 2, 0.75);
  m.curSmooth = 0;
}

// ---------------------------------------------------------------------------------- shoes

/** a shoe: heel to toe along the foot, the sole flat on the floor; work shoes are chunkier, boots high */
function shoe(m: Mesh, leg: Skeleton['legs'][number], kind: PersonSpec['shoes'], q: number, wide: boolean) {
  const fd = leg.foot;
  const side = norm(cross(fd, [0, 1, 0]));
  const u = norm(cross(side, fd));
  const chunky = kind !== 'sneakers' || wide;
  const up = chunky ? 0.008 : 0;
  const cap = kind === 'boots' ? 3 : 2.6;
  const R = (along: number, down: number, wd: number, high: number, p?: number): Ring => ({
    c: madd(madd(leg.ankle, fd, along * q), u, -(down - up) * q),
    x: side,
    y: u,
    rx: wd * q * (chunky ? 1.12 : 1),
    ry: (high + up) * q,
    p,
  });
  loft(
    m,
    [R(-0.05, 0.036, 0.028, 0.03), R(-0.03, 0.032, 0.036, 0.042), R(0.04, 0.04, 0.042, 0.036), R(0.115, 0.055, 0.047, 0.023, cap), R(0.165, 0.06, 0.036, 0.017, cap)],
    D.foot,
    (_, i) => (facing(i, D.foot, 0, -1) > 0.5 ? MAT.sole : MAT.shoes),
    2.6,
    0.45,
  );
  if (kind === 'boots') {
    // the shaft around the ankle, under the trousers
    const shin = norm(sub(leg.knee, leg.ankle));
    loft(m, tubeRings([madd(leg.ankle, shin, -0.03 * q), madd(leg.ankle, shin, 0.05 * q), madd(leg.ankle, shin, 0.12 * q)], [0.05 * q, 0.049 * q, 0.047 * q], side), D.foot, MAT.shoes, 2, 0.1);
  }
}
