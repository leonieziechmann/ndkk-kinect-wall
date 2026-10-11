// Cable presets for the shots: the user's own XLR cable (measured and fitted, see
// tools/simtest/calib-xlr.mjs) and three more cables (estimates from data sheets and experience,
// marked as such). buildCable() makes a rod from a preset: the cable resampled at the preset's
// segment length, plus the plugs as rigid, heavy end pieces.
//
// The model behind the numbers (rod.ts): a highflex cable is soft but "dead". It is heavily damped
// (Kelvin-Voigt bendDamping / twistDamping) and keeps the shape it is given (plastic memory beyond
// a small elastic range), so it moves slowly and heavily and does not swing, bounce or spring
// back. `damping` (air drag in the rod) also stands in for what calms a swinging cable in real
// hands: the arm gives way, loops rub on each other.

import { Plasticity, Rod, RodBuildOptions, RodOptions } from './rod';
import { V3 } from './vec';

export interface CableSpec {
  name: string;
  /** what it is and where each value comes from */
  source: string;
  /** outer diameter [m] (render and contact radius = od / 2) */
  od: number;
  /** cable without plugs [kg/m] */
  linearDensity: number;
  /** bending and torsional stiffness [N m²] */
  EI: number;
  GJ: number;
  /** Kelvin-Voigt relaxation times [s] */
  bendDamping: number;
  twistDamping: number;
  /** velocity damping [1/s] (air drag and the calming of the hands, see the file header) */
  damping: number;
  plastic: Plasticity | null;
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
 * Weighed by the user: 5 m with two plugs = 250 g → 42 g/m and ~20 g per plug. EI fitted to the
 * user's drape photo (the cable over a finger, a 10 cm leg with the plug and a long leg; leg
 * spacing and top bend, see calib-xlr.mjs); GJ ≈ 0.8 EI (stranded cores, braided shield). The
 * damping and memory reproduce what the user describes and the two coiling videos show: it
 * follows the hands calmly, settles at once and keeps the bends it is given.
 */
export const XLR: CableSpec = {
  name: 'XLR, Sommer SC-Stage 22 Highflex',
  source: 'user: Ø 6.4 mm, 250 g per 5 m with 2 Neutrik plugs; EI from the drape photo (calib-xlr.mjs); damping and memory: drape, U, grab-and-move and lay-down tests against the coiling videos',
  od: 0.0064,
  linearDensity: 0.042,
  EI: 1.0e-4,
  GJ: 0.8e-4,
  bendDamping: 0.08,
  twistDamping: 0.08,
  damping: 1.5,
  plastic: { yieldCurvature: 2, rate: 3, creep: 0.05, maxCurvature: 25, twistYield: null },
  friction: 0.5,
  selfFriction: 0.35,
  capsuleFriction: 0.8,
  segment: 0.01,
  plug: { mass: 0.02, length: 0.06 },
  substeps: 30,
  iterations: 2,
};

/**
 * A thin phone charging cable (USB-C), Ø 4 mm, TPE jacket. Estimates: ~20 g/m (typical 1 m
 * cables weigh 18–25 g without plugs); springier than the XLR (thin TPE jackets carry themselves
 * ~7 cm): EI ≈ ρ g · 0.07³ ≈ 7e-5; less damping and memory than a highflex stage cable.
 */
export const CHARGING: CableSpec = {
  name: 'USB-C charging cable',
  source: 'estimate: 20 g/m, self-supporting length ~7 cm, plug 4 g / 3.5 cm',
  od: 0.004,
  linearDensity: 0.02,
  EI: 7e-5,
  GJ: 5e-5,
  bendDamping: 0.04,
  twistDamping: 0.04,
  damping: 1.2,
  plastic: { yieldCurvature: 5, rate: 2, maxCurvature: 30, twistYield: null },
  friction: 0.5,
  selfFriction: 0.3,
  capsuleFriction: 0.7,
  segment: 0.008,
  plug: { mass: 0.004, length: 0.035 },
  substeps: 30,
  iterations: 2,
};

/**
 * Rubber power cable H07RN-F 5G2.5, Ø ~16 mm. Data sheets (e.g. Lapp, Faber): 14.2–16 mm,
 * ~300–340 kg/km. EI estimated from a self-supporting length of ~15 cm: ρ g · 0.15³ ≈ 0.011,
 * rounded up to 0.015 (cold rubber is stiffer). CEE 16 A plug ~150 g.
 */
export const POWER_5G2_5: CableSpec = {
  name: 'H07RN-F 5G2.5 power cable',
  source: 'data sheets: Ø 14.2–16 mm, 300–340 kg/km; EI estimate from ~15 cm self-supporting length; CEE 16 A plug ~150 g',
  od: 0.016,
  linearDensity: 0.32,
  EI: 0.015,
  GJ: 0.012,
  bendDamping: 0.06,
  twistDamping: 0.06,
  damping: 1.2,
  plastic: { yieldCurvature: 1.5, rate: 1.5, creep: 0.03, maxCurvature: 8, twistYield: null },
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
 * plug ~500 g.
 */
export const POWER_5G16: CableSpec = {
  name: 'H07RN-F 5G16 power cable',
  source: 'data sheets: Ø 27–31 mm, 1300–1450 kg/km; EI estimate from ~30 cm self-supporting length; CEE 63 A plug ~500 g',
  od: 0.03,
  linearDensity: 1.38,
  EI: 0.4,
  GJ: 0.3,
  bendDamping: 0.06,
  twistDamping: 0.06,
  damping: 1.0,
  plastic: { yieldCurvature: 1, rate: 1, creep: 0.02, maxCurvature: 4, twistYield: null },
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
    plastic: spec.plastic ? { ...spec.plastic } : null,
    friction: spec.friction,
    selfFriction: spec.selfFriction,
    capsuleFriction: spec.capsuleFriction,
    iterations: spec.iterations,
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

export interface BuildCableOptions extends RodBuildOptions {
  /** which ends carry plugs (default both) */
  plugs?: 'both' | 'start' | 'end' | 'none';
  /** segment length (default the preset's) */
  segment?: number;
}

/**
 * A rod for a preset through `points` (the whole length, plugs included, from the start plug's tip
 * to the end plug's tip), resampled at the preset's segment length. Each plug is the end piece of
 * spec.plug.length: rigid (1000 × EI) and carrying the plug's mass. Draw the tube over `cable`
 * and put the plug meshes on the end pieces.
 */
export function buildCable(spec: CableSpec, points: V3[], o: BuildCableOptions = {}): BuiltCable {
  const { plugs = 'both', segment = spec.segment, ...ro } = o;
  const pts = resample(points, segment);
  const rod = Rod.fromPolyline(pts, { ...rodOptions(spec), ...ro });
  const S = rod.sNode, total = rod.totalLength;
  const atStart = spec.plug && (plugs === 'both' || plugs === 'start');
  const atEnd = spec.plug && (plugs === 'both' || plugs === 'end');
  const pl = spec.plug?.length ?? 0;
  const iStart = atStart ? rod.segmentAt(pl - 1e-9) + 1 : 0;
  const iEnd = atEnd ? rod.segmentAt(total - pl + 1e-9) : rod.n - 1;
  if (atStart || atEnd) {
    const rigid = (k: number) => (atStart && k < iStart - 1) || (atEnd && k >= iEnd);
    // joint k joins segments k and k+1: rigid where both lie in a plug
    rod.setStiffness({ EI: (k) => (rigid(k) ? spec.EI * 1000 : spec.EI), GJ: (k) => (rigid(k) ? spec.GJ * 1000 : spec.GJ) });
    const mass = spec.plug ? spec.plug.mass : 0;
    const spread = (j0: number, j1: number) => {
      const len = S[j1] - S[j0];
      for (let j = j0; j < j1; j++) rod.addMass(j, mass * (rod.L[j] / len) - rod.m[j]);
    };
    if (atStart) spread(0, iStart);
    if (atEnd) spread(iEnd, rod.ns);
  }
  return { rod, spec, cable: [iStart, iEnd], sCable: [S[iStart], S[iEnd]] };
}
