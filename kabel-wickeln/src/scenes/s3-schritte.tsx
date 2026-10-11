// Stage 3: plays its parts (src/scenes/parts) one after the other, then the stop card.

import { Node, makeScene2D } from '@motion-canvas/2d';
import { begin, cardOut, stopCard } from '../lib/ui';
import { part as p3_steps } from './parts/p3-steps';

export default makeScene2D(function* (view) {
  yield* begin(view);
  const layer = new Node({});
  view.add(layer);
  yield* cardOut(view, 2);
  yield* p3_steps(layer);
  yield* stopCard(view, 3);
});
