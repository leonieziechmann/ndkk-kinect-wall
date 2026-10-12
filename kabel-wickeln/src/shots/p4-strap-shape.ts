// The velcro tie's band as a path (part p4-strap), pure geometry (no three.js): the part feeds the
// points and the band's width direction per point to three/strap.ts StrapMesh.update.
//
// The tie: a soft band (25 × 2 cm, 2 mm) with a plastic eyelet at its start. Put on a cable, its long
// end goes once round the cable and through its own eyelet and is pulled tight: a choke that stays
// on the cable. Closing a ring, the long end goes round the whole bundle of strands next to it and
// sticks onto itself (velcro). Every state of the band is a dense polyline from the eyelet along the
// band (arcs round the cable or the bundle, straight pieces to the hand that holds it), cut to the
// band's length; what is left beyond hangs from there and bends down under its weight (and lies on
// the floor where it reaches it). The width direction is carried along the band without twist
// (parallel transport), starting along the strands at the eyelet.

import type { V3 } from '../sim';

export const BAND = { length: 0.25, width: 0.02, thickness: 0.002 };

/** a cross-section: middle, axis (the strands' direction), outward direction (the eyelet's side), radius of what the band goes round */
export interface Section {
  c: V3;
  a: V3;
  u: V3;
  r: number;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
const perp = (v: V3, a: V3): V3 => norm(sub(v, mul(a, dot(v, a))));

/** a section with u made perpendicular to a, and v = a × u */
export function frameOf(s: Section) {
  const a = norm(s.a);
  const u = perp(s.u, a);
  return { c: s.c, a, u, v: cross(a, u), r: s.r };
}

export class BandPath {
  /** M points along the band (xyz), and the band's width direction at each */
  public readonly pts: Float32Array;
  public readonly sides: Float32Array;
  public readonly M: number;
  /** the eyelet: its middle and its frame (x along the band's width, y outward, z along the band) */
  public eye: { p: V3; x: V3; y: V3; z: V3 } = { p: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  private d: number[] = [];
  /** the floor the band cannot go below (its middle), and how strongly a free end bends down (1/m) */
  public floorY = 0;
  public droop = 28;

  public constructor(M = 200, public readonly L = BAND.length, public readonly T = BAND.thickness) {
    this.M = M;
    this.pts = new Float32Array(3 * M);
    this.sides = new Float32Array(3 * M);
  }

  /** starts a new path at p */
  public start(p: V3) {
    this.d.length = 0;
    this.d.push(p[0], p[1], p[2]);
    return this;
  }

  public last(): V3 {
    const n = this.d.length;
    return [this.d[n - 3], this.d[n - 2], this.d[n - 1]];
  }

  private push(p: V3) {
    this.d.push(p[0], p[1], p[2]);
  }

  /** a straight piece to q (1 mm steps) */
  public lineTo(q: V3) {
    const p = this.last();
    const l = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    const n = Math.max(1, Math.ceil(l / 0.001));
    for (let k = 1; k <= n; k++) this.push(add(p, mul(sub(q, p), k / n)));
    return this;
  }

  /**
   * An arc round the axis of section s (in its plane, turning from u towards v), from angle a0 to
   * a1 (rad), the radius going from r0 to r1; it first goes straight to the arc's start
   */
  public arc(s: Section, a0: number, a1: number, r0: number, r1: number) {
    const f = frameOf(s);
    const at = (ang: number, r: number): V3 => add(f.c, add(mul(f.u, r * Math.cos(ang)), mul(f.v, r * Math.sin(ang))));
    this.lineTo(at(a0, r0));
    const len = Math.abs(a1 - a0) * Math.max(r0, r1);
    const n = Math.max(2, Math.ceil(len / 0.001));
    for (let k = 1; k <= n; k++) {
      const u = k / n;
      this.push(at(a0 + (a1 - a0) * u, r0 + (r1 - r0) * u));
    }
    return this;
  }

  /** the length so far */
  public length() {
    let s = 0;
    const d = this.d;
    for (let i = 3; i < d.length; i += 3) s += Math.hypot(d[i] - d[i - 3], d[i + 1] - d[i - 2], d[i + 2] - d[i - 1]);
    return s;
  }

  /**
   * Cuts the path to the band's length (or lets the rest hang from its end, bending down, onto the
   * floor) and writes M points; the width direction starts as side0 and is carried along.
   */
  public finish(side0: V3) {
    const d = this.d;
    // the free rest: from the last point on, heading the way the path went, bending towards the floor
    let total = this.length();
    if (total < this.L) {
      const n = d.length / 3;
      let h: V3 = n >= 2 ? norm([d[d.length - 3] - d[d.length - 6], d[d.length - 2] - d[d.length - 5], d[d.length - 1] - d[d.length - 4]]) : [0, -1, 0];
      let p = this.last();
      const ds = 0.001;
      const ground = this.floorY + this.T / 2;
      while (total < this.L + ds) {
        // bend towards down, as much as the weight of what hangs beyond can (stronger for a horizontal band)
        const down: V3 = [0, -1, 0];
        const lat = sub(down, mul(h, dot(down, h)));
        h = norm(add(h, mul(lat, this.droop * ds)));
        let q = add(p, mul(h, ds));
        if (q[1] < ground) {
          q = [q[0], ground, q[2]];
          h = norm([h[0] || 1e-3, 0, h[2]]);
        }
        this.push(q);
        p = q;
        total += ds;
      }
    }
    // resample at equal arc length
    const M = this.M, step = this.L / (M - 1);
    let i = 0, acc = 0;
    const N = d.length / 3;
    for (let k = 0; k < M; k++) {
      const s = k * step;
      while (i < N - 2) {
        const l = Math.hypot(d[3 * i + 3] - d[3 * i], d[3 * i + 4] - d[3 * i + 1], d[3 * i + 5] - d[3 * i + 2]);
        if (acc + l >= s) break;
        acc += l;
        i++;
      }
      const l = Math.hypot(d[3 * i + 3] - d[3 * i], d[3 * i + 4] - d[3 * i + 1], d[3 * i + 5] - d[3 * i + 2]) || 1;
      const u = Math.max(0, Math.min(1, (s - acc) / l));
      for (let c = 0; c < 3; c++) this.pts[3 * k + c] = d[3 * i + c] + (d[3 * i + 3 + c] - d[3 * i + c]) * u;
    }
    // the width direction, carried along without twist
    let prevT: V3 = norm([this.pts[3] - this.pts[0], this.pts[4] - this.pts[1], this.pts[5] - this.pts[2]]);
    let side = perp(side0, prevT);
    for (let k = 0; k < M; k++) {
      const a = Math.max(0, k - 1), b = Math.min(M - 1, k + 1);
      const t = norm([this.pts[3 * b] - this.pts[3 * a], this.pts[3 * b + 1] - this.pts[3 * a + 1], this.pts[3 * b + 2] - this.pts[3 * a + 2]]);
      // rotate side by the turn from prevT to t (Rodrigues), then make it exactly perpendicular
      const ax = cross(prevT, t), sn = Math.hypot(ax[0], ax[1], ax[2]), cs = dot(prevT, t);
      if (sn > 1e-9) {
        const k3 = mul(ax, 1 / sn), ang = Math.atan2(sn, cs);
        side = add(add(mul(side, Math.cos(ang)), mul(cross(k3, side), Math.sin(ang))), mul(k3, dot(k3, side) * (1 - Math.cos(ang))));
      }
      side = perp(side, t);
      this.sides[3 * k] = side[0];
      this.sides[3 * k + 1] = side[1];
      this.sides[3 * k + 2] = side[2];
      prevT = t;
    }
    return this;
  }

  /** the eyelet at p: across the band (x), outward (y), along the band (z) */
  public setEye(p: V3, x: V3, y: V3) {
    const z = cross(x, y);
    this.eye = { p, x, y, z };
    return this;
  }

  /** a point of the finished band at arc length s (m) */
  public at(s: number): V3 {
    const k = Math.max(0, Math.min(this.M - 1, (s / this.L) * (this.M - 1)));
    const i = Math.min(this.M - 2, Math.floor(k)), u = k - i;
    const P = this.pts;
    return [P[3 * i] + (P[3 * i + 3] - P[3 * i]) * u, P[3 * i + 1] + (P[3 * i + 4] - P[3 * i + 1]) * u, P[3 * i + 2] + (P[3 * i + 5] - P[3 * i + 2]) * u];
  }
}

// ------------------------------------------------------------------------------------ states

/** the choke's radii round a cable of radius rc: snug, and loose (before it is pulled tight) */
export const chokeR = (rc: number, loose = 0) => rc + BAND.thickness / 2 + loose;

/**
 * The band held by its eyelet end in the hand (pads at p, the band hanging from there), or moved to
 * the cable (place 0 → 1: the eyelet goes to the cable's outer side, section s).
 */
export function held(b: BandPath, s: Section, hand: V3, place: number) {
  const f = frameOf(s);
  const onCable = add(f.c, mul(f.u, chokeR(f.r) + 0.8 * b.T));
  const e = add(mul(hand, 1 - place), mul(onCable, place));
  b.start(e).lineTo(add(e, mul(f.a, 0.004)));
  return b.setEye(sub(e, mul(f.a, 0.002)), f.a, f.u).finish(f.u);
}

/**
 * Round the cable and through its own eyelet: wrap (0 → 1, the long end goes once round, loose),
 * thread (0 → 1, through the slot), cinch (0 → 1, pulled tight); `hand`: where the pads hold the
 * band (null: let go, the end hangs).
 */
export function choke(b: BandPath, s: Section, wrap: number, thread: number, cinch: number, hand: V3 | null) {
  const f = frameOf(s);
  const T = b.T;
  const loose = 0.012 * (1 - cinch);
  const r1 = chokeR(f.r, loose), r2 = r1 + 1.6 * T;
  const eye = add(f.c, mul(f.u, chokeR(f.r) + 0.8 * T));
  b.start(add(f.c, mul(f.u, r1)));
  const w = Math.max(0, Math.min(1, wrap));
  if (w < 1 || thread <= 0) {
    // partly round: the band from the eyelet round the cable, then straight to the hand
    if (w > 0) b.arc(f, 0, 2 * Math.PI * w, r1, r1 + (r2 - r1) * Math.max(0, (w - 0.8) / 0.2));
    if (hand) b.lineTo(hand);
  } else {
    // full turn, rising over the band's start into the slot, out through it and on to the hand
    b.arc(f, 0, 1.6 * Math.PI, r1, r1).arc(f, 1.6 * Math.PI, 2 * Math.PI, r1, r2);
    const out = add(eye, mul(f.u, 1.6 * T));
    const through = add(add(out, mul(f.v, 0.004)), mul(f.u, 0.002));
    b.lineTo(through);
    if (hand) b.lineTo(add(through, mul(sub(hand, through), Math.max(0.05, thread))));
    else b.lineTo(add(through, mul(norm(add(f.u, mul(f.v, 0.6))), 0.006)));
  }
  return b.setEye(eye, f.a, f.u).finish(f.a);
}

/**
 * The tie on the start strand (section `strand`, u pointing away from the bundle), its long end round
 * the whole bundle (section `bundle`, the same axis): k 0 → 1 how far round (the rest goes to the
 * hand), then closed (k = 1: all of it on the bundle, overlapping itself). `open` 0 → 1 peels it back
 * from its end towards the hand. `choked` false: a band only wrapped round the ring (its start lies
 * on the bundle where the eyelet would be).
 */
export function round(b: BandPath, strand: Section, bundle: Section, k: number, hand: V3 | null, o: { open?: number; choked?: boolean; squeeze?: number } = {}) {
  const fs = frameOf(strand);
  const fb = frameOf({ ...bundle, u: fs.u, a: fs.a });
  const T = b.T;
  const choked = o.choked ?? true;
  const Rw = fb.r * (1 - (o.squeeze ?? 0)) + 1.6 * T;
  const eye = add(fs.c, mul(fs.u, chokeR(fs.r) + 0.8 * T));
  let used = 0;
  if (choked) {
    const r1 = chokeR(fs.r), r2 = r1 + 1.6 * T;
    b.start(add(fs.c, mul(fs.u, r1))).arc(fs, 0, 1.6 * Math.PI, r1, r1).arc(fs, 1.6 * Math.PI, 2 * Math.PI, r1, r2);
    used = b.length();
  } else {
    b.start(add(fb.c, mul(fb.u, Rw)));
  }
  // round the bundle: a slow spiral (one band thickness per turn) from the eyelet's side on
  const start = Math.atan2(dot(sub(b.last(), fb.c), fb.v), dot(sub(b.last(), fb.c), fb.u));
  const avail = Math.max(0.01, b.L - used - 0.004);
  const full = avail / (Rw + T);
  const openAng = Math.max(0, Math.min(1, o.open ?? 0)) * full * 0.86;
  const ang = Math.max(0.05, full * Math.max(0, Math.min(1, k)) - openAng);
  const turns = ang / (2 * Math.PI);
  b.arc(fb, start, start + ang, Rw, Rw + T * turns);
  if (hand) b.lineTo(hand);
  return b.setEye(choked ? eye : add(fb.c, mul(fb.u, Rw)), fs.a, fs.u).finish(fs.a);
}

/** a plastic cable tie round a bundle: the strap round (squeezed), the head, the tail straight out of it */
export function zipTie(b: BandPath, bundle: Section, squeeze: number) {
  const f = frameOf(bundle);
  const R = f.r * (1 - squeeze) + b.T / 2;
  b.start(add(f.c, mul(f.u, R))).arc(f, 0, 2 * Math.PI + 0.25, R, R + 1.5 * b.T);
  const head = add(f.c, mul(f.u, R + 0.004));
  b.lineTo(add(head, mul(f.v, 0.004)));
  b.lineTo(add(add(head, mul(f.v, 0.012)), mul(f.u, 0.02)));
  b.droop = 0;
  b.setEye(head, f.a, f.u).finish(f.a);
  b.droop = 28;
  return b;
}

/**
 * A band falling from where it was let go (its points `p0`), dt seconds later: it drops, turns a
 * little and, on the floor, lies flat (each point settles to the floor in its own time).
 */
export function falling(b: BandPath, p0: Float32Array, side0: V3, dt: number, floorY: number, spin: V3 = [0.4, 0, 0.9]) {
  const M = b.M, g = 9.81;
  let cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < M; k++) {
    cx += p0[3 * k] / M;
    cy += p0[3 * k + 1] / M;
    cz += p0[3 * k + 2] / M;
  }
  const c: V3 = [cx, cy, cz];
  const drop = 0.5 * g * dt * dt;
  const ang = 2.2 * dt;
  const ax = norm(spin);
  const ground = floorY + b.T / 2;
  const tLand = Math.sqrt((2 * Math.max(0.01, cy - ground)) / g);
  const flat = Math.max(0, Math.min(1, (dt - tLand) / 0.25));
  for (let k = 0; k < M; k++) {
    let p: V3 = sub([p0[3 * k], p0[3 * k + 1], p0[3 * k + 2]], c);
    p = add(add(mul(p, Math.cos(ang)), mul(cross(ax, p), Math.sin(ang))), mul(ax, dot(ax, p) * (1 - Math.cos(ang))));
    p = add(p, [c[0] + 0.12 * dt, c[1] - drop, c[2] + 0.05 * dt]);
    if (p[1] < ground || flat > 0) {
      // on the floor: lie down (spread a little where it lands)
      const y = Math.max(p[1], ground);
      p = [p[0], y + (ground - y) * flat, p[2]];
      if (p[1] < ground) p[1] = ground;
    }
    b.pts[3 * k] = p[0];
    b.pts[3 * k + 1] = p[1];
    b.pts[3 * k + 2] = p[2];
  }
  // (the width keeps its direction relative to the band, carried along)
  for (let k = 0; k < M; k++) {
    const a = Math.max(0, k - 1), bb = Math.min(M - 1, k + 1);
    const t = norm([b.pts[3 * bb] - b.pts[3 * a], b.pts[3 * bb + 1] - b.pts[3 * a + 1], b.pts[3 * bb + 2] - b.pts[3 * a + 2]]);
    const s = perp(flat > 0.5 ? [0, 1, 0] : side0, t);
    const side = flat > 0.5 ? cross(t, s) : s;
    b.sides[3 * k] = side[0];
    b.sides[3 * k + 1] = side[1];
    b.sides[3 * k + 2] = side[2];
  }
  return b;
}
