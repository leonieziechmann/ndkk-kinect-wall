// Stage 4's part p4-strap alone (the velcro tie), so it renders without the other parts' bakes; the
// times are part seconds (the stage scene s4-klettband plays the part 0.75 s in, after its card):
// node tools/render.mjs stills --project p4strap --scene p4-strap <seconds>

import { Node, makeScene2D } from '@motion-canvas/2d';
import { begin } from '../../lib/ui';
import { part } from '../parts/p4-strap';

export default makeScene2D(function* (view) {
  yield* begin(view);
  const layer = new Node({});
  view.add(layer);
  yield* part(layer);
});
