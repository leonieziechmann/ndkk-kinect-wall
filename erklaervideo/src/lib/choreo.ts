// Who walks where and when, on the global story time (seconds, see timeline.ts). Low-effort stand-ins
// until real recordings replace them (AUFNAHMEN.md).
//
// Room: x to the right as the audience sees the wall, z = meters in front of the wall. The Kinect
// stands at x 0, z 0.25 and sees about 0.7 m to each side per meter of distance.

import type { PersonSpec } from './people';

export const CHOREO: PersonSpec[] = [
  {
    slot: 1,
    height: 1.78,
    albedo: 0.62,
    path: [
      { t: 12.6, x: -3.3, z: 2.95 },
      { t: 16.4, x: -0.8, z: 2.3 },
      { t: 79.0, x: -0.8, z: 2.3 },
      { t: 81.8, x: -1.65, z: 2.55 },
    ],
    actions: [
      { t0: 29.0, t1: 32.2, kind: 'out', side: 'B' },
      { t0: 34.3, t1: 39.9, kind: 'wave', side: 'R' },
      { t0: 42.6, t1: 46.2, kind: 'wave', side: 'R' },
      { t0: 47.2, t1: 51.5, kind: 'raise', side: 'B' },
      { t0: 54.0, t1: 58.4, kind: 'out', side: 'B' },
      { t0: 66.8, t1: 70.4, kind: 'wave', side: 'R' },
      { t0: 73.6, t1: 78.6, kind: 'sweep', side: 'B' },
      { t0: 81.4, t1: 84.2, kind: 'wave', side: 'B' },
    ],
  },
  {
    slot: 2,
    height: 1.66,
    albedo: 0.55,
    path: [
      { t: 13.3, x: 3.6, z: 4.0 },
      { t: 17.6, x: 1.15, z: 3.0 },
      { t: 35.0, x: 1.15, z: 3.0 },
      { t: 36.7, x: 0.7, z: 2.9 },
      { t: 37.6, x: 0.7, z: 2.9 },
      { t: 39.2, x: 1.1, z: 3.0 },
      { t: 68.0, x: 1.1, z: 3.0 },
      { t: 71.6, x: -1.35, z: 3.05 },
      { t: 79.4, x: -1.35, z: 3.05 },
      { t: 82.6, x: -0.2, z: 3.3 },
    ],
    actions: [
      { t0: 25.6, t1: 28.4, kind: 'raise', side: 'B' },
      { t0: 42.0, t1: 46.0, kind: 'out', side: 'B' },
      { t0: 46.8, t1: 51.0, kind: 'reach', side: 'L' },
      { t0: 53.0, t1: 56.8, kind: 'wave', side: 'L' },
      { t0: 74.0, t1: 78.0, kind: 'wave', side: 'L' },
      { t0: 80.0, t1: 84.0, kind: 'sweep', side: 'R' },
    ],
  },
  {
    slot: 3,
    height: 1.72,
    albedo: 0.68,
    path: [
      { t: 72.6, x: 3.8, z: 2.4 },
      { t: 76.0, x: 1.05, z: 2.05 },
      { t: 80.2, x: 1.05, z: 2.05 },
      { t: 83.0, x: 2.0, z: 2.5 },
    ],
    actions: [
      { t0: 76.0, t1: 80.0, kind: 'sweep', side: 'B' },
      { t0: 81.0, t1: 84.5, kind: 'wave', side: 'R' },
    ],
  },
];
