// More cable shapes for stages 4 and 5: overhand knots in a laid-out cable, a loop that twists into
// a figure eight, loops around hand and elbow, a cable laid down in figure eights.

import { P3, Path3, STEP, resample } from './geom';
import { TAU, lerp, smooth } from './math';

/** the trefoil, flipped so that the lobe we cut away is at the bottom */
function trefoil(t: number): P3 {
  return [Math.sin(t) + 2 * Math.sin(2 * t), -(Math.cos(t) - 2 * Math.cos(2 * t)), -Math.sin(3 * t)];
}

/**
 * A straight cable along y from x0 to x1 with loose overhand knots at `knots` (x positions).
 * `amount` 0..1 lets the knots grow out of the straight cable.
 */
export function knottedLine(x0: number, x1: number, y: number, knots: number[], amount: number, size = 15): P3[] {
  const p = new Path3(x0, y);
  const a = smooth(amount);
  const gap = 1.2;
  const t0 = Math.PI + gap / 2;
  const t1 = 3 * Math.PI - gap / 2;
  for (const kx of knots) {
    // the knot sits above the cable: its tails come down to the floor and cross there
    const s = size * a;
    const body: P3[] = [];
    const n = 160;
    for (let i = 0; i <= n; i++) {
      const q = trefoil(lerp(t0, t1, i / n));
      body.push([kx + s * q[0], y - s * 4.2 + s * q[1], q[2] * 8]);
    }
    const start = body[0];
    const end = body[body.length - 1];
    // in from the left, under the outgoing tail, up into the start of the knot
    p.line(kx - 3.4 * s - 6, y, -6);
    p.cubic(kx - 1.2 * s, y, start[0] + s * 0.2, y - s * 0.4, start[0], start[1], start[2]);
    p.append(body);
    // out of the knot, down over the incoming tail, away to the right
    p.cubic(end[0] - s * 0.2, y - s * 0.4, kx + 1.2 * s, y, kx + 3.4 * s + 6, y, 6);
    p.line(kx + 3.4 * s + 8, y, 0);
  }
  p.line(x1, y, 0);
  return resample(p.pts, STEP);
}

/**
 * A loop hanging from (x, y): round (eight = 0) or twisted into a figure eight (eight = 1), the
 * way a loop turned the wrong way round fights back. The cable comes in from the left above and
 * leaves to the right above.
 */
export function loopOrEight(x: number, y: number, R: number, eight: number): P3[] {
  const e = smooth(eight);
  const p = new Path3(x - 160, y - 30);
  p.cubic(x - 90, y - 30, x - 30, y, x, y);
  const n = 360;
  for (let i = 1; i <= n; i++) {
    const t = (TAU * i) / n;
    // circle through the top point, and the eight (both start and end at the top)
    const cx = -R * Math.sin(t);
    const cy = R * (1 - Math.cos(t));
    const ex = R * 0.75 * Math.sin(2 * t);
    const ey = R * 1.25 * (1 - Math.cos(t));
    p.pts.push([x + lerp(cx, ex, e), y + lerp(cy, ey, e), 10 * Math.sin(t) * e]);
  }
  p.cubic(x + 30, y, x + 90, y - 30, x + 160, y - 30);
  return resample(p.pts, STEP);
}

/**
 * Cable wound around hand and elbow, seen from the side: long loops around the forearm from x0 to
 * x1. The halves in front of the arm and behind it come as separate pieces (the arm lies between).
 */
export function elbowWrap(x0: number, x1: number, y: number, turns: number, h: number): { front: P3[][]; back: P3[][] } {
  const front: P3[][] = [];
  const back: P3[][] = [];
  const cx = (x0 + x1) / 2;
  const w = (x1 - x0) / 2;
  const n = 240;
  for (let k = 0; k < turns; k++) {
    const dx = (k - (turns - 1) / 2) * 16;
    const dh = 1 + 0.08 * Math.sin(k * 2.1);
    const half = (from: number, to: number) => {
      const pts: P3[] = [];
      for (let i = 0; i <= n / 2; i++) {
        const t = lerp(from, to, (2 * i) / n);
        pts.push([cx + dx + w * Math.cos(t), y + (h * dh * Math.sin(t)) / 2, 0]);
      }
      return resample(pts, STEP);
    };
    // the upper half runs in front of the arm, the lower half behind it
    front.push(half(Math.PI, TAU));
    back.push(half(0, Math.PI));
  }
  return { front, back };
}

/**
 * A thick cable laid down on the floor in figure eights, seen from above: layers of eights on top
 * of each other, each a little shifted.
 */
export function figureEights(x: number, y: number, w: number, h: number, layers: number): P3[] {
  const p = new Path3(x - w * 1.7, y + h * 0.9);
  p.cubic(x - w * 1.4, y + h * 0.9, x - w * 1.15, y + h * 0.5, x - w, y);
  const n = 420;
  for (let k = 0; k < layers; k++) {
    const ox = (k - (layers - 1) / 2) * 12;
    const oy = (k - (layers - 1) / 2) * 9;
    for (let i = 1; i <= n; i++) {
      const t = Math.PI + (TAU * i) / n;
      // an eight lying on its side; each layer lies on the one before
      const ex = w * Math.cos(t);
      const ey = h * Math.sin(2 * t) * 0.5;
      p.pts.push([x + ex + ox, y + ey + oy, k * 40 + 14 * Math.sin(t)]);
    }
  }
  const last = p.last;
  p.cubic(last[0] - w * 0.1, last[1] - h * 0.4, last[0] - w * 0.3, y - h * 0.9, last[0] + w * 0.6, y - h * 0.95, last[2]);
  return resample(p.pts, STEP);
}
