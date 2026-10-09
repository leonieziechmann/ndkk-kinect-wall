// 3 · Punktwolke: one pixel of the depth picture becomes a point in the room (its ray and its
// distance). The camera swings round to look from the Kinect, then the picture flies into the room,
// the far wall first and what is nearest to the camera last: the room builds up from back to front.

import { makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInOutCubic, easeInOutSine, linear } from '@motion-canvas/core';
import { PANEL } from '../lib/layout';
import { SHOTS, begin, moveTo, setShot, until } from '../lib/shots';
import { SCENES, duration } from '../lib/timeline';
import { SensorPanel } from '../nodes/SensorPanel';
import { Stage, flightCut } from '../nodes/Stage';
import { Caption, chapterBar } from '../nodes/ui';

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.punktwolke);
  const st = createRef<Stage>();
  const ir = createRef<SensorPanel>();
  const dp = createRef<SensorPanel>();
  view.add(
    <Stage
      ref={st}
      time={T}
      wallLit={0.55}
      roomAlpha={0.5}
      frustum={1}
      zone={1}
      figures={1}
      flyX={PANEL.x}
      flyY={PANEL.yBottom}
      flyW={PANEL.w}
      flyH={PANEL.h}
      cloudFly={0}
    />,
  );
  setShot(st(), SHOTS.sidePanels2);
  view.add(<SensorPanel ref={ir} time={T} mode={'ir'} title={'Infrarot'} width={PANEL.w} height={PANEL.h} x={PANEL.x} y={PANEL.yTop} />);
  view.add(<SensorPanel ref={dp} time={T} mode={'depth'} title={'Abstand'} legend={1} width={PANEL.w} height={PANEL.h} x={PANEL.x} y={PANEL.yBottom} />);
  const cap = new Caption(view);
  yield chapterBar(view, 2);

  // one pixel: its ray out of the lens and its distance give a point in the room
  yield* all(
    cap.show('Aus jedem Bildpunkt wird ein Punkt im Raum.'),
    delay(0.2, dp().pixel(1, 0.5)),
    delay(0.7, st().rayLink(1, 0.8, easeInOutCubic)),
    delay(1.4, st().ray(1, 1.5, linear)),
  );
  // round to the Kinect's direction; the drawn room fades
  yield* all(
    dp().pixel(0, 0.4),
    st().ray(0, 0.5),
    st().rayLink(0, 0.5),
    ir().x(PANEL.x + PANEL.out, 0.9, easeInOutCubic),
    st().figures(0, 1.0),
    st().zone(0, 0.8),
    st().wallAlpha(0, 0.8),
    st().frustumAlpha(0.22, 1.2),
    st().roomAlpha(0, 1.0),
    delay(0.6, st().kinectAlpha(0, 0.6)),
    ...moveTo(st(), SHOTS.kinectA, 1.6, easeInOutCubic),
  );
  // the picture flies into the room: far first, near last; it empties in the same order
  st().cloud(1);
  dp().depthMax(() => flightCut(st().cloudFly()));
  yield* st().cloudFly(1, 3.0, linear);
  yield* all(dp().x(PANEL.x + PANEL.out, 0.8, easeInOutCubic), ...moveTo(st(), SHOTS.kinectB, 2.0, easeInOutSine));
  yield* until(duration('punktwolke') - 0.45);
  yield* cap.hide(0.4);
  yield* until(duration('punktwolke'));
});
