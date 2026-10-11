// Checks the IK test choreography (src/scenes/test/ik-sweep.ts) against the user's technique:
//   node tools/simtest/ik-sweep-check.mjs
// Solved as a scene does (RigTrack at 60 fps). Per beat: Noor's right arm angles, strained joints and
// limits hit, where the thumb tip points (angle to the direction to the coil in the left hand), the
// palm, the heights of elbow and wrist. And the under loop's turn: how far the hand turns over
// between the second slide-out and the turned pose (palm normal, thumb direction), and how much of
// it the forearm does. Asserts: start and slide-out relaxed (nothing strained or at a limit), the
// thumb tip within 45° of the coil at the start, the under turn ≥ 150° with the elbow staying low.
// Writes output/simtest/ik-sweep-check.json; exits with 1 when an assertion fails.

import fs from 'node:fs';
import path from 'node:path';
import { load, OUT } from './lib.mjs';

const { mods, close } = await load('/src/people/rig.ts', '/src/people/cast.ts', '/src/people/math.ts', '/src/people/body/hand.ts', '/src/scenes/test/ik-sweep.ts');
const [rig, cast, m, hand, sweep] = mods;
const D = 180 / Math.PI;
const track = new rig.RigTrack(cast.NOOR, sweep.sweepRig, 0, 60);
const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, m.dot(m.norm(a), m.norm(b))))) * D;

const rows = {};
for (const [beat, t] of Object.entries(sweep.SWEEP_BEATS)) {
  const pose = track.pose(t);
  const arm = pose.body.arms[1];
  const hp = pose.body.hands[1];
  const hj = hand.handJoints(hp, 1);
  const tip = m.norm(m.sub(hj.thumb[3], hj.thumb[2]));
  const coil = m.sub(pose.body.arms[0].grip.p, arm.grip.p);
  const a = arm.angles;
  rows[beat] = {
    t,
    thumbToCoilDeg: +ang(tip, coil).toFixed(0),
    palm: hp.palm.map((v) => +v.toFixed(2)),
    elevDeg: +(Math.hypot(a.flex, a.abd) * D).toFixed(0),
    rotDeg: +(a.rot * D).toFixed(0),
    elbowDeg: +(a.elbow * D).toFixed(0),
    pronDeg: +(a.pron * D).toFixed(0),
    wflexDeg: +(a.wflex * D).toFixed(0),
    wdevDeg: +(a.wdev * D).toFixed(0),
    elbowY: +pose.joints[8][1].toFixed(3),
    wristY: +pose.joints[10][1].toFixed(3),
    strained: arm.report.strained,
    atLimit: arm.report.atLimit,
    posErrMm: +(arm.report.posError * 1000).toFixed(2),
    axisErrDeg: arm.report.axisErrors.map((e) => +(e * D).toFixed(0)),
    left: { strained: pose.body.arms[0].report.strained, atLimit: pose.body.arms[0].report.atLimit, posErrMm: +(pose.body.arms[0].report.posError * 1000).toFixed(2) },
  };
}
// the under turn
const A = track.pose(sweep.SWEEP_BEATS.out2), B = track.pose(sweep.SWEEP_BEATS.turned);
const thumbOf = (p) => m.cross(p.body.hands[1].fd, p.body.hands[1].palm);
const turn = {
  palmDeg: +ang(A.body.hands[1].palm, B.body.hands[1].palm).toFixed(0),
  thumbSideDeg: +ang(thumbOf(A), thumbOf(B)).toFixed(0),
  forearmDeg: +((A.body.arms[1].angles.pron - B.body.arms[1].angles.pron) * D).toFixed(0),
  humeralRotDeg: +((B.body.arms[1].angles.rot - A.body.arms[1].angles.rot) * D).toFixed(0),
};
// the elbow over the whole period: how high it gets
let elbowMax = -Infinity, elevMax = 0;
for (let f = 0; f <= sweep.SWEEP_PERIOD * 60; f++) {
  const p = track.pose(f / 60);
  elbowMax = Math.max(elbowMax, p.joints[8][1]);
  const a = p.body.arms[1].angles;
  elevMax = Math.max(elevMax, Math.hypot(a.flex, a.abd) * D);
}
const shoulderY = track.pose(0).joints[6][1];

const fails = [];
for (const b of ['start', 'out', 'out2']) {
  const r = rows[b];
  if (r.strained.length || r.atLimit.length) fails.push(`${b}: right arm strained ${r.strained} / at limit ${r.atLimit}`);
}
if (rows.start.thumbToCoilDeg > 45) fails.push(`start: thumb tip ${rows.start.thumbToCoilDeg}° off the coil`);
if (turn.palmDeg < 150) fails.push(`under turn only ${turn.palmDeg}°`);
if (elevMax > 45) fails.push(`shoulder raised to ${elevMax.toFixed(0)}°`);

for (const [b, r] of Object.entries(rows)) console.log(b.padEnd(8), JSON.stringify(r));
console.log('UNDER TURN', JSON.stringify(turn), `elbow max height ${elbowMax.toFixed(3)} m (shoulder ${shoulderY.toFixed(3)}), shoulder elevation max ${elevMax.toFixed(0)}°`);
console.log(fails.length ? `FAIL\n  ${fails.join('\n  ')}` : 'OK');
fs.writeFileSync(path.join(OUT, 'ik-sweep-check.json'), JSON.stringify({ rows, turn, elbowMax, elevMax, fails }, null, 1));
await close();
process.exit(fails.length ? 1 : 0);
