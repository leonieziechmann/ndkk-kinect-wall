//! Options shared by the commands: decoding, where frames come from, infrared output.

use std::path::PathBuf;

use kinect_driver::driver::{DriverConfig, PipelineFactory, Source};
use kinect_driver::pipeline::{Backend, Pipeline};
use kinect_driver::sim::SimConfig;
use kinect_driver::stages::IrToneMap;
use kinect_driver::tof::{TofConfig, TofMode};
use std::sync::Arc;

use crate::args::Args;

/// How the infrared is handed on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IrMode {
    /// as decoded (Extended: HDR, may exceed 65535)
    Raw,
    /// for kinect-hub (white at 6000): unchanged up to 3000, highlights compressed instead of
    /// clipped
    Hub,
    /// even exposure: the falloff with distance cancelled (relative to 2.5 m, within 1/4..2.5x),
    /// then like `Hub`
    Even,
}

impl IrMode {
    pub fn parse(s: &str) -> Result<IrMode, String> {
        match s {
            "raw" => Ok(IrMode::Raw),
            "hub" => Ok(IrMode::Hub),
            "even" => Ok(IrMode::Even),
            _ => Err(format!("--ir {s:?}: raw, hub or even")),
        }
    }

    pub fn stage(self) -> Option<IrToneMap> {
        match self {
            IrMode::Raw => None,
            IrMode::Hub => Some(IrToneMap::hub()),
            IrMode::Even => Some(IrToneMap::even()),
        }
    }
}

pub struct Common {
    pub tof: TofConfig,
    pub backend: Backend,
    pub source: Source,
    pub ir: IrMode,
    pub led: Option<u16>,
    pub cache: Option<PathBuf>,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// The platform's cache folder for the calibration of each Kinect.
pub fn default_cache() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        env("LOCALAPPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        env("HOME").map(|h| PathBuf::from(h).join("Library").join("Caches"))
    } else {
        env("XDG_CACHE_HOME").map(PathBuf::from).or_else(|| env("HOME").map(|h| PathBuf::from(h).join(".cache")))
    };
    base.map(|b| b.join("kinect-driver"))
}

/// `kinect`, `kinect:SERIAL`, `sim`, `sim:SCENE` or a `.k2raw` recording.
pub fn parse_source(s: &str, realtime: bool, looped: bool) -> Result<Source, String> {
    if s == "kinect" {
        return Ok(Source::Kinect { serial: None });
    }
    if let Some(serial) = s.strip_prefix("kinect:") {
        return Ok(Source::Kinect { serial: Some(serial.to_string()) });
    }
    if s == "sim" || s.starts_with("sim:") {
        let scene = s.strip_prefix("sim:").unwrap_or("room").to_string();
        if !kinect_driver::sim::Scene::PRESETS.contains(&scene.as_str()) {
            return Err(format!("unknown scene {scene:?} (scenes: {})", kinect_driver::sim::Scene::PRESETS.join(", ")));
        }
        return Ok(Source::Simulator { scene, fps: 30.0, sim: SimConfig { supersample: false, ..SimConfig::default() } });
    }
    let path = PathBuf::from(s);
    if path.exists() {
        return Ok(Source::Recording { path, realtime, looped });
    }
    Err(format!("--source {s:?}: kinect, kinect:SERIAL, sim, sim:SCENE or an existing .k2raw file"))
}

impl Common {
    /// Reads the shared options (and, for the worker, the environment: kinect-hub passes only
    /// `--pipeline`).
    pub fn parse(a: &mut Args, worker: bool) -> Result<Common, String> {
        let from_env = |name: &str| if worker { env(name) } else { None };
        let mode = a.value("--mode")?.or_else(|| from_env("KINECT_DRIVER_MODE")).unwrap_or_else(|| "extended".into());
        let mut tof = match mode.as_str() {
            "extended" | "ext" => TofConfig::extended(),
            "compat" | "libfreenect2" => TofConfig::compat(),
            m => return Err(format!("--mode {m:?}: compat or extended")),
        };
        if let Some(settings) = a.value("--tof")?.or_else(|| from_env("KINECT_DRIVER_TOF")) {
            tof.apply(&settings).map_err(|e| e.to_string())?;
        }
        let backend_s = a.value("--backend")?.or(a.value("--pipeline")?).or_else(|| from_env("KINECT_DRIVER_BACKEND")).unwrap_or_else(|| "cpu".into());
        let backend = Backend::parse(&backend_s).ok_or_else(|| format!("--backend {backend_s:?}: cpu, gpu or auto"))?;
        let realtime = !a.flag("--fast");
        let looped = worker || a.flag("--loop");
        let source = match a.value("--source")?.or_else(|| from_env("KINECT_DRIVER_SOURCE")) {
            Some(s) => parse_source(&s, realtime, looped)?,
            None => Source::Kinect { serial: a.value("--serial")? },
        };
        let ir_default = if worker { "hub" } else { "raw" };
        let ir = IrMode::parse(&a.value("--ir")?.or_else(|| from_env("KINECT_DRIVER_IR")).unwrap_or_else(|| ir_default.into()))?;
        let led = match a.value("--led")?.or_else(|| from_env("KINECT_DRIVER_LED")) {
            Some(v) => Some(v.parse::<u16>().ok().filter(|l| *l <= 1000).ok_or_else(|| format!("--led {v:?}: 0..1000"))?),
            None => None,
        };
        let cache = match a.value("--calibration-cache")?.or_else(|| from_env("KINECT_DRIVER_CACHE")) {
            Some(d) if d == "off" => None,
            Some(d) => Some(PathBuf::from(d)),
            None => default_cache(),
        };
        Ok(Common { tof, backend, source, ir, led, cache })
    }

    pub fn mode_name(&self) -> &'static str {
        match self.tof.mode {
            TofMode::Compat => "compat",
            TofMode::Extended => "extended",
        }
    }

    /// The pipeline: decoder, then the infrared tone mapping.
    pub fn pipeline_factory(&self) -> PipelineFactory {
        let (tof, backend, ir) = (self.tof.clone(), self.backend, self.ir);
        Arc::new(move || {
            let p = Pipeline::decoder(tof.clone(), backend)?;
            Ok(match ir.stage() {
                Some(s) => p.with(s),
                None => p,
            })
        })
    }

    pub fn driver_config(&self) -> DriverConfig {
        DriverConfig {
            source: self.source.clone(),
            pipeline: Some(self.pipeline_factory()),
            tof: self.tof.clone(),
            backend: self.backend,
            led: self.led,
            calibration_cache: self.cache.clone(),
            ..DriverConfig::default()
        }
    }
}
