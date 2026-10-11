// Tests of the "dead" XLR cable and the hand grips against reality and against the failures a
// coiling controller must not run into. Runs the physics test shots (src/shots/phys-tests.ts) and
// small experiments, measures them and checks limits (CHECK lines; exit code 1 if one fails).
//   node tools/simtest/physics.mjs [part,part,...]   (default: all)
// Parts: drape stub loop fall swing u grab lay coil roll curl slide regrip offset taut tunnel perf
// Output: output/simtest/physics-<part>.png (pictures over time), physics[-parts].summary.json
//
// Per frame for the shots: the fastest cable node and its acceleration (at 60 fps), the largest
// joint gap, and how deep the cable is inside any hand capsule (penetration, the capsules of a
// hand that holds that piece of cable left out).

import { load, snap, render, writeSummary } from './lib.mjs';

const { mods: [sim, shots, T], close } = await load('/src/sim/index.ts', '/src/shots/index.ts', '/src/shots/phys-tests.ts');
const { Rod, XLR, buildCable, bake, gripFrame } = sim;
const ALL = 'drape,stub,loop,fall,swing,u,grab,lay,coil,roll,curl,slide,regrip,offset,taut,tunnel,perf';
const parts = (process.argv[2] ?? ALL).split(',');
const out = { checks: [] };
const r3 = (v) => +(+v).toFixed(3);
const g = 9.81;
const RC = XLR.od / 2;
const SUB = XLR.substeps;
const line = (a, b, n = 200) => Array.from({ length: n + 1 }, (_, i) => [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n, a[2] + (b[2] - a[2]) * i / n]);
const minJerk = (u) => { const x = Math.min(1, Math.max(0, u)); return x * x * x * (10 - 15 * x + 6 * x * x); };

/** a limit: recorded in the summary, printed, and failing the run if not met */
function check(name, ok, value) {
  out.checks.push({ name, ok: !!ok, value });
  console.log(`CHECK ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(value)}`);
}

/** per-frame node kinematics of a rod: max speed and max acceleration (g) */
function tracker(rod) {
  const n = rod.n, X = [new Float64Array(3 * n), new Float64Array(3 * n), new Float64Array(3 * n)];
  let f = 0;
  return () => {
    X[0].set(X[1]); X[1].set(X[2]); X[2].set(rod.x);
    if (++f < 3) return { v: 0, a: 0 };
    let vm = 0, am = 0;
    for (let i = 0; i < n; i++) {
      let v2 = 0, a2 = 0;
      for (let k = 0; k < 3; k++) {
        const v = (X[2][3 * i + k] - X[1][3 * i + k]) * 60, a = (X[2][3 * i + k] - 2 * X[1][3 * i + k] + X[0][3 * i + k]) * 3600;
        v2 += v * v; a2 += a * a;
      }
      vm = Math.max(vm, Math.sqrt(v2)); am = Math.max(am, Math.sqrt(a2));
    }
    return { v: vm, a: am / g };
  };
}

/** runs a shot, with per-frame measurements and snapshots at the given times */
function run(id, { snapAt = [], each } = {}) {
  const def = shots.SHOTS[id];
  const { rod, script, tracks, vectors } = def.build();
  const fps = def.fps ?? 60;
  const n = rod.n;
  const X = [new Float64Array(3 * n), new Float64Array(3 * n), new Float64Array(3 * n)];
  const frames = [];
  const snaps = [];
  let f = 0;
  const baked = bake(rod, {
    id, duration: def.duration, fps, substeps: def.substeps, script, tracks, vectors,
    onFrame: (r, t) => {
      X[0].set(X[1]); X[1].set(X[2]); X[2].set(r.x);
      const row = { t };
      if (f >= 2) {
        let vMax = 0, aMax = 0, ke = 0;
        for (let i = 0; i < n; i++) {
          let v2 = 0, a2 = 0;
          for (let k = 0; k < 3; k++) {
            const v = (X[2][3 * i + k] - X[1][3 * i + k]) * fps, a = (X[2][3 * i + k] - 2 * X[1][3 * i + k] + X[0][3 * i + k]) * fps * fps;
            v2 += v * v; a2 += a * a;
          }
          vMax = Math.max(vMax, Math.sqrt(v2));
          aMax = Math.max(aMax, Math.sqrt(a2));
          ke += 0.5 * r.m[Math.min(i, r.ns - 1)] * v2;
        }
        Object.assign(row, { vMax, aMax_g: aMax / g, ke });
      }
      row.gap_mm = r.maxJointGap() * 1000;
      row.pen_mm = penetration(r) * 1000;
      each?.(r, t, row, f, tracks ?? {});
      frames.push(row);
      if (snapAt.some((s) => Math.abs(s - t) < 0.5 / fps)) snaps.push(snap(sim, r, '', { caps: [...r.currentCapsules()] }));
      f++;
    },
  });
  return { rod, baked, frames, snaps, def };
}

/** deepest penetration of the cable into a capsule [m] (not the capsules of a hand holding that piece) */
function penetration(r) {
  let pen = 0;
  for (const c of r.currentCapsules()) {
    if (c.r < 0) continue;
    const ax = c.b[0] - c.a[0], ay = c.b[1] - c.a[1], az = c.b[2] - c.a[2], l2 = ax * ax + ay * ay + az * az || 1;
    for (let j = 0; j < r.ns; j++) {
      if (c.group !== undefined && r.skipGroup[j] === c.group) continue;
      if (r.wc[j] === 0) continue;
      const px = r.c[3 * j] - c.a[0], py = r.c[3 * j + 1] - c.a[1], pz = r.c[3 * j + 2] - c.a[2];
      const u = Math.max(0, Math.min(1, (px * ax + py * ay + pz * az) / l2));
      const d = Math.hypot(px - ax * u, py - ay * u, pz - az * u) - c.r - r.rc;
      pen = Math.min(pen, d);
    }
  }
  return -pen;
}

const maxOf = (rows, k, a = -Infinity, b = Infinity) => rows.filter((r) => r.t >= a && r.t <= b && r[k] !== undefined).reduce((m, r) => Math.max(m, r[k]), 0);
/** first time after t0 from which vMax stays below v */
const settle = (rows, t0, v) => {
  const after = rows.filter((r) => r.t >= t0 && r.vMax !== undefined);
  for (let i = 0; i < after.length; i++) if (after.slice(i).every((r) => r.vMax < v)) return r3(after[i].t - t0);
  return null;
};
const general = (rows, baked) => ({
  vMax: r3(maxOf(rows, 'vMax')), aMax_g: r3(maxOf(rows, 'aMax_g')), gapMax_mm: r3(maxOf(rows, 'gap_mm')), penMax_mm: r3(maxOf(rows, 'pen_mm')),
  ...(baked?.stats ? { speedCapped: baked.stats.speedCapped, heldSlip: baked.stats.heldSlip, jointFixes: baked.stats.jointFixes, warnings: baked.stats.warnings.length } : {}),
});
/** the health checks every shot must pass */
function healthy(name, gen, { gap = 0.5, pen = 1.0 } = {}) {
  check(`${name}: joints closed (gap < ${gap} mm)`, gen.gapMax_mm < gap, gen.gapMax_mm);
  check(`${name}: no hand inside the cable (penetration < ${pen} mm)`, gen.penMax_mm < pen, gen.penMax_mm);
  if (gen.speedCapped !== undefined) check(`${name}: no speed cut to the cap, no held slip`, gen.speedCapped === 0 && gen.heldSlip === 0, { speedCapped: gen.speedCapped, heldSlip: gen.heldSlip });
}

// ------------------------------------------------------------------ drape (the user's photo)

if (parts.includes('drape')) {
  const res = run('phys-drape', { snapAt: [0.1, 1, 4, 12] });
  const r = res.rod, b = res.baked;
  const at = (t) => {
    const pos = new Float32Array(3 * b.n), q = new Float32Array(4 * b.ns);
    b.sample(t, pos, q);
    let top = 0;
    for (let i = 0; i < b.n; i++) if (pos[3 * i + 1] > pos[3 * top + 1]) top = i;
    const yTop = pos[3 * top + 1];
    const legX = (dir, depth) => {
      for (let i = top; i > 0 && i < b.n - 1; i += dir) {
        const j = i + dir, ya = pos[3 * i + 1] - (yTop - depth), yb = pos[3 * j + 1] - (yTop - depth);
        if (ya * yb <= 0) return pos[3 * i] + (pos[3 * j] - pos[3 * i]) * (ya / (ya - yb));
      }
      return NaN;
    };
    const c0 = Math.round(b.track('cable0', 0));
    const plugDeg = (Math.atan2(Math.abs(pos[3 * c0] - pos[0]), Math.abs(pos[3 * c0 + 1] - pos[1])) * 180) / Math.PI;
    return { sep_cm: [0.035, 0.042].map((d) => r3((legX(1, d) - legX(-1, d)) * 100)), plugDeg: r3(plugDeg) };
  };
  out.drape = { at0_5s: at(0.5), at2s: at(2), at4s: at(4), at12s: at(12), photo: 'legs ~5 cm apart (4.5-5.3), plug vertical', ...general(res.frames, b) };
  console.log('drape', JSON.stringify(out.drape));
  check('drape: legs 4.3-6 cm apart (photo ~5 cm)', out.drape.at12s.sep_cm.every((v) => v > 4.3 && v < 6), out.drape.at12s.sep_cm);
  check('drape: settled (no creep 4 s -> 12 s, < 1 mm)', Math.abs(out.drape.at12s.sep_cm[0] - out.drape.at4s.sep_cm[0]) < 0.1, [out.drape.at4s.sep_cm[0], out.drape.at12s.sep_cm[0]]);
  check('drape: plug leg within 12° of vertical (photo: vertical)', out.drape.at12s.plugDeg < 12, out.drape.at12s.plugDeg);
  healthy('drape', out.drape);
  void r;
  console.log(render('physics-drape', { title: 'phys-drape: the XLR over a finger (photo: legs ~5 cm apart, plug vertical); 0.1, 1, 4, 12 s', radius: RC, visScale: 1, views: [{ name: 'front', target: [0, 0.95, 0], dist: 0.35, yaw: 0, pitch: 0, fov: 40, grid: 0.01, gridExtent: 0 }], snapshots: res.snaps, W: 260, H: 300 }));
}

// ------------------------------------------------------------------ stub held out horizontally

if (parts.includes('stub')) {
  out.stub = {};
  for (const L of [0.15, 0.3]) {
    const { rod } = buildCable(XLR, line([-0.03, 1, 0], [L, 1, 0], 100), { plugs: 'none', groundY: null });
    rod.restFric.fill(0);
    rod.setRestStraight();
    const hold = rod.bundle({ frame: gripFrame([0, 1, 0], [1, 0, 0], [0, 1, 0]), blend: 0.001 });
    hold.add(0, 0.03, 0.001);
    const row = {};
    for (let f = 1; f <= 600; f++) {
      rod.step(1 / 60, SUB);
      if ([15, 30, 60, 120, 600].includes(f)) row[`${f / 60}s`] = r3((1 - rod.x[3 * (rod.n - 1) + 1]) * 100);
    }
    out.stub[`droop_cm_${L * 100}cm`] = row;
    check(`stub ${L * 100} cm: shape final after 2 s (creep 2 s -> 10 s < 2 mm)`, Math.abs(row['10s'] - row['2s']) < 0.2, [row['2s'], row['10s']]);
  }
  console.log('stub', JSON.stringify(out.stub));
  check('stub 15 cm droops 2-8 cm within 0.5 s (user photo still pending)', out.stub.droop_cm_15cm['0.5s'] > 2 && out.stub.droop_cm_15cm['0.5s'] < 8, out.stub.droop_cm_15cm['0.5s']);
}

// ------------------------------------------------------------------ a loop hanging from a fist

if (parts.includes('loop')) {
  // a 0.8 m loop (both ends 3.5 cm in a fist), formed round; strand memory round (a used cable,
  // rolled right) or straight (a new cable); the videos: loops from one hand ~0.5-0.7 as wide as tall
  out.loop = {};
  const Rl = 0.8 / (2 * Math.PI);
  for (const mem of ['round', 'straight']) {
    const pts = [];
    for (let a = -0.3; a <= 2 * Math.PI + 0.3; a += 0.01) pts.push([Rl * Math.sin(a), 1 - Rl + Rl * Math.cos(a), 0.0068 * a / (2 * Math.PI)]);
    const { rod } = buildCable(XLR, pts, { plugs: 'none', groundY: null });
    if (mem === 'round') rod.setRestFromCurrent(); else rod.restFric.fill(0);
    rod.setRestStraight();
    const b = rod.bundle({ frame: gripFrame([0, 1, 0], [1, 0, 0], [0, 1, 0]), hand: 0, blend: 0.001 });
    b.add(0, 0.035, 0.001);
    b.add(rod.totalLength - 0.035, rod.totalLength, 0.001);
    const row = {};
    for (let f = 1; f <= 600; f++) {
      rod.step(1 / 60, SUB);
      if ([60, 180, 600].includes(f)) {
        const mn = [9, 9, 9], mx = [-9, -9, -9];
        for (let i = 0; i < rod.n; i++) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], rod.x[3 * i + k]); mx[k] = Math.max(mx[k], rod.x[3 * i + k]); }
        row[`${f / 60}s`] = { w_cm: r3((mx[0] - mn[0]) * 100), h_cm: r3((mx[1] - mn[1]) * 100), aspect: r3((mx[0] - mn[0]) / (mx[1] - mn[1])) };
      }
    }
    out.loop[`memory_${mem}`] = row;
    check(`loop 0.8 m from a fist, memory ${mem}: aspect >= 0.55 and stable 1 s -> 10 s`, row['10s'].aspect >= 0.55 && Math.abs(row['10s'].aspect - row['1s'].aspect) < 0.02, [row['1s'].aspect, row['10s'].aspect]);
  }
  console.log('loop', JSON.stringify(out.loop));
}

// ------------------------------------------------------------------ fall: heavy = at g

if (parts.includes('fall')) {
  const { rod } = buildCable(XLR, line([-0.5, 1.0, 0], [0.5, 1.0, 0]), { plugs: 'both' });
  const mid = Math.floor(rod.n / 2);
  let t = 0, prevY = rod.x[3 * mid + 1], hit = null;
  while (t < 2 && hit === null) {
    rod.step(1 / 240, 8); t += 1 / 240;
    const y = rod.x[3 * mid + 1];
    if (y < 0.1) hit = t - (1 / 240) * ((0.1 - y) / (prevY - y));
    prevY = y;
  }
  const free = Math.sqrt((2 * 0.9) / g);
  // a hanging cable let go from a held pinch: how far its top falls in 0.3 s
  const d = buildCable(XLR, line([0, 1.5, 0], [0, 0.6, 0]), { plugs: 'end' }).rod;
  const pin = d.pinch({ frame: gripFrame([0, 1.5, 0], [0, -1, 0], [1, 0, 0]), blend: 0.01 });
  for (let f = 0; f < 60; f++) d.step(1 / 60, SUB);
  const y0 = d.x[1];
  pin.release(0.02);
  for (let f = 0; f < 18; f++) d.step(1 / 60, SUB);
  out.fall = { fall_0_9m_s: r3(hit), freeFall_s: r3(free), slower_pct: r3((hit / free - 1) * 100), dropTop_m_in_0_3s: r3(y0 - d.x[1]), dropFree_m: r3(0.5 * g * 0.09) };
  console.log('fall', JSON.stringify(out.fall));
  check('fall: a dropped cable falls at g (within 5 %)', hit / free < 1.05, out.fall.slower_pct);
  check('fall: let go from a pinch, the top falls within 10 % of free fall in 0.3 s', out.fall.dropTop_m_in_0_3s > 0.9 * out.fall.dropFree_m, out.fall.dropTop_m_in_0_3s);
}

// ------------------------------------------------------------------ swing: a held cable the hand stops

if (parts.includes('swing')) {
  // 1 m hanging from a held pinch, plug at the bottom (above the floor); the hand moves 15 cm in
  // 0.25 s and stops. The centre of mass swings out: its extrema after the stop
  const { rod } = buildCable(XLR, line([0, 1.3, 0], [0, 0.3, 0]), { plugs: 'end' });
  const hand = (t) => gripFrame([0.15 * minJerk((t - 0.5) / 0.25), 1.3, 0], [0, -1, 0], [1, 0, 0]);
  rod.pinch({ frame: hand, blend: 0.01 });
  const xs = [];
  let M = 0;
  for (let j = 0; j < rod.ns; j++) M += rod.m[j];
  for (let f = 0; f < 360; f++) {
    rod.step(1 / 60, SUB);
    let cx = 0;
    for (let j = 0; j < rod.ns; j++) cx += rod.m[j] * rod.c[3 * j];
    xs.push(cx / M);
  }
  const ext = [];
  for (let i = 46; i < xs.length - 1; i++) if ((xs[i] - xs[i - 1]) * (xs[i + 1] - xs[i]) < 0) ext.push(r3((xs[i] - 0.15) * 100));
  out.swing = { centreOfMassExtremaAfterStop_cm: ext.slice(0, 8), at3s_cm: r3((xs[179 + 45] - 0.15) * 100) };
  console.log('swing', JSON.stringify(out.swing));
  const big = ext.filter((_, i) => i >= 4).map(Math.abs);
  check('swing: calm, the third full swing is below a third of the first', ext.length < 5 || Math.max(...big) < Math.abs(ext[0]) / 3, ext.slice(0, 6));
}

// ------------------------------------------------------------------ U between two hands

if (parts.includes('u')) {
  const U = T.U;
  const res = run('phys-u', { snapAt: [0, U.tMove + 0.25, U.tMove + U.moveTime, U.tMove + U.moveTime + 0.3, U.tMove + U.moveTime + 1, 6.9] });
  const r = res.rod;
  let low = Infinity;
  for (let i = 0; i < r.n; i++) if (Math.abs(r.x[3 * i]) < U.span / 2 - 0.01) low = Math.min(low, r.x[3 * i + 1]);
  const stop = U.tMove + U.moveTime;
  const rows = res.frames;
  out.u = {
    sag_cm: r3((U.height - low) * 100),
    settle_after_stop_s: { below_5cm_s: settle(rows.filter((x) => x.t < U.tBack), stop, 0.05), below_2cm_s: settle(rows.filter((x) => x.t < U.tBack), stop, 0.02) },
    vMax_during_move: r3(maxOf(rows, 'vMax', U.tMove, stop)), handPeak_m_s: r3((1.875 * U.move) / U.moveTime),
    vMax_0_5s_after_stop: r3(maxOf(rows, 'vMax', stop + 0.5, U.tBack)),
    ...general(rows, res.baked),
  };
  console.log('u', JSON.stringify(out.u));
  check('u: settles below 5 cm/s within 1.5 s after the hand stops', out.u.settle_after_stop_s.below_5cm_s !== null && out.u.settle_after_stop_s.below_5cm_s < 1.5, out.u.settle_after_stop_s);
  healthy('u', out.u);
  console.log(render('physics-u', { title: 'phys-u: U between two pinches 60 cm apart; the right hand moves 20 cm toward the camera in 0.5 s (2.0-2.5 s) and stops', radius: RC, visScale: 1.5, views: [{ name: 'front', target: [0, 0.8, 0], dist: 1.4, yaw: 0, pitch: 5, fov: 40 }, { name: 'side', target: [0, 0.8, 0.1], dist: 1.4, yaw: 90, pitch: 5, fov: 40 }], snapshots: res.snaps, W: 260, H: 260 }));
}

// ------------------------------------------------------------------ grab and move

if (parts.includes('grab')) {
  const G = T.GRAB;
  const stop = G.tMove + G.moveTime;
  let at05 = null;
  const res = run('phys-grab', {
    snapAt: [0.4, G.tAt, G.tLift, G.tMove + 0.3, stop, stop + 0.3, stop + 0.6, G.duration],
    each: (r, t) => {
      if (Math.abs(t - (stop + 0.5)) < 0.5 / 60) at05 = Float64Array.from(r.x);
    },
  });
  const r = res.rod;
  let back = 0;
  for (let i = 0; i < r.n; i++) back = Math.max(back, Math.hypot(r.x[3 * i] - at05[3 * i], r.x[3 * i + 1] - at05[3 * i + 1], r.x[3 * i + 2] - at05[3 * i + 2]));
  out.grab = {
    gripDistance_mm: r3(res.baked.track('gripDistance', G.duration) * 1000),
    pinchSlipped_mm: r3((res.baked.track('sPinch', G.duration) - res.baked.track('sPinch', G.tAt + 0.2)) * 1000),
    handPeak_m_s: r3((1.875 * Math.hypot(...G.move)) / G.moveTime),
    cablePeak_m_s: r3(maxOf(res.frames, 'vMax', G.tMove, stop + 0.5)),
    aMax_g_during: r3(maxOf(res.frames, 'aMax_g', G.tMove, stop + 0.5)),
    settle_after_stop_s: { below_5cm_s: settle(res.frames, stop, 0.05), below_2cm_s: settle(res.frames, stop, 0.02) },
    vMax_0_5s_after_stop: r3(maxOf(res.frames, 'vMax', stop + 0.5, stop + 0.6)),
    movedAfter_0_5s_mm: r3(back * 1000),
    ...general(res.frames, res.baked),
  };
  console.log('grab', JSON.stringify(out.grab));
  check('grab: the pinch takes the cable where it is (grip distance < 1 mm)', out.grab.gripDistance_mm < 1, out.grab.gripDistance_mm);
  check('grab: settles below 5 cm/s within 0.8 s after the hand stops', out.grab.settle_after_stop_s.below_5cm_s !== null && out.grab.settle_after_stop_s.below_5cm_s < 0.8, out.grab.settle_after_stop_s);
  healthy('grab', out.grab);
  console.log(render('physics-grab', { title: `phys-grab: the hand goes down to the cable on the floor, pinches it where it is (${G.tAt}s), lifts it, moves it 50 cm in 0.6 s (${G.tMove}-${stop.toFixed(1)}s), stops`, radius: RC, visScale: 1.5, views: [{ name: 'front', target: [0.1, 0.35, 0], dist: 2.2, yaw: 0, pitch: 8, fov: 40 }, { name: 'above', target: [0.1, 0.2, 0], dist: 2.2, yaw: 30, pitch: 55, fov: 40 }], snapshots: res.snaps, W: 220, H: 240 }));
}

// ------------------------------------------------------------------ lay down a curve

if (parts.includes('lay')) {
  const Ly = T.LAY;
  const at = {};
  const res = run('phys-lay', {
    snapAt: [0.5, Ly.tLift + 0.6, (Ly.tLift + Ly.tLay) / 2, Ly.tLay, Ly.tOpen + 0.4, Ly.duration],
    each: (r, t) => {
      for (const [k, tt] of [['open', Ly.tOpen], ['open04', Ly.tOpen + 0.4]]) if (!at[k] && t >= tt - 1e-6) at[k] = Float64Array.from(r.x);
    },
  });
  const r = res.rod;
  // the laid bend: the cable behind the hand (s < LAY.s - 3 cm); the rest is the free end beyond the pads
  const diff = (A, sMax = Infinity) => {
    let m = 0, sum = 0, n = 0;
    for (let i = 0; i < r.n; i++) {
      if (r.sNode[i] > sMax) continue;
      const d = Math.hypot(r.x[3 * i] - A[3 * i], r.x[3 * i + 1] - A[3 * i + 1], r.x[3 * i + 2] - A[3 * i + 2]);
      m = Math.max(m, d);
      sum += d;
      n++;
    }
    return { max_mm: r3(m * 1000), mean_mm: r3((sum / n) * 1000) };
  };
  out.lay = {
    springBack_laidBend_fromOpening: diff(at.open, Ly.s - 0.03), springBack_laidBend_from0_4sAfter: diff(at.open04, Ly.s - 0.03),
    wholeCable_fromOpening: diff(at.open), wholeCable_from0_4sAfter: diff(at.open04),
    settle_after_open_s: settle(res.frames, Ly.tOpen, 0.02), ...general(res.frames, res.baked),
  };
  console.log('lay', JSON.stringify(out.lay));
  check('lay: the bend stays as laid (from the moment the pinch opens: max < 10 mm, mean < 3 mm)', out.lay.springBack_laidBend_fromOpening.max_mm < 10 && out.lay.springBack_laidBend_fromOpening.mean_mm < 3, out.lay.springBack_laidBend_fromOpening);
  check('lay: the whole cable moves less than 2 cm once let go', out.lay.wholeCable_fromOpening.max_mm < 20, out.lay.wholeCable_fromOpening);
  healthy('lay', out.lay);
  console.log(render('physics-lay', { title: 'phys-lay: the hand lays the cable round in a bend on the floor and lets go (3.6 s); does the bend stay?', radius: RC, visScale: 1.5, views: [{ name: 'above', target: [0.3, 0, -0.1], dist: 1.4, yaw: 0, pitch: 80, fov: 40, grid: 0.1 }], snapshots: res.snaps, W: 240, H: 240 }));
}

// ------------------------------------------------------------------ coil: pinch slide + bundle, 5 loops

if (parts.includes('coil')) {
  const C = T.COIL, B = C.beat;
  const LOOP = B.take + B.slide + B.close + B.ret + B.place + B.open;
  const loopShape = (r, sh) => {
    // loops: split the cable from the first strand to the pads at the loop tops (high points)
    const ys = Array.from({ length: r.n }, (_, i) => r.x[3 * i + 1]);
    const iEnd = Math.min(r.n - 1, r.segmentAt(sh + 0.03));
    const top = C.left[1] - 0.03;
    const segs = [];
    let cur = [];
    for (let i = 0; i < iEnd; i++) {
      cur.push(i);
      if (i > 2 && ys[i] > top && ys[i - 1] <= top) { segs.push(cur); cur = []; }
    }
    segs.push(cur);
    return segs.filter((g2) => g2.length > 40).map((g2) => {
      const mn = [9, 9, 9], mx = [-9, -9, -9];
      for (const i of g2) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], r.x[3 * i + k]); mx[k] = Math.max(mx[k], r.x[3 * i + k]); }
      const w = Math.hypot(mx[0] - mn[0], mx[2] - mn[2]);
      return { w_cm: r3(w * 100), h_cm: r3((mx[1] - mn[1]) * 100), aspect: r3(w / (mx[1] - mn[1])) };
    });
  };
  const shapes = {};
  const res = run('phys-coil', {
    snapAt: [0.3 + B.take + B.slide * 0.5, 0.3 + B.take + B.slide, 0.3 + B.take + B.slide + B.close + B.ret, 0.3 + 2 * LOOP + 0.5, 0.3 + C.loops * LOOP, C.tMoveCoil + 0.8, C.duration],
    each: (r, t, row, f, tr) => {
      for (const tt of [C.tMoveCoil, C.duration]) if (!shapes[tt] && t >= tt - 1e-6) shapes[tt] = loopShape(r, tr.sHand(r, t));
    },
  });
  const b = res.baked;
  const slip = [];
  for (let k = 0; k < C.loops; k++) {
    const t0 = 0.3 + k * LOOP + B.take;
    const s0 = b.track('sHand', t0 + 0.15), s1 = b.track('sHand', t0 + B.slide);
    const s2 = b.track('sHand', t0 + B.slide + B.close + B.ret);
    slip.push({ loop: k + 1, slid_cm: r3((s1 - s0) * 100), whileHeld_cm: r3((s2 - s1) * 100) });
  }
  out.coil = {
    loops: C.loops, slid: slip, loopShapes_whenDone: shapes[C.tMoveCoil], loopShapes_end: shapes[C.duration],
    settle_after_coil_moves_s: settle(res.frames, C.tMoveCoil + 0.8, 0.03),
    ...general(res.frames, res.baked),
  };
  console.log('coil', JSON.stringify(out.coil));
  // (the hand-over squeezes a strand between the pads and the coil: soft fingers may sink in a little)
  healthy('coil (5 loops)', out.coil, { pen: 1.5 });
  check('coil: no warnings from the hands', out.coil.warnings === 0, res.baked.stats.warnings.slice(0, 3));
  check('coil: the loose pinch slides out 55-80 cm per loop, held part slips < 1 cm', slip.every((x) => x.slid_cm > 55 && x.slid_cm < 80 && Math.abs(x.whileHeld_cm) < 1), slip);
  console.log(render('physics-coil', { title: 'phys-coil: loose pinch slides out, holds, returns; the left hand takes the strand into its bundle (5 loops), then moves the coil', radius: RC, visScale: 1.5, views: [{ name: 'front', target: [0.2, 0.6, 0], dist: 1.6, yaw: 0, pitch: 5, fov: 40 }, { name: 'side', target: [0.2, 0.6, 0], dist: 1.6, yaw: 70, pitch: 10, fov: 40 }], snapshots: res.snaps, W: 230, H: 250 }));
}

// ------------------------------------------------------------------ roll

if (parts.includes('roll')) {
  const R = T.ROLL;
  const res = run('phys-roll', {
    snapAt: [0.4, R.tRoll + 0.5, R.tRoll + R.rollTime, R.tTurn + 0.5, R.tTurn + R.turnTime, R.duration],
    each: (r, t, row) => {
      // material angle of the cable under the pads, relative to the hand, vs the commanded roll
      const f = T.rollHand(t), s = r.segmentAt(r.closestPoint(f.p).s);
      const q = [r.q[4 * s], r.q[4 * s + 1], r.q[4 * s + 2], r.q[4 * s + 3]];
      const d1 = sim.quatRotate(q, [1, 0, 0]), e1 = sim.quatRotate(f.q, [1, 0, 0]), e2 = sim.quatRotate(f.q, [0, 1, 0]);
      row.angle = Math.atan2(sim.dot(d1, e2), sim.dot(d1, e1));
    },
  });
  const a0 = res.frames.find((x) => x.t >= 0.3).angle;
  const err = res.frames.filter((x) => x.t > 0.3).map((x) => Math.abs(Math.atan2(Math.sin(x.angle - a0 - T.rollAngle(x.t)), Math.cos(x.angle - a0 - T.rollAngle(x.t)))));
  out.roll = {
    rollTrackingErrorMax_deg: r3((Math.max(...err) * 180) / Math.PI),
    twistInHangingPart_turns: { afterRoll: r3(res.baked.track('twistHanging', R.tRoll + R.rollTime + 0.3)), afterTurn: r3(res.baked.track('twistHanging', R.tTurn + R.turnTime + 0.3)), end: r3(res.baked.track('twistHanging', R.duration)) },
    ...general(res.frames, res.baked),
  };
  console.log('roll', JSON.stringify(out.roll));
  check('roll: the cable rolls with the thumb (error < 2°)', out.roll.rollTrackingErrorMax_deg < 2, out.roll.rollTrackingErrorMax_deg);
  healthy('roll', out.roll);
  console.log(render('physics-roll', { title: 'phys-roll: thumb rolls the held cable 180° (0.5-1.5 s), then the hand turns 180° (2.2-3.2 s); red = stripe (d1)', radius: RC, visScale: 2, views: [{ name: 'front', target: [0.1, 0.55, 0], dist: 1.3, yaw: 20, pitch: 10, fov: 40 }], snapshots: res.snaps, W: 220, H: 300 }));
}

// ------------------------------------------------------------------ rollToCurl: roll the remembered bend into place

if (parts.includes('curl')) {
  // a used cable (over-under memory, 0.8 m loops) hanging from a pinch at its top end: rollToCurl
  // turns the remembered bend at the pads toward +x; then the curl there must point to +x
  const { rod } = buildCable(XLR, line([0, 1.3, 0], [0, 0.2, 0], 300), { plugs: 'none', memory: { loop: 0.8 } });
  const F = gripFrame(rod.pointAt(0.03), [0, -1, 0], [0, 0, 1]);
  const pin = rod.pinch({ frame: F, s: 0.03, blend: 0.01 });
  for (let f = 0; f < 20; f++) rod.step(1 / 60, SUB);
  const want = [1, 0, 0];
  const target = pin.rollToCurl(want);
  const r0 = pin.roll(), tStart = rod.time;
  pin.setRoll((t) => r0 + (target - r0) * minJerk((t - tStart) / 0.5));
  for (let f = 0; f < 60; f++) rod.step(1 / 60, SUB);
  const c = rod.memoryCurl(pin.s), j = rod.segmentAt(pin.s);
  const fr = rod.segmentFrame(j);
  const dir = [c.n1 * fr.d1[0] + c.n2 * fr.d2[0], c.n1 * fr.d1[1] + c.n2 * fr.d2[1], c.n1 * fr.d1[2] + c.n2 * fr.d2[2]];
  out.curl = { kappa: r3(c.kappa), curlDirection: dir.map(r3), want, rolled_deg: r3(((target - r0) * 180) / Math.PI) };
  console.log('curl', JSON.stringify(out.curl));
  check('curl: rollToCurl turns the remembered bend toward the wanted direction (cos > 0.95)', sim.dot(dir, want) > 0.95, r3(sim.dot(dir, want)));
}

// ------------------------------------------------------------------ fast slides through a loose pinch

if (parts.includes('slide')) {
  out.slide = [];
  for (const T_ of [1.3, 1.0, 0.6, 0.5, 0.4]) {
    // the cable hangs from a fist at 1.1 m and lies on the floor; the right hand pinches it loosely
    // 6 cm below the fist and slides out 0.7 m to the right and down in T_ seconds
    const pts = [...line([0, 1.1, 0], [0, RC + 0.05, 0], 100), ...line([0.05, RC, 0], [2.0, RC, 0], 200).slice(1)];
    const { rod } = buildCable(XLR, pts, { plugs: 'both' });
    const fist = gripFrame([0, 1.1, 0], [0, -1, 0], [1, 0, 0]);
    const coil = rod.bundle({ frame: fist, hand: 0, blend: 0.01 });
    coil.add(0, 0.08, 0.01);
    for (let f = 0; f < 30; f++) rod.step(1 / 60, SUB);
    const start = rod.pointAt(0.14), end = [0.7, 0.85, 0];
    const t0 = rod.time + 0.05;
    const P = (t) => { const u = minJerk((t - t0) / T_); return [start[0] + (end[0] - start[0]) * u, start[1] + (end[1] - start[1]) * u, start[2]]; };
    const dl = [end[0] - start[0], end[1] - start[1], 0], ll = Math.hypot(...dl), dir = [dl[0] / ll, dl[1] / ll, 0];
    const tan0 = rod.tangentAt(0.14);
    const axis = (t) => { const u = minJerk((t - t0) / 0.3); const v = [0, 1, 2].map((k) => tan0[k] + (dir[k] - tan0[k]) * u); const n = Math.hypot(...v); return v.map((x) => x / n); };
    const frame = (t) => gripFrame(P(t), axis(t), [0, 0, 1]);
    const pin = rod.pinch({ frame, mode: 'loose', hand: 1, blend: 0.05 });
    const tr = tracker(rod);
    let lat = 0, vm = 0, am = 0, gap = 0;
    const s0 = pin.s;
    for (let f = 0; f < Math.ceil((T_ + 0.5) * 60); f++) {
      rod.step(1 / 60, SUB);
      const k = tr(); vm = Math.max(vm, k.v); am = Math.max(am, k.a);
      gap = Math.max(gap, rod.maxJointGap());
      if (!pin.lost) lat = Math.max(lat, rod.closestPoint(pin.frame().p, pin.s - 0.1, pin.s + 0.1).dist);
    }
    const row = { T: T_, handPeak_m_s: r3((1.875 * Math.hypot(end[0] - start[0], end[1] - start[1])) / T_), slid_m: r3(pin.s - s0), lost: pin.lost, padToCableMax_mm: r3(lat * 1000), cableVmax: r3(vm), aMax_g: r3(am), gap_mm: r3(gap * 1000), speedCapped: rod.stats.speedCapped, warnings: rod.warnings.length };
    out.slide.push(row);
    console.log('slide', JSON.stringify(row));
    if (T_ >= 0.5) check(`slide in ${T_} s (hand ${row.handPeak_m_s} m/s): the cable stays in the pads, slides the whole way`, !pin.lost && row.padToCableMax_mm < 3 && row.slid_m > 0.6, row);
    else check(`slide in ${T_} s: kept or reported as lost (never dragged off)`, !pin.lost ? row.padToCableMax_mm < 3 : row.warnings > 0, row);
  }
}

// ------------------------------------------------------------------ re-grip with the same pinch

if (parts.includes('regrip')) {
  out.regrip = [];
  for (const how of ['release-then-held', 'created-free-then-held']) {
    const { rod } = buildCable(XLR, line([0, 1.2, 0], [0, 0.4, 0]), { plugs: 'none', groundY: null });
    rod.pinch({ frame: gripFrame([0, 1.2, 0], [0, -1, 0], [1, 0, 0]), blend: 0.01 });
    let move = false, t1 = 0;
    const hand = (t) => gripFrame([move ? 0.2 * minJerk((t - t1) / 0.5) : 0, 0.8, 0], [0, -1, 0], [1, 0, 0]);
    const pin = rod.pinch({ frame: hand, mode: how === 'release-then-held' ? 'held' : 'free', hand: 1 });
    for (let f = 0; f < 30; f++) rod.step(1 / 60, SUB);
    if (how === 'release-then-held') pin.release(0.1);
    for (let f = 0; f < 30; f++) rod.step(1 / 60, SUB);
    const stateOpen = pin.state, levelOpen = pin.level();
    pin.set('held', 0.1);
    for (let f = 0; f < 15; f++) rod.step(1 / 60, SUB);
    move = true; t1 = rod.time;
    for (let f = 0; f < 60; f++) rod.step(1 / 60, SUB);
    const cp = rod.closestPoint(hand(rod.time).p);
    const row = { how, whileOpen: { state: stateOpen, level: r3(levelOpen) }, after: { state: pin.state, level: r3(pin.level()) }, handToCable_mm: r3(cp.dist * 1000), gripDistance_mm: r3(pin.gripDistance * 1000) };
    out.regrip.push(row);
    console.log('regrip', JSON.stringify(row));
    check(`regrip (${how}): the same pinch takes the cable again and carries it`, row.handToCable_mm < 2 && stateOpen === 'free' && levelOpen < 1e-6, row);
  }
}

// ------------------------------------------------------------------ grips made off the cable / while moving

if (parts.includes('offset')) {
  out.offset = [];
  for (const [off, vHand] of [[0, 0], [0.005, 0], [0.02, 0], [0.05, 0], [0, 1.0], [0, 2.0]]) {
    const { rod } = buildCable(XLR, line([0, 1.3, 0], [0, 0.35, 0]), { plugs: 'none' });
    rod.pinch({ frame: gripFrame([0, 1.3, 0], [0, -1, 0], [1, 0, 0]), blend: 0.01 });
    for (let f = 0; f < 60; f++) rod.step(1 / 60, SUB);
    const t0 = rod.time;
    const at = rod.closestPoint([0, 0.9, 0]).point;
    const hand = (t) => gripFrame([at[0] + off, 0.9, at[2] + vHand * (t - t0)], [0, -1, 0], [1, 0, 0]);
    const pin = rod.pinch({ frame: hand, mode: 'held', blend: 0.12, hand: 1 });
    const tr = tracker(rod);
    tr(); tr();
    let vm = 0, am = 0;
    for (let f = 0; f < 12; f++) { rod.step(1 / 60, SUB); const k = tr(); vm = Math.max(vm, k.v); am = Math.max(am, k.a); }
    const row = { offset_mm: off * 1000, handSpeed: vHand, gripDistance_mm: r3(pin.gripDistance * 1000), gripSpeed: r3(pin.gripSpeed), warnings: rod.warnings.length, cableVmax_0_2s: r3(vm), aMax_g: r3(am) };
    out.offset.push(row);
    console.log('offset', JSON.stringify(row));
    const bad = off > 0.015 || vHand > 0.5;
    check(`offset ${off * 1000} mm, hand ${vHand} m/s: ${bad ? 'reported' : 'quiet'}`, bad ? row.warnings > 0 : row.warnings === 0, row);
  }
}

// ------------------------------------------------------------------ two held pinches pulled taut

if (parts.includes('taut')) {
  const pts = [];
  for (let i = 0; i <= 300; i++) { const x = -0.3 + 0.6 * i / 300; pts.push([x, 1.0 - 0.45 * (1 - (x / 0.3) ** 2), 0]); }
  const { rod } = buildCable(XLR, pts, { plugs: 'none', groundY: 0 });
  // the hands hold it 5 cm from its ends, the pads along the cable there, and pull apart to 1.2 m
  const sa = 0.05, sb = rod.totalLength - 0.05, pa = rod.pointAt(sa), pb = rod.pointAt(sb), ta = rod.tangentAt(sa), tb = rod.tangentAt(sb);
  const Lh = (t) => gripFrame([pa[0] - (0.6 + pa[0]) * minJerk((t - 0.5) / 1.0), pa[1], 0], ta, [0, 0, 1]);
  const Rh = (t) => gripFrame([pb[0] + (0.6 - pb[0]) * minJerk((t - 0.5) / 1.0), pb[1], 0], tb, [0, 0, 1]);
  const a = rod.pinch({ frame: Lh, blend: 0.01 }), b = rod.pinch({ frame: Rh, blend: 0.01 });
  const tr = tracker(rod);
  let vm = 0, am = 0, gap = 0;
  for (let f = 0; f < 150; f++) { rod.step(1 / 60, SUB); const k = tr(); vm = Math.max(vm, k.v); am = Math.max(am, k.a); gap = Math.max(gap, rod.maxJointGap()); }
  out.taut = { cableLength_m: r3(rod.totalLength), handsEndApart_m: 1.2, sA: r3(a.s), sB: r3(b.s), lost: [a.lost, b.lost], cableVmax: r3(vm), aMax_g: r3(am), gapMax_mm: r3(gap * 1000), heldSlip: rod.stats.heldSlip, speedCapped: rod.stats.speedCapped, warnings: rod.warnings.slice(0, 3) };
  console.log('taut', JSON.stringify(out.taut));
  check('taut: pulled taut, a pinch lets go and says so (heldSlip or a warning), joints stay closed, no speed cap', (rod.stats.heldSlip > 0 || rod.warnings.length > 0) && gap < 0.0005 && rod.stats.speedCapped === 0, out.taut);
}

// ------------------------------------------------------------------ a finger through a hanging cable

if (parts.includes('tunnel')) {
  out.tunnel = [];
  for (const soft of [undefined, 0.3]) {
    for (const speed of [1, 3, 5, 10]) {
      const { rod } = buildCable(XLR, line([0, 1.3, 0], [0, 0.35, 0]), { plugs: 'none' });
      rod.pinch({ frame: gripFrame([0, 1.3, 0], [0, -1, 0], [1, 0, 0]), blend: 0.01 });
      for (let f = 0; f < 30; f++) rod.step(1 / 60, SUB);
      // a finger 7 cm long across the cable at y = 0.8, moving along +z through it
      const y = 0.8, R = 0.008, t0 = rod.time, z0 = -0.05;
      const zAt = (t) => Math.min(0.25, z0 + speed * Math.max(0, t - t0));
      rod.setCapsules((t) => [{ a: [-0.035, y, zAt(t)], b: [0.035, y, zAt(t)], r: R, soft }]);
      let deepest = 0, wrong = false;
      for (let f = 0; f < Math.ceil((0.3 / speed) * 60) + 40; f++) {
        rod.step(1 / 60, SUB);
        const z = zAt(rod.time);
        for (let j = 0; j < rod.ns; j++) {
          if (Math.abs(rod.c[3 * j]) > 0.035) continue;
          deepest = Math.max(deepest, R + RC - Math.hypot(rod.c[3 * j + 1] - y, rod.c[3 * j + 2] - z));
        }
      }
      const z = zAt(rod.time);
      for (let i = 0; i < rod.n - 1; i++) {
        const ya = rod.x[3 * i + 1] - y, yb = rod.x[3 * i + 4] - y;
        if (ya * yb <= 0 && Math.abs(rod.x[3 * i]) < 0.035 && rod.x[3 * i + 2] < z) wrong = true;
      }
      const row = { soft: soft ?? 1, speed, passedThrough: wrong, deepest_mm: r3(Math.max(0, deepest) * 1000) };
      out.tunnel.push(row);
      console.log('tunnel', JSON.stringify(row));
      if (speed <= 5) check(`tunnel: finger at ${speed} m/s (soft ${soft ?? 1}) never passes, sinks < 2.5 mm`, !wrong && row.deepest_mm < 2.5, row);
    }
  }
}

// ------------------------------------------------------------------ performance

if (parts.includes('perf')) {
  out.perf = [];
  for (const [len, seg, sub, it] of [[5, 0.01, 30, 2], [5, 0.0075, 30, 2], [5, 0.0075, 40, 2]]) {
    // a loose spiral on the floor: some self-contact, some ground contact; one hand holds the start
    const pts = [];
    let p = [0, RC, 0], h = 0;
    for (let s = 0; s < len; s += 0.002) {
      pts.push(p);
      h += 0.002 * (1.5 + 2.5 * (s / len));
      p = [p[0] + 0.002 * Math.cos(h), RC, p[2] + 0.002 * Math.sin(h)];
    }
    const { rod } = buildCable(XLR, pts, { segment: seg, iterations: it });
    rod.pinch({ frame: gripFrame(rod.pointAt(0.3), rod.tangentAt(0.3), [0, 1, 0]), blend: 0.01 });
    const t0 = performance.now();
    for (let f = 0; f < 60; f++) rod.step(1 / 60, sub);
    const wall = (performance.now() - t0) / 1000;
    const row = { nodes: rod.n, segment_mm: seg * 1000, substeps: sub, iterations: it, simSecondsPerWallSecond: r3(1 / wall), minutesFor20s: r3((20 * wall) / 60) };
    out.perf.push(row);
    console.log('perf', JSON.stringify(row));
  }
  check('perf: a 5 m XLR at the preset (7.5 mm, 30 × 2) bakes 20 s in under 5 min', out.perf[1].minutesFor20s < 5, out.perf[1].minutesFor20s);
}

const failed = out.checks.filter((c) => !c.ok);
console.log(`\n${out.checks.length - failed.length}/${out.checks.length} checks ok${failed.length ? '; FAILED: ' + failed.map((c) => c.name).join(' | ') : ''}`);
writeSummary(`physics${parts.length < ALL.split(',').length ? '-' + parts.join('-') : ''}`, out);
await close();
process.exitCode = failed.length ? 1 : 0;
