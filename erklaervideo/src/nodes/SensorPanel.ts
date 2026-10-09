// A picture of the Kinect (512 × 424): infrared, depth, optical flow or the person masks, with what
// the pose model finds drawn on top (boxes, keypoints, skeleton).

import { Rect, RectProps, initial, signal } from '@motion-canvas/2d';
import { SignalValue, SimpleSignal } from '@motion-canvas/core';
import { depthCss, depthImage, flowColor, flowImage, irImage, maskImage } from '../lib/images';
import { clamp, easeOutBack, hexRgb, lerp, rgba, smooth } from '../lib/math';
import { COCO_BONES } from '../lib/people';
import { BodyStyle, DEFAULT_STYLE } from '../lib/body/styles';
import { ROLES } from '../lib/choreo';
import { SensorFrame, sense } from '../lib/sensor';
import { C, FONT } from '../lib/theme';
import { INTR } from '../lib/world';
import { rayTarget } from './Stage';

export interface SensorPanelProps extends RectProps {
  time?: SignalValue<number>;
  mode?: SignalValue<string>;
  title?: SignalValue<string>;
  image?: SignalValue<number>;
  chrome?: SignalValue<number>;
  legend?: SignalValue<number>;
  scan?: SignalValue<number>;
  boxes?: SignalValue<number>;
  points?: SignalValue<number>;
  bones?: SignalValue<number>;
  colorize?: SignalValue<number>;
  pointLabels?: SignalValue<number>;
  arrows?: SignalValue<number>;
  maskGrow?: SignalValue<number>;
  room?: SignalValue<number>;
  roomTint?: SignalValue<number>;
  pixel?: SignalValue<number>;
  depthMax?: SignalValue<number>;
  edge?: SignalValue<number>;
  bodyStyle?: SignalValue<string>;
  textScale?: SignalValue<number>;
}

const POINT_NAMES: [number, string][] = [
  [0, 'Kopf'],
  [10, 'Hand'],
  [13, 'Knie'],
];

export class SensorPanel extends Rect {
  @initial(0) @signal() public declare readonly time: SimpleSignal<number, this>;
  @initial('ir') @signal() public declare readonly mode: SimpleSignal<string, this>;
  @initial('') @signal() public declare readonly title: SimpleSignal<string, this>;
  @initial(1) @signal() public declare readonly image: SimpleSignal<number, this>;
  @initial(1) @signal() public declare readonly chrome: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly legend: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly scan: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly boxes: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly points: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly bones: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly colorize: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly pointLabels: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly arrows: SimpleSignal<number, this>;
  @initial(400) @signal() public declare readonly maskGrow: SimpleSignal<number, this>;
  @initial(1) @signal() public declare readonly room: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly roomTint: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly pixel: SimpleSignal<number, this>;
  /** show only what is nearer than this (m): the picture builds up with the light, or empties again */
  @initial(99) @signal() public declare readonly depthMax: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly edge: SimpleSignal<number, this>;
  /** the look of the bodies (body/styles.ts) */
  @initial(DEFAULT_STYLE) @signal() public declare readonly bodyStyle: SimpleSignal<string, this>;
  /** size of the text (1 = for 1080p landscape; larger for a phone screen) */
  @initial(1) @signal() public declare readonly textScale: SimpleSignal<number, this>;

  public constructor(props?: SensorPanelProps) {
    super({ width: 512, height: 424, ...props });
  }

  /** image px → local coordinates */
  private toLocal(u: number, v: number): [number, number] {
    const s = this.size();
    return [(u / INTR.w - 0.5) * s.x, (v / INTR.h - 0.5) * s.y];
  }

  protected override draw(ctx: CanvasRenderingContext2D) {
    const s = this.size();
    const W = s.x;
    const H = s.y;
    const f = sense(this.time(), this.bodyStyle() as BodyStyle);
    const chrome = this.chrome();
    ctx.save();
    // frame
    if (chrome > 0) {
      ctx.fillStyle = `rgba(0,0,0,${0.9 * chrome})`;
      ctx.fillRect(-W / 2, -H / 2, W, H);
    }
    const img = this.picture(f);
    if (img && this.image() > 0) {
      ctx.save();
      ctx.globalAlpha *= this.image();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, -W / 2, -H / 2, W, H);
      ctx.restore();
    }
    if (this.scan() > 0) this.drawScan(ctx, W, H);
    if (this.arrows() > 0) this.drawFlowArrows(ctx, f);
    if (this.boxes() > 0) this.drawBoxes(ctx, f);
    if (this.bones() > 0) this.drawBones(ctx, f);
    if (this.points() > 0) this.drawPoints(ctx, f);
    if (this.pointLabels() > 0) this.drawPointLabels(ctx, f);
    if (this.pixel() > 0) this.drawPixel(ctx, f);
    if (chrome > 0) {
      ctx.strokeStyle = `rgba(160,180,210,${0.45 * chrome})`;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-W / 2, -H / 2, W, H);
      const title = this.title();
      if (title) {
        ctx.font = `600 ${26 * this.textScale()}px ${FONT}`;
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'left';
        ctx.fillStyle = rgba([0.93, 0.95, 0.98], chrome);
        ctx.fillText(title, -W / 2, -H / 2 - 12 * this.textScale());
      }
    }
    if (this.legend() > 0) this.drawLegend(ctx, W, H);
    ctx.restore();
    this.drawChildren(ctx);
  }

  private picture(f: SensorFrame) {
    switch (this.mode()) {
      case 'depth':
        return depthImage(f, this.depthMax(), this.edge());
      case 'flow':
        return flowImage(f);
      case 'mask':
        return maskImage(f, this.maskGrow(), this.room(), this.roomTint());
      default:
        return irImage(f, this.depthMax(), this.edge());
    }
  }

  private drawLegend(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const a = this.legend();
    const k = this.textScale();
    const y = H / 2 + 22 * k;
    const w = W * 0.55;
    // under the right half of the picture; centered when the text is large (narrow layouts)
    const x0 = k > 1 ? -w / 2 : W / 2 - w;
    const grad = ctx.createLinearGradient(x0, 0, x0 + w, 0);
    for (let i = 0; i <= 10; i++) grad.addColorStop(i / 10, depthCss(1 - i / 10));
    ctx.globalAlpha *= a;
    ctx.fillStyle = grad;
    ctx.fillRect(x0, y - 5 * k, w, 10 * k);
    ctx.font = `500 ${20 * k}px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(220,228,240,0.9)';
    ctx.textAlign = 'right';
    ctx.fillText('nah', x0 - 12 * k, y);
    ctx.textAlign = 'left';
    ctx.fillText('fern', x0 + w + 12 * k, y);
    ctx.globalAlpha /= a;
  }

  private drawScan(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const p = this.scan();
    if (p >= 1) return;
    const y = -H / 2 + H * p;
    const sensor = hexRgb(C.sensor);
    const grad = ctx.createLinearGradient(0, y - 90, 0, y);
    grad.addColorStop(0, rgba(sensor, 0));
    grad.addColorStop(1, rgba(sensor, 0.28));
    ctx.fillStyle = grad;
    ctx.fillRect(-W / 2, y - 90, W, 90);
    ctx.strokeStyle = rgba(sensor, 0.95);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-W / 2, y);
    ctx.lineTo(W / 2, y);
    ctx.stroke();
  }

  private personColor(p: { color: [number, number, number] }) {
    const k = this.colorize();
    const w: [number, number, number] = [0.92, 0.94, 0.98];
    return [lerp(w[0], p.color[0], k), lerp(w[1], p.color[1], k), lerp(w[2], p.color[2], k)] as [number, number, number];
  }

  private drawBoxes(ctx: CanvasRenderingContext2D, f: SensorFrame) {
    const p = this.boxes();
    for (const [n, person] of f.persons.entries()) {
      const q = clamp(p * 1.4 - n * 0.25);
      if (q <= 0) continue;
      const [u0, v0, u1, v1] = person.bbox;
      const pad = 4;
      const [x0, y0] = this.toLocal(u0 - pad, v0 - pad);
      const [x1, y1] = this.toLocal(u1 + pad, v1 + pad);
      const col = this.personColor(person);
      const arm = Math.min(x1 - x0, y1 - y0) * 0.5 * smooth(0, 0.6, q);
      const full = smooth(0.5, 1, q);
      ctx.strokeStyle = rgba(col, 1);
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      // corner brackets
      for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x1, y1, -1, -1], [x0, y1, 1, -1]]) {
        ctx.moveTo(cx + sx * arm, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + sy * arm);
      }
      ctx.stroke();
      if (full > 0) {
        ctx.strokeStyle = rgba(col, 0.55 * full);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        ctx.fillStyle = rgba(col, 0.06 * full);
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        const label = `Mensch ${Math.round(person.score * 100)} %`;
        const k = this.textScale();
        ctx.font = `600 ${22 * k}px ${FONT}`;
        const w = ctx.measureText(label).width + 18 * k;
        ctx.fillStyle = rgba(col, 0.92 * full);
        ctx.fillRect(x0 - 1.75, y0 - 34 * k, w, 32 * k);
        ctx.fillStyle = rgba([0.03, 0.04, 0.06], full);
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(label, x0 + 7 * k, y0 - 17 * k);
      }
    }
  }

  private drawPoints(ctx: CanvasRenderingContext2D, f: SensorFrame) {
    const p = this.points();
    for (const [n, person] of f.persons.entries()) {
      const col = this.personColor(person);
      for (let k = 0; k < 17; k++) {
        const [u, v, c] = person.kp[k];
        if (c < 0.2) continue;
        const q = clamp((p - (k / 17) * 0.55 - n * 0.12) / 0.3);
        if (q <= 0) continue;
        const r = 6.5 * easeOutBack(q);
        const [x, y] = this.toLocal(u + 0.5, v + 0.5);
        ctx.fillStyle = rgba([0.02, 0.03, 0.05], 0.8);
        ctx.beginPath();
        ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = rgba(col, c > 0.5 ? 1 : 0.5);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawBones(ctx: CanvasRenderingContext2D, f: SensorFrame) {
    const p = this.bones();
    for (const [n, person] of f.persons.entries()) {
      const col = this.personColor(person);
      for (const [width, a] of [[10, 0.22], [4, 1]]) {
        ctx.strokeStyle = rgba(col, a);
        ctx.lineWidth = width;
        ctx.beginPath();
        COCO_BONES.forEach(([i, j], b) => {
          const q = clamp((p - (b / COCO_BONES.length) * 0.5 - n * 0.1) / 0.35);
          if (q <= 0) return;
          const A = person.kp[i];
          const B = person.kp[j];
          if (A[2] < 0.2 || B[2] < 0.2) return;
          const [ax, ay] = this.toLocal(A[0] + 0.5, A[1] + 0.5);
          const [bx, by] = this.toLocal(B[0] + 0.5, B[1] + 0.5);
          ctx.moveTo(ax, ay);
          ctx.lineTo(lerp(ax, bx, q), lerp(ay, by, q));
        });
        ctx.stroke();
      }
    }
  }

  private drawPointLabels(ctx: CanvasRenderingContext2D, f: SensorFrame) {
    const p = this.pointLabels();
    const person = f.persons.find((q) => q.slot === ROLES.lead);
    if (!person) return;
    const ts = this.textScale();
    ctx.font = `600 ${22 * ts}px ${FONT}`;
    for (const [n, [k, name]] of POINT_NAMES.entries()) {
      const q = clamp(p * 1.6 - n * 0.3);
      if (q <= 0) continue;
      const [u, v, c] = person.kp[k];
      if (c < 0.2) continue;
      const [x, y] = this.toLocal(u + 0.5, v + 0.5);
      const dx = -95 * ts;
      const dy = (n === 0 ? -40 : n === 1 ? -20 : 10) * ts;
      ctx.strokeStyle = `rgba(240,244,250,${0.8 * q})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 8, y);
      ctx.lineTo(x + dx * q, y + dy * q);
      ctx.stroke();
      ctx.fillStyle = `rgba(240,244,250,${q})`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, x + dx - 8, y + dy);
    }
  }

  private drawFlowArrows(ctx: CanvasRenderingContext2D, f: SensorFrame) {
    const a = this.arrows();
    const step = 10;
    for (let v = step / 2; v < INTR.h; v += step) {
      for (let u = step / 2; u < INTR.w; u += step) {
        const i = v * INTR.w + u;
        if (!f.label[i]) continue;
        const fu = f.flowU[i];
        const fv = f.flowV[i];
        const m = Math.hypot(fu, fv);
        if (m < 0.35) continue;
        const k = 7;
        const [x, y] = this.toLocal(u, v);
        const [x2, y2] = this.toLocal(u + fu * k, v + fv * k);
        const c = flowColor(fu, fv);
        ctx.strokeStyle = rgba(c, a);
        ctx.fillStyle = rgba(c, a);
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        const ang = Math.atan2(y2 - y, x2 - x);
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - 7 * Math.cos(ang - 0.5), y2 - 7 * Math.sin(ang - 0.5));
        ctx.lineTo(x2 - 7 * Math.cos(ang + 0.5), y2 - 7 * Math.sin(ang + 0.5));
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  private drawPixel(ctx: CanvasRenderingContext2D, f: SensorFrame) {
    const t = rayTarget(f);
    if (!t) return;
    const p = this.pixel();
    const [x, y] = this.toLocal(t.u + 0.5, t.v + 0.5);
    const s = this.size();
    const cell = (s.x / INTR.w) * 2.5;
    const pulse = 1 + 0.25 * Math.sin(this.time() * 9);
    ctx.strokeStyle = `rgba(255,255,255,${p})`;
    ctx.lineWidth = 2.5;
    const r = (cell + 10 * (1 - smooth(0, 0.5, p))) * pulse;
    ctx.strokeRect(x - r, y - r, 2 * r, 2 * r);
    ctx.fillStyle = `rgba(255,255,255,${p})`;
    ctx.fillRect(x - cell / 2, y - cell / 2, cell, cell);
  }
}
