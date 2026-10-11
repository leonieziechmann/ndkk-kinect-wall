// Stage 1, item 4: a long cable laid out by throwing it. Kofi holds a 15 m XLR coiled over-under
// (18 loops of Ø 25 cm) at the top in his left fist. His right hand opens the velcro tie and puts
// it in his back pocket, then takes most of the ring: his left hand keeps the start end and three
// loops loosely in the open palm, about one and a half loops hang between his hands. He swings
// the rest back and throws it underhand towards the mic stand. In flight the loops peel off the
// side of the ring that faces him, one after the other, the loops in his open hand pay out after
// them, and the cable lands in gentle bends without curls (the twists of the über and unter loops
// cancel). The rest of the ring lands, slides a little and falls over. Then he lets the loops left
// in his hand slide off and lowers the end.
//
// The ring is laid out over-under and pressed into a bundle (deploy-ring.ts; pulled apart in the
// air it leaves |Tw| < 0.3). Pseudo-simulation: the thrown part is held by a shape-keeping grip,
// in the fist, then on a ballistic frame that turns a quarter turn forward on the way (in the
// ring's own plane, so it lands on its edge), slides and lets go. Whenever the free cable between
// the hand's loops and the flying ring is nearly taut, nodes are let go: from the loops in the open
// hand (all of it before the release, a third after it) and from the flying ring, in winding order.
// The free cable, the floor and Kofi's body (capsules, hands left out) are simulated. The contact
// radius is the real cable's (Ø 7 mm), so the ring packs like a real one; the scene draws it at
// Ø 7 mm in close views and at Ø 12 mm in the wide one (KONZEPT: 12 mm in the Totale).
//
// Coordinates: Kofi stands at the origin and throws along +x; his right side is +z. The choreography
// needs a few points of the ring; the bake records them as constant tracks (throwGeo).

import { Frame, Quat, Rod, V3, add, lerp3, quatFromAxisAngle, quatRotate, smooth, sub } from '../sim';
import { KOFI } from '../people/cast';
import { J } from '../people/people';
import type { Capsule } from '../people/people';
import { Grip, HandRig, Rig, gripFrame, rigPose, stand } from '../people/rig';
import { capsulesOf } from '../people/body3d';
import type { ShotDef } from './types';
import { Coil, FACTORY_FIST, placeState } from './wind';
import { RingSpec, ringCoil, tieMotion } from './deploy-ring';

const SEG = 0.03, LOOP = 0.785, PATTERN = 'ou'.repeat(9);
/** loops kept in the left hand, free cable between the hands [m] */
const HAND_LOOPS = 3, BRIDGE = 1.2;
/** the real XLR: drawn at this radius in close views (= the contact radius) */
export const THROW_RADIUS = 0.0035;
/** drawn at this radius in the wide view */
export const THROW_WIDE_RADIUS = 0.006;
const CABLE = { radius: THROW_RADIUS, collisionRadius: THROW_RADIUS, linearDensity: 0.05, EI: 2e-3, GJ: 1.5e-3, damping: 0.3, angularDamping: 2, friction: 0.6, selfFriction: 0.3, capsuleFriction: 0.4, iterations: 3 };
/** the ring: 18 loops over-under, 30 cm tails, pressed into a bundle, with some memory of being coiled */
export const LONG_RING: RingSpec = { cable: CABLE, seg: SEG, loop: LOOP, pattern: PATTERN, lead: 0.3, tail: 0.3, spacing: 0.015, press: 0.9, memory: 0.3 };
/** the velcro tie of the long ring */
export const THROW_TIE = { length: 0.26, width: 0.02, thickness: 0.002 };
/** where the mic stand stands (the ring lands just short of it) */
export const MIC_AT: V3 = [7.25, 0, 0.42];

/** Kofi: where he stands, his facing (+x), his stance (left foot forward) */
const AT: [number, number] = [0, 0];
const YAW = Math.PI / 2;
const STANCE = stand(KOFI, AT, YAW, { width: 0.36, stagger: 0.26 });
/** the left fist holds the ring here at the start (top of its bundle) */
const HOLD: V3 = [0.3, 1.08, -0.2];
/** the open left hand with its loops, after the split */
const LEFT: V3 = [0.34, 1.02, -0.3];

/** shot times (the release and the landing follow from the swing) */
const T0 = {
  /** right hand to the tie, pinches it, end out of the eyelet, unwound, in the back pocket */
  reach: 0.3, pinch: 0.7, unfold: 1.0, unwrap: 1.6, pocket: 2.1,
  /** right hand takes most of the ring and draws it out of the left hand */
  split0: 2.35, split1: 3.25,
  /** ready to swing, end of the backswing */
  ready: 3.6, back: 4.35,
};

// ---------------------------------------------------------------- the swing

/** body during the throw: lean forward and down a little (constant through the swing) */
const LEAN = 0.15, DROP = 0.05;
/** the right shoulder in the throwing posture: centre of the swing */
const SHOULDER: V3 = (() => {
  const p = rigPose(KOFI, { ...STANCE, lean: LEAN, drop: DROP, hands: [null, null] }).joints[J.rightShoulder];
  return [p[0], p[1], p[2] + 0.03];
})();
/** shoulder to the middle of the fist, backswing and release angle (0 = hanging), speed at the release */
const ARM = 0.56, BACK = (-50 * Math.PI) / 180, RELEASE = (35 * Math.PI) / 180, SPEED = 7.4, READY = 0.12;
const G = 9.81;
const omega = SPEED / ARM, alpha = (omega * omega) / (2 * (RELEASE - BACK));
const tRelease = T0.back + omega / alpha;
const handOnArc = (th: number): V3 => [SHOULDER[0] + ARM * Math.sin(th), SHOULDER[1] - ARM * Math.cos(th), SHOULDER[2]];
/** the right arm's angle during the throw */
function swingAngle(t: number) {
  if (t < T0.back) return READY + (BACK - READY) * smooth((t - T0.ready) / (T0.back - T0.ready));
  const u = Math.min(t, tRelease) - T0.back;
  return BACK + 0.5 * alpha * u * u;
}

/** points of the ring the choreography needs (recorded in the bake as constant tracks) */
export interface ThrowGeo {
  /** the tops of the loops kept in the left hand, of the thrown part, and the thrown part's centre */
  handTop: V3;
  coilTop: V3;
  coilCentre: V3;
  /** the tie: centre of the bundle where it sits, and its radius */
  tie: V3;
  tieR: number;
}
const GEO_KEYS = ['hX', 'hY', 'hZ', 'cX', 'cY', 'cZ', 'mX', 'mY', 'mZ', 'tieX', 'tieY', 'tieZ', 'tieR'] as const;
const geoValues = (g: ThrowGeo) => [...g.handTop, ...g.coilTop, ...g.coilCentre, ...g.tie, g.tieR];
export function throwGeoFromTracks(track: (name: string) => number): ThrowGeo {
  const v = GEO_KEYS.map((k) => track(k));
  return { handTop: [v[0], v[1], v[2]], coilTop: [v[3], v[4], v[5]], coilCentre: [v[6], v[7], v[8]], tie: [v[9], v[10], v[11]], tieR: v[12] };
}

// ---------------------------------------------------------------- the ring

let ring: { coil: Coil; state: ReturnType<typeof placeState>; geo: ThrowGeo; kh: number; kc: number } | null = null;

/** the long ring, laid out and pressed, hanging with its bundle top in Kofi's left fist */
function longRing() {
  if (ring) return ring;
  const coil = ringCoil(LONG_RING);
  const centroid = (x: Float64Array | Float32Array, from: number, to: number, keep: (i: number) => boolean): V3 => {
    let c: V3 = [0, 0, 0], m = 0;
    for (let i = from; i <= to; i++) {
      if (!keep(i)) continue;
      c = add(c, [x[3 * i], x[3 * i + 1], x[3 * i + 2]]);
      m++;
    }
    return [c[0] / m, c[1] / m, c[2] / m];
  };
  const first = coil.loops[0][0], last = coil.loops[coil.loops.length - 1][1];
  const x0 = Rod.fromState(coil.state).x;
  const top0 = centroid(x0, first, last, (i) => x0[3 * i + 1] > FACTORY_FIST[1] - 0.03);
  const state = placeState(coil.state, sub(HOLD, top0));
  const rod = Rod.fromState(state);
  const x = rod.x, n = rod.n;
  const kh = coil.loops[HAND_LOOPS - 1][1] + 1;
  const kc = kh + Math.round(BRIDGE / SEG);
  const isTop = (i: number) => x[3 * i + 1] > HOLD[1] - 0.03;
  // the tie: round the bundle on the ring's front side (+x), half way down
  const R = coil.R, cy = HOLD[1] - R;
  const atTie = (i: number) => Math.abs(x[3 * i + 1] - cy) < 0.03 && x[3 * i] > HOLD[0] + R - 0.05;
  const tie = centroid(x, first, last, atTie);
  let tieR = 0;
  for (let i = first; i <= last; i++) if (atTie(i)) tieR = Math.max(tieR, Math.hypot(x[3 * i] - tie[0], x[3 * i + 2] - tie[2]));
  const geo: ThrowGeo = {
    handTop: centroid(x, first, kh, isTop),
    coilTop: centroid(x, kc, last, isTop),
    coilCentre: centroid(x, kc, n - 1, () => true),
    tie,
    tieR: tieR + THROW_RADIUS,
  };
  ring = { coil, state, geo, kh, kc };
  return ring;
}

// ---------------------------------------------------------------- choreography

const ease = (t: number, a: number, b: number) => smooth((t - a) / (b - a));
const ID: Quat = [0, 0, 0, 1];

/** the choreography for a ring geometry: the tie, the hands, Kofi's rig, the frames of the simulation */
export function throwChoreo(geo: ThrowGeo) {
  const T = T0;
  // ---- the tie round the bundle at the front of the ring (axis up), eyelet towards his right;
  // once off, into his right back pocket
  const tie = tieMotion({
    center: geo.tie, axis: [0, 1, 0], start: [0.4, 0, 1], radius: geo.tieR, ...THROW_TIE, times: [T.pinch, T.unfold, T.unwrap, T.pocket],
    away: { p: [-0.13, 0.98, 0.17], q: quatFromAxisAngle(0, 0, 1, Math.PI / 2) },
  });

  // ---- the frames the simulation uses (translations only: the held loops keep their pose)
  const offL = (t: number): V3 => scale3(sub(LEFT, geo.handTop), ease(t, T.split0, T.split1));
  /** the left hand's grip on the ring (whole ring, then its loops), as a translation */
  const leftFrame = (t: number): Frame => ({ p: add(HOLD, offL(t)), q: ID });
  /** where the right fist holds the thrown part: drawn out to the side, then the swing */
  const split = (t: number): V3 => {
    const u = ease(t, T.split0, T.split1);
    const out = add(geo.coilTop, [0.12, 0.02, 0.32]);
    const a = lerp3(geo.coilTop, out, u);
    return lerp3(a, handOnArc(READY), ease(t, T.split1, T.ready));
  };
  const rightP = (t: number): V3 => (t < T.ready ? split(t) : t <= tRelease ? handOnArc(swingAngle(t)) : handOnArc(RELEASE + 0.9 * smooth((t - tRelease) / 0.35)));

  // ---- the hands of the rig
  const holdRing = gripFrame(HOLD, [-1, 0, 0], [0, 0.6, -0.8]);
  /** the open left hand: palm up under the loops, which lie across the fingers */
  const palmUp = (p: V3): Grip => gripFrame(add(p, [0, -0.016, 0]), [-1, 0, 0], [0, -1, 0]);
  const fist = (p: V3): Grip => gripFrame(p, [-1, 0, 0], [0, 1, 0]);
  const leftHand = (t: number, letGo: number): HandRig => {
    if (t < T.split0) return { grip: holdRing, radius: 0.02, thumbAlong: -1 };
    const p = add(geo.handTop, offL(t));
    if (t < T.split1) {
      const w = ease(t, T.split0, T.split0 + 0.5);
      const g = palmUp(p);
      return { grip: { p: lerp3(holdRing.p, g.p, w), q: slerpQ(holdRing.q, g.q, w) }, radius: 0.02 - 0.008 * w, open: 0.7 * w, thumbAlong: -1 };
    }
    // at the end the hand opens, the last loops slide off, the hand sinks with the end
    const down = ease(t, letGo, letGo + 0.8);
    const g = palmUp(add(p, [-0.04 * down, -0.2 * down, -0.04 * down]));
    return { grip: g, radius: 0.012, open: 0.7 + 0.3 * down, thumbAlong: -1 };
  };
  const rightHand = (t: number): HandRig => {
    const tieGrip = (tt: number): Grip => {
      const s = tie(tt);
      return gripFrame(add(s.tip, scale3(s.dir, -0.012)), s.dir, [0, 0.3, 1]);
    };
    const rest = gripFrame([0.12, 0.86, 0.3], [1, -0.4, 0], [0, 0, -1]);
    if (t < T.reach) return { grip: rest, radius: 0.004, open: 0.8 };
    if (t < T.pinch) {
      const w = ease(t, T.reach, T.pinch), g = tieGrip(T.pinch);
      return { grip: { p: lerp3(rest.p, g.p, w), q: slerpQ(rest.q, g.q, w) }, radius: 0.003, open: 0.8 - 0.6 * w, pinch: w };
    }
    if (t < T.pocket + 0.1) return { grip: tieGrip(t), radius: 0.002, open: 0.2, pinch: 1 };
    // from the pocket to the ring's top, closing round it
    if (t < T.split0) {
      const w = ease(t, T.pocket + 0.1, T.split0), g0 = tieGrip(T.pocket + 0.1), g = fist(geo.coilTop);
      return { grip: { p: add(lerp3(g0.p, g.p, w), [0, 0.06 * Math.sin(Math.PI * w), 0]), q: slerpQ(g0.q, g.q, w) }, radius: 0.02, open: 1 - w, pinch: 1 - w };
    }
    // holds the thrown part, swings, lets go at the release and follows through
    return { grip: fist(rightP(t)), radius: 0.02, open: ease(t, tRelease - 0.02, tRelease + 0.08) };
  };

  /** the ring's centre at time t while it flies (for cameras); null before the release */
  const flight = (t: number): V3 | null => (t < tRelease ? null : coilFrameAt(geo, t).p);

  /** Kofi's rig */
  const rig = (t: number, letGo: number): Rig => {
    const swing = ease(t, T.split1, T.ready);
    const follow = ease(t, tRelease, tRelease + 0.4) * (1 - ease(t, letGo, letGo + 1.2));
    const look: V3 = t < T.split1 ? lerp3(HOLD, [0.25, 0.95, 0.05], 0.4) : t < tRelease ? [1.6, 0.4, 0.1] : lerp3([2.5, 0.5, 0.2], [5.5, 0.1, 0.3], ease(t, tRelease, tRelease + 1.0));
    return {
      ...STANCE,
      lean: 0.05 + (LEAN - 0.05) * swing + 0.06 * follow,
      drop: DROP * swing,
      look,
      hands: [leftHand(t, letGo), rightHand(t)],
    };
  };

  return { tie, leftFrame, rightP, rig, leftHand, rightHand, flight, tieAxis: [0, 1, 0] as V3, tieStart: [0.4, 0, 1] as V3 };
}

const scale3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
function slerpQ(a: Quat, b: Quat, u: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1;
  d *= s;
  if (d > 0.9995) {
    const q: Quat = [a[0] + (s * b[0] - a[0]) * u, a[1] + (s * b[1] - a[1]) * u, a[2] + (s * b[2] - a[2]) * u, a[3] + (s * b[3] - a[3]) * u];
    const l = Math.hypot(...q);
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  }
  const th = Math.acos(d), sn = Math.sin(th), wa = Math.sin((1 - u) * th) / sn, wb = (s * Math.sin(u * th)) / sn;
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb, a[3] * wa + b[3] * wb];
}

// ---------------------------------------------------------------- the flight

/** the thrown part's frame after the release: ballistic, turning a quarter turn forward in its plane */
function coilFrameAt(geo: ThrowGeo, t: number): Frame {
  const { centre, c0, v, tLand, tumble, drop } = flightOf(geo);
  const tau = Math.min(t, tLand) - tRelease;
  const c: V3 = [c0[0] + v[0] * tau, c0[1] + v[1] * tau - 0.5 * G * tau * tau, c0[2] + v[2] * tau];
  // after landing it slides 15 cm with the speed dying away and settles onto the floor
  if (t > tLand) {
    c[0] += 0.15 * (1 - Math.exp(-(t - tLand) / 0.06));
    c[1] -= drop * smooth((t - tLand) / 0.2);
  }
  const q = quatFromAxisAngle(0, 0, 1, -tumble * tau);
  return { p: sub(c, quatRotate(q, centre)), q };
}

/** the flight: from the ring's centre relative to the fist, the release point and speed */
function flightOf(geo: ThrowGeo) {
  const centre = sub(geo.coilCentre, geo.coilTop);
  const pRel = handOnArc(RELEASE);
  const v: V3 = [SPEED * Math.cos(RELEASE), SPEED * Math.sin(RELEASE), 0];
  const c0 = add(pRel, centre);
  // lands on its edge: the centre one ring radius (plus the bundle) above the floor
  const landY = 0.135;
  const tFly = (v[1] + Math.sqrt(v[1] * v[1] + 2 * G * (c0[1] - landY))) / G;
  return { centre, c0, v, tLand: tRelease + tFly, tumble: Math.PI / 2 / tFly, drop: 0.01 };
}

/** shot times of the release, the landing, the end of the hand's loops and of the shot */
export function throwTimes(geo: ThrowGeo) {
  const tLand = flightOf(geo).tLand;
  return { ...T0, release: tRelease, land: tLand, letGo: tLand + 1.0, end: tLand + 2.4 };
}

// ---------------------------------------------------------------- the shot

/** Kofi's body as capsules (the hands hold the cable and are left out) */
function bodyCapsules(rig: (t: number) => Rig) {
  const cache = new Map<number, Capsule[]>();
  return (t: number): Capsule[] => {
    const f = Math.round(t * 60);
    let c = cache.get(f);
    if (!c) {
      c = capsulesOf(rigPose(KOFI, rig(f / 60))).filter((x) => x.part !== 'handL' && x.part !== 'handR' && x.part !== 'head' && x.part !== 'neck');
      cache.set(f, c);
    }
    return c;
  };
}

export const throwShot: ShotDef = {
  id: 'throw',
  duration: 8.2,
  fps: 120,
  substeps: 30,
  build() {
    const { coil, state, geo, kh: kh0, kc: kc0 } = longRing();
    const rod = Rod.fromState({ ...state, opts: { ...state.opts, groundY: 0 } });
    const x = rod.x, n = rod.n;
    const times = throwTimes(geo);
    const ch = throwChoreo(geo);
    rod.setCapsules(bodyCapsules((t) => ch.rig(t, times.letGo)));
    let kh = kh0, kc = kc0;
    const kEnd = n - 1;
    const minKh = coil.loops[0][0];
    const coilFrame = (t: number): Frame => (t <= tRelease ? { p: ch.rightP(t), q: ID } : coilFrameAt(geo, t));
    // the whole ring rigid in the left fist until the right hand takes the thrown part
    let gl = rod.addGrip({ nodes: [0, n - 1], keepShape: true, frame: ch.leftFrame });
    let gc = -1;
    let stage = 0;
    return {
      rod,
      script: (r, t) => {
        if (stage === 0 && t >= T0.split0) {
          r.releaseGrip(gl);
          gl = r.addGrip({ nodes: [0, kh], keepShape: true, frame: ch.leftFrame });
          gc = r.addGrip({ nodes: [kc, kEnd], keepShape: true, frame: coilFrame });
          stage = 1;
        }
        if (stage === 0) return;
        if (stage === 1 && t >= times.land + 0.3) {
          // landed and slid to rest: let go, it falls over and settles
          r.releaseGrip(gc);
          stage = 2;
        }
        if (stage === 2 && t >= times.letGo) {
          // the open hand lets its last loops slide off; it keeps the end
          r.releaseGrip(gl);
          gl = r.addGrip({ nodes: [0, minKh], keepShape: true, frame: (tt) => ({ p: add(ch.leftFrame(tt).p, [-0.04 * smooth((tt - times.letGo) / 0.8), -0.2 * smooth((tt - times.letGo) / 0.8), -0.04 * smooth((tt - times.letGo) / 0.8)]), q: ID }) });
          stage = 3;
        }
        if (stage !== 1) return;
        // taut free cable: let nodes go from the open hand and from the flying ring
        const free = (kc - kh) * SEG;
        const chord = Math.hypot(x[3 * kc] - x[3 * kh], x[3 * kc + 1] - x[3 * kh + 1], x[3 * kc + 2] - x[3 * kh + 2]);
        let need = Math.ceil((chord / 0.85 - free) / SEG);
        if (need <= 0) return;
        need += 2;
        if (kh > minKh) {
          const fromHand = Math.min(kh - minKh, t < tRelease ? need : Math.ceil(need * 0.3));
          kh -= fromHand;
          need -= fromHand;
          r.releaseGrip(gl);
          gl = r.addGrip({ nodes: [0, kh], keepShape: true, frame: ch.leftFrame });
        }
        if (need > 0 && kc < kEnd - 2) {
          kc = Math.min(kEnd - 2, kc + need);
          r.releaseGrip(gc);
          gc = r.addGrip({ nodes: [kc, kEnd], keepShape: true, frame: coilFrame });
        }
      },
      tracks: {
        ...Object.fromEntries(GEO_KEYS.map((k, i) => [k, () => geoValues(geo)[i]])),
        /** last node held in the left hand and first node still in the flying ring */
        handEnd: () => kh,
        coilStart: () => kc,
        twist: (r) => r.twistTurns(),
      },
    };
  },
};

/** shot time at which the right fist lets go of the ring */
export const THROW_RELEASE = tRelease;
