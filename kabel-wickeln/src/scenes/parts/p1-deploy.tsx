// Placeholder: Stufe 1: Auslegen – Ilse zieht ein kurzes Kabel auseinander, Kofi wirft ein langes.
// A part adds its nodes to `layer`, plays, and leaves `layer` empty again.

import { Node, Txt } from '@motion-canvas/2d';
import { waitFor } from '@motion-canvas/core';
import { C, FONT } from '../../lib/theme';

export function* part(layer: Node) {
  const t = new Txt({ text: 'Stufe 1: Auslegen – Ilse zieht ein kurzes Kabel auseinander, Kofi wirft ein langes', fontFamily: FONT, fontWeight: 600, fontSize: 36, fill: C.muted, width: 1500, textWrap: true, textAlign: 'center' });
  layer.add(t);
  yield* waitFor(2);
  t.remove();
}
