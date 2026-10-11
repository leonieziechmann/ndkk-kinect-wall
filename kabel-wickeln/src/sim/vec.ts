// Small vector and quaternion helpers for the cable simulation and the shot scripts.
// Plain tuples, no classes; quaternions are [x, y, z, w] (three.js order).

export type V3 = [number, number, number];
export type Quat = [number, number, number, number];

/**
 * A grip frame, the interface between people and cable: p on the cable axis in the middle of
 * the fist; the columns of q are d1 (from the cable axis toward the palm), d2 = d3 × d1 and d3
 * (the direction the cable runs through the fist, in increasing node order).
 */
export interface Frame {
  p: V3;
  q: Quat;
}

export const TAU = Math.PI * 2;

/** Smoothstep of u clamped to 0..1 (ease in and out). */
export function smooth(u: number) {
  const x = Math.min(1, Math.max(0, u));
  return x * x * (3 - 2 * x);
}

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const lerp3 = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
export function normalize(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function quatFromAxisAngle(ax: number, ay: number, az: number, angle: number): Quat {
  const n = Math.hypot(ax, ay, az) || 1;
  const s = Math.sin(angle / 2) / n;
  return [ax * s, ay * s, az * s, Math.cos(angle / 2)];
}

export function quatMul(a: Readonly<Quat>, b: Readonly<Quat>): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export const quatConj = (a: Readonly<Quat>): Quat => [-a[0], -a[1], -a[2], a[3]];

export function quatRotate(q: Readonly<Quat>, v: Readonly<V3>): V3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** Quaternion whose rotation matrix has the orthonormal columns d1, d2, d3. */
export function quatFromFrame(d1: V3, d2: V3, d3: V3): Quat {
  const m00 = d1[0], m10 = d1[1], m20 = d1[2];
  const m01 = d2[0], m11 = d2[1], m21 = d2[2];
  const m02 = d3[0], m12 = d3[1], m22 = d3[2];
  const tr = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  const n = Math.hypot(x, y, z, w);
  return [x / n, y / n, z / n, w / n];
}

/** Shortest rotation taking unit vector a to unit vector b. */
export function quatFromTo(a: V3, b: V3): Quat {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.999999) {
    let ax: V3 = [0, -a[2], a[1]];
    if (Math.hypot(...ax) < 1e-6) ax = [a[2], 0, -a[0]];
    return quatFromAxisAngle(ax[0], ax[1], ax[2], Math.PI);
  }
  const c = cross(a, b);
  const q: Quat = [c[0], c[1], c[2], 1 + d];
  const n = Math.hypot(...q);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function quatSlerp(a: Readonly<Quat>, b: Readonly<Quat>, t: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s0 = d < 0 ? -1 : 1;
  d *= s0;
  if (d > 0.9995) {
    const r: Quat = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) r[i] = a[i] + (s0 * b[i] - a[i]) * t;
    const n = Math.hypot(...r);
    return [r[0] / n, r[1] / n, r[2] / n, r[3] / n];
  }
  const th = Math.acos(d), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = (s0 * Math.sin(t * th)) / s;
  return [wa * a[0] + wb * b[0], wa * a[1] + wb * b[1], wa * a[2] + wb * b[2], wa * a[3] + wb * b[3]];
}

/**
 * Grip frame from a point on the cable axis, the cable direction t (increasing node order) and
 * the direction toward the palm n (made orthogonal to t).
 */
export function gripFrame(p: V3, t: V3, n: V3): Frame {
  const d3 = normalize(t);
  const d1 = normalize(sub(n, scale(d3, dot(n, d3))));
  return { p, q: quatFromFrame(d1, cross(d3, d1), d3) };
}
