// A project with stage 4's part p4-strap only (src/scenes/test/p4-strap.tsx), so it renders without
// the other parts' bakes:
// node tools/render.mjs stills --project p4strap --scene p4-strap <seconds>

import { makeProject } from '@motion-canvas/core';
import './fonts.css';

import p4strap from './scenes/test/p4-strap?scene';

export default makeProject({
  name: 'kabel-wickeln-p4-strap',
  scenes: [p4strap],
});
