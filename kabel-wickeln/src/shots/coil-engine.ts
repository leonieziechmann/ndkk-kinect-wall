// The coiling engine: Noor's arms (people/rig.ts, stateful IK) drive the cable simulation (sim/
// grips.ts: a pinch in the right hand, the coil as a bundle in the left fist), frame by frame during
// the bake, and the controller reads the cable as it goes (sim in the loop): the right hand's
// pinch stays on the cable and slides along it, it holds as soon as a loop length of cable has
// passed, the strand it lays into the left fist is taken by the bundle where it really lies, and
// every grip frame the simulation uses is the frame the arm really reached. The arms' angles and
// the hand shapes go into the bake (vectors), so the scene shows exactly what the simulation saw
// (CoilReplay).
//
// What is physical and what is guided (KONZEPT "Pseudo-Simulation"): the cable, its weight, the
// hands and the forearms (capsules) are simulated; the pinch rolls the cable with the hand (the
// under loop's turn-over and the thumb's roll go into the cable). Two soft guides help the loop
// into the fist: the strand past the thumb tip is laid along the fist, and the free part of the
// loop is led towards a round arc below its two ends, both fading in over more than half a second
// with targets that move at most 0.4 m/s, so nothing snaps. The crossing of the cable to the floor
// (over / under) is left to the hands.
//
// Reusable: a CoilPlan (kinds, paces) makes any coiling shot (stage 1: s1-coil.ts; stage 3 later
// with slower paces and more pauses). The choreography is described in coiling.ts.

import { ARM_JOINTS, ArmAngles, projectToLimits } from '../people/ik';
import { handColliders } from '../people/colliders';
import { NOOR } from '../people/cast';
import { J } from '../people/people';
import type { PersonSpec, Pose } from '../people/people';
import { HandRig, Rig, RigIK, gripFrame, rigPose, stand, turnWithForearm } from '../people/rig';
import { quatAxisAngle, quatMul } from '../people/math';
import {
  BakedRod, Bundle, Capsule, Frame, Pinch, Quat, Rod, V3, VectorTrack, buildCable, frameTrack, normalize, quatRotate, quatSlerp, twistTurns, writhe,
  XLR,
} from '../sim';
import { CoilPlan, GEOM, LoopBeat, LOOSEN, beats, loopAt } from './coiling';
import type { ShotBuild } from './types';

const DT = 1 / 60;
const UP: V3 = [0, 1, 0];
const RC = XLR.od / 2;
/** COIL_TRACE=n: log the pinch every n frames (bake log) */
const TRACE = Number((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.COIL_TRACE ?? 0);

// ------------------------------------------------------------------ small vector helpers

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const madd = (a: V3, b: V3, s: number): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossV = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lenV = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const lerpV = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** minimum-jerk ease: the smooth way hands move from rest to rest */
export const minJerk = (u: number) => {
  const x = clamp01(u);
  return x * x * x * (10 - 15 * x + 6 * x * x);
};
const ramp = (t: number, a: number, b: number) => minJerk((t - a) / Math.max(1e-6, b - a));
const across = (v: V3, d: V3): V3 => normalize(madd(v, d, -dot(v, d)));
const nodeOf = (rod: Rod, i: number): V3 => [rod.x[3 * i], rod.x[3 * i + 1], rod.x[3 * i + 2]];
/** a quadratic Bézier from a over c to b */
const bez = (a: V3, c: V3, b: V3, u: number): V3 => lerpV(lerpV(a, c, u), lerpV(c, b, u), u);

/**
 * A round arc of length len hanging below the chord from p0 to p1 (2D: x across, y up): the major
 * arc of a circle when the ends are close (a loop), the minor one when they are far apart (a sag),
 * a straight line when the cable is too short. Returns the point at arc fraction u (0 at p0).
 */
export function hangingArc(p0: [number, number], p1: [number, number], len: number): (u: number) => [number, number] {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], c = Math.hypot(dx, dy);
  if (len <= c + 1e-6) return (u) => [p0[0] + dx * u, p0[1] + dy * u];
  // the side the arc hangs to: down (across the chord), towards -x when the chord is vertical
  let nx = 0, ny = -1;
  if (c > 1e-6) {
    nx = dy / c; ny = -dx / c;
    if (ny > 0 || (Math.abs(ny) < 1e-9 && nx > 0)) { nx = -nx; ny = -ny; }
  }
  let R: number, sign: number;
  if (c < 1e-6) {
    R = len / (2 * Math.PI);
    sign = 1;
  } else if (len >= (Math.PI * c) / 2) {
    // major arc: len = R (2π − 2 asin(c / 2R))
    let lo = c / 2, hi = len / Math.PI;
    for (let k = 0; k < 40; k++) {
      const r = (lo + hi) / 2;
      if (r * (2 * Math.PI - 2 * Math.asin(Math.min(1, c / (2 * r)))) > len) hi = r; else lo = r;
    }
    R = (lo + hi) / 2;
    sign = 1;
  } else {
    // minor arc: len = 2 R asin(c / 2R)
    let lo = c / 2, hi = c * 1e3;
    for (let k = 0; k < 60; k++) {
      const r = Math.sqrt(lo * hi);
      if (2 * r * Math.asin(Math.min(1, c / (2 * r))) > len) lo = r; else hi = r;
    }
    R = Math.sqrt(lo * hi);
    sign = -1;
  }
  const h = Math.sqrt(Math.max(0, R * R - (c * c) / 4));
  const cx = (p0[0] + p1[0]) / 2 + sign * nx * h, cy = (p0[1] + p1[1]) / 2 + sign * ny * h;
  const th0 = Math.atan2(p0[1] - cy, p0[0] - cx);
  // sweep through the lowest point (centre + n R)
  const ax = p0[0] - cx, ay = p0[1] - cy;
  const cr = ax * ny * R - ay * nx * R;
  const dir = cr >= 0 ? 1 : -1;
  const S = len / R;
  return (u) => {
    const th = th0 + dir * S * u;
    return [cx + R * Math.cos(th), cy + R * Math.sin(th)];
  };
}

// ------------------------------------------------------------------ the left fist's frame

/** from the strands to the palm: behind them (towards the body) and a little below, facing forward and up; the fingers curl round their front */
const TO_PALM: V3 = across(normalize(madd(mul(GEOM.N, -0.9), UP, -0.4)), GEOM.S);

const col1 = (f: Frame): V3 => quatRotate(f.q, [1, 0, 0]);
const col3 = (f: Frame): V3 => quatRotate(f.q, [0, 0, 1]);

/** the planned palm frame at palm point p: d3 = S (the thumb points along it, to the plug), d1 from the strands to the palm */
export const palmFrame = (p: V3): Frame => gripFrame(p, GEOM.S, TO_PALM);

/** the fist's grip frame for the IK (its axis R in front of the palm) and back */
export const gripOfPalm = (f: Frame, R: number): Frame => ({ p: madd(f.p, col1(f), -R), q: f.q });
export const palmOfGrip = (g: Frame, R: number): Frame => ({ p: madd(g.p, col1(g), R), q: g.q });

/** strand k of the stack in a palm frame (planned or reached), `along` metres along the strands (+ = lateral, to the plug) */
export function stackPoint(f: Frame, k: number, along: number): V3 {
  return madd(madd(f.p, col1(f), -GEOM.stack(k)), col3(f), along);
}

/** the stack's axis (away from the palm: in front), the strands' direction and up across them, of a palm frame */
export function stackAxes(f: Frame): { n: V3; s: V3; u: V3 } {
  const n = mul(col1(f), -1), s = col3(f);
  return { n, s, u: normalize(crossV(n, s)) };
}

// ------------------------------------------------------------------ guides that never snap

/**
 * Targets for a soft guide (rod.addGuide) that start where the nodes are and move towards the
 * wanted place at most vmax m/s: a guide that fades in pulls the cable over smoothly instead of
 * snapping it to a far target, and a target that jumps (a chord that changes side) is followed at
 * a walking pace.
 */
class Follow {
  private readonly cur: Float64Array;
  private readonly on: Uint8Array;
  private t = NaN;
  private readonly raw: (V3 | null)[];

  constructor(
    private readonly rod: Rod,
    readonly a: number,
    readonly b: number,
    private readonly want: (t: number, out: (V3 | null)[]) => void,
    private readonly vmax: number,
    /** targets that move with this point (a hand): vmax limits their speed relative to it */
    private readonly origin?: () => V3,
  ) {
    const m = b - a + 1;
    this.cur = new Float64Array(3 * m);
    this.on = new Uint8Array(m);
    this.raw = new Array(m).fill(null);
  }

  target = (i: number, t: number): V3 | null => {
    if (i < this.a || i > this.b) return null;
    if (t !== this.t) this.advance(t);
    const k = i - this.a;
    if (!this.on[k]) return null;
    return [this.cur[3 * k], this.cur[3 * k + 1], this.cur[3 * k + 2]];
  };

  private o: V3 | null = null;

  private advance(t: number) {
    const dt = Number.isNaN(this.t) ? 0 : Math.max(0, t - this.t);
    this.t = t;
    this.want(t, this.raw);
    const step = this.vmax * dt;
    if (this.origin) {
      // carried along with the origin first
      const o = this.origin();
      if (this.o) {
        const dx = o[0] - this.o[0], dy = o[1] - this.o[1], dz = o[2] - this.o[2];
        for (let k = 0; k < this.raw.length; k++) {
          if (!this.on[k]) continue;
          this.cur[3 * k] += dx; this.cur[3 * k + 1] += dy; this.cur[3 * k + 2] += dz;
        }
      }
      this.o = o;
    }
    for (let k = 0; k < this.raw.length; k++) {
      const w = this.raw[k];
      if (!w) {
        this.on[k] = 0;
        continue;
      }
      const i = this.a + k, k3 = 3 * k;
      if (!this.on[k]) {
        // starts where the node is now
        this.on[k] = 1;
        this.cur[k3] = this.rod.x[3 * i]; this.cur[k3 + 1] = this.rod.x[3 * i + 1]; this.cur[k3 + 2] = this.rod.x[3 * i + 2];
      }
      const dx = w[0] - this.cur[k3], dy = w[1] - this.cur[k3 + 1], dz = w[2] - this.cur[k3 + 2];
      const d = Math.hypot(dx, dy, dz);
      const f = d > step ? step / d : 1;
      this.cur[k3] += dx * f; this.cur[k3 + 1] += dy * f; this.cur[k3 + 2] += dz * f;
    }
  }
}

// ------------------------------------------------------------------ the record (bake vectors)

/** per frame: left angles (9), right angles (9), hand shapes, the look point */
export const REC = {
  size: 9 + 9 + 8 + 3 + 2,
  /** offsets */
  L: 0,
  R: 9,
  /** left open, right open, roll, cross, pinch (1) or free hand (0), free-hand curl, under turn 0..1, thumbWeight */
  H: 18,
  LOOK: 26,
  /** the fist's radius, the left thumb lifted */
  FR: 29,
  LIFT: 30,
} as const;

/** what the right hand does in a frame: the rig and the values recorded for the scene */
interface RightState {
  rig: HandRig;
  turn: number;
}

/** per-loop results, printed and checked at the end of the bake */
export interface LoopResult {
  k: number;
  kind: 'over' | 'under';
  /** cable in the loop, medial end to medial end [m] */
  length: number;
  /** material at the fist's medial end after the loop */
  sEdge: number;
  /** width / height of the hanging loop in its plane, right after it was laid and at the end */
  aspectLaid: number;
  aspectEnd: number;
  width: number;
  height: number;
  /** where the cable to the floor crosses the new loop (seen along N): + in front of it (away from Noor), − behind */
  crossDepth: number[];
  /** twist in the cable beyond the right hand (to the floor) right after the hand-over [turns] */
  floorTwist: number;
  /** twist in the first metre of cable beyond the fist (what hangs to the floor) [turns] */
  hangTwist: number;
  /** twist inside the loop [turns] */
  loopTwist: number;
  /** Lk of the coil so far (plug to the new strand) pulled apart along its axis N (ends drawn out −N and +N) */
  coilLk: number;
  /** under: seconds the right forearm or hand passed through the forming loop */
  wristIn: number;
}

export interface CoilOptions {
  spec?: PersonSpec;
  /** cable length [m] */
  length?: number;
  /** seconds of settling before shot time 0 */
  preroll?: number;
  /**
   * after the last loop the right hand slides out along the rest of the cable to its end and brings
   * the end up beside the fist (the user's finished coil, B 36.0: both ends at the top, in the hands)
   */
  fetchEnd?: boolean;
}

/** the end fetched after the last loop: the hand's frame when it started, the hold */
interface EndMemo {
  p0: V3;
  q0: Quat;
  held: boolean;
  holdP: V3 | null;
  stopT: number | null;
  stopP: V3 | null;
}

/** the stance (Noor stands at the origin facing -z) */
export function coilStance(spec: PersonSpec): Pick<Rig, 'pos' | 'yaw' | 'feet' | 'lean'> {
  return { ...stand(spec, [0, 0], 0, { width: 0.3 }), lean: 0.06 };
}

/** the cable's direction past the pads at the hand-over (into the fist): the strands' direction s turned to her left by layYaw and sloping down by laySlope */
function layDir(s: V3): V3 {
  const c = Math.cos(GEOM.layYaw), sn = Math.sin(GEOM.layYaw);
  const h = normalize([c * s[0] + sn * s[2], 0, -sn * s[0] + c * s[2]]);
  const a = GEOM.laySlope;
  return normalize([h[0] * Math.cos(a), -Math.sin(a), h[2] * Math.cos(a)]);
}

/** the length of the strand past the pads at the hand-over: the gap to the fist and the fist [m] */
const STRAND = GEOM.gap + 2 * GEOM.half;
/** how strongly the crossing is helped (0 = not at all; 1 = compliance 0.4 m/N) */
const CROSS_HELP = { over: 2, under: 1 };
/** the fist starts taking the new strand this long before the hand-over [s] */
const TAKE = 0.25;
/**
 * The right forearm's pronation the IK is asked for (rad, + pronation): resting a little pronated
 * (the back of the hand up); turned over for an under loop, supinated to near its limit (−85°): the
 * forearm turns as far as it can, the straight arm's shoulder does the rest
 */
const PRON = { rest: 0.45, turned: -1.4 };
/** the under loop: the hand turns over at the hip, the arm hanging nearly straight (B 6.4), moving in a little [m, from the hold point] */
const UNDER_IN: V3 = [-0.03, 0.02, -0.04];
/** and comes back still turned, low, to here: right of and below the hand-over point, the wrist above the pads, the loop over it (B 6.8) [m, from the pads' hand-over point] */
const UNDER_BACK: V3 = [0.1, -0.05, 0.0];
/** the azimuth of a point round Noor (0 straight ahead, + to her right) */
const azimuth = (p: V3) => Math.atan2(p[0], -p[2]);

interface LoopMemo {
  k: number;
  /** the pads' frame when the loop started */
  p0: V3;
  q0: Quat;
  /** under: the pose reached at the hip (the turn's reference) and the pads' frame there */
  outPose: Pose | null;
  outQ: Quat | null;
  /** the pinch held before the hand reached the hip: when, and where the hand stops */
  stopT: number | null;
  stopP: V3 | null;
  /** where the hand was when it held (the hip, or earlier) */
  holdP: V3 | null;
  /** under: the pads' frame the hand-over would have without the turn (solved once) */
  homeQ: Quat | null;
  held: boolean;
  added: boolean;
  guided: boolean;
  draped: boolean;
}

// ------------------------------------------------------------------ the controller

/**
 * Builds the cable and runs a coiling plan on it. Use it inside a ShotDef.build():
 *   const ctl = new CoilController(plan); return ctl.build();
 */
export class CoilController {
  readonly spec: PersonSpec;
  readonly bs: LoopBeat[];
  readonly results: LoopResult[] = [];
  rod!: Rod;
  pin!: Pinch;
  coil!: Bundle;
  /** material at the fist's medial end: [0] the plug strand, [k] after loop k */
  readonly sEdge: number[] = [];
  /** the plug strand in the fist [s0, s1] */
  plugStrand: [number, number] = [0, 0];
  private readonly ik = new RigIK(DT);
  private pose!: Pose;
  private tPose = 0;
  private capsA: Capsule[] = [];
  private capsB: Capsule[] = [];
  private tCapsA = 0;
  private legs: Capsule[] = [];
  private right!: RightState;
  private lookAt: V3 = [-0.02, 0.72, -0.4];
  private leftOpen = 0;
  private leftLift = 0;
  /** the fist's radius the last solved pose used */
  private leftR: number = GEOM.fist(0);
  private started = false;
  private memo: LoopMemo | null = null;
  /** what happened when (printed with the summary) */
  readonly log: string[] = [];
  /** the roll each loop ended with */
  private readonly rolls: number[] = [];
  // health, measured every frame
  private pen = { max: 0, where: '' };
  private penHeld = { max: 0, where: '' };
  private kink = { free: Infinity, freeWhere: '', fingers: Infinity, fingersWhere: '' };
  private speed = { max: 0, where: '', jump: 0 };
  private prevX: Float64Array | null = null;
  private openMax = { v: 0, where: '' };
  /** IK issues grouped: 'L at limit clavElev:max' → frames, first and last time */
  private readonly ikGroups = new Map<string, { n: number; t0: number; t1: number; worst: number }>();
  private readonly crossDone = new Set<number>();
  /** the cable's direction at the pads (towards the coil) and how far the pads are off it, read every frame */
  private spanDir: V3 | null = null;
  private tanDir: V3 | null = null;
  private padsErr: V3 = [0, 0, 0];
  /** the coil's Lk at shot time 0 (the plug strand only) */
  coilLk0: number | null = null;

  constructor(
    readonly plan: CoilPlan,
    readonly o: CoilOptions = {},
  ) {
    this.spec = o.spec ?? NOOR;
    this.bs = beats(plan);
  }

  /** shot time when the last loop is done (and the end fetched, with fetchEnd) */
  get tDone() {
    return this.o.fetchEnd ? this.endBeats().fUp : this.bs[this.bs.length - 1].t1;
  }

  /** the end fetch after the last loop: loosen, slide out along the rest, up beside the fist */
  endBeats() {
    const f0 = this.bs[this.bs.length - 1].t1 + 0.15;
    const fSlide = f0 + LOOSEN, fOut = fSlide + 1.0, fUp = fOut + 0.1 + 1.0;
    return { f0, fSlide, fOut, fUp };
  }

  private endMemo: EndMemo | null = null;
  /** the cable's material at the end of the fetch: where the right hand holds it */
  endHeldAt: number | null = null;

  // ---------------------------------------------------------------- the rig

  /** the fist's planned grip point at time t: out a little while the right hand slides out, in to meet it */
  leftPoint(t: number): V3 {
    const g = GEOM;
    const i = loopAt(this.bs, t);
    if (i < 0) return g.leftMeet;
    const b = this.bs[i];
    const last = i === this.bs.length - 1;
    if (last && t > b.t1) return lerpV(g.leftMeet, g.leftRest, ramp(t, b.t1 + 0.3, b.t1 + 1.3));
    if (t < b.tOut) return lerpV(g.leftMeet, g.leftOut, ramp(t, b.tSlide, b.tOut));
    if (t < b.tTurned + 0.2 * (b.tAbove - b.tTurned)) return g.leftOut;
    return lerpV(g.leftOut, g.leftMeet, ramp(t, b.tTurned + 0.2 * (b.tAbove - b.tTurned), b.tMeet - 0.1));
  }

  /** the fist's radius at time t: round the strands it holds, growing as the new one comes in */
  fistR(t: number): number {
    const i = loopAt(this.bs, t);
    if (i < 0) return GEOM.fist(0);
    const b = this.bs[i];
    return GEOM.fist(b.k - 1) + (GEOM.fist(b.k) - GEOM.fist(b.k - 1)) * ramp(t, b.tMeet - 0.2, b.tMeet + 0.05);
  }

  private leftRig(t: number): HandRig {
    const R = this.fistR(t);
    return { grip: gripOfPalm(palmFrame(this.leftPoint(t)), R), hold: 'coil', radius: R, open: this.leftOpen, thumbLift: this.leftLift, free: 0.3, thumbAlong: 1 };
  }

  /** where strand k leaves the fist (its medial end) and where it enters (the lateral end) at time t */
  private strandEnds(k: number, t: number): { m: V3; lat: V3 } {
    const f = palmFrame(this.leftPoint(t));
    return { m: stackPoint(f, k, -GEOM.half), lat: stackPoint(f, k, GEOM.half) };
  }

  /**
   * The pads at the hand-over of loop k: a finger's width beyond the fist's medial end and a little
   * higher (the cable past them slopes down into the fist), at strand k's place in the stack (over:
   * a little behind it, under: in front)
   */
  padsMeet(k: number, t: number): V3 {
    const f = palmFrame(this.leftPoint(t));
    const kind = k >= 1 ? this.plan.kinds[k - 1] : null;
    const { m } = this.strandEnds(k, t);
    const { s, n } = stackAxes(f);
    return madd(madd(m, layDir(s), -GEOM.gap), n, kind ? GEOM.padsDepth[kind] : 0);
  }

  /**
   * The pads ready to slide out after the hand-over of loop k (k = 0: at the start): beside the fist's
   * medial end, the cable through them already pointing the way it will run while the hand slides out
   * to the hip (towards the coil from there), so they run along it from the first moment
   */
  padsReady(k: number, t: number): { p: V3; d3: V3 } {
    const { m } = this.strandEnds(k, t);
    const d3 = normalize(sub(m, GEOM.hip));
    return { p: madd(m, d3, -GEOM.gap), d3 };
  }

  /** above the fist's medial end: the loop hangs open below between the hands */
  private padsAbove(k: number, t: number): V3 {
    const f = palmFrame(this.leftPoint(t));
    const { s } = stackAxes(f);
    return madd(madd(this.padsMeet(k, t), UP, 0.04), s, -0.05);
  }

  /** the right hand's pinch: point, cable direction past the thumb tip (towards the coil), and the shape */
  private pinchRig(p: V3, d3: V3, o: { roll?: number; open?: number; cross?: number; out?: number; free?: number; q?: Quat; pron?: number; pronWeight?: number }): HandRig {
    const out = o.out ?? 0;
    const lp = this.leftPoint(this.tPose);
    const toCoil = normalize([lp[0] - p[0], 0.4 * (lp[1] - p[1]), lp[2] - p[2]]);
    return {
      grip: o.q ? { p, q: o.q } : gripFrame(p, d3, [0, 0, 1]),
      hold: 'pinch',
      radius: RC,
      roll: o.roll ?? 0,
      open: o.open ?? 0,
      cross: o.cross ?? 0.3,
      free: o.free ?? 1,
      thumbTo: toCoil,
      thumbWeight: 0.2 * (1 - out),
      prefer: [{ hand: [0, 1, 0], world: normalize([-0.4, -0.3, 0.87]), weight: 0.3 * out }],
      // (the forearm a little pronated: the back of the hand up, as in the user's videos)
      joints: { pron: o.pron ?? PRON.rest },
      jointWeight: o.pronWeight ?? 2,
    };
  }

  /**
   * The strand past the pads as it should lie: from the pads straight to the fist's medial end (where
   * strand k will leave it), then along the fist; when the pads are farther away, straight towards it.
   * Returns the point at distance u from the pads, the end (the loop's end: the fist's lateral end
   * once laid) and the direction past the pads.
   */
  strandPath(k: number, t: number, pads: V3, padsDir?: V3): { at: (u: number) => V3; e: V3; dir: V3 } {
    const { m } = this.strandEnds(k, t);
    const { s } = stackAxes(palmFrame(this.leftPoint(t)));
    const dm = lenV(sub(m, pads)), dir = normalize(sub(m, pads));
    // (with the pads' own direction: a curve that leaves them that way and bends round to the fist's end)
    const c = padsDir ? madd(pads, padsDir, 0.5 * dm) : null;
    const at = (u: number): V3 => (u <= dm ? (c ? bez(pads, c, m, u / dm) : madd(pads, dir, u)) : madd(m, s, u - dm));
    return { at, e: at(STRAND), dir };
  }

  /** the right hand at time t (uses the per-loop memo the controller sets as it passes the beats) */
  private rightAt(t: number): RightState {
    const g = GEOM;
    const i = loopAt(this.bs, t);
    if (i < 0 || !this.memo) {
      // before the first loop: pinching next to the fist, the thumb tip towards it
      const r = this.padsReady(0, t);
      return { rig: this.pinchRig(r.p, r.d3, {}), turn: 0 };
    }
    const b = this.bs[i];
    const m = this.memo;
    if (this.o.fetchEnd && i === this.bs.length - 1 && this.endMemo && t >= this.endBeats().f0) return this.endAt(t);
    const meet = this.padsMeet(b.k, t);
    const hold = m.holdP ?? g.hip;
    // under: from the hold at the hip to just after the fist closed, the turn-over and back
    if (b.kind === 'under' && m.held && t >= b.tHeld) return this.underAt(b, m, t, hold, meet);
    // after the hand-over (the fist holds the strand): the pads stay beside it, the cable through them
    // already pointing about the way the next slide goes (GEOM.layYaw)
    if (t >= b.tMeet + 0.1) return { rig: this.pinchRig(meet, this.strandPath(b.k, t, meet).dir, {}), turn: 0 };
    // loosen where the last hand-over left the pads
    const dL = quatRotate(m.q0, [0, 0, 1]);
    if (t < b.tSlide) {
      const rig = this.pinchRig(m.p0, dL, { q: m.q0, open: 0.3 * ramp(t, b.t0, b.tSlide), roll: this.prevRoll(i) });
      return { rig, turn: 0 };
    }
    // ---- slide out along the cable to the hip (it holds when a loop length has passed)
    if (t < b.tOut || !m.held) {
      const slideAt = (x: number) => lerpV(m.p0, g.hip, ramp(x, b.tSlide, b.tOut));
      let p = slideAt(t);
      if (m.stopT !== null && m.stopP && t > m.stopT) p = lerpV(slideAt(m.stopT), m.stopP, minJerk((t - m.stopT) / 0.16));
      // the fingers keep the cable between them: the hand follows where the cable really is across
      // its length (read from the simulation); it only chooses how far along it slides
      p = add(p, this.padsErr);
      const out = ramp(t, b.tSlide, b.tOut);
      const d0 = dL;
      // the pads go with the cable: its direction where it runs through them (85 %), a little towards the span
      const along = this.tanDir && this.spanDir ? normalize(lerpV(this.spanDir, this.tanDir, 0.85)) : d0;
      const d3 = normalize(lerpV(d0, along, ramp(t, b.tSlide, b.tSlide + 0.25)));
      const open = 0.3 * (1 - ramp(t, b.tOut - 0.2, b.tOut));
      const roll = this.prevRoll(i) * (1 - ramp(t, b.tSlide, b.tSlide + 0.4));
      // (before an under loop the forearm pronates on the way out: it has room to turn over)
      return { rig: this.pinchRig(p, d3, { open, cross: 0.3 + 0.9 * out, out, roll }), turn: 0 };
    }
    // ---- over: back to the left hand, above its medial end (the loop hangs open), then down into it
    const above = this.padsAbove(b.k, t);
    const tBack = b.tTurned;
    const ctl = madd(madd(lerpV(hold, above, 0.5), UP, -0.06), g.N, 0.04);
    let p: V3;
    if (t < tBack) p = hold;
    else if (t < b.tAbove) p = bez(hold, ctl, above, ramp(t, tBack, b.tAbove));
    else p = lerpV(above, meet, ramp(t, b.tAbove, b.tMeet));
    const end = this.strandPath(b.k, t, p);
    const back = ramp(t, tBack, b.tAbove);
    const hd = this.spanDir ?? end.dir;
    const d3 = normalize(lerpV(hd, end.dir, back));
    const roll = g.roll * ramp(t, tBack, tBack + 0.6 * (b.tAbove - tBack));
    // (the thumb soon points along the cable again: the cable past its tip runs clear of the fingers)
    const out = 1 - ramp(t, tBack, tBack + 0.4 * (b.tAbove - tBack));
    return { rig: this.pinchRig(p, d3, { roll, cross: 0.3 + 0.9 * out, out }), turn: 0 };
  }

  /**
   * The under loop's right hand (ik-sweep.ts): at the hip the reached frame is turned about the
   * forearm's axis (supination, rig.ts turnWithForearm, free 0) while the hand comes in and up a
   * little (the elbow bends, so the forearm turns and not the shoulder): the cable towards the coil
   * now runs from past the thumb tip back over the back of the hand and the wrist. Still turned, the
   * hand comes back to the right of the fist (the loop hangs over the wrist), lays the strand into
   * the fist turning back on the way (the wrist still in the loop at the hand-over) and unwinds the
   * rest while the fist closes: the hand slips out of the loop.
   */
  private underAt(b: LoopBeat, m: LoopMemo, t: number, hold: V3, meet: V3): RightState {
    const g = GEOM;
    const turnP = add(hold, UNDER_IN), backP = add(meet, UNDER_BACK);
    let p: V3;
    if (t < b.tTurned) p = lerpV(hold, turnP, ramp(t, b.tHeld, b.tTurned));
    else if (t < b.tAbove) p = bez(turnP, madd(madd(lerpV(turnP, backP, 0.5), UP, -0.03), g.N, 0.03), backP, ramp(t, b.tTurned, b.tAbove));
    else p = lerpV(backP, meet, ramp(t, b.tAbove, b.tMeet));
    // (turned back before the fist takes the strand: the fingers do not sweep through it)
    const tBackTurn = this.unturnAt(b);
    const turn = t < b.tTurned ? ramp(t, b.tHeld, b.tTurned) : 1 - ramp(t, tBackTurn, b.tMeet - 0.3);
    // the frame without the turn: the hip's (as reached), carried round her body with the hand (the
    // fingers stay down, the palm keeps facing away from her), then into the hand-over's (a natural
    // pinch there, solved once); turned about the forearm as the arm holds it now
    const outQ = m.outQ ?? this.pose.body.arms![1].pads!.q;
    const homeQ = m.homeQ ?? outQ;
    const carried = quatMul(quatAxisAngle(UP, 0.8 * (azimuth(hold) - azimuth(p))), outQ);
    const homeU = ramp(t, b.tAbove - 0.2, b.tMeet);
    const base: Frame = { p, q: quatSlerp(carried, homeQ, homeU) };
    // (the forearm's axis in the hand as it was at the hip: a fixed reference, no feedback from the IK)
    const q = turnWithForearm(m.outPose ?? this.pose, 1, base, g.underTurn * turn).q;
    // the whole frame is held while turned; free about the cable again once the fist has it
    const free = 1 - ramp(t, b.tHeld, b.tHeld + 0.12) + ramp(t, b.tMeet + 0.05, b.t1 + 0.2);
    const pron = PRON.rest + (PRON.turned - PRON.rest) * turn;
    const roll = -g.roll * ramp(t, b.tTurned, b.tTurned + 0.6 * (b.tAbove - b.tTurned));
    const cross = 1.2 - 0.9 * ramp(t, b.tAbove, b.tMeet);
    const d3 = quatRotate(base.q, [0, 0, 1]);
    const rig = this.pinchRig(p, d3, { roll, open: 0, cross, out: 1 - homeU, free, q, pron, pronWeight: 4 });
    rig.thumbTo = undefined;
    rig.prefer = (rig.prefer ?? []).map((w) => ({ ...w, weight: (w.weight ?? 1) * free }));
    return { rig, turn };
  }

  /**
   * The end fetched after the last loop: the pinch loosens beside the fist and slides out along the
   * rest of the cable towards the hip (as for a loop) until it is near the plug, holds, and the hand
   * brings the end up beside the fist's medial end; the rest hangs below as a last open bight.
   */
  private endAt(t: number): RightState {
    const g = GEOM, e = this.endMemo!, eb = this.endBeats();
    const last = this.bs[this.bs.length - 1];
    const dL = quatRotate(e.q0, [0, 0, 1]);
    if (t < eb.fSlide) return { rig: this.pinchRig(e.p0, dL, { q: e.q0, open: 0.3 * ramp(t, eb.f0, eb.fSlide) }), turn: 0 };
    if (t < eb.fOut || !e.held) {
      const slideAt = (x: number) => lerpV(e.p0, g.hip, ramp(x, eb.fSlide, eb.fOut));
      let p = slideAt(t);
      if (e.stopT !== null && e.stopP && t > e.stopT) p = lerpV(slideAt(e.stopT), e.stopP, minJerk((t - e.stopT) / 0.16));
      p = add(p, this.padsErr);
      const out = ramp(t, eb.fSlide, eb.fOut);
      const along = this.tanDir && this.spanDir ? normalize(lerpV(this.spanDir, this.tanDir, 0.85)) : dL;
      const d3 = normalize(lerpV(dL, along, ramp(t, eb.fSlide, eb.fSlide + 0.25)));
      const open = 0.3 * (1 - ramp(t, eb.fOut - 0.2, eb.fOut));
      return { rig: this.pinchRig(p, d3, { open, cross: 0.3 + 0.9 * out, out }), turn: 0 };
    }
    // up beside the fist: the end held there, the thumb towards the coil
    const hold = e.holdP ?? g.hip;
    const up = madd(this.padsAbove(last.k, t), UP, 0.01);
    const u = ramp(t, eb.fOut + 0.1, eb.fUp);
    const ctl = madd(madd(lerpV(hold, up, 0.5), UP, -0.05), g.N, 0.04);
    const p = bez(hold, ctl, up, u);
    const hd = this.spanDir ?? normalize(sub(this.strandEnds(last.k, t).m, p));
    const d3 = normalize(lerpV(hd, normalize(sub(this.strandEnds(last.k, t).m, p)), u));
    const out = 1 - ramp(t, eb.fOut + 0.1, eb.fOut + 0.5);
    return { rig: this.pinchRig(p, d3, { cross: 0.3 + 0.9 * out, out }), turn: 0 };
  }

  /** under: when the hand starts turning back (the cable slides off the wrist) */
  private unturnAt(b: LoopBeat) {
    return b.tAbove - 0.25 * (b.tAbove - b.tTurned);
  }

  /** the pads' frame at loop b's hand-over as an over loop would reach it (solved once, statelessly): where the under loop's turn unwinds to */
  private homeFrame(b: LoopBeat): Quat {
    const t = b.tMeet, keep = this.tPose;
    this.tPose = t;
    const meet = this.padsMeet(b.k, t);
    const rig: Rig = { ...coilStance(this.spec), look: this.lookAt, hands: [this.leftRig(t), this.pinchRig(meet, this.strandPath(b.k, t, meet).dir, {})] };
    this.tPose = keep;
    return rigPose(this.spec, rig).body.arms![1].pads!.q;
  }

  /** the roll the last loop left on the cable (0 before the first) */
  private prevRoll(i: number): number {
    return i > 0 ? (this.rolls[i - 1] ?? 0) : 0;
  }

  /** the whole rig at time t */
  rigAt(t: number): Rig {
    this.right = this.rightAt(t);
    return { ...coilStance(this.spec), look: this.lookAt, hands: [this.leftRig(t), this.right.rig] };
  }

  // ---------------------------------------------------------------- the guides

  /**
   * The strand past the thumb tip lies straight along the way to the fist's lateral end, and the
   * free part of the loop below it hangs as a round arc from the fist's medial end to the strand's
   * end (in the loop's plane only; front and back are free). Both fade in while the hands come
   * together and fade out once the fist holds the strand: the friction in the cable keeps the
   * shape.
   */
  private guideLoop(i: number, rod: Rod) {
    const b = this.bs[i];
    const sP = this.pin.s;
    // the strand: from the loop's end up to just short of the pads
    // (only the part that will lie in the fist: the cable between the pads and the fist's end hangs as it
    // wants, over the fingers)
    const s0 = sP - STRAND, a = rod.segmentAt(sP - STRAND) + 1, e = rod.segmentAt(sP - GEOM.gap - 0.006);
    const padsNow = () => this.pose.body.arms![1].grip!;
    // (on from the pads the way the cable leaves past the thumb tip, then along the fist)
    // (under: the hand is still turned while it lays the strand, its d3 points away from the fist: the
    // strand runs straight from the pads to the fist's end instead)
    const padsDir = (g: Frame) => (b.kind === 'under' ? undefined : col3(g));
    const strand = new Follow(rod, a, e, (t, out) => {
      const g = padsNow(), path = this.strandPath(b.k, t, g.p, padsDir(g));
      for (let n = a; n <= e; n++) out[n - a] = path.at(sP - rod.sNode[n]);
    }, 0.4);
    // (under: once the hand turns back and the cable slides off the wrist; before, the loop hangs over it as it falls)
    const tIn = b.kind === 'under' ? this.unturnAt(b) : b.tTurned + 0.35 * (b.tAbove - b.tTurned);
    const tOff = b.t1 + 0.15;
    // (the strand only once the pads come down to the fist: on the way back it hangs from them as it wants)
    const tLay = b.tAbove - 0.15;
    rod.addGuide({ nodes: [a, e], target: strand.target, compliance: 0.05, weight: (t) => ramp(t, tLay, Math.max(tLay + 0.4, b.tMeet - 0.1)) * (1 - ramp(t, tOff, tOff + 0.4)) });
    // the loop: from just past the fist's medial end to the strand's start
    const la = rod.segmentAt(this.sEdge[b.k - 1]) + 2, le = a - 1;
    if (le <= la + 10) return;
    const len = rod.sNode[le] - rod.sNode[la];
    const A = GEOM.A, N = GEOM.N;
    const P2 = (p: V3): [number, number] => [dot(p, A), p[1]];
    const loop = new Follow(rod, la, le, (t, out) => {
      const g = padsNow(), E = this.strandPath(b.k, t, g.p, padsDir(g)).e;
      const arc = hangingArc(P2(nodeOf(rod, la)), P2(E), len);
      for (let n = la; n <= le; n++) {
        const [x, y] = arc((rod.sNode[n] - rod.sNode[la]) / len);
        const p = nodeOf(rod, n), depth = dot(p, N);
        out[n - la] = [A[0] * x + N[0] * depth, y, A[2] * x + N[2] * depth];
      }
    }, 0.4);
    rod.addGuide({ nodes: [la, le], target: loop.target, compliance: 0.08, weight: (t) => ramp(t, tIn, Math.max(tIn + 0.7, b.tAbove)) * (1 - ramp(t, tOff, tOff + 0.6)) });
    void s0;
    if (CROSS_HELP[b.kind] > 0) this.guideCross(i, rod, la, le);
  }

  /**
   * Under: while the hand turns over, the cable towards the coil is led from the pads over the back
   * of the hand onto the top of the wrist and round its side towards the fist (B 6.4/6.8: "the loop
   * hangs over the back of the hand and the wrist"); the forearm's capsule carries it there, so the
   * forearm is inside the loop that forms. The guide fades in over the turn (≥ 0.6 s, targets at most
   * 0.3 m/s) and out once the strand lies in the fist: the hand turning back lets the cable slip off.
   */
  private guideDrape(i: number, rod: Rod) {
    const b = this.bs[i];
    const sP = this.pin.s;
    const a = rod.segmentAt(sP - 0.17), e = rod.segmentAt(sP - 0.035);
    const R = 0.035 + RC + 0.004;
    const want = (t: number, out: (V3 | null)[]) => {
      void t;
      const pose = this.pose, arm = pose.body.arms![1];
      const wj = pose.joints[J.rightWrist], elbow = pose.joints[J.rightElbow];
      const fa = normalize(sub(wj, elbow));
      // (over the end of the forearm, 2 cm before the wrist's joint)
      const wrist = madd(wj, fa, -0.02);
      const up = across(UP, fa);
      const top = madd(wrist, up, R);
      // round the wrist's side towards the fist
      const toFist = sub(this.strandEnds(b.k, t).m, wrist);
      const side = normalize(madd(madd(toFist, fa, -dot(toFist, fa)), up, -dot(toFist, up)));
      const pads = arm.grip!.p;
      const lift = madd(lerpV(pads, top, 0.5), up, 0.02);
      const d1 = lenV(sub(top, pads)) * 1.05, arc = (Math.PI / 2) * R;
      for (let n = a; n <= e; n++) {
        const u = sP - rod.sNode[n];
        let p: V3;
        if (u <= d1) p = bez(pads, lift, top, u / d1);
        else {
          const th = Math.min(1, (u - d1) / arc) * (Math.PI / 2);
          p = add(wrist, add(mul(up, R * Math.cos(th)), mul(side, R * Math.sin(th))));
          if (u > d1 + arc) p = madd(p, UP, -(u - d1 - arc));
        }
        out[n - a] = p;
      }
    };
    const drape = new Follow(rod, a, e, want, 0.3, () => this.pose.joints[J.rightWrist]);
    const t0 = b.tHeld, t1 = Math.max(b.tTurned + 0.2, b.tHeld + 0.6);
    // (off while the hand turns back and lays the strand: the cable slides off the wrist into the fist)
    const off = this.unturnAt(b) - 0.1;
    rod.addGuide({ nodes: [a, e], target: drape.target, compliance: 0.08, weight: (t) => ramp(t, t0, t1) * (1 - ramp(t, off, off + 0.6)) });
    this.log.push(`t ${t0.toFixed(2)} loop ${b.k}: the cable is led over the wrist (s ${rod.sNode[a].toFixed(3)} … ${rod.sNode[e].toFixed(3)})`);
  }

  /**
   * A weak help for the crossing (KONZEPT: "Führungskräfte, so dass die Kreuzungen stimmen"): the
   * first 45 cm of the cable to the floor are led, along the coil's axis only, a few cm to the side
   * of the new loop they belong on (over: Noor's side, under: behind it). Weak (a fifth of the other
   * guides' strength), fading in over 0.6 s while the hand lays the strand, off before the next
   * slide. What the hands do decides it first; this only keeps it.
   */
  private guideCross(i: number, rod: Rod, la: number, le: number) {
    const b = this.bs[i];
    const sP = this.pin.s;
    const a = rod.segmentAt(sP + 0.06), e = Math.min(rod.n - 2, rod.segmentAt(sP + 0.5));
    const N = GEOM.N, side = b.kind === 'over' ? -1 : 1;
    const m0 = la + Math.floor((le - la) / 3), m1 = le - Math.floor((le - la) / 3);
    const cross = new Follow(rod, a, e, (_t, out) => {
      let depth = 0;
      for (let j = m0; j <= m1; j++) depth += dot(nodeOf(rod, j), N) / (m1 - m0 + 1);
      const want = depth + side * (b.kind === 'over' ? 0.05 : 0.035);
      for (let n = a; n <= e; n++) {
        const p = nodeOf(rod, n), off = want - dot(p, N);
        // (only towards the right side: a cable already there is left alone)
        out[n - a] = off * side > 0 ? madd(p, N, off) : p;
      }
    }, 0.3);
    const t0 = b.tAbove - 0.1, t1 = b.t1 - 0.05;
    rod.addGuide({ nodes: [a, e], target: cross.target, compliance: 0.4 / CROSS_HELP[b.kind], weight: (t) => ramp(t, t0, t0 + 0.6) * (1 - ramp(t, t1, t1 + 0.12)) });
  }

  // ---------------------------------------------------------------- the cable

  /** the cable at shot time 0: the plug end through the fist (the plug out at its lateral end), the pads next to it, down to the floor, then loose bends to her right front */
  private initialPoints(length: number): V3[] {
    const g = GEOM;
    const f = palmFrame(g.leftMeet);
    const { s: sDir } = stackAxes(f);
    const pts: V3[] = [];
    // the plug sticks out of the fist's lateral end along the strands, 2 cm of cable between; from the
    // medial end the cable rises a little to the pads
    const lat = stackPoint(f, 0, g.half);
    const tip = madd(lat, sDir, 0.02 + 0.06);
    for (let x = 0; x <= 0.08 + 2 * g.half + 1e-9; x += 0.002) pts.push(madd(tip, sDir, -x));
    const med = pts[pts.length - 1], padsAt = this.padsReady(0, 0).p;
    const up = normalize(sub(padsAt, med)), dPads = lenV(sub(padsAt, med));
    for (let x = 0.002; x <= dPads + 1e-9; x += 0.002) pts.push(madd(med, up, x));
    // from the pads: a bend down into a hanging line (away from her body), a bend onto the floor
    const pads = pts[pts.length - 1];
    const R1 = 0.1;
    const h = normalize([0.75, 0, 0.2]);
    const c1 = madd(pads, UP, -R1);
    for (let a = 0.05; a <= Math.PI / 2; a += 0.02) pts.push(add(c1, add(mul(h, R1 * Math.sin(a)), mul(UP, R1 * Math.cos(a)))));
    let p = pts[pts.length - 1];
    while (p[1] > RC + 0.1) {
      p = madd(madd(p, UP, -0.004), [0.15, 0, -0.2], 0.004 * 0.3);
      pts.push(p);
    }
    let head = -0.35;
    const fdir: V3 = [Math.cos(head), 0, Math.sin(head)];
    const c2 = madd(p, fdir, 0.1);
    for (let a = 0.02; a <= Math.PI / 2; a += 0.02) pts.push(madd(madd(c2, fdir, -0.1 * Math.cos(a)), UP, -0.1 * Math.sin(a)));
    p = pts[pts.length - 1];
    let used = 0;
    for (let i = 1; i < pts.length; i++) used += lenV(sub(pts[i], pts[i - 1]));
    // on the floor: loose bends, away to her right front
    for (let s = 0; s < length - used; s += 0.004) {
      head += 0.004 * 1.1 * Math.sin(s * 2.4 + 0.6);
      p = [p[0] + 0.004 * Math.cos(head), RC, p[2] + 0.004 * Math.sin(head)];
      pts.push(p);
    }
    return pts;
  }

  /** the shot's build(): rod, script, vectors, tracks */
  build(): ShotBuild {
    const length = this.o.length ?? 5.0;
    const g = GEOM;
    const built = buildCable(XLR, this.initialPoints(length), { plugs: 'both' });
    const rod = (this.rod = built.rod);
    // a cable that was laid out straight before: no remembered bends
    rod.restFric?.fill(0);
    rod.setRestStraight();
    // the plug strand: from the plug's tip through the fist to its medial end
    const sMed = 0.08 + 2 * g.half;
    this.plugStrand = [0, sMed];
    this.sEdge.push(sMed);

    // the legs and the trunk (the coil hangs in front of the left thigh)
    const pose0 = rigPose(this.spec, this.rigAt(0));
    const Jt = pose0.joints;
    this.legs = [
      { a: Jt[11], b: Jt[13], r: 0.068 },
      { a: Jt[12], b: Jt[14], r: 0.068 },
      { a: Jt[13], b: Jt[15], r: 0.05 },
      { a: Jt[14], b: Jt[16], r: 0.05 },
      { a: Jt[18], b: Jt[17], r: 0.13 },
    ];

    // settle with the hands holding (the IK too)
    const pre = this.o.preroll ?? 1.5;
    rod.time = -pre;
    this.solve(-pre, true);
    this.coil = rod.bundle({ frame: palmOfGrip(this.pose.body.arms![0].grip!, this.leftR), hand: 0, blend: 0.01 });
    // the plug and the strand through the fist: the plug sticks out of it, held
    this.coil.add(0, sMed - 0.003, 0.01);
    // (rolls: the cable turns with the hand, the under loop's turn-over and the thumb's roll go into it;
    // the curled fingers keep it through the bend where it hangs down from them while they slide)
    this.pin = rod.pinch({ frame: this.pose.body.arms![1].grip!, hand: 1, mode: 'held', blend: 0.01, rolls: true, lostDistance: 0.02, lostAngle: (78 * Math.PI) / 180 });
    rod.setCapsules((tt) => this.capsAt(tt));
    const frames = Math.round(pre * 60);
    for (let f = 0; f < frames; f++) {
      this.solve(rod.time + DT, false);
      rod.step(DT, XLR.substeps);
    }
    rod.time = 0;
    this.solve(0, true);
    this.started = false;
    this.coilLk0 = +coilLink(rod, this.sEdge[0]).toFixed(2);

    const rec = new Array<number>(REC.size).fill(0);
    const vectors: Record<string, VectorTrack> = {
      rec: { size: REC.size, fn: () => this.record(rec) },
      gripL: frameTrack(() => this.pose.body.arms![0].grip!),
      gripR: frameTrack(() => this.pose.body.arms![1].grip!),
    };
    return {
      rod,
      script: (r, t) => this.script(r, t),
      vectors,
      tracks: {
        cable0: () => built.cable[0],
        cable1: () => built.cable[1],
        sPads: () => this.pin.s,
        pinch: () => this.pin.level(),
        loop: (_r, t) => {
          const i = loopAt(this.bs, t);
          return i < 0 ? 0 : this.bs[i].k + clamp01((t - this.bs[i].t0) / (this.bs[i].t1 - this.bs[i].t0)) - 1;
        },
        edge: () => this.sEdge[this.sEdge.length - 1],
        seg: () => this.rod.totalLength / (this.rod.n - 1),
      },
    };
  }

  /** solves the arms for time tn and moves the hands (pinch, bundle, capsules) there over the next frame */
  private solve(tn: number, jump: boolean) {
    this.tPose = tn;
    const rig = this.rigAt(tn);
    const pose = rigPose(this.spec, rig, this.ik);
    this.pose = pose;
    const caps = [
      ...handColliders(pose, 0, { group: 0, soft: { index: 0.3, middle: 0.3, ring: 0.3, little: 0.3, thumb: 0.3 } }),
      // (the right hand's middle, ring and little fingers are not part of the pinch: the cable past the
      // pads drapes over them instead of passing through, so they keep colliding next to the pads too)
      ...handColliders(pose, 1, { group: 1, soft: { index: 0.3, middle: 0.3, ring: 0.3, little: 0.3, thumb: 0.3 } }).map((c) => (c.part === 'middle' || c.part === 'ring' || c.part === 'little' ? { ...c, group: 2, soft: 1 } : c)),
      ...this.legs,
    ];
    if (jump) {
      this.capsA = caps;
      this.tCapsA = tn;
    } else {
      this.capsA = this.capsB;
      this.tCapsA = tn - DT;
    }
    this.capsB = caps;
    const arms = pose.body.arms!;
    for (const [i, a] of arms.entries()) {
      const r = a.report;
      const note = (key: string, v = 0) => {
        const gr = this.ikGroups.get(key);
        if (gr) { gr.n++; gr.t1 = tn; gr.worst = Math.max(gr.worst, v); } else this.ikGroups.set(key, { n: 1, t0: tn, t1: tn, worst: v });
      };
      if (tn >= 0 && r.atLimit.length) note(`${i ? 'R' : 'L'} at limit ${r.atLimit.join(',')}`);
      if (tn >= 0 && !r.reached) note(`${i ? 'R' : 'L'} not reached`, r.posError * 1000);
    }
    // the coil sits against the palm: the bundle's frame is the reached grip moved back to the palm
    this.leftR = rig.hands[0]?.radius ?? GEOM.fist(0);
    const palm = palmOfGrip(arms[0].grip!, this.leftR);
    if (this.coil) {
      if (jump) {
        this.coil.setFrame(palm);
        this.pin.setFrame(arms[1].grip!);
      } else {
        this.coil.moveTo(palm, DT);
        this.pin.moveTo(arms[1].grip!, DT);
      }
    }
  }

  /** the capsules at a substep: interpolated between the last two solved frames (same order) */
  private capsAt(t: number): Capsule[] {
    const a = this.capsA, b = this.capsB;
    const u = clamp01((t - this.tCapsA) / DT);
    if (a.length !== b.length || u >= 1) return b;
    return b.map((c, k) => ({ ...c, a: lerpV(a[k].a, c.a, u), b: lerpV(a[k].b, c.b, u), r: c.r }));
  }

  // ---------------------------------------------------------------- the script (once per frame)

  private script(rod: Rod, t: number) {
    if (!this.started) {
      // frame 0: the state after the pre-roll
      this.started = true;
      return;
    }
    const tn = t + DT;
    this.events(rod, t);
    // the left fist opens a little for the new strand and closes over it
    const i = loopAt(this.bs, tn);
    if (i >= 0) {
      const b = this.bs[i];
      // (the fingers loosen and the thumb lifts: the new strand goes in under it, on top of the others)
      const w = tn < b.tMeet ? ramp(tn, b.tMeet - 0.42, b.tMeet - 0.14) : 1 - ramp(tn, b.tMeet + 0.06, b.tMeet + 0.32);
      this.leftOpen = 0.4 * w;
      this.leftLift = w;
    }
    // look at the middle between the hands, a little towards the coil
    const lp = this.leftPoint(tn), rp = this.pose.body.arms![1].grip!.p;
    const want = lerpV(lp, rp, 0.4);
    this.lookAt = lerpV(this.lookAt, [want[0], want[1] - 0.12, want[2] - 0.05], 0.06);
    this.solve(tn, false);
    this.measure(rod, t);
  }

  /** the beats that need the cable: loosen and slide, hold after a loop length, the hand-over */
  private events(rod: Rod, t: number) {
    const tn = t + DT;
    const pin = this.pin;
    const arms = this.pose.body.arms!;
    // the cable at the pads: its direction towards the coil (10 cm on), and how far the pads are off it across
    if (pin.state !== 'free') {
      const c = rod.pointAt(pin.s), ahead = rod.pointAt(Math.max(0, pin.s - 0.1));
      this.spanDir = normalize(sub(ahead, c));
      const tg = mul(rod.tangentAt(pin.s), -1), d = sub(c, arms[1].grip!.p);
      this.tanDir = tg;
      this.padsErr = madd(d, tg, -dot(d, tg));
    }
    const i = loopAt(this.bs, tn);
    if (TRACE && Math.round(t * 60) % TRACE === 0) {
      const gp = arms[1].grip!, d3 = quatRotate(gp.q, [0, 0, 1]), tg = rod.tangentAt(pin.s);
      const ang = (Math.acos(Math.min(1, Math.abs(dot(d3, tg)))) * 180) / Math.PI;
      const dist = lenV(sub(rod.pointAt(pin.s), gp.p));
      const r = arms[1].report;
      this.log.push(`  trace t ${t.toFixed(3)} s ${pin.s.toFixed(3)} ${pin.state} lvl ${pin.level().toFixed(2)} pads→cable ${(dist * 1000).toFixed(1)} mm ${ang.toFixed(0)}° slip ${pin.slip.toFixed(2)} F ${pin.force.toFixed(2)} ik ${(r.posError * 1000).toFixed(1)} mm ${r.atLimit.join(',')} p ${gp.p.map((x) => x.toFixed(3)).join(',')}`);
    }
    if (i < 0) return;
    const b = this.bs[i];
    if (!this.memo || this.memo.k !== b.k) {
      const p0 = arms[1].grip!.p;
      this.memo = { k: b.k, p0, q0: arms[1].pads!.q, outPose: null, outQ: null, stopT: null, stopP: null, holdP: null, homeQ: b.kind === 'under' ? this.homeFrame(b) : null, held: false, added: false, guided: false, draped: false };
      // the pads loosen on the cable next to the fist and slide
      pin.set('loose', LOOSEN);
      this.log.push(`t ${tn.toFixed(2)} loop ${b.k}: the pinch loosens at s ${pin.s.toFixed(3)} (edge ${this.sEdge[b.k - 1].toFixed(3)})`);
    }
    const m = this.memo;
    const edge = this.sEdge[b.k - 1];
    // hold as soon as a loop's worth has passed through the pads (or at the hip at the latest)
    const sHold = edge + this.plan.loopLength + GEOM.gap;
    // (the pads close over 0.2 s: the cable still runs on a little meanwhile)
    if (!m.held && tn >= b.tSlide && (pin.s + 0.1 * Math.min(1.2, Math.max(0, pin.slip)) >= sHold || tn >= b.tOut)) {
      pin.set('held', 0.2);
      m.held = true;
      if (tn < b.tOut - 0.1) {
        // early: the hand stops a few cm further on (decelerating), not at the hip
        const slideAt = (x: number) => lerpV(m.p0, GEOM.hip, ramp(x, b.tSlide, b.tOut));
        const a = slideAt(tn), v = mul(sub(slideAt(tn + DT), a), 1 / DT);
        m.stopT = tn;
        m.stopP = madd(a, v, 0.16 * 0.5);
        m.holdP = add(m.stopP, this.padsErr);
      } else m.holdP = arms[1].grip!.p;
      this.log.push(`t ${tn.toFixed(2)} loop ${b.k}: holds at s ${pin.s.toFixed(3)} (wanted ${sHold.toFixed(3)})`);
    }
    if (m.held && !m.holdP) m.holdP = arms[1].grip!.p;
    if (b.kind === 'under' && !m.outPose && m.held && tn >= b.tHeld) {
      // the frame the hand reached at the hip: the turn-over's reference
      m.outPose = this.pose;
      m.outQ = arms[1].pads!.q;
    }
    if (b.kind === 'under' && !m.draped && m.held && tn >= b.tHeld) {
      m.draped = true;
      this.guideDrape(i, rod);
    }
    if (!m.guided && m.held && tn >= b.tTurned) {
      m.guided = true;
      this.guideLoop(i, rod);
    }
    if (!m.added && tn >= b.tMeet - TAKE) {
      // the strand comes down into the open fist (the fingers loose, the thumb lifted): the fist takes it
      // as it settles there, more and more firmly, and holds it where it lies
      const sP = pin.s, s1 = sP - GEOM.gap;
      this.coil.add(s1 - 2 * GEOM.half + 0.003, s1 - 0.003, TAKE + 0.15);
      this.sEdge.push(s1);
      this.log.push(`t ${tn.toFixed(2)} loop ${b.k}: hand-over, pads at s ${sP.toFixed(3)}, new edge ${s1.toFixed(3)}`);
      m.added = true;
      this.results.push({ k: b.k, kind: b.kind, length: s1 - edge, sEdge: s1, aspectLaid: 0, aspectEnd: 0, width: 0, height: 0, crossDepth: [], floorTwist: 0, hangTwist: 0, loopTwist: 0, coilLk: 0, wristIn: 0 });
    }
    if (m.added && this.rolls[i] === undefined && tn >= b.t1 - DT) this.rolls[i] = this.right.rig.roll ?? 0;
    // the end fetched after the last loop
    if (this.o.fetchEnd && i === this.bs.length - 1) {
      const eb = this.endBeats();
      if (!this.endMemo && tn >= eb.f0) {
        this.endMemo = { p0: arms[1].grip!.p, q0: arms[1].pads!.q, held: false, holdP: null, stopT: null, stopP: null };
        pin.set('loose', LOOSEN);
        this.log.push(`t ${tn.toFixed(2)} the end: the pinch loosens at s ${pin.s.toFixed(3)} and slides out to the end`);
      }
      const e = this.endMemo;
      const sEnd = rod.totalLength - 0.1;
      if (e && !e.held && tn >= eb.fSlide && (pin.s + 0.1 * Math.min(1.2, Math.max(0, pin.slip)) >= sEnd || tn >= eb.fOut)) {
        pin.set('held', 0.2);
        e.held = true;
        if (tn < eb.fOut - 0.1) {
          const slideAt = (x: number) => lerpV(e.p0, GEOM.hip, ramp(x, eb.fSlide, eb.fOut));
          const a = slideAt(tn), v = mul(sub(slideAt(tn + DT), a), 1 / DT);
          e.stopT = tn;
          e.stopP = madd(a, v, 0.16 * 0.5);
          e.holdP = add(e.stopP, this.padsErr);
        } else e.holdP = arms[1].grip!.p;
        this.endHeldAt = pin.s;
        this.log.push(`t ${tn.toFixed(2)} the end: holds at s ${pin.s.toFixed(3)} (${((rod.totalLength - pin.s) * 100).toFixed(0)} cm from the end)`);
      }
    }
  }

  // ---------------------------------------------------------------- measuring

  /** the loop's free part (outside the fist) as node indices */
  loopNodes(k: number): [number, number] {
    const r = this.rod;
    const a = r.segmentAt(this.sEdge[k - 1]) + 1;
    return [a, Math.max(a + 1, r.segmentAt(this.sEdge[k] - 2 * GEOM.half) - 1)];
  }

  /** width and height of loop k in its own best-fit plane (width horizontal in it) */
  private shape(k: number): { width: number; height: number } {
    const r = this.rod, [a, b] = this.loopNodes(k);
    const P: V3[] = [];
    for (let i = a; i <= b; i++) P.push(nodeOf(r, i));
    const top = this.pose.body.arms![0].grip!.p[1];
    return loopShape(P, top);
  }

  /** crossings of the cable to the floor with loop k, seen along N: depth (floor − loop) along N at each */
  private crossings(k: number): number[] {
    const r = this.rod, [a, b] = this.loopNodes(k);
    const f0 = r.segmentAt(this.sEdge[k] + 0.005), f1 = Math.min(r.n - 2, r.segmentAt(this.sEdge[k] + 0.7));
    const A = GEOM.A, N = GEOM.N;
    const P = (i: number): [number, number, number] => {
      const p = nodeOf(r, i);
      return [dot(p, A), p[1], dot(p, N)];
    };
    const out: number[] = [];
    for (let i = f0; i < f1; i++) {
      const p = P(i), q = P(i + 1);
      for (let j = a; j < b; j++) {
        const u = P(j), v = P(j + 1);
        const d = (q[0] - p[0]) * (v[1] - u[1]) - (q[1] - p[1]) * (v[0] - u[0]);
        if (Math.abs(d) < 1e-12) continue;
        const s = ((u[0] - p[0]) * (v[1] - u[1]) - (u[1] - p[1]) * (v[0] - u[0])) / d;
        const w = ((u[0] - p[0]) * (q[1] - p[1]) - (u[1] - p[1]) * (q[0] - p[0])) / d;
        if (s < 0 || s > 1 || w < 0 || w > 1) continue;
        const zf = p[2] + (q[2] - p[2]) * s, zl = u[2] + (v[2] - u[2]) * w;
        out.push(+(zf - zl).toFixed(4));
      }
    }
    return out;
  }

  /** does the right forearm or hand pass through the loop that is forming (fist's medial end … pads)? */
  private wristThrough(k: number): boolean {
    const r = this.rod;
    const a = r.segmentAt(this.sEdge[k - 1]), e = r.segmentAt(this.pin.s);
    if (e <= a + 10) return false;
    const P: V3[] = [];
    for (let i = a; i <= e; i++) P.push(nodeOf(r, i));
    const J0 = this.pose.joints;
    const el = J0[J.rightElbow], wr = J0[J.rightWrist];
    // through the loop's plane inside its outline, or the loop's cable lying over the wrist (a loop
    // draped over the wrist is not flat, and the pads hang below the wrist on the forearm's axis)
    if (segmentThroughLoop(P, el, wr) || segmentThroughLoop(P, wr, this.pose.body.arms![1].grip!.p)) return true;
    const fa = this.capsB.find((c) => c.group === 1 && (c as { part?: string }).part === 'forearm');
    return fa ? cableOver(P, fa.a, fa.b, fa.r) : false;
  }

  private debugStrand(rod: Rod, t: number) {
    if (t > 2.6 && t < 2.72) {
      const caps = rod.currentCapsules();
      for (const ds of [0.03, 0.045, 0.06]) {
        const s = this.pin.s - ds, j = rod.segmentAt(s), p: V3 = [rod.c[3 * j], rod.c[3 * j + 1], rod.c[3 * j + 2]];
        let best = Infinity, near = '';
        caps.forEach((c, ci) => {
          if (c.r < 0) return;
          const ax = sub(c.b, c.a), l2 = dot(ax, ax) || 1, u = clamp01(dot(sub(p, c.a), ax) / l2);
          const d = lenV(sub(p, madd(c.a, ax, u))) - c.r - RC;
          if (d < best) { best = d; near = `#${ci} ${(c as { part?: string }).part ?? 'leg'}/${c.group} soft ${c.soft}`; }
        });
        this.log.push(`  dbg2 t ${t.toFixed(3)} s ${s.toFixed(3)} nearest ${near} ${(best * 1000).toFixed(1)} mm held ${rod.heldMark[j]} skip ${rod.skipGroup[j]} wc ${rod.wc[j].toFixed(3)}`);
      }
    }
    const i = loopAt(this.bs, t);
    if (i < 0) return;
    const b = this.bs[i];
    if (Math.abs(t - b.tMeet) > 0.08) return;
    const g = this.pose.body.arms![1].grip!, path = this.strandPath(b.k, t, g.p, col3(g));
    const sP = this.pin.s;
    for (const ds of [0.09, 0.1, 0.11]) {
      const s = sP - ds, j = rod.segmentAt(s), p = nodeOf(rod, j), want = path.at(ds);
      let near = '';
      let best = Infinity;
      for (const c of rod.currentCapsules()) {
        if (c.r < 0) continue;
        const ax = sub(c.b, c.a), l2 = dot(ax, ax) || 1, u = clamp01(dot(sub(p, c.a), ax) / l2);
        const d = lenV(sub(p, madd(c.a, ax, u))) - c.r - RC;
        if (d < best) { best = d; near = `${(c as { part?: string }).part ?? 'leg'}/${c.group}`; }
      }
      this.log.push(`  dbg t ${t.toFixed(3)} s ${s.toFixed(3)} off target ${(lenV(sub(p, want)) * 1000).toFixed(1)} mm, nearest capsule ${near} ${(best * 1000).toFixed(1)} mm, held ${rod.heldMark[j]} skip ${rod.skipGroup[j]}`);
    }
  }

  private measure(rod: Rod, t: number) {
    if (TRACE) this.debugStrand(rod, t);
    // (1) free cable inside a capsule (hands, forearms, legs); (2) pieces the other hand holds inside a hand
    for (const c of rod.currentCapsules()) {
      if (c.r < 0) continue;
      const ax = c.b[0] - c.a[0], ay = c.b[1] - c.a[1], az = c.b[2] - c.a[2], l2 = ax * ax + ay * ay + az * az || 1;
      for (let j = 0; j < rod.ns; j++) {
        const own = c.group !== undefined && rod.skipGroup[j] === c.group;
        if (own) continue;
        const px = rod.c[3 * j] - c.a[0], py = rod.c[3 * j + 1] - c.a[1], pz = rod.c[3 * j + 2] - c.a[2];
        const u = clamp01((px * ax + py * ay + pz * az) / l2);
        const d = c.r + RC - Math.hypot(px - ax * u, py - ay * u, pz - az * u);
        if (d <= 0) continue;
        const rec = rod.heldMark[j] ? this.penHeld : this.pen;
        if (d > rec.max) {
          rec.max = d;
          rec.where = `t ${t.toFixed(2)} s ${rod.sNode[j].toFixed(3)} capsule group ${c.group ?? '-'} ${(c as { part?: string }).part ?? 'leg'} r ${(c.r * 1000).toFixed(1)}`;
        }
      }
    }
    // kinks: the bend radius at each node from the positions (free cable ≥ 15 mm, next to the fingers ≥ 10 mm)
    const x = rod.x;
    for (let i = 1; i + 1 < rod.n; i++) {
      const j = i - 1;
      if (rod.wc[j] === 0 && rod.wc[j + 1] === 0) continue;
      const ax = x[3 * i] - x[3 * i - 3], ay = x[3 * i + 1] - x[3 * i - 2], az = x[3 * i + 2] - x[3 * i - 1];
      const bx = x[3 * i + 3] - x[3 * i], by = x[3 * i + 4] - x[3 * i + 1], bz = x[3 * i + 5] - x[3 * i + 2];
      const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz);
      const c = (ax * bx + ay * by + az * bz) / (la * lb + 1e-12);
      const ang = Math.acos(Math.min(1, Math.max(-1, c)));
      if (ang < 1e-4) continue;
      const R = (0.5 * (la + lb)) / ang;
      const nearHand = rod.heldMark[j] || rod.heldMark[j + 1] || rod.skipGroup[j] >= 0 || rod.skipGroup[j + 1] >= 0;
      if (nearHand) {
        if (R < this.kink.fingers) { this.kink.fingers = R; this.kink.fingersWhere = `t ${t.toFixed(2)} s ${rod.sNode[i].toFixed(3)}`; }
      } else if (R < this.kink.free) { this.kink.free = R; this.kink.freeWhere = `t ${t.toFixed(2)} s ${rod.sNode[i].toFixed(3)}`; }
    }
    // speed of the coil and the forming loop (plug … pads) from frame to frame
    const n = rod.n;
    if (!this.prevX) this.prevX = new Float64Array(rod.x);
    else {
      const top = rod.segmentAt(this.pin.s);
      for (let i = 0; i <= Math.min(n - 1, top); i++) {
        const d = Math.hypot(rod.x[3 * i] - this.prevX[3 * i], rod.x[3 * i + 1] - this.prevX[3 * i + 1], rod.x[3 * i + 2] - this.prevX[3 * i + 2]);
        if (d > this.speed.jump) { this.speed.jump = d; this.speed.max = d / DT; this.speed.where = `t ${t.toFixed(2)} s ${rod.sNode[i].toFixed(3)}`; }
      }
      this.prevX.set(rod.x);
    }
    // the left fist stays closed except around the hand-overs
    const i = loopAt(this.bs, t);
    if (i >= 0) {
      const b = this.bs[i];
      const nearMeet = Math.abs(t - b.tMeet) < 0.35 || (i > 0 && Math.abs(t - this.bs[i - 1].tMeet) < 0.35);
      if (!nearMeet && this.leftOpen > this.openMax.v) this.openMax = { v: this.leftOpen, where: `t ${t.toFixed(2)}` };
      // the forearm through the forming under loop
      if (b.kind === 'under' && t >= b.tTurned && t <= b.t1 + 0.3 && this.wristThrough(b.k)) this.wristTime.set(b.k, (this.wristTime.get(b.k) ?? 0) + DT);
    }
    for (const res of this.results) {
      const b = this.bs[res.k - 1];
      res.wristIn = this.wristTime.get(res.k) ?? 0;
      if (!res.crossDepth.length && !this.crossDone.has(res.k) && t >= b.t1 + 0.1) {
        this.crossDone.add(res.k);
        res.crossDepth = this.crossings(res.k);
      }
      if (!res.aspectLaid && t >= b.t1 + 0.25) {
        const s = this.shape(res.k);
        res.aspectLaid = +(s.width / s.height).toFixed(3);
        const j0 = rod.segmentAt(this.sEdge[res.k - 1]), j1 = rod.segmentAt(this.sEdge[res.k]);
        res.floorTwist = +twistTurns(rod.q, rod.segmentAt(this.sEdge[res.k] + GEOM.gap + 0.02), rod.ns - 1).toFixed(2);
        res.hangTwist = +twistTurns(rod.q, rod.segmentAt(this.sEdge[res.k] + 0.03), Math.min(rod.ns - 1, rod.segmentAt(this.sEdge[res.k] + 1.0))).toFixed(2);
        res.loopTwist = +twistTurns(rod.q, j0, j1).toFixed(2);
        res.coilLk = +coilLink(rod, this.sEdge[res.k]).toFixed(2);
      }
    }
  }
  private readonly wristTime = new Map<number, number>();

  /** where the plug is relative to the finished coil: outside every loop seen along N, or behind the first */
  private plugCheck(): { ok: boolean; text: string } {
    const r = this.rod, A = GEOM.A, N = GEOM.N;
    const plug: V3[] = [];
    for (let i = 0; i <= r.segmentAt(0.06); i++) plug.push(nodeOf(r, i));
    const inside: number[] = [];
    for (let k = 1; k <= this.results.length; k++) {
      const [a, b] = this.loopNodes(k);
      const poly: [number, number][] = [];
      for (let i = a - 12; i <= b + 12; i++) { const p = nodeOf(r, Math.max(0, i)); poly.push([dot(p, A), p[1]]); }
      if (plug.some((p) => pointInPoly([dot(p, A), p[1]], poly))) inside.push(k);
    }
    const [a1, b1] = this.loopNodes(1);
    let d1 = 0;
    for (let i = a1; i <= b1; i++) d1 += dot(nodeOf(r, i), N) / (b1 - a1 + 1);
    const behind = dot(plug[0], N) - d1;
    return { ok: inside.length === 0 || behind < -0.015, text: `plug inside the outline of loops [${inside.join(',')}], ${(behind * 100).toFixed(1)} cm along N from loop 1 (− behind)` };
  }

  /** the end of the bake: final shapes and the summary (printed) */
  summary(): { ok: boolean; lines: string[]; data: Record<string, unknown> } {
    const rod = this.rod;
    const lines: string[] = [];
    let ok = true;
    const check = (name: string, pass: boolean, value: unknown) => {
      if (!pass) ok = false;
      lines.push(`CHECK ${pass ? 'ok  ' : 'FAIL'} ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    };
    for (const res of this.results) {
      const s = this.shape(res.k);
      res.aspectEnd = +(s.width / s.height).toFixed(3);
      res.width = +s.width.toFixed(3);
      res.height = +s.height.toFixed(3);
    }
    lines.push(...this.log);
    for (const r of this.results) lines.push(`loop ${r.k} ${r.kind}: length ${r.length.toFixed(3)} m, w/h laid ${r.aspectLaid}, end ${r.aspectEnd} (${(r.width * 100).toFixed(1)} × ${(r.height * 100).toFixed(1)} cm), twist in the loop ${r.loopTwist}, coil Lk so far ${r.coilLk}, twist hanging ${r.hangTwist}, to the floor ${r.floorTwist}, crossings (depth along N: − Noor's side, + behind) ${JSON.stringify(r.crossDepth)}${r.kind === 'under' ? `, forearm through the loop ${r.wristIn.toFixed(2)} s` : ''}`);
    const coilEnd = coilLink(rod, this.sEdge[this.sEdge.length - 1]);
    lines.push(`the coil pulled apart along its axis (Lk, ends −N/+N): ${coilEnd.toFixed(2)} (start ${this.coilLk0}); stats ${JSON.stringify(rod.stats)}`);
    const lowest = (r: LoopResult) => (r.crossDepth.length ? r.crossDepth[r.crossDepth.length - 1] : NaN);
    check('all loops laid', this.results.length === this.plan.kinds.length, this.results.length);
    check('loops round (width/height ≥ 0.6 at the end)', this.results.every((r) => r.aspectEnd >= 0.6), this.results.map((r) => r.aspectEnd));
    check('loop lengths within 5 cm of the plan', this.results.every((r) => Math.abs(r.length - this.plan.loopLength) < 0.05), this.results.map((r) => +r.length.toFixed(3)));
    check('over: the cable to the floor crosses the new loop on Noor\'s side (−); under: behind it (+)', this.results.every((r) => r.crossDepth.length > 0 && (r.kind === 'over' ? lowest(r) < 0 : lowest(r) > 0)), this.results.map((r) => `${r.kind} ${JSON.stringify(r.crossDepth)}`).join(' · '));
    check('under: the forearm passes through the forming loop ≥ 0.4 s', this.results.every((r) => r.kind === 'over' || r.wristIn >= 0.4), this.results.filter((r) => r.kind === 'under').map((r) => +r.wristIn.toFixed(2)));
    check('no free cable deeper than 1.5 mm in a hand, forearm or leg', this.pen.max < 0.0015, `${(this.pen.max * 1000).toFixed(2)} mm (${this.pen.where})`);
    check('no held cable deeper than 1.5 mm in the other hand', this.penHeld.max < 0.0015, `${(this.penHeld.max * 1000).toFixed(2)} mm (${this.penHeld.where})`);
    check('no kinks: bend radius ≥ 15 mm free, ≥ 10 mm at the hands', this.kink.free >= 0.015 && this.kink.fingers >= 0.01, `free ${(this.kink.free * 1000).toFixed(1)} mm (${this.kink.freeWhere}), at the hands ${(this.kink.fingers * 1000).toFixed(1)} mm (${this.kink.fingersWhere})`);
    check('the coil and the forming loop move calmly (< 1.5 m/s, < 2 cm per frame)', this.speed.max < 1.5, `${this.speed.max.toFixed(2)} m/s, ${(this.speed.jump * 1000).toFixed(1)} mm in a frame (${this.speed.where})`);
    check('no capped speeds', rod.stats.speedCapped === 0, rod.stats.speedCapped);
    check('the fist stays closed (open ≤ 0.2 away from the hand-overs)', this.openMax.v <= 0.2, `${this.openMax.v.toFixed(2)} ${this.openMax.where}`);
    const plug = this.plugCheck();
    check('the plug stays outside the coil', plug.ok, plug.text);
    if (this.o.fetchEnd) {
      const left = this.endHeldAt === null ? NaN : rod.totalLength - this.endHeldAt;
      check('the end is fetched: the right hand holds it within 20 cm of the plug, beside the fist', left <= 0.2 && !this.pin.lost, `${(left * 100).toFixed(0)} cm from the end`);
    }
    check('IK: no hard limits, every grip reached', this.ikGroups.size === 0, [...this.ikGroups].map(([k, g]) => `${k}: ${g.n} frames, t ${g.t0.toFixed(2)}–${g.t1.toFixed(2)}${g.worst ? `, worst ${g.worst.toFixed(1)} mm` : ''}`).join('; ') || 'none');
    check('pinch never lost', !this.pin.lost, this.pin.lost);
    check('no simulation warnings (cable got away, grips off the cable, ...)', rod.warnings.length === 0, rod.warnings.slice(0, 4).join(' | ') || 'none');
    return { ok, lines, data: { results: this.results } };
  }

  // ---------------------------------------------------------------- recording

  private record(out: number[]): number[] {
    const arms = this.pose.body.arms!;
    ARM_JOINTS.forEach((j, n) => {
      out[REC.L + n] = arms[0].angles[j];
      out[REC.R + n] = arms[1].angles[j];
    });
    const r = this.right.rig;
    out[REC.H] = this.leftOpen;
    out[REC.H + 1] = r.open ?? 0;
    out[REC.H + 2] = r.roll ?? 0;
    out[REC.H + 3] = r.cross ?? 0.3;
    out[REC.H + 4] = r.hold === 'pinch' ? 1 : 0;
    out[REC.H + 5] = r.curl ?? 0.25;
    out[REC.H + 6] = this.right.turn;
    out[REC.H + 7] = r.thumbWeight ?? 0;
    out[REC.LOOK] = this.lookAt[0];
    out[REC.LOOK + 1] = this.lookAt[1];
    out[REC.LOOK + 2] = this.lookAt[2];
    out[REC.FR] = this.leftR;
    out[REC.LIFT] = this.leftLift;
    return out;
  }
}

// ------------------------------------------------------------------ geometry helpers

/** even-odd point in polygon (2D) */
export function pointInPoly(p: [number, number], poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1] + 1e-12) + a[0]) inside = !inside;
  }
  return inside;
}

/** the best-fit plane of points: centre and normal (smallest principal axis) */
export function fitPlane(P: V3[]): { c: V3; n: V3 } {
  const c: V3 = [0, 0, 0];
  for (const p of P) for (let k = 0; k < 3; k++) c[k] += p[k] / P.length;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of P) for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) C[r][s] += ((p[r] - c[r]) * (p[s] - c[s])) / P.length;
  const tr = C[0][0] + C[1][1] + C[2][2];
  let v: V3 = [0.3, 0.2, 0.9];
  for (let it = 0; it < 60; it++) {
    const w: V3 = [0, 1, 2].map((r) => (tr - C[r][r]) * v[r] - C[r].reduce((s, x, k) => s + (k === r ? 0 : x * v[k]), 0)) as V3;
    v = normalize(w);
  }
  return { c, n: v };
}

/** width (horizontal in the loop's plane) and height (top: the hand) of a hanging loop */
export function loopShape(P: V3[], top: number): { width: number; height: number } {
  const { n } = fitPlane(P);
  const h = normalize([n[2], 0, -n[0]]);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of P) {
    const x = dot(p, h);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  }
  return { width: x1 - x0, height: Math.max(y1, top) - y0 };
}

/**
 * How often the closed loop P (closed by the chord from its last point to its first) winds round
 * the line through a and b, seen along it (turns, signed); only the loop's points that lie, along
 * the line, between a and b (with `margin` m beyond) count as near it: a loop far off along the line
 * does not wind round this piece of it.
 */
export function windingAround(P: V3[], a: V3, b: V3, margin = 0.03): number {
  const ax = normalize(sub(b, a)), L = lenV(sub(b, a));
  const e1 = normalize(across(Math.abs(ax[1]) < 0.9 ? UP : [1, 0, 0], ax)), e2 = crossV(ax, e1);
  let total = 0, near = false;
  const ang = (p: V3) => {
    const v = sub(p, a);
    return Math.atan2(dot(v, e2), dot(v, e1));
  };
  for (let i = 0; i < P.length; i++) {
    const p = P[i], q = P[(i + 1) % P.length];
    const u = dot(sub(p, a), ax);
    if (u > -margin && u < L + margin) near = true;
    let d = ang(q) - ang(p);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    total += d;
  }
  return near ? total / (2 * Math.PI) : 0;
}

/**
 * Does the cable P lie over the end b of a capsule a-b (a forearm: elbow to wrist) of radius r: a
 * point of it within 3 mm of the capsule's side, at most 8 cm before b, on the capsule's upper half?
 */
export function cableOver(P: V3[], a: V3, b: V3, r: number): boolean {
  const ax = normalize(sub(b, a)), L = lenV(sub(b, a));
  const up = across(UP, ax);
  for (const p of P) {
    // (along the side of the forearm, not round its end at the wrist: the back of the hand is thinner)
    const u = dot(sub(p, a), ax);
    if (u > L + 0.012 || u < L - 0.08) continue;
    const c = madd(a, ax, u), v = sub(p, c);
    if (lenV(v) - r - RC < 0.003 && dot(v, up) > -0.3 * r) return true;
  }
  return false;
}

/** does the segment a-b pass through the closed loop P (its best-fit plane, inside its outline)? */
export function segmentThroughLoop(P: V3[], a: V3, b: V3): boolean {
  const { c, n } = fitPlane(P);
  const da = dot(sub(a, c), n), db = dot(sub(b, c), n);
  if (da * db > 0) return false;
  const u = da / (da - db + 1e-12);
  const x = lerpV(a, b, u);
  const e1 = normalize(across(Math.abs(n[1]) < 0.9 ? UP : [1, 0, 0], n));
  const e2 = crossV(n, e1);
  const poly = P.map((p): [number, number] => [dot(sub(p, c), e1), dot(sub(p, c), e2)]);
  return pointInPoly([dot(sub(x, c), e1), dot(sub(x, c), e2)], poly);
}

// ------------------------------------------------------------------ the pull-apart twist

/**
 * Lk = Tw + Wr of a piece of cable (segments j0 … j1) with its two ends drawn out far along
 * dirStart and dirEnd (Călugăreanu: with the ends' rotation fixed, pulling the piece straight that
 * way turns its writhe into twist). Positions x (3 per node) and segment quaternions q.
 */
export function linkOf(x: ArrayLike<number>, q: ArrayLike<number>, j0: number, j1: number, dirStart: V3, dirEnd: V3): number {
  const m = j1 - j0 + 2;
  const p = new Float64Array(3 * (m + 2));
  const far = 50;
  for (let k = 0; k < m; k++) for (let c = 0; c < 3; c++) p[3 * (k + 1) + c] = x[3 * (j0 + k) + c];
  for (let c = 0; c < 3; c++) {
    p[c] = p[3 + c] + dirStart[c] * far;
    p[3 * (m + 1) + c] = p[3 * m + c] + dirEnd[c] * far;
  }
  return twistTurns(q, j0, j1) + writhe(p, 0, m + 1);
}

/**
 * What pulling the coil apart along its axis would leave in it (the cable beyond it free to turn):
 * Lk of the cable from the plug to material s (the coil's last strand), its ends drawn out behind
 * the coil (−N, the plug strand is the backmost) and in front of it (+N, the newest strand).
 */
export function coilLink(rod: Rod, s: number): number {
  const j1 = rod.segmentAt(s);
  return j1 > 2 ? linkOf(rod.x, rod.q, 0, j1, mul(GEOM.N, -1), GEOM.N) : 0;
}

// ------------------------------------------------------------------ playback in the scene

/**
 * Noor's pose in the scene, from a coiling bake: the recorded arm angles (interpolated between
 * frames, kept inside the joint limits) and hand shapes, the same stance and look as the bake.
 */
export class CoilReplay {
  private readonly v: number[] = new Array(REC.size).fill(0);

  constructor(
    readonly bake: BakedRod,
    readonly spec: PersonSpec = NOOR,
  ) {}

  /** the rig at time t (hand shapes as recorded) and the recorded arm angles */
  at(t: number): { rig: Rig; angles: [ArmAngles, ArmAngles]; turn: number } {
    const v = this.bake.vector('rec', t, this.v) as number[];
    const ang = (o: number): ArmAngles => {
      const q = ARM_JOINTS.map((_, n) => v[o + n]);
      projectToLimits(q);
      return Object.fromEntries(ARM_JOINTS.map((j, n) => [j, q[n]])) as unknown as ArmAngles;
    };
    const gl = this.bake.frame('gripL', t), gr = this.bake.frame('gripR', t);
    const H = REC.H;
    const left: HandRig = { grip: gl, hold: 'coil', radius: v[REC.FR], open: v[H], thumbLift: v[REC.LIFT], thumbAlong: 1 };
    const right: HandRig = v[H + 4] > 0.5
      ? { grip: gr, hold: 'pinch', radius: RC, open: v[H + 1], roll: v[H + 2], cross: v[H + 3] }
      : { wrist: gr.p, curl: v[H + 5] };
    const rig: Rig = { ...coilStance(this.spec), look: [v[REC.LOOK], v[REC.LOOK + 1], v[REC.LOOK + 2]], hands: [left, right] };
    return { rig, angles: [ang(REC.L), ang(REC.R)], turn: v[H + 6] };
  }

  pose(t: number): Pose {
    const a = this.at(t);
    return rigPose(this.spec, a.rig, undefined, a.angles);
  }
}
