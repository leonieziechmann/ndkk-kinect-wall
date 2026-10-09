// 3 · Punktwolke: one pixel of the depth picture becomes a point in the room (its ray and its
// distance), then all pixels fly to their places and the camera circles the cloud: real 3D data,
// only the side facing the Kinect.

import { makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInOutCubic, easeInOutSine, linear } from '@motion-canvas/core';
import { PANEL } from '../lib/layout';
import { SHOTS, begin, moveTo, setShot, until } from '../lib/shots';
import { SCENES, duration } from '../lib/timeline';
import { SensorPanel } from '../nodes/SensorPanel';
import { Stage } from '../nodes/Stage';
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
      wallContent={'idle'}
      wallLit={0.7}
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
  setShot(st(), SHOTS.sidePanels);
  view.add(<SensorPanel ref={ir} time={T} mode={'ir'} title={'Infrarot'} width={PANEL.w} height={PANEL.h} x={PANEL.x} y={PANEL.yTop} />);
  view.add(<SensorPanel ref={dp} time={T} mode={'depth'} title={'Abstand'} legend={1} width={PANEL.w} height={PANEL.h} x={PANEL.x} y={PANEL.yBottom} />);
  const cap = new Caption(view);
  yield chapterBar(view, 2);

  yield* all(
    cap.show('Aus jedem Bildpunkt wird ein Punkt im Raum.'),
    delay(0.3, dp().pixel(1, 0.6)),
    delay(0.9, st().rayLink(1, 0.9, easeInOutCubic)),
    delay(1.7, st().ray(1, 1.6, linear)),
  );
  yield* until(3.5);
  // every pixel flies to its place
  st().cloud(1);
  yield* all(
    st().cloudFly(1, 2.6, linear),
    dp().image(0.08, 2.4, linear),
    dp().pixel(0, 0.4),
    st().ray(0, 0.5),
    st().rayLink(0, 0.5),
    ir().x(PANEL.x + PANEL.out, 0.9, easeInOutCubic),
    delay(0.8, st().figures(0, 1.2)),
    delay(0.6, st().zone(0, 1)),
  );
  // around the cloud: from the side to the front of the people, behind the (now see-through) wall
  yield* all(
    dp().x(PANEL.x + PANEL.out, 0.9, easeInOutCubic),
    st().wallAlpha(0.12, 1.6),
    st().frustumAlpha(0.35, 1.6),
    st().roomAlpha(0, 1.2),
    ...moveTo(st(), SHOTS.orbitB, 4.4, easeInOutSine),
  );
  yield* until(duration('punktwolke') - 0.45);
  yield* cap.hide(0.4);
  yield* until(duration('punktwolke'));
});
