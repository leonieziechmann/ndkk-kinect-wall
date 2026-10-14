//! The CPU decoder: raw depth packet -> depth, infrared, confidence, flags.
//!
//! Phases, each over all rows in blocks on a few threads:
//! 1. unpack the samples, complex value (a, b) per frequency, infrared
//! 2. bilateral filter, phase unwrapping
//! 3. (extended) neighbors resolve ambiguous pixels; edge filter, range, confidence
//! 4. (extended) clipped infrared is filled from its surroundings
//!
//! The intermediate planes of a phase are stored row-interleaved (row y holds all planes of the
//! phase one after the other), so one block of rows is one contiguous slice for every plane.

use std::sync::Arc;
use std::time::Instant;

use super::config::{TofConfig, TofMode};
use super::fill::push_pull;
use super::kernels::{
    self, EdgeParams, Row, RowFlags, RowU8, S1Out, S1Params, S1Tabs, S2In, S2OutCompat, S2OutExt, S2Params, S3In, S3Params, flags,
};
use super::parallel::{for_each_block, thread_count};
use super::resolve::{ResolveIn, resolve_row};
use super::{TofOutput, TofTimings};
use crate::consts::{HEIGHT, PIXELS, WIDTH};
use crate::error::{Error, Result};
use crate::packet::{RawDepthPacket, unpack_row};
use crate::tables::DeviceTables;

const W: usize = WIDTH;
const ROWS_PER_BLOCK: usize = 8;
/// stage 1 planes: a0..2, b0..2, n0..2, na0..2, nb0..2
const P1: usize = 15;
/// stage 2 float planes: compat raw_depth, ir_sum; extended u1, u2, e1, e2, conf, csingle,
/// ir_sum, anchor
const P2: usize = 8;
/// stage 2 byte planes: edge_ok, kind, saturation bits
const P2B: usize = 3;

/// Derived per-device tables (depend on the device tables and the parameters).
struct Prepared {
    tables_id: u64,
    mc: [Vec<f32>; 3],
    ms: [Vec<f32>; 3],
    valid: Vec<f32>,
    xt: Vec<f32>,
    zt: Vec<f32>,
    lut: [f32; 2048],
}

impl Prepared {
    fn new(t: &DeviceTables, cfg: &TofConfig) -> Prepared {
        let mc = std::array::from_fn(|k| {
            let m = f64::from(cfg.params.ab_multiplier_per_frq.get(k).copied().unwrap_or(1.0));
            (0..PIXELS).map(|i| (m * t.p0_phase(k, i).cos()) as f32).collect()
        });
        let ms = std::array::from_fn(|k| {
            let m = f64::from(cfg.params.ab_multiplier_per_frq.get(k).copied().unwrap_or(1.0));
            (0..PIXELS).map(|i| (m * t.p0_phase(k, i).sin()) as f32).collect()
        });
        Prepared {
            tables_id: t.id,
            mc,
            ms,
            valid: t.ztable.iter().map(|z| if *z > 0.0 { 1.0 } else { 0.0 }).collect(),
            xt: t.xtable.clone(),
            zt: t.ztable.clone(),
            lut: t.lut,
        }
    }
}

/// The CPU depth/infrared decoder (reusable, keeps its buffers between frames).
pub struct CpuDecoder {
    cfg: TofConfig,
    threads: usize,
    prep: Option<Prepared>,
    s1: Vec<f32>,
    usable: Vec<u8>,
    flags: Vec<u32>,
    s2: Vec<f32>,
    s2b: Vec<u8>,
    depth_res: Vec<f32>,
    conf_res: Vec<f32>,
    /// estimated infrared level at which this sensor saturates (running, 0 = not yet seen)
    saturation_level: f32,
    /// how long the last frame took per phase
    pub timings: TofTimings,
}

fn row<T>(buf: &[T], planes: usize, y: usize, p: usize) -> Option<&[T; W]> {
    let start = (y * planes + p) * W;
    buf.get(start..start + W)?.try_into().ok()
}

fn row1(buf: &[f32], y: usize) -> Option<&Row> {
    buf.get(y * W..(y + 1) * W)?.try_into().ok()
}

fn split_row<T, const P: usize>(row: &mut [T]) -> Option<[&mut [T; W]; P]> {
    let v: Vec<&mut [T; W]> = row.chunks_exact_mut(W).take(P).filter_map(|c| c.try_into().ok()).collect();
    v.try_into().ok()
}

fn ms_since(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

impl CpuDecoder {
    /// A decoder with this configuration.
    pub fn new(cfg: TofConfig) -> Result<CpuDecoder> {
        cfg.validate()?;
        Ok(CpuDecoder {
            threads: thread_count(cfg.threads),
            cfg,
            prep: None,
            s1: vec![0.0; PIXELS * P1],
            usable: vec![0; PIXELS],
            flags: vec![0; PIXELS],
            s2: vec![0.0; PIXELS * P2],
            s2b: vec![0; PIXELS * P2B],
            depth_res: vec![0.0; PIXELS],
            conf_res: vec![0.0; PIXELS],
            saturation_level: 0.0,
            timings: TofTimings::default(),
        })
    }

    /// The configuration.
    pub fn config(&self) -> &TofConfig {
        &self.cfg
    }

    /// Threads in use.
    pub fn threads(&self) -> usize {
        self.threads
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
        self.stage1(packet, out)?;
        self.timings.stage1_ms = ms_since(t0);
        let t1 = Instant::now();
        self.stage2()?;
        self.timings.stage2_ms = ms_since(t1);
        let t2 = Instant::now();
        match self.cfg.mode {
            TofMode::Compat => self.stage3_compat(out)?,
            TofMode::Extended => self.stage3_extended(out)?,
        }
        self.timings.stage3_ms = ms_since(t2);
        let t3 = Instant::now();
        if self.cfg.mode == TofMode::Extended && self.cfg.ext.ir_fill_clipped {
            self.fill_ir(out);
        }
        out.flags.copy_from_slice(&self.flags);
        self.timings.fill_ms = ms_since(t3);
        self.timings.total_ms = ms_since(t0);
        Ok(())
    }

    fn s1_params(&self) -> S1Params {
        let p = &self.cfg.params;
        let e = &self.cfg.ext;
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

    fn stage1(&mut self, packet: &RawDepthPacket, out: &mut TofOutput) -> Result<()> {
        let prep = self.prep.as_ref().ok_or_else(|| Error::invalid("tables not loaded"))?;
        let p = self.s1_params();
        let extended = self.cfg.mode == TofMode::Extended;
        let blocks: Vec<_> = self
            .s1
            .chunks_mut(W * P1 * ROWS_PER_BLOCK)
            .zip(out.ir.chunks_mut(W * ROWS_PER_BLOCK))
            .zip(self.usable.chunks_mut(W * ROWS_PER_BLOCK))
            .zip(self.flags.chunks_mut(W * ROWS_PER_BLOCK))
            .enumerate()
            .map(|(b, (((s1, ir), us), fl))| (b * ROWS_PER_BLOCK, s1, ir, us, fl))
            .collect();
        let work = |(y0, s1, ir, us, fl): (usize, &mut [f32], &mut [f32], &mut [u8], &mut [u32])| {
            let mut codes = [0u16; W];
            let mut vals = [[0f32; W]; 9];
            for ((r, s1row), ((irrow, usrow), flrow)) in s1
                .chunks_exact_mut(W * P1)
                .enumerate()
                .zip(ir.chunks_exact_mut(W).zip(us.chunks_exact_mut(W)).zip(fl.chunks_exact_mut(W)))
            {
                let y = y0 + r;
                let mut sub_ok = [false; 9];
                for ((s, v), so) in vals.iter_mut().enumerate().zip(sub_ok.iter_mut()) {
                    let ok = packet.row_ok(s, y);
                    *so = ok;
                    match packet.row_bytes(s, y).filter(|_| ok) {
                        Some(bytes) => {
                            unpack_row(bytes, &mut codes);
                            for (o, c) in v.iter_mut().zip(codes.iter()) {
                                *o = prep.lut.get(usize::from(*c & 2047)).copied().unwrap_or(0.0);
                            }
                        }
                        None => v.fill(0.0),
                    }
                }
                let [s0, s1, s2, s3, s4, s5, s6, s7, s8] = sub_ok;
                let freq_ok = [s0 && s1 && s2, s3 && s4 && s5, s6 && s7 && s8];
                let (Some(mc0), Some(mc1), Some(mc2), Some(ms0), Some(ms1), Some(ms2), Some(valid)) =
                    (row1(&prep.mc[0], y), row1(&prep.mc[1], y), row1(&prep.mc[2], y), row1(&prep.ms[0], y), row1(&prep.ms[1], y), row1(&prep.ms[2], y), row1(&prep.valid, y))
                else {
                    continue;
                };
                let tabs = S1Tabs { mc: [mc0, mc1, mc2], ms: [ms0, ms1, ms2], valid };
                let Some([a0, a1, a2, b0, b1, b2, n0, n1, n2, na0, na1, na2, nb0, nb1, nb2]) = split_row::<f32, P1>(s1row) else { continue };
                let (Ok(ir), Ok(usable), Ok(flags)) = (<&mut Row>::try_from(irrow), <&mut RowU8>::try_from(usrow), <&mut RowFlags>::try_from(flrow)) else {
                    continue;
                };
                let mut o = S1Out { a: [a0, a1, a2], b: [b0, b1, b2], n: [n0, n1, n2], na: [na0, na1, na2], nb: [nb0, nb1, nb2], ir, usable, flags };
                if extended {
                    kernels::stage1_extended(&vals, sub_ok, &tabs, &mut o, &p);
                } else {
                    kernels::stage1_compat(&vals, freq_ok, &tabs, &mut o, &p);
                }
            }
        };
        for_each_block(self.threads, blocks, &work)
    }

    fn s2_params(&self) -> S2Params {
        let p = &self.cfg.params;
        let e = &self.cfg.ext;
        S2Params {
            jb_threshold: (p.joint_bilateral_ab_threshold * p.joint_bilateral_ab_threshold) / (p.ab_multiplier * p.ab_multiplier),
            // libfreenect2's literal (not exactly LOG2_E): kept so Compat matches it
            #[allow(clippy::approx_constant)]
            jb_exp: -1.442_695 * p.joint_bilateral_exp,
            max_edge: p.joint_bilateral_max_edge,
            gauss: p.gaussian_kernel,
            bilateral: self.cfg.bilateral_filter,
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
            plausibility: e.plausibility,
            inv_brightness: 1.0 / e.brightness_1m,
            min_reflectivity: e.min_reflectivity,
            max_reflectivity: e.max_reflectivity,
            ir_output: p.ab_output_multiplier,
        }
    }

    fn stage2(&mut self) -> Result<()> {
        let prep = self.prep.as_ref().ok_or_else(|| Error::invalid("tables not loaded"))?;
        let p = self.s2_params();
        let extended = self.cfg.mode == TofMode::Extended;
        let s1 = &self.s1;
        let usable = &self.usable;
        let blocks: Vec<_> = self
            .s2
            .chunks_mut(W * P2 * ROWS_PER_BLOCK)
            .zip(self.s2b.chunks_mut(W * P2B * ROWS_PER_BLOCK))
            .zip(self.flags.chunks_mut(W * ROWS_PER_BLOCK))
            .enumerate()
            .map(|(b, ((s2, s2b), fl))| (b * ROWS_PER_BLOCK, s2, s2b, fl))
            .collect();
        let work = |(y0, s2, s2b, fl): (usize, &mut [f32], &mut [u8], &mut [u32])| {
            for ((r, s2row), (s2brow, flrow)) in s2.chunks_exact_mut(W * P2).enumerate().zip(s2b.chunks_exact_mut(W * P2B).zip(fl.chunks_exact_mut(W))) {
                let y = y0 + r;
                let ys = [y.saturating_sub(2), y.saturating_sub(1), y, (y + 1).min(HEIGHT - 1), (y + 2).min(HEIGHT - 1)];
                let rows5 = |plane: usize| -> Option<[&Row; 5]> {
                    Some([row(s1, P1, ys[0], plane)?, row(s1, P1, ys[1], plane)?, row(s1, P1, ys[2], plane)?, row(s1, P1, ys[3], plane)?, row(s1, P1, ys[4], plane)?])
                };
                let urow = |yy: usize| -> Option<&RowU8> { usable.get(yy * W..(yy + 1) * W)?.try_into().ok() };
                let planes = (0..P1).map(rows5).collect::<Option<Vec<_>>>();
                let us5 = [urow(ys[0]), urow(ys[1]), urow(ys[2]), urow(ys[3]), urow(ys[4])];
                let (Some(pl), [Some(u0), Some(u1), Some(u2), Some(u3), Some(u4)]) = (planes, us5) else { continue };
                let (Some(xt), Some(zt)) = (row1(&prep.xt, y), row1(&prep.zt, y)) else { continue };
                let g = |i: usize| pl.get(i).copied();
                let (Some(a0), Some(a1), Some(a2), Some(b0), Some(b1), Some(b2), Some(n0), Some(n1), Some(n2)) = (g(0), g(1), g(2), g(3), g(4), g(5), g(6), g(7), g(8)) else { continue };
                let (Some(na0), Some(na1), Some(na2), Some(nb0), Some(nb1), Some(nb2)) = (g(9), g(10), g(11), g(12), g(13), g(14)) else { continue };
                let input = S2In {
                    y,
                    a: [a0, a1, a2],
                    b: [b0, b1, b2],
                    n: [n0, n1, n2],
                    na: [na0, na1, na2],
                    nb: [nb0, nb1, nb2],
                    usable: [u0, u1, u2, u3, u4],
                    xt,
                    zt,
                };
                let Some([f0, f1, f2, f3, f4, f5, f6, f7]) = split_row::<f32, P2>(s2row) else { continue };
                let Some([edge_ok, kind, sat]) = split_row::<u8, P2B>(s2brow) else { continue };
                let Ok(flags) = <&mut RowFlags>::try_from(flrow) else { continue };
                if extended {
                    let mut o = S2OutExt { u1: f0, u2: f1, e1: f2, e2: f3, conf: f4, csingle: f5, ir_sum: f6, anchor: f7, kind, edge_ok, sat, flags };
                    kernels::stage2_extended(&input, &p, &mut o);
                } else {
                    let mut o = S2OutCompat { raw_depth: f0, ir_sum: f1, edge_ok };
                    kernels::stage2_compat(&input, &p, &mut o);
                }
            }
        };
        for_each_block(self.threads, blocks, &work)
    }

    fn edge_params(&self, extended: bool) -> EdgeParams {
        let p = &self.cfg.params;
        EdgeParams {
            min_depth: self.cfg.min_depth,
            max_depth: self.cfg.max_depth,
            enabled: self.cfg.edge_filter,
            avg_min: p.edge_ab_avg_min_value,
            std_threshold: p.edge_ab_std_dev_threshold,
            close: p.edge_close_delta_threshold,
            far: p.edge_far_delta_threshold,
            max_delta: p.edge_max_delta_threshold,
            avg_delta: p.edge_avg_delta_threshold,
            scale_mm: if extended { self.cfg.ext.edge_scale_mm } else { 0.0 },
        }
    }

    fn stage3_compat(&mut self, out: &mut TofOutput) -> Result<()> {
        let e = self.edge_params(false);
        let s2 = &self.s2;
        let s2b = &self.s2b;
        let blocks: Vec<_> = out
            .depth
            .chunks_mut(W * ROWS_PER_BLOCK)
            .zip(out.confidence.chunks_mut(W * ROWS_PER_BLOCK))
            .enumerate()
            .map(|(b, (d, c))| (b * ROWS_PER_BLOCK, d, c))
            .collect();
        let work = |(y0, d, c): (usize, &mut [f32], &mut [f32])| {
            for (r, (drow, crow)) in d.chunks_exact_mut(W).zip(c.chunks_exact_mut(W)).enumerate() {
                let y = y0 + r;
                let (ya, yc) = (y.saturating_sub(1), (y + 1).min(HEIGHT - 1));
                let (Some(d0), Some(d1), Some(d2), Some(s0), Some(s1), Some(s2r), Some(edge)) =
                    (row(s2, P2, ya, 0), row(s2, P2, y, 0), row(s2, P2, yc, 0), row(s2, P2, ya, 1), row(s2, P2, y, 1), row(s2, P2, yc, 1), row(s2b, P2B, y, 0))
                else {
                    continue;
                };
                let Ok(out_row) = <&mut Row>::try_from(drow) else { continue };
                kernels::stage3_compat(y, [d0, d1, d2], [s0, s1, s2r], edge, &e, out_row);
                for (cv, dv) in crow.iter_mut().zip(out_row.iter()) {
                    *cv = if *dv > 0.0 { 1.0 } else { 0.0 };
                }
            }
        };
        for_each_block(self.threads, blocks, &work)
    }

    fn stage3_extended(&mut self, out: &mut TofOutput) -> Result<()> {
        let prep = self.prep.as_ref().ok_or_else(|| Error::invalid("tables not loaded"))?;
        // smooth expectation of u from the confident pixels, for large areas where only one
        // frequency is usable (a saturated hand): only computed when such pixels exist
        let kind_at = |i: usize| self.s2b.get(((i / W) * P2B + 1) * W + i % W).copied().unwrap_or(0);
        let f_at = |p: usize, i: usize| self.s2.get(((i / W) * P2 + p) * W + i % W).copied().unwrap_or(0.0);
        let singles = (0..PIXELS).filter(|i| kind_at(*i) & 0x0f == kernels::kind::SINGLE).count();
        let expected = if self.cfg.ext.spatial_resolve && singles > 0 {
            let u1: Vec<f32> = (0..PIXELS).map(|i| f_at(0, i)).collect();
            let weights: Vec<f32> = (0..PIXELS).map(|i| f_at(7, i)).collect();
            if weights.iter().any(|w| *w > 0.0) { push_pull(&u1, &weights, W, HEIGHT) } else { vec![0.0; PIXELS] }
        } else {
            Vec::new()
        };
        let resolve = ResolveIn {
            s2: &self.s2,
            p2: P2,
            s2b: &self.s2b,
            p2b: P2B,
            expected: &expected,
            xt: &prep.xt,
            zt: &prep.zt,
            radius: if self.cfg.ext.spatial_resolve { self.cfg.ext.spatial_radius } else { 0 },
            near_prior_mm: self.cfg.ext.near_prior_mm,
            min_conf: self.cfg.ext.min_confidence,
        };
        let spatial = self.cfg.ext.spatial_resolve;
        // 3a: resolve
        let blocks: Vec<_> = self
            .depth_res
            .chunks_mut(W * ROWS_PER_BLOCK)
            .zip(self.conf_res.chunks_mut(W * ROWS_PER_BLOCK))
            .zip(self.flags.chunks_mut(W * ROWS_PER_BLOCK))
            .enumerate()
            .map(|(b, ((d, c), f))| (b * ROWS_PER_BLOCK, d, c, f))
            .collect();
        let work = |(y0, d, c, f): (usize, &mut [f32], &mut [f32], &mut [u32])| {
            for (r, ((drow, crow), frow)) in d.chunks_exact_mut(W).zip(c.chunks_exact_mut(W)).zip(f.chunks_exact_mut(W)).enumerate() {
                let y = y0 + r;
                let Ok(fl) = <&mut RowFlags>::try_from(frow) else { continue };
                if spatial {
                    resolve_row(&resolve, y, drow, crow, fl);
                } else {
                    // no neighbors: multi-frequency results as they are, single ones dropped
                    let (Some(u1r), Some(cr), Some(kr), Some(xt), Some(zt)) =
                        (row(&self.s2, P2, y, 0), row(&self.s2, P2, y, 4), row(&self.s2b, P2B, y, 1), row1(&prep.xt, y), row1(&prep.zt, y))
                    else {
                        continue;
                    };
                    for x in 0..W {
                        let k = kr.get(x).copied().unwrap_or(0) & 0x0f;
                        let cv = if k == kernels::kind::MULTI { cr.get(x).copied().unwrap_or(0.0) } else { 0.0 };
                        let dv = kernels::depth_of_u(u1r.get(x).copied().unwrap_or(0.0), xt.get(x).copied().unwrap_or(0.0), zt.get(x).copied().unwrap_or(0.0));
                        if let (Some(dd), Some(cc)) = (drow.get_mut(x), crow.get_mut(x)) {
                            *dd = if cv > 0.0 { dv } else { 0.0 };
                            *cc = cv;
                        }
                    }
                }
            }
        };
        for_each_block(self.threads, blocks, &work)?;
        // 3b: edge filter, speckle filter, range, confidence threshold
        let e = self.edge_params(true);
        let q = S3Params {
            min_conf: self.cfg.ext.min_confidence,
            speckle: self.cfg.ext.speckle_filter,
            speckle_min: self.cfg.ext.speckle_min_neighbors as f32,
        };
        let (dres, cres, s2, s2b) = (&self.depth_res, &self.conf_res, &self.s2, &self.s2b);
        let blocks: Vec<_> = out
            .depth
            .chunks_mut(W * ROWS_PER_BLOCK)
            .zip(out.confidence.chunks_mut(W * ROWS_PER_BLOCK))
            .zip(self.flags.chunks_mut(W * ROWS_PER_BLOCK))
            .enumerate()
            .map(|(b, ((d, c), f))| (b * ROWS_PER_BLOCK, d, c, f))
            .collect();
        let work = |(y0, d, c, f): (usize, &mut [f32], &mut [f32], &mut [u32])| {
            for (r, ((drow, crow), frow)) in d.chunks_exact_mut(W).zip(c.chunks_exact_mut(W)).zip(f.chunks_exact_mut(W)).enumerate() {
                let y = y0 + r;
                let ys = [y.saturating_sub(2), y.saturating_sub(1), y, (y + 1).min(HEIGHT - 1), (y + 2).min(HEIGHT - 1)];
                let (Some(d0), Some(d1), Some(d2), Some(d3), Some(d4), Some(cr)) =
                    (row1(dres, ys[0]), row1(dres, ys[1]), row1(dres, y), row1(dres, ys[3]), row1(dres, ys[4]), row1(cres, y))
                else {
                    continue;
                };
                let (Some(s0), Some(s1), Some(s2r), Some(edge)) = (row(s2, P2, ys[1], 6), row(s2, P2, y, 6), row(s2, P2, ys[3], 6), row(s2b, P2B, y, 0)) else { continue };
                let (Ok(dout), Ok(cout), Ok(fl)) = (<&mut Row>::try_from(drow), <&mut Row>::try_from(crow), <&mut RowFlags>::try_from(frow)) else { continue };
                let input = S3In { y, d: [d0, d1, d2, d3, d4], s: [s0, s1, s2r], edge_ok: edge, conf: cr };
                kernels::stage3_extended(&input, &e, &q, dout, cout, fl);
            }
        };
        for_each_block(self.threads, blocks, &work)?;
        if self.cfg.ext.fill_saturated_depth {
            self.fill_saturated_depth(out);
        }
        Ok(())
    }

    /// Where every frequency saturated there is no measurement; inside such an area the depth
    /// is interpolated from the measured rim of the same bright object (pixels that saturated
    /// in some sample but still have depth), never from what is behind it.
    fn fill_saturated_depth(&mut self, out: &mut TofOutput) {
        let sat = |f: u32| f & flags::SATURATED_ANY != 0;
        let rejected = flags::EDGE | flags::SPECKLE | flags::OUT_OF_RANGE;
        let is_source = |i: usize| out.depth.get(i).is_some_and(|d| *d > 0.0) && self.flags.get(i).is_some_and(|f| sat(*f));
        let is_target = |i: usize| out.depth.get(i).is_some_and(|d| *d <= 0.0) && self.flags.get(i).is_some_and(|f| sat(*f) && *f & rejected == 0);
        // flood from the sources through the targets (4-neighborhood)
        let mut reached = vec![false; PIXELS];
        let mut queue: std::collections::VecDeque<usize> = (0..PIXELS).filter(|i| is_source(*i)).collect();
        if queue.is_empty() {
            return;
        }
        let mut any = false;
        while let Some(i) = queue.pop_front() {
            let (x, y) = (i % W, i / W);
            let mut push = |j: usize| {
                if let Some(r) = reached.get_mut(j)
                    && !*r
                    && is_target(j)
                {
                    *r = true;
                    any = true;
                    queue.push_back(j);
                }
            };
            if x > 0 {
                push(i - 1);
            }
            if x + 1 < W {
                push(i + 1);
            }
            if y > 0 {
                push(i - W);
            }
            if y + 1 < HEIGHT {
                push(i + W);
            }
        }
        if !any {
            return;
        }
        let weights: Vec<f32> = (0..PIXELS).map(|i| if is_source(i) { 1.0 } else { 0.0 }).collect();
        let filled = push_pull(&out.depth, &weights, W, HEIGHT);
        let (lo, hi) = (self.cfg.min_depth, self.cfg.max_depth);
        for (i, r) in reached.iter().enumerate() {
            if !*r {
                continue;
            }
            let v = filled.get(i).copied().unwrap_or(0.0);
            if v >= lo
                && v <= hi
                && let (Some(d), Some(c), Some(f)) = (out.depth.get_mut(i), out.confidence.get_mut(i), self.flags.get_mut(i))
            {
                *d = v;
                *c = 0.5;
                *f = (*f | flags::DEPTH_FILLED) & !flags::LOW_CONFIDENCE;
            }
        }
    }

    /// Infrared where every frequency saturated: filled smoothly from the surroundings, but never
    /// darker than the level at which this sensor saturates (estimated from the pixels whose
    /// saturated sample could be rebuilt: their brightness is known and just at that level).
    fn fill_ir(&mut self, out: &mut TofOutput) {
        let mut repaired: Vec<f32> = out
            .ir
            .iter()
            .zip(&self.flags)
            .filter(|(v, f)| **f & flags::REPAIRED_ANY != 0 && **f & flags::IR_FILLED == 0 && v.is_finite() && **v > 0.0)
            .map(|(v, _)| *v)
            .collect();
        if repaired.len() >= 30 {
            let k = repaired.len() * 3 / 4;
            let (_, level, _) = repaired.select_nth_unstable_by(k, f32::total_cmp);
            let level = *level;
            self.saturation_level = if self.saturation_level > 0.0 { 0.8 * self.saturation_level + 0.2 * level } else { level };
        }
        let clipped = self.flags.iter().filter(|f| **f & flags::IR_FILLED != 0).count();
        if clipped == 0 {
            return;
        }
        let weights: Vec<f32> = self.flags.iter().map(|f| if *f & flags::IR_FILLED != 0 { 0.0 } else { 1.0 }).collect();
        let filled = push_pull(&out.ir, &weights, W, HEIGHT);
        let gain = self.cfg.ext.ir_fill_gain;
        let floor = self.saturation_level;
        for ((o, f), v) in out.ir.iter_mut().zip(&self.flags).zip(filled) {
            if *f & flags::IR_FILLED != 0 {
                *o = v.max(floor) * gain;
            }
        }
    }
}
