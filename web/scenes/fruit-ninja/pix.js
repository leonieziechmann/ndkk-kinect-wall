// The pixel layer (from space-invaders): an RGBA buffer at LED resolution, drawn in blocks. Every "art
// pixel" is a block of S x S LEDs (the blocky look), but a block sits wherever its position falls, to
// the LED (sub-block placement: smooth motion, crisp shapes). `unit` draws smaller blocks for detail
// (0.5: S/2 x S/2 LEDs). Nothing finer than 2 LEDs, so the LED wall shows no moiré.
// Also: a small pixel font (digits, x, +, -) and the crown.

/** '#rrggbb' -> [r, g, b] 0..1 */
export function rgb(hex) {
  const v = Number.parseInt(String(hex).slice(1), 16) || 0;
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export const WHITE = [1, 1, 1];

export class Pix {
  constructor(W = 8, H = 8, S = 1) {
    this.resize(W, H, S);
  }

  resize(W, H, S = 1) {
    this.W = W;
    this.H = H;
    this.S = S;
    this.w = Math.floor(W / S); // in art pixels
    this.h = Math.floor(H / S);
    this.buf = new Uint8ClampedArray(W * H * 4);
  }

  clear() {
    this.buf.fill(0);
  }

  /** one LED, color c [r, g, b] 0..1, opacity a: laid over what is there */
  dot(X, Y, c, a = 1) {
    if (X < 0 || Y < 0 || X >= this.W || Y >= this.H || !(a > 0.004)) return;
    const b = this.buf;
    const i = (Y * this.W + X) * 4;
    const da = b[i + 3] / 255;
    if (a >= 1 || da === 0) {
      b[i] = c[0] * 255;
      b[i + 1] = c[1] * 255;
      b[i + 2] = c[2] * 255;
      b[i + 3] = Math.max(a, da) * 255;
      return;
    }
    const oa = a + da * (1 - a);
    const k = a / oa;
    b[i] += (c[0] * 255 - b[i]) * k;
    b[i + 1] += (c[1] * 255 - b[i + 1]) * k;
    b[i + 2] += (c[2] * 255 - b[i + 2]) * k;
    b[i + 3] = oa * 255;
  }

  /** a block of `unit` art pixels with its top left corner at art (x, y), placed to the LED */
  put(x, y, c, a = 1, unit = 1) {
    if (!(a > 0.004)) return;
    const n = Math.max(1, Math.round(unit * this.S));
    const X = Math.round(x * this.S);
    const Y = Math.round(y * this.S);
    if (X >= this.W || Y >= this.H || X + n <= 0 || Y + n <= 0) return;
    if (a >= 1) {
      // opaque: straight into the buffer
      const r = c[0] * 255;
      const g = c[1] * 255;
      const bl = c[2] * 255;
      const b = this.buf;
      for (let j = Math.max(0, Y); j < Math.min(this.H, Y + n); j++) {
        let i = (j * this.W + Math.max(0, X)) * 4;
        for (let k = Math.max(0, X); k < Math.min(this.W, X + n); k++, i += 4) {
          b[i] = r;
          b[i + 1] = g;
          b[i + 2] = bl;
          b[i + 3] = 255;
        }
      }
      return;
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) this.dot(X + i, Y + j, c, a);
  }

  /** a line of blocks from (x0, y0) to (x1, y1), centered on the line */
  line(x0, y0, x1, y1, c, a = 1, unit = 1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (unit * 0.7)));
    let lx = null;
    let ly = null;
    for (let k = 0; k <= n; k++) {
      const x = x0 + (dx * k) / n - unit / 2;
      const y = y0 + (dy * k) / n - unit / 2;
      const X = Math.round(x * this.S);
      const Y = Math.round(y * this.S);
      if (X === lx && Y === ly) continue;
      lx = X;
      ly = Y;
      this.put(x, y, c, a, unit);
    }
  }

  /** a filled disc of blocks */
  disc(cx, cy, r, c, a = 1, unit = 1) {
    const n = Math.ceil(r / unit);
    const rr = r * r;
    for (let j = -n; j <= n; j++) {
      for (let i = -n; i <= n; i++) {
        const x = (i + 0.5) * unit;
        const y = (j + 0.5) * unit;
        if (x * x + y * y <= rr) this.put(cx + x - unit / 2, cy + y - unit / 2, c, a, unit);
      }
    }
  }

  /** a ring of blocks */
  ring(cx, cy, r, w, c, a = 1, unit = 1) {
    const n = Math.ceil((r + w) / unit) + 1;
    for (let j = -n; j <= n; j++) {
      for (let i = -n; i <= n; i++) {
        const d = Math.hypot((i + 0.5) * unit, (j + 0.5) * unit);
        if (Math.abs(d - r) < w / 2) this.put(cx + (i + 0.5) * unit - unit / 2, cy + (j + 0.5) * unit - unit / 2, c, a, unit);
      }
    }
  }

  /** a bitmap (rows of '#' and '.') with its center at (cx, cy), pixels of `unit` art px */
  bitmap(rows, cx, cy, c, a = 1, unit = 1) {
    const h = rows.length;
    const w = rows[0].length;
    const x0 = cx - (w * unit) / 2;
    const y0 = cy - (h * unit) / 2;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (rows[j][i] !== '.') this.put(x0 + i * unit, y0 + j * unit, c, a, unit);
  }

  /** text of digits, x, +, - centered at (cx, cy); h = glyph height in art px */
  text(str, cx, cy, h, c, a = 1) {
    const unit = h / 5;
    const adv = 4 * unit;
    const x0 = cx - (adv * str.length - unit) / 2;
    for (let k = 0; k < str.length; k++) {
      const g = FONT[str[k]];
      if (!g) continue;
      for (let j = 0; j < 5; j++) for (let i = 0; i < 3; i++) if (g[j][i] === '#') this.put(x0 + k * adv + i * unit, cy - h / 2 + j * unit, c, a, unit);
    }
  }
}

// 3 x 5 pixel font
const FONT = {
  0: ['###', '#.#', '#.#', '#.#', '###'],
  1: ['.#.', '##.', '.#.', '.#.', '###'],
  2: ['###', '..#', '###', '#..', '###'],
  3: ['###', '..#', '.##', '..#', '###'],
  4: ['#.#', '#.#', '###', '..#', '..#'],
  5: ['###', '#..', '###', '..#', '###'],
  6: ['###', '#..', '###', '#.#', '###'],
  7: ['###', '..#', '.#.', '.#.', '.#.'],
  8: ['###', '#.#', '###', '#.#', '###'],
  9: ['###', '#.#', '###', '..#', '###'],
  x: ['...', '#.#', '.#.', '#.#', '...'],
  '+': ['...', '.#.', '###', '.#.', '...'],
  '-': ['...', '...', '###', '...', '...'],
};

/** the winner's crown, 9 x 6 art px: 'g' gold, 'j' jewels */
export const CROWN = ['#...#...#', '##.###.##', '#########', '#j##j##j#', '#########', '.#######.'];
