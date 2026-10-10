// 1 · Aufbau: for a moment first the Nacht der kreativen Köpfe and what the installation is (in the
// look of ndkk.de); it wipes up, the title comes, and the room builds itself: floor, truss, the LED
// wall cabinet by cabinet, then the Kinect in front of it.

import { Node, Txt, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInCubic, easeInOutSine, easeOutCubic, linear } from '@motion-canvas/core';
import { TEXT } from '../lib/layout';
import { NDKK_COLORS } from '../lib/ndkk';
import { SHOTS, begin, moveTo, setShot, until } from '../lib/shots';
import { cue } from '../lib/sound';
import { C, FONT } from '../lib/theme';
import { SCENES, duration } from '../lib/timeline';
import { Stage } from '../nodes/Stage';
import { ndkkBackdrop, ndkkLogo } from '../nodes/ndkk';
import { chapterBar } from '../nodes/ui';

/** how long the NDKK picture stands before the room starts building (it wipes away from here) */
const INTRO = 1.6;
const PITCH_Y = 250;

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.aufbau);
  const st = createRef<Stage>();
  const title = createRef<Txt>();
  const intro = createRef<Node>();
  const pitch = createRef<Txt>();
  view.add(<Stage ref={st} time={T} textScale={TEXT} grid={0} truss={0} wall={0} kinect={0} roomAlpha={0} wallContent={'test'} wallLit={1} />);
  view.add(
    <Txt ref={title} text={'So funktioniert die Kinect-Wand'} fontFamily={FONT} fontWeight={700} fontSize={84} fill={C.text} y={-40} opacity={0} shadowColor={'rgba(0,0,0,0.9)'} shadowBlur={24} />,
  );
  setShot(st(), SHOTS.roomStart);
  yield chapterBar(view, 0);
  // the NDKK picture on top of everything, already there in the first frame
  view.add(
    <Node ref={intro}>
      {ndkkBackdrop({ time: T, width: 1920, height: 1080 })}
      {ndkkLogo({ width: 1100, top: -330 })}
      <Txt ref={pitch} text={'Die magische Videowand'} fontFamily={FONT} fontWeight={800} fontSize={104} letterSpacing={-1} fill={NDKK_COLORS.navy} y={PITCH_Y} />
    </Node>,
  );
  yield all(...moveTo(st(), SHOTS.roomEnd, duration('aufbau') - INTRO, easeInOutSine));

  const I = INTRO;
  cue(T, 'chord', 0.02);
  cue(T, 'word', I - 0.15, { gain: 0.7 });
  cue(T, 'rise', I, { dur: 1.8 });
  cue(T, 'title', I + 0.2);
  cue(T, 'build', I + 0.9, { dur: 2.2 });
  cue(T, 'panels', I + 2.6, { dur: 3.0, n: 22, pan: -0.8, panTo: 0.8 });
  cue(T, 'powerup', I + 5.4, { dur: 1.1 });
  for (const at of [5.9, 6.25, 6.6]) cue(T, 'tick', I + at, { pan: -0.3 });
  cue(T, 'ping', I + 6.4);
  yield* all(
    // a little life while it stands, then up and away
    pitch().y(PITCH_Y - 16, I, easeOutCubic),
    delay(I - 0.2, intro().y(-1080, 0.45, easeInCubic)),
    delay(I + 0.2, all(title().opacity(1, 0.7, easeOutCubic), title().y(-60, 0.7, easeOutCubic))),
    delay(I + 2.4, all(title().opacity(0, 0.5, easeInCubic), title().y(-80, 0.5, easeInCubic))),
    delay(I - 0.2, st().grid(1, 1.6, easeOutCubic)),
    delay(I + 0.4, st().roomAlpha(0.5, 1.6, easeOutCubic)),
    delay(I + 0.9, st().truss(1, 2.2, linear)),
    delay(I + 2.6, st().wall(1, 3.0, linear)),
    delay(I + 5.4, st().kinect(1, 1.1, linear)),
    delay(I + 6.4, st().ping(1, 0.9, easeOutCubic)),
    delay(I + 5.9, st().labels(1, 1.6, linear)),
    delay(I + 6.4, st().dims(1, 1.2, easeOutCubic)),
  );
  yield* until(duration('aufbau'));
});
