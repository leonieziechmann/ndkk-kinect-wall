// The rings of stage 1, items 3 and 4 (laying the cable out again): a short charging cable and a
// 15 m XLR, both coiled over-under, hanging in a fist.
//
// The coil factory (wind.ts) winds a ring with a simulated hand. For the 9 cm loops of the
// charging cable its winding motion is chaotic: the frozen loops trap ±0.5…1.5 turns of twist
// each and the later "unter" crossings do not always take (pulled apart, six over-under loops
// left 4 turns). So these rings are laid out from the factory's own target layout instead (the
// same loop circles, stacked toward the coiler, and the same weave: after an unter loop the next
// loop runs down behind it and comes to the front at the bottom), with zero twist along the cable,
// and then pressed together in the simulation into a compact bundle, as a hand and a velcro
// strap press a real coil. pullCheck() then pulls a ring apart by its ends in the air: an
// over-under ring must leave |Tw| < 0.3 turns, a same-way ring about one turn per loop.
//
// Factory coordinates (as wind.ts with lay: false): the fist at FACTORY_FIST, the loops hang in
// the x-y plane and stack toward +z, counter-clockwise seen from +z (down the left side, up the
// right side); the start tail sticks out of the fist along +x, the end tail hangs down.

import { Capsule, Frame, Quat, Rod, RodBuildOptions, RodState, V3, add, lerp3, normalize, quatFromTo, quatRotate, quatSlerp, scale, smooth, sub } from '../sim';
import { Coil, FACTORY_FIST } from './wind';

export interface RingSpec {
  cable: RodBuildOptions;
  /** segment length (m) */
  seg: number;
  /** cable per loop (m) */
  loop: number;
  /** 'o' über, 'u' unter, one letter per loop */
  pattern: string;
  /** start tail out of the fist, end tail hanging down (m) */
  lead: number;
  tail: number;
  /** loop spacing while laid out (≥ 2 contact diameters: the woven layer lies half way) */
  spacing: number;
  /** pressed bundle: how far the loops are pulled toward the stack's middle (0 none … 1 all) */
  press?: number;
  /** seconds of pressing and settling (default 1.2) */
  pressTime?: number;
  /**
   * shape memory 0..1: the rest shape moves this far toward the coiled shape (a cable that was
   * stored coiled keeps some of its bends; a straight rest shape would make 9 cm loops spring open
   * violently when let go)
   */
  memory?: number;
}

/** a small deterministic irregularity per loop, -1 … 1 */
const wobble = (k: number, salt: number) => Math.sin(12.9898 * (k + 1) + 78.233 * salt) * 0.5 + Math.sin(4.1 * (k + 1) * (salt + 1.7)) * 0.5;

/**
 * Lays out an over-under (or same-way) ring hanging in a fist, presses it together and returns
 * it at rest, its joints healed, nothing held (a shot must grip it at once). Deterministic.
 */
export function ringCoil(spec: RingSpec): Coil {
  const { seg, loop, pattern, lead, tail, spacing: DZ } = spec;
  const N = pattern.length;
  const R = (0.97 * loop) / (2 * Math.PI);
  const rc = spec.cable.collisionRadius ?? spec.cable.radius ?? 0.0035;
  // a dense path (1 mm), resampled to seg below; fist coordinates (fist at the origin)
  const dense: V3[] = [];
  const step = 0.001;
  for (let s = 0; s < lead; s += step) dense.push([lead - s, 0, 0]);
  const starts: number[] = [];
  let zPrev = 0, Rprev = R;
  for (let k = 0; k < N; k++) {
    starts.push(dense.length);
    const z = (k + 1) * DZ;
    const woven = k > 0 && pattern[k - 1] === 'u';
    const Rk = R * (1 + 0.035 * wobble(k, 1));
    // a woven loop is the cable to the floor of an unter loop: it hung behind that loop, down
    // through the middle of its eye and out over its bottom; so it runs inside the previous
    // loop's circle (seen from the front), crosses its arc behind it on the way down, comes round
    // outside it at the bottom and only then to the front
    const din = woven ? Math.max(0, Rk - Rprev) + 2 * rc : 0;
    const dout = woven ? Math.max(0, Rprev - Rk) + 3 * rc : 0;
    const m = Math.round((2 * Math.PI * Rk) / step);
    for (let j = 0; j < m; j++) {
      const u = j / m;
      const phi = Math.PI / 2 + 2 * Math.PI * u;
      // a woven loop runs behind the previous one down to its bottom, then to its own layer
      let zt = woven ? z - 1.5 * DZ * (1 - smooth((u - 0.42) / 0.16)) : z;
      // the first stretch out of the fist blends from where the cable came from
      zt = zPrev + (zt - zPrev) * smooth(u / 0.1);
      // the loop leaves the fist and comes back into it at the top: a slight teardrop there
      const tear = 1 - 0.12 * Math.exp(-((Math.cos(phi) / 0.35) ** 2)) * (Math.sin(phi) > 0 ? 1 : 0);
      const r = Rk - din * smooth(u / 0.06) * smooth((0.31 - u) / 0.04) + dout * smooth((u - 0.31) / 0.06) * smooth((0.72 - u) / 0.1);
      // centred below the fist: a wider circle hangs lower, its top stays in the fist
      dense.push([r * Math.cos(phi) * tear, -r + r * Math.sin(phi), zt]);
    }
    zPrev = z;
    Rprev = Rk;
  }
  // the end tail: from the top down through the eye, in front of (über) or behind (unter) the last loop
  const zt = N * DZ + (pattern[N - 1] === 'u' ? -0.5 : 0.5) * DZ;
  const top = dense[dense.length - 1];
  const bend = 0.015;
  for (let j = 1; j <= 24; j++) {
    const a = (j / 24) * (Math.PI / 2);
    dense.push([top[0] - bend * Math.sin(a), -bend * (1 - Math.cos(a)), top[2] + (zt - top[2]) * (j / 24)]);
  }
  const t0 = dense[dense.length - 1];
  for (let s = step; s < tail; s += step) dense.push([t0[0], t0[1] - s, zt]);

  // resample at seg (arc length), into world coordinates
  const pts: V3[] = [];
  const loopStart = new Map<number, number>();
  starts.forEach((d, k) => loopStart.set(d, k));
  const loopNode: number[] = [];
  let acc = 0;
  pts.push(add3(dense[0], FACTORY_FIST));
  for (let i = 1; i < dense.length; i++) {
    acc += Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1], dense[i][2] - dense[i - 1][2]);
    if (loopStart.has(i)) loopNode[loopStart.get(i) as number] = pts.length;
    if (acc >= seg) {
      acc -= seg;
      pts.push(add3(dense[i], FACTORY_FIST));
    }
  }
  const loops: [number, number][] = loopNode.map((a, k) => [a, k + 1 < N ? loopNode[k + 1] - 1 : a + Math.round(loop / seg) - 1]);
  const rod = Rod.fromPolyline(pts, { damping: 2, angularDamping: 3, ...spec.cable, groundY: null });

  // press: the start tail held in the fist, every other node held where it was laid by soft
  // guides whose targets move toward the middle of the stack (contacts sort the loops into a
  // bundle, as a hand and a strap press a coil). No gravity, so the held shape is the laid one;
  // slowly, softly and with extra iterations, so no strand is pushed through another.
  const zMid = FACTORY_FIST[2] + ((N + 1) / 2) * DZ;
  const press = spec.press ?? 0;
  const T = spec.pressTime ?? 4;
  const g = rod.opts.gravity;
  rod.opts.gravity = [0, 0, 0];
  const x0 = rod.x.slice();
  const still = (): Frame => ({ p: [...FACTORY_FIST] as V3, q: [0, 0, 0, 1] });
  rod.addGrip({ nodes: [0, loops[0][0]], keepShape: true, frame: still });
  rod.addGuide({
    nodes: [loops[0][0], rod.n - 1],
    compliance: 3e-3,
    target: (i, t) => [x0[3 * i], x0[3 * i + 1], x0[3 * i + 2] + (zMid - x0[3 * i + 2]) * press * smooth(t / (0.7 * T))],
  });
  const it = rod.opts.iterations;
  rod.opts.iterations = Math.max(it, 6);
  for (let f = 0; f < Math.round(T * 60); f++) rod.step(1 / 60, 60);
  rod.opts.iterations = it;
  rod.releaseAll();
  if (spec.memory) rod.setRestFromCurrent(0, rod.nj - 1, spec.memory);
  rod.opts.gravity = g;
  rod.v.fill(0);
  rod.om.fill(0);
  rod.time = 0;
  return { state: rod.saveState(), loops, R };
}

const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** frame of a grip that keeps the held part's pose and moves it from p0 to p1 (turning q0 → q1) from t0 to t1 */
const moving = (p0: V3, p1: V3, q1: Quat, t0: number, t1: number) => (t: number): Frame => {
  const u = smooth((t - t0) / (t1 - t0));
  return { p: lerp3(p0, p1, u), q: quatSlerp([0, 0, 0, 1], q1, u) };
};

/**
 * The check: the ring is let go gently (guides that fade out, as a hand opens), both ends are
 * gripped and pulled apart in the air in a straight line along x to `chord` of the cable's length
 * (from 1 s to `T`, after the end tail has been taken out to the side), then held for a second. Fists and forearms beyond the ends keep loops from
 * slipping off over an end. Returns the twist and writhe left (turns): over-under must leave
 * |Tw| < 0.3, same-way about one turn per loop.
 */
export function pullCheck(state: RodState, o: { chord?: number; T?: number; substeps?: number; onFrame?: (rod: Rod, t: number) => void } = {}) {
  const chord = o.chord ?? 0.92, T = o.T ?? 4.6;
  const rod = Rod.fromState(state);
  rod.opts.groundY = null;
  const n = rod.n, L = rod.totalLength * chord;
  const P = (i: number): V3 => [rod.x[3 * i], rod.x[3 * i + 1], rod.x[3 * i + 2]];
  const mid: V3 = [FACTORY_FIST[0], FACTORY_FIST[1] - 0.2, FACTORY_FIST[2]];
  // the start end already points along -x (into the ring); the end tail is turned the short way
  const dA = normalize(sub(P(3), P(0)));
  const dB = normalize(sub(P(n - 1), P(n - 4)));
  // the end tail is first taken out to the side (-x), then both ends are pulled apart
  const pB1: V3 = [mid[0] - 0.2, P(n - 2)[1] + 0.05, P(n - 2)[2]];
  const qB = quatFromTo(dB, [-1, 0, 0]);
  const fa = moving(P(1), [mid[0] + L / 2, mid[1], mid[2]], quatFromTo(dA, [-1, 0, 0]), 1.0, T);
  const fb0 = moving(P(n - 2), pB1, qB, 0, 0.6), fb1 = moving(pB1, [mid[0] - L / 2, mid[1], mid[2]], [0, 0, 0, 1], 1.0, T);
  const fb = (t: number): Frame => {
    const a = fb0(t), b = fb1(t);
    return { p: t < 0.6 ? a.p : b.p, q: a.q };
  };
  rod.addGrip({ nodes: [0, 3], keepShape: true, frame: fa });
  rod.addGrip({ nodes: [n - 4, n - 1], keepShape: true, frame: fb });
  // fists and forearms beyond the ends (pointing away along the pull), so no loop slips off an end
  const tipA = P(0), tipB = P(n - 1);
  const arm = (f: (t: number) => Frame, p0: V3, tip: V3, out: V3) => (t: number): Capsule => {
    const fr = f(t), e = add(fr.p, quatRotate(fr.q, sub(tip, p0)));
    return { a: add(e, scale(out, 0.03)), b: add(e, scale(out, 0.4)), r: 0.02 };
  };
  const armA = arm(fa, P(1), tipA, [1, 0, 0]), armB = arm(fb, P(n - 2), tipB, [-1, 0, 0]);
  rod.setCapsules((t) => [armA(t), armB(t)]);
  const x0 = rod.x.slice();
  rod.addGuide({ nodes: [4, n - 30], compliance: 1e-4, weight: (t) => 1 - smooth((t - 0.6) / 0.8), target: (i) => [x0[3 * i], x0[3 * i + 1], x0[3 * i + 2]] });
  const frames = Math.round((T + 1) * 60);
  for (let f = 0; f < frames; f++) {
    rod.step(1 / 60, o.substeps ?? 30);
    o.onFrame?.(rod, rod.time);
  }
  return { Tw: rod.twistTurns(), Wr: rod.writhe(), crossings: rod.stats.crossings };
}

// ---------------------------------------------------------------- the velcro tie

export interface TieSpec {
  /** centre of the bundle where the tie sits, the bundle's direction there, and its radius */
  center: V3;
  axis: V3;
  /** from the bundle's axis to the tie's eyelet */
  start: V3;
  radius: number;
  /** the band (m) */
  length: number;
  thickness: number;
  /** shot times: pinched, its end out of the eyelet, unwound off the bundle, put away */
  times: [number, number, number, number];
  /** where the straight band ends up: its middle at p, turned by q */
  away: { p: V3; q: Quat };
}

export interface TieState {
  /** StrapMesh.pose parameters while the tie is round the bundle */
  wrap: number;
  fold: number;
  /** once off: a rigid move of the straight band, turning about `pivot` (its middle) */
  move: Frame;
  pivot: V3;
  /** the band's end (a hand pinches it there) and the direction it points */
  tip: V3;
  dir: V3;
}

/**
 * A velcro tie opened by a hand (rendered with StrapMesh.pose and, once off, a rigid move of the
 * straight band): pinched at its end, the end pulled back out of the eyelet (fold 1 → 0), the band
 * unwound off the bundle (wrap 1 → 0, the end circles the bundle once), then carried away.
 */
export function tieMotion(s: TieSpec) {
  const [tPinch, tUnfold, tUnwrap, tAway] = s.times;
  const u = normalize(sub(s.start, scale(s.axis, s.start[0] * s.axis[0] + s.start[1] * s.axis[1] + s.start[2] * s.axis[2])));
  const a = normalize(s.axis);
  const v: V3 = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]];
  const r1 = s.radius + s.thickness / 2, r2 = r1 + s.thickness * 1.6;
  const tailLen = s.length - 2 * Math.PI * (0.8 * r1 + 0.2 * (r1 + r2) / 2);
  const pivot = add(s.center, add(scale(u, r1), scale(v, s.length / 2)));
  const ease = (t: number, t0: number, t1: number) => smooth((t - t0) / (t1 - t0));
  return (t: number): TieState => {
    const fold = 1 - ease(t, tPinch, tUnfold);
    const wrap = 1 - ease(t, tUnfold, tUnwrap);
    const th = wrap * 2 * Math.PI;
    // the end of the band: round the bundle by th, then straight on
    const rr = th > 1.6 * Math.PI ? r2 : r1;
    const p = add(s.center, add(scale(u, rr * Math.cos(th)), scale(v, rr * Math.sin(th))));
    const h = add(scale(u, -Math.sin(th)), scale(v, Math.cos(th)));
    const rest = s.length - (th > 0 ? 2 * Math.PI * r1 * wrap : 0);
    let tip = add(p, scale(h, wrap > 0.999 ? tailLen : rest));
    let dir = h;
    // folded back through the eyelet, the end lies round the bundle: the hand pinches it there
    if (fold > 0) {
      const back = add(s.center, add(scale(u, r2 + 0.004), scale(v, -0.012)));
      tip = lerp3(tip, back, fold);
      dir = normalize(lerp3(h, scale(v, -1), fold));
    }
    // carried away (lifted a little on the way) and turned
    const c = ease(t, tUnwrap, tAway);
    const target = lerp3(pivot, s.away.p, c);
    const q = quatSlerp([0, 0, 0, 1], s.away.q, c);
    const move: Frame = { p: [target[0] - pivot[0], target[1] - pivot[1] + 0.06 * Math.sin(Math.PI * c), target[2] - pivot[2]], q };
    if (c > 0) {
      tip = add(add(pivot, quatRotate(q, sub(tip, pivot))), move.p);
      dir = quatRotate(q, dir);
    }
    return { wrap, fold, move, pivot, tip, dir };
  };
}
