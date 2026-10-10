// 3 · Punktwolke: one pixel of the depth picture becomes a point in the room (its ray and its
// distance). The camera swings round to look from the Kinect, then the picture flies into the room,
// the far wall first and what is nearest to the camera last: the room builds up from back to front.

import { makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInOutCubic, easeInOutSine, linear } from '@motion-canvas/core';
import { PANEL, PANEL_GAP, TEXT } from '../lib/layout';
import { SHOTS, begin, moveTo, setShot, until } from '../lib/shots';
import { cue } from '../lib/sound';
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
      textScale={TEXT}
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
  view.add(<SensorPanel ref={ir} time={T} mode={'ir'} title={'Infrarot'} textScale={TEXT} titlePlate={PANEL_GAP} width={PANEL.w} height={PANEL.h} x={PANEL.x} y={PANEL.yTop} />);
  view.add(<SensorPanel ref={dp} time={T} mode={'depth'} title={'Abstand'} legend={1} textScale={TEXT} titlePlate={PANEL_GAP} width={PANEL.w} height={PANEL.h} x={PANEL.x} y={PANEL.yBottom} />);
  const cap = new Caption(view);
  yield chapterBar(view, 2);

  // one pixel: its ray out of the lens and its distance give a point in the room
  cue(T, 'select', 0.15, { pan: 0.55 });
  cue(T, 'zap', 0.55, { dur: 0.75, pan: 0.5, panTo: 0 });
  cue(T, 'laser', 1.2, { dur: 0.9, pan: 0, panTo: -0.3 });
  cue(T, 'ping', 1.95, { pan: -0.3, gain: 0.8 });
  yield* all(
    cap.show('Aus jedem Bildpunkt wird ein Punkt im Raum.'),
    delay(0.15, dp().pixel(1, 0.45)),
    delay(0.55, st().rayLink(1, 0.75, easeInOutCubic)),
    delay(1.2, st().ray(1, 1.3, linear)),
  );
  // round to the Kinect's direction; the drawn room fades
  cue(T, 'whoosh', 0, { dur: 1.5, gain: 0.6, pan: 0.4, panTo: -0.4 });
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
    ...moveTo(st(), SHOTS.kinectA, 1.5, easeInOutCubic),
  );
  // the picture flies into the room: far first, near last; it empties in the same order
  st().cloud(1);
  cue(T, 'swarm', 0, { dur: 2.6 });
  dp().depthMax(() => flightCut(st().cloudFly()));
  yield* st().cloudFly(1, 2.6, linear);
  const rest = duration('punktwolke') - (T() - SCENES.punktwolke);
  yield* all(dp().x(PANEL.x + PANEL.out, 0.8, easeInOutCubic), ...moveTo(st(), SHOTS.kinectB, rest, easeInOutSine), delay(rest - 0.45, cap.hide(0.4)));
  yield* until(duration('punktwolke'));
});
