// Stage 1, part 1: Noor coils the 5 m XLR cable over and under into her left hand (KONZEPT stage 1,
// items 1 and 2).
//
//   - a few seconds from outside, wide: who and where; then the picture splits into her own view
//     (left, 55 %) and the outside view from her right, slightly behind her (right, 45 %)
//   - the first pair slowly: an "über" loop, then an "unter" loop (the right hand turns over, a 180°
//     arrow round the forearm). After each, time stops and the outside camera swings ~45° round the
//     left hand (Noor see-through): the cable to the floor glows white, the crossing has a blue or
//     orange rim, and "in front of / behind" becomes left / right. Labels point at the crossing.
//   - four more loops at everyday speed, the tally ü u ü u ü u fills up
//   - the velcro tie closes round the ring, ✓ "Der Ring liegt rund und flach"
//
// The cable is the baked simulation (shots/s1-coil.ts), hands and arms come from the same
// choreography (shots/coiling.ts); the world is coil-world.ts.

import { Layout, Node, Txt } from '@motion-canvas/2d';
import { all, easeInOutCubic, waitFor } from '@motion-canvas/core';
import { BakedRod, loadBake, smooth } from '../../sim';
import { COIL1, SEG, floorStart, loopNodes } from '../../shots/s1-coil';
import { CAPTION_Y, Captions, GAP, PANEL_H, PanelTitle, TOP, Timeline, clock, readTime, swing, tally } from '../../lib/kit';
import { C, FONT, OVER, UNDER } from '../../lib/theme';
import { Mark, StageChip } from '../../lib/ui';
import { Orbit, mixOrbit } from '../../three/camera';
import { callout } from '../../three/overlay';
import { ThreeView } from '../../three/view';
import { CoilShot, CoilWorld, povFrom } from './coil-world';

const SHOT: CoilShot = { coil: COIL1, seg: SEG, floorStart, loopNodes };
const B = COIL1.beats;

/** seconds of the wide opening shot (time stands still), and of the change to the split screen */
const INTRO = 3.0, SPLIT = 1.2;
/** a freeze after each teaching loop: swing out, hold, swing back */
const FREEZE = { out: 1.4, hold: 3.0, back: 1.2 };
const FREEZE_LEN = FREEZE.out + FREEZE.hold + FREEZE.back;
/** shot time of each freeze: the cable to the floor has dropped through the new loop */
const freezeAt = (k: number) => B[k - 1].tFree + 0.45;
/** time after the tie is closed: the camera moves to the ring, then the tick */
const END = 3.8;

const timeline = new Timeline([
  { kind: 'freeze', at: 0, len: INTRO + SPLIT * 0.6 },
  { kind: 'freeze', at: freezeAt(1), len: FREEZE_LEN },
  { kind: 'freeze', at: freezeAt(2), len: FREEZE_LEN },
]);
const SHOT_END = COIL1.tie.tPress + END;
const LENGTH = timeline.scene(SHOT_END);

// ------------------------------------------------------------------------------- cameras

/** wide: Noor standing with the cable, the rest of it on the floor */
const WIDE: Orbit = { target: [0.05, 0.9, -0.3], yaw: 2.25, pitch: 0.16, dist: 2.7, fov: 34 };
/** the outside camera: on her right, slightly behind her, above the hands, looking down */
const EXT: Orbit = { target: COIL1.at(0.12, -0.14, 0.0), yaw: 1.2, pitch: 0.42, dist: 0.95, fov: 42 };
/** the tie: from above and in front of her, looking down on the top of the ring where it closes */
const TIE_CAM: Orbit = { target: COIL1.at(-0.04, -0.03, 0.0), yaw: 3.35, pitch: 0.95, dist: 0.62, fov: 42 };
/** the finished ring: from her side again, the floor behind it, a little closer and higher */
const END_CAM: Orbit = { target: COIL1.at(0.0, -0.1, 0.0), yaw: 1.05, pitch: 0.55, dist: 0.8, fov: 40 };
/** the freeze: ~45° further round the left hand, the whole ring in view */
const FREEZE_CAM: Orbit = { target: COIL1.at(0.02, -0.15, 0.0), yaw: 1.2 + 0.6, pitch: 0.2, dist: 0.72, fov: 42 };

export function* part(layer: Node) {
  const bake = (yield loadBake('s1-coil')) as BakedRod;
  const { tau, run } = clock(LENGTH);
  const t = () => timeline.shot(tau());
  /** 0 … 1 … 0 during the freeze after loop k */
  const sw = (k: number) => swing(timeline.phase(tau(), k), FREEZE.out / FREEZE_LEN, FREEZE.back / FREEZE_LEN);
  const freeze = () => Math.max(sw(1), sw(2));

  const ext = (): Orbit => {
    const s = tau();
    const out: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
    if (s < INTRO + SPLIT) {
      // a slow push in during the opening, then over to the outside camera while the picture splits
      const wide = mixOrbit(WIDE, { ...WIDE, dist: WIDE.dist * 0.9 }, smooth(s / INTRO), { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 });
      return mixOrbit(wide, EXT, easeInOutCubic(Math.max(0, (s - INTRO) / SPLIT)), out);
    }
    // between the last loop and the tie the camera moves round to look down on the bundle, after the
    // tie to the finished ring
    const tt = t(), T = COIL1.tie;
    const ramp = (a: number, b: number) => easeInOutCubic(Math.min(1, Math.max(0, (tt - a) / (b - a))));
    if (tt > T.tPress + 0.1) return mixOrbit(TIE_CAM, END_CAM, ramp(T.tPress + 0.1, T.tPress + 1.2), out);
    if (tt > COIL1.tEnd - 0.1) return mixOrbit(EXT, TIE_CAM, ramp(COIL1.tEnd - 0.1, T.tPinch - 0.2), out);
    return mixOrbit(EXT, FREEZE_CAM, freeze(), out);
  };

  const pov = povFrom(COIL1, 0.04, 0.06, 0.04, COIL1.at(0.07, -0.12, 0.0), 50);
  const cw = new CoilWorld('p1-coil', bake, SHOT, {
    t,
    ext,
    pov: () => pov,
    xray: freeze,
    glow: () => {
      const tt = t();
      for (const k of [1, 2]) {
        const b = B[k - 1];
        if (tt > b.tOpen && tt < B[k].t0 + 0.3) return { k, on: Math.min(1, (tt - b.tOpen) / 0.4, (B[k].t0 + 0.3 - tt) / 0.3) };
      }
      return null;
    },
    arrow: () => {
      // loop 2: while the hand turns over, and a moment after
      const tt = t(), b = B[1];
      if (tt < b.tReady - 0.15 || tt > b.tTurned + 0.7) return null;
      return Math.min(1, COIL1.right(tt).flip * 1.05 + 0.05);
    },
  });

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
  const povView = (<ThreeView world={cw.world} camera={cw.povCam} x={xL + wL / 2} y={midY} width={wL} height={PANEL_H} radius={28} opacity={() => smooth((tau() - INTRO - SPLIT * 0.4) / (SPLIT * 0.6))} />) as ThreeView;
  layer.add([extView, povView]);
  const titles = new Node({ opacity: () => smooth((tau() - INTRO - SPLIT * 0.6) / 0.4) });
  titles.add([<PanelTitle text={'So siehst du es'} x={xL + 24} />, <PanelTitle text={'Von außen'} x={xR + 24} />]);
  layer.add(titles);
  layer.add(<StageChip current={1} x={0} y={TOP + PANEL_H + 34} />);

  // tally: one letter per placed loop
  const placed = (i: number) => smooth((t() - B[i].tPlace) / 0.25);
  const tal = tally(layer, COIL1.kinds, placed);
  tal.opacity(() => smooth((tau() - INTRO - SPLIT) / 0.4));

  // labels at the crossing: in her view while the loop is shown, in the outside view during the freeze
  const LABELS = ['Kabel zum Boden: obenauf', 'Die Schlaufe deckt es zu'];
  for (const k of [1, 2]) {
    const color = k === 1 ? OVER : UNDER;
    const target = () => cw.crossPoint(k, t());
    const inPov = () => {
      const tt = t();
      return Math.min(smooth((tt - B[k - 1].tFree) / 0.35), smooth((B[k].t0 + 0.3 - tt) / 0.3));
    };
    layer.add(callout({ view: povView, target, at: [xL + wL - 330, TOP + PANEL_H - 110], text: LABELS[k - 1], color, opacity: inPov }));
    layer.add(callout({ view: extView, target, at: [xR + wR / 2, TOP + PANEL_H - 80], text: LABELS[k - 1], color, size: 32, opacity: () => sw(k) }));
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
  // caption 2 a second before the hand starts to turn (the end of the first freeze)
  const cap2At = at(freezeAt(1)) + FREEZE_LEN - 1.2;

  yield* all(
    run(),
    (function* () {
      yield* waitFor(0.8);
      yield* cap.show(CAP1);
      yield* waitFor(Math.max(readTime(CAP1), at(B[0].tFree) - 0.8 - 0.35));
      yield* cap.hide();
      yield* waitFor(cap2At - tauNow());
      yield* cap.show(CAP2);
      yield* waitFor(Math.max(readTime(CAP2), at(B[1].tRet) - tauNow()));
      yield* cap.hide();
      yield* waitFor(at(COIL1.tie.tPress + 1.2) - tauNow());
      yield* done.opacity(1, 0.4);
      yield* waitFor(LENGTH - tauNow() - 0.5);
      yield* all(...layer.children().map((c) => c.opacity(0, 0.5)));
    })(),
  );
  function tauNow() {
    return tau();
  }

  layer.removeChildren();
  cw.world.dispose();
}

