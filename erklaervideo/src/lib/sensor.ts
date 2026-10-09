// A simulated Kinect v2: ray-casts the room and the people (people.ts) for every pixel of the
// 512 × 424 depth camera, 30 times per second of story time. It gives what the real system has:
// depth (m), infrared brightness, which person each pixel belongs to, the optical flow and, per
// person, the box and the 17 keypoints the pose model would find. The images show the Kinect's own
// view (the hub sends them mirrored): what stands left of the wall as the audience sees it (-x) is on
// the right of the image, as when you look out from the wall.

import { V3, clamp, hash, RGB } from './math';
import { BONES, Pose, people } from './people';
import { FURNITURE, INTR, KINECT, ROOM } from './world';

export const SENSOR_FPS = 30;

export interface PersonView {
  slot: number;
  css: string;
  color: RGB;
  pixels: number;
  /** box of the person's pixels: u0, v0, u1, v1 (image px) */
  bbox: [number, number, number, number];
  /** the 17 COCO keypoints: u, v (image px), confidence */
  kp: [number, number, number][];
  /** every joint projected: u, v, depth (m), or null outside the image */
  img: ([number, number, number] | null)[];
  score: number;
  pose: Pose;
}

export interface SensorFrame {
  T: number;
  seq: number;
  w: number;
  h: number;
  /** m along the view axis, 0 = no measurement */
  depth: Float32Array;
  /** infrared brightness 0..1 */
  ir: Float32Array;
  /** 0 = room, else the person's slot */
  label: Uint8Array;
  /** 0 nothing, 1 floor, 2 walls and ceiling, 3 furniture, 4 person */
  cls: Uint8Array;
  /** image motion since the last frame, px */
  flowU: Float32Array;
  flowV: Float32Array;
  /** px from the pixel to its person's stick figure (people only) */
  boneDist: Float32Array;
  /** which body part a person pixel shows: index into now (person * 32 + capsule), -1 for the room */
  cap: Int16Array;
  /** the people at the moment of this frame */
  now: Pose[];
  persons: PersonView[];
}

const W = INTR.w;
const H = INTR.h;
const N = W * H;
const [KX, KY, KZ] = KINECT;

// per pixel: the ray (x, y, 1) and 1 / its length
const RX = new Float32Array(W);
const RY = new Float32Array(H);
const INVL = new Float32Array(N);
for (let u = 0; u < W; u++) RX[u] = -(u + 0.5 - INTR.cx) / INTR.f;
for (let v = 0; v < H; v++) RY[v] = -(v + 0.5 - INTR.cy) / INTR.f;
for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) INVL[v * W + u] = 1 / Math.hypot(RX[u], RY[v], 1);

export function rayX(u: number) {
  return RX[u];
}
export function rayY(v: number) {
  return RY[v];
}
/** the same for image positions between pixels */
export function rayXAt(u: number) {
  return -(u + 0.5 - INTR.cx) / INTR.f;
}
export function rayYAt(v: number) {
  return -(v + 0.5 - INTR.cy) / INTR.f;
}

/** room point of pixel i at depth z */
export function pointOf(i: number, z: number, out: number[] | Float32Array, o = 0) {
  const u = i % W;
  const v = (i - u) / W;
  out[o] = KX + RX[u] * z;
  out[o + 1] = KY + RY[v] * z;
  out[o + 2] = KZ + z;
}

/** room point → image px (u, v) and depth */
export function project(p: V3): [number, number, number] | null {
  const z = p[2] - KZ;
  if (z < 0.05) return null;
  return [INTR.cx - (INTR.f * (p[0] - KX)) / z - 0.5, INTR.cy - (INTR.f * (p[1] - KY)) / z - 0.5, z];
}

const cache = new Map<number, SensorFrame>();

/** the sensor frame visible at story time T (the newest one captured at or before T) */
export function sense(T: number): SensorFrame {
  const seq = Math.floor(T * SENSOR_FPS + 1e-6);
  const hit = cache.get(seq);
  if (hit) return hit;
  const frame = capture(seq);
  cache.set(seq, frame);
  if (cache.size > 6) cache.delete(cache.keys().next().value as number);
  return frame;
}

// albedo and normal of the room per pixel, filled by the room pass
const nrm = new Int8Array(N); // 0 floor, 1 back wall, 2 ceiling, 3 side +x, 4 side -x, 5.. furniture faces (5 + 0..5)
const alb = new Float32Array(N);
const capOf = new Int16Array(N);
const NORMALS: V3[] = [
  [0, 1, 0], [0, 0, -1], [0, -1, 0], [-1, 0, 0], [1, 0, 0],
  [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1],
];

function capture(seq: number): SensorFrame {
  const T = seq / SENSOR_FPS;
  const depth = new Float32Array(N);
  const ir = new Float32Array(N);
  const label = new Uint8Array(N);
  const cls = new Uint8Array(N);
  const flowU = new Float32Array(N);
  const flowV = new Float32Array(N);
  const boneDist = new Float32Array(N).fill(Infinity);

  // room: floor, walls, ceiling, furniture
  for (let v = 0; v < H; v++) {
    const dy = RY[v];
    for (let u = 0; u < W; u++) {
      const dx = RX[u];
      const i = v * W + u;
      let t = ROOM.back - KZ;
      let n = 1;
      let c = 2;
      let a = 0.5;
      if (dy < 0) {
        const tf = -KY / dy;
        if (tf < t) {
          t = tf;
          n = 0;
          c = 1;
          a = 0.4;
        }
      } else if (dy > 0) {
        const tc = (ROOM.ceiling - KY) / dy;
        if (tc < t) {
          t = tc;
          n = 2;
          c = 2;
          a = 0.45;
        }
      }
      if (dx !== 0) {
        const ts = ((dx > 0 ? ROOM.side : -ROOM.side) - KX) / dx;
        if (ts < t) {
          t = ts;
          n = dx > 0 ? 3 : 4;
          c = 2;
        }
      }
      for (let b = 0; b < FURNITURE.length; b++) {
        const bx = FURNITURE[b];
        let t0 = bx.min[2] - KZ;
        let t1 = bx.max[2] - KZ;
        let face = 9;
        const ix0 = (bx.min[0] - KX) / dx;
        const ix1 = (bx.max[0] - KX) / dx;
        const xa = Math.min(ix0, ix1);
        const xb = Math.max(ix0, ix1);
        if (xa > t0) {
          t0 = xa;
          face = dx > 0 ? 5 : 6;
        }
        t1 = Math.min(t1, xb);
        const iy0 = (bx.min[1] - KY) / dy;
        const iy1 = (bx.max[1] - KY) / dy;
        const ya = Math.min(iy0, iy1);
        const yb = Math.max(iy0, iy1);
        if (ya > t0) {
          t0 = ya;
          face = dy > 0 ? 7 : 8;
        }
        t1 = Math.min(t1, yb);
        if (t0 <= t1 && t0 > 0 && t0 < t) {
          t = t0;
          n = face;
          c = 3;
          a = bx.albedo;
        }
      }
      depth[i] = t;
      nrm[i] = n;
      cls[i] = c;
      alb[i] = a;
    }
  }

  // people: per capsule, only inside its projected box
  const now = people(T);
  const before = people(T - 1 / SENSOR_FPS);
  for (let pi = 0; pi < now.length; pi++) {
    const p = now[pi];
    for (let ci = 0; ci < p.capsules.length; ci++) {
      const { a, b, r } = p.capsules[ci];
      const za = a[2] - KZ;
      const zb = b[2] - KZ;
      const zmin = Math.min(za, zb) - r;
      if (zmin < 0.1) continue;
      const pa = project(a);
      const pb = project(b);
      if (!pa || !pb) continue;
      const rp = (r * INTR.f) / zmin + 2;
      const u0 = Math.max(0, Math.floor(Math.min(pa[0], pb[0]) - rp));
      const u1 = Math.min(W - 1, Math.ceil(Math.max(pa[0], pb[0]) + rp));
      const v0 = Math.max(0, Math.floor(Math.min(pa[1], pb[1]) - rp));
      const v1 = Math.min(H - 1, Math.ceil(Math.max(pa[1], pb[1]) + rp));
      if (u0 > u1 || v0 > v1) continue;
      const sphere = a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
      const bax = b[0] - a[0];
      const bay = b[1] - a[1];
      const baz = b[2] - a[2];
      const oax = KX - a[0];
      const oay = KY - a[1];
      const oaz = KZ - a[2];
      const obx = KX - b[0];
      const oby = KY - b[1];
      const obz = KZ - b[2];
      const baba = bax * bax + bay * bay + baz * baz;
      const baoa = bax * oax + bay * oay + baz * oaz;
      const oaoa = oax * oax + oay * oay + oaz * oaz;
      const obob = obx * obx + oby * oby + obz * obz;
      const rr = r * r;
      const code = pi * 32 + ci;
      for (let v = v0; v <= v1; v++) {
        for (let u = u0; u <= u1; u++) {
          const i = v * W + u;
          const il = INVL[i];
          const rx = RX[u] * il;
          const ry = RY[v] * il;
          const rz = il;
          let t = -1;
          if (sphere) {
            const bb = rx * oax + ry * oay + rz * oaz;
            const h = bb * bb - (oaoa - rr);
            if (h > 0) t = -bb - Math.sqrt(h);
          } else {
            const bard = bax * rx + bay * ry + baz * rz;
            const rdoa = rx * oax + ry * oay + rz * oaz;
            const qa = baba - bard * bard;
            const qb = baba * rdoa - baoa * bard;
            const qc = baba * oaoa - baoa * baoa - rr * baba;
            let h = qb * qb - qa * qc;
            if (h >= 0) {
              const tt = (-qb - Math.sqrt(h)) / qa;
              const y = baoa + tt * bard;
              if (y > 0 && y < baba) t = tt;
              else {
                const end = y <= 0;
                const bb = end ? rdoa : rx * obx + ry * oby + rz * obz;
                const cc = (end ? oaoa : obob) - rr;
                h = bb * bb - cc;
                if (h > 0) t = -bb - Math.sqrt(h);
              }
            }
          }
          if (t <= 0) continue;
          const z = t * il;
          if (z < depth[i]) {
            depth[i] = z;
            label[i] = p.slot;
            cls[i] = 4;
            capOf[i] = code;
          }
        }
      }
    }
  }

  const cap = new Int16Array(N).fill(-1);
  for (let i = 0; i < N; i++) if (label[i]) cap[i] = capOf[i];

  // shading, flow, noise
  const G = 5;
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const i = v * W + u;
      const z = depth[i];
      const il = INVL[i];
      const rx = RX[u] * il;
      const ry = RY[v] * il;
      const rz = il;
      const px = KX + RX[u] * z;
      const py = KY + RY[v] * z;
      const pz = KZ + z;
      let nx: number;
      let ny: number;
      let nz: number;
      let a: number;
      if (label[i]) {
        const code = capOf[i];
        const pi = code >> 5;
        const ci = code & 31;
        const p = now[pi];
        const cap = p.capsules[ci];
        const prev = before.find((q) => q.slot === p.slot)?.capsules[ci] ?? cap;
        const bax = cap.b[0] - cap.a[0];
        const bay = cap.b[1] - cap.a[1];
        const baz = cap.b[2] - cap.a[2];
        const bb = bax * bax + bay * bay + baz * baz;
        const s = bb > 0 ? clamp(((px - cap.a[0]) * bax + (py - cap.a[1]) * bay + (pz - cap.a[2]) * baz) / bb) : 0;
        const qx = cap.a[0] + bax * s;
        const qy = cap.a[1] + bay * s;
        const qz = cap.a[2] + baz * s;
        nx = px - qx;
        ny = py - qy;
        nz = pz - qz;
        const nl = Math.hypot(nx, ny, nz) || 1;
        // where this surface point was one frame ago
        const ox = prev.a[0] + (prev.b[0] - prev.a[0]) * s + nx;
        const oy = prev.a[1] + (prev.b[1] - prev.a[1]) * s + ny;
        const oz = prev.a[2] + (prev.b[2] - prev.a[2]) * s + nz;
        const zo = oz - KZ;
        if (zo > 0.05) {
          flowU[i] = u - (INTR.cx - (INTR.f * (ox - KX)) / zo - 0.5);
          flowV[i] = v - (INTR.cy - (INTR.f * (oy - KY)) / zo - 0.5);
        }
        nx /= nl;
        ny /= nl;
        nz /= nl;
        a = p.albedo[ci];
      } else {
        const n = NORMALS[nrm[i]];
        nx = n[0];
        ny = n[1];
        nz = n[2];
        a = alb[i];
      }
      const dist = z / il;
      const cos = Math.max(0, -(nx * rx + ny * ry + nz * rz));
      const r2 = ((u - INTR.cx) / INTR.cx) ** 2 + ((v - INTR.cy) / INTR.cy) ** 2;
      const n1 = hash(u, v, seq);
      let e = (a * (0.2 + 0.8 * cos) * G * (1 - 0.28 * r2)) / (dist * dist);
      e *= 0.9 + 0.2 * n1;
      ir[i] = Math.sqrt(clamp(e));
      // depth noise grows with distance; grazing surfaces and a few random pixels give no value
      const n2 = hash(v, u, seq + 7919);
      if (n2 < 0.002 || cos < 0.06) depth[i] = 0;
      else depth[i] = z + (n1 - 0.5) * 0.006 * (1 + z * z * 0.12);
    }
  }

  // per person: box, keypoints, distance to the own stick figure
  const persons: PersonView[] = [];
  for (const p of now) {
    let count = 0;
    let bu0 = W;
    let bv0 = H;
    let bu1 = -1;
    let bv1 = -1;
    for (let i = 0; i < N; i++) {
      if (label[i] !== p.slot) continue;
      count++;
      const u = i % W;
      const v = (i - u) / W;
      if (u < bu0) bu0 = u;
      if (u > bu1) bu1 = u;
      if (v < bv0) bv0 = v;
      if (v > bv1) bv1 = v;
    }
    if (count < 150) continue;
    const img = p.joints.map((j) => project(j));
    const kp = img.slice(0, 17).map((q, k): [number, number, number] => {
      if (!q || q[0] < 0 || q[0] >= W || q[1] < 0 || q[1] >= H) return [0, 0, 0];
      const d = depth[Math.round(q[1]) * W + Math.round(q[0])];
      const hidden = d > 0 && d < q[2] - 0.25;
      return [q[0], q[1], hidden ? 0.3 : 0.82 + 0.12 * hash(k, p.slot, seq)];
    });
    // distance of every pixel of this person to its projected stick figure
    const segs = BONES.map(([a, b]) => [img[a], img[b]]).filter(([a, b]) => a && b) as [number, number, number][][];
    for (let v = bv0; v <= bv1; v++) {
      for (let u = bu0; u <= bu1; u++) {
        const i = v * W + u;
        if (label[i] !== p.slot) continue;
        let best = Infinity;
        for (const [a, b] of segs) {
          const ex = b[0] - a[0];
          const ey = b[1] - a[1];
          const ee = ex * ex + ey * ey;
          const s = ee > 0 ? clamp(((u - a[0]) * ex + (v - a[1]) * ey) / ee) : 0;
          const d = Math.hypot(u - a[0] - ex * s, v - a[1] - ey * s);
          if (d < best) best = d;
        }
        boneDist[i] = best;
      }
    }
    persons.push({
      slot: p.slot,
      css: p.css,
      color: p.color,
      pixels: count,
      bbox: [bu0, bv0, bu1 + 1, bv1 + 1],
      kp,
      img,
      score: 0.95 - 0.025 * p.slot + 0.012 * Math.sin(seq * 0.37 + p.slot),
      pose: p,
    });
  }

  return { T, seq, w: W, h: H, depth, ir, label, cls, flowU, flowV, boneDist, cap, now, persons };
}
