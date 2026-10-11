//! What the browser scene drew with Canvas 2D: the logo's letter cells (panel.js letterCells), the
//! overlay's fixed layer (headline and QR card, overlay.js) and the sublines, plus the QR code
//! (qr.js). Fonts are slow: the setup paints everything once, later a background thread repaints
//! what a param changed, and frame() only uploads the result.

use std::mem::discriminant;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};

use tiny_skia::{FillRule, Paint, PathBuilder, Pixmap, PixmapPaint, Transform};

use crate::canvas::{Canvas, Font, Rgba, measure_text, text_coverage};

use super::{FONT, js_round};

/// the buttons on modern-events.de
const YELLOW: &str = "#fbbf24";
const INK: &str = "#0b1020";

// ---------- QR code ----------

/// A QR code as qr.js makes it: encodeQr(text, 'M').
pub struct QrCode {
    pub size: usize,
    dark: Vec<bool>,
}

impl QrCode {
    /// true = dark module
    pub fn get(&self, x: usize, y: usize) -> bool {
        x < self.size && y < self.size && self.dark.get(y * self.size + x).copied().unwrap_or(false)
    }
}

/// encodeQr(text, 'M') of qr.js. qrcodegen is Nayuki's algorithm as qr.js (byte mode, the error
/// correction raised while the version stays), but qr.js picks the mask with its own penalty: it
/// counts finder-like patterns only inside the code, Nayuki's also against the quiet zone. With
/// qr.js's penalty the same text gives the same picture as in the browser (common::qr keeps
/// Nayuki's choice, another mask for about a quarter of all texts).
fn encode(text: &str) -> Option<QrCode> {
    use qrcodegen::{Mask, QrCodeEcc, QrSegment, Version};
    let segs = [QrSegment::make_bytes(text.as_bytes())];
    let mut best: Option<(i64, QrCode)> = None;
    for m in 0..8u8 {
        let code = qrcodegen::QrCode::encode_segments_advanced(&segs, QrCodeEcc::Medium, Version::MIN, Version::MAX, Some(Mask::new(m)), true).ok()?;
        let size = usize::try_from(code.size()).ok()?;
        let dark: Vec<bool> = (0..size * size).map(|i| code.get_module((i % size) as i32, (i / size) as i32)).collect();
        let score = penalty(&dark, size);
        // the first mask with the lowest penalty, as qr.js
        if best.as_ref().is_none_or(|(b, _)| score < *b) {
            best = Some((score, QrCode { size, dark }));
        }
    }
    best.map(|(_, q)| q)
}

/// The code for `url` as overlay.js code(): ' ' for an empty one or one too long.
pub fn qr_code(url: &str) -> QrCode {
    encode(if url.is_empty() { " " } else { url }).or_else(|| encode(" ")).unwrap_or(QrCode { size: 21, dark: vec![false; 21 * 21] })
}

/// qr.js penalty (ISO 18004 7.8.3): runs, finder-like patterns, 2x2 blocks, dark balance.
fn penalty(dark: &[bool], size: usize) -> i64 {
    const FINDER: [[bool; 11]; 2] = [
        [true, false, true, true, true, false, true, false, false, false, false],
        [false, false, false, false, true, false, true, true, true, false, true],
    ];
    let at = |x: usize, y: usize| dark.get(y * size + x).copied().unwrap_or(false);
    let mut p = 0i64;
    let mut line = vec![false; size];
    for pass in 0..2 {
        for a in 0..size {
            for (b, v) in line.iter_mut().enumerate() {
                *v = if pass == 1 { at(a, b) } else { at(b, a) };
            }
            let mut run = 1i64;
            for b in 1..=size {
                if b < size && line[b] == line[b - 1] {
                    run += 1;
                } else {
                    if run >= 5 {
                        p += 3 + run - 5;
                    }
                    run = 1;
                }
            }
            // every occurrence, overlapping ones too (indexOf from k + 1)
            for pat in &FINDER {
                p += 40 * line.windows(11).filter(|w| *w == pat).count() as i64;
            }
        }
    }
    for y in 0..size.saturating_sub(1) {
        for x in 0..size - 1 {
            let c = at(x, y);
            if c == at(x + 1, y) && c == at(x, y + 1) && c == at(x + 1, y + 1) {
                p += 3;
            }
        }
    }
    let n = dark.iter().filter(|d| **d).count() as i64;
    let total = (size * size).max(1) as i64;
    p += (((n * 20 - total * 10).abs() + total - 1) / total - 1) * 10;
    p
}

// ---------- the logo's letters ----------

/// The letter cells a panel needs: grid and text.
#[derive(Clone, PartialEq, Debug)]
pub struct LetterSpec {
    pub cols: usize,
    pub rows: usize,
    pub text: String,
}

/// letterCells() of panel.js: which cells of a cols x rows grid the text covers (8x supersampled
/// coverage > 0.42). The text is condensed sideways (squeeze) so that its letters get more rows:
/// a long one-line logo is limited by the width, and 10 rows read much better than 8.
pub fn letter_cells(s: &LetterSpec) -> Vec<u8> {
    const S: f32 = 8.0;
    const SQUEEZE: f32 = 0.74;
    const CAP: f32 = 0.72;
    let (cols, rows) = (s.cols, s.rows);
    let mut out = vec![0u8; cols * rows];
    let (cw, ch) = (cols as f32 * S, rows as f32 * S);
    if cols == 0 || rows == 0 || s.text.is_empty() {
        return out;
    }
    // the largest size that fits: 86 % of the width, cap height 62 % of the height
    let size0 = ch;
    let w_fit = cw * 0.86 / (measure_text(&s.text, &Font::new(FONT, size0, 900)) * SQUEEZE).max(1.0);
    let h_fit = ch * 0.62 / (size0 * CAP);
    let size = (size0 * w_fit.min(h_fit)).floor();
    if size < 1.0 {
        return out;
    }
    let font = Font::new(FONT, size, 900);
    let tw = measure_text(&s.text, &font);
    let (w, h, base, cov) = text_coverage(&s.text, &font);
    let (w, h) = (w as usize, h as usize);
    // centered at cols * S / 2 after the squeeze, the baseline so that the caps sit in the middle
    let left = cw / 2.0 - SQUEEZE * tw / 2.0;
    let top = ch / 2.0 + size * CAP / 2.0 - base as f32;
    // every coverage pixel adds its area (squeezed) to the cells it falls on
    let mut sum = vec![0f32; cols * rows];
    for py in 0..h {
        let (y0, y1) = (top + py as f32, top + py as f32 + 1.0);
        let (ry0, ry1) = ((y0 / S).floor() as i64, ((y1 / S).ceil() as i64 - 1).max((y0 / S).floor() as i64));
        for px in 0..w {
            let a = cov.get(py * w + px).copied().unwrap_or(0);
            if a == 0 {
                continue;
            }
            let k = f32::from(a) / 255.0;
            let (x0, x1) = (left + SQUEEZE * px as f32, left + SQUEEZE * (px + 1) as f32);
            let (rx0, rx1) = ((x0 / S).floor() as i64, ((x1 / S).ceil() as i64 - 1).max((x0 / S).floor() as i64));
            for ry in ry0..=ry1 {
                if ry < 0 || ry >= rows as i64 {
                    continue;
                }
                let oy = y1.min((ry + 1) as f32 * S) - y0.max(ry as f32 * S);
                for rx in rx0..=rx1 {
                    if rx < 0 || rx >= cols as i64 {
                        continue;
                    }
                    let ox = x1.min((rx + 1) as f32 * S) - x0.max(rx as f32 * S);
                    if ox > 0.0 && oy > 0.0 {
                        sum[ry as usize * cols + rx as usize] += k * ox * oy;
                    }
                }
            }
        }
    }
    for (o, s) in out.iter_mut().zip(&sum) {
        *o = u8::from(s / (S * S) > 0.42);
    }
    out
}

// ---------- outlined text ----------

/// A text with its outline: fill coverage and outline coverage (0..255) in one box; (pad, base) is
/// where the text's origin (left end of the baseline) lies in it.
struct Outlined {
    w: usize,
    h: usize,
    pad: i32,
    base: i32,
    fill: Vec<u8>,
    stroke: Vec<u8>,
}

/// strokeText with round joins: everything within line_width / 2 of the glyphs' outline. As
/// coverage: the text grown by that radius (every edge pixel stamps a soft disc).
fn outlined(text: &str, font: &Font, line_width: f32) -> Outlined {
    let (w, h, base, cov) = text_coverage(text, font);
    let (w, h) = (w as usize, h as usize);
    let r = line_width / 2.0;
    let pad = (r + 1.0).ceil() as i32;
    let p = pad as usize;
    let (ow, oh) = (w + 2 * p, h + 2 * p);
    let mut fill = vec![0u8; ow * oh];
    for y in 0..h {
        if let (Some(dst), Some(src)) = (fill.get_mut((y + p) * ow + p..(y + p) * ow + p + w), cov.get(y * w..(y + 1) * w)) {
            dst.copy_from_slice(src);
        }
    }
    let mut stroke = fill.clone();
    let mut disc: Vec<(isize, f32)> = Vec::new();
    for dy in -pad..=pad {
        for dx in -pad..=pad {
            let d = (dx as f32).hypot(dy as f32);
            if d < r + 1.0 {
                disc.push((dy as isize * ow as isize + dx as isize, d));
            }
        }
    }
    let full = |i: usize| fill.get(i).copied().unwrap_or(0) == 255;
    for y in p..p + h {
        for x in p..p + w {
            let i = y * ow + x;
            let c = fill[i];
            // inner pixels: an edge pixel nearer to every outside point stamps for them
            if c == 0 || (c == 255 && full(i - 1) && full(i + 1) && full(i - ow) && full(i + ow) && full(i - ow - 1) && full(i - ow + 1) && full(i + ow - 1) && full(i + ow + 1)) {
                continue;
            }
            let cf = f32::from(c) / 255.0;
            for &(off, d) in &disc {
                let v = r + cf - d;
                if v <= 0.0 {
                    continue;
                }
                let q = (i as isize + off) as usize;
                if let Some(s) = stroke.get_mut(q) {
                    *s = (*s).max((v.min(1.0) * 255.0).round() as u8);
                }
            }
        }
    }
    Outlined { w: ow, h: oh, pad, base: base + pad, fill, stroke }
}

/// Source-over of `rgb` with coverage (0..255) times `alpha` into a premultiplied pixmap, the
/// coverage's top left at (left, top).
#[allow(clippy::too_many_arguments)]
fn blend(pix: &mut Pixmap, cov: &[u8], w: usize, h: usize, left: i64, top: i64, rgb: [f32; 3], alpha: f32) {
    let (pw, ph) = (i64::from(pix.width()), i64::from(pix.height()));
    let data = pix.data_mut();
    for cy in 0..h {
        let dy = top + cy as i64;
        if dy < 0 || dy >= ph {
            continue;
        }
        for cx in 0..w {
            let dx = left + cx as i64;
            let k = f32::from(cov.get(cy * w + cx).copied().unwrap_or(0)) / 255.0 * alpha;
            if k <= 0.0 || dx < 0 || dx >= pw {
                continue;
            }
            let i = ((dy * pw + dx) * 4) as usize;
            let Some(px) = data.get_mut(i..i + 4) else { continue };
            for (ch, d) in px.iter_mut().enumerate() {
                let src = if ch < 3 { rgb[ch] } else { 1.0 };
                *d = (src * 255.0 * k + f32::from(*d) * (1.0 - k)).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
}

/// overlay.js outline(): the black outline (globalAlpha `alpha`), then the text in `rgb` over it,
/// with the text's origin at (x, y) (left, alphabetic baseline).
fn draw_outlined(pix: &mut Pixmap, o: &Outlined, x: f32, y: f32, rgb: [f32; 3], alpha: f32) {
    let left = x.round() as i64 - i64::from(o.pad);
    let top = y.round() as i64 - i64::from(o.base);
    blend(pix, &o.stroke, o.w, o.h, left, top, [0.0; 3], alpha);
    blend(pix, &o.fill, o.w, o.h, left, top, rgb, alpha);
}

/// fillText with textAlign center, textBaseline middle. Canvas 2D puts the baseline (ascent -
/// descent) / 2 below y, from the font's metrics. canvas.rs lays text out in a line of 1.25 size
/// with ascent + descent centered, so its baseline (base - pad) lies 0.625 size + (ascent -
/// descent) / 2 below the line's top; if that layout ever changes, Baseline::Middle's 0.3 size.
fn fill_text_middle(pix: &mut Pixmap, text: &str, font: &Font, x: f32, y: f32, rgb: [f32; 3]) {
    let (w, h, base, cov) = text_coverage(text, font);
    let tw = measure_text(text, font);
    let s = font.size;
    let pad = (s * 0.5).ceil() as i32;
    let middle = if h as i32 == (s * 1.6).ceil() as i32 + 2 * pad { (base - pad) as f32 - 0.625 * s } else { 0.3 * s };
    let left = (x - tw / 2.0).round() as i64;
    let top = (y + middle).round() as i64 - i64::from(base);
    blend(pix, &cov, w as usize, h as usize, left, top, rgb, 1.0);
}

/// overlay.js fit(): the font size at which `text` fits max_w.
fn fit(text: &str, size: f32, weight: u16, max_w: f32) -> f32 {
    if size < 1.0 || text.is_empty() {
        return size;
    }
    let w = measure_text(text, &Font::new(FONT, size, weight));
    if w > max_w { (size * max_w / w).floor() } else { size }
}

// ---------- the fixed layer: headline and QR card ----------

/// What the fixed layer shows (overlay.js: the layout and the texts).
#[derive(Clone)]
pub struct LayerSpec {
    pub w: u32,
    pub h: u32,
    pub text_x: f64,
    pub text_w: f64,
    pub head_size: f64,
    pub line1_y: f64,
    pub line2_y: f64,
    pub card_x: f64,
    pub card_y: f64,
    pub module: f64,
    pub bright: f64,
    pub line1: String,
    pub line2: String,
    pub label: String,
    pub url: String,
    pub qr: Arc<QrCode>,
}

/// The painted layer (premultiplied RGBA8) and where its card is.
pub struct Layer {
    pub w: u32,
    pub h: u32,
    pub pixels: Vec<u8>,
    /// x0, y0, x1, y1 (px)
    pub card: [f32; 4],
    pub ring_radius: f32,
}

/// overlay.js update(): the headline (white, then yellow; a black outline keeps it readable over
/// the people) and the QR card.
pub fn paint_layer(s: &LayerSpec) -> Layer {
    let mut cv = Canvas::new(s.w, s.h);
    let (text_w, head) = (s.text_w as f32, s.head_size as f32);
    let hs = fit(&s.line1, head, 800, text_w).min(fit(&s.line2, head, 800, text_w));
    for (text, y, color) in [(&s.line1, s.line1_y, "#ffffff"), (&s.line2, s.line2_y, YELLOW)] {
        if text.is_empty() || hs < 1.0 {
            continue;
        }
        let o = outlined(text, &Font::new(FONT, hs, 800), (hs * 0.16).max(3.0));
        draw_outlined(&mut cv.pix, &o, s.text_x as f32, y as f32, crate::persons::hex_rgb(color), 1.0);
    }
    let card = paint_card(&s.qr, s.module, &s.label, s.bright);
    let (cw, ch, r) = (card.width() as f32, card.height() as f32, card.r);
    cv.pix.draw_pixmap(s.card_x as i32, s.card_y as i32, card.canvas.pix.as_ref(), &PixmapPaint::default(), Transform::identity(), None);
    let (x, y) = (s.card_x as f32, s.card_y as f32);
    Layer { w: s.w, h: s.h, pixels: cv.pix.take(), card: [x, y, x + cw, y + ch], ring_radius: r + 4.0 }
}

struct Card {
    canvas: Canvas,
    r: f32,
}

impl Card {
    fn width(&self) -> u32 {
        self.canvas.width()
    }
    fn height(&self) -> u32 {
        self.canvas.height()
    }
}

/// overlay.js drawCard(): yellow, rounded, the code with a 4-module quiet zone, the address below.
/// bright < 1 dims the yellow (LED walls are very bright; the dark modules keep their contrast).
fn paint_card(qr: &QrCode, module: f64, label: &str, bright: f64) -> Card {
    const QUIET: usize = 4;
    let side = (qr.size + QUIET * 2) as f64 * module;
    let label_h = js_round(module * 4.6);
    let (w, h) = (side, side + label_h);
    let r = js_round(module * 1.6) as f32;
    let mut cv = Canvas::new(w.max(1.0) as u32, h.max(1.0) as u32);
    let y = crate::persons::hex_rgb(YELLOW);
    let scaled = |c: f32| js_round(f64::from((c * 255.0).round()) * bright).clamp(0.0, 255.0) as u8;
    let mut paint = Paint::default();
    paint.set_color_rgba8(scaled(y[0]), scaled(y[1]), scaled(y[2]), 255);
    paint.anti_alias = true;
    if let Some(path) = round_rect(0.0, 0.0, w as f32, h as f32, r) {
        cv.pix.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
    }
    let m = module as f32;
    let ink = Rgba::hex(INK);
    for qy in 0..qr.size {
        for qx in 0..qr.size {
            if qr.get(qx, qy) {
                cv.fill_rect((qx + QUIET) as f32 * m, (qy + QUIET) as f32 * m, m, m, ink);
            }
        }
    }
    // the address under the code, inside the card (the quiet zone above it stays clear)
    let mut size = js_round(label_h * 0.62) as f32;
    let max_w = w as f32 - m * 3.0;
    if size >= 1.0 && !label.is_empty() {
        let tw = measure_text(label, &Font::new(FONT, size, 800));
        if tw > max_w {
            size = (size * max_w / tw).floor();
        }
        if size >= 1.0 {
            fill_text_middle(&mut cv.pix, label, &Font::new(FONT, size, 800), w as f32 / 2.0, (side - module * 0.9 + label_h / 2.0) as f32, crate::persons::hex_rgb(INK));
        }
    }
    Card { canvas: cv, r }
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

// ---------- the sublines ----------

/// What the sublines atlas holds: the param (split at |), the layout's size and width, and the
/// device's largest texture side.
#[derive(Clone, PartialEq, Debug)]
pub struct SubsSpec {
    pub src: String,
    pub size: f64,
    pub text_w: f64,
    pub max_side: u32,
}

/// A subline in the atlas: its slot's top left, and where its text's origin (left end of the
/// baseline) lies in the slot.
#[derive(Clone, Copy, Debug)]
pub struct Slot {
    pub at: [u32; 2],
    pub origin: [i32; 2],
}

/// Every subline once, with its outline: slots of `slot` px (columns of them if they do not fit
/// one), two bytes per pixel (fill, outline coverage). The shader draws the shown one with its
/// alpha and offset (main.js sublines()), so the change never repaints.
pub struct SubAtlas {
    pub w: u32,
    pub h: u32,
    pub slot: [u32; 2],
    pub data: Vec<u8>,
    pub slots: Vec<Slot>,
}

/// The sublines of the param (main.js: split at |, trimmed, empty ones dropped).
fn sub_list(src: &str) -> Vec<&str> {
    src.split('|').map(str::trim).filter(|s| !s.is_empty()).collect()
}

pub fn paint_subs(s: &SubsSpec) -> SubAtlas {
    let list = sub_list(&s.src);
    let sprites: Vec<Option<Outlined>> = list
        .iter()
        .map(|text| {
            let size = fit(text, s.size as f32, 600, s.text_w as f32);
            (size >= 1.0).then(|| outlined(text, &Font::new(FONT, size, 600), (size * 0.16).max(3.0)))
        })
        .collect();
    let max = s.max_side.max(64) as usize;
    let sw = sprites.iter().flatten().map(|o| o.w).max().unwrap_or(1).clamp(1, max);
    let sh = sprites.iter().flatten().map(|o| o.h).max().unwrap_or(1).clamp(1, max);
    // a column of slots as high as the device allows, more columns side by side if needed
    let per_col = (max / sh).max(1);
    let count = list.len().min(per_col * (max / sw).max(1));
    let (w, h) = (count.div_ceil(per_col).max(1) * sw, count.clamp(1, per_col) * sh);
    let mut data = vec![0u8; w * h * 2];
    let mut slots = Vec::with_capacity(count);
    for (i, o) in sprites.iter().take(count).enumerate() {
        let (ax, ay) = ((i / per_col) * sw, (i % per_col) * sh);
        let Some(o) = o else {
            slots.push(Slot { at: [ax as u32, ay as u32], origin: [0, 0] });
            continue;
        };
        for y in 0..o.h.min(sh) {
            for x in 0..o.w.min(sw) {
                let d = ((ay + y) * w + ax + x) * 2;
                if let (Some(px), Some(f), Some(st)) = (data.get_mut(d..d + 2), o.fill.get(y * o.w + x), o.stroke.get(y * o.w + x)) {
                    px[0] = *f;
                    px[1] = *st;
                }
            }
        }
        slots.push(Slot { at: [ax as u32, ay as u32], origin: [o.pad, o.base] });
    }
    SubAtlas { w: w as u32, h: h as u32, slot: [sw as u32, sh as u32], data, slots }
}

// ---------- the background painter ----------

pub enum Job {
    Letters(LetterSpec),
    Layer(Box<LayerSpec>),
    Subs(SubsSpec),
}

pub enum Done {
    Letters(LetterSpec, Vec<u8>),
    Layer(Layer),
    Subs(SubAtlas),
}

fn run(job: Job) -> Done {
    match job {
        Job::Letters(s) => {
            let cells = letter_cells(&s);
            Done::Letters(s, cells)
        }
        Job::Layer(s) => Done::Layer(paint_layer(&s)),
        Job::Subs(s) => Done::Subs(paint_subs(&s)),
    }
}

/// A thread per scene instance that paints what changed (it ends with the instance).
pub struct Painter {
    jobs: Sender<Job>,
    done: Receiver<Done>,
}

impl Painter {
    pub fn new(name: &str) -> Result<Self, String> {
        let (jobs, rx) = channel::<Job>();
        let (tx, done) = channel::<Done>();
        std::thread::Builder::new()
            .name(format!("{name} paint"))
            .spawn(move || {
                while let Ok(first) = rx.recv() {
                    // only the newest job of each kind (a glide asks for many)
                    let mut list = vec![first];
                    while let Ok(j) = rx.try_recv() {
                        list.retain(|k| discriminant(k) != discriminant(&j));
                        list.push(j);
                    }
                    for j in list {
                        if tx.send(run(j)).is_err() {
                            return;
                        }
                    }
                }
            })
            .map_err(|e| format!("Mal-Thread: {e}"))?;
        Ok(Self { jobs, done })
    }

    pub fn ask(&self, job: Job) {
        let _ = self.jobs.send(job);
    }

    pub fn poll(&self) -> Option<Done> {
        self.done.try_recv().ok()
    }
}
