//! How well the confidence separates right from wrong depth (extended mode): decode with no
//! confidence threshold, then sweep it.
//!   cargo run --release -p kinect-driver --example roc_sim -- SCENE [key=value,...]
#![allow(clippy::indexing_slicing, clippy::unwrap_used, clippy::expect_used, clippy::needless_range_loop)]

use kinect_driver::consts::{PIXELS, WIDTH};
use kinect_driver::sim::{Scene, SimConfig, Simulator};
use kinect_driver::tof::{CpuDecoder, TofConfig, TofOutput, flags};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let name = args.get(1).map(String::as_str).unwrap_or("far");
    let mut cfg = TofConfig::extended();
    cfg.ext.min_confidence = 0.0;
    if let Some(s) = args.get(2) {
        cfg.apply(s)?;
    }
    let mut sim = Simulator::new(SimConfig { seed: 7, ..Default::default() })?;
    let tables = sim.tables().clone();
    let mut dec = CpuDecoder::new(cfg)?;
    let mut out = TofOutput::new();
    // (confidence, right, wrong, truth band far)
    let mut samples: Vec<(f32, bool, bool)> = Vec::new();
    let mut truth_px = 0u64;
    let mut kinds = [0u64; 4];
    for f in 0..3 {
        let scene = Scene::preset(name, f as f32 * 0.5).ok_or("unknown scene")?;
        let (p, gt) = sim.frame(&scene, f);
        dec.decode(&p, &tables, &mut out)?;
        let (depth, conf) = (out.depth.to_vec(), out.confidence.to_vec());
        for i in 0..PIXELS {
            if gt.mixed[i] || i % WIDTH == 0 || i % WIDTH == WIDTH - 1 {
                continue;
            }
            let (t, d, c) = (gt.depth[i], depth[i], conf[i]);
            if t > 0.0 {
                truth_px += 1;
            }
            if d <= 0.0 {
                continue;
            }
            let fl = out.flags[i];
            kinds[usize::from(fl & flags::SINGLE_FREQUENCY != 0) + 2 * usize::from(fl & flags::RESOLVED != 0)] += 1;
            let right = t > 0.0 && (d - t).abs() <= (0.05 * t).max(100.0);
            let wrong = !right;
            samples.push((c, right, wrong));
        }
    }
    println!("scene {name}: {truth_px} truth pixels; delivered by kind (plain, single, resolved, single+resolved): {kinds:?}");
    println!("  min_conf  depth%   wrong% of truth  wrong% of delivered");
    for th in [0.0f32, 0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99] {
        let kept: Vec<_> = samples.iter().filter(|s| s.0 >= th).collect();
        let wrong = kept.iter().filter(|s| s.2).count();
        println!(
            "  {th:>7.2} {:>8.2} {:>10.3} {:>14.2}",
            100.0 * kept.len() as f64 / truth_px as f64,
            100.0 * wrong as f64 / truth_px as f64,
            100.0 * wrong as f64 / kept.len().max(1) as f64
        );
    }
    Ok(())
}
