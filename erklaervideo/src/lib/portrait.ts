// Layout of the short cut for social media: 1080 × 1920 (9:16, an Instagram Reel). Instagram puts
// its own things over the top (name, icons) and the bottom (caption, buttons on the right) of a Reel,
// and in the feed it shows only the middle 4:5 (1080 × 1350). So all text stays in the middle band
// between `top` and `bottom` (px from the center of the picture); the pictures may reach further.

import type { CaptionStyle } from '../nodes/ui';

export const P = {
  w: 1080,
  h: 1920,
  top: -675,
  bottom: 450,
  /** text inside the nodes (labels, titles of the pictures) this much larger, for a phone screen */
  text: 1.6,
};

/** the sentence of each scene: centered, hanging from the top of the band */
export const CAPTION: { x: number; y: number; style: CaptionStyle } = { x: 0, y: -630, style: { anchor: 'top', fontSize: 58, lineHeight: 70 } };

/** the two pictures of the Kinect side by side below the 3D view (scenes 2 and 3) */
export const PAIR = { w: 480, h: 398, gap: 30, y: 310, out: 1100 };
export const PAIR_X = [-(PAIR.w + PAIR.gap) / 2, (PAIR.w + PAIR.gap) / 2];

/** the mask picture below the 3D view (scenes 6 and 7) */
export const MASK = { w: 540, h: 447, x: 0, y: 270, out: 1150 };

/** the wall seen straight on (scene 7), where the camera of scene 8 starts: 6 m = 1000 px */
export const WALL_P = { x: 0, y: -280, w: 1000, h: 1000 / 3 };
