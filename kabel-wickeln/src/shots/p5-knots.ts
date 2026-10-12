// Stage 5.1 "Das Ende durch den Ring" (KONZEPT), the simulated cable for the part p5-knots. The
// user's XLR (sim/cables.ts XLR preset, unchanged), 5 m, six loops over-under (ü u ü u ü u).
//
// The ring is laid out the way deploy-ring.ts lays its rings (the same loop circles and weave, then
// pressed into a bundle in a fist, the strands remembering it round), with one difference: where the
// end goes after the last loop.
//   'free'    the end hangs out of the ring as it always does after coiling (both ends outside),
//             as long as the threaded one: the same 5.2 m cable;
//   'thread'  the end has fallen through the middle: from the last loop it runs down behind it,
//             round under its bottom, up in front of the ring and back through the eye of all six
//             loops, and hangs out of the ring's middle on the other side. This is the old coil
//             factory's threading (wind.ts thread: true); pulled out, every unter loop ties an
//             overhand knot (the knot determinant of the threaded ring is 27 = three overhand knots,
//             of the free one 1: topology.ts, scratchpad p5k/ring.mjs).
//
// Shots (the XLR preset; contact radius 1.2 × KNOT_RC, 60 substeps × 4 iterations so no strand passes
// through another in a tight knot; the hands are keyframes, the mocap shots p5.knots.* replace them):
//   p5-knots-crate  the cause: the threaded ring, its velcro open, held flat over a crate and let go:
//                   it falls flat onto the crate's bottom, the end through its middle (simulated; how
//                   the end got there is not: the ring is laid out that way)
//   p5-knots-pull   ✗ the threaded ring hangs from Noor's left fist (a bundle on the loops' tops); her
//                   right hand (a pinch) takes the end and pulls it out hand over hand; the fist lets
//                   the loops go one after the other when the cable between the hands gets short; in
//                   every second loop an overhand knot closes (loop 6, then loop 4; loop 2's stays
//                   loose within the 16 s). Fully simulated, nothing guided
//   p5-knots-fix    she takes the end before pulling and puts it back up through the middle to the
//                   front (the end's path is prescribed, the cable follows by itself): the knots in
//                   the ring are gone (knot determinant 27 → 1); then she pulls as in knot-ok
//   p5-knots-ok     ✓ the same ring with both ends outside, the same hands: the loops come off, no knot
//
// Knots are counted by the loop they are made of (knotSpans: 15 cm of cable inside a 3 cm ball, for
// 0.4 s); the knot determinant of the whole cable (topology.ts, track det) says how many knots there
// are topologically, closed or still hidden in the ring.
//
// World coordinates as in the other stage 5 parts: Noor stands at the origin facing -z, her right is
// +x, the floor is y = 0. The ring hangs from her left hand in front of her left hip, its loops
// facing forward and to her right (N, as in p5-eight), the first loop at her hand, every later one
// further out.

import { Bundle, Capsule, Frame, Pinch, Quat, Rod, RodState, V3, XLR, add, buildCable, cross, dot, frameTrack, gripFrame, length, normalize, quatFromAxisAngle, quatFromFrame, quatMul, quatRotate, scale, smooth, sub } from '../sim';
import type { ShotDef } from './types';
import type { Ring, RingSpec } from './deploy-ring';
import { knots } from './topology';

// ------------------------------------------------------------------------------------- the ring

/**
 * contact radius of the knot shots: 1.2 × the XLR's 3.2 mm (the visual radius stays): a strand pulled
 * through a tight knot must never pass through another (as the old knot shot did, with 1.2 ×)
 */
export const KNOT_RC = 0.0038;
/** the ring: 6 loops of 72 cm (Ø 22 cm), the start end 25 cm (male plug, the velcro lives there), 5.0 m in all */
export const KNOT_RING: RingSpec = { cable: XLR, loop: 0.72, pattern: 'ououou', lead: 0.25, tail: 0.45, spacing: 0.016, press: 0.6, pressTime: 3, fist: 0.04, tear: 0, memoryRound: true, rod: { collisionRadius: KNOT_RC } };
export type TailMode = 'free' | 'thread';

/** where the fist holds the ring while it is made (as deploy-ring.ts FIST) */
const FIST: V3 = [0, 1.6, 0];

const wobble = (k: number, salt: number) => Math.sin(12.9898 * (k + 1) + 78.233 * salt) * 0.5 + Math.sin(4.1 * (k + 1) * (salt + 1.7)) * 0.5;

/**
 * The layout as a dense path in fist coordinates (deploy-ring.ts layout(), the loops unchanged) and
 * where each loop starts; the end tail either hangs out (free) or is threaded through the eye.
 */
function layout(spec: RingSpec, rc: number, tailMode: TailMode) {
  const { loop, pattern, lead, tail, spacing: DZ } = spec;
  const N = pattern.length;
  const R = (0.97 * loop) / (2 * Math.PI);
  const dense: V3[] = [];
  const step = 0.001;
  const zLead = Math.max(0, DZ - 2 * rc - 0.001);
  for (let s = 0; s < lead; s += step) dense.push([lead - s, 0, zLead]);
  const starts: number[] = [];
  let zPrev = zLead, Rprev = R;
  for (let k = 0; k < N; k++) {
    starts.push(dense.length);
    const z = (k + 1) * DZ;
    const woven = k > 0 && pattern[k - 1] === 'u';
    const Rk = R * (1 + 0.035 * wobble(k, 1));
    const din = woven ? Math.max(0, Rk - Rprev) + 2 * rc : 0;
    const dout = woven ? Math.max(0, Rprev - Rk) + 3 * rc : 0;
    const m = Math.round((2 * Math.PI * Rk) / step);
    for (let j = 0; j < m; j++) {
      const u = j / m;
      const phi = Math.PI / 2 + 2 * Math.PI * u;
      let zt = woven ? z - 1.5 * DZ * (1 - smooth((u - 0.42) / 0.16)) : z;
      zt = zPrev + (zt - zPrev) * smooth(u / 0.1);
      const tear = 1 - (spec.tear ?? 0.12) * Math.exp(-((Math.cos(phi) / 0.35) ** 2)) * (Math.sin(phi) > 0 ? 1 : 0);
      const r = Rk - din * smooth(u / 0.06) * smooth((0.31 - u) / 0.04) + dout * smooth((u - 0.31) / 0.06) * smooth((0.72 - u) / 0.1);
      dense.push([r * Math.cos(phi) * tear, -r + r * Math.sin(phi), zt]);
    }
    zPrev = z;
    Rprev = Rk;
  }
  // the end tail leaves the top of the last loop, bends down in front of (über) or behind (unter) it
  const zt = N * DZ + (pattern[N - 1] === 'u' ? -0.5 : 0.5) * DZ;
  const top = dense[dense.length - 1];
  const bend = 0.015;
  for (let j = 1; j <= 24; j++) {
    const a = (j / 24) * (Math.PI / 2);
    dense.push([top[0] - bend * Math.sin(a), -bend * (1 - Math.cos(a)), top[2] + (zt - top[2]) * (j / 24)]);
  }
  const t0 = dense[dense.length - 1];
  const tailStart = dense.length;
  {
    // threaded: down past the loops' bottoms (between the last two layers for an unter loop), round
    // under the last loop to its front, up in front of the ring to the eye, back through the eye of
    // every loop, and down behind the ring (out of its middle on the side of the first loop)
    const x0 = t0[0];
    const yLow = -2 * R * 1.06 - 0.03, rB = 0.022;
    const zF = (N + 1.1) * DZ, zB = -1.1 * DZ, yEye = -R * 1.1;
    const pts: V3[] = [];
    const line = (a: V3, b: V3) => {
      const k = Math.max(1, Math.round(length(sub(b, a)) / step));
      for (let j = 1; j <= k; j++) pts.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k, a[2] + ((b[2] - a[2]) * j) / k]);
    };
    /** a quarter turn in the y-z plane from a (going along da) to going along db, radius r */
    const arc = (a: V3, da: V3, db: V3, r: number): V3 => {
      const c = add(a, scale(db, r));
      const M = Math.max(4, Math.round((Math.PI * r) / 2 / step));
      let last = a;
      for (let j = 1; j <= M; j++) {
        const th = (j / M) * (Math.PI / 2);
        last = add(c, add(scale(db, -r * Math.cos(th)), scale(da, r * Math.sin(th))));
        pts.push(last);
      }
      return last;
    };
    let p: V3 = [x0, t0[1], zt];
    const pDown: V3 = [x0, yLow + rB, zt];
    line(p, pDown);
    p = arc(pDown, [0, -1, 0], [0, 0, 1], rB);
    const pFront: V3 = [x0, p[1], zF - rB];
    line(p, pFront);
    p = arc(pFront, [0, 0, 1], [0, 1, 0], rB);
    const pUp: V3 = [x0, yEye - rB, zF];
    line(p, pUp);
    p = arc(pUp, [0, 1, 0], [0, 0, -1], rB);
    const pBack: V3 = [x0, yEye, zB + rB];
    line(p, pBack);
    p = arc(pBack, [0, 0, -1], [0, -1, 0], rB);
    let used = 0;
    for (let i = 1; i < pts.length; i++) used += length(sub(pts[i], pts[i - 1]));
    const left = Math.max(0.12, tail - used);
    line(p, [p[0], p[1] - left, p[2]]);
    if (tailMode === 'thread') dense.push(...pts);
    else {
      // free: the end hangs straight down out of the ring, as long as the threaded one (the same cable)
      let l = 0;
      for (let i = 1; i < pts.length; i++) l += length(sub(pts[i], pts[i - 1]));
      l += length(sub(pts[0], t0));
      for (let s = step; s < Math.max(tail, l); s += step) dense.push([t0[0], t0[1] - s, zt]);
    }
  }
  const arc = new Float64Array(dense.length);
  for (let i = 1; i < dense.length; i++) arc[i] = arc[i - 1] + length(sub(dense[i], dense[i - 1]));
  return { dense, sStart: starts.map((i) => arc[i]), sTail: arc[tailStart], total: arc[dense.length - 1], R };
}

/** a knot ring: the deploy-ring Ring plus where its end tail starts */
export interface KnotRing extends Ring {
  tailMode: TailMode;
  /** material coordinate where the end tail leaves the last loop's top */
  sTail: number;
}

/**
 * Lays the ring out, presses it into a bundle (no gravity, slowly, extra iterations: no strand
 * passes through another), lets it hang from the fist and settle, and returns it at rest, nothing
 * held (deploy-ring.ts layRing, with the end tail of `tailMode`). Deterministic; cached in Node.
 */
export function knotRing(tailMode: TailMode, onFrame?: (rod: Rod, t: number) => void): KnotRing {
  const spec = KNOT_RING;
  const cache = onFrame ? null : ringCache(spec, tailMode);
  const hit = cache?.read();
  if (hit) return hit;
  const ring = layKnotRing(spec, tailMode, onFrame);
  cache?.write(ring);
  return ring;
}

function ringCache(spec: RingSpec, tailMode: TailMode) {
  const pr = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown; cwd: () => string } }).process;
  const get = pr?.getBuiltinModule;
  if (!pr || !get) return null;
  const fs = get('node:fs') as typeof import('node:fs');
  const path = get('node:path') as typeof import('node:path');
  const crypto = get('node:crypto') as typeof import('node:crypto');
  const key = crypto.createHash('sha1').update(JSON.stringify(spec)).update(tailMode).update(layKnotRing.toString()).update(layout.toString()).update(buildCable.toString()).digest('hex').slice(0, 16);
  const file = path.join(pr.cwd(), 'bakes', 'cache', `knotring-${key}.json`);
  const F64 = ['L', 'c', 'q', 'v', 'om', 'rest', 'restNat', 'restFric', 'alpha1', 'alpha2', 'alphaT'] as const;
  return {
    read(): KnotRing | null {
      if (!fs.existsSync(file)) return null;
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const k of F64) if (j.state[k]) j.state[k] = Float64Array.from(j.state[k]);
      return j as KnotRing;
    },
    write(r: KnotRing) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const st: Record<string, unknown> = { ...r.state };
      for (const k of F64) st[k] = Array.from(r.state[k] ?? []);
      fs.writeFileSync(file, JSON.stringify({ ...r, state: st }));
    },
  };
}

function layKnotRing(spec: RingSpec, tailMode: TailMode, onFrame?: (rod: Rod, t: number) => void): KnotRing {
  const rc = spec.cable.od / 2;
  const L = layout(spec, rc, tailMode);
  const pts = L.dense.map((p) => add(p, FIST));
  const built = buildCable(spec.cable, pts, { plugs: spec.plugs ?? 'both', segment: spec.segment, groundY: null, ...spec.rod });
  const { rod } = built;
  const N = spec.pattern.length;
  const sLoops: [number, number][] = L.sStart.map((s, k) => [s, k + 1 < N ? L.sStart[k + 1] : s + spec.loop]);
  const loops: [number, number][] = sLoops.map(([a, b]) => [rod.segmentAt(a), rod.segmentAt(b) - 1]);

  // press (as deploy-ring.ts): the start end held, the rest pulled toward the first loop's layer by
  // soft guides; contacts sort the loops (and the threaded end) into a bundle
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
  // the fist takes the top of every loop, gravity comes back, the loops hang and settle
  const held: [number, number][] = [];
  for (let j = 0; j < rod.ns; j++) {
    const c = [rod.c[3 * j], rod.c[3 * j + 1], rod.c[3 * j + 2]];
    const inFist = c[1] > FIST[1] - 0.02 && Math.abs(c[0] - FIST[0]) < (spec.fist ?? 0.022);
    if (!inFist && rod.sNode[j] > sLoops[0][0]) continue;
    // (never the end tail: it leaves the fist)
    if (rod.sNode[j] > L.sTail + 0.005) continue;
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
  return { state: rod.saveState(), loops, sLoops, R: L.R, cable: built.cable, sCable: built.sCable, length: rod.totalLength, rc, held, top: { c, r: r2 + rc, z0, z1 }, pressed, tailMode, sTail: rod.sNode[rod.segmentAt(L.sTail)] };
}

/** a rod from a ring's state with its plug masses back (they are not part of a saved state) */
export function knotRod(ring: KnotRing, state: RodState = ring.state): Rod {
  const rod = Rod.fromState(state);
  const plug = KNOT_RING.cable.plug;
  if (plug) {
    const S = rod.sNode;
    const spread = (j0: number, j1: number) => {
      const len = S[j1] - S[j0];
      for (let j = j0; j < j1; j++) rod.addMass(j, plug.mass * (rod.L[j] / len) - rod.m[j]);
    };
    spread(0, ring.cable[0]);
    spread(ring.cable[1], rod.ns);
  }
  return rod;
}

/** a saved state turned by q about FIST and moved by d; the floor set to `ground` */
export function placeKnotRing(s: RodState, d: V3, q: Quat, ground: number | null): RodState {
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

/** a factory point turned by q about FIST and moved by d (the same as placeKnotRing) */
export const placeKnotPoint = (p: V3, d: V3, q: Quat): V3 => add(add(quatRotate(q, sub(p, FIST)), FIST), d);
export const KNOT_FIST = FIST;

/**
 * The check of a ring's topology: the ring let go in the air with both ends held and pulled far
 * apart (the start end along +x, the other end along -x, after it is first taken out of the ring the
 * way it hangs), then the knots counted (knot determinant: 3^k for k overhand knots). A threaded
 * over-under ring of six loops must give 3 knots, a free one none.
 */
export function pullApartKnots(ring: KnotRing, o: { T?: number; onFrame?: (rod: Rod, t: number) => void } = {}) {
  const T = o.T ?? 5;
  const rod = knotRod(ring);
  rod.opts.groundY = null;
  const n = rod.n;
  const P = (i: number): V3 => [rod.x[3 * i], rod.x[3 * i + 1], rod.x[3 * i + 2]];
  const pa = P(2), pb = P(n - 3);
  const span = 0.95 * rod.totalLength;
  const mid: V3 = [FIST[0], FIST[1] - 0.25, FIST[2]];
  // the other end first down and out of the ring's way along its own direction, then both apart
  const out: V3 = add(pb, [0, -0.25, 0]);
  const ha = rod.bundle({ frame: (t) => ({ p: add(pa, scale(sub([mid[0] + span / 2, mid[1], mid[2]], pa), smooth((t - 0.8) / (T - 0.8)))), q: [0, 0, 0, 1] }), hand: 0, blend: 0.001 });
  ha.add(0, ring.sCable[0] + 0.03);
  const hb = rod.bundle({
    frame: (t) => {
      const a = add(pb, scale(sub(out, pb), smooth(t / 0.8)));
      return { p: add(a, scale(sub([mid[0] - span / 2, mid[1], mid[2]], a), smooth((t - 0.8) / (T - 0.8)))), q: [0, 0, 0, 1] };
    },
    hand: 1,
    blend: 0.001,
  });
  hb.add(ring.sCable[1] - 0.03, rod.totalLength);
  const frames = Math.round((T + 0.6) * 60);
  for (let f = 0; f < frames; f++) {
    rod.step(1 / 60, 60);
    o.onFrame?.(rod, rod.time);
  }
  return { ...knots(rod.x, 0, rod.n - 1), Tw: rod.twistTurns(), Wr: rod.writhe(), gap: rod.maxJointGap(), capped: rod.stats.speedCapped, rod };
}

// ------------------------------------------------------------------------------ in Noor's hands

const D2R = Math.PI / 180;
/** the loops face this way: forward, 55° to her right (as in p5-eight) */
export const KNOT_N: V3 = normalize([Math.sin(55 * D2R), 0, -Math.cos(55 * D2R)]);
/** the ring's turn from the factory (stack along +z) to her hand (stack along KNOT_N) */
export const KNOT_Q: Quat = quatFromAxisAngle(0, 1, 0, Math.PI - 55 * D2R);
/** the strands at the ring's top run this way (factory +x): forward and to her left */
export const KNOT_A: V3 = quatRotate(KNOT_Q, [1, 0, 0]);
/** where the middle of the bunch at the ring's top is: in her left fist, in front of her left hip */
export const KNOT_HOLD: V3 = [-0.13, 0.98, -0.31];
/** the left fist's grip frame on the bunch (rig: hold 'coil'): along the strands, the palm behind and above them */
export const KNOT_LEFT = gripFrame(KNOT_HOLD, KNOT_A, normalize(add(scale(KNOT_N, -0.8), [0, 0.6, 0])));

/** where the cable proper starts and ends (nodes) and the node the velcro tie sits on (9 cm from the male plug's tip), as tracks for the part */
function ringTracks(ring: KnotRing, rod: Rod) {
  const tie = rod.segmentAt(0.09);
  return { cable0: () => ring.cable[0], cable1: () => ring.cable[1], tieNode: () => tie };
}

/** the rod of a knot shot: the ring placed in her left hand, the floor at y = 0 */
function ringInHand(ring: KnotRing): Rod {
  const d = sub(KNOT_HOLD, placeKnotPoint(ring.top.c, [0, 0, 0], KNOT_Q));
  return knotRod(ring, placeKnotRing(ring.state, d, KNOT_Q, 0));
}

/** Noor's legs and body as capsules (standing at the origin): the pulled cable must not pass through them */
const BODY_CAPS: Capsule[] = [
  { a: [-0.09, 0.88, 0.0], b: [-0.12, 0.1, 0.01], r: 0.075 },
  { a: [0.09, 0.88, 0.0], b: [0.12, 0.1, 0.01], r: 0.075 },
  { a: [0, 0.92, 0.0], b: [0, 1.38, 0.02], r: 0.15 },
];

/** the right hand at rest beside her right hip, open (pads frame) */
export const KNOT_REST: Frame = gripFrame([0.26, 0.82, -0.08], normalize([0.1, -1, -0.15]), normalize([-0.4, 0, -1]));
/** where a pull stroke ends: out to her right, at hip height, a little in front of her */
export const KNOT_OUT: V3 = [0.56, 0.86, -0.14];

/**
 * The pull: the hand's speeds [m/s] (reach: seconds), the force it slows down at [N] (pinch force,
 * reads low for a held pinch); the left hand lets the next loop go when the cable between the hands
 * is shorter than their distance plus `slack` [m] (or pulled with more than fRelease [N]); where the
 * right hand takes the end first and takes the cable again near the ring [m]
 */
const PULL = { reach: 0.6, close: 0.13, vmax: 0.6, fmax: 6, fRelease: 2.0, slack: 0.25, firstGrab: 0.09, regrab: 0.12 };

/** knot shot times [s] */
export const KNOT_T = {
  /** the right hand sets off for the end */
  reach0: 0.6,
  /** fix: after the first knot, the hand holds still this long ("Stopp") */
  stop: 1.0,
};

export type KnotMode = 'pull' | 'ok' | 'fix';
/** the right hand's phases, as recorded in the track 'phase' */
export const PHASES = ['wait', 'reach', 'close', 'pull', 'open', 'stop', 'done', 'slack', 'letgo', 'toEnd', 'closeEnd', 'thread', 'outside'] as const;
/** a knot pulled tight by hand: this much cable [m] inside a ball of this radius [m] (topology.ts tightKnots) */
const KNOT_TIGHT = { span: 0.15, radius: 0.03, hold: 0.4 };
/** fix: how fast the hand takes the end back through the knot and the ring [m/s] */
const FIX_SPEED = 0.25;

const ease5 = (u: number) => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * x * (10 - 15 * x + 6 * x * x);
};
const lerpV = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const slerpQ = (a: Quat, b: Quat, u: number): Quat => {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1;
  d *= s;
  if (d > 0.9995) {
    const q: Quat = [a[0] + (s * b[0] - a[0]) * u, a[1] + (s * b[1] - a[1]) * u, a[2] + (s * b[2] - a[2]) * u, a[3] + (s * b[3] - a[3]) * u];
    const l = Math.hypot(...q);
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  }
  const th = Math.acos(d), sn = Math.sin(th), wa = Math.sin((1 - u) * th) / sn, wb = (s * Math.sin(u * th)) / sn;
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb, a[3] * wa + b[3] * wb];
};
const mixFrame = (a: Frame, b: Frame, u: number): Frame => ({ p: lerpV(a.p, b.p, u), q: slerpQ(a.q, b.q, u) });

/**
 * Tight knots (topology.ts tightKnots: `span` metres of cable inside a ball of `radius`) with the
 * node range of the tightest window: where along the cable each knot is, in cable order.
 */
export function knotSpans(x: ArrayLike<number>, n: number, seg: number, span = 0.15, radius = 0.03): { c: V3; i0: number; i1: number }[] {
  const w = Math.max(2, Math.round(span / seg));
  const out: { c: V3; i0: number; i1: number }[] = [];
  let best: { r: number; c: V3; i: number } | null = null, last = -Infinity;
  for (let i = 0; i + w < n; i++) {
    let cx = 0, cy = 0, cz = 0;
    for (let k = i; k <= i + w; k++) { cx += x[3 * k]; cy += x[3 * k + 1]; cz += x[3 * k + 2]; }
    cx /= w + 1; cy /= w + 1; cz /= w + 1;
    let r = 0;
    for (let k = i; k <= i + w; k++) r = Math.max(r, Math.hypot(x[3 * k] - cx, x[3 * k + 1] - cy, x[3 * k + 2] - cz));
    if (r >= radius) continue;
    if (i - last > w) {
      if (best) out.push({ c: best.c, i0: best.i, i1: best.i + w });
      best = null;
    }
    last = i;
    if (!best || r < best.r) best = { r, c: [cx, cy, cz], i };
  }
  if (best) out.push({ c: best.c, i0: best.i, i1: best.i + w });
  return out;
}

/** the pads on the cable at material s: d3 along the cable toward the end, the index finger (d1) up and toward her */
function padsOn(rod: Rod, s: number): Frame {
  const p = rod.pointAt(s), t = rod.tangentAt(s);
  let n = sub([0, 0.8, 0.6], scale(t, dot([0, 0.8, 0.6], t)));
  if (length(n) < 1e-3) n = sub([1, 0, 0], scale(t, t[0]));
  return gripFrame(p, t, normalize(n));
}

/**
 * The knot shots' controller (simulation in the loop): the left fist holds the ring's top (a bundle
 * on what the factory's fist held) and lets the loops go one by one, from the last, whenever the
 * cable between it and the right hand gets short; the right hand reaches for the end, closes on
 * it, pulls it out to her right (slowing down as the force nears PULL.fmax), opens, reaches back
 * for the cable near the ring, and again. Records the hands' frames (vectors lh, rh) and what the
 * part needs to show (tracks).
 */
function knotController(mode: KnotMode, ring: KnotRing, rod: Rod) {
  const fps = 60, dt = 1 / fps;
  rod.setCapsules(BODY_CAPS);
  const left = rod.bundle({ frame: () => KNOT_LEFT, hand: 0, blend: 0.001 });
  for (const [a, b] of ring.held) left.add(a, b);
  /** junctions still held: 0 (start end) … 6 (the last loop's end, where the tail leaves) */
  let held = ring.held.length - 1;
  const pin: Pinch = rod.pinch({ frame: KNOT_REST, mode: 'free', hand: 1, s: ring.sCable[1] - PULL.firstGrab, blend: 0.12 });
  const st = {
    phase: 'wait' as 'wait' | 'reach' | 'close' | 'pull' | 'open' | 'stop' | 'done' | 'slack' | 'letgo' | 'toEnd' | 'closeEnd' | 'thread' | 'outside',
    t0: 0,
    from: KNOT_REST as Frame,
    s: ring.sCable[1] - PULL.firstGrab,
    cur: KNOT_REST as Frame,
    v: 0,
    strokes: 0,
    released: [] as number[],
    knotT: [] as number[],
    stopAt: Infinity,
    pulled: 0,
    lastRelease: -1,
    /** fix: the end's way back (polyline, cumulative length) and how far along it the hand is */
    path: [] as V3[],
    pathL: [] as number[],
    along: 0,
    /** fix: the end is outside again (from then on she pulls it out as in knot-ok) */
    fixed: false,
    fixedAt: Infinity,
    strokesFixed: 0,
  };
  let knotCount = 0, spans: { c: V3; i0: number; i1: number }[] = [];
  /**
   * The knots, by the loop they are made of, in the order they closed. A knot is counted when
   * KNOT_TIGHT.span of cable fits into a ball of KNOT_TIGHT.radius (pulled tight by hand), without a
   * break, for KNOT_TIGHT.hold seconds, and the middle of that cable lies in a loop that has no knot
   * yet; it keeps its number and its place in
   * the material while it loosens and tightens again (a knot does not untie by itself). "present":
   * found within the last 0.5 s.
   */
  const known: { loop: number; i: number; seen: number }[] = [];
  /** candidates: tight for less than KNOT_TIGHT.hold so far (a passing tangle is not a knot) */
  const maybe = new Map<number, { i: number; first: number; seen: number }>();
  const loopOf = (s: number) => ring.sLoops.findIndex(([a, b]) => s >= a && s < b);
  const knotsNow = (r: Rod, t: number) => {
    spans = knotSpans(r.x, r.n, r.L[1] ?? 0.0075, KNOT_TIGHT.span, KNOT_TIGHT.radius);
    for (const sp of spans) {
      const ic = Math.round((sp.i0 + sp.i1) / 2);
      const lp = loopOf(r.sNode[ic]);
      const k = known.find((x) => x.loop === lp);
      if (k) {
        k.i = ic;
        k.seen = t;
        continue;
      }
      const m = maybe.get(lp);
      if (!m || t - m.seen > 0.1) maybe.set(lp, { i: ic, first: t, seen: t });
      else {
        m.i = ic;
        m.seen = t;
        if (t - m.first >= KNOT_TIGHT.hold) {
          known.push({ loop: lp, i: ic, seen: t });
          maybe.delete(lp);
        }
      }
    }
    return known.filter((k) => t - k.seen < 0.5).length;
  };
  let tNow = 0;
  const knotNode = (k: number) => (known[k] ? known[k].i : -1);
  /** where a stroke takes the cable again: near the ring, on the way to the hand */
  const exitPoint = (): V3 => add(KNOT_HOLD, [0.05, -0.27, 0.06]);
  const go = (phase: typeof st.phase, t: number) => {
    st.phase = phase;
    st.t0 = t;
    st.from = st.cur;
  };
  const script = (r: Rod, t: number) => {
    // the knots, counted as they close
    tNow = t;
    knotsNow(r, t);
    while (known.length > knotCount) {
      knotCount++;
      st.knotT.push(t);
    }
    // the left hand lets the next loop go when the right hand pulls on it (a loosely held ring: a
    // loop slides out when it is pulled with about PULL.fRelease), or when the cable between the
    // hands is nearly taut; never two within 0.35 s
    if (st.phase === 'pull' || st.phase === 'close') {
      const f = pin.state === 'held' ? Math.abs(pin.force) : 0;
      st.pulled = f > PULL.fRelease ? st.pulled + dt : 0;
      if (held >= 1 && pin.state === 'held' && t - st.lastRelease > 0.35) {
        const sJ = ring.held[held][1];
        const free = pin.s - sJ;
        const d = length(sub(r.pointAt(sJ), pin.frame(t).p));
        if (st.pulled > 0.08 || free < d + PULL.slack) {
          left.release(ring.held[held][0], ring.held[held][1], 0.08);
          st.released.push(t);
          st.lastRelease = t;
          held--;
        }
      }
    }
    // the right hand
    let next: Frame = st.cur;
    const u = (dur: number) => (t + dt - st.t0) / dur;
    switch (st.phase) {
      case 'wait':
        if (t >= KNOT_T.reach0) {
          if (mode === 'fix') {
            // fix: before pulling, she takes the end and puts it back through the middle
            st.stopAt = t;
            st.s = ring.sCable[1] - 0.025;
            go('toEnd', t);
          } else go('reach', t);
        }
        break;
      case 'reach': {
        const target = padsOn(r, st.s);
        // approach from a little above and outside, then onto the cable
        const D = st.strokes === 0 ? 0.85 : PULL.reach;
        const w = ease5(u(D));
        const lift = 0.05 * Math.sin(Math.PI * Math.min(1, u(D)));
        next = mixFrame(st.from, target, w);
        next = { p: add(next.p, [0, lift, 0]), q: next.q };
        if (u(D) >= 1) {
          pin.set('held', PULL.close);
          go('close', t);
        }
        break;
      }
      case 'close':
        next = padsOn(r, st.s);
        if (u(PULL.close + 0.04) >= 1) {
          go('pull', t);
          st.v = 0;
        }
        break;
      case 'pull': {
        // toward KNOT_OUT, a smooth start, slowing near the end and when the force rises
        const p0 = st.cur.p;
        const to = sub(KNOT_OUT, p0);
        const rem = length(to);
        const f = Math.abs(pin.force);
        const want = PULL.vmax * Math.min(1, Math.max(0, (PULL.fmax - f) / (0.5 * PULL.fmax))) * Math.min(1, rem / 0.15 + 0.08);
        const acc = 1.6;
        st.v = Math.min(want, st.v + acc * dt);
        const step = Math.min(rem, st.v * dt);
        const dir = rem > 1e-6 ? scale(to, 1 / rem) : [0, 0, 0] as V3;
        const p = add(p0, scale(dir, step));
        // the cable leaves the pads toward the hand's motion (from the ring)
        const along = normalize(sub(p, exitPoint()));
        let n = sub([0, 0.8, 0.6], scale(along, dot([0, 0.8, 0.6], along)));
        n = normalize(n);
        const target = gripFrame(p, along, n);
        next = { p, q: slerpQ(st.cur.q, target.q, 0.15) };

        if (rem < 0.004 || (st.v < 0.01 && u(0.1) > 6)) {
          pin.release(0.12);
          go('open', t);
          st.strokes++;
          if (st.fixed) st.strokesFixed++;
        }
        break;
      }
      case 'open': {
        // the pads open; a moment later the hand goes back to the cable near the ring
        if (u(0.16) >= 1) {
          const done = mode === 'pull' ? knotCount >= 3 : mode === 'ok' ? held < 1 && st.strokes >= 6 : st.strokesFixed >= 3;
          if (done || held < 0) {
            go('done', t);
            break;
          }
          const aim = lerpV(exitPoint(), KNOT_OUT, PULL.regrab / Math.max(0.2, length(sub(KNOT_OUT, exitPoint()))));
          // (only cable that has left the ring: beyond the junction the left hand still holds)
          const s0 = held >= 0 ? ring.held[Math.max(0, held)][1] + 0.1 : 0;
          const c = r.closestPoint(aim, Math.min(s0, pin.s - 0.1), pin.s - 0.05);
          // never on a knot: just before it (toward the ring) if there is room, else just after it
          let sg = c.s;
          for (const k of spans) {
            const a = r.sNode[k.i0] - 0.03, b = r.sNode[k.i1] + 0.03;
            if (sg > a && sg < b) sg = a - 0.03 > s0 ? a - 0.03 : b + 0.03;
          }
          st.s = Math.min(sg, pin.s - 0.05);
          go('reach', t);
        }
        break;
      }
      case 'stop':
        // fix: "Stopp": the hand holds still, then gives a little back toward the ring
        next = st.cur;
        if (u(KNOT_T.stop) >= 1) go('slack', t);
        break;
      case 'slack': {
        const back = add(st.from.p, scale(sub(exitPoint(), st.from.p), 0.25));
        next = mixFrame(st.from, { p: back, q: st.from.q }, ease5(u(0.5)));
        if (u(0.5) >= 1) {
          pin.release(0.12);
          go('letgo', t);
        }
        break;
      }
      case 'letgo':
        next = st.cur;
        if (u(0.18) >= 1) {
          st.s = ring.sCable[1] - 0.025;
          go('toEnd', t);
        }
        break;
      case 'toEnd': {
        // to the end (just behind the plug), the plug pointing toward the knot: the end leads
        next = mixFrame(st.from, padsOn(r, st.s), ease5(u(0.9)));
        if (u(0.9) >= 1) {
          pin.set('held', 0.12);
          go('closeEnd', t);
        }
        break;
      }
      case 'closeEnd':
        next = st.cur;
        if (u(0.2) >= 1) {
          // the way back: to the knot's end side, through its middle, on to the ring's eye, through
          // it to the front, and out and down in front of the ring (outside)
          const E = add(KNOT_HOLD, [0.0, -0.14, 0.0]);
          const pts: V3[] = [st.cur.p];
          pts.push(add(E, scale(KNOT_N, -0.06)), E, add(E, scale(KNOT_N, 0.1)), add(add(E, scale(KNOT_N, 0.16)), [0.04, -0.12, 0]));
          st.path = pts;
          st.pathL = [0];
          for (let i = 1; i < pts.length; i++) st.pathL.push(st.pathL[i - 1] + length(sub(pts[i], pts[i - 1])));
          st.along = 0;
          st.v = 0;
          go('thread', t);
        }
        break;
      case 'thread': {
        // along the way at up to FIX_SPEED, easing in and out; the pads along the way (the end leads)
        const L = st.pathL[st.pathL.length - 1];
        const rem = L - st.along;
        st.v = Math.min(FIX_SPEED * Math.min(1, rem / 0.12 + 0.1), st.v + 1.2 * dt);
        st.along = Math.min(L, st.along + st.v * dt);
        const at = (d: number): V3 => {
          let i = 1;
          while (i < st.pathL.length - 1 && st.pathL[i] < d) i++;
          const a = st.path[i - 1], b = st.path[i], l = st.pathL[i] - st.pathL[i - 1];
          return lerpV(a, b, l > 0 ? (d - st.pathL[i - 1]) / l : 1);
        };
        const p = at(st.along);
        const ahead = normalize(sub(at(Math.min(L, st.along + 0.04)), at(Math.max(0, st.along - 0.04))));
        const target = gripFrame(p, ahead, normalize(sub([0, 0.8, 0.6], scale(ahead, dot([0, 0.8, 0.6], ahead)))));
        next = { p, q: slerpQ(st.cur.q, target.q, 0.08) };
        if (rem < 0.002) go('outside', t);
        break;
      }
      case 'outside':
        // the end is outside: she holds it a moment ("Ende wieder außen"), then pulls it out as
        // with both ends outside (knot-ok)
        next = st.cur;
        if (u(0.8) >= 1) {
          st.fixed = true;
          st.fixedAt = t;
          st.v = 0;
          go('pull', t);
        }
        break;
      case 'done': {
        // rest: back to her side, open
        const w = ease5(u(1.2));
        next = mixFrame(st.from, KNOT_REST, w);
        break;
      }
    }
    st.cur = next;
    pin.moveTo(next, dt);
  };
  const knotAt = (r: Rod, k: number, c: number) => {
    const i = knotNode(k);
    return i < 0 ? NaN : r.x[3 * i + c];
  };
  let detT = -1, det = 1;
  const tracks = {
    /** pads open (1) … closed (0) */
    rhOpen: (_r: Rod, t: number) => 1 - pin.level(t),
    /** junctions the left hand still holds (6 = all loops, 0 = only the start end) */
    held: () => held,
    /** knots found pulled tight within the last 0.5 s; where each knot is (numbered in the order they closed; NaN before) */
    knots: () => known.filter((k) => tNow - k.seen < 0.5).length,
    knot1X: (r: Rod) => knotAt(r, 0, 0), knot1Y: (r: Rod) => knotAt(r, 0, 1), knot1Z: (r: Rod) => knotAt(r, 0, 2),
    knot2X: (r: Rod) => knotAt(r, 1, 0), knot2Y: (r: Rod) => knotAt(r, 1, 1), knot2Z: (r: Rod) => knotAt(r, 1, 2),
    knot3X: (r: Rod) => knotAt(r, 2, 0), knot3Y: (r: Rod) => knotAt(r, 2, 1), knot3Z: (r: Rod) => knotAt(r, 2, 2),
    /** tight-knot windows found this frame (the raw detector, flickers) */
    found: () => spans.length,
    /** knots that have closed so far (never goes down), and the loop each is made of (0 = the first loop; NaN before) */
    knotsEver: () => known.length,
    knot1L: () => (known[0] ? known[0].loop : NaN), knot2L: () => (known[1] ? known[1].loop : NaN), knot3L: () => (known[2] ? known[2].loop : NaN),
    /** fix: when she stopped, and when the end was outside again (NaN before) */
    stopAt: () => (st.stopAt < Infinity ? st.stopAt : NaN),
    fixedAt: () => (st.fixedAt < Infinity ? st.fixedAt : NaN),
    /** the hand's phase (index in PHASES) */
    phase: () => PHASES.indexOf(st.phase),
    /** the knot determinant of the whole cable (3^k: k overhand knots, formed or still in the ring), every 0.1 s */
    det: (r: Rod, t: number) => {
      if (t - detT >= 0.1 - 1e-9) {
        det = knots(r.x, 0, r.n - 1).det;
        detT = t;
      }
      return det;
    },
    /** material coordinate under the pads, axial force there [N] */
    padS: () => pin.s,
    force: () => pin.force,
    /** the plug's tip */
    plugX: (r: Rod) => r.x[3 * (r.n - 1)], plugY: (r: Rod) => r.x[3 * (r.n - 1) + 1], plugZ: (r: Rod) => r.x[3 * (r.n - 1) + 2],
    ...ringTracks(ring, rod),
  };
  const vectors = {
    lh: frameTrack(() => left.frame()),
    rh: frameTrack(() => pin.frame()),
  };
  return { script, tracks, vectors, state: st, pin, left, heldNow: () => held, knotsNow: () => knotCount };
}

function knotShot(id: string, mode: KnotMode, duration: number): ShotDef {
  return {
    id,
    duration,
    // (60 substeps and 4 iterations: tight knots, strands pulled through each other's loops)
    substeps: 60,
    iterations: 4,
    build() {
      const ring = knotRing(mode === 'ok' ? 'free' : 'thread');
      const rod = ringInHand(ring);
      const c = knotController(mode, ring, rod);
      return { rod, script: c.script, tracks: c.tracks, vectors: c.vectors };
    },
  };
}

/** ✗ the end through the middle, pulled out: knots in every second loop */
export const knotPull = knotShot('p5-knots-pull', 'pull', 16);
/** ✓ both ends outside, the same pull: no knot */
export const knotOk = knotShot('p5-knots-ok', 'ok', 20);
/** the same as knot-pull up to the first knot; she stops and takes the end back through the knot and the middle */
export const knotFix = knotShot('p5-knots-fix', 'fix', 15);

/** for the experiments: the controller on a ring in her hand */
export function knotExperiment(mode: KnotMode) {
  const ring = knotRing(mode === 'ok' ? 'free' : 'thread');
  const rod = ringInHand(ring);
  return { ring, rod, ...knotController(mode, ring, rod) };
}

// ------------------------------------------------------------------------------ the cause: the crate

/** the wire crate on the floor in front of Noor (props.ts cableCrate): centre, size; the top of its bottom grid */
export const CRATE = { x: 0.04, z: -0.52, width: 0.8, depth: 0.55, height: 0.32, floor: 0.0145 };
/**
 * the ring lying flat: the stack's front (the last loop) up, its top (where a hand holds it) to her
 * left, the end, through the middle, out to her right (the crate's long side)
 */
const Q_FLAT: Quat = quatMul(quatFromAxisAngle(0, 1, 0, -Math.PI / 2), [0, Math.SQRT1_2, Math.SQRT1_2, 0]);
/** the ring's middle in the crate: a little to her left of the crate's middle, so the end has room */
const RING_DX = -0.1;
/** where Noor holds the flat ring before she lets it go, and where she lifts it to */
const DROP_H = 0.62;
export const CRATE_T = {
  /** she lets go: the ring falls flat into the crate; its end, through the middle, lands under it */
  drop: 0.25, land: 0.75,
  end: 2.2,
};
/** the crate's walls as rows of thin capsules (inside faces) */
function crateCaps(): Capsule[] {
  const out: Capsule[] = [];
  const x0 = CRATE.x - CRATE.width / 2, x1 = CRATE.x + CRATE.width / 2, z0 = CRATE.z - CRATE.depth / 2, z1 = CRATE.z + CRATE.depth / 2;
  for (const y of [0.04, 0.12, 0.2, 0.28]) {
    out.push({ a: [x0, y, z0], b: [x1, y, z0], r: 0.004 }, { a: [x0, y, z1], b: [x1, y, z1], r: 0.004 });
    out.push({ a: [x0, y, z0], b: [x0, y, z1], r: 0.004 }, { a: [x1, y, z0], b: [x1, y, z1], r: 0.004 });
  }
  return out;
}

/**
 * The cause: the ring with its end through the middle (the threaded ring of knot-pull), its velcro
 * open, lying flat in Noor's hand over the crate; she lets it go and it falls flat onto the
 * crate's bottom (simulated); its end, through the middle, lands under the ring. How the end got
 * through the middle is not simulated (the ring is made that way, see layout()), nor how she
 * lifts the ring out again (the part cuts to the ring in her hand: knot-pull).
 */
export const knotCrate: ShotDef = {
  id: 'p5-knots-crate',
  duration: CRATE_T.end,
  substeps: 60,
  iterations: 4,
  build() {
    const ring = knotRing('thread');
    // flat, its middle over the crate's middle, DROP_H above the bottom
    const tmp = knotRod(ring, placeKnotRing(ring.state, [0, 0, 0], Q_FLAT, CRATE.floor));
    const mid = (r: Rod): V3 => {
      let c: V3 = [0, 0, 0], m = 0;
      for (const [a, b] of ring.loops) for (let i = a; i <= b; i++) {
        c = add(c, [r.x[3 * i], r.x[3 * i + 1], r.x[3 * i + 2]]);
        m++;
      }
      return scale(c, 1 / m);
    };
    const rod = knotRod(ring, placeKnotRing(ring.state, sub([CRATE.x + RING_DX, CRATE.floor + DROP_H, CRATE.z], mid(tmp)), Q_FLAT, CRATE.floor));
    const e = rod.n - 1;
    rod.setCapsules(crateCaps());
    /** the middle of the ring's top (what the factory's fist held) */
    const topOf = (r: Rod): V3 => {
      let c: V3 = [0, 0, 0], m = 0;
      for (const [a, b] of ring.held) for (let j = r.segmentAt(a); j < r.segmentAt(b); j++) {
        c = add(c, [r.c[3 * j], r.c[3 * j + 1], r.c[3 * j + 2]]);
        m++;
      }
      return scale(c, 1 / m);
    };
    const hand = { p: topOf(rod), q: [0, 0, 0, 1] as Quat };
    const fist = rod.bundle({ frame: () => ({ p: hand.p, q: hand.q }), hand: 0, blend: 0.001 });
    for (const [a, b] of ring.held) fist.add(a, b);
    // (held flat: no gravity until she lets go; a flat ring in two hands does not sag)
    const g = rod.opts.gravity;
    rod.opts.gravity = [0, 0, 0];
    let dropped = false;
    return {
      rod,
      script: (r) => {
        if (!dropped && r.time >= CRATE_T.drop) {
          dropped = true;
          r.opts.gravity = g;
          fist.release(-Infinity, Infinity, 0.04);
        }
        // (while the hand is empty its frame stays on the ring's top)
        if (dropped && r.time > CRATE_T.drop + 0.2) hand.p = topOf(r);
      },
      tracks: {
        plugX: (r) => r.x[3 * e], plugY: (r) => r.x[3 * e + 1], plugZ: (r) => r.x[3 * e + 2],
        ...ringTracks(ring, rod),
      },
      vectors: { lh: frameTrack(() => ({ p: hand.p, q: hand.q })) },
    };
  },
};

/** the shots of the part p5-knots (registered in index.ts) */
export const P5_KNOTS_SHOTS: ShotDef[] = [knotCrate, knotPull, knotFix, knotOk];

export const _unused = { cross, quatFromFrame };
export type { Bundle };
