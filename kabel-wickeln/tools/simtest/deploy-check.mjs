// Checks stage 1, items 3 and 4 (laying a coil out again: src/shots/deploy-pull.ts, src/shots/throw.ts).
//
//   rings  each ring, laid out over-under and pressed exactly as in its shot (deploy-ring.ts
//          windRing), must have alternating crossings (> 0 über, < 0 unter, read from the stack), and
//          pulled apart by its ends in the air (pullApart) it must leave |Tw| < 0.3 turns, with no
//          strand passing through another on the way (Tw + Wr, the linking number of the pull,
//          never jumps by 1 or more between two checks). Control: the same ring wound the same way
//          every time (all über) must leave about one turn per loop, so the check can tell the two
//          apart.
//   bakes  the baked shots (bakes/deploy-pull.bin, bakes/throw.bin), every point a hard fail:
//          - no capped speeds, no held-pinch slips, no warnings (what the simulation says about itself);
//          - no strand passage: Tw + Wr never jumps by 1 or more between two frames (a passage changes
//            it by ±2 at once), and (throw, from the release on) no pair of segments closer than one
//            cable diameter whose pair writhe flips sign between two frames;
//          - Ilse: at the end |Tw| < 0.3 and |Wr| < 0.3 turns, no bend tighter than 10 cable
//            diameters (the plugs' last 3 cm aside);
//          - Kofi: the cable on the floor without a single self-crossing of its floor plan (a curl or
//            a knot always has one), no bend tighter than 10 cable diameters (the last 5 cm before
//            each plug aside), no 2 m of it twisted by 0.5 turns or more; the flying ring round
//            (width / height ≥ 0.85, 0.2 and 0.4 s after the release); the cable comes off its back
//            face (the node being let go lies in the rear half of the ring, along the throw).
//
//   node tools/simtest/deploy-check.mjs [rings|bakes|all] [short|long|both]
// Output: output/simtest/deploy-check.summary.json

import fs from 'node:fs';
import path from 'node:path';
import { load, writeSummary, r4 } from './lib.mjs';

const what = process.argv[2] ?? 'all';
const which = process.argv[3] ?? 'both';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const { mods: [sim, ring, pull, thr], close } = await load('/src/sim/index.ts', '/src/shots/deploy-ring.ts', '/src/shots/deploy-pull.ts', '/src/shots/throw.ts');
const out = { rings: [], bakes: [] };
let ok = true;
const say = (pass, text) => console.log(`${pass ? 'ok  ' : 'FAIL'} ${text}`);

if (what !== 'bakes') {
  const cases = [];
  if (which !== 'long') cases.push({ name: 'short (Ilse)', spec: pull.SHORT_RING, T: 4.6, substeps: 30 });
  if (which !== 'short') cases.push({ name: 'long (Kofi)', spec: thr.LONG_RING, T: 9, substeps: 30 });
  for (const c of cases) {
    for (const sameWay of [false, true]) {
      const spec = sameWay ? { ...c.spec, pattern: 'o'.repeat(c.spec.pattern.length) } : c.spec;
      const t0 = Date.now();
      const r = ring.windRing(spec);
      const rod0 = ring.ringRod(r, r.state, spec);
      const cr = ring.crossings(rod0, r);
      // (each value is a vote over the loop's nodes: its sign says on which side the following cable passes)
      const alternate = cr.every((v, k) => (sameWay ? v > 0 : k % 2 === 0 ? v > 0 : v < 0));
      let lk0 = null, jump = 0;
      const res = ring.pullApart(r, spec, {
        T: c.T, substeps: c.substeps, onFrame: (rod, t) => {
          if (Math.round(t * 60) % 6) return;
          const lk = rod.twistTurns() + rod.writhe();
          if (lk0 !== null) jump = Math.max(jump, Math.abs(lk - lk0));
          lk0 = lk;
        },
      });
      const pass = sameWay ? res.Tw > 0.75 * spec.pattern.length : Math.abs(res.Tw) < 0.3 && alternate && jump < 1;
      ok &&= pass;
      const row = { ring: c.name, pattern: spec.pattern, crossings: cr.map(r4), alternate, Tw: r4(res.Tw), Wr: r4(res.Wr), maxLinkJump: r4(jump), capped: res.capped, warnings: res.warnings, pass, seconds: r4((Date.now() - t0) / 1000) };
      out.rings.push(row);
      say(pass, `${c.name.padEnd(13)} ${spec.pattern.padEnd(17)} crossings ${row.crossings.join(' ')}  pulled apart: Tw ${row.Tw.toFixed(2)}  Wr ${row.Wr.toFixed(2)}  link jump ${row.maxLinkJump}  (${row.seconds} s)`);
    }
  }
}

// ------------------------------------------------------------------ helpers for the bakes

const readBake = (id) => {
  const file = path.join(ROOT, 'bakes', `${id}.bin`);
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  const baked = sim.BakedRod.fromBinary(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const meta = fs.existsSync(file.replace(/\.bin$/, '.json')) ? JSON.parse(fs.readFileSync(file.replace(/\.bin$/, '.json'), 'utf8')) : {};
  return { baked, meta };
};
const positions = (b, t) => {
  const x = new Float32Array(3 * b.n), d = new Float32Array(3 * b.n);
  b.frameSample(t, x, d);
  return x;
};
/** the largest jump of Tw + Wr between two recorded frames in [t0, t1] */
const lkJumps = (b, t0, t1) => {
  let prev = null, max = 0, at = -1;
  for (let f = Math.round(t0 * b.fps); f <= Math.round(t1 * b.fps); f++) {
    const t = f / b.fps, lk = b.track('twist', t) + b.track('writhe', t);
    if (prev !== null && Math.abs(lk - prev) > max) { max = Math.abs(lk - prev); at = t; }
    prev = lk;
  }
  return { max, at };
};
/** tightest bend radius (m) of nodes i0..i1 at positions x, from three nodes `span` apart */
const tightest = (x, i0, i1, span = 3) => {
  let best = { R: Infinity, i: -1 };
  for (let i = i0 + span; i <= i1 - span; i++) {
    const a = [x[3 * (i - span)], x[3 * (i - span) + 1], x[3 * (i - span) + 2]], c = [x[3 * i], x[3 * i + 1], x[3 * i + 2]], e = [x[3 * (i + span)], x[3 * (i + span) + 1], x[3 * (i + span) + 2]];
    const ab = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]), bc = Math.hypot(e[0] - c[0], e[1] - c[1], e[2] - c[2]), ca = Math.hypot(a[0] - e[0], a[1] - e[1], a[2] - e[2]);
    const u = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], v = [e[0] - a[0], e[1] - a[1], e[2] - a[2]];
    const area2 = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
    const R = area2 > 1e-12 ? (ab * bc * ca) / (2 * area2) : Infinity;
    if (R < best.R) best = { R, i };
  }
  return best;
};
/** pair writhe of segments i, j (Klenin–Langowski) */
function pairW(x, i, j) {
  const P = (k) => [x[3 * k], x[3 * k + 1], x[3 * k + 2]];
  const [p1, p2, p3, p4] = [P(i), P(i + 1), P(j), P(j + 1)];
  const s = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const c = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const n = (a) => { const l = Math.hypot(...a); return l < 1e-15 ? null : a.map((v) => v / l); };
  const d = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const r13 = s(p3, p1), r14 = s(p4, p1), r23 = s(p3, p2), r24 = s(p4, p2);
  const n1 = n(c(r13, r14)), n2 = n(c(r14, r24)), n3 = n(c(r24, r23)), n4 = n(c(r23, r13));
  if (!n1 || !n2 || !n3 || !n4) return 0;
  const as = (v) => Math.asin(Math.max(-1, Math.min(1, v)));
  const om = as(d(n1, n2)) + as(d(n2, n3)) + as(d(n3, n4)) + as(d(n4, n1));
  return (2 * om * Math.sign(d(c(s(p4, p3), s(p2, p1)), r13))) / (4 * Math.PI);
}
const segDist = (x, i, j) => {
  let m = Infinity;
  for (const a of [0, 0.25, 0.5, 0.75, 1]) for (const c of [0, 0.25, 0.5, 0.75, 1]) {
    const p = [0, 1, 2].map((k) => x[3 * i + k] + (x[3 * i + 3 + k] - x[3 * i + k]) * a), q = [0, 1, 2].map((k) => x[3 * j + k] + (x[3 * j + 3 + k] - x[3 * j + k]) * c);
    m = Math.min(m, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
  }
  return m;
};
/** strand passages between t0 and t1: segment pairs closer than `near` whose pair writhe flips sign between two frames */
const passages = (b, i0, i1, t0, t1, near) => {
  const pairs = (x) => {
    const cell = 0.02, g = new Map(), m = new Map();
    const key = (i) => `${Math.floor(x[3 * i] / cell)},${Math.floor(x[3 * i + 1] / cell)},${Math.floor(x[3 * i + 2] / cell)}`;
    for (let i = i0; i < i1; i++) { const k = key(i); (g.get(k) ?? g.set(k, []).get(k)).push(i); }
    for (let i = i0; i < i1; i++) {
      const cx = Math.floor(x[3 * i] / cell), cy = Math.floor(x[3 * i + 1] / cell), cz = Math.floor(x[3 * i + 2] / cell);
      for (let a = -1; a <= 1; a++) for (let bb = -1; bb <= 1; bb++) for (let c = -1; c <= 1; c++) {
        const l = g.get(`${cx + a},${cy + bb},${cz + c}`);
        if (!l) continue;
        for (const j of l) if (j > i + 2) m.set(i * 100000 + j, pairW(x, i, j));
      }
    }
    return m;
  };
  const found = [];
  let prev = null, prevX = null;
  for (let f = Math.round(t0 * b.fps); f <= Math.round(t1 * b.fps); f++) {
    const t = f / b.fps, x = positions(b, t), P = pairs(x);
    if (prev) for (const [k, v] of P) {
      const v0 = prev.get(k);
      if (v0 === undefined || Math.abs(v - v0) < 0.25 || Math.sign(v) === Math.sign(v0)) continue;
      const i = Math.floor(k / 100000), j = k % 100000;
      if (segDist(x, i, j) < near && segDist(prevX, i, j) < near) found.push({ t: r4(t), i, j, from: r4(v0), to: r4(v) });
    }
    prev = P;
    prevX = x;
  }
  return found;
};

if (what !== 'rings') {
  // ---------------------------------------------------------------- Ilse
  const A = readBake('deploy-pull');
  if (!A) { say(false, 'deploy-pull: no bake'); ok = false; }
  else {
    const { baked: b, meta } = A, T = pull.PULL_T, t = Math.min(T.end, b.duration);
    const i0 = Math.round(b.track('cable0', 0)), i1 = Math.round(b.track('cable1', 0));
    const jump = lkJumps(b, 0, t), x = positions(b, t);
    const plugCut = Math.round(0.03 / (pull.SHORT_RING.cable.segment ?? 0.006));
    const bend = tightest(x, i0 + plugCut, i1 - plugCut);
    const row = { id: 'deploy-pull', speedCapped: meta.speedCapped, heldSlip: meta.heldSlip, warnings: meta.warnings, maxJointGap_mm: meta.maxJointGap_mm, twist: r4(b.track('twist', t)), writhe: r4(b.track('writhe', t)), maxLinkJump: r4(jump.max), tightestBend_cm: r4(bend.R * 100) };
    const d = pull.SHORT_RING.cable.od;
    row.pass = (meta.speedCapped ?? 1) === 0 && (meta.heldSlip ?? 1) === 0 && !(meta.warnings?.length) && Math.abs(row.twist) < 0.3 && Math.abs(row.writhe) < 0.3 && jump.max < 1 && bend.R >= 10 * d;
    ok &&= row.pass;
    out.bakes.push(row);
    say(row.pass, `deploy-pull  capped ${row.speedCapped}  slips ${row.heldSlip}  warnings ${row.warnings?.length ?? '?'}  gap ${row.maxJointGap_mm} mm  end: Tw ${row.twist}  Wr ${row.writhe}  largest Tw+Wr jump ${row.maxLinkJump}  tightest bend ${row.tightestBend_cm} cm`);
  }

  // ---------------------------------------------------------------- Kofi
  const B = readBake('throw');
  if (!B) { say(false, 'throw: no bake'); ok = false; }
  else {
    const { baked: b, meta } = B, T = thr.THROW_T, tEnd = Math.min(T.end, b.duration);
    const i0 = Math.round(b.track('cable0', 0)), i1 = Math.round(b.track('cable1', 0));
    const { ring: R } = thr.longRing();
    const sNode = [0];
    for (let j = 0; j < R.state.L.length; j++) sNode.push(sNode[j] + R.state.L[j]);
    const sR0 = R.sLoops[thr.RING_FIRST][0], sR1 = R.sLoops[R.sLoops.length - 1][1];
    const nodeAt = (s) => { let i = 0; while (i < sNode.length - 1 && sNode[i] < s) i++; return i; };
    const n0 = nodeAt(sR0), n1 = nodeAt(sR1);
    // the flying ring: round? the cable comes off its back face?
    const ringShape = (t) => {
      const x = positions(b, t), sp = sR0 + b.track('peel', t) * (sR1 - sR0), np = nodeAt(sp);
      let ax0 = Infinity, ax1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = np; i <= n1; i++) {
        ax0 = Math.min(ax0, x[3 * i]); ax1 = Math.max(ax1, x[3 * i]);
        y0 = Math.min(y0, x[3 * i + 1]); y1 = Math.max(y1, x[3 * i + 1]);
        z0 = Math.min(z0, x[3 * i + 2]); z1 = Math.max(z1, x[3 * i + 2]);
      }
      // where the node being let go lies along the throw: 0 = the ring's back face, 1 = its front
      const back = (x[3 * np] - ax0) / Math.max(1e-6, ax1 - ax0);
      return { width: z1 - z0, height: y1 - y0, round: (z1 - z0) / Math.max(1e-6, y1 - y0), back, inRing: n1 - np };
    };
    const shapes = [0.2, 0.4, 0.6].map((dt) => ({ dt, ...ringShape(T.release + dt) }));
    const round = Math.min(shapes[0].round, shapes[1].round);
    const backs = [];
    for (let t = T.release + 0.1; t < T.land - 0.15; t += 0.05) { const s = ringShape(t); if (s.inRing > 20) backs.push(s.back); }
    const backFace = backs.length ? backs.filter((v) => v <= 0.5).length / backs.length : 0;
    // passages: Tw + Wr per frame over the whole shot, pair writhe flips from the release on
    const jump = lkJumps(b, 0, tEnd), jumpFree = lkJumps(b, T.release, tEnd);
    const pass = passages(b, i0, i1, T.release, Math.min(tEnd, T.land + 1.2), thr.LONG_RING.cable.od);
    const row = {
      id: 'throw', speedCapped: meta.speedCapped, heldSlip: meta.heldSlip, warnings: meta.warnings, maxJointGap_mm: meta.maxJointGap_mm,
      twist: r4(b.track('twist', tEnd)), writhe: r4(b.track('writhe', tEnd)), maxLinkJump: r4(jump.max), maxLinkJumpAt: r4(jump.at), maxLinkJumpFlight: r4(jumpFree.max), passages: pass.length, passageList: pass.slice(0, 10),
      curls: b.track('curls', tEnd), minBend_cm: r4(b.track('minBend', tEnd) * 100), twistMax2m: r4(b.track('twistMax', tEnd)),
      ringRound: shapes.map((s) => ({ dt: s.dt, width_cm: r4(s.width * 100), height_cm: r4(s.height * 100), round: r4(s.round) })), backFace: r4(backFace),
    };
    const d = thr.LONG_RING.cable.od;
    row.pass = (meta.speedCapped ?? 1) === 0 && (meta.heldSlip ?? 1) === 0 && !(meta.warnings?.length) && jump.max < 1 && pass.length === 0 && row.curls === 0 && b.track('minBend', tEnd) >= 10 * d && row.twistMax2m < 0.5 && round >= 0.85 && backFace >= 0.9;
    ok &&= row.pass;
    out.bakes.push(row);
    say(row.pass, `throw        capped ${row.speedCapped}  slips ${row.heldSlip}  warnings ${row.warnings?.length ?? '?'}  gap ${row.maxJointGap_mm} mm  largest Tw+Wr jump ${row.maxLinkJump} (at ${row.maxLinkJumpAt} s; from the release on ${row.maxLinkJumpFlight})  pair-writhe passages ${row.passages}`);
    say(row.pass, `             floor: curls ${row.curls}  tightest bend ${row.minBend_cm} cm  most twist in 2 m ${row.twistMax2m} turns  end Tw ${row.twist} Wr ${row.writhe}`);
    say(row.pass, `             flying ring w/h ${shapes.map((s) => `${r4(s.width * 100)}/${r4(s.height * 100)} cm = ${r4(s.round)}`).join(', ')}  cable comes off the back half ${r4(backFace * 100)} % of the time`);
  }
}

writeSummary('deploy-check', out);
await close();
process.exit(ok ? 0 : 1);
