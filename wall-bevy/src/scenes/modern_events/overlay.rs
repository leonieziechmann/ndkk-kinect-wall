//! The ad's fixed layer on top of everything (overlay.js): headline, rotating subline, and the QR card
//! (yellow like the buttons on modern-events.de, dark modules, the address below). Headline and card
//! are painted on the CPU into a texture only when something changes; every subline is painted
//! once into an atlas and the shader shows the current one with its fade (alpha, offset, clip), so
//! the change between them repaints nothing. The pulsing frame around the QR card is drawn in the
//! shader, so the QR itself never moves or changes.

use crate::gpu::{FULLSCREEN_WGSL, Gpu, TARGET_FORMAT, layout};

use super::paint::{Layer, LayerSpec, Slot, SubAtlas, SubsSpec};

const WGSL: &str = r"
struct U {
  res: vec2f,
  time: f32,
  pulse: f32,      // 0..1: someone is near the QR card
  card: vec4f,     // x0, y0, x1, y1 (px)
  ring: vec4f,     // rgb, corner radius (px)
  clip: vec4f,     // the sublines' clip rect: x0, y0, x1, y1 (px)
  sub: vec4f,      // the shown subline: its slot's top left on the wall (px), alpha
  slot: vec4f,     // its slot in the atlas: x, y, w, h (px)
  subFill: vec4f,  // its color
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex: texture_2d<f32>;    // headline and card (premultiplied)
@group(0) @binding(2) var subTex: texture_2d<f32>; // sublines: r fill, g outline coverage
fn roundRect(p: vec2f, lo: vec2f, hi: vec2f, r: f32) -> f32 {
  let c = (lo + hi) * 0.5;
  let h = (hi - lo) * 0.5 - vec2f(r);
  let q = abs(p - c) - h;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
// the subline as Canvas 2D drew it into the clip rect with globalAlpha: the black outline, then
// the text over it
fn subline(p: vec2f) -> vec4f {
  if (u.sub.z <= 0.0) { return vec4f(0.0); }
  let q = vec2i(floor(p - u.sub.xy));
  if (any(q < vec2i(0)) || any(q >= vec2i(u.slot.zw))) { return vec4f(0.0); }
  let lo = max(p - vec2f(0.5), u.clip.xy);
  let hi = min(p + vec2f(0.5), u.clip.zw);
  let clip = max(hi.x - lo.x, 0.0) * max(hi.y - lo.y, 0.0);
  let c = textureLoad(subTex, q + vec2i(u.slot.xy), 0);
  let f = u.sub.z * clip * c.r;
  let s = u.sub.z * clip * c.g;
  return vec4f(u.subFill.rgb * f, f + s * (1.0 - f));
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var o = textureLoad(tex, vec2i(pos.xy), 0); // premultiplied
  let sl = subline(pos.xy);
  o = sl + o * (1.0 - sl.a);
  // the frame around the card: a thin line a few LEDs outside, breathing; brighter and wider
  // apart while someone is near, with light running around it
  let d = roundRect(pos.xy, u.card.xy, u.card.zw, u.ring.w);
  let gap = 4.0 + 3.0 * u.pulse * (0.5 + 0.5 * sin(u.time * 5.0));
  let line = 1.0 - smoothstep(0.6, 1.4, abs(d - gap));
  let c = (u.card.xy + u.card.zw) * 0.5;
  let ang = atan2(pos.y - c.y, pos.x - c.x);
  let run = 0.5 + 0.5 * sin(ang * 2.0 - u.time * 3.0);
  let breathe = 0.35 + 0.15 * sin(u.time * 1.6);
  let a = line * mix(breathe, 0.55 + 0.45 * run, u.pulse) * step(0.0, d);
  let ring = vec4f(u.ring.rgb * a, a);
  return o + ring * (1.0 - o.a);
}
";

/// The subline color ('#e8e6ff').
const SUB_FILL: [f32; 3] = [232.0 / 255.0, 230.0 / 255.0, 1.0];
/// The frame's color (the card's yellow).
const RING: [f32; 3] = [0.984, 0.749, 0.141];

/// What the shader shows of the sublines this frame.
pub struct SubShown {
    pub index: usize,
    pub alpha: f32,
    pub dy: f32,
    /// the layout: text x, baseline y, clip rect
    pub x: f32,
    pub y: f32,
    pub clip: [f32; 4],
}

pub struct Overlay {
    pipeline: wgpu::RenderPipeline,
    bgl: wgpu::BindGroupLayout,
    uni: wgpu::Buffer,
    layer_tex: wgpu::Texture,
    sub_tex: wgpu::Texture,
    group: wgpu::BindGroup,
    /// what was asked for last (shown, or the painter's next result)
    pub layer_wanted: LayerSpec,
    pub subs_wanted: SubsSpec,
    card: [f32; 4],
    ring_radius: f32,
    sub_slot: [u32; 2],
    sub_slots: Vec<Slot>,
}

impl Overlay {
    pub fn new(gpu: &Gpu, spec: LayerSpec, layer: Layer, subs: SubsSpec, atlas: SubAtlas) -> Result<Self, String> {
        let module = gpu.shader("modern-events: overlay", &format!("{FULLSCREEN_WGSL}\n{WGSL}"))?;
        let f = wgpu::ShaderStages::FRAGMENT;
        let bgl = gpu.bind_group_layout("modern-events overlay", &[layout::uniform(0, f), layout::float_tex(1, f, false), layout::float_tex(2, f, false)]);
        let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("modern-events overlay"), bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
        let blend = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add };
        let pipeline = gpu.render_pipeline("modern-events overlay", |d| {
            d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("modern-events overlay"),
                layout: Some(&pl),
                vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_fullscreen"), compilation_options: Default::default(), buffers: &[] },
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
        let uni = gpu.uniform_buffer("modern-events overlay u", 28 * 4);
        let layer_tex = Self::layer_texture(gpu, layer.w, layer.h);
        let sub_tex = Self::sub_texture(gpu, &atlas);
        let group = Self::group(gpu, &bgl, &uni, &layer_tex, &sub_tex);
        let mut o = Self {
            pipeline,
            bgl,
            uni,
            layer_tex,
            sub_tex,
            group,
            layer_wanted: spec,
            subs_wanted: subs,
            card: [0.0; 4],
            ring_radius: 8.0,
            sub_slot: [1, 1],
            sub_slots: Vec::new(),
        };
        o.upload_layer(gpu, layer);
        o.upload_subs(gpu, atlas);
        Ok(o)
    }

    fn layer_texture(gpu: &Gpu, w: u32, h: u32) -> wgpu::Texture {
        gpu.texture("modern-events overlay", w, h, wgpu::TextureFormat::Rgba8Unorm, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST)
    }

    fn sub_texture(gpu: &Gpu, a: &SubAtlas) -> wgpu::Texture {
        gpu.texture("modern-events sublines", a.w, a.h, wgpu::TextureFormat::Rg8Unorm, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST)
    }

    fn group(gpu: &Gpu, bgl: &wgpu::BindGroupLayout, uni: &wgpu::Buffer, layer: &wgpu::Texture, sub: &wgpu::Texture) -> wgpu::BindGroup {
        let lv = layer.create_view(&Default::default());
        let sv = sub.create_view(&Default::default());
        gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("modern-events overlay"),
            layout: bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uni.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&lv) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&sv) },
            ],
        })
    }

    fn upload_layer(&mut self, gpu: &Gpu, layer: Layer) {
        let size = self.layer_tex.size();
        if size.width != layer.w || size.height != layer.h {
            // the LED size changed (rare): a new texture
            self.layer_tex = Self::layer_texture(gpu, layer.w, layer.h);
            self.group = Self::group(gpu, &self.bgl, &self.uni, &self.layer_tex, &self.sub_tex);
        }
        if layer.pixels.len() == (layer.w * layer.h * 4) as usize {
            gpu.write_texture(&self.layer_tex, &layer.pixels, 4);
        }
        self.card = layer.card;
        self.ring_radius = layer.ring_radius;
    }

    fn upload_subs(&mut self, gpu: &Gpu, atlas: SubAtlas) {
        let size = self.sub_tex.size();
        if size.width != atlas.w || size.height != atlas.h {
            self.sub_tex = Self::sub_texture(gpu, &atlas);
            self.group = Self::group(gpu, &self.bgl, &self.uni, &self.layer_tex, &self.sub_tex);
        }
        if atlas.data.len() == (atlas.w * atlas.h * 2) as usize {
            gpu.write_texture(&self.sub_tex, &atlas.data, 2);
        }
        self.sub_slot = atlas.slot;
        self.sub_slots = atlas.slots;
    }

    /// The painter's new layer: shown from now on.
    pub fn set_layer(&mut self, gpu: &Gpu, layer: Layer) {
        self.upload_layer(gpu, layer);
    }

    pub fn set_subs(&mut self, gpu: &Gpu, atlas: SubAtlas) {
        self.upload_subs(gpu, atlas);
    }

    /// The sublines in the atlas.
    pub fn sub_count(&self) -> usize {
        self.sub_slots.len()
    }

    /// The card as painted: x0, y0, x1, y1 (px).
    pub fn card(&self) -> [f32; 4] {
        self.card
    }

    /// The uniforms of this frame.
    pub fn prepare(&mut self, gpu: &Gpu, res: [f32; 2], time: f32, pulse: f32, sub: Option<SubShown>) {
        let c = self.card;
        let mut u = [0.0f32; 28];
        u[..8].copy_from_slice(&[res[0], res[1], time, pulse, c[0], c[1], c[2], c[3]]);
        u[8..12].copy_from_slice(&[RING[0], RING[1], RING[2], self.ring_radius]);
        if let Some(s) = sub
            && let Some(slot) = self.sub_slots.get(s.index)
            && s.alpha > 0.0
        {
            // the slot's top left: the text's origin at (x, y + dy)
            let ox = s.x - slot.origin[0] as f32;
            let oy = s.y + s.dy - slot.origin[1] as f32;
            u[12..16].copy_from_slice(&s.clip);
            u[16..20].copy_from_slice(&[ox, oy, s.alpha, 0.0]);
            u[20..24].copy_from_slice(&[slot.at[0] as f32, slot.at[1] as f32, self.sub_slot[0] as f32, self.sub_slot[1] as f32]);
            u[24..28].copy_from_slice(&[SUB_FILL[0], SUB_FILL[1], SUB_FILL[2], 0.0]);
        }
        gpu.queue.write_buffer(&self.uni, 0, bytemuck::cast_slice(&u));
    }

    pub fn draw(&self, pass: &mut wgpu::RenderPass) {
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.group, &[]);
        pass.draw(0..3, 0..1);
    }
}
