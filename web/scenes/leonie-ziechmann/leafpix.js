// Birch leaves as crisp pixel art, rasterized straight into an RGBA buffer (Uint32Array over the
// LED image, one pixel = one LED): a pointed oval, widest near the base like a birch leaf, with a
// 1-LED darker edge, a light midrib and its stalk. Turning in the air is a squeeze across the leaf
// (|flip| < 1), and its paler back shows while flip < 0.
//
// drawLeaf() rasterizes and draws in one go (leaves in the air change every frame); leafSprite()
// keeps the pixels of a leaf that lies still, and blit() draws them again.
//
// style flags: STALK (draw the stalk), ROUND (a round coin leaf like an aspen's, for the flat
// crowns), FLAT (no outline: a lit left half instead, for dense crowns that must not look noisy).

export const rgbOf = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** '#rrggbb' -> the pixel as a little-endian RGBA Uint32 */
export function u32(hex, a = 255) {
  const [r, g, b] = rgbOf(hex);
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/**
 * a leaf color [edge, body, light] as pixels: front edge/body/rib, back edge/body. alpha 255 marks
 * a leaf in front of the cards, 254 one behind them (render.js tells them apart).
 */
export function leafPalette([edge, body, light], alpha = 255) {
  return { edge: u32(edge, alpha), body: u32(body, alpha), rib: u32(light, alpha), backEdge: u32(body, alpha), backBody: u32(light, alpha) };
}

export const STALK = 1;
export const ROUND = 2;
export const FLAT = 4;

// the leaf's half width along its length t (0 base .. 1 tip): a birch leaf is widest at about a
// third and pointed, a round one nearly a circle with a small tip
const PROFILE = new Float32Array(257);
const PROFILE_ROUND = new Float32Array(257);
for (let i = 0; i <= 256; i++) {
  const t = i / 256;
  PROFILE[i] = Math.sin(Math.PI * t ** 0.62);
  PROFILE_ROUND[i] = Math.sqrt(Math.max(0, Math.sin(Math.PI * t ** 0.85)));
}

const MAX = 64;
const mask = new Uint8Array(MAX * MAX); // 1 leaf, 2 midrib, 3 stalk, 4 lit half
let mw = 0;
let mh = 0;
let mx = 0; // offset of the mask from the leaf's integer center
let my = 0;

// rasterizes a leaf centered at (fx, fy) relative to an integer pixel into `mask`; false if empty
function raster(fx, fy, L, rot, flip, style) {
  const stalk = (style & STALK) !== 0;
  const round = (style & ROUND) !== 0;
  const flat = (style & FLAT) !== 0;
  const prof = round ? PROFILE_ROUND : PROFILE;
  const half = L * 0.5;
  const c = Math.cos(rot);
  const sn = Math.sin(rot);
  const f = Math.max(0.24, Math.abs(flip));
  const back = flip < 0;
  const hwMax = L * (round ? 0.44 : 0.34);
  // the box around the leaf: along -half - stalk .. half, across +-(hwMax f) (screen px)
  const a0 = -half - (stalk ? 0.24 * L : 0) - 1;
  const a1 = half + 1;
  const b = hwMax * f + 1;
  const ex = Math.abs(sn) * Math.max(-a0, a1) + Math.abs(c) * b;
  const ey = Math.abs(c) * Math.max(-a0, a1) + Math.abs(sn) * b;
  const bx = Math.max(-31, Math.floor(fx - ex));
  const by = Math.max(-31, Math.floor(fy - ey));
  mw = Math.min(MAX, Math.ceil(fx + ex) - bx + 1);
  mh = Math.min(MAX, Math.ceil(fy + ey) - by + 1);
  mx = bx;
  my = by;
  let any = false;
  const rib = !back && !flat && !round && L >= 8;
  for (let j = 0; j < mh; j++) {
    const dy = by + j + 0.5 - fy;
    for (let i = 0; i < mw; i++) {
      const dx = bx + i + 0.5 - fx;
      const v = dx * sn + dy * c; // along the leaf: base -half, tip +half
      const w = dx * c - dy * sn; // across, on the screen
      const t = (v + half) / L;
      let m = 0;
      if (t >= 0 && t <= 1) {
        const hw = hwMax * f * prof[(t * 256) | 0];
        if (Math.abs(w) <= hw) m = rib && Math.abs(w) < 0.5 && t > 0.1 && t < 0.78 ? 2 : flat && dx < -hw * 0.2 && dy < hw * 0.6 ? 4 : 1;
      } else if (stalk && t < 0 && t > -0.24 && Math.abs(w) < 0.55) m = 3;
      mask[j * mw + i] = m;
      if (m) any = true;
    }
  }
  return any;
}

// the color of mask pixel (i, j): the edge where a 4-neighbour is outside the leaf (not when flat)
function color(i, j, pal, back, flat) {
  const k = j * mw + i;
  const m = mask[k];
  if (m === 3) return pal.edge;
  if (m === 4) return back ? pal.backBody : pal.rib;
  if (flat) return back ? pal.backEdge : pal.body;
  const out = i === 0 || j === 0 || i === mw - 1 || j === mh - 1 || !mask[k - 1] || !mask[k + 1] || !mask[k - mw] || !mask[k + mw];
  if (out) return back ? pal.backEdge : pal.edge;
  if (m === 2) return pal.rib;
  return back ? pal.backBody : pal.body;
}

/**
 * Draws one leaf. (cx, cy): its center in pixels, L: length base to tip (px), rot: 0 = tip down,
 * flip: -1..1 (squeeze across, < 0 = back side), pal: leafPalette(), style: STALK | ROUND | FLAT.
 */
export function drawLeaf(buf, W, H, cx, cy, L, rot, flip, pal, style = STALK) {
  const ix = Math.floor(cx);
  const iy = Math.floor(cy);
  if (!raster(cx - ix, cy - iy, L, rot, flip, style)) return;
  const back = flip < 0;
  const flat = (style & FLAT) !== 0;
  for (let j = 0; j < mh; j++) {
    const y = iy + my + j;
    if (y < 0 || y >= H) continue;
    for (let i = 0; i < mw; i++) {
      if (!mask[j * mw + i]) continue;
      const x = ix + mx + i;
      if (x >= 0 && x < W) buf[y * W + x] = color(i, j, pal, back, flat);
    }
  }
}

/** The pixels of a leaf that lies still, for blit(): { ox, oy, w, h, px } (0 = transparent). */
export function leafSprite(L, rot, flip, pal, style = STALK) {
  if (!raster(0.5, 0.5, L, rot, flip, style)) return { ox: 0, oy: 0, w: 0, h: 0, px: new Uint32Array(0) };
  const px = new Uint32Array(mw * mh);
  const back = flip < 0;
  const flat = (style & FLAT) !== 0;
  for (let j = 0; j < mh; j++) for (let i = 0; i < mw; i++) if (mask[j * mw + i]) px[j * mw + i] = color(i, j, pal, back, flat);
  return { ox: mx, oy: my, w: mw, h: mh, px };
}

export function blit(buf, W, H, cx, cy, spr) {
  const x0 = Math.floor(cx) + spr.ox;
  const y0 = Math.floor(cy) + spr.oy;
  for (let j = 0; j < spr.h; j++) {
    const y = y0 + j;
    if (y < 0 || y >= H) continue;
    const row = y * W;
    for (let i = 0; i < spr.w; i++) {
      const c = spr.px[j * spr.w + i];
      const x = x0 + i;
      if (c && x >= 0 && x < W) buf[row + x] = c;
    }
  }
}
