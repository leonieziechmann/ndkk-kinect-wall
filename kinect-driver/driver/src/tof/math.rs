//! Branch-free approximations that vectorize (no library calls inside the pixel loops). The
//! polynomials are those of fn2/fast_depth.cpp, so both decoders agree to the last digits.

use std::f32::consts::PI;

/// atan2 with ~1e-6 rad error; atan2(0, 0) = 0.
#[inline(always)]
pub fn atan2(y: f32, x: f32) -> f32 {
    let ax = x.abs();
    let ay = y.abs();
    let mx = ax.max(ay);
    let mn = ax.min(ay);
    let a = if mx > 0.0 { mn / mx.max(1e-30) } else { 0.0 };
    let s = a * a;
    let p = -0.011_721_2f32;
    let p = p * s + 0.052_653_32;
    let p = p * s - 0.116_432_87;
    let p = p * s + 0.193_543_46;
    let p = p * s - 0.332_623_47;
    let p = p * s + 0.999_977_26;
    let mut r = a * p;
    r = if ay > ax { 1.570_796_4 - r } else { r };
    r = if x < 0.0 { PI - r } else { r };
    if y < 0.0 { -r } else { r }
}

/// e^x for x in [-87, 88]: fast_depth.cpp's polynomial (the Taylor series of 2^f up to f^5),
/// so up to 1e-4 relative error (fast_depth documents 2e-7; it is plenty for filter weights).
#[inline(always)]
pub fn exp(x: f32) -> f32 {
    // not clamp(): it asserts min <= max, and that check keeps the loops from vectorizing
    #[allow(clippy::manual_clamp)]
    let x = x.max(-87.0).min(88.0);
    let t = x * std::f32::consts::LOG2_E;
    let fi = t.floor();
    let f = t - fi;
    let p = 0.001_333_36f32;
    let p = p * f + 0.009_618_13;
    let p = p * f + 0.055_504_11;
    let p = p * f + 0.240_226_5;
    #[allow(clippy::approx_constant, clippy::excessive_precision)]
    let p = p * f + 0.693_147_18; // fast_depth.cpp's coefficient (ln 2)
    let p = p * f + 1.0;
    // 2^fi without a float-to-int conversion (Rust's saturating `as` does not vectorize):
    // fi + 127 is an integer in 1..=254; adding 2^23 puts it in the low mantissa bits
    let biased = (fi + 127.0 + 8_388_608.0).to_bits();
    p * f32::from_bits(biased << 23)
}

/// ln(x) for x > 0, ~1e-6 absolute error (x <= 0 gives garbage, callers clamp).
#[inline(always)]
pub fn ln(x: f32) -> f32 {
    let u = x.to_bits();
    let e = ((u >> 23) & 255) as i32 - 127;
    let m = f32::from_bits((u & 0x007f_ffff) | 0x3f80_0000);
    let z = (m - 1.0) / (m + 1.0);
    let z2 = z * z;
    let p = 0.111_111_11f32;
    let p = p * z2 + 0.142_857_14;
    let p = p * z2 + 0.2;
    let p = p * z2 + 0.333_333_33;
    let p = p * z2 + 1.0;
    e as f32 * std::f32::consts::LN_2 + 2.0 * z * p
}

/// Nearest integer (ties away from zero do not matter here), vectorizable.
#[inline(always)]
pub fn round(x: f32) -> f32 {
    (x + 0.5).floor()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approximations_are_accurate() {
        let mut worst = 0f32;
        for i in -100..=100 {
            for j in -100..=100 {
                let (y, x) = (i as f32 * 0.37, j as f32 * 0.29);
                let e = (atan2(y, x) - y.atan2(x)).abs();
                worst = worst.max(e);
            }
        }
        assert!(worst < 2e-6, "atan2 error {worst}");
        assert_eq!(atan2(0.0, 0.0), 0.0);
        for i in -80..80 {
            let x = i as f32 * 0.9;
            assert!((exp(x) / x.exp() - 1.0).abs() < 1e-4, "exp({x})");
        }
        for i in 1..1000 {
            let x = i as f32 * 0.731;
            assert!((ln(x) - x.ln()).abs() < 2e-6, "ln({x})");
        }
        assert!(exp(-1000.0) >= 0.0 && exp(-1000.0) < 1e-37);
    }
}
