//! The GPU side (main.js render): the scene at LED resolution × supersampling (scene.wgsl: the dark
//! bodies opaque with depth, then every additive sprite) -> bloom as three.js' BloomNode does it at
//! half the LED resolution (luminosity high pass, 5 mips of separable gaussian blur, composite) ->
//! the LED image (post.wgsl: row glitch, RGB split, bloom, exposure, soft shoulder, vignette, sRGB).
//! Pipelines go through the gpu cache, buffers are made once at their maximum size, render targets
//! once per LED size and supersampling.

use crate::gpu::{FULLSCREEN_WGSL, Gpu, TARGET_FORMAT, layout};

use super::fx::DOT;
use super::people::{FLOATS, MAX_POINTS};
use super::world::{CORE_COUNT, MOTE_COUNT, STREAK_COUNT, WorldData};

const SCENE_WGSL: &str = include_str!("scene.wgsl");
const POST_WGSL: &str = include_str!("post.wgsl");
const SCENE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
/// floats of the scene uniform (struct U in scene.wgsl)
pub const UNIFORM_FLOATS: usize = 200;
/// floats of the post uniform (struct Post in post.wgsl)
pub const POST_FLOATS: usize = 16;
const MIPS: usize = 5;
/// BloomNode's kernel radii per mip
const KERNELS: [usize; MIPS] = [6, 10, 14, 18, 22];
/// u32 words of the blur uniform (struct Blur in post.wgsl)
const BLUR_WORDS: usize = 32;

struct Pipes {
    body: wgpu::RenderPipeline,
    people: wgpu::RenderPipeline,
    spark: wgpu::RenderPipeline,
    floor: wgpu::RenderPipeline,
    wall: wgpu::RenderPipeline,
    core: wgpu::RenderPipeline,
    glow: wgpu::RenderPipeline,
    streak: wgpu::RenderPipeline,
    mote: wgpu::RenderPipeline,
    high: wgpu::RenderPipeline,
    blur: wgpu::RenderPipeline,
    comp: wgpu::RenderPipeline,
    led: wgpu::RenderPipeline,
    high_bgl: wgpu::BindGroupLayout,
    blur_bgl: wgpu::BindGroupLayout,
    comp_bgl: wgpu::BindGroupLayout,
    led_bgl: wgpu::BindGroupLayout,
}

/// The render targets of one LED size and supersampling.
struct Targets {
    w: u32,
    h: u32,
    ss: u32,
    scene: wgpu::TextureView,
    depth: wgpu::TextureView,
    bright: wgpu::TextureView,
    hor: Vec<wgpu::TextureView>,
    ver: Vec<wgpu::TextureView>,
    /// size of the bright pass and mip 0
    bloom: [u32; 2],
    high_group: wgpu::BindGroup,
    /// horizontal, vertical per mip
    blur_groups: Vec<wgpu::BindGroup>,
    comp_group: wgpu::BindGroup,
    led_group: wgpu::BindGroup,
}

/// A vertex buffer that grows when a rebuild of the world needs more (a new wall setup).
struct Grow {
    buf: wgpu::Buffer,
    cap: u64,
}

/// What a frame draws.
pub struct Draw {
    /// the dark bodies
    pub body: bool,
    /// points of the people
    pub people: u32,
    /// sparks and swarm: the instance range in the dots buffer
    pub dots: std::ops::Range<u32>,
}

pub struct Gfx {
    pipes: Pipes,
    uni: wgpu::Buffer,
    post: wgpu::Buffer,
    scene_group: wgpu::BindGroup,
    index: wgpu::Buffer,
    people: wgpu::Buffer,
    dots: wgpu::Buffer,
    floor: Grow,
    wall: Grow,
    core: wgpu::Buffer,
    streaks: wgpu::Buffer,
    motes: wgpu::Buffer,
    floor_n: u32,
    wall_n: u32,
    /// one per blur pass (horizontal, vertical per mip)
    blur_uni: Vec<wgpu::Buffer>,
    sampler: wgpu::Sampler,
    /// the GPU's largest 2D texture
    max_texture: u32,
    targets: Option<Targets>,
}

fn additive() -> wgpu::BlendState {
    // AdditiveBlending without premultiplied alpha (three.js WebGPU backend)
    wgpu::BlendState {
        color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::SrcAlpha, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
        alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
    }
}

fn instance(stride: usize, attributes: &[wgpu::VertexAttribute]) -> wgpu::VertexBufferLayout<'_> {
    wgpu::VertexBufferLayout { array_stride: (stride * 4) as u64, step_mode: wgpu::VertexStepMode::Instance, attributes }
}

fn attr(location: u32, format: wgpu::VertexFormat, offset_floats: u64) -> wgpu::VertexAttribute {
    wgpu::VertexAttribute { format, offset: offset_floats * 4, shader_location: location }
}

fn tex(binding: u32, view: &wgpu::TextureView) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry { binding, resource: wgpu::BindingResource::TextureView(view) }
}

/// A sprite pipeline of scene.wgsl: opaque (the bodies: depth write) or additive (depth test only).
#[allow(clippy::too_many_arguments)]
fn sprite_pipe(gpu: &Gpu, module: &wgpu::ShaderModule, pl: &wgpu::PipelineLayout, name: &str, vs: &str, fs: &str, buffers: &[Option<wgpu::VertexBufferLayout>], opaque: bool) -> Result<wgpu::RenderPipeline, String> {
    gpu.render_pipeline(&format!("cyberspiegel {name}"), |d| {
        d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(name),
            layout: Some(pl),
            vertex: wgpu::VertexState { module, entry_point: Some(vs), compilation_options: Default::default(), buffers },
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some(fs),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: SCENE_FORMAT, blend: if opaque { None } else { Some(additive()) }, write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: Default::default(),
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: Some(opaque),
                depth_compare: Some(wgpu::CompareFunction::LessEqual),
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        })
    })
}

/// A fullscreen pass of post.wgsl.
fn post_pipe(gpu: &Gpu, module: &wgpu::ShaderModule, bgl: &wgpu::BindGroupLayout, name: &str, fs: &str, format: wgpu::TextureFormat) -> Result<wgpu::RenderPipeline, String> {
    let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some(name), bind_group_layouts: &[Some(bgl)], immediate_size: 0 });
    gpu.render_pipeline(&format!("cyberspiegel {name}"), |d| {
        d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(name),
            layout: Some(&pl),
            vertex: wgpu::VertexState { module, entry_point: Some("vs_fullscreen"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some(fs),
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

impl Pipes {
    fn new(gpu: &Gpu) -> Result<Self, String> {
        let scene = gpu.shader("cyberspiegel: scene", SCENE_WGSL)?;
        let post = gpu.shader("cyberspiegel: post", &format!("{FULLSCREEN_WGSL}\n{POST_WGSL}"))?;
        let vf = wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT;
        let f = wgpu::ShaderStages::FRAGMENT;
        let scene_bgl = gpu.bind_group_layout("cyberspiegel scene", &[layout::uniform(0, vf)]);
        let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("cyberspiegel scene"), bind_group_layouts: &[Some(&scene_bgl)], immediate_size: 0 });
        use wgpu::VertexFormat::{Float32x2, Float32x3, Float32x4};
        let one = [attr(0, Float32x4, 0)];
        let two = [attr(0, Float32x4, 0), attr(1, Float32x4, 4)];
        let person = [attr(0, Float32x3, 0), attr(1, Float32x4, 3), attr(2, Float32x2, 7)];
        let dot = [attr(0, Float32x4, 0), attr(1, Float32x3, 4)];
        let people_buf = [Some(instance(FLOATS, &person))];
        let one4 = [Some(instance(4, &one))];
        let sp = |name, vs, fs, buffers: &[Option<wgpu::VertexBufferLayout>], opaque| sprite_pipe(gpu, &scene, &pl, name, vs, fs, buffers, opaque);
        let high_bgl = gpu.bind_group_layout("cyberspiegel bloom high", &[layout::uniform(0, f), layout::sampler(1, f, true), layout::float_tex(2, f, true)]);
        let blur_bgl = gpu.bind_group_layout("cyberspiegel bloom blur", &[layout::sampler(1, f, true), layout::float_tex(2, f, true), layout::uniform(8, f)]);
        let comp_bgl = gpu.bind_group_layout(
            "cyberspiegel bloom composite",
            &[
                layout::uniform(0, f),
                layout::sampler(1, f, true),
                layout::float_tex(2, f, true),
                layout::float_tex(3, f, true),
                layout::float_tex(4, f, true),
                layout::float_tex(5, f, true),
                layout::float_tex(6, f, true),
            ],
        );
        let led_bgl = gpu.bind_group_layout("cyberspiegel led", &[layout::uniform(0, f), layout::sampler(1, f, true), layout::float_tex(2, f, true), layout::float_tex(7, f, true)]);
        Ok(Self {
            body: sp("body", "vs_body", "fs_body", &people_buf, true)?,
            people: sp("people", "vs_people", "fs_people", &people_buf, false)?,
            spark: sp("sparks", "vs_spark", "fs_dot", &[Some(instance(DOT, &dot))], false)?,
            floor: sp("floor", "vs_floor", "fs_dot", &one4, false)?,
            wall: sp("blackwall", "vs_wall", "fs_dot", &[Some(instance(8, &two))], false)?,
            core: sp("core", "vs_core", "fs_core", &one4, false)?,
            glow: sp("glow", "vs_glow", "fs_glow", &[], false)?,
            streak: sp("streaks", "vs_streak", "fs_streak", &one4, false)?,
            mote: sp("motes", "vs_mote", "fs_dot", &one4, false)?,
            high: post_pipe(gpu, &post, &high_bgl, "bloom high", "fs_high", SCENE_FORMAT)?,
            blur: post_pipe(gpu, &post, &blur_bgl, "bloom blur", "fs_blur", SCENE_FORMAT)?,
            comp: post_pipe(gpu, &post, &comp_bgl, "bloom composite", "fs_comp", SCENE_FORMAT)?,
            led: post_pipe(gpu, &post, &led_bgl, "led", "fs_led", TARGET_FORMAT)?,
            high_bgl,
            blur_bgl,
            comp_bgl,
            led_bgl,
        })
    }
}

/// The blur uniform of one pass: BloomNode's gaussian kernel, adjacent taps merged into bilinear fetches.
fn blur_words(kernel: usize, dir: [f32; 2], size: [u32; 2]) -> [u32; BLUR_WORDS] {
    let sigma = kernel as f64 / 3.0;
    let coef: Vec<f64> = (0..kernel).map(|i| 0.39894 * (-0.5 * (i * i) as f64 / (sigma * sigma)).exp() / sigma).collect();
    let mut offsets = Vec::new();
    let mut weights = Vec::new();
    let mut i = 1;
    while i < kernel {
        let wa = coef[i];
        let wb = if i + 1 < kernel { coef[i + 1] } else { 0.0 };
        let w = wa + wb;
        offsets.push((i as f64 * wa + (i + 1) as f64 * wb) / w);
        weights.push(w);
        i += 2;
    }
    let mut out = [0_u32; BLUR_WORDS];
    let fl = |v: f64| (v as f32).to_bits();
    out[0] = dir[0].to_bits();
    out[1] = dir[1].to_bits();
    out[2] = (1.0 / size[0].max(1) as f32).to_bits();
    out[3] = (1.0 / size[1].max(1) as f32).to_bits();
    out[4] = fl(coef[0]);
    out[5] = offsets.len().min(12) as u32;
    for (k, (o, w)) in offsets.iter().zip(&weights).take(12).enumerate() {
        out[8 + k] = fl(*o);
        out[20 + k] = fl(*w);
    }
    out
}

impl Gfx {
    pub fn new(gpu: &Gpu, dots: usize) -> Result<Self, String> {
        let pipes = Pipes::new(gpu)?;
        let vertex = wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST;
        let uni = gpu.uniform_buffer("cyberspiegel U", (UNIFORM_FLOATS * 4) as u64);
        let post = gpu.uniform_buffer("cyberspiegel post", (POST_FLOATS * 4) as u64);
        let scene_bgl = gpu.bind_group_layout("cyberspiegel scene", &[layout::uniform(0, wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT)]);
        let scene_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("cyberspiegel scene"),
            layout: &scene_bgl,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: uni.as_entire_binding() }],
        });
        let index = gpu.buffer("cyberspiegel quad", 12, wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST);
        gpu.queue.write_buffer(&index, 0, bytemuck::cast_slice(&[0_u16, 1, 2, 0, 2, 3]));
        let grow = |label: &str| Grow { buf: gpu.buffer(label, 16, vertex), cap: 16 };
        Ok(Self {
            pipes,
            uni,
            post,
            scene_group,
            index,
            people: gpu.buffer("cyberspiegel people", (MAX_POINTS * FLOATS * 4) as u64, vertex),
            dots: gpu.buffer("cyberspiegel dots", (dots * DOT * 4) as u64, vertex),
            floor: grow("cyberspiegel floor"),
            wall: grow("cyberspiegel blackwall"),
            core: gpu.buffer("cyberspiegel core", (CORE_COUNT * 16) as u64, vertex),
            streaks: gpu.buffer("cyberspiegel streaks", (STREAK_COUNT * 16) as u64, vertex),
            motes: gpu.buffer("cyberspiegel motes", (MOTE_COUNT * 16) as u64, vertex),
            floor_n: 0,
            wall_n: 0,
            blur_uni: (0..2 * MIPS).map(|_| gpu.uniform_buffer("cyberspiegel blur", (BLUR_WORDS * 4) as u64)).collect(),
            sampler: gpu.linear_sampler(),
            max_texture: gpu.device.limits().max_texture_dimension_2d,
            targets: None,
        })
    }

    /// The world's instance data after a rebuild (a new view: rare).
    pub fn upload_world(&mut self, gpu: &Gpu, w: &WorldData) {
        let vertex = wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST;
        let put = |g: &mut Grow, data: &[f32], label: &str| {
            let bytes = (data.len() * 4) as u64;
            if bytes > g.cap {
                g.cap = bytes + bytes / 4;
                g.buf = gpu.buffer(label, g.cap, vertex);
            }
            if bytes > 0 {
                gpu.queue.write_buffer(&g.buf, 0, bytemuck::cast_slice(data));
            }
        };
        put(&mut self.floor, &w.floor, "cyberspiegel floor");
        put(&mut self.wall, &w.wall, "cyberspiegel blackwall");
        self.floor_n = (w.floor.len() / 4) as u32;
        self.wall_n = (w.wall.len() / 8) as u32;
        let fixed = |buf: &wgpu::Buffer, data: &[f32], n: usize| {
            let k = data.len().min(n * 4);
            if k > 0 {
                gpu.queue.write_buffer(buf, 0, bytemuck::cast_slice(&data[..k]));
            }
        };
        fixed(&self.core, &w.core, CORE_COUNT);
        fixed(&self.streaks, &w.streaks, STREAK_COUNT);
        fixed(&self.motes, &w.motes, MOTE_COUNT);
    }

    /// The render targets for the LED size and supersampling (made again only when they change).
    pub fn ensure_targets(&mut self, gpu: &Gpu, w: u32, h: u32, ss: u32) {
        let w = w.max(1);
        let h = h.max(1);
        // a very large LED image: no more supersampling than the GPU's textures allow
        let ss = ss.min(self.max_texture / w.max(h)).max(1);
        if self.targets.as_ref().is_some_and(|t| t.w == w && t.h == h && t.ss == ss) {
            return;
        }
        let usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
        let view = |label: &str, tw: u32, th: u32, format: wgpu::TextureFormat| gpu.texture(label, tw, th, format, usage).create_view(&Default::default());
        let scene = view("cyberspiegel scene", w * ss, h * ss, SCENE_FORMAT);
        let depth = view("cyberspiegel depth", w * ss, h * ss, DEPTH_FORMAT);
        // BloomNode at half the LED image (main.js: the bloom follows the LED image, not the canvas)
        let mut sizes = [[1_u32; 2]; MIPS];
        let (mut bx, mut by) = (w / 2, h / 2);
        for s in &mut sizes {
            *s = [bx.max(1), by.max(1)];
            bx /= 2;
            by /= 2;
        }
        let bright = view("cyberspiegel bloom bright", sizes[0][0], sizes[0][1], SCENE_FORMAT);
        let hor: Vec<wgpu::TextureView> = sizes.iter().map(|s| view("cyberspiegel bloom h", s[0], s[1], SCENE_FORMAT)).collect();
        let ver: Vec<wgpu::TextureView> = sizes.iter().map(|s| view("cyberspiegel bloom v", s[0], s[1], SCENE_FORMAT)).collect();
        let smp = wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) };
        let post = wgpu::BindGroupEntry { binding: 0, resource: self.post.as_entire_binding() };
        let group = |label: &str, layout: &wgpu::BindGroupLayout, entries: &[wgpu::BindGroupEntry]| gpu.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some(label), layout, entries });
        let high_group = group("cyberspiegel bloom high", &self.pipes.high_bgl, &[post.clone(), smp.clone(), tex(2, &scene)]);
        let mut blur_groups = Vec::with_capacity(2 * MIPS);
        for (i, size) in sizes.iter().enumerate() {
            let input = if i == 0 { &bright } else { &ver[i - 1] };
            for (k, (dir, src)) in [([1.0, 0.0], input), ([0.0, 1.0], &hor[i])].into_iter().enumerate() {
                let buf = &self.blur_uni[2 * i + k];
                gpu.queue.write_buffer(buf, 0, bytemuck::cast_slice(&blur_words(KERNELS[i], dir, *size)));
                blur_groups.push(group("cyberspiegel bloom blur", &self.pipes.blur_bgl, &[smp.clone(), tex(2, src), wgpu::BindGroupEntry { binding: 8, resource: buf.as_entire_binding() }]));
            }
        }
        let comp_group = group("cyberspiegel bloom composite", &self.pipes.comp_bgl, &[post.clone(), smp.clone(), tex(2, &ver[0]), tex(3, &ver[1]), tex(4, &ver[2]), tex(5, &ver[3]), tex(6, &ver[4])]);
        let led_group = group("cyberspiegel led", &self.pipes.led_bgl, &[post, smp, tex(2, &scene), tex(7, &hor[0])]);
        self.targets = Some(Targets { w, h, ss, scene, depth, bright, hor, ver, bloom: sizes[0], high_group, blur_groups, comp_group, led_group });
    }

    /// size of the bright pass and mip 0
    pub fn bloom_size(&self) -> [u32; 2] {
        self.targets.as_ref().map(|t| t.bloom).unwrap_or([1, 1])
    }

    pub fn write_uniforms(&self, gpu: &Gpu, u: &[f32; UNIFORM_FLOATS], post: &[f32; POST_FLOATS]) {
        gpu.queue.write_buffer(&self.uni, 0, bytemuck::cast_slice(u));
        gpu.queue.write_buffer(&self.post, 0, bytemuck::cast_slice(post));
    }

    /// The people's points of a new tracking result.
    pub fn upload_people(&self, gpu: &Gpu, data: &[f32]) {
        if !data.is_empty() {
            gpu.queue.write_buffer(&self.people, 0, bytemuck::cast_slice(data));
        }
    }

    /// Dots (swarm, then sparks) from instance `at` on.
    pub fn upload_dots(&self, gpu: &Gpu, at: usize, data: &[f32]) {
        if !data.is_empty() {
            gpu.queue.write_buffer(&self.dots, (at * DOT * 4) as u64, bytemuck::cast_slice(data));
        }
    }

    /// Records the frame: the scene, the bloom, the LED image into `target`.
    pub fn render(&self, enc: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, d: &Draw) {
        let Some(t) = &self.targets else {
            return;
        };
        let p = &self.pipes;
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("cyberspiegel scene"),
                color_attachments: &[Some(crate::gpu::clear_attachment(&t.scene))],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &t.depth,
                    depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_bind_group(0, &self.scene_group, &[]);
            pass.set_index_buffer(self.index.slice(..), wgpu::IndexFormat::Uint16);
            let mut draw = |pipe: &wgpu::RenderPipeline, buf: Option<&wgpu::Buffer>, n: std::ops::Range<u32>| {
                if n.is_empty() {
                    return;
                }
                pass.set_pipeline(pipe);
                if let Some(b) = buf {
                    pass.set_vertex_buffer(0, b.slice(..));
                }
                pass.draw_indexed(0..6, 0, n);
            };
            // opaque first: the dark bodies hide what is behind them
            if d.body {
                draw(&p.body, Some(&self.people), 0..d.people);
            }
            draw(&p.wall, Some(&self.wall.buf), 0..self.wall_n);
            draw(&p.glow, None, 0..1);
            draw(&p.core, Some(&self.core), 0..CORE_COUNT as u32);
            draw(&p.floor, Some(&self.floor.buf), 0..self.floor_n);
            draw(&p.streak, Some(&self.streaks), 0..STREAK_COUNT as u32);
            draw(&p.people, Some(&self.people), 0..d.people);
            draw(&p.spark, Some(&self.dots), d.dots.clone());
            draw(&p.mote, Some(&self.motes), 0..MOTE_COUNT as u32);
        }
        let full = |enc: &mut wgpu::CommandEncoder, view: &wgpu::TextureView, pipe: &wgpu::RenderPipeline, group: &wgpu::BindGroup| {
            let mut pass = crate::gpu::begin_pass(enc, "cyberspiegel post", view);
            pass.set_pipeline(pipe);
            pass.set_bind_group(0, group, &[]);
            pass.draw(0..3, 0..1);
        };
        full(enc, &t.bright, &p.high, &t.high_group);
        for i in 0..MIPS {
            if let (Some(gh), Some(gv)) = (t.blur_groups.get(2 * i), t.blur_groups.get(2 * i + 1)) {
                full(enc, &t.hor[i], &p.blur, gh);
                full(enc, &t.ver[i], &p.blur, gv);
            }
        }
        full(enc, &t.hor[0], &p.comp, &t.comp_group);
        full(enc, target, &p.led, &t.led_group);
    }
}
