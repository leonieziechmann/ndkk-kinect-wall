// Registry of the simulated shots: id → ShotDef. tools/bake.mjs bakes every entry into
// bakes/<id>.bin (npm run bake); scenes load them with loadBake(id). Register new shot modules in
// SHOT_LIST.

import { BakedRod, Rod, bake } from '../sim';
import type { ShotDef } from './types';
import { exampleTwist } from './example';
import { COIL_SHOTS } from './s1-coil';
import { knotPull } from './knot';
import { eightOk, eightReverse, eightRoll, eightSnap, eightSwivel } from './eight';
import { kinkShot } from './kink';
import { throwShot } from './throw';
import { deployPull } from './deploy-pull';
import { PHYS_SHOTS } from './phys-tests';
import { P3_SHOTS } from './p3-steps-twist';
import { WHY_SHOTS } from './p2-why';
import { P5_KNOTS_SHOTS } from './p5-knots';
import { P4_SHOTS } from './p4-strap';

const SHOT_LIST: ShotDef[] = [exampleTwist, ...COIL_SHOTS, knotPull, eightSnap, eightOk, eightRoll, eightSwivel, eightReverse, kinkShot, throwShot, deployPull, ...PHYS_SHOTS, ...P3_SHOTS, ...WHY_SHOTS, ...P5_KNOTS_SHOTS, ...P4_SHOTS];

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
  const { rod, script, tracks, vectors } = def.build();
  if (def.iterations !== undefined) rod.opts.iterations = def.iterations;
  return bake(rod, { id: def.id, duration: def.duration, fps: def.fps, substeps: def.substeps, script, tracks, vectors, onFrame });
}
