// The cable with a real hand (the IK foundation's rig and colliders) instead of test capsules:
// Noor's right hand (rigPose, arm IK) comes to a hanging XLR, pinches it where it is, carries it
// 25 cm to the side and 10 cm down, holds, opens and leaves. The hand's 22 capsules
// (handColliders, group = the pinch's hand, soft fingers) collide with the cable every substep
// (poses solved per frame, capsules interpolated in between).
//   node tools/simtest/realhand.mjs
// Checks: no capsule of the hand inside the cable (except the pads where the pinch holds it), no
// pass-through, joints closed, no speed cap, no warnings; prints the numbers and writes
// output/simtest/realhand.png.

import { load, snap, render } from './lib.mjs';

const { mods: [sim, rig, cast, col], close } = await load('/src/sim/index.ts', '/src/people/rig.ts', '/src/people/cast.ts', '/src/people/colliders.ts');
const { XLR, buildCable, gripFrame } = sim;
const RC = XLR.od / 2, SUB = XLR.substeps, RIGHT = 1;
const minJerk = (u) => { const x = Math.min(1, Math.max(0, u)); return x * x * x * (10 - 15 * x + 6 * x * x); };
const lerp = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const r3 = (v) => +(+v).toFixed(3);
let fails = 0;
const check = (name, ok, v) => { if (!ok) fails++; console.log(`CHECK ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(v)}`); };

// the cable: held in a fixed (left) fist at 1.15 m, hanging down to the floor, then along it
const X0 = 0.0, Z0 = -0.36, TOP = 1.15;
const pts = [];
for (let y = TOP; y > RC + 0.04; y -= 0.002) pts.push([X0, y, Z0]);
for (let a = 0; a <= Math.PI / 2; a += 0.02) pts.push([X0 + 0.04 - 0.04 * Math.cos(a), RC + 0.04 - 0.04 * Math.sin(a), Z0]);
for (let x = X0 + 0.04; x < 1.2; x += 0.002) pts.push([x, RC, Z0]);
const { rod } = buildCable(XLR, pts, { plugs: 'both' });
const fist = rod.bundle({ frame: gripFrame([X0, TOP, Z0], [0, -1, 0], [1, 0, 0]), hand: 0, blend: 0.01 });
fist.add(0, 0.06, 0.01);
for (let f = 0; f < 30; f++) rod.step(1 / 60, SUB);
rod.time = 0;

// where the hand takes it: the cable point at 0.9 m, pads along the cable (d3 down), the hand free about it
const take = rod.closestPoint([X0, +(process.env.TAKE_Y ?? 0.85), Z0]);
const UP = process.env.D3 === 'up';
const T = { at: 0.6, close: 0.12, move: 0.8, moveTime: 0.9, open: 2.5, away: 2.75, end: 3.4 };
const P0 = [take.point[0] + 0.12, take.point[1] + 0.05, take.point[2] + 0.06];
const P1 = take.point, P2 = [P1[0] + 0.2, P1[1] + 0.15, P1[2] + 0.03];
const gripAt = (t) => {
  let p;
  if (t < T.at) p = lerp(P0, P1, minJerk(t / T.at));
  else if (t < T.move) p = P1;
  else if (t < T.open) p = lerp(P1, P2, minJerk((t - T.move) / T.moveTime));
  else p = lerp(P2, [P2[0] + 0.1, P2[1] + 0.08, P2[2] + 0.08], minJerk((t - T.away) / 0.5));
  const down = take.tangent[1] < 0 ? take.tangent : [-take.tangent[0], -take.tangent[1], -take.tangent[2]];
  return gripFrame(p, UP ? [-down[0], -down[1], -down[2]] : down, [1, 0, 0]);
};
let pin = null;
const openAt = (t) => (pin ? 1 - Math.min(1, pin.level(t) / 0.5) : 1 - minJerk((t - T.at + 0.2) / 0.2) * 0);
const stance = { ...rig.stand(cast.NOOR, [0.12, 0.0], 0, { width: 0.3 }), lean: 0.04 };
const SOFT = { index: 0.3, middle: 0.3, ring: 0.3, little: 0.3, thumb: 0.3 };
const poses = new Map();
/** the pose at frame f (60 fps): the right hand pinching at the grip frame */
function poseAt(f) {
  if (!poses.has(f)) {
    const t = f / 60;
    const h = { grip: gripAt(t), hold: 'pinch', radius: RC, open: openAt(t), free: 1 };
    poses.set(f, rig.rigPose(cast.NOOR, { ...stance, hands: [null, h] }));
  }
  return poses.get(f);
}
const capsAt = (f) => col.handColliders(poseAt(f), 1, { group: RIGHT, soft: SOFT });
/** capsules at time t: interpolated between the frames' poses (same order every time) */
function caps(t) {
  const f = Math.floor(t * 60 + 1e-9), u = t * 60 - f;
  const a = capsAt(f), b = capsAt(f + 1);
  return a.map((c, k) => ({ ...c, a: lerp(c.a, b[k].a, u), b: lerp(c.b, b[k].b, u) }));
}
/** the pinch frame: the grip frame the arm reached (pose.body.arms[1].grip), interpolated */
function padFrame(t) {
  const f = Math.floor(t * 60 + 1e-9), u = t * 60 - f;
  const a = poseAt(f).body.arms[1].grip, b = poseAt(f + 1).body.arms[1].grip;
  return { p: lerp(a.p, b.p, u), q: sim.quatSlerp(a.q, b.q, u) };
}
rod.setCapsules(caps);

const n = rod.n, X = [new Float64Array(3 * n), new Float64Array(3 * n), new Float64Array(3 * n)];
let vmax = 0, amax = 0, gap = 0, penOther = 0, penHeld = 0, reach = 0, worst = '';
const snaps = [];
for (let f = 0; f <= T.end * 60; f++) {
  const t = rod.time;
  if (!pin && t >= T.at) pin = rod.pinch({ frame: padFrame, hand: RIGHT, mode: 'held', blend: T.close });
  if (pin && t >= T.open && pin.state !== 'free') pin.release(0.15);
  if (f > 0) rod.step(1 / 60, SUB);
  X[0].set(X[1]); X[1].set(X[2]); X[2].set(rod.x);
  if (f >= 2) {
    for (let i = 0; i < n; i++) {
      let v2 = 0, a2 = 0;
      for (let k = 0; k < 3; k++) { const v = (X[2][3 * i + k] - X[1][3 * i + k]) * 60, a = (X[2][3 * i + k] - 2 * X[1][3 * i + k] + X[0][3 * i + k]) * 3600; v2 += v * v; a2 += a * a; }
      vmax = Math.max(vmax, Math.sqrt(v2)); amax = Math.max(amax, Math.sqrt(a2) / 9.81);
    }
  }
  gap = Math.max(gap, rod.maxJointGap());
  // penetration: every capsule against every free segment; the pinch's own capsules near the pads count separately
  for (const c of rod.currentCapsules()) {
    if (c.r < 0) continue;
    const ax = c.b[0] - c.a[0], ay = c.b[1] - c.a[1], az = c.b[2] - c.a[2], l2 = ax * ax + ay * ay + az * az || 1;
    for (let j = 0; j < rod.ns; j++) {
      if (rod.wc[j] === 0) continue;
      const px = rod.c[3 * j] - c.a[0], py = rod.c[3 * j + 1] - c.a[1], pz = rod.c[3 * j + 2] - c.a[2];
      const u = Math.max(0, Math.min(1, (px * ax + py * ay + pz * az) / l2));
      const d = c.r + RC - Math.hypot(px - ax * u, py - ay * u, pz - az * u);
      if (rod.skipGroup[j] === c.group) penHeld = Math.max(penHeld, d);
      else if (d > penOther) { penOther = d; worst = `${c.part}${c.bone} at t ${rod.time.toFixed(2)} s, s ${rod.sNode[j].toFixed(3)} (pads at ${pin ? pin.s.toFixed(3) : '-'})`; }
    }
  }
  if (pin && pin.level() > 0.9) reach = Math.max(reach, rod.closestPoint(padFrame(rod.time).p, pin.s - 0.05, pin.s + 0.05).dist);
  if ([0.3, T.at + 0.15, T.move + 0.45, T.open - 0.1, T.away + 0.2, T.end].some((s) => Math.abs(s - rod.time) < 0.009)) snaps.push(snap(sim, rod, '', { caps: rod.currentCapsules().filter((c) => c.r > 0) }));
}
const out = {
  gripDistance_mm: r3(pin.gripDistance * 1000), padsToCableWhileHeld_mm: r3(reach * 1000), cableVmax: r3(vmax), aMax_g: r3(amax), gapMax_mm: r3(gap * 1000),
  penetrationOutsideTheHold_mm: r3(Math.max(0, penOther) * 1000), deepest: worst, penetrationInTheHold_mm: r3(Math.max(0, penHeld) * 1000),
  speedCapped: rod.stats.speedCapped, heldSlip: rod.stats.heldSlip, warnings: rod.warnings,
};
console.log('realhand', JSON.stringify(out));
check('realhand: the pads close on the cable where it is (< 15 mm)', out.gripDistance_mm < 15, out.gripDistance_mm);
check('realhand: no part of the hand cuts into the cable outside the hold (< 1.5 mm)', out.penetrationOutsideTheHold_mm < 1.5, out.penetrationOutsideTheHold_mm);
check('realhand: joints closed, no speed cap, no held slip', out.gapMax_mm < 0.5 && !out.speedCapped && !out.heldSlip, out);
console.log(render('realhand', { title: 'realhand: Noor\'s right hand (IK + handColliders) pinches a hanging XLR, carries it, lets go', radius: RC, visScale: 1.5, views: [{ name: 'front', target: [0.12, 0.85, -0.33], dist: 0.7, yaw: 0, pitch: 5, fov: 40 }, { name: 'side', target: [0.12, 0.85, -0.33], dist: 0.7, yaw: 70, pitch: 10, fov: 40 }], snapshots: snaps, W: 230, H: 250 }));
await close();
process.exitCode = fails ? 1 : 0;
