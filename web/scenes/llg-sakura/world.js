// What moves: cherry petals, the blossom crowns, the lanterns, wind gusts, the school's windows and
// now and then a shooting star. Physics in wall meters (x from the left edge, y above the floor, as
// ctx.wall and BodyField); drawing in art pixels (pixel art, see render.js).
//
// The people (BodyField, ctx.wall.persons):
// - moving outlines push the air: petals near a moving arm or a walking body are swept along
// - petals that fall on someone standing still stay there (head, shoulders, raised arms) and ride
//   along; moving, shaking or walking fast throws them off again
// - reaching or jumping into a crown shakes the tree: a burst of petals
// - a lantern above someone glows brighter and swings when they pass below it
// - someone arriving sends a gust across the wall; with nobody there gusts and shooting stars come
//   by themselves

import { KIND } from './render.js';
import { C, rgb, rng } from './pixel.js';
import { FLUTTER } from './sprites.js';

const MAX_PETALS = 1100;
const KICK_HZ = 30; // BodyField results per second (kicks are "cells moved" per result)
const CROWN = [C.p3, C.p4, C.p5, C.p7].map(rgb);
const CROWN_EDGE = rgb(C.p1);
const DOTS = { 4: rgb(C.p6), 5: rgb(C.p8), 6: rgb(C.p2) };
const STAR = [C.g5, C.g7, C.w].map(rgb);
const WIN = rgb(C.y1);
const WIN_COOL = rgb(C.y2);
const WIN_SHADE = rgb(C.o5);
const CURTAIN = [C.p5, C.c2, C.o5].map(rgb);
const GLASS = rgb(C.y0);
const DOOR = rgb(C.y1);
const LANTERN_GLOW = rgb(C.o4);
const POOL = rgb(C.o3);
const VEND = rgb(C.c2);
const RED = rgb(C.o2);
const EYES = rgb(C.y1);
const CORD = rgb(C.sky0);
const ANTS = [C.p5, C.p7].map(rgb);
const METEOR = [C.w, C.y2, C.g7, C.g6, C.g5, C.g4].map(rgb);

export class World {
  constructor() {
    this.R = rng(1996); // the year the partnership with Omiya began
    this.petals = [];
    this.gusts = [];
    this.trees = [];
    this.lanterns = [];
    this.windows = [];
    this.stars = [];
    this.meteor = null;
    this.nextMeteor = 12;
    this.nextGust = 6;
    this.nextWindow = 3;
    this.lastArrival = -10;
    this.empty = 0;
    this.spawnAcc = { tree: [], top: 0, side: 0 };
    this.fieldSeq = -1;
    this.sample = [0, 0, 0];
    this.place = new Map();
  }

  /** New painting (layout or LED size changed): take over its trees, lanterns, windows, stars. */
  setScene(scene) {
    const R = this.R;
    this.scene = scene;
    this.trees = scene.trees.map((t) => ({ ...t, shake: 0 }));
    this.spawnAcc.tree = this.trees.map(() => 0);
    this.lanterns = scene.lanterns.map((l, i) => ({ ...l, a: 0, av: 0, lit: 0.55, kind: i % 3 === 1 ? 1 : 0 }));
    this.blink = 4;
    this.windows = scene.windows.map((w) => ({ ...w, lit: w.kind > 0 ? 1 : R() < 0.55 ? 1 : 0, level: 0, cool: R() < 0.3, curtain: R() < 0.3 ? Math.floor(R() * 3) : -1 }));
    for (const w of this.windows) w.level = w.lit;
    this.stars = scene.stars;
  }

  // ---- coordinates (set every step from the wall setup)
  _frame(ctx, AW, AH) {
    const S = ctx.wall.setup;
    this.W = AW;
    this.H = AH;
    this.wallW = S.size.w;
    this.wallH = S.size.h;
    this.top = S.bottom + S.size.h;
    this.bottom = S.bottom;
    this.kx = AW / S.size.w;
    this.ky = AH / S.size.h;
  }
  pxX(x) {
    return x * this.kx;
  }
  pxY(y) {
    return (this.top - y) * this.ky;
  }
  mX(px) {
    return px / this.kx;
  }
  mY(py) {
    return this.top - py / this.ky;
  }

  /** The wind at (x, y), m/s, into out[0..1]. */
  wind(x, y, t, p, out) {
    let wx = p.wind * (0.16 + 0.1 * Math.sin(t * 0.21) + 0.05 * Math.sin(t * 0.53 + x * 0.7));
    let wy = p.wind * 0.04 * Math.sin(t * 0.37 + x * 1.3);
    for (const g of this.gusts) {
      const age = t - g.t0;
      const front = g.x0 + g.dir * g.speed * age;
      const env = Math.min(1, age * 3) * Math.max(0, 1 - age / g.life);
      const amp = g.str * env * Math.exp(-(((x - front) / g.width) ** 2));
      wx += g.dir * amp;
      wy += amp * 0.35 * Math.sin(y * 3 + age * 4);
    }
    // the air around walking people moves with them
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
    this.gusts.push({ x0, dir, str, t0: t, speed: 2.4, width: 0.9, life: (this.wallW + 2) / 2.4 });
  }

  _spawn(x, y, vx, vy, fromTree) {
    if (this.petals.length >= MAX_PETALS) {
      // make room: the oldest petal on the ground goes
      let oldest = -1;
      for (let i = 0; i < this.petals.length; i++) {
        const q = this.petals[i];
        if (q.state === 2 && (oldest < 0 || q.age > this.petals[oldest].age)) oldest = i;
      }
      if (oldest < 0) return;
      this.petals.splice(oldest, 1);
    }
    const R = this.R;
    const near = R() < 0.18; // a few petals closer to the eye: bigger and brighter
    this.petals.push({
      x,
      y,
      vx,
      vy,
      rot: R() * Math.PI * 2,
      spin: (R() - 0.5) * 3,
      fp: R() * Math.PI * 2,
      fs: 2 + R() * 3,
      size: near ? 1.35 : 0.85 + R() * 0.3,
      tone: Math.floor(R() * 4),
      fall: 0.22 + R() * 0.14,
      state: 0, // 0 in the air, 1 on a person, 2 on the ground
      ground: this.bottom + 0.03 + Math.pow(R(), 0.8) * 0.52,
      age: 0,
      fromTree,
    });
  }

  /** One step. placements: ctx.wall.persons; field: BodyField or null. */
  step(ctx, p, field, placements, AW, AH) {
    this._frame(ctx, AW, AH);
    const t = ctx.time;
    const dt = Math.min(ctx.dt, 0.1);
    const R = this.R;
    this.place.clear();
    for (const pl of placements) this.place.set(pl.id, pl);
    const someone = placements.length > 0;
    this.empty = someone ? 0 : this.empty + dt;

    // ---- gusts: arrivals, and now and then by themselves
    for (const person of ctx.persons?.entered ?? []) {
      if (t - this.lastArrival < 2) break; // a group arriving is one gust
      this.lastArrival = t;
      const pl = ctx.wall.place(person);
      if (!pl) continue;
      const dir = Math.abs(pl.vx) > 0.2 ? Math.sign(pl.vx) : pl.x < this.wallW / 2 ? 1 : -1;
      this.gust(pl.x - dir * 0.5, dir, 1.1 * p.wind + 0.4, t);
    }
    if (t > this.nextGust) {
      this.nextGust = t + (someone ? 14 : 9) * (0.7 + R() * 0.6);
      const dir = R() < 0.75 ? 1 : -1;
      this.gust(dir > 0 ? -1 : this.wallW + 1, dir, (0.5 + R() * 0.5) * p.wind, t);
    }
    this.gusts = this.gusts.filter((g) => t - g.t0 < g.life);

    // ---- the trees: shaken by moving bodies inside the crown, by gusts
    const fresh = field && field.seq !== this.fieldSeq;
    if (fresh) this.fieldSeq = field.seq;
    const w2 = [0, 0];
    for (let i = 0; i < this.trees.length; i++) {
      const tr = this.trees[i];
      tr.shake *= Math.exp(-dt * 2.2);
      if (fresh && field.w) {
        // moving outlines in the crown (wall m): arms reaching up, jumping, walking through it
        const x0 = this.mX(tr.cx - tr.rx);
        const x1 = this.mX(tr.cx + tr.rx);
        const y1 = this.mY(tr.cy - tr.ry);
        const y0 = this.mY(tr.cy + tr.ry * 0.8);
        let sum = 0;
        const cx0 = Math.max(0, Math.floor(x0 / field.cell));
        const cx1 = Math.min(field.w - 1, Math.floor(x1 / field.cell));
        const cy0 = Math.max(0, Math.floor((this.top - y1) / field.cell));
        const cy1 = Math.min(field.h - 1, Math.floor((this.top - y0) / field.cell));
        for (let cy = cy0; cy <= cy1; cy += 2) {
          for (let cx = cx0; cx <= cx1; cx += 2) {
            const c = cy * field.w + cx;
            sum += Math.abs(field.kx[c]) + Math.abs(field.ky[c]);
          }
        }
        tr.shake = Math.min(1.6, tr.shake + sum * 0.012 * p.shake);
      }
      this.wind(this.mX(tr.cx), this.mY(tr.cy), t, p, w2);
      const gustiness = Math.max(0, Math.abs(w2[0]) - 0.3 * p.wind);
      tr.shake = Math.min(1.6, tr.shake + gustiness * dt * 0.8);
      // petals from the crown
      this.spawnAcc.tree[i] += dt * p.petals * (0.8 + gustiness * 6 + tr.shake * 45);
      while (this.spawnAcc.tree[i] >= 1) {
        this.spawnAcc.tree[i] -= 1;
        const b = tr.blobs[Math.floor(R() * tr.blobs.length)];
        if (b) this._spawn(this.mX(b.x), this.mY(b.y), (R() - 0.5) * 0.3 + tr.shake * (R() - 0.5) * 1.2, -0.05 - R() * 0.2, true);
      }
    }
    // petals from cherry trees beyond the wall: from above, and from the side the wind comes from
    this.spawnAcc.top += dt * p.petals * 5;
    while (this.spawnAcc.top >= 1) {
      this.spawnAcc.top -= 1;
      this._spawn(-0.3 + R() * (this.wallW + 0.3), this.top + 0.05, 0, -0.2, false);
    }
    this.spawnAcc.side += dt * p.petals * 2.5 * Math.min(2, p.wind);
    while (this.spawnAcc.side >= 1) {
      this.spawnAcc.side -= 1;
      this._spawn(-0.08, this.bottom + 0.7 + R() * (this.wallH - 0.8), 0.3, 0, false);
    }

    // ---- petals
    const smp = this.sample;
    const kickGain = field ? field.cell * KICK_HZ * 1.3 * p.kick : 0;
    const out = [];
    for (const q of this.petals) {
      q.age += dt;
      q.fp += q.fs * dt;
      if (q.state === 1) {
        const pl = this.place.get(q.on);
        if (!pl) {
          q.state = 0;
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
          if (release || !p.stick) {
            q.state = 0;
            q.vx += pl.vx;
            q.spin = (R() - 0.5) * 8;
          }
          if (q.state === 1) {
            out.push(q);
            continue;
          }
        }
      }
      if (q.state === 2) {
        // on the ground: lie, fade, get swept up by feet or a strong gust
        let lift = false;
        if (field && field.w && q.age > 0.3) {
          const c = field.cellAt(q.x, q.y + 0.04, this.top);
          if (c >= 0 && Math.hypot(field.kx[c], field.ky[c]) > 0.2) {
            lift = true;
            q.vx = field.kx[c] * kickGain * 1.2;
            q.vy = 0.5 + R() * 0.6;
          }
        }
        if (!lift && R() < dt * 0.6) {
          this.wind(q.x, q.y, t, p, w2);
          if (Math.abs(w2[0]) > 0.75) {
            lift = true;
            q.vx = w2[0];
            q.vy = 0.3 + R() * 0.5;
          }
        }
        if (lift) {
          q.state = 0;
          q.age = 0;
        } else {
          if (q.age < 20) out.push(q);
          continue;
        }
      }
      // in the air
      this.wind(q.x, q.y, t, p, w2);
      const flutter = Math.sin(q.fp) * 0.22;
      const drag = 2.2;
      q.vx += (w2[0] + flutter - q.vx) * Math.min(1, drag * dt);
      q.vy += (w2[1] - q.fall - q.vy) * Math.min(1, drag * 0.8 * dt);
      if (field && field.w) {
        field.sample(q.x, q.y, this.top, smp);
        const c = field.cellAt(q.x, q.y, this.top);
        const kx = c >= 0 ? field.kx[c] : 0;
        const ky = c >= 0 ? field.ky[c] : 0;
        const km = Math.hypot(kx, ky);
        if (km > 0.06) {
          // a moving outline sweeps the petal along
          const a = Math.min(1, km * 0.8);
          q.vx += (kx * kickGain - q.vx) * a;
          q.vy += (ky * kickGain + 0.15 - q.vy) * a;
          q.spin += (R() - 0.5) * km * 6;
        }
        if (smp[0] < 0) {
          const gl = Math.hypot(smp[1], smp[2]) || 1;
          const nx = smp[1] / gl;
          const ny = smp[2] / gl;
          const pl = p.stick && km < 0.15 && q.vy < 0.05 && ny > 0.2 ? this._personAt(q.x, q.y) : null;
          if (pl && R() < 0.75) {
            // lands on a person standing still: stays on the surface and rides along
            q.x += nx * (-0.012 - smp[0]);
            q.y += ny * (-0.012 - smp[0]);
            q.state = 1;
            q.on = pl.id;
            q.ox = q.x - pl.x;
            q.oy = q.y - pl.top;
            q.vx = q.vy = 0;
            q.rot = Math.atan2(nx, ny) + (R() - 0.5) * 1.2;
            q.fp = R() < 0.5 ? 0 : Math.PI; // lies flat: front or back
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
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.rot += q.spin * dt;
      q.spin *= Math.exp(-dt * 0.8);
      if (q.y <= q.ground && q.vy <= 0) {
        q.y = q.ground;
        q.state = 2;
        q.age = 0;
        q.vx = q.vy = 0;
      }
      if (q.x < -0.4 || q.x > this.wallW + 0.4 || q.y > this.top + 0.6) continue;
      out.push(q);
    }
    this.petals = out;

    // ---- lanterns: glow above people, swing when they pass
    for (const l of this.lanterns) {
      const lx = this.mX(l.x);
      let near = 0;
      let push = 0;
      for (const pl of placements) {
        const n = Math.max(0, 1 - Math.abs(pl.x - lx) / 0.9) * (pl.dist < 4 ? 1 : 0.5);
        near = Math.max(near, n);
        push += pl.vx * n;
      }
      this.wind(lx, this.mY(l.y), t, p, w2);
      const target = 0.5 + 0.5 * near;
      l.lit += (target - l.lit) * (1 - Math.exp(-dt * (target > l.lit ? 5 : 1.5)));
      const torque = w2[0] * 1.2 + push * 2.5;
      l.av += (-12 * Math.sin(l.a) - 1.4 * l.av + torque) * dt;
      l.a += l.av * dt;
      l.a = Math.max(-0.7, Math.min(0.7, l.a));
    }

    // ---- windows: now and then a light goes on or off
    if (t > this.nextWindow && this.windows.length) {
      this.nextWindow = t + 1.5 + R() * 4;
      const w = this.windows[Math.floor(R() * this.windows.length)];
      if (w.kind === 0) w.lit = R() < p.windows ? 1 : 0;
    }
    for (const w of this.windows) w.level += (w.lit - w.level) * Math.min(1, dt * 6);

    // ---- a shooting star now and then (more often with nobody there)
    if (!this.meteor && t > this.nextMeteor && p.stars > 0) {
      this.nextMeteor = t + (someone ? 40 : 18) * (0.6 + R() * 0.8);
      const dir = R() < 0.5 ? 1 : -1;
      this.meteor = { x: this.W * (0.15 + R() * 0.7), y: this.H * (0.04 + R() * 0.16), dir, t0: t, dur: 0.8 };
    }
    if (this.meteor && t - this.meteor.t0 > this.meteor.dur) this.meteor = null;
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

  // ---------------------------------------------------------------- drawing (art pixels)

  /** Everything behind the people. */
  emitBack(w, ctx, p, sheet) {
    const t = ctx.time;
    const AW = this.W;
    const AH = this.H;
    const sc = this.scene;
    const dot = (x, y, c, a = 1) => w.push(Math.round(x) + 0.5, Math.round(y) + 0.5, 0.5, 0.5, 0, KIND.rect, 0, 0, c[0], c[1], c[2], a);
    const box = (x, y, bw, bh, c, a = 1) => w.push(x + bw / 2, y + bh / 2, bw / 2, bh / 2, 0, KIND.rect, 0, 0, c[0], c[1], c[2], a);
    w.push(AW / 2, AH / 2, AW / 2, AH / 2, 0, KIND.paint, 0, 0, 1, 1, 1, 1);

    // stars: twinkling in three steps, the big ones as small crosses
    if (p.stars > 0) {
      for (const st of this.stars) {
        const b = st.b * (0.55 + 0.45 * Math.sin(t * st.speed + st.phase)) * p.stars;
        const lv = b > 0.78 ? 2 : b > 0.5 ? 1 : b > 0.25 ? 0 : -1;
        if (lv < 0) continue;
        dot(st.x, st.y, STAR[lv]);
        if (st.big && lv === 2) {
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            dot(st.x + dx, st.y + dy, STAR[0]);
          }
        }
      }
      if (this.meteor) {
        const m = this.meteor;
        const u = (t - m.t0) / m.dur;
        const hx = m.x + m.dir * u * 90 * sc.scale;
        const hy = m.y + u * 30 * sc.scale;
        for (let i = 0; i < METEOR.length * 2; i++) {
          const k = Math.min(METEOR.length - 1, Math.floor(i / 2));
          dot(hx - m.dir * i * 1.5, hy - i * 0.5, METEOR[k]);
        }
      }
    }
    // the antenna light: on for half a second every two
    for (const l of sc.lights) if ((t + l.phase) % 2 < 0.5) dot(l.x, l.y, RED);

    // lit windows: warm, a light corner, some with a curtain
    for (const win of this.windows) {
      if (win.level < 0.5) continue;
      const a = p.windowsBright;
      if (win.kind === 0) {
        box(win.x, win.y, win.w, win.h, win.cool ? WIN_COOL : WIN, a);
        box(win.x, win.y + win.h - 1, win.w, 1, WIN_SHADE, a);
        if (win.curtain >= 0) box(win.x, win.y, 1, win.h, CURTAIN[win.curtain], a);
        else dot(win.x + win.w - 1, win.y, WIN_COOL, a);
      } else if (win.kind === 1) {
        box(win.x, win.y, win.w, win.h, GLASS, a);
        box(win.x, win.y, win.w, 1, WIN, a);
        box(win.x, win.y + win.h - 2, win.w, 2, WIN_SHADE, a);
      } else if (win.kind === 2) {
        const c = rgb(win.color);
        box(win.x, win.y, win.w, win.h, c, a);
        box(win.x, win.y, 1, win.h, WIN_COOL, 0.5 * a);
      } else box(win.x, win.y, win.w, win.h, DOOR, a);
    }

    // glows: the vending machine, the lanterns' light on the yard
    const v = sc.vend;
    w.push(v.x + v.w / 2, v.y + v.h * 0.4, 16 * sc.scale, 14 * sc.scale, 0, KIND.glow, 0, 0, VEND[0], VEND[1], VEND[2], 0.45);
    const yard = sc.horizon + (AH - sc.horizon) * 0.42;
    for (const l of this.lanterns) {
      w.push(l.x + Math.sin(l.a) * 4, yard, 24 * sc.scale, 5 * sc.scale, 0, KIND.glow, 0, 0, POOL[0], POOL[1], POOL[2], 0.32 * l.lit * p.lanterns);
    }

    // blossom crowns: whole pixels, swaying a pixel in the wind, trembling when shaken
    const w2 = [0, 0];
    for (const tr of this.trees) {
      this.wind(this.mX(tr.cx), this.mY(tr.cy), t, p, w2);
      const sway = w2[0] * 2.2 * sc.scale;
      const off = (b) => {
        const h = Math.max(0, b.h);
        return [
          Math.round((sway * (0.6 + 0.4 * Math.sin(t * 1.3 + b.phase)) + tr.shake * 2 * sc.scale * Math.sin(t * 23 + b.phase * 3)) * h),
          Math.round(tr.shake * 1.2 * sc.scale * Math.cos(t * 19 + b.phase * 2) * h),
        ];
      };
      for (const pass of [0, 1]) {
        for (const b of tr.blobs) {
          if (pass === 0 && b.tone !== 0) continue;
          const [dx, dy] = off(b);
          const r = pass === 0 ? b.r + 1 : b.r;
          const c = pass === 0 ? CROWN_EDGE : CROWN[b.tone];
          w.push(b.x + dx + 0.5, b.y + dy + 0.5, r + 1, r + 1, 0, KIND.disc, r, 0, c[0], c[1], c[2], 1);
        }
      }
      for (const d of tr.dots) {
        const [dx, dy] = off(d);
        dot(d.x + dx, d.y + dy, DOTS[d.tone]);
      }
    }

    // lanterns: glow, cord, the lantern (dimmer when nobody is near)
    for (const l of this.lanterns) {
      const lv = l.lit * p.lanterns;
      const flick = 1 + 0.04 * Math.sin(t * 9 + l.phase) * Math.sin(t * 5.3 + l.phase * 2);
      const spr = sheet.lantern[l.kind];
      const dx = Math.round(Math.sin(l.a) * (l.len + 3));
      const top = l.y + l.len + 1;
      const cx = l.x + dx;
      w.push(cx + 0.5, top + spr.h * 0.45, 13 * sc.scale, 13 * sc.scale, 0, KIND.glow, 0, 0, LANTERN_GLOW[0], LANTERN_GLOW[1], LANTERN_GLOW[2], 0.6 * lv * flick);
      for (let i = 0; i <= l.len; i++) dot(l.x + Math.round((dx * i) / Math.max(1, l.len + 1)), l.y + i, CORD);
      const k = Math.min(1, (0.5 + 0.6 * lv) * flick);
      const x0 = Math.round(cx - spr.w / 2 + 0.5);
      w.push(x0 + spr.w / 2, top + spr.h / 2, spr.w / 2, spr.h / 2, 0, KIND.atlas, 0, 0, k, k, k, 1, ...spr.uv);
    }

    // the cat blinks now and then
    const cat = sc.cat;
    if (t > this.blink + 0.18) {
      if (Math.random() < ctx.dt * 0.3) this.blink = t;
      dot(cat.eyes[0], cat.eyes[1], EYES);
      dot(cat.eyes[2], cat.eyes[3], EYES);
    }

    // petals on the ground (behind the people standing on it)
    for (const q of this.petals) if (q.state === 2 && q.age < 20) this._petal(w, q, sheet, q.age > 17 ? 0.6 : 0.9);
  }

  /** Everything in front of the people: petals in the air and on them, the QR card's frame. */
  emitFront(w, ctx, p, card, pulse, sheet) {
    for (const q of this.petals) if (q.state !== 2) this._petal(w, q, sheet, 1);
    if (pulse > 0.3 && card[2] > card[0]) {
      // marching dashes around the card while someone stands near it
      const [x0, y0, x1, y1] = card;
      const m = 3;
      const X0 = x0 - m;
      const Y0 = y0 - m;
      const X1 = x1 + m - 1;
      const Y1 = y1 + m - 1;
      const per = [];
      for (let x = X0; x <= X1; x++) per.push([x, Y0]);
      for (let y = Y0 + 1; y <= Y1; y++) per.push([X1, y]);
      for (let x = X1 - 1; x >= X0; x--) per.push([x, Y1]);
      for (let y = Y1 - 1; y > Y0; y--) per.push([X0, y]);
      const shift = Math.floor(ctx.time * 14);
      per.forEach(([x, y], i) => {
        const ph = (i + shift) % 8;
        if (ph < 4) w.push(x + 0.5, y + 0.5, 0.5, 0.5, 0, KIND.rect, 0, 0, ...ANTS[ph < 2 ? 1 : 0], 1);
      });
    }
  }

  _petal(w, q, sheet, k) {
    const near = q.size > 1.2;
    const frames = near ? sheet.near : sheet.small;
    let f;
    if (q.state === 1) f = q.fp < 1 ? 0 : 4;
    else if (q.state === 2) f = q.tone % 3 === 0 ? 0 : q.tone % 3 === 1 ? 4 : 5;
    else f = FLUTTER[Math.floor(((q.fp % (Math.PI * 2)) / (Math.PI * 2)) * FLUTTER.length) % FLUTTER.length];
    const spr = frames[f];
    const x0 = Math.round(this.pxX(q.x) - spr.w / 2);
    const y0 = Math.round(this.pxY(q.y) - spr.h / 2);
    w.push(x0 + spr.w / 2, y0 + spr.h / 2, spr.w / 2, spr.h / 2, 0, KIND.atlas, 0, 0, k, k, k, 1, ...spr.uv);
  }

  get counts() {
    let air = 0;
    let on = 0;
    let ground = 0;
    for (const q of this.petals) {
      if (q.state === 0) air++;
      else if (q.state === 1) on++;
      else ground++;
    }
    return { air, on, ground };
  }
}
