// How the bodies look on the stage: colors per material and person, and the light.
//   clay        the people as they are, before the Kinect has seen them (light from the wall's side)
//   silhouette  dark bodies against the lit wall, with a rim in the person's color

import { RGB, hexRgb } from '../math';
import type { Pose } from '../people';
import { C } from '../theme';
import type { Look } from './raster';
import type { BodyStyle } from './styles';

const norm3 = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** the light comes from above, from the wall's side (people face the wall) */
const LIGHT = norm3([-0.35, 0.8, -0.5]);

/** clothes per person: a muted version of the color the person gets later */
const CLOTHES: Record<number, { top: RGB; pants: RGB; hair: RGB; shoes: RGB }> = {
  1: { top: [0.26, 0.47, 0.55], pants: [0.17, 0.19, 0.25], hair: [0.2, 0.14, 0.1], shoes: [0.82, 0.82, 0.84] },
  2: { top: [0.55, 0.3, 0.48], pants: [0.2, 0.17, 0.22], hair: [0.5, 0.34, 0.2], shoes: [0.22, 0.18, 0.19] },
  3: { top: [0.66, 0.53, 0.3], pants: [0.21, 0.22, 0.2], hair: [0.12, 0.1, 0.09], shoes: [0.3, 0.23, 0.18] },
};
const SKIN: RGB = [0.8, 0.66, 0.57];
const WOOD: RGB = [0.8, 0.7, 0.57];
const WOOD_JOINT: RGB = [0.62, 0.52, 0.41];

/** colors per material (MAT order: skin, shirt, pants, shoes, hair, dress, wood, joint) */
function palette(p: Pose, style: BodyStyle): RGB[] {
  if (style === 'puppe') return [WOOD, WOOD, WOOD, WOOD, WOOD, WOOD, WOOD, WOOD_JOINT];
  const c = CLOTHES[p.slot] ?? CLOTHES[1];
  return [SKIN, c.top, c.pants, c.shoes, c.hair, c.top, WOOD, WOOD_JOINT];
}

export function clayLook(p: Pose, style: BodyStyle, opts: { colorK?: number; tint?: number } = {}): Look {
  const colorK = opts.colorK ?? 0;
  let mats = palette(p, style);
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
    mats: [dark, dark, dark, dark, dark, dark, dark, dark],
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
