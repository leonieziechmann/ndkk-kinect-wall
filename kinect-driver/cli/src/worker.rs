//! The capture worker for kinect-hub: a drop-in for fn2/fn2_capture.exe
//! (`kinect-hub --worker path/to/kinect-driver.exe`).
//!
//! stdout: messages = 32-byte header + payload, little-endian
//!   u32 magic "K2W1" | u16 kind | u16 flags | u32 payload_len | u32 seq | u32 device_ts
//!   | u32 reserved | u64 host_time_us (system clock, microseconds since 1970)
//!   kind 1 FRAME      depth f32[512*424] in mm, then infrared f32[512*424] (flags & 1)
//!   kind 2 PARAMS     JSON: depth camera intrinsics + distortion, serial, firmware
//!   kind 3 STATUS     JSON: {"state": "searching"|"starting"|"streaming", "detail": "..."}
//!   kind 4 HEARTBEAT  JSON counters, once per second
//! stderr: log lines. The worker ends when its stdin closes (the hub went away).
//!
//! The hub passes only `--pipeline fast|cl`; everything else comes from the environment, which
//! the hub hands on: KINECT_DRIVER_MODE (extended|compat), KINECT_DRIVER_TOF (key=value,...),
//! KINECT_DRIVER_IR (hub|even|raw), KINECT_DRIVER_SOURCE (kinect|sim:SCENE|FILE.k2raw),
//! KINECT_DRIVER_LED (0..1000), KINECT_DRIVER_CACHE (folder|off), KINECT_DRIVER_PRIORITY=normal.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use kinect_driver::consts::{HEIGHT, PIXELS, WIDTH};
use kinect_driver::driver::{Driver, DriverState, Event};

use crate::args::Args;
use crate::opts::Common;

const MAGIC: u32 = 0x3157_324B; // "K2W1"
const FRAME: u16 = 1;
const PARAMS: u16 = 2;
const STATUS: u16 = 3;
const HEARTBEAT: u16 = 4;
const FLAG_HAS_IR: u16 = 1;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now_us() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0)
}

fn header(kind: u16, flags: u16, len: usize, seq: u32, device_ts: u32, t_us: u64) -> [u8; 32] {
    let mut h = [0u8; 32];
    let mut put = |at: usize, b: &[u8]| {
        if let Some(d) = h.get_mut(at..at + b.len()) {
            d.copy_from_slice(b);
        }
    };
    put(0, &MAGIC.to_le_bytes());
    put(4, &kind.to_le_bytes());
    put(6, &flags.to_le_bytes());
    put(8, &(len as u32).to_le_bytes());
    put(12, &seq.to_le_bytes());
    put(16, &device_ts.to_le_bytes());
    put(24, &t_us.to_le_bytes());
    h
}

/// A string as JSON.
pub fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push(' '),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

#[derive(Default)]
struct Pending {
    control: std::collections::VecDeque<Vec<u8>>,
    frame: Option<Vec<u8>>,
    stop: bool,
}

/// Everything to stdout goes through one writer thread: control messages are queued, frames
/// have a latest-only slot (a slow reader loses frames here instead of delaying the sensor).
struct Output {
    pending: Arc<(Mutex<Pending>, Condvar)>,
    thread: Option<std::thread::JoinHandle<()>>,
    dropped: Arc<AtomicU64>,
    written: Arc<AtomicU64>,
    broken: Arc<AtomicBool>,
    spare: Vec<u8>,
}

impl Output {
    fn start(quit: Arc<AtomicBool>) -> Output {
        let pending: Arc<(Mutex<Pending>, Condvar)> = Arc::default();
        let written = Arc::new(AtomicU64::new(0));
        let broken = Arc::new(AtomicBool::new(false));
        let (p, w, b) = (pending.clone(), written.clone(), broken.clone());
        let thread = std::thread::Builder::new()
            .name("worker-output".into())
            .spawn(move || {
                let mut out = std::io::stdout().lock();
                loop {
                    let (msg, is_frame) = {
                        let (m, cv) = &*p;
                        let mut g = lock(m);
                        loop {
                            if let Some(c) = g.control.pop_front() {
                                break (Some(c), false);
                            }
                            if let Some(f) = g.frame.take() {
                                break (Some(f), true);
                            }
                            if g.stop {
                                break (None, false);
                            }
                            g = cv.wait_timeout(g, Duration::from_millis(200)).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
                        }
                    };
                    let Some(msg) = msg else { break };
                    if out.write_all(&msg).and_then(|()| out.flush()).is_err() {
                        // the hub is gone
                        b.store(true, Ordering::SeqCst);
                        quit.store(true, Ordering::SeqCst);
                        break;
                    }
                    if is_frame {
                        w.fetch_add(1, Ordering::Relaxed);
                    }
                }
            })
            .ok();
        Output { pending, thread, dropped: Arc::new(AtomicU64::new(0)), written, broken, spare: Vec::new() }
    }

    fn json(&self, kind: u16, json: &str) {
        let mut msg = header(kind, 0, json.len(), 0, 0, now_us()).to_vec();
        msg.extend_from_slice(json.as_bytes());
        let (m, cv) = &*self.pending;
        let mut g = lock(m);
        if g.control.len() < 64 {
            g.control.push_back(msg);
        }
        drop(g);
        cv.notify_one();
    }

    fn frame(&mut self, depth: &[f32], ir: Option<&[f32]>, seq: u32, device_ts: u32, t_us: u64) {
        let bytes = PIXELS * 4;
        let len = if ir.is_some() { 2 * bytes } else { bytes };
        let mut msg = std::mem::take(&mut self.spare);
        msg.clear();
        msg.reserve(32 + len);
        msg.extend_from_slice(&header(FRAME, if ir.is_some() { FLAG_HAS_IR } else { 0 }, len, seq, device_ts, t_us));
        let plane = |msg: &mut Vec<u8>, v: &[f32]| {
            for x in v.iter().take(PIXELS) {
                msg.extend_from_slice(&x.to_le_bytes());
            }
            // a short plane is padded (never happens with the driver's frames)
            msg.resize(msg.len() + (PIXELS.saturating_sub(v.len())) * 4, 0);
        };
        plane(&mut msg, depth);
        if let Some(ir) = ir {
            plane(&mut msg, ir);
        }
        let (m, cv) = &*self.pending;
        let mut g = lock(m);
        if let Some(old) = g.frame.replace(msg) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            self.spare = old;
        }
        drop(g);
        cv.notify_one();
    }

    /// Lets the queued messages go out, but waits at most a second: a reader that stopped
    /// reading must not keep the worker alive (the process ends anyway).
    fn stop(mut self) {
        {
            let (m, cv) = &*self.pending;
            lock(m).stop = true;
            cv.notify_all();
        }
        if let Some(t) = self.thread.take() {
            let end = Instant::now() + Duration::from_secs(1);
            while !t.is_finished() && Instant::now() < end {
                std::thread::sleep(Duration::from_millis(5));
            }
            if t.is_finished() {
                let _ = t.join();
            }
        }
    }
}

fn status_json(state: DriverState, detail: &str) -> String {
    // the hub knows searching / starting / streaming (anything else shows as offline)
    let s = match state {
        DriverState::Searching | DriverState::Recovering | DriverState::Stopped => "searching",
        DriverState::Starting => "starting",
        DriverState::Streaming => "streaming",
    };
    format!("{{\"state\":{},\"detail\":{}}}", json_str(s), json_str(detail))
}

/// Above normal priority (Windows), as fn2_capture: the sensor comes before scenes and
/// browsers when the CPU is busy. KINECT_DRIVER_PRIORITY=normal (or FN2_PRIORITY=normal) leaves
/// it.
fn raise_priority() {
    let normal = |v: &str| std::env::var(v).is_ok_and(|s| s == "normal");
    let wanted = !(normal("KINECT_DRIVER_PRIORITY") || normal("FN2_PRIORITY"));
    #[cfg(windows)]
    if wanted {
        #[allow(unsafe_code)]
        mod win {
            use std::ffi::c_void;
            #[link(name = "kernel32")]
            unsafe extern "system" {
                pub fn GetCurrentProcess() -> *mut c_void;
                pub fn SetPriorityClass(process: *mut c_void, class: u32) -> i32;
            }
        }
        const ABOVE_NORMAL_PRIORITY_CLASS: u32 = 0x0000_8000;
        // SAFETY: the pseudo handle of the own process; plain Win32 calls without pointers to data
        #[allow(unsafe_code)]
        let ok = unsafe { win::SetPriorityClass(win::GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS) };
        if ok == 0 {
            eprintln!("cannot raise the priority");
        }
    }
    #[cfg(not(windows))]
    let _ = wanted;
}

pub fn run(mut a: Args) -> Result<(), String> {
    let common = Common::parse(&mut a, true)?;
    let stdin_watch = !a.flag("--no-stdin-watch");
    a.done()?;
    raise_priority();
    let quit = Arc::new(AtomicBool::new(false));
    let mut out = Output::start(quit.clone());
    if stdin_watch {
        let q = quit.clone();
        let _ = std::thread::Builder::new().name("worker-stdin".into()).spawn(move || {
            let mut buf = [0u8; 256];
            let mut stdin = std::io::stdin().lock();
            while matches!(stdin.read(&mut buf), Ok(n) if n > 0) {}
            // EOF or error: the hub closed our stdin or died
            q.store(true, Ordering::SeqCst);
        });
    }
    out.json(STATUS, &status_json(DriverState::Starting, &format!("kinect-driver {} ({}, {:?})", env!("CARGO_PKG_VERSION"), common.mode_name(), common.backend)));
    eprintln!("kinect-driver worker: {} mode, {:?}, infrared {:?}", common.mode_name(), common.backend, common.ir);
    let driver = Driver::start(common.driver_config()).map_err(|e| e.to_string())?;
    let mut next_beat = Instant::now();
    let mut frames = 0u64;
    let mut last_ms = 0.0f64;
    let mut decoder = String::new();
    while !quit.load(Ordering::SeqCst) {
        if Instant::now() >= next_beat {
            let s = driver.status();
            let st = s.stream.unwrap_or_default();
            let beat = format!(
                "{{\"frames\":{frames},\"dropped\":{},\"written\":{},\"reconnects\":{},\"driver\":\"kinect-driver {}\",\"decoder\":{},\"decode_ms\":{:.2},\"fps\":{:.1},\"usb_bad_packets\":{},\"usb_failed_transfers\":{},\"partial_frames\":{},\"patched_packets\":{},\"lost_frames\":{},\"processing_dropped\":{},\"panics\":{}}}",
                out.dropped.load(Ordering::Relaxed),
                out.written.load(Ordering::Relaxed),
                s.restarts,
                env!("CARGO_PKG_VERSION"),
                json_str(&decoder),
                last_ms,
                s.fps,
                st.bad_packets,
                st.failed,
                s.parser.partial_frames,
                s.parser.filled_packets,
                s.parser.dropped_frames + s.parser.missing_frames,
                s.processing_dropped,
                s.panics,
            );
            out.json(HEARTBEAT, &beat);
            next_beat += Duration::from_secs(1);
            if next_beat < Instant::now() {
                next_beat = Instant::now() + Duration::from_secs(1);
            }
        }
        match driver.recv_timeout(Duration::from_millis(50)) {
            Some(Event::Frame(f)) => {
                frames += 1;
                last_ms = f.pipeline_ms;
                if decoder != f.decoder {
                    eprintln!("decoder: {}", f.decoder);
                    decoder = f.decoder.clone();
                }
                let ir = (f.ir.len() == PIXELS).then_some(f.ir.as_slice());
                out.frame(&f.depth, ir, f.sequence, f.timestamp, f.host_time_us);
            }
            Some(Event::State { state, detail }) => {
                eprintln!("state: {} {detail}", state.name());
                out.json(STATUS, &status_json(state, &detail));
            }
            Some(Event::Device { identity, tables }) => {
                let p = tables.ir_params;
                let json = format!(
                    "{{\"width\":{WIDTH},\"height\":{HEIGHT},\"fx\":{:.6},\"fy\":{:.6},\"cx\":{:.6},\"cy\":{:.6},\"k1\":{:.8},\"k2\":{:.8},\"k3\":{:.8},\"p1\":{:.8},\"p2\":{:.8},\"serial\":{},\"firmware\":{}}}",
                    p.fx,
                    p.fy,
                    p.cx,
                    p.cy,
                    p.k1,
                    p.k2,
                    p.k3,
                    p.p1,
                    p.p2,
                    json_str(&identity.serial),
                    json_str(&identity.firmware)
                );
                out.json(PARAMS, &json);
            }
            Some(Event::Warning(w)) => eprintln!("warning: {w}"),
            Some(Event::Color(_)) => {}
            None => {}
        }
        if out.broken.load(Ordering::SeqCst) {
            break;
        }
    }
    eprintln!("worker exits");
    driver.stop();
    out.stop();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_layout() {
        let h = header(FRAME, FLAG_HAS_IR, 1234, 7, 99, 0x0102_0304_0506_0708);
        assert_eq!(&h[0..4], b"K2W1");
        assert_eq!(u16::from_le_bytes([h[4], h[5]]), 1);
        assert_eq!(u16::from_le_bytes([h[6], h[7]]), 1);
        assert_eq!(u32::from_le_bytes([h[8], h[9], h[10], h[11]]), 1234);
        assert_eq!(u32::from_le_bytes([h[12], h[13], h[14], h[15]]), 7);
        assert_eq!(u32::from_le_bytes([h[16], h[17], h[18], h[19]]), 99);
        assert_eq!(&h[20..24], &[0, 0, 0, 0]);
        assert_eq!(u64::from_le_bytes([h[24], h[25], h[26], h[27], h[28], h[29], h[30], h[31]]), 0x0102_0304_0506_0708);
    }

    #[test]
    fn json_escaping() {
        assert_eq!(json_str("a\"b\\c\nd"), "\"a\\\"b\\\\c d\"");
        assert!(status_json(DriverState::Recovering, "x").contains("\"searching\""));
    }
}
