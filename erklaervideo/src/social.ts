// The short cut for social media: an Instagram Reel, 1080 × 1920 (9:16), 57 s. The same story as the
// full video, quicker, laid out for a phone held upright; instead of the credits and the flag it ends
// with the Nacht der kreativen Köpfe and the station where the wall stands.
// Rendered with: npm run render:social (tools/render.mjs --project social).

// must come first: switches timeline and choreography to the short cut before they are loaded
import './lib/cut-social';

import { makeProject } from '@motion-canvas/core';
import './fonts.css';
// the soundtrack: made from the cues of these scenes by `npm run sound:social`
import audio from './audio/soundtrack-social.m4a';

import aufbau from './scenes/social/r1-aufbau?scene';
import sensor from './scenes/social/r2-sensor?scene';
import punktwolke from './scenes/social/r3-punktwolke?scene';
import flow from './scenes/social/r4-flow?scene';
import ki from './scenes/social/r5-ki?scene';
import masken from './scenes/social/r6-masken?scene';
import daten from './scenes/social/r7-daten?scene';
import wand from './scenes/social/r8-wand?scene';
import ndkk from './scenes/social/r9-ndkk?scene';

export default makeProject({
  name: 'kinect-wand-social',
  scenes: [aufbau, sensor, punktwolke, flow, ki, masken, daten, wand, ndkk],
  audio,
});
