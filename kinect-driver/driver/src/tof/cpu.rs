//! The CPU decoder: raw depth packet -> depth, infrared, confidence, flags.
//!
//! Phases, each over all rows in blocks on a few threads:
//! 1. unpack the samples, complex value (a, b) per frequency, infrared
//! 2. bilateral filter, phase unwrapping
//! 3. (extended) neighbors resolve ambiguous pixels; edge filter, range, confidence
//! 4. (extended) clipped infrared is filled from its surroundings
//!
//! The planes between the phases take 16 bits per value (`pack.rs`: f16 or fixed point, the
//! format per plane below), stored row-interleaved (row y holds all planes of the phase one after
//! the other), so one block of rows is one contiguous slice for every plane. The kernels work on
//! `f32` rows: each thread unpacks the rows its block needs into a small ring (every row once per
//! block) and packs what it computed.

use std::sync::Arc;
use std::time::Instant;

use super::config::{TofConfig, TofMode};
use super::echoes;
use super::lanes::LANES;
use super::fill::PushPull;
use super::kernels::{
    self, EdgeParams, Row, RowU8, S1Out, S1Params, S1Tabs, S2In, S2OutCompat, S2OutExt, S2Params, S3In, S3Params,
};
use super::pack::{Codec, formats, pack, pack_row, unpack, unpack_row};
use super::parallel::{Workers, thread_count};
use super::post::{self, PostScratch};
use super::resolve::{ResolveIn, ResolveRow, WINDOW_ROWS, Window, byte_row, plane, resolve_row};
use super::{TofOutput, TofTimings};
use crate::consts::{HEIGHT, PIXELS, WIDTH};
use crate::error::{Error, Result};
use crate::packet::{RawDepthPacket, unpack_row_values};
use crate::tables::DeviceTables;

const W: usize = WIDTH;
const ROWS_PER_BLOCK: usize = 16;
/// stage 1 planes: a0..2, b0..2, n0..2 (amplitude), na0..2, nb0..2
const P1: usize = 15;
/// The formats of the stage 1 planes.
const S1_CODECS: [Codec; P1] = {
    use formats::{AB, AMPLITUDE, DIRECTION};
    [AB, AB, AB, AB, AB, AB, AMPLITUDE, AMPLITUDE, AMPLITUDE, DIRECTION, DIRECTION, DIRECTION, DIRECTION, DIRECTION, DIRECTION]
};
/// The amplitude planes of stage 1, stored as n (n² spans more orders of magnitude than f16
/// holds: dim pixels lost their weight and jumped) and unpacked as squares (what the filters
/// compare).
const S1_AMPLITUDES: std::ops::Range<usize> = 6..9;
/// stage 2 planes (`resolve::plane`): extended u1, u2, gap, conf, csingle, ir_sum, anchor;
/// compat raw depth (in u1's place) and ir_sum
const P2: usize = 7;
/// The formats of the stage 2 planes (extended).
const S2_CODECS: [Codec; P2] = {
    use formats::{AMPLITUDE_SUM, CONFIDENCE, GAP, PHASE, U};
    [U, U, GAP, CONFIDENCE, PHASE, AMPLITUDE_SUM, CONFIDENCE]
};
/// stage 2 byte planes: edge_ok, kind, saturation bits
const P2B: usize = 3;
/// Rows of the largest ring a thread unpacks into: stage 2's five rows of every stage 1 plane,
/// or the resolver's window of two planes.
const RING_ROWS: usize = if P1 * 5 > 2 * WINDOW_ROWS { P1 * 5 } else { 2 * WINDOW_ROWS };

/// Derived per-device tables (depend on the device tables and the parameters); the GPU decoder
/// uploads the same.
pub(crate) struct Prepared {
    pub(crate) tables_id: u64,
    /// multiplier * cos(p0) per frequency ([`formats::TABLE`])
    pub(crate) mc: [Vec<u16>; 3],
    /// multiplier * sin(p0) per frequency ([`formats::TABLE`])
    pub(crate) ms: [Vec<u16>; 3],
    pub(crate) xt: Vec<f32>,
    pub(crate) zt: Vec<f32>,
    /// 1 / the relative illumination of each pixel (`illumination_angle`)
    pub(crate) illum: Vec<f32>,
    pub(crate) lut: [f32; 2048],
}

impl Prepared {
    pub(crate) fn new(t: &DeviceTables, cfg: &TofConfig) -> Prepared {
        let table = |k: usize, f: fn(f64) -> f64| -> Vec<u16> {
            let m = f64::from(cfg.params.ab_multiplier_per_frq.get(k).copied().unwrap_or(1.0));
            (0..PIXELS).map(|i| pack(formats::TABLE, (m * f(t.p0_phase(k, i))) as f32)).collect()
        };
        Prepared {
            tables_id: t.id,
            mc: std::array::from_fn(|k| table(k, f64::cos)),
            ms: std::array::from_fn(|k| table(k, f64::sin)),
            xt: t.xtable.clone(),
            zt: t.ztable.clone(),
            illum: t.rays.iter().map(|r| inverse_illumination(r, &cfg.ext) as f32).collect(),
            lut: t.lut,
        }
    }
}

/// 1 / the relative illumination along a ray (x, y, 1): 1 + (tan angle / tan half angle)^steepness.
pub fn inverse_illumination(ray: &[f32; 2], e: &super::ExtendedParams) -> f64 {
    if e.illumination_steepness <= 0.0 {
        return 1.0;
    }
    let tan = (f64::from(ray[0]).powi(2) + f64::from(ray[1]).powi(2)).sqrt();
    let half = f64::from(e.illumination_angle).to_radians().tan();
    1.0 + (tan / half).powf(f64::from(e.illumination_steepness))
}

/// Constants of stage 1 (shared with the GPU decoder).
pub(crate) fn s1_params(cfg: &TofConfig) -> S1Params {
    let p = &cfg.params;
    let e = &cfg.ext;
    S1Params {
        cos_t: p.phase_in_rad.map(f32::cos),
        sin_t: p.phase_in_rad.map(f32::sin),
        ir_scale: 0.333_333_33 * p.ab_multiplier * p.ab_output_multiplier,
        ir_lin: p.ab_multiplier * p.ab_output_multiplier,
        repair: e.repair_saturation,
        repair_lost: e.repair_lost,
        repair_ratio: e.repair_min_ratio,
        full_scale: e.full_scale_is_saturated,
        w_repaired: e.hdr_repaired_weight,
        gain: e.gain_correction.map(|g| 1.0 / g),
    }
}

/// Constants of stage 2 (shared with the GPU decoder).
pub(crate) fn s2_params(cfg: &TofConfig) -> S2Params {
    let p = &cfg.params;
    let e = &cfg.ext;
    S2Params {
        jb_threshold: (p.joint_bilateral_ab_threshold * p.joint_bilateral_ab_threshold) / (p.ab_multiplier * p.ab_multiplier),
        // libfreenect2's literal (not exactly LOG2_E): kept so Compat matches it
        #[allow(clippy::approx_constant)]
        jb_exp: -1.442_695 * p.joint_bilateral_exp,
        max_edge: p.joint_bilateral_max_edge,
        gauss: p.gaussian_kernel,
        bilateral: cfg.bilateral_filter,
        ab_multiplier: p.ab_multiplier,
        slope: p.ab_confidence_slope,
        conf_offset: p.ab_confidence_offset,
        min_conf: p.min_dealias_confidence,
        max_conf: p.max_dealias_confidence,
        individual_threshold: p.individual_ab_threshold,
        sum_threshold: p.ab_threshold,
        phase_offset: p.phase_offset,
        noise_coeff: e.noise_coeff.map(|c| c * e.noise_scale),
        noise_floor: e.noise_floor * e.noise_scale,
        min_amplitude: e.min_amplitude,
        weak_boost: e.weak_boost,
        weak_threshold: e.weak_threshold,
        inv_brightness: 1.0 / e.brightness_1m,
        ln_min_reflectivity: e.min_reflectivity.max(1e-30).ln(),
        ln_max_reflectivity: e.max_reflectivity.ln(),
        penalty_scale: if e.plausibility { 1.0 / e.plausibility_spread.ln().powi(2) } else { 0.0 },
        ir_output: p.ab_output_multiplier,
        multipath: e.multipath_check,
        gain: e.gain_correction.map(|g| 1.0 / g),
        amplitude_floor: e.amplitude_floor,
        multipath_tolerance: e.multipath_tolerance,
        two_echoes: e.two_echoes,
        echo_amplitude_floor: e.echo_amplitude_floor,
        echo_plausibility: e.echo_plausibility,
        margin_prior: e.margin_prior,
    }
}

/// Constants of the edge filter (shared with the GPU decoder).
pub(crate) fn edge_params(cfg: &TofConfig, extended: bool) -> EdgeParams {
    let p = &cfg.params;
    EdgeParams {
        min_depth: cfg.min_depth,
        max_depth: cfg.max_depth,
        enabled: cfg.edge_filter,
        avg_min: p.edge_ab_avg_min_value,
        std_threshold: p.edge_ab_std_dev_threshold,
        close: p.edge_close_delta_threshold,
        far: p.edge_far_delta_threshold,
        max_delta: p.edge_max_delta_threshold,
        avg_delta: p.edge_avg_delta_threshold,
        scale_mm: if extended { cfg.ext.edge_scale_mm } else { 0.0 },
    }
}

/// Constants of the extended finalization (shared with the GPU decoder).
pub(crate) fn s3_params(cfg: &TofConfig) -> S3Params {
    S3Params { min_conf: cfg.ext.min_confidence, speckle: cfg.ext.speckle_filter, speckle_min: cfg.ext.speckle_min_neighbors as f32 }
}

/// The serial steps of stage 3 that do not depend on each other: run as two tasks at once.
enum Serial<'a> {
    /// the smooth expectation of u for the resolver, from the confident pixels
    Expected { s2: &'a [u16], u: &'a mut Vec<f32>, w: &'a mut Vec<f32>, pp: &'a mut PushPull, anchored: &'a mut bool },
    /// the infrared where every frequency saturated
    FillIr { cfg: &'a TofConfig, ir: &'a mut [f32], flags: &'a [u32], level: &'a mut f32, scratch: &'a mut PostScratch, ms: &'a mut f64 },
}

impl Serial<'_> {
    fn run(self) {
        match self {
            Serial::Expected { s2, u, w, pp, anchored } => {
                // (sized once, then reused)
                u.resize(PIXELS, 0.0);
                w.resize(PIXELS, 0.0);
                for (y, (ur, wr)) in u.as_chunks_mut::<W>().0.iter_mut().zip(w.as_chunks_mut::<W>().0.iter_mut()).enumerate() {
                    if let (Some(us), Some(ws)) = (prow(s2, P2, y, plane::U1), prow(s2, P2, y, plane::ANCHOR)) {
                        unpack_row(formats::U, us, ur);
                        unpack_row(formats::CONFIDENCE, ws, wr);
                    }
                }
                *anchored = w.iter().any(|w| *w > 0.0);
                if *anchored {
                    pp.fill(u, w, W, HEIGHT);
                } else {
                    u.fill(0.0);
                }
            }
            Serial::FillIr { cfg, ir, flags, level, scratch, ms } => {
                let t = Instant::now();
                post::fill_ir(cfg, ir, flags, level, scratch);
                *ms = ms_since(t);
            }
        }
    }
}

/// Rows of some planes around the row being worked on, each unpacked once: while the rows of a
/// block are worked on from the top down, row `yy` of plane `p` lives in slot `yy % slots`
/// until a row `slots` further down replaces it.
#[derive(Default)]
struct Ring {
    data: Vec<f32>,
    planes: usize,
    slots: usize,
    /// the next row to unpack
    next: usize,
}

impl Ring {
    /// Starts a block: `planes` planes, room for `slots` rows, `first` the first row to unpack.
    fn start(&mut self, planes: usize, slots: usize, first: usize) {
        self.planes = planes;
        self.slots = slots.max(1);
        self.next = first;
        // (sized for the largest use when the decoder is made: grows only if a block asks more)
        let want = planes * self.slots * W;
        if self.data.len() < want {
            self.data.resize(want, 0.0);
        }
    }

    /// Unpacks the rows up to `last` (and not beyond the image) with `fill(row, plane, out)`.
    fn fill_to(&mut self, last: usize, fill: &mut dyn FnMut(usize, usize, &mut [f32])) {
        let last = last.min(HEIGHT - 1);
        while self.next <= last {
            let slot = self.next % self.slots;
            for p in 0..self.planes {
                let at = (p * self.slots + slot) * W;
                if let Some(out) = self.data.get_mut(at..at + W) {
                    fill(self.next, p, out);
                }
            }
            self.next += 1;
        }
    }

    /// Row `yy` of plane `p` (unpacked, and not replaced yet).
    fn row(&self, p: usize, yy: usize) -> Option<&Row> {
        let at = (p * self.slots + yy % self.slots) * W;
        self.data.get(at..at + W)?.try_into().ok()
    }
}

/// What one thread works in: the rows of its block, unpacked or before packing.
struct Scratch {
    ring: Ring,
    /// stage 1 output rows, before packing (P1 rows)
    s1_out: Vec<f32>,
    /// stage 1 table rows of the image row: mc0..2, ms0..2, valid
    tabs: Vec<f32>,
    /// stage 2 output rows, before packing (P2 rows)
    s2_out: Vec<f32>,
    /// other rows of the row being worked on (4 rows)
    cur: Vec<f32>,
}

impl Scratch {
    fn new() -> Scratch {
        let mut ring = Ring::default();
        ring.data.resize(RING_ROWS * W, 0.0);
        Scratch { ring, s1_out: vec![0.0; P1 * W], tabs: vec![0.0; 7 * W], s2_out: vec![0.0; P2 * W], cur: vec![0.0; 4 * W] }
    }
}

/// The CPU depth/infrared decoder (reusable, keeps its buffers and threads between frames: a
/// frame allocates nothing).
pub struct CpuDecoder {
    cfg: TofConfig,
    workers: Workers,
    describe: String,
    prep: Option<Prepared>,
    /// stage 1 planes, 16 bits each (`S1_CODECS`)
    s1: Vec<u16>,
    usable: Vec<u8>,
    flags: Vec<u32>,
    /// stage 2 planes, 16 bits each (`S2_CODECS`)
    s2: Vec<u16>,
    s2b: Vec<u8>,
    /// depth after the resolver ([`formats::DEPTH`]) and its confidence
    depth_res: Vec<u16>,
    conf_res: Vec<u16>,
    /// the resolver's expectation: input, weights, push-pull
    exp_u: Vec<f32>,
    exp_w: Vec<f32>,
    exp_pp: PushPull,
    post: PostScratch,
    /// estimated infrared level at which this sensor saturates (running, 0 = not yet seen)
    saturation_level: f32,
    /// one per thread
    scratch: Vec<Scratch>,
    /// the phase cost of the best distance per pixel (empty unless [`CpuDecoder::record_costs`])
    costs: Vec<f32>,
    /// the two-echo split (`two_echoes`): its inputs per pixel, the seeds' solutions (u1, u2;
    /// NaN where none)
    cands: Vec<echoes::Cand>,
    seeds: Vec<(f32, f32)>,
    /// how long the last frame took per phase
    pub timings: TofTimings,
}

/// The unwrapping of one pixel ([`CpuDecoder::unwrap_info`]).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct UnwrapInfo {
    /// best distance, as a fraction of the unambiguous range
    pub u1: f32,
    /// second best
    pub u2: f32,
    /// how much more the second best costs than the best
    pub gap: f32,
    /// the phase cost of the best (chi-square: the squared residuals over their variance; 0
    /// unless the decoder records costs)
    pub cost: f32,
    /// confidence 0..1
    pub confidence: f32,
    /// `kernels::kind` (single frequency: its index in bits 4..6)
    pub kind: u8,
    /// sum of the usable amplitudes (after the filter, times ab_multiplier)
    pub ir_sum: f32,
}

fn row<T>(buf: &[T], planes: usize, y: usize, p: usize) -> Option<&[T; W]> {
    let start = (y * planes + p) * W;
    buf.get(start..start + W)?.try_into().ok()
}

/// Row `y` of plane `p` of a row-interleaved 16-bit buffer of `planes` planes.
fn prow(buf: &[u16], planes: usize, y: usize, p: usize) -> Option<&[u16]> {
    let start = (y * planes + p) * W;
    buf.get(start..start + W)
}

fn row1(buf: &[f32], y: usize) -> Option<&Row> {
    buf.get(y * W..(y + 1) * W)?.try_into().ok()
}

/// The `P` rows of `W` of a row-interleaved block row.
fn split_row<T, const P: usize>(row: &mut [T]) -> Option<[&mut [T; W]; P]> {
    let (rows, _) = row.as_chunks_mut::<W>();
    let rows: &mut [[T; W]; P] = rows.get_mut(..P)?.try_into().ok()?;
    Some(rows.each_mut())
}

/// A block of rows of stage 2: first row, the 16-bit planes, the byte planes, the flags, and
/// the costs if they are recorded.
type S2Block<'a> = (usize, &'a mut [u16], &'a mut [u8], &'a mut [u32], Option<&'a mut [f32]>, Option<&'a mut [echoes::Cand]>);

/// A block of rows of the split pass: first row, the 16-bit planes, the byte planes, the flags,
/// the seeds' solutions.
type SplitBlock<'a> = (usize, &'a mut [u16], &'a mut [u8], &'a mut [u32], &'a mut [(f32, f32)]);

/// Writes a split into the stage 2 planes of a block where it replaces the single echo's
/// distance (`kernels::split_replaces`): the first echo, the second, the margin, the confidence,
/// no anchor, kind FIRST_ECHO, flag SECOND_ECHO. `i_in` = the pixel within the block.
fn write_split(s: &echoes::Split, near: f32, margin_prior: f32, s2: &mut [u16], s2b: &mut [u8], fl: &mut [u32], i_in: usize) {
    let Some(conf) = kernels::split_replaces(s, near, margin_prior) else { return };
    let (r, x) = (i_in / W, i_in % W);
    for (p, v) in [(plane::U1, s.u1), (plane::U2, s.u2), (plane::GAP, s.gap), (plane::CONF, conf), (plane::ANCHOR, 0.0)] {
        if let (Some(slot), Some(codec)) = (s2.get_mut((r * P2 + p) * W + x), S2_CODECS.get(p)) {
            *slot = pack(*codec, v);
        }
    }
    if let Some(k) = s2b.get_mut((r * P2B + plane::KIND) * W + x) {
        *k = kernels::kind::MULTI | kernels::kind::FIRST_ECHO;
    }
    if let Some(f) = fl.get_mut(i_in) {
        *f |= kernels::flags::SECOND_ECHO;
    }
}

/// The rows y-2 ..= y+2, clamped at the image border.
fn rows5(y: usize) -> [usize; 5] {
    [y.saturating_sub(2), y.saturating_sub(1), y, (y + 1).min(HEIGHT - 1), (y + 2).min(HEIGHT - 1)]
}

fn ms_since(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

impl CpuDecoder {
    /// A decoder with this configuration.
    pub fn new(cfg: TofConfig) -> Result<CpuDecoder> {
        cfg.validate()?;
        let workers = Workers::new(thread_count(cfg.threads));
        let describe = format!(
            "cpu {}, {} threads, {}",
            super::simd::detected().name(),
            workers.threads(),
            match cfg.mode {
                TofMode::Compat => "compat",
                TofMode::Extended => "extended",
            }
        );
        let scratch = (0..workers.threads()).map(|_| Scratch::new()).collect();
        let cfg_two_echoes = cfg.mode == TofMode::Extended && cfg.ext.two_echoes;
        Ok(CpuDecoder {
            workers,
            describe,
            cfg,
            prep: None,
            s1: vec![0; PIXELS * P1],
            usable: vec![0; PIXELS],
            flags: vec![0; PIXELS],
            s2: vec![0; PIXELS * P2],
            s2b: vec![0; PIXELS * P2B],
            depth_res: vec![0; PIXELS],
            conf_res: vec![0; PIXELS],
            exp_u: Vec::new(),
            exp_w: Vec::new(),
            exp_pp: PushPull::new(),
            post: PostScratch::default(),
            saturation_level: 0.0,
            scratch,
            costs: Vec::new(),
            cands: if cfg_two_echoes { vec![echoes::Cand::default(); PIXELS] } else { Vec::new() },
            seeds: if cfg_two_echoes { vec![(f32::NAN, f32::NAN); PIXELS] } else { Vec::new() },
            timings: TofTimings::default(),
        })
    }

    /// Keeps the phase cost of the best distance of every pixel for [`CpuDecoder::unwrap_info`]
    /// (extended mode; for analysis tools, it costs a little time).
    pub fn record_costs(&mut self, on: bool) {
        self.costs = if on { vec![0.0; PIXELS] } else { Vec::new() };
    }

    /// What the unwrapping decided at pixel `i` in the last decoded frame (extended mode), before
    /// the neighbors and the filters: for analysis tools.
    pub fn unwrap_info(&self, i: usize) -> Option<UnwrapInfo> {
        if self.cfg.mode != TofMode::Extended || i >= PIXELS {
            return None;
        }
        let (y, x) = (i / W, i % W);
        let get = |p: usize| self.s2.get((y * P2 + p) * W + x).zip(S2_CODECS.get(p)).map(|(v, c)| unpack(*c, *v));
        Some(UnwrapInfo {
            u1: get(plane::U1)?,
            u2: get(plane::U2)?,
            gap: get(plane::GAP)?,
            cost: self.costs.get(i).copied().unwrap_or(0.0),
            confidence: get(plane::CONF)?,
            kind: self.s2b.get((y * P2B + plane::KIND) * W + x).copied()?,
            ir_sum: get(plane::IR_SUM)?,
        })
    }

    /// The configuration.
    pub fn config(&self) -> &TofConfig {
        &self.cfg
    }

    /// Threads in use.
    pub fn threads(&self) -> usize {
        self.workers.threads()
    }

    /// "cpu avx2+fma, 4 threads, extended"
    pub fn describe(&self) -> &str {
        &self.describe
    }

    /// The complex value (a, b) of frequency `k` (0 = 80, 1 = 16, 2 = 120 MHz) at pixel `i` in the
    /// last decoded frame, before any filter: for analysis tools (noise, gains).
    pub fn sample(&self, k: usize, i: usize) -> Option<(f32, f32)> {
        if k >= 3 || i >= PIXELS {
            return None;
        }
        let (y, x) = (i / W, i % W);
        let a = self.s1.get((y * P1 + k) * W + x)?;
        let b = self.s1.get((y * P1 + 3 + k) * W + x)?;
        Some((unpack(formats::AB, *a), unpack(formats::AB, *b)))
    }

    /// Decodes one packet into `out` (its planes are resized as needed).
    pub fn decode(&mut self, packet: &RawDepthPacket, tables: &Arc<DeviceTables>, out: &mut TofOutput) -> Result<()> {
        if packet.data.len() < crate::consts::PACKET_BYTES {
            return Err(Error::invalid("raw depth packet too short"));
        }
        if self.prep.as_ref().is_none_or(|p| p.tables_id != tables.id) {
            self.prep = Some(Prepared::new(tables, &self.cfg));
        }
        out.resize();
        out.sequence = packet.sequence;
        out.timestamp = packet.timestamp;
        let t0 = Instant::now();
        self.timings.fill_ms = 0.0;
        self.timings.split_ms = 0.0;
        self.stage1(packet, out)?;
        self.timings.stage1_ms = ms_since(t0);
        let t1 = Instant::now();
        self.stage2()?;
        if self.cfg.mode == TofMode::Extended && self.cfg.ext.two_echoes {
            let ts = Instant::now();
            self.split_pass()?;
            self.timings.split_ms = ms_since(ts);
        }
        self.timings.stage2_ms = ms_since(t1);
        let t2 = Instant::now();
        match self.cfg.mode {
            TofMode::Compat => self.stage3_compat(out)?,
            TofMode::Extended => self.stage3_extended(out)?,
        }
        out.flags.copy_from_slice(&self.flags);
        if self.cfg.mode == TofMode::Extended && self.cfg.ext.fill_saturated_depth {
            post::fill_saturated_depth(&self.cfg, &mut out.depth, &mut out.confidence, &mut out.flags, &mut self.post, Some(&self.workers))?;
        }
        self.timings.stage3_ms = ms_since(t2);
        self.timings.total_ms = ms_since(t0);
        Ok(())
    }

    fn stage1(&mut self, packet: &RawDepthPacket, out: &mut TofOutput) -> Result<()> {
        let prep = self.prep.as_ref().ok_or_else(|| Error::invalid("tables not loaded"))?;
        let p = s1_params(&self.cfg);
        let extended = self.cfg.mode == TofMode::Extended;
        let blocks = self
            .s1
            .chunks_mut(W * P1 * ROWS_PER_BLOCK)
            .zip(out.ir.chunks_mut(W * ROWS_PER_BLOCK))
            .zip(self.usable.chunks_mut(W * ROWS_PER_BLOCK))
            .zip(self.flags.chunks_mut(W * ROWS_PER_BLOCK))
            .enumerate()
            .map(|(b, (((s1, ir), us), fl))| (b * ROWS_PER_BLOCK, s1, ir, us, fl));
        let work = |sc: &mut Scratch, (y0, s1, ir, us, fl): (usize, &mut [u16], &mut [f32], &mut [u8], &mut [u32])| {
            let Scratch { s1_out, tabs, .. } = sc;
            let mut vals = [[0f32; W]; 9];
            for ((r, s1row), ((ir, usable), flags)) in s1
                .as_chunks_mut::<{ W * P1 }>()
                .0
                .iter_mut()
                .enumerate()
                .zip(ir.as_chunks_mut::<W>().0.iter_mut().zip(us.as_chunks_mut::<W>().0.iter_mut()).zip(fl.as_chunks_mut::<W>().0.iter_mut()))
            {
                let y = y0 + r;
                let mut sub_ok = [false; 9];
                for ((s, v), so) in vals.iter_mut().enumerate().zip(sub_ok.iter_mut()) {
                    let ok = packet.row_ok(s, y);
                    *so = ok;
                    match packet.row_bytes(s, y).filter(|_| ok) {
                        Some(bytes) => unpack_row_values(bytes, &prep.lut, v),
                        None => v.fill(0.0),
                    }
                }
                let [s0, s1, s2, s3, s4, s5, s6, s7, s8] = sub_ok;
                let freq_ok = [s0 && s1 && s2, s3 && s4 && s5, s6 && s7 && s8];
                // the tables of the row: m cos(p0), m sin(p0) per frequency, and 1 where the
                // pixel has a z table entry
                // (the frame's planes are reused: a row that cannot be decoded is zeroed, never
                // left with an older frame's values; none of this fails with planes of the
                // right size)
                let span = y * W..(y + 1) * W;
                let mut have_tabs = true;
                for (t, packed) in tabs.as_chunks_mut::<W>().0.iter_mut().zip(prep.mc.iter().chain(&prep.ms)) {
                    match packed.get(span.clone()) {
                        Some(src) => unpack_row(formats::TABLE, src, t),
                        None => have_tabs = false,
                    }
                }
                let (Some(zt), Some(valid)) = (prep.zt.get(span), tabs.get_mut(6 * W..7 * W)) else { continue };
                for (v, z) in valid.iter_mut().zip(zt) {
                    *v = if *z > 0.0 { 1.0 } else { 0.0 };
                }
                let Some([mc0, mc1, mc2, ms0, ms1, ms2, valid]) = split_row::<f32, 7>(tabs).filter(|_| have_tabs) else {
                    ir.fill(0.0);
                    usable.fill(0);
                    continue;
                };
                let tabs_row = S1Tabs { mc: [mc0, mc1, mc2], ms: [ms0, ms1, ms2], valid };
                let Some([a0, a1, a2, b0, b1, b2, n0, n1, n2, na0, na1, na2, nb0, nb1, nb2]) = split_row::<f32, P1>(s1_out) else {
                    ir.fill(0.0);
                    usable.fill(0);
                    continue;
                };
                let mut o = S1Out { a: [a0, a1, a2], b: [b0, b1, b2], n: [n0, n1, n2], na: [na0, na1, na2], nb: [nb0, nb1, nb2], ir, usable, flags };
                if extended {
                    kernels::stage1_extended(&vals, sub_ok, &tabs_row, &mut o, &p);
                } else {
                    kernels::stage1_compat(&vals, freq_ok, &tabs_row, &mut o, &p);
                }
                for ((src, dst), codec) in s1_out.as_chunks::<W>().0.iter().zip(s1row.as_chunks_mut::<W>().0.iter_mut()).zip(S1_CODECS) {
                    pack_row(codec, src, dst);
                }
            }
        };
        self.workers.for_each_with(&mut self.scratch, blocks, &work)
    }

    fn stage2(&mut self) -> Result<()> {
        let prep = self.prep.as_ref().ok_or_else(|| Error::invalid("tables not loaded"))?;
        let p = s2_params(&self.cfg);
        let extended = self.cfg.mode == TofMode::Extended;
        let s1 = &self.s1;
        let usable = &self.usable;
        // the costs only where they are recorded (empty: none for every block)
        let costs = self.costs.chunks_mut(W * ROWS_PER_BLOCK).map(Some).chain(std::iter::repeat_with(|| None));
        let cands = self.cands.chunks_mut(W * ROWS_PER_BLOCK).map(Some).chain(std::iter::repeat_with(|| None));
        let blocks = self
            .s2
            .chunks_mut(W * P2 * ROWS_PER_BLOCK)
            .zip(self.s2b.chunks_mut(W * P2B * ROWS_PER_BLOCK))
            .zip(self.flags.chunks_mut(W * ROWS_PER_BLOCK))
            .zip(costs)
            .zip(cands)
            .enumerate()
            .map(|(b, ((((s2, s2b), fl), cost), cand))| (b * ROWS_PER_BLOCK, s2, s2b, fl, cost, cand));
        let work = |sc: &mut Scratch, (y0, s2, s2b, fl, mut cost, mut cand): S2Block| {
            let Scratch { ring, s2_out, .. } = sc;
            // the five rows around each row of every stage 1 plane; the amplitudes as squares
            ring.start(P1, 5, y0.saturating_sub(2));
            let mut unpack_s1 = |yy: usize, p: usize, out: &mut [f32]| {
                if let (Some(src), Some(codec)) = (prow(s1, P1, yy, p), S1_CODECS.get(p)) {
                    unpack_row(*codec, src, out);
                    if S1_AMPLITUDES.contains(&p) {
                        for v in out.iter_mut() {
                            *v *= *v;
                        }
                    }
                }
            };
            let rows = s2.as_chunks_mut::<{ W * P2 }>().0.iter_mut().zip(s2b.as_chunks_mut::<{ W * P2B }>().0.iter_mut().zip(fl.as_chunks_mut::<W>().0.iter_mut()));
            for (r, (s2row, (s2brow, flags))) in rows.enumerate() {
                let y = y0 + r;
                ring.fill_to(y + 2, &mut unpack_s1);
                let ys = rows5(y);
                let five = |plane: usize| -> Option<[&Row; 5]> {
                    Some([ring.row(plane, ys[0])?, ring.row(plane, ys[1])?, ring.row(plane, ys[2])?, ring.row(plane, ys[3])?, ring.row(plane, ys[4])?])
                };
                let urow = |yy: usize| -> Option<&RowU8> { usable.get(yy * W..(yy + 1) * W)?.try_into().ok() };
                let pl: [Option<[&Row; 5]>; P1] = std::array::from_fn(five);
                let us5 = [urow(ys[0]), urow(ys[1]), urow(ys[2]), urow(ys[3]), urow(ys[4])];
                let [Some(u0), Some(u1), Some(u2), Some(u3), Some(u4)] = us5 else { continue };
                let (Some(xt), Some(zt), Some(illum)) = (row1(&prep.xt, y), row1(&prep.zt, y), row1(&prep.illum, y)) else { continue };
                let g = |i: usize| pl.get(i).copied().flatten();
                let (Some(a0), Some(a1), Some(a2), Some(b0), Some(b1), Some(b2), Some(n0), Some(n1), Some(n2)) = (g(0), g(1), g(2), g(3), g(4), g(5), g(6), g(7), g(8)) else { continue };
                let (Some(na0), Some(na1), Some(na2), Some(nb0), Some(nb1), Some(nb2)) = (g(9), g(10), g(11), g(12), g(13), g(14)) else { continue };
                let input = S2In {
                    y,
                    a: [a0, a1, a2],
                    b: [b0, b1, b2],
                    n2: [n0, n1, n2],
                    na: [na0, na1, na2],
                    nb: [nb0, nb1, nb2],
                    usable: [u0, u1, u2, u3, u4],
                    xt,
                    zt,
                    illum,
                };
                let Some([f0, f1, f2, f3, f4, f5, f6]) = split_row::<f32, P2>(s2_out) else { continue };
                let Some([edge_ok, kind, sat]) = split_row::<u8, P2B>(s2brow) else { continue };
                if extended {
                    let cost = cost.as_deref_mut().and_then(|c| c.get_mut(r * W..(r + 1) * W)).and_then(|c| <&mut Row>::try_from(c).ok());
                    let cands = cand.as_deref_mut().and_then(|c| c.get_mut(r * W..(r + 1) * W));
                    let mut o = S2OutExt { u1: f0, u2: f1, gap: f2, cost, conf: f3, csingle: f4, ir_sum: f5, anchor: f6, kind, edge_ok, sat, flags, cands };
                    kernels::stage2_extended(&input, &p, &mut o);
                    for ((src, dst), codec) in s2_out.as_chunks::<W>().0.iter().zip(s2row.as_chunks_mut::<W>().0.iter_mut()).zip(S2_CODECS) {
                        pack_row(codec, src, dst);
                    }
                } else {
                    let mut o = S2OutCompat { raw_depth: f0, ir_sum: f5, edge_ok };
                    kernels::stage2_compat(&input, &p, &mut o);
                    for (plane, codec) in [(plane::RAW_DEPTH, formats::DEPTH), (plane::IR_SUM, formats::AMPLITUDE_SUM)] {
                        if let (Some(src), Some(dst)) = (s2_out.get(plane * W..(plane + 1) * W), s2row.get_mut(plane * W..(plane + 1) * W)) {
                            pack_row(codec, src, dst);
                        }
                    }
                }
            }
        };
        self.workers.for_each_with(&mut self.scratch, blocks, &work)
    }

    /// The two-echo split of the pixels stage 2 collected: first the seeds (the whole search),
    /// then the pixels between them (from the seeds' solutions). A split that replaces the single
    /// echo's distance is written into the stage 2 planes.
    fn split_pass(&mut self) -> Result<()> {
        let margin_prior = self.cfg.ext.margin_prior;
        let cands = &self.cands;
        // the seeds
        {
            let blocks = self
                .s2
                .chunks_mut(W * P2 * ROWS_PER_BLOCK)
                .zip(self.s2b.chunks_mut(W * P2B * ROWS_PER_BLOCK))
                .zip(self.flags.chunks_mut(W * ROWS_PER_BLOCK))
                .zip(self.seeds.chunks_mut(W * ROWS_PER_BLOCK))
                .enumerate()
                .map(|(b, (((s2, s2b), fl), sd))| (b * ROWS_PER_BLOCK, s2, s2b, fl, sd));
            let work = |_: &mut Scratch, (y0, s2, s2b, fl, sd): SplitBlock| {
                // eight seeds at a time
                let mut batch = [echoes::Cand::default(); LANES];
                let mut at = [0usize; LANES];
                let mut n = 0;
                let run = |batch: &mut [echoes::Cand; LANES], at: &[usize; LANES], n: usize, s2: &mut [u16], s2b: &mut [u8], fl: &mut [u32], sd: &mut [(f32, f32)]| {
                    for b in batch.iter_mut().skip(n) {
                        b.on = false;
                    }
                    let res = echoes::split_seeds(batch);
                    for ((r, &i_in), c) in res.iter().zip(at).zip(batch.iter()).take(n) {
                        if let Some(s) = r {
                            if let Some(slot) = sd.get_mut(i_in) {
                                *slot = (s.u1, s.u2);
                            }
                            write_split(s, c.near, margin_prior, s2, s2b, fl, i_in);
                        }
                    }
                };
                sd.fill((f32::NAN, f32::NAN));
                for i_in in 0..fl.len() {
                    let (y, x) = (y0 + i_in / W, i_in % W);
                    if x % echoes::SEED_STEP != 0 || y % echoes::SEED_STEP != 0 {
                        continue;
                    }
                    let Some(c) = cands.get(y * W + x).filter(|c| c.on) else { continue };
                    if let (Some(bc), Some(ba)) = (batch.get_mut(n), at.get_mut(n)) {
                        (*bc, *ba) = (*c, i_in);
                    }
                    n += 1;
                    if n == LANES {
                        run(&mut batch, &at, n, s2, s2b, fl, sd);
                        n = 0;
                    }
                }
                if n > 0 {
                    run(&mut batch, &at, n, s2, s2b, fl, sd);
                }
            };
            self.workers.for_each_with(&mut self.scratch, blocks, &work)?;
        }
        let seeds_done = &self.seeds;
        // the pixels between
        let blocks = self
            .s2
            .chunks_mut(W * P2 * ROWS_PER_BLOCK)
            .zip(self.s2b.chunks_mut(W * P2B * ROWS_PER_BLOCK))
            .zip(self.flags.chunks_mut(W * ROWS_PER_BLOCK))
            .enumerate()
            .map(|(b, ((s2, s2b), fl))| (b * ROWS_PER_BLOCK, s2, s2b, fl));
        let work = |_: &mut Scratch, (y0, s2, s2b, fl): (usize, &mut [u16], &mut [u8], &mut [u32])| {
            let step = echoes::SEED_STEP;
            // eight pixels at a time: their inputs, the seeds' solutions around them
            let mut batch = [echoes::Cand::default(); LANES];
            let mut at = [0usize; LANES];
            let mut starts = [[(0f32, 0f32); 4]; LANES];
            let mut count = [0usize; LANES];
            let mut n = 0;
            let run = |batch: &mut [echoes::Cand; LANES], at: &[usize; LANES], starts: &[[(f32, f32); 4]; LANES], count: &[usize; LANES], n: usize, s2: &mut [u16], s2b: &mut [u8], fl: &mut [u32]| {
                for b in batch.iter_mut().skip(n) {
                    b.on = false;
                }
                let res = echoes::split_between(batch, starts, count);
                for ((r, &i_in), c) in res.iter().zip(at).zip(batch.iter()).take(n) {
                    if let Some(s) = r {
                        write_split(s, c.near, margin_prior, s2, s2b, fl, i_in);
                    }
                }
            };
            for i_in in 0..fl.len() {
                let (y, x) = (y0 + i_in / W, i_in % W);
                if x % step == 0 && y % step == 0 {
                    continue;
                }
                let Some(c) = cands.get(y * W + x).filter(|c| c.on) else { continue };
                // the seeds around: the lattice points of the cell, else of the ring around it
                let (x0, ys) = (x - x % step, y - y % step);
                let mut k = 0;
                const CELL: [(isize, isize); 4] = [(0, 0), (1, 0), (0, 1), (1, 1)];
                const RING: [(isize, isize); 12] = [(-1, -1), (0, -1), (1, -1), (2, -1), (-1, 0), (2, 0), (-1, 1), (2, 1), (-1, 2), (0, 2), (1, 2), (2, 2)];
                for (idx, (dx, dy)) in CELL.iter().chain(RING.iter()).enumerate() {
                    // the ring only where the cell has no seed with a solution
                    if k == 4 || (idx == CELL.len() && k > 0) {
                        break;
                    }
                    let (sx, sy) = (x0 as isize + dx * step as isize, ys as isize + dy * step as isize);
                    if sx < 0 || sy < 0 || sx >= W as isize || sy >= HEIGHT as isize {
                        continue;
                    }
                    let (sx, sy) = (sx as usize, sy as usize);
                    if let Some(&(u1, u2)) = seeds_done.get(sy * W + sx).filter(|v| v.0.is_finite())
                        && let Some(slot) = starts.get_mut(n).and_then(|st| st.get_mut(k))
                    {
                        *slot = (u1, u2);
                        k += 1;
                    }
                }
                if let (Some(bc), Some(ba), Some(bn)) = (batch.get_mut(n), at.get_mut(n), count.get_mut(n)) {
                    (*bc, *ba, *bn) = (*c, i_in, k);
                }
                n += 1;
                if n == LANES {
                    run(&mut batch, &at, &starts, &count, n, s2, s2b, fl);
                    n = 0;
                }
            }
            if n > 0 {
                run(&mut batch, &at, &starts, &count, n, s2, s2b, fl);
            }
        };
        self.workers.for_each_with(&mut self.scratch, blocks, &work)
    }

    fn stage3_compat(&mut self, out: &mut TofOutput) -> Result<()> {
        let e = edge_params(&self.cfg, false);
        let s2 = &self.s2;
        let s2b = &self.s2b;
        let blocks = out
            .depth
            .chunks_mut(W * ROWS_PER_BLOCK)
            .zip(out.confidence.chunks_mut(W * ROWS_PER_BLOCK))
            .enumerate()
            .map(|(b, (d, c))| (b * ROWS_PER_BLOCK, d, c));
        let work = |sc: &mut Scratch, (y0, d, c): (usize, &mut [f32], &mut [f32])| {
            let ring = &mut sc.ring;
            // the depth and the amplitude sums of the rows around
            ring.start(2, 3, y0.saturating_sub(1));
            let mut unpack_s2 = |yy: usize, p: usize, out: &mut [f32]| {
                let (plane, codec) = if p == 0 { (plane::RAW_DEPTH, formats::DEPTH) } else { (plane::IR_SUM, formats::AMPLITUDE_SUM) };
                if let Some(src) = prow(s2, P2, yy, plane) {
                    unpack_row(codec, src, out);
                }
            };
            for (r, (drow, crow)) in d.as_chunks_mut::<W>().0.iter_mut().zip(c.as_chunks_mut::<W>().0.iter_mut()).enumerate() {
                let y = y0 + r;
                ring.fill_to(y + 1, &mut unpack_s2);
                let (ya, yc) = (y.saturating_sub(1), (y + 1).min(HEIGHT - 1));
                let (Some(d0), Some(d1), Some(d2), Some(s0), Some(s1), Some(s2r), Some(edge)) =
                    (ring.row(0, ya), ring.row(0, y), ring.row(0, yc), ring.row(1, ya), ring.row(1, y), ring.row(1, yc), row(s2b, P2B, y, plane::EDGE_OK))
                else {
                    drow.fill(0.0);
                    crow.fill(0.0);
                    continue;
                };
                kernels::stage3_compat(y, [d0, d1, d2], [s0, s1, s2r], edge, &e, drow);
                for (cv, dv) in crow.iter_mut().zip(drow.iter()) {
                    *cv = if *dv > 0.0 { 1.0 } else { 0.0 };
                }
            }
        };
        self.workers.for_each_with(&mut self.scratch, blocks, &work)
    }

    fn stage3_extended(&mut self, out: &mut TofOutput) -> Result<()> {
        let prep = self.prep.as_ref().ok_or_else(|| Error::invalid("tables not loaded"))?;
        // smooth expectation of u from the confident pixels, for large areas where only one
        // frequency is usable (a saturated hand): only computed when such pixels exist
        // (the planes are row-interleaved: whole rows at a time)
        let kind_rows = self.s2b.as_chunks::<{ W * P2B }>().0.iter().filter_map(|r| r.get(W..2 * W));
        let singles = kind_rows.flatten().filter(|k| **k & 0x0f == kernels::kind::SINGLE).count();
        let want_expected = self.cfg.ext.spatial_resolve && singles > 0;
        // meanwhile the clipped infrared is filled (it needs only what stage 1 decided): both
        // are serial, so they run side by side
        let mut anchored = false;
        let tasks = [
            want_expected.then_some(Serial::Expected { s2: &self.s2, u: &mut self.exp_u, w: &mut self.exp_w, pp: &mut self.exp_pp, anchored: &mut anchored }),
            self.cfg.ext.ir_fill_clipped.then_some(Serial::FillIr {
                cfg: &self.cfg,
                ir: &mut out.ir,
                flags: &self.flags,
                level: &mut self.saturation_level,
                scratch: &mut self.post,
                ms: &mut self.timings.fill_ms,
            }),
        ];
        self.workers.for_each(tasks.into_iter().flatten(), &Serial::run)?;
        let expected: &[f32] = match (want_expected, anchored) {
            (true, true) => self.exp_pp.result(),
            // no anchor anywhere: an expectation of 0 everywhere
            (true, false) => &self.exp_u,
            (false, _) => &[],
        };
        let spatial = self.cfg.ext.spatial_resolve;
        let resolve = ResolveIn {
            s2b: &self.s2b,
            p2b: P2B,
            expected,
            xt: &prep.xt,
            zt: &prep.zt,
            radius: if spatial { self.cfg.ext.spatial_radius.min(WINDOW_ROWS / 2) } else { 0 },
            near_prior_mm: self.cfg.ext.near_prior_mm,
            min_conf: self.cfg.ext.min_confidence,
        };
        let s2 = &self.s2;
        // 3a: resolve
        let blocks = self
            .depth_res
            .chunks_mut(W * ROWS_PER_BLOCK)
            .zip(self.conf_res.chunks_mut(W * ROWS_PER_BLOCK))
            .zip(self.flags.chunks_mut(W * ROWS_PER_BLOCK))
            .enumerate()
            .map(|(b, ((d, c), f))| (b * ROWS_PER_BLOCK, d, c, f));
        let work = |sc: &mut Scratch, (y0, d, c, f): (usize, &mut [u16], &mut [u16], &mut [u32])| {
            let Scratch { ring, cur, s2_out, .. } = sc;
            let r = resolve.radius;
            // u1 and the anchor weights of the window rows
            ring.start(2, 2 * r + 1, y0.saturating_sub(r));
            let mut unpack_window = |yy: usize, p: usize, out: &mut [f32]| {
                let (plane, codec) = if p == 0 { (plane::U1, formats::U) } else { (plane::ANCHOR, formats::CONFIDENCE) };
                if let Some(src) = prow(s2, P2, yy, plane) {
                    unpack_row(codec, src, out);
                }
            };
            let rows = d.as_chunks_mut::<W>().0.iter_mut().zip(c.as_chunks_mut::<W>().0.iter_mut()).zip(f.as_chunks_mut::<W>().0.iter_mut());
            for (r_in_block, ((drow, crow), fl)) in rows.enumerate() {
                let y = y0 + r_in_block;
                ring.fill_to(y + r, &mut unpack_window);
                // the row's other planes: u2, gap, conf, csingle
                for (out_row, (plane, codec)) in cur.as_chunks_mut::<W>().0.iter_mut().zip([
                    (plane::U2, formats::U),
                    (plane::GAP, formats::GAP),
                    (plane::CONF, formats::CONFIDENCE),
                    (plane::CSINGLE, formats::PHASE),
                ]) {
                    if let Some(src) = prow(s2, P2, y, plane) {
                        unpack_row(codec, src, out_row);
                    }
                }
                let (Some(u1), Some(anchor)) = (ring.row(0, y), ring.row(1, y)) else { continue };
                let Some([u2, gap, conf, csingle]) = split_row::<f32, 4>(cur) else { continue };
                let Some([dout, cout, ..]) = split_row::<f32, P2>(s2_out) else { continue };
                if spatial {
                    let mut window = Window::new();
                    for yy in y.saturating_sub(r)..=(y + r).min(HEIGHT - 1) {
                        if let (Some(u), Some(a), Some(sat), Some(kd)) = (ring.row(0, yy), ring.row(1, yy), byte_row(&resolve, plane::SAT, yy), byte_row(&resolve, plane::KIND, yy)) {
                            window.push(u, a, sat, kd);
                        }
                    }
                    let row_in = ResolveRow { u1, u2, gap, conf, csingle, anchor };
                    resolve_row(&resolve, y, &row_in, &window, dout, cout, fl);
                } else {
                    // no neighbors: multi-frequency results as they are, single ones dropped
                    let (Some(kr), Some(xt), Some(zt)) = (row(&self.s2b, P2B, y, plane::KIND), row1(&prep.xt, y), row1(&prep.zt, y)) else { continue };
                    for x in 0..W {
                        let k = kr.get(x).copied().unwrap_or(0) & 0x0f;
                        let cv = if k == kernels::kind::MULTI { conf.get(x).copied().unwrap_or(0.0) } else { 0.0 };
                        let dv = kernels::depth_of_u(u1.get(x).copied().unwrap_or(0.0), xt.get(x).copied().unwrap_or(0.0), zt.get(x).copied().unwrap_or(0.0));
                        if let (Some(dd), Some(cc)) = (dout.get_mut(x), cout.get_mut(x)) {
                            *dd = if cv > 0.0 { dv } else { 0.0 };
                            *cc = cv;
                        }
                    }
                }
                pack_row(formats::DEPTH, dout, drow);
                pack_row(formats::CONFIDENCE, cout, crow);
            }
        };
        self.workers.for_each_with(&mut self.scratch, blocks, &work)?;
        // 3b: edge filter, speckle filter, range, confidence threshold
        let e = edge_params(&self.cfg, true);
        let q = s3_params(&self.cfg);
        let (dres, cres, s2b) = (&self.depth_res, &self.conf_res, &self.s2b);
        let blocks = out
            .depth
            .chunks_mut(W * ROWS_PER_BLOCK)
            .zip(out.confidence.chunks_mut(W * ROWS_PER_BLOCK))
            .zip(self.flags.chunks_mut(W * ROWS_PER_BLOCK))
            .enumerate()
            .map(|(b, ((d, c), f))| (b * ROWS_PER_BLOCK, d, c, f));
        let work = |sc: &mut Scratch, (y0, d, c, f): (usize, &mut [f32], &mut [f32], &mut [u32])| {
            let Scratch { ring, cur, .. } = sc;
            // the resolved depth and the amplitude sums of the rows around
            ring.start(2, 5, y0.saturating_sub(2));
            let mut unpack_rows = |yy: usize, p: usize, out: &mut [f32]| {
                let src = if p == 0 { dres.get(yy * W..(yy + 1) * W) } else { prow(s2, P2, yy, plane::IR_SUM) };
                if let Some(src) = src {
                    unpack_row(if p == 0 { formats::DEPTH } else { formats::AMPLITUDE_SUM }, src, out);
                }
            };
            let rows = d.as_chunks_mut::<W>().0.iter_mut().zip(c.as_chunks_mut::<W>().0.iter_mut()).zip(f.as_chunks_mut::<W>().0.iter_mut());
            for (r, ((drow, crow), fl)) in rows.enumerate() {
                let y = y0 + r;
                ring.fill_to(y + 2, &mut unpack_rows);
                let Some(conf_row) = cur.get_mut(..W) else { continue };
                if let Some(src) = cres.get(y * W..(y + 1) * W) {
                    unpack_row(formats::CONFIDENCE, src, conf_row);
                }
                let ys = rows5(y);
                let (Some(d0), Some(d1), Some(d2), Some(d3), Some(d4)) = (ring.row(0, ys[0]), ring.row(0, ys[1]), ring.row(0, y), ring.row(0, ys[3]), ring.row(0, ys[4])) else {
                    drow.fill(0.0);
                    crow.fill(0.0);
                    continue;
                };
                let (Some(s0), Some(s1), Some(s2r), Some(edge)) = (ring.row(1, ys[1]), ring.row(1, y), ring.row(1, ys[3]), row(s2b, P2B, y, plane::EDGE_OK)) else {
                    drow.fill(0.0);
                    crow.fill(0.0);
                    continue;
                };
                let Ok(cr) = <&Row>::try_from(&*conf_row) else { continue };
                let input = S3In { y, d: [d0, d1, d2, d3, d4], s: [s0, s1, s2r], edge_ok: edge, conf: cr };
                kernels::stage3_extended(&input, &e, &q, drow, crow, fl);
            }
        };
        self.workers.for_each_with(&mut self.scratch, blocks, &work)
    }
}
