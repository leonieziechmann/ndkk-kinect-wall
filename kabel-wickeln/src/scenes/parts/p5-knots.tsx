// Stage 5.1 (KONZEPT "5 · Fehler", item 1): "Das Ende durch den Ring". The rough animation
// (animatic): every beat, caption, label, camera and counter in place; Noor's hands from simple
// keyframes on exactly the frames the simulation used (shots/p5-knots.ts records them); the recorded
// movements (MOCAP_SLOTS) replace them later.
//
//   0  cause: the ring, its velcro open, its end fallen through the middle, is dropped into a crate
//      (slow motion, then real time); Noor lifts it out: the end comes out of the middle
//   1  "Kommt das Ende aus der Mitte? Dann falsche Seite." (split screen: her view | outside)
//   2  she pulls the end out: in every second loop a knot closes (orange rings, counted 1 … 2 … 3;
//      the tally ü u ü u ü u gets a knot under every u)
//   3  "Knoten? Stopp. Ende zurück durch die Mitte, nicht reißen.": the same pull again until the
//      first loop starts to close round the cable; she stops, takes the end back through that loop
//      and the middle; then both ends are outside and the cable comes out without a knot
//   4  ✓ beside it: the same ring with both ends outside, the same pull: no knot ("Richtig: Beide
//      Enden außen – auseinanderziehen oder werfen.")
//
// Cable: simulated (XLR preset, contact radius 1.2 ×), guided only where the report says so (the end
// sliding into the crate ring's middle; the end's way back through the middle). Everything on screen
// is a function of one scene clock (tau): SEGS map it to a shot and its time.

import { Circle, Layout, Node, Rect, Txt } from '@motion-canvas/2d';
import { easeInOutCubic } from '@motion-canvas/core';
import * as THREE from 'three';
import { BakedRod, Frame, Quat, V3, loadBake, quatMul, quatRotate, smooth } from '../../sim';
import { CRATE, CRATE_T, KNOT_HOLD, KNOT_T } from '../../shots/p5-knots';
import { NOOR } from '../../people/cast';
import { Grip, HandRig, Rig, RigTrack, eyesOfRig, gripFrame, stand } from '../../people/rig';
import { CAPTION_Y, GAP, PANEL_H, PanelTitle, TOP, clock, readTime, splitPerson, viewLayers } from '../../lib/kit';
import { C, FONT, OVER, UNDER } from '../../lib/theme';
import { Mark, StageChip } from '../../lib/ui';
import { CableMesh } from '../../three/cable';
import { Orbit, makeCamera, mixOrbit, orbit, povFollow } from '../../three/camera';
import { callout, project } from '../../three/overlay';
import { cableCrate } from '../../three/props';
import { StrapMesh } from '../../three/strap';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';

// ===================================================================================== the bakes' beats

/**
 * Shot times read off the bakes (scratchpad p5k/ana.mjs, tight.mjs); the part checks them against
 * the bakes when it runs and prints any difference ("[render] p5-knots checks").
 *   pull: the knots close (k1 in loop 6, k2 in loop 4; the third, in loop 2, stays loose in the
 *         simulation and is not shown, see the report), where the part stops showing the pull (done)
 *   fix:  she takes the end (stop), the end is outside again (fixed), the end of the pull that
 *         follows (both ends outside: no knot)
 */
export const PULL_K = { k1: 6.0, k2: 12.15, done: 14.6 };
export const FIX_K = { stop: 0.62, fixed: 5.98, end: 13.2 };
export const OK_K = { end: 20 };

// ===================================================================================== the plan

type Shot = 'crate' | 'pull' | 'fix' | 'ok';
type ViewMode = 'crate' | 'split' | 'cmp';
const SLOW = 0.25, FAST = 2;

interface Seg {
  id: string;
  len: number;
  shot: Shot;
  from: number;
  to: number;
  at: number;
  take: number;
  view: ViewMode;
}

const SEGS: Seg[] = [];
let sceneAt = 0, take = 0, mode: ViewMode = 'crate';
const cut = (v: ViewMode = mode) => {
  take++;
  mode = v;
};
const hold = (id: string, shot: Shot, at: number, len: number) => {
  SEGS.push({ id, len, shot, from: at, to: at, at: sceneAt, take, view: mode });
  sceneAt += len;
};
const play = (id: string, shot: Shot, from: number, to: number, speed = 1) => {
  const len = (to - from) / speed;
  SEGS.push({ id, len, shot, from, to, at: sceneAt, take, view: mode });
  sceneAt += len;
};

const CT = CRATE_T;
const K = PULL_K, F = FIX_K;
// 0 · the cause: she drops the ring, its velcro open, into the crate (slow motion, then real time);
//     its end has fallen through the middle
hold('in', 'crate', 0, 0.8);
play('drop', 'crate', 0, CT.drop - 0.05);
play('fall', 'crate', CT.drop - 0.05, CT.land + 0.25, SLOW);
cut();
play('fallRT', 'crate', CT.drop - 0.2, CT.end);
hold('land', 'crate', CT.end, 1.6);
// 1 · in her hand (lifted out): the end comes out of the middle
cut('split');
hold('diag', 'pull', 0, 3.4);
// 2 · she pulls: in every second loop a knot closes (1, 2); between them twice as fast
play('pull1', 'pull', 0, K.k1 + 1.4);
play('fast1', 'pull', K.k1 + 1.4, K.k2 - 1.2, FAST);
play('pull2', 'pull', K.k2 - 1.2, K.done + 0.4);
hold('knots', 'pull', K.done + 0.4, 1.8);
// 3 · back to the first knot: stop (a still); then the end back through the middle, the cable comes out without a knot
cut();
hold('stopCap', 'pull', K.k1 + 0.3, 3.0);
cut();
play('back', 'fix', F.stop - 0.2, F.fixed + 0.3);
hold('backOk', 'fix', F.fixed + 0.3, 1.0);
play('fixPull', 'fix', F.fixed + 0.3, F.end, FAST);
hold('fixOk', 'fix', F.end, 1.4);
// 4 · beside it: ✓ both ends outside, the same ring, the same hand, no knot (fast)
cut('cmp');
hold('cmpIn', 'ok', 0, 0.8);
play('cmp', 'ok', 0, K.done + 0.4, 2.5);
hold('cmpHold', 'ok', K.done + 0.4, 3.0);
hold('out', 'ok', K.done + 0.4, 0.6);

/** the part's length [s] */
export const LENGTH = sceneAt;

function seg(id: string): Seg {
  const s = SEGS.find((x) => x.id === id);
  if (!s) throw new Error(`p5-knots: no segment ${id}`);
  return s;
}
const S = (id: string) => seg(id).at;
// (every id the picture uses, checked when the module loads: a typo fails loudly here, not silently in a signal)
['in', 'drop', 'fall', 'fallRT', 'land', 'diag', 'pull1', 'fast1', 'pull2', 'knots', 'stopCap', 'back', 'backOk', 'fixPull', 'fixOk', 'cmpIn', 'cmp', 'cmpHold', 'out'].forEach(seg);
const E = (id: string) => seg(id).at + seg(id).len;

function segAt(tau: number): Seg {
  let s = SEGS[0];
  for (const x of SEGS) {
    if (tau < x.at) break;
    s = x;
  }
  return s;
}
/** the scene time at which a shot reaches shot time tt (the first segment of that shot that plays through it) */
function sceneOf(shot: Shot, tt: number): number {
  for (const x of SEGS) if (x.shot === shot && x.to > x.from && tt >= x.from - 1e-9 && tt <= x.to + 1e-9) return x.at + ((tt - x.from) / (x.to - x.from)) * x.len;
  return NaN;
}
function shotAt(tau: number): number {
  const s = segAt(tau);
  const u = s.len > 0 ? Math.min(1, Math.max(0, (tau - s.at) / s.len)) : 1;
  return s.from + (s.to - s.from) * u;
}
const takeStart = (k: number) => (SEGS.find((x) => x.take === k) ?? SEGS[0]).at;

// ------------------------------------------------------------------------------------ captions

const CAPS: { text: string; a: number; b: number }[] = [
  { text: 'Kommt das Ende aus der Mitte? Dann falsche Seite.', a: S('diag') + 0.2, b: S('pull1') + 2.4 },
  { text: 'Knoten? Stopp. Ende zurück durch die Mitte, nicht reißen.', a: S('stopCap') + 0.2, b: S('back') + 3.8 },
  { text: 'Richtig: Beide Enden außen – auseinanderziehen oder werfen.', a: S('cmpIn') + 0.1, b: S('cmp') + 6.2 },
];
const CAP_IN = 0.35, CAP_OUT = 0.3;

/** captions shorter than their reading time (characters / 12 + 1 s), overlapping, or with too many words */
const captionProblems = (() => {
  const out: string[] = [];
  CAPS.forEach((c, i) => {
    const visible = c.b - c.a - CAP_IN;
    if (visible < readTime(c.text) - 0.01) out.push(`"${c.text}" visible ${visible.toFixed(2)} s < ${readTime(c.text).toFixed(2)} s`);
    if (i > 0 && c.a < CAPS[i - 1].b) out.push(`"${c.text}" overlaps the caption before`);
    if (c.text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length > 10) out.push(`"${c.text}" has more than 10 words`);
  });
  return out;
})();

// ------------------------------------------------------------------------------------ mocap

/**
 * Beats whose movement comes from a Kinect recording later (mocap/shots.json ids; times in part
 * seconds). Until then Noor moves by the keyframes below.
 */
export const MOCAP_SLOTS = [
  { shot: 'p5.knots.cause', role: 'Noor', from: S('in'), to: E('land'), note: 'Ring mit offenem Band flach über die Kiste halten und fallen lassen (Zeitlupe und Echtzeit aus derselben Aufnahme); das Herausheben aus der Kiste (Ende der Aufnahme) wird in der Rohfassung übersprungen: Schnitt auf den Ring in der Hand' },
  { shot: 'p5.knots.pull', role: 'Noor', from: S('diag'), to: E('knots'), note: 'Ring links, Ende kommt aus der Mitte; rechte Hand zieht Hand über Hand nach rechts, die linke lässt die Schlaufen nacheinander los; Knoten in Schlaufe 6 und 4 (der dritte, in Schlaufe 2, bleibt in der Simulation locker); Zeitraffer zwischen den Knoten aus derselben Aufnahme' },
  { shot: 'p5.knots.pull', role: 'Noor', from: S('stopCap'), to: E('stopCap'), note: 'Standbild beim ersten Knoten (derselbe Take, „Stopp“)' },
  { shot: 'p5.knots.fix', role: 'Noor', from: S('back'), to: E('fixOk'), note: 'Ende nehmen, zurück durch die Mitte (die Hand führt dann das Ende in der Simulation), beide Enden außen, auseinanderziehen (Zeitraffer). In der Rohfassung ohne vorher zugezogenen Knoten, siehe Bericht' },
  { shot: 'p5.knots.pull', role: 'Noor', from: S('cmpIn'), to: E('out'), note: '✗-Feld des Vergleichs: derselbe Take wie oben, 2,5 × schneller' },
  { shot: 'p5.knots.fix', role: 'Noor', from: S('cmpIn'), to: E('out'), note: '✓-Feld des Vergleichs (beide Enden außen, derselbe Zug): die zweite Hälfte von p5.knots.fix; kein eigener Shot mit vollem Ring von Anfang an' },
];

// ===================================================================================== helpers

const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const mixV = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ramp = (x: number, a: number, b: number) => smooth((x - a) / (b - a));
const norm3 = (v: V3): V3 => mul3(v, 1 / (Math.hypot(v[0], v[1], v[2]) || 1));

function slerp(a: Quat, b: Quat, u: number): Quat {
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
}
const mixGrip = (a: Grip, b: Grip, u: number): Grip => ({ p: mixV(a.p, b.p, u), q: slerp(a.q, b.q, u) });

// layout: her view left (55 %), outside right; two equal panels for the comparison; one wide panel
const wL = Math.round((1920 - 3 * GAP) * 0.55);
const wR = 1920 - 3 * GAP - wL;
const xL = -960 + GAP, xR = 960 - GAP - wR;
const midY = TOP + PANEL_H / 2;
const wC = (1920 - 3 * GAP) / 2;
const xC = [-960 + GAP, -960 + 2 * GAP + wC];
const fullW = 1920 - 2 * GAP;

/** a small dark chip like the "Zeitlupe" badge, with any text */
function badge(layer: Node, text: string, visible: () => number, x: number, y = TOP + 24) {
  layer.add(
    <Rect x={x} y={y} offset={[0, -1]} padding={[8, 20]} radius={30} fill={C.text} opacity={visible} layout>
      <Txt text={text} fontFamily={FONT} fontWeight={700} fontSize={28} fill={'#fff'} />
    </Rect>,
  );
}

const RC = 0.0032;
/** a track of a bake, or `fallback` if the bake has no such track (an older bake) */
const tr = (b: BakedRod, name: string, t: number, fallback = NaN) => (b.trackNames.includes(name) ? b.track(name, t) : fallback);

// ===================================================================================== Noor

/** a little breathing and weight shift (scene time s): never quite still */
function idle(s: number) {
  return {
    lean: 0.06 + 0.012 * Math.sin(1.3 * s) + 0.008 * Math.sin(0.37 * s + 1),
    bend: 0.01 * Math.sin(0.41 * s + 0.4),
    twist: 0.02 * Math.sin(0.29 * s + 2),
    drop: 0.01 + 0.006 * Math.sin(1.3 * s + 0.6),
  };
}

/** the coil in her left fist: the bunch at the ring's top */
const COIL_R = 0.02;

/**
 * Noor holding the ring (knot-pull, -fix, -ok): her hands on the bake's frames (lh: the left fist
 * that holds the ring's top, rh: the right hand's pads); she looks between the ring and the right hand.
 */
function holdRig(b: BakedRod, t: number, s: number): Rig {
  const base = { ...stand(NOOR, [0, 0], 0, { width: 0.26, stagger: 0.06 }), ...idle(s), reach: 0.6 };
  const lh = b.frame('lh', t), rh = b.frame('rh', t);
  const held = b.track('held', t);
  const left: HandRig = { grip: lh as Grip, hold: 'coil', radius: COIL_R, thumbAlong: 1, free: 0.3, open: 0.15 * clamp01((6 - held) / 6) };
  const right: HandRig = { grip: rh as Grip, hold: 'pinch', radius: RC, open: clamp01(b.track('rhOpen', t)), free: 0.8 };
  const look = mixV(add3(KNOT_HOLD, [0.02, -0.2, 0.02]), rh.p, 0.45);
  return { ...base, look, hands: [left, right] };
}

/** the left hand's grip relative to the crate shot's hand frame: palm up under the ring's top (at its left), thumb along it, forward */
const GRIP_FLAT = gripFrame([0, 0, 0], [0, 0, -1], norm3([-0.6, -0.8, 0]));
const REST_R: Grip = gripFrame([0.24, 0.8, -0.06], norm3([0.1, -1, -0.15]), norm3([-0.4, 0, -1]));
const REST_L: Grip = gripFrame([-0.24, 0.8, -0.04], norm3([-0.1, -1, -0.15]), norm3([0.4, 0, -1]));


/**
 * Noor at the crate: she holds the ring flat over it (bending a little), lets it go, her hand opens
 * and goes back to her side; she watches it land.
 */
function crateRig(b: BakedRod, t: number, s: number): Rig {
  const st = stand(NOOR, [0, 0.04], 0, { width: 0.28, stagger: 0.04 });
  const id = idle(s);
  const f0 = b.frame('lh', 0);
  const atDrop: Grip = { p: f0.p, q: quatMul(f0.q, GRIP_FLAT.q) };
  // after letting go: up and back toward her, then down to her side (an open hand)
  const away: Grip = { p: add3(atDrop.p, [0.0, 0.14, 0.14]), q: atDrop.q };
  let left: HandRig;
  if (t < CT.drop) left = { grip: atDrop, hold: 'coil', radius: COIL_R, thumbAlong: 1, free: 0.4, open: 0 };
  else if (t < CT.drop + 0.6) left = { grip: mixGrip(atDrop, away, ramp(t, CT.drop, CT.drop + 0.6)), hold: 'coil', radius: COIL_R, thumbAlong: 1, free: 0.4, open: Math.min(1, (t - CT.drop) / 0.12) };
  else left = { grip: mixGrip(away, REST_L, ramp(t, CT.drop + 0.6, CT.drop + 1.5)), hold: 'coil', radius: COIL_R, thumbAlong: 1, free: 0.6, open: 1 };
  const right: HandRig = { grip: REST_R, hold: 'pinch', radius: RC, open: 1, free: 0.8 };
  const look: V3 = [CRATE.x, 0.1, CRATE.z + 0.04];
  // (bent forward over the crate while she holds the ring low, upright again after)
  const bendOver = 0.32 * (1 - ramp(t, CT.drop + 0.3, CT.drop + 1.4));
  return { ...st, lean: 0.06 + bendOver + id.lean * 0.4, bend: id.bend, twist: id.twist, drop: id.drop + 0.05 * (1 - ramp(t, CT.drop + 0.3, CT.drop + 1.4)), reach: 1, look, hands: [left, right] };
}

// ===================================================================================== cameras

/** the crate: from in front of her, to her right, from above (her face, her hands, into the crate) */
const CRATE_WIDE: Orbit = { target: [0.02, 0.7, -0.3], yaw: 2.45, pitch: 0.3, dist: 3.0, fov: 38 };
/** the crate from above, close: the end and the ring's middle */
const CRATE_CLOSE: Orbit = { target: [CRATE.x - 0.08, 0.2, CRATE.z], yaw: 2.7, pitch: 0.92, dist: 1.25, fov: 36 };
/**
 * to her right, a little in front of her, from above: KONZEPT's outside camera stands a little behind
 * her, but the ring hangs at her left hip and her body would hide it and the knots; from here the
 * ring, the knots and the pulled cable are all in front of her
 */
const EXT: Orbit = { target: [0.04, 0.74, -0.28], yaw: 1.62, pitch: 0.5, dist: 1.3, fov: 40 };
/** the comparison: the same camera for both panels, wide enough for the cable that is out */
const CMP: Orbit = { target: [0.1, 0.6, -0.26], yaw: 1.62, pitch: 0.45, dist: 1.7, fov: 40 };

// ===================================================================================== the part

export function* part(layer: Node) {
  const B: Record<Shot, BakedRod> = {
    crate: (yield loadBake('p5-knots-crate')) as BakedRod,
    pull: (yield loadBake('p5-knots-pull')) as BakedRod,
    fix: (yield loadBake('p5-knots-fix')) as BakedRod,
    ok: (yield loadBake('p5-knots-ok')) as BakedRod,
  };
  for (const p of captionProblems) console.log('[render] p5-knots caption:', p);

  const { tau, run } = clock(LENGTH);
  const win = (a: number, b: number, fi = 0.35, fo = 0.35) => {
    const s = tau();
    return smooth((s - a) / Math.max(1e-6, fi)) * (1 - smooth((s - (b - fo)) / Math.max(1e-6, fo)));
  };
  const cur = () => segAt(tau());
  const t = () => shotAt(tau());

  // ------------------------------------------------------------------------- what the bakes say
  const knotTimes = (b: BakedRod) => {
    const out: number[] = [];
    let k = 0;
    for (let f = 0; f < b.frames; f++) {
      const tt = f / b.fps, n = tr(b, 'knotsEver', tt, 0);
      while (n > k) {
        out.push(tt);
        k++;
      }
    }
    return out;
  };
  const kPull = knotTimes(B.pull), kFix = knotTimes(B.fix), kOk = knotTimes(B.ok);
  const fixEnd = { knots: tr(B.fix, 'knotsEver', FIX_K.end), stop: tr(B.fix, 'stopAt', FIX_K.end), fixed: tr(B.fix, 'fixedAt', FIX_K.end) };
  /** the loop (1 … 6) each knot of the pull is made of */
  const knotLoops = [1, 2, 3].map((k) => Math.round(tr(B.pull, `knot${k}L`, PULL_K.done)) + 1).filter((l) => Number.isFinite(l));
  const truth = {
    twoKnots: kPull.filter((x) => x <= PULL_K.done).length >= 2,
    everySecond: knotLoops.length >= 2 && knotLoops.every((l) => l % 2 === 0),
    fixNoKnot: fixEnd.knots === 0 && Number.isFinite(fixEnd.fixed),
    okNone: kOk.length === 0,
  };
  console.log('[render] p5-knots checks', JSON.stringify({ length: +LENGTH.toFixed(2), segs: SEGS.map((x) => `${x.id} ${x.at.toFixed(2)}`).join(' | '), kPull, kFix, kOk, want: { PULL_K, FIX_K }, fixEnd, knotLoops, truth, captionProblems }));

  // ------------------------------------------------------------------------- Noor: one RigTrack per take
  const rigAt = (sc: number): Rig => {
    const sg = segAt(Math.min(LENGTH, Math.max(0, sc)));
    const tt = shotAt(Math.min(LENGTH, Math.max(0, sc)));
    // (the comparison's ✗ panel: the main world shows the pull)
    return sg.shot === 'crate' ? crateRig(B.crate, tt, sc) : holdRig(B[sg.shot === 'ok' ? 'pull' : sg.shot], tt, sc);
  };
  const tracks = new Map<number, RigTrack>();
  const trackOf = (k: number) => {
    let tr = tracks.get(k);
    if (!tr) {
      const s0 = takeStart(k);
      tr = new RigTrack(NOOR, (x) => rigAt(s0 + x), 0, 30);
      tracks.set(k, tr);
    }
    return tr;
  };
  const poseNow = () => {
    const sg = cur();
    return trackOf(sg.take).pose(tau() - takeStart(sg.take));
  };

  // ------------------------------------------------------------------------- the main world (crate, pull, fix)
  const maxN = Math.max(...Object.values(B).map((b) => b.n));
  const pos = new Float32Array(3 * maxN), d1 = new Float32Array(3 * maxN);
  const iStart = (b: BakedRod) => Math.round(b.track('cable0', 0));
  const iEnd = (b: BakedRod) => Math.round(b.track('cable1', 0));
  const cable = new CableMesh({ maxNodes: maxN, radius: RC, plugStart: 'xlr-male', plugEnd: 'xlr-female', stripeWidth: 0.05, sub: 2 });
  const noor = splitPerson(NOOR, new RigTrack(NOOR, (x) => holdRig(B.pull, 0, x), 0, 30).pose(0));
  const crate = cableCrate({ width: CRATE.width, depth: CRATE.depth, height: CRATE.height });
  crate.position.set(CRATE.x, 0, CRATE.z);
  // the velcro tie lives on the start end, 9 cm from the plug's tip; open, its tail hangs down
  const tie = new StrapMesh({ length: 0.2, width: 0.016, thickness: 0.0016, color: '#2b2d31', inner: '#3a3c41', maxPoints: 40 });
  const tieAt = (b: BakedRod, tt: number) => {
    const i = Math.round(b.track('tieNode', 0));
    const a = b.nodeAt(tt, i - 1, [0, 0, 0]), c = b.nodeAt(tt, i + 1, [0, 0, 0]);
    const axis = norm3(sub3(c, a));
    tie.pose({ center: mixV(a, c, 0.5), axis, start: [0, 1, 0], radius: RC, wrap: 1, fold: 0, droop: 1 });
  };
  const extCam = makeCamera(38);
  viewLayers(extCam, 'ext');
  const povCam = makeCamera(58);
  viewLayers(povCam, 'pov');

  const camOut: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
  /** the outside camera: keys in scene time, each blending from the one before over `dur` (0: a cut) */
  const camKeys: { at: number; dur: number; cam: Orbit }[] = [
    { at: 0, dur: 0, cam: CRATE_WIDE },
    { at: S('fall'), dur: 0, cam: CRATE_CLOSE },
    { at: S('diag'), dur: 0, cam: EXT },
  ];
  const extOrbit = (): Orbit => {
    const s = tau();
    let i = 0;
    for (let k = 0; k < camKeys.length; k++) if (s >= camKeys[k].at) i = k;
    const k = camKeys[i];
    const u = k.dur > 0 ? easeInOutCubic(clamp01((s - k.at) / k.dur)) : 1;
    if (u >= 1 || i === 0) return k.cam;
    return mixOrbit(camKeys[i - 1].cam, k.cam, u, camOut);
  };
  /** her view looks between the ring and her right hand */
  const look = (s: number): V3 => {
    const sc = Math.min(LENGTH, Math.max(0, s));
    const sg = segAt(sc);
    if (sg.shot === 'crate') return [CRATE.x, 0.1, CRATE.z];
    const rh = B[sg.shot === 'ok' ? 'pull' : sg.shot].frame('rh', shotAt(sc)).p;
    return mixV(add3(KNOT_HOLD, [0.03, -0.3, 0.02]), rh, 0.35);
  };

  const world = new World3D('p5-knots', () => {
    const sg = cur();
    const tt = t();
    const b = sg.shot === 'ok' ? B.pull : B[sg.shot];
    const i0 = iStart(b), i1 = iEnd(b);
    b.frameSample(tt, pos, d1);
    cable.update(pos.subarray(3 * i0), d1.subarray(3 * i0), i1 - i0 + 1);
    tieAt(b, tt);
    crate.visible = sg.shot === 'crate';
    noor.update(poseNow());
    orbit(extCam, sg.view === 'cmp' ? CMP : extOrbit());
    povFollow(povCam, (x) => eyesOfRig(NOOR, rigAt(x)), look, tau(), { back: 0.05, up: 0.03, fov: 60, smooth: 0.3 });
  });
  new Studio(world.scene, { focus: [0.05, 0.5, -0.35], focusRadius: 1.3 });
  world.scene.add(cable.group, tie.group, noor.person.group, crate);

  // ------------------------------------------------------------------------- the comparison world (✓ knot-ok)
  const okPos = new Float32Array(3 * B.ok.n), okD1 = new Float32Array(3 * B.ok.n);
  const okCable = new CableMesh({ maxNodes: B.ok.n, radius: RC, plugStart: 'xlr-male', plugEnd: 'xlr-female', stripeWidth: 0.05, sub: 2 });
  const okNoor = splitPerson(NOOR, new RigTrack(NOOR, (x) => holdRig(B.ok, 0, x), 0, 30).pose(0));
  const okTrack = new RigTrack(NOOR, (x) => holdRig(B.ok, Math.min(OK_K.end, x), x + 60), 0, 30);
  const okTie = new StrapMesh({ length: 0.2, width: 0.016, thickness: 0.0016, color: '#2b2d31', inner: '#3a3c41', maxPoints: 40 });
  const cmpCamA = makeCamera(38), cmpCamB = makeCamera(38);
  viewLayers(cmpCamA, 'ext');
  viewLayers(cmpCamB, 'ext');
  const okWorld = new World3D('p5-knots-ok', () => {
    const tt = cur().view === 'cmp' ? t() : 0;
    B.ok.frameSample(tt, okPos, okD1);
    const i0 = iStart(B.ok), i1 = iEnd(B.ok);
    okCable.update(okPos.subarray(3 * i0), okD1.subarray(3 * i0), i1 - i0 + 1);
    const i = Math.round(B.ok.track('tieNode', 0));
    const a = B.ok.nodeAt(tt, i - 1, [0, 0, 0]), c = B.ok.nodeAt(tt, i + 1, [0, 0, 0]);
    okTie.pose({ center: mixV(a, c, 0.5), axis: norm3(sub3(c, a)), start: [0, 1, 0], radius: RC, wrap: 1, fold: 0, droop: 1 });
    okNoor.update(okTrack.pose(tt));
    orbit(cmpCamB, CMP);
  });
  new Studio(okWorld.scene, { focus: [0.05, 0.5, -0.35], focusRadius: 1.3 });
  okWorld.scene.add(okCable.group, okTie.group, okNoor.person.group);
  // the ✗ panel of the comparison shows the main world with the pull, from the same camera
  const cmpPullWorld = world;

  // ------------------------------------------------------------------------- the picture
  const root = new Node({ opacity: () => smooth(tau() / 0.5) * (1 - smooth((tau() - S('out')) / 0.6)) });
  layer.add(root);
  const viewOn = (v: ViewMode, fi = 0.01) => () => {
    const sg = cur();
    return sg.view === v ? 1 : 0 * fi;
  };
  const crateOp = viewOn('crate'), splitOp = viewOn('split'), cmpOp = viewOn('cmp');
  const crateView = (<ThreeView world={world} camera={extCam} x={-960 + GAP + fullW / 2} y={midY} width={fullW} height={PANEL_H} radius={28} opacity={crateOp} />) as ThreeView;
  const povView = (<ThreeView world={world} camera={povCam} x={xL + wL / 2} y={midY} width={wL} height={PANEL_H} radius={28} opacity={splitOp} />) as ThreeView;
  const extView = (<ThreeView world={world} camera={extCam} x={xR + wR / 2} y={midY} width={wR} height={PANEL_H} radius={28} opacity={splitOp} />) as ThreeView;
  root.add([crateView, povView, extView]);
  const titles = new Node({ opacity: splitOp });
  titles.add([<PanelTitle text={'So siehst du es'} x={xL + 24} />, <PanelTitle text={'Von außen'} x={xR + 24} />]);
  root.add(titles);
  // the comparison panels: ✗ the end through the middle | ✓ both ends outside
  const cmpNode = new Node({ opacity: cmpOp });
  const cmpViews = [
    (<ThreeView world={cmpPullWorld} camera={cmpCamA} x={xC[0] + wC / 2} y={midY} width={wC} height={PANEL_H} radius={28} />) as ThreeView,
    (<ThreeView world={okWorld} camera={cmpCamB} x={xC[1] + wC / 2} y={midY} width={wC} height={PANEL_H} radius={28} />) as ThreeView,
  ];
  orbit(cmpCamA, CMP);
  cmpNode.add(cmpViews);
  [0, 1].forEach((i) => {
    const good = i === 1;
    cmpNode.add(
      <Rect x={xC[i] + 24} y={TOP + 24} offset={[-1, -1]} padding={[8, 22, 8, 12]} radius={40} fill={C.plate} layout alignItems={'center'} gap={12}>
        <Mark good={good} size={40} />
        <Txt text={good ? 'Beide Enden außen' : 'Ende durch die Mitte'} fontFamily={FONT} fontWeight={700} fontSize={32} fill={C.text} />
      </Rect>,
    );
  });
  root.add(cmpNode);

  root.add(<StageChip current={5} x={0} y={TOP + PANEL_H + 34} />);

  // badges: slow motion, real time, fast
  const bxCrate = 0;
  badge(root, 'Zeitlupe', () => win(S('fall'), E('fall'), 0.2, 0.2), bxCrate);
  badge(root, 'Echtzeit', () => win(S('fallRT'), E('fallRT'), 0.2, 0.2), bxCrate);
  // (over her view in the split screen, over the middle in the comparison)
  const fastOn = () => Math.max(win(S('fast1'), E('fast1'), 0.2, 0.2), win(S('fixPull'), E('fixPull'), 0.2, 0.2));
  badge(root, 'Zeitraffer 2×', fastOn, xL + wL / 2);
  badge(root, 'Zeitraffer 2,5×', () => win(S('cmp'), E('cmp'), 0.2, 0.2), 0, TOP + 96);
  // the fix: what this is
  root.add(
    <Rect x={xL + wL - 24} y={TOP + 24} offset={[1, -1]} padding={[8, 20]} radius={30} fill={C.plate} opacity={() => win(S('stopCap'), E('stopCap'), 0.3, 0.3)} layout>
      <Txt text={'Beim ersten Knoten'} fontFamily={FONT} fontWeight={700} fontSize={32} fill={C.text} />
    </Rect>,
  );
  root.add(
    <Rect x={xL + wL / 2} y={TOP + 24} offset={[0, -1]} padding={[8, 24]} radius={30} fill={C.text} opacity={() => win(S('stopCap') + 0.4, E('stopCap'), 0.2, 0.3)} layout>
      <Txt text={'Stopp'} fontFamily={FONT} fontWeight={800} fontSize={36} fill={'#fff'} />
    </Rect>,
  );

  // ------------------------------------------------------------------------- knots: orange rings, counted
  const knotPos = (b: BakedRod, k: number, tt: number): V3 | null => {
    const x = b.track(`knot${k}X`, tt);
    if (!Number.isFinite(x)) return null;
    return [x, b.track(`knot${k}Y`, tt), b.track(`knot${k}Z`, tt)];
  };
  const ringOn = (view: ThreeView, b: () => BakedRod, k: number, on: () => number) => {
    const at = () => {
      const p = knotPos(b(), k, t());
      if (!p) return { x: 0, y: 0, vis: 0 };
      const q = project(view, p);
      return { x: q.x, y: q.y, vis: q.vis };
    };
    root.add(
      <Node opacity={() => on() * at().vis}>
        <Circle x={() => at().x} y={() => at().y} size={66} stroke={UNDER} lineWidth={7} />
        <Circle x={() => at().x + 40} y={() => at().y - 40} size={40} fill={UNDER} />
        <Txt x={() => at().x + 40} y={() => at().y - 40} text={`${k}`} fontFamily={FONT} fontWeight={800} fontSize={28} fill={'#fff'} />
      </Node>,
    );
  };
  const pullShown = () => (cur().shot === 'pull' || cur().shot === 'fix' ? 1 : 0);
  for (const k of [1, 2]) {
    ringOn(extView, () => (cur().shot === 'fix' ? B.fix : B.pull), k, () => splitOp() * pullShown());
    ringOn(povView, () => (cur().shot === 'fix' ? B.fix : B.pull), k, () => splitOp() * pullShown());
    ringOn(cmpViews[0], () => B.pull, k, cmpOp);
  }
  const countOf = (b: BakedRod) => Math.round(b.track('knots', t()));
  // the counter
  root.add(
    <Rect x={xR + wR / 2} y={TOP + PANEL_H - 40} offset={[0, 1]} padding={[10, 26]} radius={36} fill={C.plate} layout opacity={() => win(S('pull1'), E('fixOk'), 0.4, 0.4)}>
      <Txt text={() => `Knoten: ${countOf(cur().shot === 'fix' ? B.fix : B.pull)}`} fontFamily={FONT} fontWeight={700} fontSize={36} fill={C.text} />
    </Rect>,
  );
  [0, 1].forEach((i) =>
    root.add(
      <Rect x={xC[i] + wC / 2} y={TOP + PANEL_H - 40} offset={[0, 1]} padding={[10, 26]} radius={36} fill={C.plate} layout opacity={cmpOp}>
        <Txt text={() => `Knoten: ${countOf(i === 0 ? B.pull : B.ok)}`} fontFamily={FONT} fontWeight={700} fontSize={36} fill={C.text} />
      </Rect>,
    ),
  );
  // the tally of the ring's loops: a knot under every u (every second loop), as they close
  const loopsTally = (
    <Rect x={xR + wR - 24} y={TOP + 24} offset={[1, -1]} padding={[8, 22, 10, 22]} radius={30} fill={C.plate} layout direction={'column'} alignItems={'center'} gap={2} opacity={() => win(S('diag') + 0.6, E('knots'), 0.4, 0.4)}>
      <Layout layout gap={14}>
        {['ü', 'u', 'ü', 'u', 'ü', 'u'].map((c) => (
          <Txt text={c} fontFamily={FONT} fontWeight={800} fontSize={40} fill={c === 'u' ? UNDER : OVER} width={26} textAlign={'center'} />
        ))}
      </Layout>
      <Layout layout gap={14}>
        {[0, 1, 2, 3, 4, 5].map((i) => {
          // a ring under the loop a knot has closed in (the bake says which)
          const on = () => {
            if (cur().shot !== 'pull') return 0;
            const n = Math.round(B.pull.track('knotsEver', t()));
            for (let k = 1; k <= n; k++) if (Math.round(tr(B.pull, `knot${k}L`, t())) === i) return 1;
            return 0;
          };
          return <Circle size={22} width={26} stroke={UNDER} lineWidth={4} opacity={on} />;
        })}
      </Layout>
    </Rect>
  );
  root.add(loopsTally);
  // what the tally shows, once the knots are there (only if the bake says so)
  if (truth.everySecond && truth.twoKnots)
    root.add(
      <Rect x={xR + wR - 24} y={TOP + 150} offset={[1, -1]} padding={[8, 20]} radius={30} fill={UNDER} layout opacity={() => win(S('knots') - 0.4, E('knots'), 0.3, 0.3)}>
        <Txt text={'Knoten in jeder 2. Schlaufe'} fontFamily={FONT} fontWeight={700} fontSize={32} fill={'#fff'} />
      </Rect>,
    );

  // ------------------------------------------------------------------------- labels where it happens
  const label = (o: { view: ThreeView; target: () => V3; at: [number, number]; text: string; color?: string; on: () => number }) =>
    root.add(callout({ view: o.view, target: o.target, at: o.at, text: o.text, color: o.color, size: 34, arrow: true, opacity: o.on }));
  const plugTip = (b: BakedRod) => () => b.nodeAt(t(), b.n - 1, [0, 0, 0]);
  label({ view: crateView, target: plugTip(B.crate), at: [-960 + GAP + fullW / 2 + 430, TOP + 170], text: 'Ende durch die Mitte gefallen', on: () => win(S('fall') + 0.8, E('land'), 0.4, 0.3) });
  label({ view: crateView, target: () => B.crate.nodeAt(t(), Math.round(B.crate.track('tieNode', 0)), [0, 0, 0]), at: [-960 + GAP + fullW / 2 - 430, TOP + 170], text: 'Klettband offen', on: () => win(S('in') + 0.1, E('drop') + 0.6, 0.3, 0.3) });
  label({ view: extView, target: plugTip(B.pull), at: [xR + wR / 2, TOP + 660], text: 'Ende kommt aus der Mitte', on: () => win(S('diag') + 0.2, S('pull1') + 1.0, 0.4, 0.3) });
  label({ view: povView, target: plugTip(B.pull), at: [xL + wL / 2 + 180, TOP + 700], text: 'Ende kommt aus der Mitte', on: () => win(S('diag') + 0.4, S('pull1') + 1.0, 0.4, 0.3) });
  const k1s = kPull.length ? sceneOf('pull', kPull[0]) : NaN;
  label({ view: extView, target: () => knotPos(B.pull, 1, t()) ?? KNOT_HOLD, at: [xR + 190, TOP + 170], text: 'Knoten', color: UNDER, on: () => (cur().shot === 'pull' && Number.isFinite(k1s) ? win(k1s + 0.1, k1s + 2.6, 0.3, 0.3) : 0) });
  label({ view: extView, target: plugTip(B.fix), at: [xR + 170, TOP + 420], text: 'Ende', on: () => win(S('back') + 0.3, E('back') - 1.2, 0.3, 0.3) });
  if (Number.isFinite(fixEnd.fixed)) label({ view: extView, target: plugTip(B.fix), at: [xR + wR / 2, TOP + 170], text: 'Ende wieder außen', on: () => win(E('back') - 0.6, E('backOk'), 0.4, 0.3) });
  if (truth.fixNoKnot) label({ view: extView, target: () => B.fix.frame('rh', t()).p, at: [xR + wR / 2, TOP + 640], text: '✓ kein Knoten', on: () => win(E('fixPull') - 0.8, E('fixOk'), 0.3, 0.3) });
  if (truth.okNone) label({ view: cmpViews[1], target: plugTip(B.ok), at: [xC[1] + wC / 2, TOP + 160], text: '✓ kein Knoten', on: () => win(S('cmpHold'), E('cmpHold'), 0.4, 0.3) });

  // ------------------------------------------------------------------------- captions
  const capNow = () => {
    const s = tau();
    for (const c of CAPS) if (s >= c.a && s <= c.b) return { text: c.text, op: smooth((s - c.a) / CAP_IN) * (1 - smooth((s - (c.b - CAP_OUT)) / CAP_OUT)) };
    return { text: '', op: 0 };
  };
  root.add(<Txt y={CAPTION_Y} text={() => capNow().text} opacity={() => capNow().op} fontFamily={FONT} fontWeight={600} fontSize={46} fill={C.text} />);

  yield* run();

  layer.removeChildren();
  world.dispose();
  okWorld.dispose();
}

// (kept for the camera and rig modules that read these; avoids unused-import noise)
export const _KNOT_T = KNOT_T;
export const _quatRotate = quatRotate;
export type _Frame = Frame;
export const _THREE = THREE;
