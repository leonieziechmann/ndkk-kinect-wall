// Stage 5.2 "Die verdrehte Schlaufe – sie schlägt eine Acht" (KONZEPT), the simulated cable for the
// part p5-eight. The user's XLR (sim/cables.ts XLR preset: strand friction, damping, plug mass) with
// ONE change, the torsional stiffness (EIGHT_GJ below), held by Noor's hands (pinch and fist frames
// below; the part poses her arms on the same frames).
//
// The situation: the cable comes from a ring that was always wound the same way, so the cable to
// the floor already carries twist (SUPPLY turns per metre, the stripe winds). Noor has two loops in
// her left hand and lays the next one. What is prescribed and what is simulated:
//   - prescribed: the twist in the cable when the shot starts. The new loop holds LOOP_TWIST.over
//     turns: the linking number its cable brings from the twisted supply minus the writhe of the
//     loop as it is laid (a flat loop is ±1 turn of writhe, KONZEPT stage 2/7). Laid one way (here
//     "über") that leaves 2.2 turns of twist in it; laid the other way, 2 turns less (0.2). The
//     hands' paths are keyframes (the mocap shots replace them later).
//   - pseudo-simulation (KONZEPT "Führungskräfte"): while the right hand brings the loop to the
//     left hand, soft guides keep it round (the hand shapes it); while Noor presses the eight flat,
//     a soft guide pushes the loop into the ring's plane (her flat fingers).
//   - simulated: everything the cable does by itself: the loop twisting into an eight as soon as
//     the guides let go, standing out of the ring, popping out again after the press, opening when
//     the twist is rolled out, the hanging cable untwisting and the plug spinning when the end
//     hangs free.
//
// Shots (all 120 fps for the slow motions, 15 substeps = the preset's 30 per 1/60 s):
//   eight-snap     ✗ the over loop with 2.2 turns: laid, given to the fist, let go → eight; pressed
//                  into the ring's plane, let go → it pops out again
//   eight-ok       ✓ the comparison: the same loop in a cable without twist stays flat
//   eight-reverse  fix 2: the same twisted cable, the loop laid the other way (unter): 0.2 turns, flat
//   eight-roll     fix 1: laid as in eight-snap, but the pads keep the loop's end; it starts to turn
//                  into an eight; four strokes of the thumb roll two turns out; it falls flat; then
//                  the fist takes it
//   eight-swivel   fix 3: from the end of eight-snap: the left hand lifts the ring to chest height,
//                  the plug comes off the floor and hangs free, the fist lets the last strand turn:
//                  the twist runs out at the free end (the plug spins)
//
// Coordinates as in stage 1 (coiling.ts GEOM): Noor stands at the origin facing −z, her right is +x.
// The loops hang below the left fist in planes facing forward and to her right (axis N); every new
// loop lies in front of the others (+N). Material order: a short tail inside the fist (from the
// earlier loops), the new loop, the strand into the right hand's pads, the cable to the floor, the
// female XLR plug lying on the floor.

import { Capsule, Frame, Rod, RodState, TAU, V3, XLR, buildCable, frameTrack, gripFrame, quatFromAxisAngle, quatMul, quatRotate, smooth } from '../sim';
import type { Pinch } from '../sim';
import type { ShotBuild, ShotDef } from './types';

// ------------------------------------------------------------------------------------- vectors

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => mul(a, 1 / (len(a) || 1));
const mix = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** minimum-jerk ease 0 → 1 */
export const ease = (u: number) => {
  const x = clamp01(u);
  return x * x * x * (10 - 15 * x + 6 * x * x);
};

// ------------------------------------------------------------------------------------ geometry

const D = Math.PI / 180;
const UP: V3 = [0, 1, 0];
/** the coil's axis: forward, 55° to her right (coiling.ts GEOM.N): the loops face this way */
const N: V3 = norm([Math.sin(55 * D), 0, -Math.cos(55 * D)]);
/** across the loops, from the loop's start (lateral: out to her left and forward) to its end (medial) */
const E1: V3 = norm([-N[2], 0, N[0]]);

const RC = XLR.od / 2;
/** the new loop: cable length from the fist round to the fist [m] (Ø ≈ 23 cm) */
export const LOOP = 0.75;
/** at the hand-over: the loop's end lies this far from its start across the fist [m] */
const GAP = 0.07;
/** height/width of the round loop (hanging loops are a little taller than wide) */
const ASPECT = 1.08;
/** the tail inside the fist, the strand from the loop's end to the pads' middle [m] */
const TAIL = 0.035, TO_PADS = 0.04;
/** cable beyond the pads: straight on, hanging down, lying on the floor up to the plug tip [m] */
const BEYOND = 0.03, FLOOR = 0.15;
/** the cable to the floor lies this way on the floor (to her right and forward) */
const FLOOR_DIR: V3 = norm([0.55, 0, -0.45]);

/** the twist prescribed at the start [turns]: in the new loop (laid "über" / laid the other way), and per metre in the cable to the floor */
export const LOOP_TWIST = { over: 2.2, under: 0.2 };
export const SUPPLY = 1.8;

/**
 * The torsional stiffness of the eight shots [N m²]: 3e-4 instead of the XLR preset's 0.8e-4.
 * The preset's GJ is an estimate (sim/cables.ts, physics report: "twist is untested against
 * reality") from the slipping strands alone; with it the strand friction holds a loop with 2.85
 * turns round (it tilts 5 cm) and only ~6 turns creep into an eight after 1.3 s, which is not what a
 * real XLR does. Twisting a stranded cable also shears its stuck strands and the braid; 3e-4
 * (0.14 × (EI + frictionEI)) is the smallest of the tested values with which 2.85 turns flip within
 * a second and 0.85 turns stay flat (scratchpad p5e/sweep*.log: 0.8e-4 / 2e-4 / 3e-4 / 4e-4 / 8e-4
 * / 1.7e-3). Everything else is the preset.
 */
export const EIGHT_GJ = 3e-4;

/** settings the experiments vary (tools: scratchpad p5e/exp.mjs); the shots use them as they are */
export const EIGHT_CFG = { GJ: EIGHT_GJ, over: LOOP_TWIST.over, supply: SUPPLY };

/**
 * Where everything is. F: the cable's axis where the loop starts in the left fist; E: where its end
 * comes in at the hand-over; pads: the right hand's pads at the hand-over (über: 3.5 cm on Noor's
 * side of the new loop, so the cable to the floor hangs between her and the loop; unter: 3 cm in
 * front of it, the cable to the floor hangs behind the loop); hip: the right hand slid out.
 */
export const EIGHT_GEOM = (() => {
  const F: V3 = [-0.1, 0.94, -0.3];
  const E = add(F, mul(E1, GAP));
  const padsAt = (depth: number) => add(E, add(mul(E1, 0.036), mul(N, depth)));
  return {
    N,
    E1,
    up: UP,
    F,
    E,
    pads: { over: padsAt(-0.035), under: padsAt(0.03) },
    hip: [0.36, 0.84, -0.1] as V3,
    /** the left fist raised to chest height and held out in front (fix 3): the plug hangs free, clear of her legs */
    chest: [-0.05, 1.28, -0.42] as V3,
    loop: LOOP,
    gap: GAP,
    floorDir: FLOOR_DIR,
  };
})();

/**
 * Points of a round loop of arc length `l` hanging from a to b (an ellipse arc below the chord, in
 * the plane of the chord and the vertical), `n` + 1 points at equal arc length. The bottom of the
 * loop is ASPECT times as deep as the loop is wide.
 */
export function roundLoop(a: V3, b: V3, l: number, n: number): V3[] {
  const c = sub(b, a);
  const g = len(c);
  const u = g > 1e-9 ? mul(c, 1 / g) : E1;
  // down, perpendicular to the chord
  const dn = norm(sub([0, -1, 0], mul(u, -u[1])));
  const m = mul(add(a, b), 0.5);
  let rx = Math.max(g / 2 + 1e-4, l / (2 * Math.PI)), pts: V3[] = [];
  for (let iter = 0; iter < 40; iter++) {
    const ry = ASPECT * rx;
    const p0 = Math.asin(Math.min(1, g / 2 / rx));
    const at = (p: number): V3 => add(m, add(mul(u, -rx * Math.sin(p)), mul(dn, ry * (Math.cos(p0) - Math.cos(p)))));
    const M = 600, acc = [0];
    let prev = at(p0);
    const span = 2 * Math.PI - 2 * p0;
    for (let k = 1; k <= M; k++) {
      const q = at(p0 + (span * k) / M);
      acc.push(acc[k - 1] + len(sub(q, prev)));
      prev = q;
    }
    const L = acc[M];
    if (Math.abs(L - l) < 2e-5 || iter === 39) {
      pts = [];
      let k = 0;
      for (let i = 0; i <= n; i++) {
        const s = (i / n) * L;
        while (k < M - 1 && acc[k + 1] < s) k++;
        const w = (s - acc[k]) / (acc[k + 1] - acc[k] || 1);
        pts.push(at(p0 + (span * (k + w)) / M));
      }
      break;
    }
    rx = Math.max(g / 2 + 1e-4, rx * (l / L));
  }
  return pts;
}

/** dense points along a polyline at spacing h (keeps the corners) */
function densify(P: V3[], h: number): V3[] {
  const out: V3[] = [P[0]];
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i], d = len(sub(b, a)), k = Math.max(1, Math.round(d / h));
    for (let j = 1; j <= k; j++) out.push(mix(a, b, j / k));
  }
  return out;
}

/** a few passes of neighbour averaging: rounds the corners between the pieces (radius ~1–2 cm) */
function relax(P: V3[], passes: number, keep: (i: number) => boolean): V3[] {
  let A = P.map((p) => [...p] as V3);
  for (let r = 0; r < passes; r++) {
    const B = A.map((p) => [...p] as V3);
    for (let i = 1; i < A.length - 1; i++) if (!keep(i)) B[i] = mix(A[i], mul(add(A[i - 1], A[i + 1]), 0.5), 0.5);
    A = B;
  }
  return A;
}

/** the cable as Noor holds it at the hand-over (über or unter), and where its parts are */
interface Built {
  rod: Rod;
  /** nodes: loop start (in the fist), loop end (enters the fist), the pads' middle, the first node of the plug */
  iF: number;
  iE: number;
  iP: number;
  iPlug: number;
  sP: number;
  /** the plug's segments and mass (re-added after Rod.fromState) */
  plugSegs: [number, number];
}

function buildEight(kind: 'over' | 'under', loopTwist: number, supply: number): Built {
  const G = EIGHT_GEOM;
  const pads = G.pads[kind];
  const h = 0.0025;
  const pieces: V3[][] = [];
  // the tail: from the earlier loops (Noor's side) into the fist
  pieces.push(densify([sub(G.F, mul(N, TAIL)), G.F], h));
  // the loop
  const loopPts = roundLoop(G.F, G.E, LOOP, Math.round(LOOP / h));
  pieces.push(loopPts.slice(1));
  // up into the pads, a little further, then down to the floor and along it
  const dir = norm(sub(pads, G.E));
  const after = add(pads, mul(dir, BEYOND));
  const bend = 0.05;
  const low: V3 = [after[0], RC + bend, after[2]];
  const onFloor: V3 = add([after[0], RC, after[2]], mul(FLOOR_DIR, bend));
  pieces.push(densify([G.E, pads, after, low, onFloor], h).slice(1));
  // on the floor: a gentle S to the plug
  const side = norm(cross(UP, FLOOR_DIR));
  const fl: V3[] = [];
  const K = Math.round(FLOOR / h);
  for (let k = 1; k <= K; k++) {
    const s = (k / K) * FLOOR;
    fl.push(add(add(onFloor, mul(FLOOR_DIR, s)), mul(side, 0.06 * Math.sin((Math.PI * s) / FLOOR))));
  }
  pieces.push(fl);
  let P = pieces.flat();
  // markers before relaxing: F, E, pads (kept in place)
  const near = (q: V3) => {
    let b = 0, d = Infinity;
    P.forEach((p, i) => {
      const e = len(sub(p, q));
      if (e < d) { d = e; b = i; }
    });
    return b;
  };
  const kF = near(G.F), kE = near(G.E), kP = near(pads);
  P = relax(P, 14, (i) => Math.abs(i - kF) < 2 || Math.abs(i - kP) < 3 || (i > kF + 4 && i < kE - 4));
  const sAt = (k: number) => {
    let s = 0;
    for (let i = 1; i <= k; i++) s += len(sub(P[i], P[i - 1]));
    return s;
  };
  const sF = sAt(kF), sE = sAt(kE), sP0 = sAt(kP);
  // twist: none in the tail; LOOP_TWIST spread evenly over the loop; SUPPLY per metre beyond it
  const turnsAt = (s: number) => {
    if (s <= sF) return 0;
    if (s <= sE) return (loopTwist * (s - sF)) / (sE - sF);
    return loopTwist + supply * (s - sE);
  };
  const built = buildCable(XLR, P, { plugs: 'end', GJ: EIGHT_CFG.GJ, twist: (s) => TAU * turnsAt(s) });
  const rod = built.rod;
  const seg = (s: number) => rod.segmentAt(s);
  const iF = seg(sF), iE = seg(sE), iP = seg(sP0);
  return { rod, iF, iE, iP, iPlug: built.cable[1], sP: rod.sNode[iP] + rod.L[iP] / 2, plugSegs: [built.cable[1], rod.ns] };
}

/** puts the plug's mass back on its segments (it is not part of RodState) */
function plugMass(rod: Rod, segs: [number, number]) {
  const mass = XLR.plug?.mass ?? 0;
  let l = 0;
  for (let j = segs[0]; j < segs[1]; j++) l += rod.L[j];
  for (let j = segs[0]; j < segs[1]; j++) rod.addMass(j, mass * (rod.L[j] / l) - rod.m[j]);
}

// ------------------------------------------------------------------------------------- hands

/** the left fist's frame (the sim holds what it grips in the pose it had relative to it) */
const fistQ = gripFrame(EIGHT_GEOM.F, mul(N, 1), mul(E1, -1)).q;
export const fistFrame = (p: V3): Frame => ({ p, q: fistQ });

/**
 * The two loops Noor already has in her left hand (over-under, laid before; not simulated): round
 * loops like the new one, 9 and 18 mm behind it (on her side). The new loop's cable collides with
 * them (capsules), and the part draws them from the same points. `at` is the fist's point F.
 */
export function earlierLoops(at: V3 = EIGHT_GEOM.F): V3[][] {
  return [0.018, 0.009].map((d) => {
    const a = sub(at, mul(N, d));
    return roundLoop(a, add(a, mul(E1, GAP)), LOOP, 60);
  });
}

/** capsules along the earlier loops (r = the cable's radius: the simulation adds the moving cable's own) */
function loopCapsules(at: V3): Capsule[] {
  const out: Capsule[] = [];
  for (const L of earlierLoops(at)) for (let i = 2; i < L.length - 2; i++) out.push({ a: L[i], b: L[i + 1], r: RC, mu: XLR.selfFriction });
  return out;
}

/** the pads at p, the cable running through them along `along` (increasing s), the index finger toward `palm` */
const padsFrame = (p: V3, along: V3, palm: V3 = UP, roll = 0): Frame => {
  const f = gripFrame(p, along, palm);
  return roll ? { p, q: quatMul(f.q, quatFromAxisAngle(0, 0, 1, roll)) } : f;
};

/** keyframed point: [t, p] pairs, eased between them */
function pathKeys(k: [number, V3][]): (t: number) => V3 {
  return (t) => {
    if (t <= k[0][0]) return k[0][1];
    for (let i = 1; i < k.length; i++) if (t < k[i][0]) return mix(k[i - 1][1], k[i][1], ease((t - k[i - 1][0]) / (k[i][0] - k[i - 1][0])));
    return k[k.length - 1][1];
  };
}

// ------------------------------------------------------------------------------------ timings

/** eight-snap's beats [s]: lay the loop, give it to the fist, the eight, the press, the spring back */
export const SNAP_T = {
  /** the right hand at the hip starts back toward the fist */
  back0: 0.4,
  /** above the fist: the loop hangs round */
  back1: 1.55,
  /** the fist takes the strand */
  give: 1.7,
  /** the pads open */
  open: 1.8,
  /** the hand stops shaping the loop: from here it is on its own */
  free: 1.95,
  /** the hand goes back to her side */
  away0: 2.05,
  away1: 2.9,
  /** Noor's fingers reach the eight and press it flat (the hand sets off 0.9 s before) */
  press0: 5.4,
  pressed: 6.3,
  /** she lets go */
  letGo: 7.0,
  end: 9.0,
};

/** eight-ok and eight-reverse: lay and let go, then watch */
export const OK_T = { ...SNAP_T, end: 4.6 };

/** the twist of a simulation-in-the-loop clip that continues from eight-snap's end */
const SIM_FPS = 120, SIM_SUB = 15;

// ------------------------------------------------------------------------------------ tracks

interface Parts {
  iF: number;
  iE: number;
  iPlug: number;
}

/** how far the loop's cable is out of the loop plane (through the fist, normal N) [m] */
function outOfPlane(r: Rod, a: number, b: number) {
  let m = 0;
  for (let i = a; i <= b; i++) m = Math.max(m, Math.abs(dot(sub([r.x[3 * i], r.x[3 * i + 1], r.x[3 * i + 2]], EIGHT_GEOM.F), N)));
  return m;
}

/** the counters and checks every eight shot records */
function eightTracks(p: Parts, extra: Record<string, (r: Rod, t: number) => number> = {}) {
  let spin = 0;
  let last: V3 | null = null;
  return {
    /** twist in the loop [turns] (from its start in the fist to its end) */
    twLoop: (r: Rod) => r.twistTurns(p.iF, p.iE),
    /** writhe of the loop (open curve from fist to fist) */
    wrLoop: (r: Rod) => r.writhe(p.iF, p.iE + 1),
    /** twist from the loop's end to the plug [turns]: the cable to the floor */
    twHang: (r: Rod) => r.twistTurns(p.iE, r.ns - 1),
    /** twist from the loop's start to the plug [turns]: everything below the fist */
    twAll: (r: Rod) => r.twistTurns(p.iF, r.ns - 1),
    /** the loop out of its plane [m]: the eight stands out of the ring */
    out: (r: Rod) => outOfPlane(r, p.iF, p.iE),
    /** the lowest point of the plug above the floor [m] */
    plugY: (r: Rod) => {
      let y = Infinity;
      for (let i = p.iPlug; i < r.n; i++) y = Math.min(y, r.x[3 * i + 1]);
      return y - RC;
    },
    /** turns the plug has made about its own axis since the clip began (frame to frame, unwrapped) */
    plugSpin: (r: Rod) => {
      const fr = r.segmentFrame(r.ns - 1);
      if (last) spin += Math.atan2(dot(cross(last, fr.d1), fr.d3), dot(last, fr.d1)) / TAU;
      last = fr.d1;
      return spin;
    },
    ...extra,
  };
}

// --------------------------------------------------------------------------------- the shots

/** the right hand's pads during eight-snap / -ok / -reverse: out at the hip, back to the fist, holding (then they open) */
export function layPads(kind: 'over' | 'under') {
  const G = EIGHT_GEOM, T = SNAP_T;
  const along = norm(sub(G.pads[kind], G.E));
  const pos = pathKeys([
    [T.back0, G.hip],
    [T.back1, G.pads[kind]],
  ]);
  // at the hip the cable comes up from the loop and goes down to the floor: the pads hold it level
  const hipAlong = norm([E1[0], -0.15, E1[2]]);
  return (t: number): Frame => {
    const u = ease((t - T.back0) / (T.back1 - T.back0));
    return padsFrame(pos(t), norm(mix(hipAlong, along, u)), UP);
  };
}

/** the pre-roll path of the pads: from the hand-over point out to the hip (unrecorded, before shot time 0) */
const PRE = { t0: -2.6, out0: -2.4, out1: -1.2 };

interface LayClip {
  b: ShotBuild;
  parts: Built;
}

/**
 * eight-snap / -ok / -reverse / -roll: the cable is made as laid (loop round between the fist and
 * the pads), the pads carry it out to the hip before the shot starts (the loop opens into a U by
 * itself), then the shot: back to the fist (guides keep the loop round), the fist takes the
 * strand, the pads open, the guides let go. With `press`, her fingers later press the eight flat
 * and let go again. With `roll`, the pads keep the loop's end when the guides let go (the loop
 * starts to turn), roll the cable between thumb and index (ROLL_T), and only then give it to the
 * fist.
 */
function layClip(kind: 'over' | 'under', loopTwist: number, supply: number, o: { press?: boolean; roll?: boolean } = {}): LayClip {
  const press = !!o.press, roll = !!o.roll;
  const parts = buildEight(kind, loopTwist, supply);
  const { rod, iF, iE, iP } = parts;
  const G = EIGHT_GEOM, T = SNAP_T;
  const pads = layPads(kind);
  const along = norm(sub(G.pads[kind], G.E));
  // before the shot: from the hand-over point out to the hip
  const prePos = pathKeys([
    [PRE.out0, G.pads[kind]],
    [PRE.out1, G.hip],
  ]);
  const hipAlong = norm([E1[0], -0.15, E1[2]]);
  const padsAt = (t: number): Frame => {
    if (t < 0) {
      const u = ease((t - PRE.out0) / (PRE.out1 - PRE.out0));
      return padsFrame(prePos(t), norm(mix(along, hipAlong, u)), UP);
    }
    return pads(t);
  };
  const fist = fistFrame(G.F);
  rod.time = PRE.t0;
  const caps = loopCapsules(G.F);
  rod.setCapsules(caps);
  rod.addGrip({ nodes: [0, iF + 1], keepShape: true, frame: () => fist, blend: 0.01 });
  const pin: Pinch = rod.pinch({ frame: padsAt, mode: 'held', hand: 1, s: parts.sP, blend: 0.01, roll: roll ? (t) => rollAt(t) : 0 });
  // the plug's end on the floor rests where it lies (nothing holds it: floor friction)
  const fps = 60;
  for (let f = 0; f < Math.round(-PRE.t0 * fps); f++) rod.step(1 / fps, XLR.substeps);
  rod.time = 0;
  // the cable has hung like this for a moment: that is the shape its strands remember
  rod.rememberShape();

  // the loop's guides: round between its two held ends while the hands bring it together (from
  // barely touching to firm as the chord closes), off when the hand lets go
  const ga = iF + 2, gb = iE - 3;
  const nLoop = gb - ga;
  /** the fist takes the strand, the pads open */
  const give = roll ? ROLL_T.give : T.give, open = roll ? ROLL_T.open : T.open;
  const sB = rod.sNode[gb + 1];
  let shape: V3[] = [];
  let shapeT = -1;
  /** the guided loop's ends: in the fist; at the pads (until the fist has the strand) */
  const ends = (t: number): [V3, V3] => {
    const a: V3 = [rod.x[3 * (ga - 1)], rod.x[3 * (ga - 1) + 1], rod.x[3 * (ga - 1) + 2]];
    if (t >= give + 0.15) return [a, [rod.x[3 * (gb + 1)], rod.x[3 * (gb + 1) + 1], rod.x[3 * (gb + 1) + 2]]];
    const f = padsAt(t);
    return [a, sub(f.p, mul(quatRotate(f.q, [0, 0, 1]), parts.sP - sB))];
  };
  rod.addGuide({
    nodes: [ga, gb],
    compliance: 0.02,
    weight: (t) => {
      // rolling: the hand that holds the loop's end still keeps it open a little (weak) until the fist has it
      if (roll && t >= T.free) return 1 - 0.97 * smooth((t - T.free) / 0.25) - 0.03 * smooth((t - give) / 0.25);
      if (t >= T.free) return 1 - smooth((t - T.free) / 0.12);
      const [a, b] = ends(t);
      const close = smooth((0.36 - len(sub(b, a))) / 0.2);
      return close > 0 ? 10 ** (-3 * (1 - close)) : 0;
    },
    target: (i, t) => {
      if (shapeT !== t) {
        shapeT = t;
        const [a, b] = ends(t);
        shape = roundLoop(a, b, sB - rod.sNode[ga - 1], nLoop + 2);
      }
      return shape[i - ga + 1];
    },
  });
  // the press: her flat fingers push the eight into the ring's plane (each node of the loop toward
  // its own foot on the plane, from the shape it had when the fingers touched it), firmer and
  // firmer, hold, let go. The strands only move across the plane, never through each other.
  let pressed: Float64Array | null = null;
  if (press) {
    rod.addGuide({
      nodes: [ga, gb],
      compliance: 1e-4,
      weight: (t) => {
        if (t < T.press0 || !pressed) return 0;
        // the push grows from barely touching to firm (compliance 10 → 0.03 m/N), then lets go
        const u = clamp01((t - T.press0) / (T.pressed - T.press0));
        return u === 0 ? 0 : 1e-5 * 300 ** u * (1 - smooth((t - T.letGo) / 0.08));
      },
      target: (i, t) => {
        if (!pressed) return null;
        const u = ease((t - T.press0) / (T.pressed - T.press0));
        const p: V3 = [pressed[3 * i], pressed[3 * i + 1], pressed[3 * i + 2]];
        const w = dot(sub(p, G.F), N);
        return sub(p, mul(N, w * u));
      },
    });
  }

  let gave = false, opened = false;
  const script = (r: Rod, t: number) => {
    if (!gave && t >= give) {
      gave = true;
      // the fist closes over the loop's end strand
      r.addGrip({ nodes: [iE - 2, iE + 3], keepShape: true, frame: () => fist, blend: 0.12 });
    }
    if (!opened && t >= open) {
      opened = true;
      pin.release(0.12);
    }
    if (press && !pressed && t >= T.press0) pressed = r.x.slice();
    if (opened && t >= open + 0.2 && !pin.done) pin.remove();
  };
  void iP;
  const b: ShotBuild = {
    rod,
    script,
    tracks: { ...eightTracks(parts), iF: () => iF, iE: () => iE, iPlug: () => parts.iPlug, ...(roll ? { roll: (_r: Rod, t: number) => rollAt(t) / TAU } : {}) },
    vectors: { fist: frameTrack(() => fist), pads: frameTrack((_r, t) => padsAt(t)) },
  };
  return { b, parts };
}

/** runs a clip the way bake() does, without recording, and returns the end state */
function runClip(b: ShotBuild, duration: number, fps: number, substeps: number): RodState {
  const F = Math.round(duration * fps) + 1;
  for (let f = 0; f < F; f++) {
    b.script?.(b.rod, b.rod.time);
    if (f > 0) b.rod.step(1 / fps, substeps);
    else b.rod.sync();
  }
  return b.rod.saveState();
}

let snapEnd: { state: RodState; parts: Built } | null = null;
/** the state at the end of eight-snap (simulated once per process) */
export function afterSnap() {
  if (!snapEnd) {
    const c = layClip('over', EIGHT_CFG.over, EIGHT_CFG.supply, { press: true });
    snapEnd = { state: runClip(c.b, SNAP_T.end, SIM_FPS, SIM_SUB), parts: c.parts };
  }
  return snapEnd;
}

/** a rod continuing from the end of eight-snap at shot time 0, the fist holding the loop as before */
function continueRod() {
  const { state, parts } = afterSnap();
  const rod = Rod.fromState(state);
  plugMass(rod, parts.plugSegs);
  rod.time = 0;
  return { rod, parts };
}

export const eightSnap: ShotDef = {
  id: 'eight-snap',
  duration: SNAP_T.end,
  fps: SIM_FPS,
  substeps: SIM_SUB,
  iterations: XLR.iterations,
  build: () => layClip('over', EIGHT_CFG.over, EIGHT_CFG.supply, { press: true }).b,
};

export const eightOk: ShotDef = {
  id: 'eight-ok',
  duration: OK_T.end,
  fps: SIM_FPS,
  substeps: SIM_SUB,
  iterations: XLR.iterations,
  build: () => layClip('over', 0, 0).b,
};

export const eightReverse: ShotDef = {
  id: 'eight-reverse',
  duration: OK_T.end,
  fps: SIM_FPS,
  substeps: SIM_SUB,
  iterations: XLR.iterations,
  build: () => layClip('under', EIGHT_CFG.over - 2, EIGHT_CFG.supply).b,
};

// ------------------------------------------------------------------------------- fix 1: roll

/**
 * eight-roll's beats [s]: laid as in eight-snap; the hand stops shaping the loop at SNAP_T.free but
 * keeps its end; the loop starts to turn; four strokes of the thumb along the index finger roll
 * the cable half a turn each (two turns: the loop's 2.2 down to 0.2); then the fist takes it
 */
export const ROLL_T = {
  /** the strokes: π each (half a turn), from the moment the loop is at the fist (it starts to turn as soon as the hand stops shaping it, SNAP_T.free) */
  stroke0: 1.6,
  strokes: 4,
  stroke: 0.3,
  /** between two strokes the thumb goes back (the cable stays) */
  back: 0.12,
  get rolled() {
    return this.stroke0 + this.strokes * (this.stroke + this.back) - this.back;
  },
  get give() {
    return this.rolled + 0.7;
  },
  get open() {
    return this.give + 0.1;
  },
  get end() {
    return this.open + 2.0;
  },
};

/** the roll of the cable in the pads at time t [rad] (cumulative: the strokes add up; −: the loop's twist goes down) */
export function rollAt(t: number): number {
  const T = ROLL_T;
  let r = 0;
  for (let k = 0; k < T.strokes; k++) {
    const t0 = T.stroke0 + k * (T.stroke + T.back);
    r -= Math.PI * smooth((t - t0) / T.stroke);
  }
  return r;
}

/** the visible thumb roll (rad, within ±π/2 of the hand's range): rolls π per stroke, slides back between */
export function thumbRollAt(t: number): number {
  const T = ROLL_T;
  for (let k = 0; k < T.strokes; k++) {
    const t0 = T.stroke0 + k * (T.stroke + T.back);
    if (t < t0) return k === 0 ? -(Math.PI / 2) * smooth((t - (T.stroke0 - 0.3)) / 0.3) : -Math.PI / 2;
    if (t < t0 + T.stroke) return -Math.PI / 2 + Math.PI * smooth((t - t0) / T.stroke);
    if (k < T.strokes - 1 && t < t0 + T.stroke + T.back) return Math.PI / 2 - Math.PI * smooth((t - t0 - T.stroke) / T.back);
  }
  return (Math.PI / 2) * (1 - smooth((t - T.rolled) / 0.3));
}

/** the thumb is off the cable while it slides back between two strokes (0 … 1) */
export function thumbOpenAt(t: number): number {
  const T = ROLL_T;
  for (let k = 0; k < T.strokes - 1; k++) {
    const t0 = T.stroke0 + k * (T.stroke + T.back) + T.stroke;
    if (t >= t0 && t < t0 + T.back) return Math.sin((Math.PI * (t - t0)) / T.back);
  }
  return 0;
}

export const eightRoll: ShotDef = {
  id: 'eight-roll',
  duration: ROLL_T.end,
  fps: SIM_FPS,
  substeps: SIM_SUB,
  iterations: XLR.iterations,
  build: () => layClip('over', EIGHT_CFG.over, EIGHT_CFG.supply, { roll: true }).b,
};

// ----------------------------------------------------------------------------- fix 3: let it hang

/** eight-swivel's beats [s]: the fist loosens on the last strand and lifts the ring to chest height; the plug spins */
export const HANG_T = { loosen: 0.3, lift0: 0.5, lift1: 1.9, end: 9.0 };

export function hangFist(): (t: number) => Frame {
  const G = EIGHT_GEOM, T = HANG_T;
  const pos = pathKeys([
    [T.lift0, G.F],
    [T.lift1, G.chest],
  ]);
  return (t) => fistFrame(pos(t));
}

export const eightSwivel: ShotDef = {
  id: 'eight-swivel',
  duration: HANG_T.end,
  fps: SIM_FPS,
  substeps: SIM_SUB,
  iterations: XLR.iterations,
  build() {
    const { rod, parts } = continueRod();
    const fist = hangFist();
    rod.setCapsules((t) => loopCapsules(fist(t).p));
    rod.addGrip({ nodes: [0, parts.iF + 1], keepShape: true, frame: fist, blend: 0.01 });
    const gripB = rod.addGrip({ nodes: [parts.iE - 2, parts.iE + 3], keepShape: true, frame: fist, blend: 0.01 });
    // the strand where the fist holds it, as a frame that moves with the fist (it only translates)
    const jB = parts.iE;
    const pB: V3 = [rod.c[3 * jB], rod.c[3 * jB + 1], rod.c[3 * jB + 2]];
    const tB = norm(sub([rod.c[3 * jB + 3], rod.c[3 * jB + 4], rod.c[3 * jB + 5]], [rod.c[3 * jB - 3], rod.c[3 * jB - 2], rod.c[3 * jB - 1]]));
    const strand = gripFrame(pB, tB, mul(N, -1));
    const f0 = fist(0).p;
    const strandAt = (t: number): Frame => ({ p: add(strand.p, sub(fist(t).p, f0)), q: strand.q });
    let loose = false;
    const script = (r: Rod, t: number) => {
      if (!loose && t >= HANG_T.loosen) {
        loose = true;
        // the fist loosens on the last strand: it keeps it in place but lets it turn (the twist can leave the loop)
        r.releaseGrip(gripB);
        r.pinch({ frame: strandAt, mode: 'held', rolls: false, hand: 0, s: r.sNode[jB] + r.L[jB] / 2, blend: 0.05, pad: 0.012 });
      }
    };
    return {
      rod,
      script,
      tracks: { ...eightTracks(parts), iF: () => parts.iF, iE: () => parts.iE, iPlug: () => parts.iPlug },
      vectors: { fist: frameTrack((_r, t) => fist(t)) },
    };
  },
};

/** the old export, kept for tools/simtest/derisk-eight.mjs: the cable's radius */
export const EIGHT_CABLE = { radius: RC };

export const EIGHT_SHOTS: ShotDef[] = [eightSnap, eightOk, eightReverse, eightRoll, eightSwivel];
