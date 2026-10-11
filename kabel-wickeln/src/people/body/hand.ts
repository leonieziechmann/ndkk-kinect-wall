// The skeleton of a hand: palm, four fingers with three bones each, and a thumb. A HandPose (wrist,
// finger direction, palm normal, curls, thumb tip) becomes joint positions here; the rig uses the
// same geometry for its grips, so the mesh and the grip always agree:
//   fistAround   a fist around a cable (or a hook around a thick bundle): curls that just touch it
//   pinchAround  a cable pinched between the thumb pad and the thumb side of the curled index
//                finger, the thumb lying along the cable; roll (the thumb slides along the index
//                finger and rolls the cable) and open (loosened, the cable slides through)
//   coilAround   the coil-holding hand: the bundle of loops in the hook of the fingers, the thumb
//                lying along the bundle on top of it; adapts to the bundle radius
//
// Hand frame: x along the fingers (fd), y out of the palm (palm), z towards the thumb side
// (w = side · fd × palm, side = +1 right, -1 left). Measurements in m for a hand of size 1
// (HandPose.q scales them).

import { V3, across, add, clamp, cross, dot, len, lerp, madd, mix3, norm, scale, sub, turn } from '../math';
import type { HandPose } from '../people';

export interface FingerDef {
  /** knuckle (MCP joint) in the hand frame: along fd, towards the thumb */
  kx: number;
  kz: number;
  /** bone lengths: proximal, middle, distal */
  len: [number, number, number];
  /** radius at the knuckle and at the tip */
  r0: number;
  r1: number;
  /** fan angle of the open hand (rad, towards the thumb) */
  fan: number;
}

/** index, middle, ring, little */
export const FINGERS: FingerDef[] = [
  { kx: 0.092, kz: 0.025, len: [0.043, 0.025, 0.02], r0: 0.0104, r1: 0.0084, fan: 0.1 },
  { kx: 0.095, kz: 0.006, len: [0.047, 0.029, 0.021], r0: 0.0108, r1: 0.0087, fan: 0.02 },
  { kx: 0.09, kz: -0.013, len: [0.044, 0.027, 0.021], r0: 0.0101, r1: 0.0082, fan: -0.07 },
  { kx: 0.081, kz: -0.029, len: [0.034, 0.02, 0.019], r0: 0.0091, r1: 0.0073, fan: -0.17 },
];

export const THUMB = {
  /** the base (CMC joint), inside the ball of the thumb */
  base: [0.026, 0.008, 0.022] as V3,
  /** metacarpal, proximal, distal */
  len: [0.046, 0.035, 0.029],
  r: [0.015, 0.0125, 0.011, 0.0094],
};

/** half thickness of the palm at the knuckles (the cable rests on the palm at this height) */
export const PALM_T = 0.015;
/** across-centre of the fist (between middle and ring finger) */
export const FIST_Z = -0.003;
/** joint angles of a full fist: knuckle, middle joint, end joint */
const FIST = [1.5, 1.85, 1.15];

/** the bend angles of a finger for a curl */
const angles = (c: number): [number, number, number] => [FIST[0] * c, FIST[0] * c + FIST[1] * c, FIST[0] * c + FIST[1] * c + FIST[2] * c];

/** a finger in its plane: knuckle, middle joint, end joint, tip as (along fd, along palm) */
function chain2(f: FingerDef, c: number, out: number[]) {
  const a = angles(c);
  let x = f.kx;
  let y = 0;
  out[0] = x;
  out[1] = y;
  for (let s = 0; s < 3; s++) {
    x += Math.cos(a[s]) * f.len[s];
    y += Math.sin(a[s]) * f.len[s];
    out[2 + s * 2] = x;
    out[3 + s * 2] = y;
  }
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

const tmp2 = new Array<number>(8).fill(0);
/** how much room the finger leaves around the point (gx, gy) at curl c (< 0: it cuts in) */
function gap(f: FingerDef, c: number, gx: number, gy: number, r: number) {
  chain2(f, c, tmp2);
  let d = Infinity;
  for (let s = 0; s < 3; s++) d = Math.min(d, segDist(gx, gy, tmp2[s * 2], tmp2[s * 2 + 1], tmp2[s * 2 + 2], tmp2[s * 2 + 3]));
  return d - r - (f.r0 + f.r1) / 2;
}

/**
 * The knuckles lie on a slanted line (the little finger's sits further back), and so does the crease
 * a cable rests in: a held cable crosses the hand at this slope (along fd per unit towards the thumb).
 */
export const FIST_SLOPE = (FINGERS[0].kx - FINGERS[3].kx) / (FINGERS[0].kz - FINGERS[3].kz);

export interface Fist {
  /** the cable axis in the hand frame at z = FIST_Z (along fd, along palm), size-1 units */
  gx: number;
  gy: number;
  /** curls of the four fingers that just touch the cable (1 = it is thinner than the fist's hole) */
  curl: [number, number, number, number];
}

/** where the cable axis crosses a finger's plane (along fd) */
const gxAt = (f: Fist, z: number) => f.gx + FIST_SLOPE * (z - FIST_Z);

/** a fist around a cable of radius r (size-1 units): where the cable lies and how far each finger curls */
export function fistAround(r: number): Fist {
  const mid = FINGERS[1];
  const fist: Fist = { gx: mid.kx - (mid.r0 + r + 0.003) - FIST_SLOPE * (mid.kz - FIST_Z), gy: PALM_T + r, curl: [1, 1, 1, 1] };
  FINGERS.forEach((f, i) => {
    const gx = gxAt(fist, f.kz);
    const gy = fist.gy;
    // close the finger until it touches: march, then bisect
    if (gap(f, 1, gx, gy, r) > 0) return;
    let lo = 0;
    let hi = 1;
    for (let s = 1; s <= 20; s++) {
      if (gap(f, s / 20, gx, gy, r) <= 0) {
        hi = s / 20;
        lo = (s - 1) / 20;
        break;
      }
    }
    for (let n = 0; n < 12; n++) {
      const m = (lo + hi) / 2;
      if (gap(f, m, gx, gy, r) > 0) lo = m;
      else hi = m;
    }
    fist.curl[i] = lo;
  });
  return fist;
}

/** thumb tips (hand frame, size 1) for a fist: lying along the cable, wrapped over the fingers, on the index */
export function thumbTargets(fist: Fist, r: number): { along: V3; wrap: V3; pinch: V3 } {
  const idx = FINGERS[0];
  const c = new Array<number>(8).fill(0);
  chain2(idx, fist.curl[0], c);
  // middle of the index finger's middle bone, pushed out away from the cable
  const mx = (c[2] + c[4]) / 2;
  const my = (c[3] + c[5]) / 2;
  const ox = mx - gxAt(fist, idx.kz);
  const oy = my - fist.gy;
  const ol = Math.hypot(ox, oy) || 1;
  const out = idx.r0 + THUMB.r[3] * 0.9;
  return {
    along: [gxAt(fist, 0.08) + 0.006, fist.gy - r - THUMB.r[3] * 0.85, 0.08],
    wrap: [mx + (ox / ol) * out, my + (oy / ol) * out, idx.kz - 0.004],
    pinch: [(c[2] + c[4]) / 2, (c[3] + c[5]) / 2, idx.kz + (idx.r0 + idx.r1) / 2 + THUMB.r[3] * 0.9],
  };
}

/**
 * The thumb tip of a free hand: relaxed beside the fingers, or pressing on the side of the index
 * finger's middle bone (a pinch, with the index finger curled at `indexCurl`)
 */
export function freeThumb(curl: number, pinch: number, indexCurl: number): V3 {
  const idx = FINGERS[0];
  const c = new Array<number>(8).fill(0);
  chain2(idx, indexCurl, c);
  const rest: V3 = [0.088 + 0.012 * (1 - curl), 0.03 + 0.025 * curl, 0.07 - 0.03 * curl];
  const tip: V3 = [(c[2] + c[4]) / 2, (c[3] + c[5]) / 2, idx.kz + (idx.r0 + idx.r1) / 2 + THUMB.r[3] * 0.9];
  return [rest[0] + (tip[0] - rest[0]) * pinch, rest[1] + (tip[1] - rest[1]) * pinch, rest[2] + (tip[2] - rest[2]) * pinch];
}

/** a finger in the hand frame (size 1): knuckle, middle joint, end joint, tip; the dorsal normal per bone */
export function fingerPoints(f: FingerDef, c: number, spread: number): { p: V3[]; n: V3[] } {
  const a = angles(c);
  // the open hand fans out; a fist closes the fingers together
  const fan = f.fan * (spread * (1 - c) - 0.25 * c);
  const cf = Math.cos(fan);
  const sf = Math.sin(fan);
  const p: V3[] = [[f.kx, 0, f.kz]];
  const n: V3[] = [];
  let x = f.kx;
  let y = 0;
  let z = f.kz;
  for (let s = 0; s < 3; s++) {
    const ca = Math.cos(a[s]);
    const sa = Math.sin(a[s]);
    x += ca * cf * f.len[s];
    z += ca * sf * f.len[s];
    y += sa * f.len[s];
    p.push([x, y, z]);
    // dorsal side of this bone: the bone turned back by 90° in the finger's plane
    n.push(norm([sa * cf, -ca, sa * sf]));
  }
  return { p, n };
}

/** where the thumb's middle joint (MCP) bulges: away from the palm and out to the thumb side */
const THUMB_POLE: V3 = [0.15, -0.45, 1];

/** two-bone chain from a to b (lengths l1, l2) bending towards pole; b is pulled in when out of reach */
function bend2(a: V3, b: V3, l1: number, l2: number, pole: V3): { mid: V3; end: V3 } {
  const d0 = sub(b, a);
  const dl = len(d0) || 1;
  const dir = scale(d0, 1 / dl);
  const d = clamp(dl, Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
  const cos = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
  const sd = across(pole, dir);
  return { mid: add(a, add(scale(dir, cos * l1), scale(sd, sin * l1))), end: madd(a, dir, d) };
}

/**
 * The thumb (hand frame, size 1): base (CMC, in the ball of the thumb), knuckle (MCP), joint (IP),
 * tip. With only a tip, the metacarpal leans towards it and the two phalanges reach it. With the
 * direction of the last bone too (a thumb lying along a cable or a bundle), the joint sits behind the
 * tip along that direction and metacarpal and first phalanx reach the joint. Out of reach the tip
 * stops short (never stretched).
 */
export function thumbChain(T: V3, dir?: V3): [V3, V3, V3, V3] {
  const B = THUMB.base;
  const [l0, l1, l2] = THUMB.len;
  if (dir) {
    const d = norm(dir);
    const ip = bend2(B, madd(T, d, -l2), l0, l1, THUMB_POLE);
    return [B, ip.mid, ip.end, madd(ip.end, d, l2)];
  }
  const dt = norm(sub(T, B));
  const md = norm([dt[0] * 0.5 + 0.36, dt[1] * 0.5 + 0.12, dt[2] * 0.5 + 0.33]);
  const M = madd(B, md, l0);
  const k = bend2(M, T, l1, l2, THUMB_POLE);
  return [B, M, k.mid, k.end];
}

// ---------------------------------------------------------------- the pinch

/** what a grip shape gives the rig: the hand's shape, and the held thing's axis in the hand frame */
export interface GripShape {
  curl: [number, number, number, number];
  spread: number;
  /** thumb tip, and the direction of its last bone (when it must lie along something) */
  thumb: V3;
  thumbDir?: V3;
  /** where the thumb nail faces (hand frame): away from what the pad presses on */
  thumbNail?: V3;
  /** a point on the axis of the held cable or bundle (size 1) */
  p: V3;
  /** the axis direction (the grip frame's d3, towards where the thumb points) */
  d3: V3;
  /** from the axis towards the hand (the grip frame's d1: to the palm in a fist, to the index finger in a pinch) */
  d1: V3;
}

/** index finger curl of the pinch; the other fingers curl loosely, more towards the little finger */
const PINCH_CURL = [0.6, 0.58, 0.66, 0.74];
/** where along its middle bone the index finger meets the cable (0 middle joint … 1 end joint) */
const PINCH_AT = 0.3;
/** the most the thumb can roll the cable (rad, from roll 0 in either direction) */
export const PINCH_ROLL_MAX = Math.PI / 2;
/** how far an open pinch lifts the thumb off the cable (size 1, m) */
const PINCH_LIFT = 0.012;

/** default angle between the thumb and the pinched cable: the cable crosses the thumb pad and leaves out of the palm side */
export const PINCH_CROSS = 1.0;

/**
 * A cable of radius r (size-1 units) pinched between the thumb pad and the thumb side of the index
 * finger's middle bone (a lateral pinch). The other fingers curl loosely below and guide. The cable
 * lies across the thumb pad: `crossing` is its angle from the thumb's direction, turning towards the
 * palm side (0 = along the thumb, π/2 = straight out of the palm; default PINCH_CROSS, as in the
 * reference videos, where the cable leaves the pinch sideways and the fingers hang). roll (rad, up to
 * ±PINCH_ROLL_MAX): the thumb slides along its own length over the index finger and rolls the cable
 * about d3 (without slipping on the index finger: the thumb travels 2·r·roll, the cable axis
 * r·roll); d1 turns with it. open 0 … 1 lifts the thumb and loosens the index finger, so the cable can slide through; the
 * axis stays on the index finger.
 */
export function pinchAround(r: number, roll = 0, open = 0, crossing = PINCH_CROSS): GripShape {
  const o = clamp(open);
  const curl = PINCH_CURL.map((c, i) => c * (1 - (i ? 0.3 : 0.15) * o)) as GripShape['curl'];
  const idx = fingerPoints(FINGERS[0], curl[0], 0);
  const [, pip, dip] = idx.p;
  const m = norm(sub(dip, pip));
  // the thumb side of the finger, across the bone
  const side = across([0, 0, 1], m);
  const rf = lerp(FINGERS[0].r0, FINGERS[0].r1, 0.5) + 0.0005;
  const contact = mix3(pip, dip, PINCH_AT);
  const axis0 = madd(contact, side, rf + r);
  // the thumb pad presses from the thumb side, its last bone in the plane of the pinch (two passes:
  // the tip lies a little beyond the pad along the thumb)
  const pad = r + THUMB.r[3] * 0.92 + 0.0015;
  let td: V3 = [1, 0, 0];
  for (let pass = 0; pass < 2; pass++) {
    const ch = thumbChain(madd(madd(axis0, side, pad), td, 0.008));
    td = across(sub(ch[3], ch[2]), side);
  }
  // the cable crosses the pad, turned from the thumb towards the palm side
  const d3 = turn(td, side, crossing);
  // rolling: the cable turns about d3, its axis moves r·roll and the thumb 2·r·roll along n; at
  // roll = PINCH_ROLL_MAX the thumb is as far out as it reaches, so roll 0 has it bent back a little
  const n = norm(cross(d3, side));
  const slide = roll - PINCH_ROLL_MAX;
  const p = madd(axis0, n, r * slide);
  const thumb = madd(madd(madd(madd(axis0, side, pad + PINCH_LIFT * o), td, 0.008), n, 2 * r * slide), [0, -1, 0], 0.004 * o);
  return { curl, spread: 0, thumb, thumbNail: side, p, d3, d1: turn(scale(side, -1), d3, roll) };
}

// ---------------------------------------------------------------- holding a coil

/** distance from the point p to the line through a along the unit direction d */
function lineDist(p: V3, a: V3, d: V3) {
  const v = sub(p, a);
  return len(madd(v, d, -dot(v, d)));
}

/** the smallest distance between a segment and a line (sampled; the segments are short) */
function segLineDist(p: V3, q: V3, a: V3, d: V3) {
  let m = Infinity;
  for (let i = 0; i <= 8; i++) m = Math.min(m, lineDist(mix3(p, q, i / 8), a, d));
  return m;
}

/**
 * The hand holding a coil: the bundle of loops (radius R, size-1 units) lies across the fingers in
 * their hook (fistAround: each finger curls until it touches), the thumb lies along the bundle and
 * holds it. Small bundles get the thumb on top (on the wrist side of the bundle, where it presses the
 * loops into the hook); as the bundle grows the thumb's line moves round it towards the palm, as far
 * as needed for the whole thumb to stay outside the bundle. d3 runs along the bundle to the thumb side.
 */
export function coilAround(R: number): GripShape {
  const fist = fistAround(R);
  const along = norm([FIST_SLOPE, 0, 1]);
  const B = THUMB.base;
  const ax: V3 = [gxAt(fist, B[2]), fist.gy, B[2]];
  const radii = [THUMB.r[0], THUMB.r[1], THUMB.r[2]];
  // the thumb lies on the bundle along its axis, its joint where metacarpal and first phalanx
  // reach at a natural bend (≈ 40° at the knuckle)
  const place = (beta: number) => {
    const u = across([-Math.cos(beta), Math.sin(beta), 0], along);
    const line = madd(ax, u, R + THUMB.r[2] * 0.95);
    const rel = sub(line, B);
    const k = dot(rel, along);
    const off = len(madd(rel, along, -k));
    const ip = madd(line, along, -k + Math.sqrt(Math.max(0, 0.074 * 0.074 - off * off)));
    const tip = madd(ip, along, THUMB.len[2]);
    const ch = thumbChain(tip, along);
    let clear = Infinity;
    for (let i = 0; i < 3; i++) clear = Math.min(clear, segLineDist(ch[i], ch[i + 1], ax, along) - R - radii[i] * 0.92);
    return { tip, nail: u, clear: Math.min(clear, 0.002 - len(sub(ch[3], tip))) };
  };
  // from the top round towards the palm: the first place where the thumb is clear of the bundle
  let best = place(0.5);
  for (let i = 1; i <= 34 && best.clear < 0; i++) {
    const c = place(0.5 - i * 0.05);
    if (c.clear > best.clear) best = c;
  }
  return { curl: fist.curl, spread: 0, thumb: best.tip, thumbDir: along, thumbNail: best.nail, p: [gxAt(fist, FIST_Z), fist.gy, FIST_Z], d3: along, d1: [0, -1, 0] };
}

export interface HandJoints {
  /** the thumb side (w) */
  w: V3;
  /** per finger: knuckle, middle joint, end joint, tip; and the dorsal normal of each bone */
  fingers: { p: V3[]; n: V3[]; def: FingerDef }[];
  /** base, knuckle, joint, tip */
  thumb: V3[];
}

/** joint positions of a hand in the world; side +1 right, -1 left */
export function handJoints(h: HandPose, side: number): HandJoints {
  const { fd, palm, q } = h;
  const w = norm(cross(fd, palm));
  if (side < 0) w[0] = -w[0], w[1] = -w[1], w[2] = -w[2];
  const at = (v: V3): V3 => [
    h.wrist[0] + (fd[0] * v[0] + palm[0] * v[1] + w[0] * v[2]) * q,
    h.wrist[1] + (fd[1] * v[0] + palm[1] * v[1] + w[1] * v[2]) * q,
    h.wrist[2] + (fd[2] * v[0] + palm[2] * v[1] + w[2] * v[2]) * q,
  ];
  const dirOut = (v: V3): V3 => norm([fd[0] * v[0] + palm[0] * v[1] + w[0] * v[2], fd[1] * v[0] + palm[1] * v[1] + w[1] * v[2], fd[2] * v[0] + palm[2] * v[1] + w[2] * v[2]]);
  const fingers = FINGERS.map((f, i) => {
    const fp = fingerPoints(f, h.curl[i], h.spread);
    return { p: fp.p.map(at), n: fp.n.map(dirOut), def: f };
  });
  return { w, fingers, thumb: thumbChain(h.thumb, h.thumbDir).map(at) };
}
