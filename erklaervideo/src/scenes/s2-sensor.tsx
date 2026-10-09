// 2 · Sichtfeld, Infrarot, Tiefe: the field of view grows out of the Kinect, two people walk in,
// infrared pulses run through the room, then the two pictures of the Kinect slide in.

import { makeScene2D } from '@motion-canvas/2d';
import { all, chain, createRef, delay, easeInOutCubic, easeOutCubic } from '@motion-canvas/core';
import { PANEL } from '../lib/layout';
import { SHOTS, begin, moveTo, setShot, until } from '../lib/shots';
import { SCENES, duration } from '../lib/timeline';
import { SensorPanel } from '../nodes/SensorPanel';
import { Stage } from '../nodes/Stage';
import { Caption, chapterBar } from '../nodes/ui';

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.sensor);
  const st = createRef<Stage>();
  const ir = createRef<SensorPanel>();
  const dp = createRef<SensorPanel>();
  view.add(<Stage ref={st} time={T} wallContent={'test'} wallLit={1} labels={1} dims={1} roomAlpha={0.5} />);
  setShot(st(), SHOTS.roomEnd);
  view.add(<SensorPanel ref={ir} time={T} mode={'ir'} title={'Infrarot'} width={PANEL.w} height={PANEL.h} x={PANEL.x + PANEL.out} y={PANEL.yTop} />);
  view.add(<SensorPanel ref={dp} time={T} mode={'depth'} title={'Abstand'} legend={1} width={PANEL.w} height={PANEL.h} x={PANEL.x + PANEL.out} y={PANEL.yBottom} />);
  const cap = new Caption(view);
  yield chapterBar(view, 1);

  yield* all(
    ...moveTo(st(), SHOTS.side, 2.4, easeInOutCubic),
    st().labels(0, 0.5),
    st().dims(0, 0.5),
    chain(st().wallLit(0, 0.5), () => st().wallContent('idle'), st().wallLit(0.7, 0.8)),
    delay(0.9, st().frustum(1, 1.8, easeInOutCubic)),
    delay(1.8, st().zone(1, 1.0)),
    delay(1.4, st().figures(1, 0.6)),
  );
  // infrared pulses
  st().pulseStart(T());
  yield* all(
    cap.show('Die Kinect misst mit Infrarot-Licht,\nwie weit alles entfernt ist.'),
    st().pulses(1, 0.6),
  );
  yield* until(6.6);
  yield* all(
    st().pulses(0, 0.8),
    st().shiftX(-330, 1.4, easeInOutCubic),
    ir().x(PANEL.x, 1.2, easeOutCubic),
    delay(0.25, dp().x(PANEL.x, 1.2, easeOutCubic)),
  );
  yield* until(duration('sensor') - 0.4);
  yield* cap.hide(0.4);
  yield* until(duration('sensor'));
});
