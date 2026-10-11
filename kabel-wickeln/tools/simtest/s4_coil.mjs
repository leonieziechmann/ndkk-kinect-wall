// S4 (prototype scenario): a coil of 6 loops (R 0.18 m, 7.4 m with 0.3 m tails) lies on the floor;
// both ends are lifted to 0.9 m and pulled 4.4 m apart.
//  a_sameway:   plain helix, no twist: Lk ≈ Wr ≈ -6, pulled out it becomes twist and pigtails
//  b_overunder: every second loop carries 2 turns of twist against the coil: Lk ≈ 0, comes out smooth
//   VARIANTS=a_sameway,b_overunder AIR=1 node tools/simtest/s4_coil.mjs

import { load, snap, render, writeSummary, smooth, lerp3, r4 } from './lib.mjs';

const { mods: [sim], close } = await load('/src/sim/index.ts');
const { Rod, bake, coilPoints } = sim;
const R = 0.18, LOOPS = 6, r = 0.0035, SEG = 0.025, LEAD = 0.3;
const AIR = process.env.AIR === '1';
const CABLE = { groundY: AIR ? null : 0, radius: r, linearDensity: 0.05, EI: 2e-3, GJ: 1.5e-3, friction: 0.5, selfFriction: 0.3, damping: 1 };
const loopLen = 2 * Math.PI * R;
const PULL = 2.0, SPREAD = 2.2, HEIGHT = 0.9;
const variants = (process.env.VARIANTS || 'a_sameway,b_overunder').split(',');

/** self-crossings of the top (xz) projection */
function topCrossings(x, n) {
  let cnt = 0;
  const seg = (i) => [x[3 * i], x[3 * i + 2], x[3 * i + 3], x[3 * i + 5]];
  for (let i = 0; i < n - 1; i++) {
    const [a, b, c, d] = seg(i);
    for (let j = i + 3; j < n - 1; j++) {
      const [e, f, g, h] = seg(j);
      const d1 = (g - e) * (b - f) - (h - f) * (a - e), d2 = (g - e) * (d - f) - (h - f) * (c - e);
      const d3 = (c - a) * (f - b) - (d - b) * (e - a), d4 = (c - a) * (h - b) - (d - b) * (g - a);
      if (d1 * d2 < 0 && d3 * d4 < 0) cnt++;
    }
  }
  return cnt;
}

const result = {};
for (const variant of variants) {
  const center = [0, AIR ? 1.2 : r, 0];
  const pts = coilPoints({ center, R, loops: LOOPS, pitch: 2.25 * r, seg: SEG, lead: LEAD });
  // sign of the coil's writhe: the under loops get twist of the opposite sign, 2 turns each
  const wrSign = Math.sign(Rod.fromPolyline(pts, CABLE).writhe());
  const twist = variant.startsWith('b')
    ? (s) => {
        const u = (s - LEAD) / loopLen;
        if (u <= 0) return 0;
        const done = Math.min(u, LOOPS), k = Math.floor(done), f = done - k;
        return -wrSign * 4 * Math.PI * (Math.floor(k / 2) + (k % 2 === 1 ? f : 0));
      }
    : undefined;
  const rod = Rod.fromPolyline(pts, { ...CABLE, twist });
  const n = rod.n;
  const p0 = [rod.x[3], rod.x[4], rod.x[5]], p1 = [rod.x[3 * (n - 2)], rod.x[3 * (n - 2) + 1], rod.x[3 * (n - 2) + 2]];
  const T0 = 0.3;
  const hand = (p, tgt) => (t) => ({ p: lerp3(p, tgt, smooth((t - T0) / PULL)), q: [0, 0, 0, 1] });
  rod.addGrip({ nodes: [0, 2], keepShape: true, frame: hand(p0, [p0[0], HEIGHT, -SPREAD]) });
  rod.addGrip({ nodes: [n - 3, n - 1], keepShape: true, frame: hand(p1, [p1[0], HEIGHT, SPREAD]) });
  const Lk0 = rod.twistTurns() + rod.writhe();
  const snaps = [], log = [];
  const dur = T0 + PULL + 1.2;
  const baked = bake(rod, {
    duration: dur,
    onFrame: (rr, t, f) => {
      if (f % 30 === 0) log.push({ t: r4(t), Tw: r4(rr.twistTurns()), Wr: r4(rr.writhe()), crossings: topCrossings(rr.x, rr.n), contacts: rr.stats.contacts });
      if ([0, T0 + PULL * 0.35, T0 + PULL * 0.7, dur].some((x) => Math.abs(x - t) < 1e-6)) snaps.push(snap(sim, rr, variant));
    },
  });
  const fin = log[log.length - 1];
  result[variant] = { nodes: n, length: r4(rod.totalLength), Lk0: r4(Lk0), Tw0: log[0].Tw, Wr0: log[0].Wr, final: fin, LkEnd: r4(fin.Tw + fin.Wr), simSecondsPerWallSecond: r4(baked.stats.simSecondsPerWallSecond), log };
  console.log(variant, JSON.stringify({ ...result[variant], log: undefined }));
  const views = [
    { name: 'top', target: [0, 0, 0], dist: 6.5, yaw: 0, pitch: 89, fov: 45, gridExtent: 3, grid: 0.5 },
    { name: '3/4', target: [0, AIR ? 0.6 : 0.3, 0], dist: 5.5, yaw: 70, pitch: 22, fov: 45, gridExtent: 3, grid: 0.5 },
    { name: 'floor close-up', target: [0, 0.05, 0], dist: 2.6, yaw: 90, pitch: 50, fov: 45, gridExtent: 3, grid: 0.25 },
  ];
  render(`s4_${variant}${AIR ? '_air' : ''}`, { title: `S4 ${variant}: 6-loop coil (R 0.18 m, ${rod.totalLength.toFixed(2)} m), ends lifted to ${HEIGHT} m and pulled ${2 * SPREAD} m apart in ${PULL} s${AIR ? ' (no floor)' : ''}`, radius: r, visScale: 3, views, snapshots: snaps, W: 380, H: 300 });
}
writeSummary(`s4${AIR ? '_air' : ''}`, result);
await close();
