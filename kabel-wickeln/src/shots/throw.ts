// Stage 1, item 4 (being rebuilt): Kofi throws a long over-under ring.

import type { ShotDef } from './types';
import { V3, XLR, buildCable } from '../sim';

/** where the mic stand stands */
export const MIC_AT: V3 = [7.25, 0, 0.42];
/** drawn radius of the cable in the wide view */
export const THROW_WIDE_RADIUS = 0.006;

export const throwShot: ShotDef = {
  id: 'throw',
  duration: 0.1,
  build() {
    const { rod } = buildCable(XLR, [[0, 1, 0], [1, 1, 0]], { plugs: 'none' });
    return { rod };
  },
};
