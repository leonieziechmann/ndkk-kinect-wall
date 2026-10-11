// Stage 1, part 1: Noor coils the 5 m XLR cable over and under into her left hand (KONZEPT stage 1,
// items 1 and 2). Being rebuilt on the coiling engine (shots/coil-engine.ts); until then a short
// placeholder so the stage still plays.

import { Node, Txt } from '@motion-canvas/2d';
import { waitFor } from '@motion-canvas/core';
import { C, FONT } from '../../lib/theme';

export function* part(layer: Node) {
  const t = new Txt({ text: 'Wickeln (wird neu gebaut)', fontFamily: FONT, fontWeight: 600, fontSize: 46, fill: C.text });
  layer.add(t);
  yield* waitFor(2);
  layer.removeChildren();
}
