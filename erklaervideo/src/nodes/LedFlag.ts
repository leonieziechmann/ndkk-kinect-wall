// The rainbow flag (the six stripes of the pride flag) as a full screen of LED dots, like the Modern
// Events logo panel (LedLogo.ts), waving a little in the wind: the dots ride a slow travelling wave,
// the folds get lighter and darker. On it two lines in white dots with a dark rim, so they read on
// every stripe: `word` over `rest`; `swap` rewrites the first line from `word` to `word2`, column by
// column from the left, the changing dots flickering.

import { Rect, RectProps, initial, signal } from '@motion-canvas/2d';
import { SignalValue, SimpleSignal } from '@motion-canvas/core';
import { RGB, clamp, easeOutBack, hash } from '../lib/math';
import { FONT } from '../lib/theme';

export interface LedFlagProps extends RectProps {
  time?: SignalValue<number>;
  pitch?: SignalValue<number>;
  reveal?: SignalValue<number>;
  letters?: SignalValue<number>;
  swap?: SignalValue<number>;
  word?: SignalValue<string>;
  word2?: SignalValue<string>;
  rest?: SignalValue<string>;
}

const hex = (h: string): RGB => {
  const v = Number.parseInt(h.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};
/** the six stripes, as bright as LEDs on black can show them */
const STRIPES: RGB[] = ['#ff1f1f', '#ff8a00', '#ffe500', '#00b33c', '#2f63ff', '#9a3ad6'].map(hex);
const WHITE = hex('#fffbf1');
/** cap height of the letters, in dots */
const CAP = 13;

interface Grid {
  key: string;
  cols: number;
  rows: number;
  /** per dot: 1 where a letter is, and the rim around the letters */
  a: Float32Array;
  b: Float32Array;
  rest: Float32Array;
  rimA: Float32Array;
  rimB: Float32Array;
  rimRest: Float32Array;
}

/** where a line of text covers the grid (supersampled), and the rim of one dot around it */
function textMask(text: string, cols: number, rows: number, baseline: number): [Float32Array, Float32Array] {
  const S = 8;
  const canvas = document.createElement('canvas');
  canvas.width = cols * S;
  canvas.height = rows * S;
  const g = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  const size = (CAP * S) / 0.727;
  g.font = `700 ${size}px ${FONT}`;
  g.letterSpacing = `${(0.04 * size).toFixed(1)}px`;
  const w = g.measureText(text).width;
  const squeeze = Math.min(1, (cols * S * 0.9) / Math.max(1, w));
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.setTransform(squeeze, 0, 0, 1, (cols * S) / 2, 0);
  g.fillText(text, 0, baseline * S);
  const img = g.getImageData(0, 0, cols * S, rows * S).data;
  const mask = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) sum += img[((r * S + y) * cols * S + c * S + x) * 4 + 3];
      mask[r * cols + c] = sum / (S * S * 255) > 0.42 ? 1 : 0;
    }
  }
  const rim = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (mask[r * cols + c]) continue;
      let near = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && mask[rr * cols + cc]) near = 1;
        }
      }
      rim[r * cols + c] = near;
    }
  }
  return [mask, rim];
}

export class LedFlag extends Rect {
  @initial(0) @signal() public declare readonly time: SimpleSignal<number, this>;
  /** px from dot to dot */
  @initial(12) @signal() public declare readonly pitch: SimpleSignal<number, this>;
  /** 0..1: the dots light up from the left */
  @initial(1) @signal() public declare readonly reveal: SimpleSignal<number, this>;
  /** 0..1: the letters light up from the left */
  @initial(0) @signal() public declare readonly letters: SimpleSignal<number, this>;
  /** 0..1: the first line changes from word to word2 */
  @initial(0) @signal() public declare readonly swap: SimpleSignal<number, this>;
  @initial('COTTBUS') @signal() public declare readonly word: SimpleSignal<string, this>;
  @initial('DIE ZUKUNFT') @signal() public declare readonly word2: SimpleSignal<string, this>;
  @initial('IST BUNT') @signal() public declare readonly rest: SimpleSignal<string, this>;

  private grid: Grid | null = null;
  private canvas = document.createElement('canvas');
  private img: ImageData | null = null;
  private glowCanvas = document.createElement('canvas');

  public constructor(props?: LedFlagProps) {
    super({ width: 1920, height: 1080, ...props });
  }

  private build(W: number, H: number, p: number): Grid {
    const key = `${W},${H},${p},${this.word()},${this.word2()},${this.rest()}`;
    if (this.grid?.key === key) return this.grid;
    const cols = Math.round(W / p);
    const rows = Math.round(H / p);
    // two lines, the block centered
    const gap = 8;
    const top = Math.round((rows - (2 * CAP + gap)) / 2);
    const base1 = top + CAP;
    const base2 = base1 + gap + CAP;
    const [a, rimA] = textMask(this.word(), cols, rows, base1);
    const [b, rimB] = textMask(this.word2(), cols, rows, base1);
    const [rest, rimRest] = textMask(this.rest(), cols, rows, base2);
    this.grid = { key, cols, rows, a, b, rest, rimA, rimB, rimRest };
    return this.grid;
  }

  protected override draw(ctx: CanvasRenderingContext2D) {
    const size = this.size();
    const W = size.x;
    const H = size.y;
    const p = this.pitch();
    const G = this.build(W, H, p);
    const m = ctx.getTransform();
    const scale = Math.max(0.25, Math.hypot(m.a, m.b));
    const dw = Math.max(1, Math.round(W * scale));
    const dh = Math.max(1, Math.round(H * scale));
    if (this.canvas.width !== dw || this.canvas.height !== dh || !this.img) {
      this.canvas.width = dw;
      this.canvas.height = dh;
      this.img = (this.canvas.getContext('2d') as CanvasRenderingContext2D).createImageData(dw, dh);
    }
    const data = this.img.data;
    data.fill(0);
    const t = this.time();
    const reveal = this.reveal();
    const letters = this.letters();
    const swap = this.swap();
    const { cols, rows } = G;
    const sp = p * scale;
    const R0 = 0.41 * sp;
    const amp = 0.016 * H * scale;
    const stripeRows = rows / STRIPES.length;
    const frame = Math.floor(t * 24);
    for (let c = -1; c <= cols; c++) {
      const u = (c + 0.5) / cols;
      // the wind: a slow wave travelling to the right, a quicker ripple on top
      const ph = 2 * Math.PI * (u / 0.62 - t / 3.2);
      const ph2 = 2 * Math.PI * (u / 0.23 - t / 1.7) + 1.3;
      const dy = amp * ((0.55 + 0.45 * u) * Math.sin(ph) + 0.3 * Math.sin(ph2));
      const dx = -0.25 * amp * Math.cos(ph);
      const light = 0.84 + 0.2 * Math.cos(ph) + 0.06 * Math.cos(ph2);
      const X = (c + 0.5) * sp + dx;
      // how far the change of the first line has come in this column (0 old .. 1 new)
      const s = clamp((swap * (cols + 18) - c) / 8);
      const sSmooth = s * s * (3 - 2 * s);
      for (let r = -2; r <= rows + 1; r++) {
        const seed = hash(c + 7, r + 7, 13);
        const q = clamp((reveal - (u * 0.78 + seed * 0.12)) / 0.14);
        if (q <= 0) continue;
        const stripe = STRIPES[Math.max(0, Math.min(STRIPES.length - 1, Math.floor((r + 0.5) / stripeRows)))];
        let cr = stripe[0] * light;
        let cg = stripe[1] * light;
        let cb = stripe[2] * light;
        if (c >= 0 && c < cols && r >= 0 && r < rows) {
          const i = r * cols + c;
          const on = clamp((letters - (u * 0.6 + seed * 0.1)) / 0.2);
          let L = (G.a[i] * (1 - sSmooth) + G.b[i] * sSmooth + G.rest[i]) * on;
          const rim = (G.rimA[i] * (1 - sSmooth) + G.rimB[i] * sSmooth + G.rimRest[i]) * on;
          // the dots that change flicker while the change runs through them
          if (s > 0.1 && s < 0.9 && (G.a[i] || G.b[i]) && hash(c, r, frame) > 0.55) L = Math.max(L, 0.95 * on);
          const dim = 1 - 0.8 * Math.min(1, rim);
          cr = cr * dim + (WHITE[0] - cr * dim) * L;
          cg = cg * dim + (WHITE[1] - cg * dim) * L;
          cb = cb * dim + (WHITE[2] - cb * dim) * L;
        }
        // a flash when the dot comes on
        const flash = (1 - q) * 0.8;
        cr += (1 - cr) * flash;
        cg += (1 - cg) * flash;
        cb += (1 - cb) * flash;
        const Y = (r + 0.5) * sp + dy;
        const rad = R0 * Math.max(0.05, easeOutBack(q));
        const x0 = Math.max(0, Math.floor(X - rad - 1));
        const x1 = Math.min(dw - 1, Math.ceil(X + rad + 1));
        const y0 = Math.max(0, Math.floor(Y - rad - 1));
        const y1 = Math.min(dh - 1, Math.ceil(Y + rad + 1));
        const R8 = Math.round(clamp(cr) * 255);
        const G8 = Math.round(clamp(cg) * 255);
        const B8 = Math.round(clamp(cb) * 255);
        for (let py = y0; py <= y1; py++) {
          const ddy = py + 0.5 - Y;
          for (let px = x0; px <= x1; px++) {
            const ddx = px + 0.5 - X;
            const cov = rad + 0.5 - Math.sqrt(ddx * ddx + ddy * ddy);
            if (cov <= 0) continue;
            const o = (py * dw + px) * 4;
            const a = Math.round(Math.min(1, cov) * 255);
            if (a > data[o + 3]) {
              data[o] = R8;
              data[o + 1] = G8;
              data[o + 2] = B8;
              data[o + 3] = a;
            }
          }
        }
      }
    }
    (this.canvas.getContext('2d') as CanvasRenderingContext2D).putImageData(this.img, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.canvas, -W / 2, -H / 2, W, H);
    // the glow of the LEDs, from a small copy
    const gw = Math.max(1, Math.round(dw / 4));
    const gh = Math.max(1, Math.round(dh / 4));
    if (this.glowCanvas.width !== gw || this.glowCanvas.height !== gh) {
      this.glowCanvas.width = gw;
      this.glowCanvas.height = gh;
    }
    const gc = this.glowCanvas.getContext('2d') as CanvasRenderingContext2D;
    gc.clearRect(0, 0, gw, gh);
    gc.filter = `blur(${Math.max(1, Math.round(sp / 5))}px)`;
    gc.drawImage(this.canvas, 0, 0, gw, gh);
    gc.filter = 'none';
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha *= 0.42;
    ctx.drawImage(this.glowCanvas, -W / 2, -H / 2, W, H);
    ctx.restore();
    this.drawChildren(ctx);
  }
}
