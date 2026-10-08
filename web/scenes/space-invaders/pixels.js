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

export const SPRITES = {
  // 30 points: the small one
  squid: parse([
    ['...##...', '..####..', '.######.', '##.##.##', '########', '..#..#..', '.#.##.#.', '#.#..#.#'],
    ['...##...', '..####..', '.######.', '##.##.##', '########', '.#.##.#.', '#......#', '.#....#.'],
  ]),
  // 20 points
  crab: parse([
    ['..#.....#..', '...#...#...', '..#######..', '.##.###.##.', '###########', '#.#######.#', '#.#.....#.#', '...##.##...'],
    ['..#.....#..', '#..#...#..#', '#.#######.#', '###.###.###', '###########', '.#########.', '..#.....#..', '.#.......#.'],
  ]),
  // 10 points: the big one, closest to the city
  octopus: parse([
    ['....####....', '.##########.', '############', '###..##..###', '############', '...##..##...', '..##.##.##..', '##........##'],
    ['....####....', '.##########.', '############', '###..##..###', '############', '..###..###..', '.##..##..##.', '..##....##..'],
  ]),
  ufo: parse([['.....######.....', '...##########...', '..############..', '.##.##.##.##.##.', '################', '..###..##..###..', '...#........#...']]),
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

/** the eyes of each invader (the holes in row 3 of the classic sprites): they glow, and turn red before a shot */
export const EYES = {
  squid: [
    [2, 3],
    [5, 3],
  ],
  crab: [
    [3, 3],
    [7, 3],
  ],
  octopus: [
    [3, 3],
    [4, 3],
    [7, 3],
    [8, 3],
  ],
};

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

export class Pix {
  constructor(w, h) {
    this.resize(w, h);
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
    this.buf = new Uint8ClampedArray(w * h * 4);
    this.img = new ImageData(this.buf, w, h);
  }

  clear() {
    this.buf.fill(0);
  }

  /** one art pixel, color c [r, g, b] 0..1, opacity a: laid over what is there */
  put(x, y, c, a = 1) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || !(a > 0.004)) return;
    const b = this.buf;
    const i = (y * this.w + x) * 4;
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

  rect(x, y, w, h, c, a = 1) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.put(x + i, y + j, c, a);
  }

  /** a sprite frame with its top left corner at (x, y) */
  sprite(f, x, y, c, a = 1, flipX = false) {
    x = Math.round(x);
    y = Math.round(y);
    for (let j = 0; j < f.h; j++) {
      for (let i = 0; i < f.w; i++) {
        if (f.bits[j * f.w + (flipX ? f.w - 1 - i : i)]) this.put(x + i, y + j, c, a);
      }
    }
  }

  /** Bresenham line; thick 2 adds the pixel beside each one (a 2 px line) */
  line(x0, y0, x1, y1, c, a = 1, thick = 1) {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    const steep = -dy > dx;
    let err = dx + dy;
    for (let n = 0; n < 2000; n++) {
      this.put(x0, y0, c, a);
      if (thick > 1) {
        if (steep) this.put(x0 + 1, y0, c, a);
        else this.put(x0, y0 + 1, c, a);
      }
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  disc(cx, cy, r, c, a = 1) {
    const x0 = Math.round(cx);
    const y0 = Math.round(cy);
    const rr = r * r + r * 0.6;
    const n = Math.ceil(r);
    for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) if (i * i + j * j <= rr) this.put(x0 + i, y0 + j, c, a);
  }

  ring(cx, cy, r, c, a = 1) {
    const x0 = Math.round(cx);
    const y0 = Math.round(cy);
    const n = Math.ceil(r) + 1;
    for (let j = -n; j <= n; j++) {
      for (let i = -n; i <= n; i++) {
        const d = Math.sqrt(i * i + j * j);
        if (Math.abs(d - r) < 0.5) this.put(x0 + i, y0 + j, c, a);
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
