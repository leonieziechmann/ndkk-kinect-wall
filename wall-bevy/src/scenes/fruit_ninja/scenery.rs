//! The scenery (scenery.js): a Japanese moon night, painted as pixel art in layers like a woodblock
//! print. Back to front: the sky with the Milky Way, the full moon, a far mountain range with snowy
//! peaks, Mount Fuji, a band of mist, hills with a pine line, a castle, a torii and a path of
//! lanterns, the pagoda in front of the moon, a second mist band, a lake with the moon's reflection,
//! a red arched bridge, a village with lit paper windows and lanterns, and in front a bamboo grove,
//! cherry trees in bloom and the temple roof the ninjas stand on. Every layer has its own range of
//! values (far = light and blue, near = dark) and a rim of moonlight on the side facing the moon
//! (top left).
//!
//! The still picture is painted once in blocks of 2 x 2 LEDs (paint(), in a worker thread: the
//! renderer keeps it as a texture). What moves is drawn every frame into the pixel layer, each thing
//! only where its layer shows: twinkling stars, clouds, the shimmering reflection, fireflies, birds
//! crossing the moon, cherry petals, a shooting star, flickering lanterns (with lights). Dark on
//! purpose: the fruit stays the brightest thing on the wall, and the light of the game (juice,
//! blades) falls on the scenery. The same seeded random numbers as the browser: the same picture.

use std::f64::consts::{PI, SQRT_2};

use crate::scenes::common::rand::Rng;

use super::fruits::hash;
use super::pix::{Pix, Rgb, TURN, js_round, pack, rgb};
use super::{Layout, P};

const fn hexes<const N: usize>(h: [u32; N]) -> [Rgb; N] {
    let mut out = [[0.0; 3]; N];
    let mut i = 0;
    while i < N {
        out[i] = rgb(h[i]);
        i += 1;
    }
    out
}

mod c {
    use super::super::pix::{Rgb, rgb};
    use super::hexes;
    pub const SKY: [Rgb; 9] = hexes([0x03030a, 0x05050f, 0x070715, 0x0a081b, 0x0e0a22, 0x130d2a, 0x191033, 0x20143c, 0x281846]);
    pub const DUST: [Rgb; 2] = hexes([0x0e0b24, 0x130f2c]);
    pub const STAR_DIM: [Rgb; 3] = hexes([0x3c3a62, 0x4a4672, 0x5a4f74]);
    pub const STAR: [Rgb; 3] = hexes([0xffffff, 0xd4e2ff, 0xffd8ee]);
    pub const HALO: [Rgb; 4] = hexes([0x2b2154, 0x231b4a, 0x1c1540, 0x161036]);
    pub const MOON: [Rgb; 4] = hexes([0x9c9380, 0xb8ae96, 0xd3c9b0, 0xe8e0ca]);
    pub const MOON_SEA: [Rgb; 2] = hexes([0xa59c86, 0xb4aa92]);
    pub const FAR: [Rgb; 3] = hexes([0x1a163a, 0x211c48, 0x2c2660]);
    pub const FAR_SNOW: [Rgb; 2] = hexes([0x5c6198, 0x8389bf]);
    pub const FUJI_ROCK: [Rgb; 3] = hexes([0x17153a, 0x201d48, 0x2a2858]);
    pub const FUJI_SNOW: [Rgb; 4] = hexes([0x4a5286, 0x6169a0, 0x8890c6, 0xa7aedc]);
    pub const MIST: [Rgb; 3] = hexes([0x241c48, 0x2d2456, 0x3c3270]);
    pub const HILL: [Rgb; 3] = hexes([0x0d0b22, 0x120f2c, 0x1c1842]);
    pub const PINE: [Rgb; 2] = hexes([0x0c0a20, 0x1a163c]);
    pub const WALL: [Rgb; 3] = hexes([0x30345a, 0x41466f, 0x555b88]);
    pub const ROOF: [Rgb; 3] = hexes([0x0f0f26, 0x16162f, 0x2e2f5c]);
    pub const STONE: [Rgb; 3] = hexes([0x1c1a38, 0x252347, 0x2f2d55]);
    pub const WINDOW: [Rgb; 3] = hexes([0xd08040, 0xffb25a, 0xffd690]);
    pub const GOLD: [Rgb; 3] = hexes([0xc08a2c, 0xe0b040, 0xffe08a]);
    pub const PAGODA: [Rgb; 3] = hexes([0x0b0a1e, 0x121130, 0x2c2b5e]);
    pub const TORII: [Rgb; 3] = hexes([0x6a1a34, 0xa82a44, 0xd64458]);
    pub const MIST2: [Rgb; 3] = hexes([0x161130, 0x1d1640, 0x2a2154]);
    pub const WATER: [Rgb; 4] = hexes([0x06061a, 0x0a0a22, 0x12123a, 0x1a1a46]);
    pub const REFLECT: [Rgb; 3] = hexes([0x4a4672, 0x7a7494, 0xb0a892]);
    pub const REED: [Rgb; 2] = hexes([0x08071a, 0x141232]);
    pub const BRIDGE: [Rgb; 3] = hexes([0x6e1a34, 0xa42a44, 0xd84a5c]);
    pub const BRIDGE_REFL: [Rgb; 2] = hexes([0x3a1028, 0x521a34]);
    pub const HOUSE: [Rgb; 3] = hexes([0x0b0a1e, 0x13122c, 0x22214a]);
    pub const SHOJI: [Rgb; 3] = hexes([0xb86a34, 0xffbe6c, 0xffdca0]);
    pub const CHOCHIN: [Rgb; 3] = hexes([0x8a1a24, 0xff4a34, 0xffb04a]);
    pub const CAP: Rgb = rgb(0x140c1c);
    pub const BAMBOO: [Rgb; 4] = hexes([0x0a2023, 0x0e2c2f, 0x15403f, 0x22605a]);
    pub const BAMBOO_BACK: [Rgb; 2] = hexes([0x081619, 0x0c2124]);
    pub const LEAF: [Rgb; 3] = hexes([0x0b2a2a, 0x123c3a, 0x1d5550]);
    pub const BARK: [Rgb; 3] = hexes([0x0c0716, 0x160e24, 0x2a1c3e]);
    pub const BLOSSOM: [Rgb; 6] = hexes([0x5a1446, 0x8c2a64, 0xc04c8a, 0xe57fb2, 0xffc0dc, 0xffe8f3]);
    pub const TILE: [Rgb; 4] = hexes([0x05060f, 0x0a0c1c, 0x111430, 0x1c2044]);
    pub const TILE_END: [Rgb; 3] = hexes([0x0e1028, 0x181b3c, 0x262a56]);
    pub const RIDGE: [Rgb; 3] = hexes([0x141634, 0x1d2046, 0x303468]);
    pub const CLOUD: [Rgb; 4] = hexes([0x0f0b24, 0x161030, 0x2a2258, 0x5e529c]);
    pub const PETAL: [Rgb; 3] = hexes([0xff8cc0, 0xffb8da, 0xf070aa]);
    pub const FIREFLY: Rgb = rgb(0xe4ff9a);
    pub const BIRD: Rgb = rgb(0x08060f);
}

/// a palette entry by an index computed from a value (out of range: the last / first)
fn at<const N: usize>(pal: &[Rgb; N], i: f64) -> Rgb {
    pal[if i >= 0.0 { (i as usize).min(N - 1) } else { 0 }]
}

/// a small deterministic random generator (mulberry32, as the browser: the same scenery every time)
struct Mulberry(u32);

impl Mulberry {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let s = self.0;
        let mut t = (s ^ (s >> 15)).wrapping_mul(1 | s);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

fn smooth(t: f64) -> f64 {
    t * t * (3.0 - 2.0 * t)
}

fn noise1(x: f64) -> f64 {
    let i = x.floor();
    let f = x - i;
    hash(i, 0.5) + (hash(i + 1.0, 0.5) - hash(i, 0.5)) * smooth(f)
}

fn noise2(x: f64, y: f64) -> f64 {
    let i = x.floor();
    let j = y.floor();
    let fx = smooth(x - i);
    let fy = smooth(y - j);
    let a = hash(i, j) + (hash(i + 1.0, j) - hash(i, j)) * fx;
    let b = hash(i, j + 1.0) + (hash(i + 1.0, j + 1.0) - hash(i, j + 1.0)) * fx;
    a + (b - a) * fy
}

fn fbm1(x: f64) -> f64 {
    let mut v = 0.0;
    let mut a = 0.5;
    let mut f = 1.0;
    for k in 0..4 {
        v += a * noise1(x * f + f64::from(k) * 13.7);
        a *= 0.5;
        f *= 2.03;
    }
    v
}

/// A function of a column, cached for the whole columns (the shapes ask for the same column many
/// times); other x are computed.
struct Cols {
    v: Vec<f64>,
}

impl Cols {
    const PAD: f64 = 4.0;

    fn new(bw: f64, f: &impl Fn(f64) -> f64) -> Self {
        let n = (bw + 2.0 * Self::PAD + 1.0).max(0.0) as usize;
        Self { v: (0..n).map(|i| f(i as f64 - Self::PAD)).collect() }
    }

    fn get(&self, x: f64, f: &impl Fn(f64) -> f64) -> f64 {
        let i = x + Self::PAD;
        if i >= 0.0 && i.fract() == 0.0
            && let Some(v) = self.v.get(i as usize)
        {
            return *v;
        }
        f(x)
    }
}

// what each block shows, so the moving things stay in their layer
const SKY: u8 = 1;
const MOON: u8 = 2;
const FAR: u8 = 3;
const MIST: u8 = 4;
const HILL: u8 = 5;
const WATER: u8 = 6;
const NEAR: u8 = 7;
const FRONT: u8 = 8;

/// the canvas: a color per block and the layer it belongs to; y down, in blocks
struct Cv {
    w: i64,
    h: i64,
    col: Vec<Rgb>,
    layer: Vec<u8>,
}

impl Cv {
    fn new(w: i64, h: i64) -> Self {
        let n = (w.max(0) * h.max(0)) as usize;
        Self { w, h, col: vec![c::SKY[0]; n], layer: vec![0; n] }
    }

    fn index(&self, x: f64, y: f64) -> Option<usize> {
        let (x, y) = (js_round(x), js_round(y));
        if !(x >= 0.0 && y >= 0.0 && x < self.w as f64 && y < self.h as f64) {
            return None;
        }
        Some(y as usize * self.w as usize + x as usize)
    }

    fn set(&mut self, x: f64, y: f64, c: Rgb, layer: u8) {
        if let Some(i) = self.index(x, y)
            && let (Some(cc), Some(l)) = (self.col.get_mut(i), self.layer.get_mut(i))
        {
            *cc = c;
            *l = layer;
        }
    }

    fn layer_at(&self, x: f64, y: f64) -> u8 {
        self.index(x, y).and_then(|i| self.layer.get(i).copied()).unwrap_or(0)
    }

    /// fills a shape given as a mask, coloring it with f(x, y, litEdge, shadeEdge)
    #[allow(clippy::too_many_arguments)]
    fn shape(&mut self, x0: f64, y0: f64, x1: f64, y1: f64, inside: impl Fn(f64, f64) -> bool, mut f: impl FnMut(f64, f64, bool, bool) -> Rgb, layer: u8) {
        if x0.is_nan() || y0.is_nan() || x1.is_nan() || y1.is_nan() {
            return;
        }
        let (ya, yb) = (y0.floor().max(0.0), y1.ceil().min(self.h as f64 - 1.0));
        let (xa, xb) = (x0.floor().max(0.0), x1.ceil().min(self.w as f64 - 1.0));
        if !(ya <= yb && xa <= xb) {
            return;
        }
        for y in ya as i64..=yb as i64 {
            let y = y as f64;
            for x in xa as i64..=xb as i64 {
                let x = x as f64;
                if !inside(x, y) {
                    continue;
                }
                let lit = !inside(x - 1.0, y) || !inside(x, y - 1.0);
                let shade = !inside(x + 1.0, y) || !inside(x, y + 1.0);
                let c = f(x, y, lit, shade);
                self.set(x, y, c, layer);
            }
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Moon {
    x: f64,
    y: f64,
    r: f64,
}

#[derive(Clone, Copy)]
struct Water {
    top: f64,
    bottom: f64,
}

struct Lantern {
    x: f64,
    y: f64,
    i: f64,
    r: f64,
    small: bool,
}

struct Star {
    x: f64,
    y: f64,
    ph: f64,
    f: f64,
    big: bool,
    col: Rgb,
}

struct Cloud {
    x: f64,
    y: f64,
    /// dx, dy, tone
    blocks: Vec<(f64, f64, u8)>,
    v: f64,
}

struct Fly {
    x: f64,
    y: f64,
    ph: f64,
    sp: f64,
}

struct Petal {
    x: f64,
    y: f64,
    vx: f64,
    vy: f64,
    ph: f64,
    col: Rgb,
}

struct Birds {
    x: f64,
    y: f64,
    v: f64,
    n: u32,
}

struct Shoot {
    x: f64,
    y: f64,
    vx: f64,
    vy: f64,
    t0: f64,
    life: f64,
}

/// What paint() makes of a layout: the still picture and what moves in it.
pub struct Still {
    /// the picture at LED resolution (RGBA8 per LED)
    pub buf: Vec<u32>,
    layer: Vec<u8>,
    bw: i64,
    bh: i64,
    /// LEDs per block, blocks per m
    n: f64,
    kb: f64,
    moon: Moon,
    water: Option<Water>,
    lanterns: Vec<Lantern>,
    /// where petals come from: the blossom clumps of the trees (x, y, r in blocks)
    crowns: Vec<[f64; 3]>,
    stars: Vec<Star>,
    clouds: Vec<Cloud>,
    flies: Vec<Fly>,
}

/// what the still picture depends on: LEDs across, down, LEDs per art pixel, the wall's width and bottom
pub type Key = (usize, usize, i64, u64, u64);

pub fn key_of(l: &Layout) -> Key {
    (l.w, l.h, l.s as i64, l.wall_w.to_bits(), l.bottom.to_bits())
}

impl Still {
    fn layer_at(&self, x: f64, y: f64) -> u8 {
        let (x, y) = (js_round(x), js_round(y));
        if !(x >= 0.0 && y >= 0.0 && x < self.bw as f64 && y < self.bh as f64) {
            return 0;
        }
        self.layer.get(y as usize * self.bw as usize + x as usize).copied().unwrap_or(0)
    }
}

/// The painter of the still picture (scenery.js build() and its paint* methods).
struct Painter {
    cv: Cv,
    bw: f64,
    bh: f64,
    kb: f64,
    r: Mulberry,
    moon: Moon,
    water: Water,
    lanterns: Vec<Lantern>,
    crowns: Vec<[f64; 3]>,
    fallen: Vec<(f64, f64, Rgb)>,
    castle: f64,
    torii: f64,
    hill: Cols,
}

impl Painter {
    /// height above the floor (m) -> row
    fn y(&self, m: f64) -> f64 {
        self.bh - m * self.kb
    }

    fn x(&self, f: f64) -> f64 {
        f * self.bw
    }

    fn r(&mut self) -> f64 {
        self.r.next()
    }

    fn hill_fn(&self) -> impl Fn(f64) -> f64 + use<> {
        let (bh, kb, castle, torii) = (self.bh, self.kb, self.castle, self.torii);
        move |x: f64| bh - (0.5 + 0.1 * fbm1(x * 0.009 + 21.0) + 0.13 * (-((x - castle) / 34.0).powi(2)).exp() + 0.05 * (-((x - torii) / 20.0).powi(2)).exp()) * kb
    }

    fn hill_top(&self, x: f64) -> f64 {
        self.hill.get(x, &self.hill_fn())
    }

    // ---- the still layers, back to front

    fn sky(&mut self) {
        let bw = self.bw;
        let horizon = self.y(0.62);
        for y in 0..self.cv.h {
            let y = y as f64;
            for x in 0..bw as i64 {
                let x = x as f64;
                // stepped bands with wavy borders (no dither)
                let t = ((y + 2.2 * (x * 0.045 + y * 0.02).sin() + 1.4 * (x * 0.11 + 1.0).sin()) / horizon).max(0.0);
                let n = c::SKY.len() as f64;
                let i = (t.powf(1.35) * (n - 0.6)).floor().min(n - 1.0).max(0.0);
                self.cv.set(x, y, at(&c::SKY, i), SKY);
            }
        }
        // the Milky Way: a diagonal band of dust and many faint stars
        let ax = self.x(0.36);
        let bx = self.x(0.9);
        let len = (bx - ax).hypot(horizon);
        let mut y = 0.0;
        while y < horizon {
            let mut x = (ax - 40.0).floor();
            while x < bx + 40.0 {
                let d = ((x - ax) * horizon - y * (bx - ax)).abs() / len;
                let w = 16.0 + 8.0 * noise1(x * 0.05);
                if d <= w {
                    let nz = noise2(x * 0.09, y * 0.12) * 0.7 + noise2(x * 0.3, y * 0.3) * 0.3;
                    let core = 1.0 - d / w;
                    if nz * core > 0.32 {
                        self.cv.set(x, y, c::DUST[usize::from(nz * core > 0.45)], SKY);
                    }
                    if hash(x, y) > 0.985 - core * 0.04 {
                        self.cv.set(x, y, at(&c::STAR_DIM, (hash(y, x) * 3.0).floor()), SKY);
                    }
                }
                x += 1.0;
            }
            y += 1.0;
        }
        // faint stars everywhere in the sky
        for _ in 0..260 {
            let x = self.r() * bw;
            let y = self.r() * horizon * 0.95;
            let i = (self.r() * 3.0).floor();
            self.cv.set(x, y, at(&c::STAR_DIM, i), SKY);
        }
    }

    fn paint_moon(&mut self) {
        let kb = self.kb;
        let m = Moon { x: js_round(self.x(0.2).min(1.25 * kb)), y: js_round(self.y(1.42)), r: js_round(0.26 * kb) };
        self.moon = m;
        // a stepped halo
        let mut y = m.y - m.r * 2.0;
        while y <= m.y + m.r * 2.0 {
            let mut x = m.x - m.r * 2.0;
            while x <= m.x + m.r * 2.0 {
                let d = (x - m.x).hypot(y - m.y) / m.r;
                if !(d < 1.0 || d > 1.85) {
                    let i = if d < 1.12 {
                        0
                    } else if d < 1.3 {
                        1
                    } else if d < 1.55 {
                        2
                    } else {
                        3
                    };
                    self.cv.set(x, y, c::HALO[i], SKY);
                }
                x += 1.0;
            }
            y += 1.0;
        }
        // the disc: lit at the top left, a crescent of shade at the bottom right, seas and craters
        const CRATERS: [[f64; 3]; 5] = [[-0.45, -0.2, 0.12], [0.3, 0.45, 0.09], [0.5, -0.35, 0.07], [-0.15, 0.55, 0.1], [0.05, -0.62, 0.06]];
        let mut y = m.y - m.r;
        while y <= m.y + m.r {
            let mut x = m.x - m.r;
            while x <= m.x + m.r {
                let dx = (x - m.x) / m.r;
                let dy = (y - m.y) / m.r;
                let d = dx.hypot(dy);
                if d <= 1.0 {
                    let toward = (-dx - dy) / SQRT_2; // towards the top left
                    let mut col = if d > 0.93 && toward < -0.2 {
                        c::MOON[0]
                    } else if toward < -0.55 + 0.3 * (1.0 - d) {
                        c::MOON[1]
                    } else if toward > 0.45 && d > 0.55 {
                        c::MOON[3]
                    } else {
                        c::MOON[2]
                    };
                    let sea = noise2(dx * 2.6 + 4.0, dy * 2.6 + 1.0) * 0.65 + noise2(dx * 6.0 + 9.0, dy * 6.0) * 0.35;
                    if sea > 0.58 && d < 0.9 {
                        col = if sea > 0.68 { c::MOON_SEA[0] } else { c::MOON_SEA[1] };
                    }
                    for [cx, cy, cr] in CRATERS {
                        let e = (dx - cx).hypot(dy - cy) / cr;
                        if e < 1.0 {
                            col = if e > 0.7 {
                                if dx - cx + dy - cy < 0.0 { c::MOON_SEA[0] } else { c::MOON[3] }
                            } else {
                                c::MOON_SEA[1]
                            };
                        }
                    }
                    self.cv.set(x, y, col, MOON);
                }
                x += 1.0;
            }
            y += 1.0;
        }
    }

    fn far(&mut self) {
        let (bw, bh, kb) = (self.bw, self.bh, self.kb);
        let base = self.y(0.6);
        let ridge_f = move |x: f64| bh - (0.78 + 0.28 * fbm1(x * 0.011 + 3.0) + 0.12 * (fbm1(x * 0.03 + 9.0) - 0.45).max(0.0)) * kb;
        let cols = Cols::new(bw, &ridge_f);
        let ridge = |x: f64| cols.get(x, &ridge_f);
        let snow_top = self.y(0.98);
        let inside = |x: f64, y: f64| y >= ridge(x) && y <= base + 30.0;
        self.cv.shape(
            0.0,
            self.y(1.25),
            bw - 1.0,
            base + 30.0,
            inside,
            |x, y, lit, _| {
                let top = ridge(x);
                let slope = ridge(x + 2.0) - ridge(x - 2.0); // > 0: falling to the right, facing the moon
                if top < snow_top && y < top + 3.0 + 4.0 * noise1(x * 0.4) {
                    return if slope > 0.0 { c::FAR_SNOW[1] } else { c::FAR_SNOW[0] };
                }
                if lit {
                    return c::FAR[2];
                }
                if slope > 0.3 { c::FAR[1] } else { c::FAR[0] }
            },
            FAR,
        );
    }

    fn fuji(&mut self) {
        let kb = self.kb;
        let fx = self.x(0.6);
        let peak = self.y(1.24);
        let base = self.y(0.6);
        let hw = 2.3 * kb;
        let top = move |x: f64| {
            let u = ((x - fx).abs() / hw).min(1.0);
            let crater = if (x - fx).abs() < 0.09 * kb { 1.5 + (x * 1.3).sin() } else { 0.0 };
            base - (base - peak) * (1.0 - u).powf(1.75) + crater
        };
        let inside = move |x: f64, y: f64| y >= top(x) && y <= base + 30.0;
        self.cv.shape(
            fx - hw,
            peak - 2.0,
            fx + hw,
            base + 30.0,
            inside,
            |x, y, lit, _| {
                let dx = (x - fx) / kb; // m
                let h = (base - y) / (base - peak); // 0 at the base, 1 at the top
                // the snow line runs down in tongues along the gullies
                let a = dx.atan2((y - peak) / kb + 0.05);
                let gully = (a * 38.0 + 2.0 * (a * 7.0).sin()).sin();
                let line = 0.6 - 0.12 * gully - 0.05 * noise1(x * 0.5);
                let right = dx > 0.02 * (y * 0.7).sin();
                if h > line {
                    if gully > 0.55 && h < 0.92 {
                        return if right { c::FUJI_SNOW[0] } else { c::FUJI_SNOW[1] };
                    }
                    if lit && !right {
                        return c::FUJI_SNOW[3];
                    }
                    return if right { c::FUJI_SNOW[1] } else { c::FUJI_SNOW[2] };
                }
                if lit && !right {
                    return c::FUJI_ROCK[2];
                }
                if gully > 0.7 && h > line - 0.12 {
                    return if right { c::FUJI_SNOW[0] } else { c::FUJI_SNOW[1] };
                }
                if right { c::FUJI_ROCK[0] } else { c::FUJI_ROCK[1] }
            },
            FAR,
        );
    }

    /// a band of mist as in woodblock prints: a scalloped top edge, a line inside
    fn mist(&mut self, row: f64, height: f64, pal: [Rgb; 3], scallop: f64) {
        let (bw, kb) = (self.bw, self.kb);
        let h = height * 0.1 * kb;
        let top_f = move |x: f64| row - ((x / scallop) * PI * 0.5 + noise1(x * 0.02) * 3.0).sin().abs() * 3.0 - noise1(x * 0.013) * 4.0;
        let cols = Cols::new(bw, &top_f);
        let top = |x: f64| cols.get(x, &top_f);
        let inside = |x: f64, y: f64| y >= top(x) && y <= row + h;
        self.cv.shape(
            0.0,
            row - 8.0,
            bw - 1.0,
            row + h,
            inside,
            |x, y, lit, _| {
                if lit || y - top(x) < 1.0 {
                    return pal[2];
                }
                if (y - top(x) - 3.2).abs() < 0.6 {
                    return pal[1];
                }
                pal[0]
            },
            MIST,
        );
    }

    /// a pine of three tiers, lit on the left
    fn pine(&mut self, x: f64, base: f64, h: f64, front: bool) {
        let tiers = 3.0;
        for t in 0..3 {
            let tf = f64::from(t);
            let ty = base - h + tf * h / tiers;
            let th = h / tiers + 2.0;
            let mut k = 0.0;
            while k < th {
                let w = js_round((k + 1.0) / th * (1.6 + tf * 1.1));
                let mut i = -w;
                while i <= w {
                    let col = if i == -w || k == 0.0 {
                        c::PINE[1]
                    } else if front {
                        c::PINE[0]
                    } else {
                        c::HILL[1]
                    };
                    self.cv.set(x + i, ty + k, col, HILL);
                    i += 1.0;
                }
                k += 1.0;
            }
        }
        self.cv.set(x, base, c::PINE[0], HILL);
    }

    fn hills(&mut self) {
        let bw = self.bw;
        self.castle = self.x(0.79);
        self.torii = self.x(0.45);
        let (castle, torii) = (self.castle, self.torii);
        let hill_f = self.hill_fn();
        self.hill = Cols::new(bw, &hill_f);
        let hill = std::mem::replace(&mut self.hill, Cols { v: Vec::new() });
        {
            let inside = |x: f64, y: f64| y >= hill.get(x, &hill_f);
            let y0 = self.y(0.8);
            let h = self.cv.h as f64;
            self.cv.shape(
                0.0,
                y0,
                bw - 1.0,
                h - 1.0,
                inside,
                |x, y, lit, _| {
                    if lit {
                        c::HILL[2]
                    } else if noise2(x * 0.15, y * 0.2) > 0.72 {
                        c::HILL[1]
                    } else {
                        c::HILL[0]
                    }
                },
                HILL,
            );
        }
        self.hill = hill;
        // pines along the top in two rows: small ones behind, bigger ones in front; tiers lit on the left
        for front in [false, true] {
            let mut x = if front { 2.0 } else { 0.0 };
            while x < bw {
                if !((x - castle).abs() < 24.0 || (x - torii).abs() < 11.0) {
                    let base = self.hill_top(x) + if front { 3.0 } else { 1.0 };
                    let h = if front { 9.0 + (self.r() * 7.0).floor() } else { 6.0 + (self.r() * 4.0).floor() };
                    self.pine(x, base, h, front);
                }
                x += if front { 6.0 } else { 4.0 } + (self.r() * 5.0).floor();
            }
        }
        // a path of lanterns zigzagging up to the castle
        for k in 0..7 {
            let kf = f64::from(k);
            let x = castle - 26.0 + if k % 2 == 1 { 10.0 } else { 0.0 } + kf * 3.0;
            let y = self.y(0.3) - kf * ((self.y(0.3) - self.hill_top(castle) - 6.0) / 7.0);
            self.cv.set(x, y, c::WINDOW[1], HILL);
            self.lanterns.push(Lantern { x: js_round(x), y: js_round(y), i: 0.12, r: 0.12, small: true });
        }
    }

    fn paint_castle(&mut self) {
        let kb = self.kb;
        let cx = js_round(self.x(0.79));
        let ground = js_round(self.hill_top(cx));
        // the stone base: sloped walls with a pattern of blocks
        let bh = js_round(0.1 * kb);
        let base_top = ground - bh;
        self.cv.shape(
            cx - 22.0,
            base_top,
            cx + 22.0,
            ground + 2.0,
            |x, y| y >= base_top && (x - cx).abs() <= 15.0 + ((y - base_top) / bh) * 6.0,
            |x, y, lit, _| {
                if lit {
                    return c::STONE[2];
                }
                if (y + ((x + (y % 2.0) * 2.0) / 4.0).floor() % 2.0) % 3.0 == 0.0 { c::STONE[0] } else { c::STONE[1] }
            },
            HILL,
        );
        // three tiers: white walls with lit windows, dark roofs with turned-up eaves, gables
        let mut y = base_top;
        for (i, (hw, h)) in [(14.0, 9.0), (11.0, 8.0), (8.0, 7.0)].into_iter().enumerate() {
            let wall_top = y - h;
            let yb = y;
            self.cv.shape(
                cx - hw,
                wall_top,
                cx + hw,
                y,
                |x, yy| (x - cx).abs() <= hw && yy >= wall_top && yy < yb,
                |x, yy, lit, shade| {
                    if (yy - wall_top) % 4.0 == 2.0 && (x - cx).abs() % 4.0 == 1.0 && (x - cx).abs() < hw - 1.0 {
                        return if hash(x, yy) > 0.35 { c::WINDOW[1] } else { c::WINDOW[0] };
                    }
                    if lit {
                        c::WALL[2]
                    } else if shade || x > cx + hw * 0.3 {
                        c::WALL[0]
                    } else {
                        c::WALL[1]
                    }
                },
                HILL,
            );
            let rw = hw + 4.0;
            let mut k = -rw;
            while k <= rw {
                let lift = js_round((k.abs() / rw).powi(3) * 2.5);
                for t in 0..3 {
                    let col = if t == 2 { c::ROOF[2] } else { c::ROOF[if t == 1 { 1 } else { 0 }] };
                    self.cv.set(cx + k, wall_top - f64::from(t) - lift + 1.0, col, HILL);
                }
                k += 1.0;
            }
            if i < 2 {
                for t in 0..5 {
                    let tf = f64::from(t);
                    let mut k = -tf;
                    while k <= tf {
                        self.cv.set(cx + k, wall_top - 6.0 + tf, if k.abs() == tf { c::ROOF[2] } else { c::ROOF[0] }, HILL);
                        k += 1.0;
                    }
                }
            }
            y = wall_top - 3.0;
        }
        // the top roof with golden fish (shachihoko) at both ends
        for k in -9..=9_i32 {
            let kf = f64::from(k);
            for t in 0..3 {
                let col = if t == 2 { c::ROOF[2] } else { c::ROOF[0] };
                self.cv.set(cx + kf, y - f64::from(t) + if k.abs() > 6 { 1.0 } else { 0.0 }, col, HILL);
            }
        }
        for s in [-1.0, 1.0] {
            self.cv.set(cx + s * 8.0, y - 3.0, c::GOLD[1], HILL);
            self.cv.set(cx + s * 8.0, y - 4.0, c::GOLD[2], HILL);
            self.cv.set(cx + s * 9.0, y - 4.0, c::GOLD[0], HILL);
        }
    }

    fn paint_torii(&mut self) {
        let cx = js_round(self.x(0.45));
        let g = js_round(self.hill_top(cx));
        let mut set = |x: f64, y: f64, c: Rgb| self.cv.set(x, y, c, HILL);
        for s in [-1.0, 1.0] {
            let mut y = g - 13.0;
            while y <= g {
                set(cx + s * 5.0, y, if s < 0.0 { c::TORII[2] } else { c::TORII[1] });
                y += 1.0;
            }
        }
        for k in -8..=8_i32 {
            let lift = if k.abs() > 6 { 1.0 } else { 0.0 };
            let k = f64::from(k);
            set(cx + k, g - 15.0 - lift, c::TORII[2]);
            set(cx + k, g - 14.0 - lift, c::TORII[1]);
        }
        for k in -6..=6 {
            set(cx + f64::from(k), g - 10.0, c::TORII[1]);
        }
        set(cx, g - 12.0, c::TORII[0]);
        set(cx, g - 11.0, c::TORII[0]);
        // two stone lanterns
        for s in [-1.0, 1.0] {
            set(cx + s * 9.0, g - 1.0, c::STONE[1]);
            set(cx + s * 9.0, g - 2.0, c::WINDOW[1]);
            set(cx + s * 9.0, g - 3.0, c::STONE[2]);
        }
        for s in [-1.0, 1.0] {
            self.lanterns.push(Lantern { x: cx + s * 9.0, y: g - 2.0, i: 0.15, r: 0.15, small: true });
        }
    }

    fn pagoda(&mut self) {
        let m = self.moon;
        let cx = js_round(m.x + 0.22 * self.kb);
        let mut y = js_round(self.hill_top(cx)) + 2.0;
        for i in 0..5 {
            let fi = f64::from(i);
            let hw = js_round(11.0 - fi * 1.5);
            let wall_top = y - (12.0 - fi);
            let mut yy = wall_top;
            while yy < y {
                let mut k = -hw;
                while k <= hw {
                    let edge = k.abs() == hw;
                    let mut col = if edge { c::PAGODA[1] } else { c::PAGODA[0] };
                    if k.abs() <= 1.0 && yy > wall_top + 3.0 && yy < y - 3.0 && i < 4 {
                        col = c::WINDOW[if (yy + fi) % 3.0 == 0.0 { 2 } else { 1 }];
                    }
                    if (yy == y - 2.0 || yy == y - 3.0) && k.abs() % 2.0 == 0.0 && !edge {
                        col = c::PAGODA[1]; // the railing
                    }
                    self.cv.set(cx + k, yy, col, HILL);
                    k += 1.0;
                }
                yy += 1.0;
            }
            // the roof: wide eaves, tips turned up, moonlight on the top edge
            let rw = js_round(hw + 7.0 - fi * 0.6);
            let mut k = -rw;
            while k <= rw {
                let u = k.abs() / rw;
                let lift = js_round(u.powf(3.2) * 4.0);
                let thick = 2 + i32::from(u < 0.6);
                for t in 0..thick {
                    let col = if t == thick - 1 {
                        if k < 0.0 { c::PAGODA[2] } else { c::PAGODA[1] }
                    } else {
                        c::PAGODA[0]
                    };
                    self.cv.set(cx + k, wall_top - f64::from(t) - lift, col, HILL);
                }
                k += 1.0;
            }
            // lanterns hanging at the roof tips of the lower tiers
            if i < 3 {
                for s in [-1.0, 1.0] {
                    let lx = cx + s * (rw - 1.0);
                    self.cv.set(lx, wall_top, c::CHOCHIN[1], HILL);
                    self.cv.set(lx, wall_top + 1.0, c::CHOCHIN[0], HILL);
                    self.lanterns.push(Lantern { x: lx, y: wall_top, i: 0.22, r: 0.2, small: false });
                }
            }
            y = wall_top - 3.0;
        }
        // the spire (sorin) with its rings
        for k in 0..22 {
            let kf = f64::from(k);
            self.cv.set(cx, y - kf, c::PAGODA[if k < 18 { 0 } else { 1 }], HILL);
            if k > 3 && k < 16 && k % 2 == 0 {
                self.cv.set(cx - 1.0, y - kf, c::PAGODA[0], HILL);
                self.cv.set(cx + 1.0, y - kf, c::PAGODA[0], HILL);
            }
        }
    }

    fn lake(&mut self) {
        let top = js_round(self.y(0.36));
        let bottom = js_round(self.y(0.12));
        let x1 = self.x(0.5);
        self.water = Water { top, bottom };
        let mut y = top;
        while y <= bottom {
            let mut x = 0.0;
            while x < x1 + (bottom - y) * 0.8 {
                let d = (y - top) / (bottom - top);
                let mut col = if d < 0.25 { c::WATER[1] } else { c::WATER[0] };
                // ripples: short light dashes, longer towards the front
                if noise2(x * (0.18 - d * 0.1), y * 1.7) > 0.74 {
                    col = c::WATER[2];
                }
                if y == top {
                    col = c::WATER[3];
                }
                self.cv.set(x, y, col, WATER);
                x += 1.0;
            }
            y += 1.0;
        }
        // the moon in the water: a column of broken streaks (it shimmers in draw())
        let m = self.moon;
        let mut y = top + 1.0;
        while y <= bottom {
            let w = 3.0 + (y - top) * 0.45;
            let mut x = js_round(m.x - w);
            while x <= m.x + w {
                let k = noise2(x * 0.35, y * 1.3);
                if k > 0.55 {
                    self.cv.set(x, y, c::REFLECT[usize::from(k > 0.72)], WATER);
                }
                x += 1.0;
            }
            y += 1.0;
        }
        // reeds along the left shore
        let mut x = 4.0;
        let end = self.x(0.12);
        while x < end {
            let h = 3.0 + (hash(x, 7.0) * 6.0).floor();
            let mut k = 0.0;
            while k < h {
                self.cv.set(x + if k > h - 2.0 { 1.0 } else { 0.0 }, bottom - k, c::REED[usize::from(k == h - 1.0)], NEAR);
                k += 1.0;
            }
            x += 2.0 + (hash(x, 3.0) * 3.0).floor();
        }
    }

    fn bridge(&mut self) {
        let cx = self.x(0.36);
        let hw = 0.3 * self.kb;
        let water = self.water.top + 4.0;
        let wb = self.water.bottom;
        let arch = move |x: f64| water - 11.0 * (1.0 - ((x - cx) / hw).powi(2)).max(0.0).sqrt();
        let mut x = (cx - hw).floor();
        while x <= cx + hw {
            let y = js_round(arch(x));
            // deck and railing
            self.cv.set(x, y, c::BRIDGE[2], NEAR);
            self.cv.set(x, y + 1.0, c::BRIDGE[1], NEAR);
            self.cv.set(x, y + 2.0, c::BRIDGE[0], NEAR);
            self.cv.set(x, y - 4.0, c::BRIDGE[2], NEAR);
            if js_round(x - cx) % 5.0 == 0.0 {
                for k in 1..4 {
                    self.cv.set(x, y - f64::from(k), c::BRIDGE[1], NEAR);
                }
            }
            // its reflection, broken by the ripples
            let ry = water + (water - y) + 2.0;
            if ry < wb && noise2(x * 0.4, ry) > 0.35 {
                self.cv.set(x, ry, c::BRIDGE_REFL[1], WATER);
            }
            if ry + 3.0 < wb && noise2(x * 0.4, ry + 3.0) > 0.5 {
                self.cv.set(x, ry + 3.0, c::BRIDGE_REFL[0], WATER);
            }
            x += 1.0;
        }
        for s in [-1.0, 1.0] {
            let x = js_round(cx + s * hw);
            let ly = js_round(arch(x)) - 6.0;
            let mut y = ly + 1.0;
            while y <= water + 1.0 {
                self.cv.set(x, y, c::BRIDGE[if s < 0.0 { 2 } else { 0 }], NEAR);
                y += 1.0;
            }
            self.cv.set(x, ly, c::CHOCHIN[2], NEAR);
            self.lanterns.push(Lantern { x, y: ly, i: 0.2, r: 0.18, small: false });
        }
    }

    fn village(&mut self) {
        let mut x = js_round(self.x(0.5));
        let end = self.x(0.86);
        let ground = js_round(self.y(0.12));
        while x < end {
            let w = 12.0 + (self.r() * 10.0).floor();
            let h = 9.0 + (self.r() * 6.0).floor();
            let wall_top = ground - h;
            let lit = self.r() < 0.8;
            // walls with paper windows (a lattice of 3 blocks)
            let mut y = wall_top;
            while y <= ground {
                let mut k = 0.0;
                while k < w {
                    let mut col = if k == 0.0 { c::HOUSE[1] } else { c::HOUSE[0] };
                    let wx = k - (w / 2.0).floor() + 3.0;
                    if lit && (0.0..6.0).contains(&wx) && y > wall_top + 2.0 && y < wall_top + 7.0 {
                        col = if wx % 3.0 == 2.0 || (y - wall_top) % 3.0 == 2.0 { c::SHOJI[0] } else { c::SHOJI[if y - wall_top < 4.0 { 2 } else { 1 }] };
                    }
                    self.cv.set(x + k, y, col, NEAR);
                    k += 1.0;
                }
                y += 1.0;
            }
            // the tiled roof: wider than the house, the ridge lit on top
            let rh = 5;
            for t in 0..rh {
                let tf = f64::from(t);
                let inset = js_round(tf * 1.2);
                let mut k = -2.0 + inset;
                while k < w + 2.0 - inset {
                    let col = if t == rh - 1 {
                        c::HOUSE[2]
                    } else if (k + tf) % 3.0 == 0.0 {
                        c::HOUSE[1]
                    } else {
                        c::HOUSE[0]
                    };
                    self.cv.set(x + k, wall_top - 1.0 - tf, col, NEAR);
                    k += 1.0;
                }
            }
            // a red lantern at the door
            if self.r() < 0.6 {
                let lx = x + w - 3.0;
                let ly = wall_top + 3.0;
                self.cv.set(lx, ly - 1.0, c::CAP, NEAR);
                self.cv.set(lx, ly, c::CHOCHIN[1], NEAR);
                self.cv.set(lx, ly + 1.0, c::CHOCHIN[1], NEAR);
                self.cv.set(lx, ly + 2.0, c::CAP, NEAR);
                self.lanterns.push(Lantern { x: lx, y: ly, i: 0.25, r: 0.2, small: false });
            }
            x += w + 2.0 + (self.r() * 4.0).floor();
        }
    }

    fn bamboo(&mut self) {
        let kb = self.kb;
        let h = self.cv.h as f64;
        // back stalks thin and dark; front stalks thick, lit, with nodes and leaves
        for (x0, w, back) in [(3.0, 2.0, true), (11.0, 2.0, true), (20.0, 2.0, true), (6.0, 4.0, false), (16.0, 4.0, false), (27.0, 3.0, false), (34.0, 2.0, true)] {
            let lean = (self.r() - 0.3) * 0.06;
            let node0 = (self.r() * 20.0).floor();
            let mut y = 0.0;
            while y < h {
                let x = js_round(x0 + lean * (h - y));
                let node = (y + node0) % 24.0 == 0.0;
                let mut k = 0.0;
                while k < w {
                    let col = if back {
                        c::BAMBOO_BACK[usize::from(k == 0.0)]
                    } else if node {
                        c::BAMBOO[3]
                    } else if k == 0.0 {
                        c::BAMBOO[2]
                    } else if k == w - 1.0 {
                        c::BAMBOO[0]
                    } else {
                        c::BAMBOO[1]
                    };
                    self.cv.set(x + k, y, col, FRONT);
                    k += 1.0;
                }
                if !back && node && y < h - 30.0 && self.r() < 0.8 {
                    // a twig with long leaves hanging down
                    let dir = if self.r() < 0.6 { 1.0 } else { -1.0 };
                    let nl = 2.0 + (self.r() * 3.0).floor();
                    let mut l = 0.0;
                    while l < nl {
                        let len = 0.09 * kb + self.r() * 0.06 * kb;
                        let ang = (0.35 + self.r() * 0.6) * dir;
                        let mut s = 0.0;
                        while s < len {
                            let lx = x + w / 2.0 + ang.sin() * s * 1.1;
                            let ly = y + 2.0 + l * 2.0 + ang.cos() * s * 0.55;
                            let col = if s < 2.0 {
                                c::LEAF[0]
                            } else if s > len - 3.0 {
                                c::LEAF[2]
                            } else {
                                c::LEAF[1]
                            };
                            self.cv.set(lx, ly, col, FRONT);
                            if s > 1.0 && s < len - 2.0 {
                                self.cv.set(lx, ly + 1.0, c::LEAF[0], FRONT);
                            }
                            s += 1.0;
                        }
                        l += 1.0;
                    }
                }
                y += 1.0;
            }
        }
    }

    /// One clump of blossoms: an organic round outline, a round light cap at the top left, a
    /// crescent of shade at the bottom right (outside a circle shifted to the top left), single
    /// flowers on the light side and a few petals sticking out of the rim. dark: a clump inside the
    /// crown, in shade.
    fn clump(&mut self, x0: f64, y0: f64, rr: f64, dark: bool) {
        let b = c::BLOSSOM; // dark .. light
        let ph0 = self.r() * TURN;
        let ph1 = self.r() * TURN;
        let mut y = (y0 - rr - 1.0).floor();
        while y <= y0 + rr + 1.0 {
            let mut x = (x0 - rr - 1.0).floor();
            while x <= x0 + rr + 1.0 {
                let dx = x - x0;
                let dy = y - y0;
                let a = dy.atan2(dx);
                let edge = rr * (0.9 + 0.07 * (a * 3.0 + ph0).sin() + 0.05 * (a * 7.0 + ph1).sin());
                if dx.hypot(dy * 1.08) <= edge {
                    let body = (dx + 0.2 * rr).hypot(dy + 0.22 * rr) / rr; // > ~0.8: the shaded crescent
                    let cap = (dx + 0.36 * rr).hypot(dy + 0.4 * rr) / rr; // < ~0.45: the light cap
                    let tone = if dark {
                        if body > 0.85 { 0 } else { 1 }
                    } else if body > 0.95 {
                        1
                    } else if body > 0.8 {
                        2
                    } else if cap < 0.45 {
                        4
                    } else {
                        3
                    };
                    self.cv.set(x, y, b[tone], FRONT);
                }
                x += 1.0;
            }
            y += 1.0;
        }
        if dark {
            return;
        }
        let mut k = 0.0;
        while k < js_round(rr * 0.8) {
            let a = PI * (0.9 + self.r() * 0.85);
            let d = rr * (0.3 + self.r() * 0.5);
            let fx = js_round(x0 + a.cos() * d);
            let fy = js_round(y0 + a.sin() * d);
            self.cv.set(fx, fy, b[5], FRONT);
            self.cv.set(fx - 1.0, fy, b[4], FRONT);
            self.cv.set(fx + 1.0, fy, b[4], FRONT);
            self.cv.set(fx, fy - 1.0, b[4], FRONT);
            k += 1.0;
        }
        let mut k = 0.0;
        while k < js_round(rr * 0.7) {
            let a = self.r() * PI * 2.0;
            let rim = rr * 1.02;
            self.cv.set(x0 + a.cos() * rim, y0 + a.sin() * rim, b[if a.sin() < 0.0 && a.cos() < 0.3 { 3 } else { 2 }], FRONT);
            k += 1.0;
        }
    }

    /// blossom clumps in the dome of the crown (scenery.js paintCherry clumps())
    #[allow(clippy::too_many_arguments)]
    fn clumps(&mut self, n: usize, rmin: f64, rmax: f64, lift: f64, s: f64, (cx, cy, rx, ry): (f64, f64, f64, f64)) -> Vec<[f64; 3]> {
        let in_dome = |x: f64, y: f64| ((x - cx) / rx).powi(2) + ((y - cy) / ry).powi(2) <= 1.0;
        let mut out: Vec<[f64; 3]> = Vec::with_capacity(n);
        let mut k = 0;
        while k < n * 6 && out.len() < n {
            k += 1;
            let x = cx + (self.r() * 2.0 - 1.0) * rx;
            let y = cy + (self.r() * 2.0 - 1.0) * ry - lift;
            if !in_dome(x, y + lift) {
                continue;
            }
            // keep the underside open in the middle, where the limbs come up
            if y > cy + ry * 0.35 && (x - cx).abs() < rx * 0.35 && self.r() < 0.8 {
                continue;
            }
            let r = (rmin + self.r() * (rmax - rmin)) * s;
            out.push([x, y, r]);
        }
        out.sort_by(|a, b| a[1].total_cmp(&b[1])); // the upper first: lower clumps overlap them
        out
    }

    /// The cherry tree at the right edge, the way pixel artists paint foliage: a gnarled trunk that
    /// forks into four limbs with twigs, and a dome of round blossom clumps. Clumps at the back are
    /// dark (the shade inside the crown), then the bark, then the clumps in front, each with a light
    /// cap at the top left, a crescent of shade at the bottom right and a few single flowers on the
    /// light side; lower clumps overlap upper ones. Gaps under the crown show the limbs, strands of
    /// blossoms hang down, and fallen petals lie on the roof below.
    fn cherry(&mut self, base_x: f64, base_y: f64) {
        let s = self.kb / 84.0; // the tree was drawn for 84 blocks per meter
        let p = |x: f64, y: f64| [base_x + x * s, base_y + y * s];
        // the branches as capsules [x0, y0, x1, y1, r0, r1] (blocks), from the trunk out
        let limb = |a: [f64; 2], b: [f64; 2], r0: f64, r1: f64| {
            let (pa, pb) = (p(a[0], a[1]), p(b[0], b[1]));
            [pa[0], pa[1], pb[0], pb[1], r0 * s, r1 * s]
        };
        let caps = [
            limb([0.0, 0.0], [-7.0, -38.0], 6.5, 5.0),
            limb([-7.0, -38.0], [-3.0, -66.0], 5.0, 4.2),
            limb([-3.0, -66.0], [-34.0, -95.0], 3.6, 2.2), // to the left
            limb([-34.0, -95.0], [-70.0, -112.0], 2.2, 1.1),
            limb([-3.0, -66.0], [-18.0, -110.0], 3.2, 2.0),
            limb([-18.0, -110.0], [-26.0, -136.0], 2.0, 0.9),
            limb([-3.0, -66.0], [16.0, -108.0], 3.0, 1.9), // up to the right
            limb([16.0, -108.0], [24.0, -134.0], 1.9, 0.9),
            limb([-3.0, -66.0], [32.0, -92.0], 2.6, 1.5), // out to the right edge
            limb([32.0, -92.0], [52.0, -104.0], 1.5, 0.8),
            limb([-52.0, -104.0], [-62.0, -126.0], 1.2, 0.6), // twigs
            limb([-18.0, -110.0], [-36.0, -130.0], 1.2, 0.6),
            limb([16.0, -108.0], [4.0, -126.0], 1.1, 0.6),
            limb([-34.0, -95.0], [-44.0, -84.0], 1.1, 0.6),
        ];
        let dist = |x: f64, y: f64, c: &[f64; 6]| {
            let dx = c[2] - c[0];
            let dy = c[3] - c[1];
            let h = (((x - c[0]) * dx + (y - c[1]) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
            (x - c[0] - dx * h).hypot(y - c[1] - dy * h) - (c[4] + (c[5] - c[4]) * h)
        };

        // the crown: a dome over the limbs, filled with clumps; fewer at the bottom middle (gaps)
        let [cx, cy] = p(-14.0, -108.0);
        let rx = 70.0 * s;
        let ry = 36.0 * s;
        let dome = (cx, cy, rx, ry);
        let back = self.clumps(34, 7.0, 11.0, 5.0, s, dome);
        let front = self.clumps(60, 5.0, 8.5, 2.0, s, dome);
        // strands hanging from the lower edge
        let mut strands = Vec::with_capacity(9);
        for _ in 0..9 {
            let a = PI * (0.15 + 0.7 * self.r());
            let n = 3.0 + (self.r() * 7.0).floor();
            strands.push([cx - a.cos() * rx * 0.9, cy + a.sin() * ry * 0.85, n]);
        }

        for c in &back {
            self.clump(c[0], c[1], c[2], true);
        }
        // the bark: a lit edge at the left, furrows along the trunk
        let inside = |x: f64, y: f64| caps.iter().any(|c| dist(x, y, c) < 0.0);
        let xs = caps.iter().flat_map(|c| [c[0], c[2]]);
        let ys = caps.iter().flat_map(|c| [c[1], c[3]]);
        let (x_min, x_max) = xs.fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), v| (a.min(v), b.max(v)));
        let (y_min, y_max) = ys.fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), v| (a.min(v), b.max(v)));
        self.cv.shape(
            x_min - 8.0,
            y_min - 8.0,
            x_max + 8.0,
            y_max + 2.0,
            inside,
            |x, y, lit, shade| {
                if lit {
                    return c::BARK[2];
                }
                if shade {
                    return c::BARK[0];
                }
                if noise2(x * 0.7, y * 0.1) > 0.6 { c::BARK[0] } else { c::BARK[1] }
            },
            FRONT,
        );
        for c in &front {
            self.clump(c[0], c[1], c[2], false);
        }
        for [x, y, n] in strands {
            let mut k = 0.0;
            while k < n {
                let fx = x + (k * 0.8).sin() * 0.6;
                self.cv.set(fx, y + k, c::BLOSSOM[if k % 3.0 == 0.0 { 4 } else { 2 }], FRONT);
                if k % 3.0 == 1.0 {
                    self.cv.set(fx - 1.0, y + k, c::BLOSSOM[3], FRONT);
                }
                k += 1.0;
            }
        }
        // fallen petals on the roof below the tree (painted with the roof)
        self.fallen.clear();
        for _ in 0..40 {
            let x = base_x + (self.r() - 0.6) * 90.0 * s;
            let dy = self.r() * 3.0;
            let col = c::BLOSSOM[if self.r() < 0.5 { 3 } else { 4 }];
            self.fallen.push((x, dy, col));
        }
        self.crowns.extend_from_slice(&front);
    }

    /// a twig of the hanging branch; its points go to `out`
    #[allow(clippy::too_many_arguments)]
    fn twig(&mut self, mut x: f64, mut y: f64, dx: f64, dy: f64, n: u32, thick: bool, out: &mut Vec<[f64; 2]>) -> [f64; 2] {
        for k in 0..n {
            let kf = f64::from(k);
            x += dx + (kf * 0.7).sin() * 0.3;
            y += dy + kf * 0.015;
            self.cv.set(x, y, if k % 4 == 0 { c::BARK[2] } else { c::BARK[1] }, FRONT);
            if thick && kf < f64::from(n) * 0.6 {
                self.cv.set(x, y - 1.0, c::BARK[2], FRONT);
            }
            out.push([x, y]);
        }
        [x, y]
    }

    /// a branch hanging in from the top edge beside the moon: a twig with side twigs, puffs at their ends
    fn hanging_branch(&mut self) {
        let m = self.moon;
        let mut main = Vec::with_capacity(44);
        let end = self.twig(m.x + 0.75 * self.kb, -1.0, -1.05, 0.62, 44, true, &mut main);
        let mut clusters = vec![[end[0], end[1] + 1.0, 6.0]];
        for k in [12, 22, 32] {
            let Some(&[mx, my]) = main.get(k) else { continue };
            let mut side = Vec::new();
            let dx = -0.5 - self.r() * 0.4;
            let n = 9 + (self.r() * 6.0).floor() as u32;
            let e = self.twig(mx, my, dx, 0.8, n, false, &mut side);
            clusters.push([e[0], e[1] + 1.0, 4.0 + self.r() * 2.0]);
            clusters.push([mx + 2.0, my - 1.0, 3.5 + self.r()]);
        }
        clusters.sort_by(|a, b| a[1].total_cmp(&b[1]));
        for c in &clusters {
            self.clump(c[0], c[1], c[2] + 0.5, false);
        }
        self.crowns.extend_from_slice(&clusters);
    }

    /// the ridge of the temple roof along the bottom: tiles, round tile ends, golden fish at the ends
    fn roof(&mut self) {
        let (bw, bh) = (self.bw, self.bh);
        let top = js_round(bh - 0.11 * self.kb);
        let mut y = top;
        while y < bh {
            for x in 0..bw as i64 {
                let xm = x % 6;
                let xf = x as f64;
                let d = y - top;
                let col = if d == 0.0 {
                    c::RIDGE[2]
                } else if d < 3.0 {
                    if xm == 0 { c::RIDGE[0] } else { c::RIDGE[1] }
                } else if d == 3.0 {
                    c::TILE[0]
                } else if y >= bh - 4.0 {
                    // the round tile ends
                    let u = xm as f64;
                    let v = y - (bh - 4.0);
                    let ring = (u - 2.5).hypot(v - 1.5);
                    if ring < 1.2 {
                        c::TILE_END[2]
                    } else if ring < 2.4 {
                        if u + v < 4.0 { c::TILE_END[1] } else { c::TILE_END[0] }
                    } else {
                        c::TILE[0]
                    }
                } else if xm == 0 {
                    c::TILE[0]
                } else if xm == 1 {
                    c::TILE[3]
                } else if xm < 4 {
                    c::TILE[2]
                } else {
                    c::TILE[1]
                };
                self.cv.set(xf, y, col, FRONT);
            }
            y += 1.0;
        }
        for i in 0..self.fallen.len() {
            let (x, dy, col) = self.fallen[i];
            self.cv.set(x, top + 1.0 + dy, col, FRONT);
        }
        // shachihoko: golden fish at both ends of the ridge, the tail curled up
        const FISH: [&str; 7] = ["..##", ".#.#", "#...", "##..", "###.", ".###", "..##"];
        for s in [-1.0, 1.0] {
            let x0 = if s < 0.0 { 2.0 } else { bw - 6.0 };
            for (jj, row) in FISH.iter().enumerate() {
                for (ii, ch) in row.bytes().enumerate() {
                    if ch == b'#' {
                        let (i, jf) = (ii as f64, jj as f64);
                        let col = if jj < 2 {
                            c::GOLD[2]
                        } else if (ii + jj) % 3 == 0 {
                            c::GOLD[0]
                        } else {
                            c::GOLD[1]
                        };
                        self.cv.set(if s < 0.0 { x0 + i } else { x0 + 3.0 - i }, top - FISH.len() as f64 + jf, col, FRONT);
                    }
                }
            }
        }
    }

    // ---- what moves

    fn setup_moving(&mut self) -> (Vec<Star>, Vec<Cloud>, Vec<Fly>) {
        let bw = self.bw;
        let m = self.moon;
        // bright stars that twinkle, where the sky shows
        let mut stars = Vec::with_capacity(70);
        let mut k = 0;
        while k < 600 && stars.len() < 70 {
            k += 1;
            let x = (self.r() * bw).floor();
            let y = (self.r() * self.y(0.9)).floor();
            if self.cv.layer_at(x, y) != SKY || (x - m.x).hypot(y - m.y) < m.r * 2.0 {
                continue;
            }
            let ph = self.r() * TURN;
            let f = 0.5 + self.r() * 2.2;
            let big = self.r() < 0.15;
            let col = at(&c::STAR, (self.r() * 3.0).floor());
            stars.push(Star { x, y, ph, f, big, col });
        }
        // clouds: long bands with a lit, scalloped top, rasterized once
        let mut clouds = Vec::with_capacity(4);
        for k in 0..4 {
            let len = 40.0 + (self.r() * 50.0).floor();
            let mut blocks = Vec::new();
            let mut x = 0.0;
            while x < len {
                let th = js_round(1.0 + 3.0 * (PI * x / len).sin() + (x * 0.45_f64).sin().abs() * 1.5);
                let mut y = -th;
                while y <= 1.0 {
                    let tone = if y == -th {
                        3
                    } else if y == 1.0 {
                        0
                    } else if y == -th + 1.0 {
                        2
                    } else {
                        1
                    };
                    blocks.push((x, y, tone));
                    y += 1.0;
                }
                x += 1.0;
            }
            let cx = self.r() * bw;
            let ry = self.r();
            let cy = self.y(1.35 + f64::from(k) * 0.13 + ry * 0.05);
            let v = 0.6 + self.r() * 0.9;
            clouds.push(Cloud { x: cx, y: cy, blocks, v });
        }
        // fireflies over the lake and in the bamboo
        let mut flies = Vec::with_capacity(16);
        for _ in 0..16 {
            let x = self.r() * self.x(0.5);
            let ry = self.r();
            let y = self.y(0.15 + ry * 0.5);
            let ph = self.r() * TURN;
            let sp = 0.5 + self.r();
            flies.push(Fly { x, y, ph, sp });
        }
        (stars, clouds, flies)
    }
}

/// Paints the still picture of a layout (scenery.js build()); slow (a worker thread's job).
pub fn paint(l: &Layout) -> Still {
    let n = js_round(l.s / 2.0).max(1.0); // LEDs per block
    let kb = l.ppm * l.s / n; // blocks per meter
    let bw = (l.w as f64 / n).ceil();
    let bh = (l.h as f64 / n).ceil();
    let mut p = Painter {
        cv: Cv::new(bw as i64, bh as i64),
        bw,
        bh,
        kb,
        r: Mulberry(23),
        moon: Moon::default(),
        water: Water { top: 0.0, bottom: 0.0 },
        lanterns: Vec::new(),
        crowns: Vec::new(),
        fallen: Vec::new(),
        castle: 0.0,
        torii: 0.0,
        hill: Cols { v: Vec::new() },
    };
    p.sky();
    p.paint_moon();
    p.far();
    p.fuji();
    let row = p.y(0.66);
    p.mist(row, 3.2, c::MIST, 9.0);
    p.hills();
    p.paint_castle();
    p.paint_torii();
    p.pagoda();
    let row = p.y(0.42);
    p.mist(row, 2.4, c::MIST2, 6.0);
    p.lake();
    p.bridge();
    p.village();
    p.bamboo();
    let (cx, cy) = (p.x(1.0) - 0.42 * kb, p.y(0.11));
    p.cherry(cx, cy);
    p.hanging_branch();
    p.roof();

    // to the LED picture
    let (w, h) = (l.w, l.h);
    let nb = n as usize;
    let (bwi, bhi) = (bw as usize, bh as usize);
    let mut buf = vec![0u32; w * h];
    for by in 0..bhi {
        for bx in 0..bwi {
            let Some(&col) = p.cv.col.get(by * bwi + bx) else { continue };
            let px = pack(col);
            for jy in by * nb..(by * nb + nb).min(h) {
                let row = jy * w;
                if let Some(s) = buf.get_mut(row + bx * nb..row + (bx * nb + nb).min(w)) {
                    s.fill(px);
                }
            }
        }
    }
    let (stars, clouds, flies) = p.setup_moving();
    Still {
        buf,
        layer: std::mem::take(&mut p.cv.layer),
        bw: p.cv.w,
        bh: p.cv.h,
        n,
        kb,
        moon: p.moon,
        water: Some(p.water),
        lanterns: p.lanterns,
        crowns: p.crowns,
        stars,
        clouds,
        flies,
    }
}

/// The scenery: the still picture and what moves in it.
pub struct Scenery {
    pub still: Still,
    time: f64,
    petals: Vec<Petal>,
    birds: Option<Birds>,
    next_birds: f64,
    shoot: Option<Shoot>,
    next_shoot: f64,
    rng: Rng,
}

impl Scenery {
    pub fn new(still: Still) -> Self {
        Self { still, time: 0.0, petals: Vec::with_capacity(160), birds: None, next_birds: 12.0, shoot: None, next_shoot: 9.0, rng: Rng::from_time() }
    }

    /// A new still picture (another layout): the moving things start over in it.
    pub fn set_still(&mut self, still: Still) {
        self.still = still;
        self.petals.clear();
    }

    fn random(&mut self) -> f64 {
        self.rng.f64()
    }

    pub fn step(&mut self, dt: f64, p: &P) {
        self.time += dt;
        let (bw, bh) = (self.still.bw as f64, self.still.bh as f64);
        for c in &mut self.still.clouds {
            c.x += c.v * dt;
            if c.x > bw + 5.0 {
                c.x = -100.0;
            }
        }
        // petals from the crowns, blown to the left across the wall (blocks per second)
        let want = js_round(p.petals).max(0.0) as usize;
        let nc = self.still.crowns.len();
        while self.petals.len() < want && nc > 0 {
            let c = self.still.crowns[self.rng.int(nc)];
            let vx = -(4.0 + self.random() * 10.0);
            let vy = 2.0 + self.random() * 6.0;
            let ph = self.random() * TURN;
            let col = at(&c::PETAL, (self.random() * 3.0).floor());
            self.petals.push(Petal { x: c[0], y: c[1], vx, vy, ph, col });
        }
        self.petals.truncate(want);
        let time = self.time;
        for i in 0..self.petals.len() {
            let q = &mut self.petals[i];
            q.x += (q.vx + (time * 1.3 + q.ph).sin() * 4.0) * dt;
            q.y += (q.vy + (time * 2.1 + q.ph).cos() * 3.0) * dt;
            if (q.y > bh - 2.0 || q.x < -2.0) && nc > 0 {
                let c = self.still.crowns[self.rng.int(nc)];
                let q = &mut self.petals[i];
                q.x = c[0];
                q.y = c[1];
            }
        }
        for f in &mut self.still.flies {
            f.x += (time * 0.4 * f.sp + f.ph).sin() * 3.0 * dt;
            f.y += (time * 0.6 * f.sp + f.ph * 2.0).cos() * 2.0 * dt;
        }
        // now and then a flock of birds crosses the sky
        self.next_birds -= dt;
        if self.next_birds <= 0.0 && p.birds {
            self.next_birds = 18.0 + self.random() * 20.0;
            let dir = if self.random() < 0.5 { 1.0 } else { -1.0 };
            let m = self.still.moon;
            let y = m.y + (self.random() - 0.4) * m.r * 2.0;
            let v = dir * (14.0 + self.random() * 8.0);
            let n = 3 + (self.random() * 3.0).floor() as u32;
            self.birds = Some(Birds { x: if dir > 0.0 { -10.0 } else { bw + 10.0 }, y, v, n });
        }
        if let Some(b) = &mut self.birds {
            b.x += b.v * dt;
            if b.x < -40.0 || b.x > bw + 40.0 {
                self.birds = None;
            }
        }
        self.next_shoot -= dt;
        if self.next_shoot <= 0.0 && p.shooting_stars {
            self.next_shoot = 14.0 + self.random() * 16.0;
            let dir = if self.random() < 0.5 { -1.0 } else { 1.0 };
            let x = bw * (0.3 + self.random() * 0.4);
            let y = 8.0 + self.random() * 20.0;
            let vx = dir * (180.0 + self.random() * 80.0);
            let vy = 50.0 + self.random() * 30.0;
            self.shoot = Some(Shoot { x, y, vx, vy, t0: self.time, life: 0.7 });
        }
        if self.shoot.as_ref().is_some_and(|s| self.time - s.t0 > s.life) {
            self.shoot = None;
        }
    }

    /// what moves behind the people, into the pixel layer (blocks -> art px)
    pub fn draw(&self, pix: &mut Pix) {
        let st = &self.still;
        let t = self.time;
        let u = st.n / pix.s; // a block in art px
        let put = |pix: &mut Pix, x: f64, y: f64, c: Rgb, a: f32| pix.put(js_round(x) * u, js_round(y) * u, c, a, u);
        for s in &st.stars {
            let tw = 0.5 + 0.5 * (t * s.f + s.ph).sin();
            let k = (0.35 + 0.65 * tw) as f32;
            let col = [s.col[0] * k, s.col[1] * k, s.col[2] * k];
            put(pix, s.x, s.y, col, 1.0);
            if s.big && tw > 0.75 {
                let c2 = [col[0] * 0.45, col[1] * 0.45, col[2] * 0.45];
                for (dx, dy) in [(-1.0, 0.0), (1.0, 0.0), (0.0, -1.0), (0.0, 1.0)] {
                    if st.layer_at(s.x + dx, s.y + dy) == SKY {
                        put(pix, s.x + dx, s.y + dy, c2, 1.0);
                    }
                }
            }
        }
        // clouds, only over sky and moon (behind everything else)
        let m = st.moon;
        for c in &st.clouds {
            for &(dx, dy, k) in &c.blocks {
                let x = js_round(c.x + dx);
                let y = js_round(c.y + dy);
                let l = st.layer_at(x, y);
                if l != SKY && l != MOON {
                    continue;
                }
                let near = (x - m.x).hypot(y - m.y) < m.r * 1.9;
                let col = if k == 3 {
                    c::CLOUD[if near { 3 } else { 2 }]
                } else {
                    c::CLOUD[if k == 2 && near {
                        2
                    } else if k == 0 {
                        0
                    } else {
                        1
                    }]
                };
                put(pix, x, y, col, 1.0);
            }
        }
        // the moon shimmering in the lake
        if let Some(w) = st.water {
            let mut y = w.top + 1.0;
            while y <= w.bottom {
                if (y + (t * 3.0).floor()) % 2.0 == 0.0 {
                    let ww = 3.0 + (y - w.top) * 0.45;
                    let off = (t * 1.7 + y * 0.9).sin() * 2.5;
                    let len = 1.0 + ((0.5 + 0.5 * (t * 2.3 + y * 1.7).sin()) * ww * 0.7).floor();
                    let x0 = js_round(m.x + off - len / 2.0);
                    let mut x = x0;
                    while x < x0 + len {
                        if st.layer_at(x, y) == WATER {
                            put(pix, x, y, c::REFLECT[if (x - m.x - off).abs() < len * 0.25 { 2 } else { 1 }], 1.0);
                        }
                        x += 1.0;
                    }
                }
                y += 1.0;
            }
        }
        // birds: little Vs flapping
        if let Some(b) = &self.birds {
            for k in 0..b.n {
                let kf = f64::from(k);
                let sign = if b.v > 0.0 {
                    1.0
                } else if b.v < 0.0 {
                    -1.0
                } else {
                    0.0
                };
                let x = b.x - sign * kf * 5.0;
                let y = b.y + if k % 2 == 1 { 2.0 } else { 0.0 } + kf;
                let up = if (t * 12.0 + kf).sin() > 0.0 { -1.0 } else { 0.0 };
                put(pix, x, y, c::BIRD, 1.0);
                put(pix, x - 1.0, y + up, c::BIRD, 1.0);
                put(pix, x + 1.0, y + up, c::BIRD, 1.0);
            }
        }
        if let Some(s) = &self.shoot {
            let a = (t - s.t0) / s.life;
            let sp = s.vx.hypot(s.vy);
            for k in 0..20 {
                let kf = f64::from(k);
                let x = s.x + s.vx * (t - s.t0) - (s.vx / sp) * kf;
                let y = s.y + s.vy * (t - s.t0) - (s.vy / sp) * kf;
                if st.layer_at(x, y) == SKY {
                    put(pix, x, y, [1.0, 1.0, 1.0], ((1.0 - kf / 20.0) * (1.0 - a * a)) as f32);
                }
            }
        }
        // the lanterns flicker
        for l in &st.lanterns {
            let fl = (t * 9.0 + l.x).sin() * (t * 3.7 + l.y).sin() > -0.25;
            let col = if l.small { c::WINDOW[if fl { 2 } else { 1 }] } else { c::CHOCHIN[if fl { 2 } else { 1 }] };
            put(pix, l.x, l.y, col, 1.0);
        }
        // fireflies: on or off, never dim
        for f in &st.flies {
            if (t * 2.2 * f.sp + f.ph * 3.0).sin() > 0.55 {
                put(pix, f.x, f.y, c::FIREFLY, 1.0);
            }
        }
    }

    /// the cherry petals, in front of the people
    pub fn draw_petals(&self, pix: &mut Pix) {
        let u = self.still.n / pix.s;
        for q in &self.petals {
            let x = js_round(q.x) * u;
            let y = js_round(q.y) * u;
            pix.put(x, y, q.col, 1.0, u);
            if (self.time * 5.0 + q.ph).sin() > 0.0 {
                pix.put(x + u, y, q.col, 1.0, u);
            }
        }
    }

    /// the lanterns light their surroundings: add(x, y (wall m), r (m), intensity, col)
    pub fn lights(&self, add: &mut impl FnMut(f64, f64, f64, f64, Rgb), l: &Layout) {
        let st = &self.still;
        for lt in &st.lanterns {
            let fl = 0.85 + 0.15 * (self.time * 9.0 + lt.x).sin() * (self.time * 3.7 + lt.y).sin();
            add(lt.x / st.kb, l.top - lt.y / st.kb, lt.r, lt.i * fl, c::CHOCHIN[2]);
        }
    }
}
