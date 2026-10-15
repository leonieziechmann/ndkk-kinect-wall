//! Per-pixel gains and phase offsets of the frequencies on a recording of a flat wall: a map
//! from some frames, tested on others (does it transfer to other distances and brightness?).
//!   cargo run --release -p kinect-driver --example gain_map -- WALL.k2raw [--learn A..B] [--test C..D] [--other FILE.k2raw]
//! Gain: ln(|z_k| / mean |z|); phase: arg(z_k) - 2 pi n_k u (u: the decoder's distance), per pixel
//! averaged over the frames.
#![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::needless_range_loop)]

use kinect_driver::consts::{FREQ_MULTIPLES, PIXELS};
use kinect_driver::record::RawReader;
use kinect_driver::tof::{CpuDecoder, TofConfig, TofOutput, flags};

/// Per pixel and frequency: sums of the gain, of the phase as a unit vector, count.
#[derive(Clone)]
struct Acc {
    g: Vec<[f64; 3]>,
    pc: Vec<[f64; 3]>,
    ps: Vec<[f64; 3]>,
    n: Vec<u32>,
    /// gain by brightness bin (mean |z| in octaves from 8), for the dependence on brightness
    bins: Vec<([f64; 3], u64)>,
}

impl Acc {
    fn new() -> Acc {
        Acc { g: vec![[0.0; 3]; PIXELS], pc: vec![[0.0; 3]; PIXELS], ps: vec![[0.0; 3]; PIXELS], n: vec![0; PIXELS], bins: vec![([0.0; 3], 0); 10] }
    }
    fn gain(&self, i: usize, k: usize) -> f64 {
        self.g[i][k] / f64::from(self.n[i].max(1))
    }
    fn phase(&self, i: usize, k: usize) -> f64 {
        self.ps[i][k].atan2(self.pc[i][k])
    }
}

fn wrap(a: f64) -> f64 {
    let t = std::f64::consts::TAU;
    a - t * (a / t).round()
}

/// Accumulates frames `a..b` of a recording; with a map, the values are corrected first and the
/// spread of the corrected values is returned instead.
fn run(file: &str, a: usize, b: usize, map: Option<&Acc>) -> (Acc, [Vec<f64>; 3], [Vec<f64>; 3]) {
    let mut r = RawReader::open(std::path::Path::new(file)).unwrap();
    let tables = r.header().tables().unwrap();
    let mut cfg = TofConfig::extended();
    cfg.ext.two_echoes = false;
    let mut d = CpuDecoder::new(cfg).unwrap();
    let mut o = TofOutput::new();
    let mut acc = Acc::new();
    // per frame and pixel (a sample of them): the gain and phase deviation before / after the map
    let (mut raw_g, mut raw_p): ([Vec<f64>; 3], [Vec<f64>; 3]) = Default::default();
    for fr in 0..b {
        let Some(p) = r.next_packet().unwrap() else { break };
        if fr < a {
            continue;
        }
        d.decode(&p, &tables, &mut o).unwrap();
        for i in 0..PIXELS {
            let f = o.flags[i];
            if o.depth.get(i).unwrap_or(0.0) <= 0.0 || f & (flags::SATURATED_ANY | flags::MULTIPATH | flags::EDGE | flags::RESOLVED | flags::REPAIRED_ANY) != 0 {
                continue;
            }
            let Some(info) = d.unwrap_info(i) else { continue };
            let z: [(f32, f32); 3] = std::array::from_fn(|k| d.sample(k, i).unwrap());
            let amp: [f64; 3] = z.map(|(x, y)| f64::from(x.hypot(y)));
            let m = (amp[0] + amp[1] + amp[2]) / 3.0;
            if m < 20.0 || amp.iter().any(|v| *v <= 0.0) {
                continue;
            }
            acc.n[i] += 1;
            let bin = ((m / 8.0).log2().max(0.0) as usize).min(9);
            acc.bins[bin].1 += 1;
            for k in 0..3 {
                let gk = (amp[k] / m).ln();
                let ph = wrap(f64::from(z[k].1).atan2(f64::from(z[k].0)) - std::f64::consts::TAU * f64::from(FREQ_MULTIPLES[k]) * f64::from(info.u1));
                acc.g[i][k] += gk;
                acc.pc[i][k] += ph.cos();
                acc.ps[i][k] += ph.sin();
                acc.bins[bin].0[k] += gk;
                if i % 7 == 0 {
                    let (cg, cp) = match map {
                        Some(mp) if mp.n[i] >= 20 => (mp.gain(i, k), mp.phase(i, k)),
                        _ => (0.0, 0.0),
                    };
                    raw_g[k].push(gk - cg);
                    raw_p[k].push(wrap(ph - cp));
                }
            }
        }
    }
    (acc, raw_g, raw_p)
}

fn sd(v: &[f64]) -> f64 {
    let m = v.iter().sum::<f64>() / v.len().max(1) as f64;
    (v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / v.len().max(1) as f64).sqrt()
}

fn robust_sd(v: &[f64]) -> f64 {
    let mut a: Vec<f64> = v.iter().map(|x| x.abs()).collect();
    a.sort_by(f64::total_cmp);
    a.get(a.len() / 2).copied().unwrap_or(f64::NAN) * 1.4826
}

fn range(s: &str) -> (usize, usize) {
    let (a, b) = s.split_once("..").unwrap();
    (a.parse().unwrap(), b.parse().unwrap())
}

fn main() {
    let mut args = std::env::args().skip(1);
    let file = args.next().unwrap();
    let (mut learn, mut test, mut other) = ((0, 150), (450, 750), None::<String>);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--learn" => learn = range(&args.next().unwrap()),
            "--test" => test = range(&args.next().unwrap()),
            "--other" => other = args.next(),
            other => {
                eprintln!("unknown argument {other}");
                return;
            }
        }
    }
    let (map, _, _) = run(&file, learn.0, learn.1, None);
    let (test_acc, g_raw, p_raw) = run(&file, test.0, test.1, None);
    let (_, g_cor, p_cor) = run(&file, test.0, test.1, Some(&map));
    println!("map from frames {}..{}, tested on {}..{}", learn.0, learn.1, test.0, test.1);
    for k in 0..3 {
        // the two maps against each other: how much of the pattern repeats
        let (mut a, mut b, mut pa, mut pb) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        for i in 0..PIXELS {
            if map.n[i] >= 20 && test_acc.n[i] >= 20 {
                a.push(map.gain(i, k));
                b.push(test_acc.gain(i, k));
                pa.push(map.phase(i, k));
                pb.push(test_acc.phase(i, k));
            }
        }
        let diff: Vec<f64> = a.iter().zip(&b).map(|(x, y)| x - y).collect();
        let pdiff: Vec<f64> = pa.iter().zip(&pb).map(|(x, y)| wrap(x - y)).collect();
        let (ma, mb) = (a.iter().sum::<f64>() / a.len() as f64, b.iter().sum::<f64>() / b.len() as f64);
        let mpa = pa.iter().sum::<f64>() / pa.len() as f64;
        println!(
            "  {} MHz: pixels {:6}  gain map sd {:.4} (test {:.4}), map - test sd {:.4}, mean {:+.4} / {:+.4} | phase map sd {:.4} rad (mean {:+.4}), map - test sd {:.4}",
            [80, 16, 120][k],
            a.len(),
            sd(&a),
            sd(&b),
            sd(&diff),
            ma,
            mb,
            sd(&pa.iter().map(|x| x - mpa).collect::<Vec<_>>()),
            mpa,
            sd(&pdiff)
        );
        println!(
            "      single frames of the test: gain robust sd {:.4} -> {:.4} with the map, phase robust sd {:.4} -> {:.4} rad",
            robust_sd(&g_raw[k].iter().map(|x| x - ma).collect::<Vec<_>>()),
            robust_sd(&g_cor[k]),
            robust_sd(&p_raw[k].iter().map(|x| wrap(x - mpa)).collect::<Vec<_>>()),
            robust_sd(&p_cor[k])
        );
    }
    println!("  gain by brightness (mean |z|), test frames:");
    for (b, (s, n)) in test_acc.bins.iter().enumerate() {
        if *n > 1000 {
            println!("    {:>5.0}-{:<5.0} n {:>8}  {:+.4} {:+.4} {:+.4}", 8.0 * 2f64.powi(b as i32), 8.0 * 2f64.powi(b as i32 + 1), n, s[0] / *n as f64, s[1] / *n as f64, s[2] / *n as f64);
        }
    }
    if let Some(o) = other {
        let (_, g_raw, p_raw) = run(&o, 0, 60, None);
        let (_, g_cor, p_cor) = run(&o, 0, 60, Some(&map));
        println!("other recording {o}, 60 frames, single-echo pixels:");
        for k in 0..3 {
            let mg = g_raw[k].iter().sum::<f64>() / g_raw[k].len() as f64;
            let mp = p_raw[k].iter().sum::<f64>() / p_raw[k].len() as f64;
            println!(
                "  {} MHz: gain robust sd {:.4} -> {:.4}, phase robust sd {:.4} -> {:.4} rad",
                [80, 16, 120][k],
                robust_sd(&g_raw[k].iter().map(|x| x - mg).collect::<Vec<_>>()),
                robust_sd(&g_cor[k].iter().map(|x| x - g_cor[k].iter().sum::<f64>() / g_cor[k].len() as f64).collect::<Vec<_>>()),
                robust_sd(&p_raw[k].iter().map(|x| wrap(x - mp)).collect::<Vec<_>>()),
                robust_sd(&p_cor[k].iter().map(|x| wrap(x - p_cor[k].iter().sum::<f64>() / p_cor[k].len() as f64)).collect::<Vec<_>>())
            );
        }
    }
}
