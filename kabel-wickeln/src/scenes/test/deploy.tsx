// Stage 1's part p1-deploy alone (laying a coil out again: Ilse's short cable, Kofi's throw), so it
// renders without the other parts' bakes:
// node tools/render.mjs stills --project deploy --scene deploy <seconds>

import { Node, makeScene2D } from '@motion-canvas/2d';
import { begin } from '../../lib/ui';
import { part } from '../parts/p1-deploy';

export default makeScene2D(function* (view) {
  yield* begin(view);
  const layer = new Node({});
  view.add(layer);
  yield* part(layer);
});
