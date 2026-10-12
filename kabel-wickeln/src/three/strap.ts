// A velcro cable tie (Klettkabelbinder): a soft band about 2 cm wide and 25 cm long with a plastic
// eyelet at one end. The band is a thin box section built along a path (update), so any shape
// works; pose() makes the path for the usual case, the tie wrapped around a round bundle (a single
// cable near its plug, or the bundle of a coil), with two animation parameters:
//
//   wrap 0..1  how far the band reaches around the bundle; at 1 the tail passes through the eyelet
//   fold 0..1  the tail, through the eyelet, bends back and lies around the bundle on top of itself
//
// so a closing tie is wrap 0 → 1, then fold 0 → 1. `slack` loosens it, a negative slack squeezes.
// The path lies in the plane across the bundle; the band's width runs along the bundle axis.

import * as THREE from 'three';
import type { V3 } from '../sim/vec';

export interface StrapOptions {
  /** band length (m) */
  length?: number;
  width?: number;
  thickness?: number;
  /** outer (fleece) side */
  color?: string;
  /** inner (hook) side */
  inner?: string;
  eyelet?: string;
  /** most path points update() gets */
  maxPoints?: number;
}

export interface StrapWrap {
  /** a point on the bundle axis, where the tie sits */
  center: V3;
  /** bundle axis direction (the band's width runs along it) */
  axis: V3;
  /** direction from the axis to the eyelet (made perpendicular to the axis) */
  start: V3;
  /** bundle radius: the band's inner face lies on it (m) */
  radius: number;
  wrap: number;
  fold: number;
  /** extra radius while loose (m); negative squeezes */
  slack?: number;
  /** 0..1: an open tail bends this much towards the floor (in the plane of the tie) */
  droop?: number;
}

/** section corners in (width, outward) units, two per face: outer, -width edge, inner, +width edge */
const CORNERS: [number, number][] = [[1, 1], [-1, 1], [-1, 1], [-1, -1], [-1, -1], [1, -1], [1, -1], [1, 1]];
const FACE_N: [number, number][] = [[0, 1], [-1, 0], [0, -1], [1, 0]];

export class StrapMesh {
  public readonly group = new THREE.Group();
  public readonly band: THREE.Mesh;
  public readonly eyelet: THREE.Mesh;
  public readonly length: number;
  public readonly width: number;
  public readonly thickness: number;
  private readonly maxPoints: number;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly pos: Float32Array;
  private readonly nrm: Float32Array;
  private readonly path: Float32Array;

  public constructor(o: StrapOptions = {}) {
    this.length = o.length ?? 0.25;
    this.width = o.width ?? 0.02;
    this.thickness = o.thickness ?? 0.002;
    const M = (this.maxPoints = o.maxPoints ?? 200);
    this.path = new Float32Array(M * 3);
    const nv = 8 + M * 8;
    this.pos = new Float32Array(nv * 3);
    this.nrm = new Float32Array(nv * 3);
    const col = new Float32Array(nv * 3);
    const outer = new THREE.Color(o.color ?? '#1d1e21');
    const inner = new THREE.Color(o.inner ?? o.color ?? '#1d1e21').multiplyScalar(0.8);
    const edge = outer.clone().multiplyScalar(1.6);
    const faceCol = [outer, edge, inner, edge];
    for (let v = 0; v < nv; v++) {
      const c = v < 8 ? edge : faceCol[((v - 8) % 8) >> 1];
      col.set([c.r, c.g, c.b], v * 3);
    }
    const idx = new Uint32Array(12 + (M - 1) * 24);
    let k = 0;
    for (const [a, b, c, d] of [[0, 3, 2, 1], [4, 5, 6, 7]]) for (const x of [a, b, c, a, c, d]) idx[k++] = x;
    for (let r = 0; r < M - 1; r++)
      for (let f = 0; f < 4; f++) {
        const a = 8 + r * 8 + f * 2;
        const b = a + 8;
        for (const x of [a, a + 1, b, a + 1, b + 1, b]) idx[k++] = x;
      }
    const g = this.geometry;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const dyn = (arr: Float32Array) => new THREE.BufferAttribute(arr, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', dyn(this.pos));
    g.setAttribute('normal', dyn(this.nrm));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.band = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
    this.band.castShadow = true;
    this.band.receiveShadow = true;
    this.band.frustumCulled = false;

    // the eyelet: a rectangular plastic frame, its slot a little wider and thicker than the band
    const w = this.width, t = this.thickness;
    const rect = (p: THREE.Path, hw: number, hh: number, r: number) => {
      p.moveTo(-hw + r, -hh);
      p.lineTo(hw - r, -hh);
      p.absarc(hw - r, -hh + r, r, -Math.PI / 2, 0, false);
      p.lineTo(hw, hh - r);
      p.absarc(hw - r, hh - r, r, 0, Math.PI / 2, false);
      p.lineTo(-hw + r, hh);
      p.absarc(-hw + r, hh - r, r, Math.PI / 2, Math.PI, false);
      p.lineTo(-hw, -hh + r);
      p.absarc(-hw + r, -hh + r, r, Math.PI, (3 * Math.PI) / 2, false);
    };
    const frame = new THREE.Shape();
    rect(frame, w / 2 + 0.0028, t * 1.6 + 0.0022, 0.0018);
    const hole = new THREE.Path();
    rect(hole, w / 2 + 0.0006, t * 1.6, 0.0006);
    frame.holes.push(hole);
    const eg = new THREE.ExtrudeGeometry(frame, { depth: 0.0018, bevelEnabled: true, bevelThickness: 0.0004, bevelSize: 0.0004, bevelSegments: 2, curveSegments: 4 });
    eg.translate(0, 0, -0.0009);
    this.eyelet = new THREE.Mesh(eg, new THREE.MeshStandardMaterial({ color: o.eyelet ?? '#2a2b2f', roughness: 0.5 }));
    this.eyelet.castShadow = true;
    this.eyelet.matrixAutoUpdate = false;
    this.group.add(this.band, this.eyelet);
  }

  /**
   * Lays the band along a path of n points (xyz) starting at the eyelet (pose() spaces them over
   * the band's length); `side` is the direction of the band's width, or per point (`sides`, xyz
   * per point: a band that turns, e.g. hanging down from a cable). Allocates nothing.
   */
  public update(path: Float32Array, n: number, side: V3, sides?: Float32Array) {
    n = Math.min(n, this.maxPoints);
    const P = this.pos, Nr = this.nrm;
    const hw = this.width / 2, ht = this.thickness / 2;
    let sx = side[0], sy = side[1], sz = side[2];
    for (let k = 0; k < n; k++) {
      if (sides) {
        sx = sides[k * 3];
        sy = sides[k * 3 + 1];
        sz = sides[k * 3 + 2];
      }
      const a = Math.max(0, k - 1) * 3, b = Math.min(n - 1, k + 1) * 3;
      let tx = path[b] - path[a], ty = path[b + 1] - path[a + 1], tz = path[b + 2] - path[a + 2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      // outward face normal o = t × side, width direction w = o × t (so w × o = t)
      let ox = ty * sz - tz * sy, oy = tz * sx - tx * sz, oz = tx * sy - ty * sx;
      const ol = Math.hypot(ox, oy, oz) || 1;
      ox /= ol;
      oy /= ol;
      oz /= ol;
      const wx = oy * tz - oz * ty, wy = oz * tx - ox * tz, wz = ox * ty - oy * tx;
      const cx = path[k * 3], cy = path[k * 3 + 1], cz = path[k * 3 + 2];
      for (let v = 0; v < 8; v++) {
        const [sw, so] = CORNERS[v];
        const [nw, no] = FACE_N[v >> 1];
        const o3 = (8 + k * 8 + v) * 3;
        P[o3] = cx + wx * sw * hw + ox * so * ht;
        P[o3 + 1] = cy + wy * sw * hw + oy * so * ht;
        P[o3 + 2] = cz + wz * sw * hw + oz * so * ht;
        Nr[o3] = wx * nw + ox * no;
        Nr[o3 + 1] = wy * nw + oy * no;
        Nr[o3 + 2] = wz * nw + oz * no;
      }
      if (k === 0 || k === n - 1) {
        const e = k === 0 ? 0 : 4;
        const sgn = k === 0 ? -1 : 1;
        for (let c = 0; c < 4; c++) {
          const src = (8 + k * 8 + c * 2) * 3;
          const o3 = (e + c) * 3;
          P[o3] = P[src];
          P[o3 + 1] = P[src + 1];
          P[o3 + 2] = P[src + 2];
          Nr[o3] = tx * sgn;
          Nr[o3 + 1] = ty * sgn;
          Nr[o3 + 2] = tz * sgn;
        }
      }
    }
    const g = this.geometry;
    g.setDrawRange(0, 12 + (n - 1) * 24);
    for (const name of ['position', 'normal']) {
      const att = g.getAttribute(name) as THREE.BufferAttribute;
      att.clearUpdateRanges();
      att.addUpdateRange(0, (8 + n * 8) * 3);
      att.needsUpdate = true;
    }
  }

  /** puts the eyelet at p: its x along the band's width, y outward (radial), z along the band */
  public placeEyelet(p: V3, x: V3, y: V3, z: V3) {
    this.eyelet.matrix.set(x[0], y[0], z[0], p[0], x[1], y[1], z[1], p[1], x[2], y[2], z[2], p[2], 0, 0, 0, 1);
    this.eyelet.matrixWorldNeedsUpdate = true;
  }

  /** wraps the tie around a bundle (see the file header); allocates nothing */
  public pose(w: StrapWrap) {
    const M = this.maxPoints;
    const ds = this.length / (M - 1);
    const t = this.thickness;
    // plane basis: u towards the eyelet, v = axis × u (the wrapping direction)
    const [ax, ay, az] = w.axis;
    const al = Math.hypot(ax, ay, az) || 1;
    const nx = ax / al, ny = ay / al, nz = az / al;
    let ux = w.start[0], uy = w.start[1], uz = w.start[2];
    const d = ux * nx + uy * ny + uz * nz;
    ux -= d * nx;
    uy -= d * ny;
    uz -= d * nz;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
    // the floor's direction in the plane, for a drooping tail
    const gu = -uy, gv = -vy;
    const gl = Math.hypot(gu, gv) || 1;

    const r1 = w.radius + Math.max(-w.radius * 0.5, w.slack ?? 0) + t / 2;
    const r2 = r1 + t * 1.6; // the second pass, through the eyelet's slot
    const wrapA = Math.max(0, Math.min(1, w.wrap)) * Math.PI * 2;
    const fold = Math.max(0, Math.min(1, w.fold));
    const droop = w.droop ?? 0;
    let theta = 0;
    let x = r1, y = 0;
    let hx = 0, hy = 1; // heading
    let bent = 0;
    let wrapping = wrapA > 0;
    let tailS = 0;
    const out = this.path;
    for (let k = 0; k < M; k++) {
      out[k * 3] = w.center[0] + ux * x + vx * y;
      out[k * 3 + 1] = w.center[1] + uy * x + vy * y;
      out[k * 3 + 2] = w.center[2] + uz * x + vz * y;
      if (wrapping) {
        // along the spiral: radius r1, rising to r2 in the last fifth of the turn
        const rise = Math.max(0, (theta - 1.6 * Math.PI) / (0.4 * Math.PI));
        const r = r1 + (r2 - r1) * Math.min(1, rise);
        theta = Math.min(wrapA, theta + ds / r);
        x = r * Math.cos(theta);
        y = r * Math.sin(theta);
        hx = -Math.sin(theta);
        hy = Math.cos(theta);
        if (theta >= wrapA) wrapping = false;
        continue;
      }
      tailS += ds;
      let turn = 0;
      if (wrapA >= Math.PI * 2 - 1e-6 && fold > 0 && tailS > 0.012) {
        // through the eyelet: a tight U-turn outwards, then around the bundle the other way
        if (bent < Math.PI * fold) {
          turn = -ds / (t * 1.5);
          bent -= turn;
        } else {
          const dist = Math.hypot(x, y);
          turn = (-ds * fold * fold * fold) / (dist + t * 0.6);
        }
      } else if (droop > 0) {
        // turn the heading towards the floor
        const cross = hx * (gv / gl) - hy * (gu / gl);
        turn = cross * droop * ds * 25;
      }
      if (turn !== 0) {
        const c = Math.cos(turn), s = Math.sin(turn);
        const hx2 = hx * c - hy * s;
        hy = hx * s + hy * c;
        hx = hx2;
      }
      x += hx * ds;
      y += hy * ds;
    }
    this.update(out, M, w.axis);
    // the eyelet: just before the band's start, its slot across the band's direction (v)
    const ex = w.center[0] + ux * (r1 + t * 0.8) - vx * 0.0016;
    const ey = w.center[1] + uy * (r1 + t * 0.8) - vy * 0.0016;
    const ez = w.center[2] + uz * (r1 + t * 0.8) - vz * 0.0016;
    // local x along the band's width (axis), local y radial (u), local z along the band (v)
    this.eyelet.matrix.set(nx, ux, vx, ex, ny, uy, vy, ey, nz, uz, vz, ez, 0, 0, 0, 1);
    this.eyelet.matrixWorldNeedsUpdate = true;
  }
}
