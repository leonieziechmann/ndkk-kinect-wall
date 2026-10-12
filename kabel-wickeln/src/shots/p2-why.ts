// Stage 2 (Warum): a short patch cable coiled in six loops, wound the same way every time (Teo) or
// over-under (Robin), pulled apart by its ends; and, for the first look, one über loop, one unter
// loop and one pair alone.
//
// Where the twist comes from (no fake): the rings are the over-under / same-way rings of the ring
// factory (deploy-ring.ts windRing: the loops laid on a rod, the crossings woven as the winding
// leaves them, no twist along the cable), pressed and stored, and they are pulled apart the way the
// factory's own check does it (deploy-ring.ts pullApart, the test that gives over-under ≈ 0 and
// same-way ≈ one turn per loop): both ends held so they cannot turn ("Enden fest": the start end in
// the left hand, the end in the right fist), the loops let go at once, the ends pulled apart in the
// ring's plane, forearms beyond the ends so no loop slips off over an end. Nothing in the
// simulation is told to twist: a same-way loop pulled straight becomes one turn of twist (writhe →
// twist, the linking number of the cable between the hands stays), an über and an unter loop turn
// opposite ways. The counters of the scene are the measured twist (track "tw", turns between the
// hands). Then both hands come 40 cm together: the stored twist is free to become writhe again (a
// curl, then the two halves wrap round each other); Teo pulls again (the curl closes into a kink,
// kept by the strand friction: plastic memory) and lets go loosely.
//
// The cable: the user's XLR preset (Ø 6.4 mm, 42 g/m, strand friction, damping, its GJ 0.8e-4 N m²),
// with one change from the taut hold on (RING_T.stiff): the torsional stiffness becomes that of the
// stuck strands, 0.8 × (EI + frictionEI) = 1.6e-3 N m² (WHY_GJ, the value the physics report
// proposes). Why two values (the tests are in the report of this part):
//   - with the preset's GJ the loops come out as twist, as they should (Teo ≈ 6 turns between the
//     hands when taut, Robin ≈ 0), but 6 turns of twist then sit in a slack cable without a single
//     curl: the twisting moment (GJ·τ ≈ 2.4e-3 N m) never beats the stuck strands' bending (yield
//     3e-3 N m), which no stage cable does;
//   - with 1.6e-3 from the start every loop turns into a curl that tightens into a kink under the
//     pull (a cheap plastic hinge against an expensive extra turn of twist), and the solver lets some
//     of those tight kinks pass through themselves: 2-3 turns instead of 6 when taut.
// No single GJ does both in this model, so the loops come out with the preset's and the hold, the
// slack and the kink run with the stuck strands' (switched while the cable is straight and taut,
// where it changes nothing visible). The demos (p2-one, p2-under, p2-pair) use the preset only.
// Contacts are resolved finer than the preset's default (5 mm segments, contact radius 3.6 mm, 3
// iterations, 40 substeps): a curl pulled tight is where coarse contacts let a strand slip through.
//
// The people's arms (RigTrack) reach for the same frames the simulation's ends follow; the
// simulation sees forearm capsules beyond the plugs (as pullApart) and the body, not the fingers.
//
// Coordinates (person-local; the scene places each person): the person stands at the origin facing
// -z (yaw 0, their right is +x), hands at chest height in front. The ring's face looks at the camera
// in front of the person; the start end sticks out of the left hand to the left.

import { Bundle, Capsule, Frame, Quat, Rod, V3, XLR, add, length as len, normalize, quatFromAxisAngle, quatFromTo, quatRotate, quatSlerp, scale, smooth, sub } from '../sim';
import { ROBIN, TEO } from '../people/cast';
import type { PersonSpec, Pose } from '../people/people';
import { Grip, HandRig, Rig, RigTrack, gripFrame, stand } from '../people/rig';
import { capsulesOf } from '../people/body3d';
import { tightestBend } from './kink';
import type { ShotDef } from './types';
import { FIST, RingSpec, placeRing, ringRod, windRing } from './deploy-ring';

/** torsional stiffness of the stuck strands (see the header): 0.8 × (EI + frictionEI) of the XLR preset */
export const WHY_GJ = 0.8 * (XLR.EI + (XLR.plastic?.frictionEI ?? 0));
/**
 * The settings (the tests change them before building a shot): torsional stiffness while the loops
 * come out and from the taut hold on, segment length, contact radius, solver iterations, substeps
 * per 1/60 s
 */
export const WHY_CFG = { GJ: XLR.GJ, GJ_HOLD: WHY_GJ, SEG: 0.005, RC: 0.0036, ITER: 3, SUB: 40 };

/**
 * A 1.56 m patch cable in six loops of 19 cm (Ø 5.9 cm): 16 cm before the first loop (the start end:
 * plug and 10 cm of cable, the left hand holds the plug and 7 cm), 26 cm after the last (the end:
 * it hangs out of the ring below it, the right fist holds the plug and 9 cm). 1.28 m between the
 * hands, so "almost taut" is 1.25 m apart (KONZEPT: 1.8 m and Ø 9–10 cm loops cannot be pulled
 * almost taut with hands 1.2 m apart; the recording plan takes 1.5 m).
 */
export const whyRing = (pattern: string, tail = 0.26): RingSpec => ({
  cable: XLR,
  loop: 0.19,
  pattern,
  lead: 0.16,
  tail,
  spacing: 0.014,
  press: 0.75,
  pressTime: 3,
  segment: WHY_CFG.SEG,
  rod: { GJ: WHY_CFG.GJ, collisionRadius: WHY_CFG.RC },
});

/** cable held rigidly past each plug (plug included): left, right */
export const HOLD_L = 0.07, HOLD_R = 0.09;

// ---------------------------------------------------------------- choreography

export type WhyKind = 'teo' | 'robin' | 'one' | 'under' | 'pair';
const isDemo = (kind: WhyKind) => kind === 'one' || kind === 'under' || kind === 'pair';

/**
 * Shot times (s) of the ring shots: the end comes out of the ring to the right (side), the left hand
 * lets the loops go (free, the ring hangs between the hands), the pull, the stiffness switch, 40 cm
 * together, (Teo) pulled again, loosely together. The cues of the recordings p2.teo.pull /
 * p2.robin.pull (2 / 6 / 9 / 12 / 15 / 17 s) are stretched to these.
 */
export const RING_T = { side0: 0.3, side1: 1.2, free: 1.3, pull0: 2.0, pull1: 6.0, stiff: 6.6, tog0: 12.5, tog1: 13.9, re0: 18.0, re1: 19.3, loose0: 20.3, loose1: 21.3, end: 28.0 };
/** the demo of one loop / one pair (p2.oneloop) */
export const DEMO_T = { side0: 0.1, side1: 0.6, free: 0.65, pull0: 0.8, pull1: 2.6, end: 3.6 };
const timesOf = (kind: WhyKind) => (isDemo(kind) ? DEMO_T : RING_T);

const ease = (t: number, a: number, b: number) => smooth((t - a) / (b - a));
const mix3 = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];

/** chest-height centre between the hands, person-local */
const centre = (spec: PersonSpec): V3 => [0, 0.655 * spec.height, -0.34];

/**
 * The plan recorded in the bake (the scene builds the same rig from it): the start of both holds
 * (frame points), the cable direction into the cable at each (from the plug), where the end comes out
 * of the ring to (side), the cable between the holds, the first node of every loop (and the node
 * after the last loop), the ring's top.
 */
const SLOTS = { a0: 0, b0: 3, dA: 6, dB: 9, side: 12, between: 15, loops: 16, top: 23, size: 26 } as const;
export type Plan = Float64Array;
const v3 = (p: Plan, k: number): V3 => [p[k], p[k + 1], p[k + 2]];

/** the first node of loop k (k = number of loops: the node after the last loop) */
export const loopNode = (p: Plan, k: number) => Math.round(p[SLOTS.loops + k]);
/** the ring's top (the middle of the bunch the fingers hold before they let go) */
export const ringTop = (p: Plan): V3 => v3(p, SLOTS.top);
/** how many loops */
export const loopsOf = (kind: WhyKind) => (kind === 'one' || kind === 'under' ? 1 : kind === 'pair' ? 2 : 6);

/** the hands' distance after the end has come out to the side */
export function spanOf(kind: WhyKind, p: Plan) {
  const between = p[SLOTS.between];
  const s0 = len(sub(v3(p, SLOTS.side), v3(p, SLOTS.a0)));
  const TAUT = between - 0.03, TOG = TAUT - 0.4, RE = TOG + 0.3, LOOSE = TOG + 0.08;
  if (isDemo(kind)) return (t: number) => s0 + (TAUT - s0) * ease(t, DEMO_T.pull0, DEMO_T.pull1);
  const T = RING_T, re = kind === 'teo';
  return (t: number) => {
    if (t < T.tog0) return s0 + (TAUT - s0) * ease(t, T.pull0, T.pull1);
    if (t < T.re0) return TAUT + (TOG - TAUT) * ease(t, T.tog0, T.tog1);
    if (!re) return TOG;
    if (t < T.loose0) return TOG + (RE - TOG) * ease(t, T.re0, T.re1);
    return RE + (LOOSE - RE) * ease(t, T.loose0, T.loose1);
  };
}

/** the person each shot shows */
export const personOf = (kind: WhyKind): PersonSpec => (kind === 'robin' ? ROBIN : TEO);

/** palms: the left fist's towards the body and down, the right fist's too */
const PALM_L: V3 = normalize([0.1, -0.5, 0.85]);
const PALM_R: V3 = normalize([-0.1, -0.5, 0.85]);

/**
 * The frames the simulation's held ends follow (p: the hold's frame point, q: the turn of the held
 * piece from where it lay at the start), the same for bake and scene. Left: still until the pull,
 * then out to the left on the line through the chest centre, the held start end turning so that the
 * cable leaves it to the right. Right: the end is drawn out of the ring to its right (side), turning
 * so the cable leaves the fist to the left, then out to the right on the same line.
 */
export function holdsOf(kind: WhyKind, p: Plan) {
  const T = timesOf(kind);
  const c = centre(personOf(kind));
  const span = spanOf(kind, p);
  const A0 = v3(p, SLOTS.a0), B0 = v3(p, SLOTS.b0), S = v3(p, SLOTS.side);
  const dA = v3(p, SLOTS.dA), dB = v3(p, SLOTS.dB);
  const qA = quatFromTo(dA, [1, 0, 0]), qB = quatFromTo(dB, [-1, 0, 0]);
  const I: Quat = [0, 0, 0, 1];
  const u0 = normalize(sub(S, A0)), m0 = scale(add(A0, S), 0.5);
  /** the line the hands pull along: from where they are towards the chest line (+x) */
  const line = (t: number) => {
    const u = ease(t, T.pull0, T.pull0 + 1.2);
    return { m: mix3(m0, c, u), d: normalize(mix3(u0, [1, 0, 0], u)) };
  };
  const left = (t: number): Frame => {
    if (t <= T.pull0) return { p: A0, q: quatSlerp(I, qA, 0.25 * ease(t, T.side0, T.pull0)) };
    const l = line(t), s = span(t);
    return { p: add(l.m, scale(l.d, -s / 2)), q: quatSlerp(I, qA, 0.25 + 0.75 * ease(t, T.pull0, T.pull0 + 1.2)) };
  };
  const right = (t: number): Frame => {
    if (t <= T.pull0) {
      const u = ease(t, T.side0, T.side1);
      // up and out of the ring to the right, a little arc
      const pp = mix3(B0, S, u);
      return { p: [pp[0], pp[1] + 0.03 * Math.sin(Math.PI * u), pp[2]], q: quatSlerp(I, qB, u) };
    }
    const l = line(t), s = span(t);
    return { p: add(l.m, scale(l.d, s / 2)), q: qB };
  };
  /** where each hand grips (rig grip frames): the held cable's direction turned with the hold */
  const gripL = (t: number): Grip => {
    const f = left(t);
    return gripFrame(add(f.p, quatRotate(f.q, scale(dA, -0.035))), quatRotate(f.q, dA), PALM_L);
  };
  const gripR = (t: number): Grip => {
    const f = right(t);
    return gripFrame(add(f.p, quatRotate(f.q, scale(dB, -0.045))), quatRotate(f.q, dB), PALM_R);
  };
  return { left, right, gripL, gripR };
}

/** the person's rig at shot time t (pure: bake and scene build the same RigTrack from the plan) */
export function whyRig(kind: WhyKind, p: Plan) {
  const spec = personOf(kind);
  const h = holdsOf(kind, p);
  const T = timesOf(kind);
  const top = ringTop(p);
  return (t: number): Rig => {
    const left: HandRig = { grip: h.gripL(t), hold: 'fist', radius: XLR.od / 2, wrap: 0.6, free: 0.3 };
    const right: HandRig = { grip: h.gripR(t), hold: 'fist', radius: XLR.od / 2, wrap: 0.6, free: 0.3 };
    // idle sway (the feet stay): the upper body leans and turns a little; the look: the ring, then the cable's middle
    const ph = kind === 'robin' ? 1.3 : 0;
    const mid = scale(add(h.left(t).p, h.right(t).p), 0.5);
    const look = mix3(top, [mid[0], mid[1] - 0.12, mid[2]], ease(t, T.free, T.pull0 + 0.5));
    return {
      ...stand(spec, [0, 0.02], 0, { width: 0.3 }),
      lean: 0.06 + 0.012 * Math.sin(0.7 * t + ph),
      bend: 0.02 * Math.sin(0.45 * t + ph),
      twist: 0.025 * Math.sin(0.33 * t + 2 * ph),
      look,
      hands: [left, right],
    };
  };
}

export const whyTrack = (kind: WhyKind, p: Plan) => new RigTrack(personOf(kind), whyRig(kind, p), 0, 60);

/** the plan from a bake (the scene) */
export const planFrom = (vector: (name: string, t: number) => ArrayLike<number>): Plan => Float64Array.from(vector('plan', 0));

// ---------------------------------------------------------------- the ring

/** the ring turned half round: its face towards the front of the person, the start end sticking out to the left (-x) */
const QRING: Quat = quatFromAxisAngle(0, 1, 0, Math.PI);

const patternOf = (kind: WhyKind) => (kind === 'teo' ? 'oooooo' : kind === 'robin' ? 'ououou' : kind === 'one' ? 'o' : kind === 'under' ? 'u' : 'ou');
/** demo cables: the end long enough that the hands end half a metre apart */
const tailOf = (kind: WhyKind) => (kind === 'one' || kind === 'under' ? 0.42 : kind === 'pair' ? 0.34 : 0.26);
export const ringSpecOf = (kind: WhyKind) => whyRing(patternOf(kind), tailOf(kind));

// ---------------------------------------------------------------- the shot

function makeShot(kind: WhyKind, id: string): ShotDef {
  const demo = isDemo(kind);
  const T = timesOf(kind);
  return {
    id,
    duration: T.end,
    fps: demo ? 120 : 60,
    get substeps() {
      return demo ? WHY_CFG.SUB / 2 : WHY_CFG.SUB;
    },
    get iterations() {
      return WHY_CFG.ITER;
    },
    build() {
      const spec = personOf(kind);
      const rs = ringSpecOf(kind);
      const c = centre(spec);
      // the ring's top in the left hand's fingers, in front of the chest, left of the centre
      const top: V3 = [c[0] - 0.02, c[1] + 0.03, c[2]];
      const ring = windRing(rs);
      const dPlace = sub(top, add(quatRotate(QRING, sub(ring.top.c, FIST)), FIST));
      const rod = ringRod(ring, placeRing(ring.state, dPlace, QRING, 0), rs);
      const n = rod.n, N = ring.loops.length;
      const P = (i: number): V3 => [rod.x[3 * i], rod.x[3 * i + 1], rod.x[3 * i + 2]];
      const sA = ring.sCable[0] + HOLD_L, sB = ring.sCable[1] - HOLD_R;
      const iA = rod.segmentAt(sA), iB = rod.segmentAt(sB) + 1;
      // the plan
      const plan: Plan = new Float64Array(SLOTS.size);
      const A0 = P(iA), B0 = P(iB);
      const dA = normalize(sub(P(iA + 2), P(Math.max(0, iA - 6))));
      const dB = normalize(sub(P(iB - 2), P(Math.min(n - 1, iB + 6))));
      // where the end comes out to: right of the ring, a little below its top, within reach of the
      // free piece of the end (from the last loop's top to the fist)
      const lastTop = rod.pointAt(ring.sLoops[N - 1][1]);
      const free = sB - ring.sLoops[N - 1][1];
      const side: V3 = add(lastTop, scale(normalize([1, -0.45, 0]), 0.85 * free));
      plan.set(A0, SLOTS.a0);
      plan.set(B0, SLOTS.b0);
      plan.set(dA, SLOTS.dA);
      plan.set(dB, SLOTS.dB);
      plan.set(side, SLOTS.side);
      plan[SLOTS.between] = sB - sA;
      ring.loops.forEach(([a], k) => (plan[SLOTS.loops + k] = a));
      plan[SLOTS.loops + N] = ring.loops[N - 1][1] + 1;
      plan.set(top, SLOTS.top);
      for (let k = 0; k < SLOTS.size; k++) plan[k] = Math.fround(plan[k]);

      const h = holdsOf(kind, plan);
      const track = whyTrack(kind, plan);
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
      // the holds: the ends rigidly (they cannot turn); the fingers hold the ring's top until `free`
      const PRE = -0.8;
      rod.time = PRE;
      const holdA: Bundle = rod.bundle({ frame: (t) => h.left(Math.max(0, t)), hand: 0, blend: 0.001 });
      holdA.add(0, sA);
      const holdB: Bundle = rod.bundle({ frame: (t) => h.right(Math.max(0, t)), hand: 1, blend: 0.001 });
      holdB.add(sB, rod.totalLength);
      const fingers: Bundle = rod.bundle({ frame: { p: [...top] as V3, q: [0, 0, 0, 1] }, blend: 0.001 });
      for (const [a, b] of ring.held) if (b > sA + 0.005) fingers.add(Math.max(a, sA + 0.005), b);
      // forearms beyond the plugs (as pullApart: no loop slips off over an end) and the body
      const tipA0 = P(0), tipB0 = P(n - 1);
      const arm = (f: Frame, tip0: V3, p0: V3): Capsule => {
        const e = add(f.p, quatRotate(f.q, sub(tip0, p0)));
        const out = normalize(sub(e, f.p));
        return { a: add(e, scale(out, 0.03)), b: add(e, scale(out, 0.4)), r: 0.02 };
      };
      rod.setCapsules((t) => {
        const tt = Math.max(0, t);
        const body = capsulesOf(poseAt(tt)).filter((cc) => cc.part === 'torso' || cc.part === 'legL' || cc.part === 'legR');
        return [arm(h.left(tt), tipA0, A0), arm(h.right(tt), tipB0, B0), ...body];
      });
      // pre-roll: the ring settles in the fingers, both ends held
      for (let f = 0; f < Math.round(-PRE * 60); f++) rod.step(1 / 60, WHY_CFG.SUB);
      rod.time = 0;
      rod.v.fill(0);
      rod.om.fill(0);

      let letGo = false, stiff = demo;
      const [c0, c1] = ring.cable;
      const plugJoint = (k: number) => k < c0 - 1 || k >= c1;
      const script = (r: Rod, t: number) => {
        // (quickly: pieces a bundle still holds do not collide with each other)
        if (!letGo && t >= T.free) {
          fingers.release(-Infinity, Infinity, 0.06);
          letGo = true;
        }
        // the ring shots: from the taut hold on, the torsional stiffness of the stuck strands (header)
        if (!stiff && t >= RING_T.stiff) {
          r.setStiffness({ GJ: (k) => (plugJoint(k) ? 1000 : 1) * WHY_CFG.GJ_HOLD });
          stiff = true;
        }
      };
      // twist between the hands (the counters), writhe, their sum, and the largest jump of the sum
      // between two frames once the ring hangs free (a strand passing through another changes it by 2 at once)
      const kA = iA + 1, kB = iB - 2;
      let cache = { t: NaN, tw: 0, wr: 0 }, lkPrev: number | null = null, lkJump = 0;
      const tw = (r: Rod, t: number) => {
        if (cache.t !== t) {
          cache = { t, tw: r.twistTurns(kA, kB), wr: r.writhe(iA, iB) };
          const lk = cache.tw + cache.wr;
          if (lkPrev !== null && t > T.free + 0.3) lkJump = Math.max(lkJump, Math.abs(lk - lkPrev));
          lkPrev = lk;
        }
        return cache;
      };
      const arms = (t: number, side: 0 | 1) => poseAt(t).body.arms?.[side].report;
      return {
        rod,
        script,
        tracks: {
          cable0: () => ring.cable[0],
          cable1: () => ring.cable[1],
          nodeA: () => iA,
          nodeB: () => iB,
          tw: (r, t) => tw(r, t).tw,
          wr: (r, t) => tw(r, t).wr,
          lkJump: (r, t) => (tw(r, t), lkJump),
          /** the torsional stiffness in use [N m²] */
          gj: () => (stiff && !demo ? WHY_CFG.GJ_HOLD : WHY_CFG.GJ),
          /** the tightest bend between the hands [m] and where it is (the curl, the kink) */
          bend: (r) => tightestBendIn(r, iA + 4, iB - 4).radius,
          bendNode: (r) => tightestBendIn(r, iA + 4, iB - 4).node,
          /** the lowest point of the cable between the hands [m] */
          low: (r) => {
            let m = Infinity;
            for (let i = iA; i <= iB; i++) m = Math.min(m, r.x[3 * i + 1]);
            return m;
          },
          /** the largest joint gap now [mm] (health) */
          gap: (r) => r.maxJointGap() * 1000,
          ikL: (_, t) => (arms(t, 0)?.posError ?? 0) * 1000,
          ikR: (_, t) => (arms(t, 1)?.posError ?? 0) * 1000,
        },
        vectors: { plan: { size: SLOTS.size, fn: () => plan } },
      };
    },
  };
}

/** the tightest bend of nodes a..b (kink.ts tightestBend on that piece) */
function tightestBendIn(r: Rod, a: number, b: number) {
  const tb = tightestBend(r.x.subarray(3 * a, 3 * (b + 1)) as Float64Array, b - a + 1);
  return { radius: tb.radius, node: tb.node + a };
}

export const WHY_SHOTS: ShotDef[] = [makeShot('teo', 'p2-teo'), makeShot('robin', 'p2-robin'), makeShot('one', 'p2-one'), makeShot('under', 'p2-under'), makeShot('pair', 'p2-pair')];

/** the shot id of each kind */
export const WHY_ID: Record<WhyKind, string> = { teo: 'p2-teo', robin: 'p2-robin', one: 'p2-one', under: 'p2-under', pair: 'p2-pair' };
