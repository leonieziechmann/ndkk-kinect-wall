//! Writes simulated raw recordings (for comparing decoders, e.g. with fn2/depth_bench or the
//! reference harness in tools/).
//!
//!   cargo run --release -p kinect-driver --example sim_k2raw -- OUT.k2raw [scene] [frames] [seed]
#![allow(clippy::indexing_slicing, clippy::unwrap_used, clippy::expect_used, clippy::needless_range_loop)]

use kinect_driver::record::{RawHeader, RawWriter};
use kinect_driver::sim::{Scene, SimConfig, Simulator};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let out = args.get(1).ok_or("usage: sim_k2raw OUT.k2raw [scene] [frames] [seed]")?;
    let scene = args.get(2).map(String::as_str).unwrap_or("room");
    let frames: u32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(5);
    let seed: u64 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(1);
    let mut sim = Simulator::new(SimConfig { seed, ..Default::default() })?;
    let mut w = RawWriter::create(std::path::Path::new(out), &RawHeader::from_tables(sim.tables()))?;
    for seq in 0..frames {
        let s = Scene::preset(scene, seq as f32 / 30.0).ok_or("unknown scene")?;
        let (p, _) = sim.frame(&s, seq);
        w.write(&p)?;
    }
    w.finish()?;
    eprintln!("{frames} frames of '{scene}' -> {out}");
    Ok(())
}
