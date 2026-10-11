// S2 (prototype scenario): a straight cable, both ends gripped; the right grip twists 3 (or 6)
// turns about the cable axis, then the grips approach: the stored twist turns into writhe (loops,
// plectoneme). Lk = Tw + Wr must stay at the number of turns.
//   VARIANTS=xlr3,xlr6,usb3,xlr3zeroG node tools/simtest/s2_twist.mjs

import { load, snap, render, writeSummary, smooth, r4 } from './lib.mjs';

const { mods: [sim], close } = await load('/src/sim/index.ts');
const { Rod, bake, quatFromAxisAngle } = sim;
const N = 151, L = 1.5, H = 1.0;
const XLR = { radius: 0.0035, linearDensity: 0.05, EI: 2e-3, GJ: 1.5e-3 };
const USB = { radius: 0.002, linearDensity: 0.02, EI: 4e-4, GJ: 3e-4 };
const DEFS = { xlr3: { cable: XLR, turns: 3 }, xlr6: { cable: XLR, turns: 6 }, usb3: { cable: USB, turns: 3 }, xlr3zeroG: { cable: XLR, turns: 3, zeroG: true } };
const variants = (process.env.VARIANTS || 'xlr3,xlr6,usb3,xlr3zeroG').split(',');
const result = {};
for (const variant of variants) {
  const def = DEFS[variant], TURNS = def.turns;
  const rod = Rod.straight([-L / 2, H, 0], [L / 2, H, 0], N, { ...def.cable, gravity: def.zeroG ? [0, 0, 0] : [0, -9.81, 0], damping: 1.0 });
  const tTwist = 1.5, tApproach = 2.0, endGap = 0.35;
  const xpos = (sgn, t) => sgn * (L / 2 - 0.01 - (L / 2 - endGap / 2) * smooth((t - tTwist - 0.2) / tApproach));
  rod.addGrip({ nodes: [0, 2], keepShape: true, frame: (t) => ({ p: [xpos(-1, t), H, 0], q: [0, 0, 0, 1] }) });
  rod.addGrip({ nodes: [N - 3, N - 1], keepShape: true, frame: (t) => ({ p: [xpos(1, t), H, 0], q: quatFromAxisAngle(1, 0, 0, TURNS * 2 * Math.PI * smooth(t / tTwist)) }) });
  const snaps = [], log = [];
  let minLk = Infinity, maxLk = -Infinity, maxWr = 0;
  const baked = bake(rod, {
    duration: 4.5,
    onFrame: (r, t, f) => {
      if (f % 15 === 0) {
        const tw = r.twistTurns(), wr = r.writhe();
        if (t > 1.5) { minLk = Math.min(minLk, tw + wr); maxLk = Math.max(maxLk, tw + wr); }
        maxWr = Math.max(maxWr, Math.abs(wr));
        log.push({ t: r4(t), Tw: r4(tw), Wr: r4(wr), Lk: r4(tw + wr), contacts: r.stats.contacts });
      }
      if ([1.5, 2.6, 3.2, 4.5].some((x) => Math.abs(x - t) < 1e-6)) snaps.push(snap(sim, r, variant));
    },
  });
  result[variant] = { turns: TURNS, final: log[log.length - 1], LkRangeAfterTwist: [r4(minLk), r4(maxLk)], maxAbsWr: r4(maxWr), maxStrain: r4(rod.maxStrain()), crossings: rod.stats.crossings, simSecondsPerWallSecond: r4(baked.stats.simSecondsPerWallSecond), log: log.filter((_, i) => i % 2 === 0) };
  console.log(variant, JSON.stringify({ ...result[variant], log: undefined }));
  const views = [{ name: 'front', target: [0, H - 0.25, 0], dist: 1.6, yaw: 0, pitch: 8, fov: 45 }, { name: '3/4', target: [0, H - 0.25, 0], dist: 1.6, yaw: 40, pitch: 30, fov: 45 }];
  render(`s2_${variant}`, { title: `S2 ${variant}: 1.5 m cable, right hand twists ${TURNS} turns (0-1.5 s), hands approach to ${endGap} m (1.7-3.7 s). red stripe = d1`, radius: def.cable.radius, visScale: 2, views, snapshots: snaps, W: 360, H: 300 });
}
writeSummary(`s2${process.env.VARIANTS ? '-' + variants.join('-') : ''}`, result);
await close();
