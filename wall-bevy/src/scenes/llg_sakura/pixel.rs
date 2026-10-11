//! Pixel art tools (pixel.js): the palette, a small raster with aliased shapes, text from system
//! fonts made crisp (thresholded, outlined), and a hand-made 5x7 capital font.
//!
//! Everything in the scene uses the palette below; the last render pass snaps every pixel to it
//! (with ordered dithering for glows), so nothing outside it ever reaches the wall.

use crate::canvas::{Font, measure_text, text_coverage};

/// The palette (pixel.js C) as 0xRRGGBB.
pub mod c {
    // night sky, from the top down to the glow at the horizon
    pub const SKY0: u32 = 0x07071a;
    pub const SKY1: u32 = 0x0d0e26;
    pub const SKY2: u32 = 0x141638;
    pub const SKY3: u32 = 0x1c1d4a;
    pub const SKY4: u32 = 0x262659;
    pub const SKY5: u32 = 0x33306c;
    pub const SKY6: u32 = 0x44397e;
    pub const SKY7: u32 = 0x583f8a;
    pub const SKY8: u32 = 0x734792;
    pub const SKY9: u32 = 0x93508f;
    pub const SKY10: u32 = 0xb85a8c;
    pub const SKY11: u32 = 0xda6f8a;
    pub const SKY12: u32 = 0xf19084;
    // concrete at night
    pub const G0: u32 = 0x181a36;
    pub const G1: u32 = 0x22264a;
    pub const G2: u32 = 0x2e325c;
    pub const G3: u32 = 0x3c416f;
    pub const G4: u32 = 0x4d5383;
    pub const G5: u32 = 0x636a99;
    pub const G6: u32 = 0x8189b5;
    pub const G7: u32 = 0xa6aed3;
    // the school's orange
    pub const O0: u32 = 0x5c1a2e;
    pub const O1: u32 = 0x8e2a2f;
    pub const O2: u32 = 0xc2402a;
    pub const O3: u32 = 0xe8641f;
    pub const O4: u32 = 0xff8a1c;
    pub const O5: u32 = 0xffae45;
    pub const O6: u32 = 0xffd27a;
    // warm light
    pub const Y0: u32 = 0xffc25c;
    pub const Y1: u32 = 0xffe08a;
    pub const Y2: u32 = 0xfff3c4;
    // cherry blossoms
    pub const P0: u32 = 0x3a1238;
    pub const P1: u32 = 0x5e1c4f;
    pub const P2: u32 = 0x8a2862;
    pub const P3: u32 = 0xb83a7e;
    pub const P4: u32 = 0xe05c9e;
    pub const P5: u32 = 0xff86bb;
    pub const P6: u32 = 0xffb3d4;
    pub const P7: u32 = 0xffdcec;
    pub const P8: u32 = 0xfff4fa;
    // plum bark
    pub const T0: u32 = 0x24122e;
    pub const T1: u32 = 0x3d1d44;
    pub const T2: u32 = 0x5a2c5c;
    // teal and blue
    pub const C0: u32 = 0x123a5c;
    pub const C1: u32 = 0x1c6f8f;
    pub const C2: u32 = 0x2fb3c8;
    pub const C3: u32 = 0x7eeedc;
    pub const B0: u32 = 0x3d63e0;
    pub const B1: u32 = 0x7b8cff;
    pub const W: u32 = 0xffffff;
}

use c::*;

/// PALETTE: every color of C in its order (the palette pass snaps to these).
pub const PALETTE: [u32; 50] = [
    SKY0, SKY1, SKY2, SKY3, SKY4, SKY5, SKY6, SKY7, SKY8, SKY9, SKY10, SKY11, SKY12, G0, G1, G2, G3, G4, G5, G6, G7, O0, O1, O2, O3, O4, O5, O6, Y0, Y1, Y2, P0, P1, P2, P3, P4, P5, P6, P7, P8, T0,
    T1, T2, C0, C1, C2, C3, B0, B1, W,
];

/// The color as rgb 0..1.
pub fn rgb(c: u32) -> [f32; 3] {
    [((c >> 16) & 255) as f32 / 255.0, ((c >> 8) & 255) as f32 / 255.0, (c & 255) as f32 / 255.0]
}

/// The color as rgb 0..1 in f64 (for the OKLab table).
pub fn rgb64(c: u32) -> [f64; 3] {
    [f64::from((c >> 16) & 255) / 255.0, f64::from((c >> 8) & 255) / 255.0, f64::from(c & 255) / 255.0]
}

/// Math.round
pub fn jr(x: f64) -> f64 {
    (x + 0.5).floor()
}

const BAYER4: [f64; 16] = [0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0];

/// The 4x4 ordered dither threshold at a pixel, 0..1.
pub fn bayer(x: i64, y: i64) -> f64 {
    (BAYER4[(y.rem_euclid(4) * 4 + x.rem_euclid(4)) as usize] + 0.5) / 16.0
}

/// Small seeded random generator (pixel.js rng, mulberry32): the same picture every time.
pub struct Rng32(u32);

impl Rng32 {
    pub fn new(seed: u32) -> Self {
        Self(seed)
    }

    /// 0..1
    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let a = self.0;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

/// A raster of RGBA pixels with aliased drawing (every pixel either is or is not): alpha is 0 or
/// 255, so the bytes are premultiplied as they are.
#[derive(Clone)]
pub struct Pix {
    pub w: usize,
    pub h: usize,
    pub px: Vec<[u8; 4]>,
}

const fn rgba(c: u32) -> [u8; 4] {
    [(c >> 16) as u8, (c >> 8) as u8, c as u8, 255]
}

impl Pix {
    pub fn new(w: usize, h: usize) -> Self {
        Self { w, h, px: vec![[0; 4]; w * h] }
    }

    /// RGBA8 rows, tightly packed (for write_texture)
    pub fn bytes(&self) -> &[u8] {
        bytemuck::cast_slice(&self.px)
    }

    pub fn seti(&mut self, x: i64, y: i64, c: u32) {
        if x < 0 || y < 0 || x >= self.w as i64 || y >= self.h as i64 {
            return;
        }
        self.px[y as usize * self.w + x as usize] = rgba(c);
    }

    pub fn set(&mut self, x: f64, y: f64, c: u32) {
        let (x, y) = (x.floor(), y.floor());
        if x < 0.0 || y < 0.0 || x >= self.w as f64 || y >= self.h as f64 {
            return;
        }
        self.px[y as usize * self.w + x as usize] = rgba(c);
    }

    /// A pixel made transparent again.
    pub fn clear_px(&mut self, x: usize, y: usize) {
        if x < self.w && y < self.h {
            self.px[y * self.w + x] = [0; 4];
        }
    }

    pub fn rect(&mut self, x: f64, y: f64, w: f64, h: f64, c: u32) {
        let v = rgba(c);
        let x0 = jr(x).max(0.0);
        let y0 = jr(y).max(0.0);
        let x1 = jr(x + w).min(self.w as f64);
        let y1 = jr(y + h).min(self.h as f64);
        let (xa, xb) = (x0 as usize, x1.max(x0) as usize);
        for j in y0 as usize..y1.max(y0) as usize {
            let row = j * self.w;
            if xa < xb {
                self.px[row + xa..row + xb].fill(v);
            }
        }
    }

    /// Calls f(x, y) for every pixel of the box; a returned color is set.
    pub fn shade(&mut self, x0: f64, y0: f64, x1: f64, y1: f64, mut f: impl FnMut(i64, i64) -> Option<u32>) {
        let (ya, yb) = (y0.floor().max(0.0) as i64, (y1.ceil().min(self.h as f64)) as i64);
        let (xa, xb) = (x0.floor().max(0.0) as i64, (x1.ceil().min(self.w as f64)) as i64);
        for y in ya..yb {
            for x in xa..xb {
                if let Some(c) = f(x, y) {
                    self.px[y as usize * self.w + x as usize] = rgba(c);
                }
            }
        }
    }

    /// Bresenham line.
    pub fn line(&mut self, x0: f64, y0: f64, x1: f64, y1: f64, c: u32) {
        let (mut x0, mut y0, x1, y1) = (jr(x0) as i64, jr(y0) as i64, jr(x1) as i64, jr(y1) as i64);
        let dx = (x1 - x0).abs();
        let dy = -(y1 - y0).abs();
        let sx = if x0 < x1 { 1 } else { -1 };
        let sy = if y0 < y1 { 1 } else { -1 };
        let mut err = dx + dy;
        loop {
            self.seti(x0, y0, c);
            if x0 == x1 && y0 == y1 {
                break;
            }
            let e2 = 2 * err;
            if e2 >= dy {
                err += dy;
                x0 += sx;
            }
            if e2 <= dx {
                err += dx;
                y0 += sy;
            }
        }
    }

    /// A mask stamped at (x, y) in one color.
    pub fn stamp(&mut self, m: &Mask, x: i64, y: i64, c: u32) {
        for j in 0..m.h {
            for i in 0..m.w {
                if m.d[j * m.w + i] != 0 {
                    self.seti(x + i as i64, y + j as i64, c);
                }
            }
        }
    }

    /// Every set pixel of `src` copied in at (x0, y0) (overlay.js paste()).
    pub fn paste(&mut self, src: &Pix, x0: i64, y0: i64) {
        for y in 0..src.h {
            for x in 0..src.w {
                let v = src.px[y * src.w + x];
                let (xx, yy) = (x0 + x as i64, y0 + y as i64);
                if v[3] > 0 && xx >= 0 && yy >= 0 && xx < self.w as i64 && yy < self.h as i64 {
                    self.px[yy as usize * self.w + xx as usize] = v;
                }
            }
        }
    }
}

/// A mask: 1 = set; base: the baseline row of a text.
#[derive(Clone, Debug, Default)]
pub struct Mask {
    pub w: usize,
    pub h: usize,
    pub d: Vec<u8>,
    pub base: i64,
}

impl Mask {
    pub fn new(w: usize, h: usize) -> Self {
        Self { w, h, d: vec![0; w * h], base: 0 }
    }

    pub fn at(&self, x: usize, y: usize) -> bool {
        x < self.w && y < self.h && self.d[y * self.w + x] != 0
    }
}

/// The mask grown by one pixel (8 neighbours), with a margin of one pixel on every side.
pub fn grow(m: &Mask) -> Mask {
    let mut o = Mask::new(m.w + 2, m.h + 2);
    o.base = m.base + 1;
    for y in 0..o.h {
        for x in 0..o.w {
            let mut on = 0;
            'n: for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    let sx = x as i64 - 1 + dx;
                    let sy = y as i64 - 1 + dy;
                    if sx >= 0 && sy >= 0 && m.at(sx as usize, sy as usize) {
                        on = 1;
                        break 'n;
                    }
                }
            }
            o.d[y * o.w + x] = on;
        }
    }
    o
}

/// Text from a system font as a crisp mask: drawn large with the font's own antialiasing, then
/// box-filtered down by `ss` and thresholded, so the strokes keep even widths. size: pixel height
/// of the em; squeeze: horizontal scale. The mask's base is its baseline row.
///
/// Canvas 2D drew the text `ss` times larger with the transform (squeeze, 0, 0, 1, ss, 0); here
/// the glyph coverage of that size is laid onto the art pixels by area (the same box filter).
pub fn text_mask(s: &str, font: &str, size: f64, weight: u16, threshold: f64, ss: u32, squeeze: f64) -> Mask {
    let sf = f64::from(ss.max(1));
    let f = Font::new(font, (size * sf) as f32, weight);
    let width = f64::from(measure_text(s, &f));
    let (cw, ch, base, cov) = text_coverage(s, &f);
    let (cw, ch) = (cw as usize, ch as usize);
    // measureText's actual bounding box, from the glyphs' coverage
    let rows: Vec<usize> = (0..ch).filter(|&y| cov.get(y * cw..(y + 1) * cw).is_some_and(|r| r.iter().any(|&a| a > 0))).collect();
    let asc_px = rows.first().map_or(0.0, |&y| f64::from(base) - y as f64);
    let desc_px = rows.last().map_or(0.0, |&y| y as f64 + 1.0 - f64::from(base));
    let w = ((width * squeeze / sf).ceil() + 2.0).max(1.0) as usize;
    let asc = (asc_px.max(size * 0.8 * sf) / sf).ceil() as i64 + 1;
    let desc = (desc_px.max(0.0) / sf).ceil() as i64 + 1;
    let h = (asc + desc).max(1) as usize;
    // coverage pixel (px, py) lies at x in [ss + squeeze px, ss + squeeze (px + 1)), at row
    // asc ss - base + py of the large canvas
    let mut sum = vec![0f64; w * h];
    let top = asc * i64::from(ss) - i64::from(base);
    for py in 0..ch {
        let yy = top + py as i64;
        if yy < 0 || yy >= (h as i64) * i64::from(ss) {
            continue;
        }
        let ry = (yy / i64::from(ss)) as usize;
        for px in 0..cw {
            let a = cov[py * cw + px];
            if a == 0 {
                continue;
            }
            let x0 = sf + squeeze * px as f64;
            let x1 = x0 + squeeze;
            let mut rx = (x0 / sf).floor().max(0.0) as usize;
            while rx < w && (rx as f64) * sf < x1 {
                let ov = x1.min((rx + 1) as f64 * sf) - x0.max(rx as f64 * sf);
                if ov > 0.0 {
                    sum[ry * w + rx] += f64::from(a) * ov;
                }
                rx += 1;
            }
        }
    }
    let k = 1.0 / (sf * sf * 255.0);
    let mut m = Mask::new(w, h);
    for (o, v) in m.d.iter_mut().zip(&sum) {
        *o = u8::from(v * k >= threshold);
    }
    m.base = asc;
    m
}

/// a 5x7 capital font, drawn by hand
fn f57(ch: char) -> &'static str {
    match ch {
        'A' => ".###.|#...#|#...#|#####|#...#|#...#|#...#",
        'B' => "####.|#...#|#...#|####.|#...#|#...#|####.",
        'C' => ".###.|#...#|#....|#....|#....|#...#|.###.",
        'D' => "####.|#...#|#...#|#...#|#...#|#...#|####.",
        'E' => "#####|#....|#....|####.|#....|#....|#####",
        'F' => "#####|#....|#....|####.|#....|#....|#....",
        'G' => ".###.|#...#|#....|#.###|#...#|#...#|.###.",
        'H' => "#...#|#...#|#...#|#####|#...#|#...#|#...#",
        'I' => ".###.|..#..|..#..|..#..|..#..|..#..|.###.",
        'J' => "..###|...#.|...#.|...#.|#..#.|#..#.|.##..",
        'K' => "#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#",
        'L' => "#....|#....|#....|#....|#....|#....|#####",
        'M' => "#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#",
        'N' => "#...#|#...#|##..#|#.#.#|#..##|#...#|#...#",
        'O' => ".###.|#...#|#...#|#...#|#...#|#...#|.###.",
        'P' => "####.|#...#|#...#|####.|#....|#....|#....",
        'Q' => ".###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#",
        'R' => "####.|#...#|#...#|####.|#.#..|#..#.|#...#",
        'S' => ".####|#....|#....|.###.|....#|....#|####.",
        'T' => "#####|..#..|..#..|..#..|..#..|..#..|..#..",
        'U' => "#...#|#...#|#...#|#...#|#...#|#...#|.###.",
        'V' => "#...#|#...#|#...#|#...#|#...#|.#.#.|..#..",
        'W' => "#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.",
        'X' => "#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#",
        'Y' => "#...#|#...#|.#.#.|..#..|..#..|..#..|..#..",
        'Z' => "#####|....#|...#.|..#..|.#...|#....|#####",
        '-' => ".....|.....|.....|.###.|.....|.....|.....",
        '.' => ".....|.....|.....|.....|.....|.##..|.##..",
        _ => ".....|.....|.....|.....|.....|.....|.....",
    }
}

/// Text in the 5x7 capital font as a mask (1 pixel between letters).
pub fn font57(s: &str) -> Mask {
    let chars: Vec<&str> = s.to_uppercase().chars().map(f57).collect();
    let mut m = Mask::new((chars.len() * 6).saturating_sub(1).max(1), 7);
    for (i, g) in chars.iter().enumerate() {
        for (y, row) in g.split('|').enumerate() {
            for (x, b) in row.bytes().take(5).enumerate() {
                if b == b'#' {
                    m.d[y * m.w + i * 6 + x] = 1;
                }
            }
        }
    }
    m.base = 7;
    m
}

/// How stamp_title() draws a text (fill, a lighter top row, outline, drop shadow).
pub struct Title {
    pub fill: u32,
    pub top: Option<u32>,
    pub outline: u32,
    pub shadow: Option<u32>,
    pub shadow_off: i64,
}

impl Title {
    pub fn fill(fill: u32) -> Self {
        Self { fill, top: None, outline: SKY0, shadow: None, shadow_off: 1 }
    }
}

/// Stamps text the way pixel games do: drop shadow, dark outline, fill (and a lighter top row).
pub fn stamp_title(pix: &mut Pix, m: &Mask, x: i64, y: i64, t: &Title) {
    let o = grow(m);
    if let Some(sh) = t.shadow {
        pix.stamp(&o, x - 1 + t.shadow_off, y - 1 + t.shadow_off, sh);
    }
    pix.stamp(&o, x - 1, y - 1, t.outline);
    pix.stamp(m, x, y, t.fill);
    if let Some(top) = t.top {
        // the upper edge of every stroke one shade lighter
        for j in 0..m.h {
            for i in 0..m.w {
                if m.d[j * m.w + i] != 0 && (j == 0 || m.d[(j - 1) * m.w + i] == 0) {
                    pix.seti(x + i as i64, y + j as i64, top);
                }
            }
        }
    }
}
