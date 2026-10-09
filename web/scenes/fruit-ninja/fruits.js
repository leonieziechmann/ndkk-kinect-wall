// The fruits as pixel art: every kind is a shape (signed distance in units of its radius, y up) and a
// color per point of its skin and of its cut face. draw.js samples them once per block (2 x 2 LEDs),
// so a fruit can turn and still looks blocky and crisp.
//
// Light comes from the top left and stays there while a fruit spins (shading uses the unturned
// position). Every kind has a ramp of four tones; the shadows shift towards red and violet, never to a
// darker yellow or green (dim yellow and green look olive on the LED wall).

import { rgb } from './pix.js';

const ramp = (...h) => h.map(rgb);

export const KINDS = {
  melon: { r: 0.2, skin: ramp('#073f33', '#0b6b3c', '#23a447', '#76dc66'), stripe: ramp('#032a22', '#05482c', '#0b6633', '#2f9443'), juice: rgb('#ff2d55'), hi: rgb('#c8ffb8') },
  orange: { r: 0.15, skin: ramp('#c23200', '#f05e00', '#ff8c00', '#ffc04a'), juice: rgb('#ff9a1a'), hi: rgb('#fff1c8') },
  apple: { r: 0.14, skin: ramp('#6a0030', '#c0002e', '#ff1f3d', '#ff7070'), juice: rgb('#fff0b8'), hi: rgb('#ffe4e4') },
  lemon: { r: 0.13, skin: ramp('#e05a00', '#ffa800', '#ffe01a', '#fff59a'), juice: rgb('#fff04a'), hi: rgb('#ffffff') },
  berry: { r: 0.13, skin: ramp('#80003a', '#d0083c', '#ff2a48', '#ff8090'), juice: rgb('#ff2050'), hi: rgb('#ffe0e6') },
  plum: { r: 0.14, skin: ramp('#2a0866', '#5412a8', '#8a2cf0', '#bd90ff'), juice: rgb('#c050ff'), hi: rgb('#f2e2ff') },
  dragon: { r: 0.16, skin: ramp('#80004a', '#d0006a', '#ff2a9a', '#ff90cf'), juice: rgb('#ff3aa8'), hi: rgb('#ffe6f4') },
  // specials: the star fruit starts a frenzy, the frost fruit slows everything down
  star: { r: 0.16, skin: ramp('#e05a00', '#ffa400', '#ffd84a', '#fff4a8'), juice: rgb('#ffd21a'), hi: rgb('#ffffff'), aura: rgb('#ffb21a'), special: true },
  frost: { r: 0.15, skin: ramp('#1a34d0', '#3a74ff', '#7ac4ff', '#d8f4ff'), juice: rgb('#9ae8ff'), hi: rgb('#ffffff'), aura: rgb('#5ad8ff'), special: true },
  bomb: { r: 0.15, skin: ramp('#05050a', '#10121e', '#21263e', '#465078'), juice: rgb('#ff8a2a'), hi: rgb('#b8c6ff'), aura: rgb('#ff1a3a') },
};
export const NORMAL = ['melon', 'orange', 'apple', 'lemon', 'berry', 'plum', 'dragon'];

const C = {
  leaf: ramp('#05603e', '#0a8a4a', '#2fc456', '#7cf080'),
  stem: rgb('#9a5a22'),
  seedY: rgb('#ffe14a'),
  seedO: rgb('#ff9a2a'),
  green: rgb('#3aff8a'),
  greenD: rgb('#14b860'),
  red: rgb('#ff1a3a'),
  redD: rgb('#a0002a'),
  fuse: rgb('#d09858'),
  cap: rgb('#5a6488'),
  // cut faces
  melonRind: rgb('#0b6633'),
  melonPale: rgb('#d8ffc0'),
  melonPink: rgb('#ff7a90'),
  melonRed: rgb('#ff2d55'),
  melonSeed: rgb('#200010'),
  orPeel: rgb('#ff8c00'),
  orPith: rgb('#fff0d0'),
  orIn: rgb('#ffb02a'),
  orOut: rgb('#ff9410'),
  orDot: rgb('#ffcc55'),
  apSkin: rgb('#ff1f3d'),
  apFlesh: rgb('#fff6cc'),
  apCore: rgb('#ffe49a'),
  apSeed: rgb('#7a3000'),
  lePeel: rgb('#ffe01a'),
  lePith: rgb('#fffbe8'),
  leIn: rgb('#fff27a'),
  leOut: rgb('#ffe84a'),
  beSkin: rgb('#ff2a48'),
  beFlesh: rgb('#ff5a7a'),
  beCore: rgb('#ffd4de'),
  plSkin: rgb('#7a20d0'),
  plFlesh: rgb('#ffcf3a'),
  plEdge: rgb('#ffa82a'),
  plPit: rgb('#e88a2a'),
  drSkin: rgb('#ff2a9a'),
  drFlesh: rgb('#ffffff'),
  drEdge: rgb('#ffe0f2'),
  drSeed: rgb('#1a1430'),
  stFlesh: rgb('#fff6c0'),
  stLine: rgb('#ffcc3a'),
  frFlesh: rgb('#e8fbff'),
  frLine: rgb('#7ac8ff'),
};

const hash = (x, y) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const ellipse = (x, y, a, b) => (Math.hypot(x / a, y / b) - 1) * Math.min(a, b);
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const h = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - dx * h, py - ay - dy * h);
}
// five-pointed star (Inigo Quilez), pointing up: r outer radius, rf inner ratio
const K1 = [0.809016994375, -0.587785252292];
function star5(x0, y0, r, rf) {
  let px = Math.abs(x0);
  let py = y0;
  let d = Math.max(px * K1[0] + py * K1[1], 0);
  px -= 2 * d * K1[0];
  py -= 2 * d * K1[1];
  d = Math.max(-px * K1[0] + py * K1[1], 0);
  px += 2 * d * K1[0];
  py -= 2 * d * K1[1];
  px = Math.abs(px);
  py -= r;
  const bax = rf * -K1[1];
  const bay = rf * K1[0] - 1;
  const h = Math.min(r, Math.max(0, (px * bax + py * bay) / (bax * bax + bay * bay)));
  const ex = px - bax * h;
  const ey = py - bay * h;
  return Math.hypot(ex, ey) * Math.sign(py * bax - px * bay);
}

/** the light on a sphere at (sx, sy) (unturned, units of the radius): 0 dark .. 1 bright */
function lambert(sx, sy) {
  const zz = 1 - sx * sx - sy * sy;
  const nz = zz > 0 ? Math.sqrt(zz) : 0;
  return -0.5 * sx + 0.62 * sy + 0.6 * nz;
}
function tone(rmp, sx, sy, k = 0) {
  const l = lambert(sx, sy);
  const i = l > 0.8 ? 3 : l > 0.45 ? 2 : l > 0.1 ? 1 : 0;
  return rmp[Math.max(0, i - k)];
}
const glint = (sx, sy) => (sx + 0.4) ** 2 + (sy - 0.44) ** 2 < 0.028;

/** the shape: signed distance (units of the radius, < 0 inside) incl. stems and leaves */
export function shape(kind, x, y) {
  switch (kind) {
    case 'melon':
      return ellipse(x, y, 1, 0.84);
    case 'apple': {
      const body = Math.max(ellipse(x, y + 0.03, 1.04, 1), 0.27 - Math.hypot(x, y - 1.0));
      const stem = segDist(x, y, 0, 0.7, 0.1, 1.18) - 0.07;
      const leaf = ellipse((x - 0.33) * 0.88 + (y - 1.04) * 0.47, -(x - 0.33) * 0.47 + (y - 1.04) * 0.88, 0.3, 0.13);
      return Math.min(body, stem, leaf);
    }
    case 'lemon':
      return Math.min(ellipse(x, y, 1, 0.76), Math.min(Math.hypot(x - 0.95, y), Math.hypot(x + 0.95, y)) - 0.16);
    case 'berry': {
      const w = 0.74 + 0.24 * Math.min(1, Math.max(-1, y));
      return Math.min((Math.hypot(x / w, y + 0.02) - 1) * w, star5(x, y - 0.86, 0.48, 0.42));
    }
    case 'plum':
      return Math.min(ellipse(x, y, 0.92, 1), segDist(x, y, 0.04, 0.9, 0.12, 1.14) - 0.06);
    case 'dragon':
      return ellipse(x, y, 0.84, 1);
    case 'star':
      return star5(x, y, 1.05, 0.55) - 0.06;
    case 'frost': {
      const a = Math.atan2(y, x);
      const tri = Math.abs(((((a / (2 * Math.PI)) * 8) % 1) + 1) % 1 - 0.5) * 2;
      return Math.hypot(x, y) - (0.88 + 0.12 * tri);
    }
    case 'bomb':
      return Math.min(Math.hypot(x, y) - 0.9, segDist(x, y, 0, 0.9, 0, 1.02) - 0.17, segDist(x, y, 0, 1.05, 0.2, 1.3) - 0.055);
    default:
      return Math.hypot(x, y) - 1;
  }
}

/**
 * The skin at (x, y) (turned with the fruit) and (sx, sy) (unturned, for the light), units of the
 * radius; t: time (s) for what sparkles. Returns a color, or null outside the shape.
 */
export function skin(kind, x, y, sx, sy, t) {
  if (shape(kind, x, y) > 0) return null;
  const K = KINDS[kind];
  if (glint(sx, sy) && kind !== 'star') return K.hi;
  switch (kind) {
    case 'melon': {
      const m = y / Math.max(0.3, Math.sqrt(Math.max(0, 1 - x * x * 0.92)));
      const s = (((m * 2.3 + 0.07 * Math.sin(x * 15)) % 1) + 1) % 1;
      return tone(s < 0.42 ? K.stripe : K.skin, sx, sy);
    }
    case 'orange': {
      if (Math.hypot(x - 0.06, y - 0.9) < 0.1) return C.leaf[2];
      const pore = hash(Math.floor(x * 8), Math.floor(y * 8)) < 0.16;
      return tone(K.skin, sx, sy, pore ? 1 : 0);
    }
    case 'apple': {
      if (segDist(x, y, 0, 0.7, 0.1, 1.18) < 0.075 && y > 0.72) return C.stem;
      if (y > 0.88 && x > 0.08) return tone(C.leaf, sx, sy);
      // a lighter streak down one side
      const streak = Math.abs(x + 0.35 - 0.15 * y) < 0.1 && y < 0.6;
      return tone(K.skin, sx, sy, streak ? -1 : 0) ?? K.skin[3];
    }
    case 'lemon': {
      const pore = hash(Math.floor(x * 9), Math.floor(y * 9)) < 0.1;
      return tone(K.skin, sx, sy, pore ? 1 : 0);
    }
    case 'berry': {
      if (y > 0.62 && star5(x, y - 0.86, 0.48, 0.42) < 0) return tone(C.leaf, sx, sy);
      const w = 0.74 + 0.24 * Math.min(1, Math.max(-1, y));
      // seeds on a diagonal lattice
      const u = (x / w + y) * 2.4;
      const v = (x / w - y) * 2.4;
      const du = u - Math.round(u);
      const dv = v - Math.round(v);
      if (du * du + dv * dv < 0.035) return lambert(sx, sy) > 0.2 ? C.seedY : C.seedO;
      return tone(K.skin, sx, sy);
    }
    case 'plum': {
      if (y > 0.88) return C.stem;
      const crease = Math.abs(x - 0.16 * y - 0.04) < 0.05 && y > -0.7;
      return tone(K.skin, sx, sy, crease ? 1 : 0);
    }
    case 'dragon': {
      // green-tipped scales: rows of leaves around the fruit
      const a = Math.atan2(y, x);
      const rr = Math.hypot(x / 0.84, y);
      const row = Math.floor(rr * 3.2);
      const u = (((a / (2 * Math.PI)) * (5 + row * 2) + row * 0.37) % 1 + 1) % 1;
      const v = rr * 3.2 - row;
      if (row >= 1 && Math.abs(u - 0.5) < 0.18 * (1 - v) && v > 0.35) return v > 0.7 ? C.green : C.greenD;
      return tone(K.skin, sx, sy);
    }
    case 'star': {
      // a ridge from the middle to each tip
      const a = Math.atan2(x, y);
      const k = Math.abs(((((a / (2 * Math.PI)) * 5) % 1) + 1) % 1 - 0.5);
      if (k > 0.47 && Math.hypot(x, y) > 0.15) return K.skin[1];
      if (glint(sx, sy)) return K.hi;
      return tone(K.skin, sx, sy);
    }
    case 'frost': {
      const a = Math.atan2(y, x);
      const facet = Math.floor((((a / (2 * Math.PI)) * 8) % 1 + 1) % 1 * 2);
      const sparkle = hash(Math.floor(x * 6), Math.floor(y * 6) + Math.floor(t * 6)) > 0.95;
      if (sparkle) return K.hi;
      return tone(K.skin, sx, sy, facet);
    }
    case 'bomb': {
      if (y > 1.03) return C.fuse;
      if (y > 0.86) return C.cap;
      // a red band that pulses: "danger"
      if (Math.abs(y + 0.05) < 0.13) return Math.sin(t * 9) > -0.2 ? C.red : C.redD;
      return tone(K.skin, sx, sy);
    }
    default:
      return tone(K.skin, sx, sy);
  }
}

/** the cut face: (u, v) in the unit disc of the cross-section; returns a color */
export function flesh(kind, u, v) {
  const d = Math.hypot(u, v);
  const a = Math.atan2(v, u);
  switch (kind) {
    case 'melon': {
      if (d > 0.92) return C.melonRind;
      if (d > 0.82) return C.melonPale;
      if (d > 0.75) return C.melonPink;
      for (let k = 0; k < 8; k++) {
        const b = (k / 8) * Math.PI * 2 + 0.2;
        if (Math.hypot(u - 0.5 * Math.cos(b), v - 0.5 * Math.sin(b)) < 0.075) return C.melonSeed;
      }
      return C.melonRed;
    }
    case 'orange':
    case 'lemon': {
      const o = kind === 'orange';
      if (d > 0.93) return o ? C.orPeel : C.lePeel;
      if (d > 0.84) return o ? C.orPith : C.lePith;
      const sector = (((a / (2 * Math.PI)) * 10) % 1 + 1) % 1;
      if (sector < 0.09 || d < 0.12) return o ? C.orPith : C.lePith;
      if (hash(Math.floor(u * 9), Math.floor(v * 9)) < 0.15) return o ? C.orDot : C.lePith;
      return d < 0.55 ? (o ? C.orIn : C.leIn) : o ? C.orOut : C.leOut;
    }
    case 'apple': {
      if (d > 0.93) return C.apSkin;
      for (let k = 0; k < 5; k++) {
        const b = (k / 5) * Math.PI * 2 + Math.PI / 2;
        if (Math.hypot(u - 0.2 * Math.cos(b), v - 0.2 * Math.sin(b)) < 0.065) return C.apSeed;
      }
      if (star5(u, v, 0.36, 0.5) < 0) return C.apCore;
      return C.apFlesh;
    }
    case 'berry': {
      if (d > 0.88) return C.beSkin;
      const streak = Math.abs((((a / (2 * Math.PI)) * 12) % 1 + 1) % 1 - 0.5) < 0.06 && d > 0.3;
      if (d < 0.3 || streak) return C.beCore;
      return C.beFlesh;
    }
    case 'plum':
      if (d > 0.92) return C.plSkin;
      if ((u / 0.3) ** 2 + (v / 0.42) ** 2 < 1) return C.plPit;
      return d > 0.75 ? C.plEdge : C.plFlesh;
    case 'dragon':
      if (d > 0.9) return C.drSkin;
      if (d > 0.8) return C.drEdge;
      return hash(Math.floor(u * 7.5), Math.floor(v * 7.5)) < 0.22 && hash(Math.floor(u * 15), Math.floor(v * 15)) < 0.5 ? C.drSeed : C.drFlesh;
    case 'star':
      if (d > 0.9) return KINDS.star.skin[2];
      return star5(u, v, 0.55, 0.5) < 0 && star5(u, v, 0.55, 0.5) > -0.06 ? C.stLine : C.stFlesh;
    case 'frost': {
      const k = Math.abs((((a / Math.PI) * 3) % 1 + 1) % 1 - 0.5);
      return k > 0.44 ? C.frLine : C.frFlesh;
    }
    default:
      return C.apFlesh;
  }
}

/** the face of a cut: how deep the cut surface shows, seen a little from the side (units of the radius) */
export const FACE = 0.42;
