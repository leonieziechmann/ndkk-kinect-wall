//! USB access, behind a small interface so the device logic is the same for the real bus
//! (libusb, feature `usb`) and for the simulated Kinect used in tests and without hardware
//! ([`mock`]).
//!
//! Streams deliver data to a [`PacketSink`] on the USB event thread: one call per isochronous
//! packet (with its own status, at its own offset in the transfer) or per bulk transfer.

#[cfg(feature = "usb-system")]
pub mod libusb;
pub mod mock;

use std::time::Duration;

use crate::error::Result;

/// Bus speed of a device.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum UsbSpeed {
    /// not reported
    Unknown,
    /// 1.5 Mbit/s
    Low,
    /// 12 Mbit/s
    Full,
    /// 480 Mbit/s (USB 2): the Kinect v2 cannot stream here
    High,
    /// 5 Gbit/s (USB 3)
    Super,
    /// 10 Gbit/s and more
    SuperPlus,
}

impl UsbSpeed {
    /// For messages.
    pub fn name(self) -> &'static str {
        match self {
            UsbSpeed::Unknown => "unknown speed",
            UsbSpeed::Low => "USB 1 low speed",
            UsbSpeed::Full => "USB 1 full speed",
            UsbSpeed::High => "USB 2",
            UsbSpeed::Super => "USB 3 (5 Gbit/s)",
            UsbSpeed::SuperPlus => "USB 3 (10+ Gbit/s)",
        }
    }
}

/// A Kinect v2 found on the bus (not opened).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsbDeviceInfo {
    /// bus number
    pub bus: u8,
    /// address on the bus (changes when the device re-enumerates)
    pub address: u8,
    /// physical port path, e.g. "2-1.4" (stable while the cable stays in the same port)
    pub port_path: String,
    /// USB product id
    pub product_id: u16,
    /// negotiated speed
    pub speed: UsbSpeed,
}

/// Isochronous stream layout.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IsoConfig {
    /// transfers kept in flight
    pub transfers: usize,
    /// packets per transfer
    pub packets_per_transfer: usize,
    /// bytes per packet (the endpoint's bytes per service interval)
    pub packet_size: usize,
}

/// Bulk stream layout.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BulkConfig {
    /// transfers kept in flight
    pub transfers: usize,
    /// bytes per transfer
    pub transfer_size: usize,
}

/// Receives stream data on the USB event thread. Must return quickly and never block.
pub trait PacketSink: Send {
    /// One isochronous packet (or one completed bulk transfer); `ok == false` if the USB stack
    /// reported an error for it (its data is not to be trusted).
    fn packet(&mut self, data: &[u8], ok: bool);
    /// The device disappeared.
    fn lost(&mut self) {}
}

/// A sink shared between attempts (a failed start does not lose it).
#[derive(Clone)]
pub struct SharedSink(pub std::sync::Arc<std::sync::Mutex<Box<dyn PacketSink>>>);

impl SharedSink {
    /// Wraps a sink.
    pub fn new(sink: Box<dyn PacketSink>) -> SharedSink {
        SharedSink(std::sync::Arc::new(std::sync::Mutex::new(sink)))
    }
}

impl PacketSink for SharedSink {
    fn packet(&mut self, data: &[u8], ok: bool) {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).packet(data, ok);
    }
    fn lost(&mut self) {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).lost();
    }
}

/// Counters of a running stream.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StreamStats {
    /// transfers that completed
    pub completed: u64,
    /// transfers that completed with an error status
    pub failed: u64,
    /// isochronous packets with an error status
    pub bad_packets: u64,
    /// resubmissions the USB stack refused (the transfer is gone)
    pub resubmit_errors: u64,
    /// bytes delivered
    pub bytes: u64,
    /// transfers currently in flight
    pub in_flight: u64,
}

/// A running stream; stops when told or dropped.
pub trait Stream: Send {
    /// Cancels all transfers and waits (at most `timeout`) until the USB stack let go of them.
    /// Returns false if it did not in time (the transfers are then deliberately leaked, never
    /// freed while the stack might still write into them).
    fn stop(self: Box<Self>, timeout: Duration) -> bool;
    /// Counters.
    fn stats(&self) -> StreamStats;
    /// False once every transfer died (resubmission refused, device gone).
    fn alive(&self) -> bool;
}

/// An opened device.
pub trait UsbDevice: Send {
    /// What was found on the bus.
    fn info(&self) -> &UsbDeviceInfo;
    /// The serial number string descriptor.
    fn serial(&mut self) -> Result<String>;
    /// USB port reset (the device may re-enumerate; the handle may become invalid).
    fn reset(&mut self) -> Result<()>;
    /// Active configuration.
    fn configuration(&mut self) -> Result<u8>;
    /// Selects a configuration.
    fn set_configuration(&mut self, config: u8) -> Result<()>;
    /// Claims an interface (detaching a kernel driver where the OS allows).
    fn claim(&mut self, interface: u8) -> Result<()>;
    /// Releases an interface.
    fn release(&mut self, interface: u8) -> Result<()>;
    /// Selects an alternate setting.
    fn set_alt(&mut self, interface: u8, alt: u8) -> Result<()>;
    /// Clears a halt/stall of an endpoint.
    fn clear_halt(&mut self, endpoint: u8) -> Result<()>;
    /// A control transfer without data stage or with data going out.
    fn control_out(&mut self, request_type: u8, request: u8, value: u16, index: u16, data: &[u8], timeout: Duration) -> Result<usize>;
    /// A blocking bulk write.
    fn bulk_out(&mut self, endpoint: u8, data: &[u8], timeout: Duration) -> Result<usize>;
    /// A blocking bulk read.
    fn bulk_in(&mut self, endpoint: u8, buf: &mut [u8], timeout: Duration) -> Result<usize>;
    /// Bytes per service interval of an isochronous endpoint in an alternate setting (from the
    /// SuperSpeed endpoint companion descriptor).
    fn iso_bytes_per_interval(&mut self, interface: u8, alt: u8, endpoint: u8) -> Result<usize>;
    /// Starts an isochronous IN stream.
    fn start_iso(&mut self, endpoint: u8, cfg: IsoConfig, sink: Box<dyn PacketSink>) -> Result<Box<dyn Stream>>;
    /// Starts a bulk IN stream.
    fn start_bulk(&mut self, endpoint: u8, cfg: BulkConfig, sink: Box<dyn PacketSink>) -> Result<Box<dyn Stream>>;
}

/// Finds and opens devices.
pub trait UsbBackend: Send + Sync {
    /// For logs ("libusb 1.0.27", "simulated").
    fn name(&self) -> String;
    /// All Kinect v2 devices on the bus.
    fn list(&self) -> Result<Vec<UsbDeviceInfo>>;
    /// Opens one of them.
    fn open(&self, info: &UsbDeviceInfo) -> Result<Box<dyn UsbDevice>>;
}

/// Request types and requests of the standard requests the Kinect needs.
pub mod std_request {
    /// host to device, standard, device
    pub const TO_DEVICE: u8 = 0x00;
    /// host to device, standard, interface
    pub const TO_INTERFACE: u8 = 0x01;
    /// SET_FEATURE
    pub const SET_FEATURE: u8 = 0x03;
    /// SET_SEL (USB 3)
    pub const SET_SEL: u8 = 0x30;
    /// SET_ISOCH_DELAY (USB 3)
    pub const SET_ISOCH_DELAY: u8 = 0x31;
    /// device feature U1_ENABLE
    pub const U1_ENABLE: u16 = 48;
    /// device feature U2_ENABLE
    pub const U2_ENABLE: u16 = 49;
    /// interface feature FUNCTION_SUSPEND
    pub const FUNCTION_SUSPEND: u16 = 0;
}
