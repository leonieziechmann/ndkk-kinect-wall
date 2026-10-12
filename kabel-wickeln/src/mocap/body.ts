// Measuring a body from the 68 take joints (src/mocap/joints.ts): facing, spine, chest, head, hand
// frames, finger curls, the thumb. retarget.ts applies the same measurements to the recording and to
// our own figures (their joints from takeJointsOf), so the conventions of both sides cancel out.
// Pure TypeScript; world metres, y up, any horizontal orientation.

import { V3, Quat, across, add, clamp, cross, dot, len, madd, norm, quatCols, scale, sub } from '../people/math';
import { FINGERS, THUMB, thumbChain } from '../people/body/hand';
import { UP } from '../people/people';
import { HEAD, NOSE, PELVIS, SIDE } from './joints';

// ---------------------------------------------------------------- fitting a rotation

/** the eigenvector of the largest eigenvalue of a symmetric 4 × 4 matrix (cyclic Jacobi) */
function topEigen4(A: number[][]): number[] {
  const a = A.map((r) => r.slice());
  const v: number[][] = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] * a[p][q];
    if (off < 1e-22) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i][i] > a[best][best]) best = i;
  return [v[0][best], v[1][best], v[2][best], v[3][best]];
}

/**
 * The rotation that best maps local points onto world points (weighted, centroids removed, any
 * scale; Horn's quaternion method). Returns the quaternion local → world and the weighted RMS of the
 * residual after fitting the scale too (m); null with fewer than three usable points.
 */
export function fitRotation(local: V3[], world: V3[], w: number[]): { q: Quat; rms: number; scale: number } | null {
  let W = 0;
  const lc: V3 = [0, 0, 0];
  const wc: V3 = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < local.length; i++) {
    if (!(w[i] > 0)) continue;
    n++;
    W += w[i];
    for (let k = 0; k < 3; k++) {
      lc[k] += w[i] * local[i][k];
      wc[k] += w[i] * world[i][k];
    }
  }
  if (n < 3 || W <= 0) return null;
  for (let k = 0; k < 3; k++) {
    lc[k] /= W;
    wc[k] /= W;
  }
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let ll = 0;
  for (let i = 0; i < local.length; i++) {
    if (!(w[i] > 0)) continue;
    const a = sub(local[i], lc);
    const b = sub(world[i], wc);
    ll += w[i] * dot(a, a);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += w[i] * a[r] * b[c];
  }
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  const e = topEigen4(N);
  const l = Math.hypot(e[0], e[1], e[2], e[3]) || 1;
  const q: Quat = [e[1] / l, e[2] / l, e[3] / l, e[0] / l];
  // residual with the best scale
  const [c1, c2, c3] = quatCols(q);
  const rot = (v: V3): V3 => add(add(scale(c1, v[0]), scale(c2, v[1])), scale(c3, v[2]));
  let num = 0;
  for (let i = 0; i < local.length; i++) if (w[i] > 0) num += w[i] * dot(rot(sub(local[i], lc)), sub(world[i], wc));
  const s = ll > 0 ? num / ll : 1;
  let res = 0;
  for (let i = 0; i < local.length; i++) {
    if (!(w[i] > 0)) continue;
    const d = sub(sub(world[i], wc), scale(rot(sub(local[i], lc)), s));
    res += w[i] * dot(d, d);
  }
  return { q, rms: Math.sqrt(res / W), scale: s };
}

/** v turned by the quaternion q */
export function rotate(q: Quat, v: V3): V3 {
  const [c1, c2, c3] = quatCols(q);
  return add(add(scale(c1, v[0]), scale(c2, v[1])), scale(c3, v[2]));
}

// ---------------------------------------------------------------- frames of the body

/** horizontal part of a vector, normalised (null when nearly vertical) */
export function horizontal(v: V3): V3 | null {
  const h: V3 = [v[0], 0, v[2]];
  const l = len(h);
  return l > 1e-6 ? scale(h, 1 / l) : null;
}

/** signed angle (rad) about +y from a to b (both horizontal), as people/math turn(·, UP, angle) turns */
export function yawBetween(a: V3, b: V3): number {
  return Math.atan2(dot(cross(a, b), UP), dot(a, b));
}

/** rig yaw of a forward direction (people.ts yawFrame: 0 = towards −z, + turns right) */
export const yawOf = (f: V3) => Math.atan2(f[0], -f[2]);

/** the forward direction of a rig yaw */
export const forwardOf = (yaw: number): V3 => [Math.sin(yaw), 0, -Math.cos(yaw)];
export const rightOf = (yaw: number): V3 => [Math.cos(yaw), 0, Math.sin(yaw)];

/** the measured parts of a body in one frame (the world of the joints) */
export interface BodyMeasure {
  /** between the hip joints, and how sure */
  pelvis: V3;
  pelvisC: number;
  /** facing of the pelvis (horizontal) and how sure */
  facing: V3;
  facingC: number;
  /** the shoulders with the clavicles at rest (restShoulders) and their middle */
  shoulders: [V3, V3];
  shMid: V3;
  /** pelvis → middle of the shoulders, unit */
  spine: V3;
  spineC: number;
  /** the chest frame: u = spine, r towards the right shoulder (⟂ u), f = u × r */
  chest: { r: V3; u: V3; f: V3 };
  chestC: number;
  /** where the face looks (null: no face points) */
  headF: V3 | null;
  headC: number;
}

/** the face points of people/rig.ts (headOf: nose, eyes, ears) in a right-handed head frame (r, u, −f), size k = 1 */
const FACE_LOCAL: V3[] = [
  [0, -0.02, -0.1],
  [-0.033, 0.025, -0.085],
  [0.033, 0.025, -0.085],
  [-0.075, 0, 0],
  [0.075, 0, 0],
];

/**
 * Measures one frame: p = the 68 joints (m), c = their confidences (0 … 1). Facing from the hips
 * (the shoulders when the hips are unsure), the spine from the pelvis to the middle of the
 * shoulders, the chest's right from the shoulders, the face direction from nose, eyes and ears.
 */
export function measureBody(p: V3[], c: number[], prevFacing?: V3, over?: { pelvis?: { p: V3; c: number }; shoulders?: { p: [V3, V3]; c: number } }): BodyMeasure {
  const L = SIDE[0];
  const R = SIDE[1];
  const hipC = Math.min(c[L.hip], c[R.hip]);
  const pelvis = over?.pelvis ? over.pelvis.p : hipC > 0 ? scale(add(p[L.hip], p[R.hip]), 0.5) : p[PELVIS];
  const pelvisC = over?.pelvis ? over.pelvis.c : hipC > 0 ? hipC : c[PELVIS];
  const shC = over?.shoulders ? over.shoulders.c : Math.min(c[L.shoulder], c[R.shoulder]);
  // the shoulders as they would sit with the clavicles at rest (a raised or reaching arm lifts and
  // protracts its shoulder; that is not a lean of the spine)
  let q = p;
  let qc = c;
  if (over?.shoulders) {
    q = p.slice();
    qc = c.slice();
    q[L.shoulder] = over.shoulders.p[0];
    q[R.shoulder] = over.shoulders.p[1];
    qc[L.shoulder] = qc[R.shoulder] = over.shoulders.c;
  }
  const shoulders = restShoulders(q, qc, pelvis);
  const shMid = scale(add(shoulders[0], shoulders[1]), 0.5);
  // facing: the hips' line, the shoulders' as a help
  const hipR = horizontal(sub(p[R.hip], p[L.hip]));
  const shR = horizontal(sub(shoulders[1], shoulders[0]));
  let right: V3 | null = null;
  let facingC = 0;
  if (hipR && hipC > 0) {
    const wS = shR && shC > 0 ? 0.25 * shC : 0;
    right = norm(add(scale(hipR, hipC), shR ? scale(shR, wS) : [0, 0, 0]));
    facingC = Math.min(1, hipC + wS);
  } else if (shR && shC > 0) {
    right = shR;
    facingC = 0.7 * shC;
  }
  const facing: V3 = right ? norm(cross(UP, right)) : prevFacing ?? [0, 0, -1];
  const spineV = sub(shMid, pelvis);
  const spine: V3 = len(spineV) > 0.05 ? norm(spineV) : UP;
  const spineC = Math.min(pelvisC, shC);
  const r0 = sub(shoulders[1], shoulders[0]);
  const rC: V3 = len(r0) > 0.05 && shC > 0 ? across(r0, spine) : across(cross(facing, spine), spine);
  const chest = { r: rC, u: spine, f: norm(cross(spine, rC)) };
  // the face: a rotation fitted to nose, eyes and ears (each by its confidence)
  const face = [NOSE, L.eye, R.eye, L.ear, R.ear];
  const fit = fitRotation(FACE_LOCAL, face.map((j) => p[j]), face.map((j) => c[j]));
  let headF: V3 | null = null;
  let headC = 0;
  // (a face 30 % smaller or larger than a head is a misplaced set of points)
  if (fit && fit.scale > 0.7 && fit.scale < 1.45) {
    headF = scale(rotate(fit.q, [0, 0, 1]), -1);
    // confidence: how many points, and how well they fit (a few cm off is a bad fit)
    // three points (nose and eyes, the ears hidden) turn the head less surely than five
    const wsum = face.reduce((s, j) => s + c[j], 0);
    headC = clamp((wsum - 1) / 3) * clamp(1 - (fit.rms - 0.012) / 0.03);
  }
  return { pelvis, pelvisC, facing, facingC, shoulders, shMid, spine, spineC, chest, chestC: shC, headF, headC };
}

/**
 * The shoulder joints moved back to where they sit with the clavicles at rest: people/ik.ts lifts
 * the clavicle with the arm's elevation and brings it forward with a reach (clavicleRhythm); the
 * same rhythm, read from the measured upper arms, is taken out again (the clavicle ≈ 0.85 of half
 * the shoulder width).
 */
export function restShoulders(p: V3[], c: number[], pelvis: V3): [V3, V3] {
  const L = SIDE[0];
  const R = SIDE[1];
  const sh: [V3, V3] = [p[L.shoulder], p[R.shoulder]];
  if (!(Math.min(c[L.shoulder], c[R.shoulder]) > 0)) return sh;
  const across0 = sub(sh[1], sh[0]);
  const half = len(across0) / 2;
  if (half < 0.05) return sh;
  const u = norm(sub(scale(add(sh[0], sh[1]), 0.5), pelvis));
  const r = across(across0, u);
  const f = norm(cross(u, r));
  const clav = 0.85 * half;
  return [0, 1].map((s) => {
    const X = SIDE[s];
    if (!(c[X.elbow] > 0)) return sh[s];
    const hum = sub(p[X.elbow], sh[s]);
    if (len(hum) < 0.05) return sh[s];
    const h = norm(hum);
    const th = Math.acos(clamp(-dot(h, u), -1, 1));
    const fwd = dot(h, f);
    const med = -dot(h, scale(r, s ? 1 : -1));
    const elev = clamp(0.11 * Math.max(0, th - 0.35), -0.087, 0.21);
    const prot = clamp(0.1 * Math.max(0, fwd) + 0.12 * Math.max(0, med), -0.105, 0.21);
    return sub(sh[s], add(scale(f, clav * prot), scale(u, clav * elev)));
  }) as [V3, V3];
}

/**
 * The rig's lean and bend (people/rig.ts core: spine ∝ f·sin(lean) + r·sin(bend) + up·cos(lean)·cos(bend))
 * of a spine direction, in the frame of a facing (f, r horizontal). Gauss-Newton on the angles.
 */
export function leanBendOf(spine: V3, f: V3, r: V3): { lean: number; bend: number } {
  const sf = dot(spine, f);
  const sr = dot(spine, r);
  const su = dot(spine, UP);
  let lean = Math.atan2(sf, su);
  let bend = Math.atan2(sr, Math.hypot(su, sf));
  const model = (L: number, B: number): V3 => {
    const v: V3 = [Math.sin(L), Math.sin(B), Math.cos(L) * Math.cos(B)];
    return scale(v, 1 / len(v));
  };
  for (let it = 0; it < 8; it++) {
    const m = model(lean, bend);
    const e: V3 = [m[0] - sf, m[1] - sr, m[2] - su];
    if (dot(e, e) < 1e-14) break;
    const h = 1e-5;
    const jl = scale(sub(model(lean + h, bend), m), 1 / h);
    const jb = scale(sub(model(lean, bend + h), m), 1 / h);
    // 2 × 2 normal equations
    const a = dot(jl, jl), b = dot(jl, jb), d = dot(jb, jb);
    const g1 = dot(jl, e), g2 = dot(jb, e);
    const det = a * d - b * b;
    if (Math.abs(det) < 1e-12) break;
    lean -= (d * g1 - b * g2) / det;
    bend -= (a * g2 - b * g1) / det;
  }
  return { lean, bend };
}

/**
 * The rig's twist (chest against the facing, rad, as rig.ts turns it: rotY(base.f, twist)) of a
 * chest forward direction: the horizontal direction whose part ⟂ spine is the chest's f.
 */
export function twistOf(chestF: V3, spine: V3, facing: V3): number {
  const k = Math.abs(spine[1]) > 1e-3 ? chestF[1] / spine[1] : 0;
  const h = horizontal(sub(chestF, scale(spine, k))) ?? horizontal(chestF) ?? facing;
  return yawBetween(facing, h);
}

// ---------------------------------------------------------------- hands

/** a hand's rigid points (wrist, thumb base, the four knuckles) in a right-handed hand frame (fd, palm, fd × palm), size 1 */
export function handLocal(side: 0 | 1): { idx: number[]; pts: V3[] } {
  const z = side ? 1 : -1;
  const pts: V3[] = [[0, 0, 0], [THUMB.base[0], THUMB.base[1], z * THUMB.base[2]], ...FINGERS.map((f) => [f.kx, 0, z * f.kz] as V3)];
  // take hand points: 0 wrist, 1 thumb_cmc, 5 index_mcp, 9 middle_mcp, 13 ring_mcp, 17 pinky_mcp
  return { idx: [0, 1, 5, 9, 13, 17], pts };
}

export interface HandMeasure {
  /** wrist → knuckles, out of the palm (world, unit) */
  fd: V3;
  palm: V3;
  /** how sure the finger direction is, 0 … 1 */
  conf: number;
  /** how sure the turn about it (where the palm faces) is, 0 … 1: needs the index and the little finger's knuckles, and a tight fit (their 5 cm decide it) */
  rollConf: number;
  /** the hand's size (1 = 19 cm), from the fit */
  size: number;
  /** curls of thumb, index, middle, ring, little (0 open … 1 fist, people/body/hand.ts), null = unknown */
  curls: (number | null)[];
  curlC: number[];
  /** the thumb tip in the hand frame (fd, palm, thumb side), m for a hand of size 1; null = unknown */
  thumb: V3 | null;
  thumbC: number;
  /** the direction of the thumb's last bone (IP → tip) in the hand frame; null = unknown */
  thumbDir: V3 | null;
}

/** the curl angles of body/hand.ts fingerPoints: knuckle, middle joint, end joint (cumulative) per unit curl */
const CURL_ANGLES = [1.5, 3.35, 4.5];
const CURL_NORM = CURL_ANGLES.reduce((s, a) => s + a * a, 0);

/**
 * A hand from its 21 points (h0 = index of its wrist in the take joints): the frame fitted to the
 * wrist, the thumb base and the knuckles; finger curls from the bend of each finger's bones
 * towards the palm (inverting body/hand.ts fingerPoints); the thumb tip relative to its base.
 */
export function measureHand(p: V3[], c: number[], side: 0 | 1, h0: number): HandMeasure | null {
  const { idx, pts } = handLocal(side);
  const fit = fitRotation(pts, idx.map((i) => p[h0 + i]), idx.map((i) => c[h0 + i]));
  if (!fit) return null;
  const fd = rotate(fit.q, [1, 0, 0]);
  const palm = rotate(fit.q, [0, 1, 0]);
  const size = fit.scale;
  if (!(size > 0.4 && size < 2)) return null;
  // how much of the hand is seen: the wrist and the outer knuckles count most (a hidden thumb base
  // or little finger knuckle lowers it, but the rest still fixes the frame)
  const imp = [2, 1, 1.5, 1, 1, 1.5];
  const seen = idx.reduce((s, i, k) => s + imp[k] * clamp(c[h0 + i]), 0) / imp.reduce((a, b) => a + b, 0);
  const spread = Math.max(c[h0 + 5], c[h0 + 9]) > 0 && Math.max(c[h0 + 13], c[h0 + 17]) > 0 && c[h0] > 0;
  // a hand whose points do not fit a hand's shape (more than ~2 cm off) is not trusted
  const conf = spread ? seen * clamp(1 - (fit.rms - 0.008) / 0.02) : 0;
  const axis = norm(cross(fd, palm));
  const curls: (number | null)[] = [];
  const curlC: number[] = [];
  // thumb: the angle of its last two bones away from the metacarpal's line (rough, 0 … 1)
  {
    const t = [1, 2, 3, 4].map((i) => p[h0 + i]);
    const cc = Math.min(...[1, 2, 3, 4].map((i) => c[h0 + i]));
    const b0 = sub(t[1], t[0]), b1 = sub(t[2], t[1]), b2 = sub(t[3], t[2]);
    const ang = (u: V3, v: V3) => Math.acos(clamp(dot(norm(u), norm(v)), -1, 1));
    curls.push(cc > 0 ? clamp((ang(b0, b1) + ang(b1, b2)) / 2.6) : null);
    curlC.push(cc);
  }
  for (let f = 0; f < 4; f++) {
    const b = 5 + 4 * f;
    const q = [0, b, b + 1, b + 2, b + 3].map((i) => p[h0 + i]);
    const cc = Math.min(...[b, b + 1, b + 2, b + 3].map((i) => c[h0 + i]));
    if (!(cc > 0)) {
      curls.push(null);
      curlC.push(0);
      continue;
    }
    const bones = [sub(q[2], q[1]), sub(q[3], q[2]), sub(q[4], q[3])];
    // cumulative bend towards the palm: the first bone against the hand's plane, then bone to bone
    const a0 = Math.atan2(dot(bones[0], palm), dot(bones[0], fd));
    const rel = (u: V3, v: V3) => Math.atan2(dot(cross(u, v), axis), dot(u, v));
    const A = [a0, a0 + rel(bones[0], bones[1]), a0 + rel(bones[0], bones[1]) + rel(bones[1], bones[2])];
    const cv = (CURL_ANGLES[0] * A[0] + CURL_ANGLES[1] * A[1] + CURL_ANGLES[2] * A[2]) / CURL_NORM;
    curls.push(clamp(cv));
    curlC.push(cc);
  }
  // thumb tip in the hand frame (the left hand's thumb side is −(fd × palm)), relative to its base
  const tc = Math.min(c[h0 + 1], c[h0 + 4]);
  let thumb: V3 | null = null;
  let thumbDir: V3 | null = null;
  const w = side ? axis : scale(axis, -1);
  const inHand = (v: V3): V3 => [dot(v, fd), dot(v, palm), dot(v, w)];
  if (tc > 0) thumb = add(THUMB.base, inHand(scale(sub(p[h0 + 4], p[h0 + 1]), 1 / size)));
  if (Math.min(c[h0 + 3], c[h0 + 4]) > 0) {
    const b = sub(p[h0 + 4], p[h0 + 3]);
    // only a bone of about the right length (its 2D points may have collapsed)
    if (len(b) > 0.5 * THUMB.len[2] * size && len(b) < 1.6 * THUMB.len[2] * size) thumbDir = norm(inHand(b));
  }
  // keep the direction only where the thumb chain with it fits the measured joints better than without
  if (thumb && thumbDir && Math.min(c[h0 + 2], c[h0 + 3]) > 0) {
    const mcp = add(THUMB.base, inHand(scale(sub(p[h0 + 2], p[h0 + 1]), 1 / size)));
    const ip = add(THUMB.base, inHand(scale(sub(p[h0 + 3], p[h0 + 1]), 1 / size)));
    const err = (ch: V3[]) => len(sub(ch[1], mcp)) + len(sub(ch[2], ip));
    if (err(thumbChain(thumb, thumbDir)) > err(thumbChain(thumb)) - 0.002) thumbDir = null;
  }
  const rollConf = Math.max(0, Math.min(conf, c[h0 + 5], c[h0 + 17]) * clamp(1 - (fit.rms - 0.005) / 0.01));
  return { fd, palm, conf: Math.max(0, conf), rollConf, size, curls, curlC, thumb, thumbC: tc, thumbDir };
}

/** the head centre (between the ears) of the joints, or the take's own head joint */
export function headCentre(p: V3[], c: number[]): V3 {
  const L = SIDE[0].ear;
  const R = SIDE[1].ear;
  if (c[L] > 0 && c[R] > 0) return scale(add(p[L], p[R]), 0.5);
  return p[HEAD];
}

/** the elbow's direction off the shoulder–wrist line, and how bent the arm is (0 straight … 1) */
export function elbowPole(sh: V3, el: V3, wr: V3): { dir: V3; bent: number } | null {
  const d = sub(wr, sh);
  const dl = len(d);
  if (dl < 1e-3) return null;
  const u = scale(d, 1 / dl);
  const e = sub(el, sh);
  const perp = madd(e, u, -dot(e, u));
  const pl = len(perp);
  if (pl < 1e-4) return null;
  return { dir: scale(perp, 1 / pl), bent: clamp(pl / 0.06) };
}

// ---------------------------------------------------------------- feet

/**
 * A foot's direction (heel → toes, as people/rig.ts LegRig.dir) fitted to ankle, heel, big and
 * small toe (their places on the shoe, mocap/joints.ts footPoints), so the shoe's own slant does
 * not tilt it; null without enough points.
 */
export function measureFoot(p: V3[], c: number[], side: 0 | 1): { fd: V3; conf: number } | null {
  const S = SIDE[side];
  const m = side ? -1 : 1;
  // right-handed foot frame (fd, up, fd × up): the medial side is + for the left foot, − for the right
  const local: V3[] = [[0, 0, 0], [-0.075, -0.05, 0], [0.18, -0.058, m * 0.012], [0.145, -0.058, -m * 0.03]];
  const js = [S.ankle, S.heel, S.bigToe, S.smallToe];
  const fit = fitRotation(local, js.map((j) => p[j]), js.map((j) => c[j]));
  if (!fit || !(fit.scale > 0.4 && fit.scale < 2.5)) return null;
  // the ankle and two of the three sole points fix the direction
  const sole = [c[S.heel], c[S.bigToe], c[S.smallToe]].sort((a, b) => b - a);
  const conf = Math.min(c[S.ankle], sole[1]) * clamp(1 - (fit.rms - 0.008) / 0.02);
  return { fd: rotate(fit.q, [1, 0, 0]), conf: Math.max(0, conf) };
}
