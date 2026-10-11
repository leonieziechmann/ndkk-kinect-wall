// Stage 1, shot 1 (and the core of stage 3): Noor coils a 5 m XLR cable over and under into her
// left hand. Two loops at a teaching pace (über, unter), then four everyday ones, then the velcro
// tie closes round the ring. The male plug end (with the tie on it) hangs below her left fist; the
// rest lies on the floor in a gentle curve to her right front and is pulled up loop by loop.
//
// Simulation (choreography from coiling.ts):
//   - the left fist: a shape-keeping grip over everything already in it; it grows when a loop is
//     placed, so placed loops ride rigidly with the hand
//   - the right hand: a loose fist while sliding out (a guide that keeps the cable passing through
//     the fist around the material point the hand is at, in a direction halfway between the fist's
//     and the cable's own, and lets it slide), then a short swivel grip that turns with the cable
//     (the cable may roll in the fingers, so twist runs out into the cable to the floor); the
//     fingers also roll it actively until the new loop lies flat. The fist never forces the cable
//     into a direction it does not run, so it leaves the fist in smooth bends, not kinks
//   - while sliding out, the cable between the hands is guided into a sagging curve that leaves the
//     left fist along its axis and enters the right one along the cable, as long as the cable
//   - guides pull the returning loop into its round target shape during the last part of the way
//     back, and put the cable to the floor in front of the new loop (über) or behind it (unter)
//     where it crosses the loop, eased in and out so it bends smoothly
//   - the forearms, the body and the legs are capsules (the hands are left out: they hold the cable)
//   - the floor with friction under the supply
//
// Checks while baking (printed, with a summary at the end): per placed loop the twist in
// the loop stays below half a turn; seen from Noor's eyes, the cable to the floor lies in front of
// the new loop where it crosses it (über) or behind it (unter); no strand passes through another
// (the writhe never jumps), and the cable is never pulled apart.

import { Quat, Rod, V3, add, cross, dot, length, lerp3, normalize, quatFromAxisAngle, quatFromTo, quatMul, scale, smooth, sub } from '../sim';
import { NOOR } from '../people/cast';
import type { Capsule } from '../people/people';
import { rigPose } from '../people/rig';
import { capsulesOf, eyesOf } from '../people/body3d';
import { BRISK, Coiling, FIST_HALF, LoopKind, TEACHING, XLR_R } from './coiling';
import type { ShotDef } from './types';

/** the cable: 5 m XLR */
const LENGTH = 5.0;
export const SEG = 0.0125;
const N_NODES = Math.round(LENGTH / SEG) + 1;
/** how far the end of a forming loop stays in front of its start while it swings round [m] */
const SWEEP = 0.035;
/** per substep, how much of the distance along the fist's axis to where the cable should be is closed */
const FEED = 0.08;
/** half length of the cable a loose fist keeps on its line [m] (drawn in over the outer SLEEVE_IN) */
const SLEEVE = 0.025, SLEEVE_IN = 0.012;
/** the closed fist holds this many segments either side of its point */
const GRIP_HALF = 2;

const KINDS: LoopKind[] = ['over', 'under', 'over', 'under', 'over', 'under'];


export const COIL1 = new Coiling({ kinds: KINDS, paces: [TEACHING, TEACHING, BRISK, BRISK, BRISK, BRISK] });

/** shot length: the loops, the tie and a short rest at the end */
const DURATION = Math.ceil((COIL1.tie.tAway + 0.6) * 10) / 10;

export const nodeAt = (s: number) => Math.max(0, Math.min(N_NODES - 1, Math.round(s / SEG)));

/** first node of the cable to the floor after loop k is placed (k = 0: before the first loop) */
export const floorStart = (k: number) => nodeAt(COIL1.sP[k] + FIST_HALF) + 1;

/** first and last node of loop k (1-based) outside the fist */
export const loopNodes = (k: number): [number, number] => [nodeAt(COIL1.sP[k - 1] + FIST_HALF) + 1, nodeAt(COIL1.sP[k] - FIST_HALF) - 1];

// ---------------------------------------------------------------- the checks' point of view

interface View {
  eye: V3;
  look: V3;
}

/** where the checks look from: her eyes, at the coil (the side of the coil the first-person camera sees) */
function checkView(): View {
  return { eye: eyesOf(rigPose(NOOR, COIL1.rig(NOOR, 0))).p, look: COIL1.at(0.04, -0.12, 0) };
}

/** a point seen from the view: image coordinates (x right, y up, per unit depth) and depth */
function projector(v: View) {
  const f = normalize(sub(v.look, v.eye));
  const r = normalize(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  return (p: V3) => {
    const d = sub(p, v.eye);
    const z = dot(d, f);
    return { x: dot(d, r) / z, y: dot(d, u) / z, z };
  };
}

/**
 * Where the cable to the floor (nodes f0..f1) crosses loop k (nodes l0..l1) seen from her eyes
 * (depth along the coil's normal),
 * at least `away` (m) from the fist: per crossing the node indices of both, which one is in
 * front and how far apart they are (along the view).
 */
function crossingsInPov(x: ArrayLike<number>, f0: number, f1: number, l0: number, l1: number, away: number) {
  const view = projector(checkView());
  const P = (i: number) => view([x[3 * i], x[3 * i + 1], x[3 * i + 2]]);
  const fist = COIL1.L;
  const far = (i: number) => length(sub([x[3 * i], x[3 * i + 1], x[3 * i + 2]], fist)) > away;
  const out: { floor: number; loop: number; floorInFront: boolean; gap: number }[] = [];
  for (let i = f0; i < f1; i++) {
    if (!far(i)) continue;
    const a0 = P(i), a1 = P(i + 1);
    for (let j = l0; j < l1; j++) {
      if (!far(j)) continue;
      const b0 = P(j), b1 = P(j + 1);
      const dx = a1.x - a0.x, dy = a1.y - a0.y, ex = b1.x - b0.x, ey = b1.y - b0.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const s = ((b0.x - a0.x) * ey - (b0.y - a0.y) * ex) / den;
      const t = ((b0.x - a0.x) * dy - (b0.y - a0.y) * dx) / den;
      if (s < 0 || s > 1 || t < 0 || t > 1) continue;
      // in front = nearer the coiler along the coil's normal (her side of the loop; seen from above
      // right at the fist, where the strands lie in two rows, the eye's depth would mislead)
      const D = (k: number, u: number) => dot(sub([x[3 * k] + (x[3 * k + 3] - x[3 * k]) * u, x[3 * k + 1] + (x[3 * k + 4] - x[3 * k + 1]) * u, x[3 * k + 2] + (x[3 * k + 5] - x[3 * k + 2]) * u], fist), COIL1.n);
      const zf = D(i, s), zl = D(j, t);
      out.push({ floor: s < 0.5 ? i : i + 1, loop: t < 0.5 ? j : j + 1, floorInFront: zf > zl, gap: Math.abs(zf - zl) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the cable at the start

/** start shape: the plug end in the fist, out along a, down to the floor, a gentle curve to her right front */
function startPoints(): V3[] {
  const c = COIL1;
  const dense: V3[] = [];
  const sFist = c.sP[0];
  for (let s = 0; s < sFist; s += 0.002) dense.push(c.tailPoint(s));
  // out of the fist and hanging down through where the loops will be, then onto the floor
  for (let s = sFist; ; s += 0.002) {
    const q = c.floorTarget(0, s);
    if (!q) break;
    dense.push(q);
  }
  const last = dense[dense.length - 1];
  const dir0: V3 = normalize([0.6, 0, -0.8]);
  const touch: V3 = [last[0] + 0.12 * dir0[0], XLR_R, last[2] + 0.12 * dir0[2]];
  const c1: V3 = [last[0], last[1] * 0.45, last[2]], c2: V3 = [touch[0] - 0.12 * dir0[0], XLR_R, touch[2] - 0.12 * dir0[2]];
  for (let i = 1; i <= 200; i++) {
    const u = i / 200, v = 1 - u;
    const w = [v * v * v, 3 * u * v * v, 3 * u * u * v, u * u * u];
    dense.push([0, 1, 2].map((k) => w[0] * last[k] + w[1] * c1[k] + w[2] * c2[k] + w[3] * touch[k]) as V3);
  }
  // on the floor: slowly turning to the right
  let h = Math.atan2(dir0[0], -dir0[2]);
  let p = touch;
  for (let i = 0; i < 2500; i++) {
    h += 0.002 * 0.35;
    p = [p[0] + Math.sin(h) * 0.002, XLR_R, p[2] - Math.cos(h) * 0.002];
    dense.push(p);
  }
  // nodes SEG apart along the dense path
  const out: V3[] = [dense[0]];
  let acc = 0;
  for (let i = 1; i < dense.length && out.length < N_NODES; i++) {
    const p0 = dense[i - 1], p1 = dense[i];
    const l = length(sub(p1, p0));
    while (acc + l >= SEG * out.length && out.length < N_NODES) {
      const u = (SEG * out.length - acc) / l;
      out.push([p0[0] + (p1[0] - p0[0]) * u, p0[1] + (p1[1] - p0[1]) * u, p0[2] + (p1[2] - p0[2]) * u]);
    }
    acc += l;
  }
  return out;
}

// ---------------------------------------------------------------- capsules

/** Noor's body as capsules at time t (hands left out), interpolated between 60 Hz poses */
function bodyCapsules() {
  const cache = new Map<number, Capsule[]>();
  const at = (f: number) => {
    let c = cache.get(f);
    if (!c) {
      // (while the right hand closes the tie its arm reaches over the coil, which is held still by
      // then: it does not push the free end around, so it is moved out of the way)
      const tie = f / 60 > COIL1.tie.t0 - 0.2;
      c = capsulesOf(rigPose(NOOR, COIL1.rig(NOOR, f / 60)))
        .filter((x) => x.part !== 'handL' && x.part !== 'handR' && x.part !== 'head' && x.part !== 'neck')
        .map((x) => (tie && x.part === 'armR' ? { ...x, a: [0, -9, 0] as V3, b: [0, -9, 0.01] as V3 } : x));
      cache.set(f, c);
      if (cache.size > 4) cache.delete(cache.keys().next().value as number);
    }
    return c;
  };
  const mix = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  return (t: number) => {
    const f = Math.floor(t * 60), u = t * 60 - f;
    const A = at(f), B = at(f + 1);
    return A.map((c, i) => ({ a: mix(c.a, B[i].a, u), b: mix(c.b, B[i].b, u), r: c.r }));
  };
}

/** d3 of a frame's rotation: the cable direction */
function dirOf(q: Quat): V3 {
  const [x, y, z, w] = q;
  return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
}

/** the cable's direction at material coordinate s: the chord over ±2 nodes around it */
function tangentAt(r: Rod, s: number): V3 {
  const i0 = Math.max(0, Math.floor(s / SEG) - 2), i1 = Math.min(r.n - 1, Math.ceil(s / SEG) + 2);
  return normalize([r.x[3 * i1] - r.x[3 * i0], r.x[3 * i1 + 1] - r.x[3 * i0 + 1], r.x[3 * i1 + 2] - r.x[3 * i0 + 2]]);
}

/**
 * A curve from p0 (leaving along t0) to p1 (arriving along t1) that sags by g in the middle, and
 * its arc length table (n samples): a cubic Hermite curve plus a downward bump with flat ends, so
 * the sag does not change the directions at the ends.
 */
function sagTable(p0: V3, t0: V3, p1: V3, t1: V3, g: number, n: number) {
  const L = length(sub(p1, p0));
  const pts: V3[] = [], cum: number[] = [0];
  for (let j = 0; j <= n; j++) {
    const v = j / n, v2 = v * v, v3 = v2 * v;
    const h00 = 2 * v3 - 3 * v2 + 1, h10 = v3 - 2 * v2 + v, h01 = -2 * v3 + 3 * v2, h11 = v3 - v2;
    const bump = 16 * g * v2 * (1 - v) * (1 - v);
    pts.push([0, 1, 2].map((k) => h00 * p0[k] + h10 * L * t0[k] + h01 * p1[k] + h11 * L * t1[k] - (k === 1 ? bump : 0)) as V3);
    if (j > 0) cum.push(cum[j - 1] + length(sub(pts[j], pts[j - 1])));
  }
  return { pts, cum };
}

/** the point at arc length d of an arc length table */
function alongTable(tab: { pts: V3[]; cum: number[] }, d: number): V3 {
  const { pts, cum } = tab;
  if (d <= 0) return pts[0];
  if (d >= cum[cum.length - 1]) return pts[pts.length - 1];
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (cum[m] <= d) lo = m;
    else hi = m;
  }
  return lerp3(pts[lo], pts[hi], (d - cum[lo]) / Math.max(1e-9, cum[hi] - cum[lo]));
}

/**
 * The cable between the hands while the right one slides out: a curve that leaves the left fist
 * along its axis (a), sags under its own weight and enters the right fist along the cable's own
 * direction there, as long as the cable between them (so the guide never stretches or squeezes it).
 */
function sagCurve(edge: V3, a: V3, hand: V3, dirIn: V3, len: number) {
  let lo = 0, hi = Math.max(0.01, len);
  for (let it = 0; it < 18; it++) {
    const m = (lo + hi) / 2;
    const tab = sagTable(edge, a, hand, dirIn, m, 24);
    if (tab.cum[tab.cum.length - 1] < len) lo = m;
    else hi = m;
  }
  return sagTable(edge, a, hand, dirIn, lo, 24);
}

// ---------------------------------------------------------------- the shot

export const coilShot: ShotDef = {
  id: 's1-coil',
  duration: DURATION,
  fps: 60,
  substeps: 40,
  iterations: 3,
  build() {
    const c = COIL1;
    const rod = Rod.fromPolyline(startPoints(), {
      radius: XLR_R, linearDensity: 0.06, EI: 2e-3, GJ: 1.5e-3,
      damping: 1.2, angularDamping: 3, internalDamping: 2, friction: 0.5, capsuleFriction: 0.1, selfFriction: 0.2,
    });
    if (rod.n !== N_NODES) throw new Error(`start shape has ${rod.n} nodes, expected ${N_NODES}`);
    // the female XLR plug at the far end (about 25 g)
    rod.addMass(rod.ns - 1, 0.025);
    const left = c.leftFrame();
    let leftGrip = rod.addGrip({ nodes: [0, nodeAt(c.sP[0] + FIST_HALF)], keepShape: true, frame: () => left });
    // let the cable settle on the floor before the shot starts (heavily damped)
    rod.opts.damping = 6;
    for (let f = 0; f < 90; f++) rod.step(1 / 60, 30);
    rod.opts.damping = 1.2;
    rod.time = 0;
    rod.setCapsules(bodyCapsules());

    // the loose right fist: the cable passes through it around the material point s, in a direction
    // halfway between the fist's and its own (the wrist gives way, the cable is not bent at the
    // fist's edge); along it the cable is only nudged toward where the hand is on it, so feeding it
    // through never tears it
    rod.addGuide({
      nodes: [0, N_NODES - 1],
      compliance: 2e-5,
      weight: (t) => c.right(t).sleeve,
      target: (i, t) => {
        const r = c.right(t);
        const d = i * SEG - r.s;
        if (Math.abs(d) > SLEEVE) return null;
        // halfway between the fist's own direction and the cable's
        const T = normalize(add(dirOf(r.cable.q), tangentAt(rod, r.s)));
        const cur: V3 = [rod.x[3 * i], rod.x[3 * i + 1], rod.x[3 * i + 2]];
        const along = dot(sub(cur, r.cable.p), T);
        const on = add(r.cable.p, scale(T, along + (d - along) * FEED));
        return lerp3(cur, on, smooth((SLEEVE - Math.abs(d)) / SLEEVE_IN));
      },
    });

    // the closed fist turns with the cable: halfway between the choreography's direction and the
    // chord of the cable through it, smoothed from frame to frame
    let gripDir: V3 = [1, 0, 0];
    let gripNode = -1;
    const steerGrip = (r: Rod, t: number) => {
      if (gripNode < 0) return;
      const j0 = Math.max(0, gripNode - 6), j1 = Math.min(r.n - 1, gripNode + 6);
      const chord = normalize([r.x[3 * j1] - r.x[3 * j0], r.x[3 * j1 + 1] - r.x[3 * j0 + 1], r.x[3 * j1 + 2] - r.x[3 * j0 + 2]]);
      const want = normalize(add(dirOf(c.right(t).cable.q), chord));
      gripDir = normalize(lerp3(gripDir, want, 0.12));
    };

    /** rolls the part `gain` of loop k's twist out of it, spread along the loop (returns the twist before) */
    const rollOut = (r: Rod, k: number, gain: number) => {
      const iG = nodeAt(c.beats[k - 1].sGrip);
      const [l0, l1] = loopNodes(k);
      const tw = r.twistTurns(l0, l1 - 1);
      const ang = -tw * 2 * Math.PI * gain;
      for (let j = l0; j < iG + GRIP_HALF; j++) {
        const roll = quatFromAxisAngle(0, 0, 1, ang * Math.min(1, (j - l0 + 0.5) / (l1 - l0)));
        r.q.set(quatMul([r.q[4 * j], r.q[4 * j + 1], r.q[4 * j + 2], r.q[4 * j + 3]], roll), 4 * j);
      }
      return tw;
    };
    /** per loop: the twist left just before the fingers lay it in flat */
    const laidIn: number[] = c.beats.map(() => 0);

    // events per loop
    const events: { t: number; run: () => void }[] = [];
    const checks: string[] = [];
    let failed = 0;
    /** a check; a warning only prints */
    const report = (ok: boolean, text: string, warn = false) => {
      const tag = ok ? 'ok  ' : warn ? 'WARN' : 'FAIL';
      checks.push(`${tag} ${text}`);
      console.log(`    s1-coil ${tag} ${text}`);
      if (!ok && !warn) failed++;
    };
    const crossNodes: [number, number][] = c.beats.map(() => [-1, -1]);

    c.beats.forEach((b, bi) => {
      const k = b.k;
      const iG = nodeAt(b.sGrip);
      const [l0, l1] = loopNodes(k);
      const f0 = floorStart(k);
      let grip = 0, shape = 0, cross = 0;
      // how much slack a node needs before a guide pulls it fully to its place: plenty while the
      // loop swings round (no corner where the guided part meets the free part), little at the end
      // (the strand is laid into the fist taut)
      const easeIn = (t: number) => 0.003 + 0.027 * (1 - smooth((t - b.tPlace + 0.35 * (b.tPlace - b.tRet)) / (0.3 * (b.tPlace - b.tRet))));
      const next = c.beats[bi + 1];
      const ret = b.tPlace - b.tRet;
      const hookedLoop = k > 1 && c.kinds[k - 2] === 'under';
      const hooked = hookedLoop && b.fromHanging;

      // while sliding out, the cable between the hands sags into a U, not up into an arch. Hooked
      // behind the last ("unter") loop it is only weighed down (a U-shaped target would pull it
      // through that loop).
      const sExit = c.sP[k - 1] + FIST_HALF;
      const edge = add(c.strand(k - 1), scale(c.a, FIST_HALF));
      let sagAt = -1;
      let sagTab: ReturnType<typeof sagCurve> | null = null;
      const sagGuide = rod.addGuide({
        nodes: [nodeAt(sExit) + 1, iG],
        compliance: 5e-3,
        weight: (t) => smooth((t - b.tSlide) / 0.2) * (1 - smooth((t - b.tClose + 0.1) / 0.2)),
        target: (i, t) => {
          const r = c.right(t);
          const cur: V3 = [rod.x[3 * i], rod.x[3 * i + 1], rod.x[3 * i + 2]];
          const v = i * SEG - sExit, len = r.s - SLEEVE - sExit;
          if (v <= 0 || v >= len) return null;
          if (hooked) return [cur[0], cur[1] - 0.004, cur[2]];
          if (t !== sagAt) {
            const T = normalize(add(dirOf(r.cable.q), tangentAt(rod, r.s)));
            sagTab = sagCurve(edge, c.a, sub(r.cable.p, scale(T, SLEEVE)), T, len);
            sagAt = t;
          }
          const q = alongTable(sagTab as ReturnType<typeof sagCurve>, v);
          // in the plane of the coil only: in front of or behind a loop is the crossing guide's business
          return add(q, scale(c.n, c.local(cur)[2] - c.local(q)[2]));
        },
      });
      events.push({ t: b.tClose + 0.2, run: () => rod.removeGuide(sagGuide) });
      events.push({
        t: b.tClose,
        run: () => {
          // the fist closes: the cable may still roll in it (twist escapes into the cable to the floor)
          // the fist closes the way the cable runs through it, then turns as steerGrip says
          gripDir = tangentAt(rod, b.sGrip);
          gripNode = iG;
          grip = rod.addGrip({ nodes: [iG - GRIP_HALF, iG + GRIP_HALF], swivel: true, blend: 0.12, frame: (t) => {
            const f = c.right(t).cable;
            return { p: f.p, q: quatMul(quatFromTo(dirOf(f.q), gripDir), f.q) };
          } });
          shape = rod.addGuide({
            nodes: [l0, iG - 4],
            compliance: 1e-3,
            weight: (t) => smooth((t - b.tRet - 0.45 * ret) / (0.5 * ret)),
            target: (i, t) => {
              const loopP = c.loopTarget(k, i * SEG);
              if (!loopP) return null;
              // the end of the loop swings round in front of its start, then settles into place
              const frac = (i * SEG - c.sP[k - 1]) / (c.sP[k] - c.sP[k - 1]);
              const p = add(loopP, scale(c.n, SWEEP * smooth((frac - 0.35) / 0.3) * (1 - smooth((t - b.tPlace + 0.3 * ret) / (0.25 * ret)))));
              // only where the hand, still on its way, already lets the cable reach (eased in with
              // the slack, see easeIn)
              const slack = b.sGrip - i * SEG - length(sub(p, c.right(t).cable.p)) + 0.003;
              if (slack < 0) return null;
              const cur: V3 = [rod.x[3 * i], rod.x[3 * i + 1], rod.x[3 * i + 2]];
              // hooked behind the previous ("unter") loop: the start keeps its own depth
              const q = !hookedLoop || c.depthNear(k, p).phi > 1.9 ? p : add(p, scale(c.n, dot(sub(cur, p), c.n)));
              return lerp3(cur, q, smooth(slack / easeIn(t)));
            },
          });
          // the cable to the floor: once the right hand lets go it hangs down through the new loop
          // (until the hand takes it again); where it crosses the loop it lies in front (über) or
          // behind (unter)
          cross = rod.addGuide({
            nodes: [f0 + 4, Math.min(N_NODES - 1, iG + 52)],
            compliance: 1e-3,
            weight: (t) => smooth((t - b.tRet - 0.2 * ret) / (0.3 * ret)) * (next ? 1 - smooth((t - next.tSlide + 0.1) / 0.1) : 1),
            target: (i, t) => {
              const cur: V3 = [rod.x[3 * i], rod.x[3 * i + 1], rod.x[3 * i + 2]];
              // once the hand holds the cable again, it decides where the cable is from there on
              const r = c.right(t);
              if (r.sleeve > 0 && t > b.tOpen && i * SEG > r.s - FIST_HALF - 0.02) return null;
              const hang = b.letGo ? smooth((t - b.tOpen) / 0.3) * (next ? 1 - smooth((t - next.tSlide + 0.15) / 0.15) : 1) : 0;
              const path = hang > 0 ? c.floorTarget(k, i * SEG) : null;
              // (the path lets go of the cable gradually toward its end, so it hangs on in a curve)
              const fade = 1 - smooth((i * SEG - c.sP[k] - FIST_HALF - 0.22) / 0.2);
              const p = path ? lerp3(cur, path, hang * fade) : i > iG + 3 ? cur : null;
              if (!p) return null;
              const loc = c.local(p);
              const near = c.depthNear(k, p);
              // where it crosses the new loop (below the fist, within the loop): in front or behind,
              // eased in and out so the cable bends smoothly into and out of that depth
              const w = smooth((-0.01 - loc[1]) / 0.03) * smooth((c.radius(k) + 0.05 - near.r) / 0.04);
              const zNow = c.local(cur)[2];
              if (w <= 0) return path ? add(p, scale(c.n, zNow - loc[2])) : null;
              let z = near.depth + (b.kind === 'over' ? 1 : -1) * 0.0085;
              if (b.kind === 'under' && k > 1) z = Math.max(z, Math.min(near.depth - 0.0075, c.depthNear(k - 1, p).depth + 0.0085));
              return add(p, scale(c.n, zNow + (z - zNow) * w - loc[2]));
            },
          });
        },
      });
      events.push({
        t: b.tPlace,
        run: () => {
          // the left hand takes the new loop: it rides with the hand from now on
          const j = nodeAt(c.sP[k]);
          const off = length(sub([rod.x[3 * j], rod.x[3 * j + 1], rod.x[3 * j + 2]], c.strand(k)));
          report(off < 0.008, `loop ${k}: its strand lies in the fist when the left hand takes it (${(off * 1000).toFixed(1)} mm from its place)`);
          // the fingers lay it in flat: what twist is left in the loop is rolled out of it
          laidIn[bi] = rollOut(rod, k, 1);
          rod.releaseGrip(leftGrip);
          leftGrip = rod.addGrip({ nodes: [0, nodeAt(c.sP[k] + FIST_HALF)], keepShape: true, frame: () => left });
        },
      });
      events.push({ t: b.tPlace + 0.1, run: () => rod.removeGuide(shape) });
      // the new strand is laid into the left fist (in its slot, along the fist) while the hand arrives
      // (not up to the fist's edge: there the start of an "unter" loop crosses over it)
      const strandGuide = rod.addGuide({
        nodes: [nodeAt(c.sP[k] - FIST_HALF), nodeAt(c.sP[k] + 0.02)],
        compliance: 2e-4,
        weight: (t) => smooth((t - b.tPlace + 0.3 * ret) / (0.3 * ret)),
        target: (i, t) => {
          const p = add(c.strand(k), scale(c.a, i * SEG - c.sP[k]));
          // (only what the hand, still on its way, already lets reach its place; eased in with the slack)
          const slack = b.sGrip - i * SEG - length(sub(p, c.right(t).cable.p)) + 0.003;
          if (slack < 0) return null;
          const cur: V3 = [rod.x[3 * i], rod.x[3 * i + 1], rod.x[3 * i + 2]];
          return lerp3(cur, p, smooth(slack / easeIn(t)));
        },
      });
      events.push({ t: b.tPlace + 0.1, run: () => rod.removeGuide(strandGuide) });
      events.push({ t: b.tOpen, run: () => { rod.releaseGrip(grip); gripNode = -1; } });
      if (next) events.push({ t: next.tSlide + 0.05, run: () => rod.removeGuide(cross) });
      // the checks, once the loop has settled in the hand
      events.push({
        t: b.letGo || !next ? Math.min(b.tPlace + 0.5, next ? next.tSlide : Infinity) : next.tClose,
        run: () => {
          const tw = rod.twistTurns(l0, l1 - 1);
          report(Math.abs(tw) < 0.5, `loop ${k} (${b.kind}): twist ${tw.toFixed(2)} turns (${laidIn[bi].toFixed(2)} just before the fingers laid it in flat)`);
          const xs = crossingsInPov(rod.x, f0 + 1, Math.min(N_NODES - 2, f0 + 36), l0 + 2, l1 - 2, 0.05);
          const want = b.kind === 'over';
          const good = xs.filter((x) => x.floorInFront === want);
          // the label goes to the lowest one (the clearest: away from the hands)
          if (good.length) crossNodes[bi] = [good[good.length - 1].loop, good[good.length - 1].floor];
          const where = (x: (typeof xs)[number]) => `${x.floorInFront ? 'in front' : 'behind'} at nodes ${x.floor}/${x.loop} (${(x.gap * 1000).toFixed(0)} mm)`;
          report(xs.length > 0 && good.length === xs.length, `loop ${k}: the cable to the floor crosses it ${xs.length}× seen from her eyes, ${want ? 'in front' : 'behind'} as it should ${good.length}×: ${xs.map(where).join(', ')}`);
        },
      });
    });
    events.sort((p, q) => p.t - q.t);

    /**
     * On the way back the fingers roll the cable until the new loop lies flat (what a coiler feels
     * for): each frame a part of the twist left in the loop is rolled out of it, spread along the
     * loop as the cable turns in the fingers (the cable to the floor beyond the hand takes it up);
     * the rest when the loop is laid into the left hand.
     */
    const rollFlat = (r: Rod, t: number) => {
      const b = c.beats.find((x) => t > x.tRet + 0.2 * (x.tPlace - x.tRet) && t < x.tPlace);
      // (firmly in the last moment before the left hand takes the loop)
      if (b) rollOut(r, b.k, t > b.tPlace - 0.1 ? 0.5 : 0.2);
    };

    let next = 0;
    // a strand passing through another: two segments far apart along the cable whose centres come
    // closer than a cable radius (they touch at twice that). The writhe changing by about 2 at once
    // and for good (medians of the last five frames and the five before) hints at one too, but a
    // sharp kink does the same, so that is only a warning.
    let deep = 0, jumps = 0, strain = 0;
    const wr: number[] = [];
    const median = (v: number[]) => [...v].sort((p, q) => p - q)[2];
    return {
      rod,
      script: (r, t) => {
        while (next < events.length && events[next].t <= t + 1e-9) events[next++].run();
        steerGrip(r, t);
        rollFlat(r, t);
        for (let i = 0; i < r.ns; i++) {
          for (let j = i + 3; j < r.ns; j++) {
            const dx = r.c[3 * i] - r.c[3 * j], dy = r.c[3 * i + 1] - r.c[3 * j + 1], dz = r.c[3 * i + 2] - r.c[3 * j + 2];
            if (dx * dx + dy * dy + dz * dz < r.rc * r.rc) {
              deep++;
              report(false, `t ${t.toFixed(2)} s: segments ${i} and ${j} inside each other`);
            }
          }
        }
        wr.push(r.writhe());
        if (wr.length === 10) {
          const before = median(wr.slice(0, 5)), now = median(wr.slice(5));
          if (Math.abs(now - before) > 1.4) {
            jumps++;
            report(false, `t ${t.toFixed(2)} s: writhe jumped ${before.toFixed(2)} → ${now.toFixed(2)} (a kink, or a strand passing through another)`, true);
            wr.length = 0;
          } else wr.shift();
        }
        strain = Math.max(strain, r.maxStrain());
        if (t >= DURATION - 1.5 / 60) {
          report(deep === 0, `no strand passed through another (${r.stats.crossings} contact corrections, ${jumps} writhe jumps)`);
          report(strain < 0.25, `largest gap at a joint ${(strain * SEG * 1000).toFixed(1)} mm (${(strain * 100).toFixed(0)} % of a segment)`, true);
          console.log(`  s1-coil: ${failed ? `${failed} check(s) FAILED` : 'all checks passed'}:\n    ${checks.join('\n    ')}`);
        }
      },
      tracks: {
        writhe: (r) => r.writhe(),
        strain: (r) => r.maxStrain(),
        floorTwist: (r, t) => r.twistTurns(floorStart(c.strandsAt(t) - 1), r.ns - 1),
        ...Object.fromEntries(c.beats.flatMap((b, bi) => [
          [`twist${b.k}`, (r: Rod) => r.twistTurns(loopNodes(b.k)[0], loopNodes(b.k)[1] - 1)],
          [`crossLoop${b.k}`, () => crossNodes[bi][0]],
          [`crossFloor${b.k}`, () => crossNodes[bi][1]],
        ])),
      },
    };
  },
};
