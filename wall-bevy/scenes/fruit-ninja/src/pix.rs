//! The pixel layer (pix.js, from space-invaders): an RGBA buffer at LED resolution, drawn in blocks.
//! Every "art pixel" is a block of S x S LEDs (the blocky look), but a block sits wherever its
//! position falls, to the LED (sub-block placement: smooth motion, crisp shapes). `unit` draws
//! smaller blocks for detail (0.5: S/2 x S/2 LEDs). Nothing finer than 2 LEDs, so the LED wall shows
//! no moiré. Also: a small pixel font (digits, x, +, -) and the crown.

use std::fmt;

pub type Rgb = [f32; 3];

pub const WHITE: Rgb = [1.0, 1.0, 1.0];

/// "About a full turn": the browser's random angles and phases use 6.28, not 2π.
#[allow(clippy::approx_constant)]
pub const TURN: f64 = 6.28;

/// 0xrrggbb -> [r, g, b] 0..1
pub const fn rgb(hex: u32) -> Rgb {
    [((hex >> 16) & 255) as f32 / 255.0, ((hex >> 8) & 255) as f32 / 255.0, (hex & 255) as f32 / 255.0]
}

/// Math.round (halves up)
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// floor() as an integer, None if not finite or beyond ±1e15. (f64::floor is a libm call on plain
/// x86-64: this is the same value without it.)
#[inline]
pub fn floor_i(v: f64) -> Option<i64> {
    if !(v > -1e15 && v < 1e15) {
        return None;
    }
    let t = v as i64;
    Some(if (t as f64) > v { t - 1 } else { t })
}

/// Math.round as an integer (see floor_i)
#[inline]
pub fn round_i(v: f64) -> Option<i64> {
    floor_i(v + 0.5)
}

/// Math.sign
pub fn js_sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        0.0
    }
}

/// a channel 0..255 as a Uint8ClampedArray stores it (rounded half to even, without libm)
#[inline]
fn chan(v: f32) -> u8 {
    if v >= 255.0 {
        255
    } else if v > 0.0 {
        let t = v as u32;
        let f = v - t as f32;
        (if f > 0.5 || (f == 0.5 && t & 1 == 1) { t + 1 } else { t }) as u8
    } else {
        0
    }
}

/// An opaque color as it lands in the buffer (bytes r, g, b, a in memory).
#[inline]
pub fn pack(c: Rgb) -> u32 {
    u32::from_ne_bytes([chan(c[0] * 255.0), chan(c[1] * 255.0), chan(c[2] * 255.0), 255])
}

pub struct Pix {
    /// LEDs across, down, LEDs per art pixel
    pub lw: usize,
    pub lh: usize,
    pub s: f64,
    /// art pixels across, down
    pub w: f64,
    pub h: f64,
    /// RGBA8 per LED (the bytes in memory order r, g, b, a: the texture's layout)
    pub buf: Vec<u32>,
}

impl Pix {
    pub fn new(lw: usize, lh: usize, s: f64) -> Self {
        let mut p = Self { lw: 0, lh: 0, s: 1.0, w: 0.0, h: 0.0, buf: Vec::new() };
        p.resize(lw, lh, s);
        p
    }

    pub fn resize(&mut self, lw: usize, lh: usize, s: f64) {
        self.lw = lw;
        self.lh = lh;
        self.s = s;
        self.w = (lw as f64 / s).floor();
        self.h = (lh as f64 / s).floor();
        self.buf.clear();
        self.buf.resize(lw * lh, 0);
    }

    pub fn clear(&mut self) {
        self.buf.fill(0);
    }

    pub fn bytes(&self) -> &[u8] {
        bytemuck::cast_slice(&self.buf)
    }

    /// one LED, color c, opacity a: laid over what is there
    fn dot(&mut self, x: i64, y: i64, c: Rgb, a: f32) {
        if x < 0 || y < 0 || x >= self.lw as i64 || y >= self.lh as i64 || a.is_nan() || a <= 0.004 {
            return;
        }
        let Some(p) = self.buf.get_mut(y as usize * self.lw + x as usize) else { return };
        let b = p.to_ne_bytes();
        let da = f32::from(b[3]) / 255.0;
        if a >= 1.0 || da == 0.0 {
            *p = u32::from_ne_bytes([chan(c[0] * 255.0), chan(c[1] * 255.0), chan(c[2] * 255.0), chan(a.max(da) * 255.0)]);
            return;
        }
        let oa = a + da * (1.0 - a);
        let k = a / oa;
        let mix = |o: u8, v: f32| chan(f32::from(o) + (v * 255.0 - f32::from(o)) * k);
        *p = u32::from_ne_bytes([mix(b[0], c[0]), mix(b[1], c[1]), mix(b[2], c[2]), chan(oa * 255.0)]);
    }

    /// The LED rect of a block of `unit` art pixels with its top left corner at art (x, y), or None
    /// when it is off the buffer: x0, y0, n.
    #[inline]
    fn block(&self, x: f64, y: f64, unit: f64) -> Option<(i64, i64, i64)> {
        let n = round_i(unit * self.s)?.clamp(1, 1_000_000);
        let x0 = round_i(x * self.s)?;
        let y0 = round_i(y * self.s)?;
        if x0 >= self.lw as i64 || y0 >= self.lh as i64 || x0 + n <= 0 || y0 + n <= 0 {
            return None;
        }
        Some((x0, y0, n))
    }

    /// an opaque block of a packed color (pack())
    #[inline]
    pub fn put_packed(&mut self, x: f64, y: f64, px: u32, unit: f64) {
        let Some((x0, y0, n)) = self.block(x, y, unit) else { return };
        self.fill_block(x0, y0, n, px);
    }

    /// LEDs per side of a block of `unit` art pixels
    pub fn block_n(&self, unit: f64) -> i64 {
        round_i(unit * self.s).unwrap_or(1).clamp(1, 1_000_000)
    }

    /// the LED where a block starting at art coordinate `v` starts (as put() places it)
    pub fn led(&self, v: f64) -> Option<i64> {
        round_i(v * self.s)
    }

    /// an opaque n x n LED block at LED (x0, y0), clipped
    #[inline]
    pub fn fill_block(&mut self, x0: i64, y0: i64, n: i64, px: u32) {
        let (w, h) = (self.lw as i64, self.lh as i64);
        if x0 >= w || y0 >= h || x0 + n <= 0 || y0 + n <= 0 {
            return;
        }
        let (xa, xb) = (x0.max(0) as usize, (x0 + n).min(w) as usize);
        for yy in y0.max(0)..(y0 + n).min(h) {
            let row = yy as usize * self.lw;
            if let Some(s) = self.buf.get_mut(row + xa..row + xb) {
                s.fill(px);
            }
        }
    }

    /// a block of `unit` art pixels with its top left corner at art (x, y), placed to the LED
    pub fn put(&mut self, x: f64, y: f64, c: Rgb, a: f32, unit: f64) {
        if a.is_nan() || a <= 0.004 {
            return;
        }
        if a >= 1.0 {
            // opaque: straight into the buffer
            self.put_packed(x, y, pack(c), unit);
            return;
        }
        let Some((x0, y0, n)) = self.block(x, y, unit) else { return };
        for j in 0..n {
            for i in 0..n {
                self.dot(x0 + i, y0 + j, c, a);
            }
        }
    }

    /// A ring of blocks: the blocks whose center is less than w/2 from the circle of radius r. Only
    /// the blocks near the circle are tested (the same blocks, in the same order, as testing all).
    #[allow(clippy::too_many_arguments)]
    pub fn ring(&mut self, cx: f64, cy: f64, r: f64, w: f64, c: Rgb, a: f32, unit: f64) {
        let nf = ((r + w) / unit).ceil() + 1.0;
        if !nf.is_finite() || unit.is_nan() || unit <= 0.0 {
            return;
        }
        let n = nf.clamp(0.0, 1e5) as i64;
        let ro = r + w / 2.0;
        let ri = r - w / 2.0;
        let range = |a: f64, b: f64| ((a / unit - 0.5).ceil().max(-nf) as i64, (b / unit - 0.5).floor().min(nf) as i64);
        for j in -n..=n {
            let yy = (j as f64 + 0.5) * unit;
            if yy.abs() > ro + unit {
                continue;
            }
            // candidates: inside the outer circle, outside the inner one (a unit of slack each)
            let xo = (ro * ro - yy * yy).max(0.0).sqrt() + unit;
            let xi = if ri > 0.0 && ri * ri > yy * yy { (ri * ri - yy * yy).sqrt() - unit } else { -1.0 };
            let spans = if xi > 0.0 { [range(-xo, -xi), range(xi, xo)] } else { [range(-xo, xo), (1, 0)] };
            for (i0, i1) in spans {
                for i in i0..=i1 {
                    let xx = (i as f64 + 0.5) * unit;
                    if (xx.hypot(yy) - r).abs() < w / 2.0 {
                        self.put(cx + xx - unit / 2.0, cy + yy - unit / 2.0, c, a, unit);
                    }
                }
            }
        }
    }

    /// text of digits, x, +, - centered at (cx, cy); h = glyph height in art px
    pub fn text(&mut self, s: &[u8], cx: f64, cy: f64, h: f64, c: Rgb, a: f32) {
        let unit = h / 5.0;
        let adv = 4.0 * unit;
        let x0 = cx - (adv * s.len() as f64 - unit) / 2.0;
        for (k, ch) in s.iter().enumerate() {
            let Some(g) = glyph(*ch) else { continue };
            for (j, row) in g.iter().enumerate() {
                for (i, b) in row.bytes().enumerate() {
                    if b == b'#' {
                        self.put(x0 + k as f64 * adv + i as f64 * unit, cy - h / 2.0 + j as f64 * unit, c, a, unit);
                    }
                }
            }
        }
    }
}

// 3 x 5 pixel font
fn glyph(ch: u8) -> Option<&'static [&'static str; 5]> {
    const FONT: [[&str; 5]; 13] = [
        ["###", "#.#", "#.#", "#.#", "###"],
        [".#.", "##.", ".#.", ".#.", "###"],
        ["###", "..#", "###", "#..", "###"],
        ["###", "..#", ".##", "..#", "###"],
        ["#.#", "#.#", "###", "..#", "..#"],
        ["###", "#..", "###", "..#", "###"],
        ["###", "#..", "###", "#.#", "###"],
        ["###", "..#", ".#.", ".#.", ".#."],
        ["###", "#.#", "###", "#.#", "###"],
        ["###", "#.#", "###", "..#", "###"],
        ["...", "#.#", ".#.", "#.#", "..."],
        ["...", ".#.", "###", ".#.", "..."],
        ["...", "...", "###", "...", "..."],
    ];
    let i = match ch {
        b'0'..=b'9' => usize::from(ch - b'0'),
        b'x' => 10,
        b'+' => 11,
        b'-' => 12,
        _ => return None,
    };
    FONT.get(i)
}

/// the winner's crown, 9 x 6 art px: '#' gold, 'j' jewels
pub const CROWN: [&str; 6] = ["#...#...#", "##.###.##", "#########", "#j##j##j#", "#########", ".#######."];

/// A short text without allocating (numbers on the wall: points, combos).
#[derive(Clone, Copy)]
pub struct Label {
    b: [u8; 24],
    n: usize,
}

impl Label {
    pub fn new() -> Self {
        Self { b: [0; 24], n: 0 }
    }

    pub fn bytes(&self) -> &[u8] {
        self.b.get(..self.n).unwrap_or(&[])
    }
}

impl fmt::Write for Label {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        for &c in s.as_bytes() {
            if let Some(d) = self.b.get_mut(self.n) {
                *d = c;
                self.n += 1;
            }
        }
        Ok(())
    }
}

/// A number as String() writes it (no "-0", no ".0").
pub fn num_label(v: f64) -> Label {
    let mut l = Label::new();
    let _ = fmt::Write::write_fmt(&mut l, format_args!("{}", v + 0.0));
    l
}
