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

import { Capsule, Frame, Pinch, Rod, V3, XLR, buildCable, frameTrack, gripFrame } from '../sim';
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
 * cable once round hand and elbow (LAY), pulls it snug (TUG, the hand closes), and goes back to its
 * start beside the left fist (BACK, the cable sliding through the loose hand). Natural pace
 * ("Arbeitstempo", mocap p5.elbow.wrong: four wraps in about 8 s).
 */
export const ELBOW_T = (() => {
  const T0 = 0.8, LAY = 1.3, TUG = 0.25, BACK = 0.4;
  const PERIOD = LAY + TUG + BACK;
  const WRAPS = 4;
  const end = T0 + WRAPS * PERIOD;
  return {
    T0, LAY, TUG, BACK, PERIOD, WRAPS,
    /** wrap k: start, laid round (snug pull starts), snug, back at the start */
    wrap: (k: number) => {
      const t0 = T0 + k * PERIOD;
      return { t0, laid: t0 + LAY, snug: t0 + LAY + TUG, back: t0 + PERIOD };
    },
    /** after the last wrap the hand rests beside the fist (the cable to the floor settles) */
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
  const offset = (sig: number) => (sig / LW - ELBOW_T.WRAPS / 2) * SPACING;
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
    /** the web: where every wrap starts and ends (the top of the fist) */
    web: (k: number) => target(k * LW),
  };
})();

// ------------------------------------------------------------------------------------- right hand

/** where the right hand is ahead of the cable's contact with the arm, and how far out of the path */
function handPlace(sig: number): { p: V3; contact: V3 } {
  const G = ELBOW_GEOM;
  const LW = G.LW;
  const local = sig - Math.floor(sig / LW + 1e-9) * LW;
  // towards the end of a wrap the hand comes in to the web
  const near = sstep((local - (LW - 0.24)) / 0.22);
  const lead = 0.1 * (1 - near) + 0.0 * near;
  // round the elbow the hand stays closer (between the elbow and her hip)
  const elbowEnd = Math.exp(-(((local - 0.5 * LW) / (0.16 * LW)) ** 2));
  const out = (0.12 - 0.05 * elbowEnd) * (1 - near) + 0.035 * near;
  const sh = sig + lead;
  const contact = G.target(sig);
  const p = add(G.target(sh), mul(G.outward(sh), out));
  return { p, contact };
}

export type RightMode = 'loose' | 'held';

export interface RightState {
  /** the pads (a loose fist): p on the cable, d3 along it (from the arm to the hand, on to the floor) */
  frame: Frame;
  mode: RightMode;
  /** 0 closed … 1 open (the fist's fingers) */
  open: number;
  /** path length laid round the arm [m] */
  laid: number;
  /** wraps finished (0 … WRAPS) */
  wraps: number;
}

/** the hand's frame from its position and the contact point (its palm towards her) */
function padsFrame(p: V3, contact: V3): Frame {
  const d3 = norm(sub(p, contact));
  return gripFrame(p, d3, across(ELBOW_GEOM.n, d3));
}

/** the right hand at the start of wrap k (beside the left fist, on her right) */
function startPlace(k: number) {
  return handPlace(k * ELBOW_GEOM.LW);
}

/** the right hand and how much is laid, at shot time t */
export function rightAt(t: number): RightState {
  const T = ELBOW_T, G = ELBOW_GEOM;
  if (t < T.T0) {
    const s0 = startPlace(0);
    return { frame: padsFrame(s0.p, s0.contact), mode: 'loose', open: 0.35, laid: 0, wraps: 0 };
  }
  const k = Math.min(T.WRAPS, Math.floor((t - T.T0) / T.PERIOD));
  if (k >= T.WRAPS) {
    const s0 = startPlace(T.WRAPS);
    return { frame: padsFrame(s0.p, s0.contact), mode: 'loose', open: 0.35, laid: T.WRAPS * G.LW, wraps: T.WRAPS };
  }
  const w = T.wrap(k);
  const base = k * G.LW;
  if (t < w.laid) {
    const u = (t - w.t0) / T.LAY;
    const sig = base + G.LW * ease(u);
    const hp = handPlace(sig);
    return { frame: padsFrame(hp.p, hp.contact), mode: 'loose', open: 0.35, laid: sig, wraps: k };
  }
  const end = handPlace(base + G.LW - 1e-6);
  const endFrame = padsFrame(end.p, end.contact);
  const d3 = norm(sub(end.p, end.contact));
  if (t < w.snug) {
    // pull it snug: the fist closes and draws the cable 2 cm on
    const u = sstep((t - w.laid) / T.TUG);
    return { frame: { p: add(end.p, mul(d3, 0.02 * u)), q: endFrame.q }, mode: 'held', open: 0.35 * (1 - u), laid: base + G.LW, wraps: k + 1 };
  }
  // back to the start beside the fist, over the top, the cable sliding through
  const u = ease((t - w.snug) / T.BACK);
  const from = add(end.p, mul(d3, 0.02));
  const nx = startPlace(k + 1);
  const p = add(mix(from, nx.p, u), mul(G.n, 0.03 * Math.sin(Math.PI * u)));
  const web = G.web(k + 1);
  return { frame: padsFrame(p, web), mode: 'loose', open: 0.35 * u, laid: base + G.LW, wraps: k + 1 };
}

/**
 * Noor's rig at shot time t (scene: also her idle at scene time s, head only: her arms and body
 * stay still while the cable lies on the arm). The part builds a RigTrack from it (t0 = −2 s, as
 * leftPose), so the left arm is the same settled arm the simulation used.
 */
export function elbowRig(t: number, look?: V3): Rig {
  const r = rightAt(Math.max(0, t));
  const right: HandRig = { grip: r.frame, hold: 'fist', radius: RC, open: r.open, wrap: 0.3, free: 1 };
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
    // a strand to the right hand, down to the floor, along the floor to the female plug
    const tip = add(G.C, mul(G.fd, -plugL / 2 - 0.004));
    const top = add(G.C, mul(G.fd, plugL / 2 + 0.004));
    const web = G.web(0);
    const s0 = rightAt(0);
    const hp = s0.frame.p;
    const d3 = norm(sub(hp, web));
    const pts: V3[] = [tip, top, web];
    const past = add(hp, mul(d3, 0.04));
    pts.push(hp, past);
    // down to the floor in a bend, then along the floor
    const R = 0.09;
    const yb = RC + R;
    const below: V3 = [past[0] + 0.02, yb, past[2] - 0.03];
    pts.push(...densify([past, below], 0.01).slice(1));
    const last = pts[pts.length - 1];
    const bend: V3[] = [];
    for (let i = 1; i <= 24; i++) {
      const th = (i / 24) * (Math.PI / 2);
      bend.push([last[0] + FLOOR_DIR[0] * R * (1 - Math.cos(th)), yb - R * Math.sin(th), last[2] + FLOOR_DIR[2] * R * (1 - Math.cos(th))]);
    }
    pts.push(...bend);
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
    const sWeb = (() => {
      // material at the web: the arc length to the polyline's third point
      let best = 0, bd = Infinity;
      for (let i = 0; i < rod.n; i++) {
        const p: V3 = [rod.x[3 * i], rod.x[3 * i + 1], rod.x[3 * i + 2]];
        const d = len(sub(p, web));
        if (d < bd && S[i] < 0.2) { bd = d; best = S[i]; }
      }
      return best;
    })();
    const iPlugEnd = built.cable[1];
    const seg = (r: Rod, s: number) => r.segmentAt(Math.max(0, Math.min(r.totalLength, s)));
    const nodeAt = (s: number) => {
      let i = 0;
      while (i < rod.n - 1 && S[i + 1] <= s) i++;
      return i;
    };

    // settle: the fist holds the plug, the right hand the cable
    const pre = 1.2;
    rod.time = -pre;
    const fist = rod.bundle({ frame: G.fist, hand: 0, blend: 0.05 });
    fist.add(0, sWeb - 0.012, 0.05);
    const pin: Pinch = rod.pinch({ frame: (t) => rightAt(t).frame, mode: 'held', hand: 1, rolls: false, friction: 1.0, blend: 0.1, lostDistance: 0.03, lostAngle: 1.45 });
    for (let f = 0; f < Math.round(pre * 60); f++) rod.step(1 / 60, XLR.substeps);
    rod.time = 0;

    // guides: the cable laid round the arm stays there (chunks of 6 nodes, each switched on as the
    // hand has carried the cable past it, over 0.15 s)
    const total = T.WRAPS * G.LW;
    /** shot time at which path length sig is laid (the contact passed it) */
    const laidAt = (sig: number) => {
      const k = Math.min(T.WRAPS - 1, Math.floor(sig / G.LW));
      const w = T.wrap(k);
      const want = (sig - k * G.LW) / G.LW;
      let lo = 0, hi = 1;
      for (let it = 0; it < 30; it++) {
        const m = (lo + hi) / 2;
        if (ease(m) < want) lo = m;
        else hi = m;
      }
      return w.t0 + hi * T.LAY;
    };
    const i0 = nodeAt(sWeb) + 1;
    const i1 = nodeAt(sWeb + total);
    const CH = 6, LAG = 0.06;
    const tgt = new Map<number, V3>();
    for (let i = i0; i <= i1; i++) tgt.set(i, G.target(S[i] - sWeb));
    for (let a = i0; a <= i1; a += CH) {
      const b = Math.min(i1, a + CH - 1);
      const sigEnd = S[b] - sWeb;
      const tOn = laidAt(Math.min(total, sigEnd + LAG));
      rod.addGuide({
        nodes: [a, b],
        target: (i) => tgt.get(i) ?? null,
        compliance: 1e-3,
        weight: (t) => sstep((t - tOn) / 0.15),
      });
    }

    // the right hand's grip changes with the choreography
    let mode: RightMode = 'held';
    let printed = false;
    const lastLaid = (t: number) => Math.min(total, rightAt(t).laid);
    /** smallest bend radius over a window of 5 nodes in the laid part [m] */
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
    let snugMax = 0;
    return {
      rod,
      vectors: { pads: frameTrack((_r, t) => rightAt(t).frame) },
      tracks: {
        cable0: () => built.cable[0],
        cable1: () => built.cable[1],
        sWeb: () => sWeb,
        LW: () => G.LW,
        laid: (_r, t) => lastLaid(t),
        wraps: (_r, t) => rightAt(t).wraps,
        sPin: () => pin.s,
        level: (_r, t) => pin.level(t),
        force: () => pin.force,
        /** twist of the whole cable past the fist (wraps and the cable to the floor) [turns] */
        twAll: (r) => r.twistTurns(seg(r, sWeb), iPlugEnd - 1),
        /** twist in the part laid round the arm [turns] */
        twLaid: (r, t) => r.twistTurns(seg(r, sWeb), seg(r, sWeb + lastLaid(t))),
        /** twist from the arm to the plug [turns] */
        twFree: (r, t) => r.twistTurns(seg(r, sWeb + lastLaid(t)), iPlugEnd - 1),
        /** twist in the hanging part: from the right hand 1 m on [turns] */
        twHang: (r) => r.twistTurns(seg(r, pin.s), seg(r, pin.s + 1.0)),
        /** writhe of the part laid round the arm */
        wrLaid: (r, t) => {
          const l = lastLaid(t);
          return l > 0.05 ? r.writhe(nodeAt(sWeb), nodeAt(sWeb + l)) : 0;
        },
        /** smallest bend radius in the wraps [m] */
        rMin: (r, t) => {
          const l = lastLaid(t);
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
        const want = rightAt(t).mode;
        if (want !== mode) {
          pin.set(want, want === 'held' ? 0.06 : 0.08);
          mode = want;
        }
        if (t >= T.T0 && mode === 'held') snugMax = Math.max(snugMax, pin.force);
        if (!printed && t >= ELBOW_T.duration - 1.5 / 60) {
          printed = true;
          const l = lastLaid(t);
          const twAll = r.twistTurns(seg(r, sWeb), iPlugEnd - 1);
          const twLaid = r.twistTurns(seg(r, sWeb), seg(r, sWeb + l));
          const wr = r.writhe(nodeAt(sWeb), nodeAt(sWeb + l));
          console.log(`\n[p5-elbow-wrap] LW ${G.LW.toFixed(3)} m, laid ${l.toFixed(2)} m; twist all ${twAll.toFixed(2)}, laid ${twLaid.toFixed(2)}, writhe laid ${wr.toFixed(2)}; snug force max ${snugMax.toFixed(1)} N; plug y ${r.x[3 * (r.n - 1) + 1].toFixed(3)}; lost ${pin.lost}; stats ${JSON.stringify(r.stats)}; warnings ${r.warnings.slice(0, 3).join(' | ')}`);
        }
      },
    };
  },
};

export const P5_ELBOW_SHOTS: ShotDef[] = [elbowWrap];
