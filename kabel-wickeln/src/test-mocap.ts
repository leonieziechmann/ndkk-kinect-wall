// A project with the retargeting test scene only (src/scenes/test/mocap.tsx): recorded takes on our
// people. Needs the synthetic takes in output/synthetic (see the scene's header):
// node tools/render.mjs stills --project mocap --scene mocap <seconds>

import { makeProject } from '@motion-canvas/core';
import './fonts.css';

import mocap from './scenes/test/mocap?scene';

export default makeProject({
  name: 'kabel-wickeln-mocap',
  scenes: [mocap],
});
