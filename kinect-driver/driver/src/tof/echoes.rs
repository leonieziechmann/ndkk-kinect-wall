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
//! The search is cheap because `|s_k| = 1`: with the weights `w_k`, the normal equations need
//! `sum w_k` (the same for both echoes), `g(u2 - u1) = sum w_k cos(2 pi n_k (u2 - u1))` (only the
//! separation) and the matched filter `p(u) = sum w_k Re(conj(s_k(u)) z_k)`. On a coarse grid
//! `p` is computed once per pixel; then every pair costs a handful of operations. The best pair
//! is refined, and so is the best single echo.
//!
//! The first echo counts only where it is unambiguous: its cost must beat a single echo
//! anywhere and every pair whose first echo lies elsewhere, by more than the misfit of the
//! pixel (as the unwrapping of a single echo, [`super::kernels::NOISE_PRIOR_DOF`]).
//!
//! Scalar code: it runs only for the pixels that a single echo does not explain.

#![allow(clippy::indexing_slicing)] // indices below COARSE + LANES into arrays of that length: in bounds by construction

use std::f32::consts::TAU;
use std::sync::OnceLock;

use super::kernels::NOISE_PRIOR_DOF;
use super::lanes::{F8, Isa, LANES};
use crate::consts::FREQ_MULTIPLES;
use crate::multiversion;

/// Points of the coarse grid over the unambiguous range: 104 mm apart; at 120 MHz a step is a
/// twelfth of a cycle.
pub const COARSE: usize = 180;
/// Smallest separation of the two echoes, in coarse steps (312 mm): closer ones are one echo to
/// three frequencies.
pub const MIN_SEPARATION: usize = 3;
/// First echoes this many coarse steps apart or less are the same position (for the ambiguity).
pub const SAME_FIRST: usize = 2;
/// Degrees of freedom of a two-echo fit (six numbers, four unknowns).
pub const DOF_TWO: f32 = 2.0;
/// The second echo must be at least this strong relative to the first before the first replaces
/// the single echo's distance: a weaker one moves that distance by centimeters (a quarter: the
/// pixels of two overlaid walls keep the near one), less than the split's own noise.
pub const STRONG_SECOND: f32 = 0.35;

/// The first echo must be at least this strong relative to the second: else a tiny echo in front
/// of the real one fits almost as well as the real one alone, at every distance in front of it.
pub const FIRST_MIN: f32 = 0.25;

/// The grid plus a vector of padding (loads of eight lanes never leave it).
const PAD: usize = COARSE + LANES;

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
    /// the same of the best single echo (4 degrees of freedom)
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
    /// is proportional to both; infinite = no prior): a strong echo far away is the alias of a
    /// near one (at u and u + 1/2 the 16 and 80 MHz phases are the same)
    pub max_amp_u2: f32,
    /// the cost of an echo t times brighter than that: penalty_scale (t - 1)^2 / t (about
    /// penalty_scale ln(t)^2 near 1, more far beyond: the unwrapping's plausibility penalty)
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

/// The steering vector of a distance: (cos, sin) of 2 pi n_k u per frequency.
#[inline]
fn steering(u: f32) -> [(f32, f32); 3] {
    std::array::from_fn(|k| {
        let n = FREQ_MULTIPLES.get(k).copied().unwrap_or(1) as f32;
        let t = n * u;
        let ph = TAU * (t - t.floor());
        (ph.cos(), ph.sin())
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
    /// sum of w_radial |z|^2: the weighted energy (the measurement has no tangential part)
    zz: f32,
}

impl Frame {
    fn new(z: &[(f32, f32); 3], n: &Noise) -> Option<Frame> {
        let mut e = [(0.0, 0.0); 3];
        let mut zz = 0.0;
        for k in 0..3 {
            let m = (z[k].0 * z[k].0 + z[k].1 * z[k].1).sqrt();
            if !(m > 0.0 && n.radial[k] > 0.0 && n.tangential[k] > 0.0) {
                return None;
            }
            e[k] = (z[k].0 / m, z[k].1 / m);
            zz += n.radial[k] * m * m;
        }
        let inv_lim = if n.max_amp_u2.is_finite() && n.max_amp_u2 > 0.0 { 1.0 / n.max_amp_u2 } else { 0.0 };
        Some(Frame { inv_lim, ps: n.penalty_scale, e, sr: n.radial.map(f32::sqrt), st: n.tangential.map(f32::sqrt), zz })
    }

    /// The brightness penalty of an echo of amplitude `a` at `u2` = u^2.
    #[inline]
    fn penalty(&self, a: f32, u2: f32) -> f32 {
        let t = a * u2 * self.inv_lim;
        if t > 1.0 { self.ps * (t - 1.0) * (t - 1.0) / t } else { 0.0 }
    }

    /// The whitened components of a steering vector: (radial, tangential) per frequency.
    #[inline]
    fn project(&self, s: &[(f32, f32); 3]) -> ([f32; 3], [f32; 3]) {
        let r = std::array::from_fn(|k| self.sr[k] * (s[k].0 * self.e[k].0 + s[k].1 * self.e[k].1));
        let t = std::array::from_fn(|k| self.st[k] * (s[k].1 * self.e[k].0 - s[k].0 * self.e[k].1));
        (r, t)
    }
}

/// Matched filter, norm and correlation of whitened steering vectors, with the weighted
/// measurement `y_k = sr_k |z_k|` along the radial axes.
#[inline]
fn dot(a: &([f32; 3], [f32; 3]), b: &([f32; 3], [f32; 3])) -> f32 {
    (0..3).map(|k| a.0[k] * b.0[k] + a.1[k] * b.1[k]).sum()
}

/// Cost and amplitudes of two echoes: (cost, A1, A2), the cost infinite where an amplitude
/// would be negative or the pair is degenerate.
#[inline(always)]
fn pair_cost(zz: f32, n1: f32, n2: f32, g: f32, b1: f32, b2: f32) -> (f32, f32, f32) {
    let det = n1 * n2 - g * g;
    let inv = 1.0 / det.max(1e-30);
    let a1 = (n2 * b1 - g * b2) * inv;
    let a2 = (n1 * b2 - g * b1) * inv;
    let ok = det > 1e-6 * n1 * n2 && a1 > 0.0 && a2 > 0.0;
    (if ok { (zz - a1 * b1 - a2 * b2).max(0.0) } else { f32::INFINITY }, a1, a2)
}

/// The cost of two echoes at `u1`, `u2` (exact steering).
fn pair_at(f: &Frame, y: &[f32; 3], u1: f32, u2: f32) -> (f32, f32, f32) {
    let (s1, s2) = (f.project(&steering(u1)), f.project(&steering(u2)));
    let b = |s: &([f32; 3], [f32; 3])| (0..3).map(|k| s.0[k] * y[k]).sum::<f32>();
    let (c, a1, a2) = pair_cost(f.zz, dot(&s1, &s1), dot(&s2, &s2), dot(&s1, &s2), b(&s1), b(&s2));
    (c + f.penalty(a1, u1 * u1) + f.penalty(a2, u2 * u2), a1, a2)
}

/// The cost of one echo at `u` (exact steering; infinite for a negative amplitude).
fn single_at(f: &Frame, y: &[f32; 3], u: f32) -> f32 {
    let s = f.project(&steering(u));
    let b: f32 = (0..3).map(|k| s.0[k] * y[k]).sum();
    let n = dot(&s, &s);
    if b > 0.0 && n > 0.0 { (f.zz - b * b / n).max(0.0) + f.penalty(b / n, u * u) } else { f32::INFINITY }
}

/// The whitened steering vectors of the grid, the matched filter and the norms.
struct Planes {
    r: [[f32; PAD]; 3],
    t: [[f32; PAD]; 3],
    b: [f32; PAD],
    n: [f32; PAD],
    /// u^2 of the grid point (for the brightness limit)
    u2: [f32; PAD],
}

/// The best second echo for the first echo at grid point `i`: (cost, separation in steps).
/// Eight separations at a time.
#[inline(always)]
fn best_second<I: Isa>(i: usize, pl: &Planes, zz: f32, inv_lim: f32, ps: f32) -> (f32, usize) {
    let (zero, inf) = (F8::zero(), F8::splat(f32::INFINITY));
    let iota = F8(std::array::from_fn(|l| l as f32));
    // the second echo below the end of the range, and not closer than MIN_SEPARATION modulo it
    let dmax = (COARSE - 1 - i).min(COARSE - MIN_SEPARATION);
    let ri: [F8; 3] = std::array::from_fn(|k| F8::splat(pl.r[k][i]));
    let ti: [F8; 3] = std::array::from_fn(|k| F8::splat(pl.t[k][i]));
    let (b1, n1, zzv, dmaxv) = (F8::splat(pl.b[i]), F8::splat(pl.n[i]), F8::splat(zz), F8::splat(dmax as f32));
    let tiny = F8::splat(1e-6) * n1;
    let (inv_limv, psv, onev, u2i) = (F8::splat(inv_lim), F8::splat(ps), F8::splat(1.0), F8::splat(pl.u2[i]));
    // the brightness penalty ps (t - 1)^2 / t beyond t = 1
    let pen = |t: F8| t.gt(onev).and(psv * (t - onev) * (t - onev) / t.max(onev));
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
        let inv = F8::splat(1.0) / det.max(F8::splat(1e-30));
        let a1 = n2.mul_add::<I>(b1, -(g * b2)) * inv;
        let a2 = n1.mul_add::<I>(b2, -(g * b1)) * inv;
        let c = (-a2).mul_add::<I>(b2, (-a1).mul_add::<I>(b1, zzv)).max(zero);
        let d = iota + F8::splat(d0 as f32);
        let c = c + pen(a1 * u2i * inv_limv) + pen(a2 * F8::load(&pl.u2, j) * inv_limv);
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

multiversion! {
    /// Splits a pixel into two echoes: `z` its complex value per frequency (gain corrected),
    /// `noise` the weights of its residuals. `None` if no pair fits.
    pub fn split(z: &[(f32, f32); 3], noise: &Noise) -> Option<Split> {
        split_with::<Isa>(z, noise)
    }
}

/// The coarse search of a pixel: per first echo on the grid the cost of its best pair (infinite
/// where none fits) and the separation of that pair's second echo in grid steps; the best single
/// echo on the grid.
#[derive(Clone, Debug)]
pub struct Coarse {
    /// cost of the best pair per first echo
    pub by_first: [f32; COARSE],
    /// separation of the second echo of that pair, grid steps
    pub second: [u16; COARSE],
    /// cost and grid point of the best single echo
    pub single: (f32, usize),
}

multiversion! {
    /// The coarse search alone (see [`Coarse`]), for choosing the first echo with the neighbors.
    pub fn coarse(z: &[(f32, f32); 3], noise: &Noise) -> Option<Coarse> {
        let f = Frame::new(z, noise)?;
        let y: [f32; 3] = std::array::from_fn(|k| f.sr[k] * (z[k].0 * z[k].0 + z[k].1 * z[k].1).sqrt());
        Some(search::<Isa>(&f, &y))
    }
}

/// Refines two echoes near `u1`, `u2` (coordinate descent from a quarter grid step down):
/// (u1, u2, cost, A1, A2).
pub fn refine(z: &[(f32, f32); 3], noise: &Noise, u1: f32, u2: f32) -> Option<(f32, f32, f32, f32, f32)> {
    let f = Frame::new(z, noise)?;
    let y: [f32; 3] = std::array::from_fn(|k| f.sr[k] * (z[k].0 * z[k].0 + z[k].1 * z[k].1).sqrt());
    let (u1, u2, cost, a1, a2) = refine_pair(&f, &y, u1, u2);
    cost.is_finite().then_some((u1, u2, cost, a1, a2))
}

/// The moves of the refinement: along both axes and both diagonals (two echoes close together
/// trade distance along a diagonal valley of the cost).
const MOVES: [(f32, f32); 8] = [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0), (1.0, 1.0), (-1.0, -1.0), (1.0, -1.0), (-1.0, 1.0)];
/// Rounds of moves per step size at most.
const REPEATS: usize = 4;

/// Refines a pair from `u1`, `u2`: pattern search from half a grid step down to 1/64 of one.
/// (u1, u2, cost with the penalty, A1, A2).
fn refine_pair(f: &Frame, y: &[f32; 3], u1: f32, u2: f32) -> (f32, f32, f32, f32, f32) {
    let step = 1.0 / COARSE as f32;
    let (mut u1, mut u2) = (u1, u2);
    let (mut cost, mut a1, mut a2) = pair_at(f, y, u1, u2);
    let mut h = 0.5 * step;
    while h > step / 64.0 {
        for _ in 0..REPEATS {
            let mut moved = false;
            for (m1, m2) in MOVES {
                let (v1, v2) = (u1 + m1 * h, u2 + m2 * h);
                if v1 <= 0.0 || v2 - v1 < MIN_SEPARATION as f32 * step - 1e-6 || v2 >= 1.0 {
                    continue;
                }
                let (c, b1, b2) = pair_at(f, y, v1, v2);
                if c < cost {
                    (u1, u2, cost, a1, a2) = (v1, v2, c, b1, b2);
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

/// The grid search of a pixel (see [`Coarse`]).
#[inline(always)]
fn search<I: Isa>(f: &Frame, y: &[f32; 3]) -> Coarse {
    let t = grid();
    let mut pl = Planes { r: [[0.0; PAD]; 3], t: [[0.0; PAD]; 3], b: [0.0; PAD], n: [0.0; PAD], u2: [0.0; PAD] };
    for j in 0..COARSE {
        let (r, tn) = f.project(&std::array::from_fn(|k| (t.cos[k][j], t.sin[k][j])));
        for k in 0..3 {
            pl.r[k][j] = r[k];
            pl.t[k][j] = tn[k];
        }
        pl.b[j] = (0..3).map(|k| r[k] * y[k]).sum();
        pl.n[j] = (0..3).map(|k| r[k] * r[k] + tn[k] * tn[k]).sum();
        let u = j as f32 / COARSE as f32;
        pl.u2[j] = u * u;
    }
    let mut single = (f32::INFINITY, 0usize);
    for j in 0..COARSE {
        let (b, n) = (pl.b[j], pl.n[j]);
        let c = if b > 0.0 && n > 0.0 { f.zz - b * b / n + f.penalty(b / n, pl.u2[j]) } else { f32::INFINITY };
        if c < single.0 {
            single = (c, j);
        }
    }
    // the first echo not at 0: stray light in the lens comes from there
    let mut by_first = [f32::INFINITY; COARSE];
    let mut second = [0u16; COARSE];
    for i in 1..COARSE - MIN_SEPARATION {
        let (c, d) = best_second::<I>(i, &pl, f.zz, f.inv_lim, f.ps);
        by_first[i] = c;
        second[i] = d as u16;
    }
    Coarse { by_first, second, single }
}

#[inline(always)]
fn split_with<I: Isa>(z: &[(f32, f32); 3], noise: &Noise) -> Option<Split> {
    let step = 1.0 / COARSE as f32;
    let f = Frame::new(z, noise)?;
    // the weighted measurement along the radial axes
    let y: [f32; 3] = std::array::from_fn(|k| f.sr[k] * (z[k].0 * z[k].0 + z[k].1 * z[k].1).sqrt());
    let cs = search::<I>(&f, &y);
    let best_single = cs.single;
    let by_first = cs.by_first;
    let mut best = (f32::INFINITY, 0usize, 0usize);
    for (i, &c) in by_first.iter().enumerate() {
        if c < best.0 {
            best = (c, i, i + usize::from(cs.second[i]));
        }
    }
    if !best.0.is_finite() {
        return None;
    }
    // the best pair whose first echo lies elsewhere (coarse against coarse)
    let alt = by_first
        .iter()
        .enumerate()
        .filter(|(i, _)| i.abs_diff(best.1) > SAME_FIRST)
        .map(|(_, c)| *c)
        .fold(f32::INFINITY, f32::min);
    // refine the pair and the single echo
    let (u1, u2, cost, a1, a2) = refine_pair(&f, &y, best.1 as f32 * step, best.2 as f32 * step);
    let mut us = best_single.1 as f32 * step;
    let mut single = single_at(&f, &y, us);
    let mut h = 0.5 * step;
    while h > step / 64.0 {
        for du in [h, -h] {
            let c = single_at(&f, &y, us + du);
            if c < single {
                (us, single) = (us + du, c);
            }
        }
        h *= 0.5;
    }
    // the residual alone, the penalty apart
    let penalty = f.penalty(a1, u1 * u1) + f.penalty(a2, u2 * u2);
    let resid = (cost - penalty).max(0.0);
    // the misfit of the pixel scales the evidence, as in the unwrapping
    let scale = ((NOISE_PRIOR_DOF + resid) / (NOISE_PRIOR_DOF + DOF_TWO)).max(1.0);
    let margin = (single - cost).min(alt - best.0);
    Some(Split { u1, u2, a1, a2, cost: resid, penalty, single, gap: (margin / scale).max(0.0) })
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
        let s = split(&mix(&[(d1, 40.0), (d2, 80.0)]), &w).unwrap();
        assert!((s.u1 - d1).abs() < 0.001, "{s:?}");
        assert!((s.u2 - d2).abs() < 0.001, "{s:?}");
        assert!((s.a1 - 40.0).abs() < 1.0 && (s.a2 - 80.0).abs() < 1.0, "{s:?}");
        assert!(s.cost < 1.0 && s.single > 100.0 && s.gap > 100.0, "{s:?}");
    }

    #[test]
    fn a_single_echo_gives_no_evidence_for_a_first_one() {
        let w = Noise { radial: [1.0; 3], tangential: [1.0; 3], max_amp_u2: f32::INFINITY, penalty_scale: 0.0 };
        let s = split(&mix(&[(0.2, 50.0)]), &w);
        // any pair fits it only with a second echo of no amplitude: no better than one echo
        assert!(s.is_none_or(|s| s.gap < 1.0), "{s:?}");
    }
}
