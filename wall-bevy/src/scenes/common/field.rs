//! The people on the wall as a grid of cells (port of field.js of modern-events, llg-sakura and
//! leonie-ziechmann): every person pixel mapped onto the wall by the scene's projection (or the
//! scene's own placement), a chamfer distance transform (distance to the nearest body edge: > 0
//! outside, < 0 inside), and kicks where an outline moved (along its normal, fading).

use crate::persons::PersonsResult;
use crate::wall::WallMap;

const EMPTY: f32 = 1e9;
const SQRT2: f32 = std::f32::consts::SQRT_2;

/// A disc on the wall (the mouse in the browser, for testing without people).
#[derive(Clone, Copy, Debug)]
pub struct Disc {
    pub x: f32,
    pub y: f32,
    pub r: f32,
}

#[derive(Default)]
pub struct BodyField {
    pub cell: f32,
    pub w: usize,
    pub h: usize,
    key: (u32, u32),
    /// m² covered
    pub covered: f32,
    pub occ: Vec<u8>,
    tmp: Vec<u8>,
    d_out: Vec<f32>,
    prev_out: Vec<f32>,
    d_in: Vec<f32>,
    /// signed distance (m), > 0 outside
    pub sd: Vec<f32>,
    /// kick (cells moved, along the outline's normal; y up)
    pub kx: Vec<f32>,
    pub ky: Vec<f32>,
    bx: Vec<f32>,
    by: Vec<f32>,
    tx: Vec<f32>,
    ty: Vec<f32>,
    had_bodies: bool,
    pub moving: usize,
    pub seq: u64,
}

impl BodyField {
    pub fn new(cell: f32) -> Self {
        Self { cell, ..Default::default() }
    }

    fn ensure(&mut self, wall_w: f32, wall_h: f32) {
        let key = (wall_w.to_bits(), wall_h.to_bits());
        if key == self.key && self.w > 0 {
            return;
        }
        self.key = key;
        self.w = ((wall_w / self.cell).round() as usize).max(8);
        self.h = ((wall_h / self.cell).round() as usize).max(8);
        let n = self.w * self.h;
        self.occ = vec![0; n];
        self.tmp = vec![0; n];
        self.d_out = vec![0.0; n];
        self.prev_out = vec![EMPTY; n];
        self.d_in = vec![0.0; n];
        self.sd = vec![10.0; n];
        self.kx = vec![0.0; n];
        self.ky = vec![0.0; n];
        self.bx = vec![0.0; n];
        self.by = vec![0.0; n];
        self.tx = vec![0.0; n];
        self.ty = vec![0.0; n];
        self.had_bodies = false;
    }

    /// Rebuilds the field from one tracking result. `project(slot, lat, ry, rz)` -> wall [x, y]:
    /// the scene's own placement; None = the shared wall mapping.
    pub fn update(&mut self, persons: Option<&PersonsResult>, rays: &[f32], x_sign: f32, wall: &WallMap, extra: &[Disc], project: Option<&dyn Fn(u8, f32, f32, f32) -> Option<[f32; 2]>>) {
        let s = &wall.setup;
        self.ensure(s.size_w, s.size_h);
        let (w, h) = (self.w, self.h);
        let inv = 1.0 / self.cell;
        let top = s.bottom + s.size_h;
        self.occ.fill(0);
        if let Some(p) = persons
            && let (Some(indices), Some(labels), Some(depth)) = (&p.indices, &p.labels, &p.depth)
            && p.count > 0
        {
            let m = &wall.room;
            let side = wall.side();
            let [near, far] = wall.zone();
            let stride = (p.count / 16000).max(1);
            let mut k = 0;
            while k < p.count {
                let i = indices[k] as usize;
                k += stride;
                let mm = depth[i];
                if mm < 100 {
                    continue;
                }
                let z = f32::from(mm) * 0.001;
                let wx = x_sign * rays[2 * i] * z;
                let wy = -rays[2 * i + 1] * z;
                let rz = m[2] * wx + m[6] * wy + m[10] * z + m[14];
                if rz < near || rz > far {
                    continue;
                }
                let rx = m[0] * wx + m[4] * wy + m[8] * z + m[12];
                let ry = m[1] * wx + m[5] * wy + m[9] * z + m[13];
                let sl = labels[i];
                let (gx, gy) = match project {
                    Some(f) => {
                        let Some(q) = f(sl, side * rx, ry, rz) else { continue };
                        ((q[0] * inv).floor(), ((top - q[1]) * inv).floor())
                    }
                    None => ((wall.room_x(rx, rz, sl as usize) * inv).floor(), ((top - wall.room_y(ry, sl as usize)) * inv).floor()),
                };
                if gx >= 0.0 && (gx as usize) < w && gy >= 0.0 && (gy as usize) < h {
                    self.occ[gy as usize * w + gx as usize] = 1;
                }
            }
        }
        for d in extra {
            let cx = d.x * inv;
            let cy = (top - d.y) * inv;
            let r = d.r * inv;
            let y0 = (cy - r).floor().max(0.0) as usize;
            let y1 = ((cy + r).ceil() as usize).min(h - 1);
            let x0 = (cx - r).floor().max(0.0) as usize;
            let x1 = ((cx + r).ceil() as usize).min(w - 1);
            for gy in y0..=y1 {
                for gx in x0..=x1 {
                    if (gx as f32 + 0.5 - cx).powi(2) + (gy as f32 + 0.5 - cy).powi(2) <= r * r {
                        self.occ[gy * w + gx] = 1;
                    }
                }
            }
        }
        // close holes between sampled pixels, drop single specks
        self.tmp.copy_from_slice(&self.occ);
        let mut covered = 0usize;
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                let c = y * w + x;
                let t = &self.tmp;
                let n = t[c - w - 1] + t[c - w] + t[c - w + 1] + t[c - 1] + t[c + 1] + t[c + w - 1] + t[c + w] + t[c + w + 1];
                if t[c] == 0 && n >= 5 {
                    self.occ[c] = 1;
                } else if t[c] != 0 && n == 0 {
                    self.occ[c] = 0;
                }
                covered += self.occ[c] as usize;
            }
        }
        self.covered = covered as f32 * self.cell * self.cell;
        std::mem::swap(&mut self.prev_out, &mut self.d_out);
        chamfer(&mut self.d_out, &self.occ, w, h, 1);
        chamfer(&mut self.d_in, &self.occ, w, h, 0);
        for c in 0..self.sd.len() {
            self.sd[c] = (if self.occ[c] != 0 { 0.5 - self.d_in[c] } else { self.d_out[c] - 0.5 }) * self.cell;
        }
        let compare = covered > 0 && self.had_bodies;
        self.kicks(compare);
        self.had_bodies = covered > 0;
    }

    fn kicks(&mut self, compare: bool) {
        let (w, h) = (self.w, self.h);
        let fade = 0.45;
        self.bx.fill(0.0);
        self.by.fill(0.0);
        let mut moving = 0;
        if compare {
            for y in 1..h - 1 {
                for x in 1..w - 1 {
                    let c = y * w + x;
                    if self.occ[c] == 0 || self.d_in[c] > 3.0 {
                        continue;
                    }
                    let moved = (self.prev_out[c] - 1.5).min(3.0);
                    if moved <= 0.0 {
                        continue;
                    }
                    let gx = self.sd[c + 1] - self.sd[c - 1];
                    let gy = self.sd[c - w] - self.sd[c + w];
                    let gl = gx.hypot(gy);
                    if gl < 1e-6 {
                        continue;
                    }
                    self.bx[c] = gx / gl * moved;
                    self.by[c] = gy / gl * moved;
                    moving += 1;
                }
            }
        }
        self.moving = moving;
        const R: isize = 3;
        let (wi, hi) = (w as isize, h as isize);
        for (src, dst) in [(&self.bx, &mut self.tx), (&self.by, &mut self.ty)] {
            for y in 0..hi {
                let mut acc = 0.0;
                let row = y * wi;
                for x in -R..wi {
                    if x + R < wi {
                        acc += src[(row + x + R) as usize];
                    }
                    if x - R > 0 {
                        acc -= src[(row + x - R - 1) as usize];
                    }
                    if x >= 0 {
                        dst[(row + x) as usize] = acc;
                    }
                }
            }
        }
        let norm = 1.0 / (2 * R + 1) as f32;
        for x in 0..wi {
            let (mut ax, mut ay) = (0.0, 0.0);
            for y in -R..hi {
                if y + R < hi {
                    ax += self.tx[((y + R) * wi + x) as usize];
                    ay += self.ty[((y + R) * wi + x) as usize];
                }
                if y - R > 0 {
                    ax -= self.tx[((y - R - 1) * wi + x) as usize];
                    ay -= self.ty[((y - R - 1) * wi + x) as usize];
                }
                if y >= 0 {
                    let c = (y * wi + x) as usize;
                    self.kx[c] = self.kx[c] * fade + ax * norm;
                    self.ky[c] = self.ky[c] * fade + ay * norm;
                }
            }
        }
        self.seq += 1;
    }

    /// Nobody there: everything far outside, no kicks.
    pub fn clear(&mut self) {
        if self.w == 0 {
            return;
        }
        self.sd.fill(10.0);
        self.occ.fill(0);
        self.kx.fill(0.0);
        self.ky.fill(0.0);
        self.prev_out.fill(EMPTY);
        self.covered = 0.0;
        self.moving = 0;
        self.had_bodies = false;
    }

    /// The cell at wall point (x, y), if on the grid.
    pub fn cell_at(&self, x: f32, y: f32, top: f32) -> Option<usize> {
        let gx = (x / self.cell).floor();
        let gy = ((top - y) / self.cell).floor();
        if gx >= 0.0 && (gx as usize) < self.w && gy >= 0.0 && (gy as usize) < self.h { Some(gy as usize * self.w + gx as usize) } else { None }
    }

    /// Signed distance (m) at wall point (x, y), bilinear, and its gradient (out of the bodies,
    /// per m, y up): [distance, gx, gy].
    pub fn sample(&self, x: f32, y: f32, top: f32) -> [f32; 3] {
        let (w, h) = (self.w, self.h);
        if w == 0 {
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

/// distance (cells) of every cell to the nearest cell with occ == target: two-pass chamfer 1 / sqrt 2
fn chamfer(d: &mut [f32], occ: &[u8], w: usize, h: usize, target: u8) {
    for c in 0..d.len() {
        d[c] = if occ[c] == target { 0.0 } else { EMPTY };
    }
    for y in 0..h {
        for x in 0..w {
            let c = y * w + x;
            let mut v = d[c];
            if v == 0.0 {
                continue;
            }
            if x > 0 {
                v = v.min(d[c - 1] + 1.0);
            }
            if y > 0 {
                v = v.min(d[c - w] + 1.0);
                if x > 0 {
                    v = v.min(d[c - w - 1] + SQRT2);
                }
                if x < w - 1 {
                    v = v.min(d[c - w + 1] + SQRT2);
                }
            }
            d[c] = v;
        }
    }
    for y in (0..h).rev() {
        for x in (0..w).rev() {
            let c = y * w + x;
            let mut v = d[c];
            if v == 0.0 {
                continue;
            }
            if x < w - 1 {
                v = v.min(d[c + 1] + 1.0);
            }
            if y < h - 1 {
                v = v.min(d[c + w] + 1.0);
                if x < w - 1 {
                    v = v.min(d[c + w + 1] + SQRT2);
                }
                if x > 0 {
                    v = v.min(d[c + w - 1] + SQRT2);
                }
            }
            d[c] = v;
        }
    }
}
