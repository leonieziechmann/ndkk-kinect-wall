// Checks stage 1, items 3 and 4 (laying a coil out again: src/shots/deploy-pull.ts, src/shots/throw.ts).
//
//   rings  each ring, laid out over-under and pressed exactly as in its shot (deploy-ring.ts
//          windRing), must have alternating crossings (> 0 über, < 0 unter, read from the stack), and
//          pulled apart by its ends in the air (pullApart) it must leave |Tw| < 0.3 turns, with no
//          strand passing through another on the way (Tw + Wr, the linking number of the pull,
//          never jumps by about 2). Control: the same ring wound the same way every time (all über)
//          must leave about one turn per loop, so the check can tell the two apart.
//   bakes  the baked shots (bakes/deploy-pull.bin, bakes/throw.bin): no capped speeds, no warnings,
//          the cable at the end without twist or writhe worth a curl, and for the throw the cable
//          on the floor without a single self-crossing of its floor plan (a curl or a knot always
//          has one) and no bend tighter than 3 cm.
//
//   node tools/simtest/deploy-check.mjs [rings|bakes|all] [short|long|both]
// Output: output/simtest/deploy-check.summary.json

import fs from 'node:fs';
import path from 'node:path';
import { load, writeSummary, r4 } from './lib.mjs';

const what = process.argv[2] ?? 'all';
const which = process.argv[3] ?? 'both';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const { mods: [sim, ring, pull, thr], close } = await load('/src/sim/index.ts', '/src/shots/deploy-ring.ts', '/src/shots/deploy-pull.ts', '/src/shots/throw.ts');
const out = { rings: [], bakes: [] };
let ok = true;
const say = (pass, text) => console.log(`${pass ? 'ok  ' : 'FAIL'} ${text}`);

if (what !== 'bakes') {
  const cases = [];
  if (which !== 'long') cases.push({ name: 'short (Ilse)', spec: pull.SHORT_RING, T: 4.6, substeps: 30 });
  if (which !== 'short') cases.push({ name: 'long (Kofi)', spec: thr.LONG_RING, T: 9, substeps: 30 });
  for (const c of cases) {
    for (const sameWay of [false, true]) {
      const spec = sameWay ? { ...c.spec, pattern: 'o'.repeat(c.spec.pattern.length) } : c.spec;
      const t0 = Date.now();
      const r = ring.windRing(spec);
      const rod0 = ring.ringRod(r, r.state, spec);
      const cr = ring.crossings(rod0, r);
      // (each value is a vote over the loop's nodes: its sign says on which side the following cable passes)
      const alternate = cr.every((v, k) => (sameWay ? v > 0 : k % 2 === 0 ? v > 0 : v < 0));
      let lk0 = null, jump = 0;
      const res = ring.pullApart(r, spec, {
        T: c.T, substeps: c.substeps, onFrame: (rod, t) => {
          if (Math.round(t * 60) % 6) return;
          const lk = rod.twistTurns() + rod.writhe();
          if (lk0 !== null) jump = Math.max(jump, Math.abs(lk - lk0));
          lk0 = lk;
        },
      });
      const pass = sameWay ? res.Tw > 0.75 * spec.pattern.length : Math.abs(res.Tw) < 0.3 && alternate && jump < 1;
      ok &&= pass;
      const row = { ring: c.name, pattern: spec.pattern, crossings: cr.map(r4), alternate, Tw: r4(res.Tw), Wr: r4(res.Wr), maxLinkJump: r4(jump), capped: res.capped, warnings: res.warnings, pass, seconds: r4((Date.now() - t0) / 1000) };
      out.rings.push(row);
      say(pass, `${c.name.padEnd(13)} ${spec.pattern.padEnd(17)} crossings ${row.crossings.join(' ')}  pulled apart: Tw ${row.Tw.toFixed(2)}  Wr ${row.Wr.toFixed(2)}  link jump ${row.maxLinkJump}  (${row.seconds} s)`);
    }
  }
}

if (what !== 'rings') {
  const bakes = [
    { id: 'deploy-pull', end: pull.PULL_T.end, throwShot: false },
    { id: 'throw', end: thr.THROW_T.end, throwShot: true },
  ];
  for (const b of bakes) {
    const file = path.join(ROOT, 'bakes', `${b.id}.bin`);
    if (!fs.existsSync(file)) {
      say(false, `${b.id}: no bake`);
      ok = false;
      continue;
    }
    const buf = fs.readFileSync(file);
    const baked = sim.BakedRod.fromBinary(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    // what the simulation reported about itself during the bake (tools/bake.mjs writes it next to the bin)
    const meta = fs.existsSync(file.replace(/\.bin$/, '.json')) ? JSON.parse(fs.readFileSync(file.replace(/\.bin$/, '.json'), 'utf8')) : {};
    const st = { speedCapped: meta.speedCapped, heldSlip: meta.heldSlip, warnings: meta.warnings, maxJointGap_mm: meta.maxJointGap_mm };
    const t = Math.min(b.end, baked.duration ?? b.end);
    const tw = baked.track('twist', t), wr = baked.track('writhe', t);
    const row = { id: b.id, speedCapped: st.speedCapped, heldSlip: st.heldSlip, warnings: st.warnings, maxJointGap_mm: st.maxJointGap_mm, twist: r4(tw), writhe: r4(wr) };
    let pass = (st.speedCapped ?? 0) === 0 && !(st.warnings?.length);
    if (b.throwShot) {
      row.curls = baked.track('curls', t);
      row.minBend = r4(baked.track('minBend', t));
      pass &&= row.curls === 0 && row.minBend > 0.03;
    } else pass &&= Math.abs(tw) < 0.3 && Math.abs(wr) < 0.3;
    row.pass = pass;
    ok &&= pass;
    out.bakes.push(row);
    say(pass, `${b.id.padEnd(12)} capped ${row.speedCapped}  held slips ${row.heldSlip}  warnings ${row.warnings?.length ?? '?'}  end: twist ${row.twist}  writhe ${row.writhe}${b.throwShot ? `  floor curls ${row.curls}  tightest bend ${row.minBend} m` : ''}`);
  }
}

writeSummary('deploy-check', out);
await close();
process.exit(ok ? 0 : 1);
