// A rainbow flag (the six stripes of the pride flag) waving on a pole: the cloth is cut into thin
// vertical slices that ride a travelling wave, more the farther from the pole, the folds lit and
// shaded. `unfurl` rolls it out from the pole.

import { Rect, RectProps, initial, signal } from '@motion-canvas/2d';
import { SignalValue, SimpleSignal } from '@motion-canvas/core';
import { RGB, clamp, hexRgb } from '../lib/math';

export interface RainbowFlagProps extends RectProps {
  time?: SignalValue<number>;
  unfurl?: SignalValue<number>;
  pole?: SignalValue<number>;
}

export const RAINBOW = ['#e40303', '#ff8c00', '#ffed00', '#008026', '#24408e', '#732982'];
const STRIPES: RGB[] = RAINBOW.map(hexRgb);
const SLICES = 96;

export class RainbowFlag extends Rect {
  @initial(0) @signal() public declare readonly time: SimpleSignal<number, this>;
  @initial(1) @signal() public declare readonly unfurl: SimpleSignal<number, this>;
  /** the pole: 0 hidden, 1 there */
  @initial(1) @signal() public declare readonly pole: SimpleSignal<number, this>;

  private glowCanvas = document.createElement('canvas');

  public constructor(props?: RainbowFlagProps) {
    super({ width: 600, height: 390, ...props });
  }

  /** the cloth at x (0 at the pole .. 1): vertical shift (px) and brightness */
  private wave(x: number, t: number, H: number): [number, number] {
    const ph = 2 * Math.PI * (1.15 * x - 0.42 * t);
    const reach = Math.pow(x, 0.8);
    const dy = H * (0.055 * reach * Math.sin(ph) + 0.012 * reach * Math.sin(2.3 * ph + 1.1));
    const light = 0.86 + 0.24 * reach * Math.cos(ph);
    return [dy, light];
  }

  private drawCloth(g: CanvasRenderingContext2D, W: number, H: number, t: number, unfurl: number) {
    const x0 = -W / 2;
    const y0 = -H / 2;
    const h = H / STRIPES.length;
    const n = Math.ceil(SLICES * clamp(unfurl));
    for (let i = 0; i < n; i++) {
      const a = i / SLICES;
      const b = Math.min((i + 1) / SLICES, unfurl);
      const [da, la] = this.wave(a, t, H);
      const [db] = this.wave(b, t, H);
      const xa = x0 + a * W;
      const xb = x0 + b * W + 0.8; // a little overlap, no seams
      for (let s = 0; s < STRIPES.length; s++) {
        const c = STRIPES[s];
        g.fillStyle = `rgb(${Math.round(clamp(c[0] * la) * 255)},${Math.round(clamp(c[1] * la) * 255)},${Math.round(clamp(c[2] * la) * 255)})`;
        const ya = y0 + s * h + da;
        const yb = y0 + s * h + db;
        g.beginPath();
        g.moveTo(xa, ya - 0.4);
        g.lineTo(xb, yb - 0.4);
        g.lineTo(xb, yb + h + 0.4);
        g.lineTo(xa, ya + h + 0.4);
        g.closePath();
        g.fill();
      }
    }
  }

  protected override draw(ctx: CanvasRenderingContext2D) {
    const size = this.size();
    const W = size.x;
    const H = size.y;
    const t = this.time();
    const unfurl = this.unfurl();
    const pole = this.pole();
    // the pole: a slim bar from above the flag down, fading out just below it
    if (pole > 0) {
      ctx.save();
      ctx.globalAlpha *= pole;
      const px = -W / 2 - 7;
      const top = -H / 2 - 40;
      const bottom = H / 2 + 70;
      const g = ctx.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0, 'rgba(210,218,232,0.95)');
      g.addColorStop(0.75, 'rgba(160,170,190,0.55)');
      g.addColorStop(1, 'rgba(160,170,190,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(px - 5, top, 10, bottom - top, 5);
      ctx.fill();
      ctx.fillStyle = 'rgba(230,236,245,0.95)';
      ctx.beginPath();
      ctx.arc(px, -H / 2 - 46, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (unfurl <= 0) return;
    // a soft glow of the colors behind the cloth
    const m = ctx.getTransform();
    const scale = Math.max(0.25, Math.hypot(m.a, m.b));
    const pad = 60;
    const gw = Math.ceil(((W + 2 * pad) * scale) / 4);
    const gh = Math.ceil(((H + 2 * pad) * scale) / 4);
    if (this.glowCanvas.width !== gw || this.glowCanvas.height !== gh) {
      this.glowCanvas.width = gw;
      this.glowCanvas.height = gh;
    }
    const gc = this.glowCanvas.getContext('2d') as CanvasRenderingContext2D;
    gc.setTransform(1, 0, 0, 1, 0, 0);
    gc.clearRect(0, 0, gw, gh);
    gc.setTransform((scale / 4), 0, 0, (scale / 4), gw / 2, gh / 2);
    this.drawCloth(gc, W, H, t, unfurl);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha *= 0.35;
    ctx.filter = `blur(${Math.round(18 * scale)}px)`;
    ctx.drawImage(this.glowCanvas, -W / 2 - pad, -H / 2 - pad, W + 2 * pad, H + 2 * pad);
    ctx.restore();
    this.drawCloth(ctx, W, H, t, unfurl);
    this.drawChildren(ctx);
  }
}
