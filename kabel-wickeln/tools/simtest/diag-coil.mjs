// Diagnosis of the first coiling bake (src/shots/s1-coil.ts, the version the user rejected as
// "floppy"): runs the shot with its own settings and measures, per frame, how violently the free
// cable moves (node accelerations seen at 60 fps), kinks (joint angles), twist rates and joint
// gaps, and lists them around the grip, release and placing events. Also: where the cable was when
// a grip took it (how far the grip pulled it into the hand), and how hard the guides pull: per
// substep the force each guide applies to a node at the start of its solve, |x - target| /
// compliance × weight, against the weight of that node (m g).
//   node tools/simtest/diag-coil.mjs            (~6 min)
// Output: output/simtest/diag-coil.summary.json

import { load, writeSummary } from './lib.mjs';

const { mods: [shots, coil, sim], close } = await load('/src/shots/index.ts', '/src/shots/s1-coil.ts', '/src/sim/index.ts');
// every guide's pull: wrap the target functions (called once per node and substep)
const guideForce = { max: 0, sum: 0, n: 0, maxAt: -1 };
const addGuide0 = sim.Rod.prototype.addGuide;
sim.Rod.prototype.addGuide = function (spec) {
  let wt = -1, w = 1;
  const target = (i, t) => {
    const p = spec.target(i, t);
    if (p) {
      if (t !== wt) { w = spec.weight ? spec.weight(t) : 1; wt = t; }
      if (w > 1e-6) {
        const x = this.x, F = Math.hypot(x[3 * i] - p[0], x[3 * i + 1] - p[1], x[3 * i + 2] - p[2]) * w / spec.compliance;
        guideForce.sum += F; guideForce.n++;
        if (F > guideForce.max) { guideForce.max = F; guideForce.maxAt = i; }
      }
    }
    return p;
  };
  return addGuide0.call(this, { ...spec, target });
};
const def = shots.SHOTS['s1-coil'];
const { COIL1, nodeAt } = coil;

const { rod, script } = def.build();
rod.opts.iterations = def.iterations ?? rod.opts.iterations;
const fps = def.fps ?? 60, sub = def.substeps ?? 30;
const F = Math.round(def.duration * fps) + 1;
const n = rod.n, ns = rod.ns;
const X = [new Float64Array(3 * n), new Float64Array(3 * n), new Float64Array(3 * n)];
const g = 9.81;
const frames = [];
const teleports = [];
const beats = COIL1.beats;
const t0 = performance.now();
for (let f = 0; f < F; f++) {
  const t = rod.time;
  // where the cable is when a grip takes it vs where the grip frame wants it
  for (const b of beats) {
    if (Math.abs(t - b.tClose) < 0.5 / fps) {
      const i = nodeAt(b.sGrip), p = COIL1.right(t).cable.p;
      teleports.push({ k: b.k, event: 'right grip closes', t: +t.toFixed(3), node: i, cableToFrame_mm: +(1000 * Math.hypot(rod.x[3 * i] - p[0], rod.x[3 * i + 1] - p[1], rod.x[3 * i + 2] - p[2])).toFixed(1) });
    }
  }
  script?.(rod, t, f);
  if (f > 0) rod.step(1 / fps, sub);
  else rod.sync();
  X[0].set(X[1]); X[1].set(X[2]); X[2].set(rod.x);
  if (f < 2) continue;
  // free nodes: not next to a held segment, not lying on the floor
  const held = new Set(rod.heldSegments());
  let aMax = 0, aMaxNode = -1, vMax = 0, ke = 0;
  const acc = [];
  for (let i = 0; i < n; i++) {
    if (held.has(i) || held.has(i - 1) || held.has(i + 1) || held.has(i - 2)) continue;
    if (rod.x[3 * i + 1] < rod.rc + 0.004) continue;
    let a2 = 0, v2 = 0;
    for (let k = 0; k < 3; k++) {
      const a = (X[2][3 * i + k] - 2 * X[1][3 * i + k] + X[0][3 * i + k]) * fps * fps;
      const v = (X[2][3 * i + k] - X[1][3 * i + k]) * fps;
      a2 += a * a; v2 += v * v;
    }
    const a = Math.sqrt(a2);
    acc.push(a);
    if (a > aMax) { aMax = a; aMaxNode = i; }
    vMax = Math.max(vMax, Math.sqrt(v2));
    ke += 0.5 * rod.m[Math.min(i, ns - 1)] * v2;
  }
  acc.sort((p, q) => p - q);
  // kinks: angle between neighbouring segment tangents on free joints
  let kMax = 0, kinks = 0, twistRate = 0;
  for (let k = 0; k < ns - 1; k++) {
    if (held.has(k) || held.has(k + 1)) continue;
    const d = rod.d3;
    const c = d[3 * k] * d[3 * k + 3] + d[3 * k + 1] * d[3 * k + 4] + d[3 * k + 2] * d[3 * k + 5];
    const ang = Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
    kMax = Math.max(kMax, ang);
    if (ang > 20) kinks++;
  }
  for (let j = 0; j < ns; j++) {
    if (held.has(j)) continue;
    const w = rod.om[3 * j] * rod.d3[3 * j] + rod.om[3 * j + 1] * rod.d3[3 * j + 1] + rod.om[3 * j + 2] * rod.d3[3 * j + 2];
    twistRate = Math.max(twistRate, Math.abs(w));
  }
  const nodeWeight = rod.m[0] * g;
  const gF = { guideMax_xWeight: guideForce.max / nodeWeight, guideMean_xWeight: guideForce.n ? guideForce.sum / guideForce.n / nodeWeight : 0, guideNode: guideForce.maxAt };
  guideForce.max = 0; guideForce.sum = 0; guideForce.n = 0; guideForce.maxAt = -1;
  frames.push({ ...gF,
    t: +rod.time.toFixed(4), aMax_g: aMax / g, aMaxNode, a99_g: (acc[Math.floor(acc.length * 0.99)] ?? 0) / g, a90_g: (acc[Math.floor(acc.length * 0.9)] ?? 0) / g,
    vMax, ke_mJ: ke * 1000, kinkMax_deg: kMax, kinks, twistRate_turnsPerS: twistRate / (2 * Math.PI), gap_mm: rod.maxStrain() * rod.L[0] * 1000,
  });
  if (f % 120 === 0) console.log(`t ${rod.time.toFixed(2)}  ${((performance.now() - t0) / 1000).toFixed(0)} s`);
}

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * p)]; };
const col = (k) => frames.map((r) => r[k]);
const window = (ta, tb) => frames.filter((r) => r.t >= ta && r.t <= tb);
const peak = (rows, k) => rows.reduce((m, r) => (r[k] > m[k] ? r : m), rows[0]);
const events = [];
for (const b of beats) {
  for (const [name, te] of [['take/slide', b.tSlide], ['right grip closes', b.tClose], ['return', b.tRet], ['loop placed (left regrip, rollOut, guide removals)', b.tPlace], ['right hand opens', b.tOpen]]) {
    const w = window(te - 0.05, te + 0.5);
    if (!w.length) continue;
    const pa = peak(w, 'aMax_g'), pk = peak(w, 'kinkMax_deg'), pt = peak(w, 'twistRate_turnsPerS'), pg = peak(w, 'guideMax_xWeight');
    events.push({ loop: b.k, kind: b.kind, event: name, t: +te.toFixed(2), aMax_g: +pa.aMax_g.toFixed(1), at: pa.t, node: pa.aMaxNode, a99_g: +peak(w, 'a99_g').a99_g.toFixed(2), kinkMax_deg: +pk.kinkMax_deg.toFixed(0), twistRateMax_turnsPerS: +pt.twistRate_turnsPerS.toFixed(1), keMax_mJ: +peak(w, 'ke_mJ').ke_mJ.toFixed(1), guideMax_xWeight: +pg.guideMax_xWeight.toFixed(0) });
  }
}
const out = {
  settings: { nodes: n, seg_m: rod.L[0], fps, substeps: sub, iterations: rod.opts.iterations, EI: rod.opts.EI, GJ: rod.opts.GJ, linearDensity: rod.opts.linearDensity, damping: rod.opts.damping, angularDamping: rod.opts.angularDamping, internalDamping: rod.opts.internalDamping },
  wallSeconds: +((performance.now() - t0) / 1000).toFixed(1),
  overall: {
    aMax_g: { median: +pct(col('aMax_g'), 0.5).toFixed(2), p90: +pct(col('aMax_g'), 0.9).toFixed(2), max: +Math.max(...col('aMax_g')).toFixed(1) },
    a99_g: { median: +pct(col('a99_g'), 0.5).toFixed(2), p90: +pct(col('a99_g'), 0.9).toFixed(2) },
    kinkMax_deg: { median: +pct(col('kinkMax_deg'), 0.5).toFixed(0), p90: +pct(col('kinkMax_deg'), 0.9).toFixed(0), max: +Math.max(...col('kinkMax_deg')).toFixed(0) },
    framesWithKinks: frames.filter((r) => r.kinks > 0).length, frames: frames.length,
    twistRate_turnsPerS: { median: +pct(col('twistRate_turnsPerS'), 0.5).toFixed(2), p90: +pct(col('twistRate_turnsPerS'), 0.9).toFixed(2), max: +Math.max(...col('twistRate_turnsPerS')).toFixed(1) },
    gap_mm: { median: +pct(col('gap_mm'), 0.5).toFixed(2), max: +Math.max(...col('gap_mm')).toFixed(2) },
    guideMax_xWeight: { median: +pct(col('guideMax_xWeight'), 0.5).toFixed(0), p90: +pct(col('guideMax_xWeight'), 0.9).toFixed(0), max: +Math.max(...col('guideMax_xWeight')).toFixed(0) },
    guideMean_xWeight: { median: +pct(col('guideMean_xWeight'), 0.5).toFixed(1), p90: +pct(col('guideMean_xWeight'), 0.9).toFixed(1) },
    framesWithGuidesAbove10xWeight: frames.filter((r) => r.guideMax_xWeight > 10).length,
  },
  teleports, events,
};
console.log(JSON.stringify(out, null, 1));
writeSummary('diag-coil', { ...out, frames: frames.filter((_, i) => i % 3 === 0) });
await close();
