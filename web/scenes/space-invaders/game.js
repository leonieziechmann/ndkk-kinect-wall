// The game, in "art pixels" of the map (x right along the wall, y = the depth of the room in front
// of the wall; see main.js for the mapping). Space Invaders turned by 90 degrees, twice: one formation
// comes from the left edge, one from the right one. They march up and down the map and step closer
// to the city in the middle whenever they reach the top or the bottom; at the city they storm it.
//
// The people (body.js, from the masks) defend it. Control schemes (param `control`):
//   Automatik   every unit fires at the nearest invader on its own: you aim by where you stand;
//               standing still builds a fort (fires faster, draws fire)
//   Zeigen      an arm that sticks out fires; the shot locks onto what it points at
//   both        automatic fire, and pointing takes over while an arm points
// Always: a laser between people standing close together, arms block bullets and destroy invaders
// they touch, a body hit stuns for a moment. Jumping starts the boost: faster fire, double damage,
// more range, full fire also on the move; the hexagon around the unit is its energy, used up while
// boosting and charged again afterwards (a bent power bar).
//
// Balance: a director, as in Left 4 Dead.
//   - The crowd (people present, smoothed) sizes every wave: more rows and columns, more hit points,
//     more fire, more divers. Changes in the crowd act live on fire and divers.
//   - A skill rating learns how the crowd does: a wave cleared fast and clean raises it, a storm on
//     the city or a fallen city lowers it. difficulty = (1 + 0.1 * (wave - 1)) * skill.
//   - The city heals only as a reward: after a wave (more after a clean one), or by shooting the
//     mothership. When it falls below `cityFall` it collapses (a lost game): chain explosions, the
//     invaders dance, then everything starts over from wave 1 with a lower skill rating.
//   - Mercy: a city below 40 % brings the mothership (it repairs the city when shot). Pressure: a
//     crowd that wipes out a wave fast gets divers.
//   - Alone it is easier: `ease` (0.65 with one person, 1 from three on) scales the enemies' fire,
//     divers, mines, edge lasers, hit points and the battleship.
//
// Threats that make people move: invaders glow red in the eyes before they shoot; bombers lob mines
// that explode after a warning pulse; from wave `shipFrom` on a battleship comes, flies over a
// person (forts first), charges with a warning stripe on the floor and fires a thick laser across the
// whole map: whoever stands in it is hit hard, the city gets a trench, and invaders in it burn too
// (lure it into them). Shot down, it explodes in a chain and repairs the city. From wave `edgeFrom` on,
// emitters at the left and right edge fire lasers across the map at an angle, through somebody's
// place: first only the middle line shows, then the beam opens up.
//
// Power-ups (walk onto them; dropped where the Kinect can see people, away from everybody): repair,
// rapid fire, a fan of three shots, a shield for three hits, a nova (a big shock wave), a mega laser
// of one's own, slow motion for every enemy. More of them when the crowd struggles (the director),
// repairs more likely when the city is low; the mothership and the battleship drop some.

import { SPRITES, INVADER_TYPES, SHIP_W, SHIP_H, POWER_COLORS, neon } from './pixels.js';

const PX = 15; // formation cell (art px)
const PY = 12;
const SPRITE_H = 8;
const POINTS = { squid: 30, crab: 20, octopus: 10 };
const HP = { squid: 2, crab: 2, octopus: 1 };
const WHITE = [1, 1, 1];
const RED = [1, 0.16, 0.24];
const ORANGE = [1, 0.42, 0.12];
const EMBER = [1, 0.35, 0.08];
const SHIELD = [0.55, 0.95, 1];
const BEAM = [1, 0.25, 0.55];
const POWERS = ['repair', 'rapid', 'spread', 'shield', 'nova', 'mega', 'slow'];

/** distance from (px, py) to the infinite line through a and b */
function lineDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.abs(dy * (px - ax) - dx * (py - ay)) / Math.max(1e-6, Math.hypot(dx, dy));
}

export const CITY = { EMPTY: 0, WALL: 1, TOWER: 2, HOUSE: 3, HOUSE2: 4, CORE: 5 };

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / Math.max(dx * dx + dy * dy, 1e-6), 0, 1);
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

/** does the segment a-b cross the box (x0, y0)-(x1, y1)? (Liang-Barsky) */
function segBox(ax, ay, bx, by, x0, y0, x1, y1) {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  for (const [p, q] of [
    [-dx, ax - x0],
    [dx, x1 - ax],
    [-dy, ay - y0],
    [dy, y1 - ay],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
  }
  return true;
}

/** a walled city seen from above, w x h art px: energy walls with towers, blocks of houses, lit windows */
function buildCity(w, h) {
  const base = new Uint8Array(w * h);
  const win = new Uint8Array(w * h);
  const set = (x, y, t) => {
    if (x >= 0 && y >= 0 && x < w && y < h) base[y * w + x] = t;
  };
  for (let y = 0; y < h; y++) {
    set(0, y, CITY.WALL);
    set(w - 1, y, CITY.WALL);
  }
  for (let y = 4; y < h - 3; y += 13) {
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 3; i++) {
        set(i, y + j, CITY.TOWER);
        set(w - 1 - i, y + j, CITY.TOWER);
      }
    }
  }
  const x0 = 3;
  const x1 = w - 4;
  let y = 1;
  while (y < h - 2) {
    const bh = 3 + Math.floor(Math.random() * 3);
    let x = x0;
    while (x < x1) {
      const bw = 3 + Math.floor(Math.random() * 4);
      if (Math.random() > 0.22) {
        const t = Math.random() < 0.55 ? CITY.HOUSE : CITY.HOUSE2;
        for (let j = 0; j < bh && y + j < h - 1; j++) {
          for (let i = 0; i < bw && x + i <= x1; i++) {
            set(x + i, y + j, t);
            // a few windows inside the roofs, never on the edge
            if (j > 0 && i > 0 && j < bh - 1 && i < bw - 1 && Math.random() < 0.18) win[(y + j) * w + x + i] = 1;
          }
        }
      }
      x += bw + 1;
    }
    y += bh + 1;
  }
  // the palace at the top in the middle (where the Kinect stands)
  const cw = Math.min(10, w - 8);
  for (let j = 0; j < 6; j++) for (let i = 0; i < cw; i++) set(Math.floor((w - cw) / 2) + i, 1 + j, CITY.CORE);
  return { base, win };
}

export class Game {
  constructor(fx) {
    this.fx = fx;
    this.L = null;
    this.events = [];
    this.time = 0;
    this.best = 0;
    this.P = null;
    this.skill = 1;
    this.crowd = 0;
  }

  /** layout: { AW, AH, sx, sy, cityX0, cityW } (art px); a new layout restarts the game */
  setLayout(L) {
    this.L = L;
    const { base, win } = buildCity(L.cityW, L.AH);
    const n = base.length;
    this.city = { x0: L.cityX0, w: L.cityW, h: L.AH, base, win, alive: base.slice(), dead: [], deadAt: new Float32Array(n).fill(-99), born: new Float32Array(n).fill(-99), hitAt: -9, total: 0 };
    this.city.total = base.reduce((k, t) => k + (t ? 1 : 0), 0);
    this.resetAll();
  }

  resetAll() {
    this.level = 1;
    this.skill = 1;
    this.score = 0;
    this.clearField();
    this.healCity(1, true);
    this.players = new Map();
    this.linkState = new Map();
    this.emptyFor = 0;
    this.dirty = false;
    this.startWave();
  }

  clearField() {
    this.shots = [];
    this.bullets = [];
    this.divers = [];
    this.particles = [];
    this.booms = [];
    this.waves = [];
    this.links = [];
    if (this.ufo) this.events.push({ type: 'ufo', on: false, x: 0 });
    this.ufo = null;
    this.nextUfo = this.time + 18;
    this.pending = [];
    this.bombs = [];
    this.scorches = [];
    if (this.ship) this.events.push({ type: 'beam', on: false, x: 0 });
    this.ship = null;
    this.shipDeath = null;
    this.beatAt = -9;
    this.items = [];
    this.edgeLasers = [];
    this.nextItem = this.time + 10;
    this.enemySlowUntil = 0;
    this.edgeAcc = 0;
    this.party = 0;
    this.alarm = 0;
  }

  /** the director's difficulty: wave and skill */
  get difficulty() {
    return (1 + 0.1 * (this.level - 1)) * this.skill;
  }

  get crowdN() {
    return Math.max(1, this.crowd);
  }

  /** alone it is easier: 0.65 with one person, 1 from three on */
  get ease() {
    return 0.65 + 0.35 * clamp((this.crowdN - 1) / 2, 0, 1);
  }

  startWave() {
    const L = this.L;
    const P = this.P ?? {};
    const N = Math.max(1, Math.round(this.crowd));
    const D = this.difficulty;
    const maxRows = Math.max(1, Math.floor((L.AH - 6) / PY));
    const rows = clamp(Math.round(P.rows ?? 4) + Math.floor((N - 1) / 2), 2, maxRows);
    const cols = clamp(Math.round(P.cols ?? 3) + Math.floor((N - 1) / 3) + Math.floor(Math.max(0, D - 1) * 1.5), 1, 6);
    const hpMul = (0.75 + 0.25 * D) * (1 + 0.15 * (N - 1)) * (0.75 + 0.25 * this.ease);
    const height = rows * PY - (PY - SPRITE_H);
    const width = cols * PX;
    const fy = Math.round((L.AH - height) / 2);
    const t = this.time;
    this.sides = [-1, 1].map((edge) => {
      const side = {
        edge, // -1 comes from the left edge, +1 from the right one
        dirX: -edge, // the way to the city
        rows,
        cols,
        width,
        height,
        fx: edge < 0 ? 2 : L.AW - 2 - width,
        fy,
        ydir: edge < 0 ? 1 : -1,
        alive: new Uint8Array(rows * cols).fill(1),
        hp: new Uint8Array(rows * cols),
        hpMax: null,
        flash: new Float32Array(rows * cols).fill(-9),
        kickX: new Float32Array(rows * cols),
        kickY: new Float32Array(rows * cols),
        kickAt: new Float32Array(rows * cols).fill(-9),
        shield: new Uint8Array(rows * cols),
        shieldHit: new Float32Array(rows * cols).fill(-9),
        charge: new Float32Array(rows * cols).fill(-9),
        spawn: new Float32Array(rows * cols),
        count: rows * cols,
        storm: null,
        stormT: 0,
        crashed: false,
      };
      for (let i = 0; i < side.hp.length; i++) {
        const c = i % cols;
        const r = (i / cols) | 0;
        side.hp[i] = Math.max(1, Math.round(HP[this.typeOf(side, c)] * hpMul));
        // they warp in column by column, from the outside in
        const outer = edge < 0 ? c : cols - 1 - c;
        side.spawn[i] = t + 0.5 + outer * 0.22 + r * 0.06 + Math.random() * 0.05;
      }
      side.hpMax = side.hp.slice();
      // shields from wave 2 on: the front column first, more with difficulty
      const shieldChance = this.level >= 2 ? clamp(0.15 + (D - 1) * 0.5, 0, 0.7) : 0;
      for (let i = 0; i < side.hp.length; i++) {
        const outer = edge < 0 ? i % cols : cols - 1 - (i % cols);
        if (outer >= cols - 2 && Math.random() < shieldChance) side.shield[i] = 2 + (D > 1.6 ? 1 : 0);
      }
      return side;
    });
    this.total = rows * cols * 2;
    this.phase = 'enter';
    this.phaseT = 0;
    this.beatT = 0;
    this.beat = 0;
    this.frameAnim = 0;
    this.fireAcc = 0;
    this.diveAcc = 0;
    this.stats = { t0: t, dead0: this.city.dead.length, hits: 0, storms: 0, mercy: false, pressure: false };
    this.bombAcc = 0;
    this.camp = 0;
    this.nextShip = t + (P.shipFirst ?? 18) * rand(0.9, 1.2);
    this.events.push({ type: 'enter', x: L.AW / 2 });
  }

  // ---- geometry of the formations
  typeOf(side, c) {
    const outer = side.edge < 0 ? c : side.cols - 1 - c; // 0 = the column farthest from the city
    const k = side.cols > 1 ? Math.round((outer / (side.cols - 1)) * 2) : 2;
    return INVADER_TYPES[k];
  }

  /** the box of invader i of a side: [x, y, w, h, type] */
  box(side, i, out = [0, 0, 0, 0, '']) {
    const c = i % side.cols;
    const r = (i / side.cols) | 0;
    const type = this.typeOf(side, c);
    const w = SPRITES[type][0].w;
    const bob = this.phase === 'fall' ? Math.round(Math.sin(this.time * 9 + c * 1.3 + r) * 1.5) : 0; // they dance
    out[0] = Math.round(side.fx + c * PX + (PX - w) / 2);
    out[1] = Math.round(side.fy + r * PY) + bob;
    out[2] = w;
    out[3] = SPRITE_H;
    out[4] = type;
    return out;
  }

  /** is invader i there (alive, warped in, not storming)? */
  present(side, i) {
    return side.alive[i] && this.time >= side.spawn[i] && !side.storm?.includes(i);
  }

  bounds(side) {
    let minY = 1e9;
    let maxY = -1e9;
    let front = side.dirX > 0 ? -1e9 : 1e9;
    const b = [0, 0, 0, 0, ''];
    for (let i = 0; i < side.alive.length; i++) {
      if (!side.alive[i]) continue;
      this.box(side, i, b);
      minY = Math.min(minY, b[1]);
      maxY = Math.max(maxY, b[1] + b[3]);
      front = side.dirX > 0 ? Math.max(front, b[0] + b[2]) : Math.min(front, b[0]);
    }
    return { minY, maxY, front };
  }

  /** every target: formation invaders ({ side, i }), divers ({ diver }), the mothership ({ ufo }) */
  forTargets(fn, withUfo = true) {
    const b = [0, 0, 0, 0, ''];
    for (const side of this.sides) {
      if (!side.count) continue;
      for (let i = 0; i < side.alive.length; i++) {
        if (!this.present(side, i)) continue;
        this.box(side, i, b);
        if (fn({ side, i }, b[0], b[1], b[2], b[3]) === false) return;
      }
    }
    for (const d of this.divers) if (fn({ diver: d }, d.x - 6, d.y - 4, 12, 8) === false) return;
    if (withUfo && this.ufo && fn({ ufo: this.ufo }, this.ufo.x, this.ufo.y, 16, 7) === false) return;
    if (withUfo && this.ship) fn({ ship: this.ship }, this.ship.x, this.ship.y, SHIP_W, SHIP_H);
  }

  targetAt(x, y, pad = 0) {
    let hit = null;
    this.forTargets((tg, bx, by, bw, bh) => {
      if (x >= bx - pad && x < bx + bw + pad && y >= by - pad && y < by + bh + pad) {
        hit = tg;
        return false;
      }
      return true;
    });
    return hit;
  }

  /** where a target is now (its center), or null when it is gone */
  targetPos(tg) {
    if (!tg) return null;
    if (tg.ufo) return this.ufo === tg.ufo ? [tg.ufo.x + 8, tg.ufo.y + 3.5] : null;
    if (tg.ship) return this.ship === tg.ship ? [tg.ship.x + SHIP_W / 2, tg.ship.y + SHIP_H / 2] : null;
    if (tg.diver) return this.divers.includes(tg.diver) ? [tg.diver.x, tg.diver.y] : null;
    if (!this.present(tg.side, tg.i)) return null;
    const b = this.box(tg.side, tg.i);
    return [b[0] + b[2] / 2, b[1] + b[3] / 2];
  }

  /** aim assist: the target closest to the direction dir from (x, y), within cone (rad) */
  lockOn(x, y, dir, cone) {
    let best = null;
    let bestScore = Infinity;
    const AW = this.L.AW;
    this.forTargets((tg, bx, by, bw, bh) => {
      const dx = bx + bw / 2 - x;
      const dy = by + bh / 2 - y;
      const d = Math.hypot(dx, dy);
      if (d < 1) return true;
      const ang = Math.acos(clamp((dx * dir[0] + dy * dir[1]) / d, -1, 1));
      if (ang > cone) return true;
      const score = ang + (d / AW) * 0.6 - (tg.diver ? 0.3 : 0); // divers first
      if (score < bestScore) {
        bestScore = score;
        best = tg;
      }
      return true;
    });
    return best;
  }

  /** automatic fire: the nearest target within range (m); divers count double near */
  nearest(x, y, range) {
    const L = this.L;
    let best = null;
    let bd = range;
    this.forTargets((tg, bx, by, bw, bh) => {
      const d = Math.hypot((bx + bw / 2 - x) / L.sx, (by + bh / 2 - y) / L.sy) * (tg.diver ? 0.6 : 1);
      if (d < bd) {
        bd = d;
        best = tg;
      }
      return true;
    });
    return best;
  }

  // ---- effects
  burst(x, y, n, col, speed, life, col2 = null) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random() * 0.9);
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, col: col2 && Math.random() < 0.4 ? col2 : col, t0: this.time, life: life * rand(0.6, 1.2) });
    }
  }

  /** a sprite goes to pieces: its own pixels fly apart, away from where the hit came from */
  shatter(x0, y0, type, col, col2, push = null, power = 1) {
    const frames = SPRITES[type];
    const f = frames[this.frameAnim % frames.length];
    const cx = x0 + f.w / 2;
    const cy = y0 + f.h / 2;
    for (let j = 0; j < f.h; j++) {
      for (let i = 0; i < f.w; i++) {
        if (!f.bits[j * f.w + i]) continue;
        const dx = x0 + i - cx + rand(-1.5, 1.5);
        const dy = y0 + j - cy + rand(-1.5, 1.5);
        const v = rand(10, 38) * power;
        const d = Math.hypot(dx, dy) || 1;
        const px = push ? push[0] * rand(12, 40) : 0;
        const py = push ? push[1] * rand(12, 40) : 0;
        this.particles.push({ x: x0 + i, y: y0 + j, vx: (dx / d) * v + px, vy: (dy / d) * v + py, col: Math.random() < 0.35 ? col2 : col, t0: this.time, life: rand(0.5, 1.2) });
      }
    }
    this.booms.push({ x: cx, y: cy, t0: this.time, col: WHITE });
  }

  /** combo of a person: kills in quick succession */
  combo(slot) {
    let combo = 0;
    for (const s of this.players.values()) {
      if (s.slot !== slot) continue;
      s.combo = this.time - s.lastKill < 0.9 ? s.combo + 1 : 0;
      s.lastKill = this.time;
      combo = s.combo;
    }
    return combo;
  }

  /** a hit on a target: damage; white flash and a tick, destroyed at 0 hit points */
  damage(tg, amount, slot, col, invCol, push = null) {
    const t = this.time;
    if (tg.ufo) return this.killUfo(col);
    if (tg.ship) return this.damageShip(tg.ship, amount, col);
    if (tg.diver) {
      const d = tg.diver;
      if (!this.divers.includes(d)) return;
      d.hp -= amount;
      d.flash = t;
      if (d.hp > 0) return this.events.push({ type: 'ping', x: d.x });
      this.divers = this.divers.filter((q) => q !== d);
      this.explodeDiver(d, col, slot, invCol);
      return;
    }
    const { side, i } = tg;
    if (!side.alive[i]) return;
    const b = this.box(side, i);
    const cx = b[0] + b[2] / 2;
    const cy = b[1] + b[3] / 2;
    // knocked back a little, away from the hit
    const kd = push ? Math.hypot(push[0], push[1]) || 1 : 1;
    side.kickX[i] = push ? (push[0] / kd) * 2 : side.dirX * -2;
    side.kickY[i] = push ? (push[1] / kd) * 2 : 0;
    side.kickAt[i] = t;
    // a shield takes the hits first
    if (side.shield[i] > 0 && amount < 9) {
      side.shield[i]--;
      side.shieldHit[i] = t;
      const broken = side.shield[i] === 0;
      this.burst(cx, cy, broken ? 26 : 6, SHIELD, broken ? 45 : 25, broken ? 0.6 : 0.25, WHITE);
      this.fx.light(cx, cy, broken ? 0.6 : 0.35, broken ? 2 : 1, SHIELD, broken ? 0.3 : 0.12);
      this.events.push({ type: broken ? 'shieldBreak' : 'shield', x: cx });
      return;
    }
    if (side.hp[i] > amount) {
      side.hp[i] -= amount;
      side.flash[i] = t;
      this.burst(cx - (push?.[0] ?? 0) * 4, cy - (push?.[1] ?? 0) * 3, 5, WHITE, 22, 0.25, col);
      this.fx.light(cx, cy, 0.3, 0.9, WHITE, 0.1);
      this.events.push({ type: 'ping', x: cx });
      return;
    }
    side.alive[i] = 0;
    side.count--;
    this.score += POINTS[b[4]];
    this.best = Math.max(this.best, this.score);
    this.dirty = true;
    const combo = this.combo(slot);
    const icol = invCol(b[4]);
    this.shatter(b[0], b[1], b[4], icol, col, push, 1 + Math.min(combo, 8) * 0.08);
    this.fx.light(cx, cy, 0.6 + Math.min(combo, 8) * 0.05, 1.8, icol, 0.35);
    this.fx.light(cx, cy, 0.25, 2.5, WHITE, 0.08);
    if (combo >= 4) this.fx.ripple(cx, cy, 2 + combo * 0.3, 5, 0.4);
    this.fx.kick(0.5 + Math.min(combo, 6) * 0.1);
    this.events.push({ type: 'kill', x: cx, slot, combo });
  }

  explodeDiver(d, col, slot, invCol) {
    const icol = invCol(d.type);
    this.shatter(d.x - 6, d.y - 4, d.type, icol, col ?? RED, null, 1.4);
    this.burst(d.x, d.y, 20, ORANGE, 45, 0.6, WHITE);
    this.fx.light(d.x, d.y, 0.9, 2.2, ORANGE, 0.4);
    this.fx.ripple(d.x, d.y, 3, 5, 0.45);
    this.fx.kick(1);
    if (slot) {
      if (Math.random() < 0.08) this.dropLater = (this.dropLater ?? 0) + 1;
      this.score += 50;
      this.best = Math.max(this.best, this.score);
      this.events.push({ type: 'kill', x: d.x, slot, combo: this.combo(slot) });
    } else this.events.push({ type: 'crash', x: d.x });
  }

  killUfo(col) {
    const u = this.ufo;
    if (!u) return;
    this.ufo = null;
    this.score += 100 + 50 * Math.floor(Math.random() * 5);
    this.best = Math.max(this.best, this.score);
    this.shatter(u.x, u.y, 'ufo', RED, col, null, 2);
    this.burst(u.x + 8, u.y + 3, 80, WHITE, 80, 1.3, col);
    this.burst(u.x + 8, u.y + 3, 40, ORANGE, 50, 1, RED);
    this.party = this.time + 1.5;
    // the reward: the city is repaired
    this.repair = (this.repair ?? 0) + Math.round(this.city.total * 0.18);
    this.fx.flash(WHITE, 0.35);
    this.fx.kick(3, 1.6);
    this.fx.ripple(u.x + 8, u.y + 3, 9, 7, 1);
    this.fx.light(u.x + 8, u.y + 3, 2.2, 3, RED, 0.8);
    this.fx.slow(0.6, 0.25);
    this.events.push({ type: 'ufo', on: false, x: u.x });
    this.events.push({ type: 'ufoKill', x: u.x + 8 });
    this.dropLater = (this.dropLater ?? 0) + 1;
  }

  // ---- the city
  cityAt(x, y) {
    const c = this.city;
    const i = Math.floor(x) - c.x0;
    const j = Math.floor(y);
    if (i < 0 || j < 0 || i >= c.w || j >= c.h) return false;
    return c.alive[j * c.w + i] > 0;
  }

  erode(x, y, r) {
    const c = this.city;
    let n = 0;
    const R = Math.ceil(r);
    for (let j = -R; j <= R; j++) {
      for (let i = -R; i <= R; i++) {
        const d = Math.hypot(i, j);
        if (d > r || Math.random() < (d / r) ** 2 * 0.8) continue;
        const cx = Math.floor(x) - c.x0 + i;
        const cy = Math.floor(y) + j;
        if (cx < 0 || cy < 0 || cx >= c.w || cy >= c.h) continue;
        const k = cy * c.w + cx;
        if (!c.alive[k]) continue;
        c.alive[k] = 0;
        c.deadAt[k] = this.time;
        c.dead.push(k);
        n++;
      }
    }
    if (n) {
      this.dirty = true;
      c.hitAt = this.time;
    }
    return n;
  }

  /** the city grows back: n cells (random order, so it looks like building) */
  regrow(n) {
    const c = this.city;
    while (n-- > 0 && c.dead.length) {
      const j = Math.floor(Math.random() * c.dead.length);
      const k = c.dead[j];
      c.dead[j] = c.dead[c.dead.length - 1];
      c.dead.pop();
      if (c.alive[k]) continue;
      c.alive[k] = c.base[k];
      c.born[k] = this.time;
    }
  }

  /** heal a part of what is missing (now: at once, else queued and built up over time) */
  healCity(fraction, now = false) {
    const c = this.city;
    if (!c) return;
    const n = Math.round(c.dead.length * fraction);
    if (now) this.regrow(n);
    else this.repair = (this.repair ?? 0) + n;
  }

  get cityHealth() {
    const c = this.city;
    return c.total ? 1 - c.dead.length / c.total : 1;
  }

  // ---- players
  state(p) {
    let s = this.players.get(p.id);
    if (!s) {
      s = { slot: p.slot, fire: new Map(), lock: new Map(), auto: -9, autoTarget: null, speed: 0, fortified: false, fortAt: -9, stunUntil: -1, hitAt: -1, combo: 0, lastKill: -9, seen: this.time, power: { rapid: -9, spread: -9, mega: -9, shield: 0, shieldUntil: -9, megaTick: 0 }, mega: null, shieldHit: -9, boost: { charge: 1, active: false, at: -9, readyAt: -9 } };
      this.players.set(p.id, s);
    }
    s.slot = p.slot;
    s.seen = this.time;
    return s;
  }

  hitPlayer(p, s, x, y) {
    if (this.time < s.stunUntil) return;
    if (s.power.shield > 0 && this.time < s.power.shieldUntil) {
      s.power.shield--;
      s.shieldHit = this.time;
      this.burst(x, y, 14, POWER_COLORS.shield, 35, 0.4, WHITE);
      this.fx.light(x, y, 0.5, 1.6, POWER_COLORS.shield, 0.2);
      this.events.push({ type: 'shield', x });
      return;
    }
    s.hitAt = this.time;
    s.stunUntil = this.time + this.P.stun;
    s.combo = 0;
    this.stats.hits++;
    this.burst(x, y, 22, RED, 34, 0.6, WHITE);
    this.fx.light(x, y, 0.8, 2, RED, 0.35);
    this.fx.kick(1.2, 0.6);
    this.fx.ripple(x, y, 2.5, 4, 0.4);
    this.events.push({ type: 'hit', x });
  }

  fire(p, from, dir, target) {
    const v = this.P.laserSpeed * this.L.sx;
    let d = dir;
    const at = this.targetPos(target);
    if (at) {
      const dx = at[0] - from[0];
      const dy = at[1] - from[1];
      const n = Math.hypot(dx, dy) || 1;
      d = [dx / n, dy / n];
    }
    const s = this.players.get(p.id);
    const boosted = !!s?.boost.active;
    this.shots.push({ x: from[0], y: from[1], vx: d[0] * v * (boosted ? 1.2 : 1), vy: d[1] * v * (boosted ? 1.2 : 1), col: p.col, slot: p.slot, target, t0: this.time, dmg: boosted ? this.P.boostDamage : 1, big: boosted });
    // the fan: two more, 14 degrees to each side
    if (s && this.time < s.power.spread) {
      for (const a of [-0.25, 0.25]) {
        const c = Math.cos(a);
        const sn = Math.sin(a);
        this.shots.push({ x: from[0], y: from[1], vx: (d[0] * c - d[1] * sn) * v, vy: (d[0] * sn + d[1] * c) * v, col: POWER_COLORS.spread, slot: p.slot, target: null, t0: this.time });
      }
    }
    this.events.push({ type: 'laser', x: from[0] });
  }

  // ---- the invaders' attacks
  enemyShot(people, speed, aimedShare) {
    const sides = this.sides.filter((s) => s.count && !s.storm);
    if (!sides.length) return;
    const side = pick(sides);
    // aim at somebody's row most of the time; forts first (they stand still)
    let target = null;
    if (people.length && Math.random() < 0.75) {
      const forts = people.filter((p) => this.players.get(p.id)?.fortified);
      target = pick(forts.length && Math.random() < 0.7 ? forts : people);
    }
    const rowsAlive = [];
    for (let r = 0; r < side.rows; r++) {
      for (let c = 0; c < side.cols; c++) {
        if (this.present(side, r * side.cols + c)) {
          rowsAlive.push(r);
          break;
        }
      }
    }
    if (!rowsAlive.length) return;
    let row = target ? clamp(Math.round((target.center[1] - side.fy - SPRITE_H / 2) / PY), 0, side.rows - 1) : pick(rowsAlive);
    if (!rowsAlive.includes(row)) row = rowsAlive.reduce((a, b) => (Math.abs(b - row) < Math.abs(a - row) ? b : a));
    // the front-most invader of that row fires
    let best = -1;
    for (let c = 0; c < side.cols; c++) {
      const i = row * side.cols + c;
      if (!this.present(side, i)) continue;
      if (best < 0 || (side.dirX > 0 ? c > best % side.cols : c < best % side.cols)) best = i;
    }
    if (best < 0) return;
    // announced: the eyes glow red for a moment, then it fires (some aimed straight at a person)
    if (side.charge[best] > this.time) return;
    const aimed = !!target && Math.random() < aimedShare;
    side.charge[best] = this.time + this.P.telegraph;
    this.pending.push({ side, i: best, at: this.time + this.P.telegraph, aimed, targetId: target?.id, speed });
  }

  /** the announced shots that are due */
  firePending(people) {
    const t = this.time;
    this.pending = this.pending.filter((q) => {
      if (q.at > t) return true;
      const { side, i } = q;
      side.charge[i] = -9;
      if (!this.present(side, i)) return false;
      const b = this.box(side, i);
      const x = side.dirX > 0 ? b[0] + b[2] + 1 : b[0] - 1;
      const y = b[1] + 4;
      const target = q.aimed ? people.find((p) => p.id === q.targetId) : null;
      if (target) {
        const dx = target.center[0] - x;
        const dy = target.center[1] - y;
        const d = Math.hypot(dx, dy) || 1;
        this.bullets.push({ x, y, vx: (dx / d) * q.speed * 0.9, vy: (dy / d) * q.speed * 0.9, aimed: true, anim: Math.random() * 4 });
      } else this.bullets.push({ x, y, vx: side.dirX * q.speed, vy: 0, aimed: false, anim: Math.random() * 4 });
      this.fx.light(x, y, 0.3, 1.2, [1, 0.4, 0.2], 0.12);
      return false;
    });
  }

  // ---- bombs: a squid lobs a mine at a person; it lands, pulses and explodes
  spawnBomb(people) {
    if (!people.length) return;
    const forts = people.filter((p) => this.players.get(p.id)?.fortified);
    const target = pick(forts.length && Math.random() < 0.6 ? forts : people);
    const sides = this.sides.filter((sd) => sd.count && !sd.storm);
    if (!sides.length) return;
    const side = pick(sides);
    let from = -1;
    for (let i = 0; i < side.alive.length && from < 0; i++) {
      const outer = side.edge < 0 ? i % side.cols : side.cols - 1 - (i % side.cols);
      if (outer === 0 && this.present(side, i) && Math.random() < 0.5) from = i;
    }
    if (from < 0) return;
    const b = this.box(side, from);
    const L = this.L;
    const tx = target.center[0] + rand(-0.15, 0.15) * L.sx;
    const ty = target.center[1] + rand(-0.15, 0.15) * L.sy;
    this.bombs.push({ x0: b[0] + b[2] / 2, y0: b[1] + 4, x: b[0] + b[2] / 2, y: b[1] + 4, tx, ty, t0: this.time, flight: 0.9, fuse: this.P.bombFuse, r: 0.45, landed: false, beep: 0 });
    this.events.push({ type: 'bombThrow', x: b[0] });
  }

  updateBombs(people, bySlot) {
    const t = this.time;
    const L = this.L;
    this.bombs = this.bombs.filter((bm) => {
      const u = (t - bm.t0) / bm.flight;
      if (u < 1) {
        bm.x = bm.x0 + (bm.tx - bm.x0) * u;
        bm.y = bm.y0 + (bm.ty - bm.y0) * u;
        return true;
      }
      if (!bm.landed) {
        bm.landed = true;
        bm.x = bm.tx;
        bm.y = bm.ty;
        this.fx.light(bm.x, bm.y, 0.4, 1.2, RED, 0.2);
        this.events.push({ type: 'bombLand', x: bm.x });
      }
      const left = bm.t0 + bm.flight + bm.fuse - t;
      if (left > 0) {
        // beeps faster and faster
        bm.beep -= this.dtLast;
        if (bm.beep <= 0) {
          bm.beep = Math.max(0.08, left * 0.3);
          this.events.push({ type: 'bombBeep', x: bm.x });
        }
        return true;
      }
      // boom
      const rx = bm.r * L.sx;
      const ry = bm.r * L.sy;
      for (const p of people) {
        const [cx, cy] = p.center;
        if (((cx - bm.x) / rx) ** 2 + ((cy - bm.y) / ry) ** 2 <= 1) {
          const who = bySlot.get(p.slot);
          if (who) this.hitPlayer(p, who.s, cx, cy);
        }
      }
      const c = this.city;
      if (bm.x > c.x0 - rx && bm.x < c.x0 + c.w + rx) this.erode(bm.x, bm.y, bm.r * L.sy * 1.2);
      this.burst(bm.x, bm.y, 40, ORANGE, 60, 0.8, RED);
      this.booms.push({ x: bm.x, y: bm.y, t0: t, col: ORANGE });
      this.fx.light(bm.x, bm.y, bm.r * 2.2, 3, ORANGE, 0.45);
      this.fx.ripple(bm.x, bm.y, 5, 5, 0.5);
      this.fx.kick(1.6, 0.4);
      this.events.push({ type: 'bomb', x: bm.x });
      return false;
    });
  }

  // ---- the battleship
  spawnShip() {
    const L = this.L;
    const N = this.crowdN;
    const D = this.difficulty;
    const fromLeft = Math.random() < 0.5;
    const hp = Math.round(this.P.shipHp * (0.6 + 0.4 * N) * (0.8 + 0.2 * D) * this.ease);
    this.ship = { x: fromLeft ? -SHIP_W - 2 : L.AW + 2, y: 1, hp, hpMax: hp, state: 'aim', stateT: 0, shots: Math.max(1, Math.round((2 + N / 2 + (D - 1) * 2) * this.ease)), beamX: 0, targetX: L.AW / 2, flash: -9, t0: this.time, fireT: 0 };
    this.events.push({ type: 'shipEnter', x: fromLeft ? 0 : L.AW });
    this.fx.flash(BEAM, 0.08);
  }

  /** where the ship aims next: a person standing still first (forts), else anyone */
  shipTarget(people) {
    const L = this.L;
    if (!people.length) return L.AW / 2;
    const forts = people.filter((p) => this.players.get(p.id)?.fortified);
    const p = pick(forts.length && Math.random() < 0.7 ? forts : people);
    return p.center[0];
  }

  updateShip(people, bySlot, invCol, dt) {
    const sh = this.ship;
    if (!sh) return;
    const t = this.time;
    const L = this.L;
    const P = this.P;
    const D = this.difficulty;
    sh.stateT += dt;
    const cx = sh.x + SHIP_W / 2;
    const speed = 1.8 * L.sx;
    const moveTo = (x) => {
      const d = x - cx;
      sh.x += clamp(d, -speed * dt, speed * dt);
      return Math.abs(d) < 1;
    };
    if (sh.state === 'aim') {
      if (sh.stateT < dt * 1.5) sh.targetX = this.shipTarget(people);
      if ((moveTo(sh.targetX) && sh.stateT > 0.4) || sh.stateT > 3) {
        sh.state = 'charge';
        sh.stateT = 0;
        sh.beamX = cx;
        this.events.push({ type: 'charge', x: cx });
      }
    } else if (sh.state === 'charge') {
      const dur = P.shipCharge / (0.9 + 0.1 * D);
      // sparks are sucked into the emitter
      const ex = cx;
      const ey = sh.y + SHIP_H;
      if (Math.random() < dt * 40) {
        const a = Math.random() * Math.PI * 2;
        const r = rand(10, 22);
        const x = ex + Math.cos(a) * r;
        const y = ey + Math.sin(a) * r * 0.6;
        this.particles.push({ x, y, vx: (ex - x) * 2.2, vy: (ey - y) * 2.2, col: Math.random() < 0.5 ? WHITE : BEAM, t0: t, life: 0.45 });
      }
      if (sh.stateT >= dur) {
        sh.state = 'fire';
        sh.stateT = 0;
        this.fx.flash(BEAM, 0.18);
        this.fx.kick(2.5, 1.2);
        this.fx.ripple(ex, ey, 6, 6, 0.6);
        this.events.push({ type: 'beam', on: true, x: ex });
      }
    } else if (sh.state === 'fire') {
      const dur = 1.1;
      const half = (P.beamWidth * L.sx) / 2;
      const x0 = sh.beamX - half;
      const x1 = sh.beamX + half;
      const y0 = sh.y + SHIP_H - 1;
      this.fx.kick(1.3, 0.5);
      // everything in it burns: people, invaders, bullets, mines, the city
      for (const p of people) {
        const bodyHalf = 0.12 * L.sx;
        if (p.center[0] + bodyHalf > x0 && p.center[0] - bodyHalf < x1) {
          const who = bySlot.get(p.slot);
          if (who && t >= who.s.stunUntil) {
            this.hitPlayer(p, who.s, p.center[0], p.center[1]);
            who.s.stunUntil = t + P.stun * 1.6;
          }
        }
      }
      const burned = [];
      this.forTargets((tg, bx, by, bw) => {
        if (tg.ship || tg.ufo) return true;
        if (bx + bw > x0 && bx < x1 && by + 8 > y0) burned.push(tg);
        return true;
      });
      for (const tg of burned) this.damage(tg, 99, 0, BEAM, invCol);
      this.bullets = this.bullets.filter((b) => b.x < x0 || b.x > x1);
      this.bombs = this.bombs.filter((b) => b.x < x0 || b.x > x1);
      const c = this.city;
      for (let x = Math.max(c.x0, Math.floor(x0)); x < Math.min(c.x0 + c.w, Math.ceil(x1)); x++) {
        for (let y = 0; y < c.h; y++) {
          const k = y * c.w + (x - c.x0);
          if (!c.alive[k] || Math.random() > dt * 2.5) continue;
          c.alive[k] = 0;
          c.deadAt[k] = t;
          c.dead.push(k);
          c.hitAt = t;
        }
      }
      // sparks spray off the beam's edges
      for (let k = 0; k < 3; k++) {
        const y = rand(y0, L.AH);
        const side = Math.random() < 0.5 ? -1 : 1;
        this.particles.push({ x: sh.beamX + side * half, y, vx: side * rand(20, 70), vy: rand(-15, 15), col: Math.random() < 0.5 ? WHITE : BEAM, t0: t, life: rand(0.25, 0.6) });
      }
      if (sh.stateT >= dur) {
        this.scorches.push({ x: sh.beamX, w: half * 2, y0, t0: t });
        this.events.push({ type: 'beam', on: false, x: sh.beamX });
        sh.shots--;
        sh.state = sh.shots > 0 && this.phase === 'fight' ? 'aim' : 'leave';
        sh.stateT = 0;
      }
    } else if (sh.state === 'leave') {
      const out = cx < L.AW / 2 ? -SHIP_W : L.AW + SHIP_W;
      if (moveTo(out)) {
        this.ship = null;
        this.nextShip = t + P.shipEvery * rand(0.8, 1.2) / Math.max(0.7, D) ** 0.5;
      }
    }
  }

  damageShip(sh, amount, col) {
    if (this.ship !== sh || this.shipDeath) return;
    sh.hp -= amount;
    sh.flash = this.time;
    const x = sh.x + SHIP_W / 2 + rand(-SHIP_W / 3, SHIP_W / 3);
    const y = sh.y + rand(3, SHIP_H - 3);
    this.burst(x, y, 6, WHITE, 30, 0.3, col);
    this.fx.light(x, y, 0.35, 1.2, col, 0.1);
    this.events.push({ type: 'ping', x });
    if (sh.hp > 0) return;
    // it goes down: explosions along the hull, then the big one
    this.shipDeath = { x: sh.x, y: sh.y, t0: this.time, next: 0, done: false };
    if (sh.state === 'fire') this.events.push({ type: 'beam', on: false, x: sh.beamX });
    this.ship = null;
    this.score += 1000;
    this.best = Math.max(this.best, this.score);
    this.fx.slow(1.2, 0.2);
    this.fx.flash(WHITE, 0.25);
    this.events.push({ type: 'shipHit', x });
  }

  updateShipDeath(dt) {
    const d = this.shipDeath;
    if (!d) return;
    const t = this.time;
    d.next -= dt;
    const age = t - d.t0;
    if (age < 1 && d.next <= 0) {
      d.next = rand(0.05, 0.11);
      const x = d.x + rand(2, SHIP_W - 2);
      const y = d.y + rand(2, SHIP_H - 2);
      this.burst(x, y, 24, ORANGE, 50, 0.7, WHITE);
      this.booms.push({ x, y, t0: t, col: ORANGE });
      this.fx.light(x, y, rand(0.6, 1.1), 2.5, Math.random() < 0.5 ? ORANGE : BEAM, 0.4);
      this.fx.kick(2, 0.8);
      this.events.push({ type: 'crash', x });
    }
    if (age >= 1 && !d.done) {
      d.done = true;
      const cx = d.x + SHIP_W / 2;
      const cy = d.y + SHIP_H / 2;
      this.shatter(d.x, d.y, 'ship', BEAM, WHITE, null, 2.5);
      this.burst(cx, cy, 160, WHITE, 120, 1.6, BEAM);
      this.burst(cx, cy, 80, ORANGE, 70, 1.4, RED);
      this.fx.flash(WHITE, 0.5);
      this.fx.kick(4, 2.5);
      this.fx.ripple(cx, cy, 12, 7, 1.2);
      this.fx.ripple(cx, cy, 7, 4, 1.4);
      this.fx.light(cx, cy, 3, 4, BEAM, 1.2);
      this.fx.light(cx, cy, 1.5, 4, WHITE, 0.5);
      this.fx.slow(0.9, 0.3);
      this.party = t + 2;
      this.repair = (this.repair ?? 0) + Math.round(this.city.total * 0.25);
      for (let k = 0; k < 3; k++) this.firework();
      this.dropLater = (this.dropLater ?? 0) + 2;
      this.events.push({ type: 'shipKill', x: cx });
    }
    if (age > 1.5) this.shipDeath = null;
  }

  /** an invader of the front column breaks out and dives at a person or the city */
  spawnDiver(people) {
    const sides = this.sides.filter((s) => s.count > 1 && !s.storm);
    if (!sides.length) return;
    const side = pick(sides);
    const cand = [];
    for (let i = 0; i < side.alive.length; i++) if (this.present(side, i)) cand.push(i);
    if (!cand.length) return;
    // the front-most first
    const front = (i) => (side.dirX > 0 ? i % side.cols : side.cols - 1 - (i % side.cols));
    cand.sort((a, b) => front(b) - front(a));
    const i = cand[Math.floor(Math.random() * Math.min(cand.length, side.rows))];
    const b = this.box(side, i);
    side.alive[i] = 0;
    side.count--;
    const v = this.P.diveSpeed * this.L.sx;
    const toPlayer = people.length && Math.random() < 0.6;
    const target = toPlayer ? { id: pick(people).id } : { x: side.dirX > 0 ? this.city.x0 : this.city.x0 + this.city.w, y: rand(6, this.L.AH - 6) };
    const up = b[1] + 4 < this.L.AH / 2 ? -1 : 1;
    this.divers.push({ x: b[0] + b[2] / 2, y: b[1] + 4, vx: side.dirX * v * 0.2, vy: up * v, v, type: b[4], hp: side.hp[i], flash: -9, t0: this.time, target, trail: [], trailT: 0, side });
    this.fx.light(b[0] + b[2] / 2, b[1] + 4, 0.5, 1.5, RED, 0.3);
    this.events.push({ type: 'dive', x: b[0] });
  }

  // ---- power-ups
  /** a free place where the Kinect sees people (the fog mask), off the city, away from everybody */
  itemSpot(people) {
    const L = this.L;
    const reach = this.reach;
    const c = this.city;
    const ok = (x, y) => {
      const xi = Math.round(x);
      const yi = Math.round(y);
      return !reach || (xi >= 0 && yi >= 0 && xi < L.AW && yi < L.AH && reach[yi * L.AW + xi] === 255);
    };
    for (let k = 0; k < 60; k++) {
      const x = rand(4, L.AW - 4);
      const y = rand(4, L.AH - 4);
      const mx = 0.35 * L.sx;
      const my = 0.2 * L.sy;
      if (!ok(x, y) || !ok(x - mx, y) || !ok(x + mx, y) || !ok(x, y - my) || !ok(x, y + my)) continue;
      if (x > c.x0 - 6 && x < c.x0 + c.w + 6) continue;
      const near = people.map((p) => Math.hypot((p.center[0] - x) / L.sx, (p.center[1] - y) / L.sy));
      if (near.some((d) => d < 0.6)) continue;
      if (people.length && Math.min(...near) > 3) continue;
      return [x, y];
    }
    return null;
  }

  dropItem(type, at, people) {
    const spot = at ?? this.itemSpot(people);
    if (!spot) return;
    const t = this.time;
    this.items.push({ type, x: spot[0], y: spot[1], t0: t, life: 11 });
    this.fx.light(spot[0], spot[1], 0.6, 2, POWER_COLORS[type], 0.5);
    this.fx.ripple(spot[0], spot[1], 2.5, 4, 0.4);
    this.events.push({ type: 'item', x: spot[0] });
  }

  /** a random power-up: repairs more likely when the city is low, slow motion when it is hard */
  pickPower() {
    const w = { repair: 0.6 + 3 * (1 - this.cityHealth), rapid: 2, spread: 2, shield: 1.4, nova: 1.2, mega: 1, slow: 0.6 + Math.max(0, this.difficulty - 1.2) };
    let r = Math.random() * Object.values(w).reduce((a, b) => a + b, 0);
    for (const k of POWERS) {
      r -= w[k];
      if (r <= 0) return k;
    }
    return 'rapid';
  }

  collect(item, p, s) {
    const t = this.time;
    const P = this.P;
    const col = POWER_COLORS[item.type];
    const [x, y] = [item.x, item.y];
    if (item.type === 'repair') this.repair = (this.repair ?? 0) + Math.round(this.city.total * 0.2);
    else if (item.type === 'rapid') s.power.rapid = t + P.powerTime;
    else if (item.type === 'spread') s.power.spread = t + P.powerTime;
    else if (item.type === 'shield') {
      s.power.shield = 3;
      s.power.shieldUntil = t + P.powerTime * 1.5;
    } else if (item.type === 'nova') {
      this.waves.push({ x: p.center[0], y: p.center[1], t0: t, slot: p.slot, col, R: 1.8, done: new Set(), dmg: 3 });
      this.fx.ripple(p.center[0], p.center[1], 10, 6, 0.9);
      this.fx.kick(3, 1.4);
      this.fx.flash(col, 0.2);
    } else if (item.type === 'mega') s.power.mega = t + 3;
    else if (item.type === 'slow') {
      this.enemySlowUntil = t + 6;
      this.fx.flash(col, 0.15);
    }
    this.burst(x, y, 40, col, 55, 0.8, WHITE);
    this.fx.light(x, y, 1.2, 2.5, col, 0.6);
    this.fx.ripple(x, y, 4, 5, 0.5);
    this.fx.kick(0.8, 0.4);
    this.events.push({ type: 'pickup', power: item.type, x });
  }

  /** a player's own mega laser: from the body to the edge of the map, at the nearest target */
  updateMega(p, s, dt, invCol) {
    const t = this.time;
    if (t >= s.power.mega || t < s.stunUntil) {
      s.mega = null;
      return;
    }
    const L = this.L;
    const [cx, cy] = p.center;
    let dir = p.arms[0]?.dir ?? null;
    if (!dir) {
      const tg = this.nearest(cx, cy, 8);
      const at = this.targetPos(tg);
      if (at) {
        const d = Math.hypot(at[0] - cx, at[1] - cy) || 1;
        dir = [(at[0] - cx) / d, (at[1] - cy) / d];
      } else dir = [cx < L.AW / 2 ? -1 : 1, 0];
    }
    // smooth turning
    const old = s.mega?.dir ?? dir;
    const nd = [old[0] + (dir[0] - old[0]) * Math.min(1, dt * 8), old[1] + (dir[1] - old[1]) * Math.min(1, dt * 8)];
    const n = Math.hypot(nd[0], nd[1]) || 1;
    dir = [nd[0] / n, nd[1] / n];
    const len = L.AW * 1.5;
    s.mega = { x0: cx, y0: cy, x1: cx + dir[0] * len, y1: cy + dir[1] * len, dir, half: 0.12 * (L.sx + L.sy) * 0.5 };
    s.power.megaTick -= dt;
    this.fx.kick(0.6, 0.2);
    if (s.power.megaTick > 0) return;
    s.power.megaTick = 0.08;
    const m = s.mega;
    const hits = [];
    this.forTargets((tg, bx, by, bw, bh) => {
      const ccx = bx + bw / 2;
      const ccy = by + bh / 2;
      // in front of the player and close to the beam
      if ((ccx - cx) * dir[0] + (ccy - cy) * dir[1] < 0) return true;
      if (lineDist(ccx, ccy, m.x0, m.y0, m.x1, m.y1) < m.half + Math.max(bw, bh) / 2) hits.push(tg);
      return true;
    });
    for (const tg of hits) this.damage(tg, 1, p.slot, p.col, invCol, dir);
    this.bullets = this.bullets.filter((b) => (b.x - cx) * dir[0] + (b.y - cy) * dir[1] < 0 || lineDist(b.x, b.y, m.x0, m.y0, m.x1, m.y1) > m.half + 1);
    if (hits.length) this.events.push({ type: 'zap', x: cx });
  }

  // ---- lasers from the left and right edge
  spawnEdgeLaser(people) {
    if (!people.length) return;
    const L = this.L;
    const P = this.P;
    const forts = people.filter((p) => this.players.get(p.id)?.fortified);
    const target = pick(forts.length && Math.random() < 0.6 ? forts : people);
    const fromLeft = Math.random() < 0.5;
    const [px, py] = target.center;
    const x0 = fromLeft ? 0 : L.AW;
    const x1 = fromLeft ? L.AW : 0;
    let m = Math.tan(rand(-0.5, 0.5));
    let y0 = py + m * (x0 - px);
    if (y0 < 3 || y0 > L.AH - 3) {
      y0 = clamp(y0, 3, L.AH - 3);
      m = (py - y0) / (px - x0 || 1);
    }
    const y1 = y0 + m * (x1 - x0);
    const half = (P.edgeWidth / 2) * (L.sx + L.sy) * 0.5;
    this.edgeLasers.push({ x0, y0, x1, y1, t0: this.time, tele: P.edgeTele / (0.9 + 0.1 * this.difficulty), half, hit: new Set(), fired: false });
    this.events.push({ type: 'edgeCharge', x: x0 });
  }

  /** how far a laser is open: 0 (only the middle line) .. 1 */
  edgeOpen(l) {
    const a = this.time - l.t0 - l.tele;
    if (a < 0) return 0;
    if (a < 0.1) return a / 0.1;
    if (a < 0.65) return 1;
    return Math.max(0, 1 - (a - 0.65) / 0.15);
  }

  updateEdgeLasers(people, bySlot, invCol, dt) {
    const t = this.time;
    const L = this.L;
    this.edgeLasers = this.edgeLasers.filter((l) => {
      const a = t - l.t0 - l.tele;
      if (a > 0.8) return false;
      if (a < 0) return true;
      if (!l.fired) {
        l.fired = true;
        this.fx.kick(1.6, 0.6);
        this.fx.ripple(l.x0, l.y0, 5, 6, 0.5);
        this.fx.flash([1, 0.3, 0.15], 0.06);
        this.events.push({ type: 'edgeFire', x: l.x0 });
      }
      const open = this.edgeOpen(l);
      if (open < 0.5) return true;
      const half = l.half * open;
      const bodyHalf = 0.1 * (L.sx + L.sy) * 0.5;
      for (const p of people) {
        if (l.hit.has(p.id)) continue;
        if (lineDist(p.center[0], p.center[1], l.x0, l.y0, l.x1, l.y1) < half + bodyHalf) {
          l.hit.add(p.id);
          const who = bySlot.get(p.slot);
          if (who) this.hitPlayer(p, who.s, p.center[0], p.center[1]);
        }
      }
      const burned = [];
      this.forTargets((tg, bx, by, bw, bh) => {
        if (tg.ship || tg.ufo) return true;
        if (lineDist(bx + bw / 2, by + bh / 2, l.x0, l.y0, l.x1, l.y1) < half + 4) burned.push(tg);
        return true;
      });
      for (const tg of burned) this.damage(tg, 99, 0, ORANGE, invCol);
      this.bullets = this.bullets.filter((b) => lineDist(b.x, b.y, l.x0, l.y0, l.x1, l.y1) > half + 1);
      // a scratch across the city
      const c = this.city;
      const mm = (l.y1 - l.y0) / (l.x1 - l.x0);
      const ext = half * 0.4 * Math.sqrt(1 + mm * mm); // only the core scratches (a few %)
      for (let x = c.x0; x < c.x0 + c.w; x++) {
        const yc = l.y0 + mm * (x - l.x0);
        for (let y = Math.max(0, Math.floor(yc - ext)); y <= Math.min(c.h - 1, yc + ext); y++) {
          const k = y * c.w + (x - c.x0);
          if (!c.alive[k] || Math.random() > dt * 0.6) continue;
          c.alive[k] = 0;
          c.deadAt[k] = t;
          c.dead.push(k);
          c.hitAt = t;
        }
      }
      if (Math.random() < 0.6) {
        const u = Math.random();
        const x = l.x0 + (l.x1 - l.x0) * u;
        const y = l.y0 + (l.y1 - l.y0) * u;
        const side = Math.random() < 0.5 ? -1 : 1;
        this.particles.push({ x, y: y + side * half, vx: rand(-20, 20), vy: side * rand(15, 50), col: Math.random() < 0.5 ? WHITE : ORANGE, t0: t, life: rand(0.2, 0.5) });
      }
      return true;
    });
  }

  startStorm(side) {
    const idx = [];
    for (let i = 0; i < side.alive.length; i++) if (side.alive[i]) idx.push(i);
    const col = (i) => i % side.cols;
    idx.sort((a, b) => (side.dirX > 0 ? col(b) - col(a) : col(a) - col(b)) || Math.random() - 0.5);
    side.storm = idx;
    side.stormT = 0;
    side.crashed = true;
    this.stats.storms++;
    this.fx.flash(RED, 0.12);
    this.events.push({ type: 'storm', x: side.dirX > 0 ? this.city.x0 : this.city.x0 + this.city.w });
  }

  /** the city falls: the game is lost */
  startFall() {
    this.phase = 'fall';
    this.phaseT = 0;
    this.fallT = 0;
    this.skill = clamp(this.skill * 0.75, 0.5, 3);
    for (const d of this.divers) this.explodeDiver(d, null, 0, () => RED);
    this.divers = [];
    this.bullets = [];
    this.shots = [];
    this.fx.flash(RED, 0.45);
    this.fx.kick(3, 2);
    this.fx.slow(0.8, 0.3);
    this.bombs = [];
    if (this.ship) {
      if (this.ship.state === 'fire') this.events.push({ type: 'beam', on: false, x: 0 });
      this.ship.state = 'leave';
    }
    const c = this.city;
    this.fx.ripple(c.x0 + c.w / 2, c.h / 2, 10, 6, 1.2);
    this.events.push({ type: 'fall', x: c.x0 + c.w / 2 });
  }

  firework() {
    const L = this.L;
    const x = rand(10, L.AW - 10);
    const y = rand(8, L.AH - 8);
    const col = neon(Math.random());
    const n = 40;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const v = rand(40, 55);
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, col, t0: this.time, life: rand(0.8, 1.2) });
    }
    this.fx.light(x, y, 1.2, 2.2, col, 0.6);
    this.events.push({ type: 'firework', x });
  }

  /** the wave is over: the director rates it */
  endWave(L) {
    const t = this.time;
    if (this.ship) this.ship.state = 'leave';
    const st = this.stats;
    const dur = t - st.t0;
    const lost = Math.max(0, this.city.dead.length - st.dead0) / Math.max(1, this.city.total);
    const won = st.storms === 0;
    if (won) {
      this.level++;
      const r = this.P.targetTime / Math.max(5, dur);
      this.skill *= clamp(r ** 0.3, 0.92, 1.15);
      if (lost < 0.03 && st.hits <= this.crowdN * 2) this.skill *= 1.05;
      this.healCity(lost < 0.03 ? 0.6 : 0.3);
      this.party = t + 2.5;
      for (let k = 0; k < 5; k++) this.firework();
      this.fx.slow(0.8, 0.35);
      this.fx.flash(neon(Math.random()), 0.15);
      this.fx.ripple(this.city.x0 + this.city.w / 2, L.AH / 2, 7, 6, 1);
      this.events.push({ type: 'clear', x: L.AW / 2 });
    } else {
      this.skill *= 0.9 ** st.storms;
      this.healCity(0.12);
    }
    this.skill = clamp(this.skill, 0.5, 3);
    this.lastWave = { dur, lost, won, hits: st.hits, skill: this.skill };
    this.phase = 'clear';
    this.phaseT = 0;
  }

  /**
   * One step. people: [{ id, slot, col, center, arms: [{ id, tip, dir }], stomp }] (art px); body: the
   * map grid of the bodies (body.js); P: the params; invCol(type) -> color.
   */
  step(dtReal, people, body, P, invCol) {
    const L = this.L;
    this.P = P;
    const dt = dtReal * this.fx.timeScale;
    this.time += dt;
    const t = this.time;
    const n = people.length;
    const present = n > 0;
    // the crowd, smoothed over about two seconds
    this.crowd += (n - this.crowd) * Math.min(1, dtReal / 2);
    this.emptyFor = present ? 0 : this.emptyFor + dtReal;
    if (!present && this.emptyFor > P.resetAfter && this.dirty) {
      this.resetAll();
      return;
    }
    if (present) this.dirty = true;
    const sx = L.sx;
    const c = this.city;
    const N = this.crowdN;
    const D = this.difficulty;
    const mercy = this.cityHealth < 0.4;
    const edt = t < this.enemySlowUntil ? dt * 0.4 : dt; // the slow-motion power-up

    // ---- the city: rewards are built up over time
    if (this.repair > 0) {
      const k = Math.min(this.repair, Math.ceil(dt * (this.phase === 'rebuild' ? 1500 : 300)));
      this.regrow(k);
      this.repair -= k;
      if (!c.dead.length) this.repair = 0;
    }

    // ---- phases
    this.phaseT += dt;
    if (this.phase === 'enter') {
      // warp-in: a flash where each one appears
      for (const side of this.sides) {
        for (let i = 0; i < side.alive.length; i++) {
          const s = side.spawn[i];
          if (s <= t && s > t - dt) {
            const b = this.box(side, i);
            this.fx.light(b[0] + b[2] / 2, b[1] + 4, 0.35, 1.6, invCol(b[4]), 0.25);
            this.booms.push({ x: b[0] + b[2] / 2, y: b[1] + 4, t0: t, col: WHITE, warp: true });
            this.events.push({ type: 'warp', x: b[0] });
          }
        }
      }
      if (this.sides.every((s) => s.spawn.every((v) => v <= t - 0.4))) {
        this.phase = 'fight';
        this.phaseT = 0;
      }
    } else if (this.phase === 'fight') {
      // the beat: every formation steps at once, faster with fewer invaders left and later waves
      const alive = this.sides.reduce((k, s) => k + s.count, 0);
      const interval = Math.max(0.035, (0.3 / (P.speed * (0.85 + 0.15 * D))) * (0.12 + 0.88 * (alive / Math.max(1, this.total)) ** 1.2));
      this.beatT += edt;
      if (this.beatT >= interval && alive) {
        this.beatT = 0;
        this.beat++;
        this.frameAnim ^= 1;
        this.fx.pulse = 1;
        this.beatAt = t;
        this.events.push({ type: 'march', note: this.beat % 4, x: L.AW / 2 });
        for (const side of this.sides) {
          if (!side.count || side.storm) continue;
          const b = this.bounds(side);
          const stepY = 3;
          const hitsEdge = side.ydir > 0 ? b.maxY + stepY > L.AH - 1 : b.minY - stepY < 1;
          if (hitsEdge) {
            side.ydir = -side.ydir;
            if (present) side.fx += side.dirX * Math.round(P.advance * (0.8 + 0.2 * D));
          } else side.fy += side.ydir * stepY;
          const nb = this.bounds(side);
          const reached = side.dirX > 0 ? nb.front >= c.x0 - 1 : nb.front <= c.x0 + c.w + 1;
          if (reached) this.startStorm(side);
        }
      }
      if (present) {
        // their fire: more with more people and higher difficulty, less when the city is about to fall
        const ease = this.ease;
        const rate = P.enemyFire * 0.45 * (0.6 + 0.4 * N) * D * (mercy ? 0.7 : 1) * ease;
        this.fireAcc += dt * rate;
        const maxBullets = 3 + Math.round(3 * N);
        const aimed = clamp((D - 0.9) * 0.5, 0, 0.6) * ease;
        while (this.fireAcc >= 1) {
          this.fireAcc -= 1;
          if (this.bullets.length < maxBullets) this.enemyShot(people, P.bulletSpeed * (0.85 + 0.15 * D) * sx, aimed);
        }
        // divers
        const diveRate = P.dive * 0.05 * N * Math.max(0, D - 0.6) * (mercy ? 0.5 : 1) * ease;
        this.diveAcc += dt * diveRate;
        while (this.diveAcc >= 1) {
          this.diveAcc -= 1;
          if (this.divers.length < 1 + Math.floor(N / 2)) this.spawnDiver(people);
        }
        // bombers: from wave 2, more with difficulty
        const bombRate = P.bombs * 0.06 * N * Math.max(0, D - 0.8) * (this.level >= 2 ? 1 : 0) * ease;
        this.bombAcc += dt * bombRate;
        while (this.bombAcc >= 1) {
          this.bombAcc -= 1;
          if (this.bombs.length < 1 + Math.round(N)) this.spawnBomb(people);
        }
        // the battleship: from wave shipFrom; sooner when everybody camps in forts
        const forts = people.filter((p) => this.players.get(p.id)?.fortified).length;
        this.camp = forts >= Math.max(1, people.length * 0.7) ? this.camp + dt : Math.max(0, this.camp - dt);
        if (this.camp > 10) this.nextShip = Math.min(this.nextShip, t + 2);
        if (!this.ship && !this.shipDeath && this.level >= P.shipFrom && t > this.nextShip && P.ship) this.spawnShip();
        // lasers from the edges: from wave edgeFrom, more with people and difficulty
        if (this.level >= P.edgeFrom) {
          this.edgeAcc += dt * P.edgeLasers * 0.05 * (0.6 + 0.4 * N) * D * ease;
          while (this.edgeAcc >= 1) {
            this.edgeAcc -= 1;
            if (this.edgeLasers.length < 1 + Math.floor(N / 3)) this.spawnEdgeLaser(people);
          }
        }
        // power-ups: more often when the crowd struggles (low skill, low city) and with more people
        if (P.items && t > this.nextItem) {
          if (this.items.length < 1 + Math.floor(N / 2)) this.dropItem(this.pickPower(), null, people);
          const every = (P.itemEvery * clamp(this.skill, 0.6, 1.6) * ease) / (0.7 + 0.3 * N) / (this.cityHealth < 0.5 ? 1.6 : 1);
          this.nextItem = t + every * rand(0.75, 1.25);
        }
        // mercy: a city about to fall brings the mothership (shooting it repairs the city)
        if (mercy && !this.stats.mercy) {
          this.stats.mercy = true;
          this.nextUfo = Math.min(this.nextUfo, t + 3);
        }
        // pressure: a crowd that wipes out the wave fast gets divers
        const killed = 1 - alive / Math.max(1, this.total);
        if (!this.stats.pressure && t - this.stats.t0 < 15 && killed > 0.55) {
          this.stats.pressure = true;
          for (let k = 0; k < Math.min(4, 1 + Math.round(N)); k++) this.spawnDiver(people);
        }
      }
      // the mothership
      if (!this.ufo && t > this.nextUfo) {
        const fromLeft = Math.random() < 0.5;
        this.ufo = { x: fromLeft ? -16 : L.AW, y: Math.round(rand(4, L.AH - 12)), vx: (fromLeft ? 1 : -1) * 1.1 * sx, t0: t };
        this.nextUfo = t + P.ufoEvery * rand(0.7, 1.3) * (present ? 1 : 2);
        this.events.push({ type: 'ufo', on: true, x: this.ufo.x });
      }
      // the city falls
      if (present && this.cityHealth < P.cityFall) this.startFall();
      // the wave is over when both formations are gone (shot down or crashed into the city)
      else if (this.sides.every((s) => !s.count && !s.storm) && !this.divers.length) this.endWave(L);
    } else if (this.phase === 'clear') {
      if (t < this.party && Math.random() < dt * 6) this.firework();
      if (this.phaseT > 3 && !(this.repair > 0)) this.startWave();
    } else if (this.phase === 'fall') {
      // chain explosions through the city, then the rebuild
      this.fallT -= dt;
      if (this.phaseT < 3 && this.fallT <= 0) {
        this.fallT = rand(0.06, 0.16);
        const x = c.x0 + rand(0, c.w);
        const y = rand(0, c.h);
        this.erode(x, y, rand(4, 8));
        this.burst(x, y, 24, EMBER, 50, 0.9, RED);
        this.booms.push({ x, y, t0: t, col: ORANGE });
        this.fx.light(x, y, rand(0.8, 1.4), 2.5, Math.random() < 0.5 ? EMBER : RED, 0.5);
        if (Math.random() < 0.3) this.fx.ripple(x, y, 4, 5, 0.5);
        this.fx.kick(1.5);
        this.events.push({ type: 'crash', x });
      }
      if (this.phaseT > 4) {
        this.phase = 'rebuild';
        this.phaseT = 0;
        this.level = 1;
        this.score = 0;
        this.clearField();
        this.repair = c.dead.length;
        this.events.push({ type: 'rebuild', x: c.x0 });
      }
    } else if (this.phase === 'rebuild') {
      if (this.phaseT > 2.5 && !c.dead.length) this.startWave();
    }

    // ---- storming formations: one invader after the other dives into the city
    for (const side of this.sides) {
      if (!side.storm) continue;
      side.stormT -= dt;
      while (side.storm.length && side.stormT <= 0) {
        side.stormT += 0.07;
        const i = side.storm.shift();
        if (!side.alive[i]) continue;
        const b = this.box(side, i);
        side.alive[i] = 0;
        side.count--;
        const ex = side.dirX > 0 ? c.x0 + rand(0, 3) : c.x0 + c.w - rand(0, 3);
        this.erode(ex, b[1] + 4, rand(4.5, 7));
        this.burst(ex, b[1] + 4, 18, RED, 42, 0.7, invCol(b[4]));
        this.booms.push({ x: ex, y: b[1] + 4, t0: t, col: RED });
        this.fx.light(ex, b[1] + 4, 1, 2.2, ORANGE, 0.45);
        this.fx.kick(1.4);
        this.events.push({ type: 'crash', x: ex });
        this.alarm = t + 0.5;
      }
      if (!side.storm.length) side.storm = null;
    }

    // ---- the people: automatic fire (stronger when fortified), pointing, stomping
    const point = P.control.includes('Zeigen');
    const auto = P.control.includes('Automatik');
    const cone = (P.assist * Math.PI) / 180;
    const bySlot = new Map();
    const fighting = this.phase === 'fight' || this.phase === 'enter';
    for (const p of people) {
      const s = this.state(p);
      bySlot.set(p.slot, { p, s });
      const stunned = t < s.stunUntil;
      // standing still (the position is what the tracking does best): a fort after a moment
      const [cx, cy] = p.center;
      if (s.px === undefined) {
        s.px = cx;
        s.py = cy;
        s.stillSince = t;
      }
      const v = Math.hypot((cx - s.px) / L.sx, (cy - s.py) / L.sy) / Math.max(dt, 1e-3);
      s.speed += (v - s.speed) * Math.min(1, dt * 5);
      s.px = cx;
      s.py = cy;
      if (s.speed > P.stillSpeed || stunned) s.stillSince = t;
      const fortified = P.fortify && t - s.stillSince >= P.fortifyAfter;
      if (fortified && !s.fortified) {
        s.fortAt = t;
        this.fx.light(cx, cy, 0.6, 1.2, p.col, 0.3);
        this.events.push({ type: 'fortify', x: cx });
      }
      s.fortified = fortified;

      s.lock.clear();
      let pointed = false;
      if (point && fighting) {
        for (const a of p.arms) {
          const target = this.lockOn(a.tip[0], a.tip[1], a.dir, cone);
          if (target) s.lock.set(a.id, target);
          pointed = true;
          if (stunned) continue;
          if (t - (s.fire.get(a.id) ?? -9) < P.pointEvery / (t < s.power.rapid ? 2.5 : 1) / (s.boost.active ? P.boostFire : 1)) continue;
          s.fire.set(a.id, t);
          this.fire(p, a.tip, a.dir, target);
        }
      }
      s.autoTarget = null;
      if (auto && fighting && !stunned && !pointed) {
        // boosted: full fire also on the move, faster, farther
        const every = (fortified || s.boost.active ? P.autoEvery : P.autoEvery * 3) / (t < s.power.rapid ? 2.5 : 1) / (s.boost.active ? P.boostFire : 1);
        const target = this.nearest(cx, cy, P.autoRange * (fortified ? 1.2 : 1) * (s.boost.active ? 1.5 : 1));
        s.autoTarget = target;
        if (target && t - s.auto >= every) {
          s.auto = t;
          s.fire.set('auto', t);
          this.fire(p, p.center, [1, 0], target);
        }
      }
      this.updateMega(p, s, dt, invCol);
      // walk onto a power-up to take it
      for (const it of this.items) {
        if (it.taken || Math.hypot((it.x - cx) / L.sx, (it.y - cy) / L.sy) > 0.32) continue;
        it.taken = true;
        this.collect(it, p, s);
      }
      // the boost: a jump starts it when the hexagon is full; it is used up, then charged again
      const bo = s.boost;
      if (bo.active) {
        bo.charge -= dtReal / P.boostTime;
        if (Math.random() < dtReal * 14) {
          const a = Math.random() * Math.PI * 2;
          this.particles.push({ x: cx + Math.cos(a) * 3, y: cy + Math.sin(a) * 2, vx: Math.cos(a) * 18, vy: Math.sin(a) * 12, col: Math.random() < 0.5 ? WHITE : p.col, t0: t, life: 0.4 });
        }
        if (bo.charge <= 0) {
          bo.charge = 0;
          bo.active = false;
          this.events.push({ type: 'boostEnd', x: cx });
        }
      } else if (bo.charge < 1) {
        bo.charge = Math.min(1, bo.charge + dtReal / P.boostRecharge);
        if (bo.charge >= 1) {
          bo.readyAt = t;
          this.fx.light(cx, cy, 0.6, 1.5, p.col, 0.3);
          this.events.push({ type: 'boostReady', x: cx });
        }
      }
      if (p.stomp && P.jumpBoost && !stunned && !bo.active && bo.charge >= 1) {
        bo.active = true;
        bo.at = t;
        this.burst(cx, cy, 40, p.col, 60, 0.7, WHITE);
        this.fx.ripple(cx, cy, 6, 5, 0.5);
        this.fx.light(cx, cy, 1.2, 2.5, p.col, 0.5);
        this.fx.flash(p.col, 0.08);
        this.fx.kick(2, 0.8);
        this.events.push({ type: 'boost', x: cx });
      }
    }
    for (const [id, s] of this.players) if (t - s.seen > 5) this.players.delete(id);
    this.items = this.items.filter((it) => !it.taken && t - it.t0 < it.life);
    while (this.dropLater > 0 && present) {
      this.dropLater--;
      this.dropItem(this.pickPower(), null, people);
    }

    // ---- team lasers: everybody connects to the nearest other person within linkMax; a beam cuts
    // through invaders (one hit per linkCooldown) and through every bullet
    this.links = [];
    if (P.links && people.length > 1) {
      const pairs = new Map();
      for (const a of people) {
        let best = null;
        let bd = P.linkMax;
        for (const b of people) {
          if (b === a) continue;
          const d = Math.hypot((a.center[0] - b.center[0]) / L.sx, (a.center[1] - b.center[1]) / L.sy);
          if (d < bd) {
            bd = d;
            best = b;
          }
        }
        if (!best) continue;
        const key = String(a.id) < String(best.id) ? `${a.id}|${best.id}` : `${best.id}|${a.id}`;
        if (!pairs.has(key)) pairs.set(key, [a, best]);
      }
      for (const [key, [a, b]] of pairs) {
        const sa = bySlot.get(a.slot)?.s;
        const sb = bySlot.get(b.slot)?.s;
        if (!sa || !sb || t < sa.stunUntil || t < sb.stunUntil) continue;
        let st = this.linkState.get(key);
        if (!st) {
          st = { ready: t, flash: -9, born: t };
          this.linkState.set(key, st);
          this.events.push({ type: 'link', x: (a.center[0] + b.center[0]) / 2 });
        }
        st.seen = t;
        const [ax, ay] = a.center;
        const [bx, by] = b.center;
        this.links.push({ key, a, b, st });
        if (t >= st.ready && fighting) {
          let hit = null;
          this.forTargets((tg, x0, y0, w, h) => {
            if (!segBox(ax, ay, bx, by, x0 - 1, y0 - 1, x0 + w + 1, y0 + h + 1)) return true;
            hit = tg;
            return false;
          });
          if (hit) {
            const mixCol = [(a.col[0] + b.col[0]) / 2, (a.col[1] + b.col[1]) / 2, (a.col[2] + b.col[2]) / 2];
            const at = this.targetPos(hit);
            this.damage(hit, 1, a.slot, mixCol, invCol);
            st.ready = t + P.linkCooldown;
            st.flash = t;
            if (at) this.fx.light(at[0], at[1], 0.5, 1.6, WHITE, 0.15);
            this.events.push({ type: 'zap', x: (ax + bx) / 2 });
          }
        }
        this.bullets = this.bullets.filter((bu) => {
          if (segDist(bu.x, bu.y, ax, ay, bx, by) > 1.6) return true;
          this.burst(bu.x, bu.y, 6, WHITE, 25, 0.3, a.col);
          st.flash = t;
          return false;
        });
      }
    }
    for (const [key, st] of this.linkState) if (t - st.seen > 0.5) this.linkState.delete(key);

    // ---- formation invaders and divers that touch a body: an arm destroys them, the body is stunned
    if (body) {
      const touched = [];
      this.forTargets((tg, x0, y0, w, h) => {
        let armSlot = 0;
        let bodySlot = 0;
        for (let y = y0; y < y0 + h && !armSlot; y++) {
          for (let x = Math.floor(x0); x < x0 + w; x++) {
            const s = body.slotAt(x, y);
            if (!s) continue;
            if (body.kindAt(x, y) === 2) {
              armSlot = s;
              break;
            }
            bodySlot = s;
          }
        }
        if (armSlot || bodySlot) touched.push([tg, armSlot, bodySlot, x0 + w / 2, y0 + h / 2]);
        return true;
      });
      for (const [tg, armSlot, bodySlot, x, y] of touched) {
        const who = bySlot.get(armSlot || bodySlot);
        if (!who) continue;
        if (armSlot && t >= who.s.stunUntil) this.damage(tg, 9, who.p.slot, who.p.col, invCol);
        else if (bodySlot && !tg.ufo) {
          this.hitPlayer(who.p, who.s, x, y);
          // a diver that hits a body explodes
          if (tg.diver && this.divers.includes(tg.diver)) {
            this.divers = this.divers.filter((q) => q !== tg.diver);
            this.explodeDiver(tg.diver, null, 0, invCol);
          }
        }
      }
    }

    // ---- divers: steer at their target, explode on the city or a person
    this.divers = this.divers.filter((d) => {
      const age = t - d.t0;
      let tx;
      let ty;
      const who = d.target.id !== undefined ? people.find((p) => p.id === d.target.id) : null;
      if (who) [tx, ty] = who.center;
      else {
        // at the city (also when the person left)
        if (d.target.id !== undefined) d.target = { x: d.side.dirX > 0 ? c.x0 : c.x0 + c.w, y: d.y };
        [tx, ty] = [d.target.x, d.target.y];
      }
      const cur = Math.atan2(d.vy, d.vx);
      let dd = Math.atan2(ty - d.y, tx - d.x) - cur;
      while (dd > Math.PI) dd -= Math.PI * 2;
      while (dd < -Math.PI) dd += Math.PI * 2;
      const turn = (age < 0.5 ? 1.2 : 2.6) * dt;
      const ang = cur + clamp(dd, -turn, turn);
      const v = d.v * (age < 0.4 ? 0.7 : 1);
      d.vx = Math.cos(ang) * v;
      d.vy = Math.sin(ang) * v;
      d.x += d.vx * edt;
      d.y += d.vy * edt;
      d.trailT -= dtReal;
      if (d.trailT <= 0) {
        d.trailT = 0.035;
        d.trail.unshift([d.x, d.y]);
        if (d.trail.length > 7) d.trail.pop();
      }
      if (this.cityAt(d.x, d.y)) {
        this.erode(d.x, d.y, 5.5);
        this.explodeDiver(d, null, 0, invCol);
        return false;
      }
      if (age > 9 || d.x < -20 || d.x > L.AW + 20 || d.y < -20 || d.y > L.AH + 20) {
        if (age > 9) this.explodeDiver(d, null, 0, invCol);
        return false;
      }
      return true;
    });

    // ---- shock waves: a ring runs out from where somebody landed
    this.waves = this.waves.filter((w) => {
      const u = (t - w.t0) / 0.45;
      if (u >= 1) return false;
      const r = w.R * (1 - (1 - u) ** 2);
      const rx = r * L.sx;
      const ry = r * L.sy;
      const inside = (x, y) => ((x - w.x) / Math.max(rx, 1e-3)) ** 2 + ((y - w.y) / Math.max(ry, 1e-3)) ** 2 <= 1;
      const hits = [];
      this.forTargets((tg, x0, y0, bw, bh) => {
        const cx = x0 + bw / 2;
        const cy = y0 + bh / 2;
        const key = tg.diver ?? tg.ufo ?? tg.ship ?? tg.side.edge * 10000 + tg.i;
        if (inside(cx, cy) && !w.done.has(key)) {
          w.done.add(key);
          const d = Math.hypot(cx - w.x, cy - w.y) || 1;
          hits.push([tg, [(cx - w.x) / d, (cy - w.y) / d]]);
        }
        return true;
      });
      for (const [tg, push] of hits) this.damage(tg, w.dmg ?? 2, w.slot, w.col, invCol, push);
      this.bullets = this.bullets.filter((bu) => {
        if (!inside(bu.x, bu.y)) return true;
        this.burst(bu.x, bu.y, 6, WHITE, 25, 0.3, w.col);
        return false;
      });
      return true;
    });

    // ---- the players' shots: locked ones steer after their target
    const W = L.AW;
    const H = L.AH;
    const turn = P.homing * dt;
    this.shots = this.shots.filter((sh) => {
      const at = this.targetPos(sh.target);
      if (at) {
        const v = Math.hypot(sh.vx, sh.vy);
        const cur = Math.atan2(sh.vy, sh.vx);
        let d = Math.atan2(at[1] - sh.y, at[0] - sh.x) - cur;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        const a = cur + clamp(d, -turn, turn);
        sh.vx = Math.cos(a) * v;
        sh.vy = Math.sin(a) * v;
      }
      const k = Math.max(1, Math.ceil((Math.hypot(sh.vx, sh.vy) * dt) / 1.5));
      for (let j = 0; j < k; j++) {
        sh.x += (sh.vx * dt) / k;
        sh.y += (sh.vy * dt) / k;
        if (sh.x < -4 || sh.y < -4 || sh.x > W + 4 || sh.y > H + 4) return false;
        const hit = this.targetAt(sh.x, sh.y, 1);
        if (hit) {
          const v = Math.hypot(sh.vx, sh.vy) || 1;
          this.damage(hit, sh.dmg ?? 1, sh.slot, sh.col, invCol, [sh.vx / v, sh.vy / v]);
          return false;
        }
        for (let m = 0; m < this.bullets.length; m++) {
          const b = this.bullets[m];
          if (Math.abs(b.x - sh.x) < 3.5 && Math.abs(b.y - sh.y) < 2.5) {
            this.bullets.splice(m, 1);
            this.burst(sh.x, sh.y, 8, WHITE, 25, 0.35, sh.col);
            this.fx.light(sh.x, sh.y, 0.3, 1.2, sh.col, 0.12);
            this.events.push({ type: 'block', x: sh.x });
            return false;
          }
        }
      }
      return true;
    });

    // ---- the invaders' bullets: arms block them, a body hit stuns, the city loses a bit
    const harmless = !present; // with nobody there they only splash
    this.bullets = this.bullets.filter((b) => {
      const k = Math.max(1, Math.ceil(Math.hypot(b.vx, b.vy) * dt));
      for (let j = 0; j < k; j++) {
        b.x += (b.vx * edt) / k;
        b.y += (b.vy * edt) / k;
        const hx = b.x;
        const hy = b.y;
        if (hx < -8 || hx > W + 8 || hy < -8 || hy > H + 8) return false;
        if (body) {
          const s = body.slotAt(hx, hy) || body.slotAt(hx, hy - 1) || body.slotAt(hx, hy + 1);
          const who = s && bySlot.get(s);
          if (who) {
            const kind = Math.max(body.kindAt(hx, hy), body.kindAt(hx, hy - 1), body.kindAt(hx, hy + 1));
            if (kind === 2) {
              this.burst(hx, hy, 10, WHITE, 28, 0.4, who.p.col);
              this.fx.light(hx, hy, 0.35, 1.4, who.p.col, 0.15);
              this.events.push({ type: 'block', x: hx });
            } else this.hitPlayer(who.p, who.s, hx, hy);
            return false;
          }
        }
        if (this.cityAt(hx, hy)) {
          if (!harmless) this.erode(hx + Math.sign(b.vx) * 1.5, hy, rand(1.6, 2.6));
          this.booms.push({ x: hx, y: hy, t0: t, col: [1, 0.55, 0.3], splat: true });
          this.fx.light(hx, hy, 0.4, 1.4, ORANGE, 0.2);
          this.events.push({ type: 'city', x: hx });
          return false;
        }
      }
      return true;
    });

    // ---- announced shots, bombs, the battleship
    this.dtLast = dt;
    this.firePending(people);
    this.updateBombs(people, bySlot);
    this.updateShip(people, bySlot, invCol, edt);
    this.updateEdgeLasers(people, bySlot, invCol, dt);
    this.updateShipDeath(dt);
    this.scorches = this.scorches.filter((sc) => t - sc.t0 < 4);
    // damaged invaders spark now and then
    for (const side of this.sides) {
      for (let i = 0; i < side.alive.length; i++) {
        if (!side.alive[i] || side.hp[i] >= side.hpMax[i] || Math.random() > dt * 3) continue;
        const b = this.box(side, i);
        this.particles.push({ x: b[0] + rand(1, b[2] - 1), y: b[1] + rand(1, 7), vx: rand(-12, 12), vy: rand(-12, 12), col: Math.random() < 0.5 ? ORANGE : WHITE, t0: t, life: 0.3 });
      }
    }

    // ---- the mothership
    if (this.ufo) {
      this.ufo.x += this.ufo.vx * dt;
      if (this.ufo.x < -20 || this.ufo.x > W + 4) {
        this.ufo = null;
        this.events.push({ type: 'ufo', on: false, x: 0 });
      }
    }

    // ---- debris slides over the floor and stops (seen from above: no gravity)
    const damp = Math.exp(-3.2 * dt);
    this.particles = this.particles.filter((q) => {
      if (t - q.t0 >= q.life) return false;
      q.vx *= damp;
      q.vy *= damp;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      return true;
    });
    if (this.particles.length > 6000) this.particles.splice(0, this.particles.length - 6000);
    this.booms = this.booms.filter((b) => t - b.t0 < 0.25);
  }
}
