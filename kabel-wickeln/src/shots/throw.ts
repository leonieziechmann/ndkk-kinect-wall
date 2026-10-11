// Stage 1, item 4: a long cable laid out again, done right. Kofi stands on the stage with a long
// over-under ring of XLR (15 m, 16 loops of Ø 27 cm), its top in his left hand, the stack of loops
// pointing forward (the first loop next to his hand, every later one further out), closed by a
// velcro tie. His right hand pulls the tie's tab out of the eyelet and lets go (the band stays on the
// cable, loose round the loops he keeps). It takes the front eleven loops off the left hand, which
// keeps the start end and three loops loosely in its open hand; two loops hang between the hands.
// He swings the ring forward a little, back (70°, the weight on the back foot, the chest turned
// right), and throws it underhand towards the mic stand, stepping forward with his left foot: the
// forward swing takes 0.4 s and speeds up to the release at 45°. The ring is turned so that its axis
// lies along the throw: he sees the circle. In flight the cable comes off the ring's back face (the
// side towards him), one winding after the other, the way line comes off the end of a spinning-reel
// spool; the free cable trails back to his hand. The ring lands near the stand, the cable lies in
// gentle bends on the floor, without curls (the +1 and -1 turns of the über and unter loops
// cancel). What is left in his hand he keeps, with the end, and draws it back towards his hip: the
// rest he takes along.
//
// What is guided, what is simulated (KONZEPT: "Die Schlaufen lösen sich von einem geführten Ring,
// simuliert wird das ausgelegte Kabel"):
// - In his right hand the ring is a rigid bundle (the hand holds it) on the planned swing.
// - In flight the ring is GUIDED: soft guides hold every node of it on the ring as it was let go,
//   squashed to round over 0.15 s (in free fall nothing pulls the loops long any more; the strands
//   remember the ring round, as it was stored), on a ballistic arc with a little drag, tipping back
//   level and wobbling a little.
// - The cable comes off continuously: a node is let go when the free cable behind it (from the left
//   hand) would no longer reach the ring with some slack, and at the latest on a schedule that empties
//   the ring just before it lands. The let-go cable leaves the back face from where the peel has got
//   to on the circle (a reel's pick-off point): the cable it pays out is simulated.
// - Where an unter loop's successor runs behind it (the over-under weave), that strand is let go as
//   soon as the loop in front of it starts to come off: it is not pinned to the ring, it follows.
// - Guided nodes collide with everything (they are not "held" by a hand): the strand coming off
//   slides over the ring's back face and the woven strands and never passes through them.
// - Everything that has left the ring, the loops in his left hand, the landing and the cable on the
//   floor are simulated (XLR preset).
// Kofi's arms come from one RigTrack (people/rig.ts), the single source for the bake and the scene;
// the ring's geometry the rig needs is recorded in the bake ("plan"). The bake runs 30 substeps per
// frame before the swing and after the landing, 60 from the backswing to the landing.
//
// Coordinates: Kofi stands at the origin facing +x (his right is +z), the floor at y = 0.

import { Bundle, Quat, Rod, V3, XLR, add, length as len, normalize, quatConj, quatFromAxisAngle, quatMul, quatRotate, scale, smooth, sub } from '../sim';
import { KOFI } from '../people/cast';
import { Grip, HandRig, LegRig, Rig, RigTrack, gripFrame, rigPose, stand } from '../people/rig';
import { J } from '../people/people';
import { handColliders } from '../people/colliders';
import { capsulesOf } from '../people/body3d';
import type { Pose } from '../people/people';
import type { ShotDef } from './types';
import { FIST, Ring, RingSpec, placePoint, placeRing, ringRod, windRing } from './deploy-ring';
import { TIE_POINTS, TieShape, TieSpec, tieAt } from './deploy-tie';

export { TIE_POINTS };
export type { TieShape };

/**
 * The ring: 16 loops over-under of 88 cm (Ø 27 cm), the start end 40 cm, the end tail 50 cm: 15 m.
 * The preset's 7.5 mm segments; pressed to 6.4 mm a layer (one cable diameter). Held in a hand-wide
 * fist (8 cm along the strands) and stored lying flat (the strands remember it round): its loops
 * hang about 0.8 as wide as tall from a hand, as the user's do.
 */
export const LONG_RING: RingSpec = { cable: XLR, loop: 0.88, pattern: 'ou'.repeat(8), lead: 0.4, tail: 0.5, spacing: 0.016, press: 0.6, pressTime: 3, fist: 0.04, tear: 0, memoryRound: true };
/** the loops that stay in his left hand (the first ones, next to the start end) */
export const HAND_LOOPS = 3;
/** the first loop of the ring the right hand takes and throws; the two before it hang between his hands (the backswing needs that cable) */
export const RING_FIRST = HAND_LOOPS + 2;
/** the velcro tie: band length, width, thickness; where it lives on the start end (m from the plug's tip) */
export const TIE_K: TieSpec = { length: 0.45, width: 0.02, thickness: 0.0016, s: 0.44 };

/** where Kofi stands and his facing (+x) */
export const KOFI_AT: [number, number] = [0, 0];
export const KOFI_YAW = Math.PI / 2;
/** where the mic stand stands */
export const MIC_AT: V3 = [10.8, 0, 0.4];
/** drawn radius of the cable in the wide view */
export const THROW_WIDE_RADIUS = 0.006;

/** the ring as the factory made it, turned: its stack along +x (forward), the start end to his left (-z) */
const QRING: Quat = quatFromAxisAngle(0, 1, 0, Math.PI / 2);
/** the middle of the bunch at the ring's top, in his left hand */
const HOLD: V3 = [0.32, 1.05, -0.03];

// ---------------------------------------------------------------- shot times

/** the swing (shot seconds): forward a little, back, the throw, the follow-through */
const SW = { start: 4.8, pre: 5.25, back: 5.95, rel: 6.35, follow: 6.55 };
/** swing angles (rad, 0 = the ring hangs below the shoulder, + forward): beside the thigh, the pendulum forward, the backswing, the release */
const PHI = { side: 0.12, pre: 0.45, back: (-62 * Math.PI) / 180, rel: (40 * Math.PI) / 180, follow: (95 * Math.PI) / 180 };
/** the forward swing speeds up like a throw: φ = back + Δ · u^EXP */
const EXP = 3.8;
const W_REL = (EXP * (PHI.rel - PHI.back)) / (SW.rel - SW.back);
/** radius of the arc (shoulder to the grip, the elbow a little bent) and how far out to his right of the shoulder its plane lies (the ring clears his thigh) */
const ARC_R = 0.58, ARC_OUT = 0.17;
const G = 9.81;
/** horizontal drag of the flying ring (the cable it pulls out), 1/s */
const DRAG = 0.15;
/** the ring touches the floor when its grip point (its top) is this high */
const LAND_Y = 0.3;
/** the ring is empty at this fraction of its flight */
const PEEL_DONE = 0.62;

// ---------------------------------------------------------------- Kofi's body

const ease = (t: number, a: number, b: number) => smooth((t - a) / (b - a));
const lerpV = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];

const BASE = stand(KOFI, KOFI_AT, KOFI_YAW, { width: 0.32, stagger: 0.1 });
/**
 * The body through the throw: weight back on the backswing (the pelvis back, the chest turned
 * right, knees bending), then the step forward with the left foot as the arm comes through (the
 * pelvis forward, the chest turning left, leaning in, knees bent), settling after.
 */
function body(t: number) {
  const back = ease(t, SW.pre, SW.back), step = ease(t, SW.back + 0.02, SW.rel + 0.2), settle = ease(t, SW.rel + 0.35, SW.rel + 1.3);
  const pos: [number, number] = [KOFI_AT[0] - 0.06 * back + 0.3 * step - 0.04 * settle, KOFI_AT[1]];
  const drop = 0.04 * back + 0.04 * step - 0.03 * settle;
  const lean = 0.05 + 0.12 * back + 0.06 * step - 0.1 * settle;
  const twist = -0.35 * back + 0.67 * step - 0.17 * settle;
  // the left foot steps 34 cm forward (lifted on the way), the right one stays
  const fl = BASE.feet[0] as { ankle: V3; dir: V3; knee?: V3 };
  const u = ease(t, SW.back + 0.02, SW.rel);
  const left: LegRig = { ...fl, ankle: [fl.ankle[0] + 0.34 * u, fl.ankle[1] + 0.07 * Math.sin(Math.PI * u), fl.ankle[2]] };
  return { pos, yaw: KOFI_YAW, drop, lean, twist, feet: [left, BASE.feet[1]] as [LegRig, LegRig] };
}

/** his right shoulder at time t (the body alone; quantised and cached: the bake asks every substep) */
const shoulderCache = new Map<number, V3>();
function shoulderR(t: number): V3 {
  const k = Math.round(t * 480);
  const hit = shoulderCache.get(k);
  if (hit) return hit;
  const p = rigPose(KOFI, { ...body(k / 480), hands: [null, null] }).joints[J.rightShoulder];
  const s: V3 = [p[0], p[1], p[2]];
  if (shoulderCache.size > 20000) shoulderCache.clear();
  shoulderCache.set(k, s);
  return s;
}

/** the swing angle at time t */
function swingPhi(t: number): number {
  if (t <= SW.start) return PHI.side;
  if (t <= SW.pre) return PHI.side + (PHI.pre - PHI.side) * ease(t, SW.start, SW.pre);
  if (t <= SW.back) return PHI.pre + (PHI.back - PHI.pre) * ease(t, SW.pre, SW.back);
  if (t <= SW.rel) return PHI.back + (PHI.rel - PHI.back) * ((t - SW.back) / (SW.rel - SW.back)) ** EXP;
  // the follow-through slows evenly to rest at PHI.follow
  const tf = (2 * (PHI.follow - PHI.rel)) / W_REL, u = Math.min(t - SW.rel, tf);
  return PHI.rel + W_REL * u - 0.5 * (W_REL / tf) * u * u;
}
const FOLLOW_END = SW.rel + (2 * (PHI.follow - PHI.rel)) / W_REL;
/** the grip on the arc round the shoulder at angle φ (the arc's plane along the throw, ARC_OUT out to his right) */
const onArc = (t: number, phi: number): V3 => {
  const s = shoulderR(t);
  return [s[0] + 0.03 + ARC_R * Math.sin(phi), s[1] - ARC_R * Math.cos(phi), s[2] + ARC_OUT];
};

/** the ring's grip point and velocity at the release (numerically, from the planned swing) */
const P_REL = onArc(SW.rel, PHI.rel);
const V_RELV: V3 = (() => {
  const h = 1e-3, a = onArc(SW.rel - h, swingPhi(SW.rel - h)), b = onArc(SW.rel, swingPhi(SW.rel));
  return scale(sub(b, a), 1 / h);
})();
/** the release speed (m/s) */
export const RELEASE_SPEED = len(V_RELV);
/** the ring's grip point in flight, t ≥ release */
export function flight(t: number): V3 {
  const u = Math.max(0, t - SW.rel), f = (1 - Math.exp(-DRAG * u)) / DRAG;
  return [P_REL[0] + V_RELV[0] * f, P_REL[1] + V_RELV[1] * u - 0.5 * G * u * u, P_REL[2] + V_RELV[2] * f];
}
/** flight time to the floor */
const FLIGHT = (() => {
  const vy = V_RELV[1];
  return (vy + Math.sqrt(vy * vy + 2 * G * (P_REL[1] - LAND_Y))) / G;
})();

/** shot times (s) */
export const THROW_T = {
  /** the right hand to the tie's tab, pinches it, pulls it out of the eyelet, lets go */
  reach: 0.3, pinch: 1.0, unfold: 1.4, letTie: 1.55,
  /** the right hand closes on the front loops; draws them off the left hand to his right side */
  take: 2.4, split: 3.1,
  /** the swing: forward a little, back, through */
  swing: SW.start, pre: SW.pre, back: SW.back,
  /** lets go */
  release: SW.rel,
  /** the ring lands */
  land: SW.rel + FLIGHT,
  /** the left hand goes back towards his hip with the rest */
  rest0: SW.rel + FLIGHT + 0.6, rest1: SW.rel + FLIGHT + 1.8,
  end: SW.rel + FLIGHT + 2.9,
};
const T = THROW_T;

/** the ring's frame: its grip point and how far it is tipped about the throw's horizontal cross axis (+z) */
const ringTilt = (t: number) => {
  if (t < SW.start) return 0;
  if (t <= SW.rel) return 0.45 * (swingPhi(t) - PHI.side);
  // in flight it tips back level and wobbles a little
  const u = t - SW.rel, a0 = 0.45 * (PHI.rel - PHI.side);
  return a0 * Math.exp(-u / 0.3) + 0.06 * Math.sin(2 * Math.PI * 1.6 * u) * (1 - Math.exp(-u / 0.1)) * Math.exp(-u / 1.2);
};
/** a slight yaw wobble in flight */
const ringYaw = (t: number) => (t <= SW.rel ? 0 : 0.05 * Math.sin(2 * Math.PI * 1.1 * (t - SW.rel) + 0.6) * (1 - Math.exp(-(t - SW.rel) / 0.15)));
const ringQ = (t: number): Quat => quatMul(quatFromAxisAngle(0, 1, 0, ringYaw(t)), quatFromAxisAngle(0, 0, 1, ringTilt(t)));

// ---------------------------------------------------------------- the plan (recorded in the bake)

const SLOTS = {
  /** the right hand's coil grip on the front loops */
  take: 0,
  /** the tie: centre, half axes (e = +x along the stack, v = up, w = +z along the strands) */
  tieC: 3, tieA: 6, tieB: 7,
  size: 8,
} as const;
export type Plan = Float64Array;
const v3 = (p: Plan, k: number): V3 => [p[k], p[k + 1], p[k + 2]];
const put = (p: Plan, k: number, v: V3) => {
  p[k] = Math.fround(v[0]);
  p[k + 1] = Math.fround(v[1]);
  p[k + 2] = Math.fround(v[2]);
};

// ---------------------------------------------------------------- the ring

let cached: { ring: Ring; state: ReturnType<typeof placeRing>; d: V3 } | null = null;

/** the long ring, laid out and pressed (deploy-ring.ts), turned and moved so its top is in his left hand */
export function longRing() {
  if (cached) return cached;
  const ring = windRing(LONG_RING);
  const d = sub(HOLD, add(quatRotate(QRING, sub(ring.top.c, FIST)), FIST));
  cached = { ring, state: placeRing(ring.state, d, QRING, 0), d };
  return cached;
}

// ---------------------------------------------------------------- Kofi's arms

const slerpQ = (a: Quat, b: Quat, u: number): Quat => {
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
};
const mixGrip = (a: Grip, b: Grip, u: number): Grip => ({ p: lerpV(a.p, b.p, u), q: slerpQ(a.q, b.q, u) });

/** the left hand's coil grip: the strands run along z through it, the palm over them (IK probes: the comfortable one) */
const LEFT_GRIP = gripFrame(HOLD, [0, 0, 1], [0, 1, 0]);
/** during the throw the left hand comes forward a little (it points the way), with the loops it keeps */
const LEFT_THROW = gripFrame([0.42, 1.1, -0.08], [0, 0, 1], [0, 1, 0]);
/** where the left hand goes with the rest once the ring has landed: back towards his hip, drawing the cable after it */
const LEFT_REST: Grip = { p: [0.3, 0.95, -0.13], q: LEFT_GRIP.q };
/**
 * The right hand's coil grip: the strands run along +z through it; on the swing arc at angle φ the
 * palm side turns with the arm (from the strands to the palm: (-cos φ, -sin φ, 0): the palm faces
 * the way the ring goes), the comfortable family the IK probes found along the whole arc.
 */
const rightQ = (phi: number) => gripFrame([0, 0, 0], [0, 0, 1], [-Math.cos(phi), -Math.sin(phi), 0]).q;
/** the right hand at rest, open, by his right thigh: at the start (as for the pinch it goes to), at the end (as the coil grip it comes from) */
const REST_R: Grip = gripFrame([0.12, 0.86, 0.3], [1, 0, 0], [0, 0.7, -0.7]);
const REST_END: V3 = [0.2, 0.9, 0.3];
/** the bundle of front loops that the right hand holds: its radius in the hand */
const BUNDLE_R = 0.016;

/** the right hand's grip frame from the take to the end of the follow-through (planned; the ring follows it exactly until it is let go) */
export function swingGrip(p: Plan, t: number): Grip {
  const take = v3(p, SLOTS.take);
  if (t < T.take) return { p: take, q: rightQ(0) };
  if (t < T.split) {
    const u = ease(t, T.take + 0.05, T.split);
    return { p: lerpV(take, onArc(t, PHI.side), u), q: slerpQ(rightQ(0), rightQ(PHI.side), u) };
  }
  const phi = swingPhi(t);
  return { p: onArc(t, phi), q: rightQ(phi) };
}
/** where the right hand's grip is (the ring's grip point while it holds it) */
export function swingPoint(p: Plan, t: number): V3 {
  return swingGrip(p, t).p;
}

/** the velcro tie's geometry */
const TIE_E: V3 = [1, 0, 0], TIE_V: V3 = [0, 1, 0], TIE_W: V3 = [0, 0, 1];
/** the tab stands out forward (along the stack), a little up: his right hand pinches it there */
const TAB: V3 = normalize([1, 0.25, 0]);
const TIE_TIMES = { pinch: T.pinch, unfold: T.unfold, letTie: T.letTie, drop: Infinity };

/** the left hand's grip (planned) */
function leftGrip(t: number): Grip {
  return mixGrip(mixGrip(LEFT_GRIP, LEFT_THROW, ease(t, SW.pre, SW.rel)), LEFT_REST, ease(t, T.rest0, T.rest1));
}

/**
 * The tie at shot time t (deploy-tie.ts). It lives on the start end, round the bunch in his left
 * hand: once opened it stays there, loose round the loops he keeps, and moves with that hand.
 */
export function tieShapeK(p: Plan, t: number): TieShape {
  const g = { c: v3(p, SLOTS.tieC), e: TIE_E, v: TIE_V, w: TIE_W, a: p[SLOTS.tieA], b: p[SLOTS.tieB] };
  const s = tieAt(g, TIE_K, TIE_TIMES, t, { cableR: XLR.od / 2, floorY: 0, tab: TAB });
  // with the left hand: its motion since the start, applied to the band
  const g0 = LEFT_GRIP, g1 = leftGrip(t);
  const dq = quatMul(g1.q, quatConj(g0.q));
  const move = (x: V3): V3 => add(g1.p, quatRotate(dq, sub(x, g0.p)));
  return { pts: s.pts.map(move), tip: move(s.tip), side: quatRotate(dq, s.side) };
}

/**
 * Kofi's rig at shot time t for the ring's geometry (plan). Pure: the bake and the scene call it with
 * the same plan and get the same arms (RigTrack).
 */
export function throwRig(p: Plan) {
  const tieGrip = (t: number): Grip => {
    const tip = tieShapeK(p, t).tip;
    return gripFrame(sub(tip, scale(TAB, 0.012)), TAB, [0, 0.7, -0.7]);
  };
  const PINCH = { hold: 'pinch' as const, radius: TIE_K.thickness / 2 };
  const right = (t: number): HandRig => {
    if (t < T.reach) return { grip: REST_R, ...PINCH, open: 1, free: 1 };
    // in front of the ring, to the tab (from in front and a little below), pinch, out of the eyelet, let go
    const g0 = tieGrip(T.pinch), near: Grip = { p: add(g0.p, [0.07, -0.03, 0.05]), q: g0.q };
    const tm = (T.reach + T.pinch) / 2;
    if (t < tm) return { grip: mixGrip(REST_R, near, ease(t, T.reach, tm)), ...PINCH, open: 1, free: 0.4 };
    if (t < T.pinch) return { grip: mixGrip(near, g0, ease(t, tm, T.pinch - 0.05)), ...PINCH, open: 1 - ease(t, T.pinch - 0.2, T.pinch), free: 0.4 };
    if (t < T.letTie) return { grip: tieGrip(t), ...PINCH, open: ease(t, T.unfold, T.letTie), free: 0.4 };
    // to the front loops (from in front: well clear of the band), closing round them. On the way the
    // hand stays an open pinch whose thumb turns from the tab's direction to the strands' (+z), free
    // about it; only near the loops does it become the coil grip (open), so its frame never jumps
    const take: Grip = { p: v3(p, SLOTS.take), q: rightQ(0) };
    const pre: Grip = { p: add(take.p, [0.08, 0.04, 0.03]), q: take.q };
    const COIL = { hold: 'coil' as const, radius: BUNDLE_R };
    if (t < T.take - 0.45) {
      const u = ease(t, T.letTie, T.take - 0.45), a = tieGrip(T.letTie);
      return { grip: { p: lerpV(a.p, pre.p, u), q: slerpQ(a.q, gripFrame([0, 0, 0], [0, 0, 1], [-1, 0, 0]).q, u) }, ...PINCH, open: 1, free: 0.4 + 0.6 * u };
    }
    if (t < T.take) return { grip: mixGrip(pre, take, ease(t, T.take - 0.45, T.take - 0.05)), ...COIL, open: 1 - ease(t, T.take - 0.15, T.take), free: 1 - 0.4 * ease(t, T.take - 0.45, T.take - 0.1) };
    // the split, the swing; at the release it opens
    const open = ease(t, T.release - 0.02, T.release + 0.08);
    if (t < FOLLOW_END + 0.05) return { grip: swingGrip(p, t), ...COIL, open, free: 0.7 + 0.3 * ease(t, SW.start, SW.pre) };
    // then back down to his side
    const end: Grip = { p: onArc(FOLLOW_END, PHI.follow), q: rightQ(PHI.follow) };
    const u = ease(t, FOLLOW_END + 0.05, FOLLOW_END + 1.1);
    return { grip: { p: lerpV(end.p, REST_END, u), q: rightQ(PHI.follow + (-0.05 - PHI.follow) * u) }, ...COIL, open: 1, free: 1 };
  };
  const left = (t: number): HandRig => {
    // all loops in the hook of the fingers; open a little while the front loops slide out; then
    // loosely round the start end and three loops, open while they may run out; with what is left
    // back towards his hip
    const open = 0.55 * ease(t, T.take, T.take + 0.3) - 0.2 * ease(t, T.split, T.split + 0.3) + 0.3 * ease(t, T.release + 0.2, T.release + 0.5) - 0.35 * ease(t, T.rest0, T.rest0 + 0.4);
    return { grip: leftGrip(t), hold: 'coil', radius: 0.02 - 0.006 * ease(t, T.take, T.split), open, free: 0.4 };
  };
  const rig = (t: number): Rig => {
    const look: V3 = t < T.take ? [0.42, 1.0, -0.08] : t < T.swing ? lerpV([0.42, 1.0, -0.08], [MIC_AT[0], 0.5, MIC_AT[2]], ease(t, T.take, T.split)) : lerpV([MIC_AT[0], 0.5, MIC_AT[2]], [MIC_AT[0] - 1, 0.2, MIC_AT[2]], ease(t, T.release, T.land));
    return { ...body(t), look, hands: [left(t), right(t)] };
  };
  return { rig, left, right };
}

/** the RigTrack the bake and the scene share (60 fps, from 0) */
export const throwTrack = (p: Plan) => new RigTrack(KOFI, throwRig(p).rig, 0, 60);
/** the plan from a bake (the scene) */
export const planFromK = (vector: (name: string, t: number) => ArrayLike<number>): Plan => Float64Array.from(vector('plan', T.end));

/** where the ring is at shot time t (its grip point: in the hand, then the planned flight) — for cameras */
export const ringPoint = (p: Plan, t: number): V3 => (t < T.release ? swingPoint(p, t) : flight(Math.min(t, T.land)));

// ---------------------------------------------------------------- the landed cable

/**
 * Curls in the cable lying on the floor: the self-crossings of its floor plan (nodes i0..i1 lower
 * than `maxY`, projected on x-z; a curl or a knot always crosses itself there, gentle bends never),
 * and its tightest bend (radius, m, from three nodes `span` apart). A grid of 3 cm cells keeps it
 * near linear.
 */
export function floorCurls(x: ArrayLike<number>, i0: number, i1: number, maxY = 0.05, span = 4) {
  const cell = 0.03;
  const grid = new Map<string, number[]>();
  const on = (i: number) => x[3 * i + 1] < maxY && x[3 * i + 4] < maxY;
  const key = (a: number, b: number) => `${a},${b}`;
  for (let i = i0; i < i1; i++) {
    if (!on(i)) continue;
    const ax = x[3 * i], az = x[3 * i + 2], bx = x[3 * i + 3], bz = x[3 * i + 5];
    for (let gx = Math.floor(Math.min(ax, bx) / cell); gx <= Math.floor(Math.max(ax, bx) / cell); gx++)
      for (let gz = Math.floor(Math.min(az, bz) / cell); gz <= Math.floor(Math.max(az, bz) / cell); gz++) {
        const k = key(gx, gz);
        const l = grid.get(k);
        if (l) l.push(i);
        else grid.set(k, [i]);
      }
  }
  const seen = new Set<number>();
  let crossings = 0;
  const cr = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  for (const l of grid.values()) {
    for (let p = 0; p < l.length; p++)
      for (let q = p + 1; q < l.length; q++) {
        const i = Math.min(l[p], l[q]), j = Math.max(l[p], l[q]);
        if (j - i < 2) continue;
        const id = i * 100000 + j;
        if (seen.has(id)) continue;
        seen.add(id);
        const ax = x[3 * i], az = x[3 * i + 2], bx = x[3 * i + 3], bz = x[3 * i + 5];
        const cx = x[3 * j], cz = x[3 * j + 2], dx = x[3 * j + 3], dz = x[3 * j + 5];
        const d1 = cr(ax, az, bx, bz, cx, cz), d2 = cr(ax, az, bx, bz, dx, dz), d3 = cr(cx, cz, dx, dz, ax, az), d4 = cr(cx, cz, dx, dz, bx, bz);
        if (d1 * d2 < 0 && d3 * d4 < 0) crossings++;
      }
  }
  let minR = Infinity;
  for (let i = i0 + span; i + span <= i1; i++) {
    if (!on(i - span) || !on(i + span - 1)) continue;
    const a = [x[3 * (i - span)], x[3 * (i - span) + 2]], b = [x[3 * i], x[3 * i + 2]], c = [x[3 * (i + span)], x[3 * (i + span) + 2]];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]), ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const area2 = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    if (area2 > 1e-12) minR = Math.min(minR, (ab * bc * ca) / (2 * area2));
  }
  return { crossings, minR };
}

/** the twist (turns) in windows of `win` m along the cable proper (the largest |value| tells a twisted zone) */
export function twistWindows(rod: Rod, j0: number, j1: number, win = 2): number[] {
  const out: number[] = [];
  const s0 = rod.sNode[j0], s1 = rod.sNode[j1];
  for (let a = s0; a < s1 - 0.25 * win; a += win / 2) {
    const ja = rod.segmentAt(a), jb = Math.min(j1, rod.segmentAt(Math.min(s1, a + win)));
    out.push(rod.twistTurns(ja, jb));
  }
  return out;
}

// ---------------------------------------------------------------- the shot

const LEFT = 0, RIGHT = 1;
const SOFT = { index: 0.3, middle: 0.3, ring: 0.3, little: 0.3, thumb: 0.3 };

export const throwShot: ShotDef = {
  id: 'throw',
  duration: T.end,
  substeps: 30,
  iterations: 3,
  build() {
    const { ring, state, d } = longRing();
    const rod = ringRod(ring, state, LONG_RING);
    rod.opts.maxSpeed = 40;
    // finer steps from the backswing to the landing (the swing and the flight are fast)
    const step0 = rod.step.bind(rod);
    rod.step = (dt: number, n?: number) => step0(dt, rod.time >= SW.pre - 0.1 && rod.time <= T.land + 0.8 ? 60 : n);
    const plan: Plan = new Float64Array(SLOTS.size);
    const P = (i: number): V3 => [rod.x[3 * i], rod.x[3 * i + 1], rod.x[3 * i + 2]];
    const C = (j: number): V3 => [rod.c[3 * j], rod.c[3 * j + 1], rod.c[3 * j + 2]];
    /** a point of the ring's top in factory coordinates: x along the strands from the middle, z along the stack */
    const top = (x: number, z = ring.top.c[2]): V3 => placePoint([FIST[0] + x, ring.top.c[1], z], d, QRING);
    const sLoop = ring.sLoops;
    const N = sLoop.length;
    const loopOf = (s: number) => {
      for (let k = 0; k < N; k++) if (s >= sLoop[k][0] && s < sLoop[k][1]) return k;
      return s < sLoop[0][0] ? -1 : N;
    };
    // the right hand's take: the front loops beside the left hand, 11 cm to his right of the bunch's middle
    const tk = top(-0.11);
    let cx = 0, cy = 0, cn = 0;
    for (let j = 0; j < rod.ns; j++) {
      const k = loopOf(rod.sNode[j] + rod.L[j] / 2);
      if (k < RING_FIRST || k >= N) continue;
      const c = C(j);
      if (c[1] < tk[1] - 0.09 || Math.abs(c[2] - tk[2]) > 0.02) continue;
      cx += c[0];
      cy = Math.max(cy, c[1]);
      cn++;
    }
    put(plan, SLOTS.take, [cx / Math.max(1, cn), cy - 0.005, tk[2]]);
    const tc = top(-0.052);
    put(plan, SLOTS.tieC, tc);

    const track = throwTrack(plan);
    const poseCache = new Map<number, Pose>();
    const poseAt = (t: number): Pose => {
      let q = poseCache.get(t);
      if (!q) {
        if (poseCache.size > 8) poseCache.clear();
        q = track.pose(Math.max(0, t));
        poseCache.set(t, q);
      }
      return q;
    };
    const reached = (t: number, side: 0 | 1) => {
      const g = poseAt(t).body.arms?.[side].grip;
      return g ? { p: g.p, q: g.q } : { p: [0, 0, 0] as V3, q: [0, 0, 0, 1] as Quat };
    };

    // the left hand holds the top of every loop as the factory's fist did, and the last 4 cm of the
    // start end (the plug end hangs out of the hand); the pre-roll starts at -1.5 s
    rod.time = -1.5;
    const lh: Bundle = rod.bundle({ frame: (t) => reached(t, LEFT), hand: LEFT, blend: 0.001 });
    for (const [a, b] of ring.held) if (b > LONG_RING.lead - 0.04) lh.add(Math.max(a, LONG_RING.lead - 0.04), b);
    rod.setCapsules((t) => {
      const pose = poseAt(t);
      const body = capsulesOf(pose).filter((c) => c.part === 'torso' || c.part === 'legL' || c.part === 'legR');
      // (the right hand's capsules are off while it goes into the coil and closes on the front loops:
      // it must not plough through them; from then on the strands in its fist are held by it)
      const off = t > T.letTie + 0.1 && t < T.take + 0.12;
      return [...body, ...handColliders(pose, 0, { group: LEFT, soft: SOFT }), ...handColliders(pose, 1, { group: RIGHT, soft: SOFT, disable: off ? () => true : undefined })];
    });
    for (let f = 0; f < 90; f++) rod.step(1 / 60, 40);
    rod.time = 0;
    // the tie's ellipse round the strands at its place, as they hang now
    let a = 0, b = 0;
    for (let i = ring.cable[0]; i <= ring.cable[1]; i++) {
      const q = sub(P(i), tc);
      if (Math.abs(q[2]) > 0.005 || q[1] < -0.03 || Math.abs(q[0]) > 0.08) continue;
      a = Math.max(a, Math.abs(q[0]));
      b = Math.max(b, Math.abs(q[1]));
    }
    plan[SLOTS.tieA] = Math.fround(a + ring.rc + 0.002);
    plan[SLOTS.tieB] = Math.fround(Math.max(b, 2 * ring.rc) + ring.rc + 0.002);

    // ------------------------------------------------ the ring in the right hand, then in flight
    // From the take on the front loops (and the end tail) are GUIDED: soft guides hold every node of
    // them where it was when the hand took them, in the frame of the hand's grip (tipped with the
    // swing); after the release the frame flies on the planned arc and the shape turns, in 0.15 s,
    // into the ring as it lay stored (round, its layers a little looser). Guided nodes collide with
    // everything: nothing passes through them, nothing of them through anything.
    const ringFrame = (t: number) => ({ p: ringPoint(plan, t), q: ringQ(t) });
    const sRing0 = sLoop[RING_FIRST][0], sRing1 = sLoop[N - 1][1];
    const nRing0 = rod.segmentAt(sRing0), nEnd = rod.n - 1;
    /** each guided node's place in the ring's frame: as taken (A), as stored (B) */
    let A: Float64Array | null = null, B: Float64Array | null = null;
    /** the free cable reaches from the end of the left hand's loops */
    const sHandEnd = sLoop[HAND_LOOPS - 1][1];
    /** where the peel has got to (material coordinate): every node of the ring below it is free */
    const peelAt = (t: number) => {
      if (t < T.release) return sRing0;
      // enough cable for the way from the left hand to the ring, with some slack …
      const need = sHandEnd + 1.15 * len(sub(flight(t), leftGrip(t).p)) + 0.6;
      // … and the ring empty well before it lands: its last loops and the end fly on ahead and lie
      // down stretched out (emptied just before the landing they would land in a heap)
      const lin = sRing0 + (sRing1 - sRing0) * Math.min(1, (t - T.release) / (PEEL_DONE * (T.land - T.release)));
      return Math.min(sRing1 + 0.01, Math.max(sRing0, need, lin));
    };
    /** woven strands (an unter loop's successor, behind it): free once the loop in front of them starts to come off */
    const woven: [number, number, number][] = [];
    for (let k = RING_FIRST; k < N - 1; k++) if (LONG_RING.pattern[k] === 'u') woven.push([sLoop[k][0] - 0.05, sLoop[k + 1][0], sLoop[k + 1][0] + 0.62 * LONG_RING.loop]);
    const sN = rod.sNode;
    /** free: peeled, a woven strand whose loop in front is coming off, or (once thrown) the end tail */
    const isFree = (s: number, t: number) => {
      if (t < T.release) return false;
      const sp = peelAt(t);
      return s < sp || s > sRing1 || woven.some(([at, w0, w1]) => sp >= at && s >= w0 && s <= w1);
    };
    let guide = -1, landed = false, taken = false;
    /** the strands in the right hand's fist: held by it (its capsules let them through) until it lets go */
    let fist: Bundle | null = null;

    /** the loops still in the left hand (indices), the outermost first */
    const inHand: number[] = [];
    for (let k = HAND_LOOPS - 1; k >= 0; k--) inHand.push(k);
    let split = false;
    const script = (r: Rod, t: number) => {
      if (!taken && t >= T.take) {
        // the right hand takes the front loops as they hang now; the ring as it lay stored, in the
        // same frame (placed as the shot placed the ring), its layers 15 % looser along the stack
        const F = ringFrame(t), qi = quatConj(F.q);
        const m = nEnd - nRing0 + 1;
        A = new Float64Array(3 * m);
        B = new Float64Array(3 * m);
        let mx = 0;
        for (let i = nRing0; i <= nEnd; i++) {
          A.set(quatRotate(qi, sub(P(i), F.p)), 3 * (i - nRing0));
          const pr = placePoint([ring.pressed[3 * i], ring.pressed[3 * i + 1], ring.pressed[3 * i + 2]], d, QRING);
          B.set(quatRotate(qi, sub(pr, F.p)), 3 * (i - nRing0));
          mx += B[3 * (i - nRing0)] / m;
        }
        for (let k = 0; k < m; k++) B[3 * k] = mx + (B[3 * k] - mx) * 1.15;
        const AA = A, BB = B;
        guide = r.addGuide({
          nodes: [nRing0, nEnd],
          compliance: 1e-4,
          weight: (tt) => smooth((tt - T.take) / 0.2),
          target: (i, tt) => {
            if (isFree(sN[i], tt)) return null;
            const F2 = ringFrame(tt), u = smooth((tt - T.release) / 0.15), o = 3 * (i - nRing0);
            const l: V3 = [AA[o] + (BB[o] - AA[o]) * u, AA[o + 1] + (BB[o + 1] - AA[o + 1]) * u, AA[o + 2] + (BB[o + 2] - AA[o + 2]) * u];
            return add(F2.p, quatRotate(F2.q, l));
          },
        });
        // the strands in the fist (within 5 cm of the grip point) are held by the hand
        // (in the ring's frame, as the guides: the strands in the fist and the rest of the ring move as one)
        fist = r.bundle({ frame: ringFrame, hand: RIGHT, blend: 0.1 });
        const g0 = ringFrame(t).p;
        for (let j = nRing0; j < r.ns; j++) {
          const c = C(j);
          if (len(sub(c, g0)) < 0.05) fist.add(r.sNode[j], r.sNode[j + 1], 0.1);
        }
        taken = true;
      }
      if (fist && t >= T.release) {
        // the hand opens: the guides alone hold the ring now
        fist.remove();
        fist = null;
      }
      if (!split && t >= T.take + 0.05) {
        // the left hand lets the front loops go (and the two between the hands)
        for (let k = HAND_LOOPS; k < N; k++) lh.release(sLoop[k][0], sLoop[k][1], 0.06);
        lh.release(sLoop[N - 1][1], ring.sCable[1] + 1, 0.06);
        split = true;
      }
      if (taken && !landed && (peelAt(t) >= sRing1 || flight(t)[1] < LAND_Y) && t > T.release) {
        r.removeGuide(guide);
        landed = true;
      }
      // the loops in the left hand run out after the ring's, when the cable pulls on them (what is
      // left he keeps in the hand, with the end: the rest he takes along)
      if (t > T.release && inHand.length) {
        const hand = reached(t, LEFT).p;
        const tail = P(r.n - 1);
        const D2 = len(sub(tail, hand));
        const free2 = ring.sCable[1] - sLoop[inHand[0]][1];
        if (free2 < 1.06 * D2 + 0.4) {
          const k = inHand.shift() as number;
          lh.release(sLoop[k][0], sLoop[k][1], 0.05);
        }
      }
    };
    const lowest = (r: Rod) => {
      let m = Infinity;
      for (let i = ring.cable[0]; i <= ring.cable[1]; i++) m = Math.min(m, r.x[3 * i + 1]);
      return m;
    };
    const arm = (t: number, side: 0 | 1) => poseAt(t).body.arms?.[side].report;
    let curlCache = { t: -1, v: { crossings: 0, minR: 9 } };
    const curlsAt = (r: Rod, t: number) => {
      if (curlCache.t >= 0 && t - curlCache.t < 0.24 && t < T.end - 0.01) return curlCache.v;
      // (the bend radius is not counted in the last 5 cm before each plug: the plug's own bend)
      const i0 = r.segmentAt(r.sNode[ring.cable[0]] + 0.05), i1 = r.segmentAt(r.sNode[ring.cable[1]] - 0.05);
      curlCache = { t, v: floorCurls(r.x, i0, i1) };
      return curlCache.v;
    };
    const j0 = ring.cable[0], j1 = ring.cable[1] - 1;
    // twist and writhe once per recorded frame; the largest jump of their sum (the linking number of
    // the cable with its ends' frames) between two frames: a strand passing through another
    // changes it by ±2 at once, nothing else by more than a few hundredths
    // (the jump is measured on the cable beyond the loops in his left hand, from the take on: strands
    // a hand holds may overlap a little — they do not push each other — and their writhe flickers)
    let twr = { t: NaN, tw: 0, wr: 0 }, lkPrev: number | null = null, lkMax = 0;
    const jFree = rod.segmentAt(sHandEnd);
    const tw_wr = (r: Rod, t: number) => {
      if (twr.t !== t) {
        twr = { t, tw: r.twistTurns(), wr: r.writhe(ring.cable[0], ring.cable[1]) };
        if (t >= T.take + 0.3) {
          const lk = r.twistTurns(jFree, r.ns - 1) + r.writhe(jFree, ring.cable[1]);
          if (lkPrev !== null) lkMax = Math.max(lkMax, Math.abs(lk - lkPrev));
          lkPrev = lk;
        }
      }
      return twr;
    };
    return {
      rod,
      script,
      tracks: {
        cable0: () => ring.cable[0],
        cable1: () => ring.cable[1],
        tieNode: (r) => r.segmentAt(TIE_K.s),
        twist: (r, t) => tw_wr(r, t).tw,
        writhe: (r, t) => tw_wr(r, t).wr,
        /** the largest jump of twist + writhe between two frames so far (turns): ≥ 1 is a strand passage */
        lkJump: (r, t) => (tw_wr(r, t), lkMax),
        low: lowest,
        /** how much of the ring has come off (0 … 1) */
        peel: (_, t) => (Math.min(sRing1, peelAt(t)) - sRing0) / (sRing1 - sRing0),
        // the cable on the floor: its curls (self-crossings of the floor plan) and tightest bend (m),
        // every quarter second (and at the end)
        curls: (r, t) => curlsAt(r, t).crossings,
        minBend: (r, t) => Math.min(9, curlsAt(r, t).minR),
        /** the largest |twist| in any 2 m of the cable (turns) */
        twistMax: (r) => Math.max(...twistWindows(r, j0, j1).map(Math.abs)),
        inHand: () => inHand.length,
        ikL: (_, t) => (arm(t, 0)?.posError ?? 0) * 1000,
        ikR: (_, t) => (arm(t, 1)?.posError ?? 0) * 1000,
        axL: (_, t) => ((arm(t, 0)?.axisErrors[0] ?? 0) * 180) / Math.PI,
        axR: (_, t) => ((arm(t, 1)?.axisErrors[0] ?? 0) * 180) / Math.PI,
      },
      vectors: {
        plan: { size: SLOTS.size, fn: () => plan },
      },
    };
  },
};
