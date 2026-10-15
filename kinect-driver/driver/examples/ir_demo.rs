//! Pictures of the infrared for simulated scenes: libfreenect2 as kinect-hub shows it today, and
//! the new HDR infrared (`--ir hub`, `--ir even`), all through the hub's display mapping
//! (sqrt, white at 6000), plus the HDR values themselves on a logarithmic scale.
//!   cargo run --release -p kinect-driver --example ir_demo -- OUTDIR [scene ...]
#![allow(clippy::indexing_slicing, clippy::unwrap_used, clippy::expect_used)]

use std::path::Path;
use std::sync::Arc;

use kinect_driver::consts::{HEIGHT, WIDTH};
use kinect_driver::pipeline::{Backend, Pipeline};
use kinect_driver::sim::{Scene, SimConfig, Simulator};
use kinect_driver::stages::IrToneMap;
use kinect_driver::tof::TofConfig;

/// What kinect-hub sends as the `ir` stream (and the pose model and the scenes see).
fn hub_display(ir: &[f32]) -> Vec<u8> {
    ir.iter().map(|v| ((v / 6000.0).clamp(0.0, 1.0).sqrt() * 255.0 + 0.5) as u8).collect()
}

/// The whole range of the HDR values, logarithmic.
fn log_display(ir: &[f32]) -> Vec<u8> {
    let max = ir.iter().copied().fold(1f32, f32::max);
    let scale = 255.0 / (1.0 + max).ln();
    ir.iter().map(|v| ((1.0 + v.max(0.0)).ln() * scale + 0.5).min(255.0) as u8).collect()
}

fn write_gray(path: &Path, data: &[u8]) {
    let file = std::fs::File::create(path).unwrap();
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), WIDTH as u32, HEIGHT as u32);
    enc.set_color(png::ColorType::Grayscale);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(data).unwrap();
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let out = args.next().ok_or("ir_demo OUTDIR [scene ...]")?;
    let out = Path::new(&out);
    std::fs::create_dir_all(out)?;
    let mut scenes: Vec<String> = args.collect();
    if scenes.is_empty() {
        scenes = vec!["visitor".into(), "near".into(), "room".into()];
    }
    for name in &scenes {
        let mut sim = Simulator::new(SimConfig::default())?;
        let tables = sim.tables().clone();
        let scene = Scene::preset(name, 0.6).ok_or("unknown scene")?;
        let (p, gt) = sim.frame(&scene, 1);
        let raw = Arc::new(p);
        let saturated = gt.saturated.iter().filter(|s| **s != 0).count();
        let variants: [(&str, TofConfig, Option<IrToneMap>, bool); 4] = [
            ("1-libfreenect2", TofConfig::compat(), None, false),
            ("2-hub", TofConfig::extended(), Some(IrToneMap::hub()), false),
            ("3-even", TofConfig::extended(), Some(IrToneMap::even()), false),
            ("4-hdr-log", TofConfig::extended(), None, true),
        ];
        println!("{name}: {:.1} % of the pixels saturate the sensor", 100.0 * saturated as f64 / gt.saturated.len() as f64);
        for (label, cfg, tone, log) in variants {
            let mut pipe = Pipeline::decoder(cfg, Backend::Cpu)?;
            if let Some(t) = tone {
                pipe = pipe.with(t);
            }
            let f = pipe.process(raw.clone(), &tables)?;
            let ir = f.ir.to_vec();
            let img = if log { log_display(&ir) } else { hub_display(&ir) };
            let white = img.iter().filter(|v| **v >= 250).count();
            println!("  {label:<16} white (>= 250): {:>5.1} %   IR max {:>8.0}", 100.0 * white as f64 / img.len() as f64, ir.iter().fold(0f32, |m, v| m.max(*v)));
            write_gray(&out.join(format!("{name}-{label}.png")), &img);
        }
    }
    Ok(())
}
