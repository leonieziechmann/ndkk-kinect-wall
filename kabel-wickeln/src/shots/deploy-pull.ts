// Stage 1, item 3: a short cable laid out again, done right. Ilse sits in her wheelchair at the
// FOH desk with a short over-under ring of a black charging cable (4 mm, 6 loops of Ø 9 cm,
// 2 m) in her left hand. Her right hand opens the velcro tie and lays it on the desk, takes
// the end that hangs out of the ring and draws it out to the side; her left hand lets the ring
// go and holds the other end, which sticks out of the top. Both ends are outside the ring. She
// pulls her hands apart: the loops open one after the other, the cable sinks onto the desk in a
// calm bend, its stripe calm: the +1 and -1 turns of the über and unter loops cancel.
//
// Everything the hands do is a pure function of the shot time and of a few points of the ring
// (where it hangs, where its ends and its tie are), which the bake records as constant tracks, so
// the scene can pose the hands exactly where the simulated cable is (pullChoreo). Until the right
// hand takes its end, the ring hangs rigid in the left fist (keepShape); from then on the cable is
// simulated, with the desk as its floor and the forearms and the body as capsules. The ring is let
// go gently (guides that fade out, as a hand opens), not dropped.
//
// Coordinates: Ilse sits at the origin facing +z (her left is +x); the desk's top at DESK.height.

import { Quat, Rod, V3, add, lerp3, quatFromAxisAngle, quatMul, quatSlerp, smooth, sub } from '../sim';
import { ILSE } from '../people/cast';
import type { Capsule } from '../people/people';
import { Grip, HandRig, Rig, gripFrame, rigPose, seated } from '../people/rig';
import { capsulesOf } from '../people/body3d';
import type { ShotDef } from './types';
import { Coil, FACTORY_FIST, placeState } from './wind';
import { RingSpec, ringCoil, tieMotion } from './deploy-ring';

/** the FOH desk in front of Ilse: centre (x, z), size and the height of its top */
export const DESK = { x: 0, z: 0.62, width: 1.4, depth: 0.7, height: 0.74 };
/** where Ilse sits (pelvis over the floor) and her facing (+z) */
export const SEAT: [number, number] = [0, 0];
export const YAW = Math.PI;

/** the charging cable: 4 mm, light and soft, with some memory of being coiled */
export const SHORT = { radius: 0.002, seg: 0.01, loop: 0.29, pattern: 'uououo', lead: 0.1, tail: 0.18 };
const CABLE = { radius: SHORT.radius, collisionRadius: SHORT.radius, linearDensity: 0.02, EI: 2e-4, GJ: 1.5e-4, friction: 0.6, selfFriction: 0.6, capsuleFriction: 0.4, damping: 0.8, angularDamping: 2, iterations: 3 };

/** the ring: laid out over-under (starting with unter, so the end tail hangs in front), pressed */
export const SHORT_RING: RingSpec = { cable: CABLE, seg: SHORT.seg, loop: SHORT.loop, pattern: SHORT.pattern, lead: SHORT.lead, tail: SHORT.tail, spacing: 0.009, press: 0.8, memory: 0.3 };

/** the velcro tie: length, width; it wraps the ring's bundle on her right side */
export const TIE = { length: 0.12, width: 0.01, thickness: 0.0016 };

/** where the left fist holds the ring at the start (the top of the ring's bundle) */
const HOLD: V3 = [0.06, 1.06, 0.38];

/** shot times (s) */
export const PULL_T = {
  /** right hand to the tie, pinches its end */
  reach: 0.35, pinch: 0.9,
  /** the tie's end out of the eyelet, the tie unwound off the ring, carried to the desk, let go */
  unfold: 1.25, unwrap: 1.95, laid: 2.6, letTie: 2.75,
  /** right hand to the end hanging out of the ring, takes it, draws it out to the side */
  gripB: 3.45, outB: 4.05,
  /** left hand lets the ring go (it hangs between the hands), slides to the other end and holds it */
  hang: 3.9, holdA: 4.4,
  /** hands apart and up: the loops open; then a little down, the middle rests on the desk */
  pull0: 4.45, pull1: 7.3, lay1: 8.5,
  end: 9.6,
};

/** the points of the ring the choreography needs (recorded in the bake as constant tracks) */
export interface PullGeo {
  /** middle of the bundle in the left fist */
  top: V3;
  /** on the start end, where the left hand takes it (5.5 cm from its tip) */
  endA: V3;
  /** on the end hanging out of the ring, where the right hand takes it (6.5 cm from its tip) */
  endB: V3;
  /** centre of the bundle where the tie sits, and its radius */
  tie: V3;
  tieR: number;
}
const GEO_KEYS = ['topX', 'topY', 'topZ', 'aX', 'aY', 'aZ', 'bX', 'bY', 'bZ', 'tieX', 'tieY', 'tieZ', 'tieR'] as const;
const geoValues = (g: PullGeo) => [...g.top, ...g.endA, ...g.endB, ...g.tie, g.tieR];

/** the geometry back from a bake's tracks (the scene) */
export function geoFromTracks(track: (name: string) => number): PullGeo {
  const v = GEO_KEYS.map((k) => track(k));
  return { top: [v[0], v[1], v[2]], endA: [v[3], v[4], v[5]], endB: [v[6], v[7], v[8]], tie: [v[9], v[10], v[11]], tieR: v[12] };
}

/** nodes held by the hands: the start end (tip 0) and the end tail (counted from the last node) */
const A_NODES: [number, number] = [3, 8];
const B_BACK: [number, number] = [9, 4];

// ---------------------------------------------------------------- the ring

let ring: { coil: Coil; state: ReturnType<typeof placeState>; geo: PullGeo } | null = null;

/** the ring, laid out and pressed (deploy-ring.ts), hanging with its bundle top at HOLD */
function shortRing() {
  if (ring) return ring;
  const coil = ringCoil(SHORT_RING);
  const tmp = Rod.fromState(coil.state);
  const x = tmp.x, n = tmp.n;
  const at = (i: number): V3 => [x[3 * i], x[3 * i + 1], x[3 * i + 2]];
  // the bundle's top: the loop nodes within 2.5 cm below the fist
  let c: V3 = [0, 0, 0], m = 0;
  for (let i = coil.loops[0][0]; i <= coil.loops[coil.loops.length - 1][1]; i++) {
    if (x[3 * i + 1] > FACTORY_FIST[1] - 0.025) {
      c = add(c, at(i));
      m++;
    }
  }
  const top: V3 = [c[0] / m, c[1] / m, c[2] / m];
  const d = sub(HOLD, top);
  const state = placeState(coil.state, d);
  const rod = Rod.fromState(state);
  const X = rod.x;
  const P = (i: number): V3 => [X[3 * i], X[3 * i + 1], X[3 * i + 2]];
  const mid = (a: number, b: number): V3 => lerp3(P(a), P(b), 0.5);
  // the tie sits round the bundle on the ring's -x side (her right), half way down
  const cy = HOLD[1] - coil.R, cx = HOLD[0] - coil.R;
  let s: V3 = [0, 0, 0], k = 0;
  for (let i = coil.loops[0][0]; i <= coil.loops[coil.loops.length - 1][1]; i++) {
    if (Math.abs(X[3 * i + 1] - cy) < 0.012 && X[3 * i] < cx + 0.03) {
      s = add(s, P(i));
      k++;
    }
  }
  const tie: V3 = [s[0] / k, s[1] / k, s[2] / k];
  let tieR = 0;
  for (let i = coil.loops[0][0]; i <= coil.loops[coil.loops.length - 1][1]; i++) {
    if (Math.abs(X[3 * i + 1] - cy) < 0.012 && X[3 * i] < cx + 0.03) tieR = Math.max(tieR, Math.hypot(X[3 * i] - tie[0], X[3 * i + 2] - tie[2]));
  }
  const geo: PullGeo = { top: HOLD, endA: mid(A_NODES[0], A_NODES[1]), endB: mid(n - 1 - B_BACK[0], n - 1 - B_BACK[1]), tie, tieR: tieR + CABLE.radius };
  ring = { coil, state, geo };
  return ring;
}

// ---------------------------------------------------------------- choreography

const ease = (t: number, a: number, b: number) => smooth((t - a) / (b - a));
/** where the hands end: apart and up, then down so the cable lies on the desk */
const PULL_L: V3 = [0.47, 1.15, 0.38], PULL_R: V3 = [-0.47, 1.15, 0.38];
const LAY_L: V3 = [0.46, 1.1, 0.4], LAY_R: V3 = [-0.46, 1.1, 0.4];
/** the right hand at rest: on the desk's front edge, open */
const REST_R = gripFrame([-0.2, DESK.height + 0.03, 0.31], [-0.3, 0, 1], [0, 1, 0]);

/** a grip frame's rotation, turned by q (world) */
const turned = (g: Grip, q: Quat): Quat => quatMul(q, g.q);

/**
 * The choreography for a ring geometry: the tie, both hands (rig), and the grip frames the
 * simulation uses for the two ends (the same frames, so the fists close round the cable).
 */
export function pullChoreo(geo: PullGeo) {
  const T = PULL_T;
  // ---- the tie round the bundle (axis down, eyelet facing her right and a little towards her);
  // once off the ring it is laid flat on the desk, to her right in front of the mixer
  const axis: V3 = [0, -1, 0];
  const start = norm3([-1, 0, -0.45]);
  const v = cross3(axis, start);
  const tie = tieMotion({
    center: geo.tie, axis, start, radius: geo.tieR, ...TIE, times: [T.pinch, T.unfold, T.unwrap, T.laid],
    away: { p: [-0.24, DESK.height + TIE.thickness / 2, 0.47], q: quatMul(quatFromAxisAngle(0, 1, 0, 0.5), quatFromAxisAngle(v[0], v[1], v[2], Math.PI / 2)) },
  });

  // ---- the ends: grip frames (d3 along the cable towards its tip end, d1 to the palm)
  const holdRing = gripFrame(geo.top, [-1, 0, 0], [0, 0.55, -0.83]);
  const takeA = gripFrame(geo.endA, [-1, 0, 0], [0, 1, 0]);
  const takeB = gripFrame(geo.endB, [0, -1, 0], [-1, 0, 0]);
  /** the right hand turns the end out to her right: -90° about z (cable along -x, palm on top) */
  const turnB = quatFromAxisAngle(0, 0, 1, -Math.PI / 2);
  const outB: V3 = add(geo.endB, [-0.08, 0.04, 0]);

  /** the left fist: the ring, then the start end, apart, down */
  const left = (t: number): Grip => {
    if (t < T.hang) return holdRing;
    if (t < T.holdA) {
      const w = ease(t, T.hang, T.holdA);
      return { p: lerp3(holdRing.p, takeA.p, w), q: quatSlerp(holdRing.q, takeA.q, w) };
    }
    const w = ease(t, T.pull0, T.pull1), l = ease(t, T.pull1, T.lay1);
    return { p: lerp3(lerp3(takeA.p, PULL_L, w), LAY_L, l), q: takeA.q };
  };
  /** the right fist on its end (from gripB on) */
  const right = (t: number): Grip => {
    const o = ease(t, T.gripB, T.outB);
    const q = quatSlerp(takeB.q, turned(takeB, turnB), o);
    const w = ease(t, T.pull0, T.pull1), l = ease(t, T.pull1, T.lay1);
    return { p: lerp3(lerp3(lerp3(takeB.p, outB, o), PULL_R, w), LAY_R, l), q };
  };

  /** Ilse's hands for the rig */
  const leftHand = (t: number): HandRig => {
    const g = left(t);
    const radius = t < T.hang ? 0.012 : t < T.holdA ? 0.012 + (0.003 - 0.012) * ease(t, T.hang, T.holdA) : 0.003;
    // the hand opens while it lets the ring go and slides to the end
    const open = t > T.hang - 0.15 && t < T.holdA ? Math.sin(Math.PI * ease(t, T.hang - 0.15, T.holdA)) * 0.8 : 0;
    return { grip: g, radius, open, thumbAlong: 1 };
  };
  const rightHand = (t: number): HandRig => {
    if (t >= T.gripB) return { grip: right(t), radius: 0.003, thumbAlong: -1 };
    // on the tie's end (pinched), or between rest, tie and cable
    const tieGrip = (tt: number): Grip => {
      const s = tie(tt);
      // pinch 1 cm from the band's end, palm up and back
      return gripFrame(add(s.tip, scale3(s.dir, -0.01)), s.dir, [0, 0.4, -1]);
    };
    if (t < T.reach) return { grip: REST_R, radius: 0.004, open: 1, thumbAlong: -1 };
    if (t < T.pinch) {
      const w = ease(t, T.reach, T.pinch), g = tieGrip(T.pinch);
      return { grip: { p: lerp3(REST_R.p, g.p, w), q: quatSlerp(REST_R.q, g.q, w) }, radius: 0.003, open: 1 - 0.8 * w, pinch: w, thumbAlong: -1 };
    }
    if (t < T.letTie) return { grip: tieGrip(t), radius: 0.002, open: t > T.laid ? 0.2 + 0.8 * ease(t, T.laid, T.letTie) : 0.2, pinch: 1, thumbAlong: -1 };
    const w = ease(t, T.letTie, T.gripB), g0 = tieGrip(T.letTie);
    return { grip: { p: add(lerp3(g0.p, takeB.p, w), [0, 0.05 * Math.sin(Math.PI * w), 0]), q: quatSlerp(g0.q, takeB.q, w) }, radius: 0.003, open: 1 - ease(t, T.gripB - 0.25, T.gripB), pinch: 1 - w, thumbAlong: -1 };
  };

  /** Ilse's rig; `pov` keeps the same hands (seated, the hands are already in front of the eyes) */
  const rig = (t: number): Rig => {
    const look = lerp3(lerp3(left(t).p, right(t).p, 0.5), [0, 0.9, 0.42], 0.4);
    const early = t < T.gripB ? lerp3(geo.top, [-0.12, 0.92, 0.38], 0.5) : look;
    return { ...seated(ILSE, SEAT, YAW, 0.5), look: lerp3(early, look, ease(t, T.letTie, T.gripB)), hands: [leftHand(t), rightHand(t)] };
  };

  return { tie, left, right, leftHand, rightHand, rig, tieAxis: axis, tieStart: start };
}

const scale3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

// ---------------------------------------------------------------- the shot

/** Ilse's forearms and body as capsules (the hands hold the cable and are left out) */
function bodyCapsules(choreo: ReturnType<typeof pullChoreo>) {
  const cache = new Map<number, Capsule[]>();
  return (t: number): Capsule[] => {
    const f = Math.round(t * 60);
    let c = cache.get(f);
    if (!c) {
      c = capsulesOf(rigPose(ILSE, choreo.rig(f / 60))).filter((x) => x.part === 'armL' || x.part === 'armR' || x.part === 'torso');
      cache.set(f, c);
    }
    return c;
  };
}

export const deployPull: ShotDef = {
  id: 'deploy-pull',
  duration: PULL_T.end,
  substeps: 60,
  iterations: 4,
  build() {
    const { coil, state, geo } = shortRing();
    const rod = Rod.fromState({ ...state, opts: { ...state.opts, groundY: DESK.height } });
    const n = rod.n;
    const T = PULL_T;
    const ch = pullChoreo(geo);
    const lastLoop = coil.loops[coil.loops.length - 1][1];
    const b: [number, number] = [n - 1 - B_BACK[0], n - 1 - B_BACK[1]];
    rod.setCapsules(bodyCapsules(ch));
    // the whole ring rigid in the left fist until the right hand takes the end tail
    let gRing = rod.addGrip({ nodes: [0, n - 1], keepShape: true, frame: ch.left });
    let stage = 0;
    return {
      rod,
      script: (r, t) => {
        if (stage === 0 && t >= T.gripB) {
          // the right fist takes the end tail; the ring stays in the left fist, the tail is free
          r.releaseGrip(gRing);
          gRing = r.addGrip({ nodes: [0, lastLoop - 1], keepShape: true, frame: ch.left });
          r.addGrip({ nodes: b, keepShape: true, frame: ch.right });
          stage = 1;
        }
        if (stage === 1 && t >= T.hang) {
          // the left hand opens: the start end stays where it is (the hand slides along it), the
          // ring is held by guides that fade out, so it sinks and hangs between the hands
          r.releaseGrip(gRing);
          const still = ch.left(T.hang);
          gRing = r.addGrip({ nodes: A_NODES, keepShape: true, frame: () => still });
          const x0 = r.x.slice(), t0 = t;
          r.addGuide({ nodes: [A_NODES[1] + 1, lastLoop], compliance: 1e-4, weight: (tt) => 1 - smooth((tt - t0) / 0.7), target: (i) => [x0[3 * i], x0[3 * i + 1], x0[3 * i + 2]] });
          stage = 2;
        }
        if (stage === 2 && t >= T.holdA) {
          // the left fist closes on the start end and moves with the hand from now on
          r.releaseGrip(gRing);
          gRing = r.addGrip({ nodes: A_NODES, keepShape: true, frame: ch.left });
          stage = 3;
        }
      },
      tracks: {
        ...Object.fromEntries(GEO_KEYS.map((k, i) => [k, () => geoValues(geo)[i]])),
        twist: (r) => r.twistTurns(),
        writhe: (r) => r.writhe(),
        /** height of the lowest node above the desk (the cable lies on it once ~radius) */
        low: (r) => {
          let m = Infinity;
          for (let i = 0; i < r.n; i++) m = Math.min(m, r.x[3 * i + 1]);
          return m - DESK.height;
        },
      },
    };
  },
};
