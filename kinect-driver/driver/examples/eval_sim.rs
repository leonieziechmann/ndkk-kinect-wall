//! Compat vs Extended against the simulator's ground truth.
//!   cargo run --release -p kinect-driver --example eval_sim -- [scene ...] [--frames N] [--seed S]
#![allow(clippy::indexing_slicing, clippy::unwrap_used, clippy::expect_used, clippy::needless_range_loop)]

use kinect_driver::sim::eval::Evaluation;
use kinect_driver::sim::{Scene, SimConfig, Simulator};
use kinect_driver::tof::{CpuDecoder, TofConfig, TofOutput};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut scenes = Vec::new();
    let mut frames = 3u32;
    let mut seed = 7u64;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--frames" => frames = args.next().and_then(|v| v.parse().ok()).unwrap_or(3),
            "--seed" => seed = args.next().and_then(|v| v.parse().ok()).unwrap_or(7),
            s => scenes.push(s.to_string()),
        }
    }
    if scenes.is_empty() {
        scenes = ["room", "near", "far", "ramp", "hall"].iter().map(|s| s.to_string()).collect();
    }
    for name in &scenes {
        let mut sim = Simulator::new(SimConfig { seed, ..Default::default() })?;
        let tables = sim.tables().clone();
        let mut compat = CpuDecoder::new(TofConfig::compat())?;
        let mut ext = CpuDecoder::new(TofConfig::extended())?;
        let (mut ec, mut ee) = (Evaluation::default(), Evaluation::default());
        let (mut oc, mut oe) = (TofOutput::new(), TofOutput::new());
        for f in 0..frames {
            let scene = Scene::preset(name, f as f32 * 0.5).ok_or("unknown scene")?;
            let (p, gt) = sim.frame(&scene, f);
            compat.decode(&p, &tables, &mut oc)?;
            ext.decode(&p, &tables, &mut oe)?;
            ec.add(&gt, &oc);
            ee.add(&gt, &oe);
        }
        println!("=== scene '{name}', {frames} frames");
        print!("{}", ec.table("compat (libfreenect2)"));
        print!("{}", ee.table("extended"));
    }
    Ok(())
}
