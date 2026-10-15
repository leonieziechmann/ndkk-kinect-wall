//! Time-of-flight decoding: raw depth packets -> depth, infrared, confidence, flags.
//!
//! Two methods ([`TofMode`]): `Compat` reproduces libfreenect2 (and the repository's
//! fn2/fast_depth.cpp); `Extended` covers the whole unambiguous range, keeps close objects despite
//! saturation and produces HDR infrared. Two places to run: [`CpuDecoder`] (SIMD, threads) and,
//! with the `gpu` feature, the wgpu compute shaders in `crate::gpu`.

pub mod config;
pub mod cpu;
pub mod echoes;
pub mod fill;
pub mod kernels;
pub mod lanes;
pub mod math;
pub mod pack;
pub mod parallel;
pub mod post;
pub mod resolve;
pub mod simd;

pub use config::{ExtendedParams, Lf2Params, TofConfig, TofMode};
pub use cpu::{CpuDecoder, UnwrapInfo};
pub use kernels::flags;

use crate::consts::PIXELS;

/// The decoded planes of one frame (512 x 424, row 0 at the top, mirrored like the Kinect SDK
/// and libfreenect2 deliver it).
#[derive(Clone, Debug, Default)]
pub struct TofOutput {
    /// frame sequence number
    pub sequence: u32,
    /// device timestamp
    pub timestamp: u32,
    /// depth in mm (z, not the distance along the ray); 0 = no measurement
    pub depth: Vec<f32>,
    /// infrared amplitude in libfreenect2's scale (Compat: clipped at 65535; Extended: HDR,
    /// may exceed 65535)
    pub ir: Vec<f32>,
    /// confidence 0..1 of the depth (Compat: 1 where there is depth)
    pub confidence: Vec<f32>,
    /// per-pixel [`flags`]
    pub flags: Vec<u32>,
}

impl TofOutput {
    /// Planes of the right size, zeroed.
    pub fn new() -> TofOutput {
        let mut o = TofOutput::default();
        o.resize();
        o
    }

    /// Makes every plane `PIXELS` long.
    pub fn resize(&mut self) {
        self.depth.resize(PIXELS, 0.0);
        self.ir.resize(PIXELS, 0.0);
        self.confidence.resize(PIXELS, 0.0);
        self.flags.resize(PIXELS, 0);
    }
}

/// Milliseconds per phase of the last decoded frame.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TofTimings {
    /// unpacking and complex values
    pub stage1_ms: f64,
    /// filter and unwrapping
    pub stage2_ms: f64,
    /// resolution, edge filter
    pub stage3_ms: f64,
    /// infrared fill (CPU: runs alongside the start of stage 3 and is part of `stage3_ms`)
    pub fill_ms: f64,
    /// the two-echo split (CPU: part of `stage2_ms`; the GPU does not time it apart)
    pub split_ms: f64,
    /// all of it
    pub total_ms: f64,
}
