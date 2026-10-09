// The logo of the Nacht der kreativen Köpfe (NDKK, ndkk.de): the letters N, D, the curly "kreative"
// K and K, and the line NACHT DER KREATIVEN KÖPFE below, cut from the heading of ndkk.de into one
// SVG each (src/assets/ndkk/), with their boxes in the coordinates of that heading. The colors are
// those of the site: navy type on a pale mint, blue and yellow background.

import d from '../assets/ndkk/d.svg';
import kKreativ from '../assets/ndkk/k-kreativ.svg';
import k from '../assets/ndkk/k.svg';
import line from '../assets/ndkk/nacht-der-kreativen-koepfe.svg';
import n from '../assets/ndkk/n.svg';

export const NDKK_COLORS = { navy: '#002647', mint: '#c6e2dc', pale: '#e9efda', blue: '#8fc0d3', yellow: '#f1edb4' };

export interface LogoPart {
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const NDKK_LETTERS: LogoPart[] = [
  { src: n, x: 11.5, y: 548.5, w: 372.9, h: 432.1 },
  { src: d, x: 467.5, y: 557.1, w: 375.8, h: 415.6 },
  { src: kKreativ, x: 856.1, y: 531.5, w: 451.1, h: 450.4 },
  { src: k, x: 1331.5, y: 557.1, w: 369.8, h: 415.7 },
];
export const NDKK_LINE: LogoPart = { src: line, x: 13.4, y: 998.9, w: 1678.9, h: 108.7 };
/** the whole logo (letters and line) */
export const NDKK_BOX = { x: 11.5, y: 531.5, w: 1690.2, h: 576.1 };
