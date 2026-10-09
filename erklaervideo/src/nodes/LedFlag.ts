// The rainbow flag (the six stripes of the pride flag) as a full screen of LED dots, like the Modern
// Events logo panel (LedLogo.ts), waving in the wind like satin: the dots ride a slow travelling
// wave, the folds go dark, the crests get a sheen and slightly larger dots. Every dot has its own
// small brightness, single dots twinkle white (a few as little stars with rays) and now and then a
// glint runs diagonally over the flag. `reveal` lights the dots up from the left, `burst` makes the
// whole flag sparkle for a moment.

import { Rect, RectProps, initial, signal } from '@motion-canvas/2d';
import { SignalValue, SimpleSignal } from '@motion-canvas/core';
import { RGB, clamp, easeOutBack, hash } from '../lib/math';

export interface LedFlagProps extends RectProps {
  time?: SignalValue<number>;
  pitch?: SignalValue<number>;
  reveal?: SignalValue<number>;
  burst?: SignalValue<number>;
}

const hex = (h: string): RGB => {
  const v = Number.parseInt(h.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};
/** the six stripes, as bright as LEDs on black can show them */
const STRIPES: RGB[] = ['#ff1f1f', '#ff8a00', '#ffe500', '#00b33c', '#2f63ff', '#9a3ad6'].map(hex);

export class LedFlag extends Rect {
  @initial(0) @signal() public declare readonly time: SimpleSignal<number, this>;
  /** px from dot to dot */
  @initial(12) @signal() public declare readonly pitch: SimpleSignal<number, this>;
  /** 0..1: the dots light up from the left */
  @initial(1) @signal() public declare readonly reveal: SimpleSignal<number, this>;
  /** 0..1: extra sparkle over the whole flag */
  @initial(0) @signal() public declare readonly burst: SimpleSignal<number, this>;

  private canvas = document.createElement('canvas');
  private img: ImageData | null = null;
  private glowCanvas = document.createElement('canvas');
  private stars: number[] = [];

  public constructor(props?: LedFlagProps) {
    super({ width: 1920, height: 1080, ...props });
  }

  protected override draw(ctx: CanvasRenderingContext2D) {
    const size = this.size();
    const W = size.x;
    const H = size.y;
    const p = this.pitch();
    const cols = Math.round(W / p);
    const rows = Math.round(H / p);
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
    const burst = this.burst();
    const sp = p * scale;
    const R0 = 0.4 * sp;
    const amp = 0.018 * H * scale;
    const stripeRows = rows / STRIPES.length;
    // the glint: a diagonal band of light crossing the flag every few seconds
    const glintAt = ((t / 4.2) % 1) * 2.6 - 0.8;
    // twinkles: each dot may flash in short time slots; more of them in a burst
    const slotRate = 3.5;
    const chance = 0.012 + 0.03 * burst;
    const stars = this.stars;
    stars.length = 0;
    for (let c = -1; c <= cols; c++) {
      const u = (c + 0.5) / cols;
      // the wind: a slow wave travelling to the right, a quicker ripple on top
      const ph = 2 * Math.PI * (u / 0.62 - t / 3.2);
      const ph2 = 2 * Math.PI * (u / 0.23 - t / 1.7) + 1.3;
      const dy = amp * ((0.55 + 0.45 * u) * Math.sin(ph) + 0.3 * Math.sin(ph2));
      const dx = -0.25 * amp * Math.cos(ph);
      // satin: dark in the folds, a sheen on the crests
      const slope = Math.cos(ph) + 0.35 * Math.cos(ph2);
      const light = 0.78 + 0.3 * slope;
      const sheen = Math.pow(Math.max(0, Math.cos(ph - 0.5)), 8) * 0.42;
      const X = (c + 0.5) * sp + dx;
      for (let r = -2; r <= rows + 1; r++) {
        const v = (r + 0.5) / rows;
        const seed = hash(c + 7, r + 7, 13);
        const q = clamp((reveal - (u * 0.78 + seed * 0.12)) / 0.14);
        if (q <= 0) continue;
        const stripe = STRIPES[Math.max(0, Math.min(STRIPES.length - 1, Math.floor((r + 0.5) / stripeRows)))];
        // every LED a little different
        const own = 0.93 + 0.14 * hash(c + 3, r + 11, 29);
        const k = light * own;
        let cr = stripe[0] * k;
        let cg = stripe[1] * k;
        let cb = stripe[2] * k;
        // the sheen and the glint go towards white
        const band = u + 0.35 * v - glintAt;
        const glint = Math.exp(-band * band * 90) * 0.45;
        let white = Math.min(1, sheen + glint);
        // a twinkle: a quick flash in its time slot
        const slotPos = t * slotRate + seed * 100;
        const slot = Math.floor(slotPos);
        const roll = hash(c + 1, r + 1, slot);
        let twinkle = 0;
        if (roll < chance) {
          const f = slotPos - slot;
          twinkle = Math.pow(Math.sin(Math.PI * f), 2);
          white = Math.max(white, 0.9 * twinkle);
          if (roll < chance * 0.22 && twinkle > 0.2) stars.push(X, (r + 0.5) * sp + dy, twinkle);
        }
        cr += (1 - cr) * white;
        cg += (1 - cg) * white;
        cb += (1 - cb) * white;
        // a flash when the dot comes on
        const flash = (1 - q) * 0.8;
        cr += (1 - cr) * flash;
        cg += (1 - cg) * flash;
        cb += (1 - cb) * flash;
        const Y = (r + 0.5) * sp + dy;
        const rad = R0 * Math.max(0.05, easeOutBack(q)) * (0.92 + 0.12 * slope + 0.25 * twinkle);
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
    ctx.globalAlpha /= 0.42;
    // the stars: a soft glow and four thin rays on a few of the twinkling dots
    for (let i = 0; i < stars.length; i += 3) {
      const x = stars[i] / scale - W / 2;
      const y = stars[i + 1] / scale - H / 2;
      const a = stars[i + 2];
      const len = p * (1.6 + 2.2 * a);
      const glow = ctx.createRadialGradient(x, y, 0, x, y, p * 1.4);
      glow.addColorStop(0, `rgba(255,255,255,${0.9 * a})`);
      glow.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, p * 1.4, 0, Math.PI * 2);
      ctx.fill();
      for (const [ux, uy] of [[1, 0], [0, 1]]) {
        const g = ctx.createLinearGradient(x - ux * len, y - uy * len, x + ux * len, y + uy * len);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.5, `rgba(255,255,255,${0.85 * a})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.strokeStyle = g;
        ctx.lineWidth = Math.max(1, p * 0.16);
        ctx.beginPath();
        ctx.moveTo(x - ux * len, y - uy * len);
        ctx.lineTo(x + ux * len, y + uy * len);
        ctx.stroke();
      }
    }
    ctx.restore();
    this.drawChildren(ctx);
  }
}
