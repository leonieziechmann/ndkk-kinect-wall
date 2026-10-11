// Stage 5.2 "Die verdrehte Schlaufe – sie schlägt eine Acht", in clips that chain:
//   eight-snap   a loop held by both hands carries ~2.85 turns of trapped twist (the cable comes
//                from a ring that was always wound the same way; the hanging cable is twisted
//                too). While the right hand still shapes it (guides) it is round; as soon as the
//                shaping stops it twists into an eight (the lower lobe turns over). The fingers
//                push it back into the round loop (soft guides), let go, and it springs back into
//                the eight (sperrig).
//   eight-roll   fix 1: the right hand rolls the cable back between its fingers (-2.85 turns);
//                the loop falls flat and round.
//   eight-swivel fix 3: the right hand opens to a loose fist (the cable may turn in it) and the
//                free end hangs instead of lying on the floor: the twist runs out, the plug spins,
//                the loop falls flat.
//   eight-ok     the same loop without stored twist: it stays flat (the comparison).
// eight-roll and eight-swivel start from the last frame of eight-snap (Rod.saveState).
//
// Coordinates: the hands hold the loop at height H in the x-y plane (Noor looks along -z), left
// fist at x < 0, right fist at x > 0; the cable before the loop goes back into the coil (-z), the
// cable after it runs toward Noor (+z) and down to the floor.

import { Frame, Quat, Rod, RodState, V3, quatFromAxisAngle, quatFromFrame, quatMul, smooth } from '../sim';
import type { ShotBuild, ShotDef } from './types';

/** XLR in a close-up / POV: 7 mm, contact radius 1.2 r */
export const EIGHT_CABLE = { radius: 0.0035, collisionRadius: 0.0042, linearDensity: 0.05, EI: 2e-3, GJ: 1.5e-3, damping: 1, angularDamping: 2 };
const SEG = 0.01;
/** loop length (Ø ≈ 25 cm), gap between the fists, height of the fists */
const LOOP = 0.78, GAP = 0.12, H = 1.15;
/** stored twist in the loop [turns], twist density of the hanging cable [turns/m] */
export const EIGHT_TWIST = 2.85;
const SUPPLY_TWIST = 1.2;
/** lengths: into the coil behind the left fist, the right fist, toward Noor, hanging down */
const TAIL = 0.12, FIST = 0.04, OUT = 0.1;
const DROP = H - 0.03;

/** Node indices: the loop runs from LOOP_A (in the left fist) to LOOP_B (entering the right fist). */
const TAIL_N = Math.round(TAIL / SEG), LOOP_N = Math.round(LOOP / SEG), FIST_N = Math.round(FIST / SEG);
export const LOOP_A = TAIL_N, LOOP_B = TAIL_N + LOOP_N;
const R_A = LOOP_B, R_B = LOOP_B + FIST_N;

/** times of eight-snap: the shaping stops; the fingers push it round, hold it, let go; the clip ends */
export const EIGHT_TIMES = { release: 0.8, press: 2.3, pressed: 3.1, letGo: 3.6, end: 5 };

/** The loop: an ellipse arc from the left fist down, round and up into the right fist. */
function loopShape(): { pts: V3[]; tA: V3; tB: V3 } {
  let rx = 0.13, ry = 0.15, pts: V3[] = [];
  for (let iter = 0; iter < 30; iter++) {
    const p0 = Math.asin(GAP / 2 / rx), yc = H - ry * Math.cos(p0);
    const ell = (p: number): V3 => [-rx * Math.sin(p), yc + ry * Math.cos(p), 0];
    // arc length by fine sampling, then nodes at equal arc length
    const M = 2000, acc = [0];
    for (let k = 1; k <= M; k++) {
      const a = ell(p0 + ((2 * Math.PI - 2 * p0) * (k - 1)) / M), b = ell(p0 + ((2 * Math.PI - 2 * p0) * k) / M);
      acc.push(acc[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const len = acc[M];
    if (Math.abs(len - LOOP) < 1e-5) {
      pts = [];
      let k = 0;
      for (let i = 0; i <= LOOP_N; i++) {
        const s = (i / LOOP_N) * len;
        while (k < M && acc[k + 1] < s) k++;
        const u = (s - acc[k]) / (acc[k + 1] - acc[k] || 1);
        pts.push(ell(p0 + ((2 * Math.PI - 2 * p0) * (k + u)) / M));
      }
      break;
    }
    rx *= LOOP / len;
    ry *= LOOP / len;
  }
  const dir = (a: V3, b: V3): V3 => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l, (b[2] - a[2]) / l];
  };
  return { pts, tA: dir(pts[0], pts[1]), tB: dir(pts[LOOP_N - 1], pts[LOOP_N]) };
}

/** Grip frame at p with cable direction t and d1 toward +z rotated by roll about t. */
function frameAt(p: V3, t: V3, roll = 0): Frame {
  const up: V3 = Math.abs(t[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const k = up[0] * t[0] + up[1] * t[1] + up[2] * t[2];
  let d1: V3 = [up[0] - k * t[0], up[1] - k * t[1], up[2] - k * t[2]];
  const l = Math.hypot(...d1);
  d1 = [d1[0] / l, d1[1] / l, d1[2] / l];
  const d2: V3 = [t[1] * d1[2] - t[2] * d1[1], t[2] * d1[0] - t[0] * d1[2], t[0] * d1[1] - t[1] * d1[0]];
  const q = quatMul(quatFromAxisAngle(t[0], t[1], t[2], roll), quatFromFrame(d1, d2, t));
  return { p, q };
}

const shape = loopShape();
/** The fists: the left one holds the start of the loop, the right one its end (rolled by `roll`). */
export const EIGHT_FISTS = {
  left: frameAt(shape.pts[0], shape.tA),
  right: (roll: number) => {
    const b = shape.pts[LOOP_N], t = shape.tB;
    return frameAt([b[0] + (t[0] * FIST) / 2, b[1] + (t[1] * FIST) / 2, b[2] + (t[2] * FIST) / 2], t, roll);
  },
};

/** The cable at rest before anything happens, with `twist` turns stored in the loop. */
function startRod(twist: number): Rod {
  const { pts, tB } = shape;
  const a = pts[0], b = pts[LOOP_N];
  const all: V3[] = [];
  for (let i = TAIL_N; i > 0; i--) all.push([a[0], a[1], a[2] - i * SEG]);
  all.push(...pts);
  for (let i = 1; i <= FIST_N; i++) all.push([b[0] + tB[0] * i * SEG, b[1] + tB[1] * i * SEG, b[2] + tB[2] * i * SEG]);
  const r = all[all.length - 1];
  for (let i = 1; i * SEG <= OUT; i++) all.push([r[0], r[1], r[2] + i * SEG]);
  const top = all[all.length - 1];
  for (let i = 1; i * SEG <= DROP; i++) all.push([top[0], top[1] - i * SEG, top[2]]);
  // twist: uniform over the loop, a little in the hanging cable (both from the same ring)
  const loopStart = TAIL_N * SEG, loopEnd = loopStart + LOOP;
  const turnsAt = (s: number) => {
    if (s <= loopStart) return 0;
    if (s <= loopEnd) return (twist * (s - loopStart)) / LOOP;
    return twist + (twist === 0 ? 0 : SUPPLY_TWIST * (s - loopEnd));
  };
  return Rod.fromPolyline(all, { ...EIGHT_CABLE, groundY: 0, twist: (s) => 2 * Math.PI * turnsAt(s) });
}

/** The plug end lies on the floor (held: it cannot turn). */
const floorEnd = (rod: Rod): Frame => {
  const e = rod.n - 1;
  return { p: [rod.x[3 * e - 3], rod.x[3 * e - 2], rod.x[3 * e - 1]], q: [0, 0, 0, 1] };
};

/**
 * eight-snap and eight-ok: the loop is shaped round (guides), then let go; with `press`, the
 * fingers later push the eight back into the round loop and let go again.
 */
function snapBuild(twist: number, press: boolean): ShotBuild {
  const rod = startRod(twist);
  const n = rod.n;
  rod.addGrip({ nodes: [0, LOOP_A + 2], keepShape: true, frame: () => EIGHT_FISTS.left });
  rod.addGrip({ nodes: [R_A, R_B], frame: () => EIGHT_FISTS.right(0) });
  const f = floorEnd(rod);
  rod.addGrip({ nodes: [n - 3, n - 1], keepShape: true, frame: () => f });
  // the round loop as the right hand laid it: held until `release`, and (press) pushed back into
  // that shape by Noor's fingers from `press` to `pressed`, held, and let go at `letGo`
  const x0 = rod.x.slice();
  const { release, press: p0, pressed, letGo } = EIGHT_TIMES;
  rod.addGuide({
    nodes: [LOOP_A + 3, LOOP_B - 1],
    compliance: 1e-4,
    weight: (t) => {
      if (t < p0 || !press) return 1 - smooth((t - release) / 0.12);
      // the push grows from barely touching to firm (compliance 10 → 0.01 m/N), then lets go
      const u = Math.min(1, Math.max(0, (t - p0) / (pressed - p0)));
      return u === 0 ? 0 : 1e-5 * 1000 ** u * (1 - smooth((t - letGo) / 0.1));
    },
    target: (i) => [x0[3 * i], x0[3 * i + 1], x0[3 * i + 2]],
  });
  return { rod, tracks: loopTracks() };
}

/** Tracks for the counters: twist and writhe of the loop, and how far the loop stands out of its plane. */
function loopTracks() {
  return {
    twist: (r: Rod) => r.twistTurns(LOOP_A, LOOP_B),
    writhe: (r: Rod) => r.writhe(LOOP_A, LOOP_B + 1),
    outOfPlane: (r: Rod) => {
      let m = 0;
      for (let i = LOOP_A; i <= LOOP_B; i++) m = Math.max(m, Math.abs(r.x[3 * i + 2]));
      return m;
    },
    /** turns the plug end has made (twist between the right fist and the end, for the plug's spin) */
    endTwist: (r: Rod) => r.twistTurns(R_B, r.ns - 1),
  };
}

/** Runs a clip the way bake() does, without recording, and returns the end state. */
function runClip(b: ShotBuild, duration: number, fps: number, substeps: number): RodState {
  const F = Math.round(duration * fps) + 1;
  for (let f = 0; f < F; f++) {
    b.script?.(b.rod, b.rod.time);
    if (f > 0) b.rod.step(1 / fps, substeps);
    else b.rod.sync();
  }
  return b.rod.saveState();
}

const SNAP_FPS = 120, SNAP_SUB = 30;
let snapEnd: RodState | null = null;
/** The state at the end of eight-snap (simulated once per process). */
function afterSnap(): RodState {
  if (!snapEnd) snapEnd = runClip(snapBuild(EIGHT_TWIST, true), EIGHT_TIMES.end, SNAP_FPS, SNAP_SUB);
  return snapEnd;
}

/** A rod continuing from the end of eight-snap at shot time 0, held as at the end of it. */
function continueRod(): Rod {
  const rod = Rod.fromState(afterSnap());
  rod.time = 0;
  return rod;
}

export const eightSnap: ShotDef = {
  id: 'eight-snap',
  duration: EIGHT_TIMES.end,
  fps: SNAP_FPS,
  substeps: SNAP_SUB,
  build: () => snapBuild(EIGHT_TWIST, true),
};

export const eightOk: ShotDef = {
  id: 'eight-ok',
  duration: 2.5,
  build: () => snapBuild(0, false),
};

/** fix 1: the right fist rolls the stored twist back out of the loop in ROLL_TIME seconds */
export const ROLL_TIME = 2.5;
export const eightRoll: ShotDef = {
  id: 'eight-roll',
  duration: ROLL_TIME + 1.5,
  build() {
    const rod = continueRod(), n = rod.n;
    rod.addGrip({ nodes: [0, LOOP_A + 2], keepShape: true, frame: () => EIGHT_FISTS.left });
    rod.addGrip({ nodes: [R_A, R_B], frame: (t) => EIGHT_FISTS.right(-2 * Math.PI * EIGHT_TWIST * smooth((t - 0.3) / ROLL_TIME)) });
    const f = floorEnd(rod);
    rod.addGrip({ nodes: [n - 3, n - 1], keepShape: true, frame: () => f });
    return { rod, tracks: loopTracks() };
  },
};

/** fix 3: the right fist loosens (swivel) and the plug end is lifted to hang free (swivel) */
export const eightSwivel: ShotDef = {
  id: 'eight-swivel',
  duration: 5,
  build() {
    const rod = continueRod(), n = rod.n;
    rod.addGrip({ nodes: [0, LOOP_A + 2], keepShape: true, frame: () => EIGHT_FISTS.left });
    rod.addGrip({ nodes: [R_A, R_B], swivel: true, frame: () => EIGHT_FISTS.right(0) });
    const f = floorEnd(rod);
    // the end is lifted 25 cm off the floor so it hangs (the plug, no longer on the floor, spins)
    rod.addGrip({ nodes: [n - 3, n - 1], swivel: true, frame: (t) => ({ p: [f.p[0], f.p[1] + 0.25 * smooth(t / 0.6), f.p[2]], q: hangDown }) });
    return { rod, tracks: loopTracks() };
  },
};

/** frame of a hanging end: cable direction (d3) straight down */
const hangDown: Quat = quatFromAxisAngle(1, 0, 0, Math.PI / 2);
