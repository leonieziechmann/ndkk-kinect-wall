// 6 · Masken: from the skeletons the mask grows over each body; the room is marked as background
// and drops away, only the people stay.

import { makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInCubic, easeInOutCubic, easeInOutSine, easeOutCubic, linear } from '@motion-canvas/core';
import { PANEL, TEXT } from '../lib/layout';
import { SHOTS, begin, moveTo, setShot, until } from '../lib/shots';
import { cue } from '../lib/sound';
import { SCENES, duration } from '../lib/timeline';
import { SensorPanel } from '../nodes/SensorPanel';
import { Stage } from '../nodes/Stage';
import { Caption, chapterBar } from '../nodes/ui';

const MASK = { w: 560, h: 463, x: 545, y: -30 };

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.masken);
  const st = createRef<Stage>();
  const mk = createRef<SensorPanel>();
  view.add(
    <Stage ref={st} time={T} textScale={TEXT} wallLit={0.55} wallAlpha={0} roomAlpha={0} frustum={1} frustumAlpha={0.12} kinectAlpha={0} cloud={1} colorMask={1} maskGrow={0} skel={1} />,
  );
  setShot(st(), SHOTS.kinectD);
  view.add(<SensorPanel ref={mk} time={T} mode={'mask'} maskGrow={0} title={'Masken'} textScale={TEXT} width={MASK.w} height={MASK.h} x={MASK.x + PANEL.out} y={MASK.y} />);
  const cap = new Caption(view);
  yield chapterBar(view, 5);

  cue(T, 'whoosh', 0, { dur: 1.1, gain: 0.3 });
  yield* all(
    ...moveTo(st(), SHOTS.kinectMask, 1.1, easeInOutCubic),
    mk().x(MASK.x, 1.0, easeOutCubic),
    delay(0.45, cap.show('Nur die Menschen bleiben übrig.')),
  );
  cue(T, 'grow', 0, { dur: 1.8 });
  yield* all(st().maskGrow(90, 1.8, easeInCubic), mk().maskGrow(90, 1.8, easeInCubic));
  cue(T, 'dim', 0);
  yield* all(st().bgGrey(1, 0.6), mk().roomTint(1, 0.6));
  cue(T, 'drop', 0, { dur: 2.0 });
  yield* all(st().bgDrop(1, 2.0, linear), mk().room(0, 1.7), delay(0.35, st().frustumAlpha(0, 1.1)));
  const rest = duration('masken') - (T() - SCENES.masken);
  yield* all(...moveTo(st(), SHOTS.kinectMaskEnd, rest, easeInOutSine), delay(rest - 0.45, cap.hide(0.4)));
  yield* until(duration('masken'));
});
