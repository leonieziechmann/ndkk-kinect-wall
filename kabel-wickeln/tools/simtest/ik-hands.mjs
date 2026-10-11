// Numeric test of the grips (src/people/body/hand.ts) and the hand colliders (src/people/colliders.ts):
//   node tools/simtest/ik-hands.mjs
// Everything is solved through rigPose (arm IK included), Noor and Kofi, bare hands:
//   - pinch (XLR, r 3.2 mm; roll -90° … 90°, open 0 … 1): the cable axis over ±1 cm around the
//     grip point against every capsule (distance minus both radii, mm; < 0 = the cable cuts into the
//     hand). The pads (thumb tip, index middle bone) touch the cable in a closed pinch (≈ 0); every
//     other capsule must stay clear. Does the thumb tip reach where the grip puts it?
//   - roll contract: rolling by θ turns the reached cable frame (arms[i].grip) against the pads'
//     frame (arms[i].pads) by exactly θ about d3, for both hands and free 0 / 0.5 / 1, and the hand
//     itself (pads) does not turn with it.
//   - coil (bundle radius 5 … 30 mm) and fist (cable or bundle radius 3.2 … 30 mm, thumb wrap 0 … 1):
//     the held axis over the width of the hand against every capsule; the thumb must stay outside.
//   - the collider list: always 22 capsules in the order of HAND_PARTS; disable keeps the slots.
// Asserts (exit 1 on failure): non-pad capsules ≥ -0.5 mm from the held cable or bundle, the thumb
// ≥ -0.5 mm, pads within ±0.6 mm in a closed pinch, roll exact within 0.5°, the hand turning ≤ 5°.
// Writes output/simtest/ik-hands.json.

import fs from 'node:fs';
import path from 'node:path';
import { load, OUT } from './lib.mjs';

const { mods, close } = await load('/src/people/rig.ts', '/src/people/cast.ts', '/src/people/colliders.ts', '/src/people/body/hand.ts', '/src/people/math.ts');
const [rig, cast, col, hand, m] = mods;
const DEG = Math.PI / 180;
const XLR = 0.0032;
const fails = [];

/** distance between segments p0-p1 and q0-q1 (sampled on the first, exact on the second) */
function segDist(p0, p1, q0, q1) {
  let best = Infinity;
  const d = m.sub(q1, q0), l2 = m.dot(d, d) || 1;
  for (let i = 0; i <= 60; i++) {
    const a = m.mix3(p0, p1, i / 60);
    const u = Math.max(0, Math.min(1, m.dot(m.sub(a, q0), d) / l2));
    best = Math.min(best, m.len(m.sub(a, m.madd(q0, d, u))));
  }
  return best;
}

/** per capsule key (part, bone, pad): clearance of the axis segment a-b with radius r, mm */
function clearance(caps, a, b, r) {
  const out = {};
  for (const c of caps) {
    if (c.off) continue;
    const key = `${c.part}${c.bone}${c.pad ? '*' : ''}`;
    out[key] = +((segDist(a, b, c.a, c.b) - c.r - r) * 1000).toFixed(2);
  }
  return out;
}
const minOf = (cl, pred) => Math.min(...Object.entries(cl).filter(([k]) => pred(k)).map(([, v]) => v));
const worstOf = (cl, pred) => Object.entries(cl).filter(([k]) => pred(k)).sort((x, y) => x[1] - y[1])[0]?.[0];

const rows = [];
const stance = (spec) => ({ ...rig.stand(spec, [0, 0], 0, { width: 0.3 }), lean: 0.04 });

// ---------------------------------------------------------------- pinch
for (const spec of [cast.NOOR, cast.KOFI]) {
  const grip = rig.gripFrame([0.05, 0.92, -0.32], m.norm([-1, -0.3, -0.35]), [0, 0, 1]);
  for (const roll of [-90, -45, 0, 45, 90]) {
    for (const open of [0, 0.5, 1]) {
      const h = { grip, hold: 'pinch', radius: XLR, roll: roll * DEG, open, free: 1 };
      const pose = rig.rigPose(spec, { ...stance(spec), hands: [null, h] });
      const g = pose.body.arms[1].grip;
      const [, , d3] = m.quatCols(g.q);
      const shape = rig.gripShape(spec, 1, h);
      const tipErr = m.len(m.sub(hand.thumbChain(shape.thumb, shape.thumbDir)[3], shape.thumb)) * pose.body.hands[1].q;
      const cl = clearance(col.handColliders(pose, 1), m.madd(g.p, d3, -0.01), m.madd(g.p, d3, 0.01), XLR);
      const pads = minOf(cl, (k) => k.endsWith('*'));
      const others = minOf(cl, (k) => !k.endsWith('*'));
      rows.push({ grip: 'pinch', who: spec.name, roll, open, padsMm: pads, othersMm: others, worst: worstOf(cl, (k) => !k.endsWith('*')), thumbTipMm: +(tipErr * 1000).toFixed(2) });
      if (others < -0.5) fails.push(`pinch ${spec.name} roll ${roll} open ${open}: ${worstOf(cl, (k) => !k.endsWith('*'))} ${others} mm into the hand`);
      if (open === 0 && Math.abs(pads) > 0.6) fails.push(`pinch ${spec.name} roll ${roll}: pads ${pads} mm off the cable`);
    }
  }
}

// ---------------------------------------------------------------- the roll contract
const signed = (a, b, axis) => Math.atan2(m.dot(m.cross(a, b), axis), m.dot(a, b)) / DEG;
for (const free of [0, 0.5, 1]) {
  for (const side of [0, 1]) {
    const s = side ? 1 : -1;
    const grip = rig.gripFrame([0.1 * s, 0.92, -0.3], m.norm([-s, -0.3, -0.35]), [0, 0, 1]);
    let ref = null;
    for (const roll of [0, 30, 60, 90, -60]) {
      const h = { grip, hold: 'pinch', radius: XLR, roll: roll * DEG, free };
      const pose = rig.rigPose(cast.NOOR, { ...stance(cast.NOOR), hands: side ? [null, h] : [h, null] });
      const arm = pose.body.arms[side];
      const [g1, , g3] = m.quatCols(arm.grip.q);
      const [p1] = m.quatCols(arm.pads.q);
      if (!ref) ref = p1;
      const rolled = signed(p1, g1, g3);
      const handTurn = signed(ref, m.across(p1, g3), g3);
      rows.push({ grip: 'roll', side: side ? 'R' : 'L', free, roll, cableVsPadsDeg: +rolled.toFixed(2), handTurnDeg: +handTurn.toFixed(2) });
      if (Math.abs(rolled - roll) > 0.5) fails.push(`roll ${side ? 'R' : 'L'} free ${free} roll ${roll}: the cable frame turned ${rolled.toFixed(1)}°`);
      if (Math.abs(handTurn) > 5) fails.push(`roll ${side ? 'R' : 'L'} free ${free} roll ${roll}: the hand turned ${handTurn.toFixed(1)}° with it`);
    }
  }
}

// ---------------------------------------------------------------- coil and fist
for (const spec of [cast.NOOR, cast.KOFI]) {
  for (const [hold, R, wrap] of [
    ...[0.005, 0.008, 0.012, 0.016, 0.022, 0.03].map((R) => ['coil', R, 0]),
    ...[0.0032, 0.006, 0.008, 0.012, 0.02, 0.03].flatMap((R) => [0, 0.25, 0.5, 0.75, 1].map((w) => ['fist', R, w])),
  ]) {
    const grip = rig.gripFrame([-0.1, 0.92, -0.3], m.norm([0.1, 0.4, -1]), [-1, 0.1, 0]);
    const h = { grip, hold, radius: R, wrap, free: 0.6 };
    const pose = rig.rigPose(spec, { ...stance(spec), hands: [h, null] });
    const g = pose.body.arms[0].grip;
    const [, , d3] = m.quatCols(g.q);
    // the held axis across the hand: ±5 cm around the grip point
    const cl = clearance(col.handColliders(pose, 0), m.madd(g.p, d3, -0.05), m.madd(g.p, d3, 0.05), R);
    const thumb = minOf(cl, (k) => k.startsWith('thumb'));
    const fingers = minOf(cl, (k) => /^(index|middle|ring|little)/.test(k));
    const palm = minOf(cl, (k) => k.startsWith('palm'));
    rows.push({ grip: hold, who: spec.name, Rmm: R * 1000, wrap, thumbMm: thumb, fingersMm: fingers, worstFinger: worstOf(cl, (k) => /^(index|middle|ring|little)/.test(k)), palmMm: palm, posErrMm: +(pose.body.arms[0].report.posError * 1000).toFixed(2) });
    if (thumb < -0.5) fails.push(`${hold} ${spec.name} R ${R * 1000} wrap ${wrap}: thumb ${thumb} mm into the cable`);
    if (fingers < -0.5) fails.push(`${hold} ${spec.name} R ${R * 1000} wrap ${wrap}: ${worstOf(cl, (k) => /^(index|middle|ring|little)/.test(k))} ${fingers} mm into the cable`);
  }
}

// ---------------------------------------------------------------- the list
{
  const pose = rig.rigPose(cast.NOOR, { ...stance(cast.NOOR), hands: [null, null] });
  const all = col.handColliders(pose, 1, { group: 7, soft: { index: 0.3 } });
  const off = col.handColliders(pose, 1, { disable: ['thumb', 'index'], forearm: false });
  const parts = all.map((c) => c.part).join(',');
  if (all.length !== 22 || parts !== col.HAND_PARTS.join(',')) fails.push(`collider list: ${all.length} capsules ${parts}`);
  if (off.length !== 22 || off.map((c) => c.part).join(',') !== parts) fails.push('disable changed the list');
  if (off.some((c) => (c.part === 'thumb' || c.part === 'index' || c.part === 'forearm') !== (c.r < 0))) fails.push('disable: wrong slots off');
  if (all.some((c) => c.group !== 7) || all.some((c) => (c.part === 'index') !== (c.soft === 0.3))) fails.push('group / soft not applied');
  rows.push({ grip: 'list', count: all.length, parts });
}

for (const r of rows) console.log(JSON.stringify(r));
console.log(fails.length ? `FAIL (${fails.length})\n  ${fails.slice(0, 40).join('\n  ')}` : 'OK');
fs.writeFileSync(path.join(OUT, 'ik-hands.json'), JSON.stringify({ rows, fails }, null, 1));
await close();
process.exit(fails.length ? 1 : 0);
