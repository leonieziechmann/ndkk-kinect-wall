//! State shared by the source thread, the HTTP handlers and the WebSocket sessions.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use axum::extract::ws::Utf8Bytes;
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Semaphore, watch};

use crate::config::Config;
use crate::protocol::{HEIGHT, Stream, WIDTH};

/// Wall-clock time in microseconds since 1970 (same clock as the worker's timestamps).
pub fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_micros()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Depth camera intrinsics and lens distortion as reported by the Kinect.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CameraParams {
    pub width: u32,
    pub height: u32,
    pub fx: f32,
    pub fy: f32,
    pub cx: f32,
    pub cy: f32,
    #[serde(default)]
    pub k1: f32,
    #[serde(default)]
    pub k2: f32,
    #[serde(default)]
    pub k3: f32,
    #[serde(default)]
    pub p1: f32,
    #[serde(default)]
    pub p2: f32,
    #[serde(default)]
    pub serial: String,
    #[serde(default)]
    pub firmware: String,
}

impl CameraParams {
    /// Typical Kinect v2 values, used for the synthetic source and when the device reports nonsense.
    pub fn default_kinect() -> CameraParams {
        CameraParams {
            width: WIDTH as u32,
            height: HEIGHT as u32,
            fx: 365.5,
            fy: 365.5,
            cx: 256.0,
            cy: 206.0,
            k1: 0.0,
            k2: 0.0,
            k3: 0.0,
            p1: 0.0,
            p2: 0.0,
            serial: String::new(),
            firmware: String::new(),
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        let finite = [self.fx, self.fy, self.cx, self.cy, self.k1, self.k2, self.k3, self.p1, self.p2]
            .iter()
            .all(|v| v.is_finite());
        if !finite {
            return Err("non-finite value".to_string());
        }
        if self.width as usize != WIDTH || self.height as usize != HEIGHT {
            return Err(format!("unexpected size {}x{}", self.width, self.height));
        }
        if !(100.0..2000.0).contains(&self.fx) || !(100.0..2000.0).contains(&self.fy) {
            return Err(format!("focal length {} / {}", self.fx, self.fy));
        }
        if !(0.0..WIDTH as f32).contains(&self.cx) || !(0.0..HEIGHT as f32).contains(&self.cy) {
            return Err(format!("principal point {} / {}", self.cx, self.cy));
        }
        Ok(())
    }
}

/// Camera parameters plus everything derived from them, computed once per device start.
pub struct ParamSet {
    pub params: CameraParams,
    /// Undistorted ray per pixel: x, y with point = (x * z, y * z, z).
    pub rays: Arc<Vec<f32>>,
    /// `{"type":"params",...}` text message.
    pub json: Utf8Bytes,
    /// Binary `lut` message (kind 16).
    pub lut_msg: Bytes,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct FrameStats {
    pub valid_pixels: u32,
    pub valid_ratio: f32,
    pub min_mm: u16,
    pub max_mm: u16,
    pub mean_mm: f32,
    pub median_mm: u16,
    /// Mean point in mm (camera frame), once the lens parameters are known.
    pub centroid_mm: Option<[f32; 3]>,
    pub has_ir: bool,
}

/// One sensor frame with every derived representation, ready to send as-is to any client.
pub struct FrameSet {
    pub seq: u32,
    pub capture_time_us: u64,
    pub publish_time_us: u64,
    pub stats: FrameStats,
    pub depth: Bytes,
    pub depth_raw: Bytes,
    pub ir: Option<Bytes>,
    /// Only computed while someone subscribes to `points`; HTTP computes it on demand otherwise.
    pub points: Option<Bytes>,
    /// `{"type":"frame",...}` text message (shared, cloning is free).
    pub meta: Utf8Bytes,
    /// Parameters the frame was processed with.
    pub params: Option<Arc<ParamSet>>,
}

impl FrameSet {
    pub fn binary(&self, stream: Stream) -> Option<&Bytes> {
        match stream {
            Stream::Depth => Some(&self.depth),
            Stream::DepthRaw => Some(&self.depth_raw),
            Stream::Ir => self.ir.as_ref(),
            Stream::Points => self.points.as_ref(),
            Stream::Lut | Stream::Meta | Stream::Status => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SensorState {
    /// The capture worker is not running (starting, crashed, missing).
    Offline,
    /// Worker runs, no Kinect on USB.
    Searching,
    /// Kinect found, sensor warming up.
    Starting,
    /// Frames are arriving.
    Streaming,
}

#[derive(Clone, Debug, Serialize)]
pub struct SensorStatus {
    pub state: SensorState,
    pub detail: String,
    pub since_unix_ms: u64,
}

#[derive(Default)]
pub struct Metrics {
    pub frames_in: u64,
    pub last_seq: Option<u32>,
    pub seq_gaps: u64,
    pub last_frame_at: Option<Instant>,
    pub fps: f64,
    /// Worker timestamp -> received by the hub.
    pub transfer_ms: f64,
    /// Precomputation in the hub.
    pub process_ms: f64,
    pub worker_restarts: u64,
    pub worker_pid: Option<u32>,
    pub worker_started: Option<Instant>,
    pub worker_heartbeat: Option<Value>,
    pub last_worker_exit: Option<String>,
    pub panics_caught: u64,
    pub protocol_errors: u64,
    pub frame_errors: u64,
}

impl Metrics {
    pub fn on_frame(&mut self, seq: u32, transfer_ms: f64, process_ms: f64) {
        let now = Instant::now();
        if let Some(prev) = self.last_frame_at {
            let dt = now.duration_since(prev).as_secs_f64();
            if dt > 0.0 && dt < 2.0 {
                let fps = 1.0 / dt;
                self.fps = if self.fps == 0.0 { fps } else { 0.9 * self.fps + 0.1 * fps };
            } else {
                self.fps = 0.0;
            }
        }
        if let Some(last) = self.last_seq
            && seq > last.wrapping_add(1) && seq.wrapping_sub(last) < 1000 {
                self.seq_gaps = self.seq_gaps.saturating_add(u64::from(seq.wrapping_sub(last) - 1));
            }
        let ema = |old: f64, new: f64| if old == 0.0 { new } else { 0.9 * old + 0.1 * new };
        self.transfer_ms = ema(self.transfer_ms, transfer_ms.max(0.0));
        self.process_ms = ema(self.process_ms, process_ms);
        self.last_seq = Some(seq);
        self.last_frame_at = Some(now);
        self.frames_in = self.frames_in.saturating_add(1);
    }
}

pub struct Hub {
    pub cfg: Arc<Config>,
    /// Newest frame; receivers always see only the latest one (no queues, no lag build-up).
    pub frames: watch::Sender<Option<Arc<FrameSet>>>,
    pub params: watch::Sender<Option<Arc<ParamSet>>>,
    pub sensor: watch::Sender<SensorStatus>,
    subscribers: [AtomicUsize; Stream::COUNT],
    pub clients: AtomicUsize,
    next_client_id: AtomicU64,
    pub client_slots: Arc<Semaphore>,
    pub bytes_sent: AtomicU64,
    pub messages_sent: AtomicU64,
    metrics: Mutex<Metrics>,
    pub started: Instant,
    stop: AtomicBool,
}

impl Hub {
    pub fn new(cfg: Arc<Config>) -> Arc<Hub> {
        let max_clients = cfg.max_clients;
        Arc::new(Hub {
            cfg,
            frames: watch::Sender::new(None),
            params: watch::Sender::new(None),
            sensor: watch::Sender::new(SensorStatus {
                state: SensorState::Offline,
                detail: "starting".to_string(),
                since_unix_ms: now_us() / 1000,
            }),
            subscribers: std::array::from_fn(|_| AtomicUsize::new(0)),
            clients: AtomicUsize::new(0),
            next_client_id: AtomicU64::new(1),
            client_slots: Arc::new(Semaphore::new(max_clients)),
            bytes_sent: AtomicU64::new(0),
            messages_sent: AtomicU64::new(0),
            metrics: Mutex::new(Metrics::default()),
            started: Instant::now(),
            stop: AtomicBool::new(false),
        })
    }

    /// Metrics lock that survives a panic of a previous holder.
    pub fn metrics(&self) -> MutexGuard<'_, Metrics> {
        self.metrics.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn stopping(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    pub fn next_client_id(&self) -> u64 {
        self.next_client_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn subscribers(&self, stream: Stream) -> usize {
        self.subscribers.get(stream.index()).map_or(0, |c| c.load(Ordering::Relaxed))
    }

    pub fn subscribe(&self, stream: Stream) {
        if let Some(c) = self.subscribers.get(stream.index()) {
            c.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn unsubscribe(&self, stream: Stream) {
        if let Some(c) = self.subscribers.get(stream.index()) {
            // never wraps below zero, even if bookkeeping were ever off
            let _ = c.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| Some(v.saturating_sub(1)));
        }
    }

    pub fn set_sensor(&self, state: SensorState, detail: &str) {
        self.sensor.send_if_modified(|s| {
            if s.state == state && s.detail == detail {
                return false;
            }
            if s.state != state {
                s.since_unix_ms = now_us() / 1000;
            }
            s.state = state;
            s.detail = detail.to_string();
            true
        });
    }

    pub fn status_json(&self) -> Value {
        let sensor = self.sensor.borrow().clone();
        let frame = self.frames.borrow().as_ref().map(|f| {
            json!({
                "seq": f.seq,
                "age_ms": now_us().saturating_sub(f.capture_time_us) / 1000,
                "stats": &f.stats,
            })
        });
        let subscribers: serde_json::Map<String, Value> =
            Stream::ALL.iter().map(|s| (s.name().to_string(), json!(self.subscribers(*s)))).collect();
        let m = self.metrics();
        let round = |v: f64| (v * 100.0).round() / 100.0;
        json!({
            "type": "status",
            "server_time_us": now_us(),
            "uptime_s": self.started.elapsed().as_secs(),
            "source": self.cfg.source.name(),
            "sensor": sensor,
            "fps": round(m.fps),
            "frames": m.frames_in,
            "last_seq": m.last_seq,
            "seq_gaps": m.seq_gaps,
            "frame": frame,
            "latency_ms": { "worker_to_hub": round(m.transfer_ms), "processing": round(m.process_ms) },
            "worker": {
                "pid": m.worker_pid,
                "uptime_s": m.worker_started.map(|t| t.elapsed().as_secs()),
                "restarts": m.worker_restarts,
                "last_exit": m.last_worker_exit,
                "heartbeat": m.worker_heartbeat,
            },
            "clients": self.clients.load(Ordering::Relaxed),
            "max_clients": self.cfg.max_clients,
            "subscribers": subscribers,
            "sent": {
                "messages": self.messages_sent.load(Ordering::Relaxed),
                "bytes": self.bytes_sent.load(Ordering::Relaxed),
            },
            "errors": {
                "panics_caught": m.panics_caught,
                "protocol": m.protocol_errors,
                "frames": m.frame_errors,
            },
        })
    }
}

/// Resolves once shutdown was requested (Ctrl+C / console closed).
#[derive(Clone)]
pub struct Shutdown(watch::Receiver<bool>);

impl Shutdown {
    pub fn new() -> (watch::Sender<bool>, Shutdown) {
        let (tx, rx) = watch::channel(false);
        (tx, Shutdown(rx))
    }

    pub fn is_set(&self) -> bool {
        *self.0.borrow()
    }

    pub async fn wait(mut self) {
        if self.0.wait_for(|stop| *stop).await.is_err() {
            // the sender is gone without a shutdown request: never treat that as one
            std::future::pending::<()>().await;
        }
    }
}
