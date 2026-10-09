// The people on the wall as a grid of cells (wall meters): every person pixel is mapped onto the
// wall like the shared wall core does it (mirror, the walk stretched over the wall, per-person shift;
// see WALL.md and blasen-platzen/grid.js). A chamfer distance transform gives every cell its distance
// to the nearest body edge (> 0 outside, < 0 inside).
//
// Motion: an outline that moved since the last result covers cells that were more than a cell or two
// away from the bodies before. Those cells get a kick along the outline's normal (the direction it
// moved), spread over a few cells and fading over a few results. Standing still kicks nothing: the
// single-cell flicker of a still outline stays under the threshold.

const EMPTY = 1e9;
const SQRT2 = Math.SQRT2;

export class BodyField {
  constructor(cell = 0.03) {
    this.cell = cell;
    this.w = 0;
    this.h = 0;
    this.key = '';
    this.covered = 0;
  }

  _ensure(wallW, wallH) {
    const key = `${wallW}x${wallH}`;
    if (key === this.key) return;
    this.key = key;
    this.w = Math.max(8, Math.round(wallW / this.cell));
    this.h = Math.max(8, Math.round(wallH / this.cell));
    const n = this.w * this.h;
    this.occ = new Uint8Array(n);
    this.tmp = new Uint8Array(n);
    this.dOut = new Float32Array(n);
    this.prevOut = new Float32Array(n).fill(EMPTY); // dOut of the last result
    this.dIn = new Float32Array(n);
    this.sd = new Float32Array(n).fill(10); // m, far outside
    this.kx = new Float32Array(n); // kick (cells moved, along the outline's normal; y up)
    this.ky = new Float32Array(n);
    this.bx = new Float32Array(n); // fresh kicks, then blur scratch
    this.by = new Float32Array(n);
    this.tx = new Float32Array(n);
    this.ty = new Float32Array(n);
    this.hadBodies = false;
  }

  /**
   * Rebuilds the field from one person tracking result. `extra`: discs [{ x, y, r }] in wall m
   * (the mouse, for testing without people).
   */
  update(persons, rays, xSign, wall, extra = []) {
    const S = wall.setup;
    this._ensure(S.size.w, S.size.h);
    const { w, h, occ, tmp } = this;
    const inv = 1 / this.cell;
    const top = S.bottom + S.size.h;
    occ.fill(0);

    if (persons?.indices?.length) {
      const m = wall.room.matrix;
      const side = wall.side;
      const perPerson = S.map.apply === 'person';
      const center = S.size.w / 2 + S.sensor.x;
      const { near, far } = S.zone;
      const { lift, scaleY } = S.map;
      const { indices, labels, depth } = persons;
      const stride = Math.max(1, Math.floor(indices.length / 16000));
      for (let k = 0; k < indices.length; k += stride) {
        const i = indices[k];
        const mm = depth[i];
        if (mm < 100) continue;
        const z = mm * 0.001;
        const wx = xSign * rays[2 * i] * z;
        const wy = -rays[2 * i + 1] * z;
        const rz = m[2] * wx + m[6] * wy + m[10] * z + m[14];
        if (rz < near || rz > far) continue;
        const rx = m[0] * wx + m[4] * wy + m[8] * z + m[12];
        const ry = m[1] * wx + m[5] * wy + m[9] * z + m[13];
        const s = labels[i];
        const lat = side * rx;
        const x = perPerson && wall.visible[s] ? center + lat + wall.shift[s] : center + lat * wall.k(lat, rz);
        const gx = Math.floor(x * inv);
        const gy = Math.floor((top - lift - scaleY * ry) * inv);
        if (gx >= 0 && gx < w && gy >= 0 && gy < h) occ[gy * w + gx] = 1;
      }
    }
    for (const d of extra) {
      const cx = d.x * inv;
      const cy = (top - d.y) * inv;
      const r = d.r * inv;
      for (let gy = Math.max(0, Math.floor(cy - r)); gy <= Math.min(h - 1, Math.ceil(cy + r)); gy++) {
        for (let gx = Math.max(0, Math.floor(cx - r)); gx <= Math.min(w - 1, Math.ceil(cx + r)); gx++) {
          if ((gx + 0.5 - cx) ** 2 + (gy + 0.5 - cy) ** 2 <= r * r) occ[gy * w + gx] = 1;
        }
      }
    }

    // close holes between sampled pixels, drop single specks
    tmp.set(occ);
    let covered = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const c = y * w + x;
        const n = tmp[c - w - 1] + tmp[c - w] + tmp[c - w + 1] + tmp[c - 1] + tmp[c + 1] + tmp[c + w - 1] + tmp[c + w] + tmp[c + w + 1];
        if (!tmp[c] && n >= 5) occ[c] = 1;
        else if (tmp[c] && n === 0) occ[c] = 0;
        covered += occ[c];
      }
    }
    this.covered = covered * this.cell * this.cell;

    const keep = this.prevOut;
    this.prevOut = this.dOut;
    this.dOut = keep;
    this._chamfer(this.dOut, 1);
    this._chamfer(this.dIn, 0);
    const { sd, dOut, dIn } = this;
    for (let c = 0; c < sd.length; c++) sd[c] = (occ[c] ? 0.5 - dIn[c] : dOut[c] - 0.5) * this.cell;
    this._kicks(covered > 0 && this.hadBodies);
    this.hadBodies = covered > 0;
  }

  // newly covered cells near the outline -> kick along the outward normal, blurred, fading
  _kicks(compare) {
    const { w, h, occ, dIn, prevOut, sd, kx, ky, bx, by, tx, ty } = this;
    const fade = 0.45;
    for (let c = 0; c < kx.length; c++) {
      bx[c] = 0;
      by[c] = 0;
    }
    let moving = 0;
    if (compare) {
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const c = y * w + x;
          if (!occ[c] || dIn[c] > 3) continue; // only the outline's band: a new body is no kick
          const moved = Math.min(3, prevOut[c] - 1.5);
          if (moved <= 0) continue;
          const gx = sd[c + 1] - sd[c - 1];
          const gy = sd[c - w] - sd[c + w]; // y up
          const gl = Math.hypot(gx, gy);
          if (gl < 1e-6) continue;
          bx[c] = (gx / gl) * moved;
          by[c] = (gy / gl) * moved;
          moving++;
        }
      }
    }
    this.moving = moving;
    // spread over +-3 cells (box blur, rows then columns), add to the fading kicks
    const R = 3;
    for (const [src, dst] of [
      [bx, tx],
      [by, ty],
    ]) {
      for (let y = 0; y < h; y++) {
        let acc = 0;
        const row = y * w;
        for (let x = -R; x < w; x++) {
          if (x + R < w) acc += src[row + x + R];
          if (x - R - 1 >= 0) acc -= src[row + x - R - 1];
          if (x >= 0) dst[row + x] = acc;
        }
      }
    }
    const norm = 1 / (2 * R + 1);
    for (let x = 0; x < w; x++) {
      let ax = 0;
      let ay = 0;
      for (let y = -R; y < h; y++) {
        if (y + R < h) {
          ax += tx[(y + R) * w + x];
          ay += ty[(y + R) * w + x];
        }
        if (y - R - 1 >= 0) {
          ax -= tx[(y - R - 1) * w + x];
          ay -= ty[(y - R - 1) * w + x];
        }
        if (y >= 0) {
          const c = y * w + x;
          kx[c] = kx[c] * fade + ax * norm;
          ky[c] = ky[c] * fade + ay * norm;
        }
      }
    }
    this.seq = (this.seq ?? 0) + 1;
  }

  /** Nobody there: everything far outside, no kicks. */
  clear() {
    if (!this.w) return;
    this.sd.fill(10);
    this.occ.fill(0);
    this.kx.fill(0);
    this.ky.fill(0);
    this.prevOut.fill(EMPTY);
    this.covered = 0;
    this.moving = 0;
    this.hadBodies = false;
  }

  /** The cell at wall point (x, y): index or -1. */
  cellAt(x, y, top) {
    const gx = Math.floor(x / this.cell);
    const gy = Math.floor((top - y) / this.cell);
    return gx >= 0 && gx < this.w && gy >= 0 && gy < this.h ? gy * this.w + gx : -1;
  }

  // distance (cells) of every cell to the nearest cell with occ === target: to the nearest body cell
  // (target 1) or the nearest free cell (target 0); two-pass chamfer 1 / sqrt 2
  _chamfer(d, target) {
    const { w, h, occ } = this;
    for (let c = 0; c < d.length; c++) d[c] = occ[c] === target ? 0 : EMPTY;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = y * w + x;
        let v = d[c];
        if (v === 0) continue;
        if (x > 0) v = Math.min(v, d[c - 1] + 1);
        if (y > 0) {
          v = Math.min(v, d[c - w] + 1);
          if (x > 0) v = Math.min(v, d[c - w - 1] + SQRT2);
          if (x < w - 1) v = Math.min(v, d[c - w + 1] + SQRT2);
        }
        d[c] = v;
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const c = y * w + x;
        let v = d[c];
        if (v === 0) continue;
        if (x < w - 1) v = Math.min(v, d[c + 1] + 1);
        if (y < h - 1) {
          v = Math.min(v, d[c + w] + 1);
          if (x < w - 1) v = Math.min(v, d[c + w + 1] + SQRT2);
          if (x > 0) v = Math.min(v, d[c + w - 1] + SQRT2);
        }
        d[c] = v;
      }
    }
  }

  /**
   * Signed distance (m) at wall point (x, y), bilinear, and its gradient (pointing out of the
   * bodies) in out[1], out[2] (per m, y up). out[0] = distance.
   */
  sample(x, y, top, out) {
    const { w, h, sd } = this;
    if (!w) {
      out[0] = 10;
      out[1] = out[2] = 0;
      return out;
    }
    const fx = Math.min(w - 1.001, Math.max(0, x / this.cell - 0.5));
    const fy = Math.min(h - 1.001, Math.max(0, (top - y) / this.cell - 0.5));
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const c = iy * w + ix;
    const a = sd[c];
    const b = sd[c + 1];
    const d = sd[c + w];
    const e = sd[c + w + 1];
    out[0] = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
    // gradient: x right, y up (rows go down)
    out[1] = ((b - a) * (1 - ty) + (e - d) * ty) / this.cell;
    out[2] = -((d - a) * (1 - tx) + (e - b) * tx) / this.cell;
    return out;
  }
}
