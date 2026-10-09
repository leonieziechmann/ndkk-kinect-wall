// Low-effort stand-ins for the people in front of the wall: stick figures with a body of capsules
// (sphere-swept lines), walking along waypoints and doing a few arm gestures. Everything is a pure
// function of the global story time T (seconds since the video starts), so every scene, the
// simulated Kinect and the fluid see the same people at the same moment.
//
// Joint names and order follow the repo (web/lib/persons.js, POINTS): the 17 COCO points of the
// pose model, then neck, pelvis, head and the two hands.

import { PERSON_COLORS, V3, clamp, hexRgb, local, norm, smooth, RGB } from './math';
import { CHOREO } from './choreo';

export const JOINTS = [
  'nose', 'leftEye', 'rightEye', 'leftEar', 'rightEar',
  'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist',
  'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle',
  'neck', 'pelvis', 'head', 'leftHand', 'rightHand',
] as const;
export type JointName = (typeof JOINTS)[number];
export const J = Object.fromEntries(JOINTS.map((n, i) => [n, i])) as Record<JointName, number>;

/** the stick figure of the repo (BONES in web/lib/persons.js) */
export const BONES: [number, number][] = (
  [
    ['head', 'neck'], ['neck', 'leftShoulder'], ['neck', 'rightShoulder'], ['leftShoulder', 'leftElbow'],
    ['leftElbow', 'leftWrist'], ['leftWrist', 'leftHand'], ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'],
    ['rightWrist', 'rightHand'], ['neck', 'pelvis'], ['pelvis', 'leftHip'], ['pelvis', 'rightHip'], ['leftHip', 'leftKnee'],
    ['leftKnee', 'leftAnkle'], ['rightHip', 'rightKnee'], ['rightKnee', 'rightAnkle'],
  ] as [JointName, JointName][]
).map(([a, b]) => [J[a], J[b]]);

/** the COCO skeleton the pose model draws (with the face) */
export const COCO_BONES: [number, number][] = [
  [15, 13], [13, 11], [16, 14], [14, 12], [11, 12], [5, 11], [6, 12], [5, 6], [5, 7], [6, 8], [7, 9], [8, 10],
  [1, 2], [0, 1], [0, 2], [1, 3], [2, 4], [3, 5], [4, 6],
];

export type ActionKind = 'wave' | 'raise' | 'out' | 'sweep' | 'point' | 'reach';
export interface Action {
  t0: number;
  t1: number;
  kind: ActionKind;
  /** which arm: L, R or both (B) */
  side: 'L' | 'R' | 'B';
}
export interface Waypoint {
  /** arrive here at time t (walking from the previous waypoint) */
  t: number;
  x: number;
  z: number;
}
export interface PersonSpec {
  slot: number;
  height: number;
  path: Waypoint[];
  actions: Action[];
  /** infrared reflectivity of the clothes */
  albedo: number;
  /** wears a dress (a wide shape from the hips to the knees) */
  dress?: boolean;
  /** hair tied back (a small bun behind the head) */
  hair?: boolean;
}

export interface Capsule {
  a: V3;
  b: V3;
  r: number;
}

export interface Pose {
  slot: number;
  color: RGB;
  css: string;
  joints: V3[];
  capsules: Capsule[];
  /** the albedo per capsule (skin a bit brighter than clothes) */
  albedo: number[];
  center: V3;
  F: V3;
  R: V3;
  speed: number;
}

const U: V3 = [0, 1, 0];
const STRIDE = 1.3; // m per full gait cycle

/** position on the path at T: [x, z, segment speed (m/s), dir x, dir z, distance walked] */
function onPath(path: Waypoint[], T: number) {
  let dist = 0;
  if (T <= path[0].t) return { x: path[0].x, z: path[0].z, v: 0, dx: 0, dz: -1, dist: 0 };
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    if (T < b.t) {
      const dur = b.t - a.t;
      const u = clamp((T - a.t) / dur);
      const s = (1 - Math.cos(Math.PI * u)) / 2;
      const v = segLen > 0 ? ((segLen * Math.PI) / 2) * Math.sin(Math.PI * u) / dur : 0;
      const dx = segLen > 0 ? (b.x - a.x) / segLen : 0;
      const dz = segLen > 0 ? (b.z - a.z) / segLen : -1;
      return { x: a.x + (b.x - a.x) * s, z: a.z + (b.z - a.z) * s, v, dx, dz, dist: dist + segLen * s };
    }
    dist += segLen;
  }
  const last = path[path.length - 1];
  return { x: last.x, z: last.z, v: 0, dx: 0, dz: -1, dist };
}

function actionWeight(a: Action, T: number) {
  return smooth(a.t0, a.t0 + 0.45, T) * (1 - smooth(a.t1 - 0.45, a.t1, T));
}

/** arm directions in the body frame: [outwards, up, forward] for upper arm and forearm */
function actionArm(a: Action, T: number, slot: number): [V3, V3] {
  const t = T - a.t0;
  switch (a.kind) {
    case 'wave': {
      const w = Math.sin(2 * Math.PI * 1.5 * t + slot);
      return [[0.75, 0.62, 0.12], [0.18 + 0.55 * w, 1, 0.05]];
    }
    case 'raise':
      return [[0.42, 0.92, 0.1], [0.3, 1, 0.12]];
    case 'out': {
      const w = 0.08 * Math.sin(2 * Math.PI * 0.6 * t);
      return [[1, 0.06 + w, 0.15], [1, 0.14 + w, 0.22]];
    }
    case 'sweep': {
      const b = 0.75 + 0.7 * Math.sin(2 * Math.PI * 0.55 * t);
      return [[Math.cos(b), 0.22, Math.sin(b)], [Math.cos(b + 0.35), 0.3, Math.sin(b + 0.35)]];
    }
    case 'point':
      return [[0.12, 0.25, 1], [0.08, 0.3, 1]];
    case 'reach': {
      const w = 0.12 * Math.sin(2 * Math.PI * 0.8 * t);
      return [[0.2 + w, 1, 0.15], [0.12, 1, 0.1]];
    }
  }
}

const mixDir = (a: V3, b: V3, w: number): V3 => [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];

/** the pose of one person at time T (null while not in the room) */
export function pose(spec: PersonSpec, T: number): Pose | null {
  const p = spec.path;
  if (T < p[0].t - 0.001) return null;
  const k = spec.height / 1.75;
  const at = onPath(p, T);
  // facing: towards the wall when standing, along the way when walking
  const walk = smooth(0.08, 0.5, at.v);
  const thWall = 0.12 * Math.sin(0.31 * T + spec.slot * 1.7);
  const thWalk = Math.atan2(at.dx, -at.dz);
  let d = thWalk - thWall;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const th = thWall + d * walk * 0.85;
  const F: V3 = [Math.sin(th), 0, -Math.cos(th)];
  const R: V3 = [Math.cos(th), 0, Math.sin(th)];
  const amp = clamp(at.v / 1.1);
  const phase = (2 * Math.PI * at.dist) / STRIDE + spec.slot;

  // legs, relative to the pelvis at height 0
  const thigh = 0.44 * k;
  const shin = 0.42 * k;
  const legs = [phase, phase + Math.PI].map((ph) => {
    const a = 0.42 * amp * Math.sin(ph);
    const b = amp * (0.1 + 0.62 * Math.max(0, Math.cos(ph - 0.35))) + 0.04;
    const knee: V3 = [0, -Math.cos(a) * thigh, Math.sin(a) * thigh];
    const ankle: V3 = [0, knee[1] - Math.cos(a - b) * shin, knee[2] + Math.sin(a - b) * shin];
    return { knee, ankle };
  });
  const ankleH = 0.075 * k;
  const pelvisY = ankleH - Math.min(legs[0].ankle[1], legs[1].ankle[1]);
  const sway = 0.012 * Math.sin(0.9 * T + spec.slot);
  const pelvis: V3 = [at.x + R[0] * sway, pelvisY, at.z + R[2] * sway];
  const lean = 0.06 * amp;
  const neck = local(pelvis, R, U, F, 0, 0.5 * k, lean);
  const head = local(neck, R, U, F, 0, 0.17 * k, 0.02);
  const shoulderY = -0.035 * k;
  const lSh = local(neck, R, U, F, -0.19 * k, shoulderY, 0);
  const rSh = local(neck, R, U, F, 0.19 * k, shoulderY, 0);
  const lHip = local(pelvis, R, U, F, -0.095 * k, 0, 0);
  const rHip = local(pelvis, R, U, F, 0.095 * k, 0, 0);
  const leg = (hip: V3, l: { knee: V3; ankle: V3 }) => {
    const knee = local(hip, R, U, F, 0.01, l.knee[1], l.knee[2]);
    const ankle = local(hip, R, U, F, 0.015, l.ankle[1], l.ankle[2]);
    const toe = local(ankle, R, U, F, 0, -0.045 * k, 0.14 * k);
    return { knee, ankle, toe };
  };
  const L = leg(lHip, legs[0]);
  const Rl = leg(rHip, legs[1]);

  // arms: walking swing plus the gestures
  const arms = (['L', 'R'] as const).map((side, i) => {
    const sign = side === 'L' ? -1 : 1;
    const legPh = i === 0 ? phase : phase + Math.PI;
    const swing = -0.38 * amp * Math.sin(legPh) + 0.03 * Math.sin(0.9 * T + i);
    let up: V3 = [0.07, -Math.cos(swing), Math.sin(swing)];
    let fo: V3 = [0.05, -Math.cos(0.3 + 0.35 * amp), Math.sin(0.3 + 0.35 * amp) + Math.sin(swing)];
    for (const a of spec.actions) {
      if (a.side !== 'B' && a.side !== side) continue;
      const w = actionWeight(a, T);
      if (w <= 0) continue;
      const [au, af] = actionArm(a, T, spec.slot + i * 0.7);
      up = mixDir(up, norm(au), w);
      fo = mixDir(fo, norm(af), w);
    }
    const u = norm(up);
    const f = norm(fo);
    const toWorld = (v: V3): V3 => norm([
      R[0] * v[0] * sign + U[0] * v[1] + F[0] * v[2],
      R[1] * v[0] * sign + U[1] * v[1] + F[1] * v[2],
      R[2] * v[0] * sign + U[2] * v[1] + F[2] * v[2],
    ]);
    const sh = side === 'L' ? lSh : rSh;
    const ud = toWorld(u);
    const fd = toWorld(f);
    const elbow: V3 = [sh[0] + ud[0] * 0.29 * k, sh[1] + ud[1] * 0.29 * k, sh[2] + ud[2] * 0.29 * k];
    const wrist: V3 = [elbow[0] + fd[0] * 0.26 * k, elbow[1] + fd[1] * 0.26 * k, elbow[2] + fd[2] * 0.26 * k];
    const hand: V3 = [wrist[0] + fd[0] * 0.09 * k, wrist[1] + fd[1] * 0.09 * k, wrist[2] + fd[2] * 0.09 * k];
    return { elbow, wrist, hand };
  });

  // the head looks around a little
  const look = 0.22 * Math.sin(0.45 * T + spec.slot * 2.1) * (1 - walk);
  const HF: V3 = [F[0] * Math.cos(look) + R[0] * Math.sin(look), 0, F[2] * Math.cos(look) + R[2] * Math.sin(look)];
  const HR: V3 = [R[0] * Math.cos(look) - F[0] * Math.sin(look), 0, R[2] * Math.cos(look) - F[2] * Math.sin(look)];
  const nose = local(head, HR, U, HF, 0, -0.02 * k, 0.1 * k);
  const lEye = local(head, HR, U, HF, -0.035 * k, 0.025 * k, 0.085 * k);
  const rEye = local(head, HR, U, HF, 0.035 * k, 0.025 * k, 0.085 * k);
  const lEar = local(head, HR, U, HF, -0.075 * k, 0, 0);
  const rEar = local(head, HR, U, HF, 0.075 * k, 0, 0);

  const joints: V3[] = [
    nose, lEye, rEye, lEar, rEar,
    lSh, rSh, arms[0].elbow, arms[1].elbow, arms[0].wrist, arms[1].wrist,
    lHip, rHip, L.knee, Rl.knee, L.ankle, Rl.ankle,
    neck, pelvis, head, arms[0].hand, arms[1].hand,
  ];

  const chestL = local(neck, R, U, F, -0.08 * k, -0.08 * k, 0);
  const chestR = local(neck, R, U, F, 0.08 * k, -0.08 * k, 0);
  const capsules: Capsule[] = [
    { a: head, b: head, r: 0.105 * k },
    { a: neck, b: head, r: 0.05 * k },
    { a: chestL, b: local(lHip, R, U, F, 0.02, 0.04, 0), r: 0.105 * k },
    { a: chestR, b: local(rHip, R, U, F, -0.02, 0.04, 0), r: 0.105 * k },
    { a: local(neck, R, U, F, 0, -0.06 * k, 0), b: pelvis, r: 0.115 * k },
    { a: lSh, b: arms[0].elbow, r: 0.048 * k },
    { a: rSh, b: arms[1].elbow, r: 0.048 * k },
    { a: arms[0].elbow, b: arms[0].wrist, r: 0.04 * k },
    { a: arms[1].elbow, b: arms[1].wrist, r: 0.04 * k },
    { a: arms[0].wrist, b: arms[0].hand, r: 0.038 * k },
    { a: arms[1].wrist, b: arms[1].hand, r: 0.038 * k },
    { a: lHip, b: L.knee, r: 0.072 * k },
    { a: rHip, b: Rl.knee, r: 0.072 * k },
    { a: L.knee, b: L.ankle, r: 0.054 * k },
    { a: Rl.knee, b: Rl.ankle, r: 0.054 * k },
    { a: L.ankle, b: L.toe, r: 0.04 * k },
    { a: Rl.ankle, b: Rl.toe, r: 0.04 * k },
    // shoulders, chest and hips give the torso its shape
    { a: lSh, b: rSh, r: 0.06 * k },
    { a: local(neck, R, U, F, -0.1 * k, -0.17 * k, 0.015), b: local(neck, R, U, F, 0.1 * k, -0.17 * k, 0.015), r: 0.11 * k },
    { a: local(lHip, R, U, F, 0.01, 0.03, 0), b: local(rHip, R, U, F, -0.01, 0.03, 0), r: 0.1 * k },
  ];
  if (spec.dress) {
    // a dress: wide from the hips down to the knees, swinging with the legs
    const kneeMid: V3 = [(L.knee[0] + Rl.knee[0]) / 2, (L.knee[1] + Rl.knee[1]) / 2, (L.knee[2] + Rl.knee[2]) / 2];
    capsules.push({ a: local(pelvis, R, U, F, 0, -0.02, 0), b: [kneeMid[0], kneeMid[1] + 0.02, kneeMid[2]], r: 0.165 * k });
  }
  if (spec.hair) capsules.push({ a: local(head, HR, U, HF, 0, 0.0, -0.1 * k), b: local(head, HR, U, HF, 0, -0.08 * k, -0.12 * k), r: 0.05 * k });
  const skin = Math.min(1, spec.albedo + 0.12);
  const albedo = capsules.map((_, i) => (i <= 1 || i === 9 || i === 10 ? skin : spec.albedo));
  const css = PERSON_COLORS[spec.slot] ?? '#ffffff';
  return {
    slot: spec.slot,
    color: hexRgb(css),
    css,
    joints,
    capsules,
    albedo,
    center: local(pelvis, R, U, F, 0, 0.25 * k, 0),
    F,
    R,
    speed: at.v,
  };
}

/** everyone in the room at T */
export function people(T: number): Pose[] {
  const out: Pose[] = [];
  for (const spec of CHOREO) {
    const p = pose(spec, T);
    if (p) out.push(p);
  }
  return out;
}

export function personSpec(slot: number) {
  return CHOREO.find((s) => s.slot === slot);
}
