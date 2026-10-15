//! The GPU decoder gives the CPU decoder's frames (up to rounding). Runs on whatever adapter
//! wgpu finds (lavapipe in CI); without one the tests are skipped, unless
//! KINECT_DRIVER_REQUIRE_GPU=1.
#![cfg(feature = "gpu")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing, clippy::panic)]

use kinect_driver::RawDepthPacket;
use kinect_driver::gpu::GpuDecoder;
use kinect_driver::sim::{Scene, SimConfig, Simulator};
use kinect_driver::tof::{CpuDecoder, TofConfig, TofOutput};

fn gpu(cfg: TofConfig) -> Option<GpuDecoder> {
    match GpuDecoder::new(cfg) {
        Ok(g) => {
            eprintln!("GPU: {}", g.adapter());
            Some(g)
        }
        Err(e) if std::env::var("KINECT_DRIVER_REQUIRE_GPU").is_err() => {
            eprintln!("skipped: {e}");
            None
        }
        Err(e) => panic!("{e}"),
    }
}

#[derive(Debug, Default)]
struct Diff {
    pixels: usize,
    valid_mismatch: usize,
    both: usize,
    depth_over_1mm: usize,
    depth_max: f32,
    ir_off: usize,
    conf_off: usize,
    flags_off: usize,
}

fn compare(c: &TofOutput, g: &TofOutput) -> Diff {
    let mut d = Diff { pixels: c.depth.len(), ..Default::default() };
    let (cd, gd, ci, gi, cc, gc) = (c.depth.to_vec(), g.depth.to_vec(), c.ir.to_vec(), g.ir.to_vec(), c.confidence.to_vec(), g.confidence.to_vec());
    for i in 0..c.depth.len() {
        let (a, b) = (cd[i], gd[i]);
        if (a > 0.0) != (b > 0.0) {
            d.valid_mismatch += 1;
        } else if a > 0.0 {
            d.both += 1;
            let e = (a - b).abs();
            d.depth_max = d.depth_max.max(e);
            if e > 1.0 {
                d.depth_over_1mm += 1;
            }
        }
        let (ia, ib) = (ci[i], gi[i]);
        if (ia - ib).abs() > 1e-3 * ia.abs().max(1.0) {
            d.ir_off += 1;
        }
        if (cc[i] - gc[i]).abs() > 1e-3 {
            d.conf_off += 1;
        }
        if c.flags[i] != g.flags[i] {
            d.flags_off += 1;
        }
    }
    d
}

fn check(cfg: TofConfig, scenes: &[&str]) {
    let Some(mut g) = gpu(cfg.clone()) else { return };
    let mut c = CpuDecoder::new(cfg).unwrap();
    let mut sim = Simulator::new(SimConfig { supersample: false, ..Default::default() }).unwrap();
    let tables = sim.tables().clone();
    let (mut oc, mut og) = (TofOutput::new(), TofOutput::new());
    for (n, scene) in scenes.iter().enumerate() {
        let (p, _) = sim.frame(&Scene::preset(scene, 0.3).unwrap(), n as u32);
        c.decode(&p, &tables, &mut oc).unwrap();
        g.decode(&p, &tables, &mut og).unwrap();
        let d = compare(&oc, &og);
        eprintln!("{scene}: {d:?} (gpu {:.1} ms, cpu {:.1} ms)", g.timings.total_ms, c.timings.total_ms);
        let px = d.pixels as f64;
        assert!((d.valid_mismatch as f64) < 0.002 * px, "{scene}: {d:?}");
        assert!((d.depth_over_1mm as f64) < 0.002 * px, "{scene}: {d:?}");
        assert!((d.ir_off as f64) < 0.001 * px, "{scene}: {d:?}");
        assert!((d.conf_off as f64) < 0.003 * px, "{scene}: {d:?}");
        assert!((d.flags_off as f64) < 0.003 * px, "{scene}: {d:?}");
    }
}

#[test]
fn compat_matches_the_cpu() {
    check(TofConfig::compat(), &["room", "near", "far"]);
}

#[test]
fn extended_matches_the_cpu() {
    check(TofConfig::extended(), &["room", "near", "far", "ramp"]);
}

#[test]
fn extended_variants_match_the_cpu() {
    let mut cfg = TofConfig::extended();
    cfg.apply("weak_boost=on,spatial_resolve=off,speckle_filter=off").unwrap();
    check(cfg, &["far", "near"]);
    let mut cfg = TofConfig::extended();
    cfg.apply("bilateral_filter=off,edge_filter=off,plausibility=off").unwrap();
    check(cfg, &["room"]);
}

#[test]
fn lost_rows_and_garbage() {
    let Some(mut g) = gpu(TofConfig::extended()) else { return };
    let mut c = CpuDecoder::new(TofConfig::extended()).unwrap();
    let mut sim = Simulator::new(SimConfig { supersample: false, ..Default::default() }).unwrap();
    let tables = sim.tables().clone();
    let (mut p, _) = sim.frame(&Scene::preset("room", 0.0).unwrap(), 1);
    p.present &= !(1 << 4);
    p.subimage_mut(4).unwrap().fill(0);
    let (mut oc, mut og) = (TofOutput::new(), TofOutput::new());
    c.decode(&p, &tables, &mut oc).unwrap();
    g.decode(&p, &tables, &mut og).unwrap();
    let d = compare(&oc, &og);
    assert!((d.valid_mismatch as f64) < 0.002 * d.pixels as f64, "{d:?}");
    let mut junk = RawDepthPacket::zeroed(2, 2);
    junk.present = 0x3FF;
    let mut x = 0x9E37_79B9u32;
    for b in &mut junk.data {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        *b = x as u8;
    }
    g.decode(&junk, &tables, &mut og).unwrap();
    assert!(og.depth.iter().all(|v| v.is_finite() && v >= 0.0));
    let mut short = RawDepthPacket::zeroed(3, 3);
    short.data.truncate(10);
    assert!(g.decode(&short, &tables, &mut og).is_err());
    // and it still works afterwards
    g.decode(&p, &tables, &mut og).unwrap();
    assert!(og.depth.iter().filter(|v| *v > 0.0).count() > 100_000);
}
