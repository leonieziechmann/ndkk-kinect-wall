// The test project: model sheets and render tests, not part of the video.
// npm run stills -- --project test <seconds>

import { makeProject } from '@motion-canvas/core';
import './fonts.css';

import cast from './scenes/test/cast?scene';
import render from './scenes/test/render?scene';
import derisk from './scenes/test/derisk?scene';

export default makeProject({
  name: 'kabel-wickeln-test',
  scenes: [render, cast, derisk],
});
