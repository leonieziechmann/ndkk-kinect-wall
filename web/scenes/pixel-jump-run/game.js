// The game: obstacles roll in along the ground (jump over them) or fly in at head height (duck under
// them), coins hang in the air, now and then a star makes you invincible. Everything moves across the
// wall from one edge to the other and passes every figure on its way, so it works for one person as
// for ten. No game over and no rules to explain: a hit makes the figure blink and costs its streak,
// every obstacle you get past counts, the coins count for everybody together.
//
// Positions: x in m from the wall's left edge, y in m above the game's ground line. Collisions are
// exact on the mosaic: an obstacle's cells against the figure's cells (lifted by its jump).

import { SPRITES, LOW, HIGH, rainbow } from './art.js';

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

export class Game {
  constructor() {
    this.time = 0;
    this.roundTime = 0; // s with people in front of the wall in this round
    this.emptyFor = 0;
    this.speed = 1.5;
    this.dist = 0; // m scrolled
    this.score = 0;
    this.best = 0;
    this.things = []; // obstacles and items
    this.particles = [];
    this.events = [];
    this.nextSpawn = 2;
    this.dir = 1; // 1: from the right to the left, -1: from the left
    this.dirSince = 0;
    this.lastStar = -100;
    this.flash = 0;
  }

  reset() {
    this.roundTime = 0;
    this.score = 0;
  }

  /** the cell column of the left edge of a thing */
  col(L, x) {
    return Math.floor((x * L.pxX - L.ox) / L.cellPx);
  }

  /** the cell row of the bottom of a thing at y m above the ground */
  row(L, y) {
    return L.groundRow - 1 - Math.floor(y / L.cellMy + 1e-6);
  }

  spawn(L, p, people) {
    const T = this.roundTime;
    const wallW = L.wallW;
    const w = (n) => n * L.cellMx;
    // where things start: out of sight beyond the edge, so the warning shows a moment before
    const lead = this.speed * p.warn;
    const enter = (width) => (this.dir > 0 ? wallW + lead : -lead - width);
    const along = (x, d) => x + this.dir * d; // further back in the line
    const duckY = p.figH * p.duckAt; // bottom of a flyer: you must be lower than this
    const opts = [
      ['low', 5],
      ['low2', T > 25 ? 1.2 : 0],
      ['high', T > 10 || !people ? 2.5 : 0],
      ['coins', 1.4],
      ['lowCoins', 1.6],
      ['highLow', T > 45 ? 0.8 : 0],
      ['star', T > 30 && this.time - this.lastStar > 40 ? 0.3 : 0],
    ];
    let sum = 0;
    for (const o of opts) sum += o[1];
    let r = Math.random() * sum;
    let kind = 'low';
    for (const [k, wgt] of opts) {
      if ((r -= wgt) <= 0) {
        kind = k;
        break;
      }
    }
    const air = p.jumpTime * this.speed; // m covered during one jump
    let len = 0;
    const low = (x) => {
      const type = pick(LOW);
      const s = SPRITES[type][0];
      this.things.push({ kind: 'obstacle', type, high: false, x, y: 0, w: s.w, h: s.h, hit: new Set(), passed: new Set(), phase: Math.random() * 10 });
      return w(s.w);
    };
    const high = (x) => {
      const type = pick(HIGH);
      const s = SPRITES[type][0];
      const y = duckY + rand(0, 0.12) * p.figH;
      this.things.push({ kind: 'obstacle', type, high: true, x, y, baseY: y, w: s.w, h: s.h, hit: new Set(), passed: new Set(), phase: Math.random() * 10 });
      return w(s.w);
    };
    const coin = (x, y) => {
      this.things.push({ kind: 'coin', type: 'coin', x, y, w: 4, h: 5, phase: Math.random() * 10 });
    };
    if (kind === 'low') len = low(enter(w(8)));
    else if (kind === 'low2') {
      const x = enter(w(8));
      const a = low(x);
      len = a + air * 0.35 + low(along(x, a + air * 0.35));
    } else if (kind === 'high') len = high(enter(w(11)));
    else if (kind === 'coins') {
      const n = 5;
      // over the heads: reach up or jump
      const y0 = pick([1.0, 1.1, 1.2]) * p.figH;
      const x = enter(w(4));
      for (let i = 0; i < n; i++) coin(along(x, i * w(6)), y0 + Math.sin((i / (n - 1)) * Math.PI) * 0.08 * p.figH);
      len = n * w(6);
    } else if (kind === 'lowCoins') {
      // an arc of coins over an obstacle: where the jump goes
      const x = enter(w(8));
      const ow = low(x);
      const n = 5;
      const span = air * 0.8;
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        coin(along(x, ow / 2 - span / 2 + u * span), p.figH * 0.95 + p.jumpHeight * 0.6 * Math.sin(u * Math.PI));
      }
      len = Math.max(ow, span);
    } else if (kind === 'highLow') {
      const x = enter(w(11));
      const a = high(x);
      len = a + air * 1.6 + low(along(x, a + air * 1.6));
    } else if (kind === 'star') {
      const x = enter(w(7));
      this.things.push({ kind: 'star', type: 'star', x, y: p.figH * 0.9, w: 7, h: 7, phase: 0 });
      this.lastStar = this.time;
      len = w(7);
    }
    // the gap to the next one: everybody must be able to land and look again
    const gap = air + this.speed * p.gap;
    this.nextSpawn = this.dist + len + gap * rand(1, 1.7) / Math.max(0.2, p.density);
  }

  /**
   * One step. figs: the figures (people.js) on the wall now, L: the mosaic layout, p: the params.
   */
  step(dt, figs, L, p, entered, jumped) {
    this.time += dt;
    const t = this.time;
    const people = figs.length > 0;
    if (people) {
      this.roundTime += dt;
      this.emptyFor = 0;
    } else {
      this.emptyFor += dt;
      if (this.emptyFor > p.resetAfter && this.roundTime > 0) this.reset();
    }
    const ramp = Math.min(1, this.roundTime / Math.max(1, p.rampTime));
    const target = people ? p.speed * (1 + (p.speedMax - 1) * ramp) : p.speed * 0.85;
    this.speed += (target - this.speed) * Math.min(1, dt * 0.5);
    const move = this.speed * dt;
    this.dist += move;

    // the direction: from the right, from the left or taking turns (switches once the wall is clear)
    const want = p.from === 'links' ? -1 : p.from === 'rechts' ? 1 : null;
    if (want !== null && want !== this.dir && !this.things.length) this.dir = want;
    if (want === null && t - this.dirSince > p.turnEvery) {
      if (!this.things.length) {
        this.dir = -this.dir;
        this.dirSince = t;
        this.nextSpawn = this.dist + 1;
      }
    }
    const holdSpawn = want === null && t - this.dirSince > p.turnEvery; // let the wall run empty first
    if (this.dist >= this.nextSpawn && !holdSpawn) this.spawn(L, p, people);

    for (const f of entered) {
      this.burst(L, f, 'enter');
      this.events.push({ type: 'enter', x: f.cx });
    }
    for (const f of jumped) {
      this.dust(L, f);
      this.events.push({ type: 'jump', x: f.cx });
    }
    for (const f of figs) {
      if (f.justLanded) {
        f.justLanded = false;
        this.dust(L, f);
      }
      // running: a puff of dust behind the feet now and then (the figures run towards what comes)
      if (!f.airborne && t - (f.puff ?? 0) > 0.32 && f.bbox[2] >= f.bbox[0]) {
        f.puff = t + Math.random() * 0.1;
        const x = this.dir > 0 ? f.bbox[0] - 1 : f.bbox[2] + 1;
        this.particles.push({ x, y: L.groundRow - 1, vx: -this.dir * rand(2, 5), vy: -rand(1, 3), g: 6, col: [120, 100, 210], t0: t, life: rand(0.25, 0.4) });
      }
    }

    // move, animate, collide
    const GW = L.GW;
    const GH = L.GH;
    const keep = [];
    for (const th of this.things) {
      th.x -= this.dir * move;
      th.phase += dt;
      if (th.type === 'bat') th.y = th.baseY + Math.sin(th.phase * 5) * L.cellMy * 1.2;
      const c0 = this.col(L, th.x);
      const frames = SPRITES[th.type];
      const fr = frames[Math.floor(th.phase * (th.type === 'coin' ? 8 : 7)) % frames.length];
      th.frame = fr;
      th.c0 = c0;
      th.r0 = this.row(L, th.y) - fr.h + 1;
      const gone = this.dir > 0 ? c0 + fr.w < -2 : c0 > GW + 2;
      if (gone || th.dead) continue;
      keep.push(th);
      if (c0 + fr.w < 0 || c0 >= GW) continue;
      for (const f of figs) {
        const [b0, , b1] = f.bbox;
        if (c0 > b1 || c0 + fr.w - 1 < b0) {
          // past this figure without a hit: it cleared the obstacle
          if (th.kind === 'obstacle' && !th.hit.has(f.id) && !th.passed.has(f.id)) {
            const past = this.dir > 0 ? c0 + fr.w - 1 < b0 : c0 > b1;
            if (past && th.near?.has(f.id)) {
              th.passed.add(f.id);
              f.streak++;
              this.score += 1;
              if (f.headCell) this.sparkle(L, f.headCell[0], f.headCell[1] - f.liftRows - 2, f.outfit.shirt, 6);
              this.events.push({ type: 'clear', x: f.cx, streak: f.streak });
              if (f.streak === p.crownAt) this.events.push({ type: 'crown', x: f.cx });
            }
          }
          continue;
        }
        if (th.kind === 'obstacle') (th.near ??= new Set()).add(f.id);
        const hits = this.overlap(th, fr, f, L, flipOf(this, th));
        if (!hits.n) continue;
        if (th.kind === 'coin') {
          th.dead = true;
          f.coins++;
          this.score += 1;
          this.sparkle(L, hits.c, hits.r - f.liftRows, [255, 210, 63], 10);
          this.events.push({ type: 'coin', x: f.cx });
          break;
        }
        if (th.kind === 'star') {
          th.dead = true;
          f.starUntil = t + p.starTime;
          this.sparkle(L, hits.c, hits.r - f.liftRows, [255, 255, 255], 24, true);
          this.events.push({ type: 'star', x: f.cx });
          break;
        }
        // an obstacle
        if (t < f.starUntil) {
          th.dead = true;
          this.score += 3;
          this.explode(L, th, fr);
          this.events.push({ type: 'smash', x: f.cx });
          break;
        }
        if (th.hit.has(f.id) || hits.n < p.hitCells || t < f.safeUntil) continue;
        th.hit.add(f.id);
        f.hitAt = t;
        f.safeUntil = t + p.safeTime;
        if (f.streak >= p.crownAt) this.events.push({ type: 'crownLost', x: f.cx });
        f.streak = 0;
        this.sparkle(L, hits.c, hits.r - f.liftRows, [255, 45, 85], 14);
        this.events.push({ type: 'hit', x: f.cx, high: th.high });
      }
    }
    this.things = keep;
    this.best = Math.max(this.best, this.score);

    // particles: cells that fly and fall
    const parts = [];
    for (const q of this.particles) {
      const u = (t - q.t0) / q.life;
      if (u >= 1) continue;
      q.vy += q.g * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      if (q.x < -2 || q.x > GW + 2 || q.y > GH + 2) continue;
      parts.push(q);
    }
    this.particles = parts;
  }

  /** cells where a thing overlaps a figure (lifted by its jump): count and one of them */
  overlap(th, fr, f, L, flip) {
    const g = f.grid;
    const GW = L.GW;
    const GH = L.GH;
    let n = 0;
    let hc = 0;
    let hr = 0;
    for (const [sx, sy] of fr.px) {
      const c = th.c0 + (flip ? fr.w - 1 - sx : sx);
      const r = th.r0 + sy + f.liftRows;
      if (c < 0 || c >= GW || r < 0 || r >= GH) continue;
      if (g[r * GW + c]) {
        n++;
        hc = c;
        hr = r;
      }
    }
    return { n, c: hc, r: hr };
  }

  /** a burst of cells (coin, hit) */
  sparkle(L, c, r, col, n, rainbowColors = false) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = rand(4, 14);
      this.particles.push({ x: c, y: r, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 6, g: 30, col: rainbowColors ? rainbow(i / n) : col, t0: this.time, life: rand(0.35, 0.7) });
    }
  }

  /** an obstacle falls apart into its cells */
  explode(L, th, fr) {
    for (const [sx, sy, col] of fr.px) {
      const a = Math.random() * Math.PI * 2;
      const v = rand(3, 12);
      this.particles.push({ x: th.c0 + sx, y: th.r0 + sy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 8, g: 35, col, t0: this.time, life: rand(0.4, 0.9) });
    }
  }

  /** dust at the feet when a figure jumps */
  dust(L, f) {
    const [b0, , b1] = f.bbox;
    const r = L.groundRow - 1;
    for (let i = 0; i < 8; i++) {
      const left = i % 2 === 0;
      this.particles.push({ x: left ? b0 - 0.5 : b1 + 0.5, y: r, vx: (left ? -1 : 1) * rand(3, 9), vy: -rand(1, 5), g: 12, col: [190, 170, 255], t0: this.time, life: rand(0.25, 0.45) });
    }
  }

  /** a figure appears: sparkles all over it */
  burst(L, f, kind) {
    const [b0, r0, b1, r1] = f.bbox;
    if (b1 < b0) return;
    for (let i = 0; i < 26; i++) {
      this.particles.push({ x: rand(b0, b1 + 1), y: rand(r0, r1 + 1), vx: rand(-2, 2), vy: -rand(2, 8), g: 0, col: kind === 'enter' ? [210, 240, 255] : [255, 255, 255], t0: this.time, life: rand(0.4, 0.9) });
    }
  }
}

/** sprites face left (coming from the right); from the left they are mirrored */
export function flipOf(game, th) {
  return game.dir < 0 && th.kind === 'obstacle';
}
