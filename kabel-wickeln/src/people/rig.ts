// Rigs: a pose from targets in world space. Arms by inverse kinematics with real joints and ranges
// (ik.ts: clavicle, shoulder, elbow, forearm twist, wrist), legs by two-bone IK (standing, squatting
// with a straight back, kneeling on one knee, sitting), the head looking at a point, the spine
// leaning and twisting, hands that hold a cable at a grip frame (a fist, a thumb-index pinch, a coil
// in the hook of the fingers) or are placed freely, and walking along waypoints (the erklaervideo
// gait). Keyframe helpers make choreographies short: every rig is a pure function of the shot time.
//
// Solving over time: RigTrack(spec, rigAt) solves a choreography once, in order, with the stateful IK
// and samples it at any time. Bake and scene each build one with the same arguments and get exactly
// the same arms: the simulation's grip frames and hand capsules come from track.pose(t) at every
// substep, the scene draws track.pose(t). rigPose(spec, rig) alone is stateless (stills, sheets);
// with a RigIK it solves frame by frame (a rig that depends on the running simulation; store the
// angles in the bake and give them back to the scene as rigPose(…, fixed)).
//
// Grip frame (shared with the cable simulation): p on the cable axis in the middle of the hold,
// columns of q: d1 from the cable axis towards the hand (the palm in a fist and a coil grip, the
// index finger in a pinch), d2 = d3 × d1, d3 along the cable (a fist or coil: where the thumb points;
// a pinch: where the cable leaves past the thumb tip). The frames the hand really reaches are
// pose.body.arms[i].grip (the cable's frame: a pinch's roll included) and .pads (the hand's frame,
// without the roll). Give the simulation grip with PinchSpec.roll = 0, or pads with PinchSpec.roll =
// HandRig.roll, never both.

import {
  V3, Quat, add, across, clamp, cross, dot, easeInOut, len, lerp, local, madd, mix3, norm, quatAxisAngle, quatCols, quatFromCols, quatMul, scale, slerp, smooth, sub, turn,
} from './math';
import { ArmPose, Body, Frame, HandPose, Pose, PersonSpec, UP, withUp, yawFrame } from './people';
import { FIST_SLOPE, FIST_Z, GLOVE_EXTRA, GripShape, coilAround, fistAround, fistThumb, freeThumb, pinchAround, thumbChain } from './body/hand';
import { ARM_JOINTS, ArmAngles, ArmIK, ArmIKOptions, ArmSetup, ArmSolution, AxisGoal, HandTarget, armPose, evaluateArm, projectToLimits, solveArm, toLocal } from './ik';

/**
 * A grip frame: position on the cable axis and orientation (d1 to the hand, d3 along the cable). As
 * a HandRig.grip of a pinch it is the pads' frame (d1 to the index finger as at roll 0); the roll
 * turns only the cable inside it.
 */
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

/** the grip frame turned about its cable direction d3 (rolling the cable in the hand), rad */
export function rollGrip(g: Grip, angle: number): Grip {
  return { p: g.p, q: quatMul(g.q, quatAxisAngle([0, 0, 1], angle)) };
}

/**
 * A grip frame turned with the forearm: `g` turned by `supination` rad (+ supination: the palm turns
 * up and forward, a pinch's thumb tip outwards; − pronation) about the forearm's axis as the forearm
 * lies relative to the hand in `pose` (arm `side`, 0 left / 1 right), its point kept. The axis is
 * taken in g's own frame, so it moves with g: g may travel and change while the turn is keyed. The
 * way to key a turn the forearm makes (the under loop's turn-over): g = the frame a solved pose
 * reached (pose.body.arms[side].pads), key the angle, give the result with free: 0, and the IK turns
 * the forearm (and the shoulder and wrist as far as the forearm's range needs).
 */
export function turnWithForearm(pose: Pose, side: 0 | 1, g: Grip, supination: number): Grip {
  const arm = pose.body.arms?.[side];
  const ref = arm?.pads ?? arm?.grip;
  const a = arm?.forearm.dir ?? norm(sub(pose.joints[side ? 10 : 9], pose.joints[side ? 8 : 7]));
  if (!ref) return { p: g.p, q: quatMul(quatAxisAngle(a, (side ? 1 : -1) * supination), g.q) };
  // the forearm's axis in the reference frame's coordinates, then turned about in g's frame
  const [c1, c2, c3] = quatCols(ref.q);
  const local: V3 = [dot(a, c1), dot(a, c2), dot(a, c3)];
  return { p: g.p, q: quatMul(g.q, quatAxisAngle(local, (side ? 1 : -1) * supination)) };
}

/** how a hand holds its grip */
export type Hold = 'fist' | 'pinch' | 'coil';

/**
 * A hand: holding a cable (grip) or free (wrist, finger direction, palm normal). The arm follows by
 * itself (ik.ts); the elbow, the twist of the forearm and the wrist stay inside their ranges. What the
 * arm really reached is in pose.body.arms[i] (report: residual, limits hit; grip: the frame held).
 */
export interface HandRig {
  grip?: Grip;
  /**
   * grip: 'fist' (default) closes around the cable; 'pinch' holds it between the thumb pad and the
   * index finger, the cable crossing the thumb pad and leaving towards +d3 on the side the thumb
   * points to (body/hand.ts pinchAround); 'coil' holds a bundle of loops (radius = the bundle's) in
   * the hook of the fingers, the thumb along it
   */
  hold?: Hold;
  /** radius of what the hand holds, m (a cable, or a bundle of loops); default 3.5 mm (XLR) */
  radius?: number;
  /** fist and coil: the thumb points along +d3 (1, default) or -d3 (-1); a pinch's cable always leaves towards +d3 on the thumb's side */
  thumbAlong?: 1 | -1;
  /** grip: 0 closed … 1 open (a fist's fingers open, a pinch's thumb lifts: the cable slides or goes) */
  open?: number;
  /** fist: thumb lying along the cable (0) … wrapped over the fingers (1) */
  wrap?: number;
  /** fist and free hand: thumb on the side of the index finger, 0 … 1 */
  pinch?: number;
  /**
   * pinch: the cable rolled between thumb and index finger about +d3 (rad, up to about ±π/2): the
   * thumb slides along the index finger, the hand itself does not turn (whatever `free` is). The
   * reached arms[i].grip is turned by it, arms[i].pads is not.
   */
  roll?: number;
  /** pinch: the angle between the thumb and the cable (body/hand.ts PINCH_CROSS; 0 = the thumb lies along the cable) */
  cross?: number;
  /**
   * the thumb TIP should point this way (world direction; grips and free hands), e.g. towards the
   * coil. Not the same as an AxisGoal with hand [0, 0, 1]: that is the thumb SIDE of the hand, which
   * in a pinch is about 90° away from where the thumb tip points.
   */
  thumbTo?: V3;
  /** how much thumbTo counts (default 0.3: a wish that gives way to the grip and to comfort) */
  thumbWeight?: number;
  /**
   * grip: how freely the hand may turn about the cable (0 = exactly the grip frame, default; 1 = only
   * the cable's direction counts, the hand finds the most comfortable angle about it)
   */
  free?: number;
  /** extra orientation wishes for the hand (world directions of hand axes, with weights; ik.ts AxisGoal) */
  prefer?: AxisGoal[];
  /** free hand: the wrist */
  wrist?: V3;
  /** free hand: wrist → knuckles (default: whatever is most comfortable) */
  dir?: V3;
  /** free hand: out of the palm (default: whatever is most comfortable) */
  palm?: V3;
  /** free hand: finger curl 0 … 1 (default 0.25, relaxed) */
  curl?: number;
  /** the direction the elbow should point to (default: where it is most comfortable) */
  elbow?: V3;
  /** how much the elbow wish counts (default 1) */
  elbowWeight?: number;
  /** wishes for single joint angles of the arm (ik.ts ArmAngles, rad), e.g. { rot: 0.6 }: the upper arm turns out */
  joints?: Partial<ArmAngles>;
  /** how much they count per rad (default 1; 3 = firm) */
  jointWeight?: number;
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
  /** moves the shoulders (world, m) */
  shoulders?: [V3, V3];
  /**
   * 0 … 1: the upper body may help a hand that cannot reach its target, by leaning forward (up to
   * 0.3 rad), bending sideways (0.15) and turning (0.3), times this; default 0 (the hand stops short)
   */
  reach?: number;
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

/** hand size: height/1.75 · build.hands */
const handSize = (spec: PersonSpec) => (spec.height / 1.75) * spec.build.hands;

/**
 * The shape of a holding hand and where the held axis lies in it (hand frame, m): a fist (thumb along,
 * wrapped or pinching on the index), a thumb-index pinch, or a coil in the hook of the fingers.
 */
export function gripShape(spec: PersonSpec, side: number, h: HandRig): GripShape {
  const q = handSize(spec);
  // a glove's surface is a little further out: what the hand holds lies on it
  const r = (h.radius ?? 0.0035) / q + ((spec.gloves ?? 'none') !== 'none' ? GLOVE_EXTRA : 0);
  const open = clamp(h.open ?? 0);
  const hold = h.hold ?? 'fist';
  let g: GripShape;
  if (hold === 'pinch') {
    // the roll is about the world's +d3; the hand frame of a left hand is mirrored
    g = pinchAround(r, side * (h.roll ?? 0), open, h.cross);
  } else if (hold === 'coil') {
    g = coilAround(r);
    g.curl = g.curl.map((c) => c * (1 - 0.6 * open)) as GripShape['curl'];
    if (h.thumbAlong === -1) g = { ...g, d3: scale(g.d3, -1) };
  } else {
    const fist = fistAround(r);
    const b = Math.atan(FIST_SLOPE);
    const tip = fistThumb(fist, r, h.wrap ?? 0, h.pinch ?? 0);
    // open fingers let go: the thumb lifts off too
    const thumb = mix3(tip, add(tip, [0, -0.012, 0.01]), open);
    const ch = thumbChain(thumb);
    g = {
      curl: fist.curl.map((c) => c * (1 - 0.75 * open)) as GripShape['curl'],
      spread: 0,
      thumb,
      p: [fist.gx, fist.gy, FIST_Z],
      // the cable crosses the hand along the slanted line of the knuckles
      d3: scale([Math.sin(b), 0, Math.cos(b)], h.thumbAlong ?? 1),
      d1: [0, -1, 0],
      pads: [0, -1, 0],
      thumbTip: norm(sub(ch[3], ch[2])),
    };
  }
  return { ...g, p: scale(g.p, q) };
}

/** the hand pose of a grip shape on a solved arm */
function holdingHand(sol: ArmSolution, g: GripShape, q: number): HandPose {
  return { wrist: sol.wrist, fd: sol.hand.fd, palm: sol.hand.palm, curl: g.curl, spread: g.spread, thumb: g.thumb, thumbDir: g.thumbDir, thumbNail: g.thumbNail, q };
}

/** a hand-frame direction in the world */
const handToWorld = (sol: ArmSolution, v: V3): V3 => norm([
  sol.hand.fd[0] * v[0] + sol.hand.palm[0] * v[1] + sol.hand.thumb[0] * v[2],
  sol.hand.fd[1] * v[0] + sol.hand.palm[1] * v[1] + sol.hand.thumb[1] * v[2],
  sol.hand.fd[2] * v[0] + sol.hand.palm[2] * v[1] + sol.hand.thumb[2] * v[2],
]);

/**
 * The hand that closes around a cable exactly at a grip frame, without an arm (where the wrist must
 * be and how the hand is shaped); side -1 left, +1 right. rigPose does this through the arm IK.
 */
export function handFromGrip(spec: PersonSpec, side: number, h: HandRig & { grip: Grip }): HandPose {
  const q = handSize(spec);
  const g = gripShape(spec, side, h);
  const [d1, , d3] = quatCols(h.grip.q);
  // the rotation that maps the shape's axes (hand frame) onto the grip's (world)
  const hd3 = norm(g.d3);
  const hd1 = across(g.d1, hd3);
  const hd2 = cross(hd3, hd1);
  const wd2 = cross(d3, d1);
  const toW = (v: V3): V3 => {
    const a = dot(v, hd1), b = dot(v, hd2), c = dot(v, hd3);
    return [d1[0] * a + wd2[0] * b + d3[0] * c, d1[1] * a + wd2[1] * b + d3[1] * c, d1[2] * a + wd2[2] * b + d3[2] * c];
  };
  // a left hand's frame is mirrored (thumb = -fd × palm): reflect across the plane of d1 and d3 first
  const refl = (v: V3): V3 => (side < 0 ? madd(v, hd2, -2 * dot(v, hd2)) : v);
  const fd = toW(refl([1, 0, 0]));
  const palm = toW(refl([0, 1, 0]));
  const thumb = toW(refl([0, 0, 1]));
  const wrist = sub(h.grip.p, add(add(scale(fd, g.p[0]), scale(palm, g.p[1])), scale(thumb, g.p[2])));
  return { wrist, fd, palm, curl: g.curl, spread: g.spread, thumb: g.thumb, thumbDir: g.thumbDir, thumbNail: g.thumbNail, q };
}

/** a relaxed or curled free hand; fd and palm are made orthonormal */
function freeHand(q: number, wrist: V3, fd: V3, palm: V3, curl: number, pinch: number): HandPose {
  const c = clamp(curl);
  const p = clamp(pinch);
  // a pinch curls the index finger towards the thumb
  const index = lerp(c * 0.92, Math.max(c, 0.6), p);
  return { wrist, fd, palm: across(palm, fd), curl: [index, c, c * 1.04, c * 1.1].map((x) => clamp(x)) as HandPose['curl'], spread: 0.15 * (1 - p), thumb: freeThumb(c, p, index), q };
}

// ---------------------------------------------------------------- the torso

/** pelvis, legs, spine, chest and head of a rig: everything but the arms */
function core(spec: PersonSpec, g: Rig) {
  const k = spec.height / 1.75;
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
  const hipW = 0.095 * k * spec.build.hips;

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
  const neck = madd(pelvis, spine, 0.5 * k);
  const chest = withUp(rotY(base.f, g.twist ?? 0), spine);
  return { k, thigh, shin, base, spine, pelvisF, pelvis, hips, neck, chest };
}
type Core = ReturnType<typeof core>;

/** the head turned and nodded towards the look point, within what a neck allows */
function headOf(c: Core, look: V3 | undefined) {
  const { k, neck, chest } = c;
  const pivot = local(neck, chest.r, chest.u, chest.f, 0, 0.1 * k, 0.01 * k);
  let head: Frame = chest;
  if (look) {
    const d = norm(sub(look, madd(pivot, chest.u, 0.065 * k)));
    const yaw = clamp(Math.atan2(dot(d, chest.r), dot(d, chest.f)), -1.2, 1.2);
    const pitch = clamp(Math.asin(clamp(dot(d, UP), -1, 1)), -1.0, 0.7);
    const hf0 = rotY(norm([chest.f[0], 0, chest.f[2]]), yaw);
    const hr = norm(cross(hf0, UP));
    const hf = norm(turn(hf0, hr, pitch));
    head = { r: hr, u: cross(hr, hf), f: hf };
  }
  return { head, headC: local(pivot, head.r, head.u, head.f, 0, 0.065 * k, 0.005 * k) };
}

/**
 * Where a rig's eyes are and which way they look, without solving the arms (cheap: for a smoothed
 * first-person camera that samples the rig at several times). Same as body3d eyesOf(rigPose(…)),
 * including the upper body's help (Rig.reach).
 */
export function eyesOfRig(spec: PersonSpec, rig: Rig): { p: V3; f: V3; u: V3 } {
  const g = helped(spec, rig);
  const c = core(spec, g);
  const { head, headC } = headOf(c, g.look);
  return { p: madd(madd(headC, head.f, 0.09 * c.k), head.u, 0.035 * c.k), f: head.f, u: head.u };
}

/**
 * The fixed part of an arm (ik.ts ArmSetup) for a torso: the sternoclavicular joint at the top of the
 * sternum, the clavicle out to the shoulder joint (lateral, a little back and up), the bone lengths
 * and the torso the arm keeps out of.
 */
export function armSetup(spec: PersonSpec, c: { k: number; neck: V3; chest: Frame; pelvis: V3 }, side: -1 | 1, offset: V3 = [0, 0, 0]): ArmSetup {
  const B = spec.build;
  const { k, neck, chest } = c;
  const shW = 0.19 * k * B.shoulders;
  const sc = add(local(neck, chest.r, chest.u, chest.f, side * 0.025 * k, -0.05 * k, 0.05 * k), offset);
  const sh = add(local(neck, chest.r, chest.u, chest.f, side * shW, -0.04 * k, -0.01), offset);
  const s: ArmSetup = {
    side,
    F: chest.f,
    U: chest.u,
    L: scale(chest.r, side),
    sc,
    clav: [0, 0, 0],
    upper: 0.29 * k,
    fore: 0.255 * k,
    torso: { a: [0, 0, 0], b: [0, 0, 0], halfW: 0.14 * k * B.waist * (1 + 0.3 * B.belly), halfD: 0.105 * k * (1 + 0.6 * B.belly + 0.3 * B.bust) },
  };
  s.clav = toLocal(s, sub(sh, sc));
  s.torso.a = toLocal(s, sub(madd(c.pelvis, chest.u, -0.05 * k), sc));
  s.torso.b = toLocal(s, sub(neck, sc));
  return s;
}

/**
 * The arm setup of a solved pose (side -1 left, +1 right), to call ik.ts solveArm / armPose directly
 * (e.g. to try a target against the torso of this frame). Ignores Rig.shoulders.
 */
export function armSetupOf(pose: Pose, side: -1 | 1): ArmSetup {
  return armSetup(pose.spec, { k: pose.body.k, neck: pose.joints[17], chest: pose.body.chest, pelvis: pose.joints[18] }, side);
}

/** the arm angles of a relaxed hanging arm, swinging forward by `swing` (rad) */
function hangingAngles(B: PersonSpec['build'], swing: number): ArmAngles {
  const out = 0.14 + 0.02 * (B.hips - B.shoulders) * 5;
  return { clavElev: 0, clavProt: 0, flex: swing, abd: out, rot: -0.15, elbow: 0.22 + 0.9 * Math.max(0, swing), pron: 0.15, wflex: -0.08, wdev: -0.1 };
}

/**
 * The IK state of a person for frame-by-frame solving: each arm starts from its last solution
 * (ik.ts ArmIK). dt = seconds between two rigPose calls with it (set it when the rate changes).
 * For a choreography that is a function of time, prefer RigTrack: bake and scene then get exactly the
 * same arms. RigIK is for rigs that depend on the simulation as it runs (a sim in the loop): store
 * pose.body.arms[i].angles per frame in the bake and give them back as rigPose(…, fixed) in the scene.
 */
export class RigIK {
  public readonly arms: [ArmIK, ArmIK];

  public constructor(
    public dt = 1 / 60,
    o: ArmIKOptions = {},
  ) {
    this.arms = [new ArmIK(o), new ArmIK(o)];
  }

  public reset() {
    this.arms[0].reset();
    this.arms[1].reset();
  }
}

/** the thumb tip's direction of a free hand (hand frame) */
function freeThumbTip(h: HandRig): V3 {
  const c = clamp(h.curl ?? 0.25);
  const p = clamp(h.pinch ?? 0);
  const ch = thumbChain(freeThumb(c, p, lerp(c * 0.92, Math.max(c, 0.6), p)));
  return norm(sub(ch[3], ch[2]));
}

/**
 * What a hand rig asks of its arm (ik.ts HandTarget) and the hand's shape. The orientation goals, in
 * this order (IkReport.axisErrors): a grip's cable direction d3, its d1 (the pads' frame: without a
 * pinch's roll; weight 1 - free), the `prefer` wishes, thumbTo; a free hand's `prefer` wishes, dir,
 * palm, thumbTo.
 */
function targetOf(spec: PersonSpec, side: -1 | 1, h: HandRig, s: ArmSetup, k: number): { target: HandTarget; shape: GripShape | null } {
  const elbow = h.elbow;
  const elbowWeight = h.elbowWeight;
  if (h.grip) {
    const shape = gripShape(spec, side, h);
    const [d1, , d3] = quatCols(h.grip.q);
    const free = clamp(h.free ?? 0);
    const axes: AxisGoal[] = [
      { hand: shape.d3, world: d3, weight: 1 },
      // the hand fits the grip with its pads; the roll only turns the cable between them
      { hand: shape.pads, world: d1, weight: Math.max(0.02, 1 - free) },
      ...(h.prefer ?? []),
    ];
    if (h.thumbTo) axes.push({ hand: shape.thumbTip, world: h.thumbTo, weight: h.thumbWeight ?? 0.3 });
    return { target: { p: h.grip.p, at: shape.p, axes, elbow, elbowWeight, joints: h.joints, jointWeight: h.jointWeight }, shape };
  }
  const axes: AxisGoal[] = [...(h.prefer ?? [])];
  if (h.dir) axes.push({ hand: [1, 0, 0], world: h.dir, weight: 1 });
  if (h.palm) axes.push({ hand: [0, 1, 0], world: h.palm, weight: h.dir ? 1 : 0.6 });
  if (h.thumbTo) axes.push({ hand: freeThumbTip(h), world: h.thumbTo, weight: h.thumbWeight ?? 0.3 });
  // no wrist: the hand hangs half an arm below the shoulder
  const p = h.wrist ?? add(s.sc, add(scale(s.U, -0.5 * k), scale(s.L, 0.16 * k)));
  return { target: { p, axes, elbow, elbowWeight, joints: h.joints, jointWeight: h.jointWeight }, shape: null };
}

/** an arm for a hand rig (null: hanging), solved; the hand pose and what the arm reached */
function solveSide(spec: PersonSpec, g: Rig, c: Core, i: 0 | 1, ik?: RigIK, fixed?: ArmAngles | null): { hand: HandPose; arm: ArmPose; sol: ArmSolution } {
  const side = i ? 1 : -1;
  const q = handSize(spec);
  const s = armSetup(spec, c, side, g.shoulders?.[i]);
  const h = g.hands[i];
  if (!h) {
    const sol = armPose(s, hangingAngles(spec.build, g.swing?.[i] ?? 0));
    // the next grip starts from the hanging arm (no pop)
    ik?.arms[i].hold(sol.angles);
    const hand = freeHand(q, sol.wrist, sol.hand.fd, sol.hand.palm, 0.25, 0);
    return { hand, sol, arm: { angles: sol.angles, report: sol.report, sc: s.sc, forearm: sol.forearm } };
  }
  const { target, shape } = targetOf(spec, side, h, s, c.k);
  // given angles (RigTrack): only measured against what the rig asks, with the full report
  const sol = fixed ? evaluateArm(s, target, fixed) : ik ? ik.arms[i].solve(s, target, ik.dt) : solveArm(s, target);
  const arm: ArmPose = { angles: sol.angles, report: sol.report, sc: s.sc, forearm: sol.forearm };
  if (shape) {
    // the frames really held: the reached point, the shape's axes in the reached hand (grip: the
    // cable's, turned by a pinch's roll; pads: fixed in the hand)
    const d3 = handToWorld(sol, shape.d3);
    const frame = (v: V3) => {
      const d1 = across(handToWorld(sol, v), d3);
      return { p: sol.point, q: quatFromCols(d1, cross(d3, d1), d3) };
    };
    arm.grip = frame(shape.d1);
    arm.pads = frame(shape.pads);
    return { hand: holdingHand(sol, shape, q), arm, sol };
  }
  return { hand: freeHand(q, sol.wrist, sol.hand.fd, sol.hand.palm, h.curl ?? 0.25, h.pinch ?? 0), arm, sol };
}

/** the furthest a hand target is beyond the arm's reach (m, ≤ 0 = reachable), for the torso's help */
function overreach(spec: PersonSpec, g: Rig, c: Core): number {
  let worst = -Infinity;
  for (const i of [0, 1] as const) {
    const h = g.hands[i];
    if (!h) continue;
    const s = armSetup(spec, c, i ? 1 : -1, g.shoulders?.[i]);
    const { target } = targetOf(spec, i ? 1 : -1, h, s, c.k);
    const sh = add(s.sc, add(add(scale(s.F, s.clav[0]), scale(s.U, s.clav[1])), scale(s.L, s.clav[2])));
    // a straight arm reaches this far; the hand point adds a little
    const reach = (s.upper + s.fore) * 0.97 + len(target.at ?? [0, 0, 0]) * 0.6;
    worst = Math.max(worst, len(sub(target.p, sh)) - reach);
  }
  return worst;
}

/** the rig with the upper body helping hands that cannot reach (Rig.reach): lean, bend, twist, bounded */
function helped(spec: PersonSpec, g: Rig): Rig {
  const help = clamp(g.reach ?? 0);
  if (help <= 0 || overreach(spec, g, core(spec, g)) <= -0.01) return g;
  const lim = [0.3 * help, 0.15 * help, 0.3 * help];
  const base = [g.lean ?? 0, g.bend ?? 0, g.twist ?? 0];
  const withD = (d: number[]): Rig => ({ ...g, lean: base[0] + d[0], bend: base[1] + d[1], twist: base[2] + d[2] });
  // the smallest change of lean (forward only), bend and twist that brings every target in reach
  const cost = (d: number[]) => {
    const o = overreach(spec, withD(d), core(spec, withD(d)));
    return 400 * Math.max(0, o + 0.01) ** 2 + 0.02 * (d[0] * d[0] + 2 * d[1] * d[1] + d[2] * d[2]);
  };
  const clampD = (d: number[]) => [clamp(d[0], 0, lim[0]), clamp(d[1], -lim[1], lim[1]), clamp(d[2], -lim[2], lim[2])];
  // projected gradient descent with numeric derivatives and step halving: deterministic
  let d = [0, 0, 0];
  let c0 = cost(d);
  for (let it = 0; it < 40; it++) {
    const grad = d.map((_, j) => {
      const e = d.slice();
      e[j] += 1e-4;
      return (cost(e) - c0) / 1e-4;
    });
    const gl = Math.hypot(...grad);
    if (gl < 1e-6) break;
    let step = 0.05;
    while (step > 1e-4) {
      const n = clampD(d.map((v, j) => v - (step * grad[j]) / gl));
      const cn = cost(n);
      if (cn < c0) {
        d = n;
        c0 = cn;
        break;
      }
      step /= 2;
    }
    if (step <= 1e-4) break;
  }
  return withD(d);
}

// ---------------------------------------------------------------- the pose

/**
 * The pose for a rig. Pass a RigIK to solve frame by frame (each arm starts from its last solution
 * and stays close to it); without, every call is a deterministic function of the rig alone. `fixed`
 * gives arms their angles directly (no solving; RigTrack uses it).
 */
export function rigPose(spec: PersonSpec, rig: Rig, ik?: RigIK, fixed?: [ArmAngles | null, ArmAngles | null]): Pose {
  const g = helped(spec, rig);
  const c = core(spec, g);
  const { k, thigh, shin, base, spine, pelvisF, pelvis, hips } = c;

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
    const leg = twoBone(hips[i], ft.ankle, thigh, shin, pole);
    return { knee: leg.mid, ankle: leg.end, fd: norm(ft.dir) };
  });
  const toe = (l: (typeof legs)[number]) => madd(madd(l.ankle, l.fd, 0.15 * k), UP, -0.05 * k);

  const arms = [solveSide(spec, g, c, 0, ik, fixed?.[0]), solveSide(spec, g, c, 1, ik, fixed?.[1])];
  const knuckles = (hp: HandPose) => madd(hp.wrist, hp.fd, 0.093 * hp.q);
  const { head, headC } = headOf(c, g.look);
  const face = (x: number, y: number, z: number) => local(headC, head.r, head.u, head.f, x * k, y * k, z * k);
  const P = (i: 0 | 1, j: 'shoulder' | 'elbow' | 'wrist') => arms[i].sol[j];

  const joints: V3[] = [
    face(0, -0.02, 0.1), face(-0.033, 0.025, 0.085), face(0.033, 0.025, 0.085), face(-0.075, 0, 0), face(0.075, 0, 0),
    P(0, 'shoulder'), P(1, 'shoulder'), P(0, 'elbow'), P(1, 'elbow'), arms[0].hand.wrist, arms[1].hand.wrist,
    hips[0], hips[1], legs[0].knee, legs[1].knee, legs[0].ankle, legs[1].ankle,
    c.neck, pelvis, headC, knuckles(arms[0].hand), knuckles(arms[1].hand),
  ];
  const body: Body = {
    k,
    pelvis: pelvisF,
    chest: c.chest,
    head,
    spine,
    toeL: toe(legs[0]),
    toeR: toe(legs[1]),
    footL: legs[0].fd,
    footR: legs[1].fd,
    hands: [arms[0].hand, arms[1].hand],
    arms: [arms[0].arm, arms[1].arm],
  };
  return { spec, joints, body, F: base.f, R: base.r };
}

/**
 * A choreography solved once, frame by frame, with the stateful IK (RigIK: continuous, no pops),
 * then sampled at any time: the arm angles are interpolated between the frames, everything else
 * (torso, legs, hand shapes) comes from the rig at that time, and the report (residuals, limits) is
 * measured against it. Deterministic and scrubbable: frames are solved in order up to the latest one
 * asked for and kept. THE source of the arms for bake and scene: both build a RigTrack with the same
 * spec, rigAt, t0 and fps; the bake asks track.pose(t) at every simulation substep (grip frames:
 * pose.body.arms[i].grip / .pads, capsules: colliders.ts handColliders(pose, i)), the scene at every
 * frame, and both see the same arms (tools/simtest/ik-continuity.mjs checks it).
 */
export class RigTrack {
  private readonly frames: [ArmAngles | null, ArmAngles | null][] = [];
  private readonly ik: RigIK;

  public constructor(
    public readonly spec: PersonSpec,
    public readonly rigAt: (t: number) => Rig,
    /** the first frame's time, s */
    public readonly t0 = 0,
    /** frames per second of the solve */
    public readonly fps = 60,
  ) {
    this.ik = new RigIK(1 / fps);
  }

  /** the arm angles of frame f (solving the frames before it first, once) */
  public angles(f: number): [ArmAngles | null, ArmAngles | null] {
    while (this.frames.length <= f) {
      const t = this.t0 + this.frames.length / this.fps;
      const g = this.rigAt(t);
      const p = rigPose(this.spec, g, this.ik);
      const arms = p.body.arms;
      this.frames.push([g.hands[0] && arms ? arms[0].angles : null, g.hands[1] && arms ? arms[1].angles : null]);
    }
    return this.frames[f];
  }

  /** the pose at time t */
  public pose(t: number): Pose {
    const u = Math.max(0, (t - this.t0) * this.fps);
    const f = Math.floor(u);
    const a = this.angles(f);
    const b = this.angles(f + 1);
    const w = u - f;
    const mix = (x: ArmAngles | null, y: ArmAngles | null): ArmAngles | null => {
      if (!x || !y) return w < 0.5 ? x : y;
      // in between two frames, still inside the limits (the shoulder's cone is not convex)
      const q = ARM_JOINTS.map((j) => lerp(x[j], y[j], w));
      projectToLimits(q);
      return Object.fromEntries(ARM_JOINTS.map((j, i) => [j, q[i]])) as unknown as ArmAngles;
    };
    return rigPose(this.spec, this.rigAt(t), undefined, [mix(a[0], b[0]), mix(a[1], b[1])]);
  }
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
