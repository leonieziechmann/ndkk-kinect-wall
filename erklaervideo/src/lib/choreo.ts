// Who walks where and when, and what they wear. Times are relative to the scenes (timeline.ts), so a
// scene can get shorter or longer without the people falling out of step. The slot is the person's
// number in the tracking and with it their color (PERSON_COLORS: 1 cyan, 2 magenta, 3 yellow).
// The short cut for social media (timeline.ts, CUT) has its own, quicker steps: the same people
// doing the same things in less time.
//
// Room: x to the right as the audience sees the wall, z = meters in front of the wall. The Kinect
// stands at x 0, z 0.25 and sees about 0.7 m to each side per meter of distance.

import type { PersonSpec } from './people';
import { CUT, at } from './timeline';

/** who does the demonstrations: the lead waves at the Kinect and the wall, the second gets measured */
export const ROLES = { lead: 2, second: 1 } as const;

/** who they are and what they wear */
const LOOKS = {
  // in pink
  man: { slot: 2, height: 1.78, albedo: 0.62, hair: 'short', top: 'tee', pants: 'straight' },
  // boxy shirt, wide high-waisted pants, ponytail
  woman: { slot: 1, height: 1.66, albedo: 0.55, female: true, hair: 'ponytail', top: 'boxy', pants: 'wide' },
  third: { slot: 3, height: 1.72, albedo: 0.68, hair: 'curly', top: 'sweater', pants: 'straight' },
} satisfies Record<string, Omit<PersonSpec, 'path' | 'actions'>>;

const FULL: PersonSpec[] = [
  {
    ...LOOKS.man,
    path: [
      { t: at('sensor', 1.2), x: -3.3, z: 2.95 },
      { t: at('sensor', 4.6), x: -0.8, z: 2.3 },
      { t: at('wand', 5.4), x: -0.8, z: 2.3 },
      { t: at('wand', 8.0), x: -1.65, z: 2.55 },
    ],
    actions: [
      { t0: at('sensor', 5.6), t1: at('sensor', 8.4), kind: 'wave', side: 'R' },
      { t0: at('punktwolke', 5.6), t1: at('punktwolke', 8.4), kind: 'out', side: 'B' },
      { t0: at('flow', 0.2), t1: at('flow', 5.4), kind: 'wave', side: 'R' },
      { t0: at('ki', 2.0), t1: at('ki', 5.4), kind: 'wave', side: 'R' },
      { t0: at('ki', 6.0), t1: at('ki', 9.9), kind: 'raise', side: 'B' },
      { t0: at('masken', 1.4), t1: at('masken', 5.6), kind: 'out', side: 'B' },
      { t0: at('daten', 5.0), t1: at('daten', 8.4), kind: 'wave', side: 'R' },
      { t0: at('wand', 0.5), t1: at('wand', 5.0), kind: 'circle', side: 'B' },
      { t0: at('wand', 7.8), t1: at('wand', 10.4), kind: 'wave', side: 'B' },
    ],
  },
  {
    ...LOOKS.woman,
    path: [
      { t: at('sensor', 1.8), x: 3.6, z: 4.0 },
      { t: at('sensor', 5.6), x: 1.15, z: 3.0 },
      { t: at('flow', 0.9), x: 1.15, z: 3.0 },
      { t: at('flow', 2.4), x: 0.7, z: 2.9 },
      { t: at('flow', 3.2), x: 0.7, z: 2.9 },
      { t: at('flow', 4.6), x: 1.1, z: 3.0 },
      { t: at('daten', 7.9), x: 1.1, z: 3.0 },
      { t: at('daten', 11.1), x: -1.35, z: 3.05 },
      { t: at('wand', 5.8), x: -1.35, z: 3.05 },
      { t: at('wand', 8.8), x: -0.2, z: 3.3 },
    ],
    actions: [
      { t0: at('punktwolke', 1.2), t1: at('punktwolke', 4.2), kind: 'raise', side: 'B' },
      { t0: at('ki', 1.5), t1: at('ki', 5.0), kind: 'out', side: 'B' },
      { t0: at('ki', 5.8), t1: at('ki', 9.6), kind: 'reach', side: 'L' },
      { t0: at('masken', 0.7), t1: at('masken', 4.2), kind: 'wave', side: 'L' },
      { t0: at('wand', 0.9), t1: at('wand', 4.6), kind: 'wave', side: 'L' },
      { t0: at('wand', 6.4), t1: at('wand', 10.0), kind: 'circle', side: 'B' },
    ],
  },
  {
    ...LOOKS.third,
    path: [
      { t: at('wand', -0.4), x: 3.8, z: 2.4 },
      { t: at('wand', 2.8), x: 1.05, z: 2.05 },
      { t: at('wand', 6.6), x: 1.05, z: 2.05 },
      { t: at('wand', 9.2), x: 2.0, z: 2.5 },
    ],
    actions: [
      { t0: at('wand', 2.8), t1: at('wand', 6.4), kind: 'raise', side: 'B' },
      { t0: at('wand', 7.4), t1: at('wand', 10.6), kind: 'wave', side: 'B' },
    ],
  },
];

/** the short cut: they come in sooner, and each gesture fits the quicker scenes */
const SOCIAL: PersonSpec[] = [
  {
    ...LOOKS.man,
    path: [
      { t: at('sensor', 0.6), x: -3.3, z: 2.95 },
      { t: at('sensor', 3.6), x: -0.8, z: 2.3 },
      { t: at('wand', 4.0), x: -0.8, z: 2.3 },
      { t: at('wand', 6.4), x: -1.65, z: 2.55 },
    ],
    actions: [
      { t0: at('sensor', 3.9), t1: at('sensor', 6.5), kind: 'wave', side: 'R' },
      { t0: at('punktwolke', 3.8), t1: at('punktwolke', 6.3), kind: 'out', side: 'B' },
      { t0: at('flow', 0.1), t1: at('flow', 4.4), kind: 'wave', side: 'R' },
      { t0: at('ki', 1.5), t1: at('ki', 3.9), kind: 'wave', side: 'R' },
      { t0: at('ki', 4.4), t1: at('ki', 7.4), kind: 'raise', side: 'B' },
      { t0: at('masken', 0.9), t1: at('masken', 4.3), kind: 'out', side: 'B' },
      { t0: at('daten', 3.8), t1: at('daten', 6.6), kind: 'wave', side: 'R' },
      { t0: at('wand', 0.3), t1: at('wand', 3.9), kind: 'circle', side: 'B' },
      { t0: at('wand', 5.6), t1: at('wand', 7.5), kind: 'wave', side: 'B' },
    ],
  },
  {
    ...LOOKS.woman,
    path: [
      { t: at('sensor', 1.0), x: 3.6, z: 4.0 },
      { t: at('sensor', 4.3), x: 1.15, z: 3.0 },
      { t: at('flow', 0.5), x: 1.15, z: 3.0 },
      { t: at('flow', 1.6), x: 0.7, z: 2.9 },
      { t: at('flow', 2.3), x: 0.7, z: 2.9 },
      { t: at('flow', 3.5), x: 1.1, z: 3.0 },
      { t: at('daten', 4.6), x: 1.1, z: 3.0 },
      { t: at('daten', 7.4), x: -1.35, z: 3.05 },
      { t: at('wand', 4.3), x: -1.35, z: 3.05 },
      { t: at('wand', 6.8), x: -0.2, z: 3.3 },
    ],
    actions: [
      { t0: at('punktwolke', 0.8), t1: at('punktwolke', 3.4), kind: 'raise', side: 'B' },
      { t0: at('ki', 1.2), t1: at('ki', 3.9), kind: 'out', side: 'B' },
      { t0: at('ki', 4.4), t1: at('ki', 7.4), kind: 'reach', side: 'L' },
      { t0: at('masken', 0.4), t1: at('masken', 3.4), kind: 'wave', side: 'L' },
      { t0: at('wand', 0.5), t1: at('wand', 3.5), kind: 'wave', side: 'L' },
      { t0: at('wand', 4.6), t1: at('wand', 7.5), kind: 'circle', side: 'B' },
    ],
  },
  {
    ...LOOKS.third,
    path: [
      { t: at('wand', -0.8), x: 3.8, z: 2.4 },
      { t: at('wand', 2.2), x: 1.05, z: 2.05 },
      { t: at('wand', 4.8), x: 1.05, z: 2.05 },
      { t: at('wand', 7.2), x: 2.0, z: 2.5 },
    ],
    actions: [
      { t0: at('wand', 2.3), t1: at('wand', 4.8), kind: 'raise', side: 'B' },
      { t0: at('wand', 5.2), t1: at('wand', 7.5), kind: 'wave', side: 'B' },
    ],
  },
];

export const CHOREO: PersonSpec[] = CUT === 'social' ? SOCIAL : FULL;
