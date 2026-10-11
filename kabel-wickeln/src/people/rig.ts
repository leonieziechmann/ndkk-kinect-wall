// Rigs: a pose from targets in world space. Two-bone IK for arms and legs (standing, squatting with a
// straight back, kneeling on one knee, sitting), the head looking at a point, the spine leaning and
// twisting, hands that close around a cable at a grip frame (or are placed freely), and walking along
// waypoints (the erklaervideo gait). Keyframe helpers make choreographies short: every rig is a pure
// function of the shot time, so scrubbing works.
//
// Grip frame (shared with the cable simulation): p on the cable axis in the middle of the fist,
// columns of q: d1 from the cable axis towards the palm, d2 = d3 × d1, d3 along the cable.

import {
  V3, Quat, add, across, clamp, cross, dot, easeInOut, len, lerp, local, madd, mix3, norm, quatAxisAngle, quatCols, quatFromCols, quatMul, scale, slerp, smooth, sub, turn,
} from './math';
import { Body, Frame, HandPose, Pose, PersonSpec, UP, withUp, yawFrame } from './people';
import { FIST_SLOPE, FIST_Z, fistAround, freeThumb, thumbTargets } from './body/hand';

/** a grip frame: position on the cable axis and orientation (d1 to the palm, d3 along the cable) */
export interface Grip {
  p: V3;
  q: Quat;
}

/** a grip frame from a point, the cable direction and the direction from the cable to the palm */
export function gripFrame(p: V3, along: V3, toPalm: V3): Grip {
  const d3 = norm(along);
  const d1 = across(toPalm, d3);
  return { p, q: quatFromCols(d1, cross(d3, d1), d3) };
}

/** the grip frame turned about its cable direction d3 (rolling the cable in the fist), rad */
export function rollGrip(g: Grip, angle: number): Grip {
  return { p: g.p, q: quatMul(g.q, quatAxisAngle([0, 0, 1], angle)) };
}

/** a hand: closed around a cable (grip) or free (wrist, finger direction, palm normal) */
export interface HandRig {
  grip?: Grip;
  /** radius of what the hand holds, m (a cable, or a bundle of loops); default 3.5 mm (XLR) */
  radius?: number;
  /** grip: the thumb points along +d3 (1, default) or -d3 (-1) */
  thumbAlong?: 1 | -1;
  /** grip: 0 closed around the cable … 1 fingers open (letting it slide or go) */
  open?: number;
  /** grip: thumb lying along the cable (0) … wrapped over the fingers (1) */
  wrap?: number;
  /** thumb on the side of the index finger (rolling the cable between them), 0 … 1 */
  pinch?: number;
  /** free hand: the wrist */
  wrist?: V3;
  /** free hand: wrist → knuckles (default: along the forearm) */
  dir?: V3;
  /** free hand: out of the palm (default: natural for the forearm) */
  palm?: V3;
  /** free hand: finger curl 0 … 1 (default 0.25, relaxed) */
  curl?: number;
  /** the direction the elbow points to (default: natural for the hand) */
  elbow?: V3;
}

/** a standing leg: ankle and foot direction (heel → toes); or a kneeling one: the knee on the floor */
export type LegRig = { ankle: V3; dir: V3; knee?: V3 } | { kneel: V3 };

export interface Rig {
  /** the pelvis over the floor: x, z */
  pos: [number, number];
  /** facing: 0 = towards -z, positive turns right */
  yaw: number;
  /** the pelvis this far below its standing height (it also sinks by itself when the feet are far apart) */
  drop?: number;
  /** forward lean of the spine, rad (from the hips, the back stays straight) */
  lean?: number;
  /** sideways lean of the spine, rad (+ towards the right) */
  bend?: number;
  /** the chest turned against the pelvis, rad */
  twist?: number;
  /** the pelvis turned against the facing, rad */
  hipTurn?: number;
  /** the head looks at this point (limited to what a neck can do) */
  look?: V3;
  /** left, right: null hangs at the side */
  hands: [HandRig | null, HandRig | null];
  /** left, right */
  feet: [LegRig, LegRig];
  /** hanging arms swing forward by this angle (rad), left and right */
  swing?: [number, number];
  /** moves the shoulders (world, m): the first-person view cheats them forward and in */
  shoulders?: [V3, V3];
}

/** two-bone IK in world space: the middle joint bends towards `pole` (a direction) */
export function twoBone(root: V3, target: V3, a: number, b: number, pole: V3) {
  const d0 = sub(target, root);
  const dir = norm(d0);
  const d = clamp(len(d0), Math.abs(a - b) + 1e-3, a + b - 1e-4);
  const cos = (a * a + d * d - b * b) / (2 * a * d);
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
  let side = madd(pole, dir, -dot(pole, dir));
  if (len(side) < 1e-6) side = cross(dir, Math.abs(dir[1]) < 0.9 ? UP : [1, 0, 0]);
  side = norm(side);
  return { mid: add(root, add(scale(dir, a * cos), scale(side, a * sin))), end: madd(root, dir, d) };
}

const rotY = (v: V3, a: number): V3 => turn(v, UP, a);

// ---------------------------------------------------------------- hands

/** the hand that closes around a cable at a grip frame; side -1 left, +1 right */
export function handFromGrip(spec: PersonSpec, side: number, h: HandRig & { grip: Grip }): HandPose {
  const q = (spec.height / 1.75) * spec.build.hands;
  const r = h.radius ?? 0.0035;
  const [d1, , d3] = quatCols(h.grip.q);
  const palm = scale(d1, -1);
  const along = scale(d3, h.thumbAlong ?? 1);
  // the cable crosses the hand along the slanted line of the knuckles
  const b = Math.atan(FIST_SLOPE);
  const fd0 = scale(cross(palm, along), side);
  const fd = add(scale(fd0, Math.cos(b)), scale(along, Math.sin(b)));
  const w = add(scale(fd0, -Math.sin(b)), scale(along, Math.cos(b)));
  const fist = fistAround(r / q);
  const open = clamp(h.open ?? 0);
  const curl = fist.curl.map((c) => c * (1 - 0.75 * open)) as HandPose['curl'];
  const tt = thumbTargets(fist, r / q);
  const thumb = mix3(mix3(tt.along, tt.wrap, clamp(h.wrap ?? 0)), tt.pinch, clamp(h.pinch ?? 0));
  // open fingers let go: the thumb lifts off too
  const lifted = mix3(thumb, add(thumb, [0, -0.012, 0.01]), open);
  const wrist = madd(madd(madd(h.grip.p, fd, -fist.gx * q), palm, -fist.gy * q), w, -FIST_Z * q);
  return { wrist, fd, palm, curl, spread: 0, thumb: lifted, q };
}

/** a relaxed or curled free hand; fd and palm are made orthonormal */
function freeHand(q: number, wrist: V3, fd: V3, palm: V3, curl: number, pinch: number): HandPose {
  const c = clamp(curl);
  const p = clamp(pinch);
  // a pinch curls the index finger towards the thumb
  const index = lerp(c * 0.92, Math.max(c, 0.6), p);
  return { wrist, fd, palm: across(palm, fd), curl: [index, c, c * 1.04, c * 1.1].map((x) => clamp(x)) as HandPose['curl'], spread: 0.15 * (1 - p), thumb: freeThumb(c, p, index), q };
}

/** the palm of a hand on a forearm when nobody says otherwise: hanging it faces the thigh, raised the front */
function naturalPalm(fd: V3, chest: Frame, side: number): V3 {
  const raise = clamp((dot(fd, chest.u) + 0.35) / 1.1);
  const medial = scale(chest.r, -side);
  const w = across(mix3(chest.f, medial, raise), fd);
  return scale(cross(w, fd), side);
}

// ---------------------------------------------------------------- the pose

/** the pose for a rig */
export function rigPose(spec: PersonSpec, g: Rig): Pose {
  const B = spec.build;
  const k = spec.height / 1.75;
  const q = k * B.hands;
  const thigh = 0.44 * k;
  const shin = 0.42 * k;
  const base = yawFrame(g.yaw);
  const lean = g.lean ?? 0;
  const bend = g.bend ?? 0;
  const spine = norm([
    UP[0] * Math.cos(lean) + base.f[0] * Math.sin(lean) + base.r[0] * Math.sin(bend),
    Math.cos(lean) * Math.cos(bend),
    UP[2] * Math.cos(lean) + base.f[2] * Math.sin(lean) + base.r[2] * Math.sin(bend),
  ]);
  // the pelvis tilts half as far as the spine: no sheared torso
  const pelvisF = withUp(rotY(base.f, g.hipTurn ?? 0), add(UP, spine));
  const hipW = 0.095 * k * B.hips;

  // pelvis height: standing minus drop, lower where a foot could not be reached, fixed by a kneeling knee
  let py = 0.935 * k - (g.drop ?? 0);
  const at = (y: number, s: number) => local([g.pos[0], y, g.pos[1]], pelvisF.r, pelvisF.u, pelvisF.f, s * hipW, 0, 0);
  g.feet.forEach((ft, i) => {
    const hip = at(0, i ? 1 : -1);
    if ('kneel' in ft) {
      const hx = Math.hypot(ft.kneel[0] - hip[0], ft.kneel[2] - hip[2]);
      py = ft.kneel[1] + Math.sqrt(Math.max(0, thigh * thigh - hx * hx)) - hip[1];
    } else {
      const reach = 0.997 * (thigh + shin);
      const hx = Math.hypot(ft.ankle[0] - hip[0], ft.ankle[2] - hip[2]);
      py = Math.min(py, ft.ankle[1] + Math.sqrt(Math.max(0, reach * reach - hx * hx)) - hip[1]);
    }
  });
  const pelvis: V3 = [g.pos[0], py, g.pos[1]];
  const hips = [at(py, -1), at(py, 1)];

  const legs = g.feet.map((ft, i) => {
    const s = i ? 1 : -1;
    if ('kneel' in ft) {
      // thigh to the knee on the floor, the shin flat behind it, toes tucked under
      const knee = madd(hips[i], norm(sub(ft.kneel, hips[i])), thigh);
      const back = scale(base.f, -1);
      const dy = 0.1 * k;
      const ankle = madd(madd(knee, back, Math.sqrt(shin * shin - dy * dy)), UP, dy);
      return { knee, ankle, fd: norm(madd(scale(base.f, 0.78), UP, -0.62)) };
    }
    const pole = ft.knee ?? madd(base.f, base.r, 0.15 * s);
    const ik = twoBone(hips[i], ft.ankle, thigh, shin, pole);
    return { knee: ik.mid, ankle: ik.end, fd: norm(ft.dir) };
  });
  const toe = (l: (typeof legs)[number]) => madd(madd(l.ankle, l.fd, 0.15 * k), UP, -0.05 * k);

  // spine, chest, shoulders
  const neck = madd(pelvis, spine, 0.5 * k);
  const chest = withUp(rotY(base.f, g.twist ?? 0), spine);
  const shW = 0.19 * k * B.shoulders;

  const arms = g.hands.map((h, i) => {
    const s = i ? 1 : -1;
    const sh0 = add(local(neck, chest.r, chest.u, chest.f, s * shW, -0.04 * k, -0.01), g.shoulders?.[i] ?? [0, 0, 0]);
    if (!h) {
      // hanging, a little away from the body, swinging
      const sw = g.swing?.[i] ?? 0;
      const bendE = 0.22 + 0.9 * Math.max(0, sw);
      const out = 0.14 + 0.02 * (B.hips - B.shoulders) * 5;
      const ud = norm(local([0, 0, 0], chest.r, chest.u, chest.f, out * s, -Math.cos(sw), Math.sin(sw)));
      const fdA = norm(local([0, 0, 0], chest.r, chest.u, chest.f, (out + 0.05) * s, -Math.cos(sw + bendE), Math.sin(sw + bendE)));
      const elbow = madd(sh0, ud, 0.29 * k);
      const wrist = madd(elbow, fdA, 0.255 * k);
      return { sh: sh0, elbow, wrist, hand: freeHand(q, wrist, fdA, naturalPalm(fdA, chest, s), 0.25, 0) };
    }
    const target = h.grip ? handFromGrip(spec, s, { ...h, grip: h.grip }) : null;
    const wristT = target ? target.wrist : (h.wrist ?? madd(sh0, chest.u, -0.5 * k));
    const fdT = target ? target.fd : h.dir ? norm(h.dir) : null;
    const solve = (sh: V3) => {
      // the elbow goes where the forearm continues the hand, a little down and out
      let pole = h.elbow;
      if (!pole) {
        const ideal = fdT ? madd(wristT, fdT, -0.255 * k) : madd(madd(sh, chest.u, -0.25 * k), chest.r, 0.1 * k * s);
        pole = add(norm(sub(ideal, sh)), scale(add(scale(chest.u, -1), scale(chest.r, 0.35 * s)), 0.35));
      }
      return twoBone(sh, wristT, 0.29 * k, 0.255 * k, pole);
    };
    // the shoulder rises and comes forward with the arm, then the arm is solved again
    const first = solve(sh0);
    const ud = norm(sub(first.mid, sh0));
    const sh = madd(madd(sh0, chest.u, 0.035 * k * Math.max(0, dot(ud, chest.u) + 0.2)), chest.f, 0.025 * k * Math.max(0, dot(ud, chest.f)));
    const ik = solve(sh);
    const fa = norm(sub(ik.end, ik.mid));
    let hand: HandPose;
    if (target) {
      // out of reach: the hand stays with the wrist
      hand = { ...target, wrist: ik.end };
    } else {
      const fd = fdT ?? fa;
      hand = freeHand(q, ik.end, fd, h.palm ?? naturalPalm(fd, chest, s), h.curl ?? 0.25, h.pinch ?? 0);
    }
    return { sh, elbow: ik.mid, wrist: ik.end, hand };
  });
  const knuckles = (hp: HandPose) => madd(hp.wrist, hp.fd, 0.093 * hp.q);

  // head: turns and nods towards the look point, within what a neck allows
  const pivot = local(neck, chest.r, chest.u, chest.f, 0, 0.1 * k, 0.01 * k);
  let head: Frame = chest;
  if (g.look) {
    const d = norm(sub(g.look, madd(pivot, chest.u, 0.065 * k)));
    const yaw = clamp(Math.atan2(dot(d, chest.r), dot(d, chest.f)), -1.2, 1.2);
    const pitch = clamp(Math.asin(clamp(dot(d, UP), -1, 1)), -1.0, 0.7);
    const hf0 = rotY(norm([chest.f[0], 0, chest.f[2]]), yaw);
    const hr = norm(cross(hf0, UP));
    const hf = norm(turn(hf0, hr, pitch));
    head = { r: hr, u: cross(hr, hf), f: hf };
  }
  const headC = local(pivot, head.r, head.u, head.f, 0, 0.065 * k, 0.005 * k);
  const face = (x: number, y: number, z: number) => local(headC, head.r, head.u, head.f, x * k, y * k, z * k);

  const joints: V3[] = [
    face(0, -0.02, 0.1), face(-0.033, 0.025, 0.085), face(0.033, 0.025, 0.085), face(-0.075, 0, 0), face(0.075, 0, 0),
    arms[0].sh, arms[1].sh, arms[0].elbow, arms[1].elbow, arms[0].wrist, arms[1].wrist,
    hips[0], hips[1], legs[0].knee, legs[1].knee, legs[0].ankle, legs[1].ankle,
    neck, pelvis, headC, knuckles(arms[0].hand), knuckles(arms[1].hand),
  ];
  const body: Body = {
    k,
    pelvis: pelvisF,
    chest,
    head,
    spine,
    toeL: toe(legs[0]),
    toeR: toe(legs[1]),
    footL: legs[0].fd,
    footR: legs[1].fd,
    hands: [arms[0].hand, arms[1].hand],
  };
  return { spec, joints, body, F: base.f, R: base.r };
}

// ---------------------------------------------------------------- stances

type Stance = Pick<Rig, 'pos' | 'yaw' | 'feet' | 'drop' | 'lean'>;
const footAt = (k: number, pos: [number, number], fr: Frame, x: number, f: number, out: number) => ({
  ankle: local([pos[0], 0.075 * k, pos[1]], fr.r, UP, fr.f, x, 0, f),
  dir: rotY(fr.f, out),
});

/** standing at pos facing yaw; feet `width` apart (m), turned out, one foot `stagger` ahead (+ left) */
export function stand(spec: PersonSpec, pos: [number, number], yaw: number, o: { width?: number; out?: number; stagger?: number } = {}): Stance {
  const k = spec.height / 1.75;
  const fr = yawFrame(yaw);
  const w = (o.width ?? 0.24 * k) / 2;
  const out = o.out ?? 0.12;
  const st = (o.stagger ?? 0) / 2;
  return { pos, yaw, feet: [footAt(k, pos, fr, -w, st, -out), footAt(k, pos, fr, w, -st, out)] };
}

/** squatting with heels down and a straight back, depth 0 (standing) … 1 (deep); the feet stay at pos */
export function squat(spec: PersonSpec, pos: [number, number], yaw: number, depth: number): Stance {
  const k = spec.height / 1.75;
  const fr = yawFrame(yaw);
  const d = clamp(depth);
  // the pelvis goes back as it goes down, the back leans forward to keep the balance over the feet
  const hp = local([pos[0], 0, pos[1]], fr.r, UP, fr.f, 0, 0, -0.16 * k * d);
  const w = lerp(0.12, 0.18, d) * k;
  const out = lerp(0.12, 0.38, d);
  const knee = (s: number): V3 => norm(madd(fr.f, fr.r, 0.45 * s));
  return {
    pos: [hp[0], hp[2]],
    yaw,
    drop: 0.5 * k * d,
    lean: 0.62 * d,
    feet: [
      { ...footAt(k, pos, fr, -w, 0.02 * k, -out), knee: knee(-1) },
      { ...footAt(k, pos, fr, w, 0.02 * k, out), knee: knee(1) },
    ],
  };
}

/** kneeling on one knee ('L' or 'R' on the floor), the other foot flat in front */
export function kneel(spec: PersonSpec, pos: [number, number], yaw: number, down: 'L' | 'R'): Stance {
  const k = spec.height / 1.75;
  const fr = yawFrame(yaw);
  const s = down === 'L' ? -1 : 1;
  const knee = local([pos[0], 0.05 * k, pos[1]], fr.r, UP, fr.f, s * 0.1 * k, 0, -0.04 * k);
  const front = { ...footAt(k, pos, fr, -s * 0.12 * k, 0.43 * k, -s * 0.1), knee: madd(fr.f, UP, 0.3) };
  return { pos, yaw, lean: 0.08, feet: s < 0 ? [{ kneel: knee }, front] : [front, { kneel: knee }] };
}

/** sitting on a seat of this height (m, e.g. a wheelchair 0.5), feet on a footrest in front */
export function seated(spec: PersonSpec, pos: [number, number], yaw: number, seat = 0.5, footrest = 0.1): Stance {
  const k = spec.height / 1.75;
  const fr = yawFrame(yaw);
  const hipY = seat + 0.075 * k;
  const knee = madd(fr.f, UP, 0.6);
  const foot = (x: number, out: number) => ({
    ankle: local([pos[0], footrest + 0.075 * k, pos[1]], fr.r, UP, fr.f, x, 0, 0.43 * k),
    dir: norm(madd(rotY(fr.f, out), UP, -0.15)),
    knee,
  });
  return { pos, yaw, drop: 0.935 * k - hipY, lean: -0.06, feet: [foot(-0.11 * k, -0.08), foot(0.11 * k, 0.08)] };
}

// ---------------------------------------------------------------- walking

export interface Waypoint {
  /** arrive here at time t (walking from the previous waypoint) */
  t: number;
  x: number;
  z: number;
  /** facing while standing here (default: the way the person came) */
  yaw?: number;
}

const STRIDE = 1.35; // m per full gait cycle (two steps)

/** position on the path at T: x, z, speed (m/s), the way's direction, distance walked, facing */
function onPath(path: Waypoint[], T: number) {
  let dist = 0;
  let yaw = path[0].yaw ?? 0;
  if (T <= path[0].t) return { x: path[0].x, z: path[0].z, v: 0, wayYaw: yaw, dist: 0, yaw, u: 0 };
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    const wayYaw = segLen > 0 ? Math.atan2(b.x - a.x, -(b.z - a.z)) : yaw;
    if (T < b.t) {
      const dur = b.t - a.t;
      const u = clamp((T - a.t) / dur);
      const s = (1 - Math.cos(Math.PI * u)) / 2;
      const v = segLen > 0 ? (((segLen * Math.PI) / 2) * Math.sin(Math.PI * u)) / dur : 0;
      const stand = u < 0.5 ? (a.yaw ?? wayYaw) : (b.yaw ?? wayYaw);
      return { x: a.x + (b.x - a.x) * s, z: a.z + (b.z - a.z) * s, v, wayYaw, dist: dist + segLen * s, yaw: stand, u };
    }
    dist += segLen;
    yaw = b.yaw ?? wayYaw;
  }
  const last = path[path.length - 1];
  return { x: last.x, z: last.z, v: 0, wayYaw: yaw, dist, yaw, u: 1 };
}

/** shortest signed angle from a to b */
const angleTo = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/**
 * Walking along waypoints (the erklaervideo gait: hip, knee and foot roll, the pelvis turning with the
 * legs and the chest against it, a little bounce, swinging arms). Standing, the weight rests on one
 * leg and shifts now and then. Override `hands` for carrying.
 */
export function walk(spec: PersonSpec, path: Waypoint[], T: number, seed = 0): Rig {
  const k = spec.height / 1.75;
  const at = onPath(path, T);
  const amp = clamp(at.v / 1.15);
  const walking = smooth(0.06, 0.45, at.v);
  const th = at.yaw + angleTo(at.yaw, at.wayYaw) * walking;
  const base = yawFrame(th);
  const phase = (2 * Math.PI * at.dist) / STRIDE + seed * 1.3;
  const weight = Math.tanh(2.5 * Math.sin(0.33 * T + seed * 2.3)) * (1 - walking); // -1 left … 1 right
  const hipTurn = 0.09 * amp * Math.sin(phase);
  const pf = { r: rotY(base.r, hipTurn), f: rotY(base.f, hipTurn) };
  const thigh = 0.44 * k;
  const shin = 0.42 * k;
  const legs = [phase, phase + Math.PI].map((ph, i) => {
    const s = i === 0 ? -1 : 1;
    const hip = 0.4 * amp * Math.sin(ph);
    const swing = Math.max(0, Math.cos(ph - 0.15));
    const idle = (1 - walking) * (0.03 + 0.19 * smooth(0.3, -0.3, weight * s));
    const knee = amp * (0.07 + 0.85 * swing * swing) + idle;
    const foot = amp * 0.35 * Math.sin(ph - 0.5) - idle * 0.4;
    const ky = -Math.cos(hip) * thigh;
    const kz = Math.sin(hip) * thigh;
    return { s, foot, ay: ky - Math.cos(hip - knee) * shin, az: kz + Math.sin(hip - knee) * shin };
  });
  const lowest = Math.min(legs[0].ay, legs[1].ay);
  const bounce = 0.012 * amp * Math.cos(2 * phase);
  const shift = 0.035 * weight + 0.018 * amp * Math.sin(phase);
  const pelvis: V3 = [at.x + base.r[0] * shift, 0.075 * k - lowest + bounce, at.z + base.r[2] * shift];
  const hipW = 0.095 * k * spec.build.hips;
  const feet = legs.map((l) => {
    const hipP = madd(pelvis, pf.r, l.s * hipW);
    const ankle = add(add(madd(hipP, pf.r, l.s * 0.012), [0, l.ay, 0]), scale(pf.f, l.az));
    const dir = norm([pf.f[0] * Math.cos(l.foot) + l.s * pf.r[0] * 0.12, Math.sin(l.foot), pf.f[2] * Math.cos(l.foot) + l.s * pf.r[2] * 0.12]);
    return { ankle, dir, knee: pf.f };
  }) as [LegRig, LegRig];
  const swingOf = (ph: number, i: number) => -0.36 * amp * Math.sin(ph) + 0.03 * Math.sin(0.8 * T + i * 1.7) * (1 - walking);
  return {
    pos: [pelvis[0], pelvis[2]],
    yaw: th,
    drop: 0.935 * k - pelvis[1],
    lean: 0.05 * amp + 0.015 * Math.sin(1.7 * T + seed) * (1 - walking),
    bend: -0.02 * weight,
    twist: -0.1 * amp * Math.sin(phase),
    hipTurn,
    hands: [null, null],
    feet,
    swing: [swingOf(phase, 0), swingOf(phase + Math.PI, 1)],
  };
}

// ---------------------------------------------------------------- keyframes

export type Ease = (t: number) => number;
/** time, value, and the ease of the way into this key (default: the track's) */
export type Key<T> = [number, T] | [number, T, Ease];

/**
 * A track through keys (sorted by time): numbers, points (V3) or rotations (Quat, slerped). Before
 * the first key it holds the first value, after the last the last. `ease` shapes every segment.
 */
export function keys(k: Key<number>[], ease?: Ease): (t: number) => number;
export function keys(k: Key<V3>[], ease?: Ease): (t: number) => V3;
export function keys(k: Key<Quat>[], ease?: Ease): (t: number) => Quat;
export function keys(k: Key<number | V3 | Quat>[], ease: Ease = easeInOut): (t: number) => number | V3 | Quat {
  const mixAny = (a: number | V3 | Quat, b: number | V3 | Quat, u: number) => {
    if (typeof a === 'number') return lerp(a, b as number, u);
    if (a.length === 4) return slerp(a, b as Quat, u);
    return mix3(a, b as V3, u);
  };
  return (t: number) => {
    if (t <= k[0][0]) return k[0][1];
    for (let i = 1; i < k.length; i++) {
      const b = k[i];
      if (t < b[0]) {
        const a = k[i - 1];
        const e = b[2] ?? ease;
        return mixAny(a[1], b[1], e((t - a[0]) / (b[0] - a[0])));
      }
    }
    return k[k.length - 1][1];
  };
}

/** a track of grip frames (position and orientation keyed together) */
export function gripKeys(k: Key<Grip>[], ease: Ease = easeInOut): (t: number) => Grip {
  const p = keys(k.map((x) => [x[0], x[1].p, x[2] ?? ease] as Key<V3>));
  const q = keys(k.map((x) => [x[0], x[1].q, x[2] ?? ease] as Key<Quat>));
  return (t) => ({ p: p(t), q: q(t) });
}
