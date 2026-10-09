// 2 · Sichtfeld, Infrarot, Tiefe: the field of view grows out of the Kinect, two people walk in, the
// two pictures of the Kinect slide in empty, and fill up with the first infrared pulse: what is near
// comes back first, the far wall last. Then they run live while the people arrive and wave.

import { makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInOutCubic, easeInOutSine, easeOutCubic, linear } from '@motion-canvas/core';
import { PANEL } from '../lib/layout';
import { SHOTS, begin, moveTo, setShot, until } from '../lib/shots';
import { SCENES, duration } from '../lib/timeline';
import { SensorPanel } from '../nodes/SensorPanel';
import { Stage } from '../nodes/Stage';
import { Caption, chapterBar } from '../nodes/ui';

/** the first pulse runs from 0.5 m to 6 m in this time (as fast as the pulses in the stage) */
const PULSE_RUN = 5.5 / 2.42;

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.sensor);
  const st = createRef<Stage>();
  const ir = createRef<SensorPanel>();
  const dp = createRef<SensorPanel>();
  view.add(<Stage ref={st} time={T} wallLit={1} labels={1} dims={1} roomAlpha={0.5} />);
  setShot(st(), SHOTS.roomEnd);
  view.add(<SensorPanel ref={ir} time={T} mode={'ir'} title={'Infrarot'} depthMax={0.5} edge={1} width={PANEL.w} height={PANEL.h} x={PANEL.x + PANEL.out} y={PANEL.yTop} />);
  view.add(<SensorPanel ref={dp} time={T} mode={'depth'} title={'Abstand'} depthMax={0.5} edge={1} legend={1} width={PANEL.w} height={PANEL.h} x={PANEL.x + PANEL.out} y={PANEL.yBottom} />);
  const cap = new Caption(view);
  yield chapterBar(view, 1);

  yield* all(
    ...moveTo(st(), SHOTS.sidePanels, 2.6, easeInOutCubic),
    st().labels(0, 0.5),
    st().dims(0, 0.5),
    st().wallLit(0.55, 0.8),
    delay(0.6, st().frustum(1, 1.6, easeInOutCubic)),
    delay(1.6, st().zone(1, 0.8)),
    delay(1.2, st().figures(1, 0.6)),
    delay(1.8, ir().x(PANEL.x, 1.0, easeOutCubic)),
    delay(2.0, dp().x(PANEL.x, 1.0, easeOutCubic)),
  );
  // the first pulse: the pictures fill in as the light comes back, near first
  st().pulseStart(T());
  yield all(...moveTo(st(), SHOTS.sidePanels2, duration('sensor') - 3.0, easeInOutSine));
  yield* all(
    st().pulses(1, 0.3),
    cap.show('Die Kinect misst mit Infrarot-Licht,\nwie weit alles entfernt ist.'),
    ir().depthMax(6, PULSE_RUN, linear),
    dp().depthMax(6, PULSE_RUN, linear),
  );
  yield* all(ir().edge(0, 0.5), dp().edge(0, 0.5));
  yield* until(duration('sensor') - 0.9);
  yield* all(st().pulses(0, 0.5), cap.hide(0.4));
  yield* until(duration('sensor'));
});
