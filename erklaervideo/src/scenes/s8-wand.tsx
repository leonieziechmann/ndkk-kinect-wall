// 8 · Interaktion: back in the room, behind the audience. Three people move in front of the wall,
// the fluid follows them; a small picture shows what the Kinect sees at the same moment.

import { Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInOutCubic, easeInOutSine, easeOutCubic } from '@motion-canvas/core';
import { SHOTS, begin, moveTo, setShot, until } from '../lib/shots';
import { cue } from '../lib/sound';
import { C, FONT } from '../lib/theme';
import { SCENES, duration } from '../lib/timeline';
import { Stage } from '../nodes/Stage';
import { WallView } from '../nodes/WallView';
import { Caption, chapterBar } from '../nodes/ui';

const PIP = { w: 520, h: 293, x: 640, y: 292 };

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.wand);
  const st = createRef<Stage>();
  const wall = createRef<WallView>();
  const pip = createRef<Rect>();
  const pipStage = createRef<Stage>();
  const black = createRef<Rect>();
  view.add(<Stage ref={st} time={T} wallContent={'fluid'} wallLit={1} roomAlpha={0} figures={1} silhouette={1} spill={1} />);
  setShot(st(), SHOTS.wallClose);
  view.add(<WallView ref={wall} time={T} x={0} y={-60} width={1500} height={500} fluid={1} skel={0.55} />);
  view.add(
    <Rect ref={pip} x={PIP.x} y={PIP.y} width={PIP.w} height={PIP.h} radius={14} fill={'#03050a'} stroke={'rgba(158,195,255,0.6)'} lineWidth={2} clip opacity={0}>
      <Stage ref={pipStage} time={T} width={PIP.w} height={PIP.h} grid={0.6} wallAlpha={0} kinectAlpha={0} roomAlpha={0} cloud={1} colorMask={1} maskGrow={400} bgDrop={1} skel={1} />
      <Txt x={-PIP.w / 2 + 18} y={-PIP.h / 2 + 22} offset={[-1, 0]} text={'Sicht der Kinect'} fontFamily={FONT} fontWeight={600} fontSize={22} fill={C.sensor} />
    </Rect>,
  );
  setShot(pipStage(), SHOTS.pip);
  view.add(<Rect ref={black} width={1920} height={1080} fill={'#000'} opacity={0} />);
  const cap = new Caption(view);
  yield chapterBar(view, 7);

  cue(T, 'whoosh', 0, { dur: 4.0, gain: 0.35 });
  cue(T, 'swish', 3.4, { pan: 0.75, gain: 0.5 });
  yield* all(
    wall().opacity(0, 0.9),
    ...moveTo(st(), SHOTS.wallWide, 4.0, easeInOutCubic),
    delay(1.0, cap.show('Deine Bewegung malt auf der Wand.')),
    delay(3.4, all(pip().opacity(1, 0.6), pip().y(PIP.y - 12, 0.6, easeOutCubic))),
  );
  yield* all(...moveTo(st(), SHOTS.wallWideEnd, 6.0, easeInOutSine));
  yield* all(pip().opacity(0, 0.5), cap.hide(0.5));
  yield* until(duration('wand') - 1.0);
  cue(T, 'black', 0, { dur: 1.0 });
  yield* black().opacity(1, 1.0);
  yield* until(duration('wand'));
});
