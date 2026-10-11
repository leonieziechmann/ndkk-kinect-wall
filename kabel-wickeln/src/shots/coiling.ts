// Coiling choreography: Noor winds a cable over and under into her left hand. Everything is a pure
// function of the shot time t, shared by the bake (grips, guides, capsules) and the scene (hands,
// labels, cameras):
//
//   - the left fist holds the coil: palm up, thumb wrapped over the bundle, in front of the belly,
//     the elbow out and down; every placed loop rides rigidly with it
//   - the right hand comes in to just beside the hanging cable (palm down), takes it next to the
//     left fist (thumb on top pointing back to the left hand), slides an arm's length out along it
//     through a loose fist, in the plane of the coil, closes and brings that point back into the
//     left hand, rolling the cable a little with the thumb
//   - for an "unter" loop it first turns over beside the cable (palm up, thumb pointing away from
//     the coil), takes, slides and brings the cable back like that (the loop falls over the back of
//     the hand) and turns back palm down only after letting go; the finger roll is the other way
//   - the target shape of every loop: round (Ø ~23 cm), going clockwise as the coiler sees it
//     (from the fist to her right, down, up the left side), each new loop on the coiler's side of
//     the bundle and fanning out a little toward her at the bottom. Where the cable to the floor
//     crosses the new loop it lies on top (über) or the loop covers it (unter): an "unter" loop
//     bulges forward over it, and the loop after it starts hooked behind it
//   - material coordinates (arc length from the male plug) of every strand in the fist and of the
//     point the right hand takes, so grips and guides act on the right nodes
//   - after the last loop the velcro tie on the plug end closes round the bundle just left of the
//     fist: the right hand takes its end, wraps it over the top and presses it on (tiePath gives
//     the band for the scene)
//   - Noor's rig for the outside view and a first-person variant whose left shoulder is cheated low
//     and out (the hands, and so the cable, are the same in both)
//
// Coil frame: a = the direction the cable runs through the left fist (toward the right hand),
// up = world up, n = a × up (toward the coiler's side of the coil). Seen from +n, a points right.

import { Frame, Quat, V3, add, cross, dot, length, lerp3, normalize, quatFromAxisAngle, quatFromFrame, quatFromTo, quatMul, quatRotate, quatSlerp, scale, smooth, sub } from '../sim';
import type { PersonSpec } from '../people/people';
import { HandRig, Rig, stand } from '../people/rig';

export type LoopKind = 'over' | 'under';

/** durations of the phases of one loop [s] */
export interface Pace {
  /** the right hand comes in and takes the hanging cable below the left hand (loosely) */
  take: number;
  /** "unter" only: extra time to turn the hand palm up while it comes in */
  flip: number;
  /** sliding out along the cable through the loose fist */
  slide: number;
  /** the fingers close */
  close: number;
  /** bringing the point back into the left hand */
  ret: number;
  /** both hands hold while the left one takes the new loop */
  place: number;
  /** the right hand opens and backs off; the cable to the floor drops through the new loop */
  open: number;
  /** pause before the next loop */
  hold: number;
  /**
   * true: the right hand lets go after placing the loop, so the cable to the floor drops through
   * it, and takes it again below the left hand (teaching); false: it slides on at once (everyday)
   */
  letGo: boolean;
}

/** a slow loop for teaching */
export const TEACHING: Pace = { take: 0.8, flip: 1.1, slide: 1.4, close: 0.3, ret: 1.5, place: 0.2, open: 0.5, hold: 0.8, letGo: true };
/** an everyday loop, about 2.1 s (über) or 2.4 s (unter) */
export const BRISK: Pace = { take: 0.35, flip: 0.35, slide: 0.75, close: 0.12, ret: 0.85, place: 0.1, open: 0.2, hold: 0.05, letGo: true };

export interface CoilingSpec {
  kinds: LoopKind[];
  /** one pace per loop */
  paces: Pace[];
  /** loop radii [m] (default 0.112, a little smaller after an "unter" loop) */
  radii?: number[];
  /** length of the plug end hanging below the fist [m] */
  tail?: number;
}

/** the times of one loop (absolute shot time) and where along the cable it lies */
export interface LoopBeat {
  /** 1-based loop number */
  k: number;
  kind: LoopKind;
  t0: number;
  /** the right hand is ready next to the cable, palm down; an "unter" hand then turns over until tTurned */
  tReady: number;
  tTurned: number;
  tSlide: number;
  tClose: number;
  tRet: number;
  tPlace: number;
  tOpen: number;
  tFree: number;
  t1: number;
  /** the right hand lets go after placing this loop (always after the last one) */
  letGo: boolean;
  /** the right hand takes the cable hanging below the left hand (the previous loop let go) */
  fromHanging: boolean;
  /** material coordinate where the right hand starts sliding and where it closes */
  sStart: number;
  sGrip: number;
}

export type RightMode = 'take' | 'slide' | 'close' | 'return' | 'place' | 'open' | 'hold' | 'tie';

export interface RightHand {
  mode: RightMode;
  /** index into beats of the current loop */
  loop: number;
  /** the cable in the fist: p on its axis, d3 along it (increasing material), d1 to the palm when palm down */
  cable: Frame;
  /** the hand's grip frame for the rig: the cable frame turned by the finger roll and the flip */
  hand: Frame;
  /** material coordinate in the fist */
  s: number;
  /** what holds the cable: nothing, a loose fist it slides through, or a closed fist */
  holds: 'none' | 'sleeve' | 'grip';
  /** how firmly the loose fist keeps the cable on its axis (0 … 1) */
  sleeve: number;
  open: number;
  pinch: number;
  /** 0 palm down … 1 palm up */
  flip: number;
}

/** half width of a fist along the cable [m] */
export const FIST_HALF = 0.04;
/** distance between the centres of the two fists when they meet [m] */
export const FIST_GAP = 0.095;
/** XLR cable radius [m] */
export const XLR_R = 0.0035;

const UP: V3 = [0, 1, 0];
/** coil face turned this far from facing the coiler toward her right [rad] */
const FACE = 0.61;
/** the left fist: centre of the bundle */
const L0: V3 = [-0.16, 1.0, -0.34];
/** the right hand resting at her side */
const REST: V3 = [0.25, 0.83, -0.06];
/**
 * where the right fist is when slid out, in coil coordinates (along a, up) from the bundle; its
 * depth (along n) stays that of the cable where the hand took it: in front of the coil after an
 * "über" loop, between the last two loops after an "unter" one (hooked under it), so the cable
 * the hand pulls out never has to pass a loop
 */
const OUT_X = 0.37, OUT_Y = -0.14;
/** the cable direction through the right fist when slid out, in coil coordinates */
const D_OUT: V3 = [1, -0.28, 0];
/** the plug end bends down out of the fist with this radius [m] */
const TAIL_BEND = 0.02;
/** fan of the loops toward the coiler at the bottom: tan of the tilt, first loop and per loop */
const FAN0 = 0.02, FAN = 0.045;
/** the strands lie side by side in the fist, this far apart (a little more than the cable is thick) [m] */
const SLOT = 0.0075;
/** out of the fist, loop k's strands splay toward the coiler by k times this [m] */
const SPLAY = 0.004;
/** "unter" loops bulge forward over the cable to the floor by this much [m] */
const BULGE = 0.016;
/** loops after an "unter" one: right side out, left side in (fraction of the radius) */
const LEAN = 0.14;
/** the cable to the floor: bend radius out of the fist and how far down it is guided [m] */
const FLOOR_BEND = 0.04, FLOOR_SLANT = 0.3, FLOOR_PATH = 0.45;
/**
 * the right hand takes the hanging cable this far (along it) past the left fist [m]; after an
 * "unter" loop further down, below where the cable passes under that loop's start
 */
const TAKE = 0.07, TAKE_HOOKED = 0.11;
/** finger roll during the way back [rad] */
const ROLL = 0.55;
/** the velcro tie: its eyelet sits round the plug end this far from the plug; its free tail [m] */
export const TIE_S = 0.16;
const TIE_TAIL = 0.24;
/** it is wrapped round the bundle here (coil x: where the left hand held it), band thickness [m] */
const TIE_X = -0.026, BAND_T = 0.002;
/** for the tie the left hand slides this far along the bundle toward the right hand [m] */
const TIE_SLIDE = 0.04;
/** wrap radius grows by this per turn (the second turn lies on the first) */
const TIE_GROW = 1.5 * BAND_T;
/** points along the tail for the mesh */
export const TIE_POINTS = 48;

/** the left elbow points out and down (so the forearm does not cover the coil from her right) */
const ELBOW: V3 = [-0.6, -1, 0.3];
/**
 * first person: the left shoulder much lower and the elbow below and behind the wrist, so the
 * forearm comes in diagonally from the lower left of her view and the coil hangs free of it
 */
const POV_SHOULDERS: [V3, V3] = [[-0.06, -0.16, 0.0], [0.0, -0.04, -0.03]];
const POV_ELBOW: V3 = [-0.55, -1, 0.25];

const ease = (u: number) => smooth(u);
const clamp01 = (u: number) => Math.min(1, Math.max(0, u));

/** cubic Bézier */
function bez(p0: V3, c1: V3, c2: V3, p3: V3, u: number): V3 {
  const v = 1 - u, a = v * v * v, b = 3 * u * v * v, c = 3 * u * u * v, d = u * u * u;
  return [a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0], a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1], a * p0[2] + b * c1[2] + c * c2[2] + d * p3[2]];
}

/** frame with d3 along `along` and d1 toward `toPalm` (made orthogonal) */
function frameOf(p: V3, along: V3, toPalm: V3): Frame {
  const d3 = normalize(along);
  const d1 = normalize(sub(toPalm, scale(d3, dot(toPalm, d3))));
  return { p, q: quatFromFrame(d1, cross(d3, d1), d3) };
}

/** the frame q turned in its own coordinates: first about d2 by flip, then about d3 by roll */
function turned(q: Quat, roll: number, flip: number): Quat {
  return quatMul(q, quatMul(quatFromAxisAngle(0, 0, 1, roll), quatFromAxisAngle(0, 1, 0, flip)));
}

/** the target shape of one loop, by material coordinate */
interface LoopShape {
  k: number;
  kind: LoopKind;
  R: number;
  /** material coordinates of the strand centres in the fist where the loop starts and ends */
  s0: number;
  s1: number;
  /** dense polyline of the target from s0 to s1 and its arc length (from s0) */
  pts: V3[];
  cum: number[];
}

/** where the tie closes round the bundle (see Coiling.tieGeom) */
export interface TieGeom {
  /** the eyelet on the plug end */
  attach: V3;
  /** bundle centre and direction where the tail wraps round it; e1 toward the coiler, e2 = axis × e1 (up) */
  centre: V3;
  axis: V3;
  e1: V3;
  e2: V3;
  /** bundle radius and the angle (in e1, e2) where the tail meets it; the wrap ends at thEnd */
  r: number;
  th0: number;
  thEnd: number;
  /** straight piece from the eyelet to the bundle */
  reach: number;
}

export class Coiling {
  readonly kinds: LoopKind[];
  readonly beats: LoopBeat[];
  readonly a: V3;
  readonly n: V3;
  readonly up: V3 = UP;
  /** centre of the bundle in the left fist (fixed: the coil hangs from it) */
  readonly L: V3 = L0;
  /** length of the plug end below the fist */
  readonly tail: number;
  /** material coordinate of strand j's centre in the fist (j = 0: the plug end's strand) */
  readonly sP: number[];
  /** end of the last loop */
  readonly tEnd: number;
  /** closing the tie after the last loop: reach for its end, lift it, wrap it (held, then by itself), press, away */
  readonly tie: { t0: number; tPinch: number; tLift: number; tRelease: number; tWrapped: number; tPress: number; tAway: number };
  private readonly shapes: LoopShape[];
  private tieG: TieGeom | null = null;

  constructor(spec: CoilingSpec) {
    const N = spec.kinds.length;
    this.kinds = spec.kinds;
    this.a = [Math.cos(FACE), 0, -Math.sin(FACE)];
    this.n = cross(this.a, UP);
    this.tail = spec.tail ?? 0.2;
    const radii = spec.radii ?? spec.kinds.map((_, i) => (i > 0 && spec.kinds[i - 1] === 'under' ? 0.108 : 0.112));

    // material: the plug end, its bend into the fist, the first strand's centre
    this.sP = [this.tail + (Math.PI / 2) * TAIL_BEND + FIST_HALF];
    this.shapes = [];
    for (let k = 1; k <= N; k++) {
      const shape = this.buildShape(k, radii[k - 1], this.sP[k - 1]);
      this.shapes.push(shape);
      this.sP.push(shape.s1);
    }

    let t = 0;
    this.beats = spec.kinds.map((kind, i) => {
      const p = spec.paces[i];
      const t0 = t;
      const tReady = t0 + 0.75 * p.take;
      const tTurned = tReady + (kind === 'under' ? p.flip : 0);
      const tSlide = tTurned + 0.25 * p.take;
      const tClose = tSlide + p.slide;
      const tRet = tClose + p.close;
      const tPlace = tRet + p.ret;
      const tOpen = tPlace + p.place;
      const tFree = tOpen + p.open;
      t = tFree + p.hold;
      const fromHanging = i === 0 || spec.paces[i - 1].letGo;
      return {
        k: i + 1, kind, t0, tReady, tTurned, tSlide, tClose, tRet, tPlace, tOpen, tFree, t1: t, letGo: p.letGo || i === N - 1, fromHanging,
        sStart: this.sP[i] + (fromHanging ? FIST_HALF + (i > 0 && spec.kinds[i - 1] === 'under' ? TAKE_HOOKED : TAKE) : FIST_GAP), sGrip: this.sP[i + 1] + FIST_GAP,
      };
    });
    this.tEnd = t;
    const t0 = t + 0.3, tPinch = t0 + 0.8, tLift = tPinch + 0.5, tRelease = tLift + 1.0, tWrapped = tRelease + 0.5, tPress = tWrapped + 0.45;
    this.tie = { t0, tPinch, tLift, tRelease, tWrapped, tPress, tAway: tPress + 0.75 };
  }

  // ---------------------------------------------------------------- geometry

  /** a point given in coil coordinates (along a, up, n) relative to the bundle centre */
  at(x: number, y: number, z: number): V3 {
    const { L, a, n } = this;
    return [L[0] + a[0] * x + n[0] * z, L[1] + y, L[2] + a[2] * x + n[2] * z];
  }

  /** a direction given in coil coordinates (along a, up, n) */
  cv(x: number, y: number, z: number): V3 {
    const { a, n } = this;
    return [a[0] * x + n[0] * z, y, a[2] * x + n[2] * z];
  }

  /** the cable direction through the right fist when slid out */
  private get dOut(): V3 {
    return normalize(this.cv(D_OUT[0], D_OUT[1], D_OUT[2]));
  }

  /** coil coordinates of a world point: along a, up, n relative to the bundle centre */
  local(p: V3): V3 {
    const d = sub(p, this.L);
    return [dot(d, this.a), d[1], dot(d, this.n)];
  }

  /** strand j in the fist, in coil coordinates (y, z): side by side across the palm, each new one nearer the coiler */
  slot(j: number): [number, number] {
    return [0, SLOT * (j - 3)];
  }

  /** centre of strand j in the fist */
  strand(j: number): V3 {
    const [y, z] = this.slot(j);
    return this.at(0, y, z);
  }

  /**
   * Point of loop k (1-based) at the loop angle phi (from the top, clockwise as the coiler sees it;
   * the loop leaves the fist at phiA and enters it again at 2π - phiA), with depth (along n)
   * built in. Also used for the guide targets.
   */
  loopPoint(k: number, phi: number): V3 {
    const sh = this.shapes[k - 1];
    const R = sh.R;
    const phiA = Math.asin(FIST_HALF / R);
    const u = clamp01((phi - phiA) / (2 * Math.PI - 2 * phiA));
    const y0 = this.slot(k - 1)[0], y1 = this.slot(k)[0];
    // loops after an "unter" one lean: right side out, left side in (zero near the fist), so the
    // start, hooked behind the "unter" loop, parts from it and can come forward
    const lean = k > 1 && this.kinds[k - 2] === 'under' ? (LEAN * Math.sin(phi) * (1 - Math.cos(phi))) / 2 : 0;
    const r = R * (1 + lean);
    const x = r * Math.sin(phi);
    const y = y0 + (y1 - y0) * u + r * Math.cos(phi) - R * Math.cos(phiA);
    return this.at(x, y, this.loopDepth(k, phi));
  }

  /** depth of loop k: the strands' depth, splayed out of the fist, the fan, the "unter" bulge */
  private loopDepth(k: number, phi: number) {
    const R = this.shapes[k - 1].R;
    const phiA = Math.asin(FIST_HALF / R);
    const u = clamp01((phi - phiA) / (2 * Math.PI - 2 * phiA));
    const z0 = this.slot(k - 1)[1], z1 = this.slot(k)[1];
    const drop = R * (Math.cos(phiA) - Math.cos(phi));
    // out of the fist the strands splay apart (the newer, the nearer the coiler) and fan out below
    const out = smooth(phi / 0.35) * smooth((2 * Math.PI - phi) / 0.35);
    let z = z0 + (z1 - z0) * u + SPLAY * k * out + Math.max(0, drop) * (FAN0 + FAN * (k - 1));
    // "unter": forward over the cable to the floor, from just outside the fist (where its start has
    // dropped below the new strand running on to the right hand) to past the bottom
    if (this.kinds[k - 1] === 'under') z += BULGE * smooth((phi - phiA) / 0.4) * (1 - smooth((phi - 2.6) / 0.8));
    return z;
  }

  /** depth of loop k at the angle of a world point seen around the loop's centre, and that angle */
  depthNear(k: number, p: V3): { phi: number; r: number; depth: number } {
    const sh = this.shapes[k - 1];
    const R = sh.R;
    const phiA = Math.asin(FIST_HALF / R);
    const [x, y] = this.local(p);
    const cy = -R * Math.cos(phiA);
    let phi = Math.atan2(x, y - cy);
    if (phi < 0) phi += 2 * Math.PI;
    const q = this.loopPoint(k, Math.min(2 * Math.PI - phiA, Math.max(phiA, phi)));
    return { phi, r: Math.hypot(x, y - cy), depth: this.local(q)[2] };
  }

  /** centre of loop k (in the fist plane) */
  loopCentre(k: number): V3 {
    const R = this.shapes[k - 1].R;
    return this.at(0, -R * Math.cos(Math.asin(FIST_HALF / R)), (this.slot(k - 1)[1] + this.slot(k)[1]) / 2);
  }

  radius(k: number) {
    return this.shapes[k - 1].R;
  }

  private buildShape(k: number, R: number, s0: number): LoopShape {
    const sh: LoopShape = { k, kind: this.kinds[k - 1], R, s0, s1: s0, pts: [], cum: [] };
    this.shapes[k - 1] = sh;
    const phiA = Math.asin(FIST_HALF / R);
    const pts: V3[] = [this.strand(k - 1)];
    const M = 480;
    for (let i = 0; i <= M; i++) pts.push(this.loopPoint(k, phiA + ((2 * Math.PI - 2 * phiA) * i) / M));
    pts.push(this.strand(k));
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + length(sub(pts[i], pts[i - 1])));
    sh.pts = pts;
    sh.cum = cum;
    sh.s1 = s0 + cum[cum.length - 1];
    return sh;
  }

  /**
   * Target of the material point s while loop k is laid: on the loop, or (past its end) straight
   * on along a toward the right fist. null before the loop.
   */
  loopTarget(k: number, s: number): V3 | null {
    const sh = this.shapes[k - 1];
    if (s < sh.s0) return null;
    if (s >= sh.s1) return add(this.strand(k), scale(this.a, s - sh.s1));
    const d = s - sh.s0, cum = sh.cum;
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (cum[m] <= d) lo = m;
      else hi = m;
    }
    const u = (d - cum[lo]) / Math.max(1e-9, cum[hi] - cum[lo]);
    return lerp3(sh.pts[lo], sh.pts[hi], u);
  }

  /** the plug end: from the plug (s = 0) hanging straight down, bending into strand 0 of the fist */
  tailPoint(s: number): V3 {
    const [y0, z0] = this.slot(0);
    const x0 = -FIST_HALF - TAIL_BEND;
    const bendS = this.tail;
    if (s <= bendS) return this.at(x0, y0 - TAIL_BEND - (bendS - s), z0);
    const ang = (s - bendS) / TAIL_BEND;
    if (ang <= Math.PI / 2) return this.at(x0 + TAIL_BEND * (1 - Math.cos(ang)), y0 - TAIL_BEND + TAIL_BEND * Math.sin(ang), z0);
    return this.at(-FIST_HALF + (s - bendS - (Math.PI / 2) * TAIL_BEND), y0, z0);
  }

  /**
   * Where the cable to the floor hangs after loop k is placed, for the material point s past the
   * fist (null beyond FLOOR_PATH): out of the fist, bending down and hanging a little inward
   * through the new loop, so it crosses the loop's right side just below the left hand and its
   * bottom at a clear angle. Depth: strand k's (the shot sets it at the crossings).
   */
  floorTarget(k: number, s: number): V3 | null {
    const d = s - this.sP[k] - FIST_HALF;
    if (d > FLOOR_PATH) return null;
    const [y0, z0] = this.slot(k);
    if (d <= 0) return this.at(FIST_HALF + d, y0, z0);
    // splayed out of the fist like the start of a next loop would be
    const z = z0 + SPLAY * (k + 0.8) * smooth(d / 0.04);
    // the bend turns the cable from along a to down and on a little inward: it hangs toward the
    // middle under the coil and crosses the bottom of the new loop at a clear angle
    const turn = Math.PI / 2 + FLOOR_SLANT;
    const bend = turn * FLOOR_BEND;
    if (d <= bend) {
      const ang = d / FLOOR_BEND;
      return this.at(FIST_HALF + FLOOR_BEND * Math.sin(ang), y0 - FLOOR_BEND * (1 - Math.cos(ang)), z);
    }
    const e = d - bend;
    return this.at(FIST_HALF + FLOOR_BEND * Math.sin(turn) - e * Math.sin(FLOOR_SLANT), y0 - FLOOR_BEND * (1 - Math.cos(turn)) - e * Math.cos(FLOOR_SLANT), z);
  }

  // ---------------------------------------------------------------- the velcro tie

  /**
   * The bundle where the tie closes: where the left hand held it (the strands lie compact and
   * straight there; the hand has slid a little toward the right hand to make room). The tail comes
   * up from the eyelet on the plug end below and wraps round it toward the coiler, over the top,
   * behind and under, about once.
   */
  tieGeom(): TieGeom {
    if (this.tieG) return this.tieG;
    const N = this.kinds.length;
    let r = 0;
    for (let j = 0; j <= N; j++) r = Math.max(r, Math.hypot(...this.slot(j)));
    r += XLR_R + 0.0015;
    const centre = this.at(TIE_X, 0, 0);
    const axis = this.a, e1 = this.n, e2 = UP;
    const attach = this.tailPoint(TIE_S);
    const d = sub(attach, centre);
    let th0 = Math.atan2(dot(d, e2), dot(d, e1));
    // the wrap runs toward the coiler first (increasing angle from below)
    if (th0 > 0) th0 -= 2 * Math.PI;
    const g: TieGeom = { attach, centre, axis, e1, e2, r, th0, thEnd: th0, reach: 0 };
    g.reach = length(sub(attach, this.tieRing(g, th0)));
    const c = TIE_GROW / (4 * Math.PI);
    const rest = TIE_TAIL - g.reach;
    g.thEnd = th0 + (-r + Math.sqrt(r * r + 4 * c * rest)) / (2 * c);
    this.tieG = g;
    return g;
  }

  /** the point of the wrap at angle th (on the spiral) */
  private tieRing(g: TieGeom, th: number): V3 {
    const R = g.r + (TIE_GROW * (th - g.th0)) / (2 * Math.PI);
    return add(g.centre, add(scale(g.e1, R * Math.cos(th)), scale(g.e2, R * Math.sin(th))));
  }

  /** arc length of the wrap from th0 to th */
  private tieArc(g: TieGeom, th: number) {
    const x = th - g.th0;
    return g.r * x + (TIE_GROW / (4 * Math.PI)) * x * x;
  }

  /** the tail at arc length sg (from the eyelet), wrapped up to the angle th; the rest straight on */
  private tieAt(g: TieGeom, sg: number, th: number): V3 {
    if (sg <= g.reach) return lerp3(g.attach, this.tieRing(g, g.th0), sg / g.reach);
    const s2 = sg - g.reach, arc = this.tieArc(g, th);
    if (s2 <= arc) {
      const c = TIE_GROW / (4 * Math.PI);
      return this.tieRing(g, g.th0 + (-g.r + Math.sqrt(g.r * g.r + 4 * c * s2)) / (2 * c));
    }
    const tan = add(scale(g.e1, -Math.sin(th)), scale(g.e2, Math.cos(th)));
    return add(this.tieRing(g, th), scale(tan, s2 - arc));
  }

  /** the hanging tail at arc length sg: down along the plug end, leaning slowly toward the coiler */
  private tieHanging(g: TieGeom, sg: number): V3 {
    const off = XLR_R + 0.002 + 0.03 * (sg / TIE_TAIL) ** 2;
    return add(add(g.attach, scale(UP, -sg)), scale(this.n, off));
  }

  /** how far the tie is closed at t: lift 0 (hanging) … 1 (up at the bundle), wrap angle */
  tieState(t: number): { lift: number; th: number } {
    const g = this.tieGeom(), T = this.tie;
    const lift = ease((t - T.tPinch) / (T.tLift - T.tPinch));
    // held: from the start round the front and over the top to behind; then it wraps on by itself
    const thHeld = Math.min(g.th0 + Math.PI + 0.9, g.thEnd - 0.8);
    const th = t < T.tRelease ? g.th0 + (thHeld - g.th0) * ease((t - T.tLift) / (T.tRelease - T.tLift)) : thHeld + (g.thEnd - thHeld) * ease((t - T.tRelease) / (T.tWrapped - T.tRelease));
    return { lift, th };
  }

  /** the tail of the tie at t as TIE_POINTS points (xyz) from the eyelet to its end */
  tiePath(t: number, out: Float32Array) {
    const g = this.tieGeom();
    const { lift, th } = this.tieState(t);
    for (let j = 0; j < TIE_POINTS; j++) {
      const sg = (TIE_TAIL * j) / (TIE_POINTS - 1);
      const p = lift < 1 ? lerp3(this.tieHanging(g, sg), this.tieAt(g, sg, th), lift) : this.tieAt(g, sg, th);
      out[3 * j] = p[0];
      out[3 * j + 1] = p[1];
      out[3 * j + 2] = p[2];
    }
  }

  /** the end of the tail and its direction at t */
  private tieEnd(t: number): { p: V3; d: V3 } {
    const g = this.tieGeom();
    const { lift, th } = this.tieState(t);
    const at = (sg: number) => (lift < 1 ? lerp3(this.tieHanging(g, sg), this.tieAt(g, sg, th), lift) : this.tieAt(g, sg, th));
    const p = at(TIE_TAIL);
    return { p, d: normalize(sub(p, at(TIE_TAIL - 0.01))) };
  }

  /** the right hand while it closes the tie: reaches for the end, holds it while wrapping, presses it on */
  private rightTie(t: number): RightHand {
    const T = this.tie, g = this.tieGeom();
    const base = { loop: this.beats.length - 1, s: 0, holds: 'none' as const, sleeve: 0, pinch: 0, flip: 0, mode: 'tie' as const };
    // the hand holds the band's end in a loose fist, the band running out of it toward the bundle
    const holding = (tt: number): Frame => {
      const e = this.tieEnd(tt);
      return frameOf(e.p, scale(e.d, -1), add(scale(g.axis, -0.6), scale(UP, 0.4)));
    };
    const rest = this.awayFrame(this.beats.length);
    const press = g.thEnd - 0.25;
    const pressFrame = frameOf(add(this.tieRing(g, press), scale(add(scale(g.e1, Math.cos(press)), scale(g.e2, Math.sin(press))), 0.012)), add(scale(g.e1, -Math.sin(press)), scale(g.e2, Math.cos(press))), add(scale(g.e1, -Math.cos(press)), scale(g.e2, -Math.sin(press))));
    if (t < T.tPinch) {
      const u = ease((t - T.t0) / (T.tPinch - T.t0));
      const to = holding(T.tPinch);
      const hand = { p: bez(rest.p, add(rest.p, [0, 0.08, -0.05]), add(to.p, [0.05, -0.04, 0.05]), to.p, u), q: quatSlerp(rest.q, to.q, u) };
      return { ...base, cable: hand, hand, open: 1 - 0.65 * u };
    }
    if (t < T.tRelease) return { ...base, cable: holding(t), hand: holding(t), open: 0.35 };
    if (t < T.tPress) {
      // lets go behind the bundle and comes over the top to where the end will lie, and presses it on
      const u = ease((t - T.tRelease) / (T.tWrapped - T.tRelease));
      const from = holding(T.tRelease);
      const p = bez(from.p, add(from.p, scale(UP, 0.05)), add(pressFrame.p, add(scale(UP, 0.05), scale(this.n, 0.03))), pressFrame.p, u);
      const hand = { p, q: quatSlerp(from.q, pressFrame.q, u) };
      return { ...base, cable: hand, hand, open: 0.35 + 0.4 * Math.sin(Math.PI * Math.min(1, u)) };
    }
    const u = ease((t - T.tPress) / (T.tAway - T.tPress));
    const hand = { p: bez(pressFrame.p, add(pressFrame.p, add(scale(this.n, 0.06), scale(UP, 0.03))), add(rest.p, [0.04, 0.08, -0.04]), rest.p, u), q: quatSlerp(pressFrame.q, rest.q, u) };
    return { ...base, cable: hand, hand, open: 0.6 };
  }

  // ---------------------------------------------------------------- the left hand

  /** the left fist's frame for the simulation: fixed, the coil hangs from it */
  leftFrame(): Frame {
    return frameOf(this.L, this.a, add(scale(UP, -1), scale(this.n, -0.3)));
  }

  /** placed strands at time t (1 = only the plug end's) */
  strandsAt(t: number) {
    let m = 1;
    for (const b of this.beats) if (t >= b.tPlace) m++;
    return m;
  }

  /** the left hand's grip for the rig: around the strands it holds (the bundle grows toward the coiler) */
  leftHand(t: number): HandRig {
    // the bundle centre and size follow the placed strands, eased over the placement
    let cy = 0, cz = 0, wsum = 0;
    const w = [1, ...this.beats.map((b) => smooth((t - b.tPlace) / 0.25))];
    w.forEach((x, j) => { cy += x * this.slot(j)[0]; cz += x * this.slot(j)[1]; wsum += x; });
    cy /= wsum; cz /= wsum;
    let r = 0;
    w.forEach((x, j) => (r = Math.max(r, x * Math.hypot(this.slot(j)[0] - cy, this.slot(j)[1] - cz))));
    // for the tie the hand slides a little along the bundle, toward the right hand
    const slide = TIE_SLIDE * ease((t - this.tie.t0) / 0.6);
    const f = frameOf(this.at(slide, cy, cz), this.a, add(scale(UP, -1), scale(this.n, -0.3)));
    return { grip: f, radius: XLR_R + r, thumbAlong: -1, wrap: 1 };
  }

  // ---------------------------------------------------------------- the right hand

  /** where the right fist takes the hanging cable for loop k (below the fist, on the cable to the floor) */
  private takePos(k: number): V3 {
    const b = this.beats[k - 1];
    return b.fromHanging ? (this.floorTarget(k - 1, b.sStart) as V3) : this.placePos(k - 1);
  }

  /** direction of the hanging cable where the right hand takes it for loop k */
  private takeDir(k: number): V3 {
    const s = this.beats[k - 1].sStart;
    return normalize(sub(this.floorTarget(k - 1, s + 0.005) as V3, this.floorTarget(k - 1, s - 0.005) as V3));
  }

  /** where the right fist lays the point of loop k into the left hand: right next to it */
  private placePos(k: number): V3 {
    return add(this.strand(k), scale(this.a, FIST_GAP));
  }

  /**
   * Where the open right hand waits after letting go of loop k (k = 0: before the first loop): at
   * her side after a slow loop (the view on the new loop is free), just next to the coil after an
   * everyday one.
   */
  private awayFrame(k: number): Frame {
    const b = this.beats[k - 1];
    if (k === 0 || b.t1 - b.tFree > 0.3 || k === this.beats.length) return frameOf(REST, [0.15, -1, -0.2], [1, 0, 0.3]);
    return { p: add(add(this.placePos(k), scale(this.n, 0.07)), [0.03, -0.08, 0]), q: this.rightFrame(this.placePos(k), this.a).q };
  }

  private outPos(k: number): V3 {
    // a little variation from loop to loop
    const w = Math.sin(k * 2.39) * 0.012;
    return this.at(OUT_X + w, OUT_Y + 0.6 * w, this.local(this.takePos(k))[2]);
  }

  /**
   * Cable frame of the right fist for a cable running along `along`: the thumb lies on it pointing
   * back toward the left hand, so the palm faces down on a level cable and toward the left hand on
   * a hanging one; the fingers point away from the coiler.
   */
  private rightFrame(p: V3, along: V3): Frame {
    const hanging = smooth((-along[1] - 0.3) / 0.5);
    return frameOf(p, along, add(add(scale(UP, 1 - hanging), scale(this.a, hanging)), scale(this.n, 0.25)));
  }

  /** the beat that is running at t (the last one after the end) */
  beatAt(t: number): number {
    for (let i = 0; i < this.beats.length; i++) if (t < this.beats[i].t1) return i;
    return this.beats.length - 1;
  }

  right(t: number): RightHand {
    if (t >= this.tie.t0) return this.rightTie(t);
    const a = this.a;
    const i = this.beatAt(t);
    const b = this.beats[i];
    const k = b.k;
    const sgn = b.kind === 'over' ? 1 : -1;
    const pTake = this.takePos(k), pOut = this.outPos(k), pPlace = this.placePos(k);
    const loose = 0.35;
    const base = { loop: i, pinch: 0 };
    const flipped = b.kind === 'under' ? 1 : 0;

    if (t < b.tSlide) {
      if (!b.fromHanging) {
        // still holding loosely next to the left fist; "unter": the hand turns over around the cable
        const cable = this.rightFrame(pTake, a);
        const f = flipped * ease((t - b.t0) / (b.tSlide - b.t0));
        const lift = Math.sin(Math.PI * f);
        const hand = { p: add(pTake, add(scale(this.n, 0.025 * lift), scale(UP, 0.01 * lift))), q: turned(cable.q, 0, Math.PI * f) };
        return { ...base, mode: 'take', cable, hand, s: b.sStart, holds: 'sleeve', sleeve: 1, open: loose + 0.5 * lift, flip: f };
      }
      // in from where it waited to just above the hanging cable (palm down); "unter": there the hand
      // turns over (palm up, thumb pointing away); then it takes the cable loosely
      const from = this.awayFrame(k - 1);
      const cable = this.rightFrame(pTake, this.takeDir(k));
      // ready: a little right of the take point, where the hand is seen in both views as it turns
      const ready = add(pTake, add(add(scale(this.a, 0.085), scale(this.n, 0.03)), [0, 0.02, 0]));
      if (t < b.tReady) {
        const e = ease((t - b.t0) / (b.tReady - b.t0));
        const p0 = from.p;
        const p = bez(p0, add(p0, [0, 0.06, -0.04]), add(ready, [0.06, -0.02, 0.04]), ready, e);
        return { ...base, mode: 'take', cable: { p, q: cable.q }, hand: { p, q: quatSlerp(from.q, cable.q, e) }, s: b.sStart, holds: 'none', sleeve: 0, open: 0.6, flip: 0 };
      }
      if (t < b.tTurned) {
        const u = (t - b.tReady) / (b.tTurned - b.tReady);
        const f = ease(u);
        const p = add(ready, scale(UP, 0.015 * Math.sin(Math.PI * u)));
        return { ...base, mode: 'take', cable: { p, q: cable.q }, hand: { p, q: turned(cable.q, 0, Math.PI * f) }, s: b.sStart, holds: 'none', sleeve: 0, open: 0.6 + 0.3 * Math.sin(Math.PI * u), flip: f };
      }
      const u = (t - b.tTurned) / (b.tSlide - b.tTurned);
      const e = ease(u);
      const p = lerp3(ready, pTake, e);
      return { ...base, mode: 'take', cable: { p, q: cable.q }, hand: { p, q: turned(cable.q, 0, Math.PI * flipped) }, s: b.sStart, holds: u > 0.35 ? 'sleeve' : 'none', sleeve: smooth((u - 0.35) / 0.65), open: 0.6 - (0.6 - loose) * e, flip: flipped };
    }
    if (t < b.tClose) {
      const u = ease((t - b.tSlide) / (b.tClose - b.tSlide));
      const c1 = add(pTake, b.fromHanging ? this.cv(0.06, -0.06, 0) : this.cv(0.12, 0, 0)), c2 = add(pOut, this.cv(-0.12, -0.02, 0));
      const p = bez(pTake, c1, c2, pOut, u);
      // the cable runs through the fist as fast as the hand moves along it; what the U needs on top
      // is fed once the hands are apart, so the cable between them sags instead of buckling
      let along = 0, total = 0;
      for (let j = 1; j <= 24; j++) {
        const l = length(sub(bez(pTake, c1, c2, pOut, j / 24), bez(pTake, c1, c2, pOut, (j - 1) / 24)));
        total += l;
        if (j / 24 <= u) along += l;
        else if ((j - 1) / 24 < u) along += l * (u * 24 - (j - 1));
      }
      // (hooked under the last loop right at the fist, the U is given its slack from the start)
      const hooked = k > 1 && this.kinds[k - 2] === 'under';
      const sNow = b.sStart + along + Math.max(0, b.sGrip - b.sStart - total) * (hooked ? smooth((u - 0.15) / 0.7) : smooth((u - 0.25) / 0.75));
      // from the hanging cable the fist turns level only once it is out to the side
      const cable = this.rightFrame(p, b.fromHanging ? turnToward(this.takeDir(k), this.dOut, smooth((u - 0.25) / 0.65)) : turnToward(a, this.dOut, u));
      return { ...base, mode: 'slide', cable, hand: { p, q: turned(cable.q, 0, Math.PI * flipped) }, s: sNow, holds: 'sleeve', sleeve: 1, open: loose, flip: flipped };
    }
    if (t < b.tRet) {
      const u = (t - b.tClose) / (b.tRet - b.tClose);
      const cable = this.rightFrame(pOut, this.dOut);
      return { ...base, mode: 'close', cable, hand: { p: pOut, q: turned(cable.q, 0, Math.PI * flipped) }, s: b.sGrip, holds: 'grip', sleeve: 0, open: loose * (1 - ease(u)), flip: flipped };
    }
    if (t < b.tPlace) {
      // back up to the left hand, rolling the cable a little with the thumb. "unter" stays turned
      // (palm up) while it holds the cable: the loop falls over the back of the hand
      const u = (t - b.tRet) / (b.tPlace - b.tRet);
      const e = ease(u);
      const p = bez(pOut, add(pOut, this.cv(-0.05, 0.1, 0.03)), add(pPlace, this.cv(0.1, 0.035, 0.03)), pPlace, e);
      const cable = this.rightFrame(p, turnToward(this.dOut, a, e));
      const roll = sgn * ROLL * Math.sin(Math.PI * Math.min(1, u * 1.1));
      return { ...base, mode: 'return', cable, hand: { p, q: turned(cable.q, roll, Math.PI * flipped) }, s: b.sGrip, holds: 'grip', sleeve: 0, open: 0, flip: flipped };
    }
    const cable = this.rightFrame(pPlace, a);
    const held = { p: pPlace, q: turned(cable.q, 0, Math.PI * flipped) };
    if (t < b.tOpen) return { ...base, mode: 'place', cable, hand: held, s: b.sGrip, holds: 'grip', sleeve: 0, open: 0, flip: flipped };
    if (!b.letGo) {
      // everyday pace without letting go: the fingers loosen and the next loop starts from here
      const u = ease((t - b.tOpen) / (b.tFree - b.tOpen));
      return { ...base, mode: t < b.tFree ? 'open' : 'hold', cable, hand: held, s: b.sGrip, holds: 'sleeve', sleeve: u, open: loose * u, flip: flipped };
    }
    // let go and back off (an "unter" hand turns back palm down on the way): the cable to the floor
    // drops through the new loop
    const u = ease((t - b.tOpen) / (b.tFree - b.tOpen));
    const to = this.awayFrame(k);
    const hand = { p: bez(pPlace, add(pPlace, [0.04, -0.02, 0.05]), add(to.p, [0.02, 0.08, -0.04]), to.p, u), q: quatSlerp(held.q, to.q, u) };
    return { ...base, mode: t < b.tFree ? 'open' : 'hold', cable: hand, hand, s: b.sGrip, holds: 'none', sleeve: 0, open: Math.min(1, 1.6 * u) - 0.4 * smooth((u - 0.6) / 0.4), flip: flipped * (1 - u) };
  }

  // ---------------------------------------------------------------- Noor

  /** where she looks: the coil */
  lookAt(): V3 {
    return this.at(0.04, -0.11, 0);
  }

  /**
   * Noor's rig at t. pov: the first-person variant: the left shoulder lower and further out, so
   * the left forearm hides less of the coil, the right one a little forward; the hands are the same.
   */
  rig(spec: PersonSpec, t: number, pov = false, rightGrip?: Frame): Rig {
    const r = this.right(t);
    const right: HandRig = { grip: rightGrip ?? r.hand, radius: XLR_R, thumbAlong: -1, open: r.open, pinch: r.pinch };
    return {
      ...stand(spec, [0, 0], 0, { width: 0.3 }),
      lean: 0.08,
      look: this.lookAt(),
      hands: [{ ...this.leftHand(t), elbow: pov ? POV_ELBOW : ELBOW }, right],
      shoulders: pov ? POV_SHOULDERS : undefined,
    };
  }
}

/** the unit vector a turned toward b by the fraction u of the angle between them */
function turnToward(a: V3, b: V3, u: number): V3 {
  return quatRotate(quatSlerp([0, 0, 0, 1], quatFromTo(normalize(a), normalize(b)), u), a);
}
