// De-risking stage 5.1: knots from pulling an end through an over-under coil.
//   PATTERN=ouo [THREAD=0] [TAIL=0.6] node tools/simtest/derisk-knot.mjs factory
//       winds a coil (src/shots/wind.ts), threads the end, lays it down: pictures of the winding,
//       Tw/Wr and the knot count (knot determinant) per half second
//   PATTERN=ouou node tools/simtest/derisk-knot.mjs air
//       the coil (not threaded) pulled apart in the air: the twist the loops leave
//   node tools/simtest/derisk-knot.mjs pull
//       the shot (src/shots/knot.ts): knots, Lk/Wr jumps, closest strands, force per frame
// Output: output/derisk/knot/*.png, *.summary.json

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, load, snap, render, r4 } from './lib.mjs';

const OUT = path.join(ROOT, 'output/derisk/knot');
fs.mkdirSync(OUT, { recursive: true });
const { mods: [sim, wind, topo, knot], close } = await load('/src/sim/index.ts', '/src/shots/wind.ts', '/src/shots/topology.ts', '/src/shots/knot.ts');
const mode = process.argv[2] ?? 'factory';
const pattern = process.env.PATTERN ?? 'ouo';
const thread = process.env.THREAD !== '0';

const XLR = { radius: 0.0035, collisionRadius: 0.0042, linearDensity: 0.05, EI: 2e-3, GJ: 1.5e-3, friction: 0.5, selfFriction: 0.3 };
const move = (png, name) => { const dst = path.join(OUT, name); fs.renameSync(png, dst); return dst; };

if (mode === 'factory') {
  const snaps = [], log = [];
  const times = (process.env.TIMES ?? '0.8,2.4,3.4,5,8.6,10.2,11.8,13,14.6').split(',').map(Number);
  const t0 = Date.now();
  const coil = wind.windCoil({
    cable: XLR, seg: 0.01, loop: 0.78, pattern, lead: 0.3, tail: Number(process.env.TAIL ?? 0.85), thread,
    onFrame: (rod, t) => {
      const f = Math.round(t * 60);
      if (f % Number(process.env.LOGEVERY ?? 30) === 0) log.push({ t: r4(t), Tw: r4(rod.twistTurns()), Wr: r4(rod.writhe()), contacts: rod.stats.contacts, crossings: rod.stats.crossings, ...topo.knots(rod.x, 0, rod.n - 1), dets: [[0.5237, 1, 0.3119], [-0.6113, 1, 0.4231], [0.2613, 1, -0.7417], [0, 0, 1], [1, 0.1, 0.05]].map((d) => topo.knotDeterminant(rod.x, 0, rod.n - 1, d)).join('/') });
      if (times.some((x) => Math.abs(x - t) < 1e-6)) snaps.push(snap(sim, rod, `${pattern}`));
    },
  });
  const wall = (Date.now() - t0) / 1000;
  const rod = sim.Rod.fromState(coil.state);
  snaps.push(snap(sim, rod, 'laid'));
  const res = { pattern, thread, nodes: rod.n, loops: coil.loops, wall, final: { Tw: r4(rod.twistTurns()), Wr: r4(rod.writhe()), ...topo.knots(rod.x, 0, rod.n - 1), minDist: r4(topo.minStrandDistance(rod.x, rod.n, 4)) }, log };
  console.log(JSON.stringify({ ...res, log: undefined }));
  console.log(log.map((l) => `${l.t} Tw ${l.Tw} Wr ${l.Wr} det ${l.det} (${l.dets}) cx ${l.crossings}`).join('\n'));
  fs.writeFileSync(path.join(OUT, `factory-${pattern}${thread ? '-thread' : ''}.summary.json`), JSON.stringify(res, null, 2));
  const hang = { name: 'front', target: [0, 1.4, 0], dist: 0.8, yaw: 0, pitch: 0, fov: 45 };
  const side = { name: process.env.SIDE ?? '3/4', target: [0, 1.4, 0], dist: 0.8, yaw: Number(process.env.YAW ?? 50), pitch: Number(process.env.PITCH ?? 20), fov: 45 };
  const fin = snaps.length - 1;
  move(render(`knot_factory_${pattern}`, { title: `coil factory ${pattern}${thread ? ' + threaded' : ''}`, radius: XLR.radius, visScale: 1, views: [hang, side], snapshots: snaps.slice(0, fin), W: 400, H: 400 }), `factory-${pattern}.png`);
  const top = { name: 'top', target: [0, 0, 0], dist: 0.9, yaw: 0, pitch: 89, fov: 45, grid: 0.1, gridExtent: 0.5 };
  const tq = { name: '3/4', target: [0, 0, 0.05], dist: 0.8, yaw: 30, pitch: 40, fov: 45, grid: 0.1, gridExtent: 0.5 };
  move(render(`knot_laid_${pattern}`, { title: `laid coil ${pattern}`, radius: XLR.radius, visScale: 1, views: [top, tq], snapshots: [snaps[fin]], W: 500, H: 500 }), `laid-${pattern}${thread ? '-thread' : ''}.png`);
}

if (mode === 'air') {
  // factory check: the coil (not threaded) pulled apart in the air; Tw = what the loops leave
  const coil = wind.windCoil({ cable: XLR, seg: 0.01, loop: 0.78, pattern, lead: 0.3, tail: 0.6 });
  const rod = sim.Rod.fromState(coil.state);
  rod.opts.groundY = null;
  const n = rod.n;
  const end = (i) => [rod.x[3 * i], rod.x[3 * i + 1], rod.x[3 * i + 2]];
  const pa = end(1), pb = end(n - 2), L = rod.totalLength * 0.9;
  const mk = (p, tgt) => (t) => ({ p: sim.lerp3(p, tgt, sim.smooth(t / 3)), q: [0, 0, 0, 1] });
  rod.addGrip({ nodes: [0, 3], keepShape: true, frame: mk(pa, [-L / 2, 1.2, 0]) });
  rod.addGrip({ nodes: [n - 4, n - 1], keepShape: true, frame: mk(pb, [L / 2, 1.2, 0]) });
  const snaps = [];
  const b = sim.bake(rod, { duration: 5, substeps: 30, onFrame: (r, t) => { if ([0, 1, 2, 5].some((x) => Math.abs(x - t) < 1e-6)) snaps.push(snap(sim, r, `Tw ${r.twistTurns().toFixed(2)} Wr ${r.writhe().toFixed(2)}`)); } });
  const res = { pattern, Tw: r4(rod.twistTurns()), Wr: r4(rod.writhe()), crossings: rod.stats.crossings, wall: r4(b.stats.wallSeconds) };
  console.log(JSON.stringify(res));
  fs.writeFileSync(path.join(OUT, `air-${pattern}.summary.json`), JSON.stringify(res, null, 2));
  move(render(`knot_air_${pattern}`, { title: `coil ${pattern} pulled apart in the air`, radius: XLR.radius, visScale: 1.5, views: [{ name: 'front', target: [0, 0.8, 0], dist: 3.2, yaw: 0, pitch: 10, fov: 45 }], snapshots: snaps, W: 420, H: 320 }), `air-${pattern}.png`);
}
await close();

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
/** smallest ball (radius) that holds `span` metres of cable (and its centre, with full: true) */
function tightest(r, span, full = false) {
  const w = Math.round(span / 0.01);
  let best = Infinity, at = [0, 0, 0];
  for (let i = 0; i + w < r.n; i++) {
    let cx = 0, cy = 0, cz = 0;
    for (let k = i; k <= i + w; k++) { cx += r.x[3 * k]; cy += r.x[3 * k + 1]; cz += r.x[3 * k + 2]; }
    cx /= w + 1; cy /= w + 1; cz /= w + 1;
    let m = 0;
    for (let k = i; k <= i + w; k++) m = Math.max(m, Math.hypot(r.x[3 * k] - cx, r.x[3 * k + 1] - cy, r.x[3 * k + 2] - cz));
    if (m < best) { best = m; at = [cx, cy, cz]; }
  }
  return full ? { r: best, at } : r4(best);
}

if (mode === 'pull') {
  // the shot: log knots, Lk, closest strands per frame; pictures at a few moments
  const def = knot.knotPull;
  const t0 = Date.now();
  const { rod, script, tracks } = def.build();
  const tf = (Date.now() - t0) / 1000;
  rod.opts.iterations = def.iterations;
  const log = [], snaps = [];
  let prev = null, jumps = [], minDist = Infinity;
  const times = (process.env.TIMES ?? '0,2,3.5,5,6.5,8,10').split(',').map(Number);
  const b = sim.bake(rod, {
    duration: Number(process.env.DUR ?? def.duration), substeps: def.substeps, script, tracks,
    onFrame: (r, t, f) => {
      const md = topo.minStrandDistance(r.x, r.n, 4);
      minDist = Math.min(minDist, md);
      if (f % 6 === 0) {
        const tw = r.twistTurns(), wr = r.writhe(), k = topo.knots(r.x, 0, r.n - 1);
        if (prev && (k.det !== prev.det || Math.abs(wr - prev.wr) > 0.8)) jumps.push({ t: r4(t), det: [prev.det, k.det], wr: [r4(prev.wr), r4(wr)] });
        prev = { det: k.det, wr };
        const e = r.n - 1, ends = Math.hypot(r.x[3 * e] - r.x[0], r.x[3 * e + 1] - r.x[1], r.x[3 * e + 2] - r.x[2]);
        log.push({ t: r4(t), Tw: r4(tw), Wr: r4(wr), det: k.det, knots: k.knots, tight: topo.tightKnots(r.x, r.n, 0.01).length, force: r4(tracks.force(r, t)), minDist: r4(md), crossings: r.stats.crossings, ends: r4(ends), strain: r4(r.maxStrain()), worst: worstJoint(r), ball15: tightest(r, 0.15), ball20: tightest(r, 0.2), ball25: tightest(r, 0.25) });
      }
      if (times.some((x) => Math.abs(x - t) < 1e-6)) snaps.push(snap(sim, r, `knots ${topo.knots(r.x, 0, r.n - 1).knots}, tight ${topo.tightKnots(r.x, r.n, 0.01).length}`, { knotAt: tightest(r, 0.3, true).at }));
    },
  });
  const res = { id: def.id, nodes: rod.n, factoryWall: tf, bakeWall: r4(b.stats.wallSeconds), minDist: r4(minDist), contactDiameter: 2 * rod.rc, jumps, final: log[log.length - 1], log };
  console.log(JSON.stringify({ ...res, log: undefined }));
  console.log(log.filter((_, i) => i % 5 === 0).map((l) => `${l.t} Tw ${l.Tw} Wr ${l.Wr} knots ${l.knots}(${l.det}) tight ${l.tight} F ${l.force} min ${l.minDist} cx ${l.crossings} ends ${l.ends} strain ${l.strain} @${l.worst[0]} balls ${l.ball15}/${l.ball20}/${l.ball25}`).join('\n'));
  fs.writeFileSync(path.join(OUT, 'pull.summary.json'), JSON.stringify(res, null, 2));
  const Y = knot.TABLE_Y;
  const v1 = { name: '3/4', target: [0, Y, 0.5], dist: 1.6, yaw: 60, pitch: 35, fov: 45, grid: 0.1, gridExtent: 2 };
  const v2 = { name: 'top', target: [0, Y, 0.6], dist: 2.2, yaw: 0, pitch: 89, fov: 45, grid: 0.1, gridExtent: 2 };
  move(render('knot_pull', { title: `knot-pull: ${knot.KNOT_PATTERN} coil, end through the eye, pulled away (force-limited)`, radius: 0.0035, visScale: 1.3, views: [v1, v2], snapshots: snaps, W: 420, H: 420 }), 'pull.png');
  const c1 = { name: 'close', target: [0, Y, -0.05], dist: 0.55, yaw: 35, pitch: 40, fov: 45, grid: 0.05, gridExtent: 0.5 };
  const c2 = { name: 'close top', target: [0, Y, -0.05], dist: 0.55, yaw: 0, pitch: 89, fov: 45, grid: 0.05, gridExtent: 0.5 };
  // close-ups following the tightest tangle (centre of the smallest ball holding 30 cm of cable)
  const shots = snaps.map((sn, k) => render(`knot_follow_${k}`, { title: `t ${sn.t.toFixed(1)} s`, radius: 0.0035, visScale: 1, views: [{ name: 'knot', target: sn.knotAt, dist: 0.4, yaw: 35, pitch: 45, fov: 45, grid: 0.05, gridExtent: 0.4 }], snapshots: [sn], W: 330, H: 330 }));
  execFileSync('python3', ['-c', 'import sys; from PIL import Image; ims=[Image.open(p) for p in sys.argv[2:]]; W=sum(i.width for i in ims); H=max(i.height for i in ims); o=Image.new("RGB",(W,H),"white"); x=0\nfor i in ims: o.paste(i,(x,0)); x+=i.width\no.save(sys.argv[1])', path.join(OUT, 'pull-follow.png'), ...shots]);
  for (const f of shots) fs.unlinkSync(f);
  move(render('knot_close', { title: 'knot-pull close-up', radius: 0.0035, visScale: 1, views: [c1, c2], snapshots: snaps, W: 420, H: 420 }), 'pull-close.png');
}
await close();
