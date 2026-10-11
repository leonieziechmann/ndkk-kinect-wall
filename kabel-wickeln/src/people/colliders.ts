// Collision capsules of a hand and its forearm for the cable simulation, built from the same
// geometry as the hand mesh (body/hand.ts handJoints, the radii of body/styles.ts), so a cable that
// stays outside the capsules stays outside the visible hand.
//
// Conventions (world metres, y up):
//   - A capsule is the sim's Capsule (src/sim/rod.ts): segment a-b with radius r = the surface of
//     the hand (skin, or glove). The cable's own radius is not included: the simulation keeps the
//     cable axis at r + cable radius from the segment.
//   - The list has a FIXED LENGTH AND ORDER (HAND_PARTS, 22 capsules with the forearm), the same
//     every frame and for every pose, as rod.ts requires (capsule k is always the same bone, so its
//     motion between substeps is known): palm 6 (three lanes from the thumb side to the little
//     finger, each wrist half then knuckle half), index 3 (proximal, middle, distal bone), middle 3,
//     ring 3, little 3, thumb 3 (metacarpal in the ball of the thumb, first and last phalanx),
//     forearm 1 (elbow to wrist, the sleeve's radius; last, also when switched off).
//   - Holding: give every capsule of the hand its group (options.group = the hand's id) and pass the
//     same id as PinchSpec.hand / BundleSpec.hand: the simulation then lets the held part of the
//     cable through this hand's capsules (pads and fingers press via the pinch or bundle
//     constraint) while the rest of the cable still collides with the hand. Do not drop capsules to
//     let a held cable in: switch them off with `disable` (the slot stays, with r = OFF_R < 0, which
//     never touches anything).
//   - soft: fingers may give way a little (rod.ts Capsule.soft, e.g. 0.3) so a hand that squeezes the
//     cable against something held does not make the constraints fight.
//   - Grip frames (rig.ts Grip, pose.body.arms[i].grip / .pads): p on the cable axis in the middle
//     of the hold; columns of q: d1 from the cable axis towards the hand (to the palm in a fist or a
//     coil grip, to the index finger in a pinch), d2 = d3 × d1, d3 along the cable towards where the
//     thumb points. In a closed pinch the cable touches the index finger's middle capsule and the
//     thumb's last capsule at p (both marked pad; `open` lifts the thumb off). d3 is the thumb's
//     direction, not the rod's node order: a simulation whose held segment runs the other way uses
//     (d1, -d2, -d3).

import type { Capsule as SimCapsule } from '../sim/rod';
import { V3, madd } from './math';
import type { HandPose, Pose } from './people';
import { FINGERS, THUMB_CAPS, fingerCaps, handJoints, palmSurface } from './body/hand';

export type HandPart = 'palm' | 'thumb' | 'index' | 'middle' | 'ring' | 'little' | 'forearm';

/** the part of every slot of the list, in order (handColliders with the forearm; handCapsules without the last) */
export const HAND_PARTS: readonly HandPart[] = [
  'palm', 'palm', 'palm', 'palm', 'palm', 'palm',
  'index', 'index', 'index', 'middle', 'middle', 'middle', 'ring', 'ring', 'ring', 'little', 'little', 'little',
  'thumb', 'thumb', 'thumb',
  'forearm',
];

/** the radius of a switched-off slot: negative, so no cable ever comes within r + its radius */
export const OFF_R = -1;

export interface HandCapsule extends SimCapsule {
  part: HandPart;
  /** which bone of the part: 0 proximal … 2 distal (palm: 0-5, forearm 0) */
  bone: number;
  /** what pinches: the thumb's last bone and the index finger's middle bone */
  pad?: boolean;
  /** switched off (r = OFF_R): kept so the list keeps its order */
  off?: boolean;
}

export interface ColliderOptions {
  /** switch the forearm's slot off (default true = on) */
  forearm?: boolean;
  /** grow every capsule by this much (m): a safety margin for fast motion; default 0 */
  margin?: number;
  /** friction for the simulation (Capsule.mu), default: the simulation's */
  mu?: number;
  /** the hand's id (Capsule.group): a Pinch or Bundle with the same `hand` lets the cable it holds through these capsules */
  group?: number;
  /** Capsule.soft (0 … 1, default hard), for all capsules or per part, e.g. { index: 0.3, middle: 0.3, ring: 0.3, little: 0.3, thumb: 0.3 } */
  soft?: number | Partial<Record<HandPart, number>>;
  /** switch these parts (or single capsules: a predicate) off; their slots stay (r = OFF_R) */
  disable?: HandPart[] | ((c: HandCapsule) => boolean);
}

/** the hand's 21 capsules (no forearm), from a HandPose (side -1 left, +1 right; gloved hands are thicker) */
export function handCapsules(h: HandPose, side: number, gloved = false, o: ColliderOptions = {}): HandCapsule[] {
  const hj = handJoints(h, side);
  const q = h.q;
  const thick = gloved ? 1.08 : 1;
  const out: HandCapsule[] = [];
  const add = (a: V3, b: V3, r: number, part: HandPart, bone: number, pad?: boolean) => {
    const c: HandCapsule = { a, b, r: r * q * thick, part, bone };
    if (pad) c.pad = true;
    out.push(c);
  };
  // the palm (body/hand.ts PALM_RINGS): three lanes side by side across the hand, each in two
  // pieces (the thick middle of the hand, the thinner part up to the knuckles); the palm side of
  // each capsule is where the palm's surface is
  const at = (x: number, y: number, z: number): V3 => madd(madd(madd(h.wrist, h.fd, x * q), h.palm, y * q), hj.w, z * q);
  const pieces: [number, number, number][] = [[0.006, 0.05, 0.017], [0.05, 0.086, 0.0142]];
  let pb = 0;
  for (const z of [0.022, 0, -0.022]) {
    for (const [x0, x1, r] of pieces) {
      // the capsule's centre so that its palm side lies on the palm surface at its far end
      const y = palmSurface(x1) - r;
      add(at(x0, y, z), at(x1, y, z), r, 'palm', pb++);
    }
  }
  // fingers: one capsule per bone (a curled finger's hook stays free for what it holds)
  const names: HandPart[] = ['index', 'middle', 'ring', 'little'];
  hj.fingers.forEach((f, i) => {
    const d = FINGERS[i];
    const [K, J1, J2, T] = f.p;
    const r = fingerCaps(d);
    add(K, J1, r[0], names[i], 0);
    // a pinched cable lies on the side of the index finger's middle bone
    add(J1, J2, r[1], names[i], 1, i === 0);
    add(J2, T, r[2], names[i], 2);
  });
  // the thumb: metacarpal (inside the ball of the thumb), first and last phalanx
  const [B, M, IP, T] = hj.thumb;
  add(B, M, THUMB_CAPS[0], 'thumb', 0);
  add(M, IP, THUMB_CAPS[1], 'thumb', 1);
  add(IP, T, THUMB_CAPS[2], 'thumb', 2, true);
  return out.map((c) => dress(c, o));
}

/** options applied to one capsule: margin, friction, group, softness, switched off */
function dress(c: HandCapsule, o: ColliderOptions): HandCapsule {
  if (o.margin) c.r += o.margin;
  if (o.mu !== undefined) c.mu = o.mu;
  if (o.group !== undefined) c.group = o.group;
  const soft = typeof o.soft === 'number' ? o.soft : o.soft?.[c.part];
  if (soft !== undefined) c.soft = soft;
  const off = typeof o.disable === 'function' ? o.disable(c) : (o.disable?.includes(c.part) ?? false);
  if (off) {
    c.off = true;
    c.r = OFF_R;
  }
  return c;
}

/**
 * The capsules of a person's hand (side 0 / 'L' left, 1 / 'R' right) and its forearm in a pose:
 * what the cable must stay out of. Always 22 in the order of HAND_PARTS. Rebuild them every frame
 * (or substep) from that time's pose, e.g. RigTrack.pose(t), the same poses the scene shows.
 */
export function handColliders(pose: Pose, side: 0 | 1 | 'L' | 'R', o: ColliderOptions = {}): HandCapsule[] {
  const i = side === 'L' || side === 0 ? 0 : 1;
  const h = pose.body.hands[i];
  const gloved = (pose.spec.gloves ?? 'none') !== 'none';
  const out = handCapsules(h, i ? 1 : -1, gloved, o);
  const el = pose.joints[i ? 8 : 7];
  const k = pose.body.k * pose.spec.build.limbs;
  // the forearm's middle radius (styles.ts arm tables), a little in from the wrist
  const fa = dress({ a: el, b: madd(h.wrist, h.fd, -0.01 * h.q), r: 0.038 * k, part: 'forearm', bone: 0 }, o);
  if (o.forearm === false) {
    fa.off = true;
    fa.r = OFF_R;
  }
  out.push(fa);
  return out;
}
