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

/// Two echoes in every pixel: the raw samples of two frames added (the sensor adds the light of
/// both), halved.
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
fn pixels_with_two_echoes_are_not_trusted() {
    use kinect_driver::sim::{Object, Shape};
    let wall = |z: f32, albedo: f32| Scene { objects: vec![Object::new(Shape::Plane { point: [0.0, 0.0, z], normal: [0.0, 0.0, -1.0] }, albedo)], ambient: 150.0, brightness: 16000.0 };
    let mut s = sim();
    // equally bright echoes from 1.0 and 1.6 m: at 120 MHz they almost cancel, at 16 MHz they add
    let (near, _) = s.frame(&wall(1000.0, 0.4), 1);
    let (far, _) = s.frame(&wall(1600.0, 0.4 * 1.6 * 1.6), 2);
    // a weak second echo: a quarter (light from a wall on the floor)
    let (weak, _) = s.frame(&wall(1600.0, 0.4 * 1.6 * 1.6 * 0.25), 3);
    let decode = |p: &RawDepthPacket| {
        let mut dec = CpuDecoder::new(TofConfig::extended()).unwrap();
        let mut out = TofOutput::new();
        dec.decode(p, s.tables(), &mut out).unwrap();
        out
    };
    let count = |o: &TofOutput, f: &dyn Fn(usize) -> bool| (0..o.depth.len()).filter(|i| f(*i)).count();
    let single = decode(&near);
    let px = single.depth.len() as f64;
    assert!((count(&single, &|i| single.flags[i] & flags::MULTIPATH != 0) as f64) < 0.001 * px, "a single echo is not flagged");
    assert!(count(&single, &|i| single.depth.get(i).unwrap_or(0.0) > 0.0) as f64 > 0.9 * px);
    let lut = &s.tables().lut;
    let both = decode(&mix(&near, &far, lut));
    let flagged = count(&both, &|i| both.flags[i] & flags::MULTIPATH != 0) as f64;
    let with_depth = count(&both, &|i| both.depth.get(i).unwrap_or(0.0) > 0.0) as f64;
    assert!(flagged > 0.8 * px, "flagged {flagged} of {px}");
    assert!(with_depth < 0.01 * px, "depth on {with_depth} of {px}");
    // without the test, the mixture passes for a distance that is neither wall
    let mut cfg = TofConfig::extended();
    cfg.ext.multipath_check = false;
    let mut dec = CpuDecoder::new(cfg).unwrap();
    let mut out = TofOutput::new();
    dec.decode(&mix(&near, &far, lut), s.tables(), &mut out).unwrap();
    let neither = count(&out, &|i| out.depth.get(i).unwrap_or(0.0) > 0.0 && (out.depth.get(i).unwrap_or(0.0) - 1000.0).abs() > 50.0 && (out.depth.get(i).unwrap_or(0.0) - 1600.0).abs() > 80.0) as f64;
    assert!(neither > 0.5 * px, "without the test {neither} of {px} pixels at neither wall");
    // the weak second echo moves the distance little: the pixels keep the near wall
    let o = decode(&mix(&near, &weak, lut));
    let at_near = count(&o, &|i| (o.depth.get(i).unwrap_or(0.0) - 1000.0).abs() < 50.0) as f64;
    assert!(at_near > 0.9 * px, "weak second echo: {at_near} of {px} at the near wall");
}

#[test]
fn two_echoes_give_the_near_surface() {
    use kinect_driver::sim::{Object, Shape};
    let wall = |z: f32, albedo: f32| Scene { objects: vec![Object::new(Shape::Plane { point: [0.0, 0.0, z], normal: [0.0, 0.0, -1.0] }, albedo)], ambient: 150.0, brightness: 16000.0 };
    let mut s = sim();
    // (near, far, far echo relative to the near one, near pixels at least, neither at most)
    let cases = [
        // a floor at 2 m and the mirror image of a wall at 4.6 m, half as strong: one echo puts
        // most pixels between them
        (2000.0f32, 4600.0f32, 0.5f32, 0.6f64, 0.25f64),
        (2000.0, 3000.0, 2.0, 0.9, 0.02),
        (1000.0, 1600.0, 1.0, 0.8, 0.02),
        // a weak second echo: the single echo's distance stays
        (1500.0, 3000.0, 0.25, 0.95, 0.01),
    ];
    for (zn, zf, ratio, near_min, neither_max) in cases {
        let (near, _) = s.frame(&wall(zn, 0.4), 1);
        let (far, _) = s.frame(&wall(zf, 0.4 * (zf / zn).powi(2) * ratio), 2);
        let m = mix(&near, &far, &s.tables().lut);
        let mut cfg = TofConfig::extended();
        cfg.ext.two_echoes = true;
        let mut dec = CpuDecoder::new(cfg).unwrap();
        let mut out = TofOutput::new();
        dec.decode(&m, s.tables(), &mut out).unwrap();
        let n = out.depth.len() as f64;
        let at = |z: f32| out.depth.iter().filter(|d| (*d - z).abs() < 0.03 * z).count() as f64 / n;
        let with = out.depth.iter().filter(|d| *d > 0.0).count() as f64 / n;
        let (on_near, on_far) = (at(zn), at(zf));
        assert!(on_near >= near_min, "{zn} + {zf} x{ratio}: {on_near:.3} at the near surface");
        assert!(with - on_near - on_far <= neither_max, "{zn} + {zf} x{ratio}: {:.3} at neither", with - on_near - on_far);
    }
}

#[test]
fn a_still_scene_takes_its_splits_over() {
    use kinect_driver::sim::{Object, Shape};
    let wall = |z: f32, albedo: f32| Scene { objects: vec![Object::new(Shape::Plane { point: [0.0, 0.0, z], normal: [0.0, 0.0, -1.0] }, albedo)], ambient: 150.0, brightness: 16000.0 };
    let mut s = sim();
    let pair = |s: &mut Simulator, zn: f32, zf: f32, ratio: f32, n: u32| {
        let (near, _) = s.frame(&wall(zn, 0.4), n);
        let (far, _) = s.frame(&wall(zf, 0.4 * (zf / zn).powi(2) * ratio), n + 1);
        mix(&near, &far, &s.tables().lut)
    };
    let (still, other) = (pair(&mut s, 2000.0, 4600.0, 0.5, 1), pair(&mut s, 1500.0, 3000.0, 2.0, 3));
    let mut cfg = TofConfig::extended();
    cfg.ext.two_echoes = true;
    let mut dec = CpuDecoder::new(cfg.clone()).unwrap();
    let (mut a, mut b) = (TofOutput::new(), TofOutput::new());
    // the same input again: every pixel takes its split over, or splits again (its turn) to the
    // same result
    dec.decode(&still, s.tables(), &mut a).unwrap();
    for _ in 0..3 {
        dec.decode(&still, s.tables(), &mut b).unwrap();
        assert!(a.depth == b.depth && a.flags == b.flags);
    }
    // another scene: as a decoder that never saw the first
    dec.decode(&other, s.tables(), &mut a).unwrap();
    let mut fresh = CpuDecoder::new(cfg).unwrap();
    fresh.decode(&other, s.tables(), &mut b).unwrap();
    assert!(a.depth == b.depth && a.flags == b.flags);
}

#[test]
fn surfaces_brighter_than_plausible_keep_their_depth() {
    use kinect_driver::sim::{Object, Shape};
    // glossy paint seen head-on, a reflector: several times brighter than white paper
    let wall = |z: f32, albedo: f32| Scene { objects: vec![Object::new(Shape::Plane { point: [0.0, 0.0, z], normal: [0.0, 0.0, -1.0] }, albedo)], ambient: 150.0, brightness: 16000.0 };
    let mut s = sim();
    let (p, gt) = s.frame(&wall(4500.0, 4.0), 1);
    let mut dec = CpuDecoder::new(TofConfig::extended()).unwrap();
    let mut out = TofOutput::new();
    dec.decode(&p, s.tables(), &mut out).unwrap();
    let n = out.depth.len() as f64;
    let right = (0..out.depth.len()).filter(|&i| gt.depth[i] > 0.0 && (out.depth.get(i).unwrap_or(0.0) - gt.depth[i]).abs() <= (0.01 * gt.depth[i]).max(15.0)).count() as f64;
    let wrong = (0..out.depth.len()).filter(|&i| out.depth.get(i).unwrap_or(0.0) > 0.0 && (out.depth.get(i).unwrap_or(0.0) - gt.depth[i]).abs() > 100.0).count() as f64;
    assert!(right > 0.9 * n, "{right} of {n} right");
    assert!(wrong < 0.001 * n, "{wrong} of {n} wrong");
}

#[test]
fn the_illumination_halves_at_its_angle() {
    use kinect_driver::tof::cpu::inverse_illumination;
    let e = TofConfig::extended().ext;
    let tan = e.illumination_angle.to_radians().tan();
    assert!((inverse_illumination(&[0.0, 0.0], &e) - 1.0).abs() < 1e-9);
    assert!((inverse_illumination(&[tan, 0.0], &e) - 2.0).abs() < 1e-5);
    assert!((inverse_illumination(&[0.0, tan], &e) - 2.0).abs() < 1e-5);
    assert!(inverse_illumination(&[0.7, 0.5], &e) > inverse_illumination(&[0.5, 0.5], &e));
    let even = kinect_driver::tof::ExtendedParams { illumination_steepness: 0.0, ..e };
    assert_eq!(inverse_illumination(&[0.7, 0.5], &even), 1.0);
}
