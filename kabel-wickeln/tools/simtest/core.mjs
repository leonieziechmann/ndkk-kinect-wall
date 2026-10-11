// Core checks of src/sim against the prototype (scratchpad rodsim/test_core.js, calib.js):
// determinism, bake/binary round trip (with recorded vectors), performance table, cantilever
// stiffness calibration (also per bending axis), documented grips, swivel grips.
//
// Bit-identity with the prototype held until the "dead cable" work (src/sim/cables.ts): friction
// now acts on the centre lines and only rolls the segments (rod.ts contact()), which changes the
// scenario's self-contacts. REFERENCE_HASH is the hash of the current model; a change of it means
// the simulation's results changed.
//   node tools/simtest/core.mjs [determinism,binary,perf,calib,grips,swivel]

import { createHash } from 'node:crypto';
import { load, snap, render, writeSummary, smooth, r4 } from './lib.mjs';

const { mods: [sim], close } = await load('/src/sim/index.ts');
const { Rod, bake, BakedRod, quatFromAxisAngle, gripFrame } = sim;
const parts = (process.argv[2] ?? 'determinism,binary,perf,calib,grips,swivel').split(',');
/** SHA-1 of the prototype's 4 s bake of the same scenario (scratchpad rodsim/out/core.summary.json) */
const PROTOTYPE_HASH = '95d4bc1ad0f7689a9235019ffbf77cabf08ceb65';
/** SHA-1 of the same bake with the current model (friction on the centre lines) */
const REFERENCE_HASH = 'a9df02030cf19407ab9607540d23c93c801fcb81';
const out = {};

/** The prototype's test scenario: 1.5 m XLR, right end twisted 3 turns, then the ends approach. */
function scenario(N, opts = {}) {
  const L = 1.5, H = 1;
  const rod = Rod.straight([-L / 2, H, 0], [L / 2, H, 0], N, { damping: 1, ...opts });
  const xpos = (s, t) => s * (L / 2 - 0.01 - (L / 2 - 0.175) * smooth((t - 1.7) / 2));
  rod.addGrip({ nodes: [0, 2], keepShape: true, frame: (t) => ({ p: [xpos(-1, t), H, 0], q: [0, 0, 0, 1] }) });
  rod.addGrip({ nodes: [N - 3, N - 1], keepShape: true, frame: (t) => ({ p: [xpos(1, t), H, 0], q: quatFromAxisAngle(1, 0, 0, 6 * Math.PI * smooth(t / 1.5)) }) });
  return rod;
}
const hashOf = (b) => createHash('sha1').update(Buffer.from(b.pos.buffer)).update(Buffer.from(b.quat.buffer)).digest('hex');

if (parts.includes('determinism')) {
  const hashes = [];
  for (let k = 0; k < 2; k++) hashes.push(hashOf(bake(scenario(101), { duration: 4 })));
  out.determinism = { hashes, identical: hashes[0] === hashes[1], reference: REFERENCE_HASH, identicalToReference: hashes[0] === REFERENCE_HASH, identicalToPrototype: hashes[0] === PROTOTYPE_HASH };
  console.log('determinism', JSON.stringify(out.determinism));
}

if (parts.includes('binary')) {
  const hand = (t) => gripFrame([0.1 * t, 1, 0], [1, 0, 0], [0, Math.cos(t), Math.sin(t)]);
  const b = bake(scenario(101), {
    id: 'core', duration: 4, tracks: { twist: (r) => r.twistTurns(), writhe: (r) => r.writhe() },
    vectors: { hand: sim.frameTrack((_, t) => hand(t)), caps: sim.capsuleTrack(2, (_, t) => [{ a: [t, 0, 0], b: [t, 1, 0], r: 0.01 }]) },
  });
  const bin = b.toBinary();
  const b2 = BakedRod.fromBinary(bin);
  let maxPosErr = 0, maxD1Err = 0, maxTrackErr = 0, maxVecErr = 0;
  const n = b.n;
  const pa = new Float32Array(3 * n), pb = new Float32Array(3 * n), da = new Float32Array(3 * n), db = new Float32Array(3 * n);
  for (const t of [0, 0.51, 1.234, 2.5, 3.999]) {
    b.frameSample(t, pa, da);
    b2.frameSample(t, pb, db);
    for (let i = 0; i < 3 * n; i++) {
      maxPosErr = Math.max(maxPosErr, Math.abs(pa[i] - pb[i]));
      maxD1Err = Math.max(maxD1Err, Math.abs(da[i] - db[i]));
    }
    for (const k of ['twist', 'writhe']) maxTrackErr = Math.max(maxTrackErr, Math.abs(b.track(k, t) - b2.track(k, t)));
    // vectors: the frame comes back (interpolated, quaternion normalised), the capsules too
    const f = b2.frame('hand', t), want = hand(t), c = b2.capsules('caps', t);
    maxVecErr = Math.max(maxVecErr, Math.hypot(f.p[0] - want.p[0], f.p[1] - want.p[1], f.p[2] - want.p[2]), Math.abs(Math.abs(sim.dot([f.q[0], f.q[1], f.q[2]], [want.q[0], want.q[1], want.q[2]]) + f.q[3] * want.q[3]) - 1), Math.abs(c[0].a[0] - t), c.length - 1);
  }
  out.binary = {
    frames: b.frames, nodes: n, float32Bytes: b.pos.byteLength + b.quat.byteLength, fileBytes: bin.byteLength,
    maxPosErr_m: maxPosErr, maxD1Err, maxTrackErr, maxVectorErr: maxVecErr, header: { id: b2.id, fps: b2.fps, tracks: b2.trackNames, vectors: b2.vectorNames },
    trackEnd: { twist: r4(b2.track('twist', 4)), writhe: r4(b2.track('writhe', 4)) },
  };
  console.log('binary', JSON.stringify(out.binary));
}

if (parts.includes('perf')) {
  out.perf = [];
  for (const [N, SUB, IT] of [[101, 30, 2], [151, 30, 2], [151, 30, 1], [151, 15, 2], [301, 30, 2], [301, 20, 1]]) {
    const rod = scenario(N, { iterations: IT });
    const t0 = performance.now();
    for (let f = 0; f < 150; f++) rod.step(1 / 60, SUB);
    const dt = (performance.now() - t0) / 1000;
    const row = { nodes: N, substeps: SUB, iterations: IT, simSecondsPerWallSecond: +(2.5 / dt).toFixed(3), usPerNodeSubstep: +((dt * 1e6) / (N * SUB * 150)).toFixed(2) };
    out.perf.push(row);
    console.log('perf', JSON.stringify(row));
  }
}

/** Clamped horizontal cantilever: stiffness factor = (w L⁴ / 8 EI) / tip deflection (1 = exact). */
function cantilever(N, { EI = 2e-3, EIref = EI, up, documented = false, ...o } = {}) {
  const L = 0.15, rho = 0.05;
  const rod = Rod.straight([0, 1, 0], [L, 1, 0], N, { EI, GJ: 1.5e-3, linearDensity: rho, damping: 3, up, ...o });
  const frame = documented ? gripFrame([L / (N - 1) / 2, 1, 0], [1, 0, 0], up ?? [0, 1, 0]) : { p: [0, 1, 0], q: [0, 0, 0, 1] };
  rod.addGrip({ nodes: [0, 1], keepShape: !documented, frame: () => frame });
  for (let f = 0; f < 300; f++) rod.step(1 / 60, 30);
  const d = 1 - rod.x[3 * (N - 1) + 1];
  const Lf = L - L / (N - 1);
  return (rho * 9.81 * Lf ** 4) / (8 * EIref) / d;
}

if (parts.includes('calib')) {
  out.calib = {
    isotropic: Object.fromEntries([16, 31, 61].map((N) => [`${N - 1} segments`, r4(cantilever(N))])),
    documentedGrip31: r4(cantilever(31, { documented: true })),
    // EI1 = 2e-3, EI2 = 2e-2: with d1 up, gravity bends about d2 (EI2); with d1 horizontal about d1 (EI1)
    perAxis: {
      d1Up_usesEI2: r4(cantilever(31, { EI1: 2e-3, EI2: 2e-2, EIref: 2e-2, up: [0, 1, 0] })),
      d1Horizontal_usesEI1: r4(cantilever(31, { EI1: 2e-3, EI2: 2e-2, EIref: 2e-3, up: [0, 0, 1] })),
    },
  };
  console.log('calib', JSON.stringify(out.calib));
}

if (parts.includes('grips')) {
  // documented grips: held part straight along d3 through p, material frame = grip frame; rolling
  // the right hand 2 turns about the cable axis gives Tw = 2. The left frame starts 3 cm off the
  // cable: the held part blends into it.
  const N = 101, L = 1.0, H = 1;
  const rod = Rod.straight([-L / 2, H, 0], [L / 2, H, 0], N, { damping: 1 });
  const seg = L / (N - 1);
  const left = (t) => gripFrame([-L / 2 + seg, H + 0.03, 0], [1, 0, 0], [0, 1, 0]);
  const right = (t) => {
    const a = 4 * Math.PI * smooth(t / 1.2);
    return gripFrame([L / 2 - seg, H, 0], [1, 0, 0], [0, Math.cos(a), Math.sin(a)]);
  };
  rod.addGrip({ nodes: [0, 2], frame: left });
  rod.addGrip({ nodes: [N - 3, N - 1], frame: right });
  const log = [];
  bake(rod, { duration: 1.5, onFrame: (r, t, f) => f % 30 === 0 && log.push({ t: r4(t), Tw: r4(r.twistTurns()) }) });
  // held segments vs frame: centre of nodes 0..2 at p, d1 of segment N-2 = frame d1
  const fl = left(rod.time), fr = right(rod.time);
  const mid = [rod.x[3], rod.x[4], rod.x[5]];
  const segR = rod.segmentFrame(N - 2).d1, frD1 = sim.quatRotate(fr.q, [1, 0, 0]);
  out.grips = {
    Tw_after_2_turns: r4(rod.twistTurns()), log,
    leftCentreError_m: +Math.hypot(mid[0] - fl.p[0], mid[1] - fl.p[1], mid[2] - fl.p[2]).toExponential(2),
    rightStripeVsFrameD1: r4(sim.dot(segR, frD1)),
  };
  console.log('grips', JSON.stringify(out.grips));
}

if (parts.includes('swivel')) {
  // a 1 m cable between two hands 0.9 m apart; the right hand rolls 2 turns (0-1 s). At 1.5 s the
  // left hand changes its grip: 'held' keeps it, 'swivel' lets the cable spin in the hand, 'released'
  // lets the end hang free. The twist should stay in 'held' and run out in the other two.
  out.swivel = {};
  const snaps = [];
  for (const variant of ['held', 'swivel', 'released']) {
    const N = 101, L = 1.0, H = 1.2, seg = L / (N - 1);
    const rod = Rod.straight([-L / 2, H, 0], [L / 2, H, 0], N, { damping: 1 });
    const xl = (t) => -L / 2 + seg + 0.05 * smooth(t / 1);
    const left = (t) => gripFrame([xl(t), H, 0], [1, 0, 0], [0, 1, 0]);
    const right = (t) => {
      const a = 4 * Math.PI * smooth(t / 1);
      return gripFrame([-xl(t), H, 0], [1, 0, 0], [0, Math.cos(a), Math.sin(a)]);
    };
    let lid = rod.addGrip({ nodes: [0, 2], frame: left });
    rod.addGrip({ nodes: [N - 3, N - 1], frame: right });
    const log = [];
    bake(rod, {
      duration: 5,
      script: (r, t) => {
        if (lid && t >= 1.5 && variant !== 'held') {
          r.releaseGrip(lid);
          lid = variant === 'swivel' ? r.addGrip({ nodes: [0, 2], frame: left, swivel: true }) : 0;
        }
      },
      onFrame: (r, t, f) => {
        if (f % 30 === 0) log.push({ t: r4(t), Tw: r4(r.twistTurns(2, r.ns - 3)) });
        if ([1.5, 2.5, 5].some((x) => Math.abs(x - t) < 1e-6)) snaps.push(snap(sim, r, variant));
      },
    });
    out.swivel[variant] = { Tw_at_1_5: log.find((e) => e.t === 1.5).Tw, Tw_at_2_5: log.find((e) => e.t === 2.5).Tw, Tw_end: log[log.length - 1].Tw, log };
    console.log('swivel', variant, JSON.stringify({ ...out.swivel[variant], log: undefined }));
  }
  const views = [{ name: 'front', target: [0, 0.95, 0], dist: 1.3, yaw: 0, pitch: 5, fov: 45 }, { name: 'side', target: [0, 0.95, 0], dist: 1.3, yaw: 60, pitch: 20, fov: 45 }];
  console.log(render('swivel', { title: 'Swivel: right hand rolls 2 turns (0-1 s); at 1.5 s the left hand holds (1-3), swivels (4-6) or lets go (7-9). Red stripe = d1', radius: 0.0035, visScale: 2, views, snapshots: snaps, W: 220, H: 220 }));
}

writeSummary(`core${parts.length < 6 ? '-' + parts.join('-') : ''}`, out);
await close();
