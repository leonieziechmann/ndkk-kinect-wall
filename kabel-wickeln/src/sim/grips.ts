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
// Bundles prepare first: a pinch on a strand that a bundle is taking over gives way as the bundle
// closes (the hand-over from the right hand's pads into the left hand's coil). Pieces held by any
// hand do not collide with each other (rod.heldMark). A pinch stays attached until remove():
// release() opens it, set('held' | 'loose') closes it again on what is between the pads.
//
// Typical controller (sim in the loop, once per frame in ShotBuild.script):
//   const pin = rod.pinch({ frame: (t) => rightPads(t), mode: 'loose', hand: 1 });  // hand already at the cable
//   ...  pin.set('held', 0.15); pin.setRoll((t) => roll(t)); coil.add(pin.s - 0.03, pin.s + 0.025, 0.2);
//   ...  pin.release(0.15);  ...  pin.set('loose', 0.1)   // next loop: closes where the pads are now
//   check pin.lost, pin.gripDistance, rod.warnings, rod.stats (speedCapped, heldSlip)
//
// Conventions: frames are grip frames (vec.ts): p on the cable axis between the pads, d3 the
// direction the cable runs through them (increasing material coordinate s), d1 toward the palm,
// d2 = d3 × d1. Material coordinates s are rest arc lengths from node 0 [m]. Time is shot time.

import type { Rod } from './rod';
import { Frame, Quat, V3, quatConj, quatMul, quatRotate, quatSlerp, smooth } from './vec';

/** A hand frame: a function of shot time, or a fixed frame (move it with moveTo / set it with setFrame). */
export type FrameSource = Frame | ((t: number) => Frame);

/** How a hand moved during the last substep (RodOptions.holdDamping): position, velocity, angular velocity, 0..1 how firmly it holds. */
export interface HoldMotion {
  p: V3;
  v: V3;
  w: V3;
  strength: number;
}

/** velocity and angular velocity of a frame from a to b over h */
function frameMotion(a: Frame, b: Frame, h: number, strength: number): HoldMotion {
  const ih = h > 0 ? 1 / h : 0;
  const r = quatMul(b.q, quatConj(a.q)), sg = r[3] < 0 ? -2 * ih : 2 * ih;
  return { p: b.p, v: [(b.p[0] - a.p[0]) * ih, (b.p[1] - a.p[1]) * ih, (b.p[2] - a.p[2]) * ih], w: [r[0] * sg, r[1] * sg, r[2] * sg], strength };
}

/** What the rod calls on its attachments every substep. @internal */
export interface Attachment {
  /** true once the attachment let go completely (the rod then drops it) */
  readonly done: boolean;
  prepare(t: number, h: number): void;
  project(h: number, iteration: number): void;
  finish(h: number): void;
  /** marks the segments it holds rigidly (inverse mass and inertia 0) */
  kinematic(wc: Float64Array, wt: Float64Array): void;
  /** the segments it holds (debug pictures, holdDamping) */
  segments(out: number[]): void;
  /** the hand's motion during the last substep, null while it holds nothing */
  motion(): HoldMotion | null;
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
 * cable); free: the pads are open (the pinch stays attached and closes again with set()).
 */
export type PinchMode = 'held' | 'loose' | 'free';

const LEVEL: Record<PinchMode, number> = { free: 0, loose: 0.5, held: 1 };
/** axial force [N] a pinch halfway between loose and held resists before it slips */
const HOLD_FORCE = 5;
/**
 * Most a held pinch resists before the cable slips through it [N] (a firm thumb-index pinch
 * holds about this much). Finite, so two hands pulling a cable taut make it slip, not explode
 * (rod.stats.heldSlip counts the substeps in which that happens).
 */
const MAX_HOLD = 20;
/** a held pinch keeps this much of the axial inverse mass in the direct solve (room to slip) */
const AXIAL_GIVE = 0.1;
/**
 * A sliding pinch has lost the cable when the material nearest the pads' middle is farther than
 * this [m] or crosses the pads at more than 60°: it opens (state 'free', lost = true) instead of
 * dragging some other piece of cable along.
 */
const LOST_DIST = 0.012;
const LOST_COS = 0.5;
/** a sliding pinch slides at most this much faster than the pads move along the cable [m/s] */
const SLIP_MARGIN = 0.3;
/** relative speed of pads and cable across it [m/s] above which closing on it warns */
const CLOSE_SPEED = 0.5;

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
  /**
   * axial friction force of a loose pinch [N] (default 0.6). The user's videos: while the right
   * hand slides out, the cable between the hands hangs only 3-5 cm over 70-80 cm, so the loose
   * pinch pulls it with about 0.6-1 N.
   */
  friction?: number;
  /** roll of the cable relative to the pads [rad] about d3 (thumb against index); default 0 */
  roll?: number | ((t: number) => number);
  /** false: the pads never turn the cable about its axis (a swivel) */
  rolls?: boolean;
  /** the hand's capsule group (Capsule.group): those capsules do not push the cable inside the pads */
  hand?: number;
  /**
   * Closing on the cable farther than this from it [m] (default 0.015) is reported in
   * rod.warnings (or throws with strict): the hand must go to the cable, not pull it in.
   */
  maxGripDistance?: number;
  /** throw instead of warning (gripDistance, closing while moving, lost cable) */
  strict?: boolean;
}

/**
 * The cable between thumb and index pads. Create with rod.pinch(spec); change it any time from a
 * shot script (sim in the loop): set(mode), setRoll(angle), moveTo(frame, dt), release(), remove().
 *
 * A pinch stays attached to the rod until remove(): release() only opens the pads, and a later
 * set('held') or set('loose') closes them again on the material point that is between them at
 * that moment (closest point; gripDistance tells how far the pads were from it).
 */
export class Pinch implements Attachment {
  /** material coordinate at the middle of the pads [m]; changes while the cable slides */
  s = 0;
  /** distance from p to the cable when the pads last closed on it [m] (how far the hand was off it) */
  gripDistance = 0;
  /** speed of the pads relative to the cable, across it, when they last closed [m/s] (stop the hand first) */
  gripSpeed = 0;
  /** speed the cable slid through the pads in the last substep [m/s]: + when the pads moved toward higher s */
  slip = 0;
  /** axial force of the pads on the cable in the last substep [N] */
  force = 0;
  /** the cable got away from the pads while sliding (or left at an end): the pinch opened by itself */
  lost = false;
  /** removed (remove()): the rod has dropped it */
  done = false;
  readonly pad: number;
  readonly hand: number;
  friction: number;
  blend: number;
  maxGripDistance: number;
  strict: boolean;
  private readonly rod: Rod;
  private readonly track: FrameTrack;
  private rollFn: (t: number) => number;
  private readonly rolls: boolean;
  private mode: PinchMode;
  private from = 0;
  private to: number;
  private tChange: number;
  private t0: number;
  /** lateral offset of the cable from the pads' line when made, in pad coordinates (fades out) */
  private off0: V3 = [0, 0, 0];
  /** +1: d3 points toward higher s, -1: the other way */
  private sigma = 1;
  /** material angle of the cable in the pads (from d1 toward d2) when held */
  private phi0 = 0;
  // per substep
  private F: Frame = { p: [0, 0, 0], q: [0, 0, 0, 1] };
  private Fprev: Frame | null = null;
  private h = 0;
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
    this.friction = spec.friction ?? 0.6;
    this.blend = spec.blend ?? 0.12;
    this.rolls = spec.rolls ?? true;
    this.maxGripDistance = spec.maxGripDistance ?? 0.015;
    this.strict = !!spec.strict;
    const r = spec.roll ?? 0;
    this.rollFn = typeof r === 'function' ? r : () => r;
    this.t0 = this.tChange = rod.time;
    this.mode = spec.mode ?? 'held';
    this.to = LEVEL[this.mode];
    this.take(spec.s);
  }

  /** current mode (the one it is heading for) */
  get state(): PinchMode {
    return this.done ? 'free' : this.mode;
  }

  /** 0 free … 0.5 loose … 1 held, as it is now (blending) */
  level(t = this.rod.time) {
    if (this.done) return 0;
    return this.from + (this.to - this.from) * smooth((t - this.tChange) / Math.max(this.blend, 1e-9));
  }

  /**
   * Change the grip; it blends from where it is now over `blend` seconds. From fully open, the pads
   * close on the material point between them now (not the one they held before).
   */
  set(mode: PinchMode, blend = this.blend) {
    if (this.done) throw new Error('Pinch.set: the pinch was removed (make a new one with rod.pinch)');
    if (mode === this.mode && blend === this.blend) return;
    const g = this.level();
    this.from = g;
    this.to = LEVEL[mode];
    this.mode = mode;
    this.blend = blend;
    this.tChange = this.rod.time;
    if (g <= 1e-6 && this.to > 0) this.take();
  }

  /** Open the pads (over `blend`). The pinch stays attached: set() closes it again. */
  release(blend = this.blend) {
    this.set('free', blend);
  }

  /** Drop the pinch at once (what it held keeps its velocity); it cannot be used again. */
  remove() {
    this.done = true;
    this.js.length = 0;
    this.lat = 0;
  }

  /** Roll of the cable relative to the pads [rad] about d3: a number now, or a function of time. */
  setRoll(roll: number | ((t: number) => number)) {
    this.rollFn = typeof roll === 'function' ? roll : () => roll;
  }

  /** The roll now [rad]. */
  roll(t = this.rod.time) {
    return this.rollFn(t);
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

  /**
   * The roll (for setRoll) that turns the cable in the pads so that its memorised bend (the strand
   * friction memory, opts.plastic, or the natural rest) curls toward the world direction `dir`
   * (projected across the cable), e.g. down into the loop that is forming. null without memory.
   */
  rollToCurl(dir: V3, which?: 'friction' | 'natural', t = this.rod.time): number | null {
    const rod = this.rod, j = rod.segmentAt(this.s), F = this.track.at(t);
    const curl = rod.memoryCurl(this.s, which);
    if (!curl) return null;
    const [d1, d3] = segAxes(rod, j);
    const d2: V3 = [d3[1] * d1[2] - d3[2] * d1[1], d3[2] * d1[0] - d3[0] * d1[2], d3[0] * d1[1] - d3[1] * d1[0]];
    // the curl now in world, and the wanted one: turn the cable about d3 by their angle
    const now: V3 = [curl.n1 * d1[0] + curl.n2 * d2[0], curl.n1 * d1[1] + curl.n2 * d2[1], curl.n1 * d1[2] + curl.n2 * d2[2]];
    const a = angleIn(dir, d1, d2) - angleIn(now, d1, d2);
    // a positive pad roll turns the material about the pads' d3 (sigma: the cable's own d3)
    void F;
    return this.rollFn(t) + this.sigma * wrap(a);
  }

  /** the pads close on the cable: the material point between them now (or s) */
  private take(s?: number) {
    const rod = this.rod, t = rod.time, F = this.track.at(t);
    this.s = s ?? rod.closestPoint(F.p).s;
    const P = rod.pointAt(this.s), T = rod.tangentAt(this.s);
    this.gripDistance = Math.hypot(P[0] - F.p[0], P[1] - F.p[1], P[2] - F.p[2]);
    // how fast the pads move across the cable as they close
    const F0 = this.track.at(t - 0.01), vc = rod.velocityAt(this.s);
    const rel: V3 = [(F.p[0] - F0.p[0]) / 0.01 - vc[0], (F.p[1] - F0.p[1]) / 0.01 - vc[1], (F.p[2] - F0.p[2]) / 0.01 - vc[2]];
    const ra = rel[0] * T[0] + rel[1] * T[1] + rel[2] * T[2];
    this.gripSpeed = Math.hypot(rel[0] - ra * T[0], rel[1] - ra * T[1], rel[2] - ra * T[2]);
    const a = col(F.q, 2), e1 = col(F.q, 0), e2 = col(F.q, 1);
    this.sigma = T[0] * a[0] + T[1] * a[1] + T[2] * a[2] >= 0 ? 1 : -1;
    const d: V3 = [P[0] - F.p[0], P[1] - F.p[1], P[2] - F.p[2]];
    // the offset across the pads' line, in pad coordinates
    this.off0 = [d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2], d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2], 0];
    this.phi0 = angleIn(segAxes(rod, rod.segmentAt(this.s))[0], e1, e2) - this.rollFn(t);
    this.t0 = t;
    this.lost = false;
    if (this.to > 0) {
      const ca = Math.abs(T[0] * a[0] + T[1] * a[1] + T[2] * a[2]);
      if (ca < LOST_COS) this.problem(`pinch closed across the cable (${((Math.acos(ca) * 180) / Math.PI).toFixed(0)}° between pads and cable, s ${this.s.toFixed(3)} m, t ${t.toFixed(3)} s): the pads' d3 runs along the cable`);
      if (this.gripDistance > this.maxGripDistance) this.problem(`pinch closed ${(this.gripDistance * 1000).toFixed(1)} mm off the cable (s ${this.s.toFixed(3)} m, t ${t.toFixed(3)} s): move the pads to the cable first`);
      if (this.gripSpeed > CLOSE_SPEED) this.problem(`pinch closed while the pads moved ${this.gripSpeed.toFixed(2)} m/s across the cable (s ${this.s.toFixed(3)} m, t ${t.toFixed(3)} s): stop the hand first`);
    }
  }

  private problem(msg: string) {
    if (this.strict) throw new Error(msg);
    this.rod.warn(msg);
  }

  /** the cable got away: open at once */
  private lose(msg: string) {
    this.lost = true;
    this.from = this.to = 0;
    this.mode = 'free';
    this.tChange = this.rod.time;
    this.js.length = 0;
    this.lat = 0;
    this.problem(msg);
  }

  prepare(t: number, h: number) {
    const rod = this.rod;
    const F = this.track.at(t);
    this.Fprev = this.Fprev ? this.F : F;
    this.F = F;
    this.h = h;
    this.ax = col(F.q, 2);
    this.e1 = col(F.q, 0);
    this.e2 = col(F.q, 1);
    this.js.length = 0;
    this.ws.length = 0;
    const g = this.level(t);
    this.lat = 0;
    this.held = 0;
    if (g <= 1e-6) return; // open: holds nothing (finish() keeps s over the nearest material)
    // the cable left the pads at an end
    if (this.s < -this.pad || this.s > rod.totalLength + this.pad) {
      this.lose(`the cable left the pinch at its end (t ${t.toFixed(3)} s)`);
      return;
    }
    // which way the cable runs through the pads (the hand may turn round while it slides)
    const T = rod.tangentAt(this.s), dt = T[0] * this.ax[0] + T[1] * this.ax[1] + T[2] * this.ax[2];
    if (dt * this.sigma < -0.3) this.sigma = -this.sigma;
    this.lat = smooth(g / 0.5);
    // closing from free straight to held: the pads press from the first moment (no slipping while
    // they close); between loose and held the press follows the level
    this.held = this.to === 1 && this.from < 0.5 ? smooth(g) : smooth((g - 0.5) / 0.5);
    this.fmax = Math.min(MAX_HOLD, this.friction * this.lat + (HOLD_FORCE * this.held) / Math.max(1e-9, 1 - this.held));
    this.psi = this.phi0 + this.rollFn(t);
    const fade = 1 - smooth((t - this.t0) / Math.max(this.blend, 1e-9));
    const o = this.off0;
    this.off = [(this.e1[0] * o[0] + this.e2[0] * o[1]) * fade, (this.e1[1] * o[0] + this.e2[1] * o[1]) * fade, (this.e1[2] * o[0] + this.e2[2] * o[1]) * fade];
    // the segments under the pads, weighted by how much of them the pads cover
    const s0 = this.s - this.pad, s1 = this.s + this.pad;
    const lo = rod.segmentAt(s0), hi = rod.segmentAt(s1);
    for (let j = lo; j <= hi; j++) {
      const a = Math.max(s0, rod.sNode[j]), b = Math.min(s1, rod.sNode[j + 1]);
      if (b <= a) continue;
      // (a strand the other hand's bundle is taking over: the pads give way as it closes)
      const w = Math.min(1, (b - a) / Math.min(rod.L[j], 2 * this.pad)) * (1 - rod.bundleHold[j]);
      if (w < 1e-6) continue;
      this.js.push(j);
      this.ws.push(w);
    }
    for (let k = 0; k < this.js.length; k++) {
      const j = this.js[k], w = this.ws[k];
      const fl = this.lat * w, fa = (1 - AXIAL_GIVE) * this.held * w, fr = this.rolls ? this.held * w : 0;
      if (rod.wc[j] === 0) continue;
      rod.holdBody(j, 1 - fl, fl - fa, this.ax, 1, -fr, segAxes(rod, j)[1]);
    }
    // the hand's own capsules leave the cable in and next to the pads alone; the pieces in the pads
    // do not collide with other held pieces (the other hand's bundle at the hand-over)
    if (this.hand >= 0) {
      const m = rod.segmentAt(s0 - 0.015), M = rod.segmentAt(s1 + 0.015);
      for (let j = m; j <= M; j++) rod.skipGroup[j] = this.hand;
    }
    for (const j of this.js) rod.heldMark[j] = 1;
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
    const rod = this.rod, { ax, js } = this, p = this.F.p;
    if (this.done) return;
    if (!js.length) {
      // open: the pads are over whatever material point is nearest
      this.s = rod.closestPoint(p, this.s - 0.05, this.s + 0.05).s;
      this.slip = 0;
      this.force = 0;
      return;
    }
    const sOld = this.s;
    this.force = h > 0 ? this.lam / (h * h) : 0;
    if (this.saturated || this.fmax <= 0) {
      // sliding: the material now between the pads (searched near the old one), unless the cable
      // has got away from them
      const o = this.off, pc: V3 = [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
      const cp = rod.closestPoint(pc, this.s - 2 * this.pad, this.s + 2 * this.pad);
      const cosA = Math.abs(cp.tangent[0] * ax[0] + cp.tangent[1] * ax[1] + cp.tangent[2] * ax[2]);
      // (only once the pads have closed: while they close they still turn the cable into line)
      const closed = this.lat > 0.9 && rod.time - this.t0 > this.blend;
      if (closed && (cp.dist > LOST_DIST || cosA < LOST_COS)) {
        this.lose(`the cable got away from a sliding pinch (${(cp.dist * 1000).toFixed(1)} mm, ${((Math.acos(Math.min(1, cosA)) * 180) / Math.PI).toFixed(0)}° off the pads, t ${rod.time.toFixed(3)} s): the hand moved too fast or across the cable`);
        this.slip = 0;
        return;
      }
      // the pads slide along the cable no faster than they move along it relative to the material
      // (plus a margin), at most half the pads per substep, and never into what another hand holds
      // rigidly: a cable folding back at the pads cannot make the material under them run away
      const j = rod.segmentAt(this.s), j3 = 3 * j, T = cp.tangent, Fp = this.Fprev ?? this.F;
      const rel = (p[0] - Fp.p[0] - (rod.c[j3] - rod.cp[j3])) * T[0] + (p[1] - Fp.p[1] - (rod.c[j3 + 1] - rod.cp[j3 + 1])) * T[1] + (p[2] - Fp.p[2] - (rod.c[j3 + 2] - rod.cp[j3 + 2])) * T[2];
      const lim = Math.min(this.pad / 2, Math.abs(rel) + SLIP_MARGIN * h);
      const ds = Math.max(-lim, Math.min(lim, cp.s - this.s));
      const next = this.s + ds;
      if (rod.wc[rod.segmentAt(next)] !== 0) this.s = next;
      if (this.held > 0.5) rod.stats.heldSlip++;
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

  motion(): HoldMotion | null {
    if (!this.js.length || this.lat <= 0 || !this.Fprev) return null;
    return frameMotion(this.Fprev, this.F, this.h, this.lat);
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
  /** pose relative to the hand frame (rigid members) */
  lc: V3;
  lq: Quat;
  /** joining: 0 → 1, rigid, or leaving: 1 → 0 */
  state: 'join' | 'rigid' | 'leave';
  t0: number;
  blend: number;
  /** 0 … 1: how firmly it is held now; f the per-iteration fraction this substep */
  u: number;
  f: number;
  /** where it would be this substep had it moved with the hand since the last one */
  tc: V3;
  tq: Quat;
}

/**
 * Strands held in a hand, keeping their shape relative to it: a coil in the left hand that grows
 * loop by loop. add(s0, s1) takes the segments where they are: over `blend` seconds their motion
 * relative to the hand is damped ever more strongly (they come to rest in the hand wherever they
 * lie, pushed by the other strands and fingers as they settle), then they are held rigidly in the
 * pose they have. release() lets them go the same way. Joining strands and strands held by any
 * hand do not collide with each other (that would only fight the holds).
 */
export class Bundle implements Attachment {
  done = false;
  readonly hand: number;
  blend: number;
  private readonly rod: Rod;
  private readonly track: FrameTrack;
  private readonly members = new Map<number, Member>();
  private F: Frame = { p: [0, 0, 0], q: [0, 0, 0, 1] };
  private Fprev: Frame | null = null;
  private h = 0;

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
      this.members.set(j, { j, lc, lq, state: 'join', t0: t, blend, u: old ? old.u : 0, f: 0, tc: [0, 0, 0], tq: [0, 0, 0, 1] });
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
    const rod = this.rod, F = this.track.at(t);
    const Fp = (this.Fprev = this.Fprev ? this.F : F);
    this.F = F;
    this.h = h;
    const qpi = quatConj(Fp.q);
    const fresh: Member[] = [];
    for (const m of this.members.values()) {
      const x = (t - m.t0) / Math.max(m.blend, 1e-9);
      if (m.state === 'join') m.u = Math.max(m.u, smooth(x));
      else if (m.state === 'leave') {
        m.u = Math.min(m.u, 1 - smooth(x));
        if (x >= 1) {
          this.members.delete(m.j);
          continue;
        }
      }
      if (this.hand >= 0) for (let j = Math.max(0, m.j - 1); j <= Math.min(rod.ns - 1, m.j + 1); j++) rod.skipGroup[j] = this.hand;
      rod.heldMark[m.j] = 1;
      if (m.state !== 'rigid') {
        // its pose at the start of the substep relative to the hand then
        const j3 = 3 * m.j, j4 = 4 * m.j;
        m.lc = quatRotate(qpi, [rod.cp[j3] - Fp.p[0], rod.cp[j3 + 1] - Fp.p[1], rod.cp[j3 + 2] - Fp.p[2]]);
        m.lq = quatMul(qpi, [rod.qp[j4], rod.qp[j4 + 1], rod.qp[j4 + 2], rod.qp[j4 + 3]]);
        if (m.state === 'join' && x >= 1) {
          // fully joined: from now on rigid in this pose
          m.state = 'rigid';
          rod.markKinematic();
          fresh.push(m);
          continue;
        }
      }
      if (m.state === 'rigid') {
        this.place(m, F, 1);
        continue;
      }
      rod.bundleHold[m.j] = Math.max(rod.bundleHold[m.j], m.u);
      // joining or leaving: the motion relative to the hand is damped, with a time constant from
      // ∞ (u = 0) to 0 (u = 1): the target is where it would be had it moved with the hand
      const r = quatRotate(F.q, m.lc);
      m.tc = [F.p[0] + r[0], F.p[1] + r[1], F.p[2] + r[2]];
      m.tq = quatMul(F.q, m.lq);
      const rate = (4 * m.u) / (m.blend * (1 - m.u) + 1e-9);
      m.f = h > 0 ? 1 - Math.exp(-h * rate) : 0;
      rod.holdBody(m.j, 1 - m.f, 0, null, 1 - m.f, 0, null);
    }
    if (fresh.length) this.freeze(fresh, F);
  }

  /**
   * Members that just turned rigid: their joints with rigid neighbours are closed exactly (a gap
   * the other hand's pull left open would otherwise be frozen into the coil), then placed.
   */
  private freeze(fresh: Member[], F: Frame) {
    const rod = this.rod, L = rod.L;
    const ez: V3 = [0, 0, 1];
    const shift = (m: Member, n: Member, below: boolean) => {
      // end of the lower one meets the start of the upper one (hand coordinates)
      const lo = below ? n : m, hi = below ? m : n;
      const al = quatRotate(lo.lq, ez), ah = quatRotate(hi.lq, ez);
      const e: V3 = [lo.lc[0] + (al[0] * L[lo.j]) / 2, lo.lc[1] + (al[1] * L[lo.j]) / 2, lo.lc[2] + (al[2] * L[lo.j]) / 2];
      const st: V3 = [hi.lc[0] - (ah[0] * L[hi.j]) / 2, hi.lc[1] - (ah[1] * L[hi.j]) / 2, hi.lc[2] - (ah[2] * L[hi.j]) / 2];
      const d: V3 = below ? [e[0] - st[0], e[1] - st[1], e[2] - st[2]] : [st[0] - e[0], st[1] - e[1], st[2] - e[2]];
      m.lc = [m.lc[0] + d[0], m.lc[1] + d[1], m.lc[2] + d[2]];
    };
    fresh.sort((a, b) => a.j - b.j);
    const done = new Set<number>();
    for (const m of fresh) {
      const n = this.members.get(m.j - 1);
      if (n && n.state === 'rigid' && (!fresh.includes(n) || done.has(n.j))) {
        shift(m, n, true);
        done.add(m.j);
      }
    }
    for (let i = fresh.length - 1; i >= 0; i--) {
      const m = fresh[i];
      if (done.has(m.j)) continue;
      const n = this.members.get(m.j + 1);
      if (n && n.state === 'rigid' && (!fresh.includes(n) || done.has(n.j))) shift(m, n, false);
      done.add(m.j);
    }
    for (const m of fresh) this.place(m, F, 1);
  }

  /** moves member m a fraction f of the way to its place in the hand (rigid: F ⊗ its pose) */
  private place(m: Member, F: Frame, f: number) {
    const rod = this.rod, j3 = 3 * m.j, j4 = 4 * m.j;
    let tc = m.tc, tq = m.tq;
    if (m.state === 'rigid') {
      const r = quatRotate(F.q, m.lc);
      tc = [F.p[0] + r[0], F.p[1] + r[1], F.p[2] + r[2]];
      tq = quatMul(F.q, m.lq);
    }
    const c = rod.c, q = rod.q;
    c[j3] += (tc[0] - c[j3]) * f;
    c[j3 + 1] += (tc[1] - c[j3 + 1]) * f;
    c[j3 + 2] += (tc[2] - c[j3 + 2]) * f;
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

  motion(): HoldMotion | null {
    if (!this.members.size || !this.Fprev) return null;
    return frameMotion(this.Fprev, this.F, this.h, 1);
  }
}
