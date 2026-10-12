// Stage 7 "Für Neugierige: die Physik" (KONZEPT), the simulated cables of the part p7-physics.
// Everything the cables do is simulated; hands and props only hold ends (kinematic grips, the same
// frames the part draws). Ilse's arms are posed by the part on these frames (shots/p7-physics-rig.ts).
//
//   p7-edge-*      stiffness: three equal pieces (charging cable, XLR, power 5G2.5, the presets as
//                  they are) lie on the table and stick out EDGE.over over its right edge; at the
//                  start a soft guide holds the overhang straight and fades (laid down), then the
//                  same small clamp (CLAMP_MASS) is put on each tip, one after the other
//   p7-knob        the XLR hangs in a U between a vise and a crank; the crank turns: the stripe
//                  winds, past a limit a loop pops out (twist → writhe)
//   p7-mem-old     memory: an old XLR whose jacket and strands remember the coil it lay in for
//                  years (natural rest and strand memory = a coil, a stiffer old jacket), held
//                  between two hands, let go 30 cm above a smooth table: it lands in curves
//   p7-mem-new     the same with a new cable (straight rest): it lands almost straight
//   p7-tension     a twisted XLR between two hands: taut it stays straight (the twist is hidden),
//                  slack a curl pops out; one hand lets go, the other lifts: the free end turns the
//                  twist out
//   p7-band-*      the band model: four bands (round rods drawn flat, the yellow face = the
//                  stripe d1) lie on the table in four loops each, über ×4 / unter ×4 /
//                  abwechselnd / über-über-unter-über, both ends in clamps that cannot turn. The
//                  clamps are pulled apart, pushed together, pulled again; then (über ×4 only) the
//                  right clamp opens and the band turns free. Lk = Tw + Wr is recorded (writhe
//                  closed along the clamps' line)
//   p7-ring        an XLR held as a ring at its two plugs side by side; one hand turns its plug:
//                  the twist grows until the ring flips into an eight
//
// Twist stiffness: the XLR preset's GJ (0.8e-4) is an estimate (physics report). Stage 5's eight
// (shots/eight.ts EIGHT_GJ) uses 3e-4, and so does this stage (P7_GJ), so the eight here and there
// is the same cable. With the preset GJ the crank needs ~15 turns before a loop pops (measured),
// with P7_GJ about 4.
//
// Coordinates: Ilse sits behind the table facing +z (her right is −x); the table top is at
// TABLE.height, x ∈ [−0.8, 0.8], z ∈ [0.27, 1.52].

import { CABLES, CableSpec, Frame, Rod, TAU, V3, XLR, buildCable, quatFromAxisAngle, quatFromFrame, quatMul, smooth, writhe } from '../sim';
import type { ShotBuild, ShotDef } from './types';

// ------------------------------------------------------------------------------------- shared

export const TABLE = { x: 0, z: 0.895, width: 1.6, depth: 1.25, height: 0.74 };
/** stage 5's torsional stiffness of the XLR (shots/eight.ts EIGHT_GJ), see the header */
export const P7_GJ = 3e-4;

const mix = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
/** minimum-jerk ease 0 → 1 of (t − a) / (b − a) */
export const ramp = (t: number, a: number, b: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * x * (10 - 15 * x + 6 * x * x);
};
const ID: Frame['q'] = [0, 0, 0, 1];
/** a frame along +x with d1 up (the bands' clamps) */
const ALONG_X: Frame['q'] = quatFromFrame([0, 1, 0], [0, 0, 1], [1, 0, 0]);

/** writhe of the nodes from..to, closed far out along the two end directions (open rods with fixed ends) */
export function writheClosed(x: ArrayLike<number>, from: number, to: number, out: V3, back: V3): number {
  const m = to - from + 1;
  const X = new Float64Array(3 * (m + 2));
  for (let k = 0; k < 3; k++) {
    X[k] = x[3 * from + k] + back[k] * 30;
    X[3 * (m + 1) + k] = x[3 * to + k] + out[k] * 30;
  }
  for (let i = 0; i < m; i++) for (let k = 0; k < 3; k++) X[3 * (i + 1) + k] = x[3 * (from + i) + k];
  return writhe(X, 0, m + 1);
}

/** the material's turning about the tangent of segment j (angle of d1 against a fixed reference), for spin counters */
function spinAngle(rod: Rod, j: number, ref: V3): number {
  const f = rod.segmentFrame(j);
  const d3 = f.d3;
  // reference made perpendicular to the tangent, its partner d3 × ref
  const rd = ref[0] * d3[0] + ref[1] * d3[1] + ref[2] * d3[2];
  const a: V3 = [ref[0] - rd * d3[0], ref[1] - rd * d3[1], ref[2] - rd * d3[2]];
  const b: V3 = [d3[1] * a[2] - d3[2] * a[1], d3[2] * a[0] - d3[0] * a[2], d3[0] * a[1] - d3[1] * a[0]];
  return Math.atan2(f.d1[0] * b[0] + f.d1[1] * b[1] + f.d1[2] * b[2], f.d1[0] * a[0] + f.d1[1] * a[1] + f.d1[2] * a[2]);
}

/** an unwrapped angle track (turns) of an angle function sampled once per frame */
function unwrapTrack(angle: (rod: Rod) => number) {
  let last: number | null = null, acc = 0;
  return (rod: Rod) => {
    const a = angle(rod);
    if (last !== null) {
      let d = a - last;
      d -= TAU * Math.round(d / TAU);
      acc += d;
    }
    last = a;
    return acc / TAU;
  };
}

/** points at equal arc length seg along a polyline */
function resample(P: V3[], seg: number): V3[] {
  const out: V3[] = [P[0]];
  let acc = 0, next = seg;
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    while (acc + l >= next) {
      out.push(mix(a, b, (next - acc) / l));
      next += seg;
    }
    acc += l;
  }
  return out;
}

/** a parabola of arc length L hanging between a and b (same height), sampled N + 1 times; also its sag */
function hangingArc(a: V3, b: V3, L: number, N = 300): { pts: V3[]; sag: number } {
  const D = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const at = (s: number, u: number): V3 => {
    const p = mix(a, b, u);
    p[1] -= s * (1 - (2 * u - 1) ** 2);
    return p;
  };
  const len = (s: number) => {
    let l = 0, p = at(s, 0);
    for (let i = 1; i <= 400; i++) {
      const q = at(s, i / 400);
      l += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      p = q;
    }
    return l;
  };
  let lo = 0, hi = Math.max(0.01, L);
  for (let k = 0; k < 60; k++) {
    const m = (lo + hi) / 2;
    if (len(m) < L) lo = m;
    else hi = m;
  }
  const pts: V3[] = [];
  for (let i = 0; i <= N; i++) pts.push(at(lo, i / N));
  return { pts, sag: D > 0 ? lo : 0 };
}

// ====================================================================================== 1 stiffness

/** the three pieces at the table's right edge (x = −0.8), lying along x */
export const EDGE = {
  edgeX: TABLE.x - TABLE.width / 2,
  /** overhang and the part on the table [m] */
  over: 0.15,
  onTable: 0.25,
  rows: { charging: 0.31, xlr: 0.39, power: 0.47 } as Record<EdgeKind, number>,
  /** the guide that holds the overhang straight fades out over this time (laid down) */
  settle: 1.2,
  /** the clamp goes on each tip at these times (its weight grows over CLAMP_RAMP: the hand lets go) */
  clampAt: { charging: 2.4, xlr: 3.8, power: 5.2 } as Record<EdgeKind, number>,
  duration: 7.6,
};
export type EdgeKind = 'charging' | 'xlr' | 'power';
export const EDGE_SPEC: Record<EdgeKind, CableSpec> = { charging: CABLES.CHARGING, xlr: CABLES.XLR, power: CABLES.POWER_5G2_5 };
/** the same small clamp on every tip [kg] (a metal binder clip) */
export const CLAMP_MASS = 0.008;
export const CLAMP_RAMP = 0.4;

function edgeShot(kind: EdgeKind): ShotDef {
  const spec = EDGE_SPEC[kind];
  return {
    id: `p7-edge-${kind}`,
    duration: EDGE.duration,
    fps: 60,
    substeps: spec.substeps,
    iterations: spec.iterations,
    build(): ShotBuild {
      const r = spec.od / 2, y = TABLE.height + r, z = EDGE.rows[kind];
      const x0 = EDGE.edgeX + EDGE.onTable, x1 = EDGE.edgeX - EDGE.over;
      const pts: V3[] = [];
      for (let i = 0; i <= 200; i++) pts.push([x0 + (x1 - x0) * (i / 200), y, z]);
      const { rod } = buildCable(spec, pts, { plugs: 'none', groundY: null, up: [0, 1, 0] });
      // a new piece, straight before: no strand memory of a bend
      rod.restFric.fill(0);
      rod.setRestStraight();
      // the part on the table up to the edge is held (the table and a book on it)
      let k = 0;
      while (k < rod.n - 1 && rod.x[3 * (k + 1)] >= EDGE.edgeX - 1e-9) k++;
      const held: V3 = [(x0 + EDGE.edgeX) / 2, y, z];
      rod.addGrip({ nodes: [0, k], frame: () => ({ p: held, q: ID }), keepShape: true });
      const start: V3[] = [];
      for (let i = 0; i < rod.n; i++) start.push([rod.x[3 * i], rod.x[3 * i + 1], rod.x[3 * i + 2]]);
      rod.addGuide({ nodes: [k, rod.n - 1], target: (i) => start[i], compliance: 1e-4, weight: (t) => 1 - smooth(t / EDGE.settle) });
      const tip = rod.ns - 1;
      let added = 0;
      return {
        rod,
        script: (rr, t) => {
          const want = CLAMP_MASS * smooth((t - EDGE.clampAt[kind]) / CLAMP_RAMP);
          if (want > added + 1e-7) {
            rr.addMass(tip, want - added);
            added = want;
          }
        },
        tracks: {
          edgeNode: () => k,
          /** how far the tip hangs below the table top [m] */
          droop: (rr) => y - rr.x[3 * (rr.n - 1) + 1],
          tipX: (rr) => rr.x[3 * (rr.n - 1)],
        },
      };
    },
  };
}

// ====================================================================================== 1b the crank

/** the XLR between a vise (left from Ilse's view: +x end) and a crank; the U and its ends' tilt */
export const KNOB = (() => {
  const free = 0.7, span = 0.7 * free, H = 1.06, z = 0.5, cx = -0.22;
  // the ends follow the hanging U's tangent (a parabola of the free length over the span)
  const arc = hangingArc([cx + span / 2, H, z], [cx - span / 2, H, z], free);
  const slope = Math.atan((4 * arc.sag) / span);
  return {
    free, span, H, z, cx, sag: arc.sag, slope,
    /** the vise holds the female plug at +x (Ilse's left), the crank the male plug at −x */
    vise: [cx + span / 2, H, z] as V3,
    crank: [cx - span / 2, H, z] as V3,
    /** outward directions of the two ends (along the plugs, away from the cable) */
    viseOut: [Math.cos(slope), Math.sin(slope), 0] as V3,
    crankOut: [-Math.cos(slope), Math.sin(slope), 0] as V3,
    /** turns per second while the crank turns, from t0 to the end turn count */
    rate: 0.6,
    t0: 1.2,
    turns: 4.7,
    duration: 11.5,
    /** the crank: arm length and how far out along the axis its handle sits */
    arm: 0.045,
  };
})();
/** crank turns at shot time t */
export const knobTurns = (t: number) => Math.min(KNOB.turns, KNOB.rate * Math.max(0, t - KNOB.t0));
/** rotation of the crank (and the plug in it) at t, about its outward axis */
export const knobRot = (t: number): Frame['q'] => {
  const a = KNOB.crankOut;
  return quatFromAxisAngle(a[0], a[1], a[2], TAU * knobTurns(t));
};

export const knobShot: ShotDef = {
  id: 'p7-knob',
  duration: KNOB.duration,
  fps: 120,
  substeps: 15,
  iterations: XLR.iterations,
  build(): ShotBuild {
    const pl = XLR.plug?.length ?? 0.06;
    const arc = hangingArc(KNOB.vise, KNOB.crank, KNOB.free, 300);
    const pts: V3[] = [];
    for (let i = 12; i >= 1; i--) pts.push(mix(KNOB.vise, [KNOB.vise[0] + KNOB.viseOut[0] * pl, KNOB.vise[1] + KNOB.viseOut[1] * pl, KNOB.z], i / 12));
    pts.push(...arc.pts);
    for (let i = 1; i <= 12; i++) pts.push(mix(KNOB.crank, [KNOB.crank[0] + KNOB.crankOut[0] * pl, KNOB.crank[1] + KNOB.crankOut[1] * pl, KNOB.z], i / 12));
    const { rod, cable } = buildCable(XLR, pts, { plugs: 'both', groundY: TABLE.height, GJ: P7_GJ, up: [0, 0, 1] });
    rod.restFric.fill(0);
    rod.setRestStraight();
    const n = rod.n;
    const [i0, i1] = cable;
    // the plugs are held: the vise (still) and the crank (turning about its axis through the plug's root)
    rod.addGrip({ nodes: [0, i0], frame: () => ({ p: KNOB.vise, q: ID }), keepShape: true });
    rod.addGrip({ nodes: [i1, n - 1], frame: (t) => ({ p: KNOB.crank, q: knobRot(t) }), keepShape: true });
    const back = KNOB.viseOut, out = KNOB.crankOut;
    return {
      rod,
      tracks: {
        i0: () => i0,
        i1: () => i1,
        turns: (_r, t) => knobTurns(t),
        tw: (r) => r.twistTurns(i0, i1 - 1),
        wr: (r) => writheClosed(r.x, i0, i1, out, back),
        /** the lowest point of the cable above the table [m] */
        low: (r) => {
          let m = Infinity;
          for (let i = i0; i <= i1; i++) m = Math.min(m, r.x[3 * i + 1]);
          return m - TABLE.height;
        },
      },
    };
  },
};

// ====================================================================================== 2 memory

export const MEM = {
  /** the cable proper [m]; the plugs come on top */
  len: 1.0,
  z: 0.45,
  /** above the table when let go [m] */
  drop: 0.3,
  /** the old cable is held with its ends closer (it springs together), the new one wider */
  span: { old: 0.5, new: 0.8 } as Record<MemKind, number>,
  /** the remembered coil: turns of the helix between the hands */
  oldTurns: 2,
  /** an old PVC jacket is stiffer and keeps its set: elastic EI of the old cable (preset: 1e-4) */
  oldEI: 5e-4,
  /** a smooth table top */
  friction: 0.25,
  release: 1.6,
  duration: 5.2,
};
export type MemKind = 'old' | 'new';

function memShot(kind: MemKind): ShotDef {
  return {
    id: `p7-mem-${kind}`,
    duration: MEM.duration,
    fps: 60,
    substeps: XLR.substeps,
    iterations: XLR.iterations,
    build(): ShotBuild {
      const pl = XLR.plug?.length ?? 0.06;
      const H = TABLE.height + MEM.drop, z = MEM.z, span = MEM.span[kind];
      const a: V3 = [span / 2, H, z], b: V3 = [-span / 2, H, z];
      let body: V3[];
      if (kind === 'old') {
        // a helix of oldTurns turns between the hands (its length MEM.len)
        const turnL = MEM.len / MEM.oldTurns, pitch = span / MEM.oldTurns;
        const r = Math.sqrt(Math.max(0, turnL * turnL - pitch * pitch)) / TAU;
        body = [];
        for (let i = 0; i <= 600; i++) {
          const u = i / 600, ang = TAU * MEM.oldTurns * u;
          body.push([a[0] + (b[0] - a[0]) * u, H - r + r * Math.cos(ang), z + r * Math.sin(ang)]);
        }
      } else body = hangingArc(a, b, MEM.len, 400).pts;
      // the plugs continue the ends' tangents
      const t0 = body[1], t1 = body[body.length - 2];
      const e0 = body[0], e1 = body[body.length - 1];
      const d0 = [e0[0] - t0[0], e0[1] - t0[1], e0[2] - t0[2]], d1 = [e1[0] - t1[0], e1[1] - t1[1], e1[2] - t1[2]];
      const l0 = Math.hypot(d0[0], d0[1], d0[2]), l1 = Math.hypot(d1[0], d1[1], d1[2]);
      const pts: V3[] = [];
      for (let i = 12; i >= 1; i--) pts.push([e0[0] + (d0[0] / l0) * pl * (i / 12), e0[1] + (d0[1] / l0) * pl * (i / 12), e0[2] + (d0[2] / l0) * pl * (i / 12)]);
      pts.push(...body);
      for (let i = 1; i <= 12; i++) pts.push([e1[0] + (d1[0] / l1) * pl * (i / 12), e1[1] + (d1[1] / l1) * pl * (i / 12), e1[2] + (d1[2] / l1) * pl * (i / 12)]);
      const old = kind === 'old';
      const { rod, cable } = buildCable(XLR, pts, { plugs: 'both', groundY: TABLE.height, friction: MEM.friction, up: [0, 0, 1], restFromShape: old, ...(old ? { EI: MEM.oldEI } : {}) });
      // new: straight at rest (its strands keep the gentle arc it hangs in, as any held cable)
      if (!old) rod.setRestStraight();
      const n = rod.n, [i0, i1] = cable;
      const pa = rod.x.slice(0, 3), pb = rod.x.slice(3 * (n - 1), 3 * n);
      const pA: V3 = [pa[0], pa[1], pa[2]], pB: V3 = [pb[0], pb[1], pb[2]];
      const ga = rod.addGrip({ nodes: [0, i0], frame: () => ({ p: pA, q: ID }), keepShape: true });
      const gb = rod.addGrip({ nodes: [i1, n - 1], frame: () => ({ p: pB, q: ID }), keepShape: true });
      let let_go = false;
      return {
        rod,
        script: (r, t) => {
          if (!let_go && t >= MEM.release) {
            r.releaseGrip(ga);
            r.releaseGrip(gb);
            let_go = true;
          }
        },
        tracks: {
          i0: () => i0,
          i1: () => i1,
          /** end to end in the table plane / length: 1 = straight */
          straight: (r) => Math.hypot(r.x[3 * i0] - r.x[3 * i1], r.x[3 * i0 + 2] - r.x[3 * i1 + 2]) / MEM.len,
          /** total turning of the cable in the table plane (turns): how curly it lies */
          curl: (r) => {
            let turn = 0;
            for (let i = i0 + 2; i < i1 - 1; i += 2) {
              const a1 = Math.atan2(r.x[3 * i + 2] - r.x[3 * (i - 2) + 2], r.x[3 * i] - r.x[3 * (i - 2)]);
              const a2 = Math.atan2(r.x[3 * (i + 2) + 2] - r.x[3 * i + 2], r.x[3 * (i + 2)] - r.x[3 * i]);
              let d = a2 - a1;
              d -= TAU * Math.round(d / TAU);
              turn += Math.abs(d);
            }
            return turn / TAU;
          },
          high: (r) => {
            let m = -Infinity;
            for (let i = i0; i <= i1; i++) m = Math.max(m, r.x[3 * i + 1]);
            return m - TABLE.height;
          },
        },
      };
    },
  };
}

// ====================================================================================== 3 tension

/** a twisted XLR between Ilse's hands, beside the table (she sits at the table's right end) */
export const TENSION = {
  len: 0.9,
  turns: 4,
  cx: -1.38,
  z: 0.36,
  H: 1.0,
  /** taut: span / length; slack */
  far: 0.97,
  near: 0.45,
  t: { taut0: 0.4, taut1: 2.4, slack0: 4.8, slack1: 7.2, release: 10.4, lift1: 11.6, end: 15.0 },
  /** the right hand lifts this much and moves out (−x) after the left lets go */
  lift: 0.32,
  out: 0.12,
};

/** half the distance between the hand frames (plug centres) at t; L = the rod's whole length */
export function tensionHalf(t: number, L: number, span0: number) {
  const T = TENSION.t, pl = XLR.plug?.length ?? 0.06;
  const a = span0 / 2 - pl / 2, f = (TENSION.far * L) / 2 - pl / 2, m = (TENSION.near * L) / 2 - pl / 2;
  if (t < T.slack0) return a + (f - a) * ramp(t, T.taut0, T.taut1);
  return f + (m - f) * ramp(t, T.slack0, T.slack1);
}
/** the hands' plug frames (centres) at t: [left (+x), right (−x)] */
export function tensionHands(t: number, L: number, span0: number): [V3, V3] {
  const h = tensionHalf(t, L, span0), T = TENSION.t;
  const u = ramp(t, T.release - 0.2, T.lift1);
  return [
    [TENSION.cx + h, TENSION.H, TENSION.z],
    [TENSION.cx - h - TENSION.out * u, TENSION.H + TENSION.lift * u, TENSION.z],
  ];
}

export const tensionShot: ShotDef = {
  id: 'p7-tension',
  duration: TENSION.t.end,
  fps: 120,
  substeps: 15,
  iterations: XLR.iterations,
  build(): ShotBuild {
    const L0 = TENSION.len + 2 * (XLR.plug?.length ?? 0.06);
    const pts: V3[] = [];
    for (let i = 0; i <= 200; i++) pts.push([TENSION.cx + L0 / 2 - (L0 * i) / 200, TENSION.H, TENSION.z]);
    const pl = XLR.plug?.length ?? 0.06;
    const { rod, cable } = buildCable(XLR, pts, {
      plugs: 'both', groundY: 0, GJ: P7_GJ, up: [0, 1, 0],
      // the twist she gave it: TENSION.turns over the cable proper
      twist: (s) => TAU * TENSION.turns * Math.min(1, Math.max(0, (s - pl) / TENSION.len)),
    });
    rod.restFric.fill(0);
    rod.setRestStraight();
    const n = rod.n, L = rod.totalLength, [i0, i1] = cable;
    const span0 = L0;
    const ga = rod.addGrip({ nodes: [0, i0], frame: (t) => ({ p: tensionHands(t, L, span0)[0], q: ID }), keepShape: true });
    rod.addGrip({ nodes: [i1, n - 1], frame: (t) => ({ p: tensionHands(t, L, span0)[1], q: ID }), keepShape: true });
    let freed = false;
    const spin = unwrapTrack((r) => spinAngle(r, 1, [0, 0, 1]));
    return {
      rod,
      script: (r, t) => {
        if (!freed && t >= TENSION.t.release) {
          r.releaseGrip(ga);
          freed = true;
        }
      },
      tracks: {
        i0: () => i0,
        i1: () => i1,
        L: () => L,
        span0: () => span0,
        tw: (r) => r.twistTurns(i0, i1 - 1),
        wr: (r) => writheClosed(r.x, i0, i1, [-1, 0, 0], [1, 0, 0]),
        /** the free plug's turning about its own axis (turns) */
        spin: (r) => spin(r),
        /** the free plug's height above the floor */
        plugY: (r) => r.x[1],
      },
    };
  },
};

// ====================================================================================== 4 the bands

export type BandKind = 'over' | 'under' | 'alt' | 'oouo';
/** +1 über, −1 unter, loop by loop */
export const BAND_KINDS: Record<BandKind, number[]> = { over: [1, 1, 1, 1], under: [-1, -1, -1, -1], alt: [1, -1, 1, -1], oouo: [1, 1, -1, 1] };
export const BAND_ORDER: BandKind[] = ['over', 'under', 'alt', 'oouo'];
/**
 * The band: a round rod (contact radius rc) drawn as a flat band whose yellow face is the stripe
 * (d1). Stiffness of a thin strip: GJ / EI = 2 / (1 + ν) ≈ 1.5. The loops lie on a smooth table;
 * the clamps sit `lift` above it on sleds (the band is free in the air near the clamps and can
 * turn there).
 */
export const BAND = {
  rows: { over: 0.52, under: 0.72, alt: 0.92, oouo: 1.12 } as Record<BandKind, number>,
  EI: 2e-4,
  GJ: 3e-4,
  rc: 0.004,
  density: 0.03,
  friction: 0.1,
  selfFriction: 0.05,
  /** loops: trochoid radius and advance per radian (c / R), lead at each end, segment */
  R: 0.045,
  cr: 0.32,
  lead: 0.11,
  seg: 0.008,
  lift: 0.06,
  /** pulled to far × length, pushed to near × length */
  far: 0.96,
  near: 0.45,
  /** the clamp holds this much of each end [m] */
  hold: 0.03,
  t: { settle: 0.8, pull1: 4.8, hold1: 6.0, push1: 10.0, hold2: 11.5, pull2: 14.5, release: 16.0, end: 20.0 },
};

/** the band's centre line at rest on the table, loops by kinds (+1 later strand on top = über) */
export function bandCurve(kinds: number[], z: number): V3[] {
  const { R, cr, lead, seg, rc } = BAND;
  const c = cr * R;
  // crossing half angle: sin(φ) / φ = c / R
  let lo = 0.01, hi = Math.PI;
  for (let k = 0; k < 60; k++) {
    const m = (lo + hi) / 2;
    if (Math.sin(m) / m > cr) lo = m;
    else hi = m;
  }
  const phi = lo;
  const y0 = TABLE.height + rc;
  const at = (th: number): V3 => {
    let y = y0;
    kinds.forEach((s, k) => {
      // lift the strand that lies on top at loop k's crossing: the later one for über
      const centre = TAU * k + (s > 0 ? phi : -phi);
      y += 2.3 * rc * Math.exp(-(((th - centre) / 0.35) ** 2));
    });
    return [c * th - R * Math.sin(th), y, -R * Math.cos(th)];
  };
  const th0 = -Math.PI, th1 = (2 * kinds.length - 1) * Math.PI;
  const P: V3[] = [];
  const pA = at(th0), pB = at(th1);
  for (let i = 30; i >= 1; i--) P.push([pA[0] - (lead * i) / 30, pA[1], pA[2]]);
  for (let i = 0; i <= 4000; i++) P.push(at(th0 + ((th1 - th0) * i) / 4000));
  for (let i = 1; i <= 30; i++) P.push([pB[0] + (lead * i) / 30, pB[1], pB[2]]);
  const out = resample(P, seg);
  const mid = (out[0][0] + out[out.length - 1][0]) / 2, dz = z - pA[2];
  return out.map((p) => [p[0] - mid, p[1], p[2] + dz]);
}

/** half the clamp distance at t (from the initial half0) for a band of length L */
export function bandHalf(t: number, half0: number, L: number) {
  const T = BAND.t, far = (BAND.far * L) / 2, near = (BAND.near * L) / 2;
  if (t < T.hold1) return half0 + (far - half0) * ramp(t, T.settle, T.pull1);
  if (t < T.hold2) return far + (near - far) * ramp(t, T.hold1, T.push1);
  return near + (far - near) * ramp(t, T.hold2, T.pull2);
}

function bandShot(kind: BandKind): ShotDef {
  return {
    id: `p7-band-${kind}`,
    duration: BAND.t.end,
    fps: 60,
    substeps: 30,
    iterations: 2,
    build(): ShotBuild {
      const z = BAND.rows[kind];
      const pts = bandCurve(BAND_KINDS[kind], z);
      const rod = Rod.fromPolyline(pts, {
        radius: BAND.rc, linearDensity: BAND.density, EI: BAND.EI, GJ: BAND.GJ,
        damping: 0.5, angularDamping: 0.5, bendDamping: 0.05, twistDamping: 0.05,
        groundY: TABLE.height, friction: BAND.friction, selfFriction: BAND.selfFriction,
        up: [0, 1, 0], maxSpeed: 8, iterations: 2,
      });
      const n = rod.n, L = rod.totalLength;
      const h = Math.round(BAND.hold / BAND.seg);
      const cA: V3 = [(rod.x[0] + rod.x[3 * h]) / 2, TABLE.height + BAND.rc, z];
      const cB: V3 = [(rod.x[3 * (n - 1)] + rod.x[3 * (n - 1 - h)]) / 2, TABLE.height + BAND.rc, z];
      const half0 = (cB[0] - cA[0]) / 2;
      const lifted = (t: number) => BAND.lift * smooth(t / BAND.t.settle);
      // left clamp (−x, Ilse's right) and right clamp (+x): they never turn
      rod.addGrip({ nodes: [0, h], frame: (t) => ({ p: [-bandHalf(t, half0, L), cA[1] + lifted(t), z], q: ID }), keepShape: true });
      const frameB = (t: number): Frame => ({ p: [bandHalf(t, half0, L), cB[1] + lifted(t), z], q: ID });
      let gB = rod.addGrip({ nodes: [n - 1 - h, n - 1], frame: frameB, keepShape: true });
      let freed = false;
      const spin = unwrapTrack((r) => spinAngle(r, r.ns - 1, [0, 1, 0]));
      return {
        rod,
        script: (r, t) => {
          // über ×4 only: the clamp at +x opens: the end keeps its place and direction, it may turn
          if (kind === 'over' && !freed && t >= BAND.t.release) {
            r.releaseGrip(gB);
            gB = r.addGrip({ nodes: [n - 1 - h, n - 1], frame: (tt) => ({ p: frameB(tt).p, q: ALONG_X }), swivel: true, blend: 0.05 });
            freed = true;
          }
        },
        tracks: {
          half0: () => half0,
          L: () => L,
          half: (_r, t) => bandHalf(t, half0, L),
          tw: (r) => r.twistTurns(),
          wr: (r) => writheClosed(r.x, 0, n - 1, [1, 0, 0], [-1, 0, 0]),
          /** the +x end's turning about the band (turns) */
          spin: (r) => spin(r),
        },
      };
    },
  };
}

// ====================================================================================== 5 the ring

/**
 * An XLR ring held at its two plugs side by side at the top. First (0 … RING.set) the hands turn the
 * plugs upright, so the cable leaves them downward and the ring hangs as a long loop; then the right
 * hand (−x) turns its plug about its own (vertical) axis: the twist goes in, and at about 1.3 turns
 * the loop swings round into an eight (writhe 0.6 → 1.1 within ~0.5 s); turned further it would
 * wind up into a twisted rope, so she stops at RING.turns.
 */
export const RING = {
  len: 1.2,
  /** beside the table (where she sits for the tension), the plugs at chest height */
  cx: -1.38,
  top: 1.13,
  z: 0.36,
  /** gap between the plug faces */
  gap: 0.012,
  set: 1.0,
  rate: 0.4,
  t0: 1.6,
  turns: 1.8,
  duration: 8.4,
};
export const ringTurns = (t: number) => Math.min(RING.turns, RING.rate * Math.max(0, t - RING.t0));

export const ringShot: ShotDef = {
  id: 'p7-ring',
  duration: RING.duration,
  fps: 120,
  substeps: 15,
  iterations: XLR.iterations,
  build(): ShotBuild {
    const R = RING.len / TAU, a0 = Math.PI / 2 + RING.gap / R;
    const pts: V3[] = [];
    // from the top, just left of the gap (+x side is Ilse's left), round to just right of it
    for (let i = 0; i <= 500; i++) {
      const a = a0 + ((TAU - (2 * RING.gap) / R) * i) / 500;
      pts.push([RING.cx - R * Math.cos(a), RING.top - R + R * Math.sin(a), RING.z]);
    }
    const { rod, cable } = buildCable(XLR, pts, { plugs: 'both', groundY: 0, GJ: P7_GJ, up: [0, 0, 1] });
    rod.restFric.fill(0);
    rod.setRestStraight();
    const n = rod.n, [i0, i1] = cable;
    const centre = (from: number, to: number): V3 => {
      const c: V3 = [0, 0, 0];
      for (let i = from; i <= to; i++) for (let k = 0; k < 3; k++) c[k] += rod.x[3 * i + k] / (to - from + 1);
      return c;
    };
    const cA = centre(0, i0), cB = centre(i1, n - 1);
    // upright: the left plug turns −90° about z, the right +90° (about their centres), a little apart and up
    const up = (t: number) => smooth(t / RING.set);
    const setup = (s: number, t: number) => quatFromAxisAngle(0, 0, 1, s * (Math.PI / 2) * up(t));
    rod.addGrip({ nodes: [0, i0], frame: (t) => ({ p: [cA[0] + 0.015 * up(t), cA[1] + 0.02 * up(t), cA[2]], q: setup(-1, t) }), keepShape: true });
    rod.addGrip({ nodes: [i1, n - 1], frame: (t) => ({ p: [cB[0] - 0.015 * up(t), cB[1] + 0.02 * up(t), cB[2]], q: quatMul(quatFromAxisAngle(0, 1, 0, TAU * ringTurns(t)), setup(1, t)) }), keepShape: true });
    return {
      rod,
      tracks: {
        i0: () => i0,
        i1: () => i1,
        turns: (_r, t) => ringTurns(t),
        tw: (r) => r.twistTurns(),
        // the ring is closed but for the plugs' small gap: its writhe as it is
        wr: (r) => writhe(r.x, 0, r.n - 1),
        /** how far the ring stands out of its plane (z) [m] */
        out: (r) => {
          let m = 0;
          for (let i = i0; i <= i1; i++) m = Math.max(m, Math.abs(r.x[3 * i + 2] - RING.z));
          return m;
        },
      },
    };
  },
};

// ====================================================================================== the list

export const P7_SHOTS: ShotDef[] = [
  edgeShot('charging'), edgeShot('xlr'), edgeShot('power'),
  knobShot,
  memShot('old'), memShot('new'),
  tensionShot,
  ...BAND_ORDER.map(bandShot),
  ringShot,
];

/** quaternion helper for the part: the crank's frame (axis = crankOut, at the plug's root) */
export function crankFrame(t: number): Frame {
  return { p: KNOB.crank, q: quatMul(knobRot(t), ID) };
}
