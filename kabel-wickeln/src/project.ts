// The video: a title and seven stages, from the overview down to the physics. Each stage is a
// chapter of the mp4 (src/lib/chapters.ts) and ends with a card saying you may stop here.

import { makeProject } from '@motion-canvas/core';
import './fonts.css';

import titel from './scenes/s0-titel?scene';
import ueberblick from './scenes/s1-ueberblick?scene';
import warum from './scenes/s2-warum?scene';
import schritte from './scenes/s3-schritte?scene';
import klettband from './scenes/s4-klettband?scene';
import fehler from './scenes/s5-fehler?scene';
import dicke from './scenes/s6-dicke-kabel?scene';
import physik from './scenes/s7-physik?scene';

export default makeProject({
  name: 'kabel-wickeln',
  scenes: [titel, ueberblick, warum, schritte, klettband, fehler, dicke, physik],
});
