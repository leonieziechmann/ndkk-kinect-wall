//! Punktwolke (port of web/scenes/pointcloud): the point cloud in the reference look: white, lit dots
//! on dark gray with glow and vignette, seen from an orbiting camera.
//!
//! As in the browser (its WGSL, unchanged): per depth pixel the vertex shader computes point =
//! (x·z, y·z, z) and draws a lit sphere impostor into an additive r16float target; a blurred
//! quarter-res copy of it is the glow; the composite pass tone-maps dots + glow onto the gray
//! background. The camera is ctx.camera of a page nobody touches (camera.js): its default pose, the
//! slow automatic orbit, the pivot following the median depth of the scene.

use serde_json::json;

use wall::gpu::{Gpu, TARGET_FORMAT, begin_pass, layout};
use wall::kinect_gpu::{KH, KW};
use wall::params::{ParamSpec, Params, color, num, select_map};
use wall::persons::PersonOptions;
use wall::scene::{FrameCtx, Scene, SceneDef, SetupCtx, no_cap, no_projection};

const POINTS_WGSL: &str = r"
struct Uniforms {
  viewProj: mat4x4f,
  viewport: vec4f, // width, height, 1/width, 1/height
  p0: vec4f,       // dotFill, step, fx of the depth camera, focal length of the view in px
  p1: vec4f,       // fog a, fog b, xSign, ir mix
  grid: vec4u,     // cols, rows, step, unused
};
@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var<storage, read> depth: array<u32>;  // u16 pairs
@group(0) @binding(2) var<storage, read> rays: array<vec2f>; // undistorted ray per pixel
@group(0) @binding(3) var<storage, read> ir: array<u32>;     // u8 quads

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) energy: f32,
  @location(2) radiusPx: f32,
};

const CORNERS = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
                                vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));

fn depthAt(i: u32) -> u32 {
  let w = depth[i >> 1u];
  return select(w & 0xffffu, w >> 16u, (i & 1u) == 1u);
}

fn irAt(i: u32) -> f32 {
  let w = ir[i >> 2u];
  return f32((w >> ((i & 3u) * 8u)) & 0xffu) / 255.0;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  var out: VSOut;
  out.pos = vec4f(0.0, 0.0, -1.0, 1.0); // outside the clip volume: not drawn
  out.uv = vec2f(0.0);
  out.energy = 0.0;
  out.radiusPx = 1.0;
  let step = U.grid.z;
  let col = (ii % U.grid.x) * step;
  let row = (ii / U.grid.x) * step;
  if (col >= 512u || row >= 424u) { return out; }
  let idx = row * 512u + col;
  let d = depthAt(idx);
  if (d == 0u) { return out; }
  let z = f32(d) * 0.001;
  let ray = rays[idx];
  // Kinect camera frame (x right, y down, z forward) -> world (x right, y up, z forward)
  let world = vec3f(ray.x * z * U.p1.z, -ray.y * z, z);
  let clip = U.viewProj * vec4f(world, 1.0);
  if (clip.w < 0.05) { return out; }
  // dot radius: a share of the footprint of one sensor pixel, projected into the view
  var rPx = U.p0.x * U.p0.y * z / U.p0.z * U.p0.w / clip.w;
  var energy = clamp(U.p1.x - U.p1.y * z, 0.3, 1.0); // depth fog
  let minPx = 0.8;
  if (rPx < minPx) { // tiny dots: draw at minimum size with less light instead of flickering
    energy *= rPx * rPx / (minPx * minPx);
    rPx = minPx;
  }
  if (U.p1.w > 0.0) { energy *= mix(1.0, 0.25 + 1.1 * irAt(idx), U.p1.w); }
  let corner = CORNERS[vi];
  let extent = rPx + 1.0; // one extra pixel for the anti-aliased edge
  out.pos = vec4f(clip.xy + corner * extent * 2.0 * U.viewport.zw * clip.w, clip.z, clip.w);
  out.uv = corner * (extent / rPx);
  out.energy = energy;
  out.radiusPx = rPx;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let d = length(in.uv);
  let cover = clamp((1.0 - d) * in.radiusPx + 0.5, 0.0, 1.0);
  if (cover <= 0.0) { discard; }
  var n = vec3f(in.uv, sqrt(max(0.0, 1.0 - d * d)));
  if (d >= 1.0) { n = vec3f(in.uv / d, 0.0); }
  let light = normalize(vec3f(-0.35, 0.55, 0.76)); // from the upper left, towards the viewer
  let shade = 0.28 + 0.72 * max(0.0, dot(n, light));
  return vec4f(in.energy * cover * shade, 0.0, 0.0, 1.0);
}
";

const FULLSCREEN_WGSL: &str = r"
@vertex
fn vsFull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
";

const DOWN_WGSL: &str = r"
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment
fn fsDown(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(src));
  let uv = (floor(fc.xy) * 4.0 + 2.0) / size; // center of the 4x4 source block
  let o = 1.0 / size;
  let s = textureSampleLevel(src, samp, uv + vec2f(-o.x, -o.y), 0.0).r
        + textureSampleLevel(src, samp, uv + vec2f(o.x, -o.y), 0.0).r
        + textureSampleLevel(src, samp, uv + vec2f(-o.x, o.y), 0.0).r
        + textureSampleLevel(src, samp, uv + vec2f(o.x, o.y), 0.0).r;
  return vec4f(s * 0.25, 0.0, 0.0, 1.0);
}
";

const BLUR_WGSL: &str = r"
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> dir: vec4f;
@fragment
fn fsBlur(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(src));
  let uv = fc.xy / size;
  let d = dir.xy / size;
  var s = textureSampleLevel(src, samp, uv, 0.0).r * 0.2270270270;
  s += (textureSampleLevel(src, samp, uv + d * 1.3846153846, 0.0).r
      + textureSampleLevel(src, samp, uv - d * 1.3846153846, 0.0).r) * 0.3162162162;
  s += (textureSampleLevel(src, samp, uv + d * 3.2307692308, 0.0).r
      + textureSampleLevel(src, samp, uv - d * 3.2307692308, 0.0).r) * 0.0702702703;
  return vec4f(s, 0.0, 0.0, 1.0);
}
";

const COMPOSITE_WGSL: &str = r"
struct Post { dot: vec4f, bgCenter: vec4f, bgEdge: vec4f, gains: vec4f }; // gains: gain, glow
@group(0) @binding(0) var acc: texture_2d<f32>;
@group(0) @binding(1) var glow: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> P: Post;

fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }

@fragment
fn fsComposite(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(acc));
  let uv = fc.xy / size;
  let a = textureLoad(acc, vec2i(fc.xy), 0).r;
  let g = textureSampleLevel(glow, samp, uv, 0.0).r;
  let f = uv - 0.5;
  let bg = mix(P.bgCenter.rgb, P.bgEdge.rgb, min(1.0, 2.0 * dot(f, f))); // gray with a soft vignette
  let dots = 1.0 - exp(-P.gains.x * a);
  let halo = 1.0 - exp(-P.gains.x * g);
  let c = bg + (P.dot.rgb - bg) * dots + P.gains.y * halo * (1.0 - dots) * P.dot.rgb + (hash(fc.xy) - 0.5) / 255.0;
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}
";

const ACC: wgpu::TextureFormat = wgpu::TextureFormat::R16Float;
const DEG: f64 = std::f64::consts::PI / 180.0;

fn params() -> Vec<ParamSpec> {
    vec![
        num("dotFill", 0.42, 0.1, 1.2, 0.01, "Punktgröße"),
        select_map("step", json!(2), &[("jedes Pixel", json!(1)), ("jedes 2.", json!(2)), ("jedes 3.", json!(3))], "Dichte"),
        num("gain", 1.5, 0.2, 4.0, 0.05, "Helligkeit"),
        num("glow", 0.35, 0.0, 1.5, 0.01, "Glow"),
        num("fog", 0.2, 0.0, 0.5, 0.01, "Tiefennebel"),
        num("irMix", 0.0, 0.0, 1.0, 0.05, "IR-Helligkeit"),
        color("dotColor", "#ffffff", "Punktfarbe"),
        color("bgCenter", "#2d2d2d", "Hintergrund Mitte"),
        color("bgEdge", "#1d1d1d", "Hintergrund Rand"),
    ]
}

/// the IR stream only while it is used
fn streams(p: &Params) -> Vec<&'static str> {
    if p.f("irMix") > 0.0 { vec!["depth", "ir"] } else { vec!["depth"] }
}

fn no_persons(_: &Params) -> Option<PersonOptions> {
    None
}

/// params.fx of the depth camera (the hub's camera params; the core keeps only the ray table): the
/// slope of the rays at the image center, 365.5 (the browser's fallback) without one.
fn focal_of_rays(rays: &[f32]) -> f32 {
    let i = (212 * 512 + 256) * 2;
    match (rays.get(i), rays.get(i + 2)) {
        (Some(a), Some(b)) if b - a > 1e-5 => 1.0 / (b - a),
        _ => 365.5,
    }
}

/// ctx.camera (camera.js OrbitCamera) on a page nobody touches: the pose of reset(), the automatic
/// orbit since the page started, the pivot following the median depth of the scene.
struct OrbitCamera {
    pivot_z: f64,
    started: bool,
}

impl OrbitCamera {
    /// horizontal field of view, near, far, zoom, pitch (deg), orbit amplitude (deg) and period (s)
    const FOV_DEG: f64 = 70.0;
    const NEAR: f64 = 0.05;
    const FAR: f64 = 100.0;
    const ZOOM: f64 = 1.6;
    const PITCH: f64 = 14.0;
    const AUTO_DEG: f64 = 32.0;
    const AUTO_PERIOD_S: f64 = 28.0;

    /// The page's runtime tracks the median on every new frame, whatever plays: an instance starts
    /// where that has settled (the newest median), then follows it the same way (track()).
    fn settle(&mut self, median_mm: Option<f64>) {
        if let Some(m) = median_mm.filter(|m| *m > 300.0) {
            self.pivot_z = m / 1000.0;
        }
    }

    fn track(&mut self, median_mm: Option<f64>) {
        if let Some(m) = median_mm.filter(|m| *m > 300.0) {
            self.pivot_z = 0.92 * self.pivot_z + 0.08 * (m / 1000.0);
        }
    }

    /// viewProj (column-major) and the focal length in px for this frame.
    fn update(&self, now_ms: f64, width: f64, height: f64) -> ([f32; 16], f32) {
        let yaw = Self::AUTO_DEG * (2.0 * std::f64::consts::PI * now_ms / (Self::AUTO_PERIOD_S * 1000.0)).sin() * DEG;
        let pitch = Self::PITCH * DEG;
        let back = [yaw.sin() * pitch.cos(), pitch.sin(), -yaw.cos() * pitch.cos()];
        let dist = self.pivot_z * Self::ZOOM;
        let pos = [dist * back[0], dist * back[1], self.pivot_z + dist * back[2]];
        let f = back.map(|v| -v);
        let r0 = [f[2], 0.0, -f[0]]; // cross(up, f)
        let lr = (r0[0] * r0[0] + r0[1] * r0[1] + r0[2] * r0[2]).sqrt();
        let r = r0.map(|v| v / if lr > 0.0 { lr } else { 1.0 });
        let u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
        let dot = |a: [f64; 3]| a[0] * pos[0] + a[1] * pos[1] + a[2] * pos[2];
        let sx = 1.0 / ((Self::FOV_DEG * DEG) / 2.0).tan();
        let sy = (sx * width) / height.max(1.0);
        let a = Self::FAR / (Self::FAR - Self::NEAR);
        let b = (-Self::NEAR * Self::FAR) / (Self::FAR - Self::NEAR);
        // rows of the view matrix: right, up, forward (+ translation)
        let v = [[r[0], r[1], r[2], -dot(r)], [u[0], u[1], u[2], -dot(u)], [f[0], f[1], f[2], -dot(f)], [0.0, 0.0, 0.0, 1.0]];
        let p = [[sx, 0.0, 0.0, 0.0], [0.0, sy, 0.0, 0.0], [0.0, 0.0, a, b], [0.0, 0.0, 1.0, 0.0]];
        let mut vp = [0.0_f32; 16];
        for i in 0..4 {
            for jj in 0..4 {
                vp[jj * 4 + i] = (0..4).map(|k| p[i][k] * v[k][jj]).sum::<f64>() as f32;
            }
        }
        (vp, ((sx * width) / 2.0) as f32)
    }
}

/// Size-dependent textures and their bind groups.
struct Targets {
    w: u32,
    h: u32,
    acc: wgpu::TextureView,
    q1: wgpu::TextureView,
    q2: wgpu::TextureView,
    down: wgpu::BindGroup,
    blur_h: wgpu::BindGroup,
    blur_v: wgpu::BindGroup,
    composite: wgpu::BindGroup,
}

struct Layouts {
    down: wgpu::BindGroupLayout,
    blur: wgpu::BindGroupLayout,
    composite: wgpu::BindGroupLayout,
}

struct Pointcloud {
    gpu: Gpu,
    points: wgpu::RenderPipeline,
    down: wgpu::RenderPipeline,
    blur: wgpu::RenderPipeline,
    composite: wgpu::RenderPipeline,
    layouts: Layouts,
    sampler: wgpu::Sampler,
    uniform_buf: wgpu::Buffer,
    post_buf: wgpu::Buffer,
    blur_bufs: [wgpu::Buffer; 2],
    points_group: wgpu::BindGroup,
    targets: Targets,
    camera: OrbitCamera,
    fx: f32,
    uniforms: [f32; 32],
}

/// A pipeline of one module (`entry`: vertex, fragment entry point) drawing into one `format` target.
fn pipeline(gpu: &Gpu, key: &str, module: &wgpu::ShaderModule, entry: [&str; 2], format: wgpu::TextureFormat, blend: Option<wgpu::BlendState>, bgl: &wgpu::BindGroupLayout) -> Result<wgpu::RenderPipeline, String> {
    let [vs, fs] = entry;
    let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some(key), bind_group_layouts: &[Some(bgl)], immediate_size: 0 });
    gpu.render_pipeline(key, |d| {
        d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(key),
            layout: Some(&pl),
            vertex: wgpu::VertexState { module, entry_point: Some(vs), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState {
                module,
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
}

fn make(ctx: &SetupCtx) -> Result<Box<dyn Scene>, String> {
    let gpu = &ctx.gpu;
    let kg = &ctx.kgpu;
    let (v, f) = (wgpu::ShaderStages::VERTEX, wgpu::ShaderStages::FRAGMENT);
    let points_layout = gpu.bind_group_layout("pointcloud points", &[layout::uniform(0, v | f), layout::storage(1, v, true), layout::storage(2, v, true), layout::storage(3, v, true)]);
    let layouts = Layouts {
        down: gpu.bind_group_layout("pointcloud down", &[layout::float_tex(0, f, true), layout::sampler(1, f, true)]),
        blur: gpu.bind_group_layout("pointcloud blur", &[layout::float_tex(0, f, true), layout::sampler(1, f, true), layout::uniform(2, f)]),
        composite: gpu.bind_group_layout("pointcloud composite", &[layout::float_tex(0, f, true), layout::float_tex(1, f, true), layout::sampler(2, f, true), layout::uniform(3, f)]),
    };
    let additive = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add };
    let points_module = gpu.shader("pointcloud points", POINTS_WGSL)?;
    let points = pipeline(gpu, "pointcloud points", &points_module, ["vs", "fs"], ACC, Some(wgpu::BlendState { color: additive, alpha: additive }), &points_layout)?;
    let down_module = gpu.shader("pointcloud fsDown", &format!("{FULLSCREEN_WGSL}{DOWN_WGSL}"))?;
    let down = pipeline(gpu, "pointcloud down", &down_module, ["vsFull", "fsDown"], ACC, None, &layouts.down)?;
    let blur_module = gpu.shader("pointcloud fsBlur", &format!("{FULLSCREEN_WGSL}{BLUR_WGSL}"))?;
    let blur = pipeline(gpu, "pointcloud blur", &blur_module, ["vsFull", "fsBlur"], ACC, None, &layouts.blur)?;
    let composite_module = gpu.shader("pointcloud fsComposite", &format!("{FULLSCREEN_WGSL}{COMPOSITE_WGSL}"))?;
    let composite = pipeline(gpu, "pointcloud composite", &composite_module, ["vsFull", "fsComposite"], TARGET_FORMAT, None, &layouts.composite)?;

    let uniform_buf = gpu.uniform_buffer("pointcloud uniforms", 128);
    let post_buf = gpu.uniform_buffer("pointcloud post", 64);
    let blur_bufs = [[1.6_f32, 0.0, 0.0, 0.0], [0.0, 1.6, 0.0, 0.0]].map(|d| {
        let b = gpu.uniform_buffer("pointcloud blur dir", 16);
        gpu.queue.write_buffer(&b, 0, bytemuck::cast_slice(&d));
        b
    });
    let (depth, lut, ir) = (kg.depth_buffer(), kg.lut_buffer(), kg.ir_buffer());
    let points_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("pointcloud points"),
        layout: &points_layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: depth.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: lut.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: ir.as_entire_binding() },
        ],
    });
    let sampler = gpu.linear_sampler();
    let targets = make_targets(gpu, &layouts, &sampler, &blur_bufs, &post_buf, ctx.width, ctx.height);
    Ok(Box::new(Pointcloud {
        gpu: gpu.clone(),
        points,
        down,
        blur,
        composite,
        layouts,
        sampler,
        uniform_buf,
        post_buf,
        blur_bufs,
        points_group,
        targets,
        camera: OrbitCamera { pivot_z: 2.5, started: false },
        fx: 365.5,
        uniforms: [0.0; 32],
    }))
}

fn make_targets(gpu: &Gpu, layouts: &Layouts, sampler: &wgpu::Sampler, blur_bufs: &[wgpu::Buffer; 2], post_buf: &wgpu::Buffer, w: u32, h: u32) -> Targets {
    let usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
    let tex = |label: &str, tw: u32, th: u32| gpu.texture(label, tw.max(1), th.max(1), ACC, usage).create_view(&Default::default());
    let acc = tex("pointcloud acc", w, h);
    let (qw, qh) = (w.div_ceil(4), h.div_ceil(4));
    let q1 = tex("pointcloud q1", qw, qh);
    let q2 = tex("pointcloud q2", qw, qh);
    let group = |layout: &wgpu::BindGroupLayout, entries: &[wgpu::BindGroupEntry]| gpu.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("pointcloud"), layout, entries });
    let view = wgpu::BindingResource::TextureView;
    let samp = wgpu::BindingResource::Sampler(sampler);
    Targets {
        w,
        h,
        down: group(&layouts.down, &[wgpu::BindGroupEntry { binding: 0, resource: view(&acc) }, wgpu::BindGroupEntry { binding: 1, resource: samp.clone() }]),
        blur_h: group(
            &layouts.blur,
            &[wgpu::BindGroupEntry { binding: 0, resource: view(&q1) }, wgpu::BindGroupEntry { binding: 1, resource: samp.clone() }, wgpu::BindGroupEntry { binding: 2, resource: blur_bufs[0].as_entire_binding() }],
        ),
        blur_v: group(
            &layouts.blur,
            &[wgpu::BindGroupEntry { binding: 0, resource: view(&q2) }, wgpu::BindGroupEntry { binding: 1, resource: samp.clone() }, wgpu::BindGroupEntry { binding: 2, resource: blur_bufs[1].as_entire_binding() }],
        ),
        composite: group(
            &layouts.composite,
            &[
                wgpu::BindGroupEntry { binding: 0, resource: view(&acc) },
                wgpu::BindGroupEntry { binding: 1, resource: view(&q1) },
                wgpu::BindGroupEntry { binding: 2, resource: samp },
                wgpu::BindGroupEntry { binding: 3, resource: post_buf.as_entire_binding() },
            ],
        ),
        acc,
        q1,
        q2,
    }
}

/// One fullscreen triangle into `view`.
fn full(enc: &mut wgpu::CommandEncoder, view: &wgpu::TextureView, pipeline: &wgpu::RenderPipeline, group: &wgpu::BindGroup) {
    let mut pass = begin_pass(enc, "pointcloud", view);
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, group, &[]);
    pass.draw(0..3, 0..1);
}

impl Scene for Pointcloud {
    fn frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String> {
        let p = ctx.params;
        let (w, h) = (ctx.width.max(1), ctx.height.max(1));
        if self.targets.w != w || self.targets.h != h {
            self.targets = make_targets(&self.gpu, &self.layouts, &self.sampler, &self.blur_bufs, &self.post_buf, w, h);
        }
        if ctx.kinect.fresh.lut || ctx.frame == 0 {
            self.fx = focal_of_rays(&ctx.kinect.rays());
        }
        let median = ctx.kinect.meta.as_ref().and_then(|m| m.get("stats")?.get("median_mm")?.as_f64());
        if !self.camera.started {
            self.camera.started = true;
            self.camera.settle(median);
        } else if ctx.kinect.fresh.meta {
            self.camera.track(median);
        }
        let step = match p.f("step") {
            s if s.is_finite() && s != 0.0 => s,
            _ => 2.0,
        };
        let cols = (KW as f32 / step).ceil() as u32;
        let rows = (KH as f32 / step).ceil() as u32;
        let (view_proj, focal_px) = self.camera.update(ctx.now_ms, f64::from(w), f64::from(h));
        let u = &mut self.uniforms;
        u[0..16].copy_from_slice(&view_proj);
        u[16..20].copy_from_slice(&[w as f32, h as f32, 1.0 / w as f32, 1.0 / h as f32]);
        u[20..24].copy_from_slice(&[p.f("dotFill"), step, self.fx, focal_px]);
        u[24..28].copy_from_slice(&[1.0 + p.f("fog"), p.f("fog"), ctx.x_sign, p.f("irMix")]);
        u[28..32].copy_from_slice(&[cols, rows, step as u32, 0].map(f32::from_bits));
        ctx.gpu.queue.write_buffer(&self.uniform_buf, 0, bytemuck::cast_slice(&self.uniforms));
        let rgb = |key: &str| {
            let c = p.color(key);
            [c[0], c[1], c[2], 1.0]
        };
        let [d, c, e] = [rgb("dotColor"), rgb("bgCenter"), rgb("bgEdge")];
        let post = [d[0], d[1], d[2], d[3], c[0], c[1], c[2], c[3], e[0], e[1], e[2], e[3], p.f("gain"), p.f("glow"), 0.0, 0.0];
        ctx.gpu.queue.write_buffer(&self.post_buf, 0, bytemuck::cast_slice(&post));

        let t = &self.targets;
        let enc = &mut *ctx.encoder;
        {
            let mut rp = begin_pass(enc, "pointcloud points", &t.acc);
            if ctx.kinect.depth.is_some() {
                rp.set_pipeline(&self.points);
                rp.set_bind_group(0, &self.points_group, &[]);
                rp.draw(0..6, 0..cols * rows);
            }
        }
        if p.f("glow") > 0.0 {
            full(enc, &t.q1, &self.down, &t.down);
            full(enc, &t.q2, &self.blur, &t.blur_h);
            full(enc, &t.q1, &self.blur, &t.blur_v);
        }
        full(enc, ctx.target, &self.composite, &t.composite);
        *ctx.status = format!("{}k Punkte", (f64::from(cols * rows) / 1000.0).round());
        Ok(())
    }
}

pub static DEF: SceneDef = SceneDef {
    name: "pointcloud",
    title: "Punktwolke",
    params,
    projection: no_projection,
    persons: no_persons,
    streams,
    max_fps: no_cap,
    make,
};

wall::export_scenes!(&DEF);
