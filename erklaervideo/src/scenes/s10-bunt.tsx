// 10 · Bunt: the last picture before the video starts over. The whole screen becomes a rainbow flag
// of LED dots, like the Modern Events logo, waving a little in the wind. On it "COTTBUS IST BUNT"
// lights up in white dots, then COTTBUS is rewritten into DIE ZUKUNFT: "DIE ZUKUNFT IST BUNT".
// Then black.

import { Rect, makeScene2D } from '@motion-canvas/2d';
import { createRef, delay, all, easeInOutCubic, easeInOutSine, linear } from '@motion-canvas/core';
import { begin, until } from '../lib/shots';
import { SCENES, duration } from '../lib/timeline';
import { LedFlag } from '../nodes/LedFlag';

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.bunt);
  const local = () => T() - SCENES.bunt;
  const flag = createRef<LedFlag>();
  const black = createRef<Rect>();
  view.add(<LedFlag ref={flag} width={1920} height={1080} pitch={12} time={local} reveal={0} letters={0} swap={0} word={'COTTBUS'} word2={'DIE ZUKUNFT'} rest={'IST BUNT'} />);
  view.add(<Rect ref={black} width={1920} height={1080} fill={'#000'} opacity={0} />);

  yield* all(flag().reveal(1, 1.4, linear), delay(1.0, flag().letters(1, 1.2, linear)));
  // read "COTTBUS IST BUNT", then COTTBUS becomes DIE ZUKUNFT
  yield* until(4.4);
  yield* flag().swap(1, 1.3, easeInOutSine);
  yield* until(duration('bunt') - 1.2);
  yield* black().opacity(1, 1.1, easeInOutCubic);
  yield* until(duration('bunt'));
});
