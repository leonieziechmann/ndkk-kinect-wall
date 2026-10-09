import { makeProject } from '@motion-canvas/core';
import './fonts.css';
// the soundtrack: made from the cues of the scenes by `npm run sound` (tools/sound.mjs)
import audio from './audio/soundtrack.m4a';

import aufbau from './scenes/s1-aufbau?scene';
import sensor from './scenes/s2-sensor?scene';
import punktwolke from './scenes/s3-punktwolke?scene';
import flow from './scenes/s4-flow?scene';
import ki from './scenes/s5-ki?scene';
import masken from './scenes/s6-masken?scene';
import daten from './scenes/s7-daten?scene';
import wand from './scenes/s8-wand?scene';
import abspann from './scenes/s9-abspann?scene';
import bunt from './scenes/s10-bunt?scene';

export default makeProject({
  name: 'kinect-wand',
  scenes: [aufbau, sensor, punktwolke, flow, ki, masken, daten, wand, abspann, bunt],
  audio,
});
