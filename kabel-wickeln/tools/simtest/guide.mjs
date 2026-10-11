// Guides (pseudo-simulation): an XLR cable hangs from two hands 8 cm apart as a loop (a teardrop
// under gravity). From 2.6 s soft guides pull the loop's nodes onto a target circle (R 15 cm),
// from 5 s they fade out again. Gravity, stiffness and contacts keep acting throughout.
// Measures the distance of the guided nodes from their targets and from the circle.

import { load, snap, render, writeSummary, smooth, r4 } from './lib.mjs';

const { mods: [sim], close } = await load('/src/sim/index.ts');
const { Rod, bake, gripFrame } = sim;
const SEG = 0.01, R = 0.15, H = 1.3, HX = 0.04;
const C = [0, H - 0.03 - R, 0];
const TH1 = 0.6, ARC = (2 * Math.PI - 2 * TH1) * R, TRANS = 0.07;
const circle = (th) => [C[0] - R * Math.sin(th), C[1] + R * Math.cos(th), C[2]];
// held 2 segments | transition | guided arc | transition | held 2 segments
const nTrans = Math.round(TRANS / SEG), nArc = Math.round(ARC / SEG);
const ia = 2 + nTrans, ib = ia + nArc, N = ib + nTrans + 3;
const L = (N - 1) * SEG;
const rod = Rod.straight([-L / 2, H, 0], [L / 2, H, 0], N, { damping: 1.5 });
// hands move in and turn the cable down (left) and up (right) through the fists in 1.2 s
const hand = (sgn) => (t) => {
  const u = smooth(t / 1.2), a = sgn * (Math.PI / 2) * u;
  const x0 = sgn * (L / 2 - SEG), x = x0 + (sgn * HX - x0) * u;
  return gripFrame([x, H, 0], [Math.cos(a), Math.sin(a), 0], [0, 0, 1]);
};
rod.addGrip({ nodes: [0, 2], frame: hand(-1) });
rod.addGrip({ nodes: [N - 3, N - 1], frame: hand(1) });
const target = (i) => circle(TH1 + ((i - ia) * SEG) / R);
const weight = (t) => smooth((t - 2.6) / 1.0) * (1 - smooth((t - 5) / 1.0));
rod.addGuide({ nodes: [ia, ib], target, compliance: 1e-3, weight });

/** distances of the guided nodes from their targets and from the circle (max, rms) */
function deviation(r) {
  let maxT = 0, sumT = 0, maxC = 0;
  for (let i = ia; i <= ib; i++) {
    const p = [r.x[3 * i], r.x[3 * i + 1], r.x[3 * i + 2]], q = target(i);
    const dT = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    const dC = Math.hypot(Math.hypot(p[0] - C[0], p[1] - C[1]) - R, p[2] - C[2]);
    maxT = Math.max(maxT, dT);
    sumT += dT * dT;
    maxC = Math.max(maxC, dC);
  }
  return { maxToTarget_m: r4(maxT), rmsToTarget_m: r4(Math.sqrt(sumT / (ib - ia + 1))), maxToCircle_m: r4(maxC) };
}

const ring = [];
for (let k = 0; k < 48; k++) ring.push({ a: circle((k / 48) * 2 * Math.PI), b: circle(((k + 1) / 48) * 2 * Math.PI), r: 0.0012 });
const snaps = [], log = [];
const marks = { 2.6: 'hanging', 3.1: 'guides 50 %', 5: 'guided', 6.5: 'released' };
const baked = bake(rod, {
  duration: 6.5,
  onFrame: (r, t, f) => {
    if (f % 6 === 0) log.push({ t: r4(t), weight: r4(weight(t)), ...deviation(r), maxStrain: r4(r.maxStrain()) });
    for (const [k, label] of Object.entries(marks)) if (Math.abs(+k - t) < 1e-6) snaps.push(snap(sim, r, label, { caps: ring }));
  },
});
const at = (t) => log.find((e) => Math.abs(e.t - t) < 1e-3);
const out = { nodes: N, length: r4(L), guidedNodes: [ia, ib], compliance: 1e-3, hanging: at(2.6), guided: at(5), released: at(6.5), simSecondsPerWallSecond: r4(baked.stats.simSecondsPerWallSecond), log };
console.log(JSON.stringify({ ...out, log: undefined }));
writeSummary('guide', out);
const views = [{ name: 'front', target: [0, H - 0.17, 0], dist: 0.9, yaw: 0, pitch: 3, fov: 45 }, { name: '3/4', target: [0, H - 0.17, 0], dist: 0.9, yaw: 50, pitch: 25, fov: 45 }];
console.log(render('guide', { title: 'Guides: loop hanging from two hands (teardrop), guides fade in 2.6-3.6 s toward the thin circle, fade out 5-6 s', radius: 0.0035, visScale: 1.5, views, snapshots: snaps, W: 300, H: 300 }));
await close();
