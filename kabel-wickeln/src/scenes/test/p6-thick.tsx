// Stage 6's part p6-thick alone (thick cables: coiling the 5G2.5, the 5G16 in figure eights,
// straps, carrying, unrolling), so it renders without the other parts' bakes:
// node tools/render.mjs stills --project p6thick --scene p6-thick <seconds>

import { Node, makeScene2D } from '@motion-canvas/2d';
import { begin } from '../../lib/ui';
import { part } from '../parts/p6-thick';

export default makeScene2D(function* (view) {
  yield* begin(view);
  const layer = new Node({});
  view.add(layer);
  yield* part(layer);
});
