//! The GPU side of the fluid (main.js setup() and ensure()): the browser scene's own WGSL, the
//! pipelines, the camera textures (fixed size) and the wall resources, whose size depends on the
//! wall setup and simRes. Every bind group is made here, up front, never in a frame.
//!
//! main.js swaps read/write pairs and caches a bind group per combination. Here the stats, the
//! camera signal and its flow are a texture plus a copy of the last round (made after the compute
//! pass), the blurred people one texture (bodyBlurY gets another one on the binding it does not
//! read), so their bind groups never change; velocity and dye come back to the same texture every
//! frame; only the pressure keeps a parity (pressureIters may be odd).

use std::collections::HashMap;

use crate::gpu::{Gpu, GpuResult, TARGET_FORMAT, layout};
use crate::kinect_gpu::{KH, KW, KinectGpu};
use crate::persons::{BONES, NPOINTS, POINTS};
use crate::wall::wall_wgsl;

const COMMON: &str = include_str!("../../../../web/scenes/fluid-simulation/common.wgsl");
const KINECT: &str = include_str!("../../../../web/scenes/fluid-simulation/kinect.wgsl");
const CAMERA: &str = include_str!("../../../../web/scenes/fluid-simulation/camera.wgsl");
const SIM: &str = include_str!("../../../../web/scenes/fluid-simulation/sim.wgsl");

/// the uniforms, all f32; struct Uni in WGSL is generated from this list
pub const FIELDS: [&str; 46] = [
    "simW", "simH", "dyeW", "dyeH", "gridW", "gridH", "mouseX", "mouseY", "mouseDX", "mouseDY", "mouseDown", "dt", "time", "threshold", "flowGain", "force", "irMix", "grow", "motionOn", "armGain",
    "armBrush", "coherence", "lambda", "flowSmooth", "frameStep", "fillTarget", "balanceOn", "hueBySpeed", "personHue", "curl", "velDiss", "dyeDiss", "fade", "pressureDecay", "colorMode", "hueSpeed",
    "dyeAmount", "exposure", "shading", "splatRadius", "tintR", "tintG", "tintB", "showPeople", "showSkeleton", "showFlow",
];
pub const UNIFORM_FLOATS: usize = FIELDS.len().div_ceil(4) * 4;
const WALL_BINDING: u32 = 13;
/// skeleton buffer (see common.wgsl): per slot 0..16 and point one vec4f, then per slot the color
pub const SKEL_PERSONS: usize = 17 * NPOINTS;
pub const SKEL_FLOATS: usize = (SKEL_PERSONS + 17) * 4;
const DEPTH: [u32; 2] = [KW, KH];
const FLOW: [u32; 2] = [128, 106]; // optical flow, finest level; then 64x53 and 32x27
pub const GRID_ROWS: u32 = 64; // wall cells of the motion: 64 rows = about 3 cm per cell on a 2 m wall

const SIM_ENTRIES: [&str; 20] = [
    "camSignal", "down", "lkCoarse", "lkRefine", "lkFinal", "dyeStats", "bodyBlurX", "bodyBlurY", "wallMotion", "force", "dye", "curl", "vorticity", "divergence", "pressureFade", "jacobi",
    "gradient", "advectVel", "advect", "maccormackDye",
];
const KINECT_ENTRIES: [&str; 7] = ["prep", "bodyScatter", "bodyImage", "bodyClear", "nearest", "scene", "vcollect"];

/// bones of the arms (touching an elbow, wrist or hand), as a bit mask over BONES
fn arm_bones() -> u32 {
    let arm = |i: usize| POINTS.get(i).is_some_and(|n| ["Elbow", "Wrist", "Hand"].iter().any(|s| n.contains(s)));
    BONES.iter().enumerate().fold(0, |m, (i, &(a, b))| if arm(a) || arm(b) { m | (1 << i) } else { m })
}

/// WGSL in front of the scene's files (main.js HEAD + common.wgsl)
fn head() -> String {
    let fields: Vec<String> = FIELDS.iter().map(|f| format!("  {f}: f32,")).collect();
    let bones: Vec<String> = BONES.iter().map(|(a, b)| format!("vec2u({a}u, {b}u)")).collect();
    let n = BONES.len();
    let head = [
        format!("struct Uni {{\n{}\n}};", fields.join("\n")),
        format!("const POINT_COUNT = {}u;", POINTS.len()),
        format!("const BONE_COUNT = {n}u;"),
        format!("const ARM_BONES = {}u;", arm_bones()),
        format!("var<private> BONES: array<vec2u, {n}> = array<vec2u, {n}>({});", bones.join(", ")),
        // the wall setup and mapping (WALL, wallFromRoom(), wallVelocity(), ...), ctx.wall_buf
        wall_wgsl(0, WALL_BINDING),
        String::new(),
    ]
    .join("\n");
    format!("{head}{COMMON}")
}

/// A texture of the simulation (rgba16float, sampled and written as storage).
pub struct Tex {
    pub tex: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub w: u32,
    pub h: u32,
}

impl Tex {
    fn new(gpu: &Gpu, label: &str, w: u32, h: u32, copy: bool) -> Self {
        let mut usage = wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING;
        if copy {
            usage |= wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST;
        }
        let tex = gpu.texture(&format!("fluid-simulation {label}"), w, h, wgpu::TextureFormat::Rgba16Float, usage);
        let view = tex.create_view(&Default::default());
        Self { tex, view, w: w.max(1), h: h.max(1) }
    }

    /// Copies this texture into `to` (same size).
    pub fn copy_to(&self, enc: &mut wgpu::CommandEncoder, to: &Tex) {
        enc.copy_texture_to_texture(self.tex.as_image_copy(), to.tex.as_image_copy(), wgpu::Extent3d { width: self.w, height: self.h, depth_or_array_layers: 1 });
    }
}

/// One compute dispatch: pipeline, bind group, size in threads (workgroups of 8x8).
pub struct Step {
    pipe: wgpu::ComputePipeline,
    group: wgpu::BindGroup,
    size: [u32; 2],
}

impl Step {
    pub fn run(&self, pass: &mut wgpu::ComputePass) {
        pass.set_pipeline(&self.pipe);
        pass.set_bind_group(0, &self.group, &[]);
        pass.dispatch_workgroups(self.size[0].div_ceil(8), self.size[1].div_ceil(8), 1);
    }
}

/// Shaders, pipelines and what every bind group shares (made once in make()).
pub struct Pipes {
    compute: HashMap<&'static str, wgpu::ComputePipeline>,
    pub display: wgpu::RenderPipeline,
    sim_layout: wgpu::BindGroupLayout,
    kinect_layout: wgpu::BindGroupLayout,
    display_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    pub uniform: wgpu::Buffer,
    pub skel: wgpu::Buffer,
    wall: wgpu::Buffer,
    person_depth: wgpu::TextureView,
    person_label: wgpu::TextureView,
    lut: wgpu::TextureView,
    ir: wgpu::TextureView,
}

impl Pipes {
    pub fn new(gpu: &Gpu, kg: &KinectGpu, wall_buf: &wgpu::Buffer) -> GpuResult<Self> {
        let head = head();
        let sim_module = gpu.shader("fluid-simulation sim.wgsl + camera.wgsl", &format!("{head}\n{SIM}\n{CAMERA}"))?;
        let kinect_module = gpu.shader("fluid-simulation kinect.wgsl", &format!("{head}\n{KINECT}"))?;

        let c = wgpu::ShaderStages::COMPUTE;
        let f = wgpu::ShaderStages::FRAGMENT;
        let storage = |b: u32| layout::storage_tex(b, c, wgpu::TextureFormat::Rgba16Float);
        let sim_layout = gpu.bind_group_layout(
            "fluid-simulation sim",
            &[
                layout::uniform(0, c),
                layout::float_tex(1, c, true),
                layout::float_tex(2, c, true),
                layout::sampler(3, c, true),
                storage(4),
                layout::float_tex(5, c, true),
                layout::storage(10, c, true),
                layout::float_tex(11, c, true),
                layout::float_tex(12, c, true),
                layout::uniform(WALL_BINDING, c),
            ],
        );
        let kinect_layout = gpu.bind_group_layout(
            "fluid-simulation kinect",
            &[
                layout::uniform(0, c),
                layout::float_tex(1, c, false),
                layout::uint_tex(2, c),
                layout::float_tex(3, c, false),
                layout::float_tex(4, c, true),
                layout::storage(5, c, false),
                storage(6),
                layout::storage(7, c, false),
                storage(8),
                layout::float_tex(9, c, true),
                layout::storage(10, c, true),
                layout::float_tex(11, c, true),
                storage(12),
                layout::uniform(WALL_BINDING, c),
                layout::storage(14, c, false),
            ],
        );
        let display_layout = gpu.bind_group_layout(
            "fluid-simulation display",
            &[
                layout::uniform(0, f),
                layout::float_tex(1, f, true),
                layout::float_tex(2, f, true),
                layout::sampler(3, f, true),
                layout::float_tex(5, f, true),
                layout::storage(10, f, true),
                layout::float_tex(12, f, true),
                layout::uniform(WALL_BINDING, f),
            ],
        );

        let mut compute = HashMap::new();
        for (module, bgl, names) in [(&sim_module, &sim_layout, &SIM_ENTRIES[..]), (&kinect_module, &kinect_layout, &KINECT_ENTRIES[..])] {
            let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("fluid-simulation"), bind_group_layouts: &[Some(bgl)], immediate_size: 0 });
            for &name in names {
                let pipe = gpu.compute_pipeline(&format!("fluid-simulation {name}"), |d| {
                    d.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                        label: Some(name),
                        layout: Some(&pl),
                        module,
                        entry_point: Some(name),
                        compilation_options: Default::default(),
                        cache: None,
                    })
                })?;
                compute.insert(name, pipe);
            }
        }
        let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("fluid-simulation display"), bind_group_layouts: &[Some(&display_layout)], immediate_size: 0 });
        let display = gpu.render_pipeline("fluid-simulation display", |d| {
            d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("fluid-simulation display"),
                layout: Some(&pl),
                vertex: wgpu::VertexState { module: &sim_module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
                fragment: Some(wgpu::FragmentState {
                    module: &sim_module,
                    entry_point: Some("display"),
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

        Ok(Self {
            compute,
            display,
            sim_layout,
            kinect_layout,
            display_layout,
            sampler: gpu.linear_sampler(),
            uniform: gpu.uniform_buffer("fluid-simulation uniforms", (UNIFORM_FLOATS * 4) as u64),
            skel: gpu.storage_buffer("fluid-simulation skeletons", (SKEL_FLOATS * 4) as u64),
            wall: wall_buf.clone(),
            person_depth: kg.person_depth_texture(),
            person_label: kg.person_label_texture(),
            lut: kg.lut_texture(),
            ir: kg.ir_texture(),
        })
    }

    fn pipe(&self, name: &str) -> GpuResult<wgpu::ComputePipeline> {
        self.compute.get(name).cloned().ok_or_else(|| format!("fluid-simulation: keine Pipeline {name}"))
    }
}

/// The camera image of the people and its optical flow: fixed size, made once (camOwned in main.js).
pub struct Cam {
    prep: Tex,
    pub sig: Tex,
    pub sig_prev: Tex,
    sig1: Tex,
    sig2: Tex,
    flow2: Tex,
    flow1: Tex,
    pub flow: Tex,
    pub flow_prev: Tex,
}

impl Cam {
    pub fn new(gpu: &Gpu) -> Self {
        let half = |n: u32| n.div_ceil(2);
        let [fw, fh] = FLOW;
        Self {
            prep: Tex::new(gpu, "prep", DEPTH[0], DEPTH[1], false),
            sig: Tex::new(gpu, "signal", fw, fh, true),
            sig_prev: Tex::new(gpu, "signal before", fw, fh, true),
            sig1: Tex::new(gpu, "signal 1", half(fw), half(fh), false),
            sig2: Tex::new(gpu, "signal 2", half(half(fw)), half(half(fh)), false),
            flow2: Tex::new(gpu, "flow 2", half(half(fw)), half(half(fh)), false),
            flow1: Tex::new(gpu, "flow 1", half(fw), half(fh), false),
            flow: Tex::new(gpu, "flow", fw, fh, true),
            flow_prev: Tex::new(gpu, "flow before", fw, fh, true),
        }
    }
}

/// The sizes everything on the wall depends on (main.js ensure() key).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Size {
    pub led_w: u32,
    pub led_h: u32,
    pub grid_w: u32,
    pub sim_w: u32,
    pub sim_h: u32,
}

impl Size {
    /// LED pixels, the wall in m, simRes (rows of the simulation)
    pub fn new(led: [u32; 2], wall: [f32; 2], sim_res: f64) -> Self {
        let [led_w, led_h] = [led[0].max(1), led[1].max(1)];
        let grid_w = (f64::from(GRID_ROWS) * f64::from(wall[0]) / f64::from(wall[1])).round();
        let sim_h = if sim_res.is_finite() && sim_res > 0.0 { sim_res } else { 112.0 };
        let sim_w = (sim_h * f64::from(led_w) / f64::from(led_h)).round();
        // the clamps only guard broken setups (the browser would fail there)
        let fit = |v: f64| if v.is_finite() { v.clamp(8.0, 4096.0) as u32 } else { 8 };
        Self { led_w, led_h, grid_w: fit(grid_w), sim_w: fit(sim_w), sim_h: sim_h.clamp(8.0, 4096.0) as u32 }
    }
}

/// A storage buffer of `n` u32, every entry EMPTY (all bits set) or 0.
fn cell_buffer(gpu: &Gpu, label: &str, n: u64, empty: bool) -> wgpu::Buffer {
    let buf = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: n.max(4) * 4, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST, mapped_at_creation: true });
    if empty && let Ok(mut view) = buf.slice(..).get_mapped_range_mut() {
        view.slice(..).fill(0xff);
    }
    buf.unmap();
    buf
}

fn tv(view: &wgpu::TextureView) -> wgpu::BindingResource<'_> {
    wgpu::BindingResource::TextureView(view)
}

fn entry(binding: u32, resource: wgpu::BindingResource<'_>) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry { binding, resource }
}

/// Everything whose size depends on the wall setup or params: wall grid, simulation, the people's
/// image and the dye (one texel per LED), with the dispatches that use them.
pub struct WallRes {
    pub size: Size,
    pub stats: Tex,
    pub stats_prev: Tex,
    pub stats_step: Step,
    /// once per person tracking result: optical flow, the people on the wall, their motion
    pub fresh: Vec<Step>,
    /// forces, dye, vorticity confinement, divergence
    pub fluid: Vec<Step>,
    /// pressure: [read texture] each
    pub pressure_fade: [Step; 2],
    pub jacobi: [Step; 2],
    pub gradient: [Step; 2],
    /// advection; dye with MacCormack
    pub advect: Vec<Step>,
    pub display: wgpu::BindGroup,
    // kept alive with the bind groups (main.js `owned`)
    _keep: (Vec<Tex>, Vec<wgpu::Buffer>),
}

impl WallRes {
    pub fn new(gpu: &Gpu, p: &Pipes, cam: &Cam, size: Size) -> GpuResult<Self> {
        let Size { led_w, led_h, grid_w, sim_w, sim_h } = size;
        let t = |label: &str, w: u32, h: u32| Tex::new(gpu, label, w, h, false);
        let cells = cell_buffer(gpu, "fluid-simulation cells", u64::from(grid_w) * u64::from(GRID_ROWS), true);
        let vcells = cell_buffer(gpu, "fluid-simulation vcells", u64::from(grid_w) * u64::from(GRID_ROWS) * 8, false);
        let body_cells = cell_buffer(gpu, "fluid-simulation body cells", u64::from(led_w) * u64::from(led_h), true);
        let raw_motion = t("raw motion", grid_w, GRID_ROWS);
        let raw_arm = t("raw arm", grid_w, GRID_ROWS);
        let motion = t("motion", grid_w, GRID_ROWS);
        let vel = [t("velocity a", sim_w, sim_h), t("velocity b", sim_w, sim_h)];
        let pres = [t("pressure a", sim_w, sim_h), t("pressure b", sim_w, sim_h)];
        let curl = t("curl", sim_w, sim_h);
        let div = t("divergence", sim_w, sim_h);
        let dye = [t("dye a", led_w, led_h), t("dye b", led_w, led_h)];
        let dye_tmp = t("dye tmp", led_w, led_h);
        let body = t("body", led_w, led_h);
        let body_tmp = t("body tmp", led_w.div_ceil(2), led_h.div_ceil(2));
        let body_soft = t("body soft", led_w.div_ceil(2), led_h.div_ceil(2));
        let stats = Tex::new(gpu, "stats", 1, 1, true);
        let stats_prev = Tex::new(gpu, "stats before", 1, 1, true);

        // sim: a, b, c sampled, out storage; bodyTex (12) is the blurred people; statsTex (11) the fill
        let sim_group = |a: &Tex, b: &Tex, out: &Tex, c: &Tex, stats: &Tex, body: &Tex| {
            gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("fluid-simulation sim"),
                layout: &p.sim_layout,
                entries: &[
                    entry(0, p.uniform.as_entire_binding()),
                    entry(1, tv(&a.view)),
                    entry(2, tv(&b.view)),
                    entry(3, wgpu::BindingResource::Sampler(&p.sampler)),
                    entry(4, tv(&out.view)),
                    entry(5, tv(&c.view)),
                    entry(10, p.skel.as_entire_binding()),
                    entry(11, tv(&stats.view)),
                    entry(12, tv(&body.view)),
                    entry(WALL_BINDING, p.wall.as_entire_binding()),
                ],
            })
        };
        let sim = |name: &str, a: &Tex, b: &Tex, out: &Tex, c: &Tex| -> GpuResult<Step> { Ok(Step { pipe: p.pipe(name)?, group: sim_group(a, b, out, c, &stats, &body_soft), size: [out.w, out.h] }) };
        // kinect: out storage, everything else fixed
        let kinect_group = |out: &Tex| {
            gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("fluid-simulation kinect"),
                layout: &p.kinect_layout,
                entries: &[
                    entry(0, p.uniform.as_entire_binding()),
                    entry(1, tv(&p.person_depth)),
                    entry(2, tv(&p.person_label)),
                    entry(3, tv(&p.lut)),
                    entry(4, tv(&p.ir)),
                    entry(5, cells.as_entire_binding()),
                    entry(6, tv(&out.view)),
                    entry(7, vcells.as_entire_binding()),
                    entry(8, tv(&raw_motion.view)),
                    entry(9, tv(&cam.flow.view)),
                    entry(10, p.skel.as_entire_binding()),
                    entry(11, tv(&cam.sig.view)),
                    entry(12, tv(&raw_arm.view)),
                    entry(WALL_BINDING, p.wall.as_entire_binding()),
                    entry(14, body_cells.as_entire_binding()),
                ],
            })
        };
        let on_prep = kinect_group(&cam.prep);
        let on_body = kinect_group(&body);
        let kinect = |name: &str, group: &wgpu::BindGroup, size: [u32; 2]| -> GpuResult<Step> { Ok(Step { pipe: p.pipe(name)?, group: group.clone(), size }) };

        // how full the wall is (from the last frame's dye): the stats before -> the stats now
        let stats_step = Step { pipe: p.pipe("dyeStats")?, group: sim_group(&dye[0], &stats_prev, &stats, &dye[0], &stats_prev, &body_soft), size: [1, 1] };
        let c = cam;
        let fresh = vec![
            // optical flow of the people's camera image, coarse to fine
            kinect("prep", &on_prep, DEPTH)?,
            sim("camSignal", &c.prep, &c.sig_prev, &c.sig, &c.prep)?,
            sim("down", &c.sig, &c.sig, &c.sig1, &c.sig)?,
            sim("down", &c.sig1, &c.sig1, &c.sig2, &c.sig1)?,
            sim("lkCoarse", &c.sig2, &c.sig2, &c.flow2, &c.sig2)?,
            sim("lkRefine", &c.sig1, &c.flow2, &c.flow1, &c.sig1)?,
            sim("lkFinal", &c.sig, &c.flow1, &c.flow, &c.flow_prev)?,
            // the people's image on the wall, one texel per LED
            kinect("bodyScatter", &on_prep, DEPTH)?,
            kinect("bodyImage", &on_body, [body.w, body.h])?,
            kinect("bodyClear", &on_prep, [body.w, body.h])?,
            sim("bodyBlurX", &body, &body, &body_tmp, &body)?,
            // (bodyTex is the output here: any other texture on its binding, the shader does not read it)
            Step { pipe: p.pipe("bodyBlurY")?, group: sim_group(&body_tmp, &body_tmp, &body_soft, &body_tmp, &stats, &body_tmp), size: [body_soft.w, body_soft.h] },
            // 3D motion on the wall cells
            kinect("nearest", &on_prep, DEPTH)?,
            kinect("scene", &on_prep, FLOW)?,
            kinect("vcollect", &on_prep, [motion.w, motion.h])?,
            sim("wallMotion", &raw_motion, &raw_motion, &motion, &raw_arm)?,
        ];
        let [va, vb] = &vel;
        let [d0, d1] = &dye;
        let fluid = vec![
            // forces and dye from the motion
            sim("force", va, &motion, vb, va)?,
            sim("dye", d0, &motion, d1, d0)?,
            // vorticity confinement
            sim("curl", vb, vb, &curl, vb)?,
            sim("vorticity", vb, &curl, va, vb)?,
            // projection
            sim("divergence", va, va, &div, va)?,
        ];
        let [pa, pb] = &pres;
        let pressure_fade = [sim("pressureFade", pa, pa, pb, pa)?, sim("pressureFade", pb, pb, pa, pb)?];
        let jacobi = [sim("jacobi", pa, &div, pb, pa)?, sim("jacobi", pb, &div, pa, pb)?];
        let gradient = [sim("gradient", va, pa, vb, va)?, sim("gradient", va, pb, vb, va)?];
        // advection; dye with MacCormack: forward estimate into tmp, then the correction against the old dye
        let advect = vec![sim("advectVel", vb, vb, va, vb)?, sim("advect", va, d1, &dye_tmp, va)?, sim("maccormackDye", va, &dye_tmp, d0, d1)?];
        let display = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("fluid-simulation display"),
            layout: &p.display_layout,
            entries: &[
                entry(0, p.uniform.as_entire_binding()),
                entry(1, tv(&d0.view)),
                entry(2, tv(&motion.view)),
                entry(3, wgpu::BindingResource::Sampler(&p.sampler)),
                entry(5, tv(&d0.view)),
                entry(10, p.skel.as_entire_binding()),
                entry(12, tv(&body_soft.view)),
                entry(WALL_BINDING, p.wall.as_entire_binding()),
            ],
        });
        let [va, vb] = vel;
        let [pa, pb] = pres;
        let [d0, d1] = dye;
        let keep = vec![raw_motion, raw_arm, motion, va, vb, pa, pb, curl, div, d0, d1, dye_tmp, body, body_tmp, body_soft];
        Ok(Self { size, stats, stats_prev, stats_step, fresh, fluid, pressure_fade, jacobi, gradient, advect, display, _keep: (keep, vec![cells, vcells, body_cells]) })
    }
}
