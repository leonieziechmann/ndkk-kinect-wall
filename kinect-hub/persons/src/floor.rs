//! Step 6: the floor (persons-core.js, "6. floor"): RANSAC on what is no person, spread over a few
//! frames; without a visible floor, level below the ankles.

use crate::tracker::PersonTracker;
use crate::{Floor, H, Mode, N, W, hypot3};

/// A floor estimation in progress (32 tries a frame).
pub(crate) struct FloorJob {
    n: usize,
    it: u32,
    best: Option<(f64, f64, f64, f64, i64)>,
}

/// xorshift32, as the JavaScript: the same planes are tried.
fn random(rng: &mut u32) -> f64 {
    let mut x = *rng;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *rng = x;
    f64::from(x) / 4_294_967_296.0
}

impl PersonTracker {
    /// Without a visible floor: level, a little below the ankles of the persons.
    pub(crate) fn feet_step(&mut self) {
        for t in &self.tracks {
            if t.slot == 0 || t.pixels == 0 {
                continue;
            }
            for k in [15, 16] {
                if t.joints[4 * k + 3] != 0.0 && t.uv[3 * k + 2] > 0.5 {
                    self.feet.push(f64::from(t.joints[4 * k + 1]) + 70.0);
                }
            }
        }
        if self.feet.len() > 240 {
            let cut = self.feet.len() - 240;
            self.feet.drain(..cut);
        }
        if self.feet.len() < 12 {
            return;
        }
        let mut ys = self.feet.clone();
        ys.sort_by(f64::total_cmp);
        let y = ys[ys.len() >> 1];
        if !(250.0..=3500.0).contains(&y) {
            return;
        }
        let d = match &self.feet_floor {
            Some(old) => 0.8 * old.d + 0.2 * (y / 1000.0),
            None => y / 1000.0,
        };
        self.feet_floor = Some(Floor { normal: [0.0, -1.0, 0.0], d, height: d, pitch_deg: 0.0, roll_deg: 0.0, support: 0.0, source: "feet" });
    }

    /// Floor estimation, spread over a few frames (RANSAC on what is no person, 32 tries a frame).
    pub(crate) fn floor_step(&mut self, depth: &[u16]) {
        let Some(mut job) = self.floor_job.take() else {
            if self.frame - self.floor_at < if self.floor.is_some() { 60 } else { 15 } {
                return;
            }
            self.floor_at = self.frame;
            let skel = self.options.mode == Mode::Skeleton;
            if self.samples.is_empty() {
                self.samples = vec![0.0; 3 * (N / 16 + 64)];
            }
            let mut n = 0;
            for v in (2..H).step_by(4) {
                for u in (2..W).step_by(4) {
                    let i = v * W + u;
                    let d = depth[i];
                    if self.owner[i] != -1 || !(400..=7000).contains(&d) || (skel && self.near_person[i] != 0) {
                        continue;
                    }
                    let z = f64::from(d) * 0.001;
                    self.samples[3 * n] = (f64::from(self.rays[2 * i]) * z) as f32;
                    self.samples[3 * n + 1] = (f64::from(self.rays[2 * i + 1]) * z) as f32;
                    self.samples[3 * n + 2] = z as f32;
                    n += 1;
                }
            }
            if n >= 300 {
                self.floor_job = Some(FloorJob { n, it: 0, best: None });
            }
            return;
        };
        let n = job.n;
        let tol = 0.03;
        let cos_max = (52.0_f64).to_radians().cos();
        let s = |k: usize| f64::from(self.samples[k]);
        let mut k = 0;
        while k < 32 && job.it < 160 {
            k += 1;
            job.it += 1;
            let a = 3 * (random(&mut self.rng) * n as f64).floor() as usize;
            let b = 3 * (random(&mut self.rng) * n as f64).floor() as usize;
            let c = 3 * (random(&mut self.rng) * n as f64).floor() as usize;
            let (ux, uy, uz) = (s(b) - s(a), s(b + 1) - s(a + 1), s(b + 2) - s(a + 2));
            let (vx, vy, vz) = (s(c) - s(a), s(c + 1) - s(a + 1), s(c + 2) - s(a + 2));
            let mut nx = uy * vz - uz * vy;
            let mut ny = uz * vx - ux * vz;
            let mut nz = ux * vy - uy * vx;
            let len = hypot3(nx, ny, nz);
            if len < 1e-4 {
                continue;
            }
            nx /= len;
            ny /= len;
            nz /= len;
            if ny > 0.0 {
                (nx, ny, nz) = (-nx, -ny, -nz);
            }
            if -ny < cos_max {
                continue; // not horizontal enough (n points up = -y)
            }
            // a sensor on a tripod: looks up to 15° up or 50° down, rolled by 15° at most
            if nz > 0.26 || nz < -0.77 || nx.abs() > 0.26 {
                continue;
            }
            let d = -(nx * s(a) + ny * s(a + 1) + nz * s(a + 2));
            if !(0.25..=3.5).contains(&d) {
                continue; // the sensor is 0.25..3.5 m above it
            }
            let (mut inl, mut below) = (0_i64, 0_i64);
            for q in (0..n).step_by(2) {
                let h = nx * s(3 * q) + ny * s(3 * q + 1) + nz * s(3 * q + 2) + d;
                if h < tol && h > -tol {
                    inl += 1;
                } else if h < -0.08 {
                    below += 1;
                }
            }
            // the floor is the lowest large surface: hardly anything may lie below it
            let score = inl - 4 * below;
            if score > 0 && job.best.is_none_or(|b| score > b.4) {
                job.best = Some((nx, ny, nz, d, score));
            }
        }
        if job.it < 160 {
            self.floor_job = Some(job);
            return;
        }
        let Some((bnx, bny, bnz, bd, _)) = job.best else { return };
        // least squares refinement over the inliers: y = a x + b z + c
        let (mut sxx, mut sxz, mut sx, mut szz, mut sz, mut sxy, mut szy, mut sy) = (0.0_f64, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        let (mut m, mut below) = (0_usize, 0_usize);
        for q in 0..n {
            let (x, y, z) = (s(3 * q), s(3 * q + 1), s(3 * q + 2));
            let h = bnx * x + bny * y + bnz * z + bd;
            if h < -0.08 {
                below += 1;
            }
            if h >= tol || h <= -tol {
                continue;
            }
            sxx += x * x;
            sxz += x * z;
            sx += x;
            szz += z * z;
            sz += z;
            sxy += x * y;
            szy += z * y;
            sy += y;
            m += 1;
        }
        let (mf, nf) = (m as f64, n as f64);
        if mf < (0.05 * nf).max(200.0) || below as f64 > 0.015 * nf {
            return;
        }
        // the inliers must cover an area (not a line along some edges): spread of x/z both ways
        let mx = sx / mf;
        let mz = sz / mf;
        let cxx = sxx / mf - mx * mx;
        let czz = szz / mf - mz * mz;
        let cxz = sxz / mf - mx * mz;
        let half = (cxx - czz) / 2.0;
        let minor = (cxx + czz) / 2.0 - (half * half + cxz * cxz).sqrt();
        if minor.is_nan() || minor <= 0.2 * 0.2 {
            return;
        }
        let Some([pa, pb, pc]) = solve3([sxx, sxz, sx, sxz, szz, sz, sx, sz, mf], [sxy, szy, sy]) else { return };
        let len = hypot3(pa, 1.0, pb);
        let mut normal = [pa / len, -1.0 / len, pb / len];
        let mut d = pc / len;
        let support = mf / nf;
        if d < 0.2 {
            return;
        }
        if let Some(old) = &self.floor {
            let dot = old.normal[0] * normal[0] + old.normal[1] * normal[1] + old.normal[2] * normal[2];
            if dot > (3.0_f64).to_radians().cos() && (old.d - d).abs() < 0.05 {
                // the same floor: smooth it
                let nn = [0, 1, 2].map(|j| 0.8 * old.normal[j] + 0.2 * normal[j]);
                let l = hypot3(nn[0], nn[1], nn[2]);
                normal = nn.map(|x| x / l);
                d = 0.8 * old.d + 0.2 * d;
            } else if support < 1.2 * old.support {
                return; // keep the old one
            }
        }
        let [x, y, z] = normal;
        self.floor = Some(Floor {
            normal,
            d,
            height: d,
            pitch_deg: (-z).atan2(-y).to_degrees(), // > 0: the sensor looks down
            roll_deg: x.atan2(-y).to_degrees(),
            support,
            source: "seen",
        });
    }
}

/// Solves the 3x3 system A x = b (A row-major), None if singular.
fn solve3(a: [f64; 9], b: [f64; 3]) -> Option<[f64; 3]> {
    let [a, bb, c, d, e, f, g, h, i] = a;
    let det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
    if det.abs() < 1e-12 {
        return None;
    }
    let inv = [e * i - f * h, c * h - bb * i, bb * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, bb * g - a * h, a * e - bb * d];
    Some([0, 1, 2].map(|r| (inv[3 * r] * b[0] + inv[3 * r + 1] * b[1] + inv[3 * r + 2] * b[2]) / det))
}
