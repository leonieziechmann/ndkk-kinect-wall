//! Per-pixel gains of the frequencies on a recording of a flat wall: fixed pattern
//! (mean over frames) against frame-to-frame noise, and whether a map from one half of the
//! frames predicts the other half.
#![allow(clippy::unwrap_used, clippy::indexing_slicing)]
use kinect_driver::consts::PIXELS;
use kinect_driver::record::RawReader;
use kinect_driver::tof::{CpuDecoder, TofConfig, TofOutput};
fn main() {
    let mut a = std::env::args().skip(1);
    let f = a.next().unwrap();
    let frames: usize = a.next().unwrap().parse().unwrap();
    let mut r = RawReader::open(std::path::Path::new(&f)).unwrap();
    let tables = r.header().tables().unwrap();
    let mut d = CpuDecoder::new(TofConfig::extended()).unwrap();
    let mut o = TofOutput::new();
    // per half: sum and sum of squares of ln(amp_k / mean amp), count
    let mut acc = vec![[[0f64; 3]; 2]; PIXELS];
    let mut sq = vec![[[0f64; 3]; 2]; PIXELS];
    let mut n = vec![[0u32; 2]; PIXELS];
    for fr in 0..frames {
        let Some(p) = r.next_packet().unwrap() else { break };
        d.decode(&p, &tables, &mut o).unwrap();
        let h = fr % 2;
        for i in 0..PIXELS {
            let amp: [f32; 3] = std::array::from_fn(|k| { let (x, y) = d.sample(k, i).unwrap(); (x * x + y * y).sqrt() });
            let m = (amp[0] + amp[1] + amp[2]) / 3.0;
            if m < 30.0 || o.depth[i] <= 0.0 || amp.iter().any(|v| *v <= 0.0) { continue; }
            n[i][h] += 1;
            for k in 0..3 {
                let l = f64::from((amp[k] / m).ln());
                acc[i][h][k] += l;
                sq[i][h][k] += l * l;
            }
        }
    }
    for k in 0..3 {
        let (mut pat, mut noise, mut pred, mut cnt) = (Vec::new(), Vec::new(), Vec::new(), 0);
        for i in 0..PIXELS {
            if n[i][0] < 10 || n[i][1] < 10 { continue; }
            let m0 = acc[i][0][k] / f64::from(n[i][0]);
            let m1 = acc[i][1][k] / f64::from(n[i][1]);
            let var0 = (sq[i][0][k] / f64::from(n[i][0]) - m0 * m0).max(0.0);
            pat.push(m0);
            noise.push(var0.sqrt());
            pred.push(m1 - m0);
            cnt += 1;
        }
        let mean = pat.iter().sum::<f64>() / pat.len() as f64;
        let sd = |v: &Vec<f64>, c: f64| (v.iter().map(|x| (x - c).powi(2)).sum::<f64>() / v.len() as f64).sqrt();
        let mut ns = noise.clone(); ns.sort_by(f64::total_cmp);
        println!("freq {k}: pixels {cnt}, mean ln(amp/mean) {mean:+.3}, fixed pattern sd {:.4}, single-frame noise median {:.4}, half-to-half difference sd {:.4}", sd(&pat, mean), ns[ns.len() / 2], sd(&pred, 0.0) / std::f64::consts::SQRT_2);
    }
}
