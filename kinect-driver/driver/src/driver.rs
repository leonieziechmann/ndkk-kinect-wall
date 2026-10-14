//! The driver: finds the Kinect, keeps it streaming, decodes every frame through the pipeline and
//! hands out [`Event`]s. Everything runs on its own threads; [`Driver::recv`] is all an
//! application needs.
//!
//! ```no_run
//! use kinect_driver::driver::{Driver, DriverConfig, Event};
//!
//! let driver = Driver::start(DriverConfig::default())?;
//! while let Some(event) = driver.recv() {
//!     match event {
//!         Event::Frame(f) => println!("frame {}: {} pixels with depth", f.sequence, f.valid_pixels()),
//!         Event::State { state, detail } => println!("{state:?} {detail}"),
//!         _ => {}
//!     }
//! }
//! # Ok::<(), kinect_driver::Error>(())
//! ```
//!
//! What it does about trouble:
//! - no Kinect: keeps looking (also notices one plugged in later)
//! - a USB 2 port: says so clearly and keeps looking
//! - a command fails: retried, the command pipe drained, non-essential steps skipped
//! - the calibration cannot be read: the one cached from an earlier session of the same device
//! - frames stop coming (2 s, 8 s after a start) or the stream dies: the sensor is restarted;
//!   if that keeps failing, the next opening resets the USB port, and after that the firmware
//!   is rebooted
//! - the device disappears: picked up again when it returns
//! - lost USB packets: patched or the frame decoded with the frequencies that arrived
//! - the application reads too slowly: old frames are dropped, never queued without bound
//! - a bug anywhere in a thread or stage: caught, counted, the thread starts over

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::camera::DeviceIdentity;
use crate::device::{DeviceOptions, KinectDevice};
use crate::error::{Error, Result, catch, panic_message};
use crate::frame::Frame;
use crate::packet::RawDepthPacket;
use crate::pipeline::{Backend, Pipeline};
use crate::protocol::color_stream::{ColorFrame, ColorStreamParser};
use crate::protocol::depth_stream::{DepthParserConfig, DepthParserStats, DepthStreamParser};
use crate::record::{RawHeader, RawReader};
use crate::sim::{Scene, SimConfig, Simulator};
use crate::tables::DeviceTables;
use crate::tof::TofConfig;
use crate::usb::{PacketSink, StreamStats, UsbBackend, UsbDeviceInfo};

/// Where frames come from.
#[derive(Clone)]
pub enum Source {
    /// a Kinect on the USB bus (feature `usb`); `serial` picks one of several
    Kinect {
        /// serial number to open (None = the first one)
        serial: Option<String>,
    },
    /// a Kinect behind another USB backend (e.g. the simulated bus `usb::mock::MockBackend`)
    Backend {
        /// the backend
        backend: Arc<dyn UsbBackend>,
        /// serial number to open
        serial: Option<String>,
    },
    /// a raw recording (`.k2raw`)
    Recording {
        /// the file
        path: PathBuf,
        /// at the original speed (30 fps) instead of as fast as possible
        realtime: bool,
        /// start over at the end
        looped: bool,
    },
    /// the simulator
    Simulator {
        /// scene name (`sim::Scene::PRESETS`)
        scene: String,
        /// frames per second
        fps: f32,
        /// the sensor model
        sim: SimConfig,
    },
}

/// When a stream counts as stalled.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Watchdog {
    /// after a start, the first frame must come within this time (after a firmware reboot the
    /// sensor needs ~3 s)
    pub first_frame: Duration,
    /// while streaming, frames must not pause longer than this
    pub frame_gap: Duration,
}

impl Default for Watchdog {
    fn default() -> Self {
        Watchdog { first_frame: Duration::from_secs(8), frame_gap: Duration::from_secs(2) }
    }
}

/// Builds the pipeline (the processing thread calls it at start and after a crash).
pub type PipelineFactory = Arc<dyn Fn() -> Result<Pipeline> + Send + Sync>;

/// Everything about the driver.
#[derive(Clone)]
pub struct DriverConfig {
    /// where frames come from
    pub source: Source,
    /// the pipeline (default: the decoder with `tof` on `backend`)
    pub pipeline: Option<PipelineFactory>,
    /// decoding configuration for the default pipeline
    pub tof: TofConfig,
    /// where the default pipeline decodes
    pub backend: Backend,
    /// also stream the color camera (JPEG frames as `Event::Color`)
    pub color: bool,
    /// USB details
    pub device: DeviceOptions,
    /// how forgiving the depth stream reassembly is
    pub parser: DepthParserConfig,
    /// a lost isochronous packet is replaced by zeros of its size (when `parser` sets no size
    /// itself): only the rows it carried are lost, and the extended decoder rebuilds them from
    /// the other phases, instead of losing the whole sub-image
    pub patch_lost_packets: bool,
    /// stall detection
    pub watchdog: Watchdog,
    /// frames the application may lag behind before the oldest are dropped
    pub queue: usize,
    /// LED brightness 0..=1000 after start (0 = off: no white light in the exhibition)
    pub led: Option<u16>,
    /// directory to cache each device's calibration (used if it cannot be read later)
    pub calibration_cache: Option<PathBuf>,
}

impl Default for DriverConfig {
    fn default() -> Self {
        DriverConfig {
            source: Source::Kinect { serial: None },
            pipeline: None,
            tof: TofConfig::extended(),
            backend: Backend::Cpu,
            color: false,
            device: DeviceOptions::default(),
            parser: DepthParserConfig::default(),
            patch_lost_packets: true,
            watchdog: Watchdog::default(),
            queue: 2,
            led: None,
            calibration_cache: None,
        }
    }
}

/// The driver's state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DriverState {
    /// looking for a device
    Searching,
    /// opening it, reading the calibration
    Starting,
    /// frames are coming
    Streaming,
    /// something went wrong; restarting
    Recovering,
    /// stopped (or the source ended)
    Stopped,
}

impl DriverState {
    /// Lower-case name (as kinect-hub's worker protocol uses: searching/starting/streaming).
    pub fn name(self) -> &'static str {
        match self {
            DriverState::Searching => "searching",
            DriverState::Starting => "starting",
            DriverState::Streaming => "streaming",
            DriverState::Recovering => "recovering",
            DriverState::Stopped => "stopped",
        }
    }
}

/// What the driver tells the application.
#[derive(Debug)]
pub enum Event {
    /// a processed depth frame
    Frame(Box<Frame>),
    /// a color frame (JPEG)
    Color(Box<ColorFrame>),
    /// the state changed
    State {
        /// new state
        state: DriverState,
        /// why
        detail: String,
    },
    /// a device started: who it is and its tables (camera parameters, rays)
    Device {
        /// serial, firmware
        identity: DeviceIdentity,
        /// tables
        tables: Arc<DeviceTables>,
    },
    /// something worth knowing went wrong but the driver carries on
    Warning(String),
}

/// A snapshot of the driver's state and counters.
#[derive(Clone, Debug)]
pub struct DriverStatus {
    /// state
    pub state: DriverState,
    /// why
    pub detail: String,
    /// the device in use
    pub identity: Option<DeviceIdentity>,
    /// frames delivered to the application
    pub frames: u64,
    /// frames dropped because the application read too slowly
    pub dropped: u64,
    /// frames dropped because processing was too slow or failed
    pub processing_dropped: u64,
    /// frames per second over the last second
    pub fps: f32,
    /// reassembly counters
    pub parser: DepthParserStats,
    /// USB stream counters
    pub stream: Option<StreamStats>,
    /// sessions restarted
    pub restarts: u32,
    /// the last problem
    pub last_error: Option<String>,
    /// the decoder in use
    pub decoder: String,
    /// milliseconds of the pipeline for the last frame
    pub pipeline_ms: f64,
    /// panics caught
    pub panics: u64,
}

impl Default for DriverStatus {
    fn default() -> Self {
        DriverStatus {
            state: DriverState::Searching,
            detail: String::new(),
            identity: None,
            frames: 0,
            dropped: 0,
            processing_dropped: 0,
            fps: 0.0,
            parser: DepthParserStats::default(),
            stream: None,
            restarts: 0,
            last_error: None,
            decoder: String::new(),
            pipeline_ms: 0.0,
            panics: 0,
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Microseconds since 1970.
pub fn now_us() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0)
}

// ---- queues ------------------------------------------------------------------------------

/// Events for the application: control events are never dropped (up to a generous limit),
/// frames are, oldest first, once `frame_cap` are waiting.
struct EventQueue {
    q: Mutex<(VecDeque<Event>, VecDeque<Event>)>,
    cv: Condvar,
    frame_cap: usize,
    closed: AtomicBool,
    dropped: AtomicU64,
}

impl EventQueue {
    fn new(frame_cap: usize) -> EventQueue {
        EventQueue { q: Mutex::new((VecDeque::new(), VecDeque::new())), cv: Condvar::new(), frame_cap: frame_cap.max(1), closed: AtomicBool::new(false), dropped: AtomicU64::new(0) }
    }

    fn push(&self, e: Event) {
        let mut q = lock(&self.q);
        match e {
            Event::Frame(_) | Event::Color(_) => {
                while q.1.len() >= self.frame_cap {
                    q.1.pop_front();
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                }
                q.1.push_back(e);
            }
            _ => {
                if q.0.len() >= 1024 {
                    q.0.pop_front();
                }
                q.0.push_back(e);
            }
        }
        drop(q);
        self.cv.notify_one();
    }

    fn pop(&self, timeout: Option<Duration>) -> Option<Event> {
        let deadline = timeout.map(|t| Instant::now() + t);
        let mut q = lock(&self.q);
        loop {
            if let Some(e) = q.0.pop_front() {
                return Some(e);
            }
            if let Some(e) = q.1.pop_front() {
                return Some(e);
            }
            if self.closed.load(Ordering::SeqCst) {
                return None;
            }
            match deadline {
                Some(d) => {
                    let now = Instant::now();
                    if now >= d {
                        return None;
                    }
                    q = self.cv.wait_timeout(q, d - now).map(|(g, _)| g).unwrap_or_else(|p| p.into_inner().0);
                }
                None => q = self.cv.wait_timeout(q, Duration::from_millis(200)).map(|(g, _)| g).unwrap_or_else(|p| p.into_inner().0),
            }
        }
    }

    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.cv.notify_all();
    }
}

type Work = (Arc<RawDepthPacket>, Arc<DeviceTables>);

/// Raw packets for the processing thread: only the newest few; older ones are dropped when
/// processing falls behind.
struct WorkQueue {
    q: Mutex<VecDeque<Work>>,
    cv: Condvar,
    dropped: AtomicU64,
}

impl WorkQueue {
    fn push(&self, w: Work) {
        let mut q = lock(&self.q);
        while q.len() >= 2 {
            q.pop_front();
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
        q.push_back(w);
        drop(q);
        self.cv.notify_one();
    }

    fn pop(&self, timeout: Duration) -> Option<Work> {
        let mut q = lock(&self.q);
        if q.is_empty() {
            q = self.cv.wait_timeout(q, timeout).map(|(g, _)| g).unwrap_or_else(|p| p.into_inner().0);
        }
        q.pop_front()
    }
}

// ---- shared state ------------------------------------------------------------------------

struct Shared {
    cfg: DriverConfig,
    events: EventQueue,
    work: WorkQueue,
    stop: AtomicBool,
    status: Mutex<DriverStatus>,
    epoch: Instant,
    /// ms since epoch of the last complete raw packet (0 = none in this session)
    last_packet_ms: AtomicU64,
    /// counts device sessions (see `DepthSink::session`)
    session: AtomicU64,
    packets: AtomicU64,
    lost: AtomicBool,
    parser_stats: Mutex<DepthParserStats>,
    panics: AtomicU64,
}

impl Shared {
    fn ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }

    fn stopping(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    fn set_state(&self, state: DriverState, detail: &str) {
        let changed = {
            let mut s = lock(&self.status);
            let changed = s.state != state || s.detail != detail;
            s.state = state;
            s.detail = detail.to_string();
            changed
        };
        if changed {
            log::info!("kinect: {} {detail}", state.name());
            self.events.push(Event::State { state, detail: detail.to_string() });
        }
    }

    fn warn(&self, m: String) {
        log::warn!("kinect: {m}");
        lock(&self.status).last_error = Some(m.clone());
        self.events.push(Event::Warning(m));
    }

    /// Sleeps in small steps; false if the driver is stopping.
    fn sleep(&self, d: Duration) -> bool {
        let end = Instant::now() + d;
        while !self.stopping() {
            let now = Instant::now();
            if now >= end {
                return true;
            }
            std::thread::sleep((end - now).min(Duration::from_millis(20)));
        }
        false
    }
}

// ---- sinks (run on the USB event thread) ------------------------------------------------

struct DepthSink {
    parser: DepthStreamParser,
    shared: Arc<Shared>,
    tables: Arc<DeviceTables>,
    /// the session this stream belongs to: a stream left behind by an earlier session (its
    /// transfers did not come back in time) must not feed the current one
    session: u64,
}

impl DepthSink {
    fn current(&self) -> bool {
        self.shared.session.load(Ordering::SeqCst) == self.session
    }
}

impl PacketSink for DepthSink {
    fn packet(&mut self, data: &[u8], ok: bool) {
        if !self.current() {
            return;
        }
        if let Some(mut p) = self.parser.push(data, ok) {
            p.host_time_us = now_us();
            self.shared.last_packet_ms.store(self.shared.ms().max(1), Ordering::SeqCst);
            self.shared.packets.fetch_add(1, Ordering::Relaxed);
            *lock(&self.shared.parser_stats) = self.parser.stats.clone();
            self.shared.work.push((Arc::new(p), self.tables.clone()));
        }
    }
    fn lost(&mut self) {
        if self.current() {
            self.shared.lost.store(true, Ordering::SeqCst);
        }
    }
}

struct ColorSink {
    parser: ColorStreamParser,
    shared: Arc<Shared>,
    session: u64,
}

impl ColorSink {
    fn current(&self) -> bool {
        self.shared.session.load(Ordering::SeqCst) == self.session
    }
}

impl PacketSink for ColorSink {
    fn packet(&mut self, data: &[u8], ok: bool) {
        if !ok || !self.current() {
            return;
        }
        if let Some(mut f) = self.parser.push(data) {
            f.host_time_us = now_us();
            self.shared.events.push(Event::Color(Box::new(f)));
        }
    }
    fn lost(&mut self) {
        if self.current() {
            self.shared.lost.store(true, Ordering::SeqCst);
        }
    }
}

// ---- the driver ----------------------------------------------------------------------------

/// A running driver. Dropping it stops everything (the device is switched off and released).
pub struct Driver {
    shared: Arc<Shared>,
    threads: Vec<JoinHandle<()>>,
}

impl Driver {
    /// Starts the driver threads. Fails only for an unusable configuration; a missing device is
    /// not an error (the driver waits for one).
    pub fn start(cfg: DriverConfig) -> Result<Driver> {
        cfg.tof.validate()?;
        if let Source::Kinect { .. } = cfg.source
            && !cfg!(feature = "usb-system")
        {
            return Err(Error::Unsupported("this build has no USB access (feature `usb`)".into()));
        }
        let shared = Arc::new(Shared {
            events: EventQueue::new(cfg.queue),
            work: WorkQueue { q: Mutex::new(VecDeque::new()), cv: Condvar::new(), dropped: AtomicU64::new(0) },
            stop: AtomicBool::new(false),
            status: Mutex::new(DriverStatus::default()),
            epoch: Instant::now(),
            last_packet_ms: AtomicU64::new(0),
            session: AtomicU64::new(0),
            packets: AtomicU64::new(0),
            lost: AtomicBool::new(false),
            parser_stats: Mutex::new(DepthParserStats::default()),
            panics: AtomicU64::new(0),
            cfg,
        });
        let mut threads = Vec::new();
        let s = shared.clone();
        threads.push(spawn("kinect-process", move || guarded(&s, process_loop))?);
        let s = shared.clone();
        threads.push(spawn("kinect-source", move || guarded(&s, source_loop))?);
        Ok(Driver { shared, threads })
    }

    /// The next event; blocks. `None` once the driver stopped.
    pub fn recv(&self) -> Option<Event> {
        self.shared.events.pop(None)
    }

    /// The next event, waiting at most `timeout`.
    pub fn recv_timeout(&self, timeout: Duration) -> Option<Event> {
        self.shared.events.pop(Some(timeout))
    }

    /// The next event if one is waiting.
    pub fn try_recv(&self) -> Option<Event> {
        self.shared.events.pop(Some(Duration::ZERO))
    }

    /// A snapshot of state and counters.
    pub fn status(&self) -> DriverStatus {
        let mut s = lock(&self.shared.status).clone();
        s.dropped = self.shared.events.dropped.load(Ordering::Relaxed);
        s.processing_dropped = self.shared.work.dropped.load(Ordering::Relaxed);
        s.parser = lock(&self.shared.parser_stats).clone();
        s.panics = self.shared.panics.load(Ordering::Relaxed);
        s
    }

    /// Stops the driver (also done on drop).
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        self.shared.work.cv.notify_all();
        // every wait in the threads is short, but a USB call can block for seconds on a sick
        // controller: after a while they are left to finish on their own (they only hold
        // shared state, nothing that goes away)
        let end = Instant::now() + Duration::from_secs(6);
        for t in self.threads.drain(..) {
            while !t.is_finished() && Instant::now() < end {
                std::thread::sleep(Duration::from_millis(5));
            }
            if t.is_finished() {
                let _ = t.join();
            } else {
                log::warn!("kinect: thread {:?} is still busy; not waiting for it", t.thread().name());
            }
        }
        self.shared.set_state(DriverState::Stopped, "stopped");
        self.shared.events.close();
    }
}

impl Drop for Driver {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn spawn(name: &str, f: impl FnOnce() + Send + 'static) -> Result<JoinHandle<()>> {
    std::thread::Builder::new().name(name.into()).spawn(f).map_err(|e| Error::Io(format!("cannot start a thread: {e}")))
}

/// Runs `body` again and again until the driver stops: a panic inside is counted and the loop
/// starts over after a pause.
fn guarded(shared: &Arc<Shared>, body: fn(&Arc<Shared>)) {
    while !shared.stopping() {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| body(shared))) {
            Ok(()) => return,
            Err(p) => {
                shared.panics.fetch_add(1, Ordering::Relaxed);
                shared.warn(format!("internal error caught, restarting: {}", panic_message(p.as_ref())));
                shared.sleep(Duration::from_millis(500));
            }
        }
    }
}

// ---- processing thread ---------------------------------------------------------------------

fn make_pipeline(shared: &Shared) -> Result<Pipeline> {
    match &shared.cfg.pipeline {
        Some(f) => f(),
        None => Pipeline::decoder(shared.cfg.tof.clone(), shared.cfg.backend),
    }
}

fn process_loop(shared: &Arc<Shared>) {
    let mut pipeline = match make_pipeline(shared) {
        Ok(p) => p,
        Err(e) => {
            shared.warn(format!("pipeline: {e}; decoding on the CPU with the defaults"));
            match Pipeline::decoder(TofConfig::extended(), Backend::Cpu) {
                Ok(p) => p,
                Err(e) => {
                    shared.warn(format!("no pipeline at all: {e}"));
                    return;
                }
            }
        }
    };
    let mut tables_id = 0u64;
    let mut window: VecDeque<Instant> = VecDeque::new();
    let mut failures = 0u32;
    while !shared.stopping() {
        let Some((raw, tables)) = shared.work.pop(Duration::from_millis(100)) else { continue };
        if tables.id != tables_id {
            tables_id = tables.id;
            pipeline.reset();
        }
        let mut frame = Frame::new(raw, tables);
        match pipeline.run(&mut frame) {
            Ok(()) => {
                failures = 0;
                let now = Instant::now();
                window.push_back(now);
                while window.front().is_some_and(|t| now.duration_since(*t) > Duration::from_secs(1)) {
                    window.pop_front();
                }
                {
                    let mut s = lock(&shared.status);
                    s.frames += 1;
                    s.fps = window.len() as f32;
                    s.decoder = frame.decoder.clone();
                    s.pipeline_ms = frame.pipeline_ms;
                }
                shared.events.push(Event::Frame(Box::new(frame)));
            }
            Err(e) => {
                shared.work.dropped.fetch_add(1, Ordering::Relaxed);
                failures += 1;
                if failures <= 3 || failures.is_power_of_two() {
                    shared.warn(format!("frame {} dropped: {e}", frame.sequence));
                }
                if failures >= 30 {
                    // the pipeline keeps failing: build a fresh one
                    if let Ok(p) = make_pipeline(shared) {
                        pipeline = p;
                    }
                    failures = 0;
                }
            }
        }
    }
}

// ---- sources ---------------------------------------------------------------------------------

fn source_loop(shared: &Arc<Shared>) {
    match shared.cfg.source.clone() {
        Source::Kinect { serial } => {
            // libusb can fail to start (no USB file system yet, a broken install): keep trying
            let mut said = String::new();
            loop {
                match usb_backend() {
                    Ok(b) => break device_loop(shared, b, serial),
                    Err(e) if !cfg!(feature = "usb-system") => break shared.set_state(DriverState::Stopped, &format!("{e}")),
                    Err(e) => {
                        let msg = format!("USB not available ({e}); trying again");
                        if msg != said {
                            shared.set_state(DriverState::Searching, &msg);
                            said = msg;
                        }
                        if !shared.sleep(Duration::from_secs(2)) {
                            break;
                        }
                    }
                }
            }
        }
        Source::Backend { backend, serial } => device_loop(shared, backend, serial),
        Source::Recording { path, realtime, looped } => recording_loop(shared, &path, realtime, looped),
        Source::Simulator { scene, fps, sim } => simulator_loop(shared, &scene, fps, sim),
    }
}

#[cfg(feature = "usb-system")]
fn usb_backend() -> Result<Arc<dyn UsbBackend>> {
    Ok(Arc::new(crate::usb::libusb::LibusbBackend::new()?))
}

#[cfg(not(feature = "usb-system"))]
fn usb_backend() -> Result<Arc<dyn UsbBackend>> {
    Err(Error::Unsupported("built without USB support".into()))
}

/// How hard the next opening tries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Escalation {
    Normal,
    ResetPort,
    RebootFirmware,
}

fn device_loop(shared: &Arc<Shared>, backend: Arc<dyn UsbBackend>, serial: Option<String>) {
    log::info!("kinect: USB through {}", backend.name());
    let mut backoff = Duration::from_millis(200);
    let mut failed_sessions = 0u32;
    let mut said_none = false;
    while !shared.stopping() {
        shared.set_state(DriverState::Searching, "looking for a Kinect v2");
        let found = match backend.list() {
            Ok(l) => l,
            Err(e) => {
                shared.warn(format!("cannot list USB devices: {e}"));
                Vec::new()
            }
        };
        let Some(info) = pick(&found, &serial, &backend) else {
            if !said_none {
                said_none = true;
                shared.set_state(DriverState::Searching, if found.is_empty() { "no Kinect v2 on USB" } else { "the requested Kinect is not connected" });
            }
            if !shared.sleep(Duration::from_millis(500)) {
                break;
            }
            continue;
        };
        said_none = false;
        let escalation = match failed_sessions {
            0 | 1 => Escalation::Normal,
            2 => Escalation::ResetPort,
            _ => Escalation::RebootFirmware,
        };
        let outcome = session(shared, &backend, &info, escalation);
        if shared.stopping() {
            break;
        }
        match outcome {
            SessionEnd::Good => {
                failed_sessions = 0;
                backoff = Duration::from_millis(200);
            }
            SessionEnd::Failed(reason) => {
                failed_sessions += 1;
                lock(&shared.status).restarts += 1;
                shared.warn(reason.clone());
                shared.set_state(DriverState::Recovering, &reason);
                if escalation == Escalation::RebootFirmware {
                    failed_sessions = 1;
                }
                backoff = (backoff * 2).min(Duration::from_secs(5));
            }
            SessionEnd::Fatal(reason) => {
                shared.set_state(DriverState::Searching, &reason);
                backoff = Duration::from_secs(5);
            }
        }
        if !shared.sleep(backoff) {
            break;
        }
    }
}

fn pick(found: &[UsbDeviceInfo], serial: &Option<String>, backend: &Arc<dyn UsbBackend>) -> Option<UsbDeviceInfo> {
    match serial {
        None => found.first().cloned(),
        Some(want) => found
            .iter()
            .find(|i| backend.open(i).ok().and_then(|mut d| d.serial().ok()).is_some_and(|s| &s == want))
            .cloned(),
    }
}

enum SessionEnd {
    /// streamed for a while, then ended (unplugged, stopped)
    Good,
    /// did not get going or stalled: try harder next time
    Failed(String),
    /// cannot work on this port (USB 2): wait for the user
    Fatal(String),
}

fn session(shared: &Arc<Shared>, backend: &Arc<dyn UsbBackend>, info: &UsbDeviceInfo, escalation: Escalation) -> SessionEnd {
    shared.set_state(DriverState::Starting, &format!("opening the Kinect on port {}", info.port_path));
    let session = shared.session.fetch_add(1, Ordering::SeqCst) + 1;
    shared.lost.store(false, Ordering::SeqCst);
    shared.last_packet_ms.store(0, Ordering::SeqCst);
    let mut opts = shared.cfg.device.clone();
    if escalation == Escalation::ResetPort {
        opts.reset_on_open = true;
    }
    let usb = match backend.open(info) {
        Ok(u) => u,
        Err(e) => return SessionEnd::Failed(format!("cannot open the Kinect: {e}")),
    };
    let mut dev = match KinectDevice::open(usb, opts) {
        Ok(d) => d,
        Err(e @ Error::NotSuperSpeed(_)) => return SessionEnd::Fatal(format!("{e} - plug it into a USB 3 port")),
        Err(e) => return SessionEnd::Failed(format!("cannot set up the Kinect: {e}")),
    };
    shared.set_state(DriverState::Starting, "reading the calibration");
    let (identity, tables) = match calibration(shared, &mut dev) {
        Ok(c) => c,
        Err(e) => return end_failed(dev, escalation, format!("no calibration: {e}")),
    };
    lock(&shared.status).identity = Some(identity.clone());
    shared.events.push(Event::Device { identity: identity.clone(), tables: tables.clone() });
    let mut parser = shared.cfg.parser.clone();
    if shared.cfg.patch_lost_packets && parser.fill_lost_packets.is_none() {
        parser.fill_lost_packets = Some(dev.iso_packet_size());
    }
    let depth = DepthSink { parser: DepthStreamParser::new(parser), shared: shared.clone(), tables, session };
    let color: Option<Box<dyn PacketSink>> =
        if shared.cfg.color { Some(Box::new(ColorSink { parser: ColorStreamParser::new(), shared: shared.clone(), session })) } else { None };
    shared.set_state(DriverState::Starting, "switching the sensor on");
    if let Err(e) = dev.start(Box::new(depth), color) {
        return end_failed(dev, escalation, format!("cannot start streaming: {e}"));
    }
    for w in dev.warnings.drain(..) {
        shared.events.push(Event::Warning(w));
    }
    if let Some(level) = shared.cfg.led
        && let Err(e) = dev.set_led(crate::protocol::command::Led::Primary, level, None)
    {
        shared.warn(format!("LED: {e}"));
    }
    // watch the stream
    let started = shared.ms();
    let start_packets = shared.packets.load(Ordering::Relaxed);
    let wd = shared.cfg.watchdog;
    let mut streaming = false;
    let reason = loop {
        if shared.stopping() {
            break None;
        }
        std::thread::sleep(Duration::from_millis(20));
        if shared.lost.load(Ordering::SeqCst) {
            break Some("the Kinect disappeared from the bus".to_string());
        }
        let last = shared.last_packet_ms.load(Ordering::SeqCst);
        let now = shared.ms();
        if last > 0 && !streaming {
            streaming = true;
            shared.set_state(DriverState::Streaming, &format!("{} ({})", identity.serial, identity.firmware));
        }
        if last == 0 && now.saturating_sub(started) > wd.first_frame.as_millis() as u64 {
            break Some(format!("no frame {} s after the start", wd.first_frame.as_secs()));
        }
        if last > 0 && now.saturating_sub(last) > wd.frame_gap.as_millis() as u64 {
            break Some(format!("frames stopped for {} ms", now.saturating_sub(last)));
        }
        if !dev.streams_alive() {
            break Some("the USB stream died".to_string());
        }
        let stats = dev.stream_stats();
        lock(&shared.status).stream = stats.first().copied();
    };
    let frames = shared.packets.load(Ordering::Relaxed).saturating_sub(start_packets);
    let gone = shared.lost.load(Ordering::SeqCst);
    match reason {
        None => {
            dev.close();
            SessionEnd::Good
        }
        Some(r) if gone => {
            drop(dev);
            if frames > 30 { SessionEnd::Good } else { SessionEnd::Failed(r) }
        }
        Some(r) => {
            if frames > 300 {
                // streamed fine for a while: an ordinary restart
                dev.close();
                SessionEnd::Failed(r)
            } else {
                end_failed(dev, escalation, r)
            }
        }
    }
}

fn end_failed(dev: KinectDevice, escalation: Escalation, reason: String) -> SessionEnd {
    if escalation == Escalation::RebootFirmware {
        log::warn!("kinect: rebooting the firmware ({reason})");
        dev.reboot();
        // the device is gone for a few seconds
        std::thread::sleep(Duration::from_millis(1500));
        SessionEnd::Failed(format!("{reason}; firmware rebooted"))
    } else {
        dev.close();
        SessionEnd::Failed(reason)
    }
}

/// Reads the calibration; falls back to (and keeps) the cached one of the same device.
fn calibration(shared: &Shared, dev: &mut KinectDevice) -> Result<(DeviceIdentity, Arc<DeviceTables>)> {
    match dev.read_calibration() {
        Ok(c) => {
            let tables = DeviceTables::new(c.ir_params, c.p0, &c.identity.serial)?;
            if let Some(dir) = &shared.cfg.calibration_cache
                && let Err(e) = save_calibration(dir, &c.identity.serial, &tables)
            {
                log::debug!("kinect: calibration cache: {e}");
            }
            Ok((c.identity, tables))
        }
        Err(e) => {
            let Some(dir) = &shared.cfg.calibration_cache else { return Err(e) };
            let serial = dev_serial(dev).ok_or(e.clone())?;
            let tables = load_calibration(dir, &serial).map_err(|_| e.clone())?;
            shared.warn(format!("calibration from the cache ({e})"));
            Ok((DeviceIdentity { serial, ..Default::default() }, tables))
        }
    }
}

fn dev_serial(dev: &mut KinectDevice) -> Option<String> {
    dev.command(&crate::protocol::command::Command::read_serial())
        .ok()
        .map(|d| crate::protocol::response::parse_serial(&d))
        .filter(|s| !s.is_empty())
}

fn cache_path(dir: &Path, serial: &str) -> PathBuf {
    let safe: String = serial.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    dir.join(format!("kinect-{safe}.k2cal"))
}

/// Stores a device's calibration (the header of a raw recording) in `dir`.
pub fn save_calibration(dir: &Path, serial: &str, tables: &DeviceTables) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = cache_path(dir, serial);
    let tmp = path.with_extension("tmp");
    {
        let mut w = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
        crate::record::write_header(&mut w, &RawHeader::from_tables(tables))?;
        std::io::Write::flush(&mut w)?;
    }
    // atomic: a half-written cache is never read
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Loads a cached calibration.
pub fn load_calibration(dir: &Path, serial: &str) -> Result<Arc<DeviceTables>> {
    let path = cache_path(dir, serial);
    let mut f = std::io::BufReader::new(std::fs::File::open(&path)?);
    let header = crate::record::read_header(&mut f)?;
    header.tables()
}

fn recording_loop(shared: &Arc<Shared>, path: &Path, realtime: bool, looped: bool) {
    let mut reader = match RawReader::open(path) {
        Ok(r) => r,
        Err(e) => {
            shared.set_state(DriverState::Stopped, &format!("{}: {e}", path.display()));
            return;
        }
    };
    let tables = match reader.header().tables() {
        Ok(t) => t,
        Err(e) => {
            shared.set_state(DriverState::Stopped, &format!("{}: {e}", path.display()));
            return;
        }
    };
    let identity = DeviceIdentity { serial: format!("recording {}", path.display()), ..Default::default() };
    lock(&shared.status).identity = Some(identity.clone());
    shared.events.push(Event::Device { identity, tables: tables.clone() });
    shared.set_state(DriverState::Streaming, &format!("playing {}", path.display()));
    let period = Duration::from_millis(33);
    let mut next = Instant::now();
    let mut seq = 0u32;
    while !shared.stopping() {
        match reader.next_packet() {
            Ok(Some(mut p)) => {
                if realtime {
                    let now = Instant::now();
                    if now < next && !shared.sleep(next - now) {
                        break;
                    }
                    next = next.max(Instant::now() - period) + period;
                }
                p.host_time_us = now_us();
                p.sequence = seq;
                seq = seq.wrapping_add(1);
                shared.last_packet_ms.store(shared.ms().max(1), Ordering::SeqCst);
                shared.work.push((Arc::new(p), tables.clone()));
                if !realtime {
                    // as fast as the pipeline takes them
                    while lock(&shared.work.q).len() >= 2 && !shared.stopping() {
                        std::thread::sleep(Duration::from_millis(1));
                    }
                }
            }
            Ok(None) if looped => {
                if reader.rewind().is_err() {
                    break;
                }
            }
            Ok(None) => break,
            Err(e) => {
                shared.warn(format!("recording: {e}"));
                break;
            }
        }
    }
    // let the last frames through
    while !lock(&shared.work.q).is_empty() && !shared.stopping() {
        std::thread::sleep(Duration::from_millis(5));
    }
    std::thread::sleep(Duration::from_millis(50));
    shared.set_state(DriverState::Stopped, "end of the recording");
    shared.events.close();
}

fn simulator_loop(shared: &Arc<Shared>, scene: &str, fps: f32, sim: SimConfig) {
    let mut sim = match Simulator::new(sim) {
        Ok(s) => s,
        Err(e) => {
            shared.set_state(DriverState::Stopped, &format!("simulator: {e}"));
            return;
        }
    };
    let tables = sim.tables().clone();
    let identity = DeviceIdentity { serial: "SIMULATED".into(), firmware: "simulator".into(), ..Default::default() };
    lock(&shared.status).identity = Some(identity.clone());
    shared.events.push(Event::Device { identity, tables: tables.clone() });
    shared.set_state(DriverState::Streaming, &format!("simulated scene '{scene}'"));
    let period = Duration::from_secs_f32(1.0 / fps.max(0.1));
    let t0 = Instant::now();
    let mut seq = 0u32;
    while !shared.stopping() {
        let started = Instant::now();
        let Some(s) = Scene::preset(scene, t0.elapsed().as_secs_f32()) else {
            shared.set_state(DriverState::Stopped, &format!("unknown scene {scene:?}"));
            return;
        };
        let r = catch(|| Ok(sim.frame(&s, seq)));
        if let Ok((mut p, _)) = r {
            p.host_time_us = now_us();
            shared.last_packet_ms.store(shared.ms().max(1), Ordering::SeqCst);
            shared.work.push((Arc::new(p), tables.clone()));
        }
        seq = seq.wrapping_add(1);
        let spent = started.elapsed();
        if spent < period && !shared.sleep(period - spent) {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usb::mock::{Faults, MockBackend, MockConfig};

    fn mock_driver(faults: Faults, watchdog: Watchdog) -> (Driver, MockBackend) {
        let backend = MockBackend::new(MockConfig { faults, fps: 60.0, ..Default::default() });
        let cfg = DriverConfig {
            source: Source::Backend { backend: Arc::new(backend.clone()), serial: None },
            watchdog,
            queue: 4,
            ..Default::default()
        };
        (Driver::start(cfg).unwrap(), backend)
    }

    fn frames_within(d: &Driver, n: usize, timeout: Duration) -> (usize, Vec<String>) {
        let end = Instant::now() + timeout;
        let mut got = 0;
        let mut log = Vec::new();
        while got < n && Instant::now() < end {
            match d.recv_timeout(Duration::from_millis(100)) {
                Some(Event::Frame(f)) => {
                    assert!(f.valid_pixels() > 50_000, "a decoded frame");
                    got += 1;
                }
                Some(Event::State { state, detail }) => log.push(format!("{} {detail}", state.name())),
                Some(Event::Warning(w)) => log.push(format!("warning {w}")),
                _ => {}
            }
        }
        (got, log)
    }

    #[test]
    fn streams_from_the_simulated_device() {
        let (d, _) = mock_driver(Faults::default(), Watchdog::default());
        let (got, log) = frames_within(&d, 5, Duration::from_secs(20));
        assert_eq!(got, 5, "{log:?}");
        let s = d.status();
        assert_eq!(s.state, DriverState::Streaming);
        assert_eq!(s.identity.map(|i| i.serial), Some("MOCK00000001".to_string()));
        d.stop();
    }

    #[test]
    fn survives_lost_packets_timeouts_and_busy_opens() {
        let faults = Faults { lost_packets: 0.01, corrupt_packets: 0.005, open_failures: 2, command_timeouts: 3, ..Default::default() };
        let (d, _) = mock_driver(faults, Watchdog::default());
        let (got, log) = frames_within(&d, 5, Duration::from_secs(30));
        assert_eq!(got, 5, "{log:?}");
    }

    #[test]
    fn comes_back_after_unplugging() {
        let faults = Faults { unplug_after_frames: Some(6), replug_after: Duration::from_millis(300), ..Default::default() };
        let (d, backend) = mock_driver(faults, Watchdog::default());
        let (got, log) = frames_within(&d, 4, Duration::from_secs(20));
        assert_eq!(got, 4, "{log:?}");
        // it unplugs after 6 frames; then it must come back and stream again
        let before = backend.frames_sent();
        let (got, log) = frames_within(&d, 8, Duration::from_secs(30));
        assert!(got >= 4, "{got} frames after replugging; {log:?}");
        assert!(backend.frames_sent() > before);
        assert!(log.iter().any(|l| l.contains("disappeared") || l.contains("searching")), "{log:?}");
    }

    #[test]
    fn restarts_a_stalled_stream() {
        let faults = Faults { stall_after_frames: Some(5), ..Default::default() };
        let wd = Watchdog { first_frame: Duration::from_secs(5), frame_gap: Duration::from_millis(400) };
        let (d, backend) = mock_driver(faults, wd);
        // the stream stalls after 5 frames, the watchdog restarts it, frames come again
        let end = Instant::now() + Duration::from_secs(30);
        let mut log = Vec::new();
        while Instant::now() < end && backend.frames_sent() < 5 {
            let (_, l) = frames_within(&d, 1, Duration::from_millis(200));
            log.extend(l);
        }
        let (got, l) = frames_within(&d, 3, Duration::from_secs(20));
        log.extend(l);
        assert_eq!(got, 3, "{log:?}");
        assert!(log.iter().any(|l| l.contains("frames stopped")), "{log:?}");
        assert!(d.status().restarts >= 1);
    }

    #[test]
    fn stops_quickly_in_every_state() {
        // while streaming
        let (d, _) = mock_driver(Faults::default(), Watchdog::default());
        let (got, log) = frames_within(&d, 2, Duration::from_secs(20));
        assert_eq!(got, 2, "{log:?}");
        let t = Instant::now();
        d.stop();
        assert!(t.elapsed() < Duration::from_secs(3), "{:?}", t.elapsed());
        // while waiting for a device that is gone
        let faults = Faults { unplug_after_frames: Some(1), replug_after: Duration::from_secs(3600), ..Default::default() };
        let (d, backend) = mock_driver(faults, Watchdog::default());
        let end = Instant::now() + Duration::from_secs(20);
        while backend.frames_sent() < 1 && Instant::now() < end {
            let _ = d.recv_timeout(Duration::from_millis(50));
        }
        std::thread::sleep(Duration::from_millis(300));
        let t = Instant::now();
        drop(d);
        assert!(t.elapsed() < Duration::from_secs(3), "{:?}", t.elapsed());
    }

    #[test]
    fn usb2_is_reported_clearly() {
        let (d, _) = mock_driver(Faults { usb2: true, ..Default::default() }, Watchdog::default());
        let end = Instant::now() + Duration::from_secs(10);
        let mut seen = false;
        while Instant::now() < end && !seen {
            if let Some(Event::State { detail, .. }) = d.recv_timeout(Duration::from_millis(100)) {
                seen = detail.contains("USB 3");
            }
        }
        assert!(seen);
    }

    #[test]
    fn a_panicking_stage_does_not_stop_the_driver() {
        let backend = MockBackend::new(MockConfig { fps: 60.0, ..Default::default() });
        let n = Arc::new(AtomicU64::new(0));
        let n2 = n.clone();
        let cfg = DriverConfig {
            source: Source::Backend { backend: Arc::new(backend), serial: None },
            pipeline: Some(Arc::new(move || {
                let n = n2.clone();
                Ok(Pipeline::decoder(TofConfig::compat(), Backend::Cpu)?.with_fn("flaky", move |_f| {
                    if n.fetch_add(1, Ordering::SeqCst).is_multiple_of(2) {
                        panic!("every other frame");
                    }
                    Ok(())
                }))
            })),
            ..Default::default()
        };
        let d = Driver::start(cfg).unwrap();
        let (got, log) = frames_within(&d, 6, Duration::from_secs(20));
        assert_eq!(got, 6, "{log:?}");
        assert!(n.load(Ordering::SeqCst) >= 6);
    }
}
