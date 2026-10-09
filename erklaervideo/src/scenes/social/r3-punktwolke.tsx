// Social 3 · Punktwolke (portrait, quick): one pixel of the depth picture becomes a point in the
// room; then the camera turns to the Kinect's direction and the picture flies into the room, far
// first, near last.

import { makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInOutCubic, easeInOutSine, linear } from '@motion-canvas/core';
import { CAPTION, P, PAIR, PAIR_X } from '../../lib/portrait';
import { SOCIAL_SHOTS, begin, moveTo, setShot, until } from '../../lib/shots';
import { cue } from '../../lib/sound';
import { SCENES, duration } from '../../lib/timeline';
import { SensorPanel } from '../../nodes/SensorPanel';
import { Stage, flightCut } from '../../nodes/Stage';
import { Caption, topShade } from '../../nodes/ui';

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.punktwolke);
  const st = createRef<Stage>();
  const ir = createRef<SensorPanel>();
  const dp = createRef<SensorPanel>();
  view.add(
    <Stage
      ref={st}
      time={T}
      width={P.w}
      height={P.h}
      textScale={P.text}
      wallLit={0.55}
      roomAlpha={0.5}
      frustum={1}
      zone={1}
      figures={1}
      flyX={PAIR_X[1]}
      flyY={PAIR.y}
      flyW={PAIR.w}
      flyH={PAIR.h}
      cloudFly={0}
    />,
  );
  setShot(st(), SOCIAL_SHOTS.sidePanels2);
  topShade(view, P.w, P.h);
  const panel = { width: PAIR.w, height: PAIR.h, textScale: P.text };
  view.add(<SensorPanel ref={ir} time={T} mode={'ir'} title={'Infrarot'} {...panel} x={PAIR_X[0]} y={PAIR.y} />);
  view.add(<SensorPanel ref={dp} time={T} mode={'depth'} title={'Abstand'} legend={1} {...panel} x={PAIR_X[1]} y={PAIR.y} />);
  const cap = new Caption(view, CAPTION.x, CAPTION.y, CAPTION.style);

  // one pixel: its ray out of the lens and its distance give a point in the room
  cue(T, 'select', 0.1, { pan: 0.5 });
  cue(T, 'zap', 0.4, { dur: 0.7, pan: 0.5, panTo: 0 });
  cue(T, 'laser', 0.9, { dur: 1.0, pan: 0, panTo: -0.3 });
  cue(T, 'ping', 1.7, { pan: -0.3, gain: 0.8 });
  yield* all(
    cap.show('Aus jedem Bildpunkt\nwird ein Punkt im Raum.'),
    delay(0.1, dp().pixel(1, 0.4)),
    delay(0.4, st().rayLink(1, 0.7, easeInOutCubic)),
    delay(0.9, st().ray(1, 1.1, linear)),
  );
  // round to the Kinect's direction; the drawn room fades
  cue(T, 'whoosh', 0, { dur: 1.3, gain: 0.6, pan: 0.4, panTo: -0.4 });
  yield* all(
    dp().pixel(0, 0.3),
    st().ray(0, 0.4),
    st().rayLink(0, 0.4),
    ir().y(PAIR.y + PAIR.out, 0.8, easeInOutCubic),
    st().figures(0, 0.8),
    st().zone(0, 0.6),
    st().wallAlpha(0, 0.6),
    st().frustumAlpha(0.22, 1.0),
    st().roomAlpha(0, 0.8),
    delay(0.5, st().kinectAlpha(0, 0.5)),
    ...moveTo(st(), SOCIAL_SHOTS.kinectA, 1.3, easeInOutCubic),
  );
  // the picture flies into the room: far first, near last; it empties in the same order
  st().cloud(1);
  cue(T, 'swarm', 0, { dur: 2.0 });
  dp().depthMax(() => flightCut(st().cloudFly()));
  yield* st().cloudFly(1, 2.0, linear);
  const rest = duration('punktwolke') - (T() - SCENES.punktwolke);
  yield* all(dp().y(PAIR.y + PAIR.out, 0.7, easeInOutCubic), ...moveTo(st(), SOCIAL_SHOTS.kinectB, rest, easeInOutSine), delay(rest - 0.45, cap.hide(0.4)));
  yield* until(duration('punktwolke'));
});
