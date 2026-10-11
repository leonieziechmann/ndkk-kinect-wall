// Checks the rings of stage 1, items 3 and 4 (src/shots/deploy-pull.ts, src/shots/throw.ts):
// each ring, laid out over-under and pressed exactly as in its shot, is pulled apart by its ends
// in the air (deploy-ring.ts pullCheck); over-under must leave |Tw| < 0.3 turns. As a control the
// same ring wound the same way every time (all über) must leave about one turn per loop.
//   node tools/simtest/deploy-check.mjs [short|long|all]
// Output: output/simtest/deploy-check.summary.json

import { load, writeSummary, r4 } from './lib.mjs';

const which = process.argv[2] ?? 'all';
const { mods: [ring, pull, thr], close } = await load('/src/shots/deploy-ring.ts', '/src/shots/deploy-pull.ts', '/src/shots/throw.ts');
const cases = [];
if (which !== 'long') cases.push({ name: 'short (Ilse)', spec: pull.SHORT_RING, T: 4.6, substeps: 30 });
if (which !== 'short') cases.push({ name: 'long (Kofi)', spec: thr.LONG_RING, T: 12, substeps: 60 });
const out = [];
let ok = true;
for (const c of cases) {
  for (const sameWay of [false, true]) {
    const spec = sameWay ? { ...c.spec, pattern: 'o'.repeat(c.spec.pattern.length) } : c.spec;
    const t0 = Date.now();
    const coil = ring.ringCoil(spec);
    const res = ring.pullCheck(coil.state, { T: c.T, substeps: c.substeps });
    const lk = res.Tw + res.Wr;
    const pass = sameWay ? lk > 0.75 * spec.pattern.length : Math.abs(res.Tw) < 0.3;
    ok &&= pass;
    const row = { ring: c.name, pattern: spec.pattern, Tw: r4(res.Tw), Wr: r4(res.Wr), pass, seconds: r4((Date.now() - t0) / 1000) };
    out.push(row);
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${c.name.padEnd(13)} ${spec.pattern.padEnd(19)} pulled apart: Tw ${row.Tw.toFixed(2)}  Wr ${row.Wr.toFixed(2)}  (${row.seconds} s)`);
  }
}
writeSummary('deploy-check', out);
await close();
process.exit(ok ? 0 : 1);
