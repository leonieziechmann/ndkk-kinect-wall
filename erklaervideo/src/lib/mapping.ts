// How people land on the wall (web/WALL.md, "The mapping"): mirrored (everyone on their own side),
// the body in real size, only the position stretched so the Kinect's view at the reference distance
// spans the whole wall (mode `fit`, 3 m). Wall coordinates here: x in m from the wall's middle,
// y = height above the floor.

import { V3, clamp } from './math';
import type { Pose } from './people';
import { INTR, KINECT, WALL } from './world';

export const REF_DISTANCE = 3;
const TAN_H = INTR.cx / INTR.f;
/** stretch of the walk: half the wall / half the view at the reference distance */
export const STRETCH = WALL.w / 2 / (TAN_H * REF_DISTANCE);
const MARGIN = 0.3;

/** where the person's body center lands on the wall (x from the wall's middle) */
export function wallCenter(p: Pose) {
  const c = p.center[0] - KINECT[0];
  return clamp(c * STRETCH, -WALL.w / 2 + MARGIN, WALL.w / 2 - MARGIN);
}

/** a point of this person's body → the wall: [x, y] */
export function mapToWall(p: Pose, pt: V3): [number, number] {
  return [wallCenter(p) + (pt[0] - p.center[0]), pt[1]];
}

/** is the person inside the Kinect's view (and so tracked)? */
export function inView(p: Pose) {
  const d = p.center[2] - KINECT[2];
  if (d < INTR.near || d > INTR.far) return false;
  return Math.abs(p.center[0] - KINECT[0]) < TAN_H * d - 0.15;
}

export function tracked(list: Pose[]) {
  return list.filter(inView);
}
