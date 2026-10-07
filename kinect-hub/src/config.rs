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
  --pipeline cl|cpu|clkde
                         libfreenect2 depth pipeline inside the worker (default cl = OpenCL)
  --web-dir PATH         static files served at / (default: web/, searched upwards)
  --max-clients N        simultaneous WebSocket clients (default 64)
  --smoothing A          temporal filter for the `depth` stream: weight of the newest frame,
                         0.05..1 (default 0.4; 1 = off). `depth_raw` is never filtered.
  --allow-origin ORIGIN  additional browser origin that may connect (repeatable, '*' = any).
                         Same-origin pages and http(s)://localhost / 127.0.0.1 are always allowed.
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
}

impl Config {
    /// `Ok(None)` means `--help` was requested.
    pub fn from_args(args: impl Iterator<Item = String>) -> Result<Option<Config>, String> {
        let mut cfg = Config {
            bind: SocketAddr::from(([127, 0, 0, 1], 8090)),
            source: SourceKind::Kinect,
            replay: None,
            worker: None,
            pipeline: "cl".to_string(),
            web_dir: None,
            max_clients: 64,
            smoothing: 0.4,
            allow_origins: Vec::new(),
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
                    if !["cl", "cpu", "clkde"].contains(&v.as_str()) {
                        return Err(format!("--pipeline {v}: expected cl, cpu or clkde"));
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
