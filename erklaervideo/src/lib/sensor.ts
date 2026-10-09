// A simulated Kinect v2: ray-casts the room and rasterizes the people's bodies (people.ts,
// body/styles.ts) for every pixel of the 512 × 424 depth camera, 30 times per second of story time. It gives what the real system has:
// depth (m), infrared brightness, which person each pixel belongs to, the optical flow and, per
// person, the box and the 17 keypoints the pose model would find. The images show the Kinect's own
// view (the hub sends them mirrored): what stands left of the wall as the audience sees it (-x) is on
// the right of the image, as when you look out from the wall.

import { MAT, Mesh } from './body/mesh';
import { BodyStyle, DEFAULT_STYLE, buildBody } from './body/styles';
import { V3, clamp, hash, RGB } from './math';
import { BONES, Pose, people, personSpec, pose } from './people';
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
  /** which person a pixel shows (index into now), -1 for the room */
  who: Int8Array;
  /** and where on the body: the triangle of its mesh and two of the three barycentric weights */
  tri: Int32Array;
  bary: Float32Array;
  /** the people at the moment of this frame, and their bodies */
  now: Pose[];
  meshes: Mesh[];
  style: BodyStyle;
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

const cache = new Map<string, SensorFrame>();

/** the sensor frame visible at story time T (the newest one captured at or before T) */
export function sense(T: number, style: BodyStyle = DEFAULT_STYLE): SensorFrame {
  const seq = Math.floor(T * SENSOR_FPS + 1e-6);
  const key = `${style}:${seq}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const frame = capture(seq, style);
  cache.set(key, frame);
  if (cache.size > 6) cache.delete(cache.keys().next().value as string);
  return frame;
}

// bodies are built once per person and sensor frame (the motion trails look back a few frames)
const bodies = new Map<string, Mesh | null>();

/** the body of person `slot` at sensor frame `seq` (null while not in the room) */
export function bodyAt(slot: number, seq: number, style: BodyStyle): Mesh | null {
  const key = `${style}:${slot}:${seq}`;
  const hit = bodies.get(key);
  if (hit !== undefined) return hit;
  const spec = personSpec(slot);
  const p = spec ? pose(spec, seq / SENSOR_FPS) : null;
  const m = p ? buildBody(p, style) : null;
  bodies.set(key, m);
  if (bodies.size > 80) bodies.delete(bodies.keys().next().value as string);
  return m;
}

/** infrared reflectivity per material (MAT); shirts and dresses take the person's own value */
const MAT_IR = [0.7, 0.62, 0.42, 0.3, 0.24, 0.58, 0.66, 0.56];

/** a body into the depth image: per pixel the nearest surface, which triangle, where on it */
function rasterize(m: Mesh, pi: number, slot: number, depth: Float32Array, label: Uint8Array, cls: Uint8Array, who: Int8Array, tri: Int32Array, bary: Float32Array) {
  const n = m.vertexCount;
  const P = m.pos;
  const U = new Float32Array(n);
  const V = new Float32Array(n);
  const Z = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const z = P[i * 3 + 2] - KZ;
    if (z < 0.1) {
      Z[i] = -1;
      continue;
    }
    U[i] = INTR.cx - (INTR.f * (P[i * 3] - KX)) / z - 0.5;
    V[i] = INTR.cy - (INTR.f * (P[i * 3 + 1] - KY)) / z - 0.5;
    Z[i] = z;
  }
  const T = m.tri;
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t];
    const b = T[t + 1];
    const c = T[t + 2];
    const z0 = Z[a];
    const z1 = Z[b];
    const z2 = Z[c];
    if (z0 <= 0 || z1 <= 0 || z2 <= 0) continue;
    const x0 = U[a];
    const y0 = V[a];
    const x1 = U[b];
    const y1 = V[b];
    const x2 = U[c];
    const y2 = V[c];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) continue;
    const inv = 1 / area;
    const u0 = Math.max(0, Math.ceil(Math.min(x0, x1, x2)));
    const u1 = Math.min(W - 1, Math.floor(Math.max(x0, x1, x2)));
    const v0 = Math.max(0, Math.ceil(Math.min(y0, y1, y2)));
    const v1 = Math.min(H - 1, Math.floor(Math.max(y0, y1, y2)));
    const w0 = 1 / z0;
    const w1 = 1 / z1;
    const w2 = 1 / z2;
    const id = t / 3;
    for (let v = v0; v <= v1; v++) {
      for (let u = u0; u <= u1; u++) {
        const e0 = ((x1 - u) * (y2 - v) - (x2 - u) * (y1 - v)) * inv;
        const e1 = ((x2 - u) * (y0 - v) - (x0 - u) * (y2 - v)) * inv;
        const e2 = 1 - e0 - e1;
        if (e0 < 0 || e1 < 0 || e2 < 0) continue;
        const iz = e0 * w0 + e1 * w1 + e2 * w2;
        const z = 1 / iz;
        const i = v * W + u;
        if (z >= depth[i]) continue;
        depth[i] = z;
        label[i] = slot;
        cls[i] = 4;
        who[i] = pi;
        tri[i] = id;
        bary[i * 2] = (e0 * w0) / iz;
        bary[i * 2 + 1] = (e1 * w1) / iz;
      }
    }
  }
}

// albedo and normal of the room per pixel, filled by the room pass
const nrm = new Int8Array(N); // 0 floor, 1 back wall, 2 ceiling, 3 side +x, 4 side -x, 5.. furniture faces (5 + 0..5)
const alb = new Float32Array(N);
const NORMALS: V3[] = [
  [0, 1, 0], [0, 0, -1], [0, -1, 0], [-1, 0, 0], [1, 0, 0],
  [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1],
];

function capture(seq: number, style: BodyStyle): SensorFrame {
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

  // people: their bodies, rasterized
  const now = people(T);
  const meshes = now.map((p) => bodyAt(p.slot, seq, style) ?? buildBody(p, style));
  // the same bodies one frame earlier (same vertices), for the motion
  const earlier = now.map((p, k) => bodyAt(p.slot, seq - 1, style) ?? meshes[k]);
  const who = new Int8Array(N).fill(-1);
  const tri = new Int32Array(N);
  const bary = new Float32Array(N * 2);
  for (let pi = 0; pi < now.length; pi++) rasterize(meshes[pi], pi, now[pi].slot, depth, label, cls, who, tri, bary);
  const normals = meshes.map((m) => (m.flat ? m.faceNormals() : m.normals()));

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
      let nx: number;
      let ny: number;
      let nz: number;
      let a: number;
      if (label[i]) {
        const pi = who[i];
        const m = meshes[pi];
        const t = tri[i];
        const l0 = bary[i * 2];
        const l1 = bary[i * 2 + 1];
        const l2 = 1 - l0 - l1;
        const ia = m.tri[t * 3] * 3;
        const ib = m.tri[t * 3 + 1] * 3;
        const ic = m.tri[t * 3 + 2] * 3;
        const Nn = normals[pi];
        if (m.flat) {
          nx = Nn[t * 3];
          ny = Nn[t * 3 + 1];
          nz = Nn[t * 3 + 2];
        } else {
          nx = Nn[ia] * l0 + Nn[ib] * l1 + Nn[ic] * l2;
          ny = Nn[ia + 1] * l0 + Nn[ib + 1] * l1 + Nn[ic + 1] * l2;
          nz = Nn[ia + 2] * l0 + Nn[ib + 2] * l1 + Nn[ic + 2] * l2;
          const nl = Math.hypot(nx, ny, nz) || 1;
          nx /= nl;
          ny /= nl;
          nz /= nl;
        }
        // seen from behind (only at the very edge): light it like its front
        if (nx * rx + ny * ry + nz * rz > 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        // where this surface point was one frame ago
        const Q = earlier[pi].pos;
        const ox = Q[ia] * l0 + Q[ib] * l1 + Q[ic] * l2;
        const oy = Q[ia + 1] * l0 + Q[ib + 1] * l1 + Q[ic + 1] * l2;
        const oz = Q[ia + 2] * l0 + Q[ib + 2] * l1 + Q[ic + 2] * l2;
        const zo = oz - KZ;
        if (zo > 0.05) {
          flowU[i] = u - (INTR.cx - (INTR.f * (ox - KX)) / zo - 0.5);
          flowV[i] = v - (INTR.cy - (INTR.f * (oy - KY)) / zo - 0.5);
        }
        const mat = m.mat[t];
        a = mat === MAT.shirt || mat === MAT.dress ? now[pi].spec.albedo : MAT_IR[mat];
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

  return { T, seq, w: W, h: H, depth, ir, label, cls, flowU, flowV, boneDist, who, tri, bary, now, meshes, style, persons };
}
