// The motions of the synthetic Kinect recordings (erzeugen.mjs): known movements of the cast's 3D
// people (src/people), each with a clap for the sync, a still start and end pose, the setup of the
// virtual Kinect (as in mocap/shots.json) and, for the coiling, an illustrative cable (a polyline:
// the ring in the left hand, the loop being formed, down from the right hand to the floor, along it).
//
// Rig world (src/people): metres, y up, the person at the origin facing -z (yaw 0), +x is the
// person's right. sim.ts turns it into the take's WORLD frame (mocap/FORMAT.md).
//
//   coil   Noor (no gloves, sleeves pushed up) faces the sensor at 2 m and coils one over and one
//          under loop (the IK test choreography src/scenes/test/ik-sweep.ts), with a cable
//   throw  Kofi from the side (setup D): an underhand throw with the right arm, no cable
//   tpose  Teo in setup A (cal.A.body): T-pose, hands open and closed, palms up and down, turns
//   extra: coil-a (the coiling from setup A, 30° from the right), tpose-b (the calibration in setup B)

import { V3, add, clamp, cross, len, lerp, madd, mix3, norm, scale, sub, quatCols } from '../../src/people/math';
import type { PersonSpec, Pose } from '../../src/people/people';
import { KOFI, NOOR, TEO } from '../../src/people/cast';
import { HandRig, Rig, rigPose, stand } from '../../src/people/rig';
import { handJoints } from '../../src/people/body/hand';
import { SWEEP_BEATS, SWEEP_PERIOD, sweepRig } from '../../src/scenes/test/ik-sweep';

/** where the virtual Kinect stands, as in mocap/shots.json (setups[].kinect) */
export interface Setup {
  /** the setup it imitates (A, B, T, C, D) */
  id: string;
  /** height of the middle of the Kinect's front above the floor, m */
  height_m: number;
  /** horizontal distance from the sensor to the person's mark, m */
  distance_m: number;
  /** direction of the Kinect as seen from the person on the mark: 0 = straight ahead, +90 = on the right */
  yaw_deg: number;
  /** tilt, negative = down */
  pitch_deg: number;
  /** the bright wall behind the person (as seen from the sensor), m beyond the mark */
  wall_m: number;
  /** what differs from shots.json */
  note: string;
}

export interface Markers {
  /** the palms touch, s from the first frame */
  clap: number;
  /** the action starts (after the still pose) */
  start: number;
  /** the action ends (the end pose begins) */
  end: number;
}

export interface Motion {
  /** file name: output/synthetic/<name>.k2rec */
  name: string;
  /** the shot of mocap/shots.json it stands in for */
  shot: string;
  role: string;
  spec: PersonSpec;
  setup: Setup;
  seconds: number;
  rigAt(t: number): Rig;
  /** the cable as polylines in the rig world (m); none = no cable in the picture */
  cable?(t: number, pose: Pose): V3[][];
  markers: Markers;
  /** times (s) for the preview pictures (pruefen.py) */
  previews: number[];
  about: string;
}

// ---------------------------------------------------------------- helpers

type Ease = (u: number) => number;
const linear: Ease = (u) => u;
const easeIn: Ease = (u) => u * u;
const easeOut: Ease = (u) => 1 - (1 - u) * (1 - u);
const easeInOut: Ease = (u) => (u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u));

/** a free hand: where the wrist is, wrist → knuckles, out of the palm, finger curl, thumb to the index finger */
interface HandKey {
  wrist: V3;
  dir: V3;
  palm: V3;
  curl: number;
  pinch: number;
}

/**
 * A path through keys with smooth speed: a Hermite spline whose tangents come from the neighbours
 * (Catmull-Rom with uneven times); `stop` keys have zero speed (a hold, a turning point). Easing
 * the hands like this keeps them from stopping at every key (what made the hand-keyed motion look
 * robotic). Directions are interpolated the same way and normalized.
 */
function spline(k: { t: number; p: V3; stop?: boolean }[]): (t: number) => V3 {
  const tan: V3[] = k.map((x, i) => {
    if (x.stop || i === 0 || i === k.length - 1) return [0, 0, 0];
    return scale(sub(k[i + 1].p, k[i - 1].p), 1 / (k[i + 1].t - k[i - 1].t));
  });
  return (t: number) => {
    if (t <= k[0].t) return k[0].p;
    for (let i = 1; i < k.length; i++) {
      if (t < k[i].t) {
        const a = k[i - 1];
        const b = k[i];
        const h = b.t - a.t;
        const u = (t - a.t) / h;
        const u2 = u * u;
        const u3 = u2 * u;
        const h00 = 2 * u3 - 3 * u2 + 1;
        const h10 = u3 - 2 * u2 + u;
        const h01 = -2 * u3 + 3 * u2;
        const h11 = u3 - u2;
        return add(add(scale(a.p, h00), scale(tan[i - 1], h10 * h)), add(scale(b.p, h01), scale(tan[i], h11 * h)));
      }
    }
    return k[k.length - 1].p;
  };
}

/** numbers through keys, eased per segment (the ease of the way into each key) */
function track(k: [number, number, Ease?][]): (t: number) => number {
  return (t: number) => {
    if (t <= k[0][0]) return k[0][1];
    for (let i = 1; i < k.length; i++) {
      if (t < k[i][0]) {
        const u = (t - k[i - 1][0]) / (k[i][0] - k[i - 1][0]);
        return lerp(k[i - 1][1], k[i][1], (k[i][2] ?? easeInOut)(u));
      }
    }
    return k[k.length - 1][1];
  };
}

/** a free hand along keys: wrist on a spline, directions and curls eased between keys */
function handTrack(k: { t: number; h: HandKey; stop?: boolean; ease?: Ease }[]): (t: number) => HandRig {
  const wrist = spline(k.map((x) => ({ t: x.t, p: x.h.wrist, stop: x.stop })));
  const dir = spline(k.map((x) => ({ t: x.t, p: norm(x.h.dir), stop: true })));
  const palm = spline(k.map((x) => ({ t: x.t, p: norm(x.h.palm), stop: true })));
  const curl = track(k.map((x) => [x.t, x.h.curl, x.ease] as [number, number, Ease?]));
  const pinch = track(k.map((x) => [x.t, x.h.pinch, x.ease] as [number, number, Ease?]));
  return (t) => ({ wrist: wrist(t), dir: norm(dir(t)), palm: norm(palm(t)), curl: clamp(curl(t)), pinch: clamp(pinch(t)) });
}

/** the hands of a pose as free-hand keys (to hand over from a solved pose without a jump) */
function keyOf(p: Pose, i: 0 | 1, curl = 0.25, pinch = 0): HandKey {
  const h = p.body.hands[i];
  return { wrist: h.wrist, dir: h.fd, palm: h.palm, curl, pinch };
}

/** a hand key with the wrist moved */
const at = (h: HandKey, wrist: V3, o: Partial<HandKey> = {}): HandKey => ({ ...h, wrist, ...o });

/**
 * A clap in front of the chest at time c (s): from the hands `from` (at time c - 0.6) up, apart, the
 * palms meeting fast at c (the wrists ~2.4 cm from the midline: palm to palm), then a little apart.
 * Returns the keys for the left and the right hand (to be continued by the caller).
 */
function clapKeys(c: number, from: [HandKey, HandKey], y: number, z: number) {
  const fingers: V3 = norm([0, 0.75, -0.66]);
  const side = (s: -1 | 1) => {
    const palm: V3 = [-s, 0, 0];
    const k = (x: number, dy = 0, curl = 0.08): HandKey => ({ wrist: [s * x, y + dy, z], dir: fingers, palm, curl, pinch: 0 });
    return [
      { t: c - 0.6, h: from[s < 0 ? 0 : 1], stop: true },
      { t: c - 0.17, h: k(0.17, 0.01) },
      { t: c, h: k(0.024), ease: easeIn },
      { t: c + 0.22, h: k(0.11, -0.02, 0.15), ease: easeOut },
    ];
  };
  return [side(-1), side(1)] as const;
}

// ---------------------------------------------------------------- 1: coiling (front, with cable)

const NOOR_S: PersonSpec = { ...NOOR, name: 'Noor', gloves: 'none', pushed: true };

const COIL_CLAP = 1.0;
/** from here the hands hold the coil and the cable (grips of the sweep) */
const COIL_GRIP = 2.0;
/** the sweep (one over and one under loop) runs from here */
const COIL_START = 2.4;
const COIL_END = COIL_START + SWEEP_PERIOD;

const sweepBase = sweepRig(0);
const SWEEP_START = rigPose(NOOR_S, sweepBase);
const NOOR_HANG = rigPose(NOOR_S, { ...sweepBase, hands: [null, null] });

const coilHands = (() => {
  const from: [HandKey, HandKey] = [keyOf(NOOR_HANG, 0), keyOf(NOOR_HANG, 1)];
  const [l, r] = clapKeys(COIL_CLAP, from, 1.12, -0.3);
  const to = [keyOf(SWEEP_START, 0, 0.55), keyOf(SWEEP_START, 1, 0.5, 1)];
  const left = handTrack([{ t: 0, h: from[0], stop: true }, ...l, { t: COIL_GRIP, h: to[0], stop: true }]);
  const right = handTrack([{ t: 0, h: from[1], stop: true }, ...r, { t: COIL_GRIP, h: to[1], stop: true }]);
  return [left, right] as const;
})();

/** sweep time (s, 0 … SWEEP_PERIOD) at shot time t; holds the start pose before and the end pose after */
const sweepU = (t: number) => clamp(t - COIL_START, 0, SWEEP_PERIOD - 1e-6);

function coilRig(t: number): Rig {
  if (t >= COIL_GRIP) return sweepRig(t >= COIL_END ? 0 : sweepU(t));
  const look = mix3([0, 1.05, -0.45], sweepBase.look ?? [0, 0.9, -0.4], clamp((t - COIL_CLAP - 0.3) / 0.6));
  return { ...sweepBase, look, hands: [coilHands[0](t), coilHands[1](t)] };
}

/** the ring's loops in the left hand: two at the start, one more after each hand-over */
function loopsAt(u: number): number {
  return 2 + (u >= SWEEP_BEATS.overIn ? 1 : 0) + (u >= SWEEP_BEATS.underIn ? 1 : 0);
}

/**
 * The loop being formed between the hands (m of cable from the left hand to the right one): grows
 * while the right hand slides out, stays while it comes back; `round` (0 … 1) morphs it into the
 * round loop it becomes at the hand-over.
 */
const formLen = track([
  [0, 0.12], [0.35, 0.12], [1.35, 1.0], [SWEEP_BEATS.overIn - 1e-3, 1.0, linear],
  [SWEEP_BEATS.overIn, 0.12, linear], [3.65, 0.12], [4.55, 1.0], [SWEEP_BEATS.underIn - 1e-3, 1.0, linear],
  [SWEEP_BEATS.underIn, 0.12, linear], [SWEEP_PERIOD, 0.12],
]);
const formRound = track([
  [0, 0], [SWEEP_BEATS.overIn - 0.45, 0], [SWEEP_BEATS.overIn - 1e-3, 1], [SWEEP_BEATS.overIn, 0, linear],
  [SWEEP_BEATS.underIn - 0.45, 0], [SWEEP_BEATS.underIn - 1e-3, 1], [SWEEP_BEATS.underIn, 0, linear],
]);

/** a loop's radius (5 m XLR in loops of about 1 m) */
const LOOP_R = 0.16;
const LEFT_ALONG: V3 = norm([0.1, 0.4, -1]);

/** a circle hanging from `top` in the plane perpendicular to `along` (a loop on the rod of the hand), from the top round */
function hangingLoop(top: V3, along: V3, r: number, n: number, sense = 1): V3[] {
  const e1 = norm(sub([0, 1, 0], scale(along, along[1])));
  const e2 = scale(cross(along, e1), sense);
  const c = madd(top, e1, -r);
  const out: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * i) / n;
    out.push(add(c, add(scale(e1, r * Math.cos(a)), scale(e2, r * Math.sin(a)))));
  }
  return out;
}

/** a parabola of length ~L between a and b, sagging under gravity (the hanging cable between the hands) */
function sagging(a: V3, b: V3, L: number, n: number): V3[] {
  const s = len(sub(b, a));
  const f = Math.sqrt((3 * s * Math.max(0, L - s)) / 8);
  const out: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    out.push(madd(mix3(a, b, u), [0, 1, 0], -4 * f * u * (1 - u)));
  }
  return out;
}

/** the hand-over point of a hand: the grip's point when it grips, else between thumb tip and index finger */
function heldPoint(pose: Pose, i: 0 | 1): { p: V3; d3: V3 | null } {
  const g = pose.body.arms?.[i].grip;
  if (g) return { p: g.p, d3: quatCols(g.q)[2] };
  const hj = handJoints(pose.body.hands[i], i ? 1 : -1);
  if (i === 0) return { p: mix3(hj.fingers[0].p[1], hj.fingers[3].p[1], 0.5), d3: null };
  return { p: mix3(hj.thumb[3], hj.fingers[0].p[2], 0.5), d3: null };
}

/** the cable of the coiling, one polyline: ring, the loop being formed, down to the floor, along it */
function coilCable(t: number, pose: Pose): V3[][] {
  const u = t >= COIL_END ? 0 : sweepU(t);
  const L = heldPoint(pose, 0);
  const R = heldPoint(pose, 1);
  // the first 0.2 s of gripping: from the free hands' points to the grips' (no jump)
  const w = clamp((t - COIL_GRIP) / 0.2);
  const along = norm(L.d3 ? mix3(LEFT_ALONG, L.d3, w) : LEFT_ALONG);
  const pts: V3[] = [];
  const nRing = t >= COIL_END ? 4 : loopsAt(u);
  // the ring: loops hanging in front of each other along the bundle (the first next to the hand)
  for (let k = 0; k < nRing; k++) {
    const top = madd(L.p, along, -0.012 + 0.008 * k);
    const r = LOOP_R * (1 + 0.035 * Math.sin(1.7 * k + 0.4));
    pts.push(...hangingLoop(top, along, r, 40));
  }
  // the loop being formed: a sagging cable between the hands, rounding into the next loop
  const top = madd(L.p, along, -0.012 + 0.008 * nRing);
  const span = len(sub(R.p, top));
  const Lf = Math.max(t >= COIL_END ? 0.12 : formLen(u), span * 1.04 + 0.02);
  const sag = sagging(top, R.p, Lf, 30);
  const round = t >= COIL_START && t < COIL_END ? formRound(u) : 0;
  if (round > 0) {
    // the loop it becomes: from the hand round to the right hand's point
    const circle = hangingLoop(top, along, LOOP_R, 30);
    for (let i = 0; i < sag.length; i++) sag[i] = mix3(sag[i], i === sag.length - 1 ? R.p : circle[i], round * (i === sag.length - 1 ? 0 : 1));
  }
  pts.push(...sag.slice(1));
  // from the right hand down to the floor (to the right of the right foot) and along the floor
  const floorY = 0.0032;
  const F: V3 = [R.p[0] + 0.28, floorY, R.p[2] + 0.12];
  const drop = cubic(R.p, madd(R.p, [0.05, -1, 0.02], 0.3), [F[0] - 0.05, 0.2, F[2]], F, 18);
  pts.push(...drop.slice(1));
  const end: V3 = [1.7, floorY, 0.25];
  const mid: V3 = [lerp(F[0], end[0], 0.5), floorY, lerp(F[2], end[2], 0.5) + 0.12];
  pts.push(...cubic(F, mid, mid, end, 16).slice(1));
  return [pts];
}

function cubic(a: V3, b: V3, c: V3, d: V3, n: number): V3[] {
  const out: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const v = 1 - u;
    out.push(add(add(scale(a, v * v * v), scale(b, 3 * v * v * u)), add(scale(c, 3 * v * u * u), scale(d, u * u * u))));
  }
  return out;
}

export const COIL: Motion = {
  name: 'synth-coil',
  shot: 'p1.coil.teach',
  role: 'Noor',
  spec: NOOR_S,
  setup: { id: 'A', height_m: 1.2, distance_m: 2.0, yaw_deg: 0, pitch_deg: -10, wall_m: 1.2, note: 'wie A, aber genau von vorn und 2,0 m entfernt' },
  seconds: 10,
  rigAt: coilRig,
  cable: coilCable,
  markers: { clap: COIL_CLAP, start: COIL_START, end: COIL_END },
  // the clap, out at the hip (over loop), turned over for the under loop
  previews: [COIL_CLAP, COIL_START + SWEEP_BEATS.out, COIL_START + SWEEP_BEATS.turned],
  about: 'Noor wickelt eine Über- und eine Unter-Schlaufe (IK-Testchoreographie ik-sweep.ts), mit Kabel: Ring in der linken Hand, Schlaufe zwischen den Händen, rechts zum Boden.',
};

// ---------------------------------------------------------------- 2: underhand throw (side, setup D)

const KOFI_S: PersonSpec = { ...KOFI };
const THROW_CLAP = 1.0;
const THROW_START = 2.0;
const THROW_END = 5.4;
const throwStance = stand(KOFI_S, [0, 0], 0, { width: 0.3, stagger: 0.3 });
const throwBase: Rig = { ...throwStance, lean: 0.04, look: [0, 1.3, -4], hands: [null, null] };
const KOFI_HANG = rigPose(KOFI_S, throwBase);

const throwHands = (() => {
  const from: [HandKey, HandKey] = [keyOf(KOFI_HANG, 0), keyOf(KOFI_HANG, 1)];
  const [l, r] = clapKeys(THROW_CLAP, from, 1.2, -0.3);
  // the left hand holds the cable's end in front of the left hip, palm in
  const holdL: HandKey = { wrist: [-0.16, 0.98, -0.24], dir: [0.3, -0.2, -1], palm: [1, 0.2, 0], curl: 0.75, pinch: 0.4 };
  // the right hand: the ring in front of the right hip, back of the hand forward
  const ring: HandKey = { wrist: [0.2, 0.96, -0.22], dir: [-0.1, -0.35, -1], palm: [-0.6, 0.2, 0.3], curl: 0.6, pinch: 0.3 };
  const R = (wrist: V3, o: Partial<HandKey> = {}) => at(ring, wrist, o);
  const left = handTrack([
    { t: 0, h: from[0], stop: true }, ...l,
    { t: 1.7, h: holdL, stop: true }, { t: 3.0, h: at(holdL, [-0.15, 0.94, -0.3]) }, { t: 3.8, h: at(holdL, [-0.18, 0.98, -0.2]) },
    { t: THROW_END + 0.3, h: holdL, stop: true },
  ]);
  const right = handTrack([
    { t: 0, h: from[1], stop: true }, ...r,
    { t: 1.7, h: ring, stop: true },
    { t: THROW_START, h: ring, stop: true },
    // backswing: down and back past the hip, the arm almost straight behind
    { t: 2.6, h: R([0.24, 0.8, 0.05], { dir: [0, -1, 0.3] }) },
    { t: 3.15, h: R([0.25, 0.9, 0.3], { dir: [0, -0.5, 1], palm: [0, -0.3, -1] }), stop: true },
    // the swing: down past the leg, forward and up, released at chest height
    { t: 3.42, h: R([0.24, 0.8, 0.02], { dir: [0, -1, -0.2], palm: [0, 0, -1] }) },
    { t: 3.62, h: R([0.22, 0.98, -0.5], { dir: [0, 0.2, -1], palm: [0, 1, -0.2], curl: 0.35 }) },
    { t: 3.78, h: R([0.19, 1.3, -0.6], { dir: [0, 0.8, -0.6], palm: [0, 0.6, 0.8], curl: 0.15 }) },
    // follow-through, then the arm comes down slowly
    { t: 4.05, h: R([0.16, 1.48, -0.46], { dir: [0, 1, -0.2], palm: [0, 0.2, 1], curl: 0.15 }), stop: true },
    { t: 4.8, h: R([0.2, 1.1, -0.35], { dir: [0, -0.4, -1], palm: [-0.5, 0, 0.5], curl: 0.3 }) },
    { t: THROW_END, h: keyOf(KOFI_HANG, 1), stop: true },
  ]);
  return [left, right] as const;
})();

const throwLean = track([[0, 0.04], [THROW_START, 0.06], [3.15, 0.32], [3.62, 0.18], [4.05, 0.08], [THROW_END, 0.04]]);
const throwDrop = track([[0, 0], [THROW_START, 0.01], [3.15, 0.09], [3.62, 0.04], [4.05, 0.0], [THROW_END, 0]]);
const throwTwist = track([[0, 0], [THROW_START, 0], [3.15, -0.3], [3.5, 0], [3.9, 0.22], [4.6, 0.08], [THROW_END, 0]]);
const throwPos = track([[0, 0], [THROW_START, 0], [3.15, 0.04], [3.8, -0.08], [THROW_END, -0.05]]);

function throwRig(t: number): Rig {
  return { ...throwBase, pos: [0, throwPos(t)], lean: throwLean(t), drop: throwDrop(t), twist: throwTwist(t), hands: [throwHands[0](t), throwHands[1](t)] };
}

export const THROW: Motion = {
  name: 'synth-throw',
  shot: 'p1.throw.only',
  role: 'Kofi',
  spec: KOFI_S,
  setup: { id: 'D', height_m: 1.0, distance_m: 3.2, yaw_deg: 90, pitch_deg: -5, wall_m: 1.6, note: 'Person auf D-Mitte statt D-Start; Wurf ohne Kabel' },
  seconds: 7,
  rigAt: throwRig,
  markers: { clap: THROW_CLAP, start: THROW_START, end: THROW_END },
  // backswing, the swing past the leg, the release
  previews: [3.15, 3.45, 3.8],
  about: 'Kofi von der Seite (Kinect rechts von ihm): Wurf von unten mit dem rechten Arm, ohne Kabel.',
};

// ---------------------------------------------------------------- 3: calibration (cal.A.body, cal.B.body)

const TEO_S: PersonSpec = { ...TEO };
const T_CLAP = 1.0;
const T_START = 1.5;

/** a point or direction of the body frame at yaw 0 turned with the body to yaw a (rad, + = to the right) */
const yawed = (p: V3, a: number): V3 => [p[0] * Math.cos(a) - p[2] * Math.sin(a), p[1], p[0] * Math.sin(a) + p[2] * Math.cos(a)];
const yawedHand = (h: HandRig, a: number): HandRig => ({ ...h, wrist: h.wrist && yawed(h.wrist, a), dir: h.dir && yawed(h.dir, a), palm: h.palm && yawed(h.palm, a) });

/**
 * The body calibration of aufnahmeplan.md (A1–A3, B1–B3): clap, T-pose 2.5 s, hands three times
 * open and closed, palms three times down and up; with `turns` (setup A) then 2 s facing the sensor
 * and 2 s exactly side-on (sensor on the right). The turns pivot on the spot (the feet slide).
 */
function calibration(o: { name: string; shot: string; setup: Setup; turns: boolean; armsForward: number; about: string }): Motion {
  const base: Rig = { ...stand(TEO_S, [0, 0], 0, { width: 0.28 }), lean: 0, look: [0, 1.5, -1.5], hands: [null, null] };
  const hang = rigPose(TEO_S, base);
  const from: [HandKey, HandKey] = [keyOf(hang, 0), keyOf(hang, 1)];
  const [l, r] = clapKeys(T_CLAP, from, 1.2, -0.3);
  const armsDown = 9.4;
  const side = (s: -1 | 1, clap: typeof l) => {
    // T-pose: arms out sideways at shoulder height, palms down (forward by armsForward, m)
    const f = o.armsForward;
    const tp: HandKey = { wrist: [s * Math.sqrt(0.74 * 0.74 - f * f), 1.4, -f], dir: [s, 0.02, -f / 0.74], palm: [0, -1, 0], curl: 0.05, pinch: 0 };
    // hands up in front of the chest, palms to the front: open and close
    const open: HandKey = { wrist: [s * 0.2, 1.18, -0.36], dir: [s * 0.15, 1, -0.15], palm: [0, 0.1, -1], curl: 0.02, pinch: 0 };
    const fist: HandKey = { ...open, curl: 1 };
    // forearms in front of the belly: palms up, to the midline, down
    const fore = (palm: V3): HandKey => ({ wrist: [s * 0.17, 1.0, -0.3], dir: [-s * 0.25, 0.05, -1], palm, curl: 0.15, pinch: 0 });
    const up = fore([0, 1, 0]);
    const inward = fore([-s, 0, 0]);
    const down = fore([0, -1, 0]);
    const k: { t: number; h: HandKey; stop?: boolean; ease?: Ease }[] = [
      { t: 0, h: from[s < 0 ? 0 : 1], stop: true }, ...clap,
      { t: 2.1, h: tp, stop: true }, { t: 4.6, h: tp, stop: true },
      { t: 5.3, h: open, stop: true },
    ];
    // three times closed and open again (0.6 s each)
    for (let i = 0; i < 3; i++) k.push({ t: 5.6 + 0.6 * i, h: fist, stop: true }, { t: 5.9 + 0.6 * i, h: open, stop: true });
    k.push({ t: 7.0, h: up, stop: true });
    // three times down and up again (0.6 s each), past the midline
    for (let i = 0; i < 3; i++) k.push({ t: 7.15 + 0.6 * i, h: inward }, { t: 7.3 + 0.6 * i, h: down, stop: true }, { t: 7.45 + 0.6 * i, h: inward }, { t: 7.6 + 0.6 * i, h: up, stop: true });
    k.push({ t: armsDown, h: from[s < 0 ? 0 : 1], stop: true });
    return handTrack(k);
  };
  const hands = [side(-1, l), side(1, r)] as const;
  // the turns: towards the sensor (it stands at yaw_deg to the right), then side-on (sensor on the right)
  const toSensor = (o.setup.yaw_deg * Math.PI) / 180;
  const yaw = o.turns ? track([[0, 0], [armsDown + 0.2, 0], [armsDown + 1.0, toSensor], [armsDown + 3.0, toSensor], [armsDown + 3.9, toSensor - Math.PI / 2]]) : () => 0;
  const end = o.turns ? armsDown + 3.9 : armsDown;
  const seconds = o.turns ? end + 2.1 : 10;
  const rigAt = (t: number): Rig => {
    const a = yaw(t);
    return { ...base, ...stand(TEO_S, [0, 0], a, { width: 0.28 }), lean: 0, look: yawed([0, 1.5, -1.5], a), hands: [yawedHand(hands[0](t), a), yawedHand(hands[1](t), a)] };
  };
  return {
    name: o.name,
    shot: o.shot,
    role: 'du',
    spec: TEO_S,
    setup: o.setup,
    seconds,
    rigAt,
    markers: { clap: T_CLAP, start: T_START, end },
    // T-pose, a fist, palms down (and side-on)
    previews: o.turns ? [3.3, 5.6, end + 1.0] : [3.3, 5.6, 7.3],
    about: o.about,
  };
}

export const TPOSE: Motion = calibration({
  name: 'synth-tpose',
  shot: 'cal.A.body',
  setup: { id: 'A', height_m: 1.2, distance_m: 1.8, yaw_deg: 30, pitch_deg: -10, wall_m: 1.2, note: 'wie A (Kinect 30° vorn rechts)' },
  turns: true,
  armsForward: 0.1,
  about: 'Teo in Aufbau A: T-Pose 2,5 s, Hände dreimal auf und zu, Handflächen dreimal runter und hoch, dann 2 s zur Kinect gedreht und 2 s seitlich (Kinect rechts).',
});

/** the same close up from above (setup B): in the T-pose the hands leave the picture (aufnahmeplan B1–B3) */
export const TPOSE_B: Motion = calibration({
  name: 'synth-tpose-b',
  shot: 'cal.B.body',
  setup: { id: 'B', height_m: 1.5, distance_m: 1.3, yaw_deg: 0, pitch_deg: -20, wall_m: 1.2, note: 'wie B' },
  turns: false,
  armsForward: 0.16,
  about: 'Teo nah von vorn oben (Aufbau B): T-Pose (die Hände ragen aus dem Bild), Hände dreimal auf und zu, Handflächen dreimal runter und hoch.',
});

// ---------------------------------------------------------------- extra: the coiling from setup A

/** the same coiling from where the Kinect really stands in setup A: 1.8 m, 30° to the front right of Noor */
export const COIL_A: Motion = {
  ...COIL,
  name: 'synth-coil-a',
  setup: { id: 'A', height_m: 1.2, distance_m: 1.8, yaw_deg: 30, pitch_deg: -10, wall_m: 1.2, note: 'wie A (Kinect 30° vorn rechts)' },
  about: 'Wie synth-coil, aber aus Aufbau A: die Kinect steht 1,8 m entfernt, 30° vorn rechts von Noor.',
};

export const MOTIONS: Record<string, Motion> = { coil: COIL, throw: THROW, tpose: TPOSE, 'coil-a': COIL_A, 'tpose-b': TPOSE_B };
/** what erzeugen.mjs makes without names */
export const DEFAULT = ['coil', 'throw', 'tpose'];

