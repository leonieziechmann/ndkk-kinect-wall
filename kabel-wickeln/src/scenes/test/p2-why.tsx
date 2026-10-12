// Stage 2's part p2-why alone (Teo and Robin pull their rings apart), so it renders without the
// other parts' bakes; scene time = part time:
// node tools/render.mjs stills --project p2why --scene p2-why <seconds>

import { Node, makeScene2D } from '@motion-canvas/2d';
import { begin } from '../../lib/ui';
import { part } from '../parts/p2-why';

export default makeScene2D(function* (view) {
  yield* begin(view);
  const layer = new Node({});
  view.add(layer);
  yield* part(layer);
});
