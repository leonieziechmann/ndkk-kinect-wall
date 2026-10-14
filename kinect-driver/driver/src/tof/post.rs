//! The steps after the per-pixel decoding that work on whole areas (a flood fill, a percentile):
//! shared by the CPU and the GPU decoder, which runs them on the decoded output.

use super::fill::push_pull;
use super::kernels::flags;
use super::{TofConfig, TofOutput};
use crate::consts::{HEIGHT, PIXELS, WIDTH};

const W: usize = WIDTH;

/// Where every frequency saturated there is no measurement; inside such an area the depth
/// is interpolated from the measured rim of the same bright object (pixels that saturated
/// in some sample but still have depth), never from what is behind it.
pub(crate) fn fill_saturated_depth(cfg: &TofConfig, out: &mut TofOutput) {
    let sat = |f: u32| f & flags::SATURATED_ANY != 0;
    let rejected = flags::EDGE | flags::SPECKLE | flags::OUT_OF_RANGE;
    let is_source = |i: usize| out.depth.get(i).is_some_and(|d| *d > 0.0) && out.flags.get(i).is_some_and(|f| sat(*f));
    let is_target = |i: usize| out.depth.get(i).is_some_and(|d| *d <= 0.0) && out.flags.get(i).is_some_and(|f| sat(*f) && *f & rejected == 0);
    // flood from the sources through the targets (4-neighborhood)
    let mut reached = vec![false; PIXELS];
    let mut queue: std::collections::VecDeque<usize> = (0..PIXELS).filter(|i| is_source(*i)).collect();
    if queue.is_empty() {
        return;
    }
    let mut any = false;
    while let Some(i) = queue.pop_front() {
        let (x, y) = (i % W, i / W);
        let mut push = |j: usize| {
            if let Some(r) = reached.get_mut(j)
                && !*r
                && is_target(j)
            {
                *r = true;
                any = true;
                queue.push_back(j);
            }
        };
        if x > 0 {
            push(i - 1);
        }
        if x + 1 < W {
            push(i + 1);
        }
        if y > 0 {
            push(i - W);
        }
        if y + 1 < HEIGHT {
            push(i + W);
        }
    }
    if !any {
        return;
    }
    let weights: Vec<f32> = (0..PIXELS).map(|i| if is_source(i) { 1.0 } else { 0.0 }).collect();
    let filled = push_pull(&out.depth, &weights, W, HEIGHT);
    let (lo, hi) = (cfg.min_depth, cfg.max_depth);
    for (i, r) in reached.iter().enumerate() {
        if !*r {
            continue;
        }
        let v = filled.get(i).copied().unwrap_or(0.0);
        if v >= lo
            && v <= hi
            && let (Some(d), Some(c), Some(f)) = (out.depth.get_mut(i), out.confidence.get_mut(i), out.flags.get_mut(i))
        {
            *d = v;
            *c = 0.5;
            *f = (*f | flags::DEPTH_FILLED) & !flags::LOW_CONFIDENCE;
        }
    }
}

/// Infrared where every frequency saturated: filled smoothly from the surroundings, but never
/// darker than the level at which this sensor saturates (estimated from the pixels whose
/// saturated sample could be rebuilt: their brightness is known and just at that level).
pub(crate) fn fill_ir(cfg: &TofConfig, out: &mut TofOutput, saturation_level: &mut f32) {
    let mut repaired: Vec<f32> = out
        .ir
        .iter()
        .zip(&out.flags)
        .filter(|(v, f)| **f & flags::REPAIRED_ANY != 0 && **f & flags::IR_FILLED == 0 && v.is_finite() && **v > 0.0)
        .map(|(v, _)| *v)
        .collect();
    if repaired.len() >= 30 {
        let k = repaired.len() * 3 / 4;
        let (_, level, _) = repaired.select_nth_unstable_by(k, f32::total_cmp);
        let level = *level;
        *saturation_level = if *saturation_level > 0.0 { 0.8 * *saturation_level + 0.2 * level } else { level };
    }
    let clipped = out.flags.iter().filter(|f| **f & flags::IR_FILLED != 0).count();
    if clipped == 0 {
        return;
    }
    let weights: Vec<f32> = out.flags.iter().map(|f| if *f & flags::IR_FILLED != 0 { 0.0 } else { 1.0 }).collect();
    let filled = push_pull(&out.ir, &weights, W, HEIGHT);
    let gain = cfg.ext.ir_fill_gain;
    let floor = *saturation_level;
    for ((o, f), v) in out.ir.iter_mut().zip(&out.flags).zip(filled) {
        if *f & flags::IR_FILLED != 0 {
            *o = v.max(floor) * gain;
        }
    }
}
