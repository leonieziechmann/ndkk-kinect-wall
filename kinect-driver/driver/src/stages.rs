//! Built-in pipeline stages.

use crate::consts::{HEIGHT, PIXELS, WIDTH};
use crate::error::Result;
use crate::frame::Frame;
use crate::pipeline::Stage;
use crate::tof::fill::PushPull;

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
/// (distance / reference)^2, which cancels the falloff of the Kinect's own light with distance
/// (a person at 4 m then looks like one at 2.5 m); `local` divides by the local average brightness.
/// Start from [`IrToneMap::hub`], [`IrToneMap::even`] or [`IrToneMap::clip`] and change the
/// fields.
#[derive(Clone, Debug, PartialEq)]
pub struct IrToneMap {
    /// the curve applied last
    pub curve: ToneCurve,
    /// cancel the 1/r^2 falloff relative to this distance (r along the ray; where there is no
    /// depth, the depth around is used)
    pub distance_reference_mm: Option<f32>,
    /// the distance compensation multiplies by at least / at most this much (it would otherwise
    /// blow up the noise of far, dark areas)
    pub distance_limits: (f32, f32),
    /// local adaptation: (radius in pixels, strength 0..1)
    pub local: Option<(usize, f32)>,
    scratch: ToneScratch,
}

/// The buffers of the tone mapping, kept between frames (not part of its settings).
#[derive(Clone, Default)]
struct ToneScratch {
    half: Vec<f32>,
    med: Vec<f32>,
    weights: Vec<f32>,
    window: Vec<f32>,
    smooth: Vec<f32>,
    pp: PushPull,
    logs: Vec<f32>,
    blur_tmp: Vec<f32>,
    blur: Vec<f32>,
}

impl std::fmt::Debug for ToneScratch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("..")
    }
}

impl PartialEq for ToneScratch {
    fn eq(&self, _: &ToneScratch) -> bool {
        true
    }
}

impl IrToneMap {
    /// libfreenect2's behavior: clip at 65535.
    pub fn clip() -> IrToneMap {
        IrToneMap { curve: ToneCurve::Clip { white: 65535.0 }, distance_reference_mm: None, distance_limits: (0.25, 4.0), local: None, scratch: ToneScratch::default() }
    }

    /// For kinect-hub's infrared stream (white at 6000): unchanged up to 3000, highlights rolled
    /// off instead of clipped.
    pub fn hub() -> IrToneMap {
        IrToneMap {
            curve: ToneCurve::Rolloff { knee: 3000.0, white: 6000.0 },
            distance_reference_mm: None,
            distance_limits: (0.25, 4.0),
            local: None,
            scratch: ToneScratch::default(),
        }
    }

    /// Even exposure: the falloff with distance cancelled relative to 2.5 m (what is nearer gets
    /// at most 4x darker, what is farther at most 2.5x brighter, so far noise stays down), then
    /// like [`IrToneMap::hub`].
    pub fn even() -> IrToneMap {
        IrToneMap { distance_reference_mm: Some(2500.0), distance_limits: (0.25, 2.5), ..IrToneMap::hub() }
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
            && frame.depth.iter().any(|d| *d > 0.0)
            && self.scratch.smooth_depth(&frame.depth)
        {
            let smooth = &self.scratch.smooth;
            let inv = 1.0 / (r * r);
            let (lo, hi) = self.distance_limits;
            let (lo, hi) = (lo.max(0.0), hi.max(lo.max(0.0)));
            let rays = &frame.tables.rays;
            let has_rays = rays.len() == PIXELS;
            for (i, v) in frame.ir.iter_mut().enumerate() {
                let z = gain_depth(&frame.depth, smooth, i % WIDTH, i / WIDTH);
                // squared distance along the ray: z^2 (1 + x^2 + y^2) in ray units
                let k = match rays.get(i).filter(|_| has_rays) {
                    Some(ray) => 1.0 + ray[0] * ray[0] + ray[1] * ray[1],
                    None => 1.0,
                };
                *v *= (z * z * k * inv).clamp(lo, hi);
            }
        }
        if let Some((radius, strength)) = self.local.filter(|(r, s)| *r > 0 && *s > 0.0) {
            local_adapt(&mut frame.ir, radius, strength.min(1.0), &mut self.scratch);
        }
        let c = self.curve;
        for v in &mut frame.ir {
            *v = c.apply(*v);
        }
        Ok(())
    }
}

impl ToneScratch {
    /// The smooth depth map behind the distance compensation (`smooth`, half resolution): the
    /// median of the depths around (a stray wrong depth or a hole in dark clothes takes the
    /// depth of what is around it instead of making a blotch), filled where nothing is measured
    /// nearby. False if `depth` is not a whole image.
    fn smooth_depth(&mut self, depth: &[f32]) -> bool {
        let (w, h) = (WIDTH, HEIGHT);
        let (hw, hh) = (w / 2, h / 2);
        if depth.len() < w * h {
            return false;
        }
        // half resolution: the mean of the measured pixels of each 2 x 2 block
        self.half.clear();
        self.half.resize(hw * hh, 0.0);
        for (by, hrow) in self.half.chunks_exact_mut(hw).enumerate() {
            for (bx, v) in hrow.iter_mut().enumerate() {
                let (mut sum, mut n) = (0f32, 0f32);
                for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                    if let Some(&d) = depth.get((2 * by + dy) * w + 2 * bx + dx)
                        && d > 0.0
                    {
                        sum += d;
                        n += 1.0;
                    }
                }
                *v = if n > 0.0 { sum / n } else { 0.0 };
            }
        }
        // the median of the measured values in a 5 x 5 window (10 x 10 pixels)
        self.med.clear();
        self.med.resize(hw * hh, 0.0);
        for y in 0..hh {
            for x in 0..hw {
                self.window.clear();
                for yy in y.saturating_sub(2)..=(y + 2).min(hh - 1) {
                    let Some(row) = self.half.get(yy * hw..(yy + 1) * hw) else { continue };
                    let Some(part) = row.get(x.saturating_sub(2)..=(x + 2).min(hw - 1)) else { continue };
                    self.window.extend(part.iter().copied().filter(|v| *v > 0.0));
                }
                if self.window.len() >= 4 {
                    let k = self.window.len() / 2;
                    let (_, m, _) = self.window.select_nth_unstable_by(k, f32::total_cmp);
                    if let Some(o) = self.med.get_mut(y * hw + x) {
                        *o = *m;
                    }
                }
            }
        }
        self.weights.clear();
        self.weights.extend(self.med.iter().map(|v| if *v > 0.0 { 1.0 } else { 0.0 }));
        self.smooth.clear();
        if self.weights.iter().any(|v| *v > 0.0) {
            self.smooth.extend_from_slice(self.pp.fill(&self.med, &self.weights, hw, hh));
        } else {
            self.smooth.extend_from_slice(&self.med);
        }
        true
    }
}

/// The distance pixel (x, y) uses for its compensation: the smooth map (bilinear), but its own
/// depth where it agrees with that (so object edges stay sharp).
#[allow(clippy::indexing_slicing)] // c is a fixed array of four
fn gain_depth(depth: &[f32], smooth: &[f32], x: usize, y: usize) -> f32 {
    let (hw, hh) = (WIDTH / 2, HEIGHT / 2);
    let at = |x: usize, y: usize| smooth.get(y.min(hh - 1) * hw + x.min(hw - 1)).copied().unwrap_or(0.0);
    let fy = ((y as f32 + 0.5) * 0.5 - 0.5).max(0.0);
    let (y0, ty) = (fy as usize, fy.fract());
    let fx = ((x as f32 + 0.5) * 0.5 - 0.5).max(0.0);
    let (x0, tx) = (fx as usize, fx.fract());
    let c = [at(x0, y0), at(x0 + 1, y0), at(x0, y0 + 1), at(x0 + 1, y0 + 1)];
    let top = c[0] + (c[1] - c[0]) * tx;
    let bottom = c[2] + (c[3] - c[2]) * tx;
    let s = top + (bottom - top) * ty;
    let d = depth.get(y * WIDTH + x).copied().unwrap_or(0.0);
    // its own depth if it fits one of the surfaces around (at an edge, either side)
    let fits = c.iter().any(|v| (d - v).abs() <= 0.2 * v);
    if d > 0.0 && fits { d } else { s }
}

/// Divides by the local (box) average in the log domain, keeping the global average.
fn local_adapt(ir: &mut [f32], radius: usize, strength: f32, s: &mut ToneScratch) {
    s.logs.clear();
    s.logs.extend(ir.iter().map(|v| (1.0 + v.max(0.0)).ln()));
    box_blur_into(&s.logs, WIDTH, HEIGHT, radius, &mut s.blur_tmp, &mut s.blur);
    let global = s.logs.iter().sum::<f32>() / s.logs.len().max(1) as f32;
    for ((v, l), m) in ir.iter_mut().zip(&s.logs).zip(&s.blur) {
        *v = (l - strength * (m - global)).exp() - 1.0;
    }
}

/// Separable box blur with running sums (edges clamp).
pub fn box_blur(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let (mut tmp, mut out) = (Vec::new(), Vec::new());
    box_blur_into(src, w, h, r, &mut tmp, &mut out);
    out
}

/// [`box_blur`] into `out`, with `tmp` as the intermediate buffer (both reused).
pub fn box_blur_into(src: &[f32], w: usize, h: usize, r: usize, tmp: &mut Vec<f32>, out: &mut Vec<f32>) {
    out.clear();
    if src.len() < w * h || w == 0 || h == 0 {
        out.extend_from_slice(src);
        return;
    }
    tmp.clear();
    tmp.resize(w * h, 0.0);
    out.resize(w * h, 0.0);
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
                self.depth.clone_from(&frame.depth);
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
                self.ir.clone_from(&frame.ir);
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
        // into the frame's (reused) plane
        let rays = &frame.tables.rays;
        frame.points.clear();
        frame.points.extend(frame.depth.iter().zip(rays.iter()).map(|(z, r)| if *z > 0.0 { [r[0] * z, r[1] * z, *z] } else { [0.0; 3] }));
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
    fn holes_and_strays_take_what_is_around() {
        // a person at 2.5 m with holes and a few wrong depths, in front of a wall at 9 m
        let mut d = vec![9000.0f32; PIXELS];
        for y in 100..300 {
            for x in 200..300 {
                d[y * WIDTH + x] = 2500.0;
            }
        }
        for y in 180..190 {
            for x in 240..248 {
                d[y * WIDTH + x] = 0.0;
            }
        }
        d[150 * WIDTH + 250] = 15000.0;
        d[40 * WIDTH + 40] = 500.0;
        let mut s = ToneScratch::default();
        assert!(s.smooth_depth(&d));
        let g: Vec<f32> = (0..PIXELS).map(|i| gain_depth(&d, &s.smooth, i % WIDTH, i / WIDTH)).collect();
        assert!((g[185 * WIDTH + 244] - 2500.0).abs() < 1.0, "{}", g[185 * WIDTH + 244]);
        assert!((g[150 * WIDTH + 250] - 2500.0).abs() < 1.0, "{}", g[150 * WIDTH + 250]);
        assert!((g[40 * WIDTH + 40] - 9000.0).abs() < 1.0, "{}", g[40 * WIDTH + 40]);
        // edges stay where they are
        assert_eq!(g[200 * WIDTH + 199], 9000.0);
        assert_eq!(g[200 * WIDTH + 200], 2500.0);
    }

    #[test]
    fn box_blur_keeps_constants() {
        let v = vec![3.0f32; 40 * 30];
        let b = box_blur(&v, 40, 30, 4);
        assert!(b.iter().all(|x| (x - 3.0).abs() < 1e-4));
    }
}
