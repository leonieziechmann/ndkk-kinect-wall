// 2 · Sichtfeld, Infrarot, Tiefe: the field of view grows out of the Kinect, two people walk in, the
// two pictures of the Kinect slide in empty, and fill up with the first infrared pulse: what is near
// comes back first, the far wall last (the second sentence says so). Then they run live while the
// people arrive and wave.

import { makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInOutCubic, easeInOutSine, easeOutCubic, linear } from '@motion-canvas/core';
import { PANEL, PANEL_GAP, TEXT } from '../lib/layout';
import { SHOTS, begin, moveTo, setShot, until } from '../lib/shots';
import { cue } from '../lib/sound';
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
  view.add(<Stage ref={st} time={T} textScale={TEXT} wallLit={1} labels={1} dims={1} roomAlpha={0.5} />);
  setShot(st(), SHOTS.roomEnd);
  view.add(<SensorPanel ref={ir} time={T} mode={'ir'} title={'Infrarot'} depthMax={0.5} edge={1} textScale={TEXT} titlePlate={PANEL_GAP} width={PANEL.w} height={PANEL.h} x={PANEL.x + PANEL.out} y={PANEL.yTop} />);
  view.add(<SensorPanel ref={dp} time={T} mode={'depth'} title={'Abstand'} depthMax={0.5} edge={1} legend={1} textScale={TEXT} titlePlate={PANEL_GAP} width={PANEL.w} height={PANEL.h} x={PANEL.x + PANEL.out} y={PANEL.yBottom} />);
  const cap = new Caption(view);
  yield chapterBar(view, 1);

  cue(T, 'whoosh', 0, { dur: 2.2, gain: 0.45, pan: -0.3, panTo: 0.3 });
  cue(T, 'scan', 0.4, { dur: 1.4, pan: 0, panTo: -0.5 });
  yield* all(
    ...moveTo(st(), SHOTS.sidePanels, 2.2, easeInOutCubic),
    st().labels(0, 0.4),
    st().dims(0, 0.4),
    st().wallLit(0.55, 0.7),
    delay(0.4, st().frustum(1, 1.4, easeInOutCubic)),
    delay(1.3, st().zone(1, 0.7)),
    delay(0.9, st().figures(1, 0.5)),
    delay(1.4, ir().x(PANEL.x, 0.9, easeOutCubic)),
    delay(1.6, dp().x(PANEL.x, 0.9, easeOutCubic)),
  );
  // the first pulse: the pictures fill in as the light comes back, near first
  st().pulseStart(T());
  cue(T, 'pulses', 0, { dur: duration('sensor') - 0.9 + 0.3 - (T() - SCENES.sensor) });
  yield all(...moveTo(st(), SHOTS.sidePanels2, duration('sensor') - (T() - SCENES.sensor), easeInOutSine));
  yield* all(
    st().pulses(1, 0.3),
    cap.show('Die Kinect misst mit Infrarot-Licht,\nwie weit alles entfernt ist.'),
    ir().depthMax(6, PULSE_RUN, linear),
    dp().depthMax(6, PULSE_RUN, linear),
  );
  yield* all(ir().edge(0, 0.4), dp().edge(0, 0.4), cap.show('Was nah ist, kommt zuerst zurück.'));
  yield* until(duration('sensor') - 0.9);
  yield* all(st().pulses(0, 0.5), cap.hide(0.4));
  yield* until(duration('sensor'));
});
