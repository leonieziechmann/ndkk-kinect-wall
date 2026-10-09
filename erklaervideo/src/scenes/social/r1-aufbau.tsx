// Social 1 · Aufbau (portrait, quick): the title first, then the room builds itself: floor, truss,
// the LED wall, the Kinect, with labels.

import { Txt, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInCubic, easeInOutSine, easeOutCubic, linear } from '@motion-canvas/core';
import { P } from '../../lib/portrait';
import { SOCIAL_SHOTS, begin, moveTo, setShot, until } from '../../lib/shots';
import { cue } from '../../lib/sound';
import { C, FONT } from '../../lib/theme';
import { SCENES, duration } from '../../lib/timeline';
import { Stage } from '../../nodes/Stage';

const TITLE_Y = -470;

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.aufbau);
  const st = createRef<Stage>();
  const title = createRef<Txt>();
  view.add(<Stage ref={st} time={T} width={P.w} height={P.h} textScale={P.text} grid={0} truss={0} wall={0} kinect={0} roomAlpha={0} wallContent={'test'} wallLit={1} />);
  view.add(
    <Txt
      ref={title}
      text={'So funktioniert\ndie Kinect-Wand'}
      textAlign={'center'}
      fontFamily={FONT}
      fontWeight={800}
      fontSize={100}
      lineHeight={112}
      letterSpacing={-1}
      fill={C.text}
      y={TITLE_Y + 24}
      opacity={0}
      shadowColor={'rgba(0,0,0,0.9)'}
      shadowBlur={28}
    />,
  );
  setShot(st(), SOCIAL_SHOTS.roomStart);
  yield all(...moveTo(st(), SOCIAL_SHOTS.roomEnd, duration('aufbau'), easeInOutSine));

  cue(T, 'rise', 0, { dur: 1.4 });
  cue(T, 'title', 0.1);
  cue(T, 'build', 0.6, { dur: 1.6 });
  cue(T, 'panels', 2.0, { dur: 2.0, n: 16, pan: -0.8, panTo: 0.8 });
  cue(T, 'powerup', 3.9, { dur: 0.9 });
  for (const at of [4.3, 4.6, 4.9]) cue(T, 'tick', at, { pan: -0.3 });
  cue(T, 'ping', 4.7);
  yield* all(
    delay(0.1, all(title().opacity(1, 0.5, easeOutCubic), title().y(TITLE_Y, 0.5, easeOutCubic))),
    delay(2.7, all(title().opacity(0, 0.45, easeInCubic), title().y(TITLE_Y - 24, 0.45, easeInCubic))),
    st().grid(1, 1.2, easeOutCubic),
    delay(0.3, st().roomAlpha(0.5, 1.2, easeOutCubic)),
    delay(0.6, st().truss(1, 1.6, linear)),
    delay(2.0, st().wall(1, 2.0, linear)),
    delay(3.9, st().kinect(1, 0.9, linear)),
    delay(4.7, st().ping(1, 0.8, easeOutCubic)),
    delay(4.3, st().labels(1, 1.2, linear)),
    delay(4.7, st().dims(1, 0.9, easeOutCubic)),
  );
  yield* until(duration('aufbau'));
});
