// 4 · Optical Flow: from the Kinect's direction, a bit closer; what moves stays bright and draws the
// path it took over the last frames, the rest goes dark.

import { makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInOutCubic, easeInOutSine } from '@motion-canvas/core';
import { SHOTS, begin, moveTo, setShot, until } from '../lib/shots';
import { SCENES, duration } from '../lib/timeline';
import { Stage } from '../nodes/Stage';
import { Caption, chapterBar } from '../nodes/ui';

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.flow);
  const st = createRef<Stage>();
  view.add(<Stage ref={st} time={T} wallLit={0.55} wallAlpha={0} roomAlpha={0} frustum={1} frustumAlpha={0.22} kinectAlpha={0} cloud={1} />);
  setShot(st(), SHOTS.kinectB);
  const cap = new Caption(view);
  yield chapterBar(view, 3);

  yield* all(
    ...moveTo(st(), SHOTS.kinectC, 1.6, easeInOutCubic),
    st().frustumAlpha(0.12, 1.6),
    delay(0.2, cap.show('Sie sieht auch, wie sich alles bewegt.')),
    delay(0.7, st().colorFlow(1, 1.0)),
    delay(0.9, st().streaks(1, 1.0)),
  );
  yield all(...moveTo(st(), SHOTS.kinectC2, duration('flow') - 1.9, easeInOutSine));
  yield* until(duration('flow') - 0.45);
  yield* cap.hide(0.4);
  yield* until(duration('flow'));
});
