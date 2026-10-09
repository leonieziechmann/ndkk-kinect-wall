// Social 4 · Optical Flow (portrait, quick): what moves stays bright and draws its path.

import { makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInOutCubic, easeInOutSine } from '@motion-canvas/core';
import { CAPTION, P } from '../../lib/portrait';
import { SOCIAL_SHOTS, begin, moveTo, setShot, until } from '../../lib/shots';
import { cue } from '../../lib/sound';
import { SCENES, duration } from '../../lib/timeline';
import { Stage } from '../../nodes/Stage';
import { Caption, topShade } from '../../nodes/ui';

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.flow);
  const st = createRef<Stage>();
  view.add(<Stage ref={st} time={T} width={P.w} height={P.h} textScale={P.text} wallLit={0.55} wallAlpha={0} roomAlpha={0} frustum={1} frustumAlpha={0.22} kinectAlpha={0} cloud={1} />);
  setShot(st(), SOCIAL_SHOTS.kinectB);
  topShade(view, P.w, P.h);
  const cap = new Caption(view, CAPTION.x, CAPTION.y, CAPTION.style);

  cue(T, 'whoosh', 0, { dur: 1.2, gain: 0.35 });
  cue(T, 'shimmer', 0.4, { dur: 1.0 });
  cue(T, 'trails', 0.5, { dur: duration('flow') - 0.8 });
  yield* all(
    ...moveTo(st(), SOCIAL_SHOTS.kinectC, 1.2, easeInOutCubic),
    st().frustumAlpha(0.12, 1.2),
    delay(0.1, cap.show('Sie sieht auch, wie\nsich alles bewegt.')),
    delay(0.4, st().colorFlow(1, 0.8)),
    delay(0.5, st().streaks(1, 0.8)),
  );
  yield all(...moveTo(st(), SOCIAL_SHOTS.kinectC2, duration('flow') - (T() - SCENES.flow), easeInOutSine));
  yield* until(duration('flow') - 0.45);
  yield* cap.hide(0.4);
  yield* until(duration('flow'));
});
