// The backdrop as pixel art: a spring night at the Ludwig-Leichhardt-Gymnasium, drawn pixel by pixel
// at the art resolution (one art pixel = 2 x 2 LEDs by default).
//
// A dithered twilight sky (navy at the top, violet, a pink glow at the horizon), a crescent moon,
// flat clouds lit from below, the Plattenbau skyline of Cottbus with a few lit windows, the school
// (grey panel blocks, the orange tower, "ライヒハルト高校" in orange on the facade as on the real
// building, ribbon windows, the glass front with colored panels), a vending machine, the paved
// yard with the granite benches and fallen petals, the cherry trunks and the lantern string.
// Everything that moves or lights up (stars, windows, crowns, lanterns, petals, the cat's eyes) is
// drawn on the GPU from the lists returned here.

import { C, Pix, bayer, rng, textMask } from './pixel.js';

const SKY = ['sky0', 'sky1', 'sky2', 'sky3', 'sky4', 'sky5', 'sky6', 'sky7', 'sky8', 'sky9', 'sky10', 'sky11', 'sky12'].map((k) => C[k]);
const JP_FONT = '"Yu Gothic UI", "Yu Gothic", Meiryo, "MS Gothic", sans-serif';

/** A flat cloud from a few ellipses: violet body, lit pink along its underside. */
function cloud(pix, R, cx, cy, w, h) {
  const parts = [];
  const n = Math.max(2, Math.round(w / (h * 2.2)));
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const bump = Math.sin(t * Math.PI);
    parts.push([cx + (t - 0.5) * w * 0.8, cy - bump * h * 0.35 - R() * h * 0.2, (w / n) * (0.7 + R() * 0.3), h * (0.4 + bump * 0.45)]);
  }
  const inside = (x, y) => parts.some(([px, py, rx, ry]) => ((x + 0.5 - px) / rx) ** 2 + ((y + 0.5 - py) / ry) ** 2 <= 1);
  const box = [cx - w, cy - h * 1.5, cx + w, cy + h * 1.2];
  pix.shade(...box, (x, y) => {
    if (!inside(x, y)) return null;
    if (!inside(x, y + 1)) return C.sky11;
    if (!inside(x, y + 2)) return C.sky9;
    if (!inside(x, y - 1)) return C.sky7;
    return (x + y) % 2 && !inside(x, y + 3) ? C.sky7 : C.sky6;
  });
}

/**
 * Paints the backdrop at the art resolution AW x AH. L (main.js): which side the QR card is on.
 * Returns the canvas and what the GPU draws on top.
 */
export function paintScene(AW, AH, L) {
  const R = rng(20261010);
  const pix = new Pix(AW, AH);
  const s = AH / 168; // 1 at 504 x 168
  const right = L.qrRight;
  const X = (f) => Math.round((right ? f : 1 - f) * AW);
  const span = (f0, f1) => {
    const a = X(f0);
    const b = X(f1);
    return [Math.min(a, b), Math.max(a, b)];
  };
  const hz = Math.round(AH * 0.7); // the horizon: the yard starts here

  // ---- sky: a dithered ramp through the night colors
  pix.shade(0, 0, AW, hz + 1, (x, y) => {
    const t = y / hz;
    const k = (SKY.length - 1) * Math.pow(t, 1.75);
    const i = Math.min(SKY.length - 2, Math.floor(k));
    return k - i > bayer(x, y) ? SKY[i + 1] : SKY[i];
  });

  // moon: a crescent with a soft dithered halo
  const moon = [X(0.705), Math.round(AH * 0.13)];
  const mr = 7 * s;
  pix.shade(moon[0] - mr * 2.2, moon[1] - mr * 2.2, moon[0] + mr * 2.2, moon[1] + mr * 2.2, (x, y) => {
    const d = Math.hypot(x + 0.5 - moon[0], y + 0.5 - moon[1]);
    const cut = Math.hypot(x + 0.5 - moon[0] - mr * 0.45, y + 0.5 - moon[1] + mr * 0.3);
    if (d <= mr && cut > mr * 0.85) return cut < mr * 0.98 ? C.y1 : C.y2;
    if (d <= mr + 3 * s && (x + y) % 2 === 0) return C.sky3;
    return null;
  });

  // stars: the upper sky (twinkling on the GPU)
  const stars = [];
  for (let i = 0; i < 200 && stars.length < 70; i++) {
    const x = Math.floor(R() * AW);
    const y = Math.floor(Math.pow(R(), 1.5) * AH * 0.48);
    if (Math.hypot(x - moon[0], y - moon[1]) < 16 * s) continue;
    stars.push({ x, y, big: R() < 0.12, phase: R() * 6.283, speed: 0.5 + R() * 2.5, b: 0.4 + R() * 0.6 });
  }

  // clouds: long flat streaks in the lower sky
  for (const [f, y, w, h] of [
    [0.13, 0.47, 70, 7],
    [0.5, 0.33, 54, 5],
    [0.6, 0.53, 80, 7],
    [0.92, 0.4, 56, 6],
    [0.31, 0.25, 40, 4],
  ]) {
    cloud(pix, R, X(f), Math.round(AH * y), w * s, h * s);
  }

  // ---- the skyline of Cottbus: Plattenbau blocks, their windows a regular grid, a few lit
  let bx = -4;
  while (bx < AW + 4) {
    const w = Math.round((14 + R() * 30) * s);
    const h = Math.round((5 + R() * R() * 17) * s);
    const col = R() < 0.5 ? C.sky2 : C.sky3;
    pix.rect(bx, hz - h, w, h + 1, col);
    pix.rect(bx, hz - h, w, 1, C.sky4);
    for (let wy = hz - h + 2; wy < hz - 1; wy += 2) {
      for (let wx = bx + 1; wx < bx + w - 1; wx += 2) {
        const r = R();
        if (r < 0.07) pix.set(wx, wy, r < 0.025 ? C.y1 : C.o5);
        else if (r < 0.3) pix.set(wx, wy, C.sky1);
      }
    }
    bx += w + (R() < 0.3 ? Math.round(R() * 8 * s) : 0);
  }
  // hedges along the horizon
  pix.shade(0, hz - 6 * s, AW, hz + 1, (x, y) => {
    const top = hz - 2 * s - 2.5 * s * (1 + Math.sin(x * 0.55) * 0.6 + Math.sin(x * 0.17 + 1) * 0.4);
    if (y < top) return null;
    return y < top + 1 ? C.sky3 : C.sky1;
  });

  // ---- the school
  const windows = [];
  const lights = []; // blinking red lights (antenna)
  const base = hz + Math.round(3 * s);
  // the left wing: lower, behind the text column
  {
    const [x0, x1] = span(0.2, 0.43);
    const top = Math.round(AH * 0.5);
    pix.rect(x0, top, x1 - x0, base - top, C.g2);
    pix.rect(x0, top, x1 - x0, 1, C.g5);
    pix.rect(x0, top + 1, x1 - x0, 1, C.g1);
    for (let row = 0; row < 2; row++) {
      const wy = top + Math.round((5 + row * 11) * s);
      for (let wx = x0 + 3; wx + 5 < x1 - 2; wx += Math.round(8 * s)) {
        pix.rect(wx - 1, wy - 1, 6, 8, C.g1);
        pix.rect(wx, wy, 4, 6, C.g0);
        pix.set(wx + 3, wy, C.g3);
        windows.push({ x: wx, y: wy, w: 4, h: 6, kind: 0 });
      }
    }
  }
  // the main block: concrete panels, roof units, the orange letters, two ribbons of windows,
  // the glass front
  const [mx0, mx1] = span(0.445, 0.765);
  const mTop = Math.round(AH * 0.31);
  {
    pix.shade(mx0, mTop, mx1, base, (x, y) => {
      const panelX = (x - mx0) % Math.round(12 * s) === 0;
      const panelY = (y - mTop) % Math.round(9 * s) === 0;
      if (panelX || panelY) return C.g2;
      return y - mTop < 3 ? C.g4 : C.g3;
    });
    pix.rect(mx0, mTop, mx1 - mx0, 1, C.g6);
    // the side face in shadow (the far end, away from the tower)
    const side = Math.round(4 * s);
    pix.rect(right ? mx1 : mx0 - side, mTop + 1, side, base - mTop - 1, C.g1);
    // roof: units, a railing, an antenna with a red light
    for (const [f, w, h] of [
      [0.2, 10, 4],
      [0.27, 6, 3],
      [0.7, 12, 5],
    ]) {
      const ux = Math.round(mx0 + (mx1 - mx0) * f);
      pix.rect(ux, mTop - h, w, h, C.g1);
      pix.rect(ux, mTop - h, w, 1, C.g4);
    }
    for (let x = mx0 + 1; x < mx1; x += 3) pix.set(x, mTop - 2, C.g1);
    pix.rect(mx0, mTop - 1, mx1 - mx0, 1, C.g1);
    const ax = Math.round(mx0 + (mx1 - mx0) * 0.86);
    pix.rect(ax, mTop - Math.round(14 * s), 1, Math.round(14 * s), C.g1);
    pix.rect(ax - 2, mTop - Math.round(10 * s), 5, 1, C.g1);
    lights.push({ x: ax, y: mTop - Math.round(15 * s), phase: 0 });

    // ライヒハルト高校: orange, shadow below, the upper edge lit
    const letters = textMask('ライヒハルト高校', JP_FONT, Math.round(15 * s), { weight: 800, ss: 4, threshold: 0.45 });
    const lx = Math.round((mx0 + mx1 - letters.w) / 2);
    const ly = mTop + Math.round(4 * s);
    pix.stamp(letters, lx + 1, ly + 1, C.o0);
    pix.stamp(letters, lx, ly, C.o4);
    for (let j = 0; j < letters.h; j++) {
      for (let i = 0; i < letters.w; i++) if (letters.d[j * letters.w + i] && (j === 0 || !letters.d[(j - 1) * letters.w + i])) pix.set(lx + i, ly + j, C.o6);
    }

    const wTop = ly + letters.h + Math.round(3 * s);
    for (let row = 0; row < 2; row++) {
      const wy = wTop + Math.round(row * 10 * s);
      for (let wx = mx0 + 4; wx + 5 < mx1 - 3; wx += Math.round(7 * s)) {
        pix.rect(wx - 1, wy - 1, 6, 8, C.g1);
        pix.rect(wx, wy, 4, 6, C.g0);
        pix.set(wx + 3, wy, C.g2);
        pix.set(wx - 1, wy + 7, C.g5); // sill
        pix.set(wx + 4, wy + 7, C.g5);
        pix.rect(wx, wy + 7, 4, 1, C.g4);
        windows.push({ x: wx, y: wy, w: 4, h: 6, kind: 0 });
      }
    }
    // the glass front: mullions, panels lit from inside, some colored (as on the real building)
    const gy = wTop + Math.round(21 * s);
    const gh = base - gy - 1;
    pix.rect(mx0 + 2, gy - 2, mx1 - mx0 - 4, 1, C.g5);
    pix.rect(mx0 + 2, gy - 1, mx1 - mx0 - 4, gh + 2, C.g0);
    const colors = [C.c2, C.b0, C.c3, C.p4, C.sky8, C.b1];
    let ci = 0;
    const door = Math.round(mx0 + (mx1 - mx0) * 0.38);
    for (let wx = mx0 + 3; wx + 6 < mx1 - 2; wx += 7) {
      const isDoor = Math.abs(wx - door) < 4;
      const col = !isDoor && R() < 0.4 ? colors[ci++ % colors.length] : null;
      windows.push({ x: wx, y: gy, w: 6, h: gh, kind: isDoor ? 3 : col ? 2 : 1, color: col });
    }
  }
  // the orange tower in front of the main block's near end
  {
    const [tx0, tx1] = span(0.405, 0.452);
    const top = Math.round(AH * 0.18);
    const w = tx1 - tx0;
    pix.rect(tx0, top, w, base - top, C.o3);
    const litW = Math.round(w * 0.3);
    const shW = Math.round(w * 0.2);
    pix.rect(right ? tx0 : tx1 - litW, top, litW, base - top, C.o4);
    pix.rect(right ? tx1 - shW : tx0, top, shW, base - top, C.o2);
    pix.rect(tx0, top, w, 1, C.o6);
    pix.rect(tx0, top + 1, w, 1, C.o5);
    for (let wy = top + Math.round(7 * s); wy < base - 14 * s; wy += Math.round(10 * s)) {
      const wx = Math.round(tx0 + w / 2 - 2);
      pix.rect(wx - 1, wy - 1, 6, 7, C.o1);
      pix.rect(wx, wy, 4, 5, C.o0);
      windows.push({ x: wx, y: wy, w: 4, h: 5, kind: 0, tower: true });
    }
  }

  // ---- the yard: paving slabs in perspective, petals, the granite benches
  {
    const rows = [];
    let y = hz + 1;
    let h = 2;
    while (y < AH) {
      rows.push([y, h]);
      y += h + 1;
      h = Math.round(h * 1.32 + 0.6);
    }
    pix.rect(0, hz, AW, AH - hz, C.sky3);
    pix.rect(0, hz, AW, 1, C.sky1);
    for (const [ry, rh] of rows) {
      pix.rect(0, ry + rh, AW, 1, C.sky2);
      const step = Math.round((10 + rh * 3.2) * s);
      let jx = Math.floor(R() * step);
      while (jx < AW) {
        pix.rect(jx, ry, 1, rh, C.sky2);
        if (R() < 0.18) pix.rect(jx + 1, ry, Math.min(step - 1, AW - jx - 1), rh, C.sky4); // a lighter slab
        jx += step;
      }
      for (let k = 0; k < AW * 0.02 * rh; k++) {
        const r = R();
        pix.set(Math.floor(R() * AW), ry + Math.floor(R() * rh), r < 0.4 ? C.p4 : r < 0.7 ? C.p3 : C.p5);
      }
    }
    for (const [f0, f1, yy] of [
      [0.47, 0.58, 0.8],
      [0.62, 0.74, 0.78],
      [0.07, 0.19, 0.81],
    ]) {
      const [b0, b1] = span(f0, f1);
      const by = Math.round(AH * yy);
      pix.rect(b0, by, b1 - b0, 1, C.g7);
      pix.rect(b0, by + 1, b1 - b0, 1, C.g6);
      pix.rect(b0, by + 2, b1 - b0, Math.round(4 * s), C.g4);
      pix.rect(b0, by + 2, 1, Math.round(4 * s), C.g5);
      pix.rect(b0 + 1, by + 2 + Math.round(4 * s), b1 - b0 - 2, 1, C.sky0);
    }
  }

  // a vending machine by the entrance (lit on the GPU too)
  const vend = { x: X(0.6) - 5, y: base - Math.round(19 * s), w: 10, h: Math.round(19 * s) };
  {
    const { x, y, w, h } = vend;
    pix.rect(x, y, w, h, C.c0);
    pix.rect(x, y, w, 1, C.c2);
    pix.rect(x + 1, y + 2, w - 2, 7, C.c3);
    const drinks = [C.p5, C.o5, C.b1, C.w, C.c2, C.o4, C.p6, C.y1];
    for (let row = 0; row < 3; row++) for (let col = 0; col < 4; col++) pix.set(x + 2 + col * 2, y + 3 + row * 2, drinks[(row * 4 + col) % drinks.length]);
    pix.rect(x + 1, y + 10, w - 2, 1, C.c1);
    pix.rect(x + 1, y + 12, 3, 2, C.y1);
    pix.rect(x + 2, y + h - 4, w - 4, 2, C.sky0);
    pix.rect(x - 1, y + h, w + 2, 1, C.sky0);
  }

  // ---- the cherry trees: trunks and branches here, the crowns are blobs on the GPU
  const trees = [];
  for (const [f, crownY, rx, ry, trunkY] of [
    [0.055, 0.36, 40, 27, 0.86],
    [0.355, 0.4, 32, 23, 0.83],
    [0.805, 0.37, 33, 24, 0.85],
    [0.99, 0.3, 35, 26, 0.84],
  ]) {
    const tr = { x: X(f), cx: X(f), cy: Math.round(AH * crownY), rx: rx * s, ry: ry * s, base: Math.round(AH * trunkY), blobs: [], dots: [] };
    trees.push(tr);
    // fallen petals around the trunk
    for (let i = 0; i < 60; i++) {
      const a = R() * Math.PI * 2;
      const d = Math.sqrt(R());
      const x = tr.x + Math.cos(a) * d * tr.rx * 1.2;
      const y = tr.base + Math.sin(a) * d * 5 * s;
      if (y > hz + 1) pix.set(x, y, R() < 0.5 ? C.p5 : C.p4);
    }
    // the trunk: tapering spans, lit on the left edge, a dark right edge; branches as lines
    const top = tr.cy + Math.round(tr.ry * 0.2);
    const lean = Math.round((R() - 0.5) * 6 * s);
    for (let y = top; y <= tr.base; y++) {
      const u = (y - top) / Math.max(1, tr.base - top);
      const w = Math.max(2, Math.round((2 + u * 2.6) * s));
      const cx = Math.round(tr.x + lean * (1 - u) + Math.sin(u * 5) * 0.8);
      pix.rect(cx - Math.floor(w / 2), y, w, 1, C.t1);
      pix.set(cx - Math.floor(w / 2), y, C.t2);
      pix.set(cx - Math.floor(w / 2) + w - 1, y, C.t0);
    }
    pix.rect(tr.x - 3, tr.base, 7, 1, C.sky1); // its shadow on the ground
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI / 2 + (i / 6 - 0.5) * 2.6 + (R() - 0.5) * 0.3;
      const len = (0.55 + R() * 0.45) * (Math.abs(Math.cos(a)) * tr.rx + Math.abs(Math.sin(a)) * tr.ry);
      const x0 = tr.x + lean;
      const y0 = top + Math.round(R() * 4 * s);
      const x1 = x0 + Math.cos(a) * len;
      const y1 = y0 + Math.sin(a) * len * 0.8;
      pix.line(x0, y0, x1, y1, C.t0);
      if (i % 2 === 0) pix.line(x0 + 1, y0, (x0 + x1) / 2 + 1, (y0 + y1) / 2, C.t0);
    }
    // the crown: discs in four tones (cel shading: dark rim below, light upper left), then
    // single blossom pixels on top
    const lobes = [];
    for (let i = 0; i < 5; i++) lobes.push([tr.cx + (R() - 0.5) * tr.rx * 1.3, tr.cy + (R() - 0.5) * tr.ry * 0.9, 0.45 + R() * 0.25]);
    const inCrown = (x, y) => {
      for (const [lx, ly, lr] of lobes) if (((x - lx) / (tr.rx * lr)) ** 2 + ((y - ly) / (tr.ry * lr * 1.1)) ** 2 < 1) return true;
      return ((x - tr.cx) / tr.rx) ** 2 + ((y - tr.cy) / tr.ry) ** 2 < 0.75;
    };
    const sample = (n, rMin, rMax, tone, bias) => {
      for (let i = 0, made = 0; i < n * 10 && made < n; i++) {
        const x = tr.cx + (R() * 2 - 1) * tr.rx * 1.05;
        const y = tr.cy + (R() * 2 - 1) * tr.ry * 1.05;
        if (!inCrown(x, y)) continue;
        const lx = (x - tr.cx) / tr.rx;
        const ly = (y - tr.cy) / tr.ry;
        if (bias && lx * bias[0] + ly * bias[1] < bias[2] + (R() - 0.5) * 0.5) continue;
        made++;
        tr.blobs.push({ x: Math.round(x), y: Math.round(y), r: Math.round((rMin + R() * (rMax - rMin)) * s * 2) / 2, tone, phase: R() * 6.283, h: (tr.base - y) / (tr.base - tr.cy + tr.ry) });
      }
    };
    sample(34, 5, 8.5, 0, null);
    sample(36, 4, 7, 1, [-0.6, -0.8, -0.55]);
    sample(28, 2.5, 4.5, 2, [-0.6, -0.8, 0.05]);
    sample(14, 1.5, 2.5, 3, [-0.5, -0.9, 0.25]);
    for (let i = 0; i < 90; i++) {
      const x = tr.cx + (R() * 2 - 1) * tr.rx;
      const y = tr.cy + (R() * 2 - 1) * tr.ry;
      if (!inCrown(x, y)) continue;
      const upper = (x - tr.cx) / tr.rx + (y - tr.cy) / tr.ry < 0;
      tr.dots.push({ x: Math.round(x), y: Math.round(y), tone: upper ? (R() < 0.5 ? 4 : 5) : R() < 0.5 ? 6 : 4, phase: R() * 6.283, h: (tr.base - y) / (tr.base - tr.cy + tr.ry) });
    }
  }

  // ---- the lantern string between the middle trees (a sagging line); lanterns hang from it
  const lanterns = [];
  {
    const [a0, a1] = span(0.36, 0.8);
    const y0 = AH * 0.11;
    const sag = AH * 0.07;
    const at = (u) => [a0 + (a1 - a0) * u, y0 + sag * 4 * u * (1 - u) + (u - 0.5) * 2 * s];
    let prev = at(0);
    for (let i = 1; i <= 60; i++) {
      const p = at(i / 60);
      pix.line(prev[0], prev[1], p[0], p[1], C.sky0);
      prev = p;
    }
    const n = 7;
    for (let i = 0; i < n; i++) {
      const [x, y] = at((i + 0.5) / n);
      lanterns.push({ x: Math.round(x), y: Math.round(y), len: Math.round((2 + (i % 2) * 3) * s), phase: R() * 6.283 });
    }
  }

  // the cat on the bench in front of the school (its eyes blink on the GPU)
  const [cb0, cb1] = span(0.62, 0.74);
  const cat = { x: Math.round(cb0 + (cb1 - cb0) * 0.3), y: Math.round(AH * 0.78) };
  {
    const sprite = ['..#...#..', '..##.##..', '..#####..', '..#####..', '.#######.', '########.', '#########', '.########'];
    const tail = right ? 1 : -1;
    sprite.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) if (row[i] === '#') pix.set(cat.x + (tail > 0 ? i : row.length - 1 - i), cat.y - sprite.length + j, C.sky0);
    });
    for (let j = 0; j < 4; j++) pix.set(cat.x + (tail > 0 ? 9 : -1) + (j === 0 ? 0 : tail * Math.min(j, 2)), cat.y - 1 - j, C.sky0);
    cat.eyes = [cat.x + (tail > 0 ? 3 : 5), cat.y - 5, cat.x + (tail > 0 ? 5 : 3), cat.y - 5];
  }

  return { pix, canvas: pix.toCanvas(), stars, windows, trees, lanterns, lights, vend, cat, horizon: hz, moon, scale: s };
}
