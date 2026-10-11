// Placeholder: Stufe 7: Physik.
// A part adds its nodes to `layer`, plays, and leaves `layer` empty again.

import { Node, Txt } from '@motion-canvas/2d';
import { waitFor } from '@motion-canvas/core';
import { C, FONT } from '../../lib/theme';

export function* part(layer: Node) {
  const t = new Txt({ text: 'Stufe 7: Physik', fontFamily: FONT, fontWeight: 600, fontSize: 36, fill: C.muted, width: 1500, textWrap: true, textAlign: 'center' });
  layer.add(t);
  yield* waitFor(2);
  t.remove();
}
