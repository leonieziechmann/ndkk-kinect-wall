//! Replays a recording made with `kinect-hub-probe record` (format: recording.rs) in an endless
//! loop at the original frame timing, through the same pipeline as live frames. Clients get the
//! room, the people and the sensor noise as the Kinect delivered them, without a Kinect.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tracing::{error, info, warn};

use crate::pipeline::{Pipeline, ir_raw_for_tone};
use crate::protocol::{FLAG_HAS_IR, HEIGHT, PIXELS, WIDTH, WorkerHeader, WorkerKind};
use crate::recording::{FrameInfo, Recording};
use crate::source::{panic_message, sleep_unless_stopping};
use crate::state::{CameraParams, Hub, SensorState, now_us};

/// Frame interval where the recorded timestamps are unusable.
const FRAME_TIME: Duration = Duration::from_micros(33_333);
/// Longer pauses in a recording (a sensor restart, say) are shortened to this.
const MAX_GAP: Duration = Duration::from_secs(1);
/// Further behind schedule than this (the machine stalled), the timeline restarts from now
/// instead of rushing through the missed frames.
const MAX_LAG: Duration = Duration::from_millis(250);
/// Wait before a missing or broken recording is tried again.
const RETRY: Duration = Duration::from_secs(5);

pub fn run(hub: &Arc<Hub>) {
    let mut pipeline = Pipeline::new(hub.clone());
    let mut last_error = String::new();
    while !hub.stopping() {
        let Some(path) = hub.cfg.replay_path() else {
            hub.set_sensor(SensorState::Offline, "replay: no recording given (--source replay FILE)");
            sleep_unless_stopping(hub, RETRY);
            continue;
        };
        if let Err(e) = play(hub, &mut pipeline, &path) {
            let msg = format!("replay of {}: {e}", path.display());
            let was_playing = hub.sensor.borrow().state == SensorState::Streaming;
            if was_playing || msg != last_error {
                warn!("{msg} (trying again every {} s)", RETRY.as_secs());
            }
            hub.set_sensor(SensorState::Offline, &msg);
            last_error = msg;
            pipeline.reset();
            sleep_unless_stopping(hub, RETRY);
        }
    }
}

/// Plays the recording until the hub stops (`Ok`) or the file fails (`Err`).
fn play(hub: &Arc<Hub>, pipeline: &mut Pipeline, path: &Path) -> Result<(), String> {
    let mut rec = Recording::open(path)?;
    if (usize::from(rec.width), usize::from(rec.height)) != (WIDTH, HEIGHT) {
        return Err(format!("image size {}x{}, the hub works with {WIDTH}x{HEIGHT}", rec.width, rec.height));
    }
    let params = rec.info.get("params").cloned().ok_or("no camera parameters in the recording")?;
    let params: CameraParams = serde_json::from_value(params).map_err(|e| format!("damaged camera parameters: {e}"))?;
    params.validate().map_err(|e| format!("implausible camera parameters ({e})"))?;

    let delays = frame_delays(&rec.frames);
    let length = delays.iter().fold(Duration::ZERO, |sum, d| sum.saturating_add(*d));
    let name = path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned());
    let mut detail = format!("replay of {name}: {} frames, {:.1} s, looping", rec.frames.len(), length.as_secs_f64());
    if let Some(tail) = &rec.damaged_tail {
        warn!("{}: {tail}", path.display());
        detail.push_str(" (damaged end ignored)");
    }
    info!(
        "replaying {} in a loop: {} frames, {:.1} s ({} frames were skipped while recording)",
        path.display(),
        rec.frames.len(),
        length.as_secs_f64(),
        rec.skipped_frames()
    );
    pipeline.set_recorded_params(params, std::mem::take(&mut rec.lut));
    hub.set_sensor(SensorState::Streaming, &detail);

    let ir_raw = ir_raw_for_tone();
    let mut pixels = Vec::new();
    let mut payload = vec![0u8; PIXELS * 8];
    let start = Instant::now();
    let mut due = Duration::ZERO; // when the next frame is due, from `start`
    let mut seq: u32 = 0;
    loop {
        for (index, delay) in delays.iter().enumerate() {
            if hub.stopping() {
                return Ok(());
            }
            let has_ir = rec.read_frame(index, &mut pixels)?.has_ir;
            let len = worker_payload(&pixels, has_ir, &ir_raw, &mut payload)?;
            let header = WorkerHeader {
                kind: WorkerKind::Frame,
                flags: if has_ir { FLAG_HAS_IR } else { 0 },
                payload_len: len,
                seq,
                device_ts: (due.as_micros() / 125) as u32, // Kinect ticks of 1/8 ms, wrapping
                host_time_us: now_us(),
            };
            let frame = payload.get(..len).unwrap_or_default();
            match catch_unwind(AssertUnwindSafe(|| pipeline.on_frame(&header, frame))) {
                Ok(Ok(())) => {}
                Ok(Err(e)) => error!("replayed frame {index} dropped: {e}"),
                Err(p) => {
                    hub.metrics().panics_caught += 1;
                    pipeline.reset();
                    error!("panic in frame processing: {}", panic_message(p.as_ref()));
                }
            }
            seq = seq.wrapping_add(1);
            due = due.saturating_add(*delay);
            let now = start.elapsed();
            if now > due.saturating_add(MAX_LAG) {
                due = now;
            } else {
                sleep_unless_stopping(hub, due.saturating_sub(now));
            }
        }
    }
}

/// How long each frame stays until the next one, as recorded. The last one leads back to the
/// first after a typical frame interval.
fn frame_delays(frames: &[FrameInfo]) -> Vec<Duration> {
    let mut delays: Vec<Option<Duration>> = frames
        .iter()
        .zip(frames.iter().skip(1))
        .map(|(a, b)| {
            let d = Duration::from_micros(b.capture_time_us.checked_sub(a.capture_time_us)?);
            (d >= Duration::from_millis(1)).then_some(d.min(MAX_GAP))
        })
        .collect();
    let mut usable: Vec<Duration> = delays.iter().flatten().copied().collect();
    usable.sort_unstable();
    let typical = usable
        .get(usable.len() / 2)
        .copied()
        .filter(|d| (Duration::from_millis(5)..=MAX_GAP).contains(d))
        .unwrap_or(FRAME_TIME);
    delays.push(Some(typical));
    delays.into_iter().map(|d| d.unwrap_or(typical)).collect()
}

/// Recorded pixels (u16 depth in mm, u8 `ir` bytes) to what the capture worker sends (f32 depth
/// in mm, f32 raw IR). Returns the payload length.
fn worker_payload(pixels: &[u8], has_ir: bool, ir_raw: &[f32; 256], payload: &mut [u8]) -> Result<usize, String> {
    let (depth_in, ir_in) = pixels.split_at_checked(PIXELS * 2).ok_or("recorded frame too short")?;
    let (depth_out, ir_out) = payload.split_at_mut_checked(PIXELS * 4).ok_or("payload buffer too short")?;
    for (out, d) in depth_out.as_chunks_mut::<4>().0.iter_mut().zip(depth_in.as_chunks::<2>().0) {
        *out = f32::from(u16::from_le_bytes(*d)).to_le_bytes();
    }
    if !has_ir {
        return Ok(PIXELS * 4);
    }
    for (out, &b) in ir_out.as_chunks_mut::<4>().0.iter_mut().zip(ir_in) {
        *out = ir_raw.get(usize::from(b)).copied().unwrap_or(0.0).to_le_bytes();
    }
    Ok(PIXELS * 8)
}
