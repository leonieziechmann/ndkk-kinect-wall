// Stage 6: plays its parts (src/scenes/parts) one after the other, then the stop card.

import { Node, makeScene2D } from '@motion-canvas/2d';
import { begin, cardOut, stopCard } from '../lib/ui';
import { part as p6_thick } from './parts/p6-thick';

export default makeScene2D(function* (view) {
  yield* begin(view);
  const layer = new Node({});
  view.add(layer);
  yield* cardOut(view, 5);
  yield* p6_thick(layer);
  yield* stopCard(view, 6);
});
