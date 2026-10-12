// A project with stage 5's part p5-eight only (src/scenes/test/p5-eight.tsx), so it renders without
// the other parts' bakes:
// node tools/render.mjs stills --project p5eight --scene p5-eight <seconds>

import { makeProject } from '@motion-canvas/core';
import './fonts.css';

import p5eight from './scenes/test/p5-eight?scene';

export default makeProject({
  name: 'kabel-wickeln-p5-eight',
  scenes: [p5eight],
});
