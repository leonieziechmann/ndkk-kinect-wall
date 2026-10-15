//! The Kinect v2 protocol on top of a USB device: open, read the calibration, start and stop
//! the streams. The sequence is libfreenect2's, but forgiving: only what streaming really needs
//! is fatal (claiming the interfaces, the calibration, switching the stream on); everything else
//! is tried, logged and skipped. Commands are retried, and after a failed transaction the
//! command pipe is drained so a late answer cannot be mistaken for the next one.

use std::time::{Duration, Instant};

use crate::camera::{ColorCameraParams, DeviceIdentity, IrCameraParams};
use crate::consts::{COLOR_IN, CONTROL_IN, CONTROL_INTERFACE, CONTROL_OUT, DEPTH_IN, DEPTH_INTERFACE, MIN_DEPTH_ISO_PACKET};
use crate::error::{Error, Result};
use crate::protocol::command::{Command, Led, RESPONSE_COMPLETE_LEN, response_complete_sequence};
use crate::protocol::response::{P0Tables, parse_color_params, parse_depth_params, parse_firmware, parse_p0_tables, parse_serial, parse_status};
use crate::usb::{BulkConfig, IsoConfig, PacketSink, SharedSink, Stream, StreamStats, UsbDevice, UsbSpeed, std_request};

/// How the device is driven.
#[derive(Clone, Debug, PartialEq)]
pub struct DeviceOptions {
    /// isochronous transfers for depth (libfreenect2's defaults per platform)
    pub depth_transfers: usize,
    /// packets per isochronous transfer
    pub depth_packets_per_transfer: usize,
    /// bulk transfers for color
    pub color_transfers: usize,
    /// bytes per color transfer
    pub color_transfer_size: usize,
    /// enable the U1/U2 link power states (as libfreenect2 does); off can help flaky hubs
    pub power_states: bool,
    /// how long to wait for the sensor-ready status bit before trying anyway
    pub ready_timeout: Duration,
    /// timeout of one command
    pub command_timeout: Duration,
    /// attempts per command
    pub command_attempts: u32,
    /// USB port reset when opening (costs a re-enumeration; usually not needed)
    pub reset_on_open: bool,
    /// try streaming even if the port is not USB 3 (it will fail, but with a clearer error)
    pub allow_usb2: bool,
}

impl Default for DeviceOptions {
    fn default() -> Self {
        let (transfers, packets, color_transfers, color_size) = if cfg!(windows) {
            (8, 64, 3, 1 << 20)
        } else if cfg!(target_os = "macos") {
            (4, 128, 20, 0x4000)
        } else {
            (60, 8, 20, 0x4000)
        };
        DeviceOptions {
            depth_transfers: transfers,
            depth_packets_per_transfer: packets,
            color_transfers,
            color_transfer_size: color_size,
            power_states: true,
            ready_timeout: Duration::from_secs(5),
            command_timeout: Duration::from_millis(1000),
            command_attempts: 3,
            reset_on_open: false,
            allow_usb2: false,
        }
    }
}

/// What the device told about itself when it started.
#[derive(Clone, Debug)]
pub struct Calibration {
    /// serial, firmware, USB path
    pub identity: DeviceIdentity,
    /// depth camera intrinsics
    pub ir_params: IrCameraParams,
    /// color camera parameters, if the device answered
    pub color_params: Option<ColorCameraParams>,
    /// P0 phase tables
    pub p0: P0Tables,
}

/// An opened Kinect v2.
pub struct KinectDevice {
    usb: Box<dyn UsbDevice>,
    opts: DeviceOptions,
    seq: u32,
    iso_packet: usize,
    streams: Vec<Box<dyn Stream>>,
    claimed: bool,
    /// non-fatal problems while opening and starting (for status and logs)
    pub warnings: Vec<String>,
}

fn short(e: &Error) -> String {
    e.to_string()
}

impl KinectDevice {
    /// Opens the device and brings it into the state libfreenect2's `open()` leaves it in.
    pub fn open(mut usb: Box<dyn UsbDevice>, opts: DeviceOptions) -> Result<KinectDevice> {
        let info = usb.info().clone();
        if info.speed != UsbSpeed::Unknown && info.speed < UsbSpeed::Super && !opts.allow_usb2 {
            return Err(Error::NotSuperSpeed(format!("connected at {} (port {})", info.speed.name(), info.port_path)));
        }
        let mut warnings = Vec::new();
        if opts.reset_on_open
            && let Err(e) = usb.reset()
        {
            warnings.push(format!("reset: {}", short(&e)));
        }
        match usb.configuration() {
            Ok(1) => {}
            _ => usb.set_configuration(1)?,
        }
        usb.claim(CONTROL_INTERFACE)?;
        if let Err(e) = usb.claim(DEPTH_INTERFACE) {
            let _ = usb.release(CONTROL_INTERFACE);
            return Err(e);
        }
        let mut dev = KinectDevice { usb, opts, seq: 0, iso_packet: 0, streams: Vec::new(), claimed: true, warnings };
        let t = dev.opts.command_timeout;
        // USB 3 housekeeping: tolerated if the controller refuses
        if let Err(e) = dev.usb.control_out(std_request::TO_DEVICE, std_request::SET_ISOCH_DELAY, 40, 0, &[], t) {
            dev.warn(format!("set isochronous delay: {}", short(&e)));
        }
        if let Err(e) = dev.usb.set_alt(DEPTH_INTERFACE, 0) {
            dev.warn(format!("depth interface off: {}", short(&e)));
        }
        if dev.opts.power_states {
            for (name, feature) in [("U1", std_request::U1_ENABLE), ("U2", std_request::U2_ENABLE)] {
                if let Err(e) = dev.usb.control_out(std_request::TO_DEVICE, std_request::SET_FEATURE, feature, 0, &[], t) {
                    dev.warn(format!("enable {name}: {}", short(&e)));
                }
            }
        }
        dev.function_suspend(true);
        let packet = dev.usb.iso_bytes_per_interval(DEPTH_INTERFACE, 1, DEPTH_IN)?;
        if packet < MIN_DEPTH_ISO_PACKET {
            return Err(Error::NotSuperSpeed(format!(
                "the depth endpoint offers {packet} bytes per interval, at least {MIN_DEPTH_ISO_PACKET} are needed (not a USB 3 connection?)"
            )));
        }
        dev.iso_packet = packet;
        Ok(dev)
    }

    fn warn(&mut self, m: String) {
        log::warn!("kinect: {m}");
        self.warnings.push(m);
    }

    /// Suspends (true) or resumes (false) the video function (USB 3 FUNCTION_SUSPEND).
    fn function_suspend(&mut self, suspend: bool) {
        let options: u16 = if suspend { 3 } else { 0 };
        let r = self.usb.control_out(std_request::TO_INTERFACE, std_request::SET_FEATURE, std_request::FUNCTION_SUSPEND, options << 8, &[], self.opts.command_timeout);
        if let Err(e) = r {
            self.warn(format!("function suspend {suspend}: {}", short(&e)));
        }
    }

    /// The bytes per isochronous packet of the depth endpoint.
    pub fn iso_packet_size(&self) -> usize {
        self.iso_packet
    }

    /// Runs one command transaction (with retries); returns its data.
    pub fn command(&mut self, cmd: &Command) -> Result<Vec<u8>> {
        let mut last = Error::Timeout("command");
        for attempt in 0..self.opts.command_attempts.max(1) {
            match self.try_command(cmd) {
                Ok(d) => return Ok(d),
                Err(e) if e.is_fatal_for_device() => return Err(e),
                Err(e) => {
                    log::debug!("kinect: {} failed (attempt {}): {e}", cmd.name, attempt + 1);
                    last = e;
                    self.drain();
                }
            }
        }
        Err(last)
    }

    fn try_command(&mut self, cmd: &Command) -> Result<Vec<u8>> {
        let seq = self.seq;
        self.seq = self.seq.wrapping_add(1);
        let expect = cmd.sequence_for(seq);
        let t = self.opts.command_timeout;
        let bytes = cmd.encode(seq);
        let n = self.usb.bulk_out(CONTROL_OUT, &bytes, t)?;
        if n != bytes.len() {
            return Err(Error::protocol(format!("{}: sent {n} of {} bytes", cmd.name, bytes.len())));
        }
        let mut data = Vec::new();
        if cmd.max_response > 0 {
            let mut buf = vec![0u8; cmd.max_response as usize];
            let big = Duration::from_millis(3000).max(t);
            let n = self.usb.bulk_in(CONTROL_IN, &mut buf, if cmd.max_response > 0x1000 { big } else { t })?;
            buf.truncate(n);
            match response_complete_sequence(&buf) {
                // no data: the command is done (the device has nothing for it)
                Some(s) if s == expect => {
                    if cmd.min_response > 0 {
                        return Err(Error::protocol(format!("{}: no data", cmd.name)));
                    }
                    return Ok(Vec::new());
                }
                Some(s) => return Err(Error::protocol(format!("{}: answer to command {s}, expected {expect}", cmd.name))),
                None => data = buf,
            }
        }
        // the response complete; an older one left in the pipe is skipped
        for _ in 0..4 {
            let mut rc = [0u8; 512];
            let n = self.usb.bulk_in(CONTROL_IN, &mut rc, t)?;
            match rc.get(..n).and_then(response_complete_sequence) {
                Some(s) if s == expect => {
                    if (data.len() as u32) < cmd.min_response {
                        return Err(Error::invalid(format!("{}: {} bytes, expected at least {}", cmd.name, data.len(), cmd.min_response)));
                    }
                    return Ok(data);
                }
                Some(s) if s.wrapping_sub(expect) > u32::MAX / 2 => continue, // stale
                Some(s) => return Err(Error::protocol(format!("{}: completion {s}, expected {expect}", cmd.name))),
                None if n != RESPONSE_COMPLETE_LEN => return Err(Error::protocol(format!("{}: unexpected {n} bytes instead of the completion", cmd.name))),
                None => return Err(Error::protocol(format!("{}: bad completion", cmd.name))),
            }
        }
        Err(Error::protocol(format!("{}: no completion", cmd.name)))
    }

    /// Reads and discards whatever is waiting in the command pipe (late answers).
    fn drain(&mut self) {
        let _ = self.usb.clear_halt(CONTROL_IN);
        let mut buf = vec![0u8; 0x1000];
        for _ in 0..8 {
            match self.usb.bulk_in(CONTROL_IN, &mut buf, Duration::from_millis(30)) {
                Ok(_) => continue,
                Err(_) => break,
            }
        }
    }

    /// Reads identity and calibration (libfreenect2's start sequence, first half).
    pub fn read_calibration(&mut self) -> Result<Calibration> {
        let usb_info = self.usb.info().clone();
        let firmware = match self.command(&Command::read_firmware_versions()) {
            Ok(d) => parse_firmware(&d),
            Err(e) => {
                self.warn(format!("firmware version: {}", short(&e)));
                String::new()
            }
        };
        if let Err(e) = self.command(&Command::read_hardware_info()) {
            self.warn(format!("hardware info: {}", short(&e)));
        }
        let serial = match self.command(&Command::read_serial()) {
            Ok(d) if !parse_serial(&d).is_empty() => parse_serial(&d),
            _ => self.usb.serial().unwrap_or_default(),
        };
        let ir_params = parse_depth_params(&self.command(&Command::read_depth_params())?)?;
        let p0 = parse_p0_tables(&self.command(&Command::read_p0_tables())?)?;
        let color_params = match self.command(&Command::read_color_params()) {
            Ok(d) => parse_color_params(&d).ok(),
            Err(e) => {
                self.warn(format!("color parameters: {}", short(&e)));
                None
            }
        };
        Ok(Calibration {
            identity: DeviceIdentity { serial, firmware, product_id: usb_info.product_id, usb_path: usb_info.port_path },
            ir_params,
            color_params,
            p0,
        })
    }

    /// Switches the sensor on and starts the streams (libfreenect2's start sequence, second
    /// half). Call [`KinectDevice::read_calibration`] first.
    pub fn start(&mut self, depth: Box<dyn PacketSink>, color: Option<Box<dyn PacketSink>>) -> Result<()> {
        self.function_suspend(false);
        for c in [Command::set_mode_enabled_0064(), Command::set_mode_disabled()] {
            if let Err(e) = self.command(&c) {
                self.warn(format!("{}: {}", c.name, short(&e)));
            }
        }
        // wait for the sensor (after a firmware reboot it reports not-ready for ~3 s)
        let deadline = Instant::now() + self.opts.ready_timeout;
        loop {
            match self.command(&Command::read_status_090000()).and_then(|d| parse_status(&d)) {
                Ok(s) if s & 1 == 1 => break,
                Ok(_) => {}
                Err(e) if e.is_fatal_for_device() => return Err(e),
                Err(_) => {}
            }
            if Instant::now() >= deadline {
                self.warn("the sensor did not report ready; starting anyway".to_string());
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if let Err(e) = self.command(&Command::init_streams()) {
            self.warn(format!("init streams: {}", short(&e)));
        }
        self.usb.set_alt(DEPTH_INTERFACE, 1)?;
        let _ = self.command(&Command::read_status_090000());
        self.command(&Command::set_streaming(true))?;
        let depth_stream = self.start_depth(depth)?;
        self.streams.push(depth_stream);
        if let Some(sink) = color {
            let cfg = BulkConfig { transfers: self.opts.color_transfers.max(1), transfer_size: self.opts.color_transfer_size.max(0x4000) };
            match self.usb.start_bulk(COLOR_IN, cfg, sink) {
                Ok(s) => self.streams.push(s),
                Err(e) => self.warn(format!("color stream: {}", short(&e))),
            }
        }
        Ok(())
    }

    /// Starts the isochronous depth stream, with fewer or smaller transfers if the controller
    /// cannot take the configured ones (bandwidth, memory).
    fn start_depth(&mut self, sink: Box<dyn PacketSink>) -> Result<Box<dyn Stream>> {
        let shared = SharedSink::new(sink);
        let mut transfers = self.opts.depth_transfers.max(1);
        let mut packets = self.opts.depth_packets_per_transfer.max(1);
        let mut last = Error::Unsupported("no isochronous configuration worked".into());
        for attempt in 0..8 {
            let cfg = IsoConfig { transfers, packets_per_transfer: packets, packet_size: self.iso_packet };
            match self.usb.start_iso(DEPTH_IN, cfg, Box::new(shared.clone())) {
                Ok(s) => {
                    if attempt > 0 {
                        self.warn(format!("depth stream runs with {transfers} transfers of {packets} packets"));
                    }
                    return Ok(s);
                }
                Err(e) if e.is_fatal_for_device() => return Err(e),
                Err(e) => {
                    self.warn(format!("depth stream with {transfers} x {packets} packets: {}", short(&e)));
                    last = e;
                }
            }
            if transfers > 2 {
                transfers = transfers.div_ceil(2);
            } else if packets > 8 {
                packets = packets.div_ceil(2);
            } else {
                break;
            }
        }
        Err(last)
    }

    /// True while every started stream still has transfers going.
    pub fn streams_alive(&self) -> bool {
        self.streams.iter().all(|s| s.alive())
    }

    /// Counters of the streams (depth first).
    pub fn stream_stats(&self) -> Vec<StreamStats> {
        self.streams.iter().map(|s| s.stats()).collect()
    }

    /// Stops the streams and switches the sensor off (best effort, never fails). Returns false
    /// if a stream did not let go of its transfers in time (they were leaked on purpose).
    pub fn stop(&mut self) -> bool {
        let mut clean = true;
        for s in self.streams.drain(..) {
            clean &= s.stop(Duration::from_secs(2));
        }
        let _ = self.usb.set_alt(DEPTH_INTERFACE, 0);
        for c in [
            Command::set_mode_enabled_0064(),
            Command::set_mode_disabled(),
            Command::stop(),
            Command::set_streaming(false),
            Command::set_mode_enabled(),
            Command::set_mode_disabled(),
            Command::set_mode_enabled(),
            Command::set_mode_disabled(),
        ] {
            if let Err(e) = self.try_command(&c) {
                if e.is_fatal_for_device() {
                    break;
                }
                self.drain();
            }
        }
        self.function_suspend(true);
        clean
    }

    /// Sets an LED: `level` 0..=1000 (0 = off), optionally blinking.
    pub fn set_led(&mut self, led: Led, level: u16, blink: Option<(u16, u32)>) -> Result<()> {
        self.command(&Command::led(led, level, blink)).map(|_| ())
    }

    /// Reboots the firmware: the device disappears from the bus for a few seconds and comes back
    /// fresh (the last resort when it does not stream).
    pub fn reboot(mut self) {
        let _ = self.try_command(&Command::shutdown());
        self.release();
    }

    fn release(&mut self) {
        if self.claimed {
            let _ = self.usb.release(DEPTH_INTERFACE);
            let _ = self.usb.release(CONTROL_INTERFACE);
            self.claimed = false;
        }
    }

    /// Stops everything and releases the device.
    pub fn close(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        if !self.streams.is_empty() {
            self.stop();
        }
        if self.claimed {
            for c in [Command::set_mode_enabled_0064(), Command::set_mode_disabled()] {
                if self.try_command(&c).is_err() {
                    break;
                }
            }
        }
        self.release();
    }
}

impl Drop for KinectDevice {
    fn drop(&mut self) {
        self.shutdown();
    }
}
