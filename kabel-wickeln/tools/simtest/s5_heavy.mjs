// S5 (prototype scenario): a heavy power cable (Ø 13 mm, 0.22 kg/m) is fed through a hand moving
// 0.55 m above the floor. Figure eights lie down twist-free; circles (same-way loops) build twist.
// The cable not yet laid is a kinematic column above the hand, re-gripped every frame.
//   VARIANTS=figure8,circles node tools/simtest/s5_heavy.mjs

import { load, snap, render, writeSummary, r4 } from './lib.mjs';

const { mods: [sim], close } = await load('/src/sim/index.ts');
const { Rod, bake } = sim;
const r = 0.0065, SEG = 0.025;
const CABLE = { radius: r, linearDensity: 0.22, EI: 0.03, GJ: 0.02, friction: 0.6, selfFriction: 0.4, damping: 1.5 };
const HY = 0.55, COL = 4.5, DUR = 8;
const PATHS = {
  figure8: (t) => { const w = (2 * Math.PI) / 3.2; return [0.45 * Math.sin(w * t), HY, 0.22 * Math.sin(2 * w * t)]; },
  circles: (t) => { const w = (2 * Math.PI) / 2.6; return [0.25 * Math.sin(w * t), HY, 0.25 * (1 - Math.cos(w * t))]; },
};
const result = {};
for (const name of (process.env.VARIANTS || 'figure8,circles').split(',')) {
  const path = PATHS[name];
  // arc length of the hand path (feed speed = hand speed)
  const tab = [0];
  for (let i = 1; i <= DUR * 600 + 1; i++) {
    const a = path((i - 1) / 600), b = path(i / 600);
    tab.push(tab[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const fed = (t) => { const u = Math.min(tab.length - 2, Math.max(0, t * 600)), i = Math.floor(u); return tab[i] + (tab[i + 1] - tab[i]) * (u - i); };
  // column above the hand, down to the floor, 0.4 m on the floor
  const h0 = path(0), pts = [];
  const nCol = Math.round(COL / SEG), nDown = Math.round((HY - r) / SEG), nFloor = Math.round(0.4 / SEG);
  for (let i = 0; i <= nCol; i++) pts.push([h0[0], HY + COL - i * SEG, h0[2]]);
  for (let i = 1; i <= nDown; i++) pts.push([h0[0], Math.max(r, HY - i * SEG), h0[2]]);
  for (let i = 1; i <= nFloor; i++) pts.push([h0[0] - i * SEG, r, h0[2]]);
  const rod = Rod.fromPolyline(pts, { ...CABLE, up: [1, 0, 0] });
  const colFrame = (t) => { const p = path(t), f = fed(t); return { p: [p[0], p[1] - f, p[2]], q: [0, 0, 0, 1] }; };
  let gid = rod.addGrip({ nodes: [0, nCol], keepShape: true, frame: colFrame });
  let held = nCol;
  const snaps = [], log = [];
  const baked = bake(rod, {
    duration: DUR,
    script: (rr, t) => {
      // release the segments that have passed below the hand
      if (held === 0) return;
      const p = path(t);
      let k = held;
      while (k > 1 && rr.c[3 * (k - 1) + 1] < p[1]) k--;
      if (k !== held && gid) {
        rr.releaseGrip(gid);
        held = k;
        if (held * SEG > 0.3) gid = rr.addGrip({ nodes: [0, held], keepShape: true, frame: colFrame });
        else {
          // last 0.3 m: the hand keeps holding the end
          const pE = colFrame(t);
          gid = rr.addGrip({ nodes: [0, held], keepShape: true, frame: () => ({ p: pE.p, q: [0, 0, 0, 1] }) });
          held = 0;
        }
      }
    },
    onFrame: (rr, t, f) => {
      if (f % 60 === 0) log.push({ t: r4(t), laidSegments: rr.ns - held, Tw_laid: r4(rr.twistTurns(Math.max(held, 12), rr.ns - 1)), maxStrain: r4(rr.maxStrain()) });
      if ([1.5, 4, DUR].some((x) => Math.abs(x - t) < 1e-6)) snaps.push({ ...snap(sim, rr, name), caps: [] });
    },
  });
  result[name] = { nodes: rod.n, laidLength_m: r4((rod.ns - held) * SEG), final: log[log.length - 1], simSecondsPerWallSecond: r4(baked.stats.simSecondsPerWallSecond), log };
  console.log(name, JSON.stringify({ ...result[name], log: undefined }));
  const views = [{ name: 'top', target: [0, 0, 0.1], dist: 2.4, yaw: 0, pitch: 89, fov: 45, grid: 0.1, gridExtent: 1.2 }, { name: '3/4', target: [0, 0.2, 0.1], dist: 2.2, yaw: 35, pitch: 35, fov: 45, grid: 0.1, gridExtent: 1.2 }];
  render(`s5_${name}`, { title: `S5 heavy cable (Ø13 mm, 0.22 kg/m, EI 0.03, GJ 0.02) fed through a hand moving along ${name}`, radius: r, visScale: 1.2, views, snapshots: snaps, W: 380, H: 340 });
}
writeSummary('s5', result);
await close();
