//! Pixel art (pixels.js): the sprites (the classic Space Invaders bitmaps, seen from above) and the
//! game's pixel layer. Everything of the game is plotted into it pixel by pixel (no antialiasing),
//! as blocks of S x S LEDs placed to the LED (Pix), and uploaded as it is: crisp blocks.

use std::f64::consts::{PI, TAU};
use std::sync::LazyLock;

pub type Rgb = [f64; 3];

pub const WHITE: Rgb = [1.0, 1.0, 1.0];
pub const BLACK: Rgb = [0.0, 0.0, 0.0];

/// floor without a libm call (f64::floor is one on plain x86-64); NaN and infinities pass through
#[inline]
pub fn floor(x: f64) -> f64 {
    if x.abs() < 4.5e15 {
        let t = x as i64 as f64;
        if t > x { t - 1.0 } else { t }
    } else {
        x.floor()
    }
}

/// Math.round (halves up)
#[inline]
pub fn jr(x: f64) -> f64 {
    floor(x + 0.5)
}

/// Math.sign
#[inline]
pub fn jsign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

#[inline]
pub fn clamp(x: f64, a: f64, b: f64) -> f64 {
    b.min(a.max(x))
}

#[inline]
pub fn mix(a: Rgb, b: Rgb, k: f64) -> Rgb {
    [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

#[inline]
pub fn scale(a: Rgb, k: f64) -> Rgb {
    [a[0] * k, a[1] * k, a[2] * k]
}

/// a pseudo random 0..1 of a number (draw.js hash)
#[inline]
pub fn hash(n: f64) -> f64 {
    let v = (n * 127.1 + 311.7).sin() * 43758.5453;
    v - v.floor()
}

/// 0xrrggbb -> [r, g, b] 0..1
pub const fn hex(v: u32) -> Rgb {
    [((v >> 16) & 255) as f64 / 255.0, ((v >> 8) & 255) as f64 / 255.0, (v & 255) as f64 / 255.0]
}

/// cyan, blue, violet, magenta, pink and back (never yellow or green: dim they look olive)
pub fn neon(x: f64) -> Rgb {
    let t = ((((x % 1.0) + 1.0) % 1.0) * 2.0 - 1.0).abs();
    let h = 0.5 + 0.47 * t;
    let ch = |o: f64| {
        let k = ((h + o) % 1.0) * 6.0 - 3.0;
        1.0 + (1.0_f64.min(0.0_f64.max(k.abs() - 1.0)) - 1.0) * 0.75
    };
    [ch(0.0), ch(2.0 / 3.0), ch(1.0 / 3.0)]
}

/// A 1-bit sprite: bits[y * w + x].
pub struct Sprite {
    pub w: usize,
    pub h: usize,
    pub bits: Vec<bool>,
}

impl Sprite {
    #[inline]
    pub fn at(&self, i: usize, j: usize) -> bool {
        i < self.w && j < self.h && self.bits.get(j * self.w + i).copied().unwrap_or(false)
    }
}

/// rows of '#' (set) and anything else (empty)
fn parse(rows: &[&str]) -> Sprite {
    let h = rows.len();
    let w = rows.first().map_or(0, |r| r.len());
    let mut bits = vec![false; w * h];
    for (y, row) in rows.iter().enumerate() {
        for (x, ch) in row.bytes().enumerate().take(w) {
            bits[y * w + x] = ch == b'#';
        }
    }
    Sprite { w, h, bits }
}

/// the sprite with its special pixels (eyes, dome) filled
fn parse_solid(rows: &[&str]) -> Sprite {
    let solid: Vec<String> = rows.iter().map(|r| r.replace(['e', 'o'], "#")).collect();
    let refs: Vec<&str> = solid.iter().map(String::as_str).collect();
    parse(&refs)
}

/// the special pixels of a sprite ('e' eyes, 'o' dome) as (x, y)
fn marks(rows: &[&str], ch: u8) -> Vec<(i32, i32)> {
    let mut out = Vec::new();
    for (y, r) in rows.iter().enumerate() {
        for (x, c) in r.bytes().enumerate() {
            if c == ch {
                out.push((x as i32, y as i32));
            }
        }
    }
    out
}

// The invaders seen from above (they hover over the map), facing right: towards the city for the
// formation from the left (the one from the right is drawn mirrored). '#' body, 'e' eyes at the front,
// 'o' the mothership's dome.
/// 30 points: an arrow, tentacles trailing behind
const SQUID: [[&str; 9]; 2] = [
    ["...........", "#..####....", ".#.######..", "..######e#.", "#.#########", "..######e#.", ".#.######..", "#..####....", "..........."],
    ["...........", ".#.####....", "#..######..", ".#.#####e#.", "..#########", ".#.#####e#.", "#..######..", ".#.####....", "..........."],
];
/// 20 points: a shell, legs at the sides, pincers in front
const CRAB: [[&str; 9]; 2] = [
    [".......##..", "..#.....#.#", "#.#####..#.", ".#######e..", "..#######..", ".#######e..", "#.#####..#.", "..#.....#.#", ".......##.."],
    ["...........", "..#....###.", "#.#####...#", ".#######e..", "..#######..", ".#######e..", "#.#####...#", "..#....###.", "..........."],
];
/// 10 points: round, tentacles all around; the front row
const OCTOPUS: [[&str; 9]; 2] = [
    [".#.......#.", "..#.....#..", "#..#####...", ".#######e..", "..########.", ".#######e..", "#..#####...", "..#.....#..", ".#.......#."],
    ["..#.....#..", "...#...#...", ".#.#####...", "#.######e..", "..########.", "#.######e..", ".#.#####...", "...#...#...", "..#.....#.."],
];
/// the mothership: a saucer with a dome
const UFO: [&str; 10] = [
    "....#######....",
    "..##.......##..",
    ".#..#######..#.",
    "#..##ooooo##..#",
    "#.##ooooooo##.#",
    "#.##ooooooo##.#",
    "#..##ooooo##..#",
    ".#..#######..#.",
    "..##.......##..",
    "....#######....",
];

pub const UFO_W: f64 = 15.0;
pub const UFO_H: f64 = 10.0;

/// The battleship, seen from above: '#' hull, 'o' windows, '=' engines (towards the wall), 'E' the
/// laser emitter (towards the audience). 43 x 15 art px.
pub const SHIP: [&str; 15] = [
    "............==...............==............",
    "...........====.............====...........",
    "......#############.....#############......",
    "....################...################....",
    "..###################.###################..",
    ".####o##o##o##o##o#######o##o##o##o##o####.",
    "###########################################",
    "###########################################",
    ".####o##o##o##o##o#######o##o##o##o##o####.",
    "..###################.###################..",
    "....#######.....###########.....#######....",
    "......####........#######........####......",
    "..................#######..................",
    "...................EEEEE...................",
    "....................EEE....................",
];
pub const SHIP_W: f64 = 43.0;
pub const SHIP_H: f64 = 15.0;

/// The invader types (and the other sprites that can go to pieces).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Squid,
    Crab,
    Octopus,
    Ufo,
    Ship,
}

pub const INVADER_TYPES: [Kind; 3] = [Kind::Squid, Kind::Crab, Kind::Octopus];

impl Kind {
    /// index into the invader tables (0..3), the others 0
    pub fn idx(self) -> usize {
        match self {
            Kind::Crab => 1,
            Kind::Octopus => 2,
            _ => 0,
        }
    }
}

/// The power-ups.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Power {
    Repair,
    Rapid,
    Spread,
    Shield,
    Nova,
    Mega,
    Slow,
}

pub const POWERS: [Power; 7] = [Power::Repair, Power::Rapid, Power::Spread, Power::Shield, Power::Nova, Power::Mega, Power::Slow];

impl Power {
    pub fn idx(self) -> usize {
        self as usize
    }
    pub fn color(self) -> Rgb {
        POWER_COLORS[self.idx()]
    }
}

pub const POWER_COLORS: [Rgb; 7] = [hex(0x3dffc0), hex(0xffb02e), hex(0x29e6ff), hex(0x8ec8ff), hex(0xff5cf0), hex(0xffd6f4), hex(0xb07cff)];

/// power-up icons, 7 x 7 art px (in POWERS order)
const ICONS: [[&str; 7]; 7] = [
    ["..###..", "..###..", "#######", "#######", "#######", "..###..", "..###.."],
    ["#..#...", ".#..#..", "..#..#.", "...#..#", "..#..#.", ".#..#..", "#..#..."],
    ["#..#..#", ".#.#.#.", "..###..", "...#...", "...#...", "...#...", "..###.."],
    ["..###..", ".#...#.", "#.....#", "#..#..#", "#.....#", ".#...#.", "..###.."],
    ["...#...", ".#.#.#.", "..###..", "#######", "..###..", ".#.#.#.", "...#..."],
    ["...###.", "..###..", ".###...", "#######", "...###.", "..###..", ".###..."],
    ["#######", ".#...#.", "..#.#..", "...#...", "..#.#..", ".#...#.", "#######"],
];

/// A person seen from above, in half blocks (drawn with unit 0.5): 'h' head (hair), '#' shoulders,
/// 'a' arms at the sides. Made from ellipses: shoulders 21 x 9, arms 4 x 7 at both ends, the head
/// (diameter 9) a little to the front. The part at x (to the right), y (to the back) half px from
/// the middle.
pub const CELL_NONE: u8 = 0;
pub const CELL_HEAD: u8 = 1;
pub const CELL_BODY: u8 = 2;
pub const CELL_ARM: u8 = 3;

pub fn person_cell(x: f64, y: f64) -> u8 {
    let in_e = |x: f64, cx: f64, cy: f64, rx: f64, ry: f64| ((x - cx) / rx).powi(2) + ((y - cy) / ry).powi(2) <= 1.0;
    if in_e(x, 0.0, -1.5, 4.6, 4.6) {
        return CELL_HEAD;
    }
    if in_e(x, 0.0, 1.0, 10.5, 4.6) {
        return CELL_BODY;
    }
    if in_e(x.abs(), 10.4, 1.0, 2.1, 3.6) {
        return CELL_ARM;
    }
    CELL_NONE
}

/// PERSON: facing up, 26 x 13 half px
pub const PERSON_W: f64 = 26.0;
pub const PERSON_H: f64 = 13.0;
/// art px per sprite pixel
pub const PERSON_UNIT: f64 = 0.5;
/// the figure turns in steps of 360° / TURNS (no flicker of single pixels while it turns a little)
pub const TURNS: usize = 24;

/// The figure turned to face a direction, in half px: cells[j * w + i] the part at (i + 0.5 - ox,
/// j + 0.5 - oy) half px from the middle.
pub struct Turned {
    pub w: i32,
    pub h: i32,
    pub ox: f64,
    pub oy: f64,
    pub cells: Vec<u8>,
}

impl Turned {
    #[inline]
    pub fn at(&self, i: i32, j: i32) -> u8 {
        if i >= 0 && j >= 0 && i < self.w && j < self.h { self.cells.get((j * self.w + i) as usize).copied().unwrap_or(CELL_NONE) } else { CELL_NONE }
    }
}

fn make_turned(q: usize) -> Turned {
    let a = (q as f64 / TURNS as f64) * PI * 2.0;
    let f = [a.cos(), a.sin()];
    let n = (PERSON_W.hypot(PERSON_H) / 2.0).ceil() as i32 + 1;
    let (w, h) = (2 * n, 2 * n + 1);
    let (ox, oy) = (f64::from(n), f64::from(n) + 0.5);
    let mut cells = Vec::with_capacity((w * h) as usize);
    for j in 0..h {
        for i in 0..w {
            let x = f64::from(i) + 0.5 - ox;
            let y = f64::from(j) + 0.5 - oy;
            // right of the figure: f turned by +90° on the map (y down); back: -f
            cells.push(person_cell(-x * f[1] + y * f[0], -(x * f[0] + y * f[1])));
        }
    }
    Turned { w, h, ox, oy, cells }
}

/// the figure's frame on the map: f forward, r to its right (art px directions)
pub fn facing(face: f64) -> ([f64; 2], [f64; 2]) {
    let f = [face.cos(), face.sin()];
    (f, [-f[1], f[0]])
}

/// a stretched-out arm of the figure, in art px: from its shoulder joint (beside the middle), its
/// longest reach beyond
pub struct ArmShape {
    pub shoulder: f64,
    pub reach: f64,
    pub thick: f64,
    pub hand: f64,
}
pub const ARM: ArmShape = ArmShape { shoulder: 4.5, reach: 7.0, thick: 0.9, hand: 1.3 };

/// A sprite turned for a direction of flight, with its eyes.
pub struct Oriented {
    pub f: Sprite,
    pub eyes: Vec<(i32, i32)>,
}

/// Every sprite, parsed once.
pub struct Art {
    /// [type][frame]: squid, crab, octopus
    pub inv: [[Sprite; 2]; 3],
    /// the eyes of each invader (at its front): they glow, and turn red before a shot
    pub eyes: [Vec<(i32, i32)>; 3],
    /// turned a quarter clockwise (facing down), and that mirrored (facing up): [type][frame]
    pub down: [[Oriented; 2]; 3],
    pub up: [[Oriented; 2]; 3],
    pub ufo: Sprite,
    pub ufo_dome: Vec<(i32, i32)>,
    pub boom: Sprite,
    /// an invader bullet flying sideways: a zigzag, four frames
    pub zig: [Sprite; 4],
    /// where a bullet hit the city
    pub splat: Sprite,
    pub ship: Sprite,
    pub icons: [Sprite; 7],
    /// the jump hint (no text): a little figure crouching and jumping, an arrow up; 7 x 9 art px
    pub crouch: Sprite,
    pub jump: Sprite,
    pub arrow: Sprite,
    /// the answer to a jump: big chevrons shooting up
    pub chevron: Sprite,
    pub turned: Vec<Turned>,
}

impl Art {
    /// SPRITES[type][frame] (ufo and ship have one frame)
    pub fn frame(&self, k: Kind, frame: usize) -> &Sprite {
        match k {
            Kind::Ufo => &self.ufo,
            Kind::Ship => &self.ship,
            _ => &self.inv[k.idx()][frame & 1],
        }
    }

    /// the figure turned to face `face` (rad on the map, 0 = right, -π/2 = up)
    pub fn person_turned(&self, face: f64) -> &Turned {
        let r = jr((face / TAU) * TURNS as f64);
        let q = if r.is_finite() { ((r as i64 % TURNS as i64) + TURNS as i64) % TURNS as i64 } else { 0 };
        &self.turned[q as usize]
    }

    /// a sprite and its eyes for a direction of flight (right, left, down or up): (sprite, eyes, flip)
    pub fn oriented(&self, k: Kind, frame: usize, vx: f64, vy: f64) -> (&Sprite, &[(i32, i32)], bool) {
        let t = k.idx();
        let fr = frame & 1;
        if vx.abs() >= vy.abs() {
            return (&self.inv[t][fr], &self.eyes[t], vx < 0.0);
        }
        let o = if vy < 0.0 { &self.up[t][fr] } else { &self.down[t][fr] };
        (&o.f, &o.eyes, false)
    }
}

/// turned a quarter clockwise: facing down
fn facing_down(f: &Sprite, eyes: &[(i32, i32)]) -> Oriented {
    let mut bits = vec![false; f.w * f.h];
    for j in 0..f.w {
        for i in 0..f.h {
            bits[j * f.h + i] = f.at(j, f.h - 1 - i);
        }
    }
    let eyes = eyes.iter().map(|&(ex, ey)| (f.h as i32 - 1 - ey, ex)).collect();
    Oriented { f: Sprite { w: f.h, h: f.w, bits }, eyes }
}

/// mirrored up-down (for divers flying upwards)
fn flipped_y(o: &Oriented) -> Oriented {
    let f = &o.f;
    let mut bits = vec![false; f.w * f.h];
    for j in 0..f.h {
        for i in 0..f.w {
            bits[j * f.w + i] = f.at(i, f.h - 1 - j);
        }
    }
    Oriented { f: Sprite { w: f.w, h: f.h, bits }, eyes: o.eyes.iter().map(|&(ex, ey)| (ex, f.h as i32 - 1 - ey)).collect() }
}

pub static ART: LazyLock<Art> = LazyLock::new(|| {
    let frames = |t: &[[&str; 9]; 2]| [parse_solid(&t[0]), parse_solid(&t[1])];
    let inv = [frames(&SQUID), frames(&CRAB), frames(&OCTOPUS)];
    let eyes = [marks(&SQUID[0], b'e'), marks(&CRAB[0], b'e'), marks(&OCTOPUS[0], b'e')];
    let down: [[Oriented; 2]; 3] = std::array::from_fn(|t| std::array::from_fn(|fr| facing_down(&inv[t][fr], &eyes[t])));
    let up: [[Oriented; 2]; 3] = std::array::from_fn(|t| std::array::from_fn(|fr| flipped_y(&down[t][fr])));
    let ship_rows: Vec<String> = SHIP.iter().map(|r| r.chars().map(|c| if c == '.' { '.' } else { '#' }).collect()).collect();
    let ship_refs: Vec<&str> = ship_rows.iter().map(String::as_str).collect();
    Art {
        inv,
        eyes,
        down,
        up,
        ufo: parse_solid(&UFO),
        ufo_dome: marks(&UFO, b'o'),
        boom: parse(&["....#...#....", ".#...#.#...#.", "..#.......#..", "...#.....#...", "##.........##", "...#.....#...", "..#..#.#..#..", ".#..#...#..#."]),
        zig: [
            parse(&[".#.#...", "#...#.#", ".....#."]),
            parse(&["#...#..", ".#.#...", "......#"]),
            parse(&["..#...#", ".#.#.#.", "#...#.."]),
            parse(&[".#...#.", "#.#.#.#", "...#..."]),
        ],
        splat: parse(&["#..#..#", ".#####.", "##.#.##", ".#####.", "#..#..#"]),
        ship: parse(&ship_refs),
        icons: std::array::from_fn(|k| parse(&ICONS[k])),
        crouch: parse(&["..###..", "..###..", "...#...", ".#####.", "#..#..#", "...#...", "..#.#..", ".#...#.", ".##.##."]),
        jump: parse(&["#.###.#", "#.###.#", ".#.#.#.", "..###..", "...#...", "...#...", "..#.#..", ".#...#.", "#.....#"]),
        arrow: parse(&["...#...", "..#.#..", ".#...#."]),
        chevron: parse(&["....#....", "...###...", "..##.##..", ".##...##.", "##.....##"]),
        turned: (0..TURNS).map(make_turned).collect(),
    }
});

/// Uint8ClampedArray: clamped to 0..255, rounded half to even
#[inline]
fn u8c(v: f64) -> u8 {
    if v.is_nan() || v <= 0.0 {
        return 0;
    }
    if v >= 255.0 {
        return 255;
    }
    let r = (v + 0.5) as i32;
    (if f64::from(r) - v == 0.5 && r & 1 == 1 { r - 1 } else { r }) as u8
}

/// One color laid over a pixel with opacity a (Pix.dot), its bytes worked out once.
#[derive(Clone, Copy)]
pub struct Paint {
    /// the color ×255, as bytes
    c: [f64; 3],
    b: [u8; 3],
    a: f64,
    /// the alpha written over an empty pixel
    a_empty: u8,
}

impl Paint {
    #[inline]
    pub fn new(c: Rgb, a: f64) -> Self {
        let cf = [c[0] * 255.0, c[1] * 255.0, c[2] * 255.0];
        Self { c: cf, b: [u8c(cf[0]), u8c(cf[1]), u8c(cf[2])], a, a_empty: if a >= 1.0 { 255 } else { u8c(a * 255.0) } }
    }

    #[inline]
    fn apply(&self, px: &mut [u8]) {
        if px.len() < 4 {
            return;
        }
        let d = px[3];
        if self.a >= 1.0 || d == 0 {
            px[0] = self.b[0];
            px[1] = self.b[1];
            px[2] = self.b[2];
            px[3] = self.a_empty;
            return;
        }
        let da = f64::from(d) / 255.0;
        let oa = self.a + da * (1.0 - self.a);
        let k = self.a / oa;
        for (o, &c) in px.iter_mut().zip(&self.c) {
            let v = f64::from(*o);
            *o = u8c(v + (c - v) * k);
        }
        px[3] = u8c(oa * 255.0);
    }
}

/// The game's pixel layer at LED resolution, drawn in blocks: every "art pixel" is a block of S x S
/// LEDs (the blocky look), but a block sits wherever its position falls, to the LED (sub-block
/// placement: smooth motion, clearer shapes). Coordinates are art pixels (floats); `unit` draws
/// smaller blocks for fine detail (0.5: S/2 x S/2 LEDs). ox, oy: where art pixel (0, 0) is on the LEDs.
pub struct Pix {
    pub led_w: i32,
    pub led_h: i32,
    pub s: f64,
    pub ox: f64,
    pub oy: f64,
    /// in art pixels
    pub w: i32,
    pub h: i32,
    /// RGBA, not premultiplied
    pub buf: Vec<u8>,
}

impl Pix {
    pub fn new() -> Self {
        let mut p = Self { led_w: 0, led_h: 0, s: 1.0, ox: 0.0, oy: 0.0, w: 0, h: 0, buf: Vec::new() };
        p.resize(8, 8, 1, 0, 0);
        p
    }

    pub fn resize(&mut self, w: i32, h: i32, s: i32, ox: i32, oy: i32) {
        self.led_w = w.max(1);
        self.led_h = h.max(1);
        self.s = f64::from(s.max(1));
        self.ox = f64::from(ox);
        self.oy = f64::from(oy);
        self.w = (f64::from(w - ox) / self.s).floor() as i32;
        self.h = (f64::from(h - oy) / self.s).floor() as i32;
        self.buf = vec![0; (self.led_w * self.led_h * 4) as usize];
    }

    pub fn clear(&mut self) {
        self.buf.fill(0);
    }

    /// one LED, color c [r, g, b] 0..1, opacity a: laid over what is there
    #[inline]
    pub fn dot(&mut self, x: i32, y: i32, c: Rgb, a: f64) {
        if x < 0 || y < 0 || x >= self.led_w || y >= self.led_h || a.is_nan() || a <= 0.004 {
            return;
        }
        let i = ((y * self.led_w + x) * 4) as usize;
        if let Some(px) = self.buf.get_mut(i..i + 4) {
            Paint::new(c, a).apply(px);
        }
    }

    /// a rectangle of LEDs [x0, x1) x [y0, y1) in one paint (clipped)
    #[inline]
    fn fill_leds(&mut self, x0: i64, y0: i64, x1: i64, y1: i64, p: &Paint) {
        let (w, h) = (i64::from(self.led_w), i64::from(self.led_h));
        let (x0, x1, y0, y1) = (x0.max(0), x1.min(w), y0.max(0), y1.min(h));
        if x0 >= x1 || y0 >= y1 {
            return;
        }
        for y in y0..y1 {
            let a = ((y * w + x0) * 4) as usize;
            let b = ((y * w + x1) * 4) as usize;
            if let Some(row) = self.buf.get_mut(a..b) {
                for px in row.as_chunks_mut::<4>().0 {
                    p.apply(px);
                }
            }
        }
    }

    /// w x h LEDs at (x, y) copied from an RGBA picture (src_w LEDs per row, from its (sx, sy)),
    /// clipped: as dot() with the picture's colors and its opacity (1)
    #[allow(clippy::too_many_arguments)]
    pub fn blit_rgba(&mut self, x: i64, y: i64, w: usize, h: usize, src: &[u8], src_w: usize, sx: usize, sy: usize) {
        let (lw, lh) = (i64::from(self.led_w), i64::from(self.led_h));
        let x0 = x.max(0);
        let x1 = (x + w as i64).min(lw);
        if x0 >= x1 {
            return;
        }
        let skip = (x0 - x) as usize;
        let n = (x1 - x0) as usize;
        for v in 0..h {
            let yy = y + v as i64;
            if yy < 0 || yy >= lh {
                continue;
            }
            let o = ((sy + v) * src_w + sx + skip) * 4;
            let d = ((yy * lw + x0) * 4) as usize;
            if let (Some(s), Some(dst)) = (src.get(o..o + n * 4), self.buf.get_mut(d..d + n * 4)) {
                dst.copy_from_slice(s);
            }
        }
    }

    /// a block of `unit` art pixels with its top left corner at art (x, y), placed to the LED
    #[inline]
    pub fn put(&mut self, x: f64, y: f64, c: Rgb, a: f64, unit: f64) {
        if a.is_nan() || a <= 0.004 {
            return;
        }
        self.put_p(x, y, &Paint::new(c, a), unit);
    }

    /// put() with a paint worked out before
    #[inline]
    pub fn put_p(&mut self, x: f64, y: f64, p: &Paint, unit: f64) {
        if p.a.is_nan() || p.a <= 0.004 {
            return;
        }
        let n = jr(unit * self.s).max(1.0);
        let px = jr(self.ox + x * self.s);
        let py = jr(self.oy + y * self.s);
        if !(px < f64::from(self.led_w) && py < f64::from(self.led_h) && px + n > 0.0 && py + n > 0.0) {
            return;
        }
        let (px, py, n) = (px as i64, py as i64, n as i64);
        self.fill_leds(px, py, px + n, py + n, p);
    }

    /// a rectangle of art pixels (w x h), placed to the LED
    pub fn rect(&mut self, x: f64, y: f64, w: f64, h: f64, c: Rgb, a: f64) {
        if a.is_nan() || a <= 0.004 {
            return;
        }
        let x0 = jr(self.ox + x * self.s);
        let y0 = jr(self.oy + y * self.s);
        let x1 = jr(self.ox + (x + w) * self.s);
        let y1 = jr(self.oy + (y + h) * self.s);
        if ![x0, y0, x1, y1].iter().all(|v| v.is_finite()) {
            return;
        }
        // a loop from x0 while x < x1: integer bounds (ceil of a whole number is itself)
        self.fill_leds(x0 as i64, y0 as i64, x1.ceil() as i64, y1.ceil() as i64, &Paint::new(c, a));
    }

    /// a sprite frame with its top left corner at (x, y); unit: the size of its pixels in art pixels
    #[allow(clippy::too_many_arguments)]
    pub fn sprite(&mut self, f: &Sprite, x: f64, y: f64, c: Rgb, a: f64, flip_x: bool, unit: f64) {
        if a.is_nan() || a <= 0.004 {
            return;
        }
        let p = Paint::new(c, a);
        for j in 0..f.h {
            for i in 0..f.w {
                if f.at(if flip_x { f.w - 1 - i } else { i }, j) {
                    self.put_p(x + i as f64 * unit, y + j as f64 * unit, &p, unit);
                }
            }
        }
    }

    /// a line of blocks; thick 2 adds a block beside each one
    #[allow(clippy::too_many_arguments)]
    pub fn line(&mut self, x0: f64, y0: f64, x1: f64, y1: f64, c: Rgb, a: f64, thick: u32, unit: f64) {
        let dx = x1 - x0;
        let dy = y1 - y0;
        let n = 1.0_f64.max((dx.abs().max(dy.abs()) / unit).ceil());
        if !n.is_finite() || n > 100_000.0 {
            return;
        }
        let steep = dy.abs() > dx.abs();
        let p = Paint::new(c, a);
        let (mut lx, mut ly) = (f64::NAN, f64::NAN);
        let n_i = n as i64;
        for k in 0..=n_i {
            let kf = k as f64;
            let x = x0 + (dx * kf) / n;
            let y = y0 + (dy * kf) / n;
            let px = jr(self.ox + x * self.s);
            let py = jr(self.oy + y * self.s);
            if px == lx && py == ly {
                continue;
            }
            lx = px;
            ly = py;
            self.put_p(x - unit / 2.0, y - unit / 2.0, &p, unit);
            if thick > 1 {
                if steep {
                    self.put_p(x + unit / 2.0, y - unit / 2.0, &p, unit);
                } else {
                    self.put_p(x - unit / 2.0, y + unit / 2.0, &p, unit);
                }
            }
        }
    }

    pub fn disc(&mut self, cx: f64, cy: f64, r: f64, c: Rgb, a: f64, unit: f64) {
        let rr = r * r + r * 0.6 * unit;
        let n = (r / unit).ceil();
        if !n.is_finite() || n > 1000.0 {
            return;
        }
        let n = n as i64;
        let p = Paint::new(c, a);
        for j in -n..=n {
            for i in -n..=n {
                let x = i as f64 * unit;
                let y = j as f64 * unit;
                if x * x + y * y <= rr {
                    self.put_p(cx + x - unit / 2.0, cy + y - unit / 2.0, &p, unit);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sprites_parse() {
        let a = &*ART;
        assert_eq!((a.inv[0][0].w, a.inv[0][0].h), (11, 9));
        assert_eq!(a.eyes[0], vec![(8, 3), (8, 5)]);
        assert_eq!((a.ufo.w, a.ufo.h), (15, 10));
        assert_eq!((a.ship.w, a.ship.h), (43, 15));
        assert_eq!((a.down[1][0].f.w, a.down[1][0].f.h), (9, 11));
        assert_eq!(a.turned.len(), TURNS);
        assert_eq!((a.turned[0].w, a.turned[0].h), (32, 33));
        // facing up (-π/2) is PERSON itself: the head in the middle column above the shoulders
        let t = a.person_turned(-PI / 2.0);
        assert_eq!(t.at(16, 16), CELL_HEAD);
    }

    #[test]
    fn clamped_bytes() {
        assert_eq!(u8c(127.5), 128);
        assert_eq!(u8c(76.5), 76);
        assert_eq!(u8c(76.4), 76);
        assert_eq!(u8c(-3.0), 0);
        assert_eq!(u8c(300.0), 255);
        assert_eq!(u8c(f64::NAN), 0);
    }

    #[test]
    fn neon_colors() {
        let c = neon(0.0);
        assert!(c.iter().all(|v| (0.0..=1.0).contains(v)));
    }
}
