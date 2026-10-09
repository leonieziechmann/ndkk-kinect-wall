// Camera poses of the 3D stage and helpers to cut or move between them. A scene ends on the pose the
// next one starts with, so the cut between scenes is invisible.

import { View2D } from '@motion-canvas/2d';
import { TimingFunction, createSignal, easeInOutCubic, linear, useTime, waitFor } from '@motion-canvas/core';
import type { Stage } from '../nodes/Stage';
import { fontsReady } from './fonts';
import { C } from './theme';

export interface Shot {
  yaw: number;
  pitch: number;
  dist: number;
  tx: number;
  ty: number;
  tz: number;
  fov: number;
  shiftX: number;
  shiftY: number;
}

const shot = (s: Partial<Shot>): Shot => ({ yaw: 0, pitch: 0, dist: 10, tx: 0, ty: 1.2, tz: 1.5, fov: 38, shiftX: 0, shiftY: 0, ...s });

export const SHOTS = {
  /** scene 1: the empty room from the front, high */
  roomStart: shot({ yaw: 34, pitch: 24, dist: 13, tx: 0, ty: 1.2, tz: 0.9 }),
  roomEnd: shot({ yaw: 22, pitch: 13, dist: 9.4, tx: 0, ty: 1.35, tz: 0.55 }),
  /** scene 2: from the side, the field of view reaches into the room */
  side: shot({ yaw: 58, pitch: 17, dist: 9.6, tx: 0, ty: 1.1, tz: 2.5 }),
  sidePanels: shot({ yaw: 58, pitch: 17, dist: 9.6, tx: 0, ty: 1.1, tz: 2.5, shiftX: -330 }),
  /** scene 3: around the point cloud */
  orbitA: shot({ yaw: 150, pitch: 10, dist: 8.2, tx: 0, ty: 1.05, tz: 2.8 }),
  orbitB: shot({ yaw: 208, pitch: 14, dist: 7.4, tx: 0.1, ty: 1.05, tz: 2.8 }),
  /** scene 4: close to the people, from the front */
  front: shot({ yaw: 188, pitch: 7, dist: 5.8, tx: 0.15, ty: 1.2, tz: 2.6 }),
  /** scene 5: skeletons in 3D, from the Kinect's side (behind the wall, which is see-through then) */
  lift: shot({ yaw: 176, pitch: 5, dist: 5.4, tx: 0.15, ty: 1.05, tz: 2.6 }),
  liftSide: shot({ yaw: 128, pitch: 14, dist: 7.0, tx: 0.1, ty: 1.0, tz: 2.7 }),
  /** scene 6: masks, 3D left */
  masks: shot({ yaw: 140, pitch: 15, dist: 8.0, tx: 0.1, ty: 1.0, tz: 2.8, shiftX: -330 }),
  masksEnd: shot({ yaw: 162, pitch: 11, dist: 7.4, tx: 0.1, ty: 1.05, tz: 2.8, shiftX: -330 }),
  /** scene 8: from behind the audience, straight at the wall (the wall stays a flat rectangle) */
  wallClose: shot({ yaw: 0, pitch: 0, dist: 7.06, tx: 0, ty: 1.6, tz: 0, fov: 34, shiftY: -60 }),
  wallWide: shot({ yaw: 0, pitch: 0, dist: 11.2, tx: 0, ty: 1.6, tz: 0, fov: 34, shiftY: 10 }),
  wallWideEnd: shot({ yaw: 0, pitch: 0, dist: 10.6, tx: 0.25, ty: 1.6, tz: 0, fov: 34, shiftY: 10 }),
  /** the picture-in-picture: the Kinect's view from the side */
  pip: shot({ yaw: 166, pitch: 8, dist: 4.4, tx: 0.1, ty: 1.0, tz: 2.8, fov: 50 }),
};

export function setShot(st: Stage, s: Shot) {
  st.yaw(s.yaw);
  st.pitch(s.pitch);
  st.dist(s.dist);
  st.tx(s.tx);
  st.ty(s.ty);
  st.tz(s.tz);
  st.fov(s.fov);
  st.shiftX(s.shiftX);
  st.shiftY(s.shiftY);
}

/** all camera values at once */
export function moveTo(st: Stage, s: Shot, duration: number, ease: TimingFunction = easeInOutCubic) {
  return [
    st.yaw(s.yaw, duration, ease),
    st.pitch(s.pitch, duration, ease),
    st.dist(s.dist, duration, ease),
    st.tx(s.tx, duration, ease),
    st.ty(s.ty, duration, ease),
    st.tz(s.tz, duration, ease),
    st.fov(s.fov, duration, ease),
    st.shiftX(s.shiftX, duration, ease),
    st.shiftY(s.shiftY, duration, ease),
  ];
}

/** every scene starts like this: background, fonts, and the story clock from `start` */
export function* begin(view: View2D, start: number) {
  view.fill(C.bg);
  yield fontsReady();
  const clock = createSignal(start);
  // runs in the background until the scene ends
  yield clock(start + 600, 600, linear);
  return clock;
}

/** wait until the scene's own clock reaches t seconds */
export function* until(t: number) {
  const now = useTime();
  if (t > now + 1e-6) yield* waitFor(t - now);
  else if (now > t + 1e-3) console.error(`[render] scene runs ${(now - t).toFixed(2)} s longer than planned (${t} s)`);
}
