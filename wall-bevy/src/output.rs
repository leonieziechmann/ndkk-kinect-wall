//! The output: plays the show on the LED image (port of web/lib/runtime.js in output mode and
//! web/lib/wall-output.js). Once per display frame, on the main thread, in this order:
//!
//!   bus and file changes -> Kinect data (persons played out) -> wall mapping -> scenes render
//!   into their own textures -> stage (crossfade) + test image -> color, blackout -> LED image
//!
//! Everything slow happens elsewhere: the network in threads, a scene's setup in a worker thread
//! (the running scene keeps playing; its pipelines are compiled once at the start, warm-up), JPEG
//! previews in a thread. A scene that fails is retried and skipped, never ending the show.

use std::collections::{HashMap, VecDeque};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;

use bevy::prelude::*;
use bevy::render::renderer::{RenderDevice, RenderQueue};
use crossbeam_channel::Receiver;
use serde_json::{Value, json};

use crate::audio::{Audio, SoundQueue};
use crate::bus::{Bus, BusIn};
use crate::canvas::Canvas;
use crate::compositor::{Fit, OutputImage};
use crate::config::Config;
use crate::docs::Docs;
use crate::gpu::{FULLSCREEN_WGSL, Gpu, TARGET_FORMAT, layout};
use crate::hub::mono_ms;
use crate::kinect::KinectData;
use crate::kinect_gpu::KinectGpu;
use crate::params::{Glide, Params, retune, step_glide};
use crate::persons::{PersonOptions, PersonsResult};
use crate::preview::{Purpose, Readback};
use crate::scene::{FrameCtx, Scene, SceneDef, SetupCtx};
use crate::show::{Entry, Show, Transition, crowd_wait, normalize_show, step_entry};
use crate::wall::{ProjectionDoc, Setup, WallMap, normalize_projection_doc, normalize_setup, resolve_projection};

const TELEMETRY_MS: f64 = 250.0;
const PREVIEW_MS: f64 = 200.0;
const PREVIEW_FOR_MS: f64 = 3000.0;
const RETRY_MS: f64 = 2000.0;
const FAILS_TO_SKIP: usize = 3;
const FAIL_WINDOW_MS: f64 = 30000.0;
const CROWD_SAMPLES: usize = 16;

pub struct OutputPlugin;

impl Plugin for OutputPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<SoundQueue>()
            .add_systems(Update, output_frame)
            .add_systems(PostUpdate, crate::audio::play_sounds);
    }
}

// ---------- easing ----------

/// CSS cubic-bezier(x1, y1, x2, y2) at t.
fn bezier(x1: f64, y1: f64, x2: f64, y2: f64, t: f64) -> f64 {
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }
    let bx = |s: f64| 3.0 * (1.0 - s) * (1.0 - s) * s * x1 + 3.0 * (1.0 - s) * s * s * x2 + s * s * s;
    let by = |s: f64| 3.0 * (1.0 - s) * (1.0 - s) * s * y1 + 3.0 * (1.0 - s) * s * s * y2 + s * s * s;
    let (mut lo, mut hi) = (0.0, 1.0);
    for _ in 0..30 {
        let mid = (lo + hi) / 2.0;
        if bx(mid) < t {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    by((lo + hi) / 2.0)
}

/// CSS ease-in-out (the crossfade)
fn ease_in_out(t: f64) -> f64 {
    bezier(0.42, 0.0, 0.58, 1.0, t)
}
/// CSS ease (the blackout)
fn ease(t: f64) -> f64 {
    bezier(0.25, 0.1, 0.25, 1.0, t)
}

/// A value animated like a CSS transition of opacity.
#[derive(Clone, Copy)]
struct Fade {
    from: f64,
    to: f64,
    start: f64,
    ms: f64,
    curve: fn(f64) -> f64,
}

impl Fade {
    fn at(&self, now: f64) -> f64 {
        if self.ms <= 0.0 {
            return self.to;
        }
        let t = ((now - self.start) / self.ms).clamp(0.0, 1.0);
        self.from + (self.to - self.from) * (self.curve)(t)
    }
    fn set(&mut self, to: f64, ms: f64, now: f64) {
        self.from = self.at(now);
        self.to = to;
        self.start = now;
        self.ms = ms;
    }
}

// ---------- scene instances ----------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Running,
    Error,
}

struct Instance {
    def: &'static SceneDef,
    scene: Box<dyn Scene>,
    params: Params,
    overrides: Value,
    wall: WallMap,
    wall_buf: wgpu::Buffer,
    /// the instance's picture (drawn through `view`)
    #[allow(dead_code)]
    target: wgpu::Texture,
    view: wgpu::TextureView,
    started: f64,
    frame: u64,
    last: f64,
    status: String,
    hold: Option<bool>,
    glide: Option<Glide>,
    state: State,
    /// opacity of this instance's layer (crossfade in)
    opacity: Fade,
    /// a frame was rendered (else the layer is not shown)
    shown: bool,
    /// the stage layer: opacity uniform and bind group (made once)
    layer: Option<(wgpu::Buffer, wgpu::BindGroup)>,
}

struct Leaving {
    inst: Instance,
    until: f64,
}

/// A scene being set up in a worker thread.
/// A warm-up setup: the scene, its params, the instance parts (or the error), the ms it took.
type WarmResult = (&'static SceneDef, Params, Result<(Box<dyn Scene>, WallMap, wgpu::Buffer, wgpu::Texture), String>, f64);

struct Pending {
    name: &'static str,
    rx: Receiver<Result<(Box<dyn Scene>, SetupBits), String>>,
    transition: Transition,
    fade: f64,
    overrides: Value,
}

struct SetupBits {
    params: Params,
    wall: WallMap,
    wall_buf: wgpu::Buffer,
    target: wgpu::Texture,
}

struct ErrorEntry {
    where_: String,
    message: String,
    count: u32,
    at: u64,
    scene: String,
}

/// The black layer's state (blackout, transitions over black).
enum BlackStep {
    None,
    /// going black for a switch; then plays the entry and comes back
    Out { entry: Entry, until: f64, fade: f64 },
    /// waiting for the scene's setup to come back from black
    Wait { fade: f64 },
}

// ---------- GPU of the output ----------

struct OutGpu {
    led_tex: wgpu::Texture,
    led_view: wgpu::TextureView,
    #[allow(dead_code)]
    stage: wgpu::Texture,
    stage_view: wgpu::TextureView,
    overlay: wgpu::Texture,
    layer_pipe: wgpu::RenderPipeline,
    overlay_pipe: wgpu::RenderPipeline,
    final_pipe: wgpu::RenderPipeline,
    layer_bgl: wgpu::BindGroupLayout,
    final_group: wgpu::BindGroup,
    overlay_group: wgpu::BindGroup,
    final_buf: wgpu::Buffer,
    led: [u32; 2],
}

const COMPOSE_WGSL: &str = r"
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> u: vec4f; // x: opacity
@fragment fn fs_layer(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return vec4f(textureLoad(src, vec2i(pos.xy), 0).rgb, u.x);
}
@fragment fn fs_overlay(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return textureLoad(src, vec2i(pos.xy), 0);
}
struct C { gain: vec4f, opts: vec4f }; // gain: brightness·r, ·g, ·b, gamma; opts: x black
@group(0) @binding(2) var<uniform> c: C;
@fragment fn fs_final(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var v = clamp(textureLoad(src, vec2i(pos.xy), 0).rgb, vec3f(0.0), vec3f(1.0));
  // SVG feFunc gamma in sRGB values: amplitude · v^exponent
  v = clamp(c.gain.rgb * pow(v, vec3f(c.gain.w)), vec3f(0.0), vec3f(1.0));
  v = v * (1.0 - c.opts.x);
  return vec4f(v, 1.0);
}
";

impl OutGpu {
    fn new(gpu: &Gpu, led: [u32; 2]) -> Result<Self, String> {
        let m = gpu.shader("output compose", &format!("{FULLSCREEN_WGSL}\n{COMPOSE_WGSL}"))?;
        let f = wgpu::ShaderStages::FRAGMENT;
        let layer_bgl = gpu.bind_group_layout("output layer", &[layout::float_tex(0, f, false), layout::uniform(1, f)]);
        let final_bgl = gpu.bind_group_layout("output final", &[layout::float_tex(0, f, false), layout::uniform(2, f)]);
        let over_bgl = gpu.bind_group_layout("output overlay", &[layout::float_tex(0, f, false)]);
        let mk = |key: &str, bgl: &wgpu::BindGroupLayout, entry: &str, format: wgpu::TextureFormat, blend: Option<wgpu::BlendState>| {
            let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some(key), bind_group_layouts: &[Some(bgl)], immediate_size: 0 });
            gpu.render_pipeline(key, |d| {
                d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some(key),
                    layout: Some(&pl),
                    vertex: wgpu::VertexState { module: &m, entry_point: Some("vs_fullscreen"), compilation_options: Default::default(), buffers: &[] },
                    fragment: Some(wgpu::FragmentState {
                        module: &m,
                        entry_point: Some(entry),
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
        let stage_format = wgpu::TextureFormat::Rgba16Float;
        let layer_pipe = mk("output layer", &layer_bgl, "fs_layer", stage_format, Some(wgpu::BlendState::ALPHA_BLENDING))?;
        let overlay_pipe = mk("output overlay", &over_bgl, "fs_overlay", stage_format, Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING))?;
        let final_pipe = mk("output final", &final_bgl, "fs_final", TARGET_FORMAT, None)?;
        let (w, h) = (led[0], led[1]);
        let led_tex = gpu.target("led image", w, h, TARGET_FORMAT);
        let led_view = led_tex.create_view(&Default::default());
        let stage = gpu.target("stage", w, h, stage_format);
        let stage_view = stage.create_view(&Default::default());
        let overlay = gpu.texture("overlay", w, h, wgpu::TextureFormat::Rgba8Unorm, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST);
        let overlay_view = overlay.create_view(&Default::default());
        let final_buf = gpu.uniform_buffer("output color", 32);
        let final_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("output final"),
            layout: &final_bgl,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&stage_view) }, wgpu::BindGroupEntry { binding: 2, resource: final_buf.as_entire_binding() }],
        });
        let overlay_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("output overlay"),
            layout: &over_bgl,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&overlay_view) }],
        });
        Ok(Self { led_tex, led_view, stage, stage_view, overlay, layer_pipe, overlay_pipe, final_pipe, layer_bgl, final_group, overlay_group, final_buf, led })
    }
}

// ---------- the output's state ----------

/// The output (a non-send resource: it runs on the main thread, scenes need not be Sync).
pub struct OutputState {
    cfg: Config,
    gpu: Option<Gpu>,
    out: Option<OutGpu>,
    kinect: KinectData,
    kgpu: Option<Arc<KinectGpu>>,
    /// the page's wall: setup, block zones, the default projection
    page_wall: WallMap,
    setup: Setup,
    setup_gen: u64,
    projection_raw: Value,
    projections: ProjectionDoc,
    live_at: [f64; 3],
    registry: Vec<&'static SceneDef>,
    current: Option<Instance>,
    leaving: Vec<Leaving>,
    pending: Option<Pending>,
    show: Show,
    entry: Option<Entry>,
    entry_removed: bool,
    started_at: f64,
    blackout: bool,
    black: Fade,
    black_step: BlackStep,
    pattern: Option<String>,
    over: bool,
    wizard: Option<Value>,
    wizard_at: f64,
    canvas: Canvas,
    waiting: Option<&'static str>,
    wait_left: f64,
    wait_limit: f64,
    seen: VecDeque<usize>,
    crowd: usize,
    preview_until: f64,
    last_preview: f64,
    error_at: f64,
    fails: Vec<f64>,
    queued: Option<(Entry, Transition)>,
    errors: Vec<ErrorEntry>,
    title: String,
    bus: Option<Bus>,
    docs: Docs,
    readback: Readback,
    audio: Audio,
    // timing
    last_frame: f64,
    last_scene_frame: f64,
    frame_no: u64,
    /// shifts the render cap's cadence (a new scene's first frame sets its phase)
    cap_phase: u64,
    intervals: VecDeque<f64>,
    fps: f64,
    fps_count: u32,
    fps_since: f64,
    late: u64,
    last_telemetry: f64,
    last_tick: f64,
    shots_next: f64,
    shot_no: u32,
    frame_log: Vec<f64>,
    /// test mode: frames over 50 ms (s since the start, ms, what played)
    slow_log: Vec<(f64, f64, String)>,
    /// test mode: the output's own CPU time per frame, without the GPU driver's submits
    /// (everything but waiting for the display; a CPU renderer such as lavapipe draws in them)
    cpu_log: Vec<f64>,
    /// test mode: the time in the GPU driver's submits per frame
    submit_log: Vec<f64>,
    /// test mode: the CPU times by the scene that played (the incoming one during a fade)
    cpu_by_scene: HashMap<&'static str, Vec<f64>>,
    /// this frame's time in the submits so far
    submit_ms: f64,
    /// test mode: frames whose CPU time was over 8 ms (s since the start, ms, what played)
    slow_cpu: Vec<(f64, f64, String)>,
    /// test mode: every frame, for frames.csv
    frame_rows: Vec<FrameRow>,
    started: f64,
    warm: Option<Vec<Instance>>,
    /// warm-up setups still running (collected without waiting: the window keeps answering)
    warm_jobs: Vec<std::thread::JoinHandle<WarmResult>>,
    warm_since: f64,
    warm_frames: u32,
    warmed: bool,
    windowed: bool,
    /// the output's screen and window as the browser reports them (telemetry `screen`)
    screen: Value,
    problem: String,
    problem_key: String,
    problem_since: f64,
    problem_logged: bool,
    retry_entry: Option<(Entry, f64)>,
}

impl OutputState {
    pub fn setup_window(&self) -> Option<[i32; 2]> {
        self.setup.output_window.as_ref().map(|w| [w.left, w.top])
    }
    pub fn setup_generation(&self) -> u64 {
        self.setup_gen
    }
}

fn new_state(cfg: Config) -> OutputState {
    crate::canvas::preload_fonts();
    let docs = Docs::start(["setup", "projection", "show"].iter().map(|k| (k.to_string(), cfg.doc_file(k))).collect());
    let bus = if cfg.no_bus || cfg.shots.is_some() {
        None
    } else {
        let c = cfg.clone();
        Some(Bus::start(move || c.dev_server()))
    };
    let mut setup = normalize_setup(&Value::Null);
    if let Some((w, h)) = cfg.led {
        setup.led_w = w;
        setup.led_h = h;
    }
    let now = mono_ms();
    OutputState {
        kinect: KinectData::new(cfg.hub_ws()),
        page_wall: WallMap::new(setup.clone(), None),
        setup,
        setup_gen: 0,
        projection_raw: Value::Null,
        projections: ProjectionDoc::default(),
        live_at: [-1e9; 3],
        registry: crate::scenes::registry(),
        current: None,
        leaving: Vec::new(),
        pending: None,
        show: normalize_show(&Value::Null),
        entry: None,
        entry_removed: false,
        started_at: now,
        blackout: false,
        black: Fade { from: 1.0, to: 1.0, start: now, ms: 0.0, curve: ease },
        black_step: BlackStep::None,
        pattern: None,
        over: false,
        wizard: None,
        wizard_at: 0.0,
        canvas: Canvas::new(1, 1),
        waiting: None,
        wait_left: 0.0,
        wait_limit: 0.0,
        seen: VecDeque::new(),
        crowd: 0,
        preview_until: 0.0,
        last_preview: 0.0,
        error_at: 0.0,
        fails: Vec::new(),
        queued: None,
        errors: Vec::new(),
        title: String::new(),
        bus,
        docs,
        readback: Readback::new(),
        audio: Audio::new(cfg.mute),
        last_frame: now,
        last_scene_frame: 0.0,
        frame_no: 0,
        cap_phase: 0,
        intervals: VecDeque::new(),
        fps: 0.0,
        fps_count: 0,
        fps_since: now,
        late: 0,
        last_telemetry: 0.0,
        last_tick: 0.0,
        shots_next: 0.0,
        shot_no: 0,
        frame_log: Vec::new(),
        slow_log: Vec::new(),
        cpu_log: Vec::new(),
        submit_log: Vec::new(),
        cpu_by_scene: HashMap::new(),
        submit_ms: 0.0,
        slow_cpu: Vec::new(),
        frame_rows: Vec::new(),
        started: now,
        warm: None,
        warm_jobs: Vec::new(),
        warm_since: 0.0,
        warm_frames: 0,
        warmed: false,
        windowed: cfg.windowed,
        screen: json!({ "w": 0, "h": 0, "left": Value::Null, "top": Value::Null, "dpr": 1, "inner": [0, 0], "fullscreen": false }),
        problem: String::new(),
        problem_key: String::new(),
        problem_since: 0.0,
        problem_logged: false,
        retry_entry: None,
        gpu: None,
        out: None,
        kgpu: None,
        cfg,
    }
}

fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl OutputState {
    fn push_error(&mut self, where_: &str, message: &str) {
        let scene = self.current.as_ref().map(|i| i.def.name.to_string()).unwrap_or_default();
        if let Some(e) = self.errors.iter_mut().find(|e| e.where_ == where_ && e.message == message) {
            e.count += 1;
            e.at = now_epoch_ms();
            return;
        }
        warn!("[{scene}] {where_}: {message}");
        self.errors.push(ErrorEntry { where_: where_.into(), message: message.into(), count: 1, at: now_epoch_ms(), scene });
        if self.errors.len() > 20 {
            self.errors.remove(0);
        }
    }

    fn find(&self, name: &str) -> Option<&'static SceneDef> {
        self.registry.iter().copied().find(|d| d.name == name)
    }

    fn led(&self) -> [u32; 2] {
        [self.setup.led_w, self.setup.led_h]
    }

    /// The projection of a scene: the default, its wishes, the control center's values.
    fn projection_of(&self, def: &SceneDef) -> crate::wall::Profile {
        resolve_projection(&self.projections, &self.setup, self.page_wall.tan_h, def.name, &(def.projection)())
    }

    /// Setup or projections changed: every wall map takes them.
    fn apply_wall(&mut self) {
        self.projections = normalize_projection_doc(&self.projection_raw);
        let default = self.projections.default.clone().unwrap_or_else(|| crate::wall::projection_from_setup(&self.setup, self.page_wall.tan_h));
        self.page_wall.set_setup(self.setup.clone());
        self.page_wall.set_projection(default.clone());
        let mut list: Vec<&mut Instance> = Vec::new();
        if let Some(c) = self.current.as_mut() {
            list.push(c);
        }
        for l in &mut self.leaving {
            list.push(&mut l.inst);
        }
        let projections = &self.projections;
        let setup = &self.setup;
        let tan_h = self.page_wall.tan_h;
        for inst in list {
            inst.wall.set_setup(setup.clone());
            inst.wall.set_projection(resolve_projection(projections, setup, tan_h, inst.def.name, &(inst.def.projection)()));
        }
        // the output's camera view mirrors like the default projection
        self.kinect.x_sign = if default.mirror { 1.0 } else { -1.0 };
        self.setup_gen += 1;
    }

    // ----- scenes -----

    /// Starts a scene: its setup runs in a worker thread, the running one keeps playing.
    fn launch(&mut self, def: &'static SceneDef, overrides: Value, transition: Transition, fade: f64) {
        let (Some(gpu), Some(kgpu)) = (self.gpu.clone(), self.kgpu.clone()) else {
            return;
        };
        let specs = Arc::new((def.params)());
        let params = Params::resolve(specs, &overrides);
        let mut wall = WallMap::new(self.setup.clone(), Some(self.projection_of(def)));
        wall.active = true;
        wall.output = true;
        if let Some(l) = self.kinect.lut.clone() {
            wall.set_rays(&l);
        }
        wall.update(&self.kinect.view, self.kinect.x_sign, mono_ms());
        let led = self.led();
        let (tx, rx) = crossbeam_channel::bounded(1);
        let name = def.name;
        std::thread::Builder::new()
            .name(format!("setup {name}"))
            .spawn(move || {
                let result = catch_unwind(AssertUnwindSafe(|| {
                    let wall_buf = gpu.uniform_buffer(&format!("{name} wall"), (crate::wall::WALL_UNIFORM_FLOATS * 4) as u64);
                    let target = gpu.target(&format!("{name} output"), led[0], led[1], TARGET_FORMAT);
                    let mut w = wall.clone();
                    gpu.queue.write_buffer(&wall_buf, 0, w.uniform_bytes());
                    let ctx = SetupCtx { gpu: gpu.clone(), kgpu, wall, wall_buf: wall_buf.clone(), params: params.clone(), width: led[0], height: led[1], name };
                    let (made, err) = gpu.scoped(|| (def.make)(&ctx));
                    match (made, err) {
                        (Ok(scene), None) => Ok((scene, SetupBits { params, wall: ctx.wall, wall_buf, target })),
                        (Ok(_), Some(e)) => Err(e),
                        (Err(e), _) => Err(e),
                    }
                }));
                let _ = tx.send(result.unwrap_or_else(|p| Err(panic_text(&p))));
            })
            .ok();
        if let Some(old) = self.pending.take() {
            debug!("setup von {} abgelöst", old.name);
        }
        self.pending = Some(Pending { name, rx, transition, fade, overrides });
    }

    /// A scene's setup came back: it takes over (crossfade, cut).
    fn adopt(&mut self, p: Pending, scene: Box<dyn Scene>, bits: SetupBits, now: f64) {
        let view = bits.target.create_view(&Default::default());
        let Some(def) = self.find(p.name) else { return };
        let mut inst = Instance {
            def,
            scene,
            params: bits.params,
            overrides: p.overrides,
            wall: bits.wall,
            wall_buf: bits.wall_buf,
            target: bits.target,
            view,
            started: now,
            frame: 0,
            last: now,
            status: String::new(),
            hold: None,
            glide: None,
            state: State::Running,
            opacity: Fade { from: 1.0, to: 1.0, start: now, ms: 0.0, curve: ease_in_out },
            shown: false,
            layer: None,
        };
        // a crossfade keeps the old one until the fade is over; a cut simply drops it (its GPU
        // resources go with it)
        if let Some(old) = self.current.take()
            && p.transition == Transition::Cross
            && p.fade > 0.0
        {
            inst.opacity = Fade { from: 0.0, to: 1.0, start: now, ms: p.fade * 1000.0, curve: ease_in_out };
            self.leaving.push(Leaving { inst: old, until: now + p.fade * 1000.0 + 100.0 });
        }
        self.title = def.title.to_string();
        self.current = Some(inst);
        self.update_streams();
        if let BlackStep::Wait { fade } = self.black_step {
            if !self.blackout {
                self.black.set(0.0, fade / 2.0 * 1000.0, now);
            }
            self.black_step = BlackStep::None;
        }
        self.telemetry(now);
    }

    /// What every live instance needs (during a crossfade both scenes render).
    fn update_streams(&mut self) {
        let mut streams: Vec<String> = Vec::new();
        let mut opts: Option<PersonOptions> = None;
        let mut live: Vec<&Instance> = Vec::new();
        if let Some(c) = &self.current {
            live.push(c);
        }
        for l in &self.leaving {
            live.push(&l.inst);
        }
        for inst in live {
            for s in (inst.def.streams)(&inst.params) {
                streams.push(s.to_string());
            }
            if let Some(o) = (inst.def.persons)(&inst.params) {
                streams.push("persons".into());
                // the newest scene that tracks persons decides how
                if opts.is_none() {
                    opts = Some(o);
                }
            }
        }
        streams.sort();
        streams.dedup();
        self.kinect.set_streams(&streams, opts);
    }

    /// Plays a show entry (wall-output.js playEntry).
    fn play_entry(&mut self, entry: Option<Entry>, how: Transition, now: f64) {
        if self.pending.is_some() || matches!(self.black_step, BlackStep::Out { .. }) {
            if let Some(e) = entry {
                self.queued = Some((e, how));
            }
            return;
        }
        // a scene this output does not have: the show goes on as if the entry were switched off
        if let Some(e) = &entry
            && self.find(&e.scene).is_none()
        {
            self.push_error(&format!("Szene {}", e.scene), "gibt es in der Bevy-Ausgabe (noch) nicht");
            if e.id != "adhoc" {
                let mut id = e.id.clone();
                for _ in 0..self.show.entries.len() {
                    let Some(n) = step_entry(&self.show, Some(&id), 1).cloned() else { break };
                    if n.id == e.id {
                        break;
                    }
                    if self.find(&n.scene).is_some() {
                        self.play_entry(Some(n), how, now);
                        return;
                    }
                    id = n.id;
                }
            }
            return;
        }
        self.entry = entry.clone();
        self.entry_removed = false;
        self.started_at = now;
        self.waiting = None;
        self.fails.clear();
        let Some(entry) = entry else {
            self.current = None;
            self.leaving.clear();
            self.title.clear();
            return;
        };
        remember_current(&self.cfg, &entry.id);
        // the same scene again: no second instance, the running one takes the new values
        if let Some(c) = self.current.as_mut()
            && c.def.name == entry.scene
            && c.state == State::Running
        {
            let fade = if how == Transition::Cross { self.show.fade } else { 0.0 };
            let (changed, glide) = retune(&mut c.params, &entry.params, fade, now);
            c.overrides = entry.params.clone();
            for k in changed {
                c.scene.on_param(&k, &c.params);
            }
            c.glide = glide;
            self.update_streams();
            return;
        }
        let Some(def) = self.find(&entry.scene) else {
            return;
        };
        if how == Transition::Black && self.current.is_some() {
            let fade = self.show.fade;
            self.black.set(1.0, fade / 2.0 * 1000.0, now);
            self.black_step = BlackStep::Out { entry, until: now + fade / 2.0 * 1000.0 + 30.0, fade };
            return;
        }
        let how = if self.current.is_some() { how } else { Transition::Cut };
        self.launch(def, entry.params.clone(), how, self.show.fade);
    }

    fn step(&mut self, dir: i32, now: f64) {
        let next = step_entry(&self.show, self.entry.as_ref().map(|e| e.id.as_str()), dir).cloned();
        if let Some(n) = next {
            self.play_entry(Some(n), self.show.transition, now);
        }
    }

    /// The show changed: new params of the running entry apply at once.
    fn set_show(&mut self, raw: &Value, now: f64) {
        self.show = normalize_show(raw);
        let Some(cur) = self.entry.clone() else { return };
        let Some(e) = self.show.entries.iter().find(|e| e.id == cur.id).cloned() else {
            if cur.id != "adhoc" {
                self.entry_removed = true;
            }
            return;
        };
        let scene_changed = e.scene != cur.scene;
        self.entry = Some(e.clone());
        if scene_changed {
            self.play_entry(Some(e), Transition::Cut, now);
            return;
        }
        if let Some(c) = self.current.as_mut()
            && c.def.name == e.scene
            && c.overrides != e.params
        {
            let (changed, glide) = retune(&mut c.params, &e.params, 0.0, now);
            c.overrides = e.params.clone();
            c.glide = glide;
            for k in changed {
                c.scene.on_param(&k, &c.params);
            }
            self.update_streams();
        }
    }
}

fn remember_file(cfg: &Config) -> std::path::PathBuf {
    cfg.web_dir.join(".cache").join("wall").join("bevy-current.txt")
}

fn remember_current(cfg: &Config, id: &str) {
    if cfg.shots.is_some() {
        return;
    }
    let _ = std::fs::write(remember_file(cfg), id);
}

fn panic_text(p: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = p.downcast_ref::<&str>() {
        format!("Absturz: {s}")
    } else if let Some(s) = p.downcast_ref::<String>() {
        format!("Absturz: {s}")
    } else {
        "Absturz".into()
    }
}

// ---------- the frame ----------

#[allow(clippy::too_many_arguments)]
pub fn init_output(world: &mut World) {
    let cfg = world.resource::<Config>().clone();
    // the scenes' localStorage (tests keep theirs in memory)
    crate::store::init(cfg.shots.is_none().then(|| cfg.web_dir.join(".cache").join("wall").join("bevy-store.json")));
    world.insert_non_send(new_state(cfg));
}

fn output_frame(
    state: Option<NonSendMut<OutputState>>,
    device: Option<Res<RenderDevice>>,
    queue: Option<Res<RenderQueue>>,
    mut image: ResMut<OutputImage>,
    mut sounds: ResMut<SoundQueue>,
    windows: Query<&Window, With<bevy::window::PrimaryWindow>>,
    monitors: Query<(Entity, &bevy::window::Monitor)>,
    mut exit: MessageWriter<AppExit>,
) {
    let Some(mut st) = state else {
        return;
    };
    let st: &mut OutputState = &mut st;
    let now = mono_ms();
    st.submit_ms = 0.0;
    // the GPU (again after a device loss)
    if let (Some(device), Some(queue)) = (device.as_ref(), queue.as_ref())
        && (st.gpu.is_none() || device.is_changed())
    {
        let gpu = Gpu::new(device.wgpu_device().clone(), (***queue).clone());
        info!("GPU: {:?}", gpu.device.features().contains(wgpu::Features::FLOAT32_FILTERABLE));
        st.kgpu = Some(Arc::new(KinectGpu::new(&gpu)));
        st.out = None;
        st.current = None;
        st.leaving.clear();
        st.pending = None;
        st.gpu = Some(gpu);
        st.warmed = st.warmed && st.cfg.shots.is_none();
        if st.warmed {
            // after a device loss: the entry again
            let e = st.entry.clone();
            st.play_entry(e, Transition::Cut, now);
        }
    }
    let Some(gpu) = st.gpu.clone() else { return };
    let Some(kgpu) = st.kgpu.clone() else { return };
    if let Ok(w) = windows.single() {
        st.windowed = w.mode == bevy::window::WindowMode::Windowed;
        if st.frame_no.is_multiple_of(30) {
            st.screen = screen_info(w, &monitors);
        }
    }

    // ----- timing -----
    let dt_ms = now - st.last_frame;
    st.last_frame = now;
    st.frame_no += 1;
    if st.frame_no > 2 {
        st.intervals.push_back(dt_ms);
        if st.intervals.len() > 120 {
            st.intervals.pop_front();
        }
        st.frame_log.push(dt_ms);
        if st.cfg.shots.is_some() && st.warmed && dt_ms > 50.0 && st.slow_log.len() < 5000 {
            let what = st.playing(false);
            st.slow_log.push(((now - st.started) / 1000.0, dt_ms, what));
        }
    }
    let refresh = refresh_interval(&st.intervals);
    if st.frame_no > 30 && dt_ms > refresh * 1.5 {
        st.late += 1;
    }

    // ----- documents and commands -----
    st.take_docs(now);
    st.take_bus(now, &mut exit);

    // ----- the hub's messages (every display frame) -----
    {
        let wall = &mut st.page_wall;
        st.kinect.drain(&mut |r: Arc<PersonsResult>, exact: bool| wall.filter_persons(r, exact));
    }

    // ----- warm-up: every scene once, so no switch ever compiles a shader -----
    if !st.warmed {
        st.warm_up(&gpu, &kgpu, now);
        st.present(&gpu, &mut image, now);
        return;
    }

    // ----- a scene being set up, going black for a switch -----
    if let Some(p) = &st.pending
        && let Ok(r) = p.rx.try_recv()
    {
        let p = st.pending.take();
        if let Some(p) = p {
            match r {
                Ok((scene, bits)) => st.adopt(p, scene, bits, now),
                Err(e) => {
                    st.push_error("setup()", &e);
                    // the next entry, or again later (the previous scene keeps running)
                    let failed = st.entry.clone();
                    if let Some(f) = failed {
                        st.retry_after_setup_error(f, now);
                    }
                }
            }
            if let Some((e, how)) = st.queued.take() {
                st.play_entry(Some(e), how, now);
            }
        }
    }
    if let BlackStep::Out { entry, until, fade } = &st.black_step
        && now >= *until
    {
        let (entry, fade): (Entry, f64) = (entry.clone(), *fade);
        st.black_step = BlackStep::Wait { fade };
        if let Some(def) = st.find(&entry.scene) {
            st.launch(def, entry.params.clone(), Transition::Cut, fade);
        } else {
            st.black_step = BlackStep::None;
        }
    }

    // ----- the render cap (maxFps, --fps): every n-th display frame, steady -----
    let cap = st.cfg.fps.max(0.0);
    let scene_cap = st.current.as_ref().map(|c| (c.def.max_fps)(&c.params)).unwrap_or(0.0);
    let cap = if cap > 0.0 && scene_cap > 0.0 { cap.min(scene_cap) } else { cap.max(scene_cap) };
    let every = if cap > 0.0 { ((1000.0 / cap) / refresh).round().max(1.0) as u64 } else { 1 };
    // a scene that has not rendered yet renders now (a cut would show a black frame otherwise),
    // and the cadence of the cap continues from there, steady
    let first = st.current.as_ref().is_some_and(|c| !c.shown) || st.leaving.iter().any(|l| !l.inst.shown);
    if first && every > 1 {
        st.cap_phase = (every - st.frame_no % every) % every;
    }
    let render_scenes = every <= 1 || first || (st.frame_no + st.cap_phase).is_multiple_of(every);

    if render_scenes {
        st.render_scenes(&gpu, &kgpu, now, &mut sounds);
    }
    st.present(&gpu, &mut image, now);

    // ----- once in a while -----
    if now - st.fps_since >= 1000.0 {
        st.fps = f64::from(st.fps_count) * 1000.0 / (now - st.fps_since);
        st.fps_count = 0;
        st.fps_since = now;
    }
    if now - st.last_tick >= 500.0 {
        st.last_tick = now;
        st.auto_advance(now);
    }
    if now - st.last_telemetry >= TELEMETRY_MS {
        st.telemetry(now);
    }
    let name = st.current.as_ref().map(|c| c.def.name).unwrap_or("");
    let target = if cap > 0.0 { cap.min(1000.0 / refresh) } else { 1000.0 / refresh };
    let fps = st.fps;
    st.kinect.report_render(fps, target.round(), name);
    if st.cfg.shots.is_some() {
        let cpu_ms = mono_ms() - now - st.submit_ms;
        let submit_ms = st.submit_ms;
        st.submit_log.push(submit_ms);
        st.cpu_log.push(cpu_ms);
        let scene = st.current.as_ref().map_or("-", |c| c.def.name);
        st.cpu_by_scene.entry(scene).or_default().push(cpu_ms);
        if cpu_ms > 8.0 && st.slow_cpu.len() < 5000 {
            let what = st.playing(first);
            st.slow_cpu.push(((now - st.started) / 1000.0, cpu_ms, what));
        }
        let row = FrameRow { t: now - st.started, dt: dt_ms, cpu: cpu_ms, submit: submit_ms, scene, rendered: render_scenes, fade: !st.leaving.is_empty(), setup: st.pending.is_some(), first };
        st.frame_rows.push(row);
    }
    st.shots(now, &mut exit);
}

/// Test mode: one frame of frames.csv.
struct FrameRow {
    /// ms since the start (after the warm-up)
    t: f64,
    /// ms since the previous frame
    dt: f64,
    /// the output's own CPU time and the time in the GPU driver's submits (ms)
    cpu: f64,
    submit: f64,
    scene: &'static str,
    /// the scenes rendered in this frame (not skipped by a frame rate cap)
    rendered: bool,
    fade: bool,
    setup: bool,
    first: bool,
}

/// The screen the window is on and the window, as the browser's telemetry has them (CSS pixels:
/// physical / scale factor).
fn screen_info(w: &Window, monitors: &Query<(Entity, &bevy::window::Monitor)>) -> Value {
    use bevy::window::{MonitorSelection, WindowMode, WindowPosition};
    let on = match w.mode {
        WindowMode::BorderlessFullscreen(MonitorSelection::Entity(e)) | WindowMode::Fullscreen(MonitorSelection::Entity(e), _) => monitors.get(e).ok().map(|m| m.1),
        _ => None,
    }
    .or_else(|| {
        let WindowPosition::At(p) = w.position else { return None };
        monitors
            .iter()
            .map(|m| m.1)
            .find(|m| {
                let q = m.physical_position;
                p.x >= q.x && p.y >= q.y && p.x < q.x + m.physical_width as i32 && p.y < q.y + m.physical_height as i32
            })
    })
    .or_else(|| monitors.iter().next().map(|m| m.1));
    let dpr = f64::from(w.resolution.scale_factor());
    let inner = [w.resolution.width().round(), w.resolution.height().round()];
    let fullscreen = w.mode != WindowMode::Windowed;
    match on {
        Some(m) => {
            let s = m.scale_factor.max(0.1);
            json!({
                "w": (f64::from(m.physical_width) / s).round(), "h": (f64::from(m.physical_height) / s).round(),
                "left": (f64::from(m.physical_position.x) / s).round(), "top": (f64::from(m.physical_position.y) / s).round(),
                "dpr": dpr, "inner": inner, "fullscreen": fullscreen, "name": m.name,
            })
        }
        None => json!({ "w": inner[0], "h": inner[1], "left": Value::Null, "top": Value::Null, "dpr": dpr, "inner": inner, "fullscreen": fullscreen }),
    }
}

/// The display interval (ms): a low percentile of the recent frame intervals, snapped to a usual rate.
fn refresh_interval(intervals: &VecDeque<f64>) -> f64 {
    if intervals.len() < 20 {
        return 1000.0 / 60.0;
    }
    let mut v: Vec<f64> = intervals.iter().copied().collect();
    v.sort_by(f64::total_cmp);
    let hz = 1000.0 / v[v.len() / 10].max(1.0);
    let rates = [30.0, 50.0, 60.0, 72.0, 75.0, 90.0, 100.0, 120.0, 144.0, 165.0, 240.0];
    let best = rates.iter().copied().fold(60.0, |b: f64, r: f64| if (r - hz).abs() / r < (b - hz).abs() / b { r } else { b });
    1000.0 / best
}

impl OutputState {
    fn take_docs(&mut self, now: f64) {
        while let Ok((kind, doc)) = self.docs.changed.try_recv() {
            match kind.as_str() {
                // the control center sends every change at once; the file follows a moment later
                // (an older save must not undo a newer live change)
                "setup" if now - self.live_at[0] > 3000.0 => {
                    let mut s = normalize_setup(&doc);
                    if let Some((w, h)) = self.cfg.led {
                        s.led_w = w;
                        s.led_h = h;
                    }
                    self.setup = s;
                    self.apply_wall();
                }
                "projection" if now - self.live_at[1] > 3000.0 => {
                    self.projection_raw = doc;
                    self.apply_wall();
                }
                "show" if now - self.live_at[2] > 3000.0 => {
                    let first = self.entry.is_none() && self.current.is_none();
                    self.set_show(&doc, now);
                    if first && self.warmed {
                        self.start_show(now);
                    }
                }
                _ => {}
            }
        }
    }

    fn take_bus(&mut self, now: f64, exit: &mut MessageWriter<AppExit>) {
        let Some(bus) = &self.bus else { return };
        let mut msgs = Vec::new();
        while let Ok(m) = bus.incoming.try_recv() {
            msgs.push(m);
        }
        for m in msgs {
            match m {
                BusIn::Connected(url) => {
                    info!("Steuerzentrale: verbunden mit {url}");
                    if let Some(b) = self.bus.as_mut() {
                        b.connected = true;
                    }
                    self.telemetry(now);
                }
                BusIn::Disconnected => {
                    if let Some(b) = self.bus.as_mut() {
                        b.connected = false;
                    }
                }
                BusIn::File(kind) => {
                    let i = ["setup", "projection", "show"].iter().position(|k| *k == kind);
                    if let Some(i) = i
                        && now - self.live_at[i] > 3000.0
                    {
                        self.docs.reload(&kind);
                    }
                }
                BusIn::Msg(msg) => self.command(&msg.kind, &msg.data, now, exit),
            }
        }
    }

    fn command(&mut self, kind: &str, d: &Value, now: f64, exit: &mut MessageWriter<AppExit>) {
        match kind {
            "play" => {
                let entry = match d.get("scene").and_then(Value::as_str) {
                    Some(s) => Some(Entry::adhoc(s)),
                    None => d.get("entry").and_then(Value::as_str).and_then(|id| self.show.entries.iter().find(|e| e.id == id).cloned()),
                };
                let how = d.get("transition").and_then(Value::as_str).and_then(Transition::parse).unwrap_or(self.show.transition);
                if let Some(e) = entry {
                    self.play_entry(Some(e), how, now);
                }
            }
            "next" => self.step(1, now),
            "prev" => self.step(-1, now),
            "stop" => self.play_entry(None, Transition::Cut, now),
            "show" => {
                self.live_at[2] = now;
                if let Some(s) = d.get("show") {
                    self.set_show(&s.clone(), now);
                }
            }
            "setup" => {
                if let Some(s) = d.get("setup") {
                    self.live_at[0] = now;
                    let mut s = normalize_setup(s);
                    if let Some((w, h)) = self.cfg.led {
                        s.led_w = w;
                        s.led_h = h;
                    }
                    self.setup = s;
                    self.apply_wall();
                }
            }
            "projection" => {
                if let Some(p) = d.get("projection") {
                    self.live_at[1] = now;
                    self.projection_raw = p.clone();
                    self.apply_wall();
                }
            }
            "blackout" => {
                self.blackout = d.get("on").and_then(Value::as_bool).unwrap_or(false);
                let fade = d.get("fade").and_then(Value::as_f64).unwrap_or(0.5);
                self.black.set(if self.blackout { 1.0 } else { 0.0 }, fade * 1000.0, now);
                self.telemetry(now);
            }
            "pattern" => {
                self.pattern = d.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from);
                self.over = d.get("over").and_then(Value::as_bool).unwrap_or(false);
                self.telemetry(now);
            }
            "preview" => {
                self.preview_until = if d.get("on") == Some(&Value::Bool(false)) { 0.0 } else { now + PREVIEW_FOR_MS };
            }
            "wizard" => {
                self.wizard = if d.get("on").and_then(Value::as_bool) == Some(true) { Some(d.clone()) } else { None };
                self.wizard_at = now;
                self.telemetry(now);
            }
            "ping" => self.telemetry(now),
            // the browser reloads its page; here the documents are read again (the scene keeps
            // running: no black frame on the wall)
            "reload" => {
                for k in ["setup", "projection", "show"] {
                    self.docs.reload(k);
                }
            }
            "close" => {
                exit.write(AppExit::Success);
            }
            _ => {}
        }
    }

    fn retry_after_setup_error(&mut self, failed: Entry, now: f64) {
        // wall-output.js: after 5 s the next entry, or the same again
        let next = step_entry(&self.show, Some(&failed.id), 1).cloned();
        self.queued = None;
        self.error_at = 0.0;
        self.fails.push(now);
        let pick = match next {
            Some(n) if n.id != failed.id => n,
            _ => failed,
        };
        self.started_at = now - pick.duration * 1000.0 + 5000.0; // the auto advance (or the retry) comes in 5 s
        self.retry_entry = Some((pick, now + 5000.0));
    }

    fn start_show(&mut self, now: f64) {
        if let Some(name) = self.cfg.scene.clone() {
            let mut params = serde_json::Map::new();
            for (k, v) in &self.cfg.params {
                let val = if let Ok(n) = v.parse::<i64>() {
                    json!(n)
                } else if let Ok(n) = v.parse::<f64>() {
                    json!(n)
                } else if v == "true" || v == "false" {
                    json!(v == "true")
                } else {
                    json!(v)
                };
                params.insert(k.clone(), val);
            }
            let mut e = Entry::adhoc(&name);
            e.params = Value::Object(params);
            self.play_entry(Some(e), Transition::Cut, now);
            return;
        }
        let id = std::fs::read_to_string(remember_file(&self.cfg)).unwrap_or_default();
        let entry = self.show.entries.iter().find(|e| e.id == id.trim() && e.enabled).cloned().or_else(|| step_entry(&self.show, None, 1).cloned());
        self.play_entry(entry, Transition::Cut, now);
    }

    /// Every scene of the registry set up once and rendered a few frames offscreen: their
    /// pipelines are compiled now, at the start, not when the show switches to them.
    fn warm_up(&mut self, gpu: &Gpu, kgpu: &Arc<KinectGpu>, now: f64) {
        if self.out.is_none() {
            match OutGpu::new(gpu, self.led()) {
                Ok(o) => self.out = Some(o),
                Err(e) => {
                    self.push_error("Ausgabe", &e);
                    return;
                }
            }
        }
        if self.warm.is_none() {
            // set up in parallel threads (shader compilation dominates)
            let led = self.led();
            let defs: Vec<&'static SceneDef> = match &self.cfg.scene {
                Some(n) if self.cfg.shots.is_some() => self.registry.iter().copied().filter(|d| d.name == n).collect(),
                _ => self.registry.clone(),
            };
            let mut handles: Vec<std::thread::JoinHandle<WarmResult>> = Vec::new();
            for def in defs {
                let (gpu, kgpu) = (gpu.clone(), kgpu.clone());
                let mut wall = WallMap::new(self.setup.clone(), Some(self.projection_of(def)));
                wall.active = true;
                handles.push(std::thread::spawn(move || {
                    let t0 = mono_ms();
                    let params = Params::resolve(Arc::new((def.params)()), &json!({}));
                    let r = catch_unwind(AssertUnwindSafe(|| {
                        let wall_buf = gpu.uniform_buffer("warm wall", (crate::wall::WALL_UNIFORM_FLOATS * 4) as u64);
                        let target = gpu.target("warm output", led[0], led[1], TARGET_FORMAT);
                        let mut w = wall.clone();
                        gpu.queue.write_buffer(&wall_buf, 0, w.uniform_bytes());
                        let ctx = SetupCtx { gpu: gpu.clone(), kgpu, wall, wall_buf: wall_buf.clone(), params: params.clone(), width: led[0], height: led[1], name: def.name };
                        let (made, err) = gpu.scoped(|| (def.make)(&ctx));
                        match (made, err) {
                            (Ok(scene), None) => Ok((scene, ctx.wall, wall_buf, target)),
                            (Ok(_), Some(e)) | (Err(e), _) => Err(e),
                        }
                    }));
                    let ms = mono_ms() - t0;
                    (def, params, r.unwrap_or_else(|p| Err(panic_text(&p))), ms)
                }));
            }
            self.warm_jobs = handles;
            self.warm_since = now;
            self.warm = Some(Vec::new());
            self.warm_frames = 0;
            return;
        }
        // the setups that are done (never waits for one)
        let mut i = 0;
        while i < self.warm_jobs.len() {
            if !self.warm_jobs[i].is_finished() {
                i += 1;
                continue;
            }
            let h = self.warm_jobs.swap_remove(i);
            let Ok((def, params, r, ms)) = h.join() else { continue };
            {
                match r {
                    Ok((scene, wall, wall_buf, target)) => {
                        info!("bereit: {} ({ms:.0} ms)", def.name);
                        let view = target.create_view(&Default::default());
                        self.warm.get_or_insert_with(Vec::new).push(Instance {
                            def,
                            scene,
                            params,
                            overrides: json!({}),
                            wall,
                            wall_buf,
                            target,
                            view,
                            started: now,
                            frame: 0,
                            last: now,
                            status: String::new(),
                            hold: None,
                            glide: None,
                            state: State::Running,
                            opacity: Fade { from: 1.0, to: 1.0, start: now, ms: 0.0, curve: ease_in_out },
                            shown: false,
                            layer: None,
                        });
                    }
                    Err(e) => self.push_error(&format!("Szene {}", def.name), &e),
                }
            }
        }
        if !self.warm_jobs.is_empty() {
            if now - self.warm_since < 20_000.0 {
                return;
            }
            // a setup that hangs must not keep the show from starting (its scene sets up again when played)
            self.push_error("Aufwärmen", &format!("{} Szene(n) brauchen über 20 s zum Einrichten: die Show beginnt ohne sie", self.warm_jobs.len()));
            self.warm_jobs.clear();
        }
        // a few frames of each, offscreen (drivers compile some things on first use)
        let mut warm = self.warm.take().unwrap_or_default();
        let mut scratch = String::new();
        let mut hold = None;
        for inst in &mut warm {
            let mut enc = gpu.encoder("warm");
            let (r, err) = gpu.scoped(|| {
                catch_unwind(AssertUnwindSafe(|| {
                    let mut ctx = FrameCtx {
                        gpu,
                        encoder: &mut enc,
                        target: &inst.view,
                        width: self.setup.led_w,
                        height: self.setup.led_h,
                        time: self.warm_frames as f32 / 60.0,
                        dt: 1.0 / 60.0,
                        frame: u64::from(self.warm_frames),
                        params: &inst.params,
                        kinect: &mut self.kinect,
                        kgpu,
                        wall: &mut inst.wall,
                        wall_buf: &inst.wall_buf,
                        x_sign: -1.0,
                        status: &mut scratch,
                        hold_switch: &mut hold,
                        audio: &mut Audio::new(true),
                        now_ms: now,
                    };
                    inst.scene.frame(&mut ctx)
                }))
            });
            match (r, err) {
                (Ok(Ok(())), None) => {
                    let (_, err) = gpu.scoped(|| gpu.queue.submit([enc.finish()]));
                    if let Some(e) = err {
                        self.push_error(&format!("Szene {}", inst.def.name), &e);
                    }
                }
                (Ok(Err(e)), _) | (_, Some(e)) => self.push_error(&format!("Szene {}", inst.def.name), &e),
                (Err(p), _) => self.push_error(&format!("Szene {}", inst.def.name), &panic_text(&p)),
            }
        }
        self.warm_frames += 1;
        if self.warm_frames >= 3 {
            info!("alle Szenen vorbereitet ({:.1} s)", (mono_ms() - self.started) / 1000.0);
            drop(warm);
            self.warmed = true;
            if self.cfg.shots.is_some() {
                // test mode: the seconds, shots and frame times count from here
                self.started = now;
                self.shots_next = 0.0;
                self.frame_log.clear();
                self.slow_log.clear();
                self.cpu_log.clear();
                self.submit_log.clear();
                self.cpu_by_scene.clear();
                self.slow_cpu.clear();
                self.frame_rows.clear();
                self.late = 0;
            }
            self.black = Fade { from: 0.0, to: 0.0, start: now, ms: 0.0, curve: ease };
            self.start_show(now);
        } else {
            self.warm = Some(warm);
        }
    }

    /// The Kinect data, the wall mappings and every live scene's frame.
    fn render_scenes(&mut self, gpu: &Gpu, kgpu: &Arc<KinectGpu>, now: f64, sounds: &mut SoundQueue) {
        // the display interval the persons are played out to
        let every = (now - self.last_scene_frame).clamp(1.0, 200.0);
        self.last_scene_frame = now;
        self.kinect.interval = 0.9 * self.kinect.interval + 0.1 * every;
        let wall = &mut self.page_wall;
        self.kinect.begin_frame(now, &mut |r: Arc<PersonsResult>, exact: bool| wall.filter_persons(r, exact));
        kgpu.upload(&self.kinect);
        if let Some(l) = self.kinect.lut.clone() {
            let before = self.page_wall.tan_h;
            self.page_wall.set_rays(&l);
            if (self.page_wall.tan_h - before).abs() > 1e-6 {
                // projections that follow the view cone ('cone') follow the real view
                self.apply_wall();
            }
        }
        let x_sign = self.kinect.x_sign;
        self.page_wall.active = true;
        self.page_wall.update(&self.kinect.view, x_sign, now);
        // errors: a scene stopped by an error gets another go; one that keeps failing is skipped
        if self.current.as_ref().is_some_and(|c| c.state == State::Error) {
            if self.error_at == 0.0 {
                self.error_at = now;
                self.fails.retain(|t| now - t < FAIL_WINDOW_MS);
                self.fails.push(now);
            } else if now - self.error_at > RETRY_MS {
                self.error_at = 0.0;
                let next = step_entry(&self.show, self.entry.as_ref().map(|e| e.id.as_str()), 1).map(|e| e.id.clone());
                if self.fails.len() >= FAILS_TO_SKIP && next != self.entry.as_ref().map(|e| e.id.clone()) {
                    let scene = self.current.as_ref().map(|c| c.def.name).unwrap_or("");
                    self.push_error("Show", &format!("{scene}: zu viele Fehler – weiter zur nächsten Szene"));
                    self.step(1, now);
                } else if let Some(c) = self.current.as_mut() {
                    c.state = State::Running;
                }
            }
        }
        // the retry of an entry whose setup failed
        if let Some((e, at)) = self.retry_entry.take() {
            if now >= at {
                self.play_entry(Some(e), Transition::Cut, now);
            } else {
                self.retry_entry = Some((e, at));
            }
        }
        // fade-outs that are over
        self.leaving.retain(|l| now < l.until);
        let led = self.led();
        let mut errors = Vec::new();
        let mut list: Vec<&mut Instance> = Vec::new();
        for l in &mut self.leaving {
            list.push(&mut l.inst);
        }
        if let Some(c) = self.current.as_mut() {
            list.push(c);
        }
        let is_current = list.len();
        for (i, inst) in list.into_iter().enumerate() {
            if inst.state == State::Error {
                continue;
            }
            if let Some(l) = self.kinect.lut.clone() {
                inst.wall.set_rays(&l);
            }
            inst.wall.active = true;
            inst.wall.update(&self.kinect.view, x_sign, now);
            gpu.queue.write_buffer(&inst.wall_buf, 0, inst.wall.uniform_bytes());
            if let Some(g) = inst.glide.take() {
                let (keys, done) = step_glide(&mut inst.params, &g, now);
                for k in keys {
                    inst.scene.on_param(&k, &inst.params);
                }
                if !done {
                    inst.glide = Some(g);
                }
            }
            let dt = ((now - inst.last) / 1000.0).min(0.25) as f32;
            inst.last = now;
            let mut enc = gpu.encoder(inst.def.name);
            let (r, err) = gpu.scoped(|| {
                catch_unwind(AssertUnwindSafe(|| {
                    let mut ctx = FrameCtx {
                        gpu,
                        encoder: &mut enc,
                        target: &inst.view,
                        width: led[0],
                        height: led[1],
                        time: ((now - inst.started) / 1000.0) as f32,
                        dt,
                        frame: inst.frame,
                        params: &inst.params,
                        kinect: &mut self.kinect,
                        kgpu,
                        wall: &mut inst.wall,
                        wall_buf: &inst.wall_buf,
                        x_sign,
                        status: &mut inst.status,
                        hold_switch: &mut inst.hold,
                        audio: &mut self.audio,
                        now_ms: now,
                    };
                    inst.scene.frame(&mut ctx)
                }))
            });
            inst.frame += 1;
            let failure = match (r, err) {
                (Ok(Ok(())), None) => {
                    let t0 = mono_ms();
                    let (_, err) = gpu.scoped(|| gpu.queue.submit([enc.finish()]));
                    self.submit_ms += mono_ms() - t0;
                    err
                }
                (Ok(Err(e)), _) | (_, Some(e)) => Some(e),
                (Err(p), _) => Some(panic_text(&p)),
            };
            match failure {
                None => inst.shown = true,
                Some(e) => {
                    inst.state = State::Error;
                    errors.push((i + 1 == is_current, inst.def.name, e));
                }
            }
        }
        for (current, name, e) in errors {
            self.push_error(&format!("frame() {name}"), &e);
            if !current {
                // a scene fading out that fails is simply dropped
                self.leaving.retain(|l| l.inst.state != State::Error);
            }
        }
        if self.current.is_some() {
            self.fps_count += 1;
        }
        sounds.pending.extend(self.audio.take());
    }

    /// Stage (layers, test image) -> color, black -> the LED image; previews; the window gets it.
    fn present(&mut self, gpu: &Gpu, image: &mut OutputImage, now: f64) {
        let led = self.led();
        if self.out.as_ref().is_some_and(|o| o.led != led) {
            self.out = None;
            // the scenes' outputs have the old size: start the entry again
            self.current = None;
            self.leaving.clear();
            if self.warmed {
                let e = self.entry.clone();
                self.play_entry(e, Transition::Cut, now);
            }
        }
        if self.out.is_none() {
            match OutGpu::new(gpu, led) {
                Ok(o) => {
                    self.out = Some(o);
                    image.generation += 1;
                }
                Err(e) => {
                    self.push_error("Ausgabe", &e);
                    return;
                }
            }
        }
        // the test image or the assistant (2D, on the CPU, only while shown)
        if self.wizard.is_some() && now - self.wizard_at > 10_000.0 {
            self.wizard = None;
        }
        let overlay = self.pattern.is_some() || self.wizard.is_some();
        if overlay {
            self.canvas.resize(led[0], led[1]);
            let sw = self.current.as_ref().map(|c| &c.wall).unwrap_or(&self.page_wall);
            if let Some(w) = &self.wizard {
                crate::patterns::draw_wizard(&mut self.canvas, w, now, &self.page_wall);
            } else if let Some(p) = &self.pattern {
                crate::patterns::draw_pattern(&mut self.canvas, p, self.over, now, sw, &self.kinect);
            }
        }
        let Some(o) = self.out.as_ref() else { return };
        if overlay {
            gpu.write_texture(&o.overlay, self.canvas.data(), 4);
        }
        // the layers: the scenes fading out below (opaque), the current one on top with its opacity
        let mut layers: Vec<wgpu::BindGroup> = Vec::new();
        {
            let mut insts: Vec<(&mut Instance, f32)> = Vec::new();
            for l in &mut self.leaving {
                insts.push((&mut l.inst, 1.0));
            }
            if let Some(c) = self.current.as_mut() {
                let a = c.opacity.at(now) as f32;
                insts.push((c, a));
            }
            for (inst, a) in insts {
                if !inst.shown {
                    continue;
                }
                if inst.layer.is_none() {
                    let ub = gpu.uniform_buffer("layer", 16);
                    let g = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("layer"),
                        layout: &o.layer_bgl,
                        entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&inst.view) }, wgpu::BindGroupEntry { binding: 1, resource: ub.as_entire_binding() }],
                    });
                    inst.layer = Some((ub, g));
                }
                if let Some((ub, g)) = &inst.layer {
                    gpu.queue.write_buffer(ub, 0, bytemuck::cast_slice(&[a, 0.0, 0.0, 0.0]));
                    layers.push(g.clone());
                }
            }
        }
        let Some(o) = self.out.as_ref() else { return };
        let mut enc = gpu.encoder("output");
        {
            let mut pass = crate::gpu::begin_pass(&mut enc, "stage", &o.stage_view);
            for g in &layers {
                pass.set_pipeline(&o.layer_pipe);
                pass.set_bind_group(0, g, &[]);
                pass.draw(0..3, 0..1);
            }
            if overlay {
                pass.set_pipeline(&o.overlay_pipe);
                pass.set_bind_group(0, &o.overlay_group, &[]);
                pass.draw(0..3, 0..1);
            }
        }
        let s = &self.setup;
        let black = self.black.at(now) as f32;
        let c = [s.brightness * s.gain[0], s.brightness * s.gain[1], s.brightness * s.gain[2], s.gamma, black, 0.0, 0.0, 0.0];
        gpu.queue.write_buffer(&o.final_buf, 0, bytemuck::cast_slice(&c));
        {
            let mut pass = crate::gpu::begin_pass(&mut enc, "final", &o.led_view);
            pass.set_pipeline(&o.final_pipe);
            pass.set_bind_group(0, &o.final_group, &[]);
            pass.draw(0..3, 0..1);
        }
        // previews for the control center, shots for tests
        if now < self.preview_until && now - self.last_preview >= PREVIEW_MS {
            self.last_preview = now;
            self.readback.request(gpu, &mut enc, &o.led_tex, &o.led_view, Purpose::Preview);
        }
        if let Some(dir) = &self.cfg.shots
            && self.warmed
            && self.current.is_some()
            && now - self.started >= self.shots_next
        {
            self.shots_next = now - self.started + self.cfg.shot_every * 1000.0;
            self.shot_no += 1;
            let name = self.current.as_ref().map(|c| c.def.name).unwrap_or("none");
            self.readback.request(gpu, &mut enc, &o.led_tex, &o.led_view, Purpose::Shot(dir.join(format!("{name}-{:03}.png", self.shot_no))));
        }
        let led_view = o.led_view.clone();
        let t0 = mono_ms();
        let (_, err) = gpu.scoped(|| gpu.queue.submit([enc.finish()]));
        self.submit_ms += mono_ms() - t0;
        if let Some(e) = err {
            self.push_error("Ausgabe", &e);
        }
        self.readback.after_submit(gpu);
        while let Ok((url, w, h)) = self.readback.previews.try_recv() {
            if let Some(b) = &self.bus {
                b.send("frame", json!({ "jpeg": url, "w": w, "h": h, "blackout": self.blackout }), Some("control"));
            }
        }
        // the window shows it
        image.view = Some(led_view);
        image.led = led;
        image.fit = if self.windowed || self.cfg.windowed || self.cfg.shots.is_some() {
            Fit::Fit
        } else {
            match self.setup.output_fit.as_str() {
                "stretch" => Fit::Stretch,
                "fit" => Fit::Fit,
                _ => Fit::Pixel,
            }
        };
        image.offset = [self.setup.output_x, self.setup.output_y];
    }

    /// Auto advance after the entry's duration (wall-output.js, every 0.5 s).
    fn auto_advance(&mut self, now: f64) {
        self.seen.push_back(self.kinect.view.len());
        while self.seen.len() > CROWD_SAMPLES {
            self.seen.pop_front();
        }
        self.crowd = self.seen.iter().copied().max().unwrap_or(0);
        self.waiting = None;
        let Some(cur) = self.entry.clone() else { return };
        if !self.show.auto || self.blackout || self.pending.is_some() {
            return;
        }
        let elapsed = (now - self.started_at) / 1000.0;
        if elapsed < cur.duration {
            return;
        }
        let hold = match &self.current {
            Some(c) if c.def.name == cur.scene && c.state == State::Running => c.hold,
            _ => None,
        };
        let mut limit = 0.0;
        if cur.wait {
            match hold {
                Some(h) if self.show.wait_for_round => {
                    if h {
                        self.waiting = Some("round");
                        limit = self.show.max_round_wait;
                    }
                }
                _ => {
                    if self.show.wait_for_empty && !self.kinect.view.visible.is_empty() {
                        self.waiting = Some("empty");
                        limit = crowd_wait(&self.show, self.crowd);
                    }
                }
            }
        }
        self.wait_limit = limit;
        self.wait_left = cur.duration + limit - elapsed;
        if self.wait_left <= 0.0 {
            self.waiting = None;
        }
        if self.waiting.is_some() {
            return;
        }
        let next = step_entry(&self.show, Some(&cur.id), 1).cloned();
        match next {
            Some(n) if n.id != cur.id => self.play_entry(Some(n), self.show.transition, now),
            _ => self.started_at = now, // only one entry: keep it
        }
    }

    fn status_line(&self) -> String {
        if !self.kinect.connected {
            return format!("Keine Verbindung zu kinect-hub ({}) – verbinde neu …", self.cfg.hub);
        }
        if let Some(s) = self.kinect.status.as_ref().and_then(|s| s.sensor.as_ref())
            && s.state != "streaming"
        {
            return format!("Kinect: {}{}", s.state, s.detail.as_ref().map(|d| format!(" ({d})")).unwrap_or_default());
        }
        if self.kinect.depth.is_some() && self.kinect.depth_age_ms() > 1500.0 {
            return format!("Keine neuen Bilder seit {:.0} s", self.kinect.depth_age_ms() / 1000.0);
        }
        String::new()
    }

    fn telemetry(&mut self, now: f64) {
        self.last_telemetry = now;
        let problem = self.status_line();
        // logged once it has lasted 2 s (not for the moment the hub connects), once per kind
        let key: String = problem.chars().filter(|c| !c.is_ascii_digit()).collect();
        if key != self.problem_key {
            self.problem_key = key;
            self.problem_since = now;
            self.problem_logged = false;
        }
        if !self.problem_logged && !problem.is_empty() && now - self.problem_since >= 2000.0 {
            warn!("{problem}");
            self.problem_logged = true;
        }
        self.problem = problem.clone();
        let Some(bus) = &self.bus else { return };
        let sw = self.current.as_ref().map(|c| &c.wall).unwrap_or(&self.page_wall);
        let elapsed = (now - self.started_at) / 1000.0;
        let persons: Vec<Value> = sw
            .persons
            .iter()
            .map(|p| {
                let person = self.kinect.view.by_id(p.id);
                json!({
                    "id": p.id, "slot": p.slot, "css": p.css, "x": p.x, "y": p.y, "z": p.z, "dist": p.dist, "lateral": p.lateral, "real": p.real,
                    "shift": p.shift, "inZone": p.in_zone, "top": p.top, "feet": p.feet, "norm": [p.norm.x, p.norm.y, p.norm.z], "scale": p.scale, "gain": p.gain,
                    "height": if p.height.is_finite() { json!(p.height) } else { Value::Null },
                    "reach": person.and_then(crate::patterns::reach_of),
                })
            })
            .collect();
        let state = if self.pending.is_some() || matches!(self.black_step, BlackStep::Out { .. }) {
            "switching"
        } else {
            match &self.current {
                Some(c) if c.state == State::Error => "error",
                Some(_) => "running",
                None => "loading",
            }
        };
        let k = &self.kinect;
        let data = json!({
            "scene": self.current.as_ref().map(|c| c.def.name),
            "title": self.title,
            "entry": self.entry.as_ref().map(|e| e.id.clone()),
            "entryRemoved": self.entry_removed,
            "state": state,
            "elapsed": elapsed,
            "remaining": if self.show.auto && self.entry.is_some() { json!((self.entry.as_ref().map(|e| e.duration).unwrap_or(0.0) - elapsed).max(0.0)) } else { Value::Null },
            "waiting": self.waiting,
            "waitLeft": if self.waiting.is_some() { json!(self.wait_left) } else { Value::Null },
            "waitLimit": if self.waiting.is_some() { json!(self.wait_limit) } else { Value::Null },
            "crowd": self.crowd,
            "fps": (self.fps * 10.0).round() / 10.0,
            "kinect": { "hub": self.cfg.hub, "connected": k.connected, "sensor": k.sensor_state(), "hubFps": k.status.as_ref().map(|s| s.fps.0), "fps": (k.fps * 10.0).round() / 10.0, "received": k.received, "latencyMs": (k.latency_ms * 10.0).round() / 10.0 },
            "problem": if self.problem.is_empty() { Value::Null } else { json!(self.problem) },
            "tracker": if k.persons_enabled { json!(k.status_text()) } else { Value::Null },
            "status": self.current.as_ref().map(|c| c.status.clone()).unwrap_or_default(),
            "persons": persons,
            "projection": { "scene": self.current.as_ref().map(|c| c.def.name), "profile": sw.projection.to_json() },
            "wizard": self.wizard.is_some(),
            "room": { "found": self.page_wall.room_found, "height": self.page_wall.room_height, "source": self.page_wall.room_source, "pitch": k.view.floor.as_ref().map(|f| f.pitch_deg.0), "matrix": self.page_wall.room.to_vec() },
            "xSign": k.x_sign,
            "tanH": self.page_wall.tan_h,
            "blocked": self.page_wall.blocked.iter().map(|b| json!({ "id": b.0, "slot": b.1, "x": b.2, "z": b.3 })).collect::<Vec<_>>(),
            "embedded": false,
            "owner": Value::Null,
            "errors": self.errors.iter().rev().take(6).rev().map(|e| json!({ "where": e.where_, "message": e.message, "count": e.count, "at": e.at, "scene": e.scene })).collect::<Vec<_>>(),
            "blackout": self.blackout,
            "pattern": self.pattern,
            "over": self.over,
            "led": [self.setup.led_w, self.setup.led_h],
            "native": { "engine": "bevy", "late": self.late, "refreshHz": (1000.0 / refresh_interval(&self.intervals)).round(), "playDelayMs": k.play_delay().round() },
            "screen": self.screen,
        });
        bus.send("telemetry", data, Some("control"));
    }

    /// Test mode: what plays, for the frame logs ("name +setup +fade +first").
    fn playing(&self, first: bool) -> String {
        format!(
            "{}{}{}{}",
            self.current.as_ref().map_or("-", |c| c.def.name),
            if self.pending.is_some() { " +setup" } else { "" },
            if self.leaving.is_empty() { "" } else { " +fade" },
            if first { " +first" } else { "" }
        )
    }

    /// Test mode: stops after --seconds and writes the frame times.
    fn shots(&mut self, now: f64, exit: &mut MessageWriter<AppExit>) {
        let (Some(dir), Some(secs)) = (&self.cfg.shots, self.cfg.seconds) else { return };
        if !self.warmed || now - self.started < secs * 1000.0 {
            return;
        }
        if self.readback.busy() > 0 {
            if let Some(gpu) = self.gpu.as_ref() {
                self.readback.after_submit(gpu);
            }
            return;
        }
        let mut v = self.frame_log.clone();
        v.sort_by(f64::total_cmp);
        let q = |p: f64| if v.is_empty() { 0.0 } else { v[((p * (v.len() - 1) as f64).round()) as usize] };
        let errors: Vec<String> = self.errors.iter().map(|e| format!("{}: {}", e.where_, e.message)).collect();
        // the 25 longest frames, when and during what
        let longest = |log: &[(f64, f64, String)]| -> Vec<Value> {
            let mut v = log.to_vec();
            v.sort_by(|a, b| b.1.total_cmp(&a.1));
            v.truncate(25);
            v.iter().map(|(t, ms, what)| json!({ "t": (t * 10.0).round() / 10.0, "ms": (ms * 10.0).round() / 10.0, "scene": what })).collect()
        };
        let slow = longest(&self.slow_log);
        let slow_cpu = longest(&self.slow_cpu);
        let quantiles = |log: &[f64]| -> Value {
            let mut c = log.to_vec();
            c.sort_by(f64::total_cmp);
            let q = |p: f64| if c.is_empty() { 0.0 } else { (c[((p * (c.len() - 1) as f64).round()) as usize] * 100.0).round() / 100.0 };
            json!({ "p50": q(0.5), "p95": q(0.95), "p99": q(0.99), "max": q(1.0) })
        };
        let cpu = quantiles(&self.cpu_log);
        let submit = quantiles(&self.submit_log);
        let cpu_by_scene: serde_json::Map<String, Value> = self.cpu_by_scene.iter().map(|(name, log)| ((*name).to_string(), quantiles(log))).collect();
        let report = json!({
            "frames": v.len(), "fps": if v.is_empty() { 0.0 } else { 1000.0 * v.len() as f64 / v.iter().sum::<f64>() },
            "p50": q(0.5), "p95": q(0.95), "p99": q(0.99), "max": q(1.0), "late": self.late,
            "kinectFps": self.kinect.fps, "persons": self.kinect.view.len(), "results": self.kinect.results, "playDelay": self.kinect.play_delay(),
            "errors": errors,
            "slow": slow,
            "cpu": cpu,
            "submit": submit,
            "cpuByScene": cpu_by_scene,
            "slowCpu": slow_cpu,
        });
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(dir.join("frames.json"), serde_json::to_string_pretty(&report).unwrap_or_default());
        let mut csv = String::from("t_ms,dt_ms,cpu_ms,submit_ms,scene,rendered,fade,setup,first\n");
        for r in &self.frame_rows {
            csv.push_str(&format!("{:.3},{:.3},{:.3},{:.3},{},{},{},{},{}\n", r.t, r.dt, r.cpu, r.submit, r.scene, u8::from(r.rendered), u8::from(r.fade), u8::from(r.setup), u8::from(r.first)));
        }
        let _ = std::fs::write(dir.join("frames.csv"), csv);
        info!("Test fertig: {report}");
        exit.write(AppExit::Success);
    }
}
