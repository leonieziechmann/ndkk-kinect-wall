// Stage 7: plays its parts (src/scenes/parts) one after the other, then the stop card.

import { Node, makeScene2D } from '@motion-canvas/2d';
import { begin, cardOut, stopCard } from '../lib/ui';
import { part as p7_physics } from './parts/p7-physics';

export default makeScene2D(function* (view) {
  yield* begin(view);
  const layer = new Node({});
  view.add(layer);
  yield* cardOut(view, 6);
  yield* p7_physics(layer);
  yield* stopCard(view, 7);
});
