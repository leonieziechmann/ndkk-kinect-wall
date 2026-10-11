// Fitting the "dead" cable model (rod.ts plastic + damping) to what is known about the user's XLR:
// the drape photo, round hanging loops (videos), free fall, a stub held out horizontally, a swing.
// One parameter set per run, given as JSON overrides of the XLR preset's rod options:
//   P='{"plastic":{"frictionEI":1e-3,"yieldMoment":2e-3,"rate":20}}' node tools/simtest/model-fit.mjs [stub,drape,loop,fall,swing]
// Prints one JSON line per test (used to choose the preset values in src/sim/cables.ts).

import { load } from './lib.mjs';

const { mods: [sim], close } = await load('/src/sim/index.ts');
const { XLR, buildCable, gripFrame } = sim;
const P = JSON.parse(process.env.P ?? '{}');
const SEG = +(process.env.SEG ?? XLR.segment);
const SUB = +(process.env.SUB ?? XLR.substeps);
const parts = (process.argv[2] ?? 'stub,drape,loop,fall,swing').split(',');
const r3 = (v) => +(+v).toFixed(3);
const RC = XLR.od / 2;
const line = (a, b, n = 200) => Array.from({ length: n + 1 }, (_, i) => [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n, a[2] + (b[2] - a[2]) * i / n]);
const minJerk = (u) => { const x = Math.min(1, Math.max(0, u)); return x * x * x * (10 - 15 * x + 6 * x * x); };
const build = (pts, o = {}) => buildCable(XLR, pts, { segment: SEG, ...P, ...o });
const straightMemory = (rod) => { rod.restFric.fill(0); rod.setRestStraight(); };

if (parts.includes('stub')) {
  for (const L of [0.15, 0.3]) {
    const { rod } = build(line([-0.03, 1, 0], [L, 1, 0], 100), { plugs: 'none', groundY: null, coilMemory: 0 });
    straightMemory(rod);
    const hold = rod.bundle({ frame: gripFrame([0, 1, 0], [1, 0, 0], [0, 1, 0]), blend: 0.001 });
    hold.add(0, 0.03, 0.001);
    const out = {};
    const at = [0.25, 0.5, 1, 2, 5, 10, 20];
    for (let f = 1; f <= 60 * 20; f++) {
      rod.step(1 / 60, SUB);
      const t = f / 60;
      if (at.some((a) => Math.abs(a - t) < 1e-6)) out[`${t}s`] = r3((1 - rod.x[3 * (rod.n - 1) + 1]) * 100);
    }
    console.log(JSON.stringify({ test: `stub${L * 100}cm_droop_cm`, ...out }));
  }
}

if (parts.includes('drape')) {
  const FR = 0.0085, H = 1, top = H + FR + RC, R = 0.02, cy = top - R;
  const pts = [];
  for (let y = cy - XLR.plug.length - 0.06; y < cy; y += 0.002) pts.push([-R, y, 0]);
  for (let a = Math.PI; a >= 0; a -= 0.02) pts.push([R * Math.cos(a), cy + R * Math.sin(a), 0]);
  for (let y = cy; y > RC; y -= 0.002) pts.push([R, y, 0]);
  for (let x = R; x < R + 0.3; x += 0.002) pts.push([x, RC, 0]);
  const { rod, cable } = build(pts, { plugs: 'start', coilMemory: 0 });
  straightMemory(rod);
  rod.setCapsules([{ a: [0, H, -0.05], b: [0, H, 0.05], r: FR }]);
  const c0 = cable[0];
  const meas = () => {
    const x = rod.x, n = rod.n;
    let tp = 0;
    for (let i = 0; i < n; i++) if (x[3 * i + 1] > x[3 * tp + 1]) tp = i;
    const yTop = x[3 * tp + 1];
    const legX = (dir, depth) => {
      const y = yTop - depth;
      for (let i = tp; i > 0 && i < n - 1; i += dir) {
        const j = i + dir, ya = x[3 * i + 1], yb = x[3 * j + 1];
        if ((ya - y) * (yb - y) <= 0 && ya !== yb) return x[3 * i] + (x[3 * j] - x[3 * i]) * ((y - ya) / (yb - ya));
      }
      return NaN;
    };
    const sep = [0.035, 0.042].map((d) => r3((legX(1, d) - legX(-1, d)) * 100));
    const dx = x[3 * c0] - x[0], dy = x[3 * c0 + 1] - x[1];
    return { sep, plugDeg: r3((Math.atan2(Math.abs(dx), Math.abs(dy)) * 180) / Math.PI) };
  };
  const out = {};
  for (let f = 1; f <= 600; f++) {
    rod.step(1 / 60, SUB);
    if ([30, 60, 120, 240, 600].includes(f)) out[`${f / 60}s`] = meas();
  }
  console.log(JSON.stringify({ test: 'drape (photo: sep ~5 cm, plug vertical)', ...out }));
}

if (parts.includes('loop')) {
  // a 0.8 m loop hanging from a fist (both ends held, 4 cm each), formed round; memory round (a used
  // cable coiled like this) or straight (a new cable)
  const Rl = 0.8 / (2 * Math.PI);
  for (const mem of ['round', 'straight']) {
    const pts = [];
    for (let a = -0.3; a <= 2 * Math.PI + 0.3; a += 0.01) pts.push([Rl * Math.sin(a), 1 - Rl + Rl * Math.cos(a), 0.0068 * a / (2 * Math.PI)]);
    const { rod } = build(pts, { plugs: 'none', groundY: null, coilMemory: 0 });
    if (mem === 'round') rod.setRestFromCurrent(); else straightMemory(rod);
    if (mem === 'round') { rod.setRestStraight(); }
    const fist = gripFrame([0, 1, 0], [1, 0, 0], [0, 1, 0]);
    const b = rod.bundle({ frame: fist, hand: 0, blend: 0.001 });
    const end = rod.totalLength;
    b.add(0, 0.035, 0.001);
    b.add(end - 0.035, end, 0.001);
    const out = {};
    for (let f = 1; f <= 600; f++) {
      rod.step(1 / 60, SUB);
      if ([30, 60, 180, 600].includes(f)) {
        const mn = [9, 9, 9], mx = [-9, -9, -9];
        for (let i = 0; i < rod.n; i++) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], rod.x[3 * i + k]); mx[k] = Math.max(mx[k], rod.x[3 * i + k]); }
        out[`${f / 60}s`] = { w: r3((mx[0] - mn[0]) * 100), h: r3((mx[1] - mn[1]) * 100), aspect: r3((mx[0] - mn[0]) / (mx[1] - mn[1])) };
      }
    }
    console.log(JSON.stringify({ test: `loop0.8m memory ${mem} (round: 25x25)`, ...out }));
  }
}

if (parts.includes('fall')) {
  const { rod } = build(line([-0.5, 1.0, 0], [0.5, 1.0, 0]), { plugs: 'both' });
  let t = 0, hit = null;
  const mid = Math.floor(rod.n / 2);
  while (t < 2 && hit === null) {
    rod.step(1 / 60, SUB); t += 1 / 60;
    if (rod.x[3 * mid + 1] < 0.1) hit = t;
  }
  console.log(JSON.stringify({ test: 'fall 0.9 m', t: r3(hit), free: r3(Math.sqrt(1.8 / 9.81)) }));
}

if (parts.includes('swing')) {
  // 1 m hanging from a held pinch, plug at the bottom; the hand moves 15 cm in 0.25 s and stops
  const { rod } = build(line([0, 1.3, 0], [0, 0.3, 0]), { plugs: 'end' });
  const hand = (t) => gripFrame([0.15 * minJerk((t - 0.5) / 0.25), 1.3, 0], [0, -1, 0], [1, 0, 0]);
  rod.pinch({ frame: hand, blend: 0.01 });
  const xs = [];
  for (let f = 0; f < 300; f++) { rod.step(1 / 60, SUB); xs.push(rod.x[3 * (rod.n - 1)]); }
  const ext = [];
  for (let i = 46; i < xs.length - 1; i++) if ((xs[i] - xs[i - 1]) * (xs[i + 1] - xs[i]) < 0) ext.push(r3((xs[i] - 0.15) * 100));
  let settle = null;
  for (let i = 45; i < xs.length; i++) if (xs.slice(i).every((v) => Math.abs(v - 0.15) < 0.01)) { settle = r3((i - 45) / 60); break; }
  console.log(JSON.stringify({ test: 'swing 1 m, hand 15 cm in 0.25 s', bottomExtrema_cm: ext.slice(0, 6), within1cm_after_s: settle }));
}

await close();
