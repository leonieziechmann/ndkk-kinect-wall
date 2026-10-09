// Everything in front of the wood, in Betula's light look, drawn with Canvas 2D into one transparent
// layer (only when something on it changes):
//
//   hero   the contact card: an eyebrow label, the name, the lead, a hairline, mail and phone as
//          rows with green icons; as large as its text needs
//   signs  the QR codes on wooden signs stuck in the ground on two stakes, a little crooked, the
//          label painted on top, the code on a smooth light field (the leaf heap covers their lower
//          half, heap.js); all codes are the same size
//   post   a wooden signpost "Mehr von mir hier" whose arrow points at the signs
//
// Type follows Betula: Inter, tight negative tracking for large sizes, wide tracking for the small
// uppercase label, text / text-2 grays, the green accent for the label and the icons.

import { C } from './layout.js';

// lucide icons (ISC), 24 × 24
const ICON = {
  mail: ['M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z', 'm22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7'],
  phone: [
    'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z',
  ],
  github: [
    'M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4',
    'M9 18c-4.51 2-5-2-7-2',
  ],
};
const paths = Object.fromEntries(Object.entries(ICON).map(([k, list]) => [k, list.map((d) => new Path2D(d))]));

function icon(g, name, x, y, size, color, width = 2) {
  g.save();
  g.translate(x, y);
  g.scale(size / 24, size / 24);
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const p of paths[name]) g.stroke(p);
  g.restore();
}

/** Betula's mark: a white rounded square with the dark lenticels of a birch (32 × 32 grid). */
function betulaMark(g, x, y, size) {
  const k = size / 32;
  g.beginPath();
  g.roundRect(x, y, size, size, 7 * k);
  g.fillStyle = C.bark;
  g.fill();
  g.save();
  g.clip();
  g.fillStyle = C.barkInk;
  for (const [mx, my, mw] of [[0, 7, 13], [23, 12, 9], [0, 17, 5], [17, 22, 15]]) {
    g.fillRect(Math.round(x + mx * k), Math.round(y + my * k), Math.round(mw * k), Math.max(1, Math.round(3 * k)));
  }
  g.restore();
  g.beginPath();
  g.roundRect(x + 0.5, y + 0.5, size - 1, size - 1, 7 * k);
  g.strokeStyle = C.lineStrong;
  g.lineWidth = 1;
  g.stroke();
}

/** A panel: Betula's soft shadow, then the white face (nearly opaque) with its 1-LED line. */
function panel(g, r, radius, alpha, s, shape = null) {
  const path = () => {
    g.beginPath();
    if (shape) shape();
    else g.roundRect(r.x, r.y, r.w, r.h, radius);
  };
  g.save();
  path();
  g.shadowColor = 'rgba(15, 23, 42, 0.16)';
  g.shadowBlur = 14 * s;
  g.shadowOffsetY = 6 * s;
  g.fillStyle = '#000';
  g.fill();
  g.restore();
  // the shadow stays outside: clear the inside, then fill it
  g.save();
  path();
  g.clip();
  g.clearRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
  g.globalAlpha = alpha;
  g.fillStyle = C.panel;
  g.fillRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
  g.restore();
  g.save();
  g.translate(0.5, 0.5);
  path();
  g.strokeStyle = C.lineStrong;
  g.lineWidth = 1;
  g.stroke();
  g.restore();
}

// light pine, warm but not muddy; the code field is smooth and pale, the paint dark
const WOOD = {
  board: '#ecc58a',
  light: '#f7dcaa',
  shade: '#cf9c5c',
  grain: '#dcb06f',
  grain2: '#e4bb7e',
  edge: '#8f5d31',
  knot: '#c08848',
  field: '#f8ecd3',
  fieldHi: '#fff8ea',
  fieldLo: '#dcc195',
  ink: '#24180e',
  paint: '#3a2615',
  paint2: '#76522f',
  stake: '#d8a663',
  stakeGrain: '#bb874a',
  nail: '#4e331d',
};
const px32 = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return (0xff000000 | ((n & 255) << 16) | (n & 0xff00) | ((n >> 16) & 255)) >>> 0;
};
const WP = Object.fromEntries(Object.entries(WOOD).map(([k, v]) => [k, px32(v)]));

/**
 * A wooden board as pixel art into buf (Uint32 over a canvas of width cw) at (ox, oy): w × h,
 * chamfered corners (or an arrow tip on the right), bevel, outline, grain, a knot or two, and
 * optionally a smooth sunken field { x, y, w, h } (board coordinates) that keeps them out.
 */
function board(buf, cw, ox, oy, w, h, R, s, { field = null, arrow = false } = {}) {
  const cut = Math.max(2, Math.round(3 * s));
  const tip = arrow ? Math.round(h * 0.55) : 0;
  const inside = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    if (arrow && x >= w - tip) return Math.abs(y + 0.5 - h / 2) <= ((w - x) * (h / 2)) / tip;
    if (x + y < cut || x + (h - 1 - y) < cut) return false;
    if (!arrow && (w - 1 - x + y < cut || w - 1 - x + (h - 1 - y) < cut)) return false;
    return true;
  };
  const inField = (x, y) => field && x >= field.x && y >= field.y && x < field.x + field.w && y < field.y + field.h;
  // grain: long wavy lines with gaps, knots away from the field
  const lines = [];
  for (let y = 2; y < h - 2; y += 3 + R() * 4) lines.push({ y, f: 0.015 + R() * 0.03, a: 0.6 + R() * 1.6, ph: R() * 6.28, gap: R() * 6.28, c: R() < 0.5 ? WP.grain : WP.grain2 });
  const knots = [];
  for (let k = 0; k < 8 && knots.length < 1; k++) {
    const kx = 10 + R() * (w - 20 - tip);
    const ky = 6 + R() * (h - 12);
    if (!inField(kx, ky) && !inField(kx + 7, ky) && !inField(kx - 7, ky) && !inField(kx, ky + 5) && !inField(kx, ky - 5)) knots.push({ x: kx, y: ky, r: (2.2 + R() * 1.8) * s });
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue;
      let c = WP.board;
      if (!inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) c = WP.edge;
      else if (!inside(x - 2, y) || !inside(x, y - 2)) c = WP.light;
      else if (!inside(x + 2, y) || !inside(x, y + 2)) c = WP.shade;
      else if (inField(x, y)) {
        const fx = x - field.x;
        const fy = y - field.y;
        c = fx === 0 || fy === 0 ? WP.fieldLo : fx === field.w - 1 || fy === field.h - 1 ? WP.fieldHi : WP.field;
      } else {
        for (const l of lines) {
          const ly = l.y + Math.sin(x * l.f + l.ph) * l.a;
          if (Math.abs(y - ly) < 0.5 && Math.sin(x * 0.11 + l.gap) > -0.55) c = l.c;
        }
        for (const k of knots) {
          const d = Math.hypot((x - k.x) / 1.6, y - k.y);
          if (d < k.r) c = d < k.r * 0.45 ? WP.edge : WP.knot;
          else if (d < k.r + 1.2 && Math.abs(y - k.y) < k.r) c = WP.grain;
        }
      }
      buf[(oy + y) * cw + ox + x] = c;
    }
  }
}

/** A stake: a narrow upright piece of wood, outlined, with grain. */
function stake(buf, cw, ch, x0, y0, w, R) {
  const ph = R() * 6;
  for (let y = y0; y < ch; y++) {
    for (let x = 0; x < w; x++) {
      let c = WP.stake;
      if (x === 0 || x === w - 1) c = WP.edge;
      else if (x === 1) c = WP.light;
      else if (x === w - 2) c = WP.shade;
      else if (Math.abs(x - (w / 2 + Math.sin(y * 0.05 + ph) * w * 0.25)) < 0.5 && Math.sin(y * 0.2 + ph) > -0.4) c = WP.stakeGrain;
      buf[y * cw + x0 + x] = c;
    }
  }
}

/** Draws a sign canvas turned by `angle` around (cx, cy) (its board's middle at ax, ay), crisp. */
function placeTurned(g, img, cx, cy, ax, ay, angle, s) {
  g.save();
  g.imageSmoothingEnabled = false;
  g.translate(cx, cy);
  g.rotate(angle);
  g.shadowColor = 'rgba(15, 23, 42, 0.2)';
  g.shadowBlur = 12 * s;
  g.shadowOffsetX = 3 * s;
  g.shadowOffsetY = 5 * s;
  g.drawImage(img, -ax, -ay);
  g.restore();
}

function rngLocal(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setFont(g, weight, size, font, tracking = 0) {
  g.font = `${weight} ${size}px ${font}`;
  g.letterSpacing = `${(tracking * size).toFixed(2)}px`;
}

function text(g, str, x, y, color, align = 'left') {
  g.textAlign = align;
  g.textBaseline = 'alphabetic';
  g.fillStyle = color;
  g.fillText(str, x, y);
}

/** Splits `str` into lines no wider than maxW (with the current font). */
function wrap(g, str, maxW) {
  const lines = [];
  let line = '';
  for (const word of String(str).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && g.measureText(next).width > maxW) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export function createCards() {
  let canvas = null; // the contact card (in front of everything)
  let signCanvas = null; // the signs and the signpost (in the wood, at their depth)
  let g = null;
  let key = '';
  let hero = { x: 0, y: 0, w: 0, h: 0 };

  /**
   * Draws the two layers if anything changed; returns true then. d: { eyebrow, name, lead, mail,
   * phone, title, codes: [{ qr, label, small, mark, icon }], alpha }
   */
  function draw(L, d) {
    const k = JSON.stringify([L.W, L.H, L.signs.map((r) => [r.cx, r.cy, r.angle, r.bw, r.bh]), L.post, d.eyebrow, d.name, d.lead, d.mail, d.phone, d.title, d.codes.map((c) => [c.key, c.label, c.small, c.mark, c.icon]), d.alpha]);
    if (k === key && canvas) return false;
    key = k;
    if (!canvas || canvas.width !== L.W || canvas.height !== L.H) {
      canvas = new OffscreenCanvas(L.W, L.H);
      signCanvas = new OffscreenCanvas(L.W, L.H);
    }
    const { s, font } = L;
    g = canvas.getContext('2d');
    g.clearRect(0, 0, L.W, L.H);
    signCanvas.getContext('2d').clearRect(0, 0, L.W, L.H);

    // ---- the contact card: measure first, then draw
    const pad = Math.round(20 * s);
    const sizes = { eyebrow: Math.round(11.5 * s), name: Math.round(33 * s), lead: Math.round(15 * s), row: Math.round(15 * s), icon: Math.round(16 * s) };
    setFont(g, 600, sizes.name, font, -0.032);
    const nameW = g.measureText(d.name).width;
    setFont(g, 500, sizes.row, font, -0.006);
    const rowW = Math.max(d.mail ? g.measureText(d.mail).width : 0, d.phone ? g.measureText(d.phone).width : 0) + sizes.icon + 10 * s;
    const inner = Math.ceil(Math.max(nameW, rowW, 200 * s));
    setFont(g, 500, sizes.lead, font, -0.011);
    const leadLines = d.lead ? wrap(g, d.lead, inner) : [];
    const lineLead = Math.round(sizes.lead * 1.4);
    const rows = [d.mail && ['mail', d.mail], d.phone && ['phone', d.phone]].filter(Boolean);
    const lineRow = Math.round(sizes.row * 1.65);
    let h = pad;
    if (d.eyebrow) h += sizes.eyebrow + Math.round(12 * s);
    h += Math.round(sizes.name * 0.94);
    if (leadLines.length) h += Math.round(10 * s) + leadLines.length * lineLead - Math.round(lineLead - sizes.lead * 0.9);
    if (rows.length) h += Math.round(16 * s) + 1 + Math.round(12 * s) + rows.length * lineRow - Math.round(lineRow - sizes.row * 1.05);
    h += pad;
    hero = { x: L.hero.x, y: L.hero.y, w: inner + 2 * pad, h };
    panel(g, hero, 9 * s, d.alpha, s);
    const x0 = hero.x + pad;
    let y = hero.y + pad;
    if (d.eyebrow) {
      // the small uppercase label in the accent, with Betula's green dot
      y += sizes.eyebrow;
      g.fillStyle = C.accent;
      g.beginPath();
      g.arc(x0 + 3 * s, y - sizes.eyebrow * 0.36, 3 * s, 0, Math.PI * 2);
      g.fill();
      setFont(g, 600, sizes.eyebrow, font, 0.1);
      text(g, d.eyebrow.toUpperCase(), x0 + 11 * s, y, C.accentInk);
      y += Math.round(12 * s);
    }
    y += Math.round(sizes.name * 0.94) - Math.round(sizes.name * 0.2);
    setFont(g, 600, sizes.name, font, -0.032);
    text(g, d.name, x0 - Math.round(1.5 * s), y, C.text);
    y += Math.round(sizes.name * 0.2);
    if (leadLines.length) {
      setFont(g, 500, sizes.lead, font, -0.011);
      y += Math.round(10 * s) + Math.round(sizes.lead * 0.9);
      leadLines.forEach((line, i) => text(g, line, x0, y + i * lineLead, C.text2));
      y += (leadLines.length - 1) * lineLead;
    }
    if (rows.length) {
      y += Math.round(16 * s);
      g.fillStyle = C.line;
      g.fillRect(x0, y, inner, 1);
      y += 1 + Math.round(12 * s);
      setFont(g, 500, sizes.row, font, -0.006);
      rows.forEach(([ic, str], i) => {
        const base = y + Math.round(sizes.row * 1.05) + i * lineRow - Math.round(sizes.row * 0.15);
        icon(g, ic, x0, base - sizes.row * 0.78 - (sizes.icon - sizes.row * 0.78) / 2, sizes.icon, C.accent, 2);
        setFont(g, 500, sizes.row, font, -0.006);
        text(g, str, x0 + sizes.icon + Math.round(10 * s), base, C.text);
      });
    }

    // ---- the signpost: a wooden arrow on a stake (from here on: the signs' layer)
    g = signCanvas.getContext('2d');
    const R = rngLocal(4711);
    const p = L.post;
    if (d.title) {
      const sw = Math.round(6 * s);
      const len = L.H - p.y + Math.round(40 * s);
      const cw = p.w;
      const ch = p.h + len;
      const img = new OffscreenCanvas(cw, ch);
      const ig = img.getContext('2d');
      const data = ig.createImageData(cw, ch);
      const buf = new Uint32Array(data.data.buffer);
      const sx = Math.round(p.w * 0.38);
      stake(buf, cw, ch, sx, Math.round(p.h * 0.3), sw, R);
      board(buf, cw, 0, 0, p.w, p.h, R, s, { arrow: true });
      for (const ny of [0.3, 0.7]) buf[Math.round(p.h * ny) * cw + sx + Math.round(sw / 2)] = WP.nail;
      ig.putImageData(data, 0, 0);
      const cx = p.x + p.w / 2;
      const cy = p.y + p.h / 2;
      placeTurned(g, img, cx, cy, p.w / 2, p.h / 2, p.angle, s);
      let ts = Math.round(12 * s);
      setFont(g, 650, ts, font, -0.01);
      const maxW = p.w - p.h * 0.55 - 20 * s;
      const tw = g.measureText(d.title).width;
      if (tw > maxW) {
        ts = Math.floor((ts * maxW) / tw);
        setFont(g, 650, ts, font, -0.01);
      }
      g.save();
      g.translate(cx, cy);
      g.rotate(p.angle);
      text(g, d.title, -p.w / 2 + 12 * s, Math.round(ts * 0.36), WOOD.paint);
      g.restore();
    }

    // ---- the signs: boards on two stakes, the code on a smooth light field
    d.codes.forEach((c, i) => {
      const r = L.signs[i];
      if (!r) return;
      const { bw, bh, frame, labelH, quiet } = r;
      const code = r.code;
      const sw = Math.round(7 * s);
      const len = Math.round(L.H - (r.cy + bh / 2) + 40 * s);
      const cw = bw;
      const ch = bh + len;
      const img = new OffscreenCanvas(cw, ch);
      const ig = img.getContext('2d');
      const data = ig.createImageData(cw, ch);
      const buf = new Uint32Array(data.data.buffer);
      const stakes = [Math.round(bw * 0.24 - sw / 2), Math.round(bw * 0.76 - sw / 2)];
      for (const sx of stakes) stake(buf, cw, ch, sx, Math.round(bh * 0.25), sw, R);
      const field = { x: frame, y: frame + labelH, w: code.size + 2 * quiet, h: code.size + 2 * quiet };
      board(buf, cw, 0, 0, bw, bh, R, s, { field });
      // nails where the stakes are behind the board
      for (const sx of stakes) for (const ny of [frame * 0.5, bh - frame * 0.55]) buf[Math.round(ny) * cw + sx + Math.round(sw / 2)] = WP.nail;
      // the code
      const qx = field.x + quiet;
      const qy = field.y + quiet;
      const n = c.qr.size;
      for (let yy = 0; yy < n; yy++) {
        for (let xx = 0; xx < n; xx++) {
          if (!c.qr.get(xx, yy)) continue;
          for (let py = 0; py < code.mod; py++) {
            const row = (qy + yy * code.mod + py) * cw;
            buf.fill(WP.ink, row + qx + xx * code.mod, row + qx + (xx + 1) * code.mod);
          }
        }
      }
      ig.putImageData(data, 0, 0);
      placeTurned(g, img, r.cx, r.cy, bw / 2, bh / 2, r.angle, s);

      // the label painted on the board: Betula's mark or an icon, the name, the small line below
      g.save();
      g.translate(r.cx, r.cy);
      g.rotate(r.angle);
      let ls = Math.round(13.5 * s);
      const ms = c.mark || c.icon ? Math.round(14 * s) : 0;
      const mg = ms ? Math.round(5 * s) : 0;
      setFont(g, 650, ls, font, -0.012);
      const maxW = bw - 2 * frame - 6 * s;
      let lw = g.measureText(c.label).width;
      if (lw + ms + mg > maxW) {
        ls = Math.floor((ls * (maxW - ms - mg)) / lw);
        setFont(g, 650, ls, font, -0.012);
        lw = g.measureText(c.label).width;
      }
      const lx = Math.round(-(ms + mg + lw) / 2);
      const ly = Math.round(-bh / 2 + frame + ls * 1.0);
      if (c.mark) betulaMark(g, lx, Math.round(ly - ls * 0.72 - (ms - ls * 0.72) / 2), ms);
      else if (c.icon) icon(g, c.icon, lx, Math.round(ly - ls * 0.72 - (ms - ls * 0.72) / 2), ms, WOOD.paint, 2.2);
      setFont(g, 650, ls, font, -0.012);
      text(g, c.label, lx + ms + mg, ly, WOOD.paint);
      if (c.small) {
        let ss = Math.round(10.5 * s);
        setFont(g, 550, ss, font, 0);
        const sw2 = g.measureText(c.small).width;
        if (sw2 > maxW) {
          ss = Math.floor((ss * maxW) / sw2);
          setFont(g, 550, ss, font, 0);
        }
        text(g, c.small, 0, ly + Math.round(12.5 * s), WOOD.paint2, 'center');
      }
      g.restore();
    });
    return true;
  }

  return {
    draw,
    get canvas() {
      return canvas;
    },
    get signs() {
      return signCanvas;
    },
    /** the contact card's rect from the last draw */
    get hero() {
      return hero;
    },
  };
}
