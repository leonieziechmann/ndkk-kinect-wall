// A project with stage 5's part p5-knots alone (src/scenes/test/p5-knots.tsx) and stage 5 itself
// (src/scenes/s5-fehler.tsx, where the part plays first), so both render without the other stages'
// bakes:
//   node tools/render.mjs stills --project p5knots --scene p5-knots <seconds>     (part time)
//   node tools/render.mjs stills --project p5knots --scene s5-fehler <seconds>    (stage time)

import { makeProject } from '@motion-canvas/core';
import './fonts.css';

import p5knots from './scenes/test/p5-knots?scene';
import fehler from './scenes/s5-fehler?scene';

export default makeProject({
  name: 'kabel-wickeln-p5-knots',
  scenes: [p5knots, fehler],
});
