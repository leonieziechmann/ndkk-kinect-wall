//! The page as the browser's Canvas 2D drew it, at LED size, on the GPU: first the masks (the hub's
//! labels, 512 x 424, not smoothed) scaled into the Kinect view on black, then every shape and glyph
//! of the frame in the order the page drew them, as instanced quads blended source-over. Their
//! coverage is computed per pixel the way Canvas 2D anti-aliases: the covered area for rects (the
//! mask points from above, strokeRect), the distance to the outline for lines, dashes and circles.
//! The text comes from glyphs of the monospace font rendered once (make()) into an atlas.
//!
//! The shapes of a frame are collected by `Painter` on the CPU (a few hundred, no rasterizing there),
//! with the canvas' state (line width, line cap, dash), which carries over between frames as the
//! browser's context state does.

use crate::canvas::{Font, Rgba, measure_text, text_coverage};
use crate::gpu::{FULLSCREEN_WGSL, Gpu, TARGET_FORMAT, layout};
use crate::kinect_gpu::KinectGpu;
use crate::persons::{SLOTS, person_color};
use crate::scene::FrameCtx;

const WGSL: &str = r"
// rect: x0, y0, x1, y1 of the Kinect view (LED px); misc: the masks' alpha (0: none), the target's
// width and height; cols: the color per slot
struct U { rect: vec4f, misc: vec4f, cols: array<vec4f, 17> };
@group(0) @binding(0) var labels: texture_2d<u32>;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: U;

@fragment fn fs_mask(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var c = vec3f(0.0);
  if (u.misc.x > 0.0) {
    // drawImage(mask, lx, ly, lw, lh) without smoothing: the nearest mask pixel; the rect's edges
    // with the part of the pixel they cover
    let cov = clamp(min(pos.xy + 0.5, u.rect.zw) - max(pos.xy - 0.5, u.rect.xy), vec2f(0.0), vec2f(1.0));
    if (cov.x > 0.0 && cov.y > 0.0) {
      let uv = (pos.xy - u.rect.xy) / (u.rect.zw - u.rect.xy);
      let t = clamp(vec2i(floor(uv * vec2f(512.0, 424.0))), vec2i(0), vec2i(511, 423));
      let s = textureLoad(labels, t, 0).r;
      if (s > 0u) {
        // COLS[label] ?? COLS[0]
        c = u.cols[select(s, 0u, s > 16u)].rgb * (u.misc.x * cov.x * cov.y);
      }
    }
  }
  return vec4f(c, 1.0);
}

// a: RECT x0, y0, x1, y1 | LINE x0, y0, x1, y1 | DISC, RING cx, cy, r | GLYPH x, y, w, h (LED px)
// b: RECT a hole x0, y0, x1, y1 (none: x1 < x0) | LINE half width, round caps, dash on, off (0: solid)
//    | RING half width | GLYPH its place in the atlas
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) a: vec4f,
  @location(1) @interpolate(flat) b: vec4f,
  @location(2) @interpolate(flat) col: vec4f,
  @location(3) @interpolate(flat) kind: u32,
};

@vertex fn vs_prim(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f, @location(2) col: vec4f, @location(3) kind: u32) -> VOut {
  // the quad: the shape's box and a pixel around it for the edges
  var lo = a.xy;
  var hi = a.xy + a.zw;
  if (kind == 0u) {
    lo = a.xy - 1.0;
    hi = a.zw + 1.0;
  } else if (kind == 1u) {
    lo = min(a.xy, a.zw) - b.x - 1.0;
    hi = max(a.xy, a.zw) + b.x + 1.0;
  } else if (kind == 2u || kind == 3u) {
    let e = a.z + b.x + 1.0;
    lo = a.xy - e;
    hi = a.xy + e;
  }
  var corner = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let p = mix(lo, hi, corner[vi]);
  var out: VOut;
  out.pos = vec4f(p.x / u.misc.y * 2.0 - 1.0, 1.0 - p.y / u.misc.z * 2.0, 0.0, 1.0);
  out.a = a;
  out.b = b;
  out.col = col;
  out.kind = kind;
  return out;
}

// the part of the pixel at p (its centre) inside the rect lo..hi
fn area(lo: vec2f, hi: vec2f, p: vec2f) -> f32 {
  let o = clamp(min(hi, p + 0.5) - max(lo, p - 0.5), vec2f(0.0), vec2f(1.0));
  return o.x * o.y;
}

// a stroked line: round caps (a capsule) or butt caps (a box), dashed from its start
fn line_cov(a: vec4f, b: vec4f, p: vec2f) -> f32 {
  let d = a.zw - a.xy;
  let len = length(d);
  if (len < 1e-4) {
    return 0.0;
  }
  let dir = d / len;
  let q = p - a.xy;
  let t = dot(q, dir);
  let n = abs(dot(q, vec2f(-dir.y, dir.x)));
  // the piece of the line nearest to p: the whole line or one dash
  var s0 = 0.0;
  var s1 = len;
  if (b.w > 0.0) {
    let period = b.z + b.w;
    let last = max(ceil(len / period) - 1.0, 0.0);
    let k = clamp(floor(t / period), 0.0, last);
    s0 = k * period;
    if (t > s0 + b.z && k < last && s0 + period - t < t - s0 - b.z) {
      s0 = s0 + period;
    }
    s1 = min(s0 + b.z, len);
  }
  if (b.y > 0.5) {
    let dist = length(vec2f(t - clamp(t, s0, s1), n));
    return clamp(b.x - dist + 0.5, 0.0, 1.0);
  }
  return clamp(b.x - n + 0.5, 0.0, 1.0) * clamp(t - s0 + 0.5, 0.0, 1.0) * clamp(s1 - t + 0.5, 0.0, 1.0);
}

@fragment fn fs_prim(in: VOut) -> @location(0) vec4f {
  let p = in.pos.xy;
  var cov = 0.0;
  if (in.kind == 0u) {
    cov = area(in.a.xy, in.a.zw, p);
    if (in.b.z > in.b.x && in.b.w > in.b.y) {
      cov = max(cov - area(in.b.xy, in.b.zw, p), 0.0);
    }
  } else if (in.kind == 1u) {
    cov = line_cov(in.a, in.b, p);
  } else if (in.kind == 2u) {
    cov = clamp(in.a.z - length(p - in.a.xy) + 0.5, 0.0, 1.0);
  } else if (in.kind == 3u) {
    cov = clamp(in.b.x - abs(length(p - in.a.xy) - in.a.z) + 0.5, 0.0, 1.0);
  } else {
    let t = vec2i(in.b.xy) + clamp(vec2i(floor(p - in.a.xy)), vec2i(0), vec2i(in.a.zw) - 1);
    cov = textureLoad(atlas, t, 0).r;
  }
  let a = in.col.a * cov;
  return vec4f(in.col.rgb * a, a);
}
";

const RECT: u32 = 0;
const LINE: u32 = 1;
const DISC: u32 = 2;
const RING: u32 = 3;
const GLYPH: u32 = 4;

/// One shape (see the WGSL above).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Prim {
    a: [f32; 4],
    b: [f32; 4],
    col: [f32; 4],
    kind: u32,
    _pad: [u32; 3],
}

const PRIM: u64 = std::mem::size_of::<Prim>() as u64;

/// A character in the atlas: its covered pixels (cell), where they sit from the pen position on the
/// baseline, its advance.
#[derive(Clone, Copy, Default)]
struct Glyph {
    ax: f32,
    ay: f32,
    w: f32,
    h: f32,
    x: f32,
    y: f32,
    adv: f32,
}

/// every character the page writes: ASCII, the umlauts, '°', '–'
const CHARS: &str = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~äöüÄÖÜß°–";
const ATLAS_W: usize = 256;

/// The glyphs of the font (a monospace one: no kerning, no ligatures; a string is its glyphs one after
/// the other, as the browser lays it out) and their coverage, packed into rows.
struct Glyphs {
    latin: Vec<Glyph>,
    has: Vec<bool>,
    other: Vec<(char, Glyph)>,
    space: f32,
    atlas: Vec<u8>,
    atlas_h: usize,
}

impl Glyphs {
    fn new(font: &Font) -> Self {
        let mut g = Self { latin: vec![Glyph::default(); 256], has: vec![false; 256], other: Vec::new(), space: font.size * 0.55, atlas: Vec::new(), atlas_h: 0 };
        let (mut x, mut y, mut row_h) = (0usize, 0usize, 0usize);
        for ch in CHARS.chars() {
            let mut buf = [0u8; 4];
            let s: &str = ch.encode_utf8(&mut buf);
            let (w, h, base, cov) = text_coverage(s, font);
            let adv = measure_text(s, font);
            let (w, h) = (w as usize, h as usize);
            // only the box around the covered pixels
            let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
            for (i, &a) in cov.iter().enumerate() {
                if a > 0 {
                    let (px, py) = (i % w.max(1), i / w.max(1));
                    (x0, y0, x1, y1) = (x0.min(px), y0.min(py), x1.max(px + 1), y1.max(py + 1));
                }
            }
            let mut glyph = Glyph { adv, ..Glyph::default() };
            if x0 < x1 && y0 < y1 {
                let (cw, chh) = (x1 - x0, y1 - y0);
                if x + cw > ATLAS_W {
                    (x, y, row_h) = (0, y + row_h + 1, 0);
                }
                let need = ATLAS_W * (y + chh);
                if g.atlas.len() < need {
                    g.atlas.resize(need, 0);
                }
                for yy in 0..chh {
                    let src = (y0 + yy) * w + x0;
                    let dst = (y + yy) * ATLAS_W + x;
                    if let (Some(s), Some(d)) = (cov.get(src..src + cw), g.atlas.get_mut(dst..dst + cw)) {
                        d.copy_from_slice(s);
                    }
                }
                glyph = Glyph { ax: x as f32, ay: y as f32, w: cw as f32, h: chh as f32, x: x0 as f32, y: y0 as f32 - base as f32, adv };
                x += cw + 1;
                row_h = row_h.max(chh);
                g.atlas_h = g.atlas_h.max(y + chh);
            }
            if ch == ' ' {
                g.space = adv;
            }
            match (g.latin.get_mut(ch as usize), g.has.get_mut(ch as usize)) {
                (Some(l), Some(has)) => (*l, *has) = (glyph, true),
                _ => g.other.push((ch, glyph)),
            }
        }
        g.atlas_h = g.atlas_h.max(1);
        g.atlas.resize(ATLAS_W * g.atlas_h, 0);
        g
    }

    fn get(&self, ch: char) -> Option<Glyph> {
        let i = ch as usize;
        if i < 256 {
            return self.has.get(i).copied().unwrap_or(false).then(|| self.latin.get(i).copied()).flatten();
        }
        self.other.iter().find(|(c, _)| *c == ch).map(|(_, g)| *g)
    }
}

/// The shapes of a frame, drawn as Canvas 2D would (its calls and its state).
pub struct Painter {
    prims: Vec<Prim>,
    glyphs: Glyphs,
    /// lineWidth
    pub line_width: f32,
    /// lineCap 'round' (else 'butt')
    pub round: bool,
    /// setLineDash([on, off]); [0, 0]: none
    pub dash: [f32; 2],
}

impl Painter {
    pub fn new(font: &Font) -> Self {
        Self { prims: Vec::with_capacity(4096), glyphs: Glyphs::new(font), line_width: 1.0, round: false, dash: [0.0; 2] }
    }

    /// a new frame: nothing drawn yet (the state stays)
    pub fn clear(&mut self) {
        self.prims.clear();
    }

    /// the state of a new canvas
    pub fn reset(&mut self) {
        (self.line_width, self.round, self.dash) = (1.0, false, [0.0; 2]);
    }

    fn push(&mut self, kind: u32, a: [f32; 4], b: [f32; 4], c: Rgba) {
        if c.3 > 0.0 && a.iter().chain(&b).all(|v| v.is_finite()) {
            self.prims.push(Prim { a, b, col: [c.0, c.1, c.2, c.3.min(1.0)], kind, _pad: [0; 3] });
        }
    }

    /// beginPath, moveTo, lineTo, stroke
    pub fn line(&mut self, x0: f32, y0: f32, x1: f32, y1: f32, c: Rgba) {
        // (Canvas 2D strokes nothing for a line without length)
        if (x0 == x1 && y0 == y1) || self.line_width.is_nan() || self.line_width <= 0.0 {
            return;
        }
        let dash = if self.dash[0] > 0.0 && self.dash[1] >= 0.0 { self.dash } else { [0.0; 2] };
        self.push(LINE, [x0, y0, x1, y1], [self.line_width / 2.0, if self.round { 1.0 } else { 0.0 }, dash[0], dash[1]], c);
    }

    /// strokeRect (miter joins: the outer rect without the inner one)
    pub fn stroke_rect(&mut self, x: f32, y: f32, w: f32, h: f32, c: Rgba) {
        let hw = self.line_width / 2.0;
        self.push(RECT, [x - hw, y - hw, x + w + hw, y + h + hw], [x + hw, y + hw, x + w - hw, y + h - hw], c);
    }

    /// fillRect
    pub fn fill_rect(&mut self, x: f32, y: f32, w: f32, h: f32, c: Rgba) {
        if w > 0.0 && h > 0.0 {
            self.push(RECT, [x, y, x + w, y + h], [0.0, 0.0, -1.0, -1.0], c);
        }
    }

    /// arc(cx, cy, r, 0, 2π), fill
    pub fn fill_circle(&mut self, cx: f32, cy: f32, r: f32, c: Rgba) {
        self.push(DISC, [cx, cy, r.max(0.0), 0.0], [0.0; 4], c);
    }

    /// arc(cx, cy, r, 0, 2π), stroke
    pub fn stroke_circle(&mut self, cx: f32, cy: f32, r: f32, c: Rgba) {
        self.push(RING, [cx, cy, r.max(0.0), 0.0], [self.line_width / 2.0, 0.0, 0.0, 0.0], c);
    }

    /// fillText (textAlign start, textBaseline alphabetic): `text` from (x, y) on
    pub fn text(&mut self, text: &str, x: f32, y: f32, c: Rgba) {
        let mut pen = x;
        for ch in text.chars() {
            let Some(g) = self.glyphs.get(ch) else {
                pen += self.glyphs.space;
                continue;
            };
            if g.w > 0.0 {
                // on whole pixels, as canvas::fill_text puts its glyphs
                self.push(GLYPH, [(pen + g.x + 0.5).floor(), (y + g.y + 0.5).floor(), g.w, g.h], [g.ax, g.ay, 0.0, 0.0], c);
            }
            pen += g.adv;
        }
    }
}

/// the uniform: rect, misc, a color per slot
const UNIFORM: u64 = (8 + SLOTS * 4) as u64 * 4;

/// The masks and the frame's shapes into ctx.target.
pub struct Pass {
    gpu: Gpu,
    mask: wgpu::RenderPipeline,
    prims: wgpu::RenderPipeline,
    group: wgpu::BindGroup,
    ubuf: wgpu::Buffer,
    buffer: wgpu::Buffer,
    /// shapes the buffer holds
    cap: usize,
    _atlas: wgpu::Texture,
}

impl Pass {
    /// `shapes`: how many shapes to make room for (more make the buffer grow, once)
    pub fn new(gpu: &Gpu, kgpu: &KinectGpu, painter: &Painter, shapes: usize) -> Result<Self, String> {
        let m = gpu.shader("invaders-tracking", &format!("{FULLSCREEN_WGSL}\n{WGSL}"))?;
        let f = wgpu::ShaderStages::FRAGMENT;
        let bgl = gpu.bind_group_layout("invaders-tracking", &[layout::uint_tex(0, f), layout::float_tex(1, f, false), layout::uniform(2, f | wgpu::ShaderStages::VERTEX)]);
        let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("invaders-tracking"), bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
        let mask = gpu.render_pipeline("invaders-tracking masks", |d| {
            d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("invaders-tracking masks"),
                layout: Some(&pl),
                vertex: wgpu::VertexState { module: &m, entry_point: Some("vs_fullscreen"), compilation_options: Default::default(), buffers: &[] },
                fragment: Some(wgpu::FragmentState {
                    module: &m,
                    entry_point: Some("fs_mask"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState { format: TARGET_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })],
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            })
        })?;
        let blend = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add };
        let prims = gpu.render_pipeline("invaders-tracking shapes", |d| {
            d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("invaders-tracking shapes"),
                layout: Some(&pl),
                vertex: wgpu::VertexState {
                    module: &m,
                    entry_point: Some("vs_prim"),
                    compilation_options: Default::default(),
                    buffers: &[Some(wgpu::VertexBufferLayout {
                        array_stride: PRIM,
                        step_mode: wgpu::VertexStepMode::Instance,
                        attributes: &[
                            wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x4, offset: 0, shader_location: 0 },
                            wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x4, offset: 16, shader_location: 1 },
                            wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x4, offset: 32, shader_location: 2 },
                            wgpu::VertexAttribute { format: wgpu::VertexFormat::Uint32, offset: 48, shader_location: 3 },
                        ],
                    })],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &m,
                    entry_point: Some("fs_prim"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState { format: TARGET_FORMAT, blend: Some(wgpu::BlendState { color: blend, alpha: blend }), write_mask: wgpu::ColorWrites::ALL })],
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            })
        })?;
        let gl = &painter.glyphs;
        let atlas = gpu.texture("invaders-tracking glyphs", ATLAS_W as u32, gl.atlas_h as u32, wgpu::TextureFormat::R8Unorm, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST);
        gpu.write_texture(&atlas, &gl.atlas, 1);
        // the hub's labels of the result shown (the runtime uploads them for every new result)
        let labels = kgpu.person_label_texture();
        let ubuf = gpu.uniform_buffer("invaders-tracking", UNIFORM);
        let mut cols = [0.0_f32; SLOTS * 4];
        for (s, c) in cols.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            let p = person_color(s as u8);
            c.copy_from_slice(&[p[0], p[1], p[2], 1.0]);
        }
        gpu.queue.write_buffer(&ubuf, 32, bytemuck::cast_slice(&cols));
        let atlas_view = atlas.create_view(&Default::default());
        let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("invaders-tracking"),
            layout: &bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&labels) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&atlas_view) },
                wgpu::BindGroupEntry { binding: 2, resource: ubuf.as_entire_binding() },
            ],
        });
        let cap = shapes.max(1024);
        let buffer = gpu.buffer("invaders-tracking shapes", cap as u64 * PRIM, wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST);
        Ok(Self { gpu: gpu.clone(), mask, prims, group, ubuf, buffer, cap, _atlas: atlas })
    }

    /// The picture: the masks into `rect` (LED px: x0, y0, x1, y1) with `alpha` (0: none), the
    /// painter's shapes over them.
    pub fn render(&mut self, ctx: &mut FrameCtx, painter: &Painter, rect: [f32; 4], alpha: f32) {
        let n = painter.prims.len();
        if n > self.cap {
            // more shapes than ever before (a larger map): a larger buffer, once
            self.cap = n.next_power_of_two();
            self.buffer = self.gpu.buffer("invaders-tracking shapes", self.cap as u64 * PRIM, wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST);
        }
        let u = [rect[0], rect[1], rect[2], rect[3], alpha, ctx.width as f32, ctx.height as f32, 0.0];
        ctx.gpu.queue.write_buffer(&self.ubuf, 0, bytemuck::cast_slice(&u));
        if n > 0 {
            ctx.gpu.queue.write_buffer(&self.buffer, 0, bytemuck::cast_slice(&painter.prims));
        }
        let mut pass = crate::gpu::begin_pass(ctx.encoder, "invaders-tracking", ctx.target);
        pass.set_bind_group(0, &self.group, &[]);
        pass.set_pipeline(&self.mask);
        pass.draw(0..3, 0..1);
        if n > 0 {
            pass.set_pipeline(&self.prims);
            pass.set_vertex_buffer(0, self.buffer.slice(..));
            pass.draw(0..6, 0..n as u32);
        }
    }
}
