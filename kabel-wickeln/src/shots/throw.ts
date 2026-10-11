// Stage 1, item 4: a long cable laid out again, done right. Kofi stands on the stage with a long
// over-under ring of XLR (15 m, 16 loops of about Ø 27 cm), its top in his left hand, the stack of
// loops pointing forward (the first loop next to his hand, every later one further out), closed by
// a velcro tie. His right hand pulls the tie's tab out of the eyelet and lets go (the band stays on
// the cable). It takes the front ten loops off the left hand, which keeps the start end and three
// loops loosely in its open hand; one loop hangs between the hands. He swings the right arm back and
// throws the ring underhand towards the mic stand, turned so that its axis lies along the throw: he
// sees the circle. In flight the loops leave the ring one after the other from its back face (the
// side towards him), the free cable trails back to his hand; the loops in his hand run out after
// them. The ring lands near the stand, the cable lies in gentle bends on the floor, without curls
// (the +1 and -1 turns of the über and unter loops cancel). He lets the rest run out after it.
//
// What is guided, what is simulated (KONZEPT: "Die Schlaufen lösen sich von einem geführten Ring,
// simuliert wird das ausgelegte Kabel"): the ring in the right hand and in flight is a rigid bundle
// on a planned path (the swing, then a ballistic arc with a little drag); a loop leaves it, into the
// simulation, whenever the free cable behind it would not reach any more. Everything that has left
// the ring, the loops in his left hand, the landing and the cable on the floor are simulated (XLR
// preset). Kofi's arms come from one RigTrack (people/rig.ts), the single source
// for the bake and the scene; the ring's geometry the rig needs is recorded in the bake ("plan").
//
// Coordinates: Kofi stands at the origin facing +x (his right is +z), the floor at y = 0.

import { Bundle, Quat, Rod, V3, XLR, add, length as len, normalize, quatFromAxisAngle, quatRotate, scale, smooth, sub } from '../sim';
import { KOFI } from '../people/cast';
import { Grip, HandRig, Rig, RigTrack, gripFrame, stand } from '../people/rig';
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
 * The preset's 7.5 mm segments: with 1.25 cm ones the pressed stack lost its alternation (strands
 * passed through each other) and pulling it apart left 1.8 turns. Pressed to 6.4 mm a layer (one
 * cable diameter): pressed harder, sixteen layers sort themselves out of order.
 */
export const LONG_RING: RingSpec = { cable: XLR, loop: 0.88, pattern: 'ou'.repeat(8), lead: 0.4, tail: 0.5, spacing: 0.016, press: 0.6, pressTime: 3 };
/** the loops that stay in his left hand (the first ones, next to the start end) */
export const HAND_LOOPS = 3;
/** the loop that hangs between his hands while he swings (the first one the right hand does not hold) */
const BETWEEN = HAND_LOOPS;
/** the velcro tie: band length, width, thickness; where it lives on the start end (m from the plug's tip) */
export const TIE_K: TieSpec = { length: 0.3, width: 0.02, thickness: 0.0016, s: 0.44 };

/** where Kofi stands and his facing (+x) */
export const KOFI_AT: [number, number] = [0, 0];
export const KOFI_YAW = Math.PI / 2;
/** where the mic stand stands */
export const MIC_AT: V3 = [12.2, 0, 0.62];
/** drawn radius of the cable in the wide view */
export const THROW_WIDE_RADIUS = 0.006;

/** the ring as the factory made it, turned: its stack along +x (forward), the start end to his left (-z) */
const QRING: Quat = quatFromAxisAngle(0, 1, 0, Math.PI / 2);
/** the middle of the bunch at the ring's top, in his left hand */
const HOLD: V3 = [0.4, 1.0, -0.06];

// ---------------------------------------------------------------- the swing and the flight

/**
 * The swing: the grip on an arc round his right shoulder, in a plane 19 cm out to his right (the
 * ring clears his thigh), from 30° behind the vertical (as far back as the shoulder goes without
 * strain, IK probes) through the bottom to the release at 33° in front (a flat throw, along the
 * stage), then the follow-through.
 * Its angular speed grows evenly from rest to the release speed, then falls evenly to rest.
 */
const SWING = { c: [0.03, 1.42, 0.4] as V3, r: 0.52, back: (-30 * Math.PI) / 180, rel: (33 * Math.PI) / 180, follow: (90 * Math.PI) / 180 };
/** speed at the release (m/s): the ring flies about 12 m */
const V_REL = 11;
const W_REL = V_REL / SWING.r;
const SWING_TIME = (2 * (SWING.rel - SWING.back)) / W_REL;
const FOLLOW_TIME = (2 * (SWING.follow - SWING.rel)) / W_REL;
/** horizontal drag of the flying ring (the cable it pulls out), 1/s */
const DRAG = 0.15;
const G = 9.81;
/** the ring touches the floor when its grip point is this high */
const LAND_Y = 0.32;
const BACK_AT = 3.7;
const REL_AT = BACK_AT + SWING_TIME;
/** flight time to the floor */
const FLIGHT = (() => {
  const y0 = SWING.c[1] - SWING.r * Math.cos(SWING.rel), vy = V_REL * Math.sin(SWING.rel);
  return (vy + Math.sqrt(vy * vy + 2 * G * (y0 - LAND_Y))) / G;
})();

/** shot times (s) */
export const THROW_T = {
  /** the right hand to the tie's tab, pinches it, pulls it out of the eyelet, lets go */
  reach: 0.3, pinch: 1.0, unfold: 1.4, letTie: 1.55,
  /** the right hand closes on the front loops; draws them off the left hand to his right (the band's loops leave it) */
  take: 2.4, split: 3.1,
  /** swung back */
  back: BACK_AT,
  /** swings forward and lets go */
  release: REL_AT,
  /** the ring lands */
  land: REL_AT + FLIGHT,
  /** the left hand lets the rest run out after it */
  rest0: REL_AT + FLIGHT + 0.5, rest1: REL_AT + FLIGHT + 1.7,
  end: REL_AT + FLIGHT + 2.9,
};
const T = THROW_T;

const onArc = (phi: number): V3 => [SWING.c[0] + SWING.r * Math.sin(phi), SWING.c[1] - SWING.r * Math.cos(phi), SWING.c[2]];
/** the swing angle at time t (forward swing and follow-through; before it, the back position) */
function swingPhi(t: number): number {
  const t0 = T.release - SWING_TIME;
  if (t <= t0) return SWING.back;
  if (t <= T.release) {
    const u = t - t0;
    return SWING.back + 0.5 * (W_REL / SWING_TIME) * u * u;
  }
  const u = Math.min(t - T.release, FOLLOW_TIME);
  return SWING.rel + W_REL * u - 0.5 * (W_REL / FOLLOW_TIME) * u * u;
}
/** where the ring's grip point is at the release, and its velocity */
const P_REL = onArc(SWING.rel);
const V_RELV: V3 = [V_REL * Math.cos(SWING.rel), V_REL * Math.sin(SWING.rel), 0];
/** the ring's grip point in flight, t ≥ release */
export function flight(t: number): V3 {
  const u = t - T.release;
  return [P_REL[0] + (V_RELV[0] * (1 - Math.exp(-DRAG * u))) / DRAG, P_REL[1] + V_RELV[1] * u - 0.5 * G * u * u, P_REL[2]];
}

// ---------------------------------------------------------------- the plan (recorded in the bake)

const SLOTS = {
  /** the right hand's coil grip on the front loops */
  take: 0,
  /** the tie: centre, half axes (e = +x along the stack, v = up, w = +z along the strands) */
  tieC: 3, tieA: 6, tieB: 7,
  /** the ring's grip point below the hand: the offset of the ring from the right hand's grip (constant) */
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

// ---------------------------------------------------------------- the tie

const TIE_E: V3 = [1, 0, 0], TIE_V: V3 = [0, 1, 0], TIE_W: V3 = [0, 0, 1];
/** the tab stands out forward (along the stack), a little up: his right hand pinches it there */
const TAB: V3 = normalize([1, 0.25, 0]);
const TIE_TIMES = { pinch: T.pinch, unfold: T.unfold, letTie: T.letTie, drop: T.take + 0.25 };

/** the tie at shot time t (deploy-tie.ts); root: the cable it lives on, once the loops have left it */
export function tieShapeK(p: Plan, t: number, root?: { p: V3; d: V3 }): TieShape {
  const g = { c: v3(p, SLOTS.tieC), e: TIE_E, v: TIE_V, w: TIE_W, a: p[SLOTS.tieA], b: p[SLOTS.tieB] };
  return tieAt(g, TIE_K, TIE_TIMES, t, { root, cableR: XLR.od / 2, floorY: 0, tab: TAB });
}

// ---------------------------------------------------------------- Kofi's arms

const ease = (t: number, a: number, b: number) => smooth((t - a) / (b - a));
const lerpV = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
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
/** where the left hand lets the rest run out: forward and down */
const LEFT_REST: Grip = { p: [0.55, 0.85, -0.05], q: LEFT_GRIP.q };
/**
 * The right hand's coil grip: the strands run along +z through it; on the swing arc at angle φ the
 * palm side turns with the arm (from the strands to the palm: (-cos φ, -sin φ, 0)), the comfortable
 * family the IK probes found along the whole arc. Taking the loops it is the one of φ = 0.
 */
const rightQ = (phi: number) => gripFrame([0, 0, 0], [0, 0, 1], [-Math.cos(phi), -Math.sin(phi), 0]).q;
/** the split's side position counts as φ = 45° for the hand */
const SIDE_PHI = Math.PI / 4;
/** the right hand at rest, open, by his right thigh: at the start (as for the pinch it goes to), at the end (as the coil grip it comes from) */
const REST_R: Grip = gripFrame([0.12, 0.86, 0.3], [1, 0, 0], [0, 0.7, -0.7]);
const REST_END: V3 = [0.08, 0.88, 0.3];
/** the bundle of front loops that the right hand holds: its radius in the hand */
const BUNDLE_R = 0.016;

/** where the right hand's grip is during the split and the swing (planned; the ring follows it exactly) */
export function swingPoint(p: Plan, t: number): V3 {
  return swingGrip(p, t).p;
}
/** the right hand's grip frame during the split and the swing (and the angle that turns the hand) */
export function swingGrip(p: Plan, t: number): Grip {
  const take = v3(p, SLOTS.take);
  const side: V3 = [0.3, 0.95, SWING.c[2]];
  if (t < T.take) return { p: take, q: rightQ(0) };
  if (t < T.split) {
    const u = ease(t, T.take + 0.05, T.split);
    return { p: lerpV(take, side, u), q: rightQ(SIDE_PHI * u) };
  }
  const t0 = T.release - SWING_TIME;
  if (t < t0) {
    const u = ease(t, T.split, t0);
    return { p: lerpV(side, onArc(SWING.back), u), q: rightQ(SIDE_PHI + (SWING.back - SIDE_PHI) * u) };
  }
  const phi = swingPhi(t);
  return { p: onArc(phi), q: rightQ(phi) };
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
    // to the front loops (from in front: well clear of the band), closing round them
    const take: Grip = { p: v3(p, SLOTS.take), q: rightQ(0) };
    const pre: Grip = { p: add(take.p, [0.08, 0.04, 0.03]), q: take.q };
    const COIL = { hold: 'coil' as const, radius: BUNDLE_R };
    // (open, the hand turns freely about the strands' direction on the way: the IK finds the easy roll)
    if (t < T.take - 0.45) return { grip: mixGrip(tieGrip(T.letTie), pre, ease(t, T.letTie, T.take - 0.45)), ...COIL, open: 1, free: 1 };
    if (t < T.take) return { grip: mixGrip(pre, take, ease(t, T.take - 0.45, T.take - 0.05)), ...COIL, open: 1 - ease(t, T.take - 0.15, T.take), free: 1 - 0.4 * ease(t, T.take - 0.45, T.take - 0.1) };
    // the split, the swing; after the release it opens
    const open = ease(t, T.release - 0.02, T.release + 0.08);
    if (t < T.release + FOLLOW_TIME + 0.05) return { grip: swingGrip(p, t), ...COIL, open, free: 0.7 };
    // then back down by his side
    const end: Grip = { p: onArc(SWING.follow), q: rightQ(SWING.follow) };
    const u = ease(t, T.release + FOLLOW_TIME + 0.05, T.release + 1.3);
    return { grip: { p: lerpV(end.p, REST_END, u), q: rightQ(SWING.follow + (-0.05 - SWING.follow) * u) }, ...COIL, open: 1, free: 0.7 };
  };
  const left = (t: number): HandRig => {
    // all loops in the hook of the fingers; open a little while the front loops slide out; then
    // loosely round the start end and three loops; out and down to let the rest run out
    const open = 0.55 * ease(t, T.take, T.take + 0.3) - 0.25 * ease(t, T.split, T.split + 0.3) + 0.6 * ease(t, T.land, T.land + 0.3);
    const g = mixGrip(LEFT_GRIP, LEFT_REST, ease(t, T.rest0, T.rest1));
    return { grip: g, hold: 'coil', radius: 0.02 - 0.006 * ease(t, T.take, T.split), open, free: 0.4 };
  };
  const rig = (t: number): Rig => {
    // the chest turns with the swing (back: to the right, through: to the left), leans in a little
    const back = ease(t, T.split, T.release - SWING_TIME), through = ease(t, T.release - SWING_TIME, T.release + 0.15), settle = ease(t, T.release + 0.3, T.release + 1.2);
    const twist = -0.25 * back + 0.4 * through - 0.15 * settle;
    const look: V3 = t < T.take ? [0.42, 1.0, -0.08] : t < T.release - 0.3 ? lerpV([0.42, 1.0, -0.08], [3, 0.3, 0.4], ease(t, T.take, T.split)) : lerpV([3, 0.3, 0.4], [MIC_AT[0], 0.3, MIC_AT[2]], ease(t, T.release - 0.3, T.release + 0.8));
    return { ...stand(KOFI, KOFI_AT, KOFI_YAW, { width: 0.34, stagger: 0.25 }), lean: 0.08 + 0.06 * back, twist, look, hands: [left(t), right(t)] };
  };
  return { rig, left, right };
}

/** the RigTrack the bake and the scene share (60 fps, from 0) */
export const throwTrack = (p: Plan) => new RigTrack(KOFI, throwRig(p).rig, 0, 60);
/** the plan from a bake (the scene) */
export const planFromK = (vector: (name: string, t: number) => ArrayLike<number>): Plan => Float64Array.from(vector('plan', T.end));

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

// ---------------------------------------------------------------- the shot

const LEFT = 0, RIGHT = 1;
const SOFT = { index: 0.3, middle: 0.3, ring: 0.3, little: 0.3, thumb: 0.3 };

export const throwShot: ShotDef = {
  id: 'throw',
  duration: T.end,
  substeps: 60,
  iterations: 3,
  build() {
    const { ring, state, d } = longRing();
    const rod = ringRod(ring, state, LONG_RING);
    rod.opts.maxSpeed = 40;
    const plan: Plan = new Float64Array(SLOTS.size);
    const P = (i: number): V3 => [rod.x[3 * i], rod.x[3 * i + 1], rod.x[3 * i + 2]];
    const C = (j: number): V3 => [rod.c[3 * j], rod.c[3 * j + 1], rod.c[3 * j + 2]];
    /** a point of the ring's top in factory coordinates: x along the strands from the middle, z along the stack */
    const top = (x: number, z = ring.top.c[2]): V3 => placePoint([FIST[0] + x, ring.top.c[1], z], d, QRING);
    const loopOf = (j: number) => {
      const s = rod.sNode[j];
      for (let k = 0; k < ring.sLoops.length; k++) if (s >= ring.sLoops[k][0] && s < ring.sLoops[k][1]) return k;
      return s < ring.sLoops[0][0] ? -1 : ring.sLoops.length;
    };
    const topY = top(0)[1];
    // the right hand's take: the top of the front loops, 8 cm to his right of the bunch's middle
    const frontSegs: number[] = [];
    const tk = top(-0.08);
    for (let j = 0; j < rod.ns; j++) {
      const k = loopOf(j);
      if (k <= BETWEEN || k >= ring.sLoops.length) continue;
      const c = C(j);
      if (c[1] < topY - 0.035 || Math.abs(c[2] - tk[2]) > 0.035) continue;
      frontSegs.push(j);
    }
    let cx = 0, cxn = 0;
    for (const j of frontSegs) {
      cx += C(j)[0];
      cxn++;
    }
    put(plan, SLOTS.take, [cx / Math.max(1, cxn), tk[1], tk[2]]);
    const tc = top(-0.035);
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

    // the left hand holds the top of every loop and the start end (the factory's fist); the
    // pre-roll starts at -1.5 s
    rod.time = -1.5;
    const lh: Bundle = rod.bundle({ frame: (t) => reached(t, LEFT), hand: LEFT, blend: 0.001 });
    for (let j = 0; j < rod.ns; j++) {
      const c = C(j);
      const k = loopOf(j);
      if (k < 0 || k >= ring.sLoops.length) continue;
      if (c[1] < topY - 0.02 || Math.abs(c[2] - HOLD[2]) > 0.03) continue;
      lh.add(rod.sNode[j], rod.sNode[j + 1]);
    }
    // the start end in the hand too (its last 3 cm before the first loop; the plug end hangs out of the hand)
    lh.add(LONG_RING.lead - 0.03, ring.sLoops[0][0]);
    rod.setCapsules((t) => {
      const pose = poseAt(t);
      const body = capsulesOf(pose).filter((c) => c.part === 'torso' || c.part === 'legL' || c.part === 'legR');
      return [...body, ...handColliders(pose, 0, { group: LEFT, soft: SOFT }), ...handColliders(pose, 1, { group: RIGHT, soft: SOFT })];
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

    // the ring in the right hand and in flight: a rigid bundle on the planned path (no turning: its
    // axis stays along the throw)
    const ringFrame = (t: number) => ({ p: t < T.release ? swingPoint(plan, t) : flight(t), q: [0, 0, 0, 1] as Quat });
    let rh: Bundle | null = null;
    /** the loops still in the flying ring (indices), the rearmost first */
    const inRing: number[] = [];
    /** the loops still in the left hand, the outermost first */
    const inHand: number[] = [];
    for (let k = HAND_LOOPS - 1; k >= 0; k--) inHand.push(k);
    let landed = false, split = false;
    const leftEnd = () => ring.sLoops[inHand.length ? inHand[0] : 0][inHand.length ? 1 : 0];
    const script = (r: Rod, t: number) => {
      if (!rh && t >= T.take) {
        rh = r.bundle({ frame: ringFrame, hand: RIGHT, blend: 0.12 });
        for (let k = BETWEEN + 1; k < ring.sLoops.length; k++) inRing.push(k);
        // the front loops' tops (and the end tail's start, which runs with the last loop)
        for (const j of frontSegs) rh.add(r.sNode[j], r.sNode[j + 1]);
      }
      if (!split && t >= T.take + 0.05) {
        // the left hand lets the front loops go (and the one between the hands)
        for (let k = BETWEEN; k < ring.sLoops.length; k++) lh.release(ring.sLoops[k][0], ring.sLoops[k][1], 0.06);
        lh.release(ring.sLoops[ring.sLoops.length - 1][1], ring.sCable[1] + 1, 0.06);
        split = true;
      }
      if (rh && t > T.release) {
        const fp = flight(t);
        // a loop leaves the ring's back when the free cable behind it would not reach any more
        const hand = reached(t, LEFT).p;
        const D = len(sub(fp, hand));
        while (inRing.length) {
          const k = inRing[0];
          const free = ring.sLoops[k][0] - leftEnd();
          if (free > 1.1 * D + 0.5) break;
          rh.release(ring.sLoops[k][0], ring.sLoops[k][1], 0.05);
          inRing.shift();
        }
        if (!inRing.length && rh.ranges().length) rh.release(-Infinity, Infinity, 0.05);
        // landing: whatever is left of the ring goes onto the floor
        if (!landed && fp[1] < 0.34) {
          rh.release(-Infinity, Infinity, 0.05);
          inRing.length = 0;
          landed = true;
        }
        // the loops in the left hand run out after the ring's, when the cable pulls on them
        if (!inRing.length && inHand.length) {
          const tail = P(r.n - 1);
          const D2 = len(sub(tail, hand));
          const free2 = ring.sCable[1] - ring.sLoops[inHand[0]][1];
          if (free2 < 1.06 * D2 + 0.4 || t > T.rest0 + 0.35 * (HAND_LOOPS - inHand.length)) {
            const k = inHand.shift() as number;
            lh.release(ring.sLoops[k][0], ring.sLoops[k][1], 0.05);
          }
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
      curlCache = { t, v: floorCurls(r.x, ring.cable[0], ring.cable[1]) };
      return curlCache.v;
    };
    return {
      rod,
      script,
      tracks: {
        cable0: () => ring.cable[0],
        cable1: () => ring.cable[1],
        tieNode: (r) => r.segmentAt(TIE_K.s),
        twist: (r) => r.twistTurns(),
        writhe: (r) => r.writhe(ring.cable[0], ring.cable[1]),
        low: lowest,
        inRing: () => inRing.length,
        // the cable on the floor: its curls (self-crossings of the floor plan) and tightest bend (m),
        // every quarter second (and at the end)
        curls: (r, t) => curlsAt(r, t).crossings,
        minBend: (r, t) => Math.min(9, curlsAt(r, t).minR),
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
