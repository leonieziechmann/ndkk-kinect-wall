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
    p0: V3;
    q0: Quat;
    outPose: Pose | null;
    outQ: Quat | null;
    homeQ: Quat | null;
    held: boolean;
    added: boolean;
    laidAt: number;
  } | null = null;
  private lastHandover: { p: V3; q: Quat } | null = null;
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

  /** the left hand's planned grip point at time t */
  leftPoint(t: number): V3 {
    const g = GEOM;
    const i = loopAt(this.bs, t);
    if (i < 0) return g.leftRest;
    const b = this.bs[i];
    const from = i === 0 ? g.leftRest : g.leftMeet;
    if (t < b.tOut) return lerpV(from, g.leftOut, ramp(t, b.tSlide - 0.05, b.tOut));
    if (t < b.tTurned) return g.leftOut;
    if (t < b.tMeet) return lerpV(g.leftOut, g.leftMeet, ramp(t, b.tTurned, b.tMeet - 0.05));
    if (i === this.bs.length - 1 && t > b.t1) return lerpV(g.leftMeet, g.leftRest, ramp(t, b.t1 + 0.2, b.t1 + 1.2));
    return g.leftMeet;
  }

  private leftRig(t: number): HandRig {
    return { grip: leftGrip(this.leftPoint(t)), hold: 'coil', radius: GEOM.bundle, open: this.leftOpen, free: 0.4 };
  }

  /** where the right pads go at the hand-over of loop i: beyond the left hand's medial edge, at the new strand's place */
  private meetPoint(i: number, t: number): V3 {
    const f = leftGrip(this.leftPoint(t));
    return stackPoint(f, this.bs[i].k, -(GEOM.half + GEOM.gap));
  }

  /** the medial edge of the left hand where the last strand comes out (the cable runs from there to the right hand) */
  private exitPoint(k: number, t: number): V3 {
    return stackPoint(leftGrip(this.leftPoint(t)), k, -GEOM.half);
  }

  /** the right hand's pinch: point, cable direction past the thumb tip (towards the coil), and the shape */
  private pinchRig(p: V3, d3: V3, o: { roll?: number; open?: number; cross?: number; out?: number; free?: number; q?: Quat }): HandRig {
    const out = o.out ?? 0;
    const lp = this.leftPoint(this.tPose);
    const toCoil = normalize([lp[0] - p[0], 0.4 * (lp[1] - p[1]), lp[2] - p[2]]);
    const rig: HandRig = {
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
    return rig;
  }

  /** the right hand at time t (uses the per-loop memo the controller sets as it passes the beats) */
  private rightAt(t: number): RightState {
    const g = GEOM;
    const i = loopAt(this.bs, t);
    if (i < 0 || !this.memo) {
      // before the first loop: pinching next to the left hand
      const p = this.exitPoint(0, t);
      const pads = madd(p, g.S, -g.gap);
      return { rig: this.pinchRig(pads, g.S, {}), turn: 0 };
    }
    const b = this.bs[i];
    const m = this.memo;
    const last = i === this.bs.length - 1;
    // after the last loop: the hand holds on at the hand-over point (the end phase is the shot's)
    if (last && t >= b.t1) {
      const p = this.meetPoint(i, t);
      return { rig: this.pinchRig(p, g.S, { q: m.q0, free: 1 }), turn: 0 };
    }
    const exit = this.exitPoint(b.k - 1, t);
    const meet = this.meetPoint(i, t);
    // the span's direction at the pads: towards the left hand's edge, drooping a little
    const spanDir = (p: V3) => {
      const d = sub(exit, p);
      return normalize(madd(d, [0, -1, 0], 0.25 * lenV(d)));
    };
    // where the hand is: slide out, hold, back to the open loop, along the knuckles to the left hand
    const spread = madd(madd(madd(meet, g.S, -0.18), UP, -0.05), g.N, 0.03);
    let p: V3;
    if (t < b.tOut) p = lerpV(m.p0, g.hip, ramp(t, b.tSlide, b.tOut));
    else if (t < b.tTurned) p = g.hip;
    else if (t < b.tSpread) p = lerpV(g.hip, spread, ramp(t, b.tTurned, b.tSpread));
    else p = lerpV(spread, meet, ramp(t, b.tSpread, b.tMeet));
    // how far out (0 next to the coil … 1 at the hip): shapes the pinch (cross, palm wish)
    const out = t < b.tOut ? ramp(t, b.tSlide, b.tOut) : t < b.tTurned ? 1 : 1 - ramp(t, b.tTurned, b.tSpread + 0.5 * (b.tMeet - b.tSpread));
    const cross = 0.3 + 0.9 * out;
    // the pinch loosens while sliding (visible: the thumb lifts a little)
    const open = t < b.tOut ? 0.45 * ramp(t, b.t0, b.tSlide) * (1 - ramp(t, b.tOut - 0.15, b.tOut)) : 0;
    // the roll on the way back: over +, under −; back to 0 on the next slide (the pinch is loose then)
    const sign = b.kind === 'over' ? 1 : -1;
    const roll = t < b.tTurned ? 0 : sign * g.roll * ramp(t, b.tTurned, b.tSpread);
    // the cable's direction: along the span, turning onto the knuckle line for the hand-over
    const w = ramp(t, b.tSpread - 0.2, b.tMeet);
    const d3 = normalize(lerpV(spanDir(p), g.S, w));
    // at the start of a loop the hand turns from the hand-over frame into the free slide (and an
    // under loop's hand finishes turning back: the wrist slips out of the new loop)
    const blendIn = ramp(t, b.t0, b.tSlide + 0.35);
    if (b.kind === 'over' || t < b.tHeld) {
      const rig = this.pinchRig(p, d3, { roll: t < b.tTurned ? 0 : roll, open, cross, out });
      if (blendIn < 1) {
        rig.grip = { p, q: quatSlerp(m.q0, gripFrame(p, d3, [0, 0, 1]).q, blendIn) };
        rig.free = blendIn;
      }
      return { rig, turn: this.turnLeft(i, t) };
    }
    // under: turn the hold frame about the forearm, unwinding into the hand-over frame on the way back
    const turn = t < b.tTurned ? ramp(t, b.tHeld, b.tTurned) : 1 - 0.75 * ramp(t, b.tSpread - 0.25, b.tMeet);
    const home = ramp(t, b.tSpread - 0.3, b.tMeet);
    const outPose = m.outPose ?? this.pose;
    const base: Frame = { p, q: quatSlerp(m.outQ ?? m.q0, m.homeQ ?? m.q0, home) };
    const grip = turnWithForearm(outPose, 1, base, g.underTurn * turn);
    const rig = this.pinchRig(p, d3, { roll, open: 0, cross: 0.3 + 0.9 * (1 - home), out, free: 0, q: grip.q });
    rig.thumbTo = undefined;
    rig.prefer = [];
    return { rig, turn };
  }

  /** an under loop's turn still to undo at the start of the next loop (for the arrow and the rig) */
  private turnLeft(i: number, t: number): number {
    if (i < 1 || this.bs[i - 1].kind !== 'under') return 0;
    return 0.25 * (1 - ramp(t, this.bs[i].t0, this.bs[i].tSlide + 0.35));
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
    // the plug end: the plug and 9 cm of cable outside the hand on the lateral side, then across the hand
    const plugOut = 0.06 + 0.09;
    const lat = stackPoint(f, 0, g.half);
    const sDir = quatRotate(f.q, [0, 0, 1]);
    for (let s = 0; s <= plugOut + 2 * g.half + g.gap; s += 0.002) pts.push(madd(lat, sDir, plugOut - s));
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
    const built = buildCable(XLR, this.initialPoints(length), { plugs: 'both' });
    const rod = (this.rod = built.rod);
    const g = GEOM;
    // the plug strand: the lateral end is 0.15 m from the plug tip; the medial edge 9 cm further
    const s0 = 0.06 + 0.09;
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

    // settle with the hands holding (the IK too), then the cable remembers how it lies
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
    rod.rememberShape();
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
    const rig = this.rigAt(tn);
    this.tPose = tn;
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

  /** the beats that need the cable: loosen, hold after a loop length, the hand-over */
  private events(rod: Rod, t: number) {
    const i = loopAt(this.bs, t + DT);
    if (i < 0) return;
    const b = this.bs[i];
    const pin = this.pin;
    if (!this.memo || this.memo.k !== b.k) {
      // a new loop: the pinch loosens where the hand is
      const pads = this.pose.body.arms![1].grip!;
      this.memo = { k: b.k, p0: pads.p, q0: this.lastHandover?.q ?? pads.q, outPose: null, outQ: null, homeQ: null, held: false, added: false, laidAt: -1 };
      pin.set('loose', LOOSEN);
    }
    const m = this.memo;
    const edge = this.sEdge[b.k - 1];
    // hold as soon as a loop length has passed through the pads (or at the hip at the latest)
    if (!m.held && t >= b.tSlide && (pin.s - edge >= this.plan.loopLength + GEOM.gap || t + DT >= b.tOut)) {
      pin.set('held', 0.1);
      m.held = true;
    }
    if (b.kind === 'under' && !m.outPose && t + DT >= b.tHeld) {
      // the frame the hand reached at the hip, and the frame it should have at the hand-over
      m.outPose = this.pose;
      m.outQ = this.pose.body.arms![1].pads!.q;
      const home = rigPose(this.spec, { ...coilStance(this.spec), look: this.lookAt, hands: [this.leftRig(b.tMeet), this.pinchRig(this.meetPoint(i, b.tMeet), GEOM.S, {})] });
      m.homeQ = home.body.arms![1].pads!.q;
    }
    if (!m.added && t + DT >= b.tMeet - 0.02) {
      // the strand across the left hand joins the coil where it lies
      const s1 = pin.s - GEOM.gap;
      this.coil.add(s1 - 2 * GEOM.half - 0.01, s1 + 0.004, 0.2);
      this.sEdge.push(s1);
      m.added = true;
      m.laidAt = t;
      this.results.push({ k: b.k, kind: b.kind, length: s1 - edge, sEdge: s1, aspectLaid: 0, aspectEnd: 0, width: 0, height: 0, crossDepth: [] });
    }
    if (t + DT >= b.t1 - DT && m.added) this.lastHandover = { p: this.pose.body.arms![1].grip!.p, q: this.pose.body.arms![1].pads!.q };
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
    for (const r of this.results) lines.push(`loop ${r.k} ${r.kind}: length ${r.length.toFixed(3)} m, laid ${r.aspectLaid}, end ${r.aspectEnd} (${(r.width * 100).toFixed(1)} × ${(r.height * 100).toFixed(1)} cm), floor-cable crossings (depth along N, + = in front) ${JSON.stringify(r.crossDepth)}`);
    check('all loops laid', this.results.length === this.plan.kinds.length, this.results.length);
    check('loops round (width/height ≥ 0.6 at the end)', this.results.every((r) => r.aspectEnd >= 0.6), this.results.map((r) => r.aspectEnd));
    check('loop lengths within 5 cm of the plan', this.results.every((r) => Math.abs(r.length - this.plan.loopLength) < 0.05), this.results.map((r) => +r.length.toFixed(3)));
    check('pull-apart twist |Tw + Wr| < 0.3 turns', Math.abs(lk.along) < 0.3, lk);
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
 * What pulling the coil apart by its two plugs would leave in the cable: Lk = Tw + Wr of the cable
 * with its ends extended far away (Călugăreanu: with the ends' rotation fixed, pulling it straight
 * turns the writhe into twist). Extended along the coil's axis N (the plug end backwards, the free
 * end forwards) and, as a second opinion, across it.
 */
export function pullApartTwist(rod: Rod): { along: number; across: number; tw: number } {
  const n = rod.n;
  const tw = twistTurns(rod.q, 0, rod.ns - 1);
  const ext = (dir: V3) => {
    const x = new Float64Array(3 * (n + 2));
    const far = 50;
    x.set([rod.x[0] - dir[0] * far, rod.x[1] - dir[1] * far, rod.x[2] - dir[2] * far], 0);
    x.set(rod.x, 3);
    const e = 3 * (n - 1);
    x.set([rod.x[e] + dir[0] * far, rod.x[e + 1] + dir[1] * far, rod.x[e + 2] + dir[2] * far], 3 * (n + 1));
    return tw + writhe(x, 0, n + 1);
  };
  return { along: +ext(GEOM.N).toFixed(3), across: +ext(GEOM.A).toFixed(3), tw: +tw.toFixed(3) };
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
