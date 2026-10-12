// Stage 5's part p5-size alone (the right size: the sink, three rings, the bulge, giving in), so it
// renders without the other parts' bakes:
// node tools/render.mjs stills --project p5size --scene p5-size <seconds>

import { Node, makeScene2D } from '@motion-canvas/2d';
import { begin } from '../../lib/ui';
import { part } from '../parts/p5-size';

export default makeScene2D(function* (view) {
  yield* begin(view);
  const layer = new Node({});
  view.add(layer);
  yield* part(layer);
});
