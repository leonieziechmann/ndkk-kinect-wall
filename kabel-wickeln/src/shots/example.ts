// Example shot, and the template for new ones: a 1.2 m XLR cable between two hands. The right hand
// rolls the cable three turns about its axis, then the hands come together and the stored twist
// jumps out as a loop. The hand frames are exported so a scene can put the fists exactly where the
// cable is held; the tracks feed a twist/writhe counter.

import { Frame, Rod, gripFrame, smooth } from '../sim';
import type { ShotDef } from './types';

const L = 1.2, H = 1.1, SEG = 0.01;
const N = Math.round(L / SEG) + 1;
const TURNS = 3;

/** x of the right fist (the left one mirrors it): from the cable ends to 24 cm apart, 1.7-3.7 s */
const handX = (t: number) => L / 2 - SEG + (0.12 - (L / 2 - SEG)) * smooth((t - 1.7) / 2);

/** Grip frames of the two fists (palms on top of the cable); the right hand rolls 0-1.5 s. */
export const HANDS: Record<'left' | 'right', (t: number) => Frame> = {
  left: (t) => gripFrame([-handX(t), H, 0], [1, 0, 0], [0, 1, 0]),
  right: (t) => {
    const a = TURNS * 2 * Math.PI * smooth(t / 1.5);
    return gripFrame([handX(t), H, 0], [1, 0, 0], [0, Math.cos(a), Math.sin(a)]);
  },
};

export const exampleTwist: ShotDef = {
  id: 'example-twist',
  duration: 4.5,
  build() {
    const rod = Rod.straight([-L / 2, H, 0], [L / 2, H, 0], N, { radius: 0.0035, linearDensity: 0.05, EI: 2e-3, GJ: 1.5e-3, damping: 1 });
    rod.addGrip({ nodes: [0, 2], frame: HANDS.left });
    rod.addGrip({ nodes: [N - 3, N - 1], frame: HANDS.right });
    return {
      rod,
      tracks: {
        twist: (r) => r.twistTurns(),
        writhe: (r) => r.writhe(),
      },
    };
  },
};
