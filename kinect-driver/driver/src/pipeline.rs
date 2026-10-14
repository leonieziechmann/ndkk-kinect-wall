//! Processing pipelines: a sequence of [`Stage`]s that turn a raw packet into a [`Frame`].
//!
//! The time-of-flight decoding itself is a stage ([`TofStage`], on the CPU or the GPU, in the
//! Compat or Extended mode); after it come as many stages as wanted: the built-in ones in
//! [`crate::stages`] (infrared tone mapping, temporal filter, depth range, point cloud) or your
//! own (implement [`Stage`] or wrap a closure with [`FnStage`]).
//!
//! ```no_run
//! use kinect_driver::pipeline::{Backend, Pipeline};
//! use kinect_driver::stages::{IrToneMap, TemporalFilter};
//! use kinect_driver::TofConfig;
//!
//! let pipeline = Pipeline::decoder(TofConfig::extended(), Backend::Cpu)?
//!     .with(IrToneMap::even())
//!     .with(TemporalFilter::default())
//!     .with_fn("count", |frame| {
//!         println!("{} pixels with depth", frame.valid_pixels());
//!         Ok(())
//!     });
//! # Ok::<(), kinect_driver::Error>(())
//! ```
//!
//! Every stage runs behind a panic guard: a bug in a stage costs at most that frame (essential
//! stages such as the decoder) or that stage's work on the frame (all others).

use std::sync::Arc;
use std::time::Instant;

use crate::error::{Error, Result, catch};
use crate::frame::Frame;
use crate::packet::RawDepthPacket;
use crate::tables::DeviceTables;
use crate::tof::{CpuDecoder, TofConfig, TofOutput};

/// One processing step.
pub trait Stage: Send {
    /// Name for logs and status.
    fn name(&self) -> &str;
    /// Processes the frame in place.
    fn process(&mut self, frame: &mut Frame) -> Result<()>;
    /// If true, a failure drops the frame (the decoder); otherwise the frame goes on.
    fn essential(&self) -> bool {
        false
    }
    /// The device or its tables changed (a new sensor session): forget per-device state.
    fn reset(&mut self) {}
}

/// Something that decodes raw packets (CPU or GPU).
pub trait TofDecoder: Send {
    /// "cpu avx2+fma, 4 threads, extended", ...
    fn describe(&self) -> String;
    /// Decodes `packet` into `out`.
    fn decode(&mut self, packet: &RawDepthPacket, tables: &Arc<DeviceTables>, out: &mut TofOutput) -> Result<()>;
    /// Milliseconds of the last frame.
    fn last_ms(&self) -> f64;
}

impl TofDecoder for CpuDecoder {
    fn describe(&self) -> String {
        format!(
            "cpu {}, {} threads, {}",
            crate::tof::simd::detected().name(),
            self.threads(),
            match self.config().mode {
                crate::tof::TofMode::Compat => "compat",
                crate::tof::TofMode::Extended => "extended",
            }
        )
    }
    fn decode(&mut self, packet: &RawDepthPacket, tables: &Arc<DeviceTables>, out: &mut TofOutput) -> Result<()> {
        CpuDecoder::decode(self, packet, tables, out)
    }
    fn last_ms(&self) -> f64 {
        self.timings.total_ms
    }
}

/// Where the decoding runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    /// CPU (SIMD, threads): leaves the GPU to the application
    Cpu,
    /// GPU (wgpu compute shaders; feature `gpu`)
    Gpu,
    /// the CPU if it has wide vectors (AVX2 / NEON), else the GPU if there is one
    Auto,
}

impl Backend {
    /// Parses "cpu", "gpu", "auto" (and the hub's pipeline names: fast/cpu = CPU, cl/clkde = GPU).
    pub fn parse(s: &str) -> Option<Backend> {
        match s.trim() {
            "cpu" | "fast" => Some(Backend::Cpu),
            "gpu" | "cl" | "clkde" | "opencl" => Some(Backend::Gpu),
            "auto" => Some(Backend::Auto),
            _ => None,
        }
    }
}

/// Creates a decoder for the backend. `Gpu` never fails for lack of a GPU: it decodes on the CPU
/// then (and whenever the GPU fails) and says so in [`TofDecoder::describe`].
pub fn make_decoder(cfg: TofConfig, backend: Backend) -> Result<Box<dyn TofDecoder>> {
    match backend {
        Backend::Cpu => Ok(Box::new(CpuDecoder::new(cfg)?)),
        Backend::Gpu => gpu_decoder(cfg),
        Backend::Auto => {
            let wide = crate::tof::simd::use_avx2() || cfg!(target_arch = "aarch64");
            if !wide && let Ok(d) = gpu_decoder(cfg.clone()) {
                return Ok(d);
            }
            Ok(Box::new(CpuDecoder::new(cfg)?))
        }
    }
}

#[cfg(feature = "gpu")]
fn gpu_decoder(cfg: TofConfig) -> Result<Box<dyn TofDecoder>> {
    Ok(Box::new(crate::gpu::FallbackDecoder::new(cfg)?))
}

#[cfg(not(feature = "gpu"))]
fn gpu_decoder(cfg: TofConfig) -> Result<Box<dyn TofDecoder>> {
    log::warn!("kinect-driver: built without the GPU decoder (feature `gpu`); using the CPU");
    Ok(Box::new(CpuDecoder::new(cfg)?))
}

/// The decoding as a stage: fills depth, infrared, confidence and flags from the raw packet.
pub struct TofStage {
    decoder: Box<dyn TofDecoder>,
    name: String,
}

impl TofStage {
    /// A decoding stage.
    pub fn new(cfg: TofConfig, backend: Backend) -> Result<TofStage> {
        Ok(TofStage::from_decoder(make_decoder(cfg, backend)?))
    }

    /// Wraps any decoder.
    pub fn from_decoder(decoder: Box<dyn TofDecoder>) -> TofStage {
        let name = format!("tof ({})", decoder.describe());
        TofStage { decoder, name }
    }
}

impl Stage for TofStage {
    fn name(&self) -> &str {
        &self.name
    }
    fn essential(&self) -> bool {
        true
    }
    fn process(&mut self, frame: &mut Frame) -> Result<()> {
        let raw = frame.raw.clone().ok_or_else(|| Error::invalid("the decoding stage needs the raw packet"))?;
        let mut out = TofOutput {
            sequence: frame.sequence,
            timestamp: frame.timestamp,
            depth: std::mem::take(&mut frame.depth),
            ir: std::mem::take(&mut frame.ir),
            confidence: std::mem::take(&mut frame.confidence),
            flags: std::mem::take(&mut frame.flags),
        };
        let r = self.decoder.decode(&raw, &frame.tables, &mut out);
        frame.depth = out.depth;
        frame.ir = out.ir;
        frame.confidence = out.confidence;
        frame.flags = out.flags;
        frame.decoder = self.decoder.describe();
        r
    }
}

/// A closure as a stage.
pub struct FnStage<F> {
    name: String,
    f: F,
}

impl<F: FnMut(&mut Frame) -> Result<()> + Send> FnStage<F> {
    /// Wraps `f`.
    pub fn new(name: &str, f: F) -> FnStage<F> {
        FnStage { name: name.to_string(), f }
    }
}

impl<F: FnMut(&mut Frame) -> Result<()> + Send> Stage for FnStage<F> {
    fn name(&self) -> &str {
        &self.name
    }
    fn process(&mut self, frame: &mut Frame) -> Result<()> {
        (self.f)(frame)
    }
}

/// Per-stage counters.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StageStats {
    /// stage name
    pub name: String,
    /// frames processed
    pub frames: u64,
    /// failures (errors and caught panics)
    pub failures: u64,
    /// milliseconds of the last frame
    pub last_ms: f64,
    /// the last failure
    pub last_error: Option<String>,
}

/// An ordered list of stages.
#[derive(Default)]
pub struct Pipeline {
    stages: Vec<Box<dyn Stage>>,
    stats: Vec<StageStats>,
    /// keep the raw packet in the delivered frames (otherwise it is dropped after the stages)
    pub keep_raw: bool,
}

impl Pipeline {
    /// An empty pipeline (frames carry only the raw packet).
    pub fn new() -> Pipeline {
        Pipeline::default()
    }

    /// A pipeline that starts with the decoding.
    pub fn decoder(cfg: TofConfig, backend: Backend) -> Result<Pipeline> {
        Ok(Pipeline::new().with(TofStage::new(cfg, backend)?))
    }

    /// Appends a stage.
    pub fn with(mut self, stage: impl Stage + 'static) -> Pipeline {
        self.push(Box::new(stage));
        self
    }

    /// Appends a closure as a stage.
    pub fn with_fn(self, name: &str, f: impl FnMut(&mut Frame) -> Result<()> + Send + 'static) -> Pipeline {
        self.with(FnStage::new(name, f))
    }

    /// Appends a stage.
    pub fn push(&mut self, stage: Box<dyn Stage>) {
        self.stats.push(StageStats { name: stage.name().to_string(), ..Default::default() });
        self.stages.push(stage);
    }

    /// Inserts a stage at `index` (0 = before everything, also before the decoding).
    pub fn insert(&mut self, index: usize, stage: Box<dyn Stage>) {
        let i = index.min(self.stages.len());
        self.stats.insert(i, StageStats { name: stage.name().to_string(), ..Default::default() });
        self.stages.insert(i, stage);
    }

    /// Removes the stage at `index`.
    pub fn remove(&mut self, index: usize) -> Option<Box<dyn Stage>> {
        if index >= self.stages.len() {
            return None;
        }
        self.stats.remove(index);
        Some(self.stages.remove(index))
    }

    /// Names of the stages in order.
    pub fn names(&self) -> Vec<String> {
        self.stages.iter().map(|s| s.name().to_string()).collect()
    }

    /// Counters per stage.
    pub fn stats(&self) -> &[StageStats] {
        &self.stats
    }

    /// A new sensor session: every stage forgets its state.
    pub fn reset(&mut self) {
        for s in &mut self.stages {
            let _ = catch(|| {
                s.reset();
                Ok(())
            });
        }
    }

    /// Runs all stages on the frame. Fails only if an essential stage failed.
    pub fn run(&mut self, frame: &mut Frame) -> Result<()> {
        let t0 = Instant::now();
        for (stage, st) in self.stages.iter_mut().zip(self.stats.iter_mut()) {
            let t = Instant::now();
            let r = catch(|| stage.process(frame));
            st.frames += 1;
            st.last_ms = t.elapsed().as_secs_f64() * 1000.0;
            if let Err(e) = r {
                st.failures += 1;
                st.last_error = Some(e.to_string());
                if stage.essential() {
                    frame.pipeline_ms = t0.elapsed().as_secs_f64() * 1000.0;
                    return Err(e);
                }
                log::warn!("stage {}: {e}", stage.name());
            }
        }
        if !self.keep_raw {
            frame.raw = None;
        }
        frame.pipeline_ms = t0.elapsed().as_secs_f64() * 1000.0;
        Ok(())
    }

    /// Convenience: a frame from a raw packet through all stages.
    pub fn process(&mut self, raw: Arc<RawDepthPacket>, tables: &Arc<DeviceTables>) -> Result<Frame> {
        let mut f = Frame::new(raw, tables.clone());
        self.run(&mut f)?;
        Ok(f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::{Scene, SimConfig, Simulator};

    #[test]
    fn stages_run_in_order_and_panics_are_contained() {
        let mut sim = Simulator::new(SimConfig { supersample: false, ..Default::default() }).unwrap();
        let tables = sim.tables().clone();
        let (p, _) = sim.frame(&Scene::preset("room", 0.0).unwrap(), 0);
        let mut pipe = Pipeline::decoder(TofConfig::extended(), Backend::Cpu)
            .unwrap()
            .with_fn("boom", |_f| panic!("a bug in a user stage"))
            .with_fn("mark", |f| {
                f.set_extra("one", vec![1.0]);
                Ok(())
            });
        let f = pipe.process(Arc::new(p), &tables).unwrap();
        assert!(f.valid_pixels() > 100_000);
        assert_eq!(f.extra("one"), Some(&[1.0][..]));
        assert!(f.raw.is_none());
        assert_eq!(pipe.stats()[1].failures, 1);
        assert!(pipe.stats()[1].last_error.as_deref().unwrap_or("").contains("a bug"));
    }

    #[test]
    fn a_failing_decoder_drops_the_frame() {
        let sim = Simulator::new(SimConfig { supersample: false, ..Default::default() }).unwrap();
        let tables = sim.tables().clone();
        let mut pipe = Pipeline::decoder(TofConfig::compat(), Backend::Cpu).unwrap();
        let mut f = Frame::new(Arc::new(RawDepthPacket::zeroed(1, 1)), tables);
        f.raw = None;
        assert!(pipe.run(&mut f).is_err());
    }
}
