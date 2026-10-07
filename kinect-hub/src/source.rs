//! The data source thread: supervises the capture worker process (or runs the synthetic scene,
//! or replays a recording) and feeds every message into the pipeline.
//!
//! libfreenect2 never runs inside the hub. The worker is a separate process: if it crashes,
//! hangs or the Kinect misbehaves, the hub kills and restarts it with a backoff while clients
//! stay connected and see the sensor state change.

use std::io::{BufRead, BufReader, Read};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use tracing::{debug, error, info, warn};

use crate::config::SourceKind;
use crate::pipeline::Pipeline;
use crate::protocol::{WORKER_HEADER_LEN, WorkerKind, parse_worker_header};
use crate::state::{Hub, SensorState};
use crate::{replay, synthetic};

/// A worker that sends nothing (not even its 1 Hz heartbeat) for this long is considered hung.
const WORKER_SILENCE_LIMIT: Duration = Duration::from_secs(5);
const BACKOFF_MIN: Duration = Duration::from_millis(250);
const BACKOFF_MAX: Duration = Duration::from_secs(5);

pub struct SourceHandle {
    thread: Option<JoinHandle<()>>,
    hub: Arc<Hub>,
}

pub fn spawn(hub: Arc<Hub>) -> SourceHandle {
    let h = hub.clone();
    let thread = thread::Builder::new()
        .name("source".to_string())
        .spawn(move || run(h))
        .map_err(|e| error!("cannot start the source thread: {e}"))
        .ok();
    SourceHandle { thread, hub }
}

impl SourceHandle {
    /// Stops the source (the worker gets its stdin closed, then is killed if it lingers).
    pub async fn stop(mut self, timeout: Duration) {
        self.hub.request_stop();
        let Some(thread) = self.thread.take() else { return };
        let joined = tokio::task::spawn_blocking(move || thread.join());
        match tokio::time::timeout(timeout, joined).await {
            Ok(Ok(Ok(()))) => info!("source stopped"),
            Ok(_) => warn!("source thread ended abnormally"),
            Err(_) => warn!("source did not stop within {timeout:?}"),
        }
    }
}

pub fn panic_message(p: &(dyn std::any::Any + Send)) -> String {
    p.downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| p.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".to_string())
}

/// Sleeps in small steps so a shutdown request is honoured quickly.
pub fn sleep_unless_stopping(hub: &Hub, total: Duration) {
    let end = Instant::now() + total;
    while !hub.stopping() {
        let now = Instant::now();
        if now >= end {
            break;
        }
        thread::sleep((end - now).min(Duration::from_millis(50)));
    }
}

fn run(hub: Arc<Hub>) {
    // the outer loop survives even a bug (panic) in the source code itself
    while !hub.stopping() {
        let result = catch_unwind(AssertUnwindSafe(|| match hub.cfg.source {
            SourceKind::Kinect => supervise_worker(&hub),
            SourceKind::Synthetic => synthetic::run(&hub),
            SourceKind::Replay => replay::run(&hub),
        }));
        if let Err(p) = result {
            error!("source crashed ({}), restarting it", panic_message(p.as_ref()));
            hub.metrics().panics_caught += 1;
            sleep_unless_stopping(&hub, Duration::from_secs(1));
        }
    }
    hub.set_sensor(SensorState::Offline, "hub shutting down");
}

fn supervise_worker(hub: &Arc<Hub>) {
    let mut pipeline = Pipeline::new(hub.clone());
    let mut backoff = BACKOFF_MIN;
    while !hub.stopping() {
        let Some(path) = hub.cfg.worker_path() else {
            let msg = "capture worker fn2_capture.exe not found (build it with `sh fn2/build.sh` or pass --worker)";
            warn!("{msg}");
            hub.set_sensor(SensorState::Offline, msg);
            sleep_unless_stopping(hub, BACKOFF_MAX);
            continue;
        };
        hub.set_sensor(SensorState::Offline, "starting capture worker");
        let started = Instant::now();
        let outcome = run_worker_once(hub, &mut pipeline, &path);
        pipeline.reset();
        if hub.stopping() {
            break;
        }
        warn!("capture worker ended: {outcome}");
        {
            let mut m = hub.metrics();
            m.worker_restarts = m.worker_restarts.saturating_add(1);
            m.worker_pid = None;
            m.worker_started = None;
            m.last_worker_exit = Some(outcome.clone());
        }
        hub.set_sensor(SensorState::Offline, &format!("capture worker restarting ({outcome})"));
        backoff = if started.elapsed() > Duration::from_secs(30) { BACKOFF_MIN } else { (backoff * 2).min(BACKOFF_MAX) };
        sleep_unless_stopping(hub, backoff);
    }
}

fn kill(child: &Mutex<Child>) {
    let mut c = child.lock().unwrap_or_else(PoisonError::into_inner);
    let _ = c.kill(); // fails harmlessly if it already exited
}

/// Runs one worker process until it exits, hangs or the hub stops. Returns why it ended.
fn run_worker_once(hub: &Arc<Hub>, pipeline: &mut Pipeline, path: &Path) -> String {
    let mut cmd = Command::new(path);
    cmd.arg("--pipeline")
        .arg(&hub.cfg.pipeline)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = path.parent() {
        cmd.current_dir(dir); // the libfreenect2 DLLs live next to the worker
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return format!("cannot start {}: {e}", path.display()),
    };
    let pid = child.id();
    info!("capture worker started (pid {pid}, {})", path.display());
    {
        let mut m = hub.metrics();
        m.worker_pid = Some(pid);
        m.worker_started = Some(Instant::now());
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take(); // kept open: closing it tells the worker to exit
    let child = Arc::new(Mutex::new(child));
    let done = Arc::new(AtomicBool::new(false));
    let last_message_ms = Arc::new(AtomicU64::new(0));
    let epoch = Instant::now();

    let log_thread = stderr.and_then(|err| {
        thread::Builder::new()
            .name("worker-log".to_string())
            .spawn(move || {
                for line in BufReader::new(err).lines() {
                    match line {
                        Ok(l) if !l.trim().is_empty() => info!(target: "worker", "{}", l.trim_end()),
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
            })
            .ok()
    });

    let watchdog = {
        let (hub, child, done, last) = (hub.clone(), child.clone(), done.clone(), last_message_ms.clone());
        thread::Builder::new()
            .name("worker-watchdog".to_string())
            .spawn(move || {
                let mut stdin = stdin;
                loop {
                    thread::sleep(Duration::from_millis(100));
                    if done.load(Ordering::SeqCst) {
                        return;
                    }
                    if hub.stopping() {
                        drop(stdin.take()); // polite: the worker closes the Kinect and exits
                        let deadline = Instant::now() + Duration::from_secs(2);
                        while Instant::now() < deadline && !done.load(Ordering::SeqCst) {
                            thread::sleep(Duration::from_millis(20));
                        }
                        kill(&child);
                        return;
                    }
                    let silent_ms = (epoch.elapsed().as_millis() as u64).saturating_sub(last.load(Ordering::Relaxed));
                    if silent_ms > WORKER_SILENCE_LIMIT.as_millis() as u64 {
                        warn!("capture worker silent for {silent_ms} ms, killing it");
                        kill(&child);
                        return;
                    }
                }
            })
            .ok()
    };
    last_message_ms.store(epoch.elapsed().as_millis() as u64, Ordering::Relaxed);

    let reason = match stdout {
        Some(out) => read_worker(hub, pipeline, out, &last_message_ms, epoch),
        None => "worker has no stdout".to_string(),
    };

    done.store(true, Ordering::SeqCst);
    if let Some(w) = watchdog {
        let _ = w.join();
    }
    kill(&child);
    let status = child.lock().unwrap_or_else(PoisonError::into_inner).wait();
    if let Some(t) = log_thread {
        let _ = t.join();
    }
    match status {
        Ok(s) => match s.code() {
            Some(0) => format!("{reason}; exited normally"),
            Some(code) => format!("{reason}; exit code 0x{:08X}", code as u32),
            None => format!("{reason}; terminated"),
        },
        Err(e) => format!("{reason}; wait failed: {e}"),
    }
}

/// Reads worker messages until the pipe breaks or the stream is corrupt.
fn read_worker(hub: &Hub, pipeline: &mut Pipeline, mut out: impl Read, last: &AtomicU64, epoch: Instant) -> String {
    let mut header = [0u8; WORKER_HEADER_LEN];
    let mut payload = Vec::new();
    let mut frame_errors_logged = 0u32;
    loop {
        if let Err(e) = out.read_exact(&mut header) {
            return format!("pipe closed ({e})");
        }
        let h = match parse_worker_header(&header) {
            Ok(h) => h,
            Err(e) => {
                hub.metrics().protocol_errors += 1;
                return format!("protocol error: {e}");
            }
        };
        payload.resize(h.payload_len, 0);
        if let Err(e) = out.read_exact(&mut payload) {
            return format!("pipe closed mid-message ({e})");
        }
        last.store(epoch.elapsed().as_millis() as u64, Ordering::Relaxed);

        match h.kind {
            WorkerKind::Frame => {
                let result = catch_unwind(AssertUnwindSafe(|| pipeline.on_frame(&h, &payload)));
                let error = match result {
                    Ok(Ok(())) => None,
                    Ok(Err(e)) => Some(e),
                    Err(p) => {
                        hub.metrics().panics_caught += 1;
                        pipeline.reset();
                        Some(format!("panic in frame processing: {}", panic_message(p.as_ref())))
                    }
                };
                if let Some(e) = error {
                    hub.metrics().frame_errors += 1;
                    if frame_errors_logged < 20 {
                        frame_errors_logged += 1;
                        error!("frame {} dropped: {e}", h.seq);
                    }
                }
            }
            WorkerKind::Params => {
                if let Err(e) = pipeline.on_params(&payload) {
                    error!("{e}");
                }
            }
            WorkerKind::Status => on_status(hub, &payload),
            WorkerKind::Heartbeat => {
                hub.metrics().worker_heartbeat = serde_json::from_slice(&payload).ok();
            }
            WorkerKind::Unknown(kind) => debug!("ignoring worker message kind {kind}"),
        }
    }
}

fn on_status(hub: &Hub, payload: &[u8]) {
    #[derive(serde::Deserialize)]
    struct WorkerStatus {
        state: String,
        #[serde(default)]
        detail: String,
    }
    match serde_json::from_slice::<WorkerStatus>(payload) {
        Ok(s) => {
            let state = match s.state.as_str() {
                "searching" => SensorState::Searching,
                "starting" => SensorState::Starting,
                "streaming" => SensorState::Streaming,
                _ => SensorState::Offline,
            };
            hub.set_sensor(state, &s.detail);
        }
        Err(e) => warn!("unreadable worker status: {e}"),
    }
}
