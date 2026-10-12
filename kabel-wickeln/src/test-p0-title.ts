// A project with the title stage only (src/scenes/s0-titel.tsx, which plays the part p0-title), so
// it renders without the other stages' bakes:
// node tools/render.mjs stills --project p0title --scene s0-titel <seconds>

import { makeProject } from '@motion-canvas/core';
import './fonts.css';

import titel from './scenes/s0-titel?scene';

export default makeProject({
  name: 'kabel-wickeln-p0-title',
  scenes: [titel],
});
