//! Text over a scene: the HTML the browser scenes lay over their canvas (person tags, greetings).
//! Each label is painted once into a small premultiplied image (text, a background box, a glow as
//! CSS text-shadow) and cached by text and color; per frame the labels are blended into an
//! LED-size overlay, uploaded and drawn over the scene's picture. While there is nothing to show,
//! nothing is drawn or uploaded.

use std::collections::HashMap;
use std::sync::Arc;

use crate::canvas::{Font, measure_text_spaced, text_coverage_spaced};
use crate::gpu::{FULLSCREEN_WGSL, Gpu, TARGET_FORMAT, layout};
use crate::scene::FrameCtx;

/// How a label looks (its CSS).
pub struct LabelStyle {
    pub font: Font,
    /// letter-spacing (em)
    pub spacing: f32,
    /// line-height (factor of the font size)
    pub line_height: f32,
    /// padding x, y (px)
    pub pad: [f32; 2],
    /// border-radius (px)
    pub radius: f32,
    /// background, premultiplied later: [r, g, b, a]
    pub background: Option<[f32; 4]>,
    /// text-shadow blur radius (px) in the text's color, 0 = none
    pub glow: f32,
}

/// A painted label: premultiplied RGBA (0..1), the box inside it (the glow reaches beyond).
pub struct LabelSprite {
    pub w: i32,
    pub h: i32,
    /// the box's bottom centre in the sprite
    pub anchor: [i32; 2],
    /// the box: x, y, w, h in the sprite
    pub frame: [i32; 4],
    pub px: Vec<[f32; 4]>,
}

pub struct TextOverlay {
    gpu: Gpu,
    w: u32,
    h: u32,
    canvas: Vec<u8>,
    tex: wgpu::Texture,
    pipeline: wgpu::RenderPipeline,
    group: wgpu::BindGroup,
    cache: HashMap<(String, [u8; 3]), Arc<LabelSprite>>,
    /// something was blended in this frame
    drawn: bool,
    /// the texture holds labels (needs one more clear upload when they are gone)
    shown: bool,
}

const WGSL: &str = r"
@group(0) @binding(0) var over: texture_2d<f32>;
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return textureLoad(over, vec2i(pos.xy), 0); // premultiplied
}
";

impl TextOverlay {
    pub fn new(gpu: &Gpu, w: u32, h: u32) -> Result<Self, String> {
        let m = gpu.shader("text overlay", &format!("{FULLSCREEN_WGSL}\n{WGSL}"))?;
        let bgl = gpu.bind_group_layout("text overlay", &[layout::float_tex(0, wgpu::ShaderStages::FRAGMENT, false)]);
        let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("text overlay"), bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
        let blend = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add };
        let pipeline = gpu.render_pipeline("text overlay", |d| {
            d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("text overlay"),
                layout: Some(&pl),
                vertex: wgpu::VertexState { module: &m, entry_point: Some("vs_fullscreen"), compilation_options: Default::default(), buffers: &[] },
                fragment: Some(wgpu::FragmentState {
                    module: &m,
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
        let tex = gpu.texture("text overlay", w, h, wgpu::TextureFormat::Rgba8Unorm, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST);
        let view = tex.create_view(&Default::default());
        let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("text overlay"),
            layout: &bgl,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) }],
        });
        Ok(Self { gpu: gpu.clone(), w, h, canvas: vec![0; (w * h * 4) as usize], tex, pipeline, group, cache: HashMap::new(), drawn: false, shown: false })
    }

    /// A label whose box has its bottom centre at (x, y) (LED px), with opacity `alpha`.
    pub fn label(&mut self, text: &str, style: &LabelStyle, color: [f32; 3], x: f32, y: f32, alpha: f32) {
        if alpha <= 0.0 || text.is_empty() || !x.is_finite() || !y.is_finite() {
            return;
        }
        if !self.drawn {
            // the first label of this frame: the overlay starts empty
            self.canvas.fill(0);
            self.drawn = true;
        }
        let key = (text.to_string(), color.map(|c| (c.clamp(0.0, 1.0) * 255.0).round() as u8));
        let sprite = match self.cache.get(&key) {
            Some(s) => s.clone(),
            None => {
                if self.cache.len() > 128 {
                    self.cache.clear();
                }
                let s = Arc::new(paint_label(text, style, color));
                self.cache.insert(key, s.clone());
                s
            }
        };
        let left = x.round() as i32 - sprite.anchor[0];
        let top = y.round() as i32 - sprite.anchor[1];
        let (w, h) = (self.w as i32, self.h as i32);
        let a = alpha.clamp(0.0, 1.0);
        for sy in 0..sprite.h {
            let py = top + sy;
            if py < 0 || py >= h {
                continue;
            }
            for sx in 0..sprite.w {
                let px = left + sx;
                if px < 0 || px >= w {
                    continue;
                }
                let Some(s) = sprite.px.get((sy * sprite.w + sx) as usize) else { continue };
                if s[3] <= 0.0 {
                    continue;
                }
                let i = ((py * w + px) * 4) as usize;
                let Some(d) = self.canvas.get_mut(i..i + 4) else { continue };
                // source-over, premultiplied
                let k = 1.0 - s[3] * a;
                for c in 0..4 {
                    d[c] = (s[c] * a * 255.0 + f32::from(d[c]) * k).round().clamp(0.0, 255.0) as u8;
                }
            }
        }
    }

    /// Uploads this frame's labels and draws them over ctx.target.
    pub fn draw(&mut self, ctx: &mut FrameCtx) {
        if !self.drawn && !self.shown {
            return;
        }
        if !self.drawn {
            // the labels are gone: one empty upload
            self.canvas.fill(0);
        }
        self.gpu.write_texture(&self.tex, &self.canvas, 4);
        self.shown = self.drawn;
        self.drawn = false;
        let mut pass = ctx.encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("text overlay"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: ctx.target,
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
        pass.draw(0..3, 0..1);
    }
}

/// Paints a label: the box (background, rounded), the glow (blurred text in its color), the text.
pub fn paint_label(text: &str, style: &LabelStyle, color: [f32; 3]) -> LabelSprite {
    let s = style.font.size;
    let (tw, th, base, cov) = text_coverage_spaced(text, &style.font, style.spacing);
    let text_w = measure_text_spaced(text, &style.font, style.spacing);
    let box_w = (text_w + 2.0 * style.pad[0]).ceil().max(1.0) as i32;
    let box_h = (s * style.line_height + 2.0 * style.pad[1]).ceil().max(1.0) as i32;
    // room for the glow around the box
    let m = (style.glow * 1.5).ceil() as i32;
    let (w, h) = (box_w + 2 * m, box_h + 2 * m);
    let mut px = vec![[0.0f32; 4]; (w * h) as usize];
    // the background box
    if let Some(bg) = style.background {
        let (hw, hh) = (box_w as f32 / 2.0, box_h as f32 / 2.0);
        let r = style.radius.min(hw).min(hh);
        for y in 0..box_h {
            for x in 0..box_w {
                // rounded box: signed distance, anti-aliased edge
                let qx = ((x as f32 + 0.5 - hw).abs() - (hw - r)).max(0.0);
                let qy = ((y as f32 + 0.5 - hh).abs() - (hh - r)).max(0.0);
                let d = (qx * qx + qy * qy).sqrt() - r;
                let a = (0.5 - d).clamp(0.0, 1.0) * bg[3];
                if let Some(p) = px.get_mut(((y + m) * w + x + m) as usize) {
                    *p = [bg[0] * a, bg[1] * a, bg[2] * a, a];
                }
            }
        }
    }
    // the text's place: CSS centres ascent + descent in the line box (line-height); the coverage
    // comes from a line of 1.25 size laid out the same way
    let pad_cov = (s * 0.5).ceil() as i32;
    let line_y = base - pad_cov;
    let baseline = m as f32 + style.pad[1] + line_y as f32 + (style.line_height - 1.25) * s / 2.0;
    let ox = m as f32 + style.pad[0];
    let oy = baseline.round() as i32 - base;
    let mut layer = vec![0.0f32; (w * h) as usize];
    for y in 0..th as i32 {
        for x in 0..tw as i32 {
            let Some(&c) = cov.get((y * tw as i32 + x) as usize) else { continue };
            if c == 0 {
                continue;
            }
            let (lx, ly) = (ox.round() as i32 + x, oy + y);
            if lx >= 0 && lx < w && ly >= 0 && ly < h {
                layer[(ly * w + lx) as usize] = f32::from(c) / 255.0;
            }
        }
    }
    // the glow (text-shadow: 0 0 B currentColor; a Gaussian with sigma B / 2)
    if style.glow > 0.0 {
        let glow = blur(&layer, w as usize, h as usize, style.glow / 2.0);
        over(&mut px, &glow, color);
    }
    over(&mut px, &layer, color);
    LabelSprite { w, h, anchor: [m + box_w / 2, m + box_h], frame: [m, m, box_w, box_h], px }
}

/// `cov` in `color`, source-over onto premultiplied `px`.
fn over(px: &mut [[f32; 4]], cov: &[f32], color: [f32; 3]) {
    for (p, &a) in px.iter_mut().zip(cov) {
        if a <= 0.0 {
            continue;
        }
        let k = 1.0 - a;
        *p = [color[0] * a + p[0] * k, color[1] * a + p[1] * k, color[2] * a + p[2] * k, a + p[3] * k];
    }
}

/// Separable Gaussian blur.
fn blur(src: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    let r = (sigma * 3.0).ceil().max(1.0) as isize;
    let kernel: Vec<f32> = (-r..=r).map(|i| (-(i as f32).powi(2) / (2.0 * sigma * sigma)).exp()).collect();
    let sum: f32 = kernel.iter().sum();
    let kernel: Vec<f32> = kernel.iter().map(|k| k / sum).collect();
    let mut tmp = vec![0.0f32; w * h];
    let mut out = vec![0.0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (k, kv) in kernel.iter().enumerate() {
                let xx = x as isize + k as isize - r;
                if xx >= 0 && (xx as usize) < w {
                    acc += src[y * w + xx as usize] * kv;
                }
            }
            tmp[y * w + x] = acc;
        }
    }
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (k, kv) in kernel.iter().enumerate() {
                let yy = y as isize + k as isize - r;
                if yy >= 0 && (yy as usize) < h {
                    acc += tmp[yy as usize * w + x] * kv;
                }
            }
            out[y * w + x] = acc.min(1.0);
        }
    }
    out
}

/// CSS cubic-bezier(x1, y1, x2, y2) at t.
pub fn bezier(x1: f32, y1: f32, x2: f32, y2: f32, t: f32) -> f32 {
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }
    let bx = |s: f32| 3.0 * (1.0 - s) * (1.0 - s) * s * x1 + 3.0 * (1.0 - s) * s * s * x2 + s * s * s;
    let by = |s: f32| 3.0 * (1.0 - s) * (1.0 - s) * s * y1 + 3.0 * (1.0 - s) * s * s * y2 + s * s * s;
    let (mut lo, mut hi) = (0.0, 1.0);
    for _ in 0..24 {
        let mid = (lo + hi) / 2.0;
        if bx(mid) < t {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    by((lo + hi) / 2.0)
}

/// CSS ease-out
pub fn ease_out(t: f32) -> f32 {
    bezier(0.0, 0.0, 0.58, 1.0, t)
}
