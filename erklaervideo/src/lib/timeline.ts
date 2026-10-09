// When each scene starts on the global story time (seconds). People (choreo.ts), the simulated
// Kinect and the fluid run on this clock, so cutting from one scene to the next is seamless.
//
// There are two cuts of the video: the full one (16:9, for the notebook next to the wall) and a short
// one for social media (9:16, src/social.ts): the same story, quicker, without the credits and the
// flag. A page renders one of them; src/lib/cut-social.ts switches to the short one before anything
// else is loaded.

/** which cut this page renders */
export const CUT: 'full' | 'social' = (globalThis as { __CUT?: string }).__CUT === 'social' ? 'social' : 'full';

const FULL = {
  aufbau: 0,
  sensor: 11,
  punktwolke: 20.5,
  flow: 30.5,
  ki: 36.5,
  masken: 48,
  daten: 56.5,
  wand: 68,
  abspann: 80,
  bunt: 90,
  ende: 99,
};

/** the short cut ends with the wall: no credits, no flag (their scenes take no time) */
const SOCIAL: typeof FULL = {
  aufbau: 0,
  sensor: 6,
  punktwolke: 12.5,
  flow: 19,
  ki: 23.5,
  masken: 31,
  daten: 37,
  wand: 45,
  abspann: 52.5,
  bunt: 52.5,
  ende: 52.5,
};

export const SCENES: Readonly<typeof FULL> = CUT === 'social' ? SOCIAL : FULL;

export type SceneName = keyof typeof FULL;

export function duration(name: Exclude<SceneName, 'ende'>) {
  const keys = Object.keys(SCENES) as SceneName[];
  const i = keys.indexOf(name);
  return SCENES[keys[i + 1]] - SCENES[name];
}

/** a moment inside a scene: its start plus t seconds */
export const at = (name: SceneName, t: number) => SCENES[name] + t;

/** the fluid on the wall starts here (scene "daten") and runs on until the end */
export const FLUID_START = at('daten', CUT === 'social' ? 6.0 : 8.0);
