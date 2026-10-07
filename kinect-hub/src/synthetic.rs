//! A generated test scene (room with a moving figure and a bouncing ball) at 30 fps, fed through
//! the same pipeline as real frames. Lets clients be developed without a Kinect attached.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tracing::{error, info};

use crate::lut::undistorted_rays;
use crate::pipeline::Pipeline;
use crate::protocol::{FLAG_HAS_IR, PIXELS, WorkerHeader, WorkerKind};
use crate::source::{panic_message, sleep_unless_stopping};
use crate::state::{CameraParams, Hub, SensorState, now_us};

const FRAME_TIME: Duration = Duration::from_micros(33_333);

struct Sphere {
    c: [f32; 3],
    r: f32,
}

/// Small deterministic noise source (xorshift).
struct Noise(u32);

impl Noise {
    fn next(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (x >> 8) as f32 / (1u32 << 24) as f32
    }

    /// Roughly normal distributed, mean 0, sigma 1.
    fn gauss(&mut self) -> f32 {
        (self.next() + self.next() + self.next() + self.next() - 2.0) * 1.732
    }
}

fn scene(t: f32) -> Vec<Sphere> {
    let px = 0.55 * (0.5 * t).sin();
    let pz = 2.4 + 0.35 * (0.33 * t).cos();
    let bob = 0.02 * (2.0 * t).sin();
    let arm = 0.9 * t;
    let mut s = vec![
        Sphere { c: [px, -0.48 + bob, pz], r: 0.11 },                 // head
        Sphere { c: [px, -0.16 + bob, pz], r: 0.19 },                 // chest
        Sphere { c: [px, 0.12 + bob, pz + 0.02], r: 0.17 },           // belly
        Sphere { c: [px - 0.1, 0.45, pz], r: 0.1 },                   // legs
        Sphere { c: [px + 0.1, 0.45, pz], r: 0.1 },
        Sphere { c: [px - 0.1, 0.7, pz], r: 0.09 },
        Sphere { c: [px + 0.1, 0.7, pz], r: 0.09 },
        Sphere { c: [px - 0.28, -0.05 + 0.15 * arm.sin(), pz - 0.1 * arm.cos()], r: 0.07 }, // hands
        Sphere { c: [px + 0.28, -0.05 - 0.15 * arm.sin(), pz + 0.1 * arm.cos()], r: 0.07 },
    ];
    let ball_y = 0.85 - 0.15 - 0.7 * (1.6 * t).sin().abs();
    s.push(Sphere { c: [-0.9, ball_y, 2.0], r: 0.15 });
    s
}

fn trace(x: f32, y: f32, spheres: &[Sphere]) -> f32 {
    // ray direction (x, y, 1): the hit parameter t equals the depth z
    let mut best = f32::INFINITY;
    if y > 0.0 {
        best = best.min(0.85 / y); // floor 85 cm below the sensor
    }
    best = best.min(4.2); // back wall
    if x < 0.0 {
        best = best.min(-1.9 / x);
    } else if x > 0.0 {
        best = best.min(2.2 / x);
    }
    let a = x * x + y * y + 1.0;
    for s in spheres {
        let [cx, cy, cz] = s.c;
        let b = x * cx + y * cy + cz;
        let c = cx * cx + cy * cy + cz * cz - s.r * s.r;
        let disc = b * b - a * c;
        if disc > 0.0 {
            let t = (b - disc.sqrt()) / a;
            if t > 0.0 && t < best {
                best = t;
            }
        }
    }
    best
}

pub fn run(hub: &Arc<Hub>) {
    let mut pipeline = Pipeline::new(hub.clone());
    let params = CameraParams { serial: "SYNTHETIC".to_string(), firmware: "synthetic".to_string(), ..CameraParams::default_kinect() };
    let rays = undistorted_rays(&params);
    pipeline.set_params(params);
    hub.set_sensor(SensorState::Streaming, "synthetic test scene");
    info!("synthetic source running");

    let mut noise = Noise(0x1234_5678);
    let mut payload = vec![0u8; PIXELS * 8];
    let start = Instant::now();
    let mut seq: u32 = 0;
    while !hub.stopping() {
        let t = start.elapsed().as_secs_f32();
        let spheres = scene(t);
        let (depth_part, ir_part) = payload.split_at_mut(PIXELS * 4);
        let pixels = rays.as_chunks::<2>().0.iter().zip(depth_part.as_chunks_mut::<4>().0).zip(ir_part.as_chunks_mut::<4>().0);
        for ((&[x, y], d_out), ir_out) in pixels {
            let z = trace(x, y, &spheres);
            let (depth_mm, ir) = if (0.5..4.5).contains(&z) && noise.next() > 0.004 {
                let z_noisy = z + noise.gauss() * 0.0012 * z * z;
                (z_noisy * 1000.0, (2500.0 / (z * z)) * (0.85 + 0.15 * noise.next()))
            } else {
                (0.0, 40.0 * noise.next())
            };
            *d_out = depth_mm.to_le_bytes();
            *ir_out = ir.to_le_bytes();
        }
        let header = WorkerHeader {
            kind: WorkerKind::Frame,
            flags: FLAG_HAS_IR,
            payload_len: payload.len(),
            seq,
            device_ts: seq.wrapping_mul(267),
            host_time_us: now_us(),
        };
        match catch_unwind(AssertUnwindSafe(|| pipeline.on_frame(&header, &payload))) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => error!("synthetic frame dropped: {e}"),
            Err(p) => {
                hub.metrics().panics_caught += 1;
                error!("panic in frame processing: {}", panic_message(p.as_ref()));
            }
        }
        seq = seq.wrapping_add(1);
        let next = FRAME_TIME * seq.min(u32::MAX / 2);
        let elapsed = start.elapsed();
        if next > elapsed {
            sleep_unless_stopping(hub, next - elapsed);
        }
    }
}
