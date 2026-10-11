// The contract between a shot module (choreography and rod setup), tools/bake.mjs and the scenes.
// Shot modules import only src/sim and src/people (pure TypeScript), never three.js or Motion
// Canvas, so they load in Node for baking.

import type { Rod, VectorTrack } from '../sim';

/** A per-frame scalar recorded into the bake (e.g. twist turns for a live counter). */
export type Track = (rod: Rod, t: number) => number;

export interface ShotBuild {
  rod: Rod;
  /** called before each recorded frame with the shot time: add and release grips, guides, … */
  script?: (rod: Rod, t: number) => void;
  tracks?: Record<string, Track>;
  /** per-frame vectors recorded with the rod (hand frames, capsules: frameTrack, capsuleTrack) */
  vectors?: Record<string, VectorTrack>;
}

export interface ShotDef {
  /** also the bake file name: bakes/<id>.bin */
  id: string;
  /** seconds */
  duration: number;
  /** bake rate (default 60) */
  fps?: number;
  /** substeps per frame (default 30) */
  substeps?: number;
  /** solver iterations per substep (default: the rod's, 2) */
  iterations?: number;
  /** builds a fresh rod at shot time 0; must be deterministic */
  build(): ShotBuild;
}
