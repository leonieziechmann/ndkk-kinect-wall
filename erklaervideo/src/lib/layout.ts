// Where the Kinect pictures sit when the 3D view moves aside (scenes 2, 3 and 6).

export const PANEL = { w: 470, h: 389, x: 560, yTop: -236, yBottom: 208, out: 900 };

/** text inside the nodes (labels, titles of the pictures) this much larger, readable on a notebook from a step away */
export const TEXT = 1.25;

/** the room between the two pictures, where the lower one's title sits (a dark strip fills it: titlePlate) */
export const PANEL_GAP = PANEL.yBottom - PANEL.h / 2 - (PANEL.yTop + PANEL.h / 2);
