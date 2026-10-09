// The autumn leaves, simulated in wall meters (x from the left edge, y above the floor) and drawn as
// pixel leaves on the LED image (leafpix.js).
//
// Leaves come loose from the crowns (forest.js `spots`): a few all the time, many where something
// moves up there (arms reaching into the crowns, a jump: kicks of the body field, field.js), and
// where a gust runs through. In the air they sway and turn, the wind carries them, and a moving
// outline sweeps them along. They come to rest on the forest floor, on the top edges of the cards
// (and slide off them after a while), and on the shoulders and heads of people standing still, who
// carry them along until they move. Feet kick the leaves on the floor up again. Someone arriving
// sends a gust across the wall; with nobody there, gusts come by themselves. Leaves falling onto
// the leaf heap join it (heap.js); the heap's own leaves, blown off, fly in front of everything.

import { blit, drawLeaf, FLAT, leafSprite, ROUND } from './leafpix.js';
import { PALETTES, PALETTES_BEHIND, PALETTES_SIGN, pickColor } from './forest.js';

const KICK_HZ = 30; // body field results per second (kicks are "cells moved" per result)
const MAX_LEAVES = 900;
const BIN = 0.5; // m: width of a crown section

// the motes: core bright, core dim, glow (alpha 254: behind the cards)
const MOTE = ['#fff4c4', '#e8cf86', '#a8925a'].map((h) => {
  const n = Number.parseInt(h.slice(1), 16);
  return ((254 << 24) | ((n & 255) << 16) | (n & 0xff00) | ((n >> 16) & 255)) >>> 0;
});

const AIR = 0;
const ON_PERSON = 1;
const ON_GROUND = 2;
const ON_CARD = 3;

export class Leaves {
  constructor() {
    this.list = [];
    this.gusts = [];
    this.place = new Map();
    this.sample = [0, 0, 0];
    this.w2 = [0, 0];
    this.nextGust = 3;
    this.lastArrival = -9;
    this.fieldSeq = -1;
    this.shake = [];
    this.acc = [];
    this.key = '';
    this.someone = false;
  }

  /**
   * Size, crowns and the cards for layout L (call every frame; cheap if nothing changed). rects:
   * what leaves can lie on (LED px), heap: the leaf heap (heap.js).
   */
  layout(L, wall, spots, rects, heap, ground) {
    const S = wall.setup;
    this.heap = heap;
    this.groundFn = ground;
    const key = JSON.stringify([L.W, L.H, S.size, S.bottom, spots.length, rects]);
    if (key === this.key) return;
    this.key = key;
    this.W = L.W;
    this.H = L.H;
    this.s = L.s;
    this.wallW = S.size.w;
    this.top = S.bottom + S.size.h;
    this.kx = L.W / S.size.w;
    this.ky = L.H / S.size.h;
    this.groundTop = this.mY(L.ground + 2 * L.s);
    this.groundBottom = this.mY(L.H - 3 * L.s);
    this.canopyLow = this.mY(L.canopy);
    // where leaves can rest on a card: its top edge (m)
    // where leaves can rest: a card's or board's top edge (m), sloped if the board is turned
    this.cards = rects.map((r) => {
      const slope = Math.tan(r.angle ?? 0);
      const [tx, ty] = r.top ?? [r.x + r.w / 2, r.y];
      const half = ((r.bw ?? r.w) / 2) * Math.cos(r.angle ?? 0) - 8 * L.s;
      return { x0: this.mX(tx - half), x1: this.mX(tx + half), cx: this.mX(tx), y: this.mY(ty), slope: (-slope * this.kx) / this.ky, angle: r.angle ?? 0, sign: !!r.sign, px: r };
    });
    // the crowns' hanging leaves by section, in m
    const nb = Math.max(1, Math.ceil(this.wallW / BIN));
    this.bins = Array.from({ length: nb }, () => []);
    for (const [x, y, c] of spots) {
      const b = Math.min(nb - 1, Math.max(0, Math.floor(this.mX(x) / BIN)));
      this.bins[b].push([this.mX(x), this.mY(y), c]);
    }
    this.shake = new Array(nb).fill(0);
    this.acc = new Array(nb).fill(0);
    this.list = this.list.filter((q) => q.x < this.wallW + 0.5);
    // light motes drifting in the air of the wood
    const R = Math.random;
    this.motes = Array.from({ length: Math.round((L.W / L.s / 1008) * 60) }, () => ({ x: R() * L.W, y: R() * L.ground * 0.95, vx: (R() - 0.5) * 6, vy: (R() - 0.5) * 3, ph: R() * 6.28, sp: 0.6 + R() * 1.8, big: R() < 0.3 }));
  }

  /** where a leaf at x (m) lies on the ground (m): the near ground's line, `off` 0..1 deeper in */
  groundAt(x, off) {
    const px = x * this.kx;
    const gy = this.groundFn ? this.groundFn(px) : (this.top - this.groundTop) * this.ky;
    return this.mY(gy + 2 * this.s + off * Math.max(0, this.H - 4 * this.s - gy));
  }

  mX(px) {
    return px / this.kx;
  }
  mY(py) {
    return this.top - py / this.ky;
  }

  /** The air: a slow breeze, gusts running across the wall, and the air walking people push. */
  wind(x, y, t, p, out) {
    let wx = p.wind * (0.12 + 0.1 * Math.sin(t * 0.21) + 0.05 * Math.sin(t * 0.53 + x * 0.7));
    let wy = p.wind * 0.05 * Math.sin(t * 0.37 + x * 1.3);
    for (const g of this.gusts) {
      const age = t - g.t0;
      const front = g.x0 + g.dir * g.speed * age;
      const env = Math.min(1, age * 3) * Math.max(0, 1 - age / g.life);
      const amp = g.str * env * Math.exp(-(((x - front) / g.width) ** 2));
      wx += g.dir * amp;
      wy += amp * 0.4 * Math.sin(y * 3 + age * 4);
    }
    for (const pl of this.place.values()) {
      const dx = Math.abs(x - pl.x);
      if (dx > 0.8 || y > pl.top + 0.35 || y < pl.feet - 0.1) continue;
      wx += pl.vx * (1 - dx / 0.8) * 0.8 * p.kick;
    }
    out[0] = wx;
    out[1] = wy;
    return out;
  }

  gust(x0, dir, str, t) {
    this.gusts.push({ x0, dir, str, t0: t, speed: 2.6, width: 0.9, life: (this.wallW + 2) / 2.6 });
  }

  /** a leaf from elsewhere (the heap): size in LED px, front: in front of the cards */
  spawnFree(x, y, vx, vy, c, size, front) {
    const q = this._spawn(x, y, vx, vy, c);
    if (!q) return;
    q.size = size;
    q.front = front;
    q.spin = (Math.random() - 0.5) * 10;
  }

  _spawn(x, y, vx, vy, c) {
    if (this.list.length >= MAX_LEAVES) {
      // make room: the oldest leaf on the floor goes
      let oldest = -1;
      for (let i = 0; i < this.list.length; i++) {
        const q = this.list[i];
        if (q.state === ON_GROUND && (oldest < 0 || q.age > this.list[oldest].age)) oldest = i;
      }
      if (oldest < 0) return null;
      this.list.splice(oldest, 1);
    }
    const R = Math.random;
    const q = {
      x,
      y,
      vx,
      vy,
      rot: (R() - 0.5) * 1.2,
      spin: (R() - 0.5) * 3,
      fp: R() * 6.28,
      fs: 2.2 + R() * 2.2,
      fall: 0.32 + R() * 0.22,
      size: (8 + R() * 4) * this.s,
      c: c ?? pickColor(R),
      state: AIR,
      ground: 0,
      gOff: R() ** 1.5,
      age: 0,
      life: 0,
      on: 0,
      ox: 0,
      oy: 0,
      flip: 1,
      card: null,
      front: false,
    };
    this.list.push(q);
    return q;
  }

  /** The person whose body is at wall point (x, y): the nearest placement around it. */
  _personAt(x, y) {
    let best = null;
    let bd = 0.55;
    for (const pl of this.place.values()) {
      if (y > pl.top + 0.25 || y < pl.feet - 0.1) continue;
      const d = Math.abs(x - pl.x);
      if (d < bd) {
        bd = d;
        best = pl;
      }
    }
    return best;
  }

  _underCard(x, y) {
    for (const c of this.cards) {
      const r = c.px;
      const px = x * this.kx;
      const py = (this.top - y) * this.ky;
      if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) return true;
    }
    return false;
  }

  /** places: the people on the wall this frame (persp.js: x, top, feet, vx, dist, id) */
  update(ctx, p, field, places) {
    const R = Math.random;
    const t = ctx.time;
    const dt = Math.min(0.05, ctx.dt);
    const w2 = this.w2;
    if (!this.bins) return;

    // the people: where they are (wall m)
    this.place.clear();
    for (const pl of places) this.place.set(pl.id, pl);
    this.someone = this.place.size > 0;

    // gusts: someone arrives (from the side they come from), or now and then
    for (const person of ctx.persons?.entered ?? []) {
      if (t - this.lastArrival < 2) break; // a group arriving is one gust
      this.lastArrival = t;
      const pl = this.place.get(person.id);
      if (!pl) continue;
      const dir = Math.abs(pl.vx) > 0.2 ? Math.sign(pl.vx) : pl.x < this.wallW / 2 ? 1 : -1;
      this.gust(pl.x - dir * 0.5, dir, 1.1 * p.wind + 0.4, t);
    }
    if (t > this.nextGust) {
      this.nextGust = t + (this.someone ? 16 : 8) * (0.7 + R() * 0.6);
      const dir = R() < 0.7 ? 1 : -1;
      this.gust(dir > 0 ? -1 : this.wallW + 1, dir, (0.5 + R() * 0.6) * p.wind, t);
    }
    this.gusts = this.gusts.filter((g) => t - g.t0 < g.life);

    // ---- the crowns: shaken by moving bodies up there (arms, jumps) and by gusts
    const fresh = field && field.seq !== this.fieldSeq;
    if (fresh) this.fieldSeq = field.seq;
    const nb = this.bins.length;
    for (let b = 0; b < nb; b++) {
      this.shake[b] *= Math.exp(-dt * 2.2);
      if (fresh && field.w) {
        const cx0 = Math.max(0, Math.floor((b * BIN) / field.cell));
        const cx1 = Math.min(field.w - 1, Math.floor(((b + 1) * BIN) / field.cell));
        const cy1 = Math.min(field.h - 1, Math.floor((this.top - this.canopyLow + 0.12) / field.cell));
        let sum = 0;
        for (let cy = 0; cy <= cy1; cy += 2) {
          for (let cx = cx0; cx <= cx1; cx += 2) {
            const c = cy * field.w + cx;
            sum += Math.abs(field.kx[c]) + Math.abs(field.ky[c]);
          }
        }
        this.shake[b] = Math.min(2, this.shake[b] + sum * 0.012 * p.shake);
      }
      const bx = (b + 0.5) * BIN;
      this.wind(bx, this.canopyLow, t, p, w2);
      const gusty = Math.max(0, Math.abs(w2[0]) - 0.3 * p.wind);
      this.acc[b] += dt * ((p.laub / nb) * (1 + gusty * 6) + this.shake[b] * 16 * p.shake);
      const spots = this.bins[b];
      while (this.acc[b] >= 1) {
        this.acc[b] -= 1;
        if (!spots.length) continue;
        const [x, y, c] = spots[Math.floor(R() * spots.length)];
        this._spawn(x, y, (R() - 0.5) * 0.3 + this.shake[b] * (R() - 0.5) * 1.2, -0.05 - R() * 0.15, c);
      }
    }

    // ---- the light motes: drifting slowly with the breeze, twinkling
    for (const m of this.motes ?? []) {
      this.wind(m.x / this.kx, this.mY(m.y), t, p, w2);
      m.x += (m.vx + w2[0] * 12) * dt;
      m.y += (m.vy + Math.sin(t * 0.7 + m.ph) * 4) * dt;
      if (m.x < -4) m.x += this.W + 8;
      if (m.x > this.W + 4) m.x -= this.W + 8;
      if (m.y < 2 || m.y > this.H * 0.85) m.vy = -m.vy;
      m.glow = 0.5 + 0.5 * Math.sin(t * m.sp + m.ph);
    }

    // ---- the leaves
    const smp = this.sample;
    const kickGain = field ? field.cell * KICK_HZ * 1.3 * p.kick : 0;
    const out = [];
    let onGround = 0;
    for (const q of this.list) {
      q.age += dt;
      q.fp += q.fs * dt;

      if (q.state === ON_PERSON) {
        const pl = this.place.get(q.on);
        if (!pl) {
          q.state = AIR;
          q.vy = 0.1;
        } else {
          q.x = pl.x + q.ox;
          q.y = pl.top + q.oy;
          let release = Math.abs(pl.vx) > 1.1 && R() < dt * 3;
          if (field && field.w) {
            field.sample(q.x, q.y, this.top, smp);
            const c = field.cellAt(q.x, q.y, this.top);
            const kx = c >= 0 ? field.kx[c] : 0;
            const ky = c >= 0 ? field.ky[c] : 0;
            if (Math.hypot(kx, ky) > 0.3) {
              release = true;
              q.vx = kx * kickGain * 1.4 + (R() - 0.5) * 0.4;
              q.vy = ky * kickGain * 1.4 + 0.3 + R() * 0.3;
            } else if (smp[0] > 0.06) {
              release = true; // the body moved away under it
            } else if (smp[0] < -0.025) {
              // sank in (the outline changed): ride up to the surface
              const gl = Math.hypot(smp[1], smp[2]) || 1;
              q.ox += (smp[1] / gl) * (-0.012 - smp[0]) * 0.5;
              q.oy += (smp[2] / gl) * (-0.012 - smp[0]) * 0.5;
            }
          }
          if (release || !p.stick || this._underCard(q.x, q.y)) {
            q.state = AIR;
            q.vx += pl.vx;
            q.spin = (R() - 0.5) * 8;
          }
          if (q.state === ON_PERSON) {
            out.push(q);
            continue;
          }
        }
      }

      if (q.state === ON_CARD) {
        // lies on a card's top edge; after a while it slides to the nearer end and drops off
        const cd = q.card;
        let go = false;
        if (field && field.w) {
          const c = field.cellAt(q.x, q.y + 0.03, this.top);
          if (c >= 0 && Math.hypot(field.kx[c], field.ky[c]) > 0.25) {
            go = true;
            q.vx = field.kx[c] * kickGain;
            q.vy = 0.4 + R() * 0.4;
          }
        }
        if (q.age > q.life) {
          const dir = Math.abs(cd.slope) > 0.02 ? (cd.slope > 0 ? -1 : 1) : q.x - cd.x0 < cd.x1 - q.x ? -1 : 1;
          q.x += dir * 0.12 * dt;
          q.y = cd.y + cd.slope * (q.x - cd.cx) + 0.015;
          q.rot += dir * 0.4 * dt;
          if (q.x < cd.x0 - 0.02 || q.x > cd.x1 + 0.02) {
            go = true;
            q.vx = dir * 0.15;
            q.vy = 0;
          }
        }
        if (go) {
          q.state = AIR;
          q.age = 0;
          q.skip = cd; // falls in front of that card now, does not land on it again
        } else {
          out.push(q);
          continue;
        }
      }

      if (q.state === ON_GROUND) {
        // on the floor: lies until feet or a strong gust lift it
        let lift = false;
        if (field && field.w && q.age > 0.3) {
          const c = field.cellAt(q.x, q.y + 0.05, this.top);
          if (c >= 0 && Math.hypot(field.kx[c], field.ky[c]) > 0.2) {
            lift = true;
            q.vx = field.kx[c] * kickGain * 1.2;
            q.vy = 0.5 + R() * 0.6;
          }
        }
        if (!lift && R() < dt * 0.6) {
          this.wind(q.x, q.y, t, p, w2);
          if (Math.abs(w2[0]) > 0.8) {
            lift = true;
            q.vx = w2[0];
            q.vy = 0.3 + R() * 0.5;
          }
        }
        if (lift) {
          q.state = AIR;
          q.age = 0;
        } else {
          onGround++;
          out.push(q);
          continue;
        }
      }

      // in the air
      this.wind(q.x, q.y, t, p, w2);
      const flutter = Math.sin(q.fp) * 0.25;
      q.vx += (w2[0] + flutter - q.vx) * Math.min(1, 2.2 * dt);
      q.vy += (w2[1] - q.fall - q.vy) * Math.min(1, 1.8 * dt);
      if (field && field.w) {
        field.sample(q.x, q.y, this.top, smp);
        const c = field.cellAt(q.x, q.y, this.top);
        const kx = c >= 0 ? field.kx[c] : 0;
        const ky = c >= 0 ? field.ky[c] : 0;
        const km = Math.hypot(kx, ky);
        if (km > 0.06) {
          // a moving outline sweeps the leaf along
          const a = Math.min(1, km * 0.8);
          q.vx += (kx * kickGain - q.vx) * a;
          q.vy += (ky * kickGain + 0.15 - q.vy) * a;
          q.spin += (R() - 0.5) * km * 6;
        }
        if (smp[0] < 0) {
          const gl = Math.hypot(smp[1], smp[2]) || 1;
          const nx = smp[1] / gl;
          const ny = smp[2] / gl;
          const pl = p.stick && km < 0.15 && q.vy < 0.05 && ny > 0.2 && !this._underCard(q.x, q.y) ? this._personAt(q.x, q.y) : null;
          if (pl && R() < 0.75) {
            // lands on a person standing still: stays on the surface and rides along
            q.x += nx * (-0.012 - smp[0]);
            q.y += ny * (-0.012 - smp[0]);
            q.state = ON_PERSON;
            q.on = pl.id;
            q.ox = q.x - pl.x;
            q.oy = q.y - pl.top;
            q.vx = q.vy = 0;
            q.rot = Math.atan2(nx, -ny) + Math.PI / 2 + (R() - 0.5) * 0.9;
            q.flip = (R() < 0.5 ? -1 : 1) * (0.55 + R() * 0.35);
            out.push(q);
            continue;
          }
          // else: off the body's surface like off a wall
          q.x += nx * (-smp[0] + 0.004);
          q.y += ny * (-smp[0] + 0.004);
          const vn = q.vx * nx + q.vy * ny;
          if (vn < 0) {
            q.vx -= nx * vn * 1.3;
            q.vy -= ny * vn * 1.3;
          }
        }
      }
      const y0 = q.y;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.rot += q.spin * dt;
      q.spin *= Math.exp(-dt * 0.8);
      // a card's top edge
      if (q.vy < 0 && p.cards) {
        let landed = false;
        for (const cd of this.cards) {
          const ey = cd.y + cd.slope * (q.x - cd.cx);
          if (cd === q.skip || q.x < cd.x0 || q.x > cd.x1 || y0 < ey || q.y > ey) continue;
          if (R() < 0.7) {
            q.state = ON_CARD;
            q.card = cd;
            q.y = ey + 0.012 + R() * 0.01;
            q.vx = q.vy = 0;
            q.age = 0;
            q.life = 5 + R() * 14;
            q.rot = (R() < 0.5 ? -1 : 1) * (Math.PI / 2 + (R() - 0.5) * 0.5) + cd.angle;
            q.flip = (R() < 0.5 ? -1 : 1) * (0.5 + R() * 0.3);
            landed = true;
          } else q.skip = cd;
          break;
        }
        if (landed) {
          out.push(q);
          continue;
        }
      }
      // onto the leaf heap: joins it
      if (this.heap && !q.front && q.vy <= 0) {
        const px = q.x * this.kx;
        const hh = this.heap.heightAt(px);
        if (hh > 0 && q.y <= this.top - this.H / this.ky + hh / this.ky) {
          this.heap.feed(px);
          continue;
        }
      }
      if (q.vy <= 0 && q.y < this.groundTop + 0.2) q.ground = this.groundAt(q.x, q.gOff);
      if (q.y <= q.ground && q.vy <= 0) {
        q.y = q.ground;
        q.state = ON_GROUND;
        q.age = 0;
        q.vx = q.vy = 0;
        q.skip = null;
        q.rot = (R() < 0.5 ? -1 : 1) * (Math.PI / 2 + (R() - 0.5) * 1.1);
        q.flip = (R() < 0.5 ? -1 : 1) * (0.6 + R() * 0.35);
        onGround++;
      }
      if (q.x < -0.4 || q.x > this.wallW + 0.4 || q.y > this.top + 0.6) continue;
      out.push(q);
    }
    // the floor keeps at most `pile` leaves: the oldest go
    if (onGround > p.pile) {
      const ground = out.filter((q) => q.state === ON_GROUND).sort((a, b) => b.age - a.age);
      const drop = new Set(ground.slice(0, onGround - p.pile));
      this.list = out.filter((q) => !drop.has(q));
    } else this.list = out;
  }

  /**
   * Draws the leaves into buf (Uint32 RGBA over the LED image). ground true: only those lying on
   * the floor (drawn before the heap); false: all others and the light motes, the air last. The
   * alpha says where render.js puts them: 255 in front of the contact card (lying on it), 253 at
   * the signs' depth (lying on a sign), 254 the rest (in front of the wood, behind the card).
   */
  draw(buf, ground) {
    const { W, H, kx, ky, top } = this;
    if (!W) return 0;
    let n = 0;
    if (!ground) {
      // the light motes: a bright pixel, a little cross of glow when they shine
      for (const m of this.motes ?? []) {
        if (m.glow < 0.25) continue;
        const x = Math.round(m.x);
        const y = Math.round(m.y);
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
        const k = y * W + x;
        buf[k] = m.glow > 0.6 ? MOTE[0] : MOTE[1];
        if (m.big && m.glow > 0.7) for (const d of [1, -1, W, -W]) if (!buf[k + d]) buf[k + d] = MOTE[2];
      }
    }
    for (const pass of ground ? [ON_GROUND] : [ON_CARD, ON_PERSON, AIR]) {
      for (const q of this.list) {
        if (q.state !== pass) continue;
        let rot = q.rot;
        let flip = q.flip;
        if (pass === AIR) {
          // swinging and turning while it falls
          rot += Math.sin(q.fp) * 0.55;
          flip = Math.cos(q.fp * 0.6 + q.fs);
        }
        const pal = (pass === ON_CARD ? (q.card?.sign ? PALETTES_SIGN : PALETTES) : PALETTES_BEHIND)[q.c];
        if (pass === AIR) drawLeaf(buf, W, H, q.x * kx, (top - q.y) * ky, q.size, rot, flip, pal, ROUND | FLAT);
        else {
          // lying still: rasterized once (again if it turned or changed place)
          const key = `${pass},${Math.round(rot * 20)},${Math.round(flip * 20)}`;
          if (q.sprKey !== key) {
            q.sprKey = key;
            q.spr = leafSprite(q.size, rot, flip, pal, ROUND | FLAT);
          }
          blit(buf, W, H, q.x * kx, (top - q.y) * ky, q.spr);
        }
        n++;
      }
    }
    return n;
  }
}
