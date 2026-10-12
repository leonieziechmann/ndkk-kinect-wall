//! The id and height above every person (main.js updateTags(): HTML on top of the canvas, which the
//! wall showed): a dark box with a border in the person's color, the id in bold with a glow
//! (text-shadow 0 0 10px), the height in light blue. The glyphs of the CSS fonts are rendered once
//! in make(), with the line boxes and letter spacing of the CSS; every frame the tags are put
//! together from quads (nothing is rendered or allocated in the frame).

use std::fmt::Write;

use wall::canvas::{Font, measure_text, text_coverage};
use wall::gpu::{Gpu, TARGET_FORMAT, layout};
use wall::persons::{PERSON_COLORS, hex_rgb};

/// .nr-tag: font 500 13px/1.25 ui-monospace, 'Cascadia Mono', Consolas, monospace; b: 700 15px
const FAMILY: &str = "ui-monospace, 'Cascadia Mono', Consolas, monospace";
const ID_SIZE: f32 = 15.0;
const TEXT_SIZE: f32 = 13.0;
const LINE: f32 = 1.25;
/// letter-spacing 0.08em of the 13px font (inherited as a length by both texts)
const SPACING: f32 = 0.08 * TEXT_SIZE;
/// border-left, padding (top, right, bottom, left), gap
const BORDER: f32 = 2.0;
const PAD: [f32; 4] = [2.0, 9.0, 3.0, 9.0];
const GAP: f32 = 8.0;
const BOX: [f32; 4] = [2.0 / 255.0, 4.0 / 255.0, 10.0 / 255.0, 0.55];
const TEXT_COLOR: &str = "#cfe8ff";
const TEXT_ALPHA: f32 = 0.85;
/// text-shadow blur 10px: a Gaussian of half that (CSS), 3 sigma around every glyph
const SIGMA: f32 = 5.0;
const GLOW_PAD: usize = 15;
/// the characters of an id (padStart(2, '0')) and of a height (toFixed(2), ',' for '.', ' m', NaN)
const ID_CHARS: &str = "0123456789";
const TEXT_CHARS: &str = "0123456789,-mNa";
const ATLAS_W: usize = 512;
const MAX_QUADS: usize = 2048;
const FLOATS: usize = 12; // rect (px), atlas cell (texels), rgba

const WGSL: &str = r"
@group(0) @binding(0) var<uniform> res: vec4f;
@group(0) @binding(1) var atlas: texture_2d<f32>;
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) col: vec4f, };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) rect: vec4f, @location(1) cell: vec4f, @location(2) col: vec4f) -> VOut {
  var corner = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let c = corner[vi];
  let p = rect.xy + c * rect.zw;
  var out: VOut;
  out.pos = vec4f(p.x / res.x * 2.0 - 1.0, 1.0 - p.y / res.y * 2.0, 0.0, 1.0);
  out.uv = cell.xy + c * cell.zw;
  out.col = col;
  return out;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let a = in.col.a * textureLoad(atlas, vec2i(floor(in.uv)), 0).r;
  return vec4f(in.col.rgb * a, a);
}
";

/// A glyph in the atlas: its cell (texels), the baseline in the cell, the advance (px).
#[derive(Clone, Copy, Default)]
struct Glyph {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    base: f32,
    adv: f32,
}

/// Coverage cells packed into rows of the atlas.
struct Packer {
    data: Vec<u8>,
    x: usize,
    y: usize,
    row_h: usize,
}

impl Packer {
    fn put(&mut self, w: usize, h: usize, cov: &[u8]) -> (usize, usize) {
        if self.x + w > ATLAS_W {
            self.x = 0;
            self.y += self.row_h + 1;
            self.row_h = 0;
        }
        let (x0, y0) = (self.x, self.y);
        let need = (y0 + h) * ATLAS_W;
        if self.data.len() < need {
            self.data.resize(need, 0);
        }
        for yy in 0..h {
            let (src, dst) = (yy * w, (y0 + yy) * ATLAS_W + x0);
            if let (Some(s), Some(d)) = (cov.get(src..src + w), self.data.get_mut(dst..dst + w)) {
                d.copy_from_slice(s);
            }
        }
        self.x += w + 1;
        self.row_h = self.row_h.max(h);
        (x0, y0)
    }
}

/// The coverage blurred like a text-shadow, with GLOW_PAD around it.
fn glow(w: usize, h: usize, cov: &[u8]) -> (usize, usize, Vec<u8>) {
    let (bw, bh) = (w + 2 * GLOW_PAD, h + 2 * GLOW_PAD);
    let mut a = vec![0.0_f32; bw * bh];
    for y in 0..h {
        for x in 0..w {
            a[(y + GLOW_PAD) * bw + x + GLOW_PAD] = f32::from(cov.get(y * w + x).copied().unwrap_or(0)) / 255.0;
        }
    }
    let r = GLOW_PAD as i32;
    let mut k: Vec<f32> = (-r..=r).map(|i| (-((i * i) as f32) / (2.0 * SIGMA * SIGMA)).exp()).collect();
    let sum: f32 = k.iter().sum();
    k.iter_mut().for_each(|v| *v /= sum);
    let mut b = vec![0.0_f32; bw * bh];
    for y in 0..bh {
        for x in 0..bw {
            let mut s = 0.0;
            for (j, kv) in k.iter().enumerate() {
                let xx = x as i32 + j as i32 - r;
                if xx >= 0 && (xx as usize) < bw {
                    s += a[y * bw + xx as usize] * kv;
                }
            }
            b[y * bw + x] = s;
        }
    }
    let mut out = vec![0u8; bw * bh];
    for y in 0..bh {
        for x in 0..bw {
            let mut s = 0.0;
            for (j, kv) in k.iter().enumerate() {
                let yy = y as i32 + j as i32 - r;
                if yy >= 0 && (yy as usize) < bh {
                    s += b[yy as usize * bw + x] * kv;
                }
            }
            out[y * bw + x] = (s * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
    (bw, bh, out)
}

/// A character of `font` in the atlas (and its glow).
fn glyph(p: &mut Packer, c: char, font: &Font, with_glow: bool) -> (Glyph, Glyph) {
    let s = c.to_string();
    let (w, h, base, cov) = text_coverage(&s, font);
    let adv = measure_text(&s, font);
    let (w, h) = (w as usize, h as usize);
    let (x, y) = p.put(w, h, &cov);
    let g = Glyph { x: x as f32, y: y as f32, w: w as f32, h: h as f32, base: base as f32, adv };
    let mut shadow = Glyph::default();
    if with_glow {
        let (bw, bh, blurred) = glow(w, h, &cov);
        let (x, y) = p.put(bw, bh, &blurred);
        shadow = Glyph { x: x as f32, y: y as f32, w: bw as f32, h: bh as f32, base: base as f32 + GLOW_PAD as f32, adv };
    }
    (g, shadow)
}

/// The baseline in a line box of LINE x size: text_coverage() puts the line (cosmic-text centers
/// ascent + descent in it, as CSS does) ceil(size / 2) below the top of its box.
fn line_baseline(g: &Glyph, size: f32) -> f32 {
    g.base - (size * 0.5).ceil()
}

pub struct Tags {
    pipeline: wgpu::RenderPipeline,
    group: wgpu::BindGroup,
    res: wgpu::Buffer,
    buffer: wgpu::Buffer,
    data: Vec<f32>,
    n: usize,
    ids: [Glyph; 10],
    glows: [Glyph; 10],
    texts: [Glyph; 15],
    /// baseline below the top of the content box, the content height
    above: f32,
    content_h: f32,
    text: String,
    _atlas: wgpu::Texture,
}

impl Tags {
    pub fn new(gpu: &Gpu) -> Result<Self, String> {
        let id_font = Font::new(FAMILY, ID_SIZE, 700);
        let text_font = Font::new(FAMILY, TEXT_SIZE, 500);
        let mut p = Packer { data: vec![0; ATLAS_W], x: 0, y: 0, row_h: 0 };
        // one white texel for the solid boxes
        p.put(1, 1, &[255]);
        let mut ids = [Glyph::default(); 10];
        let mut glows = [Glyph::default(); 10];
        for (i, c) in ID_CHARS.chars().enumerate() {
            (ids[i], glows[i]) = glyph(&mut p, c, &id_font, true);
        }
        let mut texts = [Glyph::default(); 15];
        for (i, c) in TEXT_CHARS.chars().enumerate() {
            texts[i] = glyph(&mut p, c, &text_font, false).0;
        }
        // display: flex, align-items: baseline: both line boxes on one baseline
        let (bl_id, bl_text) = (line_baseline(&ids[0], ID_SIZE), line_baseline(&texts[0], TEXT_SIZE));
        let above = bl_id.max(bl_text);
        let content_h = (above - bl_id + LINE * ID_SIZE).max(above - bl_text + LINE * TEXT_SIZE);

        let ah = (p.y + p.row_h + 1).max(1);
        p.data.resize(ATLAS_W * ah, 0);
        let atlas = gpu.texture("neon-room tags", ATLAS_W as u32, ah as u32, wgpu::TextureFormat::R8Unorm, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST);
        gpu.write_texture(&atlas, &p.data, 1);
        let module = gpu.shader("neon-room tags", WGSL)?;
        let bgl = gpu.bind_group_layout("neon-room tags", &[layout::uniform(0, wgpu::ShaderStages::VERTEX), layout::float_tex(1, wgpu::ShaderStages::FRAGMENT, false)]);
        let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("neon-room tags"), bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
        let blend = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add };
        let pipeline = gpu.render_pipeline("neon-room tags", |d| {
            d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("neon-room tags"),
                layout: Some(&pl),
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some("vs"),
                    compilation_options: Default::default(),
                    buffers: &[Some(wgpu::VertexBufferLayout {
                        array_stride: (FLOATS * 4) as u64,
                        step_mode: wgpu::VertexStepMode::Instance,
                        attributes: &[
                            wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x4, offset: 0, shader_location: 0 },
                            wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x4, offset: 16, shader_location: 1 },
                            wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x4, offset: 32, shader_location: 2 },
                        ],
                    })],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some("fs"),
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
        let res = gpu.uniform_buffer("neon-room tags res", 16);
        let buffer = gpu.buffer("neon-room tags", (MAX_QUADS * FLOATS * 4) as u64, wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST);
        let view = atlas.create_view(&Default::default());
        let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("neon-room tags"),
            layout: &bgl,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: res.as_entire_binding() }, wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&view) }],
        });
        Ok(Self {
            pipeline,
            group,
            res,
            buffer,
            data: vec![0.0; MAX_QUADS * FLOATS],
            n: 0,
            ids,
            glows,
            texts,
            above,
            content_h,
            text: String::with_capacity(32),
            _atlas: atlas,
        })
    }

    pub fn begin(&mut self) {
        self.n = 0;
    }

    fn quad(&mut self, rect: [f32; 4], cell: [f32; 4], col: [f32; 4]) {
        let Some(d) = self.data.get_mut(self.n * FLOATS..(self.n + 1) * FLOATS) else { return };
        d[0..4].copy_from_slice(&rect);
        d[4..8].copy_from_slice(&cell);
        d[8..12].copy_from_slice(&col);
        self.n += 1;
    }

    fn glyph_quad(&mut self, g: Glyph, x: f32, baseline: f32, col: [f32; 4]) {
        self.quad([x, baseline - g.base, g.w, g.h], [g.x, g.y, g.w, g.h], col);
    }

    /// The tag of a person whose head (+ 0.28 m) is at `s` (LED px): its bottom center there.
    pub fn add(&mut self, id: u32, slot: u8, height: f64, s: [f32; 2]) {
        let c = hex_rgb(PERSON_COLORS.get(usize::from(slot)).copied().unwrap_or(PERSON_COLORS[0]));
        let col = [c[0], c[1], c[2], 1.0];
        let tc = hex_rgb(TEXT_COLOR);
        let tcol = [tc[0], tc[1], tc[2], TEXT_ALPHA];
        let (ids, glows, texts) = (self.ids, self.glows, self.texts);
        // the texts: String(id).padStart(2, '0') and `${height.toFixed(2).replace('.', ',')} m`
        let mut text = std::mem::take(&mut self.text);
        text.clear();
        let _ = write!(text, "{id:02}");
        let id_len = text.len();
        let _ = write!(text, "{:.2} m", if height == 0.0 { 0.0 } else { height });
        let (id_text, h_text) = text.split_at(id_len);
        let digit = |ch: char| ch.to_digit(10).map(|d| d as usize).filter(|d| *d < ids.len());
        // other characters (the space) advance like a digit: the font is monospace
        let text_glyph = |ch: char| TEXT_CHARS.chars().position(|t| t == if ch == '.' { ',' } else { ch }).and_then(|i| texts.get(i).copied());
        let id_w: f32 = id_text.chars().filter_map(digit).map(|d| ids[d].adv + SPACING).sum();
        let h_w: f32 = h_text.chars().map(|ch| text_glyph(ch).map_or(texts[0].adv, |g| g.adv) + SPACING).sum();
        // the border box, translate(-50%, -100%)
        let w = BORDER + PAD[3] + id_w + GAP + h_w + PAD[1];
        let h = PAD[0] + self.content_h + PAD[2];
        let (left, top) = ((s[0] - w / 2.0).round(), (s[1] - h).round());
        let baseline = top + PAD[0] + self.above.round();
        let solid = [0.5, 0.5, 0.0, 0.0];
        self.quad([left, top, w.round(), h.round()], solid, BOX);
        self.quad([left, top, BORDER, h.round()], solid, col);
        // the id: its glow under it, then the glyphs
        let x0 = left + BORDER + PAD[3];
        let mut pen = x0;
        for d in id_text.chars().filter_map(digit) {
            self.glyph_quad(glows[d], pen.round() - GLOW_PAD as f32, baseline, col);
            pen += ids[d].adv + SPACING;
        }
        pen = x0;
        for d in id_text.chars().filter_map(digit) {
            self.glyph_quad(ids[d], pen.round(), baseline, col);
            pen += ids[d].adv + SPACING;
        }
        // the height
        pen = x0 + id_w + GAP;
        for ch in h_text.chars() {
            match text_glyph(ch) {
                Some(g) => {
                    self.glyph_quad(g, pen.round(), baseline, tcol);
                    pen += g.adv + SPACING;
                }
                None => pen += texts[0].adv + SPACING,
            }
        }
        self.text = text;
    }

    /// Draws the tags of this frame over `target`.
    pub fn render(&mut self, gpu: &Gpu, enc: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, size: [u32; 2]) {
        if self.n == 0 {
            return;
        }
        gpu.queue.write_buffer(&self.res, 0, bytemuck::cast_slice(&[size[0] as f32, size[1] as f32, 0.0, 0.0]));
        gpu.queue.write_buffer(&self.buffer, 0, bytemuck::cast_slice(&self.data[..self.n * FLOATS]));
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("neon-room tags"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.group, &[]);
        pass.set_vertex_buffer(0, self.buffer.slice(..));
        pass.draw(0..6, 0..self.n as u32);
    }
}
