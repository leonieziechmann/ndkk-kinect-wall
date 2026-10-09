// The room of the installation: LED wall on a goal-post truss, the Kinect in front of it at the
// middle, a few things standing around (they show up in the depth image and get removed later).
// Meters; x to the right as the audience sees the wall, y up, z from the wall towards the audience.
// The values follow web/WALL.md (6 × 2 m, 1008 × 336 LEDs, Kinect 0.85 m high in front of the wall,
// sees 0.5–4.5 m); the panels are 0.5 m wide and 1 m high (84 × 168 LEDs), 12 × 2 of them. The Kinect
// stands on a photo/video tripod.

import { V3 } from './math';

export const WALL = { w: 6, h: 2, bottom: 0.6, z: 0, cols: 12, rows: 2, depth: 0.09, ledW: 1008, ledH: 336 };
export const TRUSS = { x: WALL.w / 2 + 0.38, z: -0.07, size: 0.29, height: 3.4, chord: 0.05, lacing: 0.022 };
/** the flying bar on top of the wall: the panels hang from it, it hangs from the truss on slings */
export const FLYBAR = { x0: -WALL.w / 2 - 0.02, x1: WALL.w / 2 + 0.02, y0: WALL.bottom + WALL.h, y1: WALL.bottom + WALL.h + 0.09, z0: -0.06, z1: 0.02 };
/** where the round slings go around the truss */
export const SLINGS = [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5];
export const KINECT: V3 = [0, 0.85, 0.25];
/** depth camera intrinsics at 512 × 424 (Kinect v2: about 70° × 60°) */
export const INTR = { w: 512, h: 424, f: 365, cx: 256, cy: 212, near: 0.5, far: 4.5 };
export const ROOM = { back: 5.4, side: 4.2, ceiling: 3.5 };

export interface Box {
  min: V3;
  max: V3;
  albedo: number;
}
const box = (c: V3, s: V3, albedo = 0.55): Box => ({
  min: [c[0] - s[0] / 2, c[1] - s[1] / 2, c[2] - s[2] / 2],
  max: [c[0] + s[0] / 2, c[1] + s[1] / 2, c[2] + s[2] / 2],
  albedo,
});

/** furniture: a bar table, a flight case, a bench and a column */
export const FURNITURE: Box[] = [
  box([-2.35, 1.085, 4.3], [0.72, 0.05, 0.72], 0.7),
  box([-2.35, 0.54, 4.3], [0.07, 1.04, 0.07], 0.5),
  box([-2.35, 0.015, 4.3], [0.46, 0.03, 0.46], 0.5),
  box([2.45, 0.42, 4.65], [0.62, 0.84, 0.5], 0.45),
  box([0.55, 0.22, 4.95], [1.5, 0.44, 0.55], 0.6),
  box([0.55, 0.66, 5.2], [1.5, 0.44, 0.12], 0.6),
  box([-3.3, 1.75, 4.95], [0.42, 3.5, 0.42], 0.65),
];

export interface Seg {
  a: V3;
  b: V3;
  /** build progress (0..1) at which this piece appears */
  at: number;
  /** tube diameter (m) */
  d: number;
}

/** the truss as tubes: main chords and zigzag lacing; two towers growing up, then the beam across */
export function trussSegments(): Seg[] {
  const out: Seg[] = [];
  const h = TRUSS.size / 2;
  const top = TRUSS.height;
  const step = 0.25;
  const towerEnd = 0.62;
  const chord = TRUSS.chord;
  const lacing = TRUSS.lacing;
  for (const [ti, x0] of [-TRUSS.x, TRUSS.x].entries()) {
    const delay = ti * 0.08;
    const corners: [number, number][] = [[-h, -h], [h, -h], [h, h], [-h, h]];
    const at = (y: number) => delay + (y / top) * (towerEnd - 0.08);
    for (let y = 0; y < top - 1e-6; y += step) {
      const y1 = Math.min(top, y + step);
      for (const [cx, cz] of corners) out.push({ a: [x0 + cx, y, TRUSS.z + cz], b: [x0 + cx, y1, TRUSS.z + cz], at: at(y), d: chord });
      // zigzag lacing on the four faces
      for (let f = 0; f < 4; f++) {
        const [ax, az] = corners[f];
        const [bx, bz] = corners[(f + 1) % 4];
        const flip = Math.round(y / step) % 2 === 1;
        const p: V3 = flip ? [x0 + ax, y, TRUSS.z + az] : [x0 + bx, y, TRUSS.z + bz];
        const q: V3 = flip ? [x0 + bx, y1, TRUSS.z + bz] : [x0 + ax, y1, TRUSS.z + az];
        out.push({ a: p, b: q, at: at(y) + 0.01, d: lacing });
      }
    }
  }
  // the beam on top of the towers
  const by = top - h;
  const x0 = -TRUSS.x - h;
  const x1 = TRUSS.x + h;
  const yz: [number, number][] = [[-h, -h], [h, -h], [h, h], [-h, h]];
  for (let x = x0; x < x1 - 1e-6; x += step) {
    const xe = Math.min(x1, x + step);
    const at = towerEnd + ((x - x0) / (x1 - x0)) * (1 - towerEnd);
    for (const [cy, cz] of yz) out.push({ a: [x, by + cy, TRUSS.z + cz], b: [xe, by + cy, TRUSS.z + cz], at, d: chord });
    for (let f = 0; f < 4; f++) {
      const [ay, az] = yz[f];
      const [cy, cz] = yz[(f + 1) % 4];
      const flip = Math.round((x - x0) / step) % 2 === 1;
      const p: V3 = flip ? [x, by + ay, TRUSS.z + az] : [x, by + cy, TRUSS.z + cz];
      const q: V3 = flip ? [xe, by + cy, TRUSS.z + cz] : [xe, by + ay, TRUSS.z + az];
      out.push({ a: p, b: q, at: at + 0.005, d: lacing });
    }
  }
  return out;
}

/** an axis-aligned box as its 8 corners (for solid parts: base plates, corner blocks, the flying bar) */
export function boxCorners(min: V3, max: V3): V3[] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
}
export const BOX_FACES = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]];

export interface Cabinet {
  col: number;
  row: number;
  /** corners top-left, top-right, bottom-right, bottom-left (front face) */
  corners: V3[];
  /** order in which they are hung (0..23): column by column, the top panel first */
  order: number;
}

export function cabinets(): Cabinet[] {
  const out: Cabinet[] = [];
  const cw = WALL.w / WALL.cols;
  const ch = WALL.h / WALL.rows;
  for (let row = 0; row < WALL.rows; row++) {
    for (let col = 0; col < WALL.cols; col++) {
      const x0 = -WALL.w / 2 + col * cw;
      const y1 = WALL.bottom + WALL.h - row * ch;
      out.push({
        col,
        row,
        corners: [[x0, y1, WALL.z], [x0 + cw, y1, WALL.z], [x0 + cw, y1 - ch, WALL.z], [x0, y1 - ch, WALL.z]],
        order: col * WALL.rows + row,
      });
    }
  }
  return out;
}

/** the corners of the field of view at distance d (m from the sensor): TL, TR, BR, BL as the audience sees it */
export function fovCorners(d: number): V3[] {
  const hx = (INTR.cx / INTR.f) * d;
  const hy = (INTR.cy / INTR.f) * d;
  const [x, y, z] = KINECT;
  return [
    [x - hx, y + hy, z + d],
    [x + hx, y + hy, z + d],
    [x + hx, y - hy, z + d],
    [x - hx, y - hy, z + d],
  ];
}

/** the part of the floor the Kinect sees between near and far (polygon on y = 0) */
export function floorZone(near = INTR.near, far = INTR.far): V3[] {
  const tanV = INTR.cy / INTR.f;
  const tanH = INTR.cx / INTR.f;
  const d0 = Math.max(near, KINECT[1] / tanV);
  const z0 = KINECT[2] + d0;
  const z1 = KINECT[2] + far;
  return [
    [-tanH * d0, 0, z0],
    [tanH * d0, 0, z0],
    [tanH * far, 0, z1],
    [-tanH * far, 0, z1],
  ];
}

/** a polygon cut at the floor: only the part with y >= 0 */
export function aboveFloor(poly: V3[]): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ia = a[1] >= 0;
    const ib = b[1] >= 0;
    if (ia) out.push(a);
    if (ia !== ib) {
      const t = a[1] / (a[1] - b[1]);
      out.push([a[0] + (b[0] - a[0]) * t, 0, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

/** a segment cut at the floor, or null below it */
export function segAboveFloor(a: V3, b: V3): [V3, V3] | null {
  if (a[1] < 0 && b[1] < 0) return null;
  if (a[1] >= 0 && b[1] >= 0) return [a, b];
  const t = a[1] / (a[1] - b[1]);
  const c: V3 = [a[0] + (b[0] - a[0]) * t, 0, a[2] + (b[2] - a[2]) * t];
  return a[1] >= 0 ? [a, c] : [c, b];
}
