// Pixel Jump'n'Run for the LED wall (6 m x 2 m, 1008 x 336 LEDs). The wall is a coarse LED mosaic
// (cells of a few cm with dark joints) and the people in front of it are pixel figures in it: their
// real silhouette, every person in their own outfit (hair, skin, shirt, pants, shoes from the
// skeleton). Obstacles roll in along the ground and must be jumped over, others fly in at head height
// and must be ducked under; coins hang in the air, a rare star makes you invincible. Any number of
// people play at once, each at their own place on the wall (the wall core maps them: mirrored, the
// walk stretched over the whole wall). No text, no rules: you find out by trying.
//
// people.js: masks -> pixel figures, jump detection. game.js: obstacles, collisions, points.
// art.js: sprites, outfits, digits. sound.js: 8-bit sounds. Drawn with Canvas 2D: the mosaic at
// cell resolution, scaled up without smoothing, the LED raster laid over it, a soft glow on top.

import { DEFAULT_DELAY } from '/lib/persons.js';
import { Cells, SPRITES, PART, hash2, mix, scale, rainbow, textWidth } from './art.js';
import { PeopleLayer } from './people.js';
import { Game, flipOf, GOAL_W } from './game.js';
import { Sound } from './sound.js';

const STATES = new WeakMap(); // per ctx: the output window may run this scene twice at once
const WHITE = [255, 255, 255];
const RED = [255, 45, 85];
const GOLD = [255, 210, 63];

/** the mosaic on the LED image */
function makeLayout(ctx, p) {
  const wall = ctx.wall;
  const s = wall.setup;
  const W = ctx.width;
  const H = ctx.height;
  const [pxX, pxY] = wall.pxPerM;
  const cellPx = Math.max(4, Math.round((p.cellCm / 100) * pxX));
  const GW = Math.max(16, Math.floor(W / cellPx));
  const GH = Math.max(8, Math.floor(H / cellPx));
  const groundRows = Math.max(1, Math.min(4, Math.round(p.groundRows)));
  return {
    W,
    H,
    pxX,
    pxY,
    cellPx,
    GW,
    GH,
    ox: Math.floor((W - GW * cellPx) / 2),
    oy: Math.floor((H - GH * cellPx) / 2),
    cellMx: cellPx / pxX,
    cellMy: cellPx / pxY,
    groundRow: GH - groundRows,
    wallW: s.size.w,
    key: [W, H, cellPx, GW, GH, groundRows].join(),
  };
}

/** the static part of the background: a dark violet LED field with a little noise, the stars */
function makeBackground(L) {
  const { GW, GH } = L;
  const base = new Float32Array(GW * GH * 3);
  const stars = [];
  for (let y = 0; y < GH; y++) {
    const v = y / Math.max(1, GH - 1);
    const top = [10, 5, 26];
    const bot = [34, 14, 58];
    const c = mix(top, bot, v);
    for (let x = 0; x < GW; x++) {
      const n = 0.82 + 0.36 * hash2(x, y);
      const o = (y * GW + x) * 3;
      base[o] = c[0] * n;
      base[o + 1] = c[1] * n;
      base[o + 2] = c[2] * n;
      if (y < GH * 0.6 && hash2(x + 911, y + 37) < 0.022) stars.push([x, y, hash2(x, y + 5) * 6.28, 0.8 + hash2(y, x) * 2.5]);
    }
  }
  return { base, stars };
}

/** a skyline far away: buildings with a few lit windows */
function skyline(i) {
  const b = Math.floor(i / 6);
  if (((i % 6) + 6) % 6 === 5) return { h: 0, b };
  return { h: 3 + Math.floor(hash2(b, 77) * 8), b };
}

function hills(i) {
  return Math.max(1, Math.round(2.6 + 1.6 * Math.sin(i * 0.11) + 1.1 * Math.sin(i * 0.29 + 1.3)));
}

function drawWorld(S, p, t) {
  const { cells, game, layout: L, bg } = S;
  const { GW, GH, groundRow } = L;
  const d = cells.data;
  const k = p.bgLevel;
  const base = bg.base;
  for (let c = 0, o = 0; c < GW * GH; c++, o += 4) {
    d[o] = base[c * 3] * k;
    d[o + 1] = base[c * 3 + 1] * k;
    d[o + 2] = base[c * 3 + 2] * k;
    d[o + 3] = 255;
  }
  for (const [x, y, ph, rate] of bg.stars) {
    const a = 0.18 + 0.22 * Math.sin(t * rate + ph);
    cells.add(x, y, [150, 190, 255], a * k);
  }
  // a crescent moon
  const mx = Math.round(GW * 0.62);
  const my = Math.round(GH * 0.17);
  for (let y = -3; y <= 3; y++) {
    for (let x = -3; x <= 3; x++) {
      if (x * x + y * y > 10 || (x - 1.6) ** 2 + (y + 0.8) ** 2 < 6.5) continue;
      cells.put(mx + x, my + y, scale([215, 190, 255], 0.55 * k));
    }
  }
  // far skyline and near hills, scrolling slower than the ground
  const dir = game.dir;
  const off1 = Math.floor((game.dist * 0.15) / L.cellMx) * dir;
  const off2 = Math.floor((game.dist * 0.4) / L.cellMx) * dir;
  for (let x = 0; x < GW; x++) {
    const s = skyline(x + off1);
    for (let j = 0; j < s.h; j++) {
      const y = groundRow - 1 - j;
      const lit = j > 0 && j < s.h - 1 && (x + off1) % 2 === 0 && j % 2 === 1 && hash2(s.b * 13 + j, (x + off1) * 3) < 0.35;
      cells.put(x, y, scale(lit ? [120, 90, 200] : [36, 18, 74], k));
    }
    const h = hills(x + off2);
    for (let j = 0; j < h; j++) cells.put(x, groundRow - 1 - j, scale(j === h - 1 ? [44, 40, 120] : [24, 22, 80], k));
  }
  // the ground: a bright edge and bricks, scrolling with the game
  const off = Math.floor(game.dist / L.cellMx) * dir;
  for (let y = groundRow; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const i = x + off;
      let col;
      if (y === groundRow) col = ((i % 4) + 4) % 4 === 0 ? [190, 140, 255] : [130, 80, 255];
      else {
        const row = y - groundRow;
        const mortar = (((i + (row % 2) * 2) % 4) + 4) % 4 === 0;
        col = mortar ? [30, 12, 60] : row % 2 ? [74, 34, 150] : [62, 28, 128];
      }
      cells.put(x, y, scale(col, k));
    }
  }
}

function partColor(o, part) {
  switch (part) {
    case PART.HAIR:
      return o.hair;
    case PART.SKIN:
      return o.skin;
    case PART.PANTS:
      return o.pants;
    case PART.SHOES:
      return o.shoes;
    case PART.SLEEVE:
      return o.shirt;
    default:
      return o.shirt;
  }
}

// someone too far away to play: a violet silhouette (dimmed outfit colors would turn olive/brown)
const BACK_LUM = { [PART.HAIR]: 0.55, [PART.SKIN]: 0.95, [PART.SHIRT]: 0.8, [PART.SLEEVE]: 0.8, [PART.PANTS]: 0.6, [PART.SHOES]: 0.5 };

function drawBackFigure(S, f, p) {
  const { cells, layout: L } = S;
  const { GW } = L;
  const g = f.grid;
  const [c0, r0, c1, r1] = f.bbox;
  for (let y = r0; y <= r1; y++) {
    for (let x = c0; x <= c1; x++) {
      const part = g[y * GW + x];
      if (!part) continue;
      const lum = (BACK_LUM[part] ?? 0.8) * (0.9 + 0.16 * hash2(x * 3 + f.slot, y * 7));
      cells.put(x, y, scale([150, 120, 255], p.bgPeople * lum));
    }
  }
}

function drawFigure(S, f, p, t, liftRows, ghost) {
  const { cells, layout: L } = S;
  const { GW, GH } = L;
  const g = f.grid;
  const [c0, r0, c1, r1] = f.bbox;
  if (c1 < c0) return;
  const o = f.outfit;
  const age = t - f.born;
  const star = t < f.starUntil && (f.starUntil - t > 1.5 || Math.floor(t * 10) % 2 === 0);
  const flash = t - f.hitAt < 0.1;
  const hurt = !flash && t < f.safeUntil;
  if (hurt && !ghost && Math.floor(t * 14) % 2 === 0) return; // flickers after a hit
  const reveal = age < 0.45 ? r1 - (r1 - r0 + 1) * (age / 0.45) : -1; // appears from the feet up
  for (let y = r0; y <= r1; y++) {
    if (y < reveal) continue;
    const yy = y - liftRows;
    if (yy < 0 || yy >= GH) continue;
    for (let x = c0; x <= c1; x++) {
      const part = g[y * GW + x];
      if (!part) continue;
      if (ghost) {
        cells.put(x, yy, scale(o.shirt, ghost), 0.9);
        continue;
      }
      let col = partColor(o, part);
      // pixel-art light from above: a bright top edge, a darker bottom edge, a little grain
      const above = y > 0 && g[(y - 1) * GW + x];
      const below = y < GH - 1 && g[(y + 1) * GW + x];
      let lum = 0.9 + 0.16 * hash2(x * 3 + f.slot, y * 7);
      if (!above) lum *= 1.15;
      else if (!below && part !== PART.SHOES) lum *= 0.8;
      col = scale(col, lum);
      if (star) col = mix(col, rainbow(t * 1.6 - y * 0.06 + x * 0.02), 0.75);
      if (flash) col = WHITE;
      else if (hurt) col = mix(col, RED, 0.45);
      if (age < 0.6) col = mix(WHITE, col, Math.min(1, age / 0.6));
      cells.put(x, yy, col);
    }
  }
}

/** a ghost (no lives left): the person's silhouette, pale and see-through, floating and bobbing */
function drawGhost(S, f, t) {
  const { cells, layout: L } = S;
  const { GW, GH } = L;
  const g = f.grid;
  const [c0, r0, c1, r1] = f.bbox;
  if (c1 < c0) return;
  const ph = (typeof f.id === 'number' ? f.id : f.slot) * 1.7;
  const up = Math.round((0.22 + 0.08 * Math.sin(t * 2.2 + ph)) / L.cellMy) + f.liftRows;
  const dx = Math.round(Math.sin(t * 1.3 + ph) * 1.2);
  const tail = r1 - Math.round((r1 - r0) * 0.3);
  for (let y = r0; y <= r1; y++) {
    const yy = y - up;
    if (yy < 0 || yy >= GH) continue;
    for (let x = c0; x <= c1; x++) {
      if (!g[y * GW + x]) continue;
      // a wavy, thinning tail at the bottom
      if (y > tail && (x + y + Math.floor(t * 6)) % 2) continue;
      const k = 0.55 + 0.15 * Math.sin(t * 3 + y * 0.4) - (y > tail ? 0.15 : 0);
      cells.put(x + dx, yy, [170, 225, 255], k);
    }
  }
  if (f.headCell) {
    const [hx, hy] = f.headCell;
    for (const ex of [hx - 1, hx + 1]) if (g[(hy + 2) * GW + ex]) cells.put(ex + dx, hy + 2 - up, [20, 10, 50]);
  }
}

/** hearts (lives) and the crown of last round's best above a figure */
function drawBadges(S, f, p, t, crown) {
  const { cells, game } = S;
  if (!f.headCell) return;
  const [b0, , b1] = f.bbox;
  const cx = Math.round((b0 + b1) / 2);
  let y = f.headCell[1] - f.liftRows - 4;
  if (f.alive && (game.phase === 'run' || game.phase === 'count') && f.round === game.round) {
    const heart = SPRITES.heart[0];
    for (let i = 0; i < p.lives; i++) {
      const lost = i >= f.lives;
      const justLost = lost && i === f.lives && t - f.hitAt < 0.8;
      if (justLost && Math.floor(t * 12) % 2) continue;
      const col = justLost ? WHITE : lost ? [60, 22, 80] : null;
      cells.sprite(heart, cx - (p.lives * 4 - 1) / 2 + i * 4, y, col ? { tint: col } : {});
    }
    y -= 4;
  }
  if (crown) {
    const cr = SPRITES.crown[0];
    cells.sprite(cr, cx - 2, y - 1 + Math.round(Math.sin(t * 5) * 0.45));
  }
}

function drawScene(S, figs, back, p, t) {
  const { cells, game, layout: L } = S;
  const { GW, groundRow } = L;
  drawWorld(S, p, t);
  if (p.bgPeople > 0) for (const f of back) drawBackFigure(S, f, p);

  // shadows of figures in the air on the ground edge
  for (const f of figs) {
    if (f.liftRows <= 0 || f.alive === false) continue;
    const [c0, , c1] = f.bbox;
    const shrink = Math.min(2, Math.floor(f.liftRows / 4));
    for (let x = c0 + shrink; x <= c1 - shrink; x++) cells.put(x, groundRow, [40, 20, 90]);
  }

  // the ghosts behind, the living in front; obstacles and items over them (they hit you)
  for (const f of figs) if (f.alive === false) drawGhost(S, f, t);
  for (const f of figs) {
    if (f.alive === false) continue;
    const h = f.liftHist;
    if (h && f.liftRows > 1) {
      drawFigure(S, f, p, t, h[h.length - 6] ?? 0, 0.16);
      drawFigure(S, f, p, t, h[h.length - 3] ?? 0, 0.28);
    }
    drawFigure(S, f, p, t, f.liftRows, 0);
  }

  // obstacles, coins, the star; warnings at the edge where something is about to come in
  for (const th of game.things) {
    const fr = th.frame;
    if (!fr) continue;
    const flip = flipOf(game, th);
    const visible = th.c0 + fr.w > 0 && th.c0 < GW;
    if (visible) {
      if (th.kind === 'star') cells.sprite(fr, th.c0, th.r0, { tint: rainbow(t * 2), tintK: 0.85 });
      else cells.sprite(fr, th.c0, th.r0, { flip });
    } else if (th.kind === 'obstacle' && Math.floor(t * 7) % 2 === 0) {
      const ex = game.dir > 0 ? GW - 1 : 0;
      const step = game.dir > 0 ? -1 : 1;
      const mid = th.r0 + Math.floor(fr.h / 2);
      // a chevron pointing into the wall
      cells.put(ex, mid - 1, RED);
      cells.put(ex, mid + 1, RED);
      cells.put(ex + step, mid, RED);
    }
  }

  // the goal: a checkered gate with a flag
  if (game.goal) {
    const gc = game.col(L, game.goal.x);
    for (let y = 4; y < groundRow; y++) {
      for (let i = 0; i < GOAL_W; i++) cells.put(gc + i, y, (Math.floor(y / 1) + i) % 2 ? [255, 63, 208] : [240, 240, 255]);
    }
    const fl = SPRITES.flag[0];
    cells.sprite(fl, game.dir > 0 ? gc : gc + GOAL_W - 1 - fl.w + 1, 0, { flip: game.dir < 0 });
  }

  // particles keep their color and blink out (fading yellow or red on violet looks brownish)
  for (const q of game.particles) {
    const u = (t - q.t0) / q.life;
    if (u > 0.55 && Math.floor((t - q.t0) * 24) % 2) continue;
    cells.put(q.x, q.y, q.col);
  }
  if (p.debug) drawSkeletons(S, figs);

  // lives and crowns; at the end of a round everybody's points, the crown drops onto the best
  const ended = game.phase === 'end';
  const et = t - game.phaseAt;
  for (const f of figs) {
    const crowned = game.crowns.has(f.id) && (!ended || et > 1.2);
    drawBadges(S, f, p, t, crowned);
    if (!ended || !p.numbers || !f.headCell) continue;
    const r = game.results.find((q) => q.id === f.id);
    if (!r) continue;
    const str = String(r.score);
    const [b0, , b1] = f.bbox;
    const x = Math.round((b0 + b1) / 2 - textWidth(str) / 2);
    let y = f.headCell[1] - (f.alive === false ? Math.round(0.25 / L.cellMy) : f.liftRows) - 7;
    y = Math.max(0, y);
    const col = r.best ? (Math.floor(t * 6) % 2 ? GOLD : WHITE) : f.outfit.shirt;
    cells.text(str, x, y, col);
    if (r.best && et <= 1.2) {
      // the crown falls from the sky onto the winner
      const cr = SPRITES.crown[0];
      const u = Math.min(1, et / 1.2);
      const ty = f.headCell[1] - f.liftRows - 5;
      cells.sprite(cr, Math.round((b0 + b1) / 2) - 2, Math.round(-3 + (ty + 3) * (1 - (1 - u) ** 3)));
    }
  }

  // the round: countdown, GO, the way to the goal along the top
  if (game.phase === 'count') {
    const pt = t - game.phaseAt;
    const n = Math.max(1, Math.ceil(3 - pt));
    const cols = [null, [255, 210, 63], [255, 122, 26], [255, 45, 85]];
    const fresh = pt - Math.floor(pt) < 0.15;
    const str = String(n);
    cells.text(str, Math.round(GW / 2 - textWidth(str, 2) / 2), 1, fresh ? WHITE : cols[n], 1, 2);
  } else if (game.phase === 'run') {
    if (game.roundT < 0.9 && Math.floor(game.roundT * 8) % 2 === 0) cells.text('GO!', Math.round(GW / 2 - textWidth('GO!', 2) / 2), 2, [41, 230, 255], 1, 2);
    const x0 = 6;
    const x1 = GW - 7;
    const u = Math.min(1, game.roundT / Math.max(1, p.roundSecs));
    const head = Math.round(x0 + (x1 - x0) * (game.dir > 0 ? u : 1 - u));
    for (let x = x0; x <= x1; x++) {
      const done = game.dir > 0 ? x <= head : x >= head;
      cells.put(x, 1, done ? [120, 80, 255] : [36, 18, 70]);
    }
    cells.put(head, 1, WHITE);
    cells.put(head, 0, WHITE);
    const fx = game.dir > 0 ? x1 + 1 : x0 - 2;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) cells.put(fx + i, j, (i + j) % 2 ? [255, 63, 208] : [240, 240, 255]);
  }
}

/** test: the bones the body parts come from, as white cells */
function drawSkeletons(S, figs) {
  const { cells, layout: L } = S;
  for (const f of figs) {
    for (const sg of f.segs ?? []) {
      const n = 12;
      for (let i = 0; i <= n; i++) {
        const x = sg[0] + ((sg[2] - sg[0]) * i) / n;
        const y = sg[1] + ((sg[3] - sg[1]) * i) / n;
        const c = Math.floor((x * L.pxX - L.ox) / L.cellPx);
        const r = L.groundRow - 1 - Math.floor(y / L.cellMy) - f.liftRows;
        cells.put(c, r, [255, 255, 255]);
      }
    }
  }
}

/** black with rounded holes where the cells are: the LED raster over the mosaic */
function makeRaster(L, p) {
  const c = document.createElement('canvas');
  c.width = L.W;
  c.height = L.H;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, L.W, L.H);
  g.globalCompositeOperation = 'destination-out';
  const gap = Math.max(1, Math.round(L.cellPx * p.gapFrac));
  const size = L.cellPx - gap;
  const r = Math.min(size / 2, size * p.round);
  g.fillStyle = '#fff';
  g.beginPath();
  for (let y = 0; y < L.GH; y++) {
    for (let x = 0; x < L.GW; x++) {
      const px = L.ox + x * L.cellPx + Math.floor(gap / 2);
      const py = L.oy + y * L.cellPx + Math.floor(gap / 2);
      g.roundRect(px, py, size, size, r);
    }
  }
  g.fill();
  return c;
}

export default {
  wall: true, // the canvas is the LED image; wall size, Kinect, zone and mapping: control center
  streams: ['persons'],
  persons: (p) => ({ mode: 'full', delay: p.live ? 0 : DEFAULT_DELAY }),

  params: {
    live: { value: true, label: 'Live (weniger Verzögerung)', folder: 'Spiel' },
    speed: { value: 1.4, min: 0.5, max: 5, step: 0.05, label: 'Tempo am Anfang (m/s)', folder: 'Spiel' },
    speedMax: { value: 1.6, min: 1, max: 3, step: 0.05, label: 'Tempo steigt in der Runde bis (×)', folder: 'Spiel' },
    density: { value: 1, min: 0.3, max: 3, step: 0.05, label: 'Dichte', folder: 'Spiel' },
    gap: { value: 0.9, min: 0.2, max: 3, step: 0.05, label: 'Reaktionszeit zwischen Hindernissen (s)', folder: 'Spiel' },
    from: { value: 'rechts', options: ['rechts', 'links', 'abwechselnd'], label: 'Hindernisse kommen von (abwechselnd: jede Runde)', folder: 'Spiel' },
    warn: { value: 0.8, min: 0, max: 2, step: 0.05, label: 'Vorwarnung am Rand (s)', folder: 'Spiel' },
    grace: { value: 0.12, min: 0, max: 0.6, step: 0.01, label: 'Gnadenfrist: Treffer zählt erst nach (s)', folder: 'Spiel' },
    latency: { value: 0.2, min: 0, max: 0.6, step: 0.01, label: 'Latenzausgleich (s, + Verzögerung des Trackings)', folder: 'Spiel' },
    hitCells: { value: 3, min: 1, max: 8, step: 1, label: 'Treffer ab (Zellen)', folder: 'Spiel' },
    safeTime: { value: 1.2, min: 0, max: 4, step: 0.1, label: 'Nach Treffer geschützt (s)', folder: 'Spiel' },
    starTime: { value: 6, min: 1, max: 20, step: 0.5, label: 'Stern hält (s)', folder: 'Spiel' },
    lives: { value: 3, min: 1, max: 9, step: 1, label: 'Leben pro Person', folder: 'Runde' },
    roundSecs: { value: 30, min: 10, max: 180, step: 1, label: 'Runde dauert (s, dann kommt das Ziel)', folder: 'Runde' },
    goalBonus: { value: 5, min: 0, max: 30, step: 1, label: 'Punkte fürs Ziel', folder: 'Runde' },
    waitFor: { value: 1.5, min: 0, max: 10, step: 0.5, label: 'Countdown, wenn jemand so lange da ist (s)', folder: 'Runde' },
    endTime: { value: 6, min: 2, max: 20, step: 0.5, label: 'Ergebnis zeigen (s)', folder: 'Runde' },

    jumpHeight: { value: 0.85, min: 0.2, max: 1.4, step: 0.01, label: 'Sprung-Boost: Höhe auf der Wand (m)', folder: 'Springen' },
    jumpTime: { value: 1.3, min: 0.3, max: 2.5, step: 0.01, label: 'Sprung-Boost: Dauer in der Luft (s)', folder: 'Springen' },
    headroom: { value: 0.1, min: 0, max: 1, step: 0.01, label: 'Kopf darf oben aus der Wand (m)', folder: 'Springen' },
    jumpVy: { value: 0.45, min: 0.15, max: 1.5, step: 0.01, label: 'Absprung: Körper (Maske) steigt schneller als (m/s)', folder: 'Springen' },
    jumpVy2: { value: 0.2, min: 0, max: 1.5, step: 0.01, label: 'und der Mittelwert der Maske schneller als (m/s)', folder: 'Springen' },
    jumpRise: { value: 0.05, min: 0.01, max: 0.25, step: 0.005, label: 'und würde so hoch fliegen (m über dem Stand)', folder: 'Springen' },
    jumpDip: { value: 0.1, min: 0, max: 0.4, step: 0.01, label: 'Absprung darf so tief beginnen (m unter dem Stand)', folder: 'Springen' },
    feetUp: { value: 0.02, min: 0, max: 0.15, step: 0.005, label: 'Bestätigt: Füße heben ab um (m)', folder: 'Springen' },
    minRise: { value: 0.06, min: 0, max: 0.3, step: 0.005, label: 'und Körper über dem Stand (m)', folder: 'Springen' },
    pelvisMin: { value: 0.03, min: -0.5, max: 0.3, step: 0.005, label: 'und Becken (Skelett) über dem Stand (m)', folder: 'Springen' },
    walkGate: { value: 0.55, min: 0.1, max: 3, step: 0.05, label: 'kein Sprung beim Gehen schneller als (m/s)', folder: 'Springen' },
    instant: { value: 2, min: 1, max: 4, step: 0.1, label: 'Figur hebt sofort mit (× echter Hub)', folder: 'Springen' },
    jumpRest: { value: 0.15, min: 0, max: 1, step: 0.01, label: 'Mindestabstand zweier Sprünge (s)', folder: 'Springen' },
    jumpLead: { value: 0.08, min: 0, max: 0.3, step: 0.01, label: 'Sprung startet schon ein Stück im Bogen (s)', folder: 'Springen' },

    playNear: { value: 0.8, min: 0.3, max: 6, step: 0.05, label: 'Mitspielen ab (m vom Sensor)', folder: 'Mitspielen' },
    playFar: { value: 3.2, min: 0.5, max: 8, step: 0.05, label: 'Mitspielen bis (m vom Sensor)', folder: 'Mitspielen' },
    bgPeople: { value: 0.4, min: 0, max: 1, step: 0.05, label: 'Leute dahinter: Helligkeit (0 = aus)', folder: 'Mitspielen' },
    bgScale: { value: 0.8, min: 0.4, max: 1, step: 0.05, label: 'Leute dahinter: Größe (×)', folder: 'Mitspielen' },

    figH: { value: 1.1, min: 0.6, max: 1.8, step: 0.01, label: 'Figurhöhe auf der Wand (m)', folder: 'Figuren' },
    sameSize: { value: true, label: 'Alle gleich groß (Kinder wie Erwachsene)', folder: 'Figuren' },
    duckAt: { value: 0.72, min: 0.4, max: 0.95, step: 0.01, label: 'Flieger fliegen ab (× Figurhöhe)', folder: 'Figuren' },
    wide: { value: 1.25, min: 1, max: 2, step: 0.05, label: 'Figuren breiter (×, Pixel-Look)', folder: 'Figuren' },
    fill: { value: 0.22, min: 0.05, max: 0.9, step: 0.01, label: 'Zelle gehört zur Figur ab (Anteil)', folder: 'Figuren' },
    mouse: { value: false, label: 'Maus-Figur (Test: Klick springt, Taste C duckt)', folder: 'Figuren' },
    debug: { value: false, label: 'Skelett zeigen (Test)', folder: 'Figuren' },

    cellCm: { value: 6, min: 3, max: 12, step: 0.5, label: 'Mosaik (cm pro Zelle)', folder: 'Bild' },
    groundRows: { value: 2, min: 1, max: 4, step: 1, label: 'Boden (Zellen)', folder: 'Bild' },
    gapFrac: { value: 0.14, min: 0, max: 0.5, step: 0.01, label: 'Fuge zwischen den Zellen', folder: 'Bild' },
    round: { value: 0.3, min: 0, max: 0.5, step: 0.01, label: 'Ecken rund', folder: 'Bild' },
    glow: { value: 0.35, min: 0, max: 1.5, step: 0.05, label: 'Leuchten', folder: 'Bild' },
    bgLevel: { value: 1, min: 0, max: 2, step: 0.05, label: 'Hintergrund', folder: 'Bild' },
    brightness: { value: 1, min: 0.2, max: 1.5, step: 0.05, label: 'Helligkeit', folder: 'Bild' },
    numbers: { value: true, label: 'Punkte zeigen', folder: 'Bild' },
    sound: { value: true, label: 'Ton', folder: 'Bild' },
    volume: { value: 0.5, min: 0, max: 1, step: 0.01, label: 'Lautstärke', folder: 'Bild' },
  },

  setup(ctx) {
    const g = ctx.canvas.getContext('2d');
    if (!g) throw new Error('Canvas hat schon einen anderen Kontext');
    const sound = new Sound();
    const unlock = () => ctx.params.sound && sound.unlock();
    ctx.on(window, 'pointerdown', unlock);
    ctx.on(window, 'keydown', unlock);
    unlock(); // works right away in a kiosk browser that allows autoplay
    const cellCanvas = document.createElement('canvas');
    const S = {
      g,
      cellCanvas,
      cellG: cellCanvas.getContext('2d'),
      cells: new Cells(16, 8),
      people: new PeopleLayer(),
      game: new Game(),
      sound,
      layout: null,
      key: '',
      rasterKey: '',
      raster: null,
      bg: null,
      fake: [],
      mouseFake: { id: 'mouse', x: 3, h: 1.7, crouch: 0, slot: 2 },
      destroy() {
        sound.stopAll();
      },
    };
    ctx.on(window, 'keydown', (e) => {
      if (e.key === 'c' || e.key === 'C') S.mouseFake.crouch = S.mouseFake.crouch ? 0 : 1;
    });
    ctx.on(ctx.canvas, 'pointerdown', () => {
      if (ctx.params.mouse) S.mouseFake.jump = true;
    });
    ctx.track(S);
    STATES.set(ctx, S);
    // for debugging and tests: fake players { id, x, h, crouch, arms, jump }, the jump signal log
    globalThis.__jumprun = {
      game: S.game,
      people: S.people,
      fake: S.fake,
      params: ctx.params,
      get layout() {
        return S.layout;
      },
    };
  },

  frame(ctx) {
    const S = STATES.get(ctx);
    if (!S) return;
    const p = ctx.params;
    const L = (S.layout = makeLayout(ctx, p));
    if (L.key !== S.key) {
      S.key = L.key;
      S.cells.resize(L.GW, L.GH);
      S.cellCanvas.width = L.GW;
      S.cellCanvas.height = L.GH;
      S.bg = makeBackground(L);
    }
    const rk = `${L.key}|${p.gapFrac}|${p.round}`;
    if (rk !== S.rasterKey) {
      S.rasterKey = rk;
      S.raster = makeRaster(L, p);
    }

    const dt = Math.min(Math.max(ctx.dt, 0.001), 1 / 15);
    const game = S.game;
    const t = game.time + dt;
    const fakes = [...S.fake];
    if (p.mouse && ctx.wall.pointer.inside) {
      S.mouseFake.x = ctx.wall.pointer.x;
      fakes.push(S.mouseFake);
    }
    const all = S.people.update(ctx, L, p, t, fakes, dt);
    const figs = all.filter((f) => f.player);
    const back = all.filter((f) => !f.player);
    for (const f of figs) {
      (f.liftHist ??= []).push(f.liftRows);
      if (f.liftHist.length > 8) f.liftHist.shift();
    }
    // how far the figures lag behind the people: the set compensation plus the tracker's delay
    const lag = Math.min(0.8, p.latency + (ctx.persons?.delayMs ?? 0) / 1000);
    // ready: Kinect frames and the pose model ran once (or test figures)
    const ready = fakes.length > 0 || (Boolean(ctx.kinect.depth) && (ctx.kinect.persons?.poseRuns ?? 0) > 0);
    game.step(dt, figs, L, p, { ready, entered: S.people.entered.filter((f) => f.player), jumped: S.people.jumped, lag });
    if (p.sound) {
      S.sound.setVolume(p.volume);
      for (const e of game.events) S.sound.play(e, L.wallW);
    } else S.sound.stopAll();
    game.events.length = 0;

    drawScene(S, figs, back, p, game.time);
    S.cellG.putImageData(S.cells.img, 0, 0);
    const g = S.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#000';
    g.fillRect(0, 0, L.W, L.H);
    g.imageSmoothingEnabled = false;
    g.filter = p.brightness !== 1 ? `brightness(${p.brightness})` : 'none';
    g.drawImage(S.cellCanvas, L.ox, L.oy, L.GW * L.cellPx, L.GH * L.cellPx);
    g.filter = 'none';
    g.drawImage(S.raster, 0, 0);
    if (p.glow > 0) {
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = Math.min(1, p.glow);
      g.imageSmoothingEnabled = true;
      g.filter = `blur(${Math.round(L.cellPx * 0.8)}px) brightness(${p.brightness * 0.6})`;
      g.drawImage(S.cellCanvas, L.ox, L.oy, L.GW * L.cellPx, L.GH * L.cellPx);
      g.filter = 'none';
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }

    const snd = p.sound && !S.sound.ready ? ' · Ton: einmal klicken' : '';
    const jumps = figs.reduce((n, f) => n + f.jumps, 0);
    const phase = { wait: ready ? 'wartet auf Leute' : 'Tracking lädt', count: 'Countdown', run: `läuft ${Math.floor(game.roundT)} s`, end: 'Ergebnis' }[game.phase];
    const alive = figs.filter((f) => f.alive !== false).length;
    ctx.status = `Runde ${game.round}: ${phase} · ${figs.length} Spieler (${alive} leben)${back.length ? ` +${back.length} dahinter` : ''} · ${game.speed.toFixed(2)} m/s · ${jumps} Sprünge${snd}`;
  },

  dispose(ctx) {
    STATES.get(ctx)?.sound.stopAll();
    STATES.delete(ctx);
  },
};

