// Checks the retargeting (src/mocap: take.ts, retarget.ts) on the synthetic recordings of
// mocap/synthetic (their ground truth and the takes auswerten.py made of them):
//   node tools/simtest/mocap-retarget.mjs            (about 2 min)
//
//   1 formats     takeJointsOf = synthetic generate.ts jointsOf; gzip read sync = async; mirror twice = identity
//   2 same person the truth, the evaluated takes (true 2D pixels + 2.5 px noise as a stand-in for the
//                 strong models; the light model YOLO11s, no hands) retargeted onto the same Noor at the
//                 recording's own place: joint positions (mm) and joint angles (°) against the original
//                 motion, next to the take's own error against the truth (what the retargeting adds)
//   3 proportions the truth onto Kofi (1.80 m) and the throw onto Noor (1.65 m): feet on the floor, standing
//                 feet do not slide, hands that meet still meet (the clap), IK limits, knees
//   4 mirror      the mirrored take = the mirror image of the retargeted figure
//   5 holds       grips from the recorded hands: where the cable frame lies against the original grips
//   6 time        speed and warp
// Needs output/synthetic/*.truth.json.gz (node mocap/synthetic/erzeugen.mjs coil throw coil-a) and the
// evaluated takes output/synthetic/<name>.take-gt2d.json.gz / .take-leicht.json.gz (see the report
// mocap-retarget.md: auswertung.pipeline on the synthetic recordings); missing ones are skipped.
// Writes output/simtest/mocap-retarget.json; exits with 1 when an assertion fails.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { load, OUT, ROOT } from './lib.mjs';

const { mods, close } = await load('/src/mocap/take.ts', '/src/mocap/retarget.ts', '/src/mocap/joints.ts', '/src/mocap/body.ts', '/mocap/synthetic/motions.ts', '/mocap/synthetic/generate.ts', '/src/people/rig.ts', '/src/people/cast.ts', '/src/people/math.ts');
const [tk, rt, jn, body, motions, gen, rig, cast, mm] = mods;
const D = 180 / Math.PI;
const SYN = path.join(ROOT, 'output/synthetic');
const fails = [];
const out = {};
const check = (ok, msg) => {
  if (!ok) fails.push(msg);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};
const have = (f) => fs.existsSync(path.join(SYN, f));
const read = (f) => tk.readTakeSync(path.join(SYN, f));
const r1 = (x) => Math.round(x * 10) / 10;

// ---------------------------------------------------------------- measures

const S = jn.SIDE;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b))))) * D;
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const ones = (J) => J.map(() => 1);

/** joint angles (°) of 68 take joints */
function anglesOf(J) {
  const spine = sub(mid(J[S[0].shoulder], J[S[1].shoulder]), mid(J[S[0].hip], J[S[1].hip]));
  const down = spine.map((x) => -x);
  const a = {};
  for (const s of [0, 1]) {
    const X = S[s];
    const n = s ? 'R' : 'L';
    a[`elbow${n}`] = 180 - angle(sub(J[X.shoulder], J[X.elbow]), sub(J[X.wrist], J[X.elbow]));
    a[`shoulder${n}`] = angle(sub(J[X.elbow], J[X.shoulder]), down);
    a[`knee${n}`] = 180 - angle(sub(J[X.hip], J[X.knee]), sub(J[X.ankle], J[X.knee]));
    a[`hip${n}`] = angle(sub(J[X.knee], J[X.hip]), down);
  }
  a.lean = angle(spine, [0, 1, 0]);
  return a;
}
/** the hand frame of take joints (body.ts measureHand) */
const handOf = (J, s) => body.measureHand(J, ones(J), s, S[s].hand);
/** angle (°) between two hand frames */
function handAngle(a, b) {
  if (!a || !b) return NaN;
  const qa = qOf(a), qb = qOf(b);
  const d = Math.abs(qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3]);
  return 2 * Math.acos(Math.min(1, d)) * D;
}
const qOf = (h) => mm.quatFromCols(h.fd, h.palm, norm(cross(h.fd, h.palm)));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const GROUPS = {
  body: [...Array(17).keys()],
  wrists: [9, 10],
  elbows: [7, 8],
  hands: [...Array(42).keys()].map((i) => 23 + i),
  feet: [17, 18, 19, 20, 21, 22],
  face: [0, 1, 2, 3, 4],
};
const ANG = ['elbowL', 'elbowR', 'shoulderL', 'shoulderR', 'kneeL', 'kneeR', 'hipL', 'hipR', 'lean'];

/** accumulates per-frame errors: positions (mm) per group, angles (°), head, hands, curls */
class Stats {
  constructor() { this.v = {}; }
  add(k, x) { if (Number.isFinite(x)) (this.v[k] ??= []).push(x); }
  pose(A, B, prefix = '') {
    for (const [g, js] of Object.entries(GROUPS)) this.add(`${prefix}${g}_mm`, (js.reduce((s, j) => s + dist(A[j], B[j]), 0) / js.length) * 1000);
    const aa = anglesOf(A), ab = anglesOf(B);
    for (const k of ANG) this.add(`${prefix}${k}_deg`, Math.abs(aa[k] - ab[k]));
    const ha = body.measureBody(A, ones(A)).headF, hb = body.measureBody(B, ones(B)).headF;
    if (ha && hb) this.add(`${prefix}head_deg`, angle(ha, hb));
    for (const s of [0, 1]) {
      const a = handOf(A, s), b = handOf(B, s);
      this.add(`${prefix}hand${s ? 'R' : 'L'}_deg`, handAngle(a, b));
      if (a && b) this.add(`${prefix}curl${s ? 'R' : 'L'}`, [1, 2, 3, 4].reduce((x, f) => x + Math.abs(a.curls[f] - b.curls[f]), 0) / 4);
    }
  }
  mean(k) { const v = this.v[k] ?? []; return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; }
  p90(k) { const v = [...(this.v[k] ?? [])].sort((a, b) => a - b); return v.length ? v[Math.floor(0.9 * (v.length - 1))] : NaN; }
  table() { return Object.fromEntries(Object.keys(this.v).map((k) => [k, { mean: r1(this.mean(k)), p90: r1(this.p90(k)) }])); }
}

/** the inverse of a row-major rigid 4 × 4 (mm) */
function invRigid(M) {
  const R = [M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]];
  const t = [M[3], M[7], M[11]];
  const Rt = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
  const ti = [0, 1, 2].map((r) => -(Rt[3 * r] * t[0] + Rt[3 * r + 1] * t[1] + Rt[3 * r + 2] * t[2]));
  return [Rt[0], Rt[1], Rt[2], ti[0], Rt[3], Rt[4], Rt[5], ti[1], Rt[6], Rt[7], Rt[8], ti[2], 0, 0, 0, 1];
}

/** a take placed so that scene time = recording time and scene space = the original rig world */
function atOrigin(take, truth, spec, options = {}) {
  const t0 = take.t0, t1 = take.t1;
  return new rt.Mocap(take, spec, { matrix: invRigid(truth.doc.truth.rig_to_world), from: t0 - take.zero, to: t1 - take.zero, at: t0 }, options);
}

/** compares a retargeted take with the original motion at the recording's times (every 2nd frame) during the action (the truth's markers ±0.5 s) */
function compareSame(name, motion, takeFile, truthFile, options = {}) {
  const truth = read(truthFile);
  const take = takeFile === truthFile ? truth : read(takeFile);
  const t0 = performance.now();
  const mc = atOrigin(take, truth, motion.spec, options);
  const build = performance.now() - t0;
  const track = mc.track();
  const orig = new rig.RigTrack(motion.spec, motion.rigAt, 0, 60);
  const st = new Stats();
  let ikMax = 0, limits = 0, frames = 0;
  const t1 = performance.now();
  for (let i = 0; i < take.frames; i += 2) {
    const t = take.time[i];
    if (t < truth.t0 || t > truth.t1 || t < (truth.markers.start ?? 0) - 0.5 || t > (truth.markers.end ?? 1e9) + 0.5) continue;
    const pr = track.pose(t);
    const A = jn.takeJointsOf(pr);
    const B = gen.jointsOf(orig.pose(t));
    st.pose(A, B);
    // what the take itself is off (its joints against the truth, same instant)
    const k = truth.nearest(t);
    const Tj = [...Array(68).keys()].map((j) => truth.at(k, j));
    const Kj = take.sample(t);
    for (const [g, js] of Object.entries(GROUPS)) {
      const e = js.filter((j) => Kj.c[j] > 0 && Tj[j]).map((j) => dist(Kj.p[j], Tj[j]) * 1000);
      if (e.length) st.add(`take_${g}_mm`, e.reduce((a, b) => a + b, 0) / e.length);
    }
    // the wrists the take has (seen or filled in from a short gap): the retargeted ones against the original
    for (const j of [9, 10]) if (Kj.c[j] > 0.3) st.add('seen_wrists_mm', dist(A[j], B[j]) * 1000);
    // the take's own angles against the truth's
    {
      const ok = (js) => js.every((j) => Kj.c[j] > 0 && Tj[j]);
      const at = anglesOf(Kj.p), tt = anglesOf(Tj);
      if (ok([5, 6, 11, 12])) st.add('take_lean_deg', Math.abs(at.lean - tt.lean));
      for (const s of [0, 1]) if (ok([S[s].shoulder, S[s].elbow, S[s].wrist])) st.add(`take_elbow${s ? 'R' : 'L'}_deg`, Math.abs(at[`elbow${s ? 'R' : 'L'}`] - tt[`elbow${s ? 'R' : 'L'}`]));
    }
    // the take's own hand frames against the truth's (what the data can give)
    for (const s of [0, 1]) {
      const a = body.measureHand(Kj.p, Kj.c, s, S[s].hand), b = handOf(Tj, s);
      if (a && b && a.conf > 0.3) {
        st.add(`take_hand${s ? 'R' : 'L'}_deg`, handAngle(a, b));
        st.add(`take_fd${s ? 'R' : 'L'}_deg`, angle(a.fd, b.fd));
      }
    }
    for (const s of [0, 1]) {
      const rep = pr.body.arms[s].report;
      ikMax = Math.max(ikMax, rep.posError);
      limits += rep.atLimit.length ? 1 : 0;
    }
    frames++;
  }
  const res = { quality: mc.quality, report: mc.report(), buildMs: Math.round(build), solveMs: Math.round(performance.now() - t1), frames, ikPosErrMaxMm: r1(ikMax * 1000), armFramesAtLimit: limits, errors: st.table() };
  out[name] = res;
  console.log(`\n${name}: ${frames} frames, build ${res.buildMs} ms, track ${res.solveMs} ms`);
  console.log(mc.report().split('\n').map((l) => `  ${l}`).join('\n'));
  const T = res.errors;
  const f = (k) => (T[k] ? `${T[k].mean}/${T[k].p90}` : '–');
  console.log(`  retarget vs original (mean/p90): body ${f('body_mm')} mm, wrists ${f('wrists_mm')} (those the take has ${f('seen_wrists_mm')}), elbows ${f('elbows_mm')}, hands ${f('hands_mm')}, feet ${f('feet_mm')}, face ${f('face_mm')}`);
  console.log(`  take vs truth:                    body ${f('take_body_mm')} mm, wrists ${f('take_wrists_mm')}, hands ${f('take_hands_mm')}, feet ${f('take_feet_mm')}; hand frames ${f('take_handL_deg')}° ${f('take_handR_deg')}° (fingers' direction ${f('take_fdL_deg')}° ${f('take_fdR_deg')}°)`);
  console.log(`  take angles (°): elbow ${f('take_elbowL_deg')} ${f('take_elbowR_deg')}, lean ${f('take_lean_deg')}`);
  console.log(`  angles (°): elbow ${f('elbowL_deg')} ${f('elbowR_deg')}, shoulder ${f('shoulderL_deg')} ${f('shoulderR_deg')}, knee ${f('kneeL_deg')} ${f('kneeR_deg')}, hip ${f('hipL_deg')} ${f('hipR_deg')}, lean ${f('lean_deg')}, head ${f('head_deg')}, hand ${f('handL_deg')} ${f('handR_deg')}, curl ${f('curlL')} ${f('curlR')}`);
  return { res, mc, track, take, truth };
}

// ---------------------------------------------------------------- 1 formats

console.log('1 formats');
{
  const spec = motions.COIL.spec;
  const tr = new rig.RigTrack(spec, motions.COIL.rigAt, 0, 60);
  let worst = 0;
  for (const t of [0.5, 1.0, 3.3, 6.1]) {
    const p = tr.pose(t);
    const a = jn.takeJointsOf(p), b = gen.jointsOf(p);
    for (let j = 0; j < 68; j++) worst = Math.max(worst, dist(a[j], b[j]));
  }
  check(worst === 0 && jn.TAKE_JOINTS.join() === gen.JOINTS.join(), `takeJointsOf = generate.ts jointsOf (68 names, max diff ${worst} m)`);
  if (have('synth-coil.truth.json.gz')) {
    const file = path.join(SYN, 'synth-coil.truth.json.gz');
    const a = tk.readTakeSync(file);
    const b = tk.parseTake(await tk.decodeTakeBytes(new Uint8Array(fs.readFileSync(file))), 'async');
    const plain = tk.parseTake(JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')), 'plain');
    let d = 0;
    for (let i = 0; i < a.pos.length; i++) d = Math.max(d, Math.abs(a.pos[i] - b.pos[i]), Math.abs(a.pos[i] - plain.pos[i]));
    check(d === 0 && a.frames === 300 && a.zero === 1, `take read: sync (zlib) = async (DecompressionStream) = plain JSON; ${a.frames} frames, clap ${a.zero} s`);
    const mm2 = a.mirror().mirror();
    let e = 0;
    for (let i = 0; i < a.pos.length; i++) e = Math.max(e, Math.abs(a.pos[i] - mm2.pos[i]));
    check(e === 0, 'mirror twice = the take');
    const m1 = a.mirror();
    const lw = m1.position(jn.TJ.left_wrist, 3.0), rw = a.position(jn.TJ.right_wrist, 3.0);
    check(Math.abs(lw[0] + rw[0]) < 1e-9 && lw[1] === rw[1], 'mirror: the left wrist is the reflected right one');
    // sampling between frames: Catmull-Rom through the frame values
    const j = jn.TJ.right_wrist;
    const p5 = a.position(j, a.time[100]), q5 = a.at(100, j);
    check(dist(p5, q5) < 1e-9, 'sampling at a frame time returns the frame');
  }
}

// ---------------------------------------------------------------- 2 same person

console.log('\n2 same person (Noor → Noor at the original place)');
const coilTruth = 'synth-coil.truth.json.gz';
let coilRun = null;
if (have(coilTruth)) {
  coilRun = compareSame('coil_truth', motions.COIL, coilTruth, coilTruth);
  const E = coilRun.res.errors;
  check(E.wrists_mm.mean <= 5, `truth: wrists ${E.wrists_mm.mean} mm (≤ 5)`);
  check(E.hands_mm.mean <= 6, `truth: hand points ${E.hands_mm.mean} mm (≤ 6)`);
  check(E.body_mm.mean <= 6, `truth: body ${E.body_mm.mean} mm (≤ 6)`);
  check(E.feet_mm.mean <= 4, `truth: feet ${E.feet_mm.mean} mm (≤ 4)`);
  check(Math.max(E.elbowL_deg.mean, E.elbowR_deg.mean) <= 3, `truth: elbow angles ${E.elbowL_deg.mean}° / ${E.elbowR_deg.mean}° (≤ 3)`);
  check(Math.max(E.kneeL_deg.mean, E.kneeR_deg.mean) <= 2, `truth: knee angles ${E.kneeL_deg.mean}° / ${E.kneeR_deg.mean}° (≤ 2)`);
  check(E.head_deg.mean <= 3, `truth: head ${E.head_deg.mean}° (≤ 3)`);
  check(Math.max(E.handL_deg.mean, E.handR_deg.mean) <= 4, `truth: hand frames ${E.handL_deg.mean}° / ${E.handR_deg.mean}° (≤ 4)`);
  check(Math.max(E.curlL.mean, E.curlR.mean) <= 0.05, `truth: finger curls off by ${E.curlL.mean} / ${E.curlR.mean} (≤ 0.05)`);
}
for (const [kind, lim] of [['gt2d', { wrists: 12, hands: 20 }], ['leicht', { wrists: 15, hands: null }]]) {
  const f = `synth-coil.take-${kind}.json.gz`;
  if (!have(f) || !have(coilTruth)) continue;
  const { res } = compareSame(`coil_${kind}`, motions.COIL, f, coilTruth);
  const E = res.errors;
  // the retargeting must not add much to what the take is off
  check(E.seen_wrists_mm.mean <= E.take_wrists_mm.mean + lim.wrists, `${kind}: wrists ${E.seen_wrists_mm.mean} mm vs take ${E.take_wrists_mm.mean} mm (adds ≤ ${lim.wrists})`);
  if (lim.hands) check(E.hands_mm.mean <= E.take_hands_mm.mean + lim.hands, `${kind}: hand points ${E.hands_mm.mean} mm vs take ${E.take_hands_mm.mean} mm (adds ≤ ${lim.hands})`);
  check(res.ikPosErrMaxMm < 30, `${kind}: IK reaches every wrist target (max ${res.ikPosErrMaxMm} mm)`);
}
for (const [kind] of [['gt2d']]) {
  const f = `synth-coil-a.take-${kind}.json.gz`;
  if (have(f) && have('synth-coil-a.truth.json.gz')) compareSame(`coil_a_${kind}`, motions.COIL_A, f, 'synth-coil-a.truth.json.gz');
}

// ---------------------------------------------------------------- 3 proportions

console.log('\n3 other proportions');
/** checks of a retargeted figure that hold whoever it is: floor, sliding feet, IK, knees, hands meeting */
function figureChecks(name, mc, opts = {}) {
  const track = mc.track();
  let soleMin = Infinity, slideMax = 0, kneeMax = 0, ikMax = 0, limit = 0, nan = 0;
  const prevAnkle = [null, null];
  const dt = 1 / 60;
  for (let t = mc.start; t <= mc.end; t += dt) {
    const p = track.pose(t);
    const J = jn.takeJointsOf(p);
    if (J.some((v) => !v.every(Number.isFinite))) nan++;
    for (const j of [...GROUPS.feet]) soleMin = Math.min(soleMin, J[j][1]);
    const a = anglesOf(J);
    kneeMax = Math.max(kneeMax, a.kneeL, a.kneeR);
    // the frames around t: a foot counts as standing when it is locked in both
    const tau = mc.tauOf(t);
    const after = mc.frames.findIndex((f) => f.tau > tau);
    const k1 = after < 0 ? mc.frames.length - 1 : after;
    const k0 = Math.max(0, k1 - 1);
    for (const s of [0, 1]) {
      const an = J[S[s].ankle];
      const locked = mc.frames[k0].sides[s].lock >= 1 && mc.frames[k1].sides[s].lock >= 1;
      if (locked && prevAnkle[s]) slideMax = Math.max(slideMax, Math.hypot(an[0] - prevAnkle[s][0], an[2] - prevAnkle[s][2]));
      prevAnkle[s] = locked ? an : null;
      const rep = p.body.arms[s].report;
      ikMax = Math.max(ikMax, rep.posError);
      if (rep.atLimit.length) limit++;
    }
  }
  // the clap: the hands' middles (middle finger knuckles) at the clap
  let clap = null;
  if (opts.clap !== undefined) {
    const t = opts.clap;
    const J = jn.takeJointsOf(track.pose(t));
    const rec = mc.recorded(t).p;
    const hm = (P, s) => P[S[s].hand + 9];
    clap = { figureMm: r1(dist(hm(J, 0), hm(J, 1)) * 1000), recordedMm: r1(dist(hm(rec, 0), hm(rec, 1)) * 1000) };
  }
  const r = { soleMinMm: r1(soleMin * 1000), footSlideMaxMm: r1(slideMax * 1000), kneeMaxDeg: r1(kneeMax), ikPosErrMaxMm: r1(ikMax * 1000), armSamplesAtLimit: limit, nan, clap, quality: mc.quality, report: mc.report() };
  out[name] = r;
  console.log(`\n${name}:`);
  console.log(mc.report().split('\n').map((l) => `  ${l}`).join('\n'));
  console.log(`  sole min ${r.soleMinMm} mm, standing foot slides ≤ ${r.footSlideMaxMm} mm/frame, knee ≤ ${r.kneeMaxDeg}°, IK off ≤ ${r.ikPosErrMaxMm} mm, ${limit} arm samples at a limit${clap ? `, clap: hands ${clap.figureMm} mm apart (recorded ${clap.recordedMm})` : ''}`);
  check(nan === 0, `${name}: no NaN`);
  check(r.soleMinMm >= -3, `${name}: shoes stay above the floor (${r.soleMinMm} mm)`);
  check(r.footSlideMaxMm <= 1, `${name}: standing feet do not slide (${r.footSlideMaxMm} mm per frame)`);
  check(r.kneeMaxDeg <= 156, `${name}: knees bend ≤ 155° (${r.kneeMaxDeg}°)`);
  if (clap && opts.meet !== false) check(clap.figureMm <= clap.recordedMm + 25, `${name}: hands that meet still meet (${clap.figureMm} vs ${clap.recordedMm} mm)`);
  return r;
}
if (have(coilTruth)) {
  const truth = read(coilTruth);
  const spec = cast.KOFI;
  const pl = { pos: [0, 0], yaw: 0, from: -1, to: 8, at: 0, anchor: 0 };
  figureChecks('coil_truth_on_Kofi', new rt.Mocap(truth, spec, pl), { clap: 1 });
  const apart = figureChecks('coil_truth_on_Kofi_no_together', new rt.Mocap(truth, spec, pl, { together: [0, 0] }), { clap: 1, meet: false });
  console.log(`  (without keeping close hands together the clap's hands are ${apart.clap.figureMm} mm apart)`);
  figureChecks('coil_truth_on_Jonas', new rt.Mocap(truth, cast.JONAS, pl), { clap: 1 });
}
if (have('synth-throw.truth.json.gz')) {
  const truth = read('synth-throw.truth.json.gz');
  figureChecks('throw_truth_on_Noor', new rt.Mocap(truth, cast.NOOR, { pos: [0, 0], yaw: 0, from: -1, to: 5.9, at: 0, anchor: 0 }), { clap: 1 });
  if (have('synth-throw.take-leicht.json.gz')) {
    const tl = read('synth-throw.take-leicht.json.gz');
    figureChecks('throw_leicht_on_Kofi', new rt.Mocap(tl, cast.KOFI, { pos: [0, 0], yaw: 0, from: -1, to: 5.9, at: 0, anchor: 0 }));
  }
  compareSame('throw_truth', motions.THROW, 'synth-throw.truth.json.gz', 'synth-throw.truth.json.gz');
  // the side view (setup D): the far arm and hip are hidden (true 2D pixels), the light model guesses
  // them onto the near ones; the data itself is off by 8–17 cm at the wrists. Looser bounds: the
  // retargeting must stay usable (no flips, no lost figure), not better than the data.
  for (const kind of ['gt2d', 'leicht']) {
    const f = `synth-throw.take-${kind}.json.gz`;
    if (!have(f)) continue;
    const { res } = compareSame(`throw_${kind}`, motions.THROW, f, 'synth-throw.truth.json.gz');
    check(res.errors.seen_wrists_mm.mean <= res.errors.take_wrists_mm.mean + 40, `throw ${kind}: wrists the take has ${res.errors.seen_wrists_mm.mean} mm vs take ${res.errors.take_wrists_mm.mean} mm (adds ≤ 40)`);
    check(res.errors.body_mm.mean <= res.errors.take_body_mm.mean + 60, `throw ${kind}: body ${res.errors.body_mm.mean} mm vs take ${res.errors.take_body_mm.mean} mm (adds ≤ 60)`);
    check(res.errors.lean_deg.mean <= 8, `throw ${kind}: lean ${res.errors.lean_deg.mean}° (≤ 8)`);
  }
}

// ---------------------------------------------------------------- 4 mirror

console.log('\n4 mirror');
if (coilRun) {
  const truth = coilRun.truth;
  const pl = { pos: [0, 0], yaw: 0, from: -1, to: 8.9, at: 0, anchor: 0 };
  const a = new rt.Mocap(truth, motions.COIL.spec, pl).track();
  const b = new rt.Mocap(truth, motions.COIL.spec, { ...pl, mirror: true }).track();
  const st = new Stats();
  for (let t = 0; t <= 8.9; t += 0.1) {
    const A = jn.takeJointsOf(a.pose(t));
    const B = jn.takeJointsOf(b.pose(t));
    // B's mirror image: x → −x about the placement point, left ↔ right
    const Bm = B.map((_, j) => { const q = B[jn.MIRROR_OF[j]]; return [-q[0], q[1], q[2]]; });
    st.pose(A, Bm);
  }
  const T = st.table();
  out.mirror = T;
  console.log(`  mirrored take vs mirror image: body ${T.body_mm.mean} mm, wrists ${T.wrists_mm.mean} mm, hands ${T.hands_mm.mean} mm, elbows ${T.elbowL_deg.mean}°/${T.elbowR_deg.mean}°`);
  check(T.wrists_mm.mean <= 3 && T.body_mm.mean <= 4, `mirror: the mirrored take is the mirror image (wrists ${T.wrists_mm.mean} mm, body ${T.body_mm.mean} mm)`);
  // the side view too (the plan's sensor direction flips with the take)
  if (have('synth-throw.take-leicht.json.gz')) {
    const tl = read('synth-throw.take-leicht.json.gz');
    const pl2 = { pos: [0, 0], yaw: 0, from: -1, to: 5.9, at: 0, anchor: 0 };
    const a2 = new rt.Mocap(tl, cast.KOFI, pl2).track();
    const b2 = new rt.Mocap(tl, cast.KOFI, { ...pl2, mirror: true }).track();
    const st2 = new Stats();
    for (let t = 0; t <= 6.9; t += 0.1) {
      const A = jn.takeJointsOf(a2.pose(t));
      const B = jn.takeJointsOf(b2.pose(t));
      st2.pose(A, B.map((_, j) => { const q = B[jn.MIRROR_OF[j]]; return [-q[0], q[1], q[2]]; }));
    }
    const T2 = st2.table();
    out.mirrorThrowLeicht = T2;
    check(T2.wrists_mm.mean <= 3 && T2.body_mm.mean <= 4, `mirror (side view, light model): the mirror image (wrists ${T2.wrists_mm.mean} mm, body ${T2.body_mm.mean} mm)`);
  }
}

// ---------------------------------------------------------------- 5 holds

console.log('\n5 holds (grips from the recorded hands)');
if (coilRun) {
  const truth = coilRun.truth;
  // the synthetic coil holds from 2.0 s (1.0 s after the clap): left a coil (bundle 12 mm), right a pinch
  const holds = [{ side: 'left', from: 1.0, to: 8.2, hold: 'coil', radius: 0.012 }, { side: 'right', from: 1.0, to: 8.2, hold: 'pinch', radius: 0.0032 }];
  const mc = atOrigin(truth, truth, motions.COIL.spec, { holds });
  const track = mc.track();
  const orig = new rig.RigTrack(motions.COIL.spec, motions.COIL.rigAt, 0, 60);
  const e = [[], []], ang = [[], []], wr = [[], []];
  for (let t = 2.2; t <= 9.0; t += 0.1) {
    const p = track.pose(t);
    const o = orig.pose(t);
    for (const s of [0, 1]) {
      const g = mc.gripOf(p, t, s);
      const go = o.body.arms[s].grip;
      if (!g || !go) continue;
      e[s].push(dist(g.p, go.p) * 1000);
      ang[s].push(angle(mm.quatCols(g.q)[2], mm.quatCols(go.q)[2]));
      wr[s].push(dist(p.body.hands[s].wrist, o.body.hands[s].wrist) * 1000);
    }
  }
  const mean = (v) => r1(v.reduce((a, b) => a + b, 0) / Math.max(1, v.length));
  out.holds = { gripPointMm: [mean(e[0]), mean(e[1])], cableDirDeg: [mean(ang[0]), mean(ang[1])], wristMm: [mean(wr[0]), mean(wr[1])], samples: [e[0].length, e[1].length] };
  console.log(`  grip point vs the original grip: left (coil) ${out.holds.gripPointMm[0]} mm, right (pinch) ${out.holds.gripPointMm[1]} mm; cable direction ${out.holds.cableDirDeg[0]}° / ${out.holds.cableDirDeg[1]}°; wrists ${out.holds.wristMm[0]} / ${out.holds.wristMm[1]} mm`);
  check(e[0].length > 50 && e[1].length > 50, 'holds: both hands give a grip frame for the simulation while holding');
  check(out.holds.wristMm[0] <= 15 && out.holds.wristMm[1] <= 15, `holds: the holding hands stay where the recorded hands were (wrists ${out.holds.wristMm[0]} / ${out.holds.wristMm[1]} mm)`);
  check(mc.gripOf(track.pose(1.5), 1.5, 1) === null, 'holds: no grip before the hold');
  // suggested holds from the recorded fingers: the synthetic coil holds from 1.0 s after the clap
  const sug = [0, 1].map((s) => rt.suggestHolds(truth, s));
  out.suggestedHolds = sug;
  console.log(`  suggested holds: left ${JSON.stringify(sug[0].map((h) => [h.hold, r1(h.from), r1(h.to)]))}, right ${JSON.stringify(sug[1].map((h) => [h.hold, r1(h.from), r1(h.to)]))}`);
  // share of [a, b] the suggested holds cover
  const covers = (list, a, b) => list.reduce((s, h) => s + Math.max(0, Math.min(b, h.to) - Math.max(a, h.from)), 0) / (b - a);
  check(covers(sug[1].filter((h) => h.hold === 'pinch'), 1.5, 7.5) >= 0.7, `suggestHolds: the right hand pinches through most of the coiling (${Math.round(covers(sug[1].filter((h) => h.hold === 'pinch'), 1.5, 7.5) * 100)} %)`);
  check(covers(sug[0], 1.5, 7.5) >= 0.9, `suggestHolds: the left hand holds the coil through the coiling (${Math.round(covers(sug[0], 1.5, 7.5) * 100)} %)`);
  // hands where they were in the room (a table): the wrist targets are the recorded wrists
  const world = new rt.Mocap(truth, cast.KOFI, { pos: [0, 0], yaw: 0, from: -1, to: 8, at: 0, anchor: 0 }, { handsWorld: 1 });
  let dw = 0;
  for (let t = 0; t <= 9; t += 0.25) {
    const r = world.rigAt(t);
    const rec = world.recorded(t).p;
    dw = Math.max(dw, dist(r.hands[0].wrist, rec[9]), dist(r.hands[1].wrist, rec[10]));
  }
  check(dw < 0.002, `handsWorld 1: wrist targets = the recorded wrists (max ${r1(dw * 1000)} mm)`);
}

// ---------------------------------------------------------------- 6 time

console.log('\n6 time');
if (coilRun) {
  const truth = coilRun.truth;
  const spec = motions.COIL.spec;
  const a = new rt.Mocap(truth, spec, { from: 0, to: 6, at: 10 });
  const b = new rt.Mocap(truth, spec, { from: 0, to: 6, at: 10, speed: 0.5 });
  const w = new rt.Mocap(truth, spec, { from: 0, to: 6, warp: [[10, 0], [12, 4], [16, 6]] });
  const same = (r1_, r2_) => dist(r1_.hands[1].wrist, r2_.hands[1].wrist) < 1e-9 && Math.abs(r1_.lean - r2_.lean) < 1e-12;
  check(same(a.rigAt(11.5), b.rigAt(13)) && Math.abs(b.end - 22) < 1e-9, 'speed 0.5: twice as long, the same poses');
  check(same(a.rigAt(13), w.rigAt(11.5)) && same(a.rigAt(15), w.rigAt(14)) && same(a.rigAt(10), w.rigAt(5)), 'warp: piecewise linear, held before');
  check(same(a.rigAt(16), a.rigAt(30)), 'held after the end');
}

out.fails = fails;
fs.writeFileSync(path.join(OUT, 'mocap-retarget.json'), JSON.stringify(out, null, 1));
console.log(`\n${fails.length ? `${fails.length} FAILED:\n  ${fails.join('\n  ')}` : 'all checks passed'}  → output/simtest/mocap-retarget.json`);
await close();
process.exit(fails.length ? 1 : 0);
