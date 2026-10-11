//! The renderer (render.js, wgpu): the map floor with its hex grid, lit by the game's lights; over it
//! the crisp pixel layer of the game (at LED resolution: blocks placed to the LED, see pixels.rs
//! Pix); then bloom in two sizes, distortion ripples, color fringes and flashes.
//!
//! Made for an LED wall with 5.9 mm pitch: nothing finer than a few LEDs repeats regularly (no 1-LED
//! lines, no raster, no dither), so neither the LED grid nor a camera sees moiré. The hex lines are
//! soft and 2-3 LEDs wide at a period of ~36 LEDs; the fog edge and the glows are smooth.
//!
//! Passes: light map (one texel per art pixel: light is smooth) -> scene (W x H) -> bright parts
//! down to 1/4 -> blur -> down to 1/8 -> blur -> final. The WGSL is render.js's, unchanged.

use crate::gpu::{Gpu, TARGET_FORMAT, begin_pass, layout};
use crate::scene::FrameCtx;

use super::Layout;

pub const MAX_LIGHTS: usize = 128;
const HDR: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
/// floats of the uniform (struct U)
const U_FLOATS: usize = 56;

const WGSL: &str = r"
struct U {
  res: vec2f, art: vec2f, off: vec2f, S: f32, time: f32,
  scale: vec2f, shake: vec2f,
  flash: vec4f,
  hex: f32, pulse: f32, nLights: f32, nRipples: f32,
  chroma: f32, bloom: f32, bloomWide: f32, brightness: f32,
  ripples: array<vec4f, 8>,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

// ---- the light map: every light summed up per art pixel
@group(1) @binding(0) var<storage, read> lights: array<vec4f>;
@fragment fn lightmap(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let art = pos.xy;
  var light = vec3f(0.0);
  let nl = u32(u.nLights);
  for (var i = 0u; i < nl; i++) {
    let a = lights[i * 2u];
    let c = lights[i * 2u + 1u];
    let d = (art - a.xy) / u.scale / max(a.z, 0.01);
    let d2 = dot(d, d);
    if (d2 < 1.0) {
      let f = (1.0 - d2);
      light += c.rgb * a.w * f * f;
    }
  }
  return vec4f(light, 1.0);
}

// ---- scene: floor + lights + the game's pixels
@group(1) @binding(1) var artTex: texture_2d<f32>;
@group(1) @binding(2) var fogTex: texture_2d<f32>;
@group(1) @binding(7) var lightTex: texture_2d<f32>;

fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1.0, 0.0)), w.x), mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), w.x), w.y);
}
// pointy-top hexagons: distance (in hex units, across flats = 1) to the nearest edge
const HS = vec2f(1.0, 1.7320508);
fn hexEdge(p: vec2f) -> f32 {
  let hc = floor(vec4f(p, p - vec2f(0.5, 1.0)) / HS.xyxy) + 0.5;
  let h = vec4f(p - hc.xy * HS, p - (hc.zw + 0.5) * HS);
  let l = select(h.zw, h.xy, dot(h.xy, h.xy) < dot(h.zw, h.zw));
  let q = abs(l);
  return 0.5 - max(dot(q, HS * 0.5), q.x);
}

@fragment fn scene(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let art = (pos.xy - u.off - u.shake) / u.S;
  let auv = art / u.art;
  let fog = textureSampleLevel(fogTex, samp, auv, 0.0).r;
  // the floor: almost black, a faint large-scale texture (no fine pattern)
  let n = noise(art * 0.025) * 0.65 + noise(art * 0.06 + 17.0) * 0.35;
  let base = vec3f(0.006, 0.004, 0.02) * (0.5 + n) * mix(0.35, 1.0, fog);
  // hex lines: 12 art px across, soft and about 2-3 LEDs wide
  let hexSize = 12.0;
  let e = hexEdge(art / hexSize) * hexSize;
  let line = (1.0 - smoothstep(0.25, 0.9, e)) * fog;
  // the lights (from the light map, filtered: smooth between the art pixels)
  let light = textureSampleLevel(lightTex, samp, auv, 0.0).rgb;
  let gridCol = vec3f(0.3, 0.42, 1.0);
  var col = base + light * (0.07 + line * 1.5) + gridCol * line * u.hex * (0.03 + 0.05 * u.pulse);
  // the game's pixels (one texel per LED)
  let ai = vec2i(floor(pos.xy - u.shake));
  if (all(ai >= vec2i(0)) && all(ai < vec2i(u.res))) {
    let px = textureLoad(artTex, ai, 0);
    col = mix(col, px.rgb * (1.0 + light * 0.25), px.a);
  }
  return vec4f(col, 1.0);
}

// ---- bloom
@group(1) @binding(3) var src: texture_2d<f32>;
fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
// 4 x 4 (2 x 2 linear taps) down, only what is bright
@fragment fn down4(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(src));
  let uv = pos.xy * 4.0 / size;
  let t = 1.0 / size;
  var c = vec3f(0.0);
  c += textureSampleLevel(src, samp, uv + vec2f(-1.0, -1.0) * t, 0.0).rgb;
  c += textureSampleLevel(src, samp, uv + vec2f(1.0, -1.0) * t, 0.0).rgb;
  c += textureSampleLevel(src, samp, uv + vec2f(-1.0, 1.0) * t, 0.0).rgb;
  c += textureSampleLevel(src, samp, uv + vec2f(1.0, 1.0) * t, 0.0).rgb;
  c *= 0.25;
  let k = smoothstep(0.3, 0.85, lum(c));
  return vec4f(c * k, 1.0);
}
@fragment fn down2(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(src));
  let uv = pos.xy * 2.0 / size;
  return vec4f(textureSampleLevel(src, samp, uv, 0.0).rgb, 1.0);
}
const W0 = 0.2270270270;
const W1 = 0.3162162162;
const W2 = 0.0702702703;
fn blur(pos: vec2f, dir: vec2f) -> vec4f {
  let size = vec2f(textureDimensions(src));
  let uv = pos / size;
  let t = dir / size;
  var c = textureSampleLevel(src, samp, uv, 0.0).rgb * W0;
  c += textureSampleLevel(src, samp, uv + t * 1.3846153846, 0.0).rgb * W1;
  c += textureSampleLevel(src, samp, uv - t * 1.3846153846, 0.0).rgb * W1;
  c += textureSampleLevel(src, samp, uv + t * 3.2307692308, 0.0).rgb * W2;
  c += textureSampleLevel(src, samp, uv - t * 3.2307692308, 0.0).rgb * W2;
  return vec4f(c, 1.0);
}
@fragment fn blurH(@builtin(position) pos: vec4f) -> @location(0) vec4f { return blur(pos.xy, vec2f(1.0, 0.0)); }
@fragment fn blurV(@builtin(position) pos: vec4f) -> @location(0) vec4f { return blur(pos.xy, vec2f(0.0, 1.0)); }

// ---- final: ripples, color fringes, bloom, flash
@group(1) @binding(4) var sceneTex: texture_2d<f32>;
@group(1) @binding(5) var b4: texture_2d<f32>;
@group(1) @binding(6) var b8: texture_2d<f32>;
@fragment fn finish(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var off = vec2f(0.0);
  let nr = u32(u.nRipples);
  for (var i = 0u; i < nr; i++) {
    let r = u.ripples[i];
    let d = pos.xy - r.xy;
    let dist = max(length(d), 1e-3);
    let k = exp(-pow((dist - r.z) / 22.0, 2.0));
    off += d / dist * r.w * k;
  }
  let uv = (pos.xy - off) / u.res;
  let dir = (pos.xy / u.res - 0.5) * vec2f(1.0, u.res.y / u.res.x);
  let ca = dir * u.chroma * 10.0 / u.res;
  var col = vec3f(
    textureSampleLevel(sceneTex, samp, uv + ca, 0.0).r,
    textureSampleLevel(sceneTex, samp, uv, 0.0).g,
    textureSampleLevel(sceneTex, samp, uv - ca, 0.0).b);
  col += textureSampleLevel(b4, samp, uv, 0.0).rgb * u.bloom;
  col += textureSampleLevel(b8, samp, uv, 0.0).rgb * u.bloomWide;
  col += u.flash.rgb * u.flash.a;
  return vec4f(col * u.brightness, 1.0);
}
";

/// What a frame shows (render.js render(f)).
pub struct Frame<'a> {
    /// RGBA, W x H (LED resolution)
    pub art: &'a [u8],
    /// MAX_LIGHTS x 8 floats
    pub lights: &'a [f32],
    pub n_lights: usize,
    /// [x, y, radius, amplitude] LED px
    pub ripples: &'a [[f32; 4]],
    pub shake: [f32; 2],
    pub flash: [f32; 4],
    pub chroma: f32,
    pub pulse: f32,
    pub hex: f32,
    pub bloom: f32,
    pub bloom_wide: f32,
    pub brightness: f32,
    pub time: f32,
}

/// size-dependent textures and bind groups
struct Targets {
    key: [u32; 4],
    /// the render textures (kept with their views)
    _keep: Vec<wgpu::Texture>,
    art: wgpu::Texture,
    fog: wgpu::Texture,
    lm: wgpu::TextureView,
    scene: wgpu::TextureView,
    a4: wgpu::TextureView,
    c4: wgpu::TextureView,
    a8: wgpu::TextureView,
    c8: wgpu::TextureView,
    scene_group: wgpu::BindGroup,
    from_scene: wgpu::BindGroup,
    from_a4: wgpu::BindGroup,
    from_c4: wgpu::BindGroup,
    from_a8: wgpu::BindGroup,
    from_c8: wgpu::BindGroup,
    final_group: wgpu::BindGroup,
}

struct Layouts {
    scene: wgpu::BindGroupLayout,
    src: wgpu::BindGroupLayout,
    fin: wgpu::BindGroupLayout,
}

pub struct Renderer {
    lightmap: wgpu::RenderPipeline,
    scene: wgpu::RenderPipeline,
    down4: wgpu::RenderPipeline,
    down2: wgpu::RenderPipeline,
    blur_h: wgpu::RenderPipeline,
    blur_v: wgpu::RenderPipeline,
    finish: wgpu::RenderPipeline,
    layouts: Layouts,
    uniform: wgpu::Buffer,
    light_buf: wgpu::Buffer,
    common_group: wgpu::BindGroup,
    light_group: wgpu::BindGroup,
    t: Targets,
    u: [f32; U_FLOATS],
}

fn tv(v: &wgpu::TextureView) -> wgpu::BindingResource<'_> {
    wgpu::BindingResource::TextureView(v)
}

fn pipeline(gpu: &Gpu, module: &wgpu::ShaderModule, pl: &wgpu::PipelineLayout, entry: &str, format: wgpu::TextureFormat) -> Result<wgpu::RenderPipeline, String> {
    gpu.render_pipeline(&format!("space-invaders {entry}"), |d| {
        d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(entry),
            layout: Some(pl),
            vertex: wgpu::VertexState { module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
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

impl Renderer {
    /// For an LED image of w x h and a map of aw x ah art px.
    pub fn new(gpu: &Gpu, w: u32, h: u32, aw: u32, ah: u32) -> Result<Self, String> {
        let module = gpu.shader("space-invaders render", WGSL)?;
        let f = wgpu::ShaderStages::FRAGMENT;
        let common = gpu.bind_group_layout("space-invaders common", &[layout::uniform(0, f), layout::sampler(1, f, true)]);
        let light_l = gpu.bind_group_layout("space-invaders lights", &[layout::storage(0, f, true)]);
        let scene_l = gpu.bind_group_layout("space-invaders scene", &[layout::float_tex(1, f, true), layout::float_tex(2, f, true), layout::float_tex(7, f, true)]);
        let src_l = gpu.bind_group_layout("space-invaders src", &[layout::float_tex(3, f, true)]);
        let fin_l = gpu.bind_group_layout("space-invaders final", &[layout::float_tex(4, f, true), layout::float_tex(5, f, true), layout::float_tex(6, f, true)]);
        let pl = |second: &wgpu::BindGroupLayout| gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("space-invaders"), bind_group_layouts: &[Some(&common), Some(second)], immediate_size: 0 });
        let (pl_light, pl_scene, pl_src, pl_fin) = (pl(&light_l), pl(&scene_l), pl(&src_l), pl(&fin_l));
        let lightmap = pipeline(gpu, &module, &pl_light, "lightmap", HDR)?;
        let scene = pipeline(gpu, &module, &pl_scene, "scene", HDR)?;
        let down4 = pipeline(gpu, &module, &pl_src, "down4", HDR)?;
        let down2 = pipeline(gpu, &module, &pl_src, "down2", HDR)?;
        let blur_h = pipeline(gpu, &module, &pl_src, "blurH", HDR)?;
        let blur_v = pipeline(gpu, &module, &pl_src, "blurV", HDR)?;
        let finish = pipeline(gpu, &module, &pl_fin, "finish", TARGET_FORMAT)?;
        let uniform = gpu.uniform_buffer("space-invaders uniform", (U_FLOATS * 4) as u64);
        let light_buf = gpu.storage_buffer("space-invaders lights", (MAX_LIGHTS * 32) as u64);
        let sampler = gpu.linear_sampler();
        let common_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("space-invaders common"),
            layout: &common,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() }, wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&sampler) }],
        });
        let light_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("space-invaders lights"),
            layout: &light_l,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: light_buf.as_entire_binding() }],
        });
        let layouts = Layouts { scene: scene_l, src: src_l, fin: fin_l };
        let t = Self::targets(gpu, &layouts, [w, h, aw, ah]);
        Ok(Self { lightmap, scene, down4, down2, blur_h, blur_v, finish, layouts, uniform, light_buf, common_group, light_group, t, u: [0.0; U_FLOATS] })
    }

    fn targets(gpu: &Gpu, l: &Layouts, key: [u32; 4]) -> Targets {
        let [w, h, aw, ah] = key;
        let rt = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
        let up = wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST;
        let mut keep = Vec::with_capacity(6);
        let mut tex = |label: &str, w: u32, h: u32| {
            let t = gpu.texture(label, w, h, HDR, rt);
            let v = t.create_view(&Default::default());
            keep.push(t);
            v
        };
        let scene = tex("space-invaders scene", w, h);
        let a4 = tex("space-invaders a4", w.div_ceil(4), h.div_ceil(4));
        let c4 = tex("space-invaders c4", w.div_ceil(4), h.div_ceil(4));
        let a8 = tex("space-invaders a8", w.div_ceil(8), h.div_ceil(8));
        let c8 = tex("space-invaders c8", w.div_ceil(8), h.div_ceil(8));
        let lm = tex("space-invaders lightmap", aw, ah);
        let art = gpu.texture("space-invaders art", w, h, wgpu::TextureFormat::Rgba8Unorm, up);
        let fog = gpu.texture("space-invaders fog", aw, ah, wgpu::TextureFormat::R8Unorm, up);
        let group = |label: &str, layout: &wgpu::BindGroupLayout, list: &[(u32, wgpu::BindingResource)]| {
            let entries: Vec<wgpu::BindGroupEntry> = list.iter().map(|(b, r)| wgpu::BindGroupEntry { binding: *b, resource: r.clone() }).collect();
            gpu.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some(label), layout, entries: &entries })
        };
        let art_v = art.create_view(&Default::default());
        let fog_v = fog.create_view(&Default::default());
        let scene_group = group("space-invaders scene", &l.scene, &[(1, tv(&art_v)), (2, tv(&fog_v)), (7, tv(&lm))]);
        let src = |v: &wgpu::TextureView| group("space-invaders src", &l.src, &[(3, tv(v))]);
        let final_group = group("space-invaders final", &l.fin, &[(4, tv(&scene)), (5, tv(&a4)), (6, tv(&a8))]);
        Targets {
            key,
            _keep: keep,
            from_scene: src(&scene),
            from_a4: src(&a4),
            from_c4: src(&c4),
            from_a8: src(&a8),
            from_c8: src(&c8),
            art,
            fog,
            lm,
            scene,
            a4,
            c4,
            a8,
            c8,
            scene_group,
            final_group,
        }
    }

    /// the textures for these sizes (made again only when a size changes: another wall, pixel size)
    fn ensure(&mut self, gpu: &Gpu, key: [u32; 4]) {
        if self.t.key != key {
            self.t = Self::targets(gpu, &self.layouts, key);
        }
    }

    /// the fog mask (AW x AH, 0..255: 255 where the Kinect sees people)
    pub fn set_fog(&mut self, gpu: &Gpu, l: &Layout, mask: &[u8]) {
        let key = [l.w as u32, l.h as u32, l.aw as u32, l.ah as u32];
        self.ensure(gpu, key);
        if mask.len() >= (key[2] * key[3]) as usize {
            gpu.write_texture(&self.t.fog, &mask[..(key[2] * key[3]) as usize], 1);
        }
    }

    pub fn render(&mut self, ctx: &mut FrameCtx, l: &Layout, f: &Frame) {
        let gpu = ctx.gpu;
        let key = [l.w as u32, l.h as u32, l.aw as u32, l.ah as u32];
        self.ensure(gpu, key);
        let t = &self.t;
        if f.art.len() >= (key[0] * key[1] * 4) as usize {
            gpu.write_texture(&t.art, &f.art[..(key[0] * key[1] * 4) as usize], 4);
        }
        if f.n_lights > 0 {
            let n = (f.n_lights * 8).min(f.lights.len());
            gpu.queue.write_buffer(&self.light_buf, 0, bytemuck::cast_slice(&f.lights[..n]));
        }
        let u = &mut self.u;
        u.fill(0.0);
        u[..12].copy_from_slice(&[l.w as f32, l.h as f32, l.aw as f32, l.ah as f32, l.ox as f32, l.oy as f32, l.s as f32, f.time, l.sx as f32, l.sy as f32, f.shake[0], f.shake[1]]);
        u[12..16].copy_from_slice(&f.flash);
        let nr = f.ripples.len().min(8);
        u[16..24].copy_from_slice(&[f.hex, f.pulse, f.n_lights as f32, nr as f32, f.chroma, f.bloom, f.bloom_wide, f.brightness]);
        for (i, r) in f.ripples.iter().take(8).enumerate() {
            u[24 + i * 4..28 + i * 4].copy_from_slice(r);
        }
        gpu.queue.write_buffer(&self.uniform, 0, bytemuck::cast_slice(&self.u));
        let passes: [(&wgpu::RenderPipeline, &wgpu::BindGroup, &wgpu::TextureView, &str); 8] = [
            (&self.lightmap, &self.light_group, &t.lm, "space-invaders lightmap"),
            (&self.scene, &t.scene_group, &t.scene, "space-invaders scene"),
            (&self.down4, &t.from_scene, &t.a4, "space-invaders down4"),
            (&self.blur_h, &t.from_a4, &t.c4, "space-invaders blur h4"),
            (&self.blur_v, &t.from_c4, &t.a4, "space-invaders blur v4"),
            (&self.down2, &t.from_a4, &t.a8, "space-invaders down2"),
            (&self.blur_h, &t.from_a8, &t.c8, "space-invaders blur h8"),
            (&self.blur_v, &t.from_c8, &t.a8, "space-invaders blur v8"),
        ];
        for (pipe, group, view, label) in passes {
            let mut pass = begin_pass(ctx.encoder, label, view);
            pass.set_pipeline(pipe);
            pass.set_bind_group(0, &self.common_group, &[]);
            pass.set_bind_group(1, group, &[]);
            pass.draw(0..3, 0..1);
        }
        let mut pass = begin_pass(ctx.encoder, "space-invaders final", ctx.target);
        pass.set_pipeline(&self.finish);
        pass.set_bind_group(0, &self.common_group, &[]);
        pass.set_bind_group(1, &t.final_group, &[]);
        pass.draw(0..3, 0..1);
    }
}
