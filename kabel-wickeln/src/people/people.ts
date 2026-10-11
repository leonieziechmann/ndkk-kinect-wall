// The people: who they are (PersonSpec: height, build, clothes, hair, colours) and the pose a rig
// gives them (Pose: joints, body frames, hands). Ported from erklaervideo/src/lib/people.ts; the
// joints keep the repo's order (the 17 COCO points of the pose model, then neck, pelvis, head and the
// two hands). World: metres, y up, a person with yaw 0 faces -z.
//
// Poses come from rig.ts (world-space IK, walking, keyframes); meshes from body/styles.ts.

import { V3, cross, norm } from './math';
import type { MatName } from './body/mesh';
import type { ArmAngles, IkReport } from './ik';

export const JOINTS = [
  'nose', 'leftEye', 'rightEye', 'leftEar', 'rightEar',
  'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist',
  'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle',
  'neck', 'pelvis', 'head', 'leftHand', 'rightHand',
] as const;
export type JointName = (typeof JOINTS)[number];
export const J = Object.fromEntries(JOINTS.map((n, i) => [n, i])) as Record<JointName, number>;

/**
 * Body shape, as factors of a base body (1 = the base; belly and bust are extra volume, 0 = none).
 * Shoulders and hips also move the joints, limbs and neck change thicknesses, head/hands/feet sizes.
 */
export interface Build {
  shoulders: number;
  chest: number;
  waist: number;
  hips: number;
  belly: number;
  bust: number;
  limbs: number;
  neck: number;
  head: number;
  hands: number;
  feet: number;
}

/** presets; mix them with `build()` (a woman with broad shoulders, a slim man, a heavier older person) */
export const BUILDS = {
  /** the base body (the original male proportions) */
  base: { shoulders: 1, chest: 1, waist: 1, hips: 1, belly: 0, bust: 0, limbs: 1, neck: 1, head: 1, hands: 1, feet: 1 },
  /** the original female proportions */
  fem: { shoulders: 0.92, chest: 0.95, waist: 0.9, hips: 1.06, belly: 0, bust: 0.35, limbs: 0.88, neck: 0.86, head: 0.95, hands: 0.92, feet: 0.93 },
  slim: { shoulders: 0.97, chest: 0.92, waist: 0.88, hips: 0.95, belly: 0, bust: 0, limbs: 0.88, neck: 0.92, head: 1, hands: 0.98, feet: 1 },
  sturdy: { shoulders: 1.04, chest: 1.06, waist: 1.1, hips: 1.06, belly: 0.25, bust: 0, limbs: 1.12, neck: 1.08, head: 1, hands: 1.03, feet: 1 },
} satisfies Record<string, Build>;

/** a preset with some factors changed */
export const build = (base: Build, over: Partial<Build> = {}): Build => ({ ...base, ...over });

export type Hair = 'none' | 'buzz' | 'undercut' | 'short' | 'pixie' | 'coils' | 'curly' | 'afro' | 'bun' | 'ponytail';
/** overshirt: a buttoned shirt jacket with collar and chest pockets; jacket: an open work jacket over a tee (top2) */
export type Top = 'tee' | 'longsleeve' | 'hoodie' | 'fleece' | 'overshirt' | 'jacket';
export type Pants = 'straight' | 'work' | 'wide';
export type Shoes = 'sneakers' | 'workshoes' | 'boots';
export type Headwear = 'none' | 'cap' | 'hijab';
export type Gloves = 'none' | 'work' | 'rigger';

/** colours per material, as '#rrggbb' (sRGB); missing ones are derived (body/styles.ts paletteOf) */
export type Palette = { skin: string; hair: string; top: string; pants: string; shoes: string } & Partial<Record<MatName, string>>;

export interface PersonSpec {
  name: string;
  /** m */
  height: number;
  build: Build;
  hair: Hair;
  top: Top;
  /** how oversized the top is: 0 fitted … 1 very loose */
  loose?: number;
  /** long sleeves pushed up to the elbows */
  pushed?: boolean;
  pants: Pants;
  kneePads?: boolean;
  shoes: Shoes;
  headwear?: Headwear;
  beard?: boolean;
  glasses?: boolean;
  /** a crew pass on a lanyard around the neck */
  lanyard?: boolean;
  /** gloves worn on the hands; 'rigger' leaves the fingertips free */
  gloves?: Gloves;
  /** a pair of gloves hanging from the waistband (right hip) */
  beltGloves?: boolean;
  /** nails painted in palette.nails */
  painted?: boolean;
  colors: Palette;
}

/** a simplified body of capsules (collision bodies for the cable simulation) */
export interface Capsule {
  a: V3;
  b: V3;
  r: number;
  /** body part: 'head', 'torso', 'armL', 'handL', 'fingerL', … so a simulation can skip a holding hand */
  part: string;
}

/** an orthonormal frame: right, up, forward */
export interface Frame {
  r: V3;
  u: V3;
  f: V3;
}

/** a hand: where it is and how it is shaped (rig.ts makes them, body/hand.ts turns them into joints) */
export interface HandPose {
  wrist: V3;
  /** finger direction: wrist → knuckles (unit) */
  fd: V3;
  /** out of the palm (unit, ⟂ fd) */
  palm: V3;
  /** finger curls (index, middle, ring, little): 0 open … 1 fist */
  curl: [number, number, number, number];
  /** spread of the fingers when open (0 … 1) */
  spread: number;
  /** thumb tip in the hand frame (along fd, along palm, towards the thumb side), m for a hand of size 1 */
  thumb: V3;
  /** the direction of the thumb's last bone in the hand frame, when it lies along something (a pinched cable, a bundle) */
  thumbDir?: V3;
  /** where the thumb nail faces in the hand frame (default: away from the palm, out to the thumb side) */
  thumbNail?: V3;
  /** hand size: height/1.75 · build.hands (1 = an average adult hand, 19 cm long) */
  q: number;
}

/** an arm as the IK solved it (rig.ts): its angles, how well it reached, what the hand holds */
export interface ArmPose {
  /** the joint angles (ik.ts ArmAngles, rad) */
  angles: ArmAngles;
  /** how well the target was reached, limits hit (hanging arms: all zero) */
  report: IkReport;
  /** the sternoclavicular joint, where the clavicle starts */
  sc: V3;
  /** the forearm for the mesh: direction, elbow axis (lateral), the wrist's radio-ulnar axis (thumb side) and the pronation between them */
  forearm: { dir: V3; elbowAxis: V3; wristAxis: V3; pron: number };
  /**
   * The grip frame the hand really holds (grips only): p on the cable or bundle axis, columns
   * d1 (to the palm, or to the index finger in a pinch), d2 = d3 × d1, d3 along the cable (a fist or
   * coil: where the thumb points; a pinch: where the cable leaves past the thumb tip). Includes a
   * pinch's roll and the hand's freedom about the cable (HandRig.free): give this frame to the
   * simulation.
   */
  grip?: { p: V3; q: [number, number, number, number] };
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
  /** left, right */
  hands: [HandPose, HandPose];
  /** left, right: the solved arms (always set by rig.ts) */
  arms?: [ArmPose, ArmPose];
}

export interface Pose {
  spec: PersonSpec;
  /** JOINTS order */
  joints: V3[];
  body: Body;
  /** facing (yaw frame): forward and right, horizontal */
  F: V3;
  R: V3;
}

export const UP: V3 = [0, 1, 0];

/** a frame with this up direction, keeping its forward as close as possible */
export function withUp(f: V3, up: V3): Frame {
  const u = norm(up);
  const r = norm(cross(f, u));
  return { r, u, f: cross(u, r) };
}

/** the horizontal frame of a person facing yaw (0 = towards -z, positive turns to the right) */
export function yawFrame(yaw: number): Frame {
  return { r: [Math.cos(yaw), 0, Math.sin(yaw)], u: UP, f: [Math.sin(yaw), 0, -Math.cos(yaw)] };
}
