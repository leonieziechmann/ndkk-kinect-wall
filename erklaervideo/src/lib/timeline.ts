// When each scene starts on the global story time (seconds). People (choreo.ts), the simulated
// Kinect and the fluid run on this clock, so cutting from one scene to the next is seamless.
//
// There are two cuts of the video: the full one (16:9, for the notebook next to the wall) and a short
// one for social media (9:16, src/social.ts): the same story, quicker, without the credits and the
// flag. A page renders one of them; src/lib/cut-social.ts switches to the short one before anything
// else is loaded.

/** which cut this page renders */
export const CUT: 'full' | 'social' = (globalThis as { __CUT?: string }).__CUT === 'social' ? 'social' : 'full';

/**
 * The full cut: a moment of the NDKK first (in its first scene), the story, the credits, the flag, and
 * the NDKK again, on which it loops. Its length is a multiple of 16 frames (8/15 s): that is 25 600
 * samples of sound at 48 kHz, exactly 25 blocks of the AAC encoder, so the sound in the MP4 ends
 * without filling up its last block with silence, and the loop has no gap (tools/sound.mjs checks it).
 */
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
  bunt: 82.2,
  ende: 91.2,
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

/**
 * The full cut loops: it ends on its first picture. This is the story clock run on across its end and
 * its start without a jump: just before the end it is a little below 0. What stands on the screen
 * around that moment moves with it.
 */
export const loopTime = (t: number) => (t > SCENES.ende / 2 ? t - SCENES.ende : t);
