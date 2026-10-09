// Who walks where and when. Times are relative to the scenes (timeline.ts), so a scene can get
// shorter or longer without the people falling out of step.
//
// Room: x to the right as the audience sees the wall, z = meters in front of the wall. The Kinect
// stands at x 0, z 0.25 and sees about 0.7 m to each side per meter of distance.

import type { PersonSpec } from './people';
import { at } from './timeline';

export const CHOREO: PersonSpec[] = [
  {
    slot: 1,
    height: 1.78,
    albedo: 0.62,
    hair: 'short',
    path: [
      { t: at('sensor', 1.6), x: -3.3, z: 2.95 },
      { t: at('sensor', 5.4), x: -0.8, z: 2.3 },
      { t: at('wand', 6.0), x: -0.8, z: 2.3 },
      { t: at('wand', 8.8), x: -1.65, z: 2.55 },
    ],
    actions: [
      { t0: at('sensor', 6.4), t1: at('sensor', 9.4), kind: 'wave', side: 'R' },
      { t0: at('punktwolke', 6.4), t1: at('punktwolke', 9.6), kind: 'out', side: 'B' },
      { t0: at('flow', 0.2), t1: at('flow', 5.9), kind: 'wave', side: 'R' },
      { t0: at('ki', 2.4), t1: at('ki', 6.0), kind: 'wave', side: 'R' },
      { t0: at('ki', 6.8), t1: at('ki', 11.3), kind: 'raise', side: 'B' },
      { t0: at('masken', 1.6), t1: at('masken', 6.2), kind: 'out', side: 'B' },
      { t0: at('daten', 5.4), t1: at('daten', 9.0), kind: 'wave', side: 'R' },
      { t0: at('wand', 0.6), t1: at('wand', 5.6), kind: 'sweep', side: 'B' },
      { t0: at('wand', 8.4), t1: at('wand', 11.2), kind: 'wave', side: 'B' },
    ],
  },
  {
    slot: 2,
    height: 1.66,
    albedo: 0.55,
    female: true,
    dress: true,
    hair: 'long',
    path: [
      { t: at('sensor', 2.3), x: 3.6, z: 4.0 },
      { t: at('sensor', 6.6), x: 1.15, z: 3.0 },
      { t: at('flow', 1.0), x: 1.15, z: 3.0 },
      { t: at('flow', 2.7), x: 0.7, z: 2.9 },
      { t: at('flow', 3.6), x: 0.7, z: 2.9 },
      { t: at('flow', 5.2), x: 1.1, z: 3.0 },
      { t: at('daten', 6.6), x: 1.1, z: 3.0 },
      { t: at('daten', 10.2), x: -1.35, z: 3.05 },
      { t: at('wand', 6.4), x: -1.35, z: 3.05 },
      { t: at('wand', 9.6), x: -0.2, z: 3.3 },
    ],
    actions: [
      { t0: at('punktwolke', 1.4), t1: at('punktwolke', 4.6), kind: 'raise', side: 'B' },
      { t0: at('ki', 1.8), t1: at('ki', 5.8), kind: 'out', side: 'B' },
      { t0: at('ki', 6.6), t1: at('ki', 11.0), kind: 'reach', side: 'L' },
      { t0: at('masken', 0.8), t1: at('masken', 4.6), kind: 'wave', side: 'L' },
      { t0: at('wand', 1.0), t1: at('wand', 5.0), kind: 'wave', side: 'L' },
      { t0: at('wand', 7.0), t1: at('wand', 11.0), kind: 'sweep', side: 'R' },
    ],
  },
  {
    slot: 3,
    height: 1.72,
    albedo: 0.68,
    hair: 'curly',
    sleeves: 'long',
    path: [
      { t: at('wand', -0.4), x: 3.8, z: 2.4 },
      { t: at('wand', 3.0), x: 1.05, z: 2.05 },
      { t: at('wand', 7.2), x: 1.05, z: 2.05 },
      { t: at('wand', 10.0), x: 2.0, z: 2.5 },
    ],
    actions: [
      { t0: at('wand', 3.0), t1: at('wand', 7.0), kind: 'sweep', side: 'B' },
      { t0: at('wand', 8.0), t1: at('wand', 11.5), kind: 'wave', side: 'R' },
    ],
  },
];
