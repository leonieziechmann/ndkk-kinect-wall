// Sound cues: the scenes mark the moments that make a sound, on the story clock. tools/render.mjs
// (mode "cues") runs through the whole video once and collects them; tools/sound.mjs turns them into
// the soundtrack (src/audio/soundtrack.m4a). Outside of that run a cue does nothing.

export interface Cue {
  /** story time (s) */
  t: number;
  name: string;
  /** length of the sound (s), if it has one */
  dur?: number;
  /** -1 left .. 1 right; with panTo the sound moves */
  pan?: number;
  panTo?: number;
  gain?: number;
  /** a number for the sound to vary on (an index, a count) */
  n?: number;
}

type Clock = () => number;

/** a sound at the scene's clock now plus `at` seconds */
export function cue(T: Clock, name: string, at = 0, opts: Omit<Cue, 't' | 'name'> = {}) {
  const g = globalThis as { __cues?: Cue[] };
  if (!g.__cues) return;
  g.__cues.push({ t: Math.round((T() + at) * 1000) / 1000, name, ...opts });
}
