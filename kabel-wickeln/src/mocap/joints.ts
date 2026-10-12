// The joints of a take (mocap/FORMAT.md, version 1): 68 names in a fixed order, and the same
// joints computed from a pose of our people (src/people), so a retargeted figure can be measured
// exactly like the recording. Pure TypeScript (browser and Node).
//
// The order: COCO-17, the feet (COCO-WholeBody: big toe, small toe, heel; left, right), the left
// and the right hand with 21 points each (wrist, thumb cmc/mcp/ip/tip, then index, middle, ring,
// pinky as mcp/pip/dip/tip), then the derived pelvis, neck, head. `left`/`right` are the person's
// sides. takeJointsOf must stay equal to mocap/synthetic/generate.ts jointsOf (the synthetic
// truth); tools/simtest/mocap-retarget.mjs checks it.

import { V3, cross, madd, norm } from '../people/math';
import type { Pose } from '../people/people';
import { handJoints } from '../people/body/hand';

const COCO = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear', 'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
] as const;
const FEET = ['left_big_toe', 'left_small_toe', 'left_heel', 'right_big_toe', 'right_small_toe', 'right_heel'] as const;
/** the 21 points of a hand (OpenPose/MediaPipe order) */
export const HAND_POINTS = [
  'wrist', 'thumb_cmc', 'thumb_mcp', 'thumb_ip', 'thumb_tip', 'index_mcp', 'index_pip', 'index_dip', 'index_tip',
  'middle_mcp', 'middle_pip', 'middle_dip', 'middle_tip', 'ring_mcp', 'ring_pip', 'ring_dip', 'ring_tip',
  'pinky_mcp', 'pinky_pip', 'pinky_dip', 'pinky_tip',
] as const;

/** the 68 joints of a take, in file order */
export const TAKE_JOINTS: readonly string[] = [
  ...COCO, ...FEET, ...HAND_POINTS.map((n) => `left_hand_${n}`), ...HAND_POINTS.map((n) => `right_hand_${n}`), 'pelvis', 'neck', 'head',
];

/** index of every joint name */
export const TJ: Readonly<Record<string, number>> = Object.fromEntries(TAKE_JOINTS.map((n, i) => [n, i]));

/** the first index of a hand's 21 points (side 0 left, 1 right) */
export const handBase = (side: 0 | 1) => (side ? 44 : 23);

/** joint indices by role, per side (0 left, 1 right) */
export const SIDE = [0, 1].map((s) => {
  const p = s ? 'right' : 'left';
  const h = handBase(s as 0 | 1);
  return {
    eye: TJ[`${p}_eye`], ear: TJ[`${p}_ear`], shoulder: TJ[`${p}_shoulder`], elbow: TJ[`${p}_elbow`], wrist: TJ[`${p}_wrist`],
    hip: TJ[`${p}_hip`], knee: TJ[`${p}_knee`], ankle: TJ[`${p}_ankle`],
    bigToe: TJ[`${p}_big_toe`], smallToe: TJ[`${p}_small_toe`], heel: TJ[`${p}_heel`],
    /** hand: wrist, thumb cmc … pinky tip (21) */
    hand: h,
  };
}) as { eye: number; ear: number; shoulder: number; elbow: number; wrist: number; hip: number; knee: number; ankle: number; bigToe: number; smallToe: number; heel: number; hand: number }[];

export const NOSE = 0;
export const PELVIS = TJ.pelvis;
export const NECK = TJ.neck;
export const HEAD = TJ.head;

/** the index of the same joint on the other side (mirroring) */
export const MIRROR_OF: readonly number[] = TAKE_JOINTS.map((n) => {
  const o = n.startsWith('left_') ? `right_${n.slice(5)}` : n.startsWith('right_') ? `left_${n.slice(6)}` : n;
  return TJ[o];
});

/** heel, big toe, small toe of a foot, on the shoe's sole (body/styles.ts shoe) */
function footPoints(ankle: V3, fd: V3, q: number, sideSign: number): [V3, V3, V3] {
  const side = norm(cross(fd, [0, 1, 0]));
  const u = norm(cross(side, fd));
  // towards the other foot: + side for the left foot
  const medial: V3 = sideSign < 0 ? side : [-side[0], -side[1], -side[2]];
  const p = (along: number, down: number, med: number) => madd(madd(madd(ankle, fd, along * q), u, -down * q), medial, med * q);
  return [p(0.18, 0.058, 0.012), p(0.145, 0.058, -0.03), p(-0.075, 0.05, 0)];
}

/** all 68 take joints of a pose (world of the pose, m), TAKE_JOINTS order */
export function takeJointsOf(pose: Pose): V3[] {
  const J = pose.joints;
  const b = pose.body;
  const qf = b.k * pose.spec.build.feet;
  const [lbt, lst, lhe] = footPoints(J[15], b.footL, qf, -1);
  const [rbt, rst, rhe] = footPoints(J[16], b.footR, qf, 1);
  const hand = (i: 0 | 1): V3[] => {
    const h = b.hands[i];
    const hj = handJoints(h, i ? 1 : -1);
    return [h.wrist, ...hj.thumb, ...hj.fingers.flatMap((f) => f.p)];
  };
  return [...J.slice(0, 17), lbt, lst, lhe, rbt, rst, rhe, ...hand(0), ...hand(1), J[18], J[17], J[19]];
}
