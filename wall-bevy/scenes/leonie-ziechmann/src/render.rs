//! The compositor (render.js), one fullscreen pass on the LED image:
//!
//!   1. the wood in layers (forest.rs), far to near, with the signs, the signpost and the leaf heap
//!      as one more layer at their depth (cards layer 1, the heap in the leaves with alpha 253); the
//!      people go in between: every person pixel lands behind the layers nearer to the sensor than
//!      the person and in front of the farther ones
//!   2. the people as soft, dark shadows (walkers in mist): strongly nearer, faintly far back in the
//!      wood, soft-edged; the mist and light of the nearer layers lies over them; over a sign a
//!      shadow stays thin, so the code can still be read (persp.rs: r covered, g distance)
//!   3. the leaves in the air (alpha 254)
//!   4. the contact card (cards layer 0) and the leaves lying on it (alpha 255)
//!   5. overall brightness

use wall::gpu::{Gpu, GpuResult, TARGET_FORMAT, layout};

pub const LAYERS: u32 = 4;

const WGSL: &str = r"
struct U {
  res: vec2f,
  time: f32,
  s: f32,           // LED px per design px
  bright: f32,
  near: f32,        // shadow strength near the sensor
  far: f32,         // ... and far away
  soft: f32,        // edge softness (design px)
  tint: vec4f,      // the shadow's color, ground y (px)
  depth: vec4f,     // distance of tree layers 1..3 from the sensor (m), of the signs
  back: vec4f,      // the people's depths: nearest, farthest (for the shadow's strength)
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var forest: texture_2d_array<f32>;
@group(0) @binding(3) var personTex: texture_2d<f32>;
@group(0) @binding(4) var cardsTex: texture_2d_array<f32>; // 0: the contact card, 1: the signs
@group(0) @binding(5) var leavesTex: texture_2d<f32>;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

// covered and covered * distance at LED pixel pos (bilinear over the cells of the person image)
fn person(pos: vec2f) -> vec2f {
  let v = textureSampleLevel(personTex, samp, pos / u.res, 0.0);
  return vec2f(v.r, v.r * v.g);
}

@fragment fn fs(@builtin(position) fp: vec4f) -> @location(0) vec4f {
  let pos = floor(fp.xy) + 0.5;
  let ip = vec2i(pos);

  // the people, smoothed over a few LEDs: coverage and the (coverage-weighted) distance
  let r = u.soft * u.s;
  var acc = person(pos) * 0.2;
  acc += (person(pos + vec2f(r, 0.0)) + person(pos - vec2f(r, 0.0)) + person(pos + vec2f(0.0, r)) + person(pos - vec2f(0.0, r))) * 0.12;
  acc += (person(pos + vec2f(r, r) * 0.7) + person(pos - vec2f(r, r) * 0.7) + person(pos + vec2f(r, -r) * 0.7) + person(pos - vec2f(r, -r) * 0.7)) * 0.08;
  let cov = smoothstep(0.12, 0.7, acc.x);
  let dist = select(99.0, acc.y / max(acc.x, 1e-4), acc.x > 1e-3);
  // stronger near the sensor, misty far away; the feet fade into the forest floor a little
  var a = cov * mix(u.near, u.far, saturate((dist - u.back.x) / max(0.1, u.back.y - u.back.x)));
  a *= mix(0.6, 1.0, saturate((u.tint.w - pos.y) / (40.0 * u.s) + 0.4));

  // what lies at the signs' depth: the signs (premultiplied) and the heap (leaves, alpha 253)
  let sg = textureLoad(cardsTex, ip, 1, 0);
  let lv = textureLoad(leavesTex, ip, 0);
  let heap = lv.a > 0.99 && lv.a <= 0.994;
  // a shadow passing in front of a sign stays thin
  let aSign = select(a, min(a, 0.3), sg.a > 0.5 || heap);

  // the wood far to near, the signs at their depth, the person in between
  var col = textureLoad(forest, ip, 0, 0).rgb;
  var placed = false;
  var signs = false;
  for (var i = 1; i < 4; i++) {
    let dl = u.depth[i - 1];
    if (!signs && u.depth.w > dl) {
      if (!placed && dist > u.depth.w) {
        col = mix(col, u.tint.rgb, a);
        placed = true;
      }
      col = sg.rgb + col * (1.0 - sg.a);
      col = select(col, lv.rgb, heap);
      signs = true;
    }
    if (!placed && dist > dl) {
      col = mix(col, u.tint.rgb, select(a, aSign, signs));
      placed = true;
    }
    let l = textureLoad(forest, ip, i, 0);
    col = l.rgb + col * (1.0 - l.a);
  }
  if (!signs) {
    if (!placed && dist > u.depth.w) {
      col = mix(col, u.tint.rgb, a);
      placed = true;
    }
    col = sg.rgb + col * (1.0 - sg.a);
    col = select(col, lv.rgb, heap);
  }
  if (!placed) { col = mix(col, u.tint.rgb, aSign); }

  // the leaves in the air, the contact card, the leaves lying on it (opaque pixel art)
  col = select(col, lv.rgb, lv.a > 0.994 && lv.a <= 0.998);
  let c = textureLoad(cardsTex, ip, 0, 0);
  col = c.rgb + col * (1.0 - c.a);
  col = select(col, lv.rgb, lv.a > 0.998);
  return vec4f(col * u.bright, 1.0);
}
";

/// The uniforms of a frame (render.js o).
pub struct Uniforms {
    pub s: f32,
    pub bright: f32,
    pub near: f32,
    pub far: f32,
    pub soft: f32,
    pub tint: [f32; 3],
    pub ground: f32,
    /// tree layers 1..3, signs
    pub depths: [f32; 4],
    /// the people's nearest and farthest depth
    pub back: [f32; 2],
}

fn array_tex(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2Array, multisampled: false },
        count: None,
    }
}

fn texture(gpu: &Gpu, label: &str, w: u32, h: u32, layers: u32) -> wgpu::Texture {
    gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: layers },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    })
}

fn array_view(t: &wgpu::Texture) -> wgpu::TextureView {
    t.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() })
}

pub struct Renderer {
    pipeline: wgpu::RenderPipeline,
    bgl: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    uni: wgpu::Buffer,
    forest: wgpu::Texture,
    cards: wgpu::Texture,
    leaves: wgpu::Texture,
    group: wgpu::BindGroup,
    pub w: u32,
    pub h: u32,
    data: [f32; 20],
}

impl Renderer {
    pub fn new(gpu: &Gpu, w: u32, h: u32, person: &wgpu::TextureView) -> GpuResult<Self> {
        let module = gpu.shader("leonie-ziechmann: render", WGSL)?;
        let f = wgpu::ShaderStages::FRAGMENT;
        let bgl = gpu.bind_group_layout("leonie-ziechmann render", &[layout::uniform(0, f), layout::sampler(1, f, true), array_tex(2), layout::float_tex(3, f, true), array_tex(4), layout::float_tex(5, f, true)]);
        let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("leonie-ziechmann render"), bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
        let pipeline = gpu.render_pipeline("leonie-ziechmann render", |d| {
            d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("leonie-ziechmann render"),
                layout: Some(&pl),
                vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some("fs"),
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
        let sampler = gpu.linear_sampler();
        let uni = gpu.uniform_buffer("leonie-ziechmann u", 80);
        let forest = texture(gpu, "leonie-ziechmann wood", w, h, LAYERS);
        let cards = texture(gpu, "leonie-ziechmann cards", w, h, 2);
        let leaves = texture(gpu, "leonie-ziechmann leaves", w, h, 1);
        let group = Self::group(gpu, &bgl, &uni, &sampler, &forest, &cards, &leaves, person);
        Ok(Self { pipeline, bgl, sampler, uni, forest, cards, leaves, group, w, h, data: [0.0; 20] })
    }

    #[allow(clippy::too_many_arguments)]
    fn group(gpu: &Gpu, bgl: &wgpu::BindGroupLayout, uni: &wgpu::Buffer, sampler: &wgpu::Sampler, forest: &wgpu::Texture, cards: &wgpu::Texture, leaves: &wgpu::Texture, person: &wgpu::TextureView) -> wgpu::BindGroup {
        let fv = array_view(forest);
        let cv = array_view(cards);
        let lv = leaves.create_view(&Default::default());
        gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("leonie-ziechmann render"),
            layout: bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uni.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(sampler) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&fv) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(person) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&cv) },
                wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::TextureView(&lv) },
            ],
        })
    }

    /// New textures for a new LED size (their content must be uploaded again: true), or a new
    /// person texture (persp.rs made its grid anew).
    pub fn ensure(&mut self, gpu: &Gpu, w: u32, h: u32, person: &wgpu::TextureView, person_new: bool) -> bool {
        let resized = w != self.w || h != self.h;
        if resized {
            self.forest = texture(gpu, "leonie-ziechmann wood", w, h, LAYERS);
            self.cards = texture(gpu, "leonie-ziechmann cards", w, h, 2);
            self.leaves = texture(gpu, "leonie-ziechmann leaves", w, h, 1);
            self.w = w;
            self.h = h;
        }
        if resized || person_new {
            self.group = Self::group(gpu, &self.bgl, &self.uni, &self.sampler, &self.forest, &self.cards, &self.leaves, person);
        }
        resized
    }

    fn fits(&self, t: &wgpu::Texture, bytes: &[u8]) -> bool {
        let s = t.size();
        s.width == self.w && s.height == self.h && bytes.len() == (s.width * s.height * s.depth_or_array_layers * 4) as usize
    }

    /// the wood's layers (premultiplied RGBA8, far to near)
    pub fn set_forest(&self, gpu: &Gpu, bytes: &[u8]) {
        if self.fits(&self.forest, bytes) {
            gpu.write_texture(&self.forest, bytes, 4);
        }
    }

    /// the contact card and the signs (premultiplied RGBA8)
    pub fn set_cards(&self, gpu: &Gpu, bytes: &[u8]) {
        if self.fits(&self.cards, bytes) {
            gpu.write_texture(&self.cards, bytes, 4);
        }
    }

    /// the leaves: RGBA, opaque pixels (alpha 253..255) or 0
    pub fn set_leaves(&self, gpu: &Gpu, bytes: &[u8]) {
        if self.fits(&self.leaves, bytes) {
            gpu.write_texture(&self.leaves, bytes, 4);
        }
    }

    pub fn render(&mut self, gpu: &Gpu, enc: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, time: f32, o: &Uniforms) {
        let d = &mut self.data;
        d[..8].copy_from_slice(&[self.w as f32, self.h as f32, time, o.s, o.bright, o.near, o.far, o.soft]);
        d[8..12].copy_from_slice(&[o.tint[0], o.tint[1], o.tint[2], o.ground]);
        d[12..16].copy_from_slice(&o.depths);
        d[16..20].copy_from_slice(&[o.back[0], o.back[1], 0.0, 0.0]);
        gpu.queue.write_buffer(&self.uni, 0, bytemuck::cast_slice(&self.data));
        let mut pass = wall::gpu::begin_pass(enc, "leonie-ziechmann", target);
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.group, &[]);
        pass.draw(0..3, 0..1);
    }
}
