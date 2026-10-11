//! A fullscreen fragment shader with the Kinect data bound (port of web/lib/shader-pass.js): the
//! scene writes `fn shade(pos: vec2f, uv: vec2f) -> vec4f` in WGSL and gets the same helpers as in
//! the browser (F, P, kinectUv, depthAt, personMask, personJoint, wallPerson, ...). The browser
//! scenes' .wgsl files run unchanged.

use crate::gpu::{FULLSCREEN_WGSL, Gpu, GpuResult, TARGET_FORMAT, layout};
use crate::kinect_gpu::{KinectGpu, PERSON_POINTS};
use crate::params::{Kind, ParamSpec};
use crate::persons::{BONES, MAX_PERSONS, PERSON_COLORS, POINTS};
use crate::scene::FrameCtx;
use crate::wall::wall_wgsl;
use crate::wall_persons::WallPersons;

/// WGSL struct for the params, plus where each value goes (floats) in the uniform.
pub struct ParamLayout {
    code: String,
    size: usize,
    writers: Vec<(usize, ParamSpec)>,
}

fn param_layout(specs: &[ParamSpec]) -> ParamLayout {
    let mut fields = Vec::new();
    let mut writers = Vec::new();
    let mut offset = 0usize;
    for p in specs {
        let ok = p.key.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && p.key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !ok {
            continue;
        }
        match p.kind {
            Kind::Color => {
                offset = offset.div_ceil(16) * 16;
                fields.push(format!("{}: vec3f", p.key));
                writers.push((offset / 4, p.clone()));
                offset += 12;
            }
            Kind::Number { .. } | Kind::Bool | Kind::Select(_) => {
                fields.push(format!("{}: f32", p.key));
                writers.push((offset / 4, p.clone()));
                offset += 4;
            }
            Kind::Text => {}
        }
    }
    if fields.is_empty() {
        fields.push("_unused: f32".into());
        offset = 4;
    }
    ParamLayout { code: format!("struct Params {{\n  {},\n}};", fields.join(",\n  ")), size: offset.div_ceil(16) * 16, writers }
}

/// `J_LEFT_HAND` from `leftHand`
fn joint_const(name: &str) -> String {
    let mut s = String::new();
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            s.push('_');
        }
        s.push(c.to_ascii_uppercase());
    }
    format!("J_{s}")
}

pub fn prelude(layout: &ParamLayout, filterable: bool) -> String {
    let colors: Vec<String> = PERSON_COLORS
        .iter()
        .map(|h| {
            let c = crate::persons::hex_rgb(h);
            format!("vec3f({:.4}, {:.4}, {:.4})", c[0], c[1], c[2])
        })
        .collect();
    let joints: String = POINTS.iter().enumerate().map(|(i, n)| format!("const {} = {}u;\n", joint_const(n), i)).collect();
    let bones: Vec<String> = BONES.iter().map(|(a, b)| format!("vec2u({a}u, {b}u)")).collect();
    let depth_smooth = if filterable { "return textureSampleLevel(depthTex, smoothSampler, k, 0.0).r;" } else { "return depthAt(k);" };
    format!(
        r"struct Frame {{
  resolution: vec2f, // canvas size in pixels
  time: f32,         // seconds since the scene started
  dt: f32,           // seconds since the previous frame
  mouse: vec4f,      // xy: pointer in pixels, z: 1 while a button is pressed
  xSign: f32,        // -1 = geometrically correct (default), 1 = mirror view
  frame: f32,        // frame counter
  depthAge: f32,     // seconds since the sensor captured the current depth frame
  hasDepth: f32,     // 1 once depth data arrived
}};
{params}
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> P: Params;
@group(0) @binding(2) var depthTex: texture_2d<f32>; // meters, 0 = no measurement
@group(0) @binding(3) var irTex: texture_2d<f32>;    // infrared 0..1
@group(0) @binding(4) var lutTex: texture_2d<f32>;   // rg: ray per pixel, point = (x*z, y*z, z)
@group(0) @binding(5) var prevTex: texture_2d<f32>;  // previous output (feedback: true)
@group(0) @binding(6) var smoothSampler: sampler;
@group(0) @binding(7) var personTex: texture_2d<u32>;      // slot of the person per pixel, 0 = none
@group(0) @binding(8) var personDepthTex: texture_2d<f32>; // meters, person pixels only
@group(0) @binding(9) var<storage, read> personPoints: array<vec4f>; // see personJoint()
@group(0) @binding(11) var wallPersonTex: texture_2d<f32>; // wall_persons.rs
{wall}

const KINECT_SIZE = vec2f(512.0, 424.0);

fn kinectUv(uv: vec2f) -> vec2f {{
  if (WALL.ledImage > 0.5) {{ return wallToKinect(uv); }}
  let screen = F.resolution.x / max(F.resolution.y, 1.0);
  let image = KINECT_SIZE.x / KINECT_SIZE.y;
  var k = uv - vec2f(0.5);
  if (screen > image) {{ k.y = k.y * image / screen; }} else {{ k.x = k.x * screen / image; }}
  k = k + vec2f(0.5);
  if (F.xSign < 0.0) {{ k.x = 1.0 - k.x; }}
  return k;
}}
fn inImage(k: vec2f) -> bool {{ return all(k >= vec2f(0.0)) && all(k <= vec2f(1.0)); }}
fn kinectPx(k: vec2f) -> vec2i {{ return vec2i(clamp(k, vec2f(0.0), vec2f(0.99999)) * KINECT_SIZE); }}
fn depthAt(k: vec2f) -> f32 {{ return textureLoad(depthTex, kinectPx(k), 0).r; }}
fn depthSmooth(k: vec2f) -> f32 {{ {depth_smooth} }}
fn irAt(k: vec2f) -> f32 {{ return textureSampleLevel(irTex, smoothSampler, k, 0.0).r; }}
fn pointAt(k: vec2f) -> vec3f {{
  let px = kinectPx(k);
  let z = textureLoad(depthTex, px, 0).r;
  let ray = textureLoad(lutTex, px, 0).rg;
  return vec3f(F.xSign * ray.x * z, -ray.y * z, z);
}}
fn prev(uv: vec2f) -> vec4f {{ return textureSampleLevel(prevTex, smoothSampler, uv, 0.0); }}
fn personAt(k: vec2f) -> u32 {{ return textureLoad(personTex, kinectPx(k), 0).r; }}
fn isPerson(k: vec2f) -> bool {{ return personAt(k) > 0u; }}
fn personMask(k: vec2f) -> f32 {{
  let p = clamp(k, vec2f(0.0), vec2f(1.0)) * KINECT_SIZE - vec2f(0.5);
  let i = vec2i(floor(p));
  let f = fract(p);
  let hi = vec2i(511, 423);
  let a = f32(textureLoad(personTex, clamp(i, vec2i(0), hi), 0).r > 0u);
  let b = f32(textureLoad(personTex, clamp(i + vec2i(1, 0), vec2i(0), hi), 0).r > 0u);
  let c = f32(textureLoad(personTex, clamp(i + vec2i(0, 1), vec2i(0), hi), 0).r > 0u);
  let d = f32(textureLoad(personTex, clamp(i + vec2i(1, 1), vec2i(0), hi), 0).r > 0u);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}}
fn personDepthAt(k: vec2f) -> f32 {{ return textureLoad(personDepthTex, kinectPx(k), 0).r; }}
fn personPointAt(k: vec2f) -> vec3f {{
  let px = kinectPx(k);
  let z = textureLoad(personDepthTex, px, 0).r;
  let ray = textureLoad(lutTex, px, 0).rg;
  return vec3f(F.xSign * ray.x * z, -ray.y * z, z);
}}
const PERSON_COLORS = array<vec3f, {ncolors}>({colors});
fn personColor(slot: u32) -> vec3f {{ return PERSON_COLORS[min(slot, {maxcolor}u)]; }}
{joints}const PERSON_SLOTS = {slots}u;
const PERSON_POINTS = {points}u;
const BONE_COUNT = {nbones}u;
const BONES = array<vec2u, {nbones}>({bones});
fn personEntry(slot: u32, j: u32) -> u32 {{ return (min(slot, PERSON_SLOTS) * PERSON_POINTS + min(j, PERSON_POINTS - 1u)) * 2u; }}
fn personInfo(slot: u32) -> vec4f {{ return personPoints[personEntry(slot, PERSON_POINTS - 1u)]; }}
fn personVisible(slot: u32) -> bool {{ return slot > 0u && personInfo(slot).x > 0.5; }}
fn personBox(slot: u32) -> vec4f {{ return personPoints[personEntry(slot, PERSON_POINTS - 1u) + 1u]; }}
fn personJointUv(slot: u32, j: u32) -> vec4f {{ return personPoints[personEntry(slot, j)]; }}
fn personJoint(slot: u32, j: u32) -> vec4f {{ return personPoints[personEntry(slot, j) + 1u]; }}
fn segmentDist(p: vec2f, a: vec2f, b: vec2f) -> f32 {{
  let ab = b - a;
  let t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return length(p - a - ab * t);
}}
fn personBoneDist(k: vec2f, slot: u32) -> f32 {{
  var d = 1e6;
  if (!personVisible(slot)) {{ return d; }}
  let p = k * KINECT_SIZE;
  for (var b = 0u; b < BONE_COUNT; b++) {{
    let a = personJointUv(slot, BONES[b].x);
    let c = personJointUv(slot, BONES[b].y);
    if (a.w > 0.0 && c.w > 0.0) {{ d = min(d, segmentDist(p, a.xy * KINECT_SIZE, c.xy * KINECT_SIZE)); }}
  }}
  return d;
}}
fn wallPersonPx(uv: vec2f) -> vec2i {{
  let size = vec2f(textureDimensions(wallPersonTex));
  return vec2i(clamp(uv, vec2f(0.0), vec2f(0.99999)) * size);
}}
fn wallPersonMask(uv: vec2f) -> f32 {{ return textureSampleLevel(wallPersonTex, smoothSampler, uv, 0.0).r; }}
fn wallPersonAt(uv: vec2f) -> u32 {{ return u32(textureLoad(wallPersonTex, wallPersonPx(uv), 0).b + 0.5); }}
fn wallPerson(uv: vec2f) -> vec4f {{
  let v = textureLoad(wallPersonTex, wallPersonPx(uv), 0);
  return vec4f(wallPersonMask(uv), v.g, v.b, v.a);
}}
fn skeletonDist(k: vec2f) -> vec2f {{
  var best = vec2f(1e6, 0.0);
  for (var s = 1u; s <= PERSON_SLOTS; s++) {{
    if (!personVisible(s)) {{ continue; }}
    let box = personBox(s);
    let m = 40.0 / KINECT_SIZE;
    if (any(k < box.xy - m) || any(k > box.zw + m)) {{ continue; }}
    let d = personBoneDist(k, s);
    if (d < best.x) {{ best = vec2f(d, f32(s)); }}
  }}
  return best;
}}
",
        params = layout.code,
        wall = wall_wgsl(0, 10),
        depth_smooth = depth_smooth,
        ncolors = PERSON_COLORS.len(),
        colors = colors.join(", "),
        maxcolor = PERSON_COLORS.len() - 1,
        joints = joints,
        slots = MAX_PERSONS,
        points = PERSON_POINTS,
        nbones = BONES.len(),
        bones = bones.join(", "),
    )
}

const MAIN_WGSL: &str = r"
@fragment fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return shade(pos.xy, pos.xy / F.resolution);
}";

const BLIT_WGSL: &str = r"
@group(0) @binding(0) var src: texture_2d<f32>;
@fragment fn fs_blit(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return vec4f(textureLoad(src, vec2i(pos.xy), 0).rgb, 1.0);
}";

struct Feedback {
    w: u32,
    h: u32,
    _textures: [wgpu::Texture; 2],
    views: [wgpu::TextureView; 2],
    groups: [wgpu::BindGroup; 2],
    blits: [wgpu::BindGroup; 2],
    current: usize,
}

pub struct ShaderPass {
    pipeline: wgpu::RenderPipeline,
    blit: Option<(wgpu::RenderPipeline, wgpu::BindGroupLayout)>,
    bgl: wgpu::BindGroupLayout,
    frame_buf: wgpu::Buffer,
    param_buf: wgpu::Buffer,
    param_size: usize,
    writers: Vec<(usize, ParamSpec)>,
    views: Vec<wgpu::TextureView>,
    point_buf: wgpu::Buffer,
    wall_buf: wgpu::Buffer,
    sampler: wgpu::Sampler,
    black: wgpu::TextureView,
    wall_persons: Option<WallPersons>,
    plain: wgpu::BindGroup,
    feedback: Option<Feedback>,
    want_feedback: bool,
    /// the param uniform of a frame, reused
    scratch: Vec<f32>,
    gpu: Gpu,
}

impl ShaderPass {
    /// `key` names the shader in the cache (one per scene); `shade` is the scene's WGSL.
    pub fn new(gpu: &Gpu, kg: &KinectGpu, wall_buf: &wgpu::Buffer, led: [u32; 2], key: &str, specs: &[ParamSpec], shade: &str, feedback: bool) -> GpuResult<Self> {
        let layout = param_layout(specs);
        let head = prelude(&layout, gpu.float32_filterable);
        let code = format!("{head}\n{shade}\n{FULLSCREEN_WGSL}\n{MAIN_WGSL}");
        let module = gpu.shader(&format!("{key}: shade()"), &code).map_err(|e| {
            // line numbers of the scene's own shade.wgsl
            let off = head.lines().count() + 1;
            renumber(&e, off)
        })?;
        let f = wgpu::ShaderStages::FRAGMENT;
        let filterable = gpu.float32_filterable;
        let bgl = gpu.bind_group_layout(
            if filterable { "shade-pass" } else { "shade-pass-nf" },
            &[
                layout::uniform(0, f),
                layout::uniform(1, f),
                layout::float_tex(2, f, filterable),
                layout::float_tex(3, f, true),
                layout::float_tex(4, f, filterable),
                layout::float_tex(5, f, true),
                layout::sampler(6, f, true),
                layout::uint_tex(7, f),
                layout::float_tex(8, f, false),
                layout::storage(9, f, true),
                layout::uniform(10, f),
                layout::float_tex(11, f, true),
            ],
        );
        let target = if feedback { wgpu::TextureFormat::Rgba16Float } else { TARGET_FORMAT };
        let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some(key), bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
        let pipeline = gpu.render_pipeline(&format!("{key}: shade() {target:?}"), |d| {
            d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(key),
                layout: Some(&pl),
                vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_fullscreen"), compilation_options: Default::default(), buffers: &[] },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some("fs_main"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState { format: target, blend: None, write_mask: wgpu::ColorWrites::ALL })],
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            })
        })?;
        let blit = if feedback {
            let m = gpu.shader("shade-pass blit", &format!("{FULLSCREEN_WGSL}\n{BLIT_WGSL}"))?;
            let bl = gpu.bind_group_layout("shade-pass blit", &[layout::float_tex(0, f, false)]);
            let bpl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("blit"), bind_group_layouts: &[Some(&bl)], immediate_size: 0 });
            let p = gpu.render_pipeline("shade-pass blit", |d| {
                d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("blit"),
                    layout: Some(&bpl),
                    vertex: wgpu::VertexState { module: &m, entry_point: Some("vs_fullscreen"), compilation_options: Default::default(), buffers: &[] },
                    fragment: Some(wgpu::FragmentState {
                        module: &m,
                        entry_point: Some("fs_blit"),
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
            Some((p, bl))
        } else {
            None
        };
        // the people on the wall: only projected if the shader asks for them
        let wall_persons = if shade.contains("wallPerson") { Some(WallPersons::new(gpu, kg, wall_buf, led)?) } else { None };
        let views = vec![kg.depth_texture(), kg.ir_texture(), kg.lut_texture(), kg.person_label_texture(), kg.person_depth_texture()];
        let black_tex = gpu.texture("shade black", 1, 1, wgpu::TextureFormat::Rgba16Float, wgpu::TextureUsages::TEXTURE_BINDING);
        let black = black_tex.create_view(&Default::default());
        let frame_buf = gpu.uniform_buffer("shade F", 48);
        let param_buf = gpu.uniform_buffer("shade P", layout.size as u64);
        let point_buf = kg.person_point_buffer();
        let sampler = gpu.linear_sampler();
        let mut pass = Self {
            pipeline,
            blit,
            bgl,
            frame_buf,
            param_buf,
            param_size: layout.size,
            writers: layout.writers,
            views,
            point_buf,
            wall_buf: wall_buf.clone(),
            sampler,
            black,
            wall_persons,
            plain: gpu.device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &gpu.bind_group_layout("empty", &[]), entries: &[] }),
            feedback: None,
            want_feedback: feedback,
            scratch: vec![0.0; layout.size / 4],
            gpu: gpu.clone(),
        };
        pass.plain = pass.group(&pass.black.clone());
        // the feedback pair now, in the setup thread: not in the first frame (a hitch)
        if feedback {
            pass.ensure_feedback(led[0], led[1]);
        }
        Ok(pass)
    }

    fn group(&self, prev: &wgpu::TextureView) -> wgpu::BindGroup {
        let wp = self.wall_persons.as_ref().map(|w| w.view.clone()).unwrap_or_else(|| self.black.clone());
        self.gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("shade"),
            layout: &self.bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.frame_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: self.param_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&self.views[0]) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&self.views[1]) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&self.views[2]) },
                wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::TextureView(prev) },
                wgpu::BindGroupEntry { binding: 6, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 7, resource: wgpu::BindingResource::TextureView(&self.views[3]) },
                wgpu::BindGroupEntry { binding: 8, resource: wgpu::BindingResource::TextureView(&self.views[4]) },
                wgpu::BindGroupEntry { binding: 9, resource: self.point_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 10, resource: self.wall_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 11, resource: wgpu::BindingResource::TextureView(&wp) },
            ],
        })
    }

    fn ensure_feedback(&mut self, w: u32, h: u32) {
        if self.feedback.as_ref().is_some_and(|f| f.w == w && f.h == h) {
            return;
        }
        let t = [self.gpu.target("shade feedback a", w, h, wgpu::TextureFormat::Rgba16Float), self.gpu.target("shade feedback b", w, h, wgpu::TextureFormat::Rgba16Float)];
        let v = [t[0].create_view(&Default::default()), t[1].create_view(&Default::default())];
        let groups = [self.group(&v[1]), self.group(&v[0])];
        let Some((_, bl)) = &self.blit else {
            return;
        };
        let mk = |view: &wgpu::TextureView| {
            self.gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("shade blit"),
                layout: bl,
                entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(view) }],
            })
        };
        let blits = [mk(&v[0]), mk(&v[1])];
        self.feedback = Some(Feedback { w, h, _textures: t, views: v, groups, blits, current: 0 });
    }

    /// The uniforms of this frame (F and P).
    fn write_uniforms(&mut self, ctx: &FrameCtx) {
        let age = if ctx.kinect.depth.is_some() { (ctx.kinect.depth_age_ms() / 1000.0).min(60.0) as f32 } else { 60.0 };
        let has = if ctx.kinect.depth.is_some() { 1.0 } else { 0.0 };
        let f = [ctx.width as f32, ctx.height as f32, ctx.time, ctx.dt, 0.0, 0.0, 0.0, 0.0, ctx.x_sign, ctx.frame as f32, age, has];
        self.gpu.queue.write_buffer(&self.frame_buf, 0, bytemuck::cast_slice(&f));
        let p = &mut self.scratch;
        p.resize(self.param_size / 4, 0.0);
        for (at, spec) in &self.writers {
            let v = ctx.params.shader_value(spec);
            match spec.kind {
                Kind::Color => p[*at..*at + 3].copy_from_slice(&v),
                _ => p[*at] = v[0],
            }
        }
        self.gpu.queue.write_buffer(&self.param_buf, 0, bytemuck::cast_slice(p));
    }

    /// Draws one frame into ctx.target (call it from frame()).
    pub fn render(&mut self, ctx: &mut FrameCtx) {
        self.write_uniforms(ctx);
        if let Some(wp) = self.wall_persons.as_mut() {
            wp.update(ctx.encoder, ctx.kinect);
        }
        let draw = |enc: &mut wgpu::CommandEncoder, view: &wgpu::TextureView, pipe: &wgpu::RenderPipeline, group: &wgpu::BindGroup| {
            let mut pass = crate::gpu::begin_pass(enc, "shade", view);
            pass.set_pipeline(pipe);
            pass.set_bind_group(0, group, &[]);
            pass.draw(0..3, 0..1);
        };
        if self.want_feedback {
            self.ensure_feedback(ctx.width, ctx.height);
            let (Some(fb), Some((blit, _))) = (self.feedback.as_mut(), self.blit.as_ref()) else {
                return;
            };
            let cur = fb.current;
            draw(ctx.encoder, &fb.views[cur], &self.pipeline, &fb.groups[cur]);
            draw(ctx.encoder, ctx.target, blit, &fb.blits[cur]);
            fb.current = 1 - cur;
        } else {
            draw(ctx.encoder, ctx.target, &self.pipeline, &self.plain);
        }
    }

    /// The people on the wall (for scenes that draw more passes on top).
    #[allow(dead_code)]
    pub fn wall_persons_view(&self) -> Option<&wgpu::TextureView> {
        self.wall_persons.as_ref().map(|w| &w.view)
    }
}

/// Shifts "line N" / ":N:" in a WGSL error to the line in the scene's own file.
fn renumber(e: &str, offset: usize) -> String {
    let mut out = String::new();
    for line in e.lines() {
        // naga: "   ┌─ wgsl:123:5"
        if let Some(pos) = line.find("wgsl:") {
            let rest = &line[pos + 5..];
            let n: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(n) = n.parse::<usize>()
                && n > offset
            {
                out.push_str(&format!("{}shade.wgsl:{}{}\n", &line[..pos], n - offset, &rest[n.to_string().len()..]));
                continue;
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}
