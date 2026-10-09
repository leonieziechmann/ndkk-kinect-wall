// Social 8 · Interaktion (portrait, quick): back in the room, behind the audience; the people move in
// front of the wall and the fluid follows them. Then black.

import { Rect, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInOutCubic, easeInOutSine } from '@motion-canvas/core';
import { CAPTION, P, WALL_P } from '../../lib/portrait';
import { SOCIAL_SHOTS, begin, moveTo, setShot, until } from '../../lib/shots';
import { cue } from '../../lib/sound';
import { SCENES, duration } from '../../lib/timeline';
import { Stage } from '../../nodes/Stage';
import { WallView } from '../../nodes/WallView';
import { Caption, topShade } from '../../nodes/ui';

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.wand);
  const st = createRef<Stage>();
  const wall = createRef<WallView>();
  const black = createRef<Rect>();
  // the room comes in around the wall picture of scene 7
  view.add(<Stage ref={st} time={T} width={P.w} height={P.h} textScale={P.text} wallContent={'fluid'} wallLit={1} roomAlpha={0} figures={1} silhouette={1} spill={1} opacity={0} />);
  setShot(st(), SOCIAL_SHOTS.wallClose);
  view.add(<WallView ref={wall} time={T} x={WALL_P.x} y={WALL_P.y} width={WALL_P.w} height={WALL_P.h} fluid={1} skel={0.55} textScale={P.text} />);
  topShade(view, P.w, P.h);
  view.add(<Rect ref={black} width={P.w} height={P.h} fill={'#000'} opacity={0} />);
  const cap = new Caption(view, CAPTION.x, CAPTION.y, CAPTION.style);

  cue(T, 'whoosh', 0, { dur: 3.0, gain: 0.35 });
  yield* all(st().opacity(1, 0.6), delay(0.2, wall().opacity(0, 0.7)), ...moveTo(st(), SOCIAL_SHOTS.wallWide, 3.0, easeInOutCubic), delay(0.6, cap.show('Deine Bewegung malt\nauf der Wand.')));
  yield* all(...moveTo(st(), SOCIAL_SHOTS.wallWideEnd, 3.3, easeInOutSine), delay(2.9, cap.hide(0.4)));
  yield* until(duration('wand') - 0.8);
  cue(T, 'black', 0, { dur: 0.8 });
  yield* black().opacity(1, 0.8);
  yield* until(duration('wand'));
});
