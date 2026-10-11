// A fist seen from the front, as you see your own hand: four curled fingers side by side, the thumb
// across them, the forearm in a sleeve coming in from below. A cable runs through it from left to
// right. `flip` turns the hand over around the cable (0 back of the hand and thumb on top, 1 palm
// up and thumb below): it squashes through the side view and shows the other face.

import { Node, NodeProps, initial, signal } from '@motion-canvas/2d';
import { SignalValue, SimpleSignal } from '@motion-canvas/core';
import { C } from '../lib/theme';

export interface FistProps extends NodeProps {
  side?: SignalValue<'left' | 'right'>;
  flip?: SignalValue<number>;
  /** direction the forearm leaves the fist (deg, 90 = straight down) */
  arm?: SignalValue<number>;
  /** draw only the forearm (behind the cable) or only the hand (on top of it) */
  part?: SignalValue<'all' | 'arm' | 'hand'>;
}

const PALM = '#f6d3b6';
const PALM_DARK = '#ecbb98';
const NAIL = '#fbe7da';

export class Fist extends Node {
  @initial('left') @signal() public declare readonly side: SimpleSignal<'left' | 'right', this>;
  @initial(0) @signal() public declare readonly flip: SimpleSignal<number, this>;
  @initial(110) @signal() public declare readonly arm: SimpleSignal<number, this>;
  @initial('all') @signal() public declare readonly part: SimpleSignal<'all' | 'arm' | 'hand', this>;

  public constructor(props?: FistProps) {
    super(props);
  }

  protected override draw(ctx: CanvasRenderingContext2D) {
    const mirror = this.side() === 'right' ? -1 : 1;
    const flip = this.flip();
    const squash = Math.cos(Math.PI * flip);
    const palm = flip > 0.5;
    const arm = (this.arm() * Math.PI) / 180;
    const ink = (w: number) => {
      ctx.lineWidth = w;
      ctx.strokeStyle = C.skinLine;
      ctx.stroke();
    };

    const part = this.part();
    ctx.save();
    // the forearm: tapers toward the wrist, the near end is out of the picture
    if (part !== 'hand') this.drawArm(ctx, arm);
    if (part === 'arm') {
      ctx.restore();
      this.drawChildren(ctx);
      return;
    }
    ctx.scale(mirror, Math.max(0.06, Math.abs(squash)));
    if (palm) ctx.scale(1, -1);
    // the hand
    ctx.beginPath();
    ctx.roundRect(-56, -46, 112, 94, 30);
    ctx.fillStyle = palm ? PALM : C.skin;
    ctx.fill();
    ink(2.5);
    // four fingers, curled around the cable
    for (let i = 0; i < 4; i++) {
      const x = -50 + i * 25;
      ctx.beginPath();
      ctx.roundRect(x, -12, 25, 58, 11);
      ctx.fillStyle = palm ? (i % 2 ? PALM_DARK : PALM) : i % 2 ? '#ebb790' : C.skin;
      ctx.fill();
      ink(2);
      if (palm) {
        // the nails of the curled fingertips
        ctx.beginPath();
        ctx.roundRect(x + 5.5, 26, 14, 14, 5);
        ctx.fillStyle = NAIL;
        ctx.fill();
        ink(1.5);
      } else {
        ctx.beginPath();
        ctx.moveTo(x + 7, 16);
        ctx.quadraticCurveTo(x + 12.5, 20, x + 18, 16);
        ink(1.8);
      }
    }
    // the thumb across the fingers
    ctx.beginPath();
    ctx.roundRect(-60, -36, 86, 30, 15);
    ctx.fillStyle = palm ? PALM_DARK : C.skin;
    ctx.fill();
    ink(2.5);
    if (!palm) {
      ctx.beginPath();
      ctx.roundRect(4, -31, 17, 20, 7);
      ctx.fillStyle = NAIL;
      ctx.fill();
      ink(1.5);
    }
    ctx.restore();
    this.drawChildren(ctx);
  }

  private drawArm(ctx: CanvasRenderingContext2D, arm: number) {
    ctx.save();
    ctx.rotate(arm);
    ctx.beginPath();
    ctx.moveTo(26, -30);
    ctx.lineTo(760, -62);
    ctx.lineTo(760, 62);
    ctx.lineTo(26, 30);
    ctx.closePath();
    ctx.fillStyle = C.skinShade;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(70, -36);
    ctx.lineTo(760, -66);
    ctx.lineTo(760, 66);
    ctx.lineTo(70, 36);
    ctx.closePath();
    ctx.fillStyle = C.sleeve;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(70, -36);
    ctx.lineTo(92, -37);
    ctx.lineTo(92, 37);
    ctx.lineTo(70, 36);
    ctx.closePath();
    ctx.fillStyle = C.sleeveShade;
    ctx.fill();
    ctx.restore();
  }
}
