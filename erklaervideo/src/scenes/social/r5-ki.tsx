// Social 5 · KI-Tracking (portrait, quick): the infrared picture large; a scan, boxes, 17 points, the
// skeleton; then the skeletons lift out of the picture into 3D.

import { makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInOutCubic, easeInOutSine, easeOutCubic, linear } from '@motion-canvas/core';
import { CAPTION, P } from '../../lib/portrait';
import { SOCIAL_SHOTS, begin, moveTo, setShot, until } from '../../lib/shots';
import { cue } from '../../lib/sound';
import { SCENES, duration } from '../../lib/timeline';
import { SensorPanel } from '../../nodes/SensorPanel';
import { Stage } from '../../nodes/Stage';
import { Caption, topShade } from '../../nodes/ui';

const KI = { w: 1000, h: 828, x: 0, y: 30 };

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.ki);
  const st = createRef<Stage>();
  const ki = createRef<SensorPanel>();
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
      colorFlow={1}
      streaks={1}
      flyX={KI.x}
      flyY={KI.y}
      flyW={KI.w}
      flyH={KI.h}
    />,
  );
  setShot(st(), SOCIAL_SHOTS.kinectC2);
  topShade(view, P.w, P.h);
  view.add(<SensorPanel ref={ki} time={T} mode={'ir'} width={KI.w} height={KI.h} x={KI.x} y={KI.y} opacity={0} scale={0.94} textScale={P.text} />);
  const cap = new Caption(view, CAPTION.x, CAPTION.y, CAPTION.style);

  cue(T, 'pop', 0.2, { n: 0, gain: 0.8 });
  yield* all(
    st().streaks(0, 0.5),
    st().colorFlow(0, 0.6),
    st().opacity(0.15, 0.8),
    delay(0.2, all(ki().opacity(1, 0.6, easeOutCubic), ki().scale(1, 0.6, easeOutCubic))),
    delay(0.2, cap.show('Eine KI erkennt Menschen\nund ihr Skelett.')),
  );
  cue(T, 'scan', 0, { dur: 0.9, pan: -0.6, panTo: 0.6 });
  cue(T, 'lock', 0.85, { pan: -0.35 });
  cue(T, 'lock', 1.3, { pan: 0.35 });
  cue(T, 'dots', 1.6, { dur: 1.0, n: 26 });
  for (const at of [2.0, 2.25, 2.5]) cue(T, 'tick', at, { pan: 0.4 });
  cue(T, 'connect', 2.6, { dur: 0.9 });
  cue(T, 'chord', 3.2);
  yield* all(
    ki().scan(1, 0.9, linear),
    delay(0.7, ki().boxes(1, 0.9, linear)),
    delay(1.6, ki().points(1, 1.0, linear)),
    delay(2.0, ki().pointLabels(1, 0.7, linear)),
    delay(2.6, ki().bones(1, 0.9, linear)),
    delay(3.2, ki().colorize(1, 0.5)),
    delay(3.7, ki().pointLabels(0, 0.4)),
  );
  // lift the skeletons into 3D
  cue(T, 'lift', 0.3, { dur: 1.3 });
  yield* st().opacity(0, 0.3);
  setShot(st(), SOCIAL_SHOTS.kinectK);
  st().colorFlow(0);
  st().streaks(0);
  st().colorMask(1);
  st().maskGrow(0);
  st().skel(1);
  st().skelFly(0);
  yield* all(st().opacity(1, 0.8), st().skelFly(1, 1.3, easeInOutCubic), ki().opacity(0, 0.7));
  cue(T, 'whoosh', 0, { dur: 1.1, gain: 0.25, pan: 0.3, panTo: -0.3 });
  yield* all(...moveTo(st(), SOCIAL_SHOTS.kinectD, duration('ki') - (T() - SCENES.ki), easeInOutSine), delay(duration('ki') - (T() - SCENES.ki) - 0.45, cap.hide(0.4)));
  yield* until(duration('ki'));
});
