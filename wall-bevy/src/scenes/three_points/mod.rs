//! three.js Partikel (port of web/scenes/three-points): the Kinect points as glowing, colored
//! sprites as three.js draws them (WebGPURenderer with antialias, a Sprite with PointsNodeMaterial,
//! additive blending, sizeAttenuation, shapeCircle()) and OrbitControls (damping, auto rotation).
//!
//! No three.js here, the same pipeline with wgpu: the sprites go additively into a 4x multisampled
//! linear rgba16float target (three's framebuffer target), the output pass encodes it to sRGB as
//! three's output color transform does. The browser computed positions and colors on the CPU for
//! every new depth frame; here the vertex shader computes the same points from the depth, ray and
//! IR buffers.

use serde_json::json;

use crate::gpu::{FULLSCREEN_WGSL, Gpu, TARGET_FORMAT, begin_pass, layout};
use crate::kinect_gpu::{KH, KW};
use crate::params::{ParamSpec, Params, boolean, color, num, select_map};
use crate::persons::PersonOptions;
use crate::scene::{FrameCtx, Scene, SceneDef, SetupCtx, no_cap, no_projection};

const SPRITES_WGSL: &str = r"
struct Uni {
  view: mat4x4f,       // the camera's view matrix (the sprite sits at the origin)
  proj: mat4x4f,
  p0: vec4f,           // size (m), half the canvas height (px), viewport width, height (px)
  p1: vec4f,           // xSign, irBoost, IR present, unused
  nearColor: vec4f,    // linear rgb
  farColor: vec4f,
  grid: vec4u,         // cols, rows, step, unused
};
@group(0) @binding(0) var<uniform> U: Uni;
@group(0) @binding(1) var<storage, read> depth: array<u32>;  // u16 mm pairs
@group(0) @binding(2) var<storage, read> rays: array<vec2f>; // x, y per pixel: point = (x*z, y*z, z)
@group(0) @binding(3) var<storage, read> ir: array<u32>;     // u8 quads

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
};

fn depthAt(i: u32) -> u32 {
  let w = depth[i >> 1u];
  return select(w & 0xffffu, w >> 16u, (i & 1u) == 1u);
}

fn irAt(i: u32) -> f32 {
  return f32((ir[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var out: VOut;
  out.pos = vec4f(0.0, 0.0, -1.0, 1.0); // outside the clip volume: not drawn
  out.uv = vec2f(0.0);
  out.color = vec3f(0.0);
  let step = U.grid.z;
  let u = (ii % U.grid.x) * step;
  let v = (ii / U.grid.x) * step;
  if (u >= 512u || v >= 424u) { return out; }
  let i = v * 512u + u;
  let mm = depthAt(i);
  if (mm == 0u) { return out; }
  let z = f32(mm) * 0.001;
  let r = rays[i];
  // Kinect (x right, y down, z forward) -> three.js (y up, the camera looks along -z)
  let p = vec3f(U.p1.x * r.x * z, -r.y * z, -z);
  let t = clamp((z - 0.8) / 3.5, 0.0, 1.0);
  let b = select(1.0, 0.3 + (U.p1.y * irAt(i)) / 255.0, U.p1.z > 0.5);
  out.color = (U.nearColor.rgb + (U.farColor.rgb - U.nearColor.rgb) * t) * b;
  // PointsNodeMaterial on a Sprite: a square of `size` px around the point, sizeAttenuation
  // scales by half the canvas height over the view depth
  let mv = U.view * vec4f(p, 1.0);
  let clip = U.proj * mv;
  let size = U.p0.x * (U.p0.y / -mv.z);
  // the sprite geometry: two triangles of the unit square around the center, uv 0..1
  var corner = array<vec2f, 6>(vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(0.5, 0.5), vec2f(-0.5, -0.5), vec2f(0.5, 0.5), vec2f(-0.5, 0.5));
  let c = corner[vi];
  let offset = c * size / (U.p0.zw / 2.0) * clip.w;
  out.pos = vec4f(clip.xy + offset, clip.zw);
  out.uv = c + vec2f(0.5);
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  // shapeCircle() without alpha to coverage: 1 inside the circle of the sprite, 0 outside
  let q = in.uv * 2.0 - 1.0;
  let alpha = select(1.0, 0.0, dot(q, q) > 1.0);
  return max(vec4f(in.color, alpha), vec4f(0.0));
}
";

/// three's output color transform: linear -> sRGB (sRGBTransferOETF), into the canvas
const OUTPUT_WGSL: &str = r"
@group(0) @binding(0) var src: texture_2d<f32>;
@fragment
fn fs_output(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let c = textureLoad(src, vec2i(fc.xy), 0);
  let a = pow(max(c.rgb, vec3f(0.0)), vec3f(0.41666)) * 1.055 - 0.055;
  let b = c.rgb * 12.92;
  return vec4f(select(a, b, c.rgb <= vec3f(0.0031308)), c.a);
}
";

const HDR: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
const SAMPLES: u32 = 4;
const UNIFORM_FLOATS: usize = 52;
/// renderer.setClearColor(0x0b0b0e)
const CLEAR: [u8; 3] = [0x0b, 0x0b, 0x0e];
/// PerspectiveCamera(55, aspect, 0.05, 50); OrbitControls: target, damping, auto rotation
const FOV_DEG: f64 = 55.0;
const NEAR: f64 = 0.05;
const FAR: f64 = 50.0;
const START: [f64; 3] = [0.0, 0.25, 0.6];
const TARGET: [f64; 3] = [0.0, 0.0, -2.5];
const DAMPING: f64 = 0.05;
const AUTO_ROTATE_SPEED: f64 = 0.8;

fn params() -> Vec<ParamSpec> {
    vec![
        select_map("step", json!(2), &[("jedes Pixel", json!(1)), ("jedes 2.", json!(2)), ("jedes 3.", json!(3))], "Dichte"),
        // world units: sizeAttenuation
        num("size", 0.012, 0.002, 0.08, 0.001, "Punktgröße (m)"),
        num("irBoost", 0.8, 0.0, 2.0, 0.05, "IR-Helligkeit"),
        color("nearColor", "#ff8a3d", "Farbe nah"),
        color("farColor", "#3d7bff", "Farbe fern"),
        boolean("autoRotate", true, "Auto-Rotation"),
    ]
}

fn streams(_: &Params) -> Vec<&'static str> {
    vec!["depth", "ir"]
}

fn no_persons(_: &Params) -> Option<PersonOptions> {
    None
}

/// THREE.Color.set('#rrggbb'): sRGB -> linear working color space (ColorManagement)
fn srgb_to_linear(c: f32) -> f32 {
    if c < 0.04045 { c * 0.077_399_38 } else { (c * 0.947_867_3 + 0.052_132_7).powf(2.4) }
}

/// OrbitControls with damping on a camera nobody drags: only the auto rotation turns it.
struct Orbit {
    radius: f64,
    phi: f64,
    theta: f64,
    /// sphericalDelta.theta
    delta: f64,
}

impl Orbit {
    fn new() -> Self {
        let o = [START[0] - TARGET[0], START[1] - TARGET[1], START[2] - TARGET[2]];
        let radius = (o[0] * o[0] + o[1] * o[1] + o[2] * o[2]).sqrt();
        Self { radius, phi: (o[1] / radius).clamp(-1.0, 1.0).acos(), theta: o[0].atan2(o[2]), delta: 0.0 }
    }

    /// controls.update(dt): the camera position for this frame
    fn update(&mut self, auto_rotate: bool, dt: f64) -> [f64; 3] {
        if auto_rotate {
            self.delta -= std::f64::consts::TAU / 60.0 * AUTO_ROTATE_SPEED * dt;
        }
        self.theta += self.delta * DAMPING;
        let phi = self.phi.clamp(1e-6, std::f64::consts::PI - 1e-6);
        self.delta *= 1.0 - DAMPING;
        let s = phi.sin() * self.radius;
        [TARGET[0] + s * self.theta.sin(), TARGET[1] + phi.cos() * self.radius, TARGET[2] + s * self.theta.cos()]
    }
}

/// camera.lookAt(target): the view matrix (inverse of the camera's world matrix), column-major
fn view_matrix(eye: [f64; 3]) -> [f64; 16] {
    let norm = |v: [f64; 3]| {
        let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        if l > 0.0 { v.map(|x| x / l) } else { v }
    };
    let cross = |a: [f64; 3], b: [f64; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let z = norm([eye[0] - TARGET[0], eye[1] - TARGET[1], eye[2] - TARGET[2]]);
    let x = norm(cross([0.0, 1.0, 0.0], z));
    let y = cross(z, x);
    let d = |a: [f64; 3]| -(a[0] * eye[0] + a[1] * eye[1] + a[2] * eye[2]);
    [x[0], y[0], z[0], 0.0, x[1], y[1], z[1], 0.0, x[2], y[2], z[2], 0.0, d(x), d(y), d(z), 1.0]
}

/// PerspectiveCamera.projectionMatrix for WebGPU (depth 0..1), column-major
fn projection(aspect: f64) -> [f64; 16] {
    let top = NEAR * ((FOV_DEG / 2.0).to_radians()).tan();
    let (height, width) = (2.0 * top, aspect * 2.0 * top);
    let (x, y) = (2.0 * NEAR / width, 2.0 * NEAR / height);
    let (c, d) = (-FAR / (FAR - NEAR), -FAR * NEAR / (FAR - NEAR));
    [x, 0.0, 0.0, 0.0, 0.0, y, 0.0, 0.0, 0.0, 0.0, c, -1.0, 0.0, 0.0, d, 0.0]
}

struct Targets {
    w: u32,
    h: u32,
    msaa: wgpu::TextureView,
    resolved: wgpu::TextureView,
    output: wgpu::BindGroup,
}

struct ThreePoints {
    gpu: Gpu,
    sprites: wgpu::RenderPipeline,
    output: wgpu::RenderPipeline,
    output_layout: wgpu::BindGroupLayout,
    uniform_buf: wgpu::Buffer,
    group: wgpu::BindGroup,
    targets: Targets,
    orbit: Orbit,
    clear: wgpu::Color,
    /// points of the last depth frame (sprite.count)
    count: usize,
    uniforms: [f32; UNIFORM_FLOATS],
}

fn make_targets(gpu: &Gpu, output_layout: &wgpu::BindGroupLayout, w: u32, h: u32) -> Result<Targets, String> {
    let (msaa, err) = gpu.scoped(|| {
        gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("three-points msaa"),
            size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: SAMPLES,
            dimension: wgpu::TextureDimension::D2,
            format: HDR,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        })
    });
    if let Some(e) = err {
        return Err(format!("three-points: MSAA-Ziel: {e}"));
    }
    let resolved = gpu.texture("three-points frame", w.max(1), h.max(1), HDR, wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING).create_view(&Default::default());
    let output = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("three-points output"),
        layout: output_layout,
        entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&resolved) }],
    });
    Ok(Targets { w, h, msaa: msaa.create_view(&Default::default()), resolved, output })
}

fn make(ctx: &SetupCtx) -> Result<Box<dyn Scene>, String> {
    let gpu = &ctx.gpu;
    let kg = &ctx.kgpu;
    let (v, f) = (wgpu::ShaderStages::VERTEX, wgpu::ShaderStages::FRAGMENT);
    let layout = gpu.bind_group_layout("three-points sprites", &[layout::uniform(0, v), layout::storage(1, v, true), layout::storage(2, v, true), layout::storage(3, v, true)]);
    let output_layout = gpu.bind_group_layout("three-points output", &[layout::float_tex(0, f, false)]);
    let module = gpu.shader("three-points sprites", SPRITES_WGSL)?;
    let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("three-points sprites"), bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
    // AdditiveBlending (not premultiplied): color SrcAlpha + One, alpha One + One
    let color_blend = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::SrcAlpha, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add };
    let alpha_blend = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add };
    let sprites = gpu.render_pipeline("three-points sprites", |d| {
        d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("three-points sprites"),
            layout: Some(&pl),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: HDR, blend: Some(wgpu::BlendState { color: color_blend, alpha: alpha_blend }), write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState { count: SAMPLES, mask: !0, alpha_to_coverage_enabled: false },
            multiview_mask: None,
            cache: None,
        })
    })?;
    let out_module = gpu.shader("three-points output", &format!("{FULLSCREEN_WGSL}{OUTPUT_WGSL}"))?;
    let opl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("three-points output"), bind_group_layouts: &[Some(&output_layout)], immediate_size: 0 });
    let output = gpu.render_pipeline("three-points output", |d| {
        d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("three-points output"),
            layout: Some(&opl),
            vertex: wgpu::VertexState { module: &out_module, entry_point: Some("vs_fullscreen"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState {
                module: &out_module,
                entry_point: Some("fs_output"),
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
    let uniform_buf = gpu.uniform_buffer("three-points uniforms", (UNIFORM_FLOATS * 4) as u64);
    let (depth, lut, ir) = (kg.depth_buffer(), kg.lut_buffer(), kg.ir_buffer());
    let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("three-points sprites"),
        layout: &layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: depth.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: lut.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: ir.as_entire_binding() },
        ],
    });
    let targets = make_targets(gpu, &output_layout, ctx.width, ctx.height)?;
    let [r, g, b] = CLEAR.map(|c| f64::from(srgb_to_linear(f32::from(c) / 255.0)));
    Ok(Box::new(ThreePoints {
        gpu: gpu.clone(),
        sprites,
        output,
        output_layout,
        uniform_buf,
        group,
        targets,
        orbit: Orbit::new(),
        clear: wgpu::Color { r, g, b, a: 1.0 },
        count: 0,
        uniforms: [0.0; UNIFORM_FLOATS],
    }))
}

impl Scene for ThreePoints {
    fn frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String> {
        let p = ctx.params;
        let (w, h) = (ctx.width.max(1), ctx.height.max(1));
        if self.targets.w != w || self.targets.h != h {
            self.targets = make_targets(&self.gpu, &self.output_layout, w, h)?;
        }
        let step = match p.f("step") {
            s if s.is_finite() && s != 0.0 => s,
            _ => 2.0,
        };
        let (cols, rows) = ((KW as f32 / step).ceil() as u32, (KH as f32 / step).ceil() as u32);
        // sprite.count: the points of the newest depth frame
        if ctx.kinect.fresh.depth
            && let Some(d) = &ctx.kinect.depth
        {
            let s = (step as usize).max(1);
            self.count = (0..KH as usize).step_by(s).filter_map(|v| d.mm.get(v * KW as usize..(v + 1) * KW as usize)).map(|row| row.iter().step_by(s).filter(|&&mm| mm != 0).count()).sum();
        }
        let eye = self.orbit.update(p.b("autoRotate"), f64::from(ctx.dt));
        let view = view_matrix(eye);
        let proj = projection(f64::from(w) / f64::from(h));
        let near = p.color("nearColor").map(srgb_to_linear);
        let far = p.color("farColor").map(srgb_to_linear);
        let u = &mut self.uniforms;
        u[0..16].copy_from_slice(&view.map(|x| x as f32));
        u[16..32].copy_from_slice(&proj.map(|x| x as f32));
        u[32..36].copy_from_slice(&[p.f("size"), 0.5 * h as f32, w as f32, h as f32]);
        u[36..40].copy_from_slice(&[ctx.x_sign, p.f("irBoost"), if ctx.kinect.ir.is_some() { 1.0 } else { 0.0 }, 0.0]);
        u[40..44].copy_from_slice(&[near[0], near[1], near[2], 1.0]);
        u[44..48].copy_from_slice(&[far[0], far[1], far[2], 1.0]);
        u[48..52].copy_from_slice(&[cols, rows, step as u32, 0].map(f32::from_bits));
        ctx.gpu.queue.write_buffer(&self.uniform_buf, 0, bytemuck::cast_slice(&self.uniforms));

        let t = &self.targets;
        let enc = &mut *ctx.encoder;
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("three-points sprites"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &t.msaa,
                    depth_slice: None,
                    resolve_target: Some(&t.resolved),
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(self.clear), store: wgpu::StoreOp::Discard },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            if ctx.kinect.depth.is_some() {
                pass.set_pipeline(&self.sprites);
                pass.set_bind_group(0, &self.group, &[]);
                pass.draw(0..6, 0..cols * rows);
            }
        }
        {
            let mut pass = begin_pass(enc, "three-points output", ctx.target);
            pass.set_pipeline(&self.output);
            pass.set_bind_group(0, &t.output, &[]);
            pass.draw(0..3, 0..1);
        }
        *ctx.status = format!("{}k Punkte", (self.count as f64 / 1000.0).round());
        Ok(())
    }
}

pub static DEF: SceneDef = SceneDef {
    name: "three-points",
    title: "three.js Partikel",
    params,
    projection: no_projection,
    persons: no_persons,
    streams,
    max_fps: no_cap,
    make,
};
