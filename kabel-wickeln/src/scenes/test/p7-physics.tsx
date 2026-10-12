// Stage 7's part p7-physics alone (the physics: stiffness, memory, tension, the band, the ring, the
// formula), so it renders without the other parts' bakes:
// node tools/render.mjs stills --project p7physics --scene p7-physics <seconds>

import { Node, makeScene2D } from '@motion-canvas/2d';
import { begin } from '../../lib/ui';
import { part } from '../parts/p7-physics';

export default makeScene2D(function* (view) {
  yield* begin(view);
  const layer = new Node({});
  view.add(layer);
  yield* part(layer);
});
