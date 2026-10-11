// Rod: a deterministic, pseudo-physical cable (discrete Cosserat rod) for baking cable shots.
//
// Kugelstadt & Schömer 2016 constraints (zero-stretch + Darboux bend-twist with a rest Darboux
// quaternion), solved with XPBD in small substeps and a block-tridiagonal DIRECT solve of all
// joints per iteration (Deul et al. 2018, "Direct Position-Based Solver for Stiff Rods"), so
// bending and twist stiffness converge to their analytic values. Port of the tested prototype
// scratchpad/rodsim/rodsim.js (same algorithms and arithmetic) plus per-axis bending stiffness,
// guides, documented grip frames, shape-keeping grips and swivel grips.
//
// Units: metres, kilograms, seconds, radians. World: y up, ground plane y = groundY.
// Quaternions [x, y, z, w].
//
// State (segments are rigid bodies; nodes are derived)
//   segments  j = 0..ns-1  centre c[j], orientation q[j]; material frame d1, d2, d3 = q·(ex, ey, ez);
//                          d3 = tangent, d1 = direction of the printed stripe (shows twist)
//   nodes     i = 0..n-1   x[i] (n = ns + 1), the segment ends (output)
//   joints    k = 0..ns-2  between segment k and k+1; rest Darboux quaternion rest[k] = q̄_k q_{k+1}
//                          at rest (natural curvature and twist: "memory")
//
// Per substep: predict (gravity, damping) -> grips (kinematic) -> capsules -> `iterations` x
//   { direct XPBD solve of all joints (stretch 3 rows + bend-twist 3 rows: EI1 about d1, EI2
//     about d2, GJ about d3), pins and swivels, guides, self-contact (segment capsules, spatial
//     hash, remembered normals), kinematic capsules, ground (Coulomb friction at the cable
//     surface, so friction also resists rolling) } -> velocities -> internal damping.
//
// Determinism: fixed step, fixed order, no randomness; two runs give bit-identical frames.

import { Frame, Quat, TAU, V3, quatConj, quatFromAxisAngle, quatFromFrame, quatFromTo, quatMul, quatRotate, quatSlerp, smooth } from './vec';

/** A number per joint k (0..ns-2), or one number for all joints. */
export type PerJoint = number | ((k: number) => number);

export interface RodOptions {
  /** visual radius, also the contact radius unless collisionRadius is set [m] */
  radius: number;
  collisionRadius: number | null;
  /** [kg/m] */
  linearDensity: number;
  /** bending stiffness about both d1 and d2 [N m²]; EI1 / EI2 override it per axis */
  EI: PerJoint;
  /** bending stiffness about d1 (curvature toward d2) */
  EI1: PerJoint | null;
  /** bending stiffness about d2 (curvature toward d1) */
  EI2: PerJoint | null;
  /** torsional stiffness [N m²] */
  GJ: PerJoint;
  gravity: V3;
  /** linear velocity damping [1/s] (air drag + internal) */
  damping: number;
  /** angular velocity damping [1/s] */
  angularDamping: number;
  /** scales the (isotropic) rotational inertia of the segments */
  rotInertiaScale: number;
  /** direct solve + contact iterations per substep (2 keeps tight self-contact from passing through) */
  iterations: number;
  /** ground plane height, null = no ground */
  groundY: number | null;
  /** ground Coulomb friction */
  friction: number;
  selfCollision: boolean;
  selfFriction: number;
  capsuleFriction: number;
  /** rebuild the self-contact candidate list every k substeps */
  collideEvery: number;
  /** joint (inextensibility) compliance; ~0 = inextensible */
  stretchCompliance: number;
  /** damps the relative angular velocity of neighbouring segments [1/s] (material damping) */
  internalDamping: number;
}

export const ROD_DEFAULTS: RodOptions = {
  radius: 0.0035,
  collisionRadius: null,
  linearDensity: 0.05,
  EI: 2e-3,
  EI1: null,
  EI2: null,
  GJ: 1.5e-3,
  gravity: [0, -9.81, 0],
  damping: 0.5,
  angularDamping: 2,
  rotInertiaScale: 1,
  iterations: 2,
  groundY: 0,
  friction: 0.5,
  selfCollision: true,
  selfFriction: 0.3,
  capsuleFriction: 0.6,
  collideEvery: 2,
  stretchCompliance: 1e-9,
  internalDamping: 0,
};

export interface RodBuildOptions extends Partial<RodOptions> {
  /** initial d1 guess at the first segment (default: world up, or x for a vertical start) */
  up?: V3;
  /** extra material rotation about the tangent [rad] at arc length s (segment j), relative to parallel transport */
  twist?: (s: number, j: number) => number;
  /** the initial shape is the rest shape (memory) instead of straight */
  restFromShape?: boolean;
}

export interface Stiffness {
  /** sets EI1 and EI2 together */
  EI?: PerJoint;
  EI1?: PerJoint;
  EI2?: PerJoint;
  GJ?: PerJoint;
}

/** Kinematic capsule (hand, forearm, leg, prop edge). */
export interface Capsule {
  a: V3;
  b: V3;
  r: number;
  /** friction (default capsuleFriction) */
  mu?: number;
}

export interface GripSpec {
  /** nodes [a, b]: the segments a..b-1 are held (b > a; default b = a + 1). A pin uses node a. */
  nodes: [number, number] | [number];
  /** grip frame as a function of shot time */
  frame: (t: number) => Frame;
  /** false: a pin, only node a follows the frame point p (the cable rotates freely about it) */
  orient?: boolean;
  /** hold the held part rigidly in the pose it had relative to the frame when gripped */
  keepShape?: boolean;
  /** position and tangent follow the frame, rotation about the cable axis is free (twist escapes) */
  swivel?: boolean;
  /** seconds over which the held part moves from where it was into the frame (default 0.15) */
  blend?: number;
}

export interface GuideSpec {
  /** guided nodes a..b (inclusive) */
  nodes: [number, number];
  /** target of node i at time t, or null to leave the node free */
  target: (i: number, t: number) => V3 | null;
  /** compliance per node [m/N]: how far 1 N pulls the node off its target */
  compliance: number;
  /** strength 0..1 over time (default 1); the compliance is divided by it */
  weight?: (t: number) => number;
}

/** Everything a clip needs to continue a simulation (Rod.saveState / Rod.fromState). */
export interface RodState {
  opts: RodOptions;
  /** shot time when saved */
  time: number;
  /** rest lengths, centres, orientations, velocities, angular velocities, rest Darboux quaternions */
  L: Float64Array;
  c: Float64Array;
  q: Float64Array;
  v: Float64Array;
  om: Float64Array;
  rest: Float64Array;
  /** joint compliances (bending about d1, about d2, twist) */
  alpha1: Float64Array;
  alpha2: Float64Array;
  alphaT: Float64Array;
}

export interface RodStats {
  contacts: number;
  candidates: number;
  minDist2: number;
  crossings: number;
}

type GripKind = 'pin' | 'rigid' | 'swivel';

interface Grip {
  kind: GripKind;
  a: number;
  b: number;
  frame: (t: number) => Frame;
  keepShape: boolean;
  t0: number;
  blend: number;
  /** captured centres (rigid/swivel) or end offset (pin) in frame coordinates */
  lc: V3[];
  /** captured orientations in frame coordinates */
  lq: Quat[];
  /** centres of the held segments in the frame when fully gripped (along local z, centred on p) */
  canon: number[];
  /** pin: segment and side of the pinned node */
  j: number;
  side: number;
}

interface Guide {
  a: number;
  b: number;
  target: (i: number, t: number) => V3 | null;
  compliance: number;
  weight: ((t: number) => number) | null;
  /** compliance / weight of this substep (0 = inactive) */
  alpha: number;
  tgt: Float64Array;
  on: Uint8Array;
  lam: Float64Array;
}

const EZ: V3 = [0, 0, 1];

/**
 * Discrete Cosserat rod as a chain of rigid segments linked by joints with two constraints each:
 *   zero-stretch  end of segment k == start of segment k+1   (3 rows, ~rigid)
 *   bend-twist    Im(q̄_k q_{k+1}) == Im(Ω0_k)                 (3 rows, compliance from EI1, EI2, GJ)
 * Build with Rod.fromPolyline or Rod.straight.
 */
export class Rod {
  readonly opts: RodOptions;
  /** segments, nodes (ns + 1), joints (ns - 1) */
  readonly ns: number;
  readonly n: number;
  readonly nj: number;
  /** segment centres, previous centres, velocities (3 per segment) */
  readonly c: Float64Array;
  readonly cp: Float64Array;
  readonly v: Float64Array;
  /** segment orientations, previous orientations (4 per segment), angular velocities (3) */
  readonly q: Float64Array;
  readonly qp: Float64Array;
  readonly om: Float64Array;
  /** rest lengths and masses of the segments */
  readonly L: Float64Array;
  readonly m: Float64Array;
  /** inverse mass and inverse rotational inertia (0 = held), and their free values */
  readonly wc: Float64Array;
  readonly wt: Float64Array;
  private readonly wc0: Float64Array;
  private readonly wt0: Float64Array;
  /** tangents of the segments */
  readonly d3: Float64Array;
  /** node positions (output) */
  readonly x: Float64Array;
  /** rest Darboux quaternions per joint */
  readonly rest: Float64Array;
  /** compliances per joint: bending about d1, about d2, twist */
  private readonly alpha1: Float64Array;
  private readonly alpha2: Float64Array;
  private readonly alphaT: Float64Array;
  readonly radius: number;
  /** contact radius */
  readonly rc: number;
  totalLength = 0;
  time = 0;
  readonly stats: RodStats = { contacts: 0, candidates: 0, minDist2: Infinity, crossings: 0 };

  private readonly grips = new Map<number, Grip>();
  private gripId = 1;
  private readonly guides = new Map<number, Guide>();
  private guideId = 1;
  private capsules: Capsule[] | ((t: number) => Capsule[]) | null = null;
  private caps: Capsule[] = [];
  private sub = 0;

  // solver scratch
  private readonly J: Float64Array;
  private readonly C: Float64Array;
  private readonly lam: Float64Array;
  private readonly Cp: Float64Array;
  private readonly dp: Float64Array;
  private readonly Cc: Float64Array;
  /** scratch of the pivoting fallback solve */
  private readonly M = new Float64Array(6 * 13);
  private readonly D = new Float64Array(36);
  private readonly rhs = new Float64Array(6);
  private readonly st = new Float64Array(2);
  private readonly pm = new Float64Array(6);
  // self-contact candidate pairs and the contact normals remembered from the previous build
  private cand = new Int32Array(1024);
  private ncand = 0;
  private candN = new Float64Array(0);
  private candV = new Uint8Array(0);
  private hStart = new Int32Array(0);
  private readonly hEnt: Int32Array;
  private readonly hKey: Int32Array;
  private readonly seen: Int32Array;

  private constructor(ns: number, opts: Partial<RodOptions>) {
    const o: RodOptions = { ...ROD_DEFAULTS, ...opts };
    this.opts = o;
    this.ns = ns;
    this.n = ns + 1;
    this.nj = Math.max(0, ns - 1);
    const n = this.n, nj = this.nj;
    this.c = new Float64Array(3 * ns);
    this.cp = new Float64Array(3 * ns);
    this.v = new Float64Array(3 * ns);
    this.q = new Float64Array(4 * ns);
    this.qp = new Float64Array(4 * ns);
    this.om = new Float64Array(3 * ns);
    this.L = new Float64Array(ns);
    this.m = new Float64Array(ns);
    this.wc = new Float64Array(ns);
    this.wt = new Float64Array(ns);
    this.wc0 = new Float64Array(ns);
    this.wt0 = new Float64Array(ns);
    this.d3 = new Float64Array(3 * ns);
    this.x = new Float64Array(3 * n);
    this.rest = new Float64Array(4 * nj);
    this.alpha1 = new Float64Array(nj);
    this.alpha2 = new Float64Array(nj);
    this.alphaT = new Float64Array(nj);
    this.J = new Float64Array(36 * nj);
    this.C = new Float64Array(6 * nj);
    this.lam = new Float64Array(6 * nj);
    this.Cp = new Float64Array(36 * nj);
    this.dp = new Float64Array(6 * nj);
    this.Cc = new Float64Array(36 * nj);
    this.hEnt = new Int32Array(ns);
    this.hKey = new Int32Array(ns);
    this.seen = new Int32Array(ns).fill(-1);
    this.radius = o.radius;
    this.rc = o.collisionRadius ?? o.radius;
  }

  /** Rod through the given node positions (at least 2). */
  static fromPolyline(points: V3[], opts: RodBuildOptions = {}): Rod {
    const { up, twist, restFromShape, ...ro } = opts;
    const rod = new Rod(points.length - 1, ro);
    rod.initFromPoints(points, up, twist);
    rod.initMass();
    if (restFromShape) rod.setRestFromCurrent();
    else rod.setRestStraight();
    const o = rod.opts;
    rod.setStiffness({ EI1: o.EI1 ?? o.EI, EI2: o.EI2 ?? o.EI, GJ: o.GJ });
    rod.cp.set(rod.c);
    rod.qp.set(rod.q);
    rod.derive();
    return rod;
  }

  /**
   * A rod continuing from a saved state (saveState): same options, rest lengths, stiffness, rest
   * shape, positions, orientations, velocities and clock. Grips, guides and capsules are not part
   * of the state; set rod.time = 0 to start a new clip at shot time 0.
   */
  static fromState(s: RodState): Rod {
    const rod = new Rod(s.L.length, s.opts);
    rod.L.set(s.L);
    rod.initMass();
    rod.c.set(s.c);
    rod.q.set(s.q);
    rod.v.set(s.v);
    rod.om.set(s.om);
    rod.rest.set(s.rest);
    rod.alpha1.set(s.alpha1);
    rod.alpha2.set(s.alpha2);
    rod.alphaT.set(s.alphaT);
    rod.time = s.time;
    rod.cp.set(rod.c);
    rod.qp.set(rod.q);
    rod.derive();
    return rod;
  }

  /** Snapshot of the simulated state, to chain clips (Rod.fromState). */
  saveState(): RodState {
    const o = this.opts;
    return {
      opts: { ...o, gravity: [...o.gravity] as V3 }, time: this.time,
      L: this.L.slice(), c: this.c.slice(), q: this.q.slice(), v: this.v.slice(), om: this.om.slice(), rest: this.rest.slice(),
      alpha1: this.alpha1.slice(), alpha2: this.alpha2.slice(), alphaT: this.alphaT.slice(),
    };
  }

  /** Straight rod from a to b with n nodes. */
  static straight(a: V3, b: V3, n: number, opts: RodBuildOptions = {}): Rod {
    const pts: V3[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
    return Rod.fromPolyline(pts, opts);
  }

  private initFromPoints(P: V3[], up: V3 | undefined, twistFn: ((s: number, j: number) => number) | undefined) {
    const { q, c, ns } = this;
    let d1: V3 | null = null, prevT: V3 = [0, 0, 1], s = 0;
    for (let j = 0; j < ns; j++) {
      let tx = P[j + 1][0] - P[j][0], ty = P[j + 1][1] - P[j][1], tz = P[j + 1][2] - P[j][2];
      const l = Math.hypot(tx, ty, tz);
      this.L[j] = l;
      tx /= l; ty /= l; tz /= l;
      c[3 * j] = (P[j][0] + P[j + 1][0]) / 2;
      c[3 * j + 1] = (P[j][1] + P[j + 1][1]) / 2;
      c[3 * j + 2] = (P[j][2] + P[j + 1][2]) / 2;
      const t: V3 = [tx, ty, tz];
      if (!d1) {
        const u = up ?? (Math.abs(ty) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
        const dt = u[0] * tx + u[1] * ty + u[2] * tz;
        d1 = [u[0] - dt * tx, u[1] - dt * ty, u[2] - dt * tz];
      } else {
        d1 = quatRotate(quatFromTo(prevT, t), d1);
        const dt = d1[0] * tx + d1[1] * ty + d1[2] * tz;
        d1 = [d1[0] - dt * tx, d1[1] - dt * ty, d1[2] - dt * tz];
      }
      const nn = Math.hypot(...d1);
      d1 = [d1[0] / nn, d1[1] / nn, d1[2] / nn];
      prevT = t;
      let e1 = d1;
      if (twistFn) e1 = quatRotate(quatFromAxisAngle(tx, ty, tz, twistFn(s + l / 2, j)), d1);
      const e2: V3 = [t[1] * e1[2] - t[2] * e1[1], t[2] * e1[0] - t[0] * e1[2], t[0] * e1[1] - t[1] * e1[0]];
      q.set(quatFromFrame(e1, e2, t), 4 * j);
      s += l;
    }
  }

  private initMass() {
    const { ns, L, opts } = this, r = this.radius;
    let total = 0;
    for (let j = 0; j < ns; j++) {
      const m = opts.linearDensity * L[j];
      this.m[j] = m;
      this.wc0[j] = 1 / m;
      // isotropic rotational inertia (twist inertia raised to the bending one: better conditioning)
      this.wt0[j] = 1 / (m * (L[j] * L[j] / 12 + r * r / 4) * opts.rotInertiaScale);
      total += L[j];
    }
    this.wc.set(this.wc0);
    this.wt.set(this.wt0);
    this.totalLength = total;
  }

  /**
   * Adds a point mass [kg] to segment j, e.g. a plug at the end: it hangs heavier and swings and
   * turns slower. Not part of saveState (add it again after Rod.fromState).
   */
  addMass(j: number, mass: number) {
    const { L, opts } = this, r = this.radius;
    const m = (this.m[j] += mass);
    this.wc0[j] = 1 / m;
    this.wt0[j] = 1 / (m * (L[j] * L[j] / 12 + r * r / 4) * opts.rotInertiaScale);
    this.updateKinematic();
  }

  /**
   * Bending and torsional stiffness [N m²], numbers or functions of the joint index. EI sets both
   * bending axes; EI1 (about d1) and EI2 (about d2) set one each. A flat ribbon whose wide side
   * faces d2 bends easily about d1: EI2 ≫ EI1. Fields left out keep their value.
   */
  setStiffness(s: Stiffness) {
    const e1 = s.EI1 ?? s.EI, e2 = s.EI2 ?? s.EI, gj = s.GJ;
    const { L } = this;
    for (let k = 0; k < this.nj; k++) {
      const l = (L[k] + L[k + 1]) / 2;
      // E = 1/2 (EI / l) θ², C ≈ θ / 2
      if (e1 !== undefined) this.alpha1[k] = l / (4 * (typeof e1 === 'function' ? e1(k) : e1));
      if (e2 !== undefined) this.alpha2[k] = l / (4 * (typeof e2 === 'function' ? e2(k) : e2));
      if (gj !== undefined) this.alphaT[k] = l / (4 * (typeof gj === 'function' ? gj(k) : gj));
    }
    if (s.EI !== undefined) this.opts.EI = s.EI;
    if (e1 !== undefined) this.opts.EI1 = e1;
    if (e2 !== undefined) this.opts.EI2 = e2;
    if (gj !== undefined) this.opts.GJ = gj;
  }

  setRestStraight() {
    for (let k = 0; k < this.nj; k++) this.rest.set([0, 0, 0, 1], 4 * k);
  }

  /**
   * The current shape becomes the rest shape ("memory") of the joints from..to (inclusive;
   * default all). amount < 1 moves the rest shape only part of the way (slerp): fake plasticity,
   * e.g. a loop pulled tight keeps a kink.
   */
  setRestFromCurrent(from = 0, to = this.nj - 1, amount = 1) {
    for (let k = Math.max(0, from); k <= Math.min(this.nj - 1, to); k++) {
      const cur = quatMul(quatConj(this.segQuat(k)), this.segQuat(k + 1));
      const r: Quat = [this.rest[4 * k], this.rest[4 * k + 1], this.rest[4 * k + 2], this.rest[4 * k + 3]];
      this.rest.set(amount >= 1 ? cur : quatSlerp(r, cur, amount), 4 * k);
    }
  }

  /**
   * Natural curvature and twist [1/m]: fn(k, s) -> [k1, k2, tau] or one constant triple.
   * k1: bending about d1 (curls in the d2-d3 plane), k2: about d2, tau: twist about d3.
   */
  setRestCurvature(fn: V3 | ((k: number, s: number) => V3)) {
    let s = 0;
    for (let k = 0; k < this.nj; k++) {
      const l = (this.L[k] + this.L[k + 1]) / 2;
      s += this.L[k];
      const [k1, k2, tau] = typeof fn === 'function' ? fn(k, s) : fn;
      const ang = Math.hypot(k1, k2, tau) * l;
      this.rest.set(ang < 1e-12 ? [0, 0, 0, 1] : quatFromAxisAngle(k1, k2, tau, ang), 4 * k);
    }
  }

  /** rest <- slerp(rest, other, a): partial memory, or memory fading. */
  blendRest(other: Float64Array, a: number) {
    for (let k = 0; k < this.nj; k++) {
      const r: Quat = [this.rest[4 * k], this.rest[4 * k + 1], this.rest[4 * k + 2], this.rest[4 * k + 3]];
      const o: Quat = [other[4 * k], other[4 * k + 1], other[4 * k + 2], other[4 * k + 3]];
      this.rest.set(quatSlerp(r, o, a), 4 * k);
    }
  }

  // ------------------------------------------------------------------ grips

  /**
   * A hand holds the cable. The segments a..b-1 follow the grip frame:
   * - default: they lie straight along the frame's d3, centred on p, with the frame as their
   *   material frame, so rolling the frame about d3 rolls the cable (and its stripe). The held
   *   part moves there from where it was over `blend` seconds.
   * - keepShape: they keep the pose they had relative to the frame when gripped (a coil resting
   *   in a hand, loops already placed).
   * - swivel: like the default, but only the tangent follows the frame; rotation about the cable
   *   axis stays free, so stored twist runs out through the hand.
   * - orient: false: a pin; node a follows p, the cable rotates freely about it.
   * Returns an id for releaseGrip(). Released segments keep their velocity.
   */
  addGrip(spec: GripSpec): number {
    const f = spec.frame(this.time), qi = quatConj(f.q);
    const id = this.gripId++;
    const blend = spec.blend ?? 0.15;
    const a = spec.nodes[0];
    if (spec.orient === false) {
      const j = Math.min(a, this.ns - 1), side = a === j ? -1 : 1;
      const p = this.segEnd(j, side);
      const lo = quatRotate(qi, [p[0] - f.p[0], p[1] - f.p[1], p[2] - f.p[2]]);
      this.grips.set(id, { kind: 'pin', a, b: a, frame: spec.frame, keepShape: !!spec.keepShape, t0: this.time, blend, lc: [lo], lq: [], canon: [], j, side });
      return id;
    }
    const b = Math.max(spec.nodes[1] ?? a + 1, a + 1);
    if (a < 0 || b > this.ns) throw new Error(`grip nodes [${a}, ${b}] out of range (0..${this.ns})`);
    const lc: V3[] = [], lq: Quat[] = [], canon: number[] = [];
    let half = 0;
    for (let j = a; j < b; j++) half += this.L[j] / 2;
    let s = -half;
    for (let j = a; j < b; j++) {
      lc.push(quatRotate(qi, [this.c[3 * j] - f.p[0], this.c[3 * j + 1] - f.p[1], this.c[3 * j + 2] - f.p[2]]));
      lq.push(quatMul(qi, this.segQuat(j)));
      canon.push(s + this.L[j] / 2);
      s += this.L[j];
    }
    const kind: GripKind = spec.swivel ? 'swivel' : 'rigid';
    this.grips.set(id, { kind, a, b, frame: spec.frame, keepShape: !!spec.keepShape && !spec.swivel, t0: this.time, blend, lc, lq, canon, j: a, side: -1 });
    this.updateKinematic();
    return id;
  }

  releaseGrip(id: number) {
    this.grips.delete(id);
    this.updateKinematic();
  }

  releaseAll() {
    this.grips.clear();
    this.updateKinematic();
  }

  /** Segments held by grips (for debug pictures). */
  heldSegments(): number[] {
    const out: number[] = [];
    for (const g of this.grips.values()) for (let j = g.a; j < g.b; j++) out.push(j);
    return out;
  }

  private updateKinematic() {
    this.wc.set(this.wc0);
    this.wt.set(this.wt0);
    for (const g of this.grips.values()) {
      if (g.kind === 'pin') continue;
      for (let j = g.a; j < g.b; j++) {
        this.wc[j] = 0;
        if (g.kind === 'rigid') this.wt[j] = 0;
      }
    }
  }

  /** 0..1: how far a grip has moved the held part from its captured pose into the frame. */
  private gripBlend(g: Grip, t: number) {
    if (g.keepShape) return 0;
    return g.blend > 0 ? smooth((t - g.t0) / g.blend) : 1;
  }

  private applyGrips(t: number) {
    const { c, q } = this;
    for (const g of this.grips.values()) {
      if (g.kind === 'pin') continue;
      const f = g.frame(t);
      const u = this.gripBlend(g, t);
      for (let j = g.a; j < g.b; j++) {
        const k = j - g.a;
        let o = g.lc[k];
        if (u > 0) o = [o[0] * (1 - u), o[1] * (1 - u), o[2] + (g.canon[k] - o[2]) * u];
        const r = quatRotate(f.q, o);
        c[3 * j] = f.p[0] + r[0];
        c[3 * j + 1] = f.p[1] + r[1];
        c[3 * j + 2] = f.p[2] + r[2];
        if (g.kind === 'rigid') q.set(quatMul(f.q, u > 0 ? quatSlerp(g.lq[k], [0, 0, 0, 1], u) : g.lq[k]), 4 * j);
      }
      if (g.kind === 'swivel') this.alignSwivel(g, f, u);
    }
  }

  /** Turns each segment of a swivel grip (shortest way) so that its tangent follows the frame. */
  private alignSwivel(g: Grip, f: Frame, u: number) {
    const q = this.q;
    for (let j = g.a; j < g.b; j++) {
      const ld = quatRotate(g.lq[j - g.a], EZ);
      const lt: V3 = [ld[0] * (1 - u), ld[1] * (1 - u), ld[2] + (1 - ld[2]) * u];
      const tl = Math.hypot(lt[0], lt[1], lt[2]);
      const target = quatRotate(f.q, [lt[0] / tl, lt[1] / tl, lt[2] / tl]);
      const cur = this.segQuat(j);
      const r = quatMul(quatFromTo(quatRotate(cur, EZ), target), cur);
      const il = 1 / Math.hypot(r[0], r[1], r[2], r[3]);
      q[4 * j] = r[0] * il; q[4 * j + 1] = r[1] * il; q[4 * j + 2] = r[2] * il; q[4 * j + 3] = r[3] * il;
    }
  }

  /** Kinematic capsules (hands, forearms, legs, props): a function of time or a fixed list. */
  setCapsules(fn: Capsule[] | ((t: number) => Capsule[]) | null) {
    this.capsules = fn;
    if (!fn) this.caps = [];
  }

  /** Capsules of the current substep. */
  currentCapsules(): readonly Capsule[] {
    return this.caps;
  }

  // ------------------------------------------------------------------ guides

  /**
   * Soft positional constraints (pseudo-simulation): pull nodes a..b toward target(i, t) while
   * gravity, stiffness and contacts still act. Returns an id for removeGuide().
   */
  addGuide(spec: GuideSpec): number {
    const a = Math.max(0, spec.nodes[0]), b = Math.min(this.n - 1, spec.nodes[1]);
    const m = b - a + 1;
    const id = this.guideId++;
    this.guides.set(id, {
      a, b, target: spec.target, compliance: spec.compliance, weight: spec.weight ?? null, alpha: 0,
      tgt: new Float64Array(3 * m), on: new Uint8Array(m), lam: new Float64Array(2 * m),
    });
    return id;
  }

  removeGuide(id: number) {
    this.guides.delete(id);
  }

  private prepareGuides(t: number) {
    for (const g of this.guides.values()) {
      const w = g.weight ? g.weight(t) : 1;
      g.alpha = w > 1e-6 ? g.compliance / w : 0;
      if (g.alpha === 0) continue;
      g.lam.fill(0);
      for (let i = g.a; i <= g.b; i++) {
        const k = i - g.a, p = g.target(i, t);
        g.on[k] = p ? 1 : 0;
        if (p) { g.tgt[3 * k] = p[0]; g.tgt[3 * k + 1] = p[1]; g.tgt[3 * k + 2] = p[2]; }
      }
    }
  }

  private solveGuides(h: number) {
    const ih2 = 1 / (h * h);
    for (const g of this.guides.values()) {
      if (g.alpha === 0) continue;
      for (let i = g.a; i <= g.b; i++) {
        const k = i - g.a;
        if (!g.on[k]) continue;
        // a node is the end of segment i-1 and the start of segment i: each end gets half the stiffness
        const ends = (i > 0 ? 1 : 0) + (i < this.ns ? 1 : 0);
        const at = g.alpha * ends * ih2;
        if (i > 0) this.softPoint(i - 1, 1, g.tgt, 3 * k, at, g.lam, 2 * k);
        if (i < this.ns) this.softPoint(i, -1, g.tgt, 3 * k, at, g.lam, 2 * k + 1);
      }
    }
  }

  /** XPBD distance-to-target constraint on one end of segment j (compliance at already / h²). */
  private softPoint(j: number, side: number, tgt: Float64Array, o: number, at: number, lam: Float64Array, li: number) {
    const W = this.wc[j], T = this.wt[j];
    if (W === 0 && T === 0) return;
    const p = this.segEnd(j, side);
    let nx = p[0] - tgt[o], ny = p[1] - tgt[o + 1], nz = p[2] - tgt[o + 2];
    const d = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (d < 1e-12) return;
    nx /= d; ny /= d; nz /= d;
    const j3 = 3 * j;
    const rx = p[0] - this.c[j3], ry = p[1] - this.c[j3 + 1], rz = p[2] - this.c[j3 + 2];
    const ax = ry * nz - rz * ny, ay = rz * nx - rx * nz, az = rx * ny - ry * nx;
    const w = W + T * (ax * ax + ay * ay + az * az);
    const dl = (-d - at * lam[li]) / (w + at);
    lam[li] += dl;
    this.c[j3] += W * dl * nx; this.c[j3 + 1] += W * dl * ny; this.c[j3 + 2] += W * dl * nz;
    if (T > 0) this.rotate(j, T * dl * ax, T * dl * ay, T * dl * az);
  }

  // ------------------------------------------------------------------- step

  /** Advance by dt in `substeps` equal substeps. */
  step(dt: number, substeps = 20) {
    const h = dt / substeps;
    for (let s = 0; s < substeps; s++) this.substep(h);
  }

  /** Apply the grips at the current time and derive the nodes (state for frame 0 of a bake). */
  sync() {
    this.applyGrips(this.time);
    this.derive();
  }

  private substep(h: number) {
    const { ns, c, cp, v, q, qp, om, wc, opts } = this;
    const [gx, gy, gz] = opts.gravity;
    const ld = Math.exp(-opts.damping * h), ad = Math.exp(-opts.angularDamping * h);
    for (let j = 0; j < ns; j++) {
      const j3 = 3 * j, j4 = 4 * j;
      cp[j3] = c[j3]; cp[j3 + 1] = c[j3 + 1]; cp[j3 + 2] = c[j3 + 2];
      qp[j4] = q[j4]; qp[j4 + 1] = q[j4 + 1]; qp[j4 + 2] = q[j4 + 2]; qp[j4 + 3] = q[j4 + 3];
      if (wc[j] === 0) {
        // a swivel-held segment still spins about its axis
        if (this.wt[j] > 0) {
          const ox = om[j3] * ad, oy = om[j3 + 1] * ad, oz = om[j3 + 2] * ad;
          om[j3] = ox; om[j3 + 1] = oy; om[j3 + 2] = oz;
          this.rotate(j, ox * h, oy * h, oz * h);
        }
        continue;
      }
      v[j3] = (v[j3] + gx * h) * ld; v[j3 + 1] = (v[j3 + 1] + gy * h) * ld; v[j3 + 2] = (v[j3 + 2] + gz * h) * ld;
      c[j3] += v[j3] * h; c[j3 + 1] += v[j3 + 1] * h; c[j3 + 2] += v[j3 + 2] * h;
      const ox = om[j3] * ad, oy = om[j3 + 1] * ad, oz = om[j3 + 2] * ad;
      om[j3] = ox; om[j3 + 1] = oy; om[j3 + 2] = oz;
      this.rotate(j, ox * h, oy * h, oz * h);
    }
    this.time += h;
    this.applyGrips(this.time);
    this.prepareGuides(this.time);
    if (this.capsules) this.caps = typeof this.capsules === 'function' ? this.capsules(this.time) : this.capsules;
    this.lam.fill(0);
    const doSelf = opts.selfCollision && this.ns > 3;
    if (doSelf && this.sub % opts.collideEvery === 0) this.buildCandidates();
    this.sub++;
    for (let it = 0; it < opts.iterations; it++) {
      this.solveRod(h);
      this.solveGripConstraints();
      if (this.guides.size) this.solveGuides(h);
      this.derive();
      if (doSelf) this.solveSelf();
      if (this.caps.length) this.solveCapsules();
      if (opts.groundY !== null && opts.groundY !== undefined) this.solveGround();
    }
    const ih = 1 / h;
    for (let j = 0; j < ns; j++) {
      const j3 = 3 * j, j4 = 4 * j;
      v[j3] = (c[j3] - cp[j3]) * ih; v[j3 + 1] = (c[j3 + 1] - cp[j3 + 1]) * ih; v[j3 + 2] = (c[j3 + 2] - cp[j3 + 2]) * ih;
      // world angular velocity: 2 Im(q qp⁻¹) / h
      const ax = q[j4], ay = q[j4 + 1], az = q[j4 + 2], aw = q[j4 + 3];
      const bx = -qp[j4], by = -qp[j4 + 1], bz = -qp[j4 + 2], bw = qp[j4 + 3];
      const rx = aw * bx + ax * bw + ay * bz - az * by;
      const ry = aw * by - ax * bz + ay * bw + az * bx;
      const rz = aw * bz + ax * by - ay * bx + az * bw;
      const rw = aw * bw - ax * bx - ay * by - az * bz;
      const sg = rw < 0 ? -2 * ih : 2 * ih;
      om[j3] = rx * sg; om[j3 + 1] = ry * sg; om[j3 + 2] = rz * sg;
    }
    const kd = opts.internalDamping;
    if (kd > 0) {
      const f = 0.5 * (1 - Math.exp(-kd * h));
      for (let pass = 0; pass < 2; pass++) {
        for (let k = 0; k < this.nj; k++) {
          const a = 3 * k, b = a + 3;
          const ta = this.wt[k] > 0 ? 1 : 0, tb = this.wt[k + 1] > 0 ? 1 : 0;
          if (ta + tb === 0) continue;
          const g = (f * 2) / (ta + tb);
          const dx = (om[b] - om[a]) * g, dy = (om[b + 1] - om[a + 1]) * g, dz = (om[b + 2] - om[a + 2]) * g;
          if (ta) { om[a] += dx; om[a + 1] += dy; om[a + 2] += dz; }
          if (tb) { om[b] -= dx; om[b + 1] -= dy; om[b + 2] -= dz; }
        }
      }
    }
    this.derive();
  }

  /** q_j <- normalize(q_j + 1/2 (0, dθ) q_j) for a world-frame rotation vector dθ. */
  private rotate(j: number, dx: number, dy: number, dz: number) {
    const q = this.q, j4 = 4 * j;
    const qx = q[j4], qy = q[j4 + 1], qz = q[j4 + 2], qw = q[j4 + 3];
    const nx = qx + 0.5 * (dx * qw + dy * qz - dz * qy);
    const ny = qy + 0.5 * (dy * qw + dz * qx - dx * qz);
    const nz = qz + 0.5 * (dz * qw + dx * qy - dy * qx);
    const nw = qw - 0.5 * (dx * qx + dy * qy + dz * qz);
    const il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
    q[j4] = nx * il; q[j4 + 1] = ny * il; q[j4 + 2] = nz * il; q[j4 + 3] = nw * il;
  }

  /** Tangents per segment and node positions (average of the two adjacent segment ends). */
  private derive() {
    const { ns, c, q, L, d3, x } = this;
    for (let j = 0; j < ns; j++) {
      const j4 = 4 * j, j3 = 3 * j;
      const qx = q[j4], qy = q[j4 + 1], qz = q[j4 + 2], qw = q[j4 + 3];
      d3[j3] = 2 * (qx * qz + qw * qy);
      d3[j3 + 1] = 2 * (qy * qz - qw * qx);
      d3[j3 + 2] = qw * qw - qx * qx - qy * qy + qz * qz;
    }
    for (let i = 0; i <= ns; i++) {
      let px = 0, py = 0, pz = 0, k = 0;
      if (i > 0) {
        const j = i - 1, h = L[j] / 2;
        px += c[3 * j] + d3[3 * j] * h; py += c[3 * j + 1] + d3[3 * j + 1] * h; pz += c[3 * j + 2] + d3[3 * j + 2] * h;
        k++;
      }
      if (i < ns) {
        const j = i, h = L[j] / 2;
        px += c[3 * j] - d3[3 * j] * h; py += c[3 * j + 1] - d3[3 * j + 1] * h; pz += c[3 * j + 2] - d3[3 * j + 2] * h;
        k++;
      }
      x[3 * i] = px / k; x[3 * i + 1] = py / k; x[3 * i + 2] = pz / k;
    }
  }

  private segQuat(j: number): Quat {
    const q = this.q, j4 = 4 * j;
    return [q[j4], q[j4 + 1], q[j4 + 2], q[j4 + 3]];
  }

  /** End of segment j: side -1 = start (node j), +1 = end (node j+1). */
  private segEnd(j: number, side: number): V3 {
    const { c, q, L } = this, j4 = 4 * j;
    const qx = q[j4], qy = q[j4 + 1], qz = q[j4 + 2], qw = q[j4 + 3];
    const h = (side * L[j]) / 2;
    return [c[3 * j] + h * 2 * (qx * qz + qw * qy), c[3 * j + 1] + h * 2 * (qy * qz - qw * qx), c[3 * j + 2] + h * (qw * qw - qx * qx - qy * qy + qz * qz)];
  }

  // --------------------------------------------------- direct rod solve

  private solveRod(h: number) {
    const { nj, c, q, L, wc, wt, rest, alpha1, alpha2, alphaT, opts } = this;
    if (nj < 1) return;
    const { J, C, lam, Cp, dp, Cc, M, D, rhs } = this;
    const ih2 = 1 / (h * h), aS = opts.stretchCompliance * ih2;
    // pass 1: constraint values and Jacobian blocks
    for (let k = 0; k < nj; k++) {
      const a4 = 4 * k, b4 = a4 + 4, a3 = 3 * k, b3 = a3 + 3, o = 36 * k, k6 = 6 * k;
      const ax = q[a4], ay = q[a4 + 1], az = q[a4 + 2], aw = q[a4 + 3];
      const bx = q[b4], by = q[b4 + 1], bz = q[b4 + 2], bw = q[b4 + 3];
      // rotation matrix of a (columns d1 d2 d3)
      const r00 = 1 - 2 * (ay * ay + az * az), r10 = 2 * (ax * ay + aw * az), r20 = 2 * (ax * az - aw * ay);
      const r01 = 2 * (ax * ay - aw * az), r11 = 1 - 2 * (ax * ax + az * az), r21 = 2 * (ay * az + aw * ax);
      const r02 = 2 * (ax * az + aw * ay), r12 = 2 * (ay * az - aw * ax), r22 = 1 - 2 * (ax * ax + ay * ay);
      const ha = L[k] / 2, hb = L[k + 1] / 2;
      const avx = r02 * ha, avy = r12 * ha, avz = r22 * ha; // a = +d3a la/2
      const bd3x = 2 * (bx * bz + bw * by), bd3y = 2 * (by * bz - bw * bx), bd3z = bw * bw - bx * bx - by * by + bz * bz;
      const bvx = -bd3x * hb, bvy = -bd3y * hb, bvz = -bd3z * hb; // b = -d3b lb/2
      C[k6] = c[a3] + avx - c[b3] - bvx;
      C[k6 + 1] = c[a3 + 1] + avy - c[b3 + 1] - bvy;
      C[k6 + 2] = c[a3 + 2] + avz - c[b3 + 2] - bvz;
      // Darboux omega = conj(a) b
      let ox = aw * bx - ax * bw - ay * bz + az * by;
      let oy = aw * by + ax * bz - ay * bw - az * bx;
      let oz = aw * bz - ax * by + ay * bx - az * bw;
      let ow = aw * bw + ax * bx + ay * by + az * bz;
      const rx = rest[a4], ry = rest[a4 + 1], rz = rest[a4 + 2], rw = rest[a4 + 3];
      const dm = (ox - rx) ** 2 + (oy - ry) ** 2 + (oz - rz) ** 2 + (ow - rw) ** 2;
      const dpl = (ox + rx) ** 2 + (oy + ry) ** 2 + (oz + rz) ** 2 + (ow + rw) ** 2;
      if (dm > dpl) { ox = -ox; oy = -oy; oz = -oz; ow = -ow; }
      C[k6 + 3] = ox - rx; C[k6 + 4] = oy - ry; C[k6 + 5] = oz - rz;
      // G = 1/2 (ow I - [o]x) R_aᵀ
      const m00 = ow, m01 = oz, m02 = -oy, m10 = -oz, m11 = ow, m12 = ox, m20 = oy, m21 = -ox, m22 = ow;
      const g00 = 0.5 * (m00 * r00 + m01 * r01 + m02 * r02), g01 = 0.5 * (m00 * r10 + m01 * r11 + m02 * r12), g02 = 0.5 * (m00 * r20 + m01 * r21 + m02 * r22);
      const g10 = 0.5 * (m10 * r00 + m11 * r01 + m12 * r02), g11 = 0.5 * (m10 * r10 + m11 * r11 + m12 * r12), g12 = 0.5 * (m10 * r20 + m11 * r21 + m12 * r22);
      const g20 = 0.5 * (m20 * r00 + m21 * r01 + m22 * r02), g21 = 0.5 * (m20 * r10 + m21 * r11 + m22 * r12), g22 = 0.5 * (m20 * r20 + m21 * r21 + m22 * r22);
      // Xa = -[a]x, Ya = -G, Xb = [b]x, Yb = G
      J[o] = 0; J[o + 1] = avz; J[o + 2] = -avy; J[o + 3] = -avz; J[o + 4] = 0; J[o + 5] = avx; J[o + 6] = avy; J[o + 7] = -avx; J[o + 8] = 0;
      J[o + 9] = -g00; J[o + 10] = -g01; J[o + 11] = -g02; J[o + 12] = -g10; J[o + 13] = -g11; J[o + 14] = -g12; J[o + 15] = -g20; J[o + 16] = -g21; J[o + 17] = -g22;
      J[o + 18] = 0; J[o + 19] = -bvz; J[o + 20] = bvy; J[o + 21] = bvz; J[o + 22] = 0; J[o + 23] = -bvx; J[o + 24] = -bvy; J[o + 25] = bvx; J[o + 26] = 0;
      J[o + 27] = g00; J[o + 28] = g01; J[o + 29] = g02; J[o + 30] = g10; J[o + 31] = g11; J[o + 32] = g12; J[o + 33] = g20; J[o + 34] = g21; J[o + 35] = g22;
    }
    // pass 2: assemble block rows and forward-eliminate (block Thomas)
    for (let k = 0; k < nj; k++) {
      const o = 36 * k, k6 = 6 * k;
      const a1 = alpha1[k] * ih2, a2 = alpha2[k] * ih2, at = alphaT[k] * ih2;
      D.fill(0);
      blockAdd(D, J, o, wc[k], wt[k]); // body a of joint k (Xa, Ya)
      blockAdd(D, J, o + 18, wc[k + 1], wt[k + 1]); // body b
      D[0] += aS; D[7] += aS; D[14] += aS; D[21] += a1; D[28] += a2; D[35] += at;
      rhs[0] = -C[k6] - aS * lam[k6];
      rhs[1] = -C[k6 + 1] - aS * lam[k6 + 1];
      rhs[2] = -C[k6 + 2] - aS * lam[k6 + 2];
      rhs[3] = -C[k6 + 3] - a1 * lam[k6 + 3];
      rhs[4] = -C[k6 + 4] - a2 * lam[k6 + 4];
      rhs[5] = -C[k6 + 5] - at * lam[k6 + 5];
      if (k > 0) {
        // D -= A_k Cp_{k-1} (= Ccᵀ S⁻¹ Cc, symmetric), rhs -= A_k dp_{k-1}, with A_k = Cc_{k-1}ᵀ
        const pc = 36 * (k - 1), p6 = 6 * (k - 1);
        const e0 = dp[p6], e1 = dp[p6 + 1], e2 = dp[p6 + 2], e3 = dp[p6 + 3], e4 = dp[p6 + 4], e5 = dp[p6 + 5];
        for (let r = 0; r < 6; r++) {
          const cr = pc + r;
          const c0 = Cc[cr], c1 = Cc[cr + 6], c2 = Cc[cr + 12], c3 = Cc[cr + 18], c4 = Cc[cr + 24], c5 = Cc[cr + 30];
          rhs[r] -= c0 * e0 + c1 * e1 + c2 * e2 + c3 * e3 + c4 * e4 + c5 * e5;
          for (let s2 = r; s2 < 6; s2++) {
            const ps = pc + s2;
            const a = c0 * Cp[ps] + c1 * Cp[ps + 6] + c2 * Cp[ps + 12] + c3 * Cp[ps + 18] + c4 * Cp[ps + 24] + c5 * Cp[ps + 30];
            D[6 * r + s2] -= a;
            if (s2 !== r) D[6 * s2 + r] -= a;
          }
        }
      }
      // off-diagonal block to the next joint: the shared body k+1 (rows: joint k via Xb, Yb; cols: joint k+1 via Xa', Ya')
      const hasNext = k < nj - 1;
      if (hasNext) {
        for (let r = 0; r < 36; r++) Cc[o + r] = 0;
        crossBlock(Cc, o, J, o + 18, 36 * (k + 1), wc[k + 1], wt[k + 1]);
      }
      // solve D [Cp_k | dp_k] = [Cc_k | rhs]
      if (!chol6(D, Cc, o, hasNext, rhs, Cp, o, dp, k6)) solve6(D, Cc, o, hasNext, rhs, Cp, o, dp, k6, M);
    }
    // pass 3: back substitution (dp becomes dλ)
    for (let k = nj - 2; k >= 0; k--) {
      const k6 = 6 * k, n6 = k6 + 6;
      const e0 = dp[n6], e1 = dp[n6 + 1], e2 = dp[n6 + 2], e3 = dp[n6 + 3], e4 = dp[n6 + 4], e5 = dp[n6 + 5];
      for (let r = 0; r < 6; r++) {
        const o = 36 * k + 6 * r;
        dp[k6 + r] -= Cp[o] * e0 + Cp[o + 1] * e1 + Cp[o + 2] * e2 + Cp[o + 3] * e3 + Cp[o + 4] * e4 + Cp[o + 5] * e5;
      }
    }
    // pass 4: apply dx_j = W_j Σ Jᵀ dλ
    for (let k = 0; k < nj * 6; k++) lam[k] += dp[k];
    for (let j = 0; j < this.ns; j++) {
      const W = wc[j], T = wt[j];
      if (W === 0 && T === 0) continue;
      let dcx = 0, dcy = 0, dcz = 0, dtx = 0, dty = 0, dtz = 0;
      if (j < nj) {
        // body j is "a" of joint j: Xa, Ya
        const o = 36 * j, k6 = 6 * j;
        const l0 = dp[k6], l1 = dp[k6 + 1], l2 = dp[k6 + 2], l3 = dp[k6 + 3], l4 = dp[k6 + 4], l5 = dp[k6 + 5];
        dcx += l0; dcy += l1; dcz += l2;
        dtx += J[o] * l0 + J[o + 3] * l1 + J[o + 6] * l2 + J[o + 9] * l3 + J[o + 12] * l4 + J[o + 15] * l5;
        dty += J[o + 1] * l0 + J[o + 4] * l1 + J[o + 7] * l2 + J[o + 10] * l3 + J[o + 13] * l4 + J[o + 16] * l5;
        dtz += J[o + 2] * l0 + J[o + 5] * l1 + J[o + 8] * l2 + J[o + 11] * l3 + J[o + 14] * l4 + J[o + 17] * l5;
      }
      if (j > 0) {
        // body j is "b" of joint j-1: Xb, Yb
        const o = 36 * (j - 1) + 18, k6 = 6 * (j - 1);
        const l0 = dp[k6], l1 = dp[k6 + 1], l2 = dp[k6 + 2], l3 = dp[k6 + 3], l4 = dp[k6 + 4], l5 = dp[k6 + 5];
        dcx -= l0; dcy -= l1; dcz -= l2;
        dtx += J[o] * l0 + J[o + 3] * l1 + J[o + 6] * l2 + J[o + 9] * l3 + J[o + 12] * l4 + J[o + 15] * l5;
        dty += J[o + 1] * l0 + J[o + 4] * l1 + J[o + 7] * l2 + J[o + 10] * l3 + J[o + 13] * l4 + J[o + 16] * l5;
        dtz += J[o + 2] * l0 + J[o + 5] * l1 + J[o + 8] * l2 + J[o + 11] * l3 + J[o + 14] * l4 + J[o + 17] * l5;
      }
      c[3 * j] += W * dcx; c[3 * j + 1] += W * dcy; c[3 * j + 2] += W * dcz;
      if (T > 0) this.rotate(j, T * dtx, T * dty, T * dtz);
    }
  }

  // ---------------------------------------------------------------- contacts

  /**
   * Positional rigid-body contact on segment j at offset r (contact point - c_j) along the unit
   * normal n with penetration pen > 0, against segment k at offset rk (k < 0: kinematic). Applies
   * the normal correction and Coulomb friction (mu) from the relative motion of the contact
   * points during this substep.
   */
  private contact(j: number, rx: number, ry: number, rz: number, k: number, kx: number, ky: number, kz: number, nx: number, ny: number, nz: number, pen: number, mu: number) {
    const { c, wc, wt } = this;
    const Wj = wc[j], Tj = wt[j], Wk = k >= 0 ? wc[k] : 0, Tk = k >= 0 ? wt[k] : 0;
    // r × n
    let ax = ry * nz - rz * ny, ay = rz * nx - rx * nz, az = rx * ny - ry * nx;
    let bx = ky * nz - kz * ny, by = kz * nx - kx * nz, bz = kx * ny - ky * nx;
    const w = Wj + Tj * (ax * ax + ay * ay + az * az) + Wk + Tk * (bx * bx + by * by + bz * bz);
    if (w < 1e-12) return;
    const lamN = pen / w;
    c[3 * j] += Wj * lamN * nx; c[3 * j + 1] += Wj * lamN * ny; c[3 * j + 2] += Wj * lamN * nz;
    if (Tj > 0) this.rotate(j, Tj * lamN * ax, Tj * lamN * ay, Tj * lamN * az);
    if (k >= 0) {
      c[3 * k] -= Wk * lamN * nx; c[3 * k + 1] -= Wk * lamN * ny; c[3 * k + 2] -= Wk * lamN * nz;
      if (Tk > 0) this.rotate(k, -Tk * lamN * bx, -Tk * lamN * by, -Tk * lamN * bz);
    }
    if (mu <= 0) return;
    // relative displacement of the contact points over the substep
    const pm = this.pm;
    this.pointMotion(j, rx, ry, rz, pm, 0);
    if (k >= 0) this.pointMotion(k, kx, ky, kz, pm, 3);
    else { pm[3] = 0; pm[4] = 0; pm[5] = 0; }
    let dx = pm[0] - pm[3], dy = pm[1] - pm[4], dz = pm[2] - pm[5];
    const dn = dx * nx + dy * ny + dz * nz;
    dx -= dn * nx; dy -= dn * ny; dz -= dn * nz;
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dl < 1e-12) return;
    const tx = dx / dl, ty = dy / dl, tz = dz / dl;
    ax = ry * tz - rz * ty; ay = rz * tx - rx * tz; az = rx * ty - ry * tx;
    bx = ky * tz - kz * ty; by = kz * tx - kx * tz; bz = kx * ty - ky * tx;
    const wT = Wj + Tj * (ax * ax + ay * ay + az * az) + Wk + Tk * (bx * bx + by * by + bz * bz);
    const lamT = -Math.min(dl / wT, mu * lamN); // static (cancel slip) or kinetic (Coulomb limit)
    c[3 * j] += Wj * lamT * tx; c[3 * j + 1] += Wj * lamT * ty; c[3 * j + 2] += Wj * lamT * tz;
    if (Tj > 0) this.rotate(j, Tj * lamT * ax, Tj * lamT * ay, Tj * lamT * az);
    if (k >= 0) {
      c[3 * k] -= Wk * lamT * tx; c[3 * k + 1] -= Wk * lamT * ty; c[3 * k + 2] -= Wk * lamT * tz;
      if (Tk > 0) this.rotate(k, -Tk * lamT * bx, -Tk * lamT * by, -Tk * lamT * bz);
    }
  }

  /** Displacement during this substep of the body-fixed point now at offset r from c_j, into out[o..o+2]. */
  private pointMotion(j: number, rx: number, ry: number, rz: number, out: Float64Array, o: number) {
    const { c, cp, q, qp } = this, j3 = 3 * j, j4 = 4 * j;
    // local = q⁻¹ r
    let x = -q[j4], y = -q[j4 + 1], z = -q[j4 + 2], w = q[j4 + 3];
    let tx = 2 * (y * rz - z * ry), ty = 2 * (z * rx - x * rz), tz = 2 * (x * ry - y * rx);
    const lx = rx + w * tx + (y * tz - z * ty), ly = ry + w * ty + (z * tx - x * tz), lz = rz + w * tz + (x * ty - y * tx);
    // previous world offset = qp local
    x = qp[j4]; y = qp[j4 + 1]; z = qp[j4 + 2]; w = qp[j4 + 3];
    tx = 2 * (y * lz - z * ly); ty = 2 * (z * lx - x * lz); tz = 2 * (x * ly - y * lx);
    const px = lx + w * tx + (y * tz - z * ty), py = ly + w * ty + (z * tx - x * tz), pz = lz + w * tz + (x * ty - y * tx);
    out[o] = c[j3] + rx - cp[j3] - px;
    out[o + 1] = c[j3 + 1] + ry - cp[j3 + 1] - py;
    out[o + 2] = c[j3 + 2] + rz - cp[j3 + 2] - pz;
  }

  private solveGround() {
    const { ns, c, q, L, wc, opts, rc } = this;
    const gy = (opts.groundY ?? 0) + rc;
    for (let j = 0; j < ns; j++) {
      if (wc[j] === 0) continue;
      const j4 = 4 * j;
      const qx = q[j4], qy = q[j4 + 1], qz = q[j4 + 2], qw = q[j4 + 3];
      const d3y = 2 * (qy * qz - qw * qx);
      const h = L[j] / 2, cy = c[3 * j + 1];
      if (cy - Math.abs(d3y) * h >= gy) continue;
      const d3x = 2 * (qx * qz + qw * qy), d3z = qw * qw - qx * qx - qy * qy + qz * qz;
      for (let side = -1; side <= 1; side += 2) {
        const ey = c[3 * j + 1] + side * d3y * h;
        if (ey >= gy) continue;
        // contact point on the surface below the end point (lever arm incl. radius -> rolling friction)
        const rx = side * d3x * h, ry = side * d3y * h - rc, rz = side * d3z * h;
        this.contact(j, rx, ry, rz, -1, 0, 0, 0, 0, 1, 0, (gy - ey) * 0.5, opts.friction);
      }
    }
  }

  /** Pins pull their node to the frame point; swivel grips keep their tangents on the frame. */
  private solveGripConstraints() {
    for (const g of this.grips.values()) {
      if (g.kind === 'swivel') {
        this.alignSwivel(g, g.frame(this.time), this.gripBlend(g, this.time));
        continue;
      }
      if (g.kind !== 'pin') continue;
      const f = g.frame(this.time);
      const u = this.gripBlend(g, this.time);
      const l0 = g.lc[0];
      const lo = quatRotate(f.q, u > 0 ? [l0[0] * (1 - u), l0[1] * (1 - u), l0[2] * (1 - u)] : l0);
      const tx = f.p[0] + lo[0], ty = f.p[1] + lo[1], tz = f.p[2] + lo[2];
      const p = this.segEnd(g.j, g.side);
      const dx = p[0] - tx, dy = p[1] - ty, dz = p[2] - tz;
      const dl = Math.hypot(dx, dy, dz);
      if (dl < 1e-12) continue;
      const j3 = 3 * g.j;
      this.contact(g.j, p[0] - this.c[j3], p[1] - this.c[j3 + 1], p[2] - this.c[j3 + 2], -1, 0, 0, 0, -dx / dl, -dy / dl, -dz / dl, dl, 0);
    }
  }

  private solveCapsules() {
    const { ns, c, d3, L, wc, rc, opts } = this;
    const st = this.st;
    for (const cap of this.caps) {
      const R = cap.r + rc;
      const A = cap.a, B = cap.b;
      for (let j = 0; j < ns; j++) {
        if (wc[j] === 0) continue;
        const h = L[j] / 2, j3 = 3 * j;
        const p0x = c[j3] - d3[j3] * h, p0y = c[j3 + 1] - d3[j3 + 1] * h, p0z = c[j3 + 2] - d3[j3 + 2] * h;
        const p1x = c[j3] + d3[j3] * h, p1y = c[j3 + 1] + d3[j3 + 1] * h, p1z = c[j3 + 2] + d3[j3 + 2] * h;
        if (Math.max(p0x, p1x) < Math.min(A[0], B[0]) - R || Math.min(p0x, p1x) > Math.max(A[0], B[0]) + R) continue;
        if (Math.max(p0y, p1y) < Math.min(A[1], B[1]) - R || Math.min(p0y, p1y) > Math.max(A[1], B[1]) + R) continue;
        if (Math.max(p0z, p1z) < Math.min(A[2], B[2]) - R || Math.min(p0z, p1z) > Math.max(A[2], B[2]) + R) continue;
        closestSegSeg(p0x, p0y, p0z, p1x, p1y, p1z, A[0], A[1], A[2], B[0], B[1], B[2], st);
        const s = st[0], t = st[1];
        const px = p0x + (p1x - p0x) * s, py = p0y + (p1y - p0y) * s, pz = p0z + (p1z - p0z) * s;
        const qx = A[0] + (B[0] - A[0]) * t, qy = A[1] + (B[1] - A[1]) * t, qz = A[2] + (B[2] - A[2]) * t;
        let nx = px - qx, ny = py - qy, nz = pz - qz;
        const d = Math.hypot(nx, ny, nz);
        if (d >= R || d < 1e-9) continue;
        nx /= d; ny /= d; nz /= d;
        this.contact(j, px - c[j3] - nx * rc, py - c[j3 + 1] - ny * rc, pz - c[j3 + 2] - nz * rc, -1, 0, 0, 0, nx, ny, nz, R - d, cap.mu ?? opts.capsuleFriction);
      }
    }
  }

  private buildCandidates() {
    const { ns, c, rc, L } = this;
    let maxL = 0, minL = Infinity;
    for (let j = 0; j < ns; j++) { maxL = Math.max(maxL, L[j]); minL = Math.min(minL, L[j]); }
    const cell = maxL * 1.1 + 2 * rc + Math.max(0.01, 2 * rc);
    // segments closer than ~π rc along the cable can never touch without a kink sharper than the cable allows
    const skip = Math.max(1, Math.ceil((Math.PI * rc) / minL));
    const size = 1 << Math.ceil(Math.log2(Math.max(64, ns * 2)));
    if (this.hStart.length !== size + 1) this.hStart = new Int32Array(size + 1);
    const start = this.hStart, ent = this.hEnt, key = this.hKey;
    start.fill(0);
    const ic = 1 / cell, mask = size - 1;
    const hash = (a: number, b: number, cc: number) => (((a * 92837111) ^ (b * 689287499) ^ (cc * 283923481)) >>> 0) & mask;
    for (let j = 0; j < ns; j++) {
      const k = hash(Math.floor(c[3 * j] * ic), Math.floor(c[3 * j + 1] * ic), Math.floor(c[3 * j + 2] * ic));
      key[j] = k;
      start[k]++;
    }
    let acc = 0;
    for (let k = 0; k < size; k++) { acc += start[k]; start[k] = acc; }
    start[size] = acc;
    for (let j = 0; j < ns; j++) ent[--start[key[j]]] = j;
    // remember the contact normals of the previous candidate list (pair -> normal) so a strand that
    // was pushed through another one in a single substep is detected and pushed back
    const oldN = this.candN, oldV = this.candV, oldCand = this.cand, oldCount = this.ncand;
    const oldMap = new Map<number, number>();
    for (let i = 0; i < oldCount; i++) if (oldV[i]) oldMap.set(oldCand[2 * i] * ns + oldCand[2 * i + 1], i);
    let nc = 0;
    let cand = new Int32Array(Math.max(1024, oldCand.length));
    const r2 = cell * cell;
    const seen = this.seen.fill(-1);
    for (let j = 0; j < ns; j++) {
      const cx = c[3 * j], cy = c[3 * j + 1], cz = c[3 * j + 2];
      const bx = Math.floor(cx * ic), by = Math.floor(cy * ic), bz = Math.floor(cz * ic);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const k = hash(bx + dx, by + dy, bz + dz);
        for (let e = start[k]; e < start[k + 1]; e++) {
          const o = ent[e];
          if (o <= j + skip || seen[o] === j) continue;
          const ex = c[3 * o] - cx, ey = c[3 * o + 1] - cy, ez = c[3 * o + 2] - cz;
          if (ex * ex + ey * ey + ez * ez > r2) continue;
          seen[o] = j;
          if (2 * nc + 2 > cand.length) {
            const nn = new Int32Array(cand.length * 2);
            nn.set(cand);
            cand = nn;
          }
          cand[2 * nc] = j;
          cand[2 * nc + 1] = o;
          nc++;
        }
      }
    }
    this.cand = cand;
    this.ncand = nc;
    this.stats.candidates = nc;
    const N3 = new Float64Array(3 * nc), V = new Uint8Array(nc);
    if (oldMap.size) {
      for (let i = 0; i < nc; i++) {
        const oi = oldMap.get(cand[2 * i] * ns + cand[2 * i + 1]);
        if (oi !== undefined) { N3[3 * i] = oldN[3 * oi]; N3[3 * i + 1] = oldN[3 * oi + 1]; N3[3 * i + 2] = oldN[3 * oi + 2]; V[i] = 1; }
      }
    }
    this.candN = N3;
    this.candV = V;
  }

  private solveSelf() {
    const { c, d3, L, rc, opts, cand, st } = this;
    const N3 = this.candN, V = this.candV;
    const R = 2 * rc, R2 = R * R;
    let contacts = 0;
    for (let i = 0; i < this.ncand; i++) {
      const j = cand[2 * i], o = cand[2 * i + 1];
      const j3 = 3 * j, o3 = 3 * o, hj = L[j] / 2, ho = L[o] / 2;
      const a0x = c[j3] - d3[j3] * hj, a0y = c[j3 + 1] - d3[j3 + 1] * hj, a0z = c[j3 + 2] - d3[j3 + 2] * hj;
      const a1x = c[j3] + d3[j3] * hj, a1y = c[j3 + 1] + d3[j3 + 1] * hj, a1z = c[j3 + 2] + d3[j3 + 2] * hj;
      const b0x = c[o3] - d3[o3] * ho, b0y = c[o3 + 1] - d3[o3 + 1] * ho, b0z = c[o3 + 2] - d3[o3 + 2] * ho;
      const b1x = c[o3] + d3[o3] * ho, b1y = c[o3 + 1] + d3[o3 + 1] * ho, b1z = c[o3 + 2] + d3[o3 + 2] * ho;
      closestSegSeg(a0x, a0y, a0z, a1x, a1y, a1z, b0x, b0y, b0z, b1x, b1y, b1z, st);
      const s = st[0], t = st[1];
      const px = a0x + (a1x - a0x) * s, py = a0y + (a1y - a0y) * s, pz = a0z + (a1z - a0z) * s;
      const qx = b0x + (b1x - b0x) * t, qy = b0y + (b1y - b0y) * t, qz = b0z + (b1z - b0z) * t;
      let nx = px - qx, ny = py - qy, nz = pz - qz;
      const dd = nx * nx + ny * ny + nz * nz;
      const i3 = 3 * i;
      let pen: number;
      const hn = N3[i3] * nx + N3[i3 + 1] * ny + N3[i3 + 2] * nz;
      if (V[i] && hn < 0) {
        // crossed since the last substep: push back along the remembered normal
        nx = N3[i3]; ny = N3[i3 + 1]; nz = N3[i3 + 2];
        pen = R - hn;
        this.stats.crossings++;
      } else {
        if (dd < 1e-16) continue;
        const d = Math.sqrt(dd);
        nx /= d; ny /= d; nz /= d;
        N3[i3] = nx; N3[i3 + 1] = ny; N3[i3 + 2] = nz; V[i] = 1;
        if (dd >= R2) continue;
        pen = R - d;
      }
      contacts++;
      if (dd < this.stats.minDist2) this.stats.minDist2 = dd;
      this.contact(j, px - c[j3] - nx * rc, py - c[j3 + 1] - ny * rc, pz - c[j3 + 2] - nz * rc,
        o, qx - c[o3] + nx * rc, qy - c[o3 + 1] + ny * rc, qz - c[o3 + 2] + nz * rc, nx, ny, nz, pen, opts.selfFriction);
    }
    this.stats.contacts = contacts;
  }

  // ----------------------------------------------------------------- outputs

  /** Material frame of segment j; d1 = stripe direction. */
  segmentFrame(j: number): { d1: V3; d2: V3; d3: V3 } {
    const qq = this.segQuat(j);
    return { d1: quatRotate(qq, [1, 0, 0]), d2: quatRotate(qq, [0, 1, 0]), d3: quatRotate(qq, EZ) };
  }

  /** Per-node frames: d1, d2, d3 per node (9 floats each). */
  nodeFrames(out = new Float32Array(9 * this.n)) {
    return nodeFramesFrom(this.q, this.n, out);
  }

  /** Current arc length of the node polyline. */
  length() {
    let s = 0;
    const x = this.x;
    for (let i = 0; i < this.ns; i++) s += Math.hypot(x[3 * i + 3] - x[3 * i], x[3 * i + 4] - x[3 * i + 1], x[3 * i + 5] - x[3 * i + 2]);
    return s;
  }

  /** Largest gap at a joint relative to the segment length (inextensibility error). */
  maxStrain() {
    let m = 0;
    for (let k = 0; k < this.nj; k++) {
      const a = this.segEnd(k, 1), b = this.segEnd(k + 1, -1);
      m = Math.max(m, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / this.L[k]);
    }
    return m;
  }

  /** Twist Tw in turns over the joints between segments from..to. */
  twistTurns(from = 0, to = this.ns - 1) {
    return twistTurns(this.q, from, to);
  }

  /** Writhe Wr (Gauss integral) of the node polyline from..to. */
  writhe(from = 0, to = this.n - 1) {
    return writhe(this.x, from, to);
  }
}

// --------------------------------------------------- small dense helpers

/** Closest points between segments p1-q1 and p2-q2: out = [s, t] in [0, 1]. */
function closestSegSeg(p1x: number, p1y: number, p1z: number, q1x: number, q1y: number, q1z: number, p2x: number, p2y: number, p2z: number, q2x: number, q2y: number, q2z: number, out: Float64Array) {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s: number, t: number;
  if (a < 1e-14 && e < 1e-14) { s = 0; t = 0; }
  else if (a < 1e-14) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e < 1e-14) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const den = a * e - b * b;
      s = den > 1e-14 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  out[0] = s;
  out[1] = t;
}

/** D += [[W I + T X Xᵀ, T X Yᵀ], [T Y Xᵀ, T Y Yᵀ]] for one body (X at J[ox], Y at J[ox + 9]). */
function blockAdd(D: Float64Array, J: Float64Array, ox: number, W: number, T: number) {
  if (W === 0 && T === 0) return;
  const x00 = J[ox], x01 = J[ox + 1], x02 = J[ox + 2];
  const x10 = J[ox + 3], x11 = J[ox + 4], x12 = J[ox + 5];
  const x20 = J[ox + 6], x21 = J[ox + 7], x22 = J[ox + 8];
  const y00 = J[ox + 9], y01 = J[ox + 10], y02 = J[ox + 11];
  const y10 = J[ox + 12], y11 = J[ox + 13], y12 = J[ox + 14];
  const y20 = J[ox + 15], y21 = J[ox + 16], y22 = J[ox + 17];
  const xx00 = x00 * x00 + x01 * x01 + x02 * x02;
  const yy00 = y00 * y00 + y01 * y01 + y02 * y02;
  const xx01 = x00 * x10 + x01 * x11 + x02 * x12;
  const yy01 = y00 * y10 + y01 * y11 + y02 * y12;
  const xx02 = x00 * x20 + x01 * x21 + x02 * x22;
  const yy02 = y00 * y20 + y01 * y21 + y02 * y22;
  const xx11 = x10 * x10 + x11 * x11 + x12 * x12;
  const yy11 = y10 * y10 + y11 * y11 + y12 * y12;
  const xx12 = x10 * x20 + x11 * x21 + x12 * x22;
  const yy12 = y10 * y20 + y11 * y21 + y12 * y22;
  const xx22 = x20 * x20 + x21 * x21 + x22 * x22;
  const yy22 = y20 * y20 + y21 * y21 + y22 * y22;
  const xy00 = x00 * y00 + x01 * y01 + x02 * y02;
  const xy01 = x00 * y10 + x01 * y11 + x02 * y12;
  const xy02 = x00 * y20 + x01 * y21 + x02 * y22;
  const xy10 = x10 * y00 + x11 * y01 + x12 * y02;
  const xy11 = x10 * y10 + x11 * y11 + x12 * y12;
  const xy12 = x10 * y20 + x11 * y21 + x12 * y22;
  const xy20 = x20 * y00 + x21 * y01 + x22 * y02;
  const xy21 = x20 * y10 + x21 * y11 + x22 * y12;
  const xy22 = x20 * y20 + x21 * y21 + x22 * y22;
  D[0] += W;
  D[0] += T * xx00;
  D[3] += T * xy00;
  D[18] += T * xy00;
  D[21] += T * yy00;
  D[1] += T * xx01;
  D[4] += T * xy01;
  D[24] += T * xy01;
  D[22] += T * yy01;
  D[2] += T * xx02;
  D[5] += T * xy02;
  D[30] += T * xy02;
  D[23] += T * yy02;
  D[7] += W;
  D[6] += T * xx01;
  D[9] += T * xy10;
  D[19] += T * xy10;
  D[27] += T * yy01;
  D[7] += T * xx11;
  D[10] += T * xy11;
  D[25] += T * xy11;
  D[28] += T * yy11;
  D[8] += T * xx12;
  D[11] += T * xy12;
  D[31] += T * xy12;
  D[29] += T * yy12;
  D[14] += W;
  D[12] += T * xx02;
  D[15] += T * xy20;
  D[20] += T * xy20;
  D[33] += T * yy02;
  D[13] += T * xx12;
  D[16] += T * xy21;
  D[26] += T * xy21;
  D[34] += T * yy12;
  D[14] += T * xx22;
  D[17] += T * xy22;
  D[32] += T * xy22;
  D[35] += T * yy22;
}

/** Cc[o..] = J_{k,b} W J_{k+1,a}ᵀ for the shared body: rows (Xb, Yb) at J[pb], cols (Xa', Ya') at J[pa]. */
function crossBlock(Cc: Float64Array, o: number, J: Float64Array, pb: number, pa: number, W: number, T: number) {
  if (W === 0 && T === 0) return;
  const a00 = J[pb], a01 = J[pb + 1], a02 = J[pb + 2];
  const a10 = J[pb + 3], a11 = J[pb + 4], a12 = J[pb + 5];
  const a20 = J[pb + 6], a21 = J[pb + 7], a22 = J[pb + 8];
  const b00 = J[pb + 9], b01 = J[pb + 10], b02 = J[pb + 11];
  const b10 = J[pb + 12], b11 = J[pb + 13], b12 = J[pb + 14];
  const b20 = J[pb + 15], b21 = J[pb + 16], b22 = J[pb + 17];
  const c00 = J[pa], c01 = J[pa + 1], c02 = J[pa + 2];
  const c10 = J[pa + 3], c11 = J[pa + 4], c12 = J[pa + 5];
  const c20 = J[pa + 6], c21 = J[pa + 7], c22 = J[pa + 8];
  const d00 = J[pa + 9], d01 = J[pa + 10], d02 = J[pa + 11];
  const d10 = J[pa + 12], d11 = J[pa + 13], d12 = J[pa + 14];
  const d20 = J[pa + 15], d21 = J[pa + 16], d22 = J[pa + 17];
  Cc[o] -= W;
  Cc[o] += T * (a00 * c00 + a01 * c01 + a02 * c02);
  Cc[o + 3] += T * (a00 * d00 + a01 * d01 + a02 * d02);
  Cc[o + 18] += T * (b00 * c00 + b01 * c01 + b02 * c02);
  Cc[o + 21] += T * (b00 * d00 + b01 * d01 + b02 * d02);
  Cc[o + 1] += T * (a00 * c10 + a01 * c11 + a02 * c12);
  Cc[o + 4] += T * (a00 * d10 + a01 * d11 + a02 * d12);
  Cc[o + 19] += T * (b00 * c10 + b01 * c11 + b02 * c12);
  Cc[o + 22] += T * (b00 * d10 + b01 * d11 + b02 * d12);
  Cc[o + 2] += T * (a00 * c20 + a01 * c21 + a02 * c22);
  Cc[o + 5] += T * (a00 * d20 + a01 * d21 + a02 * d22);
  Cc[o + 20] += T * (b00 * c20 + b01 * c21 + b02 * c22);
  Cc[o + 23] += T * (b00 * d20 + b01 * d21 + b02 * d22);
  Cc[o + 7] -= W;
  Cc[o + 6] += T * (a10 * c00 + a11 * c01 + a12 * c02);
  Cc[o + 9] += T * (a10 * d00 + a11 * d01 + a12 * d02);
  Cc[o + 24] += T * (b10 * c00 + b11 * c01 + b12 * c02);
  Cc[o + 27] += T * (b10 * d00 + b11 * d01 + b12 * d02);
  Cc[o + 7] += T * (a10 * c10 + a11 * c11 + a12 * c12);
  Cc[o + 10] += T * (a10 * d10 + a11 * d11 + a12 * d12);
  Cc[o + 25] += T * (b10 * c10 + b11 * c11 + b12 * c12);
  Cc[o + 28] += T * (b10 * d10 + b11 * d11 + b12 * d12);
  Cc[o + 8] += T * (a10 * c20 + a11 * c21 + a12 * c22);
  Cc[o + 11] += T * (a10 * d20 + a11 * d21 + a12 * d22);
  Cc[o + 26] += T * (b10 * c20 + b11 * c21 + b12 * c22);
  Cc[o + 29] += T * (b10 * d20 + b11 * d21 + b12 * d22);
  Cc[o + 14] -= W;
  Cc[o + 12] += T * (a20 * c00 + a21 * c01 + a22 * c02);
  Cc[o + 15] += T * (a20 * d00 + a21 * d01 + a22 * d02);
  Cc[o + 30] += T * (b20 * c00 + b21 * c01 + b22 * c02);
  Cc[o + 33] += T * (b20 * d00 + b21 * d01 + b22 * d02);
  Cc[o + 13] += T * (a20 * c10 + a21 * c11 + a22 * c12);
  Cc[o + 16] += T * (a20 * d10 + a21 * d11 + a22 * d12);
  Cc[o + 31] += T * (b20 * c10 + b21 * c11 + b22 * c12);
  Cc[o + 34] += T * (b20 * d10 + b21 * d11 + b22 * d12);
  Cc[o + 14] += T * (a20 * c20 + a21 * c21 + a22 * c22);
  Cc[o + 17] += T * (a20 * d20 + a21 * d21 + a22 * d22);
  Cc[o + 32] += T * (b20 * c20 + b21 * c21 + b22 * c22);
  Cc[o + 35] += T * (b20 * d20 + b21 * d21 + b22 * d22);
}

/** Cholesky solve of the SPD D X = [B | rhs] (unrolled); false if D is not numerically SPD. */
function chol6(D: Float64Array, B: Float64Array, ob: number, hasB: boolean, rhs: Float64Array, Cp: Float64Array, oc: number, dp: Float64Array, od: number): boolean {
  let s: number;
  s = D[0];
  if (s <= 1e-300) return false;
  const l00 = Math.sqrt(s);
  const l10 = D[6] / l00;
  s = D[7] - l10 * l10;
  if (s <= 1e-300) return false;
  const l11 = Math.sqrt(s);
  const l20 = D[12] / l00;
  const l21 = (D[13] - l20 * l10) / l11;
  s = D[14] - l20 * l20 - l21 * l21;
  if (s <= 1e-300) return false;
  const l22 = Math.sqrt(s);
  const l30 = D[18] / l00;
  const l31 = (D[19] - l30 * l10) / l11;
  const l32 = (D[20] - l30 * l20 - l31 * l21) / l22;
  s = D[21] - l30 * l30 - l31 * l31 - l32 * l32;
  if (s <= 1e-300) return false;
  const l33 = Math.sqrt(s);
  const l40 = D[24] / l00;
  const l41 = (D[25] - l40 * l10) / l11;
  const l42 = (D[26] - l40 * l20 - l41 * l21) / l22;
  const l43 = (D[27] - l40 * l30 - l41 * l31 - l42 * l32) / l33;
  s = D[28] - l40 * l40 - l41 * l41 - l42 * l42 - l43 * l43;
  if (s <= 1e-300) return false;
  const l44 = Math.sqrt(s);
  const l50 = D[30] / l00;
  const l51 = (D[31] - l50 * l10) / l11;
  const l52 = (D[32] - l50 * l20 - l51 * l21) / l22;
  const l53 = (D[33] - l50 * l30 - l51 * l31 - l52 * l32) / l33;
  const l54 = (D[34] - l50 * l40 - l51 * l41 - l52 * l42 - l53 * l43) / l44;
  s = D[35] - l50 * l50 - l51 * l51 - l52 * l52 - l53 * l53 - l54 * l54;
  if (s <= 1e-300) return false;
  const l55 = Math.sqrt(s);
  const ncol = hasB ? 7 : 1;
  for (let col = 0; col < ncol; col++) {
    const fromB = hasB && col < 6, bo = ob + col;
    const b0 = fromB ? B[bo + 0] : rhs[0];
    const b1 = fromB ? B[bo + 6] : rhs[1];
    const b2 = fromB ? B[bo + 12] : rhs[2];
    const b3 = fromB ? B[bo + 18] : rhs[3];
    const b4 = fromB ? B[bo + 24] : rhs[4];
    const b5 = fromB ? B[bo + 30] : rhs[5];
    const y0 = (b0) / l00;
    const y1 = (b1 - l10 * y0) / l11;
    const y2 = (b2 - l20 * y0 - l21 * y1) / l22;
    const y3 = (b3 - l30 * y0 - l31 * y1 - l32 * y2) / l33;
    const y4 = (b4 - l40 * y0 - l41 * y1 - l42 * y2 - l43 * y3) / l44;
    const y5 = (b5 - l50 * y0 - l51 * y1 - l52 * y2 - l53 * y3 - l54 * y4) / l55;
    const x5 = (y5) / l55;
    const x4 = (y4 - l54 * x5) / l44;
    const x3 = (y3 - l43 * x4 - l53 * x5) / l33;
    const x2 = (y2 - l32 * x3 - l42 * x4 - l52 * x5) / l22;
    const x1 = (y1 - l21 * x2 - l31 * x3 - l41 * x4 - l51 * x5) / l11;
    const x0 = (y0 - l10 * x1 - l20 * x2 - l30 * x3 - l40 * x4 - l50 * x5) / l00;
    if (fromB) {
      const co = oc + col;
      Cp[co + 0] = x0;
      Cp[co + 6] = x1;
      Cp[co + 12] = x2;
      Cp[co + 18] = x3;
      Cp[co + 24] = x4;
      Cp[co + 30] = x5;
    } else {
      dp[od + 0] = x0;
      dp[od + 1] = x1;
      dp[od + 2] = x2;
      dp[od + 3] = x3;
      dp[od + 4] = x4;
      dp[od + 5] = x5;
    }
  }
  return true;
}

/** D X = [B | rhs] by Gaussian elimination with partial pivoting (fallback when D is not SPD). */
function solve6(D: Float64Array, B: Float64Array, ob: number, hasB: boolean, rhs: Float64Array, Cp: Float64Array, oc: number, dp: Float64Array, od: number, M: Float64Array) {
  const nc = hasB ? 7 : 1, w = 6 + nc;
  for (let r = 0; r < 6; r++) {
    for (let s = 0; s < 6; s++) M[w * r + s] = D[6 * r + s];
    if (hasB) {
      for (let s = 0; s < 6; s++) M[w * r + 6 + s] = B[ob + 6 * r + s];
      M[w * r + 12] = rhs[r];
    } else M[w * r + 6] = rhs[r];
  }
  for (let col = 0; col < 6; col++) {
    let piv = col, best = Math.abs(M[w * col + col]);
    for (let r = col + 1; r < 6; r++) {
      const v = Math.abs(M[w * r + col]);
      if (v > best) { best = v; piv = r; }
    }
    if (piv !== col) for (let s = 0; s < w; s++) { const tmp = M[w * col + s]; M[w * col + s] = M[w * piv + s]; M[w * piv + s] = tmp; }
    const ip = 1 / (M[w * col + col] || 1e-30);
    for (let r = col + 1; r < 6; r++) {
      const f = M[w * r + col] * ip;
      if (f === 0) continue;
      for (let s = col; s < w; s++) M[w * r + s] -= f * M[w * col + s];
    }
  }
  for (let col = 5; col >= 0; col--) {
    const ip = 1 / (M[w * col + col] || 1e-30);
    for (let s = 6; s < w; s++) {
      let v = M[w * col + s];
      for (let t = col + 1; t < 6; t++) v -= M[w * col + t] * M[w * t + s];
      M[w * col + s] = v * ip;
    }
  }
  if (hasB) {
    for (let r = 0; r < 6; r++) {
      for (let s = 0; s < 6; s++) Cp[oc + 6 * r + s] = M[w * r + 6 + s];
      dp[od + r] = M[w * r + 12];
    }
  } else for (let r = 0; r < 6; r++) dp[od + r] = M[w * r + 6];
}

// ---------------------------------------------------------------- analysis

/** Per-node frames from segment quaternions: node i averages segments i-1 and i; out = d1, d2, d3 per node (9 floats). */
export function nodeFramesFrom(q: ArrayLike<number>, n: number, out: Float32Array) {
  const ns = n - 1;
  for (let i = 0; i < n; i++) {
    const ja = Math.max(0, i - 1), jb = Math.min(ns - 1, i);
    const ax = q[4 * ja], ay = q[4 * ja + 1], az = q[4 * ja + 2], aw = q[4 * ja + 3];
    let bx = q[4 * jb], by = q[4 * jb + 1], bz = q[4 * jb + 2], bw = q[4 * jb + 3];
    if (ax * bx + ay * by + az * bz + aw * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
    let x = ax + bx, y = ay + by, z = az + bz, w = aw + bw;
    const il = 1 / Math.hypot(x, y, z, w);
    x *= il; y *= il; z *= il; w *= il;
    const o = 9 * i;
    out[o] = 1 - 2 * (y * y + z * z); out[o + 1] = 2 * (x * y + w * z); out[o + 2] = 2 * (x * z - w * y);
    out[o + 3] = 2 * (x * y - w * z); out[o + 4] = 1 - 2 * (x * x + z * z); out[o + 5] = 2 * (y * z + w * x);
    out[o + 6] = 2 * (x * z + w * y); out[o + 7] = 2 * (y * z - w * x); out[o + 8] = 1 - 2 * (x * x + y * y);
  }
  return out;
}

/** Twist Tw [turns] over the joints between segments from..to of the quaternions q. */
export function twistTurns(q: ArrayLike<number>, from: number, to: number) {
  let tw = 0;
  for (let k = from; k < to; k++) {
    const a4 = 4 * k, b4 = a4 + 4;
    const ax = -q[a4], ay = -q[a4 + 1], az = -q[a4 + 2], aw = q[a4 + 3];
    const bx = q[b4], by = q[b4 + 1], bz = q[b4 + 2], bw = q[b4 + 3];
    let oz = aw * bz + ax * by - ay * bx + az * bw;
    let ow = aw * bw - ax * bx - ay * by - az * bz;
    if (ow < 0) { oz = -oz; ow = -ow; }
    tw += 2 * Math.atan2(oz, ow);
  }
  return tw / TAU;
}

const asinC = (v: number) => Math.asin(Math.max(-1, Math.min(1, v)));

/** Writhe Wr of the polyline x (3 per node) from node `from` to node `to` (Gauss integral, Klenin & Langowski). */
export function writhe(x: ArrayLike<number>, from: number, to: number) {
  let wr = 0;
  for (let i = from; i < to; i++) {
    const p1x = x[3 * i], p1y = x[3 * i + 1], p1z = x[3 * i + 2];
    const p2x = x[3 * i + 3], p2y = x[3 * i + 4], p2z = x[3 * i + 5];
    for (let j = i + 2; j < to; j++) {
      const p3x = x[3 * j], p3y = x[3 * j + 1], p3z = x[3 * j + 2];
      const p4x = x[3 * j + 3], p4y = x[3 * j + 4], p4z = x[3 * j + 5];
      const r13x = p3x - p1x, r13y = p3y - p1y, r13z = p3z - p1z;
      const r14x = p4x - p1x, r14y = p4y - p1y, r14z = p4z - p1z;
      const r23x = p3x - p2x, r23y = p3y - p2y, r23z = p3z - p2z;
      const r24x = p4x - p2x, r24y = p4y - p2y, r24z = p4z - p2z;
      // n1 = r13 × r14, n2 = r14 × r24, n3 = r24 × r23, n4 = r23 × r13 (normalised)
      let n1x = r13y * r14z - r13z * r14y, n1y = r13z * r14x - r13x * r14z, n1z = r13x * r14y - r13y * r14x;
      let n2x = r14y * r24z - r14z * r24y, n2y = r14z * r24x - r14x * r24z, n2z = r14x * r24y - r14y * r24x;
      let n3x = r24y * r23z - r24z * r23y, n3y = r24z * r23x - r24x * r23z, n3z = r24x * r23y - r24y * r23x;
      let n4x = r23y * r13z - r23z * r13y, n4y = r23z * r13x - r23x * r13z, n4z = r23x * r13y - r23y * r13x;
      const l1 = Math.hypot(n1x, n1y, n1z), l2 = Math.hypot(n2x, n2y, n2z), l3 = Math.hypot(n3x, n3y, n3z), l4 = Math.hypot(n4x, n4y, n4z);
      if (l1 < 1e-15 || l2 < 1e-15 || l3 < 1e-15 || l4 < 1e-15) continue;
      n1x /= l1; n1y /= l1; n1z /= l1; n2x /= l2; n2y /= l2; n2z /= l2;
      n3x /= l3; n3y /= l3; n3z /= l3; n4x /= l4; n4y /= l4; n4z /= l4;
      const om = asinC(n1x * n2x + n1y * n2y + n1z * n2z) + asinC(n2x * n3x + n2y * n3y + n2z * n3z) + asinC(n3x * n4x + n3y * n4y + n3z * n4z) + asinC(n4x * n1x + n4y * n1y + n4z * n1z);
      // sign of ((p4 - p3) × (p2 - p1)) · r13
      const ax = p4x - p3x, ay = p4y - p3y, az = p4z - p3z, bx = p2x - p1x, by = p2y - p1y, bz = p2z - p1z;
      const sg = Math.sign((ay * bz - az * by) * r13x + (az * bx - ax * bz) * r13y + (ax * by - ay * bx) * r13z);
      wr += om * sg;
    }
  }
  return (2 * wr) / (4 * Math.PI);
}

// ----------------------------------------------------------- shape helpers

export interface CoilOptions {
  center?: V3;
  /** loop radius [m] */
  R?: number;
  loops?: number;
  /** rise per loop [m] */
  pitch?: number;
  /** segment length [m] */
  seg?: number;
  /** straight tail at each end [m] */
  lead?: number;
  /** +1 / -1: direction of rotation about the vertical axis */
  handed?: number;
}

/** Node positions of a helix (coil) about the vertical axis through `center`, with straight tails. */
export function coilPoints({ center = [0, 0, 0], R = 0.18, loops = 6, pitch = 0.008, seg = 0.025, lead = 0.3, handed = 1 }: CoilOptions): V3[] {
  const pts: V3[] = [];
  const len = loops * TAU * R;
  const nCoil = Math.max(2, Math.round(len / seg));
  const coil = (u: number): V3 => {
    const th = handed * u * loops * TAU;
    return [center[0] + R * Math.cos(th), center[1] + u * loops * pitch, center[2] + R * Math.sin(th)];
  };
  const tan = (u: number): V3 => {
    const th = handed * u * loops * TAU, k = handed * loops * TAU * R;
    return [-Math.sin(th) * k, loops * pitch, Math.cos(th) * k];
  };
  const norm = (v: V3): V3 => {
    const l = Math.hypot(...v);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const nl = Math.round(lead / seg);
  if (lead > 0) {
    const t0 = norm(tan(0)), p0 = coil(0);
    for (let i = nl; i >= 1; i--) pts.push([p0[0] - t0[0] * i * seg, p0[1], p0[2] - t0[2] * i * seg]);
  }
  for (let i = 0; i <= nCoil; i++) pts.push(coil(i / nCoil));
  if (lead > 0) {
    const t1 = norm(tan(1)), p1 = coil(1);
    for (let i = 1; i <= nl; i++) pts.push([p1[0] + t1[0] * i * seg, p1[1], p1[2] + t1[2] * i * seg]);
  }
  return pts;
}
