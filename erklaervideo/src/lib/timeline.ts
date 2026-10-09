// When each scene starts on the global story time (seconds). People (choreo.ts), the simulated
// Kinect and the fluid run on this clock, so cutting from one scene to the next is seamless.

export const SCENES = {
  aufbau: 0,
  sensor: 11,
  punktwolke: 23,
  flow: 34,
  ki: 40,
  masken: 52,
  daten: 61,
  wand: 73,
  ende: 85,
} as const;

export type SceneName = keyof typeof SCENES;

export function duration(name: Exclude<SceneName, 'ende'>) {
  const keys = Object.keys(SCENES) as SceneName[];
  const i = keys.indexOf(name);
  return SCENES[keys[i + 1]] - SCENES[name];
}

/** the fluid on the wall starts here (scene "daten") and runs on until the end */
export const FLUID_START = 69.5;
