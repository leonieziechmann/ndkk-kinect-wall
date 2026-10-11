// Stage 1: Noor coils the 5 m XLR over and under into her left hand (coil-engine.ts drives her arms
// and the simulated cable together; the technique is described in coiling.ts). The first two loops
// slowly for teaching (über, unter), then four at her natural pace; afterwards the coil hangs
// still in her left hand for the strap.
//
// The bake prints its checks at the end (over/under, roundness, loop lengths, the pull-apart
// twist, hands, IK) and fails loudly in the summary: "COIL CHECKS FAILED".
//
// coil-dev is the first two loops only, for quick experiments (npm run bake -- --jobs 1 coil-dev).

import { XLR } from '../sim';
import { CoilController } from './coil-engine';
import { CoilPlan, LoopKind, NATURAL, TEACH } from './coiling';
import type { ShotDef } from './types';

const KINDS: LoopKind[] = ['over', 'under', 'over', 'under', 'over', 'under'];

/** stage 1: two slow loops, four at the natural pace */
export const COIL1: CoilPlan = {
  kinds: KINDS,
  paces: KINDS.map((_, i) => (i < 2 ? TEACH : NATURAL)),
  start: 0.6,
  loopLength: 0.74,
};

/** how long the coil hangs still after the last loop (the strap closes in the scene) */
export const COIL1_TAIL = 2.6;

function coilShotOf(id: string, plan: CoilPlan, tail: number): ShotDef & { controller: () => CoilController | null } {
  let last: CoilController | null = null;
  const probe = new CoilController(plan);
  const duration = probe.tDone + tail;
  return {
    id,
    duration,
    substeps: XLR.substeps,
    iterations: XLR.iterations,
    controller: () => last,
    build() {
      const ctl = (last = new CoilController(plan));
      const b = ctl.build();
      let printed = false;
      return {
        ...b,
        script: (rod, t) => {
          b.script?.(rod, t);
          if (!printed && t >= duration - 1.5 / 60) {
            printed = true;
            const s = ctl.summary();
            console.log(`\n[${id}] coil checks`);
            for (const l of s.lines) console.log(`  ${l}`);
            console.log(s.ok ? `[${id}] all coil checks passed` : `[${id}] COIL CHECKS FAILED`);
          }
        },
      };
    },
  };
}

export const coilShot = coilShotOf('s1-coil', COIL1, COIL1_TAIL);

/** the first two loops of stage 1, for experiments */
export const coilDev = coilShotOf('coil-dev', { ...COIL1, kinds: KINDS.slice(0, 2), paces: [TEACH, TEACH] }, 1.2);

export const COIL_SHOTS: ShotDef[] = [coilShot, coilDev];
