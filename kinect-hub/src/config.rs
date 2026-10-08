//! Command line options.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

pub const USAGE: &str = "\
kinect-hub - Kinect v2 middleware: one process owns the sensor, every client gets the stream

usage: kinect-hub [options]

  --bind ADDR            listen address (default 127.0.0.1:8090; 0.0.0.0:8090 = whole LAN)
  --source kinect|synthetic|replay FILE
                         data source (default kinect; synthetic = generated test scene;
                         replay FILE = loop a recording of `kinect-hub-probe record`)
  --worker PATH          capture worker (default: fn2/bin/fn2_capture.exe, searched upwards)
  --pipeline fast|cl|cpu|clkde
                         depth decoding inside the worker (default fast = on the CPU with AVX2,
                         leaves the GPU to the scenes; cl = OpenCL on the GPU)
  --web-dir PATH         static files served at / (default: web/, searched upwards)
  --max-clients N        simultaneous WebSocket clients (default 64)
  --smoothing A          temporal filter for the `depth` stream: weight of the newest frame,
                         0.05..1 (default 0.4; 1 = off). `depth_raw` is never filtered.
  --allow-origin ORIGIN  additional browser origin that may connect (repeatable, '*' = any).
                         Same-origin pages and http(s)://localhost / 127.0.0.1 are always allowed.
  --pose dml|cpu|off     pose model on the infrared image (stream `poses`): DirectML on the GPU
                         (default), the CPU, or not at all
  --pose-models A,B,...  pose models, best first; all are loaded, the hub runs the best one that
                         keeps --pose-hz (default: those of web/lib/models/ that exist, in this
                         order: yolo11s-pose-512x448-fp16, yolo11s-pose-384x320-fp16,
                         yolo11n-pose-fp16 (only without the s 384 one), yolo11n-pose-384-fp16)
  --pose-model PATH      the best model, --pose-model-fast PATH|none the next one (older form of
                         --pose-models)
  --pose-hz HZ           target pose rate (default 15; 0 = as often as possible, best model only)
  --pose-idle-hz HZ      pose rate while nobody is in front of the sensor (default 3; new movement
                         wakes it at once; 0 = always --pose-hz)
  --persons on|off       person tracking (streams `persons`, `persons_live`; default on)
  --persons-delay N      frames the `persons` stream may wait for a later pose (default 12)
  --onnxruntime PATH     onnxruntime.dll (default: next to the hub, else kinect-hub/onnxruntime/,
                         which kinect-hub/setup-onnxruntime.ps1 fills)
  -h, --help             this text

Logging: set RUST_LOG, e.g. RUST_LOG=debug";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceKind {
    Kinect,
    Synthetic,
    Replay,
}

impl SourceKind {
    pub fn name(self) -> &'static str {
        match self {
            SourceKind::Kinect => "kinect",
            SourceKind::Synthetic => "synthetic",
            SourceKind::Replay => "replay",
        }
    }
}

/// Where the pose model runs (`--pose`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoseDevice {
    DirectMl,
    Cpu,
    Off,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: SocketAddr,
    pub source: SourceKind,
    /// The recording for `--source replay`, as given on the command line.
    pub replay: Option<PathBuf>,
    pub worker: Option<PathBuf>,
    pub pipeline: String,
    pub web_dir: Option<PathBuf>,
    pub max_clients: usize,
    pub smoothing: f32,
    pub allow_origins: Vec<String>,
    pub pose: PoseDevice,
    /// --pose-models, best first (empty: see pose_model_paths)
    pub pose_models: Vec<PathBuf>,
    pub pose_model: Option<PathBuf>,
    /// `Some(None)`: `--pose-model-fast none`
    pub pose_model_fast: Option<Option<PathBuf>>,
    pub pose_hz: f64,
    pub pose_idle_hz: f64,
    pub onnxruntime: Option<PathBuf>,
    pub persons: bool,
    pub persons_delay: u32,
}

impl Config {
    /// `Ok(None)` means `--help` was requested.
    pub fn from_args(args: impl Iterator<Item = String>) -> Result<Option<Config>, String> {
        let mut cfg = Config {
            bind: SocketAddr::from(([127, 0, 0, 1], 8090)),
            source: SourceKind::Kinect,
            replay: None,
            worker: None,
            pipeline: "fast".to_string(),
            web_dir: None,
            max_clients: 64,
            smoothing: 0.4,
            allow_origins: Vec::new(),
            pose: PoseDevice::DirectMl,
            pose_models: Vec::new(),
            pose_model: None,
            pose_model_fast: None,
            pose_hz: 15.0,
            pose_idle_hz: 3.0,
            onnxruntime: None,
            persons: true,
            persons_delay: 12,
        };
        let mut args = args;
        while let Some(arg) = args.next() {
            let mut value = |name: &str| args.next().ok_or_else(|| format!("{name} needs a value"));
            match arg.as_str() {
                "-h" | "--help" => return Ok(None),
                "--bind" => {
                    let v = value("--bind")?;
                    cfg.bind = v.parse().map_err(|e| format!("--bind {v}: {e}"))?;
                }
                "--source" => {
                    cfg.source = match value("--source")?.as_str() {
                        "kinect" => SourceKind::Kinect,
                        "synthetic" => SourceKind::Synthetic,
                        "replay" => {
                            let file = value("--source replay")?;
                            if file.starts_with("--") {
                                return Err("--source replay needs the recording: --source replay recordings/NAME.k2rec".to_string());
                            }
                            cfg.replay = Some(PathBuf::from(file));
                            SourceKind::Replay
                        }
                        other => return Err(format!("--source {other}: expected kinect, synthetic or replay FILE")),
                    }
                }
                "--worker" => cfg.worker = Some(PathBuf::from(value("--worker")?)),
                "--pipeline" => {
                    let v = value("--pipeline")?;
                    if !["fast", "cl", "cpu", "clkde"].contains(&v.as_str()) {
                        return Err(format!("--pipeline {v}: expected fast, cl, cpu or clkde"));
                    }
                    cfg.pipeline = v;
                }
                "--web-dir" => cfg.web_dir = Some(PathBuf::from(value("--web-dir")?)),
                "--max-clients" => {
                    let v = value("--max-clients")?;
                    cfg.max_clients = v.parse().map_err(|e| format!("--max-clients {v}: {e}"))?;
                    if !(1..=10_000).contains(&cfg.max_clients) {
                        return Err("--max-clients must be between 1 and 10000".to_string());
                    }
                }
                "--smoothing" => {
                    let v = value("--smoothing")?;
                    cfg.smoothing = v.parse().map_err(|e| format!("--smoothing {v}: {e}"))?;
                    if !(0.05..=1.0).contains(&cfg.smoothing) {
                        return Err("--smoothing must be between 0.05 and 1".to_string());
                    }
                }
                "--allow-origin" => cfg.allow_origins.push(value("--allow-origin")?),
                "--pose" => {
                    cfg.pose = match value("--pose")?.as_str() {
                        "dml" | "directml" => PoseDevice::DirectMl,
                        "cpu" => PoseDevice::Cpu,
                        "off" => PoseDevice::Off,
                        other => return Err(format!("--pose {other}: expected dml, cpu or off")),
                    }
                }
                "--pose-models" => {
                    cfg.pose_models = value("--pose-models")?.split(',').map(str::trim).filter(|s| !s.is_empty()).map(PathBuf::from).collect();
                }
                "--pose-model" => cfg.pose_model = Some(PathBuf::from(value("--pose-model")?)),
                "--pose-model-fast" => {
                    let v = value("--pose-model-fast")?;
                    cfg.pose_model_fast = Some((v != "none").then(|| PathBuf::from(v)));
                }
                "--pose-idle-hz" => {
                    let v = value("--pose-idle-hz")?;
                    cfg.pose_idle_hz = v.parse().map_err(|e| format!("--pose-idle-hz {v}: {e}"))?;
                    if !(0.0..=60.0).contains(&cfg.pose_idle_hz) {
                        return Err("--pose-idle-hz must be between 0 and 60".to_string());
                    }
                }
                "--pose-hz" => {
                    let v = value("--pose-hz")?;
                    cfg.pose_hz = v.parse().map_err(|e| format!("--pose-hz {v}: {e}"))?;
                    if !(0.0..=60.0).contains(&cfg.pose_hz) {
                        return Err("--pose-hz must be between 0 and 60".to_string());
                    }
                }
                "--onnxruntime" => cfg.onnxruntime = Some(PathBuf::from(value("--onnxruntime")?)),
                "--persons" => {
                    cfg.persons = match value("--persons")?.as_str() {
                        "on" => true,
                        "off" => false,
                        other => return Err(format!("--persons {other}: expected on or off")),
                    }
                }
                "--persons-delay" => {
                    let v = value("--persons-delay")?;
                    cfg.persons_delay = v.parse().map_err(|e| format!("--persons-delay {v}: {e}"))?;
                    if cfg.persons_delay > 60 {
                        return Err("--persons-delay must be between 0 and 60".to_string());
                    }
                }
                other => return Err(format!("unknown option {other}")),
            }
        }
        if cfg.web_dir.is_none() {
            cfg.web_dir = find_upwards(Path::new("web").join("index.html").as_path())
                .and_then(|p| p.parent().map(Path::to_path_buf));
        }
        Ok(Some(cfg))
    }

    /// The worker executable, looked up again before every start (it may be rebuilt meanwhile).
    pub fn worker_path(&self) -> Option<PathBuf> {
        match &self.worker {
            Some(p) => p.is_file().then(|| p.clone()),
            None => find_upwards(&Path::new("fn2").join("bin").join("fn2_capture.exe")),
        }
    }

    /// The pose models, best first (looked up again before every start: models may be added
    /// while the hub runs). Empty: no web/ directory and none given.
    pub fn pose_model_paths(&self) -> Vec<PathBuf> {
        if !self.pose_models.is_empty() {
            return self.pose_models.clone();
        }
        let dir = self.web_dir.as_ref().map(|d| d.join("lib").join("models"));
        let in_dir = |name: &str| dir.as_ref().map(|d| d.join(name));
        if self.pose_model.is_some() || self.pose_model_fast.is_some() {
            let best = self.pose_model.clone().or_else(|| in_dir("yolo11n-pose-fp16.onnx"));
            let next = match &self.pose_model_fast {
                Some(p) => p.clone(),
                None => in_dir("yolo11n-pose-384-fp16.onnx").filter(|p| p.is_file()),
            };
            return best.into_iter().chain(next).collect();
        }
        // n 512 costs about as much as s 384 and is worse: only without that one
        let s384 = in_dir("yolo11s-pose-384x320-fp16.onnx").filter(|p| p.is_file());
        let n512 = if s384.is_some() { None } else { in_dir("yolo11n-pose-fp16.onnx") };
        let found: Vec<PathBuf> = [in_dir("yolo11s-pose-512x448-fp16.onnx"), s384, n512, in_dir("yolo11n-pose-384-fp16.onnx")]
            .into_iter()
            .flatten()
            .filter(|p| p.is_file())
            .collect();
        if found.is_empty() { in_dir("yolo11n-pose-fp16.onnx").into_iter().collect() } else { found }
    }

    /// onnxruntime.dll, looked up again before every attempt (setup-onnxruntime.ps1 may run while
    /// the hub does).
    pub fn onnxruntime_path(&self) -> Option<PathBuf> {
        if let Some(p) = &self.onnxruntime {
            return p.is_file().then(|| p.clone());
        }
        find_upwards(Path::new("onnxruntime.dll"))
            .or_else(|| find_upwards(&Path::new("kinect-hub").join("onnxruntime").join("onnxruntime.dll")))
            .or_else(|| find_upwards(&Path::new("onnxruntime").join("onnxruntime.dll")))
    }

    /// The recording to replay, looked up again before every attempt. A relative path that does
    /// not exist here is also searched upwards from the executable: `recordings/` lives in the
    /// main checkout, next to the hub, not in the worktrees.
    pub fn replay_path(&self) -> Option<PathBuf> {
        let p = self.replay.as_ref()?;
        if p.is_absolute() || p.exists() {
            return Some(p.clone());
        }
        Some(find_upwards(p).unwrap_or_else(|| p.clone()))
    }
}

/// Searches `rel` in the directory of the executable, the current directory and their parents.
pub fn find_upwards(rel: &Path) -> Option<PathBuf> {
    let mut starts = Vec::new();
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent() {
            starts.push(dir.to_path_buf());
        }
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    for start in starts {
        let mut dir: Option<&Path> = Some(start.as_path());
        for _ in 0..8 {
            let Some(d) = dir else { break };
            let candidate = d.join(rel);
            if candidate.is_file() {
                return Some(candidate);
            }
            dir = d.parent();
        }
    }
    None
}
