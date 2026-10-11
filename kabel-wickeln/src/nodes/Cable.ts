// A cable drawn from a 3D polyline (lib/geom.ts): black jacket with a dark edge and a soft glint,
// a printed yellow stripe that shows how the cable is twisted, plugs at the ends. Where strands
// cross, the upper one (bigger z) is drawn later and cuts a gap of background colour into the lower
// one, like in a knot diagram.

import { Node, NodeProps, initial, signal } from '@motion-canvas/2d';
import { SignalValue, SimpleSignal } from '@motion-canvas/core';
import { CableGeom } from '../lib/geom';
import { C } from '../lib/theme';

export interface CableProps extends NodeProps {
  geom?: SignalValue<CableGeom>;
  thickness?: SignalValue<number>;
  color?: SignalValue<string>;
  halo?: SignalValue<string>;
  /** opacity of the printed stripe */
  stripe?: SignalValue<number>;
  /** draw only this part of the cable (0..1 from the start), for drawing it in */
  trim?: SignalValue<number>;
}

/** points per depth-sorted piece */
const RUN = 7;
/** where the light comes from (in the picture plane) */
const LX = -0.45;
const LY = -0.89;

export class Cable extends Node {
  @initial({ pts: [] }) @signal() public declare readonly geom: SimpleSignal<CableGeom, this>;
  @initial(18) @signal() public declare readonly thickness: SimpleSignal<number, this>;
  @initial(C.cable) @signal() public declare readonly color: SimpleSignal<string, this>;
  @initial(C.bg) @signal() public declare readonly halo: SimpleSignal<string, this>;
  @initial(1) @signal() public declare readonly stripe: SimpleSignal<number, this>;
  @initial(1) @signal() public declare readonly trim: SimpleSignal<number, this>;

  public constructor(props?: CableProps) {
    super(props);
  }

  protected override draw(ctx: CanvasRenderingContext2D) {
    const full = this.geom();
    const trim = this.trim();
    const g = trim >= 1 ? full : { ...full, plugEnd: false, pts: full.pts.slice(0, Math.max(0, Math.round(full.pts.length * trim))) };
    const pts = g.pts;
    const n = pts.length;
    if (n < 2) {
      this.drawChildren(ctx);
      return;
    }
    const W = this.thickness();
    const color = this.color();
    const halo = this.halo();
    const stripe = this.stripe();
    const phi = g.phi;

    // normals
    const nx = new Float32Array(n);
    const ny = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      let dx = b[0] - a[0];
      let dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      dx /= l;
      dy /= l;
      nx[i] = -dy;
      ny[i] = dx;
    }

    const runs: { i: number; j: number; z: number }[] = [];
    for (let i = 0; i < n - 1; i += RUN) {
      const j = Math.min(i + RUN, n - 1);
      let z = 0;
      for (let k = i; k <= j; k++) z += pts[k][2];
      runs.push({ i, j, z: z / (j - i + 1) });
    }
    runs.sort((a, b) => a.z - b.z);

    const trace = (i: number, j: number, off?: (k: number) => number) => {
      ctx.beginPath();
      for (let k = i; k <= j; k++) {
        const o = off ? off(k) : 0;
        const x = pts[k][0] + nx[k] * o;
        const y = pts[k][1] + ny[k] * o;
        if (k === i) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    };
    const glint = (k: number) => W * 0.24 * (nx[k] * LX + ny[k] * LY);

    ctx.save();
    ctx.lineJoin = 'round';
    for (const r of runs) {
      trace(r.i, r.j);
      ctx.lineCap = 'butt';
      ctx.strokeStyle = halo;
      ctx.lineWidth = W + 14;
      ctx.stroke();
      ctx.strokeStyle = C.cableEdge;
      ctx.lineWidth = W + 3;
      ctx.stroke();
      ctx.lineCap = 'round';
      ctx.strokeStyle = g.tint?.[(r.i + r.j) >> 1] ?? color;
      ctx.lineWidth = W;
      ctx.stroke();
      // glint and stripe reach a little into the neighbours: the round cap of whichever piece is
      // drawn later covers the end of the other one
      const i0 = Math.max(0, r.i - 3);
      const j0 = Math.min(n - 1, r.j + 3);
      trace(i0, j0, glint);
      ctx.strokeStyle = C.cableHi;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = W * 0.2;
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (phi && stripe > 0) this.drawStripe(ctx, pts, nx, ny, phi, i0, j0, W, stripe);
      if (r.i === 0 && g.plugStart) this.drawPlug(ctx, pts[0], pts[Math.min(n - 1, 4)], W);
      if (r.j === n - 1 && g.plugEnd) this.drawPlug(ctx, pts[n - 1], pts[Math.max(0, n - 5)], W);
    }
    ctx.restore();
    this.drawChildren(ctx);
  }

  /** the printed stripe: visible on the front half of the cable, moves sideways as it turns */
  private drawStripe(ctx: CanvasRenderingContext2D, pts: CableGeom['pts'], nx: Float32Array, ny: Float32Array, phi: number[], i: number, j: number, W: number, alpha: number) {
    ctx.lineCap = 'round';
    ctx.strokeStyle = C.stripe;
    let open = false;
    let level = -1;
    const flush = () => {
      if (open) ctx.stroke();
      open = false;
    };
    for (let k = i; k < j; k++) {
      const p0 = phi[k] ?? 0;
      const p1 = phi[k + 1] ?? p0;
      const c = Math.cos((p0 + p1) / 2);
      const a = Math.min(1, c * 2.2);
      if (a <= 0.02) {
        flush();
        level = -1;
        continue;
      }
      const q = Math.round(a * 6) / 6;
      if (q !== level || !open) {
        flush();
        level = q;
        ctx.globalAlpha = q * alpha;
        ctx.lineWidth = W * 0.2 * Math.max(0.35, c);
        ctx.beginPath();
        const o = W * 0.42 * Math.sin(p0);
        ctx.moveTo(pts[k][0] + nx[k] * o, pts[k][1] + ny[k] * o);
        open = true;
      }
      const o = W * 0.42 * Math.sin(p1);
      ctx.lineTo(pts[k + 1][0] + nx[k + 1] * o, pts[k + 1][1] + ny[k + 1] * o);
    }
    flush();
    ctx.globalAlpha = 1;
  }

  /** a plug (XLR style): rubber boot, metal shell; `p` is the end, `q` a point further in */
  private drawPlug(ctx: CanvasRenderingContext2D, p: number[], q: number[], W: number) {
    const a = Math.atan2(p[1] - q[1], p[0] - q[0]);
    ctx.save();
    ctx.translate(p[0], p[1]);
    ctx.rotate(a);
    const boot = 30;
    const shell = 46;
    const round = (x: number, y: number, w: number, h: number, r: number) => {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
    };
    round(-4, -(W + 6) / 2, boot + 4, W + 6, 6);
    ctx.fillStyle = '#1b1f25';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = C.cableEdge;
    ctx.stroke();
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      ctx.moveTo(6 + k * 8, -(W + 6) / 2 + 2);
      ctx.lineTo(6 + k * 8, (W + 6) / 2 - 2);
      ctx.strokeStyle = '#3a414c';
      ctx.stroke();
    }
    const h = W + 14;
    round(boot, -h / 2, shell, h, 7);
    const grad = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
    grad.addColorStop(0, '#eef0f3');
    grad.addColorStop(0.35, C.metal);
    grad.addColorStop(1, C.metalDark);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = '#5b626d';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(40,45,52,0.35)';
    ctx.fillRect(boot + shell - 9, -h / 2 + 3, 3, h - 6);
    ctx.restore();
  }
}
