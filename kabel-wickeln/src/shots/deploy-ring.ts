// The rings of stage 1, items 3 and 4 (laying a cable out again): a short black charging cable
// (Ilse) and a long XLR (Kofi), both coiled over-under, with the calibrated cable presets
// (src/sim/cables.ts) and their plugs.
//
// Where the rings come from. The coil factory (wind.ts) winds a ring with a pin for a hand and
// soft guides. With the calibrated presets (strand friction, Kelvin-Voigt damping, the 8 m/s
// speed cap) its winding is not stable: for the 9 cm loops of the charging cable the joints open
// by 20-55 mm and 10⁴-10⁶ substeps hit the speed cap, and the crossings it makes do not
// alternate (cumulative writhe +0.4, +2.3, +1.3, +2.2, +1.5, +2.1 per loop for 'ououou', all one
// way). So the rings are laid out along the factory's own target layout instead: the same loop
// circles, stacked like loops hung on a rod, and the same weave (after an "unter" loop the next
// loop runs down behind it and comes to the front at the bottom, because the cable to the floor
// hung behind it), with no twist along the cable. The layout is then pressed together in the
// simulation into a bundle, as a hand and a velcro strap press a real coil, and the strands
// remember that shape (strand friction): a cable that was stored coiled.
//
// The checks (tools/simtest/deploy-check.mjs): every ring is pulled apart by its ends in the air;
// over-under must leave |Tw| < 0.3 turns, the same ring wound the same way every time (control)
// about one turn per loop. The crossings: the writhe each loop adds (with the cable to the floor
// that crosses it) must alternate in sign for over-under and keep one sign for the control.
//
// Factory coordinates (as wind.ts with lay: false): the fist at FIST, the loops hang in the x-y
// plane and stack toward +z (the first loop at the holder, every new loop in front of it), round
// counter-clockwise seen from +z (down the left side, up the right side); the start end sticks
// out of the fist along +x, the end tail hangs down through the eye. A shot places the ring with
// placeRing() and must grip it at once (it is returned at rest, nothing held).

import { Bundle, BuildCableOptions, CableSpec, Capsule, Frame, Quat, Rod, RodState, V3, add, buildCable, cross, dot, length, lerp3, normalize, quatFromTo, quatMul, quatRotate, quatSlerp, scale, smooth, sub } from '../sim';

/** where the hand holds the ring in the factory */
export const FIST: V3 = [0, 1.6, 0];

export interface RingSpec {
  cable: CableSpec;
  /** which ends carry plugs (default both) */
  plugs?: 'both' | 'start' | 'end' | 'none';
  /** segment length (default the preset's) */
  segment?: number;
  /** extra rod options (e.g. maxSpeed for a thrown ring) */
  rod?: BuildCableOptions;
  /** cable per loop [m] */
  loop: number;
  /** 'o' über, 'u' unter, one letter per loop */
  pattern: string;
  /** from the start plug's tip into the fist, from the last loop's top to the end plug's tip [m] */
  lead: number;
  tail: number;
  /** layer distance of the loops while laid out (≥ 2 cable diameters: the woven layer lies half way) */
  spacing: number;
  /** pressing: how far the loops are pulled toward the first one (0 none … 1 all; the stack closes up behind it, against the start end) */
  press?: number;
  /** seconds of pressing (default 3) */
  pressTime?: number;
  /** half width of the fist along the strands (m, default 0.022): a wider hold keeps the loops' tops apart, they hang rounder */
  fist?: number;
  /** how much the loops narrow where they leave and enter the fist (default 0.12) */
  tear?: number;
  /**
   * the strands remember the pressed ring while it is still round (before gravity), not the shape it
   * sags into in the fist (default false): a ring stored lying flat; it then hangs as round as its
   * memory and the fist let it
   */
  memoryRound?: boolean;
}

export interface Ring {
  /** the ring at rest in factory coordinates, nothing held */
  state: RodState;
  /** node ranges [first, last] and material ranges [s0, s1] of the loops, in winding order */
  loops: [number, number][];
  sLoops: [number, number][];
  /** loop radius [m] */
  R: number;
  /** the cable proper (between the plugs): nodes and material coordinates */
  cable: [number, number];
  sCable: [number, number];
  /** total length [m] */
  length: number;
  /** contact radius [m] */
  rc: number;
  /** what the fist holds (material ranges: the start end and the top of every loop): a shot must take exactly these at once */
  held: [number, number][];
  /** the bundle in the fist: centre, radius across the stack, its extent along the stack (z) */
  top: { c: V3; r: number; z0: number; z1: number };
  /** the node positions right after pressing, before gravity (factory coordinates): the ring round, as it lay stored */
  pressed: number[];
}

/** a small deterministic irregularity per loop, -1 … 1 */
const wobble = (k: number, salt: number) => Math.sin(12.9898 * (k + 1) + 78.233 * salt) * 0.5 + Math.sin(4.1 * (k + 1) * (salt + 1.7)) * 0.5;

/** The over-under (or same-way) layout as a dense path in fist coordinates, and where each loop starts on it (arc length). */
function layout(spec: RingSpec, rc: number) {
  const { loop, pattern, lead, tail, spacing: DZ } = spec;
  const N = pattern.length;
  const R = (0.97 * loop) / (2 * Math.PI);
  const dense: V3[] = [];
  const step = 0.001;
  // the start end lies right in front of the first loop (touching it: the bundle in the fist is
  // compact, a hand can pinch it)
  const zLead = Math.max(0, DZ - 2 * rc - 0.001);
  for (let s = 0; s < lead; s += step) dense.push([lead - s, 0, zLead]);
  const starts: number[] = [];
  let zPrev = zLead, Rprev = R;
  for (let k = 0; k < N; k++) {
    starts.push(dense.length);
    const z = (k + 1) * DZ;
    const woven = k > 0 && pattern[k - 1] === 'u';
    const Rk = R * (1 + 0.035 * wobble(k, 1));
    // a woven loop is the cable to the floor of an unter loop: it hung behind that loop, down through
    // the middle of its eye and out over its bottom; so it runs inside the previous loop's circle
    // (seen from the front), behind it on the way down, round its bottom outside it, and only then
    // comes to the front into its own layer
    const din = woven ? Math.max(0, Rk - Rprev) + 2 * rc : 0;
    const dout = woven ? Math.max(0, Rprev - Rk) + 3 * rc : 0;
    const m = Math.round((2 * Math.PI * Rk) / step);
    for (let j = 0; j < m; j++) {
      const u = j / m;
      const phi = Math.PI / 2 + 2 * Math.PI * u;
      let zt = woven ? z - 1.5 * DZ * (1 - smooth((u - 0.42) / 0.16)) : z;
      // the first stretch out of the fist blends from where the cable came from
      zt = zPrev + (zt - zPrev) * smooth(u / 0.1);
      // the loop leaves the fist and comes back into it at the top: a slight teardrop there
      const tear = 1 - (spec.tear ?? 0.12) * Math.exp(-((Math.cos(phi) / 0.35) ** 2)) * (Math.sin(phi) > 0 ? 1 : 0);
      const r = Rk - din * smooth(u / 0.06) * smooth((0.31 - u) / 0.04) + dout * smooth((u - 0.31) / 0.06) * smooth((0.72 - u) / 0.1);
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
  // arc length of every dense point
  const arc = new Float64Array(dense.length);
  for (let i = 1; i < dense.length; i++) arc[i] = arc[i - 1] + length(sub(dense[i], dense[i - 1]));
  return { dense, sStart: starts.map((i) => arc[i]), total: arc[dense.length - 1], R };
}

/**
 * Lays out an over-under (or same-way) ring hanging in a fist, presses it into a bundle (no
 * gravity, slowly, with extra iterations, so no strand passes through another) and returns it at
 * rest with the strands remembering the coiled shape. Deterministic.
 */
export function windRing(spec: RingSpec, onFrame?: (rod: Rod, t: number) => void): Ring {
  const cache = onFrame ? null : ringCache(spec);
  const hit = cache?.read();
  if (hit) return hit;
  const ring = layRing(spec, onFrame);
  cache?.write(ring);
  return ring;
}

/**
 * Laying out and pressing a long ring takes minutes; in Node (bakes, checks) the result is kept in
 * bakes/cache/ring-<hash>.json, keyed by the spec and the source of the functions that make it.
 * Deterministic either way; in the browser there is no cache (and no call: scenes read bakes).
 */
function ringCache(spec: RingSpec) {
  const pr = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown; cwd: () => string } }).process;
  const get = pr?.getBuiltinModule;
  if (!pr || !get) return null;
  const fs = get('node:fs') as typeof import('node:fs');
  const path = get('node:path') as typeof import('node:path');
  const crypto = get('node:crypto') as typeof import('node:crypto');
  const key = crypto.createHash('sha1').update(JSON.stringify(spec)).update(layRing.toString()).update(layout.toString()).update(buildCable.toString()).digest('hex').slice(0, 16);
  const file = path.join(pr.cwd(), 'bakes', 'cache', `ring-${key}.json`);
  const F64 = ['L', 'c', 'q', 'v', 'om', 'rest', 'restNat', 'restFric', 'alpha1', 'alpha2', 'alphaT'] as const;
  return {
    read(): Ring | null {
      if (!fs.existsSync(file)) return null;
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const k of F64) j.state[k] = Float64Array.from(j.state[k]);
      return j as Ring;
    },
    write(r: Ring) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const st: Record<string, unknown> = { ...r.state };
      for (const k of F64) st[k] = Array.from(r.state[k] ?? []);
      fs.writeFileSync(file, JSON.stringify({ ...r, state: st }));
    },
  };
}

function layRing(spec: RingSpec, onFrame?: (rod: Rod, t: number) => void): Ring {
  const rc = spec.cable.od / 2;
  const L = layout(spec, rc);
  const pts = L.dense.map((p) => add(p, FIST));
  const built = buildCable(spec.cable, pts, { plugs: spec.plugs ?? 'both', segment: spec.segment, groundY: null, ...spec.rod });
  const { rod } = built;
  const N = spec.pattern.length;
  const sLoops: [number, number][] = L.sStart.map((s, k) => [s, k + 1 < N ? L.sStart[k + 1] : s + spec.loop]);
  const loops: [number, number][] = sLoops.map(([a, b]) => [rod.segmentAt(a), rod.segmentAt(b) - 1]);

  // press: the start end held in the fist, every other node held where it was laid by soft guides
  // whose targets move toward the middle of the stack; contacts sort the loops into a bundle
  // (towards the first loop, which lies against the start end: the bundle closes up behind it)
  const zMid = FIST[2] + spec.spacing;
  const press = spec.press ?? 0;
  const T = spec.pressTime ?? 3;
  const g = rod.opts.gravity;
  rod.opts.gravity = [0, 0, 0];
  const x0 = rod.x.slice();
  const fist = rod.bundle({ frame: { p: [...FIST] as V3, q: [0, 0, 0, 1] }, blend: 0.001 });
  fist.add(0, sLoops[0][0]);
  const guide = rod.addGuide({
    nodes: [loops[0][0], rod.n - 1],
    compliance: 3e-3,
    target: (i, t) => [x0[3 * i], x0[3 * i + 1], x0[3 * i + 2] + (zMid - x0[3 * i + 2]) * press * smooth(t / (0.7 * T))],
  });
  const it = rod.opts.iterations;
  rod.opts.iterations = Math.max(it, 6);
  for (let f = 0; f < Math.round(T * 60); f++) {
    rod.step(1 / 60, 60);
    onFrame?.(rod, rod.time);
  }
  rod.removeGuide(guide);
  rod.opts.iterations = it;
  if (spec.memoryRound) rod.rememberShape();
  const pressed = Array.from(rod.x, (v) => Math.fround(v));
  // the fist takes the top of every loop (where a hand holds a coil), gravity comes back and the
  // loops hang and settle; then the strands remember this shape (it was stored like this)
  const held: [number, number][] = [];
  for (let j = 0; j < rod.ns; j++) {
    const c = [rod.c[3 * j], rod.c[3 * j + 1], rod.c[3 * j + 2]];
    const inFist = c[1] > FIST[1] - 0.02 && Math.abs(c[0] - FIST[0]) < (spec.fist ?? 0.022);
    if (!inFist && rod.sNode[j] > sLoops[0][0]) continue;
    const last = held[held.length - 1];
    if (last && Math.abs(last[1] - rod.sNode[j]) < 1e-9) last[1] = rod.sNode[j + 1];
    else held.push([rod.sNode[j], rod.sNode[j + 1]]);
  }
  for (const [a, b] of held) fist.add(a, b);
  rod.opts.gravity = g;
  for (let f = 0; f < 72; f++) {
    rod.step(1 / 60, 30);
    onFrame?.(rod, rod.time);
  }
  if (!spec.memoryRound) rod.rememberShape();
  rod.v.fill(0);
  rod.om.fill(0);
  rod.time = 0;

  // the bundle in the fist: centre, radius across the stack, extent along it
  let c: V3 = [0, 0, 0], m = 0, z0 = Infinity, z1 = -Infinity;
  const inside = (j: number) => held.some(([a, b]) => rod.sNode[j] >= a - 1e-9 && rod.sNode[j + 1] <= b + 1e-9) && rod.sNode[j] > sLoops[0][0];
  for (let j = 0; j < rod.ns; j++) {
    if (!inside(j)) continue;
    const p: V3 = [rod.c[3 * j], rod.c[3 * j + 1], rod.c[3 * j + 2]];
    c = add(c, p);
    m++;
    z0 = Math.min(z0, p[2]);
    z1 = Math.max(z1, p[2]);
  }
  c = scale(c, 1 / Math.max(1, m));
  let r2 = 0;
  for (let j = 0; j < rod.ns; j++) if (inside(j)) r2 = Math.max(r2, Math.hypot(rod.c[3 * j] - c[0], rod.c[3 * j + 1] - c[1]));
  fist.remove();
  return { state: rod.saveState(), loops, sLoops, R: L.R, cable: built.cable, sCable: built.sCable, length: rod.totalLength, rc, held, top: { c, r: r2 + rc, z0, z1 }, pressed };
}

/** A rod from a ring's state with its plug masses back (they are not part of a saved state). */
export function ringRod(ring: Ring, state: RodState, spec: RingSpec): Rod {
  const rod = Rod.fromState(state);
  const plug = spec.cable.plug;
  const plugs = spec.plugs ?? 'both';
  if (plug) {
    const S = rod.sNode;
    const spread = (j0: number, j1: number) => {
      const len = S[j1] - S[j0];
      for (let j = j0; j < j1; j++) rod.addMass(j, plug.mass * (rod.L[j] / len) - rod.m[j]);
    };
    if (plugs === 'both' || plugs === 'start') spread(0, ring.cable[0]);
    if (plugs === 'both' || plugs === 'end') spread(ring.cable[1], rod.ns);
  }
  return rod;
}

/**
 * A saved state moved by d after turning it by q about FIST (to place a ring in a shot); the
 * floor (groundY) is set to `ground`.
 */
export function placeRing(s: RodState, d: V3, q: Quat, ground: number | null): RodState {
  const out: RodState = { ...s, opts: { ...s.opts, groundY: ground }, c: s.c.slice(), q: s.q.slice(), v: s.v.slice(), om: s.om.slice() };
  for (let j = 0; j < s.L.length; j++) {
    const c = quatRotate(q, [s.c[3 * j] - FIST[0], s.c[3 * j + 1] - FIST[1], s.c[3 * j + 2] - FIST[2]]);
    out.c.set([c[0] + FIST[0] + d[0], c[1] + FIST[1] + d[1], c[2] + FIST[2] + d[2]], 3 * j);
    out.v.set(quatRotate(q, [s.v[3 * j], s.v[3 * j + 1], s.v[3 * j + 2]]), 3 * j);
    out.om.set(quatRotate(q, [s.om[3 * j], s.om[3 * j + 1], s.om[3 * j + 2]]), 3 * j);
    out.q.set(quatMul(q, [s.q[4 * j], s.q[4 * j + 1], s.q[4 * j + 2], s.q[4 * j + 3]]), 4 * j);
  }
  return out;
}

/** a point of the factory turned by q about FIST and moved by d (the same as placeRing) */
export const placePoint = (p: V3, d: V3, q: Quat): V3 => add(add(quatRotate(q, sub(p, FIST)), FIST), d);

// ------------------------------------------------------------------ checks

/**
 * The crossings, read from the ring (factory coordinates, the stack along +z): for every loop, on
 * which side of it the cable that follows it passes (the next loop on its way down the left side,
 * or the end tail through the eye): +1 in front (über: the cable to the floor lies on top), -1
 * behind (unter: the loop covers it). Over-under must alternate; it also shows that pressing did
 * not push a strand through another.
 */
export function crossings(rod: Rod, ring: Ring): number[] {
  const x = rod.x, out: number[] = [];
  const N = ring.loops.length;
  for (let k = 0; k < N; k++) {
    const [a, b] = ring.loops[k];
    const per = b - a + 1;
    // the strand that follows: the next loop's first 40 %, or the end tail where it hangs down past
    // the loop's bottom (out of the eye)
    const last = k + 1 >= N;
    const s0 = last ? b + 1 : ring.loops[k + 1][0] + Math.round(0.08 * per);
    const s1 = last ? rod.n - 1 : ring.loops[k + 1][0] + Math.round(0.4 * per);
    let yb = Infinity;
    for (let j = a; j <= b; j++) yb = Math.min(yb, x[3 * j + 1]);
    let sum = 0, cnt = 0;
    for (let i = s0; i <= s1; i++) {
      if (last && Math.abs(x[3 * i + 1] - yb) > 0.02) continue;
      // where it lies over loop k, seen along the stack: the nearest node of loop k in x-y
      let best = Infinity, bz = 0;
      for (let j = a; j <= b; j++) {
        const d = Math.hypot(x[3 * i] - x[3 * j], x[3 * i + 1] - x[3 * j + 1]);
        if (d < best) {
          best = d;
          bz = x[3 * j + 2];
        }
      }
      if (best < 4 * ring.rc) {
        sum += Math.sign(x[3 * i + 2] - bz);
        cnt++;
      }
    }
    out.push(cnt ? sum / cnt : 0);
  }
  return out;
}

/** frame of a hand that keeps the held end's pose and moves it from p0 to p1, turning q0 → q1, from t0 to t1 */
const moving = (p0: V3, p1: V3, q1: Quat, t0: number, t1: number) => (t: number): Frame => {
  const u = smooth((t - t0) / (t1 - t0));
  return { p: lerp3(p0, p1, u), q: quatSlerp([0, 0, 0, 1], q1, u) };
};

/**
 * The check: the ring is let go gently (guides that fade out, as a hand opens), both ends are
 * held (by the plugs and a few cm of cable, as hands hold them, so the ends cannot turn) and pulled
 * apart in the air along x to `chord` of the cable's length (from 1 s to T, after the end tail has
 * been taken out to the side), then held for a second. Fists and forearms beyond the ends keep loops
 * from slipping off over an end. Returns the twist and writhe left (turns): over-under must leave
 * |Tw| < 0.3, same-way about one turn per loop.
 */
export function pullApart(ring: Ring, spec: RingSpec, o: { chord?: number; T?: number; substeps?: number; onFrame?: (rod: Rod, t: number) => void } = {}) {
  const chord = o.chord ?? 0.9, T = o.T ?? 4.6;
  const rod = ringRod(ring, ring.state, spec);
  rod.opts.groundY = null;
  const n = rod.n, Ltot = rod.totalLength * chord;
  const P = (i: number): V3 => [rod.x[3 * i], rod.x[3 * i + 1], rod.x[3 * i + 2]];
  const mid: V3 = [FIST[0], FIST[1] - 0.2, FIST[2]];
  const hold = 0.03;
  const iA = rod.segmentAt(ring.sCable[0] + hold), iB = rod.segmentAt(ring.sCable[1] - hold) + 1;
  const dA = normalize(sub(P(iA + 2), P(0)));
  const dB = normalize(sub(P(n - 1), P(iB - 2)));
  const pA = P(iA), pB = P(iB);
  // the end tail is first swung out to the side (-x), well within its free length
  const sTop = ring.sLoops[ring.sLoops.length - 1][1], free = ring.sCable[1] - hold - sTop;
  const pB1 = add(rod.pointAt(sTop), scale(normalize([-0.6, -0.8, 0]), 0.8 * free));
  const qB = quatFromTo(dB, [-1, 0, 0]);
  const fa = moving(pA, [mid[0] + Ltot / 2, mid[1], mid[2]], quatFromTo(dA, [-1, 0, 0]), 1.0, T);
  const fb0 = moving(pB, pB1, qB, 0, 0.6), fb1 = moving(pB1, [mid[0] - Ltot / 2, mid[1], mid[2]], [0, 0, 0, 1], 1.0, T);
  const fb = (t: number): Frame => {
    const a = fb0(t), b = fb1(t);
    return { p: t < 0.6 ? a.p : b.p, q: a.q };
  };
  // the ends are held rigidly in their pose, turning about the grip point
  const ha: Bundle = rod.bundle({ frame: fa, hand: 0, blend: 0.001 });
  ha.add(0, ring.sCable[0] + hold);
  const hb: Bundle = rod.bundle({ frame: fb, hand: 1, blend: 0.001 });
  hb.add(ring.sCable[1] - hold, rod.totalLength);
  const arm = (f: (t: number) => Frame, p0: V3, tip: V3, out: V3) => (t: number): Capsule => {
    const fr = f(t), e = add(fr.p, quatRotate(fr.q, sub(tip, p0)));
    return { a: add(e, scale(out, 0.03)), b: add(e, scale(out, 0.4)), r: 0.02 };
  };
  const armA = arm(fa, pA, P(0), [1, 0, 0]), armB = arm(fb, pB, P(n - 1), [-1, 0, 0]);
  rod.setCapsules((t) => [armA(t), armB(t)]);
  // the fist holds the ring as it was stored and opens at 0.6 s (the start end stays in the other hand)
  const fist = rod.bundle({ frame: { p: [...FIST] as V3, q: [0, 0, 0, 1] }, blend: 0.001 });
  for (const [a, b] of ring.held) if (b > ring.sCable[0] + hold + 0.01) fist.add(Math.max(a, ring.sCable[0] + hold + 0.01), b);
  let opened = false;
  const frames = Math.round((T + 1) * 60);
  for (let f = 0; f < frames; f++) {
    if (!opened && rod.time >= 0.6) {
      // (quickly: pieces a bundle still holds, leaving or not, do not collide with each other, so a
      // slow release lets strands that move apart under gravity pass through each other)
      fist.release(-Infinity, Infinity, 0.06);
      opened = true;
    }
    rod.step(1 / 60, o.substeps ?? 30);
    o.onFrame?.(rod, rod.time);
  }
  return { Tw: rod.twistTurns(), Wr: rod.writhe(), gap: rod.maxJointGap(), capped: rod.stats.speedCapped, warnings: rod.stats.warnings, rod };
}

/** unit vector perpendicular to a, as close to b as possible */
export const across = (b: V3, a: V3): V3 => normalize(sub(b, scale(a, dot(a, b))));
export const crossN = (a: V3, b: V3): V3 => normalize(cross(a, b));
