// Cable shapes: polylines in 3D (x right, y down, z toward the viewer, all in px of the 1920 × 1080
// picture) built from lines, arcs and Bézier curves, then resampled to equal steps so that the twist
// of the cable can be given per arc length. z only decides what lies on top where strands cross.

import { TAU, clamp, lerp } from './math';

export type P3 = [number, number, number];

/** what the Cable node draws */
export interface CableGeom {
  pts: P3[];
  /** angle of the printed stripe around the cable per point (rad, 0 = facing the viewer) */
  phi?: number[];
  /** colour of the jacket per point (null: the cable's own colour) */
  tint?: (string | null)[];
  /** a plug on the first / last point */
  plugStart?: boolean;
  plugEnd?: boolean;
}

/** distance between two points of a resampled cable (px) */
export const STEP = 3;

export class Path3 {
  public pts: P3[] = [];

  public constructor(x = 0, y = 0, z = 0) {
    this.pts.push([x, y, z]);
  }

  public get last(): P3 {
    return this.pts[this.pts.length - 1];
  }

  public line(x: number, y: number, z = this.last[2]) {
    const [x0, y0, z0] = this.last;
    const n = Math.max(1, Math.ceil(Math.hypot(x - x0, y - y0) / 2));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      this.pts.push([lerp(x0, x, t), lerp(y0, y, t), lerp(z0, z, t)]);
    }
    return this;
  }

  /** a circular arc around (cx, cy) from angle a0 to a1 (screen angles: y down) */
  public arc(cx: number, cy: number, r: number, a0: number, a1: number, z1 = this.last[2]) {
    const z0 = this.last[2];
    const n = Math.max(2, Math.ceil((Math.abs(a1 - a0) * r) / 2));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const a = lerp(a0, a1, t);
      const p: P3 = [cx + r * Math.cos(a), cy + r * Math.sin(a), lerp(z0, z1, t)];
      if (i === 0 && Math.hypot(p[0] - this.last[0], p[1] - this.last[1]) < 0.5) continue;
      this.pts.push(p);
    }
    return this;
  }

  public cubic(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, z3 = this.last[2]) {
    const [x0, y0, z0] = this.last;
    const len = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
    const n = Math.max(2, Math.ceil(len / 2));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const u = 1 - t;
      this.pts.push([
        u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        lerp(z0, z3, t),
      ]);
    }
    return this;
  }

  /** points of a function f(t), t from 0 to 1 (the first one is skipped: it is the current point) */
  public fn(f: (t: number) => P3, n: number) {
    for (let i = 1; i <= n; i++) this.pts.push(f(i / n));
    return this;
  }

  public append(pts: P3[]) {
    for (const p of pts) {
      if (Math.hypot(p[0] - this.last[0], p[1] - this.last[1]) < 0.01) continue;
      this.pts.push(p);
    }
    return this;
  }
}

export function polyLength(pts: P3[]) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
}

/** the same line in steps of `step` px (measured in the picture plane); keeps the last point */
export function resample(pts: P3[], step = STEP): P3[] {
  if (pts.length < 2) return pts.slice();
  const out: P3[] = [pts[0]];
  let need = step;
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1];
    const b = pts[i];
    let seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (seg >= need && seg > 0) {
      const t = need / seg;
      const p: P3 = [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
      out.push(p);
      a = p;
      seg -= need;
      need = step;
    }
    need -= seg;
  }
  const last = pts[pts.length - 1];
  const prev = out[out.length - 1];
  if (Math.hypot(last[0] - prev[0], last[1] - prev[1]) > step * 0.3) out.push(last);
  return out;
}

/**
 * A circular arc of length `len` from a to b that turns counterclockwise on the screen. Short chord:
 * almost a full circle; chord as long as the arc: a straight line. Returns the points (with z = 0).
 */
export function arcOfLength(ax: number, ay: number, bx: number, by: number, len: number, n = 0): P3[] {
  const c = Math.hypot(bx - ax, by - ay);
  if (c >= len * 0.9999) {
    const m = n || Math.ceil(len / 2);
    return Array.from({ length: m + 1 }, (_, i) => [lerp(ax, bx, i / m), lerp(ay, by, i / m), 0] as P3);
  }
  // sin(α/2)/(α/2) = c/len, solved by bisection on (0, 2π)
  const q = c / len;
  let lo = 1e-6;
  let hi = TAU - 1e-6;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const f = Math.sin(mid / 2) / (mid / 2);
    if (f > q) lo = mid;
    else hi = mid;
  }
  const alpha = (lo + hi) / 2;
  const r = len / alpha;
  const ux = c > 1e-9 ? (bx - ax) / c : 1;
  const uy = c > 1e-9 ? (by - ay) / c : 0;
  // the centre lies to the (visual) left of the chord for small arcs, to the right for big ones
  const h = r * Math.cos(alpha / 2);
  const cx = (ax + bx) / 2 + uy * h;
  const cy = (ay + by) / 2 - ux * h;
  const a0 = Math.atan2(ay - cy, ax - cx);
  const m = n || Math.max(8, Math.ceil(len / 2));
  return Array.from({ length: m + 1 }, (_, i) => {
    const a = a0 - (alpha * i) / m;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a), 0] as P3;
  });
}

/** the cumulative arc length of each point */
export function arcLengths(pts: P3[]) {
  const s = new Array<number>(pts.length);
  s[0] = 0;
  for (let i = 1; i < pts.length; i++) s[i] = s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
}

/** piecewise-linear lookup: value of a function given at (xs, ys) */
export function interp(xs: number[], ys: number[], x: number) {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const t = clamp((x - xs[lo]) / (xs[hi] - xs[lo] || 1));
  return lerp(ys[lo], ys[hi], t);
}
