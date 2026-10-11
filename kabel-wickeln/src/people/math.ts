// Small vector and quaternion helpers for the people (ported from erklaervideo/src/lib/math.ts and
// extended with quaternions for grip frames). Units: metres, radians; quaternions are [x, y, z, w].

export type V3 = [number, number, number];
export type Quat = [number, number, number, number];
export type RGB = [number, number, number];

export const clamp = (v: number, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const easeInOut = (t: number) => {
  const x = clamp(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
/** a + b·s */
export const madd = (a: V3, b: V3, s: number): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const mix3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
/** v without its part along the unit vector d, normalised */
export const across = (v: V3, d: V3) => norm(madd(v, d, -dot(v, d)));
/** a + R*r + U*u + F*f */
export const local = (a: V3, R: V3, U: V3, F: V3, r: number, u: number, f: number): V3 => [
  a[0] + R[0] * r + U[0] * u + F[0] * f,
  a[1] + R[1] * r + U[1] * u + F[1] * f,
  a[2] + R[2] * r + U[2] * u + F[2] * f,
];
/** v turned about the unit axis by angle a (Rodrigues) */
export function turn(v: V3, axis: V3, a: number): V3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const k = dot(axis, v) * (1 - c);
  const x = cross(axis, v);
  return [v[0] * c + x[0] * s + axis[0] * k, v[1] * c + x[1] * s + axis[1] * k, v[2] * c + x[2] * s + axis[2] * k];
}

export function hexRgb(hex: string): RGB {
  const v = Number.parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

// ---------------------------------------------------------------- quaternions

/** the rotated basis vectors (columns of the rotation matrix): d1, d2, d3 */
export function quatCols(q: Quat): [V3, V3, V3] {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
    [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
    [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
  ];
}

/** the quaternion whose columns are the orthonormal right-handed basis d1, d2, d3 */
export function quatFromCols(d1: V3, d2: V3, d3: V3): Quat {
  const tr = d1[0] + d2[1] + d3[2];
  let q: Quat;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q = [(d2[2] - d3[1]) * s, (d3[0] - d1[2]) * s, (d1[1] - d2[0]) * s, 0.25 / s];
  } else if (d1[0] > d2[1] && d1[0] > d3[2]) {
    const s = 2 * Math.sqrt(1 + d1[0] - d2[1] - d3[2]);
    q = [0.25 * s, (d2[0] + d1[1]) / s, (d3[0] + d1[2]) / s, (d2[2] - d3[1]) / s];
  } else if (d2[1] > d3[2]) {
    const s = 2 * Math.sqrt(1 + d2[1] - d1[0] - d3[2]);
    q = [(d2[0] + d1[1]) / s, 0.25 * s, (d3[1] + d2[2]) / s, (d3[0] - d1[2]) / s];
  } else {
    const s = 2 * Math.sqrt(1 + d3[2] - d1[0] - d2[1]);
    q = [(d3[0] + d1[2]) / s, (d3[1] + d2[2]) / s, 0.25 * s, (d1[1] - d2[0]) / s];
  }
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function quatAxisAngle(axis: V3, a: number): Quat {
  const n = norm(axis);
  const s = Math.sin(a / 2);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(a / 2)];
}

/** a·b: first b, then a */
export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** spherical interpolation along the shorter arc */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1;
  d *= s;
  let wa = 1 - t;
  let wb = t * s;
  if (d < 0.9995) {
    const th = Math.acos(d);
    const sn = Math.sin(th);
    wa = Math.sin((1 - t) * th) / sn;
    wb = (Math.sin(t * th) / sn) * s;
  }
  const q: Quat = [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb, a[3] * wa + b[3] * wb];
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
