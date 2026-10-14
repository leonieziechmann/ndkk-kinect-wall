//! What the driver delivers: one [`Frame`] per raw depth packet, filled by the pipeline.

use std::sync::Arc;

use crate::consts::{PIXELS, WIDTH};
use crate::packet::RawDepthPacket;
use crate::pool::Pool;
use crate::tables::DeviceTables;

/// The planes of a frame that are reused: when a decoded frame is dropped they go back to the
/// decoder's pool, and a later frame is decoded into them.
#[derive(Debug, Default)]
pub struct Planes {
    depth: Vec<f32>,
    ir: Vec<f32>,
    confidence: Vec<f32>,
    flags: Vec<u32>,
    points: Vec<[f32; 3]>,
    decoder: String,
}

/// One processed frame. Images are 512 x 424, row-major, row 0 at the top, mirrored the way
/// the Kinect SDK and libfreenect2 deliver them. Planes that no stage produced are empty.
///
/// The planes of a decoded frame come from the decoder's pool and go back there when the frame
/// is dropped: keep a frame as long as you need it, but take what you want to keep longer out
/// of it (`std::mem::take(&mut frame.depth)`) or copy it, so the buffers can go round.
#[derive(Clone, Debug)]
pub struct Frame {
    /// frame sequence number of the device
    pub sequence: u32,
    /// device timestamp
    pub timestamp: u32,
    /// host clock when the raw packet was complete: microseconds since 1970
    pub host_time_us: u64,
    /// the raw packet (kept if the pipeline wants it or a stage needs it)
    pub raw: Option<Arc<RawDepthPacket>>,
    /// the device's tables (camera parameters, rays for point clouds)
    pub tables: Arc<DeviceTables>,
    /// depth in mm (0 = none)
    pub depth: Vec<f32>,
    /// infrared, libfreenect2's scale (HDR in the extended mode until a tone mapping stage)
    pub ir: Vec<f32>,
    /// confidence 0..1 of the depth
    pub confidence: Vec<f32>,
    /// per-pixel flags (`kinect_driver::tof::flags`)
    pub flags: Vec<u32>,
    /// 3D points in mm (x right, y down, z forward), filled by the `Points` stage
    pub points: Vec<[f32; 3]>,
    /// planes added by custom stages
    pub extra: Vec<(String, Vec<f32>)>,
    /// which decoder made depth and infrared
    pub decoder: String,
    /// milliseconds the whole pipeline took
    pub pipeline_ms: f64,
    /// where the planes go when the frame is dropped
    pub(crate) home: Option<Pool<Planes>>,
}

impl Drop for Frame {
    fn drop(&mut self) {
        if let Some(pool) = self.home.take() {
            pool.put(Planes {
                depth: std::mem::take(&mut self.depth),
                ir: std::mem::take(&mut self.ir),
                confidence: std::mem::take(&mut self.confidence),
                flags: std::mem::take(&mut self.flags),
                points: std::mem::take(&mut self.points),
                decoder: std::mem::take(&mut self.decoder),
            });
        }
    }
}

impl Frame {
    /// An empty frame for a raw packet.
    pub fn new(raw: Arc<RawDepthPacket>, tables: Arc<DeviceTables>) -> Frame {
        Frame {
            sequence: raw.sequence,
            timestamp: raw.timestamp,
            host_time_us: raw.host_time_us,
            raw: Some(raw),
            tables,
            depth: Vec::new(),
            ir: Vec::new(),
            confidence: Vec::new(),
            flags: Vec::new(),
            points: Vec::new(),
            extra: Vec::new(),
            decoder: String::new(),
            pipeline_ms: 0.0,
            home: None,
        }
    }

    /// Gives the frame planes from `pool` to be filled (they hold an earlier frame's values
    /// until then), and sends them back there when the frame is dropped. Planes the frame
    /// already has stay; a frame that already belongs to a pool keeps it.
    pub fn use_pool(&mut self, pool: &Pool<Planes>) {
        if self.home.is_some() {
            return;
        }
        let p = pool.take_or(Planes::default);
        let swap_in = |mine: &mut Vec<f32>, theirs: Vec<f32>| {
            if mine.is_empty() {
                *mine = theirs;
            }
        };
        swap_in(&mut self.depth, p.depth);
        swap_in(&mut self.ir, p.ir);
        swap_in(&mut self.confidence, p.confidence);
        if self.flags.is_empty() {
            self.flags = p.flags;
        }
        if self.points.is_empty() {
            self.points = p.points;
            self.points.clear();
        }
        if self.decoder.is_empty() {
            self.decoder = p.decoder;
            self.decoder.clear();
        }
        self.home = Some(pool.clone());
    }

    /// Depth at a pixel (mm, 0 = none).
    pub fn depth_at(&self, x: usize, y: usize) -> f32 {
        if x >= WIDTH {
            return 0.0;
        }
        self.depth.get(y * WIDTH + x).copied().unwrap_or(0.0)
    }

    /// The 3D point of a pixel (mm), if it has depth.
    pub fn point_at(&self, x: usize, y: usize) -> Option<[f32; 3]> {
        let z = self.depth_at(x, y);
        let r = self.tables.rays.get(y * WIDTH + x)?;
        (z > 0.0).then(|| [r[0] * z, r[1] * z, z])
    }

    /// A custom plane by name.
    pub fn extra(&self, name: &str) -> Option<&[f32]> {
        self.extra.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_slice())
    }

    /// Sets (or replaces) a custom plane.
    pub fn set_extra(&mut self, name: &str, plane: Vec<f32>) {
        match self.extra.iter_mut().find(|(n, _)| n == name) {
            Some((_, v)) => *v = plane,
            None => self.extra.push((name.to_string(), plane)),
        }
    }

    /// Pixels with depth.
    pub fn valid_pixels(&self) -> usize {
        self.depth.iter().filter(|d| **d > 0.0).count()
    }

    /// True if the depth plane has the full size.
    pub fn has_depth(&self) -> bool {
        self.depth.len() == PIXELS
    }
}
