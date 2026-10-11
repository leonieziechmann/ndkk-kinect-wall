//! Pixel sparks (sparks.js): small square pixels that fly off fast hands and feet in the person's
//! outfit colors, drift upwards and blink out. Simulated on the CPU (wall meters), drawn as
//! instanced squares on top of the tile image, on whole LEDs.

use std::collections::{HashMap, HashSet};

use crate::gpu::{Gpu, TARGET_FORMAT, layout};
use crate::persons::j;
use crate::scene::FrameCtx;
use crate::scenes::common::rand::Rng;

use super::outfit;

const MAX: usize = 800;
const FLOATS: usize = 8; // x, y (LED px), size (LED px), alpha, r, g, b, unused
const LIMBS: [(usize, &str); 4] = [(j::LEFT_HAND, "lh"), (j::RIGHT_HAND, "rh"), (j::LEFT_ANKLE, "la"), (j::RIGHT_ANKLE, "ra")];
const BODY: [usize; 9] = [j::HEAD, j::LEFT_SHOULDER, j::RIGHT_SHOULDER, j::LEFT_ELBOW, j::RIGHT_ELBOW, j::LEFT_HAND, j::RIGHT_HAND, j::LEFT_HIP, j::RIGHT_HIP];

const WGSL: &str = r"
@group(0) @binding(0) var<uniform> res: vec4f;
struct VOut { @builtin(position) pos: vec4f, @location(0) col: vec4f, };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) c: vec4f) -> VOut {
  var corner = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let size = max(1.0, round(a.z));
  let px = floor(a.xy - 0.5 * size) + corner[vi] * size; // on whole LEDs
  var out: VOut;
  out.pos = vec4f(px.x / res.x * 2.0 - 1.0, 1.0 - px.y / res.y * 2.0, 0.0, 1.0);
  out.col = vec4f(c.rgb, a.w);
  return out;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f { return vec4f(in.col.rgb * in.col.a, in.col.a); }
";

struct Spark {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    life: f32,
    age: f32,
    size: f32,
    rgb: [f32; 3],
}

pub struct Sparks {
    pipeline: wgpu::RenderPipeline,
    buffer: wgpu::Buffer,
    res: wgpu::Buffer,
    group: wgpu::BindGroup,
    data: Vec<f32>,
    list: Vec<Spark>,
    /// id -> depth layer, the same rule as slotLayer() in shade.wgsl
    layers: HashMap<u32, usize>,
    /// fractional spawns per person and limb
    carry: HashMap<(u32, &'static str), f32>,
    rng: Rng,
}

impl Sparks {
    pub fn new(gpu: &Gpu) -> Result<Self, String> {
        let module = gpu.shader("pixel-spiegel: sparks", WGSL)?;
        let bgl = gpu.bind_group_layout("pixel-spiegel sparks", &[layout::uniform(0, wgpu::ShaderStages::VERTEX)]);
        let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
        let blend = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add };
        let pipeline = gpu.render_pipeline("pixel-spiegel sparks", |d| {
            d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("sparks"),
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
        let buffer = gpu.buffer("sparks", (MAX * FLOATS * 4) as u64, wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST);
        let res = gpu.uniform_buffer("sparks res", 16);
        let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("sparks"),
            layout: &bgl,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: res.as_entire_binding() }],
        });
        Ok(Self { pipeline, buffer, res, group, data: vec![0.0; MAX * FLOATS], list: Vec::with_capacity(MAX), layers: HashMap::new(), carry: HashMap::new(), rng: Rng::from_time() })
    }

    pub fn count(&self) -> usize {
        self.list.len()
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn(&mut self, x: f32, y: f32, vx: f32, vy: f32, rgb: [f32; 3], size: f32, jitter: f32, life: Option<f32>) {
        let life = life.unwrap_or_else(|| 0.7 + self.rng.f32() * 1.1);
        if self.list.len() >= MAX {
            self.list.remove(0);
        }
        let a = self.rng.f32() * std::f32::consts::TAU;
        let s = (0.25 + self.rng.f32() * 0.75) * jitter;
        self.list.push(Spark { x, y, vx: vx + a.cos() * s, vy: vy + a.sin() * s, life, age: 0.0, size, rgb });
    }

    fn layer_of(&mut self, id: u32, z: f32, near: f32, far: f32, hold: f32) -> usize {
        let fresh = if z < near { 0 } else if z < far { 1 } else { 2 };
        let mut l = fresh;
        if let Some(&was) = self.layers.get(&id) {
            let lo = if was == 0 { f32::NEG_INFINITY } else { (if was == 1 { near } else { far }) - hold };
            let hi = if was == 2 { f32::INFINITY } else { (if was == 0 { near } else { far }) + hold };
            if z >= lo && z <= hi {
                l = was;
            }
        }
        self.layers.insert(id, l);
        l
    }

    fn update(&mut self, ctx: &FrameCtx) {
        let p = ctx.params;
        let wall = &*ctx.wall;
        let dt = ctx.dt.min(0.1);
        let cell = p.f("cell") / 100.0;
        let mut seen: HashSet<(u32, &'static str)> = HashSet::new();
        let view = ctx.kinect.view.clone();
        let light = |c: [f32; 3]| [c[0] + (1.0 - c[0]) * 0.45, c[1] + (1.0 - c[1]) * 0.45, c[2] + (1.0 - c[2]) * 0.45];
        let placed: Vec<(u32, f32)> = wall.persons.iter().map(|q| (q.id, q.dist)).collect();
        // spawn: limbs faster than the threshold throw pixels, more the faster they move
        for (id, dist) in &placed {
            let Some(person) = view.by_id(*id) else { continue };
            let o = outfit(*id);
            let layer = self.layer_of(*id, *dist, p.f("layerNear"), p.f("layerFar"), p.f("layerHold"));
            let scale = [p.f("nearScale"), 1.0, p.f("farScale")][layer]; // sparks as fine as the person's tiles
            let hx = |i: usize| crate::persons::hex_rgb(o.0[i]);
            let colors = [hx(2), hx(1), hx(0), [1.0, 1.0, 1.0]];
            for (jj, name) in LIMBS {
                let key = (*id, name);
                seen.insert(key);
                let (Some(vel), Some(pos)) = (wall.joint_velocity(person, jj), wall.joint(person, jj)) else { continue };
                let speed = vel.x.hypot(vel.y);
                let over = speed - p.f("sparkSpeed");
                let mut n = self.carry.get(&key).copied().unwrap_or(0.0) + if over > 0.0 { over * 18.0 * p.f("sparks") * dt } else { 0.0 };
                while n >= 1.0 {
                    n -= 1.0;
                    let rgb = colors[self.rng.int(colors.len())];
                    let size = cell * scale * (0.38 + self.rng.f32() * 0.25);
                    self.spawn(pos.x, pos.y, vel.x * 0.45, vel.y * 0.45, rgb, size, 0.6, None);
                }
                self.carry.insert(key, n);
            }
            // a few pixels always drift up from the body, slowly
            let key = (*id, "drift");
            seen.insert(key);
            let mut n = self.carry.get(&key).copied().unwrap_or(0.0) + p.f("drift") * 1.5 * dt;
            while n >= 1.0 {
                n -= 1.0;
                let Some(pos) = wall.joint(person, BODY[self.rng.int(BODY.len())]) else { continue };
                let rgb = light(colors[self.rng.int(3)]);
                let side = if self.rng.f32() < 0.5 { -1.0 } else { 1.0 };
                let x = pos.x + side * (0.14 + self.rng.f32() * 0.22); // beside the body
                let y = pos.y + (self.rng.f32() - 0.5) * 0.2;
                let vy = 0.12 + self.rng.f32() * 0.15;
                let size = cell * scale * (0.22 + self.rng.f32() * 0.18);
                let life = 1.8 + self.rng.f32() * 1.6;
                self.spawn(x, y, 0.0, vy, rgb, size, 0.12, Some(life));
            }
            self.carry.insert(key, n);
        }
        self.carry.retain(|k, _| seen.contains(k));
        self.layers.retain(|id, _| placed.iter().any(|(q, _)| q == id));
        // move: drag, a slow drift upwards
        let drag = (-2.2 * dt).exp();
        self.list.retain_mut(|s| {
            s.age += dt;
            if s.age >= s.life {
                return false;
            }
            s.vx *= drag;
            s.vy = s.vy * drag + 0.35 * dt;
            s.x += s.vx * dt;
            s.y += s.vy * dt;
            true
        });
    }

    pub fn render(&mut self, ctx: &mut FrameCtx) {
        self.update(ctx);
        if self.list.is_empty() {
            return;
        }
        let ppm = ctx.wall.px_per_m()[0];
        let mut n = 0;
        for s in &self.list {
            let t = s.age / s.life;
            // pixel-art fade: full, then blinking, then gone; the size shrinks in steps
            let alpha = if t < 0.6 { 1.0 } else { (if (s.age * 14.0).floor() as i64 % 2 != 0 { 0.25 } else { 0.9 }) * (1.0 - t) * 2.5 };
            let size = s.size * ppm * if t < 0.5 { 1.0 } else { 0.6 };
            let [px, py] = ctx.wall.px(s.x, s.y);
            self.data[n * FLOATS..(n + 1) * FLOATS].copy_from_slice(&[px, py, size, alpha.min(1.0), s.rgb[0], s.rgb[1], s.rgb[2], 0.0]);
            n += 1;
        }
        ctx.gpu.queue.write_buffer(&self.res, 0, bytemuck::cast_slice(&[ctx.width as f32, ctx.height as f32, 0.0, 0.0]));
        ctx.gpu.queue.write_buffer(&self.buffer, 0, bytemuck::cast_slice(&self.data[..n * FLOATS]));
        let mut pass = ctx.encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("sparks"),
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
        pass.set_vertex_buffer(0, self.buffer.slice(..));
        pass.draw(0..6, 0..n as u32);
    }
}
