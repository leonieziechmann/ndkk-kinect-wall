// When each scene starts on the global story time (seconds). People (choreo.ts), the simulated
// Kinect and the fluid run on this clock, so cutting from one scene to the next is seamless.
//
// There are two cuts of the video: the full one (16:9, for the notebook next to the wall) and a short
// one for social media (9:16, src/social.ts): the same story, quicker, without the credits and the
// flag. A page renders one of them; src/lib/cut-social.ts switches to the short one before anything
// else is loaded.

/** which cut this page renders */
export const CUT: 'full' | 'social' = (globalThis as { __CUT?: string }).__CUT === 'social' ? 'social' : 'full';

/** the full cut: a moment of the NDKK first (in its first scene), the story, the credits, the flag */
const FULL = {
  aufbau: 0,
  sensor: 10,
  punktwolke: 18.5,
  flow: 27,
  ki: 32.5,
  masken: 42.5,
  daten: 50,
  wand: 62.5,
  abspann: 73.5,
  bunt: 82.5,
  ende: 91.5,
};

/**
 * The short cut starts with a moment of the NDKK (in its first scene) and ends with the wall and the
 * NDKK again (in the place of the credits); no flag.
 */
const SOCIAL: typeof FULL = {
  aufbau: 0,
  sensor: 7.2,
  punktwolke: 13.7,
  flow: 20.2,
  ki: 24.7,
  masken: 32.2,
  daten: 38.2,
  wand: 46.2,
  abspann: 53.7,
  bunt: 58.2,
  ende: 58.2,
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
export const FLUID_START = at('daten', CUT === 'social' ? 6.0 : 9.4);
