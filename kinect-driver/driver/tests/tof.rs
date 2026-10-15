//! The depth/infrared decoding against the simulator's ground truth: what the extended mode
//! promises (range, saturation, HDR infrared, lost data) and that the compatible mode stays
//! libfreenect2's.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing, clippy::panic)]

use kinect_driver::RawDepthPacket;
use kinect_driver::sim::eval::{BANDS_MM, Band, Evaluation};
use kinect_driver::sim::{GroundTruth, Scene, SimConfig, Simulator};
use kinect_driver::tof::{CpuDecoder, TofConfig, TofOutput, flags};

fn sim() -> Simulator {
    Simulator::new(SimConfig { supersample: false, ..Default::default() }).unwrap()
}

fn frame(sim: &mut Simulator, scene: &str) -> (RawDepthPacket, GroundTruth) {
    sim.frame(&Scene::preset(scene, 0.0).unwrap(), 1)
}

fn evaluate(cfg: TofConfig, sim: &Simulator, p: &RawDepthPacket, gt: &GroundTruth) -> (Evaluation, TofOutput) {
    let mut dec = CpuDecoder::new(cfg).unwrap();
    let mut out = TofOutput::new();
    dec.decode(p, sim.tables(), &mut out).unwrap();
    let mut e = Evaluation::default();
    e.add(gt, &out);
    (e, out)
}

fn band(e: &Evaluation, upper_mm: f32) -> Band {
    let i = BANDS_MM.iter().position(|b| *b == upper_mm).unwrap();
    e.bands[i]
}

fn pct(a: u64, b: u64) -> f64 {
    100.0 * a as f64 / b.max(1) as f64
}

#[test]
fn compat_is_libfreenect2_up_to_4_5_m() {
    let mut s = sim();
    let (p, gt) = frame(&mut s, "room");
    let (e, out) = evaluate(TofConfig::compat(), &s, &p, &gt);
    let b = band(&e, 2000.0);
    assert!(pct(b.valid, b.truth) > 95.0, "{}", e.table("compat"));
    assert!(pct(b.outliers, b.truth) < 0.5, "{}", e.table("compat"));
    // libfreenect2 stops at 4.5 m
    assert!(out.depth.iter().all(|d| d <= 4500.0));
    assert_eq!(e.phantom, 0);
}

#[test]
fn extended_reaches_beyond_4_5_m() {
    let mut s = sim();
    let (p, gt) = frame(&mut s, "room");
    let (c, _) = evaluate(TofConfig::compat(), &s, &p, &gt);
    let (e, _) = evaluate(TofConfig::extended(), &s, &p, &gt);
    let (bc, be) = (band(&c, 6000.0), band(&e, 6000.0));
    assert!(pct(be.inliers, be.truth) > 90.0, "{}", e.table("extended"));
    assert!(pct(bc.inliers, bc.truth) < 50.0, "{}", c.table("compat"));
    for upper in [2000.0, 3000.0, 4500.0] {
        let (bc, be) = (band(&c, upper), band(&e, upper));
        assert!(be.inliers + be.truth / 100 >= bc.inliers, "no worse than compat below 4.5 m\n{}{}", c.table("compat"), e.table("extended"));
        assert!(pct(be.outliers, be.truth) < 1.0, "{}", e.table("extended"));
    }
    assert_eq!(e.phantom, 0);
}

#[test]
fn extended_measures_close_saturated_objects() {
    let mut s = sim();
    let (p, gt) = frame(&mut s, "near");
    assert!(gt.saturated.iter().filter(|v| **v != 0).count() > 10_000, "the scene saturates");
    let (c, oc) = evaluate(TofConfig::compat(), &s, &p, &gt);
    let (e, oe) = evaluate(TofConfig::extended(), &s, &p, &gt);
    assert_eq!(c.saturated.valid, 0, "libfreenect2 has no depth where it saturates");
    assert!(pct(e.saturated.valid, e.saturated.truth) > 95.0, "{}", e.table("extended"));
    assert!(pct(e.saturated.outliers, e.saturated.truth) < 1.0, "{}", e.table("extended"));
    // below 0.5 m (libfreenect2's minimum)
    let b = band(&e, 500.0);
    assert!(pct(b.valid, b.truth) > 90.0, "{}", e.table("extended"));
    // the infrared never clips: compat is white (65535) where it saturates, extended is not
    assert!(c.ir_clipped == c.ir_saturated && c.ir_saturated > 0);
    assert_eq!(e.ir_clipped, 0, "{}", e.table("extended"));
    // (libfreenect2's white, 65535, is 65536 in the 16-bit plane: the nearest f16)
    let max_c = oc.ir.iter().fold(0f32, f32::max);
    assert_eq!(max_c, 65536.0);
    assert!(oe.ir.iter().all(|v| v.is_finite() && v >= 0.0));
    // flags tell what happened
    assert!(oe.flags.iter().any(|f| f & flags::SATURATED_ANY != 0));
}

#[test]
fn a_lost_subimage_is_rebuilt() {
    let mut s = sim();
    let (full, gt) = frame(&mut s, "room");
    let (ef, _) = evaluate(TofConfig::extended(), &s, &full, &gt);
    let total = |e: &Evaluation| e.bands.iter().fold((0u64, 0u64, 0u64), |(t, i, o), b| (t + b.truth, i + b.inliers, o + b.outliers));
    let (truth, in_full, _) = total(&ef);
    // a wrong distance is much worse than a missing one
    let score = |inl: u64, out: u64| inl as f64 - 10.0 * out as f64;
    for lost in 0..9 {
        let mut p = full.clone();
        p.present &= !(1 << lost);
        p.subimage_mut(lost).unwrap().fill(0);
        let (e, o) = evaluate(TofConfig::extended(), &s, &p, &gt);
        let mut cfg = TofConfig::extended();
        cfg.ext.repair_lost = false;
        let (ew, _) = evaluate(cfg, &s, &p, &gt);
        let ((_, inl, out), (_, inl_w, out_w)) = (total(&e), total(&ew));
        let what = format!("sub-image {lost}: right {inl} wrong {out}; without rebuilding right {inl_w} wrong {out_w}; full frame right {in_full}");
        assert!(inl as f64 > 0.85 * in_full as f64, "{what}");
        assert!((out as f64) < 0.006 * truth as f64, "{what}");
        assert!(score(inl, out) > score(inl_w, out_w), "{what}");
        assert!(o.flags.iter().all(|f| f & flags::DATA_LOST != 0), "{what}");
    }
}

#[test]
fn garbage_does_not_crash_the_decoder() {
    let s = sim();
    for mode in [TofConfig::compat(), TofConfig::extended()] {
        let mut dec = CpuDecoder::new(mode).unwrap();
        let mut out = TofOutput::new();
        let mut p = RawDepthPacket::zeroed(1, 1);
        p.present = 0x3FF;
        let mut x = 0x1234_5678u32;
        for b in &mut p.data {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            *b = x as u8;
        }
        dec.decode(&p, s.tables(), &mut out).unwrap();
        assert!(out.depth.iter().all(|d| d.is_finite() && (0.0..=18750.0).contains(&d)));
        assert!(out.ir.iter().all(|v| v.is_finite() && v >= 0.0));
        // all zeros, nothing present
        let empty = RawDepthPacket::zeroed(2, 2);
        dec.decode(&empty, s.tables(), &mut out).unwrap();
        assert!(out.depth.iter().all(|d| d == 0.0));
        // too short
        let mut short = RawDepthPacket::zeroed(3, 3);
        short.data.truncate(1000);
        assert!(dec.decode(&short, s.tables(), &mut out).is_err());
    }
}
