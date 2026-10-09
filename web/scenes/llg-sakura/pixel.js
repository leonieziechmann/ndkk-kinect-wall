// Pixel art tools: the palette, a small raster with aliased shapes, text from system fonts made
// crisp (thresholded, outlined), and a hand-made 5x7 capital font.
//
// Everything in the scene uses the palette below; the last render pass snaps every pixel to it
// (with ordered dithering for glows), so nothing outside it ever reaches the wall.

export const C = {
  // night sky, from the top down to the glow at the horizon
  sky0: '#07071a',
  sky1: '#0d0e26',
  sky2: '#141638',
  sky3: '#1c1d4a',
  sky4: '#262659',
  sky5: '#33306c',
  sky6: '#44397e',
  sky7: '#583f8a',
  sky8: '#734792',
  sky9: '#93508f',
  sky10: '#b85a8c',
  sky11: '#da6f8a',
  sky12: '#f19084',
  // concrete at night
  g0: '#181a36',
  g1: '#22264a',
  g2: '#2e325c',
  g3: '#3c416f',
  g4: '#4d5383',
  g5: '#636a99',
  g6: '#8189b5',
  g7: '#a6aed3',
  // the school's orange
  o0: '#5c1a2e',
  o1: '#8e2a2f',
  o2: '#c2402a',
  o3: '#e8641f',
  o4: '#ff8a1c',
  o5: '#ffae45',
  o6: '#ffd27a',
  // warm light
  y0: '#ffc25c',
  y1: '#ffe08a',
  y2: '#fff3c4',
  // cherry blossoms
  p0: '#3a1238',
  p1: '#5e1c4f',
  p2: '#8a2862',
  p3: '#b83a7e',
  p4: '#e05c9e',
  p5: '#ff86bb',
  p6: '#ffb3d4',
  p7: '#ffdcec',
  p8: '#fff4fa',
  // plum bark
  t0: '#24122e',
  t1: '#3d1d44',
  t2: '#5a2c5c',
  // teal and blue
  c0: '#123a5c',
  c1: '#1c6f8f',
  c2: '#2fb3c8',
  c3: '#7eeedc',
  b0: '#3d63e0',
  b1: '#7b8cff',
  w: '#ffffff',
};
export const PALETTE = Object.values(C);

export const rgb = (hex) => {
  const v = Number.parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};
const packed = new Map();
/** Hex -> the Uint32 of an RGBA pixel (little endian: ABGR). */
export function px(hex, a = 255) {
  const key = hex + a;
  let v = packed.get(key);
  if (v === undefined) {
    const n = Number.parseInt(hex.slice(1), 16);
    v = ((a << 24) | ((n & 255) << 16) | (((n >> 8) & 255) << 8) | ((n >> 16) & 255)) >>> 0;
    packed.set(key, v);
  }
  return v;
}

export const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
export const bayer = (x, y) => BAYER4[(y & 3) * 4 + (x & 3)];

/** Small seeded random generator: the same picture every time. */
export function rng(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A raster of RGBA pixels with aliased drawing (every pixel either is or is not). */
export class Pix {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.img = new ImageData(w, h);
    this.u32 = new Uint32Array(this.img.data.buffer);
  }
  set(x, y, hex) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.u32[y * this.w + x] = px(hex);
  }
  isSet(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    return this.u32[y * this.w + x] >>> 24 > 0;
  }
  rect(x, y, w, h, hex) {
    const v = px(hex);
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w));
    const y1 = Math.min(this.h, Math.round(y + h));
    for (let j = y0; j < y1; j++) this.u32.fill(v, j * this.w + x0, j * this.w + Math.max(x0, x1));
  }
  /** Calls fn(x, y) for every pixel of the box; a returned color is set. */
  shade(x0, y0, x1, y1, fn) {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(this.h, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(this.w, Math.ceil(x1)); x++) {
        const c = fn(x, y);
        if (c) this.u32[y * this.w + x] = px(c);
      }
    }
  }
  /** Filled ellipse: pixels whose centers are inside. */
  ellipse(cx, cy, rx, ry, hex) {
    this.shade(cx - rx - 1, cy - ry - 1, cx + rx + 1, cy + ry + 1, (x, y) => (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1 ? hex : null));
  }
  /** Bresenham line. */
  line(x0, y0, x1, y1, hex) {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, hex);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }
  /** A mask (Uint8Array w x h, 1 = set) stamped at (x, y) in one color. */
  stamp(m, x, y, hex) {
    for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) if (m.d[j * m.w + i]) this.set(x + i, y + j, hex);
  }
  toCanvas() {
    const c = new OffscreenCanvas(this.w, this.h);
    c.getContext('2d').putImageData(this.img, 0, 0);
    return c;
  }
}

/** A mask: { w, h, d: Uint8Array }. */
export const mask = (w, h) => ({ w, h, d: new Uint8Array(w * h) });

/** The mask grown by one pixel (8 neighbours), with a margin of one pixel on every side. */
export function grow(m, r = 1) {
  let cur = m;
  for (let k = 0; k < r; k++) {
    const o = mask(cur.w + 2, cur.h + 2);
    for (let y = 0; y < o.h; y++) {
      for (let x = 0; x < o.w; x++) {
        let on = 0;
        for (let dy = -1; dy <= 1 && !on; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const sx = x - 1 + dx;
            const sy = y - 1 + dy;
            if (sx >= 0 && sy >= 0 && sx < cur.w && sy < cur.h && cur.d[sy * cur.w + sx]) {
              on = 1;
              break;
            }
          }
        }
        o.d[y * o.w + x] = on;
      }
    }
    cur = o;
  }
  return cur;
}

/**
 * Text from a system font as a crisp mask: drawn large with the font's own antialiasing, then
 * box-filtered down by `ss` and thresholded, so the strokes keep even widths. size: pixel height of
 * the em. Returns { w, h, d, base } (base: baseline row).
 */
export function textMask(str, font, size, { weight = 800, threshold = 0.5, ss = 4, squeeze = 1 } = {}) {
  const S = ss;
  const probe = new OffscreenCanvas(8, 8).getContext('2d');
  probe.font = `${weight} ${size * S}px ${font}`;
  const mt = probe.measureText(str);
  const w = Math.max(1, Math.ceil((mt.width * squeeze) / S) + 2);
  const asc = Math.ceil(Math.max(mt.actualBoundingBoxAscent, size * 0.8 * S) / S) + 1;
  const desc = Math.ceil(Math.max(mt.actualBoundingBoxDescent, 0) / S) + 1;
  const h = asc + desc;
  const c = new OffscreenCanvas(w * S, h * S);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.font = `${weight} ${size * S}px ${font}`;
  g.fillStyle = '#fff';
  g.textBaseline = 'alphabetic';
  g.setTransform(squeeze, 0, 0, 1, S, 0);
  g.fillText(str, 0, asc * S);
  const src = g.getImageData(0, 0, c.width, c.height).data;
  const m = mask(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) sum += src[((y * S + j) * c.width + x * S + i) * 4 + 3];
      m.d[y * w + x] = sum / (S * S * 255) >= threshold ? 1 : 0;
    }
  }
  m.base = asc;
  return m;
}

// a 5x7 capital font, drawn by hand
const F57 = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#',
  B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '.###.|#...#|#....|#....|#....|#...#|.###.',
  D: '####.|#...#|#...#|#...#|#...#|#...#|####.',
  E: '#####|#....|#....|####.|#....|#....|#####',
  F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.###.|#...#|#....|#.###|#...#|#...#|.###.',
  H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  I: '.###.|..#..|..#..|..#..|..#..|..#..|.###.',
  J: '..###|...#.|...#.|...#.|#..#.|#..#.|.##..',
  K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#',
  L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#',
  N: '#...#|#...#|##..#|#.#.#|#..##|#...#|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  P: '####.|#...#|#...#|####.|#....|#....|#....',
  Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#',
  R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.',
  T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
  W: '#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.',
  X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..',
  Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  '-': '.....|.....|.....|.###.|.....|.....|.....',
  ' ': '.....|.....|.....|.....|.....|.....|.....',
  '.': '.....|.....|.....|.....|.....|.##..|.##..',
};

/** Text in the 5x7 capital font as a mask (1 pixel between letters). */
export function font57(str) {
  const chars = [...String(str).toUpperCase()].map((ch) => F57[ch] ?? F57[' ']);
  const m = mask(Math.max(1, chars.length * 6 - 1), 7);
  chars.forEach((g, i) => {
    g.split('|').forEach((row, y) => {
      for (let x = 0; x < 5; x++) if (row[x] === '#') m.d[y * m.w + i * 6 + x] = 1;
    });
  });
  m.base = 7;
  return m;
}

/** Stamps text the way pixel games do: drop shadow, dark outline, fill (and a lighter top row). */
export function stampTitle(pix, m, x, y, { fill, top = null, outline = C.sky0, shadow = null, shadowOff = 1 }) {
  const o = grow(m);
  if (shadow) pix.stamp(o, x - 1 + shadowOff, y - 1 + shadowOff, shadow);
  pix.stamp(o, x - 1, y - 1, outline);
  pix.stamp(m, x, y, fill);
  if (top) {
    // the upper edge of every stroke one shade lighter
    for (let j = 0; j < m.h; j++) {
      for (let i = 0; i < m.w; i++) if (m.d[j * m.w + i] && (j === 0 || !m.d[(j - 1) * m.w + i])) pix.set(x + i, y + j, top);
    }
  }
}
