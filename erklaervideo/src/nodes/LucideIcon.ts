// A line icon from lucide (ISC license, 24 × 24), drawn to the node's size, as on the contact card
// of the wall scene (web/scenes/leonie-ziechmann/cards.js).

import { Rect, RectProps, initial, signal } from '@motion-canvas/2d';
import { SignalValue, SimpleSignal } from '@motion-canvas/core';

const ICONS: Record<string, string[]> = {
  mail: ['M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z', 'm22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7'],
  phone: [
    'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z',
  ],
};
const PATHS = Object.fromEntries(Object.entries(ICONS).map(([k, list]) => [k, list.map((d) => new Path2D(d))]));

export interface LucideIconProps extends RectProps {
  icon?: SignalValue<string>;
  iconColor?: SignalValue<string>;
  /** line width in the icon's 24 × 24 units */
  iconWidth?: SignalValue<number>;
}

export class LucideIcon extends Rect {
  @initial('mail') @signal() public declare readonly icon: SimpleSignal<string, this>;
  @initial('#4e7755') @signal() public declare readonly iconColor: SimpleSignal<string, this>;
  @initial(2) @signal() public declare readonly iconWidth: SimpleSignal<number, this>;

  public constructor(props?: LucideIconProps) {
    super({ width: 32, height: 32, ...props });
  }

  protected override draw(ctx: CanvasRenderingContext2D) {
    const s = this.size();
    const paths = PATHS[this.icon()] ?? [];
    ctx.save();
    ctx.translate(-s.x / 2, -s.y / 2);
    ctx.scale(s.x / 24, s.y / 24);
    ctx.strokeStyle = this.iconColor();
    ctx.lineWidth = this.iconWidth();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const p of paths) ctx.stroke(p);
    ctx.restore();
    this.drawChildren(ctx);
  }
}
