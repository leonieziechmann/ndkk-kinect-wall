// Stage 2: plays its parts (src/scenes/parts) one after the other, then the stop card.

import { Node, makeScene2D } from '@motion-canvas/2d';
import { begin, cardOut, stopCard } from '../lib/ui';
import { part as p2_why } from './parts/p2-why';

export default makeScene2D(function* (view) {
  yield* begin(view);
  const layer = new Node({});
  view.add(layer);
  yield* cardOut(view, 1);
  yield* p2_why(layer);
  yield* stopCard(view, 2);
});
