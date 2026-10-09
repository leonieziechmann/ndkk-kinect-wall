// The people in front of the wall: a skeleton that walks along waypoints and makes a few gestures,
// as a pure function of the global story time T (seconds since the video starts), so every scene,
// the simulated Kinect and the fluid see the same people at the same moment. The bodies around the
// skeleton are triangle meshes (body/styles.ts).
//
// The motion: a walk cycle with hip, knee and foot roll, the pelvis turning with the legs and the
// chest against it, a little bounce; standing, the weight rests on one leg and shifts now and then,
// the head looks around; gestures move the arms from the shoulder with a bending elbow.
//
// Joint names and order follow the repo (web/lib/persons.js, POINTS): the 17 COCO points of the
// pose model, then neck, pelvis, head and the two hands.

import { PERSON_COLORS, V3, clamp, cross, hexRgb, local, norm, smooth, RGB } from './math';
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

/**
 * The gestures. None of them stretches an arm forward: arms go up or out to the side, the elbows
 * bend (no pose that could read as a raised-arm salute; `npm run check-arms` checks every frame).
 */
export type ActionKind = 'wave' | 'raise' | 'out' | 'circle' | 'reach';
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
  /** body shape: a little wider hips, narrower shoulders */
  female?: boolean;
  /** hair: short, curly (more volume) or pulled back into a ponytail */
  hair?: 'short' | 'curly' | 'ponytail';
  /** top: a T-shirt, long sleeves, or a wide, boxy shirt tucked into high-waisted pants */
  top?: 'tee' | 'sweater' | 'boxy';
  /** pants: straight, or wide legs down over the shoes */
  pants?: 'straight' | 'wide';
}

/** a simplified body of capsules, for the fluid's forces (indices 5..10 are the arms) */
export interface Capsule {
  a: V3;
  b: V3;
  r: number;
}

/** an orthonormal frame: right, up, forward */
export interface Frame {
  r: V3;
  u: V3;
  f: V3;
}

export interface Body {
  /** height / 1.75 */
  k: number;
  pelvis: Frame;
  chest: Frame;
  head: Frame;
  /** the direction of the spine (pelvis to neck) */
  spine: V3;
  toeL: V3;
  toeR: V3;
  /** forward directions of the feet */
  footL: V3;
  footR: V3;
}

export interface Pose {
  slot: number;
  color: RGB;
  css: string;
  spec: PersonSpec;
  joints: V3[];
  capsules: Capsule[];
  center: V3;
  F: V3;
  R: V3;
  speed: number;
  body: Body;
}

const UP: V3 = [0, 1, 0];
const STRIDE = 1.35; // m per full gait cycle (two steps)

/** position on the path at T: x, z, speed (m/s), direction, distance walked */
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
      const v = segLen > 0 ? (((segLen * Math.PI) / 2) * Math.sin(Math.PI * u)) / dur : 0;
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
  return smooth(a.t0, a.t0 + 0.5, T) * (1 - smooth(a.t1 - 0.5, a.t1, T));
}

/**
 * Upper arm and forearm (unit, chest frame) that bring the wrist to `target` (relative to the
 * shoulder, in units of the body scale), the elbow bending towards `pole`.
 */
function reachFor(target: V3, pole: V3): [V3, V3] {
  const a = 0.29;
  const b = 0.255;
  const dir = norm(target);
  const d = clamp(Math.hypot(target[0], target[1], target[2]), a - b + 0.02, a + b - 0.01);
  const cos = (a * a + d * d - b * b) / (2 * a * d);
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
  const k = pole[0] * dir[0] + pole[1] * dir[1] + pole[2] * dir[2];
  const side = norm([pole[0] - dir[0] * k, pole[1] - dir[1] * k, pole[2] - dir[2] * k]);
  const upper: V3 = [dir[0] * cos + side[0] * sin, dir[1] * cos + side[1] * sin, dir[2] * cos + side[2] * sin];
  const fore = norm([dir[0] * d - upper[0] * a, dir[1] * d - upper[1] * a, dir[2] * d - upper[2] * a]);
  return [upper, fore];
}

/** arm in the chest frame for a gesture: upper arm and forearm as [outwards, up, forward] */
function actionArm(a: Action, T: number, slot: number): [V3, V3] {
  const t = T - a.t0;
  switch (a.kind) {
    case 'wave': {
      // the elbow out at about shoulder height, the forearm up, the hand waving beside the head
      const w = Math.sin(2 * Math.PI * 1.4 * t + slot);
      return [[0.94, 0.26, 0.06], [0.16 + 0.42 * w, 1, 0.04]];
    }
    case 'raise': {
      // both arms up in a V (cheering)
      const w = 0.05 * Math.sin(2 * Math.PI * 0.7 * t + slot);
      return [[0.42, 0.9, 0.04 + w], [0.24, 1, 0.02]];
    }
    case 'out': {
      // arms out to the sides
      const w = 0.07 * Math.sin(2 * Math.PI * 0.55 * t);
      return [[1, 0.08 + w, 0.06], [1, 0.18 + w, 0.1]];
    }
    case 'circle': {
      // the hands draw circles beside the body, parallel to the wall, the elbows bent and down
      const ph = 2 * Math.PI * 0.55 * t + slot * 0.6;
      return reachFor([0.36 + 0.14 * Math.cos(ph), -0.02 + 0.14 * Math.sin(ph), 0.12], [0.25, -1, -0.35]);
    }
    case 'reach': {
      // one arm up beside the head, the elbow a little bent
      const w = 0.08 * Math.sin(2 * Math.PI * 0.75 * t);
      return [[0.5 + w, 0.86, 0], [0.22, 1, 0]];
    }
  }
}

const mix = (a: V3, b: V3, w: number): V3 => [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
/** a horizontal frame turned by an angle around the vertical */
function turned(f: Frame, a: number): Frame {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return {
    r: [f.r[0] * c - f.f[0] * s, 0, f.r[2] * c - f.f[2] * s],
    u: UP,
    f: [f.f[0] * c + f.r[0] * s, 0, f.f[2] * c + f.r[2] * s],
  };
}
/** a frame with this up direction, keeping its forward as close as possible */
function withUp(f: Frame, up: V3): Frame {
  const u = norm(up);
  const r = norm(cross(f.f, u));
  return { r, u, f: cross(u, r) };
}

/** the pose of one person at time T (null while not in the room) */
export function pose(spec: PersonSpec, T: number): Pose | null {
  const p = spec.path;
  if (T < p[0].t - 0.001) return null;
  const k = spec.height / 1.75;
  const at = onPath(p, T);
  const amp = clamp(at.v / 1.15);
  const walking = smooth(0.06, 0.45, at.v);

  // facing: towards the wall when standing, along the way when walking
  const thWall = 0.1 * Math.sin(0.27 * T + spec.slot * 1.7);
  const thWalk = Math.atan2(at.dx, -at.dz);
  let d = thWalk - thWall;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const th = thWall + d * walking * 0.9;
  const base: Frame = { r: [Math.cos(th), 0, Math.sin(th)], u: UP, f: [Math.sin(th), 0, -Math.cos(th)] };
  const phase = (2 * Math.PI * at.dist) / STRIDE + spec.slot * 1.3;

  // standing: the weight on one leg, now and then on the other
  const weight = Math.tanh(2.5 * Math.sin(0.33 * T + spec.slot * 2.3)) * (1 - walking); // -1 left .. 1 right
  const breathe = Math.sin(1.7 * T + spec.slot);

  // the pelvis turns with the legs, the chest against it
  const pelvisF = turned(base, 0.09 * amp * Math.sin(phase));
  const chestTwist = -0.1 * amp * Math.sin(phase);

  // legs: hip flexion, knee bend in the swing, foot roll
  const thigh = 0.44 * k;
  const shin = 0.42 * k;
  const ankleH = 0.075 * k;
  const legs = [phase, phase + Math.PI].map((ph, i) => {
    const side = i === 0 ? -1 : 1;
    const hip = 0.4 * amp * Math.sin(ph);
    const swing = Math.max(0, Math.cos(ph + 0.35));
    // the free knee bends, the standing one stays straight; when the weight shifts they trade over
    // the moment it takes (not in one frame)
    const idleBend = (1 - walking) * (0.03 + 0.19 * smooth(0.3, -0.3, weight * side));
    const knee = amp * (0.07 + 0.95 * swing * swing) + idleBend;
    const foot = amp * 0.35 * Math.sin(ph - 0.5) - idleBend * 0.4;
    // in the pelvis frame: [out, up, forward]
    const kneeP: V3 = [0, -Math.cos(hip) * thigh, Math.sin(hip) * thigh];
    const ankleP: V3 = [0, kneeP[1] - Math.cos(hip - knee) * shin, kneeP[2] + Math.sin(hip - knee) * shin];
    return { kneeP, ankleP, foot, side };
  });
  // the standing hip is higher, the free one sinks a little
  const tilt = 0.035 * weight;
  const lowest = Math.min(legs[0].ankleP[1] - tilt, legs[1].ankleP[1] + tilt);
  const bounce = 0.012 * amp * Math.cos(2 * phase);
  const shift = 0.035 * weight + 0.018 * amp * Math.sin(phase);
  const pelvis: V3 = [at.x + base.r[0] * shift, ankleH - lowest + bounce, at.z + base.r[2] * shift];
  const hipW = (spec.female ? 0.1 : 0.095) * k;
  const lHip = local(pelvis, pelvisF.r, UP, pelvisF.f, -hipW, -tilt, 0);
  const rHip = local(pelvis, pelvisF.r, UP, pelvisF.f, hipW, tilt, 0);
  const leg = (hip: V3, l: (typeof legs)[number]) => {
    const knee = local(hip, pelvisF.r, UP, pelvisF.f, l.side * 0.01, l.kneeP[1], l.kneeP[2]);
    const ankle = local(hip, pelvisF.r, UP, pelvisF.f, l.side * 0.012, l.ankleP[1], l.ankleP[2]);
    const fd = norm([pelvisF.f[0] * Math.cos(l.foot) + l.side * pelvisF.r[0] * 0.12, Math.sin(l.foot), pelvisF.f[2] * Math.cos(l.foot) + l.side * pelvisF.r[2] * 0.12]);
    const toe = add(add(ankle, fd, 0.15 * k), UP, -0.05 * k);
    return { knee, ankle, toe, fd };
  };
  const L = leg(lHip, legs[0]);
  const Rl = leg(rHip, legs[1]);

  // spine and chest
  const twist = chestTwist;
  const lean = 0.05 * amp + 0.015 * breathe * (1 - walking);
  const spineTop = local(pelvis, base.r, UP, base.f, -0.02 * weight, 0.5 * k, lean);
  const spine = norm([spineTop[0] - pelvis[0], spineTop[1] - pelvis[1], spineTop[2] - pelvis[2]]);
  const chest = withUp(turned(base, twist), spine);
  const neck = spineTop;
  const shoulderW = (spec.female ? 0.175 : 0.19) * k;
  const lSh = local(neck, chest.r, chest.u, chest.f, -shoulderW, -0.04 * k, -0.01);
  const rSh = local(neck, chest.r, chest.u, chest.f, shoulderW, -0.04 * k, -0.01);

  // arms: hanging with a slight bend, swinging against the legs, gestures on top
  const arms = (['L', 'R'] as const).map((side, i) => {
    const sign = side === 'L' ? -1 : 1;
    const legPh = i === 0 ? phase : phase + Math.PI;
    const swing = -0.36 * amp * Math.sin(legPh) + 0.03 * Math.sin(0.8 * T + i * 1.7) * (1 - walking);
    const bend = 0.22 + 0.32 * amp * Math.max(0, Math.sin(-legPh));
    // hanging a little away from the body, so the hands clear the hips
    const out = spec.female ? 0.16 : 0.14;
    let up: V3 = [out, -Math.cos(swing), Math.sin(swing)];
    let fo: V3 = [out + 0.05, -Math.cos(swing + bend), Math.sin(swing + bend)];
    let lift = 0;
    for (const a of spec.actions) {
      if (a.side !== 'B' && a.side !== side) continue;
      const w = actionWeight(a, T);
      if (w <= 0) continue;
      const [au, af] = actionArm(a, T, spec.slot + i * 0.7);
      up = mix(up, norm(au), w);
      fo = mix(fo, norm(af), w);
      // into and out of a gesture the arm moves through the side, not through the front; going out
      // to the side also keeps the forearm from flipping over when it turns from down to up
      const via = 4 * w * (1 - w);
      const mid = 1 - 0.75 * via;
      up[2] *= mid;
      fo[2] *= mid;
      up[0] += 0.6 * via;
      fo[0] += 0.9 * via;
      lift = Math.max(lift, w * Math.max(0, norm(au)[1]));
    }
    const toWorld = (v: V3): V3 => {
      const n = norm(v);
      return norm([chest.r[0] * n[0] * sign + chest.u[0] * n[1] + chest.f[0] * n[2], chest.r[1] * n[0] * sign + chest.u[1] * n[1] + chest.f[1] * n[2], chest.r[2] * n[0] * sign + chest.u[2] * n[1] + chest.f[2] * n[2]]);
    };
    const sh0 = side === 'L' ? lSh : rSh;
    const sh = add(sh0, chest.u, 0.035 * lift * k); // the shoulder rises with the arm
    const ud = toWorld(up);
    const fd = toWorld(fo);
    const elbow = add(sh, ud, 0.29 * k);
    const wrist = add(elbow, fd, 0.255 * k);
    const hand = add(wrist, fd, 0.085 * k);
    return { sh, elbow, wrist, hand };
  });

  // the head looks around a little, ahead while walking
  const look = 0.25 * Math.sin(0.41 * T + spec.slot * 2.1) * (1 - walking) + 0.05 * Math.sin(1.3 * T + spec.slot);
  const nod = 0.06 * walking + 0.04 * Math.sin(0.53 * T + spec.slot * 0.7);
  const fH = norm([chest.f[0], 0, chest.f[2]]);
  const level = turned({ r: norm(cross(fH, UP)), u: UP, f: fH }, look);
  const c = Math.cos(nod);
  const s = Math.sin(nod);
  const head: Frame = { r: level.r, u: [level.f[0] * s, c, level.f[2] * s], f: [level.f[0] * c, -s, level.f[2] * c] };
  const headC = add(add(neck, chest.u, 0.165 * k), chest.f, 0.015 * k);
  const nose = local(headC, head.r, head.u, head.f, 0, -0.02 * k, 0.1 * k);
  const lEye = local(headC, head.r, head.u, head.f, -0.033 * k, 0.025 * k, 0.085 * k);
  const rEye = local(headC, head.r, head.u, head.f, 0.033 * k, 0.025 * k, 0.085 * k);
  const lEar = local(headC, head.r, head.u, head.f, -0.075 * k, 0, 0);
  const rEar = local(headC, head.r, head.u, head.f, 0.075 * k, 0, 0);

  const joints: V3[] = [
    nose, lEye, rEye, lEar, rEar,
    arms[0].sh, arms[1].sh, arms[0].elbow, arms[1].elbow, arms[0].wrist, arms[1].wrist,
    lHip, rHip, L.knee, Rl.knee, L.ankle, Rl.ankle,
    neck, pelvis, headC, arms[0].hand, arms[1].hand,
  ];

  // a coarse body of capsules for the fluid (arms at 5..10)
  const capsules: Capsule[] = [
    { a: headC, b: headC, r: 0.1 * k },
    { a: neck, b: headC, r: 0.05 * k },
    { a: lSh, b: lHip, r: 0.1 * k },
    { a: rSh, b: rHip, r: 0.1 * k },
    { a: neck, b: pelvis, r: 0.12 * k },
    { a: arms[0].sh, b: arms[0].elbow, r: 0.048 * k },
    { a: arms[1].sh, b: arms[1].elbow, r: 0.048 * k },
    { a: arms[0].elbow, b: arms[0].wrist, r: 0.04 * k },
    { a: arms[1].elbow, b: arms[1].wrist, r: 0.04 * k },
    { a: arms[0].wrist, b: arms[0].hand, r: 0.036 * k },
    { a: arms[1].wrist, b: arms[1].hand, r: 0.036 * k },
    { a: lHip, b: L.knee, r: 0.075 * k },
    { a: rHip, b: Rl.knee, r: 0.075 * k },
    { a: L.knee, b: L.ankle, r: 0.052 * k },
    { a: Rl.knee, b: Rl.ankle, r: 0.052 * k },
    { a: L.ankle, b: L.toe, r: 0.04 * k },
    { a: Rl.ankle, b: Rl.toe, r: 0.04 * k },
  ];
  const css = PERSON_COLORS[spec.slot] ?? '#ffffff';
  return {
    slot: spec.slot,
    color: hexRgb(css),
    css,
    spec,
    joints,
    capsules,
    center: local(pelvis, base.r, UP, base.f, 0, 0.25 * k, 0),
    F: base.f,
    R: base.r,
    speed: at.v,
    body: { k, pelvis: pelvisF, chest, head, spine, toeL: L.toe, toeR: Rl.toe, footL: L.fd, footR: Rl.fd },
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
