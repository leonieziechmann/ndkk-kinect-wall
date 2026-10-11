// Stage 1, item 3 (being rebuilt): Ilse pulls a short over-under ring apart.

import type { ShotDef } from './types';
import { CHARGING, buildCable } from '../sim';

export const deployPull: ShotDef = {
  id: 'deploy-pull',
  duration: 0.1,
  build() {
    const { rod } = buildCable(CHARGING, [[0, 1, 0], [1, 1, 0]], { plugs: 'none' });
    return { rod };
  },
};
