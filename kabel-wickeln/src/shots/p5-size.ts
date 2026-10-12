// Stage 5.3 "Die richtige Größe" (KONZEPT), the simulated cables of the part p5-size. Noor's own
// XLR (the XLR preset as it is, sim/cables.ts) as a USED cable: it was stored for a long time
// coiled over-under in loops of MEMORY.loop (BuildCableOptions.memory, the preset's coil memory).
//
//   p5-size-sink    Noor lets the cable sink slowly from her right hand at chest height to the
//                   floor, moving the hand slowly to her right; it lies down in bows. Simulated:
//                   everything below her right hand. Guided (KONZEPT "Führungskräfte"): the cable
//                   above it, which slides through her hands from where it lay on the floor at her
//                   left (soft guides along a path that moves with her hands). The memory: the
//                   preset's strand-friction memory is plastic, so the straight guided part would
//                   forget the coil before it reaches the hand; the cable that is just coming out
//                   of her hand gets the remembered coil back every frame (what a coil in the
//                   hand would keep). Below the hand nothing is guided or reset.
//   p5-size-small   the same cable coiled too small (8 loops of ~15 cm), hanging from her left
//   p5-size-big     fist: too big (2 loops of ~70 cm, they reach the floor and lie there; her
//   p5-size-right   right foot steps on one), right (6 loops of 0.75 m, as it was stored). The
//                   rings come from the ring factory (deploy-ring.ts: laid out over-under,
//                   pressed, hanging), then the strands get the cable's coil memory again (the
//                   size it was stored at; the factory makes them remember the ring itself); the
//                   fist lowers the ring from chest to hip height and holds it. Everything after
//                   that is simulated (the fist is a bundle, the foot and her shins are capsules).
//
// Coordinates as in stage 1 and 5.2: Noor stands at the origin facing −z, her right is +x, y up.

import { Bundle, Capsule, Quat, Rod, V3, XLR, add, buildCable, cross, dot, length, lerp3, normalize, quatFromAxisAngle, quatRotate, scale, sub } from '../sim';
import { FIST, Ring, RingSpec, placeRing, ringRod, windRing } from './deploy-ring';
import type { ShotBuild, ShotDef } from './types';

const RC = XLR.od / 2;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** minimum-jerk ease 0 → 1 */
export const ease = (u: number) => {
  const x = clamp01(u);
  return x * x * x * (10 - 15 * x + 6 * x * x);
};

/** the coil the cable remembers (it was stored like this): loop length [m], over-under */
export const MEMORY = { loop: 0.75, overUnder: true } as const;

// ===================================================================================== the sink

/** settings the experiments vary (scratchpad p5s/run.mjs); the shot uses them as they are */
export const SINK_CFG = { memory: true, restore: true, compliance: 1e-7, plugs: 'start' as 'both' | 'start' };
/** the cable gets its coil memory back over this last stretch before it leaves the hand [m] */
const RESTORE = 0.08;

/** the sink's beats [s] */
export const SINK_T = {
  /** the cable starts to slide through her right hand */
  feed0: 0.8,
  /** and stops */
  feed1: 11.2,
  /** the left hand comes to the front of her belly (where she shows the size) */
  lift0: 12.6,
  lift1: 14.4,
  end: 15.2,
};

/** the sink's geometry: her hands, where the cable lies */
export const SINK = {
  /** feed speed through the right hand [m/s] */
  v: 0.24,
  /** the right hand (the cable runs down through it) moves slowly from rh0 to rh1 while it feeds */
  rh0: [0.0, 1.13, -0.52] as V3,
  rh1: [0.48, 1.11, -0.48] as V3,
  /** the left hand holds the cable loosely (it slides through), at her left */
  lh: [-0.3, 1.02, -0.4] as V3,
  /** after: the left hand in front of her belly, where she shows the size (the ghost loop hangs from it) */
  lhShow: [-0.08, 1.0, -0.44] as V3,
  /** where the cable from the left hand reaches the floor, and the way it lies there (to her left and back) */
  floorAt: [-0.56, RC + 0.003, -0.3] as V3,
  floorDir: normalize([-0.5, 0, 0.86]),
  /** the free end at the start: from below the right hand along the floor (forward) */
  lie: 0.22,
  lieDir: normalize([0.25, 0, -1]),
  /** total length incl. plugs [m] */
  length: 5.0,
};

/** 0 → 1 with constant speed in the middle and eased ends of `r` seconds */
function glide(t: number, t0: number, t1: number, r: number) {
  const T = t1 - t0, x = Math.min(T, Math.max(0, t - t0));
  const vmax = 1 / (T - r);
  if (x < r) return (vmax * x * x) / (2 * r);
  if (x > T - r) return 1 - (vmax * (T - x) * (T - x)) / (2 * r);
  return vmax * (x - r / 2);
}

/** the right hand (pads' middle: where the cable leaves it downward) at shot time t */
export const sinkRH = (t: number): V3 => lerp3(SINK.rh0, SINK.rh1, glide(t, SINK_T.feed0, SINK_T.feed1, 0.8));
/** the left hand at shot time t */
export const sinkLH = (t: number): V3 => lerp3(SINK.lh, SINK.lhShow, ease((t - SINK_T.lift0) / (SINK_T.lift1 - SINK_T.lift0)));

/** Chaikin corner cutting (keeps the ends) */
function chaikin(P: V3[], passes: number): V3[] {
  let A = P;
  for (let r = 0; r < passes; r++) {
    const B: V3[] = [A[0]];
    for (let i = 0; i < A.length - 1; i++) {
      B.push(lerp3(A[i], A[i + 1], 0.25), lerp3(A[i], A[i + 1], 0.75));
    }
    B.push(A[A.length - 1]);
    A = B;
  }
  return A;
}

/** the guided cable above the right hand at time t: a polyline from the hand back along the supply, with arc lengths */
export function sinkSupply(t: number): { P: V3[]; arc: number[] } {
  const rh = sinkRH(t), lh = sinkLH(t);
  const fl = SINK.floorAt, fd = SINK.floorDir;
  // over the top from the left hand into the right fist (an arch, bends of ≥ 5 cm radius)
  const top: V3 = [(rh[0] + lh[0]) / 2 + 0.04, Math.max(rh[1], lh[1]) + 0.13, (rh[2] + lh[2]) / 2];
  const ctrl: V3[] = [
    rh,
    add(rh, [0, 0.13, 0]),
    top,
    add(lh, [0.1, 0.06, 0]),
    lh,
    add(lh, [-0.08, -0.03, 0.02]),
    [fl[0] + 0.02, 0.45, fl[2] - 0.03],
    [fl[0], 0.08, fl[2]],
    fl,
    add(fl, scale(fd, 0.12)),
    add(fl, scale(fd, 4)),
  ];
  const P = chaikin(ctrl, 4);
  const arc = [0];
  for (let i = 1; i < P.length; i++) arc.push(arc[i - 1] + length(sub(P[i], P[i - 1])));
  return { P, arc };
}

/** the point at arc length u along a polyline with arc lengths */
function along(P: V3[], arc: number[], u: number): V3 {
  if (u <= 0) return P[0];
  const n = P.length;
  if (u >= arc[n - 1]) return P[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (arc[m] <= u) lo = m;
    else hi = m;
  }
  return lerp3(P[lo], P[hi], (u - arc[lo]) / (arc[hi] - arc[lo] || 1));
}

/** the start shape (free end on the floor, up to the right hand, then the supply) and how much cable hangs below the hand */
function sinkStart() {
  const rh = SINK.rh0;
  const foot: V3 = [rh[0] + 0.04, RC, rh[2] - 0.04];
  const tip = add(foot, scale(SINK.lieDir, SINK.lie));
  const pts: V3[] = [];
  const K = 40;
  for (let k = 0; k <= K; k++) pts.push(lerp3(tip, foot, k / K));
  // up from the floor to the hand: a quarter bend, then straight
  for (let k = 1; k <= 60; k++) {
    const u = k / 60;
    const p = lerp3(foot, rh, u);
    p[1] = RC + (rh[1] - RC) * Math.sin((Math.PI / 2) * Math.min(1, u * 1.05));
    pts.push(p);
  }
  let free = 0;
  for (let i = 1; i < pts.length; i++) free += length(sub(pts[i], pts[i - 1]));
  const sup = sinkSupply(0);
  const rest = SINK.length - free;
  for (let u = 0.005; u < rest; u += 0.005) pts.push(along(sup.P, sup.arc, u));
  pts.push(along(sup.P, sup.arc, rest));
  return { pts, free };
}

/** material coordinate at the right hand at shot time t: everything below it is free [m] (s0 = the free cable at the start) */
export function sinkFeed(s0: number, t: number) {
  const T = SINK_T.feed1 - SINK_T.feed0;
  return s0 + SINK.v * (T - 0.8) * glide(t, SINK_T.feed0, SINK_T.feed1, 0.8);
}

export const sinkShot: ShotDef = {
  id: 'p5-size-sink',
  duration: SINK_T.end,
  fps: 60,
  substeps: XLR.substeps,
  iterations: XLR.iterations,
  build(): ShotBuild {
    const { pts, free } = sinkStart();
    const { rod, cable } = buildCable(XLR, pts, { plugs: SINK_CFG.plugs, memory: SINK_CFG.memory ? MEMORY : null });
    const S = rod.sNode;
    const sHand0 = S[rod.segmentAt(free)];
    const feed = (t: number) => sinkFeed(sHand0, t);
    // the coil memory as built: the cable that leaves the hand gets it back (see the header)
    const memFric = rod.restFric.slice();
    let cacheT = NaN;
    let cache = sinkSupply(0);
    rod.addGuide({
      nodes: [0, rod.n - 1],
      compliance: SINK_CFG.compliance,
      target: (i, t) => {
        const u = S[i] - feed(t);
        if (u < 0) return null;
        if (t !== cacheT) {
          cache = sinkSupply(t);
          cacheT = t;
        }
        return along(cache.P, cache.arc, u);
      },
    });
    const restore = (r: Rod, t: number) => {
      if (!SINK_CFG.restore) return;
      // (only the last RESTORE m before the hand: further up the guide's bends would fight it)
      const sh = feed(t) - 0.02, top = feed(t) + RESTORE;
      let any = false;
      for (let k = 0; k < r.nj; k++) {
        if (S[k + 1] <= sh || S[k + 1] > top) continue;
        r.restFric[2 * k] = memFric[2 * k];
        r.restFric[2 * k + 1] = memFric[2 * k + 1];
        any = true;
      }
      // (rememberShape with amount 0: recompute the weighted rest from the memory just written)
      if (any) r.rememberShape(1, 0, 0);
    };
    return {
      rod,
      script: restore,
      tracks: {
        i0: () => cable[0],
        i1: () => cable[1],
        /** material coordinate at the right hand */
        feed: (_r, t) => feed(t),
        /** the free cable's twist (turns): from the free end to the hand */
        twFree: (r, t) => r.twistTurns(0, Math.max(1, r.segmentAt(feed(t)))),
      },
    };
  },
};

// ===================================================================================== the rings

export type RingKind = 'small' | 'big' | 'right';

/** loop length, pattern, lead and tail [m]; all three are the same 5 m cable */
export const RINGS: Record<RingKind, { loop: number; pattern: string; lead: number; tail: number }> = {
  /** too small: 8 loops of 0.47 m (Ø ≈ 15 cm), the rest hangs */
  small: { loop: 0.47, pattern: 'ouououou', lead: 0.25, tail: 0.9 },
  /** too big: 2 loops of 2.3 m (Ø ≈ 70 cm): from hip height they reach the floor */
  big: { loop: 2.3, pattern: 'ou', lead: 0.2, tail: 0.2 },
  /** right: 6 loops of 0.75 m (Ø ≈ 23 cm), the size the cable was stored at */
  right: { loop: 0.75, pattern: 'ououou', lead: 0.25, tail: 0.3 },
};

export const RING_T = {
  /** the fist lowers the ring from chest to hip height */
  lower0: 0.4,
  lower1: 1.9,
  /** big: her right foot lifts, steps onto the loop on the floor, stays */
  step0: 2.6,
  step1: 3.5,
  end: 6.0,
};

/** the loops face this way (forward and to her right, toward the camera of the comparison) */
export const RING_N: V3 = normalize([Math.sin((50 * Math.PI) / 180), 0, -Math.cos((50 * Math.PI) / 180)]);
/** turns the factory ring (loops facing +z) to face RING_N */
export const RING_Q: Quat = quatFromAxisAngle(0, 1, 0, Math.atan2(RING_N[0], RING_N[2]));
/** the fist (the top of the ring) at chest and at hip height */
export const RING_FIST = { chest: [-0.12, 1.24, -0.42] as V3, hip: [-0.12, 0.95, -0.42] as V3 };
export const ringFist = (t: number): V3 => lerp3(RING_FIST.chest, RING_FIST.hip, ease((t - RING_T.lower0) / (RING_T.lower1 - RING_T.lower0)));

const ringSpec = (k: RingKind): RingSpec => ({ cable: XLR, plugs: 'both', ...RINGS[k], spacing: 0.016, press: 0.6 });

/** Noor's stance in the ring shots: feet 26 cm apart; the right ankle and its direction */
const K_NOOR = 1.65 / 1.75;
export const ANKLE_Y = 0.075 * K_NOOR;
export const FOOT = {
  /** the right foot standing, and where it steps (onto the big ring's loop on the floor) */
  stand: { ankle: [0.13, ANKLE_Y, 0.0] as V3, dir: normalize([0.12, 0, -1]) },
  step: { ankle: [-0.03, ANKLE_Y + 2 * RC, -0.26] as V3, dir: normalize([-0.12, 0, -1]) },
  /** the sole as a capsule: heel and toe behind and in front of the ankle, radius */
  heel: 0.05,
  toe: 0.15,
  r: 0.03,
};

/** the right foot at shot time t (big ring: lifts, steps forward onto the loop, stays) */
export function rightFoot(kind: RingKind, t: number): { ankle: V3; dir: V3 } {
  if (kind !== 'big') return FOOT.stand;
  const u = ease((t - RING_T.step0) / (RING_T.step1 - RING_T.step0));
  const p = lerp3(FOOT.stand.ankle, FOOT.step.ankle, u);
  p[1] += 0.09 * Math.sin(Math.PI * u);
  return { ankle: p, dir: normalize(lerp3(FOOT.stand.dir, FOOT.step.dir, u)) };
}

/** the sole capsule of a foot (lying on the cable when planted on it) */
export function soleCapsule(f: { ankle: V3; dir: V3 }): Capsule {
  const y = f.ankle[1] - ANKLE_Y + FOOT.r;
  const a: V3 = [f.ankle[0] - f.dir[0] * FOOT.heel, y, f.ankle[2] - f.dir[2] * FOOT.heel];
  const b: V3 = [f.ankle[0] + f.dir[0] * FOOT.toe, y, f.ankle[2] + f.dir[2] * FOOT.toe];
  return { a, b, r: FOOT.r, mu: 0.8 };
}

/** a shin as a capsule (ankle to below the knee) */
const shin = (ankle: V3): Capsule => ({ a: [ankle[0], ankle[1] + 0.05, ankle[2]], b: [ankle[0], ankle[1] + 0.42, ankle[2] - 0.03], r: 0.05 });
const LEFT_ANKLE: V3 = [-0.13, ANKLE_Y, 0.0];

/** per-loop shape of a ring (node ranges): width and height in the loop's plane, out of plane, lowest point */
function loopShapes(r: Rod, loops: [number, number][], fist: V3) {
  const N = RING_N;
  const E: V3 = normalize(cross([0, 1, 0], N));
  return loops.map(([a, b]) => {
    let e0 = Infinity, e1 = -Infinity, y0 = Infinity, y1 = -Infinity, n0 = Infinity, n1 = -Infinity;
    for (let i = a; i <= b; i++) {
      const p: V3 = [r.x[3 * i], r.x[3 * i + 1], r.x[3 * i + 2]];
      const d = sub(p, fist);
      const e = dot(d, E), n = dot(d, N);
      e0 = Math.min(e0, e); e1 = Math.max(e1, e);
      y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
      n0 = Math.min(n0, n); n1 = Math.max(n1, n);
    }
    return { w: e1 - e0, h: y1 - y0, out: n1 - n0, low: y0 };
  });
}

function ringShot(kind: RingKind): ShotDef {
  return {
    id: `p5-size-${kind}`,
    duration: RING_T.end,
    fps: 60,
    substeps: XLR.substeps,
    iterations: XLR.iterations,
    build(): ShotBuild {
      const spec = ringSpec(kind);
      const ring: Ring = windRing(spec);
      const d = sub(RING_FIST.chest, FIST);
      const rod = ringRod(ring, placeRing(ring.state, d, RING_Q, 0), spec);
      const S = rod.sNode;
      // the cable's memory: the coil it was stored in (MEMORY), in the plane the ring bends now.
      // Over-under: the remembered bend changes sides every MEMORY.loop of cable, and so does the
      // material of a ring coiled over-under (every loop is laid with the hand turned the other
      // way): in the ring's material frame the memory bends with the loop where both agree and
      // against it where they do not (the ring is laid out without twist, see deploy-ring.ts).
      const s0 = ring.sLoops[0][0];
      const loopOf = (s: number) => {
        let k = 0;
        ring.sLoops.forEach(([a], i) => {
          if (s >= a) k = i;
        });
        return k;
      };
      const kap = (2 * Math.PI) / MEMORY.loop;
      const dirs: ([number, number] | null)[] = [];
      for (let k = 0; k < rod.nj; k++) {
        const a4 = 4 * k, b4 = a4 + 4, q = rod.q;
        const ax = q[a4], ay = q[a4 + 1], az = q[a4 + 2], aw = q[a4 + 3];
        const bx = q[b4], by = q[b4 + 1], bz = q[b4 + 2], bw = q[b4 + 3];
        const sg = aw * bw + ax * bx + ay * by + az * bz < 0 ? -1 : 1;
        const ox = sg * (aw * bx - ax * bw - ay * bz + az * by), oy = sg * (aw * by + ax * bz - ay * bw - az * bx);
        const l = Math.hypot(ox, oy);
        dirs.push(l > 1e-5 ? [ox / l, oy / l] : null);
      }
      let last: [number, number] = [1, 0];
      for (let k = 0; k < rod.nj; k++) {
        const dk = dirs[k];
        if (dk) last = dk;
        else dirs[k] = last;
      }
      const mem = (k: number): [number, number] => {
        const s = S[k + 1];
        if (s < Math.max(s0, ring.sCable[0]) || s > ring.sCable[1]) return [0, 0];
        const sideMem = Math.floor((s - s0) / MEMORY.loop) % 2 === 0 ? 1 : -1;
        const sideRing = loopOf(s) % 2 === 0 ? 1 : -1;
        const dk = dirs[k] as [number, number];
        return [dk[0] * kap * sideMem * sideRing, dk[1] * kap * sideMem * sideRing];
      };
      rod.setMemoryCurvature((k) => mem(k));
      rod.setRestCurvature((k) => {
        const m = mem(k);
        return [0.5 * m[0], 0.5 * m[1], 0];
      });
      // the fist: the ring's top (what the factory's fist held), lowered from chest to hip height
      const fist: Bundle = rod.bundle({ frame: (t) => ({ p: ringFist(t), q: RING_Q }), hand: 0, blend: 0.001 });
      for (const [a, b] of ring.held) fist.add(a, b);
      // her shins and (big) the sole of her right foot
      rod.setCapsules((t) => {
        const f = rightFoot(kind, t);
        return [shin(LEFT_ANKLE), shin(f.ankle), soleCapsule(f)];
      });
      const loops = ring.loops;
      const shape = (r: Rod, t: number) => loopShapes(r, loops, ringFist(t));
      return {
        rod,
        tracks: {
          i0: () => ring.cable[0],
          i1: () => ring.cable[1],
          loops: () => loops.length,
          /** the narrowest loop: width / height in its plane */
          aspMin: (r, t) => Math.min(...shape(r, t).map((l) => l.w / l.h)),
          aspMean: (r, t) => {
            const s = shape(r, t);
            return s.reduce((a, l) => a + l.w / l.h, 0) / s.length;
          },
          /** how far the ring spreads out of its plane [m] (loops standing out) */
          out: (r, t) => Math.max(...shape(r, t).map((l) => l.out)),
          /** mean loop width and height [m] */
          w: (r, t) => {
            const s = shape(r, t);
            return s.reduce((a, l) => a + l.w, 0) / s.length;
          },
          h: (r, t) => {
            const s = shape(r, t);
            return s.reduce((a, l) => a + l.h, 0) / s.length;
          },
          /** the lowest point of the loops above the floor [m] (RC: lying on it) */
          low: (r, t) => Math.min(...shape(r, t).map((l) => l.low)) - RC,
          /** cable length lying on the floor [m] */
          onFloor: (r) => {
            let l = 0;
            for (let j = ring.cable[0]; j < ring.cable[1]; j++) if (r.c[3 * j + 1] < RC + 0.004) l += r.L[j];
            return l;
          },
          /** big: the nearest cable to the sole (m; ≤ 0: the foot stands on it) */
          underFoot: (r, t) => {
            const c = soleCapsule(rightFoot(kind, t));
            let best = Infinity;
            for (let i = ring.cable[0]; i <= ring.cable[1]; i++) {
              const p: V3 = [r.x[3 * i], r.x[3 * i + 1], r.x[3 * i + 2]];
              const ab = sub(c.b, c.a), u = clamp01(dot(sub(p, c.a), ab) / dot(ab, ab));
              best = Math.min(best, length(sub(p, add(c.a, scale(ab, u)))) - c.r - RC);
            }
            return best;
          },
        },
      };
    },
  };
}

export const ringSmall = ringShot('small');
export const ringBig = ringShot('big');
export const ringRight = ringShot('right');

/** a point of the factory ring placed as in the ring shots at shot time 0 (chest) */
export const ringPoint = (p: V3): V3 => add(quatRotate(RING_Q, sub(p, FIST)), RING_FIST.chest);

export const P5_SIZE_SHOTS: ShotDef[] = [sinkShot, ringSmall, ringBig, ringRight];
