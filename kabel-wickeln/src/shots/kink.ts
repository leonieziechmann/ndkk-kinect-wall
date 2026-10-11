// Stage 2, shot 5 (and the curl of shot 4): Teo's cable, wound the same way six times, holds six
// turns of twist. Pulled almost taut it stays straight (the twist is hidden); the hands come 40 cm
// together and a curl pops out and twists up; Teo pulls again and the curl tightens into a kink
// of about one to two cable diameters (guided, see tighten()); he lets go loosely, and the kink
// stays (fake plasticity: where the cable is bent tighter than KINK_RADIUS, its rest shape
// follows the bend).
//
// Coordinates: Teo holds the cable in front of him at height H along x; the clip is baked at
// 120 frames/s for the slow motion.

import { Frame, Rod, V3, add, cross, dot, gripFrame, normalize, scale, smooth, sub } from '../sim';
import type { ShotDef } from './types';

/** patch cable Ø 6 mm, contact radius 1.2 r */
export const KINK_CABLE = { radius: 0.003, collisionRadius: 0.0036, linearDensity: 0.04, EI: 1.2e-3, GJ: 0.9e-3, damping: 1.5, angularDamping: 2, groundY: null as number | null };
const SEG = 0.005, LENGTH = 1.2, H = 1.1;
/** stored twist [turns] (six loops wound the same way) */
export const KINK_TWIST = 6;
/** cable beyond each fist (the plugs hang from it) */
const END = 0.1;
/**
 * half the distance of the fists: taut, 40 cm closer, pulled again (leaving the ~7 cm a tight
 * curl needs), and loosely at the end
 */
const TAUT = 0.49, SLACK = TAUT - 0.2, PULLED = TAUT - 0.035, LOOSE = TAUT - 0.12;
/** shot times: hands together, pulling again, letting go loosely */
export const KINK_TIMES = { together: 0.6, pull: 2.6, pulled: 3.8, loose: 5.0, end: 6.5 };
/** a bend tighter than this radius sets (plasticity) [m] */
export const KINK_RADIUS = 0.009;
/** how far the rest shape follows a kink at most (sum of the per-frame steps) */
const SET = 0.6;

/** Half the distance between the fists over time. */
function halfGap(t: number) {
  const { together, pull, pulled, loose } = KINK_TIMES;
  if (t < pull) return TAUT + (SLACK - TAUT) * smooth((t - together) / 0.6);
  if (t < loose) return SLACK + (PULLED - SLACK) * smooth((t - pull) / (pulled - pull));
  return PULLED + (LOOSE - PULLED) * smooth((t - loose) / 0.8);
}

/** Grip frames of Teo's fists (palms down, the cable along +x). */
export const KINK_HANDS: Record<'left' | 'right', (t: number) => Frame> = {
  left: (t) => gripFrame([-halfGap(t), H, 0], [1, 0, 0], [0, 1, 0]),
  right: (t) => gripFrame([halfGap(t), H, 0], [1, 0, 0], [0, 1, 0]),
};

/** Curvature radius at node i (from the neighbouring nodes two segments away). */
function bendRadius(x: Float64Array, i: number) {
  const a: V3 = [x[3 * i - 6], x[3 * i - 5], x[3 * i - 4]], b: V3 = [x[3 * i], x[3 * i + 1], x[3 * i + 2]], c: V3 = [x[3 * i + 6], x[3 * i + 7], x[3 * i + 8]];
  const ab = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), bc = Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]), ca = Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
  // circumradius of the triangle a b c
  const s = (ab + bc + ca) / 2, area = Math.sqrt(Math.max(0, s * (s - ab) * (s - bc) * (s - ca)));
  return area < 1e-12 ? Infinity : (ab * bc * ca) / (4 * area);
}

/** The tightest bend of the cable between the fists: node and radius. */
export function tightestBend(x: Float64Array, n: number): { node: number; radius: number } {
  let best = { node: -1, radius: Infinity };
  for (let i = 2; i < n - 2; i++) {
    const r = bendRadius(x, i);
    if (r < best.radius) best = { node: i, radius: r };
  }
  return best;
}

/** radius the pulled curl is drawn down to (≈ 1.2 cable diameters); how far it may leave its plane */
const TIGHT = 0.007, CROSS = 0.004;

/**
 * Pulled again, a free curl would mostly roll out; a real one, held by the friction where its
 * strands cross, tightens. So while Teo pulls, a guide draws the curl down to TIGHT in its plane
 * (pseudo-simulation): every node of the curl is pulled toward the shrinking circle in its plane
 * (so it cannot roll out over the cable), leaving its angle free and its offset across the plane
 * free up to CROSS (where the strands cross). The curl is found when the pull starts: the
 * tightest bend, and the circle through it and two nodes half a radius-arc away.
 */
function tighten(r: Rod): number {
  const { node: k0, radius: r0 } = tightestBend(r.x, r.n);
  const m = Math.max(4, Math.round((Math.PI * r0) / SEG)), h = Math.round(m / 2);
  const p = (i: number): V3 => [r.x[3 * i], r.x[3 * i + 1], r.x[3 * i + 2]];
  const a = p(k0 - h), b = p(k0), c = p(k0 + h);
  const nrm = normalize(cross(sub(b, a), sub(c, a)));
  const { pull, pulled } = KINK_TIMES;
  const radius = (t: number) => r0 + (TIGHT - r0) * smooth((t - pull) / (pulled - pull));
  // the curl's centre: the centroid of the nodes still in it
  const centre = (t: number): V3 => {
    const k = Math.round(m * (radius(t) / r0));
    let sx = 0, sy = 0, sz = 0;
    for (let i = k0 - k; i <= k0 + k; i++) { sx += r.x[3 * i]; sy += r.x[3 * i + 1]; sz += r.x[3 * i + 2]; }
    const w = 2 * k + 1;
    return [sx / w, sy / w, sz / w];
  };
  let tc = -1, cc: V3 = [0, 0, 0];
  return r.addGuide({
    nodes: [k0 - m, k0 + m],
    compliance: 2e-4,
    weight: (t) => smooth((t - pull) / 0.2) * (1 - smooth((t - pulled - 0.2) / 0.2)),
    target: (i, t) => {
      if (Math.abs(i - k0) > m * (radius(t) / r0)) return null;
      if (t !== tc) { tc = t; cc = centre(t); }
      // in the plane (it must not roll out over the cable), on the shrinking circle; the strands
      // may still pass each other where they cross
      const d = sub(p(i), cc), off = dot(d, nrm), inPlane = sub(d, scale(nrm, off)), l = Math.hypot(...inPlane);
      if (l < 1e-6) return null;
      const keep = Math.max(-CROSS, Math.min(CROSS, off));
      return add(add(cc, scale(nrm, keep)), scale(inPlane, radius(t) / l));
    },
  });
}

export const kinkShot: ShotDef = {
  id: 'kink',
  duration: KINK_TIMES.end,
  fps: 120,
  substeps: 30,
  iterations: 3,
  build() {
    const n = Math.round(LENGTH / SEG) + 1;
    const rod = Rod.straight([-LENGTH / 2, H, 0], [LENGTH / 2, H, 0], n, { ...KINK_CABLE, twist: (s) => (2 * Math.PI * KINK_TWIST * s) / LENGTH });
    const e = Math.round(END / SEG);
    // the fists hold the cable as it is (with its twist), so they only move it
    const left0 = KINK_HANDS.left(0), right0 = KINK_HANDS.right(0);
    rod.addGrip({ nodes: [e - 2, e + 2], keepShape: true, frame: (t) => ({ p: KINK_HANDS.left(t).p, q: left0.q }) });
    rod.addGrip({ nodes: [n - 1 - e - 2, n - 1 - e + 2], keepShape: true, frame: (t) => ({ p: KINK_HANDS.right(t).p, q: right0.q }) });
    // plasticity: while Teo pulls, per frame, joints bent tighter than KINK_RADIUS move 6 % of
    // the way toward keeping that bend, up to SET in all (a few tenths of a second of being
    // pulled tight leave a lasting kink, but the rest shape never runs away)
    const setOf = new Float64Array(n);
    let set = 0, loop = 0;
    return {
      rod,
      script: (r, t) => {
        if (!loop && t >= KINK_TIMES.pull) loop = tighten(r);
        if (t < KINK_TIMES.pull || t > KINK_TIMES.loose) return;
        for (let i = e + 4; i < n - e - 4; i++) {
          if (setOf[i] >= SET || bendRadius(r.x, i) >= KINK_RADIUS) continue;
          r.setRestFromCurrent(i - 2, i + 1, 0.06);
          setOf[i] += 0.06;
          set++;
        }
      },
      tracks: {
        twist: (r) => r.twistTurns(e, n - 2 - e),
        writhe: (r) => r.writhe(e, n - 1 - e),
        /** tightest bend radius [m] and how often the kink has been set (plasticity, for the ✗) */
        bend: (r) => tightestBend(r.x, r.n).radius,
        kinkNode: (r) => tightestBend(r.x, r.n).node,
        plastic: () => set,
      },
    };
  },
};
