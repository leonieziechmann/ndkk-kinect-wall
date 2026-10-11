// Numeric test of the arm IK (src/people/ik.ts through rig.ts): dense target paths, frame by frame.
//   node tools/simtest/ik-continuity.mjs
// Paths: the over-under sweep of the test scene (src/scenes/test/ik-sweep.ts, both hands), and
// smooth random paths of the right hand all round the body with changing orientation goals (some out
// of reach, some at the limits). Per path, stateless (rigPose without state, as a scene does when it
// scrubs) and stateful (RigIK, as a bake does): the largest jump of any joint angle between two
// frames, how much faster the joints moved than the target (a pop shows up as a jump far above the
// path's own speed), hard-limit violations (must be 0), position error, and solve time. A third
// mode samples a RigTrack (the stateful solve at 60 fps, interpolated) at 120 fps, as a scene does.
// Then the call rate: RigIK at 30 and 120 fps against RigTrack at 60 fps (a bake at another rate than
// the scene). Asserts: no limit violations, stateful/track jumps ≤ 20°/frame, RigIK@30 and @120 within
// 2° and 1 mm of RigTrack@60 on the sweep (3° / 3 mm on the spinning pinch). Writes output/simtest/ik-continuity.json; exits with 1 when an assertion fails.

import fs from 'node:fs';
import path from 'node:path';
import { load, OUT } from './lib.mjs';

const { mods, close } = await load('/src/people/ik.ts', '/src/people/rig.ts', '/src/people/cast.ts', '/src/scenes/test/ik-sweep.ts');
const [ik, rig, cast, sweep] = mods;
const DEG = Math.PI / 180;
const J = ik.ARM_JOINTS;

/** hard limits, checked independently of the solver's own projection */
function violations(a) {
  const out = [];
  const L = ik.ARM_LIMITS;
  for (const j of ['clavElev', 'clavProt', 'rot', 'elbow', 'pron']) {
    if (a[j] < L[j].min - 1e-9 || a[j] > L[j].max + 1e-9) out.push(`${j}=${(a[j] / DEG).toFixed(2)}`);
  }
  const th = Math.hypot(a.flex, a.abd);
  if (th > ik.shoulderLimit(Math.atan2(a.abd, a.flex)) + 1e-9) out.push(`shoulder ${(th / DEG).toFixed(2)}`);
  const u = a.wflex / (a.wflex >= 0 ? L.wflex.max : -L.wflex.min);
  const v = a.wdev / (a.wdev >= 0 ? L.wdev.max : -L.wdev.min);
  if (Math.hypot(u, v) > 1 + 1e-9) out.push(`wrist ${Math.hypot(u, v).toFixed(4)}`);
  return out;
}

/** runs a rig path at `fps` for `seconds`: 'stateless', 'stateful' (RigIK) or 'track' (RigTrack at 60 fps) */
function run(name, rigAt, seconds, fps, mode) {
  const state = mode === 'stateful' ? new rig.RigIK(1 / fps) : undefined;
  const track = mode === 'track' ? new rig.RigTrack(cast.NOOR, rigAt, 0, 60) : null;
  const n = Math.round(seconds * fps);
  let prev = null;
  let prevP = null;
  const maxJump = Object.fromEntries(J.map((j) => [j, 0]));
  let worst = { jump: 0, frame: -1, joint: '', speed: 0 };
  let maxRatio = 0;
  const viol = [];
  let maxPos = 0;
  let sumPos = 0;
  let notReached = 0;
  const t0 = performance.now();
  for (let f = 0; f <= n; f++) {
    const t = f / fps;
    const g = rigAt(t);
    const pose = track ? track.pose(t) : rig.rigPose(cast.NOOR, g, state);
    for (const side of [0, 1]) {
      if (!g.hands[side]) continue;
      const arm = pose.body.arms[side];
      const v = violations(arm.angles);
      if (v.length) viol.push({ f, side, v });
      maxPos = Math.max(maxPos, arm.report.posError);
      sumPos += arm.report.posError;
      if (!arm.report.reached) notReached++;
    }
    const a = pose.body.arms[1].angles;
    const p = g.hands[1]?.grip?.p ?? g.hands[1]?.wrist;
    if (prev) {
      const speed = Math.hypot(p[0] - prevP[0], p[1] - prevP[1], p[2] - prevP[2]);
      for (const j of J) {
        const d = Math.abs(a[j] - prev[j]) / DEG;
        maxJump[j] = Math.max(maxJump[j], d);
        if (d > worst.jump) worst = { jump: d, frame: f, joint: j, speed };
        // degrees per cm of target motion (with a floor so a resting target does not divide by 0)
        maxRatio = Math.max(maxRatio, d / Math.max(speed * 100, 0.2));
      }
    }
    prev = { ...a };
    prevP = p;
  }
  const ms = (performance.now() - t0) / (n + 1);
  return { name, mode, frames: n + 1, fps, maxJumpDeg: worst.jump, worst, maxJumpPerJoint: maxJump, maxDegPerCm: maxRatio, violations: viol.length, violationSamples: viol.slice(0, 5), maxPosErrorMm: maxPos * 1000, meanPosErrorMm: (sumPos / (n + 1)) * 1000, notReached, msPerPose: ms };
}

// ---------------------------------------------------------------- paths

const STAND = { ...rig.stand(cast.NOOR, [0, 0], 0, { width: 0.3 }), lean: 0.05 };

/** smooth pseudo-random path: a sum of sines with fixed seeds */
function wave(seed, t, amp, base) {
  let v = base;
  for (let i = 1; i <= 3; i++) v += (amp / i) * Math.sin(t * (0.37 + 0.23 * i + 0.11 * seed) + seed * 1.7 + i * 2.1);
  return v;
}
const norm = (v) => {
  const l = Math.hypot(...v) || 1;
  return v.map((x) => x / l);
};

/** the right hand all round the body: in front, across, high, low, at the side, a little behind; a full frame goal or only the palm */
function roam(seed, goal) {
  return (t) => {
    // the wrist within (mostly) reach of the right shoulder (≈ 0.17, 1.31, 0.01; the arm ≈ 0.51 m)
    const p = [wave(seed, t, 0.12, 0.12), wave(seed + 1, t, 0.14, 1.05), wave(seed + 2, t, 0.12, -0.18)];
    const fd = norm([wave(seed + 3, t, 1, 0), wave(seed + 4, t, 1, -0.6), wave(seed + 5, t, 1, -0.5)]);
    const palm = norm([wave(seed + 6, t, 1, 0), wave(seed + 7, t, 1, 0), wave(seed + 8, t, 1, 0.4)]);
    const hand = goal === 'frame' ? { wrist: p, dir: fd, palm } : goal === 'palm' ? { wrist: p, palm } : { wrist: p };
    return { ...STAND, hands: [null, hand] };
  };
}

const results = [];
for (const mode of ['stateless', 'stateful', 'track']) {
  results.push(run('sweep (over-under, both hands)', sweep.sweepRig, sweep.SWEEP_PERIOD * 2, 120, mode));
  for (const [seed, goal] of [[1, 'none'], [2, 'palm'], [3, 'frame'], [4, 'frame'], [5, 'palm']]) {
    results.push(run(`roam ${seed} (${goal})`, roam(seed, goal), 30, 120, mode));
  }
}

// ---------------------------------------------------------------- the call rate
// The stateful solver counts speeds per second and checks on a time grid: RigIK at another rate
// (a bake at 120 or 30 fps) must give the same arms as the scene's RigTrack at 60 fps. Paths: the
// sweep, and a pinch whose cable direction turns all the way round at the right hip (the arm has
// to change its configuration on the way).
const pinchSpin = (t) => ({ ...STAND, hands: [null, { grip: rig.gripFrame([0.22, 0.9, -0.22], [Math.cos(t), -0.2, Math.sin(t)], [0, 0, 1]), hold: 'pinch', radius: 0.0032, free: 1 }] });
const rate = [];
for (const [name, rigAt, seconds] of [['sweep', sweep.sweepRig, sweep.SWEEP_PERIOD * 2], ['pinchSpin', pinchSpin, 12]]) {
  const ref = new rig.RigTrack(cast.NOOR, rigAt, 0, 60);
  for (const fps of [30, 120]) {
    const st = new rig.RigIK(1 / fps);
    let worst = { deg: 0 }, worstMm = 0;
    for (let f = 0; f <= Math.round(seconds * fps); f++) {
      const t = f / fps;
      const g = rigAt(t);
      const a = rig.rigPose(cast.NOOR, g, st), b = ref.pose(t);
      for (const side of [0, 1]) {
        if (!g.hands[side]) continue;
        for (const j of J) {
          const d = Math.abs(a.body.arms[side].angles[j] - b.body.arms[side].angles[j]) / DEG;
          if (d > worst.deg) worst = { deg: +d.toFixed(2), joint: j, side, t: +t.toFixed(3) };
        }
        const ga = a.body.arms[side].grip, gb = b.body.arms[side].grip;
        if (ga && gb) worstMm = Math.max(worstMm, Math.hypot(ga.p[0] - gb.p[0], ga.p[1] - gb.p[1], ga.p[2] - gb.p[2]) * 1000);
      }
    }
    rate.push({ path: name, fps, maxAngleDiffDeg: worst.deg, worst, maxGripDiffMm: +worstMm.toFixed(2) });
  }
}

const fails = [];
for (const r of results) if (r.violations) fails.push(`${r.name} ${r.mode}: ${r.violations} limit violations`);
for (const r of results) if (r.mode !== 'stateless' && r.maxJumpDeg > 20) fails.push(`${r.name} ${r.mode}: jump ${r.maxJumpDeg.toFixed(1)}°`);
// the sweep within 2° and 1 mm; the spinning pinch (the arm changes its configuration, the hand lags
// up to 6 mm behind its target) within 3° and 3 mm
const RATE_TOL = { sweep: [2, 1], pinchSpin: [3, 3] };
for (const r of rate) {
  const [deg, mm] = RATE_TOL[r.path];
  if (r.maxAngleDiffDeg > deg || r.maxGripDiffMm > mm) fails.push(`${r.path}: RigIK@${r.fps} vs RigTrack@60 differ by ${r.maxAngleDiffDeg}° / ${r.maxGripDiffMm} mm`);
}

for (const r of results) {
  console.log(
    `${r.name.padEnd(32)} ${r.mode.padEnd(9)} jump ${r.maxJumpDeg.toFixed(2).padStart(6)}°/frame (${r.worst.joint} @${r.worst.frame}, target ${(r.worst.speed * 1000).toFixed(1)} mm)` +
      ` ${r.maxDegPerCm.toFixed(2).padStart(6)}°/cm  violations ${r.violations}  pos max ${r.maxPosErrorMm.toFixed(2)} mm mean ${r.meanPosErrorMm.toFixed(2)} mm` +
      `  out of reach ${r.notReached}  ${r.msPerPose.toFixed(2)} ms/pose`,
  );
}
for (const r of rate) console.log(`RATE ${r.path.padEnd(10)} RigIK@${r.fps} vs RigTrack@60: max angle diff ${r.maxAngleDiffDeg}° (${r.worst.joint ?? '-'} @${r.worst.t ?? '-'} s), grip point ${r.maxGripDiffMm} mm`);
console.log(fails.length ? `FAIL\n  ${fails.join('\n  ')}` : 'OK');
fs.writeFileSync(path.join(OUT, 'ik-continuity.json'), JSON.stringify({ results, rate, fails }, null, 1));
await close();
process.exit(fails.length ? 1 : 0);
