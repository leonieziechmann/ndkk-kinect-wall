//! Built-in pipeline stages.

use crate::consts::{HEIGHT, PIXELS, WIDTH};
use crate::error::Result;
use crate::frame::Frame;
use crate::pipeline::Stage;
use crate::tof::fill::push_pull;

/// How infrared values are mapped into the output range.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ToneCurve {
    /// clipped at `white` (libfreenect2: 65535)
    Clip {
        /// largest output
        white: f32,
    },
    /// unchanged below `knee`, compressed above it (Reinhard: `knee + room * t / (1 + t)`),
    /// approaching `white` but never reaching it: highlights keep their detail over a range of a
    /// hundred times the knee instead of clipping
    Rolloff {
        /// below this nothing changes
        knee: f32,
        /// the output approaches this
        white: f32,
    },
    /// logarithmic: 0..`max_in` onto 0..`white`
    Log {
        /// input that maps to `white`
        max_in: f32,
        /// largest output
        white: f32,
    },
}

impl ToneCurve {
    /// Maps one value.
    #[inline]
    pub fn apply(&self, v: f32) -> f32 {
        let v = if v.is_finite() { v.max(0.0) } else { 0.0 };
        match *self {
            ToneCurve::Clip { white } => v.min(white),
            ToneCurve::Rolloff { knee, white } => {
                let room = (white - knee).max(1e-3);
                let t = (v - knee) / room;
                if v <= knee { v } else { knee + room * t / (1.0 + t) }
            }
            ToneCurve::Log { max_in, white } => {
                let m = max_in.max(1.0);
                (white * (1.0 + v).ln() / (1.0 + m).ln()).min(white)
            }
        }
    }
}

/// Infrared tone mapping: makes the (HDR) infrared fit an output range without hard clipping,
/// optionally evening out the exposure: `distance_reference_mm` multiplies every pixel by
/// (depth / reference)^2, which cancels the falloff of the Kinect's own light with distance (a
/// person at 4 m then looks like one at 2 m); `local` divides by the local average brightness.
#[derive(Clone, Debug, PartialEq)]
pub struct IrToneMap {
    /// the curve applied last
    pub curve: ToneCurve,
    /// cancel the 1/d^2 falloff relative to this distance (where there is no depth, the depth
    /// around is used)
    pub distance_reference_mm: Option<f32>,
    /// local adaptation: (radius in pixels, strength 0..1)
    pub local: Option<(usize, f32)>,
}

impl IrToneMap {
    /// libfreenect2's behavior: clip at 65535.
    pub fn clip() -> IrToneMap {
        IrToneMap { curve: ToneCurve::Clip { white: 65535.0 }, distance_reference_mm: None, local: None }
    }

    /// For kinect-hub's infrared stream (white at 6000): unchanged up to 3000, highlights rolled
    /// off instead of clipped.
    pub fn hub() -> IrToneMap {
        IrToneMap { curve: ToneCurve::Rolloff { knee: 3000.0, white: 6000.0 }, distance_reference_mm: None, local: None }
    }

    /// Even exposure: distance compensated to 2 m, then like [`IrToneMap::hub`].
    pub fn even() -> IrToneMap {
        IrToneMap { distance_reference_mm: Some(2000.0), ..IrToneMap::hub() }
    }
}

impl Stage for IrToneMap {
    fn name(&self) -> &str {
        "ir tone map"
    }

    fn process(&mut self, frame: &mut Frame) -> Result<()> {
        if frame.ir.len() != PIXELS {
            return Ok(());
        }
        if let Some(r) = self.distance_reference_mm.filter(|r| *r > 0.0)
            && frame.depth.len() == PIXELS
        {
            let weights: Vec<f32> = frame.depth.iter().map(|d| if *d > 0.0 { 1.0 } else { 0.0 }).collect();
            if weights.iter().any(|w| *w > 0.0) {
                let filled = push_pull(&frame.depth, &weights, WIDTH, HEIGHT);
                let inv = 1.0 / (r * r);
                for (v, d) in frame.ir.iter_mut().zip(filled) {
                    // never darken what is nearer than the reference by more than 4x
                    *v *= (d * d * inv).max(0.25);
                }
            }
        }
        if let Some((radius, strength)) = self.local.filter(|(r, s)| *r > 0 && *s > 0.0) {
            local_adapt(&mut frame.ir, radius, strength.min(1.0));
        }
        let c = self.curve;
        for v in &mut frame.ir {
            *v = c.apply(*v);
        }
        Ok(())
    }
}

/// Divides by the local (box) average in the log domain, keeping the global average.
fn local_adapt(ir: &mut [f32], radius: usize, strength: f32) {
    let logs: Vec<f32> = ir.iter().map(|v| (1.0 + v.max(0.0)).ln()).collect();
    let mean = box_blur(&logs, WIDTH, HEIGHT, radius);
    let global = logs.iter().sum::<f32>() / logs.len().max(1) as f32;
    for ((v, l), m) in ir.iter_mut().zip(&logs).zip(&mean) {
        *v = (l - strength * (m - global)).exp() - 1.0;
    }
}

/// Separable box blur with running sums (edges clamp).
pub fn box_blur(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut tmp = vec![0f32; w * h];
    let mut out = vec![0f32; w * h];
    if src.len() < w * h || w == 0 || h == 0 {
        return src.to_vec();
    }
    let n = (2 * r + 1) as f32;
    for (srow, trow) in src.chunks_exact(w).zip(tmp.chunks_exact_mut(w)) {
        let at = |i: isize| srow.get(i.clamp(0, w as isize - 1) as usize).copied().unwrap_or(0.0);
        let mut acc: f32 = (-(r as isize)..=r as isize).map(at).sum();
        for (x, t) in trow.iter_mut().enumerate() {
            *t = acc / n;
            acc += at(x as isize + r as isize + 1) - at(x as isize - r as isize);
        }
    }
    for x in 0..w {
        let at = |y: isize| tmp.get(y.clamp(0, h as isize - 1) as usize * w + x).copied().unwrap_or(0.0);
        let mut acc: f32 = (-(r as isize)..=r as isize).map(at).sum();
        for y in 0..h {
            if let Some(o) = out.get_mut(y * w + x) {
                *o = acc / n;
            }
            acc += at(y as isize + r as isize + 1) - at(y as isize - r as isize);
        }
    }
    out
}

/// Temporal smoothing of the depth (and optionally the infrared): the newest frame gets weight
/// `alpha`; a pixel that changed by more than `reset_mm` (or 3 %) takes the new value at once,
/// so movement does not smear.
#[derive(Clone, Debug)]
pub struct TemporalFilter {
    /// weight of the newest frame (1 = off)
    pub alpha: f32,
    /// a jump larger than this (or 3 % of the depth) is movement, not noise
    pub reset_mm: f32,
    /// smooth the infrared too
    pub infrared: bool,
    depth: Vec<f32>,
    ir: Vec<f32>,
}

impl Default for TemporalFilter {
    fn default() -> Self {
        TemporalFilter { alpha: 0.4, reset_mm: 60.0, infrared: false, depth: Vec::new(), ir: Vec::new() }
    }
}

impl Stage for TemporalFilter {
    fn name(&self) -> &str {
        "temporal filter"
    }
    fn reset(&mut self) {
        self.depth.clear();
        self.ir.clear();
    }
    fn process(&mut self, frame: &mut Frame) -> Result<()> {
        let a = self.alpha.clamp(0.01, 1.0);
        if frame.depth.len() == PIXELS {
            if self.depth.len() != PIXELS {
                self.depth = frame.depth.clone();
            } else {
                for (new, old) in frame.depth.iter_mut().zip(self.depth.iter_mut()) {
                    let thr = self.reset_mm.max(0.03 * *new);
                    *old = if *new > 0.0 && *old > 0.0 && (*new - *old).abs() < thr { *old + a * (*new - *old) } else { *new };
                    *new = *old;
                }
            }
        }
        if self.infrared && frame.ir.len() == PIXELS {
            if self.ir.len() != PIXELS {
                self.ir = frame.ir.clone();
            } else {
                for (new, old) in frame.ir.iter_mut().zip(self.ir.iter_mut()) {
                    *old += a * (*new - *old);
                    *new = *old;
                }
            }
        }
        Ok(())
    }
}

/// Drops depth outside a range.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DepthRange {
    /// nearest, mm
    pub min_mm: f32,
    /// farthest, mm
    pub max_mm: f32,
}

impl Stage for DepthRange {
    fn name(&self) -> &str {
        "depth range"
    }
    fn process(&mut self, frame: &mut Frame) -> Result<()> {
        for d in &mut frame.depth {
            if *d < self.min_mm || *d > self.max_mm {
                *d = 0.0;
            }
        }
        Ok(())
    }
}

/// Computes the 3D point of every pixel (mm; x right, y down, z forward; [0, 0, 0] without
/// depth) into `frame.points`.
#[derive(Clone, Copy, Debug, Default)]
pub struct Points;

impl Stage for Points {
    fn name(&self) -> &str {
        "points"
    }
    fn process(&mut self, frame: &mut Frame) -> Result<()> {
        let rays = &frame.tables.rays;
        frame.points = frame.depth.iter().zip(rays.iter()).map(|(z, r)| if *z > 0.0 { [r[0] * z, r[1] * z, *z] } else { [0.0; 3] }).collect();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curves() {
        let r = ToneCurve::Rolloff { knee: 3000.0, white: 6000.0 };
        assert_eq!(r.apply(1000.0), 1000.0);
        assert!(r.apply(5000.0) > 3000.0 && r.apply(5000.0) < 6000.0);
        assert!(r.apply(1e9) <= 6000.0 && r.apply(1e9) > 5999.0);
        // detail far above the knee: 30000 and 60000 still differ clearly
        assert!(r.apply(60000.0) - r.apply(30000.0) > 100.0);
        // smooth at the knee (slope 1 on both sides)
        assert!((r.apply(3001.0) - 3001.0).abs() < 0.01);
        assert!(r.apply(f32::NAN) == 0.0);
        let l = ToneCurve::Log { max_in: 1000.0, white: 255.0 };
        assert!((l.apply(1000.0) - 255.0).abs() < 1e-3);
        assert_eq!(ToneCurve::Clip { white: 10.0 }.apply(20.0), 10.0);
    }

    #[test]
    fn box_blur_keeps_constants() {
        let v = vec![3.0f32; 40 * 30];
        let b = box_blur(&v, 40, 30, 4);
        assert!(b.iter().all(|x| (x - 3.0).abs() < 1e-4));
    }
}
