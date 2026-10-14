//! Compares the decoder output of two builds pixel by pixel: for changes that may change the
//! result only by rounding (faster approximations, smaller intermediate values).
//!
//!   cargo run --release -p kinect-driver --example tof_diff -- dump DIR [SEED]  (once per build)
//!   cargo run --release -p kinect-driver --example tof_diff -- compare OLD NEW
//!
//! The frames come from the simulator (every scene preset, a lost sub-image, damaged rows), so
//! both builds see the same input. `KINECT_DRIVER_SIMD=baseline` dumps the SSE2 build: comparing
//! it with the AVX2 dump of the same build shows what rounding alone changes; another SEED
//! (other sensor noise on the same scenes) shows how much the noise alone changes.
#![allow(clippy::indexing_slicing, clippy::unwrap_used, clippy::expect_used, clippy::needless_range_loop)]

use std::path::{Path, PathBuf};

use kinect_driver::RawDepthPacket;
use kinect_driver::consts::PIXELS;
use kinect_driver::packet::BadRows;
use kinect_driver::sim::{Scene, SimConfig, Simulator};
use kinect_driver::tof::{CpuDecoder, TofConfig, TofOutput};

/// (name, packet) of every test frame, and the simulator that made them (its tables).
type Cases = (Vec<(String, RawDepthPacket)>, Simulator);

fn cases(seed: u64) -> Result<Cases, Box<dyn std::error::Error>> {
    let mut sim = Simulator::new(SimConfig { seed, ..SimConfig::default() })?;
    let mut out = Vec::new();
    for name in Scene::PRESETS {
        for f in 0..2u32 {
            let scene = Scene::preset(name, f as f32 * 0.4).ok_or("scene")?;
            let (p, _) = sim.frame(&scene, f + 1);
            out.push((format!("{name}-{f}"), p));
        }
    }
    let room = Scene::preset("room", 0.2).ok_or("scene")?;
    let (mut p, _) = sim.frame(&room, 9);
    p.present &= !(1 << 4);
    p.subimage_mut(4).ok_or("sub-image")?.fill(0);
    out.push(("room-lost4".into(), p));
    let visitor = Scene::preset("visitor", 0.6).ok_or("scene")?;
    let (mut p, _) = sim.frame(&visitor, 10);
    let mut bad = BadRows::default();
    for r in (40..380).step_by(37) {
        bad.mark(r % 9, r);
        bad.mark((r + 3) % 9, r + 1);
    }
    p.bad_rows = Some(Box::new(bad));
    out.push(("visitor-badrows".into(), p));
    Ok((out, sim))
}

fn write_planes(path: &Path, o: &TofOutput) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(PIXELS * 16);
    for v in o.depth.iter().chain(&o.ir).chain(&o.confidence) {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    for v in &o.flags {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(path, buf)
}

struct Planes {
    depth: Vec<f32>,
    ir: Vec<f32>,
    conf: Vec<f32>,
    flags: Vec<u32>,
}

fn read_planes(path: &Path) -> std::io::Result<Planes> {
    let b = std::fs::read(path)?;
    let word = |i: usize| [b[4 * i], b[4 * i + 1], b[4 * i + 2], b[4 * i + 3]];
    let f = |plane: usize| (0..PIXELS).map(|i| f32::from_le_bytes(word(plane * PIXELS + i))).collect::<Vec<_>>();
    Ok(Planes { depth: f(0), ir: f(1), conf: f(2), flags: (0..PIXELS).map(|i| u32::from_le_bytes(word(3 * PIXELS + i))).collect() })
}

fn dump(dir: &Path, seed: u64) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::create_dir_all(dir)?;
    let (cases, sim) = cases(seed)?;
    for (mode, cfg) in [("compat", TofConfig::compat()), ("extended", TofConfig::extended())] {
        let mut dec = CpuDecoder::new(cfg)?;
        let mut out = TofOutput::new();
        for (name, p) in &cases {
            dec.decode(p, sim.tables(), &mut out)?;
            write_planes(&dir.join(format!("{name}.{mode}.bin")), &out)?;
        }
        println!("{mode}: {} frames, {}", cases.len(), dec.describe());
    }
    Ok(())
}

#[derive(Default)]
struct Diff {
    frames: u32,
    both: u64,
    sum_abs: f64,
    max_abs: f32,
    over_01: u64,
    over_1: u64,
    old_only: u64,
    new_only: u64,
    ir_max_rel: f32,
    ir_sum_rel: f64,
    ir_n: u64,
    conf_max: f32,
    flags_differ: u64,
    /// pixels per flag bit that differ
    bits: [u64; 32],
    /// confidence of the pixels with depth in one output only (in the one that has it), 0.1 bins
    flip_conf: [u64; 11],
}

impl Diff {
    fn add(&mut self, a: &Planes, b: &Planes) {
        self.frames += 1;
        for i in 0..PIXELS {
            let (da, db) = (a.depth[i], b.depth[i]);
            match (da > 0.0, db > 0.0) {
                (true, true) => {
                    let d = (da - db).abs();
                    self.both += 1;
                    self.sum_abs += f64::from(d);
                    self.max_abs = self.max_abs.max(d);
                    self.over_01 += u64::from(d > 0.1);
                    self.over_1 += u64::from(d > 1.0);
                    self.conf_max = self.conf_max.max((a.conf[i] - b.conf[i]).abs());
                }
                (true, false) => {
                    self.old_only += 1;
                    self.flip_conf[((a.conf[i] * 10.0) as usize).min(10)] += 1;
                }
                (false, true) => {
                    self.new_only += 1;
                    self.flip_conf[((b.conf[i] * 10.0) as usize).min(10)] += 1;
                }
                (false, false) => {}
            }
            let (ia, ib) = (a.ir[i], b.ir[i]);
            let rel = (ia - ib).abs() / ia.abs().max(10.0);
            self.ir_max_rel = self.ir_max_rel.max(rel);
            self.ir_sum_rel += f64::from(rel);
            self.ir_n += 1;
            self.flags_differ += u64::from(a.flags[i] != b.flags[i]);
            let x = a.flags[i] ^ b.flags[i];
            for (bit, n) in self.bits.iter_mut().enumerate() {
                *n += u64::from(x >> bit & 1);
            }
        }
    }

    fn line(&self, name: &str) -> String {
        let per = |v: u64| v as f64 / f64::from(self.frames.max(1));
        format!(
            "{name:<22} {:>9.0} {:>9.5} {:>8.4} {:>8.1} {:>7.1} {:>8.1} {:>8.1} {:>9.1e} {:>9.1e} {:>7.4} {:>8.1}",
            per(self.both),
            self.sum_abs / self.both.max(1) as f64,
            self.max_abs,
            per(self.over_01),
            per(self.over_1),
            per(self.old_only),
            per(self.new_only),
            self.ir_sum_rel / self.ir_n.max(1) as f64,
            self.ir_max_rel,
            self.conf_max,
            per(self.flags_differ),
        )
    }
}

fn compare(old: &Path, new: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut names: Vec<PathBuf> = std::fs::read_dir(old)?.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "bin")).collect();
    names.sort();
    println!("per frame: pixels with depth in both, mean and max |depth diff| (mm), pixels > 0.1 mm and > 1 mm,");
    println!("depth only in the old / only in the new output, infrared mean and max relative diff, max confidence diff, pixels with other flags");
    for mode in ["compat", "extended"] {
        println!(
            "\n{:<22} {:>9} {:>9} {:>8} {:>8} {:>7} {:>8} {:>8} {:>9} {:>9} {:>7} {:>8}",
            mode, "both", "mean", "max", ">0.1mm", ">1mm", "old only", "new only", "ir mean", "ir max", "conf", "flags"
        );
        let mut total = Diff::default();
        for p in names.iter().filter(|p| p.to_string_lossy().ends_with(&format!(".{mode}.bin"))) {
            let file = p.file_name().ok_or("name")?;
            let (a, b) = (read_planes(p)?, read_planes(&new.join(file))?);
            let mut d = Diff::default();
            d.add(&a, &b);
            total.add(&a, &b);
            let case = file.to_string_lossy().split('.').next().unwrap_or("").to_string();
            println!("{}", d.line(&case));
        }
        println!("{}", total.line("all frames"));
        let names = kinect_driver_flag_names();
        let differ: Vec<String> = total.bits.iter().enumerate().filter(|(_, n)| **n > 0).map(|(b, n)| format!("{} {:.1}", names.get(b).copied().unwrap_or("?"), *n as f64 / f64::from(total.frames))).collect();
        if !differ.is_empty() {
            println!("  flags that differ, pixels per frame: {}", differ.join(", "));
        }
        if total.old_only + total.new_only > 0 {
            let h: Vec<String> = total.flip_conf.iter().enumerate().filter(|(_, n)| **n > 0).map(|(b, n)| format!("{:.1}: {n}", b as f32 / 10.0)).collect();
            println!("  confidence of the pixels with depth in one output only: {}", h.join(", "));
        }
    }
    Ok(())
}

fn kinect_driver_flag_names() -> [&'static str; 19] {
    [
        "SATURATED_80",
        "SATURATED_16",
        "SATURATED_120",
        "REPAIRED_80",
        "REPAIRED_16",
        "REPAIRED_120",
        "IR_FILLED",
        "SINGLE_FREQUENCY",
        "RESOLVED",
        "EDGE",
        "LOW_CONFIDENCE",
        "DATA_LOST",
        "OUT_OF_RANGE",
        "NEAR_PRIOR",
        "WEAK_BOOSTED",
        "NO_SIGNAL",
        "DEPTH_FILLED",
        "SPECKLE",
        "PLAUSIBILITY",
    ]
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    match (args.get(1).map(String::as_str), args.get(2), args.get(3)) {
        (Some("dump"), Some(dir), seed) => dump(Path::new(dir), seed.and_then(|s| s.parse().ok()).unwrap_or(11)),
        (Some("compare"), Some(a), Some(b)) => compare(Path::new(a), Path::new(b)),
        _ => Err("usage: tof_diff dump DIR [SEED] | tof_diff compare OLD NEW".into()),
    }
}
