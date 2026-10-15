//! Once a few frames have gone round, the way of a frame from the isochronous packets through the
//! pipeline allocates nothing but the two small handles of the hand-over (the `Arc` of the raw
//! packet, the `Box` of the event): no image buffers, no per-row vectors, no threads.
//! (Its own test binary: the allocator counts for the whole process.)
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

use kinect_driver::consts::{MIN_DEPTH_ISO_PACKET, SUBPACKET_FOOTER_BYTES};
use kinect_driver::frame::Frame;
use kinect_driver::pipeline::{Backend, Pipeline};
use kinect_driver::protocol::depth_stream::{DepthParserConfig, DepthStreamParser, encode_subpackets};
use kinect_driver::sim::{Scene, SimConfig, Simulator};
use kinect_driver::stages::{IrToneMap, TemporalFilter};
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

#[test]
fn a_frame_allocates_nothing_once_the_buffers_go_round() {
    let mut sim = Simulator::new(SimConfig { supersample: false, ..SimConfig::default() }).unwrap();
    let tables = sim.tables().clone();
    // close enough that parts saturate: the fills and the resolver's expectation run too
    let (raw, _) = sim.frame(&Scene::preset("visitor", 0.3).unwrap(), 1);
    let mut packets = Vec::new();
    let mut footers = Vec::new();
    for sub in encode_subpackets(&raw, (0, 9)) {
        for chunk in sub.chunks(MIN_DEPTH_ISO_PACKET) {
            packets.push(chunk.to_vec());
        }
        footers.push(packets.len() - 1);
        packets.push(Vec::new());
    }
    let pipelines = vec![
        ("compat", Pipeline::decoder(TofConfig::compat(), Backend::Cpu).unwrap()),
        ("extended + hub", Pipeline::decoder(TofConfig::extended(), Backend::Cpu).unwrap().with(IrToneMap::hub())),
        (
            "extended + even + temporal + points",
            Pipeline::decoder(TofConfig::extended(), Backend::Cpu).unwrap().with(IrToneMap::even()).with(TemporalFilter::default()).with_fn("points", {
                let mut points = Vec::new();
                move |f| {
                    f.points_into(&mut points);
                    assert_eq!(points.len(), kinect_driver::consts::PIXELS);
                    Ok(())
                }
            }),
        ),
    ];
    for (name, mut pipeline) in pipelines {
        let mut parser = DepthStreamParser::new(DepthParserConfig::default());
        let mut seq = 1u32;
        let mut run = |frames: u32| {
            let mut done = 0;
            while done < frames {
                for &i in &footers {
                    let p = &mut packets[i];
                    let at = p.len() - SUBPACKET_FOOTER_BYTES + 12;
                    p[at..at + 4].copy_from_slice(&seq.to_le_bytes());
                }
                seq += 1;
                for p in &packets {
                    if let Some(raw) = parser.push(p, true) {
                        let mut frame = Frame::new(Arc::new(raw), tables.clone());
                        pipeline.run(&mut frame).unwrap();
                        assert!(frame.valid_pixels() > 10_000);
                        drop(Box::new(frame));
                        done += 1;
                    }
                }
            }
        };
        run(5);
        let (a, b, l) = (ALLOCS.load(Relaxed), BYTES.load(Relaxed), LARGE.load(Relaxed));
        let frames = 20;
        run(frames);
        let allocs = (ALLOCS.load(Relaxed) - a) as f64 / f64::from(frames);
        let bytes = (BYTES.load(Relaxed) - b) as f64 / f64::from(frames);
        let large = LARGE.load(Relaxed) - l;
        println!("{name}: {allocs:.1} allocations, {bytes:.0} bytes per frame");
        assert_eq!(large, 0, "{name}: no image buffer is allocated");
        assert!(allocs <= 2.5, "{name}: {allocs} allocations per frame");
        assert!(bytes < 2048.0, "{name}: {bytes} bytes per frame");
    }
}
