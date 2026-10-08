// The text layer as pixel art, on top of everything: the school's logo rebuilt in pixels (three
// orange arches, "LUDWIG-LEICHHARDT-" in a hand-made 5x7 font, "GYMNASIUM" as serif capitals), a
// small Japanese line, the headline like a pixel game's title, the rotating subline, and the QR code
// on a paper card hanging from two cords. Drawn only when something changes; the QR never moves.

import { encodeQr } from './qr.js';
import { C, Pix, font57, grow, mask, stampTitle, textMask } from './pixel.js';

/**
 * The three sails of the logo (they recall the Sydney Opera House: Ludwig Leichhardt explored
 * Australia), each a mask of the same box: a thick band sweeping up from its foot to a pointed tip,
 * a short edge dropping on the right, a thin line inside. Coordinates from the original logo,
 * in units of the sails' height.
 */
const SAILS = [
  { foot: 0.0, thick: 0.2, tip: [0.96, 0.03], hook: [1.06, 0.47], inner: 0.4 },
  { foot: 0.46, thick: 0.18, tip: [1.27, 0.23], hook: [1.35, 0.66], inner: 0.82 },
  { foot: 0.76, thick: 0.16, tip: [1.47, 0.44], hook: [1.58, 0.9], inner: 1.08 },
];
function sailMasks(h) {
  const S = 6;
  const w = Math.round(h * 1.64);
  const toMask = (draw) => {
    const c = new OffscreenCanvas(w * S, h * S);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.scale(S * h, S * h);
    g.fillStyle = '#fff';
    g.strokeStyle = '#fff';
    g.lineCap = 'round';
    draw(g);
    const src = g.getImageData(0, 0, c.width, c.height).data;
    const m = mask(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) sum += src[((y * S + j) * c.width + x * S + i) * 4 + 3];
        m.d[y * w + x] = sum / (S * S * 255) >= 0.45 ? 1 : 0;
      }
    }
    return m;
  };
  return SAILS.map((sl) => {
    const [tx, ty] = sl.tip;
    const f = sl.foot;
    const band = toMask((g) => {
      // the band: outer edge up to the tip, inner edge back down
      g.beginPath();
      g.moveTo(f, 1);
      g.bezierCurveTo(f + 0.02, 0.45, f + 0.3, ty - 0.03, tx, ty);
      g.bezierCurveTo(tx - 0.12, ty + 0.2, f + sl.thick + 0.01, 0.62, f + sl.thick, 1);
      g.closePath();
      g.fill();
      // the back edge dropping from the tip
      g.lineWidth = 0.085;
      g.beginPath();
      g.moveTo(tx - 0.02, ty + 0.02);
      g.quadraticCurveTo(sl.hook[0] - 0.02, (ty + sl.hook[1]) / 2 - 0.05, sl.hook[0], sl.hook[1]);
      g.stroke();
    });
    const line = toMask((g) => {
      // the thin line inside
      g.lineWidth = 0.05;
      g.beginPath();
      g.moveTo(sl.inner, 1);
      g.bezierCurveTo(sl.inner + 0.03, 0.62, tx - 0.2, ty + 0.24, tx - 0.07, ty + 0.13);
      g.stroke();
    });
    return [band, line];
  });
}

/** The logo lockup, h art pixels high, as a Pix (transparent around it). */
function buildLogo(h) {
  const archH = Math.round(h * 0.72);
  const sails = sailMasks(archH);
  const aw = sails[0][0].w;
  const small = font57('LUDWIG-LEICHHARDT-');
  const capH = Math.max(7, h - archH - 3);
  const big = trimRows(textMask('GYMNASIUM', '"Times New Roman", Georgia, serif', Math.round(capH / 0.66), { weight: 700, ss: 6, threshold: 0.5 }));
  const w = Math.max(aw + 3, Math.round(aw * 0.62) + small.w + 3, big.w + 3);
  const pix = new Pix(w, archH + big.h + 5);
  // sails back to front, each with a dark outline over the one behind; lit upper edge, shaded
  // lower edge
  for (const m of sails.flat()) {
    pix.stamp(grow(m), 0, 0, C.sky0);
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        if (!m.d[y * m.w + x]) continue;
        const up = y > 0 && m.d[(y - 1) * m.w + x];
        const down = y < m.h - 1 && m.d[(y + 1) * m.w + x];
        pix.set(1 + x, 1 + y, !up ? C.o6 : !down ? C.o2 : C.o4);
      }
    }
  }
  // the name: the small line at the sails' feet, GYMNASIUM below, both to the right edge
  stampTitle(pix, small, w - small.w - 2, archH - small.h + 1, { fill: C.w });
  stampTitle(pix, big, w - big.w - 2, archH + 3, { fill: C.w });
  return pix;
}

/** The mask without its empty rows at the top and bottom. */
function trimRows(m) {
  const row = (y) => m.d.subarray(y * m.w, (y + 1) * m.w).some((v) => v);
  let y0 = 0;
  let y1 = m.h;
  while (y0 < y1 && !row(y0)) y0++;
  while (y1 > y0 && !row(y1 - 1)) y1--;
  const o = mask(m.w, Math.max(1, y1 - y0));
  o.d.set(m.d.subarray(y0 * m.w, y1 * m.w));
  o.base = m.base - y0;
  return o;
}

/** A five-petal blossom, 5 x 5. */
function blossom(pix, x, y) {
  const rows = ['.p.p.', 'pPPPp', '.PyP.', 'pPPPp', '..p..'];
  rows.forEach((r, j) => {
    for (let i = 0; i < 5; i++) if (r[i] !== '.') pix.set(x + i, y + j, { p: C.p4, P: C.p5, y: C.y1 }[r[i]]);
  });
}

/** The QR card: paper, the code with its quiet zone, the address with two blossoms. */
function drawCard(qr, mod, quiet, label) {
  const side = (qr.size + quiet * 2) * mod;
  const labelH = 11;
  const pix = new Pix(side, side + labelH);
  pix.rect(0, 0, side, side + labelH, C.y2);
  // rounded corners, one pixel
  for (const [x, y] of [
    [0, 0],
    [side - 1, 0],
    [0, side + labelH - 1],
    [side - 1, side + labelH - 1],
  ]) {
    pix.u32[y * side + x] = 0;
  }
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) if (qr.get(x, y)) pix.rect((x + quiet) * mod, (y + quiet) * mod, mod, mod, C.sky2);
  }
  const t = font57(label);
  const tx = Math.round((side - t.w) / 2);
  const ty = side - 2;
  pix.stamp(t, tx, ty, C.sky2);
  if (tx >= 9) {
    blossom(pix, tx - 8, ty + 1);
    blossom(pix, tx + t.w + 3, ty + 1);
  }
  return pix;
}

export async function createOverlay() {
  let qrKey = null;
  let qr = null;
  let card = null;
  let cardKey = '';
  let logo = null;
  let logoKey = '';
  let key = '';
  let pix = null;
  let cardRect = [0, 0, 0, 0];
  const masks = new Map(); // text masks by font, size and string

  function code(url) {
    if (url !== qrKey) {
      qrKey = url;
      try {
        qr = encodeQr(url || ' ', 'M');
      } catch (e) {
        console.warn(e);
        qr = encodeQr(' ', 'M');
      }
      cardKey = '';
    }
    return qr;
  }

  /** Card size for a module size and quiet zone (for the layout). */
  function cardSize(url, mod, quiet) {
    const side = (code(url).size + quiet * 2) * mod;
    return { w: side, h: side + 11 };
  }

  function text(str, font, size, weight, maxW) {
    const k = `${font}|${size}|${weight}|${str}`;
    let m = masks.get(k);
    if (!m) {
      if (masks.size > 64) masks.clear();
      m = textMask(str, font, size, { weight, ss: 6, threshold: 0.5 });
      // too wide: squeeze a little, then smaller
      if (m.w > maxW) m = textMask(str, font, size, { weight, ss: 6, threshold: 0.5, squeeze: Math.max(0.82, maxW / m.w) });
      while (m.w > maxW && size > 6) m = textMask(str, font, --size, { weight, ss: 6, threshold: 0.5, squeeze: 0.82 });
      masks.set(k, m);
    }
    return m;
  }

  /**
   * Draws the layer at the art resolution if anything changed; returns the canvas then (to upload),
   * else null. L: layout (main.js); t: { kicker, line1, line2, sub: [{ text, a, dy }], url, label }.
   */
  function update(AW, AH, L, t) {
    const q = code(t.url);
    const ck = `${qrKey},${L.mod},${L.quiet},${t.label}`;
    if (ck !== cardKey) {
      cardKey = ck;
      card = drawCard(q, L.mod, L.quiet, t.label.toUpperCase());
      key = '';
    }
    if (`${L.logoH}` !== logoKey) {
      logoKey = `${L.logoH}`;
      logo = buildLogo(L.logoH);
      key = '';
    }
    const k = JSON.stringify([AW, AH, L, t.kicker, t.line1, t.line2, t.sub]);
    if (k === key) return null;
    key = k;
    pix = new Pix(AW, AH);
    const maxW = L.textX1 - L.textX0;
    const left = L.textAlign !== 'right';
    const at = (w) => (left ? L.textX0 : L.textX1 - w);

    // the logo
    const lx = left ? L.textX0 - 2 : L.textX1 - logo.w + 2;
    const paste = (src, x0, y0) => {
      for (let y = 0; y < src.h; y++) {
        for (let x = 0; x < src.w; x++) {
          const v = src.u32[y * src.w + x];
          const X = x0 + x;
          const Y = y0 + y;
          if (v >>> 24 && X >= 0 && Y >= 0 && X < AW && Y < AH) pix.u32[Y * AW + X] = v;
        }
      }
    };
    paste(logo, lx, L.logoY);

    // under the logo: the small Japanese line in pink, then the headline
    let y = L.logoY + logo.h + 1;
    if (t.kicker) {
      const m = trimRows(text(t.kicker, L.jpFont, L.kickSize, 700, maxW));
      stampTitle(pix, m, at(m.w), y, { fill: C.p6 });
      y += m.h + 3;
    }
    // the headline: white, then orange, each with a dark outline and a pink drop shadow
    const hs = [t.line1, t.line2].filter(Boolean).map((s) => text(s, L.font, L.headSize, 900, maxW - 3));
    const b1 = y + Math.round(L.headSize * 0.74);
    const ys = [b1, b1 + Math.round(L.headSize * 1.02)];
    const fills = [
      [C.w, C.p7],
      [C.o4, C.o6],
    ];
    hs.forEach((m, i) => stampTitle(pix, m, at(m.w), ys[i] - m.base, { fill: fills[i][0], top: fills[i][1], shadow: C.p3, shadowOff: 2 }));
    // the subline, sliding in and out (whole pixels, no fading: alpha only switches it)
    for (const s of t.sub) {
      if (s.a < 0.5) continue;
      const m = text(s.text, L.subFont, L.subSize, 700, maxW);
      const y = L.subY - m.base + Math.round(s.dy);
      if (y < L.subY - m.base - L.subSize || y > AH) continue;
      stampTitle(pix, m, at(m.w), y, { fill: C.p8 });
    }

    // the QR card on two cords from the top edge
    for (const fx of [0.2, 0.8]) {
      const cx = Math.round(L.cardX + card.w * fx);
      pix.line(cx + (fx < 0.5 ? -4 : 4), 0, cx, L.cardY - 1, C.g6);
      pix.set(cx, L.cardY - 1, C.p5);
    }
    pix.rect(L.cardX - 1, L.cardY - 1, card.w + 2, card.h + 2, C.sky0);
    paste(card, L.cardX, L.cardY);
    cardRect = [L.cardX, L.cardY, L.cardX + card.w, L.cardY + card.h];
    return pix.toCanvas();
  }

  return {
    update,
    cardSize,
    get card() {
      return cardRect;
    },
  };
}
