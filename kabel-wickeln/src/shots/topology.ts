// Topology checks for baked cables: how many knots a cable has (the knot determinant of its
// diagram) and how close two strands come (pass-through detection). Used by the shot checks and
// the simulation tests (tools/simtest); pure TypeScript.
//
// Knots: the open cable is closed far above the scene, projected along a generic direction, and
// the determinant of its colouring matrix (Alexander polynomial at t = -1) is computed. It is 1
// for no knot, 3 for an overhand knot (trefoil) and multiplies over separate knots, so a cable
// with k overhand knots has determinant 3^k. It is a topological invariant: it only changes when
// one strand passes through another.

import type { V3 } from '../sim';

/** Projection directions (generic, not aligned with the floor or the axes). */
const DIRS: V3[] = [[0.5237, 1, 0.3119], [-0.6113, 1, 0.4231], [0.2613, 1, -0.7417]];

interface Crossing {
  /** position along the closed polygon (segment index + parameter) of the over and the under strand */
  over: number;
  under: number;
}

/**
 * Knot determinant of the polyline of nodes from..to (3 floats per node in x), closed by a path
 * high above along dir. 1 = unknotted, 3 = one overhand knot, 9 = two, …
 */
export function knotDeterminant(x: ArrayLike<number>, from: number, to: number, dir: V3 = DIRS[0]): number {
  const l = Math.hypot(dir[0], dir[1], dir[2]);
  const u: V3 = [dir[0] / l, dir[1] / l, dir[2] / l];
  // basis of the projection plane
  const a0: V3 = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  const du = a0[0] * u[0] + a0[1] * u[1] + a0[2] * u[2];
  const e1n = Math.hypot(a0[0] - du * u[0], a0[1] - du * u[1], a0[2] - du * u[2]);
  const e1: V3 = [(a0[0] - du * u[0]) / e1n, (a0[1] - du * u[1]) / e1n, (a0[2] - du * u[2]) / e1n];
  const e2: V3 = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]];
  // closed polygon: the nodes, then straight up along u, across high above, back down
  const m = to - from + 1;
  const px: number[] = [], py: number[] = [], pz: number[] = [];
  for (let i = from; i <= to; i++) {
    const X = x[3 * i], Y = x[3 * i + 1], Z = x[3 * i + 2];
    px.push(X * e1[0] + Y * e1[1] + Z * e1[2]);
    py.push(X * e2[0] + Y * e2[1] + Z * e2[2]);
    pz.push(X * u[0] + Y * u[1] + Z * u[2]);
  }
  const H = 1e3;
  // the closing segment A→B projects onto the chord between the two ends, above everything
  px.push(px[m - 1], px[0]);
  py.push(py[m - 1], py[0]);
  pz.push(H, H);
  const P = px.length; // segments i → (i + 1) % P; the vertical ones (m-1 → m, P-1 → 0) project to points
  const crossings: Crossing[] = [];
  for (let i = 0; i < P; i++) {
    const i1 = (i + 1) % P;
    const ax = px[i], ay = py[i], bx = px[i1] - ax, by = py[i1] - ay;
    if (bx * bx + by * by < 1e-18) continue;
    const xmin = Math.min(ax, px[i1]), xmax = Math.max(ax, px[i1]), ymin = Math.min(ay, py[i1]), ymax = Math.max(ay, py[i1]);
    for (let j = i + 2; j < P; j++) {
      const j1 = (j + 1) % P;
      if (j1 === i) continue;
      const cx = px[j], cy = py[j], dx = px[j1] - cx, dy = py[j1] - cy;
      if (dx * dx + dy * dy < 1e-18) continue;
      if (Math.max(cx, px[j1]) < xmin || Math.min(cx, px[j1]) > xmax || Math.max(cy, py[j1]) < ymin || Math.min(cy, py[j1]) > ymax) continue;
      const den = bx * dy - by * dx;
      if (Math.abs(den) < 1e-18) continue;
      const s = ((cx - ax) * dy - (cy - ay) * dx) / den;
      const t = ((cx - ax) * by - (cy - ay) * bx) / den;
      if (s <= 0 || s >= 1 || t <= 0 || t >= 1) continue;
      const zi = pz[i] + (pz[i1] - pz[i]) * s, zj = pz[j] + (pz[j1] - pz[j]) * t;
      crossings.push(zi > zj ? { over: i + s, under: j + t } : { over: j + t, under: i + s });
    }
  }
  const K = crossings.length;
  if (K === 0) return 1;
  // arcs run from one under-passage to the next; arc k starts at the k-th under-passage
  const unders = crossings.map((c) => c.under).sort((p, q) => p - q);
  const arcOf = (pos: number) => {
    // last under-passage at or before pos (cyclic: before the first one is the last arc)
    let lo = 0, hi = K - 1, k = K - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (unders[mid] <= pos) { k = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return unders[0] > pos ? K - 1 : k;
  };
  const M = new Float64Array(K * K);
  crossings.forEach((c, r) => {
    const after = arcOf(c.under), before = (after + K - 1) % K;
    M[r * K + arcOf(c.over)] += 2;
    M[r * K + before] -= 1;
    M[r * K + after] -= 1;
  });
  return Math.round(Math.abs(det(M, K, K - 1)));
}

/** Determinant of the leading n×n block of the K×K row-major matrix M (destroys M). */
function det(M: Float64Array, K: number, n: number): number {
  let d = 1;
  for (let c = 0; c < n; c++) {
    let p = c, best = Math.abs(M[c * K + c]);
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * K + c]) > best) { best = Math.abs(M[r * K + c]); p = r; }
    if (best < 1e-9) return 0;
    if (p !== c) {
      for (let s = 0; s < n; s++) { const tmp = M[c * K + s]; M[c * K + s] = M[p * K + s]; M[p * K + s] = tmp; }
      d = -d;
    }
    const piv = M[c * K + c];
    d *= piv;
    for (let r = c + 1; r < n; r++) {
      const f = M[r * K + c] / piv;
      if (f !== 0) for (let s = c; s < n; s++) M[r * K + s] -= f * M[c * K + s];
    }
  }
  return d;
}

/**
 * Number of overhand-type knots in nodes from..to: log3 of the knot determinant, taken as the
 * majority over three projection directions (guards against a degenerate projection).
 * Returns the determinant too (a non-power of 3 means some other knot).
 */
export function knots(x: ArrayLike<number>, from: number, to: number): { det: number; knots: number } {
  const dets = DIRS.map((d) => knotDeterminant(x, from, to, d));
  const det = dets[0] === dets[1] || dets[0] === dets[2] ? dets[0] : dets[1];
  return { det, knots: Math.round(Math.log(Math.max(1, det)) / Math.log(3)) };
}

/**
 * Smallest distance between the axes of two strands: segments at least `skip` apart along the
 * cable (closer ones are neighbours, not strands). Below twice the contact radius the strands are
 * pressed into each other; far below it, one may be passing through the other.
 */
export function minStrandDistance(x: ArrayLike<number>, n: number, skip: number): number {
  let best = Infinity, maxL = 0;
  const ns = n - 1;
  for (let i = 0; i < ns; i++) maxL = Math.max(maxL, Math.hypot(x[3 * i + 3] - x[3 * i], x[3 * i + 4] - x[3 * i + 1], x[3 * i + 5] - x[3 * i + 2]));
  for (let i = 0; i < ns; i++) {
    const ax = x[3 * i], ay = x[3 * i + 1], az = x[3 * i + 2];
    const bx = x[3 * i + 3] - ax, by = x[3 * i + 4] - ay, bz = x[3 * i + 5] - az;
    for (let j = i + skip; j < ns; j++) {
      const cx = x[3 * j], cy = x[3 * j + 1], cz = x[3 * j + 2];
      // quick reject: start points further apart than both segment lengths plus the best so far
      const ex = cx - ax, ey = cy - ay, ez = cz - az, reach = 2 * maxL + Math.min(best, 0.05);
      if (ex * ex + ey * ey + ez * ez > reach * reach) continue;
      const dx = x[3 * j + 3] - cx, dy = x[3 * j + 4] - cy, dz = x[3 * j + 5] - cz;
      best = Math.min(best, segDist(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz));
    }
  }
  return best;
}

/** Distance between the segments a + s b and c + t d (s, t in 0..1). */
function segDist(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number) {
  const rx = ax - cx, ry = ay - cy, rz = az - cz;
  const A = bx * bx + by * by + bz * bz, E = dx * dx + dy * dy + dz * dz, F = dx * rx + dy * ry + dz * rz;
  const C = bx * rx + by * ry + bz * rz, B = bx * dx + by * dy + bz * dz;
  const den = A * E - B * B;
  let s = den > 1e-14 ? Math.min(1, Math.max(0, (B * F - C * E) / den)) : 0;
  let t = (B * s + F) / E;
  if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -C / A)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (B - C) / A)); }
  const qx = rx + bx * s - dx * t, qy = ry + by * s - dy * t, qz = rz + bz * s - dz * t;
  return Math.hypot(qx, qy, qz);
}

/**
 * Tight knots: places where `span` metres of cable fit into a ball of radius `radius` (an XLR
 * overhand knot pulled by hand; a loose loop or a straight cable does not). Returns their
 * centres in cable order.
 */
export function tightKnots(x: ArrayLike<number>, n: number, seg: number, span = 0.15, radius = 0.03): V3[] {
  const w = Math.max(2, Math.round(span / seg));
  const out: V3[] = [];
  let best: { r: number; c: V3 } | null = null, last = -Infinity;
  for (let i = 0; i + w < n; i++) {
    let cx = 0, cy = 0, cz = 0;
    for (let k = i; k <= i + w; k++) { cx += x[3 * k]; cy += x[3 * k + 1]; cz += x[3 * k + 2]; }
    cx /= w + 1; cy /= w + 1; cz /= w + 1;
    let r = 0;
    for (let k = i; k <= i + w; k++) r = Math.max(r, Math.hypot(x[3 * k] - cx, x[3 * k + 1] - cy, x[3 * k + 2] - cz));
    if (r >= radius) continue;
    // windows that overlap belong to the same knot: keep the tightest
    if (i - last > w) {
      if (best) out.push(best.c);
      best = null;
    }
    last = i;
    if (!best || r < best.r) best = { r, c: [cx, cy, cz] };
  }
  if (best) out.push(best.c);
  return out;
}
