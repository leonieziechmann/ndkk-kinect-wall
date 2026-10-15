//! The tools: list, info, stream, record, replay, bench, simulate, eval, analyze.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use kinect_driver::consts::{HEIGHT, PIXELS, WIDTH};
use kinect_driver::driver::{Driver, DriverConfig, Event, Source};
use kinect_driver::frame::Frame;
use kinect_driver::pipeline::{Backend, Pipeline, make_decoder};
use kinect_driver::record::{RawHeader, RawReader, RawWriter};
use kinect_driver::sim::eval::Evaluation;
use kinect_driver::sim::{Scene, SimConfig, Simulator};
use kinect_driver::tables::DeviceTables;
use kinect_driver::tof::{CpuDecoder, TofConfig, TofMode, TofOutput, flags};
use kinect_driver::RawDepthPacket;

use crate::args::Args;
use crate::opts::{Common, IrMode};

type R = Result<(), String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ---- devices --------------------------------------------------------------------------------

fn backend() -> Result<kinect_driver::usb::libusb::LibusbBackend, String> {
    kinect_driver::usb::libusb::LibusbBackend::new().map_err(err)
}

/// `list`: the Kinects on the bus.
pub fn list(a: Args) -> R {
    a.done()?;
    use kinect_driver::usb::UsbBackend;
    let b = backend()?;
    let l = b.list().map_err(err)?;
    println!("{}", b.name());
    if l.is_empty() {
        println!("no Kinect v2 found");
        if cfg!(windows) {
            println!("  Windows: the Kinect needs the libusbK driver (Zadig: \"Xbox NUI Sensor\"), or UsbDk with KINECT_DRIVER_USBDK=1");
        } else if cfg!(target_os = "linux") {
            println!("  Linux: is it on a USB 3 port, and may you open it? (udev rule in kinect-driver/README.md)");
        }
    }
    for d in l {
        println!("port {:<10} address {:>3}  {}  product {:#06x}", d.port_path, d.address, d.speed.name(), d.product_id);
    }
    Ok(())
}

/// `info`: identity and calibration of a Kinect (stops nothing else: the hub must not hold it).
pub fn info(mut a: Args) -> R {
    use kinect_driver::device::{DeviceOptions, KinectDevice};
    use kinect_driver::usb::UsbBackend;
    let serial = a.value("--serial")?;
    let save = a.value("--save-calibration")?;
    a.done()?;
    let b = backend()?;
    let found = b.list().map_err(err)?;
    let Some(d) = found.first() else { return Err("no Kinect v2 found".into()) };
    let mut dev = KinectDevice::open(b.open(d).map_err(err)?, DeviceOptions::default()).map_err(err)?;
    let cal = dev.read_calibration().map_err(err)?;
    if let Some(s) = &serial
        && &cal.identity.serial != s
    {
        return Err(format!("the first Kinect is {}, not {s}", cal.identity.serial));
    }
    let p = cal.ir_params;
    println!("serial    {}", cal.identity.serial);
    println!("firmware  {}", cal.identity.firmware);
    println!("usb       port {} ({}), product {:#06x}", cal.identity.usb_path, d.speed.name(), cal.identity.product_id);
    println!("iso       {} bytes per interval", dev.iso_packet_size());
    println!("depth     fx {:.3} fy {:.3} cx {:.3} cy {:.3}", p.fx, p.fy, p.cx, p.cy);
    println!("          k1 {:.6} k2 {:.6} k3 {:.6} p1 {:.6} p2 {:.6}", p.k1, p.k2, p.k3, p.p1, p.p2);
    if let Some(c) = &cal.color_params {
        println!("color     fx {:.3} fy {:.3} cx {:.3} cy {:.3}", c.fx, c.fy, c.cx, c.cy);
    }
    for w in &dev.warnings {
        println!("warning   {w}");
    }
    if let Some(dir) = save {
        let tables = DeviceTables::new(cal.ir_params, cal.p0, &cal.identity.serial).map_err(err)?;
        kinect_driver::driver::save_calibration(Path::new(&dir), &cal.identity.serial, &tables).map_err(err)?;
        println!("calibration saved in {dir}");
    }
    dev.close();
    Ok(())
}

// ---- streaming --------------------------------------------------------------------------------

/// `stream`: runs the driver and prints a line per second.
pub fn stream(mut a: Args) -> R {
    let c = Common::parse(&mut a, false)?;
    let seconds: f64 = a.number("--seconds")?.unwrap_or(0.0);
    let png = a.value("--png")?.map(PathBuf::from);
    a.done()?;
    let driver = Driver::start(c.driver_config()).map_err(err)?;
    let start = Instant::now();
    let mut next = start + Duration::from_secs(1);
    let (mut frames, mut valid, mut ms) = (0u64, 0usize, 0f64);
    let mut last: Option<Box<Frame>> = None;
    while seconds <= 0.0 || start.elapsed().as_secs_f64() < seconds {
        match driver.recv_timeout(Duration::from_millis(50)) {
            Some(Event::Frame(f)) => {
                frames += 1;
                valid += f.valid_pixels();
                ms += f.pipeline_ms;
                last = Some(f);
            }
            Some(Event::State { state, detail }) => println!("{:>6.1} s  {} {detail}", start.elapsed().as_secs_f64(), state.name()),
            Some(Event::Device { identity, .. }) => println!("{:>6.1} s  device {} (firmware {})", start.elapsed().as_secs_f64(), identity.serial, identity.firmware),
            Some(Event::Warning(w)) => println!("{:>6.1} s  warning: {w}", start.elapsed().as_secs_f64()),
            _ => {}
        }
        if Instant::now() >= next {
            next += Duration::from_secs(1);
            let s = driver.status();
            let n = frames.max(1) as f64;
            let usb = s.stream.unwrap_or_default();
            println!(
                "{:>6.1} s  {:>4.1} fps  depth {:>5.1} %  {:>5.1} ms  usb bad {}  patched {}  partial {}  lost {}  restarts {}  {}",
                start.elapsed().as_secs_f64(),
                s.fps,
                100.0 * valid as f64 / n / PIXELS as f64,
                ms / n,
                usb.bad_packets,
                s.parser.filled_packets,
                s.parser.partial_frames,
                s.parser.dropped_frames + s.parser.missing_frames,
                s.restarts,
                s.decoder
            );
            frames = 0;
            valid = 0;
            ms = 0.0;
        }
    }
    if let (Some(dir), Some(f)) = (png, last) {
        write_frame_pngs(&dir, "last", &f.depth, &f.ir, c.ir)?;
        println!("last frame written to {}", dir.display());
    }
    driver.stop();
    Ok(())
}

/// `record`: raw packets from the Kinect into a `.k2raw` recording (shows the room: keep it in
/// recordings/, never commit it).
pub fn record(mut a: Args) -> R {
    let out = PathBuf::from(a.value("--out")?.ok_or("--out FILE.k2raw is missing")?);
    let seconds: f64 = a.number("--seconds")?.unwrap_or(10.0);
    let serial = a.value("--serial")?;
    a.done()?;
    if out.exists() {
        return Err(format!("{} exists already", out.display()));
    }
    let written = Arc::new(AtomicU64::new(0));
    let failed = Arc::new(AtomicU64::new(0));
    let (w2, f2, out2) = (written.clone(), failed.clone(), out.clone());
    let writer: Arc<std::sync::Mutex<Option<RawWriter>>> = Arc::default();
    let wr = writer.clone();
    let cfg = DriverConfig {
        source: Source::Kinect { serial },
        pipeline: Some(Arc::new(move || {
            let (w2, f2, out2, wr) = (w2.clone(), f2.clone(), out2.clone(), wr.clone());
            Ok(Pipeline::new().with_fn("record", move |f: &mut Frame| {
                let Some(raw) = f.raw.as_ref() else { return Ok(()) };
                let mut g = wr.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                if g.is_none() {
                    *g = Some(RawWriter::create(&out2, &RawHeader::from_tables(&f.tables))?);
                }
                if let Some(w) = g.as_mut() {
                    match w.write(raw) {
                        Ok(()) => w2.fetch_add(1, Ordering::Relaxed),
                        Err(_) => f2.fetch_add(1, Ordering::Relaxed),
                    };
                }
                Ok(())
            }))
        })),
        queue: 4,
        ..DriverConfig::default()
    };
    let driver = Driver::start(cfg).map_err(err)?;
    let mut started: Option<Instant> = None;
    let begin = Instant::now();
    loop {
        if let Some(Event::State { state, detail }) = driver.recv_timeout(Duration::from_millis(100)) {
            println!("{} {detail}", state.name());
        }
        if started.is_none() && written.load(Ordering::Relaxed) > 0 {
            started = Some(Instant::now());
        }
        if started.is_some_and(|t| t.elapsed().as_secs_f64() >= seconds) {
            break;
        }
        if started.is_none() && begin.elapsed() > Duration::from_secs(60) {
            driver.stop();
            return Err("no frames within a minute".into());
        }
    }
    let status = driver.status();
    driver.stop();
    if let Some(w) = writer.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take() {
        w.finish().map_err(err)?;
    }
    println!(
        "{} packets written to {} ({} failed, {} dropped by processing)",
        written.load(Ordering::Relaxed),
        out.display(),
        failed.load(Ordering::Relaxed),
        status.processing_dropped
    );
    Ok(())
}

// ---- recordings -----------------------------------------------------------------------------------

/// Reads packets from a `.k2raw` file or the simulator.
enum Packets {
    File(Box<RawReader>, Arc<DeviceTables>),
    Sim(Box<Simulator>, String, u32),
}

impl Packets {
    fn open(source: &str) -> Result<Packets, String> {
        if source == "sim" || source.starts_with("sim:") {
            let scene = source.strip_prefix("sim:").unwrap_or("room").to_string();
            Scene::preset(&scene, 0.0).ok_or_else(|| format!("unknown scene {scene:?}"))?;
            let sim = Simulator::new(SimConfig::default()).map_err(err)?;
            return Ok(Packets::Sim(Box::new(sim), scene, 0));
        }
        let r = RawReader::open(Path::new(source)).map_err(err)?;
        let t = r.header().tables().map_err(err)?;
        Ok(Packets::File(Box::new(r), t))
    }

    fn tables(&self) -> Arc<DeviceTables> {
        match self {
            Packets::File(_, t) => t.clone(),
            Packets::Sim(s, ..) => s.tables().clone(),
        }
    }

    fn next(&mut self) -> Result<Option<RawDepthPacket>, String> {
        match self {
            Packets::File(r, _) => r.next_packet().map_err(err),
            Packets::Sim(s, scene, n) => {
                let Some(sc) = Scene::preset(scene, *n as f32 / 30.0) else { return Ok(None) };
                let (p, _) = s.frame(&sc, *n);
                *n += 1;
                Ok(Some(p))
            }
        }
    }
}

/// `replay`: decodes a recording (or the simulator) and prints per-frame numbers; optionally
/// writes PNGs and compares the two modes.
pub fn replay(mut a: Args) -> R {
    let file = a.positional().ok_or("replay FILE.k2raw (or sim:SCENE)")?;
    let c = Common::parse(&mut a, false)?;
    let frames: usize = a.number("--frames")?.unwrap_or(usize::MAX);
    let every: usize = a.number("--every")?.unwrap_or(1).max(1);
    let png = a.value("--png")?.map(PathBuf::from);
    let compare = a.flag("--compare");
    a.done()?;
    let mut src = Packets::open(&file)?;
    let tables = src.tables();
    let mut pipe = Pipeline::decoder(c.tof.clone(), c.backend).map_err(err)?;
    if let Some(s) = c.ir.stage() {
        pipe.push(Box::new(s));
    }
    let mut other = if compare {
        let mut o = c.tof.clone();
        o.mode = if c.tof.mode == TofMode::Extended { TofMode::Compat } else { TofMode::Extended };
        let base = if o.mode == TofMode::Compat { TofConfig::compat() } else { TofConfig::extended() };
        let mut op = Pipeline::decoder(TofConfig { threads: c.tof.threads, ..base }, c.backend).map_err(err)?;
        if let Some(s) = c.ir.stage() {
            op.push(Box::new(s));
        }
        Some((op, o.mode))
    } else {
        None
    };
    let mut cmp = Compare::default();
    let mut n = 0usize;
    let mut index = 0usize;
    while n < frames {
        let Some(p) = src.next()? else { break };
        index += 1;
        if !(index - 1).is_multiple_of(every) {
            continue;
        }
        n += 1;
        let raw = Arc::new(p);
        let f = pipe.process(raw.clone(), &tables).map_err(err)?;
        let sat = f.flags.iter().filter(|x| **x & flags::SATURATED_ANY != 0).count();
        println!(
            "frame {:>6}  depth {:>5.1} %  saturated {:>4.1} %  {:>5.1} ms  {}",
            f.sequence,
            100.0 * f.valid_pixels() as f64 / PIXELS as f64,
            100.0 * sat as f64 / PIXELS as f64,
            f.pipeline_ms,
            f.decoder
        );
        if let Some(dir) = &png {
            write_frame_pngs(dir, &format!("{:06}", f.sequence), &f.depth, &f.ir, c.ir)?;
        }
        if let Some((op, _)) = other.as_mut() {
            let g = op.process(raw, &tables).map_err(err)?;
            cmp.add(&f, &g);
            if let Some(dir) = &png {
                write_frame_pngs(dir, &format!("{:06}-other", f.sequence), &g.depth, &g.ir, c.ir)?;
            }
        }
    }
    if let Some((_, mode)) = other {
        cmp.print(c.mode_name(), if mode == TofMode::Compat { "compat" } else { "extended" });
    }
    if let Some(dir) = &png {
        println!("PNGs in {} (depth: 16 bit mm; depth-color; ir: 8 bit)", dir.display());
    }
    Ok(())
}

/// Where two decodings differ, per distance band of the first.
#[derive(Default)]
struct Compare {
    frames: u64,
    only_a: [u64; 6],
    only_b: [u64; 6],
    both: [u64; 6],
    close: [u64; 6],
}

const BANDS: [f32; 6] = [500.0, 2000.0, 4500.0, 8000.0, 12000.0, 20000.0];

impl Compare {
    fn band(d: f32) -> usize {
        BANDS.iter().position(|b| d <= *b).unwrap_or(BANDS.len() - 1)
    }

    fn add(&mut self, a: &Frame, b: &Frame) {
        self.frames += 1;
        for (da, db) in a.depth.iter().zip(&b.depth) {
            match (*da > 0.0, *db > 0.0) {
                (true, true) => {
                    let k = Compare::band(*da);
                    if let (Some(x), Some(y)) = (self.both.get_mut(k), self.close.get_mut(k)) {
                        *x += 1;
                        *y += u64::from((da - db).abs() <= (0.01 * da).max(10.0));
                    }
                }
                (true, false) => {
                    if let Some(x) = self.only_a.get_mut(Compare::band(*da)) {
                        *x += 1;
                    }
                }
                (false, true) => {
                    if let Some(x) = self.only_b.get_mut(Compare::band(*db)) {
                        *x += 1;
                    }
                }
                _ => {}
            }
        }
    }

    fn print(&self, a: &str, b: &str) {
        let n = self.frames.max(1) as f64;
        println!("\nper frame, by distance:      only {a:<9} only {b:<9} both    agree (1 % / 10 mm)");
        let mut lo = 0.0;
        for (i, hi) in BANDS.iter().enumerate() {
            let g = |v: &[u64; 6]| v.get(i).copied().unwrap_or(0);
            println!(
                "  {:>5.1} - {:>5.1} m  {:>14.0} {:>14.0} {:>8.0}  {:>6.1} %",
                lo / 1000.0,
                hi / 1000.0,
                g(&self.only_a) as f64 / n,
                g(&self.only_b) as f64 / n,
                g(&self.both) as f64 / n,
                100.0 * g(&self.close) as f64 / g(&self.both).max(1) as f64
            );
            lo = *hi;
        }
    }
}

// ---- images -------------------------------------------------------------------------------------------

fn write_png(path: &Path, w: u32, h: u32, color: png::ColorType, depth: png::BitDepth, data: &[u8]) -> R {
    let file = std::fs::File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    enc.set_color(color);
    enc.set_depth(depth);
    let mut wr = enc.write_header().map_err(err)?;
    wr.write_image_data(data).map_err(err)?;
    wr.finish().map_err(err)
}

/// A color for a depth (blue near, red far), black without depth.
fn depth_color(d: f32, max: f32) -> [u8; 3] {
    if d <= 0.0 {
        return [0, 0, 0];
    }
    let t = (d / max).clamp(0.0, 1.0);
    // a simple rainbow: blue - cyan - green - yellow - red
    let seg = t * 4.0;
    let f = seg.fract();
    let (r, g, b) = match seg as u32 {
        0 => (0.0, f, 1.0),
        1 => (0.0, 1.0, 1.0 - f),
        2 => (f, 1.0, 0.0),
        3 => (1.0, 1.0 - f, 0.0),
        _ => (1.0, 0.0, 0.0),
    };
    [(r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8]
}

/// depth (16 bit, mm), a colored depth and the infrared (8 bit, the hub's tone: white at 6000).
pub fn write_frame_pngs(dir: &Path, name: &str, depth: &[f32], ir: &[f32], mode: IrMode) -> R {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let (w, h) = (WIDTH as u32, HEIGHT as u32);
    if depth.len() == PIXELS {
        let d16: Vec<u8> = depth.iter().flat_map(|d| (d.clamp(0.0, 65535.0) as u16).to_be_bytes()).collect();
        write_png(&dir.join(format!("{name}-depth.png")), w, h, png::ColorType::Grayscale, png::BitDepth::Sixteen, &d16)?;
        let max = depth.iter().copied().filter(|d| *d > 0.0).fold(4500f32, f32::max).min(18750.0);
        let rgb: Vec<u8> = depth.iter().flat_map(|d| depth_color(*d, max)).collect();
        write_png(&dir.join(format!("{name}-depth-color.png")), w, h, png::ColorType::Rgb, png::BitDepth::Eight, &rgb)?;
    }
    if ir.len() == PIXELS {
        let g: Vec<u8> = if mode == IrMode::Raw {
            // raw HDR: logarithmic over the frame's range, so nothing is white that is not the
            // brightest
            let max = ir.iter().copied().filter(|v| v.is_finite()).fold(1f32, f32::max);
            let scale = 255.0 / (1.0 + max).ln();
            ir.iter().map(|v| ((1.0 + v.max(0.0)).ln() * scale + 0.5).min(255.0) as u8).collect()
        } else {
            // as the hub shows it: sqrt, white at 6000
            ir.iter().map(|v| ((v / 6000.0).clamp(0.0, 1.0).sqrt() * 255.0 + 0.5) as u8).collect()
        };
        write_png(&dir.join(format!("{name}-ir.png")), w, h, png::ColorType::Grayscale, png::BitDepth::Eight, &g)?;
    }
    Ok(())
}

// ---- performance and quality ---------------------------------------------------------------------------

/// `bench`: milliseconds per frame for each backend and mode.
pub fn bench(mut a: Args) -> R {
    let source = a.value("--source")?.unwrap_or_else(|| "sim:room".into());
    let frames: usize = a.number("--frames")?.unwrap_or(60);
    let threads: usize = a.number("--threads")?.unwrap_or(0);
    let only = a.value("--backend")?;
    let only_mode = a.value("--mode")?;
    let fps: Option<f64> = a.number("--fps")?;
    let seconds: f64 = a.number("--seconds")?.unwrap_or(60.0);
    a.done()?;
    if fps.is_some_and(|f| !(1.0..=1000.0).contains(&f)) || !(seconds > 0.0 && seconds.is_finite()) {
        return Err("--fps 1..1000, --seconds > 0".into());
    }
    let mut src = Packets::open(&source)?;
    let tables = src.tables();
    let mut packets = Vec::new();
    while packets.len() < 8 {
        match src.next()? {
            Some(p) => packets.push(p),
            None => break,
        }
    }
    if packets.is_empty() {
        return Err("no packets".into());
    }
    let backends: Vec<Backend> = match only.as_deref() {
        Some(b) => vec![Backend::parse(b).ok_or("--backend cpu|gpu")?],
        None => vec![Backend::Cpu, Backend::Gpu],
    };
    let modes = match only_mode.as_deref() {
        None => vec![TofMode::Compat, TofMode::Extended],
        Some("compat") => vec![TofMode::Compat],
        Some("extended") => vec![TofMode::Extended],
        Some(m) => return Err(format!("--mode {m:?}: compat or extended")),
    };
    match fps {
        None => println!("{frames} frames from {source}"),
        Some(f) => println!("{f} frames per second from {source}, {seconds} s per run (read the power meter during each run, e.g. HWiNFO's CPU package power, which on an APU includes the GPU, and compare with idle)"),
    }
    for backend in backends {
        for &mode in &modes {
            let mut cfg = if mode == TofMode::Compat { TofConfig::compat() } else { TofConfig::extended() };
            cfg.threads = threads;
            let mut dec = make_decoder(cfg, backend).map_err(err)?;
            let mut out = TofOutput::new();
            for p in packets.iter().take(3) {
                dec.decode(p, &tables, &mut out).map_err(err)?;
            }
            if let Some(f) = fps {
                paced(dec.as_mut(), &packets, &tables, f, seconds)?;
                continue;
            }
            let mut ms = Vec::with_capacity(frames);
            for i in 0..frames {
                let p = packets.get(i % packets.len()).ok_or("no packet")?;
                let t = Instant::now();
                dec.decode(p, &tables, &mut out).map_err(err)?;
                ms.push(t.elapsed().as_secs_f64() * 1000.0);
            }
            ms.sort_by(f64::total_cmp);
            let mean = ms.iter().sum::<f64>() / ms.len().max(1) as f64;
            let p95 = ms.get(ms.len() * 95 / 100).copied().unwrap_or(0.0);
            println!("  {:<60} {:>6.2} ms/frame (p95 {:>6.2})", dec.describe(), mean, p95);
        }
    }
    Ok(())
}

/// Decodes at `fps` for `seconds`, as the show does (not as fast as it can), and prints the
/// time per frame and the CPU time of the whole process per frame: the decoding, the threads
/// of the GPU driver and the copies, but not the waiting for the GPU.
fn paced(dec: &mut dyn kinect_driver::pipeline::TofDecoder, packets: &[RawDepthPacket], tables: &Arc<DeviceTables>, fps: f64, seconds: f64) -> R {
    let period = Duration::from_secs_f64(1.0 / fps);
    let n = (seconds * fps).ceil().max(1.0) as u32;
    let mut out = TofOutput::new();
    let (mut busy, mut late) = (0.0, 0u32);
    println!("  {:<60} running {seconds} s ...", dec.describe());
    let cpu0 = process_cpu_seconds();
    let start = Instant::now();
    for i in 0..n {
        let due = start + period * i;
        let now = Instant::now();
        match due.checked_duration_since(now) {
            Some(wait) => std::thread::sleep(wait),
            None if now.duration_since(due) > period => late += 1,
            None => {}
        }
        let p = packets.get(i as usize % packets.len()).ok_or("no packet")?;
        let t = Instant::now();
        dec.decode(p, tables, &mut out).map_err(err)?;
        busy += t.elapsed().as_secs_f64();
    }
    let wall = start.elapsed().as_secs_f64();
    let per_frame = |s: f64| s * 1000.0 / f64::from(n);
    let cpu = match process_cpu_seconds().zip(cpu0) {
        Some((b, a)) => format!("CPU {:.2} ms/frame = {:.0} % of one core", per_frame(b - a), 100.0 * (b - a) / wall),
        None => "CPU time unknown here".into(),
    };
    let behind = if late > 0 { format!(", {late} frames more than a frame late") } else { String::new() };
    println!("  {:<60} {:>6.2} ms/frame, {cpu}{behind}", dec.describe(), per_frame(busy));
    Ok(())
}

/// The CPU time of this process so far (all threads, user and kernel), in seconds.
#[cfg(windows)]
fn process_cpu_seconds() -> Option<f64> {
    #[allow(unsafe_code)]
    mod win {
        use std::ffi::c_void;
        #[repr(C)]
        #[derive(Default)]
        pub struct FileTime {
            pub low: u32,
            pub high: u32,
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            pub fn GetCurrentProcess() -> *mut c_void;
            pub fn GetProcessTimes(process: *mut c_void, creation: *mut FileTime, exit: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
        }
    }
    let (mut creation, mut exit, mut kernel, mut user) = (win::FileTime::default(), win::FileTime::default(), win::FileTime::default(), win::FileTime::default());
    // SAFETY: the pseudo handle of the own process and four FILETIMEs on the stack that outlive
    // the call
    #[allow(unsafe_code)]
    let ok = unsafe { win::GetProcessTimes(win::GetCurrentProcess(), &mut creation, &mut exit, &mut kernel, &mut user) };
    // in units of 100 ns
    let secs = |f: &win::FileTime| ((u64::from(f.high) << 32) | u64::from(f.low)) as f64 * 1e-7;
    (ok != 0).then(|| secs(&kernel) + secs(&user))
}

/// The CPU time of this process so far (all threads, user and kernel), in seconds.
#[cfg(target_os = "linux")]
fn process_cpu_seconds() -> Option<f64> {
    // fields 14 and 15 of /proc/self/stat (utime, stime) in ticks of 1/100 s; the name before
    // them is in parentheses and may contain spaces
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    let fields: Vec<&str> = stat.rsplit_once(')')?.1.split_whitespace().collect();
    let tick = |i: usize| fields.get(i).and_then(|v| v.parse::<f64>().ok());
    Some((tick(11)? + tick(12)?) / 100.0)
}

/// The CPU time of this process so far: not known on this platform.
#[cfg(not(any(windows, target_os = "linux")))]
fn process_cpu_seconds() -> Option<f64> {
    None
}

/// `simulate`: a simulated recording (for tests without a Kinect).
pub fn simulate(mut a: Args) -> R {
    let out = PathBuf::from(a.value("--out")?.ok_or("--out FILE.k2raw is missing")?);
    let scene = a.value("--scene")?.unwrap_or_else(|| "room".into());
    let frames: u32 = a.number("--frames")?.unwrap_or(30);
    a.done()?;
    let mut sim = Simulator::new(SimConfig::default()).map_err(err)?;
    let mut w = RawWriter::create(&out, &RawHeader::from_tables(sim.tables())).map_err(err)?;
    for n in 0..frames {
        let sc = Scene::preset(&scene, n as f32 / 30.0).ok_or_else(|| format!("unknown scene {scene:?} ({})", Scene::PRESETS.join(", ")))?;
        let (p, _) = sim.frame(&sc, n);
        w.write(&p).map_err(err)?;
    }
    w.finish().map_err(err)?;
    println!("{frames} frames of '{scene}' in {}", out.display());
    Ok(())
}

/// `eval`: both modes against the simulator's ground truth.
pub fn eval(mut a: Args) -> R {
    let scenes = a.value("--scenes")?.unwrap_or_else(|| "room,near,far,ramp,hall".into());
    let frames: u32 = a.number("--frames")?.unwrap_or(2);
    let backend = Backend::parse(&a.value("--backend")?.unwrap_or_else(|| "cpu".into())).ok_or("--backend cpu|gpu")?;
    let mut ext = TofConfig::extended();
    if let Some(t) = a.value("--tof")? {
        ext.apply(&t).map_err(err)?;
    }
    a.done()?;
    for name in scenes.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let mut sim = Simulator::new(SimConfig::default()).map_err(err)?;
        let tables = sim.tables().clone();
        let mut dc = make_decoder(TofConfig::compat(), backend).map_err(err)?;
        let mut de = make_decoder(ext.clone(), backend).map_err(err)?;
        let (mut ec, mut ee) = (Evaluation::default(), Evaluation::default());
        let (mut oc, mut oe) = (TofOutput::new(), TofOutput::new());
        for f in 0..frames {
            let scene = Scene::preset(name, f as f32 * 0.5).ok_or_else(|| format!("unknown scene {name:?} ({})", Scene::PRESETS.join(", ")))?;
            let (p, gt) = sim.frame(&scene, f);
            dc.decode(&p, &tables, &mut oc).map_err(err)?;
            de.decode(&p, &tables, &mut oe).map_err(err)?;
            ec.add(&gt, &oc);
            ee.add(&gt, &oe);
        }
        println!("=== scene '{name}', {frames} frames");
        print!("{}", ec.table("compat (libfreenect2)"));
        print!("{}", ee.table("extended"));
    }
    Ok(())
}

// ---- calibration hints ------------------------------------------------------------------------------------

/// Per-pixel circular statistics of one frequency's phase over the frames.
#[derive(Clone, Copy, Default)]
struct PhaseAcc {
    c: f32,
    s: f32,
    amp: f32,
    n: u16,
}

/// Median of the chi-square distribution with 2 degrees of freedom: the cost of the best distance
/// of a pixel with three usable frequencies, if the noise model is right.
const CHI2_MEDIAN_2: f32 = 1.386;

fn median(v: &mut [f32]) -> f32 {
    percentile(v, 0.5)
}

fn percentile(v: &mut [f32], q: f32) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    let k = ((v.len() - 1) as f32 * q) as usize;
    v.select_nth_unstable_by(k, f32::total_cmp);
    v.get(k).copied().unwrap_or(0.0)
}

/// The unwrapping costs of static, clean multi-frequency pixels, split by what dominates their
/// noise model: the amplitude-dependent noise (weak pixels) or the floor (bright pixels).
fn unwrap_costs(file: &str, frames: usize, cfg: &TofConfig) -> Result<(Vec<f32>, Vec<f32>), String> {
    let mut src = Packets::open(file)?;
    let tables = src.tables();
    let mut dec = CpuDecoder::new(cfg.clone()).map_err(err)?;
    dec.record_costs(true);
    let mut out = TofOutput::new();
    let e = &cfg.ext;
    let c = (e.noise_coeff[0] + e.noise_coeff[1] + e.noise_coeff[2]) / 3.0;
    let f2 = e.noise_floor * e.noise_floor;
    let skip = flags::SATURATED_ANY | flags::REPAIRED_ANY | flags::DATA_LOST | flags::MULTIPATH | flags::PLAUSIBILITY | flags::EDGE;
    let mut base: Vec<f32> = Vec::new();
    let (mut weak, mut bright) = (Vec::new(), Vec::new());
    for n in 0..frames {
        let Some(p) = src.next()? else { break };
        dec.decode(&p, &tables, &mut out).map_err(err)?;
        let depth_of = |i: usize, u: f32| kinect_driver::tables::depth_from_u(u, tables.xtable.get(i).copied().unwrap_or(0.0), tables.ztable.get(i).copied().unwrap_or(0.0));
        if n == 0 {
            base = (0..PIXELS).map(|i| dec.unwrap_info(i).map(|u| depth_of(i, u.u1)).unwrap_or(0.0)).collect();
        }
        for i in (0..PIXELS).step_by(3) {
            let (Some(info), Some(&fl), Some(&b)) = (dec.unwrap_info(i), out.flags.get(i), base.get(i)) else { continue };
            let d = depth_of(i, info.u1);
            // a static pixel, unwrapped the same way as in the first frame
            if info.kind & 0x0f != 1 || fl & skip != 0 || !(500.0..6000.0).contains(&d) || (d - b).abs() > 0.02 * d {
                continue;
            }
            let amp = info.ir_sum / 3.0;
            let s2 = (c / amp.max(1e-3)).powi(2);
            let q = s2 / (s2 + f2);
            if q >= 0.75 {
                weak.push(info.cost);
            } else if q <= 0.25 {
                bright.push(info.cost);
            }
        }
    }
    Ok((weak, bright))
}

/// The illumination profile 1 / (1 + (tan / tan half)^q) fitted to the brightest pixels by
/// angle off the axis: (half angle in degrees, q), or `None` without bright surfaces towards
/// the edges.
fn fit_illumination(samples: &[(f32, f32)]) -> Option<(f32, f32)> {
    // 99th percentile of brightness * r^2 in bands of 2.5 degrees
    let mut bands: Vec<Vec<f32>> = vec![Vec::new(); 20];
    for (b, tan) in samples {
        let deg = tan.atan().to_degrees();
        if let Some(v) = bands.get_mut((deg / 2.5) as usize) {
            v.push(*b);
        }
    }
    let p99: Vec<Option<f32>> = bands.iter_mut().map(|v| (v.len() >= 300).then(|| percentile(v, 0.99))).collect();
    let mut center: Vec<f32> = p99.iter().take(8).flatten().copied().collect();
    if center.is_empty() {
        return None;
    }
    let top = median(&mut center);
    // ln(top / p99 - 1) = q (ln tan - ln tan half), from 25 degrees on, where it falls off
    let pts: Vec<(f32, f32)> = p99
        .iter()
        .enumerate()
        .skip(10)
        .filter_map(|(k, v)| {
            let v = (*v)?;
            let r = top / v - 1.0;
            let tan = ((k as f32 + 0.5) * 2.5).to_radians().tan();
            (v < 0.95 * top && r > 0.0).then(|| (tan.ln(), r.ln()))
        })
        .collect();
    if pts.len() < 2 {
        return None;
    }
    let n = pts.len() as f32;
    let (mx, my) = (pts.iter().map(|p| p.0).sum::<f32>() / n, pts.iter().map(|p| p.1).sum::<f32>() / n);
    let sxx: f32 = pts.iter().map(|p| (p.0 - mx) * (p.0 - mx)).sum();
    let sxy: f32 = pts.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum();
    if sxx <= 0.0 {
        return None;
    }
    let q = sxy / sxx;
    let half = (mx - my / q).exp().atan().to_degrees();
    (q > 1.0 && (5.0..80.0).contains(&half)).then_some((half, q))
}

/// `analyze`: what a real recording of a still scene says about this sensor: the brightness of a
/// white surface at 1 m and how it falls off towards the edges, the relative gain of the three
/// frequencies, their phase noise as the unwrapping sees it, how much saturates. Prints the
/// settings for `--tof`.
pub fn analyze(mut a: Args) -> R {
    let file = a.positional().ok_or("analyze FILE.k2raw")?;
    let frames: usize = a.number("--frames")?.unwrap_or(60);
    let mut cfg = TofConfig::extended();
    if let Some(t) = a.value("--tof")? {
        cfg.apply(&t).map_err(err)?;
    }
    a.done()?;
    let mut src = Packets::open(&file)?;
    let tables = src.tables();
    let abm = cfg.params.ab_multiplier;
    let mut dec = CpuDecoder::new(cfg.clone()).map_err(err)?;
    let mut out = TofOutput::new();
    let mut acc = vec![[PhaseAcc::default(); 3]; PIXELS];
    let mut first_depth: Option<Vec<f32>> = None;
    let mut ratios: [Vec<f32>; 3] = Default::default();
    // brightness * r^2 and tan(angle off the axis)
    let mut bright: Vec<(f32, f32)> = Vec::new();
    let (mut n, mut sat, mut repaired, mut valid) = (0usize, 0u64, 0u64, 0u64);
    while n < frames {
        let Some(p) = src.next()? else { break };
        dec.decode(&p, &tables, &mut out).map_err(err)?;
        n += 1;
        let base = first_depth.get_or_insert_with(|| out.depth.clone());
        for i in 0..PIXELS {
            let (Some(&d), Some(&fl), Some(&conf), Some(&ir)) = (out.depth.get(i), out.flags.get(i), out.confidence.get(i), out.ir.get(i)) else { continue };
            sat += u64::from(fl & flags::SATURATED_ANY != 0);
            repaired += u64::from(fl & flags::REPAIRED_ANY != 0);
            valid += u64::from(d > 0.0);
            let clean = d > 500.0 && d < 6000.0 && conf >= 0.9 && fl & (flags::SATURATED_ANY | flags::REPAIRED_ANY | flags::DATA_LOST | flags::MULTIPATH) == 0;
            if !clean {
                continue;
            }
            let s = [dec.sample(0, i), dec.sample(1, i), dec.sample(2, i)];
            let amps: Vec<f32> = s.iter().map(|v| v.map(|(a, b)| (a * a + b * b).sqrt()).unwrap_or(0.0)).collect();
            let mean = amps.iter().sum::<f32>() / 3.0;
            if mean <= 0.0 {
                continue;
            }
            if i % 7 == 0 {
                for (r, amp) in ratios.iter_mut().zip(&amps) {
                    r.push(amp / mean);
                }
                // radial distance in m (the plausibility test works with it)
                let ray = tables.rays.get(i).copied().unwrap_or([0.0, 0.0]);
                let t2 = ray[0] * ray[0] + ray[1] * ray[1];
                let r = d / 1000.0 * (t2 + 1.0).sqrt();
                bright.push((ir * r * r, t2.sqrt()));
            }
            // a static pixel (same depth as in the first frame) adds to the phase statistics
            if base.get(i).is_some_and(|b| (b - d).abs() < 0.02 * d)
                && let Some(px) = acc.get_mut(i)
            {
                for (k, slot) in px.iter_mut().enumerate() {
                    if let Some(Some((a, b))) = s.get(k) {
                        let m = (a * a + b * b).sqrt();
                        if m > 0.0 {
                            slot.c += a / m;
                            slot.s += b / m;
                            slot.amp += m;
                            slot.n += 1;
                        }
                    }
                }
            }
        }
    }
    if n == 0 {
        return Err("no frames".into());
    }
    let gains: Vec<f32> = ratios.iter_mut().map(|v| median(v)).collect();
    let mut noise = [0f32; 3];
    for (k, nk) in noise.iter_mut().enumerate() {
        // phase noise times amplitude, for pixels seen often enough
        let mut v: Vec<f32> = acc
            .iter()
            .filter_map(|px| px.get(k))
            .filter(|p| usize::from(p.n) >= (n * 3 / 4).max(5))
            .map(|p| {
                let r = ((p.c * p.c + p.s * p.s).sqrt() / f32::from(p.n)).clamp(1e-6, 1.0);
                let sigma = (-2.0 * r.ln()).max(0.0).sqrt();
                sigma * p.amp / f32::from(p.n) * abm
            })
            .collect();
        *nk = median(&mut v);
    }
    let px = (n * PIXELS) as f64;
    let e = &cfg.ext;
    println!("{n} frames of {file}");
    println!("  depth on {:.1} % of the pixels, saturated {:.2} %, rebuilt {:.2} %", 100.0 * valid as f64 / px, 100.0 * sat as f64 / px, 100.0 * repaired as f64 / px);
    // the illumination profile from the brightest surfaces at each angle (rough in a cluttered
    // room: a white wall filling the view gives it best), then the brightness of a white surface
    // on the axis
    let fit = fit_illumination(&bright);
    let mut profile = cfg.clone();
    match fit {
        Some((half, q)) => {
            println!(
                "  illumination: half at {half:.1} degrees off the axis, steepness {q:.1}  (illumination_angle / _steepness, now {:.1} / {:.1})",
                e.illumination_angle, e.illumination_steepness
            );
            profile.ext.illumination_angle = half;
            profile.ext.illumination_steepness = q;
        }
        None => println!("  illumination: too few bright surfaces towards the edges to measure the falloff (keeps {:.1} / {:.1})", e.illumination_angle, e.illumination_steepness),
    }
    let mut on_axis: Vec<f32> = bright.iter().map(|(b, tan)| b * kinect_driver::tof::cpu::inverse_illumination(&[*tan, 0.0], &profile.ext) as f32).collect();
    let b_med = median(&mut on_axis);
    let b90 = percentile(&mut on_axis, 0.9);
    let b99 = percentile(&mut on_axis, 0.99);
    println!("  brightness * distance^2 on the axis (IR at 1 m): median {b_med:.0}, 90 % {b90:.0}, 99 % {b99:.0}  (brightness_1m: a white surface, now {:.0})", e.brightness_1m);
    println!("  amplitude per frequency / mean (80, 16, 120 MHz): {:.3} {:.3} {:.3}  (gain_correction, now {:.3}:{:.3}:{:.3})", gains.first().unwrap_or(&0.0), gains.get(1).unwrap_or(&0.0), gains.get(2).unwrap_or(&0.0), e.gain_correction[0], e.gain_correction[1], e.gain_correction[2]);
    // the noise model: the ratios of the frequencies from their measured noise, the levels such
    // that the unwrapping costs of static pixels follow their distribution (median 1.39 with
    // three frequencies): the filtered phases, the stray light and the calibration errors the
    // unwrapping sees, not only the sensor noise
    let mut model = profile.clone();
    if noise.iter().all(|v| *v > 0.0) {
        println!("  phase noise * amplitude of the raw samples (static pixels): {:.2} {:.2} {:.2}", noise[0], noise[1], noise[2]);
        let (now, raw) = (e.noise_coeff.iter().sum::<f32>(), noise.iter().sum::<f32>());
        model.ext.noise_coeff = noise.map(|v| v * now / raw);
    } else {
        println!("  phase noise: needs a still scene (too few unchanged pixels)");
    }
    let mut fitted = false;
    for _ in 0..3 {
        let (mut weak, mut strong) = unwrap_costs(&file, frames, &model)?;
        if weak.len() < 1000 || strong.len() < 1000 {
            break;
        }
        let (mw, ms) = (median(&mut weak), median(&mut strong));
        let cs = (mw / CHI2_MEDIAN_2).sqrt().clamp(0.25, 4.0);
        let fs = (ms / CHI2_MEDIAN_2).sqrt().clamp(0.25, 4.0);
        model.ext.noise_coeff = model.ext.noise_coeff.map(|c| c * cs);
        model.ext.noise_floor *= fs;
        fitted = true;
        if (cs - 1.0).abs() < 0.03 && (fs - 1.0).abs() < 0.03 {
            break;
        }
    }
    let m = &model.ext;
    if fitted {
        println!(
            "  noise model of the unwrapping: noise_coeff {:.2}:{:.2}:{:.2}, noise_floor {:.3}  (now {:.2}:{:.2}:{:.2}, {:.3})",
            m.noise_coeff[0], m.noise_coeff[1], m.noise_coeff[2], m.noise_floor, e.noise_coeff[0], e.noise_coeff[1], e.noise_coeff[2], e.noise_floor
        );
    } else {
        println!("  noise model: too few static pixels with three frequencies to fit it");
    }
    let mut tof = format!("brightness_1m={:.0},gain_correction={:.3}:{:.3}:{:.3}", b99.max(1.0), gains.first().unwrap_or(&1.0), gains.get(1).unwrap_or(&1.0), gains.get(2).unwrap_or(&1.0));
    if fitted {
        tof += &format!(",noise_coeff={:.2}:{:.2}:{:.2},noise_floor={:.3}", m.noise_coeff[0], m.noise_coeff[1], m.noise_coeff[2], m.noise_floor);
    }
    if let Some((half, q)) = fit {
        tof += &format!(",illumination_angle={half:.1},illumination_steepness={q:.1}");
    }
    println!("  try: --tof {tof}");
    Ok(())
}

/// The sources the commands accept (for the help text).
pub fn source_help() -> String {
    format!("kinect | kinect:SERIAL | sim | sim:SCENE ({}) | FILE.k2raw", Scene::PRESETS.join(", "))
}
