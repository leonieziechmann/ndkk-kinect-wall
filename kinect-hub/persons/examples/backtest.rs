//! The Rust tracker over a recording, exactly like recordings/backtest/backtest.mjs runs the
//! JavaScript one: a pose run starts on the newest frame when the model is free and its result
//! arrives LAT frames later; the same measures, the same output lines (tag "rs" unless TAG is set).
//!
//!   cargo run --release --example backtest -- <dir>/work/<name> [poses.json]
//!
//! Reads <name>.depth / .ir / _lut.npy (python k2rec.py) and the reference poses
//! (<dir>/poses/<name>.poses.json, python poses.py). env: MODE=hybrid|live, LAT=4, SKIP=1, FROM, TO,
//! MAXD=12, TAG, CFG (JSON of options by their JavaScript names, e.g. '{"mode":"skeleton"}').
//! The recordings show people: they stay in recordings/ (not in git).

use std::path::{Path, PathBuf};
use std::time::Instant;

use persons::{FrameResult, N, OptionValue, Options, PersonTracker, PoseIn, STAGES};

type Res<T> = Result<T, Box<dyn std::error::Error>>;

fn env_num(k: &str, d: f64) -> f64 {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

/// f32 [424, 512, 2] from an .npy file (v1 or v2 header).
fn load_lut(path: &Path) -> Res<Vec<f32>> {
    let b = std::fs::read(path)?;
    let major = *b.get(6).ok_or("short npy")?;
    let (hlen, off) = if major == 1 {
        (usize::from(u16::from_le_bytes([b[8], b[9]])), 10)
    } else {
        (u32::from_le_bytes([b[8], b[9], b[10], b[11]]) as usize, 12)
    };
    let header = String::from_utf8_lossy(&b[off..off + hlen]);
    if !header.contains("<f4") {
        return Err(format!("{}: not f4", path.display()).into());
    }
    Ok(b[off + hlen..].as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect())
}

/// The poses per frame; None where the model did not run (null, as the JavaScript skips it).
fn load_poses(path: &Path) -> Res<Vec<Option<Vec<PoseIn>>>> {
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(path)?)?;
    let frames = v.as_array().ok_or("poses: not an array")?;
    let num = |v: &serde_json::Value| v.as_f64().unwrap_or(0.0);
    Ok(frames
        .iter()
        .map(|f| {
            f.as_array()
                .map(|list| {
                    list.iter()
                        .map(|p| {
                            let mut kp = [0.0_f32; 51];
                            if let Some(a) = p.get("kp").and_then(|k| k.as_array()) {
                                for (d, s) in kp.iter_mut().zip(a) {
                                    *d = num(s) as f32;
                                }
                            }
                            let bx = p.get("box").and_then(|b| b.as_array());
                            let b = |i: usize| bx.and_then(|b| b.get(i)).map_or(0.0, num);
                            PoseIn { score: p.get("score").map_or(0.0, num), bbox: [b(0), b(1), b(2), b(3)], kp }
                        })
                        .collect()
                })
        })
        .collect())
}

struct Out {
    labels: Vec<u8>,
    depth: Vec<u16>,
    indices: Vec<u32>,
}

impl Out {
    fn new() -> Out {
        Out { labels: vec![0; N], depth: vec![0; N], indices: vec![0; N] }
    }
}

struct Held {
    seq: i64,
    f: usize,
    r: FrameResult,
    out: Out,
    ms: f64,
}

#[derive(Default)]
struct Measure {
    sum: f64,
    max: f64,
    frames: u32,
    flick: Vec<(usize, f64)>,
    ids: std::collections::BTreeSet<u32>,
    kp: Vec<f64>,
    kp_w: Vec<f64>,
    kp_a: Vec<f64>,
    person_frames: u64,
    person_pixels: u64,
    prev: Option<(Vec<u8>, usize)>,
}

impl Measure {
    #[allow(clippy::too_many_arguments)]
    fn add(&mut self, seq: i64, f: usize, r: &FrameResult, labels: &[u8], depth_all: &[u16], poses: &[Option<Vec<PoseIn>>], ms: f64) {
        let depth = &depth_all[f * N..(f + 1) * N];
        if seq > 5 {
            self.sum += ms;
            self.max = self.max.max(ms);
            self.frames += 1;
        }
        for p in &r.persons {
            self.ids.insert(p.id);
        }
        // skeleton accuracy: output keypoints vs the pose model run on this very frame
        if let Some(ref_poses) = poses.get(f).and_then(Option::as_ref).filter(|p| !p.is_empty()) {
            for p in r.persons.iter().filter(|p| p.visible) {
                let mut best: Option<(f64, Vec<(usize, f64)>)> = None;
                for q in ref_poses {
                    let mut errs = Vec::new();
                    for k in 0..17 {
                        if f64::from(q.kp[3 * k + 2]) < 0.5 || p.keypoints[k][2] < 0.35 {
                            continue;
                        }
                        let e = (f64::from(q.kp[3 * k]) - p.keypoints[k][0]).hypot(f64::from(q.kp[3 * k + 1]) - p.keypoints[k][1]);
                        errs.push((k, e));
                    }
                    if errs.is_empty() {
                        continue;
                    }
                    let mut s: Vec<f64> = errs.iter().map(|e| e.1).collect();
                    s.sort_by(f64::total_cmp);
                    let med = s[s.len() >> 1];
                    if med < 60.0 && best.as_ref().is_none_or(|b| med < b.0) {
                        best = Some((med, errs));
                    }
                }
                if let Some((_, errs)) = best {
                    for (k, e) in errs {
                        self.kp.push(e);
                        if (9..=10).contains(&k) {
                            self.kp_w.push(e);
                        }
                        if k >= 15 {
                            self.kp_a.push(e);
                        }
                    }
                }
            }
        }
        // flicker against the previous frame
        if let Some((prev, pf)) = &self.prev {
            let prev_depth = &depth_all[pf * N..(pf + 1) * N];
            let (mut changed, mut persons) = (0_u64, 0_u64);
            for i in 0..N {
                let (a, b) = (labels[i], prev[i]);
                if a != 0 {
                    persons += 1;
                }
                if a == b {
                    continue;
                }
                let (d, e) = (f64::from(depth[i]), f64::from(prev_depth[i]));
                if d == 0.0 || e == 0.0 {
                    continue;
                }
                if (d - e).abs() < 30.0 + 0.01 * d {
                    changed += 1;
                }
            }
            if persons > 500 {
                self.flick.push((f, changed as f64 / persons as f64));
                self.person_frames += 1;
                self.person_pixels += persons;
            }
        }
        self.prev = Some((labels.to_vec(), f));
    }
}

fn q(a: &[f64], x: f64) -> String {
    let mut s = a.to_vec();
    s.sort_by(f64::total_cmp);
    if s.is_empty() {
        return "-".into();
    }
    format!("{:.1}", s[((x * s.len() as f64).floor() as usize).min(s.len() - 1)])
}

fn main() {
    if let Err(e) = run() {
        eprintln!("Fehler: {e}");
        std::process::exit(1);
    }
}

fn run() -> Res<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let name = PathBuf::from(args.first().ok_or("usage: backtest <dir>/work/<name> [poses.json]")?);
    let base = name.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let with_ext = |ext: &str| PathBuf::from(format!("{}{ext}", name.display()));
    let poses_file = match args.get(1) {
        Some(p) => PathBuf::from(p),
        None => name.parent().and_then(Path::parent).map(|d| d.join("poses").join(format!("{base}.poses.json"))).ok_or("no poses")?,
    };
    let lat = env_num("LAT", 4.0) as i64;
    let skip = env_num("SKIP", 1.0) as usize;
    let maxd = env_num("MAXD", 12.0) as i64;
    let mode = std::env::var("MODE").unwrap_or_else(|_| "hybrid".into());
    let tag = std::env::var("TAG").unwrap_or_else(|_| "rs".into());
    let live = match mode.as_str() {
        "hybrid" => false,
        "live" => true,
        m => return Err(format!("MODE={m}: use hybrid or live").into()),
    };
    let t_load = Instant::now();
    let depth_bytes = std::fs::read(with_ext(".depth"))?;
    let depth: Vec<u16> = depth_bytes.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect();
    drop(depth_bytes);
    let ir = std::fs::read(with_ext(".ir"))?;
    let lut = load_lut(&with_ext("_lut.npy"))?;
    let poses = load_poses(&poses_file)?;
    let frames_total = depth.len() / N;
    let from = env_num("FROM", 0.0) as usize;
    let to = (env_num("TO", frames_total as f64) as usize).min(frames_total);
    eprintln!("{base}: {frames_total} frames, loaded in {:.1} s", t_load.elapsed().as_secs_f64());

    let mut opts = Options::default();
    if let Ok(cfg) = std::env::var("CFG") {
        let v: serde_json::Value = serde_json::from_str(&cfg)?;
        for (k, v) in v.as_object().ok_or("CFG: not an object")? {
            let val = match v {
                serde_json::Value::Bool(b) => OptionValue::Bool(*b),
                serde_json::Value::String(s) => OptionValue::Text(s.clone()),
                other => OptionValue::Number(other.as_f64().unwrap_or(0.0)),
            };
            if !opts.set(k, val) {
                return Err(format!("CFG: unknown option {k}").into());
            }
        }
    }
    let mut t = PersonTracker::new(opts);
    t.set_rays(&lut);
    let mut outs = [Out::new(), Out::new()];
    let mut pending: Option<(i64, i64, usize)> = None; // seq, due, frame of the poses
    let mut held: Vec<Held> = Vec::new();
    let mut pool: Vec<Out> = Vec::new();
    let mut prev_out: Option<Out> = None;
    let mut posed_up_to: i64 = -1;
    let (mut delay_sum, mut delay_n) = (0_i64, 0_i64);
    let mut m = Measure::default();
    let mut stage_sum = [0.0_f64; 8];
    let ir_of = |f: usize| if std::env::var_os("NOIR").is_some() { None } else { ir.get(f * N..(f + 1) * N) };
    let mut seq: i64 = 0;
    let mut fa = from;
    let t_run = Instant::now();
    while fa < to {
        let aseq = seq;
        if let Some((pseq, due, pf)) = pending
            && aseq >= due
        {
            t.set_poses(poses[pf].as_deref().unwrap_or(&[]), Some(pseq));
            posed_up_to = pseq;
            pending = None;
        }
        // a frame with an entry had a pose run, also one that found nobody (as in the JavaScript)
        if pending.is_none() && poses.get(fa).is_some_and(Option::is_some) {
            t.mark_pose_frame(aseq);
            pending = Some((aseq, aseq + lat.max(0), fa));
            if lat == 0 {
                t.set_poses(poses[fa].as_deref().unwrap_or(&[]), Some(aseq));
                posed_up_to = aseq;
                pending = None;
            }
        }
        let d = &depth[fa * N..(fa + 1) * N];
        if live {
            let out = &mut outs[(aseq & 1) as usize];
            let t0 = Instant::now();
            let r = t.process(d, &mut out.labels, &mut out.depth, &mut out.indices, aseq, ir_of(fa));
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            for (a, b) in stage_sum.iter_mut().zip(r.stages) {
                *a += b;
            }
            delay_n += 1;
            m.add(aseq, fa, &r, &out.labels, &depth, &poses, ms);
        } else {
            // hybrid: segmented at once, the skeletons made exact once a later pose is in
            let mut out = pool.pop().unwrap_or_else(Out::new);
            let t0 = Instant::now();
            let r = t.process(d, &mut out.labels, &mut out.depth, &mut out.indices, aseq, ir_of(fa));
            for (a, b) in stage_sum.iter_mut().zip(r.stages) {
                *a += b;
            }
            held.push(Held { seq: aseq, f: fa, r, out, ms: t0.elapsed().as_secs_f64() * 1000.0 });
            while held.first().is_some_and(|h| h.seq <= posed_up_to || aseq - h.seq >= maxd) {
                let mut h = held.remove(0);
                let t1 = Instant::now();
                t.finalize(&mut h.r, h.seq, &depth[h.f * N..(h.f + 1) * N], &h.out.labels);
                delay_sum += aseq - h.seq;
                delay_n += 1;
                let ms = h.ms + t1.elapsed().as_secs_f64() * 1000.0;
                m.add(h.seq, h.f, &h.r, &h.out.labels, &depth, &poses, ms);
                if let Some(p) = prev_out.replace(h.out) {
                    pool.push(p);
                }
            }
        }
        fa += skip;
        seq += 1;
    }
    let mut vs: Vec<f64> = m.flick.iter().map(|x| x.1).collect();
    vs.sort_by(f64::total_cmp);
    let pct = |x: f64| if vs.is_empty() { 0.0 } else { vs[((x * vs.len() as f64).floor() as usize).min(vs.len() - 1)] };
    let mean = vs.iter().sum::<f64>() / vs.len().max(1) as f64;
    let mut worst = m.flick.clone();
    worst.sort_by(|a, b| b.1.total_cmp(&a.1));
    let worst: Vec<String> = worst.iter().take(6).map(|(f, v)| format!("{f}:{:.1}%", 100.0 * v)).collect();
    let label = format!("{tag} {base}");
    println!(
        "{label} {mode} LAT={lat} SKIP={skip}: keypoints px: median {} p90 {} | wrists {}/{} | ankles {}/{} | delay {:.1} frames",
        q(&m.kp, 0.5),
        q(&m.kp, 0.9),
        q(&m.kp_w, 0.5),
        q(&m.kp_w, 0.9),
        q(&m.kp_a, 0.5),
        q(&m.kp_a, 0.9),
        delay_sum as f64 / delay_n.max(1) as f64
    );
    println!(
        "{label} LAT={lat} SKIP={skip}: flicker mean {:.2}% p90 {:.2}% p99 {:.2}% | avg persons px {} | ids {} | {:.1} ms (max {:.0}) | worst {}",
        100.0 * mean,
        100.0 * pct(0.9),
        100.0 * pct(0.99),
        (m.person_pixels as f64 / m.person_frames.max(1) as f64).round(),
        m.ids.len(),
        m.sum / f64::from(m.frames.max(1)),
        m.max,
        worst.join(" ")
    );
    eprintln!("{label}: {} frames in {:.1} s", seq, t_run.elapsed().as_secs_f64());
    let per: Vec<String> = STAGES.iter().zip(stage_sum).map(|(n, s)| format!("{n} {:.2}", s / seq.max(1) as f64)).collect();
    eprintln!("{label}: ms per frame by stage: {}", per.join(" | "));
    Ok(())
}
