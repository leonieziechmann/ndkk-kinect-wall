// The Modern Events logo as an LED panel of dots, as on the wall (web/scenes/modern-events/panel.js):
// a rounded block in the logo's blue-violet gradient with pink in two corners and faint diagonal
// facets, the name in white dots. It lights up dot by dot from the left (reveal), the dots twinkle a
// little and now and then a glint runs over the panel.

import { Rect, RectProps, initial, signal } from '@motion-canvas/2d';
import { SignalValue, SimpleSignal } from '@motion-canvas/core';
import { RGB, clamp, easeOutBack, hash } from '../lib/math';
import { FONT } from '../lib/theme';

export interface LedLogoProps extends RectProps {
  text?: SignalValue<string>;
  pitch?: SignalValue<number>;
  reveal?: SignalValue<number>;
  time?: SignalValue<number>;
}

const hex = (h: string): RGB => {
  const v = Number.parseInt(h.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// the logo block (the colors of the wall scene)
const BLUE = hex('#2c40c4');
const INDIGO = hex('#3d32b4');
const PURPLE = hex('#8a2b9c');
const PINK = hex('#d8327e');
const WHITE = hex('#fffbf1');

interface Dot {
  x: number;
  y: number;
  c: RGB;
  letter: boolean;
  /** 0..1 across the panel, for the glint */
  u: number;
  v: number;
  /** when it lights up (reveal 0..1) */
  at: number;
  seed: number;
}

/**
 * Which cells of a cols × rows grid the text covers (supersampled coverage above a threshold). The
 * text is condensed sideways so the letters get more rows, as on the wall.
 */
function letterCells(text: string, cols: number, rows: number, squeeze = 0.74) {
  const S = 8;
  const canvas = document.createElement('canvas');
  canvas.width = cols * S;
  canvas.height = rows * S;
  const g = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  let size = rows * S;
  g.font = `700 ${size}px ${FONT}`;
  const capRatio = 0.72;
  const wFit = (cols * S * 0.86) / Math.max(1, g.measureText(text).width * squeeze);
  const hFit = (rows * S * 0.62) / (size * capRatio);
  size = Math.floor(size * Math.min(wFit, hFit));
  g.font = `700 ${size}px ${FONT}`;
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.setTransform(squeeze, 0, 0, 1, (cols * S) / 2, 0);
  g.fillText(text, 0, (rows * S) / 2 + (size * capRatio) / 2);
  const img = g.getImageData(0, 0, cols * S, rows * S).data;
  const out = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) sum += img[((r * S + y) * cols * S + c * S + x) * 4 + 3];
      out[r * cols + c] = sum / (S * S * 255) > 0.42 ? 1 : 0;
    }
  }
  return out;
}

export class LedLogo extends Rect {
  @initial('MODERN EVENTS') @signal() public declare readonly text: SimpleSignal<string, this>;
  /** px from dot to dot */
  @initial(10) @signal() public declare readonly pitch: SimpleSignal<number, this>;
  @initial(1) @signal() public declare readonly reveal: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly time: SimpleSignal<number, this>;

  private dotsKey = '';
  private dots: Dot[] = [];
  private buf = document.createElement('canvas');

  public constructor(props?: LedLogoProps) {
    super({ width: 760, height: 180, ...props });
  }

  private build(W: number, H: number, p: number, text: string) {
    const key = `${W},${H},${p},${text}`;
    if (key === this.dotsKey) return this.dots;
    this.dotsKey = key;
    const cols = Math.max(4, Math.floor(W / p));
    const rows = Math.max(3, Math.floor(H / p));
    const x0 = -(cols * p) / 2 + p / 2;
    const y0 = -(rows * p) / 2 + p / 2;
    const cells = letterCells(text, cols, rows);
    const round = 2.6; // corner radius in cells
    const dots: Dot[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const dx = Math.max(0, round - (col + 0.5), col + 0.5 - (cols - round));
        const dy = Math.max(0, round - (row + 0.5), row + 0.5 - (rows - round));
        if (dx * dx + dy * dy > round * round) continue;
        const u = (col + 0.5) / cols;
        const v = (row + 0.5) / rows;
        // blue, indigo, purple; pink in two corners; faint diagonal facets
        let c = u < 0.5 ? mix(BLUE, INDIGO, u * 2) : mix(INDIGO, PURPLE, (u - 0.5) * 2);
        const aspect = rows / cols;
        const bl = u + (1 - v) * aspect * 0.55;
        const tr = 1 - u + v * aspect * 0.55;
        if (bl < 0.09) c = mix(c, PINK, 0.85);
        else if (tr < 0.07) c = mix(c, PINK, 0.7);
        const facet = Math.floor((u * cols + v * rows) / (rows * 1.6)) % 2 ? 1 : 0.86;
        c = [c[0] * facet, c[1] * facet, c[2] * facet];
        const letter = cells[row * cols + col] === 1;
        const seed = hash(col, row, 91);
        dots.push({ x: x0 + col * p, y: y0 + row * p, c: letter ? WHITE : c, letter, u, v, at: u * 0.72 + seed * 0.1 + (letter ? 0.08 : 0), seed });
      }
    }
    this.dots = dots;
    return dots;
  }

  protected override draw(ctx: CanvasRenderingContext2D) {
    const size = this.size();
    const W = size.x;
    const H = size.y;
    const p = this.pitch();
    const dots = this.build(W, H, p, this.text());
    const m = ctx.getTransform();
    const scale = Math.max(0.25, Math.hypot(m.a, m.b));
    const pad = p * 2;
    const bw = Math.ceil((W + 2 * pad) * scale);
    const bh = Math.ceil((H + 2 * pad) * scale);
    if (this.buf.width !== bw || this.buf.height !== bh) {
      this.buf.width = bw;
      this.buf.height = bh;
    }
    const g = this.buf.getContext('2d') as CanvasRenderingContext2D;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, bw, bh);
    g.setTransform(scale, 0, 0, scale, (W / 2 + pad) * scale, (H / 2 + pad) * scale);
    const t = this.time();
    const reveal = this.reveal();
    // a glint runs diagonally over the panel every few seconds
    const g0 = ((t / 3.6) % 1) * 2.4 - 0.6;
    for (const d of dots) {
      const q = clamp((reveal - d.at) / 0.16);
      if (q <= 0) continue;
      const r = p * 0.4 * easeOutBack(q);
      const twinkle = 0.94 + 0.06 * Math.sin(t * 2.3 + d.seed * 6.283);
      const band = d.u + 0.3 * d.v - g0;
      const glint = Math.exp(-band * band * 180) * 0.6;
      // a flash when the dot comes on
      const flash = (1 - q) * 0.8;
      const k = Math.min(1, glint + flash);
      const c = d.letter ? d.c : [d.c[0] * twinkle, d.c[1] * twinkle, d.c[2] * twinkle];
      g.fillStyle = `rgb(${Math.round((c[0] + (1 - c[0]) * k) * 255)},${Math.round((c[1] + (1 - c[1]) * k) * 255)},${Math.round((c[2] + (1 - c[2]) * k) * 255)})`;
      g.beginPath();
      g.arc(d.x, d.y, Math.max(0.1, r), 0, Math.PI * 2);
      g.fill();
    }
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.buf, -W / 2 - pad, -H / 2 - pad, W + 2 * pad, H + 2 * pad);
    // the glow of the LEDs
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha *= 0.5;
    ctx.filter = `blur(${Math.round(p * 0.9 * scale)}px)`;
    ctx.drawImage(this.buf, -W / 2 - pad, -H / 2 - pad, W + 2 * pad, H + 2 * pad);
    ctx.restore();
    this.drawChildren(ctx);
  }
}
