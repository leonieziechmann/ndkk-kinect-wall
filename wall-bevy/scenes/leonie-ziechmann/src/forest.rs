//! The birch wood (forest.js), painted once per layout as four layers in a flat, pixel-crisp style,
//! so people can walk between the trees:
//!
//!   0  the deep wood: dark indigo, a warm light far behind, very many small trees, the far hills
//!   1  far trees  (DEPTHS[0] m from the sensor), golden light rays and a band of glowing mist
//!   2  mid trees  (DEPTHS[1]), fainter rays, a thinner band of mist
//!   3  near trees (DEPTHS[2]): wide white trunks, the brightest crowns, the near knolls with heather
//!
//! Layers 1-3 are transparent around their trees and hills. render.rs puts every person pixel
//! between the layers by its distance from the sensor. Every row of trees has its own crowns and its
//! own rolling ground; the farther a row, the lower its crowns sit, the denser and darker it is.
//!
//! Colors: indigo depth against gold light. Things far away are mixed into the deep indigo in
//! OKLCH, not in RGB: a gold crown turns orange, then rose on its way into the dark.
//!
//! The same seeded generator (mulberry32) in the same order as the browser, in f64 like JS numbers:
//! the same trees, crowns and heather on the same LEDs.

use std::collections::HashMap;

use super::layout::{LEAF_COLORS, LEAF_WEIGHTS, Layout, TURN, js_round};
use super::leafpix::{FLAT, Palette, ROUND, Raster, leaf_palette, px, rgb8};

const PI: f64 = std::f64::consts::PI;

/// mulberry32 (forest.js rng())
pub struct Mulberry(u32);

impl Mulberry {
    pub fn new(seed: u32) -> Self {
        Self(seed)
    }

    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

/// a leaf color index from a random number 0..1, golds more often (pickColor)
pub fn pick_color(r: f64) -> usize {
    let sum: f64 = LEAF_WEIGHTS.iter().sum();
    let mut r = r * sum;
    for (i, w) in LEAF_WEIGHTS.iter().enumerate() {
        r -= w;
        if r < 0.0 {
            return i;
        }
    }
    0
}

/// The leaf palettes with alpha `a`: 255 in front of the card, 254 behind it (leaves in the air),
/// 253 at the signs' depth (the heap, leaves lying on a sign)
pub fn palettes(a: u8) -> [Palette; 7] {
    LEAF_COLORS.map(|c| leaf_palette(c.map(rgb8), a))
}

// ---------------------------------------------------------------- colors in OKLCH

fn to_lin(c: u8) -> f64 {
    let v = f64::from(c) / 255.0;
    if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

fn to_srgb(v: f64) -> u8 {
    let e = if v <= 0.003_130_8 { 12.92 * v } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
    js_round(255.0 * e.clamp(0.0, 1.0)).clamp(0.0, 255.0) as u8
}

fn oklch([r8, g8, b8]: [u8; 3]) -> [f64; 3] {
    let (r, g, b) = (to_lin(r8), to_lin(g8), to_lin(b8));
    let l = (0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b).cbrt();
    let m = (0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b).cbrt();
    let s = (0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b).cbrt();
    let ll = 0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s;
    let a = 1.977_998_495_1 * l - 2.428_592_205 * m + 0.450_593_709_9 * s;
    let bb = 0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766 * s;
    [ll, a.hypot(bb), bb.atan2(a)]
}

fn from_oklch([ll, c, h]: [f64; 3]) -> [u8; 3] {
    let a = c * h.cos();
    let b = c * h.sin();
    let l = (ll + 0.396_337_777_4 * a + 0.215_803_757_3 * b).powf(3.0);
    let m = (ll - 0.105_561_345_8 * a - 0.063_854_172_8 * b).powf(3.0);
    let s = (ll - 0.089_484_177_5 * a - 1.291_485_548 * b).powf(3.0);
    [
        to_srgb(4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s),
        to_srgb(-1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s),
        to_srgb(-0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s),
    ]
}

/// a mixed into b by t, in OKLCH (a gray takes the other's hue). The hue goes the short way, or
/// with via_red always through red and magenta (gold into indigo never passes green).
fn mix_ok(a: [u8; 3], b: [u8; 3], t: f64, via_red: bool) -> [u8; 3] {
    let p = oklch(a);
    let q = oklch(b);
    let (mut h0, mut h1) = (p[2], q[2]);
    if p[1] < 0.02 {
        h0 = h1;
    }
    if q[1] < 0.02 {
        h1 = h0;
    }
    let mut dh = h1 - h0;
    if dh > PI {
        dh -= 2.0 * PI;
    }
    if dh < -PI {
        dh += 2.0 * PI;
    }
    if via_red && dh > 0.0 && dh.abs() > 0.6 {
        dh -= 2.0 * PI;
    }
    from_oklch([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, h0 + dh * t])
}

fn mix_hex(a: &str, b: &str, t: f64, via_red: bool) -> [u8; 3] {
    mix_ok(rgb8(a), rgb8(b), t, via_red)
}

// the deep wood, top to bottom, and the color everything far away sinks into
const DEEP: [&str; 4] = ["#0b0e1e", "#121731", "#1a2045", "#232a55"];
const DEEP_MID: &str = "#181e3c";
/// glowing mist, lavender white
const MIST: &str = "#c9ccf2";
/// the light far behind
const GLOW: &str = "#ffd27a";
const RAY: &str = "#fff0d2";

/// distance of the tree layers from the sensor (m), far to near
pub const DEPTHS: [f64; 3] = [3.3, 2.4, 1.5];

/// per layer: trunks per 1000 design px and their width, how crooked, branches per trunk, where the
/// crowns sit (design px from the top) and their radius, leaf size, how much it sinks into the deep
/// wood (0 = not), the ground: base height (design px), hill amplitude and its soil; the mist band
struct LayerDef {
    trunks: f64,
    w: [f64; 2],
    lean: f64,
    branches: u32,
    crown_y: f64,
    crown_r: [f64; 2],
    leaf: [f64; 2],
    deep: f64,
    marks: f64,
    ground: f64,
    hills: f64,
    soil: &'static str,
    mist: f64,
}

const LAYERS: [LayerDef; 4] = [
    LayerDef { trunks: 80.0, w: [2.0, 5.0], lean: 0.012, branches: 0, crown_y: 104.0, crown_r: [11.0, 22.0], leaf: [5.0, 7.0], deep: 0.66, marks: 0.3, ground: 246.0, hills: 9.0, soil: "#1c2244", mist: 0.0 },
    LayerDef { trunks: 24.0, w: [5.0, 9.0], lean: 0.025, branches: 1, crown_y: 68.0, crown_r: [16.0, 30.0], leaf: [6.5, 9.0], deep: 0.42, marks: 0.45, ground: 272.0, hills: 8.0, soil: "#222a50", mist: 0.36 },
    LayerDef { trunks: 9.0, w: [11.0, 17.0], lean: 0.04, branches: 2, crown_y: 34.0, crown_r: [22.0, 40.0], leaf: [8.0, 11.0], deep: 0.18, marks: 0.7, ground: 294.0, hills: 7.0, soil: "#2a335d", mist: 0.22 },
    LayerDef { trunks: 0.0, w: [26.0, 34.0], lean: 0.05, branches: 2, crown_y: 2.0, crown_r: [30.0, 52.0], leaf: [10.0, 14.0], deep: 0.0, marks: 1.0, ground: 318.0, hills: 7.0, soil: "#333d6a", mist: 0.0 },
];

/// where the people's feet stand (persp.rs): on the near and on the far trees' ground
/// ([m from the sensor, design px from the top])
pub const FEET: [[f64; 2]; 2] = [[DEPTHS[2], LAYERS[3].ground], [DEPTHS[0], LAYERS[1].ground]];

/// the near trees stand where they frame the scene (fraction of the design width, lean)
const NEAR: [(f64, f64); 3] = [(0.012, 0.03), (0.415, -0.035), (0.998, -0.02)];

/// the bark of a layer: lit, shaded, edge, marks, foot, branches (sunk into the deep wood by `deep`)
struct Bark {
    lit: u32,
    shade: u32,
    edge: u32,
    mark: u32,
    mark2: u32,
    foot: u32,
    branch: u32,
}

fn bark(deep: f64) -> Bark {
    let f = |h: &str| px(mix_hex(h, DEEP_MID, deep, false), 255);
    Bark { lit: f("#f6f6fa"), shade: f("#c3c5d8"), edge: f("#9a9db9"), mark: f("#0f1016"), mark2: f("#3b3d4c"), foot: f("#13141e"), branch: f("#25273a") }
}

fn hash(x: i64, y: i64) -> f64 {
    let h = (x as i32 as u32).wrapping_mul(374_761_393) ^ (y as i32 as u32).wrapping_mul(668_265_263);
    let h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
    f64::from(h ^ (h >> 16)) / 4_294_967_296.0
}

/// A rolling line: y (px) at column x around `base` (design px) with amplitude `amp`.
#[derive(Clone, Copy, Debug)]
pub struct Rolling {
    base: f64,
    amp: f64,
    s: f64,
    k: [f64; 3],
    f: [f64; 3],
}

impl Rolling {
    fn new(base: f64, amp: f64, s: f64, r: &mut Mulberry) -> Self {
        let k = [r.next() * TURN, r.next() * TURN, r.next() * TURN];
        let f = [0.004 + r.next() * 0.003, 0.011 + r.next() * 0.006, 0.027 + r.next() * 0.01];
        Self { base, amp, s, k, f }
    }

    pub fn at(&self, x: f64) -> f64 {
        let u = x / self.s;
        let (k, f) = (self.k, self.f);
        (self.base + self.amp * (0.6 * (u * f[0] + k[0]).sin() + 0.3 * (u * f[1] + k[1]).sin() + 0.12 * (u * f[2] + k[2]).sin())) * self.s
    }
}

/// a drawn birch: its middle and width at height y (for branches and the crown)
struct Trunk {
    x0: f64,
    w: f64,
    lean: f64,
    top: f64,
    y_bot: f64,
    len: f64,
}

impl Trunk {
    fn mid(&self, y: f64) -> f64 {
        self.x0 + self.lean * (self.y_bot - y) + (y * 0.013 + self.x0).sin() * self.w * 0.08
    }
    fn width(&self, y: f64) -> f64 {
        self.w * (0.72 + 0.28 * ((y - self.top) / self.len))
    }
}

/// The pixels of one layer (u32 RGBA, not premultiplied, as ImageData) and its size.
struct Img {
    buf: Vec<u32>,
    w: usize,
    h: usize,
}

impl Img {
    fn set(&mut self, x: i64, y: i64, c: u32) {
        if x >= 0 && y >= 0 && (x as usize) < self.w && (y as usize) < self.h {
            self.buf[y as usize * self.w + x as usize] = c;
        }
    }
    fn bytes(&mut self) -> &mut [u8] {
        bytemuck::cast_slice_mut(&mut self.buf)
    }
}

/// A birch from `top` down to y_bot: two-tone bark, lenticels, branch scars, a rough dark foot.
/// x0: its middle at y_bot, w: width at the foot, lean: px sideways per px up.
#[allow(clippy::too_many_arguments)]
fn birch(img: &mut Img, x0: f64, w: f64, top: f64, y_bot: f64, lean: f64, pal: &Bark, r: &mut Mulberry, s: f64, mark_amount: f64, deep: f64) -> Trunk {
    let trunk = Trunk { x0, w, lean, top, y_bot, len: (y_bot - top).max(1.0) };
    // the marks: per row, dashes [u0, u1] across the trunk (0 left .. 1 right)
    let mut rows: HashMap<i64, Vec<(f64, f64)>> = HashMap::new();
    let mut add = |y: f64, u0: f64, u1: f64| rows.entry(y as i64).or_default().push((u0, u1));
    let mut y = top + js_round(r.next() * 8.0);
    while y < y_bot {
        if r.next() < mark_amount {
            let th = 1.0 + (r.next() * if w > 12.0 { 3.0 } else { 2.0 }).floor();
            let from_right = r.next() < 0.6;
            let l = 0.18 + r.next() * if w > 10.0 { 0.5 } else { 0.7 };
            let u0 = if from_right {
                1.0 - l
            } else if r.next() < 0.5 {
                0.0
            } else {
                r.next() * 0.4
            };
            let mut k = 0.0;
            while k < th {
                add(y + k, u0, (u0 + l).min(1.0));
                k += 1.0;
            }
        }
        // a V-shaped branch scar now and then on wide trunks
        if w >= 12.0 && r.next() < 0.07 {
            let c = 0.3 + r.next() * 0.4;
            let h = js_round((3.0 + r.next() * 3.0) * s);
            let mut k = 0.0;
            while k < h {
                let spread = 0.08 + (k / h) * 0.3;
                add(y + k, c - spread - 0.06, c - spread + 0.04);
                add(y + k, c + spread - 0.04, c + spread + 0.06);
                k += 1.0;
            }
            y += h;
        }
        y += js_round((3.0 + r.next() * 7.0) * if w > 10.0 { 1.0 } else { 1.4 } * s.max(0.6));
    }
    let foot_h = js_round((trunk.len * 0.2).min(w * (1.2 + r.next())) * (1.0 - deep * 0.7));
    let mut y = js_round(top).max(0.0);
    let y_end = (img.h as f64).min(y_bot);
    while y < y_end {
        let cx = trunk.mid(y);
        let ww = trunk.width(y);
        let left = js_round(cx - ww / 2.0);
        let right = js_round(cx + ww / 2.0);
        let marks = rows.get(&(y as i64));
        let foot_t = (y - (y_bot - foot_h)) / foot_h.max(1.0); // 0..1 into the dark foot
        let mut x = left;
        while x <= right {
            if x >= 0.0 && x < img.w as f64 {
                let u = (x - left) / (right - left).max(1.0);
                let mut c = if u > 0.62 { pal.shade } else { pal.lit };
                if x == right && w > 6.0 {
                    c = pal.edge;
                }
                if let Some(m) = marks {
                    for &(u0, u1) in m {
                        if u >= u0 && u <= u1 {
                            c = if u > 0.55 { pal.mark } else { pal.mark2 };
                        }
                    }
                }
                if foot_t > 0.0 {
                    // rough black bark at the foot, in chunks, denser further down
                    let n = hash((x / 2.0).floor() as i64, (y / 3.0).floor() as i64) * 0.8 + hash(x as i64, y as i64) * 0.2;
                    if n < foot_t * 0.85 + if u > 0.6 { 0.12 } else { 0.0 } {
                        c = pal.foot;
                    }
                }
                img.set(x as i64, y as i64, c);
            }
            x += 1.0;
        }
        y += 1.0;
    }
    trunk
}

/// A thin dark branch from (x0, y0) up to (x1, y1), tapering, slightly bent.
#[allow(clippy::too_many_arguments)]
fn branch(img: &mut Img, x0: f64, y0: f64, x1: f64, y1: f64, th: f64, color: u32, r: &mut Mulberry) {
    let n = (x1 - x0).hypot(y1 - y0).ceil();
    let bend = (r.next() - 0.5) * 0.25 * n;
    if n.is_nan() || n < 1.0 {
        return; // t = 0 / 0 in the browser: nothing drawn
    }
    let mut i = 0.0;
    while i <= n {
        let t = i / n;
        let x = x0 + (x1 - x0) * t + (t * PI).sin() * bend;
        let y = y0 + (y1 - y0) * t;
        let w = js_round(th * (1.0 - t * 0.7)).max(1.0);
        let mut k = 0.0;
        while k < w {
            img.set(js_round(x + k - w / 2.0) as i64, js_round(y) as i64, color);
            k += 1.0;
        }
        i += 1.0;
    }
}

/// A crown: a cluster of round leaves around (cx, cy) with radius r, denser in the middle.
#[allow(clippy::too_many_arguments)]
fn cluster(img: &mut Img, ras: &mut Raster, cx: f64, cy: f64, rad: f64, ly: &LayerDef, pals: &[Palette; 7], r: &mut Mulberry, s: f64) {
    let n = js_round(((rad * rad) / (ly.leaf[0] * ly.leaf[0] * s * s)) * 2.2);
    let mut i = 0.0;
    while i < n {
        let a = r.next() * PI * 2.0;
        let d = rad * r.next().sqrt() * (0.6 + 0.4 * r.next());
        let size = (ly.leaf[0] + r.next() * (ly.leaf[1] - ly.leaf[0])) * s;
        let rot = (r.next() - 0.5) * 1.4;
        let flip = 0.75 + r.next() * 0.25;
        let pal = &pals[pick_color(r.next())];
        ras.draw_leaf(&mut img.buf, img.w, img.h, cx + a.cos() * d * 1.2, cy + a.sin() * d * 0.85, size, rot, flip, pal, ROUND | FLAT);
        i += 1.0;
    }
}

/// The ground below a layer's line: its soil, a lit crest, and heather tufts along the crest.
fn terrain(img: &mut Img, gy: &Rolling, ly: &LayerDef, deep: f64, r: &mut Mulberry, s: f64) {
    let soil = px(rgb8(ly.soil), 255);
    let soil2 = px(mix_hex(ly.soil, "#05060c", 0.3, false), 255);
    let crest = px(mix_ok(mix_hex(ly.soil, MIST, 0.4, false), rgb8(DEEP_MID), deep * 0.4, false), 255);
    let (w, h) = (img.w, img.h);
    for x in 0..w {
        let y0 = js_round(gy.at(x as f64)) as i64;
        for y in y0.max(0)..h as i64 {
            let c = if y == y0 {
                crest
            } else if (y - y0) as f64 > 10.0 * s && hash(x as i64 >> 1, y >> 1) < 0.5 {
                soil2
            } else {
                soil
            };
            img.buf[y as usize * w + x] = c;
        }
    }
    // heather: short upright strokes along the crest, lilacs and a few fresh greens
    let cols = ["#cfb2f2", "#b996ea", "#a17fdc", "#e2cdf7", "#8c6cd0"].map(|c| px(mix_hex(c, DEEP_MID, deep, false), 255));
    let greens = ["#8fd08a", "#6fb87a"].map(|c| px(mix_hex(c, DEEP_MID, deep, false), 255));
    let n = js_round((w as f64 / s) * if deep > 0.5 { 1.2 } else { 2.6 });
    let mut i = 0.0;
    while i < n {
        let x = (r.next() * w as f64).floor();
        let yb = js_round(gy.at(x) + r.next() * 12.0 * s);
        let hh = js_round((2.0 + r.next() * 5.0) * s * (1.0 - deep * 0.5)).max(2.0);
        let c = if r.next() < 0.14 { greens[((r.next() * 2.0).floor() as usize).min(1)] } else { cols[((r.next() * cols.len() as f64).floor() as usize).min(cols.len() - 1)] };
        let mut k = 0.0;
        while k < hh {
            let y = yb - k;
            let dx = if k > hh / 2.0 && r.next() < 0.3 {
                if r.next() < 0.5 { -1.0 } else { 1.0 }
            } else {
                0.0
            };
            img.set((x + dx) as i64, y as i64, c);
            k += 1.0;
        }
        i += 1.0;
    }
}

#[derive(Clone, Copy)]
struct Box2 {
    x0: f64,
    x1: f64,
    y0: f64,
    y1: f64,
}

/// the signs stand in the wood: nothing of the nearer layers may cover their faces
fn hits_box(boxes: &[Box2], x0: f64, x1: f64, y0: f64, y1: f64) -> bool {
    boxes.iter().any(|b| x1 > b.x0 && x0 < b.x1 && y1 > b.y0 && y0 < b.y1)
}

/// blends `rgb` with alpha a over the (unpremultiplied) RGBA pixel at byte k
fn over(d: &mut [u8], k: usize, rgb: [u8; 3], a: f64) {
    let Some(p) = d.get_mut(k..k + 4) else { return };
    let oa = f64::from(p[3]) / 255.0;
    let na = oa + a * (1.0 - oa);
    for ch in 0..3 {
        p[ch] = js_round((f64::from(rgb[ch]) * a + f64::from(p[ch]) * oa * (1.0 - a)) / na.max(1e-4)).clamp(0.0, 255.0) as u8;
    }
    p[3] = js_round(na * 255.0).clamp(0.0, 255.0) as u8;
}

/// Light rays fanning down from the glow behind the wood: bands with a brighter core, fading.
fn rays(img: &mut Img, glow: [f64; 2], r: &mut Mulberry, s: f64, strength: f64) {
    let rgb = rgb8(RAY);
    // (angle sin, cos, width, alpha)
    let mut beams = [(0.0, 0.0, 0.0, 0.0); 7];
    for b in &mut beams {
        let ang = (-50.0 + r.next() * 100.0) * (PI / 180.0);
        let w = (22.0 + r.next() * 48.0) * s;
        let a = (0.17 + r.next() * 0.16) * strength;
        *b = (ang.sin(), ang.cos(), w, a);
    }
    let (w, h) = (img.w, img.h);
    let hf = h as f64;
    let d = img.bytes();
    for y in 0..h {
        let dy = y as f64 - glow[1];
        if dy <= 0.0 {
            continue;
        }
        for x in 0..w {
            let dx = x as f64 - glow[0];
            let dist = dx.hypot(dy);
            let mut a: f64 = 0.0;
            for &(sn, cs, bw, ba) in &beams {
                let along = dx * sn + dy * cs;
                let across = (dx * cs - dy * sn).abs();
                let wide = bw * (0.35 + (0.9 * along) / hf);
                if along > 0.0 && across < wide / 2.0 {
                    a = a.max(ba * if across < wide * 0.18 { 1.5 } else { 1.0 } * (1.0 - dist / (hf * 1.4)).max(0.0));
                }
            }
            if a > 0.004 {
                over(d, (y * w + x) * 4, rgb, a.min(0.55));
            }
        }
    }
}

/// A band of glowing mist from y0 down to the ground, in three flat steps.
fn mist_band(img: &mut Img, gy: &Rolling, y0: f64, alpha: f64) {
    let rgb = rgb8(MIST);
    let (w, h) = (img.w, img.h);
    let d = img.bytes();
    for x in 0..w {
        let yg = gy.at(x as f64);
        let mut y = js_round(y0).max(0.0);
        let end = (h as f64).min(js_round(yg + 4.0));
        while y < end {
            let t = (y - y0) / (yg - y0).max(1.0);
            let step = if t < 0.33 {
                0.35
            } else if t < 0.66 {
                0.65
            } else {
                1.0
            };
            over(d, (y as usize * w + x) * 4, rgb, alpha * step);
            y += 1.0;
        }
    }
}

/// The light far behind the trees: a soft warm glow (no rings, no edge), mixed into the dark in
/// OKLCH, only between the trunks: it fades out towards the crowns (from `top` up), so it never
/// shows through the gaps of the leaves.
fn glow_soft(img: &mut Img, glow: [f64; 2], s: f64, top: f64) {
    let g = rgb8(GLOW);
    let rr = 210.0 * s;
    let mut cache: HashMap<u32, [u8; 3]> = HashMap::new();
    let (w, h) = (img.w, img.h);
    let d = img.bytes();
    for y in (top.floor().max(0.0) as usize)..h {
        let yf = y as f64;
        let fade = ((yf - top) / (55.0 * s)).min(1.0);
        let v = fade * fade * (3.0 - 2.0 * fade);
        for x in 0..w {
            let dist = ((x as f64 - glow[0]) / 1.6).hypot(yf - glow[1]) / rr;
            if dist >= 1.0 {
                continue;
            }
            // smooth falloff, quantized finely (1/48) so the colors can be cached
            let q = js_round((1.0 - dist).powf(2.2) * 0.8 * v * 48.0);
            let t = q / 48.0;
            if t <= 0.0 {
                continue;
            }
            let k = (y * w + x) * 4;
            let Some(p) = d.get_mut(k..k + 3) else { continue };
            let key = (u32::from(p[0]) << 16) | (u32::from(p[1]) << 8) | u32::from(p[2]) | ((js_round(t * 48.0) as u32) << 24);
            let c = *cache.entry(key).or_insert_with(|| mix_ok([p[0], p[1], p[2]], g, t, false));
            p.copy_from_slice(&c);
        }
    }
}

/// A leaf of a nearer crown where falling leaves come from: x, y (LED px), color index.
pub type Spot = (f64, f64, usize);

/// What paintForest() returns: the four layers (premultiplied RGBA8, one after the other, as the
/// browser's copyExternalImageToTexture with premultipliedAlpha), the spots, the near ground.
pub struct Forest {
    pub layers: Vec<u8>,
    pub spots: Vec<Spot>,
    pub ground: Option<Rolling>,
}

struct Tree {
    x: f64,
    lean: f64,
    w: Option<f64>,
    fixed: bool,
}

struct Crown {
    x: f64,
    y: f64,
    r: f64,
    /// index into the palette tables
    pals: usize,
}

/// Paints the wood for layout `l`.
pub fn paint(l: &Layout) -> Forest {
    let (wf, hf, s) = (l.w, l.h, l.s);
    let (w, h) = (wf.max(1.0) as usize, hf.max(1.0) as usize);
    let mut r = Mulberry::new(20_261_010);
    let mut ras = Raster::new();
    let mut spots = Vec::new();
    // the light: a soft glow between the trunks, and the rays falling from above, out of the crowns
    let glow = [wf * 0.6, hf * 0.38];
    let sun = [wf * 0.6, hf * 0.12];
    let mut near_ground = None;
    // the faces of the signs and the signpost: the nearer layers keep their trunks and crowns off the
    // codes and the writing (the boards' edges may vanish behind trees)
    let pad = 4.0 * s;
    let sign_boxes: Vec<Box2> = l.signs.iter().map(|g| g.face).chain(std::iter::once(l.post.face)).map(|f| Box2 { x0: f.x0 - pad, x1: f.x1 + pad, y0: f.y0 - pad, y1: f.y1 + pad }).collect();
    let base_pals = palettes(255);
    let mut out = vec![0u8; w * h * 4 * LAYERS.len()];
    for (li, ly) in LAYERS.iter().enumerate() {
        let boxes: &[Box2] = if li >= 2 { &sign_boxes } else { &[] };
        let mut img = Img { buf: vec![0u32; w * h], w, h };
        if li == 0 {
            // the deep wood's gradient, top to bottom (at the pixel centers)
            let stops = DEEP.map(rgb8);
            for y in 0..h {
                let t = ((y as f64 + 0.5) / hf) * (stops.len() - 1) as f64;
                let i = (t.floor() as usize).min(stops.len() - 2);
                let f = t - i as f64;
                let (a, b) = (stops[i], stops[i + 1]);
                let c = [0, 1, 2].map(|ch| js_round(f64::from(a[ch]) + (f64::from(b[ch]) - f64::from(a[ch])) * f).clamp(0.0, 255.0) as u8);
                img.buf[y * w..(y + 1) * w].fill(px(c, 255));
            }
            glow_soft(&mut img, glow, s, (LAYERS[0].crown_y + 12.0) * s);
        }
        let gy = Rolling::new(ly.ground, ly.hills, s, &mut r);
        if li == 3 {
            near_ground = Some(gy);
        }

        // the rows: the deep wood twice (a farther, smaller, darker row first), the others once
        // (deep, crownY, scale, count, drop)
        let rows: &[(f64, f64, f64, f64, f64)] = if li == 0 { &[(0.84, ly.crown_y + 22.0, 0.7, 1.25, 12.0), (ly.deep, ly.crown_y, 1.0, 1.0, 0.0)] } else { &[(ly.deep, ly.crown_y, 1.0, 1.0, 0.0)] };
        let mut tables: Vec<[Palette; 7]> = vec![base_pals];
        let mut crowns: Vec<Crown> = Vec::new();
        for &(deep, crown_y, scale, count, drop) in rows {
            let pal = bark(deep);
            tables.push(LEAF_COLORS.map(|c| leaf_palette(c.map(|hx| mix_hex(hx, DEEP_MID, deep * 0.9, true)), 255)));
            let pals = tables.len() - 1;
            let crown_line = Rolling::new(crown_y, 10.0, s, &mut r);
            let mut trees: Vec<Tree> = Vec::new();
            if li == 3 {
                for (f, lean) in NEAR {
                    trees.push(Tree { x: wf / 2.0 + (f - 0.5) * 1008.0 * s, lean, w: None, fixed: false });
                }
            } else {
                let n = js_round((wf / s / 1000.0) * ly.trunks * count);
                let mut i = 0.0;
                while i < n {
                    let x = ((i + 0.1 + r.next() * 0.8) / n) * wf;
                    let lean = (r.next() - 0.5) * 2.0 * ly.lean;
                    trees.push(Tree { x, lean, w: None, fixed: false });
                    i += 1.0;
                }
            }
            // the birches standing among the signs (straight, so they stay off the codes)
            if li == 2 && deep == ly.deep {
                for t in &l.sign_trees {
                    trees.push(Tree { x: t.x, lean: 0.0, w: Some(t.w), fixed: true });
                }
            }
            for t in &trees {
                let tw = match t.w {
                    Some(v) if v != 0.0 && !v.is_nan() => js_round(v),
                    _ => js_round((ly.w[0] + r.next() * (ly.w[1] - ly.w[0])) * s * scale).max(1.0),
                };
                if !t.fixed && hits_box(boxes, t.x - tw / 2.0 - 2.0 * s, t.x + tw / 2.0 + 2.0 * s, 0.0, hf) {
                    continue;
                }
                let y_bot = js_round(gy.at(t.x) + (4.0 + r.next() * 6.0) * s - drop * s);
                let rad = (ly.crown_r[0] + r.next() * (ly.crown_r[1] - ly.crown_r[0])) * s * scale;
                let cy = crown_line.at(t.x) + (r.next() - 0.5) * 10.0 * s;
                let tr = birch(&mut img, t.x, tw, js_round(cy - rad * 0.3), y_bot, t.lean, &pal, &mut r, s, ly.marks, deep);
                crowns.push(Crown { x: tr.mid(cy), y: cy, r: rad, pals });
                for _ in 0..ly.branches {
                    if r.next() < 0.35 {
                        continue;
                    }
                    let y0 = js_round(cy + rad * 0.8 + r.next() * 50.0 * s);
                    let side = if r.next() < 0.5 { -1.0 } else { 1.0 };
                    let x0 = tr.mid(y0) + (side * tr.width(y0)) / 2.0;
                    let x1 = x0 + side * (20.0 + r.next() * 40.0) * s;
                    let y1 = (y0 - (25.0 + r.next() * 40.0) * s).max(4.0);
                    if hits_box(boxes, x0.min(x1) - 14.0 * s, x0.max(x1) + 14.0 * s, y1 - 14.0 * s, y0) {
                        continue;
                    }
                    branch(&mut img, x0, y0, x1, y1, js_round(tw * 0.12).max(1.0), pal.branch, &mut r);
                    crowns.push(Crown { x: x1, y: y1, r: (10.0 + r.next() * 12.0) * s * scale, pals });
                }
            }
            // fill the gaps between the crowns of a row, so the row has one canopy
            let step = ly.crown_r[1] * if li >= 1 { 0.95 } else { 1.3 } * s * scale;
            let mut x = -step / 2.0;
            while x < wf + step {
                let y = crown_line.at(x) - r.next() * 8.0 * s;
                let rad = (ly.crown_r[0] + r.next() * (ly.crown_r[1] - ly.crown_r[0]) * 0.7) * s * scale;
                crowns.push(Crown { x, y, r: rad, pals });
                x += step * (0.7 + r.next() * 0.6);
            }
        }
        // the near row closes the ceiling: a dense band of leaves along the top edge
        if li == 3 {
            let mut x = -10.0 * s;
            while x < wf + 20.0 * s {
                let y = (r.next() * 16.0 - 6.0) * s;
                let rad = (20.0 + r.next() * 18.0) * s;
                crowns.push(Crown { x, y, r: rad, pals: 0 });
                x += (16.0 + r.next() * 12.0) * s;
            }
        }
        // the hills this layer stands on, then the crowns over its trunks
        terrain(&mut img, &gy, ly, ly.deep, &mut r, s);
        for c in &crowns {
            if hits_box(boxes, c.x - c.r * 1.25, c.x + c.r * 1.25, c.y - c.r * 0.9, c.y + c.r * 0.9) {
                continue;
            }
            let pals = tables.get(c.pals).copied().unwrap_or(base_pals);
            cluster(&mut img, &mut ras, c.x, c.y, c.r, ly, &pals, &mut r, s);
            if li >= 2 {
                spots.push((c.x, c.y + c.r * 0.4, pick_color(r.next())));
            }
        }
        // light and mist in between the layers (thin mist and light may lie over the signs: they
        // stand in the wood, the codes stay readable)
        if li == 1 {
            rays(&mut img, sun, &mut r, s, 1.0);
        }
        if li == 2 {
            rays(&mut img, sun, &mut r, s, 0.45);
        }
        if ly.mist > 0.0 {
            mist_band(&mut img, &gy, (ly.ground - 75.0) * s, ly.mist);
        }
        // premultiplied, as the canvas keeps it
        let dst = &mut out[li * w * h * 4..(li + 1) * w * h * 4];
        for (o, p) in dst.as_chunks_mut::<4>().0.iter_mut().zip(img.bytes().as_chunks::<4>().0) {
            let a = u32::from(p[3]);
            for ch in 0..3 {
                let v = u32::from(p[ch]) * a + 128;
                o[ch] = ((v + (v >> 8)) >> 8) as u8;
            }
            o[3] = p[3];
        }
    }
    Forest { layers: out, spots, ground: near_ground }
}
