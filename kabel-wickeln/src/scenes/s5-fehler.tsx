// Placeholder for stage 5 (Fehler und wie du sie behebst); replaced by the real scene.

import { Txt, makeScene2D } from '@motion-canvas/2d';
import { waitFor } from '@motion-canvas/core';
import { C, FONT } from '../lib/theme';
import { StageBar, begin, stopCard } from '../lib/ui';

export default makeScene2D(function* (view) {
  yield* begin(view);
  view.add(<StageBar current={5} />);
  view.add(<Txt text={'Fehler und wie du sie behebst (in Arbeit)'} fontFamily={FONT} fontWeight={700} fontSize={60} fill={C.text} />);
  yield* waitFor(2);
  yield* stopCard(view, 5);
});
