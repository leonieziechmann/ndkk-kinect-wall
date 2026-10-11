// S1 (prototype scenario): a 2 m cable hangs between two held points, the grips move from 2.0 m to
// 1.4 m apart in 1 s. Pinned ends are compared with the catenary; clamped ends (a hand) leave the
// hand horizontally. Checks length conservation and the joint gaps.

import { load, snap, render, writeSummary, smooth, r4 } from './lib.mjs';

const { mods: [sim], close } = await load('/src/sim/index.ts');
const { Rod, bake } = sim;
const N = 101, L = 2, H = 1.2, half = 0.7;
const out = {};
const snaps = [];
for (const variant of ['pinned', 'clamped']) {
  const rod = Rod.straight([-L / 2, H, 0], [L / 2, H, 0], N, { radius: 0.0035, linearDensity: 0.05, EI: 2e-3, GJ: 1.5e-3 });
  const hand = (sgn) => (t) => ({ p: [sgn * (L / 2 + (half - L / 2) * smooth(t / 1.0)), H, 0], q: [0, 0, 0, 1] });
  const orient = variant === 'clamped';
  rod.addGrip({ nodes: orient ? [0, 1] : [0], orient, keepShape: true, frame: hand(-1) });
  rod.addGrip({ nodes: orient ? [N - 2, N - 1] : [N - 1], orient, keepShape: true, frame: hand(1) });
  let maxStrainMoving = 0, maxStrainSettled = 0;
  const baked = bake(rod, {
    duration: 3,
    onFrame: (r, t) => {
      const s = r.maxStrain();
      if (t < 1.5) maxStrainMoving = Math.max(maxStrainMoving, s);
      else maxStrainSettled = Math.max(maxStrainSettled, s);
      if ([0.3, 1.0, 3.0].some((x) => Math.abs(x - t) < 1e-6)) snaps.push(snap(sim, r, variant));
    },
  });
  // catenary with the same length between the end points
  let lo = 0.01, hi = 100;
  for (let i = 0; i < 200; i++) {
    const c = (lo + hi) / 2;
    if (2 * c * Math.sinh(half / c) > L) lo = c;
    else hi = c;
  }
  const c = (lo + hi) / 2, sagRef = c * (Math.cosh(half / c) - 1);
  let minY = Infinity, dev = 0;
  for (let i = 0; i < N; i++) minY = Math.min(minY, rod.x[3 * i + 1]);
  for (let i = 0; i < N; i++) dev = Math.max(dev, Math.abs(rod.x[3 * i + 1] - (H - sagRef - c + c * Math.cosh(rod.x[3 * i] / c))));
  out[variant] = { lengthEnd: r4(rod.length()), maxStrainWhileMoving: r4(maxStrainMoving), maxStrainSettled: r4(maxStrainSettled), sag: r4(H - minY), catenarySag: r4(sagRef), maxDeviationFromCatenary_m: r4(dev), simSecondsPerWallSecond: r4(baked.stats.simSecondsPerWallSecond) };
  console.log(variant, JSON.stringify(out[variant]));
}
writeSummary('s1', out);
const views = [{ name: 'front', target: [0, 0.8, 0], dist: 3, yaw: 0, pitch: 5, fov: 45 }, { name: '3/4', target: [0, 0.8, 0], dist: 3, yaw: 35, pitch: 25, fov: 45 }];
console.log(render('s1', { title: 'S1 hanging cable (2 m, grips 2.0 -> 1.4 m apart in 1 s). left 3: pinned ends, right 3: clamped ends', radius: 0.0035, views, snapshots: snaps, W: 300, H: 260 }));
await close();
