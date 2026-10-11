// Calibration of the XLR preset (src/sim/cables.ts) against the user's drape photo: the cable
// hung over a finger (Ø ~17 mm), the plug end short (~6 cm of free cable, then the 20 g plug), the
// other leg long (to the floor). Measured in the photo (scale from the plug body, Ø 19 mm, and the
// folding rule; the rule is a little nearer the camera): the legs hang 5.3 cm apart centre to
// centre 3.5-4.2 cm below the top of the cable (4.5-4.8 cm read off the rule), and the bend at
// the top has a radius of 1.5-2.2 cm.
//
// Two models:
//   - elastic: one bending stiffness EI, no memory. The fit is EI ≈ 1.3e-4 N m², but then a loop
//     of 30 cm hangs as a narrow teardrop (w R³ / EI ≈ 13), not round as in the user's videos.
//   - the preset: strand friction (opts.plastic, a stiff element frictionEI that slips beyond a
//     yield curvature and creeps). The cable was straight before it was hung over the finger: the
//     drape starts with a straight memory, so it is wider at first and creeps narrower; it matches
//     the photo a few seconds after hanging with EI (strands slipping) ≈ 1.0e-4 N m².
// The separation is printed over 10 s for each.
//   node tools/simtest/calib-xlr.mjs
// Output: output/simtest/calib-xlr.summary.json, calib-xlr.png

import { load, snap, render, writeSummary } from './lib.mjs';

const { mods: [sim], close } = await load('/src/sim/index.ts');
const { XLR, buildCable } = sim;

const FINGER_R = 0.0085, H = 1.0;
const PHOTO = { separation_cm: 5.3, at_cm: [3.5, 4.2], topRadius_cm: [1.5, 2.2] };
const RC = XLR.od / 2;

/** the cable over the finger: plug tip lower left, 6 cm of cable up, over the finger, down to the floor and 30 cm along it */
function drapePoints() {
  const top = H + FINGER_R + RC, R = 0.02, cy = top - R;
  const pts = [];
  for (let y = cy - XLR.plug.length - 0.06; y < cy; y += 0.002) pts.push([-R, y, 0]);
  for (let a = Math.PI; a >= 0; a -= 0.02) pts.push([R * Math.cos(a), cy + R * Math.sin(a), 0]);
  for (let y = cy; y > RC; y -= 0.002) pts.push([R, y, 0]);
  for (let x = R; x < R + 0.3; x += 0.002) pts.push([x, RC, 0]);
  return pts;
}

/** leg separation at depths below the top of the centre line [cm], and the top radius [cm] */
function measure(rod) {
  const x = rod.x, n = rod.n;
  let top = 0;
  for (let i = 0; i < n; i++) if (x[3 * i + 1] > x[3 * top + 1]) top = i;
  const yTop = x[3 * top + 1], xTop = x[3 * top];
  const legX = (dir, depth) => {
    const y = yTop - depth;
    for (let i = top; i > 0 && i < n - 1; i += dir) {
      const j = i + dir, ya = x[3 * i + 1], yb = x[3 * j + 1];
      if ((ya - y) * (yb - y) <= 0 && ya !== yb) return x[3 * i] + (x[3 * j] - x[3 * i]) * ((y - ya) / (yb - ya));
    }
    return NaN;
  };
  // top radius: circle through the top and the points 1.4 cm to either side (horizontally)
  const dyAt = (dir, hw) => {
    for (let i = top; i > 0 && i < n - 1; i += dir) {
      const j = i + dir, xa = Math.abs(x[3 * i] - xTop), xb = Math.abs(x[3 * j] - xTop);
      if (xb >= hw) return yTop - (x[3 * i + 1] + (x[3 * j + 1] - x[3 * i + 1]) * ((hw - xa) / (xb - xa)));
    }
    return NaN;
  };
  const dy = (dyAt(1, 0.014) + dyAt(-1, 0.014)) / 2;
  return {
    separation_cm: PHOTO.at_cm.map((d) => +((legX(1, d / 100) - legX(-1, d / 100)) * 100).toFixed(2)),
    topRadius_cm: +(((0.014 ** 2 + dy * dy) / (2 * dy)) * 100).toFixed(2),
  };
}

function drape(o) {
  const { rod } = buildCable(XLR, drapePoints(), { plugs: 'start', ...o });
  // a straight cable hung over the finger: natural rest and memory straight
  rod.restFric.fill(0);
  rod.setRestStraight();
  rod.setCapsules([{ a: [0, H, -0.05], b: [0, H, 0.05], r: FINGER_R }]);
  const log = {};
  for (let f = 1; f <= 600; f++) {
    rod.step(1 / 60, XLR.substeps);
    if ([30, 60, 180, 300, 600].includes(f)) log[`${f / 60}s`] = measure(rod);
  }
  return { rod, log };
}

const runs = [
  { name: 'EI 2e-3 (the first coiling bake), elastic', o: { EI: 2e-3, GJ: 1.5e-3, plastic: null } },
  { name: 'elastic EI 1.0e-4', o: { EI: 1e-4, GJ: 8e-5, plastic: null } },
  { name: 'elastic EI 1.3e-4', o: { EI: 1.3e-4, GJ: 1e-4, plastic: null } },
  { name: 'elastic EI 1.6e-4', o: { EI: 1.6e-4, GJ: 1.3e-4, plastic: null } },
  { name: 'preset (EI 1.0e-4 + strand friction)', o: {} },
  { name: 'preset with EI 1.3e-4', o: { EI: 1.3e-4, GJ: 1e-4 } },
];
const out = { photo: PHOTO, finger_r_m: FINGER_R, preset: { EI: XLR.EI, GJ: XLR.GJ, plastic: XLR.plastic }, rows: [] };
const snaps = [];
for (const r of runs) {
  const { rod, log } = drape(r.o);
  out.rows.push({ name: r.name, ...log });
  console.log(r.name.padEnd(40), Object.entries(log).map(([t, m]) => `${t}: ${m.separation_cm.join('/')} cm, R ${m.topRadius_cm}`).join(' | '));
  snaps.push(snap(sim, rod, r.name, { caps: [{ a: [0, H, -0.05], b: [0, H, 0.05], r: FINGER_R }] }));
}
const views = [{ name: 'front', target: [0, 0.95, 0], dist: 0.4, yaw: 0, pitch: 0, fov: 40, grid: 0.01, gridExtent: 0 }];
console.log(render('calib-xlr', { title: 'Drape over a finger after 10 s (photo: legs 5.3 cm apart 3.5-4.2 cm below the top, top radius 1.5-2.2 cm)', radius: RC, visScale: 1, views, snapshots: snaps, W: 230, H: 300 }));
writeSummary('calib-xlr', out);
await close();
