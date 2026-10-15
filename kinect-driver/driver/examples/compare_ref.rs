//! Compares the Compat decoder with reference output (tools/fastdepth_ref: fn2/fast_depth.cpp).
//!
//!   cargo run --release -p kinect-driver --example compare_ref -- FILE.k2raw REF.f32
#![allow(clippy::indexing_slicing, clippy::unwrap_used, clippy::expect_used, clippy::needless_range_loop)]

use std::io::Read;

use kinect_driver::consts::PIXELS;
use kinect_driver::record::RawReader;
use kinect_driver::tof::{CpuDecoder, TofConfig, TofOutput};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let (Some(raw), Some(refp)) = (args.get(1), args.get(2)) else {
        return Err("usage: compare_ref FILE.k2raw REF.f32".into());
    };
    let mut reader = RawReader::open(std::path::Path::new(raw))?;
    let tables = reader.header().tables()?;
    let mut reff = std::fs::File::open(refp)?;
    let mut dec = CpuDecoder::new(TofConfig::compat())?;
    let mut out = TofOutput::new();
    let mut frame = 0;
    let (mut both, mut ref_only, mut ours_only, mut over1, mut over10) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let (mut sum_abs, mut max_abs, mut ir_rel, mut ir_n, mut ir_max) = (0f64, 0f32, 0f64, 0u64, 0f32);
    let mut times = Vec::new();
    while let Some(p) = reader.next_packet()? {
        let mut buf = vec![0u8; PIXELS * 8];
        reff.read_exact(&mut buf)?;
        let f: Vec<f32> = buf.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect();
        let (rd, rir) = f.split_at(PIXELS);
        dec.decode(&p, &tables, &mut out)?;
        times.push(dec.timings.total_ms);
        let (depth, ir) = (out.depth.to_vec(), out.ir.to_vec());
        for i in 0..PIXELS {
            let (a, b) = (rd[i] > 0.0, depth[i] > 0.0);
            if a && b {
                let d = (rd[i] - depth[i]).abs();
                both += 1;
                sum_abs += f64::from(d);
                max_abs = max_abs.max(d);
                over1 += u64::from(d > 1.0);
                over10 += u64::from(d > 10.0);
            } else if a {
                ref_only += 1;
            } else if b {
                ours_only += 1;
            }
            if rir[i] > 10.0 {
                let e = (rir[i] - ir[i]).abs() / rir[i];
                ir_rel += f64::from(e);
                ir_max = ir_max.max(e);
                ir_n += 1;
            }
        }
        frame += 1;
    }
    times.sort_by(|a, b| a.total_cmp(b));
    println!(
        "{frame} frames: {both} pixels with depth in both, {ref_only} only in the reference, {ours_only} only here; \
         mean |diff| {:.4} mm, max {:.3} mm, >1 mm {over1}, >10 mm {over10}; IR mean rel. diff {:.2e}, max {:.2e}; \
         {:.1} ms median per frame ({} threads)",
        sum_abs / both.max(1) as f64,
        max_abs,
        ir_rel / ir_n.max(1) as f64,
        ir_max,
        times.get(times.len() / 2).copied().unwrap_or(0.0),
        dec.threads()
    );
    Ok(())
}
