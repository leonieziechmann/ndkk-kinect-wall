// Stage 5.2 (KONZEPT "5 · Fehler", item 2): "Die verdrehte Schlaufe – sie schlägt eine Acht". The
// rough animation (animatic): every beat, caption, label, camera and counter in place; Noor's hands
// from simple keyframes (shots/p5-eight-rig.ts) on exactly the frames the simulation used; the
// recorded movements (MOCAP_SLOTS) replace them later.
//
//   0  cause: the cable comes from a ring that was always wound the same way; the cable to the floor
//      is twisted (the stripe winds, twist rings, counter): "Im Kabel steckt schon Drall."
//   1  Noor lays the next loop; as soon as her right hand lets it go it turns into an eight and
//      stands out of the ring (side camera, slow motion, then once in real time):
//      "Passt er nicht, schlägt die Schlaufe eine Acht."
//   2  she presses it flat, it pops out again (slow motion): "Plattdrücken hilft nicht – der Drall
//      bleibt drin."
//   3  comparison, two panels, same camera: ✗ with twist (the eight) | ✓ without twist (stays flat)
//   4  fix 1: roll it back between thumb and index while the hand still holds it (slow motion, roll
//      arrow, counter), it stays flat ✓
//   5  fix 2: lay this loop the other way (hand turned over, "unter"), it stays flat ✓; tally
//      ü u u: "Zweimal dieselbe Sorte ist dann okay."
//   6  fix 3: lift the ring, the plug hangs free and spins (inset, slow motion), the counter falls
//      to 0; "Steckt ein Ende noch? Dann fang dort an zu wickeln."; then a new loop stays flat ✓
//   7  fix 4: "Viele Achten? Ganz auslegen, neu wickeln." (kinematic: she walks the ring out)
//
// Cable: simulated (shots/eight.ts: the XLR preset with a higher torsional stiffness, see EIGHT_GJ);
// fix 4 is kinematic. Everything on screen is a function of one scene clock (tau): SEGS map it to a
// shot and its time (holds, slow motion, cuts back for real-time replays).

import { Layout, Node, Rect, Txt } from '@motion-canvas/2d';
import { easeInOutCubic } from '@motion-canvas/core';
import * as THREE from 'three';
import { BakedRod, V3, loadBake, smooth } from '../../sim';
import { EIGHT_GEOM, HANG_T, OK_T, ROLL_T, SNAP_T, earlierLoops, hangFist, layPads, rollAt } from '../../shots/eight';
import { EightShot, RigInputs, eightRig } from '../../shots/p5-eight-rig';
import { NOOR } from '../../people/cast';
import { Grip, Rig, RigTrack, eyesOfRig, gripFrame, walk } from '../../people/rig';
import { CAPTION_Y, GAP, PANEL_H, PanelTitle, TOP, clock, readTime, splitPerson, viewLayers } from '../../lib/kit';
import { C, FONT, OVER, UNDER } from '../../lib/theme';
import { Mark, StageChip } from '../../lib/ui';
import { ArcArrow } from '../../three/arrows';
import { CableMesh } from '../../three/cable';
import { Orbit, makeCamera, mixOrbit, orbit, povFollow } from '../../three/camera';
import { callout } from '../../three/overlay';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';

// ===================================================================================== the plan

type Shot = EightShot | 'layout';
const SLOW = 0.25;

interface Seg {
  id: string;
  /** scene seconds */
  len: number;
  shot: Shot;
  /** shot time at its start and end (equal: time stands still) */
  from: number;
  to: number;
  /** scene time of its start */
  at: number;
  /** a continuous take (a cut starts a new one): Noor's arms are solved per take */
  take: number;
}

const SEGS: Seg[] = [];
let sceneAt = 0, take = 0;
const cut = () => take++;
const hold = (id: string, shot: Shot, at: number, len: number) => {
  SEGS.push({ id, len, shot, from: at, to: at, at: sceneAt, take });
  sceneAt += len;
};
const play = (id: string, shot: Shot, from: number, to: number, speed = 1) => {
  const len = (to - from) / speed;
  SEGS.push({ id, len, shot, from, to, at: sceneAt, take });
  sceneAt += len;
};

/** the eight: tilting out of the ring from SNAP_T.free, snapping into the eight about 1.3 s later (bake) */
const FLIP = { tilt: SNAP_T.free, snap: 3.15, done: 3.95, settled: 4.4 };
/** the roll: from the first stroke to a little after the last */
const ROLLED = ROLL_T.rolled + 0.15;
/** fix 3: the plug lifts off and spins (bake: off the floor at ~1.35 s, the twist out by ~2.1 s) */
const SPIN = { from: 1.2, to: 2.3 };

// 0 · cause: the twisted cable hangs
hold('in', 'snap', 0, 0.5);
hold('cause', 'snap', 0, 4.8);
// 1 · lay, the eight (slow motion: the slow tilt at half speed, the snap at a quarter), labels, replay
play('lay', 'snap', 0, FLIP.tilt);
play('tilt', 'snap', FLIP.tilt, FLIP.snap, 0.5);
play('flip', 'snap', FLIP.snap, FLIP.done, SLOW);
play('settle', 'snap', FLIP.done, FLIP.settled);
hold('eight', 'snap', FLIP.settled, 3.4);
cut();
play('replay', 'snap', 0.3, FLIP.settled);
// 2 · pressed flat, it pops out again
hold('pressCap', 'snap', FLIP.settled, 0.9);
play('press', 'snap', FLIP.settled, SNAP_T.letGo);
play('pop', 'snap', SNAP_T.letGo, SNAP_T.letGo + 0.6, SLOW);
play('popEnd', 'snap', SNAP_T.letGo + 0.6, SNAP_T.letGo + 1.0);
hold('bulky', 'snap', SNAP_T.letGo + 1.0, 2.5);
cut();
play('popReplay', 'snap', SNAP_T.letGo - 0.5, SNAP_T.letGo + 1.0);
// 3 · ✗ with twist | ✓ without, side by side
cut();
hold('cmpIn', 'snap', 0.3, 0.6);
play('cmp', 'snap', 0.3, OK_T.end);
hold('cmpHold', 'snap', OK_T.end, 3.0);
hold('cmpOut', 'snap', OK_T.end, 0.6);
// 4 · fix 1: roll it back between the fingers
cut();
hold('f1in', 'roll', 0, 1.3);
play('f1lay', 'roll', 0, ROLL_T.stroke0);
play('f1roll', 'roll', ROLL_T.stroke0, ROLLED, SLOW);
play('f1give', 'roll', ROLLED, ROLL_T.end);
hold('f1ok', 'roll', ROLL_T.end, 1.5);
cut();
play('f1replay', 'roll', ROLL_T.stroke0 - 0.4, ROLL_T.give);
// 5 · fix 2: lay it the other way
cut();
hold('f2in', 'rev', 0, 1.4);
play('f2lay', 'rev', 0, OK_T.end);
hold('f2ok', 'rev', OK_T.end, 4.8);
// 6 · fix 3: let the end hang
cut();
hold('f3in', 'hang', 0, 1.1);
play('f3lift', 'hang', 0, SPIN.from);
play('f3spin', 'hang', SPIN.from, SPIN.to, SLOW);
play('f3rest', 'hang', SPIN.to, 2.9);
cut();
play('f3replay', 'hang', 0.6, 3.6);
hold('f3done', 'hang', 3.6, 1.4);
hold('f3plug', 'hang', 3.6, 5.9);
cut();
play('f3relay', 'ok', 0.6, OK_T.end);
hold('f3ok', 'ok', OK_T.end, 1.6);
// 7 · fix 4: lay it all out, coil it again
cut();
const LAYOUT_LEN = 10.5;
play('f4', 'layout', 0, LAYOUT_LEN);
hold('out', 'layout', LAYOUT_LEN, 0.6);

/** the part's length [s] */
export const LENGTH = sceneAt;

function seg(id: string): Seg {
  const s = SEGS.find((x) => x.id === id);
  if (!s) throw new Error(`p5-eight: no segment ${id}`);
  return s;
}
/** scene time where segment id starts / ends */
const S = (id: string) => seg(id).at;
const E = (id: string) => seg(id).at + seg(id).len;

function segAt(tau: number): Seg {
  let s = SEGS[0];
  for (const x of SEGS) {
    if (tau < x.at) break;
    s = x;
  }
  return s;
}
/** the shot time at scene time tau */
function shotAt(tau: number): number {
  const s = segAt(tau);
  const u = s.len > 0 ? Math.min(1, Math.max(0, (tau - s.at) / s.len)) : 1;
  return s.from + (s.to - s.from) * u;
}
/** the first segment of a take */
const takeStart = (k: number) => (SEGS.find((x) => x.take === k) ?? SEGS[0]).at;

// ------------------------------------------------------------------------------------ captions

const CAPS: { text: string; a: number; b: number }[] = [
  { text: 'Im Kabel steckt schon Drall.', a: S('cause') + 0.3, b: E('flip') },
  { text: 'Passt er nicht, schlägt die Schlaufe eine Acht.', a: S('eight') + 0.2, b: E('replay') },
  { text: 'Plattdrücken hilft nicht – der Drall bleibt drin.', a: S('pressCap'), b: E('popEnd') + 0.6 },
  { text: 'Ohne Drall bleibt die Schlaufe flach liegen.', a: S('cmp') + 0.1, b: E('cmpHold') },
  { text: 'Zwischen den Fingern zurückrollen, bis sie flach fällt.', a: S('f1in') + 0.1, b: E('f1give') },
  { text: 'Oder diese Schlaufe andersherum legen.', a: S('f2in') + 0.1, b: E('f2lay') },
  { text: 'Zweimal dieselbe Sorte ist dann okay.', a: S('f2ok') + 0.2, b: E('f2ok') },
  { text: 'Oder das freie Ende hängen lassen – der Drall dreht sich raus.', a: S('f3in') + 0.1, b: E('f3done') },
  { text: 'Steckt ein Ende noch? Dann fang dort an zu wickeln.', a: S('f3plug') + 0.1, b: E('f3plug') },
  { text: 'Viele Achten? Ganz auslegen, neu wickeln.', a: S('f4') + 0.2, b: S('f4') + 6.2 },
];
const CAP_IN = 0.35, CAP_OUT = 0.3;

/** captions shorter than their reading time (characters / 12 + 1 s) or overlapping: printed when the part runs */
const captionProblems = (() => {
  const out: string[] = [];
  CAPS.forEach((c, i) => {
    const visible = c.b - c.a - CAP_IN;
    if (visible < readTime(c.text) - 0.01) out.push(`"${c.text}" visible ${visible.toFixed(2)} s < ${readTime(c.text).toFixed(2)} s`);
    if (i > 0 && c.a < CAPS[i - 1].b) out.push(`"${c.text}" overlaps the caption before`);
    // (KONZEPT: "höchstens etwa zehn Wörter"; its own text for way 3 has eleven)
    if (c.text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length > 11) out.push(`"${c.text}" has more than 11 words`);
  });
  return out;
})();

// ------------------------------------------------------------------------------------ mocap

/**
 * Beats whose movement comes from a Kinect recording later (mocap/shots.json ids; times in part
 * seconds). Until then Noor moves by the keyframes of shots/p5-eight-rig.ts.
 */
export const MOCAP_SLOTS = [
  { shot: 'p3.wrong.same', role: 'Noor', from: S('in'), to: E('cause'), note: 'Ursache: Ende von p3.wrong.same (Ring nur mit Über-Schlaufen in der Hand, Blick aufs hängende, verdrehte Kabel); das Kabel bleibt Simulation' },
  { shot: 'p5.eight.flip', role: 'Noor', from: S('lay'), to: E('popReplay'), note: 'Schlaufe legen, loslassen → Acht, flach drücken, springt zurück; Zeitlupen aus derselben Aufnahme gedehnt; die Hände treiben dann die Simulation (Zange, Faust, Druck)' },
  { shot: 'p5.eight.flip', role: 'Noor', from: S('cmpIn'), to: E('cmpOut'), note: '✗-Feld des Vergleichs: derselbe Take wie oben (Legen bis zur Acht)' },
  { shot: 'p1.coil.teach', role: 'Noor', from: S('cmpIn'), to: E('cmpOut'), note: '✓-Feld des Vergleichs: eine richtige Über-Schlaufe im Lehrtempo (die erste von p1.coil.teach); kein eigener p5-Shot' },
  { shot: 'p5.eight.roll', role: 'Noor', from: S('f1in'), to: E('f1replay'), note: 'Weg 1: rollen, solange die rechte Hand die Schlaufe noch hält; Daumen und Zeigefinger nah; die Zeitlupe aus der langsamen Aufnahme (pace slow)' },
  { shot: 'p5.eight.reverse', role: 'Noor', from: S('f2in'), to: E('f2ok'), note: 'Weg 2: Hand umgedreht, Schlaufe andersherum (unter) legen' },
  { shot: 'p5.eight.hang', role: 'Noor', from: S('f3in'), to: E('f3plug'), note: 'Weg 3: Ring auf Brusthöhe, Stecker hängt frei und dreht sich aus; Blick zum Stecker' },
  { shot: 'p1.coil.teach', role: 'Noor', from: S('f3relay'), to: E('f3ok'), note: 'Weg 3, Ergebnis: eine neue Schlaufe bleibt flach. Kein eigener Shot (p5.eight.hang endet mit „Dann zu Ende wickeln“, ohne Kamera auf die Schlaufe); bis dahin die erste Über-Schlaufe von p1.coil.teach' },
  { shot: 'p5.eight.layout', role: 'Noor', from: S('f4'), to: E('f4'), note: 'Weg 4: Ende auf D-Start, mit dem Ring die Bahn entlang, Schlaufen fallen ab, am Ende neu anfangen' },
];

// ===================================================================================== helpers

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (v: V3): V3 => mul3(v, 1 / (Math.hypot(v[0], v[1], v[2]) || 1));
const mixV = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// layout: her view left (55 %), outside right; two equal panels for the comparison
const wL = Math.round((1920 - 3 * GAP) * 0.55);
const wR = 1920 - 3 * GAP - wL;
const xL = -960 + GAP, xR = 960 - GAP - wR;
const midY = TOP + PANEL_H / 2;
const wC = (1920 - 3 * GAP) / 2;
const xC = [-960 + GAP, -960 + 2 * GAP + wC];

/** a small dark chip like the "Zeitlupe" badge, with any text */
function badge(layer: Node, text: string, visible: () => number, x: number, y = TOP + 24) {
  layer.add(
    <Rect x={x} y={y} offset={[0, -1]} padding={[8, 20]} radius={30} fill={C.text} opacity={visible} layout>
      <Txt text={text} fontFamily={FONT} fontWeight={700} fontSize={28} fill={'#fff'} />
    </Rect>,
  );
}

/** node d1 by parallel transport along a polyline (static kinematic cables: the stripe on top at the start) */
function transportFrames(P: V3[], d0: V3 = [0, 1, 0]): V3[] {
  const out: V3[] = [];
  let d = d0;
  for (let i = 0; i < P.length; i++) {
    const t = norm3(sub3(P[Math.min(P.length - 1, i + 1)], P[Math.max(0, i - 1)]));
    d = norm3(sub3(d, mul3(t, dot3(d, t))));
    out.push(d);
  }
  return out;
}

/** points at equal spacing h along a polyline */
function resampleLine(P: V3[], h: number): V3[] {
  const out: V3[] = [P[0]];
  let acc = 0, next = h;
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    while (acc + l >= next) {
      out.push(mixV(a, b, (next - acc) / l));
      next += h;
    }
    acc += l;
  }
  out.push(P[P.length - 1]);
  return out;
}

const G = EIGHT_GEOM;
const N = G.N;
const yawN = Math.atan2(N[0], N[2]);
const RC = 0.0032;
/** the loop as it hangs below the fist */
const LOOP_C: V3 = add3(add3(G.F, mul3(G.E1, 0.035)), [0, -0.13, 0]);

// cameras of the outside view (Noor stands at the origin facing -z; the loops face N, forward right).
// KONZEPT: on her side of the ring, to her right and a little behind her, above the hands, looking
// down: the light floor in front of her lies behind the black cable (not her dark trousers).
/** the default: to her right, a little behind, 25° down; the loop's face at ~65° */
const EXT: Orbit = { target: [LOOP_C[0] + 0.04, LOOP_C[1] + 0.02, LOOP_C[2]], yaw: 1.15, pitch: 0.55, dist: 1.35, fov: 38 };
/** the side camera for the eight: to her right, the loop at ~50° from its face (the figure eight and how it stands out) */
const SIDE: Orbit = { target: [LOOP_C[0] + 0.01, LOOP_C[1] + 0.01, LOOP_C[2]], yaw: 1.31, pitch: 0.33, dist: 0.9, fov: 36 };
/** the cable to the floor, from her right and behind: the floor in front of her behind it */
const CAUSE_CAM: Orbit = { target: [0.33, 0.48, -0.12], yaw: 0.62, pitch: 0.16, dist: 1.05, fov: 38 };
/** the ring lifted to chest height, the cable and plug hanging below */
const HANG_CAM: Orbit = { target: [-0.04, 0.74, -0.36], yaw: Math.PI / 2 - 0.15, pitch: 0.12, dist: 2.1, fov: 38 };
/** the comparison: both panels, the same camera, the loops face-on (Noor see-through, so the black cable stands out) */
const CMP_CAM: Orbit = { target: [LOOP_C[0] + 0.0, LOOP_C[1] - 0.01, LOOP_C[2]], yaw: yawN + 0.15, pitch: 0.22, dist: 0.85, fov: 36 };

// ===================================================================================== the part

export function* part(layer: Node) {
  const B: Record<EightShot, BakedRod> = {
    snap: (yield loadBake('eight-snap')) as BakedRod,
    ok: (yield loadBake('eight-ok')) as BakedRod,
    rev: (yield loadBake('eight-reverse')) as BakedRod,
    roll: (yield loadBake('eight-roll')) as BakedRod,
    hang: (yield loadBake('eight-swivel')) as BakedRod,
  };
  for (const p of captionProblems) console.log('[render] p5-eight caption:', p);

  const { tau, run } = clock(LENGTH);
  /** 0 → 1 → 0 between scene times a and b (fading in and out) */
  const win = (a: number, b: number, fi = 0.35, fo = 0.35) => {
    const s = tau();
    return smooth((s - a) / Math.max(1e-6, fi)) * (1 - smooth((s - (b - fo)) / Math.max(1e-6, fo)));
  };
  const cur = () => segAt(tau());
  /** the comparison is on (Noor see-through there) */
  const cmpX = () => win(S('cmpIn'), E('cmpOut'), 0.3, 0.3);
  const t = () => shotAt(tau());

  // ------------------------------------------------------------------------- what the bakes say
  const idx = (b: BakedRod) => ({ iF: Math.round(b.track('iF', 0)), iE: Math.round(b.track('iE', 0)), iPlug: Math.round(b.track('iPlug', 0)) });
  const I = idx(B.snap);
  const node = (b: BakedRod, i: number, tt: number): V3 => b.nodeAt(tt, i, [0, 0, 0]);
  const wOf = (p: V3) => dot3(sub3(p, G.F), N);
  /** the loop node that stands out furthest (in front of the ring), at shot time tt */
  const lobeNode = (b: BakedRod, tt: number) => {
    let best = I.iF, w = -1;
    for (let i = I.iF + 4; i <= I.iE - 4; i++) {
      const v = wOf(node(b, i, tt));
      if (v > w) { w = v; best = i; }
    }
    return { i: best, w };
  };
  /** where the two strands of the eight cross (closest pair of loop nodes far apart along the cable) */
  const crossing = (b: BakedRod, tt: number) => {
    let best = { d: Infinity, p: [0, 0, 0] as V3 };
    for (let i = I.iF + 6; i <= I.iE - 6; i += 1)
      for (let j = i + 22; j <= I.iE - 6; j += 1) {
        const a = node(b, i, tt), c = node(b, j, tt);
        const d = Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
        if (d < best.d) best = { d, p: mixV(a, c, 0.5) };
      }
    return best;
  };
  const eightAt = { lobe: lobeNode(B.snap, FLIP.settled), cross: crossing(B.snap, FLIP.settled), wr: B.snap.track('wrLoop', FLIP.settled) };
  const pressLobe = lobeNode(B.snap, SNAP_T.press0);
  const popped = { before: B.snap.track('out', SNAP_T.letGo - 0.05), after: B.snap.track('out', SNAP_T.letGo + 0.9), lk: B.snap.track('twLoop', SNAP_T.end) + B.snap.track('wrLoop', SNAP_T.end) };
  const okEnd = { wr: B.ok.track('wrLoop', OK_T.end), out: B.ok.track('out', OK_T.end) };
  const revEnd = { wr: B.rev.track('wrLoop', OK_T.end), out: B.rev.track('out', OK_T.end), lk: B.rev.track('twLoop', OK_T.end) + B.rev.track('wrLoop', OK_T.end) };
  const rollEnd = { wr: B.roll.track('wrLoop', ROLL_T.end), lk0: B.roll.track('twLoop', ROLL_T.stroke0) + B.roll.track('wrLoop', ROLL_T.stroke0), lk: B.roll.track('twLoop', ROLL_T.end) + B.roll.track('wrLoop', ROLL_T.end) };
  const hangEnd = { tw0: B.hang.track('twHang', 0), tw: B.hang.track('twHang', 3.6), plugY: B.hang.track('plugY', 3.6), spin: B.hang.track('plugSpin', 3.6) };
  // what may be claimed (the labels and ticks appear only if the bake shows it)
  const truth = {
    isEight: eightAt.wr > 0.8 && eightAt.lobe.w > 0.04,
    popsOut: popped.after > popped.before + 0.015,
    okFlat: Math.abs(okEnd.wr) < 0.3,
    revFlat: Math.abs(revEnd.wr) < 0.3,
    rollFlat: Math.abs(rollEnd.wr) < 0.3,
    untwisted: Math.abs(hangEnd.tw) < 0.3 && hangEnd.plugY > 0.02,
  };
  console.log('[render] p5-eight checks', JSON.stringify({
    length: +LENGTH.toFixed(2),
    segs: SEGS.map((x) => `${x.id} ${x.at.toFixed(2)}`).join(' | '),
    eight: { wr: +eightAt.wr.toFixed(2), lobe: +eightAt.lobe.w.toFixed(3), cross: +eightAt.cross.d.toFixed(3) },
    popped, okEnd, revEnd, rollEnd, hangEnd, truth, captionProblems,
  }));

  // ------------------------------------------------------------------------- Noor: one RigTrack per take
  const plugAt = (shot: EightShot) => (tt: number) => node(B[shot], B[shot].n - 1, tt);
  const lobeAt = (tt: number) => add3(node(B.snap, pressLobe.i, tt), mul3(N, RC + 0.01));
  const inputs: Record<EightShot, RigInputs> = {
    snap: { lobe: lobeAt },
    ok: {},
    rev: {},
    roll: {},
    hang: { plug: plugAt('hang') },
  };
  /** Noor's rig at scene time s (the cable's shot and time from the segments) */
  const rigAt = (s: number): Rig => {
    const sc = Math.min(LENGTH, Math.max(0, s));
    const sg = segAt(sc);
    const shot = (sg.shot === 'layout' ? 'snap' : sg.shot) as EightShot;
    return eightRig(shot, shotAt(sc), sc, inputs[shot]);
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

  // ------------------------------------------------------------------------- the main world
  const maxN = Math.max(...Object.values(B).map((b) => b.n));
  const pos = new Float32Array(3 * maxN), d1 = new Float32Array(3 * maxN);
  const cable = new CableMesh({ maxNodes: maxN, radius: RC, plugStart: null, plugEnd: 'xlr-female', stripeWidth: 0.05 });
  const noor = splitPerson(NOOR, rigPoseFallback());
  /** the two earlier loops in her fist (drawn from the same points the simulation collides with) */
  const early = [0, 1].map(() => new CableMesh({ maxNodes: 61, radius: RC, plugStart: null, plugEnd: null, stripeWidth: 0.05 }));
  const earlyPos = new Float32Array(3 * 61), earlyD1 = new Float32Array(3 * 61);
  const drawEarly = (meshes: CableMesh[], at: V3) => {
    earlierLoops(at).forEach((L, k) => {
      // (their stripe winds once round each loop, as on a used cable)
      const c = mul3(L.reduce((a, p) => add3(a, p), [0, 0, 0] as V3), 1 / L.length);
      L.forEach((p, i) => {
        earlyPos.set(p, 3 * i);
        const inward = norm3(sub3(c, p));
        const ph = (2 * Math.PI * i) / (L.length - 1) + k * 2.1;
        earlyD1.set(add3(mul3(N, Math.cos(ph)), mul3(inward, Math.sin(ph))), 3 * i);
      });
      meshes[k].update(earlyPos, earlyD1, L.length);
    });
  };
  // twist rings on the cable to the floor (one per turn it holds, KONZEPT: curved 3D arrows for "Drall")
  const rings = [0, 1].map(() => new ArcArrow({ color: '#3b3f46', thickness: 0.0024 }));
  // the roll arrow round the cable at the pads (fix 1)
  const rollArrow = new ArcArrow({ color: OVER, thickness: 0.003 });
  const extCam = makeCamera(38);
  viewLayers(extCam, 'ext');
  const povCam = makeCamera(56);
  viewLayers(povCam, 'pov');
  const plugCam = makeCamera(30);
  viewLayers(plugCam, 'ext');
  const cmpCamA = makeCamera(36);
  viewLayers(cmpCamA, 'ext');

  /** the outside camera: keys in scene time, each blending from the one before over `dur` (0: a cut) */
  const camKeys: { at: number; dur: number; cam: () => Orbit }[] = [
    { at: 0, dur: 0, cam: () => CAUSE_CAM },
    { at: S('lay') - 0.6, dur: 1.2, cam: () => EXT },
    { at: S('tilt'), dur: 0, cam: () => SIDE },
    // (fix 1: her view shows the fingers rolling; outside, the loop: does it turn or stay flat?)
    { at: S('f1in'), dur: 0, cam: () => SIDE },
    { at: S('f2in'), dur: 0, cam: () => EXT },
    { at: S('f3in'), dur: 0, cam: () => EXT },
    { at: S('f3lift') + 0.2, dur: 1.0, cam: () => HANG_CAM },
    { at: S('f3replay'), dur: 0, cam: () => HANG_CAM },
    { at: S('f3relay'), dur: 0, cam: () => EXT },
  ];
  const camOut: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
  const extOrbit = (): Orbit => {
    const s = tau();
    let i = 0;
    for (let k = 0; k < camKeys.length; k++) if (s >= camKeys[k].at) i = k;
    const k = camKeys[i];
    const u = k.dur > 0 ? easeInOutCubic(clamp01((s - k.at) / k.dur)) : 1;
    if (u >= 1 || i === 0) return k.cam();
    return mixOrbit(camKeys[i - 1].cam(), k.cam(), u, camOut);
  };
  /** her view looks at the loop; at the cable to the floor first; at the plug in fix 3 */
  const look = (s: number): V3 => {
    const sg = segAt(Math.min(LENGTH, Math.max(0, s)));
    const hip: V3 = [0.3, 0.55, -0.16];
    if (sg.id === 'in' || sg.id === 'cause') return hip;
    if (sg.id === 'lay') return mixV(hip, LOOP_C, clamp01((s - S('lay')) / 1.2));
    if (sg.shot === 'hang') {
      const tt = shotAt(s);
      const f = hangFist()(tt).p;
      return mixV(LOOP_C, mixV(f, plugAt('hang')(tt), 0.5), smooth((tt - HANG_T.lift0) / 1.2));
    }
    if (sg.shot === 'roll') return [-0.07, 0.86, -0.25];
    return add3(LOOP_C, [0.02, -0.04, -0.06]);
  };

  const world = new World3D('p5-eight', () => {
    const sg = cur();
    const tt = t();
    if (sg.shot === 'layout') return;
    const b = B[sg.shot];
    const ii = idx(b);
    b.frameSample(tt, pos, d1);
    // (no white glow on the cable to the floor here: it would cover the stripe, which is the point)
    cable.update(pos, d1, ii.iPlug + 1);
    const fistP = sg.shot === 'hang' ? hangFist()(tt).p : G.F;
    drawEarly(early, fistP);
    noor.update(poseNow());
    // see-through during the comparison (only its panels show then): the cable against the floor
    noor.seeThrough(1 - 0.75 * cmpX());
    // twist rings: on the cable to the floor, one per turn it holds (measured), during the cause
    const ringOn = win(S('cause') + 1.0, E('cause'), 0.4, 0.4);
    const tw = b.track('twHang', tt);
    rings.forEach((r, k) => {
      const u = clamp01(Math.abs(tw) - k) * ringOn;
      r.group.visible = u > 0.02;
      if (u > 0.02) {
        const p = node(b, ii.iE + 34 + 14 * k, tt);
        const q = node(b, ii.iE + 36 + 14 * k, tt);
        r.update({ center: p, axis: mul3(norm3(sub3(q, p)), Math.sign(tw) || 1), from: [Math.sin(extOrbit().yaw), 0, Math.cos(extOrbit().yaw)], radius: 0.022, angle: (320 * Math.PI) / 180, progress: u });
      }
    });
    // the roll arrow round the cable just past the pads, while the thumb rolls it (fix 1)
    const ra = sg.shot === 'roll' ? win(S('f1lay') + ROLL_T.stroke0 - 0.3, E('f1roll') + 0.3, 0.3, 0.3) : 0;
    rollArrow.group.visible = ra > 0.01;
    if (ra > 0.01) {
      const f = layPads('over')(tt);
      const d3 = norm3(sub3(G.pads.over, G.E));
      const c = add3(f.p, mul3(d3, 0.045));
      const done = -rollAt(tt) / (4 * Math.PI);
      rollArrow.update({ center: c, axis: mul3(d3, -1), from: [0, 1, 0], radius: 0.024, angle: 2.6, progress: clamp01(0.25 + 0.75 * (done * 4 - Math.floor(done * 4 - 1e-6))) * ra });
    }
    orbit(extCam, extOrbit());
    orbit(cmpCamA, CMP_CAM);
    // (her view narrows a little while the eight is the subject: as if she looked closer)
    const close = Math.max(win(S('tilt'), E('replay'), 0.6, 0.6), win(S('pressCap'), E('popReplay'), 0.6, 0.6));
    povFollow(povCam, (x) => eyesOfRig(NOOR, rigAt(x)), look, tau(), { back: 0.05, up: 0.03, fov: 60 - 12 * close, smooth: 0.3 });
    // the inset: close on the plug (fix 3)
    if (sg.shot === 'hang') {
      const pl = node(b, b.n - 1, tt);
      orbit(plugCam, { target: [pl[0], pl[1] + 0.05, pl[2]], yaw: Math.PI / 2, pitch: 0.15, dist: 0.36, fov: 30 });
    }
  });
  new Studio(world.scene, { focus: [0.05, 0.6, -0.2], focusRadius: 1.2 });
  world.scene.add(cable.group, noor.person.group, ...early.map((m) => m.group), ...rings.map((r) => r.group), rollArrow.group);

  // ------------------------------------------------------------------------- the comparison world (✓ eight-ok)
  const okPos = new Float32Array(3 * B.ok.n), okD1 = new Float32Array(3 * B.ok.n);
  const okCable = new CableMesh({ maxNodes: B.ok.n, radius: RC, plugStart: null, plugEnd: 'xlr-female', stripeWidth: 0.05 });
  const okEarly = [0, 1].map(() => new CableMesh({ maxNodes: 61, radius: RC, plugStart: null, plugEnd: null, stripeWidth: 0.05 }));
  const okNoor = splitPerson(NOOR, rigPoseFallback());
  const okTrack = new RigTrack(NOOR, (x) => eightRig('ok', x, x + 40, {}), 0, 30);
  const cmpCamB = makeCamera(36);
  viewLayers(cmpCamB, 'ext');
  const okI = idx(B.ok);
  const cmpWorld = new World3D('p5-eight-cmp', () => {
    const tt = Math.min(OK_T.end, Math.max(0, t()));
    B.ok.frameSample(tt, okPos, okD1);
    okCable.update(okPos, okD1, okI.iPlug + 1);
    drawEarly(okEarly, G.F);
    okNoor.update(okTrack.pose(tt));
    okNoor.seeThrough(1 - 0.75 * cmpX());
    orbit(cmpCamB, CMP_CAM);
  });
  new Studio(cmpWorld.scene, { focus: [0.05, 0.6, -0.2], focusRadius: 1.2 });
  cmpWorld.scene.add(okCable.group, okNoor.person.group, ...okEarly.map((m) => m.group));

  // ------------------------------------------------------------------------- the layout world (fix 4, kinematic)
  const lay = layoutWorld(() => (cur().shot === 'layout' ? t() : 0));

  // ------------------------------------------------------------------------- the picture
  const root = new Node({ opacity: () => smooth(tau() / 0.5) * (1 - smooth((tau() - S('out')) / 0.6)) });
  layer.add(root);
  const cmpOp = () => win(S('cmpIn'), E('cmpOut'), 0.6, 0.6);
  const layOp = () => win(S('f4') - 0.01, LENGTH + 1, 0.5, 0.3);
  const mainOp = () => (1 - cmpOp()) * (1 - layOp());
  const povView = (<ThreeView world={world} camera={povCam} x={xL + wL / 2} y={midY} width={wL} height={PANEL_H} radius={28} opacity={mainOp} />) as ThreeView;
  const extView = (<ThreeView world={world} camera={extCam} x={xR + wR / 2} y={midY} width={wR} height={PANEL_H} radius={28} opacity={mainOp} />) as ThreeView;
  root.add([povView, extView]);
  const titles = new Node({ opacity: () => 1 - cmpOp() });
  titles.add([<PanelTitle text={'So siehst du es'} x={xL + 24} />, <PanelTitle text={'Von außen'} x={xR + 24} />]);
  root.add(titles);
  // the layout panels (fix 4)
  const layNode = new Node({ opacity: layOp });
  const layPov = (<ThreeView world={lay.world} camera={lay.povCam} x={xL + wL / 2} y={midY} width={wL} height={PANEL_H} radius={28} />) as ThreeView;
  const layExt = (<ThreeView world={lay.world} camera={lay.extCam} x={xR + wR / 2} y={midY} width={wR} height={PANEL_H} radius={28} />) as ThreeView;
  layNode.add([layPov, layExt, <PanelTitle text={'So siehst du es'} x={xL + 24} />, <PanelTitle text={'Von außen'} x={xR + 24} />]);
  root.add(layNode);

  // the comparison panels
  const cmpNode = new Node({ opacity: cmpOp });
  const cmpViews = [
    (<ThreeView world={world} camera={cmpCamA} x={xC[0] + wC / 2} y={midY} width={wC} height={PANEL_H} radius={28} />) as ThreeView,
    (<ThreeView world={cmpWorld} camera={cmpCamB} x={xC[1] + wC / 2} y={midY} width={wC} height={PANEL_H} radius={28} />) as ThreeView,
  ];
  cmpNode.add(cmpViews);
  [0, 1].forEach((i) => {
    const good = i === 1;
    cmpNode.add(
      <Rect x={xC[i] + 24} y={TOP + 24} offset={[-1, -1]} padding={[8, 22, 8, 12]} radius={40} fill={C.plate} layout alignItems={'center'} gap={12}>
        <Mark good={good} size={40} />
        <Txt text={good ? 'Ohne Drall' : 'Mit Drall'} fontFamily={FONT} fontWeight={700} fontSize={32} fill={C.text} />
      </Rect>,
    );
  });
  root.add(cmpNode);

  // the plug inset (fix 3): top right of the outside view
  const insetOn = () => win(S('f3lift') + 0.4, E('f3done'), 0.4, 0.4);
  const IW = 330, IH = 330;
  const inset = new Node({ opacity: insetOn });
  inset.add(<Rect x={xR + wR - 24 - IW / 2} y={TOP + 96 + IH / 2} width={IW + 8} height={IH + 8} radius={24} fill={'#ffffff'} />);
  inset.add(<ThreeView world={world} camera={plugCam} x={xR + wR - 24 - IW / 2} y={TOP + 96 + IH / 2} width={IW} height={IH} radius={20} />);
  inset.add(
    <Rect x={xR + wR - 24 - IW / 2} y={TOP + 96 + IH + 30} offset={[0, -1]} padding={[8, 20]} radius={30} fill={C.plate} layout>
      <Txt text={() => `Drehungen im Kabel: ${Math.abs(Math.round(B.hang.track('twHang', t())))}`} fontFamily={FONT} fontWeight={700} fontSize={32} fill={C.text} />
    </Rect>,
  );
  root.add(inset);

  root.add(<StageChip current={5} x={0} y={TOP + PANEL_H + 34} />);

  // badges over her view: slow motion, real time, which fix
  const bx = xL + wL / 2;
  const slowOn = () => Math.max(win(S('tilt'), E('flip'), 0.2, 0.2), win(S('pop'), E('pop'), 0.2, 0.2), win(S('f1roll'), E('f1roll'), 0.2, 0.2), win(S('f3spin'), E('f3spin'), 0.2, 0.2));
  badge(root, 'Zeitlupe', slowOn, bx);
  badge(root, 'Echtzeit', () => Math.max(win(S('replay'), E('replay'), 0.3, 0.3), win(S('popReplay'), E('popReplay'), 0.3, 0.3), win(S('f1replay'), E('f1replay'), 0.3, 0.3), win(S('f3replay'), E('f3replay'), 0.3, 0.3)), bx);
  const fixChip = (n: number, a: number, b: number) =>
    root.add(
      <Rect x={xL + wL - 24} y={TOP + 24} offset={[1, -1]} padding={[8, 20]} radius={30} fill={C.plate} opacity={() => win(a, b, 0.4, 0.4)} layout>
        <Txt text={`Weg ${n} von 4`} fontFamily={FONT} fontWeight={700} fontSize={32} fill={C.text} />
      </Rect>,
    );
  fixChip(1, S('f1in'), E('f1replay'));
  fixChip(2, S('f2in'), E('f2ok'));
  fixChip(3, S('f3in'), E('f3ok'));
  fixChip(4, S('f4'), E('f4'));

  // the cause: the ring it came from was always wound the same way
  root.add(
    <Rect x={xR + wR - 24} y={TOP + 24} offset={[1, -1]} padding={[8, 22, 8, 12]} radius={40} fill={C.plate} layout alignItems={'center'} gap={12} opacity={() => win(S('cause') + 0.4, E('lay'), 0.4, 0.4)}>
      <Mark good={false} size={36} />
      <Txt text={'vorher'} fontFamily={FONT} fontWeight={700} fontSize={32} fill={C.text} />
      {[0, 1, 2, 3, 4, 5].map(() => (
        <Txt text={'ü'} fontFamily={FONT} fontWeight={800} fontSize={36} fill={OVER} />
      ))}
    </Rect>,
  );
  // the cause: the turns in the cable to the floor, measured
  root.add(
    <Rect x={xR + wR / 2} y={TOP + PANEL_H - 40} offset={[0, 1]} padding={[10, 26]} radius={36} fill={C.plate} layout opacity={() => win(S('cause') + 1.0, E('cause'), 0.4, 0.4)}>
      <Txt text={() => `Drehungen im Kabel: ${Math.abs(Math.round(B.snap.track('twHang', t())))}`} fontFamily={FONT} fontWeight={700} fontSize={36} fill={C.text} />
    </Rect>,
  );
  // fix 1: the loop's turns (twist + writhe, measured): they go down while she rolls
  root.add(
    <Rect x={xR + wR / 2} y={TOP + PANEL_H - 40} offset={[0, 1]} padding={[10, 26]} radius={36} fill={C.plate} layout opacity={() => win(S('f1lay'), E('f1give'), 0.4, 0.4)}>
      <Txt text={() => `Drehungen in der Schlaufe: ${Math.abs(Math.round(B.roll.track('twLoop', t()) + B.roll.track('wrLoop', t())))}`} fontFamily={FONT} fontWeight={700} fontSize={36} fill={C.text} />
    </Rect>,
  );
  // fix 2: the tally, the last two of the same kind
  const tal = (
    <Rect x={xR + wR - 24} y={TOP + 24} offset={[1, -1]} padding={[8, 22]} radius={40} fill={C.plate} layout alignItems={'center'} gap={14} opacity={() => win(S('f2in'), E('f2ok'), 0.4, 0.4)}>
      <Txt text={'ü'} fontFamily={FONT} fontWeight={800} fontSize={40} fill={OVER} />
      <Txt text={'u'} fontFamily={FONT} fontWeight={800} fontSize={40} fill={UNDER} />
      <Txt text={'u'} fontFamily={FONT} fontWeight={800} fontSize={40} fill={UNDER} opacity={() => 0.15 + 0.85 * smooth((tau() - S('f2lay') - 1.9) / 0.3)} />
    </Rect>
  );
  root.add(tal);
  root.add(
    <Rect x={xR + wR - 24} y={TOP + 100} offset={[1, -1]} padding={[8, 22]} radius={40} fill={UNDER} layout opacity={() => win(S('f2ok') + 0.3, E('f2ok'), 0.4, 0.4)}>
      <Txt text={'2× u: okay'} fontFamily={FONT} fontWeight={700} fontSize={32} fill={'#fff'} />
    </Rect>,
  );

  // ------------------------------------------------------------------------- labels where it happens
  const label = (o: { view: ThreeView; target: () => V3; at: [number, number]; text: string; color?: string; on: () => number }) =>
    root.add(callout({ view: o.view, target: o.target, at: o.at, text: o.text, color: o.color, size: 34, arrow: true, opacity: o.on }));
  const tNode = (shot: EightShot, i: () => number) => () => node(B[shot], i(), t());
  // cause: the stripe winds round the hanging cable
  label({ view: extView, target: tNode('snap', () => I.iE + 48), at: [xR + 210, TOP + 300], text: 'Streifen windet sich', on: () => win(S('cause') + 1.6, E('cause'), 0.4, 0.3) });
  // the eight: where it crosses, and how it stands out of the ring
  if (truth.isEight) {
    label({ view: extView, target: () => node(B.snap, eightAt.lobe.i, t()), at: [xR + wR - 190, TOP + 640], text: 'steht aus dem Ring', on: () => win(S('eight') + 0.5, E('eight'), 0.4, 0.3) });
    label({ view: extView, target: () => eightAt.cross.p, at: [xR + 170, TOP + 170], text: 'Acht', on: () => win(S('eight') + 0.2, E('eight'), 0.4, 0.3) });
  }
  if (truth.popsOut) label({ view: extView, target: () => node(B.snap, lobeNode(B.snap, SNAP_T.letGo + 0.9).i, t()), at: [xR + wR / 2, TOP + 150], text: 'springt zurück – sperrig', on: () => win(S('bulky') + 0.2, E('bulky'), 0.4, 0.3) });
  // the comparison
  if (truth.isEight) label({ view: cmpViews[0], target: () => node(B.snap, eightAt.lobe.i, t()), at: [xC[0] + wC / 2, TOP + 160], text: 'Acht', on: () => win(S('cmpHold'), E('cmpHold'), 0.4, 0.3) });
  if (truth.okFlat) label({ view: cmpViews[1], target: () => node(B.ok, Math.round((okI.iF + okI.iE) / 2), Math.min(OK_T.end, t())), at: [xC[1] + wC / 2, TOP + 160], text: 'liegt flach', on: () => win(S('cmpHold'), E('cmpHold'), 0.4, 0.3) });
  // fix 1: rolling, then flat
  label({ view: povView, target: () => layPads('over')(t()).p, at: [xL + wL / 2 + 220, TOP + 160], text: 'rollen', on: () => win(S('f1in') + 0.4, S('f1roll') + 0.2, 0.4, 0.3) });
  if (truth.rollFlat) label({ view: extView, target: () => node(B.roll, Math.round((I.iF + I.iE) / 2), t()), at: [xR + wR / 2, TOP + 640], text: '✓ fällt flach', on: () => win(S('f1give') + 1.0, E('f1ok'), 0.4, 0.3) });
  // fix 2: the hand turned over; flat
  label({ view: extView, target: () => layPads('under')(t()).p, at: [xR + 220, TOP + 170], text: 'Hand umgedreht', on: () => win(S('f2in') + 0.2, S('f2lay') + 0.3, 0.3, 0.3) });
  if (truth.revFlat) label({ view: extView, target: () => node(B.rev, Math.round((I.iF + I.iE) / 2), t()), at: [xR + wR / 2, TOP + 640], text: '✓ bleibt flach', on: () => win(S('f2ok') + 0.2, E('f2ok'), 0.4, 0.3) });
  // fix 3: the plug hangs free; the twist is out; then a new loop
  if (truth.untwisted) {
    label({ view: extView, target: () => node(B.hang, B.hang.n - 1, t()), at: [xR + 200, TOP + 640], text: 'Stecker hängt frei', on: () => win(S('f3done'), E('f3plug'), 0.4, 0.3) });
    label({ view: extView, target: () => node(B.ok, Math.round((okI.iF + okI.iE) / 2), t()), at: [xR + wR / 2, TOP + 640], text: '✓ neue Schlaufe bleibt flach', on: () => win(S('f3relay') + 1.8, E('f3ok'), 0.4, 0.3) });
  }
  // fix 4
  label({ view: layExt, target: () => lay.floorMark(), at: [xR + wR / 2, TOP + 160], text: 'ganz ausgelegt', on: () => win(S('f4') + 6.5, E('f4'), 0.4, 0.3) });

  // ------------------------------------------------------------------------- captions
  const capNow = () => {
    const s = tau();
    for (const c of CAPS) if (s >= c.a && s <= c.b) return { text: c.text, op: smooth((s - c.a) / CAP_IN) * (1 - smooth((s - (c.b - CAP_OUT)) / CAP_OUT)) };
    return { text: '', op: 0 };
  };
  root.add(<Txt y={CAPTION_Y} text={() => capNow().text} opacity={() => capNow().op} fontFamily={FONT} fontWeight={600} fontSize={46} fill={C.text} />);
  // fix 4 ends with the over-under tally of the new coil
  root.add(
    <Layout layout direction={'row'} alignItems={'center'} gap={20} y={CAPTION_Y} opacity={() => win(S('f4') + 6.6, E('f4') + 0.6, 0.4, 0.4)}>
      <Mark good size={58} />
      <Txt text={'Neu wickeln: ü u ü u ü u'} fontFamily={FONT} fontWeight={600} fontSize={46} fill={C.text} />
    </Layout>,
  );

  yield* run();

  layer.removeChildren();
  world.dispose();
  cmpWorld.dispose();
  lay.world.dispose();
}

/** a standing pose to build the meshes with (updated every frame) */
function rigPoseFallback() {
  return new RigTrack(NOOR, (x) => eightRig('snap', 0, x, {}), 0, 30).pose(0);
}

// ===================================================================================== fix 4: lay it all out

/**
 * Fix 4, kinematic (KONZEPT allows a guided cable where the behaviour is not the point): Noor puts
 * the end with its plug down at D-Start and walks the path with the ring in her left hand; loop by
 * loop falls off and the cable lies in a long arc behind her. Then she stands at the far end with
 * the last of it, ready to coil it again.
 */
function layoutWorld(time: () => number) {
  const TOTAL = 5.0, LOOPL = 0.75, WALK0 = 0.8, WALK1 = 7.2;
  // the path on the floor (D-Start → D-Ziel), a gentle arc
  const path = (u: number): V3 => [-1.5 + 3.0 * u, RC, -0.9 - 0.35 * Math.sin(Math.PI * u)];
  const PL = (() => {
    let l = 0;
    for (let k = 1; k <= 200; k++) l += Math.hypot(...sub3(path(k / 200), path((k - 1) / 200)));
    return l;
  })();
  const walkPath = [
    { t: WALK0, x: path(0.05)[0], z: path(0.05)[2] + 0.45 },
    { t: WALK1, x: path(0.95)[0], z: path(0.95)[2] + 0.45 },
    { t: WALK1 + 1.2, x: path(0.95)[0], z: path(0.95)[2] + 0.45, yaw: Math.PI / 2 + 0.6 },
  ];
  const rigAt = (tt: number): Rig => {
    const r = walk(NOOR, walkPath, Math.max(0, tt), 2);
    // the ring in her left hand, in front of her left hip (towards the path); the right hand swings
    const fy = r.yaw;
    const f: V3 = [Math.sin(fy), 0, -Math.cos(fy)], rt: V3 = [Math.cos(fy), 0, Math.sin(fy)];
    const p: V3 = [r.pos[0] + 0.28 * f[0] - 0.14 * rt[0], 0.93, r.pos[1] + 0.28 * f[2] - 0.14 * rt[2]];
    const grip: Grip = gripFrame(p, norm3(add3(mul3(rt, -1), mul3(f, 0.3))), norm3(add3(mul3(f, -0.9), [0, -0.4, 0])));
    return { ...r, look: [p[0] - 0.4 * rt[0], 0.2, p[2] - 0.4 * rt[2] + 0.1], hands: [{ grip, hold: 'coil', radius: 0.016, thumbAlong: 1, free: 0.4 }, null] };
  };
  const track = new RigTrack(NOOR, rigAt, 0, 30);
  const noor = splitPerson(NOOR, track.pose(0));
  const MAXN = 720;
  // (drawn 12 mm thick in this wide shot, as KONZEPT allows for the XLR in a Totale)
  const cable = new CableMesh({ maxNodes: MAXN, radius: 0.006, plugStart: 'xlr-male', plugEnd: 'xlr-female', stripeWidth: 0.05 });
  const posA = new Float32Array(3 * MAXN), d1A = new Float32Array(3 * MAXN);
  let floorMid: V3 = path(0.5);
  /** the cable's polyline at time tt: on the floor from D-Start, up to the fist, the loops left in the ring */
  const shape = (tt: number): V3[] => {
    const pose = track.pose(tt);
    const g = (pose.body.arms?.[0]?.grip ?? null) as { p: V3 } | null;
    const fist: V3 = g ? g.p : [0, 0.93, -0.3];
    // how far along the path the cable lies: up to below her (a little behind the fist)
    const walked = clamp01((tt - WALK0) / (WALK1 - WALK0));
    const uLay = 0.03 + 0.9 * smooth(walked);
    const floorPts: V3[] = [];
    for (let k = 0; k <= 120; k++) floorPts.push(path((k / 120) * uLay));
    const touch = floorPts[floorPts.length - 1];
    floorMid = path(uLay * 0.5);
    // up to the fist: a hanging curve
    const hang: V3[] = [];
    for (let k = 1; k <= 30; k++) {
      const u = k / 30;
      const p = mixV(touch, fist, u);
      p[1] = touch[1] + (fist[1] - touch[1]) * u * u;
      hang.push(p);
    }
    const laid = PL * uLay;
    const hangL = Math.hypot(...sub3(fist, touch)) * 1.15;
    const left = Math.max(0.3, TOTAL - laid - hangL);
    // the loops in the ring: round, the first two twisted into eights (the messy ring)
    const loops: V3[] = [];
    const nl = left / LOOPL;
    const K = Math.ceil(nl);
    for (let k = 0; k < K; k++) {
      const frac = k === K - 1 ? nl - Math.floor(nl) || 1 : 1;
      const M = Math.max(2, Math.round(40 * frac));
      for (let j = 1; j <= M; j++) {
        const a = (j / 40) * 2 * Math.PI;
        const R = 0.12;
        const eightTwist = k >= K - 2 && tt < WALK1 ? Math.min(1, Math.max(0, (1 - Math.cos(a)) / 2 - 0.3)) * Math.PI * 0.9 : 0;
        const lx = R * Math.sin(a), ly = -R * (1 - Math.cos(a));
        const off = 0.012 * k;
        loops.push([fist[0] + lx * Math.cos(eightTwist) + off, fist[1] + ly, fist[2] + lx * Math.sin(eightTwist) + off * 0.3]);
      }
    }
    return resampleLine([...floorPts, ...hang, ...loops], 0.008).slice(0, MAXN);
  };
  const extCam = makeCamera(36);
  viewLayers(extCam, 'ext');
  const povCam = makeCamera(58);
  viewLayers(povCam, 'pov');
  const world = new World3D('p5-eight-layout', () => {
    const tt = time();
    noor.update(track.pose(tt));
    const P = shape(tt);
    const D = transportFrames(P);
    P.forEach((p, i) => {
      posA.set(p, 3 * i);
      d1A.set(D[i], 3 * i);
    });
    cable.update(posA, d1A, P.length);
    // (follows her along the path, a little behind her towards D-Start, where the cable lies)
    const r0 = rigAt(tt);
    orbit(extCam, { target: [0.75 * r0.pos[0] - 0.1, 0.42, -0.75], yaw: 0.2, pitch: 0.4, dist: 3.0, fov: 40 });
    // her view: down at the ring in her hand and the floor beside and behind it, where the loops land
    povFollow(povCam, (x) => eyesOfRig(NOOR, rigAt(x)), (x) => {
      const r = rigAt(x);
      const g = r.hands[0]?.grip?.p ?? [r.pos[0], 0.9, r.pos[1] - 0.3];
      return [g[0] - 0.15, 0.3, g[2] - 0.2];
    }, tt, { back: 0.05, up: 0.03, fov: 66, smooth: 0.35 });
  });
  new Studio(world.scene, { focus: [0, 0.4, -0.8], focusRadius: 2.4 });
  world.scene.add(cable.group, noor.person.group);
  return { world, extCam, povCam, floorMark: () => floorMid };
}
