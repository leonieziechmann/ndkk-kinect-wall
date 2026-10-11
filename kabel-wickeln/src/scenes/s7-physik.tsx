// Placeholder for stage 7 (Für Neugierige: die Physik); replaced by the real scene.

import { Txt, makeScene2D } from '@motion-canvas/2d';
import { waitFor } from '@motion-canvas/core';
import { C, FONT } from '../lib/theme';
import { StageBar, begin, stopCard } from '../lib/ui';

export default makeScene2D(function* (view) {
  yield* begin(view);
  view.add(<StageBar current={7} />);
  view.add(<Txt text={'Für Neugierige: die Physik (in Arbeit)'} fontFamily={FONT} fontWeight={700} fontSize={60} fill={C.text} />);
  yield* waitFor(2);
  yield* stopCard(view, 7);
});
