// The LED wall seen straight on (6 × 2 m): the people's skeletons where the shared wall setup puts
// them (mirrored, real size, walk stretched), the fluid, and small animated hints about the mapping:
// a mirror, a ruler for the real size and a top view of the stretched walk.

import { Rect, RectProps, initial, signal } from '@motion-canvas/2d';
import { SignalValue, SimpleSignal } from '@motion-canvas/core';
import { FLUID } from '../lib/fluid';
import { REF_DISTANCE, STRETCH, mapToWall, tracked, wallCenter } from '../lib/mapping';
import { V3, hexRgb, lerp, rgba, smooth } from '../lib/math';
import { BONES, Pose, people } from '../lib/people';
import { C, FONT } from '../lib/theme';
import { INTR, KINECT, WALL } from '../lib/world';

export interface WallViewProps extends RectProps {
  time?: SignalValue<number>;
  panel?: SignalValue<number>;
  skel?: SignalValue<number>;
  ghost?: SignalValue<number>;
  fluid?: SignalValue<number>;
  mirror?: SignalValue<number>;
  ruler?: SignalValue<number>;
  topView?: SignalValue<number>;
}

export class WallView extends Rect {
  @initial(0) @signal() public declare readonly time: SimpleSignal<number, this>;
  @initial(1) @signal() public declare readonly panel: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly skel: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly ghost: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly fluid: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly mirror: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly ruler: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly topView: SimpleSignal<number, this>;

  public constructor(props?: WallViewProps) {
    super({ width: 1500, height: 500, ...props });
  }

  /** wall point (x from the middle, y above the floor) → local px */
  toLocal(x: number, y: number): [number, number] {
    const s = this.size();
    return [(x / WALL.w) * s.x, (-(y - (WALL.bottom + WALL.h / 2)) / WALL.h) * s.y];
  }

  protected override draw(ctx: CanvasRenderingContext2D) {
    const s = this.size();
    const W = s.x;
    const H = s.y;
    const T = this.time();
    const list = tracked(people(T));
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const panel = this.panel();
    if (panel > 0) {
      ctx.fillStyle = rgba(hexRgb(C.cabinet), panel);
      ctx.fillRect(-W / 2, -H / 2, W, H);
    }
    if (this.fluid() > 0) {
      ctx.save();
      ctx.globalAlpha *= this.fluid();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(FLUID.at(T).image(), -W / 2, -H / 2, W, H);
      ctx.restore();
    }
    if (panel > 0) {
      // cabinet seams and the frame
      ctx.strokeStyle = rgba(hexRgb(C.cabinetEdge), 0.9 * panel);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 1; c < WALL.cols; c++) {
        const x = -W / 2 + (c * W) / WALL.cols;
        ctx.moveTo(x, -H / 2);
        ctx.lineTo(x, H / 2);
      }
      for (let r = 1; r < WALL.rows; r++) {
        const y = -H / 2 + (r * H) / WALL.rows;
        ctx.moveTo(-W / 2, y);
        ctx.lineTo(W / 2, y);
      }
      ctx.stroke();
      ctx.strokeStyle = rgba([0.62, 0.68, 0.78], 0.8 * panel);
      ctx.lineWidth = 2;
      ctx.strokeRect(-W / 2, -H / 2, W, H);
    }
    if (this.ghost() > 0) for (const p of list) this.drawSkeleton(ctx, p, this.ghost() * 0.35, false, true);
    if (this.skel() > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(-W / 2, -H / 2, W, H);
      ctx.clip();
      for (const p of list) this.drawSkeleton(ctx, p, this.skel(), true, false);
      ctx.restore();
    }
    if (this.mirror() > 0) this.drawMirror(ctx, list);
    if (this.ruler() > 0) this.drawRuler(ctx, list);
    if (this.topView() > 0) this.drawTopView(ctx, list, H);
    ctx.restore();
    this.drawChildren(ctx);
  }

  private drawSkeleton(ctx: CanvasRenderingContext2D, p: Pose, alpha: number, glow: boolean, dashed: boolean) {
    const pts = p.joints.map((j) => this.toLocal(...mapToWall(p, j)));
    ctx.save();
    if (dashed) ctx.setLineDash([6, 7]);
    for (const [width, a] of glow ? [[16, 0.2], [5, 1]] : [[3, 1]]) {
      ctx.strokeStyle = rgba(p.color, a * alpha);
      ctx.lineWidth = width;
      ctx.beginPath();
      for (const [i, j] of BONES) {
        ctx.moveTo(pts[i][0], pts[i][1]);
        ctx.lineTo(pts[j][0], pts[j][1]);
      }
      ctx.stroke();
    }
    ctx.restore();
    if (glow) {
      const head = pts[19];
      const r = (0.11 / WALL.h) * this.size().y;
      ctx.strokeStyle = rgba(p.color, alpha);
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(head[0], head[1], r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = rgba([1, 1, 1], alpha);
      for (const k of [9, 10, 20, 21]) {
        ctx.beginPath();
        ctx.arc(pts[k][0], pts[k][1], 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private tag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, a: number, color: [number, number, number]) {
    ctx.save();
    ctx.font = `600 26px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 28;
    ctx.fillStyle = `rgba(5,7,12,${0.85 * a})`;
    ctx.strokeStyle = rgba(color, 0.9 * a);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 21, w, 42, 21);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = `rgba(240,244,250,${a})`;
    ctx.fillText(text, x, y + 1);
    ctx.restore();
  }

  /** a dashed mirror line through the person and a double arrow: the right hand is on the right */
  private drawMirror(ctx: CanvasRenderingContext2D, list: Pose[]) {
    const p = list.find((q) => q.slot === 1);
    if (!p) return;
    const a = this.mirror();
    const [hx, hy] = this.toLocal(...mapToWall(p, p.joints[21]));
    ctx.strokeStyle = `rgba(255,255,255,${0.9 * a})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(hx, hy, 26 + 6 * Math.sin(this.time() * 6), 0, Math.PI * 2);
    ctx.stroke();
    this.tag(ctx, 'wie ein Spiegel', hx + 40, hy - 70, a, [1, 1, 1]);
  }

  /** a ruler from the floor to the head: the body appears in real size */
  private drawRuler(ctx: CanvasRenderingContext2D, list: Pose[]) {
    const p = list.find((q) => q.slot === 2) ?? list[0];
    if (!p) return;
    const a = this.ruler();
    const head = p.joints[19][1] + 0.11;
    const [x, yTop] = this.toLocal(wallCenter(p) + 0.42, head);
    const [, yFloor] = this.toLocal(0, 0);
    const e = smooth(0, 1, a);
    const y1 = lerp(yFloor, yTop, e);
    ctx.strokeStyle = `rgba(255,255,255,${0.9 * a})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, yFloor);
    ctx.lineTo(x, y1);
    ctx.moveTo(x - 12, yFloor);
    ctx.lineTo(x + 12, yFloor);
    ctx.moveTo(x - 12, y1);
    ctx.lineTo(x + 12, y1);
    for (let m = 0.5; m < head; m += 0.5) {
      const [, ym] = this.toLocal(0, m);
      if (ym < y1) continue;
      ctx.moveTo(x - 6, ym);
      ctx.lineTo(x + 6, ym);
    }
    ctx.stroke();
    // the floor line below the wall
    ctx.strokeStyle = `rgba(160,175,200,${0.5 * a})`;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    const W = this.size().x;
    ctx.moveTo(-W / 2, yFloor);
    ctx.lineTo(W / 2, yFloor);
    ctx.stroke();
    ctx.setLineDash([]);
    const h = head.toFixed(2).replace('.', ',');
    this.tag(ctx, `${h} m · echte Größe`, x + 150, y1, smooth(0.5, 1, a), [1, 1, 1]);
  }

  /** top view below the wall: the Kinect's view at 3 m is narrower than the wall, so the walk is stretched */
  private drawTopView(ctx: CanvasRenderingContext2D, list: Pose[], H: number) {
    const a = this.topView();
    const scale = 58; // px per m
    const ox = 0;
    const oy = H / 2 + 56;
    const X = (x: number) => ox + x * scale;
    const Z = (z: number) => oy + z * scale;
    ctx.save();
    ctx.globalAlpha *= a;
    // the wall seen from above
    ctx.strokeStyle = 'rgba(200,210,230,0.9)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(X(-WALL.w / 2), Z(0));
    ctx.lineTo(X(WALL.w / 2), Z(0));
    ctx.stroke();
    // the Kinect and its view
    const tan = INTR.cx / INTR.f;
    const sensor = hexRgb(C.sensor);
    const reach = 3.6;
    ctx.fillStyle = rgba(sensor, 0.1);
    ctx.strokeStyle = rgba(sensor, 0.8);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(X(KINECT[0]), Z(KINECT[2]));
    ctx.lineTo(X(-tan * reach), Z(KINECT[2] + reach));
    ctx.lineTo(X(tan * reach), Z(KINECT[2] + reach));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // the reference line at 3 m
    const zr = KINECT[2] + REF_DISTANCE;
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(220,228,240,0.6)';
    ctx.beginPath();
    ctx.moveTo(X(-tan * REF_DISTANCE), Z(zr));
    ctx.lineTo(X(tan * REF_DISTANCE), Z(zr));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = rgba(sensor, 1);
    ctx.fillRect(X(-0.12), Z(KINECT[2]) - 4, 0.24 * scale, 8);
    // each person: where they stand, and where they appear on the wall
    for (const p of list) {
      const real: [number, number] = [X(p.center[0]), Z(p.center[2])];
      const onWall: [number, number] = [X(wallCenter(p)), Z(0)];
      ctx.strokeStyle = rgba(p.color, 0.8);
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.moveTo(real[0], real[1]);
      ctx.lineTo(onWall[0], onWall[1] + 8);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = rgba(p.color, 1);
      ctx.beginPath();
      ctx.arc(real[0], real[1], 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(onWall[0], onWall[1], 7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = `600 24px ${FONT}`;
    ctx.fillStyle = 'rgba(235,240,248,0.95)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('Laufweg × ' + STRETCH.toFixed(1).replace('.', ','), X(WALL.w / 2) + 24, Z(0));
    ctx.restore();
  }
}

/** the wall point of a joint (for the scenes) */
export function wallJoint(p: Pose, k: number): V3 {
  const [x, y] = mapToWall(p, p.joints[k]);
  return [x, y, 0];
}
