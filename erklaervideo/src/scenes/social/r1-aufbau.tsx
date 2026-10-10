// Social 1 · Aufbau (portrait, quick): for a moment first the Nacht der kreativen Köpfe and what the
// installation is (the very first frame of the Reel, in the look of ndkk.de); it wipes up, the title
// comes, and the room builds itself: floor, truss, the LED wall, the Kinect, with labels.

import { Node, Txt, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInCubic, easeInOutSine, easeOutCubic, linear } from '@motion-canvas/core';
import { NDKK_COLORS } from '../../lib/ndkk';
import { P } from '../../lib/portrait';
import { SOCIAL_SHOTS, begin, moveTo, setShot, until } from '../../lib/shots';
import { cue } from '../../lib/sound';
import { C, FONT } from '../../lib/theme';
import { SCENES, duration } from '../../lib/timeline';
import { Stage } from '../../nodes/Stage';
import { ndkkBackdrop, ndkkLogo } from '../../nodes/ndkk';

const TITLE_Y = -470;
/** how long the NDKK picture stands before the room starts building (it wipes away from here) */
const INTRO = 1.2;
const PITCH_Y = 190;

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.aufbau);
  const st = createRef<Stage>();
  const title = createRef<Txt>();
  const intro = createRef<Node>();
  const pitch = createRef<Txt>();
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
  // the NDKK picture on top of everything, already there in the first frame
  view.add(
    <Node ref={intro}>
      {ndkkBackdrop({ time: T, width: P.w, height: P.h })}
      {ndkkLogo({ width: 900, top: -380 })}
      <Txt
        ref={pitch}
        text={'Die magische\nVideowand'}
        textAlign={'center'}
        fontFamily={FONT}
        fontWeight={800}
        fontSize={104}
        lineHeight={112}
        letterSpacing={-1}
        fill={NDKK_COLORS.navy}
        y={PITCH_Y}
      />
    </Node>,
  );
  setShot(st(), SOCIAL_SHOTS.roomStart);
  yield all(...moveTo(st(), SOCIAL_SHOTS.roomEnd, duration('aufbau') - INTRO, easeInOutSine));

  cue(T, 'chord', 0.02);
  cue(T, 'word', INTRO - 0.15, { gain: 0.7 });
  cue(T, 'rise', INTRO, { dur: 1.4 });
  cue(T, 'title', INTRO + 0.1);
  cue(T, 'build', INTRO + 0.6, { dur: 1.6 });
  cue(T, 'panels', INTRO + 2.0, { dur: 2.0, n: 16, pan: -0.8, panTo: 0.8 });
  cue(T, 'powerup', INTRO + 3.9, { dur: 0.9 });
  for (const at of [4.3, 4.6, 4.9]) cue(T, 'tick', INTRO + at, { pan: -0.3 });
  cue(T, 'ping', INTRO + 4.7);
  yield* all(
    // a little life while it stands, then up and away
    pitch().y(PITCH_Y - 14, INTRO, easeOutCubic),
    delay(INTRO - 0.2, intro().y(-P.h, 0.45, easeInCubic)),
    delay(INTRO + 0.1, all(title().opacity(1, 0.5, easeOutCubic), title().y(TITLE_Y, 0.5, easeOutCubic))),
    delay(INTRO + 2.7, all(title().opacity(0, 0.45, easeInCubic), title().y(TITLE_Y - 24, 0.45, easeInCubic))),
    delay(INTRO - 0.2, st().grid(1, 1.4, easeOutCubic)),
    delay(INTRO + 0.3, st().roomAlpha(0.5, 1.2, easeOutCubic)),
    delay(INTRO + 0.6, st().truss(1, 1.6, linear)),
    delay(INTRO + 2.0, st().wall(1, 2.0, linear)),
    delay(INTRO + 3.9, st().kinect(1, 0.9, linear)),
    delay(INTRO + 4.7, st().ping(1, 0.8, easeOutCubic)),
    delay(INTRO + 4.3, st().labels(1, 1.2, linear)),
    delay(INTRO + 4.7, st().dims(1, 0.9, easeOutCubic)),
  );
  yield* until(duration('aufbau'));
});
