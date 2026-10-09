// The game: rounds of about 30 s. Obstacles roll in along the ground (jump over them) or fly in at
// head height (duck under them), coins hang in the air, now and then a star makes you invincible.
// Everything moves across the wall from one edge to the other and passes every figure on its way, so
// it works for one person as for ten.
//
// A round: the game waits until the tracking runs and somebody stands in the play zone, counts down
// 3-2-1-GO, then the obstacles come. Everybody has 3 lives; whoever loses the last one becomes a ghost
// and floats around until the next round. At the end the goal comes through. The round is over when
// the goal has crossed the wall or everybody is a ghost. Then everybody's points show above their
// heads, and the best one wears a crown in the next round.
//
// Points per round: +1 per obstacle you get past, +1 per coin, a bonus for reaching the goal alive.
//
// Positions: x in m from the wall's left edge, y in m above the game's ground line. Collisions are
// exact on the mosaic: an obstacle's cells against the figure's cells (lifted by its jump).

import { SPRITES, LOW, HIGH, rainbow } from './art.js';

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const COUNT = 3; // s of countdown
export const GOAL_W = 2; // cells
const AIR = 0.9; // s: a jump over an obstacle lasts about this long (spacing of the obstacles)
// the jump assist (carry)
const CLEAR_CELLS = 1; // the feet pass this many cells above an obstacle
const LEG_ROWS = 7; // the figure's lowest rows: what a ground obstacle can touch
const CARRY_AHEAD = 0.8; // s: obstacles that come within this time of the jump are carried over
const MERGE_GAP = 0.2; // s: two obstacles this close after each other: one long jump over both
const PAD = 0.03; // s before and after

export class Game {
  constructor() {
    this.time = 0;
    this.phase = 'wait'; // wait | count | run | end
    this.phaseAt = 0;
    this.round = 0;
    this.roundT = 0; // s since GO
    this.readyFor = 0;
    this.emptyFor = 0;
    this.speed = 1;
    this.dist = 0; // m scrolled
    this.things = []; // obstacles and items
    this.goal = null; // { x (m, left edge) }
    this.particles = [];
    this.events = [];
    this.nextSpawn = 2;
    this.dir = 1; // 1: from the right to the left, -1: from the left
    this.starDone = false;
    this.crowns = new Set(); // ids of the best of the last round
    this.results = []; // [{ id, score, best }] of the last round
    this.allDeadAt = -1;
    this.lastCount = 0;
  }

  /** the cell column of the left edge of a thing */
  col(L, x) {
    return Math.floor((x * L.pxX - L.ox) / L.cellPx);
  }

  /** the cell row of the bottom of a thing at y m above the ground */
  row(L, y) {
    return L.groundRow - 1 - Math.floor(y / L.cellMy + 1e-6);
  }

  setPhase(phase) {
    this.phase = phase;
    this.phaseAt = this.time;
  }

  /** a figure takes part in this round: 3 lives, no points yet */
  join(f, p) {
    f.round = this.round;
    f.lives = p.lives;
    f.alive = true;
    f.roundScore = 0;
    f.finished = false;
    f.safeUntil = 0;
    f.starUntil = 0;
    f.streak = 0;
  }

  spawn(L, p, people) {
    const T = this.roundT;
    const wallW = L.wallW;
    const w = (n) => n * L.cellMx;
    // where things start: out of sight beyond the edge, so the warning shows a moment before
    const lead = this.speed * p.warn;
    const enter = (width) => (this.dir > 0 ? wallW + lead : -lead - width);
    const along = (x, d) => x + this.dir * d; // further back in the line
    const duckY = p.figH * p.duckAt; // bottom of a flyer: you must be lower than this
    const running = this.phase === 'run';
    // waiting: only coins drift by (something to catch while nothing has started)
    const opts = running
      ? [
          ['low', 5],
          ['low2', T > 12 ? 1.2 : 0],
          ['high', T > 5 ? 2.8 : 0],
          ['coins', 1.2],
          ['lowCoins', 1.6],
          ['highLow', T > 16 ? 0.9 : 0],
          ['star', T > 8 && !this.starDone ? 0.35 : 0],
        ]
      : [['coins', 1]];
    let sum = 0;
    for (const o of opts) sum += o[1];
    let r = Math.random() * sum;
    let kind = opts[0][0];
    for (const [k, wgt] of opts) {
      if ((r -= wgt) <= 0) {
        kind = k;
        break;
      }
    }
    const air = AIR * this.speed; // m covered during one jump
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
        coin(along(x, ow / 2 - span / 2 + u * span), p.figH * 0.9 + p.jumpHeight * 0.5 * Math.sin(u * Math.PI));
      }
      len = Math.max(ow, span);
    } else if (kind === 'highLow') {
      const x = enter(w(11));
      const a = high(x);
      len = a + air * 1.6 + low(along(x, a + air * 1.6));
    } else if (kind === 'star') {
      const x = enter(w(7));
      this.things.push({ kind: 'star', type: 'star', x, y: p.figH * 0.9, w: 7, h: 7, phase: 0 });
      this.starDone = true;
      len = w(7);
    }
    // the gap to the next one: everybody must be able to land and look again
    const gap = air + this.speed * p.gap;
    this.nextSpawn = this.dist + len + (gap * rand(1, 1.7)) / Math.max(0.2, running ? p.density : 0.5);
  }

  /** the round is over: points, the crown for the best */
  finish(figs, L) {
    this.results = figs.filter((f) => f.round === this.round).map((f) => ({ id: f.id, score: f.roundScore ?? 0 }));
    const best = Math.max(0, ...this.results.map((r) => r.score));
    this.crowns = new Set(best > 0 ? this.results.filter((r) => r.score === best).map((r) => r.id) : []);
    for (const r of this.results) r.best = this.crowns.has(r.id);
    for (const f of figs) if (this.crowns.has(f.id)) this.confetti(L, f, 60);
    this.setPhase('end');
    this.events.push({ type: 'end', x: 3 });
    this.goal = null;
  }

  /**
   * One step. figs: the players (people.js) on the wall now, L: the mosaic layout, p: the params,
   * o: { ready (tracking runs), entered, jumped (figures), lag (s the figures lag behind the people:
   * latency compensation) }.
   */
  step(dt, figs, L, p, o) {
    this.time += dt;
    const t = this.time;
    const { entered, jumped, lag = 0 } = o;
    const pt = t - this.phaseAt;
    const people = figs.length > 0;
    this.emptyFor = people ? 0 : this.emptyFor + dt;

    // ---- the round ----
    if (this.phase === 'wait') {
      this.readyFor = o.ready && people ? this.readyFor + dt : 0;
      if (this.readyFor > p.waitFor) this.startCount(figs, p);
    } else if (this.phase === 'count') {
      if (!people) this.setPhase('wait');
      else {
        const n = Math.ceil(COUNT - pt);
        if (n !== this.lastCount && n > 0) this.events.push({ type: 'count', x: L.wallW / 2, n });
        this.lastCount = n;
        if (pt >= COUNT) {
          this.setPhase('run');
          this.roundT = 0;
          this.nextSpawn = this.dist + 0.5;
          this.events.push({ type: 'go', x: L.wallW / 2 });
        }
      }
    } else if (this.phase === 'run') {
      this.roundT += dt;
      if (this.emptyFor > 3) this.setPhase('wait'); // everybody left: no result
      const alive = figs.filter((f) => f.alive && f.round === this.round);
      if (people && !alive.length) {
        if (this.allDeadAt < 0) this.allDeadAt = t;
        if (t - this.allDeadAt > 1.2) this.finish(figs, L);
      } else this.allDeadAt = -1;
    } else if (this.phase === 'end') {
      if (pt > p.endTime) {
        if (people) this.startCount(figs, p);
        else this.setPhase('wait');
      }
    }
    for (const f of entered) {
      // joins the running round (once per round: stepping out of the zone does not revive a ghost)
      if (f.round !== this.round) this.join(f, p);
      this.burst(L, f, 'enter');
      this.events.push({ type: 'enter', x: f.cx });
    }

    // ---- speed and direction ----
    const running = this.phase === 'run';
    const ramp = Math.min(1, this.roundT / Math.max(5, p.roundSecs));
    const target = running ? p.speed * (1 + (p.speedMax - 1) * ramp) : p.speed * 0.6;
    this.speed += (target - this.speed) * Math.min(1, dt * 0.8);
    const move = this.speed * dt;
    this.dist += move;
    const want = p.from === 'links' ? -1 : p.from === 'rechts' ? 1 : 0;
    if (want && want !== this.dir && !this.things.length && !this.goal) this.dir = want;

    // ---- spawning: obstacles while the round runs, then the goal ----
    const goalLead = L.wallW / 2 / Math.max(0.3, this.speed); // the goal reaches the middle at roundSecs
    if (running && !this.goal && this.roundT >= p.roundSecs - goalLead) {
      this.goal = { x: this.dir > 0 ? L.wallW + this.speed * 0.3 : -this.speed * 0.3 - GOAL_W * L.cellMx, finished: new Set() };
      this.events.push({ type: 'goalIn', x: this.dir > 0 ? L.wallW : 0 });
    }
    const spawnUntil = p.roundSecs - goalLead - 1.2;
    if (this.dist >= this.nextSpawn && (this.phase === 'wait' || (running && this.roundT < spawnUntil))) this.spawn(L, p, people);
    else if (this.dist >= this.nextSpawn) this.nextSpawn = this.dist + 0.5;

    for (const f of jumped) {
      this.dust(L, f);
      this.events.push({ type: f.airJumps ? 'airjump' : 'jump', x: f.cx });
    }
    for (const f of figs) {
      if (f.justLanded) {
        f.justLanded = false;
        if (f.alive !== false) this.dust(L, f);
      }
      // running: a puff of dust behind the feet now and then (the figures run towards what comes)
      if (f.alive !== false && !f.airborne && t - (f.puff ?? 0) > 0.32 && f.bbox[2] >= f.bbox[0]) {
        f.puff = t + Math.random() * 0.1;
        const x = this.dir > 0 ? f.bbox[0] - 1 : f.bbox[2] + 1;
        this.particles.push({ x, y: L.groundRow - 1, vx: -this.dir * rand(2, 5), vy: -rand(1, 3), g: 6, col: [120, 100, 210], t0: t, life: rand(0.25, 0.4) });
      }
    }

    // ---- the goal: crosses the wall; whoever it passes alive has made it ----
    if (this.goal) {
      const g = this.goal;
      g.x -= this.dir * move;
      const gc = this.col(L, g.x);
      for (const f of figs) {
        if (!f.alive || f.round !== this.round || g.finished.has(f.id)) continue;
        const mid = (f.bbox[0] + f.bbox[2]) / 2;
        if (this.dir > 0 ? gc <= mid : gc + GOAL_W - 1 >= mid) {
          g.finished.add(f.id);
          f.finished = true;
          f.roundScore += p.goalBonus;
          this.confetti(L, f);
          this.events.push({ type: 'finish', x: f.cx });
        }
      }
      if (running && (this.dir > 0 ? gc + GOAL_W < 0 : gc > L.GW)) this.finish(figs, L);
    }

    this.collide(dt, figs, L, p, lag, move);
    if (p.assist) for (const f of jumped) this.carry(f, L, p, lag);

    // particles: cells that fly and fall
    const parts = [];
    for (const q of this.particles) {
      const u = (t - q.t0) / q.life;
      if (u >= 1) continue;
      q.vy += q.g * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      if (q.x < -2 || q.x > L.GW + 2 || q.y > L.GH + 2) continue;
      parts.push(q);
    }
    this.particles = parts;
  }

  startCount(figs, p) {
    this.round++;
    this.setPhase('count');
    this.lastCount = 0;
    this.things = [];
    if (p.from === 'abwechselnd' && this.round > 1) this.dir = -this.dir; // every round from the other side
    this.goal = null;
    this.starDone = false;
    this.allDeadAt = -1;
    for (const f of figs) this.join(f, p);
  }

  /**
   * Move the things and check them against the players. Latency compensation: a figure shows the
   * person as they were `lag` seconds ago (tracking, jump detection, display). So the figures are
   * checked against where the obstacles were back then: shifted `back` cells towards where they come
   * from. Whoever jumped or ducked in time on the obstacles they saw is safe, even if the figure goes
   * up a moment late. Coins and stars count at either place (generous).
   */
  collide(dt, figs, L, p, lag, move) {
    const t = this.time;
    const GW = L.GW;
    const back = Math.round((this.dir * this.speed * Math.max(0, lag)) / L.cellMx);
    const players = figs.filter((f) => f.alive && f.round === this.round);
    const playing = this.phase === 'run' || this.phase === 'count';
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
      const obstacle = th.kind === 'obstacle';
      if (Math.max(c0, c0 + back) + fr.w - 1 < 0 || Math.min(c0, c0 + back) >= GW) continue;
      const flip = flipOf(this, th);
      // obstacles only hit while the round runs; coins can be caught any time (count while it runs)
      const targets = this.phase === 'run' ? players : obstacle ? [] : figs.filter((f) => f.alive !== false);
      for (const f of targets) {
        const [b0, , b1] = f.bbox;
        // where it is checked: shifted back (latency); for a figure carried over it (see carry), from
        // the top of the jump on where it is now, so the figure lands right behind it
        const cc = obstacle ? c0 + ((th.visualFrom?.get(f.id) ?? Infinity) <= t ? 0 : back) : c0;
        const lo = obstacle ? cc : Math.min(c0, c0 + back);
        const hi = (obstacle ? cc : Math.max(c0, c0 + back)) + fr.w - 1;
        if (lo > b1 || hi < b0) {
          // past this figure without a hit: it cleared the obstacle
          if (obstacle && !th.hit.has(f.id) && !th.passed.has(f.id)) {
            const past = this.dir > 0 ? hi < b0 : lo > b1;
            if (past && th.near?.has(f.id)) {
              th.passed.add(f.id);
              f.streak = (f.streak ?? 0) + 1;
              f.roundScore += 1;
              if (f.headCell) this.sparkle(L, f.headCell[0], f.headCell[1] - f.liftRows - 2, f.outfit.shirt, 6);
              this.events.push({ type: 'clear', x: f.cx, streak: f.streak });
            }
          }
          continue;
        }
        if (obstacle && th.passed.has(f.id)) continue; // already past it
        if (obstacle) (th.near ??= new Set()).add(f.id);
        let hits = this.overlap(th, fr, f, L, flip, cc);
        let at = cc;
        if (!obstacle && !hits.n && back) {
          hits = this.overlap(th, fr, f, L, flip, c0 + back);
          at = c0 + back;
        }
        if (!hits.n) continue;
        const vc = hits.c - (at - c0); // the cell on the wall now (for effects)
        if (th.kind === 'coin') {
          th.dead = true;
          if (playing && f.round === this.round) f.roundScore += 1;
          this.sparkle(L, vc, hits.r - f.liftRows, [255, 210, 63], 10);
          this.events.push({ type: 'coin', x: f.cx });
          break;
        }
        if (th.kind === 'star') {
          th.dead = true;
          f.starUntil = t + p.starTime;
          this.sparkle(L, vc, hits.r - f.liftRows, [255, 255, 255], 24, true);
          this.events.push({ type: 'star', x: f.cx });
          break;
        }
        // an obstacle
        if (t < f.starUntil) {
          th.dead = true;
          f.roundScore += 2;
          this.explode(L, th, fr);
          this.events.push({ type: 'smash', x: f.cx });
          break;
        }
        if (th.hit.has(f.id) || hits.n < p.hitCells || t < f.safeUntil) continue;
        // grace: a contact only counts when the figure still touches the obstacle a moment later;
        // a jump (or duck) in between saves it
        const contact = (th.contact ??= new Map()).get(f.id);
        if (contact === undefined || t - contact > 1) {
          th.contact.set(f.id, t);
          if (p.grace > 0) continue;
        } else if (t - contact < p.grace) continue;
        th.hit.add(f.id);
        f.hitAt = t;
        f.safeUntil = t + p.safeTime;
        f.streak = 0;
        f.lives -= 1;
        this.sparkle(L, vc, hits.r - f.liftRows, [255, 45, 85], 14);
        if (f.lives <= 0) {
          f.alive = false;
          f.diedAt = t;
          this.burst(L, f, 'ghost');
          this.events.push({ type: 'die', x: f.cx });
        } else this.events.push({ type: 'hit', x: f.cx, high: th.high });
      }
    }
    this.things = keep;
  }

  /**
   * Jump assist: whoever jumps with the right timing comes over the obstacle well, without flying
   * much more than needed. The jump that just started (f.jump) is stretched over the ground
   * obstacles that will pass below the figure's legs. Rising, the figure is checked against where
   * the obstacle was `lag` s ago (the takeoff was late by the latency, not the person); from the top
   * on against where it is on the wall, so the figure lands right behind it and does not hang in the
   * air for the latency (a moment less: half the grace). Two close after each other make one long
   * jump. See Figure.carry.
   */
  carry(f, L, p, lag) {
    if (!f.jump || !f.grid || f.bbox[2] < f.bbox[0]) return;
    // the columns of the legs: the lowest rows of the figure (before the lift)
    const GW = L.GW;
    const [c0, , c1, r1] = f.bbox;
    let l0 = GW;
    let l1 = -1;
    for (let r = Math.max(0, r1 - LEG_ROWS + 1); r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (!f.grid[r * GW + c]) continue;
        if (c < l0) l0 = c;
        if (c > l1) l1 = c;
      }
    }
    if (l1 < l0) return;
    const vc = Math.max(0.1, this.speed) / L.cellMx; // cells per s
    const late = Math.min(Math.max(0, lag), p.grace * 0.5); // s: the end may use half the grace
    const wins = [];
    for (const th of this.things) {
      if (th.kind !== 'obstacle' || th.high || th.dead || th.hit.has(f.id) || th.passed.has(f.id) || !th.frame) continue;
      const lo = (th.x * L.pxX - L.ox) / L.cellPx; // its left edge on the wall now (cells)
      const hi = lo + th.frame.w;
      // reaches the legs and leaves them, on the wall now
      const a = (this.dir > 0 ? lo - (l1 + 1) : l0 - hi) / vc;
      const b = (this.dir > 0 ? hi - l0 : l1 + 1 - lo) / vc;
      if (b - late <= 0) continue;
      wins.push({ th, a, up: a + Math.max(0, lag) - PAD, b: b - late + PAD, clear: (th.frame.h + CLEAR_CELLS) * L.cellMy });
    }
    wins.sort((x, y) => x.a - y.a);
    let w = null;
    for (const x of wins) {
      if (!w) {
        if (x.a > CARRY_AHEAD) break;
        w = { ...x, list: [x.th] };
      } else if (x.a - w.b <= MERGE_GAP) {
        w.b = Math.max(w.b, x.b);
        w.clear = Math.max(w.clear, x.clear);
        w.list.push(x.th);
      } else break;
    }
    if (!w) return;
    // up when it comes where it is checked while rising (the takeoff counts with the latency
    // compensation), still up when it has left the legs where it is seen
    f.carry(this.time, w.up, w.b, w.clear, p);
    const top = f.jump.t0 + f.jump.ta;
    for (const th of w.list) (th.visualFrom ??= new Map()).set(f.id, top);
  }

  /** cells where a thing overlaps a figure (lifted by its jump): count and one of them */
  overlap(th, fr, f, L, flip, c0 = th.c0) {
    const g = f.grid;
    const GW = L.GW;
    const GH = L.GH;
    let n = 0;
    let hc = 0;
    let hr = 0;
    for (const [sx, sy] of fr.px) {
      const c = c0 + (flip ? fr.w - 1 - sx : sx);
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

  /** confetti over a figure that reached the goal (and for the winner) */
  confetti(L, f, n = 30) {
    const [b0, r0, b1] = f.bbox;
    for (let i = 0; i < n; i++) {
      this.particles.push({ x: rand(b0 - 3, b1 + 4), y: r0 - f.liftRows - rand(2, 8), vx: rand(-6, 6), vy: -rand(4, 14), g: 22, col: rainbow(Math.random()), t0: this.time, life: rand(0.8, 1.4) });
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

  /** dust at the feet when a figure jumps or lands */
  dust(L, f) {
    const [b0, , b1] = f.bbox;
    const r = L.groundRow - 1 - (f.airborne ? f.liftRows : 0);
    for (let i = 0; i < 8; i++) {
      const left = i % 2 === 0;
      this.particles.push({ x: left ? b0 - 0.5 : b1 + 0.5, y: r, vx: (left ? -1 : 1) * rand(3, 9), vy: -rand(1, 5) * (f.airborne ? -0.5 : 1), g: 12, col: [190, 170, 255], t0: this.time, life: rand(0.25, 0.45) });
    }
  }

  /** a figure appears (sparkles all over it) or turns into a ghost (pale puffs rising) */
  burst(L, f, kind) {
    const [b0, r0, b1, r1] = f.bbox;
    if (b1 < b0) return;
    const ghost = kind === 'ghost';
    for (let i = 0; i < (ghost ? 40 : 26); i++) {
      this.particles.push({ x: rand(b0, b1 + 1), y: rand(r0, r1 + 1) - f.liftRows, vx: rand(-2, 2), vy: -rand(2, ghost ? 12 : 8), g: 0, col: ghost ? [170, 225, 255] : [210, 240, 255], t0: this.time, life: rand(0.4, ghost ? 1.2 : 0.9) });
    }
  }
}

/** sprites face left (coming from the right); from the left they are mirrored */
export function flipOf(game, th) {
  return game.dir < 0 && th.kind === 'obstacle';
}
