// A flat band instead of a round cable: yellow on top, dark below. Where it turns about its own
// axis it narrows to an edge and shows the other face, so a twist is easy to see. Drawn from the
// same geometry as the Cable (pts, phi), depth-sorted the same way.

import { Node, NodeProps, initial, signal } from '@motion-canvas/2d';
import { SignalValue, SimpleSignal } from '@motion-canvas/core';
import { CableGeom } from '../lib/geom';
import { C } from '../lib/theme';

export interface RibbonProps extends NodeProps {
  geom?: SignalValue<CableGeom>;
  breadth?: SignalValue<number>;
  front?: SignalValue<string>;
  back?: SignalValue<string>;
  halo?: SignalValue<string>;
}

const RUN = 6;

function shade(hex: string, k: number) {
  const v = parseInt(hex.slice(1), 16);
  const f = (s: number) => Math.round(((v >> s) & 255) * k);
  return `rgb(${f(16)},${f(8)},${f(0)})`;
}

export class Ribbon extends Node {
  @initial({ pts: [] }) @signal() public declare readonly geom: SimpleSignal<CableGeom, this>;
  @initial(36) @signal() public declare readonly breadth: SimpleSignal<number, this>;
  @initial(C.stripe) @signal() public declare readonly front: SimpleSignal<string, this>;
  @initial('#3a4250') @signal() public declare readonly back: SimpleSignal<string, this>;
  @initial(C.bg) @signal() public declare readonly halo: SimpleSignal<string, this>;

  public constructor(props?: RibbonProps) {
    super(props);
  }

  protected override draw(ctx: CanvasRenderingContext2D) {
    const g = this.geom();
    const pts = g.pts;
    const n = pts.length;
    if (n < 2) {
      this.drawChildren(ctx);
      return;
    }
    const W = this.breadth() / 2;
    const phi = g.phi ?? [];
    const front = this.front();
    const back = this.back();
    const halo = this.halo();
    // the two edges of the band in the picture: they swap sides where the band turns, and the one
    // that comes toward us crosses in front (that shows which way it turns)
    const ax = new Float32Array(n);
    const ay = new Float32Array(n);
    const bx = new Float32Array(n);
    const by = new Float32Array(n);
    const cs = new Float32Array(n);
    const sn = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      let dx = b[0] - a[0];
      let dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      dx /= l;
      dy /= l;
      const c = Math.cos(phi[i] ?? 0);
      cs[i] = c;
      sn[i] = Math.sin(phi[i] ?? 0);
      const w = W * c;
      ax[i] = pts[i][0] - dy * w;
      ay[i] = pts[i][1] + dx * w;
      bx[i] = pts[i][0] + dy * w;
      by[i] = pts[i][1] - dx * w;
    }
    const runs: { i: number; j: number; z: number }[] = [];
    for (let i = 0; i < n - 1; i += RUN) {
      const j = Math.min(i + RUN, n - 1);
      let z = 0;
      for (let k = i; k <= j; k++) z += pts[k][2];
      runs.push({ i, j, z: z / (j - i + 1) });
    }
    runs.sort((a, b) => a.z - b.z);

    ctx.save();
    ctx.lineJoin = 'round';
    for (const r of runs) {
      // a halo along the middle, so that a band on top cuts the one below
      ctx.beginPath();
      for (let k = r.i; k <= r.j; k++) (k === r.i ? ctx.moveTo : ctx.lineTo).call(ctx, pts[k][0], pts[k][1]);
      ctx.lineCap = 'butt';
      ctx.strokeStyle = halo;
      let wmax = 0;
      for (let k = r.i; k <= r.j; k++) wmax = Math.max(wmax, Math.abs(cs[k]));
      ctx.lineWidth = 2 * W * wmax + 12;
      ctx.stroke();
      // the faces, one quad per step
      for (let k = r.i; k < r.j; k++) {
        const c = (cs[k] + cs[k + 1]) / 2;
        ctx.beginPath();
        ctx.moveTo(ax[k], ay[k]);
        ctx.lineTo(ax[k + 1], ay[k + 1]);
        ctx.lineTo(bx[k + 1], by[k + 1]);
        ctx.lineTo(bx[k], by[k]);
        ctx.closePath();
        const col = c >= 0 ? shade(front, 0.72 + 0.28 * Math.abs(c)) : shade(back, 0.75 + 0.25 * Math.abs(c));
        ctx.fillStyle = col;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();
      }
      // the edges, the nearer one last; where the band is edge-on the nearer edge cuts the other
      const segs: { z: number; e: 0 | 1; k: number }[] = [];
      for (let k = r.i; k < r.j; k++) {
        const z = (sn[k] + sn[k + 1]) / 2;
        segs.push({ z, e: 0, k }, { z: -z, e: 1, k });
      }
      segs.sort((a, b) => a.z - b.z);
      // back edges first, then the front edges
      const line = (sg: { e: 0 | 1; k: number }) => {
        const [ex, ey] = sg.e === 0 ? [ax, ay] : [bx, by];
        ctx.moveTo(ex[sg.k], ey[sg.k]);
        ctx.lineTo(ex[sg.k + 1], ey[sg.k + 1]);
      };
      ctx.lineCap = 'round';
      ctx.strokeStyle = C.cableEdge;
      ctx.lineWidth = 2.5;
      for (const front of [false, true]) {
        ctx.beginPath();
        for (const sg of segs) if (sg.z > 0 === front) line(sg);
        ctx.stroke();
      }
    }
    // the ends
    for (const k of [0, n - 1]) {
      ctx.beginPath();
      ctx.moveTo(ax[k], ay[k]);
      ctx.lineTo(bx[k], by[k]);
      ctx.strokeStyle = C.cableEdge;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    ctx.restore();
    this.drawChildren(ctx);
  }
}
