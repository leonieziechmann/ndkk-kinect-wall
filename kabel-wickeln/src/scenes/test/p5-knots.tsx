// Stage 5's part p5-knots alone (the end through the ring: knots in every second loop), so it
// renders without the other parts' bakes:
// node tools/render.mjs stills --project p5knots --scene p5-knots <seconds>

import { Node, makeScene2D } from '@motion-canvas/2d';
import { begin } from '../../lib/ui';
import { part } from '../parts/p5-knots';

export default makeScene2D(function* (view) {
  yield* begin(view);
  const layer = new Node({});
  view.add(layer);
  yield* part(layer);
});
