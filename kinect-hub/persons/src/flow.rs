//! Sparse optical flow on the infrared image (pyramidal Lucas–Kanade): moves the keypoints of the
//! persons from frame to frame, so the skeletons follow the bodies at the full frame rate although
//! the pose model only runs every few frames. The method of web/lib/persons-flow.js.
//!
//! Faster than there: all samples of a window share one sub-pixel offset, so a window is one
//! bilinear patch made row by row with fixed weights (f32, vectorized; AVX2 where the CPU has it),
//! and its gradients are differences inside the patch. Near the image border the samples are
//! clamped one by one as in the JavaScript. track() only reads, so several persons can be followed
//! at once from several threads.
//!
//! A point is lost in a step where the image has no texture to follow, or where tracking it back
//! does not lead to where it started (occlusion, motion blur); it then moves with the others.

use std::collections::VecDeque;

const EPS: f64 = 0.01; // px: stop iterating below this step
/// largest window radius (the scratch patches are this big)
const MAX_RADIUS: i32 = 6;
const MAX_N: usize = (2 * MAX_RADIUS as usize + 3) * (2 * MAX_RADIUS as usize + 3);

struct Level {
    w: usize,
    h: usize,
    data: Vec<f32>,
}

struct Frame {
    seq: i64,
    pyr: Vec<Level>,
}

/// Settings of FlowTracker::new.
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
}

impl FlowTracker {
    pub fn new(width: usize, height: usize, mut o: FlowOptions) -> FlowTracker {
        o.radius = o.radius.clamp(1, MAX_RADIUS);
        FlowTracker { w: width, h: height, o, frames: VecDeque::new() }
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
                let r0 = &a.data[2 * y * a.w..2 * y * a.w + 2 * b.w];
                let r1 = &a.data[(2 * y + 1) * a.w..(2 * y + 1) * a.w + 2 * b.w];
                for (x, out) in b.data[y * b.w..(y + 1) * b.w].iter_mut().enumerate() {
                    *out = 0.25 * (r0[2 * x] + r0[2 * x + 1] + r1[2 * x] + r1[2 * x + 1]);
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
    pub fn track(&self, from: i64, to: i64, pts: &mut [f32], n: usize, use_: &[u8], lost: &mut [u8], check: bool, relax: Option<&[u8]>) -> bool {
        if from == to {
            return true;
        }
        let a = self.frames.iter().position(|f| f.seq == from);
        let b = self.frames.iter().position(|f| f.seq == to);
        let (Some(a), Some(b)) = (a, b) else { return false };
        let n = n.min(64);
        let (mut ok, mut dx, mut dy) = ([false; 64], [0.0_f32; 64], [0.0_f32; 64]);
        let steps: Vec<(usize, usize)> = if b > a { (a..b).map(|k| (k, k + 1)).collect() } else { (b + 1..=a).rev().map(|k| (k, k - 1)).collect() };
        for (ki, kj) in steps {
            let (Some(fi), Some(fj)) = (self.frames.get(ki), self.frames.get(kj)) else { return false };
            let mut m = 0;
            for p in 0..n {
                ok[p] = false;
                if use_[p] == 0 {
                    continue;
                }
                let x = f64::from(pts[2 * p]);
                let y = f64::from(pts[2 * p + 1]);
                let relaxed = relax.is_some_and(|r| r[p] != 0);
                let tex = if relaxed { self.o.relax_texture } else { self.o.min_texture };
                let err = if relaxed { self.o.relax_error } else { self.o.max_error };
                let Some((nx, ny)) = self.lk(fi, fj, x, y, tex) else { continue };
                // and back: it must come out where it started
                if check {
                    match self.lk(fj, fi, nx, ny, tex) {
                        None => continue,
                        Some((bx, by)) => {
                            let (ex, ey) = (bx - x, by - y);
                            if ex * ex + ey * ey > err * err {
                                continue;
                            }
                        }
                    }
                }
                ok[p] = true;
                lost[p] = 0;
                dx[m] = (nx - x) as f32;
                dy[m] = (ny - y) as f32;
                m += 1;
                pts[2 * p] = nx as f32;
                pts[2 * p + 1] = ny as f32;
            }
            let mx = if m > 0 { median(&dx[..m]) } else { 0.0 };
            let my = if m > 0 { median(&dy[..m]) } else { 0.0 };
            for p in 0..n {
                if use_[p] == 0 || ok[p] {
                    continue;
                }
                pts[2 * p] = (f64::from(pts[2 * p]) + mx) as f32;
                pts[2 * p + 1] = (f64::from(pts[2 * p + 1]) + my) as f32;
                lost[p] = lost[p].wrapping_add(1);
            }
        }
        true
    }

    /// One point from pyramid `fi` to pyramid `fj` (coarse to fine); None if lost.
    fn lk(&self, fi: &Frame, fj: &Frame, x: f64, y: f64, min_texture: f64) -> Option<(f64, f64)> {
        let r = self.o.radius;
        let n = (2 * r + 1) as usize;
        let area = (n * n) as f64;
        let mut wa = [0.0_f32; MAX_N];
        let mut wx = [0.0_f32; MAX_N];
        let mut wy = [0.0_f32; MAX_N];
        let mut patch = [0.0_f32; MAX_N];
        let mut gx = 0.0_f64;
        let mut gy = 0.0_f64;
        for l in (0..self.o.levels).rev() {
            let a = &fi.pyr[l];
            let b = &fj.pyr[l];
            let s = 1.0 / f64::from(1_u32 << l);
            let px = (x + 0.5) * s - 0.5;
            let py = (y + 0.5) * s - 0.5;
            // template and its gradients
            let (gxx, gxy, gyy) = if let Some((x0, y0, fx, fy)) = grid(a, px - f64::from(r + 1), py - f64::from(r + 1), n + 2) {
                let m = n + 2;
                bilinear(a, x0, y0, fx, fy, m, &mut patch);
                template(&patch, n, &mut wa, &mut wx, &mut wy)
            } else {
                template_clamped(a, px, py, r, &mut wa, &mut wx, &mut wy)
            };
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
                let ox = px + gx + vx;
                let oy = py + gy + vy;
                let (bx, by) = if let Some((x0, y0, fx, fy)) = grid(b, ox - f64::from(r), oy - f64::from(r), n) {
                    bilinear(b, x0, y0, fx, fy, n, &mut patch);
                    mismatch(&patch, &wa, &wx, &wy, n * n)
                } else {
                    mismatch_clamped(b, ox, oy, r, &wa, &wx, &wy)
                };
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
        Some((nx, ny))
    }
}

/// The integer corner and the sub-pixel weights of an m x m grid starting at (x, y), if it lies
/// inside the level with room for the bilinear neighbors (no clamping needed).
#[inline]
fn grid(l: &Level, x: f64, y: f64, m: usize) -> Option<(usize, usize, f32, f32)> {
    let (xf, yf) = (x.floor(), y.floor());
    if xf < 0.0 || yf < 0.0 || xf + m as f64 + 1.0 >= l.w as f64 || yf + m as f64 + 1.0 >= l.h as f64 {
        return None;
    }
    Some((xf as usize, yf as usize, (x - xf) as f32, (y - yf) as f32))
}

/// Bilinear samples on an m x m grid at (x0, y0) + (fx, fy), row by row with fixed weights.
#[inline]
fn bilinear(l: &Level, x0: usize, y0: usize, fx: f32, fy: f32, m: usize, out: &mut [f32]) {
    #[cfg(target_arch = "x86_64")]
    if std::arch::is_x86_feature_detected!("avx2") {
        // SAFETY: the CPU has AVX2 (checked just now)
        unsafe { bilinear_avx2(l, x0, y0, fx, fy, m, out) };
        return;
    }
    bilinear_rows(l, x0, y0, fx, fy, m, out);
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
fn bilinear_avx2(l: &Level, x0: usize, y0: usize, fx: f32, fy: f32, m: usize, out: &mut [f32]) {
    bilinear_rows(l, x0, y0, fx, fy, m, out);
}

#[inline(always)]
fn bilinear_rows(l: &Level, x0: usize, y0: usize, fx: f32, fy: f32, m: usize, out: &mut [f32]) {
    let w = l.w;
    for (r, o) in out[..m * m].chunks_exact_mut(m).enumerate() {
        let top = &l.data[(y0 + r) * w + x0..(y0 + r) * w + x0 + m + 1];
        let bot = &l.data[(y0 + r + 1) * w + x0..(y0 + r + 1) * w + x0 + m + 1];
        for c in 0..m {
            let t = top[c] + fx * (top[c + 1] - top[c]);
            let b = bot[c] + fx * (bot[c + 1] - bot[c]);
            o[c] = t + fy * (b - t);
        }
    }
}

/// Template (the inner n x n of an (n+2) x (n+2) patch) and its central-difference gradients;
/// returns the gradient matrix sums gxx, gxy, gyy.
fn template(p: &[f32], n: usize, wa: &mut [f32], wx: &mut [f32], wy: &mut [f32]) -> (f64, f64, f64) {
    let m = n + 2;
    let (mut gxx, mut gxy, mut gyy) = (0.0_f32, 0.0_f32, 0.0_f32);
    for r in 0..n {
        let up = &p[r * m..r * m + m];
        let mid = &p[(r + 1) * m..(r + 1) * m + m];
        let down = &p[(r + 2) * m..(r + 2) * m + m];
        for c in 0..n {
            let k = r * n + c;
            let ix = 0.5 * (mid[c + 2] - mid[c]);
            let iy = 0.5 * (down[c + 1] - up[c + 1]);
            wa[k] = mid[c + 1];
            wx[k] = ix;
            wy[k] = iy;
            gxx += ix * ix;
            gxy += ix * iy;
            gyy += iy * iy;
        }
    }
    (f64::from(gxx), f64::from(gxy), f64::from(gyy))
}

/// sum of (template - patch) * gradient over the window
#[inline]
fn mismatch(p: &[f32], wa: &[f32], wx: &[f32], wy: &[f32], k: usize) -> (f64, f64) {
    let (mut bx, mut by) = (0.0_f32, 0.0_f32);
    for i in 0..k {
        let d = wa[i] - p[i];
        bx += d * wx[i];
        by += d * wy[i];
    }
    (f64::from(bx), f64::from(by))
}

/// The template near the border: every sample clamped on its own (as persons-flow.js).
fn template_clamped(a: &Level, px: f64, py: f64, r: i32, wa: &mut [f32], wx: &mut [f32], wy: &mut [f32]) -> (f64, f64, f64) {
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
    (gxx, gxy, gyy)
}

fn mismatch_clamped(b: &Level, ox: f64, oy: f64, r: i32, wa: &[f32], wx: &[f32], wy: &[f32]) -> (f64, f64) {
    let (mut bx, mut by) = (0.0_f64, 0.0_f64);
    let mut k = 0;
    for dy in -r..=r {
        for dx in -r..=r {
            let d = f64::from(wa[k]) - sample(b, ox + f64::from(dx), oy + f64::from(dy));
            bx += d * f64::from(wx[k]);
            by += d * f64::from(wy[k]);
            k += 1;
        }
    }
    (bx, by)
}

/// Median of f32 values (two middles: their mean).
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
    let x = x.clamp(0.0, w as f64 - 1.001);
    let y = y.clamp(0.0, h as f64 - 1.001);
    let x0 = x as usize;
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
        let mut pts = [64.0_f32, 48.0, 40.0, 30.0, 2.0, 3.0];
        let mut lost = [0_u8; 3];
        assert!(f.track(1, 2, &mut pts, 3, &[1, 1, 1], &mut lost, true, None));
        assert!((pts[0] - 67.0).abs() < 0.3 && (pts[1] - 46.0).abs() < 0.3, "{pts:?}");
        assert!((pts[2] - 43.0).abs() < 0.3 && (pts[3] - 28.0).abs() < 0.3, "{pts:?}");
        assert_eq!(&lost[..2], &[0, 0]);
        assert!(!f.track(1, 3, &mut pts, 3, &[1, 1, 1], &mut lost, true, None));
        // and back
        let mut back = [67.0_f32, 46.0];
        let mut lost1 = [0_u8; 1];
        assert!(f.track(2, 1, &mut back, 1, &[1], &mut lost1, true, None));
        assert!((back[0] - 64.0).abs() < 0.3 && (back[1] - 48.0).abs() < 0.3, "{back:?}");
    }

    #[test]
    fn patch_matches_clamped_samples() {
        let (w, h) = (64, 48);
        let mut f = FlowTracker::new(w, h, FlowOptions::default());
        f.push(1, &image(w, h, 0.0, 0.0));
        let l = &f.frames[0].pyr[0];
        let (x, y) = (20.37, 17.81);
        let Some((x0, y0, fx, fy)) = grid(l, x, y, 5) else { return };
        let mut p = [0.0_f32; MAX_N];
        bilinear(l, x0, y0, fx, fy, 5, &mut p);
        for r in 0..5 {
            for c in 0..5 {
                let s = sample(l, x + c as f64, y + r as f64);
                assert!((f64::from(p[r * 5 + c]) - s).abs() < 1e-3);
            }
        }
    }
}
