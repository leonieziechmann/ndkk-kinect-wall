// A virtual Kinect v2 depth camera: renders depth (u16 mm) and infrared (u8, the hub's tone mapping)
// of a triangle scene the way kinect-hub delivers them (512 x 424, mirrored, lens distortion in the
// pixel grid, the undistorted rays as the LUT), with the sensor's typical faults: depth noise that
// grows with distance and darkness, mixed ("flying") pixels at depth edges, holes where too little
// infrared comes back, grazing angles and the range limits of 0.5–4.5 m.
//
// Rendering is a small CPU rasterizer (no GPU, no browser: the same numbers on every machine). Each
// pixel is S x S subsamples; the room (floor, walls, ceiling) is intersected analytically per
// subsample once, the person and the cable are rasterized as triangles every frame (z-buffer with
// the true camera z). A pixel then combines its subsamples like a time-of-flight pixel: the
// infrared is their mean brightness, the depth their brightness-weighted mean when they agree, and
// at an edge either that mix (a flying pixel) or nothing (what libfreenect2's edge filter leaves).
//
// Frames (mocap/FORMAT.md): CAMERA = the unmirrored depth camera, x right as seen from the sensor
// looking into the scene, y down, z forward; the hub's mirrored point of pixel (u, v) at depth z is
// (lut.x*z, lut.y*z, z) and the camera point (-lut.x*z, lut.y*z, z). WORLD = y up, floor y = 0,
// origin on the floor below the sensor, +z horizontal from the person's mark towards the sensor
// (the camera looks along -z, tilted by its pitch), x = y × z (right as seen from the sensor).

import type { V3 } from '../../src/people/math';

export const W = 512;
export const H = 424;

/** depth camera intrinsics and distortion, libfreenect2's model (as the hub stores them in `params`) */
export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  k1: number;
  k2: number;
  k3: number;
  p1: number;
  p2: number;
}

/** like a real Kinect v2's depth camera (values of the order libfreenect2 reads from a device) */
export const KINECT_V2: Intrinsics = { fx: 365.6, fy: 365.6, cx: 256.9, cy: 211.4, k1: 0.0904, k2: -0.2694, k3: 0.0935, p1: 0, p2: 0 };

/**
 * The undistorted ray (x, y) of the distorted pixel position (u, v): the hub's point at depth z is
 * (x*z, y*z, z), mirrored. Fixed-point inversion as in kinect-hub/src/lut.rs, in f32 like there.
 */
export function undistort(p: Intrinsics, u: number, v: number): [number, number] {
  const f = Math.fround;
  const xd = f(f(u - p.cx) / p.fx);
  const yd = f(f(v - p.cy) / p.fy);
  let x = xd;
  let y = yd;
  for (let i = 0; i < 12; i++) {
    const r2 = f(f(x * x) + f(y * y));
    const kr = f(1 + f(f(f(f(f(p.k3 * r2) + p.k2) * r2) + p.k1) * r2));
    if (Math.abs(kr) < 1e-3) break;
    const dx = f(f(p.p2 * f(r2 + f(2 * x * x))) + f(2 * p.p1 * x * y));
    const dy = f(f(p.p1 * f(r2 + f(2 * y * y))) + f(2 * p.p2 * x * y));
    x = f(f(xd - dx) / kr);
    y = f(f(yd - dy) / kr);
  }
  if (!(Number.isFinite(x) && Number.isFinite(y)) || Math.abs(x - xd) > 0.5 || Math.abs(y - yd) > 0.5) return [xd, yd];
  return [x, y];
}

/** the LUT the hub sends (kind 16): f32 x, y per pixel, row-major */
export function lutOf(p: Intrinsics): Float32Array {
  const out = new Float32Array(W * H * 2);
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const [x, y] = undistort(p, u, v);
      out[(v * W + u) * 2] = x;
      out[(v * W + u) * 2 + 1] = y;
    }
  }
  return out;
}

/** pixel (u, v) of the hub's mirrored image for a CAMERA point (unmirrored, any unit; z > 0) */
export function project(p: Intrinsics, X: number, Y: number, Z: number): [number, number] {
  const x = -X / Z;
  const y = Y / Z;
  const r2 = x * x + y * y;
  const kr = 1 + ((p.k3 * r2 + p.k2) * r2 + p.k1) * r2;
  const xd = x * kr + p.p2 * (r2 + 2 * x * x) + 2 * p.p1 * x * y;
  const yd = y * kr + p.p1 * (r2 + 2 * y * y) + 2 * p.p2 * x * y;
  return [p.cx + p.fx * xd, p.cy + p.fy * yd];
}

// ---------------------------------------------------------------- frames

/** a rigid transform: p' = R p + t (R row-major 3x3) */
export interface Rigid {
  R: number[];
  t: V3;
}
export const apply = (m: Rigid, p: V3): V3 => [
  m.R[0] * p[0] + m.R[1] * p[1] + m.R[2] * p[2] + m.t[0],
  m.R[3] * p[0] + m.R[4] * p[1] + m.R[5] * p[2] + m.t[1],
  m.R[6] * p[0] + m.R[7] * p[1] + m.R[8] * p[2] + m.t[2],
];
export function inverse(m: Rigid): Rigid {
  const R = [m.R[0], m.R[3], m.R[6], m.R[1], m.R[4], m.R[7], m.R[2], m.R[5], m.R[8]];
  const t = apply({ R, t: [0, 0, 0] }, m.t);
  return { R, t: [-t[0], -t[1], -t[2]] };
}
export const compose = (a: Rigid, b: Rigid): Rigid => {
  // a ∘ b: first b, then a
  const R = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R[i * 3 + j] = a.R[i * 3] * b.R[j] + a.R[i * 3 + 1] * b.R[3 + j] + a.R[i * 3 + 2] * b.R[6 + j];
  return { R, t: apply(a, b.t) };
};
/** 4x4 row-major, translation scaled (m → mm: 1000) */
export const mat4 = (m: Rigid, unit = 1): number[] => [
  m.R[0], m.R[1], m.R[2], m.t[0] * unit, m.R[3], m.R[4], m.R[5], m.t[1] * unit, m.R[6], m.R[7], m.R[8], m.t[2] * unit, 0, 0, 0, 1,
];

export interface Placement {
  /** rig world (person at the origin facing -z) → WORLD, m */
  rigToWorld: Rigid;
  /** CAMERA → WORLD, m */
  camToWorld: Rigid;
  worldToCam: Rigid;
  /** the person's mark in WORLD, m */
  mark: V3;
}

/**
 * Where everything is, from the setup: the sensor `distance` from the mark at `yaw` (as seen from the
 * person facing -z in the rig world: +90° = on the person's right), `height` above the floor, aimed
 * horizontally at the mark and tilted by `pitch` (negative = down), no roll.
 */
export function place(s: { height_m: number; distance_m: number; yaw_deg: number; pitch_deg: number }): Placement {
  const a = (s.yaw_deg * Math.PI) / 180;
  const D = s.distance_m;
  // rig world: the horizontal direction from the mark to the sensor
  const ez: V3 = [Math.sin(a), 0, -Math.cos(a)];
  const ey: V3 = [0, 1, 0];
  const ex: V3 = [ey[1] * ez[2] - ey[2] * ez[1], ey[2] * ez[0] - ey[0] * ez[2], ey[0] * ez[1] - ey[1] * ez[0]];
  // the floor below the sensor
  const O: V3 = [D * ez[0], 0, D * ez[2]];
  const R = [...ex, ...ey, ...ez];
  const rot = { R, t: [0, 0, 0] as V3 };
  const t = apply(rot, O);
  const rigToWorld: Rigid = { R, t: [-t[0], -t[1], -t[2]] };
  // camera axes in WORLD: x right = +x, y down, z forward (tilted by the pitch)
  const th = (s.pitch_deg * Math.PI) / 180;
  const xc: V3 = [1, 0, 0];
  const yc: V3 = [0, -Math.cos(th), -Math.sin(th)];
  const zc: V3 = [0, Math.sin(th), -Math.cos(th)];
  const camToWorld: Rigid = { R: [xc[0], yc[0], zc[0], xc[1], yc[1], zc[1], xc[2], yc[2], zc[2]], t: [0, s.height_m, 0] };
  return { rigToWorld, camToWorld, worldToCam: inverse(camToWorld), mark: [0, 0, -D] };
}

// ---------------------------------------------------------------- the room

/** ids of what a subsample sees */
export const HIT = { none: 0, floor: 1, wall: 2, side: 3, ceiling: 4, person: 5, cable: 6 } as const;
export const HIT_NAMES = ['none', 'floor', 'wall', 'side', 'ceiling', 'person', 'cable'];

/** a plane of the room in WORLD: inside where n·p < c (n points out of the room), m */
export interface Plane {
  n: V3;
  c: number;
  albedo: number;
  id: number;
}

/** a box room around sensor and person: floor, the bright wall behind the person, side walls, ceiling, a wall behind the sensor */
export function room(markDistance: number, wallBehind: number, o: { halfWidth?: number; ceiling?: number; albedo?: Partial<Record<'floor' | 'wall' | 'side' | 'ceiling', number>> } = {}): Plane[] {
  const al = { floor: 0.42, wall: 0.78, side: 0.6, ceiling: 0.6, ...o.albedo };
  const hw = o.halfWidth ?? 2.6;
  return [
    { n: [0, -1, 0], c: 0, albedo: al.floor, id: HIT.floor },
    { n: [0, 1, 0], c: o.ceiling ?? 2.8, albedo: al.ceiling, id: HIT.ceiling },
    { n: [0, 0, -1], c: markDistance + wallBehind, albedo: al.wall, id: HIT.wall },
    { n: [0, 0, 1], c: 1.0, albedo: al.side, id: HIT.side },
    { n: [-1, 0, 0], c: hw, albedo: al.side, id: HIT.side },
    { n: [1, 0, 0], c: hw, albedo: al.side, id: HIT.side },
  ];
}

// ---------------------------------------------------------------- random numbers

/** a small seeded generator (mulberry32) with normal deviates */
export class Rng {
  private s: number;
  private spare: number | null = null;
  public constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  public next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  public gauss(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0;
    while (u <= 1e-12) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
}

// ---------------------------------------------------------------- the sensor

export interface SensorOptions {
  /** subsamples per pixel and axis (3: 9 per pixel) */
  ss?: number;
  /** depth noise factor (1 = like a Kinect v2: ~2.5 mm at 2 m on skin, more on dark things and far away) */
  noise?: number;
  /** how many mixed pixels at depth edges survive as flying pixels (0 … 1; the rest become 0) */
  flying?: number;
  /** raw infrared for albedo 1 at 1 m, head-on (the hub maps 6000 to white) */
  irGain?: number;
  /** below this raw infrared there is no depth (too dark) */
  irMin?: number;
  /** random dropouts per pixel */
  dropout?: number;
  seed?: number;
}

/** the hub's infrared tone mapping (kinect-hub/src/pipeline.rs): raw value → `ir` byte */
export function irTone(raw: number): number {
  const i = Math.min(65535, Math.max(0, Math.floor(raw))) >> 4;
  const v = (i << 4) + 8;
  return Math.floor(Math.sqrt(Math.min(1, Math.max(0, v / 6000))) * 255 + 0.5);
}

export class Sensor {
  public readonly S: number;
  public readonly WS: number;
  public readonly HS: number;
  /** per subsample: the true camera ray (x, y, 1) */
  private readonly rx: Float32Array;
  private readonly ry: Float32Array;
  /** the room, per subsample: camera z (mm), albedo·cos, cos, hit id */
  private readonly bgZ: Float32Array;
  private readonly bgA: Float32Array;
  private readonly bgC: Float32Array;
  private readonly bgId: Uint8Array;
  /** this frame */
  public readonly z: Float32Array;
  public readonly a: Float32Array;
  public readonly c: Float32Array;
  public readonly id: Uint8Array;
  /** per pixel: the illumination falloff towards the image corners */
  private readonly vignette: Float32Array;
  private readonly rng: Rng;
  private readonly o: Required<SensorOptions>;

  public constructor(
    public readonly k: Intrinsics,
    public readonly camToWorld: Rigid,
    planes: Plane[],
    o: SensorOptions = {},
  ) {
    this.o = { ss: 3, noise: 1, flying: 0.3, irGain: 14000, irMin: 45, dropout: 0.0004, seed: 1, ...o };
    const S = (this.S = this.o.ss);
    this.WS = W * S;
    this.HS = H * S;
    const n = this.WS * this.HS;
    this.rx = new Float32Array(n);
    this.ry = new Float32Array(n);
    for (let j = 0; j < this.HS; j++) {
      for (let i = 0; i < this.WS; i++) {
        const [x, y] = undistort(k, (i + 0.5) / S - 0.5, (j + 0.5) / S - 0.5);
        this.rx[j * this.WS + i] = -x;
        this.ry[j * this.WS + i] = y;
      }
    }
    this.bgZ = new Float32Array(n);
    this.bgA = new Float32Array(n);
    this.bgC = new Float32Array(n);
    this.bgId = new Uint8Array(n);
    const R = camToWorld.R;
    const o0 = camToWorld.t;
    for (let s = 0; s < n; s++) {
      const dc: V3 = [this.rx[s], this.ry[s], 1];
      const d: V3 = [R[0] * dc[0] + R[1] * dc[1] + R[2], R[3] * dc[0] + R[4] * dc[1] + R[5], R[6] * dc[0] + R[7] * dc[1] + R[8]];
      const dl = Math.hypot(d[0], d[1], d[2]);
      let best = Infinity;
      let hit: Plane | null = null;
      for (const pl of planes) {
        const dn = pl.n[0] * d[0] + pl.n[1] * d[1] + pl.n[2] * d[2];
        if (dn <= 1e-9) continue;
        const t = (pl.c - (pl.n[0] * o0[0] + pl.n[1] * o0[1] + pl.n[2] * o0[2])) / dn;
        if (t > 0 && t < best) {
          best = t;
          hit = pl;
        }
      }
      if (!hit) continue;
      // t is along (x, y, 1): the camera z
      const cos = Math.abs(hit.n[0] * d[0] + hit.n[1] * d[1] + hit.n[2] * d[2]) / dl;
      this.bgZ[s] = best * 1000;
      this.bgC[s] = cos;
      this.bgA[s] = hit.albedo * cos;
      this.bgId[s] = hit.id;
    }
    this.z = new Float32Array(n);
    this.a = new Float32Array(n);
    this.c = new Float32Array(n);
    this.id = new Uint8Array(n);
    this.vignette = new Float32Array(W * H);
    const r0 = Math.hypot(W / 2, H / 2);
    for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
      const r = Math.hypot(u - k.cx, v - k.cy) / r0;
      this.vignette[v * W + u] = 1 - 0.42 * r * r;
    }
    this.rng = new Rng(this.o.seed);
  }

  /** starts a frame: the room only */
  public clear() {
    this.z.set(this.bgZ);
    this.a.set(this.bgA);
    this.c.set(this.bgC);
    this.id.set(this.bgId);
  }

  /**
   * Rasterizes triangles given in CAMERA coordinates (m, 9 numbers each), each with an infrared
   * albedo and a hit id. Depth is interpolated as 1/z across the triangle (perspective-correct).
   */
  public draw(tris: Float32Array, count: number, albedo: Float32Array, ids: Uint8Array) {
    const { S, WS, HS, k } = this;
    const zb = this.z;
    const sx = [0, 0, 0];
    const sy = [0, 0, 0];
    const iz = [0, 0, 0];
    for (let t = 0; t < count; t++) {
      const o = t * 9;
      let behind = false;
      for (let v = 0; v < 3; v++) {
        const X = tris[o + v * 3];
        const Y = tris[o + v * 3 + 1];
        const Z = tris[o + v * 3 + 2];
        if (Z < 0.2) {
          behind = true;
          break;
        }
        const [u, w] = project(k, X, Y, Z);
        sx[v] = (u + 0.5) * S - 0.5;
        sy[v] = (w + 0.5) * S - 0.5;
        iz[v] = 1 / (Z * 1000);
      }
      if (behind) continue;
      const x0 = Math.max(0, Math.ceil(Math.min(sx[0], sx[1], sx[2])));
      const x1 = Math.min(WS - 1, Math.floor(Math.max(sx[0], sx[1], sx[2])));
      const y0 = Math.max(0, Math.ceil(Math.min(sy[0], sy[1], sy[2])));
      const y1 = Math.min(HS - 1, Math.floor(Math.max(sy[0], sy[1], sy[2])));
      if (x0 > x1 || y0 > y1) continue;
      const area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
      if (Math.abs(area) < 1e-12) continue;
      const inv = 1 / area;
      // the face normal in camera coordinates, for the infrared's cosine
      const ax = tris[o + 3] - tris[o], ay = tris[o + 4] - tris[o + 1], az = tris[o + 5] - tris[o + 2];
      const bx = tris[o + 6] - tris[o], by = tris[o + 7] - tris[o + 1], bz = tris[o + 8] - tris[o + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const alb = albedo[t];
      const hid = ids[t];
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          // barycentric weights (signed areas, same sign as `area` inside)
          const w0 = ((sx[1] - x) * (sy[2] - y) - (sx[2] - x) * (sy[1] - y)) * inv;
          const w1 = ((sx[2] - x) * (sy[0] - y) - (sx[0] - x) * (sy[2] - y)) * inv;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const zmm = 1 / (w0 * iz[0] + w1 * iz[1] + w2 * iz[2]);
          const s = y * WS + x;
          if (zmm >= zb[s]) continue;
          const rx = this.rx[s], ry = this.ry[s];
          const cos = Math.abs(nx * rx + ny * ry + nz) / Math.sqrt(rx * rx + ry * ry + 1);
          zb[s] = zmm;
          this.c[s] = cos;
          this.a[s] = alb * cos;
          this.id[s] = hid;
        }
      }
    }
  }

  /** what the subsample nearest to pixel position (u, v) sees: camera z (mm) and hit id, before noise */
  public at(u: number, v: number): { z: number; id: number } {
    const i = Math.round((u + 0.5) * this.S - 0.5);
    const j = Math.round((v + 0.5) * this.S - 0.5);
    if (i < 0 || j < 0 || i >= this.WS || j >= this.HS) return { z: 0, id: HIT.none };
    const s = j * this.WS + i;
    return { z: this.z[s], id: this.id[s] };
  }

  /**
   * The frame as the hub records it: depth (u16 mm, 0 = no measurement) and infrared (u8, the hub's
   * tone mapping), both in the mirrored pixel grid. `raw` gets the raw infrared (for tests).
   */
  public measure(depth: Uint16Array, ir: Uint8Array, raw?: Float32Array) {
    const { S, WS, rng, o } = this;
    const n2 = S * S;
    const zs = new Float32Array(n2);
    const ws = new Float32Array(n2);
    for (let v = 0; v < H; v++) {
      for (let u = 0; u < W; u++) {
        let sum = 0;
        let valid = 0;
        let m = 0;
        let amax = 0;
        for (let j = 0; j < S; j++) {
          const row = (v * S + j) * WS + u * S;
          for (let i = 0; i < S; i++) {
            const s = row + i;
            const z = this.z[s];
            if (!(z > 0)) continue;
            const rx = this.rx[s], ry = this.ry[s];
            const d2 = (z / 1000) * (z / 1000) * (rx * rx + ry * ry + 1);
            const a = this.a[s] / d2;
            sum += a;
            if (z >= 500 && z <= 4500 && this.c[s] >= 0.06) {
              zs[m] = z;
              ws[m] = a;
              valid += a;
              if (a > amax) amax = a;
              m++;
            }
          }
        }
        const p = v * W + u;
        // the infrared: the subsamples' mean brightness, a little shot noise
        let I = (o.irGain * this.vignette[p] * sum) / n2;
        if (raw) raw[p] = I;
        I = Math.max(0, I * (1 + 0.02 * rng.gauss()) + 3 * rng.gauss());
        ir[p] = irTone(I);
        // the depth
        let Z = 0;
        if (m > 0 && valid >= 0.6 * sum && I >= o.irMin) {
          let lo = Infinity;
          let hi = -Infinity;
          let acc = 0;
          for (let q = 0; q < m; q++) {
            acc += zs[q] * ws[q];
            if (ws[q] > 0.05 * amax) {
              if (zs[q] < lo) lo = zs[q];
              if (zs[q] > hi) hi = zs[q];
            }
          }
          Z = acc / valid;
          // an edge: the pixel mixes two surfaces; the edge filter removes most of them
          if (hi - lo > 35 && rng.next() >= o.flying) Z = 0;
          if (Z > 0) {
            const zm = Z / 1000;
            // ~1.5 mm at 1.3 m, ~2.5 mm at 2 m, ~6 mm at 3.2 m on clothes; more where it is dark
            const dark = Math.min(4, Math.max(0.8, Math.sqrt(1000 / Math.max(I, 1))));
            Z += o.noise * (0.9 + 0.4 * zm * zm) * dark * rng.gauss();
            if (rng.next() < o.dropout) Z = 0;
          }
        }
        depth[p] = Z >= 500 && Z <= 4500 ? Math.round(Z) : 0;
      }
    }
  }
}
