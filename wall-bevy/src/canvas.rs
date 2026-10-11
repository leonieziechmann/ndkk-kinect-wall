//! A small Canvas 2D for the CPU (tiny-skia + cosmic-text): test images, text masks and the parts
//! of the browser scenes that were drawn with Canvas 2D. Pixels are premultiplied RGBA8, ready to
//! upload as a texture and blend with (One, OneMinusSrcAlpha).
//!
//! Fonts are the system's (Segoe UI, Verdana, Yu Gothic, ... on Windows, as in the browser),
//! loaded once in a background thread at start.

use std::sync::{Arc, OnceLock};

use cosmic_text::{Attrs, Buffer, Family, FontSystem, Metrics, Shaping, SwashCache, Weight};
use parking_lot::Mutex;
use tiny_skia::{FillRule, LineCap, Paint, PathBuilder, Pixmap, Rect, Shader, Stroke, StrokeDash, Transform};

pub use tiny_skia::Color as SkColor;

struct FontState {
    sys: FontSystem,
    cache: SwashCache,
    families: std::collections::HashMap<String, Option<String>>,
}

static FONTS: OnceLock<Arc<Mutex<Option<FontState>>>> = OnceLock::new();

fn fonts() -> Arc<Mutex<Option<FontState>>> {
    FONTS.get_or_init(|| Arc::new(Mutex::new(None))).clone()
}

/// Loads the system fonts in the background (call at start; text waits for it the first time).
pub fn preload_fonts() {
    let f = fonts();
    std::thread::spawn(move || {
        let mut g = f.lock();
        if g.is_none() {
            *g = Some(FontState { sys: FontSystem::new(), cache: SwashCache::new(), families: Default::default() });
        }
    });
}

fn with_fonts<T>(f: impl FnOnce(&mut FontState) -> T) -> T {
    let arc = fonts();
    let mut g = arc.lock();
    let st = g.get_or_insert_with(|| FontState { sys: FontSystem::new(), cache: SwashCache::new(), families: Default::default() });
    f(st)
}

/// A font as in CSS: families (first one present wins), size in px, weight 100..900.
#[derive(Clone, Debug)]
pub struct Font {
    pub families: String,
    pub size: f32,
    pub weight: u16,
}

impl Font {
    pub fn new(families: &str, size: f32, weight: u16) -> Self {
        Self { families: families.into(), size, weight }
    }
    pub fn sans(size: f32, weight: u16) -> Self {
        Self::new("system-ui, sans-serif", size, weight)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Left,
    Center,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Baseline {
    Top,
    Middle,
    Alphabetic,
    Bottom,
}

/// The first family of a CSS list that this system has (None: the generic sans-serif).
fn resolve_family(st: &mut FontState, list: &str) -> Option<String> {
    if let Some(r) = st.families.get(list) {
        return r.clone();
    }
    let mut found = None;
    for f in list.split(',') {
        let name = f.trim().trim_matches('"').trim_matches('\'');
        if name.is_empty() {
            continue;
        }
        let generic = matches!(name, "sans-serif" | "system-ui" | "serif" | "monospace" | "ui-monospace");
        if generic {
            break;
        }
        if st.sys.db().faces().any(|face| face.families.iter().any(|(n, _)| n.eq_ignore_ascii_case(name))) {
            found = Some(name.to_string());
            break;
        }
    }
    // the system's UI font where there is one (Windows: Segoe UI)
    if found.is_none() {
        for name in ["Segoe UI", "Inter", "DejaVu Sans", "Liberation Sans", "Arial"] {
            if st.sys.db().faces().any(|face| face.families.iter().any(|(n, _)| n == name)) {
                found = Some(name.to_string());
                break;
            }
        }
    }
    st.families.insert(list.to_string(), found.clone());
    found
}

/// A laid out text: its width and a callback over its pixels.
fn layout_text(st: &mut FontState, text: &str, font: &Font) -> Buffer {
    let fam = resolve_family(st, &font.families);
    let metrics = Metrics::new(font.size, font.size * 1.25);
    let mut buf = Buffer::new(&mut st.sys, metrics);
    buf.set_size(&mut st.sys, None, None);
    let attrs = match &fam {
        Some(f) => Attrs::new().family(Family::Name(f)).weight(Weight(font.weight)),
        None => Attrs::new().family(Family::SansSerif).weight(Weight(font.weight)),
    };
    buf.set_text(&mut st.sys, text, &attrs, Shaping::Advanced, None);
    buf.shape_until_scroll(&mut st.sys, false);
    buf
}

/// The width of `text` in px.
pub fn measure_text(text: &str, font: &Font) -> f32 {
    with_fonts(|st| {
        let buf = layout_text(st, text, font);
        buf.layout_runs().map(|r| r.line_w).fold(0.0, f32::max)
    })
}

/// Text as coverage (0..255) in a box from the baseline: (w, h, baseline y, pixels).
pub fn text_coverage(text: &str, font: &Font) -> (u32, u32, i32, Vec<u8>) {
    with_fonts(|st| {
        let buf = layout_text(st, text, font);
        let w = buf.layout_runs().map(|r| r.line_w).fold(0.0, f32::max).ceil() as i32 + 4;
        let line_y = buf.layout_runs().next().map(|r| r.line_y).unwrap_or(font.size);
        let pad = (font.size * 0.5).ceil() as i32;
        let h = (font.size * 1.6).ceil() as i32 + 2 * pad;
        let mut cov = vec![0u8; (w.max(1) * h.max(1)) as usize];
        let FontState { sys, cache, .. } = st;
        buf.draw(sys, cache, cosmic_text::Color::rgba(255, 255, 255, 255), |x, y, _, _, c| {
            let yy = y + pad;
            if x >= 0 && x < w && yy >= 0 && yy < h {
                let i = (yy * w + x) as usize;
                cov[i] = cov[i].max(c.a());
            }
        });
        (w.max(1) as u32, h.max(1) as u32, line_y.round() as i32 + pad, cov)
    })
}

/// RGBA color 0..1 with alpha.
#[derive(Clone, Copy, Debug)]
pub struct Rgba(pub f32, pub f32, pub f32, pub f32);

impl Rgba {
    pub fn hex(s: &str) -> Self {
        let c = crate::persons::hex_rgb(s);
        Rgba(c[0], c[1], c[2], 1.0)
    }
    pub fn rgb(c: [f32; 3]) -> Self {
        Rgba(c[0], c[1], c[2], 1.0)
    }
    pub fn a(self, a: f32) -> Self {
        Rgba(self.0, self.1, self.2, self.3 * a)
    }
    fn sk(self) -> SkColor {
        SkColor::from_rgba(self.0.clamp(0.0, 1.0), self.1.clamp(0.0, 1.0), self.2.clamp(0.0, 1.0), self.3.clamp(0.0, 1.0)).unwrap_or(SkColor::BLACK)
    }
}

pub struct Canvas {
    pub pix: Pixmap,
    pub alpha: f32,
    pub line_width: f32,
    pub cap: LineCap,
    pub dash: Vec<f32>,
}

impl Canvas {
    pub fn new(w: u32, h: u32) -> Self {
        Self { pix: Pixmap::new(w.max(1), h.max(1)).unwrap_or_else(|| Pixmap::new(1, 1).unwrap_or_else(|| unreachable!())), alpha: 1.0, line_width: 1.0, cap: LineCap::Butt, dash: Vec::new() }
    }

    pub fn width(&self) -> u32 {
        self.pix.width()
    }
    pub fn height(&self) -> u32 {
        self.pix.height()
    }

    /// premultiplied RGBA8
    pub fn data(&self) -> &[u8] {
        self.pix.data()
    }

    pub fn resize(&mut self, w: u32, h: u32) {
        if self.pix.width() != w || self.pix.height() != h {
            *self = Canvas::new(w, h);
        }
    }

    pub fn clear(&mut self) {
        self.pix.fill(SkColor::TRANSPARENT);
    }

    fn paint(&self, c: Rgba) -> Paint<'static> {
        let mut p = Paint::default();
        p.set_color(c.a(self.alpha).sk());
        p.anti_alias = true;
        p
    }

    pub fn fill_rect(&mut self, x: f32, y: f32, w: f32, h: f32, c: Rgba) {
        if let Some(r) = Rect::from_xywh(x, y, w, h) {
            let mut p = self.paint(c);
            p.anti_alias = false;
            self.pix.fill_rect(r, &p, Transform::identity(), None);
        }
    }

    pub fn fill_poly(&mut self, pts: &[(f32, f32)], c: Rgba) {
        let mut pb = PathBuilder::new();
        for (i, (x, y)) in pts.iter().enumerate() {
            if i == 0 { pb.move_to(*x, *y) } else { pb.line_to(*x, *y) }
        }
        pb.close();
        if let Some(path) = pb.finish() {
            self.pix.fill_path(&path, &self.paint(c), FillRule::Winding, Transform::identity(), None);
        }
    }

    fn stroke_style(&self) -> Stroke {
        let mut s = Stroke { width: self.line_width, line_cap: self.cap, ..Default::default() };
        if !self.dash.is_empty() {
            s.dash = StrokeDash::new(self.dash.clone(), 0.0);
        }
        s
    }

    pub fn line(&mut self, x0: f32, y0: f32, x1: f32, y1: f32, c: Rgba) {
        let mut pb = PathBuilder::new();
        pb.move_to(x0, y0);
        pb.line_to(x1, y1);
        if let Some(path) = pb.finish() {
            self.pix.stroke_path(&path, &self.paint(c), &self.stroke_style(), Transform::identity(), None);
        }
    }

    pub fn polyline(&mut self, pts: &[(f32, f32)], close: bool, c: Rgba) {
        let mut pb = PathBuilder::new();
        for (i, (x, y)) in pts.iter().enumerate() {
            if i == 0 { pb.move_to(*x, *y) } else { pb.line_to(*x, *y) }
        }
        if close {
            pb.close();
        }
        if let Some(path) = pb.finish() {
            self.pix.stroke_path(&path, &self.paint(c), &self.stroke_style(), Transform::identity(), None);
        }
    }

    /// arc from a0 to a1 (radians, clockwise on screen as Canvas 2D)
    fn arc_path(cx: f32, cy: f32, rx: f32, ry: f32, a0: f32, a1: f32) -> Option<tiny_skia::Path> {
        let mut pb = PathBuilder::new();
        let n = (((a1 - a0).abs() * rx.max(ry)).max(8.0) as usize).min(256);
        for i in 0..=n {
            let a = a0 + (a1 - a0) * i as f32 / n as f32;
            let (x, y) = (cx + rx * a.cos(), cy + ry * a.sin());
            if i == 0 { pb.move_to(x, y) } else { pb.line_to(x, y) }
        }
        pb.finish()
    }

    pub fn stroke_arc(&mut self, cx: f32, cy: f32, r: f32, a0: f32, a1: f32, c: Rgba) {
        if let Some(path) = Self::arc_path(cx, cy, r, r, a0, a1) {
            self.pix.stroke_path(&path, &self.paint(c), &self.stroke_style(), Transform::identity(), None);
        }
    }

    pub fn stroke_ellipse(&mut self, cx: f32, cy: f32, rx: f32, ry: f32, c: Rgba) {
        if let Some(path) = Self::arc_path(cx, cy, rx, ry, 0.0, std::f32::consts::TAU) {
            self.pix.stroke_path(&path, &self.paint(c), &self.stroke_style(), Transform::identity(), None);
        }
    }

    pub fn fill_circle(&mut self, cx: f32, cy: f32, r: f32, c: Rgba) {
        if let Some(path) = PathBuilder::from_circle(cx, cy, r.max(0.01)) {
            self.pix.fill_path(&path, &self.paint(c), FillRule::Winding, Transform::identity(), None);
        }
    }

    /// A horizontal linear gradient from `c0` at x0 to `c1` at x1, filling the rect.
    pub fn fill_rect_gradient_x(&mut self, x: f32, y: f32, w: f32, h: f32, x0: f32, x1: f32, c0: Rgba, c1: Rgba) {
        let Some(r) = Rect::from_xywh(x, y, w, h) else { return };
        let Some(sh) = tiny_skia::LinearGradient::new(
            tiny_skia::Point::from_xy(x0, 0.0),
            tiny_skia::Point::from_xy(x1, 0.0),
            vec![tiny_skia::GradientStop::new(0.0, c0.a(self.alpha).sk()), tiny_skia::GradientStop::new(1.0, c1.a(self.alpha).sk())],
            tiny_skia::SpreadMode::Pad,
            Transform::identity(),
        ) else {
            return;
        };
        let p = Paint { shader: sh, anti_alias: false, ..Default::default() };
        self.pix.fill_rect(r, &p, Transform::identity(), None);
    }

    /// Text as Canvas 2D fillText (max_width squeezes it like the browser does).
    pub fn fill_text(&mut self, text: &str, x: f32, y: f32, font: &Font, align: Align, baseline: Baseline, c: Rgba, max_width: Option<f32>) {
        if text.is_empty() {
            return;
        }
        let (w, h, base, cov) = text_coverage(text, font);
        let tw = measure_text(text, font);
        let squeeze = match max_width {
            Some(m) if tw > m && m > 0.0 => m / tw,
            _ => 1.0,
        };
        let shown_w = tw * squeeze;
        let left = match align {
            Align::Left => x,
            Align::Center => x - shown_w / 2.0,
            Align::Right => x - shown_w,
        };
        let s = font.size;
        let baseline_y = match baseline {
            Baseline::Alphabetic => y,
            Baseline::Top => y + 0.8 * s,
            Baseline::Middle => y + 0.3 * s,
            Baseline::Bottom => y - 0.2 * s,
        };
        let top = baseline_y - base as f32;
        let col = c.a(self.alpha);
        let (pw, ph) = (self.pix.width() as i32, self.pix.height() as i32);
        let data = self.pix.data_mut();
        for py in 0..h as i32 {
            let dy = (top + py as f32).round() as i32;
            if dy < 0 || dy >= ph {
                continue;
            }
            for px in 0..w as i32 {
                let a = cov[(py * w as i32 + px) as usize];
                if a == 0 {
                    continue;
                }
                let dx = (left + px as f32 * squeeze).round() as i32;
                if dx < 0 || dx >= pw {
                    continue;
                }
                let k = f32::from(a) / 255.0 * col.3;
                let i = ((dy * pw + dx) * 4) as usize;
                let inv = 1.0 - k;
                data[i] = (col.0 * k * 255.0 + f32::from(data[i]) * inv).round() as u8;
                data[i + 1] = (col.1 * k * 255.0 + f32::from(data[i + 1]) * inv).round() as u8;
                data[i + 2] = (col.2 * k * 255.0 + f32::from(data[i + 2]) * inv).round() as u8;
                data[i + 3] = (k * 255.0 + f32::from(data[i + 3]) * inv).round() as u8;
            }
        }
    }

    /// Wraps words to lines no wider than max_w (wall-output.js wrap()).
    pub fn wrap_text(&mut self, text: &str, x: f32, mut y: f32, max_w: f32, lh: f32, font: &Font, c: Rgba) {
        let mut line = String::new();
        for word in text.split_whitespace() {
            let t = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
            if measure_text(&t, font) > max_w && !line.is_empty() {
                self.fill_text(&line, x, y, font, Align::Left, Baseline::Top, c, None);
                y += lh;
                line = word.to_string();
            } else {
                line = t;
            }
        }
        if !line.is_empty() {
            self.fill_text(&line, x, y, font, Align::Left, Baseline::Top, c, None);
        }
    }
}

pub const SHADER_SOLID: fn(SkColor) -> Shader<'static> = Shader::SolidColor;
