// De-risking stage 1 shot 4: Kofi's throw (src/shots/throw.ts).
//   node tools/simtest/derisk-throw.mjs
// Logs per frame: peel progress, Tw/Wr, self-crossings of the cable on the floor seen from above
// (curls), the tightest bend on the floor. Pictures: side and top views.
// Output: output/derisk/throw/*.png, throw.summary.json

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, load, snap, render, r4 } from './lib.mjs';

const OUT = path.join(ROOT, 'output/derisk/throw');
fs.mkdirSync(OUT, { recursive: true });
const { mods: [sim, thr], close } = await load('/src/sim/index.ts', '/src/shots/throw.ts');

/** crossings of the floor part (y < 5 cm) seen from above, and the smallest bend radius there */
function floorShape(x, n, from = 0, to = n - 1) {
  const on = (i) => i >= from && i <= to && x[3 * i + 1] < 0.05;
  let cross = 0, minR = Infinity;
  for (let i = 0; i < n - 1; i++) {
    if (!on(i) || !on(i + 1)) continue;
    for (let j = i + 2; j < n - 1; j++) {
      if (!on(j) || !on(j + 1)) continue;
      const a = [x[3 * i], x[3 * i + 2]], b = [x[3 * i + 3], x[3 * i + 5]], c = [x[3 * j], x[3 * j + 2]], d = [x[3 * j + 3], x[3 * j + 5]];
      const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) cross++;
    }
  }
  for (let i = 1; i < n - 1; i++) {
    if (!on(i - 1) || !on(i + 1)) continue;
    const ax = x[3 * i] - x[3 * i - 3], az = x[3 * i + 2] - x[3 * i - 1], bx = x[3 * i + 3] - x[3 * i], bz = x[3 * i + 5] - x[3 * i + 2];
    const ang = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
    if (ang > 1e-6) minR = Math.min(minR, Math.hypot(ax, az) / ang);
  }
  return { cross, minR };
}

/** joint with the largest gap (index, gap / segment length) */
function worstJoint(r) {
  const end = (j, side) => {
    const [x, y, z, w] = [r.q[4 * j], r.q[4 * j + 1], r.q[4 * j + 2], r.q[4 * j + 3]], h = side * r.L[j] / 2;
    return [r.c[3 * j] + h * 2 * (x * z + w * y), r.c[3 * j + 1] + h * 2 * (y * z - w * x), r.c[3 * j + 2] + h * (w * w - x * x - y * y + z * z)];
  };
  let best = [0, 0];
  for (let k = 0; k < r.ns - 1; k++) {
    const a = end(k, 1), b = end(k + 1, -1), g = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / r.L[k];
    if (g > best[1]) best = [k, r4(g)];
  }
  return best;
}

const def = thr.throwShot;
const t0 = Date.now();
const { rod, script, tracks } = def.build();
const tb = (Date.now() - t0) / 1000;
const times = (process.env.TIMES ?? '0,1.0,1.4,1.7,2.0,2.3,2.6,3.0,4.6').split(',').map(Number);
const snaps = [], log = [];
const b = sim.bake(rod, {
  duration: Number(process.env.DUR ?? def.duration), substeps: def.substeps, script, tracks,
  onFrame: (r, t, f) => {
    if (f % 6 === 0) {
      const kh = tracks.handEnd(r, t), kc = tracks.coilStart(r, t);
      const fs2 = floorShape(r.x, r.n, kh, kc);
      log.push({ t: r4(t), Tw: r4(r.twistTurns()), Wr: r4(r.writhe()), kh, kc, held: r.heldSegments().length, floorCross: fs2.cross, minBend: r4(fs2.minR), crossings: r.stats.crossings, strain: r4(r.maxStrain()), worst: worstJoint(r) });
    }
    if (times.some((x) => Math.abs(x - t) < 1e-6)) snaps.push(snap(sim, r, `held ${r.heldSegments().length}`));
  },
});
const res = { id: def.id, nodes: rod.n, release: r4(thr.THROW_RELEASE), buildWall: tb, bakeWall: r4(b.stats.wallSeconds), final: log[log.length - 1], log };
console.log(JSON.stringify({ ...res, log: undefined }));
console.log(log.filter((_, i) => i % 3 === 0).map((l) => `${l.t} hand ${l.kh} coil ${l.kc} held ${l.held} worst ${l.worst} Tw ${l.Tw} Wr ${l.Wr} floorX ${l.floorCross} minBend ${l.minBend} cx ${l.crossings} strain ${l.strain}`).join('\n'));
fs.writeFileSync(path.join(OUT, 'throw.summary.json'), JSON.stringify(res, null, 2));
const views = [
  { name: 'side', target: [3.2, 0.8, 0], dist: 8.5, yaw: 0, pitch: 5, fov: 45, grid: 0.5, gridExtent: 6 },
  { name: 'top', target: [3.2, 0, 0], dist: 8.5, yaw: 0, pitch: 89, fov: 45, grid: 0.5, gridExtent: 6 },
  { name: 'behind', target: [3.5, 0.5, 0], dist: 6, yaw: -90, pitch: 18, fov: 45, grid: 0.5, gridExtent: 6 },
];
// close-ups of the landed strand from above, in three pieces along x
const fin = snaps[snaps.length - 1];
const parts = [0.8, 3, 5.2].map((cx, i) => ({ name: `floor ${i + 1}`, target: [cx, 0, 0], dist: 3, yaw: 0, pitch: 89, fov: 45, grid: 0.25, gridExtent: 8 }));
fs.renameSync(render('throw_floor', { title: 'throw: the landed cable from above (end of the shot)', radius: thr.THROW_RADIUS, visScale: 1, views: parts, snapshots: [fin], W: 700, H: 300 }), path.join(OUT, 'throw-floor.png'));
const png = render('throw', { title: `throw: 15 m XLR, release ${thr.THROW_RELEASE.toFixed(2)} s`, radius: thr.THROW_RADIUS, visScale: 1, views, snapshots: snaps, W: 320, H: 300 });
fs.renameSync(png, path.join(OUT, 'throw.png'));
await close();
