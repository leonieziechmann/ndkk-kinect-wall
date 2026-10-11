// The skeleton of a hand: palm, four fingers with three bones each, and a thumb. A HandPose (wrist,
// finger direction, palm normal, curls, thumb tip) becomes joint positions here; the rig uses the
// same geometry to close a fist around a cable (fistAround), so the mesh and the grip always agree.
//
// Hand frame: x along the fingers (fd), y out of the palm (palm), z towards the thumb side
// (w = side · fd × palm, side = +1 right, -1 left). Measurements in m for a hand of size 1.

import { V3, clamp, cross, norm } from '../math';
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
  { kx: 0.092, kz: 0.025, len: [0.043, 0.025, 0.02], r0: 0.0092, r1: 0.0072, fan: 0.1 },
  { kx: 0.095, kz: 0.006, len: [0.047, 0.029, 0.021], r0: 0.0096, r1: 0.0075, fan: 0.02 },
  { kx: 0.09, kz: -0.013, len: [0.044, 0.027, 0.021], r0: 0.009, r1: 0.007, fan: -0.07 },
  { kx: 0.081, kz: -0.029, len: [0.034, 0.02, 0.019], r0: 0.0081, r1: 0.0063, fan: -0.17 },
];

export const THUMB = {
  /** the base (CMC joint), inside the ball of the thumb */
  base: [0.024, 0.006, 0.022] as V3,
  /** metacarpal, proximal, distal */
  len: [0.044, 0.033, 0.027],
  r: [0.0135, 0.011, 0.0098, 0.0085],
};

/** half thickness of the palm at the knuckles (the cable rests on the palm at this height) */
export const PALM_T = 0.0135;
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
    pinch: [(c[4] + c[6]) / 2, (c[5] + c[7]) / 2, idx.kz + idx.r1 + THUMB.r[3] * 0.9],
  };
}

/** the thumb tip of a relaxed open hand, and of a pinch on the index finger at curl c */
export function freeThumb(curl: number, pinch: number): V3 {
  const idx = FINGERS[0];
  const c = new Array<number>(8).fill(0);
  chain2(idx, curl, c);
  const rest: V3 = [0.088 + 0.012 * (1 - curl), 0.03 + 0.025 * curl, 0.07 - 0.03 * curl];
  const tip: V3 = [(c[4] + c[6]) / 2, (c[5] + c[7]) / 2, idx.kz + idx.r1 + THUMB.r[3] * 0.9];
  return [rest[0] + (tip[0] - rest[0]) * pinch, rest[1] + (tip[1] - rest[1]) * pinch, rest[2] + (tip[2] - rest[2]) * pinch];
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
  const at = (x: number, y: number, z: number): V3 => [
    h.wrist[0] + (fd[0] * x + palm[0] * y + w[0] * z) * q,
    h.wrist[1] + (fd[1] * x + palm[1] * y + w[1] * z) * q,
    h.wrist[2] + (fd[2] * x + palm[2] * y + w[2] * z) * q,
  ];
  const fingers = FINGERS.map((f, i) => {
    const c = h.curl[i];
    const a = angles(c);
    // the open hand fans out; a fist closes the fingers together
    const fan = f.fan * (h.spread * (1 - c) - 0.25 * c);
    const cf = Math.cos(fan);
    const sf = Math.sin(fan);
    const p: V3[] = [at(f.kx, 0, f.kz)];
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
      p.push(at(x, y, z));
      // dorsal side of this bone: the bone turned back by 90° in the finger's plane
      n.push(norm([fd[0] * sa * cf - palm[0] * ca + w[0] * sa * sf, fd[1] * sa * cf - palm[1] * ca + w[1] * sa * sf, fd[2] * sa * cf - palm[2] * ca + w[2] * sa * sf]));
    }
    return { p, n, def: f };
  });

  // thumb: the metacarpal leans towards the tip, the two phalanges reach it (two-bone IK)
  const T = h.thumb;
  const B = THUMB.base;
  const [l0, l1, l2] = THUMB.len;
  const dt = norm([T[0] - B[0], T[1] - B[1], T[2] - B[2]]);
  const md = norm([dt[0] * 0.5 + 0.36, dt[1] * 0.5 + 0.12, dt[2] * 0.5 + 0.33]);
  const M: V3 = [B[0] + md[0] * l0, B[1] + md[1] * l0, B[2] + md[2] * l0];
  const d0: V3 = [T[0] - M[0], T[1] - M[1], T[2] - M[2]];
  const dl = Math.hypot(d0[0], d0[1], d0[2]) || 1;
  const dir: V3 = [d0[0] / dl, d0[1] / dl, d0[2] / dl];
  const d = clamp(dl, Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
  const cos = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
  // the joints bulge away from the palm and outwards
  const pole: V3 = [0.15, -0.45, 1];
  const pk = pole[0] * dir[0] + pole[1] * dir[1] + pole[2] * dir[2];
  const sd = norm([pole[0] - dir[0] * pk, pole[1] - dir[1] * pk, pole[2] - dir[2] * pk]);
  const IP: V3 = [M[0] + (dir[0] * cos + sd[0] * sin) * l1, M[1] + (dir[1] * cos + sd[1] * sin) * l1, M[2] + (dir[2] * cos + sd[2] * sin) * l1];
  const tip: V3 = [M[0] + dir[0] * d, M[1] + dir[1] * d, M[2] + dir[2] * d];
  return { w, fingers, thumb: [at(B[0], B[1], B[2]), at(M[0], M[1], M[2]), at(IP[0], IP[1], IP[2]), at(tip[0], tip[1], tip[2])] };
}
