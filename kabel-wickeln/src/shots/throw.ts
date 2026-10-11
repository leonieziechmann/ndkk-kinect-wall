// Stage 1, shot 4: Kofi throws a 15 m XLR toward the mic stand. He keeps the start end and three
// loops loosely in his open left hand, about one and a half loops hang between his hands, and he
// throws the rest of the over-under coil underhand with his right hand. In flight the loops peel
// off the trailing face of the coil one after another, the loops in the left hand feed out after
// them, and the cable lands in gentle bends without curls (the twist of the über and unter loops
// cancels). The rest of the coil lands as a small heap.
//
// Pseudo-simulation: the coil is wound by the coil factory (wind.ts, real crossings) and then
// kinematic: a shape-keeping grip on the right fist, after the release on a ballistic frame that
// turns a quarter turn on the way down (it lands flat), slides a little and lets go. Whenever the
// free cable between the left hand's loops and the coil is nearly taut, nodes are let go: from
// the loops in the open left hand (all of it before the release, a third after it) and from the
// trailing face of the flying coil. The free cable and the floor are simulated (60 substeps).
// Drawn at 12 mm (wide shot) with a 6 mm contact radius, so the coil can be packed like a real
// one; the floor is raised by 6 mm so the thick tube rests on y = 0.
//
// Coordinates: Kofi stands at the origin and throws along +x; his right side is +z.

import { Frame, Quat, Rod, RodState, V3, add, lerp3, quatFromAxisAngle, quatRotate, smooth, sub } from '../sim';
import type { ShotDef } from './types';
import { FACTORY_FIST, placeState, windCoil } from './wind';

const SEG = 0.03, LOOP = 0.785, LOOPS = 18;
const PATTERN = 'ou'.repeat(LOOPS / 2);
/** loops kept in the left hand, free cable between the hands [m] */
const HAND_LOOPS = 3, BRIDGE = 1.2;
/** the cable as simulated: XLR, drawn at 12 mm, contact radius 6 mm, floor 6 mm up */
export const THROW_RADIUS = 0.012;
const RC = 0.006;
export const THROW_CABLE = { radius: THROW_RADIUS, collisionRadius: RC, linearDensity: 0.05, EI: 2e-3, GJ: 1.5e-3, damping: 0.3, angularDamping: 2, friction: 0.6, selfFriction: 0.3, groundY: THROW_RADIUS - RC };

/**
 * Shot times: the backswing ends at `back`; release and landing follow from the swing. Before
 * shot time 0 (pre-roll of SPLIT seconds, not recorded) Kofi pulls the coil apart into the two
 * hands: the right hand first forward (so the loop between the hands slips off the stack), then
 * to the side.
 */
export const THROW_TIMES = { back: 0.8, end: 4.4 };
const SPLIT = 1.2;
/** shoulder (centre of the swing), arm length, release angle and speed */
const SHOULDER: V3 = [0, 1.4, 0.25], ARM = 0.62, BACK = -50 * Math.PI / 180, RELEASE = 35 * Math.PI / 180, SPEED = 7.4;
/** height of the coil's centre when it lands; it turns a quarter turn on the way (lands flat) */
const LAND_Y = 0.12;
/** where Kofi holds the coil with both hands at the start, and his open left hand */
const HOLD: V3 = [0.35, 1.0, 0.05], LEFT: V3 = [0.3, 1.0, -0.22];
/** the coil's stack axis (the factory's +z) points forward; loops hang down */
const PLACE: Quat = quatFromAxisAngle(0, 1, 0, Math.PI / 2);

const G = 9.81;
const omega = SPEED / ARM, alpha = (omega * omega) / (2 * (RELEASE - BACK)), tRelease = THROW_TIMES.back + omega / alpha;

/** Swing angle of the right arm (0 = hanging straight down, positive = forward). */
function swingAngle(t: number) {
  const ready = 0.15;
  if (t < THROW_TIMES.back) return ready + (BACK - ready) * smooth(t / THROW_TIMES.back);
  const u = Math.min(t, tRelease) - THROW_TIMES.back;
  return BACK + 0.5 * alpha * u * u;
}

const handOnArc = (th: number): V3 => [SHOULDER[0] + ARM * Math.sin(th), SHOULDER[1] - ARM * Math.cos(th), SHOULDER[2]];

/** The right fist: pulls the coil out of the left hand (t < 0), swings, releases, follows through. */
export function rightHand(t: number): V3 {
  if (t < 0) {
    const u = (t + SPLIT) / SPLIT, fwd = add(HOLD, [0.25, 0, 0]);
    return u < 0.5 ? lerp3(HOLD, fwd, smooth(u / 0.5)) : lerp3(fwd, handOnArc(swingAngle(0)), smooth((u - 0.5) / 0.5));
  }
  if (t <= tRelease) return handOnArc(swingAngle(t));
  return handOnArc(RELEASE + 0.9 * smooth((t - tRelease) / 0.35));
}

/** The open left hand: from the coil to the side (t < 0), then still. */
export function leftHand(t: number): V3 {
  return lerp3(HOLD, LEFT, smooth((t + SPLIT) / SPLIT));
}

let coil: { state: RodState; loops: [number, number][] } | null = null;
/**
 * The wound coil hanging in Kofi's hands (wound once per process): wound with the real 3.5 mm
 * cable and the loops one contact diameter (12 mm) apart, so the thrown cable's loops just touch.
 */
function throwCoil() {
  if (!coil) {
    const c = windCoil({ cable: { radius: 0.0035, linearDensity: 0.05, EI: 2e-3, GJ: 1.5e-3, iterations: 4 }, seg: SEG, loop: LOOP, pattern: PATTERN, lead: 0.3, tail: 0.3, spacing: 2 * RC, loopTime: 2, lay: false });
    const placed = placeState(c.state, sub(HOLD, quatRotate(PLACE, FACTORY_FIST)), PLACE);
    coil = { state: { ...placed, opts: { ...placed.opts, ...THROW_CABLE } }, loops: c.loops };
  }
  return coil;
}

export const throwShot: ShotDef = {
  id: 'throw',
  duration: THROW_TIMES.end,
  substeps: 60,
  build() {
    const { state, loops } = throwCoil();
    const rod = Rod.fromState(state);
    rod.time = -SPLIT;
    const x = rod.x;
    // left hand: start tail and HAND_LOOPS loops; right hand: the rest after BRIDGE of free cable
    let kh = loops[HAND_LOOPS - 1][1] + 1;
    let kc = kh + Math.round(BRIDGE / SEG);
    const kEnd = loops[loops.length - 1][1] + 1;
    const minKh = loops[0][0];
    // the coil's centre relative to the fist (for the tumble about the centre)
    let cx = 0, cy = 0, cz = 0;
    for (let i = kc; i <= kEnd; i++) { cx += x[3 * i]; cy += x[3 * i + 1]; cz += x[3 * i + 2]; }
    const m = kEnd - kc + 1, centre = sub([cx / m, cy / m, cz / m], HOLD);
    const pRel = rightHand(tRelease), vRel: V3 = [SPEED * Math.cos(RELEASE), SPEED * Math.sin(RELEASE), 0];
    const c0 = add(pRel, centre);
    // flight time until the centre is down at LAND_Y; the coil tumbles forward a quarter turn by then
    const tFly = (vRel[1] + Math.sqrt(vRel[1] * vRel[1] + 2 * G * (c0[1] - LAND_Y))) / G, tumble = Math.PI / 2 / tFly;
    const tLand = tRelease + tFly;
    const id: Quat = [0, 0, 0, 1];
    /** frame of the thrown coil: in the right fist, ballistic and tumbling, then sliding to rest */
    const coilFrame = (t: number): Frame => {
      if (t <= tRelease) return { p: rightHand(t), q: id };
      const tau = Math.min(t, tLand) - tRelease;
      const c = add(c0, [vRel[0] * tau, vRel[1] * tau - 0.5 * G * tau * tau, vRel[2] * tau]);
      // after landing: slides 15 cm with the speed dying away, settles onto the floor
      const slide = t > tLand ? 0.15 * (1 - Math.exp(-(t - tLand) / 0.06)) : 0;
      c[0] += slide;
      c[1] -= drop * smooth((t - tLand) / 0.2);
      const q = quatFromAxisAngle(0, 0, 1, -tumble * tau);
      return { p: sub(c, quatRotate(q, centre)), q };
    };
    // how far the landed coil sinks until its lowest loop rests on the floor (set at the landing)
    let drop = 0;
    const leftFrame = (t: number): Frame => ({ p: leftHand(t), q: id });
    let gl = rod.addGrip({ nodes: [0, kh], keepShape: true, frame: leftFrame });
    let gc = rod.addGrip({ nodes: [kc, kEnd], keepShape: true, frame: coilFrame });
    // pre-roll: the split, not recorded
    while (rod.time < -1e-9) rod.step(1 / 60, 60);
    rod.time = 0;
    let landed = false;
    return {
      rod,
      script: (r, t) => {
        if (landed) return;
        if (t >= tLand && !drop) {
          let low = Infinity;
          for (let i = kc; i <= kEnd; i++) low = Math.min(low, x[3 * i + 1]);
          drop = Math.max(1e-4, low - (THROW_CABLE.groundY + RC + 0.004));
        }
        // landed and slid to rest: let go; the loops sink onto each other, held in place seen from
        // above by guides that fade out
        if (t >= tLand + 0.3) {
          const x0 = x.slice(), t0 = t;
          r.releaseGrip(gc);
          r.addGuide({ nodes: [kc, r.n - 1], compliance: 1e-4, weight: (tt) => 1 - smooth((tt - t0 - 0.3) / 0.5), target: (i) => [x0[3 * i], x[3 * i + 1], x0[3 * i + 2]] });
          landed = true;
          return;
        }
        // taut free cable: let nodes go from the coil's trailing face (and from the left hand)
        const free = (kc - kh) * SEG;
        const chord = Math.hypot(x[3 * kc] - x[3 * kh], x[3 * kc + 1] - x[3 * kh + 1], x[3 * kc + 2] - x[3 * kh + 2]);
        let need = Math.ceil((chord / 0.85 - free) / SEG);
        if (need <= 0) return;
        need += 2;
        // the open left hand gives cable whenever it is pulled; after the release the coil gives most
        if (kh > minKh) {
          const fromHand = Math.min(kh - minKh, t < tRelease ? need : Math.ceil(need * 0.3));
          kh -= fromHand;
          need -= fromHand;
          r.releaseGrip(gl);
          gl = r.addGrip({ nodes: [0, kh], keepShape: true, frame: leftFrame });
        }
        if (need > 0 && kc < kEnd - 2) {
          kc = Math.min(kEnd - 2, kc + need);
          r.releaseGrip(gc);
          gc = r.addGrip({ nodes: [kc, kEnd], keepShape: true, frame: coilFrame });
        }
      },
      tracks: {
        /** last node held in the left hand and first node still in the flying coil (until it lands) */
        handEnd: () => kh,
        coilStart: () => kc,
        /** 1 while the coil flies (or is in the fist), 0 once it has landed and been let go */
        flying: () => (landed ? 0 : 1),
        twist: (r) => r.twistTurns(),
        writhe: (r) => r.writhe(),
      },
    };
  },
};

/** shot time at which the right fist lets go of the coil */
export const THROW_RELEASE = tRelease;
