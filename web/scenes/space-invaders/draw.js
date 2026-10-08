// The game's pixel layer (art pixels, crisp) and the lights it casts on the floor (render.js).
// Retro sprites, lit like a modern game: everything that glows also lights the map around it.
//
// Everything says "seen from above": the light comes from the top left (bright top-left edges, dark
// bottom-right ones), everything that is up in the air casts a shadow to the bottom right, the
// people are top-down figures (shoulders, head, feet stepping out when they walk) leaving footprints,
// the invaders are creatures seen from above facing the city, the city is a night satellite picture
// (streets with lamps, cars driving, roofs with shadows, parks, a dome).

import { CITY } from './city.js';
import { SPRITES, EYES, SHIP, SHIP_W, SHIP_H, UFO_W, UFO_H, UFO_DOME, ICONS, POWER_COLORS, JUMP_HINT, PERSON_H, PERSON_UNIT, ARM, personTurned, facing, rgb, neon } from './pixels.js';
import { MAX_LIGHTS } from './render.js';

export const WHITE = [1, 1, 1];
const BLACK = [0, 0, 0];
const RED = [1, 0.16, 0.24];
const ORANGE = [1, 0.42, 0.12];
const BULLET = rgb('#ff6a2a');
const EMBER = [1, 0.35, 0.08];
const RUBBLE = rgb('#1c1230');
const WINDOW = rgb('#ffcf8a');
const SHIELD = [0.55, 0.95, 1];
const BEAM = [1, 0.25, 0.55];
const HULL = rgb('#6a1650');
const HULL_EDGE = rgb('#e0409e');
const ENGINE = rgb('#5ff0ff');
const SHIP_WINDOW = rgb('#ffd0f0');
const LASER = rgb('#ff4a1f');



/** glowing embers cool from orange through deep red and magenta to the dark violet rubble (never brown) */
function ember(heat) {
  const h = Math.min(1, Math.max(0, heat));
  if (h > 0.6) return mix([0.95, 0.12, 0.3], [1, 0.45, 0.1], (h - 0.6) / 0.4);
  if (h > 0.25) return mix([0.45, 0.06, 0.32], [0.95, 0.12, 0.3], (h - 0.25) / 0.35);
  return mix(RUBBLE, [0.45, 0.06, 0.32], h / 0.25);
}

export const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const hash = (n) => {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};

/** corner brackets around a target: what is being aimed at */
function reticle(pix, x0b, y0b, w, h, col, t) {
  const g = 2 + (Math.floor(t * 8) % 2);
  const x0 = x0b - g;
  const y0 = y0b - g;
  const x1 = x0b + w + g - 1;
  const y1 = y0b + h + g - 1;
  for (const [x, y, dx, dy] of [
    [x0, y0, 1, 1],
    [x1, y0, -1, 1],
    [x0, y1, 1, -1],
    [x1, y1, -1, -1],
  ]) {
    pix.put(x, y, col);
    pix.put(x + dx, y, col);
    pix.put(x, y + dy, col);
  }
}

/** an ellipse outline; dashes > 0 leaves gaps (a turning ring of `dashes` arcs) */
export function ellipse(pix, cx, cy, rx, ry, col, a, dashes = 0, turn = 0) {
  const n = Math.ceil(Math.PI * 2 * Math.max(rx, ry) * 1.5);
  let lx = null;
  let ly = null;
  for (let k = 0; k < n; k++) {
    const ang = (k / n) * Math.PI * 2;
    if (dashes && Math.floor(((ang + turn) / (Math.PI * 2)) * dashes * 2) % 2) continue;
    const x = Math.round(cx + rx * Math.cos(ang));
    const y = Math.round(cy + ry * Math.sin(ang));
    if (x === lx && y === ly) continue;
    lx = x;
    ly = y;
    pix.put(x, y, col, a);
  }
}

/**
 * The jump hint for a unit whose boost is ready: 'full' (figure and arrow) until its first boost,
 * 'arrow' (only an arrow) after that, null when not ready or switched off.
 */
function jumpHint(P, bo, t) {
  if (!P.jumpBoost || P.jumpHint === 'aus' || bo.active || bo.charge < 1 || t - bo.readyAt < 0.5) return null;
  if (P.jumpHint === 'immer' || !bo.uses) return 'full';
  return 'arrow';
}

/** the corners of a pointy-top hexagon, clockwise from the top */
function hexPoints(cx, cy, rx, ry) {
  const pts = [];
  for (let k = 0; k < 6; k++) {
    const ang = (Math.PI / 180) * (60 * k - 90);
    pts.push([cx + rx * Math.cos(ang), cy + ry * Math.sin(ang)]);
  }
  return pts;
}

/** the point at u (0..1) along the hexagon's outline, clockwise from the top */
function hexAt(cx, cy, rx, ry, u) {
  const pts = hexPoints(cx, cy, rx, ry);
  const f = Math.min(5.9999, Math.max(0, u * 6));
  const k = Math.floor(f);
  const [x0, y0] = pts[k];
  const [x1, y1] = pts[(k + 1) % 6];
  return [x0 + (x1 - x0) * (f - k), y0 + (y1 - y0) * (f - k)];
}

/** the hexagon's outline from the top, clockwise, as far as u (0..1): a bent power bar */
function hexArc(pix, cx, cy, rx, ry, u, col, a) {
  if (u <= 0) return;
  const pts = hexPoints(cx, cy, rx, ry);
  const f = Math.min(6, u * 6);
  for (let k = 0; k < Math.ceil(f); k++) {
    const [x0, y0] = pts[k];
    const [x1, y1] = pts[(k + 1) % 6];
    const e = Math.min(1, f - k);
    pix.line(x0, y0, x0 + (x1 - x0) * e, y0 + (y1 - y0) * e, col, a);
  }
}

/** a pointy-top hexagon (like the map's tiles): outline, corner posts and a faint fill */
function hexagon(pix, cx, cy, rx, ry, col, a, fill) {
  const pts = [];
  for (let k = 0; k < 6; k++) {
    const ang = (Math.PI / 180) * (60 * k - 90);
    pts.push([cx + rx * Math.cos(ang), cy + ry * Math.sin(ang)]);
  }
  if (fill > 0) {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
        const u = Math.abs(x - cx) / rx;
        const v = Math.abs(y - cy) / ry;
        if (u <= 0.866 && v <= 1 - u * 0.577) pix.put(x, y, col, fill);
      }
    }
  }
  for (let k = 0; k < 6; k++) {
    const [x0, y0] = pts[k];
    const [x1, y1] = pts[(k + 1) % 6];
    pix.line(x0, y0, x1, y1, col, a);
    pix.rect(Math.round(x0) - 1, Math.round(y0) - 1, 2, 2, mix(col, WHITE, 0.5), a);
  }
}

/**
 * An invader seen from above: lit from the top left (bright top-left edges, dark bottom-right ones),
 * missing pixels where it is cracked, glowing eyes at its front. flip: facing left.
 */
function invader(pix, f, type, x, y, col, eye, crack, seed, flip = false, eyes = EYES[type]) {
  const lit = mix(col, WHITE, 0.4);
  const dark = scale(col, 0.55);
  const at = (i, j) => i >= 0 && j >= 0 && i < f.w && j < f.h && f.bits[j * f.w + (flip ? f.w - 1 - i : i)];
  for (let j = 0; j < f.h; j++) {
    for (let i = 0; i < f.w; i++) {
      if (!at(i, j)) continue;
      if (crack > 0 && hash(seed * 97 + j * 13 + i) < crack) continue;
      const k = !at(i, j - 1) || !at(i - 1, j) ? lit : !at(i, j + 1) || !at(i + 1, j) ? dark : col;
      pix.put(x + i, y + j, k);
    }
  }
  if (eye) for (const [ex, ey] of eyes) pix.put(x + (flip ? f.w - 1 - ex : ex), y + ey, eye);
}

/** a sprite turned to face down (rotated a quarter turn clockwise), with its eyes */
const turned = new Map();
function facingDown(type, frame) {
  const key = `${type}${frame}`;
  if (!turned.has(key)) {
    const f = SPRITES[type][frame];
    const bits = new Uint8Array(f.w * f.h);
    for (let j = 0; j < f.w; j++) for (let i = 0; i < f.h; i++) bits[j * f.h + i] = f.bits[(f.h - 1 - i) * f.w + j];
    const eyes = EYES[type].map(([ex, ey]) => [f.h - 1 - ey, ex]);
    turned.set(key, { f: { w: f.h, h: f.w, bits }, eyes });
  }
  return turned.get(key);
}

/** a sprite and its eyes for a direction of flight (right, left, down or up) */
function oriented(type, frame, vx, vy) {
  if (Math.abs(vx) >= Math.abs(vy)) return { f: SPRITES[type][frame], eyes: EYES[type], flip: vx < 0, flipY: false };
  const d = facingDown(type, frame);
  return { f: d.f, eyes: d.eyes, flip: false, flipY: vy < 0 };
}

/** a sprite, mirrored up-down when needed (for divers flying upwards) */
function flipped(o) {
  if (!o.flipY) return o;
  const f = o.f;
  const bits = new Uint8Array(f.w * f.h);
  for (let j = 0; j < f.h; j++) for (let i = 0; i < f.w; i++) bits[j * f.w + i] = f.bits[(f.h - 1 - j) * f.w + i];
  return { f: { w: f.w, h: f.h, bits }, eyes: o.eyes.map(([ex, ey]) => [ex, f.h - 1 - ey]), flip: o.flip };
}

/** the battleship: hull with lit edges, windows, engines; the emitter glows while it charges */
function ship(pix, sh, t, charge) {
  const hit = t - sh.flash < 0.06;
  const worn = 1 - sh.hp / sh.hpMax;
  const x0 = sh.x;
  const y0 = sh.y;
  for (let j = 0; j < SHIP_H; j++) {
    const row = SHIP[j];
    for (let i = 0; i < SHIP_W; i++) {
      const ch = row[i];
      if (ch === '.') continue;
      let col;
      if (ch === '#') {
        const edge = j === 0 || i === 0 || row[i - 1] === '.' || SHIP[j - 1][i] === '.';
        col = edge ? HULL_EDGE : HULL;
        if (worn > 0.3 && hash(i * 31 + j * 7) < worn * 0.4) col = mix(col, EMBER, 0.6 + 0.4 * Math.sin(t * 12 + i));
      } else if (ch === 'o') col = hash(i + Math.floor(t * 2 + j)) > 0.3 ? SHIP_WINDOW : HULL;
      else if (ch === '=') col = scale(ENGINE, 0.7 + 0.3 * Math.sin(t * 30 + i));
      else col = mix(BEAM, WHITE, charge);
      pix.put(x0 + i, y0 + j, hit ? WHITE : col);
    }
  }
}

/** a thick beam from a to b: a white core, a colored mantle, edges that flicker */
function beam(pix, x0, y0, x1, y1, half, col, seed) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const along = Math.abs(dx) >= Math.abs(dy);
  const m = along ? dy / (dx || 1e-6) : dx / (dy || 1e-6);
  const ext = half * Math.sqrt(1 + m * m);
  const [a0, a1] = along ? [x0, x1] : [y0, y1];
  const lim = along ? pix.w - 1 : pix.h - 1;
  for (let u = Math.max(0, Math.floor(Math.min(a0, a1))); u <= Math.min(lim, Math.max(a0, a1)); u++) {
    const c = (along ? y0 : x0) + m * (u - a0);
    const e = Math.max(0.5, ext + (hash(u * 3 + seed) - 0.5) * 1.4);
    for (let v = Math.floor(c - e); v <= c + e; v++) {
      const d = Math.abs(v - c) / e;
      const k = d < 0.3 ? WHITE : mix(mix(WHITE, col, 0.5), col, (d - 0.3) / 0.7);
      if (along) pix.put(u, v, k, d < 0.8 ? 1 : 0.55);
      else pix.put(v, u, k, d < 0.8 ? 1 : 0.55);
    }
  }
}

/**
 * A person seen from above, a classic top-down figure (a pixel sprite, pixels.js PERSON), turned the
 * way the body is turned (pp.face): a shadow to the bottom right, feet that step out in the direction
 * of walking (both peek out in front when standing), arms stretched out where the masks show them,
 * shoulders, arms at the sides, the head a little to the front, a dark rim. The light stays at the
 * top left however the figure turns.
 */
function figure(pix, pp, lk, L, P, t) {
  const s = lk.s;
  const [cx0, cy0] = pp.center;
  const cx = cx0;
  const cy = cy0 - lk.lift;
  const { f, r } = facing(pp.face ?? L.wallFace);
  const a = lk.a;
  const U = PERSON_UNIT; // half blocks: rounder
  const g = personTurned(pp.face ?? L.wallFace);
  const x0 = cx - g.ox * U;
  const y0 = cy - g.oy * U;
  const at = (i, j) => (i >= 0 && j >= 0 && i < g.w && j < g.h ? g.cells[j * g.w + i] : '.');
  // the shadow, to the bottom right (it stays on the floor when the figure hops)
  for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) if (at(i, j) !== '.') pix.put(cx0 - g.ox * U + i * U + 1.5, cy0 - g.oy * U + j * U + 2, BLACK, 0.5, U);
  // the feet: they step out in the direction of walking; standing, both peek out in front
  const shoe = scale(lk.col, 0.4);
  const walking = s && s.speed > 0.15;
  const dir = walking && s.dir ? s.dir : f;
  const dn = Math.hypot(dir[0], dir[1]) || 1;
  const stride = walking ? Math.sin(s.phase) * 3 : 0;
  const toe = walking ? 0 : (PERSON_H * U) / 2 - 0.5;
  for (const side of [-1, 1]) {
    const reach = stride * side;
    const fx = cx + side * 2 * r[0] + (dir[0] / dn) * reach + f[0] * toe;
    const fy = cy + side * 2 * r[1] + (dir[1] / dn) * reach + f[1] * toe;
    pix.line(fx - f[0] * 0.65, fy - f[1] * 0.65, fx + f[0] * 0.65, fy + f[1] * 0.65, shoe, a, 2, U);
  }
  // stretched-out arms (from the masks), in the figure's proportions: a round, thick arm in the
  // sleeves' color from the shoulder, a dark rim, a light round hand at its end
  const armCol = scale(lk.col, 0.55);
  const handCol = mix(lk.col, WHITE, 0.45);
  for (const arm of pp.arms) {
    const [sx0, sy0] = arm.from ? [arm.from[0], arm.from[1] - lk.lift] : [cx, cy];
    const tx = arm.tip[0];
    const ty = arm.tip[1] - lk.lift;
    const n = Math.max(1, Math.ceil(Math.hypot(tx - sx0, ty - sy0) / 0.5));
    for (const [rr, col, al] of [
      [ARM.thick + 0.5, BLACK, 0.8],
      [ARM.thick, armCol, 1],
    ]) {
      for (let k = 0; k <= n; k++) pix.disc(sx0 + ((tx - sx0) * k) / n, sy0 + ((ty - sy0) * k) / n, rr, col, al * a, U);
    }
    pix.disc(tx, ty, ARM.hand + 0.5, BLACK, 0.8 * a, U);
    pix.disc(tx, ty, ARM.hand, handCol, a, U);
    pix.put(tx - ARM.hand * 0.5 - 0.25, ty - ARM.hand * 0.5 - 0.25, mix(handCol, WHITE, 0.6), a, U);
  }
  // the figure: a dark rim, then shirt, arms and hair, lit from the top left
  const tone = { '#': scale(lk.col, 0.72), a: scale(lk.col, 0.55), h: mix(lk.col, WHITE, 0.4) };
  for (let j = -1; j <= g.h; j++) {
    for (let i = -1; i <= g.w; i++) {
      const ch = at(i, j);
      if (ch === '.') {
        if ([at(i - 1, j), at(i + 1, j), at(i, j - 1), at(i, j + 1)].some((q) => q !== '.')) pix.put(x0 + i * U, y0 + j * U, BLACK, 0.8 * a, U);
        continue;
      }
      const same = (q) => q === ch;
      const col = !same(at(i, j - 1)) || !same(at(i - 1, j)) ? mix(tone[ch], WHITE, 0.25) : !same(at(i, j + 1)) || !same(at(i + 1, j)) ? scale(tone[ch], 0.7) : tone[ch];
      pix.put(x0 + i * U, y0 + j * U, col, a, U);
    }
  }
}

/** how each person looks this frame (color, blinking when stunned) */
export function looks(game, people) {
  const t = game.time;
  const party = t < game.party;
  const look = new Map();
  for (const pp of people) {
    const s = game.players.get(pp.id);
    let col = party ? neon(t * 0.7 + pp.slot * 0.13) : pp.col;
    let a = 1;
    if (s && t - s.hitAt < 0.12) col = WHITE;
    else if (s && t < s.stunUntil) {
      col = mix(col, RED, 0.65);
      a = Math.floor(t * 10) % 2 ? 0.35 : 1;
    }
    // a jump that was seen: the unit hops (in this top-down view: lifted up, its shadow stays below)
    const ju = s ? (t - s.jumpAt) / 0.35 : 9;
    const lift = ju >= 0 && ju < 1 ? Math.round(Math.sin(Math.PI * ju) * 5) : 0;
    look.set(pp.slot, { col, a, s, lift, firing: !!s && pp.arms.some((arm) => t - (s.fire.get(arm.id) ?? -9) < 0.12) });
  }
  return look;
}

export function drawArt(S, people, look) {
  const { pix, game, body, layout: L } = S;
  const t = game.time;
  const party = t < game.party;
  const alarm = t < game.alarm ? (game.alarm - t) / 0.5 : 0;
  const invCol = S.invCol;
  pix.clear();

  // ---- the city: its aerial picture (city.js) where it stands, rubble and embers where it was hit,
  // the energy wall drawn live
  const c = game.city;
  const wallHit = Math.max(0, 1 - (t - c.hitAt) / 0.2);
  const S0 = c.S;
  const X0 = Math.round(pix.ox + c.x0 * S0);
  const Y0 = Math.round(pix.oy);
  const px = [0, 0, 0];
  for (let j = 0; j < c.h; j++) {
    for (let i = 0; i < c.w; i++) {
      const k = j * c.w + i;
      const type = c.alive[k];
      if (!type) {
        if (!c.base[k]) continue;
        const age = t - c.deadAt[k];
        const col = age < 2.5 ? ember((1 - age / 2.5) * (0.75 + 0.25 * Math.sin(t * 13 + hash(k) * 40))) : RUBBLE;
        pix.put(c.x0 + i, j, col, age < 2.5 ? 1 : 0.9);
        continue;
      }
      const born = t - c.born[k];
      const flashB = born < 0.35 ? 1 - born / 0.35 : 0;
      if (type === CITY.WALL || type === CITY.TOWER) {
        let col = type === CITY.TOWER ? [0.37, 0.7, 0.94] : scale([0.16, 0.56, 0.85], 0.75 + 0.25 * Math.sin(t * 5 + j * 0.35));
        if (wallHit > 0) col = mix(col, WHITE, wallHit);
        if (party) col = neon(t * 0.6 + j * 0.02);
        if (alarm > 0) col = mix(col, RED, alarm * 0.7);
        pix.put(c.x0 + i, j, mix(col, WHITE, flashB));
        continue;
      }
      // copy this art pixel's S x S LEDs from the picture
      for (let v = 0; v < S0; v++) {
        for (let u = 0; u < S0; u++) {
          const o = ((j * S0 + v) * c.imgW + i * S0 + u) * 3;
          px[0] = c.img[o];
          px[1] = c.img[o + 1];
          px[2] = c.img[o + 2];
          let col = px;
          if (flashB > 0) col = mix(px, WHITE, flashB);
          if (alarm > 0) col = mix(col, RED, alarm * 0.5);
          pix.dot(X0 + i * S0 + u, Y0 + j * S0 + v, col);
        }
      }
    }
  }
  const aliveAt = (ax, ay) => {
    const i = Math.floor(ax - c.x0);
    const j = Math.floor(ay);
    return i >= 0 && j >= 0 && i < c.w && j < c.h && c.alive[j * c.w + i] > 0;
  };
  // the energy core: ring segments turning both ways, the core pulsing
  if (aliveAt(c.x0 + c.core.x, c.core.y)) {
    const cr = c.core;
    for (const [rr, speed, segs, col] of [
      [cr.r * 0.86, 0.9, 3, [0.5, 1, 1]],
      [cr.r * 0.52, -1.6, 2, [0.85, 0.6, 1]],
    ]) {
      for (let k = 0; k < segs; k++) {
        const a0 = t * speed + (k / segs) * Math.PI * 2;
        for (let a = a0; a < a0 + 0.9; a += 0.12) pix.put(c.x0 + cr.x + Math.cos(a) * rr - 0.25, cr.y + Math.sin(a) * rr - 0.25, col, 0.9, 0.5);
      }
    }
    pix.disc(c.x0 + cr.x, cr.y, cr.r * 0.22 * (1 + 0.15 * Math.sin(t * 6)), WHITE, 0.9, 0.5);
  }
  // the conduit: light pulses run down from the core
  {
    const cd = c.conduit;
    const len = cd.y1 - cd.y0;
    for (let k = 0; k < 3; k++) {
      const y = cd.y0 + ((t * 9 + (k * len) / 3) % len);
      for (let d = 0; d < 3; d += 0.5) if (aliveAt(c.x0 + cd.x, y - d)) pix.put(c.x0 + cd.x - 0.25, y - d, mix([0.3, 0.95, 1], WHITE, 1 - d / 3), 1 - d / 3.5, 0.5);
    }
  }
  // hover gliders: a bright nose, a colored body, a light trail behind; only on living streets
  for (const car of game.cars) {
    const ln = car.lane;
    const along = Math.round(car.pos);
    const across = Math.round(ln.at);
    const cellX = ln.vertical ? Math.floor(ln.at / S0) : Math.floor(along / S0);
    const cellY = ln.vertical ? Math.floor(along / S0) : Math.floor(ln.at / S0);
    if (cellX < 0 || cellY < 0 || cellX >= c.w || cellY >= c.h || !c.alive[cellY * c.w + cellX]) continue;
    const trail = S0 * 4;
    for (let a = 0; a < trail; a++) {
      const back = along - ln.dir * a;
      const k = a < 2 ? WHITE : a < S0 ? car.col : car.col;
      const al = a < S0 ? 1 : 0.7 * (1 - (a - S0) / (trail - S0));
      for (let b2 = -1; b2 <= 0; b2++) {
        if (a >= S0 && b2 !== 0) continue; // the trail is thinner than the glider
        const X = ln.vertical ? across + b2 : back;
        const Y = ln.vertical ? back : across + b2;
        pix.dot(X0 + X, Y0 + Y, k, al);
      }
    }
  }

  // ---- scorch marks of the battleship's laser: a glowing trench that fades
  for (const sc of game.scorches) {
    const u = (t - sc.t0) / 4;
    const half = sc.w * 0.15;
    for (let y = Math.max(0, Math.floor(sc.y0)); y < L.AH; y++) {
      const fl = 0.8 + 0.2 * hash(y * 7 + Math.floor(t * 8));
      for (let x = Math.round(sc.x - half); x <= sc.x + half; x++) pix.put(x, y, ember((1 - u) * fl), 0.9 * (1 - u * u));
    }
  }
  // ---- the battleship charging: a warning stripe on the floor where it will fire
  const sh = game.ship;
  if (sh && sh.state === 'charge') {
    const dur = S.P.shipCharge / (0.9 + 0.1 * game.difficulty);
    const u = Math.min(1, sh.stateT / dur);
    const half = (S.P.beamWidth * L.sx) / 2;
    const pulse = 0.5 + 0.5 * Math.sin(t * (8 + 30 * u));
    const y0 = Math.round(sh.y + SHIP_H);
    for (let y = y0; y < L.AH; y++) {
      for (let x = Math.round(sh.beamX - half); x <= sh.beamX + half; x++) {
        const edge = Math.abs(x - sh.beamX) > half - 1;
        pix.put(x, y, BEAM, edge ? 0.5 + 0.4 * pulse : (0.06 + 0.22 * u) * (0.5 + 0.5 * pulse));
      }
    }
  }

  // ---- power-ups: dropped with a column of light, a turning ring, blinking before they go
  for (const it of game.items) {
    const age = t - it.t0;
    if (it.life - age < 3 && Math.floor(t * 8) % 2) continue;
    const col = POWER_COLORS[it.type];
    if (age < 0.35) pix.line(it.x, 0, it.x, it.y, mix(col, WHITE, 0.5), 1 - age / 0.35);
    const bob = Math.round(Math.sin(t * 4 + it.x) * 1);
    const grow = Math.min(1, age / 0.2);
    ellipse(pix, it.x, it.y + bob, 6.5 * grow, 5.5 * grow, col, 0.9, 6, -t * 2.5);
    ellipse(pix, it.x, it.y + bob, 5 * grow, 4.2 * grow, col, 0.25);
    if (grow >= 1) pix.sprite(ICONS[it.type], it.x - 3, it.y - 3 + bob, mix(col, WHITE, 0.35 + 0.25 * Math.sin(t * 6)));
  }

  // ---- a jump: the shadow left on the floor, the landing ring, arrows shooting up
  for (const pp of people) {
    const lk = look.get(pp.slot);
    const s = lk.s;
    if (!s) continue;
    const age = t - s.jumpAt;
    if (age < 0 || age > 1) continue;
    const [cx, cy] = pp.center;
    const r = 0.2 * S.P.bodyScale + 0.05;
    if (lk.lift > 0) {
      const sh = lk.lift / 5;
      for (let y = -r * L.sy; y <= r * L.sy; y++) {
        for (let x = -r * L.sx; x <= r * L.sx; x++) if ((x / (r * L.sx)) ** 2 + (y / (r * L.sy)) ** 2 <= 1) pix.put(cx + x, cy + y + 2, BLACK, 0.45 * sh);
      }
    }
    if (age > 0.3) {
      const u = (age - 0.3) / 0.7;
      const rr = (0.3 * S.P.bodyScale + 0.15) * (1 + u);
      ellipse(pix, cx, cy, rr * L.sx, rr * L.sy, mix(lk.col, WHITE, 0.5), 1 - u);
    }
    if (age < 0.9) {
      const u = age / 0.9;
      const top = cy - 30 >= 0; // decided once per jump, so the arrows do not jump around
      for (let k = 0; k < 3; k++) {
        // above the unit, or below it near the top edge of the map
        const y = top ? cy - 10 - age * 40 - k * 7 : cy + 8 + k * 7;
        pix.sprite(JUMP_HINT.chevron, cx - 4, y, mix(lk.col, WHITE, 0.8 - k * 0.2), Math.min(1, (1 - u) * 2) * (1 - k * 0.2));
      }
    }
  }

  // ---- footprints: one per step, left and right, turned the way the person walked; they fade
  for (const f of game.footprints) {
    const u = (t - f.t0) / S.P.footLife;
    const a = 0.9 * (1 - u) ** 1.2;
    const col = mix(f.col, WHITE, 0.3);
    const [dx, dy] = f.dir;
    // the ball of the foot (bigger) in front, the heel behind
    pix.rect(f.x + dx * 1.1 - 0.6, f.y + dy * 1.1 - 0.6, 1.2, 1.2, col, a);
    pix.rect(f.x - dx * 1.1 - 0.45, f.y - dy * 1.1 - 0.35, 0.9, 0.7, col, a * 0.8);
  }

  // ---- the people as top-down figures (or their real silhouettes, param look)
  if (S.P.look !== 'Silhouette') for (const pp of people) figure(pix, pp, look.get(pp.slot), L, S.P, t);
  else for (let y = 0; y < body.h; y++) {
    for (let x = 0; x < body.w; x++) {
      const k = y * body.w + x;
      const s = body.slot[k];
      const lk = s && look.get(s);
      if (!lk) continue;
      const h = Math.min(1, body.height[k] / 180);
      let col = scale(lk.col, 0.25 + 0.75 * h ** 1.6);
      if (body.kind[k] === 2 && lk.firing) col = mix(col, WHITE, 0.45);
      if (lk.lift) col = mix(col, WHITE, lk.lift * 0.06);
      pix.put(x, y - lk.lift, col, lk.a);
    }
  }
  // their base on the floor: a hexagon that is the boost energy (a bent power bar, clockwise from the
  // top): full and pulsing = ready (a jump starts the boost), used up while boosting (bright, double),
  // charged again dimly; standing still adds the fort (a faint fill and corner posts)
  for (const pp of people) {
    const lk = look.get(pp.slot);
    const s = lk.s;
    const [cx, cy] = pp.center;
    // the boost starts: the hexagon pops up big and snaps back
    const pop = s ? Math.max(0, 1 - (t - s.boost.at) / 0.3) : 0;
    const r = (0.36 * S.P.bodyScale + 0.1) * (1 + 0.6 * pop * pop);
    const rx = r * L.sx;
    const ry = r * L.sy;
    const bo = s?.boost ?? { charge: 1, active: false, at: -9, readyAt: -9, uses: 0 };
    // ready and not used yet: the hexagon hops along with the jump hint (see below)
    const hint = jumpHint(S.P, bo, t);
    const hop = (hint === 'full' && (t * 1.1) % 1 > 0.5 ? -2 : 0) - look.get(pp.slot).lift;
    if (s?.fortified) {
      const u = Math.min(1, (t - s.fortAt) / 0.25);
      hexagon(pix, cx, cy, rx * (1 + 0.4 * (1 - u) ** 2), ry * (1 + 0.4 * (1 - u) ** 2), lk.col, 0, 0.1);
      for (const [x, y] of hexPoints(cx, cy, rx, ry)) pix.rect(Math.round(x) - 1, Math.round(y) - 1, 2, 2, mix(lk.col, WHITE, 0.5), lk.a);
    }
    // jumped without a full hexagon: its empty track flickers
    const denied = s && t - s.deniedAt < 0.4 ? Math.floor(t * 20) % 2 : 0;
    hexArc(pix, cx, cy + hop, rx, ry, 1, denied ? mix(lk.col, RED, 0.6) : lk.col, (denied ? 0.7 : 0.12) * lk.a);
    if (pop > 0) hexArc(pix, cx, cy + hop, rx * 1.15, ry * 1.15, 1, WHITE, pop * lk.a);
    let col = lk.col;
    let a = 0.4;
    if (bo.active) {
      col = mix(lk.col, WHITE, 0.25 + 0.15 * Math.sin(t * 20));
      a = 1;
      hexArc(pix, cx, cy, rx * 0.85, ry * 0.85, bo.charge, col, lk.a);
    } else if (bo.charge >= 1) {
      const ready = Math.max(0, 1 - (t - bo.readyAt) / 0.5);
      col = mix(lk.col, WHITE, 0.15 + 0.15 * Math.sin(t * 4) + ready * 0.7);
      a = 0.75 + 0.25 * Math.sin(t * 4);
    }
    hexArc(pix, cx, cy + hop, rx, ry, bo.charge, col, a * lk.a);
    // the hint figure that was showing takes off with the boost
    if (s && s.launchFull && t - s.launchAt < 0.45) {
      const u = (t - s.launchAt) / 0.45;
      pix.sprite(JUMP_HINT.jump, Math.round(cx + rx * 0.75), Math.round(cy - ry - 13 - u * 40), WHITE, 1 - u);
    }
    // the jump hint, no text: a little figure crouching and jumping, an arrow up (until the first boost)
    if (hint) {
      const ph = (t * 1.1) % 1;
      const hx = Math.round(cx + rx * 0.75);
      const above = cy - ry - 13 >= 0;
      const hy = Math.round(above ? cy - ry - 13 : cy + ry + 3);
      const hcol = mix(lk.col, WHITE, 0.55);
      if (hint === 'full') {
        const up = ph > 0.5;
        pix.sprite(up ? JUMP_HINT.jump : JUMP_HINT.crouch, hx, hy + (up ? -2 : 1), hcol, 0.95 * lk.a);
        if (!up && ph < 0.12) {
          pix.put(hx, hy + 10, hcol, 0.6);
          pix.put(hx + 6, hy + 10, hcol, 0.6);
        }
      }
      // the arrow rises and fades, again and again
      const ay = hint === 'full' ? hy - 5 - Math.round(ph * 3) : Math.round(cy - ry - 5 - ph * 3 + hop);
      pix.sprite(JUMP_HINT.arrow, hint === 'full' ? hx : Math.round(cx - 3), ay, hcol, (1 - ph) * lk.a);
    }
    // the end of the bar
    if (bo.charge > 0 && bo.charge < 1) {
      const [ex, ey] = hexAt(cx, cy, rx, ry, bo.charge);
      pix.rect(Math.round(ex) - 1, Math.round(ey) - 1, 2, 2, bo.active ? WHITE : mix(lk.col, WHITE, 0.4), lk.a);
    }
  }

  // ---- team lasers: a lightning beam from one color to the other, white when it cuts
  for (const ln of game.links) {
    const la = look.get(ln.a.slot);
    const lb = look.get(ln.b.slot);
    if (!la || !lb) continue;
    const [ax, ay] = ln.a.center;
    const [bx, by] = ln.b.center;
    const len = Math.hypot(bx - ax, by - ay);
    const segs = Math.max(2, Math.round(len / 7));
    const nx = -(by - ay) / (len || 1);
    const ny = (bx - ax) / (len || 1);
    const flash = Math.max(0, 1 - (t - ln.st.flash) / 0.15);
    const born = Math.min(1, (t - ln.st.born) / 0.2);
    const seed = Math.floor(t * 20);
    let px = ax;
    let py = ay;
    for (let k = 1; k <= segs * born; k++) {
      const u = k / segs;
      const jit = k < segs ? (hash(seed * 13 + k) - 0.5) * 3 : 0;
      const x = ax + (bx - ax) * u + nx * jit;
      const y = ay + (by - ay) * u + ny * jit;
      const col = mix(mix(la.col, lb.col, u), WHITE, 0.35 + 0.65 * flash);
      pix.line(px, py, x, y, col, 0.95);
      px = x;
      py = y;
    }
  }

  // ---- invaders: they hover over the map, their shadows fall to the bottom right; they bob slowly
  const b = [0, 0, 0, 0, ''];
  const bob = (side, i) => Math.round(Math.sin(t * 2.2 + i * 0.9 + side.edge) * 0.9);
  for (const side of game.sides) {
    for (let i = 0; i < side.alive.length; i++) {
      if (!side.alive[i] || t < side.spawn[i]) continue;
      game.box(side, i, b);
      pix.sprite(SPRITES[b[4]][game.frameAnim], b[0] + 3, b[1] + 4, BLACK, 0.6, side.edge > 0);
    }
  }
  for (const d of game.divers) {
    const o = flipped(oriented(d.type, game.frameAnim, d.vx, d.vy));
    pix.sprite(o.f, d.x - o.f.w / 2 + 5, d.y - o.f.h / 2 + 6, BLACK, 0.5, o.flip);
  }
  if (game.ufo) pix.sprite(SPRITES.ufo[0], game.ufo.x + 4, game.ufo.y + 5, BLACK, 0.6);
  for (const side of game.sides) {
    for (let i = 0; i < side.alive.length; i++) {
      if (!side.alive[i] || t < side.spawn[i]) continue;
      game.box(side, i, b);
      const kick = Math.max(0, 1 - (t - side.kickAt[i]) / 0.12);
      const x = b[0] + side.kickX[i] * kick;
      const y = b[1] + side.kickY[i] * kick + bob(side, i);
      const storming = side.storm?.includes(i);
      // a light wave runs through the formation on every beat, from the back to the front
      const outer = side.edge < 0 ? i % side.cols : side.cols - 1 - (i % side.cols);
      const wave = Math.max(0, 1 - Math.abs(t - game.beatAt - outer * 0.04) / 0.07);
      let col = storming ? (Math.floor(t * 16) % 2 ? RED : WHITE) : mix(invCol(b[4]), WHITE, wave * 0.45);
      if (t < game.enemySlowUntil) col = mix(col, POWER_COLORS.slow, 0.5);
      const worn = 1 - side.hp[i] / side.hpMax[i];
      if (t - side.flash[i] < 0.08 || t - side.spawn[i] < 0.12) col = WHITE;
      else if (!storming && worn > 0) col = scale(col, 1 - worn * 0.35);
      // eyes: bright, red when about to fire, closed now and then
      const charging = side.charge[i] > t;
      const blink = (t * 0.7 + hash(i + side.edge * 50) * 10) % 4 < 0.12;
      const eye = charging ? (Math.floor(t * 20) % 2 ? RED : [1, 0.6, 0.4]) : blink ? null : mix(col, WHITE, 0.7);
      invader(pix, SPRITES[b[4]][game.frameAnim], b[4], x, y, col, eye, worn * 0.35, i + side.edge * 100, side.edge > 0);
      if (side.shield[i] > 0) {
        const hitS = Math.max(0, 1 - (t - side.shieldHit[i]) / 0.15);
        ellipse(pix, x + b[2] / 2, y + 4, b[2] / 2 + 2.5, 6.5, mix(SHIELD, WHITE, hitS), 0.35 + 0.2 * side.shield[i] + hitS * 0.4, 8, t * 2 + i);
      }
    }
  }
  // divers: afterimages behind them, blinking
  // divers: turned into their direction of flight, afterimages behind them, blinking
  for (const d of game.divers) {
    const o = flipped(oriented(d.type, game.frameAnim, d.vx, d.vy));
    d.trail.forEach(([x, y], k) => pix.sprite(o.f, x - o.f.w / 2, y - o.f.h / 2, mix(invCol(d.type), RED, 0.5), 0.45 * (1 - k / d.trail.length), o.flip));
    const col = t - d.flash < 0.08 ? WHITE : Math.floor(t * 10) % 2 ? RED : invCol(d.type);
    invader(pix, o.f, d.type, d.x - o.f.w / 2, d.y - o.f.h / 2, col, RED, 0, 0, o.flip, o.eyes);
  }
  // the mothership: a saucer seen from above, its dome lit from the top left, lights running round
  if (game.ufo) {
    const u = game.ufo;
    invader(pix, SPRITES.ufo[0], 'ufo', u.x, u.y, RED, null, 0, 0, false, []);
    const cx = u.x + UFO_W / 2 - 0.5;
    const cy = u.y + UFO_H / 2 - 0.5;
    for (const [dx, dy] of UFO_DOME) {
      const l = Math.max(0, 1 - Math.hypot(dx - UFO_W / 2 + 2, dy - UFO_H / 2 + 2) / 5);
      pix.put(u.x + dx, u.y + dy, mix([1, 0.45, 0.6], WHITE, 0.25 + 0.6 * l));
    }
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const on = (Math.floor(t * 12) - k + 80) % 8 < 2;
      pix.put(cx + Math.cos(a) * 6.5, cy + Math.sin(a) * 4.2, on ? WHITE : [1, 0.6, 0.2]);
    }
  }
  // mines: lobbed (a shadow on the floor, the orb above), then a warning pulse that speeds up
  for (const bm of game.bombs) {
    const u = (t - bm.t0) / bm.flight;
    if (u < 1) {
      const arc = Math.sin(Math.PI * u) * 7;
      pix.rect(Math.round(bm.x) - 1, Math.round(bm.y), 2, 1, BLACK, 0.5);
      pix.rect(Math.round(bm.x) - 1, Math.round(bm.y - arc) - 1, 2, 2, Math.floor(t * 16) % 2 ? WHITE : BULLET);
      continue;
    }
    const left = bm.t0 + bm.flight + bm.fuse - t;
    const rate = 2 + 10 * (1 - left / bm.fuse);
    const ph = (t * rate) % 1;
    const rx = bm.r * L.sx;
    const ry = bm.r * L.sy;
    ellipse(pix, bm.x, bm.y, rx, ry, RED, 0.35);
    ellipse(pix, bm.x, bm.y, rx * ph, ry * ph, mix(RED, WHITE, ph), 1 - ph);
    pix.rect(Math.round(bm.x) - 1, Math.round(bm.y) - 1, 3, 2, ph < 0.5 ? WHITE : RED);
  }
  if (sh) {
    pix.sprite(SPRITES.ship[0], sh.x + 3, sh.y + 3, BLACK, 0.5);
    const charge = sh.state === 'charge' ? Math.min(1, sh.stateT / (S.P.shipCharge / (0.9 + 0.1 * game.difficulty))) : sh.state === 'fire' ? 1 : 0;
    ship(pix, sh, t, charge);
  }

  for (const bm of game.booms) {
    const u = (t - bm.t0) / 0.25;
    if (bm.warp) {
      // a star where an invader warps in
      const r = 1 + u * 6;
      pix.line(bm.x - r, bm.y, bm.x + r, bm.y, WHITE, 1 - u);
      pix.line(bm.x, bm.y - r * 0.6, bm.x, bm.y + r * 0.6, WHITE, 1 - u);
      continue;
    }
    const f = bm.splat ? SPRITES.splat[0] : SPRITES.boom[0];
    pix.sprite(f, bm.x - f.w / 2, bm.y - f.h / 2, bm.col, 1 - u * 0.5);
  }

  // ---- what is being aimed at
  for (const pp of people) {
    const lk = look.get(pp.slot);
    const s = lk.s;
    if (!s) continue;
    const targets = [...s.lock.values()];
    if (s.fortified && s.autoTarget) targets.push(s.autoTarget);
    for (const tg of targets) {
      const at = game.targetPos(tg);
      if (!at) continue;
      if (tg.ufo) reticle(pix, Math.round(tg.ufo.x), tg.ufo.y, UFO_W, UFO_H, lk.col, t);
      else if (tg.diver) reticle(pix, Math.round(at[0] - 5.5), Math.round(at[1] - 4.5), 11, 9, lk.col, t);
      else if (tg.ship) reticle(pix, Math.round(tg.ship.x), Math.round(tg.ship.y), SHIP_W, SHIP_H, lk.col, t);
      else reticle(pix, ...game.box(tg.side, tg.i).slice(0, 4), lk.col, t);
    }
  }

  // ---- shock waves, debris
  for (const w of game.waves) {
    const u = (t - w.t0) / 0.45;
    const r = w.R * (1 - (1 - u) ** 2);
    ellipse(pix, w.x, w.y, r * L.sx, r * L.sy, mix(w.col, WHITE, 0.5), 1 - u);
    if (r > 0.08) ellipse(pix, w.x, w.y, (r - 0.07) * L.sx, (r - 0.07) * L.sy, w.col, (1 - u) * 0.7);
  }
  for (const q of game.particles) pix.put(q.x, q.y, q.col, 1 - (t - q.t0) / q.life);

  // ---- active power-ups: a shield bubble, a dot per power circling the unit
  for (const pp of people) {
    const s = look.get(pp.slot).s;
    if (!s) continue;
    const [cx, cy] = pp.center;
    const rr = 0.3 * S.P.bodyScale + 0.12;
    if (s.power.shield > 0 && t < s.power.shieldUntil) {
      const hitS = Math.max(0, 1 - (t - s.shieldHit) / 0.2);
      hexagon(pix, cx, cy, rr * L.sx, rr * L.sy, mix(POWER_COLORS.shield, WHITE, hitS), 0.6 + 0.4 * hitS, 0.06 + 0.04 * s.power.shield);
    }
    const active = ['rapid', 'spread', 'mega'].filter((k) => t < s.power[k]);
    active.forEach((k, i) => {
      const ang = t * 5 + (i * Math.PI * 2) / active.length;
      pix.disc(cx + Math.cos(ang) * rr * L.sx, cy + Math.sin(ang) * rr * L.sy, 1.2, POWER_COLORS[k]);
    });
  }

  // ---- heads and hands: the bright points of every unit (the figures have their own head; their
  // hands glow only at the end of a stretched-out arm)
  const figures = S.P.look !== 'Silhouette';
  for (const pp of people) {
    const lk = look.get(pp.slot);
    const s = lk.s;
    if (pp.head && !figures) {
      pix.disc(pp.head[0], pp.head[1] - lk.lift, 2.2, mix(lk.col, WHITE, 0.75), lk.a);
      ellipse(pix, pp.head[0], pp.head[1] - lk.lift, 3.6, 3.6, lk.col, 0.8 * lk.a);
    }
    for (const h of figures ? pp.arms.map((a) => a.tip) : (pp.hands ?? [])) {
      if (!h) continue;
      const hy = Math.round(h[1]) - lk.lift;
      pix.rect(Math.round(h[0]) - 1, hy - 1, 2, 2, WHITE, lk.a);
      for (const [dx, dy] of [
        [-2, -1],
        [1, -1],
        [-2, 0],
        [1, 0],
        [-1, -2],
        [0, -2],
        [-1, 1],
        [0, 1],
      ])
        pix.put(Math.round(h[0]) + dx, hy + dy, lk.col, 0.8 * lk.a);
    }
    if (!s) continue;
    for (const arm of pp.arms) if (t - (s.fire.get(arm.id) ?? -9) < 0.06) pix.disc(arm.tip[0], arm.tip[1], 2, WHITE);
    if (t - (s.fire.get('auto') ?? -9) < 0.06) pix.disc(pp.center[0], pp.center[1], 2, WHITE);
  }

  // ---- lasers from the edges: the emitter, the marked middle line, then the beam opens up
  for (const l of game.edgeLasers) {
    const a = t - l.t0;
    const charge = Math.min(1, a / l.tele);
    const dir = l.x1 > l.x0 ? 1 : -1;
    // the emitter: a small wedge at the edge, glowing up
    for (let j = -3; j <= 3; j++) {
      for (let i = 0; i <= 3 - Math.abs(j); i++) pix.put(l.x0 + dir * i - (dir < 0 ? 1 : 0), l.y0 + j, mix(LASER, WHITE, charge * 0.7));
    }
    const open = game.edgeOpen(l);
    if (a < l.tele) {
      // the middle line, pulsing faster; a light runs along it towards the far side
      const pulse = 0.5 + 0.5 * Math.sin(t * (8 + 26 * charge));
      pix.line(l.x0, l.y0, l.x1, l.y1, LASER, 0.25 + 0.55 * charge * pulse);
      const u = (a * 1.6) % 1;
      for (let k = -2; k <= 2; k++) {
        const uu = u + k * 0.006;
        pix.put(l.x0 + (l.x1 - l.x0) * uu, l.y0 + (l.y1 - l.y0) * uu, WHITE, 1 - Math.abs(k) * 0.3);
      }
    } else if (open > 0) beam(pix, l.x0, l.y0, l.x1, l.y1, Math.max(0.6, l.half * open), LASER, Math.floor(t * 30) + Math.round(l.y0));
  }
  for (const pp of people) {
    const m = look.get(pp.slot).s?.mega;
    if (m) beam(pix, m.x0, m.y0, m.x1, m.y1, m.half * (1 + 0.15 * Math.sin(t * 40)), pp.col, Math.floor(t * 30) + pp.slot * 7);
  }

  // ---- the battleship's laser: a white core, a magenta mantle, flickering edges
  if (sh && sh.state === 'fire') {
    const dur = 1.1;
    const grow = Math.min(1, sh.stateT / 0.08) * Math.min(1, (dur - sh.stateT) / 0.15);
    const half = ((S.P.beamWidth * L.sx) / 2) * grow * (1 + 0.08 * Math.sin(t * 50));
    const y0 = Math.round(sh.y + SHIP_H - 1);
    const seed = Math.floor(t * 30);
    for (let y = y0; y < L.AH; y++) {
      const h = half + (hash(y * 3 + seed) - 0.5) * 2;
      for (let x = Math.round(sh.beamX - h); x <= sh.beamX + h; x++) {
        const d = Math.abs(x - sh.beamX) / Math.max(h, 1);
        const col = d < 0.25 ? WHITE : mix(mix(WHITE, BEAM, 0.55), scale(BEAM, 0.8), (d - 0.25) / 0.75);
        pix.put(x, y, col, d < 0.8 ? 1 : 0.55);
      }
    }
  }

  // ---- shots and bullets on top
  for (const sh of game.shots) {
    const v = Math.hypot(sh.vx, sh.vy) || 1;
    const dx = sh.vx / v;
    const dy = sh.vy / v;
    if (sh.big) {
      // boosted: thick, longer, a white head
      pix.line(sh.x - dx * 10, sh.y - dy * 10, sh.x - dx * 2, sh.y - dy * 2, sh.col, 1, 2);
      pix.rect(Math.round(sh.x) - 1, Math.round(sh.y) - 1, 2, 2, WHITE);
    } else {
      pix.line(sh.x - dx * 7, sh.y - dy * 7, sh.x - dx * 2, sh.y - dy * 2, sh.col);
      pix.line(sh.x - dx, sh.y - dy, sh.x, sh.y, WHITE);
    }
  }
  for (const bu of game.bullets) {
    if (bu.aimed) {
      const on = Math.floor(t * 14 + bu.anim) % 2;
      pix.rect(Math.round(bu.x) - 1, Math.round(bu.y) - 1, 2, 2, on ? WHITE : BULLET);
      pix.put(Math.round(bu.x) - 2, Math.round(bu.y), BULLET, 0.7);
      pix.put(Math.round(bu.x) + 1, Math.round(bu.y), BULLET, 0.7);
    } else {
      const f = SPRITES.zig[Math.floor(t * 12 + bu.anim) % 4];
      pix.sprite(f, bu.vx > 0 ? bu.x - 6 : bu.x, bu.y - 1, BULLET, 1, bu.vx < 0);
    }
  }
}

/** the lights on the floor: x, y (art px), radius (m), intensity, rgb; returns how many */
export function collectLights(S, people, look, out) {
  const { game, fx } = S;
  const t = game.time;
  let n = 0;
  const add = (x, y, r, i, col) => {
    if (n >= MAX_LIGHTS || i <= 0.01) return;
    const o = n * 8;
    out[o] = x;
    out[o + 1] = y;
    out[o + 2] = r;
    out[o + 3] = i;
    out[o + 4] = col[0];
    out[o + 5] = col[1];
    out[o + 6] = col[2];
    n++;
  };
  // flashes first (explosions): they matter most
  for (const l of fx.lights) {
    const u = (fx.time - l.t0) / l.life;
    add(l.x, l.y, l.r * (1 + 0.3 * u), l.i * (1 - u) ** 1.5, l.col);
  }
  for (const pp of people) {
    const lk = look.get(pp.slot);
    const figures = S.P.look !== 'Silhouette';
    add(pp.center[0], pp.center[1], 0.9, (figures ? 0.16 : 0.3) * lk.a, lk.col);
    if (pp.head && !figures) add(pp.head[0], pp.head[1], 0.4, 0.55 * lk.a, mix(lk.col, WHITE, 0.4));
    for (const h of figures ? pp.arms.map((q) => q.tip) : (pp.hands ?? [])) if (h) add(h[0], h[1], 0.3, 0.7 * lk.a, lk.col);
    if (lk.s?.fortified) add(pp.center[0], pp.center[1], 0.55, 0.3, lk.col);
    if (lk.s?.boost.active) add(pp.center[0], pp.center[1], 0.75, 0.55 + 0.15 * Math.sin(t * 20), lk.col);
  }
  for (const sh of game.shots) add(sh.x, sh.y, 0.35, 0.8, sh.col);
  for (const d of game.divers) add(d.x, d.y, 0.5, 1, RED);
  if (game.ufo) add(game.ufo.x + UFO_W / 2, game.ufo.y + UFO_H / 2, 1, 1.2, RED);
  for (const ln of game.links) {
    const flash = Math.max(0, 1 - (t - ln.st.flash) / 0.15);
    const la = look.get(ln.a.slot);
    const lb = look.get(ln.b.slot);
    if (!la || !lb) continue;
    for (const u of [0.25, 0.5, 0.75]) add(ln.a.center[0] + (ln.b.center[0] - ln.a.center[0]) * u, ln.a.center[1] + (ln.b.center[1] - ln.a.center[1]) * u, 0.45, 0.5 + flash, mix(la.col, lb.col, u));
  }
  for (const bu of game.bullets) add(bu.x, bu.y, 0.25, 0.6, BULLET);
  const sh = game.ship;
  if (sh) {
    const cx = sh.x + SHIP_W / 2;
    add(cx - 9, sh.y + 1, 0.5, 0.8, ENGINE);
    add(cx + 9, sh.y + 1, 0.5, 0.8, ENGINE);
    if (sh.state === 'charge') {
      const u = Math.min(1, sh.stateT / (S.P.shipCharge / (0.9 + 0.1 * game.difficulty)));
      add(cx, sh.y + SHIP_H, 0.4 + 0.6 * u, 1 + 2 * u, BEAM);
      for (let k = 1; k <= 3; k++) add(sh.beamX, sh.y + SHIP_H + ((S.layout.AH - sh.y - SHIP_H) * k) / 3.5, 0.5, 0.5 * u * (0.5 + 0.5 * Math.sin(t * 20)), RED);
    } else if (sh.state === 'fire') {
      const L = S.layout;
      for (let k = 0; k < 7; k++) add(sh.beamX, sh.y + SHIP_H + ((L.AH - sh.y - SHIP_H) * k) / 6, 0.6, 1.5, BEAM);
    }
  }
  for (const it of game.items) add(it.x, it.y, 0.5, 0.6 + 0.3 * Math.sin(t * 6), POWER_COLORS[it.type]);
  for (const l of game.edgeLasers) {
    const charge = Math.min(1, (t - l.t0) / l.tele);
    const open = game.edgeOpen(l);
    add(l.x0, l.y0, 0.4, 0.4 + charge, LASER);
    if (open > 0) for (let k = 0; k < 5; k++) add(l.x0 + ((l.x1 - l.x0) * (k + 0.5)) / 5, l.y0 + ((l.y1 - l.y0) * (k + 0.5)) / 5, 0.5, 1.5 * open, k % 2 ? LASER : WHITE);
  }
  for (const pp of people) {
    const m = look.get(pp.slot)?.s?.mega;
    if (!m) continue;
    for (let k = 1; k <= 4; k++) add(m.x0 + m.dir[0] * k * 25, m.y0 + m.dir[1] * k * 25, 0.5, 1.4, pp.col);
  }
  for (const bm of game.bombs) {
    if (t - bm.t0 < bm.flight) add(bm.x, bm.y, 0.25, 0.8, BULLET);
    else add(bm.x, bm.y, bm.r, 0.6 + 0.6 * Math.sin(t * 20), RED);
  }
  for (const sc of game.scorches) {
    const u = (t - sc.t0) / 4;
    for (let k = 0; k < 3; k++) add(sc.x, sc.y0 + ((S.layout.AH - sc.y0) * (k + 0.5)) / 3, 0.45, 0.7 * (1 - u), BEAM);
  }
  // the city: the palace, and embers where it burns
  const c = game.city;
  for (const l of c.lights) if (!l.blink || Math.floor(t * 1.5) % 2) add(c.x0 + l.x, l.y, l.r, l.i, l.col);
  let embers = 0;
  for (let k = c.dead.length - 1; k >= 0 && embers < 6; k--) {
    const cell = c.dead[k];
    const age = t - c.deadAt[cell];
    if (age > 2.5) continue;
    embers++;
    add(c.x0 + (cell % c.w), Math.floor(cell / c.w), 0.4, 0.8 * (1 - age / 2.5), ember(1 - age / 2.5));
  }
  if (t < game.alarm) add(c.x0 + c.w / 2, c.h / 2, 1.2, 1.2 * ((game.alarm - t) / 0.5), RED);
  return n;
}

export { ORANGE };
