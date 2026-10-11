// Collision capsules of a hand and its forearm for the cable simulation, built from the same
// geometry as the hand mesh (body/hand.ts handJoints, the radii of body/styles.ts), so a cable that
// stays outside the capsules stays outside the visible hand.
//
// Conventions (world metres, y up):
//   - A capsule is the sim's Capsule (src/sim/rod.ts): segment a-b with radius r = the surface of
//     the hand (skin, or glove). The cable's own radius is not included: the simulation keeps the
//     cable axis at r + cable radius from the segment.
//   - Per hand: the palm as three capsules side by side from the wrist to the knuckles, the thumb
//     (metacarpal, first phalanx, last phalanx), the index finger (one capsule per bone), middle,
//     ring and little finger as two capsules each (first bone; middle and last bone together), and
//     the forearm (elbow to wrist, the sleeve's radius). `part` names each one, so a simulation can
//     leave some out, e.g. the thumb and index pads that hold a pinched cable.
//   - Grip frames (rig.ts Grip, pose.body.arms[i].grip): p on the cable axis in the middle of the
//     hold; columns of q: d1 from the cable axis towards the hand (to the palm in a fist or a coil
//     grip, to the index finger in a pinch), d2 = d3 × d1, d3 along the cable towards where the thumb
//     points. In a pinch the cable touches the index finger's middle capsule and the thumb's last
//     capsule at p (both marked pad; closed pinch, `open` lifts the thumb off). d3 is the thumb's direction, not the rod's node
//     order: a simulation whose held segment runs the other way uses (d1, -d2, -d3).

import type { Capsule as SimCapsule } from '../sim/rod';
import { V3, madd } from './math';
import type { HandPose, Pose } from './people';
import { FINGERS, THUMB, handJoints, palmSurface } from './body/hand';

export type HandPart = 'palm' | 'thumb' | 'index' | 'middle' | 'ring' | 'little' | 'forearm';

export interface HandCapsule extends SimCapsule {
  part: HandPart;
  /** what pinches: the thumb's last bone and the index finger's middle bone */
  pad?: boolean;
}

export interface ColliderOptions {
  /** add the forearm (default true) */
  forearm?: boolean;
  /** grow every capsule by this much (m): a safety margin for fast motion; default 0 */
  margin?: number;
  /** friction for the simulation (Capsule.mu), default: the simulation's */
  mu?: number;
  /** leave these parts out */
  exclude?: HandPart[];
}

/** the hand's capsules without the forearm, from a HandPose (side -1 left, +1 right; gloved hands are thicker) */
export function handCapsules(h: HandPose, side: number, gloved = false, o: ColliderOptions = {}): HandCapsule[] {
  const hj = handJoints(h, side);
  const q = h.q;
  const thick = gloved ? 1.08 : 1;
  const grow = o.margin ?? 0;
  const out: HandCapsule[] = [];
  const add = (a: V3, b: V3, r: number, part: HandPart, pad?: boolean) => {
    if (o.exclude?.includes(part)) return;
    const c: HandCapsule = { a, b, r: r * q * thick + grow, part };
    if (pad) c.pad = true;
    if (o.mu !== undefined) c.mu = o.mu;
    out.push(c);
  };
  // the palm (body/hand.ts PALM_RINGS): three lanes side by side across the hand, each in two
  // pieces (the thick middle of the hand, the thinner part up to the knuckles); the palm side of
  // each capsule is where the palm's surface is
  const at = (x: number, y: number, z: number): V3 => madd(madd(madd(h.wrist, h.fd, x * q), h.palm, y * q), hj.w, z * q);
  const pieces: [number, number, number][] = [[0.006, 0.05, 0.017], [0.05, 0.086, 0.0142]];
  for (const z of [-0.022, 0, 0.022]) {
    for (const [x0, x1, r] of pieces) {
      // the capsule's centre so that its palm side lies on the palm surface at its far end
      const y = palmSurface(x1) - r;
      add(at(x0, y, z), at(x1, y, z), r, 'palm');
    }
  }
  // fingers
  const names: HandPart[] = ['index', 'middle', 'ring', 'little'];
  hj.fingers.forEach((f, i) => {
    const d = FINGERS[i];
    const [K, J1, J2, T] = f.p;
    if (i === 0) {
      // a pinched cable lies on the side of the middle bone
      add(K, J1, d.r0, 'index');
      add(J1, J2, (d.r0 + d.r1) / 2, 'index', true);
      add(J2, T, d.r1, 'index');
    } else {
      add(K, J1, d.r0, names[i]);
      add(J1, T, (d.r0 + d.r1) / 2, names[i]);
    }
  });
  // the thumb: metacarpal (inside the ball of the thumb), first and last phalanx
  const [B, M, IP, T] = hj.thumb;
  add(B, M, THUMB.r[0] * 0.95, 'thumb');
  add(M, IP, THUMB.r[1], 'thumb');
  add(IP, T, THUMB.r[3] * 1.04, 'thumb', true);
  return out;
}

/**
 * The capsules of a person's hand (side 0 / 'L' left, 1 / 'R' right) and its forearm in a pose:
 * what the cable must stay out of. Rebuild them every frame from the frame's pose.
 */
export function handColliders(pose: Pose, side: 0 | 1 | 'L' | 'R', o: ColliderOptions = {}): HandCapsule[] {
  const i = side === 'L' || side === 0 ? 0 : 1;
  const h = pose.body.hands[i];
  const gloved = (pose.spec.gloves ?? 'none') !== 'none';
  const out = handCapsules(h, i ? 1 : -1, gloved, o);
  if ((o.forearm ?? true) && !o.exclude?.includes('forearm')) {
    const el = pose.joints[i ? 8 : 7];
    const k = pose.body.k * pose.spec.build.limbs;
    // the forearm's middle radius (styles.ts arm tables), a little in from the wrist
    const c: HandCapsule = { a: el, b: madd(h.wrist, h.fd, -0.01 * h.q), r: 0.038 * k + (o.margin ?? 0), part: 'forearm' };
    if (o.mu !== undefined) c.mu = o.mu;
    out.push(c);
  }
  return out;
}
