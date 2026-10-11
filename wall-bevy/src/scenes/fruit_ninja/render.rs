//! The renderer (render.js, from space-invaders): the scenery (scenery.rs, a still picture at LED
//! resolution), lit by the game's lights; over it the crisp pixel layer of the game (at LED
//! resolution: blocks placed to the LED, see pix.rs); then bloom in two sizes, distortion ripples,
//! color fringes and flashes.
//!
//! Made for an LED wall with 5.9 mm pitch: nothing finer than a few LEDs repeats regularly (no 1-LED
//! lines, no raster, no dither), so neither the LED grid nor a camera sees moiré. The scenery is
//! drawn in blocks of 2 x 2 LEDs; the glows are smooth.
//!
//! Passes: light map (one texel per art pixel: light is smooth) -> scene (W x H) -> the blade
//! strokes added on top (strokes.rs: soft ribbons) -> bright parts down to 1/4 -> blur -> down to
//! 1/8 -> blur -> final (into ctx.target). The WGSL is render.js's own.

use crate::gpu::{Gpu, TARGET_FORMAT, begin_pass, layout};

use super::strokes::{FLOATS, MAX_TRAIL_VERTS};

pub const MAX_LIGHTS: usize = 128;
const HDR: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
const ART: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const U_FLOATS: usize = 56;

const WGSL: &str = r"
struct U {
  res: vec2f, art: vec2f, sceneryBloom: f32, pad: f32, S: f32, time: f32,
  scale: vec2f, shake: vec2f,
  flash: vec4f,
  scenery: f32, sceneryLight: f32, nLights: f32, nRipples: f32,
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

// ---- scene: the scenery + lights + the game's pixels
@group(1) @binding(1) var artTex: texture_2d<f32>;
@group(1) @binding(2) var bgTex: texture_2d<f32>;
@group(1) @binding(7) var lightTex: texture_2d<f32>;

@fragment fn scene(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let art = (pos.xy - u.shake) / u.S;
  let auv = art / u.art;
  // the lights (from the light map, filtered: smooth between the art pixels)
  let light = textureSampleLevel(lightTex, samp, auv, 0.0).rgb;
  // the scenery (one texel per LED), lit by the game: juice and blades light up the night around them
  let ai = vec2i(floor(pos.xy - u.shake));
  let inside = all(ai >= vec2i(0)) && all(ai < vec2i(u.res));
  var col = light * 0.03;
  var glow = 1.0; // how much of this pixel blooms (alpha): the scenery only a little, the game fully
  if (inside) {
    let bg = textureLoad(bgTex, ai, 0).rgb * u.scenery;
    col += bg * (1.0 + light * u.sceneryLight);
    // the game's pixels
    let px = textureLoad(artTex, ai, 0);
    col = mix(col, px.rgb * (1.0 + light * 0.25), px.a);
    glow = mix(u.sceneryBloom, 1.0, px.a);
  }
  return vec4f(col, glow);
}

// ---- the blade strokes: ribbons with a soft profile across, added onto the picture
struct TV { a: vec4f, b: vec4f, c: vec4f };
@group(1) @binding(0) var<storage, read> tv: array<TV>;
struct TO {
  @builtin(position) pos: vec4f,
  @location(0) across: f32,
  @location(1) along: f32,
  @location(2) col: vec4f,
  @location(3) @interpolate(flat) kind: vec2f,
};
@vertex fn trailVs(@builtin(vertex_index) i: u32) -> TO {
  let v = tv[i];
  let p = v.a.xy + u.shake;
  var o: TO;
  o.pos = vec4f(p.x / u.res.x * 2.0 - 1.0, 1.0 - p.y / u.res.y * 2.0, 0.0, 1.0);
  o.across = v.a.z;
  o.along = v.a.w;
  o.col = v.b;
  o.kind = v.c.xy;
  return o;
}
@fragment fn trailFs(in: TO) -> @location(0) vec4f {
  let s = abs(in.across);
  let fw = max(fwidth(in.across), 1e-3);
  var c = vec3f(0.0);
  if (in.kind.y > 0.5) {
    // the woosh: a soft band, speed lines in it broken into dashes along the way
    let band = pow(max(1.0 - s * s, 0.0), 1.5);
    var lines = 0.0;
    for (var j = 0; j < 3; j++) {
      let off = -0.55 + f32(j) * 0.55;
      let lw = max(2.0 * fw, 0.1);
      let dash = smoothstep(0.25, 0.4, fract(in.along * 2.3 + f32(j) * 0.37));
      lines += (1.0 - smoothstep(lw * 0.5, lw, abs(in.across - off))) * dash;
    }
    c = in.col.rgb * (band * 0.85 + lines * 0.35 * (1.0 - s));
  } else {
    // a blade or a slash: a crisp white core in a glow of its color
    let glow = (1.0 - s) * (1.0 - s);
    let core = 1.0 - smoothstep(in.kind.x - fw, in.kind.x + fw, s);
    c = in.col.rgb * glow * 0.9 + vec3f(1.0) * core;
  }
  return vec4f(c * in.col.a, in.col.a);
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
  var g = 0.0;
  for (var i = 0; i < 4; i++) {
    let o = vec2f(select(-1.0, 1.0, (i & 1) == 1), select(-1.0, 1.0, i >= 2));
    let s = textureSampleLevel(src, samp, uv + o * t, 0.0);
    c += s.rgb * 0.25;
    g += s.a * 0.25;
  }
  let k = smoothstep(0.3, 0.85, lum(c)) * g;
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

/// What a frame hands the renderer (render.js render(f)).
pub struct Frame<'a> {
    /// the pixel layer (RGBA8 per LED)
    pub art: &'a [u8],
    pub lights: &'a [f32],
    pub n_lights: usize,
    pub trail: &'a [f32],
    pub n_trail: usize,
    /// [x, y, r, amp] in LED px
    pub ripples: &'a [[f32; 4]],
    pub shake: [f32; 2],
    pub flash: [f32; 4],
    pub chroma: f32,
    pub scenery: f32,
    pub scenery_light: f32,
    pub scenery_bloom: f32,
    pub bloom: f32,
    pub bloom_wide: f32,
    pub brightness: f32,
    pub time: f32,
}

/// The size-dependent textures and bind groups.
struct Sized {
    w: u32,
    h: u32,
    aw: u32,
    ah: u32,
    art: wgpu::Texture,
    bg: wgpu::Texture,
    lm: wgpu::TextureView,
    scene: wgpu::TextureView,
    a4: wgpu::TextureView,
    c4: wgpu::TextureView,
    a8: wgpu::TextureView,
    c8: wgpu::TextureView,
    light_group: wgpu::BindGroup,
    scene_group: wgpu::BindGroup,
    from_scene: wgpu::BindGroup,
    from_a4: wgpu::BindGroup,
    from_c4: wgpu::BindGroup,
    from_a8: wgpu::BindGroup,
    from_c8: wgpu::BindGroup,
    final_group: wgpu::BindGroup,
}

struct Pipes {
    lightmap: wgpu::RenderPipeline,
    scene: wgpu::RenderPipeline,
    down4: wgpu::RenderPipeline,
    down2: wgpu::RenderPipeline,
    blur_h: wgpu::RenderPipeline,
    blur_v: wgpu::RenderPipeline,
    finish: wgpu::RenderPipeline,
    trail: wgpu::RenderPipeline,
}

pub struct Renderer {
    pipes: Pipes,
    light_layout: wgpu::BindGroupLayout,
    scene_layout: wgpu::BindGroupLayout,
    src_layout: wgpu::BindGroupLayout,
    final_layout: wgpu::BindGroupLayout,
    uniform: wgpu::Buffer,
    light_buf: wgpu::Buffer,
    trail_buf: wgpu::Buffer,
    trail_group: wgpu::BindGroup,
    common_group: wgpu::BindGroup,
    u: [f32; U_FLOATS],
    t: Option<Sized>,
}

impl Renderer {
    pub fn new(gpu: &Gpu) -> Result<Self, String> {
        let module = gpu.shader("fruit-ninja render", WGSL)?;
        let f = wgpu::ShaderStages::FRAGMENT;
        let common = gpu.bind_group_layout("fruit-ninja common", &[layout::uniform(0, f | wgpu::ShaderStages::VERTEX), layout::sampler(1, f, true)]);
        let light_layout = gpu.bind_group_layout("fruit-ninja lights", &[layout::storage(0, f, true)]);
        let scene_layout = gpu.bind_group_layout("fruit-ninja scene", &[layout::float_tex(1, f, true), layout::float_tex(2, f, true), layout::float_tex(7, f, true)]);
        let src_layout = gpu.bind_group_layout("fruit-ninja src", &[layout::float_tex(3, f, true)]);
        let trail_layout = gpu.bind_group_layout("fruit-ninja trail", &[layout::storage(0, wgpu::ShaderStages::VERTEX, true)]);
        let final_layout = gpu.bind_group_layout("fruit-ninja final", &[layout::float_tex(4, f, true), layout::float_tex(5, f, true), layout::float_tex(6, f, true)]);
        let pipe = |key: &str, group: &wgpu::BindGroupLayout, vs: &str, fs: &str, format: wgpu::TextureFormat, blend: Option<wgpu::BlendState>| {
            gpu.render_pipeline(key, |d| {
                let pl = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some(key), bind_group_layouts: &[Some(&common), Some(group)], immediate_size: 0 });
                d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some(key),
                    layout: Some(&pl),
                    vertex: wgpu::VertexState { module: &module, entry_point: Some(vs), compilation_options: Default::default(), buffers: &[] },
                    fragment: Some(wgpu::FragmentState {
                        module: &module,
                        entry_point: Some(fs),
                        compilation_options: Default::default(),
                        targets: &[Some(wgpu::ColorTargetState { format, blend, write_mask: wgpu::ColorWrites::ALL })],
                    }),
                    primitive: Default::default(),
                    depth_stencil: None,
                    multisample: Default::default(),
                    multiview_mask: None,
                    cache: None,
                })
            })
        };
        let add = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add };
        let pipes = Pipes {
            lightmap: pipe("fruit-ninja lightmap", &light_layout, "vs", "lightmap", HDR, None)?,
            scene: pipe("fruit-ninja scene", &scene_layout, "vs", "scene", HDR, None)?,
            down4: pipe("fruit-ninja down4", &src_layout, "vs", "down4", HDR, None)?,
            down2: pipe("fruit-ninja down2", &src_layout, "vs", "down2", HDR, None)?,
            blur_h: pipe("fruit-ninja blurH", &src_layout, "vs", "blurH", HDR, None)?,
            blur_v: pipe("fruit-ninja blurV", &src_layout, "vs", "blurV", HDR, None)?,
            finish: pipe("fruit-ninja final", &final_layout, "vs", "finish", TARGET_FORMAT, None)?,
            trail: pipe("fruit-ninja trail", &trail_layout, "trailVs", "trailFs", HDR, Some(wgpu::BlendState { color: add, alpha: add }))?,
        };
        let uniform = gpu.uniform_buffer("fruit-ninja u", (U_FLOATS * 4) as u64);
        let light_buf = gpu.storage_buffer("fruit-ninja lights", (MAX_LIGHTS * 32) as u64);
        let trail_buf = gpu.storage_buffer("fruit-ninja trail", (MAX_TRAIL_VERTS * FLOATS * 4) as u64);
        let trail_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("fruit-ninja trail"),
            layout: &trail_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: trail_buf.as_entire_binding() }],
        });
        let sampler = gpu.linear_sampler();
        let common_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("fruit-ninja common"),
            layout: &common,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() }, wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&sampler) }],
        });
        Ok(Self { pipes, light_layout, scene_layout, src_layout, final_layout, uniform, light_buf, trail_buf, trail_group, common_group, u: [0.0; U_FLOATS], t: None })
    }

    /// The textures for this size (made anew only when it changed).
    pub fn ensure(&mut self, gpu: &Gpu, w: u32, h: u32, aw: u32, ah: u32) {
        if self.t.as_ref().is_some_and(|t| t.w == w && t.h == h && t.aw == aw && t.ah == ah) {
            return;
        }
        let rt = |label: &str, w: u32, h: u32| {
            gpu.texture(label, w.max(1), h.max(1), HDR, wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING).create_view(&Default::default())
        };
        let scene = rt("fruit-ninja scene", w, h);
        let a4 = rt("fruit-ninja a4", w.div_ceil(4), h.div_ceil(4));
        let c4 = rt("fruit-ninja c4", w.div_ceil(4), h.div_ceil(4));
        let a8 = rt("fruit-ninja a8", w.div_ceil(8), h.div_ceil(8));
        let c8 = rt("fruit-ninja c8", w.div_ceil(8), h.div_ceil(8));
        let lm = rt("fruit-ninja lightmap", aw, ah);
        let art = gpu.texture("fruit-ninja art", w, h, ART, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST);
        let bg = gpu.texture("fruit-ninja scenery", w, h, ART, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST);
        let art_view = art.create_view(&Default::default());
        let bg_view = bg.create_view(&Default::default());
        let group = |label: &str, layout: &wgpu::BindGroupLayout, views: &[(u32, &wgpu::TextureView)]| {
            let entries: Vec<wgpu::BindGroupEntry> = views.iter().map(|(b, v)| wgpu::BindGroupEntry { binding: *b, resource: wgpu::BindingResource::TextureView(v) }).collect();
            gpu.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some(label), layout, entries: &entries })
        };
        let light_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("fruit-ninja lights"),
            layout: &self.light_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: self.light_buf.as_entire_binding() }],
        });
        let scene_group = group("fruit-ninja scene", &self.scene_layout, &[(1, &art_view), (2, &bg_view), (7, &lm)]);
        let from_scene = group("fruit-ninja from scene", &self.src_layout, &[(3, &scene)]);
        let from_a4 = group("fruit-ninja from a4", &self.src_layout, &[(3, &a4)]);
        let from_c4 = group("fruit-ninja from c4", &self.src_layout, &[(3, &c4)]);
        let from_a8 = group("fruit-ninja from a8", &self.src_layout, &[(3, &a8)]);
        let from_c8 = group("fruit-ninja from c8", &self.src_layout, &[(3, &c8)]);
        let final_group = group("fruit-ninja final", &self.final_layout, &[(4, &scene), (5, &a4), (6, &a8)]);
        self.t = Some(Sized { w, h, aw, ah, art, bg, lm, scene, a4, c4, a8, c8, light_group, scene_group, from_scene, from_a4, from_c4, from_a8, from_c8, final_group });
    }

    /// the still scenery (RGBA8 per LED, w x h)
    pub fn set_scenery(&self, gpu: &Gpu, buf: &[u32]) {
        if let Some(t) = &self.t
            && buf.len() == (t.w * t.h) as usize
        {
            gpu.write_texture(&t.bg, bytemuck::cast_slice(buf), 4);
        }
    }

    fn pass(&self, enc: &mut wgpu::CommandEncoder, label: &str, pipeline: &wgpu::RenderPipeline, group: &wgpu::BindGroup, view: &wgpu::TextureView) {
        let mut p = begin_pass(enc, label, view);
        p.set_pipeline(pipeline);
        p.set_bind_group(0, &self.common_group, &[]);
        p.set_bind_group(1, group, &[]);
        p.draw(0..3, 0..1);
    }

    /// One frame into `target`.
    pub fn render(&mut self, gpu: &Gpu, enc: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, f: &Frame, l: &super::Layout) {
        let Some(t) = &self.t else { return };
        if f.art.len() == (t.w * t.h * 4) as usize {
            gpu.write_texture(&t.art, f.art, 4);
        }
        let n_lights = f.n_lights.min(MAX_LIGHTS).min(f.lights.len() / 8);
        if n_lights > 0 {
            gpu.queue.write_buffer(&self.light_buf, 0, bytemuck::cast_slice(&f.lights[..n_lights * 8]));
        }
        let n_trail = f.n_trail.min(MAX_TRAIL_VERTS).min(f.trail.len() / FLOATS);
        if n_trail > 0 {
            gpu.queue.write_buffer(&self.trail_buf, 0, bytemuck::cast_slice(&f.trail[..n_trail * FLOATS]));
        }
        let ppm = l.ppm as f32;
        let u = &mut self.u;
        u.fill(0.0);
        u[..12].copy_from_slice(&[t.w as f32, t.h as f32, t.aw as f32, t.ah as f32, f.scenery_bloom, 0.0, l.s as f32, f.time, ppm, ppm, f.shake[0], f.shake[1]]);
        u[12..16].copy_from_slice(&f.flash);
        u[16..24].copy_from_slice(&[f.scenery, f.scenery_light, n_lights as f32, f.ripples.len().min(8) as f32, f.chroma, f.bloom, f.bloom_wide, f.brightness]);
        for (i, r) in f.ripples.iter().take(8).enumerate() {
            u[24 + i * 4..28 + i * 4].copy_from_slice(r);
        }
        gpu.queue.write_buffer(&self.uniform, 0, bytemuck::cast_slice(&self.u));
        let p = &self.pipes;
        self.pass(enc, "fruit-ninja lightmap", &p.lightmap, &t.light_group, &t.lm);
        self.pass(enc, "fruit-ninja scene", &p.scene, &t.scene_group, &t.scene);
        if n_trail > 0 {
            let mut tp = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("fruit-ninja trail"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &t.scene,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            tp.set_pipeline(&p.trail);
            tp.set_bind_group(0, &self.common_group, &[]);
            tp.set_bind_group(1, &self.trail_group, &[]);
            tp.draw(0..n_trail as u32, 0..1);
        }
        self.pass(enc, "fruit-ninja down4", &p.down4, &t.from_scene, &t.a4);
        self.pass(enc, "fruit-ninja blurH", &p.blur_h, &t.from_a4, &t.c4);
        self.pass(enc, "fruit-ninja blurV", &p.blur_v, &t.from_c4, &t.a4);
        self.pass(enc, "fruit-ninja down2", &p.down2, &t.from_a4, &t.a8);
        self.pass(enc, "fruit-ninja blurH", &p.blur_h, &t.from_a8, &t.c8);
        self.pass(enc, "fruit-ninja blurV", &p.blur_v, &t.from_c8, &t.a8);
        self.pass(enc, "fruit-ninja final", &p.finish, &t.final_group, target);
    }
}
