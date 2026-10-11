// Stage 5: plays its parts (src/scenes/parts) one after the other, then the stop card.

import { Node, makeScene2D } from '@motion-canvas/2d';
import { begin, cardOut, stopCard } from '../lib/ui';
import { part as p5_knots } from './parts/p5-knots';
import { part as p5_eight } from './parts/p5-eight';
import { part as p5_size } from './parts/p5-size';
import { part as p5_elbow } from './parts/p5-elbow';

export default makeScene2D(function* (view) {
  yield* begin(view);
  const layer = new Node({});
  view.add(layer);
  yield* cardOut(view, 4);
  yield* p5_knots(layer);
  yield* p5_eight(layer);
  yield* p5_size(layer);
  yield* p5_elbow(layer);
  yield* stopCard(view, 5);
});
