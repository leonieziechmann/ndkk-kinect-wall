// Draws the body meshes on the 3D stage: a small software rasterizer with a depth buffer (so arms in
// front of the body, hair around the head and touching parts look right), at twice the resolution
// for smooth edges. First every pixel learns which triangle it shows and where on it, then each
// visible pixel is shaded once.

import type { Camera } from '../camera';
import { RGB } from '../math';
import { Mesh } from './mesh';

export interface Look {
  /** color per material (MAT) */
  mats: RGB[];
  /** light: from where (unit vector, world), how strong; plus light from all around */
  light: [number, number, number];
  key: number;
  ambient: number;
  /** a rim along the outline, in this color */
  rim: RGB;
  rimK: number;
  /** mixed over everything (the infrared pulse), 0..1 */
  tint: RGB;
  tintK: number;
  alpha: number;
}

interface Entry {
  mesh: Mesh;
  look: Look;
}

export class FigureRaster {
  canvas = document.createElement('canvas');
  private g = this.canvas.getContext('2d') as CanvasRenderingContext2D;
  private img: ImageData | null = null;
  private px = new Uint32Array(0);
  private zb = new Float32Array(0);
  private id = new Int32Array(0);
  private b0 = new Float32Array(0);
  private b1 = new Float32Array(0);
  private sx = new Float32Array(0);
  private sy = new Float32Array(0);
  private iz = new Float32Array(0);
  private list: Entry[] = [];
  w = 0;
  h = 0;
  /** screen rectangle (stage px) that the buffer covers, and buffer px per stage px */
  x0 = 0;
  y0 = 0;
  k = 1;

  begin(x0: number, y0: number, x1: number, y1: number, k: number) {
    const w = Math.max(1, Math.ceil((x1 - x0) * k));
    const h = Math.max(1, Math.ceil((y1 - y0) * k));
    this.x0 = x0;
    this.y0 = y0;
    this.k = k;
    if (w !== this.w || h !== this.h || !this.img) {
      this.w = w;
      this.h = h;
      this.canvas.width = w;
      this.canvas.height = h;
      this.img = this.g.createImageData(w, h);
      this.px = new Uint32Array(this.img.data.buffer);
      this.zb = new Float32Array(w * h);
      this.id = new Int32Array(w * h);
      this.b0 = new Float32Array(w * h);
      this.b1 = new Float32Array(w * h);
    }
    this.px.fill(0);
    this.zb.fill(0);
    this.id.fill(-1);
    this.list = [];
  }

  /** rasterize a mesh (visibility only; shading happens in end) */
  add(mesh: Mesh, cam: Camera, look: Look) {
    const mi = this.list.length;
    this.list.push({ mesh, look });
    const n = mesh.vertexCount;
    if (this.sx.length < n) {
      this.sx = new Float32Array(n * 2);
      this.sy = new Float32Array(n * 2);
      this.iz = new Float32Array(n * 2);
    }
    const P = mesh.pos;
    const { eye, r, u, f, focal } = cam;
    const k = this.k;
    const ox = (cam.sx - this.x0) * k;
    const oy = (cam.sy - this.y0) * k;
    const fk = focal * k;
    for (let i = 0; i < n; i++) {
      const dx = P[i * 3] - eye[0];
      const dy = P[i * 3 + 1] - eye[1];
      const dz = P[i * 3 + 2] - eye[2];
      const vz = dx * f[0] + dy * f[1] + dz * f[2];
      if (vz < cam.near) {
        this.iz[i] = -1;
        continue;
      }
      const vx = dx * r[0] + dy * r[1] + dz * r[2];
      const vy = dx * u[0] + dy * u[1] + dz * u[2];
      this.sx[i] = (vx * fk) / vz + ox;
      this.sy[i] = (-vy * fk) / vz + oy;
      this.iz[i] = 1 / vz;
    }
    const T = mesh.tri;
    const W = this.w;
    const H = this.h;
    const zb = this.zb;
    const ids = this.id;
    const B0 = this.b0;
    const B1 = this.b1;
    for (let t = 0; t < T.length; t += 3) {
      const a = T[t];
      const b = T[t + 1];
      const c = T[t + 2];
      const w0 = this.iz[a];
      const w1 = this.iz[b];
      const w2 = this.iz[c];
      if (w0 <= 0 || w1 <= 0 || w2 <= 0) continue;
      const x0 = this.sx[a];
      const y0 = this.sy[a];
      const x1 = this.sx[b];
      const y1 = this.sy[b];
      const x2 = this.sx[c];
      const y2 = this.sy[c];
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (Math.abs(area) < 1e-9) continue;
      const inv = 1 / area;
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
      if (minX > maxX || minY > maxY) continue;
      const code = (mi << 22) | (t / 3);
      for (let py = minY; py <= maxY; py++) {
        const cy = py + 0.5;
        // the weights are linear in x: start value and step per pixel
        const cx0 = minX + 0.5;
        let e0 = ((x1 - cx0) * (y2 - cy) - (x2 - cx0) * (y1 - cy)) * inv;
        let e1 = ((x2 - cx0) * (y0 - cy) - (x0 - cx0) * (y2 - cy)) * inv;
        const d0 = (y1 - y2) * inv;
        const d1 = (y2 - y0) * inv;
        let i = py * W + minX;
        for (let px = minX; px <= maxX; px++, i++, e0 += d0, e1 += d1) {
          const e2 = 1 - e0 - e1;
          if (e0 < 0 || e1 < 0 || e2 < 0) continue;
          const z = e0 * w0 + e1 * w1 + e2 * w2;
          if (z <= zb[i]) continue;
          zb[i] = z;
          ids[i] = code;
          B0[i] = (e0 * w0) / z;
          B1[i] = (e1 * w1) / z;
        }
      }
    }
  }

  /** shade the visible pixels; returns the canvas (draw it over the screen rectangle) */
  end(cam: Camera) {
    const W = this.w;
    const H = this.h;
    const k = this.k;
    const { r, u, f, focal } = cam;
    const ids = this.id;
    const px = this.px;
    // per mesh: smooth or flat normals
    const normals = this.list.map((e) => (e.mesh.flat ? e.mesh.faceNormals() : e.mesh.normals()));
    for (let py = 0; py < H; py++) {
      // view ray of the pixel (world), for the rim
      const vy = -((py + 0.5) / k + this.y0 - cam.sy) / focal;
      for (let pxi = 0; pxi < W; pxi++) {
        const i = py * W + pxi;
        const code = ids[i];
        if (code < 0) continue;
        const e = this.list[code >> 22];
        const t = code & 0x3fffff;
        const m = e.mesh;
        const look = e.look;
        const N = normals[code >> 22];
        let nx: number;
        let ny: number;
        let nz: number;
        if (m.flat) {
          nx = N[t * 3];
          ny = N[t * 3 + 1];
          nz = N[t * 3 + 2];
        } else {
          const a = m.tri[t * 3] * 3;
          const b = m.tri[t * 3 + 1] * 3;
          const c = m.tri[t * 3 + 2] * 3;
          const l0 = this.b0[i];
          const l1 = this.b1[i];
          const l2 = 1 - l0 - l1;
          nx = N[a] * l0 + N[b] * l1 + N[c] * l2;
          ny = N[a + 1] * l0 + N[b + 1] * l1 + N[c + 1] * l2;
          nz = N[a + 2] * l0 + N[b + 2] * l1 + N[c + 2] * l2;
          const l = Math.hypot(nx, ny, nz) || 1;
          nx /= l;
          ny /= l;
          nz /= l;
        }
        const vx = ((pxi + 0.5) / k + this.x0 - cam.sx) / focal;
        let dx = r[0] * vx + u[0] * vy + f[0];
        let dy = r[1] * vx + u[1] * vy + f[1];
        let dz = r[2] * vx + u[2] * vy + f[2];
        const dl = Math.hypot(dx, dy, dz);
        dx /= dl;
        dy /= dl;
        dz /= dl;
        let facing = -(nx * dx + ny * dy + nz * dz);
        if (facing < 0) {
          // a face seen from behind (should not happen on closed parts): light it like its front
          nx = -nx;
          ny = -ny;
          nz = -nz;
          facing = -facing;
        }
        const L = look.light;
        const diff = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
        // light from all around: more from above, some bounced back from the floor
        const hemi = 0.72 + 0.28 * ny;
        const lit = look.ambient * hemi + look.key * diff;
        const rim = (1 - facing) ** 3 * look.rimK;
        const col = look.mats[m.mat[t]];
        let cr = col[0] * lit + look.rim[0] * rim;
        let cg = col[1] * lit + look.rim[1] * rim;
        let cb = col[2] * lit + look.rim[2] * rim;
        if (look.tintK > 0) {
          cr += (look.tint[0] - cr) * look.tintK;
          cg += (look.tint[1] - cg) * look.tintK;
          cb += (look.tint[2] - cb) * look.tintK;
        }
        const al = look.alpha;
        px[i] =
          ((Math.min(255, al * 255) & 255) << 24) |
          ((Math.min(255, Math.max(0, cb) * 255) & 255) << 16) |
          ((Math.min(255, Math.max(0, cg) * 255) & 255) << 8) |
          (Math.min(255, Math.max(0, cr) * 255) & 255);
      }
    }
    if (this.img) this.g.putImageData(this.img, 0, 0);
    return this.canvas;
  }
}
