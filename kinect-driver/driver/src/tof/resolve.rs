//! Extended mode, stage 3a: the neighbors decide where a pixel alone cannot.
//!
//! - Two or three frequencies, but the best and the second best distance are close in cost
//!   (weak signal, far away): the candidate the confident neighbors agree with wins.
//! - One frequency only (the others saturated, very close; or too weak): its distance is known
//!   up to a multiple of its period (1.25 m at 120 MHz, 1.875 m at 80 MHz, 9.375 m at 16 MHz).
//!   The candidate the confident neighbors vote for wins; inside a large saturated area, where
//!   no confident pixel is near, the smooth expectation filled in from around the area decides;
//!   failing that, a saturated pixel is assumed to be near (it is bright).
//!
//! Scalar code: only the few ambiguous pixels do real work here.

#![allow(clippy::indexing_slicing)]

use super::kernels::{RowFlags, depth_of_u, flags, kind, u_of_depth};
use crate::consts::{FREQ_MULTIPLES, HEIGHT, WIDTH};

const W: usize = WIDTH;

pub use super::kernels::ANCHOR_CONFIDENCE;
/// Confidence above which a pixel is not reconsidered.
pub const SURE_CONFIDENCE: f32 = 0.9;
/// A pixel whose best distance is this confident and far ahead of the second needs no support.
pub const CONFIRMED_CONFIDENCE: f32 = 0.75;

/// The whole-image inputs of the resolver. Stage 2 stores its planes row-interleaved (row y:
/// `planes` rows of `WIDTH`, one per plane); the accessors below read them.
pub struct ResolveIn<'a> {
    /// stage 2 float planes (u1, u2, e1, e2, conf, csingle, ir_sum, anchor)
    pub s2: &'a [f32],
    /// number of float planes
    pub p2: usize,
    /// stage 2 byte planes (edge_ok, kind)
    pub s2b: &'a [u8],
    /// number of byte planes
    pub p2b: usize,
    /// smooth expectation of `u` filled from the confident pixels (push-pull), 0 = none
    pub expected: &'a [f32],
    /// x table
    pub xt: &'a [f32],
    /// z table
    pub zt: &'a [f32],
    /// neighborhood radius
    pub radius: usize,
    /// near assumption for saturated single-frequency pixels, mm (0 = off)
    pub near_prior_mm: f32,
    /// the confidence threshold of the output (pixels above it that cannot switch are left alone)
    pub min_conf: f32,
}

/// Float plane indices of stage 2 (extended).
pub mod plane {
    /// best u
    pub const U1: usize = 0;
    /// second best u
    pub const U2: usize = 1;
    /// cost of the best
    pub const E1: usize = 2;
    /// cost of the second best
    pub const E2: usize = 3;
    /// confidence
    pub const CONF: usize = 4;
    /// phase of the single frequency
    pub const CSINGLE: usize = 5;
    /// amplitude sum
    pub const IR_SUM: usize = 6;
    /// anchor weight: the confidence if the pixel is a reliable multi-frequency result, else 0
    pub const ANCHOR: usize = 7;
    /// byte plane: bilateral edge test
    pub const EDGE_OK: usize = 0;
    /// byte plane: kind
    pub const KIND: usize = 1;
    /// byte plane: saturation bits
    pub const SAT: usize = 2;
}

/// One row of a stage-2 float plane.
fn frow<'a>(i: &ResolveIn<'a>, p: usize, y: usize) -> Option<&'a [f32]> {
    let start = (y * i.p2 + p) * W;
    i.s2.get(start..start + W)
}

/// One row of a stage-2 byte plane.
fn brow<'a>(i: &ResolveIn<'a>, p: usize, y: usize) -> Option<&'a [u8]> {
    let start = (y * i.p2b + p) * W;
    i.s2b.get(start..start + W)
}

/// Rows of the largest window (`spatial_radius` is at most 16).
const WINDOW_ROWS: usize = 33;

type WindowRow<'a> = (&'a [f32], &'a [f32], &'a [u8]);

/// The rows of the neighborhood window: u1, anchor weight, saturation bits.
struct Window<'a> {
    rows: [WindowRow<'a>; WINDOW_ROWS],
    n: usize,
}

impl<'a> Window<'a> {
    fn rows(&self) -> &[WindowRow<'a>] {
        self.rows.get(..self.n).unwrap_or(&[])
    }
}

/// Resolves one row: writes the depth (mm, 0 = none) and confidence, adds flags.
pub fn resolve_row(i: &ResolveIn, y: usize, depth: &mut [f32], conf_out: &mut [f32], fl: &mut RowFlags) {
    let r = i.radius;
    let (Some(u1r), Some(u2r), Some(e1r), Some(e2r), Some(cr), Some(csr), Some(kr)) = (
        frow(i, plane::U1, y),
        frow(i, plane::U2, y),
        frow(i, plane::E1, y),
        frow(i, plane::E2, y),
        frow(i, plane::CONF, y),
        frow(i, plane::CSINGLE, y),
        brow(i, plane::KIND, y),
    ) else {
        return;
    };
    let (Some(xtr), Some(ztr), Some(anr)) = (i.xt.get(y * W..(y + 1) * W), i.zt.get(y * W..(y + 1) * W), frow(i, plane::ANCHOR, y)) else { return };
    let mut window = Window { rows: [(&[], &[], &[]); WINDOW_ROWS], n: 0 };
    for yy in y.saturating_sub(r)..=(y + r).min(HEIGHT - 1) {
        if let (Some(u), Some(a), Some(sat)) = (frow(i, plane::U1, yy), frow(i, plane::ANCHOR, yy), brow(i, plane::SAT, yy))
            && let Some(slot) = window.rows.get_mut(window.n)
        {
            *slot = (u, a, sat);
            window.n += 1;
        }
    }
    let rows = u1r.iter().zip(u2r).zip(e1r.iter().zip(e2r)).zip(cr.iter().zip(csr)).zip(kr.iter().zip(xtr.iter().zip(ztr)));
    for (x, ((((&u1, &u2), (&e1, &e2)), (&c, &cref)), (&k, (&xt, &zt)))) in rows.enumerate() {
        let (Some(d_out), Some(c_out), Some(f)) = (depth.get_mut(x), conf_out.get_mut(x), fl.get_mut(x)) else { continue };
        let base = k & 0x0f;
        if base == kind::MULTI {
            let gap = e2 - e1;
            if c >= SURE_CONFIDENCE || (gap >= 20.0 && c >= CONFIRMED_CONFIDENCE) {
                // sure, or too clear for the neighbors to switch it and confident already
                *d_out = depth_of_u(u1, xt, zt);
                *c_out = c;
                continue;
            }
            let h = bandwidth(u1);
            let (mut s1, mut s2, mut total) = support2(&window, x, r, u1, u2, h);
            // the pixel itself does not vote
            let own = anr.get(x).copied().unwrap_or(0.0);
            let d = (u2 - u1) / h;
            s1 -= own;
            s2 -= own * (1.0 - d * d).max(0.0);
            total -= own;
            let (u, conf, resolved) = if total > 1.0 && s2 > 2.0 * s1 && gap < 20.0 {
                (u2, (0.55 + 0.4 * s2 / total).min(0.95), true)
            } else if total > 1.0 && s1 > 2.0 * s2 && s1 > 0.5 * total {
                (u1, c.max((0.55 + 0.4 * s1 / total).min(0.95)), true)
            } else {
                (u1, c, false)
            };
            *d_out = depth_of_u(u, xt, zt);
            *c_out = conf;
            if resolved {
                *f |= flags::RESOLVED;
            }
            continue;
        }
        if base == kind::SINGLE {
            let fi = usize::from((k >> 4) & 3);
            let n = FREQ_MULTIPLES.get(fi).copied().unwrap_or(1) as f32;
            *f |= flags::SINGLE_FREQUENCY;
            let saturated = *f & flags::SATURATED_ANY != 0;
            let (votes, total) = vote(&window, x, r, n, cref, saturated);
            let (best_m, best_v) = votes.iter().enumerate().fold((0usize, 0f32), |acc, (m, v)| if *v > acc.1 { (m, *v) } else { acc });
            let (u, conf) = if total >= 1.5 && best_v > 0.6 * total {
                *f |= flags::RESOLVED;
                ((cref + best_m as f32) / n, 0.5 + 0.4 * best_v / total)
            } else if let Some(&e) = i.expected.get(y * W + x).filter(|e| **e > 0.0) {
                *f |= flags::RESOLVED;
                let m = (n * e - cref + 0.5).floor().max(0.0);
                ((cref + m) / n, if saturated { 0.6 } else { 0.4 })
            } else if saturated && i.near_prior_mm > 0.0 && u1 <= u_of_depth(i.near_prior_mm, zt) {
                *f |= flags::NEAR_PRIOR;
                (u1, 0.55)
            } else {
                (u1, 0.0)
            };
            *d_out = if conf > 0.0 { depth_of_u(u, xt, zt) } else { 0.0 };
            *c_out = conf;
            continue;
        }
        *d_out = 0.0;
        *c_out = 0.0;
    }
}

/// Kernel bandwidth around a distance fraction: 4 % of the distance, at least 80 mm.
fn bandwidth(u: f32) -> f32 {
    let mm = (u * super::kernels::U_RANGE_MM * 0.04).max(80.0);
    mm / super::kernels::U_RANGE_MM
}

/// Support of the anchors around `x` for two candidates (Epanechnikov kernel), and the total
/// anchor weight (the pixel itself excluded).
fn support2(w: &Window, x: usize, r: usize, u1: f32, u2: f32, h: f32) -> (f32, f32, f32) {
    let (mut s1, mut s2, mut total) = (0f32, 0f32, 0f32);
    let inv_h2 = 1.0 / (h * h).max(1e-12);
    let (x0, x1) = (x.saturating_sub(r), (x + r).min(W - 1));
    for (ur, ar, _) in w.rows() {
        let (Some(us), Some(aws)) = (ur.get(x0..=x1), ar.get(x0..=x1)) else { continue };
        for (&uj, &aj) in us.iter().zip(aws) {
            let d1 = uj - u1;
            let d2 = uj - u2;
            total += aj;
            s1 += aj * (1.0 - d1 * d1 * inv_h2).max(0.0);
            s2 += aj * (1.0 - d2 * d2 * inv_h2).max(0.0);
        }
    }
    (s1, s2, total)
}

/// Votes of the anchors around `x` for the candidates `(c + m) / n`; a saturated pixel listens
/// mostly to saturated anchors (the same bright object, not what is behind it).
fn vote(w: &Window, x: usize, r: usize, n: f32, cref: f32, saturated: bool) -> ([f32; 16], f32) {
    let mut votes = [0f32; 16];
    let mut total = 0f32;
    let (x0, x1) = (x.saturating_sub(r), (x + r).min(W - 1));
    for (ur, ar, sr) in w.rows() {
        let (Some(us), Some(aws), Some(ss)) = (ur.get(x0..=x1), ar.get(x0..=x1), sr.get(x0..=x1)) else { continue };
        for ((&uj, &aj), &sj) in us.iter().zip(aws).zip(ss) {
            if aj <= 0.0 {
                continue;
            }
            let wj = if saturated && sj != 0 { 10.0 * aj } else { aj };
            let m = (n * uj - cref + 0.5).floor();
            if (0.0..16.0).contains(&m)
                && let Some(v) = votes.get_mut(m as usize)
            {
                *v += wj;
                total += wj;
            }
        }
    }
    (votes, total)
}
