// Physics test shots for the "dead" XLR cable (src/sim/cables.ts) and the hand grips
// (src/sim/grips.ts). Each one is a small experiment with simple test hands (capsules: palm,
// thumb, index, the other fingers), baked like any shot (npm run bake) and shown side by side in
// the test scene src/scenes/test/physics.tsx; tools/simtest/physics.mjs runs the same shots and
// measures them.
//
//   phys-drape   the cable hung over a finger, as in the user's photo
//   phys-u       a U between two hands 60 cm apart; one hand moves 20 cm sideways and stops
//   phys-grab    a hand goes to a hanging cable (the cable to the floor), pinches it where it is
//                and moves it 50 cm in 0.6 s, then stops
//   phys-lay     a hand lays the cable in a bend on the floor and lets go
//   phys-coil    pinch and bundle together: the right hand slides out along the cable through a
//                loose pinch, holds, brings the point back into the left hand, which takes it
//                into its bundle; five loops (a 5 m XLR coils in 4.5-5), then the left hand moves
//                the coil and holds it still
//   phys-roll    a held pinch rolls the cable 180° between thumb and index, then the hand turns
//
// The hands go to the cable: every grip is made where the cable is at that moment (the scripts
// read the rod, sim in the loop), and the hand frames and capsules are recorded as vectors.

import { BuiltCable, Bundle, Capsule, CoilMemory, Frame, Pinch, Rod, RodBuildOptions, V3, XLR, buildCable, capsuleTrack, frameTrack, gripFrame, normalize, quatFromAxisAngle, quatMul, quatRotate, sub } from '../sim';
import type { ShotDef } from './types';

const RC = XLR.od / 2;

/** minimum-jerk ease 0 … 1 (the smooth way hands move) */
export const minJerk = (u: number) => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * x * (10 - 15 * x + 6 * x * x);
};

const lerpV = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];

/** A keyframed point: min-jerk from key to key, holding before the first and after the last. */
export function keyPath(keys: [number, V3][]): (t: number) => V3 {
  return (t) => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i][0]) return lerpV(keys[i - 1][1], keys[i][1], minJerk((t - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0])));
    }
    return keys[keys.length - 1][1];
  };
}

const local = (f: Frame, v: V3): V3 => {
  const r = quatRotate(f.q, v);
  return [f.p[0] + r[0], f.p[1] + r[1], f.p[2] + r[2]];
};

/**
 * Test hand for a pinch frame (d1 toward the palm, d3 along the cable): the index and thumb pads
 * on either side of the cable, the palm behind them, the other fingers curled below the index.
 * Radii: fingers 7.5–9 mm, palm 22 mm. open 0..1 moves the pads apart and the thumb up (a hand
 * that lets go opens its fingers before it moves away).
 */
export function pinchHand(f: Frame, group: number, open = 0): Capsule[] {
  const fi = 0.0075, th = 0.009, o = Math.min(1, Math.max(0, open));
  const c = (a: V3, b: V3, r: number): Capsule => ({ a: local(f, a), b: local(f, b), r, group });
  return [
    c([0.085, -0.01, -0.03], [0.085, -0.01, 0.03], 0.022), // palm
    c([0.075, -0.022, -0.012], [0.036, -0.018 - 0.006 * o, -0.004], fi), // index, proximal
    c([0.036, -0.018 - 0.006 * o, -0.004], [0.004 + 0.004 * o, -(RC + fi) - 0.012 * o, 0], fi), // index, distal: pad against the cable
    c([0.065, 0.032, 0.02], [0.03 + 0.006 * o, 0.022 + 0.008 * o, 0.01], th), // thumb, proximal
    c([0.03 + 0.006 * o, 0.022 + 0.008 * o, 0.01], [0.004 + 0.012 * o, RC + th + 0.014 * o, 0], th), // thumb, distal: pad against the cable
    c([0.078, -0.038, -0.004], [0.042, -0.05, 0.006], 0.008), // middle, ring and little fingers, curled
  ];
}

/** how open the pads of a pinch are (for pinchHand): closed when held, a little when loose, open when free */
export const padsOpen = (pin: Pinch | null, t: number) => (pin ? 1 - Math.min(1, pin.level(t) / 0.5) : 1);

/** Test hand holding a bundle: a fist round the frame's d3 axis (palm toward d1). */
export function fistHand(f: Frame, group: number, r = 0.012): Capsule[] {
  const c = (a: V3, b: V3, rr: number): Capsule => ({ a: local(f, a), b: local(f, b), r: rr, group });
  return [
    c([r + 0.022, 0, -0.035], [r + 0.022, 0, 0.035], 0.022), // palm
    c([0, -(r + 0.009), -0.03], [0, -(r + 0.009), 0.03], 0.009), // fingers wrapped under
    c([-(r + 0.008), 0, -0.02], [-(r + 0.008), 0, 0.02], 0.008), // thumb on top
  ];
}

/** points along a polyline description: start point then [direction, length] runs, ~2 mm apart */
function polyline(start: V3, runs: [V3, number][]): V3[] {
  const out: V3[] = [start];
  let p = start;
  for (const [d, len] of runs) {
    const n = Math.max(1, Math.round(len / 0.002)), u = normalize(d);
    for (let i = 1; i <= n; i++) out.push([p[0] + (u[0] * len * i) / n, p[1] + (u[1] * len * i) / n, p[2] + (u[2] * len * i) / n]);
    p = out[out.length - 1];
  }
  return out;
}

/** a quarter-round corner from direction a to b with radius r, appended to pts */
function corner(pts: V3[], a: V3, b: V3, r: number) {
  const p = pts[pts.length - 1], ua = normalize(a), ub = normalize(b);
  const c: V3 = [p[0] + ub[0] * r, p[1] + ub[1] * r, p[2] + ub[2] * r];
  for (let i = 1; i <= 24; i++) {
    const th = (i / 24) * (Math.PI / 2);
    pts.push([c[0] - ub[0] * r * Math.cos(th) + ua[0] * r * Math.sin(th), c[1] - ub[1] * r * Math.cos(th) + ua[1] * r * Math.sin(th), c[2] - ub[2] * r * Math.cos(th) + ua[2] * r * Math.sin(th)]);
  }
}

/** tracks with the node range of the cable proper (the tube; the plugs lie beyond) */
export const cableRange = (b: BuiltCable) => ({ cable0: () => b.cable[0], cable1: () => b.cable[1] });

/** lets a rod settle for `seconds` before shot time 0 (the hands must already hold it) */
function preroll(rod: Rod, seconds: number, step?: (t: number) => void) {
  rod.time = -seconds;
  const frames = Math.round(seconds * 60);
  for (let f = 0; f < frames; f++) {
    step?.(rod.time);
    rod.step(1 / 60, XLR.substeps);
  }
  rod.time = 0;
}

// ---------------------------------------------------------------- phys-drape

export const DRAPE = { finger: { a: [0, 1, -0.05] as V3, b: [0, 1, 0.05] as V3, r: 0.0085 } };

export const physDrape: ShotDef = {
  id: 'phys-drape',
  duration: 12,
  substeps: XLR.substeps,
  build() {
    const H = 1, top = H + DRAPE.finger.r + RC, R = 0.02, cy = top - R;
    const pts: V3[] = [];
    for (let y = cy - (XLR.plug as { length: number }).length - 0.06; y < cy; y += 0.002) pts.push([-R, y, 0]);
    for (let a = Math.PI; a >= 0; a -= 0.02) pts.push([R * Math.cos(a), cy + R * Math.sin(a), 0]);
    for (let y = cy; y > RC; y -= 0.002) pts.push([R, y, 0]);
    for (let x = R; x < R + 0.3; x += 0.002) pts.push([x, RC, 0]);
    const built = buildCable(XLR, pts, { plugs: 'start' }), rod = built.rod;
    // it was straight before it was hung over the finger: the friction memory starts straight
    rod.restFric.fill(0);
    rod.setRestStraight();
    const finger: Capsule = { ...DRAPE.finger, group: 0 };
    rod.setCapsules([finger]);
    return { rod, vectors: { caps: capsuleTrack(1, () => [finger]) }, tracks: cableRange(built) };
  },
};

// ---------------------------------------------------------------- phys-u

export const U = { span: 0.6, height: 1.0, tMove: 2, tBack: 4.5, move: 0.2, moveTime: 0.5 };

const uHand = (side: -1 | 1) => {
  const z = keyPath([[U.tMove, [0, 0, 0]], [U.tMove + U.moveTime, [0, 0, U.move]], [U.tBack, [0, 0, U.move]], [U.tBack + U.moveTime, [0, 0, 0]]]);
  return (t: number): Frame => {
    const dz = side > 0 ? z(t)[2] : 0;
    return gripFrame([(side * U.span) / 2, U.height, dz], [1, 0, 0], [0, 1, 0]);
  };
};
export const U_HANDS = { left: uHand(-1), right: uHand(1) };

export const physU: ShotDef = {
  id: 'phys-u',
  duration: 7,
  substeps: XLR.substeps,
  build() {
    const h = U.height, x0 = -U.span / 2;
    // tail hanging from the left hand, a smooth U (a parabola 0.9 m long), tail on the right
    const pts = polyline([x0 - 0.02, h - 0.2, 0], [[[0, 1, 0], 0.18]]);
    corner(pts, [0, 1, 0], [1, 0, 0], 0.02);
    const uLen = (sag: number) => {
      let l = 0;
      for (let i = 0; i < 200; i++) {
        const xa = x0 + (U.span * i) / 200, xb = x0 + (U.span * (i + 1)) / 200;
        l += Math.hypot(xb - xa, sag * ((1 - (2 * xb / U.span) ** 2) - (1 - (2 * xa / U.span) ** 2)));
      }
      return l;
    };
    let sag = 0.3;
    for (let it = 0; it < 30; it++) sag *= 0.9 / uLen(sag);
    for (let i = 1; i <= 300; i++) {
      const x = x0 + (U.span * i) / 300;
      pts.push([x, h - sag * (1 - (2 * x / U.span) ** 2), 0]);
    }
    corner(pts, [1, 0, 0], [0, -1, 0], 0.02);
    pts.push(...polyline(pts[pts.length - 1], [[[0, -1, 0], 0.18]]).slice(1));
    const built = buildCable(XLR, pts, { plugs: 'none', groundY: 0 }), rod = built.rod;
    let pins: Pinch[] = [];
    const makePins = () => {
      pins = [rod.pinch({ frame: U_HANDS.left, hand: 0, blend: 0.01 }), rod.pinch({ frame: U_HANDS.right, hand: 1, blend: 0.01 })];
    };
    const caps = (t: number) => [...pinchHand(U_HANDS.left(t), 0), ...pinchHand(U_HANDS.right(t), 1)];
    rod.time = -2;
    makePins();
    rod.setCapsules(caps);
    preroll(rod, 2);
    // the cable has hung like this for a while: it remembers this shape, not the made-up start
    rod.rememberShape();
    return {
      rod,
      vectors: {
        left: frameTrack((_, t) => U_HANDS.left(t)),
        right: frameTrack((_, t) => U_HANDS.right(t)),
        caps: capsuleTrack(12, (r) => r.currentCapsules()),
      },
      tracks: { sPinchR: () => pins[1].s, ...cableRange(built) },
    };
  },
};

// ---------------------------------------------------------------- phys-grab

export const GRAB = { reach: [0.05, 0.5, 0.25] as V3, tAt: 0.8, tLift: 1.5, lift: 0.65, tMove: 1.8, moveTime: 0.6, move: [0.5, 0, 0.05] as V3, duration: 5 };

export const physGrab: ShotDef = {
  id: 'phys-grab',
  duration: GRAB.duration,
  substeps: XLR.substeps,
  build() {
    // a cable lying on the floor in a gentle S
    const pts: V3[] = [];
    let p: V3 = [-1.05, RC, 0.15], h = -0.25;
    for (let s = 0; s < 2.4; s += 0.002) {
      pts.push(p);
      h += 0.002 * 0.6 * Math.sin(s * 2.2);
      p = [p[0] + 0.002 * Math.cos(h), RC, p[2] + 0.002 * Math.sin(h)];
    }
    const built = buildCable(XLR, pts, { plugs: 'both' }), rod = built.rod;
    preroll(rod, 0.5);
    // the hand goes down to the cable where it is (the point nearest below its start), then lifts and moves
    const near = rod.closestPoint([GRAB.reach[0], RC, 0]);
    const at = near.point, along = near.tangent;
    const up: V3 = [at[0], GRAB.lift, at[2]];
    const end: V3 = [up[0] + GRAB.move[0], up[1] + GRAB.move[1], up[2] + GRAB.move[2]];
    const path = keyPath([[0.1, GRAB.reach], [GRAB.tAt, at], [GRAB.tAt + 0.1, at], [GRAB.tLift, up], [GRAB.tMove, up], [GRAB.tMove + GRAB.moveTime, end]]);
    // the pads along the cable, palm up above it (the hand comes from above)
    const right = (t: number): Frame => gripFrame(path(t), along, [0, 1, 0]);
    let pin: Pinch | null = null;
    rod.setCapsules((t) => pinchHand(right(t), 1));
    return {
      rod,
      script: (r: Rod, t: number) => {
        if (!pin && t >= GRAB.tAt) pin = r.pinch({ frame: right, hand: 1, mode: 'held', blend: 0.1 });
      },
      vectors: { right: frameTrack((_, t) => right(t)), caps: capsuleTrack(6, (_, t) => pinchHand(right(t), 1)) },
      tracks: { gripDistance: () => (pin ? pin.gripDistance : -1), sPinch: () => (pin ? pin.s : -1), ...cableRange(built) },
    };
  },
};

// ---------------------------------------------------------------- phys-lay

export const LAY = { s: 1.3, tAt: 0.6, tLift: 0.9, tLay: 3.2, tDown: 3.5, tOpen: 3.6, radius: 0.15, lift: 0.04, duration: 6.5 };

export const physLay: ShotDef = {
  id: 'phys-lay',
  duration: LAY.duration,
  substeps: XLR.substeps,
  build() {
    const pts = polyline([-0.5, RC, 0], [[[1, 0, 0], 1.5]]);
    const built = buildCable(XLR, pts, { plugs: 'both' }), rod = built.rod;
    preroll(rod, 0.5);
    const p0 = rod.pointAt(LAY.s);
    const R = LAY.radius, cz = p0[2] - R;
    // down to the cable, lift, then a half circle round (the cable is dragged behind), down, open
    const round = (u: number): V3 => {
      const a = Math.PI * minJerk(u);
      return [p0[0] + R * Math.sin(a) + 0.12 * minJerk(u), RC + LAY.lift, cz + R * Math.cos(a)];
    };
    const hand = (t: number): V3 => {
      if (t < LAY.tAt) return lerpV([p0[0] + 0.05, 0.2, p0[2]], p0, minJerk((t - 0.1) / (LAY.tAt - 0.1)));
      if (t < LAY.tLift) return lerpV(p0, round(0), minJerk((t - LAY.tAt) / (LAY.tLift - LAY.tAt)));
      if (t < LAY.tLay) return round((t - LAY.tLift) / (LAY.tLay - LAY.tLift));
      const e = round(1);
      if (t < LAY.tDown) return lerpV(e, [e[0], RC, e[2]], minJerk((t - LAY.tLay) / (LAY.tDown - LAY.tLay)));
      return lerpV([e[0], RC, e[2]], [e[0] - 0.03, 0.2, e[2]], minJerk((t - LAY.tOpen - 0.15) / 0.6));
    };
    // the pads' axis follows the way the hand goes round (the cable trails behind)
    const dirAt = (t: number): V3 => {
      const a = hand(Math.max(LAY.tLift, Math.min(LAY.tLay, t)) - 0.02), b = hand(Math.max(LAY.tLift, Math.min(LAY.tLay, t)) + 0.02);
      const d = sub(b, a);
      return Math.hypot(d[0], d[2]) < 1e-6 ? [1, 0, 0] : normalize([d[0], 0, d[2]]);
    };
    const frame = (t: number): Frame => gripFrame(hand(t), t < LAY.tLift ? [1, 0, 0] : dirAt(t), [0, 1, 0]);
    let pin: Pinch | null = null;
    // the fingers come down open, close on the cable, open again when they let go
    const open = (t: number) => (t < LAY.tAt ? 1 - minJerk((t - LAY.tAt + 0.25) / 0.25) : padsOpen(pin, t));
    rod.setCapsules((t) => pinchHand(frame(t), 1, open(t)));
    return {
      rod,
      script: (r: Rod, t: number) => {
        if (!pin && t >= LAY.tAt) pin = r.pinch({ frame, hand: 1, mode: 'held', blend: 0.1 });
        if (pin && t >= LAY.tOpen && pin.state !== 'free') pin.release(0.15);
      },
      vectors: { right: frameTrack((_, t) => frame(t)), caps: capsuleTrack(6, (r) => r.currentCapsules()) },
      tracks: cableRange(built),
    };
  },
};

// ---------------------------------------------------------------- phys-coil

export const COIL = {
  left: [0, 1.0, 0] as V3,
  loops: 5,
  /** per loop: approach, slide out, close, return, place, open; then the next loop */
  beat: { take: 0.35, slide: 1.3, close: 0.15, ret: 1.3, place: 0.2, open: 0.3 },
  out: [0.72, -0.22, 0.03] as V3,
  tMoveCoil: 0,
  duration: 0,
};
const BEAT = COIL.beat, LOOP = BEAT.take + BEAT.slide + BEAT.close + BEAT.ret + BEAT.place + BEAT.open;
COIL.tMoveCoil = 0.3 + COIL.loops * LOOP + 0.3;
COIL.duration = COIL.tMoveCoil + 4;

/** the left hand: a fist, the cable running through it toward +x; at the end it moves the coil */
export function coilLeft(t: number): Frame {
  const u = minJerk((t - COIL.tMoveCoil) / 0.8);
  const p: V3 = [COIL.left[0] - 0.15 * u, COIL.left[1] + 0.03 * u, COIL.left[2] + 0.05 * u];
  const q = quatMul(quatFromAxisAngle(0, 1, 0, 0.35 * u), gripFrame([0, 0, 0], [1, 0, 0], [0, 1, 0]).q);
  return { p, q };
}

/** Options of the coil test (experiments: tools/simtest; the shot phys-coil uses the defaults). */
export interface CoilTestOptions {
  id?: string;
  /** the coil a used cable remembers (BuildCableOptions.memory) */
  memory?: CoilMemory;
  /** while the hand brings the strand back, roll the remembered bend down into the loop (Pinch.rollToCurl) */
  rollToCurl?: boolean;
  /** extra rod options */
  rod?: RodBuildOptions;
}

export function coilShot(o: CoilTestOptions = {}): ShotDef {
  return {
  id: o.id ?? 'phys-coil',
  duration: COIL.duration,
  substeps: XLR.substeps,
  build() {
    const L = COIL.left;
    // the plug end in the fist (along +x), then down to the floor and away along it
    const pts = polyline([L[0] - 0.1, L[1], 0], [[[1, 0, 0], 0.14]]);
    corner(pts, [1, 0, 0], [0, -1, 0], 0.04);
    pts.push(...polyline(pts[pts.length - 1], [[[0, -1, 0], L[1] - 0.04 - RC - 0.05]]).slice(1));
    corner(pts, [0, -1, 0], [1, 0, 0], 0.05);
    pts.push(...polyline(pts[pts.length - 1], [[[1, 0, 0.3], 0.8 * COIL.loops + 0.6]]).slice(1));
    const built = buildCable(XLR, pts, { plugs: 'both', memory: o.memory ?? null, ...o.rod }), { rod, sCable } = built;
    const coil: Bundle = rod.bundle({ frame: coilLeft, hand: 0, blend: 0.15 });
    rod.time = -1.5;
    coil.add(0, 0.11);
    rod.setCapsules((t) => fistHand(coilLeft(t), 0));
    preroll(rod, 1.5);

    // the right hand, planned loop by loop from where the cable is (sim in the loop)
    let pin: Pinch | null = null;
    let k = -1, t0 = 0;
    let sHand = 0;
    let path: (t: number) => V3 = () => [L[0] + 0.1, L[1] + 0.1, 0.15];
    let axis: (t: number) => V3 = () => [1, 0, 0];
    const right = (t: number): Frame => gripFrame(path(t), axis(t), [0, 1, 0]);
    const placed: number[] = [0.11];
    let phase = 'wait';
    const script = (r: Rod, t: number) => {
      const kk = Math.floor((t - 0.3) / LOOP);
      if (kk >= 0 && kk < COIL.loops && kk !== k) {
        // a new loop: the hand goes to the cable ~7 cm out of the fist, from above, clear of the loops
        k = kk;
        t0 = 0.3 + k * LOOP;
        const sStart = placed[placed.length - 1] + 0.07;
        const at = r.pointAt(sStart);
        const from = path(t);
        const dir = r.tangentAt(sStart);
        const out: V3 = [L[0] + COIL.out[0], L[1] + COIL.out[1], L[2] + COIL.out[2] + 0.012 * k];
        const back: V3 = [L[0] + 0.035, L[1], L[2] + 0.009 * (k + 1)];
        const mid: V3 = [L[0] + 0.4, L[1] + 0.02, L[2] + 0.04];
        const tA = t0 + BEAT.take, tS = tA + BEAT.slide, tC = tS + BEAT.close, tR = tC + BEAT.ret;
        const above: V3 = [at[0] + 0.04, at[1] + 0.1, at[2] + 0.03];
        path = keyPath([[t0, from], [t0 + BEAT.take * 0.6, above], [tA, at], [tS, out], [tC, out], [tC + BEAT.ret * 0.5, mid], [tR, back], [tR + BEAT.place + 0.05, back], [tR + BEAT.place + BEAT.open, [back[0] + 0.08, back[1] + 0.06, back[2] + 0.06]]]);
        // the pads along the cable while sliding out; on the way back the wrist turns them level
        // (+x, slightly up), so the strand comes into the fist from below and the loop closes round
        const dOut = normalize(sub(out, at)), dIn: V3 = normalize([1, 0.2, 0]);
        axis = (tt) => (tt < tA ? dir : tt < tC ? normalize(lerpV(dir, dOut, minJerk((tt - tA) / 0.3))) : normalize(lerpV(dOut, dIn, minJerk((tt - tC) / BEAT.ret))));
        phase = 'take';
      }
      if (k < 0) return;
      const tA = t0 + BEAT.take, tS = tA + BEAT.slide, tC = tS + BEAT.close, tR = tC + BEAT.ret, tP = tR + BEAT.place;
      if (phase === 'take' && t >= tA) {
        // the same pinch every loop: it closes on whatever is between the pads now
        if (!pin) pin = r.pinch({ frame: right, hand: 1, mode: 'loose', blend: 0.1 });
        else pin.set('loose', 0.1);
        phase = 'slide';
      }
      if (phase === 'slide' && t >= tS && pin) {
        pin.set('held', BEAT.close);
        if (o.rollToCurl) {
          // the thumb rolls the remembered bend so that it curls down, into the loop
          const want = pin.rollToCurl([0, -1, 0]);
          if (want !== null) {
            const r0 = pin.roll(), t1 = t + BEAT.close;
            pin.setRoll((tt) => r0 + (want - r0) * minJerk((tt - t1) / (0.5 * BEAT.ret)));
          }
        }
        phase = 'return';
      }
      if (phase === 'return' && t >= tR && pin) {
        // the left hand takes the strand at the right hand's pads
        coil.add(pin.s - 0.03, pin.s + 0.025, BEAT.place);
        placed.push(pin.s + 0.025);
        phase = 'place';
      }
      if (phase === 'place' && t >= tP && pin) {
        pin.release(0.15);
        phase = 'open';
      }
      if (pin) sHand = pin.s;
    };
    const caps = (t: number) => [...fistHand(coilLeft(t), 0), ...pinchHand(right(t), 1, padsOpen(pin, t))];
    rod.setCapsules(caps);
    return {
      rod,
      script,
      vectors: { left: frameTrack((_, t) => coilLeft(t)), right: frameTrack((_, t) => right(t)), caps: capsuleTrack(9, (r) => r.currentCapsules()) },
      tracks: { sHand: () => sHand, slip: () => (pin ? pin.slip : 0), force: () => (pin ? pin.force : 0), sCable0: () => sCable[0], ...cableRange(built) },
    };
  },
  };
}

export const physCoil: ShotDef = coilShot();

// ---------------------------------------------------------------- phys-roll

export const ROLL = { at: [0, 1.0, 0] as V3, tRoll: 0.5, rollTime: 1.0, tTurn: 2.2, turnTime: 1.0, duration: 4.5 };

/** the hand holds the cable hanging down from the pads (d3 down); it turns -180° about the vertical later */
export function rollHand(t: number): Frame {
  const a = -Math.PI * minJerk((t - ROLL.tTurn) / ROLL.turnTime);
  const f = gripFrame(ROLL.at, [0, -1, 0], [1, 0, 0]);
  return { p: f.p, q: quatMul(quatFromAxisAngle(0, 1, 0, a), f.q) };
}
export const rollAngle = (t: number) => Math.PI * minJerk((t - ROLL.tRoll) / ROLL.rollTime);

export const physRoll: ShotDef = {
  id: 'phys-roll',
  duration: ROLL.duration,
  substeps: XLR.substeps,
  build() {
    const pts = polyline([ROLL.at[0], ROLL.at[1] + 0.05, 0], [[[0, -1, 0], ROLL.at[1] + 0.05 - RC - 0.04]]);
    corner(pts, [0, -1, 0], [1, 0, 0], 0.04);
    pts.push(...polyline(pts[pts.length - 1], [[[1, 0, 0], 0.5]]).slice(1));
    const built = buildCable(XLR, pts, { plugs: 'end' }), rod = built.rod;
    rod.time = -1;
    const pin = rod.pinch({ frame: rollHand, hand: 1, mode: 'held', blend: 0.01, roll: rollAngle });
    rod.setCapsules((t) => pinchHand(rollHand(t), 1));
    preroll(rod, 1);
    return {
      rod,
      vectors: { right: frameTrack((_, t) => rollHand(t)), caps: capsuleTrack(6, (_, t) => pinchHand(rollHand(t), 1)) },
      tracks: { sPinch: () => pin.s, twistHanging: (r) => r.twistTurns(r.segmentAt(pin.s), r.segmentAt(pin.s + 0.9)), ...cableRange(built) },
    };
  },
};

// ---------------------------------------------------------------- phys-cant-old / phys-cant-new

/**
 * 30 cm of cable sticking out of a fist, held straight until 0.3 s, then let go: with the first
 * coiling bake's settings (EI 2e-3, 1.25 cm segments, 40 substeps × 3 iterations, the old
 * damping) and with the XLR preset. The fist is at the origin, the cable along +x at 1 m.
 */
export const CANT = { length: 0.3, hold: 0.03, tLet: 0.3, duration: 3 };

function cantShot(id: string, opts: RodBuildOptions, seg: number, substeps: number, iterations: number): ShotDef {
  return {
    id, duration: CANT.duration, substeps, iterations,
    build() {
      const pts = Array.from({ length: Math.round(CANT.length / seg) + 1 }, (_, i): V3 => [i * seg, 1, 0]);
      const built = buildCable(XLR, pts, { plugs: 'none', segment: seg, groundY: null, ...opts }), rod = built.rod;
      const fist = gripFrame([0.015, 1, 0], [1, 0, 0], [0, 1, 0]);
      const hold = rod.bundle({ frame: fist, hand: 0, blend: 0.001 });
      hold.add(0, CANT.length + 0.01);
      let let_ = false;
      return {
        rod,
        script: (_: Rod, t: number) => {
          if (!let_ && t >= CANT.tLet) {
            hold.release(CANT.hold, Infinity, 0.02);
            let_ = true;
          }
        },
        vectors: { caps: capsuleTrack(3, () => fistHand(fist, 0, RC)) },
        tracks: { tip: (r) => 1 - r.x[3 * (r.n - 1) + 1], ...cableRange(built) },
      };
    },
  };
}

/** the first coiling bake's cable (src/shots/s1-coil.ts) */
export const physCantOld = cantShot('phys-cant-old', { linearDensity: 0.06, EI: 2e-3, GJ: 1.5e-3, damping: 1.2, angularDamping: 3, internalDamping: 2, bendDamping: 0, twistDamping: 0, plastic: null, radius: 0.0035 }, 0.0125, 40, 3);
/** the calibrated XLR preset */
export const physCantNew = cantShot('phys-cant-new', {}, XLR.segment, XLR.substeps, XLR.iterations);

export const PHYS_SHOTS: ShotDef[] = [physDrape, physCantOld, physCantNew, physU, physGrab, physLay, physCoil, physRoll];
