// The game: soap bubbles float up the wall, the people pop them. Pure JS, in wall meters:
// x from the left edge of the wall, y = height above the floor (up).
//
// A bubble pops when a body moves into it (wall cells newly covered in this frame, see grid.js):
// a slap or a swipe pops, a hand held still only pushes it away, so bubbles can rest on a head or
// slide around a shoulder. Kinds: normal, star (pops everything around it in a chain), giant
// (splits into four). The score is the group's; everyone also gets their own count above the head.

export const KIND = { NORMAL: 0, STAR: 1, GIANT: 2 };
export const FX = { BUBBLE: 0, RING: 1, DOT: 2, GLYPH: 3 };

const rand = (a, b) => a + Math.random() * (b - a);
const BEST_KEY = 'blasen-platzen:best';

/** neon: cyan, blue, violet, magenta, pink and back (no yellow or green, they fade to olive) */
export function neon(x, out = [0, 0, 0]) {
  const tri = Math.abs((((x % 1) + 1) % 1) * 2 - 1);
  const h = 0.5 + 0.47 * tri;
  const s = 0.8;
  for (let i = 0; i < 3; i++) {
    const k = Math.abs(((h + [0, 2 / 3, 1 / 3][i]) % 1) * 6 - 3);
    out[i] = 1 - s + s * Math.min(Math.max(k - 1, 0), 1);
  }
  return out;
}

function loadBest() {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}
function saveBest(v) {
  try {
    localStorage.setItem(BEST_KEY, String(v));
  } catch {
    /* no storage: the record lasts until the page reloads */
  }
}

export class Game {
  constructor() {
    this.bubbles = [];
    this.fx = []; // effects with a life: rings, droplets, flashes, "+1"
    this.chain = []; // scheduled pops of a star's chain: { at, bubble, slot }
    this.events = []; // for the sound: { type, x, r, kind }
    this.score = 0;
    this.best = loadBest();
    this.bestAtStart = this.best;
    this.perPerson = new Map(); // person id -> points
    this.sinceWave = 0;
    this.wave = 0; // seconds left of a bubble wave
    this.emptyFor = 0;
    this.demoAt = 0;
    this.time = 0;
    this.nextId = 1;
    this.contacts = []; // contact speeds (m/s) of the last bubble/body contacts, for tuning
    this.stats = { hit: 0, chain: 0, age: 0, demo: 0, mouse: 0, escaped: 0, spawned: 0 }; // for tests and tuning
  }

  /** points for someone (slot 0 = nobody / the mouse: only the group score) */
  award(points, slot, persons) {
    this.score += points;
    if (this.score > this.best) this.best = this.score;
    const p = slot ? persons.bySlot?.(slot) : null;
    if (p) this.perPerson.set(p.id, (this.perPerson.get(p.id) ?? 0) + points);
  }

  spawn(world, opts = {}) {
    const P = world.params;
    const people = world.people;
    const W = world.wallW;
    let kind = KIND.NORMAL;
    if (people.length && !opts.kind) {
      const r = Math.random();
      if (r < P.starChance) kind = KIND.STAR;
      else if (r < P.starChance + P.giantChance) kind = KIND.GIANT;
    }
    if (opts.kind !== undefined) kind = opts.kind;
    const size = P.size;
    const r = opts.r ?? (kind === KIND.GIANT ? rand(0.28, 0.34) : kind === KIND.STAR ? 0.13 : rand(0.08, 0.16)) * size;
    // near the people more often, so everyone gets some; else anywhere on the wall
    let x = rand(r, W - r);
    if (people.length && Math.random() < 0.7) {
      const p = people[Math.floor(Math.random() * people.length)];
      x = Math.min(W - r, Math.max(r, p.x + rand(-1.3, 1.3)));
    }
    // most rise from below the wall, some appear in the air (not inside a person)
    let y = world.bottom - r;
    let grow = 0.5;
    if (Math.random() < 0.4) {
      for (let tries = 0; tries < 4; tries++) {
        const yy = rand(world.bottom + 0.5, world.top - 0.3);
        if (world.grid.probe(x, yy, r * 1.5, world.top).covered === 0) {
          y = yy;
          grow = 0.35;
          break;
        }
        x = rand(r, W - r);
      }
    }
    const b = {
      id: this.nextId++,
      kind,
      x: opts.x ?? x,
      y: opts.y ?? y,
      r,
      vx: opts.vx ?? rand(-0.05, 0.05),
      vy: opts.vy ?? 0,
      rise: (kind === KIND.GIANT ? rand(0.07, 0.1) : rand(0.12, 0.26)) * P.speed,
      drift: rand(-0.06, 0.06),
      hue: Math.random(),
      phase: rand(0, 6.28),
      born: this.time,
      grow, // s to full size
      graceUntil: this.time + (opts.grace ?? 0),
      life: rand(22, 30),
    };
    this.bubbles.push(b);
    this.stats.spawned++;
    return b;
  }

  pop(b, slot, world, cause = 'hit') {
    const i = this.bubbles.indexOf(b);
    if (i < 0) return;
    this.bubbles.splice(i, 1);
    this.stats[cause] = (this.stats[cause] ?? 0) + 1;
    const t = this.time;
    const col = neon(b.hue + 0.3);
    const scored = cause !== 'escape' && cause !== 'age' && cause !== 'demo';
    const points = b.kind === KIND.STAR ? 5 : b.kind === KIND.GIANT ? 3 : 1;
    if (scored) this.award(points, slot, world.persons);

    // the burst: a ring, droplets flying out, a flash
    this.fx.push({ kind: FX.RING, x: b.x, y: b.y, r0: b.r, r1: b.r * 1.9, w: 0.06, col: col.map((c) => 0.45 + 0.55 * c), t0: t, life: 0.3, a: 1 });
    const n = b.kind === KIND.GIANT ? 22 : Math.round(9 + b.r * 30);
    for (let k = 0; k < n; k++) {
      const ang = rand(0, Math.PI * 2);
      const sp = rand(0.6, 2.2) * (0.6 + b.r * 3);
      this.fx.push({
        kind: FX.DOT,
        x: b.x + Math.cos(ang) * b.r,
        y: b.y + Math.sin(ang) * b.r,
        vx: Math.cos(ang) * sp + b.vx,
        vy: Math.sin(ang) * sp + b.vy,
        size: rand(0.012, 0.026),
        col: neon(b.hue + rand(-0.25, 0.25)),
        t0: t,
        life: rand(0.35, 0.75),
        a: 1,
        gravity: true,
      });
    }
    this.fx.push({ kind: FX.DOT, x: b.x, y: b.y, size: b.r * 0.9, col: [1, 1, 1], t0: t, life: 0.12, a: 0.7 });
    if (scored && world.params.numbers) {
      const pc = slot ? world.persons.bySlot?.(slot)?.color : null;
      this.fx.push({ kind: FX.GLYPH, text: `+${points}`, x: b.x, y: b.y + b.r * 0.3, vy: 0.45, h: 0.09 + points * 0.006, col: pc ?? col, t0: t, life: 0.9, a: 1 });
    }
    this.events.push({ type: 'pop', x: b.x, r: b.r, kind: b.kind, quiet: !scored });

    if (b.kind === KIND.GIANT) {
      // four children fly out; they cannot be popped for a moment, else the same slap takes them all
      for (let k = 0; k < 4; k++) {
        const ang = (k / 4) * Math.PI * 2 + rand(-0.3, 0.3) + Math.PI / 4;
        this.spawn(world, {
          kind: KIND.NORMAL,
          r: b.r * 0.45,
          x: b.x + Math.cos(ang) * b.r * 0.5,
          y: b.y + Math.sin(ang) * b.r * 0.5,
          vx: Math.cos(ang) * 0.9,
          vy: Math.sin(ang) * 0.9,
          grace: 0.5,
        });
      }
    }
    if (b.kind === KIND.STAR) {
      // chain: everything around pops, nearer ones first
      const R = world.params.chainRadius;
      this.fx.push({ kind: FX.RING, x: b.x, y: b.y, r0: b.r, r1: R, w: 0.04, col: [1, 0.6, 1], t0: t, life: 0.55, a: 1 });
      for (const o of this.bubbles) {
        const d = Math.hypot(o.x - b.x, o.y - b.y);
        if (d < R + o.r && !this.chain.some((c) => c.bubble === o)) this.chain.push({ at: t + 0.05 + (d / R) * 0.45, bubble: o, slot });
      }
      this.events.push({ type: 'star', x: b.x });
    }
    if (scored && ++this.sinceWave >= world.params.waveEvery) {
      this.sinceWave = 0;
      this.wave = 6;
      this.events.push({ type: 'wave', x: world.wallW / 2 });
    }
  }

  /**
   * One animation frame. world: { wallW, top, bottom, grid, fresh (new grid this frame),
   * frameRate (1, or less when Kinect frames were skipped since the last grid), people
   * ([{ x, id, slot }] wall m), persons (ctx.persons), params, pointer ({ x, y, vx, vy, down } wall m) }
   */
  step(dt, world) {
    this.time += dt;
    const t = this.time;
    const P = world.params;
    const B = this.bubbles;
    const people = world.people;

    // group session: a few seconds after the last person left, the score starts again
    if (people.length) this.emptyFor = 0;
    else if ((this.emptyFor += dt) > P.resetAfter && this.score > 0) {
      if (this.best > this.bestAtStart) saveBest(this.best);
      this.bestAtStart = this.best;
      this.score = 0;
      this.sinceWave = 0;
      this.perPerson.clear();
    }
    for (const id of world.persons.left ?? []) this.perPerson.delete(id);
    this.wave = Math.max(0, this.wave - dt);

    // spawning: more people, more bubbles; a wave triples them for a few seconds
    let target = people.length ? P.count + P.perPerson * people.length : P.idleCount;
    if (this.wave > 0) target *= 2.5;
    const rate = people.length ? (this.wave > 0 ? 8 : 2.5) : 0.5;
    if (B.length < target && Math.random() < rate * dt) this.spawn(world);
    // a welcome: newcomers get a few bubbles right around them
    for (const p of world.persons.entered ?? []) {
      const me = people.find((q) => q.id === p.id);
      if (!me) continue;
      for (let k = 0; k < 3; k++) this.spawn(world, { x: me.x + rand(-0.6, 0.6), y: rand(0.9, 1.6), grace: 0.6 });
    }

    // motion: rise towards their speed, drift, sway
    const k = 1 - Math.exp(-dt * 0.9);
    for (const b of B) {
      const tvx = b.drift + Math.sin(t * 0.37 + b.phase) * 0.05;
      b.vx += (tvx - b.vx) * k;
      b.vy += (b.rise - b.vy) * k;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.x < b.r) {
        b.x = b.r;
        b.vx = Math.abs(b.vx) * 0.5;
      } else if (b.x > world.wallW - b.r) {
        b.x = world.wallW - b.r;
        b.vx = -Math.abs(b.vx) * 0.5;
      }
    }
    // bubbles do not overlap: push pairs apart
    for (let i = 0; i < B.length; i++) {
      for (let j = i + 1; j < B.length; j++) {
        const a = B[i];
        const b = B[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const min = (a.r + b.r) * 0.95;
        if (d >= min || d < 1e-6) continue;
        const push = (min - d) * 0.5;
        const nx = dx / d;
        const ny = dy / d;
        a.x -= nx * push;
        a.y -= ny * push;
        b.x += nx * push;
        b.y += ny * push;
      }
    }

    // the people: a body moving into a bubble pops it, else it is pushed away from the body.
    // How fast the outline moved in: the newly covered area over the length of the outline in the
    // bubble, per frame (30/s). A still body's outline flickers by single cells: that is slow.
    if (world.fresh) {
      const minArea = 3 * 2.25e-4; // three cells, against single specks
      for (const b of B.slice()) {
        const scale = Math.min(1, (t - b.born) / b.grow);
        const pr = world.grid.probe(b.x, b.y, b.r * scale, world.top);
        if (pr.covered === 0) continue;
        const speed = (pr.fresh / Math.max(pr.edge, 0.05)) * 30 * world.frameRate;
        const need = P.popSpeed * (b.kind === KIND.GIANT ? 1.3 : 1);
        this.contacts.push(speed);
        if (this.contacts.length > 500) this.contacts.shift();
        if (pr.fresh >= minArea && speed >= need && t >= b.graceUntil) {
          this.pop(b, pr.slot, world);
          continue;
        }
        const frac = pr.covered / (Math.PI * b.r * b.r);
        let len = Math.hypot(pr.dx, pr.dy);
        const nx = len > 1e-4 ? pr.dx / len : 0;
        const ny = len > 1e-4 ? pr.dy / len : 1;
        len = frac * b.r * 0.35; // out of the body, a part of the overlap per frame
        b.x += nx * len;
        b.y += ny * len;
        b.vx += nx * P.push * frac;
        b.vy += ny * P.push * frac;
      }
    }
    // the mouse (for testing): a fast drag pops
    const m = world.pointer;
    if (m?.down && Math.hypot(m.vx, m.vy) > 0.8) {
      for (const b of B.slice()) if (Math.hypot(b.x - m.x, b.y - m.y) < b.r) this.pop(b, 0, world, 'mouse');
    }

    // chains of the stars
    for (let i = this.chain.length - 1; i >= 0; i--) {
      const c = this.chain[i];
      if (t < c.at) continue;
      this.chain.splice(i, 1);
      this.pop(c.bubble, c.slot, world, 'chain');
    }

    // gone: out at the top, too old
    for (const b of B.slice()) {
      if (b.y - b.r > world.top) {
        B.splice(B.indexOf(b), 1);
        this.stats.escaped++;
      } else if (t - b.born > b.life) {
        this.pop(b, 0, world, 'age');
      }
    }
    // nobody there: now and then a bubble pops by itself, to show what happens
    if (!people.length && t > this.demoAt && B.length) {
      this.demoAt = t + rand(4, 7);
      const b = B[Math.floor(Math.random() * B.length)];
      if (b.y > world.bottom + 0.3) this.pop(b, 0, world, 'demo');
    }

    // effects
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      if (t - f.t0 > f.life) {
        this.fx.splice(i, 1);
        continue;
      }
      if (f.gravity) {
        f.vy -= 3 * dt;
        f.vx *= 1 - dt * 1.5;
      }
      if (f.vx) f.x += f.vx * dt;
      if (f.vy) f.y += f.vy * dt;
    }
  }
}
