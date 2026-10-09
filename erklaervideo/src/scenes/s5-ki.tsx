// 5 · KI-Tracking: the infrared picture large; a scan, boxes around the people, 17 points, the
// skeleton. Then the skeletons lift out of the picture into 3D.

import { makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInOutCubic, easeInOutSine, easeOutCubic, linear } from '@motion-canvas/core';
import { SHOTS, begin, moveTo, setShot, until } from '../lib/shots';
import { SCENES, duration } from '../lib/timeline';
import { SensorPanel } from '../nodes/SensorPanel';
import { Stage } from '../nodes/Stage';
import { Caption, chapterBar } from '../nodes/ui';

const KI = { w: 900, h: 745, x: 0, y: -40 };

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.ki);
  const st = createRef<Stage>();
  const ki = createRef<SensorPanel>();
  view.add(
    <Stage
      ref={st}
      time={T}
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
  setShot(st(), SHOTS.kinectC);
  view.add(<SensorPanel ref={ki} time={T} mode={'ir'} width={KI.w} height={KI.h} x={KI.x} y={KI.y} opacity={0} scale={0.94} />);
  const cap = new Caption(view);
  yield chapterBar(view, 4);

  yield* all(
    st().streaks(0, 0.6),
    st().colorFlow(0, 0.8),
    st().opacity(0.15, 1.0),
    delay(0.3, all(ki().opacity(1, 0.8, easeOutCubic), ki().scale(1, 0.8, easeOutCubic))),
    delay(0.4, cap.show('Eine KI erkennt die Menschen und ihr Skelett.')),
  );
  yield* all(
    ki().scan(1, 1.4, linear),
    delay(1.2, ki().boxes(1, 1.4, linear)),
    delay(2.6, ki().points(1, 1.6, linear)),
    delay(3.2, ki().pointLabels(1, 1.0, linear)),
    delay(4.2, ki().bones(1, 1.4, linear)),
    delay(5.0, ki().colorize(1, 0.8)),
    delay(5.4, ki().pointLabels(0, 0.5)),
  );
  // lift the skeletons into 3D
  yield* st().opacity(0, 0.4);
  setShot(st(), SHOTS.kinectK);
  st().colorFlow(0);
  st().streaks(0);
  st().colorMask(1);
  st().maskGrow(0);
  st().skel(1);
  st().skelFly(0);
  yield* all(
    st().opacity(1, 1.0),
    st().skelFly(1, 1.6, easeInOutCubic),
    ki().opacity(0, 0.9),
  );
  yield* all(...moveTo(st(), SHOTS.kinectD, 2.5, easeInOutSine));
  yield* until(duration('ki') - 0.45);
  yield* cap.hide(0.4);
  yield* until(duration('ki'));
});
