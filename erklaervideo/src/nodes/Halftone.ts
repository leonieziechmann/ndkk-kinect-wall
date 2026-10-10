// A halftone screen: dots on a grid whose size follows a slow, soft field, like the printed look of
// ndkk.de (and the dots of an LED wall). `reveal` lets them grow in.

import { Rect, RectProps, initial, signal } from '@motion-canvas/2d';
import { SignalValue, SimpleSignal } from '@motion-canvas/core';
import { clamp, smooth } from '../lib/math';

export interface HalftoneProps extends RectProps {
  time?: SignalValue<number>;
  pitch?: SignalValue<number>;
  dotColor?: SignalValue<string>;
  dotAlpha?: SignalValue<number>;
  reveal?: SignalValue<number>;
}

export class Halftone extends Rect {
  @initial(0) @signal() public declare readonly time: SimpleSignal<number, this>;
  @initial(16) @signal() public declare readonly pitch: SimpleSignal<number, this>;
  @initial('#002647') @signal() public declare readonly dotColor: SimpleSignal<string, this>;
  @initial(0.16) @signal() public declare readonly dotAlpha: SimpleSignal<number, this>;
  @initial(1) @signal() public declare readonly reveal: SimpleSignal<number, this>;

  public constructor(props?: HalftoneProps) {
    super(props);
  }

  protected override draw(ctx: CanvasRenderingContext2D) {
    const size = this.size();
    const W = size.x;
    const H = size.y;
    const p = this.pitch();
    const t = this.time();
    const reveal = this.reveal();
    ctx.save();
    ctx.fillStyle = this.dotColor();
    ctx.globalAlpha *= this.dotAlpha();
    ctx.beginPath();
    const rows = Math.ceil(H / p) + 1;
    const cols = Math.ceil(W / p) + 1;
    for (let r = 0; r < rows; r++) {
      const y = -H / 2 + r * p;
      const v = r / rows;
      for (let c = 0; c < cols; c++) {
        const x = -W / 2 + c * p + (r % 2 ? p / 2 : 0);
        const u = c / cols;
        // a diagonal band, denser towards the lower left, slowly breathing
        const field = Math.sin(u * 3.1 + v * 2.2 + t * 0.5) * Math.cos(v * 2.6 - u * 1.2 - t * 0.35);
        const density = smooth(0.2, 1, (1 - u) * 0.5 + v * 0.65 + 0.3 * field - 0.15);
        // grows in from the bottom
        const grow = clamp((reveal * 1.4 - (1 - v)) / 0.4);
        const rad = p * 0.48 * density * grow;
        if (rad < 0.4) continue;
        ctx.moveTo(x + rad, y);
        ctx.arc(x, y, rad, 0, Math.PI * 2);
      }
    }
    ctx.fill();
    ctx.restore();
    this.drawChildren(ctx);
  }
}
