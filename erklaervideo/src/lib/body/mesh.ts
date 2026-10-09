// Triangle meshes for the bodies: ellipsoids and lofts (rings along a path, each a superellipse, so
// a cross-section can be anything from round to a rounded box). The same body always gives the same
// vertices in the same order, whatever the pose, so a point on the body can be followed over time.

import { V3, cross, dot, norm } from '../math';

/** materials: what the surface is made of (infrared brightness and look) */
export const MAT = { skin: 0, shirt: 1, pants: 2, shoes: 3, hair: 4 } as const;

export class Mesh {
  pos: number[] = [];
  tri: number[] = [];
  mat: number[] = [];
  /** shading: smooth (vertex normals) or flat (face normals, the low-poly look) */
  flat = false;
  private normalCache: Float32Array | null = null;
  private faceCache: Float32Array | null = null;

  vertex(p: V3) {
    this.pos.push(p[0], p[1], p[2]);
    return this.pos.length / 3 - 1;
  }

  face(a: number, b: number, c: number, m: number) {
    this.tri.push(a, b, c);
    this.mat.push(m);
  }

  get vertexCount() {
    return this.pos.length / 3;
  }

  /** smooth normals per vertex (area weighted) */
  normals() {
    if (this.normalCache) return this.normalCache;
    const n = new Float32Array(this.pos.length);
    const P = this.pos;
    for (let t = 0; t < this.tri.length; t += 3) {
      const a = this.tri[t] * 3;
      const b = this.tri[t + 1] * 3;
      const c = this.tri[t + 2] * 3;
      const ux = P[b] - P[a];
      const uy = P[b + 1] - P[a + 1];
      const uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a];
      const vy = P[c + 1] - P[a + 1];
      const vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      for (const i of [a, b, c]) {
        n[i] += nx;
        n[i + 1] += ny;
        n[i + 2] += nz;
      }
    }
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
      n[i] /= l;
      n[i + 1] /= l;
      n[i + 2] /= l;
    }
    this.normalCache = n;
    return n;
  }

  /** one normal per triangle (flat shading) */
  faceNormals() {
    if (this.faceCache) return this.faceCache;
    const P = this.pos;
    const n = new Float32Array(this.tri.length);
    for (let t = 0; t < this.tri.length; t += 3) {
      const a = this.tri[t] * 3;
      const b = this.tri[t + 1] * 3;
      const c = this.tri[t + 2] * 3;
      const ux = P[b] - P[a];
      const uy = P[b + 1] - P[a + 1];
      const uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a];
      const vy = P[c + 1] - P[a + 1];
      const vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      n[t] = nx / l;
      n[t + 1] = ny / l;
      n[t + 2] = nz / l;
    }
    this.faceCache = n;
    return n;
  }
}

/** an ellipsoid with axes x, y, z (unit vectors) and radii; nu around, nv from bottom to top */
export function ellipsoid(m: Mesh, c: V3, x: V3, y: V3, z: V3, rx: number, ry: number, rz: number, nu: number, nv: number, mat: number) {
  const start = m.vertexCount;
  // the faces point outwards for right-handed axes; turn them for left-handed ones
  const turn = dot(cross(x, y), z) < 0;
  for (let j = 0; j <= nv; j++) {
    const th = (Math.PI * j) / nv;
    const sy = -Math.cos(th);
    const sr = Math.sin(th);
    for (let i = 0; i < nu; i++) {
      const ph = (2 * Math.PI * i) / nu;
      const cx = sr * Math.cos(ph) * rx;
      const cz = sr * Math.sin(ph) * rz;
      const cy = sy * ry;
      m.vertex([c[0] + x[0] * cx + y[0] * cy + z[0] * cz, c[1] + x[1] * cx + y[1] * cy + z[1] * cz, c[2] + x[2] * cx + y[2] * cy + z[2] * cz]);
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = start + j * nu + i;
      const b = start + j * nu + ((i + 1) % nu);
      const c2 = a + nu;
      const d = b + nu;
      if (turn) {
        m.face(a, b, c2, mat);
        m.face(b, d, c2, mat);
      } else {
        m.face(a, c2, b, mat);
        m.face(b, c2, d, mat);
      }
    }
  }
}

export interface Ring {
  /** center */
  c: V3;
  /** the two axes of the cross-section (unit, perpendicular to the path) */
  x: V3;
  y: V3;
  /** half-widths towards +x and +y */
  rx: number;
  ry: number;
  /** half-widths towards -x and -y (default: the same) */
  rx2?: number;
  ry2?: number;
  /** cross-section exponent: 2 = ellipse, larger = boxier (default: the loft's) */
  p?: number;
}

const unitCache = new Map<string, [number, number][]>();
/** points of a unit superellipse */
function unitShape(sides: number, p: number) {
  const key = `${sides}:${p}`;
  let pts = unitCache.get(key);
  if (pts) return pts;
  const e = 2 / p;
  pts = [];
  for (let i = 0; i < sides; i++) {
    const a = (2 * Math.PI * i) / sides;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    pts.push([Math.sign(ca) * Math.abs(ca) ** e, Math.sign(sa) * Math.abs(sa) ** e]);
  }
  unitCache.set(key, pts);
  return pts;
}

/**
 * Rings joined into a tube. `p` shapes the cross-sections: 2 = ellipse, larger = boxier. The ends are
 * closed with a small dome (`dome` > 0, as a fraction of the radius) or flat. `mat` is one material,
 * or one per segment (segment j joins ring j and j + 1).
 */
export function loft(m: Mesh, rings: Ring[], sides: number, mat: number | number[], p = 2, dome = 0.5) {
  const start = m.vertexCount;
  for (const r of rings) {
    const rx2 = r.rx2 ?? r.rx;
    const ry2 = r.ry2 ?? r.ry;
    for (const [px, py] of unitShape(sides, r.p ?? p)) {
      const ax = px * (px >= 0 ? r.rx : rx2);
      const ay = py * (py >= 0 ? r.ry : ry2);
      m.vertex([r.c[0] + r.x[0] * ax + r.y[0] * ay, r.c[1] + r.x[1] * ax + r.y[1] * ay, r.c[2] + r.x[2] * ax + r.y[2] * ay]);
    }
  }
  const matOf = (j: number) => (typeof mat === 'number' ? mat : mat[Math.max(0, Math.min(mat.length - 1, j))]);
  // the faces point outwards if x = y × (direction of the path); else turn them
  const mid = Math.max(0, Math.floor((rings.length - 2) / 2));
  const ra = rings[mid];
  const rb = rings[Math.min(rings.length - 1, mid + 1)];
  const along: V3 = [rb.c[0] - ra.c[0], rb.c[1] - ra.c[1], rb.c[2] - ra.c[2]];
  const turn = dot(cross(ra.y, along), ra.x) < 0;
  const face = (a: number, b: number, c: number, mt: number) => (turn ? m.face(a, c, b, mt) : m.face(a, b, c, mt));
  for (let j = 0; j < rings.length - 1; j++) {
    const mt = matOf(j);
    for (let i = 0; i < sides; i++) {
      const a = start + j * sides + i;
      const b = start + j * sides + ((i + 1) % sides);
      const c = a + sides;
      const d = b + sides;
      face(a, b, c, mt);
      face(b, d, c, mt);
    }
  }
  // the ends
  const cap = (ring: Ring, first: number, outward: V3, flip: boolean, mt: number) => {
    const r = Math.max(ring.rx, ring.ry, ring.rx2 ?? 0, ring.ry2 ?? 0);
    const tip = m.vertex([ring.c[0] + outward[0] * r * dome, ring.c[1] + outward[1] * r * dome, ring.c[2] + outward[2] * r * dome]);
    for (let i = 0; i < sides; i++) {
      const a = first + i;
      const b = first + ((i + 1) % sides);
      if (flip) face(tip, b, a, mt);
      else face(tip, a, b, mt);
    }
  };
  if (rings.length > 1) {
    const r0 = rings[0];
    const r1 = rings[rings.length - 1];
    const d0 = norm([r0.c[0] - rings[1].c[0], r0.c[1] - rings[1].c[1], r0.c[2] - rings[1].c[2]]);
    const d1 = norm([r1.c[0] - rings[rings.length - 2].c[0], r1.c[1] - rings[rings.length - 2].c[1], r1.c[2] - rings[rings.length - 2].c[2]]);
    cap(r0, start, d0, true, matOf(0));
    cap(r1, start + (rings.length - 1) * sides, d1, false, matOf(rings.length - 2));
  }
}

/** cross-section axes for a path direction d: x across (towards `side`), y the rest */
export function axesFor(d: V3, side: V3): [V3, V3] {
  let y = cross(d, side);
  if (Math.hypot(y[0], y[1], y[2]) < 1e-4) y = cross(d, [0, 1, 0]);
  if (Math.hypot(y[0], y[1], y[2]) < 1e-4) y = cross(d, [1, 0, 0]);
  y = norm(y);
  const x = norm(cross(y, d));
  return [x, y];
}

/**
 * Rings along a polyline of points with radii (round cross-sections, or flattened to rx/ry). The
 * cross-section starts with x towards `side` and is carried along the path without twisting
 * (parallel transport), so the tube never folds, however the path bends.
 */
export function tubeRings(points: V3[], radii: number[], side: V3, flatten = 1): Ring[] {
  const rings: Ring[] = [];
  let x: V3 | null = null;
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const d = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    if (!x) x = axesFor(d, side)[0];
    // the previous x, turned into the plane of this cross-section
    const k = dot(x, d);
    let nx: V3 = [x[0] - d[0] * k, x[1] - d[1] * k, x[2] - d[2] * k];
    if (Math.hypot(nx[0], nx[1], nx[2]) < 1e-4) nx = axesFor(d, side)[0];
    x = norm(nx);
    const y = norm(cross(d, x));
    rings.push({ c: points[i], x, y, rx: radii[i], ry: radii[i] * flatten });
  }
  return rings;
}
