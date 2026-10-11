// 3D guides drawn into the scene:
//   ArcArrow   a curved arrow around an axis (rolling the cable in the fingers, the 180° turn of the
//              hand around the forearm, ↻/↺ on figure eights); grows with `progress`
//   GhostPath  a dashed, glowing tube along a path (the ghost loop: "this big should it be")
// Both rebuild their geometry in place (no allocation per frame) and cast no shadows.

import * as THREE from 'three';
import type { V3 } from '../sim/vec';

export interface ArcArrowOptions {
  color?: string;
  /** tube radius of the shaft (m) */
  thickness?: number;
  /** segments along the arc */
  segments?: number;
}

export interface ArcPose {
  center: V3;
  /** rotation axis: the arrow turns counter-clockwise seen from its tip (right-hand rule) */
  axis: V3;
  /** direction from the centre to the arrow's start (made perpendicular to the axis) */
  from: V3;
  /** radius of the arc (m) */
  radius: number;
  /** signed sweep (rad): negative turns clockwise about the axis */
  angle: number;
  /** 0..1: how much of the sweep is drawn */
  progress?: number;
}

const SIDES = 10;

export class ArcArrow {
  public readonly group = new THREE.Group();
  private readonly shaft: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private readonly tail: THREE.Mesh;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly pos: Float32Array;
  private readonly nrm: Float32Array;
  private readonly K: number;
  private readonly r: number;

  public constructor(o: ArcArrowOptions = {}) {
    const K = (this.K = o.segments ?? 48);
    this.r = o.thickness ?? 0.004;
    const ring = SIDES + 1;
    this.pos = new Float32Array((K + 1) * ring * 3);
    this.nrm = new Float32Array((K + 1) * ring * 3);
    const idx: number[] = [];
    for (let k = 0; k < K; k++)
      for (let j = 0; j < SIDES; j++) {
        const a = k * ring + j;
        const b = a + ring;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    const g = this.geometry;
    g.setIndex(idx);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    const color = new THREE.Color(o.color ?? '#2a6cc4');
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.45, emissive: color, emissiveIntensity: 0.35 });
    this.shaft = new THREE.Mesh(g, mat);
    this.shaft.frustumCulled = false;
    // a cone along +y with its base at the origin
    this.head = new THREE.Mesh(new THREE.ConeGeometry(this.r * 2.6, this.r * 6, 20).translate(0, this.r * 3, 0), mat);
    this.head.matrixAutoUpdate = false;
    // a round tail closes the shaft's open start
    this.tail = new THREE.Mesh(new THREE.SphereGeometry(this.r, 12, 8), mat);
    this.group.add(this.shaft, this.head, this.tail);
  }

  public update(p: ArcPose) {
    const prog = Math.max(0, Math.min(1, p.progress ?? 1));
    const R = p.radius;
    const headLen = this.r * 6;
    const sweep = p.angle * prog;
    this.group.visible = Math.abs(sweep) * R > headLen * 0.5;
    if (!this.group.visible) return;
    // basis: u = from (⊥ axis), w = axis × u; point(φ) = c + R (u cos φ + w sin φ)
    const [ax, ay, az] = p.axis;
    const al = Math.hypot(ax, ay, az) || 1;
    const nx = ax / al, ny = ay / al, nz = az / al;
    let ux = p.from[0], uy = p.from[1], uz = p.from[2];
    const d = ux * nx + uy * ny + uz * nz;
    ux -= d * nx;
    uy -= d * ny;
    uz -= d * nz;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const wx = ny * uz - nz * uy, wy = nz * ux - nx * uz, wz = nx * uy - ny * ux;
    const sgn = Math.sign(sweep);
    // the shaft stops where the head begins
    const body = sweep - (sgn * headLen) / R;
    const [cx, cy, cz] = p.center;
    this.tail.position.set(cx + ux * R, cy + uy * R, cz + uz * R);
    const ring = SIDES + 1;
    for (let k = 0; k <= this.K; k++) {
      const phi = (body * k) / this.K;
      const c = Math.cos(phi), s = Math.sin(phi);
      const rx = ux * c + wx * s, ry = uy * c + wy * s, rz = uz * c + wz * s; // radial
      for (let j = 0; j <= SIDES; j++) {
        // the ring runs against the sweep, so the faces wind outwards for either sign
        const a = (-sgn * j * Math.PI * 2) / SIDES;
        const ca = Math.cos(a), sa = Math.sin(a);
        // ring around the arc: in the plane of radial and axis
        const ox = rx * ca + nx * sa, oy = ry * ca + ny * sa, oz = rz * ca + nz * sa;
        const v3 = (k * ring + j) * 3;
        this.pos[v3] = cx + rx * R + ox * this.r;
        this.pos[v3 + 1] = cy + ry * R + oy * this.r;
        this.pos[v3 + 2] = cz + rz * R + oz * this.r;
        this.nrm[v3] = ox;
        this.nrm[v3 + 1] = oy;
        this.nrm[v3 + 2] = oz;
      }
    }
    const pa = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const na = this.geometry.getAttribute('normal') as THREE.BufferAttribute;
    pa.needsUpdate = true;
    na.needsUpdate = true;
    // head: base at the shaft's end, pointing along the arc's tangent
    const c = Math.cos(body), s = Math.sin(body);
    const rx = ux * c + wx * s, ry = uy * c + wy * s, rz = uz * c + wz * s;
    const tx = (wx * c - ux * s) * sgn, ty = (wy * c - uy * s) * sgn, tz = (wz * c - uz * s) * sgn;
    // head axes: x = radial, y = tangent, z = x × y
    const zx = ry * tz - rz * ty, zy = rz * tx - rx * tz, zz = rx * ty - ry * tx;
    this.head.matrix.set(rx, tx, zx, cx + rx * R, ry, ty, zy, cy + ry * R, rz, tz, zz, cz + rz * R, 0, 0, 0, 1);
    this.head.matrixWorldNeedsUpdate = true;
  }
}

export interface GhostOptions {
  maxPoints: number;
  /** tube radius (m) */
  radius?: number;
  color?: string;
  /** dash period along the path (m) */
  dash?: number;
  opacity?: number;
}

export class GhostPath {
  public readonly mesh: THREE.Mesh;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly pos: Float32Array;
  private readonly nrm: Float32Array;
  private readonly arc: Float32Array;
  private readonly maxPoints: number;
  private readonly radius: number;

  public constructor(o: GhostOptions) {
    const M = (this.maxPoints = o.maxPoints);
    this.radius = o.radius ?? 0.004;
    const ring = 9;
    this.pos = new Float32Array(M * ring * 3);
    this.nrm = new Float32Array(M * ring * 3);
    this.arc = new Float32Array(M * ring);
    const idx = new Uint32Array((M - 1) * 8 * 6);
    let k = 0;
    for (let i = 0; i < M - 1; i++)
      for (let j = 0; j < 8; j++) {
        const a = i * ring + j;
        const b = a + ring;
        for (const x of [a, a + 1, b, a + 1, b + 1, b]) idx[k++] = x;
      }
    const g = this.geometry;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aArc', new THREE.BufferAttribute(this.arc, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.MeshBasicMaterial({ color: o.color ?? '#ffffff', transparent: true, opacity: o.opacity ?? 0.85, depthWrite: false });
    const dash = { value: o.dash ?? 0.03 };
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uDash = dash;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aArc;\nvarying float vArc;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvArc = aArc;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uDash;\nvarying float vArc;')
        .replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\nif (fract(vArc / uDash) > 0.58) discard;');
    };
    mat.customProgramCacheKey = () => 'ghost-dash';
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
  }

  /** a dashed tube through n points (xyz); allocates nothing */
  public update(pts: Float32Array, n: number) {
    n = Math.min(n, this.maxPoints);
    this.mesh.visible = n >= 2;
    if (n < 2) return;
    const ring = 9;
    let nx = 0, ny = 1, nz = 0;
    let s = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1) * 3, b = Math.min(n - 1, i + 1) * 3;
      let tx = pts[b] - pts[a], ty = pts[b + 1] - pts[a + 1], tz = pts[b + 2] - pts[a + 2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      if (i > 0) s += Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2], pts[i * 3 + 2] - pts[i * 3 - 1]);
      // carry the previous normal along (projected), restart from up if it degenerates
      let d = nx * tx + ny * ty + nz * tz;
      nx -= d * tx;
      ny -= d * ty;
      nz -= d * tz;
      let l = Math.hypot(nx, ny, nz);
      if (l < 1e-4) {
        nx = Math.abs(tx) < 0.9 ? 1 : 0;
        ny = Math.abs(tx) < 0.9 ? 0 : 1;
        nz = 0;
        d = nx * tx + ny * ty;
        nx -= d * tx;
        ny -= d * ty;
        nz -= d * tz;
        l = Math.hypot(nx, ny, nz);
      }
      nx /= l;
      ny /= l;
      nz /= l;
      const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
      for (let j = 0; j <= 8; j++) {
        const ang = (j / 8) * Math.PI * 2;
        const c = Math.cos(ang), sn = Math.sin(ang);
        const ox = nx * c + bx * sn, oy = ny * c + by * sn, oz = nz * c + bz * sn;
        const v = i * ring + j;
        this.pos[v * 3] = pts[i * 3] + ox * this.radius;
        this.pos[v * 3 + 1] = pts[i * 3 + 1] + oy * this.radius;
        this.pos[v * 3 + 2] = pts[i * 3 + 2] + oz * this.radius;
        this.nrm[v * 3] = ox;
        this.nrm[v * 3 + 1] = oy;
        this.nrm[v * 3 + 2] = oz;
        this.arc[v] = s;
      }
    }
    const g = this.geometry;
    g.setDrawRange(0, (n - 1) * 8 * 6);
    for (const name of ['position', 'normal', 'aArc']) {
      const att = g.getAttribute(name) as THREE.BufferAttribute;
      att.clearUpdateRanges();
      att.addUpdateRange(0, n * ring * att.itemSize);
      att.needsUpdate = true;
    }
  }
}
