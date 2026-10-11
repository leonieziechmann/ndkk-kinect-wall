// Camera helpers. All are pure functions of their arguments (no state, no clocks), so a camera is
// keyframed by computing its parameters from the scene clock and calling one of these per frame.
//
//   orbit        a camera on a sphere around a target (yaw, pitch, distance): establishing shots,
//                freeze + orbit around a hand
//   mixOrbit     blends two orbits (yaw the short way round): camera moves between beats
//   lookFrom     a camera at a position looking at a point (dolly paths)
//   povCamera    the first-person camera from the eyes, a bit lower and further forward than
//                anatomy allows so both hands and the coil fit; hides the own head and torso
//   smoothed     a deterministic moving average of a moving point (a calm POV, no wobble)

import * as THREE from 'three';
import type { V3 } from '../sim/vec';

/** the layer of the own head, hair, neck, torso and upper arms (people/body/mesh.ts SELF) */
export const SELF_LAYER = 1;

export interface Orbit {
  target: V3;
  /** around y, 0 = camera on +z looking towards -z (rad) */
  yaw: number;
  /** above the horizontal (rad) */
  pitch: number;
  dist: number;
  /** vertical field of view (deg) */
  fov?: number;
}

/** a perspective camera that sees every layer (outside views must show the whole person) */
export function makeCamera(fov = 35, near = 0.02, far = 60): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(fov, 16 / 9, near, far);
  cam.layers.enableAll();
  return cam;
}

/** places cam on the orbit, looking at its target */
export function orbit(cam: THREE.PerspectiveCamera, o: Orbit): THREE.PerspectiveCamera {
  const cp = Math.cos(o.pitch);
  cam.position.set(o.target[0] + o.dist * cp * Math.sin(o.yaw), o.target[1] + o.dist * Math.sin(o.pitch), o.target[2] + o.dist * cp * Math.cos(o.yaw));
  cam.up.set(0, 1, 0);
  cam.lookAt(o.target[0], o.target[1], o.target[2]);
  setFov(cam, o.fov);
  return cam;
}

/** blends two orbits at u (0..1) into out (its target array is written in place): yaw the short way round */
export function mixOrbit(a: Orbit, b: Orbit, u: number, out: Orbit): Orbit {
  let dy = b.yaw - a.yaw;
  dy -= 2 * Math.PI * Math.round(dy / (2 * Math.PI));
  for (let k = 0; k < 3; k++) out.target[k] = a.target[k] + (b.target[k] - a.target[k]) * u;
  out.yaw = a.yaw + dy * u;
  out.pitch = a.pitch + (b.pitch - a.pitch) * u;
  // distance blends geometrically: a dolly from 4 m to 0.5 m feels even
  out.dist = a.dist * Math.pow(b.dist / a.dist, u);
  const fa = a.fov ?? b.fov, fb = b.fov ?? a.fov;
  out.fov = fa !== undefined && fb !== undefined ? fa + (fb - fa) * u : undefined;
  return out;
}

/** a camera at `eye` looking at `target` */
export function lookFrom(cam: THREE.PerspectiveCamera, eye: V3, target: V3, fov?: number): THREE.PerspectiveCamera {
  cam.position.set(eye[0], eye[1], eye[2]);
  cam.up.set(0, 1, 0);
  cam.lookAt(target[0], target[1], target[2]);
  setFov(cam, fov);
  return cam;
}

export interface PovOptions {
  /** move the camera this far towards the target, horizontally (m) */
  forward?: number;
  /** and this far down (m) */
  down?: number;
  /** vertical field of view (deg) */
  fov?: number;
}

/**
 * First-person camera: at the eyes, moved `forward` towards the look target and `down`, looking
 * at `look` (the hands). Leaves out SELF_LAYER, so the own head and torso do not block the view.
 */
export function povCamera(cam: THREE.PerspectiveCamera, eye: V3, look: V3, o: PovOptions = {}): THREE.PerspectiveCamera {
  let fx = look[0] - eye[0], fz = look[2] - eye[2];
  const l = Math.hypot(fx, fz) || 1;
  fx /= l;
  fz /= l;
  const f = o.forward ?? 0.08, d = o.down ?? 0.06;
  cam.position.set(eye[0] + fx * f, eye[1] - d, eye[2] + fz * f);
  cam.up.set(0, 1, 0);
  cam.lookAt(look[0], look[1], look[2]);
  setFov(cam, o.fov ?? 62);
  cam.layers.enableAll();
  cam.layers.disable(SELF_LAYER);
  return cam;
}

/**
 * The mean of p(t') over [t - half, t + half] (`samples` points, triangle weights), written into
 * out: a smooth, deterministic version of a moving point for a calm camera.
 */
export function smoothed(p: (t: number, out: V3) => V3, t: number, half: number, out: V3, samples = 9): V3 {
  const tmp = scratch;
  let x = 0, y = 0, z = 0, wsum = 0;
  for (let i = 0; i < samples; i++) {
    const u = samples > 1 ? (i / (samples - 1)) * 2 - 1 : 0;
    const w = 1 - Math.abs(u) * 0.9;
    p(t + u * half, tmp);
    x += tmp[0] * w;
    y += tmp[1] * w;
    z += tmp[2] * w;
    wsum += w;
  }
  out[0] = x / wsum;
  out[1] = y / wsum;
  out[2] = z / wsum;
  return out;
}

const scratch: V3 = [0, 0, 0];

function setFov(cam: THREE.PerspectiveCamera, fov: number | undefined) {
  if (fov !== undefined && cam.fov !== fov) {
    cam.fov = fov;
    cam.updateProjectionMatrix();
  }
}
