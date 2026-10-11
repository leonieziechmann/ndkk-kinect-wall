// Triangle meshes for the bodies: ellipsoids and lofts (rings along a path, each a superellipse, so
// a cross-section can be anything from round to a rounded box). Ported from erklaervideo and extended:
// faces can be painted one by one (pockets, soles, nails), every triangle carries a layer (the own
// head and torso hide in the first-person view) and a shading mode, and a built mesh can be refilled
// in place: the same person always gives the same vertices in the same order, whatever the pose, so
// later builds only overwrite the positions.

import { V3, cross, dot, norm } from '../math';

/** materials: what a surface is made of; the palette gives each one a colour */
export const MAT = {
  skin: 0,
  top: 1,
  /** second shade of the top: hems, cuffs, pockets, what shows under an open cardigan */
  top2: 2,
  pants: 3,
  pants2: 4,
  shoes: 5,
  sole: 6,
  hair: 7,
  /** the shaved sides of an undercut, a beard of another colour */
  hair2: 8,
  nails: 9,
  glove: 10,
  glove2: 11,
  pad: 12,
  cap: 13,
  hijab: 14,
  frame: 15,
  /** small details in a contrasting colour: drawstrings, zips */
  accent: 16,
} as const;
export type MatName = keyof typeof MAT;
export const MAT_COUNT = Object.keys(MAT).length;

/** layer of the own head, hair, neck, torso and upper arms: a first-person camera leaves it out */
export const SELF = 1;

/** a material per face: one for all, one per segment, or chosen per segment j and side i */
export type Paint = number | number[] | ((j: number, i: number) => number);

export class Mesh {
  pos: number[] = [];
  tri: number[] = [];
  mat: number[] = [];
  /** per triangle: 0, or SELF */
  layer: number[] = [];
  /** per triangle: 1 = smooth shading (vertex normals), 0 = flat */
  smooth: number[] = [];
  /** what the next faces get */
  curLayer = 0;
  curSmooth = 0;
  private refill = false;
  private nv = 0;
  private nt = 0;

  /** starts a build; a mesh that was built before is refilled in place (positions only) */
  begin() {
    this.refill = this.tri.length > 0;
    this.nv = 0;
    this.nt = 0;
    this.curLayer = 0;
    this.curSmooth = 0;
  }

  /** ends a build; a refill must have made exactly the same vertices and faces */
  end() {
    if (this.refill && (this.nv * 3 !== this.pos.length || this.nt * 3 !== this.tri.length)) {
      throw new Error(`body topology changed: ${this.nv}/${this.pos.length / 3} vertices, ${this.nt}/${this.tri.length / 3} faces`);
    }
  }

  vertex(p: V3) {
    if (this.refill) {
      const o = this.nv * 3;
      this.pos[o] = p[0];
      this.pos[o + 1] = p[1];
      this.pos[o + 2] = p[2];
    } else this.pos.push(p[0], p[1], p[2]);
    return this.nv++;
  }

  vertex3(x: number, y: number, z: number) {
    if (this.refill) {
      const o = this.nv * 3;
      this.pos[o] = x;
      this.pos[o + 1] = y;
      this.pos[o + 2] = z;
    } else this.pos.push(x, y, z);
    return this.nv++;
  }

  face(a: number, b: number, c: number, m: number) {
    this.nt++;
    if (this.refill) return;
    this.tri.push(a, b, c);
    this.mat.push(m);
    this.layer.push(this.curLayer);
    this.smooth.push(this.curSmooth);
  }

  get vertexCount() {
    return this.nv;
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
      m.vertex3(c[0] + x[0] * cx + y[0] * cy + z[0] * cz, c[1] + x[1] * cx + y[1] * cy + z[1] * cz, c[2] + x[2] * cx + y[2] * cy + z[2] * cz);
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
  /** the ring hangs down at ±y (a drape over the shoulders): y·y · sag along -(x × y) */
  sag?: number;
  /** irregular bumps outwards (curls), m */
  bumps?: number;
}

/** deterministic hash noise 0..1 */
function hash(a: number, b: number) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const unitCache = new Map<number, [number, number][]>();
/** points of a unit superellipse; point i is at angle 2πi/sides from +x towards +y */
function unitShape(sides: number, p: number) {
  const key = sides * 100000 + Math.round(p * 1000);
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

/** how much face i of a loft with `sides` sides faces the ring direction (ax, ay): -1 … 1 */
export function facing(i: number, sides: number, ax: number, ay: number) {
  const a = (2 * Math.PI * (i + 0.5)) / sides;
  return (Math.cos(a) * ax + Math.sin(a) * ay) / (Math.hypot(ax, ay) || 1);
}

/**
 * Rings joined into a tube. `p` shapes the cross-sections: 2 = ellipse, larger = boxier. The ends are
 * closed with a small dome (`dome` > 0, as a fraction of the radius) or flat. `paint` gives the
 * material of each face (segment j joins ring j and j + 1; side i starts at +x); `layerOf` the layer
 * per segment (default: the mesh's current one).
 */
export function loft(m: Mesh, rings: Ring[], sides: number, paint: Paint, p = 2, dome = 0.5, layerOf?: (j: number) => number) {
  const start = m.vertexCount;
  for (let j = 0; j < rings.length; j++) {
    const r = rings[j];
    const pts = unitShape(sides, r.p ?? p);
    const rx2 = r.rx2 ?? r.rx;
    const ry2 = r.ry2 ?? r.ry;
    const sag = r.sag ?? 0;
    const n = sag ? cross(r.x, r.y) : null;
    for (let i = 0; i < sides; i++) {
      const [px, py] = pts[i];
      // bumps: alternating in and out with some noise, so flat faces catch the light like curls
      const b = r.bumps ? 1 + (r.bumps * (((i + j) & 1 ? 0.8 : -0.5) + hash(i, j) - 0.5)) / Math.max(r.rx, r.ry) : 1;
      const ax = px * (px >= 0 ? r.rx : rx2) * b;
      const ay = py * (py >= 0 ? r.ry : ry2) * b;
      const s = n ? -sag * py * py : 0;
      m.vertex3(
        r.c[0] + r.x[0] * ax + r.y[0] * ay + (n ? n[0] * s : 0),
        r.c[1] + r.x[1] * ax + r.y[1] * ay + (n ? n[1] * s : 0),
        r.c[2] + r.x[2] * ax + r.y[2] * ay + (n ? n[2] * s : 0),
      );
    }
  }
  const last = rings.length - 2;
  const matOf =
    typeof paint === 'number'
      ? () => paint
      : Array.isArray(paint)
        ? (j: number) => paint[Math.max(0, Math.min(paint.length - 1, j))]
        : (j: number, i: number) => paint(Math.max(0, Math.min(last, j)), i);
  // the faces point outwards if x = y × (direction of the path); else turn them
  const mid = Math.max(0, Math.floor((rings.length - 2) / 2));
  const ra = rings[mid];
  const rb = rings[Math.min(rings.length - 1, mid + 1)];
  const along: V3 = [rb.c[0] - ra.c[0], rb.c[1] - ra.c[1], rb.c[2] - ra.c[2]];
  const turn = dot(cross(ra.y, along), ra.x) < 0;
  const face = (a: number, b: number, c: number, mt: number) => (turn ? m.face(a, c, b, mt) : m.face(a, b, c, mt));
  const keep = m.curLayer;
  for (let j = 0; j < rings.length - 1; j++) {
    if (layerOf) m.curLayer = layerOf(j);
    for (let i = 0; i < sides; i++) {
      const a = start + j * sides + i;
      const b = start + j * sides + ((i + 1) % sides);
      const c = a + sides;
      const d = b + sides;
      const mt = matOf(j, i);
      face(a, b, c, mt);
      face(b, d, c, mt);
    }
  }
  // the ends
  const cap = (ring: Ring, first: number, outward: V3, flip: boolean, j: number) => {
    const r = Math.max(ring.rx, ring.ry, ring.rx2 ?? 0, ring.ry2 ?? 0);
    const tip = m.vertex3(ring.c[0] + outward[0] * r * dome, ring.c[1] + outward[1] * r * dome, ring.c[2] + outward[2] * r * dome);
    for (let i = 0; i < sides; i++) {
      const a = first + i;
      const b = first + ((i + 1) % sides);
      const mt = matOf(j, i);
      if (flip) face(tip, b, a, mt);
      else face(tip, a, b, mt);
    }
  };
  if (rings.length > 1) {
    const r0 = rings[0];
    const r1 = rings[rings.length - 1];
    const d0 = norm([r0.c[0] - rings[1].c[0], r0.c[1] - rings[1].c[1], r0.c[2] - rings[1].c[2]]);
    const d1 = norm([r1.c[0] - rings[rings.length - 2].c[0], r1.c[1] - rings[rings.length - 2].c[1], r1.c[2] - rings[rings.length - 2].c[2]]);
    if (layerOf) m.curLayer = layerOf(0);
    cap(r0, start, d0, true, 0);
    if (layerOf) m.curLayer = layerOf(last);
    cap(r1, start + (rings.length - 1) * sides, d1, false, last);
  }
  m.curLayer = keep;
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
