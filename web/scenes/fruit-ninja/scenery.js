// The scenery: a Japanese moon night, painted as pixel art in layers like a woodblock print. Back to
// front: the sky with the Milky Way, the full moon, a far mountain range with snowy peaks, Mount Fuji,
// a band of mist, hills with a pine line, a castle, a torii and a path of lanterns, the pagoda in front
// of the moon, a second mist band, a lake with the moon's reflection, a red arched bridge, a village
// with lit paper windows and lanterns, and in front a bamboo grove, cherry trees in bloom and the temple
// roof the ninjas stand on. Every layer has its own range of values (far = light and blue, near = dark)
// and a rim of moonlight on the side facing the moon (top left).
//
// The still picture is painted once in blocks of 2 x 2 LEDs (the renderer keeps it as a texture). What
// moves is drawn every frame into the pixel layer, each thing only where its layer shows: twinkling
// stars, clouds, the shimmering reflection, fireflies, birds crossing the moon, cherry petals, a
// shooting star, flickering lanterns (with lights). Dark on purpose: the fruit stays the brightest
// thing on the wall, and the light of the game (juice, blades) falls on the scenery.

import { rgb } from './pix.js';

const hexes = (...h) => h.map(rgb);
const C = {
  sky: hexes('#03030a', '#05050f', '#070715', '#0a081b', '#0e0a22', '#130d2a', '#191033', '#20143c', '#281846'),
  dust: hexes('#0e0b24', '#130f2c'),
  starDim: hexes('#3c3a62', '#4a4672', '#5a4f74'),
  star: hexes('#ffffff', '#d4e2ff', '#ffd8ee'),
  halo: hexes('#2b2154', '#231b4a', '#1c1540', '#161036'),
  moon: hexes('#9c9380', '#b8ae96', '#d3c9b0', '#e8e0ca'),
  moonSea: hexes('#a59c86', '#b4aa92'),
  far: hexes('#1a163a', '#211c48', '#2c2660'),
  farSnow: hexes('#5c6198', '#8389bf'),
  fujiRock: hexes('#17153a', '#201d48', '#2a2858'),
  fujiSnow: hexes('#4a5286', '#6169a0', '#8890c6', '#a7aedc'),
  mist: hexes('#241c48', '#2d2456', '#3c3270'),
  hill: hexes('#0d0b22', '#120f2c', '#1c1842'),
  pine: hexes('#0c0a20', '#1a163c'),
  wall: hexes('#30345a', '#41466f', '#555b88'),
  roof: hexes('#0f0f26', '#16162f', '#2e2f5c'),
  stone: hexes('#1c1a38', '#252347', '#2f2d55'),
  window: hexes('#d08040', '#ffb25a', '#ffd690'),
  gold: hexes('#c08a2c', '#e0b040', '#ffe08a'),
  pagoda: hexes('#0b0a1e', '#121130', '#2c2b5e'),
  torii: hexes('#6a1a34', '#a82a44', '#d64458'),
  mist2: hexes('#161130', '#1d1640', '#2a2154'),
  water: hexes('#06061a', '#0a0a22', '#12123a', '#1a1a46'),
  reflect: hexes('#4a4672', '#7a7494', '#b0a892'),
  reed: hexes('#08071a', '#141232'),
  bridge: hexes('#6e1a34', '#a42a44', '#d84a5c'),
  bridgeRefl: hexes('#3a1028', '#521a34'),
  house: hexes('#0b0a1e', '#13122c', '#22214a'),
  shoji: hexes('#b86a34', '#ffbe6c', '#ffdca0'),
  chochin: hexes('#8a1a24', '#ff4a34', '#ffb04a'),
  cap: rgb('#140c1c'),
  bamboo: hexes('#0a2023', '#0e2c2f', '#15403f', '#22605a'),
  bambooBack: hexes('#081619', '#0c2124'),
  leaf: hexes('#0b2a2a', '#123c3a', '#1d5550'),
  bark: hexes('#0c0716', '#160e24', '#2a1c3e'),
  blossom: hexes('#5a1446', '#8c2a64', '#c04c8a', '#e57fb2', '#ffc0dc', '#ffe8f3'),
  tile: hexes('#05060f', '#0a0c1c', '#111430', '#1c2044'),
  tileEnd: hexes('#0e1028', '#181b3c', '#262a56'),
  ridge: hexes('#141634', '#1d2046', '#303468'),
  cloud: hexes('#0f0b24', '#161030', '#2a2258', '#5e529c'),
  petal: hexes('#ff8cc0', '#ffb8da', '#f070aa'),
  firefly: rgb('#e4ff9a'),
  bird: rgb('#08060f'),
};

/** a small deterministic random generator (the same scenery every time) */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (x, y) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const smooth = (t) => t * t * (3 - 2 * t);
function noise1(x) {
  const i = Math.floor(x);
  const f = x - i;
  return hash(i, 0.5) + (hash(i + 1, 0.5) - hash(i, 0.5)) * smooth(f);
}
function noise2(x, y) {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = smooth(x - i);
  const fy = smooth(y - j);
  const a = hash(i, j) + (hash(i + 1, j) - hash(i, j)) * fx;
  const b = hash(i, j + 1) + (hash(i + 1, j + 1) - hash(i, j + 1)) * fx;
  return a + (b - a) * fy;
}
function fbm1(x, o = 4) {
  let v = 0;
  let a = 0.5;
  let f = 1;
  for (let k = 0; k < o; k++, a *= 0.5, f *= 2.03) v += a * noise1(x * f + k * 13.7);
  return v;
}

// what each block shows, so the moving things stay in their layer
export const LAYER = { SKY: 1, MOON: 2, FAR: 3, MIST: 4, HILL: 5, WATER: 6, NEAR: 7, FRONT: 8 };

/** the canvas: a color per block and the layer it belongs to; y down, in blocks */
class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.col = new Array(w * h).fill(C.sky[0]);
    this.layer = new Uint8Array(w * h);
  }
  set(x, y, c, layer) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || !c) return;
    this.col[y * this.w + x] = c;
    this.layer[y * this.w + x] = layer;
  }
  layerAt(x, y) {
    x = Math.round(x);
    y = Math.round(y);
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? 0 : this.layer[y * this.w + x];
  }
  /** fills a shape given as a mask, coloring it with fn(x, y, litEdge, shadeEdge) */
  shape(x0, y0, x1, y1, inside, fn, layer) {
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(this.h - 1, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(this.w - 1, Math.ceil(x1)); x++) {
        if (!inside(x, y)) continue;
        const lit = !inside(x - 1, y) || !inside(x, y - 1);
        const shade = !inside(x + 1, y) || !inside(x, y + 1);
        this.set(x, y, fn(x, y, lit, shade), layer);
      }
    }
  }
}

export class Scenery {
  constructor() {
    this.key = '';
    this.buf = null;
    this.cv = null;
    this.time = 0;
    this.stars = [];
    this.clouds = [];
    this.petals = [];
    this.flies = [];
    this.birds = null;
    this.nextBirds = 12;
    this.lanterns = [];
    this.shoot = null;
    this.nextShoot = 9;
    this.trees = [];
  }

  /** paints the still picture (when the wall or the layout changed); true if it did */
  build(L) {
    const key = [L.W, L.H, L.S, L.wallW, L.bottom].join();
    if (key === this.key) return false;
    this.key = key;
    const n = Math.max(1, Math.round(L.S / 2)); // LEDs per block
    const kb = (L.ppm * L.S) / n; // blocks per meter
    const bw = Math.ceil(L.W / n);
    const bh = Math.ceil(L.H / n);
    this.n = n;
    this.kb = kb;
    const cv = (this.cv = new Canvas(bw, bh));
    const Y = (m) => bh - m * kb; // height above the floor (m) -> row
    const X = (f) => f * bw;
    const G = { bw, bh, kb, Y, X, r: rng(23) };
    this.lanterns = [];
    this.trees = [];
    this.paintSky(cv, G);
    this.paintMoon(cv, G);
    this.paintFar(cv, G);
    this.paintFuji(cv, G);
    this.paintMist(cv, G, Y(0.66), 3.2, C.mist, 9);
    this.paintHills(cv, G);
    this.paintCastle(cv, G);
    this.paintTorii(cv, G);
    this.paintPagoda(cv, G);
    this.paintMist(cv, G, Y(0.42), 2.4, C.mist2, 6);
    this.paintLake(cv, G);
    this.paintBridge(cv, G);
    this.paintVillage(cv, G);
    this.paintBamboo(cv, G);
    this.paintCherry(cv, G, X(1) - 0.42 * kb, Y(0.11));
    this.paintHangingBranch(cv, G);
    this.paintRoof(cv, G);

    // to the LED picture
    this.buf = new Uint8ClampedArray(L.W * L.H * 4);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const c = cv.col[by * bw + bx];
        for (let j = by * n; j < Math.min(L.H, by * n + n); j++) {
          let i = (j * L.W + bx * n) * 4;
          for (let k = bx * n; k < Math.min(L.W, bx * n + n); k++, i += 4) {
            this.buf[i] = c[0] * 255;
            this.buf[i + 1] = c[1] * 255;
            this.buf[i + 2] = c[2] * 255;
            this.buf[i + 3] = 255;
          }
        }
      }
    }
    this.setupMoving(G);
    return true;
  }

  // ---- the still layers, back to front

  paintSky(cv, G) {
    const { bw, Y, r } = G;
    const horizon = Y(0.62);
    for (let y = 0; y < cv.h; y++) {
      for (let x = 0; x < bw; x++) {
        // stepped bands with wavy borders (no dither)
        const t = Math.max(0, (y + 2.2 * Math.sin(x * 0.045 + y * 0.02) + 1.4 * Math.sin(x * 0.11 + 1)) / horizon);
        const i = Math.max(0, Math.min(C.sky.length - 1, Math.floor(t ** 1.35 * (C.sky.length - 0.6))));
        cv.set(x, y, C.sky[i], LAYER.SKY);
      }
    }
    // the Milky Way: a diagonal band of dust and many faint stars
    const ax = G.X(0.36);
    const bx = G.X(0.9);
    const len = Math.hypot(bx - ax, horizon);
    for (let y = 0; y < horizon; y++) {
      for (let x = Math.floor(ax - 40); x < bx + 40; x++) {
        const d = Math.abs((x - ax) * horizon - y * (bx - ax)) / len;
        const w = 16 + 8 * noise1(x * 0.05);
        if (d > w) continue;
        const nz = noise2(x * 0.09, y * 0.12) * 0.7 + noise2(x * 0.3, y * 0.3) * 0.3;
        const core = 1 - d / w;
        if (nz * core > 0.32) cv.set(x, y, C.dust[nz * core > 0.45 ? 1 : 0], LAYER.SKY);
        if (hash(x, y) > 0.985 - core * 0.04) cv.set(x, y, C.starDim[Math.floor(hash(y, x) * 3)], LAYER.SKY);
      }
    }
    // faint stars everywhere in the sky
    for (let k = 0; k < 260; k++) cv.set(r() * bw, r() * horizon * 0.95, C.starDim[Math.floor(r() * 3)], LAYER.SKY);
  }

  paintMoon(cv, G) {
    const { X, Y, kb } = G;
    const m = (this.moon = { x: Math.round(Math.min(X(0.2), 1.25 * kb)), y: Math.round(Y(1.42)), r: Math.round(0.26 * kb) });
    // a stepped halo
    for (let y = m.y - m.r * 2; y <= m.y + m.r * 2; y++) {
      for (let x = m.x - m.r * 2; x <= m.x + m.r * 2; x++) {
        const d = Math.hypot(x - m.x, y - m.y) / m.r;
        if (d < 1 || d > 1.85) continue;
        cv.set(x, y, C.halo[d < 1.12 ? 0 : d < 1.3 ? 1 : d < 1.55 ? 2 : 3], LAYER.SKY);
      }
    }
    // the disc: lit at the top left, a crescent of shade at the bottom right, seas and craters
    const craters = [
      [-0.45, -0.2, 0.12],
      [0.3, 0.45, 0.09],
      [0.5, -0.35, 0.07],
      [-0.15, 0.55, 0.1],
      [0.05, -0.62, 0.06],
    ];
    for (let y = m.y - m.r; y <= m.y + m.r; y++) {
      for (let x = m.x - m.r; x <= m.x + m.r; x++) {
        const dx = (x - m.x) / m.r;
        const dy = (y - m.y) / m.r;
        const d = Math.hypot(dx, dy);
        if (d > 1) continue;
        const toward = (-dx - dy) / Math.SQRT2; // towards the top left
        let c = d > 0.93 && toward < -0.2 ? C.moon[0] : toward < -0.55 + 0.3 * (1 - d) ? C.moon[1] : toward > 0.45 && d > 0.55 ? C.moon[3] : C.moon[2];
        const sea = noise2(dx * 2.6 + 4, dy * 2.6 + 1) * 0.65 + noise2(dx * 6 + 9, dy * 6) * 0.35;
        if (sea > 0.58 && d < 0.9) c = sea > 0.68 ? C.moonSea[0] : C.moonSea[1];
        for (const [cx, cy, cr] of craters) {
          const e = Math.hypot(dx - cx, dy - cy) / cr;
          if (e < 1) c = e > 0.7 ? (dx - cx + dy - cy < 0 ? C.moonSea[0] : C.moon[3]) : C.moonSea[1];
        }
        cv.set(x, y, c, LAYER.MOON);
      }
    }
  }

  paintFar(cv, G) {
    const { bw, Y } = G;
    const base = Y(0.6);
    const ridge = (x) => Y(0.78 + 0.28 * fbm1(x * 0.011 + 3) + 0.12 * Math.max(0, fbm1(x * 0.03 + 9) - 0.45));
    const inside = (x, y) => y >= ridge(x) && y <= base + 30;
    cv.shape(0, Y(1.25), bw - 1, base + 30, inside, (x, y, lit) => {
      const top = ridge(x);
      const slope = ridge(x + 2) - ridge(x - 2); // > 0: falling to the right, facing the moon
      if (top < Y(0.98) && y < top + 3 + 4 * noise1(x * 0.4)) return slope > 0 ? C.farSnow[1] : C.farSnow[0];
      if (lit) return C.far[2];
      return slope > 0.3 ? C.far[1] : C.far[0];
    }, LAYER.FAR);
  }

  paintFuji(cv, G) {
    const { X, Y, kb } = G;
    const fx = X(0.6);
    const peak = Y(1.24);
    const base = Y(0.6);
    const hw = 2.3 * kb;
    const top = (x) => {
      const u = Math.min(1, Math.abs(x - fx) / hw);
      const crater = Math.abs(x - fx) < 0.09 * kb ? 1.5 + Math.sin(x * 1.3) : 0;
      return base - (base - peak) * (1 - u) ** 1.75 + crater;
    };
    const inside = (x, y) => y >= top(x) && y <= base + 30;
    cv.shape(fx - hw, peak - 2, fx + hw, base + 30, inside, (x, y, lit) => {
      const dx = (x - fx) / kb; // m
      const h = (base - y) / (base - peak); // 0 at the base, 1 at the top
      // the snow line runs down in tongues along the gullies
      const a = Math.atan2(dx, (y - peak) / kb + 0.05);
      const gully = Math.sin(a * 38 + 2 * Math.sin(a * 7));
      const line = 0.6 - 0.12 * gully - 0.05 * noise1(x * 0.5);
      const right = dx > 0.02 * Math.sin(y * 0.7);
      if (h > line) {
        if (gully > 0.55 && h < 0.92) return right ? C.fujiSnow[0] : C.fujiSnow[1];
        if (lit && !right) return C.fujiSnow[3];
        return right ? C.fujiSnow[1] : C.fujiSnow[2];
      }
      if (lit && !right) return C.fujiRock[2];
      if (gully > 0.7 && h > line - 0.12) return right ? C.fujiSnow[0] : C.fujiSnow[1];
      return right ? C.fujiRock[0] : C.fujiRock[1];
    }, LAYER.FAR);
  }

  /** a band of mist as in woodblock prints: a scalloped top edge, a line inside */
  paintMist(cv, G, row, height, pal, scallop) {
    const { bw, kb } = G;
    const h = height * 0.1 * kb;
    const top = (x) => row - Math.abs(Math.sin((x / scallop) * Math.PI * 0.5 + noise1(x * 0.02) * 3)) * 3 - noise1(x * 0.013) * 4;
    const inside = (x, y) => y >= top(x) && y <= row + h;
    cv.shape(0, row - 8, bw - 1, row + h, inside, (x, y, lit) => {
      if (lit || y - top(x) < 1) return pal[2];
      if (Math.abs(y - top(x) - 3.2) < 0.6) return pal[1];
      return pal[0];
    }, LAYER.MIST);
  }

  paintHills(cv, G) {
    const { bw, Y, X, r } = G;
    const castle = X(0.79);
    const torii = X(0.45);
    this.hillTop = (x) => Y(0.5 + 0.1 * fbm1(x * 0.009 + 21) + 0.13 * Math.exp(-(((x - castle) / 34) ** 2)) + 0.05 * Math.exp(-(((x - torii) / 20) ** 2)));
    const inside = (x, y) => y >= this.hillTop(x);
    cv.shape(0, Y(0.8), bw - 1, cv.h - 1, inside, (x, y, lit) => (lit ? C.hill[2] : noise2(x * 0.15, y * 0.2) > 0.72 ? C.hill[1] : C.hill[0]), LAYER.HILL);
    // pines along the top in two rows: small ones behind, bigger ones in front; tiers lit on the left
    const pine = (x, base, h, front) => {
      const tiers = 3;
      for (let t = 0; t < tiers; t++) {
        const ty = base - h + (t * h) / tiers;
        const th = h / tiers + 2;
        for (let k = 0; k < th; k++) {
          const w = Math.round(((k + 1) / th) * (1.6 + t * 1.1));
          for (let i = -w; i <= w; i++) cv.set(x + i, ty + k, i === -w || k === 0 ? C.pine[1] : front ? C.pine[0] : C.hill[1], LAYER.HILL);
        }
      }
      cv.set(x, base, C.pine[0], LAYER.HILL);
    };
    for (const front of [false, true]) {
      for (let x = front ? 2 : 0; x < bw; x += (front ? 6 : 4) + Math.floor(r() * 5)) {
        if (Math.abs(x - castle) < 24 || Math.abs(x - torii) < 11) continue;
        pine(x, this.hillTop(x) + (front ? 3 : 1), front ? 9 + Math.floor(r() * 7) : 6 + Math.floor(r() * 4), front);
      }
    }
    // a path of lanterns zigzagging up to the castle
    for (let k = 0; k < 7; k++) {
      const x = castle - 26 + (k % 2 ? 10 : 0) + k * 3;
      const y = Y(0.3) - k * ((Y(0.3) - this.hillTop(castle) - 6) / 7);
      cv.set(x, y, C.window[1], LAYER.HILL);
      this.lanterns.push({ x: Math.round(x), y: Math.round(y), i: 0.12, r: 0.12, small: true });
    }
  }

  paintCastle(cv, G) {
    const { X, kb } = G;
    const cx = Math.round(X(0.79));
    const ground = Math.round(this.hillTop(cx));
    const set = (x, y, c) => cv.set(x, y, c, LAYER.HILL);
    // the stone base: sloped walls with a pattern of blocks
    const bh = Math.round(0.1 * kb);
    const baseTop = ground - bh;
    cv.shape(cx - 22, baseTop, cx + 22, ground + 2, (x, y) => y >= baseTop && Math.abs(x - cx) <= 15 + ((y - baseTop) / bh) * 6, (x, y, lit) => {
      if (lit) return C.stone[2];
      return (y + (Math.floor((x + (y % 2) * 2) / 4) % 2)) % 3 === 0 ? C.stone[0] : C.stone[1];
    }, LAYER.HILL);
    // three tiers: white walls with lit windows, dark roofs with turned-up eaves, gables
    let y = baseTop;
    [
      [14, 9],
      [11, 8],
      [8, 7],
    ].forEach(([hw, h], i) => {
      const wallTop = y - h;
      cv.shape(cx - hw, wallTop, cx + hw, y, (x, yy) => Math.abs(x - cx) <= hw && yy >= wallTop && yy < y, (x, yy, lit, shade) => {
        if ((yy - wallTop) % 4 === 2 && Math.abs(x - cx) % 4 === 1 && Math.abs(x - cx) < hw - 1) return hash(x, yy) > 0.35 ? C.window[1] : C.window[0];
        return lit ? C.wall[2] : shade || x > cx + hw * 0.3 ? C.wall[0] : C.wall[1];
      }, LAYER.HILL);
      const rw = hw + 4;
      for (let k = -rw; k <= rw; k++) {
        const lift = Math.round((Math.abs(k) / rw) ** 3 * 2.5);
        for (let t = 0; t < 3; t++) set(cx + k, wallTop - t - lift + 1, t === 2 ? C.roof[2] : C.roof[t === 1 ? 1 : 0]);
      }
      if (i < 2) for (let t = 0; t < 5; t++) for (let k = -t; k <= t; k++) set(cx + k, wallTop - 6 + t, Math.abs(k) === t ? C.roof[2] : C.roof[0]);
      y = wallTop - 3;
    });
    // the top roof with golden fish (shachihoko) at both ends
    for (let k = -9; k <= 9; k++) for (let t = 0; t < 3; t++) set(cx + k, y - t + (Math.abs(k) > 6 ? 1 : 0), t === 2 ? C.roof[2] : C.roof[0]);
    for (const s of [-1, 1]) {
      set(cx + s * 8, y - 3, C.gold[1]);
      set(cx + s * 8, y - 4, C.gold[2]);
      set(cx + s * 9, y - 4, C.gold[0]);
    }
  }

  paintTorii(cv, G) {
    const cx = Math.round(G.X(0.45));
    const g = Math.round(this.hillTop(cx));
    const set = (x, y, c) => cv.set(x, y, c, LAYER.HILL);
    for (const s of [-1, 1]) for (let y = g - 13; y <= g; y++) set(cx + s * 5, y, s < 0 ? C.torii[2] : C.torii[1]);
    for (let k = -8; k <= 8; k++) {
      const lift = Math.abs(k) > 6 ? 1 : 0;
      set(cx + k, g - 15 - lift, C.torii[2]);
      set(cx + k, g - 14 - lift, C.torii[1]);
    }
    for (let k = -6; k <= 6; k++) set(cx + k, g - 10, C.torii[1]);
    set(cx, g - 12, C.torii[0]);
    set(cx, g - 11, C.torii[0]);
    // two stone lanterns
    for (const s of [-1, 1]) {
      set(cx + s * 9, g - 1, C.stone[1]);
      set(cx + s * 9, g - 2, C.window[1]);
      set(cx + s * 9, g - 3, C.stone[2]);
      this.lanterns.push({ x: cx + s * 9, y: g - 2, i: 0.15, r: 0.15, small: true });
    }
  }

  paintPagoda(cv, G) {
    const m = this.moon;
    const cx = Math.round(m.x + 0.22 * G.kb);
    let y = Math.round(this.hillTop(cx)) + 2;
    const set = (x, yy, c) => cv.set(x, yy, c, LAYER.HILL);
    for (let i = 0; i < 5; i++) {
      const hw = Math.round(11 - i * 1.5);
      const wallTop = y - (12 - i);
      for (let yy = wallTop; yy < y; yy++) {
        for (let k = -hw; k <= hw; k++) {
          const edge = Math.abs(k) === hw;
          let c = edge ? C.pagoda[1] : C.pagoda[0];
          if (Math.abs(k) <= 1 && yy > wallTop + 3 && yy < y - 3 && i < 4) c = C.window[(yy + i) % 3 === 0 ? 2 : 1];
          if ((yy === y - 2 || yy === y - 3) && Math.abs(k) % 2 === 0 && !edge) c = C.pagoda[1]; // the railing
          set(cx + k, yy, c);
        }
      }
      // the roof: wide eaves, tips turned up, moonlight on the top edge
      const rw = Math.round(hw + 7 - i * 0.6);
      for (let k = -rw; k <= rw; k++) {
        const u = Math.abs(k) / rw;
        const lift = Math.round(u ** 3.2 * 4);
        const thick = 2 + (u < 0.6 ? 1 : 0);
        for (let t = 0; t < thick; t++) set(cx + k, wallTop - t - lift, t === thick - 1 ? (k < 0 ? C.pagoda[2] : C.pagoda[1]) : C.pagoda[0]);
      }
      // lanterns hanging at the roof tips of the lower tiers
      if (i < 3) {
        for (const s of [-1, 1]) {
          const lx = cx + s * (rw - 1);
          set(lx, wallTop, C.chochin[1]);
          set(lx, wallTop + 1, C.chochin[0]);
          this.lanterns.push({ x: lx, y: wallTop, i: 0.22, r: 0.2 });
        }
      }
      y = wallTop - 3;
    }
    // the spire (sorin) with its rings
    for (let k = 0; k < 22; k++) {
      set(cx, y - k, C.pagoda[k < 18 ? 0 : 1]);
      if (k > 3 && k < 16 && k % 2 === 0) {
        set(cx - 1, y - k, C.pagoda[0]);
        set(cx + 1, y - k, C.pagoda[0]);
      }
    }
  }

  paintLake(cv, G) {
    const { X, Y } = G;
    const top = Math.round(Y(0.36));
    const bottom = Math.round(Y(0.12));
    const x1 = X(0.5);
    this.water = { top, bottom };
    for (let y = top; y <= bottom; y++) {
      for (let x = 0; x < x1 + (bottom - y) * 0.8; x++) {
        const d = (y - top) / (bottom - top);
        let c = d < 0.25 ? C.water[1] : C.water[0];
        // ripples: short light dashes, longer towards the front
        if (noise2(x * (0.18 - d * 0.1), y * 1.7) > 0.74) c = C.water[2];
        if (y === top) c = C.water[3];
        cv.set(x, y, c, LAYER.WATER);
      }
    }
    // the moon in the water: a column of broken streaks (it shimmers in draw())
    const m = this.moon;
    for (let y = top + 1; y <= bottom; y++) {
      const w = 3 + (y - top) * 0.45;
      for (let x = Math.round(m.x - w); x <= m.x + w; x++) {
        const k = noise2(x * 0.35, y * 1.3);
        if (k > 0.55) cv.set(x, y, C.reflect[k > 0.72 ? 1 : 0], LAYER.WATER);
      }
    }
    // reeds along the left shore
    for (let x = 4; x < X(0.12); x += 2 + Math.floor(hash(x, 3) * 3)) {
      const h = 3 + Math.floor(hash(x, 7) * 6);
      for (let k = 0; k < h; k++) cv.set(x + (k > h - 2 ? 1 : 0), bottom - k, C.reed[k === h - 1 ? 1 : 0], LAYER.NEAR);
    }
  }

  paintBridge(cv, G) {
    const cx = G.X(0.36);
    const hw = 0.3 * G.kb;
    const water = this.water.top + 4;
    const arch = (x) => water - 11 * Math.sqrt(Math.max(0, 1 - ((x - cx) / hw) ** 2));
    for (let x = Math.floor(cx - hw); x <= cx + hw; x++) {
      const y = Math.round(arch(x));
      // deck and railing
      cv.set(x, y, C.bridge[2], LAYER.NEAR);
      cv.set(x, y + 1, C.bridge[1], LAYER.NEAR);
      cv.set(x, y + 2, C.bridge[0], LAYER.NEAR);
      cv.set(x, y - 4, C.bridge[2], LAYER.NEAR);
      if (Math.round(x - cx) % 5 === 0) for (let k = 1; k < 4; k++) cv.set(x, y - k, C.bridge[1], LAYER.NEAR);
      // its reflection, broken by the ripples
      const ry = water + (water - y) + 2;
      if (ry < this.water.bottom && noise2(x * 0.4, ry) > 0.35) cv.set(x, ry, C.bridgeRefl[1], LAYER.WATER);
      if (ry + 3 < this.water.bottom && noise2(x * 0.4, ry + 3) > 0.5) cv.set(x, ry + 3, C.bridgeRefl[0], LAYER.WATER);
    }
    for (const s of [-1, 1]) {
      const x = Math.round(cx + s * hw);
      const ly = Math.round(arch(x)) - 6;
      for (let y = ly + 1; y <= water + 1; y++) cv.set(x, y, C.bridge[s < 0 ? 2 : 0], LAYER.NEAR);
      cv.set(x, ly, C.chochin[2], LAYER.NEAR);
      this.lanterns.push({ x, y: ly, i: 0.2, r: 0.18 });
    }
  }

  paintVillage(cv, G) {
    const { X, Y, r } = G;
    let x = Math.round(X(0.5));
    const end = X(0.86);
    const ground = Math.round(Y(0.12));
    while (x < end) {
      const w = 12 + Math.floor(r() * 10);
      const h = 9 + Math.floor(r() * 6);
      const wallTop = ground - h;
      const lit = r() < 0.8;
      // walls with paper windows (a lattice of 3 blocks)
      for (let y = wallTop; y <= ground; y++) {
        for (let k = 0; k < w; k++) {
          let c = k === 0 ? C.house[1] : C.house[0];
          const wx = k - Math.floor(w / 2) + 3;
          if (lit && wx >= 0 && wx < 6 && y > wallTop + 2 && y < wallTop + 7) c = wx % 3 === 2 || (y - wallTop) % 3 === 2 ? C.shoji[0] : C.shoji[y - wallTop < 4 ? 2 : 1];
          cv.set(x + k, y, c, LAYER.NEAR);
        }
      }
      // the tiled roof: wider than the house, the ridge lit on top
      const rh = 5;
      for (let t = 0; t < rh; t++) {
        const inset = Math.round(t * 1.2);
        for (let k = -2 + inset; k < w + 2 - inset; k++) cv.set(x + k, wallTop - 1 - t, t === rh - 1 ? C.house[2] : (k + t) % 3 === 0 ? C.house[1] : C.house[0], LAYER.NEAR);
      }
      // a red lantern at the door
      if (r() < 0.6) {
        const lx = x + w - 3;
        const ly = wallTop + 3;
        cv.set(lx, ly - 1, C.cap, LAYER.NEAR);
        cv.set(lx, ly, C.chochin[1], LAYER.NEAR);
        cv.set(lx, ly + 1, C.chochin[1], LAYER.NEAR);
        cv.set(lx, ly + 2, C.cap, LAYER.NEAR);
        this.lanterns.push({ x: lx, y: ly, i: 0.25, r: 0.2 });
      }
      x += w + 2 + Math.floor(r() * 4);
    }
  }

  paintBamboo(cv, G) {
    const { r, kb } = G;
    const set = (x, y, c) => cv.set(x, y, c, LAYER.FRONT);
    // back stalks thin and dark; front stalks thick, lit, with nodes and leaves
    for (const [x0, w, back] of [
      [3, 2, true],
      [11, 2, true],
      [20, 2, true],
      [6, 4, false],
      [16, 4, false],
      [27, 3, false],
      [34, 2, true],
    ]) {
      const lean = (r() - 0.3) * 0.06;
      const node0 = Math.floor(r() * 20);
      for (let y = 0; y < cv.h; y++) {
        const x = Math.round(x0 + lean * (cv.h - y));
        const node = (y + node0) % 24 === 0;
        for (let k = 0; k < w; k++) set(x + k, y, back ? C.bambooBack[k === 0 ? 1 : 0] : node ? C.bamboo[3] : k === 0 ? C.bamboo[2] : k === w - 1 ? C.bamboo[0] : C.bamboo[1]);
        if (!back && node && y < cv.h - 30 && r() < 0.8) {
          // a twig with long leaves hanging down
          const dir = r() < 0.6 ? 1 : -1;
          const nl = 2 + Math.floor(r() * 3);
          for (let l = 0; l < nl; l++) {
            const len = 0.09 * kb + r() * 0.06 * kb;
            const ang = (0.35 + r() * 0.6) * dir;
            for (let s = 0; s < len; s++) {
              const lx = x + w / 2 + Math.sin(ang) * s * 1.1;
              const ly = y + 2 + l * 2 + Math.cos(ang) * s * 0.55;
              set(lx, ly, s < 2 ? C.leaf[0] : s > len - 3 ? C.leaf[2] : C.leaf[1]);
              if (s > 1 && s < len - 2) set(lx, ly + 1, C.leaf[0]);
            }
          }
        }
      }
    }
  }

  /**
   * A crown of flowers: each cluster is a puff of a few round lobes, filled with single flowers in
   * three passes: dark ones at the back (drawn before the branches, so the bark shows in front of them),
   * then the middle, then light ones at the top left of each lobe.
   */
  crownLobes(r, clusters) {
    const lobes = [];
    for (const [cx, cy, R] of clusters) {
      const n = 3 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) {
        const a = r() * Math.PI * 2;
        const d = R * 0.55 * Math.sqrt(r());
        lobes.push([cx + Math.cos(a) * d * 1.2, cy + Math.sin(a) * d * 0.7 - R * 0.15, R * (0.45 + r() * 0.3)]);
      }
    }
    return lobes;
  }
  paintFlowers(cv, r, lobes, pass) {
    for (const [cx, cy, R] of lobes) {
      const nF = Math.round(R * R * (pass === 0 ? 1.1 : pass === 1 ? 0.55 : 0.22));
      for (let k = 0; k < nF; k++) {
        const a = r() * Math.PI * 2;
        const d = Math.sqrt(r()) * R;
        const fx = cx + Math.cos(a) * d;
        const fy = cy + Math.sin(a) * d * 0.85;
        const lit = (cx - fx + (cy - fy) * 1.2) / R; // > 0: towards the top left of the lobe
        if (pass === 2 && lit < 0.1) continue;
        if (pass === 1 && lit < -0.55) continue;
        const tone = pass === 0 ? (lit > 0.3 ? 1 : 0) : pass === 1 ? (lit > 0.25 ? 3 : 2) : lit > 0.5 ? 4 : 3;
        this.flower(cv, fx, fy, tone, pass === 2 && r() < 0.5);
      }
    }
  }

  /** one flower: petals around a light center (a plus with a soft corner) */
  flower(cv, x, y, tone, big) {
    const P = C.blossom;
    const set = (dx, dy, c) => cv.set(x + dx, y + dy, c, LAYER.FRONT);
    set(0, 0, P[Math.min(5, tone + 1)]);
    set(-1, 0, P[tone]);
    set(1, 0, P[tone]);
    set(0, -1, P[tone]);
    set(0, 1, P[Math.max(0, tone - 1)]);
    if (big) {
      set(-1, -1, P[tone]);
      set(1, 1, P[Math.max(0, tone - 1)]);
    }
  }

  /**
   * The cherry tree at the right edge, the way pixel artists paint foliage: a gnarled trunk that forks
   * into four limbs with twigs, and a dome of round blossom clumps. Clumps at the back are dark (the
   * shade inside the crown), then the bark, then the clumps in front, each with a light cap at the top
   * left, a crescent of shade at the bottom right and a few single flowers on the light side; lower
   * clumps overlap upper ones. Gaps under the crown show the limbs, strands of blossoms hang down, and
   * fallen petals lie on the roof below.
   */
  paintCherry(cv, G, baseX, baseY) {
    const { kb, r } = G;
    const s = kb / 84; // the tree was drawn for 84 blocks per meter
    const P = (x, y) => [baseX + x * s, baseY + y * s];
    // the branches as capsules [x0, y0, x1, y1, r0, r1] (blocks), from the trunk out
    const caps = [];
    const limb = (a, b, r0, r1) => caps.push([...P(...a), ...P(...b), r0 * s, r1 * s]);
    limb([0, 0], [-7, -38], 6.5, 5);
    limb([-7, -38], [-3, -66], 5, 4.2);
    limb([-3, -66], [-34, -95], 3.6, 2.2); // to the left
    limb([-34, -95], [-70, -112], 2.2, 1.1);
    limb([-3, -66], [-18, -110], 3.2, 2);
    limb([-18, -110], [-26, -136], 2, 0.9);
    limb([-3, -66], [16, -108], 3, 1.9); // up to the right
    limb([16, -108], [24, -134], 1.9, 0.9);
    limb([-3, -66], [32, -92], 2.6, 1.5); // out to the right edge
    limb([32, -92], [52, -104], 1.5, 0.8);
    limb([-52, -104], [-62, -126], 1.2, 0.6); // twigs
    limb([-18, -110], [-36, -130], 1.2, 0.6);
    limb([16, -108], [4, -126], 1.1, 0.6);
    limb([-34, -95], [-44, -84], 1.1, 0.6);
    const dist = (x, y, c) => {
      const dx = c[2] - c[0];
      const dy = c[3] - c[1];
      const h = Math.min(1, Math.max(0, ((x - c[0]) * dx + (y - c[1]) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(x - c[0] - dx * h, y - c[1] - dy * h) - (c[4] + (c[5] - c[4]) * h);
    };

    // the crown: a dome over the limbs, filled with clumps; fewer at the bottom middle (gaps)
    const [cx, cy] = P(-14, -108);
    const rx = 70 * s;
    const ry = 36 * s;
    const inDome = (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
    const clumps = (n, rmin, rmax, lift) => {
      const out = [];
      for (let k = 0; k < n * 6 && out.length < n; k++) {
        const x = cx + (r() * 2 - 1) * rx;
        const y = cy + (r() * 2 - 1) * ry - lift;
        if (!inDome(x, y + lift)) continue;
        // keep the underside open in the middle, where the limbs come up
        if (y > cy + ry * 0.35 && Math.abs(x - cx) < rx * 0.35 && r() < 0.8) continue;
        out.push([x, y, (rmin + r() * (rmax - rmin)) * s]);
      }
      return out.sort((a, b) => a[1] - b[1]); // the upper first: lower clumps overlap them
    };
    const back = clumps(34, 7, 11, 5);
    const front = clumps(60, 5, 8.5, 2);
    // strands hanging from the lower edge
    const strands = [];
    for (let k = 0; k < 9; k++) {
      const a = Math.PI * (0.15 + 0.7 * r());
      strands.push([cx - Math.cos(a) * rx * 0.9, cy + Math.sin(a) * ry * 0.85, 3 + Math.floor(r() * 7)]);
    }

    const clump = (c, dark) => this.clump(cv, r, c[0], c[1], c[2], dark);
    for (const c of back) clump(c, true);
    // the bark: a lit edge at the left, furrows along the trunk
    const inside = (x, y) => caps.some((c) => dist(x, y, c) < 0);
    const xs = caps.flatMap((c) => [c[0], c[2]]);
    const ys = caps.flatMap((c) => [c[1], c[3]]);
    cv.shape(Math.min(...xs) - 8, Math.min(...ys) - 8, Math.max(...xs) + 8, Math.max(...ys) + 2, inside, (x, y, lit, shade) => {
      if (lit) return C.bark[2];
      if (shade) return C.bark[0];
      return noise2(x * 0.7, y * 0.1) > 0.6 ? C.bark[0] : C.bark[1];
    }, LAYER.FRONT);
    for (const c of front) clump(c, false);
    for (const [x, y, n] of strands) {
      for (let k = 0; k < n; k++) {
        const fx = x + Math.sin(k * 0.8) * 0.6;
        cv.set(fx, y + k, C.blossom[k % 3 === 0 ? 4 : 2], LAYER.FRONT);
        if (k % 3 === 1) cv.set(fx - 1, y + k, C.blossom[3], LAYER.FRONT);
      }
    }
    // fallen petals on the roof below the tree (painted with the roof)
    this.fallen = Array.from({ length: 40 }, () => [baseX + (r() - 0.6) * 90 * s, r() * 3, C.blossom[r() < 0.5 ? 3 : 4]]);
    this.trees.push({ clusters: front });
  }

  /**
   * One clump of blossoms: an organic round outline, a round light cap at the top left, a crescent of
   * shade at the bottom right (outside a circle shifted to the top left), single flowers on the light
   * side and a few petals sticking out of the rim. dark: a clump inside the crown, in shade.
   */
  clump(cv, r, x0, y0, R, dark) {
    const B = C.blossom; // dark .. light: #5a1446 .. #ffe8f3
    const ph0 = r() * 6.28;
    const ph1 = r() * 6.28;
    const set = (x, y, c) => cv.set(x, y, c, LAYER.FRONT);
    for (let y = Math.floor(y0 - R - 1); y <= y0 + R + 1; y++) {
      for (let x = Math.floor(x0 - R - 1); x <= x0 + R + 1; x++) {
        const dx = x - x0;
        const dy = y - y0;
        const a = Math.atan2(dy, dx);
        const edge = R * (0.9 + 0.07 * Math.sin(a * 3 + ph0) + 0.05 * Math.sin(a * 7 + ph1));
        if (Math.hypot(dx, dy * 1.08) > edge) continue;
        const body = Math.hypot(dx + 0.2 * R, dy + 0.22 * R) / R; // > ~0.8: the shaded crescent
        const cap = Math.hypot(dx + 0.36 * R, dy + 0.4 * R) / R; // < ~0.45: the light cap
        let tone;
        if (dark) tone = body > 0.85 ? 0 : 1;
        else tone = body > 0.95 ? 1 : body > 0.8 ? 2 : cap < 0.45 ? 4 : 3;
        set(x, y, B[tone]);
      }
    }
    if (dark) return;
    for (let k = 0; k < Math.round(R * 0.8); k++) {
      const a = Math.PI * (0.9 + r() * 0.85);
      const d = R * (0.3 + r() * 0.5);
      const fx = Math.round(x0 + Math.cos(a) * d);
      const fy = Math.round(y0 + Math.sin(a) * d);
      set(fx, fy, B[5]);
      set(fx - 1, fy, B[4]);
      set(fx + 1, fy, B[4]);
      set(fx, fy - 1, B[4]);
    }
    for (let k = 0; k < Math.round(R * 0.7); k++) {
      const a = r() * Math.PI * 2;
      const rim = R * 1.02;
      set(x0 + Math.cos(a) * rim, y0 + Math.sin(a) * rim, B[Math.sin(a) < 0 && Math.cos(a) < 0.3 ? 3 : 2]);
    }
  }

  /** a branch hanging in from the top edge beside the moon: a twig with side twigs, puffs at their ends */
  paintHangingBranch(cv, G) {
    const { r, kb } = G;
    const m = this.moon;
    const twig = (x, y, dx, dy, n, thick, out) => {
      for (let k = 0; k < n; k++) {
        x += dx + Math.sin(k * 0.7) * 0.3;
        y += dy + k * 0.015;
        cv.set(x, y, k % 4 === 0 ? C.bark[2] : C.bark[1], LAYER.FRONT);
        if (thick && k < n * 0.6) cv.set(x, y - 1, C.bark[2], LAYER.FRONT);
        out.push([x, y]);
      }
      return [x, y];
    };
    const main = [];
    const end = twig(m.x + 0.75 * kb, -1, -1.05, 0.62, 44, true, main);
    const clusters = [[end[0], end[1] + 1, 6]];
    for (const k of [12, 22, 32]) {
      const side = [];
      const e = twig(main[k][0], main[k][1], -0.5 - r() * 0.4, 0.8, 9 + Math.floor(r() * 6), false, side);
      clusters.push([e[0], e[1] + 1, 4 + r() * 2]);
      clusters.push([main[k][0] + 2, main[k][1] - 1, 3.5 + r()]);
    }
    clusters.sort((a, b) => a[1] - b[1]);
    for (const c of clusters) this.clump(cv, r, c[0], c[1], c[2] + 0.5, false);
    this.trees.push({ clusters });
  }

  /** the ridge of the temple roof along the bottom: tiles, round tile ends, golden fish at the ends */
  paintRoof(cv, G) {
    const { bw, bh, kb } = G;
    const top = Math.round(bh - 0.11 * kb);
    for (let y = top; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const d = y - top;
        let c;
        if (d === 0) c = C.ridge[2];
        else if (d < 3) c = x % 6 === 0 ? C.ridge[0] : C.ridge[1];
        else if (d === 3) c = C.tile[0];
        else if (y >= bh - 4) {
          // the round tile ends
          const u = x % 6;
          const v = y - (bh - 4);
          const ring = Math.hypot(u - 2.5, v - 1.5);
          c = ring < 1.2 ? C.tileEnd[2] : ring < 2.4 ? (u + v < 4 ? C.tileEnd[1] : C.tileEnd[0]) : C.tile[0];
        } else c = x % 6 === 0 ? C.tile[0] : x % 6 === 1 ? C.tile[3] : x % 6 < 4 ? C.tile[2] : C.tile[1];
        cv.set(x, y, c, LAYER.FRONT);
      }
    }
    for (const [x, dy, c] of this.fallen ?? []) cv.set(x, top + 1 + dy, c, LAYER.FRONT);
    // shachihoko: golden fish at both ends of the ridge, the tail curled up
    const fish = ['..##', '.#.#', '#...', '##..', '###.', '.###', '..##'];
    for (const s of [-1, 1]) {
      const x0 = s < 0 ? 2 : bw - 6;
      fish.forEach((row, j) => {
        [...row].forEach((ch, i) => {
          if (ch === '#') cv.set(s < 0 ? x0 + i : x0 + 3 - i, top - fish.length + j, j < 2 ? C.gold[2] : (i + j) % 3 === 0 ? C.gold[0] : C.gold[1], LAYER.FRONT);
        });
      });
    }
  }

  // ---- what moves

  setupMoving(G) {
    const { bw, Y, r } = G;
    const cv = this.cv;
    // bright stars that twinkle, where the sky shows
    this.stars = [];
    for (let k = 0; k < 600 && this.stars.length < 70; k++) {
      const x = Math.floor(r() * bw);
      const y = Math.floor(r() * Y(0.9));
      if (cv.layerAt(x, y) !== LAYER.SKY || Math.hypot(x - this.moon.x, y - this.moon.y) < this.moon.r * 2) continue;
      this.stars.push({ x, y, ph: r() * 6.28, f: 0.5 + r() * 2.2, big: r() < 0.15, col: C.star[Math.floor(r() * 3)] });
    }
    // clouds: long bands with a lit, scalloped top, rasterized once
    this.clouds = [0, 1, 2, 3].map((k) => {
      const len = 40 + Math.floor(r() * 50);
      const blocks = [];
      for (let x = 0; x < len; x++) {
        const th = Math.round(1 + 3 * Math.sin((Math.PI * x) / len) + Math.abs(Math.sin(x * 0.45)) * 1.5);
        for (let y = -th; y <= 1; y++) blocks.push([x, y, y === -th ? 3 : y === 1 ? 0 : y === -th + 1 ? 2 : 1]);
      }
      return { x: r() * bw, y: Y(1.35 + k * 0.13 + r() * 0.05), blocks, v: 0.6 + r() * 0.9 };
    });
    // fireflies over the lake and in the bamboo
    this.flies = Array.from({ length: 16 }, () => ({ x: r() * G.X(0.5), y: Y(0.15 + r() * 0.5), ph: r() * 6.28, sp: 0.5 + r() }));
    this.petals = [];
  }

  step(dt, L, P) {
    this.time += dt;
    if (!this.cv) return;
    const { w: bw, h: bh } = this.cv;
    for (const c of this.clouds) {
      c.x += c.v * dt;
      if (c.x > bw + 5) c.x = -100;
    }
    // petals from the crowns, blown to the left across the wall (blocks per second)
    const want = Math.round(P.petals);
    const crowns = this.trees.flatMap((t) => t.clusters);
    while (this.petals.length < want && crowns.length) {
      const c = crowns[Math.floor(Math.random() * crowns.length)];
      this.petals.push({ x: c[0], y: c[1], vx: -(4 + Math.random() * 10), vy: 2 + Math.random() * 6, ph: Math.random() * 6.28, col: C.petal[Math.floor(Math.random() * 3)] });
    }
    if (this.petals.length > want) this.petals.length = want;
    for (const q of this.petals) {
      q.x += (q.vx + Math.sin(this.time * 1.3 + q.ph) * 4) * dt;
      q.y += (q.vy + Math.cos(this.time * 2.1 + q.ph) * 3) * dt;
      if (q.y > bh - 2 || q.x < -2) {
        const c = crowns[Math.floor(Math.random() * crowns.length)];
        q.x = c[0];
        q.y = c[1];
      }
    }
    for (const f of this.flies) {
      f.x += Math.sin(this.time * 0.4 * f.sp + f.ph) * 3 * dt;
      f.y += Math.cos(this.time * 0.6 * f.sp + f.ph * 2) * 2 * dt;
    }
    // now and then a flock of birds crosses the sky
    this.nextBirds -= dt;
    if (this.nextBirds <= 0 && P.birds) {
      this.nextBirds = 18 + Math.random() * 20;
      const dir = Math.random() < 0.5 ? 1 : -1;
      this.birds = { x: dir > 0 ? -10 : bw + 10, y: this.moon.y + (Math.random() - 0.4) * this.moon.r * 2, v: dir * (14 + Math.random() * 8), n: 3 + Math.floor(Math.random() * 3) };
    }
    if (this.birds) {
      this.birds.x += this.birds.v * dt;
      if (this.birds.x < -40 || this.birds.x > bw + 40) this.birds = null;
    }
    this.nextShoot -= dt;
    if (this.nextShoot <= 0 && P.shootingStars) {
      this.nextShoot = 14 + Math.random() * 16;
      const dir = Math.random() < 0.5 ? -1 : 1;
      this.shoot = { x: bw * (0.3 + Math.random() * 0.4), y: 8 + Math.random() * 20, vx: dir * (180 + Math.random() * 80), vy: 50 + Math.random() * 30, t0: this.time, life: 0.7 };
    }
    if (this.shoot && this.time - this.shoot.t0 > this.shoot.life) this.shoot = null;
  }

  /** what moves behind the people, into the pixel layer (blocks -> art px) */
  draw(pix) {
    const cv = this.cv;
    if (!cv) return;
    const t = this.time;
    const u = this.n / pix.S; // a block in art px
    const put = (x, y, c, a = 1) => pix.put(Math.round(x) * u, Math.round(y) * u, c, a, u);
    for (const s of this.stars) {
      const tw = 0.5 + 0.5 * Math.sin(t * s.f + s.ph);
      const k = 0.35 + 0.65 * tw;
      const col = [s.col[0] * k, s.col[1] * k, s.col[2] * k];
      put(s.x, s.y, col);
      if (s.big && tw > 0.75) {
        const c2 = [col[0] * 0.45, col[1] * 0.45, col[2] * 0.45];
        for (const [dx, dy] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ]) if (cv.layerAt(s.x + dx, s.y + dy) === LAYER.SKY) put(s.x + dx, s.y + dy, c2);
      }
    }
    // clouds, only over sky and moon (behind everything else)
    const m = this.moon;
    for (const c of this.clouds) {
      for (const [dx, dy, k] of c.blocks) {
        const x = Math.round(c.x + dx);
        const y = Math.round(c.y + dy);
        const l = cv.layerAt(x, y);
        if (l !== LAYER.SKY && l !== LAYER.MOON) continue;
        const near = Math.hypot(x - m.x, y - m.y) < m.r * 1.9;
        put(x, y, k === 3 ? C.cloud[near ? 3 : 2] : C.cloud[k === 2 && near ? 2 : k === 0 ? 0 : 1]);
      }
    }
    // the moon shimmering in the lake
    const W = this.water;
    if (W) {
      for (let y = W.top + 1; y <= W.bottom; y++) {
        if ((y + Math.floor(t * 3)) % 2) continue;
        const w = 3 + (y - W.top) * 0.45;
        const off = Math.sin(t * 1.7 + y * 0.9) * 2.5;
        const len = 1 + Math.floor((0.5 + 0.5 * Math.sin(t * 2.3 + y * 1.7)) * w * 0.7);
        const x0 = Math.round(m.x + off - len / 2);
        for (let x = x0; x < x0 + len; x++) if (cv.layerAt(x, y) === LAYER.WATER) put(x, y, C.reflect[Math.abs(x - m.x - off) < len * 0.25 ? 2 : 1]);
      }
    }
    // birds: little Vs flapping
    const b = this.birds;
    if (b) {
      for (let k = 0; k < b.n; k++) {
        const x = b.x - Math.sign(b.v) * k * 5;
        const y = b.y + (k % 2 ? 2 : 0) + k;
        const up = Math.sin(t * 12 + k) > 0 ? -1 : 0;
        put(x, y, C.bird);
        put(x - 1, y + up, C.bird);
        put(x + 1, y + up, C.bird);
      }
    }
    const s = this.shoot;
    if (s) {
      const a = (t - s.t0) / s.life;
      const sp = Math.hypot(s.vx, s.vy);
      for (let k = 0; k < 20; k++) {
        const x = s.x + s.vx * (t - s.t0) - (s.vx / sp) * k;
        const y = s.y + s.vy * (t - s.t0) - (s.vy / sp) * k;
        if (cv.layerAt(x, y) === LAYER.SKY) put(x, y, [1, 1, 1], (1 - k / 20) * (1 - a * a));
      }
    }
    // the lanterns flicker
    for (const l of this.lanterns) {
      const fl = Math.sin(t * 9 + l.x) * Math.sin(t * 3.7 + l.y) > -0.25;
      put(l.x, l.y, l.small ? C.window[fl ? 2 : 1] : C.chochin[fl ? 2 : 1]);
    }
    // fireflies: on or off, never dim
    for (const f of this.flies) if (Math.sin(t * 2.2 * f.sp + f.ph * 3) > 0.55) put(f.x, f.y, C.firefly);
  }

  /** the cherry petals, in front of the people */
  drawPetals(pix) {
    const u = this.n / pix.S;
    for (const q of this.petals) {
      const x = Math.round(q.x) * u;
      const y = Math.round(q.y) * u;
      pix.put(x, y, q.col, 1, u);
      if (Math.sin(this.time * 5 + q.ph) > 0) pix.put(x + u, y, q.col, 1, u);
    }
  }

  /** the lanterns light their surroundings: add(x, y (wall m), r (m), intensity, col) */
  lights(add, L) {
    if (!this.cv) return;
    for (const l of this.lanterns) {
      const fl = 0.85 + 0.15 * Math.sin(this.time * 9 + l.x) * Math.sin(this.time * 3.7 + l.y);
      add(l.x / this.kb, L.top - l.y / this.kb, l.r, l.i * fl, C.chochin[2]);
    }
  }
}
