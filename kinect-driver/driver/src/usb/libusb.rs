//! The real bus, through libusb 1.0 (built from source with the feature `usb`, the system's with
//! `usb-system`). Windows needs the libusbK driver on the Kinect (Zadig) or UsbDk
//! (`KINECT_DRIVER_USBDK=1`); Linux needs read/write access to the device (udev rule); macOS
//! works as is.
//!
//! One event thread per backend completes the transfers. Every callback runs inside
//! `catch_unwind` (a panic must never unwind into C), every isochronous packet is read at its own
//! offset in the transfer whether or not the packets before it failed, and a stream that does
//! not get its transfers back in time leaks them deliberately (with the device handle) rather
//! than freeing memory the USB stack might still write into.

#![allow(unsafe_code)]

use std::ffi::{CStr, c_int, c_uint};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use libusb1_sys as ffi;
use libusb1_sys::constants::*;

use super::{BulkConfig, IsoConfig, PacketSink, Stream, StreamStats, UsbBackend, UsbDevice, UsbDeviceInfo, UsbSpeed};
use crate::consts::{PRODUCT_ID, PRODUCT_ID_PREVIEW, VENDOR_ID};
use crate::error::{Error, Result};

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// libusb's name of an error code.
fn error_name(code: c_int) -> String {
    // SAFETY: libusb_error_name returns a pointer to a static, NUL-terminated string for any code.
    let p = unsafe { ffi::libusb_error_name(code) };
    if p.is_null() {
        return format!("error {code}");
    }
    // SAFETY: non-null and NUL-terminated (static storage inside libusb).
    unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
}

/// Turns a libusb return code into a result, with hints where the fix is on the user's side.
fn check(op: &'static str, code: c_int) -> Result<c_int> {
    if code >= 0 {
        return Ok(code);
    }
    Err(match code {
        LIBUSB_ERROR_NO_DEVICE => Error::Disconnected,
        LIBUSB_ERROR_TIMEOUT => Error::Timeout(op),
        LIBUSB_ERROR_ACCESS => Error::Usb {
            op,
            code,
            detail: if cfg!(target_os = "linux") {
                "access denied - install the udev rule from kinect-driver/README.md (or run as root)".into()
            } else {
                "access denied - another program uses the Kinect".into()
            },
        },
        LIBUSB_ERROR_NOT_SUPPORTED if cfg!(windows) => Error::Usb {
            op,
            code,
            detail: "the Kinect has no usable driver - install libusbK with Zadig, or UsbDk and set KINECT_DRIVER_USBDK=1".into(),
        },
        LIBUSB_ERROR_BUSY => Error::Usb { op, code, detail: "busy - another program has the Kinect open".into() },
        _ => Error::Usb { op, code, detail: error_name(code) },
    })
}

fn millis(t: Duration) -> c_uint {
    t.as_millis().clamp(1, u128::from(c_uint::MAX)) as c_uint
}

// ---- the context and its event thread ------------------------------------------------------

/// A libusb context with its event thread. Shared (Arc) by the backend, every opened device and
/// every stream, so it lives until the last of them is gone.
struct Ctx {
    ptr: *mut ffi::libusb_context,
    stop: Arc<AtomicBool>,
    events: Mutex<Option<JoinHandle<()>>>,
}

// SAFETY: a libusb context is thread-safe (libusb's documented guarantee); the pointer itself is
// only handed to libusb.
unsafe impl Send for Ctx {}
// SAFETY: see above.
unsafe impl Sync for Ctx {}

/// The context pointer, movable into the event thread.
struct CtxPtr(*mut ffi::libusb_context);
// SAFETY: see `Ctx`.
unsafe impl Send for CtxPtr {}

impl Ctx {
    fn new() -> Result<Arc<Ctx>> {
        let mut ptr = ptr::null_mut();
        // SAFETY: ptr is a valid out pointer.
        check("init", unsafe { ffi::libusb_init(&mut ptr) })?;
        if ptr.is_null() {
            return Err(Error::Unsupported("libusb did not create a context".into()));
        }
        if std::env::var("KINECT_DRIVER_USBDK").is_ok_and(|v| v != "0") {
            // SAFETY: the option takes no argument; the context is valid.
            let r = unsafe { ffi::libusb_set_option(ptr, LIBUSB_OPTION_USE_USBDK) };
            if r < 0 {
                log::warn!("libusb: UsbDk not available ({})", error_name(r));
            }
        }
        let stop = Arc::new(AtomicBool::new(false));
        let ctx = Arc::new(Ctx { ptr, stop: stop.clone(), events: Mutex::new(None) });
        let p = CtxPtr(ptr);
        let handle = std::thread::Builder::new()
            .name("kinect-usb-events".into())
            .spawn(move || event_loop(p, &stop))
            .map_err(|e| Error::Unsupported(format!("cannot start the USB event thread: {e}")))?;
        *lock(&ctx.events) = Some(handle);
        Ok(ctx)
    }
}

fn event_loop(ctx: CtxPtr, stop: &AtomicBool) {
    while !stop.load(Ordering::Acquire) {
        let tv = libc::timeval { tv_sec: 0, tv_usec: 100_000 };
        // SAFETY: the context lives until this thread ends (it calls libusb_exit itself).
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe { ffi::libusb_handle_events_timeout_completed(ctx.0, &tv, ptr::null_mut()) }));
        match r {
            Ok(r) if r < 0 && r != LIBUSB_ERROR_INTERRUPTED && r != LIBUSB_ERROR_TIMEOUT => {
                log::debug!("libusb events: {}", error_name(r));
                std::thread::sleep(Duration::from_millis(10));
            }
            Ok(_) => {}
            Err(_) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
    // `stop` is only set when the last user of the context is gone
    // SAFETY: nothing refers to the context any more.
    unsafe { ffi::libusb_exit(ctx.0) };
}

impl Drop for Ctx {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        // SAFETY: the context is valid until the event thread exits.
        unsafe { ffi::libusb_interrupt_event_handler(self.ptr) };
        match lock(&self.events).take() {
            // the last reference went away inside a callback (a late transfer of a leaked
            // stream): the event thread finishes the callback, sees `stop` and cleans up
            Some(h) if h.thread().id() == std::thread::current().id() => {}
            Some(h) => {
                let _ = h.join();
            }
            // SAFETY: no event thread was started: nothing else uses the context.
            None => unsafe { ffi::libusb_exit(self.ptr) },
        }
    }
}

// ---- the backend ---------------------------------------------------------------------------

/// The real USB bus.
pub struct LibusbBackend {
    ctx: Arc<Ctx>,
    version: String,
}

impl LibusbBackend {
    /// Initializes libusb (and starts its event thread).
    pub fn new() -> Result<LibusbBackend> {
        let ctx = Ctx::new()?;
        // SAFETY: returns a pointer to a static struct.
        let v = unsafe { ffi::libusb_get_version() };
        let version = if v.is_null() {
            "libusb".to_string()
        } else {
            // SAFETY: non-null pointer to libusb's static version struct.
            let v = unsafe { &*v };
            format!("libusb {}.{}.{}", v.major, v.minor, v.micro)
        };
        Ok(LibusbBackend { ctx, version })
    }
}

/// The device list, unreferenced on drop.
struct DeviceList {
    list: *const *mut ffi::libusb_device,
    len: usize,
}

impl DeviceList {
    fn get(ctx: &Ctx) -> Result<DeviceList> {
        let mut list = ptr::null();
        // SAFETY: valid context and out pointer.
        let n = unsafe { ffi::libusb_get_device_list(ctx.ptr, &mut list) };
        if n < 0 {
            check("list devices", n as c_int)?;
        }
        Ok(DeviceList { list, len: n.max(0) as usize })
    }

    fn iter(&self) -> impl Iterator<Item = *mut ffi::libusb_device> + '_ {
        // SAFETY: the list has `len` valid entries while self lives.
        (0..self.len).map(move |i| unsafe { *self.list.add(i) }).filter(|d| !d.is_null())
    }
}

impl Drop for DeviceList {
    fn drop(&mut self) {
        if !self.list.is_null() {
            // SAFETY: the list came from libusb_get_device_list; devices we keep are ref'd.
            unsafe { ffi::libusb_free_device_list(self.list, 1) };
        }
    }
}

fn describe(dev: *mut ffi::libusb_device) -> Option<UsbDeviceInfo> {
    // SAFETY: an all-zero descriptor is a valid value of this plain C struct.
    let mut d: ffi::libusb_device_descriptor = unsafe { std::mem::zeroed() };
    // SAFETY: dev is a valid device from the list; d is a valid out pointer.
    if unsafe { ffi::libusb_get_device_descriptor(dev, &mut d) } < 0 {
        return None;
    }
    if d.idVendor != VENDOR_ID || (d.idProduct != PRODUCT_ID && d.idProduct != PRODUCT_ID_PREVIEW) {
        return None;
    }
    // SAFETY: dev is valid.
    let (bus, address, speed) = unsafe { (ffi::libusb_get_bus_number(dev), ffi::libusb_get_device_address(dev), ffi::libusb_get_device_speed(dev)) };
    let mut ports = [0u8; 8];
    // SAFETY: ports has room for 8 entries (USB 3 allows 7 tiers).
    let n = unsafe { ffi::libusb_get_port_numbers(dev, ports.as_mut_ptr(), ports.len() as c_int) };
    let path: Vec<String> = ports.iter().take(n.max(0) as usize).map(|p| p.to_string()).collect();
    let port_path = if path.is_empty() { format!("{bus}-?@{address}") } else { format!("{bus}-{}", path.join(".")) };
    let speed = match speed {
        LIBUSB_SPEED_LOW => UsbSpeed::Low,
        LIBUSB_SPEED_FULL => UsbSpeed::Full,
        LIBUSB_SPEED_HIGH => UsbSpeed::High,
        LIBUSB_SPEED_SUPER => UsbSpeed::Super,
        LIBUSB_SPEED_SUPER_PLUS => UsbSpeed::SuperPlus,
        _ => UsbSpeed::Unknown,
    };
    Some(UsbDeviceInfo { bus, address, port_path, product_id: d.idProduct, speed })
}

impl UsbBackend for LibusbBackend {
    fn name(&self) -> String {
        self.version.clone()
    }

    fn list(&self) -> Result<Vec<UsbDeviceInfo>> {
        let list = DeviceList::get(&self.ctx)?;
        Ok(list.iter().filter_map(describe).collect())
    }

    fn open(&self, info: &UsbDeviceInfo) -> Result<Box<dyn UsbDevice>> {
        let list = DeviceList::get(&self.ctx)?;
        let found = list.iter().filter_map(|d| describe(d).map(|i| (d, i))).find(|(_, i)| i.bus == info.bus && (i.address == info.address || i.port_path == info.port_path));
        let Some((dev, now)) = found else { return Err(Error::Disconnected) };
        let mut handle = ptr::null_mut();
        // SAFETY: dev is valid while the list lives; handle is a valid out pointer.
        check("open", unsafe { ffi::libusb_open(dev, &mut handle) })?;
        if handle.is_null() {
            return Err(Error::Disconnected);
        }
        // the kernel may have a driver on other interfaces (audio): detach only what we claim
        // SAFETY: valid handle; unsupported platforms return an error we ignore.
        let _ = unsafe { ffi::libusb_set_auto_detach_kernel_driver(handle, 1) };
        // SAFETY: keep the device referenced beyond the list.
        let dev = unsafe { ffi::libusb_ref_device(dev) };
        let h = Arc::new(Handle { ptr: handle, dev, _ctx: self.ctx.clone() });
        Ok(Box::new(LibusbDevice { ctx: self.ctx.clone(), handle: h, info: now, claimed: Vec::new() }))
    }
}

// ---- an opened device ----------------------------------------------------------------------

/// The open handle; closed when the device and all its streams (and leaked transfers) are gone.
struct Handle {
    ptr: *mut ffi::libusb_device_handle,
    dev: *mut ffi::libusb_device,
    _ctx: Arc<Ctx>,
}

// SAFETY: libusb device handles may be used from any thread.
unsafe impl Send for Handle {}
// SAFETY: see above.
unsafe impl Sync for Handle {}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: nothing uses the handle any more (streams and transfers hold this Arc).
        unsafe {
            ffi::libusb_close(self.ptr);
            ffi::libusb_unref_device(self.dev);
        }
    }
}

struct LibusbDevice {
    ctx: Arc<Ctx>,
    handle: Arc<Handle>,
    info: UsbDeviceInfo,
    claimed: Vec<u8>,
}

impl LibusbDevice {
    fn h(&self) -> *mut ffi::libusb_device_handle {
        self.handle.ptr
    }
}

impl Drop for LibusbDevice {
    fn drop(&mut self) {
        for i in std::mem::take(&mut self.claimed) {
            // SAFETY: valid handle.
            let _ = unsafe { ffi::libusb_release_interface(self.h(), c_int::from(i)) };
        }
    }
}

/// The active configuration descriptor, freed on drop.
struct ConfigDescriptor(*const ffi::libusb_config_descriptor);

impl Drop for ConfigDescriptor {
    fn drop(&mut self) {
        // SAFETY: came from libusb_get_active_config_descriptor.
        unsafe { ffi::libusb_free_config_descriptor(self.0) };
    }
}

impl UsbDevice for LibusbDevice {
    fn info(&self) -> &UsbDeviceInfo {
        &self.info
    }

    fn serial(&mut self) -> Result<String> {
        // SAFETY: zeroed is valid for the plain descriptor struct; dev is valid.
        let mut d: ffi::libusb_device_descriptor = unsafe { std::mem::zeroed() };
        check("device descriptor", unsafe { ffi::libusb_get_device_descriptor(self.handle.dev, &mut d) })?;
        if d.iSerialNumber == 0 {
            return Ok(String::new());
        }
        let mut buf = [0u8; 128];
        // SAFETY: buf is writable for its length.
        let n = check("serial", unsafe { ffi::libusb_get_string_descriptor_ascii(self.h(), d.iSerialNumber, buf.as_mut_ptr(), buf.len() as c_int) })?;
        Ok(String::from_utf8_lossy(buf.get(..n as usize).unwrap_or(&[])).trim().to_string())
    }

    fn reset(&mut self) -> Result<()> {
        // SAFETY: valid handle.
        match unsafe { ffi::libusb_reset_device(self.h()) } {
            // the device re-enumerated: this handle is gone, open it again
            LIBUSB_ERROR_NOT_FOUND => Err(Error::Disconnected),
            r => check("reset", r).map(|_| ()),
        }
    }

    fn configuration(&mut self) -> Result<u8> {
        let mut c: c_int = 0;
        // SAFETY: valid handle and out pointer.
        check("get configuration", unsafe { ffi::libusb_get_configuration(self.h(), &mut c) })?;
        Ok(c.clamp(0, 255) as u8)
    }

    fn set_configuration(&mut self, config: u8) -> Result<()> {
        // SAFETY: valid handle.
        check("set configuration", unsafe { ffi::libusb_set_configuration(self.h(), c_int::from(config)) }).map(|_| ())
    }

    fn claim(&mut self, interface: u8) -> Result<()> {
        // SAFETY: valid handle.
        check("claim interface", unsafe { ffi::libusb_claim_interface(self.h(), c_int::from(interface)) })?;
        if !self.claimed.contains(&interface) {
            self.claimed.push(interface);
        }
        Ok(())
    }

    fn release(&mut self, interface: u8) -> Result<()> {
        self.claimed.retain(|i| *i != interface);
        // SAFETY: valid handle.
        check("release interface", unsafe { ffi::libusb_release_interface(self.h(), c_int::from(interface)) }).map(|_| ())
    }

    fn set_alt(&mut self, interface: u8, alt: u8) -> Result<()> {
        // SAFETY: valid handle.
        check("set alternate setting", unsafe { ffi::libusb_set_interface_alt_setting(self.h(), c_int::from(interface), c_int::from(alt)) }).map(|_| ())
    }

    fn clear_halt(&mut self, endpoint: u8) -> Result<()> {
        // SAFETY: valid handle.
        check("clear halt", unsafe { ffi::libusb_clear_halt(self.h(), endpoint) }).map(|_| ())
    }

    fn control_out(&mut self, request_type: u8, request: u8, value: u16, index: u16, data: &[u8], timeout: Duration) -> Result<usize> {
        let len = u16::try_from(data.len()).map_err(|_| Error::invalid("control transfer too long"))?;
        let mut buf = data.to_vec();
        // SAFETY: valid handle; buf is valid for len bytes (libusb only reads it for OUT).
        let n = unsafe { ffi::libusb_control_transfer(self.h(), request_type, request, value, index, buf.as_mut_ptr(), len, millis(timeout)) };
        check("control transfer", n).map(|n| n as usize)
    }

    fn bulk_out(&mut self, endpoint: u8, data: &[u8], timeout: Duration) -> Result<usize> {
        let mut buf = data.to_vec();
        let mut done: c_int = 0;
        let len = c_int::try_from(buf.len()).map_err(|_| Error::invalid("bulk transfer too long"))?;
        // SAFETY: valid handle; buf valid for len bytes; done is a valid out pointer.
        let r = unsafe { ffi::libusb_bulk_transfer(self.h(), endpoint, buf.as_mut_ptr(), len, &mut done, millis(timeout)) };
        if r == LIBUSB_ERROR_TIMEOUT && done > 0 {
            return Ok(done as usize);
        }
        check("bulk write", r)?;
        Ok(done.max(0) as usize)
    }

    fn bulk_in(&mut self, endpoint: u8, buf: &mut [u8], timeout: Duration) -> Result<usize> {
        let mut done: c_int = 0;
        let len = c_int::try_from(buf.len()).map_err(|_| Error::invalid("bulk transfer too long"))?;
        // SAFETY: valid handle; buf valid for len bytes; done is a valid out pointer.
        let r = unsafe { ffi::libusb_bulk_transfer(self.h(), endpoint, buf.as_mut_ptr(), len, &mut done, millis(timeout)) };
        if r == LIBUSB_ERROR_OVERFLOW {
            // the device sent more than asked for: what fit is there, the rest is lost
            return Ok((done.max(0) as usize).min(buf.len()));
        }
        check("bulk read", r)?;
        Ok((done.max(0) as usize).min(buf.len()))
    }

    fn iso_bytes_per_interval(&mut self, interface: u8, alt: u8, endpoint: u8) -> Result<usize> {
        let mut cfg = ptr::null();
        // SAFETY: valid device and out pointer.
        check("config descriptor", unsafe { ffi::libusb_get_active_config_descriptor(self.handle.dev, &mut cfg) })?;
        if cfg.is_null() {
            return Err(Error::invalid("no configuration descriptor"));
        }
        let cfg = ConfigDescriptor(cfg);
        // SAFETY: the descriptor tree is valid while `cfg` lives; every count bounds its array.
        unsafe {
            let c = &*cfg.0;
            for i in 0..usize::from(c.bNumInterfaces) {
                let itf = &*c.interface.add(i);
                for a in 0..itf.num_altsetting.max(0) as usize {
                    let d = &*itf.altsetting.add(a);
                    if d.bInterfaceNumber != interface || d.bAlternateSetting != alt {
                        continue;
                    }
                    for e in 0..usize::from(d.bNumEndpoints) {
                        let ep = d.endpoint.add(e);
                        if (*ep).bEndpointAddress != endpoint {
                            continue;
                        }
                        let mut comp = ptr::null();
                        if ffi::libusb_get_ss_endpoint_companion_descriptor(self.ctx.ptr, ep, &mut comp) >= 0 && !comp.is_null() {
                            let bytes = usize::from((*comp).wBytesPerInterval);
                            ffi::libusb_free_ss_endpoint_companion_descriptor(comp.cast_mut());
                            return Ok(bytes);
                        }
                        // no SuperSpeed companion: a USB 2 connection
                        let mps = usize::from((*ep).wMaxPacketSize);
                        return Ok((mps & 0x7FF) * (1 + ((mps >> 11) & 3)));
                    }
                }
            }
        }
        Err(Error::invalid(format!("endpoint {endpoint:#04x} not found in interface {interface} alt {alt}")))
    }

    fn start_iso(&mut self, endpoint: u8, cfg: IsoConfig, sink: Box<dyn PacketSink>) -> Result<Box<dyn Stream>> {
        start_stream(self, endpoint, Kind::Iso { packets: cfg.packets_per_transfer.max(1), packet_size: cfg.packet_size.max(1) }, cfg.transfers.max(1), sink)
    }

    fn start_bulk(&mut self, endpoint: u8, cfg: BulkConfig, sink: Box<dyn PacketSink>) -> Result<Box<dyn Stream>> {
        start_stream(self, endpoint, Kind::Bulk { size: cfg.transfer_size.max(512) }, cfg.transfers.max(1), sink)
    }
}

// ---- streams -------------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Kind {
    Iso { packets: usize, packet_size: usize },
    Bulk { size: usize },
}

/// Shared between a stream and the callbacks of its transfers.
struct StreamState {
    kind: Kind,
    sink: Mutex<Box<dyn PacketSink>>,
    stopping: AtomicBool,
    /// transfers alive (submitted or being handled), as addresses: cancelled under this lock,
    /// removed under it before being freed, so a listed transfer is always valid
    live: Mutex<Vec<usize>>,
    in_flight: AtomicUsize,
    completed: AtomicU64,
    failed: AtomicU64,
    bad_packets: AtomicU64,
    resubmit_errors: AtomicU64,
    bytes: AtomicU64,
    lost: AtomicBool,
    /// transfers in a row that failed (a stalled or broken endpoint fails at once, every time:
    /// resubmitting forever would only burn the CPU)
    errors_in_row: AtomicU64,
    /// keeps the handle open while any transfer lives
    handle: Arc<Handle>,
}

/// Failed transfers in a row after which a stream gives up (each transfer fails at most once a
/// millisecond or so; real trouble on a weak controller comes in short bursts).
const MAX_ERRORS_IN_ROW: u64 = 2000;

/// The per-transfer data behind `user_data`.
struct Slot {
    state: Arc<StreamState>,
    buffer: Vec<u8>,
}

struct LibusbStream {
    state: Arc<StreamState>,
}

fn start_stream(dev: &mut LibusbDevice, endpoint: u8, kind: Kind, transfers: usize, sink: Box<dyn PacketSink>) -> Result<Box<dyn Stream>> {
    let state = Arc::new(StreamState {
        kind,
        sink: Mutex::new(sink),
        stopping: AtomicBool::new(false),
        live: Mutex::new(Vec::new()),
        in_flight: AtomicUsize::new(0),
        completed: AtomicU64::new(0),
        failed: AtomicU64::new(0),
        bad_packets: AtomicU64::new(0),
        resubmit_errors: AtomicU64::new(0),
        bytes: AtomicU64::new(0),
        lost: AtomicBool::new(false),
        errors_in_row: AtomicU64::new(0),
        handle: dev.handle.clone(),
    });
    let stream = LibusbStream { state: state.clone() };
    for _ in 0..transfers {
        if let Err(e) = submit_new(&state, endpoint) {
            // whatever was submitted goes back before the error is reported
            Box::new(stream).stop(Duration::from_secs(2));
            return Err(e);
        }
    }
    Ok(Box::new(stream))
}

fn submit_new(state: &Arc<StreamState>, endpoint: u8) -> Result<()> {
    let (packets, len) = match state.kind {
        Kind::Iso { packets, packet_size } => (packets, packets * packet_size),
        Kind::Bulk { size } => (0, size),
    };
    let len_c = c_int::try_from(len).map_err(|_| Error::config("transfer too large"))?;
    let slot = Box::new(Slot { state: state.clone(), buffer: vec![0u8; len] });
    // SAFETY: allocates a transfer with room for `packets` descriptors.
    let t = unsafe { ffi::libusb_alloc_transfer(packets as c_int) };
    if t.is_null() {
        return Err(Error::Usb { op: "allocate transfer", code: LIBUSB_ERROR_NO_MEM, detail: "out of memory".into() });
    }
    let slot = Box::into_raw(slot);
    // SAFETY: t is a fresh transfer; the slot (and its buffer) stays valid until the transfer is
    // freed, which also frees the slot.
    unsafe {
        let buf = (*slot).buffer.as_mut_ptr();
        match state.kind {
            Kind::Iso { packet_size, .. } => {
                ffi::libusb_fill_iso_transfer(t, state.handle.ptr, endpoint, buf, len_c, packets as c_int, on_transfer, slot.cast(), 1000);
                ffi::libusb_set_iso_packet_lengths(t, packet_size as c_uint);
            }
            Kind::Bulk { .. } => ffi::libusb_fill_bulk_transfer(t, state.handle.ptr, endpoint, buf, len_c, on_transfer, slot.cast(), 1000),
        }
    }
    // listed before it flies, so its callback always finds it; libusb is never called with our
    // lock held from this side
    lock(&state.live).push(t as usize);
    state.in_flight.fetch_add(1, Ordering::SeqCst);
    // SAFETY: t is filled in completely.
    let r = unsafe { ffi::libusb_submit_transfer(t) };
    if r < 0 {
        lock(&state.live).retain(|p| *p != t as usize);
        state.in_flight.fetch_sub(1, Ordering::SeqCst);
        // SAFETY: never submitted: nothing else refers to it.
        unsafe {
            ffi::libusb_free_transfer(t);
            drop(Box::from_raw(slot));
        }
        return check("submit transfer", r).map(|_| ());
    }
    Ok(())
}

/// Removes a transfer that will not be resubmitted, then frees it with its slot.
///
/// # Safety
/// `t` must be a transfer of this module that libusb is done with (in its callback, not
/// resubmitted), and `slot` its user data.
unsafe fn retire(t: *mut ffi::libusb_transfer, slot: *mut Slot) {
    // SAFETY: the slot is valid until freed here.
    let state = unsafe { (*slot).state.clone() };
    lock(&state.live).retain(|p| *p != t as usize);
    // SAFETY: as documented: nobody refers to t or slot any more.
    unsafe {
        ffi::libusb_free_transfer(t);
        drop(Box::from_raw(slot));
    }
    // last: a waiting stop() may return now
    state.in_flight.fetch_sub(1, Ordering::SeqCst);
}

extern "system" fn on_transfer(t: *mut ffi::libusb_transfer) {
    // a panic must never unwind into libusb: caught, counted, the transfer goes on
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // SAFETY: libusb calls this with one of our transfers, whose user_data is its Slot.
        unsafe { handle_transfer(t) }
    }));
    if r.is_err() {
        log::error!("kinect-driver: a USB callback panicked (caught)");
    }
}

/// # Safety
/// Only from `on_transfer`.
unsafe fn handle_transfer(t: *mut ffi::libusb_transfer) {
    if t.is_null() {
        return;
    }
    // SAFETY: our transfers always carry their Slot.
    let slot = unsafe { (*t).user_data }.cast::<Slot>();
    if slot.is_null() {
        return;
    }
    // SAFETY: the slot lives until `retire`.
    let state = unsafe { (*slot).state.clone() };
    // SAFETY: t is valid during its callback.
    let status = unsafe { (*t).status };
    match status {
        LIBUSB_TRANSFER_COMPLETED | LIBUSB_TRANSFER_TIMED_OUT | LIBUSB_TRANSFER_ERROR | LIBUSB_TRANSFER_OVERFLOW | LIBUSB_TRANSFER_STALL => {
            if status == LIBUSB_TRANSFER_COMPLETED {
                state.completed.fetch_add(1, Ordering::Relaxed);
                state.errors_in_row.store(0, Ordering::Relaxed);
            } else if status != LIBUSB_TRANSFER_TIMED_OUT {
                state.failed.fetch_add(1, Ordering::Relaxed);
                state.errors_in_row.fetch_add(1, Ordering::Relaxed);
            }
            if !state.stopping.load(Ordering::SeqCst) {
                // the sink is our code but may still have a bug: whatever happens there, the
                // transfer is resubmitted or retired below
                // SAFETY: t and its slot are valid during the callback.
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe { deliver(&state, t, slot, status) }));
                if r.is_err() {
                    state.failed.fetch_add(1, Ordering::Relaxed);
                    log::error!("kinect-driver: the stream's receiver panicked (caught)");
                }
            }
        }
        LIBUSB_TRANSFER_NO_DEVICE => mark_lost(&state),
        _ => {} // cancelled
    }
    // a stalled endpoint, or one that fails every time, ends the stream: the driver's watchdog
    // restarts it properly (clearing the halt)
    let broken = status == LIBUSB_TRANSFER_STALL || state.errors_in_row.load(Ordering::Relaxed) > MAX_ERRORS_IN_ROW;
    let gone = status == LIBUSB_TRANSFER_NO_DEVICE || status == LIBUSB_TRANSFER_CANCELLED || broken;
    if !gone && !state.stopping.load(Ordering::SeqCst) {
        // SAFETY: resubmitting a completed transfer from its callback is allowed.
        let r = unsafe { ffi::libusb_submit_transfer(t) };
        if r >= 0 {
            return;
        }
        state.resubmit_errors.fetch_add(1, Ordering::Relaxed);
        if r == LIBUSB_ERROR_NO_DEVICE {
            mark_lost(&state);
        }
    }
    // SAFETY: not resubmitted: libusb is done with it.
    unsafe { retire(t, slot) };
}

/// Tells the sink (once) that the device is gone.
fn mark_lost(state: &StreamState) {
    if !state.lost.swap(true, Ordering::SeqCst) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| lock(&state.sink).lost()));
    }
}

/// Hands the data of a finished transfer to the sink: every isochronous packet at its own offset
/// (`i * packet_size`, also after failed packets), a bulk transfer as one piece.
///
/// # Safety
/// `t` must be the finished transfer and `slot` its user data.
unsafe fn deliver(state: &StreamState, t: *mut ffi::libusb_transfer, slot: *mut Slot, status: c_int) {
    // SAFETY: the slot's buffer is not touched by libusb while the callback runs.
    let buf: &[u8] = unsafe { &(*slot).buffer };
    let mut sink = lock(&state.sink);
    // a transfer that failed as a whole may carry stale packet descriptors: all of it is lost
    let transfer_ok = status == LIBUSB_TRANSFER_COMPLETED;
    match state.kind {
        Kind::Iso { packets, packet_size } => {
            // SAFETY: t has `packets` descriptors (allocated so).
            let n = (unsafe { (*t).num_iso_packets }.max(0) as usize).min(packets);
            let mut bytes = 0u64;
            let mut bad = 0u64;
            for i in 0..n {
                // SAFETY: i < num_iso_packets.
                let d = unsafe { &*(*t).iso_packet_desc.as_ptr().add(i) };
                let ok = transfer_ok && d.status == LIBUSB_TRANSFER_COMPLETED;
                let len = (d.actual_length as usize).min(packet_size);
                let start = i * packet_size;
                let data = buf.get(start..start + len).unwrap_or(&[]);
                if !ok {
                    bad += 1;
                }
                bytes += data.len() as u64;
                sink.packet(if ok { data } else { &[] }, ok);
            }
            state.bad_packets.fetch_add(bad, Ordering::Relaxed);
            state.bytes.fetch_add(bytes, Ordering::Relaxed);
        }
        Kind::Bulk { .. } => {
            // SAFETY: t is valid.
            let n = unsafe { (*t).actual_length }.max(0) as usize;
            let data = buf.get(..n.min(buf.len())).unwrap_or(&[]);
            state.bytes.fetch_add(data.len() as u64, Ordering::Relaxed);
            if !data.is_empty() || transfer_ok {
                sink.packet(data, transfer_ok);
            }
        }
    }
}

impl Stream for LibusbStream {
    fn stop(self: Box<Self>, timeout: Duration) -> bool {
        let s = &self.state;
        s.stopping.store(true, Ordering::SeqCst);
        {
            let live = lock(&s.live);
            for t in live.iter() {
                // SAFETY: listed transfers are valid (they are removed under this lock before
                // being freed); cancelling a finished one just fails.
                let _ = unsafe { ffi::libusb_cancel_transfer(*t as *mut ffi::libusb_transfer) };
            }
        }
        let end = Instant::now() + timeout;
        while s.in_flight.load(Ordering::SeqCst) > 0 {
            if Instant::now() >= end {
                // the stack did not give them back: leak them (each holds the state and the
                // handle), never free what might still be written to
                log::warn!("kinect-driver: {} USB transfers did not return; leaving them", s.in_flight.load(Ordering::SeqCst));
                return false;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        true
    }

    fn stats(&self) -> StreamStats {
        let s = &self.state;
        StreamStats {
            completed: s.completed.load(Ordering::Relaxed),
            failed: s.failed.load(Ordering::Relaxed),
            bad_packets: s.bad_packets.load(Ordering::Relaxed),
            resubmit_errors: s.resubmit_errors.load(Ordering::Relaxed),
            bytes: s.bytes.load(Ordering::Relaxed),
            in_flight: s.in_flight.load(Ordering::Relaxed) as u64,
        }
    }

    fn alive(&self) -> bool {
        !self.state.lost.load(Ordering::SeqCst) && self.state.in_flight.load(Ordering::SeqCst) > 0
    }
}

impl Drop for LibusbStream {
    fn drop(&mut self) {
        if !self.state.stopping.load(Ordering::SeqCst) {
            // dropped without stop(): cancel, and let the callbacks free the transfers
            self.state.stopping.store(true, Ordering::SeqCst);
            let live = lock(&self.state.live);
            for t in live.iter() {
                // SAFETY: as in stop().
                let _ = unsafe { ffi::libusb_cancel_transfer(*t as *mut ffi::libusb_transfer) };
            }
        }
    }
}
