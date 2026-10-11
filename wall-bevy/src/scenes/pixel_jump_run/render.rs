//! The LED image (the end of main.js frame()): the mosaic scaled up without smoothing, the LED
//! raster over it (black with rounded holes where the cells are), a soft glow on top (the mosaic
//! scaled up smoothly, blurred, added). The browser did it with Canvas 2D drawImage, filters and a
//! raster canvas; here the cell buffer is uploaded as a texture each frame and three fullscreen
//! passes draw it: the glow blurred across and down at half resolution (it is soft, sigma 8 LEDs),
//! then the cells with their rounded holes (coverage computed per pixel) plus the glow.

use crate::gpu::{FULLSCREEN_WGSL, Gpu, TARGET_FORMAT, begin_pass, layout};
use crate::scene::FrameCtx;

use super::art::{Cells, js_round};
use super::{Layout, P};

/// most taps per side of the blur (half resolution texels): 3 sigma for cells up to 26 LEDs (the
/// default wall has at most 20)
const TAPS: usize = 32;
const GLOW_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
/// floats of the uniform (struct U)
const U_FLOATS: usize = 20 + (TAPS / 4 + 1) * 4;

const WGSL: &str = r"
struct U {
  led: vec2f,
  grid: vec2f,      // cells across, down
  origin: vec2f,    // LED px of the mosaic's top left
  texel: vec2f,     // size of the cell texture
  half: vec2f,      // size of the glow textures
  cell: f32,        // LED px per cell
  gap0: f32,        // where the hole starts in its cell
  hole: f32,        // hole size (LED px)
  radius: f32,      // its corner radius
  bright: f32,      // brightness of the cells
  glow: f32,        // strength of the glow (0: none)
  taps: f32,        // blur taps per side
  pad0: f32,
  pad1: f32,
  pad2: f32,
  weights: array<vec4f, 9>,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var cells: texture_2d<f32>;
@group(0) @binding(2) var glowTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

fn weight(k: i32) -> f32 {
  let i = u32(abs(k));
  return u.weights[i / 4u][i % 4u];
}

// the mosaic as drawImage scales it up with smoothing: bilinear, clamped to the cell image, nothing outside
fn mosaic(p: vec2f) -> vec3f {
  let q = p - u.origin;
  let size = u.grid * u.cell;
  if (q.x < 0.0 || q.y < 0.0 || q.x >= size.x || q.y >= size.y) {
    return vec3f(0.0);
  }
  let c = clamp(q / u.cell, vec2f(0.5), u.grid - vec2f(0.5));
  return textureSampleLevel(cells, samp, c / u.texel, 0.0).rgb;
}

// the glow, step 1 (half resolution): blurred across, 2 LEDs per tap
@fragment fn fs_blur_x(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = pos.xy * 2.0;
  let n = i32(u.taps);
  var sum = weight(0) * mosaic(p);
  for (var k = 1; k <= n; k++) {
    let d = vec2f(2.0 * f32(k), 0.0);
    sum += weight(k) * (mosaic(p - d) + mosaic(p + d));
  }
  return vec4f(sum, 1.0);
}

// step 2: blurred down (nothing beyond the edges)
@fragment fn fs_blur_y(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let ip = vec2i(pos.xy);
  let h = i32(u.half.y);
  let n = i32(u.taps);
  var sum = weight(0) * textureLoad(glowTex, ip, 0).rgb;
  for (var k = 1; k <= n; k++) {
    let w = weight(k);
    if (ip.y - k >= 0) {
      sum += w * textureLoad(glowTex, vec2i(ip.x, ip.y - k), 0).rgb;
    }
    if (ip.y + k < h) {
      sum += w * textureLoad(glowTex, vec2i(ip.x, ip.y + k), 0).rgb;
    }
  }
  return vec4f(sum, 1.0);
}

// how much of the pixel at l (from the top left of the hole's box) the rounded hole covers
fn hole(l: vec2f) -> f32 {
  let b = vec2f(u.hole * 0.5);
  let r = min(u.radius, b.x);
  let q = abs(l - b) - b + vec2f(r);
  let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
  return clamp(0.5 - d, 0.0, 1.0);
}

// the LED image: the cells (brightness) through the raster, the glow added
@fragment fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = pos.xy;
  var col = vec3f(0.0);
  let q = p - u.origin;
  let ci = floor(q / u.cell);
  if (ci.x >= 0.0 && ci.y >= 0.0 && ci.x < u.grid.x && ci.y < u.grid.y) {
    let c = textureLoad(cells, vec2i(ci), 0).rgb;
    col = min(c * u.bright, vec3f(1.0)) * hole(q - ci * u.cell - vec2f(u.gap0));
  }
  if (u.glow > 0.0) {
    col += u.glow * textureSampleLevel(glowTex, samp, p / (2.0 * u.half), 0.0).rgb;
  }
  return vec4f(min(col, vec3f(1.0)), 1.0);
}
";

pub struct Render {
    blur_x: wgpu::RenderPipeline,
    blur_y: wgpu::RenderPipeline,
    main: wgpu::RenderPipeline,
    bgl: wgpu::BindGroupLayout,
    uniform: wgpu::Buffer,
    cells: wgpu::Texture,
    cells_size: [u32; 2],
    /// the glow textures (kept with their views)
    _glow: [wgpu::Texture; 2],
    glow_a: wgpu::TextureView,
    glow_b: wgpu::TextureView,
    half: [u32; 2],
    /// bind groups that read glow b (blur across, main) and glow a (blur down)
    read_b: wgpu::BindGroup,
    read_a: wgpu::BindGroup,
    data: [f32; U_FLOATS],
    sigma: f32,
}

fn pipeline(gpu: &Gpu, module: &wgpu::ShaderModule, pl: &wgpu::PipelineLayout, entry: &str, format: wgpu::TextureFormat) -> Result<wgpu::RenderPipeline, String> {
    gpu.render_pipeline(&format!("pixel-jump-run {entry}"), |d| {
        d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(entry),
            layout: Some(pl),
            vertex: wgpu::VertexState { module, entry_point: Some("vs_fullscreen"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        })
    })
}

impl Render {
    /// For an LED image of w x h: the most cells it can have (cells are at least 4 LEDs).
    pub fn new(gpu: &Gpu, w: u32, h: u32) -> Result<Self, String> {
        let module = gpu.shader("pixel-jump-run", &format!("{FULLSCREEN_WGSL}\n{WGSL}"))?;
        let f = wgpu::ShaderStages::FRAGMENT;
        let bgl = gpu.bind_group_layout("pixel-jump-run", &[layout::uniform(0, f), layout::float_tex(1, f, true), layout::float_tex(2, f, true), layout::sampler(3, f, true)]);
        let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("pixel-jump-run"), bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
        let blur_x = pipeline(gpu, &module, &pl, "fs_blur_x", GLOW_FORMAT)?;
        let blur_y = pipeline(gpu, &module, &pl, "fs_blur_y", GLOW_FORMAT)?;
        let main = pipeline(gpu, &module, &pl, "fs_main", TARGET_FORMAT)?;
        let uniform = gpu.uniform_buffer("pixel-jump-run", (U_FLOATS * 4) as u64);
        let cells_size = [(w / 4).max(16), (h / 4).max(8)];
        let cells = gpu.texture("pixel-jump-run cells", cells_size[0], cells_size[1], wgpu::TextureFormat::Rgba8Unorm, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST);
        let half = [w.div_ceil(2).max(1), h.div_ceil(2).max(1)];
        let usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
        let ta = gpu.texture("pixel-jump-run glow a", half[0], half[1], GLOW_FORMAT, usage);
        let tb = gpu.texture("pixel-jump-run glow b", half[0], half[1], GLOW_FORMAT, usage);
        let glow_a = ta.create_view(&Default::default());
        let glow_b = tb.create_view(&Default::default());
        let (read_b, read_a) = Self::groups(gpu, &bgl, &uniform, &cells, &glow_a, &glow_b);
        Ok(Self { blur_x, blur_y, main, bgl, uniform, cells, cells_size, _glow: [ta, tb], glow_a, glow_b, half, read_b, read_a, data: [0.0; U_FLOATS], sigma: -1.0 })
    }

    fn groups(gpu: &Gpu, bgl: &wgpu::BindGroupLayout, uniform: &wgpu::Buffer, cells: &wgpu::Texture, glow_a: &wgpu::TextureView, glow_b: &wgpu::TextureView) -> (wgpu::BindGroup, wgpu::BindGroup) {
        let cv = cells.create_view(&Default::default());
        let samp = gpu.linear_sampler();
        let group = |glow: &wgpu::TextureView| {
            gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("pixel-jump-run"),
                layout: bgl,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&cv) },
                    wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(glow) },
                    wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&samp) },
                ],
            })
        };
        (group(glow_b), group(glow_a))
    }

    /// The gaussian of the glow: blur(round(cell · 0.8) px), sampled every 2 LEDs.
    fn weights(&mut self, sigma: f32) {
        if sigma == self.sigma {
            return;
        }
        self.sigma = sigma;
        let s = sigma / 2.0; // in half resolution texels
        let n = if s > 0.05 { ((3.0 * s).ceil() as usize).min(TAPS) } else { 0 };
        let w = &mut self.data[20..];
        w.fill(0.0);
        let mut total = 0.0;
        for (k, wk) in w.iter_mut().enumerate().take(n + 1) {
            let v = if n == 0 { 1.0 } else { (-((k * k) as f32) / (2.0 * s * s)).exp() };
            *wk = v;
            total += if k == 0 { v } else { 2.0 * v };
        }
        for v in &mut w[..=n] {
            *v /= total;
        }
        self.data[16] = n as f32;
    }

    /// Uploads the mosaic and draws the LED image into ctx.target.
    pub fn render(&mut self, ctx: &mut FrameCtx, cells: &Cells, l: &Layout, p: &P) {
        let gpu = ctx.gpu;
        let (gw, gh) = (cells.w.max(1) as u32, cells.h.max(1) as u32);
        if gw > self.cells_size[0] || gh > self.cells_size[1] {
            // a grid larger than planned (another wall): a texture of its size, once
            self.cells_size = [gw.max(self.cells_size[0]), gh.max(self.cells_size[1])];
            self.cells =
                gpu.texture("pixel-jump-run cells", self.cells_size[0], self.cells_size[1], wgpu::TextureFormat::Rgba8Unorm, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST);
            (self.read_b, self.read_a) = Self::groups(gpu, &self.bgl, &self.uniform, &self.cells, &self.glow_a, &self.glow_b);
        }
        if cells.data.len() >= (gw * gh * 4) as usize {
            gpu.queue.write_texture(
                wgpu::TexelCopyTextureInfo { texture: &self.cells, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                &cells.data,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(gw * 4), rows_per_image: Some(gh) },
                wgpu::Extent3d { width: gw, height: gh, depth_or_array_layers: 1 },
            );
        }
        // the raster: holes of cell - gap LEDs with rounded corners (makeRaster)
        let gap = js_round(f64::from(l.cell_px) * p.gap_frac).max(1.0);
        let size = f64::from(l.cell_px) - gap;
        let radius = (size / 2.0).min(size * p.round);
        let glow = if p.glow > 0.0 { p.glow.min(1.0) * p.brightness * 0.6 } else { 0.0 };
        self.weights(js_round(f64::from(l.cell_px) * 0.8) as f32);
        let d = &mut self.data;
        d[..16].copy_from_slice(&[
            ctx.width as f32,
            ctx.height as f32,
            gw as f32,
            gh as f32,
            l.ox as f32,
            l.oy as f32,
            self.cells_size[0] as f32,
            self.cells_size[1] as f32,
            self.half[0] as f32,
            self.half[1] as f32,
            l.cell_px as f32,
            (gap / 2.0).floor() as f32,
            size as f32,
            radius as f32,
            p.brightness as f32,
            glow as f32,
        ]);
        gpu.queue.write_buffer(&self.uniform, 0, bytemuck::cast_slice(&self.data));
        if glow > 0.0 {
            {
                let mut pass = begin_pass(ctx.encoder, "pixel-jump-run blur x", &self.glow_a);
                pass.set_pipeline(&self.blur_x);
                pass.set_bind_group(0, &self.read_b, &[]);
                pass.draw(0..3, 0..1);
            }
            let mut pass = begin_pass(ctx.encoder, "pixel-jump-run blur y", &self.glow_b);
            pass.set_pipeline(&self.blur_y);
            pass.set_bind_group(0, &self.read_a, &[]);
            pass.draw(0..3, 0..1);
        }
        let mut pass = begin_pass(ctx.encoder, "pixel-jump-run", ctx.target);
        pass.set_pipeline(&self.main);
        pass.set_bind_group(0, &self.read_b, &[]);
        pass.draw(0..3, 0..1);
    }
}
