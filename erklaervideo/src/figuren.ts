// A second project, only for choosing the look of the people: the same moments of the story with
// the bodies from the front, the side and behind, plus the Kinect's infrared and depth picture.
// Rendered with: npm run stills -- --project figuren --body puppe 3 8

import { makeProject } from '@motion-canvas/core';
import './fonts.css';

import figuren from './scenes/figuren?scene';

export default makeProject({
  name: 'figuren',
  scenes: [figuren],
});
