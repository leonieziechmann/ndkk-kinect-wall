// A project with the coiling test scenes only (src/scenes/test/coil-*.tsx), so they render without
// the other test scenes' bakes and shots:
// node tools/render.mjs stills --project coil --scene coil-pose <seconds>

import { makeProject } from '@motion-canvas/core';
import './fonts.css';

import coilPose from './scenes/test/coil-pose?scene';
import coilSim from './scenes/test/coil-sim?scene';
import coilCompare from './scenes/test/coil-compare?scene';

export default makeProject({
  name: 'kabel-wickeln-coil',
  scenes: [coilSim, coilPose, coilCompare],
});
