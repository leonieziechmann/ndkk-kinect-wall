//! Poses of the people in front of the sensor: YOLO11n-pose (yolo.rs) on the infrared image,
//! natively with ONNX Runtime on the GPU through DirectML, once for every client (stream `poses`,
//! `GET /api/poses`). Measured against the browser in kinect-hub/pose-bench: a third of the GPU time
//! per pose, the same poses.
//!
//! - A thread of its own takes the newest frame whenever the next pose is due (--pose-hz, default
//!   15 Hz); the frames never wait for it. It only runs while someone wants poses. While the
//!   person tracker runs (tracking.rs), the tracker hands it the frames instead (submit()): it must
//!   know which frame a pose belongs to before it processes that frame.
//! - Two model sizes: when the full model (512x448) runs late for the target rate, the smaller one
//!   (384x320) takes over. Every few seconds the full one is tried again (its pose counts as well)
//!   and comes back once it fits with room to spare. Every pose says which model made it.
//! - ONNX Runtime is a DLL loaded at run time (setup-onnxruntime.ps1). Without it, without a model,
//!   or if DirectML fails, the hub runs on without poses, says why in /api/status and tries again
//!   every 10 s (so the DLL or a new model can be added while the hub runs).

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use axum::extract::ws::Utf8Bytes;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::runtime::Handle;
use tracing::{error, info, warn};

use crate::config::PoseDevice;
use crate::protocol::{Stream, payload};
use crate::source::{panic_message, sleep_unless_stopping};
use crate::state::{FrameSet, Hub, now_us};
use crate::yolo::{Device, Model, Pose};

/// Wait after a failed start before the next attempt.
const RETRY: Duration = Duration::from_secs(10);
/// A full-model run slower than this share of the period counts as late ...
const LATE: f64 = 0.9;
/// ... and this many late runs in a row switch to the small model.
const LATE_RUNS: u32 = 5;
/// While on the small model, the full one is tried this often ...
const PROBE_EVERY: Duration = Duration::from_secs(3);
/// ... and comes back after this many tries in a row faster than this share of the period.
const FITS: f64 = 0.6;
const FIT_PROBES: u32 = 3;
/// `GET /api/poses` keeps the model running this long for scripts that poll it.
const HTTP_LEASE: Duration = Duration::from_secs(5);

/// The poses of one frame, ready to send.
pub struct PoseSet {
    /// the frame they were computed on
    pub seq: u32,
    pub capture_time_us: u64,
    pub poses: Vec<Pose>,
    /// ms the model took
    pub ms: f64,
    /// `{"type":"poses",...}` text message (shared, cloning is free).
    pub json: Utf8Bytes,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ModelInfo {
    pub size: String,
    pub file: String,
    /// ms per run measured right after loading (GPU without the scenes' load)
    pub warm_ms: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct PoseStatus {
    /// off · loading · idle (nobody wants poses) · running · error
    pub state: &'static str,
    pub detail: String,
    pub device: &'static str,
    pub models: Vec<ModelInfo>,
    /// the model in use ("512x448")
    pub active: Option<String>,
    pub target_hz: f64,
    /// poses per second, and ms per run of the active model (moving averages)
    pub hz: f64,
    pub ms: f64,
    pub runs: u64,
    pub switches: u64,
    pub last_switch: Option<String>,
}

/// What the hub keeps about the pose model.
pub struct PoseState {
    status: Mutex<PoseStatus>,
    http_lease: Mutex<Option<Instant>>,
    /// set by the person tracker while it runs: it then hands the frames in (submit)
    pub wanted_inside: AtomicBool,
    /// the model is loaded and takes frames
    ready: AtomicBool,
    /// a frame handed in is being worked on (one at a time)
    busy: AtomicBool,
    job: Mutex<Option<Arc<FrameSet>>>,
    job_ready: Condvar,
    /// when the next pose is due (the target rate)
    next_due: Mutex<Instant>,
}

impl PoseState {
    pub fn new(target_hz: f64, device: PoseDevice) -> PoseState {
        let off = device == PoseDevice::Off;
        PoseState {
            status: Mutex::new(PoseStatus {
                state: if off { "off" } else { "loading" },
                detail: if off { "--pose off".to_string() } else { String::new() },
                device: match device {
                    PoseDevice::DirectMl => "directml",
                    PoseDevice::Cpu => "cpu",
                    PoseDevice::Off => "off",
                },
                models: Vec::new(),
                active: None,
                target_hz,
                hz: 0.0,
                ms: 0.0,
                runs: 0,
                switches: 0,
                last_switch: None,
            }),
            http_lease: Mutex::new(None),
            wanted_inside: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            busy: AtomicBool::new(false),
            job: Mutex::new(None),
            job_ready: Condvar::new(),
            next_due: Mutex::new(Instant::now()),
        }
    }

    /// The model is loaded and takes frames (submit).
    pub fn available(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    /// No frame is being worked on, and the next pose is due.
    pub fn idle_and_due(&self) -> bool {
        !self.busy.load(Ordering::SeqCst) && Instant::now() >= *self.next_due.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Hands a frame to the model (the tracker does, see the module notes); false if the model
    /// is not loaded or still busy. Its poses come on Hub::poses with that frame's seq.
    pub fn submit(&self, frame: Arc<FrameSet>) -> bool {
        if !self.available() || self.busy.swap(true, Ordering::SeqCst) {
            return false;
        }
        *self.job.lock().unwrap_or_else(PoisonError::into_inner) = Some(frame);
        self.job_ready.notify_one();
        true
    }

    /// The frame handed in, waiting up to `timeout` for one.
    fn take_job(&self, timeout: Duration) -> Option<Arc<FrameSet>> {
        let guard = self.job.lock().unwrap_or_else(PoisonError::into_inner);
        let (mut guard, _) = self.job_ready.wait_timeout_while(guard, timeout, |j| j.is_none()).unwrap_or_else(PoisonError::into_inner);
        guard.take()
    }

    fn set_ready(&self, ready: bool) {
        self.ready.store(ready, Ordering::SeqCst);
        if !ready {
            self.busy.store(false, Ordering::SeqCst);
            self.job.lock().unwrap_or_else(PoisonError::into_inner).take();
        }
    }

    pub fn status(&self) -> MutexGuard<'_, PoseStatus> {
        self.status.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn status_json(&self) -> Value {
        json!(*self.status())
    }

    /// An HTTP client asked for poses: keep the model running for a while.
    pub fn touch_http(&self) {
        *self.http_lease.lock().unwrap_or_else(PoisonError::into_inner) = Some(Instant::now() + HTTP_LEASE);
    }

    fn http_wanted(&self) -> bool {
        self.http_lease.lock().unwrap_or_else(PoisonError::into_inner).is_some_and(|until| Instant::now() < until)
    }

    fn set_state(&self, state: &'static str, detail: impl Into<String>) {
        let mut s = self.status();
        s.state = state;
        s.detail = detail.into();
    }
}

impl Hub {
    /// Someone wants poses: a WebSocket client, an HTTP client of late, or the hub itself.
    pub fn poses_wanted(&self) -> bool {
        self.subscribers(Stream::Poses) > 0 || self.pose.http_wanted() || self.pose.wanted_inside.load(Ordering::Relaxed)
    }
}

pub struct PoseHandle {
    thread: Option<JoinHandle<()>>,
}

impl PoseHandle {
    pub async fn stop(mut self, timeout: Duration) {
        let Some(thread) = self.thread.take() else { return };
        let joined = tokio::task::spawn_blocking(move || thread.join());
        match tokio::time::timeout(timeout, joined).await {
            Ok(Ok(Ok(()))) => info!("pose model stopped"),
            Ok(_) => warn!("pose thread ended abnormally"),
            Err(_) => warn!("pose thread did not stop within {timeout:?}"),
        }
    }
}

/// Starts the pose thread (it ends when the hub stops). `rt` lets it wait for frames.
pub fn spawn(hub: Arc<Hub>, rt: Handle) -> PoseHandle {
    if hub.cfg.pose == PoseDevice::Off {
        info!("pose model off (--pose off)");
        return PoseHandle { thread: None };
    }
    let thread = thread::Builder::new()
        .name("pose".to_string())
        .spawn(move || run(&hub, &rt))
        .map_err(|e| error!("cannot start the pose thread: {e}"))
        .ok();
    PoseHandle { thread }
}

fn run(hub: &Arc<Hub>, rt: &Handle) {
    while !hub.stopping() {
        let result = catch_unwind(AssertUnwindSafe(|| serve(hub, rt)));
        hub.pose.set_ready(false);
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                warn!("pose model: {e} (trying again in {} s)", RETRY.as_secs());
                hub.pose.set_state("error", e);
                sleep_unless_stopping(hub, RETRY);
            }
            Err(p) => {
                let msg = panic_message(p.as_ref());
                error!("pose thread crashed ({msg}), restarting it");
                hub.metrics().panics_caught += 1;
                hub.pose.set_state("error", format!("crashed: {msg}"));
                sleep_unless_stopping(hub, RETRY);
            }
        }
    }
}

/// ONNX Runtime is loaded once per process; a failed attempt can be repeated.
fn load_runtime(hub: &Hub) -> Result<(), String> {
    static LOADED: AtomicBool = AtomicBool::new(false);
    if LOADED.load(Ordering::SeqCst) {
        return Ok(());
    }
    let dll = hub.cfg.onnxruntime_path().ok_or(
        "onnxruntime.dll not found: run kinect-hub/setup-onnxruntime.ps1 once (or pass --onnxruntime)",
    )?;
    ort::init_from(&dll).map_err(|e| format!("cannot load ONNX Runtime: {e}"))?.commit();
    info!("ONNX Runtime loaded from {}", dll.display());
    LOADED.store(true, Ordering::SeqCst);
    Ok(())
}

fn device(hub: &Hub) -> Device {
    match hub.cfg.pose {
        PoseDevice::Cpu => Device::Cpu(3),
        PoseDevice::DirectMl | PoseDevice::Off => Device::DirectMl(0),
    }
}

/// Loads a model and runs it twice on an empty frame (the first run compiles the GPU programs);
/// returns it with the time of the second run.
fn warm(file: &std::path::Path, device: Device) -> Result<(Model, f64), String> {
    if !file.is_file() {
        return Err(format!("pose model {} not found", file.display()));
    }
    let mut m = Model::load(file, device)?;
    let empty = vec![0_u8; crate::protocol::PIXELS];
    m.run(&empty)?;
    let t = Instant::now();
    m.run(&empty)?;
    Ok((m, t.elapsed().as_secs_f64() * 1000.0))
}

/// Which model the next run uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Pick {
    Full,
    Fast,
    /// the full model, tried while the small one is in use
    Probe,
}

/// Paces the runs and chooses the model, with hysteresis.
struct Scheduler {
    period: Option<Duration>,
    has_fast: bool,
    on_fast: bool,
    late: u32,
    fits: u32,
    last_probe: Instant,
    next_due: Instant,
}

impl Scheduler {
    fn new(hz: f64, has_fast: bool) -> Scheduler {
        let period = (hz > 0.0).then(|| Duration::from_secs_f64(1.0 / hz));
        Scheduler { period, has_fast, on_fast: false, late: 0, fits: 0, last_probe: Instant::now(), next_due: Instant::now() }
    }

    fn pick(&mut self) -> Pick {
        if !self.on_fast {
            return Pick::Full;
        }
        if self.last_probe.elapsed() >= PROBE_EVERY {
            self.last_probe = Instant::now();
            return Pick::Probe;
        }
        Pick::Fast
    }

    /// A run took `ms`; returns a description when the model changes.
    fn record(&mut self, pick: Pick, ms: f64) -> Option<String> {
        let now = Instant::now();
        let period = self.period?;
        // the next run is due one period after this one was; a late run is not made up for
        self.next_due = (self.next_due + period).max(now);
        let p = period.as_secs_f64() * 1000.0;
        match pick {
            Pick::Full if self.has_fast => {
                self.late = if ms > LATE * p { self.late + 1 } else { self.late.saturating_sub(1) };
                if self.late >= LATE_RUNS {
                    (self.on_fast, self.late, self.fits, self.last_probe) = (true, 0, 0, now);
                    return Some(format!("small model: the full one took {ms:.0} ms, {p:.0} ms per pose wanted"));
                }
            }
            Pick::Probe => {
                self.fits = if ms < FITS * p { self.fits + 1 } else { 0 };
                if self.fits >= FIT_PROBES {
                    (self.on_fast, self.late, self.fits) = (false, 0, 0);
                    return Some(format!("full model again: {ms:.0} ms fits {p:.0} ms per pose"));
                }
            }
            Pick::Full | Pick::Fast => {}
        }
        None
    }
}

/// Loads the models and serves poses until the hub stops (Ok) or something breaks (Err: the
/// caller starts over).
fn serve(hub: &Arc<Hub>, rt: &Handle) -> Result<(), String> {
    hub.pose.set_state("loading", "loading ONNX Runtime");
    load_runtime(hub)?;
    let device = device(hub);
    let full_file = hub.cfg.pose_model_path().ok_or("no pose model (web/ directory not found; pass --pose-model)")?;
    hub.pose.set_state("loading", format!("loading {}", full_file.display()));
    let (mut full, full_ms) = warm(&full_file, device)?;
    let mut fast = None;
    if let Some(file) = hub.cfg.pose_model_fast_path() {
        match warm(&file, device) {
            Ok((m, ms)) => fast = Some((m, ms)),
            Err(e) => warn!("small pose model not used: {e}"),
        }
    }
    let info = |m: &Model, ms: f64| ModelInfo { size: m.size_name(), file: m.file.display().to_string(), warm_ms: (ms * 10.0).round() / 10.0 };
    let mut models = vec![info(&full, full_ms)];
    if let Some((m, ms)) = &fast {
        models.push(info(m, *ms));
    }
    info!(
        "pose model ready on {}: {}",
        device.name(),
        models.iter().map(|m| format!("{} ({:.1} ms)", m.size, m.warm_ms)).collect::<Vec<_>>().join(", ")
    );
    {
        let mut s = hub.pose.status();
        s.models = models;
        s.active = Some(full.size_name());
    }
    hub.pose.set_state("idle", "nobody wants poses");
    hub.pose.set_ready(true);

    let mut fast = fast.map(|(m, _)| m);
    let mut sched = Scheduler::new(hub.cfg.pose_hz, fast.is_some());
    let mut frames = hub.frames.subscribe();
    let mut last_seq: Option<u32> = None;
    let (mut ema_ms, mut ema_hz, mut last_run) = (0.0_f64, 0.0_f64, None::<Instant>);
    let mut idle = true;
    while !hub.stopping() {
        if !hub.poses_wanted() {
            if !idle {
                hub.pose.set_state("idle", "nobody wants poses");
                idle = true;
            }
            sleep_unless_stopping(hub, Duration::from_millis(100));
            continue;
        }
        if idle {
            hub.pose.set_state("running", "");
            idle = false;
            last_run = None;
        }
        let driven = hub.pose.wanted_inside.load(Ordering::Relaxed);
        let frame = if driven {
            // the tracker hands the frames in when a pose is due
            match hub.pose.take_job(Duration::from_millis(100)) {
                Some(f) => f,
                None => continue,
            }
        } else {
            if let Some(wait) = sched.next_due.checked_duration_since(Instant::now()) {
                sleep_unless_stopping(hub, wait);
            }
            match newest_frame(hub, rt, &mut frames, last_seq) {
                Some(f) => f,
                None => continue,
            }
        };
        let Some(ir) = frame.ir.as_ref().map(payload) else {
            hub.pose.busy.store(false, Ordering::SeqCst);
            continue;
        };
        let pick = sched.pick();
        let model = match (pick, fast.as_mut()) {
            (Pick::Fast, Some(m)) => m,
            _ => &mut full,
        };
        let t = Instant::now();
        let poses = model.run(&ir)?;
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        let size = model.size_name();
        last_seq = Some(frame.seq);
        let switched = sched.record(pick, ms);
        *hub.pose.next_due.lock().unwrap_or_else(PoisonError::into_inner) = sched.next_due;
        publish(hub, &frame, &size, ms, poses);
        hub.pose.busy.store(false, Ordering::SeqCst);

        let ema = |old: f64, new: f64| if old == 0.0 { new } else { 0.8 * old + 0.2 * new };
        if pick != Pick::Probe {
            ema_ms = ema(ema_ms, ms);
        }
        if let Some(prev) = last_run {
            let dt = prev.elapsed().as_secs_f64();
            if dt > 0.0 {
                ema_hz = ema(ema_hz, 1.0 / dt);
            }
        }
        last_run = Some(Instant::now());
        let mut s = hub.pose.status();
        s.runs += 1;
        s.ms = (ema_ms * 10.0).round() / 10.0;
        s.hz = (ema_hz * 10.0).round() / 10.0;
        if let Some(why) = switched {
            info!("pose model: {why}");
            s.switches += 1;
            s.last_switch = Some(why);
            s.active = Some(if sched.on_fast { fast.as_ref().map_or_else(|| full.size_name(), Model::size_name) } else { full.size_name() });
            ema_ms = 0.0;
        }
    }
    Ok(())
}

/// The newest frame with infrared that has no poses yet; waits up to half a second for one.
fn newest_frame(
    hub: &Hub,
    rt: &Handle,
    frames: &mut tokio::sync::watch::Receiver<Option<Arc<FrameSet>>>,
    last_seq: Option<u32>,
) -> Option<Arc<FrameSet>> {
    let fresh = |f: &Option<Arc<FrameSet>>| f.as_ref().filter(|f| f.ir.is_some() && Some(f.seq) != last_seq).cloned();
    if let Some(f) = fresh(&frames.borrow_and_update()) {
        return Some(f);
    }
    if hub.stopping() {
        return None;
    }
    // the timer must be made inside the runtime: inside the async block, not before it
    let changed = rt.block_on(async { tokio::time::timeout(Duration::from_millis(500), frames.changed()).await });
    match changed {
        Ok(Ok(())) => fresh(&frames.borrow_and_update()),
        _ => None,
    }
}

/// Rounded in f64, so the JSON says 75.13 and not 75.12999725341797.
fn round(v: f32, scale: f64) -> f64 {
    (f64::from(v) * scale).round() / scale
}

fn publish(hub: &Hub, frame: &FrameSet, model: &str, ms: f64, poses: Vec<Pose>) {
    let list: Vec<Value> = poses
        .iter()
        .map(|p| {
            json!({
                "score": round(p.score, 1000.0),
                "box": p.bbox.map(|v| round(v, 100.0)),
                // u, v rounded to 0.01 px, confidence to 0.001
                "kp": p.kp.as_chunks::<3>().0.iter().flat_map(|[u, v, c]| [round(*u, 100.0), round(*v, 100.0), round(*c, 1000.0)]).collect::<Vec<_>>(),
            })
        })
        .collect();
    let json = json!({
        "type": "poses",
        "seq": frame.seq,
        "capture_time_us": frame.capture_time_us,
        "publish_time_us": now_us(),
        "model": model,
        "ms": (ms * 10.0).round() / 10.0,
        "poses": list,
    })
    .to_string()
    .into();
    hub.poses.send_replace(Some(Arc::new(PoseSet { seq: frame.seq, capture_time_us: frame.capture_time_us, poses, ms, json })));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switches_down_after_late_runs_and_back_after_good_probes() {
        let mut s = Scheduler::new(15.0, true); // 66.7 ms per pose
        for _ in 0..LATE_RUNS - 1 {
            assert_eq!(s.pick(), Pick::Full);
            assert!(s.record(Pick::Full, 70.0).is_none());
        }
        assert!(s.record(Pick::Full, 70.0).is_some());
        assert!(s.on_fast);
        assert_eq!(s.pick(), Pick::Fast);
        // probes that do not fit keep the small model
        s.last_probe = Instant::now() - PROBE_EVERY;
        assert_eq!(s.pick(), Pick::Probe);
        assert!(s.record(Pick::Probe, 50.0).is_none());
        for _ in 0..FIT_PROBES - 1 {
            assert!(s.record(Pick::Probe, 30.0).is_none());
        }
        assert!(s.record(Pick::Probe, 30.0).is_some());
        assert!(!s.on_fast);
    }

    #[test]
    fn one_late_run_does_not_switch() {
        let mut s = Scheduler::new(15.0, true);
        for _ in 0..20 {
            assert!(s.record(Pick::Full, 70.0).is_none());
            assert!(s.record(Pick::Full, 30.0).is_none());
        }
        assert!(!s.on_fast);
    }

    #[test]
    fn without_a_target_rate_it_never_switches() {
        let mut s = Scheduler::new(0.0, true);
        for _ in 0..20 {
            assert!(s.record(Pick::Full, 500.0).is_none());
        }
        assert!(!s.on_fast);
    }
}
