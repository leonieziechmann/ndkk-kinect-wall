//! Extended mode: one pixel, two echoes.
//!
//! A glossy floor seen at a grazing angle returns two echoes in the same pixel: its own (weak,
//! near) and the mirror image of what it reflects (often stronger, farther). So do a grazing
//! table top, a room corner, a pixel on a depth edge. Their sum fits no single distance; the
//! unwrapping of a single echo gives a distance between them, below the floor.
//!
//! Per pixel the three frequencies give three complex values, six numbers. Two echoes at the
//! distances `u1 < u2` (fractions of the unambiguous range) with the amplitudes `A1, A2 >= 0`
//! (the same at every frequency, after the gain correction) are four unknowns:
//! `z_k = A1 s_k(u1) + A2 s_k(u2)`, `s_k(u) = exp(i 2 pi n_k u)`, `n_k` = 10, 2, 15. For given
//! distances the amplitudes are a linear least-squares problem; the distances are searched.
//!
//! The residual is weighted along the measured value (the amplitudes: the gains of the
//! frequencies differ from pixel to pixel) and across it (the phases) separately. Whitened, a
//! steering vector becomes six numbers per distance; on a coarse grid they are computed once per
//! pixel, and then every pair costs a handful of operations. The best pair is refined by a
//! pattern search that rotates the steering vectors instead of computing them anew.
//!
//! What keeps the search short: the single echo's distance lies between the two (at 16 MHz the
//! mixture's phase is between theirs), so the first echo is not searched beyond it. What keeps
//! it right: every echo costs the brightness it would need beyond the plausible
//! ([`Noise::max_amp_u2`]): at 16 and 80 MHz the phases repeat after half the range, and a pair
//! with an echo there fits almost as well as the real one.
//!
//! Scalar code (the pair loop in eight lanes): it runs only for the pixels that a single echo
//! does not explain.

#![allow(clippy::indexing_slicing)] // indices below COARSE + LANES into arrays of that length: in bounds by construction

use std::f32::consts::TAU;
use std::sync::OnceLock;

use super::kernels::NOISE_PRIOR_DOF;
use super::lanes::{F8, Isa, LANES, M8};
use crate::consts::FREQ_MULTIPLES;
use crate::multiversion;

/// Points of the coarse grid over the unambiguous range: 104 mm apart; at 120 MHz a step is a
/// twelfth of a cycle (120 points, 156 mm apart, found the wrong pair noticeably more often).
pub const COARSE: usize = 180;
/// Smallest separation of the two echoes in the grid search, in grid steps (at least
/// [`MIN_SEP_U`]): closer ones are one echo to three frequencies.
pub const MIN_SEPARATION: usize = (COARSE * MIN_SEP_10K).div_ceil(10_000);
/// Smallest separation of the two echoes, in 1/10000 of the range (31 cm).
const MIN_SEP_10K: usize = 167;
/// The same as a fraction of the range.
pub const MIN_SEP_U: f32 = MIN_SEP_10K as f32 / 10_000.0;
/// First echoes this many grid steps apart or less are the same position (for the ambiguity).
pub const SAME_FIRST: usize = (COARSE * 111 + 5_000) / 10_000;
/// The first echo is searched up to this many grid steps (about 0.2 m) beyond the single echo's
/// distance: the mixture lies between the two echoes.
pub const FIRST_BEYOND: usize = (COARSE * 107).div_ceil(10_000);
/// Degrees of freedom of a two-echo fit (six numbers, four unknowns).
pub const DOF_TWO: f32 = 2.0;
/// The second echo must be at least this strong relative to the first before the first replaces
/// the single echo's distance: a weaker one moves that distance by centimeters (a quarter: the
/// pixels of two overlaid walls keep the near one), less than the split's own noise.
pub const STRONG_SECOND: f32 = 0.35;
/// The first echo must be at least this strong relative to the second: else a tiny echo in front
/// of the real one fits almost as well as the real one alone, at every distance in front of it.
pub const FIRST_MIN: f32 = 0.25;

/// Seeds: every SEED_STEP-th pixel in both directions gets the whole search; the pixels
/// between start from the solutions of the seeds around them and only refine (a floor and its
/// mirror image change little from pixel to pixel). Every 3rd, 4th or 6th pixel are as good
/// (starting from the best of four solutions picks the right pair more often than the search of
/// a pixel alone); every 8th loses about 1 % of the floor.
pub const SEED_STEP: usize = 6;

/// With `split_reuse` every pixel is split again at least every this many frames (in turn, a
/// sixteenth of them per frame): within half a second it finds a pair its last split would hide.
/// A seed's turn: (lattice row * lattice columns + lattice column + frame) % RESPLIT == 0 (lattice
/// columns = width / SEED_STEP, rounded up); that of a pixel between: ((y * width + x) *
/// [`RESPLIT_SPREAD`] + frame) % RESPLIT == 0. The frame counts the decoded frames from 0.
pub const RESPLIT: u64 = 16;
/// Spreads the turns of the pixels between the seeds over the image (see [`RESPLIT`]).
pub const RESPLIT_SPREAD: u64 = 5;
/// How far (squared, weighted with the phase noise `Noise::tangential`) the input of a pixel may
/// move from that of its last split before it is split again. Between two frames of a still
/// scene the inputs move by 2 to 16 (the noise of both); a person walking by, by thousands.
pub const RESPLIT_DISTANCE: f32 = 16.0;

/// The inputs of the split of one pixel, collected in stage 2.
#[derive(Clone, Copy, Debug, Default)]
pub struct Cand {
    /// the complex value per frequency (gain corrected)
    pub z: [(f32, f32); 3],
    /// its noise and brightness prior
    pub noise: Noise,
    /// the single echo's distance
    pub near: f32,
    /// one echo does not explain the pixel: split it
    pub on: bool,
}

/// The grid plus a vector of padding (loads of eight lanes never leave it).
const PAD: usize = COARSE + LANES;
// the GPU packs a grid point into the 8 low bits of a cost
const _: () = assert!(COARSE <= 256);

/// The distances of the two echoes and their amplitudes, with the evidence for them.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Split {
    /// first (nearer) echo, fraction of the unambiguous range
    pub u1: f32,
    /// second echo
    pub u2: f32,
    /// amplitude of the first echo (the units of the input)
    pub a1: f32,
    /// amplitude of the second echo
    pub a2: f32,
    /// weighted squared residual of the two echoes (chi-square, 2 degrees of freedom)
    pub cost: f32,
    /// their brightness penalty (in the comparisons, not in `cost`)
    pub penalty: f32,
    /// the same of the best single echo, penalty included (4 degrees of freedom)
    pub single: f32,
    /// how much better the first echo is than the best alternative (a single echo, or a pair
    /// whose first echo lies elsewhere), in units of the misfit
    pub gap: f32,
}

/// The noise of one pixel: per frequency the weight (1 / variance) of the residual along the
/// measured value (amplitude: the gains of the frequencies differ from pixel to pixel) and
/// across it (phase); and the brightness an echo may have at its distance.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Noise {
    /// along the measured value
    pub radial: [f32; 3],
    /// across it
    pub tangential: [f32; 3],
    /// amplitude times u^2 of an echo with the largest plausible reflectivity (the reflectivity
    /// is proportional to both; infinite = no prior)
    pub max_amp_u2: f32,
    /// the cost of an echo t times brighter than that: penalty_scale (t - 1)^2
    pub penalty_scale: f32,
}

impl Default for Noise {
    fn default() -> Self {
        Noise { radial: [0.0; 3], tangential: [0.0; 3], max_amp_u2: f32::INFINITY, penalty_scale: 0.0 }
    }
}

/// cos and sin of 2 pi n_k j / COARSE per frequency (zeros in the padding).
struct Grid {
    cos: [[f32; PAD]; 3],
    sin: [[f32; PAD]; 3],
}

fn grid() -> &'static Grid {
    static GRID: OnceLock<Grid> = OnceLock::new();
    GRID.get_or_init(|| {
        let mut g = Grid { cos: [[0.0; PAD]; 3], sin: [[0.0; PAD]; 3] };
        for j in 0..COARSE {
            let s = steering(j as f32 / COARSE as f32);
            for (k, &(c, sn)) in s.iter().enumerate() {
                g.cos[k][j] = c;
                g.sin[k][j] = sn;
            }
        }
        g
    })
}

/// A steering vector: (cos, sin) of 2 pi n_k u per frequency.
type Steer = [(f32, f32); 3];

/// (cos, sin) of `t` cycles (2 pi t): reduced to an eighth of a cycle, then polynomials (error
/// below 1e-6; the library's sin and cos are several times slower).
#[inline]
fn cos_sin_cycles(t: f32) -> (f32, f32) {
    // nearest integer, ties to even (as F8::round, so both give the same bits)
    let round = |x: f32| (x + ROUNDER) - ROUNDER;
    let r = t - round(t);
    let q = round(r * 4.0);
    let y = (r - 0.25 * q) * TAU;
    let y2 = y * y;
    let s = y * (1.0 + y2 * (-1.0 / 6.0 + y2 * (1.0 / 120.0 + y2 * (-1.0 / 5040.0))));
    let c = 1.0 + y2 * (-0.5 + y2 * (1.0 / 24.0 + y2 * (-1.0 / 720.0 + y2 * (1.0 / 40320.0))));
    match (q as i32).rem_euclid(4) {
        0 => (c, s),
        1 => (-s, c),
        2 => (-c, -s),
        _ => (s, -c),
    }
}

/// 1.5 * 2^23: adding it rounds an `f32` below 2^22 to an integer.
const ROUNDER: f32 = 12_582_912.0;

/// The steering vector of a distance.
#[inline]
fn steering(u: f32) -> Steer {
    std::array::from_fn(|k| cos_sin_cycles(FREQ_MULTIPLES.get(k).copied().unwrap_or(1) as f32 * u))
}

/// `s` moved by the rotation `r` (a steering vector of a step): forward, back or not at all.
#[inline]
fn rotate(s: &Steer, r: &Steer, dir: f32) -> Steer {
    if dir == 0.0 {
        return *s;
    }
    std::array::from_fn(|k| {
        let (c, sn) = (r[k].0, dir * r[k].1);
        (s[k].0 * c - s[k].1 * sn, s[k].0 * sn + s[k].1 * c)
    })
}

/// A pixel in the frame of its measured values: per frequency the unit vector along the
/// measurement, the square roots of the weights, the weighted measurement.
struct Frame {
    /// 1 / [`Noise::max_amp_u2`] (0 = no prior) and [`Noise::penalty_scale`]
    inv_lim: f32,
    ps: f32,
    e: [(f32, f32); 3],
    sr: [f32; 3],
    st: [f32; 3],
    /// the weighted measurement along the radial axes, sr_k |z_k|
    y: [f32; 3],
    /// sum of y_k^2: the weighted energy (the measurement has no tangential part)
    zz: f32,
}

impl Frame {
    fn new(z: &[(f32, f32); 3], n: &Noise) -> Option<Frame> {
        let mut e = [(0.0, 0.0); 3];
        let mut y = [0.0; 3];
        let sr = n.radial.map(f32::sqrt);
        for k in 0..3 {
            let m = (z[k].0 * z[k].0 + z[k].1 * z[k].1).sqrt();
            if !(m > 0.0 && n.radial[k] > 0.0 && n.tangential[k] > 0.0) {
                return None;
            }
            e[k] = (z[k].0 / m, z[k].1 / m);
            y[k] = sr[k] * m;
        }
        let inv_lim = if n.max_amp_u2.is_finite() && n.max_amp_u2 > 0.0 { 1.0 / n.max_amp_u2 } else { 0.0 };
        Some(Frame { inv_lim, ps: n.penalty_scale, e, sr, st: n.tangential.map(f32::sqrt), y, zz: y.iter().map(|v| v * v).sum() })
    }

    /// The brightness penalty of an echo of amplitude `a` at `u2` = u^2.
    #[inline]
    fn penalty(&self, a: f32, u2: f32) -> f32 {
        let t = a * u2 * self.inv_lim;
        if t > 1.0 { self.ps * (t - 1.0) * (t - 1.0) } else { 0.0 }
    }

    /// The whitened components of a steering vector: (radial, tangential) per frequency.
    #[inline]
    fn project(&self, s: &Steer) -> ([f32; 3], [f32; 3]) {
        let r = std::array::from_fn(|k| self.sr[k] * (s[k].0 * self.e[k].0 + s[k].1 * self.e[k].1));
        let t = std::array::from_fn(|k| self.st[k] * (s[k].1 * self.e[k].0 - s[k].0 * self.e[k].1));
        (r, t)
    }

    /// Cost (penalty included) and amplitudes of two echoes with steering vectors `s1`, `s2`
    /// at `u1`, `u2`; infinite where an amplitude would be negative or the pair degenerate.
    fn pair(&self, s1: &Steer, s2: &Steer, u1: f32, u2: f32) -> (f32, f32, f32) {
        let (p, q) = (self.project(s1), self.project(s2));
        let (mut n1, mut n2, mut g, mut b1, mut b2) = (0f32, 0f32, 0f32, 0f32, 0f32);
        for k in 0..3 {
            n1 += p.0[k] * p.0[k] + p.1[k] * p.1[k];
            n2 += q.0[k] * q.0[k] + q.1[k] * q.1[k];
            g += p.0[k] * q.0[k] + p.1[k] * q.1[k];
            b1 += p.0[k] * self.y[k];
            b2 += q.0[k] * self.y[k];
        }
        let det = n1 * n2 - g * g;
        let inv = 1.0 / det.max(1e-30);
        let a1 = (n2 * b1 - g * b2) * inv;
        let a2 = (n1 * b2 - g * b1) * inv;
        if !(det > 1e-6 * n1 * n2 && a1 > 0.0 && a2 > 0.0) {
            return (f32::INFINITY, a1, a2);
        }
        ((self.zz - a1 * b1 - a2 * b2).max(0.0) + self.penalty(a1, u1 * u1) + self.penalty(a2, u2 * u2), a1, a2)
    }

    /// Cost (penalty included) of one echo with steering vector `s` at `u`.
    fn single(&self, s: &Steer, u: f32) -> f32 {
        let p = self.project(s);
        let (mut n, mut b) = (0f32, 0f32);
        for k in 0..3 {
            n += p.0[k] * p.0[k] + p.1[k] * p.1[k];
            b += p.0[k] * self.y[k];
        }
        if b > 0.0 && n > 0.0 { (self.zz - b * b / n).max(0.0) + self.penalty(b / n, u * u) } else { f32::INFINITY }
    }
}

/// The whitened steering vectors of the grid, the matched filter, the norms, u^2.
struct Planes {
    r: [[f32; PAD]; 3],
    t: [[f32; PAD]; 3],
    b: [f32; PAD],
    n: [f32; PAD],
    u2: [f32; PAD],
}

/// The best second echo for the first echo at grid point `i`: (cost with the penalty,
/// separation in steps). Eight separations at a time.
#[inline(always)]
fn best_second<I: Isa>(i: usize, pl: &Planes, f: &Frame) -> (f32, usize) {
    let (zero, inf, one) = (F8::zero(), F8::splat(f32::INFINITY), F8::splat(1.0));
    let iota = F8(std::array::from_fn(|l| l as f32));
    // the second echo below the end of the range, and not closer than MIN_SEPARATION modulo it
    let dmax = (COARSE - 1 - i).min(COARSE - MIN_SEPARATION);
    let ri: [F8; 3] = std::array::from_fn(|k| F8::splat(pl.r[k][i]));
    let ti: [F8; 3] = std::array::from_fn(|k| F8::splat(pl.t[k][i]));
    let (b1, n1, zzv, dmaxv) = (F8::splat(pl.b[i]), F8::splat(pl.n[i]), F8::splat(f.zz), F8::splat(dmax as f32));
    let tiny = F8::splat(1e-6) * n1;
    let (inv_limv, psv, u2i) = (F8::splat(f.inv_lim), F8::splat(f.ps), F8::splat(pl.u2[i]));
    // the brightness penalty ps (t - 1)^2 beyond t = 1
    let pen = |t: F8| {
        let over = (t - one).max(zero);
        psv * over * over
    };
    let (mut bc, mut bd) = (inf, zero);
    let mut d0 = MIN_SEPARATION;
    while d0 <= dmax {
        let j = i + d0;
        let mut g = ri[0] * F8::load(&pl.r[0], j);
        g = ri[1].mul_add::<I>(F8::load(&pl.r[1], j), g);
        g = ri[2].mul_add::<I>(F8::load(&pl.r[2], j), g);
        g = ti[0].mul_add::<I>(F8::load(&pl.t[0], j), g);
        g = ti[1].mul_add::<I>(F8::load(&pl.t[1], j), g);
        g = ti[2].mul_add::<I>(F8::load(&pl.t[2], j), g);
        let (n2, b2) = (F8::load(&pl.n, j), F8::load(&pl.b, j));
        let det = n1.mul_add::<I>(n2, -(g * g));
        let inv = one / det.max(F8::splat(1e-30));
        let a1 = n2.mul_add::<I>(b1, -(g * b2)) * inv;
        let a2 = n1.mul_add::<I>(b2, -(g * b1)) * inv;
        let c = (-a2).mul_add::<I>(b2, (-a1).mul_add::<I>(b1, zzv)).max(zero);
        let c = c + pen(a1 * u2i * inv_limv) + pen(a2 * F8::load(&pl.u2, j) * inv_limv);
        let d = iota + F8::splat(d0 as f32);
        let ok = a1.ge(F8::splat(FIRST_MIN) * a2) & a2.gt(zero) & det.gt(tiny * n2) & d.le(dmaxv);
        let c = ok.select(c, inf);
        let better = c.lt(bc);
        bc = better.select(c, bc);
        bd = better.select(d, bd);
        d0 += LANES;
    }
    let mut best = (f32::INFINITY, 0usize);
    for l in 0..LANES {
        if bc.0[l] < best.0 {
            best = (bc.0[l], bd.0[l] as usize);
        }
    }
    best
}

/// The moves of the refinement: along both axes and both diagonals (two echoes close together
/// trade distance along a diagonal valley of the cost).
const MOVES: [(f32, f32); 8] = [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0), (1.0, 1.0), (-1.0, -1.0), (1.0, -1.0), (-1.0, 1.0)];
/// Rounds of moves per step size at most.
pub const REPEATS: usize = 2;
/// The refinement starts at half a grid step and goes down to 1/3840 of the range (5 mm) or
/// finer.
pub const LEVELS: u32 = halvings(2 * COARSE, 3840) + 1;
/// Between the seeds it starts at a quarter step and goes down to 1/1920 (10 mm) or finer, one
/// round per step size.
pub const BETWEEN_LEVELS: u32 = halvings(4 * COARSE, 1920) + 1;

/// How often 1/`from` must be halved to reach 1/`to` or less.
const fn halvings(from: usize, to: usize) -> u32 {
    let mut k = 0;
    while from << k < to {
        k += 1;
    }
    k
}

/// Refines a pair from `u1`, `u2`: pattern search from the step `h` down (`levels` times
/// halved), the steering vectors rotated by each move. (u1, u2, cost with the penalty, A1, A2).
fn refine_pair(f: &Frame, u1: f32, u2: f32, h: f32, levels: u32, repeats: usize) -> (f32, f32, f32, f32, f32) {
    let (mut u1, mut u2) = (u1, u2);
    let (mut s1, mut s2) = (steering(u1), steering(u2));
    let (mut cost, mut a1, mut a2) = f.pair(&s1, &s2, u1, u2);
    let mut h = h;
    for _ in 0..levels {
        let rot = steering(h);
        for _ in 0..repeats {
            let mut moved = false;
            for (m1, m2) in MOVES {
                let (v1, v2) = (u1 + m1 * h, u2 + m2 * h);
                if v1 <= 0.0 || v2 - v1 < MIN_SEP_U - 1e-6 || v2 >= 1.0 {
                    continue;
                }
                let (t1, t2) = (rotate(&s1, &rot, m1), rotate(&s2, &rot, m2));
                let (c, b1, b2) = f.pair(&t1, &t2, v1, v2);
                if c < cost {
                    (u1, u2, cost, a1, a2, s1, s2) = (v1, v2, c, b1, b2, t1, t2);
                    moved = true;
                }
            }
            if !moved {
                break;
            }
        }
        h *= 0.5;
    }
    (u1, u2, cost, a1, a2)
}

/// Refines a single echo from `u`, the step `h` halved `levels` times: (u, cost).
fn refine_single(f: &Frame, u: f32, h: f32, levels: u32) -> (f32, f32) {
    let mut u = u;
    let mut s = steering(u);
    let mut cost = f.single(&s, u);
    let mut h = h;
    for _ in 0..levels {
        let rot = steering(h);
        for dir in [1.0, -1.0] {
            let t = rotate(&s, &rot, dir);
            let c = f.single(&t, u + dir * h);
            if c < cost {
                (u, s, cost) = (u + dir * h, t, c);
            }
        }
        h *= 0.5;
    }
    (u, cost)
}

multiversion! {
    /// Splits a pixel into two echoes: `z` its complex value per frequency (gain corrected),
    /// `noise` the weights of its residuals and the brightness prior, `near` the single echo's
    /// distance (the first echo is searched up to [`FIRST_BEYOND`] beyond it). `None` if no pair
    /// fits.
    pub fn split(z: &[(f32, f32); 3], noise: &Noise, near: f32) -> Option<Split> {
        split_with::<Isa>(z, noise, near)
    }
}

/// The grid search of a pixel: the best pair (cost with the penalty, first and second echo as
/// grid points), the margin to the best pair whose first echo lies elsewhere, the grid point of
/// the best single echo. `None` if no pair fits.
#[inline(always)]
fn search<I: Isa>(f: &Frame, near: f32) -> Option<(f32, usize, usize, f32, usize)> {
    let t = grid();
    let mut pl = Planes { r: [[0.0; PAD]; 3], t: [[0.0; PAD]; 3], b: [0.0; PAD], n: [0.0; PAD], u2: [0.0; PAD] };
    let mut single = (f32::INFINITY, 0usize);
    for j in 0..COARSE {
        let (r, tn) = f.project(&std::array::from_fn(|k| (t.cos[k][j], t.sin[k][j])));
        let u = j as f32 / COARSE as f32;
        let (mut b, mut n) = (0f32, 0f32);
        for k in 0..3 {
            pl.r[k][j] = r[k];
            pl.t[k][j] = tn[k];
            b += r[k] * f.y[k];
            n += r[k] * r[k] + tn[k] * tn[k];
        }
        pl.b[j] = b;
        pl.n[j] = n;
        pl.u2[j] = u * u;
        let c = if b > 0.0 && n > 0.0 { f.zz - b * b / n + f.penalty(b / n, u * u) } else { f32::INFINITY };
        if c < single.0 {
            single = (c, j);
        }
    }
    // every pair whose first echo lies before the single echo's distance (and not at 0: stray
    // light in the lens comes from there): the best cost per first echo, and the best pair
    let near_i = (near.max(0.0) * COARSE as f32).round() as usize;
    let last = (near_i + FIRST_BEYOND + 1).min(COARSE - MIN_SEPARATION);
    let mut by_first = [f32::INFINITY; COARSE];
    let mut best = (f32::INFINITY, 0usize, 0usize);
    for (i, slot) in by_first.iter_mut().enumerate().take(last).skip(1) {
        let (c, d) = best_second::<I>(i, &pl, f);
        *slot = c;
        if c < best.0 {
            best = (c, i, i + d);
        }
    }
    if !best.0.is_finite() {
        return None;
    }
    // the best pair whose first echo lies elsewhere
    let alt = by_first
        .iter()
        .enumerate()
        .filter(|(i, _)| i.abs_diff(best.1) > SAME_FIRST)
        .map(|(_, c)| *c)
        .fold(f32::INFINITY, f32::min);
    Some((best.0, best.1, best.2, alt - best.0, single.1))
}

multiversion! {
    /// [`search`] of one pixel, compiled on its own: inlined eight times into the batch, the
    /// compiler gives up inlining the lanes' operations (and `mul_add` becomes a library call).
    fn grid_search(z: &[(f32, f32); 3], noise: &Noise, near: f32) -> Option<(f32, usize, usize, f32, usize)> {
        search::<Isa>(&Frame::new(z, noise)?, near)
    }
}

#[inline(always)]
fn split_with<I: Isa>(z: &[(f32, f32); 3], noise: &Noise, near: f32) -> Option<Split> {
    let f = Frame::new(z, noise)?;
    let (_, i, j, alt_margin, js) = search::<I>(&f, near)?;
    let step = 1.0 / COARSE as f32;
    let (u1, u2, cost, a1, a2) = refine_pair(&f, i as f32 * step, j as f32 * step, 0.5 * step, LEVELS, REPEATS);
    let (_, single) = refine_single(&f, js as f32 * step, 0.5 * step, LEVELS);
    Some(finish(&f, u1, u2, cost, a1, a2, single, alt_margin))
}

/// The split with its evidence: the residual apart from the penalty, the margin over a single
/// echo and over `alt_margin` (pairs whose first echo lies elsewhere) in units of the misfit.
#[allow(clippy::too_many_arguments)]
fn finish(f: &Frame, u1: f32, u2: f32, cost: f32, a1: f32, a2: f32, single: f32, alt_margin: f32) -> Split {
    let penalty = f.penalty(a1, u1 * u1) + f.penalty(a2, u2 * u2);
    let resid = (cost - penalty).max(0.0);
    // the misfit of the pixel scales the evidence, as in the unwrapping
    let scale = ((NOISE_PRIOR_DOF + resid) / (NOISE_PRIOR_DOF + DOF_TWO)).max(1.0);
    let margin = (single - cost).min(alt_margin);
    Split { u1, u2, a1, a2, cost: resid, penalty, single, gap: (margin / scale).max(0.0) }
}

// ---- eight pixels at a time: the seeds and the pixels between them ------------------------

/// [`cos_sin_cycles`] in eight lanes.
#[inline(always)]
fn cos_sin_cycles8<I: Isa>(t: F8) -> (F8, F8) {
    let r = t - t.round();
    let q = (r * F8::splat(4.0)).round();
    let y = (r - F8::splat(0.25) * q) * F8::splat(TAU);
    let y2 = y * y;
    let sp = F8::splat(-1.0 / 5040.0).mul_add::<I>(y2, F8::splat(1.0 / 120.0));
    let sp = sp.mul_add::<I>(y2, F8::splat(-1.0 / 6.0));
    let sp = sp.mul_add::<I>(y2, F8::splat(1.0));
    let sn = y * sp;
    let cp = F8::splat(1.0 / 40320.0).mul_add::<I>(y2, F8::splat(-1.0 / 720.0));
    let cp = cp.mul_add::<I>(y2, F8::splat(1.0 / 24.0));
    let cp = cp.mul_add::<I>(y2, F8::splat(-0.5));
    let c = cp.mul_add::<I>(y2, F8::splat(1.0));
    // the quadrant: q in -2 ..= 2
    let (q1, qm1, q2) = (q.eq(F8::splat(1.0)), q.eq(F8::splat(-1.0)), q.eq(F8::splat(2.0)) | q.eq(F8::splat(-2.0)));
    let cos = q1.select(-sn, qm1.select(sn, q2.select(-c, c)));
    let sin = q1.select(c, qm1.select(-c, q2.select(-sn, sn)));
    (cos, sin)
}

/// Steering vectors of eight distances: (cos, sin) per frequency.
#[derive(Clone, Copy)]
struct Steer8 {
    c: [F8; 3],
    s: [F8; 3],
}

#[inline(always)]
fn steering8<I: Isa>(u: F8) -> Steer8 {
    let mut out = Steer8 { c: [F8::zero(); 3], s: [F8::zero(); 3] };
    for k in 0..3 {
        let n = FREQ_MULTIPLES.get(k).copied().unwrap_or(1) as f32;
        (out.c[k], out.s[k]) = cos_sin_cycles8::<I>(F8::splat(n) * u);
    }
    out
}

/// `s` rotated by the scalar step `r`, in the direction `dir` (+1, -1 or 0) for all lanes.
#[inline(always)]
fn rotate8(s: &Steer8, r: &Steer, dir: f32) -> Steer8 {
    if dir == 0.0 {
        return *s;
    }
    let mut out = *s;
    for (k, rk) in r.iter().enumerate() {
        let (c, sn) = (F8::splat(rk.0), F8::splat(dir * rk.1));
        out.c[k] = s.c[k] * c - s.s[k] * sn;
        out.s[k] = s.c[k] * sn + s.s[k] * c;
    }
    out
}

/// Eight pixels in the frame of their measured values ([`Frame`] lane by lane).
struct Frame8 {
    inv_lim: F8,
    ps: F8,
    ex: [F8; 3],
    ey: [F8; 3],
    sr: [F8; 3],
    st: [F8; 3],
    y: [F8; 3],
    zz: F8,
}

impl Frame8 {
    /// The frames of eight pixels, and which lanes are usable (on, with a frame).
    fn new(c: &[Cand; LANES]) -> (Frame8, [bool; LANES]) {
        let mut ok = [false; LANES];
        let z8 = [F8::zero(); 3];
        let mut f = Frame8 { inv_lim: F8::zero(), ps: F8::zero(), ex: z8, ey: z8, sr: z8, st: z8, y: z8, zz: F8::zero() };
        for (l, cl) in c.iter().enumerate() {
            if !cl.on {
                continue;
            }
            let Some(fr) = Frame::new(&cl.z, &cl.noise) else { continue };
            ok[l] = true;
            f.inv_lim.0[l] = fr.inv_lim;
            f.ps.0[l] = fr.ps;
            for k in 0..3 {
                f.ex[k].0[l] = fr.e[k].0;
                f.ey[k].0[l] = fr.e[k].1;
                f.sr[k].0[l] = fr.sr[k];
                f.st[k].0[l] = fr.st[k];
                f.y[k].0[l] = fr.y[k];
            }
            f.zz.0[l] = fr.zz;
        }
        (f, ok)
    }

    #[inline(always)]
    fn penalty(&self, a: F8, u2: F8) -> F8 {
        let over = (a * u2 * self.inv_lim - F8::splat(1.0)).max(F8::zero());
        self.ps * over * over
    }

    /// [`Frame::pair`] lane by lane.
    #[inline(always)]
    fn pair<I: Isa>(&self, s1: &Steer8, s2: &Steer8, u1: F8, u2: F8) -> (F8, F8, F8) {
        let (zero, inf) = (F8::zero(), F8::splat(f32::INFINITY));
        let (mut n1, mut n2, mut g, mut b1, mut b2) = (zero, zero, zero, zero, zero);
        for k in 0..3 {
            let r1 = self.sr[k] * s1.c[k].mul_add::<I>(self.ex[k], s1.s[k] * self.ey[k]);
            let t1 = self.st[k] * s1.s[k].mul_add::<I>(self.ex[k], -(s1.c[k] * self.ey[k]));
            let r2 = self.sr[k] * s2.c[k].mul_add::<I>(self.ex[k], s2.s[k] * self.ey[k]);
            let t2 = self.st[k] * s2.s[k].mul_add::<I>(self.ex[k], -(s2.c[k] * self.ey[k]));
            n1 = r1.mul_add::<I>(r1, t1.mul_add::<I>(t1, n1));
            n2 = r2.mul_add::<I>(r2, t2.mul_add::<I>(t2, n2));
            g = r1.mul_add::<I>(r2, t1.mul_add::<I>(t2, g));
            b1 = r1.mul_add::<I>(self.y[k], b1);
            b2 = r2.mul_add::<I>(self.y[k], b2);
        }
        let det = n1.mul_add::<I>(n2, -(g * g));
        let inv = F8::splat(1.0) / det.max(F8::splat(1e-30));
        let a1 = n2.mul_add::<I>(b1, -(g * b2)) * inv;
        let a2 = n1.mul_add::<I>(b2, -(g * b1)) * inv;
        let ok = det.gt(F8::splat(1e-6) * n1 * n2) & a1.gt(zero) & a2.gt(zero);
        let c = (-a2).mul_add::<I>(b2, (-a1).mul_add::<I>(b1, self.zz)).max(zero) + self.penalty(a1, u1 * u1) + self.penalty(a2, u2 * u2);
        (ok.select(c, inf), a1, a2)
    }

    /// [`Frame::single`] lane by lane.
    #[inline(always)]
    fn single<I: Isa>(&self, s: &Steer8, u: F8) -> F8 {
        let (zero, inf) = (F8::zero(), F8::splat(f32::INFINITY));
        let (mut n, mut b) = (zero, zero);
        for k in 0..3 {
            let r = self.sr[k] * s.c[k].mul_add::<I>(self.ex[k], s.s[k] * self.ey[k]);
            let t = self.st[k] * s.s[k].mul_add::<I>(self.ex[k], -(s.c[k] * self.ey[k]));
            n = r.mul_add::<I>(r, t.mul_add::<I>(t, n));
            b = r.mul_add::<I>(self.y[k], b);
        }
        let a = b / n.max(F8::splat(1e-30));
        let c = (-b).mul_add::<I>(a, self.zz).max(zero) + self.penalty(a, u * u);
        (b.gt(zero) & n.gt(zero)).select(c, inf)
    }
}

/// The state of eight pattern searches: distances, steering vectors, cost, amplitudes.
struct Search8 {
    u1: F8,
    u2: F8,
    s1: Steer8,
    s2: Steer8,
    cost: F8,
    a1: F8,
    a2: F8,
}

/// [`refine_pair`] in eight lanes, all lanes together (each keeps its own state; a round stops
/// when no lane moved, as each would on its own).
#[inline(always)]
fn refine_pair8<I: Isa>(f: &Frame8, st: &mut Search8, h: f32, levels: u32, repeats: usize) {
    let min_sep = F8::splat(MIN_SEP_U - 1e-6);
    let mut h = h;
    for _ in 0..levels {
        let rot = steering(h);
        for _ in 0..repeats {
            let mut moved = false;
            for (m1, m2) in MOVES {
                let (v1, v2) = (st.u1 + F8::splat(m1 * h), st.u2 + F8::splat(m2 * h));
                let inside = v1.gt(F8::zero()) & (v2 - v1).ge(min_sep) & v2.lt(F8::splat(1.0));
                let (t1, t2) = (rotate8(&st.s1, &rot, m1), rotate8(&st.s2, &rot, m2));
                let (cs, b1, b2) = f.pair::<I>(&t1, &t2, v1, v2);
                let better = inside & cs.lt(st.cost);
                if better.0.iter().all(|b| *b == 0) {
                    continue;
                }
                moved = true;
                st.cost = better.select(cs, st.cost);
                st.u1 = better.select(v1, st.u1);
                st.u2 = better.select(v2, st.u2);
                st.a1 = better.select(b1, st.a1);
                st.a2 = better.select(b2, st.a2);
                for k in 0..3 {
                    st.s1.c[k] = better.select(t1.c[k], st.s1.c[k]);
                    st.s1.s[k] = better.select(t1.s[k], st.s1.s[k]);
                    st.s2.c[k] = better.select(t2.c[k], st.s2.c[k]);
                    st.s2.s[k] = better.select(t2.s[k], st.s2.s[k]);
                }
            }
            if !moved {
                break;
            }
        }
        h *= 0.5;
    }
}

/// [`refine_single`] in eight lanes: (u, cost).
#[inline(always)]
fn refine_single8<I: Isa>(f: &Frame8, u: F8, h: f32, levels: u32) -> (F8, F8) {
    let mut u = u;
    let mut s = steering8::<I>(u);
    let mut cost = f.single::<I>(&s, u);
    let mut h = h;
    for _ in 0..levels {
        let rot = steering(h);
        for dir in [1.0f32, -1.0] {
            let t = rotate8(&s, &rot, dir);
            let v = u + F8::splat(dir * h);
            let c = f.single::<I>(&t, v);
            let better = c.lt(cost);
            cost = better.select(c, cost);
            u = better.select(v, u);
            for k in 0..3 {
                s.c[k] = better.select(t.c[k], s.c[k]);
                s.s[k] = better.select(t.s[k], s.s[k]);
            }
        }
        h *= 0.5;
    }
    (u, cost)
}

/// The splits of eight seeds ([`split`] lane by lane): the grid search pixel by pixel, the
/// refinements of all eight together.
#[inline(always)]
fn split_seeds_with<I: Isa>(c: &[Cand; LANES]) -> [Option<Split>; LANES] {
    let mut out = [None; LANES];
    let (f8, mut ok) = Frame8::new(c);
    let step = 1.0 / COARSE as f32;
    let (mut u1, mut u2, mut us, mut alt) = ([0f32; LANES], [0f32; LANES], [0f32; LANES], [f32::INFINITY; LANES]);
    for l in 0..LANES {
        if !ok[l] {
            continue;
        }
        let found = grid_search(&c[l].z, &c[l].noise, c[l].near);
        match found {
            Some((_, i, j, am, js)) => (u1[l], u2[l], alt[l], us[l]) = (i as f32 * step, j as f32 * step, am, js as f32 * step),
            None => ok[l] = false,
        }
    }
    if !ok.iter().any(|o| *o) {
        return out;
    }
    let (v1, v2) = (F8(u1), F8(u2));
    let (s1, s2) = (steering8::<I>(v1), steering8::<I>(v2));
    let (cost, a1, a2) = f8.pair::<I>(&s1, &s2, v1, v2);
    let mut st = Search8 { u1: v1, u2: v2, s1, s2, cost, a1, a2 };
    refine_pair8::<I>(&f8, &mut st, 0.5 * step, LEVELS, REPEATS);
    let (_, single) = refine_single8::<I>(&f8, F8(us), 0.5 * step, LEVELS);
    for (l, slot) in out.iter_mut().enumerate() {
        if !ok[l] || !st.cost.0[l].is_finite() {
            continue;
        }
        let Some(fr) = Frame::new(&c[l].z, &c[l].noise) else { continue };
        *slot = Some(finish(&fr, st.u1.0[l], st.u2.0[l], st.cost.0[l], st.a1.0[l], st.a2.0[l], single.0[l], alt[l]));
    }
    out
}

multiversion! {
    /// The splits of eight seeds, lane by lane as [`split`].
    pub fn split_seeds(c: &[Cand; LANES]) -> [Option<Split>; LANES] {
        split_seeds_with::<Isa>(c)
    }
}

/// The splits of eight pixels between the seeds: `starts` the seeds' solutions per lane (`count`
/// of them); from the best of them a short pattern search ([`BETWEEN_LEVELS`], one round per step
/// size). The margin is over a single echo at stage 2's distance only (the seeds weigh the other
/// first echoes). Lanes without a usable start stay without a split.
#[inline(always)]
fn split_between_with<I: Isa>(c: &[Cand; LANES], starts: &[[(f32, f32); 4]; LANES], count: &[usize; LANES]) -> [Option<Split>; LANES] {
    let mut out = [None; LANES];
    let (f, ok) = Frame8::new(c);
    let inf = F8::splat(f32::INFINITY);
    // the best start per lane
    let (mut cost, mut u1, mut u2) = (inf, F8::zero(), F8::zero());
    #[allow(clippy::needless_range_loop)] // s indexes the starts of every lane
    for s in 0..4 {
        let have = M8(std::array::from_fn(|l| if ok[l] && s < count[l] { u32::MAX } else { 0 }));
        if have.0.iter().all(|h| *h == 0) {
            continue;
        }
        let v1 = F8(std::array::from_fn(|l| starts[l][s].0));
        let v2 = F8(std::array::from_fn(|l| starts[l][s].1));
        let (cs, _, _) = f.pair::<I>(&steering8::<I>(v1), &steering8::<I>(v2), v1, v2);
        let better = have & cs.lt(cost);
        cost = better.select(cs, cost);
        u1 = better.select(v1, u1);
        u2 = better.select(v2, u2);
    }
    // the pattern search, all lanes together
    let step = 1.0 / COARSE as f32;
    let (s1, s2) = (steering8::<I>(u1), steering8::<I>(u2));
    let (_, a1, a2) = f.pair::<I>(&s1, &s2, u1, u2);
    let mut st = Search8 { u1, u2, s1, s2, cost, a1, a2 };
    refine_pair8::<I>(&f, &mut st, 0.25 * step, BETWEEN_LEVELS, 1);
    // the single echo at stage 2's distance
    let near = F8(std::array::from_fn(|l| c[l].near));
    let single = f.single::<I>(&steering8::<I>(near), near);
    for (l, slot) in out.iter_mut().enumerate() {
        if !ok[l] {
            continue;
        }
        // no seed around with a solution: the neighbors could not confirm a first echo either
        if count[l] == 0 || !st.cost.0[l].is_finite() {
            continue;
        }
        let Some(fr) = Frame::new(&c[l].z, &c[l].noise) else { continue };
        *slot = Some(finish(&fr, st.u1.0[l], st.u2.0[l], st.cost.0[l], st.a1.0[l], st.a2.0[l], single.0[l], f32::INFINITY));
    }
    out
}

multiversion! {
    /// The splits of eight pixels between the seeds (see `split_between_with`).
    pub fn split_between(c: &[Cand; LANES], starts: &[[(f32, f32); 4]; LANES], count: &[usize; LANES]) -> [Option<Split>; LANES] {
        split_between_with::<Isa>(c, starts, count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mix(echoes: &[(f32, f32)]) -> [(f32, f32); 3] {
        std::array::from_fn(|k| {
            echoes.iter().fold((0.0, 0.0), |(re, im), (u, a)| {
                let s = steering(*u)[k];
                (re + a * s.0, im + a * s.1)
            })
        })
    }

    #[test]
    fn two_echoes_are_found() {
        let w = Noise { radial: [1.0; 3], tangential: [1.0; 3], max_amp_u2: f32::INFINITY, penalty_scale: 0.0 };
        // a floor at 2.0 m under the mirror image of a wall at 4.6 m, the mirror twice as bright
        let (d1, d2) = (2000.0 / 18750.0, 4600.0 / 18750.0);
        let z = mix(&[(d1, 40.0), (d2, 80.0)]);
        let s = split(&z, &w, 0.18).unwrap();
        assert!((s.u1 - d1).abs() < 0.001, "{s:?}");
        assert!((s.u2 - d2).abs() < 0.001, "{s:?}");
        assert!((s.a1 - 40.0).abs() < 1.0 && (s.a2 - 80.0).abs() < 1.0, "{s:?}");
        assert!(s.cost < 1.0 && s.single > 100.0 && s.gap > 100.0, "{s:?}");
    }

    #[test]
    fn a_single_echo_gives_no_evidence_for_a_first_one() {
        let w = Noise { radial: [1.0; 3], tangential: [1.0; 3], max_amp_u2: f32::INFINITY, penalty_scale: 0.0 };
        let s = split(&mix(&[(0.2, 50.0)]), &w, 0.2);
        // any pair fits it only with a second echo of no amplitude: no better than one echo
        assert!(s.is_none_or(|s| s.gap < 1.0), "{s:?}");
    }

    #[test]
    fn the_polynomials_are_cos_and_sin() {
        for i in -2000..2000 {
            let t = i as f32 * 0.00137;
            let (c, s) = cos_sin_cycles(t);
            let ph = f64::from(t) * std::f64::consts::TAU;
            assert!((f64::from(c) - ph.cos()).abs() < 2e-6 && (f64::from(s) - ph.sin()).abs() < 2e-6, "{t}");
        }
    }

    #[test]
    fn rotating_is_steering() {
        let (u, h) = (0.137f32, 0.0021f32);
        let a = rotate(&steering(u), &steering(h), 1.0);
        let b = steering(u + h);
        let c = rotate(&steering(u), &steering(h), -1.0);
        let d = steering(u - h);
        for k in 0..3 {
            assert!((a[k].0 - b[k].0).abs() < 1e-5 && (a[k].1 - b[k].1).abs() < 1e-5);
            assert!((c[k].0 - d[k].0).abs() < 1e-5 && (c[k].1 - d[k].1).abs() < 1e-5);
        }
    }
}
