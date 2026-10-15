//! Fault injection on the real Kinect: the driver streams through a wrapped libusb backend, and a
//! second thread hits the open device the way a bad cable, a weak controller or a firmware hiccup
//! would. Prints, per fault, how long until frames came back.
//!
//!   cargo run --release -p kinect-driver --example usb_faults -- [--faults reset,reboot,stall,alt0]
//!       [--rounds N] [--every S] [--mode compat|extended]
//!
//! - `reset`  USB port reset (libusb_reset_device) under the running stream
//! - `reboot` firmware shutdown command: the Kinect leaves the bus for a few seconds
//! - `stall`  "stop" command: the sensor stays on the bus but sends nothing
//! - `alt0`   depth interface to alternate setting 0: the isochronous endpoint goes away

use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, Instant};

use kinect_driver::consts::{CONTROL_OUT, DEPTH_INTERFACE};
use kinect_driver::driver::{Driver, DriverConfig, Event, Source};
use kinect_driver::protocol::command::Command;
use kinect_driver::usb::libusb::LibusbBackend;
use kinect_driver::usb::{BulkConfig, IsoConfig, PacketSink, Stream, UsbBackend, UsbDevice, UsbDeviceInfo};
use kinect_driver::{Result, TofConfig};

type Shared = Arc<Mutex<Box<dyn UsbDevice>>>;
type Current = Arc<Mutex<Weak<Mutex<Box<dyn UsbDevice>>>>>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// libusb, remembering the device the driver opened last (weakly: it closes as usual).
struct Faulty {
    inner: LibusbBackend,
    current: Current,
}

impl UsbBackend for Faulty {
    fn name(&self) -> String {
        format!("{} (fault injection)", self.inner.name())
    }
    fn list(&self) -> Result<Vec<UsbDeviceInfo>> {
        self.inner.list()
    }
    fn open(&self, info: &UsbDeviceInfo) -> Result<Box<dyn UsbDevice>> {
        let dev = self.inner.open(info)?;
        let info = dev.info().clone();
        let shared: Shared = Arc::new(Mutex::new(dev));
        *lock(&self.current) = Arc::downgrade(&shared);
        Ok(Box::new(Wrapped { dev: shared, info }))
    }
}

struct Wrapped {
    dev: Shared,
    info: UsbDeviceInfo,
}

impl UsbDevice for Wrapped {
    fn info(&self) -> &UsbDeviceInfo {
        &self.info
    }
    fn serial(&mut self) -> Result<String> {
        lock(&self.dev).serial()
    }
    fn reset(&mut self) -> Result<()> {
        lock(&self.dev).reset()
    }
    fn configuration(&mut self) -> Result<u8> {
        lock(&self.dev).configuration()
    }
    fn set_configuration(&mut self, config: u8) -> Result<()> {
        lock(&self.dev).set_configuration(config)
    }
    fn claim(&mut self, interface: u8) -> Result<()> {
        lock(&self.dev).claim(interface)
    }
    fn release(&mut self, interface: u8) -> Result<()> {
        lock(&self.dev).release(interface)
    }
    fn set_alt(&mut self, interface: u8, alt: u8) -> Result<()> {
        lock(&self.dev).set_alt(interface, alt)
    }
    fn clear_halt(&mut self, endpoint: u8) -> Result<()> {
        lock(&self.dev).clear_halt(endpoint)
    }
    fn control_out(&mut self, request_type: u8, request: u8, value: u16, index: u16, data: &[u8], timeout: Duration) -> Result<usize> {
        lock(&self.dev).control_out(request_type, request, value, index, data, timeout)
    }
    fn bulk_out(&mut self, endpoint: u8, data: &[u8], timeout: Duration) -> Result<usize> {
        lock(&self.dev).bulk_out(endpoint, data, timeout)
    }
    fn bulk_in(&mut self, endpoint: u8, buf: &mut [u8], timeout: Duration) -> Result<usize> {
        lock(&self.dev).bulk_in(endpoint, buf, timeout)
    }
    fn iso_bytes_per_interval(&mut self, interface: u8, alt: u8, endpoint: u8) -> Result<usize> {
        lock(&self.dev).iso_bytes_per_interval(interface, alt, endpoint)
    }
    fn start_iso(&mut self, endpoint: u8, cfg: IsoConfig, sink: Box<dyn PacketSink>) -> Result<Box<dyn Stream>> {
        lock(&self.dev).start_iso(endpoint, cfg, sink)
    }
    fn start_bulk(&mut self, endpoint: u8, cfg: BulkConfig, sink: Box<dyn PacketSink>) -> Result<Box<dyn Stream>> {
        lock(&self.dev).start_bulk(endpoint, cfg, sink)
    }
}

fn fire(fault: &str, dev: &Shared) -> String {
    let mut d = lock(dev);
    let r = match fault {
        "reset" => d.reset().map(|_| ()),
        "reboot" => d.bulk_out(CONTROL_OUT, &Command::shutdown().encode(0x4000), Duration::from_millis(500)).map(|_| ()),
        "stall" => d.bulk_out(CONTROL_OUT, &Command::stop().encode(0x4001), Duration::from_millis(500)).map(|_| ()),
        "alt0" => d.set_alt(DEPTH_INTERFACE, 0),
        other => return format!("unknown fault {other}"),
    };
    match r {
        Ok(()) => "ok".into(),
        Err(e) => format!("error: {e}"),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let faults: Vec<String> = arg("--faults").unwrap_or_else(|| "reset,reboot,stall,alt0".into()).split(',').map(str::to_string).collect();
    let rounds: usize = arg("--rounds").and_then(|v| v.parse().ok()).unwrap_or(faults.len() * 3);
    let every: f64 = arg("--every").and_then(|v| v.parse().ok()).unwrap_or(8.0);
    let tof = match arg("--mode").as_deref() {
        Some("compat") => TofConfig::compat(),
        _ => TofConfig::extended(),
    };

    let inner = match LibusbBackend::new() {
        Ok(b) => b,
        Err(e) => {
            eprintln!("libusb: {e}");
            std::process::exit(1);
        }
    };
    let current: Current = Arc::new(Mutex::new(Weak::new()));
    let backend = Arc::new(Faulty { inner, current: current.clone() });
    let cfg = DriverConfig { source: Source::Backend { backend, serial: None }, tof, led: Some(0), ..Default::default() };
    let driver = match Driver::start(cfg) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("driver: {e}");
            std::process::exit(1);
        }
    };

    let t0 = Instant::now();
    let at = |t: Instant| t.duration_since(t0).as_secs_f64();
    let mut last_frame: Option<Instant> = None;
    let mut frames_since = 0u64;
    // the fault, and whether the driver has noticed an outage since (frames already on their way
    // when the fault hit do not count as "back")
    let mut fault_at: Option<(Instant, String, bool)> = None;
    let mut next_fault = t0 + Duration::from_secs_f64(every.max(2.0) + 4.0);
    let mut round = 0usize;
    // name, outcome: Some(seconds until frames were back) / None = no recovery; no_effect
    let mut results: Vec<(String, Option<f64>, bool)> = Vec::new();
    let give_up = Duration::from_secs(60);
    let no_effect_after = Duration::from_secs(6);
    let gap_is_outage = Duration::from_millis(300);
    loop {
        match driver.recv_timeout(Duration::from_millis(10)) {
            Some(Event::Frame(_)) => {
                let now = Instant::now();
                let gap = last_frame.map(|l| now.duration_since(l)).unwrap_or_default();
                if let Some((t, name, outage)) = &fault_at
                    && (*outage || gap > gap_is_outage)
                {
                    let rec = now.duration_since(*t).as_secs_f64();
                    println!("{:>7.2} s  frames back after {name}: {rec:.2} s after the fault (last gap {:.2} s)", at(now), gap.as_secs_f64());
                    results.push((name.clone(), Some(rec), false));
                    fault_at = None;
                    next_fault = now + Duration::from_secs_f64(every);
                    frames_since = 0;
                }
                last_frame = Some(now);
                frames_since += 1;
            }
            Some(Event::State { state, detail }) => {
                println!("{:>7.2} s  state {} {detail}", at(Instant::now()), state.name());
                if let Some((_, _, outage)) = &mut fault_at
                    && state.name() != "streaming"
                {
                    *outage = true;
                }
            }
            Some(Event::Warning(w)) => println!("{:>7.2} s  warning: {w}", at(Instant::now())),
            Some(Event::Device { identity, .. }) => println!("{:>7.2} s  device {} (firmware {})", at(Instant::now()), identity.serial, identity.firmware),
            _ => {}
        }
        let now = Instant::now();
        if let Some((t, name, outage)) = &fault_at {
            let since = now.duration_since(*t);
            let flowing = last_frame.is_some_and(|l| now.duration_since(l) < gap_is_outage);
            if !*outage && since > no_effect_after && flowing {
                println!("{:>7.2} s  {name}: no interruption", at(now));
                results.push((name.clone(), None, true));
                fault_at = None;
                next_fault = now + Duration::from_secs_f64(every);
            } else if since > give_up {
                println!("{:>7.2} s  NO RECOVERY after {name} within {} s", at(now), give_up.as_secs());
                results.push((name.clone(), None, false));
                fault_at = None;
                next_fault = now + Duration::from_secs_f64(every);
            }
        }
        if fault_at.is_none() && now >= next_fault && frames_since > 30 {
            if round >= rounds {
                break;
            }
            let Some(name) = faults.get(round % faults.len().max(1)).cloned() else { break };
            round += 1;
            let dev = lock(&current).upgrade();
            let s = driver.status();
            println!(
                "{:>7.2} s  --- fault {round}/{rounds}: {name}  ({:.1} fps, usb bad {}, patched {}, partial {}, lost {}, restarts {})",
                at(now),
                s.fps,
                s.stream.unwrap_or_default().bad_packets,
                s.parser.filled_packets,
                s.parser.partial_frames,
                s.parser.dropped_frames + s.parser.missing_frames,
                s.restarts
            );
            match dev {
                Some(dev) => {
                    let n = name.clone();
                    // fired from its own thread: a hanging USB call must not stop the clock here
                    let _ = std::thread::Builder::new().name("fault".into()).spawn(move || {
                        let r = fire(&n, &dev);
                        println!("           fault {n}: {r}");
                    });
                    fault_at = Some((now, name, false));
                }
                None => println!("           no open device"),
            }
        }
    }
    let s = driver.status();
    println!("\nsummary ({:.0} s, {} frames, restarts {}, panics {}, decoder {})", at(Instant::now()), s.frames, s.restarts, s.panics, s.decoder);
    println!("parser: {:?}", s.parser);
    for name in &faults {
        let of: Vec<_> = results.iter().filter(|r| &r.0 == name).collect();
        if of.is_empty() {
            continue;
        }
        let rec: Vec<f64> = of.iter().filter_map(|r| r.1).collect();
        let no_effect = of.iter().filter(|r| r.2).count();
        let failed = of.len() - rec.len() - no_effect;
        let max = rec.iter().copied().fold(0.0f64, f64::max);
        let min = rec.iter().copied().fold(f64::INFINITY, f64::min);
        let mean = rec.iter().sum::<f64>() / rec.len().max(1) as f64;
        println!("{name:>7}: {} recovered (min {min:.2} / mean {mean:.2} / max {max:.2} s), {no_effect} without interruption, {failed} NOT recovered", rec.len());
    }
    driver.stop();
}
