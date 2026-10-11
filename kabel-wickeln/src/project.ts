import { makeProject } from '@motion-canvas/core';
import './fonts.css';

import titel from './scenes/s0-titel?scene';
import ueberblick from './scenes/s1-ueberblick?scene';
import warum from './scenes/s2-warum?scene';
import schritte from './scenes/s3-schritte?scene';
import feinheiten from './scenes/s4-feinheiten?scene';
import physik from './scenes/s5-physik?scene';

export default makeProject({
  name: 'kabel-wickeln',
  scenes: [titel, ueberblick, warum, schritte, feinheiten, physik],
});
