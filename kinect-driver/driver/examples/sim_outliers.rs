//! What the wrong pixels of the extended decoder in a simulator scene are: how far off (a few
//! percent: multipath or noise; whole periods: wrong unwrapping), their flags and confidence.
//!   cargo run --release -p kinect-driver --example sim_outliers -- [SCENE] [--frames N] [--tof key=value,...]
#![allow(clippy::indexing_slicing, clippy::unwrap_used, clippy::expect_used)]

use kinect_driver::consts::{PIXELS, WIDTH};
use kinect_driver::sim::{Scene, SimConfig, Simulator};
use kinect_driver::tof::{CpuDecoder, TofConfig, TofOutput, flags};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let (mut scene, mut frames, mut tof) = ("hall".to_string(), 2u32, String::new());
    while let Some(a) = args.next() {
        match a.as_str() {
            "--frames" => frames = args.next().ok_or("--frames N")?.parse()?,
            "--tof" => tof = args.next().ok_or("--tof key=value")?,
            s => scene = s.to_string(),
        }
    }
    let mut cfg = TofConfig::extended();
    if !tof.is_empty() {
        cfg.apply(&tof)?;
    }
    let mut sim = Simulator::new(SimConfig::default())?;
    let tables = sim.tables().clone();
    let mut de = CpuDecoder::new(cfg)?;
    let mut out = TofOutput::new();
    // off by: < 10 %, 10-30 %, a period or more (>= 30 %); flags of each
    let names = ["5-10 %", "10-30 %", ">= 30 %"];
    let mut n = [0u64; 3];
    let mut fl = [[0u64; 5]; 3];
    let mut conf = [0f64; 3];
    let mut near = [0u64; 3];
    for f in 0..frames {
        let s = Scene::preset(&scene, f as f32 * 0.5).ok_or("unknown scene")?;
        let (p, gt) = sim.frame(&s, f);
        de.decode(&p, &tables, &mut out)?;
        for i in 0..PIXELS {
            let (t, d) = (gt.depth[i], out.depth[i]);
            if t <= 0.0 || d <= 0.0 || gt.mixed[i] || i % WIDTH == 0 || i % WIDTH == WIDTH - 1 {
                continue;
            }
            let rel = (d - t) / t;
            if (d - t).abs() <= (0.05 * t).max(100.0) {
                continue;
            }
            let k = if rel.abs() < 0.1 { 0 } else if rel.abs() < 0.3 { 1 } else { 2 };
            n[k] += 1;
            near[k] += u64::from(rel < 0.0);
            conf[k] += f64::from(out.confidence[i]);
            let g = out.flags[i];
            for (j, b) in [flags::MULTIPATH, flags::RESOLVED, flags::PLAUSIBILITY, flags::SATURATED_ANY, flags::DEPTH_FILLED].into_iter().enumerate() {
                fl[k][j] += u64::from(g & b != 0);
            }
        }
    }
    println!("scene {scene}, {frames} frames: wrong pixels (more than 5 % / 100 mm off) per frame");
    println!("  off by      n/frame  nearer  conf   MULTIPATH RESOLVED PLAUS SATURATED FILLED");
    for k in 0..3 {
        let m = n[k].max(1) as f64;
        println!(
            "  {:<9} {:>8.1} {:>6.0}% {:>5.2} {:>9.0}% {:>7.0}% {:>4.0}% {:>8.0}% {:>5.0}%",
            names[k],
            n[k] as f64 / f64::from(frames),
            100.0 * near[k] as f64 / m,
            conf[k] / m,
            100.0 * fl[k][0] as f64 / m,
            100.0 * fl[k][1] as f64 / m,
            100.0 * fl[k][2] as f64 / m,
            100.0 * fl[k][3] as f64 / m,
            100.0 * fl[k][4] as f64 / m
        );
    }
    Ok(())
}
