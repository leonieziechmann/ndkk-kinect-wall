// Ribbon (stage 6): a flat band is a rod with EI2 = 50 × EI1 (wide side facing d2, bends easily
// about d1). Four loops in the air, held at both ends, are pulled apart to 2.84 m, then the ends
// are pushed together to 0.3 m.
//  same:  four same-sense loops: pulled taut they end as ~4 turns of twist; pushed together the
//         twist springs back into loops (Lk = Tw + Wr conserved)
//  mixed: every second loop carries 2 turns against the coil (over/under): Lk ≈ 0, the band comes
//         out flat and stays calm when pushed together
//   VARIANTS=same,mixed node tools/simtest/ribbon.mjs

import { load, snap, render, writeSummary, smooth, lerp3, r4 } from './lib.mjs';

const { mods: [sim], close } = await load('/src/sim/index.ts');
const { Rod, bake, coilPoints } = sim;
const R = 0.1, LOOPS = 4, SEG = 0.02, LEAD = 0.25, H = 1.4;
const EI1 = 1e-3, GJ = 1e-3, FAR = 1.42;
const RIBBON = { groundY: null, radius: 0.004, collisionRadius: 0.003, linearDensity: 0.02, EI1, EI2: 50 * EI1, GJ, damping: 1, selfFriction: 0.15 };
const loopLen = 2 * Math.PI * R;
const T0 = 0.3, PULL = 2, HOLD = 0.7, PUSH = 2, REST = 1.5;
const tTaut = T0 + PULL + HOLD, tEnd = tTaut + PUSH + REST;
const variants = (process.env.VARIANTS || 'same,mixed').split(',');
const result = {};
for (const variant of variants) {
  const pts = coilPoints({ center: [0, H, 0], R, loops: LOOPS, pitch: 0.012, seg: SEG, lead: LEAD });
  const wrSign = Math.sign(Rod.fromPolyline(pts, RIBBON).writhe());
  const twist = variant === 'mixed'
    ? (s) => {
        const u = (s - LEAD) / loopLen;
        if (u <= 0) return 0;
        const done = Math.min(u, LOOPS), k = Math.floor(done), f = done - k;
        return -wrSign * 4 * Math.PI * (Math.floor(k / 2) + (k % 2 === 1 ? f : 0));
      }
    : undefined;
  // d1 up: the wide side (d2) faces outward from the loop axis, the loops bend about d1
  const rod = Rod.fromPolyline(pts, { ...RIBBON, up: [0, 1, 0], twist });
  const n = rod.n;
  const p0 = [rod.x[3], rod.x[4], rod.x[5]], p1 = [rod.x[3 * (n - 2)], rod.x[3 * (n - 2) + 1], rod.x[3 * (n - 2) + 2]];
  const hand = (p, far, near) => (t) => ({
    p: t < tTaut ? lerp3(p, far, smooth((t - T0) / PULL)) : lerp3(far, near, smooth((t - tTaut) / PUSH)),
    q: [0, 0, 0, 1],
  });
  rod.addGrip({ nodes: [0, 2], keepShape: true, frame: hand(p0, [0, H, -FAR], [0, H, -0.15]) });
  rod.addGrip({ nodes: [n - 3, n - 1], keepShape: true, frame: hand(p1, [0, H, FAR], [0, H, 0.15]) });
  const Lk0 = rod.twistTurns() + rod.writhe();
  const snaps = [], log = [];
  let LkMin = Infinity, LkMax = -Infinity;
  const baked = bake(rod, {
    duration: tEnd,
    onFrame: (r, t, f) => {
      if (f % 15 === 0) {
        const tw = r.twistTurns(), wr = r.writhe();
        LkMin = Math.min(LkMin, tw + wr);
        LkMax = Math.max(LkMax, tw + wr);
        log.push({ t: r4(t), Tw: r4(tw), Wr: r4(wr), Lk: r4(tw + wr), contacts: r.stats.contacts });
      }
      if ([0, T0 + PULL / 2, tTaut, tTaut + PUSH * 0.75, tEnd].some((x) => Math.abs(x - t) < 1e-6)) snaps.push(snap(sim, r, variant, {}, 1));
    },
  });
  const at = (t) => log.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
  result[variant] = { nodes: n, length: r4(rod.totalLength), Lk0: r4(Lk0), taut: at(tTaut), end: log[log.length - 1], LkRange: [r4(LkMin), r4(LkMax)], crossings: rod.stats.crossings, simSecondsPerWallSecond: r4(baked.stats.simSecondsPerWallSecond), log };
  console.log(variant, JSON.stringify({ ...result[variant], log: undefined }));
  const views = [{ name: 'side', target: [0, H - 0.15, 0], dist: 3.6, yaw: 90, pitch: 8, fov: 45, gridExtent: 2 }, { name: '3/4', target: [0, H - 0.1, 0], dist: 1.6, yaw: 60, pitch: 25, fov: 45, gridExtent: 2 }];
  render(`ribbon_${variant}`, { title: `Ribbon ${variant} (EI2 = 50 EI1): 4 loops pulled to 2.84 m (${T0}-${T0 + PULL} s), pushed to 0.3 m (${tTaut}-${tTaut + PUSH} s). red = top face (d2)`, radius: 0.004, visScale: 2, views, snapshots: snaps, W: 300, H: 280 });
}
writeSummary(`ribbon${process.env.VARIANTS ? '-' + variants.join('-') : ''}`, result);
await close();
