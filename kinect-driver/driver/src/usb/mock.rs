//! A simulated Kinect v2 on a simulated bus: answers the protocol's commands, streams the
//! simulator's frames as isochronous packets once streaming is switched on, and misbehaves on
//! request (lost or corrupted packets, timeouts, stalls, unplugging and replugging, a late
//! ready bit). The driver's device logic and supervisor are tested against it, and it is the
//! `mock` source of the command line tool (everything without hardware).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::{BulkConfig, IsoConfig, PacketSink, Stream, StreamStats, UsbBackend, UsbDevice, UsbDeviceInfo, UsbSpeed};
use crate::camera::IrCameraParams;
use crate::consts::{CONTROL_IN, CONTROL_OUT, MIN_DEPTH_ISO_PACKET, PRODUCT_ID};
use crate::error::{Error, Result};
use crate::packet::RawDepthPacket;
use crate::protocol::command::{decode_command, encode_response_complete, id, page};
use crate::protocol::depth_stream::encode_subpackets;
use crate::protocol::response::{encode_depth_params, encode_firmware, encode_p0_tables, encode_serial};
use crate::sim::rng::Rng;
use crate::sim::{Scene, SimConfig, Simulator};

/// What goes wrong with the simulated device.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Faults {
    /// probability that an isochronous packet is reported as failed
    pub lost_packets: f32,
    /// probability that an isochronous packet arrives with flipped bits (undetected by USB)
    pub corrupt_packets: f32,
    /// the device drops off the bus after this many frames ...
    pub unplug_after_frames: Option<u32>,
    /// ... and comes back after this long (with a new address)
    pub replug_after: Duration,
    /// the stream silently stops once, after this many frames (until it is restarted)
    pub stall_after_frames: Option<u32>,
    /// the first opens fail as busy
    pub open_failures: u32,
    /// the first command answers time out
    pub command_timeouts: u32,
    /// the sensor-ready status bit appears only this long after the mode commands
    pub ready_delay: Duration,
    /// the device sits on a USB 2 port (cannot stream)
    pub usb2: bool,
}

/// Configuration of the simulated device.
#[derive(Clone, Debug, PartialEq)]
pub struct MockConfig {
    /// the sensor model
    pub sim: SimConfig,
    /// scene name (see [`Scene::preset`])
    pub scene: String,
    /// distinct frames rendered once and then repeated (rendering is slow)
    pub distinct_frames: u32,
    /// frames per second (0 = as fast as possible)
    pub fps: f32,
    /// bytes per isochronous packet
    pub iso_packet_size: usize,
    /// serial number
    pub serial: String,
    /// misbehavior
    pub faults: Faults,
}

impl Default for MockConfig {
    fn default() -> Self {
        MockConfig {
            sim: SimConfig { supersample: false, ..SimConfig::default() },
            scene: "room".to_string(),
            distinct_frames: 2,
            fps: 30.0,
            iso_packet_size: MIN_DEPTH_ISO_PACKET,
            serial: "MOCK00000001".to_string(),
            faults: Faults::default(),
        }
    }
}

/// The state of the simulated bus.
struct World {
    present: bool,
    back_at: Option<Instant>,
    address: u8,
    opens: u32,
    command_timeouts_left: u32,
}

struct Shared {
    cfg: MockConfig,
    world: Mutex<World>,
    frames: Mutex<Option<Arc<Vec<RawDepthPacket>>>>,
    tables: Mutex<Option<(IrCameraParams, [Vec<u16>; 3])>>,
    /// frames sent since the device appeared
    frames_sent: AtomicU32,
    /// the stall has happened
    stalled_once: AtomicBool,
    /// total frames sent
    pub total_frames: AtomicU64,
}

/// The simulated bus with one simulated Kinect on it.
#[derive(Clone)]
pub struct MockBackend {
    shared: Arc<Shared>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl MockBackend {
    /// A bus with one simulated Kinect.
    pub fn new(cfg: MockConfig) -> MockBackend {
        let timeouts = cfg.faults.command_timeouts;
        MockBackend {
            shared: Arc::new(Shared {
                cfg,
                world: Mutex::new(World { present: true, back_at: None, address: 7, opens: 0, command_timeouts_left: timeouts }),
                frames: Mutex::new(None),
                tables: Mutex::new(None),
                frames_sent: AtomicU32::new(0),
                stalled_once: AtomicBool::new(false),
                total_frames: AtomicU64::new(0),
            }),
        }
    }

    /// Frames the simulated device has sent so far.
    pub fn frames_sent(&self) -> u64 {
        self.shared.total_frames.load(Ordering::Relaxed)
    }

    /// Pulls the plug now (the device comes back after `faults.replug_after`).
    pub fn unplug(&self) {
        unplug(&self.shared);
    }

    fn refresh(&self) {
        let mut w = lock(&self.shared.world);
        if !w.present && w.back_at.is_some_and(|t| Instant::now() >= t) {
            w.present = true;
            w.back_at = None;
            w.address = w.address.wrapping_add(1).max(1);
            self.shared.frames_sent.store(0, Ordering::Relaxed);
        }
    }
}

fn unplug(shared: &Shared) {
    let mut w = lock(&shared.world);
    if w.present {
        w.present = false;
        w.back_at = Some(Instant::now() + shared.cfg.faults.replug_after);
    }
}

fn present(shared: &Shared) -> bool {
    lock(&shared.world).present
}

/// The rendered frames, the camera parameters and the P0 tables.
type Content = (Arc<Vec<RawDepthPacket>>, IrCameraParams, [Vec<u16>; 3]);

/// The tables and the rendered frames (once per backend).
fn content(shared: &Shared) -> Result<Content> {
    if let (Some(f), Some((ir, p0))) = (lock(&shared.frames).clone(), lock(&shared.tables).clone()) {
        return Ok((f, ir, p0));
    }
    let mut sim = Simulator::new(shared.cfg.sim.clone())?;
    let mut frames = Vec::new();
    for k in 0..shared.cfg.distinct_frames.max(1) {
        let scene = Scene::preset(&shared.cfg.scene, k as f32 * 0.25).ok_or_else(|| Error::config(format!("unknown scene {:?}", shared.cfg.scene)))?;
        frames.push(sim.frame(&scene, k).0);
    }
    let frames = Arc::new(frames);
    let t = sim.tables();
    let tables = (t.ir_params, t.p0.clone());
    *lock(&shared.frames) = Some(frames.clone());
    *lock(&shared.tables) = Some(tables.clone());
    Ok((frames, tables.0, tables.1))
}

impl UsbBackend for MockBackend {
    fn name(&self) -> String {
        "simulated bus".to_string()
    }

    fn list(&self) -> Result<Vec<UsbDeviceInfo>> {
        self.refresh();
        let w = lock(&self.shared.world);
        if !w.present {
            return Ok(Vec::new());
        }
        let speed = if self.shared.cfg.faults.usb2 { UsbSpeed::High } else { UsbSpeed::Super };
        Ok(vec![UsbDeviceInfo { bus: 2, address: w.address, port_path: "2-1".to_string(), product_id: PRODUCT_ID, speed }])
    }

    fn open(&self, info: &UsbDeviceInfo) -> Result<Box<dyn UsbDevice>> {
        self.refresh();
        let mut w = lock(&self.shared.world);
        if !w.present || w.address != info.address {
            return Err(Error::NoDevice);
        }
        w.opens += 1;
        if w.opens <= self.shared.cfg.faults.open_failures {
            return Err(Error::Usb { op: "open", code: -6, detail: "LIBUSB_ERROR_BUSY (simulated)".into() });
        }
        drop(w);
        Ok(Box::new(MockDevice {
            shared: self.shared.clone(),
            info: info.clone(),
            responses: VecDeque::new(),
            alt: Arc::new(AtomicU32::new(0)),
            streaming: Arc::new(AtomicBool::new(false)),
            mode_at: None,
            config: 1,
        }))
    }
}

/// An opened simulated device.
pub struct MockDevice {
    shared: Arc<Shared>,
    info: UsbDeviceInfo,
    responses: VecDeque<Vec<u8>>,
    alt: Arc<AtomicU32>,
    streaming: Arc<AtomicBool>,
    mode_at: Option<Instant>,
    config: u8,
}

impl MockDevice {
    fn check(&self) -> Result<()> {
        if present(&self.shared) { Ok(()) } else { Err(Error::Disconnected) }
    }

    fn answer(&mut self, cmd: &[u8]) -> Result<()> {
        let Some(c) = decode_command(cmd) else {
            return Err(Error::Usb { op: "bulk write", code: -9, detail: "LIBUSB_ERROR_PIPE (simulated: garbage command)".into() });
        };
        let data: Option<Vec<u8>> = match c.id {
            id::READ_FIRMWARE_VERSIONS => Some(encode_firmware((2, 3, 7697, 0))),
            id::READ_HARDWARE_INFO => Some(vec![0; 0x5C]),
            id::READ_STATUS => {
                let ready = self.mode_at.is_some_and(|t| t.elapsed() >= self.shared.cfg.faults.ready_delay);
                Some(u32::from(ready).to_le_bytes().to_vec())
            }
            id::READ_DATA_PAGE => {
                let (_, ir, p0) = content(&self.shared)?;
                match c.params.first().copied().unwrap_or(0) {
                    page::SERIAL => Some(encode_serial(&self.shared.cfg.serial)),
                    page::P0_TABLES => Some(encode_p0_tables(&p0)),
                    page::DEPTH_PARAMS => Some(encode_depth_params(&ir)),
                    page::COLOR_PARAMS => Some(vec![0; crate::protocol::response::COLOR_PARAMS_MIN_LEN + 64]),
                    _ => Some(Vec::new()),
                }
            }
            id::SET_MODE => {
                if c.params.first() == Some(&0) {
                    self.mode_at.get_or_insert_with(Instant::now);
                }
                None
            }
            id::SET_STREAMING => {
                self.streaming.store(c.params.first() == Some(&1), Ordering::SeqCst);
                None
            }
            id::SHUTDOWN => {
                unplug(&self.shared);
                None
            }
            _ => None,
        };
        if let Some(d) = data {
            let mut d = d;
            d.truncate(c.max_response as usize);
            self.responses.push_back(d);
        }
        self.responses.push_back(encode_response_complete(c.sequence));
        Ok(())
    }
}

impl UsbDevice for MockDevice {
    fn info(&self) -> &UsbDeviceInfo {
        &self.info
    }
    fn serial(&mut self) -> Result<String> {
        self.check()?;
        Ok(self.shared.cfg.serial.clone())
    }
    fn reset(&mut self) -> Result<()> {
        self.check()?;
        self.responses.clear();
        self.streaming.store(false, Ordering::SeqCst);
        self.alt.store(0, Ordering::SeqCst);
        Ok(())
    }
    fn configuration(&mut self) -> Result<u8> {
        self.check()?;
        Ok(self.config)
    }
    fn set_configuration(&mut self, config: u8) -> Result<()> {
        self.check()?;
        self.config = config;
        Ok(())
    }
    fn claim(&mut self, _interface: u8) -> Result<()> {
        self.check()
    }
    fn release(&mut self, _interface: u8) -> Result<()> {
        self.check()
    }
    fn set_alt(&mut self, interface: u8, alt: u8) -> Result<()> {
        self.check()?;
        if interface == 1 {
            self.alt.store(u32::from(alt), Ordering::SeqCst);
        }
        Ok(())
    }
    fn clear_halt(&mut self, _endpoint: u8) -> Result<()> {
        self.check()
    }
    fn control_out(&mut self, _rt: u8, _r: u8, _v: u16, _i: u16, data: &[u8], _timeout: Duration) -> Result<usize> {
        self.check()?;
        Ok(data.len())
    }
    fn bulk_out(&mut self, endpoint: u8, data: &[u8], _timeout: Duration) -> Result<usize> {
        self.check()?;
        if endpoint == CONTROL_OUT {
            self.answer(data)?;
        }
        Ok(data.len())
    }
    fn bulk_in(&mut self, endpoint: u8, buf: &mut [u8], timeout: Duration) -> Result<usize> {
        self.check()?;
        if endpoint != CONTROL_IN {
            return Err(Error::Timeout("bulk read"));
        }
        {
            let mut w = lock(&self.shared.world);
            if w.command_timeouts_left > 0 && !self.responses.is_empty() {
                w.command_timeouts_left -= 1;
                // the answer is late: this read times out, the next one gets it
                drop(w);
                std::thread::sleep(timeout.min(Duration::from_millis(5)));
                return Err(Error::Timeout("bulk read"));
            }
        }
        let Some(r) = self.responses.pop_front() else {
            std::thread::sleep(timeout.min(Duration::from_millis(5)));
            return Err(Error::Timeout("bulk read"));
        };
        if r.len() > buf.len() {
            return Err(Error::Usb { op: "bulk read", code: -8, detail: "LIBUSB_ERROR_OVERFLOW (simulated)".into() });
        }
        if let Some(dst) = buf.get_mut(..r.len()) {
            dst.copy_from_slice(&r);
        }
        Ok(r.len())
    }
    fn iso_bytes_per_interval(&mut self, _interface: u8, _alt: u8, _endpoint: u8) -> Result<usize> {
        self.check()?;
        Ok(if self.shared.cfg.faults.usb2 { 1024 } else { self.shared.cfg.iso_packet_size })
    }
    fn start_iso(&mut self, _endpoint: u8, cfg: IsoConfig, sink: Box<dyn PacketSink>) -> Result<Box<dyn Stream>> {
        self.check()?;
        let (frames, _, _) = content(&self.shared)?;
        let stop = Arc::new(AtomicBool::new(false));
        let stats = Arc::new(Mutex::new(StreamStats::default()));
        let alive = Arc::new(AtomicBool::new(true));
        let ctx = Generator {
            shared: self.shared.clone(),
            frames,
            packet: cfg.packet_size.max(1),
            streaming: self.streaming.clone(),
            alt: self.alt.clone(),
            stop: stop.clone(),
            stats: stats.clone(),
            alive: alive.clone(),
        };
        let thread = std::thread::Builder::new().name("mock-kinect".into()).spawn(move || ctx.run(sink)).map_err(|e| Error::Io(e.to_string()))?;
        Ok(Box::new(MockStream { stop, thread: Some(thread), stats, alive }))
    }
    fn start_bulk(&mut self, _endpoint: u8, _cfg: BulkConfig, _sink: Box<dyn PacketSink>) -> Result<Box<dyn Stream>> {
        self.check()?;
        // the simulated device has no color camera: an idle stream
        Ok(Box::new(MockStream {
            stop: Arc::new(AtomicBool::new(true)),
            thread: None,
            stats: Arc::new(Mutex::new(StreamStats::default())),
            alive: Arc::new(AtomicBool::new(true)),
        }))
    }
}

struct Generator {
    shared: Arc<Shared>,
    frames: Arc<Vec<RawDepthPacket>>,
    packet: usize,
    streaming: Arc<AtomicBool>,
    alt: Arc<AtomicU32>,
    stop: Arc<AtomicBool>,
    stats: Arc<Mutex<StreamStats>>,
    alive: Arc<AtomicBool>,
}

impl Generator {
    fn run(self, mut sink: Box<dyn PacketSink>) {
        let f = &self.shared.cfg.faults;
        let period = if self.shared.cfg.fps > 0.0 { Duration::from_secs_f32(1.0 / self.shared.cfg.fps) } else { Duration::ZERO };
        let mut rng = Rng::new(0xF00D);
        let mut seq = 1000u32;
        let mut next = Instant::now();
        let mut stalled = false;
        while !self.stop.load(Ordering::SeqCst) {
            if !present(&self.shared) {
                sink.lost();
                self.alive.store(false, Ordering::SeqCst);
                return;
            }
            let now = Instant::now();
            if now < next {
                std::thread::sleep((next - now).min(Duration::from_millis(5)));
                continue;
            }
            next += period;
            if now > next + Duration::from_millis(500) {
                next = now; // fell behind (slow machine): do not burst
            }
            if stalled || !self.streaming.load(Ordering::SeqCst) || self.alt.load(Ordering::SeqCst) != 1 {
                continue;
            }
            let sent = self.shared.frames_sent.fetch_add(1, Ordering::Relaxed) + 1;
            if f.unplug_after_frames.is_some_and(|n| sent > n) {
                unplug(&self.shared);
                continue;
            }
            if f.stall_after_frames.is_some_and(|n| sent > n) && !self.shared.stalled_once.swap(true, Ordering::SeqCst) {
                stalled = true;
                continue;
            }
            let Some(base) = self.frames.get(seq as usize % self.frames.len().max(1)) else { continue };
            let mut packet = base.clone();
            packet.sequence = seq;
            packet.timestamp = seq.wrapping_mul(333);
            seq = seq.wrapping_add(1);
            let mut bytes = 0u64;
            let mut bad = 0u64;
            for sub in encode_subpackets(&packet, (0, 9)) {
                for chunk in sub.chunks(self.packet) {
                    if rng.uniform() < f.lost_packets {
                        sink.packet(&[], false);
                        bad += 1;
                        continue;
                    }
                    if rng.uniform() < f.corrupt_packets {
                        let mut c = chunk.to_vec();
                        for _ in 0..4 {
                            let i = rng.next_u32() as usize % c.len().max(1);
                            if let Some(b) = c.get_mut(i) {
                                *b ^= 0x5A;
                            }
                        }
                        sink.packet(&c, true);
                    } else {
                        sink.packet(chunk, true);
                    }
                    bytes += chunk.len() as u64;
                }
                // gaps between subpackets
                sink.packet(&[], true);
                sink.packet(&[], true);
            }
            let mut s = lock(&self.stats);
            s.completed += 1;
            s.bytes += bytes;
            s.bad_packets += bad;
            self.shared.total_frames.fetch_add(1, Ordering::Relaxed);
        }
    }
}

struct MockStream {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    stats: Arc<Mutex<StreamStats>>,
    alive: Arc<AtomicBool>,
}

impl Stream for MockStream {
    fn stop(mut self: Box<Self>, _timeout: Duration) -> bool {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        true
    }
    fn stats(&self) -> StreamStats {
        *lock(&self.stats)
    }
    fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}

impl Drop for MockStream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
