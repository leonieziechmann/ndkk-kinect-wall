// Placeholder for stage 2 (Warum das funktioniert); replaced by the real scene.

import { Txt, makeScene2D } from '@motion-canvas/2d';
import { waitFor } from '@motion-canvas/core';
import { C, FONT } from '../lib/theme';
import { StageBar, begin, stopCard } from '../lib/ui';

export default makeScene2D(function* (view) {
  yield* begin(view);
  view.add(<StageBar current={2} />);
  view.add(<Txt text={'Warum das funktioniert (in Arbeit)'} fontFamily={FONT} fontWeight={700} fontSize={60} fill={C.text} />);
  yield* waitFor(2);
  yield* stopCard(view, 2);
});
