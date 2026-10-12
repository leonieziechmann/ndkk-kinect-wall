// A project with stage 5's part p5-size only (src/scenes/test/p5-size.tsx), so it renders without
// the other parts' bakes:
// node tools/render.mjs stills --project p5size --scene p5-size <seconds>

import { makeProject } from '@motion-canvas/core';
import './fonts.css';

import p5size from './scenes/test/p5-size?scene';

export default makeProject({
  name: 'kabel-wickeln-p5-size',
  scenes: [p5size],
});
