//! Diagnostics of the extended decoder on a real recording, against compat: why pixels that
//! compat measures have no depth in extended, what the pixels look like that extended puts
//! beyond the room, which pixels are reliable in both, the phase residuals and the amplitude
//! ratios of the frequencies, the brightness by angle, and maps.
//!   cargo run --release -p kinect-driver --features gpu --example diag_raw -- FILE.k2raw
//!       [--frames N] [--tof key=value,...] [--room MM] [--png DIR] [--gpu] [--pixels] [--columns]
//! `--room`: the farthest real surface (default 3000 mm); extended depth beyond it is a phantom.
//! `--gpu`: the GPU decoder against the CPU decoder. `--pixels`: the first phantoms one by one.
//! `--columns`: depth down a few columns of the last frame.
#![allow(clippy::indexing_slicing, clippy::unwrap_used, clippy::expect_used, clippy::needless_range_loop)]

use std::io::BufWriter;
use std::path::Path;

use kinect_driver::consts::{HEIGHT, PIXELS, WIDTH};
use kinect_driver::record::RawReader;
use kinect_driver::tof::{CpuDecoder, TofConfig, TofOutput, flags};

fn save_rgb(path: &str, px: &[[u8; 3]]) -> Result<(), Box<dyn std::error::Error>> {
    let f = std::fs::File::create(path)?;
    let mut e = png::Encoder::new(BufWriter::new(f), WIDTH as u32, HEIGHT as u32);
    e.set_color(png::ColorType::Rgb);
    e.set_depth(png::BitDepth::Eight);
    let mut w = e.write_header()?;
    let data: Vec<u8> = px.iter().flatten().copied().collect();
    w.write_image_data(&data)?;
    Ok(())
}

fn color(d: f32, max: f32) -> [u8; 3] {
    if d <= 0.0 {
        return [0, 0, 0];
    }
    let t = (d / max).clamp(0.0, 1.0) * 4.0;
    let f = t.fract();
    let (r, g, b) = match t as u32 {
        0 => (0.0, f, 1.0),
        1 => (0.0, 1.0, 1.0 - f),
        2 => (f, 1.0, 0.0),
        3 => (1.0, 1.0 - f, 0.0),
        _ => (1.0, 0.0, 0.0),
    };
    [(r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8]
}

/// Why extended has no depth where compat has.
const REASONS: [(&str, u32); 7] = [
    ("no signal", flags::NO_SIGNAL),
    ("out of range", flags::OUT_OF_RANGE),
    ("edge", flags::EDGE),
    ("speckle", flags::SPECKLE),
    ("low confidence", flags::LOW_CONFIDENCE),
    ("single frequency", flags::SINGLE_FREQUENCY),
    ("other", 0),
];

fn reason(f: u32) -> usize {
    REASONS.iter().position(|(_, b)| *b != 0 && f & b != 0).unwrap_or(REASONS.len() - 1)
}

#[derive(Default)]
struct Hist {
    v: Vec<f32>,
}

impl Hist {
    fn q(&mut self, p: f32) -> f32 {
        if self.v.is_empty() {
            return f32::NAN;
        }
        self.v.sort_by(f32::total_cmp);
        self.v[((self.v.len() - 1) as f32 * p) as usize]
    }
    fn line(&mut self, name: &str) {
        println!("    {name:<22} n {:>8}  p10 {:>8.2}  p50 {:>8.2}  p90 {:>8.2}  p99 {:>8.2}", self.v.len(), self.q(0.1), self.q(0.5), self.q(0.9), self.q(0.99));
    }
}

/// Phase residuals of each frequency against the unwrapped distance, by amplitude and by
/// distance: raw samples and a 3 x 3 mean (as the bilateral filter on a smooth surface).
struct Resid {
    /// [raw|mean][freq][amp bin] -> residuals (radians)
    by_amp: Vec<Vec<Vec<Vec<f32>>>>,
    /// [freq][distance bin of 250 mm] -> residuals of the 3 x 3 mean (radians)
    by_dist: Vec<Vec<Vec<f32>>>,
}

const AMP_BINS: [f32; 12] = [5.0, 10.0, 20.0, 40.0, 80.0, 160.0, 320.0, 640.0, 1280.0, 2560.0, 5120.0, 1e9];

impl Resid {
    fn new() -> Resid {
        Resid { by_amp: vec![vec![vec![Vec::<f32>::new(); AMP_BINS.len()]; 3]; 2], by_dist: vec![vec![Vec::<f32>::new(); 12]; 3] }
    }

    fn add(&mut self, de: &CpuDecoder, oc: &TofOutput, tables: &kinect_driver::DeviceTables, abm: f32) {
        let nf = [10.0f32, 2.0, 15.0];
        for y in 2..HEIGHT - 2 {
            for x in 2..WIDTH - 2 {
                let i = y * WIDTH + x;
                if (x + 3 * y) % 4 != 0 {
                    continue;
                }
                let c = oc.depth.get(i).unwrap_or(0.0);
                if !(500.0..=3000.0).contains(&c) {
                    continue;
                }
                let Some(info) = de.unwrap_info(i) else { continue };
                if info.kind & 0x0f != 1 {
                    continue;
                }
                let d = kinect_driver::tables::depth_from_u(info.u1, tables.xtable[i], tables.ztable[i]);
                if (d - c).abs() > (0.01 * c).max(10.0) {
                    continue;
                }
                // the 3 x 3 neighbors at a similar depth
                let near: Vec<usize> = (0..9).map(|j| i + (j % 3) + (j / 3) * WIDTH - WIDTH - 1).filter(|&j| (oc.depth.get(j).unwrap_or(0.0) - c).abs() < 0.03 * c).collect();
                for k in 0..3 {
                    let Some((a, b)) = de.sample(k, i) else { continue };
                    let (mut sa, mut sb) = (0f32, 0f32);
                    for &j in &near {
                        if let Some((aj, bj)) = de.sample(k, j) {
                            sa += aj;
                            sb += bj;
                        }
                    }
                    let nn = near.len().max(1) as f32;
                    let (sa, sb) = (sa / nn, sb / nn);
                    for (v, (aa, bb)) in [(a, b), (sa, sb)].into_iter().enumerate() {
                        let amp = (aa * aa + bb * bb).sqrt() * abm;
                        if amp <= 0.0 {
                            continue;
                        }
                        let ph = bb.atan2(aa) / std::f32::consts::TAU;
                        let r = nf[k] * info.u1 - ph;
                        let r = (r - r.round()) * std::f32::consts::TAU;
                        let bin = AMP_BINS.iter().position(|b| amp < *b).unwrap_or(AMP_BINS.len() - 1);
                        self.by_amp[v][k][bin].push(r);
                        if v == 1 && amp > 300.0 {
                            let db = ((c / 250.0) as usize).min(11);
                            self.by_dist[k][db].push(r);
                        }
                    }
                }
            }
        }
    }

    fn print(&mut self) {
        let stats = |v: &mut Vec<f32>| -> (usize, f32, f32, f32) {
            if v.len() < 20 {
                return (v.len(), f32::NAN, f32::NAN, f32::NAN);
            }
            let n = v.len() as f32;
            let mean = v.iter().sum::<f32>() / n;
            let sd = (v.iter().map(|r| (r - mean) * (r - mean)).sum::<f32>() / n).sqrt();
            v.sort_by(f32::total_cmp);
            let med = v[v.len() / 2];
            let mut dev: Vec<f32> = v.iter().map(|r| (r - med).abs()).collect();
            dev.sort_by(f32::total_cmp);
            (v.len(), mean, sd, dev[dev.len() / 2] * 1.4826)
        };
        for (v, name) in ["raw", "3x3 mean"].iter().enumerate() {
            println!("  phase residual against the unwrapped distance ({name}), radians: mean / sd / robust sd; sd * amplitude");
            for b in 0..AMP_BINS.len() {
                let lo = if b == 0 { 0.0 } else { AMP_BINS[b - 1] };
                let mut line = format!("    amp {lo:>6.0}-{:<6.0}", AMP_BINS[b].min(99999.0));
                for k in 0..3 {
                    let (n, m, sd, rsd) = stats(&mut self.by_amp[v][k][b]);
                    let mid = if b == 0 { 3.0 } else { (lo * AMP_BINS[b].min(10240.0)).sqrt() };
                    line += &format!(" | {n:>7} {m:>+6.3} {sd:>6.3} {rsd:>6.3} {:>6.2}", rsd * mid);
                }
                println!("{line}");
            }
        }
        println!("  mean residual (3x3 mean, amplitude > 300) by distance, radians (80 / 16 / 120 MHz):");
        for db in 0..12 {
            let mut line = format!("    {:>4}-{:<4} mm", db * 250, db * 250 + 250);
            for k in 0..3 {
                let (n, m, _, rsd) = stats(&mut self.by_dist[k][db]);
                line += &format!(" | {n:>7} {m:>+6.3} {rsd:>6.3}");
            }
            println!("{line}");
        }
    }
}

/// How far the amplitudes of the three frequencies (3 x 3 complex mean) are from the ratio of a
/// single return: max |ln(amp_k / g_k / geometric mean)|. Two returns at different distances
/// add up differently at each frequency.
fn ratio_dev(de: &CpuDecoder, i: usize) -> f32 {
    let g = [0.976f32, 1.005, 1.019];
    let (x, y) = (i % WIDTH, i / WIDTH);
    if x < 1 || y < 1 || x + 1 >= WIDTH || y + 1 >= HEIGHT {
        return f32::NAN;
    }
    let mut l = [0f32; 3];
    for k in 0..3 {
        let (mut sa, mut sb) = (0f32, 0f32);
        for j in 0..9 {
            let jj = (y + j / 3 - 1) * WIDTH + x + j % 3 - 1;
            if let Some((a, b)) = de.sample(k, jj) {
                sa += a;
                sb += b;
            }
        }
        l[k] = ((sa * sa + sb * sb).sqrt() / g[k]).max(1e-6).ln();
    }
    let m = (l[0] + l[1] + l[2]) / 3.0;
    l.iter().map(|v| (v - m).abs()).fold(0.0, f32::max)
}

/// Anchor weight (confident multi-frequency neighbors) in the 7 x 7 window around `i`, without
/// the pixel, and how much of it supports `u` (Epanechnikov kernel, 4 % of the distance or 80 mm).
fn support(de: &CpuDecoder, i: usize, u: f32) -> (f32, f32) {
    let (x, y) = ((i % WIDTH) as i32, (i / WIDTH) as i32);
    let range = 18750.0f32;
    let h = (u * range * 0.04).max(80.0) / range;
    let (mut total, mut s) = (0f32, 0f32);
    for dy in -3..=3 {
        for dx in -3..=3 {
            let (xx, yy) = (x + dx, y + dy);
            if (dx == 0 && dy == 0) || xx < 0 || yy < 0 || xx >= WIDTH as i32 || yy >= HEIGHT as i32 {
                continue;
            }
            let Some(n) = de.unwrap_info(yy as usize * WIDTH + xx as usize) else { continue };
            if n.kind & 0x0f != 1 || n.confidence < 0.8 {
                continue;
            }
            total += n.confidence;
            let d = (n.u1 - u) / h;
            s += n.confidence * (1.0 - d * d).max(0.0);
        }
    }
    (total, s)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut take = |name: &str| -> Option<String> {
        let i = args.iter().position(|a| a == name)?;
        args.remove(i);
        (i < args.len()).then(|| args.remove(i))
    };
    let frames: usize = take("--frames").and_then(|s| s.parse().ok()).unwrap_or(60);
    let tof = take("--tof").unwrap_or_default();
    let room: f32 = take("--room").and_then(|s| s.parse().ok()).unwrap_or(3000.0);
    let png = take("--png");
    let mut flag = |name: &str| args.iter().position(|a| a == name).map(|i| args.remove(i)).is_some();
    let (with_gpu, pixels, columns) = (flag("--gpu"), flag("--pixels"), flag("--columns"));
    let file = args.first().ok_or("diag_raw FILE.k2raw")?.clone();
    let mut reader = RawReader::open(Path::new(&file))?;
    let tables = reader.header().tables()?;
    let mut cfg_e = TofConfig::extended();
    cfg_e.apply(&tof)?;
    let mut dc = CpuDecoder::new(TofConfig::compat())?;
    let mut de = CpuDecoder::new(cfg_e)?;
    de.record_costs(true);
    let (mut oc, mut oe) = (TofOutput::new(), TofOutput::new());
    let mut n = 0usize;
    let mut lost = [0u64; REASONS.len()];
    let (mut both, mut agree, mut c_valid, mut e_valid, mut e_near, mut phantoms) = (0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
    // lost to low confidence / kept pixels at the same depth as compat: their unwrapping
    let (mut lc_e1, mut lc_gap, mut lc_conf, mut lc_ir) = (Hist::default(), Hist::default(), Hist::default(), Hist::default());
    let (mut ok_e1, mut ok_gap, mut ok_ir) = (Hist::default(), Hist::default(), Hist::default());
    let (mut weak_gap, mut weak_e1, mut weak_conf) = (Hist::default(), Hist::default(), Hist::default());
    let (mut ph_e1, mut ph_gap, mut ph_conf, mut ph_ir, mut ph_compat) = (Hist::default(), Hist::default(), Hist::default(), Hist::default(), Hist::default());
    let (mut rd_ok, mut rd_lost, mut rd_ph48, mut rd_ph8) = (Hist::default(), Hist::default(), Hist::default(), Hist::default());
    let (mut ph48_ir, mut ph8_ir, mut ph48_conf0, mut ph8_conf0) = (Hist::default(), Hist::default(), Hist::default(), Hist::default());
    let mut ph_flags = [0u64; 20];
    let mut ph_grid = [[0u64; 8]; 8];
    // ln amplitude ratios of agreeing bright pixels per 8 x 8 grid cell: [cell][k] sum, n
    let mut lr = vec![([0f64; 3], 0u64); 64];
    let mut mp_ok = [0u64; 2];
    let mut ph_res = [0u64; 2];
    // brightness * r^2 of agreeing pixels by the angle off the optical axis (5 degree bins)
    let mut prof: Vec<Hist> = (0..10).map(|_| Hist::default()).collect();
    // the same by column band (rows 120..300) and by row band (columns 150..360), relative to
    // the radial illumination model
    let mut colp: Vec<Hist> = (0..16).map(|_| Hist::default()).collect();
    let mut rowp: Vec<Hist> = (0..14).map(|_| Hist::default()).collect();
    let (mut ph_total, mut ph_frac, mut ok_total, mut ok_frac) = (Hist::default(), Hist::default(), Hist::default(), Hist::default());
    let mut ph_single = 0u64;
    let mut lost_map = vec![0u16; PIXELS];
    let mut ph_map = vec![0u16; PIXELS];
    // where both have depth but disagree: count and the sum of (extended - compat) / compat
    let mut dis_map = vec![(0u16, 0f32); PIXELS];
    // extended depth flagged MULTIPATH (the amplitudes do not fit one echo), per pixel
    let mut mp_map = vec![0u16; PIXELS];
    // extended depth from the first of two echoes (SECOND_ECHO), per pixel
    let mut se_map = vec![0u16; PIXELS];
    let mut resid = Resid::new();
    // per pixel over the frames: count, sum, sum of squares of the depth (compat, extended)
    let mut tc = vec![(0u32, 0f64, 0f64); PIXELS];
    let mut te = vec![(0u32, 0f64, 0f64); PIXELS];
    #[cfg(feature = "gpu")]
    let mut gpu = if with_gpu { Some(kinect_driver::gpu::GpuDecoder::new(de.config().clone())?) } else { None };
    #[cfg(not(feature = "gpu"))]
    let _ = with_gpu;
    let mut og = TofOutput::new();
    let (mut g_mismatch, mut g_over1, mut g_max, mut g_flags, mut g_conf) = (0u64, 0u64, 0f32, 0u64, 0u64);
    let abm = de.config().params.ab_multiplier;
    while n < frames {
        let Some(p) = reader.next_packet()? else { break };
        dc.decode(&p, &tables, &mut oc)?;
        de.decode(&p, &tables, &mut oe)?;
        n += 1;
        if n % 4 == 1 {
            resid.add(&de, &oc, &tables, abm);
        }
        #[cfg(feature = "gpu")]
        if let Some(g) = gpu.as_mut() {
            g.decode(&p, &tables, &mut og)?;
            for i in 0..PIXELS {
                let (a, b) = (oe.depth.get(i).unwrap_or(0.0), og.depth.get(i).unwrap_or(0.0));
                g_mismatch += u64::from((a > 0.0) != (b > 0.0));
                if a > 0.0 && b > 0.0 {
                    g_over1 += u64::from((a - b).abs() > 1.0);
                    g_max = g_max.max((a - b).abs());
                }
                g_flags += u64::from(oe.flags[i] != og.flags[i]);
                g_conf += u64::from((oe.confidence.get(i).unwrap_or(0.0) - og.confidence.get(i).unwrap_or(0.0)).abs() > 0.01);
            }
        }
        for (t, o) in [(&mut tc, &oc), (&mut te, &oe)] {
            for (s, d) in t.iter_mut().zip(o.depth.iter()) {
                if d > 0.0 {
                    s.0 += 1;
                    s.1 += f64::from(d);
                    s.2 += f64::from(d) * f64::from(d);
                }
            }
        }
        for (i, (d, f)) in oe.depth.iter().zip(&oe.flags).enumerate() {
            mp_map[i] += u16::from(d > 0.0 && f & flags::MULTIPATH != 0);
            se_map[i] += u16::from(d > 0.0 && f & flags::SECOND_ECHO != 0);
        }
        for i in 0..PIXELS {
            let (c, e, f) = (oc.depth.get(i).unwrap_or(0.0), oe.depth.get(i).unwrap_or(0.0), oe.flags[i]);
            c_valid += u64::from(c > 0.0);
            e_valid += u64::from(e > 0.0);
            e_near += u64::from(e > 0.0 && e <= room);
            let info = de.unwrap_info(i).unwrap_or_default();
            let gap = info.gap.min(1e4);
            if c > 0.0 && e > 0.0 {
                both += 1;
                if (c - e).abs() > (0.01 * c).max(10.0) {
                    dis_map[i].0 += 1;
                    dis_map[i].1 += (e - c) / c;
                }
                if (c - e).abs() <= (0.01 * c).max(10.0) {
                    agree += 1;
                    if i % 3 == 0 && f & flags::SATURATED_ANY == 0 {
                        let ray = tables.rays[i];
                        let t2 = ray[0] * ray[0] + ray[1] * ray[1];
                        let ang = t2.sqrt().atan().to_degrees();
                        let r = e / 1000.0 * (t2 + 1.0).sqrt();
                        prof[((ang / 5.0) as usize).min(9)].v.push(oe.ir.get(i).unwrap_or(0.0) * r * r);
                        let model = kinect_driver::tof::cpu::inverse_illumination(&ray, &de.config().ext) as f32;
                        let (x, y) = (i % WIDTH, i / WIDTH);
                        if (120..300).contains(&y) {
                            colp[x / 32].v.push(oe.ir.get(i).unwrap_or(0.0) * r * r * model);
                        }
                        if (150..360).contains(&x) {
                            rowp[(y / 32).min(13)].v.push(oe.ir.get(i).unwrap_or(0.0) * r * r * model);
                        }
                    }
                    mp_ok[usize::from(f & flags::MULTIPATH != 0)] += 1;
                    if info.ir_sum > 300.0 && (i % WIDTH) > 0 && (i % WIDTH) < WIDTH - 1 && i / WIDTH > 0 && i / WIDTH < HEIGHT - 1 {
                        let l: Vec<f64> = (0..3).map(|k| { let (a, b) = de.sample(k, i).unwrap_or((0.0, 0.0)); f64::from((a * a + b * b).sqrt().max(1e-6)).ln() }).collect();
                        let m = (l[0] + l[1] + l[2]) / 3.0;
                        let cell = &mut lr[((i / WIDTH) * 8 / HEIGHT) * 8 + (i % WIDTH) * 8 / WIDTH];
                        for k in 0..3 {
                            cell.0[k] += l[k] - m;
                        }
                        cell.1 += 1;
                    }
                    if info.ir_sum < 45.0 && info.kind & 0x0f == 1 {
                        let (t, f1) = support(&de, i, info.u1);
                        ok_total.v.push(t);
                        ok_frac.v.push(if t > 0.0 { f1 / t } else { f32::NAN });
                        weak_gap.v.push(gap);
                        weak_e1.v.push(info.cost);
                        weak_conf.v.push(info.confidence);
                    }
                    if i % 5 == 0 && info.kind & 0x0f == 1 {
                        rd_ok.v.push(ratio_dev(&de, i));
                        ok_e1.v.push(info.cost);
                        ok_gap.v.push(gap);
                        ok_ir.v.push(info.ir_sum);
                    }
                }
            }
            if c > 0.0 && e <= 0.0 {
                let r = reason(f);
                lost[r] += 1;
                lost_map[i] += 1;
                if REASONS[r].1 == flags::LOW_CONFIDENCE && i % 3 == 0 {
                    rd_lost.v.push(ratio_dev(&de, i));
                    lc_e1.v.push(info.cost);
                    lc_gap.v.push(gap);
                    lc_conf.v.push(info.confidence);
                    lc_ir.v.push(info.ir_sum);
                }
            }
            if e > room {
                phantoms += 1;
                ph_map[i] += 1;
                if pixels && n <= 3 && phantoms < 60 {
                    let ph: Vec<String> = (0..3)
                        .map(|k| {
                            let (a, b) = de.sample(k, i).unwrap_or((0.0, 0.0));
                            format!("{:.3}@{:.1}", (b.atan2(a) / std::f32::consts::TAU).rem_euclid(1.0), (a * a + b * b).sqrt() * abm)
                        })
                        .collect();
                    let to_mm = |u: f32| kinect_driver::tables::depth_from_u(u, tables.xtable[i], tables.ztable[i]);
                    println!(
                        "  phantom x {:>3} y {:>3}: {:>6.0} mm (2nd {:>6.0}) e1 {:>6.2} e2 {:>6.2} conf {:.2}->{:.2} ir_sum {:>5.1} raw phases@amp {} flags {:#x}",
                        i % WIDTH, i / WIDTH, e, to_mm(info.u2), info.cost, info.cost + info.gap, info.confidence, oe.confidence.get(i).unwrap_or(0.0), info.ir_sum, ph.join(" "), f
                    );
                }
                ph_e1.v.push(info.cost);
                ph_grid[(i / WIDTH) * 8 / HEIGHT][(i % WIDTH) * 8 / WIDTH] += 1;
                ph_res[usize::from(info.confidence >= 0.6)] += 1;
                let (t, f1) = support(&de, i, info.u1);
                ph_total.v.push(t);
                ph_frac.v.push(if t > 0.0 { f1 / t } else { f32::NAN });
                if e < 8000.0 {
                    rd_ph48.v.push(ratio_dev(&de, i));
                    ph48_ir.v.push(info.ir_sum);
                    ph48_conf0.v.push(info.confidence);
                } else {
                    rd_ph8.v.push(ratio_dev(&de, i));
                    ph8_ir.v.push(info.ir_sum);
                    ph8_conf0.v.push(info.confidence);
                }
                ph_gap.v.push(gap);
                ph_conf.v.push(oe.confidence.get(i).unwrap_or(0.0));
                ph_ir.v.push(info.ir_sum);
                ph_compat.v.push(c);
                ph_single += u64::from(info.kind & 0x0f == 2);
                for b in 0..20 {
                    ph_flags[b] += u64::from(f & (1 << b) != 0);
                }
            }
        }
    }
    let nf = n.max(1) as f64;
    let px = PIXELS as f64;
    println!("{n} frames of {file}  (extended --tof {tof:?})");
    println!(
        "  depth: compat {:.1} %, extended {:.1} % ({:.1} % within {:.1} m), both {:.0}/frame, agree {:.1} %, extended beyond {:.1} m: {:.0}/frame",
        100.0 * c_valid as f64 / nf / px,
        100.0 * e_valid as f64 / nf / px,
        100.0 * e_near as f64 / nf / px,
        room / 1000.0,
        both as f64 / nf,
        100.0 * agree as f64 / both.max(1) as f64,
        room / 1000.0,
        phantoms as f64 / nf
    );
    if g_mismatch + g_flags + g_conf > 0 || g_max > 0.0 {
        println!(
            "  GPU against CPU per frame: depth on one only {:.1}, depth > 1 mm apart {:.1} (max {:.4} mm), flags differ {:.1}, confidence > 0.01 apart {:.1}",
            g_mismatch as f64 / nf, g_over1 as f64 / nf, g_max, g_flags as f64 / nf, g_conf as f64 / nf
        );
    }
    let _ = &og;
    // reliable: depth in >= 90 % of the frames, temporal sd below 1 %, and at least 6 of the 8
    // neighbors reliable in time with a mean within 2 %
    let stable = |t: &[(u32, f64, f64)], i: usize| -> Option<f64> {
        let (k, s, q) = t[i];
        if (k as f64) < 0.9 * n as f64 || k == 0 {
            return None;
        }
        let m = s / k as f64;
        let sd = (q / k as f64 - m * m).max(0.0).sqrt();
        (sd < 0.01 * m).then_some(m)
    };
    let reliable = |t: &[(u32, f64, f64)]| -> Vec<Option<f64>> {
        (0..PIXELS)
            .map(|i| {
                let (x, y) = (i % WIDTH, i / WIDTH);
                let m = stable(t, i)?;
                if x == 0 || y == 0 || x + 1 == WIDTH || y + 1 == HEIGHT {
                    return None;
                }
                let good = [i - WIDTH - 1, i - WIDTH, i - WIDTH + 1, i - 1, i + 1, i + WIDTH - 1, i + WIDTH, i + WIDTH + 1]
                    .iter()
                    .filter(|&&j| stable(t, j).is_some_and(|mj| (mj - m).abs() < 0.02 * m))
                    .count();
                (good >= 6).then_some(m)
            })
            .collect()
    };
    let (rc, re) = (reliable(&tc), reliable(&te));
    let (mut nrc, mut nre, mut covered, mut agree_r, mut nre_room, mut nre_far) = (0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
    for i in 0..PIXELS {
        if let Some(m) = rc[i] {
            nrc += 1;
            let (k, s, _) = te[i];
            if k as f64 >= 0.9 * n as f64 {
                covered += 1;
                let me = s / k as f64;
                agree_r += u64::from((me - m).abs() <= (0.01 * m).max(10.0));
            }
        }
        if let Some(m) = re[i] {
            nre += 1;
            nre_room += u64::from((500.0..=2500.0).contains(&m));
            nre_far += u64::from(f64::from(room) < m);
        }
    }
    let nrc_room = rc.iter().filter(|m| m.is_some_and(|m| (500.0..=2500.0).contains(&m))).count();
    println!(
        "  reliable pixels (depth in >= 90 % of the frames, sd < 1 %, >= 6 of 8 neighbors alike): compat {nrc} ({nrc_room} at 0.5-2.5 m), extended {nre} ({nre_room} at 0.5-2.5 m, {nre_far} beyond {:.1} m)",
        room / 1000.0
    );
    println!(
        "  of compat's reliable pixels extended has {:.1} % (in >= 90 % of the frames), {:.1} % within 1 % / 10 mm of compat's mean",
        100.0 * covered as f64 / nrc.max(1) as f64,
        100.0 * agree_r as f64 / nrc.max(1) as f64
    );
    println!("  compat has depth, extended not, per frame:");
    for (k, (name, _)) in REASONS.iter().enumerate() {
        println!("    {name:<22} {:>8.0}", lost[k] as f64 / nf);
    }
    println!("  lost to low confidence (unwrapping, before the neighbors):");
    lc_e1.line("cost e1");
    lc_gap.line("gap e2 - e1");
    lc_conf.line("confidence");
    lc_ir.line("amplitude sum");
    println!("  kept and agreeing with compat (multi-frequency):");
    ok_e1.line("cost e1");
    ok_gap.line("gap e2 - e1");
    ok_ir.line("amplitude sum");
    println!("  agreeing pixels flagged MULTIPATH: {:.2} %", 100.0 * mp_ok[1] as f64 / (mp_ok[0] + mp_ok[1]).max(1) as f64);
    for k in 0..3 {
        println!("  mean ln(amp_{k} / mean) of agreeing pixels with amplitude sum > 300, 8 x 8 cells:");
        for r in 0..8 {
            println!("    {}", (0..8).map(|c| { let (sm, n) = lr[r * 8 + c]; if n < 50 { "     -".to_string() } else { format!("{:>+6.3}", sm[k] / n as f64) } }).collect::<Vec<_>>().join(""));
        }
    }
    println!("  kept and agreeing, amplitude sum below 45:");
    weak_e1.line("cost e1");
    weak_gap.line("gap e2 - e1");
    weak_conf.line("confidence (unwrapping)");
    println!("  phantoms beyond {:.1} m ({:.0}/frame, {:.0} % single frequency):", room / 1000.0, phantoms as f64 / nf, 100.0 * ph_single as f64 / phantoms.max(1) as f64);
    ph_e1.line("cost e1");
    ph_gap.line("gap e2 - e1");
    ph_conf.line("confidence");
    ph_ir.line("amplitude sum");
    ph_compat.line("compat depth there");
    let names = [
        "SAT80", "SAT16", "SAT120", "REP80", "REP16", "REP120", "IR_FILLED", "SINGLE", "RESOLVED", "EDGE", "LOWCONF", "LOST", "RANGE", "NEAR", "WEAK", "NOSIG", "FILLED", "SPECKLE", "PLAUS", "MULTIPATH",
    ];
    let fl: Vec<String> = (0..20).filter(|b| ph_flags[*b] > 0).map(|b| format!("{} {:.0} %", names[b], 100.0 * ph_flags[b] as f64 / phantoms.max(1) as f64)).collect();
    println!("    flags: {}", fl.join(", "));
    println!("    unwrapping alone below / above 0.6: {} / {}", ph_res[0], ph_res[1]);
    ph_total.line("anchor weight 7x7");
    ph_frac.line("support of u1 / total");
    println!("    weak agreeing pixels:");
    ok_total.line("anchor weight 7x7");
    ok_frac.line("support of u1 / total");
    for row in &ph_grid {
        println!("    {}", row.iter().map(|v| format!("{:>6.0}", *v as f64 / nf)).collect::<Vec<_>>().join(""));
    }
    println!("  amplitude ratio deviation (3 x 3 mean), max |ln(amp_k / g_k / mean)|:");
    rd_ok.line("agreeing");
    rd_lost.line("lost, low confidence");
    rd_ph48.line("phantom 3-8 m");
    rd_ph8.line("phantom 8+ m");
    println!("  phantoms: amplitude sum and confidence of the unwrapping (before the neighbors):");
    ph48_ir.line("3-8 m amplitude");
    ph48_conf0.line("3-8 m confidence");
    ph8_ir.line("8+ m amplitude");
    ph8_conf0.line("8+ m confidence");
    if columns {
        println!("  columns (last frame): row: compat / extended / unwrap u1 -> mm, conf, flags");
        for x in [30usize, 60, 100, 250, 400] {
            for y in (260..HEIGHT).step_by(10) {
                let i = y * WIDTH + x;
                let info = de.unwrap_info(i).unwrap_or_default();
                let mm = kinect_driver::tables::depth_from_u(info.u1, tables.xtable[i], tables.ztable[i]);
                println!("    x {x:>3} y {y:>3}: {:>6.0} {:>6.0} {:>6.0} {:.2} {:#x} ir {:.0}", oc.depth.get(i).unwrap_or(0.0), oe.depth.get(i).unwrap_or(0.0), mm, info.confidence, oe.flags[i], oc.ir.get(i).unwrap_or(0.0));
            }
        }
    }
    println!("  brightness * r^2 of agreeing pixels by angle off the axis (p50 / p90 / p99):");
    for (b, h) in prof.iter_mut().enumerate() {
        if h.v.len() > 100 {
            let (a, b9, c9) = (h.q(0.5), h.q(0.9), h.q(0.99));
            println!("    {:>2}-{:<2} deg  n {:>8}  {:>7.0} {:>7.0} {:>7.0}", b * 5, b * 5 + 5, h.v.len(), a, b9, c9);
        }
    }
    println!("  brightness * r^2 / model illumination, p99, by column band of 32 (rows 120..300):");
    println!("    {}", colp.iter_mut().map(|h| if h.v.len() > 50 { format!("{:>6.0}", h.q(0.99)) } else { "     -".into() }).collect::<Vec<_>>().join(""));
    println!("  ... by row band of 32 (columns 150..360):");
    println!("    {}", rowp.iter_mut().map(|h| if h.v.len() > 50 { format!("{:>6.0}", h.q(0.99)) } else { "     -".into() }).collect::<Vec<_>>().join(""));
    resid.print();
    if let Some(dir) = png {
        std::fs::create_dir_all(&dir)?;
        let max = room;
        save_rgb(&format!("{dir}/compat.png"), &oc.depth.iter().map(|d| color(d, max)).collect::<Vec<_>>())?;
        save_rgb(&format!("{dir}/extended.png"), &oe.depth.iter().map(|d| if d > room { [255, 255, 255] } else { color(d, max) }).collect::<Vec<_>>())?;
        // last frame: green both, blue extended only, red/orange/... lost by reason, white phantom
        let rcol = [[80, 80, 80], [255, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 0], [255, 128, 0], [128, 0, 255]];
        let map: Vec<[u8; 3]> = (0..PIXELS)
            .map(|i| {
                let (c, e) = (oc.depth.get(i).unwrap_or(0.0), oe.depth.get(i).unwrap_or(0.0));
                if e > room {
                    [255, 255, 255]
                } else if c > 0.0 && e > 0.0 {
                    [0, 110, 0]
                } else if e > 0.0 {
                    [0, 80, 255]
                } else if c > 0.0 {
                    rcol[reason(oe.flags[i])]
                } else {
                    [0, 0, 0]
                }
            })
            .collect();
        save_rgb(&format!("{dir}/reasons.png"), &map)?;
        // compat's reliable pixels: green = extended has them, red = not; blue = extended's
        // reliable pixels that compat lacks
        let rmap: Vec<[u8; 3]> = (0..PIXELS)
            .map(|i| match (rc[i].is_some(), te[i].0 as f64 >= 0.9 * n as f64, re[i].is_some()) {
                (true, true, _) => [0, 110, 0],
                (true, false, _) => [255, 0, 0],
                (false, _, true) => [0, 80, 255],
                _ => [0, 0, 0],
            })
            .collect();
        save_rgb(&format!("{dir}/reliable.png"), &rmap)?;
        let heat = |m: &[u16]| -> Vec<[u8; 3]> { m.iter().map(|v| { let t = (*v as f32 / n as f32 * 255.0) as u8; [t, t, t] }).collect() };
        save_rgb(&format!("{dir}/lost-heat.png"), &heat(&lost_map))?;
        save_rgb(&format!("{dir}/phantom-heat.png"), &heat(&ph_map))?;
        // disagreement: red = extended farther, blue = nearer; brightness = share of the frames,
        // saturation at 5 % mean difference
        let dis: Vec<[u8; 3]> = dis_map
            .iter()
            .map(|(k, sum)| {
                if *k == 0 {
                    return [0, 0, 0];
                }
                let share = *k as f32 / n as f32;
                let rel = (sum / *k as f32 / 0.05).clamp(-1.0, 1.0);
                let v = 80.0 + 175.0 * share;
                let (r, b) = if rel > 0.0 { (v, v * (1.0 - rel)) } else { (v * (1.0 + rel), v) };
                [r as u8, (v * (1.0 - rel.abs())) as u8, b as u8]
            })
            .collect();
        save_rgb(&format!("{dir}/disagree.png"), &dis)?;
        save_rgb(&format!("{dir}/multipath-heat.png"), &heat(&mp_map))?;
        save_rgb(&format!("{dir}/second-echo-heat.png"), &heat(&se_map))?;
        let ir: Vec<[u8; 3]> = oe.ir.iter().map(|v| { let t = ((v.max(1.0).ln() / 65535f32.ln()) * 255.0) as u8; [t, t, t] }).collect();
        save_rgb(&format!("{dir}/ir.png"), &ir)?;
        println!("  PNGs in {dir}: compat, extended (0..{:.1} m, white beyond), reasons, lost-heat, phantom-heat, disagree, multipath-heat, second-echo-heat, ir", room / 1000.0);
    }
    Ok(())
}
