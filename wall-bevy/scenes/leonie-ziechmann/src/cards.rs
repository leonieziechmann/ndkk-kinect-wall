//! Everything in front of the wood, in Betula's light look (cards.js), painted on the CPU into two
//! transparent layers (only when something on them changes, in the background: paint.rs):
//!
//!   hero   the contact card: an eyebrow label, the name, the lead, a hairline, mail and phone as
//!          rows with green icons; as large as its text needs
//!   signs  the QR codes on wooden signs stuck in the ground on two stakes, a little crooked, the
//!          label painted on top, the code on a smooth light field (the leaf heap covers their lower
//!          half, heap.rs); all codes are the same size
//!   post   a wooden signpost "Mehr von mir hier" whose arrow points at the signs
//!
//! Type follows Betula: Inter, tight negative tracking for large sizes, wide tracking for the small
//! uppercase label (Canvas letterSpacing), text / text-2 grays, the green accent for the label and
//! the icons. What Canvas 2D did is done here with tiny-skia: shadows (Chrome's blur sigma), the
//! turned boards (nearest neighbour, antialiased edges), the lucide icons (SVG paths), and the text
//! on the turned boards (16× supersampled from a 4× glyph mask, as crisp as Chrome's turned glyphs).

use std::sync::Arc;

use tiny_skia::{FillRule, FilterQuality, LineCap, LineJoin, Mask, Paint, PathBuilder, Pattern, Pixmap, Rect, SpreadMode, Stroke, Transform};

use super::forest::Mulberry;
use super::layout::{FONT, Layout, TURN, c, js_round};
use super::leafpix::{px, rgb8};
use wall::canvas::{Font, measure_text_spaced, text_coverage_spaced};
use wall::common::qr::Qr;

// lucide icons (ISC), 24 × 24
const MAIL: [&str; 2] = ["M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z", "m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"];
const PHONE: [&str; 1] = ["M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"];
const GITHUB: [&str; 2] = [
    "M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4",
    "M9 18c-4.51 2-5-2-7-2",
];

/// light pine, warm but not muddy; the code field is smooth and pale, the paint dark
mod wood {
    pub const BOARD: &str = "#ecc58a";
    pub const LIGHT: &str = "#f7dcaa";
    pub const SHADE: &str = "#cf9c5c";
    pub const GRAIN: &str = "#dcb06f";
    pub const GRAIN2: &str = "#e4bb7e";
    pub const EDGE: &str = "#8f5d31";
    pub const KNOT: &str = "#c08848";
    pub const FIELD: &str = "#f8ecd3";
    pub const FIELD_HI: &str = "#fff8ea";
    pub const FIELD_LO: &str = "#dcc195";
    pub const INK: &str = "#24180e";
    pub const PAINT: &str = "#3a2615";
    pub const PAINT2: &str = "#76522f";
    pub const STAKE: &str = "#d8a663";
    pub const STAKE_GRAIN: &str = "#bb874a";
    pub const NAIL: &str = "#4e331d";
}

/// The wood colors as opaque pixels.
struct Wp {
    board: u32,
    light: u32,
    shade: u32,
    grain: u32,
    grain2: u32,
    edge: u32,
    knot: u32,
    field: u32,
    field_hi: u32,
    field_lo: u32,
    ink: u32,
    stake: u32,
    stake_grain: u32,
    nail: u32,
}

impl Wp {
    fn new() -> Self {
        let p = |h: &str| px(rgb8(h), 255);
        Self {
            board: p(wood::BOARD),
            light: p(wood::LIGHT),
            shade: p(wood::SHADE),
            grain: p(wood::GRAIN),
            grain2: p(wood::GRAIN2),
            edge: p(wood::EDGE),
            knot: p(wood::KNOT),
            field: p(wood::FIELD),
            field_hi: p(wood::FIELD_HI),
            field_lo: p(wood::FIELD_LO),
            ink: p(wood::INK),
            stake: p(wood::STAKE),
            stake_grain: p(wood::STAKE_GRAIN),
            nail: p(wood::NAIL),
        }
    }
}

/// A QR sign's content.
#[derive(Clone)]
pub struct Code {
    pub url: String,
    pub label: String,
    pub small: String,
    pub qr: Arc<Qr>,
    /// Betula's mark before the label (a betula.app link)
    pub mark: bool,
    /// the GitHub icon before the label (a github.com link)
    pub github: bool,
}

/// What the two layers show (cards.js draw(): the layout and the texts).
#[derive(Clone)]
pub struct CardsSpec {
    pub layout: Layout,
    pub eyebrow: String,
    pub name: String,
    pub lead: String,
    pub mail: String,
    pub phone: String,
    pub title: String,
    pub codes: Vec<Code>,
    pub alpha: f64,
}

/// The painted layers: the contact card, then the signs (premultiplied RGBA8), and the card's rect.
pub struct Cards {
    pub pixels: Vec<u8>,
    /// x, y, w, h
    pub hero: [f64; 4],
}

// ---------------------------------------------------------------- drawing helpers

fn color(hex: &str, a: f32) -> tiny_skia::Color {
    let [r, g, b] = rgb8(hex);
    tiny_skia::Color::from_rgba8(r, g, b, (a.clamp(0.0, 1.0) * 255.0).round() as u8)
}

fn rgba(c: ([u8; 3], f32)) -> tiny_skia::Color {
    tiny_skia::Color::from_rgba8(c.0[0], c.0[1], c.0[2], (c.1 * 255.0).round() as u8)
}

fn solid(col: tiny_skia::Color) -> Paint<'static> {
    let mut p = Paint::default();
    p.set_color(col);
    p.anti_alias = true;
    p
}

/// Canvas 2D roundRect(x, y, w, h, r) (corners as cubic arcs).
fn round_rect(x: f32, y: f32, w: f32, h: f32, r: f32) -> Option<tiny_skia::Path> {
    let r = r.min(w / 2.0).min(h / 2.0).max(0.0);
    let k = 0.552_284_8 * r;
    let (x1, y1) = (x + w, y + h);
    let mut pb = PathBuilder::new();
    pb.move_to(x + r, y);
    pb.line_to(x1 - r, y);
    pb.cubic_to(x1 - r + k, y, x1, y + r - k, x1, y + r);
    pb.line_to(x1, y1 - r);
    pb.cubic_to(x1, y1 - r + k, x1 - r + k, y1, x1 - r, y1);
    pb.line_to(x + r, y1);
    pb.cubic_to(x + r - k, y1, x, y1 - r + k, x, y1 - r);
    pb.line_to(x, y + r);
    pb.cubic_to(x, y + r - k, x + r - k, y, x + r, y);
    pb.close();
    pb.finish()
}

/// An SVG path (the commands the lucide icons use: M L H V C S Q T A Z, absolute and relative).
fn svg_path(d: &str) -> Option<tiny_skia::Path> {
    let b = d.as_bytes();
    let mut i = 0;
    let skip = |i: &mut usize| {
        while *i < b.len() && (b[*i] == b' ' || b[*i] == b',' || b[*i] == b'\n' || b[*i] == b'\t') {
            *i += 1;
        }
    };
    let number = |i: &mut usize| -> Option<f32> {
        skip(i);
        let start = *i;
        if *i < b.len() && (b[*i] == b'-' || b[*i] == b'+') {
            *i += 1;
        }
        let mut dot = false;
        while *i < b.len() && (b[*i].is_ascii_digit() || (b[*i] == b'.' && !dot)) {
            dot |= b[*i] == b'.';
            *i += 1;
        }
        if *i < b.len() && (b[*i] == b'e' || b[*i] == b'E') {
            *i += 1;
            if *i < b.len() && (b[*i] == b'-' || b[*i] == b'+') {
                *i += 1;
            }
            while *i < b.len() && b[*i].is_ascii_digit() {
                *i += 1;
            }
        }
        d.get(start..*i)?.parse().ok()
    };
    let flag = |i: &mut usize| -> Option<bool> {
        skip(i);
        let f = *b.get(*i)?;
        *i += 1;
        Some(f == b'1')
    };
    let mut pb = PathBuilder::new();
    let (mut cx, mut cy, mut sx, mut sy) = (0f32, 0f32, 0f32, 0f32);
    // the last control point (S, T)
    let mut last_c: Option<(f32, f32)> = None;
    let mut last_q: Option<(f32, f32)> = None;
    let mut cmd = b'M';
    loop {
        skip(&mut i);
        if i >= b.len() {
            break;
        }
        if b[i].is_ascii_alphabetic() {
            cmd = b[i];
            i += 1;
        } else if cmd == b'M' {
            cmd = b'L'; // more pairs after a moveto are linetos
        } else if cmd == b'm' {
            cmd = b'l';
        }
        let rel = cmd.is_ascii_lowercase();
        let (ox, oy) = if rel { (cx, cy) } else { (0.0, 0.0) };
        let mut c_now = None;
        let mut q_now = None;
        match cmd.to_ascii_uppercase() {
            b'M' => {
                let (x, y) = (number(&mut i)? + ox, number(&mut i)? + oy);
                pb.move_to(x, y);
                (cx, cy, sx, sy) = (x, y, x, y);
            }
            b'L' => {
                let (x, y) = (number(&mut i)? + ox, number(&mut i)? + oy);
                pb.line_to(x, y);
                (cx, cy) = (x, y);
            }
            b'H' => {
                cx = number(&mut i)? + ox;
                pb.line_to(cx, cy);
            }
            b'V' => {
                cy = number(&mut i)? + oy;
                pb.line_to(cx, cy);
            }
            b'C' => {
                let (x1, y1) = (number(&mut i)? + ox, number(&mut i)? + oy);
                let (x2, y2) = (number(&mut i)? + ox, number(&mut i)? + oy);
                let (x, y) = (number(&mut i)? + ox, number(&mut i)? + oy);
                pb.cubic_to(x1, y1, x2, y2, x, y);
                c_now = Some((x2, y2));
                (cx, cy) = (x, y);
            }
            b'S' => {
                let (x1, y1) = last_c.map(|(px, py)| (2.0 * cx - px, 2.0 * cy - py)).unwrap_or((cx, cy));
                let (x2, y2) = (number(&mut i)? + ox, number(&mut i)? + oy);
                let (x, y) = (number(&mut i)? + ox, number(&mut i)? + oy);
                pb.cubic_to(x1, y1, x2, y2, x, y);
                c_now = Some((x2, y2));
                (cx, cy) = (x, y);
            }
            b'Q' => {
                let (x1, y1) = (number(&mut i)? + ox, number(&mut i)? + oy);
                let (x, y) = (number(&mut i)? + ox, number(&mut i)? + oy);
                pb.quad_to(x1, y1, x, y);
                q_now = Some((x1, y1));
                (cx, cy) = (x, y);
            }
            b'T' => {
                let (x1, y1) = last_q.map(|(px, py)| (2.0 * cx - px, 2.0 * cy - py)).unwrap_or((cx, cy));
                let (x, y) = (number(&mut i)? + ox, number(&mut i)? + oy);
                pb.quad_to(x1, y1, x, y);
                q_now = Some((x1, y1));
                (cx, cy) = (x, y);
            }
            b'A' => {
                let (rx, ry, rot) = (number(&mut i)?, number(&mut i)?, number(&mut i)?);
                let (large, sweep) = (flag(&mut i)?, flag(&mut i)?);
                let (x, y) = (number(&mut i)? + ox, number(&mut i)? + oy);
                arc_to(&mut pb, [cx, cy], rx, ry, rot, large, sweep, [x, y]);
                (cx, cy) = (x, y);
            }
            b'Z' => {
                pb.close();
                (cx, cy) = (sx, sy);
            }
            _ => return None,
        }
        last_c = c_now;
        last_q = q_now;
    }
    pb.finish()
}

/// An elliptical arc as cubic curves (SVG endpoint parameterization, F.6.5 of the SVG spec).
#[allow(clippy::too_many_arguments)]
fn arc_to(pb: &mut PathBuilder, p1: [f32; 2], rx: f32, ry: f32, rot_deg: f32, large: bool, sweep: bool, p2: [f32; 2]) {
    let (x1, y1, x2, y2) = (f64::from(p1[0]), f64::from(p1[1]), f64::from(p2[0]), f64::from(p2[1]));
    let (mut rx, mut ry) = (f64::from(rx).abs(), f64::from(ry).abs());
    if rx == 0.0 || ry == 0.0 {
        pb.line_to(p2[0], p2[1]);
        return;
    }
    if x1 == x2 && y1 == y2 {
        return;
    }
    let (sin_p, cos_p) = f64::from(rot_deg).to_radians().sin_cos();
    let (dx, dy) = ((x1 - x2) / 2.0, (y1 - y2) / 2.0);
    let x1p = cos_p * dx + sin_p * dy;
    let y1p = -sin_p * dx + cos_p * dy;
    let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if lambda > 1.0 {
        rx *= lambda.sqrt();
        ry *= lambda.sqrt();
    }
    let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let mut coef = if den > 0.0 { (num / den).max(0.0).sqrt() } else { 0.0 };
    if large == sweep {
        coef = -coef;
    }
    let cxp = coef * rx * y1p / ry;
    let cyp = -coef * ry * x1p / rx;
    let ccx = cos_p * cxp - sin_p * cyp + (x1 + x2) / 2.0;
    let ccy = sin_p * cxp + cos_p * cyp + (y1 + y2) / 2.0;
    let angle = |ux: f64, uy: f64, vx: f64, vy: f64| (ux * vy - uy * vx).atan2(ux * vx + uy * vy);
    let (ux, uy) = ((x1p - cxp) / rx, (y1p - cyp) / ry);
    let (vx, vy) = ((-x1p - cxp) / rx, (-y1p - cyp) / ry);
    let theta1 = angle(1.0, 0.0, ux, uy);
    let mut dtheta = angle(ux, uy, vx, vy);
    if !sweep && dtheta > 0.0 {
        dtheta -= std::f64::consts::TAU;
    } else if sweep && dtheta < 0.0 {
        dtheta += std::f64::consts::TAU;
    }
    let n = (dtheta.abs() / std::f64::consts::FRAC_PI_2).ceil().max(1.0);
    let delta = dtheta / n;
    let t = 4.0 / 3.0 * (delta / 4.0).tan();
    let map = |x: f64, y: f64| ((ccx + rx * x * cos_p - ry * y * sin_p) as f32, (ccy + rx * x * sin_p + ry * y * cos_p) as f32);
    let mut i = 0.0;
    while i < n {
        let a1 = theta1 + i * delta;
        let a2 = a1 + delta;
        let (s1, c1) = a1.sin_cos();
        let (s2, c2) = a2.sin_cos();
        let q1 = map(c1 - t * s1, s1 + t * c1);
        let q2 = map(c2 + t * s2, s2 - t * c2);
        let e = map(c2, s2);
        pb.cubic_to(q1.0, q1.1, q2.0, q2.1, e.0, e.1);
        i += 1.0;
    }
}

/// A mask of `path` under `t` (Canvas clip(): antialiased).
fn clip_mask(w: u32, h: u32, path: &tiny_skia::Path, t: Transform) -> Option<Mask> {
    let mut m = Mask::new(w, h)?;
    m.fill_path(path, FillRule::Winding, true, t);
    Some(m)
}

/// Canvas shadowBlur as Chrome turns it into a Gaussian (BlurRadiusToStdDev).
fn shadow_sigma(blur: f64) -> f64 {
    blur * 0.288_675 + 0.5
}

/// What Canvas 2D does for a shape drawn with a shadow: the shadow of `src`'s alpha (blurred,
/// offset in device pixels, `rgb` with alpha `alpha`) first, then `src`, both source-over `dst`.
fn draw_shadowed(dst: &mut Pixmap, src: &Pixmap, rgb: [u8; 3], alpha: f32, blur: f64, off: [f64; 2]) {
    let (w, h) = (src.width() as i64, src.height() as i64);
    let sd = src.data();
    // the drawn part of src
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, -1i64, -1i64);
    for y in 0..h {
        for x in 0..w {
            if sd[((y * w + x) * 4 + 3) as usize] != 0 {
                x0 = x0.min(x);
                x1 = x1.max(x);
                y0 = y0.min(y);
                y1 = y1.max(y);
            }
        }
    }
    if x1 < x0 {
        return;
    }
    let sigma = shadow_sigma(blur);
    let r = (3.0 * sigma).ceil() as i64;
    let kernel: Vec<f32> = {
        let k: Vec<f64> = (-r..=r).map(|i| (-((i * i) as f64) / (2.0 * sigma * sigma)).exp()).collect();
        let sum: f64 = k.iter().sum();
        k.iter().map(|v| (v / sum) as f32).collect()
    };
    // the alpha of the drawn part with room for the blur
    let (bx0, by0) = (x0 - r, y0 - r);
    let (bw, bh) = ((x1 - x0 + 1 + 2 * r) as usize, (y1 - y0 + 1 + 2 * r) as usize);
    let mut a = vec![0f32; bw * bh];
    for y in y0..=y1 {
        for x in x0..=x1 {
            a[((y - by0) as usize) * bw + (x - bx0) as usize] = f32::from(sd[((y * w + x) * 4 + 3) as usize]) / 255.0;
        }
    }
    let mut tmp = vec![0f32; bw * bh];
    for y in 0..bh {
        for x in 0..bw {
            let mut acc = 0.0;
            for (k, kv) in kernel.iter().enumerate() {
                let sx = x as i64 + k as i64 - r;
                if sx >= 0 && (sx as usize) < bw {
                    acc += a[y * bw + sx as usize] * kv;
                }
            }
            tmp[y * bw + x] = acc;
        }
    }
    for y in 0..bh {
        for x in 0..bw {
            let mut acc = 0.0;
            for (k, kv) in kernel.iter().enumerate() {
                let sy = y as i64 + k as i64 - r;
                if sy >= 0 && (sy as usize) < bh {
                    acc += tmp[sy as usize * bw + x] * kv;
                }
            }
            a[y * bw + x] = acc;
        }
    }
    // the shadow, source-over
    let (ox, oy) = (js_round(off[0]) as i64, js_round(off[1]) as i64);
    let (dw, dh) = (i64::from(dst.width()), i64::from(dst.height()));
    let dd = dst.data_mut();
    let col = [f32::from(rgb[0]) / 255.0, f32::from(rgb[1]) / 255.0, f32::from(rgb[2]) / 255.0];
    for y in 0..bh as i64 {
        let dy = by0 + y + oy;
        if dy < 0 || dy >= dh {
            continue;
        }
        for x in 0..bw as i64 {
            let dx = bx0 + x + ox;
            if dx < 0 || dx >= dw {
                continue;
            }
            let sa = a[(y as usize) * bw + x as usize] * alpha;
            if sa <= 0.0 {
                continue;
            }
            let i = ((dy * dw + dx) * 4) as usize;
            let inv = 1.0 - sa;
            for ch in 0..3 {
                dd[i + ch] = (col[ch] * sa * 255.0 + f32::from(dd[i + ch]) * inv).round().clamp(0.0, 255.0) as u8;
            }
            dd[i + 3] = (sa * 255.0 + f32::from(dd[i + 3]) * inv).round().clamp(0.0, 255.0) as u8;
        }
    }
    // then the shape itself
    over(dst, src);
}

/// src over dst (premultiplied, same size)
fn over(dst: &mut Pixmap, src: &Pixmap) {
    for (d, s) in dst.data_mut().as_chunks_mut::<4>().0.iter_mut().zip(src.data().as_chunks::<4>().0) {
        let sa = u32::from(s[3]);
        if sa == 0 {
            continue;
        }
        if sa == 255 {
            *d = *s;
            continue;
        }
        let inv = 255 - sa;
        for ch in 0..4 {
            let v = u32::from(d[ch]) * inv + 128;
            d[ch] = (u32::from(s[ch]) + ((v + (v >> 8)) >> 8)).min(255) as u8;
        }
    }
}

/// A font as cards.js setFont(): weight, size (px) and tracking (em, the letterSpacing rounded to
/// 0.01 px as toFixed(2)).
struct TextFont {
    font: Font,
    size: f64,
    spacing: f32,
}

impl TextFont {
    fn new(weight: u16, size: f64, tracking: f64) -> Self {
        let px = tracking * size;
        let px = px.signum() * (px.abs() * 100.0).round() / 100.0;
        let spacing = if size > 0.0 { (px / size) as f32 } else { 0.0 };
        Self { font: Font::new(FONT, size as f32, weight), size, spacing }
    }

    fn measure(&self, text: &str) -> f64 {
        if text.is_empty() || self.size < 1.0 {
            return 0.0;
        }
        f64::from(measure_text_spaced(text, &self.font, self.spacing))
    }
}

/// fillText with textBaseline alphabetic on the unturned card: the glyphs' coverage at whole pixels.
fn fill_text(pix: &mut Pixmap, text: &str, f: &TextFont, x: f64, y: f64, center: bool, rgb: [u8; 3]) {
    if text.is_empty() || f.size < 1.0 {
        return;
    }
    let (cw, ch, base, cov) = text_coverage_spaced(text, &f.font, f.spacing);
    let left = if center { x - f.measure(text) / 2.0 } else { x };
    let (left, top) = (js_round(left) as i64, js_round(y) as i64 - i64::from(base));
    let (pw, ph) = (i64::from(pix.width()), i64::from(pix.height()));
    let col = [f32::from(rgb[0]) / 255.0, f32::from(rgb[1]) / 255.0, f32::from(rgb[2]) / 255.0];
    let data = pix.data_mut();
    for cy in 0..i64::from(ch) {
        let dy = top + cy;
        if dy < 0 || dy >= ph {
            continue;
        }
        for cx in 0..i64::from(cw) {
            let dx = left + cx;
            let k = f32::from(cov.get((cy * i64::from(cw) + cx) as usize).copied().unwrap_or(0)) / 255.0;
            if k <= 0.0 || dx < 0 || dx >= pw {
                continue;
            }
            blend_px(data, ((dy * pw + dx) * 4) as usize, col, k);
        }
    }
}

/// source-over of a color with coverage k into a premultiplied pixel
fn blend_px(data: &mut [u8], i: usize, col: [f32; 3], k: f32) {
    let Some(p) = data.get_mut(i..i + 4) else { return };
    let inv = 1.0 - k;
    for ch in 0..3 {
        p[ch] = (col[ch] * k * 255.0 + f32::from(p[ch]) * inv).round().clamp(0.0, 255.0) as u8;
    }
    p[3] = (k * 255.0 + f32::from(p[3]) * inv).round().clamp(0.0, 255.0) as u8;
}

/// An affine map in f64 (Canvas translate/rotate), for the turned text.
#[derive(Clone, Copy)]
struct Affine {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
}

impl Affine {
    /// translate(cx, cy) then rotate(angle)
    fn turn(cx: f64, cy: f64, angle: f64) -> Self {
        let (s, c) = angle.sin_cos();
        Self { a: c, b: s, c: -s, d: c, e: cx, f: cy }
    }
    fn map(&self, x: f64, y: f64) -> (f64, f64) {
        (self.a * x + self.c * y + self.e, self.b * x + self.d * y + self.f)
    }
    fn inverse(&self) -> Option<Self> {
        let det = self.a * self.d - self.b * self.c;
        if det.abs() < 1e-12 {
            return None;
        }
        let (a, b, c, d) = (self.d / det, -self.b / det, -self.c / det, self.a / det);
        Some(Self { a, b, c, d, e: -(a * self.e + c * self.f), f: -(b * self.e + d * self.f) })
    }
    fn sk(&self) -> Transform {
        Transform::from_row(self.a as f32, self.b as f32, self.c as f32, self.d as f32, self.e as f32, self.f as f32)
    }
}

/// fillText on a turned board (translate + rotate `t`) at (x, y) in its frame: the glyphs at 4× their
/// size, sampled 4 × 4 per LED (as Chrome draws turned glyphs as outlines, not a turned bitmap).
#[allow(clippy::too_many_arguments)]
fn fill_text_turned(pix: &mut Pixmap, text: &str, f: &TextFont, x: f64, y: f64, center: bool, rgb: [u8; 3], t: Affine) {
    const SS: f64 = 4.0;
    if text.is_empty() || f.size < 1.0 {
        return;
    }
    let big = Font::new(FONT, (f.size * SS) as f32, f.font.weight);
    let (cw, ch, base, cov) = text_coverage_spaced(text, &big, f.spacing);
    let left = if center { x - f.measure(text) / 2.0 } else { x };
    let Some(inv) = t.inverse() else { return };
    // the box of the text in the board's frame, then on the canvas
    let (lx0, lx1) = (left, left + f64::from(cw) / SS);
    let (ly0, ly1) = (y - f64::from(base) / SS, y + f64::from(ch as i32 - base) / SS);
    let corners = [t.map(lx0, ly0), t.map(lx1, ly0), t.map(lx0, ly1), t.map(lx1, ly1)];
    let (pw, ph) = (i64::from(pix.width()), i64::from(pix.height()));
    let bx0 = corners.iter().map(|p| p.0).fold(f64::INFINITY, f64::min).floor().max(0.0) as i64;
    let bx1 = (corners.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max).ceil() as i64).min(pw - 1);
    let by0 = corners.iter().map(|p| p.1).fold(f64::INFINITY, f64::min).floor().max(0.0) as i64;
    let by1 = (corners.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max).ceil() as i64).min(ph - 1);
    let col = [f32::from(rgb[0]) / 255.0, f32::from(rgb[1]) / 255.0, f32::from(rgb[2]) / 255.0];
    let (cw, ch) = (i64::from(cw), i64::from(ch));
    let data = pix.data_mut();
    for py in by0..=by1 {
        for pxx in bx0..=bx1 {
            let mut acc = 0u32;
            for j in 0..4 {
                for i in 0..4 {
                    let (lx, ly) = inv.map(pxx as f64 + (f64::from(i) + 0.5) / 4.0, py as f64 + (f64::from(j) + 0.5) / 4.0);
                    let sx = ((lx - left) * SS).floor() as i64;
                    let sy = ((ly - y) * SS + f64::from(base)).floor() as i64;
                    if sx >= 0 && sx < cw && sy >= 0 && sy < ch {
                        acc += u32::from(cov.get((sy * cw + sx) as usize).copied().unwrap_or(0));
                    }
                }
            }
            if acc > 0 {
                blend_px(data, ((py * pw + pxx) * 4) as usize, col, acc as f32 / (16.0 * 255.0));
            }
        }
    }
}

/// a lucide icon (24 × 24) stroked at (x, y) with `size` px in the frame `t`
#[allow(clippy::too_many_arguments)]
fn icon(pix: &mut Pixmap, paths: &[&str], x: f64, y: f64, size: f64, col: &str, width: f32, t: Affine) {
    let tr = t.sk().pre_translate(x as f32, y as f32).pre_scale((size / 24.0) as f32, (size / 24.0) as f32);
    let stroke = Stroke { width, line_cap: LineCap::Round, line_join: LineJoin::Round, ..Default::default() };
    let p = solid(color(col, 1.0));
    for d in paths {
        if let Some(path) = svg_path(d) {
            pix.stroke_path(&path, &p, &stroke, tr, None);
        }
    }
}

/// Betula's mark: a white rounded square with the dark lenticels of a birch (32 × 32 grid).
fn betula_mark(pix: &mut Pixmap, x: f64, y: f64, size: f64, t: Affine) {
    let k = size / 32.0;
    let tr = t.sk();
    let (w, h) = (pix.width(), pix.height());
    let Some(path) = round_rect(x as f32, y as f32, size as f32, size as f32, (7.0 * k) as f32) else { return };
    pix.fill_path(&path, &solid(color(c::BARK, 1.0)), FillRule::Winding, tr, None);
    if let Some(mask) = clip_mask(w, h, &path, tr) {
        let ink = solid(color(c::BARK_INK, 1.0));
        for (mx, my, mw) in [(0.0, 7.0, 13.0), (23.0, 12.0, 9.0), (0.0, 17.0, 5.0), (17.0, 22.0, 15.0)] {
            if let Some(r) = Rect::from_xywh(js_round(x + mx * k) as f32, js_round(y + my * k) as f32, js_round(mw * k) as f32, js_round(3.0 * k).max(1.0) as f32) {
                pix.fill_rect(r, &ink, tr, Some(&mask));
            }
        }
    }
    if let Some(path) = round_rect((x + 0.5) as f32, (y + 0.5) as f32, (size - 1.0) as f32, (size - 1.0) as f32, (7.0 * k) as f32) {
        let stroke = Stroke { width: 1.0, ..Default::default() };
        pix.stroke_path(&path, &solid(rgba(c::LINE_STRONG)), &stroke, tr, None);
    }
}

/// A panel: Betula's soft shadow, then the white face (nearly opaque) with its 1-LED line.
fn panel(pix: &mut Pixmap, r: [f64; 4], radius: f64, alpha: f64, s: f64) {
    let (w, h) = (pix.width(), pix.height());
    let [x, y, rw, rh] = r.map(|v| v as f32);
    let Some(path) = round_rect(x, y, rw, rh, radius as f32) else { return };
    // the black shape with Betula's shadow (rgba(15, 23, 42, 0.16), blur 14, y 6)
    if let Some(mut shape) = Pixmap::new(w, h) {
        shape.fill_path(&path, &solid(tiny_skia::Color::BLACK), FillRule::Winding, Transform::identity(), None);
        draw_shadowed(pix, &shape, [15, 23, 42], 0.16, 14.0 * s, [0.0, 6.0 * s]);
    }
    // the shadow stays outside: clear the inside, then fill it
    if let Some(mask) = clip_mask(w, h, &path, Transform::identity())
        && let Some(rect) = Rect::from_xywh(x - 2.0, y - 2.0, rw + 4.0, rh + 4.0)
    {
        let clear = Paint { blend_mode: tiny_skia::BlendMode::Clear, ..Default::default() };
        pix.fill_rect(rect, &clear, Transform::identity(), Some(&mask));
        let mut face = Paint::default();
        face.set_color(color(c::PANEL, alpha as f32));
        pix.fill_rect(rect, &face, Transform::identity(), Some(&mask));
    }
    if let Some(path) = round_rect(x + 0.5, y + 0.5, rw, rh, radius as f32) {
        let stroke = Stroke { width: 1.0, ..Default::default() };
        pix.stroke_path(&path, &solid(rgba(c::LINE_STRONG)), &stroke, Transform::identity(), None);
    }
}

/// A wooden board as pixel art into buf (u32 over an image of width cw) at (ox, oy): w × h,
/// chamfered corners (or an arrow tip on the right), bevel, outline, grain, a knot, and optionally
/// a smooth sunken field [x, y, w, h] (board coordinates) that keeps them out.
#[allow(clippy::too_many_arguments)]
fn board(buf: &mut [u32], cw: usize, ox: usize, oy: usize, w: f64, h: f64, r: &mut Mulberry, s: f64, field: Option<[f64; 4]>, arrow: bool, wp: &Wp) {
    let cut = js_round(3.0 * s).max(2.0);
    let tip = if arrow { js_round(h * 0.55) } else { 0.0 };
    let inside = |x: f64, y: f64| -> bool {
        if x < 0.0 || y < 0.0 || x >= w || y >= h {
            return false;
        }
        if arrow && x >= w - tip {
            return (y + 0.5 - h / 2.0).abs() <= ((w - x) * (h / 2.0)) / tip;
        }
        if x + y < cut || x + (h - 1.0 - y) < cut {
            return false;
        }
        if !arrow && (w - 1.0 - x + y < cut || w - 1.0 - x + (h - 1.0 - y) < cut) {
            return false;
        }
        true
    };
    let in_field = |x: f64, y: f64| field.is_some_and(|f| x >= f[0] && y >= f[1] && x < f[0] + f[2] && y < f[1] + f[3]);
    // grain: long wavy lines with gaps, knots away from the field
    struct Line {
        y: f64,
        f: f64,
        a: f64,
        ph: f64,
        gap: f64,
        c: u32,
    }
    let mut lines = Vec::new();
    let mut y = 2.0;
    while y < h - 2.0 {
        let f = 0.015 + r.next() * 0.03;
        let a = 0.6 + r.next() * 1.6;
        let ph = r.next() * TURN;
        let gap = r.next() * TURN;
        let c = if r.next() < 0.5 { wp.grain } else { wp.grain2 };
        lines.push(Line { y, f, a, ph, gap, c });
        y += 3.0 + r.next() * 4.0;
    }
    let mut knots: Vec<(f64, f64, f64)> = Vec::new();
    let mut k = 0;
    while k < 8 && knots.is_empty() {
        let kx = 10.0 + r.next() * (w - 20.0 - tip);
        let ky = 6.0 + r.next() * (h - 12.0);
        if !in_field(kx, ky) && !in_field(kx + 7.0, ky) && !in_field(kx - 7.0, ky) && !in_field(kx, ky + 5.0) && !in_field(kx, ky - 5.0) {
            knots.push((kx, ky, (2.2 + r.next() * 1.8) * s));
        }
        k += 1;
    }
    let (wi, hi) = (w.max(0.0) as usize, h.max(0.0) as usize);
    for yy in 0..hi {
        let y = yy as f64;
        for xx in 0..wi {
            let x = xx as f64;
            if !inside(x, y) {
                continue;
            }
            let mut c = wp.board;
            if !inside(x - 1.0, y) || !inside(x + 1.0, y) || !inside(x, y - 1.0) || !inside(x, y + 1.0) {
                c = wp.edge;
            } else if !inside(x - 2.0, y) || !inside(x, y - 2.0) {
                c = wp.light;
            } else if !inside(x + 2.0, y) || !inside(x, y + 2.0) {
                c = wp.shade;
            } else if let Some(f) = field.filter(|_| in_field(x, y)) {
                let (fx, fy) = (x - f[0], y - f[1]);
                c = if fx == 0.0 || fy == 0.0 {
                    wp.field_lo
                } else if fx == f[2] - 1.0 || fy == f[3] - 1.0 {
                    wp.field_hi
                } else {
                    wp.field
                };
            } else {
                for l in &lines {
                    let ly = l.y + (x * l.f + l.ph).sin() * l.a;
                    if (y - ly).abs() < 0.5 && (x * 0.11 + l.gap).sin() > -0.55 {
                        c = l.c;
                    }
                }
                for &(kx, ky, kr) in &knots {
                    let d = ((x - kx) / 1.6).hypot(y - ky);
                    if d < kr {
                        c = if d < kr * 0.45 { wp.edge } else { wp.knot };
                    } else if d < kr + 1.2 && (y - ky).abs() < kr {
                        c = wp.grain;
                    }
                }
            }
            if let Some(p) = buf.get_mut((oy + yy) * cw + ox + xx) {
                *p = c;
            }
        }
    }
}

/// A stake: a narrow upright piece of wood, outlined, with grain.
#[allow(clippy::too_many_arguments)]
fn stake(buf: &mut [u32], cw: usize, chh: usize, x0: f64, y0: f64, w: f64, r: &mut Mulberry, wp: &Wp) {
    let ph = r.next() * 6.0;
    let wi = w.max(0.0) as usize;
    for yy in (y0.max(0.0) as usize)..chh {
        let y = yy as f64;
        for xx in 0..wi {
            let x = xx as f64;
            let c = if xx == 0 || xx + 1 == wi {
                wp.edge
            } else if xx == 1 {
                wp.light
            } else if xx + 2 == wi {
                wp.shade
            } else if (x - (w / 2.0 + (y * 0.05 + ph).sin() * w * 0.25)).abs() < 0.5 && (y * 0.2 + ph).sin() > -0.4 {
                wp.stake_grain
            } else {
                wp.stake
            };
            let xi = x0 + x;
            if xi >= 0.0
                && (xi as usize) < cw
                && let Some(p) = buf.get_mut(yy * cw + xi as usize)
            {
                *p = c;
            }
        }
    }
}

/// u32 pixels (opaque or 0) as a pixmap
fn pixmap_of(buf: &[u32], w: usize, h: usize) -> Option<Pixmap> {
    let mut p = Pixmap::new(w as u32, h as u32)?;
    p.data_mut().copy_from_slice(bytemuck::cast_slice(buf));
    Some(p)
}

/// Draws a sign image turned by `angle` around (cx, cy) (its board's middle at ax, ay), crisp
/// (nearest neighbour, antialiased edges), with its shadow (rgba(15, 23, 42, 0.2), blur 12, 3/5).
#[allow(clippy::too_many_arguments)]
fn place_turned(dst: &mut Pixmap, scratch: &mut Pixmap, img: &Pixmap, cx: f64, cy: f64, ax: f64, ay: f64, angle: f64, s: f64) {
    scratch.fill(tiny_skia::Color::TRANSPARENT);
    let t = Affine::turn(cx, cy, angle).sk().pre_translate(-ax as f32, -ay as f32);
    let pattern = Pattern::new(img.as_ref(), SpreadMode::Pad, FilterQuality::Nearest, 1.0, Transform::identity());
    let p = Paint { shader: pattern, anti_alias: true, ..Default::default() };
    if let Some(r) = Rect::from_xywh(0.0, 0.0, img.width() as f32, img.height() as f32) {
        scratch.fill_rect(r, &p, t, None);
    }
    draw_shadowed(dst, scratch, [15, 23, 42], 0.2, 12.0 * s, [3.0 * s, 5.0 * s]);
}

/// Splits `text` into lines no wider than max_w.
fn wrap(text: &str, max_w: f64, f: &TextFont) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        let next = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
        if !line.is_empty() && f.measure(&next) > max_w {
            lines.push(std::mem::replace(&mut line, word.to_string()));
        } else {
            line = next;
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

/// cards.js draw(): both layers for the spec.
pub fn paint(d: &CardsSpec) -> Cards {
    let l = &d.layout;
    let (w, h) = (l.w.max(1.0) as u32, l.h.max(1.0) as u32);
    let s = l.s;
    let (Some(mut hero_pix), Some(mut signs), Some(mut scratch)) = (Pixmap::new(w, h), Pixmap::new(w, h), Pixmap::new(w, h)) else {
        return Cards { pixels: vec![0; (w * h * 8) as usize], hero: [l.hero[0], l.hero[1], 0.0, 0.0] };
    };
    let wp = Wp::new();
    let none = Affine::turn(0.0, 0.0, 0.0);

    // ---- the contact card: measure first, then draw
    let pad = js_round(20.0 * s);
    let (sz_eyebrow, sz_name, sz_lead, sz_row, sz_icon) = (js_round(11.5 * s), js_round(33.0 * s), js_round(15.0 * s), js_round(15.0 * s), js_round(16.0 * s));
    let f_name = TextFont::new(600, sz_name, -0.032);
    let name_w = f_name.measure(&d.name);
    let f_row = TextFont::new(500, sz_row, -0.006);
    let row_w = f_row.measure(&d.mail).max(f_row.measure(&d.phone)) + sz_icon + 10.0 * s;
    let inner = name_w.max(row_w).max(200.0 * s).ceil();
    let f_lead = TextFont::new(500, sz_lead, -0.011);
    let lead_lines = if d.lead.is_empty() { Vec::new() } else { wrap(&d.lead, inner, &f_lead) };
    let line_lead = js_round(sz_lead * 1.4);
    let rows: Vec<(&[&str], &str)> = [(&MAIL[..], d.mail.as_str()), (&PHONE[..], d.phone.as_str())].into_iter().filter(|(_, t)| !t.is_empty()).collect();
    let line_row = js_round(sz_row * 1.65);
    let mut hh = pad;
    if !d.eyebrow.is_empty() {
        hh += sz_eyebrow + js_round(12.0 * s);
    }
    hh += js_round(sz_name * 0.94);
    if !lead_lines.is_empty() {
        hh += js_round(10.0 * s) + lead_lines.len() as f64 * line_lead - js_round(line_lead - sz_lead * 0.9);
    }
    if !rows.is_empty() {
        hh += js_round(16.0 * s) + 1.0 + js_round(12.0 * s) + rows.len() as f64 * line_row - js_round(line_row - sz_row * 1.05);
    }
    hh += pad;
    let hero = [l.hero[0], l.hero[1], inner + 2.0 * pad, hh];
    panel(&mut hero_pix, hero, 9.0 * s, d.alpha, s);
    let x0 = hero[0] + pad;
    let mut y = hero[1] + pad;
    if !d.eyebrow.is_empty() {
        // the small uppercase label in the accent, with Betula's green dot
        y += sz_eyebrow;
        if let Some(dot) = PathBuilder::from_circle((x0 + 3.0 * s) as f32, (y - sz_eyebrow * 0.36) as f32, (3.0 * s) as f32) {
            hero_pix.fill_path(&dot, &solid(color(c::ACCENT, 1.0)), FillRule::Winding, Transform::identity(), None);
        }
        let f = TextFont::new(600, sz_eyebrow, 0.1);
        fill_text(&mut hero_pix, &d.eyebrow.to_uppercase(), &f, x0 + 11.0 * s, y, false, rgb8(c::ACCENT_INK));
        y += js_round(12.0 * s);
    }
    y += js_round(sz_name * 0.94) - js_round(sz_name * 0.2);
    fill_text(&mut hero_pix, &d.name, &f_name, x0 - js_round(1.5 * s), y, false, rgb8(c::TEXT));
    y += js_round(sz_name * 0.2);
    if !lead_lines.is_empty() {
        y += js_round(10.0 * s) + js_round(sz_lead * 0.9);
        for (i, line) in lead_lines.iter().enumerate() {
            fill_text(&mut hero_pix, line, &f_lead, x0, y + i as f64 * line_lead, false, rgb8(c::TEXT2));
        }
        y += (lead_lines.len() - 1) as f64 * line_lead;
    }
    if !rows.is_empty() {
        y += js_round(16.0 * s);
        if let Some(r) = Rect::from_xywh(x0 as f32, y as f32, inner as f32, 1.0) {
            hero_pix.fill_rect(r, &solid(rgba(c::LINE)), Transform::identity(), None);
        }
        y += 1.0 + js_round(12.0 * s);
        for (i, (ic, text)) in rows.iter().enumerate() {
            let base = y + js_round(sz_row * 1.05) + i as f64 * line_row - js_round(sz_row * 0.15);
            icon(&mut hero_pix, ic, x0, base - sz_row * 0.78 - (sz_icon - sz_row * 0.78) / 2.0, sz_icon, c::ACCENT, 2.0, none);
            fill_text(&mut hero_pix, text, &f_row, x0 + sz_icon + js_round(10.0 * s), base, false, rgb8(c::TEXT));
        }
    }

    // ---- the signpost: a wooden arrow on a stake (from here on: the signs' layer)
    let mut r = Mulberry::new(4711);
    let p = &l.post;
    if !d.title.is_empty() {
        let sw = js_round(6.0 * s);
        let len = l.h - p.y + js_round(40.0 * s);
        let (cw, chh) = (p.w.max(1.0) as usize, (p.h + len).max(1.0) as usize);
        let mut buf = vec![0u32; cw * chh];
        let sx = js_round(p.w * 0.38);
        stake(&mut buf, cw, chh, sx, js_round(p.h * 0.3), sw, &mut r, &wp);
        board(&mut buf, cw, 0, 0, p.w, p.h, &mut r, s, None, true, &wp);
        for ny in [0.3, 0.7] {
            if let Some(px) = buf.get_mut(js_round(p.h * ny) as usize * cw + (sx + js_round(sw / 2.0)) as usize) {
                *px = wp.nail;
            }
        }
        let (cx, cy) = (p.x + p.w / 2.0, p.y + p.h / 2.0);
        if let Some(img) = pixmap_of(&buf, cw, chh) {
            place_turned(&mut signs, &mut scratch, &img, cx, cy, p.w / 2.0, p.h / 2.0, p.angle, s);
        }
        let mut ts = js_round(12.0 * s);
        let mut f = TextFont::new(650, ts, -0.01);
        let max_w = p.w - p.h * 0.55 - 20.0 * s;
        let tw = f.measure(&d.title);
        if tw > max_w {
            ts = (ts * max_w / tw).floor();
            f = TextFont::new(650, ts, -0.01);
        }
        fill_text_turned(&mut signs, &d.title, &f, -p.w / 2.0 + 12.0 * s, js_round(ts * 0.36), false, rgb8(wood::PAINT), Affine::turn(cx, cy, p.angle));
    }

    // ---- the signs: boards on two stakes, the code on a smooth light field
    for (code, g) in d.codes.iter().zip(&l.signs) {
        let (bw, bh, frame, label_h, quiet) = (g.bw, g.bh, g.frame, g.label_h, g.quiet);
        let sw = js_round(7.0 * s);
        let len = js_round(l.h - (g.cy + bh / 2.0) + 40.0 * s);
        let (cw, chh) = (bw.max(1.0) as usize, (bh + len).max(1.0) as usize);
        let mut buf = vec![0u32; cw * chh];
        let stakes = [js_round(bw * 0.24 - sw / 2.0), js_round(bw * 0.76 - sw / 2.0)];
        for sx in stakes {
            stake(&mut buf, cw, chh, sx, js_round(bh * 0.25), sw, &mut r, &wp);
        }
        let field = [frame, frame + label_h, g.code_size + 2.0 * quiet, g.code_size + 2.0 * quiet];
        board(&mut buf, cw, 0, 0, bw, bh, &mut r, s, Some(field), false, &wp);
        // nails where the stakes are behind the board
        for sx in stakes {
            for ny in [frame * 0.5, bh - frame * 0.55] {
                if let Some(px) = buf.get_mut(js_round(ny) as usize * cw + (sx + js_round(sw / 2.0)) as usize) {
                    *px = wp.nail;
                }
            }
        }
        // the code
        let (qx, qy) = ((field[0] + quiet) as usize, (field[1] + quiet) as usize);
        let m = g.code_mod as usize;
        let n = code.qr.size;
        for yy in 0..n {
            for xx in 0..n {
                if !code.qr.get(xx, yy) {
                    continue;
                }
                for py in 0..m {
                    let row = (qy + yy * m + py) * cw;
                    if let Some(span) = buf.get_mut(row + qx + xx * m..row + qx + (xx + 1) * m) {
                        span.fill(wp.ink);
                    }
                }
            }
        }
        if let Some(img) = pixmap_of(&buf, cw, chh) {
            place_turned(&mut signs, &mut scratch, &img, g.cx, g.cy, bw / 2.0, bh / 2.0, g.angle, s);
        }

        // the label painted on the board: Betula's mark or an icon, the name, the small line below
        let t = Affine::turn(g.cx, g.cy, g.angle);
        let mut ls = js_round(13.5 * s);
        let ms = if code.mark || code.github { js_round(14.0 * s) } else { 0.0 };
        let mg = if ms > 0.0 { js_round(5.0 * s) } else { 0.0 };
        let mut f = TextFont::new(650, ls, -0.012);
        let max_w = bw - 2.0 * frame - 6.0 * s;
        let mut lw = f.measure(&code.label);
        if lw + ms + mg > max_w {
            ls = (ls * (max_w - ms - mg) / lw).floor();
            f = TextFont::new(650, ls, -0.012);
            lw = f.measure(&code.label);
        }
        let lx = js_round(-(ms + mg + lw) / 2.0);
        let ly = js_round(-bh / 2.0 + frame + ls);
        let my = js_round(ly - ls * 0.72 - (ms - ls * 0.72) / 2.0);
        if code.mark {
            betula_mark(&mut signs, lx, my, ms, t);
        } else if code.github {
            icon(&mut signs, &GITHUB, lx, my, ms, wood::PAINT, 2.2, t);
        }
        fill_text_turned(&mut signs, &code.label, &f, lx + ms + mg, ly, false, rgb8(wood::PAINT), t);
        if !code.small.is_empty() {
            let mut ss = js_round(10.5 * s);
            let mut fs = TextFont::new(550, ss, 0.0);
            let sw2 = fs.measure(&code.small);
            if sw2 > max_w {
                ss = (ss * max_w / sw2).floor();
                fs = TextFont::new(550, ss, 0.0);
            }
            fill_text_turned(&mut signs, &code.small, &fs, 0.0, ly + js_round(12.5 * s), true, rgb8(wood::PAINT2), t);
        }
    }

    let mut pixels = hero_pix.take();
    pixels.extend_from_slice(signs.data());
    Cards { pixels, hero }
}
