// A flat band (the ribbon model of a cable in the physics stage) along simulated nodes, rebuilt in
// place every frame. Cross-section: a thin box, `width` along d1 and `thickness` along d2; the face
// on the +d2 side has the `top` colour (yellow: the stripe side), the other face `bottom`, the narrow
// edges a darker shade. Between nodes the centre line is a Catmull-Rom spline and d1 is blended and
// made perpendicular to the spline tangent (d2 = t × d1, as in the rod's right-handed frame).
// Flat-shaded across the section (each face has its own vertices), smooth along the band.

import * as THREE from 'three';

export interface RibbonOptions {
  maxNodes: number;
  /** across the band, along d1 (m) */
  width: number;
  /** along d2 (m) */
  thickness: number;
  top?: string;
  bottom?: string;
  /** rings per node segment */
  sub?: number;
}

/** corner offsets of the section in (d1, d2) units of half width and half thickness; one face per pair */
const CORNERS: [number, number][] = [
  [1, 1], [-1, 1], // top (+d2)
  [-1, 1], [-1, -1], // edge (-d1)
  [-1, -1], [1, -1], // bottom (-d2)
  [1, -1], [1, 1], // edge (+d1)
];
/** face normals in (d1, d2) */
const FACE_N: [number, number][] = [[0, 1], [-1, 0], [0, -1], [1, 0]];

export class RibbonMesh {
  public readonly mesh: THREE.Mesh;
  public readonly maxNodes: number;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly pos: Float32Array;
  private readonly nrm: Float32Array;
  private readonly sub: number;
  private readonly hw: number;
  private readonly ht: number;
  private readonly capIdx: number;

  public constructor(o: RibbonOptions) {
    this.maxNodes = o.maxNodes;
    const sub = (this.sub = o.sub ?? 3);
    this.hw = o.width / 2;
    this.ht = o.thickness / 2;
    const maxRings = (o.maxNodes - 1) * sub + 1;
    const nv = 8 + maxRings * 8; // two end caps of 4, then 8 per ring
    this.pos = new Float32Array(nv * 3);
    this.nrm = new Float32Array(nv * 3);
    const col = new Float32Array(nv * 3);
    const top = new THREE.Color(o.top ?? '#f2c200');
    const bottom = new THREE.Color(o.bottom ?? '#2a2d33');
    const edge = top.clone().lerp(bottom, 0.5).multiplyScalar(0.55);
    const faceCol = [top, edge, bottom, edge];
    for (let v = 0; v < nv; v++) {
      const c = v < 8 ? edge : faceCol[((v - 8) % 8) >> 1];
      col[v * 3] = c.r;
      col[v * 3 + 1] = c.g;
      col[v * 3 + 2] = c.b;
    }
    this.capIdx = 2 * 2 * 3;
    const idx = new Uint32Array(this.capIdx + (maxRings - 1) * 4 * 6);
    let k = 0;
    // caps: start faces -t, end faces +t (corners in CORNERS order 0, 2, 4, 6)
    for (const [a, b, c, d] of [[0, 3, 2, 1], [4, 5, 6, 7]]) {
      idx[k++] = a;
      idx[k++] = b;
      idx[k++] = c;
      idx[k++] = a;
      idx[k++] = c;
      idx[k++] = d;
    }
    for (let r = 0; r < maxRings - 1; r++)
      for (let f = 0; f < 4; f++) {
        const a = 8 + r * 8 + f * 2;
        const b = a + 8;
        idx[k++] = a;
        idx[k++] = a + 1;
        idx[k++] = b;
        idx[k++] = a + 1;
        idx[k++] = b + 1;
        idx[k++] = b;
      }
    const g = this.geometry;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const dyn = (arr: Float32Array, size: number) => new THREE.BufferAttribute(arr, size).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', dyn(this.pos, 3));
    g.setAttribute('normal', dyn(this.nrm, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0 }));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
  }

  /** pos, d1: xyz per node (d1 across the band; the top face looks along d2 = t × d1). Allocates nothing. */
  public update(pos: Float32Array, d1: Float32Array, n: number) {
    n = Math.min(n, this.maxNodes);
    this.mesh.visible = n >= 2;
    if (n < 2) return;
    const { sub, hw, ht } = this;
    const P = this.pos, Nr = this.nrm;
    const rings = (n - 1) * sub + 1;
    for (let k = 0; k < rings; k++) {
      const i = Math.min(n - 2, Math.floor(k / sub));
      const u = k / sub - i;
      const u2 = u * u, u3 = u2 * u;
      let cx = 0, cy = 0, cz = 0, tx = 0, ty = 0, tz = 0;
      for (let c = 0; c < 3; c++) {
        const p1 = pos[i * 3 + c];
        const p2 = pos[(i + 1) * 3 + c];
        const p0 = i > 0 ? pos[(i - 1) * 3 + c] : 2 * p1 - p2;
        const p3 = i + 2 < n ? pos[(i + 2) * 3 + c] : 2 * p2 - p1;
        const x = 0.5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (3 * p1 - p0 - 3 * p2 + p3) * u3);
        const t = 0.5 * (p2 - p0 + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * u + 3 * (3 * p1 - p0 - 3 * p2 + p3) * u2);
        if (c === 0) (cx = x), (tx = t);
        else if (c === 1) (cy = x), (ty = t);
        else (cz = x), (tz = t);
      }
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      // blended d1, made perpendicular to t; d2 = t × d1 (the rod's frame is right-handed)
      const i3 = i * 3, j3 = i3 + 3;
      let ax = d1[i3] + (d1[j3] - d1[i3]) * u, ay = d1[i3 + 1] + (d1[j3 + 1] - d1[i3 + 1]) * u, az = d1[i3 + 2] + (d1[j3 + 2] - d1[i3 + 2]) * u;
      const dd = ax * tx + ay * ty + az * tz;
      ax -= dd * tx;
      ay -= dd * ty;
      az -= dd * tz;
      const al = Math.hypot(ax, ay, az) || 1;
      ax /= al;
      ay /= al;
      az /= al;
      const bx = ty * az - tz * ay, by = tz * ax - tx * az, bz = tx * ay - ty * ax;
      for (let v = 0; v < 8; v++) {
        const [s1, s2] = CORNERS[v];
        const [n1, n2] = FACE_N[v >> 1];
        const o3 = (8 + k * 8 + v) * 3;
        P[o3] = cx + ax * s1 * hw + bx * s2 * ht;
        P[o3 + 1] = cy + ay * s1 * hw + by * s2 * ht;
        P[o3 + 2] = cz + az * s1 * hw + bz * s2 * ht;
        Nr[o3] = ax * n1 + bx * n2;
        Nr[o3 + 1] = ay * n1 + by * n2;
        Nr[o3 + 2] = az * n1 + bz * n2;
      }
      if (k === 0 || k === rings - 1) {
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
    g.setDrawRange(0, this.capIdx + (rings - 1) * 24);
    for (const name of ['position', 'normal']) {
      const att = g.getAttribute(name) as THREE.BufferAttribute;
      att.clearUpdateRanges();
      att.addUpdateRange(0, (8 + rings * 8) * 3);
      att.needsUpdate = true;
    }
  }
}
