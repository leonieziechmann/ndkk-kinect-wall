// Hands holding the cable: pinches (the cable between the thumb and index pads) and bundles (a
// coil held in a hand). Both are attachments of the rod (rod.pinch(), rod.bundle()) to kinematic
// hand frames. The hand goes to the cable, never the other way round: a pinch takes the material
// point that is between the pads at that moment (the closest point), a bundle takes strands where
// they are, and every change of grip blends over a short time, so nothing jumps.
//
// How they act on the rod (per substep, see Rod): prepare() decides which segments are held and how
// firmly, and tells the rod (holdBody) how much heavier those segments are in the directions they
// are held (the Schur complement of the attachment: W (1 - f) along a held direction, f = how much
// of the error the attachment removes per iteration). project() moves the held segments to where
// the hand wants them before every direct solve, and the direct solve then closes the joints
// without moving them back. finish() does the bookkeeping after the substep (sliding, rolling).
//
// Conventions: frames are grip frames (vec.ts): p on the cable axis between the pads, d3 the
// direction the cable runs through them (increasing material coordinate s), d1 toward the palm,
// d2 = d3 × d1. Material coordinates s are rest arc lengths from node 0 [m]. Time is shot time.

import type { Rod } from './rod';
import { Frame, Quat, V3, quatConj, quatMul, quatRotate, quatSlerp, smooth } from './vec';

/** A hand frame: a function of shot time, or a fixed frame (move it with moveTo / set it with setFrame). */
export type FrameSource = Frame | ((t: number) => Frame);

/** What the rod calls on its attachments every substep. @internal */
export interface Attachment {
  /** true once the attachment let go completely (the rod then drops it) */
  readonly done: boolean;
  prepare(t: number, h: number): void;
  project(h: number, iteration: number): void;
  finish(h: number): void;
  /** marks the segments it holds rigidly (inverse mass and inertia 0) */
  kinematic(wc: Float64Array, wt: Float64Array): void;
  /** the segments it holds (debug pictures) */
  segments(out: number[]): void;
}

/** A hand frame over time: a function, or fixed frames with linear moves between them. */
class FrameTrack {
  private fn: ((t: number) => Frame) | null = null;
  private a: Frame = { p: [0, 0, 0], q: [0, 0, 0, 1] };
  private b: Frame = this.a;
  private t0 = 0;
  private t1 = 0;

  constructor(src: FrameSource) {
    this.set(src);
  }

  set(src: FrameSource) {
    if (typeof src === 'function') this.fn = src;
    else {
      this.fn = null;
      this.a = this.b = src;
      this.t0 = this.t1 = 0;
    }
  }

  /** from the frame at time t to f, linearly over dt (slerp for the rotation) */
  moveTo(f: Frame, t: number, dt: number) {
    const cur = this.at(t);
    this.fn = null;
    this.a = cur;
    this.b = f;
    this.t0 = t;
    this.t1 = t + Math.max(dt, 1e-9);
  }

  at(t: number): Frame {
    if (this.fn) return this.fn(t);
    if (t >= this.t1) return this.b;
    if (t <= this.t0) return this.a;
    const u = (t - this.t0) / (this.t1 - this.t0), a = this.a, b = this.b;
    return { p: [a.p[0] + (b.p[0] - a.p[0]) * u, a.p[1] + (b.p[1] - a.p[1]) * u, a.p[2] + (b.p[2] - a.p[2]) * u], q: quatSlerp(a.q, b.q, u) };
  }
}

const col = (q: Readonly<Quat>, k: 0 | 1 | 2): V3 => {
  const [x, y, z, w] = q;
  if (k === 0) return [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
  if (k === 1) return [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
  return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
};

/** d1 and d3 of segment j */
function segAxes(rod: Rod, j: number): [V3, V3] {
  const q = rod.q, j4 = 4 * j;
  const qq: Quat = [q[j4], q[j4 + 1], q[j4 + 2], q[j4 + 3]];
  return [col(qq, 0), col(qq, 2)];
}

/** angle of v projected on the plane ⊥ n, measured from e1 toward e2 */
function angleIn(v: V3, e1: V3, e2: V3) {
  return Math.atan2(v[0] * e2[0] + v[1] * e2[1] + v[2] * e2[2], v[0] * e1[0] + v[1] * e1[1] + v[2] * e1[2]);
}

const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

// ------------------------------------------------------------------ pinch

/**
 * held: the cable does not slip and rolls with the hand (and with roll()); loose: the pads keep it
 * on their line but it slides through them against the friction force (the hand slides along the
 * cable); free: the pads are off the cable.
 */
export type PinchMode = 'held' | 'loose' | 'free';

const LEVEL: Record<PinchMode, number> = { free: 0, loose: 0.5, held: 1 };
/** axial force [N] a pinch halfway between loose and held resists before it slips */
const HOLD_FORCE = 5;

export interface PinchSpec {
  /** the pads' frame (grip frame): p between the pads on the cable axis, d3 along the cable */
  frame: FrameSource;
  /** material coordinate at the pads [m]; default: the material point closest to p now */
  s?: number;
  /** half length of the pads along the cable [m] (default 0.008) */
  pad?: number;
  /** grip at the start (default 'held'); it closes from free over `blend` */
  mode?: PinchMode;
  /** seconds for every change of mode (default 0.12) */
  blend?: number;
  /** axial friction force of a loose pinch [N] (default 0.2) */
  friction?: number;
  /** roll of the cable relative to the pads [rad] about d3 (thumb against index); default 0 */
  roll?: number | ((t: number) => number);
  /** false: the pads never turn the cable about its axis (a swivel) */
  rolls?: boolean;
  /** the hand's capsule group (Capsule.group): those capsules do not push the cable inside the pads */
  hand?: number;
}

/**
 * The cable between thumb and index pads. Create with rod.pinch(spec); change it any time from a
 * shot script (sim in the loop): set(mode), setRoll(angle), moveTo(frame, dt), release().
 */
export class Pinch implements Attachment {
  /** material coordinate at the middle of the pads [m]; changes while the cable slides */
  s: number;
  /** distance from p to the cable when the pinch was made [m] (how far the hand was off it) */
  readonly gripDistance: number;
  /** speed the cable slid through the pads in the last substep [m/s]: + when the pads moved toward higher s */
  slip = 0;
  /** axial force of the pads on the cable in the last substep [N] */
  force = 0;
  done = false;
  readonly pad: number;
  readonly hand: number;
  friction: number;
  blend: number;
  private readonly rod: Rod;
  private readonly track: FrameTrack;
  private rollFn: (t: number) => number;
  private readonly rolls: boolean;
  private mode: PinchMode;
  private from = 0;
  private to: number;
  private tChange: number;
  private readonly t0: number;
  /** lateral offset of the cable from the pads' line when made, in pad coordinates (fades out) */
  private readonly off0: V3;
  /** +1: d3 points toward higher s, -1: the other way */
  private sigma: number;
  /** material angle of the cable in the pads (from d1 toward d2) when held */
  private phi0: number;
  // per substep
  private F: Frame = { p: [0, 0, 0], q: [0, 0, 0, 1] };
  private ax: V3 = [0, 0, 1];
  private e1: V3 = [1, 0, 0];
  private e2: V3 = [0, 1, 0];
  private off: V3 = [0, 0, 0];
  private lat = 0;
  private held = 0;
  private fmax = 0;
  private psi = 0;
  private lam = 0;
  private saturated = false;
  private js: number[] = [];
  private ws: number[] = [];

  /** @internal use rod.pinch(spec) */
  constructor(rod: Rod, spec: PinchSpec) {
    this.rod = rod;
    this.track = new FrameTrack(spec.frame);
    this.pad = spec.pad ?? 0.008;
    this.hand = spec.hand ?? -1;
    this.friction = spec.friction ?? 0.2;
    this.blend = spec.blend ?? 0.12;
    this.rolls = spec.rolls ?? true;
    const r = spec.roll ?? 0;
    this.rollFn = typeof r === 'function' ? r : () => r;
    this.t0 = this.tChange = rod.time;
    this.mode = spec.mode ?? 'held';
    this.to = LEVEL[this.mode];
    const F = this.track.at(rod.time);
    const near = spec.s === undefined ? rod.closestPoint(F.p) : null;
    this.s = spec.s ?? (near as { s: number }).s;
    const P = rod.pointAt(this.s), T = rod.tangentAt(this.s);
    this.gripDistance = Math.hypot(P[0] - F.p[0], P[1] - F.p[1], P[2] - F.p[2]);
    const a = col(F.q, 2), e1 = col(F.q, 0), e2 = col(F.q, 1);
    this.sigma = T[0] * a[0] + T[1] * a[1] + T[2] * a[2] >= 0 ? 1 : -1;
    const d: V3 = [P[0] - F.p[0], P[1] - F.p[1], P[2] - F.p[2]];
    // the offset across the pads' line, in pad coordinates
    this.off0 = [d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2], d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2], 0];
    this.phi0 = angleIn(segAxes(rod, rod.segmentAt(this.s))[0], e1, e2) - this.rollFn(rod.time);
  }

  /** current mode (the one it is heading for) */
  get state(): PinchMode {
    return this.mode;
  }

  /** 0 free … 0.5 loose … 1 held, as it is now (blending) */
  level(t = this.rod.time) {
    return this.from + (this.to - this.from) * smooth((t - this.tChange) / Math.max(this.blend, 1e-9));
  }

  /** Change the grip; it blends from where it is now over `blend` seconds. */
  set(mode: PinchMode, blend = this.blend) {
    if (mode === this.mode && blend === this.blend) return;
    this.from = this.level();
    this.to = LEVEL[mode];
    this.mode = mode;
    this.blend = blend;
    this.tChange = this.rod.time;
  }

  /** Open the pads (over `blend`); the rod drops the pinch once it is free. */
  release(blend = this.blend) {
    this.set('free', blend);
  }

  /** Roll of the cable relative to the pads [rad] about d3: a number now, or a function of time. */
  setRoll(roll: number | ((t: number) => number)) {
    this.rollFn = typeof roll === 'function' ? roll : () => roll;
  }

  /** The pads' frame from now on (a function of time or a fixed frame). */
  setFrame(src: FrameSource) {
    this.track.set(src);
  }

  /** Move the pads from where they are now to f over dt seconds (sim in the loop: once per frame). */
  moveTo(f: Frame, dt = this.rod.lastDt) {
    this.track.moveTo(f, this.rod.time, dt);
  }

  /** The pads' frame at time t. */
  frame(t = this.rod.time): Frame {
    return this.track.at(t);
  }

  prepare(t: number, h: number) {
    const rod = this.rod;
    const g = this.level(t);
    if (this.to === 0 && g <= 1e-6 && t >= this.tChange + this.blend) {
      this.done = true;
      this.js.length = 0;
      return;
    }
    const F = (this.F = this.track.at(t));
    this.ax = col(F.q, 2);
    this.e1 = col(F.q, 0);
    this.e2 = col(F.q, 1);
    // the cable left the pads at an end
    if (this.s < -this.pad || this.s > rod.totalLength + this.pad) {
      this.from = this.to = 0;
      this.done = true;
      this.js.length = 0;
      return;
    }
    this.lat = smooth(g / 0.5);
    this.held = smooth((g - 0.5) / 0.5);
    this.fmax = g <= 0.5 ? this.friction * this.lat : this.friction + (HOLD_FORCE * this.held) / Math.max(1e-9, 1 - this.held);
    this.psi = this.phi0 + this.rollFn(t);
    const fade = 1 - smooth((t - this.t0) / Math.max(this.blend, 1e-9));
    const o = this.off0;
    this.off = [(this.e1[0] * o[0] + this.e2[0] * o[1]) * fade, (this.e1[1] * o[0] + this.e2[1] * o[1]) * fade, (this.e1[2] * o[0] + this.e2[2] * o[1]) * fade];
    // the segments under the pads, weighted by how much of them the pads cover
    this.js.length = 0;
    this.ws.length = 0;
    const s0 = this.s - this.pad, s1 = this.s + this.pad;
    const lo = rod.segmentAt(s0), hi = rod.segmentAt(s1);
    for (let j = lo; j <= hi; j++) {
      const a = Math.max(s0, rod.sNode[j]), b = Math.min(s1, rod.sNode[j + 1]);
      if (b <= a) continue;
      const w = Math.min(1, (b - a) / Math.min(rod.L[j], 2 * this.pad));
      if (w < 1e-6) continue;
      this.js.push(j);
      this.ws.push(w);
    }
    for (let k = 0; k < this.js.length; k++) {
      const j = this.js[k], w = this.ws[k];
      const fl = this.lat * w, fa = this.held * w, fr = this.rolls ? this.held * w : 0;
      if (rod.wc[j] === 0) continue;
      rod.holdBody(j, 1 - fl, fl - fa, this.ax, 1, -fr, segAxes(rod, j)[1]);
    }
    if (this.hand >= 0) {
      const m = rod.segmentAt(s0 - 0.015), M = rod.segmentAt(s1 + 0.015);
      for (let j = m; j <= M; j++) rod.skipGroup[j] = this.hand;
    }
    this.lam = 0;
    this.saturated = false;
  }

  project(h: number) {
    const rod = this.rod, c = rod.c, { ax, js, ws } = this, p = this.F.p, off = this.off;
    if (!js.length || this.lat <= 0) return;
    let sw = 0, cax = 0, wt = 0;
    for (let k = 0; k < js.length; k++) {
      const j = js[k], j3 = 3 * j;
      if (rod.wc[j] === 0) continue;
      // across: onto the pads' line
      const dx = c[j3] - p[0] - off[0], dy = c[j3 + 1] - p[1] - off[1], dz = c[j3 + 2] - p[2] - off[2];
      const al = dx * ax[0] + dy * ax[1] + dz * ax[2];
      const f = this.lat * ws[k];
      c[j3] -= f * (dx - al * ax[0]); c[j3 + 1] -= f * (dy - al * ax[1]); c[j3 + 2] -= f * (dz - al * ax[2]);
      // along: how far the segment is from where its material coordinate puts it
      const sm = rod.sNode[j] + rod.L[j] / 2;
      cax += ws[k] * (al - this.sigma * (sm - this.s));
      sw += ws[k];
    }
    if (sw > 0 && this.fmax > 0) {
      cax /= sw;
      for (let k = 0; k < js.length; k++) {
        const j = js[k];
        if (rod.wc[j] === 0) continue;
        const u = ws[k] / sw;
        wt += u * u * rod.invMass(j);
      }
      if (wt > 0) {
        // friction: the accumulated axial correction is limited to fmax h² per substep
        const lim = this.fmax * h * h;
        const want = this.lam - cax / wt;
        const next = Math.max(-lim, Math.min(lim, want));
        this.saturated = next !== want;
        const dl = next - this.lam;
        this.lam = next;
        for (let k = 0; k < js.length; k++) {
          const j = js[k], j3 = 3 * j;
          if (rod.wc[j] === 0) continue;
          const d = rod.invMass(j) * (ws[k] / sw) * dl;
          c[j3] += d * ax[0]; c[j3 + 1] += d * ax[1]; c[j3 + 2] += d * ax[2];
        }
      }
    }
    // roll: the material frame under the pads turns with the hand
    if (this.rolls && this.held > 0) {
      const ct = Math.cos(this.psi), st = Math.sin(this.psi);
      const tx = ct * this.e1[0] + st * this.e2[0], ty = ct * this.e1[1] + st * this.e2[1], tz = ct * this.e1[2] + st * this.e2[2];
      for (let k = 0; k < js.length; k++) {
        const j = js[k];
        if (rod.wt[j] === 0) continue;
        const [d1, d3] = segAxes(rod, j);
        // target direction in the plane ⊥ d3, angle from d1 about d3
        const y = d3[0] * (d1[1] * tz - d1[2] * ty) + d3[1] * (d1[2] * tx - d1[0] * tz) + d3[2] * (d1[0] * ty - d1[1] * tx);
        const x = d1[0] * tx + d1[1] * ty + d1[2] * tz;
        const err = Math.atan2(y, x) * this.held * ws[k];
        rod.rotateBody(j, d3[0] * err, d3[1] * err, d3[2] * err);
      }
    }
  }

  finish(h: number) {
    const rod = this.rod, c = rod.c, { ax, js, ws } = this, p = this.F.p;
    if (!js.length) return;
    const sOld = this.s;
    this.force = h > 0 ? this.lam / (h * h) : 0;
    if (this.lat <= 1e-6) {
      // free: the pads are over whatever material point is nearest
      this.s = rod.closestPoint(p, this.s - 0.05, this.s + 0.05).s;
    } else if (this.saturated || this.fmax <= 0) {
      // sliding: the material now at the middle of the pads
      let sw = 0, cax = 0;
      for (let k = 0; k < js.length; k++) {
        const j = js[k], j3 = 3 * j;
        const sm = rod.sNode[j] + rod.L[j] / 2;
        const al = (c[j3] - p[0]) * ax[0] + (c[j3 + 1] - p[1]) * ax[1] + (c[j3 + 2] - p[2]) * ax[2];
        cax += ws[k] * (al - this.sigma * (sm - this.s));
        sw += ws[k];
      }
      if (sw > 0) this.s -= this.sigma * (cax / sw);
    }
    this.slip = h > 0 ? (this.s - sOld) / h : 0;
    // roll that is not held follows the cable
    if (this.held < 1) {
      const j = rod.segmentAt(this.s);
      const cur = angleIn(segAxes(rod, j)[0], this.e1, this.e2);
      this.phi0 += (1 - (this.rolls ? this.held : 0)) * wrap(cur - this.psi);
    }
  }

  kinematic() {}

  segments(out: number[]) {
    for (const j of this.js) out.push(j);
  }
}

// ------------------------------------------------------------------ bundle

export interface BundleSpec {
  /** the hand's frame (any frame fixed in the hand, e.g. the grip frame of the fist) */
  frame: FrameSource;
  /** seconds over which a strand joins (or leaves) the bundle (default 0.15) */
  blend?: number;
  /** the hand's capsule group: those capsules do not push the strands it holds */
  hand?: number;
}

interface Member {
  j: number;
  /** pose relative to the hand frame */
  lc: V3;
  lq: Quat;
  /** joining: 0 → 1, rigid, or leaving: 1 → 0 */
  state: 'join' | 'rigid' | 'leave';
  t0: number;
  blend: number;
  /** 0 … 1: how firmly it is held now; f the per-iteration fraction this substep */
  u: number;
  f: number;
}

/**
 * Strands held in a hand, keeping their shape relative to it: a coil in the left hand that grows
 * loop by loop. add(s0, s1) takes the segments where they are now (relative to the hand) and holds
 * them ever more firmly over `blend` seconds, then rigidly; release() lets them go the same way.
 */
export class Bundle implements Attachment {
  done = false;
  readonly hand: number;
  blend: number;
  private readonly rod: Rod;
  private readonly track: FrameTrack;
  private readonly members = new Map<number, Member>();
  private F: Frame = { p: [0, 0, 0], q: [0, 0, 0, 1] };

  /** @internal use rod.bundle(spec) */
  constructor(rod: Rod, spec: BundleSpec) {
    this.rod = rod;
    this.track = new FrameTrack(spec.frame);
    this.blend = spec.blend ?? 0.15;
    this.hand = spec.hand ?? -1;
  }

  /** The segments whose middle lies in [s0, s1] join the bundle where they are now. */
  add(s0: number, s1: number, blend = this.blend) {
    const rod = this.rod, t = rod.time;
    const F = this.track.at(t), qi = quatConj(F.q);
    for (let j = rod.segmentAt(s0); j <= rod.segmentAt(s1); j++) {
      const sm = rod.sNode[j] + rod.L[j] / 2;
      if (sm < s0 || sm > s1) continue;
      const old = this.members.get(j);
      if (old && old.state !== 'leave') continue;
      const j3 = 3 * j, j4 = 4 * j;
      const lc = quatRotate(qi, [rod.c[j3] - F.p[0], rod.c[j3 + 1] - F.p[1], rod.c[j3 + 2] - F.p[2]]);
      const lq = quatMul(qi, [rod.q[j4], rod.q[j4 + 1], rod.q[j4 + 2], rod.q[j4 + 3]]);
      this.members.set(j, { j, lc, lq, state: 'join', t0: t, blend, u: old ? old.u : 0, f: 0 });
    }
  }

  /** The segments whose middle lies in [s0, s1] (default all) let go over `blend` seconds. */
  release(s0 = -Infinity, s1 = Infinity, blend = this.blend) {
    const rod = this.rod;
    for (const m of this.members.values()) {
      const sm = rod.sNode[m.j] + rod.L[m.j] / 2;
      if (sm < s0 || sm > s1 || m.state === 'leave') continue;
      if (m.state === 'rigid') rod.markKinematic();
      m.state = 'leave';
      m.t0 = rod.time;
      m.blend = blend;
    }
  }

  /** Drop the bundle at once (what it holds keeps its velocity). */
  remove() {
    this.done = true;
    this.members.clear();
    this.rod.markKinematic();
  }

  /** whether material coordinate s is held */
  holds(s: number) {
    return this.members.has(this.rod.segmentAt(s));
  }

  /** the material ranges held (joining, rigid or leaving), sorted */
  ranges(): [number, number][] {
    const rod = this.rod, js = [...this.members.keys()].sort((a, b) => a - b), out: [number, number][] = [];
    for (const j of js) {
      const last = out[out.length - 1];
      if (last && Math.abs(last[1] - rod.sNode[j]) < 1e-9) last[1] = rod.sNode[j + 1];
      else out.push([rod.sNode[j], rod.sNode[j + 1]]);
    }
    return out;
  }

  setFrame(src: FrameSource) {
    this.track.set(src);
  }

  moveTo(f: Frame, dt = this.rod.lastDt) {
    this.track.moveTo(f, this.rod.time, dt);
  }

  frame(t = this.rod.time): Frame {
    return this.track.at(t);
  }

  prepare(t: number, h: number) {
    const rod = this.rod, F = (this.F = this.track.at(t));
    for (const m of this.members.values()) {
      const x = (t - m.t0) / Math.max(m.blend, 1e-9);
      if (m.state === 'join') {
        m.u = Math.max(m.u, smooth(x));
        if (x >= 1) {
          m.state = 'rigid';
          rod.markKinematic();
        }
      } else if (m.state === 'leave') {
        m.u = Math.min(m.u, 1 - smooth(x));
        if (x >= 1) {
          this.members.delete(m.j);
          continue;
        }
      }
      if (this.hand >= 0) for (let j = Math.max(0, m.j - 1); j <= Math.min(rod.ns - 1, m.j + 1); j++) rod.skipGroup[j] = this.hand;
      if (m.state === 'rigid') {
        this.place(m, F, 1);
        continue;
      }
      // stiffness of the hold: a time constant from ∞ (u = 0) to 0 (u = 1)
      const rate = (4 * m.u) / (m.blend * (1 - m.u) + 1e-9);
      m.f = h > 0 ? 1 - Math.exp(-h * rate) : 0;
      rod.holdBody(m.j, 1 - m.f, 0, null, 1 - m.f, 0, null);
    }
  }

  /** moves member m a fraction f of the way to its place in the hand */
  private place(m: Member, F: Frame, f: number) {
    const rod = this.rod, j3 = 3 * m.j, j4 = 4 * m.j;
    const r = quatRotate(F.q, m.lc), tq = quatMul(F.q, m.lq);
    const c = rod.c, q = rod.q;
    c[j3] += (F.p[0] + r[0] - c[j3]) * f;
    c[j3 + 1] += (F.p[1] + r[1] - c[j3 + 1]) * f;
    c[j3 + 2] += (F.p[2] + r[2] - c[j3 + 2]) * f;
    const nq = f >= 1 ? tq : quatSlerp([q[j4], q[j4 + 1], q[j4 + 2], q[j4 + 3]], tq, f);
    q[j4] = nq[0]; q[j4 + 1] = nq[1]; q[j4 + 2] = nq[2]; q[j4 + 3] = nq[3];
  }

  project() {
    for (const m of this.members.values()) if (m.state !== 'rigid' && m.f > 0) this.place(m, this.F, m.f);
  }

  finish() {}

  kinematic(wc: Float64Array, wt: Float64Array) {
    for (const m of this.members.values()) {
      if (m.state !== 'rigid') continue;
      wc[m.j] = 0;
      wt[m.j] = 0;
    }
  }

  segments(out: number[]) {
    for (const j of this.members.keys()) out.push(j);
  }
}
