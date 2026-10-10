// 5 · KI-Tracking: the infrared picture large; a scan, boxes around the people, 17 points, the
// skeleton. Then the skeletons lift out of the picture into 3D.

import { makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInOutCubic, easeInOutSine, easeOutCubic, linear } from '@motion-canvas/core';
import { TEXT } from '../lib/layout';
import { SHOTS, begin, moveTo, setShot, until } from '../lib/shots';
import { cue } from '../lib/sound';
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
      textScale={TEXT}
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
  setShot(st(), SHOTS.kinectC2);
  view.add(<SensorPanel ref={ki} time={T} mode={'ir'} width={KI.w} height={KI.h} x={KI.x} y={KI.y} opacity={0} scale={0.94} textScale={TEXT} />);
  const cap = new Caption(view);
  yield chapterBar(view, 4);

  cue(T, 'pop', 0.25, { n: 0, gain: 0.8 });
  yield* all(
    st().streaks(0, 0.5),
    st().colorFlow(0, 0.7),
    st().opacity(0.15, 0.9),
    delay(0.25, all(ki().opacity(1, 0.7, easeOutCubic), ki().scale(1, 0.7, easeOutCubic))),
    delay(0.35, cap.show('Eine KI erkennt die Menschen und ihr Skelett.')),
  );
  cue(T, 'scan', 0, { dur: 1.0, pan: -0.6, panTo: 0.6 });
  cue(T, 'lock', 0.95, { pan: -0.35 });
  cue(T, 'lock', 1.5, { pan: 0.35 });
  cue(T, 'dots', 1.9, { dur: 1.2, n: 30 });
  for (const at of [2.4, 2.7, 3.0]) cue(T, 'tick', at, { pan: 0.4 });
  cue(T, 'connect', 3.1, { dur: 1.0 });
  cue(T, 'chord', 3.7);
  yield* all(
    ki().scan(1, 1.0, linear),
    delay(0.85, ki().boxes(1, 1.0, linear)),
    delay(1.9, ki().points(1, 1.2, linear)),
    delay(2.4, ki().pointLabels(1, 0.8, linear)),
    delay(3.1, ki().bones(1, 1.0, linear)),
    delay(3.7, ki().colorize(1, 0.6)),
    delay(4.3, ki().pointLabels(0, 0.45)),
  );
  // lift the skeletons into 3D
  cue(T, 'lift', 0.35, { dur: 1.45 });
  yield* st().opacity(0, 0.35);
  setShot(st(), SHOTS.kinectK);
  st().colorFlow(0);
  st().streaks(0);
  st().colorMask(1);
  st().maskGrow(0);
  st().skel(1);
  st().skelFly(0);
  yield* all(
    st().opacity(1, 0.9),
    st().skelFly(1, 1.45, easeInOutCubic),
    ki().opacity(0, 0.8),
  );
  const rest = duration('ki') - (T() - SCENES.ki);
  // up to the cut (alongside: until() alone decides where the scene ends, to the frame)
  yield all(...moveTo(st(), SHOTS.kinectD, rest, easeInOutSine), delay(rest - 0.45, cap.hide(0.4)));
  yield* until(duration('ki'));
});
