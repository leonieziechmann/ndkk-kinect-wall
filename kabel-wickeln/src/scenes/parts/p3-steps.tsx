// Stage 3 (KONZEPT "3 · Schritt für Schritt", ≈ 2 min): the rough animation (animatic) of the eight
// steps, split screen: her own view (left, 55 %: her arms only, her body's shadow) | outside (45 %).
//
//   0  "Du wickelst lieber mit links? Dann alles spiegeln.": her view flips to its mirror image
//      for one loop (2.5 s), the outside view dims, then flips back
//   1  the end in the left hand, the plug (with the pins, the velcro tie already on the cable next
//      to it) sticks out of the fist: "Stecker bleibt außerhalb des Rings"
//   2  the right hand pinches next to the fist, thumb towards it; a dashed ghost loop shows the size
//      of the loop to come (the first loop's real size, fitted as a circle); the hand slides out
//   3  über: back, the thumb rolls the cable forward (an arc arrow round the cable at the pads);
//      time stops, the outside camera swings to her side of the coil: "Kabel zum Boden: obenauf"
//   4  unter: out again, the hand turns over in slow motion (0.25×, "Zeitlupe", the arc round the
//      wrist), held: "Daumen nach außen"
//   5  back in slow motion, held where the loop hangs over the back of the hand ("Die Schlaufe
//      fällt über den Handrücken", "Sieht komisch aus – stimmt so."), on to the hand-over, time
//      stops: "Kabel zum Boden: drunter"; then the under loop once more in real time ("Echtzeit")
//   6  checking: the outside camera to the front of the ring (✓ "flach und rund", measured), her
//      view and the outside camera to the cable to the floor (✓ "ruhig", measured); then the short
//      ✗ comparison, two panels: the cable to the floor of a coil wound the same way every time
//      against over-under, four loops each (simulated: shots/p3-steps-twist.ts), a counter of the
//      turns in the cable (measured)
//   7  "Immer die andere Sorte." + the rule of thumb, then the last four loops sped up (1.5×,
//      "Zeitraffer"), the tally ü u ü u ü u fills
//   8  "Klettband drum – fertig.": the right hand fetches the end, the tie closes, the camera goes
//      to the front of the ring, ✓ (if the baked ring is round and flat: coil-world.ts ringCheck)
//
// Placeholder motion: the stage 1 coiling bake s1-coil (shots/s1-coil.ts, coil-engine.ts), held
// and slowed at each step. Every beat whose movement will come from a Kinect recording is listed in
// MOCAP_SLOTS (part time, seconds from the start of this part).
//
// Everything on screen is a function of one scene clock (tau): SEGS maps it to the bake's shot time
// (holds, slow motion, a jump back for the real-time replay), captions and labels are windows on it.

import { Layout, Node, Rect, Txt } from '@motion-canvas/2d';
import { easeInOutCubic } from '@motion-canvas/core';
import * as THREE from 'three';
import { BakedRod, V3, loadBake, quatRotate, smooth, twistTurns } from '../../sim';
import { COIL1, COIL1_TAIL } from '../../shots/s1-coil';
import { CoilController, REC, fitPlane, loopShape } from '../../shots/coil-engine';
import { GEOM, beats } from '../../shots/coiling';
import { TWIST, loopSign, loopStart } from '../../shots/p3-steps-twist';
import { J } from '../../people/people';
import { CAPTION_Y, GAP, PANEL_H, PanelTitle, TOP, clock, readTime, tally } from '../../lib/kit';
import { C, FONT, OVER, UNDER } from '../../lib/theme';
import { Mark, StageChip } from '../../lib/ui';
import { ArcArrow, GhostPath } from '../../three/arrows';
import { CableMesh } from '../../three/cable';
import { Orbit, makeCamera, mixOrbit, orbit } from '../../three/camera';
import { callout } from '../../three/overlay';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';
import { CoilWorld } from './coil-world';

// ===================================================================================== the plan

const B = beats(COIL1);
const END = new CoilController(COIL1, { fetchEnd: true }).endBeats();
/** the tie closes once the end is up beside the fist (shot times; as in stage 1) */
const TIE_T = { wrap0: END.fUp + 0.1, wrap1: END.fUp + 1.1, fold1: END.fUp + 1.7 };
const SHOT_END = END.fUp + COIL1_TAIL - 0.05;
/** time stops after each teaching loop: the strand lies in the fist, the cable to the floor hangs through the loop */
const F1 = B[0].tMeet + 0.22, F2 = B[1].tMeet + 0.22;
/** on the way back with the under loop: the loop hangs over the back of the hand (checked in the part) */
const T_WRIST = B[1].tTurned + 0.6 * (B[1].tAbove - B[1].tTurned);
/** the pair is done: check it */
const CHECK_T = B[1].t1;
/** the left-handers' note shows the third loop (an over loop at her natural pace) mirrored */
const LEFTY = { from: B[2].t0, to: B[2].t1 };
/** the comparison plays the twist shots this long (to 2.4 s after the last turn) */
const CMP_LEN = TWIST.first + (TWIST.loops - 1) * TWIST.period + TWIST.turn + 2.4;
const SLOW = 0.25;
const FAST = 1.5;
/** a freeze with a camera swing: out, hold, back [s] */
const SWING = { out: 1.4, hold: 3.8, back: 1.2 };
const SWING_LEN = SWING.out + SWING.hold + SWING.back;

interface Seg {
  id: string;
  /** scene seconds */
  len: number;
  /** shot time at its start and end (equal: time stands still) */
  from: number;
  to: number;
  /** scene time of its start */
  at: number;
}

const SEGS: Seg[] = [];
let sceneAt = 0;
const hold = (id: string, at: number, len: number) => {
  SEGS.push({ id, len, from: at, to: at, at: sceneAt });
  sceneAt += len;
};
const play = (id: string, from: number, to: number, speed = 1) => {
  const len = (to - from) / speed;
  SEGS.push({ id, len, from, to, at: sceneAt });
  sceneAt += len;
};

// 0 · left-handers
hold('open', LEFTY.from, 0.9);
hold('flip', LEFTY.from, 0.6);
play('lefty', LEFTY.from, LEFTY.to);
hold('unflip', LEFTY.to, 0.6);
hold('leftyEnd', LEFTY.to, 1.7);
hold('dipOut', LEFTY.to, 0.35);
hold('dipIn', 0, 0.35);
// 1 · the end in the left hand, the plug outside
hold('s1', 0, 6.4);
// 2 · the right hand pinches, thumb to the left hand; the ghost loop; slide out
hold('s2', 0, 5.6);
hold('s2ghost', B[0].t0, 1.6);
play('slide1', B[0].t0, B[0].tHeld);
hold('hip1', B[0].tHeld, 1.6);
// 3 · über: back, rolling forward; time stops at the hand-over
hold('s3cap', B[0].tHeld, 1.4);
play('back1', B[0].tHeld, F1);
hold('freeze1', F1, SWING_LEN);
play('give1', F1, B[1].t0);
// 4 · unter: out again, turn the hand over (slow motion), held turned
hold('s4cap', B[1].t0, 1.1);
play('slide2', B[1].t0, B[1].tHeld);
hold('hip2', B[1].tHeld, 1.1);
play('turn', B[1].tHeld, B[1].tTurned, SLOW);
hold('turned', B[1].tTurned, 3.4);
// 5 · back, turning back (slow motion): over the back of the hand, the hand-over, real time
hold('s5cap', B[1].tTurned, 1.4);
play('back2a', B[1].tTurned, T_WRIST, SLOW);
hold('wrist', T_WRIST, 4.6);
play('back2b', T_WRIST, F2, SLOW);
hold('freeze2', F2, SWING_LEN);
hold('dip2out', F2, 0.35);
hold('dip2in', B[1].t0, 0.35);
play('replay', B[1].t0, B[1].t1);
// 6 · check: flat and round, the cable to the floor calm; ✗ the comparison
hold('check1', CHECK_T, 5.8);
hold('check2', CHECK_T, 5.0);
hold('cmpIn', CHECK_T, 0.6);
hold('cmp', CHECK_T, CMP_LEN);
hold('cmpOut', CHECK_T, 0.6);
// 7 · always the other kind; four loops sped up
hold('s7a', CHECK_T, 3.8);
hold('s7b', CHECK_T, 1.8);
play('fast', B[2].t0, B[5].t1, FAST);
// 8 · the tie, done
hold('s8cap', B[5].t1, 1.0);
play('strap', B[5].t1, SHOT_END);
hold('done', SHOT_END, 4.6);
hold('out', SHOT_END, 0.6);

/** the part's length [s] */
export const LENGTH = sceneAt;

function seg(id: string): Seg {
  const s = SEGS.find((x) => x.id === id);
  if (!s) throw new Error(`p3-steps: no segment ${id}`);
  return s;
}
/** scene time where segment id starts / ends */
const S = (id: string) => seg(id).at;
const E = (id: string) => seg(id).at + seg(id).len;

/** the bake's shot time at scene time tau */
function shotAt(tau: number): number {
  let s = SEGS[0];
  for (const x of SEGS) {
    if (tau < x.at) break;
    s = x;
  }
  const u = s.len > 0 ? Math.min(1, Math.max(0, (tau - s.at) / s.len)) : 1;
  return s.from + (s.to - s.from) * u;
}

// ------------------------------------------------------------------------------------ captions

const CAPS: { text: string; a: number; b: number }[] = [
  { text: 'Du wickelst lieber mit links? Dann alles spiegeln.', a: S('open') + 0.3, b: E('leftyEnd') },
  { text: 'Nimm das Ende in die linke Hand, Handfläche oben.', a: S('s1') + 0.2, b: E('s1') },
  { text: 'Rechte Hand: Daumen zeigt zur linken Hand.', a: S('s2'), b: E('s2') },
  { text: 'Gleite etwa eine Armlänge nach außen.', a: S('s2ghost') + 0.1, b: E('hip1') },
  { text: 'Zurück, dabei mit dem Daumen nach vorn rollen.', a: S('s3cap'), b: S('freeze1') + 2.2 },
  { text: 'Dreh die rechte Hand um: Daumen zeigt nach außen.', a: S('s4cap'), b: E('turned') },
  { text: 'Zurück, dabei zurückdrehen.', a: S('s5cap'), b: E('back2a') },
  { text: 'Sieht komisch aus – stimmt so.', a: S('wrist') + 0.4, b: E('wrist') },
  { text: 'Prüfen: Fällt die Schlaufe flach und rund?', a: S('check1') + 0.2, b: E('check1') },
  { text: 'Hängt das Kabel zum Boden ruhig?', a: S('check2'), b: E('check2') },
  { text: 'Immer gleich gewickelt: Das Kabel zum Boden verdreht sich.', a: S('cmp') + 0.3, b: E('cmp') },
  { text: 'Immer die andere Sorte.', a: S('s7a') + 0.1, b: E('s7a') },
  { text: 'Lag das Kabel zum Boden eben obenauf? Dann jetzt drunter.', a: S('s7b'), b: E('fast') },
];
/** the last caption comes with the ✓ (its own row) */
const DONE_CAP = { text: 'Klettband drum – fertig.', a: S('s8cap'), b: E('done') };
const CAP_IN = 0.35, CAP_OUT = 0.3;

/** captions shorter than their reading time (characters / 12 + 1 s) or overlapping: printed when the part runs */
const captionProblems = (() => {
  const out: string[] = [];
  const all = [...CAPS, DONE_CAP];
  all.forEach((c, i) => {
    const visible = c.b - c.a - CAP_IN;
    if (visible < readTime(c.text) - 0.01) out.push(`"${c.text}" visible ${visible.toFixed(2)} s < ${readTime(c.text).toFixed(2)} s`);
    if (i > 0 && c.a < all[i - 1].b) out.push(`"${c.text}" overlaps the caption before`);
  });
  return out;
})();

// ------------------------------------------------------------------------------------ mocap

/**
 * Beats whose movement comes from a Kinect recording later (mocap/shots.json ids; times in part
 * seconds). Until then the stage 1 coiling bake plays there, held and slowed.
 */
export const MOCAP_SLOTS = [
  { shot: 'p3.lefty', role: 'Noor', from: S('flip'), to: E('unflip'), note: 'gespiegelte Ich-Ansicht, eine Schlaufe; p3.lefty ist freiwillig (Prio 3), sonst p1.coil.natural gespiegelt' },
  { shot: 'p3.start', role: 'Noor', from: S('s1'), to: E('hip1'), note: 'Ende in die linke Hand, Stecker außen; rechte Hand greift, Daumen zur linken; eine Armlänge nach außen, halten (Halte 1 und 2 von p3.pair.slow)' },
  { shot: 'p3.pair.slow', role: 'Noor', from: S('s3cap'), to: E('freeze2'), note: 'Über- und Unter-Schlaufe mit Halten: hold 3 = freeze1, 4 = turned, 5 = wrist, 6/7 = freeze2; Außenansicht; Zeitlupen aus der langsamen Aufnahme, nicht aus Zeitlupe des Lehrtempos' },
  { shot: 'p3.pair.slow.near', role: 'Noor', from: S('s3cap'), to: E('freeze2'), note: 'dieselben Halte, Hände nah: Finger (Rollen, Daumen nach außen) für die Ich-Ansicht und die Nahaufnahme der rechten Hand' },
  { shot: 'p1.coil.teach', role: 'Noor', from: S('replay'), to: E('replay'), note: 'die Unter-Schlaufe noch einmal in Echtzeit (Lehrtempo), Schnitt aus dem ersten Paar' },
  { shot: 'p3.check', role: 'Noor', from: S('check1'), to: E('check2'), note: 'Blick zum Ring, dann zum Kabel zum Boden (Kopf und Ich-Kamera folgen dem Blick)' },
  { shot: 'p3.wrong.same', role: 'Noor', from: S('cmpIn'), to: E('cmp'), note: '✗ nur Über-Schlaufen; im Rohschnitt nur das hängende Kabel (Simulation p3-steps-same), Noor nicht im Bild' },
  { shot: 'p1.coil.natural', role: 'Noor', from: S('fast'), to: E('fast'), note: 'vier Schlaufen im Arbeitstempo, gezeigt mit 1,5× (Zeitraffer)' },
  { shot: 'p4.close', role: 'Noor', from: S('s8cap'), to: E('done'), note: 'Ende holen, Klettband zu, Ring zeigen; p4.close ist als Jonas-Shot geplant und wird auf Noor übertragen; sonst das Ende von p1.coil.teach' },
];

// ===================================================================================== helpers

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
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

/**
 * The camera of the comparison panels: close on the hanging cable (its top inside the coil stays out
 * of the picture), on the side its stripe faced before the first loop, so the stripe starts as a
 * straight line towards the camera (both cables start the same)
 */
function twistCam(b: BakedRod): Orbit {
  const pos = new Float32Array(3 * b.n), d1 = new Float32Array(3 * b.n);
  b.frameSample(0, pos, d1);
  const i = 40;
  return { target: [0, 0.6, 0], yaw: Math.atan2(d1[3 * i], d1[3 * i + 2]), pitch: 0.42, dist: 0.55, fov: 34 };
}

/**
 * One comparison panel's world: the baked cable to the floor. No white glow here: seen this close and
 * from above, the halo (three/cable.ts) covers the hanging tube and hides its stripe; a label names it.
 */
function twistWorld(key: string, b: BakedRod, time: () => number) {
  const n = b.n;
  const pos = new Float32Array(3 * n), d1 = new Float32Array(3 * n);
  // (a wider stripe than elsewhere: it is what this close-up is about)
  const cable = new CableMesh({ maxNodes: n, radius: b.radius, plugStart: null, plugEnd: 'xlr-female', stripeWidth: 0.07 });
  const cam = makeCamera(34);
  const TWIST_CAM = twistCam(b);
  // the twist arrows (KONZEPT: curved 3D arrows for "Drall"): one ring round the cable per turn it
  // holds, measured (the twist of the whole cable below the coil), the last one partly drawn; they
  // turn the way the twist goes
  const rings = [0, 1, 2, 3].map(() => new ArcArrow({ color: '#3b3f46', thickness: 0.0022 }));
  const world = new World3D(key, () => {
    const tt = time();
    b.frameSample(tt, pos, d1);
    cable.update(pos, d1, n);
    const tw = b.track('twistAll', tt);
    rings.forEach((r, k) => {
      const u = Math.min(1, Math.max(0, Math.abs(tw) - k));
      r.group.visible = u > 0.02;
      if (u > 0.02) r.update({ center: [0, 0.74 - 0.075 * k, 0], axis: [0, Math.sign(tw) || 1, 0], from: [Math.sin(TWIST_CAM.yaw), 0, Math.cos(TWIST_CAM.yaw)], radius: 0.022, angle: (320 * Math.PI) / 180, progress: u });
    });
    orbit(cam, TWIST_CAM);
  });
  new Studio(world.scene, { focus: [0.5, 0.2, -0.6], focusRadius: 1.3 });
  world.scene.add(cable.group, ...rings.map((r) => r.group));
  return { world, cam };
}

// ===================================================================================== the part

export function* part(layer: Node) {
  const bake = (yield loadBake('s1-coil')) as BakedRod;
  const same = (yield loadBake('p3-steps-same')) as BakedRod;
  const alt = (yield loadBake('p3-steps-alt')) as BakedRod;
  for (const p of captionProblems) console.warn('p3-steps caption:', p);

  const { tau, run } = clock(LENGTH);
  const t = () => shotAt(tau());
  /** 0 → 1 → 0 between scene times a and b (fading in and out) */
  const win = (a: number, b: number, fi = 0.35, fo = 0.35) => {
    const s = tau();
    return smooth((s - a) / Math.max(1e-6, fi)) * (1 - smooth((s - (b - fo)) / Math.max(1e-6, fo)));
  };
  /** 0 → 1 → 1 → 0 over a freeze segment (camera swing out, hold, back) */
  const swingOf = (id: string) => {
    const a = S(id), s = tau();
    if (s < a || s > E(id)) return 0;
    const u = s - a;
    if (u < SWING.out) return easeInOutCubic(u / SWING.out);
    if (u > SWING_LEN - SWING.back) return easeInOutCubic((SWING_LEN - u) / SWING.back);
    return 1;
  };
  /** the hold part of a freeze (labels): after the swing out, before the swing back */
  const freezeHold = (id: string) => win(S(id) + SWING.out - 0.1, E(id) - SWING.back + 0.1, 0.4, 0.3);

  // ------------------------------------------------------------------------- the 3D world (stage 1's)
  const gripL = (tt: number) => bake.frame('gripL', tt).p as V3;
  const gripR = (tt: number) => bake.frame('gripR', tt);
  const glF = gripL(F1);
  const coilAt: V3 = [glF[0] + 0.02, glF[1] - 0.12, glF[2]];
  const gl0 = gripL(0);

  // cameras of the outside view
  const EXT: Orbit = { target: [0.08, 0.8, -0.3], yaw: Math.PI - 0.42, pitch: 0.3, dist: 1.2, fov: 40 };
  /** close on the left hand, the plug and the right hand next to it */
  const CLOSE: Orbit = { target: [gl0[0] + 0.08, gl0[1] - 0.03, gl0[2] + 0.02], yaw: Math.PI - 0.5, pitch: 0.32, dist: 0.72, fov: 40 };
  /** a freeze: from Noor's side of the coil, behind and above her left hand, looking along its axis N (as in stage 1) */
  const freezeCam = (k: number, at: number): Orbit => {
    const c = cw.crossPoint(k, at);
    return { target: [0.5 * (c[0] + coilAt[0]), 0.5 * (c[1] + coilAt[1]) + 0.02, 0.5 * (c[2] + coilAt[2])], yaw: Math.atan2(-GEOM.N[0], -GEOM.N[2]), pitch: 0.62, dist: 0.78, fov: 38 };
  };
  let slowBase: Orbit | null = null;
  /** close on the right hand while it turns over and comes back with the loop over it (follows the pads) */
  const slowCam = (): Orbit => {
    if (!slowBase) {
      const pose = cw.replay.pose(B[1].tTurned);
      const w = pose.joints[J.rightWrist], e = pose.joints[J.rightElbow];
      const fa = norm3(sub3(w, e));
      const outside = norm3([w[0], 0, w[2] + 0.1]);
      const o = norm3([-fa[0] + 0.9 * outside[0], -fa[1] + 0.35, -fa[2] + 0.9 * outside[2]]);
      slowBase = { target: [w[0], w[1], w[2]], yaw: Math.atan2(o[0], o[2]), pitch: Math.asin(Math.max(-0.2, Math.min(0.9, o[1]))), dist: 0.66, fov: 40 };
    }
    const g = gripR(t()).p;
    return { ...slowBase, target: [g[0], g[1] + 0.04, g[2]] };
  };
  /** the middle of loops 1 … k at shot time tt (their best-fit centres) */
  const ringCentre = (k: number, tt: number): V3 => {
    const c: V3 = [0, 0, 0];
    for (let j = 1; j <= k; j++) {
      const [a, e] = cw.loopNodes(j);
      const P: V3[] = [];
      for (let i = a; i <= e; i++) P.push(cw.at(i, tt));
      const f = fitPlane(P).c;
      for (let m = 0; m < 3; m++) c[m] += f[m] / k;
    }
    return c;
  };
  /** the coil face-on, a little towards her front and from above (the floor behind it, not her trousers) */
  const faceOn = (c: V3, dist: number): Orbit => ({ target: c, yaw: Math.atan2(GEOM.N[0], GEOM.N[2]) + 0.35, pitch: 0.42, dist, fov: 38 });

  // the cable to the floor after the pair: from the right hand down to where it touches the floor
  const hangInfo = (() => {
    const tt = CHECK_T;
    const n = bake.n;
    const pos = new Float32Array(3 * n), q = new Float32Array(4 * (n - 1));
    bake.sample(tt, pos, q);
    // (s1-coil: cw is not built yet; the floor cable starts past the pads)
    const sPads = bake.track('sPads', tt), seg = bake.track('seg', 0) || 0.0075;
    const i0 = Math.min(n - 2, Math.round(sPads / seg) + 2);
    let i1 = i0;
    while (i1 < n - 1 && pos[3 * i1 + 1] > 0.02) i1++;
    const top: V3 = [pos[3 * i0], pos[3 * i0 + 1], pos[3 * i0 + 2]];
    const low: V3 = [pos[3 * i1], pos[3 * i1 + 1], pos[3 * i1 + 2]];
    const mid = Math.round((i0 + i1) / 2);
    const midP: V3 = [pos[3 * mid], pos[3 * mid + 1], pos[3 * mid + 2]];
    // calm: how fast it moves (over the last 1/30 s), how much it is twisted
    const prev = new Float32Array(3 * n), q2 = new Float32Array(4 * (n - 1));
    bake.sample(tt - 1 / 30, prev, q2);
    let vmax = 0;
    for (let i = i0; i < n; i++) vmax = Math.max(vmax, Math.hypot(pos[3 * i] - prev[3 * i], pos[3 * i + 1] - prev[3 * i + 1], pos[3 * i + 2] - prev[3 * i + 2]) * 30);
    const twist = twistTurns(q, i0, Math.max(i0 + 1, i1 - 1));
    return { i0, i1, top, low, midP, vmax, twist, length: (i1 - i0) * seg };
  })();
  const HANG_CAM: Orbit = { target: [hangInfo.midP[0] - 0.05, hangInfo.midP[1] - 0.05, hangInfo.midP[2]], yaw: Math.PI - 0.85, pitch: 0.12, dist: 1.45, fov: 40 };

  /** the outside camera: keys in scene time, each blending from the one before over `dur` */
  const camKeys: { at: number; dur: number; cam: () => Orbit }[] = [
    { at: 0, dur: 0, cam: () => EXT },
    { at: S('dipIn'), dur: 0, cam: () => CLOSE },
    { at: S('s2ghost') - 0.2, dur: 1.4, cam: () => EXT },
    { at: S('freeze1'), dur: SWING.out, cam: () => freezeCam(1, F1) },
    { at: E('freeze1') - SWING.back, dur: SWING.back, cam: () => EXT },
    { at: S('hip2'), dur: 1.0, cam: slowCam },
    { at: S('freeze2'), dur: SWING.out, cam: () => freezeCam(2, F2) },
    { at: S('dip2in'), dur: 0, cam: () => EXT },
    { at: S('check1'), dur: 1.3, cam: () => (CHECK_CAM ??= faceOn(ringCentre(2, CHECK_T), 0.85)) },
    { at: S('check2'), dur: 1.3, cam: () => HANG_CAM },
    { at: S('cmpOut'), dur: 0, cam: () => EXT },
    { at: E('strap') - 0.4, dur: 2.4, cam: () => (END_CAM ??= faceOn(ringCentre(6, SHOT_END), 0.95)) },
  ];
  const camOut: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
  let CHECK_CAM: Orbit | null = null, END_CAM: Orbit | null = null;
  const ext = (): Orbit => {
    extras();
    const s = tau();
    let i = 0;
    for (let k = 0; k < camKeys.length; k++) if (s >= camKeys[k].at) i = k;
    const k = camKeys[i];
    const u = k.dur > 0 ? easeInOutCubic(clamp01((s - k.at) / k.dur)) : 1;
    if (u >= 1 || i === 0) return k.cam();
    return mixOrbit(camKeys[i - 1].cam(), k.cam(), u, camOut);
  };

  /** her view looks between and below her hands (as in stage 1), during the check at the ring, then at the cable to the floor */
  const glC = gripL(CHECK_T);
  const ringLook: V3 = [glC[0] + 0.03, glC[1] - 0.17, glC[2] - 0.03];
  const look = (tt: number): V3 => {
    const g = gripL(tt), r = gripR(tt).p;
    const base: V3 = [g[0] + 0.4 * (r[0] - g[0]) + 0.04, Math.min(g[1], r[1]) - 0.24, g[2] + 0.4 * (r[2] - g[2]) - 0.06];
    const s = tau();
    const w1 = smooth((s - S('check1')) / 1.0) * (1 - smooth((s - S('check2')) / 1.0));
    const w2 = smooth((s - S('check2')) / 1.0) * (1 - smooth((s - S('cmpIn')) / 0.6));
    return mixV(mixV(base, ringLook, w1), hangInfo.midP, w2);
  };

  // the cable's highlights: the cable to the floor white, the crossing's rim, during the freezes and the check
  const glow = () => {
    const a = swingOf('freeze1'), b = swingOf('freeze2'), c = win(S('check2') + 0.6, E('check2'), 0.5, 0.4);
    if (a > 0) return { k: 1, on: a };
    if (b > 0) return { k: 2, on: b };
    if (c > 0) return { k: 2, on: c };
    return null;
  };

  const cw: CoilWorld = new CoilWorld('p3-steps', bake, COIL1, {
    t,
    ext,
    look,
    xray: () => Math.max(swingOf('freeze1'), swingOf('freeze2')),
    glow,
    // the arc round the wrist while the hand turns over for the first "unter", as far as it really turns
    arrow: (): number | null => {
      const tt = t(), b = B[1];
      const s = tau();
      if (s < S('hip2') || s > E('turned') + 0.2) return null;
      if (tt < b.tHeld - 0.05) return null;
      return cw.replay.at(Math.min(tt, b.tTurned)).turn;
    },
    // the tie hangs on the cable next to the plug from the start, and closes at the end
    tie: () => {
      const tt = t();
      if (tt < TIE_T.wrap0) return { wrap: 0, fold: 0 };
      return { wrap: smooth((tt - TIE_T.wrap0) / (TIE_T.wrap1 - TIE_T.wrap0)), fold: smooth((tt - TIE_T.wrap1) / (TIE_T.fold1 - TIE_T.wrap1)) };
    },
  });

  // ------------------------------------------------------------------------- what is true (measured on the bake)
  const cross = [cw.crossing(1, F1), cw.crossing(2, F2)];
  const overTrue = cross[0] !== null && cross[0].depth < 0;
  const underTrue = cross[1] !== null && cross[1].depth > 0;
  // the right hand at the start: the thumb (the pads' d3: where the cable leaves past the thumb tip) points to the left hand
  const g0 = gripR(0);
  const thumbDir = quatRotate(g0.q, [0, 0, 1]);
  const thumbToLeft = dot3(thumbDir, norm3(sub3(gl0, g0.p as V3)));
  // turned over: the thumb side of the wrist points away from her (out), the palm up?
  const poseT = cw.replay.pose(B[1].tTurned);
  const handT = poseT.body.hands[1], armT = poseT.body.arms![1];
  const pelv = poseT.joints[J.pelvis], wr = poseT.joints[J.rightWrist];
  const outward = norm3([wr[0] - pelv[0], 0, wr[2] - pelv[2]]);
  const thumbOut = dot3(armT.forearm.wristAxis, outward);
  const palmUp = handT.palm[1];
  // the loop over the back of the hand: loop 2's cable within 4.5 cm of the wrist or the knuckles, above the wrist
  const overWrist = (tt: number) => {
    const pose = cw.replay.pose(tt), w = pose.joints[J.rightWrist], h = pose.joints[J.rightHand];
    const a = cw.node(cw.sEdge[1]) + 1, e = cw.node(cw.sEdge[2]) - 1;
    let n = 0;
    for (let i = a; i <= e; i++) {
      const p = cw.at(i, tt);
      const d = Math.min(Math.hypot(p[0] - w[0], p[1] - w[1], p[2] - w[2]), Math.hypot(p[0] - h[0], p[1] - h[1], p[2] - h[2]));
      if (d < 0.045 && p[1] > w[1] - 0.01) n++;
    }
    return n;
  };
  let bestWrist = { t: T_WRIST, n: -1 };
  for (let tt = B[1].tTurned; tt <= B[1].tMeet; tt += 0.05) {
    const n = overWrist(tt);
    if (n > bestWrist.n) bestWrist = { t: +tt.toFixed(2), n };
  }
  const wristNodes = overWrist(T_WRIST);
  const wristTrue = wristNodes >= 3;
  // the pair: flat and round (each loop's free part: width/height ≥ 0.6, rms off its plane < 1.5 cm, its plane within 25° of the coil's)
  const pairCheck = [1, 2].map((k) => {
    const [a, e] = cw.loopNodes(k);
    const P: V3[] = [];
    for (let i = a; i <= e; i++) P.push(cw.at(i, CHECK_T));
    const { c, n } = fitPlane(P);
    const rms = Math.sqrt(P.reduce((s, p) => s + dot3(sub3(p, c), n) ** 2, 0) / P.length);
    const sh = loopShape(P, gripL(CHECK_T)[1]);
    const angle = (Math.acos(Math.min(1, Math.abs(dot3(n, GEOM.N)))) * 180) / Math.PI;
    return { k, aspect: +(sh.width / sh.height).toFixed(2), width: +sh.width.toFixed(3), rms: +(rms * 1000).toFixed(1), angle: +angle.toFixed(0) };
  });
  const flatRound = pairCheck.every((l) => l.aspect >= 0.6 && l.rms < 15 && l.angle < 25);
  const calm = hangInfo.vmax < 0.1 && Math.abs(hangInfo.twist) < 1;
  const ring = cw.ringCheck(SHOT_END);
  // the comparison: what the cable holds after the four loops (measured)
  const cmpEnd = CMP_LEN - 0.05;
  const cmp = {
    same: { in: same.track('turnsIn', cmpEnd), hang: same.track('twistHang', cmpEnd), all: same.track('twistAll', cmpEnd), far: same.track('twistFar', cmpEnd) },
    alt: { in: alt.track('turnsIn', cmpEnd), hang: alt.track('twistHang', cmpEnd), all: alt.track('twistAll', cmpEnd), far: alt.track('twistFar', cmpEnd) },
  };
  // the roll the thumb gives on the way back of the over loop (recorded)
  const recV = bake.vector('rec', 0.5 * (B[0].tHeld + B[0].tAbove)) as number[];
  console.log('p3-steps checks', JSON.stringify({
    segs: SEGS.map((x) => `${x.id} ${x.at.toFixed(2)}`).join(' | '),
    length: +LENGTH.toFixed(2),
    overTrue, underTrue, cross,
    thumbToLeft: +thumbToLeft.toFixed(2), thumbOut: +thumbOut.toFixed(2), palmUp: +palmUp.toFixed(2),
    wrist: { at: T_WRIST, nodes: wristNodes, best: bestWrist, ok: wristTrue },
    pairCheck, flatRound,
    hang: { vmax: +hangInfo.vmax.toFixed(3), twist: +hangInfo.twist.toFixed(2), length: +hangInfo.length.toFixed(2), calm },
    ring: { ok: ring.ok, loops: ring.loops.map((l) => [+l.aspect.toFixed(2), +(l.thickness * 1000).toFixed(1), +((l.angle * 180) / Math.PI).toFixed(0)]) },
    cmp, rollOver: +recV[REC.H + 2].toFixed(2), captionProblems,
  }));

  // ------------------------------------------------------------------------- extra 3D: ghost loop, roll arrow
  // the ghost loop: the first loop's real size and plane (a circle fitted to it once laid), hanging from the fist
  const ghostT = B[0].t1;
  const ghostFit = (() => {
    const [a, e] = cw.loopNodes(1);
    const P: V3[] = [];
    for (let i = a; i <= e; i++) P.push(cw.at(i, ghostT));
    const { c, n } = fitPlane(P);
    const up = norm3(sub3([0, 1, 0], [n[0] * n[1], n[1] * n[1], n[2] * n[1]]));
    const w = cross3(n, up);
    let R = 0;
    for (const p of P) {
      const d = sub3(p, c);
      R += Math.hypot(dot3(d, up), dot3(d, w));
    }
    R /= P.length;
    return { c, up, w, R, at: gripL(ghostT) };
  })();
  console.log('p3-steps ghost loop', JSON.stringify({ diameter: +(2 * ghostFit.R).toFixed(3) }));
  const GN = 97;
  const ghostPts = new Float32Array(3 * GN);
  const ghostDark = new GhostPath({ maxPoints: GN, radius: 0.0042, color: '#2b2f36', dash: 0.03, opacity: 0.75 });
  const ghostLight = new GhostPath({ maxPoints: GN, radius: 0.0027, color: '#ffffff', dash: 0.03, opacity: 0.95 });
  ghostDark.mesh.renderOrder = 5;
  ghostLight.mesh.renderOrder = 6;
  const rollArrow = new ArcArrow({ color: OVER, thickness: 0.003 });
  cw.world.scene.add(ghostDark.mesh, ghostLight.mesh, rollArrow.group);
  const ghostOn = () => win(S('s2ghost'), S('back1') + 1.2, 0.6, 0.8);
  const rollOn = () => win(S('s3cap') + 0.2, S('freeze1') + 0.2, 0.3, 0.3);
  /** updates the ghost loop and the roll arrow (inside the world's update: called from ext()) */
  function extras() {
    const tt = t();
    const g = ghostOn();
    ghostDark.mesh.visible = ghostLight.mesh.visible = g > 0.01;
    if (g > 0.01) {
      const off = sub3(gripL(tt), ghostFit.at);
      const { c, up, w, R } = ghostFit;
      for (let i = 0; i < GN; i++) {
        const ph = (i / (GN - 1)) * Math.PI * 2;
        const cs = Math.cos(ph), sn = Math.sin(ph);
        for (let k = 0; k < 3; k++) ghostPts[3 * i + k] = c[k] + off[k] + R * (up[k] * cs + w[k] * sn);
      }
      ghostDark.update(ghostPts, GN);
      ghostLight.update(ghostPts, GN);
      (ghostDark.mesh.material as THREE.MeshBasicMaterial).opacity = 0.75 * g;
      (ghostLight.mesh.material as THREE.MeshBasicMaterial).opacity = 0.95 * g;
    }
    const r = rollOn();
    rollArrow.group.visible = r > 0.01;
    if (r > 0.01) {
      const f = gripR(tt);
      const d3 = quatRotate(f.q, [0, 0, 1]);
      const c: V3 = [f.p[0] + d3[0] * 0.06, f.p[1] + d3[1] * 0.06, f.p[2] + d3[2] * 0.06];
      // (over: the thumb rolls the cable forward, a positive roll about the cable's d3: GEOM.roll)
      const prog = smooth((tau() - S('s3cap') - 0.2) / 1.0);
      rollArrow.update({ center: c, axis: d3, from: [0, 1, 0], radius: 0.026, angle: 2.4 * Math.sign(GEOM.roll), progress: prog * r });
    }
  }

  // ------------------------------------------------------------------------- the comparison worlds
  const cmpT = () => Math.min(CMP_LEN, Math.max(0, tau() - S('cmp')));
  const twA = twistWorld('p3-steps-same', same, cmpT);
  const twB = twistWorld('p3-steps-alt', alt, cmpT);

  // ------------------------------------------------------------------------- the picture
  const cmpOp = () => win(S('cmpIn'), E('cmpOut'), 0.6, 0.6);
  const dip = () => Math.max(win(S('dipOut'), E('dipIn'), 0.35, 0.35), win(S('dip2out'), E('dip2in'), 0.35, 0.35));
  const mainOp = () => (1 - cmpOp()) * (1 - dip()) * smooth(tau() / 0.5);
  const flipU = () => {
    const s = tau();
    if (s < S('flip') || s > E('unflip')) return 0;
    if (s < E('flip')) return (s - S('flip')) / (E('flip') - S('flip'));
    if (s < S('unflip')) return 1;
    return 1 - (s - S('unflip')) / (E('unflip') - S('unflip'));
  };
  const mirrorX = () => Math.cos(Math.PI * easeInOutCubic(clamp01(flipU())));
  const leftyW = () => win(S('flip'), E('unflip'), 0.5, 0.5);

  // everything goes into one node that fades out at the end
  const root = new Node({ opacity: () => 1 - smooth((tau() - S('out')) / 0.6) });
  layer.add(root);
  const povView = (
    <ThreeView world={cw.world} camera={cw.povCam} x={xL + wL / 2} y={midY} width={wL} height={PANEL_H} radius={28} scale={() => [mirrorX(), 1]} opacity={mainOp} />
  ) as ThreeView;
  const extView = (
    <ThreeView world={cw.world} camera={cw.extCam} x={xR + wR / 2} y={midY} width={wR} height={PANEL_H} radius={28} opacity={() => mainOp() * (1 - 0.6 * leftyW())} />
  ) as ThreeView;
  root.add([povView, extView]);
  const titles = new Node({ opacity: () => 1 - cmpOp() });
  titles.add([<PanelTitle text={'So siehst du es'} x={xL + 24} />, <PanelTitle text={'Von außen'} x={xR + 24} />]);
  root.add(titles);

  // the comparison panels
  const cmpNode = new Node({ opacity: cmpOp });
  const cmpViews = [
    (<ThreeView world={twA.world} camera={twA.cam} x={xC[0] + wC / 2} y={midY} width={wC} height={PANEL_H} radius={28} />) as ThreeView,
    (<ThreeView world={twB.world} camera={twB.cam} x={xC[1] + wC / 2} y={midY} width={wC} height={PANEL_H} radius={28} />) as ThreeView,
  ];
  cmpNode.add(cmpViews);
  const cmpBakes = [same, alt];
  [0, 1].forEach((i) => {
    const good = i === 1;
    cmpNode.add(
      <Rect x={xC[i] + 24} y={TOP + 24} offset={[-1, -1]} padding={[8, 22, 8, 12]} radius={40} fill={C.plate} layout alignItems={'center'} gap={12}>
        <Mark good={good} size={40} />
        <Txt text={good ? 'Abwechselnd' : 'Immer gleich'} fontFamily={FONT} fontWeight={700} fontSize={32} fill={C.text} />
      </Rect>,
    );
    const kinds = Array.from({ length: TWIST.loops }, (_, k) => (loopSign(good, k + 1) > 0 ? 'over' : 'under') as 'over' | 'under');
    tally(cmpNode, kinds, (k) => smooth((cmpT() - loopStart(k + 1)) / 0.3), xC[i] + wC - 24, TOP + 24);
    // the turns in the cable to the floor, measured (twist of the whole cable below the coil)
    const b = cmpBakes[i];
    cmpNode.add(
      <Rect x={xC[i] + wC / 2} y={TOP + PANEL_H - 40} offset={[0, 1]} padding={[10, 26]} radius={36} fill={C.plate} layout>
        <Txt text={() => `Drehungen im Kabel: ${Math.abs(Math.round(b.track('twistAll', cmpT())))}`} fontFamily={FONT} fontWeight={700} fontSize={36} fill={C.text} />
      </Rect>,
    );
  });
  root.add(cmpNode);
  // (one label names what the panels show; the white glow is the cable to the floor everywhere in the video)
  root.add(callout({ view: cmpViews[0], target: () => same.nodeAt(Math.max(0, tau() - S('cmp')), 30, [0, 0, 0]), at: [xC[0] + 250, TOP + 200], text: 'Kabel zum Boden', size: 34, arrow: true, opacity: () => cmpOp() * (1 - smooth((tau() - S('cmp') - 4) / 0.5)) }));

  root.add(<StageChip current={3} x={0} y={TOP + PANEL_H + 34} />);

  // tally: one letter per laid loop (not during the left-handers' preview)
  const placed = (i: number) => smooth((t() - B[i].tMeet) / 0.25);
  const tal = tally(root, COIL1.kinds, placed);
  tal.opacity(() => mainOp() * smooth((tau() - S('s1')) / 0.4));

  // badges over her view
  const bx = xL + wL / 2;
  const slowOn = () => Math.max(win(S('turn'), E('turn'), 0.2, 0.2), win(S('back2a'), E('back2b'), 0.2, 0.2));
  badge(root, 'Zeitlupe', slowOn, bx);
  badge(root, 'gespiegelt', () => win(S('flip') + 0.3, E('unflip') - 0.3, 0.3, 0.3), bx);
  badge(root, 'Echtzeit', () => win(S('replay'), E('replay') + 0.2, 0.3, 0.4), bx);
  badge(root, 'Zeitraffer 1,5×', () => win(S('fast'), E('fast'), 0.3, 0.3), bx);

  // ------------------------------------------------------------------------- labels where it happens
  const label = (o: { view: ThreeView; target: () => V3; at: [number, number]; text: string; color?: string; on: () => number }) =>
    root.add(callout({ view: o.view, target: o.target, at: o.at, text: o.text, color: o.color, size: 34, arrow: true, opacity: o.on }));
  // 1: the plug sticks out of the fist (her view)
  label({ view: povView, target: () => cw.at(4, t()), at: [xL + 470, TOP + 150], text: 'Stecker bleibt außerhalb des Rings', on: () => win(S('s1') + 1.6, E('s1'), 0.4, 0.3) });
  // 2: the thumb towards the left hand (her view)
  if (thumbToLeft > 0.3) label({ view: povView, target: () => gripR(t()).p as V3, at: [xL + 640, TOP + 600], text: 'Daumen zur linken Hand', on: () => win(S('s2') + 1.4, E('s2'), 0.4, 0.3) });
  // 3: über (outside, from her side, while time stands still)
  if (overTrue) label({ view: extView, target: () => cw.floorPoint(1, t()) ?? cw.crossPoint(1, t()), at: [xR + wR / 2, TOP + PANEL_H - 90], text: 'Kabel zum Boden: obenauf', color: OVER, on: () => freezeHold('freeze1') });
  // 4: turned over (outside, close on the hand)
  const thumbTip = (): V3 => {
    const pose = cw.replay.pose(t());
    const h = pose.body.hands[1], wa = pose.body.arms![1].forearm.wristAxis;
    return [0, 1, 2].map((k) => h.wrist[k] + h.q * (h.fd[k] * h.thumb[0] + h.palm[k] * h.thumb[1] + wa[k] * h.thumb[2])) as V3;
  };
  if (thumbOut > 0.3) label({ view: extView, target: thumbTip, at: [xR + wR / 2, TOP + 150], text: 'Daumen nach außen', on: () => win(S('turned') + 0.3, E('turned'), 0.4, 0.3) });
  if (palmUp > 0.3) label({ view: extView, target: () => cw.replay.pose(t()).joints[J.rightHand], at: [xR + wR / 2, TOP + PANEL_H - 110], text: 'Handfläche oben', on: () => win(S('turned') + 0.8, E('turned'), 0.4, 0.3) });
  // 5: the loop over the back of the hand (her view), then unter (outside, from her side)
  if (wristTrue) label({ view: povView, target: () => cw.replay.pose(t()).joints[J.rightWrist], at: [xL + wL / 2, TOP + 130], text: 'Die Schlaufe fällt über den Handrücken', on: () => win(S('wrist') + 0.2, E('wrist'), 0.4, 0.3) });
  if (underTrue) label({ view: extView, target: () => cw.floorPoint(2, t()) ?? cw.crossPoint(2, t()), at: [xR + wR / 2, TOP + PANEL_H - 90], text: 'Kabel zum Boden: drunter', color: UNDER, on: () => freezeHold('freeze2') });
  // 6: the check (outside)
  if (flatRound) label({ view: povView, target: () => cw.crossPoint(2, t()), at: [xL + wL / 2 + 160, TOP + PANEL_H - 110], text: '✓ flach und rund', on: () => win(S('check1') + 1.8, E('check1'), 0.4, 0.3) });
  if (calm) label({ view: extView, target: () => hangInfo.midP, at: [xR + wR / 2 - 120, TOP + 160], text: '✓ ruhig', on: () => win(S('check2') + 1.6, E('check2'), 0.4, 0.3) });

  // ------------------------------------------------------------------------- captions
  const capNow = () => {
    const s = tau();
    for (const c of CAPS) if (s >= c.a && s <= c.b) return { text: c.text, op: smooth((s - c.a) / CAP_IN) * (1 - smooth((s - (c.b - CAP_OUT)) / CAP_OUT)) };
    return { text: '', op: 0 };
  };
  root.add(<Txt y={CAPTION_Y} text={() => capNow().text} opacity={() => capNow().op} fontFamily={FONT} fontWeight={600} fontSize={46} fill={C.text} />);
  // the last one with the ✓ (if the finished ring is round and flat)
  const doneOn = () => win(DONE_CAP.a, DONE_CAP.b, CAP_IN, CAP_OUT);
  root.add(
    <Layout layout direction={'row'} alignItems={'center'} gap={20} y={CAPTION_Y} opacity={doneOn}>
      <Mark good size={58} opacity={() => (ring.ok ? smooth((tau() - E('strap') - 0.3) / 0.4) : 0)} />
      <Txt text={DONE_CAP.text} fontFamily={FONT} fontWeight={600} fontSize={46} fill={C.text} />
    </Layout>,
  );

  yield* run();

  layer.removeChildren();
  cw.world.dispose();
  twA.world.dispose();
  twB.world.dispose();
}
