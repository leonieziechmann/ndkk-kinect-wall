//! Runtime selection of the vector instruction set. The pixel kernels are plain Rust written so
//! the compiler vectorizes them; [`multiversion!`] compiles each kernel twice on x86-64 (baseline
//! SSE2 and AVX2 + FMA) and picks the AVX2 build when the CPU has it. On aarch64 (Apple silicon,
//! Raspberry Pi) NEON is always there and the baseline build uses it.

use std::sync::OnceLock;

/// Vector instruction sets the CPU decoder can use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SimdLevel {
    /// no wide vectors in use (forced by configuration)
    Scalar,
    /// x86-64 baseline (SSE2) or aarch64 NEON
    Baseline,
    /// x86-64 with AVX2 and FMA
    Avx2,
}

impl SimdLevel {
    /// For logs and status.
    pub fn name(self) -> &'static str {
        match self {
            SimdLevel::Scalar => "scalar",
            SimdLevel::Baseline => {
                if cfg!(target_arch = "aarch64") {
                    "neon"
                } else {
                    "sse2"
                }
            }
            SimdLevel::Avx2 => "avx2+fma",
        }
    }
}

static DETECTED: OnceLock<SimdLevel> = OnceLock::new();

/// The best level this CPU supports (detected once). `KINECT_DRIVER_SIMD=baseline` forces the
/// baseline build (for comparisons).
pub fn detected() -> SimdLevel {
    *DETECTED.get_or_init(|| {
        if std::env::var("KINECT_DRIVER_SIMD").is_ok_and(|v| v == "baseline" || v == "scalar") {
            return SimdLevel::Baseline;
        }
        #[cfg(target_arch = "x86_64")]
        {
            if std::arch::is_x86_feature_detected!("avx2") && std::arch::is_x86_feature_detected!("fma") {
                return SimdLevel::Avx2;
            }
        }
        SimdLevel::Baseline
    })
}

/// True if the AVX2 build of the kernels may run.
#[inline]
pub fn use_avx2() -> bool {
    detected() == SimdLevel::Avx2
}

/// Defines `fn name(args) -> ret { body }` compiled twice on x86-64: once for the baseline and
/// once with AVX2 + FMA enabled; calls dispatch on the CPU detected at run time. Helpers used
/// in the body must be `#[inline(always)]` so they are compiled into each version.
#[macro_export]
#[doc(hidden)]
macro_rules! multiversion {
    ($(#[$m:meta])* $vis:vis fn $name:ident($($arg:ident : $ty:ty),* $(,)?) $(-> $ret:ty)? $body:block) => {
        $(#[$m])*
        $vis fn $name($($arg: $ty),*) $(-> $ret)? {
            #[cfg(target_arch = "x86_64")]
            {
                #[target_feature(enable = "avx2,fma")]
                #[allow(clippy::too_many_arguments)]
                fn avx2($($arg: $ty),*) $(-> $ret)? $body
                if $crate::tof::simd::use_avx2() {
                    // SAFETY: the CPU supports AVX2 and FMA (checked at run time just above)
                    #[allow(unsafe_code)]
                    return unsafe { avx2($($arg),*) };
                }
            }
            #[allow(clippy::too_many_arguments)]
            #[inline(always)]
            fn baseline($($arg: $ty),*) $(-> $ret)? $body
            baseline($($arg),*)
        }
    };
}
