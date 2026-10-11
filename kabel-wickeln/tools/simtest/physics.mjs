// Tests of the "dead" XLR cable and the hand grips against reality: runs the physics test shots
// (src/shots/phys-tests.ts) and measures them.
//   node tools/simtest/physics.mjs [drape,u,grab,lay,coil,roll,cantilever,tunnel,perf]
// Output: output/simtest/physics-<part>.png (pictures over time), physics.summary.json
//
// Per frame for every shot: the fastest cable node and its acceleration (at 60 fps), the largest
// joint gap, and how deep the cable is inside any hand capsule (penetration, the capsules of a
// hand that holds that piece of cable left out).

import { load, snap, render, writeSummary } from './lib.mjs';

const { mods: [sim, shots, T], close } = await load('/src/sim/index.ts', '/src/shots/index.ts', '/src/shots/phys-tests.ts');
const { Rod, XLR, buildCable, bake } = sim;
const parts = (process.argv[2] ?? 'drape,u,grab,lay,coil,roll,cantilever,tunnel,perf').split(',');
const out = {};
const r3 = (v) => +v.toFixed(3);
const g = 9.81;

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
      row.gap_mm = r.maxStrain() * r.L[1] * 1000;
      // penetration into capsules (not those of a hand holding that piece)
      let pen = 0;
      for (const c of r.currentCapsules()) {
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
      row.pen_mm = -pen * 1000;
      each?.(r, t, row, f);
      frames.push(row);
      if (snapAt.some((s) => Math.abs(s - t) < 0.5 / fps)) snaps.push(snap(sim, r, '', { caps: [...r.currentCapsules()] }));
      f++;
    },
  });
  return { rod, baked, frames, snaps, def };
}

const maxOf = (rows, k, a = -Infinity, b = Infinity) => rows.filter((r) => r.t >= a && r.t <= b && r[k] !== undefined).reduce((m, r) => Math.max(m, r[k]), 0);
/** first time after t0 from which vMax stays below v */
const settle = (rows, t0, v) => {
  const after = rows.filter((r) => r.t >= t0 && r.vMax !== undefined);
  for (let i = 0; i < after.length; i++) if (after.slice(i).every((r) => r.vMax < v)) return r3(after[i].t - t0);
  return null;
};
const general = (rows) => ({ vMax: r3(maxOf(rows, 'vMax')), aMax_g: r3(maxOf(rows, 'aMax_g')), gapMax_mm: r3(maxOf(rows, 'gap_mm')), penMax_mm: r3(maxOf(rows, 'pen_mm')) });

// ------------------------------------------------------------------ drape

if (parts.includes('drape')) {
  const res = run('phys-drape', { snapAt: [0.1, 1, 4] });
  const r = res.rod;
  let top = 0;
  for (let i = 0; i < r.n; i++) if (r.x[3 * i + 1] > r.x[3 * top + 1]) top = i;
  const yTop = r.x[3 * top + 1];
  const legX = (dir, depth) => {
    for (let i = top; i > 0 && i < r.n - 1; i += dir) {
      const j = i + dir, ya = r.x[3 * i + 1] - (yTop - depth), yb = r.x[3 * j + 1] - (yTop - depth);
      if (ya * yb <= 0) return r.x[3 * i] + (r.x[3 * j] - r.x[3 * i]) * (ya / (ya - yb));
    }
    return NaN;
  };
  out.drape = { separation_cm_at_3_5_and_4_2_cm: [0.035, 0.042].map((d) => r3((legX(1, d) - legX(-1, d)) * 100)), photo_cm: 5.3, ...general(res.frames) };
  console.log('drape', JSON.stringify(out.drape));
  console.log(render('physics-drape', { title: 'phys-drape: the XLR over a finger (photo: legs 5.3 cm apart)', radius: RC(), visScale: 1, views: [{ name: 'front', target: [0, 0.95, 0], dist: 0.35, yaw: 0, pitch: 0, fov: 40, grid: 0.01, gridExtent: 0 }], snapshots: res.snaps, W: 260, H: 300 }));
}

function RC() {
  return XLR.od / 2;
}

// ------------------------------------------------------------------ U

if (parts.includes('u')) {
  const U = T.U;
  const res = run('phys-u', { snapAt: [0, U.tMove + 0.25, U.tMove + U.moveTime, U.tMove + U.moveTime + 0.3, U.tMove + U.moveTime + 1, 6.9] });
  const r = res.rod;
  // sag depth of the U below the hands at the end, vs a catenary of the same length
  let low = Infinity;
  for (let i = 0; i < r.n; i++) if (Math.abs(r.x[3 * i]) < U.span / 2 - 0.01) low = Math.min(low, r.x[3 * i + 1]);
  const stop = U.tMove + U.moveTime;
  // the lowest point's sideways (z) position: how far it swings past where it ends
  const zLow = [];
  const res2 = res.frames;
  out.u = {
    sag_cm: r3((U.height - low) * 100),
    settle_after_stop_s: { below_5cm_s: settle(res2.filter((x) => x.t < U.tBack), stop, 0.05), below_2cm_s: settle(res2.filter((x) => x.t < U.tBack), stop, 0.02) },
    vMax_during_move: r3(maxOf(res2, 'vMax', U.tMove, stop)), handPeak_m_s: r3((1.875 * U.move) / U.moveTime),
    vMax_after_stop: r3(maxOf(res2, 'vMax', stop + 0.2, U.tBack)),
    ...general(res2),
  };
  void zLow;
  console.log('u', JSON.stringify(out.u));
  console.log(render('physics-u', { title: 'phys-u: U between two pinches 60 cm apart; the right hand moves 20 cm toward the camera in 0.5 s (2.0-2.5 s) and stops', radius: RC(), visScale: 1.5, views: [{ name: 'front', target: [0, 0.8, 0], dist: 1.4, yaw: 0, pitch: 5, fov: 40 }, { name: 'side', target: [0, 0.8, 0.1], dist: 1.4, yaw: 90, pitch: 5, fov: 40 }], snapshots: res.snaps, W: 260, H: 260 }));
}

// ------------------------------------------------------------------ grab and move

if (parts.includes('grab')) {
  const G = T.GRAB;
  const stop = G.tMove + G.moveTime;
  // the cable's shape half a second after the hand stopped, against the end (does it move back?)
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
    ...general(res.frames),
  };
  console.log('grab', JSON.stringify(out.grab));
  console.log(render('physics-grab', { title: `phys-grab: the hand goes down to the cable on the floor, pinches it where it is (${G.tAt}s), lifts it, moves it 50 cm in 0.6 s (${G.tMove}-${stop.toFixed(1)}s), stops`, radius: RC(), visScale: 1.5, views: [{ name: 'front', target: [0.1, 0.35, 0], dist: 2.2, yaw: 0, pitch: 8, fov: 40 }, { name: 'above', target: [0.1, 0.2, 0], dist: 2.2, yaw: 30, pitch: 55, fov: 40 }], snapshots: res.snaps, W: 220, H: 240 }));
}

// ------------------------------------------------------------------ lay down a curve

if (parts.includes('lay')) {
  const Ly = T.LAY;
  let atOpen = null;
  const res = run('phys-lay', {
    snapAt: [0.5, Ly.tLift + 0.6, (Ly.tLift + Ly.tLay) / 2, Ly.tLay, Ly.tOpen + 0.4, Ly.duration],
    each: (r, t) => {
      if (Math.abs(t - (Ly.tOpen + 0.4)) < 0.5 / 60) atOpen = Float64Array.from(r.x);
    },
  });
  const r = res.rod;
  let back = 0, sum = 0;
  for (let i = 0; i < r.n; i++) {
    const d = Math.hypot(r.x[3 * i] - atOpen[3 * i], r.x[3 * i + 1] - atOpen[3 * i + 1], r.x[3 * i + 2] - atOpen[3 * i + 2]);
    back = Math.max(back, d);
    sum += d;
  }
  // radius of the laid bend: circle through three points of the trailing cable
  out.lay = { springBack_max_mm: r3(back * 1000), springBack_mean_mm: r3((sum / r.n) * 1000), settle_after_open_s: settle(res.frames, Ly.tOpen + 0.3, 0.02), ...general(res.frames) };
  console.log('lay', JSON.stringify(out.lay));
  console.log(render('physics-lay', { title: 'phys-lay: the hand lays the cable round in a bend on the floor and lets go (3.6 s); does the bend stay?', radius: RC(), visScale: 1.5, views: [{ name: 'above', target: [0.3, 0, -0.1], dist: 1.4, yaw: 0, pitch: 80, fov: 40, grid: 0.1 }], snapshots: res.snaps, W: 240, H: 240 }));
}

// ------------------------------------------------------------------ coil: pinch slide + bundle

if (parts.includes('coil')) {
  const C = T.COIL, B = C.beat;
  const LOOP = B.take + B.slide + B.close + B.ret + B.place + B.open;
  // lateral error of the cable at the pads and slip speed while sliding
  let lat = 0;
  const slips = [];
  const res = run('phys-coil', {
    snapAt: [0.3 + B.take + B.slide * 0.5, 0.3 + B.take + B.slide, 0.3 + B.take + B.slide + B.close + B.ret, 0.3 + LOOP + 0.5, 0.3 + 3 * LOOP, C.tMoveCoil + 0.8, C.duration],
    each: (r, t, row) => {
      row.slip = r.time;
    },
  });
  void lat;
  void slips;
  const b = res.baked;
  const slip = [];
  for (let k = 0; k < C.loops; k++) {
    const t0 = 0.3 + k * LOOP + B.take;
    const s0 = b.track('sHand', t0 + 0.15), s1 = b.track('sHand', t0 + B.slide);
    const s2 = b.track('sHand', t0 + B.slide + B.close + B.ret);
    slip.push({ loop: k + 1, slid_cm: r3((s1 - s0) * 100), whileHeld_cm: r3((s2 - s1) * 100) });
  }
  out.coil = {
    slid: slip,
    settle_after_coil_moves_s: settle(res.frames, C.tMoveCoil + 0.8, 0.03),
    ...general(res.frames),
  };
  console.log('coil', JSON.stringify(out.coil));
  console.log(render('physics-coil', { title: 'phys-coil: loose pinch slides out, holds, returns; the left hand takes the strand into its bundle (3 loops), then moves the coil', radius: RC(), visScale: 1.5, views: [{ name: 'front', target: [0.2, 0.6, 0], dist: 1.6, yaw: 0, pitch: 5, fov: 40 }, { name: 'side', target: [0.2, 0.6, 0], dist: 1.6, yaw: 70, pitch: 10, fov: 40 }], snapshots: res.snaps, W: 230, H: 250 }));
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
    ...general(res.frames),
  };
  console.log('roll', JSON.stringify(out.roll));
  console.log(render('physics-roll', { title: 'phys-roll: thumb rolls the held cable 180° (0.5-1.5 s), then the hand turns 180° (2.2-3.2 s); red = stripe (d1)', radius: RC(), visScale: 2, views: [{ name: 'front', target: [0.1, 0.55, 0], dist: 1.3, yaw: 20, pitch: 10, fov: 40 }], snapshots: res.snaps, W: 220, H: 300 }));
}

// ------------------------------------------------------------------ cantilever ring-down, old vs new

if (parts.includes('cantilever')) {
  const cant = (o, sub, L = 0.15, seg = 0.0125) => {
    const N = Math.round(L / seg) + 1;
    const rod = Rod.straight([0, 1, 0], [L, 1, 0], N, { groundY: null, ...o });
    rod.addGrip({ nodes: [0, 1], keepShape: true, frame: () => ({ p: [0, 1, 0], q: [0, 0, 0, 1] }) });
    const tip = [];
    for (let f = 0; f < 240; f++) { rod.step(1 / 60, sub); tip.push(1 - rod.x[3 * (N - 1) + 1]); }
    const fin = tip[tip.length - 1];
    let s5 = tip.length;
    for (let i = tip.length - 1; i >= 0 && Math.abs(tip[i] - fin) < 0.05 * Math.abs(fin); i--) s5 = i;
    return { droop_mm: r3(fin * 1000), overshoot_mm: r3(Math.max(...tip.map((v) => v - fin)) * 1000), settle5pct_s: r3(s5 / 60) };
  };
  const OLD = { EI: 2e-3, GJ: 1.5e-3, linearDensity: 0.06, damping: 1.2, angularDamping: 3, internalDamping: 2, iterations: 3 };
  const NEW = sim.rodOptions(XLR);
  out.cantilever = {
    old_s1coil_15cm: cant(OLD, 40), old_s1coil_30cm: cant(OLD, 40, 0.3),
    xlr_15cm: cant(NEW, XLR.substeps, 0.15, XLR.segment), xlr_30cm: cant(NEW, XLR.substeps, 0.3, XLR.segment),
    xlr_noDamping_15cm: cant({ ...NEW, bendDamping: 0, twistDamping: 0, plastic: null }, XLR.substeps, 0.15, XLR.segment),
  };
  console.log('cantilever', JSON.stringify(out.cantilever));
}

// ------------------------------------------------------------------ a fast finger through a hanging cable

if (parts.includes('tunnel')) {
  out.tunnel = [];
  for (const speed of [1, 3, 5, 10, 30]) {
    const pts = [];
    for (let i = 0; i <= 100; i++) {
      const x = -0.4 + 0.8 * (i / 100);
      pts.push([x, 1 - 0.4 * (1 - (x / 0.4) ** 2), 0]);
    }
    const { rod } = buildCable(XLR, pts, { plugs: 'none', groundY: null });
    const fa = { frame: sim.gripFrame([-0.4, 1, 0], [1, 0, 0], [0, 1, 0]) }, fb = { frame: sim.gripFrame([0.4, 1, 0], [1, 0, 0], [0, 1, 0]) };
    rod.pinch({ ...fa, blend: 0.01 });
    rod.pinch({ ...fb, blend: 0.01 });
    for (let f = 0; f < 60; f++) rod.step(1 / 60, XLR.substeps);
    // a finger (r 8 mm, upright and long, so the cable cannot swing round its end) sweeps through the
    // bottom of the U along +z to z = 0.15 and stays
    let low = 0;
    for (let i = 0; i < rod.n; i++) if (rod.x[3 * i + 1] < rod.x[3 * low + 1]) low = i;
    const y = rod.x[3 * low + 1], t0 = rod.time, z0 = -0.15, R = 0.008;
    const zAt = (t) => Math.min(0.15, z0 + speed * (t - t0));
    rod.setCapsules((t) => [{ a: [0, y - 0.5, zAt(t)], b: [0, y + 1.5, zAt(t)], r: R }]);
    let deepest = 0;
    const frames = Math.ceil((0.3 / speed) * 60) + 30;
    for (let f = 0; f < frames; f++) {
      rod.step(1 / 60, XLR.substeps);
      const z = zAt(rod.time);
      for (let j = 0; j < rod.ns; j++) {
        const dx = rod.c[3 * j], dz = rod.c[3 * j + 2] - z, dy = rod.c[3 * j + 1] - y;
        deepest = Math.max(deepest, R + rod.rc - Math.hypot(dx, dz)); void dy;
      }
    }
    // the cable's bottom must end up in front of the finger (z > 0.15)
    let behind = 0;
    for (let i = 0; i < rod.n; i++) if (Math.abs(rod.x[3 * i]) < 0.005 && rod.x[3 * i + 2] < 0.15) behind++;
    const pushed = rod.x[3 * low + 2];
    rod.setCapsules(null);
    const row = { speed_m_s: speed, cablePassedThrough: behind > 0, bottomPushedTo_z_m: r3(pushed), deepestPenetration_mm: r3(Math.max(0, deepest) * 1000) };
    out.tunnel.push(row);
    console.log('tunnel', JSON.stringify(row));
  }
}

// ------------------------------------------------------------------ performance

if (parts.includes('perf')) {
  out.perf = [];
  for (const [len, seg, sub, it] of [[4, 0.01, 30, 2], [5, 0.0125, 30, 2], [5, 0.01, 30, 2], [5, 0.01, 40, 2], [5, 0.01, 30, 3]]) {
    // a loose spiral on the floor: some self-contact, some ground contact
    const pts = [];
    let p = [0, RC(), 0], h = 0;
    for (let s = 0; s < len; s += 0.002) {
      pts.push(p);
      h += 0.002 * (1.5 + 2.5 * (s / len));
      p = [p[0] + 0.002 * Math.cos(h), RC(), p[2] + 0.002 * Math.sin(h)];
    }
    const { rod } = buildCable(XLR, pts, { segment: seg, iterations: it });
    const t0 = performance.now();
    for (let f = 0; f < 60; f++) rod.step(1 / 60, sub);
    const wall = (performance.now() - t0) / 1000;
    const row = { nodes: rod.n, substeps: sub, iterations: it, simSecondsPerWallSecond: r3(1 / wall), minutesFor20s: r3((20 * wall) / 60) };
    out.perf.push(row);
    console.log('perf', JSON.stringify(row));
  }
}

writeSummary(`physics${parts.length < 9 ? '-' + parts.join('-') : ''}`, out);
await close();
