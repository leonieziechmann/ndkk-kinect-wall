// Placeholder for stage 0 (Kabel richtig aufwickeln); replaced by the real scene.

import { Txt, makeScene2D } from '@motion-canvas/2d';
import { waitFor } from '@motion-canvas/core';
import { C, FONT } from '../lib/theme';
import { StageBar, begin } from '../lib/ui';

export default makeScene2D(function* (view) {
  yield* begin(view);
  view.add(<StageBar current={0} />);
  view.add(<Txt text={'Kabel richtig aufwickeln (in Arbeit)'} fontFamily={FONT} fontWeight={700} fontSize={60} fill={C.text} />);
  yield* waitFor(2);
});
