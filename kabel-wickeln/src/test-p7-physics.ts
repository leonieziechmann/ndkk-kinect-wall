// A project with stage 7's part p7-physics only (src/scenes/test/p7-physics.tsx), so it renders
// without the other parts' bakes (part time = scene time):
// node tools/render.mjs stills --project p7physics --scene p7-physics <seconds>

import { makeProject } from '@motion-canvas/core';
import './fonts.css';

import p7physics from './scenes/test/p7-physics?scene';

export default makeProject({
  name: 'kabel-wickeln-p7-physics',
  scenes: [p7physics],
});
