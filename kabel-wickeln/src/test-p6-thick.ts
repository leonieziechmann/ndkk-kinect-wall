// A project with stage 6's part p6-thick only (src/scenes/test/p6-thick.tsx), so it renders without
// the other parts' bakes:
// node tools/render.mjs stills --project p6thick --scene p6-thick <seconds>

import { makeProject } from '@motion-canvas/core';
import './fonts.css';

import p6thick from './scenes/test/p6-thick?scene';

export default makeProject({
  name: 'kabel-wickeln-p6-thick',
  scenes: [p6thick],
});
