// Pictures of a baked shot (bakes/<id>.bin) at a few times, front and 3/4 view, with the stripe
// (d1) in red: a quick look at a bake without the scene.
//   node tools/simtest/shot.mjs <id> [t1 t2 …] [--target x,y,z] [--dist m]
//   → output/simtest/shot_<id>.png

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, load, render } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const [id, ...rest] = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--'));
if (!id) throw new Error('usage: node tools/simtest/shot.mjs <id> [t1 t2 …]');
const { mods: [sim], close } = await load('/src/sim/index.ts');
const buf = fs.readFileSync(path.join(ROOT, 'bakes', `${id}.bin`));
const b = sim.BakedRod.fromBinary(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const times = rest.length ? rest.map(Number) : [0, 0.25, 0.5, 0.75, 1].map((u) => +(b.t0 + u * b.duration).toFixed(2));
const pos = new Float32Array(3 * b.n), d1 = new Float32Array(3 * b.n);
const snaps = times.map((t) => {
  b.frameSample(t, pos, d1);
  const label = b.trackNames.map((k) => `${k} ${b.track(k, t).toFixed(2)}`).join('  ');
  return { t, label, pos: Array.from(pos, (v) => +v.toFixed(5)), d1: Array.from(d1, (v) => +v.toFixed(4)), grips: [], caps: [] };
});
// frame the whole recording unless given
let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < b.pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b.pos[i + k]); hi[k] = Math.max(hi[k], b.pos[i + k]); }
const target = opt('target')?.split(',').map(Number) ?? lo.map((v, k) => (v + hi[k]) / 2);
const dist = Number(opt('dist') ?? Math.max(0.6, 1.4 * Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])));
const views = [{ name: 'front', target, dist, yaw: 0, pitch: 5, fov: 45 }, { name: '3/4', target, dist, yaw: 40, pitch: 25, fov: 45 }];
console.log(render(`shot_${id}`, { title: `${id}: ${b.n} nodes, ${b.duration.toFixed(2)} s at ${b.fps} fps. red stripe = d1`, radius: b.radius, visScale: 2, views, snapshots: snaps, W: 300, H: 280 }));
await close();
