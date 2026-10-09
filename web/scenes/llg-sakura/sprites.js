// Hand-made pixel sprites: two paper lanterns (red, pale pink) and the petal animation frames, in
// one atlas canvas. Each sprite is a list of rows; every letter is a palette color, '.' is empty.

import { C, Pix } from './pixel.js';

const LANTERN = [
  '...kkkkk...',
  '..kKKKKKk..',
  '.rRoooooRr.',
  'rRRRRRRRRRr',
  'rRoyyYyyoRr',
  'rRRoyyyoRRr',
  'rRoyYYYyoRr',
  'rRRoyYyoRRr',
  'rRoyyYyyoRr',
  'rRRRRRRRRRr',
  '.rRoooooRr.',
  '..kKKKKKk..',
  '...kkkkk...',
  '.....K.....',
  '....KrK....',
];
const RED = { k: C.sky0, K: C.o0, r: C.o1, R: C.o2, o: C.o3, y: C.o5, Y: C.y1 };
const PINK = { k: C.sky0, K: C.p1, r: C.p3, R: C.p4, o: C.p5, y: C.p7, Y: C.y2 };

// petals: small (3 x 3) and near (4 x 4) frames of one flutter
const P = { L: C.p7, P: C.p5, p: C.p4, d: C.p3 };
const SMALL = [
  ['...', '.LP', '.Pp'],
  ['L..', '.Pp', '...'],
  ['.L.', '.P.', '.p.'],
  ['..L', '.P.', 'p..'],
  ['...', 'LPp', '...'],
  ['...', '.P.', '...'],
];
const NEAR = [
  ['.LP.', 'LPPp', 'PPpd', '.pd.'],
  ['....', 'LPPp', '.Ppd', '....'],
  ['.L..', '.PP.', '..Pp', '...d'],
  ['....', '.LP.', '.Pd.', '....'],
  ['..L.', '.PP.', 'Pp..', 'd...'],
  ['....', 'LPPd', '....', '....'],
];
// the order of frames as a petal turns over once
export const FLUTTER = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1];

/** Builds the atlas: returns { canvas, lantern: [red, pink], small: [...], near: [...] } with pixel rects. */
export function buildAtlas() {
  const items = [];
  const add = (rows, colors) => {
    items.push({ rows, colors });
    return items.length - 1;
  };
  const lantern = [add(LANTERN, RED), add(LANTERN, PINK)];
  const small = SMALL.map((r) => add(r, P));
  const near = NEAR.map((r) => add(r, P));
  let x = 1;
  const rects = items.map((it) => {
    const w = it.rows[0].length;
    const h = it.rows.length;
    const r = { x, y: 1, w, h };
    x += w + 2;
    return r;
  });
  const pix = new Pix(x, Math.max(...rects.map((r) => r.h)) + 2);
  items.forEach((it, i) => {
    const r = rects[i];
    it.rows.forEach((row, j) => {
      for (let k = 0; k < row.length; k++) if (row[k] !== '.') pix.set(r.x + k, r.y + j, it.colors[row[k]]);
    });
  });
  const uv = (i) => {
    const r = rects[i];
    return { w: r.w, h: r.h, uv: [r.x / pix.w, r.y / pix.h, (r.x + r.w) / pix.w, (r.y + r.h) / pix.h] };
  };
  return { canvas: pix.toCanvas(), lantern: lantern.map(uv), small: small.map(uv), near: near.map(uv) };
}
