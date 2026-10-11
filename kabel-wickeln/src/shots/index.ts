// Registry of the simulated shots: id → ShotDef. tools/bake.mjs bakes every entry into
// bakes/<id>.bin (npm run bake); scenes load them with loadBake(id). Register new shot modules in
// SHOT_LIST.

import { BakedRod, Rod, bake } from '../sim';
import type { ShotDef } from './types';
import { exampleTwist } from './example';

const SHOT_LIST: ShotDef[] = [exampleTwist];

export const SHOTS: Readonly<Record<string, ShotDef>> = (() => {
  const out: Record<string, ShotDef> = {};
  for (const s of SHOT_LIST) {
    if (out[s.id]) throw new Error(`two shots with the id "${s.id}"`);
    out[s.id] = s;
  }
  return out;
})();

/** Builds and bakes one shot (tools/bake.mjs and the simulation tests). */
export function bakeShot(def: ShotDef, onFrame?: (rod: Rod, t: number, frame: number) => void): BakedRod {
  const { rod, script, tracks } = def.build();
  if (def.iterations !== undefined) rod.opts.iterations = def.iterations;
  return bake(rod, { id: def.id, duration: def.duration, fps: def.fps, substeps: def.substeps, script, tracks, onFrame });
}
