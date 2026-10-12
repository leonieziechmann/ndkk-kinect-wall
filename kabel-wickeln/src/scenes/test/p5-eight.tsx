// Stage 5's part p5-eight alone (the twisted loop that turns into an eight, and four fixes), so it
// renders without the other parts' bakes:
// node tools/render.mjs stills --project p5eight --scene p5-eight <seconds>

import { Node, makeScene2D } from '@motion-canvas/2d';
import { begin } from '../../lib/ui';
import { part } from '../parts/p5-eight';

export default makeScene2D(function* (view) {
  yield* begin(view);
  const layer = new Node({});
  view.add(layer);
  yield* part(layer);
});
