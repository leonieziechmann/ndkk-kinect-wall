// Small glowing dots streaming along a path: the data going from one box to the next.

import { Rect, RectProps, initial, signal } from '@motion-canvas/2d';
import { SignalValue, SimpleSignal } from '@motion-canvas/core';
import { hexRgb, rgba } from '../lib/math';

export interface PacketsProps extends RectProps {
  time?: SignalValue<number>;
  from?: SignalValue<[number, number]>;
  to?: SignalValue<[number, number]>;
  flow?: SignalValue<number>;
  color?: SignalValue<string>;
  count?: SignalValue<number>;
}

export class Packets extends Rect {
  @initial(0) @signal() public declare readonly time: SimpleSignal<number, this>;
  @initial([0, 0]) @signal() public declare readonly from: SimpleSignal<[number, number], this>;
  @initial([100, 0]) @signal() public declare readonly to: SimpleSignal<[number, number], this>;
  @initial(0) @signal() public declare readonly flow: SimpleSignal<number, this>;
  @initial('#9ec3ff') @signal() public declare readonly color: SimpleSignal<string, this>;
  @initial(6) @signal() public declare readonly count: SimpleSignal<number, this>;

  public constructor(props?: PacketsProps) {
    super({ width: 1920, height: 1080, ...props });
  }

  protected override draw(ctx: CanvasRenderingContext2D) {
    const a = this.flow();
    if (a > 0) {
      const [x0, y0] = this.from();
      const [x1, y1] = this.to();
      const n = this.count();
      const c = hexRgb(this.color());
      const t = this.time();
      for (let k = 0; k < n; k++) {
        const u = (t * 1.1 + k / n) % 1;
        const fade = Math.min(1, u * 6, (1 - u) * 6) * a;
        const x = x0 + (x1 - x0) * u;
        const y = y0 + (y1 - y0) * u;
        ctx.fillStyle = rgba(c, 0.25 * fade);
        ctx.beginPath();
        ctx.arc(x, y, 13, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = rgba(c, fade);
        ctx.beginPath();
        ctx.arc(x, y, 5.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    this.drawChildren(ctx);
  }
}
