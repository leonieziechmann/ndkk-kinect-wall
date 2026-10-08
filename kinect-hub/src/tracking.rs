//! Person tracking in the hub: the persons crate (kinect-hub/persons, the tracker of
//! web/lib/persons-core.js in Rust) once for all clients, fed with every frame and with the poses
//! of the pose model (pose.rs). Two streams:
//!
//!   persons_live  every frame at once (its skeletons follow the optical flow since the last pose)
//!   persons       every frame once the pose of a later frame is in (at most --persons-delay
//!                 frames): skeletons interpolated between the poses before and after it, as the
//!                 browser's delayed output (web/lib/persons-worker.js)
//!
//! A result is a JSON text message {type: "persons" | "persons_live", seq, capture_time_us,
//! persons, floor, ...} followed by the labels of that frame (binary kind 5 / 6, run-length coded:
//! per run u8 slot, u16 length). The person list has the browser's fields (PERSONS.md).
//!
//! It runs while someone subscribes. It hands the frames to the pose model itself (a pose is
//! matched against the labels of the frame it was computed on, so it must know that frame before
//! processing it). A crash in the tracker is caught and the tracker starts over.

use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use axum::extract::ws::Utf8Bytes;
use bytes::Bytes;
use persons::{FrameResult, N, Options, PersonOut, PersonTracker, PoseIn};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::runtime::Handle;
use tracing::{error, info, warn};

use crate::pose::PoseSet;
use crate::protocol::{MessageBuf, Stream, payload};
use crate::source::{panic_message, sleep_unless_stopping};
use crate::state::{Hub, ParamSet, now_us};

/// After a pause this long the persons are forgotten (they may have left); the background stays.
const IDLE_RESET: Duration = Duration::from_secs(2);
/// `GET /api/persons` keeps the tracker running this long for scripts that poll it.
const HTTP_LEASE: Duration = Duration::from_secs(5);

/// One result, ready to send: the JSON message and the labels (binary, with header).
pub struct PersonsSet {
    pub json: Utf8Bytes,
    pub labels: Bytes,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct TrackingStatus {
    /// off · idle (nobody subscribes) · running · error
    pub state: &'static str,
    pub detail: String,
    /// frames the delayed output may wait for a later pose
    pub delay: u32,
    /// ms per frame (moving average) and by stage (flow, skeleton, segment, arms, output,
    /// background, floor, list)
    pub ms: f64,
    pub stages: [f64; 8],
    pub frames: u64,
    pub persons: usize,
    pub tracks: usize,
    /// delayed results waiting for a pose
    pub waiting: usize,
    pub poses: u64,
    /// ms of the last pose (moving average)
    pub pose_ms: f64,
    /// the tracker started over (crash, or a pause)
    pub resets: u64,
}

pub struct TrackingState {
    status: Mutex<TrackingStatus>,
    http_lease: Mutex<Option<Instant>>,
}

impl TrackingState {
    pub fn new(enabled: bool, delay: u32) -> TrackingState {
        TrackingState {
            status: Mutex::new(TrackingStatus {
                state: if enabled { "idle" } else { "off" },
                detail: if enabled { String::new() } else { "--persons off".to_string() },
                delay,
                ..TrackingStatus::default()
            }),
            http_lease: Mutex::new(None),
        }
    }

    pub fn status(&self) -> MutexGuard<'_, TrackingStatus> {
        self.status.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn status_json(&self) -> Value {
        json!(*self.status())
    }

    /// An HTTP client asked for persons: keep the tracker running for a while.
    pub fn touch_http(&self) {
        *self.http_lease.lock().unwrap_or_else(PoisonError::into_inner) = Some(Instant::now() + HTTP_LEASE);
    }

    fn http_wanted(&self) -> bool {
        self.http_lease.lock().unwrap_or_else(PoisonError::into_inner).is_some_and(|until| Instant::now() < until)
    }
}

impl Hub {
    pub fn persons_wanted(&self) -> bool {
        self.subscribers(Stream::Persons) > 0 || self.subscribers(Stream::PersonsLive) > 0 || self.tracking.http_wanted()
    }
}

pub struct TrackingHandle {
    thread: Option<JoinHandle<()>>,
}

impl TrackingHandle {
    pub async fn stop(mut self, timeout: Duration) {
        let Some(thread) = self.thread.take() else { return };
        let joined = tokio::task::spawn_blocking(move || thread.join());
        match tokio::time::timeout(timeout, joined).await {
            Ok(Ok(Ok(()))) => info!("person tracking stopped"),
            Ok(_) => warn!("tracking thread ended abnormally"),
            Err(_) => warn!("tracking thread did not stop within {timeout:?}"),
        }
    }
}

pub fn spawn(hub: Arc<Hub>, rt: Handle) -> TrackingHandle {
    if !hub.cfg.persons {
        info!("person tracking off (--persons off)");
        return TrackingHandle { thread: None };
    }
    let thread = thread::Builder::new()
        .name("persons".to_string())
        .spawn(move || run(&hub, &rt))
        .map_err(|e| error!("cannot start the tracking thread: {e}"))
        .ok();
    TrackingHandle { thread }
}

fn run(hub: &Arc<Hub>, rt: &Handle) {
    while !hub.stopping() {
        let result = catch_unwind(AssertUnwindSafe(|| serve(hub, rt)));
        hub.pose.wanted_inside.store(false, Ordering::Relaxed);
        if let Err(p) = result {
            let msg = panic_message(p.as_ref());
            error!("person tracking crashed ({msg}), starting over");
            hub.metrics().panics_caught += 1;
            let mut s = hub.tracking.status();
            s.state = "error";
            s.detail = format!("crashed: {msg}");
            s.resets += 1;
            drop(s);
            sleep_unless_stopping(hub, Duration::from_secs(1));
        }
    }
}

/// Output buffers of one result.
struct Out {
    labels: Vec<u8>,
    masked: Vec<u16>,
    indices: Vec<u32>,
    depth: Vec<u16>,
}

impl Out {
    fn new() -> Out {
        Out { labels: vec![0; N], masked: vec![0; N], indices: vec![0; N], depth: vec![0; N] }
    }
}

/// A result waiting for the pose of a later frame.
struct Held {
    seq: u32,
    capture_time_us: u64,
    result: FrameResult,
    out: Out,
}

/// What the tracker loop waits for.
enum Wake {
    Frame,
    Poses,
    Nothing,
}

fn serve(hub: &Arc<Hub>, rt: &Handle) -> Result<(), String> {
    let delay = hub.cfg.persons_delay;
    let mut tracker = PersonTracker::new(Options::default());
    let mut frames = hub.frames.subscribe();
    let mut poses = hub.poses.subscribe();
    let mut params: Option<Arc<ParamSet>> = None;
    let mut held: VecDeque<Held> = VecDeque::new();
    let mut pool: Vec<Out> = Vec::new();
    let mut pending: Option<u32> = None; // the frame the pose model works on for us
    let mut posed_up_to: Option<u32> = None;
    let mut last_seq: Option<u32> = None;
    let mut last_frame_at = Instant::now();
    let mut idle = true;
    let (mut ema_ms, mut ema_stages) = (0.0_f64, [0.0_f64; 8]);
    while !hub.stopping() {
        if !hub.persons_wanted() {
            if !idle {
                hub.pose.wanted_inside.store(false, Ordering::Relaxed);
                let mut s = hub.tracking.status();
                s.state = "idle";
                s.detail = "nobody subscribes".to_string();
                s.waiting = 0;
                idle = true;
                held.clear();
                pending = None;
            }
            sleep_unless_stopping(hub, Duration::from_millis(100));
            continue;
        }
        if idle {
            idle = false;
            hub.pose.wanted_inside.store(true, Ordering::Relaxed);
            let mut s = hub.tracking.status();
            s.state = "running";
            s.detail.clear();
        }
        // a new frame, or the poses of the frame handed to the model
        let wake = rt.block_on(async {
            tokio::select! {
                r = frames.changed() => if r.is_ok() { Wake::Frame } else { Wake::Nothing },
                r = poses.changed() => if r.is_ok() { Wake::Poses } else { Wake::Nothing },
                () = tokio::time::sleep(Duration::from_millis(200)) => Wake::Nothing,
            }
        });
        // poses first: they belong to an earlier frame
        let latest_poses = poses.borrow_and_update().clone();
        if let (Some(p), Some(want)) = (&latest_poses, pending)
            && p.seq == want
        {
            tracker.set_poses(&pose_input(p), Some(i64::from(p.seq)));
            posed_up_to = Some(p.seq);
            pending = None;
            {
                let mut s = hub.tracking.status();
                s.poses += 1;
                s.pose_ms = (if s.pose_ms == 0.0 { p.ms } else { 0.9 * s.pose_ms + 0.1 * p.ms } * 10.0).round() / 10.0;
            }
            flush(hub, &mut tracker, &mut held, &mut pool, posed_up_to, last_seq, delay);
        }
        if pending.is_some() && !hub.pose.available() {
            pending = None; // the model went away: no pose comes for it
        }
        if matches!(wake, Wake::Poses | Wake::Nothing) && !frames.has_changed().unwrap_or(false) {
            continue;
        }
        let frame = frames.borrow_and_update().clone();
        let Some(frame) = frame.filter(|f| Some(f.seq) != last_seq) else { continue };
        let seq = frame.seq;
        // after a pause the persons are forgotten (the background is kept)
        if last_frame_at.elapsed() > IDLE_RESET && last_seq.is_some() {
            tracker.reset();
            held.clear();
            pending = None;
            posed_up_to = None;
            hub.tracking.status().resets += 1;
        }
        last_frame_at = Instant::now();
        last_seq = Some(seq);
        if let Some(p) = &frame.params
            && params.as_ref().is_none_or(|q| !Arc::ptr_eq(p, q))
        {
            tracker.set_rays(&p.rays);
            params = Some(p.clone());
        }
        // hand this frame to the pose model when a pose is due
        if pending.is_none() && frame.ir.is_some() && hub.pose.available() && hub.pose.idle_and_due() {
            tracker.mark_pose_frame(i64::from(seq));
            if hub.pose.submit(frame.clone()) {
                pending = Some(seq);
            }
        }
        let mut out = pool.pop().unwrap_or_else(Out::new);
        for (d, s) in out.depth.iter_mut().zip(payload(&frame.depth).as_chunks::<2>().0) {
            *d = u16::from_le_bytes(*s);
        }
        let ir = frame.ir.as_ref().map(payload);
        let Out { labels, masked, indices, depth } = &mut out;
        let result = tracker.process(depth, labels, masked, indices, i64::from(seq), ir.as_deref());
        let ema = |old: f64, new: f64| if old == 0.0 { new } else { 0.9 * old + 0.1 * new };
        ema_ms = ema(ema_ms, result.ms);
        for (a, b) in ema_stages.iter_mut().zip(result.stages) {
            *a = ema(*a, b);
        }
        // at once: the live stream
        if hub.subscribers(Stream::PersonsLive) > 0 {
            let (pose_ms, pose_runs) = pose_stats(hub);
            let set = message(Stream::PersonsLive, seq, frame.capture_time_us, &result, &out.labels, 0, pose_ms, pose_runs);
            hub.persons_live.send_replace(Some(Arc::new(set)));
        }
        {
            let mut s = hub.tracking.status();
            s.frames += 1;
            s.ms = (ema_ms * 100.0).round() / 100.0;
            s.stages = ema_stages.map(|v| (v * 100.0).round() / 100.0);
            s.persons = result.persons.iter().filter(|p| p.visible).count();
            s.tracks = result.tracks;
        }
        held.push_back(Held { seq, capture_time_us: frame.capture_time_us, result, out });
        flush(hub, &mut tracker, &mut held, &mut pool, posed_up_to, last_seq, delay);
    }
    Ok(())
}

/// Sends the delayed results that may go: a pose of their frame or a later one is in, or they
/// waited `delay` frames (or there is no pose model to wait for). Their skeletons are made exact
/// first (finalize).
fn flush(hub: &Hub, tracker: &mut PersonTracker, held: &mut VecDeque<Held>, pool: &mut Vec<Out>, posed_up_to: Option<u32>, newest: Option<u32>, delay: u32) {
    let wait = delay > 0 && hub.pose.available();
    while let Some(h) = held.front() {
        let posed = posed_up_to.is_some_and(|p| p.wrapping_sub(h.seq) < 1 << 30);
        let waited = newest.is_some_and(|n| n.wrapping_sub(h.seq) >= delay);
        if wait && !posed && !waited {
            break;
        }
        let Some(mut h) = held.pop_front() else { break };
        if delay > 0 {
            tracker.finalize(&mut h.result, i64::from(h.seq), &h.out.depth, &h.out.labels);
        }
        let waited_frames = newest.map_or(0, |n| n.wrapping_sub(h.seq));
        if hub.subscribers(Stream::Persons) > 0 || hub.tracking.http_wanted() {
            let (pose_ms, pose_runs) = pose_stats(hub);
            let set = message(Stream::Persons, h.seq, h.capture_time_us, &h.result, &h.out.labels, waited_frames, pose_ms, pose_runs);
            hub.persons.send_replace(Some(Arc::new(set)));
        }
        pool.push(h.out);
    }
    hub.tracking.status().waiting = held.len();
}

fn pose_stats(hub: &Hub) -> (f64, u64) {
    let s = hub.tracking.status();
    (s.pose_ms, s.poses)
}

fn pose_input(p: &PoseSet) -> Vec<PoseIn> {
    p.poses
        .iter()
        .map(|q| PoseIn { score: f64::from(q.score), bbox: q.bbox.map(f64::from), kp: q.kp })
        .collect()
}

fn person_json(p: &PersonOut) -> Value {
    json!({
        "id": p.id,
        "slot": p.slot,
        "visible": p.visible,
        "age": (p.age * 100.0).round() / 100.0,
        "score": p.score,
        "pixels": p.pixels,
        "area": p.area,
        "centroid": p.centroid,
        "head": p.head,
        "ground": p.ground,
        "height": p.height,
        "velocity": p.velocity,
        "bbox": p.bbox,
        "joints": p.joints,
        "keypoints": p.keypoints,
        "extra": p.extra,
        "extraKeypoints": p.extra_keypoints,
    })
}

/// The JSON message and the run-length coded labels of one result.
#[allow(clippy::too_many_arguments)]
fn message(stream: Stream, seq: u32, capture_time_us: u64, r: &FrameResult, labels: &[u8], waited: u32, pose_ms: f64, pose_runs: u64) -> PersonsSet {
    let floor = r.floor.as_ref().map(|f| {
        json!({
            "normal": f.normal,
            "d": f.d,
            "height": f.height,
            "pitchDeg": f.pitch_deg,
            "rollDeg": f.roll_deg,
            "support": f.support,
            "source": f.source,
        })
    });
    let publish = now_us();
    let json = json!({
        "type": stream.name(),
        "seq": seq,
        "capture_time_us": capture_time_us,
        "publish_time_us": publish,
        "count": r.count,
        "persons": r.persons.iter().map(person_json).collect::<Vec<_>>(),
        "floor": floor,
        "ms": (r.ms * 100.0).round() / 100.0,
        "waited": waited,
        "pose_ms": pose_ms,
        "pose_runs": pose_runs,
    })
    .to_string()
    .into();
    let rle = run_lengths(labels);
    let mut m = MessageBuf::new(rle.len());
    m.payload_mut().copy_from_slice(&rle);
    PersonsSet { json, labels: m.finish(stream, seq, capture_time_us, publish) }
}

/// Labels as runs: per run u8 value, u16 length (little-endian, 1..65535).
pub fn run_lengths(labels: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4096);
    let mut it = labels.iter().copied();
    let Some(mut value) = it.next() else { return out };
    let mut len: u16 = 1;
    for v in it {
        if v == value && len < u16::MAX {
            len += 1;
            continue;
        }
        out.push(value);
        out.extend_from_slice(&len.to_le_bytes());
        (value, len) = (v, 1);
    }
    out.push(value);
    out.extend_from_slice(&len.to_le_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(rle: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        for r in rle.as_chunks::<3>().0 {
            let len = u16::from_le_bytes([r[1], r[2]]);
            out.extend(std::iter::repeat_n(r[0], usize::from(len)));
        }
        out
    }

    #[test]
    fn run_lengths_round_trip() {
        let mut labels = vec![0_u8; N];
        for (i, l) in labels.iter_mut().enumerate().skip(1000).take(5000) {
            *l = if i % 700 < 300 { 3 } else { 0 };
        }
        let rle = run_lengths(&labels);
        assert!(rle.len() < 200, "{}", rle.len());
        assert_eq!(decode(&rle), labels);
        assert_eq!(decode(&run_lengths(&vec![7_u8; 70_000])), vec![7_u8; 70_000]);
    }
}
