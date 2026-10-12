// A project with stage 2's part p2-why only (src/scenes/test/p2-why.tsx), so it renders without the
// other parts' bakes:
// node tools/render.mjs stills --project p2why --scene p2-why <seconds of part time>

import { makeProject } from '@motion-canvas/core';
import './fonts.css';

import p2why from './scenes/test/p2-why?scene';

export default makeProject({
  name: 'kabel-wickeln-p2-why',
  scenes: [p2why],
});
