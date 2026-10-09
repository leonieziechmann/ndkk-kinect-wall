// A pinhole camera for the 3D stage. Room coordinates in meters: x to the right as the audience sees
// the wall, y up, z from the wall towards the audience (the LED wall is the plane z = 0).
// Screen coordinates are Motion Canvas pixels: origin in the middle, y down.

import { V3, cross, dot, norm, sub } from './math';

export interface CameraPose {
  /** point the camera orbits around */
  target: V3;
  /** degrees, 0 = from the audience straight at the wall, positive = from the right */
  yaw: number;
  /** degrees, positive = from above */
  pitch: number;
  /** m */
  distance: number;
  /** vertical field of view, degrees */
  fov: number;
  /** screen offset of the target, px (moves the picture without turning the camera) */
  shiftX?: number;
  shiftY?: number;
}

export class Camera {
  eye: V3 = [0, 0, 0];
  r: V3 = [1, 0, 0];
  u: V3 = [0, 1, 0];
  f: V3 = [0, 0, -1];
  focal = 1000;
  near = 0.05;
  sx = 0;
  sy = 0;

  constructor(public width = 1920, public height = 1080) {}

  setPose(p: CameraPose) {
    const yaw = (p.yaw * Math.PI) / 180;
    const pitch = (p.pitch * Math.PI) / 180;
    const eye: V3 = [
      p.target[0] + p.distance * Math.sin(yaw) * Math.cos(pitch),
      p.target[1] + p.distance * Math.sin(pitch),
      p.target[2] + p.distance * Math.cos(yaw) * Math.cos(pitch),
    ];
    this.lookAt(eye, p.target, p.fov);
    this.sx = p.shiftX ?? 0;
    this.sy = p.shiftY ?? 0;
    return this;
  }

  lookAt(eye: V3, target: V3, fov: number) {
    this.eye = eye;
    this.f = norm(sub(target, eye));
    this.r = norm(cross(this.f, [0, 1, 0]));
    this.u = cross(this.r, this.f);
    this.focal = this.height / 2 / Math.tan((fov * Math.PI) / 360);
    return this;
  }

  /** view space: x right, y up, z forward (m) */
  view(p: V3): V3 {
    const d = sub(p, this.eye);
    return [dot(d, this.r), dot(d, this.u), dot(d, this.f)];
  }

  /** [x, y, depth] on the screen, or null behind the camera */
  project(p: V3): V3 | null {
    const v = this.view(p);
    if (v[2] < this.near) return null;
    return [(v[0] * this.focal) / v[2] + this.sx, (-v[1] * this.focal) / v[2] + this.sy, v[2]];
  }

  /** the same into out (no allocation); returns false behind the camera */
  projectInto(x: number, y: number, z: number, out: Float32Array | number[], o = 0) {
    const dx = x - this.eye[0];
    const dy = y - this.eye[1];
    const dz = z - this.eye[2];
    const vz = dx * this.f[0] + dy * this.f[1] + dz * this.f[2];
    if (vz < this.near) return false;
    const vx = dx * this.r[0] + dy * this.r[1] + dz * this.r[2];
    const vy = dx * this.u[0] + dy * this.u[1] + dz * this.u[2];
    out[o] = (vx * this.focal) / vz + this.sx;
    out[o + 1] = (-vy * this.focal) / vz + this.sy;
    out[o + 2] = vz;
    return true;
  }

  /** a segment clipped at the near plane, projected; null if it lies behind the camera */
  segment(a: V3, b: V3): [number, number, number, number] | null {
    let va = this.view(a);
    let vb = this.view(b);
    const n = this.near;
    if (va[2] < n && vb[2] < n) return null;
    if (va[2] < n || vb[2] < n) {
      const t = (n - va[2]) / (vb[2] - va[2]);
      const c: V3 = [va[0] + (vb[0] - va[0]) * t, va[1] + (vb[1] - va[1]) * t, n];
      if (va[2] < n) va = c;
      else vb = c;
    }
    const f = this.focal;
    return [(va[0] * f) / va[2] + this.sx, (-va[1] * f) / va[2] + this.sy, (vb[0] * f) / vb[2] + this.sx, (-vb[1] * f) / vb[2] + this.sy];
  }

  /** pixels per meter at depth z */
  ppm(z: number) {
    return this.focal / Math.max(this.near, z);
  }
}
