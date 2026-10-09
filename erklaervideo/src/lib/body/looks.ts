// How the bodies look on the stage: colors per material and person, and the light.
//   clay        the people as they are, before the Kinect has seen them (light from the wall's side)
//   silhouette  dark bodies against the lit wall, with a rim in the person's color

import { RGB, hexRgb } from '../math';
import type { Pose } from '../people';
import { C } from '../theme';
import type { Look } from './raster';

const norm3 = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** the light comes from above, from the wall's side (people face the wall) */
const LIGHT = norm3([-0.35, 0.8, -0.5]);

/**
 * Per person (slot): skin, clothes, hair. The tops are a softer version of the color the person gets
 * in the tracking later (1 cyan, 2 magenta, 3 yellow): he wears pink, she wears turquoise.
 */
const PEOPLE: Record<number, { skin: RGB; top: RGB; pants: RGB; shoes: RGB; hair: RGB }> = {
  1: { skin: [0.74, 0.56, 0.44], top: [0.22, 0.58, 0.66], pants: [0.56, 0.64, 0.74], shoes: [0.9, 0.9, 0.9], hair: [0.18, 0.12, 0.09] },
  2: { skin: [0.85, 0.7, 0.6], top: [0.88, 0.44, 0.66], pants: [0.16, 0.18, 0.24], shoes: [0.82, 0.82, 0.84], hair: [0.36, 0.25, 0.16] },
  3: { skin: [0.45, 0.31, 0.24], top: [0.7, 0.55, 0.28], pants: [0.21, 0.22, 0.2], shoes: [0.3, 0.23, 0.18], hair: [0.08, 0.07, 0.07] },
};

/** colors per material (MAT order: skin, shirt, pants, shoes, hair) */
function palette(p: Pose): RGB[] {
  const c = PEOPLE[p.slot] ?? PEOPLE[2];
  return [c.skin, c.top, c.pants, c.shoes, c.hair];
}

export function clayLook(p: Pose, opts: { colorK?: number; tint?: number } = {}): Look {
  const colorK = opts.colorK ?? 0;
  let mats = palette(p);
  if (colorK > 0) mats = mats.map((m) => [m[0] + (p.color[0] - m[0]) * colorK, m[1] + (p.color[1] - m[1]) * colorK, m[2] + (p.color[2] - m[2]) * colorK]);
  return {
    mats,
    light: LIGHT,
    key: 0.78,
    ambient: 0.42,
    rim: [0.55, 0.68, 0.95],
    rimK: 0.32,
    tint: hexRgb(C.ir),
    tintK: (opts.tint ?? 0) * 0.65,
    alpha: 1,
  };
}

export function silhouetteLook(p: Pose): Look {
  const dark: RGB = [0.03, 0.035, 0.05];
  return {
    mats: [dark, dark, dark, dark, dark],
    light: LIGHT,
    key: 0.6,
    ambient: 0.8,
    rim: p.color,
    rimK: 1.1,
    tint: [0, 0, 0],
    tintK: 0,
    alpha: 1,
  };
}
