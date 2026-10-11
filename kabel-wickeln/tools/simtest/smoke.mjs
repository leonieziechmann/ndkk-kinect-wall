// Smoke test: every registered shot builds and runs 0.5 s without NaN, and every cable preset
// hangs from a pinch for 1 s without NaN, capped speeds or warnings.
//   node tools/simtest/smoke.mjs

import { load } from './lib.mjs';

const { mods: [sim, shots], close } = await load('/src/sim/index.ts', '/src/shots/index.ts');
let fails = 0;
const finite = (rod) => rod.x.every((v) => Number.isFinite(v));
for (const [id, def] of Object.entries(shots.SHOTS)) {
  try {
    const { rod, script } = def.build();
    const t0 = performance.now();
    for (let f = 0; f <= 30; f++) {
      script?.(rod, rod.time);
      if (f > 0) rod.step(1 / (def.fps ?? 60), def.substeps ?? 30); else rod.sync();
    }
    const ok = finite(rod);
    if (!ok) fails++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} shot ${id}: nodes ${rod.n}, 0.5 s in ${((performance.now() - t0) / 1000).toFixed(1)} s${ok ? '' : ' (NaN)'}`);
  } catch (e) {
    fails++;
    console.log(`FAIL shot ${id}: ${e.message}`);
  }
}
for (const [name, spec] of Object.entries(sim.CABLES)) {
  const pts = Array.from({ length: 101 }, (_, i) => [0, 1.6 - i * 0.015, 0]);
  const { rod } = sim.buildCable(spec, pts, { plugs: 'end' });
  // held 2 cm from its top end; the hand moves 20 cm sideways in 0.4 s
  const top = rod.pointAt(0.02);
  const hand = (t) => sim.gripFrame([top[0] + 0.2 * Math.min(1, Math.max(0, t - 0.3) / 0.4), top[1], top[2]], [0, -1, 0], [1, 0, 0]);
  rod.pinch({ frame: hand, s: 0.02, blend: 0.01 });
  for (let f = 0; f < 60; f++) rod.step(1 / 60, spec.substeps);
  const ok = finite(rod) && rod.stats.speedCapped === 0 && rod.warnings.length === 0;
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} preset ${name}: nodes ${rod.n}, gap ${(rod.maxJointGap() * 1000).toFixed(3)} mm, capped ${rod.stats.speedCapped}, warnings ${rod.warnings.length}`);
}
await close();
process.exitCode = fails ? 1 : 0;
