// Numeric test of the grips (src/people/body/hand.ts) and the hand colliders (src/people/colliders.ts):
//   node tools/simtest/ik-hands.mjs
// For Noor's right hand pinching an XLR cable (roll -90° … 90°, open 0 … 1) and her left hand holding
// a coil (bundle radius 0.5 … 3 cm), solved through rigPose:
//   - thumb: does the thumb tip reach where the grip puts it (mm)?
//   - pinch: the cable axis over ±1 cm around the grip point, its distance to every hand capsule minus
//     both radii (mm; < 0 = the cable cuts into the hand). The pads (thumb tip, index finger) touch the
//     cable in a closed pinch (≈ 0), everything else must stay clear.
//   - coil: the bundle's axis over the width of the hand, the same against every capsule.
//   - the reached grip frame against the asked one (position mm, cable direction deg).
// Writes output/simtest/ik-hands.json.

import fs from 'node:fs';
import path from 'node:path';
import { load, OUT } from './lib.mjs';

const { mods, close } = await load('/src/people/rig.ts', '/src/people/cast.ts', '/src/people/colliders.ts', '/src/people/body/hand.ts', '/src/people/math.ts');
const [rig, cast, col, hand, m] = mods;
const DEG = Math.PI / 180;
const XLR = 0.0032;

/** distance between segments p0-p1 and q0-q1 (sampled finely; the segments are short) */
function segDist(p0, p1, q0, q1) {
  let best = Infinity;
  for (let i = 0; i <= 30; i++) {
    const a = m.mix3(p0, p1, i / 30);
    for (let j = 0; j <= 30; j++) best = Math.min(best, m.len(m.sub(a, m.mix3(q0, q1, j / 30))));
  }
  return best;
}

function clearance(caps, a, b, r) {
  const out = {};
  for (const c of caps) {
    const key = c.part + (c.pad ? '(pad)' : '');
    const d = segDist(a, b, c.a, c.b) - c.r - r;
    out[key] = Math.min(out[key] ?? Infinity, d);
  }
  return out;
}

const base = { ...rig.stand(cast.NOOR, [0, 0], 0, { width: 0.3 }), lean: 0.04 };
const rows = [];

// the pinch
const pinchGrip = rig.gripFrame([0.05, 0.92, -0.32], m.norm([-1, -0.3, -0.35]), [0, 0, 1]);
for (const roll of [-90, -45, 0, 45, 90]) {
  for (const open of [0, 0.5, 1]) {
    const h = { grip: pinchGrip, hold: 'pinch', radius: XLR, roll: roll * DEG, open, free: 1, prefer: [{ hand: [0, 0, 1], world: [0, 1, 0], weight: 0.3 }] };
    const pose = rig.rigPose(cast.NOOR, { ...base, hands: [null, h] });
    const arm = pose.body.arms[1];
    const hp = pose.body.hands[1];
    const g = arm.grip;
    const [, , d3] = m.quatCols(g.q);
    const shape = rig.gripShape(cast.NOOR, 1, h);
    const thumb = hand.thumbChain(shape.thumb, shape.thumbDir);
    const tipErr = m.len(m.sub(thumb[3], shape.thumb)) * hp.q;
    const caps = col.handColliders(pose, 1, { forearm: true });
    const cl = clearance(caps, m.madd(g.p, d3, -0.01), m.madd(g.p, d3, 0.01), XLR);
    const [, , a3] = m.quatCols(pinchGrip.q);
    rows.push({
      grip: 'pinch', roll, open,
      thumbTipMm: +(tipErr * 1000).toFixed(2),
      padsMm: +(Math.min(cl['thumb(pad)'] ?? Infinity, cl['index(pad)'] ?? Infinity) * 1000).toFixed(2),
      othersMm: +(Math.min(...Object.entries(cl).filter(([k]) => !k.includes('pad')).map(([, v]) => v)) * 1000).toFixed(2),
      worst: Object.entries(cl).filter(([k]) => !k.includes('pad')).sort((x, y) => x[1] - y[1])[0][0],
      gripPosMm: +(m.len(m.sub(g.p, pinchGrip.p)) * 1000).toFixed(2),
      cableDirDeg: +(Math.acos(Math.min(1, m.dot(d3, a3))) / DEG).toFixed(2),
    });
  }
}

// the coil
for (const R of [0.005, 0.008, 0.012, 0.016, 0.022, 0.03]) {
  const grip = rig.gripFrame([-0.1, 0.92, -0.3], m.norm([0.1, 0.4, -1]), [-1, 0.1, 0]);
  const h = { grip, hold: 'coil', radius: R, free: 0.6 };
  const pose = rig.rigPose(cast.NOOR, { ...base, hands: [h, null] });
  const arm = pose.body.arms[0];
  const g = arm.grip;
  const [, , d3] = m.quatCols(g.q);
  const shape = rig.gripShape(cast.NOOR, -1, h);
  const hp = pose.body.hands[0];
  const thumb = hand.thumbChain(shape.thumb, shape.thumbDir);
  const caps = col.handColliders(pose, 0, { forearm: true });
  // the bundle runs across the hand: ±6 cm around the grip point
  const cl = clearance(caps, m.madd(g.p, d3, -0.06), m.madd(g.p, d3, 0.06), R);
  const [, , a3] = m.quatCols(grip.q);
  rows.push({
    grip: 'coil', R,
    thumbTipMm: +(m.len(m.sub(thumb[3], shape.thumb)) * hp.q * 1000).toFixed(2),
    thumbMm: +(cl.thumb * 1000).toFixed(2),
    fingersMm: +(Math.min(cl.index, cl.middle, cl.ring, cl.little) * 1000).toFixed(2),
    palmMm: +(cl.palm * 1000).toFixed(2),
    gripPosMm: +(m.len(m.sub(g.p, grip.p)) * 1000).toFixed(2),
    bundleDirDeg: +(Math.acos(Math.min(1, m.dot(d3, a3))) / DEG).toFixed(2),
  });
}

for (const r of rows) console.log(JSON.stringify(r));
fs.writeFileSync(path.join(OUT, 'ik-hands.json'), JSON.stringify(rows, null, 1));
await close();
