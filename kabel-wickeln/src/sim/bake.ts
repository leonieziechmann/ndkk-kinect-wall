// Baking and playback of cable simulations. bake() runs a scripted Rod and records every frame;
// a BakedRod plays it back (interpolated positions, material frames, scalar tracks). The binary
// format (bakes/<id>.bin, written by tools/bake.mjs) is:
//
//   u32 magic 'ROD2' | u32 header length | header JSON (utf-8, padded to 4 bytes)
//   f32 tracks   [track][frame]
//   i16 positions [frame][node][xyz], quantised to the bounding box (header.min, header.scale)
//   i16 quaternions [frame][segment][xyzw] × 32767
//
// About 2 bytes per value, position error < 0.1 mm for a 7 m bounding box. In the browser,
// loadBake(id) fetches /bakes/<id>.bin once and caches it by id.

import { V3 } from './vec';
import { Rod } from './rod';

const MAGIC = 0x32444f52; // 'ROD2'

export interface BakeHeader {
  id: string;
  fps: number;
  frames: number;
  nodes: number;
  radius: number;
  /** shot time of frame 0 */
  t0: number;
  tracks: string[];
  /** position quantisation: value = min + (int16 + 32767) * scale */
  min: V3;
  scale: V3;
}

export interface BakeOptions {
  /** id stored in the header (the bake file name) */
  id?: string;
  duration: number;
  /** recorded frames per simulated second (default 60) */
  fps?: number;
  /** substeps per frame (default 30) */
  substeps?: number;
  /** called before each frame is simulated: add and release grips, change stiffness, rest shape, … */
  script?: (rod: Rod, t: number, frame: number) => void;
  /** per-frame scalars for live counters, e.g. { twist: (rod) => rod.twistTurns() } */
  tracks?: Record<string, (rod: Rod, t: number) => number>;
  /** called after each recorded frame */
  onFrame?: (rod: Rod, t: number, frame: number) => void;
}

export interface BakeStats {
  wallSeconds: number;
  simSecondsPerWallSecond: number;
  substeps: number;
  fps: number;
  nodes: number;
}

/** Runs the rod for `duration` seconds and records it. */
export function bake(rod: Rod, o: BakeOptions): BakedRod {
  const fps = o.fps ?? 60, substeps = o.substeps ?? 30;
  const F = Math.round(o.duration * fps) + 1;
  const n = rod.n, ns = rod.ns;
  const names = Object.keys(o.tracks ?? {});
  const fns = names.map((k) => o.tracks![k]);
  const pos = new Float32Array(F * 3 * n), quat = new Float32Array(F * 4 * ns), tracks = new Float32Array(F * names.length);
  const t0 = rod.time;
  const start = performance.now();
  for (let f = 0; f < F; f++) {
    o.script?.(rod, rod.time, f);
    if (f > 0) rod.step(1 / fps, substeps);
    else rod.sync();
    pos.set(rod.x, f * 3 * n);
    quat.set(rod.q, f * 4 * ns);
    for (let k = 0; k < fns.length; k++) tracks[k * F + f] = fns[k](rod, rod.time);
    o.onFrame?.(rod, rod.time, f);
  }
  const wall = (performance.now() - start) / 1000;
  const baked = new BakedRod({ id: o.id ?? '', fps, frames: F, nodes: n, radius: rod.radius, t0, tracks: names, min: [0, 0, 0], scale: [1, 1, 1] }, pos, quat, tracks);
  baked.stats = { wallSeconds: wall, simSecondsPerWallSecond: o.duration / wall, substeps, fps, nodes: n };
  return baked;
}

/** A recorded rod: sample it at any shot time (clamped to the recording). */
export class BakedRod {
  readonly id: string;
  /** nodes and segments */
  readonly n: number;
  readonly ns: number;
  readonly fps: number;
  readonly frames: number;
  readonly t0: number;
  readonly duration: number;
  readonly radius: number;
  readonly trackNames: readonly string[];
  /** frames × 3n node positions, frames × 4ns segment quaternions, tracks × frames scalars */
  readonly pos: Float32Array;
  readonly quat: Float32Array;
  readonly trackData: Float32Array;
  stats: BakeStats | null = null;
  private readonly trackIndex = new Map<string, number>();
  private readonly qScratch: Float32Array;
  /** frame f0, frame f1 and the blend between them, from at() */
  private readonly fa = new Float64Array(3);

  constructor(h: BakeHeader, pos: Float32Array, quat: Float32Array, tracks: Float32Array) {
    this.id = h.id;
    this.n = h.nodes;
    this.ns = h.nodes - 1;
    this.fps = h.fps;
    this.frames = h.frames;
    this.t0 = h.t0;
    this.duration = (h.frames - 1) / h.fps;
    this.radius = h.radius;
    this.trackNames = h.tracks;
    h.tracks.forEach((k, i) => this.trackIndex.set(k, i));
    this.pos = pos;
    this.quat = quat;
    this.trackData = tracks;
    this.qScratch = new Float32Array(4 * this.ns);
  }

  /** Frame index f0, the next frame f1 and the blend a between them at time t. */
  private at(t: number, out: Float64Array) {
    const u = Math.min(this.frames - 1, Math.max(0, (t - this.t0) * this.fps));
    const f0 = Math.floor(u);
    out[0] = f0;
    out[1] = Math.min(this.frames - 1, f0 + 1);
    out[2] = u - f0;
  }

  /** Interpolated node positions (3n) and segment quaternions (4ns) at time t. */
  sample(t: number, outPos: Float32Array, outQuat: Float32Array) {
    this.at(t, this.fa);
    const f0 = this.fa[0], f1 = this.fa[1], a = this.fa[2];
    const P = this.pos, Q = this.quat, np = 3 * this.n, nq = 4 * this.ns;
    const o0 = f0 * np, o1 = f1 * np;
    for (let i = 0; i < np; i++) outPos[i] = P[o0 + i] + (P[o1 + i] - P[o0 + i]) * a;
    const q0 = f0 * nq, q1 = f1 * nq;
    for (let j = 0; j < nq; j += 4) {
      const ax = Q[q0 + j], ay = Q[q0 + j + 1], az = Q[q0 + j + 2], aw = Q[q0 + j + 3];
      let bx = Q[q1 + j], by = Q[q1 + j + 1], bz = Q[q1 + j + 2], bw = Q[q1 + j + 3];
      if (ax * bx + ay * by + az * bz + aw * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
      const x = ax + (bx - ax) * a, y = ay + (by - ay) * a, z = az + (bz - az) * a, w = aw + (bw - aw) * a;
      const il = 1 / Math.hypot(x, y, z, w);
      outQuat[j] = x * il; outQuat[j + 1] = y * il; outQuat[j + 2] = z * il; outQuat[j + 3] = w * il;
    }
  }

  /**
   * Node positions and per-node material frames at time t for a tube mesh (3n floats each):
   * d1 is the stripe direction, d3 the tangent. d2 and d3 are optional. Returns the node count.
   */
  frameSample(t: number, pos: Float32Array, d1: Float32Array, d2?: Float32Array, d3?: Float32Array): number {
    const q = this.qScratch, n = this.n, ns = this.ns;
    this.sample(t, pos, q);
    for (let i = 0; i < n; i++) {
      // node i averages the frames of segments i-1 and i
      const ja = Math.max(0, i - 1), jb = Math.min(ns - 1, i);
      const ax = q[4 * ja], ay = q[4 * ja + 1], az = q[4 * ja + 2], aw = q[4 * ja + 3];
      let bx = q[4 * jb], by = q[4 * jb + 1], bz = q[4 * jb + 2], bw = q[4 * jb + 3];
      if (ax * bx + ay * by + az * bz + aw * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
      let x = ax + bx, y = ay + by, z = az + bz, w = aw + bw;
      const il = 1 / Math.hypot(x, y, z, w);
      x *= il; y *= il; z *= il; w *= il;
      const o = 3 * i;
      d1[o] = 1 - 2 * (y * y + z * z); d1[o + 1] = 2 * (x * y + w * z); d1[o + 2] = 2 * (x * z - w * y);
      if (d2) { d2[o] = 2 * (x * y - w * z); d2[o + 1] = 1 - 2 * (x * x + z * z); d2[o + 2] = 2 * (y * z + w * x); }
      if (d3) { d3[o] = 2 * (x * z + w * y); d3[o + 1] = 2 * (y * z - w * x); d3[o + 2] = 1 - 2 * (x * x + y * y); }
    }
    return n;
  }

  /** Position of node i at time t (for labels and arrows), written into out. */
  nodeAt(t: number, i: number, out: V3): V3 {
    this.at(t, this.fa);
    const P = this.pos, np = 3 * this.n, a = this.fa[2];
    const o0 = this.fa[0] * np + 3 * i, o1 = this.fa[1] * np + 3 * i;
    for (let k = 0; k < 3; k++) out[k] = P[o0 + k] + (P[o1 + k] - P[o0 + k]) * a;
    return out;
  }

  /** Recorded scalar track at time t (linear interpolation). */
  track(name: string, t: number): number {
    const k = this.trackIndex.get(name);
    if (k === undefined) throw new Error(`bake "${this.id}" has no track "${name}" (tracks: ${this.trackNames.join(', ')})`);
    this.at(t, this.fa);
    const d = this.trackData, o = k * this.frames;
    return d[o + this.fa[0]] + (d[o + this.fa[1]] - d[o + this.fa[0]]) * this.fa[2];
  }

  /** The binary bake file (see the header of this file). */
  toBinary(): ArrayBuffer {
    const P = this.pos;
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) {
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], P[i + k]); max[k] = Math.max(max[k], P[i + k]); }
    }
    const scale: V3 = [0, 1, 2].map((k) => Math.max(max[k] - min[k], 1e-6) / 65534) as V3;
    const header: BakeHeader = { id: this.id, fps: this.fps, frames: this.frames, nodes: this.n, radius: this.radius, t0: this.t0, tracks: [...this.trackNames], min, scale };
    let json = new TextEncoder().encode(JSON.stringify(header));
    const hl = (json.length + 3) & ~3;
    if (hl !== json.length) {
      const padded = new Uint8Array(hl).fill(0x20);
      padded.set(json);
      json = padded;
    }
    const offT = 8 + hl, offP = offT + 4 * this.trackData.length, offQ = offP + 2 * P.length;
    const buf = new ArrayBuffer(offQ + 2 * this.quat.length);
    const u32 = new Uint32Array(buf, 0, 2);
    u32[0] = MAGIC;
    u32[1] = hl;
    new Uint8Array(buf, 8, hl).set(json);
    new Float32Array(buf, offT, this.trackData.length).set(this.trackData);
    const qp = new Int16Array(buf, offP, P.length);
    for (let i = 0; i < P.length; i++) qp[i] = Math.round((P[i] - min[i % 3]) / scale[i % 3]) - 32767;
    const qq = new Int16Array(buf, offQ, this.quat.length);
    for (let i = 0; i < qq.length; i++) qq[i] = Math.round(this.quat[i] * 32767);
    return buf;
  }

  static fromBinary(buf: ArrayBuffer): BakedRod {
    const u32 = new Uint32Array(buf, 0, 2);
    if (u32[0] !== MAGIC) throw new Error('not a rod bake (wrong magic); rebake with npm run bake');
    const hl = u32[1];
    const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl))) as BakeHeader;
    const nt = h.tracks.length * h.frames, np = h.frames * 3 * h.nodes, nq = h.frames * 4 * (h.nodes - 1);
    const offT = 8 + hl, offP = offT + 4 * nt, offQ = offP + 2 * np;
    const tracks = new Float32Array(buf.slice(offT, offP));
    const ip = new Int16Array(buf, offP, np), iq = new Int16Array(buf, offQ, nq);
    const pos = new Float32Array(np), quat = new Float32Array(nq);
    for (let i = 0; i < np; i++) pos[i] = h.min[i % 3] + (ip[i] + 32767) * h.scale[i % 3];
    for (let i = 0; i < nq; i++) quat[i] = iq[i] / 32767;
    return new BakedRod(h, pos, quat, tracks);
  }
}

// ------------------------------------------------------------------ browser loader

const pending = new Map<string, Promise<BakedRod>>();
const loaded = new Map<string, BakedRod>();

/**
 * Fetches /bakes/<id>.bin (served by Vite from the project's bakes/ directory) once per id.
 * In a scene: `yield loadBake('id')` before the first frame, then bakeOf('id').
 */
export function loadBake(id: string): Promise<BakedRod> {
  let p = pending.get(id);
  if (!p) {
    p = fetch(`/bakes/${id}.bin`, { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`bake "${id}" missing (HTTP ${r.status}): run npm run bake`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        const b = BakedRod.fromBinary(buf);
        loaded.set(id, b);
        return b;
      });
    p.catch(() => pending.delete(id));
    pending.set(id, p);
  }
  return p;
}

/** A bake that loadBake(id) has already loaded. */
export function bakeOf(id: string): BakedRod {
  const b = loaded.get(id);
  if (!b) throw new Error(`bake "${id}" is not loaded: yield loadBake('${id}') first`);
  return b;
}
