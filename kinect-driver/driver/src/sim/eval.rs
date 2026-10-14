//! Measures a decoder against the simulator's ground truth: per distance band how many pixels
//! get depth, how many of those are right, how many are wrong (bad unwrapping, flying pixels),
//! and how well the infrared matches where the sensor saturated.

use std::fmt::Write as _;

use super::GroundTruth;
use crate::consts::{PIXELS, WIDTH};
use crate::tof::TofOutput;

/// Upper edges of the distance bands, mm.
pub const BANDS_MM: [f32; 12] = [500.0, 1000.0, 2000.0, 3000.0, 4500.0, 6000.0, 8000.0, 10000.0, 12500.0, 15000.0, 17000.0, 18750.0];

/// Counters of one band.
#[derive(Clone, Copy, Debug, Default)]
pub struct Band {
    /// pixels with ground truth in this band (not at an edge)
    pub truth: u64,
    /// ... that got a depth
    pub valid: u64,
    /// ... within max(15 mm, 1 %) of the truth
    pub inliers: u64,
    /// ... more than max(100 mm, 5 %) off (wrong distance)
    pub outliers: u64,
    /// sum of absolute errors of the inliers, mm
    pub abs_err_sum: f64,
}

/// The whole evaluation.
#[derive(Clone, Debug, Default)]
pub struct Evaluation {
    /// per band
    pub bands: [Band; 12],
    /// pixels where the sensor saturated (any frequency)
    pub saturated: Band,
    /// depth reported where the truth has none (nothing there or beyond the range)
    pub phantom: u64,
    /// infrared: pixels where the sensor saturated
    pub ir_saturated: u64,
    /// ... whose infrared is clipped (>= 65535) or 0
    pub ir_clipped: u64,
    /// ... sum of relative errors against the true brightness
    pub ir_rel_err_sum: f64,
    /// infrared: unsaturated pixels, sum of relative errors (should be small for both modes)
    pub ir_plain_err_sum: f64,
    /// unsaturated pixels with brightness
    pub ir_plain: u64,
    /// frames
    pub frames: u64,
}

impl Evaluation {
    /// Adds one decoded frame.
    pub fn add(&mut self, gt: &GroundTruth, out: &TofOutput) {
        self.frames += 1;
        for i in 0..PIXELS {
            let (Some(&truth), Some(&d), Some(&mixed), Some(&sat)) = (gt.depth.get(i), out.depth.get(i), gt.mixed.get(i), gt.saturated.get(i)) else {
                continue;
            };
            if mixed || i % WIDTH == 0 || i % WIDTH == WIDTH - 1 {
                continue;
            }
            if truth <= 0.0 {
                self.phantom += u64::from(d > 0.0);
                continue;
            }
            let Some(b) = BANDS_MM.iter().position(|e| truth <= *e) else { continue };
            let err = (d - truth).abs();
            let inlier = d > 0.0 && err <= (0.01 * truth).max(15.0);
            let outlier = d > 0.0 && err > (0.05 * truth).max(100.0);
            for band in [self.bands.get_mut(b), if sat != 0 { Some(&mut self.saturated) } else { None }].into_iter().flatten() {
                band.truth += 1;
                band.valid += u64::from(d > 0.0);
                band.inliers += u64::from(inlier);
                band.outliers += u64::from(outlier);
                if inlier {
                    band.abs_err_sum += f64::from(err);
                }
            }
            let (Some(&ir_true), Some(&ir)) = (gt.ir.get(i), out.ir.get(i)) else { continue };
            if ir_true <= 0.0 {
                continue;
            }
            if sat != 0 {
                self.ir_saturated += 1;
                self.ir_clipped += u64::from(ir >= 65535.0 || ir <= 0.0);
                self.ir_rel_err_sum += f64::from(((ir - ir_true) / ir_true).abs().min(10.0));
            } else if ir_true > 20.0 {
                self.ir_plain += 1;
                self.ir_plain_err_sum += f64::from(((ir - ir_true) / ir_true).abs().min(10.0));
            }
        }
    }

    /// A table: per band valid / inlier / outlier percentages and the mean error.
    pub fn table(&self, name: &str) -> String {
        let mut s = String::new();
        let _ = writeln!(s, "{name}");
        let _ = writeln!(s, "  band (m)        truth px   depth%  right%  wrong%  err mm");
        let mut lo = 0.0;
        let pct = |a: u64, b: u64| if b == 0 { 0.0 } else { 100.0 * a as f64 / b as f64 };
        let mut line = |label: String, b: &Band| {
            if b.truth == 0 {
                return;
            }
            let _ = writeln!(
                s,
                "  {label:<15} {:>9} {:>8.1} {:>7.1} {:>7.2} {:>7.1}",
                b.truth,
                pct(b.valid, b.truth),
                pct(b.inliers, b.truth),
                pct(b.outliers, b.truth),
                if b.inliers > 0 { b.abs_err_sum / b.inliers as f64 } else { 0.0 }
            );
        };
        for (b, hi) in self.bands.iter().zip(BANDS_MM) {
            line(format!("{:.1}-{:.1}", lo / 1000.0, hi / 1000.0), b);
            lo = hi;
        }
        line("saturated".to_string(), &self.saturated);
        let _ = writeln!(s, "  depth where nothing is: {} px over {} frames", self.phantom, self.frames);
        if self.ir_saturated > 0 {
            let _ = writeln!(
                s,
                "  IR where saturated: {:.1} % clipped/empty, mean error {:.1} %",
                pct(self.ir_clipped, self.ir_saturated),
                100.0 * self.ir_rel_err_sum / self.ir_saturated as f64
            );
        }
        if self.ir_plain > 0 {
            let _ = writeln!(s, "  IR elsewhere: mean error {:.2} %", 100.0 * self.ir_plain_err_sum / self.ir_plain as f64);
        }
        s
    }
}
