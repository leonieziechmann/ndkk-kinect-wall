//! Diagnostics of the extended decoder on one simulated frame: breakdown of saturated pixels and
//! PNG images (truth, compat, extended, error, flags).
//!   cargo run --release -p kinect-driver --example diag_sim -- SCENE OUTDIR [t]
#![allow(clippy::indexing_slicing, clippy::unwrap_used, clippy::expect_used, clippy::needless_range_loop)]

use std::io::BufWriter;

use kinect_driver::consts::{HEIGHT, PIXELS, WIDTH};
use kinect_driver::sim::{Scene, SimConfig, Simulator};
use kinect_driver::tof::{CpuDecoder, TofConfig, TofOutput, flags};

fn save_gray(path: &str, v: &[f32], lo: f32, hi: f32) -> Result<(), Box<dyn std::error::Error>> {
    let f = std::fs::File::create(path)?;
    let mut e = png::Encoder::new(BufWriter::new(f), WIDTH as u32, HEIGHT as u32);
    e.set_color(png::ColorType::Grayscale);
    e.set_depth(png::BitDepth::Eight);
    let mut w = e.write_header()?;
    let data: Vec<u8> = v.iter().map(|x| if *x <= 0.0 { 0 } else { (((x - lo) / (hi - lo)).clamp(0.0, 1.0) * 254.0 + 1.0) as u8 }).collect();
    w.write_image_data(&data)?;
    Ok(())
}

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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let name = args.get(1).map(String::as_str).unwrap_or("near");
    let dir = args.get(2).map(String::as_str).unwrap_or(".");
    let t: f32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let mut sim = Simulator::new(SimConfig { seed: 7, ..Default::default() })?;
    let tables = sim.tables().clone();
    let scene = Scene::preset(name, t).ok_or("unknown scene")?;
    let (p, gt) = sim.frame(&scene, 0);
    let mut oc = TofOutput::new();
    let mut oe = TofOutput::new();
    CpuDecoder::new(TofConfig::compat())?.decode(&p, &tables, &mut oc)?;
    CpuDecoder::new(TofConfig::extended())?.decode(&p, &tables, &mut oe)?;
    let max_d = gt.depth.iter().copied().fold(0f32, f32::max).max(1000.0);
    let (oc_depth, oe_depth) = (oc.depth.to_vec(), oe.depth.to_vec());
    save_gray(&format!("{dir}/{name}-truth.png"), &gt.depth, 0.0, max_d)?;
    save_gray(&format!("{dir}/{name}-compat.png"), &oc_depth, 0.0, max_d)?;
    save_gray(&format!("{dir}/{name}-extended.png"), &oe_depth, 0.0, max_d)?;
    let ir_t: Vec<f32> = gt.ir.iter().map(|v| v.max(1.0).sqrt()).collect();
    let ir_c: Vec<f32> = oc.ir.iter().map(|v| v.max(1.0).sqrt()).collect();
    let ir_e: Vec<f32> = oe.ir.iter().map(|v| v.max(1.0).sqrt()).collect();
    let ir_hi = ir_t.iter().copied().fold(0f32, f32::max);
    save_gray(&format!("{dir}/{name}-ir-truth.png"), &ir_t, 0.0, ir_hi)?;
    save_gray(&format!("{dir}/{name}-ir-compat.png"), &ir_c, 0.0, ir_hi)?;
    save_gray(&format!("{dir}/{name}-ir-extended.png"), &ir_e, 0.0, ir_hi)?;
    // error map: green = right, red = wrong, blue = missing, black = no truth
    let mut px = vec![[0u8; 3]; PIXELS];
    for i in 0..PIXELS {
        let (tr, d) = (gt.depth[i], oe_depth[i]);
        px[i] = if tr <= 0.0 {
            if d > 0.0 { [255, 0, 255] } else { [0, 0, 0] }
        } else if d <= 0.0 {
            [0, 0, 160]
        } else if (d - tr).abs() <= (0.01 * tr).max(15.0) {
            [0, 200, 0]
        } else if (d - tr).abs() <= (0.05 * tr).max(100.0) {
            [200, 200, 0]
        } else {
            [255, 0, 0]
        };
    }
    save_rgb(&format!("{dir}/{name}-errors.png"), &px)?;
    // saturated pixels: how many frequencies saturated (>= 2 samples), and the outcome
    let mut table = std::collections::BTreeMap::<String, [u64; 4]>::new();
    for i in 0..PIXELS {
        let s = gt.saturated[i];
        if s == 0 || gt.mixed[i] || gt.depth[i] <= 0.0 {
            continue;
        }
        let lost = (s >> 3).count_ones();
        let one = (s & 7).count_ones();
        let fl = oe.flags[i];
        let key = format!(
            "freq w/ >=1 sat {one}, >=2 sat {lost}, repaired {}, single {}",
            (fl & flags::REPAIRED_ANY).count_ones(),
            u8::from(fl & flags::SINGLE_FREQUENCY != 0)
        );
        let (tr, d) = (gt.depth[i], oe_depth[i]);
        let e = table.entry(key).or_default();
        e[0] += 1;
        e[1] += u64::from(d > 0.0);
        e[2] += u64::from(d > 0.0 && (d - tr).abs() <= (0.01 * tr).max(15.0));
        e[3] += u64::from(d > 0.0 && (d - tr).abs() > (0.05 * tr).max(100.0));
    }
    println!("saturated pixels by category: count, with depth, right, wrong");
    for (k, v) in &table {
        println!("  {k:<55} {:>6} {:>6} {:>6} {:>6}", v[0], v[1], v[2], v[3]);
    }
    Ok(())
}
