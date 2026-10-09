// Camera poses of the 3D stage and helpers to cut or move between them. A scene ends on the pose the
// next one starts with, so the cut between scenes is invisible.

import { View2D } from '@motion-canvas/2d';
import { TimingFunction, createSignal, easeInOutCubic, linear, useTime, waitFor } from '@motion-canvas/core';
import type { Stage } from '../nodes/Stage';
import { fontsReady } from './fonts';
import { WALL_P } from './portrait';
import { C } from './theme';
import { WALL } from './world';

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
  /** scene 2 drifts on to this, scene 3 starts here */
  sidePanels2: shot({ yaw: 50, pitch: 15, dist: 9.0, tx: 0, ty: 1.1, tz: 2.6, shiftX: -330 }),
  /**
   * scenes 3–7: the point cloud seen roughly from the Kinect: from behind the sensor (the wall is
   * hidden then), a bit above and to the side, looking at the people; only small swings, enough to
   * see that it is 3D
   */
  kinectA: shot({ yaw: 200, pitch: 17, dist: 4.4, tx: 0.15, ty: 1.0, tz: 3.0, fov: 46 }),
  kinectB: shot({ yaw: 162, pitch: 13, dist: 4.5, tx: 0.1, ty: 1.0, tz: 3.0, fov: 46 }),
  /** scene 4: a bit closer */
  kinectC: shot({ yaw: 186, pitch: 11, dist: 3.9, tx: 0.15, ty: 1.1, tz: 2.8, fov: 46 }),
  kinectC2: shot({ yaw: 176, pitch: 9, dist: 3.7, tx: 0.15, ty: 1.1, tz: 2.8, fov: 46 }),
  /** scene 5: where the skeletons lift out of the picture, then a slow swing */
  kinectK: shot({ yaw: 180, pitch: 6, dist: 3.7, tx: 0.15, ty: 1.0, tz: 2.75, fov: 48 }),
  kinectD: shot({ yaw: 203, pitch: 15, dist: 4.4, tx: 0.1, ty: 1.0, tz: 2.95, fov: 46 }),
  /** scene 6: 3D left, the mask picture right */
  kinectMask: shot({ yaw: 195, pitch: 14, dist: 4.7, tx: 0.1, ty: 1.0, tz: 2.95, fov: 48, shiftX: -330 }),
  kinectMaskEnd: shot({ yaw: 167, pitch: 12, dist: 4.6, tx: 0.1, ty: 1.0, tz: 2.95, fov: 48, shiftX: -330 }),
  /** scene 8: from behind the audience, straight at the wall (the wall stays a flat rectangle) */
  wallClose: shot({ yaw: 0, pitch: 0, dist: 7.06, tx: 0, ty: 1.6, tz: 0, fov: 34, shiftY: -60 }),
  wallWide: shot({ yaw: 0, pitch: 0, dist: 11.2, tx: 0, ty: 1.6, tz: 0, fov: 34, shiftY: 10 }),
  wallWideEnd: shot({ yaw: 0, pitch: 0, dist: 10.6, tx: 0.25, ty: 1.6, tz: 0, fov: 34, shiftY: 10 }),
  /** the picture-in-picture: the Kinect's view from the side */
  pip: shot({ yaw: 176, pitch: 10, dist: 4.4, tx: 0.1, ty: 1.0, tz: 2.9, fov: 50 }),
};

/**
 * The same story in portrait (the short cut for social media, 1080 × 1920): the camera's field of
 * view is vertical, so the picture is as tall as before but much narrower; the shots step back or
 * turn so that what matters fits the width, and leave room for the text at the top and the
 * pictures of the Kinect below.
 */
export const SOCIAL_SHOTS = {
  roomStart: shot({ yaw: 42, pitch: 26, dist: 15, tx: 0, ty: 1.5, tz: 0, fov: 50, shiftX: -60, shiftY: 90 }),
  roomEnd: shot({ yaw: 32, pitch: 15, dist: 13.0, tx: 0, ty: 1.55, tz: 0, fov: 50, shiftX: -80, shiftY: 70 }),
  sidePanels: shot({ yaw: 58, pitch: 17, dist: 12.5, tx: 0, ty: 1.1, tz: 2.5, fov: 56, shiftX: -130, shiftY: -160 }),
  sidePanels2: shot({ yaw: 50, pitch: 15, dist: 11.8, tx: 0, ty: 1.1, tz: 2.6, fov: 56, shiftX: -140, shiftY: -160 }),
  kinectA: shot({ yaw: 200, pitch: 17, dist: 5.6, tx: 0.15, ty: 1.0, tz: 3.0, fov: 56, shiftY: 40 }),
  kinectB: shot({ yaw: 166, pitch: 13, dist: 5.7, tx: 0.1, ty: 1.0, tz: 3.0, fov: 56, shiftY: 40 }),
  kinectC: shot({ yaw: 186, pitch: 11, dist: 5.0, tx: 0.15, ty: 1.1, tz: 2.8, fov: 56, shiftY: 40 }),
  kinectC2: shot({ yaw: 177, pitch: 9, dist: 4.8, tx: 0.15, ty: 1.1, tz: 2.8, fov: 56, shiftY: 40 }),
  kinectK: shot({ yaw: 180, pitch: 6, dist: 4.8, tx: 0.15, ty: 1.0, tz: 2.75, fov: 56, shiftY: 40 }),
  kinectD: shot({ yaw: 200, pitch: 15, dist: 5.6, tx: 0.1, ty: 1.0, tz: 2.95, fov: 56, shiftY: 40 }),
  kinectMask: shot({ yaw: 194, pitch: 14, dist: 8.2, tx: 0.1, ty: 1.0, tz: 2.95, fov: 56, shiftY: -250 }),
  kinectMaskEnd: shot({ yaw: 168, pitch: 12, dist: 8.0, tx: 0.1, ty: 1.0, tz: 2.95, fov: 56, shiftY: -250 }),
  /** the wall as a flat rectangle where the wall picture of scene 7 ends (WALL_P) */
  wallClose: shot({ yaw: 0, pitch: 0, dist: (WALL.w * (960 / Math.tan((70 * Math.PI) / 360))) / WALL_P.w, tx: 0, ty: WALL.bottom + WALL.h / 2, tz: 0, fov: 70, shiftY: WALL_P.y }),
  wallWide: shot({ yaw: 0, pitch: 8, dist: 8.8, tx: 0, ty: 1.3, tz: 0.6, fov: 66, shiftY: -140 }),
  wallWideEnd: shot({ yaw: -3, pitch: 9, dist: 8.6, tx: -0.15, ty: 1.3, tz: 0.6, fov: 66, shiftY: -140 }),
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
