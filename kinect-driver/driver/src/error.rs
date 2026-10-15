//! The one error type of the crate. Nothing in the driver panics on purpose: every failure (USB,
//! device, data, GPU, a bug caught at a thread boundary) comes back as an [`Error`].

use std::fmt;

/// Result with the crate's [`Error`].
pub type Result<T> = std::result::Result<T, Error>;

/// Everything that can go wrong.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// No Kinect v2 was found on the USB bus.
    NoDevice,
    /// A USB operation failed; `code` is the libusb error code (negative) or 0.
    Usb {
        /// what was attempted
        op: &'static str,
        /// libusb error code
        code: i32,
        /// libusb's name for it, or a description
        detail: String,
    },
    /// The device went away (unplugged, firmware reset, driver unloaded).
    Disconnected,
    /// The device did not answer in time.
    Timeout(&'static str),
    /// The device answered something unexpected.
    Protocol(String),
    /// The Kinect is not connected over USB 3 (SuperSpeed); it cannot stream there.
    NotSuperSpeed(String),
    /// Corrupt or incomplete data (packets, recordings, tables).
    InvalidData(String),
    /// A configuration value is out of range or contradicts another one.
    Config(String),
    /// File or pipe I/O.
    Io(String),
    /// GPU setup or execution failed (the CPU path still works).
    Gpu(String),
    /// Not available in this build or on this system.
    Unsupported(String),
    /// The driver or a stream was stopped.
    Stopped,
    /// A bug was caught at a thread or stage boundary (the message of the panic).
    Panic(String),
}

impl Error {
    /// True for errors after which the device has to be opened again (it is gone or wedged).
    pub fn is_fatal_for_device(&self) -> bool {
        matches!(self, Error::Disconnected | Error::NoDevice | Error::NotSuperSpeed(_))
    }

    pub(crate) fn invalid(msg: impl Into<String>) -> Error {
        Error::InvalidData(msg.into())
    }

    pub(crate) fn config(msg: impl Into<String>) -> Error {
        Error::Config(msg.into())
    }

    pub(crate) fn protocol(msg: impl Into<String>) -> Error {
        Error::Protocol(msg.into())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NoDevice => write!(f, "no Kinect v2 found"),
            Error::Usb { op, code, detail } => write!(f, "USB {op} failed: {detail} ({code})"),
            Error::Disconnected => write!(f, "the Kinect is no longer connected"),
            Error::Timeout(what) => write!(f, "timeout: {what}"),
            Error::Protocol(m) => write!(f, "protocol error: {m}"),
            Error::NotSuperSpeed(m) => write!(f, "the Kinect needs a USB 3 port: {m}"),
            Error::InvalidData(m) => write!(f, "invalid data: {m}"),
            Error::Config(m) => write!(f, "configuration: {m}"),
            Error::Io(m) => write!(f, "I/O: {m}"),
            Error::Gpu(m) => write!(f, "GPU: {m}"),
            Error::Unsupported(m) => write!(f, "not supported: {m}"),
            Error::Stopped => write!(f, "stopped"),
            Error::Panic(m) => write!(f, "internal error (caught): {m}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Error {
        Error::Io(e.to_string())
    }
}

/// The message of a caught panic payload.
pub fn panic_message(p: &(dyn std::any::Any + Send)) -> String {
    p.downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| p.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".to_string())
}

/// Runs `f`, turning a panic into [`Error::Panic`]. Used at every boundary where user code or a
/// whole processing stage runs, so a bug there can never take the program down.
pub fn catch<T>(f: impl FnOnce() -> Result<T>) -> Result<T> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(p) => Err(Error::Panic(panic_message(p.as_ref()))),
    }
}
