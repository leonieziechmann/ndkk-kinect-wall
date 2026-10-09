// 1 · Aufbau: the room builds itself: floor, truss, the LED wall cabinet by cabinet, then the
// Kinect in front of it.

import { Txt, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInCubic, easeInOutSine, easeOutCubic, linear } from '@motion-canvas/core';
import { SHOTS, begin, moveTo, setShot, until } from '../lib/shots';
import { cue } from '../lib/sound';
import { C, FONT } from '../lib/theme';
import { SCENES, duration } from '../lib/timeline';
import { Stage } from '../nodes/Stage';
import { chapterBar } from '../nodes/ui';

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.aufbau);
  const st = createRef<Stage>();
  const title = createRef<Txt>();
  view.add(<Stage ref={st} time={T} grid={0} truss={0} wall={0} kinect={0} roomAlpha={0} wallContent={'test'} wallLit={1} />);
  view.add(
    <Txt ref={title} text={'So funktioniert die Kinect-Wand'} fontFamily={FONT} fontWeight={700} fontSize={84} fill={C.text} y={-40} opacity={0} shadowColor={'rgba(0,0,0,0.9)'} shadowBlur={24} />,
  );
  setShot(st(), SHOTS.roomStart);
  yield chapterBar(view, 0);
  yield all(...moveTo(st(), SHOTS.roomEnd, duration('aufbau'), easeInOutSine));

  cue(T, 'rise', 0, { dur: 2.0 });
  cue(T, 'title', 0.2);
  cue(T, 'build', 1.4, { dur: 3.0 });
  cue(T, 'panels', 3.8, { dur: 3.8, n: 24, pan: -0.8, panTo: 0.8 });
  cue(T, 'powerup', 7.6, { dur: 1.3 });
  for (const at of [8.0, 8.4, 8.8]) cue(T, 'tick', at, { pan: -0.3 });
  cue(T, 'ping', 8.85);
  yield* all(
    delay(0.2, all(title().opacity(1, 0.8, easeOutCubic), title().y(-60, 0.8, easeOutCubic))),
    delay(2.4, all(title().opacity(0, 0.6, easeInCubic), title().y(-80, 0.6, easeInCubic))),
    delay(0.0, st().grid(1, 2.0, easeOutCubic)),
    delay(0.6, st().roomAlpha(0.5, 2, easeOutCubic)),
    delay(1.4, st().truss(1, 3.0, linear)),
    delay(3.8, st().wall(1, 3.8, linear)),
    delay(7.6, st().kinect(1, 1.4, linear)),
    delay(8.85, st().ping(1, 0.9, easeOutCubic)),
    delay(8.0, st().labels(1, 2.0, linear)),
    delay(8.8, st().dims(1, 1.4, easeOutCubic)),
  );
  yield* until(duration('aufbau'));
});
