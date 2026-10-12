// Stage 6 (KONZEPT "6 · Dicke Kabel"): the rough animation (animatic). Every beat, caption, label,
// camera, arrow and counter in place; Mai's and Ada's bodies from simple keyframes
// (shots/p6-thick-rig.ts) on exactly the frames the simulation used; the recorded movements
// (MOCAP_SLOTS) replace them later.
//
//   1  Mai coils 15 m of 5G2.5 alone over-under, loops Ø ≈ 40 cm (her view | outside); the finished
//      ring, carried close to the body: "Trag den Ring nah am Körper."
//   2  25 m of 5G16 (≈ 40 kg): a loop in her hands springs open again (slow motion, then real time):
//      ✗ too heavy, too stiff. "Sehr dicke Kabel: auf dem Boden in Achten legen." Her view down |
//      from above: every eight one loop clockwise and one counter-clockwise (↻ ↺), the stripe stays
//      calm. "Hier ist die Acht gewollt: flach auf dem Boden." The bend radius gauge: "Biegeradius
//      mindestens 10 × Kabeldicke."
//   3  two velcro straps round the stack
//   4  carrying: Mai and Ada lift it together from a squat, Mai counts with her hand (3, 2, 1).
//      "Schwer? Zu zweit tragen. Eine Person sagt an." · "Aus der Hocke, Rücken gerade, Last nah am
//      Körper."
//   5  unrolling (where the stack has been carried to): "Oben abziehen, eine Schlaufe nach der anderen."
//      (KONZEPT has 3 before 4: here the stack is first carried and then unrolled, so that the
//      strapped stack is the one they carry; see the report.)
//
// Cables: simulated with the presets POWER_5G2_5 and POWER_5G16 (shots/p6-thick.ts); the straps are
// kinematic, the carried stack is the simulated stack's last frame moved rigidly (with a little
// sag). Everything on screen is a function of one scene clock (tau): SEGS map it to a shot and its
// time (holds, slow motion, time-lapse, cuts back for real-time replays).

import { Layout, Node, Rect, Txt } from '@motion-canvas/2d';
import { easeInOutCubic } from '@motion-canvas/core';
import * as THREE from 'three';
import { BakedRod, Frame, POWER_5G16, POWER_5G2_5, V3, loadBake, smooth } from '../../sim';
import { CAPTION_Y, GAP, PANEL_H, PanelTitle, TOP, clock, readTime, splitPerson, viewLayers } from '../../lib/kit';
import { C, FONT, OVER, UNDER } from '../../lib/theme';
import { Mark, StageChip } from '../../lib/ui';
import { ADA, MAI } from '../../people/cast';
import { Rig, RigTrack, eyesOfRig } from '../../people/rig';
import { COIL, COIL_T, EIGHTS_T, FAIL_T, RING_T, STACK, UNROLL_T, coilBeat, coilFist, depositAt, depositTime, eightStart, lobeCentre, ringFist, stackPlane, stackWorld } from '../../shots/p6-thick';
import { CARRY, CARRY_T, STRAPS_T, STRAP_AT, carryCount, carryOffset, carryRig, coilRig, eightsRig, failRig, ringRig, strapsRig, unrollRig } from '../../shots/p6-thick-rig';
import { ArcArrow, GhostPath } from '../../three/arrows';
import { CableMesh } from '../../three/cable';
import { Orbit, makeCamera, mixOrbit, orbit, povFollow } from '../../three/camera';
import { callout } from '../../three/overlay';
import { StrapMesh } from '../../three/strap';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';

// ===================================================================================== the plan

type Shot = 'coil' | 'ring' | 'fail' | 'eights' | 'straps' | 'carry' | 'unroll';
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
  /** a continuous take (a cut starts a new one): the people's arms are solved per take */
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

/** the first eight laid in the shot ends here (shot time), the second one here */
const E4 = depositTime(eightStart(STACK.before + 1));
const E5 = depositTime(eightStart(STACK.before + 2));

// 1 · coil the 5G2.5 (her view | outside), then the finished ring carried close to the body
hold('cIn', 'coil', 0, 0.9);
play('coil', 'coil', 0, COIL_T.end);
cut();
hold('rIn', 'ring', 0, 0.7);
play('ring', 'ring', 0, RING_T.end);
// 2 · the 5G16 in the hands: the loop springs open (slow motion, then once in real time)
cut();
play('fIn', 'fail', 0.9, FAIL_T.letGo - 0.15);
play('fSlow', 'fail', FAIL_T.letGo - 0.15, FAIL_T.letGo + 0.75, SLOW);
play('fRest', 'fail', FAIL_T.letGo + 0.75, FAIL_T.down1 + 0.3);
cut();
play('fReal', 'fail', FAIL_T.letGo - 0.8, FAIL_T.letGo + 1.3);
//   … on the floor in figure eights (her view down | from above), the second eight in time-lapse
cut();
hold('eIn', 'eights', 0, 0.7);
play('e4', 'eights', 0, E4 + 0.2);
play('e5', 'eights', E4 + 0.2, E5, 2);
play('eEnd', 'eights', E5, EIGHTS_T.end);
hold('gauge', 'eights', EIGHTS_T.end, 5.4);
// 3 · two straps; 4 · carrying together
cut();
play('straps', 'straps', 0, STRAPS_T.end);
cut();
play('carry', 'carry', 0, CARRY_T.end);
// 5 · unrolling: off the top, one loop after the other
cut();
hold('uIn', 'unroll', 0, 0.7);
play('unroll', 'unroll', 0, UNROLL_T.end);
hold('out', 'unroll', UNROLL_T.end, 0.8);

/** the part's length [s] */
export const LENGTH = sceneAt;

function seg(id: string): Seg {
  const s = SEGS.find((x) => x.id === id);
  if (!s) throw new Error(`p6-thick: no segment ${id}`);
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
/** the first and last scene time of a take */
const takeStart = (k: number) => (SEGS.find((x) => x.take === k) ?? SEGS[0]).at;
const takeEnd = (k: number) => {
  const l = SEGS.filter((x) => x.take === k);
  const last = l[l.length - 1] ?? SEGS[0];
  return last.at + last.len;
};

// ------------------------------------------------------------------------------------ captions

const CAPS: { text: string; a: number; b: number }[] = [
  { text: 'Dicke Kabel: genauso über-unter, nur größere Schlaufen.', a: S('cIn') + 0.2, b: S('coil') + 6.6 },
  { text: 'Trag den Ring nah am Körper.', a: S('rIn') + 0.05, b: S('ring') + 4.0 },
  { text: 'Sehr dicke Kabel: auf dem Boden in Achten legen.', a: S('eIn') + 0.1, b: S('e4') + 5.6 },
  { text: 'Hier ist die Acht gewollt: flach auf dem Boden.', a: S('e5') + 0.1, b: S('e5') + 5.6 },
  { text: 'Biegeradius mindestens 10 × Kabeldicke.', a: S('gauge') + 0.1, b: E('gauge') },
  { text: 'Leg zwei Klettbänder um den Stapel.', a: S('straps') + 0.1, b: S('straps') + 4.5 },
  { text: 'Schwer? Zu zweit tragen. Eine Person sagt an.', a: S('carry') + 0.1, b: S('carry') + 5.3 },
  { text: 'Aus der Hocke, Rücken gerade, Last nah am Körper.', a: S('carry') + 5.45, b: S('carry') + 11.2 },
  { text: 'Oben abziehen, eine Schlaufe nach der anderen.', a: S('uIn') + 0.05, b: S('unroll') + 5.4 },
];
const CAP_IN = 0.35, CAP_OUT = 0.3;

/** captions shorter than their reading time (characters / 12 + 1 s), overlapping, or too long: printed when the part runs */
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
 * seconds). Until then Mai and Ada move by the keyframes of shots/p6-thick-rig.ts.
 */
export const MOCAP_SLOTS = [
  { shot: 'p6.coil.power', role: 'Mai', from: S('cIn'), to: E('coil'), note: 'die ersten drei Schlaufen (ü u ü) des 5G2,5 in natürlichem Tempo; die Simulation wird mit den aufgenommenen Händen neu gerechnet (rechte Faust gleitet, linke hält das Bündel)' },
  { shot: 'p6.carry.ring', role: 'Mai', from: S('rIn'), to: E('ring'), note: 'fertigen Ring anheben, nah am Körper tragen, zwei Schritte (hier nach vorn)' },
  { shot: 'p6.thick.fail', role: 'Mai', from: S('fIn'), to: E('fReal'), note: 'Ende aufnehmen, Schlaufe versuchen, rechte Hand lässt los, Ende ablegen; Zeitlupe aus derselben Aufnahme gedehnt, danach Echtzeit-Wiederholung' },
  { shot: 'p6.floor.eights', role: 'Mai', from: S('eIn'), to: E('eEnd'), note: 'Achten auf dem Boden: die vierte in Echtzeit, die fünfte im Zeitraffer (2×), das Ende obenauf; Mais Blick nach unten ist die Ich-Ansicht' },
  { shot: 'p6.floor.eights', role: 'Mai', from: S('gauge'), to: E('gauge'), note: 'Standbild des fertigen Stapels (Biegeradius-Lehre): Endpose der Aufnahme, Mai steht neben dem Stapel' },
  { shot: 'p6.floor.straps', role: 'Mai', from: S('straps'), to: E('straps'), note: 'zwei Klettbänder um die Enden des Stapels, kniend' },
  { shot: 'p6.lift.pair', role: 'Mai + Ada', from: S('carry'), to: E('carry'), note: 'Hocke, greifen, Mai zählt mit der Hand 3-2-1, gemeinsam hoch, drei kleine Schritte, absetzen; Ersatz: p6.lift.mai und p6.lift.ada einzeln aufgenommen' },
  { shot: 'p6.floor.unroll', role: 'Mai', from: S('uIn'), to: E('out'), note: 'oberes Ende nehmen, seitlich weggehen, das Kabel kommt Schlaufe für Schlaufe vom Stapel' },
];

// ===================================================================================== helpers

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const mixV = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const norm3 = (v: V3): V3 => mul3(v, 1 / (Math.hypot(v[0], v[1], v[2]) || 1));
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// layout: her view left (55 %), outside right
const wL = Math.round((1920 - 3 * GAP) * 0.55);
const wR = 1920 - 3 * GAP - wL;
const xL = -960 + GAP, xR = 960 - GAP - wR;
const midY = TOP + PANEL_H / 2;
const wF = 1920 - 2 * GAP;

/** a small dark chip like the "Zeitlupe" badge, with any text */
function badge(layer: Node, text: string, visible: () => number, x: number, y = TOP + 24) {
  layer.add(
    <Rect x={x} y={y} offset={[0, -1]} padding={[8, 20]} radius={30} fill={C.text} opacity={visible} layout>
      <Txt text={text} fontFamily={FONT} fontWeight={700} fontSize={28} fill={'#fff'} />
    </Rect>,
  );
}

/** a plate with text at a fixed place (a fact about the cable, a count) */
function plate(layer: Node, text: () => string, x: number, y: number, on: () => number, size = 34, fill: string = C.plate, ink: string = C.text) {
  layer.add(
    <Rect x={x} y={y} padding={[8, 22]} radius={34} fill={fill} layout opacity={on}>
      <Txt text={text} fontFamily={FONT} fontWeight={700} fontSize={size} fill={ink} />
    </Rect>,
  );
}

/** the cable proper's node range of a bake (the plugs lie beyond) */
const cableRange = (b: BakedRod): [number, number] => [Math.round(b.track('iC0', 0)), Math.round(b.track('iC1', 0))];

/** a frame recorded in a bake as a Frame */
const frameOf = (b: BakedRod, name: string, t: number): Frame => b.frame(name, t);

const CEE_SCALE_16 = 1.0, CEE_SCALE_63 = 1.5;
const STRIPE = 0.045;

// cameras (Mai stands at the origin facing -z in the coil and ring beats)
/** coil, outside: KONZEPT: on her side of the ring, to her right and a little behind, above the hands, looking down */
const COIL_EXT: Orbit = { target: [0.05, 0.78, -0.3], yaw: 0.95, pitch: 0.36, dist: 2.35, fov: 40 };
/** ring: from her right, she walks forward past the camera */
const RING_CAM: Orbit = { target: [-0.22, 0.85, -0.65], yaw: 1.4, pitch: 0.16, dist: 3.1, fov: 40 };
/** fail: in front of her, to her right: the loop between her hands, the cable on the floor running off to her right */
const FAIL_CAM: Orbit = { target: [0.25, 0.65, -0.45], yaw: Math.PI - 0.55, pitch: 0.2, dist: 3.4, fov: 40 };
/** eights: from above (her side at the bottom of the picture) */
const TOP_CAM: Orbit = { target: [0.0, 0.0, STACK.C[2] + 0.12], yaw: 0, pitch: 1.36, dist: 3.15, fov: 42 };
/** the gauge: closer, above the right lobe */
const GAUGE_CAM: Orbit = { target: [STACK.C[0] + 0.45, 0.0, STACK.C[2] + 0.02], yaw: 0, pitch: 1.4, dist: 1.85, fov: 40 };
/** straps: from her side, above */
const STRAP_CAM: Orbit = { target: [0.0, 0.15, STACK.C[2] + 0.1], yaw: 0.35, pitch: 0.62, dist: 3.0, fov: 40 };
/** carrying: from the side, both in profile */
const CARRY_CAM: Orbit = { target: [0.3, 0.62, STACK.C[2]], yaw: 0.12, pitch: 0.14, dist: 4.4, fov: 40 };
/** unrolling: above and to the side; she walks away to the right */
const UNROLL_CAM: Orbit = { target: [0.9, 0.3, STACK.C[2] + 0.2], yaw: 0.25, pitch: 0.55, dist: 4.6, fov: 40 };

// ===================================================================================== the part

export function* part(layer: Node) {
  const B = {
    coil: (yield loadBake('p6-coil')) as BakedRod,
    ring: (yield loadBake('p6-ring')) as BakedRod,
    fail: (yield loadBake('p6-fail')) as BakedRod,
    eights: (yield loadBake('p6-eights')) as BakedRod,
    unroll: (yield loadBake('p6-unroll')) as BakedRod,
  };
  for (const p of captionProblems) console.log('[render] p6-thick caption:', p);

  const { tau, run } = clock(LENGTH);
  /** 0 → 1 → 0 between scene times a and b (fading in and out) */
  const win = (a: number, b: number, fi = 0.35, fo = 0.35) => {
    const s = tau();
    return smooth((s - a) / Math.max(1e-6, fi)) * (1 - smooth((s - (b - fo)) / Math.max(1e-6, fo)));
  };
  const cur = () => segAt(tau());
  const t = () => shotAt(tau());
  const inSegs = (...ids: string[]) => ids.includes(cur().id);

  // ------------------------------------------------------------------------- what the bakes say
  const loops = [0, 1, 2].map((k) => B.coil.track(`loop${k}`, COIL_T.end));
  const loopD = loops.map((l) => (100 * l) / Math.PI);
  const eTw = { e4: B.eights.track('twStack', E4 + 0.2), e5: B.eights.track('twStack', E5), maxE4: 0 };
  for (let x = 0.8; x < E4; x += 0.1) eTw.maxE4 = Math.max(eTw.maxE4, Math.abs(B.eights.track('twStack', x)));
  const end = EIGHTS_T.end;
  // the tightest bend of the laid stack seen from above (the rule is about the loops; strands
  // climbing over each other bend in the vertical, which is not what the gauge is about)
  const stackBend = (() => {
    const [i0, i1] = cableRange(B.eights);
    const P = Array.from({ length: B.eights.n }, (_, i) => B.eights.nodeAt(end, i, [0, 0, 0]));
    let rMin = Infinity, at = 0;
    const k = 3;
    for (let i = i0 + k + 2; i <= i1 - k - 30; i++) {
      const a = P[i - k], b = P[i], c = P[i + k];
      const ab = Math.hypot(b[0] - a[0], b[2] - a[2]), bc = Math.hypot(c[0] - b[0], c[2] - b[2]), ac = Math.hypot(c[0] - a[0], c[2] - a[2]);
      const area2 = Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]));
      const r = area2 > 1e-9 ? (ab * bc * ac) / (2 * area2) : Infinity;
      if (r < rMin) {
        rMin = r;
        at = i;
      }
    }
    return { r: rMin, at };
  })();
  const unrollEnd = { twOut: B.unroll.track('twOut', UNROLL_T.end), twAll: B.unroll.track('twAll', UNROLL_T.end), onStack0: B.unroll.track('onStack', 0), onStack: B.unroll.track('onStack', UNROLL_T.end) };
  let twOutMax = 0;
  for (let x = UNROLL_T.walk0; x < UNROLL_T.end; x += 0.1) twOutMax = Math.max(twOutMax, Math.abs(B.unroll.track('twOut', x)));
  const failBend = { held: B.fail.track('bend', FAIL_T.letGo - 0.1), after: B.fail.track('bend', FAIL_T.letGo + 1.0) };
  // what may be claimed (the labels and ticks appear only if the bakes show it)
  const truth = {
    loops40: loopD.every((d) => d >= 38 && d <= 52),
    springsOpen: failBend.after > 1.5 * failBend.held,
    stripeCalm: Math.abs(eTw.e4) < 0.35 && Math.abs(eTw.e5) < 0.35,
    bendOk: stackBend.r >= 0.27,
    unrollCalm: twOutMax < 0.6,
  };
  console.log('[render] p6-thick checks', JSON.stringify({
    length: +LENGTH.toFixed(2),
    segs: SEGS.map((x) => `${x.id} ${x.at.toFixed(2)}`).join(' | '),
    loops: loops.map((l) => +l.toFixed(3)), loopD: loopD.map((d) => +d.toFixed(1)),
    eTw, E4: +E4.toFixed(2), E5: +E5.toFixed(2), stackBend, unrollEnd, twOutMax, failBend, truth, captionProblems,
  }));

  // ------------------------------------------------------------------------- the people: one RigTrack per take
  const rigOf = (who: 0 | 1, s: number): Rig => {
    const sc = Math.min(LENGTH, Math.max(0, s));
    const sg = segAt(sc);
    const st = shotAt(sc);
    switch (sg.shot) {
      case 'coil':
        return coilRig(st, sc, frameOf(B.coil, 'right', st));
      case 'ring':
        return ringRig(st, sc, ringFist(st));
      case 'fail':
        return failRig(st, sc, (x) => frameOf(B.fail, 'left', x), (x) => frameOf(B.fail, 'right', x));
      case 'eights':
        return eightsRig(st, sc, frameOf(B.eights, 'fist', st), 1 - Math.min(1, B.eights.track('grip', st) * 2));
      case 'straps':
        return strapsRig(st, sc);
      case 'carry':
        return carryRig(who, st, sc);
      case 'unroll':
        return unrollRig(st, sc, frameOf(B.unroll, 'fist', st));
    }
  };
  const tracks = new Map<string, RigTrack>();
  const trackOf = (who: 0 | 1, k: number) => {
    const key = `${who}:${k}`;
    let tr = tracks.get(key);
    if (!tr) {
      const s0 = takeStart(k);
      tr = new RigTrack(who ? ADA : MAI, (x) => rigOf(who, s0 + x), 0, 30);
      tracks.set(key, tr);
    }
    return tr;
  };
  const poseNow = (who: 0 | 1) => {
    const sg = cur();
    return trackOf(who, sg.take).pose(tau() - takeStart(sg.take));
  };
  /** Mai's eyes at scene time x, kept inside the current take (no smoothing across a cut) */
  const maiEyes = (x: number) => {
    const k = cur().take;
    return eyesOfRig(MAI, rigOf(0, Math.min(takeEnd(k) - 1e-3, Math.max(takeStart(k), x))));
  };

  // ------------------------------------------------------------------------- world A: the 5G2.5 (coil, ring)
  const r25 = POWER_5G2_5.od / 2, r16 = POWER_5G16.od / 2;
  const posA = new Float32Array(3 * Math.max(B.coil.n, B.ring.n)), d1A = new Float32Array(3 * Math.max(B.coil.n, B.ring.n));
  const coilCable = new CableMesh({ maxNodes: B.coil.n, radius: r25, plugStart: 'cee-red', plugEnd: 'cee-red-coupler', plugScale: CEE_SCALE_16, stripeWidth: STRIPE, sub: 3 });
  const ringCable = new CableMesh({ maxNodes: B.ring.n, radius: r25, plugStart: 'cee-red', plugEnd: 'cee-red-coupler', plugScale: CEE_SCALE_16, stripeWidth: STRIPE, sub: 2 });
  const ringStrap = new StrapMesh({ length: 0.5, width: 0.025, color: '#1d1e21', maxPoints: 160 });
  const maiA = splitPerson(MAI, trackOf(0, 0).pose(0));
  const povA = makeCamera(58);
  viewLayers(povA, 'pov');
  const extA = makeCamera(40);
  viewLayers(extA, 'ext');
  const ringTop = (tt: number) => {
    const f = ringFist(tt);
    return f.p;
  };
  const drawCable = (mesh: CableMesh, b: BakedRod, tt: number, pos: Float32Array, d1: Float32Array) => {
    b.frameSample(tt, pos, d1);
    const [i0, i1] = cableRange(b);
    mesh.update(pos.subarray(3 * i0), d1.subarray(3 * i0), i1 - i0 + 1);
  };
  const worldA = new World3D('p6-thick-a', () => {
    const sg = cur();
    const tt = t();
    const coil = sg.shot === 'coil';
    coilCable.group.visible = coil;
    ringCable.group.visible = !coil;
    ringStrap.group.visible = !coil;
    if (coil) drawCable(coilCable, B.coil, tt, posA, d1A);
    else {
      drawCable(ringCable, B.ring, tt, posA, d1A);
      // the strap round the top of the ring, next to her fist (closed)
      const f = ringFist(tt);
      const q = new THREE.Quaternion(f.q[0], f.q[1], f.q[2], f.q[3]);
      const along = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      const c = add3(f.p, [along.x * 0.075, along.y * 0.075 - 0.01, along.z * 0.075]);
      ringStrap.pose({ center: c, axis: [along.x, along.y, along.z], start: [0, 1, 0], radius: 0.045, wrap: 1, fold: 1 });
    }
    maiA.update(poseNow(0));
    if (coil) {
      orbit(extA, COIL_EXT);
      const look = (x: number): V3 => {
        const st = shotAt(Math.min(E('coil'), Math.max(S('cIn'), x)));
        const r = frameOf(B.coil, 'right', st).p;
        return mixV(add3(coilFist(st).p, [0.1, -0.22, 0]), r, 0.3);
      };
      povFollow(povA, maiEyes, look, tau(), { back: 0.05, up: 0.03, fov: 62, smooth: 0.3 });
    } else orbit(extA, RING_CAM);
  });
  new Studio(worldA.scene, { focus: [0, 0.6, -0.3], focusRadius: 1.8 });
  worldA.scene.add(coilCable.group, ringCable.group, ringStrap.group, maiA.person.group);

  // ------------------------------------------------------------------------- world B: the 5G16 (fail, eights, straps, carry, unroll)
  const nB = Math.max(B.fail.n, B.eights.n, B.unroll.n);
  const posB = new Float32Array(3 * nB), d1B = new Float32Array(3 * nB);
  const failCable = new CableMesh({ maxNodes: B.fail.n, radius: r16, plugStart: 'cee-red', plugEnd: null, plugScale: CEE_SCALE_63, stripeWidth: STRIPE, sub: 3 });
  // the rest of the 25 m beyond the simulated 8 m: lying on along the floor from the last node
  const REST_N = 60;
  const failRest = new CableMesh({ maxNodes: REST_N, radius: r16, plugStart: null, plugEnd: null, stripeWidth: STRIPE });
  const restPos = new Float32Array(3 * REST_N), restD1 = new Float32Array(3 * REST_N);
  const stackCable = new CableMesh({ maxNodes: B.eights.n, radius: r16, plugStart: 'cee-red', plugEnd: 'cee-red-coupler', plugScale: CEE_SCALE_63, stripeWidth: STRIPE, sub: 2 });
  const arrows = [new ArcArrow({ color: '#2b2f36', thickness: 0.009 }), new ArcArrow({ color: '#2b2f36', thickness: 0.009 })];
  const gauge = new GhostPath({ maxPoints: 97, radius: 0.006, color: '#ffffff', dash: 0.04, opacity: 0.95 });
  const gaugeLine = new GhostPath({ maxPoints: 2, radius: 0.005, color: '#ffffff', dash: 0.03, opacity: 0.95 });
  const gaugePts = new Float32Array(3 * 97), linePts = new Float32Array(6);
  const straps = [0, 1].map(() => new StrapMesh({ length: 0.62, width: 0.04, thickness: 0.003, color: '#1d1e21', maxPoints: 200 }));
  const maiB = splitPerson(MAI, trackOf(0, 2).pose(0));
  const adaB = splitPerson(ADA, carryRigPose());
  const povB = makeCamera(60);
  viewLayers(povB, 'pov');
  const extB = makeCamera(40);
  viewLayers(extB, 'ext');
  const topB = makeCamera(42);
  viewLayers(topB, 'ext');
  // the finished stack (p6-eights' last frame), for the straps and the carry: moved rigidly
  const stackPos = new Float32Array(3 * B.eights.n), stackD1 = new Float32Array(3 * B.eights.n);
  B.eights.frameSample(end, stackPos, stackD1);
  const movedPos = new Float32Array(3 * B.eights.n);
  const stackHere = (tt: number) => {
    const off = carryOffset(tt);
    const lift = off[1] / CARRY.lift;
    const half = (CARRY.ends[1] - CARRY.ends[0]) / 2;
    for (let i = 0; i < B.eights.n; i++) {
      const x = stackPos[3 * i] - STACK.C[0];
      const sag = 0.07 * lift * (1 - Math.min(1, (x / half) ** 2));
      movedPos[3 * i] = stackPos[3 * i] + off[0];
      movedPos[3 * i + 1] = stackPos[3 * i + 1] + off[1] - sag;
      movedPos[3 * i + 2] = stackPos[3 * i + 2];
    }
    return movedPos;
  };
  const strapClose = (i: number, tt: number) => {
    const T = STRAPS_T;
    const [a, b] = i ? [T.b0, T.b1] : [T.a0, T.a1];
    return { wrap: clamp01((tt - a) / ((b - a) * 0.7)), fold: clamp01((tt - a - (b - a) * 0.7) / ((b - a) * 0.3)) };
  };
  /** the camera blend of the eights beat: from above, closer on the gauge */
  const topOrbit = (): Orbit => {
    const u = easeInOutCubic(clamp01((tau() - S('gauge')) / 1.0));
    return mixOrbit(TOP_CAM, GAUGE_CAM, u, { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 });
  };
  const worldB = new World3D('p6-thick-b', () => {
    const sg = cur();
    const tt = t();
    const shot = sg.shot;
    failCable.group.visible = failRest.group.visible = shot === 'fail';
    stackCable.group.visible = shot !== 'fail';
    adaB.person.group.visible = shot === 'carry';
    if (shot === 'fail') {
      drawCable(failCable, B.fail, tt, posB, d1B);
      // the rest: straight on from the last node along the floor
      const n = B.fail.n;
      const pE = B.fail.nodeAt(tt, n - 1, [0, 0, 0]);
      const pD = B.fail.nodeAt(tt, n - 4, [0, 0, 0]);
      const dir = norm3([pE[0] - pD[0], 0, pE[2] - pD[2]]);
      for (let i = 0; i < REST_N; i++) {
        restPos.set([pE[0] + dir[0] * 0.3 * i, r16, pE[2] + dir[2] * 0.3 * i], 3 * i);
        restD1.set([0, 1, 0], 3 * i);
      }
      failRest.update(restPos, restD1, REST_N);
      orbit(extB, FAIL_CAM);
    } else if (shot === 'eights' || shot === 'unroll') {
      const b = shot === 'eights' ? B.eights : B.unroll;
      drawCable(stackCable, b, tt, posB, d1B);
      if (shot === 'eights') {
        orbit(topB, topOrbit());
        const look = (x: number): V3 => {
          const st = shotAt(Math.min(E('gauge'), Math.max(S('eIn'), x)));
          const f = frameOf(B.eights, 'fist', st).p;
          return [f[0] * 0.8, 0.05, f[2] + 0.05];
        };
        povFollow(povB, maiEyes, look, tau(), { back: 0.04, up: 0.03, fov: 66, smooth: 0.35 });
      } else orbit(extB, UNROLL_CAM);
    } else {
      // straps and carry: the finished stack, moved rigidly
      const P = shot === 'carry' ? stackHere(tt) : stackPos;
      const [i0, i1] = cableRange(B.eights);
      stackCable.update(P.subarray(3 * i0), stackD1.subarray(3 * i0), i1 - i0 + 1);
      orbit(extB, shot === 'carry' ? CARRY_CAM : STRAP_CAM);
    }
    // straps: closing in the straps beat, closed while carried
    straps.forEach((m, i) => {
      const on = shot === 'straps' || shot === 'carry';
      m.group.visible = on;
      if (!on) return;
      const off = shot === 'carry' ? carryOffset(tt) : ([0, 0, 0] as V3);
      const c = add3(STRAP_AT[i], add3(off, [0, 0.075, 0]));
      const k = shot === 'carry' ? { wrap: 1, fold: 1 } : strapClose(i, tt);
      m.pose({ center: c, axis: [0, 0, 1], start: [0, 1, 0], radius: 0.075, wrap: k.wrap, fold: k.fold, slack: 0.004 * (1 - k.fold) });
    });
    // the turning arrows on the two lobes of the first eight laid here, growing as it is laid
    const k = STACK.before;
    arrows.forEach((a, i) => {
      const side = i === 0 ? 1 : -1;
      const on = shot === 'eights' ? win(S('e4'), E('e5') + 2.0, 0.3, 0.6) : 0;
      a.group.visible = on > 0.02;
      if (!a.group.visible) return;
      const c = lobeCentre(k, side as 1 | -1);
      const lobeA = eightStart(k) + (side === 1 ? 0.35 : 0.35 * 3 + STACK.R * (Math.PI + 2 * STACK.alpha));
      const lobeL = STACK.R * (Math.PI + 2 * STACK.alpha);
      const prog = clamp01((depositAt(tt) - lobeA) / lobeL);
      const startP = stackPlane(lobeA);
      const from = sub3(stackWorld(startP.X, startP.F), c);
      a.update({ center: [c[0], 0.24, c[2]], axis: [0, 1, 0], from, radius: 0.2, angle: side * -1.55 * Math.PI, progress: Math.max(0.02, prog) * on });
    });
    // the gauge: a circle of 10 × Ø round the right lobe's middle, and its radius
    const gOn = shot === 'eights' ? win(S('gauge') + 0.6, E('gauge'), 0.5, 0.3) : 0;
    gauge.mesh.visible = gaugeLine.mesh.visible = gOn > 0.02;
    if (gOn > 0.02) {
      const c = lobeCentre(STACK.before + 1, 1);
      const R = 10 * POWER_5G16.od;
      for (let j = 0; j <= 96; j++) {
        const a = (j / 96) * 2 * Math.PI * Math.min(1, gOn * 1.2);
        gaugePts.set([c[0] + R * Math.cos(a), 0.22, c[2] + R * Math.sin(a)], 3 * j);
      }
      gauge.update(gaugePts, 97);
      linePts.set([c[0], 0.22, c[2], c[0] + R, 0.22, c[2]]);
      gaugeLine.update(linePts, 2);
    }
    maiB.update(poseNow(0));
    if (shot === 'carry') adaB.update(poseNow(1));
  });
  new Studio(worldB.scene, { focus: [0.2, 0.3, STACK.C[2]], focusRadius: 2.2 });
  worldB.scene.add(failCable.group, failRest.group, stackCable.group, ...arrows.map((a) => a.group), gauge.mesh, gaugeLine.mesh, ...straps.map((m) => m.group), maiB.person.group, adaB.person.group);

  // ------------------------------------------------------------------------- the picture
  const root = new Node({ opacity: () => smooth(tau() / 0.5) * (1 - smooth((tau() - S('out')) / 0.7)) });
  layer.add(root);
  const coilOn = () => win(S('cIn') - 1, E('coil'), 0.01, 0.35);
  const ringOn = () => win(S('rIn'), E('ring'), 0.35, 0.35);
  const failOn = () => win(S('fIn'), E('fReal'), 0.35, 0.35);
  const eightsOn = () => win(S('eIn'), E('gauge'), 0.35, 0.35);
  const restOn = () => win(S('straps'), LENGTH + 1, 0.35, 0.01);
  const fullA = () => ringOn();
  const fullB = () => Math.max(failOn(), restOn());

  // split: coil (her view | outside)
  const povViewA = (<ThreeView world={worldA} camera={povA} x={xL + wL / 2} y={midY} width={wL} height={PANEL_H} radius={28} opacity={coilOn} />) as ThreeView;
  const extViewA = (<ThreeView world={worldA} camera={extA} x={xR + wR / 2} y={midY} width={wR} height={PANEL_H} radius={28} opacity={coilOn} />) as ThreeView;
  // full: ring
  const fullViewA = (<ThreeView world={worldA} camera={extA} x={0} y={midY} width={wF} height={PANEL_H} radius={28} opacity={fullA} />) as ThreeView;
  // full: fail, straps, carry, unroll
  const fullViewB = (<ThreeView world={worldB} camera={extB} x={0} y={midY} width={wF} height={PANEL_H} radius={28} opacity={fullB} />) as ThreeView;
  // split: eights (her view down | from above)
  const povViewB = (<ThreeView world={worldB} camera={povB} x={xL + wL / 2} y={midY} width={wL} height={PANEL_H} radius={28} opacity={eightsOn} />) as ThreeView;
  const topViewB = (<ThreeView world={worldB} camera={topB} x={xR + wR / 2} y={midY} width={wR} height={PANEL_H} radius={28} opacity={eightsOn} />) as ThreeView;
  root.add([povViewA, extViewA, fullViewA, fullViewB, povViewB, topViewB]);
  const titles = new Node({});
  titles.add(new Node({ opacity: coilOn, children: [<PanelTitle text={'So siehst du es'} x={xL + 24} />, <PanelTitle text={'Von außen'} x={xR + 24} />] }));
  titles.add(new Node({ opacity: eightsOn, children: [<PanelTitle text={'So siehst du es'} x={xL + 24} />, <PanelTitle text={'Von oben'} x={xR + 24} />] }));
  root.add(titles);
  root.add(<StageChip current={6} x={0} y={TOP + PANEL_H + 34} />);

  // badges
  badge(root, 'Zeitlupe', () => win(S('fSlow'), E('fSlow'), 0.2, 0.2), 0);
  badge(root, 'Echtzeit', () => win(S('fReal'), E('fReal'), 0.3, 0.3), 0);
  badge(root, 'Zeitraffer', () => win(S('e5'), E('e5'), 0.3, 0.3), xL + wL / 2);

  // ------------------------------------------------------------------------- facts, labels where it happens
  const label = (o: { view: ThreeView; target: () => V3; at: [number, number]; text: string; color?: string; on: () => number }) =>
    root.add(callout({ view: o.view, target: o.target, at: o.at, text: o.text, color: o.color, size: 34, arrow: true, opacity: o.on }));
  const nodeOf = (b: BakedRod, i: () => number) => () => b.nodeAt(t(), Math.max(0, Math.min(b.n - 1, i())), [0, 0, 0]);
  const sNode = (b: BakedRod, s: number) => Math.round((s / b.track('iC1', 0)) * 0) + 0;
  void sNode;
  /** the node nearest material s (nodes are evenly spaced along the bake's cable) */
  const nodeAtS = (b: BakedRod, spec: typeof POWER_5G16, s: number) => Math.round(s / spec.segment);

  // 1 · the cable's facts, the loop size (measured)
  plate(root, () => '5G2,5 · 15 m · ≈ 5 kg', xR + wR / 2, TOP + 110, () => win(S('cIn') + 0.3, S('coil') + 4.5, 0.4, 0.4), 32);
  if (truth.loops40) label({ view: extViewA, target: nodeOf(B.coil, () => nodeAtS(B.coil as BakedRod, POWER_5G2_5, B.coil.track('loopS0', COIL_T.end) + 0.5 * loops[0])), at: [xR + wR / 2, TOP + PANEL_H - 120], text: `Schlaufe Ø ≈ ${Math.round(loopD[0] / 5) * 5} cm`, on: () => win(S('coil') + coilBeat(0).give + 0.3, S('coil') + coilBeat(1).slide1, 0.4, 0.3) });
  // tally of the loops (ü u ü), lit as each is given to the left fist
  const kinds = COIL.kinds;
  root.add(
    <Rect x={960 - GAP - 24} y={TOP + 24} offset={[1, -1]} padding={[10, 22]} radius={40} fill={C.plate} layout gap={14} opacity={coilOn}>
      {kinds.map((k, i) => (
        <Txt text={k === 'over' ? 'ü' : 'u'} fontFamily={FONT} fontWeight={800} fontSize={40} fill={k === 'over' ? OVER : UNDER} opacity={() => 0.15 + 0.85 * smooth((t() - coilBeat(i).give) / 0.3) * (cur().shot === 'coil' ? 1 : 0)} />
      ))}
    </Rect>,
  );
  plate(root, () => 'fertig: 11 Schlaufen', 760, TOP + 60, () => win(S('rIn') + 0.3, E('ring') - 0.5, 0.4, 0.4), 32);

  // 2 · the 5G16
  plate(root, () => '5G16 · 25 m · ≈ 40 kg', 640, TOP + 60, () => win(S('fIn') + 0.2, S('fIn') + 5.0, 0.4, 0.4), 34);
  if (truth.springsOpen) {
    root.add(
      <Rect x={0} y={TOP + 150} padding={[8, 22, 8, 12]} radius={40} fill={C.plate} layout alignItems={'center'} gap={12} opacity={() => Math.max(win(S('fRest') + 0.2, E('fRest'), 0.4, 0.3), win(S('fReal') + 1.2, E('fReal'), 0.3, 0.3))}>
        <Mark good={false} size={40} />
        <Txt text={'federt zurück: zu schwer, zu steif'} fontFamily={FONT} fontWeight={700} fontSize={34} fill={C.text} />
      </Rect>,
    );
  }
  // the eights: which way each loop turns, the calm stripe
  const lobeNow = (side: 1 | -1) => () => lobeCentre(STACK.before, side);
  label({ view: topViewB, target: () => add3(lobeNow(1)(), [0, 0.2, -0.24]), at: [xR + wR - 150, TOP + 150], text: '↻ rechtsherum', on: () => win(S('e4') + 1.6, E('e5'), 0.4, 0.4) });
  label({ view: topViewB, target: () => add3(lobeNow(-1)(), [0, 0.2, -0.24]), at: [xR + 160, TOP + 150], text: '↺ linksherum', on: () => win(S('e4') + 5.4, E('e5'), 0.4, 0.4) });
  if (truth.stripeCalm) {
    const sStripe = eightStart(STACK.before) + 0.35 + 0.4 * STACK.R * (Math.PI + 2 * STACK.alpha) + 0.4;
    label({ view: topViewB, target: nodeOf(B.eights, () => nodeAtS(B.eights, POWER_5G16, sStripe + B.eights.track('sDep', 0) - depositAt(0))), at: [xR + wR / 2 + 60, TOP + PANEL_H - 110], text: 'Streifen bleibt ruhig', on: () => win(S('e5') + 0.4, E('eEnd'), 0.4, 0.4) });
  }
  // the gauge
  label({ view: topViewB, target: () => add3(lobeCentre(STACK.before + 1, 1), [10 * POWER_5G16.od * 0.5, 0.22, 0]), at: [xR + wR / 2, TOP + 150], text: 'r ≥ 10 × Ø = 30 cm', color: C.text, on: () => win(S('gauge') + 1.0, E('gauge'), 0.4, 0.3) });
  label({ view: topViewB, target: nodeOf(B.eights, () => stackBend.at), at: [xR + wR / 2, TOP + PANEL_H - 110], text: 'Kabel Ø 3 cm', on: () => win(S('gauge') + 1.6, E('gauge'), 0.4, 0.3) });
  if (truth.bendOk) plate(root, () => `✓ hier: r ≥ ${Math.floor(stackBend.r * 100)} cm`, xL + wL / 2, TOP + PANEL_H - 70, () => win(S('gauge') + 2.4, E('gauge'), 0.4, 0.3), 32, C.good, '#fff');

  // 3 · straps
  label({ view: fullViewB, target: () => add3(STRAP_AT[0], [0, 0.15, 0]), at: [520, TOP + 170], text: 'Klettband', on: () => win(S('straps') + STRAPS_T.a1, E('straps'), 0.4, 0.3) });
  label({ view: fullViewB, target: () => add3(STRAP_AT[1], [0, 0.15, 0]), at: [-520, TOP + 170], text: 'Klettband', on: () => win(S('straps') + STRAPS_T.b1, E('straps'), 0.4, 0.3) });

  // 4 · the count: Mai's hand sign
  const countAt = () => {
    const p = poseNow(0).body.hands[1].wrist;
    return [p[0], p[1] + 0.22, p[2]] as V3;
  };
  for (const n of [3, 2, 1]) {
    label({ view: fullViewB, target: countAt, at: [-420, TOP + 150], text: `${n}`, on: () => (cur().shot === 'carry' && carryCount(t()) === n ? 1 : 0) });
  }

  // 5 · unrolling: no curl (measured)
  if (truth.unrollCalm) label({ view: fullViewB, target: nodeOf(B.unroll, () => B.unroll.n - 40), at: [560, TOP + 170], text: 'keine Kringel', on: () => win(S('unroll') + 5.5, E('out'), 0.4, 0.3) });

  // ------------------------------------------------------------------------- captions
  const capNow = () => {
    const s = tau();
    for (const c of CAPS) if (s >= c.a && s <= c.b) return { text: c.text, op: smooth((s - c.a) / CAP_IN) * (1 - smooth((s - (c.b - CAP_OUT)) / CAP_OUT)) };
    return { text: '', op: 0 };
  };
  root.add(<Txt y={CAPTION_Y} text={() => capNow().text} opacity={() => capNow().op} fontFamily={FONT} fontWeight={600} fontSize={46} fill={C.text} />);
  void Layout;
  void inSegs;
  void ringTop;

  yield* run();

  layer.removeChildren();
  worldA.dispose();
  worldB.dispose();
}

/** Ada's first pose (she appears in the carry beat only) */
function carryRigPose() {
  return new RigTrack(ADA, (x) => carryRig(1, x, x), 0, 30).pose(0);
}
