// The title (part p0-title): the clean ring the camera glides to at the end of the load-out shot.
//
//   p0-title-ring   Noor's 5 m XLR (the calibrated XLR preset, sim/cables.ts) coiled over-under in
//                   6 loops of 0.75 m (Ø ≈ 23 cm), the same ring as "right" in stage 5.3 (the ring
//                   factory, deploy-ring.ts: laid out, pressed, hung in a fist; a cache hit), laid
//                   down flat on the lid of a flight case. The velcro tie holds the top of the ring,
//                   where the hand held it (a rigid bundle: the start end and the top of every loop),
//                   both plugs stick out beside the tie. Simulated: everything else, as it settles
//                   under its own weight on the case (the case top is the ground plane). Guided
//                   (KONZEPT "Führungskräfte"), for the first 1.4 s only: the end tail, which hung
//                   down through the eye in the fist, is led out beside the tie (a coiler puts the
//                   tie round the last bit and lets the plug hang out), so both plugs lie outside
//                   the ring; then it is let go and lies where it falls.
//
// The scene shows the settled ring (the last frame). The checks are tracks of the bake (the
// crossings of the factory ring, twist and writhe, how still it lies, how flat and round, whether
// both plugs lie outside the loops).
//
// World coordinates as in the part: y up, the camera of the wide shot on +z looking towards -z.

import { Bundle, Quat, Rod, V3, XLR, add, cross, dot, length, normalize, quatFromAxisAngle, quatMul, quatRotate, scale, sub } from '../sim';
import { FIST, Ring, RingSpec, crossings, placePoint, placeRing, ringRod, windRing } from './deploy-ring';
import type { ShotBuild, ShotDef } from './types';

const RC = XLR.od / 2;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth01 = (x: number) => {
  const u = clamp01(x);
  return u * u * (3 - 2 * u);
};

/** the flight case the ring lies on: centre on the floor (x, z), size, turned about y (rad) */
export const HERO_CASE = { x: 1.35, z: 1.35, width: 0.8, depth: 0.6, height: 0.55, yaw: -0.12 };
/** the case's top surface (the laminate lies 2 mm below the top of the box) */
export const HERO_TOP = HERO_CASE.height - 0.002;

/**
 * Noor's 5 m XLR coiled like the ring "right" of stage 5.3 (6 loops of 0.75 m, over-under), but
 * starting with an "unter" loop: the last loop is then an "über" loop and the end tail hangs in
 * front of it, so laid flat it lies on top of the stack (and can be laid out beside the tie).
 */
export const RING_SPEC: RingSpec = { cable: XLR, plugs: 'both', loop: 0.75, pattern: 'uououo', lead: 0.25, tail: 0.3, spacing: 0.016, press: 0.6 };

/** how the ring lies: the factory ring (loops in x-y, stack along +z, the fist on top) laid flat (the stack points up), the tie towards +z turned by RING_YAW */
export const RING_YAW = Math.PI + HERO_CASE.yaw + 0.35;
export const RING_Q: Quat = quatMul(quatFromAxisAngle(0, 1, 0, RING_YAW), quatFromAxisAngle(1, 0, 0, -Math.PI / 2));

export const RING_T = {
  /** the end tail is led out beside the tie, then let go */
  guide1: 1.4,
  guideOff: 1.9,
  end: 3.6,
};

/** the factory ring's centre (the loops' middle) and its turned axes in the world */
function ringAxes() {
  const w = quatRotate(RING_Q, [1, 0, 0]); // the strands' direction at the tie (the lead's side: +w)
  const v = quatRotate(RING_Q, [0, 0, 1]); // up (the stack)
  const e = quatRotate(RING_Q, [0, 1, 0]); // out of the ring through the tie
  return { w, v, e };
}

export const ringShot: ShotDef = {
  id: 'p0-title-ring',
  duration: RING_T.end,
  fps: 60,
  substeps: XLR.substeps,
  iterations: XLR.iterations,
  build(): ShotBuild {
    const spec = RING_SPEC;
    const ring: Ring = windRing(spec);
    // the crossings of the ring as it was coiled (factory coordinates): over-under must alternate
    const cross0 = crossings(ringRod(ring, ring.state, spec), ring);

    // where it goes: the loops' middle over the case's centre, the lowest strand on the case
    const N = ring.loops.length;
    let cx = 0, cy = 0, cz = 0, m = 0;
    for (const [a, b] of ring.loops) {
      for (let j = a; j <= b; j++) {
        cx += ring.state.c[3 * j];
        cy += ring.state.c[3 * j + 1];
        cz += ring.state.c[3 * j + 2];
        m++;
      }
    }
    const centre: V3 = [cx / m, cy / m, cz / m];
    const cTurned = sub(placePoint(centre, [0, 0, 0], RING_Q), FIST);
    let yMin = Infinity;
    for (let j = 0; j < ring.state.L.length; j++) {
      const p = placePoint([ring.state.c[3 * j], ring.state.c[3 * j + 1], ring.state.c[3 * j + 2]], [0, 0, 0], RING_Q);
      yMin = Math.min(yMin, p[1]);
    }
    const d: V3 = [HERO_CASE.x - FIST[0] - cTurned[0], HERO_TOP + RC + 0.0008 - yMin, HERO_CASE.z - FIST[2] - cTurned[2]];
    const rod: Rod = ringRod(ring, placeRing(ring.state, d, RING_Q, HERO_TOP), spec);
    const { w, v, e } = ringAxes();
    const tieP: V3 = add(FIST, d);

    // the velcro tie: a rigid bundle round the top of the ring (the top of every loop, and the last
    // 5 cm of the start end under it; the rest of the start end with its plug lies free)
    const tie: Bundle = rod.bundle({ frame: { p: tieP, q: RING_Q }, blend: 0.001 });
    const sLead = ring.sLoops[0][0];
    for (const [a, b] of ring.held) {
      if (b <= sLead + 1e-9) tie.add(Math.max(a, sLead - 0.045), b);
      else tie.add(a, b);
    }

    // The end tail hung down through the eye in front of the last loop (an "über" loop): laid flat
    // it lies on top of the stack, across the middle of the ring. It is turned about the tie by 90°
    // on top of the stack (never through a strand), so that it leaves beside the tie (away from
    // the lead's side) and comes down onto the case outside the loops; then it is let go.
    const sTop = ring.sLoops[N - 1][1];
    const iT0 = rod.segmentAt(sTop + 0.02) + 1;
    const nT = rod.n - 1;
    const s0 = rod.sNode[iT0];
    const startPos = Float64Array.from(rod.x);
    const root: V3 = [startPos[3 * iT0], startPos[3 * iT0 + 1], startPos[3 * iT0 + 2]];
    const yLie = HERO_TOP + RC + 0.0005;
    /** where tail node i lies at turn u (0 … 1): turned about the root from across the ring (-e) to beside the tie (-w, 1.2 cm out) */
    const tailAt = (i: number, u: number): V3 => {
      const s = rod.sNode[i] - s0;
      const a: V3 = [startPos[3 * i], startPos[3 * i + 1], startPos[3 * i + 2]];
      const th = (Math.PI / 2) * 0.97 * u;
      const dir = add(scale(e, -Math.cos(th)), scale(w, -Math.sin(th)));
      const p = add(add(root, scale(dir, s)), scale(e, 0.012 * u * smooth01(s / 0.03)));
      // a little above the stack while it turns; outside the loops it comes down onto the case
      const lift = 0.012 * Math.sin(Math.PI * u);
      const yTurn = Math.max(a[1], root[1]) + lift;
      const yOut = root[1] + (yLie - root[1]) * smooth01((s - 0.02) / 0.06);
      const y = yTurn + (yOut - yTurn) * smooth01((u - 0.6) / 0.4);
      return [p[0], y, p[2]];
    };
    const tailGuide = rod.addGuide({
      nodes: [iT0, nT],
      compliance: 3e-3,
      target: (i, t) => tailAt(i, smooth01(t / RING_T.guide1)),
      weight: (t) => 1 - smooth01((t - RING_T.guide1) / (RING_T.guideOff - RING_T.guide1)),
    });
    let guideOn = true;

    // ------------------------------------------------------------------ measures
    const [c0, c1] = ring.cable;
    const loopNodes = (r: Rod) => {
      const out: V3[] = [];
      for (const [a, b] of ring.loops) for (let j = a; j <= b; j++) out.push([r.x[3 * j], r.x[3 * j + 1], r.x[3 * j + 2]]);
      return out;
    };
    /** the ring in the case's plane: centre, mean and max loop radius, extents along the tie axis (e) and across (w) */
    const plan = (r: Rod) => {
      const P = loopNodes(r);
      let x = 0, z = 0;
      for (const p of P) {
        x += p[0];
        z += p[2];
      }
      const C: V3 = [x / P.length, 0, z / P.length];
      let rMax = 0, rSum = 0, e0 = Infinity, e1 = -Infinity, w0 = Infinity, w1 = -Infinity;
      for (const p of P) {
        const dd: V3 = [p[0] - C[0], 0, p[2] - C[2]];
        const rr = length(dd);
        rMax = Math.max(rMax, rr);
        rSum += rr;
        const pe = dot(dd, e), pw = dot(dd, w);
        e0 = Math.min(e0, pe);
        e1 = Math.max(e1, pe);
        w0 = Math.min(w0, pw);
        w1 = Math.max(w1, pw);
      }
      return { C, rMax, rMean: rSum / P.length, depth: e1 - e0, width: w1 - w0 };
    };
    /** a plug's tip outside the loops: its distance from the ring's centre minus the largest loop radius (m, > 0: outside) */
    const plugOut = (r: Rod, i: number) => {
      const pl = plan(r);
      return Math.hypot(r.x[3 * i] - pl.C[0], r.x[3 * i + 2] - pl.C[2]) - pl.rMax;
    };
    /** the tie's bunch: centre and half axes (along e: out of the ring; along v: up) from the strands at the tie (world) */
    const tieGeom = (r: Rod): number[] => {
      let ea = Infinity, eb = -Infinity, va = Infinity, vb = -Infinity;
      for (let i = 0; i < r.n; i++) {
        const p: V3 = [r.x[3 * i], r.x[3 * i + 1], r.x[3 * i + 2]];
        const dd = sub(p, tieP);
        if (Math.abs(dot(dd, w)) > 0.008) continue;
        if (Math.abs(dot(dd, e)) > 0.06 || Math.abs(dot(dd, v)) > 0.08) continue;
        const pe = dot(dd, e), pv = dot(dd, v);
        ea = Math.min(ea, pe);
        eb = Math.max(eb, pe);
        va = Math.min(va, pv);
        vb = Math.max(vb, pv);
      }
      const c = add(tieP, add(scale(e, (ea + eb) / 2), scale(v, (va + vb) / 2)));
      return [...c, ...e, ...v, ...w, (eb - ea) / 2 + RC, (vb - va) / 2 + RC];
    };

    return {
      rod,
      script: (r, t) => {
        if (guideOn && t >= RING_T.guideOff) {
          r.removeGuide(tailGuide);
          guideOn = false;
        }
      },
      tracks: {
        i0: () => c0,
        i1: () => c1,
        loops: () => N,
        // the factory ring's crossings, one per loop (+ über, − unter); over-under alternates
        ...Object.fromEntries(cross0.map((c, k) => [`cross${k}`, () => c])),
        /** twist and writhe of the cable proper (turns) */
        tw: (r) => r.twistTurns(c0, c1 - 1),
        wr: (r) => r.writhe(c0, c1),
        /** the fastest segment (m/s): ≈ 0 when it lies still */
        vmax: (r) => {
          let vm = 0;
          for (let j = 0; j < r.ns; j++) vm = Math.max(vm, Math.hypot(r.v[3 * j], r.v[3 * j + 1], r.v[3 * j + 2]));
          return vm;
        },
        /** the pile's height above the case (m), the lowest strand's gap to the case (m, ≥ 0) */
        height: (r) => {
          let y = -Infinity;
          for (let i = 0; i < r.n; i++) y = Math.max(y, r.x[3 * i + 1]);
          return y + RC - HERO_TOP;
        },
        low: (r) => {
          let y = Infinity;
          for (let i = 0; i < r.n; i++) y = Math.min(y, r.x[3 * i + 1]);
          return y - RC - HERO_TOP;
        },
        /** how round it lies: mean loop radius, widest, footprint across and along the tie's axis */
        rMean: (r) => plan(r).rMean,
        rMax: (r) => plan(r).rMax,
        width: (r) => plan(r).width,
        depth: (r) => plan(r).depth,
        /** both plugs outside the loops (m beyond the widest loop) */
        plugStartOut: (r) => plugOut(r, 0),
        plugEndOut: (r) => plugOut(r, r.n - 1),
        gap: (r) => r.maxJointGap(),
      },
      vectors: {
        /** the tie's bunch for the scene: centre, e, v, w, half axes a (along e), b (along v) */
        tie: { size: 14, fn: (r) => tieGeom(r) },
      },
    };
  },
};

/** the ring's frame in the world (for the scene: the tie's side e, up v, the strands at the tie w) */
export const ringFrame = () => {
  const a = ringAxes();
  return { e: a.e, v: a.v, w: a.w, n: normalize(cross(a.w, a.e)) };
};

export const P0_TITLE_SHOTS: ShotDef[] = [ringShot];
