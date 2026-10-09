// Social 6 · Masken (portrait, quick): from the skeletons the mask grows over each body, the room
// goes grey and drops away; the mask picture below.

import { makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInCubic, easeInOutCubic, easeInOutSine, easeOutCubic, linear } from '@motion-canvas/core';
import { CAPTION, MASK, P } from '../../lib/portrait';
import { SOCIAL_SHOTS, begin, moveTo, setShot, until } from '../../lib/shots';
import { cue } from '../../lib/sound';
import { SCENES, duration } from '../../lib/timeline';
import { SensorPanel } from '../../nodes/SensorPanel';
import { Stage } from '../../nodes/Stage';
import { Caption, topShade } from '../../nodes/ui';

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.masken);
  const st = createRef<Stage>();
  const mk = createRef<SensorPanel>();
  view.add(
    <Stage
      ref={st}
      time={T}
      width={P.w}
      height={P.h}
      textScale={P.text}
      wallLit={0.55}
      wallAlpha={0}
      roomAlpha={0}
      frustum={1}
      frustumAlpha={0.12}
      kinectAlpha={0}
      cloud={1}
      colorMask={1}
      maskGrow={0}
      skel={1}
    />,
  );
  setShot(st(), SOCIAL_SHOTS.kinectD);
  topShade(view, P.w, P.h);
  const M = MASK;
  view.add(<SensorPanel ref={mk} time={T} mode={'mask'} maskGrow={0} title={'Masken'} width={M.w} height={M.h} x={M.x} y={M.y + M.out} textScale={P.text} />);
  const cap = new Caption(view, CAPTION.x, CAPTION.y, CAPTION.style);

  cue(T, 'whoosh', 0, { dur: 1.0, gain: 0.3 });
  yield* all(...moveTo(st(), SOCIAL_SHOTS.kinectMask, 1.0, easeInOutCubic), mk().y(M.y, 0.9, easeOutCubic), delay(0.3, cap.show('Nur die Menschen\nbleiben übrig.')));
  cue(T, 'grow', 0, { dur: 1.5 });
  yield* all(st().maskGrow(90, 1.5, easeInCubic), mk().maskGrow(90, 1.5, easeInCubic));
  cue(T, 'dim', 0);
  yield* all(st().bgGrey(1, 0.5), mk().roomTint(1, 0.5));
  cue(T, 'drop', 0, { dur: 1.7 });
  yield* all(st().bgDrop(1, 1.7, linear), mk().room(0, 1.5), delay(0.3, st().frustumAlpha(0, 1.0)));
  yield* all(...moveTo(st(), SOCIAL_SHOTS.kinectMaskEnd, duration('masken') - (T() - SCENES.masken), easeInOutSine), delay(duration('masken') - (T() - SCENES.masken) - 0.45, cap.hide(0.4)));
  yield* until(duration('masken'));
});
