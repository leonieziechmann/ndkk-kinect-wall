//! Sparse optical flow on the infrared image (pyramidal Lucas–Kanade): moves the keypoints of the
//! persons from frame to frame, so the skeletons follow the bodies at the full frame rate although
//! the pose model only runs every few frames. A port of web/lib/persons-flow.js: the same
//! arithmetic (doubles, with the values the JavaScript keeps in Float32Arrays rounded to f32), so
//! both move the points alike.
//!
//! A point is lost in a step where the image has no texture to follow, or where tracking it back
//! does not lead to where it started (occlusion, motion blur); it then moves with the others.

use std::collections::VecDeque;

const EPS: f64 = 0.01; // px: stop iterating below this step

struct Level {
    w: usize,
    h: usize,
    data: Vec<f32>,
}

struct Frame {
    seq: i64,
    pyr: Vec<Level>,
}

/// Settings of FlowTracker::new (the JavaScript's constructor options).
#[derive(Clone, Copy, Debug)]
pub struct FlowOptions {
    pub levels: usize,
    pub radius: i32,
    pub iterations: usize,
    pub history: usize,
    /// smallest eigenvalue of the gradient matrix per window pixel
    pub min_texture: f64,
    /// px: forward-backward error
    pub max_error: f64,
    /// the same for the points marked in track()'s `relax`
    pub relax_texture: f64,
    pub relax_error: f64,
}

impl Default for FlowOptions {
    fn default() -> Self {
        FlowOptions { levels: 3, radius: 5, iterations: 8, history: 10, min_texture: 30.0, max_error: 1.5, relax_texture: 30.0, relax_error: 1.5 }
    }
}

pub struct FlowTracker {
    w: usize,
    h: usize,
    o: FlowOptions,
    /// oldest first
    frames: VecDeque<Frame>,
    /// window: template values and gradients
    wa: Vec<f32>,
    wx: Vec<f32>,
    wy: Vec<f32>,
    ok: [u8; 64],
    dx: [f32; 64],
    dy: [f32; 64],
}

impl FlowTracker {
    pub fn new(width: usize, height: usize, o: FlowOptions) -> FlowTracker {
        let n = ((2 * o.radius + 1) * (2 * o.radius + 1)) as usize;
        FlowTracker {
            w: width,
            h: height,
            o,
            frames: VecDeque::new(),
            wa: vec![0.0; n],
            wx: vec![0.0; n],
            wy: vec![0.0; n],
            ok: [0; 64],
            dx: [0.0; 64],
            dy: [0.0; 64],
        }
    }

    /// The infrared image of frame `seq`; the oldest frame is dropped.
    pub fn push(&mut self, seq: i64, ir: &[u8]) {
        let mut f = if self.frames.len() >= self.o.history { self.frames.pop_front() } else { None }.unwrap_or_else(|| {
            let (mut w, mut h) = (self.w, self.h);
            let mut pyr = Vec::new();
            for _ in 0..self.o.levels {
                pyr.push(Level { w, h, data: vec![0.0; w * h] });
                w >>= 1;
                h >>= 1;
            }
            Frame { seq, pyr }
        });
        f.seq = seq;
        if let Some(l0) = f.pyr.first_mut() {
            for (d, s) in l0.data.iter_mut().zip(ir) {
                *d = f32::from(*s);
            }
        }
        for l in 1..f.pyr.len() {
            let (lower, upper) = f.pyr.split_at_mut(l);
            let a = &lower[l - 1];
            let b = &mut upper[0];
            for y in 0..b.h {
                for x in 0..b.w {
                    let i = 2 * y * a.w + 2 * x;
                    let sum = f64::from(a.data[i]) + f64::from(a.data[i + 1]) + f64::from(a.data[i + a.w]) + f64::from(a.data[i + a.w + 1]);
                    b.data[y * b.w + x] = (0.25 * sum) as f32;
                }
            }
        }
        self.frames.push_back(f);
    }

    pub fn has(&self, seq: i64) -> bool {
        self.frames.iter().any(|f| f.seq == seq)
    }

    /// Moves n points (pts: u, v pairs in pixels of frame `from`) to frame `to`, through all frames
    /// kept in between (backwards if `to` is older). Only points with use[k] = 1 move. A point that
    /// cannot be followed in a step moves like the median of the others (or not at all) and is
    /// tried again in the next step; lost[k] counts such steps in a row. False if a frame is not
    /// kept (nothing moved). check = false skips tracking back.
    #[allow(clippy::too_many_arguments)]
    pub fn track(&mut self, from: i64, to: i64, pts: &mut [f32], n: usize, use_: &[u8], lost: &mut [u8], check: bool, relax: Option<&[u8]>) -> bool {
        if from == to {
            return true;
        }
        let mut a: isize = -1;
        let mut b: isize = -1;
        for (k, f) in self.frames.iter().enumerate() {
            if f.seq == from {
                a = k as isize;
            }
            if f.seq == to {
                b = k as isize;
            }
        }
        if a < 0 || b < 0 {
            return false;
        }
        let dir: isize = if b > a { 1 } else { -1 };
        let mut k = a;
        while k != b {
            let (ki, kj) = (k as usize, (k + dir) as usize);
            let mut m = 0;
            for p in 0..n {
                self.ok[p] = 0;
                if use_[p] == 0 {
                    continue;
                }
                let x = f64::from(pts[2 * p]);
                let y = f64::from(pts[2 * p + 1]);
                let relaxed = relax.is_some_and(|r| r[p] != 0);
                let tex = if relaxed { self.o.relax_texture } else { self.o.min_texture };
                let err = if relaxed { self.o.relax_error } else { self.o.max_error };
                let Some((nx, ny)) = self.lk(ki, kj, x, y, tex) else { continue };
                let (nx, ny) = (f64::from(nx), f64::from(ny));
                // and back: it must come out where it started
                if check {
                    match self.lk(kj, ki, nx, ny, tex) {
                        None => continue,
                        Some((bx, by)) => {
                            let (ex, ey) = (f64::from(bx) - x, f64::from(by) - y);
                            if ex * ex + ey * ey > err * err {
                                continue;
                            }
                        }
                    }
                }
                self.ok[p] = 1;
                lost[p] = 0;
                self.dx[m] = (nx - x) as f32;
                self.dy[m] = (ny - y) as f32;
                m += 1;
                pts[2 * p] = nx as f32;
                pts[2 * p + 1] = ny as f32;
            }
            let mx = if m > 0 { median(&self.dx[..m]) } else { 0.0 };
            let my = if m > 0 { median(&self.dy[..m]) } else { 0.0 };
            for p in 0..n {
                if use_[p] == 0 || self.ok[p] != 0 {
                    continue;
                }
                pts[2 * p] = (f64::from(pts[2 * p]) + mx) as f32;
                pts[2 * p + 1] = (f64::from(pts[2 * p + 1]) + my) as f32;
                lost[p] = lost[p].wrapping_add(1);
            }
            k += dir;
        }
        true
    }

    /// One point from the pyramid of frame `fi` to that of frame `fj` (coarse to fine); None if
    /// lost. The result is what the JavaScript keeps in its Float32Array `out`.
    fn lk(&mut self, fi: usize, fj: usize, x: f64, y: f64, min_texture: f64) -> Option<(f32, f32)> {
        let r = self.o.radius;
        let area = f64::from((2 * r + 1) * (2 * r + 1));
        let (Some(fi), Some(fj)) = (self.frames.get(fi), self.frames.get(fj)) else { return None };
        let (wa, wx, wy) = (&mut self.wa, &mut self.wx, &mut self.wy);
        let mut gx = 0.0_f64;
        let mut gy = 0.0_f64;
        for l in (0..self.o.levels).rev() {
            let a = &fi.pyr[l];
            let b = &fj.pyr[l];
            let s = 1.0 / f64::from(1_u32 << l);
            let px = (x + 0.5) * s - 0.5;
            let py = (y + 0.5) * s - 0.5;
            // template and its gradients
            let (mut gxx, mut gxy, mut gyy) = (0.0_f64, 0.0_f64, 0.0_f64);
            let mut k = 0;
            for dy in -r..=r {
                for dx in -r..=r {
                    let ax = px + f64::from(dx);
                    let ay = py + f64::from(dy);
                    let ix = 0.5 * (sample(a, ax + 1.0, ay) - sample(a, ax - 1.0, ay));
                    let iy = 0.5 * (sample(a, ax, ay + 1.0) - sample(a, ax, ay - 1.0));
                    wa[k] = sample(a, ax, ay) as f32;
                    wx[k] = ix as f32;
                    wy[k] = iy as f32;
                    gxx += ix * ix;
                    gxy += ix * iy;
                    gyy += iy * iy;
                    k += 1;
                }
            }
            let det = gxx * gyy - gxy * gxy;
            let diff = gxx - gyy;
            let min_eig = (gxx + gyy - (diff * diff + 4.0 * gxy * gxy).sqrt()) / 2.0;
            if min_eig < min_texture * area || det <= 0.0 {
                if l == 0 {
                    return None; // nothing to follow here
                }
                gx *= 2.0;
                gy *= 2.0;
                continue;
            }
            let (mut vx, mut vy) = (0.0_f64, 0.0_f64);
            for _ in 0..self.o.iterations {
                let (mut bx, mut by) = (0.0_f64, 0.0_f64);
                let ox = px + gx + vx;
                let oy = py + gy + vy;
                let mut k = 0;
                for dy in -r..=r {
                    for dx in -r..=r {
                        let d = f64::from(wa[k]) - sample(b, ox + f64::from(dx), oy + f64::from(dy));
                        bx += d * f64::from(wx[k]);
                        by += d * f64::from(wy[k]);
                        k += 1;
                    }
                }
                let sx = (gyy * bx - gxy * by) / det;
                let sy = (gxx * by - gxy * bx) / det;
                vx += sx;
                vy += sy;
                if sx * sx + sy * sy < EPS * EPS {
                    break;
                }
            }
            if l > 0 {
                gx = 2.0 * (gx + vx);
                gy = 2.0 * (gy + vy);
            } else {
                gx += vx;
                gy += vy;
            }
        }
        let nx = x + gx;
        let ny = y + gy;
        if !(nx >= 0.0 && ny >= 0.0 && nx <= (self.w - 1) as f64 && ny <= (self.h - 1) as f64) {
            return None;
        }
        Some((nx as f32, ny as f32))
    }
}

/// Median of f32 values (the JavaScript sorts them as numbers; two middles: their mean).
fn median(a: &[f32]) -> f64 {
    let mut s: Vec<f64> = a.iter().map(|v| f64::from(*v)).collect();
    s.sort_by(f64::total_cmp);
    let n = s.len();
    if n & 1 == 1 { s[n >> 1] } else { 0.5 * (s[n / 2 - 1] + s[n / 2]) }
}

/// Bilinear sample of a pyramid level, clamped to the border.
#[inline]
fn sample(l: &Level, x: f64, y: f64) -> f64 {
    let (w, h) = (l.w, l.h);
    let x = if x < 0.0 { 0.0 } else if x > w as f64 - 1.001 { w as f64 - 1.001 } else { x };
    let y = if y < 0.0 { 0.0 } else if y > h as f64 - 1.001 { h as f64 - 1.001 } else { y };
    let x0 = x as usize; // x | 0 for x >= 0
    let y0 = y as usize;
    let fx = x - x0 as f64;
    let fy = y - y0 as f64;
    let d = &l.data;
    let i = y0 * w + x0;
    let (d00, d01, d10, d11) = (f64::from(d[i]), f64::from(d[i + 1]), f64::from(d[i + w]), f64::from(d[i + w + 1]));
    let top = d00 + fx * (d01 - d00);
    let bottom = d10 + fx * (d11 - d10);
    top + fy * (bottom - top)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A textured image shifted by (dx, dy) pixels.
    fn image(w: usize, h: usize, dx: f64, dy: f64) -> Vec<u8> {
        let mut img = vec![0_u8; w * h];
        for y in 0..h {
            for x in 0..w {
                let (fx, fy) = (x as f64 - dx, y as f64 - dy);
                let v = 128.0 + 60.0 * (fx * 0.31).sin() * (fy * 0.23).cos() + 40.0 * ((fx + fy) * 0.11).sin();
                img[y * w + x] = v.clamp(0.0, 255.0) as u8;
            }
        }
        img
    }

    #[test]
    fn follows_a_shift() {
        let (w, h) = (128, 96);
        let mut f = FlowTracker::new(w, h, FlowOptions::default());
        f.push(1, &image(w, h, 0.0, 0.0));
        f.push(2, &image(w, h, 3.0, -2.0));
        let mut pts = [64.0_f32, 48.0, 40.0, 30.0];
        let mut lost = [0_u8; 2];
        assert!(f.track(1, 2, &mut pts, 2, &[1, 1], &mut lost, true, None));
        assert!((pts[0] - 67.0).abs() < 0.3 && (pts[1] - 46.0).abs() < 0.3, "{pts:?}");
        assert_eq!(lost, [0, 0]);
        assert!(!f.track(1, 3, &mut pts, 2, &[1, 1], &mut lost, true, None));
    }
}
