// De-risking stage 5.2: the twisted loop that flips into a figure eight (src/shots/eight.ts).
//   node tools/simtest/derisk-eight.mjs [snap,ok,roll,swivel]
// Bakes the clips, logs loop twist / writhe / out-of-plane per frame, renders pictures.
// Output: output/derisk/eight/*.png, *.summary.json

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, load, snap, render, r4 } from './lib.mjs';

const OUT = path.join(ROOT, 'output/derisk/eight');
fs.mkdirSync(OUT, { recursive: true });
const { mods: [sim, eight], close } = await load('/src/sim/index.ts', '/src/shots/eight.ts');
const which = (process.argv[2] ?? 'snap,ok,roll,swivel').split(',');
const DEFS = { snap: eight.eightSnap, ok: eight.eightOk, roll: eight.eightRoll, swivel: eight.eightSwivel };
const TIMES = {
  snap: [0, 0.8, 0.95, 1.1, 1.4, 2.0, 3.1, 3.6, 3.75, 3.9, 5],
  ok: [0, 0.8, 1.2, 2.5],
  roll: [0, 0.6, 1.2, 1.8, 2.4, 3.0, 4.0],
  swivel: [0, 0.5, 1, 1.5, 2.5, 3.5, 5],
};
const H = 1.0;
for (const k of which) {
  const def = DEFS[k];
  const t0 = Date.now();
  const { rod, script, tracks } = def.build();
  const tb = (Date.now() - t0) / 1000;
  const snaps = [], log = [];
  const times = TIMES[k];
  const b = sim.bake(rod, {
    duration: def.duration, fps: def.fps, substeps: def.substeps, script, tracks,
    onFrame: (r, t, f) => {
      const tr = Object.fromEntries(Object.entries(tracks).map(([n, fn]) => [n, r4(fn(r, t))]));
      if (f % Math.round((def.fps ?? 60) / 10) === 0) log.push({ t: r4(t), ...tr, Lk: r4(tr.twist + tr.writhe), crossings: r.stats.crossings, strain: r4(r.maxStrain()) });
      if (times.some((x) => Math.abs(x - t) < 1e-6)) snaps.push(snap(sim, r, `Tw ${tr.twist.toFixed(2)} Wr ${tr.writhe.toFixed(2)} out ${(tr.outOfPlane * 100).toFixed(1)}cm`));
    },
  });
  const res = { id: def.id, nodes: rod.n, fps: def.fps ?? 60, buildWall: tb, bakeWall: r4(b.stats.wallSeconds), final: log[log.length - 1], log };
  console.log(JSON.stringify({ ...res, log: undefined }));
  console.log(log.filter((_, i) => i % 3 === 0).map((l) => `${l.t} Tw ${l.twist} Wr ${l.writhe} Lk ${l.Lk} out ${l.outOfPlane} end ${l.endTwist} cx ${l.crossings} strain ${l.strain}`).join('\n'));
  fs.writeFileSync(path.join(OUT, `${k}.summary.json`), JSON.stringify(res, null, 2));
  const views = [
    { name: 'front (Noor)', target: [0, H, 0], dist: 0.85, yaw: 0, pitch: 5, fov: 45, grid: 0.1 },
    { name: 'side', target: [0, H, 0], dist: 0.85, yaw: 90, pitch: 5, fov: 45, grid: 0.1 },
    { name: 'top', target: [0, H, 0], dist: 0.85, yaw: 0, pitch: 80, fov: 45, grid: 0.1 },
  ];
  const png = render(`eight_${k}`, { title: `${def.id}: ${def.fps ?? 60} fps. red stripe = d1`, radius: eight.EIGHT_CABLE.radius, visScale: 1.2, views, snapshots: snaps, W: 330, H: 330 });
  fs.renameSync(png, path.join(OUT, `${k}.png`));
}
await close();
