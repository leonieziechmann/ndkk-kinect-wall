// The game, in wall meters (x from the left edge of the wall, y above the floor, up).
//
// Fruit is thrown up from below the wall in arcs that peak where the people can reach them. A fast hand
// cuts it (people.js: blades): two halves fly apart and show the inside, juice sprays, a splash stays on
// the wall for a moment. Several fruits in one swipe are a combo. Bombs hurt (points off, a big bang),
// the star fruit starts a frenzy (fruit flies in from both sides), the frost fruit slows time down.
//
// Cuts happen at once on the live hands. With live + exact tracking the exact skeletons follow
// 150-250 ms later: a swipe that live missed still cuts then, tested against where the fruit was at
// that moment (every fruit keeps its way of the last second). Only fruit: a bomb goes off on live hits
// alone, so a late correction never punishes anybody.
//
// Rounds like the jump'n'run: as soon as people are there a round starts (the bar at the top fills),
// runs `roundTime` s (the bar empties), the last seconds get wild, then the remaining fruit bursts and
// the best of the round wears the crown in the next one. Nobody there: now and then a fruit flies and a
// ghost blade cuts it, to show what happens. No text: everyone finds out by trying.

import { KINDS, NORMAL } from './fruits.js';

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

function segDist(px, py, s) {
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  const l2 = dx * dx + dy * dy;
  const h = l2 > 1e-9 ? clamp(((px - s.x0) * dx + (py - s.y0) * dy) / l2, 0, 1) : 0;
  return Math.hypot(px - s.x0 - dx * h, py - s.y0 - dy * h);
}

/** where a fruit was at real time t: its way is [t, x, y, t, x, y, ...]; null if not yet thrown */
function wayAt(way, t) {
  if (!way?.length || t < way[0] || t > way[way.length - 3] + 0.05) return null;
  for (let i = 3; i < way.length; i += 3) {
    if (way[i] < t) continue;
    const w = (t - way[i - 3]) / Math.max(1e-6, way[i] - way[i - 3]);
    return [way[i - 2] + (way[i + 1] - way[i - 2]) * w, way[i - 1] + (way[i + 2] - way[i - 1]) * w];
  }
  return [way[way.length - 2], way[way.length - 1]];
}

// embers: orange -> deep red -> magenta -> violet (never brown)
const EMBERS = [
  [1, 0.85, 0.4],
  [1, 0.45, 0.1],
  [1, 0.1, 0.2],
  [0.9, 0.1, 0.6],
  [0.5, 0.15, 0.9],
];
export function ember(u, out = [0, 0, 0]) {
  const f = clamp(u, 0, 0.999) * (EMBERS.length - 1);
  const i = Math.floor(f);
  const w = f - i;
  for (let k = 0; k < 3; k++) out[k] = EMBERS[i][k] + (EMBERS[i + 1][k] - EMBERS[i][k]) * w;
  return out;
}

export class Game {
  constructor(fx) {
    this.fx = fx;
    this.fruits = [];
    this.halves = [];
    this.drops = []; // juice and sparks: { x, y, vx, vy, col, size (art px), t0, life, ember }
    this.splats = []; // juice on the wall: { x, y, col, blocks: [[dx, dy, unit, death]], t0, life }
    this.slashes = []; // the white flash of a cut: { x0, y0, x1, y1, t0, life }
    this.rings = []; // shock waves: { x, y, r0, r1, col, t0, life, w }
    this.pops = []; // numbers: { text, x, y, h, col, t0, life }
    this.queue = []; // fruits to throw a moment later: { at, opts }
    this.events = []; // for the sound
    this.combos = new Map(); // blade key -> { n, last, x, y, id, slot }
    this.scores = new Map(); // person id -> { pts, slot }
    this.hurt = new Map(); // slot -> real time of a bomb hit
    this.crown = null; // id of the best of the last round
    this.time = 0; // game time (slows down in slow motion and frost)
    this.real = 0;
    this.phase = 'idle';
    this.phaseT = 0;
    this.roundLeft = 0;
    this.roundTime = 60;
    this.roundAge = 0;
    this.emptyFor = 0;
    this.nextVolley = 1;
    this.nextDemo = 4;
    this.frenzy = 0;
    this.frenzyNext = 0;
    this.rr = 0; // round robin over the people
    this.nextId = 1;
    this.stats = { thrown: 0, cut: 0, late: 0, bombs: 0, missed: 0, combos: 0, rounds: 0, segs: 0, lateSegs: 0 };
  }

  award(id, slot, pts) {
    if (id === null || id === undefined) return;
    const s = this.scores.get(id) ?? { pts: 0, slot };
    s.pts = Math.max(0, s.pts + pts);
    s.slot = slot;
    this.scores.set(id, s);
  }

  /** throws a fruit; opts: { kind, target ({ x, headY }), from: 'below' | 'left' | 'right' } */
  launch(world, opts = {}) {
    const P = world.params;
    const W = world.wallW;
    const kind = opts.kind ?? pick(NORMAL);
    const K = KINDS[kind];
    const r = K.r * P.size;
    const g = P.gravity * P.tempo * P.tempo;
    let x;
    let y;
    let vx;
    let vy;
    if (opts.from === 'left' || opts.from === 'right') {
      // frenzy: in from the side, across the wall
      const s = opts.from === 'left' ? 1 : -1;
      x = s > 0 ? -r : W + r;
      y = rand(world.bottom + 0.35, world.bottom + 1.1);
      vx = s * rand(1.5, 2.6) * P.tempo;
      vy = rand(1.2, 2.3) * P.tempo;
    } else {
      // from below the wall, the top of the arc where the target can reach it
      const t = opts.target;
      const top = world.top - r - 0.04;
      const hi = t ? Math.min(top, t.headY + 0.3) : top - 0.1;
      const lo = Math.max(world.bottom + 0.6, t ? t.headY - 0.95 : world.bottom + 0.8);
      const apexY = rand(Math.min(lo, hi - 0.05), hi);
      const apexX = clamp(t ? t.x + rand(-0.75, 0.75) : rand(0.5, W - 0.5), r + 0.1, W - r - 0.1);
      y = world.bottom - r - 0.02;
      const tUp = Math.sqrt((2 * Math.max(0.2, apexY - y)) / g);
      vx = rand(-0.35, 0.35) * P.tempo;
      // towards the middle near the edges, so it stays on the wall
      if (apexX < 1) vx = Math.abs(vx);
      if (apexX > W - 1) vx = -Math.abs(vx);
      x = apexX - vx * tUp;
      vy = g * tUp;
    }
    const f = { id: this.nextId++, kind, x, y, vx, vy, r, g, rot: rand(0, Math.PI * 2), vr: rand(-2.6, 2.6) * (kind === 'melon' ? 0.6 : 1), born: this.time, way: [] };
    this.fruits.push(f);
    this.stats.thrown++;
    this.events.push({ type: 'throw', x, kind });
    return f;
  }

  /** what to throw next */
  kindFor(world, allowSpecial = true) {
    const P = world.params;
    if (this.phase === 'play' && this.roundAge > P.bombAfter && Math.random() < P.bombs) return 'bomb';
    if (allowSpecial && this.phase === 'play' && this.frenzy <= 0 && this.fx.timeScale >= 1 && Math.random() < P.specials) return Math.random() < 0.55 ? 'star' : 'frost';
    return pick(NORMAL);
  }

  volley(world) {
    const P = world.params;
    const people = world.people;
    const n = people.length;
    let count = Math.round(rand(1, 1 + P.amount * Math.pow(n, 0.85)));
    if (this.phase === 'play' && this.roundLeft < P.finale) count += 1 + Math.floor(n / 2);
    count = clamp(count, 1, 9);
    let bombs = 0;
    let special = false;
    for (let k = 0; k < count; k++) {
      const target = n ? people[this.rr++ % n] : null;
      let kind = this.kindFor(world, !special);
      // never only bombs, and at most one per two people in a volley
      if (kind === 'bomb' && (bombs >= Math.max(1, Math.floor(n / 2)) || (count === 1 && Math.random() < 0.5))) kind = pick(NORMAL);
      if (kind === 'bomb') bombs++;
      if (KINDS[kind].special) special = true;
      this.queue.push({ at: this.time + k * rand(0.07, 0.17), opts: { kind, target } });
    }
  }

  /** a fruit is cut by segment s (or burst: s = null, no points) */
  cut(f, s, world, scored = true) {
    const i = this.fruits.indexOf(f);
    if (i < 0) return;
    this.fruits.splice(i, 1);
    const P = world.params;
    const fx = this.fx;
    const K = KINDS[f.kind];
    let ux;
    let uy;
    if (s) {
      const l = Math.hypot(s.x1 - s.x0, s.y1 - s.y0) || 1;
      ux = (s.x1 - s.x0) / l;
      uy = (s.y1 - s.y0) / l;
    } else {
      const a = rand(0, Math.PI * 2);
      ux = Math.cos(a);
      uy = Math.sin(a);
    }
    if (f.kind === 'bomb') {
      this.boom(f, s, world, scored);
      return;
    }
    const nx = -uy;
    const ny = ux;
    const speed = s ? Math.min(s.v, 5) : 2;
    const sep = 0.45 + speed * 0.08;
    const na = Math.atan2(ny, nx) - f.rot; // the cut's normal in the fruit's frame
    for (const side of [1, -1]) {
      this.halves.push({
        kind: f.kind,
        x: f.x,
        y: f.y,
        vx: f.vx * 0.6 + nx * side * sep + ux * speed * 0.12,
        vy: f.vy * 0.4 + ny * side * sep + uy * speed * 0.12 + 0.3,
        r: f.r,
        g: f.g,
        rot: f.rot,
        vr: f.vr * 0.5 + side * rand(1.5, 3.5),
        na,
        side,
        born: this.time,
      });
    }
    // juice: along the cut and out of both sides
    const n = Math.round(14 + f.r * 70);
    for (let k = 0; k < n; k++) {
      const along = rand(-1, 1);
      const side = Math.random() < 0.5 ? 1 : -1;
      const sp = rand(0.6, 2.4);
      this.drops.push({
        x: f.x + ux * along * f.r,
        y: f.y + uy * along * f.r,
        vx: ux * sp * rand(0.3, 1.1) + nx * side * sp * rand(0.2, 0.8) + f.vx * 0.3,
        vy: uy * sp * rand(0.3, 1.1) + ny * side * sp * rand(0.2, 0.8) + f.vy * 0.2 + 0.4,
        col: K.juice,
        size: Math.random() < 0.3 ? 1 : 0.5,
        t0: this.time,
        life: rand(0.4, 0.9),
      });
    }
    this.splat(f.x, f.y, f.r, K.juice, world.cell);
    this.slashes.push({ x0: f.x - ux * f.r * 2, y0: f.y - uy * f.r * 2, x1: f.x + ux * f.r * 2, y1: f.y + uy * f.r * 2, t0: this.real, life: 0.22 });
    fx.light(f.x, f.y, 0.7, 1.1, K.juice, 0.35);
    fx.ripple(f.x, f.y, 2.5, 2.5, 0.35);
    // a short hit stop: the halves hang for a moment before they fly (the blades go on in real time)
    if (scored && P.hitStop > 0) fx.slow(P.hitStop, 0.12);
    this.events.push({ type: 'cut', x: f.x, kind: f.kind, r: f.r, quiet: !scored });
    if (!scored) return;
    this.stats.cut++;
    if (s) {
      this.award(s.id, s.slot, 1);
      const c = this.combos.get(s.key);
      if (c && this.real - c.last < P.comboGap) {
        c.n++;
        c.last = this.real;
        c.x = f.x;
        c.y = f.y;
      } else this.combos.set(s.key, { n: 1, last: this.real, x: f.x, y: f.y, id: s.id, slot: s.slot, col: null });
    }
    if (f.kind === 'star') {
      this.frenzy = P.frenzyTime;
      this.frenzyNext = 0;
      fx.flash([1, 0.75, 0.2], 0.35);
      fx.kick(0.4, 0.6);
      this.rings.push({ x: f.x, y: f.y, r0: f.r, r1: 1.6, col: K.aura, t0: this.real, life: 0.6, w: 0.05 });
      this.events.push({ type: 'frenzy', x: f.x });
    } else if (f.kind === 'frost') {
      if (P.slowmo) fx.slow(P.freezeTime, 0.4);
      fx.flash([0.5, 0.85, 1], 0.4);
      this.rings.push({ x: f.x, y: f.y, r0: f.r, r1: 2.4, col: K.aura, t0: this.real, life: 0.8, w: 0.05 });
      this.events.push({ type: 'freeze', x: f.x });
    }
  }

  /**
   * juice on the wall: a solid blob with a frayed edge, droplets around and a few runs downwards. Every
   * block dies on its own (the edge first), so the splash breaks up instead of getting dim (dim yellow
   * would look olive). cell: m per art pixel.
   */
  splat(x, y, r, col, cell) {
    const blocks = [];
    const R = r * 1.05;
    const lobes = [rand(0, 6.28), rand(0, 6.28), rand(0, 6.28)];
    const n = Math.ceil((R * 1.3) / cell);
    for (let j = -n; j <= n; j++) {
      for (let i = -n; i <= n; i++) {
        const xx = i * cell;
        const yy = j * cell;
        const a = Math.atan2(yy, xx);
        const edge = R * (0.7 + 0.16 * Math.sin(a * 3 + lobes[0]) + 0.1 * Math.sin(a * 5 + lobes[1]) + 0.06 * Math.sin(a * 8 + lobes[2]));
        const d = Math.hypot(xx, yy);
        if (d > edge) continue;
        blocks.push([xx, yy, 1, (0.45 + 0.55 * Math.random()) * (1 - 0.6 * (d / edge) ** 2)]);
      }
    }
    for (let k = 0; k < 12; k++) {
      const a = rand(0, 6.28);
      const d = R * rand(1.05, 2);
      blocks.push([Math.cos(a) * d, Math.sin(a) * d, Math.random() < 0.5 ? 1 : 0.5, rand(0.2, 0.6)]);
    }
    // runs: columns of blocks below the blob that grow down over the first part of its life
    for (let k = 0; k < 3; k++) {
      const xx = rand(-0.6, 0.6) * R;
      const len = rand(0.4, 1.1) * R;
      for (let yy = -R * 0.5; yy > -R * 0.5 - len; yy -= cell) blocks.push([xx, yy, 1, rand(0.35, 0.75), (-R * 0.5 - yy) / len]);
    }
    if (this.splats.length > 40) this.splats.shift();
    this.splats.push({ x, y, col, blocks, t0: this.real, life: 2 });
  }

  boom(f, s, world, scored) {
    const P = world.params;
    const fx = this.fx;
    this.stats.bombs++;
    fx.flash([1, 1, 1], scored ? 0.9 : 0.4);
    fx.kick(scored ? 1.3 : 0.5, scored ? 1.2 : 0.4);
    fx.ripple(f.x, f.y, 9, 3.5, 0.9);
    fx.light(f.x, f.y, 2.2, 2, [1, 0.5, 0.15], 0.8);
    this.rings.push({ x: f.x, y: f.y, r0: f.r, r1: 1.4, col: [1, 0.75, 0.4], t0: this.real, life: 0.5, w: 0.08 });
    this.rings.push({ x: f.x, y: f.y, r0: f.r, r1: 0.9, col: [1, 0.2, 0.4], t0: this.real, life: 0.7, w: 0.05 });
    for (let k = 0; k < 46; k++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(0.8, 4);
      this.drops.push({ x: f.x, y: f.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 0.6, col: null, ember: true, size: Math.random() < 0.35 ? 1 : 0.5, t0: this.time, life: rand(0.5, 1.2) });
    }
    this.events.push({ type: 'boom', x: f.x, quiet: !scored });
    if (!scored) return;
    // everything close by bursts, no points
    for (const o of this.fruits.slice()) if (Math.hypot(o.x - f.x, o.y - f.y) < 0.9 && o.kind !== 'bomb') this.cut(o, null, world, false);
    if (s) {
      this.award(s.id, s.slot, -P.bombPenalty);
      if (s.slot) this.hurt.set(s.slot, this.real);
      this.combos.delete(s.key);
      if (s.id !== null) this.pops.push({ text: `-${P.bombPenalty}`, x: f.x, y: f.y + 0.15, h: 9, col: [1, 0.25, 0.35], t0: this.real, life: 1.2, vy: 0.25 });
    }
  }

  /** the end of a round: everything bursts, the best gets the crown */
  endRound(world) {
    this.phase = 'end';
    this.phaseT = 0;
    this.stats.rounds++;
    let best = null;
    for (const [id, s] of this.scores) if (s.pts > 0 && (!best || s.pts > best.pts)) best = { id, pts: s.pts };
    this.crown = best?.id ?? null;
    for (const f of this.fruits.slice()) {
      if (f.kind === 'bomb') this.boom(f, null, world, false);
      else this.cut(f, null, world, false);
    }
    this.fruits.length = 0;
    this.queue.length = 0;
    this.frenzy = 0;
    this.fx.flash([1, 0.85, 0.6], 0.3);
    this.events.push({ type: 'end', x: world.wallW / 2 });
  }

  startRound(world) {
    const P = world.params;
    this.phase = P.roundTime > 0 ? 'ready' : 'play';
    this.phaseT = 0;
    this.roundTime = P.roundTime;
    this.roundLeft = P.roundTime;
    this.roundAge = 0;
    this.scores.clear();
    this.combos.clear();
    this.nextVolley = 0.6;
    this.events.push({ type: 'ready', x: world.wallW / 2 });
  }

  /**
   * One frame. dt: real seconds. world: { wallW, top, bottom, people ([{ id, slot, x, headX, headY }]),
   * segs (cutting blade segments of this frame, people.js), lateSegs (those of the exact skeletons,
   * with t0/t1 in real time), entered (person ids), params, script(pts, dur) }
   */
  step(dt, world) {
    const P = world.params;
    const fx = this.fx;
    const gdt = dt * fx.timeScale;
    this.time += gdt;
    this.real += dt;
    const t = this.time;
    const people = world.people;
    const n = people.length;
    if (n) this.emptyFor = 0;
    else this.emptyFor += dt;

    // ---- rounds
    this.phaseT += dt;
    if (this.phase === 'idle') {
      if (n) this.startRound(world);
    } else if (this.phase === 'ready') {
      if (this.phaseT >= 1.8) {
        this.phase = 'play';
        this.phaseT = 0;
        this.events.push({ type: 'go', x: world.wallW / 2 });
      }
      if (this.emptyFor > 2) this.phase = 'idle';
    } else if (this.phase === 'play') {
      this.roundAge += dt;
      if (P.roundTime > 0) {
        this.roundLeft -= dt;
        if (this.roundLeft <= 0) this.endRound(world);
      }
      if (this.emptyFor > P.resetAfter) {
        this.phase = 'idle';
        this.scores.clear();
      }
    } else if (this.phase === 'end') {
      if (this.phaseT >= P.endTime) {
        if (n) this.startRound(world);
        else this.phase = 'idle';
      }
    }

    // ---- throwing
    if (this.phase === 'play') {
      if (this.frenzy > 0) {
        this.frenzy -= dt;
        this.frenzyNext -= gdt;
        if (this.frenzyNext <= 0) {
          this.frenzyNext = rand(0.12, 0.22);
          this.launch(world, { kind: pick(NORMAL), from: Math.random() < 0.5 ? 'left' : 'right' });
        }
      }
      this.nextVolley -= gdt;
      if (this.nextVolley <= 0) {
        this.volley(world);
        const crowd = clamp((n - 1) / 5, 0, 1);
        let every = P.every * (1 - 0.35 * crowd) * rand(0.8, 1.2);
        if (P.roundTime > 0 && this.roundLeft < P.finale) every *= 0.6;
        if (this.frenzy > 0) every *= 1.6;
        this.nextVolley = every / P.tempo;
      }
      // newcomers get two fruits right in front of them
      for (const id of world.entered) {
        const me = people.find((q) => q.id === id);
        if (me) for (let k = 0; k < 2; k++) this.queue.push({ at: t + 0.3 + k * 0.25, opts: { kind: pick(NORMAL), target: me } });
      }
    } else if (this.phase === 'idle') {
      // attract: a fruit now and then, and a ghost blade cuts one at the top of its arc
      this.nextVolley -= gdt;
      if (this.nextVolley <= 0) {
        this.nextVolley = rand(1.6, 3);
        const k = Math.random() < 0.3 ? 2 : 1;
        for (let i = 0; i < k; i++) this.queue.push({ at: t + i * 0.2, opts: { kind: Math.random() < 0.06 ? 'bomb' : pick(NORMAL) } });
      }
      this.nextDemo -= dt;
      if (this.nextDemo <= 0) {
        const f = this.fruits.find((o) => o.kind !== 'bomb' && Math.abs(o.vy) < 0.5 && o.y > world.bottom + 0.6);
        if (f) {
          this.nextDemo = rand(3.5, 6);
          const a = rand(-0.6, 0.6) + (Math.random() < 0.5 ? 0 : Math.PI);
          const dx = Math.cos(a);
          const dy = Math.sin(a);
          const L = 0.8;
          const sag = 0.12;
          world.script(
            [0, 0.25, 0.5, 0.75, 1].map((u) => {
              const w = (u - 0.5) * 2 * L;
              const bend = (1 - (u - 0.5) ** 2 * 4) * sag;
              return [f.x + dx * w - dy * bend, f.y + dy * w + dx * bend];
            }),
            0.22,
          );
        }
      }
    }
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i];
      if (t < q.at) continue;
      this.queue.splice(i, 1);
      // a target that left is replaced by anybody (or nobody)
      if (q.opts.target && !people.some((p) => p.id === q.opts.target.id)) q.opts.target = n ? pick(people) : null;
      else if (q.opts.target) q.opts.target = people.find((p) => p.id === q.opts.target.id);
      this.launch(world, q.opts);
    }

    // ---- motion
    for (const f of this.fruits) {
      f.vy -= f.g * gdt;
      f.x += f.vx * gdt;
      f.y += f.vy * gdt;
      f.rot += f.vr * gdt;
      // its way (real time, as the blades): where it was when a late exact frame was live
      const way = (f.way ??= []);
      way.push(this.real, f.x, f.y);
      if (way.length > 3 && this.real - way[0] > 1) way.splice(0, 3);
    }
    for (const h of this.halves) {
      h.vy -= h.g * 1.25 * gdt;
      h.x += h.vx * gdt;
      h.y += h.vy * gdt;
      h.rot += h.vr * gdt;
    }
    for (const d of this.drops) {
      d.vy -= 5.5 * gdt;
      d.vx *= 1 - gdt * 1.2;
      d.x += d.vx * gdt;
      d.y += d.vy * gdt;
    }

    // ---- cuts
    this.stats.segs += world.segs.length;
    for (const s of world.segs) {
      for (const f of this.fruits.slice()) {
        if (t - f.born < 0.05 || f.y + f.r < world.bottom) continue;
        if (segDist(f.x, f.y, s) <= f.r * P.hit + P.bladeR) this.cut(f, s, world, this.phase !== 'idle' || s.id !== null);
      }
    }
    // late cuts: the exact skeletons of frames that are 150-250 ms old, against where the fruit was then
    this.stats.lateSegs += world.lateSegs?.length ?? 0;
    for (const s of world.lateSegs ?? []) {
      const tm = (s.t0 + s.t1) / 2;
      for (const f of this.fruits.slice()) {
        if (f.kind === 'bomb') continue;
        const at = wayAt(f.way, tm);
        if (!at || at[1] + f.r < world.bottom) continue;
        if (segDist(at[0], at[1], s) <= f.r * P.hit + P.bladeR) {
          this.stats.late++;
          this.cut(f, s, world, this.phase !== 'idle');
        }
      }
    }
    // combos end when the swipe pauses
    for (const [key, c] of this.combos) {
      if (this.real - c.last < P.comboGap) continue;
      this.combos.delete(key);
      if (c.n < 3) continue;
      this.stats.combos++;
      this.award(c.id, c.slot, c.n);
      const col = world.colorOf(c.slot);
      this.pops.push({ text: `${c.n}x`, x: c.x, y: c.y + 0.12, h: 8 + Math.min(6, c.n), col, t0: this.real, life: 1.3, vy: 0.3 });
      this.rings.push({ x: c.x, y: c.y, r0: 0.1, r1: 0.5 + 0.08 * c.n, col, t0: this.real, life: 0.45, w: 0.04 });
      fx.flash(col, 0.25);
      fx.kick(0.3, 0.8);
      if (P.slowmo && c.n >= 4) fx.slow(0.5, 0.35);
      this.events.push({ type: 'combo', x: c.x, n: c.n });
    }

    // ---- gone
    const W = world.wallW;
    for (let i = this.fruits.length - 1; i >= 0; i--) {
      const f = this.fruits[i];
      if ((f.vy < 0 && f.y < world.bottom - f.r - 0.15) || f.x < -1 || f.x > W + 1) {
        this.fruits.splice(i, 1);
        if (f.kind !== 'bomb') this.stats.missed++;
      }
    }
    this.halves = this.halves.filter((h) => h.y > world.bottom - h.r - 0.3 && t - h.born < 4);
    this.drops = this.drops.filter((d) => t - d.t0 < d.life);
    this.splats = this.splats.filter((s) => this.real - s.t0 < s.life);
    this.slashes = this.slashes.filter((s) => this.real - s.t0 < s.life);
    this.rings = this.rings.filter((r) => this.real - r.t0 < r.life);
    this.pops = this.pops.filter((p) => this.real - p.t0 < p.life);
    for (const [slot, at] of this.hurt) if (this.real - at > 0.8) this.hurt.delete(slot);
  }
}
