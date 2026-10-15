//! Counts the heap allocations per frame on the way a frame takes through the driver: the
//! reassembly of the isochronous packets, the pipeline, the hand-over to the application; and
//! the whole driver (its threads and queues) playing a recording.
//!   cargo run --release -p kinect-driver --example alloc_count [--features gpu]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};

use kinect_driver::consts::MIN_DEPTH_ISO_PACKET;
use kinect_driver::driver::{Driver, DriverConfig, Event, Source};
use kinect_driver::frame::Frame;
use kinect_driver::record::{RawHeader, RawWriter};
use kinect_driver::pipeline::{Backend, Pipeline};
use kinect_driver::protocol::depth_stream::{DepthParserConfig, DepthStreamParser, encode_subpackets};
use kinect_driver::sim::{Scene, SimConfig, Simulator};
use kinect_driver::stages::IrToneMap;
use kinect_driver::tof::TofConfig;

struct Counting;

static ALLOCS: AtomicU64 = AtomicU64::new(0);
static BYTES: AtomicU64 = AtomicU64::new(0);
static LARGE: AtomicU64 = AtomicU64::new(0);

fn note(size: usize) {
    ALLOCS.fetch_add(1, Relaxed);
    BYTES.fetch_add(size as u64, Relaxed);
    if size >= 64 * 1024 {
        LARGE.fetch_add(1, Relaxed);
    }
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        note(l.size());
        unsafe { System.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        note(l.size());
        unsafe { System.alloc_zeroed(l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        note(new);
        unsafe { System.realloc(p, l, new) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

fn snapshot() -> (u64, u64, u64) {
    (ALLOCS.load(Relaxed), BYTES.load(Relaxed), LARGE.load(Relaxed))
}

/// The isochronous packets of one frame as the device sends them (full packets, the short last
/// one of each sub-image, two empty ones in between), and where each footer's sequence is.
fn iso_packets(raw: &kinect_driver::RawDepthPacket) -> (Vec<Vec<u8>>, Vec<usize>) {
    let mut out = Vec::new();
    let mut footers = Vec::new();
    for sub in encode_subpackets(raw, (0, 9)) {
        for chunk in sub.chunks(MIN_DEPTH_ISO_PACKET) {
            out.push(chunk.to_vec());
        }
        footers.push(out.len() - 1);
        out.push(Vec::new());
        out.push(Vec::new());
    }
    (out, footers)
}

fn set_sequence(packets: &mut [Vec<u8>], footers: &[usize], seq: u32) {
    for &i in footers {
        let p = &mut packets[i];
        let at = p.len() - 152 + 12;
        p[at..at + 4].copy_from_slice(&seq.to_le_bytes());
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut sim = Simulator::new(SimConfig { supersample: false, ..SimConfig::default() })?;
    let tables = sim.tables().clone();
    let (raw, _) = sim.frame(&Scene::preset("visitor", 0.3).ok_or("scene")?, 1);
    let (mut packets, footers) = iso_packets(&raw);
    let warmup = 10u32;
    let frames = 60u32;

    let variants: Vec<(&str, Pipeline)> = vec![
        ("parser only", Pipeline::new()),
        ("compat, cpu", Pipeline::decoder(TofConfig::compat(), Backend::Cpu)?),
        ("extended, cpu, ir hub", Pipeline::decoder(TofConfig::extended(), Backend::Cpu)?.with(IrToneMap::hub())),
        ("extended, cpu, ir even", Pipeline::decoder(TofConfig::extended(), Backend::Cpu)?.with(IrToneMap::even())),
        (
            "extended, cpu, hub + points",
            Pipeline::decoder(TofConfig::extended(), Backend::Cpu)?.with(IrToneMap::hub()).with_fn("points", {
                let mut points = Vec::new();
                move |f| {
                    f.points_into(&mut points);
                    Ok(())
                }
            }),
        ),
        #[cfg(feature = "gpu")]
        ("extended, gpu, ir hub", Pipeline::decoder(TofConfig::extended(), Backend::Gpu)?.with(IrToneMap::hub())),
    ];
    println!("{:<30} {:>12} {:>14} {:>12} {:>10}", "per frame", "allocations", "bytes", ">= 64 KB", "ms");
    for (name, mut pipeline) in variants {
        let mut parser = DepthStreamParser::new(DepthParserConfig::default());
        let mut seq = 100u32;
        let mut run = |n: u32, parser: &mut DepthStreamParser, pipeline: &mut Pipeline| {
            let mut done = 0;
            while done < n {
                set_sequence(&mut packets, &footers, seq);
                seq += 1;
                for p in &packets {
                    if let Some(raw) = parser.push(p, true) {
                        // what the driver does with it: shared with the processing thread, a
                        // frame through the pipeline, boxed into an event, dropped by the app
                        let mut frame = Frame::new(Arc::new(raw), tables.clone());
                        pipeline.run(&mut frame).unwrap();
                        let event = Box::new(frame);
                        drop(event);
                        done += 1;
                    }
                }
            }
        };
        run(warmup, &mut parser, &mut pipeline);
        let before = snapshot();
        let t = Instant::now();
        run(frames, &mut parser, &mut pipeline);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        let after = snapshot();
        let n = f64::from(frames);
        println!(
            "{name:<30} {:>12.1} {:>14.0} {:>12.1} {:>10.2}",
            (after.0 - before.0) as f64 / n,
            (after.1 - before.1) as f64 / n,
            (after.2 - before.2) as f64 / n,
            ms / n
        );
    }

    // the whole driver: a recording played as fast as the pipeline takes it
    let dir = std::env::temp_dir().join(format!("kinect-alloc-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("visitor.k2raw");
    let mut w = RawWriter::create(&path, &RawHeader::from_tables(&tables))?;
    for n in 0..3 {
        let (p, _) = sim.frame(&Scene::preset("visitor", n as f32 / 30.0).ok_or("scene")?, n);
        w.write(&p)?;
    }
    drop(w);
    let cfg = DriverConfig {
        source: Source::Recording { path: path.clone(), realtime: false, looped: true },
        pipeline: Some(Arc::new(|| Ok(Pipeline::decoder(TofConfig::extended(), Backend::Cpu)?.with(IrToneMap::hub())))),
        ..DriverConfig::default()
    };
    let driver = Driver::start(cfg)?;
    let count = |n: u32| -> u32 {
        let mut got = 0;
        while got < n {
            match driver.recv_timeout(Duration::from_secs(5)) {
                Some(Event::Frame(f)) => {
                    got += 1;
                    drop(f);
                }
                Some(_) => {}
                None => break,
            }
        }
        got
    };
    count(10);
    let before = snapshot();
    let t = Instant::now();
    let got = count(frames);
    let ms = t.elapsed().as_secs_f64() * 1000.0;
    let after = snapshot();
    let n = f64::from(got.max(1));
    println!(
        "{:<30} {:>12.1} {:>14.0} {:>12.1} {:>10.2}",
        "driver, recording, cpu, hub",
        (after.0 - before.0) as f64 / n,
        (after.1 - before.1) as f64 / n,
        (after.2 - before.2) as f64 / n,
        ms / n
    );
    driver.stop();
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}
