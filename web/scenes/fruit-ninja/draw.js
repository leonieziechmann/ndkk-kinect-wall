// Drawing the game into the pixel layer (pix.js) and collecting the lights for the renderer.
// Order: what moves in the scenery (stars, clouds, lanterns), juice on the wall, the ninjas (headband
// tails and sword hilt behind them), cherry petals, fruit halves, whole fruits, juice and sparks,
// rings, numbers and crowns, the round bar. The blades and cuts are smooth strokes (strokes.js). The still scenery is a texture of its
// own (scenery.js, render.js). Wall meters -> art px: x * ppm, (top - y) * ppm.

import { KINDS, skin, flesh, FACE } from './fruits.js';
import { CROWN, WHITE, rgb } from './pix.js';
import { PART, SHADE } from './ninja.js';
import { RES } from './people.js';
import { ember } from './game.js';

const UNIT = 0.5; // fruit blocks: half an art pixel (2 x 2 LEDs)
const GOLD = [1, 0.8, 0.15];
const JEWEL = [1, 0.2, 0.45];
const tmpCol = [0, 0, 0];
const mix = (a, b, k, out) => {
  for (let i = 0; i < 3; i++) out[i] = a[i] + (b[i] - a[i]) * k;
  return out;
};
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

// Fruits turn in steps (like the figures in space-invaders): every kind, size, step and cut is
// computed once into a grid of block colors and kept, so a frame only copies blocks.
const STEPS = 32;
const sprites = new Map();
const step = (a) => ((Math.round((a / (Math.PI * 2)) * STEPS) % STEPS) + STEPS) % STEPS;

/** the blocks of a fruit: { n, cols } with cols[(j + n) * 2n + (i + n)] a color or null */
function sprite(kind, R, rotQ, half, naQ, side, phase, t) {
  const key = `${kind}|${R.toFixed(2)}|${rotQ}|${half ? `${naQ}|${side}` : '-'}|${phase}`;
  let sp = sprites.get(key);
  if (sp) return sp;
  if (sprites.size > 4000) sprites.clear();
  const n = Math.ceil((R * 1.4) / UNIT);
  const rot = (rotQ / STEPS) * Math.PI * 2;
  const c = Math.cos(-rot);
  const s = Math.sin(-rot);
  const na = (naQ / STEPS) * Math.PI * 2;
  const nx = Math.cos(na);
  const ny = Math.sin(na);
  const cols = new Array(4 * n * n).fill(null);
  for (let j = -n; j < n; j++) {
    const sy = -((j + 0.5) * UNIT) / R;
    for (let i = -n; i < n; i++) {
      const sx = ((i + 0.5) * UNIT) / R;
      if (sx * sx + sy * sy > 2) continue;
      const lx = sx * c - sy * s;
      const ly = sx * s + sy * c;
      let col;
      if (half) {
        const d = (lx * nx + ly * ny) * side;
        const tg = -lx * ny + ly * nx;
        const v = d / FACE;
        if (tg * tg + v * v <= 1) col = flesh(kind, tg, v * side);
        else if (d >= 0) col = skin(kind, lx, ly, sx, sy, t);
        else continue;
      } else col = skin(kind, lx, ly, sx, sy, t);
      cols[(j + n) * 2 * n + (i + n)] = col ?? null;
    }
  }
  sp = { n, cols };
  sprites.set(key, sp);
  return sp;
}

/** a fruit (whole, or a half with f.na / f.side) */
function drawFruit(pix, L, f, t, half) {
  const ppm = L.ppm;
  const R = f.r * ppm;
  const cx = f.x * ppm;
  const cy = (L.top - f.y) * ppm;
  // what changes with time: the bomb's band pulses, the frost fruit sparkles
  const phase = f.kind === 'bomb' ? (Math.sin(t * 9) > -0.2 ? 1 : 0) : f.kind === 'frost' ? Math.floor(t * 6) % 4 : 0;
  const tq = f.kind === 'frost' ? phase / 6 : f.kind === 'bomb' ? (phase ? 0 : (1.5 * Math.PI) / 9) : 0;
  const sp = sprite(f.kind, R, step(f.rot), half, half ? step(f.na) : 0, half ? f.side : 0, phase, tq);
  const { n, cols } = sp;
  const w = 2 * n;
  for (let j = 0; j < w; j++) {
    const y = cy + (j - n) * UNIT;
    for (let i = 0; i < w; i++) {
      const col = cols[j * w + i];
      if (col) pix.put(cx + (i - n) * UNIT, y, col, 1, UNIT);
    }
  }
}

// ---- the ninja costume: [base, lit, dark] per piece (moonlight from the top left, cool shadows)
const COSTUME = {
  [PART.SUIT]: ['#181d36', '#2a3358', '#0e1122'].map(rgb),
  [PART.PANTS]: ['#151a30', '#252d50', '#0c0f1e'].map(rgb),
  [PART.HOOD]: ['#161b32', '#2b3459', '#0d1021'].map(rgb),
  [PART.SKIN]: ['#e8b898', '#f8d4b8', '#c8907e'].map(rgb),
  [PART.COLLAR]: ['#2e375c', '#46517e', '#1e2442'].map(rgb),
  [PART.PLATE]: ['#4a5684', '#8a98c8', '#2c3458'].map(rgb),
  [PART.WRAP]: ['#3e4b76', '#56659a', '#29325a'].map(rgb),
  [PART.WRAP2]: ['#2b3558', '#3d4a76', '#1d2442'].map(rgb),
  [PART.FOOT]: ['#0c0f1c', '#1a1f36', '#07080f'].map(rgb),
};
const GRIP = rgb('#24243c');
const GUARD = rgb('#e0b030');
const POMMEL = rgb('#a0aad0');

/**
 * The tones of a piece of the costume of a player of color col: [base, lit, dark, rim (the outline
 * towards the light, in the player's color), shaded outline]
 */
function ninjaTones(col, pt, P) {
  let tri;
  if (pt === PART.BAND || pt === PART.BELT) {
    const c = pt === PART.BELT ? scale(col, 0.8) : col;
    tri = [c, mix(c, WHITE, 0.3, [0, 0, 0]), scale(c, 0.62)];
  } else if (pt === PART.EYE) {
    const c = mix(col, WHITE, 0.45, [0, 0, 0]); // the eyes glow in the player's color
    tri = [c, c, c];
  } else tri = COSTUME[pt] ?? COSTUME[PART.SUIT];
  const rim = pt === PART.BAND || pt === PART.BELT || pt === PART.EYE ? mix(tri[0], WHITE, 0.35, [0, 0, 0]) : mix(tri[1], col, P.bodyEdge, [0, 0, 0]);
  return [tri[0], tri[1], tri[2], rim, mix(tri[2], col, 0.2, [0, 0, 0])];
}

/** the gear behind a ninja: the two tails of the headband (they flutter against the motion), the sword hilt */
function drawGear(pix, L, q, real, P) {
  const sk = q.sk;
  const ppm = L.ppm;
  const h = sk.head;
  if (h) {
    const [vx, vy] = q.hv ?? [0, 0];
    const sp = Math.hypot(vx, vy);
    // the knot sits at the back; seen from the front the tails come out on one side and trail behind
    const side = sp > 0.25 ? -Math.sign(vx || 1) : q.headX < L.wallW / 2 ? 1 : -1;
    const k = Math.min(1, sp / 1.5);
    let dx = side * 0.8 - vx * 0.5;
    let dy = -0.45 - vy * 0.4 + k * 0.3;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const ox = h[0] + side * 0.075;
    const oy = h[1] + 0.065;
    const col = q.col;
    for (const [len, ph, shade] of [
      [0.26, 0, 1],
      [0.2, 1.7, 0.72],
    ]) {
      const c = scale(col, shade);
      const n = Math.ceil(len / 0.012);
      for (let i = 0; i <= n; i++) {
        const s = (i / n) * len;
        const w = Math.sin(real * (9 + sp * 4) + s * 16 + ph) * 0.022 * (s / len) * (0.6 + k);
        const sag = (1 - k) * 0.14 * (s / len) ** 2;
        const x = ox + dx * s - dy * w;
        const y = oy + dy * s + dx * w - sag;
        // two blocks wide at the knot, one at the end
        const u = i < n * 0.65 ? 1 : 0.5;
        pix.put(x * ppm - u / 2, (L.top - y) * ppm - u / 2, c, 1, u);
        if (i < n * 0.4) pix.put((x + dy * 0.02) * ppm - u / 2, (L.top - (y - dx * 0.02)) * ppm - u / 2, c, 1, u);
      }
    }
  }
  // the hilt of the sword on the back, over the shoulder on the other side
  const sh = sk.leftShoulder && sk.rightShoulder ? (sk.leftShoulder[0] < sk.rightShoulder[0] ? sk.rightShoulder : sk.leftShoulder) : null;
  if (sh && sk.neck && P.sword) {
    const out = Math.sign(sh[0] - sk.neck[0]) || 1;
    const dx = out * 0.42;
    const dy = 0.91;
    const x0 = sh[0] - out * 0.03;
    const y0 = sh[1] - 0.02;
    for (let s = 0; s <= 0.27; s += 0.012) {
      const x = x0 + dx * s;
      const y = y0 + dy * s;
      let c = GRIP;
      let u = 1;
      if (s > 0.25) c = POMMEL;
      else if (Math.abs(s - 0.09) < 0.012) {
        // the guard: across the blade
        for (const o of [-0.03, -0.015, 0.015, 0.03]) pix.put((x - dy * o) * ppm - 0.25, (L.top - (y + dx * o)) * ppm - 0.25, GUARD, 1, 0.5);
        c = GUARD;
      } else if (s > 0.1 && Math.floor(s / 0.024) % 2 === 0) c = scale(q.col, 0.85);
      else if (s < 0.09) u = 0.5;
      pix.put(x * ppm - u / 2, (L.top - y) * ppm - u / 2, c, 1, u);
    }
  }
}

/** wall m -> art px */
const ax = (L, x) => x * L.ppm;
const ay = (L, y) => (L.top - y) * L.ppm;

export function drawArt(S) {
  const { pix, L, game, people, P } = S;
  const t = game.time;
  const real = game.real;
  const ppm = L.ppm;
  pix.clear();

  // ---- the scenery: stars, clouds, a shooting star, the lanterns
  S.scenery.draw(pix);

  // ---- juice on the wall
  for (const sp of game.splats) {
    const u = (real - sp.t0) / sp.life;
    const col = scale(sp.col, P.splat);
    const cx = ax(L, sp.x);
    const cy = ay(L, sp.y);
    for (const b of sp.blocks) {
      if (u > b[3]) continue;
      if (b[4] !== undefined && b[4] > u * 4) continue; // a run grows down over the first quarter
      pix.put(cx + b[0] * ppm - b[2] / 2, cy - b[1] * ppm - b[2] / 2, col, 1, b[2]);
    }
  }

  // ---- the ninjas: what is behind them first (headband tails, sword hilt), then the costume
  for (const q of people.list) if (q.sk && people.shown(q.slot)) drawGear(pix, L, q, real, P);
  const cell = people.cell;
  if (cell && people.any && people.box) {
    const AW = people.AW;
    const AH = people.AH;
    const part = people.part;
    const shade = people.shade;
    const tones = new Map();
    const u = 1 / RES; // a cell in art px
    const [x0, y0, x1, y1] = people.box;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const c = y * AW + x;
        const s = cell[c];
        if (!s) continue;
        const pt = part[c] || PART.SUIT;
        const key = s * 16 + pt;
        let tn = tones.get(key);
        if (!tn) {
          tn = ninjaTones(S.colorOf(s), pt, P);
          const hit = game.hurt.get(s);
          if (hit !== undefined) {
            const k = Math.max(0, 1 - (real - hit) / 0.8);
            const flash = Math.sin(real * 40) > 0 ? [1, 1, 1] : [1, 0.15, 0.25];
            tn = tn.map((col) => mix(col, flash, k, [0, 0, 0]));
          }
          tones.set(key, tn);
        }
        // light from the top left: a rim in the player's color there, darker at the bottom right;
        // inside, the shade of the limb (lit, base, dark)
        const up = y > 0 ? cell[c - AW] : 0;
        const left = x > 0 ? cell[c - 1] : 0;
        const down = y < AH - 1 ? cell[c + AW] : 0;
        const right = x < AW - 1 ? cell[c + 1] : 0;
        const sh = shade[c];
        const tone = up !== s || left !== s ? tn[3] : down !== s || right !== s ? tn[4] : sh === SHADE.LIT ? tn[1] : sh === SHADE.DARK ? tn[2] : tn[0];
        pix.put(x * u, y * u, tone, 1, u);
      }
    }
  }

  // ---- cherry petals, in front of the people
  S.scenery.drawPetals(pix);

  // ---- fruit
  for (const h of game.halves) drawFruit(pix, L, h, t, true);
  for (const f of game.fruits) {
    const K = KINDS[f.kind];
    if (K.aura) {
      // specials and bombs glow: a pulsing ring around them
      const pulse = 0.5 + 0.5 * Math.sin(real * (f.kind === 'bomb' ? 10 : 5) + f.id);
      pix.ring(ax(L, f.x), ay(L, f.y), f.r * ppm * (1.22 + 0.08 * pulse), 0.9, K.aura, 0.35 + 0.4 * pulse, UNIT);
    }
    drawFruit(pix, L, f, t, false);
    if (f.kind === 'bomb') {
      // the spark at the end of the fuse
      const cr = Math.cos(f.rot);
      const sr = Math.sin(f.rot);
      const lx = 0.22;
      const ly = 1.34;
      const fx = f.x + f.r * (lx * cr - ly * sr);
      const fy = f.y + f.r * (lx * sr + ly * cr);
      const flick = Math.random();
      pix.put(ax(L, fx) - 0.5, ay(L, fy) - 0.5, flick > 0.5 ? WHITE : [1, 0.7, 0.2], 1, 1);
      for (let k = 0; k < 3; k++) {
        const a = Math.random() * 6.28;
        const d = 0.6 + Math.random() * 1.2;
        pix.put(ax(L, fx) + Math.cos(a) * d - 0.25, ay(L, fy) + Math.sin(a) * d - 0.25, Math.random() > 0.5 ? [1, 0.85, 0.3] : [1, 0.35, 0.1], 1, UNIT);
      }
    }
  }

  // ---- juice drops and sparks
  for (const d of game.drops) {
    const u = (t - d.t0) / d.life;
    const col = d.ember ? ember(u, tmpCol) : d.col;
    const sz = d.size * (u > 0.7 ? 0.5 / d.size : 1);
    pix.put(ax(L, d.x) - sz / 2, ay(L, d.y) - sz / 2, col, 1, sz);
  }

  // ---- rings
  for (const r of game.rings) {
    const u = (real - r.t0) / r.life;
    const rad = r.r0 + (r.r1 - r.r0) * (1 - (1 - u) ** 3);
    // stays bright and gets thinner: a dim orange or magenta ring would look brown
    pix.ring(ax(L, r.x), ay(L, r.y), rad * ppm, Math.max(UNIT, r.w * ppm * (1 - 0.8 * u)), r.col, u < 0.75 ? 1 : (1 - u) / 0.25, UNIT);
  }

  // (the blades, the woosh and the cuts are smooth strokes on the GPU: strokes.js)

  // ---- everyone's points beside the head (the wall is only 2 m high: no room above tall people),
  // the crown on the head of the best of the last round
  const end = game.phase === 'end';
  if (game.phase === 'play' || end || game.phase === 'ready') {
    for (const q of people.list) {
      if (!people.shown(q.slot)) continue;
      const pts = game.scores.get(q.id)?.pts ?? 0;
      const h = end ? 9 : 5;
      const hx = ax(L, q.headX);
      const hy = ay(L, q.headY);
      const str = String(pts);
      const tw = (str.length * 4 - 1) * (h / 5);
      // on the side towards the middle of the wall, where there is room
      const side = q.headX < L.wallW / 2 ? 1 : -1;
      const tx = hx + side * (0.2 * ppm + tw / 2);
      const ty = Math.max(h / 2 + 1, Math.min(pix.h - h / 2 - 1, hy));
      if (pts > 0 || end) pix.text(str, tx, ty, h, q.col, 1);
      if (game.crown === q.id && P.crown) {
        const bob = end ? Math.abs(Math.sin(real * 5)) * 1.2 : 0;
        const rows = CROWN;
        const cw = rows[0].length;
        const top = Math.max(rows.length * UNIT, ay(L, q.headY + 0.1) - bob);
        for (let j = 0; j < rows.length; j++) for (let i = 0; i < cw; i++) if (rows[j][i] !== '.') pix.put(hx - (cw * UNIT) / 2 + i * UNIT, top - rows.length * UNIT + j * UNIT, rows[j][i] === 'j' ? JEWEL : GOLD, 1, UNIT);
      }
    }
  }
  for (const p of game.pops) {
    const u = (real - p.t0) / p.life;
    pix.text(p.text, ax(L, p.x), ay(L, p.y + (p.vy ?? 0) * u), p.h * (u < 0.15 ? 0.6 + u * 2.7 : 1), p.col, u < 0.7 ? 1 : (1 - u) / 0.3);
  }

  // ---- the round: a bar along the top edge, it fills before the round and empties during it
  if (P.roundTime > 0 && (game.phase === 'ready' || game.phase === 'play')) {
    const k = game.phase === 'ready' ? Math.min(1, game.phaseT / 1.8) : Math.max(0, game.roundLeft / game.roundTime);
    const finale = game.phase === 'play' && game.roundLeft < P.finale;
    const col = finale ? (Math.sin(real * 12) > 0 ? [1, 0.2, 0.6] : [1, 0.6, 0.9]) : [0.35, 0.85, 1];
    const half = (pix.w / 2) * k;
    for (let x = Math.floor(pix.w / 2 - half); x < pix.w / 2 + half; x++) pix.put(x, 0, col, 0.85, 1);
  }
}

/** the lights on the wall behind everything: [x, y (art px), r (m), intensity, r, g, b, 0] */
export function collectLights(S, out) {
  const { L, game, people, fx, P } = S;
  let n = 0;
  const max = out.length / 8;
  const add = (x, y, r, i, col) => {
    if (n >= max || !(i > 0.01)) return;
    out.set([ax(L, x), ay(L, y), r, i * P.lights, col[0], col[1], col[2], 0], n * 8);
    n++;
  };
  for (const l of fx.lights) {
    const u = (fx.time - l.t0) / l.life;
    add(l.x, l.y, l.r * (0.7 + 0.3 * u), l.i * (1 - u) ** 2, l.col);
  }
  for (const f of game.fruits) {
    const K = KINDS[f.kind];
    if (K.aura) add(f.x, f.y, f.kind === 'bomb' ? 0.55 : 0.7, f.kind === 'bomb' ? 0.5 + 0.3 * Math.sin(game.real * 10) : 0.6, K.aura);
  }
  for (const b of people.blades.values()) {
    if (!b.cutting || b.x === null) continue;
    add(b.x, b.y, 0.4, 0.5, b.col);
  }
  S.scenery.lights(add, L);
  return n;
}
