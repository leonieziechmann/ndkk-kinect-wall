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

/// Two echoes in every pixel: the raw samples of two frames added, halved (as tests/tof.rs).
fn mix(a: &RawDepthPacket, b: &RawDepthPacket, lut: &[f32; 2048]) -> RawDepthPacket {
    use kinect_driver::consts::{HEIGHT, PHASE_SUBIMAGES, ROW_BYTES, WIDTH};
    use kinect_driver::packet::{code_for_value, pack_row, packed_row, unpack_row};
    let mut out = a.clone();
    for s in 0..PHASE_SUBIMAGES {
        for y in 0..HEIGHT {
            let (mut ca, mut cb) = ([0u16; WIDTH], [0u16; WIDTH]);
            unpack_row(a.row_bytes(s, y).unwrap(), &mut ca);
            unpack_row(b.row_bytes(s, y).unwrap(), &mut cb);
            let codes: [u16; WIDTH] = std::array::from_fn(|x| code_for_value(0.5 * (lut[usize::from(ca[x])] + lut[usize::from(cb[x])])));
            let r = packed_row(y).unwrap() * ROW_BYTES;
            pack_row(&codes, &mut out.subimage_mut(s).unwrap()[r..r + ROW_BYTES]);
        }
    }
    out
}

#[test]
fn two_echoes_match_the_cpu() {
    use kinect_driver::sim::{Object, Shape};
    let mut cfg = TofConfig::extended();
    cfg.ext.two_echoes = true;
    let Some(mut g) = gpu(cfg.clone()) else { return };
    let mut c = CpuDecoder::new(cfg).unwrap();
    let wall = |z: f32, albedo: f32| Scene { objects: vec![Object::new(Shape::Plane { point: [0.0, 0.0, z], normal: [0.0, 0.0, -1.0] }, albedo)], ambient: 150.0, brightness: 16000.0 };
    let mut sim = Simulator::new(SimConfig { supersample: false, ..Default::default() }).unwrap();
    let tables = sim.tables().clone();
    let (mut oc, mut og) = (TofOutput::new(), TofOutput::new());
    // a floor and the mirror image of a wall; two walls close together; and a room with no second echo
    for (zn, zf, ratio) in [(2000.0f32, 4600.0f32, 0.5f32), (1000.0, 1600.0, 1.0)] {
        let (near, _) = sim.frame(&wall(zn, 0.4), 1);
        let (far, _) = sim.frame(&wall(zf, 0.4 * (zf / zn).powi(2) * ratio), 2);
        let p = mix(&near, &far, &tables.lut);
        c.decode(&p, &tables, &mut oc).unwrap();
        g.decode(&p, &tables, &mut og).unwrap();
        let d = compare(&oc, &og);
        eprintln!("{zn} + {zf} x{ratio}: {d:?} (gpu {:.1} ms, cpu {:.1} ms)", g.timings.total_ms, c.timings.total_ms);
        // the searches round differently: now and then another of two equally good pairs
        let px = d.pixels as f64;
        assert!((d.valid_mismatch as f64) < 0.002 * px, "{d:?}");
        assert!((d.depth_over_1mm as f64) < 0.005 * px, "{d:?}");
        assert!((d.flags_off as f64) < 0.005 * px, "{d:?}");
    }
    let (p, _) = sim.frame(&Scene::preset("room", 0.3).unwrap(), 3);
    c.decode(&p, &tables, &mut oc).unwrap();
    g.decode(&p, &tables, &mut og).unwrap();
    let d = compare(&oc, &og);
    assert!((d.depth_over_1mm as f64) < 0.002 * d.pixels as f64, "{d:?}");
}

#[test]
fn split_reuse_matches_the_cpu() {
    use kinect_driver::sim::{Object, Shape};
    let mut cfg = TofConfig::extended();
    cfg.ext.two_echoes = true;
    assert!(cfg.ext.split_reuse);
    let Some(mut g) = gpu(cfg.clone()) else { return };
    let mut c = CpuDecoder::new(cfg).unwrap();
    let wall = |z: f32, albedo: f32| Scene { objects: vec![Object::new(Shape::Plane { point: [0.0, 0.0, z], normal: [0.0, 0.0, -1.0] }, albedo)], ambient: 150.0, brightness: 16000.0 };
    let mut sim = Simulator::new(SimConfig { supersample: false, ..Default::default() }).unwrap();
    let tables = sim.tables().clone();
    let mut pair = |zn: f32, zf: f32, ratio: f32, n: u32| {
        let (near, _) = sim.frame(&wall(zn, 0.4), n);
        let (far, _) = sim.frame(&wall(zf, 0.4 * (zf / zn).powi(2) * ratio), n + 1);
        mix(&near, &far, &tables.lut)
    };
    // a floor and its mirror image with new sensor noise every frame (pixels take their splits
    // over or split again, in turn), then another scene (every pixel splits again)
    let mut frames: Vec<RawDepthPacket> = (0..5).map(|f| pair(2000.0, 4600.0, 0.5, 1 + 2 * f)).collect();
    frames.push(pair(1500.0, 3000.0, 2.0, 11));
    let (mut oc, mut og) = (TofOutput::new(), TofOutput::new());
    for (n, p) in frames.iter().enumerate() {
        c.decode(p, &tables, &mut oc).unwrap();
        g.decode(p, &tables, &mut og).unwrap();
        let d = compare(&oc, &og);
        eprintln!("frame {n}: {d:?} (gpu split {:.2} ms)", g.timings.split_ms);
        let px = d.pixels as f64;
        assert!((d.valid_mismatch as f64) < 0.002 * px, "frame {n}: {d:?}");
        assert!((d.depth_over_1mm as f64) < 0.005 * px, "frame {n}: {d:?}");
        assert!((d.flags_off as f64) < 0.005 * px, "frame {n}: {d:?}");
    }
    // the same input again: every pixel takes its split over, or splits again to the same result
    let first = og.clone();
    for _ in 0..3 {
        g.decode(&frames[5], &tables, &mut og).unwrap();
        assert!(og.depth == first.depth && og.flags == first.flags);
    }
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
