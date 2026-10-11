// Stage 1, part 1: Noor coils the 5 m XLR cable over and under into her left hand (KONZEPT stage 1,
// items 1 and 2).
//
//   - a few seconds from outside, wide: who and where; then the picture splits into her own view
//     (left, 55 %: her arms only, her body's shadow) and the outside view (right, 45 %)
//   - the first pair slowly: an "über" loop, then an "unter" loop (the right hand turns over in slow
//     motion while the outside camera comes close to it, an arc 5 cm round the wrist as far as it
//     really turns; the loop then hangs over the wrist on the way back). After each, time stops and
//     the outside camera swings round behind the left hand, to Noor's side of the coil, looking along
//     the coil's axis the way she sees it (Noor see-through): the cable to the floor glows white, the
//     crossing gets a blue or orange rim, and a label points at the cable to the floor and says which
//     lies on top, seen from her side (only if the simulation really has it so)
//   - four more loops at her natural pace, the tally ü u ü u ü u fills up
//   - the right hand slides out along the rest of the cable and brings its end up beside the fist,
//     the velcro tie closes round the coil next to her fist; ✓ "Der Ring liegt rund und flach." (only
//     if every baked loop really is round and flat at the end: coil-world.ts ringCheck)
//
// The outside camera stands in front of her, a little to her right: the loops hang in planes facing
// forward and to her right (shots/coiling.ts GEOM.N), so from there the rings are seen open, and the
// right hand's way out to the hip and its turn over are in front of the camera, not behind her body.
//
// Everything comes from the bake s1-coil (shots/s1-coil.ts, coil-engine.ts): the cable, her arms
// (recorded angles), the hand shapes; the world is coil-world.ts.

import { Layout, Node, Txt } from '@motion-canvas/2d';
import { all, easeInOutCubic, waitFor } from '@motion-canvas/core';
import { BakedRod, loadBake, smooth } from '../../sim';
import { COIL1 } from '../../shots/s1-coil';
import { CoilController } from '../../shots/coil-engine';
import { GEOM, beats } from '../../shots/coiling';
import { J } from '../../people/people';
import { CAPTION_Y, Captions, GAP, PANEL_H, PanelTitle, TOP, Timeline, clock, readTime, slowBadge, swing, tally } from '../../lib/kit';
import { C, FONT, OVER, UNDER } from '../../lib/theme';
import { Mark, StageChip } from '../../lib/ui';
import { Orbit, mixOrbit } from '../../three/camera';
import { callout } from '../../three/overlay';
import { ThreeView } from '../../three/view';
import { CoilWorld } from './coil-world';

const B = beats(COIL1);
const norm3 = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** seconds of the wide opening shot (time stands still), and of the change to the split screen */
const INTRO = 3.4, SPLIT = 1.2;
/** a freeze after each teaching loop: swing out, hold, swing back */
const FREEZE = { out: 1.4, hold: 3.6, back: 1.2 };
const FREEZE_LEN = FREEZE.out + FREEZE.hold + FREEZE.back;
/** shot time of each freeze: the loop is laid, the cable to the floor hangs from the pads through it */
const freezeAt = (k: number) => B[k - 1].tMeet + 0.22;
/** the turn over of the first "unter" loop in slow motion (0.25×), the loop falling over the wrist after it at 0.5× */
const SLOW_AT = B[1].tHeld - 0.1, SLOW_LEN = B[1].tTurned - B[1].tHeld + 0.25, SLOW_F = 0.25;
/** the end fetched after the last loop (the right hand brings it up beside the fist) */
const END = new CoilController(COIL1, { fetchEnd: true }).endBeats();
/** the tie (shot times, once the end is up) */
const TIE = { wrap0: END.fUp + 0.1, wrap1: END.fUp + 1.1, fold1: END.fUp + 1.7 };
/** the end: time stands still while the camera moves round to the front of the ring */
const END_HOLD = 5.5;

export function* part(layer: Node) {
  const bake = (yield loadBake('s1-coil')) as BakedRod;
  const SHOT_END = bake.duration - 0.05;
  const timeline = new Timeline([
    { kind: 'freeze', at: 0, len: INTRO + SPLIT * 0.6 },
    { kind: 'freeze', at: freezeAt(1), len: FREEZE_LEN },
    { kind: 'slow', at: SLOW_AT, len: SLOW_LEN, factor: SLOW_F },
    { kind: 'freeze', at: freezeAt(2), len: FREEZE_LEN },
    { kind: 'freeze', at: SHOT_END, len: END_HOLD },
  ]);
  const LENGTH = timeline.scene(SHOT_END) + END_HOLD;
  const { tau, run } = clock(LENGTH);
  const t = () => Math.min(SHOT_END, timeline.shot(tau()));
  /** 0 … 1 … 0 during the freeze after loop k (events 1 and 3) */
  const sw = (k: number) => swing(timeline.phase(tau(), k === 1 ? 1 : 3), FREEZE.out / FREEZE_LEN, FREEZE.back / FREEZE_LEN);
  const freeze = () => Math.max(sw(1), sw(2));
  const endU = () => smooth(Math.max(0, (tau() - timeline.scene(SHOT_END)) / 2.4));

  // ------------------------------------------------------------------------- cameras
  const gl = bake.frame('gripL', freezeAt(1)).p;
  const coilAt: [number, number, number] = [gl[0] + 0.02, gl[1] - 0.12, gl[2]];
  /** wide: Noor standing with the cable, the rest of it on the floor to her right front */
  const WIDE: Orbit = { target: [0.1, 0.92, -0.45], yaw: 2.5, pitch: 0.2, dist: 2.9, fov: 34 };
  /** the outside camera: in front of her, a little to her right, close: the coil and both hands */
  const EXT: Orbit = { target: [0.08, 0.8, -0.3], yaw: Math.PI - 0.42, pitch: 0.3, dist: 1.2, fov: 40 };
  /**
   * The freeze: from Noor's side of the coil, behind and above her left hand, looking along the
   * coil's axis N (the way she sees the loops: "on top" is towards the camera)
   */
  const FREEZE_CAM = (k: number): Orbit => {
    const c = cw.crossPoint(k, freezeAt(k));
    return { target: [0.5 * (c[0] + coilAt[0]), 0.5 * (c[1] + coilAt[1]) + 0.02, 0.5 * (c[2] + coilAt[2])], yaw: Math.atan2(-GEOM.N[0], -GEOM.N[2]), pitch: 0.62, dist: 0.78, fov: 38 };
  };
  /**
   * The slow motion: close on the right hand turning over, looking at the wrist at 45° to the
   * forearm from outside it, so the arc round the wrist is seen open
   */
  let slowOrbit: Orbit | null = null;
  const slowCam = (): Orbit => (slowOrbit ??= (() => {
    const pose = cw.replay.pose(B[1].tTurned);
    const w = pose.joints[J.rightWrist], e = pose.joints[J.rightElbow];
    const fa = norm3([w[0] - e[0], w[1] - e[1], w[2] - e[2]]);
    // outside the forearm (away from her body, horizontally) and back along it towards the elbow: the camera
    const outside = norm3([w[0], 0, w[2] + 0.1]);
    const o = norm3([-fa[0] + 0.9 * outside[0], -fa[1] + 0.35, -fa[2] + 0.9 * outside[2]]);
    return { target: [w[0], w[1], w[2]], yaw: Math.atan2(o[0], o[2]), pitch: Math.asin(Math.max(-0.2, Math.min(0.9, o[1]))), dist: 0.62, fov: 38 } as Orbit;
  })());
  /** the slow motion's camera follows the right hand (between its pads and its wrist) */
  const slowFollow: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
  const slowNow = (): Orbit => {
    const c = slowCam(), g = bake.frame('gripR', t()).p;
    slowFollow.target[0] = g[0]; slowFollow.target[1] = g[1] + 0.04; slowFollow.target[2] = g[2];
    slowFollow.yaw = c.yaw; slowFollow.pitch = c.pitch; slowFollow.dist = c.dist; slowFollow.fov = c.fov;
    return slowFollow;
  };
  /** 0 … 1 … 0 around the slow motion: the outside camera comes close to the right hand */
  const slowU = () => {
    const a = timeline.scene(SLOW_AT) - 0.9, b = timeline.scene(SLOW_AT + SLOW_LEN) + 0.9;
    const s = tau();
    return smooth((s - a) / 0.9) * (1 - smooth((s - b) / 1.0));
  };
  /** the finished ring from the front at hip height */
  const END_CAM: Orbit = { target: [coilAt[0] - 0.04, coilAt[1] - 0.02, coilAt[2] + 0.04], yaw: Math.PI - 0.3, pitch: 0.12, dist: 0.95, fov: 38 };
  const o1: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
  const o2: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
  const ext = (): Orbit => {
    const s = tau();
    if (s < INTRO + SPLIT) {
      const wide = mixOrbit(WIDE, { ...WIDE, dist: WIDE.dist * 0.88 }, smooth(s / INTRO), o1);
      return mixOrbit(wide, EXT, easeInOutCubic(Math.max(0, (s - INTRO) / SPLIT)), o2);
    }
    if (endU() > 0) return mixOrbit(EXT, END_CAM, easeInOutCubic(endU()), o2);
    if (slowU() > 0) return mixOrbit(EXT, slowNow(), easeInOutCubic(slowU()), o2);
    const k = sw(2) > 0 ? 2 : 1;
    return mixOrbit(EXT, FREEZE_CAM(k), easeInOutCubic(freeze()), o2);
  };

  const cw: CoilWorld = new CoilWorld('p1-coil', bake, COIL1, {
    t,
    ext,
    xray: freeze,
    glow: () => {
      const tt = t();
      for (const k of [1, 2]) {
        const b = B[k - 1], nx = B[k];
        if (tt > b.tMeet - 0.1 && tt < nx.tSlide + 0.3) return { k, on: Math.min(1, (tt - b.tMeet + 0.1) / 0.3, (nx.tSlide + 0.3 - tt) / 0.3) };
      }
      return null;
    },
    arrow: (): number | null => {
      // the first "unter" loop: while the hand turns over, and as it turns back on the way
      const tt = t(), b = B[1];
      if (tt < b.tHeld - 0.05 || tt > b.tAbove) return null;
      return cw.replay.at(tt).turn;
    },
    tie: () => {
      const tt = t();
      if (tt < TIE.wrap0) return null;
      return { wrap: smooth((tt - TIE.wrap0) / (TIE.wrap1 - TIE.wrap0)), fold: smooth((tt - TIE.wrap1) / (TIE.fold1 - TIE.wrap1)) };
    },
  });
  // the crossings the labels point at, and whether the labels are true there
  const cross = [1, 2].map((k) => cw.crossing(k, freezeAt(k)));
  const truth = cross.map((c, i) => c !== null && (i === 0 ? c.depth < 0 : c.depth > 0));
  console.log('p1-coil crossings at the freezes (depth along N: − Noor\'s side)', JSON.stringify(cross), 'labels shown', JSON.stringify(truth));
  // (the ✓ only if the baked ring really lies round and flat: coil-world.ts ringCheck)
  const ring = cw.ringCheck(SHOT_END);
  const roundOk = ring.ok;
  console.log('p1-coil ring check', JSON.stringify(ring));

  // ------------------------------------------------------------------------- the picture
  const wL = Math.round((1920 - 3 * GAP) * 0.55);
  const wR = 1920 - 3 * GAP - wL;
  const xL = -960 + GAP, xR = 960 - GAP - wR;
  const midY = TOP + PANEL_H / 2;
  const fullW = 1920 - 2 * GAP;
  const split = () => easeInOutCubic(Math.min(1, Math.max(0, (tau() - INTRO) / SPLIT)));

  const extView = (
    <ThreeView world={cw.world} camera={cw.extCam} y={midY} height={PANEL_H} radius={28}
      x={() => -960 + GAP + fullW / 2 + (xR + wR / 2 - (-960 + GAP + fullW / 2)) * split()}
      width={() => fullW + (wR - fullW) * split()} />
  ) as ThreeView;
  const povView = (<ThreeView world={cw.world} camera={cw.povCam} x={xL + wL / 2} y={midY} width={wL} height={PANEL_H} radius={28} opacity={() => smooth((tau() - INTRO - SPLIT * 0.2) / (SPLIT * 0.5))} />) as ThreeView;
  // (her view lies behind the outside view, which slides off it to the right)
  layer.add([povView, extView]);
  const titles = new Node({ opacity: () => smooth((tau() - INTRO - SPLIT * 0.6) / 0.4) });
  titles.add([<PanelTitle text={'So siehst du es'} x={xL + 24} />, <PanelTitle text={'Von außen'} x={xR + 24} />]);
  layer.add(titles);
  layer.add(<StageChip current={1} x={0} y={TOP + PANEL_H + 34} />);

  // tally: one letter per laid loop
  const placed = (i: number) => smooth((t() - B[i].tMeet) / 0.25);
  const tal = tally(layer, COIL1.kinds, placed);
  tal.opacity(() => smooth((tau() - INTRO - SPLIT) / 0.4));
  // "Zeitlupe" over her view while the hand turns over in slow motion
  slowBadge(layer, () => smooth((timeline.phase(tau(), 2) + 1e-6) / 0.08) * (timeline.phase(tau(), 2) >= 0 ? 1 : 0), xL + wL / 2, TOP + 24);

  // labels at the crossing: in the outside view during the freeze (only if they are true)
  const LABELS = ['Kabel zum Boden: obenauf', 'Die Schlaufe deckt es zu'];
  for (const k of [1, 2]) {
    if (!truth[k - 1]) continue;
    const color = k === 1 ? OVER : UNDER;
    // (the arrow points at the cable to the floor, just past the crossing)
    layer.add(callout({ view: extView, target: () => cw.floorPoint(k, t()) ?? cw.crossPoint(k, t()), at: [xR + wR / 2, TOP + PANEL_H - 90], text: LABELS[k - 1], color, size: 34, arrow: true, opacity: () => smooth((sw(k) - 0.5) / 0.4) }));
  }

  // the end: ✓ the ring lies round and flat
  const done = (
    <Layout layout direction={'row'} alignItems={'center'} gap={20} y={CAPTION_Y} opacity={0}>
      <Mark good size={58} />
      <Txt text={'Der Ring liegt rund und flach.'} fontFamily={FONT} fontWeight={600} fontSize={46} fill={C.text} />
    </Layout>
  ) as Layout;
  layer.add(done);

  const cap = new Captions(layer);
  const at = (shotT: number) => timeline.scene(shotT);
  const CAP1 = 'Leg Schlaufen in die linke Hand – abwechselnd über und unter.';
  const CAP2 = 'Für »unter« drehst du die rechte Hand um.';

  yield* all(
    run(),
    (function* () {
      // caption 1 during the opening, a second before the first movement; it stays through the first loop
      yield* waitFor(INTRO - 1.4);
      yield* cap.show(CAP1);
      yield* waitFor(Math.max(readTime(CAP1), at(B[0].tMeet) - tau()));
      yield* cap.hide();
      // caption 2 at the end of the first freeze, well before the hand turns
      yield* waitFor(at(freezeAt(1)) + FREEZE_LEN - 0.4 - tau());
      yield* cap.show(CAP2);
      yield* waitFor(Math.max(readTime(CAP2), at(B[1].tMeet) - tau()));
      yield* cap.hide();
      yield* waitFor(at(SHOT_END) + 1.6 - tau());
      if (roundOk) yield* done.opacity(1, 0.4);
      yield* waitFor(LENGTH - tau() - 0.5);
      yield* all(...layer.children().map((c) => c.opacity(0, 0.5)));
    })(),
  );

  layer.removeChildren();
  cw.world.dispose();
}
