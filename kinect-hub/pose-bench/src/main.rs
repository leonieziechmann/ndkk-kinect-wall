//! pose-bench: a measurement prototype. Runs the pose model of the person tracking (YOLO11n-pose,
//! web/lib/models/) natively with ONNX Runtime, on the GPU through DirectML and on the CPU with N
//! threads, prepared and decoded exactly as web/lib/persons-pose.js does it in the browser. Prints
//! the time per run (median, p90), the CPU it takes and the sensor rate at the hub meanwhile, and
//! compares the results with the browser's (web/tools/pose-ref.mjs). README.md has the steps.
//!
//!   pose-bench --ep dml,cpu6 --frames a.bin,b.bin --compare
//!   pose-bench --ep dml --seconds 20 --load           # CPU and GPU load per process (load.ps1)
//!   pose-bench --ep dml --seconds 20 --hz 15 --load   # the same at a fixed pose rate
//!
//! Without --frames it takes the newest infrared frame from the running hub (/api/frame/ir).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use ort::ep;
use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::Tensor;

const W: usize = 512;
const H: usize = 424;
const MAX_POSES: usize = 16;
const MIN_SCORE: f32 = 0.35;
const NMS_IOU: f64 = 0.5;

type Res<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Clone, Copy, Debug)]
enum Ep {
    /// DirectML on the GPU with this adapter index
    Dml(i32),
    /// the CPU with this many threads; spinning: the threads busy-wait for work between the steps
    Cpu { threads: usize, spinning: bool },
}

impl std::fmt::Display for Ep {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Ep::Dml(0) => write!(f, "dml"),
            Ep::Dml(d) => write!(f, "dml{d}"),
            Ep::Cpu { threads, spinning } => write!(f, "cpu{threads}{}", if *spinning { "spin" } else { "" }),
        }
    }
}

fn parse_ep(s: &str) -> Res<Ep> {
    if let Some(d) = s.strip_prefix("dml") {
        return Ok(Ep::Dml(if d.is_empty() { 0 } else { d.parse()? }));
    }
    if let Some(rest) = s.strip_prefix("cpu") {
        let (n, spinning) = match rest.strip_suffix("spin") {
            Some(n) => (n, true),
            None => (rest, false),
        };
        return Ok(Ep::Cpu { threads: n.parse()?, spinning });
    }
    Err(format!("unbekannter Provider {s} (dml, dml1, cpu6, cpu6spin)").into())
}

struct Opts {
    model: PathBuf,
    dylib: PathBuf,
    frames: Vec<PathBuf>,
    hub: String,
    eps: Vec<Ep>,
    runs: usize,
    seconds: Option<f64>,
    hz: Option<f64>,
    warmup: usize,
    compare: bool,
    load: bool,
    /// write the middle infrared frame of each recording into this folder, then stop
    extract: Option<(PathBuf, Vec<PathBuf>)>,
}

fn opts() -> Res<Opts> {
    let here = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut o = Opts {
        model: here.join("../../web/lib/models/yolo11n-pose-fp16.onnx"),
        // the hub's copy (setup-onnxruntime.ps1) unless there is one of its own
        dylib: std::env::var_os("ORT_DYLIB_PATH").map_or_else(
            || Some(here.join("ort/onnxruntime.dll")).filter(|p| p.is_file()).unwrap_or_else(|| here.join("../onnxruntime/onnxruntime.dll")),
            PathBuf::from,
        ),
        frames: Vec::new(),
        hub: "127.0.0.1:8090".into(),
        eps: vec![Ep::Dml(0), Ep::Cpu { threads: 6, spinning: false }],
        runs: 100,
        seconds: None,
        hz: None,
        warmup: 5,
        compare: false,
        load: false,
        extract: None,
    };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut val = || args.next().ok_or_else(|| format!("{a} braucht einen Wert"));
        match a.as_str() {
            "--model" => o.model = val()?.into(),
            "--ort" => o.dylib = val()?.into(),
            "--frames" => o.frames = val()?.split(',').map(PathBuf::from).collect(),
            "--hub" => o.hub = val()?,
            "--ep" => o.eps = val()?.split(',').map(parse_ep).collect::<Res<_>>()?,
            "--runs" => o.runs = val()?.parse()?,
            "--seconds" => o.seconds = Some(val()?.parse()?),
            "--hz" => o.hz = Some(val()?.parse()?),
            "--warmup" => o.warmup = val()?.parse()?,
            "--compare" => o.compare = true,
            "--load" => o.load = true,
            "--extract" => {
                let dir = PathBuf::from(val()?);
                o.extract = Some((dir, args.by_ref().map(PathBuf::from).collect()));
            }
            "-h" | "--help" => {
                println!(
                    "pose-bench [--ep dml,cpu6,cpu3spin] [--frames a.bin,b.bin] [--runs 100 | --seconds 20] [--hz 15] [--load] [--compare]\n           [--model web/lib/models/yolo11n-pose-fp16.onnx] [--ort ort/onnxruntime.dll] [--hub 127.0.0.1:8090] [--warmup 5]
pose-bench --extract OUT_DIR a.k2rec b.k2rec   (the middle infrared frame of each as OUT_DIR/<name>.bin)"
                );
                std::process::exit(0);
            }
            _ => return Err(format!("unbekannte Option {a}").into()),
        }
    }
    Ok(o)
}

// ---- input and output, as web/lib/persons-pose.js -------------------------------------------------

/// How the 512x424 image sits in the model input: scaled to fit, gray bands around it (as in
/// training). At 512x448 the scale is 1 and the bands are 12 rows above and below.
#[derive(Clone, Copy, Debug)]
struct Letterbox {
    in_w: usize,
    in_h: usize,
    scale: f64,
    /// image size in the input and its offset, in input pixels
    w: usize,
    h: usize,
    pad_x: usize,
    pad_y: usize,
}

impl Letterbox {
    fn new(in_w: usize, in_h: usize) -> Self {
        let scale = (in_w as f64 / W as f64).min(in_h as f64 / H as f64);
        let (w, h) = (((W as f64 * scale).round() as usize).min(in_w), ((H as f64 * scale).round() as usize).min(in_h));
        Self { in_w, in_h, scale, w, h, pad_x: (in_w - w) / 2, pad_y: (in_h - h) / 2 }
    }

    /// A point of the model input back to pixels of the (mirrored) depth image.
    fn to_image(self, x: f64, y: f64) -> (f64, f64) {
        ((W - 1) as f64 - (x - self.pad_x as f64) / self.scale, (y - self.pad_y as f64) / self.scale)
    }
}

/// The model input: gray letterbox bands, the image mirrored back, gray in all three channels, 0..1.
/// At scale 1 the values are rounded the way JavaScript stores them in a Float32Array (exactly as
/// persons-pose.js); smaller inputs are scaled bilinearly like the training's letterbox.
fn preprocess(ir: &[u8], x: &mut [f32], lut: &[f32; 256], lb: &Letterbox) {
    let plane = lb.in_w * lb.in_h;
    x.fill((114.0_f64 / 255.0) as f32);
    let (p0, rest) = x.split_at_mut(plane.min(x.len()));
    let rows = p0.chunks_exact_mut(lb.in_w).skip(lb.pad_y).take(lb.h);
    if lb.w == W && lb.h == H {
        for (dst, src) in rows.zip(ir.as_chunks::<W>().0) {
            for (d, s) in dst.iter_mut().skip(lb.pad_x).zip(src.iter().rev()) {
                *d = lut.get(usize::from(*s)).copied().unwrap_or(0.0);
            }
        }
    } else {
        // per input row/column: the two source rows/columns and the weight of the second
        let taps = |n: usize, len: usize| -> Vec<(usize, usize, f32)> {
            (0..n)
                .map(|i| {
                    let s = ((i as f64 + 0.5) / lb.scale - 0.5).clamp(0.0, (len - 1) as f64);
                    let i0 = s.floor() as usize;
                    (i0, (i0 + 1).min(len - 1), (s - i0 as f64) as f32)
                })
                .collect()
        };
        let cols = taps(lb.w, W);
        // the image is mirrored back: input column c reads source column W - 1 - c
        let px = |row: &[u8], c: usize| f32::from(row.get(W - 1 - c).copied().unwrap_or(0));
        for (dst, (r0, r1, fy)) in rows.zip(taps(lb.h, H)) {
            let (Some(a), Some(b)) = (ir.get(r0 * W..(r0 + 1) * W), ir.get(r1 * W..(r1 + 1) * W)) else { continue };
            for (d, (c0, c1, fx)) in dst.iter_mut().skip(lb.pad_x).zip(&cols) {
                let top = px(a, *c0) * (1.0 - fx) + px(a, *c1) * fx;
                let bottom = px(b, *c0) * (1.0 - fx) + px(b, *c1) * fx;
                *d = (top * (1.0 - fy) + bottom * fy) / 255.0;
            }
        }
    }
    for p in rest.chunks_exact_mut(plane) {
        p.copy_from_slice(p0);
    }
}

#[derive(Clone, Debug)]
struct Pose {
    score: f64,
    /// u0, v0, u1, v1 in pixels of the (mirrored) depth image
    bbox: [f64; 4],
    /// 17 x (u, v, confidence)
    kp: [f32; 51],
}

fn iou(a: &[f64; 4], b: &[f64; 4]) -> f64 {
    let inter = (a[2].min(b[2]) - a[0].max(b[0])).max(0.0) * (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
    let area = |r: &[f64; 4]| (r[2] - r[0]).max(0.0) * (r[3] - r[1]).max(0.0);
    inter / (area(a) + area(b) - inter).max(1e-6)
}

/// Channel c of the output [1, C, A].
fn chan(data: &[f32], anchors: usize, c: usize) -> &[f32] {
    data.get(c * anchors..(c + 1) * anchors).unwrap_or(&[])
}

fn at(ch: &[f32], a: usize) -> f64 {
    f64::from(ch.get(a).copied().unwrap_or(0.0))
}

/// Candidates above MIN_SCORE, greedy non-maximum suppression, at most 16, back to image pixels.
fn decode(data: &[f32], channels: usize, anchors: usize, lb: &Letterbox) -> Vec<Pose> {
    let score = chan(data, anchors, 4);
    let mut cands: Vec<(usize, f64, [f64; 4])> = Vec::new();
    for (a, s) in score.iter().enumerate() {
        if *s < MIN_SCORE {
            continue;
        }
        let (cx, cy) = (at(chan(data, anchors, 0), a), at(chan(data, anchors, 1), a));
        let (w, h) = (at(chan(data, anchors, 2), a), at(chan(data, anchors, 3), a));
        cands.push((a, f64::from(*s), [cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0]));
    }
    cands.sort_by(|p, q| q.1.total_cmp(&p.1));
    let mut keep: Vec<(usize, f64, [f64; 4])> = Vec::new();
    for c in cands {
        if keep.iter().all(|k| iou(&k.2, &c.2) < NMS_IOU) {
            keep.push(c);
        }
        if keep.len() >= MAX_POSES {
            break;
        }
    }
    keep.into_iter()
        .map(|(a, score, b)| {
            let mut kp = [0.0_f32; 51];
            for (k, [u, v, conf]) in kp.as_chunks_mut::<3>().0.iter_mut().enumerate() {
                if 5 + 3 * k + 2 >= channels {
                    break;
                }
                let (x, y) = lb.to_image(at(chan(data, anchors, 5 + 3 * k), a), at(chan(data, anchors, 6 + 3 * k), a));
                (*u, *v) = (x as f32, y as f32);
                *conf = at(chan(data, anchors, 7 + 3 * k), a) as f32;
            }
            let ((u0, v0), (u1, v1)) = (lb.to_image(b[2], b[1]), lb.to_image(b[0], b[3]));
            Pose { score, bbox: [u0, v0, u1, v1], kp }
        })
        .collect()
}

// ---- the hub and the machine ---------------------------------------------------------------------

/// A plain HTTP GET (the hub answers with Content-Length; chunked bodies are joined too).
fn http_get(host: &str, path: &str) -> Res<Vec<u8>> {
    let mut s = TcpStream::connect(host)?;
    s.set_read_timeout(Some(Duration::from_secs(5)))?;
    write!(s, "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n")?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf)?;
    let end = buf.windows(4).position(|w| w == b"\r\n\r\n").ok_or("keine HTTP-Antwort")?;
    let head = String::from_utf8_lossy(buf.get(..end).unwrap_or(&[])).to_ascii_lowercase();
    if !head.starts_with("http/1.1 200") {
        return Err(format!("{path}: {}", head.lines().next().unwrap_or("")).into());
    }
    let body = buf.get(end + 4..).unwrap_or(&[]);
    if !head.contains("transfer-encoding: chunked") {
        return Ok(body.to_vec());
    }
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(nl) = rest.windows(2).position(|w| w == b"\r\n") {
        let len = usize::from_str_radix(String::from_utf8_lossy(rest.get(..nl).unwrap_or(&[])).trim(), 16)?;
        if len == 0 {
            break;
        }
        out.extend_from_slice(rest.get(nl + 2..nl + 2 + len).ok_or("abgeschnittener Chunk")?);
        rest = rest.get(nl + 4 + len..).unwrap_or(&[]);
    }
    Ok(out)
}

/// Frames the hub has received from the sensor so far ("frames" at the top level of /api/status;
/// nested objects have counters of that name too).
fn hub_frames(hub: &str) -> Option<(u64, Instant)> {
    let body = http_get(hub, "/api/status").ok()?;
    let key = b"\"frames\":".as_slice();
    let (mut depth, mut in_str, mut esc) = (0_i32, false, false);
    for (i, c) in body.iter().enumerate() {
        if in_str {
            if esc {
                esc = false;
            } else if *c == b'\\' {
                esc = true;
            } else if *c == b'"' {
                in_str = false;
            }
            continue;
        }
        match c {
            b'{' | b'[' => depth += 1,
            b'}' | b']' => depth -= 1,
            b'"' if depth == 1 && body.get(i..i + key.len()) == Some(key) => {
                let digits: String = body.get(i + key.len()..)?.iter().map(|b| char::from(*b)).take_while(char::is_ascii_digit).collect();
                return Some((digits.parse().ok()?, Instant::now()));
            }
            b'"' => in_str = true,
            _ => {}
        }
    }
    None
}

#[repr(C)]
#[derive(Default)]
struct FileTime {
    low: u32,
    high: u32,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> *mut std::ffi::c_void;
    fn GetProcessTimes(process: *mut std::ffi::c_void, creation: *mut FileTime, exit: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
}

/// Processor time this process has used so far (all threads, user + kernel).
fn cpu_time() -> Duration {
    let (mut c, mut e, mut k, mut u) = (FileTime::default(), FileTime::default(), FileTime::default(), FileTime::default());
    // SAFETY: GetCurrentProcess returns a pseudo handle that needs no closing; the four pointers are
    // valid FILETIME-shaped locals for the duration of the call.
    let ok = unsafe { GetProcessTimes(GetCurrentProcess(), &mut c, &mut e, &mut k, &mut u) };
    if ok == 0 {
        return Duration::ZERO;
    }
    let ticks = |t: &FileTime| (u64::from(t.high) << 32) | u64::from(t.low);
    Duration::from_nanos((ticks(&k) + ticks(&u)) * 100)
}

// ---- measuring -----------------------------------------------------------------------------------

struct Frame {
    name: String,
    path: Option<PathBuf>,
    ir: Vec<u8>,
}

fn frames(o: &Opts) -> Res<Vec<Frame>> {
    if o.frames.is_empty() {
        let ir = http_get(&o.hub, "/api/frame/ir")?;
        return Ok(vec![Frame { name: "hub".into(), path: None, ir }]);
    }
    o.frames
        .iter()
        .map(|p| {
            let ir = std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?;
            if ir.len() != W * H {
                return Err(format!("{}: {} Byte statt {}", p.display(), ir.len(), W * H).into());
            }
            let name = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            Ok(Frame { name, path: Some(p.clone()), ir })
        })
        .collect()
}

fn session(model: &Path, e: Ep) -> Res<Session> {
    let b = Session::builder()?.with_optimization_level(GraphOptimizationLevel::Level3)?;
    let s = match e {
        // DirectML wants sequential execution and no memory pattern
        Ep::Dml(device) => b
            .with_parallel_execution(false)?
            .with_memory_pattern(false)?
            .with_execution_providers([ep::DirectML::default().with_device_id(device).build().error_on_failure()])?
            .commit_from_file(model)?,
        Ep::Cpu { threads, spinning } => b
            .with_intra_threads(threads)?
            .with_inter_threads(1)?
            .with_intra_op_spinning(spinning)?
            .commit_from_file(model)?,
    };
    Ok(s)
}

struct Model {
    session: Session,
    input: Tensor<f32>,
    input_name: String,
    output_name: String,
    lut: [f32; 256],
    lb: Letterbox,
}

impl Model {
    fn new(model: &Path, e: Ep) -> Res<Self> {
        let session = session(model, e)?;
        let input_name = session.inputs().first().map(|i| i.name().to_string()).ok_or("Modell ohne Eingang")?;
        let output_name = session.outputs().first().map(|i| i.name().to_string()).ok_or("Modell ohne Ausgang")?;
        let dims: Vec<i64> = session.inputs().first().and_then(|i| i.dtype().tensor_shape()).map(|s| s.iter().copied().collect()).unwrap_or_default();
        let lb = match dims.as_slice() {
            [1, 3, h, w] if *h > 0 && *w > 0 => Letterbox::new(usize::try_from(*w)?, usize::try_from(*h)?),
            d => return Err(format!("unerwartete Eingabeform {d:?}").into()),
        };
        let input = Tensor::from_array(([1_usize, 3, lb.in_h, lb.in_w], vec![0.0_f32; 3 * lb.in_h * lb.in_w]))?;
        let mut lut = [0.0_f32; 256];
        for (i, v) in lut.iter_mut().enumerate() {
            *v = (i as f64 / 255.0) as f32;
        }
        Ok(Self { session, input, input_name, output_name, lut, lb })
    }

    /// One run; returns the raw output [C, A] flattened, its channel and anchor count, and the
    /// times of preprocessing and inference (the latter with the output copied back).
    fn run(&mut self, ir: &[u8]) -> Res<(Vec<f32>, usize, usize, Duration, Duration)> {
        let t0 = Instant::now();
        let (_, x) = self.input.extract_tensor_mut();
        preprocess(ir, x, &self.lut, &self.lb);
        let t1 = Instant::now();
        let outputs = self.session.run(ort::inputs![self.input_name.as_str() => &self.input])?;
        let out = outputs.get(self.output_name.as_str()).ok_or("keine Ausgabe")?;
        let (shape, data) = out.try_extract_tensor::<f32>()?;
        let dims: Vec<i64> = shape.iter().copied().collect();
        let (channels, anchors) = match dims.as_slice() {
            [1, c, a] => (usize::try_from(*c)?, usize::try_from(*a)?),
            d => return Err(format!("unerwartete Ausgabeform {d:?}").into()),
        };
        let data = data.to_vec();
        Ok((data, channels, anchors, t1 - t0, t1.elapsed()))
    }
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// median, p90, min of times in ms
fn stats(v: &[f64]) -> (f64, f64, f64) {
    let mut s = v.to_vec();
    s.sort_by(f64::total_cmp);
    let q = |f: f64| s.get(((s.len().saturating_sub(1)) as f64 * f).round() as usize).copied().unwrap_or(f64::NAN);
    (q(0.5), q(0.9), s.first().copied().unwrap_or(f64::NAN))
}

fn bench(o: &Opts, e: Ep, frames: &[Frame]) -> Res<()> {
    let t0 = Instant::now();
    let mut m = Model::new(&o.model, e)?;
    let load_ms = ms(t0.elapsed());
    let first = frames.first().ok_or("kein Bild")?;
    let t1 = Instant::now();
    m.run(&first.ir)?;
    let first_ms = ms(t1.elapsed());
    for k in 1..o.warmup {
        let f = frames.get(k % frames.len()).unwrap_or(first);
        m.run(&f.ir)?;
    }
    println!(
        "{e:<9} Modell geladen in {load_ms:.0} ms, erster Lauf {first_ms:.0} ms ({}, Eingang {}x{})",
        o.model.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
        m.lb.in_w,
        m.lb.in_h
    );

    if o.compare {
        for f in frames {
            let (out, channels, anchors, _, _) = m.run(&f.ir)?;
            compare(f, &out, channels, anchors, &m.lb);
        }
    }

    // the timed runs: back to back, as the pose worker does when it is never idle (or paced with --hz)
    let sampler = match (o.load, o.seconds) {
        (true, Some(s)) if s >= 4.0 => Some(
            Command::new("powershell")
                .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("load.ps1"))
                .args(["-Seconds", &format!("{}", (s - 2.0).floor()), "-Top", "6", "-Hub", &format!("http://{}", o.hub)])
                .stdout(std::process::Stdio::piped())
                .spawn()?,
        ),
        _ => None,
    };
    let hub0 = hub_frames(&o.hub);
    let cpu0 = cpu_time();
    let start = Instant::now();
    let (mut pre, mut run, mut post) = (Vec::new(), Vec::new(), Vec::new());
    let mut found = 0;
    let mut k = 0;
    let mut due = start;
    loop {
        let done = match o.seconds {
            Some(s) => start.elapsed().as_secs_f64() >= s,
            None => k >= o.runs,
        };
        if done {
            break;
        }
        if let Some(hz) = o.hz {
            // paced like a tracker that wants a pose every 1/hz s; a late run is not made up for
            if let Some(wait) = due.checked_duration_since(Instant::now()) {
                std::thread::sleep(wait);
            }
            due = (due + Duration::from_secs_f64(1.0 / hz)).max(Instant::now());
        }
        let f = frames.get(k % frames.len()).unwrap_or(first);
        let (out, channels, anchors, p, r) = m.run(&f.ir)?;
        let t = Instant::now();
        found += decode(&out, channels, anchors, &m.lb).len();
        post.push(ms(t.elapsed()));
        pre.push(ms(p));
        run.push(ms(r));
        k += 1;
    }
    let wall = start.elapsed();
    let cpu = cpu_time().saturating_sub(cpu0);
    let hub1 = hub_frames(&o.hub);
    let (rm, r90, rmin) = stats(&run);
    let total: Vec<f64> = pre.iter().zip(&run).zip(&post).map(|((a, b), c)| a + b + c).collect();
    let (tm, t90, _) = stats(&total);
    println!(
        "          {k} Läufe in {:.1} s: Vorbereitung {:.1} ms | Modell {rm:.1} ms (p90 {r90:.1}, min {rmin:.1}) | Auswertung {:.2} ms | gesamt {tm:.1} ms (p90 {t90:.1}) = {:.1} Hz, {:.1} Posen/Bild",
        wall.as_secs_f64(),
        stats(&pre).0,
        stats(&post).0,
        k as f64 / wall.as_secs_f64(),
        found as f64 / k.max(1) as f64,
    );
    let sensor = match (hub0, hub1) {
        (Some((a, ta)), Some((b, tb))) => format!(", Sensor am Hub {:.1} fps", (b.saturating_sub(a)) as f64 / (tb - ta).as_secs_f64()),
        _ => String::new(),
    };
    println!("          CPU dieses Prozesses {:.2} Kerne{sensor}", cpu.as_secs_f64() / wall.as_secs_f64());
    if let Some(child) = sampler {
        let out = child.wait_with_output()?;
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            println!("          | {line}");
        }
    }
    Ok(())
}

// ---- comparing with the browser ------------------------------------------------------------------

/// Compares this run with the browser's of the same frame (<name>.browser.f32 / .browser.txt from
/// web/tools/pose-ref.mjs, next to the frame).
fn compare(f: &Frame, out: &[f32], channels: usize, anchors: usize, lb: &Letterbox) {
    let Some(path) = &f.path else { return };
    let Ok(raw) = std::fs::read(path.with_extension("browser.f32")) else {
        println!("          {}: keine Browser-Referenz", f.name);
        return;
    };
    let reference: Vec<f32> = raw.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect();
    if reference.len() != out.len() {
        println!("          {}: Browser-Ausgabe hat {} Werte, nativ {}", f.name, reference.len(), out.len());
        return;
    }
    // raw output at the anchors that matter (score >= 0.1 in either run)
    let (s_nat, s_ref) = (chan(out, anchors, 4), chan(&reference, anchors, 4));
    let mut d_box = 0.0_f64;
    let mut d_score = 0.0_f64;
    let mut d_kp = 0.0_f64;
    let mut d_conf = 0.0_f64;
    let mut n = 0;
    for a in 0..anchors {
        let (sn, sr) = (at(s_nat, a), at(s_ref, a));
        d_score = d_score.max((sn - sr).abs());
        if sn.max(sr) < 0.1 {
            continue;
        }
        n += 1;
        let d = |c: usize| (at(chan(out, anchors, c), a) - at(chan(&reference, anchors, c), a)).abs();
        for c in 0..4 {
            d_box = d_box.max(d(c));
        }
        for k in 0..17 {
            d_kp = d_kp.max(d(5 + 3 * k)).max(d(6 + 3 * k));
            d_conf = d_conf.max(d(7 + 3 * k));
        }
    }
    let native = decode(out, channels, anchors, lb);
    let from_browser_raw = decode(&reference, channels, anchors, lb);
    let js = read_poses(&path.with_extension("browser.txt"));
    let pose_diff = |a: &[Pose], b: &[Pose]| -> String {
        let mut used = vec![false; b.len()];
        let (mut matched, mut d_s, mut d_b, mut d_k) = (0, 0.0_f64, 0.0_f64, 0.0_f64);
        for p in a {
            let best = b.iter().enumerate().filter(|(i, _)| !used.get(*i).copied().unwrap_or(true)).max_by(|x, y| iou(&p.bbox, &x.1.bbox).total_cmp(&iou(&p.bbox, &y.1.bbox)));
            let Some((i, q)) = best else { continue };
            if iou(&p.bbox, &q.bbox) < 0.5 {
                continue;
            }
            if let Some(u) = used.get_mut(i) {
                *u = true;
            }
            matched += 1;
            d_s = d_s.max((p.score - q.score).abs());
            for (x, y) in p.bbox.iter().zip(&q.bbox) {
                d_b = d_b.max((x - y).abs());
            }
            for ([u0, v0, c0], [u1, v1, c1]) in p.kp.as_chunks::<3>().0.iter().zip(q.kp.as_chunks::<3>().0) {
                if c0.min(*c1) >= 0.5 {
                    d_k = d_k.max(f64::from((u0 - u1).hypot(v0 - v1)));
                }
            }
        }
        format!("{}/{} Posen gleich zugeordnet (Browser {}), Δ Score {d_s:.4}, Box {d_b:.2} px, Gelenke {d_k:.2} px", matched, a.len(), b.len())
    };
    println!(
        "          {}: Rohausgabe an {n} Ankern max |Δ| Box {d_box:.3} px, Score {d_score:.4}, Gelenk {d_kp:.3} px, Gelenk-Konfidenz {d_conf:.4}",
        f.name
    );
    match js {
        Some(js) => {
            println!("          {}  nativ vs. Browser: {}", " ".repeat(f.name.len()), pose_diff(&native, &js));
            println!("          {}  Dekoder-Probe (Browser-Rohausgabe hier dekodiert vs. persons-pose.js): {}", " ".repeat(f.name.len()), pose_diff(&from_browser_raw, &js));
        }
        None => println!("          {}  nativ vs. Browser-Rohausgabe dekodiert: {}", " ".repeat(f.name.len()), pose_diff(&native, &from_browser_raw)),
    }
}

/// Poses as pose-ref.mjs writes them: per line score, box (4), 17 x (u, v, confidence).
fn read_poses(path: &Path) -> Option<Vec<Pose>> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut poses = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let v: Vec<f64> = line.split_whitespace().map(str::parse).collect::<Result<_, _>>().ok()?;
        let (Some(score), Some(b), Some(k)) = (v.first(), v.get(1..5), v.get(5..56)) else { return None };
        let mut kp = [0.0_f32; 51];
        for (d, s) in kp.iter_mut().zip(k) {
            *d = *s as f32;
        }
        poses.push(Pose { score: *score, bbox: [*b.first()?, *b.get(1)?, *b.get(2)?, *b.get(3)?], kp });
    }
    Some(poses)
}

/// The middle infrared frame of a recording (.k2rec, format in kinect-hub/README.md).
fn middle_ir(path: &Path) -> Res<Vec<u8>> {
    let data = std::fs::read(path)?;
    let u32_at = |at: usize| data.get(at..at + 4).and_then(|b| <[u8; 4]>::try_from(b).ok()).map(u32::from_le_bytes);
    let u16_at = |at: usize| data.get(at..at + 2).and_then(|b| <[u8; 2]>::try_from(b).ok()).map(u16::from_le_bytes);
    if data.get(..4) != Some(b"K2RC".as_slice()) {
        return Err("keine .k2rec-Aufnahme".into());
    }
    // frames: 24-byte head (magic "K2RF", seq, time, flags, reserved, payload length), then the payload
    let mut frames = Vec::new();
    let mut at = usize::try_from(u32_at(8).ok_or("Kopf zu kurz")?)?;
    while let (Some(magic), Some(flags), Some(len)) = (data.get(at..at + 4), u16_at(at + 16), u32_at(at + 20)) {
        if magic != b"K2RF" {
            return Err(format!("kaputtes Frame bei Byte {at}").into());
        }
        let len = usize::try_from(len)?;
        if flags & 1 == 1 && len == W * H * 3 {
            frames.push(at + 24 + W * H * 2); // depth (u16) first, then the infrared bytes
        }
        at += 24 + len;
    }
    let start = frames.get(frames.len() / 2).copied().ok_or("kein Frame mit Infrarot")?;
    Ok(data.get(start..start + W * H).ok_or("abgeschnittenes Frame")?.to_vec())
}

fn main() {
    if let Err(e) = real_main() {
        eprintln!("Fehler: {e}");
        std::process::exit(1);
    }
}

fn real_main() -> Res<()> {
    let o = opts()?;
    if let Some((dir, recordings)) = &o.extract {
        std::fs::create_dir_all(dir)?;
        for r in recordings {
            let ir = middle_ir(r).map_err(|e| format!("{}: {e}", r.display()))?;
            let name = r.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let out = dir.join(format!("{name}.bin"));
            std::fs::write(&out, ir)?;
            println!("{}", out.display());
        }
        return Ok(());
    }
    ort::init_from(&o.dylib).map_err(|e| format!("{}: {e}", o.dylib.display()))?.commit();
    let frames = frames(&o)?;
    println!(
        "{} Bild(er), Modell {}, ONNX Runtime {}",
        frames.len(),
        o.model.display(),
        o.dylib.display()
    );
    for e in &o.eps {
        if let Err(err) = bench(&o, *e, &frames) {
            println!("{e:<9} Fehler: {err}");
        }
    }
    Ok(())
}
