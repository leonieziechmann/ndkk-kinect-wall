// Placeholder, replaced by the cast test scene.
import { Txt, makeScene2D } from '@motion-canvas/2d';
import { waitFor } from '@motion-canvas/core';

export default makeScene2D(function* (view) {
  view.add(<Txt text={'cast'} fill={'#888'} />);
  yield* waitFor(1);
});
