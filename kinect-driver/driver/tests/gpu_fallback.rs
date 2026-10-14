//! Without a usable GPU the GPU backend decodes on the CPU instead of failing.
#![cfg(feature = "gpu")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing, clippy::panic)]

use kinect_driver::gpu::FallbackDecoder;
use kinect_driver::pipeline::{Backend, Pipeline, TofDecoder};
use kinect_driver::sim::{Scene, SimConfig, Simulator};
use kinect_driver::tof::{TofConfig, TofOutput};
use kinect_driver::{Frame, RawDepthPacket};
use std::sync::Arc;

#[test]
fn no_gpu_means_cpu() {
    // a backend this platform does not have: wgpu finds no adapter
    let missing = if cfg!(target_os = "macos") { "dx12" } else { "metal" };
    // SAFETY: set before any other thread of this test binary reads the environment
    unsafe { std::env::set_var("WGPU_BACKEND", missing) };
    let mut d = FallbackDecoder::new(TofConfig::extended()).unwrap();
    assert!(!d.on_gpu());
    assert!(!d.reason().is_empty());
    assert!(d.describe().contains("no GPU"), "{}", d.describe());
    let mut sim = Simulator::new(SimConfig { supersample: false, ..Default::default() }).unwrap();
    let tables = sim.tables().clone();
    let (p, _) = sim.frame(&Scene::preset("room", 0.0).unwrap(), 1);
    let mut out = TofOutput::new();
    d.decode(&p, &tables, &mut out).unwrap();
    assert!(out.depth.iter().filter(|v| **v > 0.0).count() > 100_000);
    // the same through the pipeline API
    let mut pipe = Pipeline::decoder(TofConfig::compat(), Backend::Gpu).unwrap();
    let mut f = Frame::new(Arc::new(p), tables.clone());
    pipe.run(&mut f).unwrap();
    assert!(f.valid_pixels() > 100_000);
    // an empty packet decodes to nothing, without an error
    let mut empty = Frame::new(Arc::new(RawDepthPacket::zeroed(1, 1)), tables);
    pipe.run(&mut empty).unwrap();
    assert_eq!(empty.valid_pixels(), 0);
}
