// A project with stage 1's part p1-deploy only (src/scenes/test/deploy.tsx), so it renders without
// the other parts' bakes:
// node tools/render.mjs stills --project deploy --scene deploy <seconds>

import { makeProject } from '@motion-canvas/core';
import './fonts.css';

import deploy from './scenes/test/deploy?scene';

export default makeProject({
  name: 'kabel-wickeln-deploy',
  scenes: [deploy],
});
