//! The decoder on the GPU (feature `gpu`): the CPU decoder's steps as wgpu compute shaders
//! (`decode.wgsl`), with the same parameters and approximations, so both give the same frames up
//! to rounding. Vulkan, Metal, DirectX 12 or OpenGL ES 3.1 (wgpu 30, the version wall-bevy uses:
//! an application can hand in its own device with [`GpuDecoder::with_device`]).
//!
//! One frame: upload the raw packet (2.7 MB), about 30 dispatches, read depth, infrared,
//! confidence and flags back (2.6 MB). The values between the stages take 16 bits each, in the
//! formats of `tof/pack.rs` (the CPU decoder stores the same), two to a 32-bit word; the output
//! planes (`crate::plane`) have the same formats, so the read back halves are copied as they are.
//! The push-pull pyramid of the resolver's expectation starts at half resolution, and the
//! resolver works out the last step for the pixels that ask. Two steps that work on whole areas
//! (the flood fill inside saturated areas, the infrared percentile) then run on the CPU, shared
//! with the CPU decoder; they cost only where something saturated.
//!
//! Nothing here may take the program down: wgpu's error callbacks are installed (they would
//! panic by default), every call runs inside `catch`, and a lost device turns into errors that
//! [`FallbackDecoder`] answers by decoding on the CPU.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use crate::consts::{HEIGHT, PACKET_BYTES, PHASE_SUBIMAGES, PIXELS, SATURATED, SUBIMAGE_BYTES, WIDTH};
use crate::error::{Error, Result, catch};
use crate::packet::RawDepthPacket;
use crate::pipeline::TofDecoder;
use crate::tables::DeviceTables;
use crate::tof::config::{TofConfig, TofMode};
use crate::tof::cpu::{Prepared, edge_params, s1_params, s2_params, s3_params};
use crate::tof::kernels::{ANCHOR_CONFIDENCE, FULL_SCALE, REBUILT_NOISE, TIE_BREAK, U_RANGE_MM, flags, kind};
use crate::tof::pack::{self, Codec, formats};
use crate::tof::resolve::{CONFIRMED_CONFIDENCE, SURE_CONFIDENCE};
use crate::tof::post::PostScratch;
use crate::tof::{CpuDecoder, TofOutput, TofTimings, post};

const N: usize = PIXELS;
const SUB_WORDS: usize = SUBIMAGE_BYTES / 4;
const ROW_WORDS: usize = crate::consts::ROW_BYTES / 4;
const MASK_BASE: usize = PHASE_SUBIMAGES * SUB_WORDS;
const RAW_WORDS: usize = MASK_BASE + HEIGHT;

// table planes (`tabs`, words), then the lookup table
const T_MCS: usize = 0;
const T_XT: usize = 3;
const T_ZT: usize = 4;
const T_PLANES: usize = 5;

// work planes (`work`, words; two 16-bit values each, low half first): the first three are read
// back together
/// depth ([`formats::DEPTH`]), confidence ([`formats::CONFIDENCE`])
const W_OUT: usize = 0;
/// infrared ([`formats::IR`]), amplitude of 120 MHz ([`formats::AMPLITUDE`])
const W_IRN: usize = 1;
/// flags (32 bits)
const W_FLAGS: usize = 2;
/// (a, b) per frequency ([`formats::AB`])
const W_AB: usize = 3;
/// (a, b) / amplitude per frequency ([`formats::DIRECTION`])
const W_DIR: usize = 6;
/// amplitudes of 80 and 16 MHz
const W_N01: usize = 9;
/// usable bits, bilateral edge test, saturation bits, kind; anchor weight
const W_SMALL: usize = 10;
/// u1, u2 ([`formats::U`]); compat: depth before the edge filter, amplitude sum
const W_U12: usize = 11;
/// cost gap ([`formats::GAP`]), confidence
const W_GAPC: usize = 12;
/// phase of the single frequency ([`formats::PHASE`]), amplitude sum ([`formats::AMPLITUDE_SUM`])
const W_CSIR: usize = 13;
/// depth and confidence after the resolver
const W_RES: usize = 14;
/// the push-pull pyramid starts after the planes
const W_PLANES: usize = 15;
/// planes read back
const READ_BACK: usize = 3;

const WG_X: u32 = 16;
const WG_Y: u32 = 8;

/// An exact f32 constant in WGSL (a hexadecimal float literal: no decimal rounding).
fn f32c(v: f32) -> String {
    let bits = v.to_bits();
    let sign = if bits >> 31 != 0 { "-" } else { "" };
    let exp = ((bits >> 23) & 0xff) as i32;
    let man = bits & 0x7f_ffff;
    match exp {
        0 if man == 0 => "0.0f".to_string(),
        0 => format!("{sign}0x0.{:06x}p-126f", man << 1),
        _ => format!("{sign}0x1.{:06x}p{}f", man << 1, exp - 127),
    }
}

enum Value {
    F(f32),
    U(u32),
}

/// Everything the shaders need from the configuration, in the order of `struct Params`.
fn params(cfg: &TofConfig) -> Vec<(&'static str, Value)> {
    use Value::{F, U};
    let ext = cfg.mode == TofMode::Extended;
    let s1 = s1_params(cfg);
    let s2 = s2_params(cfg);
    let e = edge_params(cfg, ext);
    let s3 = s3_params(cfg);
    let g = s2.gauss;
    let mut v = vec![
        ("mode", U(u32::from(ext))),
        ("cos_t0", F(s1.cos_t[0])),
        ("cos_t1", F(s1.cos_t[1])),
        ("cos_t2", F(s1.cos_t[2])),
        ("sin_t0", F(s1.sin_t[0])),
        ("sin_t1", F(s1.sin_t[1])),
        ("sin_t2", F(s1.sin_t[2])),
        ("ir_scale", F(s1.ir_scale)),
        ("ir_lin", F(s1.ir_lin)),
        ("repair", U(u32::from(s1.repair))),
        ("repair_lost", U(u32::from(s1.repair_lost))),
        ("repair_ratio", F(s1.repair_ratio)),
        ("full_scale", U(u32::from(s1.full_scale))),
        ("w_repaired", F(s1.w_repaired)),
        ("gain0", F(s1.gain[0])),
        ("gain1", F(s1.gain[1])),
        ("gain2", F(s1.gain[2])),
        ("jb_threshold", F(s2.jb_threshold)),
        ("jb_exp", F(s2.jb_exp)),
        ("max_edge", F(s2.max_edge)),
    ];
    let names = ["g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8"];
    v.extend(names.iter().zip(g).map(|(n, x)| (*n, F(x))));
    v.extend([
        ("bilateral", U(u32::from(s2.bilateral))),
        ("ab_multiplier", F(s2.ab_multiplier)),
        ("slope", F(s2.slope)),
        ("conf_offset", F(s2.conf_offset)),
        ("min_conf", F(s2.min_conf)),
        ("max_conf", F(s2.max_conf)),
        ("individual_threshold", F(s2.individual_threshold)),
        ("sum_threshold", F(s2.sum_threshold)),
        ("phase_offset", F(s2.phase_offset)),
        ("noise0", F(s2.noise_coeff[0])),
        ("noise1", F(s2.noise_coeff[1])),
        ("noise2", F(s2.noise_coeff[2])),
        ("noise_floor", F(s2.noise_floor)),
        ("min_amplitude", F(s2.min_amplitude)),
        ("weak_boost", U(u32::from(s2.weak_boost))),
        ("weak_threshold", F(s2.weak_threshold)),
        ("plausibility", U(u32::from(s2.plausibility))),
        ("inv_brightness", F(s2.inv_brightness)),
        ("min_reflectivity", F(s2.min_reflectivity)),
        ("max_reflectivity", F(s2.max_reflectivity)),
        ("ir_output", F(s2.ir_output)),
        ("min_depth", F(e.min_depth)),
        ("max_depth", F(e.max_depth)),
        ("edge_enabled", U(u32::from(e.enabled))),
        ("avg_min", F(e.avg_min)),
        ("std_threshold", F(e.std_threshold)),
        ("close", F(e.close)),
        ("far", F(e.far)),
        ("max_delta", F(e.max_delta)),
        ("avg_delta", F(e.avg_delta)),
        ("scale_mm", F(e.scale_mm)),
        ("out_min_conf", F(s3.min_conf)),
        ("speckle", U(u32::from(s3.speckle))),
        ("speckle_min", F(s3.speckle_min)),
        ("radius", U(if cfg.ext.spatial_resolve { cfg.ext.spatial_radius as u32 } else { 0 })),
        ("near_prior_mm", F(cfg.ext.near_prior_mm)),
        ("spatial", U(u32::from(cfg.ext.spatial_resolve))),
    ]);
    // a uniform struct is a multiple of 16 bytes
    let pads = ["pad0", "pad1", "pad2"];
    let mut p = 0;
    while v.len() % 4 != 0 {
        v.push((pads.get(p).copied().unwrap_or("pad"), U(0)));
        p += 1;
    }
    v
}

/// The constants and `struct Params` in front of `decode.wgsl`.
fn prelude(params: &[(&'static str, Value)]) -> String {
    let u = |name: &str, v: usize| format!("const {name}: u32 = {v}u;\n");
    let mut s = String::new();
    for (name, v) in [
        ("W", WIDTH),
        ("H", HEIGHT),
        ("N", N),
        ("SUB_WORDS", SUB_WORDS),
        ("ROW_WORDS", ROW_WORDS),
        ("MASK_BASE", MASK_BASE),
        ("T_MCS", T_MCS),
        ("T_XT", T_XT),
        ("T_ZT", T_ZT),
        ("T_LUT", T_PLANES * N),
        ("W_OUT", W_OUT),
        ("W_IRN", W_IRN),
        ("W_FLAGS", W_FLAGS),
        ("W_AB", W_AB),
        ("W_DIR", W_DIR),
        ("W_N01", W_N01),
        ("W_SMALL", W_SMALL),
        ("W_U12", W_U12),
        ("W_GAPC", W_GAPC),
        ("W_CSIR", W_CSIR),
        ("W_RES", W_RES),
        ("L1_FILLED", Pyramid::new().filled.first().copied().unwrap_or(0)),
        ("L1_W", Pyramid::new().sizes.first().map_or(1, |s| s.0)),
        ("L1_H", Pyramid::new().sizes.first().map_or(1, |s| s.1)),
    ] {
        s.push_str(&u(name, v));
    }
    // the formats of tof/pack.rs: scales of the f16 ones, the fixed-point constants
    let scale = |c: Codec| if let Codec::F16 { scale } = c { scale } else { 1.0 };
    let range = |c: Codec| if let Codec::Snorm { range } = c { range } else { 1.0 };
    for (name, v) in [
        ("AB_SCALE", scale(formats::AB)),
        ("AB_INV", 1.0 / scale(formats::AB)),
        ("AMP_SCALE", scale(formats::AMPLITUDE)),
        ("AMP_INV", 1.0 / scale(formats::AMPLITUDE)),
        ("GAP_SCALE", scale(formats::GAP)),
        ("GAP_INV", 1.0 / scale(formats::GAP)),
        ("IRSUM_SCALE", scale(formats::AMPLITUDE_SUM)),
        ("IRSUM_INV", 1.0 / scale(formats::AMPLITUDE_SUM)),
        ("IR_SCALE", scale(formats::IR)),
        ("TABLE_RANGE", range(formats::TABLE)),
        ("INV_65535", pack::INV_65535),
        ("INV_32767", pack::INV_32767),
        ("FRAC_OFFSET", pack::FRACTION_OFFSET),
        ("FRAC_SPAN", pack::FRACTION_SPAN),
        ("INV_FRAC_SPAN", pack::INV_FRACTION_SPAN),
        ("F16_MAX", pack::F16_MAX),
    ] {
        s.push_str(&format!("const {name}: f32 = {};\n", f32c(v)));
    }
    for (name, v) in [
        ("KIND_NONE", u32::from(kind::NONE)),
        ("KIND_MULTI", u32::from(kind::MULTI)),
        ("KIND_SINGLE", u32::from(kind::SINGLE)),
        ("FL_SATURATED_ANY", flags::SATURATED_ANY),
        ("FL_REPAIRED_80", flags::REPAIRED_80),
        ("FL_IR_FILLED", flags::IR_FILLED),
        ("FL_SINGLE_FREQUENCY", flags::SINGLE_FREQUENCY),
        ("FL_RESOLVED", flags::RESOLVED),
        ("FL_EDGE", flags::EDGE),
        ("FL_LOW_CONFIDENCE", flags::LOW_CONFIDENCE),
        ("FL_DATA_LOST", flags::DATA_LOST),
        ("FL_OUT_OF_RANGE", flags::OUT_OF_RANGE),
        ("FL_NEAR_PRIOR", flags::NEAR_PRIOR),
        ("FL_WEAK_BOOSTED", flags::WEAK_BOOSTED),
        ("FL_NO_SIGNAL", flags::NO_SIGNAL),
        ("FL_SPECKLE", flags::SPECKLE),
        ("FL_PLAUSIBILITY", flags::PLAUSIBILITY),
    ] {
        s.push_str(&format!("const {name}: u32 = {v}u;\n"));
    }
    for (name, v) in [
        ("SATURATED", SATURATED),
        ("FULL_SCALE", FULL_SCALE),
        ("UNIT_MM", crate::tables::PHASE_UNIT_MM),
        ("U_RANGE_MM", U_RANGE_MM),
        ("REBUILT_NOISE", REBUILT_NOISE),
        ("ANCHOR_CONFIDENCE", ANCHOR_CONFIDENCE),
        ("TIE_BREAK", TIE_BREAK),
        ("SURE_CONFIDENCE", SURE_CONFIDENCE),
        ("CONFIRMED_CONFIDENCE", CONFIRMED_CONFIDENCE),
    ] {
        s.push_str(&format!("const {name}: f32 = {};\n", f32c(v)));
    }
    s.push_str("struct Params {\n");
    for (name, v) in params {
        s.push_str(&format!("    {name}: {},\n", if matches!(v, Value::F(_)) { "f32" } else { "u32" }));
    }
    s.push_str("}\n");
    s
}

fn params_bytes(params: &[(&'static str, Value)]) -> Vec<u8> {
    params
        .iter()
        .flat_map(|(_, v)| match v {
            Value::F(f) => f.to_le_bytes(),
            Value::U(u) => u.to_le_bytes(),
        })
        .collect()
}

/// One push-pull step: which shader, on which level.
struct Step {
    pipeline: usize,
    group: wgpu::BindGroup,
    w: u32,
    h: u32,
}

/// The levels of the pyramid above the input (sizes and offsets in `work`, in words): per level
/// the (vw, wt) pairs and the filled values. The input (level 0) is read where it is needed,
/// and the resolver works out the last pull for the pixels that ask (as `tof/fill.rs` does):
/// nothing here has the size of the image.
struct Pyramid {
    sizes: Vec<(usize, usize)>,
    vwt: Vec<usize>,
    filled: Vec<usize>,
    words: usize,
}

impl Pyramid {
    fn new() -> Pyramid {
        let mut sizes = vec![(WIDTH.div_ceil(2), HEIGHT.div_ceil(2))];
        while let Some(&(w, h)) = sizes.last() {
            if w <= 1 && h <= 1 {
                break;
            }
            sizes.push((w.div_ceil(2), h.div_ceil(2)));
        }
        let mut at = W_PLANES * N;
        let (mut vwt, mut filled) = (Vec::new(), Vec::new());
        for (w, h) in &sizes {
            let n = w * h;
            vwt.push(at);
            filled.push(at + n);
            at += 2 * n;
        }
        Pyramid { sizes, vwt, filled, words: at }
    }
}

const P_STAGE1: usize = 0;
const P_STAGE2: usize = 1;
const P_STAGE3_COMPAT: usize = 2;
const P_RESOLVE: usize = 3;
const P_FINISH: usize = 4;
const P_PP_FIRST: usize = 5;
const P_PP_DOWN: usize = 6;
const P_PP_TOP: usize = 7;
const P_PP_UP: usize = 8;
const ENTRY_POINTS: [&str; 9] = ["stage1", "stage2", "stage3_compat", "resolve", "finish", "pp_first", "pp_down", "pp_top", "pp_up"];

/// The depth/infrared decoder on the GPU.
pub struct GpuDecoder {
    cfg: TofConfig,
    device: wgpu::Device,
    queue: wgpu::Queue,
    adapter: String,
    pipelines: Vec<wgpu::ComputePipeline>,
    raw: wgpu::Buffer,
    tabs: wgpu::Buffer,
    staging: wgpu::Buffer,
    work: wgpu::Buffer,
    group0: wgpu::BindGroup,
    /// group 1 for the stages that do not use it
    no_level: wgpu::BindGroup,
    steps: Vec<Step>,
    tables_id: Option<u64>,
    masks: Vec<u8>,
    /// the answer of the read-back mapping (set by its callback during the poll)
    mapped: Arc<Mutex<Option<std::result::Result<(), wgpu::BufferAsyncError>>>>,
    post: PostScratch,
    describe: String,
    saturation_level: f32,
    lost: Arc<AtomicBool>,
    /// how long the last frame took (stage1 = upload, stage2 = GPU, stage3 = read back,
    /// fill = the CPU steps)
    pub timings: TofTimings,
}

fn gpu_err(what: &str, e: impl std::fmt::Display) -> Error {
    Error::Gpu(format!("{what}: {e}"))
}

impl GpuDecoder {
    /// Opens the best GPU (`KINECT_DRIVER_GPU=low` prefers the integrated one; wgpu's
    /// `WGPU_BACKEND` and `WGPU_ADAPTER_NAME` choose further).
    pub fn new(cfg: TofConfig) -> Result<GpuDecoder> {
        cfg.validate()?;
        catch(|| {
            let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
            let power = match std::env::var("KINECT_DRIVER_GPU").as_deref() {
                Ok("low") => wgpu::PowerPreference::LowPower,
                _ => wgpu::PowerPreference::HighPerformance,
            };
            let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: power, ..Default::default() }))
                .map_err(|e| gpu_err("no GPU", e))?;
            if !adapter.get_downlevel_capabilities().flags.contains(wgpu::DownlevelFlags::COMPUTE_SHADERS) {
                return Err(Error::Gpu(format!("{} has no compute shaders", adapter.get_info().name)));
            }
            let info = adapter.get_info();
            let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
                label: Some("kinect-driver"),
                required_limits: wgpu::Limits::downlevel_defaults().using_resolution(adapter.limits()),
                ..Default::default()
            }))
            .map_err(|e| gpu_err("cannot open the GPU", e))?;
            GpuDecoder::build(device, queue, format!("{} ({:?})", info.name, info.backend), cfg)
        })
    }

    /// Decodes on a device the application already has (it must allow 4 storage buffers per
    /// shader stage and buffers of 32 MB: any adapter with compute shaders does).
    pub fn with_device(device: wgpu::Device, queue: wgpu::Queue, cfg: TofConfig) -> Result<GpuDecoder> {
        cfg.validate()?;
        catch(|| GpuDecoder::build(device, queue, "shared device".into(), cfg))
    }

    fn build(device: wgpu::Device, queue: wgpu::Queue, adapter: String, cfg: TofConfig) -> Result<GpuDecoder> {
        // wgpu panics on errors nobody catches: log them instead (each frame checks its own)
        device.on_uncaptured_error(Arc::new(|e| log::error!("kinect-driver GPU: {e}")));
        let lost = Arc::new(AtomicBool::new(false));
        let l2 = lost.clone();
        device.set_device_lost_callback(move |reason, msg| {
            log::warn!("kinect-driver GPU lost ({reason:?}): {msg}");
            l2.store(true, Ordering::SeqCst);
        });
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let p = params(&cfg);
        let source = format!("{}{}", prelude(&p), include_str!("decode.wgsl"));
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("kinect-driver decode"), source: wgpu::ShaderSource::Wgsl(source.into()) });
        let storage = |binding: u32, read_only: bool| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only }, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let uniform = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let layout0 = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("kinect-driver buffers"),
            entries: &[uniform(0), storage(1, true), storage(2, true), storage(3, false)],
        });
        let layout1 = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("kinect-driver level"), entries: &[uniform(0)] });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("kinect-driver"),
            bind_group_layouts: &[Some(&layout0), Some(&layout1)],
            immediate_size: 0,
        });
        let pipelines: Vec<wgpu::ComputePipeline> = ENTRY_POINTS
            .iter()
            .map(|entry| {
                device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some(entry),
                    layout: Some(&layout),
                    module: &module,
                    entry_point: Some(entry),
                    compilation_options: Default::default(),
                    cache: None,
                })
            })
            .collect();
        let buffer = |label: &str, bytes: usize, usage: wgpu::BufferUsages| {
            device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: bytes.div_ceil(4) as u64 * 4, usage, mapped_at_creation: false })
        };
        let pbytes = params_bytes(&p);
        let params_buf = buffer("kinect-driver params", pbytes.len(), wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST);
        queue.write_buffer(&params_buf, 0, &pbytes);
        let pyramid = Pyramid::new();
        let raw = buffer("kinect-driver raw", RAW_WORDS * 4, wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST);
        let tabs = buffer("kinect-driver tables", (T_PLANES * N + 2048) * 4, wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST);
        let work = buffer("kinect-driver work", pyramid.words * 4, wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC);
        let staging = buffer("kinect-driver readback", READ_BACK * N * 4, wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST);
        let group0 = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("kinect-driver buffers"),
            layout: &layout0,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: params_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: raw.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: tabs.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: work.as_entire_binding() },
            ],
        });
        let level_group = |vals: [usize; 8]| {
            let bytes: Vec<u8> = vals.iter().flat_map(|v| (*v as u32).to_le_bytes()).collect();
            let b = buffer("kinect-driver level", bytes.len(), wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST);
            queue.write_buffer(&b, 0, &bytes);
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("kinect-driver level"),
                layout: &layout1,
                entries: &[wgpu::BindGroupEntry { binding: 0, resource: b.as_entire_binding() }],
            })
        };
        let no_level = level_group([0; 8]);
        // push-pull of u1 weighted by the anchors (the resolver's expectation); level 0 of the
        // pyramid is level 1 of `tof/fill.rs`, made from the input
        let mut steps = Vec::new();
        let top = pyramid.sizes.len().saturating_sub(1);
        let size = |l: usize| pyramid.sizes.get(l).copied().unwrap_or((1, 1));
        let at = |v: &Vec<usize>, l: usize| v.get(l).copied().unwrap_or(0);
        let (w0, h0) = size(0);
        steps.push(Step { pipeline: P_PP_FIRST, group: level_group([w0, h0, WIDTH, HEIGHT, at(&pyramid.vwt, 0), 0, 0, 0]), w: w0 as u32, h: h0 as u32 });
        for l in 1..=top {
            let ((w, h), (pw, ph)) = (size(l), size(l - 1));
            steps.push(Step { pipeline: P_PP_DOWN, group: level_group([w, h, pw, ph, at(&pyramid.vwt, l), 0, at(&pyramid.vwt, l - 1), 0]), w: w as u32, h: h as u32 });
        }
        let (tw, th) = size(top);
        steps.push(Step { pipeline: P_PP_TOP, group: level_group([tw, th, 0, 0, at(&pyramid.vwt, top), at(&pyramid.filled, top), 0, 0]), w: tw as u32, h: th as u32 });
        for l in (0..top).rev() {
            let ((w, h), (pw, ph)) = (size(l), size(l + 1));
            steps.push(Step {
                pipeline: P_PP_UP,
                group: level_group([w, h, pw, ph, at(&pyramid.vwt, l), at(&pyramid.filled, l), 0, at(&pyramid.filled, l + 1)]),
                w: w as u32,
                h: h as u32,
            });
        }
        if let Some(e) = pollster::block_on(scope.pop()) {
            return Err(gpu_err("setting up the shaders", e));
        }
        let describe = format!("gpu {adapter}, {}", if cfg.mode == TofMode::Compat { "compat" } else { "extended" });
        Ok(GpuDecoder {
            cfg,
            device,
            queue,
            adapter,
            describe,
            mapped: Arc::new(Mutex::new(None)),
            post: PostScratch::default(),
            pipelines,
            raw,
            tabs,
            staging,
            work,
            group0,
            no_level,
            steps,
            tables_id: None,
            masks: vec![0; HEIGHT * 4],
            saturation_level: 0.0,
            lost,
            timings: TofTimings::default(),
        })
    }

    /// The configuration.
    pub fn config(&self) -> &TofConfig {
        &self.cfg
    }

    /// The GPU in use.
    pub fn adapter(&self) -> &str {
        &self.adapter
    }

    /// Decodes one raw packet (like [`CpuDecoder::decode`]).
    pub fn decode(&mut self, packet: &RawDepthPacket, tables: &Arc<DeviceTables>, out: &mut TofOutput) -> Result<()> {
        if self.lost.load(Ordering::SeqCst) {
            return Err(Error::Gpu("the GPU device was lost".into()));
        }
        if packet.data.len() < PACKET_BYTES {
            return Err(Error::invalid("raw depth packet too short"));
        }
        catch(|| self.decode_inner(packet, tables, out))
    }

    fn decode_inner(&mut self, packet: &RawDepthPacket, tables: &Arc<DeviceTables>, out: &mut TofOutput) -> Result<()> {
        let t0 = Instant::now();
        if self.tables_id != Some(tables.id) {
            let prep = Prepared::new(tables, &self.cfg);
            let mut bytes = Vec::with_capacity((T_PLANES * N + 2048) * 4);
            // per frequency (m cos(p0), m sin(p0)) as one word: the CPU decoder's 16-bit values
            for (mc, ms) in prep.mc.iter().zip(&prep.ms) {
                bytes.extend(mc.iter().zip(ms).flat_map(|(c, s)| (u32::from(*c) | (u32::from(*s) << 16)).to_le_bytes()));
            }
            for plane in [&prep.xt, &prep.zt] {
                bytes.extend(plane.iter().flat_map(|v| v.to_le_bytes()));
            }
            bytes.extend(prep.lut.iter().flat_map(|v| v.to_le_bytes()));
            self.queue.write_buffer(&self.tabs, 0, &bytes);
            self.tables_id = Some(tables.id);
        }
        let phases = packet.data.get(..PHASE_SUBIMAGES * SUBIMAGE_BYTES).ok_or_else(|| Error::invalid("raw depth packet too short"))?;
        self.queue.write_buffer(&self.raw, 0, phases);
        for (y, m) in self.masks.chunks_exact_mut(4).enumerate() {
            let bits = (0..PHASE_SUBIMAGES).fold(0u32, |acc, s| acc | (u32::from(packet.row_ok(s, y)) << s));
            m.copy_from_slice(&bits.to_le_bytes());
        }
        self.queue.write_buffer(&self.raw, (MASK_BASE * 4) as u64, &self.masks);
        let t1 = Instant::now();
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut enc = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("kinect-driver frame") });
        {
            let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("kinect-driver decode"), timestamp_writes: None });
            pass.set_bind_group(0, &self.group0, &[]);
            pass.set_bind_group(1, &self.no_level, &[]);
            let (fx, fy) = ((WIDTH as u32).div_ceil(WG_X), (HEIGHT as u32).div_ceil(WG_Y));
            let pl = &self.pipelines;
            dispatch(&mut pass, pl.get(P_STAGE1), fx, fy);
            dispatch(&mut pass, pl.get(P_STAGE2), fx, fy);
            if self.cfg.mode == TofMode::Compat {
                dispatch(&mut pass, pl.get(P_STAGE3_COMPAT), fx, fy);
            } else {
                if self.cfg.ext.spatial_resolve {
                    for s in &self.steps {
                        pass.set_bind_group(1, &s.group, &[]);
                        dispatch(&mut pass, pl.get(s.pipeline), s.w.div_ceil(WG_X), s.h.div_ceil(WG_Y));
                    }
                    pass.set_bind_group(1, &self.no_level, &[]);
                }
                dispatch(&mut pass, pl.get(P_RESOLVE), fx, fy);
                dispatch(&mut pass, pl.get(P_FINISH), fx, fy);
            }
        }
        enc.copy_buffer_to_buffer(&self.work, 0, &self.staging, 0, (READ_BACK * N * 4) as u64);
        let submission = self.queue.submit([enc.finish()]);
        let slot = self.mapped.clone();
        *slot.lock().unwrap_or_else(PoisonError::into_inner) = None;
        self.staging.map_async(wgpu::MapMode::Read, .., move |r| {
            *slot.lock().unwrap_or_else(PoisonError::into_inner) = Some(r);
        });
        let waited = self
            .device
            .poll(wgpu::PollType::Wait { submission_index: Some(submission), timeout: Some(Duration::from_secs(5)) })
            .map_err(|e| gpu_err("waiting for the GPU", e))
            .and_then(|_| match pollster::block_on(scope.pop()) {
                Some(e) => Err(gpu_err("decoding", e)),
                None => Ok(()),
            })
            .and_then(|()| {
                // the poll above ran the mapping's callback; once more if it is late
                let answer = || self.mapped.lock().unwrap_or_else(PoisonError::into_inner).take();
                match answer().or_else(|| {
                    let _ = self.device.poll(wgpu::PollType::Poll);
                    answer()
                }) {
                    Some(Ok(())) => Ok(()),
                    Some(Err(e)) => Err(gpu_err("reading back", e)),
                    None => Err(Error::Gpu("reading back: no answer from the GPU".into())),
                }
            });
        if let Err(e) = waited {
            // never leave the buffer mapped (or a mapping pending): the next frame copies into it
            self.staging.unmap();
            return Err(e);
        }
        let t2 = Instant::now();
        out.resize();
        out.sequence = packet.sequence;
        out.timestamp = packet.timestamp;
        {
            let view = self.staging.get_mapped_range(..).map_err(|e| gpu_err("reading back", e))?;
            let words = |p: usize| {
                let bytes = view.get(p * N * 4..(p + 1) * N * 4).unwrap_or(&[]);
                bytes.as_chunks::<4>().0.iter().map(|c| u32::from_le_bytes(*c))
            };
            // the output planes have the formats of the words' halves: copied as they are
            for ((d, c), w) in out.depth.raw_mut().iter_mut().zip(out.confidence.raw_mut().iter_mut()).zip(words(W_OUT)) {
                *d = w as u16;
                *c = (w >> 16) as u16;
            }
            for (v, w) in out.ir.raw_mut().iter_mut().zip(words(W_IRN)) {
                *v = w as u16;
            }
            for (f, w) in out.flags.iter_mut().zip(words(W_FLAGS)) {
                *f = w;
            }
        }
        self.staging.unmap();
        let t3 = Instant::now();
        if self.cfg.mode == TofMode::Extended {
            if self.cfg.ext.fill_saturated_depth {
                // (cannot fail without workers)
                let _ = post::fill_saturated_depth(&self.cfg, &mut out.depth, &mut out.confidence, &mut out.flags, &mut self.post, None);
            }
            if self.cfg.ext.ir_fill_clipped {
                post::fill_ir(&self.cfg, &mut out.ir, &out.flags, &mut self.saturation_level, &mut self.post);
            }
        }
        let ms = |a: Instant, b: Instant| b.duration_since(a).as_secs_f64() * 1000.0;
        let t4 = Instant::now();
        self.timings = TofTimings { stage1_ms: ms(t0, t1), stage2_ms: ms(t1, t2), stage3_ms: ms(t2, t3), fill_ms: ms(t3, t4), total_ms: ms(t0, t4) };
        Ok(())
    }
}

fn dispatch(pass: &mut wgpu::ComputePass<'_>, pipeline: Option<&wgpu::ComputePipeline>, x: u32, y: u32) {
    if let Some(p) = pipeline {
        pass.set_pipeline(p);
        pass.dispatch_workgroups(x, y, 1);
    }
}

impl TofDecoder for GpuDecoder {
    fn describe(&self) -> &str {
        &self.describe
    }
    fn decode(&mut self, packet: &RawDepthPacket, tables: &Arc<DeviceTables>, out: &mut TofOutput) -> Result<()> {
        GpuDecoder::decode(self, packet, tables, out)
    }
    fn last_ms(&self) -> f64 {
        self.timings.total_ms
    }
}

/// The GPU decoder with the CPU as safety net: if there is no usable GPU, or it fails (driver
/// reset, device lost), frames are decoded on the CPU, and the GPU is tried again now and then.
pub struct FallbackDecoder {
    cfg: TofConfig,
    gpu: Option<GpuDecoder>,
    cpu: Option<CpuDecoder>,
    reason: String,
    describe: String,
    retry_at: Option<Instant>,
    last_ms: f64,
}

/// How long the CPU stands in before the GPU is tried again.
const GPU_RETRY: Duration = Duration::from_secs(30);

impl FallbackDecoder {
    /// Tries the GPU; without one the CPU decodes (see [`FallbackDecoder::reason`]).
    pub fn new(cfg: TofConfig) -> Result<FallbackDecoder> {
        cfg.validate()?;
        let mut d = FallbackDecoder { cfg, gpu: None, cpu: None, reason: String::new(), describe: String::new(), retry_at: None, last_ms: 0.0 };
        d.try_gpu();
        if d.gpu.is_none() {
            d.cpu = Some(CpuDecoder::new(d.cfg.clone())?);
        }
        d.refresh_describe();
        Ok(d)
    }

    /// The description changes only when the decoder switches.
    fn refresh_describe(&mut self) {
        self.describe = match (&self.gpu, &self.cpu) {
            (Some(g), _) => g.describe().to_string(),
            (None, Some(c)) => format!("{} (no GPU: {})", c.describe(), self.reason),
            (None, None) => "none".into(),
        };
    }

    fn try_gpu(&mut self) {
        match GpuDecoder::new(self.cfg.clone()) {
            Ok(g) => {
                log::info!("kinect-driver: decoding on {}", g.adapter());
                self.gpu = Some(g);
                self.reason.clear();
                self.retry_at = None;
            }
            Err(e) => {
                log::warn!("kinect-driver: no GPU decoding ({e}); using the CPU");
                self.reason = e.to_string();
                self.retry_at = Some(Instant::now() + GPU_RETRY);
            }
        }
    }

    /// Why the CPU decodes instead of the GPU (empty while the GPU works).
    pub fn reason(&self) -> &str {
        &self.reason
    }

    /// True while the GPU decodes.
    pub fn on_gpu(&self) -> bool {
        self.gpu.is_some()
    }
}

impl TofDecoder for FallbackDecoder {
    fn describe(&self) -> &str {
        &self.describe
    }

    fn decode(&mut self, packet: &RawDepthPacket, tables: &Arc<DeviceTables>, out: &mut TofOutput) -> Result<()> {
        if self.gpu.is_none() && self.retry_at.is_some_and(|t| Instant::now() >= t) {
            self.try_gpu();
            self.refresh_describe();
        }
        if let Some(g) = self.gpu.as_mut() {
            match g.decode(packet, tables, out) {
                Ok(()) => {
                    self.last_ms = g.timings.total_ms;
                    return Ok(());
                }
                // a bad packet is not the GPU's fault
                Err(e @ Error::InvalidData(_)) => return Err(e),
                Err(e) => {
                    log::warn!("kinect-driver: GPU decoding failed ({e}); switching to the CPU");
                    self.reason = e.to_string();
                    self.gpu = None;
                    self.retry_at = Some(Instant::now() + GPU_RETRY);
                    if self.cpu.is_none() {
                        self.cpu = Some(CpuDecoder::new(self.cfg.clone())?);
                    }
                    self.refresh_describe();
                }
            }
        }
        if self.cpu.is_none() {
            self.cpu = Some(CpuDecoder::new(self.cfg.clone())?);
            self.refresh_describe();
        }
        let cpu = self.cpu.as_mut().ok_or_else(|| Error::Unsupported("no decoder".into()))?;
        cpu.decode(packet, tables, out)?;
        self.last_ms = cpu.timings.total_ms;
        Ok(())
    }

    fn last_ms(&self) -> f64 {
        self.last_ms
    }
}

#[cfg(test)]
mod tests {
    use super::f32c;

    /// Parses what `f32c` writes (the WGSL hex float syntax it uses).
    fn parse(s: &str) -> f32 {
        let s = s.trim_end_matches('f');
        let (neg, s) = match s.strip_prefix('-') {
            Some(r) => (true, r),
            None => (false, s),
        };
        if s == "0.0" {
            return 0.0;
        }
        let (m, e) = s.trim_start_matches("0x").split_once('p').unwrap();
        let (int, frac) = m.split_once('.').unwrap();
        let mant = u64::from_str_radix(int, 16).unwrap() as f64 + u64::from_str_radix(frac, 16).unwrap() as f64 / 16f64.powi(frac.len() as i32);
        let v = (mant * 2f64.powi(e.parse::<i32>().unwrap())) as f32;
        if neg { -v } else { v }
    }

    #[test]
    fn exact_float_literals() {
        for v in [1.0f32, -2.5, 32767.0, 2083.333, std::f32::consts::SQRT_2, 0.8, 1e-30, f32::MIN_POSITIVE / 4.0, 0.0] {
            assert_eq!(parse(&f32c(v)).to_bits(), v.to_bits(), "{v} -> {}", f32c(v));
        }
    }
}
