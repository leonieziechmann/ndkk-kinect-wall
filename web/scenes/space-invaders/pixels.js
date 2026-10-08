// Pixel art: the sprites (the classic Space Invaders bitmaps) and a small RGBA buffer at "art pixel"
// resolution (one art pixel = a few LEDs). Everything of the game is plotted into it pixel by pixel
// (no antialiasing), then the buffer is scaled up onto the LED image without smoothing: crisp blocks.

function parse(frames) {
  return frames.map((rows) => {
    const h = rows.length;
    const w = rows[0].length;
    const bits = new Uint8Array(w * h);
    rows.forEach((row, y) => {
      for (let x = 0; x < w; x++) bits[y * w + x] = row[x] === '#' ? 1 : 0;
    });
    return { w, h, bits };
  });
}

// The invaders seen from above (they hover over the map), facing right: towards the city for the
// formation from the left (the one from the right is drawn mirrored). '#' body, 'e' eyes at the front,
// 'o' the mothership's dome.
const TOP = {
  // 30 points: an arrow, tentacles trailing behind
  squid: [
    ['...........', '#..####....', '.#.######..', '..######e#.', '#.#########', '..######e#.', '.#.######..', '#..####....', '...........'],
    ['...........', '.#.####....', '#..######..', '.#.#####e#.', '..#########', '.#.#####e#.', '#..######..', '.#.####....', '...........'],
  ],
  // 20 points: a shell, legs at the sides, pincers in front
  crab: [
    ['.......##..', '..#.....#.#', '#.#####..#.', '.#######e..', '..#######..', '.#######e..', '#.#####..#.', '..#.....#.#', '.......##..'],
    ['...........', '..#....###.', '#.#####...#', '.#######e..', '..#######..', '.#######e..', '#.#####...#', '..#....###.', '...........'],
  ],
  // 10 points: round, tentacles all around; the front row
  octopus: [
    ['.#.......#.', '..#.....#..', '#..#####...', '.#######e..', '..########.', '.#######e..', '#..#####...', '..#.....#..', '.#.......#.'],
    ['..#.....#..', '...#...#...', '.#.#####...', '#.######e..', '..########.', '#.######e..', '.#.#####...', '...#...#...', '..#.....#..'],
  ],
  // the mothership: a saucer with a dome
  ufo: [['....#######....', '..##.......##..', '.#..#######..#.', '#..##ooooo##..#', '#.##ooooooo##.#', '#.##ooooooo##.#', '#..##ooooo##..#', '.#..#######..#.', '..##.......##..', '....#######....']],
};
const solid = (rows) => rows.map((r) => r.replace(/[eo]/g, '#'));
/** the special pixels of a sprite ('e' eyes, 'o' dome) as [x, y] */
const marks = (rows, ch) => rows.flatMap((r, y) => [...r].map((c, x) => (c === ch ? [x, y] : null)).filter(Boolean));

export const UFO_W = TOP.ufo[0][0].length;
export const UFO_H = TOP.ufo[0].length;
export const UFO_DOME = marks(TOP.ufo[0], 'o');

export const SPRITES = {
  squid: parse(TOP.squid.map(solid)),
  crab: parse(TOP.crab.map(solid)),
  octopus: parse(TOP.octopus.map(solid)),
  ufo: parse(TOP.ufo.map(solid)),
  boom: parse([['....#...#....', '.#...#.#...#.', '..#.......#..', '...#.....#...', '##.........##', '...#.....#...', '..#..#.#..#..', '.#..#...#..#.']]),
  // an invader bullet flying sideways: a zigzag, four frames
  zig: parse([
    ['.#.#...', '#...#.#', '.....#.'],
    ['#...#..', '.#.#...', '......#'],
    ['..#...#', '.#.#.#.', '#...#..'],
    ['.#...#.', '#.#.#.#', '...#...'],
  ]),
  // where a bullet hit the city
  splat: parse([['#..#..#', '.#####.', '##.#.##', '.#####.', '#..#..#']]),
};

export const INVADER_TYPES = ['squid', 'crab', 'octopus'];

/** the eyes of each invader (at its front): they glow, and turn red before a shot */
export const EYES = { squid: marks(TOP.squid[0], 'e'), crab: marks(TOP.crab[0], 'e'), octopus: marks(TOP.octopus[0], 'e') };

/**
 * The battleship, seen from above: '#' hull, 'o' windows, '=' engines (towards the wall), 'E' the
 * laser emitter (towards the audience). 43 x 15 art px.
 */
export const SHIP = [
  '............==...............==............',
  '...........====.............====...........',
  '......#############.....#############......',
  '....################...################....',
  '..###################.###################..',
  '.####o##o##o##o##o#######o##o##o##o##o####.',
  '###########################################',
  '###########################################',
  '.####o##o##o##o##o#######o##o##o##o##o####.',
  '..###################.###################..',
  '....#######.....###########.....#######....',
  '......####........#######........####......',
  '..................#######..................',
  '...................EEEEE...................',
  '....................EEE....................',
];
export const SHIP_W = SHIP[0].length;
export const SHIP_H = SHIP.length;
export const SHIP_BITS = parse([SHIP.map((r) => r.replace(/[^.]/g, '#'))])[0];

/** '#rrggbb' -> [r, g, b] 0..1 */
export function rgb(hex) {
  const v = Number.parseInt(String(hex).slice(1), 16) || 0;
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** cyan, blue, violet, magenta, pink and back (never yellow or green: dim they look olive) */
export function neon(x) {
  const t = Math.abs((((x % 1) + 1) % 1) * 2 - 1);
  const h = 0.5 + 0.47 * t;
  return [0, 2 / 3, 1 / 3].map((o) => {
    const k = ((h + o) % 1) * 6 - 3;
    return 1 + (Math.min(1, Math.max(0, Math.abs(k) - 1)) - 1) * 0.75;
  });
}

/**
 * The game's pixel layer at LED resolution, drawn in blocks: every "art pixel" is a block of S x S
 * LEDs (the blocky look), but a block sits wherever its position falls, to the LED (sub-block
 * placement: smooth motion, clearer shapes). Coordinates are art pixels (floats); `unit` draws smaller
 * blocks for fine detail (0.5: S/2 x S/2 LEDs). ox, oy: where art pixel (0, 0) is on the LEDs.
 */
export class Pix {
  constructor(W = 8, H = 8, S = 1, ox = 0, oy = 0) {
    this.resize(W, H, S, ox, oy);
  }

  resize(W, H, S = 1, ox = 0, oy = 0) {
    this.W = W;
    this.H = H;
    this.S = S;
    this.ox = ox;
    this.oy = oy;
    this.w = Math.floor((W - ox) / S); // in art pixels
    this.h = Math.floor((H - oy) / S);
    this.buf = new Uint8ClampedArray(W * H * 4);
  }

  clear() {
    this.buf.fill(0);
  }

  /** one LED, color c [r, g, b] 0..1, opacity a: laid over what is there */
  dot(X, Y, c, a = 1) {
    if (X < 0 || Y < 0 || X >= this.W || Y >= this.H || !(a > 0.004)) return;
    const b = this.buf;
    const i = (Y * this.W + X) * 4;
    const da = b[i + 3] / 255;
    if (a >= 1 || da === 0) {
      b[i] = c[0] * 255;
      b[i + 1] = c[1] * 255;
      b[i + 2] = c[2] * 255;
      b[i + 3] = Math.max(a, da) * 255;
      return;
    }
    const oa = a + da * (1 - a);
    const k = a / oa;
    b[i] = b[i] + (c[0] * 255 - b[i]) * k;
    b[i + 1] = b[i + 1] + (c[1] * 255 - b[i + 1]) * k;
    b[i + 2] = b[i + 2] + (c[2] * 255 - b[i + 2]) * k;
    b[i + 3] = oa * 255;
  }

  /** a block of `unit` art pixels with its top left corner at art (x, y), placed to the LED */
  put(x, y, c, a = 1, unit = 1) {
    if (!(a > 0.004)) return;
    const n = Math.max(1, Math.round(unit * this.S));
    const X = Math.round(this.ox + x * this.S);
    const Y = Math.round(this.oy + y * this.S);
    if (X >= this.W || Y >= this.H || X + n <= 0 || Y + n <= 0) return;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) this.dot(X + i, Y + j, c, a);
  }

  /** a rectangle of art pixels (w x h), placed to the LED */
  rect(x, y, w, h, c, a = 1) {
    const X0 = Math.round(this.ox + x * this.S);
    const Y0 = Math.round(this.oy + y * this.S);
    const X1 = Math.round(this.ox + (x + w) * this.S);
    const Y1 = Math.round(this.oy + (y + h) * this.S);
    for (let Y = Math.max(0, Y0); Y < Math.min(this.H, Y1); Y++) for (let X = Math.max(0, X0); X < Math.min(this.W, X1); X++) this.dot(X, Y, c, a);
  }

  /** a sprite frame with its top left corner at (x, y); unit: the size of its pixels in art pixels */
  sprite(f, x, y, c, a = 1, flipX = false, unit = 1) {
    for (let j = 0; j < f.h; j++) {
      for (let i = 0; i < f.w; i++) {
        if (f.bits[j * f.w + (flipX ? f.w - 1 - i : i)]) this.put(x + i * unit, y + j * unit, c, a, unit);
      }
    }
  }

  /** a line of blocks; thick 2 adds a block beside each one */
  line(x0, y0, x1, y1, c, a = 1, thick = 1, unit = 1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / unit));
    const steep = Math.abs(dy) > Math.abs(dx);
    let lx = null;
    let ly = null;
    for (let k = 0; k <= n; k++) {
      const x = x0 + (dx * k) / n;
      const y = y0 + (dy * k) / n;
      const X = Math.round(this.ox + x * this.S);
      const Y = Math.round(this.oy + y * this.S);
      if (X === lx && Y === ly) continue;
      lx = X;
      ly = Y;
      this.put(x - unit / 2, y - unit / 2, c, a, unit);
      if (thick > 1) {
        if (steep) this.put(x + unit / 2, y - unit / 2, c, a, unit);
        else this.put(x - unit / 2, y + unit / 2, c, a, unit);
      }
    }
  }

  disc(cx, cy, r, c, a = 1, unit = 1) {
    const rr = r * r + r * 0.6 * unit;
    const n = Math.ceil(r / unit);
    for (let j = -n; j <= n; j++) {
      for (let i = -n; i <= n; i++) {
        const x = i * unit;
        const y = j * unit;
        if (x * x + y * y <= rr) this.put(cx + x - unit / 2, cy + y - unit / 2, c, a, unit);
      }
    }
  }

  ring(cx, cy, r, c, a = 1, unit = 1) {
    const n = Math.ceil(r / unit) + 1;
    for (let j = -n; j <= n; j++) {
      for (let i = -n; i <= n; i++) {
        const d = Math.hypot(i * unit, j * unit);
        if (Math.abs(d - r) < 0.5 * unit) this.put(cx + i * unit - unit / 2, cy + j * unit - unit / 2, c, a, unit);
      }
    }
  }
}
SPRITES.ship = [SHIP_BITS];

/** power-up icons, 7 x 7 art px */
export const ICONS = Object.fromEntries(
  Object.entries({
    repair: ['..###..', '..###..', '#######', '#######', '#######', '..###..', '..###..'],
    rapid: ['#..#...', '.#..#..', '..#..#.', '...#..#', '..#..#.', '.#..#..', '#..#...'],
    spread: ['#..#..#', '.#.#.#.', '..###..', '...#...', '...#...', '...#...', '..###..'],
    shield: ['..###..', '.#...#.', '#.....#', '#..#..#', '#.....#', '.#...#.', '..###..'],
    nova: ['...#...', '.#.#.#.', '..###..', '#######', '..###..', '.#.#.#.', '...#...'],
    mega: ['...###.', '..###..', '.###...', '#######', '...###.', '..###..', '.###...'],
    slow: ['#######', '.#...#.', '..#.#..', '...#...', '..#.#..', '.#...#.', '#######'],
  }).map(([k, rows]) => [k, parse([rows])[0]]),
);
export const POWER_COLORS = {
  repair: rgb('#3dffc0'),
  rapid: rgb('#ffb02e'),
  spread: rgb('#29e6ff'),
  shield: rgb('#8ec8ff'),
  nova: rgb('#ff5cf0'),
  mega: rgb('#ffd6f4'),
  slow: rgb('#b07cff'),
};

/** the jump hint (no text): a little figure crouching and jumping, an arrow up; 7 x 9 art px */
export const JUMP_HINT = {
  crouch: parse([['..###..', '..###..', '...#...', '.#####.', '#..#..#', '...#...', '..#.#..', '.#...#.', '.##.##.']])[0],
  jump: parse([['#.###.#', '#.###.#', '.#.#.#.', '..###..', '...#...', '...#...', '..#.#..', '.#...#.', '#.....#']])[0],
  arrow: parse([['...#...', '..#.#..', '.#...#.']])[0],
  // the answer to a jump: big chevrons shooting up
  chevron: parse([['....#....', '...###...', '..##.##..', '.##...##.', '##.....##']])[0],
};

/**
 * A person seen from above, in half blocks (drawn with unit 0.5: rounder than whole blocks): 'h' head
 * (hair), '#' shoulders, 'a' arms at the sides. Made from ellipses: shoulders 21 x 9, arms 4 x 7 at
 * both ends, the head (diameter 9) a little to the front. personCell(x, y): the part at x (to the
 * right), y (to the back) half px from the middle; PERSON: facing up, 26 x 13.
 */
export function personCell(x, y) {
  const inE = (cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  if (inE(0, -1.5, 4.6, 4.6)) return 'h';
  if (inE(0, 1, 10.5, 4.6)) return '#';
  x = Math.abs(x);
  if (inE(10.4, 1, 2.1, 3.6)) return 'a';
  return '.';
}
export const PERSON = Array.from({ length: 13 }, (_, y) => Array.from({ length: 26 }, (_, x) => personCell(x + 0.5 - 13, y + 0.5 - 6.5)).join(''));
export const PERSON_W = PERSON[0].length;
export const PERSON_H = PERSON.length;
export const PERSON_UNIT = 0.5; // art px per sprite pixel
/** the figure turns in steps of 360° / TURNS (no flicker of single pixels while it turns a little) */
export const TURNS = 24;
const turned = new Map();
/**
 * The figure turned to face `face` (rad on the map, 0 = right, -π/2 = up), in half px: { w, h, ox, oy,
 * cells } with cells[j * w + i] the part at (i + 0.5 - ox, j + 0.5 - oy) half px from the middle (the
 * middle on a column edge and a row center, as in PERSON: facing the wall it is exactly PERSON).
 */
export function personTurned(face) {
  const q = ((Math.round((face / (Math.PI * 2)) * TURNS) % TURNS) + TURNS) % TURNS;
  let g = turned.get(q);
  if (g) return g;
  const a = (q / TURNS) * Math.PI * 2;
  const f = [Math.cos(a), Math.sin(a)];
  const n = Math.ceil(Math.hypot(PERSON_W, PERSON_H) / 2) + 1;
  g = { w: 2 * n, h: 2 * n + 1, ox: n, oy: n + 0.5, cells: [] };
  for (let j = 0; j < g.h; j++) {
    for (let i = 0; i < g.w; i++) {
      const x = i + 0.5 - g.ox;
      const y = j + 0.5 - g.oy;
      // right of the figure: f turned by +90° on the map (y down); back: -f
      g.cells.push(personCell(-x * f[1] + y * f[0], -(x * f[0] + y * f[1])));
    }
  }
  turned.set(q, g);
  return g;
}
/** the figure's frame on the map: f forward, r to its right (art px directions) */
export function facing(face) {
  const f = [Math.cos(face), Math.sin(face)];
  return { f, r: [-f[1], f[0]] };
}
/** a stretched-out arm of the figure, in art px: from its shoulder joint (beside the middle), its longest reach beyond */
export const ARM = { shoulder: 4.5, reach: 7, thick: 0.9, hand: 1.3 };
