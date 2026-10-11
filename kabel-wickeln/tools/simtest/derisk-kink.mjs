// De-risking stage 2 shot 5: curl and kink from stored twist (src/shots/kink.ts).
//   node tools/simtest/derisk-kink.mjs
// Logs per frame: Tw/Wr/Lk between the fists, tightest bend, plasticity; pictures front, top and
// a close-up at the tightest bend. Output: output/derisk/kink/*.png, kink.summary.json

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, load, snap, render, r4 } from './lib.mjs';

const OUT = path.join(ROOT, 'output/derisk/kink');
fs.mkdirSync(OUT, { recursive: true });
const { mods: [sim, kink], close } = await load('/src/sim/index.ts', '/src/shots/kink.ts');
const def = kink.kinkShot;
const { rod, script, tracks } = def.build();
rod.opts.iterations = def.iterations;
const times = (process.env.TIMES ?? '0.5,1.0,1.3,2.5,3.2,3.8,4.6,5.8,6.5').split(',').map(Number);
const snaps = [], log = [];
let prevLk = null, jumps = [];
const b = sim.bake(rod, {
  duration: def.duration, fps: def.fps, substeps: def.substeps, script, tracks,
  onFrame: (r, t, f) => {
    const tr = Object.fromEntries(Object.entries(tracks).map(([n, fn]) => [n, fn(r, t)]));
    const lk = tr.twist + tr.writhe;
    if (prevLk !== null && Math.abs(lk - prevLk) > 0.5) jumps.push({ t: r4(t), from: r4(prevLk), to: r4(lk) });
    prevLk = lk;
    if (f % 12 === 0) log.push({ t: r4(t), Tw: r4(tr.twist), Wr: r4(tr.writhe), Lk: r4(lk), bend: r4(tr.bend), node: tr.kinkNode, plastic: tr.plastic, crossings: r.stats.crossings, strain: r4(r.maxStrain()) });
    if (times.some((x) => Math.abs(x - t) < 1e-6)) snaps.push(snap(sim, r, `Lk ${lk.toFixed(2)} bend ${(tr.bend * 1000).toFixed(0)}mm`));
  },
});
const res = { id: def.id, nodes: rod.n, fps: def.fps, bakeWall: r4(b.stats.wallSeconds), jumps, final: log[log.length - 1], log };
console.log(JSON.stringify({ ...res, log: undefined }));
console.log(log.filter((_, i) => i % 3 === 0).map((l) => `${l.t} Tw ${l.Tw} Wr ${l.Wr} Lk ${l.Lk} bend ${l.bend} @${l.node} plastic ${l.plastic} cx ${l.crossings} strain ${l.strain}`).join('\n'));
fs.writeFileSync(path.join(OUT, 'kink.summary.json'), JSON.stringify(res, null, 2));
const H = 1.0;
const views = [
  { name: 'front', target: [0, H, 0], dist: 1.6, yaw: 0, pitch: 5, fov: 45, grid: 0.1 },
  { name: 'top', target: [0, H, 0], dist: 1.6, yaw: 0, pitch: 80, fov: 45, grid: 0.1 },
];
fs.renameSync(render('kink', { title: `kink: 1.2 m patch cable, ${kink.KINK_TWIST} turns, ${def.fps} fps`, radius: kink.KINK_CABLE.radius, visScale: 1.5, views, snapshots: snaps, W: 330, H: 330 }), path.join(OUT, 'kink.png'));
// close-ups, each centred on the tightest bend of its moment, stitched side by side
const shots = snaps.map((sn, k) => {
  const node = kink.tightestBend(Float64Array.from(sn.pos), sn.pos.length / 3).node;
  const tgt = [sn.pos[3 * node], sn.pos[3 * node + 1], sn.pos[3 * node + 2]];
  const cv = [{ name: 'close front', target: tgt, dist: 0.3, yaw: 0, pitch: 10, fov: 45, grid: 0.02 }, { name: 'close side', target: tgt, dist: 0.3, yaw: 70, pitch: 20, fov: 45, grid: 0.02 }];
  return render(`kink_close_${k}`, { title: `t ${sn.t.toFixed(2)} s`, radius: kink.KINK_CABLE.radius, visScale: 1, views: cv, snapshots: [sn], W: 300, H: 300 });
});
execFileSync('python3', ['-c', 'import sys; from PIL import Image; ims=[Image.open(p) for p in sys.argv[2:]]; W=sum(i.width for i in ims); H=max(i.height for i in ims); o=Image.new("RGB",(W,H),"white"); x=0\nfor i in ims: o.paste(i,(x,0)); x+=i.width\no.save(sys.argv[1])', path.join(OUT, 'kink-close.png'), ...shots]);
for (const f of shots) fs.unlinkSync(f);
await close();
