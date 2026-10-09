// Social 2 · Sichtfeld, Infrarot, Abstand (portrait, quick): the field of view grows out of the
// Kinect, the people walk in, the two pictures slide in below and fill up with the first infrared
// pulse, near first.

import { makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInOutCubic, easeInOutSine, easeOutCubic, linear } from '@motion-canvas/core';
import { CAPTION, P, PAIR, PAIR_X } from '../../lib/portrait';
import { SOCIAL_SHOTS, begin, moveTo, setShot, until } from '../../lib/shots';
import { cue } from '../../lib/sound';
import { SCENES, duration } from '../../lib/timeline';
import { SensorPanel } from '../../nodes/SensorPanel';
import { Stage } from '../../nodes/Stage';
import { Caption, topShade } from '../../nodes/ui';

/** the first pulse runs from 0.5 m to 6 m in this time (as fast as the pulses in the stage) */
const PULSE_RUN = 5.5 / 2.42;

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.sensor);
  const st = createRef<Stage>();
  const ir = createRef<SensorPanel>();
  const dp = createRef<SensorPanel>();
  view.add(<Stage ref={st} time={T} width={P.w} height={P.h} textScale={P.text} wallLit={1} labels={1} dims={1} roomAlpha={0.5} />);
  setShot(st(), SOCIAL_SHOTS.roomEnd);
  topShade(view, P.w, P.h);
  const panel = { width: PAIR.w, height: PAIR.h, depthMax: 0.5, edge: 1, textScale: P.text };
  view.add(<SensorPanel ref={ir} time={T} mode={'ir'} title={'Infrarot'} {...panel} x={PAIR_X[0]} y={PAIR.y + PAIR.out} />);
  view.add(<SensorPanel ref={dp} time={T} mode={'depth'} title={'Abstand'} legend={1} {...panel} x={PAIR_X[1]} y={PAIR.y + PAIR.out} />);
  const cap = new Caption(view, CAPTION.x, CAPTION.y, CAPTION.style);

  cue(T, 'whoosh', 0, { dur: 1.8, gain: 0.45, pan: -0.3, panTo: 0.3 });
  cue(T, 'scan', 0.3, { dur: 1.1, pan: 0, panTo: -0.5 });
  yield* all(
    ...moveTo(st(), SOCIAL_SHOTS.sidePanels, 1.8, easeInOutCubic),
    st().labels(0, 0.4),
    st().dims(0, 0.4),
    st().wallLit(0.55, 0.6),
    delay(0.3, st().frustum(1, 1.1, easeInOutCubic)),
    delay(0.9, st().zone(1, 0.6)),
    delay(0.5, st().figures(1, 0.5)),
    delay(1.0, ir().y(PAIR.y, 0.8, easeOutCubic)),
    delay(1.15, dp().y(PAIR.y, 0.8, easeOutCubic)),
  );
  // the first pulse: the pictures fill in as the light comes back, near first
  st().pulseStart(T());
  cue(T, 'pulses', 0, { dur: duration('sensor') - 0.6 + 0.3 - (T() - SCENES.sensor) });
  yield all(...moveTo(st(), SOCIAL_SHOTS.sidePanels2, duration('sensor') - (T() - SCENES.sensor), easeInOutSine));
  yield* all(
    st().pulses(1, 0.3),
    cap.show('Die Kinect misst mit\nInfrarot-Licht, wie weit\nalles entfernt ist.'),
    ir().depthMax(6, PULSE_RUN, linear),
    dp().depthMax(6, PULSE_RUN, linear),
  );
  yield* all(ir().edge(0, 0.4), dp().edge(0, 0.4));
  yield* until(duration('sensor') - 0.6);
  yield* all(st().pulses(0, 0.4), cap.hide(0.35));
  yield* until(duration('sensor'));
});
