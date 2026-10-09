// When each scene starts on the global story time (seconds). People (choreo.ts), the simulated
// Kinect and the fluid run on this clock, so cutting from one scene to the next is seamless.

export const SCENES = {
  aufbau: 0,
  sensor: 11,
  punktwolke: 20.5,
  flow: 30.5,
  ki: 36.5,
  masken: 48,
  daten: 56.5,
  wand: 68,
  abspann: 80,
  ende: 90,
} as const;

export type SceneName = keyof typeof SCENES;

export function duration(name: Exclude<SceneName, 'ende'>) {
  const keys = Object.keys(SCENES) as SceneName[];
  const i = keys.indexOf(name);
  return SCENES[keys[i + 1]] - SCENES[name];
}

/** a moment inside a scene: its start plus t seconds */
export const at = (name: SceneName, t: number) => SCENES[name] + t;

/** the fluid on the wall starts here (scene "daten") and runs on until the end */
export const FLUID_START = at('daten', 8.0);
