// A project with only the IK test scene (src/scenes/test/ik.tsx), so it renders without the bakes
// the other test scenes need: node tools/render.mjs stills --project ik <seconds>

import { makeProject } from '@motion-canvas/core';
import './fonts.css';

import ik from './scenes/test/ik?scene';

export default makeProject({
  name: 'kabel-wickeln-ik',
  scenes: [ik],
});
