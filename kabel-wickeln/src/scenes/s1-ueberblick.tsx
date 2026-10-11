// Stage 1: plays its parts (src/scenes/parts) one after the other, then the stop card.

import { Node, makeScene2D } from '@motion-canvas/2d';
import { begin, stopCard } from '../lib/ui';
import { part as p1_coil } from './parts/p1-coil';
import { part as p1_deploy } from './parts/p1-deploy';

export default makeScene2D(function* (view) {
  yield* begin(view);
  const layer = new Node({});
  view.add(layer);
  yield* p1_coil(layer);
  yield* p1_deploy(layer);
  yield* stopCard(view, 1);
});
