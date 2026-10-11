// Cable presets for the shots: the user's own XLR cable (measured and fitted, see
// tools/simtest/model-fit.mjs and calib-xlr.mjs) and three more cables (estimates from data
// sheets and experience, marked as such). buildCable() makes a rod from a preset: the cable
// resampled at the preset's segment length, plus the plugs as rigid, heavy end pieces.
//
// The model behind the numbers (rod.ts): a highflex cable is soft but "dead".
//   - Its strands stick by friction (opts.plastic): a bend near the shape it was given is held
//     by the stuck strands (frictionEI) up to a yield moment, beyond that they slip and only the
//     soft elastic EI is left; a bend the hands give it stays. Loops of 30-35 cm hang as ovals
//     instead of narrow teardrops, a tight bend over a finger is still easy.
//   - It is heavily damped inside (Kelvin-Voigt bendDamping / twistDamping): a bend relaxes in
//     about 0.1 s instead of ringing.
//   - A hand calms what it holds (holdDamping, relative to the hand): a cable the hand stops
//     swings out in a few calm swings, not for seconds.
//   - The air does almost nothing (damping 0.2 /s): a dropped cable falls at g, which is what
//     makes it look heavy.

import { Plasticity, Rod, RodBuildOptions, RodOptions } from './rod';
import { TAU, V3 } from './vec';

export interface CableSpec {
  name: string;
  /** what it is and where each value comes from */
  source: string;
  /** outer diameter [m] (render and contact radius = od / 2) */
  od: number;
  /** cable without plugs [kg/m] */
  linearDensity: number;
  /** bending stiffness of the elastic element (strands slipping) and torsional stiffness [N m²] */
  EI: number;
  GJ: number;
  /** Kelvin-Voigt relaxation times [s] */
  bendDamping: number;
  twistDamping: number;
  /** air drag [1/s] (small: a falling cable falls at g) */
  damping: number;
  /** what a hand does to the cable it holds: damping across the cable relative to the hand [1/s], fading over holdDampingReach [m] (RodOptions.holdDamping) */
  holdDamping: number;
  holdDampingReach: number;
  /** friction between the strands (stick-slip, memory); null = elastic */
  plastic: Plasticity | null;
  /**
   * Natural curvature [1/m] of the elastic element (its rest shape curls in the plane of d2 and
   * d3, always to the same side): a cable that was always coiled the same way. 0 = straight. Weak
   * against the strand friction; BuildCableOptions.memory is the coil memory of a used cable.
   */
  coilMemory: number;
  /** Coulomb friction: floor, cable on cable, cable on skin */
  friction: number;
  selfFriction: number;
  capsuleFriction: number;
  /** segment length that resolves the tightest bends in the hands [m] */
  segment: number;
  /** the plugs: mass [kg] and rigid length incl. the boot [m] (rendered plug lengths: three/plugs.ts) */
  plug: { mass: number; length: number } | null;
  /** solver settings that keep it stable and fast: substeps per 1/60 s frame, iterations */
  substeps: number;
  iterations: number;
}

/**
 * Sommer Cable SC-Stage 22 Highflex (the user's cable), Ø 6.4 mm, with Neutrik XLR plugs.
 * - Mass: weighed by the user, 5 m with two plugs = 250 g → 42 g/m and ~20 g per plug.
 * - Bending (tools/simtest/model-fit.mjs). Three observations:
 *   - the drape photo (over a finger, plug leg 6 cm + plug, other leg long): legs ~5 cm apart
 *     centre to centre (4.5-5.3 cm depending on the scale used), top radius 1.5-2.2 cm. An elastic
 *     cable fits it with EI ≈ 1e-4 N m² (4.8 cm);
 *   - the coiling videos: a loop of ~0.8 m hanging from one hand is an oval about 0.5-0.7 as wide
 *     as tall (a single loop hanging from both hands together is narrower, the finished coil
 *     rounder). An elastic EI 1e-4 cable makes teardrops (~0.45);
 *   - the user: "gar nicht mal so steif, aber mehr gedämpft".
 *   A stranded cable does both: EI 1.0e-4 (strands slipping) plus strand friction 2e-3 N m² that
 *   carries up to 3e-3 N m (yield moment). Results: drape 5.4-5.6 cm, top radius ~1.9 cm, plug
 *   leg ~9° off vertical (photo: vertical, see the report); a 0.8 m loop hanging from a fist
 *   0.61 (straight memory) to 0.65 (memory round) as wide as tall; 15 cm held out horizontally
 *   droops 3.5 cm within 0.5 s and 4.1 cm in the end, 30 cm hangs down (28.8 cm). No creep: a
 *   shape is final within ~1 s. The yield moment is the one knob between round loops (higher)
 *   and a limp stub (lower): 2.5e-3 gives 5.6 cm droop and 0.57-0.59 loops.
 *   GJ ≈ 0.8 EI (stranded cores, braided shield; an estimate).
 * - Damping: τ = 0.08 s in bending and twist (a 15 cm end settles without overshoot); air
 *   0.2 /s (a 1 m drop takes 2-4 % longer than in vacuum); a hand calms what it holds at 4 /s,
 *   fading over 0.6 m along the cable (a 1 m cable the hand stops after 15 cm swings out in about
 *   3 calm swings).
 * - No coil memory by default: over-under coiling leaves no net bend (see BuildCableOptions.memory).
 * - Friction on skin 0.8 (PVC on skin), floor 0.5, cable on cable 0.35.
 * - Segments 7.5 mm: a 1.5 cm bend radius is ~30° per joint, a cable round a finger ~40°.
 */
export const XLR: CableSpec = {
  name: 'XLR, Sommer SC-Stage 22 Highflex',
  source: 'user: Ø 6.4 mm, 250 g per 5 m with 2 Neutrik plugs; EI and strand friction from the drape photo and the loops of the coiling videos (model-fit.mjs); damping: grab-and-move, U, swing and fall tests (physics.mjs)',
  od: 0.0064,
  linearDensity: 0.042,
  EI: 1.0e-4,
  GJ: 0.8e-4,
  bendDamping: 0.08,
  twistDamping: 0.08,
  damping: 0.2,
  holdDamping: 4,
  holdDampingReach: 0.6,
  plastic: { frictionEI: 2e-3, yieldMoment: 3e-3, rate: 50, creep: 0, slipDamping: 0.25 },
  coilMemory: 0,
  friction: 0.5,
  selfFriction: 0.35,
  capsuleFriction: 0.8,
  segment: 0.0075,
  plug: { mass: 0.02, length: 0.06 },
  substeps: 30,
  iterations: 2,
};

/**
 * A thin phone charging cable (USB-C), Ø 4 mm, TPE jacket. Estimates: ~20 g/m (typical 1 m
 * cables weigh 18–25 g without plugs); springier than the XLR (thin TPE jackets carry themselves
 * ~7 cm): EI ≈ ρ g · 0.07³ ≈ 7e-5; less strand friction and damping than a highflex stage cable.
 * Untested beyond a smoke test.
 */
export const CHARGING: CableSpec = {
  name: 'USB-C charging cable',
  source: 'estimate: 20 g/m, self-supporting length ~7 cm, plug 4 g / 3.5 cm; friction and damping guessed',
  od: 0.004,
  linearDensity: 0.02,
  EI: 7e-5,
  GJ: 5e-5,
  bendDamping: 0.04,
  twistDamping: 0.04,
  damping: 0.3,
  holdDamping: 2,
  holdDampingReach: 0.4,
  plastic: { frictionEI: 2e-4, yieldMoment: 1.6e-3, rate: 100, creep: 0 },
  coilMemory: 0,
  friction: 0.5,
  selfFriction: 0.3,
  capsuleFriction: 0.7,
  segment: 0.006,
  plug: { mass: 0.004, length: 0.035 },
  substeps: 30,
  iterations: 2,
};

/**
 * Rubber power cable H07RN-F 5G2.5, Ø ~16 mm. Data sheets (e.g. Lapp, Faber): 14.2–16 mm,
 * ~300–340 kg/km. EI estimated from a self-supporting length of ~15 cm: ρ g · 0.15³ ≈ 0.011,
 * rounded up to 0.015 (cold rubber is stiffer). CEE 16 A plug ~150 g. Strand friction and damping
 * guessed; untested beyond a smoke test.
 */
export const POWER_5G2_5: CableSpec = {
  name: 'H07RN-F 5G2.5 power cable',
  source: 'data sheets: Ø 14.2–16 mm, 300–340 kg/km; EI estimate from ~15 cm self-supporting length; CEE 16 A plug ~150 g; friction and damping guessed',
  od: 0.016,
  linearDensity: 0.32,
  EI: 0.015,
  GJ: 0.012,
  bendDamping: 0.06,
  twistDamping: 0.06,
  damping: 0.2,
  holdDamping: 3,
  holdDampingReach: 0.6,
  plastic: { frictionEI: 0.02, yieldMoment: 0.06, rate: 100, creep: 0 },
  coilMemory: 0,
  friction: 0.6,
  selfFriction: 0.5,
  capsuleFriction: 0.8,
  segment: 0.02,
  plug: { mass: 0.15, length: 0.105 },
  substeps: 30,
  iterations: 2,
};

/**
 * Rubber power cable H07RN-F 5G16, Ø ~30 mm. Data sheets: 27–31 mm, ~1300–1450 kg/km. EI
 * estimated from a self-supporting length of ~30 cm: ρ g · 0.3³ ≈ 0.37, taken as 0.4. CEE 63 A
 * plug ~500 g. Strand friction and damping guessed; untested beyond a smoke test.
 */
export const POWER_5G16: CableSpec = {
  name: 'H07RN-F 5G16 power cable',
  source: 'data sheets: Ø 27–31 mm, 1300–1450 kg/km; EI estimate from ~30 cm self-supporting length; CEE 63 A plug ~500 g; friction and damping guessed',
  od: 0.03,
  linearDensity: 1.38,
  EI: 0.4,
  GJ: 0.3,
  bendDamping: 0.06,
  twistDamping: 0.06,
  damping: 0.2,
  holdDamping: 3,
  holdDampingReach: 0.8,
  plastic: { frictionEI: 0.4, yieldMoment: 0.8, rate: 100, creep: 0 },
  coilMemory: 0,
  friction: 0.6,
  selfFriction: 0.5,
  capsuleFriction: 0.8,
  segment: 0.035,
  plug: { mass: 0.5, length: 0.16 },
  substeps: 30,
  iterations: 2,
};

export const CABLES = { XLR, CHARGING, POWER_5G2_5, POWER_5G16 } as const;

/** Rod options of a preset (radius, density, stiffness, damping, memory, friction, iterations). */
export function rodOptions(spec: CableSpec, over: Partial<RodOptions> = {}): Partial<RodOptions> {
  return {
    radius: spec.od / 2,
    linearDensity: spec.linearDensity,
    EI: spec.EI,
    GJ: spec.GJ,
    bendDamping: spec.bendDamping,
    twistDamping: spec.twistDamping,
    damping: spec.damping,
    angularDamping: spec.damping,
    holdDamping: spec.holdDamping,
    holdDampingReach: spec.holdDampingReach,
    plastic: spec.plastic ? { ...spec.plastic } : null,
    friction: spec.friction,
    selfFriction: spec.selfFriction,
    capsuleFriction: spec.capsuleFriction,
    iterations: spec.iterations,
    maxSpeed: 8,
    ...over,
  };
}

/** Points at equal arc-length spacing seg along a polyline (the last spacing may be shorter). */
export function resample(points: V3[], seg: number): V3[] {
  const out: V3[] = [points[0]];
  let acc = 0, next = seg;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    while (acc + l >= next - 1e-12) {
      const u = (next - acc) / l;
      out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]);
      next += seg;
    }
    acc += l;
  }
  const last = points[points.length - 1], end = out[out.length - 1];
  if (Math.hypot(last[0] - end[0], last[1] - end[1], last[2] - end[2]) > seg * 0.25) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

export interface BuiltCable {
  rod: Rod;
  spec: CableSpec;
  /** nodes of the cable proper [first, last]: the tube; the plugs lie beyond (rigid end segments) */
  cable: [number, number];
  /** material coordinates where the cable proper starts and ends */
  sCable: [number, number];
}

/**
 * The coil memory of a used cable: it has been stored coiled with loops of `loop` metres, so its
 * strands (and a little its jacket) remember a bend of 2π / loop. Over-under coiling flips every
 * second loop, so the remembered bend changes sides from loop to loop in the material frame (a
 * cable always coiled over-over remembers one side only: it twists when coiled the other way).
 * The memory goes into the strand friction memory (strong but plastic: it is lost where the
 * hands bend the cable away from it by more than the yield) and, scaled by `natural`, into the
 * elastic natural rest (permanent but weak). A coiling controller rolls the cable in the pinch so
 * that the remembered bend lies in the loop it forms (Pinch.rollToCurl, rod.memoryCurl): that is
 * the thumb's "leicht rotieren, damit es richtig fällt".
 */
export interface CoilMemory {
  /** loop length [m] of the remembered coil */
  loop: number;
  /** remembered curvature [1/m] (default 2π / loop) */
  curvature?: number;
  /** the side changes every loop (default true) */
  overUnder?: boolean;
  /** material coordinate where the first remembered loop starts [m] (default: the cable proper's start) */
  start?: number;
  /** how much of it the elastic natural rest keeps (default 0.5) */
  natural?: number;
}

export interface BuildCableOptions extends RodBuildOptions {
  /** which ends carry plugs (default both) */
  plugs?: 'both' | 'start' | 'end' | 'none';
  /** segment length (default the preset's) */
  segment?: number;
  /** natural curvature of the elastic element [1/m] (default the preset's coilMemory) */
  coilMemory?: number;
  /** the coil a used cable remembers (default none: a new cable or one that was laid out straight) */
  memory?: CoilMemory | null;
}

/**
 * A rod for a preset through `points` (the whole length, plugs included, from the start plug's tip
 * to the end plug's tip), resampled at the preset's segment length. Each plug is the end piece of
 * spec.plug.length: rigid (1000 × EI) and carrying the plug's mass. Draw the tube over `cable`
 * and put the plug meshes on the end pieces. The strand friction memory starts as the shape of
 * `points` (a corner in a made-up polyline is remembered: start from smooth shapes, let them
 * settle, then rod.rememberShape(); or rod.restFric.fill(0) + rod.setRestStraight() for a cable
 * that was straight before).
 */
export function buildCable(spec: CableSpec, points: V3[], o: BuildCableOptions = {}): BuiltCable {
  const { plugs = 'both', segment = spec.segment, coilMemory = spec.coilMemory, memory = null, ...ro } = o;
  const pts = resample(points, segment);
  const rod = Rod.fromPolyline(pts, { ...rodOptions(spec), ...ro });
  const EI = typeof ro.EI === 'number' ? ro.EI : spec.EI, GJ = typeof ro.GJ === 'number' ? ro.GJ : spec.GJ;
  const S = rod.sNode, total = rod.totalLength;
  const atStart = spec.plug && (plugs === 'both' || plugs === 'start');
  const atEnd = spec.plug && (plugs === 'both' || plugs === 'end');
  const pl = spec.plug?.length ?? 0;
  const iStart = atStart ? rod.segmentAt(pl - 1e-9) + 1 : 0;
  const iEnd = atEnd ? rod.segmentAt(total - pl + 1e-9) : rod.n - 1;
  if (atStart || atEnd) {
    const rigid = (k: number) => (atStart && k < iStart - 1) || (atEnd && k >= iEnd);
    // joint k joins segments k and k+1: rigid where both lie in a plug
    rod.setStiffness({ EI: (k) => (rigid(k) ? EI * 1000 : EI), GJ: (k) => (rigid(k) ? GJ * 1000 : GJ) });
    const mass = spec.plug ? spec.plug.mass : 0;
    const spread = (j0: number, j1: number) => {
      const len = S[j1] - S[j0];
      for (let j = j0; j < j1; j++) rod.addMass(j, mass * (rod.L[j] / len) - rod.m[j]);
    };
    if (atStart) spread(0, iStart);
    if (atEnd) spread(iEnd, rod.ns);
  }
  const inCable = (k: number) => k >= iStart && k < iEnd - 1;
  if (memory) {
    // over-under: the side flips every loop (bending about ±d1, curling toward ∓d2)
    const kap = memory.curvature ?? TAU / memory.loop, s0 = memory.start ?? S[iStart], nat = memory.natural ?? 0.5;
    const at = (k: number): number => {
      if (!inCable(k)) return 0;
      const n = Math.floor((S[k + 1] - s0) / memory.loop);
      return memory.overUnder === false || n % 2 === 0 ? kap : -kap;
    };
    rod.setMemoryCurvature((k) => [at(k), 0]);
    rod.setRestCurvature((k) => [at(k) * nat + (inCable(k) ? coilMemory : 0), 0, 0]);
  } else if (coilMemory) {
    // the natural curvature curls the cable proper (not the plugs) about d1
    rod.setRestCurvature((k) => (inCable(k) ? [coilMemory, 0, 0] : [0, 0, 0]));
  }
  return { rod, spec, cable: [iStart, iEnd], sCable: [S[iStart], S[iEnd]] };
}
