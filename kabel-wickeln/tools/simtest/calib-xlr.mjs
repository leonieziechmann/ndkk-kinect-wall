// Calibration of the XLR preset (src/sim/cables.ts) against the user's drape photo: the cable
// hung over a finger (Ø ~17 mm), the plug end short (~6 cm of free cable, then the 20 g plug),
// the other leg long (to the floor). Measured in the photo (scale from the plug body, Ø 19 mm, and
// the folding rule): the two legs hang 5.3 cm apart centre to centre 3.5-4.2 cm below the top of
// the cable, and the bend at the top has a radius of 1.5-2.2 cm. For a range of EI the test
// drapes the cable the same way and measures the same numbers, elastic and with the preset's
// plastic memory, and for two lengths of the long leg (its weight pulls the bend tighter).
//   node tools/simtest/calib-xlr.mjs [EI,…]
// Output: output/simtest/calib-xlr.summary.json, calib-xlr.png

import { load, snap, render, writeSummary } from './lib.mjs';

const { mods: [sim], close } = await load('/src/sim/index.ts');
const { XLR, buildCable } = sim;

const FINGER_R = 0.0085, H = 1.0;
const PHOTO = { separation_cm: 5.3, at_cm: [3.5, 4.2], topRadius_cm: [1.5, 2.2] };

/** the cable over the finger: plug tip lower left, 6 cm of cable up, over the finger, down to the floor and `floor` m along it */
function drapePoints(hangToFloor = true, floor = 0.3, rightLeg = H) {
  const rc = XLR.od / 2, top = H + FINGER_R + rc, R = 0.02;
  const cy = top - R;
  const pts = [];
  const plugAndLeg = XLR.plug.length + 0.06;
  for (let y = cy - plugAndLeg; y < cy; y += 0.002) pts.push([-R, y, 0]);
  for (let a = Math.PI; a >= 0; a -= 0.02) pts.push([R * Math.cos(a), cy + R * Math.sin(a), 0]);
  const yEnd = hangToFloor ? rc : cy - rightLeg;
  for (let y = cy; y > yEnd; y -= 0.002) pts.push([R, y, 0]);
  if (hangToFloor) for (let x = R; x < R + floor; x += 0.002) pts.push([x, rc, 0]);
  return pts;
}

/** leg separation at depths below the top of the centreline, and the top radius */
function measure(rod) {
  const x = rod.x, n = rod.n;
  let top = 0;
  for (let i = 0; i < n; i++) if (x[3 * i + 1] > x[3 * top + 1]) top = i;
  const yTop = x[3 * top + 1], xTop = x[3 * top];
  const legX = (dir, depth) => {
    const y = yTop - depth;
    for (let i = top; i > 0 && i < n - 1; i += dir) {
      const j = i + dir, ya = x[3 * i + 1], yb = x[3 * j + 1];
      if ((ya - y) * (yb - y) <= 0 && ya !== yb) {
        const u = (y - ya) / (yb - ya);
        return x[3 * i] + (x[3 * j] - x[3 * i]) * u;
      }
    }
    return NaN;
  };
  const sep = PHOTO.at_cm.map((d) => legX(1, d / 100) - legX(-1, d / 100));
  // top radius: circle through the top and the points 1.4 cm to either side (horizontally)
  const atHalf = (dir, hw) => {
    for (let i = top; i > 0 && i < n - 1; i += dir) {
      const j = i + dir, xa = x[3 * i] - xTop, xb = x[3 * j] - xTop;
      if (Math.abs(xb) >= hw) {
        const u = (hw - Math.abs(xa)) / (Math.abs(xb) - Math.abs(xa));
        return yTop - (x[3 * i + 1] + (x[3 * j + 1] - x[3 * i + 1]) * u);
      }
    }
    return NaN;
  };
  const radius = (hw) => {
    const dy = (atHalf(1, hw) + atHalf(-1, hw)) / 2;
    return (hw * hw + dy * dy) / (2 * dy);
  };
  return { separation_cm: sep.map((v) => +(v * 100).toFixed(2)), topRadius_cm: [+(radius(0.009) * 100).toFixed(2), +(radius(0.014) * 100).toFixed(2)] };
}

function drape(EI, { plastic = false, floor = true, seconds = 4, leg = H } = {}) {
  const { rod } = buildCable(XLR, drapePoints(floor, 0.3, leg), { plugs: 'start', EI, GJ: 0.8 * EI, plastic: plastic ? { ...XLR.plastic } : null, groundY: floor ? 0 : null });
  rod.setCapsules([{ a: [0, H, -0.05], b: [0, H, 0.05], r: FINGER_R }]);
  const log = [];
  for (let f = 0; f < seconds * 60; f++) {
    rod.step(1 / 60, XLR.substeps);
    if ((f + 1) % 60 === 0) log.push({ t: +rod.time.toFixed(2), ...measure(rod) });
  }
  return { rod, final: measure(rod), log };
}

const EIs = (process.argv[2] ?? '3e-5,5e-5,7e-5,1e-4,1.3e-4,2e-3').split(',').map(Number);
const out = { photo: PHOTO, finger_r_m: FINGER_R, rows: [] };
const snaps = [];
for (const EI of EIs) {
  for (const plastic of [false, true]) {
    for (const leg of ['floor', 0.5]) {
      if (plastic && leg !== 'floor') continue;
      const r = drape(EI, { plastic, floor: leg === 'floor', leg: leg === 'floor' ? H : leg });
      const row = { EI, plastic, longLeg: leg === 'floor' ? '1 m to the floor' : `${leg} m hanging`, ...r.final, after1s: r.log[0] };
      out.rows.push(row);
      console.log(JSON.stringify(row));
      if (leg === 'floor' && (!plastic || EI === 1e-4)) snaps.push(snap(sim, r.rod, `EI ${EI}${plastic ? ' memory' : ''}`, {}));
    }
  }
}
const views = [{ name: 'front', target: [0, H - 0.06, 0], dist: 0.32, yaw: 0, pitch: 0, fov: 40, grid: 0.01, gridExtent: 0 }];
console.log(render('calib-xlr', { title: 'Drape over a finger (Ø 17 mm): photo legs 5.3 cm apart 3.5-4.2 cm below the top, top radius 1.5-2.2 cm', radius: XLR.od / 2, visScale: 1, views, snapshots: snaps.map((s) => ({ ...s, caps: [{ a: [0, H, -0.05], b: [0, H, 0.05], r: FINGER_R }] })), W: 240, H: 300 }));
writeSummary('calib-xlr', out);
await close();
