//! Built-in pipeline stages.

use crate::consts::{HEIGHT, PIXELS, WIDTH};
use crate::error::Result;
use crate::frame::Frame;
use crate::pipeline::Stage;
use crate::plane::{Depth, Plane};
use crate::tof::fill::PushPull;
use crate::tof::lanes::{Baseline, Isa};
use crate::tof::pack::{formats, pack, unpack};

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
    /// unchanged below `knee`, logarithmic above it (`knee + s ln(1 + (v - knee) / s)`, slope 1
    /// at the knee, so there is no visible step), reaching `white` at `top`: every doubling of
    /// the brightness above the knee gets about the same step, so the highlights keep their
    /// detail up to `top` instead of clipping (with `top` > `white` > `knee`; otherwise like
    /// `Clip`)
    LogShoulder {
        /// below this nothing changes
        knee: f32,
        /// the input that becomes `white`
        top: f32,
        /// largest output
        white: f32,
    },
}

impl ToneCurve {
    /// Maps one value (for many, [`IrToneMap`] prepares the curve once).
    pub fn apply(&self, v: f32) -> f32 {
        self.prepare().apply(v)
    }

    /// The curve with what does not depend on the value worked out.
    fn prepare(&self) -> Prepared {
        match *self {
            ToneCurve::Clip { white } => Prepared::Clip { white },
            ToneCurve::Rolloff { knee, white } => {
                let room = (white - knee).max(1e-3);
                Prepared::Rolloff { knee, room, inv_room: 1.0 / room }
            }
            ToneCurve::Log { max_in, white } => Prepared::Log { scale: white / (1.0 + max_in.max(1.0)).ln(), white },
            ToneCurve::LogShoulder { knee, top, white } => {
                if knee >= 0.0 && white > knee && top > white && top.is_finite() {
                    let s = shoulder_scale(top - knee, white - knee);
                    Prepared::LogShoulder { knee, s, inv_s: 1.0 / s, white }
                } else {
                    Prepared::Clip { white }
                }
            }
        }
    }
}

/// A [`ToneCurve`] ready to map many values: without branches and with the polynomial `ln`, so
/// the loop over an image vectorizes.
#[derive(Clone, Copy)]
enum Prepared {
    Clip { white: f32 },
    Rolloff { knee: f32, room: f32, inv_room: f32 },
    Log { scale: f32, white: f32 },
    LogShoulder { knee: f32, s: f32, inv_s: f32, white: f32 },
}

impl Prepared {
    fn apply(&self, v: f32) -> f32 {
        let mut one = [v];
        self.apply_all::<Baseline>(&mut one);
        let [v] = one;
        v
    }

    /// Maps every value in place (one loop per curve, each a straight line).
    #[inline(always)]
    fn apply_all<I: Isa>(&self, values: &mut [f32]) {
        use crate::tof::math::{fmax, fmin};
        let ln = ln_fast::<I>;
        // NaN and infinity become 0, negative values 0
        let clean = |v: f32| if v.abs() < f32::INFINITY { fmax(v, 0.0) } else { 0.0 };
        match *self {
            Prepared::Clip { white } => values.iter_mut().for_each(|v| *v = fmin(clean(*v), white)),
            Prepared::Rolloff { knee, room, inv_room } => values.iter_mut().for_each(|v| {
                let x = clean(*v);
                let t = fmax(x - knee, 0.0) * inv_room;
                *v = if x <= knee { x } else { knee + room * t / (1.0 + t) };
            }),
            Prepared::Log { scale, white } => values.iter_mut().for_each(|v| *v = fmin(ln(1.0 + clean(*v)) * scale, white)),
            Prepared::LogShoulder { knee, s, inv_s, white } => values.iter_mut().for_each(|v| {
                let x = clean(*v);
                let shoulder = knee + s * ln(1.0 + fmax(x - knee, 0.0) * inv_s);
                *v = if x <= knee { x } else { fmin(shoulder, white) };
            }),
        }
    }
}

crate::multiversion! {
    /// [`Prepared::apply_all`], with AVX2 where the CPU has it.
    fn tone_all(c: Prepared, values: &mut [f32]) {
        c.apply_all::<Isa>(values);
    }
}

/// ln(x) for normal x > 0, within 8e-5: the exponent plus a polynomial in the mantissa
/// (minimax for log2(1 + t) on 0..1, exact at both ends, so it is continuous), without a
/// division, which keeps the vectorized loops cheap. Plenty for 8-bit pictures.
#[inline(always)]
fn ln_fast<I: Isa>(x: f32) -> f32 {
    let fma = |a: f32, b: f32, c: f32| if I::FMA { a.mul_add(b, c) } else { a * b + c };
    let u = x.to_bits();
    let e = ((u >> 23) & 255) as i32 - 127;
    let t = f32::from_bits((u & 0x007f_ffff) | 0x3f80_0000) - 1.0;
    let p = fma(t, fma(t, fma(t, -0.082_130_59, 0.321_188_7), -0.677_783_8), 1.438_725_7);
    fma(t, p, e as f32) * std::f32::consts::LN_2
}

/// The scale `s` of a logarithmic shoulder that rises by `rise` over an input range of `range`
/// (`s ln(1 + range / s) = rise`, 0 < `rise` < `range`): bisection on a log scale (64 steps
/// take the bracket below f64 precision), `s ln(1 + range / s)` grows with `s` from 0 towards
/// `range`.
fn shoulder_scale(range: f32, rise: f32) -> f32 {
    let (range, rise) = (f64::from(range), f64::from(rise));
    let (mut lo, mut hi) = (rise * 1e-9, range * 1e9);
    for _ in 0..64 {
        let mid = (lo * hi).sqrt();
        if mid * (range / mid).ln_1p() > rise {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    (lo * hi).sqrt() as f32
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

/// The buffers of the tone mapping, kept between frames (not part of its settings). The depth
/// maps at half resolution keep the depth's 16-bit steps; the infrared is worked on row by row
/// (as a whole image only for the local adaptation).
#[derive(Clone, Default)]
struct ToneScratch {
    half: Vec<u16>,
    med: Vec<u16>,
    window: Vec<u16>,
    smooth: Vec<u16>,
    pp: PushPull,
    /// one row of infrared and of depth
    row: Vec<f32>,
    depth_row: Vec<f32>,
    /// the local adaptation's whole image and its maps
    full: Vec<f32>,
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

    /// For kinect-hub's infrared stream (white at 6000, shown as sqrt): unchanged up to 3000,
    /// above it logarithmic up to 65535 (where libfreenect2 clips), so what is white today keeps
    /// its detail at a mid-light gray (6000 is byte 212 instead of 255, 12000 is 227, 30000 is 243).
    pub fn hub() -> IrToneMap {
        IrToneMap {
            curve: ToneCurve::LogShoulder { knee: 3000.0, top: 65535.0, white: HUB_WHITE },
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

    /// The highlights shaped otherwise, for kinect-hub's range: unchanged up to `knee`, white
    /// (6000) at `top`, logarithmic between them.
    pub fn shoulder(self, knee: f32, top: f32) -> IrToneMap {
        IrToneMap { curve: ToneCurve::LogShoulder { knee, top, white: HUB_WHITE }, ..self }
    }
}

/// kinect-hub shows the infrared as sqrt(v / 6000), white from 6000 on.
pub const HUB_WHITE: f32 = 6000.0;

impl Stage for IrToneMap {
    fn name(&self) -> &str {
        "ir tone map"
    }

    fn process(&mut self, frame: &mut Frame) -> Result<()> {
        if frame.ir.len() != PIXELS {
            return Ok(());
        }
        let curve = self.curve.prepare();
        let distance = self.distance_reference_mm.filter(|r| *r > 0.0).and_then(|r| {
            let usable = frame.depth.len() == PIXELS && frame.depth.raw().iter().any(|q| *q != 0) && self.scratch.smooth_depth(&frame.depth);
            let (lo, hi) = self.distance_limits;
            usable.then(|| Distance { inv: 1.0 / (r * r), lo: lo.max(0.0), hi: hi.max(lo.max(0.0)) })
        });
        let s = &mut self.scratch;
        let rays = &frame.tables.rays;
        if let Some((radius, strength)) = self.local.filter(|(r, s)| *r > 0 && *s > 0.0) {
            // the local averages need the whole image
            frame.ir.unpack_into(&mut s.full);
            if let Some(dist) = &distance {
                s.depth_row.resize(WIDTH, 0.0);
                for (y, row) in s.full.as_chunks_mut::<WIDTH>().0.iter_mut().enumerate() {
                    frame.depth.unpack_row(y, &mut s.depth_row);
                    dist.compensate(row, &s.depth_row, &s.smooth, rays, y);
                }
            }
            local_adapt(&mut s.full, radius, strength.min(1.0), &mut s.logs, &mut s.blur_tmp, &mut s.blur);
            tone_all(curve, &mut s.full);
            frame.ir.pack_slice(0, &s.full);
            return Ok(());
        }
        s.row.resize(WIDTH, 0.0);
        s.depth_row.resize(WIDTH, 0.0);
        for y in 0..HEIGHT {
            frame.ir.unpack_row(y, &mut s.row);
            if let Some(dist) = &distance {
                frame.depth.unpack_row(y, &mut s.depth_row);
                dist.compensate(&mut s.row, &s.depth_row, &s.smooth, rays, y);
            }
            tone_all(curve, &mut s.row);
            frame.ir.pack_row(y, &s.row);
        }
        Ok(())
    }
}

/// The distance compensation of [`IrToneMap`]: 1 / reference^2 and the limits of the gain.
struct Distance {
    inv: f32,
    lo: f32,
    hi: f32,
}

impl Distance {
    /// Multiplies row `y` of the infrared by (distance / reference)^2 within the limits.
    fn compensate(&self, ir: &mut [f32], depth: &[f32], smooth: &[u16], rays: &[[f32; 2]], y: usize) {
        let ray_row = rays.get(y * WIDTH..(y + 1) * WIDTH).filter(|_| rays.len() == PIXELS);
        for (x, (v, d)) in ir.iter_mut().zip(depth).enumerate() {
            let z = gain_depth(*d, smooth, x, y);
            // squared distance along the ray: z^2 (1 + x^2 + y^2) in ray units
            let k = match ray_row.and_then(|r| r.get(x)) {
                Some(ray) => 1.0 + ray[0] * ray[0] + ray[1] * ray[1],
                None => 1.0,
            };
            *v *= (z * z * k * self.inv).clamp(self.lo, self.hi);
        }
    }
}

impl ToneScratch {
    /// The smooth depth map behind the distance compensation (`smooth`, half resolution): the
    /// median of the depths around (a stray wrong depth or a hole in dark clothes takes the
    /// depth of what is around it instead of making a blotch), filled where nothing is measured
    /// nearby. All in the depth's 16-bit steps ([`formats::DEPTH`]: they sort like the
    /// values). False if `depth` is not a whole image.
    fn smooth_depth(&mut self, depth: &Plane<Depth>) -> bool {
        let (w, h) = (WIDTH, HEIGHT);
        let (hw, hh) = (w / 2, h / 2);
        let d = depth.raw();
        if d.len() < w * h {
            return false;
        }
        // half resolution: the mean of the measured pixels of each 2 x 2 block
        self.half.clear();
        self.half.resize(hw * hh, 0);
        for (by, hrow) in self.half.chunks_exact_mut(hw).enumerate() {
            for (bx, v) in hrow.iter_mut().enumerate() {
                let (mut sum, mut n) = (0f32, 0f32);
                for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                    if let Some(&q) = d.get((2 * by + dy) * w + 2 * bx + dx)
                        && q != 0
                    {
                        sum += unpack(formats::DEPTH, q);
                        n += 1.0;
                    }
                }
                *v = if n > 0.0 { pack(formats::DEPTH, sum / n) } else { 0 };
            }
        }
        // the median of the measured values in a 5 x 5 window (10 x 10 pixels)
        self.med.clear();
        self.med.resize(hw * hh, 0);
        for y in 0..hh {
            for x in 0..hw {
                self.window.clear();
                for yy in y.saturating_sub(2)..=(y + 2).min(hh - 1) {
                    let Some(row) = self.half.get(yy * hw..(yy + 1) * hw) else { continue };
                    let Some(part) = row.get(x.saturating_sub(2)..=(x + 2).min(hw - 1)) else { continue };
                    self.window.extend(part.iter().copied().filter(|v| *v != 0));
                }
                if self.window.len() >= 4 {
                    let k = self.window.len() / 2;
                    let (_, m, _) = self.window.select_nth_unstable(k);
                    if let Some(o) = self.med.get_mut(y * hw + x) {
                        *o = *m;
                    }
                }
            }
        }
        // filled where no median is (weight 1 where one is: those stay as they are)
        self.smooth.clear();
        self.smooth.extend_from_slice(&self.med);
        let med = &self.med;
        let input = |y: usize, v: &mut [f32], wt: &mut [f32]| {
            if let Some(row) = med.get(y * hw..(y + 1) * hw) {
                for ((v, wt), q) in v.iter_mut().zip(wt.iter_mut()).zip(row) {
                    *v = unpack(formats::DEPTH, *q);
                    *wt = if *q != 0 { 1.0 } else { 0.0 };
                }
            }
        };
        // (serial: cannot fail)
        let _ = self.pp.build(hw, hh, 1.0, &input, None);
        if self.pp.anchored() {
            self.row.resize(WIDTH, 0.0);
            self.depth_row.resize(WIDTH, 0.0);
            let (Some(around), Some(tmp)) = (self.row.get_mut(..hw), self.depth_row.get_mut(..hw)) else { return true };
            for (y, (orow, mrow)) in self.smooth.chunks_exact_mut(hw).zip(med.chunks_exact(hw)).enumerate() {
                if !mrow.contains(&0) {
                    continue;
                }
                self.pp.surroundings(y, around, tmp);
                for ((o, q), v) in orow.iter_mut().zip(mrow).zip(around.iter()) {
                    if *q == 0 {
                        *o = pack(formats::DEPTH, *v);
                    }
                }
            }
        }
        true
    }
}

/// The distance pixel (x, y) with depth `d` (mm, 0 = none) uses for its compensation: the smooth
/// map (bilinear), but its own depth where it agrees with that (so object edges stay sharp).
#[allow(clippy::indexing_slicing)] // c is a fixed array of four
fn gain_depth(d: f32, smooth: &[u16], x: usize, y: usize) -> f32 {
    let (hw, hh) = (WIDTH / 2, HEIGHT / 2);
    let at = |x: usize, y: usize| smooth.get(y.min(hh - 1) * hw + x.min(hw - 1)).map_or(0.0, |q| unpack(formats::DEPTH, *q));
    let fy = ((y as f32 + 0.5) * 0.5 - 0.5).max(0.0);
    let (y0, ty) = (fy as usize, fy.fract());
    let fx = ((x as f32 + 0.5) * 0.5 - 0.5).max(0.0);
    let (x0, tx) = (fx as usize, fx.fract());
    let c = [at(x0, y0), at(x0 + 1, y0), at(x0, y0 + 1), at(x0 + 1, y0 + 1)];
    let top = c[0] + (c[1] - c[0]) * tx;
    let bottom = c[2] + (c[3] - c[2]) * tx;
    let s = top + (bottom - top) * ty;
    // its own depth if it fits one of the surfaces around (at an edge, either side)
    let fits = c.iter().any(|v| (d - v).abs() <= 0.2 * v);
    if d > 0.0 && fits { d } else { s }
}

/// Divides by the local (box) average in the log domain, keeping the global average (`logs`,
/// `tmp` and `blur` are the buffers it works in).
fn local_adapt(ir: &mut [f32], radius: usize, strength: f32, logs: &mut Vec<f32>, tmp: &mut Vec<f32>, blur: &mut Vec<f32>) {
    logs.clear();
    logs.extend(ir.iter().map(|v| (1.0 + v.max(0.0)).ln()));
    box_blur_into(logs, WIDTH, HEIGHT, radius, tmp, blur);
    let global = logs.iter().sum::<f32>() / logs.len().max(1) as f32;
    for ((v, l), m) in ir.iter_mut().zip(logs.iter()).zip(blur.iter()) {
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
/// so movement does not smear. Its state is kept in `f32` (rounded to the 16-bit steps it
/// would stop short of the mean); the frame gets the smoothed values in its own steps.
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
    row: Vec<f32>,
}

impl Default for TemporalFilter {
    fn default() -> Self {
        TemporalFilter { alpha: 0.4, reset_mm: 60.0, infrared: false, depth: Vec::new(), ir: Vec::new(), row: Vec::new() }
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
        self.row.resize(WIDTH, 0.0);
        if frame.depth.len() == PIXELS {
            if self.depth.len() != PIXELS {
                frame.depth.unpack_into(&mut self.depth);
            } else {
                for (y, state) in self.depth.as_chunks_mut::<WIDTH>().0.iter_mut().enumerate() {
                    frame.depth.unpack_row(y, &mut self.row);
                    for (new, old) in self.row.iter_mut().zip(state.iter_mut()) {
                        let thr = self.reset_mm.max(0.03 * *new);
                        *old = if *new > 0.0 && *old > 0.0 && (*new - *old).abs() < thr { *old + a * (*new - *old) } else { *new };
                        *new = *old;
                    }
                    frame.depth.pack_row(y, &self.row);
                }
            }
        }
        if self.infrared && frame.ir.len() == PIXELS {
            if self.ir.len() != PIXELS {
                frame.ir.unpack_into(&mut self.ir);
            } else {
                for (y, state) in self.ir.as_chunks_mut::<WIDTH>().0.iter_mut().enumerate() {
                    frame.ir.unpack_row(y, &mut self.row);
                    for (new, old) in self.row.iter_mut().zip(state.iter_mut()) {
                        *old += a * (*new - *old);
                        *new = *old;
                    }
                    frame.ir.pack_row(y, &self.row);
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
        for q in frame.depth.raw_mut() {
            let d = unpack(formats::DEPTH, *q);
            if d < self.min_mm || d > self.max_mm {
                *q = 0;
            }
        }
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
        let s = ToneCurve::LogShoulder { knee: 3000.0, top: 65535.0, white: 6000.0 };
        assert_eq!(s.apply(1000.0), 1000.0);
        assert_eq!(s.apply(3000.0), 3000.0);
        // smooth at the knee (slope 1 on both sides), white at the top and above
        assert!((s.apply(3001.0) - 3001.0).abs() < 0.01);
        assert!((s.apply(65535.0) - 6000.0).abs() < 0.5);
        assert_eq!(s.apply(1e9), 6000.0);
        // equal ratios, about equal steps: 7500 -> 15000 and 15000 -> 30000
        let (a, b) = (s.apply(15000.0) - s.apply(7500.0), s.apply(30000.0) - s.apply(15000.0));
        assert!(a > 300.0 && b > 300.0 && (a / b - 1.0).abs() < 0.3, "{a} {b}");
        // in kinect-hub's bytes (sqrt, white at 6000)
        let byte = |v: f32| ((s.apply(v) / 6000.0).sqrt() * 255.0 + 0.5) as u8;
        assert_eq!([byte(3000.0), byte(6000.0), byte(12000.0), byte(30000.0)], [180, 212, 227, 243]);
        assert!(s.apply(f32::NAN) == 0.0 && s.apply(-5.0) == 0.0);
        // without room above the knee: clipped
        assert_eq!(ToneCurve::LogShoulder { knee: 3000.0, top: 5000.0, white: 6000.0 }.apply(7000.0), 6000.0);
    }

    #[test]
    fn fast_ln() {
        for i in 0..20000 {
            let x = 1.0 + i as f32 * 0.37;
            for ln in [ln_fast::<crate::tof::lanes::Fma>, ln_fast::<crate::tof::lanes::Plain>] {
                assert!((ln(x) - x.ln()).abs() < 8.5e-5, "{x}");
            }
        }
        assert_eq!(ln_fast::<Baseline>(1.0), 0.0);
        assert!((ln_fast::<Baseline>(0.001) - 0.001f32.ln()).abs() < 8.5e-5);
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
        assert!(s.smooth_depth(&Plane::from_values(&d)));
        let g: Vec<f32> = (0..PIXELS).map(|i| gain_depth(d[i], &s.smooth, i % WIDTH, i / WIDTH)).collect();
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
