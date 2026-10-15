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
  --worker kinect-driver|fn2|PATH
                         capture worker (default: the Rust driver
                         kinect-driver/target/release/kinect-driver.exe, else libfreenect2's
                         fn2/bin/fn2_capture.exe, both searched upwards; fn2 = always libfreenect2)
  --driver-mode compat|extended
                         depth decoding of kinect-driver (default compat = the results of
                         libfreenect2; extended = more range, near despite saturation, costs about
                         twice the CPU). KINECT_DRIVER_MODE in the environment sets the default.
  --pipeline fast|cl|cpu|clkde
                         depth decoding inside the worker (default fast = on the CPU with AVX2,
                         leaves the GPU to the scenes; cl = on the GPU)
  --max-clients N        simultaneous WebSocket clients (default 64)
  --smoothing A          temporal filter for the `depth` stream: weight of the newest frame,
                         0.05..1 (default 0.4; 1 = off). `depth_raw` is never filtered.
  --allow-origin ORIGIN  additional browser origin that may connect (repeatable, '*' = any).
                         Same-origin pages and http(s)://localhost / 127.0.0.1 are always allowed.
  --pose dml|cpu|off     pose model on the infrared image (stream `poses`): DirectML on the GPU
                         (default), the CPU, or not at all
  --pose-models A,B,...  pose models, best first; all are loaded, the hub runs the best one that
                         keeps --pose-hz (default: those of kinect-hub/models/ that exist, in
                         this order: yolo11s-pose-512x448-fp16, yolo11s-pose-384x320-fp16,
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

/// The capture worker (`--worker`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkerChoice {
    /// kinect-driver if it is built, else fn2_capture
    Auto,
    Driver,
    Fn2,
    Path(PathBuf),
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
    pub worker: WorkerChoice,
    /// KINECT_DRIVER_MODE for kinect-driver (fn2_capture ignores it)
    pub driver_mode: String,
    pub pipeline: String,
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
            worker: WorkerChoice::Auto,
            driver_mode: std::env::var("KINECT_DRIVER_MODE").ok().filter(|m| !m.trim().is_empty()).unwrap_or_else(|| "compat".to_string()),
            pipeline: "fast".to_string(),
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
                "--worker" => {
                    cfg.worker = match value("--worker")?.as_str() {
                        "kinect-driver" | "rust" => WorkerChoice::Driver,
                        "fn2" | "libfreenect2" => WorkerChoice::Fn2,
                        path => WorkerChoice::Path(PathBuf::from(path)),
                    }
                }
                "--driver-mode" => {
                    let v = value("--driver-mode")?;
                    if !["compat", "extended"].contains(&v.as_str()) {
                        return Err(format!("--driver-mode {v}: expected compat or extended"));
                    }
                    cfg.driver_mode = v;
                }
                "--pipeline" => {
                    let v = value("--pipeline")?;
                    if !["fast", "cl", "cpu", "clkde"].contains(&v.as_str()) {
                        return Err(format!("--pipeline {v}: expected fast, cl, cpu or clkde"));
                    }
                    cfg.pipeline = v;
                }
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
        Ok(Some(cfg))
    }

    /// The worker executable, looked up again before every start (it may be built meanwhile).
    pub fn worker_path(&self) -> Option<PathBuf> {
        let driver = || find_upwards(&Path::new("kinect-driver").join("target").join("release").join("kinect-driver.exe"));
        let fn2 = || find_upwards(&Path::new("fn2").join("bin").join("fn2_capture.exe"));
        match &self.worker {
            WorkerChoice::Auto => driver().or_else(fn2),
            WorkerChoice::Driver => driver(),
            WorkerChoice::Fn2 => fn2(),
            WorkerChoice::Path(p) => p.is_file().then(|| p.clone()),
        }
    }

    /// What to build when the worker is missing.
    pub fn worker_missing(&self) -> String {
        let driver = "kinect-driver.exe (`cargo build --release` in kinect-driver/)";
        let fn2 = "fn2_capture.exe (`sh fn2/build.sh`)";
        match &self.worker {
            WorkerChoice::Auto => format!("capture worker not found: build {driver} or {fn2}, or pass --worker"),
            WorkerChoice::Driver => format!("capture worker not found: build {driver}"),
            WorkerChoice::Fn2 => format!("capture worker not found: build {fn2}"),
            WorkerChoice::Path(p) => format!("capture worker {} not found", p.display()),
        }
    }

    /// The pose models, best first (looked up again before every start: models may be added
    /// while the hub runs). Empty: no kinect-hub/models/ found and none given.
    pub fn pose_model_paths(&self) -> Vec<PathBuf> {
        if !self.pose_models.is_empty() {
            return self.pose_models.clone();
        }
        // kinect-hub/models/ of the checkout the hub was built in (or is started from)
        let dir = find_upwards(&Path::new("kinect-hub").join("models").join("README.md")).and_then(|p| p.parent().map(Path::to_path_buf));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_pose_models_are_found_in_kinect_hub_models() {
        let cfg = Config::from_args(std::iter::empty()).ok().flatten();
        let files = cfg.map(|c| c.pose_model_paths()).unwrap_or_default();
        let names: Vec<String> = files.iter().filter_map(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["yolo11s-pose-512x448-fp16.onnx", "yolo11s-pose-384x320-fp16.onnx", "yolo11n-pose-384-fp16.onnx"]);
        assert!(files.iter().all(|p| p.is_file() && p.parent().is_some_and(|d| d.ends_with(Path::new("kinect-hub").join("models")))));
    }

    fn parse(args: &[&str]) -> Result<Option<Config>, String> {
        Config::from_args(args.iter().map(|s| (*s).to_string()))
    }

    #[test]
    fn worker_and_driver_mode_options() {
        let worker = |args: &[&str]| parse(args).ok().flatten().map(|c| c.worker);
        assert_eq!(worker(&[]), Some(WorkerChoice::Auto));
        assert_eq!(worker(&["--worker", "fn2"]), Some(WorkerChoice::Fn2));
        assert_eq!(worker(&["--worker", "kinect-driver"]), Some(WorkerChoice::Driver));
        assert_eq!(worker(&["--worker", "x/w.exe"]), Some(WorkerChoice::Path(PathBuf::from("x/w.exe"))));
        let mode = |args: &[&str]| parse(args).ok().flatten().map(|c| c.driver_mode);
        assert_eq!(mode(&["--driver-mode", "extended"]).as_deref(), Some("extended"));
        assert!(parse(&["--driver-mode", "fast"]).is_err());
    }

    #[test]
    fn the_rust_driver_goes_first_when_it_is_built() {
        let driver = find_upwards(&Path::new("kinect-driver").join("target").join("release").join("kinect-driver.exe"));
        let auto = Config::from_args(std::iter::empty()).ok().flatten().and_then(|c| c.worker_path());
        if driver.is_some() {
            assert_eq!(auto, driver);
        }
        let fn2 = parse(&["--worker", "fn2"]).ok().flatten().and_then(|c| c.worker_path());
        assert!(fn2.is_none_or(|p| p.ends_with(Path::new("fn2").join("bin").join("fn2_capture.exe"))));
    }
}
