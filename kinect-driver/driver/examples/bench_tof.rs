//! Decoding speed per phase: cargo run --release -p kinect-driver --example bench_tof -- FILE.k2raw [threads] [compat|extended]
#![allow(clippy::indexing_slicing, clippy::unwrap_used, clippy::expect_used, clippy::needless_range_loop)]

use kinect_driver::record::RawReader;
use kinect_driver::tof::{CpuDecoder, TofConfig, TofOutput};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let raw = args.get(1).ok_or("usage: bench_tof FILE.k2raw [threads] [compat|extended] [key=value,...]")?;
    let threads: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
    let mode = args.get(3).map(String::as_str).unwrap_or("compat");
    let mut reader = RawReader::open(std::path::Path::new(raw))?;
    let tables = reader.header().tables()?;
    let p = reader.next_packet()?.ok_or("empty recording")?;
    let mut cfg = if mode == "extended" { TofConfig::extended() } else { TofConfig::compat() };
    cfg.threads = threads;
    if let Some(settings) = args.get(4) {
        cfg.apply(settings)?;
    }
    let mut dec = CpuDecoder::new(cfg)?;
    let mut out = TofOutput::new();
    for _ in 0..5 {
        dec.decode(&p, &tables, &mut out)?;
    }
    let n = 40;
    let mut s = [0f64; 5];
    for _ in 0..n {
        dec.decode(&p, &tables, &mut out)?;
        let t = dec.timings;
        for (a, b) in s.iter_mut().zip([t.stage1_ms, t.stage2_ms, t.stage3_ms, t.fill_ms, t.total_ms]) {
            *a += b / n as f64;
        }
    }
    println!(
        "{mode}, {} threads, {}: {:.2} ms/frame (stage1 {:.2}, stage2 {:.2}, stage3 {:.2}, fill {:.2})",
        dec.threads(),
        kinect_driver::tof::simd::detected().name(),
        s[4],
        s[0],
        s[1],
        s[2],
        s[3]
    );
    Ok(())
}
