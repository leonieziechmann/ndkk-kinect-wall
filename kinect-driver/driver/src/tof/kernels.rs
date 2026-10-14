//! The per-row pixel kernels of the CPU decoder.
//!
//! Every function works on whole image rows held as fixed-size arrays (`[f32; WIDTH]`), with
//! loops over `0..WIDTH` (or `1..WIDTH - 1` for neighbors), so every index is within bounds by
//! construction: the compiler proves it and no panic path exists. That is why this module
//! allows plain indexing. The loops are written so they vectorize (no calls, no early exits,
//! selects instead of branches); `multiversion!` builds them for AVX2 + FMA as well.

#![allow(clippy::indexing_slicing, clippy::needless_range_loop, clippy::too_many_arguments)]

use super::lanes::{F8, Isa, LANES, M8};
use super::math::{atan2, exp, fmax, fmin, ln};

use crate::consts::{FREQ_MULTIPLES, HEIGHT, SATURATED, WIDTH};
use crate::multiversion;
use crate::tables::{PHASE_UNIT_MM, depth_from_phase};

/// One image row.
pub type Row = [f32; WIDTH];
/// One row of bytes.
pub type RowU8 = [u8; WIDTH];
/// One row of flags.
pub type RowFlags = [u32; WIDTH];

const W: usize = WIDTH;
const TAU: f32 = std::f32::consts::TAU;
/// Pixels this confident count as anchors for their neighbors in the resolver.
pub const ANCHOR_CONFIDENCE: f32 = 0.8;
/// Largest sample magnitude the 11-bit code can carry.
pub const FULL_SCALE: f32 = 16320.0;

/// Per-pixel flags of the decoder output.
pub mod flags {
    /// frequency 0 (80 MHz) had a saturated sample
    pub const SATURATED_80: u32 = 1 << 0;
    /// frequency 1 (16 MHz) had a saturated sample
    pub const SATURATED_16: u32 = 1 << 1;
    /// frequency 2 (120 MHz) had a saturated sample
    pub const SATURATED_120: u32 = 1 << 2;
    /// frequency 0 was rebuilt from two of its three samples
    pub const REPAIRED_80: u32 = 1 << 3;
    /// frequency 1 was rebuilt
    pub const REPAIRED_16: u32 = 1 << 4;
    /// frequency 2 was rebuilt
    pub const REPAIRED_120: u32 = 1 << 5;
    /// no frequency usable for the infrared value: filled from the surroundings
    pub const IR_FILLED: u32 = 1 << 6;
    /// depth from a single frequency (chosen by the neighbors or the near assumption)
    pub const SINGLE_FREQUENCY: u32 = 1 << 7;
    /// the neighbors decided between candidate distances
    pub const RESOLVED: u32 = 1 << 8;
    /// rejected as a flying pixel at a depth edge
    pub const EDGE: u32 = 1 << 9;
    /// rejected for low confidence
    pub const LOW_CONFIDENCE: u32 = 1 << 10;
    /// data of this pixel was lost on the USB bus
    pub const DATA_LOST: u32 = 1 << 11;
    /// outside min_depth..max_depth
    pub const OUT_OF_RANGE: u32 = 1 << 12;
    /// saturated and alone: assumed to be near
    pub const NEAR_PRIOR: u32 = 1 << 13;
    /// weak signal averaged over 5 x 5 pixels
    pub const WEAK_BOOSTED: u32 = 1 << 14;
    /// no usable signal at all
    pub const NO_SIGNAL: u32 = 1 << 15;
    /// depth interpolated inside a saturated area from the measured rim of the same object
    pub const DEPTH_FILLED: u32 = 1 << 16;
    /// rejected: no neighbor at a similar depth (isolated noise)
    pub const SPECKLE: u32 = 1 << 17;
    /// a candidate distance was ruled out because the brightness would not fit it
    pub const PLAUSIBILITY: u32 = 1 << 18;
    /// all saturation bits
    pub const SATURATED_ANY: u32 = SATURATED_80 | SATURATED_16 | SATURATED_120;
    /// all repair bits
    pub const REPAIRED_ANY: u32 = REPAIRED_80 | REPAIRED_16 | REPAIRED_120;
}

/// `kind` values of the unwrapping result.
pub mod kind {
    /// no usable frequency
    pub const NONE: u8 = 0;
    /// two or three frequencies
    pub const MULTI: u8 = 1;
    /// one frequency (index in bits 4..6)
    pub const SINGLE: u8 = 2;
}

// ---- stage 1: samples -> complex value per frequency -------------------------------------

/// Tables of stage 1 for one row.
pub struct S1Tabs<'a> {
    /// multiplier * cos(p0) per frequency
    pub mc: [&'a Row; 3],
    /// multiplier * sin(p0) per frequency
    pub ms: [&'a Row; 3],
    /// 1 where the pixel has a valid z table entry
    pub valid: &'a Row,
}

/// Outputs of stage 1 for one row.
pub struct S1Out<'a> {
    /// real part per frequency
    pub a: [&'a mut Row; 3],
    /// imaginary part per frequency
    pub b: [&'a mut Row; 3],
    /// squared amplitude per frequency (what the filter compares)
    pub n2: [&'a mut Row; 3],
    /// a / amplitude
    pub na: [&'a mut Row; 3],
    /// b / amplitude
    pub nb: [&'a mut Row; 3],
    /// infrared output
    pub ir: &'a mut Row,
    /// bit k: frequency k usable (extended mode)
    pub usable: &'a mut RowU8,
    /// flags
    pub flags: &'a mut RowFlags,
}

/// Constants of stage 1.
#[derive(Clone, Copy, Debug)]
pub struct S1Params {
    /// cos of the three phase steps
    pub cos_t: [f32; 3],
    /// sin of the three phase steps
    pub sin_t: [f32; 3],
    /// compat infrared: 1/3 * ab_multiplier * ab_output_multiplier
    pub ir_scale: f32,
    /// HDR infrared: ab_multiplier * ab_output_multiplier
    pub ir_lin: f32,
    /// rebuild one saturated sample
    pub repair: bool,
    /// rebuild one lost sample (a sub-image row that did not arrive)
    pub repair_lost: bool,
    /// plausibility ratio of a rebuilt sample
    pub repair_ratio: f32,
    /// treat +-16320 as saturated
    pub full_scale: bool,
    /// HDR weight of a rebuilt frequency
    pub w_repaired: f32,
    /// 1 / gain correction per frequency
    pub gain: [f32; 3],
}

multiversion! {
    /// libfreenect2's stage 1 (as fast_depth.cpp): a saturated sample zeroes its frequency and
    /// makes the infrared white; amplitudes for the bilateral filter come from the unzeroed values.
    pub fn stage1_compat(v: &[Row; 9], freq_ok: [bool; 3], t: &S1Tabs, o: &mut S1Out, p: &S1Params) {
        let mut ir_acc = [0f32; W];
        for k in 0..3 {
            let (v0, v1, v2) = (&v[3 * k], &v[3 * k + 1], &v[3 * k + 2]);
            let (mc, ms) = (t.mc[k], t.ms[k]);
            let ok = if freq_ok[k] { 1.0f32 } else { 0.0 };
            let (c0, c1, c2) = (p.cos_t[0], p.cos_t[1], p.cos_t[2]);
            let (s0, s1, s2) = (p.sin_t[0], p.sin_t[1], p.sin_t[2]);
            for x in 0..W {
                let c = v0[x] * c0 + v1[x] * c1 + v2[x] * c2;
                let s = v0[x] * s0 + v1[x] * s1 + v2[x] * s2;
                let valid = t.valid[x] * ok;
                let av = valid * (mc[x] * c - ms[x] * s);
                let bv = valid * -(ms[x] * c + mc[x] * s);
                let nn = (av * av + bv * bv).sqrt();
                let sat = v0[x] == SATURATED || v1[x] == SATURATED || v2[x] == SATURATED;
                let av = if sat { 0.0 } else { av };
                let bv = if sat { 0.0 } else { bv };
                o.a[k][x] = av;
                o.b[k][x] = bv;
                o.n2[k][x] = nn * nn;
                let inv = if nn > 0.0 { 1.0 / nn.max(1e-30) } else { 0.0 };
                o.na[k][x] = av * inv;
                o.nb[k][x] = bv * inv;
                ir_acc[x] += if sat { 65535.0 } else { nn };
            }
        }
        for x in 0..W {
            o.ir[x] = (ir_acc[x] * p.ir_scale).min(65535.0);
            o.usable[x] = 0;
            o.flags[x] = 0;
        }
    }
}

multiversion! {
    /// The extended stage 1: one saturated or lost sample of a frequency is rebuilt from the
    /// other two (the three samples of a frequency sum to zero), a frequency with more is left
    /// out; the infrared is the average amplitude of the usable frequencies (HDR, not clipped).
    /// `sub_ok[s]`: the row of phase sub-image `s` arrived.
    pub fn stage1_extended(v: &[Row; 9], sub_ok: [bool; 9], t: &S1Tabs, o: &mut S1Out, p: &S1Params) {
        let mut ir_acc = [0f32; W];
        let mut w_acc = [0f32; W];
        let mut usable = [0u8; W];
        let mut fl = [0u32; W];
        let lost = sub_ok.iter().any(|ok| !ok);
        for k in 0..3 {
            let (v0, v1, v2) = (&v[3 * k], &v[3 * k + 1], &v[3 * k + 2]);
            let (mc, ms) = (t.mc[k], t.ms[k]);
            // a lost sample is unknown everywhere in the row: like a saturated one, but any
            // value is plausible for it
            let (m0, m1, m2) = (!sub_ok[3 * k], !sub_ok[3 * k + 1], !sub_ok[3 * k + 2]);
            let nmiss = u32::from(m0) + u32::from(m1) + u32::from(m2);
            let ok = nmiss == 0 || (nmiss == 1 && p.repair_lost);
            let (c0, c1, c2) = (p.cos_t[0], p.cos_t[1], p.cos_t[2]);
            let (s0, s1, s2) = (p.sin_t[0], p.sin_t[1], p.sin_t[2]);
            let gain = p.gain[k];
            let sat_bit = 1u32 << k;
            let rep_bit = 1u32 << (3 + k);
            let use_bit = 1u8 << k;
            for x in 0..W {
                let (x0, x1, x2) = (v0[x], v1[x], v2[x]);
                let st0 = x0 == SATURATED || (p.full_scale && x0.abs() >= FULL_SCALE);
                let st1 = x1 == SATURATED || (p.full_scale && x1.abs() >= FULL_SCALE);
                let st2 = x2 == SATURATED || (p.full_scale && x2.abs() >= FULL_SCALE);
                let nsat = u32::from(st0) + u32::from(st1) + u32::from(st2);
                let (u0, u1, u2) = (st0 || m0, st1 || m1, st2 || m2);
                let nunk = u32::from(u0) + u32::from(u1) + u32::from(u2);
                let k0 = if u0 { 0.0 } else { x0 };
                let k1 = if u1 { 0.0 } else { x1 };
                let k2 = if u2 { 0.0 } else { x2 };
                let sum_ok = k0 + k1 + k2;
                let max_ok = k0.abs().max(k1.abs()).max(k2.abs());
                let imputed = -sum_ok;
                let plausible = if nmiss == 1 { true } else { p.repair && imputed.abs() >= p.repair_ratio * max_ok };
                let repaired = nunk == 1 && plausible;
                let y0 = if u0 { imputed } else { x0 };
                let y1 = if u1 { imputed } else { x1 };
                let y2 = if u2 { imputed } else { x2 };
                let good = ok && t.valid[x] > 0.0 && (nunk == 0 || repaired);
                let c = y0 * c0 + y1 * c1 + y2 * c2;
                let s = y0 * s0 + y1 * s1 + y2 * s2;
                let av = if good { mc[x] * c - ms[x] * s } else { 0.0 };
                let bv = if good { -(ms[x] * c + mc[x] * s) } else { 0.0 };
                let nn = (av * av + bv * bv).sqrt();
                o.a[k][x] = av;
                o.b[k][x] = bv;
                o.n2[k][x] = nn * nn;
                let inv = if nn > 0.0 { 1.0 / nn.max(1e-30) } else { 0.0 };
                o.na[k][x] = av * inv;
                o.nb[k][x] = bv * inv;
                let w = if good { if repaired { p.w_repaired } else { 1.0 } } else { 0.0 };
                ir_acc[x] += w * nn * gain;
                w_acc[x] += w;
                usable[x] |= if good && nn > 0.0 { use_bit } else { 0 };
                fl[x] |= (if nsat > 0 { sat_bit } else { 0 }) | (if repaired && good { rep_bit } else { 0 });
            }
        }
        let lost_flag = if lost { flags::DATA_LOST } else { 0 };
        for x in 0..W {
            let ir = if w_acc[x] > 0.0 { ir_acc[x] / w_acc[x].max(1e-30) * p.ir_lin } else { 0.0 };
            let clipped = w_acc[x] <= 0.0 && fl[x] & flags::SATURATED_ANY != 0;
            o.ir[x] = ir;
            o.usable[x] = usable[x];
            o.flags[x] = fl[x] | lost_flag | (if clipped { flags::IR_FILLED } else { 0 });
        }
    }
}

// ---- stage 2: bilateral filter and phase unwrapping --------------------------------------

/// Five rows (y-2 ..= y+2, clamped at the image border) of one plane.
pub type Rows5<'a> = [&'a Row; 5];

/// Inputs of stage 2 for one row.
pub struct S2In<'a> {
    /// row index
    pub y: usize,
    /// real parts per frequency
    pub a: [Rows5<'a>; 3],
    /// imaginary parts per frequency
    pub b: [Rows5<'a>; 3],
    /// squared amplitudes per frequency
    pub n2: [Rows5<'a>; 3],
    /// normalized real parts
    pub na: [Rows5<'a>; 3],
    /// normalized imaginary parts
    pub nb: [Rows5<'a>; 3],
    /// usable bits (extended)
    pub usable: [&'a RowU8; 5],
    /// x table
    pub xt: &'a Row,
    /// z table
    pub zt: &'a Row,
}

/// Constants of stage 2.
#[derive(Clone, Copy, Debug)]
pub struct S2Params {
    /// bilateral: squared amplitude threshold
    pub jb_threshold: f32,
    /// bilateral: exponent factor (negative)
    pub jb_exp: f32,
    /// bilateral: edge threshold
    pub max_edge: f32,
    /// bilateral: spatial weights
    pub gauss: [f32; 9],
    /// bilateral on/off
    pub bilateral: bool,
    /// amplitude scale
    pub ab_multiplier: f32,
    /// libfreenect2 unwrapping constants
    pub slope: f32,
    /// libfreenect2 unwrapping constants
    pub conf_offset: f32,
    /// libfreenect2 unwrapping constants
    pub min_conf: f32,
    /// libfreenect2 unwrapping constants
    pub max_conf: f32,
    /// libfreenect2 unwrapping constants
    pub individual_threshold: f32,
    /// libfreenect2 unwrapping constants
    pub sum_threshold: f32,
    /// libfreenect2 unwrapping constants
    pub phase_offset: f32,
    /// extended: phase noise coefficient per frequency (rad * amplitude)
    pub noise_coeff: [f32; 3],
    /// extended: noise floor (rad)
    pub noise_floor: f32,
    /// extended: smallest usable amplitude
    pub min_amplitude: f32,
    /// extended: 5 x 5 averaging of weak pixels
    pub weak_boost: bool,
    /// extended: amplitude below which a pixel is weak
    pub weak_threshold: f32,
    /// extended: brightness plausibility on/off
    pub plausibility: bool,
    /// extended: 1 / (infrared of albedo 1 at 1 m), in libfreenect2's infrared scale
    pub inv_brightness: f32,
    /// extended: plausible reflectivity range
    pub min_reflectivity: f32,
    /// extended: plausible reflectivity range
    pub max_reflectivity: f32,
    /// libfreenect2's infrared output scale (amplitude * ab_multiplier * this = infrared)
    pub ir_output: f32,
}

/// Outputs of stage 2 (compat).
pub struct S2OutCompat<'a> {
    /// depth before the edge filter, mm
    pub raw_depth: &'a mut Row,
    /// sum of the amplitudes (edge filter)
    pub ir_sum: &'a mut Row,
    /// 1 = the bilateral filter saw no edge
    pub edge_ok: &'a mut RowU8,
}

/// Outputs of stage 2 (extended).
pub struct S2OutExt<'a> {
    /// best distance as fraction of the unambiguous range
    pub u1: &'a mut Row,
    /// second best
    pub u2: &'a mut Row,
    /// cost of the best (chi-square like)
    pub e1: &'a mut Row,
    /// cost of the second best
    pub e2: &'a mut Row,
    /// confidence 0..1
    pub conf: &'a mut Row,
    /// `kind::*`
    pub kind: &'a mut RowU8,
    /// single frequency: its phase in cycles
    pub csingle: &'a mut Row,
    /// sum of the usable amplitudes
    pub ir_sum: &'a mut Row,
    /// anchor weight for the resolver (confidence of reliable multi-frequency pixels, else 0)
    pub anchor: &'a mut Row,
    /// 1 = no edge in the bilateral filter
    pub edge_ok: &'a mut RowU8,
    /// saturation bits of stage 1 (for the neighbors in the resolver)
    pub sat: &'a mut RowU8,
    /// flags (WEAK_BOOSTED, NO_SIGNAL added)
    pub flags: &'a mut RowFlags,
}

/// The per-pixel constants of one step of the bilateral filter.
struct TapCenter {
    /// normalized (a, b) of the pixel
    sa: F8,
    sb: F8,
    /// a neighbor counts if its squared amplitude is at least this
    thr: F8,
    /// exponent factor: the weight is 2^(kx (1 - dot)), kx = 0 for a weak pixel
    kx: F8,
}

/// One row of the planes of a frequency, for the bilateral filter.
struct TapRows<'a> {
    a: &'a Row,
    b: &'a Row,
    n2: &'a Row,
    na: &'a Row,
    nb: &'a Row,
}

/// The sums of one step of the bilateral filter.
struct TapSums {
    wa: F8,
    wb: F8,
    ws: F8,
    /// sum of 1 - dot of the neighbors that count (twice the phase distance)
    dist2: F8,
}

/// One neighbor of eight pixels in the bilateral filter.
#[inline(always)]
fn tap<I: Isa>(s: &mut TapSums, c: &TapCenter, r: &TapRows, at: usize, g: F8) {
    let counts = F8::load(r.n2, at).ge(c.thr);
    let dot = c.sa.mul_add::<I>(F8::load(r.na, at), c.sb * F8::load(r.nb, at));
    // g exp(jb_exp (1 - dot) / 2) = g 2^(kx (1 - dot)); |dot| <= 1
    let w = counts.and(g * (-c.kx).mul_add::<I>(dot, c.kx).exp2_fd::<I>());
    s.wa = w.mul_add::<I>(F8::load(r.a, at), s.wa);
    s.wb = w.mul_add::<I>(F8::load(r.b, at), s.wb);
    s.ws = s.ws + w;
    s.dist2 = s.dist2 + counts.and(F8::splat(1.0) - dot);
}

/// The joint bilateral filter of one row and frequency (libfreenect2's filterPixelStage1).
/// `extended`: unusable neighbors never contribute, and the edge test only counts where the
/// pixel itself is strong. Writes the filtered (a, b) and updates `edge`.
///
/// Eight pixels at a time, the sums over the nine neighbors in registers.
#[inline(always)]
fn bilateral<I: Isa>(i: &S2In, k: usize, p: &S2Params, extended: bool, af: &mut Row, bf: &mut Row, edge: &mut RowU8) {
    let border = i.y < 1 || i.y > HEIGHT - 2;
    let (a, b, n2, na, nb) = (&i.a[k], &i.b[k], &i.n2[k], &i.na[k], &i.nb[k]);
    if !p.bilateral || border {
        *af = *a[2];
        *bf = *b[2];
        return;
    }
    let zero = F8::zero();
    let thr_strong = F8::splat(p.jb_threshold);
    // extended: a neighbor without amplitude (or NaN) never counts, not even for a weak pixel
    let thr_weak = F8::splat(if extended { 1e-30 } else { 0.0 });
    let k_strong = F8::splat(p.jb_exp * 0.5 * std::f32::consts::LOG2_E);
    let max_dist2 = F8::splat(2.0 * p.max_edge);
    let g = p.gauss.map(F8::splat);
    let rows = |r: usize| TapRows { a: a[r], b: b[r], n2: n2[r], na: na[r], nb: nb[r] };
    let (r0, r1, r2) = (rows(1), rows(2), rows(3));
    // pixels 1 ..= W - 2, eight at a time; the last step overlaps the one before
    let mut x0 = 1;
    loop {
        let x = x0.min(W - 1 - LANES);
        let nn2 = F8::load(r1.n2, x);
        let weak = nn2.lt(thr_strong);
        let c = TapCenter { sa: F8::load(r1.na, x), sb: F8::load(r1.nb, x), thr: weak.select(thr_weak, thr_strong), kx: weak.select(zero, k_strong) };
        let mut s = TapSums { wa: zero, wb: zero, ws: zero, dist2: zero };
        let (l, r) = (x - 1, x + 1);
        tap::<I>(&mut s, &c, &r0, l, g[0]);
        tap::<I>(&mut s, &c, &r0, x, g[1]);
        tap::<I>(&mut s, &c, &r0, r, g[2]);
        tap::<I>(&mut s, &c, &r1, l, g[3]);
        tap::<I>(&mut s, &c, &r1, x, g[4]);
        tap::<I>(&mut s, &c, &r1, r, g[5]);
        tap::<I>(&mut s, &c, &r2, l, g[6]);
        tap::<I>(&mut s, &c, &r2, x, g[7]);
        tap::<I>(&mut s, &c, &r2, r, g[8]);
        let ok = s.ws.gt(zero) & nn2.gt(zero);
        let inv = ok.and(F8::splat(1.0) / s.ws.max(F8::splat(1e-30)));
        (s.wa * inv).store(af, x);
        (s.wb * inv).store(bf, x);
        // extended: a weak pixel averages everything around it; that is no edge
        let counts = if extended { !weak } else { M8::splat(true) };
        let keep = s.dist2.lt(max_dist2) | !counts;
        if let Some(e) = edge.get_mut(x..x + LANES) {
            for (e, m) in e.iter_mut().zip(keep.0) {
                *e &= (m & 1) as u8;
            }
        }
        if x0 + LANES >= W - 1 {
            break;
        }
        x0 += LANES;
    }
    af[0] = a[2][0];
    bf[0] = b[2][0];
    af[W - 1] = a[2][W - 1];
    bf[W - 1] = b[2][W - 1];
}

multiversion! {
    /// libfreenect2's stage 2 (as fast_depth.cpp): bilateral filter, the closed-form phase
    /// unwrapping with its confidence test, depth.
    pub fn stage2_compat(i: &S2In, p: &S2Params, o: &mut S2OutCompat) {
        let mut af = [[0f32; W]; 3];
        let mut bf = [[0f32; W]; 3];
        let mut edge = [1u8; W];
        for k in 0..3 {
            let (fa, fb) = (&mut af[k], &mut bf[k]);
            bilateral::<Isa>(i, k, p, false, fa, fb, &mut edge);
        }
        let abm = p.ab_multiplier;
        let slope_pos = p.slope > 0.0;
        for x in 0..W {
            let (a0, a1, a2) = (af[0][x], af[1][x], af[2][x]);
            let (b0, b1, b2) = (bf[0][x], bf[1][x], bf[2][x]);
            let mut ph0 = atan2(b0, a0);
            let mut ph1 = atan2(b1, a1);
            let mut ph2 = atan2(b2, a2);
            ph0 += if ph0 < 0.0 { TAU } else { 0.0 };
            ph1 += if ph1 < 0.0 { TAU } else { 0.0 };
            ph2 += if ph2 < 0.0 { TAU } else { 0.0 };
            let ir0 = (a0 * a0 + b0 * b0).sqrt() * abm;
            let ir1 = (a1 * a1 + b1 * b1).sqrt() * abm;
            let ir2 = (a2 * a2 + b2 * b2).sqrt() * abm;
            let ir_sum = ir0 + ir1 + ir2;
            let ir_min = fmin(fmin(ir0, ir1), ir2);
            let ir_max = fmax(fmax(ir0, ir1), ir2);
            let t0 = ph0 * (3.0 / TAU);
            let t1 = ph1 * (15.0 / TAU);
            let t2 = ph2 * (2.0 / TAU);
            let t5 = ((t1 - t0) * 0.333333 + 0.5).floor() * 3.0 + t0;
            let mut t3 = t5 - t2;
            let c1 = t3 >= 0.0;
            let f1 = if c1 { 2.0 } else { -2.0 };
            let f2 = if c1 { 0.5 } else { -0.5 };
            t3 *= f2;
            t3 = (t3 - t3.floor()) * f1;
            let at3 = t3.abs();
            let c2 = 0.5 < at3 && at3 < 1.5;
            let mut t6 = t5 + if c2 { 15.0 } else { 0.0 };
            let mut t7 = t1 + if c2 { 15.0 } else { 0.0 };
            let mut t8 = (((t6 - t2) * 0.5 + 0.5).floor() * 2.0 + t2) * 0.5;
            t6 *= 0.333333;
            t7 *= 0.066667;
            let t9 = t8 + t6 + t7;
            let t10 = if t9 >= 0.0 { t9 * 0.333333 } else { 0.0 };
            t6 *= TAU;
            t7 *= TAU;
            t8 *= TAU;
            let t8n = t7 * 0.826977 - t8 * 0.110264;
            let t6n = t8 * 0.551318 - t6 * 0.826977;
            let t7n = t6 * 0.110264 - t7 * 0.551318;
            let norm = t8n * t8n + t6n * t6n + t7n * t7n;
            let irx = if slope_pos { ir_min } else { ir_max };
            let irx = ln(fmax(irx, 1e-20));
            // libfreenect2's literals (log10(2), log2(10)), kept exactly
            #[allow(clippy::approx_constant)]
            let irx = exp((irx * p.slope * 0.301030 + p.conf_offset) * 3.321928);
            let irx = fmin(fmax(irx, p.min_conf), p.max_conf);
            let irx = irx * irx;
            let strong = ir_min >= p.individual_threshold && ir_sum >= p.sum_threshold && irx >= norm;
            let mut pf = if strong { t10 } else { 0.0 };
            pf += if pf > 0.0 { p.phase_offset } else { 0.0 };
            o.raw_depth[x] = depth_from_phase(pf, i.xt[x], i.zt[x]);
            o.ir_sum[x] = ir_sum;
            o.edge_ok[x] = edge[x];
        }
    }
}

/// 5 x 5 phase-coherent average of a weak pixel: replaces (a, b) where the neighbors agree in
/// phase (no edge), multiplying the signal-to-noise ratio by up to 5.
#[inline(always)]
fn weak_boost(i: &S2In, k: usize, p: &S2Params, af: &mut Row, bf: &mut Row, boosted: &mut RowU8) {
    let (a, b, n2) = (&i.a[k], &i.b[k], &i.n2[k]);
    let mut sa = [0f32; W];
    let mut sb = [0f32; W];
    let mut sm = [0f32; W];
    let mut cnt = [0f32; W];
    for dy in 0..5 {
        for dx in 0..5usize {
            let (ra, rb, rn2) = (a[dy], b[dy], n2[dy]);
            for x in 2..W - 2 {
                let xo = x + dx - 2;
                let on = rn2[xo].sqrt();
                let use_it = on > 0.0;
                sa[x] += if use_it { ra[xo] } else { 0.0 };
                sb[x] += if use_it { rb[xo] } else { 0.0 };
                sm[x] += if use_it { on } else { 0.0 };
                cnt[x] += if use_it { 1.0 } else { 0.0 };
            }
        }
    }
    let thr = p.weak_threshold / p.ab_multiplier;
    for x in 2..W - 2 {
        let amp = (af[x] * af[x] + bf[x] * bf[x]).sqrt();
        let self_ok = n2[2][x] > 0.0;
        let weak = amp < thr;
        let coherent = (sa[x] * sa[x] + sb[x] * sb[x]).sqrt() > 0.8 * sm[x];
        let take = self_ok && weak && coherent && cnt[x] >= 12.0;
        let inv = 1.0 / cnt[x].max(1.0);
        af[x] = if take { sa[x] * inv } else { af[x] };
        bf[x] = if take { sb[x] * inv } else { bf[x] };
        boosted[x] |= u8::from(take);
    }
}

/// Cost added per candidate step of the unwrapping, so that equally good candidates are decided
/// the same way every time (the nearer wins) instead of by the rounding of the costs, which
/// differs between the CPU and the GPU. Far below any difference that means something (a cost
/// of 1 is one standard deviation squared).
pub const TIE_BREAK: f32 = 1e-3;

/// Phase noise of a frequency with a rebuilt sample relative to a measured one: the rebuilt
/// sample is minus the sum of the other two, which doubles the noise variance on average over
/// the phase (sqrt(3) at worst, 1 at best).
pub const REBUILT_NOISE: f32 = std::f32::consts::SQRT_2;

multiversion! {
    /// The extended stage 2: bilateral filter (unusable samples never count), optional 5 x 5
    /// averaging of weak pixels, then maximum-likelihood unwrapping over the whole unambiguous
    /// range: every candidate distance of the most precise usable frequency is refined with all
    /// usable frequencies, weighted by their noise; the best two are kept with their costs.
    pub fn stage2_extended(i: &S2In, p: &S2Params, o: &mut S2OutExt) {
        let mut af = [[0f32; W]; 3];
        let mut bf = [[0f32; W]; 3];
        let mut edge = [1u8; W];
        let mut boosted = [0u8; W];
        for k in 0..3 {
            let (fa, fb) = (&mut af[k], &mut bf[k]);
            bilateral::<Isa>(i, k, p, true, fa, fb, &mut edge);
            if p.weak_boost {
                weak_boost(i, k, p, fa, fb, &mut boosted);
            }
        }
        let f = Filtered { a: &af, b: &bf, edge: &edge, boosted: &boosted };
        for x in (0..W).step_by(LANES) {
            unwrap_extended::<Isa>(&f, i, p, o, x);
        }
    }
}

/// The filtered row of stage 2 (extended), input of the unwrapping.
struct Filtered<'a> {
    a: &'a [Row; 3],
    b: &'a [Row; 3],
    edge: &'a RowU8,
    boosted: &'a RowU8,
}

/// atan2 of eight lanes (the polynomial of [`super::math::atan2`]); atan2(0, 0) = 0.
#[inline(always)]
fn atan2_8<I: Isa>(y: F8, x: F8) -> F8 {
    let zero = F8::zero();
    let (ax, ay) = (x.abs(), y.abs());
    let (mx, mn) = (ax.max(ay), ax.min(ay));
    let a = mx.gt(zero).and(mn / mx.max(F8::splat(1e-30)));
    let s = a * a;
    let p = F8::splat(-0.011_721_2).mul_add::<I>(s, F8::splat(0.052_653_32));
    let p = p.mul_add::<I>(s, F8::splat(-0.116_432_87));
    let p = p.mul_add::<I>(s, F8::splat(0.193_543_46));
    let p = p.mul_add::<I>(s, F8::splat(-0.332_623_47));
    let p = p.mul_add::<I>(s, F8::splat(0.999_977_26));
    let r = a * p;
    let r = ay.gt(ax).select(F8::splat(1.570_796_4) - r, r);
    let r = x.lt(zero).select(F8::splat(std::f32::consts::PI) - r, r);
    y.lt(zero).select(-r, r)
}

/// The unwrapping of eight pixels from `x` on (stage 2, extended), all in registers.
#[inline(always)]
fn unwrap_extended<I: Isa>(f: &Filtered, i: &S2In, p: &S2Params, o: &mut S2OutExt, x: usize) {
    let (zero, one, inf) = (F8::zero(), F8::splat(1.0), F8::splat(f32::INFINITY));
    let nf = [FREQ_MULTIPLES[0] as f32, FREQ_MULTIPLES[1] as f32, FREQ_MULTIPLES[2] as f32];
    let abm = F8::splat(p.ab_multiplier);
    // pass A: phase (cycles) and weight 1 / sigma^2 of every usable frequency
    let mut c = [zero; 3];
    let mut w = [zero; 3];
    let mut ir_sum = zero;
    let mut nvalid = zero;
    let floor2 = F8::splat(p.noise_floor * p.noise_floor);
    for k in 0..3 {
        let (ak, bk) = (F8::load(&f.a[k], x), F8::load(&f.b[k], x));
        let ir = ak.mul_add::<I>(ak, bk * bk).sqrt() * abm;
        let use_k = M8::bits_u8(i.usable[2], x, 1 << k) & ir.ge(F8::splat(p.min_amplitude));
        let ck = atan2_8::<I>(bk, ak) * F8::splat(1.0 / TAU);
        c[k] = ck + ck.lt(zero).and(one);
        // a rebuilt sample carries the noise of the two it came from
        let rebuilt = M8::bits_u32(o.flags, x, flags::REPAIRED_80 << k);
        let coeff = rebuilt.select(F8::splat(p.noise_coeff[k] * REBUILT_NOISE), F8::splat(p.noise_coeff[k]));
        let sig = (coeff / ir.max(F8::splat(1e-6))).min(F8::splat(3.0));
        // in cycles: sigma_c^2 = (sig^2 + floor^2) / tau^2
        let var = sig.mul_add::<I>(sig, floor2);
        w[k] = use_k.and(F8::splat(TAU * TAU) / var.max(F8::splat(1e-12 * TAU * TAU)));
        ir_sum = ir_sum + use_k.and(ir);
        nvalid = nvalid + use_k.and(one);
    }
    // the brightness in libfreenect2's infrared scale, for the plausibility of candidates
    let irl = ir_sum / nvalid.max(one) * F8::splat(p.ir_output);
    // reference: the most precise usable frequency (120, then 80, then 16 MHz)
    let (use2, use0) = (w[2].gt(zero), w[0].gt(zero));
    let pick = |v2: f32, v0: f32, v1: f32| use2.select(F8::splat(v2), use0.select(F8::splat(v0), F8::splat(v1)));
    let c_ref = use2.select(c[2], use0.select(c[0], c[1]));
    let n_ref = pick(nf[2], nf[0], nf[1]);
    let inv_ref = pick(1.0 / nf[2], 1.0 / nf[0], 1.0 / nf[1]);
    let nf2 = nf.map(|v| F8::splat(v * v));
    let wn2 = w[0].mul_add::<I>(nf2[0], w[1].mul_add::<I>(nf2[1], w[2] * nf2[2]));
    let inv_wn2 = one / wn2.max(F8::splat(1e-30));
    // the two other frequencies (with the reference 120 MHz: 80 and 16; else the remaining
    // ones, whose weights are 0 where they are unusable). The reference itself has no residual
    // at its own candidates (0 up to rounding), so it adds nothing to the sums below.
    let o_c = [use2.select(c[0], c[1]), use2.select(c[1], c[2])];
    let o_w = [use2.select(w[0], w[1]), use2.select(w[1], w[2])];
    let o_n = [use2.select(F8::splat(nf[0]), F8::splat(nf[1])), use2.select(F8::splat(nf[1]), F8::splat(nf[2]))];
    // pass B: every candidate of the reference frequency, refined by least squares; keep the
    // best two
    let penalty = F8::splat(if p.plausibility { 30.0 } else { 0.0 });
    // reflectivity rho = brightness * (u * to_m)^2 outside [min, max] is implausible: as bounds
    // on u^2
    let to_m = U_RANGE_MM * 0.001;
    let bright = irl * F8::splat(p.inv_brightness * to_m * to_m);
    let (u2_max, u2_min) = (F8::splat(p.max_reflectivity) / bright, F8::splat(p.min_reflectivity) / bright);
    let (mut e1, mut u1, mut e2, mut u2) = (inf, zero, inf, zero);
    for m in 0..15 {
        let mf = F8::splat(m as f32);
        let um = (c_ref + mf) * inv_ref;
        let r: [F8; 2] = std::array::from_fn(|j| {
            let d = o_n[j].mul_add::<I>(um, -o_c[j]);
            d - d.round()
        });
        let q = [o_w[0] * r[0], o_w[1] * r[1]];
        let s1 = q[0].mul_add::<I>(o_n[0], q[1] * o_n[1]);
        let s2 = q[0].mul_add::<I>(r[0], q[1] * r[1]);
        let t = s1 * inv_wn2;
        let e = (-s1).mul_add::<I>(t, s2).max(zero);
        let u = um - t;
        // implausible reflectivities are penalized (a strong prior, not a hard limit)
        let uu = u * u;
        let e = e + (uu.gt(u2_max) | uu.lt(u2_min)).and(penalty);
        // equally good candidates (only 80 and 120 MHz usable repeat every 3.75 m): the nearer
        // one wins, not the rounding
        let e = mf.mul_add::<I>(F8::splat(TIE_BREAK), e);
        let e = mf.lt(n_ref).select(e, inf);
        let (b1, b2) = (e.lt(e1), e.lt(e2));
        e2 = b1.select(e1, b2.select(e, e2));
        u2 = b1.select(u1, b2.select(u, u2));
        e1 = b1.select(e, e1);
        u1 = b1.select(u, u1);
    }
    // pass C: confidence = how much better the best is than the second (posterior of two
    // hypotheses) times how consistent the best is (chi-square with nvalid - 1 dof)
    let dof = (nvalid - one).max(zero);
    let chi = dof + F8::splat(3.0) * (dof + dof).sqrt();
    let margin = (e2 - e1).min(F8::splat(80.0));
    let half = F8::splat(-0.5);
    let post = one / (one + (half * margin).exp_fd::<I>());
    let cons = (half * (e1 - chi).max(zero)).exp_fd::<I>();
    let multi = nvalid.ge(F8::splat(2.0));
    let single = nvalid.eq(one);
    let conf = multi.and(post * cons);
    single.select(c_ref * inv_ref, u1).store(o.u1, x);
    single.select((c_ref + one) * inv_ref, u2).store(o.u2, x);
    e1.store(o.e1, x);
    e2.store(o.e2, x);
    conf.store(o.conf, x);
    (multi & conf.ge(F8::splat(ANCHOR_CONFIDENCE))).and(conf).store(o.anchor, x);
    c_ref.store(o.csingle, x);
    ir_sum.store(o.ir_sum, x);
    // kind, with the index of the single frequency in bits 4..6
    let r_idx = use2.select_u32([2; LANES], (!use0).select_u32([1; LANES], [0; LANES]));
    let single_kind = std::array::from_fn(|l| u32::from(kind::SINGLE) | (r_idx[l] << 4));
    let kinds = multi.select_u32([u32::from(kind::MULTI); LANES], single.select_u32(single_kind, [u32::from(kind::NONE); LANES]));
    let plaus = e1.ge(F8::splat(25.0)) & nvalid.ge(one);
    let added = M8::bits_u8(f.boosted, x, 1).and_u32(flags::WEAK_BOOSTED);
    let added: [u32; LANES] = std::array::from_fn(|l| added[l] | nvalid.eq(zero).and_u32(flags::NO_SIGNAL)[l] | plaus.and_u32(flags::PLAUSIBILITY)[l]);
    let (Some(kd), Some(eo), Some(sat), Some(fl), Some(edge)) =
        (o.kind.get_mut(x..x + LANES), o.edge_ok.get_mut(x..x + LANES), o.sat.get_mut(x..x + LANES), o.flags.get_mut(x..x + LANES), f.edge.get(x..x + LANES))
    else {
        return;
    };
    for l in 0..LANES {
        kd[l] = kinds[l] as u8;
        eo[l] = edge[l];
        sat[l] = (fl[l] & flags::SATURATED_ANY) as u8;
        fl[l] |= added[l];
    }
}

// ---- stage 3: edge filter ----------------------------------------------------------------

/// Constants of the edge filter.
#[derive(Clone, Copy, Debug)]
pub struct EdgeParams {
    /// nearest depth, mm
    pub min_depth: f32,
    /// farthest depth, mm
    pub max_depth: f32,
    /// filter on/off
    pub enabled: bool,
    /// libfreenect2 thresholds
    pub avg_min: f32,
    /// libfreenect2 thresholds
    pub std_threshold: f32,
    /// libfreenect2 thresholds, mm
    pub close: f32,
    /// libfreenect2 thresholds, mm
    pub far: f32,
    /// libfreenect2 thresholds, mm
    pub max_delta: f32,
    /// libfreenect2 thresholds, mm
    pub avg_delta: f32,
    /// extended: thresholds grow beyond this depth (0 = never)
    pub scale_mm: f32,
}

/// The edge decision of libfreenect2's filterPixelStage2 for one pixel (true = flying pixel).
#[inline(always)]
fn is_flying(d: f32, dn: [f32; 8], s: f32, sn: [f32; 8], e: &EdgeParams) -> bool {
    let mut acc = s;
    let mut sq = s * s;
    let mut mn = d;
    let mut mx = d;
    for j in 0..8 {
        acc += sn[j];
        sq += sn[j] * sn[j];
        let o = dn[j];
        mn = if o > 0.0 { mn.min(o) } else { mn };
        mx = if o > 0.0 { mx.max(o) } else { mx };
    }
    let tmp0 = (sq * 9.0 - acc * acc).max(0.0).sqrt() / 9.0;
    let tmp0 = tmp0 / (acc / 9.0).max(e.avg_min);
    let amin = (d - mn).abs();
    let amax = (d - mx).abs();
    let avg = (amin + amax) * 0.5;
    let maxd = amin.max(amax);
    let scale = if e.scale_mm > 0.0 { (d / e.scale_mm).max(1.0) } else { 1.0 };
    d > 0.0
        && tmp0 >= e.std_threshold
        && e.close * scale < amin
        && e.far * scale < amax
        && e.max_delta * scale < maxd
        && e.avg_delta * scale < avg
}

multiversion! {
    /// libfreenect2's edge-aware filter for one row (compat; `rows` = y-1, y, y+1).
    pub fn stage3_compat(y: usize, d: [&Row; 3], s: [&Row; 3], edge_ok: &RowU8, e: &EdgeParams, out: &mut Row) {
        if !e.enabled {
            *out = *d[1];
            return;
        }
        let border_row = !(1..=HEIGHT - 2).contains(&y);
        for x in 0..W {
            let v = d[1][x];
            let in_range = v >= e.min_depth && v <= e.max_depth;
            if border_row || !(1..=W - 2).contains(&x) {
                out[x] = if in_range { v } else { 0.0 };
                continue;
            }
            let dn = [d[0][x - 1], d[0][x], d[0][x + 1], d[1][x - 1], d[1][x + 1], d[2][x - 1], d[2][x], d[2][x + 1]];
            let sn = [s[0][x - 1], s[0][x], s[0][x + 1], s[1][x - 1], s[1][x + 1], s[2][x - 1], s[2][x], s[2][x + 1]];
            let flying = is_flying(v, dn, s[1][x], sn, e);
            out[x] = if in_range && !flying && edge_ok[x] != 0 { v } else { 0.0 };
        }
    }
}

/// Inputs of the extended edge filter / finalization.
pub struct S3In<'a> {
    /// row
    pub y: usize,
    /// resolved depth rows y-2 ..= y+2 (clamped at the border)
    pub d: [&'a Row; 5],
    /// amplitude sums rows y-1, y, y+1
    pub s: [&'a Row; 3],
    /// bilateral edge test of the row
    pub edge_ok: &'a RowU8,
    /// confidence after resolution
    pub conf: &'a Row,
}

/// Constants of the extended finalization.
#[derive(Clone, Copy, Debug)]
pub struct S3Params {
    /// depth below this confidence is dropped
    pub min_conf: f32,
    /// speckle filter on/off
    pub speckle: bool,
    /// neighbors (of 24) that must agree
    pub speckle_min: f32,
}

multiversion! {
    /// Extended finalization of one row: edge filter with thresholds that grow with the depth,
    /// speckle filter (a depth needs neighbors at a similar depth), range check, confidence
    /// threshold.
    pub fn stage3_extended(i: &S3In, e: &EdgeParams, q: &S3Params, depth: &mut Row, confidence: &mut Row, fl: &mut RowFlags) {
        let y = i.y;
        let d = &i.d;
        let s = &i.s;
        let mut flying = [0u8; W];
        if e.enabled && (1..=HEIGHT - 2).contains(&y) {
            for x in 1..W - 1 {
                let v = d[2][x];
                let dn = [d[1][x - 1], d[1][x], d[1][x + 1], d[2][x - 1], d[2][x + 1], d[3][x - 1], d[3][x], d[3][x + 1]];
                let sn = [s[0][x - 1], s[0][x], s[0][x + 1], s[1][x - 1], s[1][x + 1], s[2][x - 1], s[2][x], s[2][x + 1]];
                // no short-circuit: the loop stays branch-free and vectorizes
                let fly = is_flying(v, dn, s[1][x], sn, e);
                let f = (v > 0.0) & (fly | (i.edge_ok[x] == 0));
                flying[x] = u8::from(f);
            }
        }
        // neighbors in a 5 x 5 window at a similar depth
        let mut agree = [24f32; W];
        if q.speckle && (2..=HEIGHT - 3).contains(&y) {
            for x in 2..W - 2 {
                agree[x] = 0.0;
            }
            for dy in 0..5 {
                for dx in 0..5usize {
                    if dy == 2 && dx == 2 {
                        continue;
                    }
                    let r = d[dy];
                    for x in 2..W - 2 {
                        let v = d[2][x];
                        let o = r[x + dx - 2];
                        let tol = (0.03 * v).max(50.0);
                        agree[x] += if (o > 0.0) & ((o - v).abs() < tol) { 1.0 } else { 0.0 };
                    }
                }
            }
        }
        for x in 0..W {
            let v = d[2][x];
            let in_range = (v >= e.min_depth) & (v <= e.max_depth);
            let fly = flying[x] != 0;
            let c = i.conf[x];
            let confident = c >= q.min_conf;
            let speckle = q.speckle & (agree[x] < q.speckle_min);
            let has = v > 0.0;
            let keep = has & in_range & !fly & confident & !speckle;
            depth[x] = if keep { v } else { 0.0 };
            confidence[x] = if keep { c } else { 0.0 };
            fl[x] |= (if has & !in_range { flags::OUT_OF_RANGE } else { 0 })
                | (if has & in_range & fly { flags::EDGE } else { 0 })
                | (if has & in_range & !fly & !confident { flags::LOW_CONFIDENCE } else { 0 })
                | (if has & in_range & !fly & confident & speckle { flags::SPECKLE } else { 0 });
        }
    }
}

/// libfreenect2's depth formula for a distance fraction `u` (re-exported for the resolver).
#[inline(always)]
pub fn depth_of_u(u: f32, xt: f32, zt: f32) -> f32 {
    depth_from_phase(9.0 * u, xt, zt)
}

/// The radial distance (mm) at which a pixel with z table `zt` reports depth `z` (roughly).
#[inline(always)]
pub fn u_of_depth(z: f32, zt: f32) -> f32 {
    if zt > 0.0 { z / (9.0 * zt) } else { 0.0 }
}

/// mm per unit of `u`.
pub const U_RANGE_MM: f32 = 9.0 * PHASE_UNIT_MM;
