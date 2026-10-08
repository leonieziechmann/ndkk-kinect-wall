// The pixel art: sprites (one character = one cell of the LED mosaic), the outfits of the pixel
// people, a 3 x 5 digit font and the colors. Everything is drawn into a cell buffer (Cells) at mosaic
// resolution; main.js scales it onto the LED image and lays the LED raster over it.

/** '#rrggbb' -> [r, g, b] 0..255 */
export function rgb(hex) {
  const v = Number.parseInt(String(hex).slice(1), 16) || 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
export const scale = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

/** cyan, blue, violet, magenta, pink and back: never yellow-green (dim it looks olive) */
export function neon(x) {
  const t = Math.abs((((x % 1) + 1) % 1) * 2 - 1);
  const h = 0.5 + 0.47 * t;
  return [0, 2 / 3, 1 / 3].map((o) => {
    const k = ((h + o) % 1) * 6 - 3;
    return 255 * (1 + (Math.min(1, Math.max(0, Math.abs(k) - 1)) - 1) * 0.8);
  });
}

/** the full rainbow (star power) */
export function rainbow(x) {
  const h = ((x % 1) + 1) % 1;
  return [0, 2 / 3, 1 / 3].map((o) => {
    const k = Math.abs(((h + o) % 1) * 6 - 3);
    return 255 * Math.min(1, Math.max(0, k - 1));
  });
}

/** a stable pseudo-random number 0..1 per integer pair */
export function hash2(i, j) {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---------- sprites ----------

const C = {
  W: '#ffffff',
  K: '#12081f',
  R: '#ff2d55',
  D: '#b0123f',
  O: '#ff7a1a',
  Y: '#ffd23f',
  y: '#fff2a8',
  M: '#ff3fd0',
  P: '#ffb3ee',
  V: '#a24dff',
  v: '#6a2bd0',
  C: '#29e6ff',
  c: '#1478c8',
  B: '#3a5bff',
  G: '#c7f0ff',
};

function sprite(rows, colors = C) {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const px = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.' || ch === ' ') continue;
      px.push([x, y, rgb(colors[ch] ?? '#ff00ff')]);
    }
  });
  return { w, h, px };
}
const frames = (list) => list.map((rows) => sprite(rows));

/** facing left: everything comes from the right (main.js mirrors them for the other direction) */
export const SPRITES = {
  // on the ground: jump over them
  crawler: frames([
    ['..O..O..', '.ORO.RO.', 'ORRRRRRO', 'RWKRRRRR', 'RRRRRRRR', 'RRRRRRRR', '.D..D..D'],
    ['..O..O..', '.ORO.RO.', 'ORRRRRRO', 'RWKRRRRR', 'RRRRRRRR', 'RRRRRRRR', 'D..D..D.'],
  ]),
  flame: frames([
    ['...R..', '..RR..', '..ROR.', '.ROOR.', 'RROYOR', 'ROYyYR', 'ROYyOR', '.RYYR.'],
    ['..R...', '..RR.R', '.RORR.', '.ROOR.', 'ROOYRR', 'ROYyYR', 'RYyyOR', '.RYYR.'],
    ['....R.', '.R.RR.', '.RROR.', 'RROOR.', 'ROYOOR', 'ROYyYR', 'ROyYOR', '.RYYR.'],
  ]),
  crystal: frames([['...M...', '..MPM..', '..MPM.M', 'M.MPMMP', 'MPMMMPM', 'MPMPMMM', 'MMMMMMM']]),
  // in the air at head height: duck under them
  bat: frames([
    ['V.........V', 'VV..V.V..VV', 'VVVVVVVVVVV', '.VVVPVPVVV.', '....VVV....'],
    ['...V...V...', '..VVV.VVV..', '.VVVPVPVVV.', 'VVVVVVVVVVV', 'V...VVV...V'],
    ['....V.V....', '...VVVVV...', '.VVVPVPVVV.', 'VVVVVVVVVVV', 'VV..VVV..VV'],
  ]),
  drone: frames([
    ['CCCC...CCCC', '....c.c....', '..cCCCCCc..', '.cCWKCCCCc.', '..cCCCCCc..', '...R...R...'],
    ['.CC.....CC.', '....c.c....', '..cCCCCCc..', '.cCWKCCCCc.', '..cCCCCCc..', '...O...O...'],
  ]),
  // to collect
  coin: frames([
    ['.YY.', 'YyYY', 'YyYY', 'YYYY', '.YY.'],
    ['.YY.', '.yY.', '.yY.', '.YY.', '.YY.'],
    ['.Y..', '.Y..', '.Y..', '.Y..', '.Y..'],
    ['.YY.', '.Yy.', '.Yy.', '.YY.', '.YY.'],
  ]),
  star: frames([['...W...', '..WWW..', 'WWWWWWW', '.WWWWW.', '..WWW..', '.WW.WW.', 'W.....W']]),
  crown: frames([['Y.Y.Y', 'YYYYY', 'YRYBY']]),
  heart: frames([['RR.RR', 'RRRRR', '.RRR.', '..R..']]),
};

export const LOW = ['crawler', 'flame', 'crystal'];
export const HIGH = ['bat', 'drone'];

// ---------- digits ----------

const DIGITS = [
  '###', '#.#', '#.#', '#.#', '###',
  '.#.', '##.', '.#.', '.#.', '###',
  '###', '..#', '###', '#..', '###',
  '###', '..#', '.##', '..#', '###',
  '#.#', '#.#', '###', '..#', '..#',
  '###', '#..', '###', '..#', '###',
  '###', '#..', '###', '#.#', '###',
  '###', '..#', '.#.', '.#.', '.#.',
  '###', '#.#', '###', '#.#', '###',
  '###', '#.#', '###', '..#', '###',
];

// ---------- the pixel people ----------

export const PART = { NONE: 0, HAIR: 1, SKIN: 2, SHIRT: 3, PANTS: 4, SHOES: 5, SLEEVE: 6 };

// no white shirts: white is the flash of a hit
const SHIRTS = ['#29e6ff', '#ff3fd0', '#9a6bff', '#ff5c7a', '#3dffc0', '#4d8dff', '#ff8be8', '#ff7a1a', '#c58bff', '#00d2c0', '#ffd23f'];
const PANTS = ['#3046c8', '#5b2a9c', '#1f7f8c', '#a02472', '#4430b0', '#2c6fd8', '#7a2fc0', '#203a8a', '#c02a5a'];
const SKIN = ['#ffd5b8', '#f4b48e', '#e0a07a', '#ffe6d2', '#c98d6a'];
const HAIR = ['#2a1840', '#ffd23f', '#ff6a3d', '#7a3dff', '#1ad1ff', '#f5f0ff', '#ff3fd0', '#3a2050'];
const SHOES = ['#ffffff', '#ff2d55', '#29e6ff', '#ffd23f', '#1a1030'];

function hue([r, g, b]) {
  const mx = Math.max(r, g, b);
  const d = mx - Math.min(r, g, b);
  if (!d) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const hueDist = (a, b) => {
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d);
};

/** a stable outfit per person id: shirt, pants, skin, hair, shoes (and short or long sleeves) */
export function outfit(id, slot) {
  const r = (k) => hash2(id * 7 + 13, k);
  const pick = (list, k) => rgb(list[Math.floor(r(k) * list.length) % list.length]);
  // shirt and pants follow the slot (people standing together differ), a little shuffled per person
  const shirt = rgb(SHIRTS[(slot * 4 + Math.floor(r(9) * 2)) % SHIRTS.length]);
  // pants that differ clearly from the shirt (blue on blue reads as one blob)
  let pi = slot * 5 + Math.floor(r(2) * 2);
  let pants = rgb(PANTS[pi % PANTS.length]);
  for (let n = 0; n < PANTS.length && hueDist(pants, shirt) < 55; n++) pants = rgb(PANTS[++pi % PANTS.length]);
  return { shirt, pants, skin: pick(SKIN, 3), hair: pick(HAIR, 4), shoes: pick(SHOES, 5), longSleeves: r(6) < 0.5 };
}

// ---------- the cell buffer ----------

export class Cells {
  constructor(w, h) {
    this.resize(w, h);
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
    this.img = new ImageData(w, h);
    this.data = this.img.data;
  }

  put(x, y, c, a = 1) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 4;
    const d = this.data;
    if (a >= 1) {
      d[o] = c[0];
      d[o + 1] = c[1];
      d[o + 2] = c[2];
    } else if (a > 0) {
      d[o] += (c[0] - d[o]) * a;
      d[o + 1] += (c[1] - d[o + 1]) * a;
      d[o + 2] += (c[2] - d[o + 2]) * a;
    }
  }

  add(x, y, c, a = 1) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 4;
    const d = this.data;
    d[o] += c[0] * a;
    d[o + 1] += c[1] * a;
    d[o + 2] += c[2] * a;
  }

  /** a sprite with its top left cell at (x, y); flip mirrors it; tint replaces its colors */
  sprite(s, x, y, { flip = false, a = 1, tint = null, tintK = 1 } = {}) {
    x = Math.round(x);
    y = Math.round(y);
    for (const [sx, sy, c] of s.px) {
      const col = tint ? mix(c, tint, tintK) : c;
      this.put(x + (flip ? s.w - 1 - sx : sx), y + sy, col, a);
    }
  }

  /** digits (3 x 5 cells, one cell apart); x, y = top left */
  text(str, x, y, c, a = 1) {
    let cx = Math.round(x);
    for (const ch of str) {
      const d = ch.charCodeAt(0) - 48;
      if (d >= 0 && d <= 9) {
        for (let j = 0; j < 5; j++) for (let i = 0; i < 3; i++) if (DIGITS[d * 5 + j][i] === '#') this.put(cx + i, y + j, c, a);
      }
      cx += 4;
    }
  }
}

export const textWidth = (str) => str.length * 4 - 1;
