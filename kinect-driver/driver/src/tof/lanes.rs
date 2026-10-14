//! Eight pixels at a time. [`F8`] holds eight `f32` lanes and [`M8`] eight lane masks; every
//! operation is a loop over the lanes that LLVM turns into one vector instruction (AVX2) or two
//! (SSE2, NEON). So a kernel can keep its state in registers across loops that do not run over
//! pixels (the candidate distances of the unwrapping, the neighbors of a filter): the compiler
//! only vectorizes the innermost loop of plain row code, and keeps everything else in memory.
//!
//! [`Isa`] tells the kernels what the vector unit can do beyond that: `multiversion!` compiles
//! them with [`Fma`] into the AVX2 build and with [`Plain`] into the baseline build (with `Fma`
//! on aarch64, where NEON always has fused multiply-add). Without FMA hardware a fused
//! multiply-add would be a slow library call, so the baseline multiplies and adds.

#![allow(clippy::indexing_slicing)] // lanes 0..LANES of [_; LANES]: in bounds by construction

use std::array::from_fn;
use std::ops::{Add, BitAnd, BitOr, Div, Mul, Neg, Not, Sub};

/// Lanes per vector.
pub const LANES: usize = 8;

/// Eight `f32`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct F8(pub [f32; LANES]);

/// Eight lane masks: all bits set (true) or none.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct M8(pub [u32; LANES]);

/// What the vector unit can do (see the module documentation).
pub trait Isa {
    /// fused multiply-add in hardware
    const FMA: bool;
}

/// AVX2 + FMA, NEON.
pub struct Fma;
/// SSE2.
pub struct Plain;

/// What the baseline build has: FMA on aarch64 (NEON), not on x86-64 (SSE2).
#[cfg(target_arch = "aarch64")]
pub type Baseline = Fma;
/// What the baseline build has: FMA on aarch64 (NEON), not on x86-64 (SSE2).
#[cfg(not(target_arch = "aarch64"))]
pub type Baseline = Plain;

impl Isa for Fma {
    const FMA: bool = true;
}
impl Isa for Plain {
    const FMA: bool = false;
}

/// 1.5 * 2^23: adding it rounds an `f32` below 2^22 to an integer, kept in the low mantissa
/// bits.
const ROUNDER: f32 = 12_582_912.0;

impl F8 {
    /// All lanes `v`.
    #[inline(always)]
    pub fn splat(v: f32) -> F8 {
        F8([v; LANES])
    }

    /// All lanes 0.
    #[inline(always)]
    pub fn zero() -> F8 {
        F8([0.0; LANES])
    }

    /// `row[at..at + LANES]` (zeros past the end, which callers never reach).
    #[inline(always)]
    pub fn load(row: &[f32], at: usize) -> F8 {
        F8(row.get(at..at + LANES).and_then(|s| <[f32; LANES]>::try_from(s).ok()).unwrap_or([0.0; LANES]))
    }

    /// Writes the lanes to `row[at..at + LANES]` (nothing past the end).
    #[inline(always)]
    pub fn store(self, row: &mut [f32], at: usize) {
        if let Some(s) = row.get_mut(at..at + LANES) {
            s.copy_from_slice(&self.0);
        }
    }

    /// `f` applied to every lane.
    #[inline(always)]
    pub fn map_lanes(self, f: impl Fn(f32) -> f32) -> F8 {
        self.map(f)
    }

    #[inline(always)]
    fn map(self, f: impl Fn(f32) -> f32) -> F8 {
        F8(from_fn(|i| f(self.0[i])))
    }

    #[inline(always)]
    fn zip(self, o: F8, f: impl Fn(f32, f32) -> f32) -> F8 {
        F8(from_fn(|i| f(self.0[i], o.0[i])))
    }

    #[inline(always)]
    fn test(self, o: F8, f: impl Fn(f32, f32) -> bool) -> M8 {
        M8(from_fn(|i| if f(self.0[i], o.0[i]) { u32::MAX } else { 0 }))
    }

    /// `self * b + c`, fused where the hardware has it.
    #[inline(always)]
    pub fn mul_add<I: Isa>(self, b: F8, c: F8) -> F8 {
        if I::FMA { F8(from_fn(|i| self.0[i].mul_add(b.0[i], c.0[i]))) } else { self * b + c }
    }

    /// The smaller per lane (the other operand if one is NaN, like `minps`).
    #[inline(always)]
    pub fn min(self, o: F8) -> F8 {
        self.zip(o, |a, b| if a < b { a } else { b })
    }

    /// The larger per lane (the other operand if one is NaN, like `maxps`).
    #[inline(always)]
    pub fn max(self, o: F8) -> F8 {
        self.zip(o, |a, b| if a > b { a } else { b })
    }

    /// Absolute value.
    #[inline(always)]
    pub fn abs(self) -> F8 {
        self.map(f32::abs)
    }

    /// Square root.
    #[inline(always)]
    pub fn sqrt(self) -> F8 {
        self.map(f32::sqrt)
    }

    /// Nearest integer (ties to even) for |x| < 2^22, without SSE4.1's rounding instruction.
    #[inline(always)]
    pub fn round(self) -> F8 {
        (self + F8::splat(ROUNDER)) - F8::splat(ROUNDER)
    }

    /// [`super::math::exp`] in eight lanes: fast_depth.cpp's polynomial, about 1e-4 relative
    /// error. The GPU shader evaluates the same, so the decoders agree to the rounding (a
    /// different approximation of the same accuracy moves enough threshold decisions to tell).
    #[inline(always)]
    pub fn exp_fd<I: Isa>(self) -> F8 {
        (self.max(F8::splat(-87.0)).min(F8::splat(88.0)) * F8::splat(std::f32::consts::LOG2_E)).exp2_fd::<I>()
    }

    /// The 2^x of [`F8::exp_fd`], for x in [-126, 127] (not checked).
    #[inline(always)]
    pub fn exp2_fd<I: Isa>(self) -> F8 {
        let fi = self.map(f32::floor);
        let f = self - fi;
        let p = F8::splat(0.001_333_36).mul_add::<I>(f, F8::splat(0.009_618_13));
        let p = p.mul_add::<I>(f, F8::splat(0.055_504_11));
        let p = p.mul_add::<I>(f, F8::splat(0.240_226_5));
        #[allow(clippy::approx_constant, clippy::excessive_precision)]
        let p = p.mul_add::<I>(f, F8::splat(0.693_147_18));
        let p = p.mul_add::<I>(f, F8::splat(1.0));
        // 2^fi: fi + 127 in the exponent field (see math::exp)
        let scale = F8(from_fn(|i| f32::from_bits((fi.0[i] + 127.0 + 8_388_608.0).to_bits() << 23)));
        p * scale
    }

    /// Per lane `self < o`.
    #[inline(always)]
    pub fn lt(self, o: F8) -> M8 {
        self.test(o, |a, b| a < b)
    }

    /// Per lane `self <= o`.
    #[inline(always)]
    pub fn le(self, o: F8) -> M8 {
        self.test(o, |a, b| a <= b)
    }

    /// Per lane `self > o`.
    #[inline(always)]
    pub fn gt(self, o: F8) -> M8 {
        self.test(o, |a, b| a > b)
    }

    /// Per lane `self >= o`.
    #[inline(always)]
    pub fn ge(self, o: F8) -> M8 {
        self.test(o, |a, b| a >= b)
    }

    /// Per lane `self == o`.
    #[inline(always)]
    pub fn eq(self, o: F8) -> M8 {
        self.test(o, |a, b| a == b)
    }
}

impl M8 {
    /// All lanes `v`.
    #[inline(always)]
    pub fn splat(v: bool) -> M8 {
        M8([if v { u32::MAX } else { 0 }; LANES])
    }

    /// Lanes where `row[at + i] & bit != 0`.
    #[inline(always)]
    pub fn bits_u8(row: &[u8], at: usize, bit: u8) -> M8 {
        let mut m = [0u32; LANES];
        if let Some(s) = row.get(at..at + LANES) {
            for (o, v) in m.iter_mut().zip(s) {
                *o = if v & bit != 0 { u32::MAX } else { 0 };
            }
        }
        M8(m)
    }

    /// Lanes where `row[at + i] & bit != 0`.
    #[inline(always)]
    pub fn bits_u32(row: &[u32], at: usize, bit: u32) -> M8 {
        let mut m = [0u32; LANES];
        if let Some(s) = row.get(at..at + LANES) {
            for (o, v) in m.iter_mut().zip(s) {
                *o = if v & bit != 0 { u32::MAX } else { 0 };
            }
        }
        M8(m)
    }

    /// `a` where the mask is set, else `b`.
    #[inline(always)]
    pub fn select(self, a: F8, b: F8) -> F8 {
        F8(from_fn(|i| f32::from_bits((a.0[i].to_bits() & self.0[i]) | (b.0[i].to_bits() & !self.0[i]))))
    }

    /// `v` where the mask is set, else 0.
    #[inline(always)]
    pub fn and(self, v: F8) -> F8 {
        F8(from_fn(|i| f32::from_bits(v.0[i].to_bits() & self.0[i])))
    }

    /// `a` where the mask is set, else `b` (integer lanes).
    #[inline(always)]
    pub fn select_u32(self, a: [u32; LANES], b: [u32; LANES]) -> [u32; LANES] {
        from_fn(|i| (a[i] & self.0[i]) | (b[i] & !self.0[i]))
    }

    /// `v` where the mask is set, else 0 (integer lanes).
    #[inline(always)]
    pub fn and_u32(self, v: u32) -> [u32; LANES] {
        from_fn(|i| v & self.0[i])
    }
}

macro_rules! lane_op {
    ($tr:ident, $f:ident, $op:tt) => {
        impl $tr for F8 {
            type Output = F8;
            #[inline(always)]
            fn $f(self, o: F8) -> F8 {
                self.zip(o, |a, b| a $op b)
            }
        }
    };
}
lane_op!(Add, add, +);
lane_op!(Sub, sub, -);
lane_op!(Mul, mul, *);
lane_op!(Div, div, /);

impl Neg for F8 {
    type Output = F8;
    #[inline(always)]
    fn neg(self) -> F8 {
        self.map(|a| -a)
    }
}

impl BitAnd for M8 {
    type Output = M8;
    #[inline(always)]
    fn bitand(self, o: M8) -> M8 {
        M8(from_fn(|i| self.0[i] & o.0[i]))
    }
}

impl BitOr for M8 {
    type Output = M8;
    #[inline(always)]
    fn bitor(self, o: M8) -> M8 {
        M8(from_fn(|i| self.0[i] | o.0[i]))
    }
}

impl Not for M8 {
    type Output = M8;
    #[inline(always)]
    fn not(self) -> M8 {
        M8(from_fn(|i| !self.0[i]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lanes_compute_what_they_should() {
        let x = F8([-3.0, -0.5, 0.0, 0.49, 0.5, 1.5, 2.5, 1e6]);
        assert_eq!(x.round().0, [-3.0, -0.0, 0.0, 0.0, 0.0, 2.0, 2.0, 1e6]);
        let m = x.lt(F8::splat(0.5));
        assert_eq!(m.select(F8::splat(1.0), F8::splat(2.0)).0, [1.0, 1.0, 1.0, 1.0, 2.0, 2.0, 2.0, 2.0]);
        assert_eq!((!m & x.gt(F8::splat(1.0))).and(x).0, [0.0, 0.0, 0.0, 0.0, 0.0, 1.5, 2.5, 1e6]);
        let a = F8([1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]);
        assert_eq!(a.mul_add::<Fma>(a, a).0, a.mul_add::<Plain>(a, a).0);
        let nan = F8::splat(f32::NAN);
        assert_eq!(nan.max(F8::splat(1.0)).0, [1.0; LANES]);
        assert_eq!(M8::bits_u8(&[0, 1, 2, 3, 4, 5, 6, 7], 0, 1).0, [0, u32::MAX, 0, u32::MAX, 0, u32::MAX, 0, u32::MAX]);
    }

    #[test]
    fn exp_is_the_scalar_one() {
        for i in -2000..=2000 {
            let base = i as f32 * 0.0613;
            let x = F8(from_fn(|l| base + l as f32 * 0.0077));
            let (plain, fused) = (x.exp_fd::<Plain>(), x.exp_fd::<Fma>());
            for l in 0..LANES {
                let want = super::super::math::exp(x.0[l]);
                assert_eq!(plain.0[l], want, "exp({})", x.0[l]);
                assert!((fused.0[l] / want - 1.0).abs() < 1e-6, "exp({}) with FMA", x.0[l]);
            }
        }
        assert_eq!(F8::splat(f32::NAN).exp_fd::<Plain>().0, F8::splat(-87.0).exp_fd::<Plain>().0);
    }
}
