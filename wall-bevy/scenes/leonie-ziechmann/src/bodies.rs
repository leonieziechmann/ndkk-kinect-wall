//! The bodies on a wall grid (common::field, field.js) in a thread of their own: rebuilding the field
//! from a tracking result takes a millisecond or two (sampling the person pixels through the
//! perspective, two distance transforms, the kicks), so frame() only hands each new result over and
//! reads the newest field: at most one result (33 ms) late, which nobody sees. The leaves and the
//! heap read a snapshot (signed distance and kicks) with the field's own sample() and cellAt().

use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};

use super::persp::Placing;
use wall::persons::PersonsResult;
use wall::common::field::BodyField;
use wall::map::WallMap;

/// What the leaves and the heap read of the field.
#[derive(Default)]
pub struct Field {
    pub w: usize,
    pub h: usize,
    pub cell: f32,
    pub seq: u64,
    /// signed distance (m), > 0 outside
    pub sd: Vec<f32>,
    /// kicks (cells moved, along the outline's normal; y up)
    pub kx: Vec<f32>,
    pub ky: Vec<f32>,
}

impl Field {
    fn copy_from(&mut self, f: &BodyField) {
        self.w = f.w;
        self.h = f.h;
        self.cell = f.cell;
        self.seq = f.seq;
        self.sd.clear();
        self.sd.extend_from_slice(&f.sd);
        self.kx.clear();
        self.kx.extend_from_slice(&f.kx);
        self.ky.clear();
        self.ky.extend_from_slice(&f.ky);
    }

    /// The cell at wall point (x, y), if on the grid (cellAt).
    pub fn cell_at(&self, x: f32, y: f32, top: f32) -> Option<usize> {
        let gx = (x / self.cell).floor();
        let gy = ((top - y) / self.cell).floor();
        if gx >= 0.0 && (gx as usize) < self.w && gy >= 0.0 && (gy as usize) < self.h { Some(gy as usize * self.w + gx as usize) } else { None }
    }

    /// Signed distance (m) at wall point (x, y), bilinear, and its gradient (out of the bodies, per
    /// m, y up): [distance, gx, gy] (sample()).
    pub fn sample(&self, x: f32, y: f32, top: f32) -> [f32; 3] {
        let (w, h) = (self.w, self.h);
        if w < 2 || h < 2 || self.sd.len() < w * h {
            return [10.0, 0.0, 0.0];
        }
        let fx = (x / self.cell - 0.5).max(0.0).min(w as f32 - 1.001);
        let fy = ((top - y) / self.cell - 0.5).max(0.0).min(h as f32 - 1.001);
        let (ix, iy) = (fx.floor() as usize, fy.floor() as usize);
        let (tx, ty) = (fx - ix as f32, fy - iy as f32);
        let c = iy * w + ix;
        let (a, b, d, e) = (self.sd[c], self.sd[c + 1], self.sd[c + w], self.sd[c + w + 1]);
        [
            (a * (1.0 - tx) + b * tx) * (1.0 - ty) + (d * (1.0 - tx) + e * tx) * ty,
            ((b - a) * (1.0 - ty) + (e - d) * ty) / self.cell,
            -((d - a) * (1.0 - tx) + (e - b) * tx) / self.cell,
        ]
    }
}

enum Job {
    Update {
        persons: Arc<PersonsResult>,
        rays: Arc<Vec<f32>>,
        x_sign: f32,
        /// the world -> room matrix of this frame
        room: [f32; 16],
        /// the wall (setup and projection) when it changed
        wall: Option<Box<WallMap>>,
        place: Box<Placing>,
        out: Field,
    },
    Clear {
        out: Field,
    },
}

pub struct Bodies {
    jobs: Sender<Job>,
    done: Receiver<Field>,
    /// the newest field (None until the first result)
    pub field: Option<Field>,
    /// snapshots to fill (their buffers are reused)
    pool: Vec<Field>,
    in_flight: usize,
    wall_version: Option<u64>,
}

impl Bodies {
    pub fn new(name: &str, wall: WallMap) -> Result<Self, String> {
        let (jobs, rx) = channel::<Job>();
        let (tx, done) = channel::<Field>();
        std::thread::Builder::new()
            .name(format!("{name} bodies"))
            .spawn(move || {
                let mut field = BodyField::new(0.03);
                let mut wall = wall;
                while let Ok(job) = rx.recv() {
                    let out = match job {
                        Job::Update { persons, rays, x_sign, room, wall: new_wall, place, mut out } => {
                            if let Some(w) = new_wall {
                                wall = *w;
                            }
                            wall.room = room;
                            wall.x_sign = x_sign;
                            let project = |slot: u8, lat: f32, ry: f32, _rz: f32| place.project(slot, lat, ry);
                            field.update(Some(&persons), &rays, x_sign, &wall, &[], Some(&project));
                            out.copy_from(&field);
                            out
                        }
                        Job::Clear { mut out } => {
                            field.clear();
                            out.copy_from(&field);
                            out
                        }
                    };
                    if tx.send(out).is_err() {
                        return;
                    }
                }
            })
            .map_err(|e| format!("Körper-Thread: {e}"))?;
        Ok(Self { jobs, done, field: None, pool: Vec::new(), in_flight: 0, wall_version: None })
    }

    /// Takes the newest finished field (the one before goes back to the pool).
    pub fn poll(&mut self) {
        while let Ok(f) = self.done.try_recv() {
            self.in_flight = self.in_flight.saturating_sub(1);
            if let Some(old) = self.field.replace(f) {
                self.pool.push(old);
            }
        }
    }

    /// A new tracking result: rebuilt in the background (skipped while two are still waiting).
    pub fn update(&mut self, persons: Arc<PersonsResult>, rays: Arc<Vec<f32>>, x_sign: f32, wall: &WallMap, place: &Placing) {
        if self.in_flight >= 2 {
            return;
        }
        let wall_new = (self.wall_version != Some(wall.version)).then(|| Box::new(wall.clone()));
        self.wall_version = Some(wall.version);
        let out = self.pool.pop().unwrap_or_default();
        let job = Job::Update { persons, rays, x_sign, room: wall.room, wall: wall_new, place: Box::new(place.clone()), out };
        if self.jobs.send(job).is_ok() {
            self.in_flight += 1;
        }
    }

    /// Nobody there: everything far outside, no kicks. false: not now (still busy).
    pub fn clear(&mut self) -> bool {
        if self.in_flight >= 2 {
            return false;
        }
        let out = self.pool.pop().unwrap_or_default();
        if self.jobs.send(Job::Clear { out }).is_ok() {
            self.in_flight += 1;
        }
        true
    }
}
