//! Draw: the scenes' 2D painter, on the GPU. Shapes (rectangles with round corners, circles and
//! ellipses, lines, triangles and convex polygons), images and text, each with fill, outline and
//! glow, in LED pixels (origin top left, y down, as the browser's Canvas 2D). What a frame asks for
//! is collected and drawn at its end in one pass: one instance buffer, one draw call per run of the
//! same blend mode; the shapes are signed distance fields in the shader (smooth edges at any size).
//!
//! Text and images live in two atlas textures. A text is painted once (canvas.rs: the font, a
//! background box, a glow) and kept while it is used; an image is loaded once (load_image).

use std::collections::HashMap;

use glam::Vec2;

use crate::canvas::Font;
use crate::common::overlay::{LabelStyle, paint_label};
use crate::gpu::{Gpu, TARGET_FORMAT, layout};
use crate::scene::FrameCtx;

// ---------- colors and paints ----------

/// A color, straight alpha, 0..1 (as displayed on the LEDs).
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Color {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

pub const fn rgba(r: f32, g: f32, b: f32, a: f32) -> Color {
    Color { r, g, b, a }
}

pub const fn rgb(r: f32, g: f32, b: f32) -> Color {
    Color { r, g, b, a: 1.0 }
}

/// 0..255 channels.
pub fn rgb8(r: u8, g: u8, b: u8) -> Color {
    rgb(f32::from(r) / 255.0, f32::from(g) / 255.0, f32::from(b) / 255.0)
}

/// "#rgb", "#rrggbb" or "#rrggbbaa" (CSS); black if it is none of them.
pub fn hex(s: &str) -> Color {
    let h = s.trim().trim_start_matches('#');
    let n = |i: usize, l: usize| u8::from_str_radix(h.get(i..i + l).unwrap_or("0"), 16).unwrap_or(0);
    match h.len() {
        3 => rgb8(n(0, 1) * 17, n(1, 1) * 17, n(2, 1) * 17),
        8 => rgb8(n(0, 2), n(2, 2), n(4, 2)).alpha(f32::from(n(6, 2)) / 255.0),
        _ => rgb8(n(0, 2), n(2, 2), n(4, 2)),
    }
}

/// Hue (0..360), saturation and lightness (0..1), as CSS hsl().
pub fn hsl(h: f32, s: f32, l: f32) -> Color {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = h.rem_euclid(360.0) / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r, g, b) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    rgb(r + m, g + m, b + m)
}

impl Color {
    pub const WHITE: Color = rgb(1.0, 1.0, 1.0);
    pub const BLACK: Color = rgb(0.0, 0.0, 0.0);
    pub const NONE: Color = rgba(0.0, 0.0, 0.0, 0.0);
    pub const RED: Color = rgb(1.0, 0.24, 0.35);
    pub const GREEN: Color = rgb(0.24, 1.0, 0.48);
    pub const BLUE: Color = rgb(0.24, 0.5, 1.0);
    pub const YELLOW: Color = rgb(1.0, 0.82, 0.23);
    pub const CYAN: Color = rgb(0.24, 0.94, 1.0);
    pub const MAGENTA: Color = rgb(1.0, 0.3, 0.9);

    /// The same color with alpha `a`.
    pub fn alpha(self, a: f32) -> Color {
        Color { a, ..self }
    }

    /// The same color, its alpha times `k`.
    pub fn fade(self, k: f32) -> Color {
        Color { a: self.a * k, ..self }
    }

    /// Between self (t = 0) and `o` (t = 1).
    pub fn mix(self, o: Color, t: f32) -> Color {
        let m = |a: f32, b: f32| a + (b - a) * t;
        rgba(m(self.r, o.r), m(self.g, o.g), m(self.b, o.b), m(self.a, o.a))
    }

    /// From [r, g, b] (persons' colors, params).
    pub fn from_rgb(c: [f32; 3]) -> Color {
        rgb(c[0], c[1], c[2])
    }

    fn premul(self) -> [f32; 4] {
        let a = self.a.clamp(0.0, 1.0);
        [self.r * a, self.g * a, self.b * a, a]
    }
}

/// How two colors combine.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Blend {
    /// over what is there (alpha)
    #[default]
    Normal,
    /// added to what is there (light, glow, neon)
    Add,
}

/// How a shape is painted: fill, outline (centred on the edge), glow around it, blend mode.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Paint {
    pub fill: Color,
    pub stroke: Color,
    pub stroke_width: f32,
    /// px: a soft halo in the outline's color (else the fill's)
    pub glow: f32,
    pub blend: Blend,
}

impl Paint {
    /// Filled with `c`.
    pub fn fill(c: Color) -> Paint {
        Paint { fill: c, stroke: Color::NONE, stroke_width: 0.0, glow: 0.0, blend: Blend::Normal }
    }

    /// Only the outline, `w` px wide.
    pub fn stroke(c: Color, w: f32) -> Paint {
        Paint { fill: Color::NONE, stroke: c, stroke_width: w, glow: 0.0, blend: Blend::Normal }
    }

    /// And an outline.
    pub fn outline(self, c: Color, w: f32) -> Paint {
        Paint { stroke: c, stroke_width: w, ..self }
    }

    /// And a glow of `px`.
    pub fn glow(self, px: f32) -> Paint {
        Paint { glow: px, ..self }
    }

    /// Added to what is there (light).
    pub fn add(self) -> Paint {
        Paint { blend: Blend::Add, ..self }
    }
}

impl From<Color> for Paint {
    fn from(c: Color) -> Paint {
        Paint::fill(c)
    }
}

// ---------- text ----------

/// Which point of a text's box (or an image) lies at the given position.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Anchor {
    TopLeft,
    Top,
    TopRight,
    Left,
    #[default]
    Center,
    Right,
    BottomLeft,
    Bottom,
    BottomRight,
}

impl Anchor {
    /// The anchor's place in a box of w × h, from its top left corner.
    fn offset(self, w: f32, h: f32) -> Vec2 {
        let (fx, fy) = match self {
            Anchor::TopLeft => (0.0, 0.0),
            Anchor::Top => (0.5, 0.0),
            Anchor::TopRight => (1.0, 0.0),
            Anchor::Left => (0.0, 0.5),
            Anchor::Center => (0.5, 0.5),
            Anchor::Right => (1.0, 0.5),
            Anchor::BottomLeft => (0.0, 1.0),
            Anchor::Bottom => (0.5, 1.0),
            Anchor::BottomRight => (1.0, 1.0),
        };
        Vec2::new(w * fx, h * fy)
    }
}

/// How a text looks: font, color, a background box, a glow (CSS text-shadow), its anchor.
#[derive(Clone, Debug)]
pub struct Text {
    pub font: Font,
    pub color: Color,
    pub anchor: Anchor,
    /// px blur radius in the text's color, 0 = none
    pub glow: f32,
    pub background: Option<Color>,
    /// px around the text inside the box
    pub pad: [f32; 2],
    /// px corner radius of the box
    pub radius: f32,
    /// letter spacing (em)
    pub spacing: f32,
    /// line height (factor of the size)
    pub line_height: f32,
}

impl Text {
    /// White sans-serif text of `size` px, centred on its position.
    pub fn new(size: f32) -> Text {
        Text { font: Font::sans(size, 400), color: Color::WHITE, anchor: Anchor::Center, glow: 0.0, background: None, pad: [0.0, 0.0], radius: 0.0, spacing: 0.0, line_height: 1.2 }
    }
    pub fn bold(self) -> Text {
        self.weight(700)
    }
    pub fn weight(mut self, w: u16) -> Text {
        self.font = Font::new(&self.font.families, self.font.size, w);
        self
    }
    /// CSS font families ("Segoe UI, sans-serif").
    pub fn font(mut self, families: &str) -> Text {
        self.font = Font::new(families, self.font.size, self.font.weight);
        self
    }
    pub fn color(self, c: Color) -> Text {
        Text { color: c, ..self }
    }
    pub fn anchor(self, a: Anchor) -> Text {
        Text { anchor: a, ..self }
    }
    pub fn glow(self, px: f32) -> Text {
        Text { glow: px, ..self }
    }
    /// A box behind the text (with `pad` around it).
    pub fn background(self, c: Color) -> Text {
        Text { background: Some(c), ..self }
    }
    pub fn pad(self, x: f32, y: f32) -> Text {
        Text { pad: [x, y], ..self }
    }
    pub fn radius(self, r: f32) -> Text {
        Text { radius: r, ..self }
    }
    pub fn spacing(self, em: f32) -> Text {
        Text { spacing: em, ..self }
    }

    fn style(&self) -> LabelStyle {
        LabelStyle {
            font: self.font.clone(),
            spacing: self.spacing,
            line_height: self.line_height,
            pad: self.pad,
            radius: self.radius,
            background: self.background.map(|c| [c.r, c.g, c.b, c.a]),
            glow: self.glow,
        }
    }

    fn key(&self, text: &str) -> String {
        let c = |x: f32| (x.clamp(0.0, 1.0) * 255.0).round() as u8;
        let bg = self.background.map(|b| [c(b.r), c(b.g), c(b.b), c(b.a)]);
        format!(
            "{text}\u{1}{}\u{1}{}\u{1}{}\u{1}{:?}\u{1}{}\u{1}{:?}\u{1}{:?}\u{1}{}\u{1}{}\u{1}{}",
            self.font.families,
            self.font.size,
            self.font.weight,
            [c(self.color.r), c(self.color.g), c(self.color.b)],
            self.glow,
            bg,
            self.pad,
            self.radius,
            self.spacing,
            self.line_height
        )
    }
}

/// An image in the image atlas (Draw::load_image).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Image {
    id: u32,
    pub w: u32,
    pub h: u32,
}

// ---------- the atlases ----------

/// Shelves of a texture: rows of rectangles, 1 px apart.
struct Shelves {
    w: u32,
    h: u32,
    rows: Vec<[u32; 3]>,
    next_y: u32,
}

impl Shelves {
    fn new(w: u32, h: u32) -> Self {
        Self { w, h, rows: Vec::new(), next_y: 0 }
    }

    fn alloc(&mut self, w: u32, h: u32) -> Option<[u32; 2]> {
        if w + 1 > self.w || h + 1 > self.h {
            return None;
        }
        for r in &mut self.rows {
            // a row of about this height with room left
            if h <= r[1] && h * 2 + 4 >= r[1] && r[2] + w < self.w {
                let x = r[2];
                r[2] += w + 1;
                return Some([x, r[0]]);
            }
        }
        if self.next_y + h + 1 > self.h {
            return None;
        }
        let y = self.next_y;
        self.rows.push([y, h, w + 1]);
        self.next_y += h + 1;
        Some([0, y])
    }
}

struct Atlas {
    tex: wgpu::Texture,
    view: wgpu::TextureView,
    shelves: Shelves,
}

impl Atlas {
    fn new(gpu: &Gpu, label: &str, w: u32, h: u32) -> Self {
        let tex = gpu.texture(label, w, h, wgpu::TextureFormat::Rgba8Unorm, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST);
        let view = tex.create_view(&Default::default());
        Self { tex, view, shelves: Shelves::new(w, h) }
    }

    fn write(&self, gpu: &Gpu, at: [u32; 2], w: u32, h: u32, rgba: &[u8]) {
        gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &self.tex, mip_level: 0, origin: wgpu::Origin3d { x: at[0], y: at[1], z: 0 }, aspect: wgpu::TextureAspect::All },
            rgba,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * 4), rows_per_image: Some(h) },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
    }

    /// [u0, v0, u1, v1] of a rectangle in it
    fn uv(&self, at: [u32; 2], w: u32, h: u32) -> [f32; 4] {
        let (tw, th) = (self.shelves.w as f32, self.shelves.h as f32);
        [at[0] as f32 / tw, at[1] as f32 / th, (at[0] + w) as f32 / tw, (at[1] + h) as f32 / th]
    }
}

/// A painted text in the text atlas.
#[derive(Clone, Copy)]
struct TextSprite {
    uv: [f32; 4],
    /// sprite size and the box inside it (x, y, w, h)
    size: [f32; 2],
    frame: [f32; 4],
    /// the frame it was last drawn in
    used: u64,
}

struct ImageSlot {
    at: [u32; 2],
    w: u32,
    h: u32,
    /// premultiplied RGBA8 (kept to move it into a bigger atlas)
    px: Vec<u8>,
}

// ---------- the GPU side ----------

const KIND_RECT: f32 = 0.0;
const KIND_ELLIPSE: f32 = 1.0;
const KIND_SEGMENT: f32 = 2.0;
const KIND_TRI: f32 = 3.0;
const KIND_IMAGE: f32 = 4.0;

/// One shape: a, b, c by kind (see WGSL), fill and stroke premultiplied, p = [stroke width, glow, kind, image atlas].
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Inst {
    a: [f32; 4],
    b: [f32; 4],
    c: [f32; 4],
    fill: [f32; 4],
    stroke: [f32; 4],
    p: [f32; 4],
}

const WGSL: &str = r"
struct U { size: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var text_atlas: texture_2d<f32>;
@group(0) @binding(2) var image_atlas: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

struct I {
  @location(0) a: vec4f, @location(1) b: vec4f, @location(2) c: vec4f,
  @location(3) fill: vec4f, @location(4) stroke: vec4f, @location(5) p: vec4f,
};
struct V {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec2f,
  @location(1) @interpolate(flat) a: vec4f,
  @location(2) @interpolate(flat) b: vec4f,
  @location(3) @interpolate(flat) c: vec4f,
  @location(4) @interpolate(flat) fill: vec4f,
  @location(5) @interpolate(flat) stroke: vec4f,
  @location(6) @interpolate(flat) p: vec4f,
};

fn rot(v: vec2f, cs: vec2f) -> vec2f { return vec2f(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x); }

@vertex fn vs(@builtin(vertex_index) vi: u32, i: I) -> V {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let k = corners[vi];
  let pad = i.p.x * 0.5 + i.p.y * 2.5 + 1.5;
  let kind = i.p.z;
  var wp: vec2f;
  if (kind == 2.0) {
    let lo = min(i.a.xy, i.a.zw) - vec2f(i.b.x + pad);
    let hi = max(i.a.xy, i.a.zw) + vec2f(i.b.x + pad);
    wp = mix(lo, hi, k * 0.5 + 0.5);
  } else if (kind == 3.0) {
    let lo = min(min(i.a.xy, i.a.zw), i.b.xy) - vec2f(pad);
    let hi = max(max(i.a.xy, i.a.zw), i.b.xy) + vec2f(pad);
    wp = mix(lo, hi, k * 0.5 + 0.5);
  } else {
    wp = i.a.xy + rot(k * (i.a.zw + vec2f(pad)), i.b.xy);
  }
  var o: V;
  o.pos = vec4f(wp.x * u.size.z * 2.0 - 1.0, 1.0 - wp.y * u.size.w * 2.0, 0.0, 1.0);
  o.wp = wp;
  o.a = i.a; o.b = i.b; o.c = i.c; o.fill = i.fill; o.stroke = i.stroke; o.p = i.p;
  return o;
}

fn sd_box(p: vec2f, b: vec2f, r: f32) -> f32 {
  let rr = min(r, min(b.x, b.y));
  let q = abs(p) - b + vec2f(rr);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rr;
}
fn sd_ellipse(p: vec2f, ab: vec2f) -> f32 {
  if (abs(ab.x - ab.y) < 0.01) { return length(p) - ab.x; }
  let k0 = length(p / ab);
  let k1 = length(p / (ab * ab));
  if (k1 < 1e-6) { return -min(ab.x, ab.y); }
  return k0 * (k0 - 1.0) / k1;
}
fn sd_segment(p: vec2f, a: vec2f, b: vec2f, r: f32) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
fn sd_tri(p: vec2f, p0: vec2f, p1: vec2f, p2: vec2f) -> f32 {
  let e0 = p1 - p0; let e1 = p2 - p1; let e2 = p0 - p2;
  let v0 = p - p0; let v1 = p - p1; let v2 = p - p2;
  let pq0 = v0 - e0 * clamp(dot(v0, e0) / max(dot(e0, e0), 1e-6), 0.0, 1.0);
  let pq1 = v1 - e1 * clamp(dot(v1, e1) / max(dot(e1, e1), 1e-6), 0.0, 1.0);
  let pq2 = v2 - e2 * clamp(dot(v2, e2) / max(dot(e2, e2), 1e-6), 0.0, 1.0);
  let s = sign(e0.x * e2.y - e0.y * e2.x);
  let d = min(min(vec2f(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                  vec2f(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                  vec2f(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}

@fragment fn fs(v: V) -> @location(0) vec4f {
  let kind = v.p.z;
  var d: f32;
  var tex = vec4f(1.0);
  if (kind == 2.0) {
    d = sd_segment(v.wp, v.a.xy, v.a.zw, v.b.x);
  } else if (kind == 3.0) {
    d = sd_tri(v.wp, v.a.xy, v.a.zw, v.b.xy);
  } else {
    let lp = rot(v.wp - v.a.xy, vec2f(v.b.x, -v.b.y));
    if (kind == 1.0) {
      d = sd_ellipse(lp, v.a.zw);
    } else {
      d = sd_box(lp, v.a.zw, v.b.z);
    }
    if (kind == 4.0) {
      let t = clamp(lp / v.a.zw * 0.5 + 0.5, vec2f(0.0), vec2f(1.0));
      let uv = mix(v.c.xy, v.c.zw, t);
      if (v.p.w > 0.5) {
        tex = textureSampleLevel(image_atlas, samp, uv, 0.0);
      } else {
        tex = textureSampleLevel(text_atlas, samp, uv, 0.0);
      }
    }
  }
  let sw = v.p.x;
  let glow = v.p.y;
  let fa = clamp(0.5 - d, 0.0, 1.0);
  var col = v.fill * fa;
  if (kind == 4.0) { col = tex * v.fill * fa; }
  if (sw > 0.0) {
    let sa = clamp(sw * 0.5 + 0.5 - abs(d), 0.0, 1.0);
    col = v.stroke * sa + col * (1.0 - v.stroke.a * sa);
  }
  if (glow > 0.0) {
    let outside = max(d - sw * 0.5, 0.0);
    let g = exp(-outside * outside / (glow * glow * 0.5));
    var gc = v.fill;
    if (v.stroke.a > 0.0) { gc = v.stroke; }
    col = col + gc * (g * 0.65 * (1.0 - col.a));
  }
  return col;
}
";

/// 2D transform: rotation and uniform scale, then translation.
#[derive(Clone, Copy)]
struct Xf {
    cos: f32,
    sin: f32,
    scale: f32,
    t: Vec2,
}

impl Xf {
    const ID: Xf = Xf { cos: 1.0, sin: 0.0, scale: 1.0, t: Vec2::ZERO };

    fn point(&self, p: Vec2) -> Vec2 {
        let s = self.scale;
        Vec2::new((p.x * self.cos - p.y * self.sin) * s, (p.x * self.sin + p.y * self.cos) * s) + self.t
    }

    fn is_id(&self) -> bool {
        self.cos == 1.0 && self.sin == 0.0 && self.scale == 1.0
    }
}

const TEXT_ATLAS: u32 = 1024;
const IMAGE_ATLAS_MIN: u32 = 512;
const IMAGE_ATLAS_MAX: u32 = 4096;
const START_INSTANCES: usize = 4096;

/// The painter of one scene instance (sketch.rs makes it; raw scenes can use it too).
pub struct Draw {
    gpu: Gpu,
    w: f32,
    h: f32,
    normal: wgpu::RenderPipeline,
    add: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    group: wgpu::BindGroup,
    ubuf: wgpu::Buffer,
    sampler: wgpu::Sampler,
    buf: wgpu::Buffer,
    cap: usize,
    inst: Vec<Inst>,
    /// (blend, first instance) of each run
    runs: Vec<(Blend, u32)>,
    stack: Vec<Xf>,
    xf: Xf,
    clear: Color,
    keep: bool,
    /// frames finished (the first one always clears)
    frame: u64,
    text_atlas: Atlas,
    texts: HashMap<String, TextSprite>,
    image_atlas: Atlas,
    images: Vec<ImageSlot>,
}

impl Draw {
    /// A painter for a target of w × h LED pixels.
    pub fn new(gpu: &Gpu, w: u32, h: u32) -> Result<Draw, String> {
        let m = gpu.shader("wall draw", WGSL)?;
        let f = wgpu::ShaderStages::FRAGMENT;
        let bgl = gpu.bind_group_layout(
            "wall draw",
            &[layout::uniform(0, wgpu::ShaderStages::VERTEX_FRAGMENT), layout::float_tex(1, f, true), layout::float_tex(2, f, true), layout::sampler(3, f, true)],
        );
        let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("wall draw"), bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
        let attrs = wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32x4, 2 => Float32x4, 3 => Float32x4, 4 => Float32x4, 5 => Float32x4];
        let pipeline = |name: &str, comp: wgpu::BlendComponent| {
            gpu.render_pipeline(name, |d| {
                d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some(name),
                    layout: Some(&pl),
                    vertex: wgpu::VertexState {
                        module: &m,
                        entry_point: Some("vs"),
                        compilation_options: Default::default(),
                        buffers: &[Some(wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<Inst>() as u64, step_mode: wgpu::VertexStepMode::Instance, attributes: &attrs })],
                    },
                    fragment: Some(wgpu::FragmentState {
                        module: &m,
                        entry_point: Some("fs"),
                        compilation_options: Default::default(),
                        targets: &[Some(wgpu::ColorTargetState { format: TARGET_FORMAT, blend: Some(wgpu::BlendState { color: comp, alpha: comp }), write_mask: wgpu::ColorWrites::ALL })],
                    }),
                    primitive: Default::default(),
                    depth_stencil: None,
                    multisample: Default::default(),
                    multiview_mask: None,
                    cache: None,
                })
            })
        };
        let over = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add };
        let plus = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add };
        let normal = pipeline("wall draw normal", over)?;
        let add = pipeline("wall draw add", plus)?;
        let ubuf = gpu.uniform_buffer("wall draw", 16);
        gpu.queue.write_buffer(&ubuf, 0, bytemuck::cast_slice(&[w as f32, h as f32, 1.0 / w.max(1) as f32, 1.0 / h.max(1) as f32]));
        let sampler = gpu.linear_sampler();
        let text_atlas = Atlas::new(gpu, "wall draw text", TEXT_ATLAS, TEXT_ATLAS);
        let image_atlas = Atlas::new(gpu, "wall draw images", IMAGE_ATLAS_MIN, IMAGE_ATLAS_MIN);
        let group = Self::bind(gpu, &bgl, &ubuf, &text_atlas, &image_atlas, &sampler);
        let cap = START_INSTANCES;
        let buf = gpu.buffer("wall draw", (cap * std::mem::size_of::<Inst>()) as u64, wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST);
        Ok(Draw {
            gpu: gpu.clone(),
            w: w as f32,
            h: h as f32,
            normal,
            add,
            layout: bgl,
            group,
            ubuf,
            sampler,
            buf,
            cap,
            inst: Vec::with_capacity(cap),
            runs: Vec::new(),
            stack: Vec::new(),
            xf: Xf::ID,
            clear: Color::BLACK,
            keep: false,
            frame: 0,
            text_atlas,
            texts: HashMap::new(),
            image_atlas,
            images: Vec::new(),
        })
    }

    fn bind(gpu: &Gpu, bgl: &wgpu::BindGroupLayout, ubuf: &wgpu::Buffer, text: &Atlas, image: &Atlas, sampler: &wgpu::Sampler) -> wgpu::BindGroup {
        gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("wall draw"),
            layout: bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: ubuf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&text.view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&image.view) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(sampler) },
            ],
        })
    }

    /// The target's size in LED pixels.
    pub fn size(&self) -> Vec2 {
        Vec2::new(self.w, self.h)
    }

    /// Starts a frame (sketch.rs does it).
    pub fn begin(&mut self) {
        self.inst.clear();
        self.runs.clear();
        self.stack.clear();
        self.xf = Xf::ID;
        self.clear = Color::BLACK;
        self.keep = false;
    }

    /// This frame's background (default black).
    pub fn clear(&mut self, c: Color) {
        self.clear = c;
    }

    /// Keeps the last frame's picture instead of clearing it (trails: then fade() it).
    pub fn keep(&mut self) {
        self.keep = true;
    }

    /// The whole picture covered with `c` (with keep(): what was there fades by c's alpha per frame).
    pub fn fade(&mut self, c: Color) {
        let xf = std::mem::replace(&mut self.xf, Xf::ID);
        self.rect(0.0, 0.0, self.w, self.h, c);
        self.xf = xf;
    }

    // ----- transform -----

    /// Saves the transform (pop() restores it).
    pub fn push(&mut self) {
        self.stack.push(self.xf);
    }

    pub fn pop(&mut self) {
        if let Some(x) = self.stack.pop() {
            self.xf = x;
        }
    }

    /// Moves what follows by (x, y).
    pub fn translate(&mut self, x: f32, y: f32) {
        self.xf.t = self.xf.point(Vec2::new(x, y));
    }

    /// Turns what follows by `radians` (clockwise on the wall).
    pub fn rotate(&mut self, radians: f32) {
        let (s, c) = radians.sin_cos();
        let (c0, s0) = (self.xf.cos, self.xf.sin);
        self.xf.cos = c0 * c - s0 * s;
        self.xf.sin = s0 * c + c0 * s;
    }

    /// Scales what follows by `s`.
    pub fn scale(&mut self, s: f32) {
        self.xf.scale *= s;
    }

    // ----- shapes -----

    fn push_inst(&mut self, blend: Blend, i: Inst) {
        if self.runs.last().is_none_or(|r| r.0 != blend) {
            self.runs.push((blend, self.inst.len() as u32));
        }
        self.inst.push(i);
    }

    fn paint_bits(&self, p: &Paint, kind: f32, atlas: f32) -> ([f32; 4], [f32; 4], [f32; 4]) {
        let s = self.xf.scale;
        (p.fill.premul(), p.stroke.premul(), [p.stroke_width * s, p.glow * s, kind, atlas])
    }

    /// A box with its centre, half size, corner radius, turned by the transform.
    fn boxed(&mut self, center: Vec2, half: Vec2, radius: f32, p: Paint, kind: f32) {
        let c = self.xf.point(center);
        let s = self.xf.scale;
        let (fill, stroke, pp) = self.paint_bits(&p, kind, 0.0);
        self.push_inst(p.blend, Inst { a: [c.x, c.y, half.x * s, half.y * s], b: [self.xf.cos, self.xf.sin, radius * s, 0.0], c: [0.0; 4], fill, stroke, p: pp });
    }

    /// A rectangle: top left corner, size.
    pub fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, p: impl Into<Paint>) {
        self.boxed(Vec2::new(x + w / 2.0, y + h / 2.0), Vec2::new(w.abs() / 2.0, h.abs() / 2.0), 0.0, p.into(), KIND_RECT);
    }

    /// A rectangle with round corners of radius `r`.
    pub fn rrect(&mut self, x: f32, y: f32, w: f32, h: f32, r: f32, p: impl Into<Paint>) {
        self.boxed(Vec2::new(x + w / 2.0, y + h / 2.0), Vec2::new(w.abs() / 2.0, h.abs() / 2.0), r, p.into(), KIND_RECT);
    }

    /// A circle: centre, radius.
    pub fn circle(&mut self, x: f32, y: f32, r: f32, p: impl Into<Paint>) {
        self.boxed(Vec2::new(x, y), Vec2::splat(r.abs()), 0.0, p.into(), KIND_ELLIPSE);
    }

    /// An ellipse: centre, radii.
    pub fn ellipse(&mut self, x: f32, y: f32, rx: f32, ry: f32, p: impl Into<Paint>) {
        self.boxed(Vec2::new(x, y), Vec2::new(rx.abs(), ry.abs()), 0.0, p.into(), KIND_ELLIPSE);
    }

    /// A line `width` px wide with round ends; its color is the paint's fill.
    pub fn line(&mut self, x0: f32, y0: f32, x1: f32, y1: f32, width: f32, p: impl Into<Paint>) {
        let p = p.into();
        let (a, b) = (self.xf.point(Vec2::new(x0, y0)), self.xf.point(Vec2::new(x1, y1)));
        let (fill, stroke, pp) = self.paint_bits(&p, KIND_SEGMENT, 0.0);
        self.push_inst(p.blend, Inst { a: [a.x, a.y, b.x, b.y], b: [width * 0.5 * self.xf.scale, 0.0, 0.0, 0.0], c: [0.0; 4], fill, stroke, p: pp });
    }

    /// Lines through `pts` (closed: back to the first).
    pub fn polyline(&mut self, pts: &[Vec2], width: f32, closed: bool, p: impl Into<Paint>) {
        let p = p.into();
        for w in pts.windows(2) {
            self.line(w[0].x, w[0].y, w[1].x, w[1].y, width, p);
        }
        if closed && pts.len() > 2 {
            let (a, b) = (pts[pts.len() - 1], pts[0]);
            self.line(a.x, a.y, b.x, b.y, width, p);
        }
    }

    /// A filled triangle.
    pub fn triangle(&mut self, a: Vec2, b: Vec2, c: Vec2, p: impl Into<Paint>) {
        let p = p.into();
        let (a, b, c) = (self.xf.point(a), self.xf.point(b), self.xf.point(c));
        let (fill, stroke, pp) = self.paint_bits(&p, KIND_TRI, 0.0);
        self.push_inst(p.blend, Inst { a: [a.x, a.y, b.x, b.y], b: [c.x, c.y, 0.0, 0.0], c: [0.0; 4], fill, stroke, p: pp });
    }

    /// A filled convex polygon (as a fan of triangles: outline and glow per triangle).
    pub fn polygon(&mut self, pts: &[Vec2], p: impl Into<Paint>) {
        let p = p.into();
        for i in 1..pts.len().saturating_sub(1) {
            self.triangle(pts[0], pts[i], pts[i + 1], p);
        }
    }

    // ----- images -----

    /// Loads an image (RGBA8, straight alpha, w × h) into the image atlas, once (in setup).
    pub fn load_image(&mut self, w: u32, h: u32, rgba: &[u8]) -> Result<Image, String> {
        if rgba.len() < (w * h * 4) as usize || w == 0 || h == 0 {
            return Err(format!("Bild {w}×{h}: zu wenige Pixel"));
        }
        let mut px = rgba[..(w * h * 4) as usize].to_vec();
        for c in px.as_chunks_mut::<4>().0 {
            let a = u16::from(c[3]);
            for v in &mut c[..3] {
                *v = ((u16::from(*v) * a + 127) / 255) as u8;
            }
        }
        let at = match self.image_atlas.shelves.alloc(w, h) {
            Some(at) => at,
            None => {
                self.grow_images(w, h)?;
                self.image_atlas.shelves.alloc(w, h).ok_or("Bildatlas voll")?
            }
        };
        self.image_atlas.write(&self.gpu, at, w, h, &px);
        self.images.push(ImageSlot { at, w, h, px });
        Ok(Image { id: (self.images.len() - 1) as u32, w, h })
    }

    /// A bigger image atlas with every image in it again (and room for one of w × h).
    fn grow_images(&mut self, w: u32, h: u32) -> Result<(), String> {
        let fits = |size: u32, images: &[ImageSlot]| {
            let mut sh = Shelves::new(size, size);
            images.iter().all(|s| sh.alloc(s.w, s.h).is_some()) && sh.alloc(w, h).is_some()
        };
        let mut size = self.image_atlas.shelves.w * 2;
        while !fits(size, &self.images) {
            size *= 2;
            if size > IMAGE_ATLAS_MAX {
                return Err(format!("Bild {w}×{h} passt nicht mehr in den Bildatlas ({IMAGE_ATLAS_MAX}²)"));
            }
        }
        let mut atlas = Atlas::new(&self.gpu, "wall draw images", size, size);
        for s in &mut self.images {
            let Some(at) = atlas.shelves.alloc(s.w, s.h) else { return Err("Bildatlas".into()) };
            atlas.write(&self.gpu, at, s.w, s.h, &s.px);
            s.at = at;
        }
        self.image_atlas = atlas;
        self.group = Self::bind(&self.gpu, &self.layout, &self.ubuf, &self.text_atlas, &self.image_atlas, &self.sampler);
        Ok(())
    }

    /// An image, its top left corner at (x, y), drawn w × h.
    pub fn image(&mut self, img: Image, x: f32, y: f32, w: f32, h: f32) {
        self.image_tinted(img, x, y, w, h, Color::WHITE);
    }

    /// An image multiplied with `tint` (its alpha fades it).
    pub fn image_tinted(&mut self, img: Image, x: f32, y: f32, w: f32, h: f32, tint: Color) {
        let Some(s) = self.images.get(img.id as usize) else { return };
        let uv = self.image_atlas.uv(s.at, s.w, s.h);
        let c = self.xf.point(Vec2::new(x + w / 2.0, y + h / 2.0));
        let sc = self.xf.scale;
        self.push_inst(
            Blend::Normal,
            Inst { a: [c.x, c.y, w.abs() / 2.0 * sc, h.abs() / 2.0 * sc], b: [self.xf.cos, self.xf.sin, 0.0, 0.0], c: uv, fill: tint.premul(), stroke: [0.0; 4], p: [0.0, 0.0, KIND_IMAGE, 1.0] },
        );
    }

    // ----- text -----

    /// The painted text (cached while it is in use).
    fn text_sprite(&mut self, text: &str, t: &Text) -> Option<TextSprite> {
        let key = t.key(text);
        if let Some(s) = self.texts.get_mut(&key) {
            s.used = self.frame;
            return Some(*s);
        }
        let label = paint_label(text, &t.style(), [t.color.r, t.color.g, t.color.b]);
        let (w, h) = (label.w.max(1) as u32, label.h.max(1) as u32);
        let at = match self.text_atlas.shelves.alloc(w, h) {
            Some(at) => at,
            None => {
                // full: start over (the texts still in use are painted again as they come)
                self.text_atlas.shelves = Shelves::new(TEXT_ATLAS, TEXT_ATLAS);
                self.texts.clear();
                self.text_atlas.shelves.alloc(w, h)?
            }
        };
        let mut px = vec![0u8; (w * h * 4) as usize];
        for (d, s) in px.as_chunks_mut::<4>().0.iter_mut().zip(&label.px) {
            *d = s.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8);
        }
        self.text_atlas.write(&self.gpu, at, w, h, &px);
        let sprite = TextSprite {
            uv: self.text_atlas.uv(at, w, h),
            size: [w as f32, h as f32],
            frame: [label.frame[0] as f32, label.frame[1] as f32, label.frame[2] as f32, label.frame[3] as f32],
            used: self.frame,
        };
        self.texts.insert(key, sprite);
        Some(sprite)
    }

    /// The size of a text's box (with its padding), px.
    pub fn measure(&mut self, text: &str, t: &Text) -> Vec2 {
        self.text_sprite(text, t).map_or(Vec2::ZERO, |s| Vec2::new(s.frame[2], s.frame[3]))
    }

    /// A text; its anchor (t.anchor, default the centre of its box) at (x, y).
    pub fn text(&mut self, text: &str, x: f32, y: f32, t: &Text) {
        if text.is_empty() || t.color.a <= 0.0 {
            return;
        }
        let Some(s) = self.text_sprite(text, t) else { return };
        // the sprite's top left: the box's anchor at (x, y), the glow margin around the box
        let off = t.anchor.offset(s.frame[2], s.frame[3]);
        let mut left = x - off.x - s.frame[0];
        let mut top = y - off.y - s.frame[1];
        if self.xf.is_id() {
            // whole pixels: crisp text
            left = (left + self.xf.t.x).round() - self.xf.t.x;
            top = (top + self.xf.t.y).round() - self.xf.t.y;
        }
        let c = self.xf.point(Vec2::new(left + s.size[0] / 2.0, top + s.size[1] / 2.0));
        let sc = self.xf.scale;
        self.push_inst(
            Blend::Normal,
            Inst { a: [c.x, c.y, s.size[0] / 2.0 * sc, s.size[1] / 2.0 * sc], b: [self.xf.cos, self.xf.sin, 0.0, 0.0], c: s.uv, fill: Color::WHITE.alpha(t.color.a).premul(), stroke: [0.0; 4], p: [0.0, 0.0, KIND_IMAGE, 0.0] },
        );
    }

    // ----- the end of a frame -----

    /// Draws everything of this frame into the scene's target (sketch.rs does it).
    pub fn finish(&mut self, ctx: &mut FrameCtx) {
        self.finish_into(ctx.encoder, ctx.target);
    }

    /// Draws everything of this frame into `target` with `encoder`.
    pub fn finish_into(&mut self, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView) {
        if self.inst.len() > self.cap {
            while self.cap < self.inst.len() {
                self.cap *= 2;
            }
            self.buf = self.gpu.buffer("wall draw", (self.cap * std::mem::size_of::<Inst>()) as u64, wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST);
        }
        if !self.inst.is_empty() {
            self.gpu.queue.write_buffer(&self.buf, 0, bytemuck::cast_slice(&self.inst));
        }
        let c = self.clear;
        let load = if self.keep && self.frame > 0 { wgpu::LoadOp::Load } else { wgpu::LoadOp::Clear(wgpu::Color { r: f64::from(c.r), g: f64::from(c.g), b: f64::from(c.b), a: f64::from(c.a) }) };
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("wall draw"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: target, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load, store: wgpu::StoreOp::Store } })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            if !self.inst.is_empty() {
                pass.set_bind_group(0, &self.group, &[]);
                pass.set_vertex_buffer(0, self.buf.slice(..));
                let n = self.inst.len() as u32;
                for (k, (blend, first)) in self.runs.iter().enumerate() {
                    let end = self.runs.get(k + 1).map_or(n, |r| r.1);
                    pass.set_pipeline(if *blend == Blend::Add { &self.add } else { &self.normal });
                    pass.draw(0..6, *first..end);
                }
            }
        }
        self.frame += 1;
        // texts unused for a while leave the cache (their atlas room is reused when it is full)
        if self.frame.is_multiple_of(300) {
            let now = self.frame;
            self.texts.retain(|_, s| now - s.used < 600);
        }
    }
}

/// Drawing on whatever has a Draw: Draw itself and a sketch's Frame (`f.circle(..)`). As methods of
/// the frame, their arguments may read the frame (`f.circle(x, y, f.num("r"), c)`).
pub trait Paints {
    fn painter(&mut self) -> &mut Draw;

    /// The target's size in LED pixels.
    fn size(&mut self) -> Vec2 {
        Draw::size(self.painter())
    }
    /// This frame's background (default black).
    fn clear(&mut self, c: Color) {
        Draw::clear(self.painter(), c);
    }
    /// Keeps the last frame's picture (trails: then fade() it).
    fn keep(&mut self) {
        Draw::keep(self.painter());
    }
    /// The whole picture covered with `c`.
    fn fade(&mut self, c: Color) {
        Draw::fade(self.painter(), c);
    }
    fn push(&mut self) {
        Draw::push(self.painter());
    }
    fn pop(&mut self) {
        Draw::pop(self.painter());
    }
    fn translate(&mut self, x: f32, y: f32) {
        Draw::translate(self.painter(), x, y);
    }
    fn rotate(&mut self, radians: f32) {
        Draw::rotate(self.painter(), radians);
    }
    fn scale(&mut self, s: f32) {
        Draw::scale(self.painter(), s);
    }
    /// A rectangle: top left corner, size.
    fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, p: impl Into<Paint>) {
        Draw::rect(self.painter(), x, y, w, h, p);
    }
    /// A rectangle with round corners of radius `r`.
    fn rrect(&mut self, x: f32, y: f32, w: f32, h: f32, r: f32, p: impl Into<Paint>) {
        Draw::rrect(self.painter(), x, y, w, h, r, p);
    }
    /// A circle: centre, radius.
    fn circle(&mut self, x: f32, y: f32, r: f32, p: impl Into<Paint>) {
        Draw::circle(self.painter(), x, y, r, p);
    }
    /// An ellipse: centre, radii.
    fn ellipse(&mut self, x: f32, y: f32, rx: f32, ry: f32, p: impl Into<Paint>) {
        Draw::ellipse(self.painter(), x, y, rx, ry, p);
    }
    /// A line `width` px wide with round ends.
    fn line(&mut self, x0: f32, y0: f32, x1: f32, y1: f32, width: f32, p: impl Into<Paint>) {
        Draw::line(self.painter(), x0, y0, x1, y1, width, p);
    }
    /// Lines through `pts`.
    fn polyline(&mut self, pts: &[Vec2], width: f32, closed: bool, p: impl Into<Paint>) {
        Draw::polyline(self.painter(), pts, width, closed, p);
    }
    fn triangle(&mut self, a: Vec2, b: Vec2, c: Vec2, p: impl Into<Paint>) {
        Draw::triangle(self.painter(), a, b, c, p);
    }
    /// A filled convex polygon.
    fn polygon(&mut self, pts: &[Vec2], p: impl Into<Paint>) {
        Draw::polygon(self.painter(), pts, p);
    }
    /// An image, its top left corner at (x, y), drawn w × h.
    fn image(&mut self, img: Image, x: f32, y: f32, w: f32, h: f32) {
        Draw::image(self.painter(), img, x, y, w, h);
    }
    fn image_tinted(&mut self, img: Image, x: f32, y: f32, w: f32, h: f32, tint: Color) {
        Draw::image_tinted(self.painter(), img, x, y, w, h, tint);
    }
    /// Loads an image (RGBA8, straight alpha) once.
    fn load_image(&mut self, w: u32, h: u32, rgba: &[u8]) -> Result<Image, String> {
        Draw::load_image(self.painter(), w, h, rgba)
    }
    /// A text; its anchor (default the centre of its box) at (x, y).
    fn text(&mut self, text: &str, x: f32, y: f32, t: &Text) {
        Draw::text(self.painter(), text, x, y, t);
    }
    /// The size of a text's box, px.
    fn measure(&mut self, text: &str, t: &Text) -> Vec2 {
        Draw::measure(self.painter(), text, t)
    }
}

impl Paints for Draw {
    fn painter(&mut self) -> &mut Draw {
        self
    }
}
