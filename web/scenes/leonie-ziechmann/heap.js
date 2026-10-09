// The leaf heap around the signs' feet: the QR codes peek out only halfway. Whoever walks towards a
// sign blows the heap in front of it away, and the code comes out whole; standing in front of it
// keeps it clear. Feet and hands stirring in the heap scatter it too. With nobody there for a while
// it grows back, also from the leaves that fall onto it.
//
// The heap is a height per column (`level` 0..1 times its full shape, highest at the codes'
// middle), filled with packed leaves below its surface and loose leaves (cached pixel sprites) up
// to it. Lowering the surface uncovers leaves: those fly off as leaves of leaves.js, in front of
// everything, in the direction the person walks.

import { blit, drawLeaf, FLAT, leafSprite, ROUND, u32 } from './leafpix.js';
import { PALETTES_SIGN as PALETTES, pickColor, rng } from './forest.js';

const MAX_FLY = 28; // leaves sent flying per frame at most

export class Heap {
  constructor() {
    this.key = '';
    this.approach = new Map(); // per person: { dist, v } distance from the sensor and its smoothed change
    this.blowing = [];
  }

  layout(L, wall) {
    const S = wall.setup;
    const key = JSON.stringify([L.W, L.H, L.heap, L.signs.map((r) => [r.cx, r.bw, r.codeMid]), S.size, S.bottom]);
    if (key === this.key) return;
    this.key = key;
    const { s, H } = L;
    const R = rng(1789);
    this.s = s;
    this.kx = L.W / S.size.w;
    this.ky = L.H / S.size.h;
    this.top = S.bottom + S.size.h;
    this.x0 = Math.max(0, L.heap.x0);
    this.x1 = Math.min(L.W, L.heap.x1);
    this.bottom = L.heap.base;
    const n = this.x1 - this.x0;
    this.n = n;
    this.signs = L.signs.map((r) => ({ cx: r.cx, w: r.bw, peak: L.heap.base - r.codeMid[1], lastBlow: -99, dir: 1, str: 0 }));
    // the full heap: a mound under every sign up to the code's middle, a saddle between them
    const peak = Math.max(1, ...this.signs.map((sg) => sg.peak));
    this.shape = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = this.x0 + i;
      let h = 0;
      for (const sg of this.signs) {
        const u = Math.abs(x - sg.cx) / (sg.w * 0.78);
        h = Math.max(h, sg.peak * Math.exp(-(u ** 3)));
      }
      const edge = Math.min(1, (x - this.x0) / (40 * s), (this.x1 - x) / (14 * s));
      const e = Math.max(0, edge);
      h *= e * e * (3 - 2 * e);
      h += (Math.sin(x * 0.21) * 2 + Math.sin(x * 0.07 + 1) * 3) * s * Math.min(1, h / (20 * s));
      this.shape[i] = Math.max(0, h);
    }
    this.level = new Float32Array(n).fill(1);
    this.lastBlow = new Float32Array(n).fill(-99);
    // packed leaves below the surface: an opaque base, densely covered with leaves
    const fh = Math.ceil(peak + 14 * s);
    this.fillH = fh;
    this.fill = new Uint32Array(n * fh);
    // the base gets darker towards the bottom (the heap's volume), leaves packed on top of it
    const shades = ['#f2c25a', '#eab04a', '#e0a043', '#d5923d'].map((h) => u32(h, 253));
    for (let y = 0; y < fh; y++) {
      const t = y / fh;
      for (let x = 0; x < n; x++) {
        const d = t * 3 + (((x * 7 + y * 13) % 4) / 4 - 0.4) * 0.6;
        this.fill[y * n + x] = shades[Math.max(0, Math.min(3, Math.floor(d)))];
      }
    }
    const dense = Math.round((n * fh) / (34 * s * s));
    for (let i = 0; i < dense; i++) {
      const y = R() * fh;
      // fewer reds and oranges deep inside
      let c = pickColor(R);
      if (c >= 4 && R() < y / fh) c = 0;
      drawLeaf(this.fill, n, fh, R() * n, y, (10 + R() * 4) * s, R() * 6.28, (R() < 0.5 ? -1 : 1) * (0.6 + R() * 0.4), PALETTES[c], ROUND | FLAT);
    }
    // loose leaves up to the surface, bottom first (the top ones are drawn last)
    const area = this.shape.reduce((a, b) => a + b, 0);
    const count = Math.round(area / (40 * s * s));
    this.leaves = [];
    for (let k = 0; k < count * 4 && this.leaves.length < count; k++) {
      const i = Math.floor(R() * n);
      const h = R() * peak;
      if (h > this.shape[i] - 2 * s) continue;
      const c = pickColor(R);
      const size = (10 + R() * 4.5) * s;
      const rot = R() * 6.28;
      const flip = (R() < 0.5 ? -1 : 1) * (0.55 + R() * 0.45);
      this.leaves.push({ i, h, c, size, rot, flip, spr: leafSprite(size, rot, flip, PALETTES[c], ROUND | FLAT), on: true });
    }
    this.leaves.sort((a, b) => a.h - b.h);
  }

  /** The heap's surface at LED column px (height above the bottom, px), or 0 outside it. */
  heightAt(px) {
    const i = Math.round(px - this.x0);
    if (!this.level || i < 0 || i >= this.n) return 0;
    return this.level[i] * this.shape[i];
  }

  /** a leaf landed on the heap at column px: it grows a little there */
  feed(px) {
    const i0 = Math.round(px - this.x0);
    for (let d = -6; d <= 6; d++) {
      const i = i0 + d;
      if (i >= 0 && i < this.n) this.level[i] = Math.min(1, this.level[i] + 0.01 * (1 - Math.abs(d) / 7));
    }
  }

  /**
   * places: the people on the wall (wall.persons in the zone), leaves: the Leaves to send the
   * uncovered ones flying, field: the bodies (kicks), p: params (heap, blow, regrow).
   */
  update(ctx, p, places, leaves, field) {
    if (!this.level) return;
    const t = ctx.time;
    const dt = Math.min(0.05, ctx.dt);
    const R = Math.random;
    const mx = (px) => px / this.kx;
    if (!p.heap) {
      this.level.fill(0);
      for (const q of this.leaves) q.on = false;
      return;
    }

    // how hard each sign gets blown: walking towards it, standing in front of it, stepping closer
    const seen = new Set();
    for (const sg of this.signs) {
      const cx = mx(sg.cx);
      let str = 0;
      let push = 0;
      for (const pl of places) {
        const dx = cx - pl.x;
        const ad = Math.abs(dx);
        if (ad > 3.2) continue;
        const close = 1 - ad / 3.2;
        const toward = pl.vx * Math.sign(dx || 1);
        const walk = Math.max(0, toward - 0.2) * close * 2.2;
        const stand = Math.max(0, 1 - ad / 0.7) * 0.45 * (pl.dist < 3 ? 1 : 0.4);
        const ap = this.approach.get(pl.id);
        const closer = ap ? Math.max(0, ap.v - 0.25) * Math.max(0, 1 - ad / 1.2) * 1.5 : 0;
        str += walk + stand + closer;
        push += (walk + closer) * Math.sign(dx || 1) + stand * 0.2 * Math.sign(dx || 1);
      }
      // feet and hands stirring in the heap
      if (field && field.w) {
        const half = sg.w * 0.6;
        const c0 = Math.max(0, Math.floor(mx(sg.cx - half) / field.cell));
        const c1 = Math.min(field.w - 1, Math.floor(mx(sg.cx + half) / field.cell));
        const hTop = this.heightAt(sg.cx) / this.ky + 0.05;
        const r0 = Math.max(0, Math.floor((this.top - hTop) / field.cell));
        let k = 0;
        for (let cy = r0; cy < field.h; cy += 2) for (let cx2 = c0; cx2 <= c1; cx2 += 2) k += Math.abs(field.kx[cy * field.w + cx2]);
        str += Math.min(0.6, k * 0.004);
      }
      sg.str = str * p.blow;
      if (Math.abs(push) > 0.05) sg.dir = Math.sign(push);
      if (sg.str > 0.05) sg.lastBlow = t;
    }
    // stepping closer to the wall: the change of the distance, smoothed over about half a second
    for (const pl of places) {
      seen.add(pl.id);
      const ap = this.approach.get(pl.id);
      if (!ap) this.approach.set(pl.id, { dist: pl.dist, v: 0 });
      else {
        const a = 1 - Math.exp(-dt / 0.45);
        ap.v += ((ap.dist - pl.dist) / Math.max(dt, 1e-3) - ap.v) * a;
        ap.dist = pl.dist;
      }
    }
    for (const id of this.approach.keys()) if (!seen.has(id)) this.approach.delete(id);

    // the surface: blown down around a sign, grows back where nothing blew for a while
    const before = this.level.slice();
    for (let i = 0; i < this.n; i++) {
      const x = this.x0 + i;
      let down = 0;
      for (const sg of this.signs) {
        if (sg.str <= 0.05) continue;
        const u = (x - sg.cx) / (sg.w * 0.55);
        const f = Math.exp(-u * u);
        down += sg.str * f;
        if (f > 0.3) this.lastBlow[i] = t;
      }
      if (down > 0) this.level[i] = Math.max(0, this.level[i] - down * 1.3 * dt);
      else if (t - this.lastBlow[i] > p.regrowDelay) this.level[i] = Math.min(1, this.level[i] + dt / Math.max(1, p.regrow));
    }

    // uncovered leaves fly off (the top ones first: they are the last in the list)
    let flying = 0;
    for (let k = this.leaves.length - 1; k >= 0; k--) {
      const q = this.leaves[k];
      const lim = this.level[q.i] * this.shape[q.i];
      if (q.on && q.h > lim + 1) {
        q.on = false;
        if (before[q.i] * this.shape[q.i] >= q.h && flying < MAX_FLY) {
          flying++;
          const sg = this.nearest(this.x0 + q.i);
          const px = this.x0 + q.i;
          const py = this.bottom - q.h;
          const kick = Math.min(3, 0.8 + sg.str);
          leaves.spawnFree(mx(px), this.top - py / this.ky, sg.dir * kick * (0.6 + R() * 0.9) + (R() - 0.5) * 0.5, 0.5 + R() * 1.3 * Math.min(1.5, kick), q.c, q.size, false);
        }
      } else if (!q.on && q.h <= lim - 1) q.on = true;
    }
  }

  nearest(px) {
    let best = this.signs[0];
    for (const sg of this.signs) if (Math.abs(sg.cx - px) < Math.abs(best.cx - px)) best = sg;
    return best;
  }

  /** the share of the codes covered (0..1), for the status line */
  get cover() {
    if (!this.level) return 0;
    let sum = 0;
    for (const sg of this.signs) sum += this.level[Math.round(sg.cx - this.x0)] ?? 0;
    return sum / Math.max(1, this.signs.length);
  }

  /** Draws the heap into buf: the packed leaves below the surface, the loose ones up to it. */
  draw(buf, W, H) {
    if (!this.level) return;
    const inset = Math.round(5 * this.s);
    const { n, fillH, fill } = this;
    for (let i = 0; i < n; i++) {
      const h = this.level[i] * this.shape[i] - inset;
      if (h <= 0) continue;
      const x = this.x0 + i;
      const y0 = Math.max(0, Math.round(this.bottom - h));
      // down to a little below the base (the nearer hills cover the rest)
      for (let y = y0; y < Math.min(H, this.bottom + 10 * this.s); y++) {
        const fy = Math.min(fillH - 1, fillH - (this.bottom - y));
        if (fy >= 0) buf[y * W + x] = fill[fy * n + i];
      }
    }
    for (const q of this.leaves) if (q.on) blit(buf, W, H, this.x0 + q.i, this.bottom - q.h, q.spr);
  }
}
