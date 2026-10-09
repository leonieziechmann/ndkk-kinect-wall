// The birch wood, painted once per size as four layers in a flat, pixel-crisp style, so people can
// walk between the trees:
//
//   0  the deep wood: dark indigo, a warm light far behind, very many small trees, the far hills
//   1  far trees  (DEPTHS[0] m from the sensor), golden light rays and a band of glowing mist
//   2  mid trees  (DEPTHS[1]), fainter rays, a thinner band of mist
//   3  near trees (DEPTHS[2]): wide white trunks, the brightest crowns, the near knolls with heather
//
// Layers 1-3 are transparent around their trees and hills. render.js puts every person pixel
// between the layers by its distance from the sensor: in front of the trees farther away, behind
// the nearer ones (and behind the nearer hills). Every row of trees has its own crowns and its own
// rolling ground; the farther a row, the lower its crowns sit (smaller in perspective), the denser
// and darker it is.
//
// Colors: indigo depth against gold light (complementary, so nothing turns olive). Things far away
// are mixed into the deep indigo in OKLCH, not in RGB: a gold crown turns orange, then rose on its
// way into the dark instead of going muddy.
//
// A birch here: flat two-tone bark (lit left, shaded right), black lenticel dashes, V-shaped branch
// scars, a rough black foot, thin dark branches reaching into its crown. A crown: clusters of round
// leaves (leafpix.js, flat). Nothing is blurred; every pixel is one LED.

import { LEAF_COLORS, LEAF_WEIGHTS } from './layout.js';
import { drawLeaf, FLAT, leafPalette, ROUND, u32 } from './leafpix.js';

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WEIGHT_SUM = LEAF_WEIGHTS.reduce((a, b) => a + b, 0);
/** a leaf color index, golds more often */
export function pickColor(R) {
  let r = R() * WEIGHT_SUM;
  for (let i = 0; i < LEAF_WEIGHTS.length; i++) {
    r -= LEAF_WEIGHTS[i];
    if (r < 0) return i;
  }
  return 0;
}
export const PALETTES = LEAF_COLORS.map((c) => leafPalette(c));
/** the same for leaves in the air (behind the contact card, alpha 254) */
export const PALETTES_BEHIND = LEAF_COLORS.map((c) => leafPalette(c, 254));
/** the same for the leaf heap and leaves lying on the signs (at the signs' depth, alpha 253) */
export const PALETTES_SIGN = LEAF_COLORS.map((c) => leafPalette(c, 253));

// ---------------------------------------------------------------- colors in OKLCH

const rgbOf = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const toLin = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (v) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)));

function oklch([r8, g8, b8]) {
  const [r, g, b] = [toLin(r8), toLin(g8), toLin(b8)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}
function fromOklch([L, C, h]) {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}
/**
 * a mixed into b by t, in OKLCH (a gray takes the other's hue). The hue goes the short way, or
 * with viaRed always through red and magenta (gold into indigo never passes green).
 */
function mixOk(a, b, t, viaRed = false) {
  const p = oklch(a);
  const q = oklch(b);
  let h0 = p[2];
  let h1 = q[2];
  if (p[1] < 0.02) h0 = h1;
  if (q[1] < 0.02) h1 = h0;
  let dh = h1 - h0;
  if (dh > Math.PI) dh -= 2 * Math.PI;
  if (dh < -Math.PI) dh += 2 * Math.PI;
  if (viaRed && dh > 0 && Math.abs(dh) > 0.6) dh -= 2 * Math.PI;
  return fromOklch([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, h0 + dh * t]);
}
const hexOf = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const mixHex = (a, b, t, viaRed = false) => hexOf(mixOk(rgbOf(a), rgbOf(b), t, viaRed));

// the deep wood, top to bottom, and the color everything far away sinks into
const DEEP = ['#0b0e1e', '#121731', '#1a2045', '#232a55'];
const DEEP_MID = '#181e3c';
const MIST = '#c9ccf2'; // glowing mist, lavender white
const GLOW = '#ffd27a'; // the light far behind
const RAY = '#fff0d2';

// distance of the tree layers from the sensor (m), far to near
export const DEPTHS = [3.3, 2.4, 1.5];

// per layer: trunks per 1000 design px and their width, how crooked, branches per trunk, where the
// crowns sit (design px from the top) and their radius, leaf size, how much it sinks into the deep
// wood (0 = not), the ground: base height (design px), hill amplitude and its soil; the mist band
const LAYERS = [
  { trunks: 80, w: [2, 5], lean: 0.012, branches: 0, crownY: 104, crownR: [11, 22], leaf: [5, 7], deep: 0.66, marks: 0.3, ground: 246, hills: 9, soil: '#1c2244', mist: 0 },
  { trunks: 24, w: [5, 9], lean: 0.025, branches: 1, crownY: 68, crownR: [16, 30], leaf: [6.5, 9], deep: 0.42, marks: 0.45, ground: 272, hills: 8, soil: '#222a50', mist: 0.36 },
  { trunks: 9, w: [11, 17], lean: 0.04, branches: 2, crownY: 34, crownR: [22, 40], leaf: [8, 11], deep: 0.18, marks: 0.7, ground: 294, hills: 7, soil: '#2a335d', mist: 0.22 },
  { trunks: 0, w: [26, 34], lean: 0.05, branches: 2, crownY: 2, crownR: [30, 52], leaf: [10, 14], deep: 0, marks: 1, ground: 318, hills: 7, soil: '#333d6a', mist: 0 },
];
// where the people's feet stand (persp.js): on the near and on the far trees' ground
// ([m from the sensor, design px from the top])
export const FEET = [
  [DEPTHS[2], LAYERS[3].ground],
  [DEPTHS[0], LAYERS[1].ground],
];

// the near trees stand where they frame the scene (fraction of the design width, lean)
const NEAR = [
  [0.012, 0.03],
  [0.415, -0.035],
  [0.998, -0.02],
];

// the bark of a layer: lit, shaded, edge, marks, foot, branches (sunk into the deep wood by `deep`)
function bark(deep) {
  const f = (h) => u32(mixHex(h, DEEP_MID, deep));
  return { lit: f('#f6f6fa'), shade: f('#c3c5d8'), edge: f('#9a9db9'), mark: f('#0f1016'), mark2: f('#3b3d4c'), foot: f('#13141e'), branch: f('#25273a') };
}

const hash = (x, y) => {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** A rolling line: y (px) at column x around `base` (design px) with amplitude `amp`. */
function rolling(base, amp, s, R) {
  const k = [R() * 6.28, R() * 6.28, R() * 6.28];
  const f = [0.004 + R() * 0.003, 0.011 + R() * 0.006, 0.027 + R() * 0.01];
  return (x) => {
    const u = x / s;
    return (base + amp * (0.6 * Math.sin(u * f[0] + k[0]) + 0.3 * Math.sin(u * f[1] + k[1]) + 0.12 * Math.sin(u * f[2] + k[2]))) * s;
  };
}

/**
 * A birch from `top` down to yBot: two-tone bark, lenticels, branch scars, a rough dark foot.
 * x0: its middle at yBot, w: width at the foot, lean: px sideways per px up. Returns its middle and
 * width at height y (for branches and the crown).
 */
function birch(buf, W, H, x0, w, top, yBot, lean, pal, R, s, markAmount, deep) {
  const len = Math.max(1, yBot - top);
  const mid = (y) => x0 + lean * (yBot - y) + Math.sin(y * 0.013 + x0) * w * 0.08;
  const width = (y) => w * (0.72 + 0.28 * ((y - top) / len));
  // the marks: per row, dashes [u0, u1] across the trunk (0 left .. 1 right)
  const rows = new Map();
  const add = (y, u0, u1) => {
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push([u0, u1]);
  };
  for (let y = top + Math.round(R() * 8); y < yBot; ) {
    if (R() < markAmount) {
      const th = 1 + Math.floor(R() * (w > 12 ? 3 : 2));
      const fromRight = R() < 0.6;
      const l = 0.18 + R() * (w > 10 ? 0.5 : 0.7);
      const u0 = fromRight ? 1 - l : R() < 0.5 ? 0 : R() * 0.4;
      for (let k = 0; k < th; k++) add(y + k, u0, Math.min(1, u0 + l));
    }
    // a V-shaped branch scar now and then on wide trunks
    if (w >= 12 && R() < 0.07) {
      const c = 0.3 + R() * 0.4;
      const h = Math.round((3 + R() * 3) * s);
      for (let k = 0; k < h; k++) {
        const spread = 0.08 + (k / h) * 0.3;
        add(y + k, c - spread - 0.06, c - spread + 0.04);
        add(y + k, c + spread - 0.04, c + spread + 0.06);
      }
      y += h;
    }
    y += Math.round((3 + R() * 7) * (w > 10 ? 1 : 1.4) * Math.max(0.6, s));
  }
  const footH = Math.round(Math.min(len * 0.2, w * (1.2 + R())) * (1 - deep * 0.7));
  for (let y = Math.max(0, Math.round(top)); y < Math.min(H, yBot); y++) {
    const cx = mid(y);
    const ww = width(y);
    const left = Math.round(cx - ww / 2);
    const right = Math.round(cx + ww / 2);
    const marks = rows.get(y);
    const footT = (y - (yBot - footH)) / Math.max(1, footH); // 0..1 into the dark foot
    for (let x = left; x <= right; x++) {
      if (x < 0 || x >= W) continue;
      const u = (x - left) / Math.max(1, right - left);
      let c = u > 0.62 ? pal.shade : pal.lit;
      if (x === right && w > 6) c = pal.edge;
      if (marks) for (const [u0, u1] of marks) if (u >= u0 && u <= u1) c = u > 0.55 ? pal.mark : pal.mark2;
      if (footT > 0) {
        // rough black bark at the foot, in chunks, denser further down
        const n = hash(Math.floor(x / 2), Math.floor(y / 3)) * 0.8 + hash(x, y) * 0.2;
        if (n < footT * 0.85 + (u > 0.6 ? 0.12 : 0)) c = pal.foot;
      }
      buf[y * W + x] = c;
    }
  }
  return { mid, width };
}

/** A thin dark branch from (x0, y0) up to (x1, y1), tapering, slightly bent. */
function branch(buf, W, H, x0, y0, x1, y1, th, color, R) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  const bend = (R() - 0.5) * 0.25 * n;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = x0 + (x1 - x0) * t + Math.sin(t * Math.PI) * bend;
    const y = y0 + (y1 - y0) * t;
    const w = Math.max(1, Math.round(th * (1 - t * 0.7)));
    for (let k = 0; k < w; k++) {
      const px = Math.round(x + k - w / 2);
      const py = Math.round(y);
      if (px >= 0 && px < W && py >= 0 && py < H) buf[py * W + px] = color;
    }
  }
}

/** A crown: a cluster of round leaves around (cx, cy) with radius r, denser in the middle. */
function cluster(buf, W, H, cx, cy, r, ly, pals, R, s) {
  const n = Math.round(((r * r) / (ly.leaf[0] * ly.leaf[0] * s * s)) * 2.2);
  for (let i = 0; i < n; i++) {
    const a = R() * Math.PI * 2;
    const d = r * Math.sqrt(R()) * (0.6 + 0.4 * R());
    const size = (ly.leaf[0] + R() * (ly.leaf[1] - ly.leaf[0])) * s;
    drawLeaf(buf, W, H, cx + Math.cos(a) * d * 1.2, cy + Math.sin(a) * d * 0.85, size, (R() - 0.5) * 1.4, 0.75 + R() * 0.25, pals[pickColor(R)], ROUND | FLAT);
  }
}

/** The ground below a layer's line: its soil, a lit crest, and heather tufts along the crest. */
function terrain(buf, W, H, gy, ly, deep, R, s) {
  const soil = u32(ly.soil);
  const soil2 = u32(mixHex(ly.soil, '#05060c', 0.3));
  const crest = u32(mixHex(mixHex(ly.soil, MIST, 0.4), DEEP_MID, deep * 0.4));
  for (let x = 0; x < W; x++) {
    const y0 = Math.round(gy(x));
    for (let y = Math.max(0, y0); y < H; y++) buf[y * W + x] = y === y0 ? crest : y - y0 > 10 * s && hash(x >> 1, y >> 1) < 0.5 ? soil2 : soil;
  }
  // heather: short upright strokes along the crest, lilacs and a few fresh greens
  const cols = ['#cfb2f2', '#b996ea', '#a17fdc', '#e2cdf7', '#8c6cd0'].map((h) => u32(mixHex(h, DEEP_MID, deep)));
  const greens = ['#8fd08a', '#6fb87a'].map((h) => u32(mixHex(h, DEEP_MID, deep)));
  const n = Math.round((W / s) * (deep > 0.5 ? 1.2 : 2.6));
  for (let i = 0; i < n; i++) {
    const x = Math.floor(R() * W);
    const yb = Math.round(gy(x) + R() * 12 * s);
    const h = Math.max(2, Math.round((2 + R() * 5) * s * (1 - deep * 0.5)));
    const c = R() < 0.14 ? greens[Math.floor(R() * 2)] : cols[Math.floor(R() * cols.length)];
    for (let k = 0; k < h; k++) {
      const y = yb - k;
      const px = x + (k > h / 2 && R() < 0.3 ? (R() < 0.5 ? -1 : 1) : 0);
      if (y >= 0 && y < H && px >= 0 && px < W) buf[y * W + px] = c;
    }
  }
}

// the signs stand in the wood: nothing of the nearer layers may cover their faces
const inBox = (boxes, x, y) => boxes.some((b) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1);
const hitsBox = (boxes, x0, x1, y0, y1) => boxes.some((b) => x1 > b.x0 && x0 < b.x1 && y1 > b.y0 && y0 < b.y1);

// blends `rgb` with alpha a over the (unpremultiplied) RGBA pixel at byte k
function over(d, k, rgb, a) {
  const oa = d[k + 3] / 255;
  const na = oa + a * (1 - oa);
  for (let ch = 0; ch < 3; ch++) d[k + ch] = Math.round((rgb[ch] * a + d[k + ch] * oa * (1 - a)) / Math.max(na, 1e-4));
  d[k + 3] = Math.round(na * 255);
}

/** Light rays fanning down from the glow behind the wood: bands with a brighter core, fading. */
function rays(d, W, H, glow, R, s, strength, boxes = []) {
  const rgb = rgbOf(RAY);
  const beams = [];
  for (let i = 0; i < 7; i++) beams.push({ ang: (-50 + R() * 100) * (Math.PI / 180), w: (22 + R() * 48) * s, a: (0.17 + R() * 0.16) * strength });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - glow[0];
      const dy = y - glow[1];
      if (dy <= 0) continue;
      const dist = Math.hypot(dx, dy);
      let a = 0;
      for (const b of beams) {
        const along = dx * Math.sin(b.ang) + dy * Math.cos(b.ang);
        const across = Math.abs(dx * Math.cos(b.ang) - dy * Math.sin(b.ang));
        const wide = b.w * (0.35 + (0.9 * along) / H);
        if (along > 0 && across < wide / 2) a = Math.max(a, b.a * (across < wide * 0.18 ? 1.5 : 1) * Math.max(0, 1 - dist / (H * 1.4)));
      }
      if (a > 0.004 && !inBox(boxes, x, y)) over(d, (y * W + x) * 4, rgb, Math.min(0.55, a));
    }
  }
}

/** A band of glowing mist from y0 down to the ground, in three flat steps. */
function mistBand(d, W, H, gy, y0, alpha, boxes = []) {
  const rgb = rgbOf(MIST);
  for (let x = 0; x < W; x++) {
    const yg = gy(x);
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(H, Math.round(yg + 4)); y++) {
      const t = (y - y0) / Math.max(1, yg - y0);
      const step = t < 0.33 ? 0.35 : t < 0.66 ? 0.65 : 1;
      if (!inBox(boxes, x, y)) over(d, (y * W + x) * 4, rgb, alpha * step);
    }
  }
}

/**
 * The light far behind the trees: a soft warm glow (no rings, no edge), mixed into the dark in
 * OKLCH, only between the trunks: it fades out towards the crowns (from `top` up), so it never
 * shows through the gaps of the leaves.
 */
function glowSoft(d, W, H, glow, s, top) {
  const g = rgbOf(GLOW);
  const R = 210 * s;
  const cache = new Map();
  for (let y = Math.max(0, Math.floor(top)); y < H; y++) {
    const fade = Math.min(1, (y - top) / (55 * s));
    const v = fade * fade * (3 - 2 * fade);
    for (let x = 0; x < W; x++) {
      const dist = Math.hypot((x - glow[0]) / 1.6, y - glow[1]) / R;
      if (dist >= 1) continue;
      // smooth falloff, quantized finely (1/48) so the colors can be cached
      const t = Math.round((1 - dist) ** 2.2 * 0.8 * v * 48) / 48;
      if (t <= 0) continue;
      const k = (y * W + x) * 4;
      const key = (d[k] << 16) | (d[k + 1] << 8) | d[k + 2] | (Math.round(t * 48) << 24);
      let c = cache.get(key);
      if (!c) {
        c = mixOk([d[k], d[k + 1], d[k + 2]], g, t);
        cache.set(key, c);
      }
      d[k] = c[0];
      d[k + 1] = c[1];
      d[k + 2] = c[2];
    }
  }
}

/**
 * Paints the wood for layout L. Returns { layers: [4 canvases], spots, ground }: spots are leaves
 * of the nearer crowns ([x, y, color] in LED px), where falling leaves come from; ground(x) is the
 * near ground line (px).
 */
export function paintForest(L) {
  const { W, H, s } = L;
  const R = rng(20261010);
  const spots = [];
  // the light: a soft glow between the trunks, and the rays falling from above, out of the crowns
  const glow = [W * 0.6, H * 0.38];
  const sun = [W * 0.6, H * 0.12];
  let nearGround = null;
  // the faces of the signs and the signpost: the nearer layers keep their trunks and crowns off the
  // codes and the writing (the boards' edges may vanish behind trees)
  const pad = 4 * s;
  const signBoxes = [...(L.signs ?? []), ...(L.post ? [L.post] : [])].map(({ face: f }) => ({ x0: f.x0 - pad, x1: f.x1 + pad, y0: f.y0 - pad, y1: f.y1 + pad }));
  const layers = LAYERS.map((ly, li) => {
    const boxes = li >= 2 ? signBoxes : [];
    const canvas = new OffscreenCanvas(W, H);
    const g = canvas.getContext('2d');
    if (li === 0) {
      const gr = g.createLinearGradient(0, 0, 0, H);
      DEEP.forEach((c, i) => gr.addColorStop(i / (DEEP.length - 1), c));
      g.fillStyle = gr;
      g.fillRect(0, 0, W, H);
    }
    const img = g.getImageData(0, 0, W, H);
    if (li === 0) glowSoft(img.data, W, H, glow, s, (LAYERS[0].crownY + 12) * s);
    const buf = new Uint32Array(img.data.buffer);
    const gy = rolling(ly.ground, ly.hills, s, R);
    if (li === 3) nearGround = gy;

    // the rows: the deep wood twice (a farther, smaller, darker row first), the others once
    const rows = li === 0 ? [{ deep: 0.84, crownY: ly.crownY + 22, scale: 0.7, count: 1.25, drop: 12 }, { deep: ly.deep, crownY: ly.crownY, scale: 1, count: 1, drop: 0 }] : [{ deep: ly.deep, crownY: ly.crownY, scale: 1, count: 1, drop: 0 }];
    const crowns = [];
    for (const row of rows) {
      const pal = bark(row.deep);
      const pals = LEAF_COLORS.map((c) => leafPalette(c.map((h) => mixHex(h, DEEP_MID, row.deep * 0.9, true))));
      const crownLine = rolling(row.crownY, 10, s, R);
      const trees = [];
      if (li === 3) for (const [f, lean] of NEAR) trees.push({ x: W / 2 + (f - 0.5) * 1008 * s, lean });
      else {
        const n = Math.round((W / s / 1000) * ly.trunks * row.count);
        for (let i = 0; i < n; i++) trees.push({ x: ((i + 0.1 + R() * 0.8) / n) * W, lean: (R() - 0.5) * 2 * ly.lean });
      }
      // the birches standing among the signs (straight, so they stay off the codes)
      if (li === 2 && row.deep === ly.deep) for (const t of L.signTrees ?? []) trees.push({ x: t.x, lean: 0, w: t.w, fixed: true });
      for (const t of trees) {
        const w = t.w ? Math.round(t.w) : Math.max(1, Math.round((ly.w[0] + R() * (ly.w[1] - ly.w[0])) * s * row.scale));
        if (!t.fixed && hitsBox(boxes, t.x - w / 2 - 2 * s, t.x + w / 2 + 2 * s, 0, H)) continue;
        const yBot = Math.round(gy(t.x) + (4 + R() * 6) * s - row.drop * s);
        const r = (ly.crownR[0] + R() * (ly.crownR[1] - ly.crownR[0])) * s * row.scale;
        const cy = crownLine(t.x) + (R() - 0.5) * 10 * s;
        const tr = birch(buf, W, H, t.x, w, Math.round(cy - r * 0.3), yBot, t.lean, pal, R, s, ly.marks, row.deep);
        const tx = tr.mid(cy);
        crowns.push({ x: tx, y: cy, r, pals, deep: row.deep });
        for (let b = 0; b < ly.branches; b++) {
          if (R() < 0.35) continue;
          const y0 = Math.round(cy + r * 0.8 + R() * 50 * s);
          const side = R() < 0.5 ? -1 : 1;
          const x0 = tr.mid(y0) + (side * tr.width(y0)) / 2;
          const x1 = x0 + side * (20 + R() * 40) * s;
          const y1 = Math.max(4, y0 - (25 + R() * 40) * s);
          if (hitsBox(boxes, Math.min(x0, x1) - 14 * s, Math.max(x0, x1) + 14 * s, y1 - 14 * s, y0)) continue;
          branch(buf, W, H, x0, y0, x1, y1, Math.max(1, Math.round(w * 0.12)), pal.branch, R);
          crowns.push({ x: x1, y: y1, r: (10 + R() * 12) * s * row.scale, pals, deep: row.deep });
        }
      }
      // fill the gaps between the crowns of a row, so the row has one canopy
      const step = ly.crownR[1] * (li >= 1 ? 0.95 : 1.3) * s * row.scale;
      for (let x = -step / 2; x < W + step; x += step * (0.7 + R() * 0.6)) {
        crowns.push({ x, y: crownLine(x) - R() * 8 * s, r: (ly.crownR[0] + R() * (ly.crownR[1] - ly.crownR[0]) * 0.7) * s * row.scale, pals, deep: row.deep });
      }
    }
    // the near row closes the ceiling: a dense band of leaves along the top edge
    if (li === 3) {
      for (let x = -10 * s; x < W + 20 * s; x += (16 + R() * 12) * s) {
        crowns.push({ x, y: (R() * 16 - 6) * s, r: (20 + R() * 18) * s, pals: LEAF_COLORS.map((c) => leafPalette(c)), deep: 0 });
      }
    }
    // the hills this layer stands on, then the crowns over its trunks
    terrain(buf, W, H, gy, ly, ly.deep, R, s);
    for (const c of crowns) {
      if (hitsBox(boxes, c.x - c.r * 1.25, c.x + c.r * 1.25, c.y - c.r * 0.9, c.y + c.r * 0.9)) continue;
      cluster(buf, W, H, c.x, c.y, c.r, ly, c.pals, R, s);
      if (li >= 2) spots.push([c.x, c.y + c.r * 0.4, pickColor(R)]);
    }
    // light and mist in between the layers
    if (li === 1) rays(img.data, W, H, sun, R, s, 1);
    // (thin mist and light may lie over the signs: they stand in the wood, the codes stay readable)
    if (li === 2) rays(img.data, W, H, sun, R, s, 0.45);
    if (ly.mist) mistBand(img.data, W, H, gy, (ly.ground - 75) * s, ly.mist);
    g.putImageData(img, 0, 0);
    return canvas;
  });
  return { layers, spots, ground: nearGround };
}
