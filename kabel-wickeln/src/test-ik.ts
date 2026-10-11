// A project with the IK test scene (src/scenes/test/ik.tsx) and the cast sheet (whose arms also go
// through the IK), so they render without the bakes the other test scenes need:
// node tools/render.mjs stills --project ik --scene ik <seconds>

import { makeProject } from '@motion-canvas/core';
import './fonts.css';

import ik from './scenes/test/ik?scene';
import cast from './scenes/test/cast?scene';

export default makeProject({
  name: 'kabel-wickeln-ik',
  scenes: [ik, cast],
});
