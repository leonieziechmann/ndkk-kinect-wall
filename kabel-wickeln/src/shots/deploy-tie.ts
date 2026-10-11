// The velcro tie of a ring that is laid out again (stage 1, items 3 and 4: deploy-pull.ts, throw.ts),
// kinematic. Closed: once round the bunch at the ring's top (an ellipse round the strands), its end
// through the eyelet, folded back over the band, the pull tab standing up. A hand pinches the tab and
// pulls it up out of the eyelet, lets go: the end flops over, the band lies loose round the bunch.
// When the loops leave it (the hand lets the ring fall, or takes them away) the band hangs from the
// cable it lives on, near the plug: a small loop round the cable, then down.

import { V3, add, cross, normalize, scale, smooth, sub } from '../sim';

/** the band: length, width, thickness (m); where it lives on its cable (m from the plug's tip) */
export interface TieSpec {
  length: number;
  width: number;
  thickness: number;
  s: number;
}

/** the bunch the band goes round: centre, axes (e across the strands, v up: the eyelet's side), the strands' direction w, half axes */
export interface TieGeom {
  c: V3;
  e: V3;
  v: V3;
  w: V3;
  a: number;
  b: number;
}

/** when (shot seconds): pinched, out of the eyelet, let go, the loops leave the band */
export interface TieTimes {
  pinch: number;
  unfold: number;
  letTie: number;
  drop: number;
}

export interface TieShape {
  /** the band's centre line from the eyelet to its end (TIE_POINTS points) */
  pts: V3[];
  /** its end, where a hand pinches it */
  tip: V3;
  /** the band's width direction */
  side: V3;
}
export const TIE_POINTS = 90;
/** how far the closed band's end is folded back over the band before the pull tab stands up */
const TIE_FOLD = 0.012;

/** a point of the ellipse round the bunch (centre c, axes e and v) at angle φ (0 = towards v, the eyelet), grown by `off` */
const onEllipse = (c: V3, e: V3, v: V3, a: number, b: number, phi: number, off: number): V3 => add(c, add(scale(e, (a + off) * Math.sin(phi)), scale(v, (b + off) * Math.cos(phi))));
const lerpV = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];

export interface TieOptions {
  /** the band hangs from here once the loops have left it: the cable point it lives on and the cable's direction (without it the eyelet stays put) */
  root?: { p: V3; d: V3 };
  /** radius of the cable it lives on (m) */
  cableR: number;
  /** nothing goes below this height (a desk, the floor) */
  floorY: number;
  /** the direction the pull tab stands out in, and the end once out of the eyelet (default: up) */
  tab?: V3;
}

/**
 * The tie at shot time t. The flopped-over end hangs beyond the bunch along +e (a half turn wide
 * enough to clear the bunch, then down): never through the loops below the top.
 */
export function tieAt(g: TieGeom, spec: TieSpec, T: TieTimes, t: number, o: TieOptions): TieShape {
  const { c: c0, e: E, v: V, w: W, a, b } = g;
  /** the pull tab and the end out of the eyelet point up (or along o.tab) */
  const UP: V3 = o.tab ? normalize(o.tab) : normalize(add(V, [0, 1.5, 0]));
  const ell = (c: V3, phi: number, off: number) => onEllipse(c, E, V, a, b, phi, off);
  const th = spec.thickness, L = spec.length, n = TIE_POINTS, ds = L / (n - 1);
  const fold = 1 - smooth((t - T.pinch) / (T.unfold - T.pinch));
  const loose = smooth((t - T.letTie) / 0.4);
  const hang = smooth((t - T.drop - 0.1) / 0.5);
  // the loose band lies wider round the bunch and sags a little
  const c = add(c0, [0, -0.003 * loose, 0]), off = th / 2 + 0.005 * loose;
  const M = 360;
  const arc = new Float64Array(M + 1);
  for (let k = 1; k <= M; k++) arc[k] = arc[k - 1] + Math.hypot(...sub(ell(c, (2 * Math.PI * k) / M, off), ell(c, (2 * Math.PI * (k - 1)) / M, off)));
  const turn = arc[M];
  const phiAt = (s: number) => {
    let k = 0;
    while (k < M - 1 && arc[k + 1] < s) k++;
    return ((k + (s - arc[k]) / Math.max(1e-9, arc[k + 1] - arc[k])) / M) * 2 * Math.PI;
  };
  const eye = ell(c, 0, off);
  // closed: through the eyelet, folded back over the band for TIE_FOLD, then the pull tab stands up
  // (a hand pinches it well above the loops: its fingers stay clear of them)
  const R = (a + b) * 0.95, foldEnd = ell(c, -TIE_FOLD / R, th * 2.6);
  // let go: the end flops over towards +e (a half turn) and hangs beyond the bunch
  const r = Math.max(0.012, (a + 0.008) / 2), flopTop = add(eye, scale(UP, 0.008)), hangDir = normalize(add(scale(V, -1), scale(E, 0.25)));
  const flop = (e: number): V3 => {
    if (e < 0.008) return add(eye, scale(UP, e));
    const th2 = (e - 0.008) / r;
    if (th2 < Math.PI) return add(flopTop, add(scale(UP, r * Math.sin(th2)), scale(E, r * (1 - Math.cos(th2)))));
    return add(add(flopTop, scale(E, 2 * r)), scale(hangDir, e - 0.008 - Math.PI * r));
  };
  const pts: V3[] = [];
  for (let k = 0; k < n; k++) {
    const s = k * ds;
    if (s <= turn) {
      pts.push(ell(c, phiAt(s), off));
      continue;
    }
    const e = s - turn;
    // through the eyelet, back over the band, the tab up (closed) …
    const folded =
      e < 0.006 ? ell(c, 0, th * (1.5 + e / 0.006)) : e < 0.006 + TIE_FOLD ? ell(c, -(e - 0.006) / R, th * 2.6) : add(foldEnd, scale(UP, e - 0.006 - TIE_FOLD));
    // … or out of it, straight up; flopped over once let go
    const out = add(eye, scale(UP, e));
    pts.push(lerpV(lerpV(out, folded, fold), flop(e), loose));
  }
  // the loops left it: the band hangs from the cable it lives on (a small loop round the cable, then down)
  let side = W;
  const root = o.root;
  if (hang > 0 && root) {
    const d = normalize(root.d), rr = o.cableR + th;
    const e1 = normalize(sub([0, -1, 0], scale(d, -d[1]))), e2 = cross(d, e1);
    const loop = 2 * Math.PI * rr, shift = scale(sub(root.p, eye), hang);
    for (let k = 0; k < n; k++) {
      const s = k * ds;
      let h: V3;
      if (s < loop) {
        const ph = s / rr;
        h = add(root.p, add(scale(e1, rr * Math.cos(ph)), add(scale(e2, rr * Math.sin(ph)), scale(d, 0.002 * ph))));
      } else {
        const e = s - loop, bottom = add(root.p, scale(e1, rr));
        h = add(bottom, add([0, -e, 0], scale(e2, 0.012 * Math.sin(e * 14) * Math.min(1, e / 0.03))));
      }
      pts[k] = lerpV(add(pts[k], shift), h, hang);
      pts[k][1] = Math.max(pts[k][1], o.floorY + th / 2);
    }
    side = normalize(lerpV(W, d, hang));
  }
  return { pts, tip: pts[n - 1], side };
}
