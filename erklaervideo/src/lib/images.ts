// The sensor frames as pictures (512 × 424 canvases): infrared, depth in color or gray, the person
// masks and the optical flow. Cached per frame and look.

import { clamp, hsv, turbo } from './math';
import { SensorFrame } from './sensor';
import { INTR } from './world';

const cache = new Map<string, HTMLCanvasElement>();
const pool: HTMLCanvasElement[] = [];

function remember(key: string, canvas: HTMLCanvasElement) {
  cache.set(key, canvas);
  if (cache.size > 16) {
    const first = cache.keys().next().value as string;
    pool.push(cache.get(first) as HTMLCanvasElement);
    cache.delete(first);
  }
  return canvas;
}

function paint(key: string, fill: (px: Uint8ClampedArray) => void) {
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = pool.pop() ?? document.createElement('canvas');
  canvas.width = INTR.w;
  canvas.height = INTR.h;
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  const img = g.createImageData(INTR.w, INTR.h);
  fill(img.data);
  g.putImageData(img, 0, 0);
  return remember(key, canvas);
}

/** depth → 0..1 for the color scale: near (0.5 m) = 1 = warm, far (4.5 m) = 0 = cold */
export const depthT = (d: number) => clamp(1 - (d - INTR.near) / (INTR.far - INTR.near));

// the depth palette as a table
const LUT = new Uint8Array(256 * 3);
for (let i = 0; i < 256; i++) {
  const c = turbo(0.04 + 0.92 * (i / 255));
  LUT[i * 3] = Math.round(c[0] * 255);
  LUT[i * 3 + 1] = Math.round(c[1] * 255);
  LUT[i * 3 + 2] = Math.round(c[2] * 255);
}
/** far things (the room's back wall) darker, so the people stand out */
export function farDim(d: number) {
  const t = clamp((d - 3.6) / 1.4);
  return 1 - 0.65 * t * t * (3 - 2 * t);
}

export function depthColor(d: number, out: number[]) {
  const k = Math.round(depthT(d) * 255) * 3;
  out[0] = LUT[k] / 255;
  out[1] = LUT[k + 1] / 255;
  out[2] = LUT[k + 2] / 255;
  return out;
}
export function depthCss(t: number) {
  const k = Math.round(clamp(t) * 255) * 3;
  return `rgb(${LUT[k]},${LUT[k + 1]},${LUT[k + 2]})`;
}

export function irImage(f: SensorFrame) {
  return paint(`ir:${f.seq}`, (px) => {
    for (let i = 0; i < f.ir.length; i++) {
      const g = Math.round(f.ir[i] * 255);
      const o = i * 4;
      px[o] = g;
      px[o + 1] = g;
      px[o + 2] = g;
      px[o + 3] = 255;
    }
  });
}

export function depthImage(f: SensorFrame) {
  return paint(`depth:${f.seq}`, (px) => {
    for (let i = 0; i < f.depth.length; i++) {
      const d = f.depth[i];
      const o = i * 4;
      if (d <= 0) {
        px[o] = px[o + 1] = px[o + 2] = 0;
      } else {
        const k = Math.round(depthT(d) * 255) * 3;
        const dim = farDim(d);
        px[o] = LUT[k] * dim;
        px[o + 1] = LUT[k + 1] * dim;
        px[o + 2] = LUT[k + 2] * dim;
      }
      px[o + 3] = 255;
    }
  });
}

/**
 * The people in their colors, grown from their stick figures out to `grow` px; the room in gray,
 * `room` 0..1 (1 = gray depth, 0 = black).
 */
export function maskImage(f: SensorFrame, grow: number, room: number, tint: number) {
  const g = Math.round(grow);
  const r = Math.round(room * 50) / 50;
  const t = Math.round(tint * 50) / 50;
  const colors = new Map(f.persons.map((p) => [p.slot, p.color]));
  return paint(`mask:${f.seq}:${g}:${r}:${t}`, (px) => {
    for (let i = 0; i < f.depth.length; i++) {
      const o = i * 4;
      const d = f.depth[i];
      const s = f.label[i];
      const shade = d > 0 ? 0.25 + 0.75 * depthT(d) : 0;
      let cr = 0;
      let cg = 0;
      let cb = 0;
      if (d > 0) {
        // the room: gray depth, tinted blue-gray while marked as background
        const gray = shade * 0.75 * r;
        cr = gray * (1 - 0.35 * t);
        cg = gray * (1 - 0.15 * t);
        cb = gray;
      }
      if (s && f.boneDist[i] <= g) {
        const c = colors.get(s) ?? [1, 1, 1];
        const k = 0.45 + 0.55 * f.ir[i];
        cr = c[0] * k;
        cg = c[1] * k;
        cb = c[2] * k;
      } else if (s) {
        const gray = shade * 0.75;
        cr = cg = cb = gray;
      }
      px[o] = cr * 255;
      px[o + 1] = cg * 255;
      px[o + 2] = cb * 255;
      px[o + 3] = 255;
    }
  });
}

/** infrared dimmed, moving pixels colored by the direction of their motion */
export function flowImage(f: SensorFrame) {
  return paint(`flow:${f.seq}`, (px) => {
    for (let i = 0; i < f.ir.length; i++) {
      const o = i * 4;
      const base = f.ir[i] * 0.35;
      const fu = f.flowU[i];
      const fv = f.flowV[i];
      const m = Math.hypot(fu, fv);
      const a = clamp((m - 0.15) / 1.2);
      if (a > 0) {
        const c = flowColor(fu, fv);
        px[o] = (base + (c[0] - base) * a) * 255;
        px[o + 1] = (base + (c[1] - base) * a) * 255;
        px[o + 2] = (base + (c[2] - base) * a) * 255;
      } else {
        px[o] = px[o + 1] = px[o + 2] = base * 255;
      }
      px[o + 3] = 255;
    }
  });
}

/** the color of a motion direction (image px, v down): the usual flow color wheel */
export function flowColor(fu: number, fv: number) {
  const h = (Math.atan2(-fv, fu) / (2 * Math.PI) + 1) % 1;
  return hsv(h, 0.85, 1);
}
