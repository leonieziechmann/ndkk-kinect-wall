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
use super::lanes::{F8, LANES};
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
    // the anchors' support for both candidates, where a multi-frequency pixel needs it
    let mut need = [0u8; W];
    for ((n, &k), (&c, (&e1, &e2))) in need.iter_mut().zip(kr).zip(cr.iter().zip(e1r.iter().zip(e2r))) {
        *n = u8::from((k & 0x0f == kind::MULTI) & !settled(c, e2 - e1));
    }
    let mut sums = [[0f32; W]; 3];
    if need.iter().any(|n| *n != 0) {
        support_row(&window, r, u1r, u2r, &need, &mut sums);
    }
    let [sum1, sum2, sum_total] = &sums;
    // first as if no neighbor were asked: a multi-frequency pixel keeps its best candidate, the
    // others have no depth (this pass vectorizes; the one below only works where needed)
    let first = depth.iter_mut().zip(conf_out.iter_mut()).zip(u1r.iter().zip(cr)).zip(kr.iter().zip(xtr.iter().zip(ztr)));
    for (((d_out, c_out), (&u1, &c)), (&k, (&xt, &zt))) in first {
        let multi = k & 0x0f == kind::MULTI;
        *d_out = if multi { depth_of_u(u1, xt, zt) } else { 0.0 };
        *c_out = if multi { c } else { 0.0 };
    }
    let rows = u1r.iter().zip(u2r).zip(e1r.iter().zip(e2r)).zip(cr.iter().zip(csr)).zip(kr.iter().zip(xtr.iter().zip(ztr)));
    for (x, ((((&u1, &u2), (&e1, &e2)), (&c, &cref)), (&k, (&xt, &zt)))) in rows.enumerate() {
        let base = k & 0x0f;
        if base != kind::SINGLE && need.get(x).is_none_or(|n| *n == 0) {
            continue;
        }
        let (Some(d_out), Some(c_out), Some(f)) = (depth.get_mut(x), conf_out.get_mut(x), fl.get_mut(x)) else { continue };
        if base == kind::MULTI {
            // the phases of a pixel that mixes several echoes are wrong, not ambiguous: the
            // neighbors neither confirm nor replace its distance
            if *f & flags::MULTIPATH != 0 {
                continue;
            }
            let gap = e2 - e1;
            let h = bandwidth(u1);
            let (Some(&s1), Some(&s2), Some(&total)) = (sum1.get(x), sum2.get(x), sum_total.get(x)) else { continue };
            let (mut s1, mut s2, mut total) = (s1, s2, total);
            // the pixel itself does not vote
            let own = anr.get(x).copied().unwrap_or(0.0);
            let d = (u2 - u1) / h;
            s1 -= own;
            s2 -= own * (1.0 - d * d).max(0.0);
            total -= own;
            if total > 1.0 && s2 > 2.0 * s1 && gap < 20.0 && k & kind::SECOND_IMPLAUSIBLE == 0 {
                *d_out = depth_of_u(u2, xt, zt);
                *c_out = (0.55 + 0.4 * s2 / total).min(0.95);
                *f |= flags::RESOLVED;
            } else if total > 1.0 && s1 > 2.0 * s2 && s1 > 0.5 * total {
                *c_out = c.max((0.55 + 0.4 * s1 / total).min(0.95));
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
        }
    }
}

/// A multi-frequency pixel that is sure, or too clear for the neighbors to switch it and
/// confident already: the neighbors are not asked.
#[inline(always)]
fn settled(conf: f32, gap: f32) -> bool {
    // no short-circuit: the loops around it vectorize
    (conf >= SURE_CONFIDENCE) | ((gap >= 20.0) & (conf >= CONFIRMED_CONFIDENCE))
}

crate::multiversion! {
    /// [`support2`] of the pixels of a row with `need` set: eight pixels at a time where the
    /// whole window lies inside the image.
    fn support_row(w: &Window, r: usize, u1r: &[f32], u2r: &[f32], need: &[u8; W], out: &mut [[f32; W]; 3]) {
        let [o1, o2, ot] = out;
        let (zero, one) = (F8::zero(), F8::splat(1.0));
        for x in (0..W).step_by(LANES) {
            let Some(nd) = need.get(x..x + LANES) else { continue };
            if nd.iter().all(|n| *n == 0) {
                continue;
            }
            if x < r || x + LANES + r > W {
                for (l, n) in nd.iter().enumerate() {
                    let (xl, u1, u2) = (x + l, u1r.get(x + l).copied().unwrap_or(0.0), u2r.get(x + l).copied().unwrap_or(0.0));
                    if *n != 0 && let (Some(a), Some(b), Some(t)) = (o1.get_mut(xl), o2.get_mut(xl), ot.get_mut(xl)) {
                        (*a, *b, *t) = support2(w, xl, r, u1, u2, bandwidth(u1));
                    }
                }
                continue;
            }
            let (u1, u2) = (F8::load(u1r, x), F8::load(u2r, x));
            let h = u1.map_lanes(bandwidth);
            let inv_h2 = one / (h * h).max(F8::splat(1e-12));
            let (mut s1, mut s2, mut total) = (zero, zero, zero);
            for (ur, ar, _) in w.rows() {
                for at in x - r..=x + r {
                    let (uj, aj) = (F8::load(ur, at), F8::load(ar, at));
                    let (d1, d2) = (uj - u1, uj - u2);
                    total = total + aj;
                    s1 = aj.mul_add::<Isa>((-d1 * d1).mul_add::<Isa>(inv_h2, one).max(zero), s1);
                    s2 = aj.mul_add::<Isa>((-d2 * d2).mul_add::<Isa>(inv_h2, one).max(zero), s2);
                }
            }
            s1.store(o1, x);
            s2.store(o2, x);
            total.store(ot, x);
        }
    }
}

/// Kernel bandwidth around a distance fraction: 4 % of the distance, at least 80 mm.
#[inline(always)]
fn bandwidth(u: f32) -> f32 {
    let mm = (u * super::kernels::U_RANGE_MM * 0.04).max(80.0);
    mm / super::kernels::U_RANGE_MM
}

/// Support of the anchors around `x` for two candidates (Epanechnikov kernel), and the total
/// anchor weight (the pixel itself included).
#[inline(always)]
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
