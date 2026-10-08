// persons-flow.js — sparse optical flow on the infrared image (pyramidal Lucas–Kanade): moves the
// keypoints of the persons from frame to frame, so the skeletons follow the bodies at the full frame
// rate although the pose model only runs every few frames. Plain JavaScript without DOM (used by
// persons-core.js).
//
//   const flow = new FlowTracker(512, 424);
//   flow.push(seq, irU8);                             // every frame
//   flow.track(fromSeq, toSeq, pts, n, use, lost);    // moves n points (u, v pairs)
//
// A point is lost in a step where the image has no texture to follow, or where tracking it back
// does not lead to where it started (occlusion, motion blur); it then moves with the others.

const EPS = 0.01; // px: stop iterating below this step

export class FlowTracker {
  constructor(width, height, { levels = 3, radius = 5, iterations = 8, history = 10, minTexture = 30, maxError = 1.5, relaxTexture = minTexture, relaxError = maxError } = {}) {
    this.w = width;
    this.h = height;
    this.levels = levels;
    this.r = radius;
    this.iterations = iterations;
    this.history = history;
    this.minTexture = minTexture; // smallest eigenvalue of the gradient matrix per window pixel
    this.maxError = maxError; // px: forward-backward error
    this.relaxTexture = relaxTexture; // the same for the points marked in track()'s `relax`
    this.relaxError = relaxError;
    this.frames = []; // oldest first: { seq, pyr: [{ w, h, data }] }
    const n = (2 * radius + 1) ** 2;
    this.wa = new Float32Array(n); // window: template values and gradients
    this.wx = new Float32Array(n);
    this.wy = new Float32Array(n);
    this.out = new Float32Array(2);
  }

  /** The infrared image (Uint8Array) of frame `seq`; the oldest frame is dropped. */
  push(seq, ir) {
    let f = this.frames.length >= this.history ? this.frames.shift() : null;
    if (!f) {
      f = { seq, pyr: [] };
      let w = this.w;
      let h = this.h;
      for (let l = 0; l < this.levels; l++) {
        f.pyr.push({ w, h, data: new Float32Array(w * h) });
        w >>= 1;
        h >>= 1;
      }
    }
    f.seq = seq;
    const L0 = f.pyr[0].data;
    for (let i = 0; i < L0.length; i++) L0[i] = ir[i];
    for (let l = 1; l < this.levels; l++) {
      const a = f.pyr[l - 1];
      const b = f.pyr[l];
      for (let y = 0; y < b.h; y++) {
        for (let x = 0; x < b.w; x++) {
          const i = 2 * y * a.w + 2 * x;
          b.data[y * b.w + x] = 0.25 * (a.data[i] + a.data[i + 1] + a.data[i + a.w] + a.data[i + a.w + 1]);
        }
      }
    }
    this.frames.push(f);
  }

  has(seq) {
    return this.frames.some((f) => f.seq === seq);
  }

  /**
   * Moves n points (pts: u, v pairs in pixels of frame `from`) to frame `to`, through all frames
   * kept in between (backwards if `to` is older). Only points with use[k] = 1 move. A point that
   * cannot be followed in a step moves like the median of the others (or not at all) and is tried
   * again in the next step; lost[k] counts such steps in a row. False if a frame is not kept
   * (nothing moved). check = false skips tracking back (twice as fast, for rough predictions).
   */
  track(from, to, pts, n, use, lost, check = true, relax = null) {
    if (from === to) return true;
    let a = -1;
    let b = -1;
    for (let k = 0; k < this.frames.length; k++) {
      if (this.frames[k].seq === from) a = k;
      if (this.frames[k].seq === to) b = k;
    }
    if (a < 0 || b < 0) return false;
    const out = this.out;
    const dir = b > a ? 1 : -1;
    const ok = (this.okScratch ??= new Uint8Array(64));
    const dx = (this.dxScratch ??= new Float32Array(64));
    const dy = (this.dyScratch ??= new Float32Array(64));
    for (let k = a; k !== b; k += dir) {
      const I = this.frames[k].pyr;
      const J = this.frames[k + dir].pyr;
      let m = 0;
      for (let p = 0; p < n; p++) {
        ok[p] = 0;
        if (!use[p]) continue;
        const x = pts[2 * p];
        const y = pts[2 * p + 1];
        const tex = relax && relax[p] ? this.relaxTexture : this.minTexture;
        const err = relax && relax[p] ? this.relaxError : this.maxError;
        if (!this._lk(I, J, x, y, tex)) continue;
        const nx = out[0];
        const ny = out[1];
        // and back: it must come out where it started
        if (check && (!this._lk(J, I, nx, ny, tex) || (out[0] - x) ** 2 + (out[1] - y) ** 2 > err ** 2)) continue;
        ok[p] = 1;
        lost[p] = 0;
        dx[m] = nx - x;
        dy[m] = ny - y;
        m++;
        pts[2 * p] = nx;
        pts[2 * p + 1] = ny;
      }
      const mx = m ? median(dx, m) : 0;
      const my = m ? median(dy, m) : 0;
      for (let p = 0; p < n; p++) {
        if (!use[p] || ok[p]) continue;
        pts[2 * p] += mx;
        pts[2 * p + 1] += my;
        lost[p]++;
      }
    }
    return true;
  }

  /** One point from pyramid I to J (coarse to fine); the result in this.out, false if lost. */
  _lk(I, J, x, y, minTexture = this.minTexture) {
    const r = this.r;
    const wa = this.wa;
    const wx = this.wx;
    const wy = this.wy;
    const area = (2 * r + 1) ** 2;
    let gx = 0;
    let gy = 0;
    for (let l = this.levels - 1; l >= 0; l--) {
      const A = I[l];
      const B = J[l];
      const s = 1 / (1 << l);
      const px = (x + 0.5) * s - 0.5;
      const py = (y + 0.5) * s - 0.5;
      // template and its gradients
      let gxx = 0;
      let gxy = 0;
      let gyy = 0;
      let k = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++, k++) {
          const ax = px + dx;
          const ay = py + dy;
          const ix = 0.5 * (sample(A, ax + 1, ay) - sample(A, ax - 1, ay));
          const iy = 0.5 * (sample(A, ax, ay + 1) - sample(A, ax, ay - 1));
          wa[k] = sample(A, ax, ay);
          wx[k] = ix;
          wy[k] = iy;
          gxx += ix * ix;
          gxy += ix * iy;
          gyy += iy * iy;
        }
      }
      const det = gxx * gyy - gxy * gxy;
      const minEig = (gxx + gyy - Math.sqrt((gxx - gyy) ** 2 + 4 * gxy * gxy)) / 2;
      if (minEig < minTexture * area || det <= 0) {
        if (l === 0) return false; // nothing to follow here
        gx *= 2;
        gy *= 2;
        continue;
      }
      let vx = 0;
      let vy = 0;
      for (let it = 0; it < this.iterations; it++) {
        let bx = 0;
        let by = 0;
        k = 0;
        const ox = px + gx + vx;
        const oy = py + gy + vy;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++, k++) {
            const diff = wa[k] - sample(B, ox + dx, oy + dy);
            bx += diff * wx[k];
            by += diff * wy[k];
          }
        }
        const sx = (gyy * bx - gxy * by) / det;
        const sy = (gxx * by - gxy * bx) / det;
        vx += sx;
        vy += sy;
        if (sx * sx + sy * sy < EPS * EPS) break;
      }
      if (l > 0) {
        gx = 2 * (gx + vx);
        gy = 2 * (gy + vy);
      } else {
        gx += vx;
        gy += vy;
      }
    }
    const nx = x + gx;
    const ny = y + gy;
    if (!(nx >= 0 && ny >= 0 && nx <= this.w - 1 && ny <= this.h - 1)) return false;
    this.out[0] = nx;
    this.out[1] = ny;
    return true;
  }
}

function median(a, n) {
  const s = Array.from(a.subarray(0, n)).sort((x, y) => x - y);
  return n & 1 ? s[n >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

/** Bilinear sample of a pyramid level, clamped to the border. */
function sample(L, x, y) {
  const w = L.w;
  const h = L.h;
  if (x < 0) x = 0;
  else if (x > w - 1.001) x = w - 1.001;
  if (y < 0) y = 0;
  else if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const d = L.data;
  const i = y0 * w + x0;
  const top = d[i] + fx * (d[i + 1] - d[i]);
  const bottom = d[i + w] + fx * (d[i + w + 1] - d[i + w]);
  return top + fy * (bottom - top);
}
