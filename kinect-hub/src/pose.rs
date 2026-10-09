//! Poses of the people in front of the sensor: YOLO11-pose (yolo.rs) on the infrared image,
//! natively with ONNX Runtime on the GPU through DirectML, once for every client (stream `poses`,
//! `GET /api/poses`). Measured against the browser in kinect-hub/pose-bench: a third of the GPU time
//! per pose, the same poses.
//!
//! - A thread of its own takes the newest frame whenever the next pose is due (--pose-hz, default
//!   15 Hz); the frames never wait for it. It only runs while someone wants poses. While the
//!   person tracker runs (tracking.rs), the tracker hands it the frames instead (submit()): it must
//!   know which frame a pose belongs to before it processes that frame.
//! - A ladder of models, best first (--pose-models, e.g. YOLO11s 512, YOLO11s 384, YOLO11n 384), all
//!   loaded at the start: the hub runs the best one that keeps the target rate. When the one in use
//!   gets too slow, the next one takes over; every few seconds the next better one is tried (its
//!   pose counts as well) and takes over once it fits with room to spare. Every pose says which
//!   model made it.
//! - The scenes come first: while a visible page renders slower than it wants (render.rs), the
//!   next cheaper model takes over and no better one is tried.
//! - Nobody in front of the sensor (no pose found anybody for a while and the tracker follows
//!   nobody): a few poses a second (--pose-idle-hz) with the cheapest model, until the tracker sees
//!   something new in front of the background, which wakes the model at once.
//! - ONNX Runtime is a DLL loaded at run time (setup-onnxruntime.ps1). Without it, without a model,
//!   or if DirectML fails, the hub runs on without poses, says why in /api/status and tries again
//!   every 10 s (so the DLL or a new model can be added while the hub runs).

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
/// The model in use hands over to the next one when its runs take longer than this share of the
/// period on average ...
const DOWN: f64 = 0.95;
/// ... once it ran this often since it took over.
const DOWN_RUNS: u32 = 8;
/// Meanwhile the next better model is tried now and then; it takes over after this many tries in
/// a row faster than this share of the period.
const UP: f64 = 0.85;
const UP_PROBES: u32 = 2;
/// Wait between tries at first ...
const PROBE_EVERY: Duration = Duration::from_secs(3);
/// ... and longer (up to this) after tries that failed or a takeover that did not last.
const PROBE_MAX: Duration = Duration::from_secs(30);
/// A model that hands over this soon after it took over did not last ...
const FLIP: Duration = Duration::from_secs(20);
/// ... one that ran this long did: its tries start over at PROBE_EVERY.
const STAY: Duration = Duration::from_secs(60);
/// A visible page too slow for this long hands over to the next cheaper model ...
const PRESSURE_FOR: Duration = Duration::from_secs(2);
/// ... and no better one is tried until this long after the last slow report.
const PRESSURE_HOLD: Duration = Duration::from_secs(8);
/// No pose found anybody for this long (and the tracker follows nobody): the room is empty.
const EMPTY_AFTER: Duration = Duration::from_secs(2);
/// A wake (something new in front of the background) runs the model at most this often.
const WAKE_GAP: Duration = Duration::from_millis(150);
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
    /// short name, e.g. "s@384" (YOLO11s with a 384 px wide input)
    pub name: String,
    pub size: String,
    pub file: String,
    /// ms per run measured right after loading (GPU without the scenes' load)
    pub warm_ms: f64,
    /// ms per run of late (average; 0 = not run yet)
    pub ms: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct PoseStatus {
    /// off · loading · idle (nobody wants poses) · running · error
    pub state: &'static str,
    pub detail: String,
    pub device: &'static str,
    pub models: Vec<ModelInfo>,
    /// the model in use (its name, e.g. "s@384")
    pub active: Option<String>,
    pub target_hz: f64,
    /// poses at the slow rate: nobody in front of the sensor
    pub quiet: bool,
    pub idle_hz: f64,
    /// the visible page that renders too slowly, while it does (the pose model gives way)
    pub pressure: Option<String>,
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
    /// when the last run started (wake() keeps WAKE_GAP to it)
    last_start: Mutex<Instant>,
    /// persons the tracker follows (visible), 0 without the tracker
    pub tracked: AtomicUsize,
}

impl PoseState {
    pub fn new(target_hz: f64, idle_hz: f64, device: PoseDevice) -> PoseState {
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
                quiet: false,
                idle_hz,
                pressure: None,
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
            last_start: Mutex::new(Instant::now()),
            tracked: AtomicUsize::new(0),
        }
    }

    /// Something new in front of the background (the tracker): while the room is quiet, the next
    /// pose is due now (at most every WAKE_GAP).
    pub fn wake(&self) {
        let soonest = *self.last_start.lock().unwrap_or_else(PoisonError::into_inner) + WAKE_GAP;
        let mut due = self.next_due.lock().unwrap_or_else(PoisonError::into_inner);
        *due = (*due).min(soonest.max(Instant::now()));
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

/// A short name for a model: "s@384" for yolo11s-pose-384x320-fp16.onnx (input 384x320), else
/// the file name.
fn label(file: &std::path::Path, size: &str) -> String {
    let stem = file.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let width = size.split('x').next().unwrap_or(size);
    match stem.find("yolo11").and_then(|i| stem.get(i + 6..i + 7)) {
        Some(v) if v.chars().all(|c| c.is_ascii_lowercase()) && !v.is_empty() => format!("{v}@{width}"),
        _ => stem,
    }
}

/// Which model the next run uses: its level (0 = the best) and whether it is a try of a better one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Pick {
    level: usize,
    probe: bool,
}

/// Paces the runs and picks the best model that keeps the target rate, with hysteresis.
struct Scheduler {
    period: Option<Duration>,
    /// the model in use: its level, 0 = the best
    cur: usize,
    /// ms per run of each model (moving average; 0 = not run yet)
    avg: Vec<f64>,
    /// wait between tries of each model while a worse one runs
    wait: Vec<Duration>,
    /// runs of the model in use since it took over, and when that was
    runs: u32,
    since: Instant,
    /// tries of the next better model in a row that fit
    fits: u32,
    last_probe: Instant,
    next_due: Instant,
    /// the room is empty: runs at the idle period, the models stay as they are
    quiet: bool,
    idle_period: Option<Duration>,
    /// since when a visible page has been too slow without a break, and when it last was
    pressure_since: Option<Instant>,
    last_pressure: Option<Instant>,
}

impl Scheduler {
    fn new(hz: f64, idle_hz: f64, levels: usize) -> Scheduler {
        let period = (hz > 0.0).then(|| Duration::from_secs_f64(1.0 / hz));
        let idle_period = (idle_hz > 0.0 && (hz <= 0.0 || idle_hz < hz)).then(|| Duration::from_secs_f64(1.0 / idle_hz));
        let n = levels.max(1);
        let now = Instant::now();
        Scheduler {
            period,
            cur: 0,
            avg: vec![0.0; n],
            wait: vec![PROBE_EVERY; n],
            runs: 0,
            since: now,
            fits: 0,
            last_probe: now,
            next_due: now,
            quiet: false,
            idle_period,
            pressure_since: None,
            last_pressure: None,
        }
    }

    /// A visible page renders too slowly: no better model is tried meanwhile.
    fn held_back(&self) -> bool {
        self.last_pressure.is_some_and(|t| t.elapsed() < PRESSURE_HOLD)
    }

    fn pick(&mut self) -> Pick {
        // nobody there: the cheapest model (a newcomer is found soonest, the GPU stays free); the
        // ladder goes on where it was once someone comes
        if self.quiet {
            return Pick { level: self.avg.len().saturating_sub(1), probe: false };
        }
        if self.period.is_some() && self.cur > 0 && !self.held_back() {
            let up = self.cur - 1;
            if self.last_probe.elapsed() >= self.wait.get(up).copied().unwrap_or(PROBE_EVERY) {
                self.last_probe = Instant::now();
                return Pick { level: up, probe: true };
            }
        }
        Pick { level: self.cur, probe: false }
    }

    /// A run took `ms` (`pressure`: a visible page renders too slowly); returns why when the
    /// model in use changes (see `cur`).
    fn record(&mut self, pick: Pick, ms: f64, pressure: Option<&str>) -> Option<String> {
        let now = Instant::now();
        let Some(period) = self.period else {
            if let Some(a) = self.avg.get_mut(pick.level) {
                *a = if *a == 0.0 { ms } else { 0.85 * *a + 0.15 * ms };
            }
            return None;
        };
        // the next run is due one period after this one was due (or started, when it was woken
        // early); a late run is not made up for
        let pace = if self.quiet { self.idle_period.unwrap_or(period) } else { period };
        self.next_due = (self.next_due.min(now) + pace).max(now);
        if self.quiet {
            // nobody there: the runs are rare and slow (the GPU clocks down), not a measure
            self.pressure_since = None;
            return None;
        }
        if let Some(a) = self.avg.get_mut(pick.level) {
            *a = if *a == 0.0 { ms } else { 0.85 * *a + 0.15 * ms };
        }
        let p = period.as_secs_f64() * 1000.0;
        // the scenes first: a page too slow for a while hands over to the next cheaper model
        match pressure {
            Some(why) => {
                self.last_pressure = Some(now);
                let since = *self.pressure_since.get_or_insert(now);
                if !pick.probe && self.cur + 1 < self.avg.len() && self.runs >= DOWN_RUNS && now.saturating_duration_since(since) >= PRESSURE_FOR {
                    return Some(self.step_down(now, format!("{why} (the scene first)")));
                }
            }
            None => self.pressure_since = None,
        }
        if pick.probe {
            if ms < UP * p {
                self.fits += 1;
            } else {
                self.fits = 0;
                if let Some(w) = self.wait.get_mut(pick.level) {
                    *w = w.mul_f64(1.25).min(PROBE_MAX);
                }
            }
            if self.fits < UP_PROBES {
                return None;
            }
            (self.cur, self.runs, self.since, self.fits) = (pick.level, 0, now, 0);
            return Some(format!("{ms:.0} ms fits {p:.0} ms per pose"));
        }
        self.runs += 1;
        let avg = self.avg.get(self.cur).copied().unwrap_or(0.0);
        if self.cur + 1 >= self.avg.len() || self.runs < DOWN_RUNS || avg <= DOWN * p {
            return None;
        }
        Some(self.step_down(now, format!("{avg:.0} ms per run, {p:.0} ms per pose wanted")))
    }

    /// The next cheaper model takes over.
    fn step_down(&mut self, now: Instant, why: String) -> String {
        // a takeover that did not last: try that model less often; after a long stay as at first
        let stayed = now.saturating_duration_since(self.since);
        if let Some(w) = self.wait.get_mut(self.cur) {
            if stayed < FLIP {
                *w = w.mul_f64(2.0).min(PROBE_MAX);
            } else if stayed >= STAY {
                *w = PROBE_EVERY;
            }
        }
        (self.cur, self.runs, self.since, self.fits, self.last_probe, self.pressure_since) = (self.cur + 1, 0, now, 0, now, None);
        why
    }
}

/// Loads the models and serves poses until the hub stops (Ok) or something breaks (Err: the
/// caller starts over).
fn serve(hub: &Arc<Hub>, rt: &Handle) -> Result<(), String> {
    hub.pose.set_state("loading", "loading ONNX Runtime");
    load_runtime(hub)?;
    let device = device(hub);
    let files = hub.cfg.pose_model_paths();
    if files.is_empty() {
        return Err("no pose model (web/ directory not found; pass --pose-models)".to_string());
    }
    let mut models: Vec<Model> = Vec::new();
    let mut infos: Vec<ModelInfo> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    for file in &files {
        hub.pose.set_state("loading", format!("loading {}", file.display()));
        match warm(file, device) {
            Ok((m, ms)) => {
                let size = m.size_name();
                infos.push(ModelInfo { name: label(&m.file, &size), size, file: m.file.display().to_string(), warm_ms: (ms * 10.0).round() / 10.0, ms: 0.0 });
                models.push(m);
            }
            Err(e) => {
                warn!("pose model not used: {e}");
                failed.push(e);
            }
        }
    }
    if models.is_empty() {
        return Err(failed.join("; "));
    }
    let names: Vec<String> = infos.iter().map(|m| m.name.clone()).collect();
    info!(
        "pose models ready on {}, best first: {}",
        device.name(),
        infos.iter().map(|m| format!("{} ({:.1} ms)", m.name, m.warm_ms)).collect::<Vec<_>>().join(", ")
    );
    {
        let mut s = hub.pose.status();
        s.models = infos;
        s.active = names.first().cloned();
    }
    hub.pose.set_state("idle", "nobody wants poses");
    hub.pose.set_ready(true);

    let mut sched = Scheduler::new(hub.cfg.pose_hz, hub.cfg.pose_idle_hz, models.len());
    let mut last_person = Instant::now();
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
        // nobody there: no pose found anybody for a while, and the tracker follows nobody
        sched.quiet = sched.idle_period.is_some() && hub.pose.tracked.load(Ordering::Relaxed) == 0 && last_person.elapsed() > EMPTY_AFTER;
        let pick = sched.pick();
        let model = models.get_mut(pick.level).ok_or("no pose model at that level")?;
        let t = Instant::now();
        *hub.pose.last_start.lock().unwrap_or_else(PoisonError::into_inner) = t;
        let poses = model.run(&ir)?;
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        if !poses.is_empty() {
            last_person = Instant::now();
        }
        let name = names.get(pick.level).cloned().unwrap_or_default();
        last_seq = Some(frame.seq);
        let before = sched.cur;
        let pressure = hub.render.pressure();
        let switched = sched.record(pick, ms, pressure.as_deref());
        *hub.pose.next_due.lock().unwrap_or_else(PoisonError::into_inner) = sched.next_due;
        publish(hub, &frame, &name, ms, poses);
        hub.pose.busy.store(false, Ordering::SeqCst);

        let ema = |old: f64, new: f64| if old == 0.0 { new } else { 0.8 * old + 0.2 * new };
        if !pick.probe {
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
        s.quiet = sched.quiet;
        s.pressure = pressure;
        s.ms = (ema_ms * 10.0).round() / 10.0;
        s.hz = (ema_hz * 10.0).round() / 10.0;
        for (info, avg) in s.models.iter_mut().zip(&sched.avg) {
            info.ms = (avg * 10.0).round() / 10.0;
        }
        if let Some(why) = switched {
            let from = names.get(before).map_or("?", String::as_str);
            let to = names.get(sched.cur).map_or("?", String::as_str);
            let why = format!("{from} -> {to}: {why}");
            info!("pose model: {why}");
            s.switches += 1;
            s.last_switch = Some(why);
            s.active = Some(to.to_string());
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

    const RUN: Pick = Pick { level: 0, probe: false };

    fn run(s: &mut Scheduler, ms: f64) -> Option<String> {
        let p = s.pick();
        s.record(Pick { probe: false, ..p }, ms, None)
    }

    /// Lets the next try come now.
    fn probe_now(s: &mut Scheduler) {
        s.last_probe = Instant::now() - PROBE_MAX;
    }

    #[test]
    fn steps_down_one_model_at_a_time_and_up_after_good_tries() {
        let mut s = Scheduler::new(15.0, 0.0, 3); // 66.7 ms per pose
        for _ in 0..DOWN_RUNS - 1 {
            assert!(run(&mut s, 120.0).is_none());
        }
        assert!(run(&mut s, 120.0).is_some());
        assert_eq!(s.cur, 1);
        // the next one is too slow as well: one more step, not further than the last
        for _ in 0..DOWN_RUNS {
            run(&mut s, 90.0);
        }
        assert_eq!(s.cur, 2);
        for _ in 0..3 * DOWN_RUNS {
            assert!(run(&mut s, 200.0).is_none());
        }
        assert_eq!(s.cur, 2);
        // tries of the better one: a slow one does not count, two fitting ones in a row step up
        probe_now(&mut s);
        let p = s.pick();
        assert_eq!(p, Pick { level: 1, probe: true });
        assert!(s.record(p, 70.0, None).is_none());
        for i in 0..UP_PROBES {
            probe_now(&mut s);
            let p = s.pick();
            assert_eq!(s.record(p, 40.0, None).is_some(), i + 1 == UP_PROBES);
        }
        assert_eq!(s.cur, 1);
    }

    #[test]
    fn a_slow_run_now_and_then_does_not_switch() {
        let mut s = Scheduler::new(15.0, 0.0, 2);
        for _ in 0..40 {
            assert!(s.record(RUN, 75.0, None).is_none());
            assert!(s.record(RUN, 45.0, None).is_none());
            assert!(s.record(RUN, 45.0, None).is_none());
        }
        assert_eq!(s.cur, 0);
    }

    #[test]
    fn a_takeover_that_does_not_last_backs_the_tries_off() {
        let mut s = Scheduler::new(15.0, 0.0, 2);
        for _ in 0..DOWN_RUNS {
            run(&mut s, 100.0);
        }
        assert_eq!(s.cur, 1);
        let before = s.wait.first().copied();
        // up again, and down soon after
        for _ in 0..UP_PROBES {
            probe_now(&mut s);
            let p = s.pick();
            s.record(p, 40.0, None);
        }
        assert_eq!(s.cur, 0);
        for _ in 0..2 * DOWN_RUNS {
            run(&mut s, 100.0);
        }
        assert_eq!(s.cur, 1);
        assert!(s.wait.first().copied() > before);
    }

    #[test]
    fn without_a_target_rate_it_keeps_the_best_model() {
        let mut s = Scheduler::new(0.0, 0.0, 3);
        for _ in 0..20 {
            assert_eq!(s.pick(), RUN);
            assert!(s.record(RUN, 500.0, None).is_none());
        }
        assert_eq!(s.cur, 0);
    }

    #[test]
    fn a_slow_scene_hands_over_to_the_cheaper_model_and_holds_the_tries_back() {
        let mut s = Scheduler::new(15.0, 0.0, 3);
        for _ in 0..DOWN_RUNS {
            assert!(s.record(RUN, 40.0, None).is_none()); // fits by itself
        }
        s.pressure_since = Some(Instant::now() - PRESSURE_FOR);
        let why = s.record(RUN, 40.0, Some("wall 40 of 60 fps"));
        assert!(why.is_some_and(|w| w.contains("wall")));
        assert_eq!(s.cur, 1);
        // while it lasts (and a while after) no better model is tried
        probe_now(&mut s);
        assert_eq!(s.pick(), Pick { level: 1, probe: false });
        s.last_pressure = Some(Instant::now() - PRESSURE_HOLD);
        probe_now(&mut s);
        assert_eq!(s.pick(), Pick { level: 0, probe: true });
    }

    #[test]
    fn an_empty_room_runs_at_the_idle_rate_and_keeps_the_model() {
        let mut s = Scheduler::new(15.0, 3.0, 3);
        s.quiet = true;
        let start = Instant::now();
        for _ in 0..3 * DOWN_RUNS {
            assert!(s.record(RUN, 300.0, Some("busy")).is_none());
        }
        assert_eq!(s.cur, 0, "slow runs while quiet do not count");
        assert_eq!(s.pick(), Pick { level: 2, probe: false }, "the cheapest model while quiet");
        assert!(s.next_due >= start + Duration::from_millis(300), "a third of a second apart");
        s.quiet = false;
        s.next_due = Instant::now();
        s.record(RUN, 40.0, None);
        assert!(s.next_due <= Instant::now() + Duration::from_millis(70), "back to the full rate");
    }

    #[test]
    fn short_names_of_the_models() {
        let p = std::path::Path::new;
        assert_eq!(label(p("m/yolo11s-pose-384x320-fp16.onnx"), "384x320"), "s@384");
        assert_eq!(label(p("yolo11n-pose-fp16.onnx"), "512x448"), "n@512");
        assert_eq!(label(p("pose.onnx"), "512x448"), "pose");
    }
}
