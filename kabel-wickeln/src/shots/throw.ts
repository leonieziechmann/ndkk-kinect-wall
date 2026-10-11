// Stage 1, item 4 (being rebuilt): Kofi throws a long over-under ring.

import type { ShotDef } from './types';
import { XLR, buildCable } from '../sim';

export const throwShot: ShotDef = {
  id: 'throw',
  duration: 0.1,
  build() {
    const { rod } = buildCable(XLR, [[0, 1, 0], [1, 1, 0]], { plugs: 'none' });
    return { rod };
  },
};
