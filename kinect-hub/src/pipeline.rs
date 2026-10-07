//! Per-frame precomputation, done once in the hub for all clients. One pass over the pixels
//! converts depth, applies the temporal filter, gathers statistics and (while subscribed) builds
//! 3D points, writing straight into the final message buffers that every client then shares.

use std::sync::Arc;
use std::time::Instant;

use bytes::Bytes;
use serde_json::json;
use tracing::{info, warn};

use crate::lut::build_param_set;
use crate::protocol::{FLAG_HAS_IR, MessageBuf, PIXELS, Stream, WorkerHeader};
use crate::state::{CameraParams, FrameSet, FrameStats, Hub, ParamSet, now_us};

/// IR values are tone-mapped through a table indexed by `value >> IR_SHIFT`.
const IR_SHIFT: u32 = 4;
/// IR value shown as full white (raw IR range is 0..65535, most of a room is far below).
const IR_WHITE: f32 = 6000.0;
const HIST_BIN_MM: u16 = 16;
const HIST_BINS: usize = 1024; // up to 16 m

/// Running depth statistics over the valid pixels of one frame.
struct StatsAcc<'a> {
    hist: &'a mut [u32],
    n: u32,
    sum: u64,
    min: u16,
    max: u16,
    centroid: [f64; 3],
    with_rays: bool,
}

impl<'a> StatsAcc<'a> {
    fn new(hist: &'a mut [u32], with_rays: bool) -> StatsAcc<'a> {
        hist.fill(0);
        StatsAcc { hist, n: 0, sum: 0, min: u16::MAX, max: 0, centroid: [0.0; 3], with_rays }
    }

    #[inline]
    fn add(&mut self, d: u16, ray: [f32; 2]) {
        self.n += 1;
        self.sum += u64::from(d);
        self.min = self.min.min(d);
        self.max = self.max.max(d);
        if let Some(bin) = self.hist.get_mut(usize::from(d / HIST_BIN_MM)) {
            *bin += 1;
        }
        let z = f64::from(d);
        self.centroid[0] += f64::from(ray[0]) * z;
        self.centroid[1] += f64::from(ray[1]) * z;
        self.centroid[2] += z;
    }

    fn finish(self, has_ir: bool) -> FrameStats {
        if self.n == 0 {
            return FrameStats { has_ir, ..FrameStats::default() };
        }
        let mut median = 0u16;
        let mut seen = 0u32;
        for (i, &count) in self.hist.iter().enumerate() {
            seen += count;
            if seen * 2 >= self.n {
                median = (i as u16).saturating_mul(HIST_BIN_MM).saturating_add(HIST_BIN_MM / 2);
                break;
            }
        }
        let n = f64::from(self.n);
        FrameStats {
            valid_pixels: self.n,
            valid_ratio: (n / PIXELS as f64) as f32,
            min_mm: self.min,
            max_mm: self.max,
            mean_mm: (self.sum as f64 / n) as f32,
            median_mm: median,
            centroid_mm: self.with_rays.then(|| self.centroid.map(|c| (c / n) as f32)),
            has_ir,
        }
    }
}

pub struct Pipeline {
    hub: Arc<Hub>,
    /// Temporal filter state in mm.
    filtered: Vec<f32>,
    ir_table: Vec<u8>,
    hist: Vec<u32>,
    params: Option<Arc<ParamSet>>,
}

impl Pipeline {
    pub fn new(hub: Arc<Hub>) -> Pipeline {
        let ir_table = (0..(65536u32 >> IR_SHIFT))
            .map(|i| {
                let v = (i << IR_SHIFT) as f32 + 8.0;
                ((v / IR_WHITE).clamp(0.0, 1.0).sqrt() * 255.0 + 0.5) as u8
            })
            .collect();
        Pipeline { hub, filtered: vec![0.0; PIXELS], ir_table, hist: vec![0; HIST_BINS], params: None }
    }

    /// Forgets the temporal filter state (after a reconnect the scene may have changed).
    pub fn reset(&mut self) {
        self.filtered.fill(0.0);
    }

    pub fn on_params(&mut self, payload: &[u8]) -> Result<(), String> {
        let mut params: CameraParams =
            serde_json::from_slice(payload).map_err(|e| format!("invalid camera parameters: {e}"))?;
        if let Err(e) = params.validate() {
            warn!("implausible camera parameters from the worker ({e}), using defaults");
            params = CameraParams { serial: params.serial, firmware: params.firmware, ..CameraParams::default_kinect() };
        }
        self.set_params(params);
        Ok(())
    }

    pub fn set_params(&mut self, params: CameraParams) {
        if let Some(current) = &self.params {
            let p = &current.params;
            let same = [p.fx, p.fy, p.cx, p.cy, p.k1, p.k2, p.k3, p.p1, p.p2]
                == [params.fx, params.fy, params.cx, params.cy, params.k1, params.k2, params.k3, params.p1, params.p2];
            if same && p.serial == params.serial {
                return;
            }
        }
        info!(
            "camera parameters: fx {:.2} fy {:.2} cx {:.2} cy {:.2} k1 {:.4} k2 {:.4} k3 {:.4} (serial {}, firmware {})",
            params.fx, params.fy, params.cx, params.cy, params.k1, params.k2, params.k3, params.serial, params.firmware
        );
        let set = Arc::new(build_param_set(params));
        self.params = Some(set.clone());
        self.hub.params.send_replace(Some(set));
    }

    pub fn on_frame(&mut self, h: &WorkerHeader, payload: &[u8]) -> Result<(), String> {
        let t0 = Instant::now();
        let received_us = now_us();
        let plane = PIXELS * 4;
        let has_ir = h.flags & FLAG_HAS_IR != 0;
        let expected = if has_ir { 2 * plane } else { plane };
        if payload.len() != expected {
            return Err(format!("frame payload has {} bytes, expected {expected}", payload.len()));
        }
        let (depth_bytes, ir_bytes) = payload.split_at_checked(plane).ok_or("frame payload too short")?;

        let params = self.params.clone();
        let rays: &[[f32; 2]] = params.as_ref().map_or(&[], |p| p.rays.as_chunks::<2>().0);
        let want_points = !rays.is_empty() && self.hub.subscribers(Stream::Points) > 0;
        let alpha = self.hub.cfg.smoothing;

        let mut depth_msg = MessageBuf::new(PIXELS * 2);
        let mut raw_msg = MessageBuf::new(PIXELS * 2);
        let mut points_msg = want_points.then(|| MessageBuf::new(PIXELS * 6));
        let mut stats = StatsAcc::new(&mut self.hist, !rays.is_empty());
        {
            let depth_out = depth_msg.payload_mut().as_chunks_mut::<2>().0;
            let raw_out = raw_msg.payload_mut().as_chunks_mut::<2>().0;
            let mut points_out = points_msg.as_mut().map(|m| m.payload_mut().as_chunks_mut::<6>().0.iter_mut());
            let mut ray_iter = rays.iter();
            let pixels = depth_bytes
                .as_chunks::<4>()
                .0
                .iter()
                .zip(self.filtered.iter_mut())
                .zip(depth_out.iter_mut())
                .zip(raw_out.iter_mut());
            for (((input, state), out), raw) in pixels {
                let d = f32::from_le_bytes(*input);
                let d = if d.is_finite() && d > 0.0 && d < 16_000.0 { d } else { 0.0 };
                *raw = mm(d).to_le_bytes();
                // smooth only where the change looks like sensor noise; real motion passes at once
                let prev = *state;
                let f = if d > 0.0 && prev > 0.0 && (d - prev).abs() < (30.0f32).max(0.015 * d) {
                    prev + alpha * (d - prev)
                } else {
                    d
                };
                *state = f;
                let z = mm(f);
                *out = z.to_le_bytes();
                let ray = ray_iter.next().copied().unwrap_or([0.0, 0.0]);
                if z != 0 {
                    stats.add(z, ray);
                }
                if let Some(p) = points_out.as_mut().and_then(Iterator::next) {
                    *p = xyz_bytes(z, ray);
                }
            }
        }
        let stats = stats.finish(has_ir);

        let ir_msg = has_ir.then(|| {
            let mut m = MessageBuf::new(PIXELS);
            for (out, input) in m.payload_mut().iter_mut().zip(ir_bytes.as_chunks::<4>().0) {
                let v = f32::from_le_bytes(*input);
                let idx = if v.is_finite() && v > 0.0 { (v.min(65535.0) as u32 >> IR_SHIFT) as usize } else { 0 };
                *out = self.ir_table.get(idx).copied().unwrap_or(255);
            }
            m
        });

        let (seq, capture, publish) = (h.seq, h.host_time_us, now_us());
        let meta = json!({
            "type": "frame",
            "seq": seq,
            "device_ts": h.device_ts,
            "capture_time_us": capture,
            "publish_time_us": publish,
            "stats": &stats,
        })
        .to_string()
        .into();
        let frame = FrameSet {
            seq,
            capture_time_us: capture,
            publish_time_us: publish,
            stats,
            depth: depth_msg.finish(Stream::Depth, seq, capture, publish),
            depth_raw: raw_msg.finish(Stream::DepthRaw, seq, capture, publish),
            ir: ir_msg.map(|m| m.finish(Stream::Ir, seq, capture, publish)),
            points: points_msg.map(|m| m.finish(Stream::Points, seq, capture, publish)),
            meta,
            params,
        };
        self.hub.frames.send_replace(Some(Arc::new(frame)));

        let transfer_ms = received_us.saturating_sub(capture) as f64 / 1000.0;
        let process_ms = t0.elapsed().as_secs_f64() * 1000.0;
        self.hub.metrics().on_frame(seq, transfer_ms, process_ms);
        Ok(())
    }
}

fn mm(d: f32) -> u16 {
    (d + 0.5) as u16 // saturating cast
}

/// One point as i16 x, y, z in mm, little-endian (zeros = no measurement).
fn xyz_bytes(z: u16, ray: [f32; 2]) -> [u8; 6] {
    if z == 0 {
        return [0; 6];
    }
    let zf = f32::from(z);
    let c = |v: f32| (v.round().clamp(-32768.0, 32767.0) as i16).to_le_bytes();
    let (x, y, z) = (c(ray[0] * zf), c(ray[1] * zf), c(zf));
    [x[0], x[1], y[0], y[1], z[0], z[1]]
}

/// Points for an HTTP request when nobody streams them (normally built in `on_frame`).
pub fn points_message(depth: &[u16], rays: &[f32], seq: u32, capture: u64, publish: u64) -> Bytes {
    let mut m = MessageBuf::new(depth.len() * 6);
    for ((out, &d), ray) in m.payload_mut().as_chunks_mut::<6>().0.iter_mut().zip(depth).zip(rays.as_chunks::<2>().0) {
        *out = xyz_bytes(d, *ray);
    }
    m.finish(Stream::Points, seq, capture, publish)
}
