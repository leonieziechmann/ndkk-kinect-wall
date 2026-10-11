// The coiling engine: Noor's arms (people/rig.ts, stateful IK) drive the cable simulation (sim/
// grips.ts: a pinch in the right hand, the coil as a bundle in the left), frame by frame during the
// bake, and the controller reads the cable as it goes (sim in the loop): the right hand's pinch
// stays on the cable and slides along it, it holds as soon as a loop length of cable has passed,
// the strand it lays across the left hand is taken by the bundle where it really lies, and every
// grip frame the simulation uses is the frame the arm really reached. The arms' angles and the hand
// shapes go into the bake (vectors), so the scene shows exactly what the simulation saw
// (CoilReplay).
//
// Reusable: a CoilPlan (kinds, paces) makes any coiling shot (stage 1: s1-coil.ts; stage 3 later
// with slower paces and more pauses). The choreography is described in coiling.ts.

import { ARM_JOINTS, ArmAngles, projectToLimits } from '../people/ik';
import { handColliders } from '../people/colliders';
import { NOOR } from '../people/cast';
import type { PersonSpec, Pose } from '../people/people';
import { HandRig, Rig, RigIK, gripFrame, rigPose, stand, turnWithForearm } from '../people/rig';
import {
  BakedRod, Bundle, Capsule, Frame, Pinch, Quat, Rod, V3, VectorTrack, buildCable, frameTrack, normalize, quatRotate, quatSlerp, twistTurns, writhe,
  XLR,
} from '../sim';
import { CoilPlan, GEOM, LoopBeat, LOOSEN, beats, loopAt } from './coiling';
import type { ShotBuild } from './types';

const DT = 1 / 60;
const UP: V3 = [0, 1, 0];
const RC = XLR.od / 2;

// ------------------------------------------------------------------ small vector helpers

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const madd = (a: V3, b: V3, s: number): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
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

// ------------------------------------------------------------------ the left hand's frame

/** from the strands' axis to the palm (palm up and towards the midline) */
const TO_PALM: V3 = (() => {
  const down = across([0, -1, 0], GEOM.S);
  const side = normalize([
    GEOM.N[1] * GEOM.S[2] - GEOM.N[2] * GEOM.S[1],
    GEOM.N[2] * GEOM.S[0] - GEOM.N[0] * GEOM.S[2],
    GEOM.N[0] * GEOM.S[1] - GEOM.N[1] * GEOM.S[0],
  ]);
  return normalize(madd(down, side, Math.tan((20 * Math.PI) / 180)));
})();

/** the coil's axis N in the left grip's own frame (component across the strands) */
const N_LOCAL: V3 = (() => {
  const q = gripFrame([0, 0, 0], GEOM.S, TO_PALM).q;
  const nq = across(GEOM.N, GEOM.S);
  const inv: Quat = [-q[0], -q[1], -q[2], q[3]];
  return quatRotate(inv, nq);
})();

/** the left grip frame (as planned) at point p */
export const leftGrip = (p: V3): Frame => gripFrame(p, GEOM.S, TO_PALM);

/** a point of the stack in a (reached) left grip frame: strand k, `along` metres along the strands (+ = lateral) */
export function stackPoint(f: Frame, k: number, along: number): V3 {
  const n = quatRotate(f.q, N_LOCAL);
  const s = quatRotate(f.q, [0, 0, 1]);
  return add(add(f.p, mul(n, GEOM.stack(k))), mul(s, along));
}

// ------------------------------------------------------------------ the record (bake vectors)

/** per frame: left angles (9), right angles (9), hand shapes, the look point, the under turn */
export const REC = {
  size: 9 + 9 + 8 + 3,
  /** offsets */
  L: 0,
  R: 9,
  /** left open, right open, roll, cross, pinch (1) or free hand (0), free-hand curl, under turn 0..1, thumbWeight */
  H: 18,
  LOOK: 26,
} as const;

/** what a hand does in a frame: the rig and the values recorded for the scene */
interface RightState {
  rig: HandRig;
  turn: number;
}

/** per-loop results, printed and checked at the end of the bake */
export interface LoopResult {
  k: number;
  kind: 'over' | 'under';
  /** cable in the loop, edge to edge [m] */
  length: number;
  /** material at the left hand's medial edge after the loop */
  sEdge: number;
  /** width / height of the hanging loop in the coil plane, right after it was laid and at the end */
  aspectLaid: number;
  aspectEnd: number;
  width: number;
  height: number;
  /** where the cable to the floor crosses the new loop (seen along N): + in front of it (away from Noor), − behind */
  crossDepth: number[];
  /** the loop's own Lk (Tw + Wr, its ends drawn out sideways): ±1 over and under, opposite signs */
  lk: number;
  /** twist in the cable beyond the right hand (to the floor) right after the hand-over [turns] */
  floorTwist: number;
}

export interface CoilOptions {
  spec?: PersonSpec;
  /** cable length [m] */
  length?: number;
  /** seconds of settling before shot time 0 */
  preroll?: number;
}

/** the stance (Noor stands at the origin facing -z) */
export function coilStance(spec: PersonSpec): Pick<Rig, 'pos' | 'yaw' | 'feet' | 'lean'> {
  return { ...stand(spec, [0, 0], 0, { width: 0.3 }), lean: 0.06 };
}

// ------------------------------------------------------------------ the controller

/**
 * Builds the cable and runs a coiling plan on it. Use it inside a ShotDef.build():
 *   const ctl = new CoilController(plan); return ctl.build(duration);
 */
export class CoilController {
  readonly spec: PersonSpec;
  readonly bs: LoopBeat[];
  readonly results: LoopResult[] = [];
  readonly warnings: string[] = [];
  rod!: Rod;
  pin!: Pinch;
  coil!: Bundle;
  /** material at the left hand's medial edge: [0] the plug strand, [k] after loop k */
  readonly sEdge: number[] = [];
  /** the plug strand in the left hand [s0, s1] */
  plugStrand: [number, number] = [0, 0];
  private readonly ik = new RigIK(DT);
  private pose!: Pose;
  private tPose = 0;
  private capsA: Capsule[] = [];
  private capsB: Capsule[] = [];
  private tCapsA = 0;
  private legs: Capsule[] = [];
  private right!: RightState;
  private lookAt: V3 = [-0.05, 0.75, -0.35];
  private leftOpen = 0;
  private started = false;
  // per loop memo (set as the bake passes the beats)
  private memo: {
    k: number;
    /** the pads' frame when the loop started */
    p0: V3;
    q0: Quat;
    /** under: the pose and pads frame reached at the hip, and the pads' frame wanted at the hand-over */
    outPose: Pose | null;
    outQ: Quat | null;
    homeQ: Quat | null;
    /** the pads' frame at the hand-over */
    qMeet: Quat | null;
    /** where the cable is at the left hand's medial edge (read at the loop's start), in the left grip's frame */
    gripLocal: V3 | null;
    /** the roll the hand turns to on the way back, so that the cable's remembered bend curls into the loop */
    rollTo: number | null;
    gripped: boolean;
    held: boolean;
    added: boolean;
  } | null = null;
  /** the roll each loop ended with */
  private readonly rolls: number[] = [];
  private maxPen = 0;
  private maxPenWhere = '';
  private ikIssues: string[] = [];

  constructor(
    readonly plan: CoilPlan,
    readonly o: CoilOptions = {},
  ) {
    this.spec = o.spec ?? NOOR;
    this.bs = beats(plan);
  }

  /** shot time when the last loop is done */
  get tDone() {
    return this.bs[this.bs.length - 1].t1;
  }

  // ---------------------------------------------------------------- the rig

  /** the left hand's planned grip point at time t: with the right hand at the start, out while it slides, back to meet it */
  leftPoint(t: number): V3 {
    const g = GEOM;
    const i = loopAt(this.bs, t);
    if (i < 0) return g.leftMeet;
    const b = this.bs[i];
    if (t < b.tOut) return lerpV(g.leftMeet, g.leftOut, ramp(t, b.tSlide - 0.05, b.tOut));
    if (t < b.tTurned) return g.leftOut;
    if (t < b.tMeet) return lerpV(g.leftOut, g.leftMeet, ramp(t, b.tTurned, b.tMeet - 0.05));
    if (i === this.bs.length - 1 && t > b.t1) return lerpV(g.leftMeet, g.leftRest, ramp(t, b.t1 + 0.2, b.t1 + 1.2));
    return g.leftMeet;
  }

  private leftRig(t: number): HandRig {
    return { grip: leftGrip(this.leftPoint(t)), hold: 'coil', radius: GEOM.bundle, open: this.leftOpen, free: 0.4 };
  }

  /**
   * Where the right pads go at the hand-over of loop i: the lateral end of the left hand, at the new
   * strand's place in the stack (the loop hangs from there down the lateral side; the cable behind
   * the pads lies across the open left hand and down from its medial edge)
   */
  private meetPoint(i: number, t: number): V3 {
    const f = leftGrip(this.leftPoint(t));
    return stackPoint(f, this.bs[i].k, GEOM.half - 0.01);
  }

  /** where the right hand takes the cable at the start of loop i: just beyond the left hand's medial edge, where the last strand comes out */
  private gripPoint(i: number, t: number): V3 {
    const f = leftGrip(this.leftPoint(t));
    const m = this.memo;
    if (m && m.k === this.bs[i].k && m.gripLocal) return add(f.p, quatRotate(f.q, m.gripLocal));
    return stackPoint(f, this.bs[i].k - 1, -(GEOM.half + GEOM.gap));
  }

  /** the medial edge of the left hand where strand k comes out */
  private exitPoint(k: number, t: number): V3 {
    return stackPoint(leftGrip(this.leftPoint(t)), k, -GEOM.half);
  }

  /** the right hand's pinch: point, cable direction past the thumb tip (towards the coil), and the shape */
  private pinchRig(p: V3, d3: V3, o: { roll?: number; open?: number; cross?: number; out?: number; free?: number; q?: Quat }): HandRig {
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
    };
  }

  /** the right hand at time t (uses the per-loop memo the controller sets as it passes the beats) */
  private rightAt(t: number): RightState {
    const g = GEOM;
    const i = loopAt(this.bs, t);
    if (i < 0 || !this.memo) {
      // before the first loop: pinching next to the left hand, the thumb tip towards it
      return { rig: this.pinchRig(madd(this.exitPoint(0, t), g.S, -g.gap), g.S, {}), turn: 0 };
    }
    const b = this.bs[i];
    const m = this.memo;
    const last = i === this.bs.length - 1;
    const exit = this.exitPoint(b.k - 1, t);
    const grip = this.gripPoint(i, t);
    const meet = this.meetPoint(i, t);
    // the span's direction at the pads: towards the left hand's edge, drooping a little
    const spanDir = (p: V3) => {
      const d = sub(exit, p);
      return normalize(madd(d, [0, -1, 0], 0.25 * lenV(d)));
    };
    // at the hand-over the loop hangs from the thumb tip down the lateral side
    const laying = normalize(madd(g.S, [0, -1, 0], 0.7));
    // after the last loop: the hand opens and leaves the coil
    if (last && t >= b.t1) {
      const away = madd(madd(meet, UP, 0.08), g.S, -0.12);
      const p = lerpV(meet, away, ramp(t, b.t1, b.t1 + 0.6));
      const rig = this.pinchRig(p, laying, { q: m.qMeet ?? undefined, free: 1, open: ramp(t, b.t1, b.t1 + 0.2) });
      return { rig, turn: 0 };
    }
    // the open hand moves from the last hand-over over the left hand to its medial edge and takes the cable there
    if (t < b.tGrip) {
      const u = ramp(t, b.t0, b.tGrip);
      const mid = madd(lerpV(m.p0, grip, 0.5), UP, 0.035);
      const p = u < 0.5 ? lerpV(m.p0, mid, minJerk(u * 2) * 0.999 + 0.001 * u) : lerpV(mid, grip, minJerk((u - 0.5) * 2));
      const q = quatSlerp(m.q0, gripFrame(grip, g.S, [0, 0, 1]).q, u);
      const rig = this.pinchRig(p, g.S, { q, free: u, open: 1 - ramp(t, b.tGrip - 0.12, b.tGrip), roll: this.prevRoll(i) * (1 - u) });
      return { rig, turn: this.turnLeft(i, t) };
    }
    // where the hand is: slide out, a little slack at the hip, back to where the loop hangs open
    // between the hands (wide, so it falls round), over the left hand and down onto its lateral end
    const sh = normalize([g.S[0], 0, g.S[2]]);
    const slack = lerpV(g.hip, exit, 0.06);
    const spread = madd(madd(madd(exit, sh, -0.24), UP, 0.0), g.N, 0.05);
    const above = madd(madd(meet, UP, 0.08), g.N, 0.015);
    const tBack = Math.max(b.tTurned, b.tHeld);
    const tAbove = b.tSpread + 0.6 * (b.tMeet - b.tSpread);
    let p: V3;
    if (t < b.tOut) p = lerpV(m.p0, g.hip, ramp(t, b.tSlide, b.tOut));
    else if (t < tBack) p = lerpV(g.hip, slack, ramp(t, b.tOut, tBack));
    else if (t < b.tSpread) p = lerpV(slack, spread, ramp(t, tBack, b.tSpread));
    else if (t < tAbove) p = lerpV(spread, above, ramp(t, b.tSpread, tAbove));
    else p = lerpV(above, meet, ramp(t, tAbove, b.tMeet));
    // how far out (0 next to the coil … 1 at the hip): shapes the pinch (cross, palm wish)
    const out = t < b.tOut ? ramp(t, b.tSlide, b.tOut) : t < tBack ? 1 : 1 - ramp(t, tBack, b.tSpread);
    const cross = 0.3 + 0.9 * out;
    // the pinch loosens while sliding (visible: the thumb lifts a little)
    const open = t < b.tOut ? 0.4 * ramp(t, b.tGrip, b.tSlide) * (1 - ramp(t, b.tOut - 0.15, b.tOut)) : 0;
    // the roll on the way back: over +, under −
    const sign = b.kind === 'over' ? 1 : -1;
    const roll = t < tBack ? this.prevRoll(i) * (1 - ramp(t, b.tGrip, b.tSlide + 0.3)) : (m.rollTo ?? sign * g.roll) * ramp(t, tBack, b.tSpread);
    // the cable's direction: along the span, then turning down the lateral side for the hand-over
    const w = ramp(t, b.tSpread, b.tMeet);
    const d3 = normalize(lerpV(spanDir(p), laying, w));
    if (b.kind === 'over' || t < b.tHeld) return { rig: this.pinchRig(p, d3, { roll, open, cross, out }), turn: this.turnLeft(i, t) };
    // under: turn the hold frame about the forearm, unwinding into the hand-over frame on the way back
    const turn = t < b.tTurned ? ramp(t, b.tHeld, b.tTurned) : 1 - 0.7 * ramp(t, b.tSpread - 0.2, b.tMeet);
    const home = ramp(t, b.tSpread - 0.3, b.tMeet);
    const outPose = m.outPose ?? this.pose;
    const base: Frame = { p, q: quatSlerp(m.outQ ?? m.q0, m.homeQ ?? m.q0, home) };
    const rig = this.pinchRig(p, d3, { roll, open: 0, cross: 0.3 + 0.9 * (1 - home), out, free: 0, q: turnWithForearm(outPose, 1, base, g.underTurn * turn).q });
    rig.thumbTo = undefined;
    rig.prefer = [];
    return { rig, turn };
  }

  /** the roll the last loop left on the cable (0 before the first) */
  private prevRoll(i: number): number {
    return i > 0 ? (this.rolls[i - 1] ?? 0) : 0;
  }

  /** an under loop's turn still to undo at the start of the next loop (for the arrow and the rig) */
  private turnLeft(i: number, t: number): number {
    if (i < 1 || this.bs[i - 1].kind !== 'under') return 0;
    return 0.3 * (1 - ramp(t, this.bs[i].t0, this.bs[i].tGrip));
  }

  /** the whole rig at time t */
  rigAt(t: number): Rig {
    this.right = this.rightAt(t);
    return { ...coilStance(this.spec), look: this.lookAt, hands: [this.leftRig(t), this.right.rig] };
  }

  // ---------------------------------------------------------------- the cable

  /** the cable at shot time 0: the plug end in the left hand, down from the right hand to the floor, then in loose bends to her right front */
  private initialPoints(length: number): V3[] {
    const g = GEOM;
    const f = leftGrip(g.leftRest);
    const pts: V3[] = [];
    // the plug end hangs out of the hand on the lateral side (2 cm on, a bend, 4 cm down, the plug
    // pointing down), then the strand runs across the hand to its medial edge and on to the pads
    const lat = stackPoint(f, 0, g.half);
    const sDir = quatRotate(f.q, [0, 0, 1]);
    const rb = 0.02;
    const c0 = madd(madd(lat, sDir, 0.02), UP, -rb);
    const tip = madd(madd(c0, sDir, rb), UP, -(0.04 + 0.06));
    for (let y = 0; y <= 0.1; y += 0.002) pts.push(madd(tip, UP, y));
    for (let a = 0; a <= Math.PI / 2; a += 0.04) pts.push(add(c0, add(mul(sDir, rb * Math.cos(a)), mul(UP, rb * Math.sin(a)))));
    for (let s = 0.02; s >= -(2 * g.half + g.gap); s -= 0.002) pts.push(madd(lat, sDir, s));
    // from the pads down: a quarter circle into a hanging line, a bend onto the floor, then bends
    const pads = pts[pts.length - 1];
    const R1 = 0.12;
    const h = normalize([-sDir[0], 0, -sDir[2]]);
    const c1 = madd(pads, UP, -R1);
    for (let a = 0.05; a <= Math.PI / 2; a += 0.02) pts.push(add(c1, add(mul(h, R1 * Math.sin(a)), mul(UP, R1 * Math.cos(a)))));
    let p = pts[pts.length - 1];
    const bottom = RC + 0.1;
    while (p[1] > bottom) {
      p = madd(madd(p, UP, -0.004), [0.1, 0, -0.25], 0.004 * 0.3);
      pts.push(p);
    }
    const c2: V3 = [p[0] + 0.1, RC + 0.1, p[2]];
    for (let a = 0.02; a <= Math.PI / 2; a += 0.02) pts.push([c2[0] - 0.1 * Math.cos(a), c2[1] - 0.1 * Math.sin(a), c2[2]]);
    p = pts[pts.length - 1];
    let used = 0;
    for (let i = 1; i < pts.length; i++) used += lenV(sub(pts[i], pts[i - 1]));
    // on the floor: loose bends, away to her right front
    let head = -0.35;
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
    // a used cable: it has been coiled over and under in loops of this size before (BuildCableOptions.memory)
    const s0 = 0.1 + (Math.PI / 2) * 0.02 + 0.02;
    const built = buildCable(XLR, this.initialPoints(length), { plugs: 'both', memory: { loop: this.plan.loopLength, start: s0 + 2 * GEOM.half, overUnder: true } });
    const rod = (this.rod = built.rod);
    const g = GEOM;
    // the plug strand: its lateral end is ~0.17 m from the plug tip (plug, 4 cm down, the bend, 2 cm); the medial edge 9 cm further
    this.plugStrand = [s0, s0 + 2 * g.half];
    this.sEdge.push(s0 + 2 * g.half);

    // the legs and the trunk (the coil hangs in front of the left thigh)
    const pose0 = rigPose(this.spec, this.rigAt(0));
    const J = pose0.joints;
    this.legs = [
      { a: J[11], b: J[13], r: 0.068 },
      { a: J[12], b: J[14], r: 0.068 },
      { a: J[13], b: J[15], r: 0.05 },
      { a: J[14], b: J[16], r: 0.05 },
      { a: J[18], b: J[17], r: 0.13 },
    ];

    // settle with the hands holding (the IK too)
    const pre = this.o.preroll ?? 1.5;
    rod.time = -pre;
    this.solve(-pre, true);
    this.coil = rod.bundle({ frame: this.pose.body.arms![0].grip!, hand: 0, blend: 0.01 });
    this.coil.add(this.plugStrand[0], this.plugStrand[1] + 0.004, 0.01);
    this.pin = rod.pinch({ frame: this.pose.body.arms![1].grip!, hand: 1, mode: 'held', blend: 0.01 });
    rod.setCapsules((tt) => this.capsAt(tt));
    const frames = Math.round(pre * 60);
    for (let f = 0; f < frames; f++) {
      this.solve(rod.time + DT, false);
      rod.step(DT, XLR.substeps);
    }
    rod.time = 0;
    this.solve(0, true);
    this.started = false;

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
      ...handColliders(pose, 1, { group: 1, soft: { index: 0.3, middle: 0.3, ring: 0.3, little: 0.3, thumb: 0.3 } }),
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
      if (r.atLimit.length && this.ikIssues.length < 40) this.ikIssues.push(`t ${tn.toFixed(2)} ${i ? 'R' : 'L'} at limit ${r.atLimit.join(',')}`);
      if (!r.reached && this.ikIssues.length < 40) this.ikIssues.push(`t ${tn.toFixed(2)} ${i ? 'R' : 'L'} not reached ${(r.posError * 1000).toFixed(1)} mm`);
    }
    if (this.coil) {
      if (jump) {
        this.coil.setFrame(arms[0].grip!);
        this.pin.setFrame(arms[1].grip!);
      } else {
        this.coil.moveTo(arms[0].grip!, DT);
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
    // the left hand opens for the new strand and closes over it
    const i = loopAt(this.bs, tn);
    if (i >= 0) {
      const b = this.bs[i];
      this.leftOpen = tn < b.tMeet ? 0.5 * ramp(tn, b.tSpread - 0.1, b.tMeet - 0.1) : 0.5 * (1 - ramp(tn, b.tMeet + 0.05, b.t1));
    }
    // look at the middle between the hands, a little towards the coil
    const lp = this.leftPoint(tn), rp = this.pose.body.arms![1].grip!.p;
    const want = lerpV(lp, rp, 0.35);
    this.lookAt = lerpV(this.lookAt, [want[0], want[1] - 0.12, want[2] - 0.05], 0.06);
    this.solve(tn, false);
    this.measure(rod, t);
  }

  /** the beats that need the cable: let go and take it again next to the left hand, hold after a loop length, the hand-over */
  private events(rod: Rod, t: number) {
    const tn = t + DT;
    const i = loopAt(this.bs, tn);
    if (i < 0) return;
    const b = this.bs[i];
    const pin = this.pin;
    const arms = this.pose.body.arms!;
    if (!this.memo || this.memo.k !== b.k) {
      // a new loop: the hand lets go at the hand-over (the first loop: it already holds next to the left hand)
      this.memo = { k: b.k, p0: arms[1].grip!.p, q0: arms[1].pads!.q, outPose: null, outQ: null, homeQ: null, qMeet: null, gripLocal: null, rollTo: null, gripped: false, held: false, added: false };
      if (i > 0) {
        // the hand goes where the cable really comes out of the left hand
        const lf = arms[0].grip!;
        const pt = rod.pointAt(this.sEdge[b.k - 1] + GEOM.gap);
        const inv: Quat = [-lf.q[0], -lf.q[1], -lf.q[2], lf.q[3]];
        this.memo.gripLocal = quatRotate(inv, sub(pt, lf.p));
      }
      if (i > 0) pin.release(0.12);
    }
    const m = this.memo;
    const edge = this.sEdge[b.k - 1];
    if (!m.gripped && tn >= b.tGrip) {
      // the pads close loosely on the cable between them, next to the left hand
      pin.set('loose', LOOSEN);
      m.gripped = true;
    }
    // hold as soon as a loop's worth has passed through the pads (or at the hip at the latest)
    const sHold = edge + this.plan.loopLength - 2 * GEOM.half + 0.01;
    if (m.gripped && !m.held && tn >= b.tSlide && (pin.s >= sHold || tn >= b.tOut)) {
      pin.set('held', 0.25);
      m.held = true;
    }
    if (b.kind === 'under' && !m.outPose && tn >= b.tHeld) {
      // the frame the hand reached at the hip, and the frame it should have at the hand-over
      m.outPose = this.pose;
      m.outQ = arms[1].pads!.q;
      const laying = normalize(madd(GEOM.S, [0, -1, 0], 0.7));
      const home = rigPose(this.spec, { ...coilStance(this.spec), look: this.lookAt, hands: [this.leftRig(b.tMeet), this.pinchRig(this.meetPoint(i, b.tMeet), laying, {})] });
      m.homeQ = home.body.arms![1].pads!.q;
    }
    if (m.held && m.rollTo === null && tn >= Math.max(b.tTurned, b.tHeld)) {
      // roll the cable so that its remembered bend curls down into the hanging loop (a used cable)
      const d = pin.rollToCurl([0, -1, 0]);
      const now = this.right.rig.roll ?? 0;
      m.rollTo = d === null ? (b.kind === 'over' ? 1 : -1) * GEOM.roll : Math.max(-1.3, Math.min(1.3, now + d));
    }
    if (!m.added && tn >= b.tMeet - 0.02) {
      // the cable behind the pads lies across the open left hand: the coil takes it where it lies
      const s0 = pin.s;
      this.coil.add(s0 + 0.005, s0 + 2 * GEOM.half, 0.2);
      const s1 = s0 + 2 * GEOM.half - 0.01;
      this.sEdge.push(s1);
      m.added = true;
      this.results.push({ k: b.k, kind: b.kind, length: s1 - edge, sEdge: s1, aspectLaid: 0, aspectEnd: 0, width: 0, height: 0, crossDepth: [], lk: 0, floorTwist: 0 });
    }
    if (m.added && !m.qMeet && tn >= b.t1 - DT) {
      m.qMeet = arms[1].pads!.q;
      this.rolls[i] = this.right.rig.roll ?? 0;
    }
    if (i === this.bs.length - 1 && m.added && tn >= b.t1 && pin.state !== 'free') pin.release(0.15);
  }

  // ---------------------------------------------------------------- measuring

  /** the loop's free part (outside the left hand) as node indices */
  loopNodes(k: number): [number, number] {
    const r = this.rod;
    return [r.segmentAt(this.sEdge[k - 1]) + 1, r.segmentAt(this.sEdge[k] - 2 * GEOM.half) - 1];
  }

  /** width and height of loop k in the coil plane */
  private shape(k: number): { width: number; height: number } {
    const r = this.rod, [a, b] = this.loopNodes(k);
    const A = GEOM.A;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = a; i <= b; i++) {
      const p: V3 = [r.x[3 * i], r.x[3 * i + 1], r.x[3 * i + 2]];
      const x = dot(p, A), y = p[1];
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    // the top is the hand
    const top = Math.max(y1, this.pose.body.arms![0].grip!.p[1]);
    return { width: x1 - x0, height: top - y0 };
  }

  /** crossings of the cable to the floor with loop k, seen along N: depth (floor − loop) along N at each */
  private crossings(k: number): number[] {
    const r = this.rod, [a, b] = this.loopNodes(k);
    const f0 = r.segmentAt(this.sEdge[k] + 0.005), f1 = Math.min(r.n - 2, r.segmentAt(this.sEdge[k] + 0.7));
    const A = GEOM.A, N = GEOM.N;
    const P = (i: number): [number, number, number] => {
      const p: V3 = [r.x[3 * i], r.x[3 * i + 1], r.x[3 * i + 2]];
      return [dot(p, A), p[1], dot(p, N)];
    };
    const out: number[] = [];
    for (let i = f0; i < f1; i++) {
      const p = P(i), q = P(i + 1);
      for (let j = a; j < b; j++) {
        const u = P(j), v = P(j + 1);
        // 2D segment intersection in (A, y)
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

  private measure(rod: Rod, t: number) {
    // the deepest a free piece of cable sits inside a capsule (hands, legs)
    for (const c of rod.currentCapsules()) {
      if (c.r < 0) continue;
      const ax = c.b[0] - c.a[0], ay = c.b[1] - c.a[1], az = c.b[2] - c.a[2], l2 = ax * ax + ay * ay + az * az || 1;
      for (let j = 0; j < rod.ns; j++) {
        if (rod.heldMark[j] || (c.group !== undefined && rod.skipGroup[j] === c.group)) continue;
        const px = rod.c[3 * j] - c.a[0], py = rod.c[3 * j + 1] - c.a[1], pz = rod.c[3 * j + 2] - c.a[2];
        const u = clamp01((px * ax + py * ay + pz * az) / l2);
        const d = c.r + RC - Math.hypot(px - ax * u, py - ay * u, pz - az * u);
        if (d > this.maxPen) {
          this.maxPen = d;
          this.maxPenWhere = `t ${t.toFixed(2)} s ${rod.sNode[j].toFixed(3)} capsule group ${c.group ?? '-'} r ${(c.r * 1000).toFixed(1)}`;
        }
      }
    }
    for (const res of this.results) {
      const b = this.bs[res.k - 1];
      if (!res.aspectLaid && t >= b.t1 + 0.25) {
        const s = this.shape(res.k);
        res.aspectLaid = +(s.width / s.height).toFixed(3);
        res.crossDepth = this.crossings(res.k);
        const j0 = rod.segmentAt(this.sEdge[res.k - 1]), j1 = rod.segmentAt(this.sEdge[res.k]);
        res.lk = +linkOf(rod.x, rod.q, j0, j1, GEOM.A, mul(GEOM.A, -1)).toFixed(2);
        res.floorTwist = +twistTurns(rod.q, rod.segmentAt(this.sEdge[res.k] + GEOM.gap + 0.02), rod.ns - 1).toFixed(2);
      }
    }
  }

  /** the end of the bake: final shapes, the pull-apart twist, and the summary (printed) */
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
    const lk = pullApartTwist(rod);
    for (const r of this.results) lines.push(`loop ${r.k} ${r.kind}: length ${r.length.toFixed(3)} m, w/h laid ${r.aspectLaid}, end ${r.aspectEnd} (${(r.width * 100).toFixed(1)} × ${(r.height * 100).toFixed(1)} cm), Lk ${r.lk}, twist to the floor ${r.floorTwist}, floor-cable crossings (depth along N, + = in front) ${JSON.stringify(r.crossDepth)}`);
    check('all loops laid', this.results.length === this.plan.kinds.length, this.results.length);
    check('loops round (width/height ≥ 0.6 at the end)', this.results.every((r) => r.aspectEnd >= 0.6), this.results.map((r) => r.aspectEnd));
    check('loop lengths within 5 cm of the plan', this.results.every((r) => Math.abs(r.length - this.plan.loopLength) < 0.05), this.results.map((r) => +r.length.toFixed(3)));
    check('pull-apart twist |Tw + Wr| < 0.3 turns', Math.abs(lk.lk) < 0.3, lk);
    check('over and under alternate (each loop\'s Lk: over and under opposite, |Lk| > 0.5)', this.results.every((r, i) => Math.abs(r.lk) > 0.5 && (i === 0 || Math.sign(r.lk) !== Math.sign(this.results[i - 1].lk))), this.results.map((r) => r.lk));
    check('no free cable deeper than 1.5 mm in a hand or leg', this.maxPen < 0.0015, `${(this.maxPen * 1000).toFixed(2)} mm (${this.maxPenWhere})`);
    check('IK: no hard limits, every grip reached', this.ikIssues.length === 0, this.ikIssues.slice(0, 12).join('; ') || 'none');
    check('pinch never lost', !this.pin.lost, this.pin.lost);
    return { ok, lines, data: { results: this.results, lk, maxPen: this.maxPen, ik: this.ikIssues } };
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
    return out;
  }
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
 * What pulling the coil apart by its two plugs would leave in the cable: Lk of the whole cable with
 * the plug end drawn out to her left (+A, away from the coil on the side where it hangs) and the
 * other end to her right (−A).
 */
export function pullApartTwist(rod: Rod): { lk: number; tw: number } {
  const lk = linkOf(rod.x, rod.q, 0, rod.ns - 1, GEOM.A, mul(GEOM.A, -1));
  return { lk: +lk.toFixed(3), tw: +twistTurns(rod.q, 0, rod.ns - 1).toFixed(3) };
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
    const left: HandRig = { grip: gl, hold: 'coil', radius: GEOM.bundle, open: v[H] };
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
