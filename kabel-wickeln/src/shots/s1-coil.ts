// Stage 1: Noor coils the 5 m XLR over and under into her left hand (coil-engine.ts drives her arms
// and the simulated cable together; the technique is described in coiling.ts). The first two loops
// slowly for teaching (über, unter), then four at her natural pace; afterwards the coil hangs
// still in her left hand, the cable's end in her right, for the strap.
//
// The bake prints its checks at the end (over/under, roundness, loop lengths, the forearm through
// the under loops, hands, kinks, speeds, the plug, IK) and fails loudly in the summary: "COIL
// CHECKS FAILED".
//
// coil-dev is the first two loops only (über, unter), coil-dev-oo the same twice über (the twist
// comparison), coil-dev1 one über loop: quick experiments (npm run bake -- --jobs 1 coil-dev).

import { XLR } from '../sim';
import { CoilController } from './coil-engine';
import { CoilPlan, LoopKind, NATURAL, TEACH } from './coiling';
import type { ShotDef } from './types';

const KINDS: LoopKind[] = ['over', 'under', 'over', 'under', 'over', 'under'];

/** stage 1: two slow loops, four at the natural pace; 5 m in six loops leaves ~18 cm and the plug in the right hand */
export const COIL1: CoilPlan = {
  kinds: KINDS,
  paces: KINDS.map((_, i) => (i < 2 ? TEACH : NATURAL)),
  start: 0.6,
  loopLength: 0.77,
};

/** how long the coil hangs still after the last loop (the strap closes in the scene) */
export const COIL1_TAIL = 3.2;

/** the controller of the last bake of each shot in this process (for test scripts) */
export const lastController = new Map<string, CoilController>();

function coilShotOf(id: string, plan: CoilPlan, tail: number): ShotDef {
  const probe = new CoilController(plan);
  const duration = probe.tDone + tail;
  return {
    id,
    duration,
    substeps: XLR.substeps,
    iterations: XLR.iterations,
    build() {
      const ctl = new CoilController(plan);
      lastController.set(id, ctl);
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

/** two loops the same way (over, over): the comparison for the twist checks */
export const coilDevSame = coilShotOf('coil-dev-oo', { ...COIL1, kinds: ['over', 'over'], paces: [TEACH, TEACH] }, 1.2);

/** one over loop, for quick experiments */
export const coilDev1 = coilShotOf('coil-dev1', { ...COIL1, kinds: ['over'], paces: [TEACH] }, 1.0);

export const COIL_SHOTS: ShotDef[] = [coilShot, coilDev, coilDevSame, coilDev1];
