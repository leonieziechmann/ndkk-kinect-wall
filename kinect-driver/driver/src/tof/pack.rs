//! Sixteen bits per value for the planes between the stages: half the memory (and memory
//! traffic) of `f32`, each plane in the format that fits its values.
//!
//! - [`Codec::F16`] (IEEE binary16) for values over orders of magnitude: the complex values and
//!   amplitudes, costs, amplitude sums. 11 significant bits: 0.05 % at most.
//! - Fixed point for values in a fixed range, finer than f16 there: [`Codec::Unorm`] (0..1:
//!   confidences, the single frequency's phase), [`Codec::Snorm`] (phase directions),
//!   [`Codec::Fraction`] (distance as a fraction of the 18.75 m range: steps of 0.32 mm),
//!   [`Codec::HalfMm`] (depth in millimeters: steps of 0.5 mm).
//!
//! Rounding is to the nearest value, ties to even, without branches (the loops vectorize; the
//! AVX2 build converts f16 with F16C). The GPU decoder (`decode.wgsl`) stores the same formats.
//! What the stages then compute differs from `f32` planes by deterministic rounding, far below
//! the sensor noise: it does not make the depth flicker (README, Rechenkerne).

use super::lanes::{Isa, LANES};
use super::math::{fmax, fmin};

/// How a plane is stored.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Codec {
    /// binary16 of `v * scale` (`scale` a power of two, so the values stay below 65504); beyond
    /// ±65504 clamped, NaN stored as 0
    F16 {
        /// multiplies before storing
        scale: f32,
    },
    /// 0..=1 in steps of 1/65535 (clamped)
    Unorm,
    /// `-range..=range` in steps of `range / 32767` (two's complement in the 16 bits)
    Snorm {
        /// the largest magnitude
        range: f32,
    },
    /// a distance fraction u: -1/16..=17/16 in steps of 1.125 / 65535 (a little room on both
    /// sides of 0..1, where the least squares can end)
    Fraction,
    /// millimeters, 0..=32767.5 in steps of 0.5 (negative: 0)
    HalfMm,
}

/// The format of each kind of value, shared by the CPU and the GPU decoder.
pub mod formats {
    use super::Codec;
    /// the complex value (a, b) of a frequency (|a|, |b| < 160000)
    pub const AB: Codec = Codec::F16 { scale: 0.25 };
    /// amplitudes
    pub const AMPLITUDE: Codec = Codec::F16 { scale: 0.25 };
    /// (a, b) / amplitude
    pub const DIRECTION: Codec = Codec::Snorm { range: 1.0 };
    /// distances as a fraction u of the unambiguous range
    pub const U: Codec = Codec::Fraction;
    /// how much more the second best distance costs (only `>= 20` matters)
    pub const GAP: Codec = Codec::F16 { scale: 1.0 };
    /// confidences and anchor weights
    pub const CONFIDENCE: Codec = Codec::Unorm;
    /// the phase of a single frequency, in cycles
    pub const PHASE: Codec = Codec::Unorm;
    /// sums of the three amplitudes (edge filter)
    pub const AMPLITUDE_SUM: Codec = Codec::F16 { scale: 1.0 / 16.0 };
    /// depths in millimeters
    pub const DEPTH: Codec = Codec::HalfMm;
    /// the per-pixel tables m cos(p0), m sin(p0) (|m| < 2)
    pub const TABLE: Codec = Codec::Snorm { range: 2.0 };
    /// infrared, HDR (what the GPU decoder reads back)
    pub const IR: Codec = Codec::F16 { scale: 1.0 / 32.0 };
}

/// 1 / 65535 as the decoders multiply with it.
pub const INV_65535: f32 = 1.0 / 65535.0;
/// 1 / 32767.
pub const INV_32767: f32 = 1.0 / 32767.0;
/// The offset of [`Codec::Fraction`].
pub const FRACTION_OFFSET: f32 = 0.0625;
/// The span of [`Codec::Fraction`].
pub const FRACTION_SPAN: f32 = 1.125;
/// 1 / [`FRACTION_SPAN`].
pub const INV_FRACTION_SPAN: f32 = 1.0 / FRACTION_SPAN;
/// The largest finite binary16.
pub const F16_MAX: f32 = 65504.0;

/// 1.5 * 2^23: adding it rounds an `f32` in -2^22..2^22 to an integer (ties to even), kept in
/// the low mantissa bits.
const ROUNDER: f32 = 12_582_912.0;
const ROUNDER_BITS: u32 = 0x4B40_0000;

/// `t` (an integer-valued range, |t| < 2^22) rounded to the nearest integer, ties to even, as
/// the low 16 bits of its two's complement.
#[inline(always)]
fn round16(t: f32) -> u16 {
    (t + ROUNDER).to_bits().wrapping_sub(ROUNDER_BITS) as u16
}

#[inline(always)]
fn not_nan(v: f32) -> f32 {
    if v.is_nan() { 0.0 } else { v }
}

/// `v` as binary16 bits, rounded to the nearest even, subnormals included. `v` must be finite
/// and within ±65504 (the codecs clamp first).
#[inline(always)]
pub fn f16_bits(v: f32) -> u16 {
    let x = v.to_bits();
    let sign = (x >> 16) & 0x8000;
    let a = x & 0x7fff_ffff;
    // normal: rebias the exponent (127 - 15), round the 13 dropped mantissa bits to even
    let normal = (a.wrapping_sub(0x3800_0000) + 0x0fff + ((a >> 13) & 1)) >> 13;
    // below 2^-14: a multiple of 2^-24; adding 0.5 (whose last bit is 2^-24) rounds it there
    let sub = (f32::from_bits(a) + 0.5).to_bits().wrapping_sub(0x3f00_0000);
    let r = if a < 0x3880_0000 { sub } else { normal };
    (sign | r) as u16
}

/// The value of binary16 bits (finite ones; exact).
#[inline(always)]
pub fn f16_value(h: u16) -> f32 {
    let h = u32::from(h);
    let sign = (h & 0x8000) << 16;
    let em = h & 0x7fff;
    let normal = (em << 13) + 0x3800_0000;
    // subnormal: em * 2^-24, exactly 0.5 + em * 2^-24 - 0.5
    let sub = (f32::from_bits(0x3f00_0000 + em) - 0.5).to_bits();
    f32::from_bits(sign | if em < 0x400 { sub } else { normal })
}

/// Eight values to binary16 with F16C (only called in the AVX2 build).
#[cfg(target_arch = "x86_64")]
#[inline(always)]
#[allow(unsafe_code)]
fn f16c_bits8(v: [f32; LANES]) -> Option<[u16; LANES]> {
    use std::arch::x86_64::{__m128i, __m256, _MM_FROUND_TO_NEAREST_INT, _mm256_cvtps_ph};
    // SAFETY: only called where `I::F16C` is set, i.e. inlined into the AVX2 build, which runs
    // only on CPUs with F16C (checked at run time, see simd.rs); the transmutes are between
    // types of the same size (32 and 16 bytes), moved by value
    unsafe {
        let x: __m256 = std::mem::transmute::<[f32; LANES], __m256>(v);
        Some(std::mem::transmute::<__m128i, [u16; LANES]>(_mm256_cvtps_ph::<_MM_FROUND_TO_NEAREST_INT>(x)))
    }
}

/// Eight binary16 values with F16C (only called in the AVX2 build).
#[cfg(target_arch = "x86_64")]
#[inline(always)]
#[allow(unsafe_code)]
fn f16c_values8(h: [u16; LANES]) -> Option<[f32; LANES]> {
    use std::arch::x86_64::{__m128i, __m256, _mm256_cvtph_ps};
    // SAFETY: as in `f16c_bits8`
    unsafe {
        let x: __m128i = std::mem::transmute::<[u16; LANES], __m128i>(h);
        Some(std::mem::transmute::<__m256, [f32; LANES]>(_mm256_cvtph_ps(x)))
    }
}

/// No F16C here.
#[cfg(not(target_arch = "x86_64"))]
#[inline(always)]
fn f16c_bits8(_: [f32; LANES]) -> Option<[u16; LANES]> {
    None
}

/// No F16C here.
#[cfg(not(target_arch = "x86_64"))]
#[inline(always)]
fn f16c_values8(_: [u16; LANES]) -> Option<[f32; LANES]> {
    None
}

/// Clamped, NaN-free `v * scale` for binary16.
#[inline(always)]
fn f16_input(v: f32, scale: f32) -> f32 {
    fmin(fmax(not_nan(v * scale), -F16_MAX), F16_MAX)
}

#[inline(always)]
fn pack_f16<I: Isa>(src: &[f32], dst: &mut [u16], scale: f32) {
    let n = src.len().min(dst.len());
    let (Some(src), Some(dst)) = (src.get(..n), dst.get_mut(..n)) else { return };
    let (s8, s_rest) = src.as_chunks::<LANES>();
    let (d8, d_rest) = dst.as_chunks_mut::<LANES>();
    for (s, d) in s8.iter().zip(d8.iter_mut()) {
        let v = s.map(|x| f16_input(x, scale));
        *d = match I::F16C.then(|| f16c_bits8(v)).flatten() {
            Some(h) => h,
            None => v.map(f16_bits),
        };
    }
    for (o, x) in d_rest.iter_mut().zip(s_rest) {
        *o = f16_bits(f16_input(*x, scale));
    }
}

#[inline(always)]
fn unpack_f16<I: Isa>(src: &[u16], dst: &mut [f32], inv: f32) {
    let n = src.len().min(dst.len());
    let (Some(src), Some(dst)) = (src.get(..n), dst.get_mut(..n)) else { return };
    let (s8, s_rest) = src.as_chunks::<LANES>();
    let (d8, d_rest) = dst.as_chunks_mut::<LANES>();
    for (s, d) in s8.iter().zip(d8.iter_mut()) {
        let v = match I::F16C.then(|| f16c_values8(*s)).flatten() {
            Some(v) => v,
            None => s.map(f16_value),
        };
        *d = v.map(|x| x * inv);
    }
    for (o, x) in d_rest.iter_mut().zip(s_rest) {
        *o = f16_value(*x) * inv;
    }
}

/// One value packed (the rows below do the same, many at a time).
#[inline(always)]
fn pack_one(codec: Codec, v: f32) -> u16 {
    let v = not_nan(v);
    match codec {
        Codec::F16 { scale } => f16_bits(f16_input(v, scale)),
        Codec::Unorm => round16(fmin(fmax(v, 0.0), 1.0) * 65535.0),
        Codec::Snorm { range } => round16(fmin(fmax(v * (1.0 / range), -1.0), 1.0) * 32767.0),
        Codec::Fraction => round16(fmin(fmax((v + FRACTION_OFFSET) * INV_FRACTION_SPAN, 0.0), 1.0) * 65535.0),
        Codec::HalfMm => round16(fmin(fmax(v * 2.0, 0.0), 65535.0)),
    }
}

/// One value unpacked.
#[inline(always)]
fn unpack_one(codec: Codec, q: u16) -> f32 {
    match codec {
        Codec::F16 { scale } => f16_value(q) * (1.0 / scale),
        Codec::Unorm => f32::from(q) * INV_65535,
        Codec::Snorm { range } => fmax(f32::from(q as i16) * INV_32767, -1.0) * range,
        Codec::Fraction => f32::from(q) * INV_65535 * FRACTION_SPAN - FRACTION_OFFSET,
        Codec::HalfMm => f32::from(q) * 0.5,
    }
}

/// [`pack_row`] for one value.
pub fn pack(codec: Codec, v: f32) -> u16 {
    pack_one(codec, v)
}

/// [`unpack_row`] for one value.
pub fn unpack(codec: Codec, q: u16) -> f32 {
    unpack_one(codec, q)
}

crate::multiversion! {
    /// Packs `src` into `dst` (as many values as the shorter has).
    pub fn pack_row(codec: Codec, src: &[f32], dst: &mut [u16]) {
        match codec {
            Codec::F16 { scale } => pack_f16::<Isa>(src, dst, scale),
            // one loop per format: each a straight line that vectorizes
            Codec::Unorm => dst.iter_mut().zip(src).for_each(|(o, v)| *o = pack_one(Codec::Unorm, *v)),
            Codec::Snorm { range } => dst.iter_mut().zip(src).for_each(|(o, v)| *o = pack_one(Codec::Snorm { range }, *v)),
            Codec::Fraction => dst.iter_mut().zip(src).for_each(|(o, v)| *o = pack_one(Codec::Fraction, *v)),
            Codec::HalfMm => dst.iter_mut().zip(src).for_each(|(o, v)| *o = pack_one(Codec::HalfMm, *v)),
        }
    }
}

crate::multiversion! {
    /// Unpacks `src` into `dst` (as many values as the shorter has).
    pub fn unpack_row(codec: Codec, src: &[u16], dst: &mut [f32]) {
        match codec {
            Codec::F16 { scale } => unpack_f16::<Isa>(src, dst, 1.0 / scale),
            Codec::Unorm => dst.iter_mut().zip(src).for_each(|(o, q)| *o = unpack_one(Codec::Unorm, *q)),
            Codec::Snorm { range } => dst.iter_mut().zip(src).for_each(|(o, q)| *o = unpack_one(Codec::Snorm { range }, *q)),
            Codec::Fraction => dst.iter_mut().zip(src).for_each(|(o, q)| *o = unpack_one(Codec::Fraction, *q)),
            Codec::HalfMm => dst.iter_mut().zip(src).for_each(|(o, q)| *o = unpack_one(Codec::HalfMm, *q)),
        }
    }
}

/// The software f16 conversion, for tests against F16C.
#[cfg(test)]
fn pack_f16_software(src: &[f32], dst: &mut [u16], scale: f32) {
    pack_f16::<super::lanes::Baseline>(src, dst, scale);
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::float_cmp)]
    use super::*;

    /// The binary16 value nearest to `v` by the textbook (ties to the even mantissa), in f64.
    fn reference_value(v: f32) -> f64 {
        let a = f64::from(v).abs();
        if a == 0.0 {
            return 0f64.copysign(f64::from(v));
        }
        // the spacing of binary16 around `a`: 2^-24 below 2^-14, else 2^(exponent - 10)
        let e = ((a.to_bits() >> 52) & 0x7ff) as i32 - 1023;
        let q = if e < -14 { 2f64.powi(-24) } else { 2f64.powi(e - 10) };
        let m = (a / q).floor();
        let frac = a / q - m;
        let m = if frac > 0.5 || (frac == 0.5 && m % 2.0 == 1.0) { m + 1.0 } else { m };
        (m * q).copysign(f64::from(v))
    }

    #[test]
    fn every_f16_round_trips() {
        for h in (0..0x7c00u16).chain(0x8000..0xfc00) {
            let v = f16_value(h);
            assert_eq!(f16_bits(v), h, "{h:#06x} = {v}");
            let mut out = [0u16; 1];
            pack_row(Codec::F16 { scale: 1.0 }, &[v], &mut out);
            assert_eq!(out[0], h);
            let mut back = [0f32; 1];
            unpack_row(Codec::F16 { scale: 1.0 }, &[h], &mut back);
            assert_eq!(back[0].to_bits(), v.to_bits(), "{h:#06x}");
        }
        assert_eq!(f16_value(0x3c00), 1.0);
        assert_eq!(f16_value(0x0001), 2f32.powi(-24));
        assert_eq!(f16_value(0x7bff), 65504.0);
    }

    #[test]
    fn f16_rounds_to_nearest_even() {
        let mut x = 0x2468_ace1u32;
        let mut vals = vec![0.0f32, -0.0, 65504.0, -65504.0, 65519.0, 2f32.powi(-25), 3.0 * 2f32.powi(-25), 1e-30];
        for _ in 0..20_000 {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            // magnitudes from 1e-9 to 6e4
            let v = f32::from_bits(0x3000_0000 + x % 0x1780_0000);
            vals.push(if x & 1 == 0 { v } else { -v });
        }
        for v in vals {
            let v = v.clamp(-F16_MAX, F16_MAX);
            let got = f64::from(f16_value(f16_bits(v)));
            assert_eq!(got.to_bits(), reference_value(v).to_bits(), "{v:e}");
        }
    }

    #[test]
    fn f16c_and_software_agree() {
        // whatever this machine runs (AVX2 + F16C or not) against the software path
        let mut x = 0x1357_9bdfu32;
        let src: Vec<f32> = (0..4099)
            .map(|i| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                let v = f32::from_bits(0x2800_0000 + x % 0x2000_0000);
                if i % 3 == 0 { -v } else { v }
            })
            .chain([f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 1e9, -1e9])
            .collect();
        for scale in [1.0, 0.25, 1.0 / 16.0] {
            let (mut a, mut b) = (vec![0u16; src.len()], vec![0u16; src.len()]);
            pack_row(Codec::F16 { scale }, &src, &mut a);
            pack_f16_software(&src, &mut b, scale);
            assert_eq!(a, b);
            let (mut fa, mut fb) = (vec![0f32; src.len()], vec![0f32; src.len()]);
            unpack_row(Codec::F16 { scale }, &a, &mut fa);
            unpack_f16::<super::super::lanes::Baseline>(&a, &mut fb, 1.0 / scale);
            assert!(fa.iter().zip(&fb).all(|(p, q)| p.to_bits() == q.to_bits()));
            // NaN as 0, infinities and beyond clamped
            let n = src.len();
            assert_eq!(&fa[n - 5..], &[0.0, F16_MAX / scale, -F16_MAX / scale, F16_MAX / scale, -F16_MAX / scale]);
        }
    }

    #[test]
    fn fixed_point_formats() {
        let check = |codec: Codec, v: f32, want: f32, tol: f32| {
            let q = pack(codec, v);
            let back = unpack(codec, q);
            assert!((back - want).abs() <= tol, "{codec:?}: {v} -> {q} -> {back}, want {want}");
            let (mut qa, mut fa) = ([0u16; 9], [0f32; 9]);
            pack_row(codec, &[v; 9], &mut qa);
            unpack_row(codec, &qa, &mut fa);
            assert!(qa.iter().all(|x| *x == q) && fa.iter().all(|x| x.to_bits() == back.to_bits()));
        };
        let unorm_step = 1.0 / 65535.0;
        for v in [0.0, 1.0, 0.5, 0.123_456, 0.999_99] {
            check(Codec::Unorm, v, v, unorm_step / 2.0 + 1e-7);
        }
        check(Codec::Unorm, -0.3, 0.0, 0.0);
        check(Codec::Unorm, 7.0, 1.0, 0.0);
        check(Codec::Unorm, f32::NAN, 0.0, 0.0);
        for v in [-1.0, 1.0, 0.0, -0.654_3, 0.333_33] {
            check(Codec::Snorm { range: 1.0 }, v, v, 0.5 / 32767.0 + 1e-7);
            check(Codec::Snorm { range: 2.0 }, 1.6 * v, 1.6 * v, 1.0 / 32767.0 + 1e-6);
        }
        check(Codec::Snorm { range: 1.0 }, -3.0, -1.0, 0.0);
        // fractions: 0.32 mm of 18.75 m, a little room below 0 and above 1
        for v in [0.0, 1.0, 0.5, -0.05, 1.05, 0.000_01, 0.999_9] {
            check(Codec::Fraction, v, v, 0.5 * FRACTION_SPAN / 65535.0 + 1e-7);
        }
        check(Codec::Fraction, -0.5, -FRACTION_OFFSET, 1e-7);
        for v in [0.0, 0.5, 1234.25, 18_750.0, 32_767.5] {
            check(Codec::HalfMm, v, v, 0.25);
        }
        check(Codec::HalfMm, 1234.5, 1234.5, 0.0);
        check(Codec::HalfMm, -20.0, 0.0, 0.0);
        check(Codec::HalfMm, 1e9, 32_767.5, 0.0);
        // ties go to the even step, as on the GPU (WGSL `round`)
        assert_eq!(pack(Codec::HalfMm, 0.25), 0);
        assert_eq!(pack(Codec::HalfMm, 0.75), 2);
        assert_eq!(unpack(Codec::HalfMm, pack(Codec::HalfMm, 1234.75)), 1235.0);
    }
}
