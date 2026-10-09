// The fluid on the LED wall, a small version of the scene `fluid-simulation`: the people's motion
// (mapped onto the wall: mirrored, real size, the walk stretched) pushes the flow, and color comes
// only from moving bodies. Stable fluids (semi-Lagrangian advection, Jacobi pressure, vorticity) on
// a 168 × 56 grid, one step per video frame. Deterministic in story time: asking for an earlier
// moment simulates again from the start.

import { clamp } from './math';
import { Pose, people } from './people';
import { FLUID_START } from './timeline';
import { WALL } from './world';
import { mapToWall, tracked } from './mapping';

export const NX = 168;
export const NY = 56;
const FPS = 60;
const DT = 1 / FPS;

class Grid {
  u = new Float32Array(NX * NY);
  v = new Float32Array(NX * NY);
  u2 = new Float32Array(NX * NY);
  v2 = new Float32Array(NX * NY);
  p = new Float32Array(NX * NY);
  div = new Float32Array(NX * NY);
  curl = new Float32Array(NX * NY);
  dye = [new Float32Array(NX * NY), new Float32Array(NX * NY), new Float32Array(NX * NY)];
  dye2 = [new Float32Array(NX * NY), new Float32Array(NX * NY), new Float32Array(NX * NY)];
}

const id = (x: number, y: number) => y * NX + x;

function sample(f: Float32Array, x: number, y: number) {
  x = clamp(x, 0, NX - 1.001);
  y = clamp(y, 0, NY - 1.001);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i = id(x0, y0);
  return (f[i] * (1 - fx) + f[i + 1] * fx) * (1 - fy) + (f[i + NX] * (1 - fx) + f[i + NX + 1] * fx) * fy;
}

export class Fluid {
  g = new Grid();
  frame = -1;
  canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
  private img = this.ctx.createImageData(NX, NY);
  private drawn = -2;
  private prev: Pose[] = [];

  constructor() {
    this.canvas.width = NX;
    this.canvas.height = NY;
  }

  reset() {
    this.g = new Grid();
    this.frame = -1;
    this.prev = [];
  }

  /** advance to story time T */
  at(T: number) {
    const target = Math.floor((T - FLUID_START) * FPS);
    if (target < this.frame) this.reset();
    while (this.frame < target) {
      this.frame++;
      this.step(FLUID_START + this.frame / FPS);
    }
    return this;
  }

  /** steer the flow around (x, y) towards (tu, tv) cells/s and add dye */
  private splat(x: number, y: number, r: number, tu: number, tv: number, blend: number, cr: number, cg: number, cb: number, amount: number) {
    const g = this.g;
    const x0 = Math.max(1, Math.floor(x - r * 2.2));
    const x1 = Math.min(NX - 2, Math.ceil(x + r * 2.2));
    const y0 = Math.max(1, Math.floor(y - r * 2.2));
    const y1 = Math.min(NY - 2, Math.ceil(y + r * 2.2));
    const k = 1 / (r * r);
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const d2 = (xx - x) ** 2 + (yy - y) ** 2;
        const w = Math.exp(-d2 * k);
        if (w < 0.01) continue;
        const i = id(xx, yy);
        const b = blend * w;
        g.u[i] += (tu - g.u[i]) * b;
        g.v[i] += (tv - g.v[i]) * b;
        if (amount > 0) {
          g.dye[0][i] += cr * amount * w;
          g.dye[1][i] += cg * amount * w;
          g.dye[2][i] += cb * amount * w;
        }
      }
    }
  }

  private step(T: number) {
    const g = this.g;
    const cells = NX / WALL.w; // cells per meter
    // forces and dye from the moving bodies
    const now = tracked(people(T));
    for (const p of now) {
      const before = this.prev.find((q) => q.slot === p.slot);
      if (!before) continue;
      for (let c = 0; c < p.capsules.length; c++) {
        const cap = p.capsules[c];
        const old = before.capsules[c];
        const len = Math.hypot(cap.b[0] - cap.a[0], cap.b[1] - cap.a[1], cap.b[2] - cap.a[2]);
        const n = Math.max(1, Math.ceil(len / 0.07));
        const arm = c >= 5 && c <= 10;
        for (let s = 0; s <= n; s++) {
          const t = s / n;
          const pt: [number, number, number] = [cap.a[0] + (cap.b[0] - cap.a[0]) * t, cap.a[1] + (cap.b[1] - cap.a[1]) * t, cap.a[2] + (cap.b[2] - cap.a[2]) * t];
          const po: [number, number, number] = [old.a[0] + (old.b[0] - old.a[0]) * t, old.a[1] + (old.b[1] - old.a[1]) * t, old.a[2] + (old.b[2] - old.a[2]) * t];
          const w1 = mapToWall(p, pt);
          const w0 = mapToWall(before, po);
          const vx = (w1[0] - w0[0]) / DT;
          const vy = (w1[1] - w0[1]) / DT;
          const speed = Math.hypot(vx, vy);
          if (speed < 0.12) continue;
          const gx = ((w1[0] + WALL.w / 2) / WALL.w) * NX;
          const gy = ((WALL.bottom + WALL.h - w1[1]) / WALL.h) * NY;
          if (gx < -4 || gx > NX + 4 || gy < -4 || gy > NY + 4) continue;
          const r = Math.max(1.2, cap.r * cells * (arm ? 1.5 : 1.1));
          const blend = arm ? 0.5 : 0.3;
          const amount = clamp((speed - 0.12) * 0.9) * (arm ? 0.16 : 0.1);
          this.splat(gx, gy, r, vx * cells * 1.4, -vy * cells * 1.4, blend, p.color[0], p.color[1], p.color[2], amount);
        }
      }
    }
    this.prev = now;

    // vorticity confinement: keeps the swirls alive
    for (let y = 1; y < NY - 1; y++) {
      for (let x = 1; x < NX - 1; x++) {
        const i = id(x, y);
        g.curl[i] = (g.v[i + 1] - g.v[i - 1] - (g.u[i + NX] - g.u[i - NX])) * 0.5;
      }
    }
    const eps = 18;
    for (let y = 2; y < NY - 2; y++) {
      for (let x = 2; x < NX - 2; x++) {
        const i = id(x, y);
        const dx = Math.abs(g.curl[i + 1]) - Math.abs(g.curl[i - 1]);
        const dy = Math.abs(g.curl[i + NX]) - Math.abs(g.curl[i - NX]);
        const l = Math.hypot(dx, dy) + 1e-5;
        g.u[i] += (dy / l) * g.curl[i] * eps * DT;
        g.v[i] += (-dx / l) * g.curl[i] * eps * DT;
      }
    }

    // pressure projection
    this.project();
    // advect velocity
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        const i = id(x, y);
        const px = x - g.u[i] * DT;
        const py = y - g.v[i] * DT;
        g.u2[i] = sample(g.u, px, py) * 0.992;
        g.v2[i] = sample(g.v, px, py) * 0.992;
      }
    }
    [g.u, g.u2] = [g.u2, g.u];
    [g.v, g.v2] = [g.v2, g.v];
    this.bounds();
    this.project();
    // advect dye
    for (let c = 0; c < 3; c++) {
      const src = g.dye[c];
      const dst = g.dye2[c];
      for (let y = 0; y < NY; y++) {
        for (let x = 0; x < NX; x++) {
          const i = id(x, y);
          dst[i] = sample(src, x - g.u[i] * DT, y - g.v[i] * DT) * 0.988;
        }
      }
      g.dye[c] = dst;
      g.dye2[c] = src;
    }
  }

  private bounds() {
    const g = this.g;
    for (let x = 0; x < NX; x++) {
      g.v[id(x, 0)] = 0;
      g.v[id(x, NY - 1)] = 0;
    }
    for (let y = 0; y < NY; y++) {
      g.u[id(0, y)] = 0;
      g.u[id(NX - 1, y)] = 0;
    }
  }

  private project() {
    const g = this.g;
    for (let y = 1; y < NY - 1; y++) {
      for (let x = 1; x < NX - 1; x++) {
        const i = id(x, y);
        g.div[i] = -0.5 * (g.u[i + 1] - g.u[i - 1] + g.v[i + NX] - g.v[i - NX]);
        g.p[i] *= 0.8;
      }
    }
    for (let k = 0; k < 24; k++) {
      for (let y = 1; y < NY - 1; y++) {
        for (let x = 1; x < NX - 1; x++) {
          const i = id(x, y);
          g.p[i] = (g.div[i] + g.p[i - 1] + g.p[i + 1] + g.p[i - NX] + g.p[i + NX]) / 4;
        }
      }
    }
    for (let y = 1; y < NY - 1; y++) {
      for (let x = 1; x < NX - 1; x++) {
        const i = id(x, y);
        g.u[i] -= 0.5 * (g.p[i + 1] - g.p[i - 1]);
        g.v[i] -= 0.5 * (g.p[i + NX] - g.p[i - NX]);
      }
    }
  }

  /** the dye as a NX × NY canvas */
  image() {
    if (this.drawn === this.frame) return this.canvas;
    this.drawn = this.frame;
    const px = this.img.data;
    const [r, g, b] = this.g.dye;
    for (let i = 0; i < NX * NY; i++) {
      const o = i * 4;
      // tone map the brightness only, so dense dye keeps its color instead of turning white
      const m = Math.max(r[i], g[i], b[i], 1e-6);
      const k = ((1 - Math.exp(-m * 1.8)) / m) * 255;
      px[o] = r[i] * k;
      px[o + 1] = g[i] * k;
      px[o + 2] = b[i] * k;
      px[o + 3] = 255;
    }
    this.ctx.putImageData(this.img, 0, 0);
    return this.canvas;
  }
}

/** one fluid for the whole video (scene "daten" starts it, scene "wand" continues it) */
export const FLUID = new Fluid();
