//! The steps after the per-pixel decoding that work on whole areas (a flood fill, a percentile):
//! shared by the CPU and the GPU decoder, which runs them on the decoded output. The infrared
//! fill needs only what stage 1 decided, so a decoder can run it early, beside other work.

use super::TofConfig;
use super::fill::PushPull;
use super::kernels::flags;
use super::parallel::Workers;
use crate::consts::{HEIGHT, PIXELS, WIDTH};
use crate::error::Result;

const W: usize = WIDTH;

/// The buffers of the steps, kept by each decoder: they grow once and are reused (the two
/// fills never run at the same time and share them).
#[derive(Default)]
pub(crate) struct PostScratch {
    /// per pixel: [`OTHER`], [`SOURCE`], [`TARGET`] or [`REACHED`]
    class: Vec<u8>,
    stack: Vec<u32>,
    repaired: Vec<f32>,
    weights: Vec<f32>,
    pp: PushPull,
}

const OTHER: u8 = 0;
/// saturated in some sample, but with depth: the measured rim of a bright object
const SOURCE: u8 = 1;
/// saturated without depth (and not rejected for another reason)
const TARGET: u8 = 2;
/// a target connected to a source through targets
const REACHED: u8 = 3;

/// Where every frequency saturated there is no measurement; inside such an area the depth
/// is interpolated from the measured rim of the same bright object (pixels that saturated
/// in some sample but still have depth), never from what is behind it. With `workers`, the
/// interpolation runs on them (fails only if one panicked).
pub(crate) fn fill_saturated_depth(cfg: &TofConfig, depth: &mut [f32], confidence: &mut [f32], fl: &mut [u32], s: &mut PostScratch, workers: Option<&Workers>) -> Result<()> {
    // nothing saturated (the usual frame): nothing to fill
    if !any_bits(fl, flags::SATURATED_ANY) {
        return Ok(());
    }
    let PostScratch { class, stack, weights, pp, .. } = s;
    let rejected = flags::EDGE | flags::SPECKLE | flags::OUT_OF_RANGE;
    class.clear();
    class.extend(depth.iter().zip(fl.iter()).map(|(d, f)| {
        let sat = f & flags::SATURATED_ANY != 0;
        if !sat {
            OTHER
        } else if *d > 0.0 {
            SOURCE
        } else if *d <= 0.0 && f & rejected == 0 {
            TARGET
        } else {
            OTHER
        }
    }));
    if class.len() < PIXELS {
        return Ok(());
    }
    // the targets next to a source, then everything connected to them through targets
    // (4-neighborhood: the same set as a flood from all sources)
    stack.clear();
    for i in 0..PIXELS {
        if class.get(i) != Some(&TARGET) {
            continue;
        }
        let (x, y) = (i % W, i / W);
        let at = |j: usize| class.get(j) == Some(&SOURCE);
        if (x > 0 && at(i - 1)) || (x + 1 < W && at(i + 1)) || (y > 0 && at(i - W)) || (y + 1 < HEIGHT && at(i + W)) {
            stack.push(i as u32);
        }
    }
    if stack.is_empty() {
        return Ok(());
    }
    for i in stack.iter() {
        if let Some(c) = class.get_mut(*i as usize) {
            *c = REACHED;
        }
    }
    while let Some(i) = stack.pop() {
        let i = i as usize;
        let (x, y) = (i % W, i / W);
        let mut visit = |j: usize| {
            if let Some(c) = class.get_mut(j)
                && *c == TARGET
            {
                *c = REACHED;
                stack.push(j as u32);
            }
        };
        if x > 0 {
            visit(i - 1);
        }
        if x + 1 < W {
            visit(i + 1);
        }
        if y > 0 {
            visit(i - W);
        }
        if y + 1 < HEIGHT {
            visit(i + W);
        }
    }
    weights.clear();
    weights.extend(class.iter().map(|c| if *c == SOURCE { 1.0 } else { 0.0 }));
    let filled = match workers {
        Some(w) => pp.fill_with(depth, weights, W, HEIGHT, w)?,
        None => pp.fill(depth, weights, W, HEIGHT),
    };
    let (lo, hi) = (cfg.min_depth, cfg.max_depth);
    for (((c, v), d), (cf, f)) in class.iter().zip(filled).zip(depth.iter_mut()).zip(confidence.iter_mut().zip(fl.iter_mut())) {
        if *c == REACHED && *v >= lo && *v <= hi {
            *d = *v;
            *cf = 0.5;
            *f = (*f | flags::DEPTH_FILLED) & !flags::LOW_CONFIDENCE;
        }
    }
    Ok(())
}

/// Infrared where every frequency saturated: filled smoothly from the surroundings, but never
/// darker than the level at which this sensor saturates (estimated from the pixels whose
/// saturated sample could be rebuilt: their brightness is known and just at that level).
/// Needs only what stage 1 decided (`IR_FILLED`, the repair bits of `fl`).
pub(crate) fn fill_ir(cfg: &TofConfig, ir: &mut [f32], fl: &[u32], saturation_level: &mut f32, s: &mut PostScratch) {
    // nothing repaired or clipped (the usual frame): no level to learn, nothing to fill
    if !any_bits(fl, flags::REPAIRED_ANY | flags::IR_FILLED) {
        return;
    }
    let PostScratch { repaired, weights, pp, .. } = s;
    repaired.clear();
    let mut clipped = 0usize;
    for (v, f) in ir.iter().zip(fl) {
        clipped += usize::from(*f & flags::IR_FILLED != 0);
        if *f & flags::REPAIRED_ANY != 0 && *f & flags::IR_FILLED == 0 && v.is_finite() && *v > 0.0 {
            repaired.push(*v);
        }
    }
    if repaired.len() >= 30 {
        let k = repaired.len() * 3 / 4;
        let (_, level, _) = repaired.select_nth_unstable_by(k, f32::total_cmp);
        let level = *level;
        *saturation_level = if *saturation_level > 0.0 { 0.8 * *saturation_level + 0.2 * level } else { level };
    }
    if clipped == 0 {
        return;
    }
    weights.clear();
    weights.extend(fl.iter().map(|f| if *f & flags::IR_FILLED != 0 { 0.0 } else { 1.0 }));
    let filled = pp.fill(ir, weights, W, HEIGHT);
    let gain = cfg.ext.ir_fill_gain;
    let floor = *saturation_level;
    for ((o, f), v) in ir.iter_mut().zip(fl).zip(filled) {
        if *f & flags::IR_FILLED != 0 {
            *o = v.max(floor) * gain;
        }
    }
}

/// True if any pixel has any of `bits`: an OR over the whole plane, which vectorizes (a quick
/// look before the steps that would otherwise walk every pixel for nothing).
fn any_bits(fl: &[u32], bits: u32) -> bool {
    fl.iter().fold(0, |a, f| a | f) & bits != 0
}
