// Stage 0: plays its parts (src/scenes/parts) one after the other.

import { Node, makeScene2D } from '@motion-canvas/2d';
import { begin } from '../lib/ui';
import { part as p0_title } from './parts/p0-title';

export default makeScene2D(function* (view) {
  yield* begin(view);
  const layer = new Node({});
  view.add(layer);
  yield* p0_title(layer);
});
