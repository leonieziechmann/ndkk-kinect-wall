// Coil factory: winds a coil in the simulation instead of building it from a formula, so its
// crossings are real. The cable hangs from a left fist; for each loop a right hand (a pin, so
// twist runs freely into the hanging supply) takes the supply one loop length down and brings it
// up around the right side into the fist. Guides round the loop and put the cable to the floor
// in front of the new loop (über) or behind it (unter), where it crosses the loop's bottom; the
// finished loop is then frozen in the fist (keepShape grip). The next loop is made from that
// supply, so after an "unter" it hooks behind the previous loop: the alternating crossings of an
// over-under coil. Optionally the free end is then passed through the eye of the coil (the
// mistake of stage 5.1). Finally the fist turns the coil flat and lays it on the floor (y = 0),
// centred on the origin, the loops stacked upward, the start tail along +x at z = -R, and
// everything is let go to settle. Or (lay: false) the coil stays hanging in the fist, its joints
// healed (frozen loops can carry small gaps), for a shot that grips it at once.
//
// Checks (tools/simtest/derisk-knot.mjs): pulled apart in the air, every unter loop leaves about
// two turns less twist than an über loop (über-über-über-über 3.4 turns, über-unter-über-unter
// -0.6, both with the same -0.6 from the open ends); threaded, every unter loop knots.
//
// Factory coordinates (hanging): fist at (0, Y0, 0), loops hang in the x-y plane and stack toward
// +z (toward the person winding); the cable runs through the fist along -x, loops go round
// counter-clockwise seen from +z (down the left side, up the right side).

import { Frame, Quat, Rod, RodBuildOptions, RodState, V3, lerp3, quatFromAxisAngle, quatMul, quatRotate, smooth } from '../sim';

export interface CoilSpec {
  /** cable options (radius, collisionRadius, EI, GJ, linearDensity, …) */
  cable: RodBuildOptions;
  /** segment length [m] */
  seg: number;
  /** cable length per loop [m] (circumference) */
  loop: number;
  /** one letter per loop: 'o' = über (the cable to the floor crosses on top), 'u' = unter */
  pattern: string;
  /** cable before the first loop (the start tail) and after the last one [m] */
  lead: number;
  tail: number;
  /**
   * pass the free end through the eye before the coil is laid down, from the top of the laid
   * coil to the bottom: pulled out, every unter loop ties an overhand knot
   */
  thread?: boolean;
  /** seconds per loop (default 2.6) */
  loopTime?: number;
  /** loop spacing in the fist (default 2.5 cm: the cable to the floor must fit between two loops) */
  spacing?: number;
  /**
   * false: stop when the coil is wound (and threaded) and return it hanging in the factory
   * coordinates (fist at FACTORY_FIST); the loops are then still where the fist held them, so a
   * shot must grip them at once
   */
  lay?: boolean;
  /** called after every factory frame (60 per second; pictures and checks) */
  onFrame?: (rod: Rod, t: number) => void;
}

export interface Coil {
  /** the coil lying on the floor at rest (or hanging in the fist: lay false) */
  state: RodState;
  /** node ranges [first, last] of the loops in winding order */
  loops: [number, number][];
  /** loop radius [m] */
  R: number;
}

const Y0 = 1.6;
/** where the fist is in the factory (the hanging coil of lay: false) */
export const FACTORY_FIST: V3 = [0, Y0, 0];
/** layer of the threaded end behind the stack */
const ZB = -0.015;
/** start tail: from the fist entry along +x to its end */
const FIST = 0.03;

/** Winds, optionally threads, lays down and settles a coil. Deterministic. */
export function windCoil(spec: CoilSpec): Coil {
  const { seg, loop, pattern, lead, tail } = spec;
  const loopTime = spec.loopTime ?? 2.6;
  const N = pattern.length;
  // nodes: start tail and fist, then per loop `perLoop` segments plus one to the next, then the tail
  const fistStart = Math.round(lead / seg), fistEnd = Math.round((lead + 2 * FIST) / seg);
  const perLoop = Math.round(loop / seg) - 1;
  // loop radius: a little slack, so the right hand never has to stretch the cable round the circle
  const R = (0.96 * perLoop * seg) / (2 * Math.PI);
  const n = fistEnd + N * (perLoop + 1) + Math.round(tail / seg);
  const rc = spec.cable.collisionRadius ?? spec.cable.radius ?? 0.0035;
  const DZ = spec.spacing ?? 0.025, lay = spec.lay !== false;

  // start: tail along +x into the fist, through the fist along -x, the rest hanging straight down
  const pts: V3[] = [];
  for (let i = 0; i < n; i++) {
    const s = i * seg;
    if (s <= lead) pts.push([FIST + lead - s, Y0 - 0.02 * (1 - s / lead), 0]);
    else if (s <= lead + 2 * FIST) pts.push([FIST - (s - lead), Y0, 0]);
    else pts.push([-FIST, Y0 - (s - lead - 2 * FIST), 0]);
  }
  const rod = Rod.fromPolyline(pts, { damping: 2, angularDamping: 3, ...spec.cable, groundY: null });

  // the left fist: still while winding, then it turns the coil flat and lays it down
  const tLay = 0.8 + N * loopTime + (spec.thread ? 2.4 : 0.4), layTime = 1.6;
  const hFist = -ZB + rc + 0.003;
  const fist = (t: number): Frame => {
    const u = smooth((t - tLay) / layTime);
    return { p: lerp3([0, Y0, 0], [0, hFist, -R], u), q: quatFromAxisAngle(1, 0, 0, (-Math.PI / 2) * u) };
  };
  /** a point given in the hanging fist coordinates, carried along by the fist */
  const inFist = (local: V3) => (t: number): Frame => {
    const f = fist(t);
    const r = quatRotate(f.q, local);
    return { p: [f.p[0] + r[0], f.p[1] + r[1], f.p[2] + r[2]], q: f.q };
  };
  rod.addGrip({ nodes: [0], orient: false, frame: inFist([FIST + lead, -0.02, 0]) });
  rod.addGrip({ nodes: [fistStart, fistEnd], keepShape: true, frame: fist });

  const loops: [number, number][] = [];
  let a = fistEnd;
  const events: { t: number; run: () => void }[] = [];
  for (let k = 0; k < N; k++) {
    const t0 = 0.8 + k * loopTime, b = a + perLoop, z = (k + 1) * DZ;
    const side = pattern[k] === 'u' ? -1 : 1;
    const woven = k > 0 && pattern[k - 1] === 'u';
    const la = a;
    loops.push([la, b]);
    let hand = 0, round = 0, cross = 0;
    events.push({
      t: t0,
      run: () => {
        // the right hand takes the supply one loop length down and brings it up the right side
        const p0: V3 = [rod.x[3 * b], rod.x[3 * b + 1] - Y0, rod.x[3 * b + 2]];
        const bottom: V3 = [0, -2 * R, z];
        const path = (t: number): V3 => {
          const u = (t - t0) / loopTime;
          if (u < 0.27) return lerp3(p0, bottom, smooth(u / 0.27));
          const phi = -Math.PI / 2 + Math.PI * smooth((u - 0.27) / 0.46);
          return [R * Math.cos(phi), -R + R * Math.sin(phi), z];
        };
        hand = rod.addGrip({ nodes: [b], orient: false, frame: (t) => inFist(path(t))(t) });
        // round loop: x, y on the circle (counter-clockwise from the top); z in the new loop's
        // layer, except that a woven loop runs behind the previous one down to its bottom
        const zOf = (i: number) => {
          if (!woven) return z;
          const u = (i - la) / perLoop;
          return z - 1.5 * DZ * (1 - smooth((u - 0.42) / 0.16));
        };
        round = rod.addGuide({
          nodes: [la, b],
          compliance: 1e-3,
          weight: (t) => smooth((t - t0 - 0.45 * loopTime) / (0.25 * loopTime)),
          target: (i) => {
            const phi = Math.PI / 2 + (2 * Math.PI * (i - la)) / perLoop;
            return [R * Math.cos(phi), Y0 - R + R * Math.sin(phi), zOf(i)];
          },
        });
        // the cable to the floor crosses the loop's bottom in front (über) or behind (unter)
        cross = rod.addGuide({
          nodes: [b + Math.round(0.08 / seg), Math.min(n - 1, b + Math.round(0.45 / seg))],
          compliance: 1e-3,
          weight: (t) => smooth((t - t0 - 0.3 * loopTime) / (0.15 * loopTime)),
          target: (i) => [rod.x[3 * i], rod.x[3 * i + 1], z + (side * DZ) / 2],
        });
      },
    });
    events.push({
      t: t0 + 0.78 * loopTime,
      run: () => {
        rod.removeGuide(round);
        rod.addGrip({ nodes: [la, b + 1], keepShape: true, frame: fist });
        rod.releaseGrip(hand);
      },
    });
    events.push({ t: t0 + 0.95 * loopTime, run: () => rod.removeGuide(cross) });
    a = b + 1;
  }

  // threading: the end is taken from the front (the top of the laid coil) through the eye and
  // down behind the coil; the last leg gets what is left of the tail (5 cm to spare)
  if (spec.thread) {
    const t0 = 0.8 + N * loopTime, dur = 2;
    const front: V3 = [0, -R, (N + 2) * DZ], back: V3 = [0, -R, ZB];
    const used = Math.hypot(R, 2 * DZ) + (N + 2) * DZ - ZB;
    const pts: V3[] = [front, back, [0, -R - (tail - used - 0.05), ZB]];
    events.push({
      t: t0,
      run: () => {
        const e = n - 1;
        const way = [[rod.x[3 * e], rod.x[3 * e + 1] - Y0, rod.x[3 * e + 2]] as V3, ...pts];
        const path = (t: number): V3 => {
          const u = Math.min(1, Math.max(0, (t - t0) / dur)) * (way.length - 1);
          const k = Math.min(way.length - 2, Math.floor(u));
          return lerp3(way[k], way[k + 1], smooth(u - k));
        };
        rod.addGrip({ nodes: [e], orient: false, frame: (t) => inFist(path(t))(t) });
      },
    });
  }
  if (lay) events.push({ t: tLay, run: () => { rod.opts.groundY = 0; } });
  // let go: the loops sink onto each other, held in their top-view shape by guides that fade out
  const tGo = tLay + layTime;
  if (lay) events.push({
    t: tGo,
    run: () => {
      const x0 = rod.x.slice();
      rod.releaseAll();
      rod.addGuide({
        nodes: [0, n - 1],
        compliance: 1e-4,
        weight: (t) => 1 - smooth((t - tGo - 0.5) / 0.6),
        target: (i) => [x0[3 * i], rod.x[3 * i + 1], x0[3 * i + 2]],
      });
    },
  });

  const fps = 60, settle = 1.8;
  const frames = Math.round((lay ? tLay + layTime + settle : tLay - 0.4) * fps);
  events.sort((p, q) => p.t - q.t);
  let next = 0;
  for (let f = 0; f < frames; f++) {
    const t = f / fps;
    while (next < events.length && events[next].t <= t + 1e-9) events[next++].run();
    rod.step(1 / fps, 30);
    spec.onFrame?.(rod, rod.time);
  }
  if (!lay) heal(rod);
  rod.time = 0;
  return { state: rod.saveState(), loops, R };
}

/**
 * Closes the joint gaps that frozen loops can carry (a loop is frozen as it is, also where a
 * contact had just pushed it): let go of everything, hold every node where it is with stiff
 * guides, and let the rod settle without gravity for a moment.
 */
function heal(rod: Rod) {
  const x0 = rod.x.slice(), g = rod.opts.gravity;
  rod.releaseAll();
  rod.opts.gravity = [0, 0, 0];
  const id = rod.addGuide({ nodes: [0, rod.n - 1], compliance: 1e-6, target: (i) => [x0[3 * i], x0[3 * i + 1], x0[3 * i + 2]] });
  for (let f = 0; f < 12; f++) rod.step(1 / 60, 30);
  rod.removeGuide(id);
  rod.opts.gravity = g;
  rod.v.fill(0);
  rod.om.fill(0);
}

/**
 * A saved state moved by d and turned by q about the y axis through the origin (to place a coil
 * in a shot); the ground moves with it.
 */
export function placeState(s: RodState, d: V3, q: Quat = [0, 0, 0, 1]): RodState {
  const g = s.opts.groundY;
  const out: RodState = { ...s, opts: { ...s.opts, groundY: g === null ? null : g + d[1] }, c: s.c.slice(), q: s.q.slice(), v: s.v.slice(), om: s.om.slice() };
  for (let j = 0; j < s.L.length; j++) {
    const c = quatRotate(q, [s.c[3 * j], s.c[3 * j + 1], s.c[3 * j + 2]]);
    out.c.set([c[0] + d[0], c[1] + d[1], c[2] + d[2]], 3 * j);
    const v = quatRotate(q, [s.v[3 * j], s.v[3 * j + 1], s.v[3 * j + 2]]);
    out.v.set(v, 3 * j);
    const w = quatRotate(q, [s.om[3 * j], s.om[3 * j + 1], s.om[3 * j + 2]]);
    out.om.set(w, 3 * j);
    out.q.set(quatMul(q, [s.q[4 * j], s.q[4 * j + 1], s.q[4 * j + 2], s.q[4 * j + 3]]), 4 * j);
  }
  return out;
}
