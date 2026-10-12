// Stage 5.4 "Nicht um Hand und Ellenbogen" (KONZEPT), the simulated cable for the part p5-elbow:
// Noor shows the mistake ("So nicht."): she wraps the 5 m XLR four times round her left hand and
// elbow. Every wrap turns the cable once more, the wraps are bent tight round the elbow and over
// the hand, and she pulls each one snug. ("So." is the stage 1 coiling bake coil-dev-n, played by
// the part.)
//
// What is prescribed and what is simulated:
//   - prescribed: Noor's arms. The left forearm is angled up in front of her (the elbow in front of
//     the body, mocap/shots.json p5.elbow.wrong), the end of the cable in the left fist (its plug
//     held by a bundle). The right hand is a loose fist the cable slides through and can turn in
//     (a pinch with rolls: false): it circles the left forearm on keyframes (ELBOW_T), four wraps.
//   - pseudo-simulation (KONZEPT "Führungskräfte"): where the cable lies on the arm. Once the
//     strand has been carried round a part of the arm, soft guides keep it there on a path round
//     hand and elbow (the arm's surface; in reality tension and friction hold it). Guides act on
//     positions only: they never turn the cable about its axis.
//   - simulated: everything about twist. Nobody turns the cable: the right hand lets it turn, the
//     left fist and the plug on the floor hold its ends. Wrapping it round the arm loop after loop
//     (writhe) is what twists it: the stripe winds, in the wraps and in the cable to the floor.
//     Also simulated: the cable to the floor hanging, swinging and lying, its weight, the plug,
//     the tension when she pulls a wrap snug (pin.force), contacts with arm, hand, body and legs.
//
// Coordinates as in stage 1: Noor stands at the origin facing −z, her right is +x, y up.

import { Capsule, Frame, Rod, V3, XLR, buildCable, frameTrack, gripFrame } from '../sim';
import { NOOR } from '../people/cast';
import { handColliders } from '../people/colliders';
import { J, Pose } from '../people/people';
import { HandRig, Rig, RigTrack, stand } from '../people/rig';
import type { ShotDef } from './types';

// ------------------------------------------------------------------------------------- vectors

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => mul(a, 1 / (len(a) || 1));
const mix = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** across: v without its part along unit d, normalised */
const across = (v: V3, d: V3) => norm(sub(v, mul(d, dot(v, d))));
/** minimum-jerk ease 0 → 1 */
export const ease = (u: number) => {
  const x = clamp01(u);
  return x * x * x * (10 - 15 * x + 6 * x * x);
};
const sstep = (u: number) => {
  const x = clamp01(u);
  return x * x * (3 - 2 * x);
};

const D = Math.PI / 180;
const RC = XLR.od / 2;

// ------------------------------------------------------------------------------------- timing

/**
 * The shot's timing [s]. Wrap k (0 … WRAPS-1) starts at T0 + k·PERIOD: the right hand carries the
 * cable once round hand and elbow (LAY), then pulls it snug above the fist (TUG) and goes on with
 * the next wrap. Natural pace ("Arbeitstempo", mocap p5.elbow.wrong). Three wraps: with the 5 m XLR
 * a fourth would lift the plug off the floor, and a free plug lets the twist run out (stage 5.2).
 */
export const ELBOW_T = (() => {
  const T0 = 0.8, LAY = 1.45, TUG = 0.35;
  const PERIOD = LAY + TUG;
  const WRAPS = 3;
  const end = T0 + WRAPS * PERIOD;
  return {
    T0, LAY, TUG, PERIOD, WRAPS,
    /** wrap k: start, laid round (the snug pull starts), done */
    wrap: (k: number) => {
      const t0 = T0 + k * PERIOD;
      return { t0, laid: t0 + LAY, done: t0 + PERIOD };
    },
    /** after the last wrap the hand holds the cable above the fist (the cable to the floor settles) */
    end,
    duration: end + 2.6,
  };
})();

// ------------------------------------------------------------------------------------- Noor

/** her stance: as in stage 1 (coil-engine coilStance), so the comparison panels match */
export const STANCE = { ...stand(NOOR, [0, 0], 0, { width: 0.3 }), lean: 0.06 };

/**
 * The left hand: a fist holding the cable's end (its plug inside), the forearm angled up in front
 * of her, the elbow in front of the body (not behind it, KONZEPT / mocap note), the palm towards her
 * middle. A free hand (no grip): the plug sits in the fist's hollow, along the fingers' direction,
 * the cable comes out on top between thumb and index finger.
 */
const LEFT_DIR = norm([0.15, 0.85, -0.5]);
export const LEFT: HandRig = {
  wrist: [-0.15, 1.26, -0.34],
  dir: LEFT_DIR,
  palm: across([1, 0, 0.3], LEFT_DIR),
  curl: 0.85,
  pinch: 0.3,
  elbow: [-0.2, -1, -0.6],
  elbowWeight: 5,
  joints: { flex: 45 * D, abd: 10 * D, elbow: 110 * D },
  jointWeight: 5,
};

/** where she looks at first: her left forearm */
const LOOK_ARM: V3 = [-0.12, 1.12, -0.33];

let leftPoseCache: Pose | null = null;
/**
 * The left arm as the stateful IK settles it (RigTrack from t = −2 s, the same as the part's and
 * the bake's tracks): static from shot time 0 on. The arm's capsules and the wrap path come from it.
 */
export function leftPose(): Pose {
  if (!leftPoseCache) {
    const track = new RigTrack(NOOR, () => ({ ...STANCE, look: LOOK_ARM, hands: [LEFT, null] }), -2, 60);
    leftPoseCache = track.pose(0);
  }
  return leftPoseCache;
}

// ------------------------------------------------------------------------------------- geometry

/**
 * The arm and the path of the wraps. The wraps lie in the plane through the forearm's axis that is
 * square to the upper arm (so they pass round the elbow below the upper arm): over the top of the
 * fist between thumb and index finger ("web"), down the inner side of the forearm (her middle),
 * round under the elbow, up the outer side, over the top again. Successive wraps lie side by side
 * (6.8 mm apart across the plane). Every point keeps the cable's radius + 2 mm off the arm's
 * capsules.
 */
export const ELBOW_GEOM = (() => {
  const pose = leftPose();
  const j = pose.joints;
  const E = j[J.leftElbow], Wr = j[J.leftWrist], S = j[J.leftShoulder];
  const hand = pose.body.hands[0];
  const q = hand.q;
  /** the fist's middle (the plug lies here) */
  const C = add(add(hand.wrist, mul(hand.fd, 0.05 * q)), mul(hand.palm, 0.018 * q));
  /** the hand end of the path: its centre and radius; the elbow end */
  const Hc = add(hand.wrist, mul(hand.fd, 0.045 * q));
  const RH = 0.047, RE = 0.052;
  const a = norm(sub(Hc, E));
  const ua = norm(sub(S, E));
  /** the plane's normal: the upper arm's direction square to the forearm (towards her chest) */
  const n = across(ua, a);
  /** across the plane: towards her middle (medial) */
  const s = norm(cross(a, n));

  // capsules of the arm and body (the simulation's, and the path keeps off them)
  const k = pose.body.k;
  const B = pose.spec.build;
  const L = B.limbs;
  const arm: Capsule[] = [
    { a: S, b: E, r: 0.048 * k * L + 0.003 },
    { a: E, b: Wr, r: 0.04 * k * L + 0.003 },
  ];
  const hand0 = handColliders(pose, 0, { forearm: false, group: 0 }).map((c) => ({ a: c.a, b: c.b, r: c.r, group: 0 }) as Capsule);
  const body: Capsule[] = [
    { a: j[J.pelvis], b: j[J.neck], r: 0.12 * k * B.chest },
    { a: j[J.leftShoulder], b: j[J.leftHip], r: 0.1 * k },
    { a: j[J.rightShoulder], b: j[J.rightHip], r: 0.1 * k },
    { a: j[J.leftHip], b: j[J.leftKnee], r: 0.075 * k * L },
    { a: j[J.rightHip], b: j[J.rightKnee], r: 0.075 * k * L },
    { a: j[J.leftKnee], b: j[J.leftAnkle], r: 0.052 * k * L },
    { a: j[J.rightKnee], b: j[J.rightAnkle], r: 0.052 * k * L },
  ];
  const caps = [...arm, ...hand0, ...body];

  /** push a point out of every capsule (to its surface + the cable + margin) */
  const clear = (p: V3, margin = 0.002): V3 => {
    let x = p;
    for (let it = 0; it < 4; it++) {
      for (const c of caps) {
        const ab = sub(c.b, c.a), l2 = dot(ab, ab);
        const u = l2 > 1e-12 ? clamp01(dot(sub(x, c.a), ab) / l2) : 0;
        const cp = add(c.a, mul(ab, u));
        const d = sub(x, cp), dl = len(d), want = c.r + RC + margin;
        if (dl < want) x = dl > 1e-9 ? add(cp, mul(d, want / dl)) : add(cp, mul(n, want));
      }
    }
    return x;
  };

  // one loop of the path, dense, from the web (top of the fist) round: inner side, elbow, outer side
  const raw: V3[] = [];
  const arc = (c: V3, r: number, from: number, to: number, m: number) => {
    // angle 0 = a (towards the hand), +90° = s (inner side)
    for (let i = 0; i < m; i++) {
      const th = from + ((to - from) * i) / m;
      raw.push(add(c, add(mul(a, r * Math.cos(th)), mul(s, r * Math.sin(th)))));
    }
  };
  const line = (p: V3, q2: V3, m: number) => {
    for (let i = 0; i < m; i++) raw.push(mix(p, q2, i / m));
  };
  arc(Hc, RH, 0, Math.PI / 2, 40);
  line(add(Hc, mul(s, RH)), add(E, mul(s, RE)), 120);
  arc(E, RE, Math.PI / 2, (3 * Math.PI) / 2, 80);
  line(add(E, mul(s, -RE)), add(Hc, mul(s, -RH)), 120);
  arc(Hc, RH, (3 * Math.PI) / 2, 2 * Math.PI, 40);
  raw.push(raw[0]);
  const loop = raw.map((p) => clear(p));
  // a few passes of smoothing, keeping clear of the arm
  let P = loop;
  for (let r = 0; r < 6; r++) {
    const Q = P.map((p, i) => (i === 0 || i === P.length - 1 ? p : mix(p, mul(add(P[i - 1], P[i + 1]), 0.5), 0.5)));
    P = Q.map((p) => clear(p));
  }
  P[P.length - 1] = P[0];
  const acc = [0];
  for (let i = 1; i < P.length; i++) acc.push(acc[i - 1] + len(sub(P[i], P[i - 1])));
  /** one wrap's length along the path [m] */
  const LW = acc[acc.length - 1];
  const at = (sig: number): V3 => {
    const x = ((sig % LW) + LW) % LW;
    let lo = 0, hi = acc.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (acc[mid] <= x) lo = mid;
      else hi = mid;
    }
    const w = (x - acc[lo]) / (acc[hi] - acc[lo] || 1);
    return mix(P[lo], P[hi], w);
  };
  /** wraps lie side by side across the plane, centred: offset along n for path length sig */
  const SPACING = 2 * RC + 0.0004;
  const offset = (sig: number) => (sig / LW) * SPACING;
  /** the target of the cable at path length sig (0 = the web at the start, WRAPS·LW = done) */
  const target = (sig: number): V3 => clear(add(at(sig), mul(n, offset(sig))), 0.0015);
  /** the path's direction at sig */
  const tangent = (sig: number): V3 => norm(sub(at(sig + 0.004), at(sig - 0.004)));
  /** outward from the path in the plane (away from the arm's axis) */
  const outward = (sig: number): V3 => {
    const t = tangent(sig);
    return norm(cross(t, n)) as V3;
  };
  // (outward must point away from the arm: check at the elbow end and flip if needed)
  const probe = LW * 0.5;
  const flip = dot(outward(probe), sub(at(probe), E)) < 0 ? -1 : 1;
  return {
    E, Wr, S, C, Hc, RH, RE, a, n, s, LW, caps, arm, body, hand: hand0,
    /** the fist frame (for the bundle holding the plug): p in the fist, d3 along the fingers (the plug's axis), d1 to the palm */
    fist: gripFrame(C, hand.fd, mul(hand.palm, -1)) as Frame,
    fd: hand.fd,
    at,
    target,
    tangent,
    outward: (sig: number) => mul(outward(sig), flip),
    /** push a point off the arm and body (cable radius + margin) */
    clear,
    /** the path with the wraps' offset, not pushed off the arm (cheap: for the hand's kinematics) */
    raw: (sig: number): V3 => add(at(sig), mul(n, offset(sig))),
    /** the web: where every wrap starts and ends (the top of the fist) */
    web: (k: number) => target(k * LW),
  };
})();

// ------------------------------------------------------------------------------------- right hand

/**
 * The right hand's path round the arm for wrap k, as a function of the path parameter phi (0 … LW):
 * outside the wrap path by `d`, a little towards her middle at the start and end of a wrap (so the
 * cable to the floor hangs beside the arm, not over it).
 */
function handOnPath(k: number, phi: number): V3 {
  const G = ELBOW_GEOM, LW = G.LW;
  const sig = k * LW + phi;
  const elbowEnd = Math.exp(-(((phi - 0.5 * LW) / (0.13 * LW)) ** 2));
  const d = 0.1 - 0.025 * elbowEnd;
  const b = 0.06 * (1 - sstep(phi / 0.14)) + 0.06 * sstep((phi - (LW - 0.14)) / 0.14);
  return add(add(G.raw(sig), mul(G.outward(sig), d)), mul(G.s, b));
}

/** per wrap: the hand path sampled every 2 mm of phi, with its arc length (uniform speed along it) */
const HAND_PATHS = (() => {
  const G = ELBOW_GEOM;
  const M = Math.ceil(G.LW / 0.002);
  return Array.from({ length: ELBOW_T.WRAPS }, (_, k) => {
    const P: V3[] = [], acc: number[] = [0];
    for (let i = 0; i <= M; i++) {
      P.push(handOnPath(k, (G.LW * i) / M));
      if (i) acc.push(acc[i - 1] + len(sub(P[i], P[i - 1])));
    }
    return { P, acc, L: acc[M] };
  });
})();

/** the hand on wrap k's path at fraction u (0 … 1) of its length */
function handAlong(k: number, u: number): V3 {
  const hp = HAND_PATHS[k];
  const x = clamp01(u) * hp.L;
  let lo = 0, hi = hp.acc.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (hp.acc[mid] <= x) lo = mid;
    else hi = mid;
  }
  return mix(hp.P[lo], hp.P[hi], (x - hp.acc[lo]) / (hp.acc[hi] - hp.acc[lo] || 1));
}

/** the hand's position at shot time t (keyframed path; no simulation) */
function handPos(t: number): V3 {
  const T = ELBOW_T;
  if (t < T.T0) return handAlong(0, 0);
  const k = Math.floor((t - T.T0) / T.PERIOD);
  if (k >= T.WRAPS) return handAlong(T.WRAPS - 1, 1);
  const w = T.wrap(k);
  if (t < w.laid) return handAlong(k, ease((t - w.t0) / T.LAY));
  // the snug pull: out by 1.5 cm and back, then on to the next wrap's start
  const u = (t - w.laid) / T.TUG;
  const end = handAlong(k, 1);
  const next = k + 1 < T.WRAPS ? handAlong(k + 1, 0) : end;
  const out = norm(sub(end, ELBOW_GEOM.raw((k + 1) * ELBOW_GEOM.LW)));
  return add(mix(end, next, sstep(u)), mul(out, 0.015 * Math.sin(Math.PI * clamp01(u))));
}

/**
 * The wrapping kinematics, sampled at 300 Hz. Where the cable leaves the arm: as for a taut string,
 * the first point past the laid part whose outward side faces the hand (the tangent point); what
 * lies before it is laid round the arm (monotonic). Which material is in the hand: the cable slides
 * through the loose fist as the wrap needs it, at most FEED m/s, early enough that the part between
 * the arm and the hand is never shorter than the straight line (+ 1 cm): material sHand (from the
 * web), non-decreasing.
 */
const FEED = 0.9;
const KIN = (() => {
  const G = ELBOW_GEOM;
  const HZ = 300;
  const N = Math.ceil(ELBOW_T.duration * HZ) + 2;
  const sc = new Float64Array(N), need = new Float64Array(N), sh = new Float64Array(N);
  let prev = 0;
  const total = ELBOW_T.WRAPS * G.LW;
  for (let f = 0; f < N; f++) {
    const t = f / HZ;
    const h = handPos(t);
    let sig = prev;
    // first visible point from the hand at or past the laid part (2 mm steps, then refined)
    while (sig < total && dot(sub(h, G.raw(sig)), G.outward(sig)) <= 0) sig += 0.002;
    if (sig > prev) {
      let lo = Math.max(prev, sig - 0.002), hi = sig;
      for (let it = 0; it < 12; it++) {
        const m = (lo + hi) / 2;
        if (dot(sub(h, G.raw(m)), G.outward(m)) <= 0) lo = m;
        else hi = m;
      }
      sig = hi;
    }
    prev = Math.min(total, sig);
    sc[f] = prev;
    need[f] = prev + len(sub(h, G.raw(prev))) + 0.01;
  }
  // rate-limited from behind (the cable starts sliding early enough), then non-decreasing
  sh[N - 1] = need[N - 1];
  for (let f = N - 2; f >= 0; f--) sh[f] = Math.max(need[f], sh[f + 1] - FEED / HZ);
  for (let f = 1; f < N; f++) sh[f] = Math.max(sh[f], sh[f - 1]);
  return { HZ, sc, sh };
})();

const sampleKin = (arr: Float64Array, t: number) => {
  const x = Math.max(0, t) * KIN.HZ;
  const f = Math.min(arr.length - 2, Math.floor(x));
  return arr[f] + (arr[f + 1] - arr[f]) * (x - f);
};
/** path length laid round the arm at shot time t [m] */
export const laidAt = (t: number) => sampleKin(KIN.sc, t);
/** the material in the right hand at shot time t, from the web [m] */
export const handMaterialAt = (t: number) => sampleKin(KIN.sh, t);

export interface RightState {
  /** the loose fist round the cable: p where the cable runs through it, d3 from the arm towards the hand */
  frame: Frame;
  /** where the cable leaves the arm */
  contact: V3;
  /** path length laid round the arm [m] */
  laid: number;
  /** wraps finished (0 … WRAPS) */
  wraps: number;
  /** 0 … 1 while she pulls a wrap snug */
  snug: number;
}

/** the right hand and the cable's contact at shot time t */
export function rightAt(t: number): RightState {
  const G = ELBOW_GEOM, T = ELBOW_T;
  const h = handPos(t);
  const laid = laidAt(t);
  const contact = G.raw(laid);
  const d3 = norm(sub(h, contact));
  const k = Math.floor((Math.max(t, T.T0) - T.T0) / T.PERIOD);
  let snug = 0;
  if (k < T.WRAPS && t >= T.T0) {
    const w = T.wrap(k);
    if (t >= w.laid) snug = Math.sin(Math.PI * clamp01((t - w.laid) / T.TUG));
  }
  return { frame: gripFrame(h, d3, across(G.n, d3)), contact, laid, wraps: Math.min(T.WRAPS, Math.floor(laid / G.LW + 0.02)), snug };
}

/**
 * Noor's rig at shot time t: the left arm still (the cable lies on it), the right fist round the
 * cable where the taut strand ends. The part builds a RigTrack from it (t0 = −2 s, as leftPose), so
 * the left arm is the same settled arm the simulation used.
 */
export function elbowRig(t: number, look?: V3): Rig {
  const r = rightAt(Math.max(0, t));
  const right: HandRig = { grip: r.frame, hold: 'fist', radius: RC, open: 0.25 * (1 - r.snug), wrap: 0.3, free: 1 };
  return { ...STANCE, look: look ?? LOOK_ARM, hands: [LEFT, right] };
}

// ------------------------------------------------------------------------------------- the shot

/** the floor: the cable to the floor lies this way from below her right hand (forward and to her right) */
const FLOOR_DIR: V3 = norm([0.45, 0, -0.9]);

/** dense points along a polyline at spacing h */
function densify(P: V3[], h: number): V3[] {
  const out: V3[] = [P[0]];
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i], d = len(sub(b, a)), m = Math.max(1, Math.round(d / h));
    for (let j = 1; j <= m; j++) out.push(mix(a, b, j / m));
  }
  return out;
}
const polyLen = (P: V3[]) => P.reduce((acc, p, i) => (i ? acc + len(sub(p, P[i - 1])) : 0), 0);

/** the cable's length with its plugs [m] (KONZEPT: the 5 m XLR) */
export const CABLE_LENGTH = 5.0;

export const elbowWrap: ShotDef = {
  id: 'p5-elbow-wrap',
  duration: ELBOW_T.duration,
  fps: 60,
  substeps: XLR.substeps,
  iterations: XLR.iterations,
  build() {
    const G = ELBOW_GEOM, T = ELBOW_T;
    const plugL = XLR.plug?.length ?? 0.06;
    // the start: the male plug in the fist (along the fingers), the cable out on top to the web,
    // the taut strand to the right fist, from there down to the floor and along it to the female plug
    const tip = add(G.C, mul(G.fd, -plugL / 2 - 0.004));
    const top = add(G.C, mul(G.fd, plugL / 2 + 0.004));
    const web = G.raw(0);
    const r0 = rightAt(0);
    const hp = r0.frame.p;
    const d3 = norm(sub(hp, web));
    const pts: V3[] = [tip, top, web, hp];
    const past = add(hp, mul(d3, 0.03));
    pts.push(past);
    const R = 0.09;
    const yb = RC + R;
    const below: V3 = [past[0] + 0.02, yb, past[2] - 0.03];
    pts.push(...densify([past, below], 0.01).slice(1));
    const last = pts[pts.length - 1];
    for (let i = 1; i <= 24; i++) {
      const th = (i / 24) * (Math.PI / 2);
      pts.push([last[0] + FLOOR_DIR[0] * R * (1 - Math.cos(th)), yb - R * Math.sin(th), last[2] + FLOOR_DIR[2] * R * (1 - Math.cos(th))]);
    }
    const used = polyLen(densify(pts, 0.004));
    const rest = CABLE_LENGTH - used;
    const f0 = pts[pts.length - 1];
    const side = norm([-FLOOR_DIR[2], 0, FLOOR_DIR[0]]);
    for (let x = 0.01; x <= rest; x += 0.01) {
      const u = x / rest;
      const off = 0.35 * Math.sin(Math.PI * u) * u;
      pts.push([f0[0] + FLOOR_DIR[0] * x + side[0] * off, RC, f0[2] + FLOOR_DIR[2] * x + side[2] * off]);
    }
    const built = buildCable(XLR, densify(pts, 0.003), { plugs: 'both' });
    const rod = built.rod;
    // a cable that lay straight before: no memory of the made-up start shape
    rod.restFric?.fill(0);
    rod.setRestStraight();
    rod.setCapsules(G.caps);

    const S = rod.sNode;
    // material at the web: the arc length of the start polyline up to it
    const sWeb = polyLen(densify([tip, top, web], 0.002));
    const iPlugEnd = built.cable[1];
    const seg = (r: Rod, s: number) => r.segmentAt(Math.max(0, Math.min(r.totalLength, s)));
    const nodeAt = (s: number) => {
      let i = 0;
      while (i < rod.n - 1 && S[i + 1] <= s) i++;
      return i;
    };
    const total = T.WRAPS * G.LW;

    // the fist holds the plug; the wraps, once laid, are held by the arm (tension and friction:
    // a bundle in the arm's frame, which does not move)
    const fist = rod.bundle({ frame: G.fist, hand: 0, blend: 0.05 });
    const armHold = rod.bundle({ frame: { p: [0, 0, 0], q: [0, 0, 0, 1] }, hand: 0, blend: 0.12 });

    // guides, one per node from the web on (pseudo-simulation, positions only):
    //  - laid round the arm: onto the wrap path, fading in over 0.2 s from when the hand has
    //    carried the cable past it (then held by the arm, see armHold)
    //  - in the hand: the 2-3 nodes at the material the fist holds sit on the hand's line (the cable
    //    slides through the fist as handMaterialAt says); everything else is free: the cable
    //    between arm and hand sags and swings, the cable to the floor hangs and lies
    const i0 = nodeAt(sWeb) + 1;
    const iMax = nodeAt(sWeb + handMaterialAt(T.duration) + 0.05);
    const laidTarget = new Map<number, V3>();
    const layTime = new Map<number, number>();
    for (let i = i0; i <= iMax; i++) {
      const sig = S[i] - sWeb;
      laidTarget.set(i, G.target(Math.min(total, sig)));
      // first time at which the laid length passes this node (+ 1.5 cm)
      let tl = Infinity;
      if (sig + 0.015 <= total) {
        for (let f = 0; f < KIN.sc.length; f++) if (KIN.sc[f] >= sig + 0.015) { tl = f / KIN.HZ; break; }
      }
      layTime.set(i, tl);
    }
    let cur = rightAt(-1);
    let curT = -1;
    const state = (t: number) => {
      if (t !== curT) {
        cur = rightAt(t);
        curT = t;
      }
      return cur;
    };
    const HAND_HALF = 0.011;
    for (let i = i0; i <= iMax; i++) {
      const sig = S[i] - sWeb;
      const tl = layTime.get(i) ?? Infinity;
      rod.addGuide({
        nodes: [i, i],
        target: (_i, t) => {
          if (t >= tl) return laidTarget.get(i) ?? null;
          const st = state(t);
          return add(st.frame.p, mul(norm(sub(st.frame.p, st.contact)), sig - handMaterialAt(t)));
        },
        compliance: 2e-4,
        weight: (t) => {
          if (t >= tl) return sstep((t - tl) / 0.2);
          return Math.max(0, 1 - Math.abs(sig - handMaterialAt(t)) / HAND_HALF);
        },
      });
    }

    // settle: the fist holds the plug, the hand the cable
    const pre = 1.2;
    rod.time = -pre;
    fist.add(0, sWeb + 0.004, 0.05);
    for (let f = 0; f < Math.round(pre * 60); f++) rod.step(1 / 60, XLR.substeps);
    rod.time = 0;

    let held = sWeb;
    let printed = false;
    /** smallest bend radius over a window of 5 nodes [m] */
    const rMin = (r: Rod, a: number, b: number) => {
      let best = Infinity;
      for (let i = a + 2; i <= b - 2; i++) {
        const p0: V3 = [r.x[3 * i - 6], r.x[3 * i - 5], r.x[3 * i - 4]];
        const p1: V3 = [r.x[3 * i], r.x[3 * i + 1], r.x[3 * i + 2]];
        const p2: V3 = [r.x[3 * i + 6], r.x[3 * i + 7], r.x[3 * i + 8]];
        const A = len(sub(p1, p0)), Bl = len(sub(p2, p1)), C2 = len(sub(p2, p0));
        const area2 = len(cross(sub(p1, p0), sub(p2, p0)));
        if (area2 < 1e-12) continue;
        const R2 = (A * Bl * C2) / (2 * area2);
        if (R2 < best) best = R2;
      }
      return best;
    };
    return {
      rod,
      vectors: { hand: frameTrack((_r, t) => rightAt(t).frame) },
      tracks: {
        cable0: () => built.cable[0],
        cable1: () => built.cable[1],
        sWeb: () => sWeb,
        LW: () => G.LW,
        laid: (_r, t) => laidAt(t),
        wraps: (_r, t) => rightAt(t).wraps,
        /** the material in the right hand */
        sHand: (_r, t) => sWeb + handMaterialAt(t),
        snug: (_r, t) => rightAt(t).snug,
        /** twist of the whole cable past the fist (wraps and the cable to the floor) [turns] */
        twAll: (r) => r.twistTurns(seg(r, sWeb), iPlugEnd - 1),
        /** twist in the part laid round the arm [turns] */
        twLaid: (r, t) => r.twistTurns(seg(r, sWeb), seg(r, sWeb + laidAt(t))),
        /** twist from the arm to the plug [turns] */
        twFree: (r, t) => r.twistTurns(seg(r, sWeb + laidAt(t)), iPlugEnd - 1),
        /** twist in the hanging cable: from the hand 1 m on [turns] */
        twHang: (r, t) => {
          const sh = sWeb + handMaterialAt(t);
          return r.twistTurns(seg(r, sh), seg(r, sh + 1.0));
        },
        /** writhe of the part laid round the arm */
        wrLaid: (r, t) => {
          const l = laidAt(t);
          return l > 0.05 ? r.writhe(nodeAt(sWeb), nodeAt(sWeb + l)) : 0;
        },
        /** smallest bend radius in the wraps [m] */
        rMin: (r, t) => {
          const l = laidAt(t);
          return l > 0.1 ? rMin(r, nodeAt(sWeb), nodeAt(sWeb + l)) : 1;
        },
        plugY: (r) => r.x[3 * (r.n - 1) + 1],
        /** cable on the floor [m] */
        onFloor: (r) => {
          let n = 0;
          for (let i = 0; i < r.n; i++) if (r.x[3 * i + 1] < RC + 0.004) n++;
          return n * XLR.segment;
        },
      },
      script: (r, t) => {
        // what has lain round the arm for 0.35 s is held there (rigid: tension and friction)
        const l = laidAt(t - 0.35);
        if (l - (held - sWeb) > 0.03) {
          armHold.add(held, sWeb + l);
          held = sWeb + l;
        }
        if (!printed && t >= ELBOW_T.duration - 1.5 / 60) {
          printed = true;
          const lt = laidAt(t);
          const twAll = r.twistTurns(seg(r, sWeb), iPlugEnd - 1);
          const twLaid = r.twistTurns(seg(r, sWeb), seg(r, sWeb + lt));
          const wr = r.writhe(nodeAt(sWeb), nodeAt(sWeb + lt));
          console.log(`\n[p5-elbow-wrap] LW ${G.LW.toFixed(3)} m, laid ${lt.toFixed(2)} m; twist all ${twAll.toFixed(2)}, laid ${twLaid.toFixed(2)}, writhe laid ${wr.toFixed(2)}; plug y ${r.x[3 * (r.n - 1) + 1].toFixed(3)}; stats ${JSON.stringify(r.stats)}; warnings ${r.warnings.slice(0, 3).join(' | ')}`);
        }
      },
    };
  },
};

export const P5_ELBOW_SHOTS: ShotDef[] = [elbowWrap];
