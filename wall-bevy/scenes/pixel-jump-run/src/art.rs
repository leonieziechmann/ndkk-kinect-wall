//! The pixel art (art.js): sprites (one character = one cell of the LED mosaic), the outfits of the
//! pixel people, a 3 x 5 digit font and the colors. Everything is drawn into a cell buffer (Cells)
//! at mosaic resolution; render.rs scales it onto the LED image and lays the LED raster over it.

use std::sync::LazyLock;

/// A color 0..255 per channel (may leave the range: the cell buffer clamps, as Uint8ClampedArray).
pub type Rgb = [f64; 3];

/// '#rrggbb' -> [r, g, b] 0..255
pub fn rgb(hex: &str) -> Rgb {
    let v = u32::from_str_radix(hex.get(1..).unwrap_or(""), 16).unwrap_or(0);
    [f64::from((v >> 16) & 255), f64::from((v >> 8) & 255), f64::from(v & 255)]
}

pub fn mix(a: Rgb, b: Rgb, k: f64) -> Rgb {
    [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

pub fn scale(c: Rgb, k: f64) -> Rgb {
    [c[0] * k, c[1] * k, c[2] * k]
}

/// the full rainbow (star power)
pub fn rainbow(x: f64) -> Rgb {
    let h = ((x % 1.0) + 1.0) % 1.0;
    let ch = |o: f64| 255.0 * ((((h + o) % 1.0) * 6.0 - 3.0).abs() - 1.0).clamp(0.0, 1.0);
    [ch(0.0), ch(2.0 / 3.0), ch(1.0 / 3.0)]
}

/// a stable pseudo-random number 0..1 per integer pair (the same bits as the browser's Math.imul hash)
pub fn hash2(i: i64, j: i64) -> f64 {
    let (i, j) = (i as i32, j as i32);
    let mut h = i.wrapping_mul(374_761_393).wrapping_add(j.wrapping_mul(668_265_263));
    h = (h ^ ((h as u32 >> 13) as i32)).wrapping_mul(1_274_126_177);
    f64::from((h ^ ((h as u32 >> 16) as i32)) as u32) / 4_294_967_296.0
}

/// Math.round: halves up
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

// ---------- sprites ----------

fn palette(ch: char) -> &'static str {
    match ch {
        'W' => "#ffffff",
        'K' => "#12081f",
        'R' => "#ff2d55",
        'D' => "#b0123f",
        'O' => "#ff7a1a",
        'Y' => "#ffd23f",
        'y' => "#fff2a8",
        'M' => "#ff3fd0",
        'P' => "#ffb3ee",
        'V' => "#a24dff",
        'v' => "#6a2bd0",
        'C' => "#29e6ff",
        'c' => "#1478c8",
        'B' => "#3a5bff",
        'G' => "#c7f0ff",
        _ => "#ff00ff",
    }
}

pub struct Sprite {
    pub w: i32,
    pub h: i32,
    /// the colored cells: x, y, color
    pub px: Vec<(i32, i32, Rgb)>,
}

fn sprite(rows: &[&str]) -> Sprite {
    let mut px = Vec::new();
    for (y, row) in rows.iter().enumerate() {
        for (x, ch) in row.chars().enumerate() {
            if ch == '.' || ch == ' ' {
                continue;
            }
            px.push((x as i32, y as i32, rgb(palette(ch))));
        }
    }
    Sprite { w: rows.iter().map(|r| r.chars().count()).max().unwrap_or(0) as i32, h: rows.len() as i32, px }
}

/// The sprites (facing left: everything comes from the right; drawn mirrored for the other direction).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Spr {
    // on the ground: jump over them (4-5 cells, at most 30 cm: a small hop with the boost clears them)
    Crawler,
    Flame,
    Crystal,
    // in the air at head height: duck under them
    Bat,
    Drone,
    // to collect
    Coin,
    Star,
    Crown,
    Heart,
    Flag,
}

pub const LOW: [Spr; 3] = [Spr::Crawler, Spr::Flame, Spr::Crystal];
pub const HIGH: [Spr; 2] = [Spr::Bat, Spr::Drone];

const FRAMES: [&[&[&str]]; 10] = [
    &[&[".O.O.O.", "ORORORO", "RWKRRRR", ".D.D.D."], &[".O.O.O.", "ORORORO", "RWKRRRR", "D.D.D.D"]],
    &[&["..R..", ".ROR.", "ROYOR", "RYyYR", ".RYR."], &[".R...", ".RRR.", "ROYOR", "RYyOR", ".RYR."], &["...R.", ".RRR.", "RROOR", "ROyYR", ".RYR."]],
    &[&["..M..M", "M.MPMP", "MPMMPM", "MMMMMM"]],
    &[
        &["V.........V", "VV..V.V..VV", "VVVVVVVVVVV", ".VVVPVPVVV.", "....VVV...."],
        &["...V...V...", "..VVV.VVV..", ".VVVPVPVVV.", "VVVVVVVVVVV", "V...VVV...V"],
        &["....V.V....", "...VVVVV...", ".VVVPVPVVV.", "VVVVVVVVVVV", "VV..VVV..VV"],
    ],
    &[&["CCCC...CCCC", "....c.c....", "..cCCCCCc..", ".cCWKCCCCc.", "..cCCCCCc..", "...R...R..."], &[".CC.....CC.", "....c.c....", "..cCCCCCc..", ".cCWKCCCCc.", "..cCCCCCc..", "...O...O..."]],
    &[&[".YY.", "YyYY", "YyYY", "YYYY", ".YY."], &[".YY.", ".yY.", ".yY.", ".YY.", ".YY."], &[".Y..", ".Y..", ".Y..", ".Y..", ".Y.."], &[".YY.", ".Yy.", ".Yy.", ".YY.", ".YY."]],
    &[&["...W...", "..WWW..", "WWWWWWW", ".WWWWW.", "..WWW..", ".WW.WW.", "W.....W"]],
    &[&["Y.Y.Y", "YYYYY", "YRYBY"]],
    &[&["R.R", "RRR", ".R."]],
    &[&["WMWM", "MWMW", "W...", "W..."]],
];

pub struct Sprites {
    frames: Vec<Vec<Sprite>>,
}

impl Sprites {
    /// the frames of a sprite (at least one)
    pub fn of(&self, s: Spr) -> &[Sprite] {
        self.frames.get(s as usize).map(Vec::as_slice).unwrap_or(&[])
    }

    /// frame `i` (wrapping), or the first
    pub fn frame(&self, s: Spr, i: usize) -> Option<&Sprite> {
        let f = self.of(s);
        if f.is_empty() { None } else { f.get(i % f.len()) }
    }
}

pub static SPRITES: LazyLock<Sprites> = LazyLock::new(|| Sprites { frames: FRAMES.iter().map(|list| list.iter().map(|rows| sprite(rows)).collect()).collect() });

// ---------- digits ----------

const DIGITS: [[&str; 5]; 10] = [
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
];

/// a digit, or G O ! for the countdown (3 x 5 like the digits)
fn glyph(ch: u8) -> Option<&'static [&'static str; 5]> {
    match ch {
        b'0'..=b'9' => DIGITS.get(usize::from(ch - b'0')),
        b'G' => Some(&["###", "#..", "#.#", "#.#", "###"]),
        b'O' => Some(&["###", "#.#", "#.#", "#.#", "###"]),
        b'!' => Some(&[".#.", ".#.", ".#.", "...", ".#."]),
        _ => None,
    }
}

/// the width in cells of a text of `len` characters at size `s`
pub fn text_width(len: usize, s: i32) -> i32 {
    (len as i32 * 4 - 1) * s
}

// ---------- the pixel people ----------

pub const HAIR: u8 = 1;
pub const SKIN: u8 = 2;
pub const SHIRT: u8 = 3;
pub const PANTS: u8 = 4;
pub const SHOES: u8 = 5;
pub const SLEEVE: u8 = 6;

// no white shirts: white is the flash of a hit
const SHIRTS: [&str; 11] = ["#29e6ff", "#ff3fd0", "#9a6bff", "#ff5c7a", "#3dffc0", "#4d8dff", "#ff8be8", "#ff7a1a", "#c58bff", "#00d2c0", "#ffd23f"];
const PANTS_C: [&str; 9] = ["#3046c8", "#5b2a9c", "#1f7f8c", "#a02472", "#4430b0", "#2c6fd8", "#7a2fc0", "#203a8a", "#c02a5a"];
const SKIN_C: [&str; 5] = ["#ffd5b8", "#f4b48e", "#e0a07a", "#ffe6d2", "#c98d6a"];
const HAIR_C: [&str; 8] = ["#2a1840", "#ffd23f", "#ff6a3d", "#7a3dff", "#1ad1ff", "#f5f0ff", "#ff3fd0", "#3a2050"];
const SHOES_C: [&str; 5] = ["#ffffff", "#ff2d55", "#29e6ff", "#ffd23f", "#1a1030"];

fn hue(c: Rgb) -> f64 {
    let [r, g, b] = c;
    let mx = r.max(g).max(b);
    let d = mx - r.min(g).min(b);
    if d == 0.0 {
        return 0.0;
    }
    let h = if mx == r {
        ((g - b) / d) % 6.0
    } else if mx == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h * 60.0 + 360.0) % 360.0
}

fn hue_dist(a: Rgb, b: Rgb) -> f64 {
    let d = (hue(a) - hue(b)).abs();
    d.min(360.0 - d)
}

#[derive(Clone, Copy, Debug)]
pub struct Outfit {
    pub shirt: Rgb,
    pub pants: Rgb,
    pub skin: Rgb,
    pub hair: Rgb,
    pub shoes: Rgb,
    pub long_sleeves: bool,
}

/// a stable outfit per person id: shirt, pants, skin, hair, shoes (and short or long sleeves)
pub fn outfit(id: i64, slot: i64) -> Outfit {
    let r = |k: i64| hash2(id * 7 + 13, k);
    let at = |list: &[&str], i: i64| rgb(list.get(i.rem_euclid(list.len() as i64) as usize).copied().unwrap_or("#000000"));
    let pick = |list: &[&str], k: i64| at(list, (r(k) * list.len() as f64).floor() as i64);
    // shirt and pants follow the slot (people standing together differ), a little shuffled per person
    let shirt = at(&SHIRTS, slot * 4 + (r(9) * 2.0).floor() as i64);
    // pants that differ clearly from the shirt (blue on blue reads as one blob)
    let mut pi = slot * 5 + (r(2) * 2.0).floor() as i64;
    let mut pants = at(&PANTS_C, pi);
    let mut n = 0;
    while n < PANTS_C.len() && hue_dist(pants, shirt) < 55.0 {
        pi += 1;
        pants = at(&PANTS_C, pi);
        n += 1;
    }
    Outfit { shirt, pants, skin: pick(&SKIN_C, 3), hair: pick(&HAIR_C, 4), shoes: pick(&SHOES_C, 5), long_sleeves: r(6) < 0.5 }
}

// ---------- the cell buffer ----------

/// A value as an Uint8ClampedArray stores it: clamped, rounded half to even, NaN -> 0.
fn clamp_u8(v: f64) -> u8 {
    v.clamp(0.0, 255.0).round_ties_even() as u8
}

/// The mosaic: RGBA8 per cell.
pub struct Cells {
    pub w: i32,
    pub h: i32,
    pub data: Vec<u8>,
}

impl Cells {
    pub fn new(w: i32, h: i32) -> Self {
        let mut c = Cells { w: 0, h: 0, data: Vec::new() };
        c.resize(w, h);
        c
    }

    pub fn resize(&mut self, w: i32, h: i32) {
        self.w = w.max(1);
        self.h = h.max(1);
        self.data.clear();
        self.data.resize((self.w * self.h * 4) as usize, 0);
    }

    /// every cell from a float RGB image times k (opaque)
    pub fn fill_from(&mut self, base: &[f32], k: f64) {
        for (d, c) in self.data.as_chunks_mut::<4>().0.iter_mut().zip(base.as_chunks::<3>().0) {
            d[0] = clamp_u8(f64::from(c[0]) * k);
            d[1] = clamp_u8(f64::from(c[1]) * k);
            d[2] = clamp_u8(f64::from(c[2]) * k);
            d[3] = 255;
        }
    }

    fn index(&self, x: f64, y: f64) -> Option<usize> {
        let (x, y) = (js_round(x), js_round(y));
        if !(x >= 0.0 && y >= 0.0 && x < f64::from(self.w) && y < f64::from(self.h)) {
            return None;
        }
        Some(((y as i64 * i64::from(self.w) + x as i64) * 4) as usize)
    }

    /// sets a cell (a < 1: blends towards c)
    pub fn put(&mut self, x: f64, y: f64, c: Rgb, a: f64) {
        let Some(o) = self.index(x, y) else { return };
        let Some(d) = self.data.get_mut(o..o + 3) else { return };
        if a >= 1.0 {
            for k in 0..3 {
                d[k] = clamp_u8(c[k]);
            }
        } else if a > 0.0 {
            for k in 0..3 {
                let v = f64::from(d[k]);
                d[k] = clamp_u8(v + (c[k] - v) * a);
            }
        }
    }

    /// adds light to a cell
    pub fn add(&mut self, x: f64, y: f64, c: Rgb, a: f64) {
        let Some(o) = self.index(x, y) else { return };
        let Some(d) = self.data.get_mut(o..o + 3) else { return };
        for k in 0..3 {
            d[k] = clamp_u8(f64::from(d[k]) + c[k] * a);
        }
    }

    /// a sprite with its top left cell at (x, y); flip mirrors it; tint (color, k) replaces its colors
    pub fn sprite(&mut self, s: &Sprite, x: f64, y: f64, flip: bool, tint: Option<(Rgb, f64)>) {
        let (x, y) = (js_round(x), js_round(y));
        for &(sx, sy, c) in &s.px {
            let col = match tint {
                Some((t, k)) => mix(c, t, k),
                None => c,
            };
            let cx = if flip { s.w - 1 - sx } else { sx };
            self.put(x + f64::from(cx), y + f64::from(sy), col, 1.0);
        }
    }

    /// digits and G O ! (3 x 5 cells, one cell apart), each cell as s x s cells; x, y = top left
    pub fn text(&mut self, text: &[u8], x: f64, y: f64, c: Rgb, s: i32) {
        let mut cx = js_round(x);
        let y = js_round(y);
        let sf = f64::from(s);
        for &ch in text {
            if let Some(g) = glyph(ch) {
                for (j, row) in g.iter().enumerate() {
                    for (i, b) in row.bytes().enumerate() {
                        if b != b'#' {
                            continue;
                        }
                        for v in 0..s {
                            for u in 0..s {
                                self.put(cx + i as f64 * sf + f64::from(u), y + j as f64 * sf + f64::from(v), c, 1.0);
                            }
                        }
                    }
                }
            }
            cx += 4.0 * sf;
        }
    }
}

/// The decimal digits of a number into `buf` (no allocation); returns them.
pub fn digits(n: u64, buf: &mut [u8; 20]) -> &[u8] {
    let mut v = n;
    let mut i = buf.len();
    loop {
        i -= 1;
        buf[i] = b'0' + (v % 10) as u8;
        v /= 10;
        if v == 0 {
            break;
        }
    }
    &buf[i..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_matches_the_browser() {
        // values of art.js hash2 in node
        let want =
            [(0, 0, 0.0), (1, 2, 0.8830856902059168), (-5, 911, 0.5824172464199364), (713, 9, 0.36899905232712626), (123456789, -987654, 0.8224818087182939), ((1 << 31) + 5, 3, 0.9202177168335766)];
        for (i, j, v) in want {
            assert!((hash2(i, j) - v).abs() < 1e-15, "hash2({i}, {j})");
        }
        let mut b = [0u8; 20];
        assert_eq!(digits(0, &mut b), b"0");
        assert_eq!(digits(1207, &mut b), b"1207");
    }
}
