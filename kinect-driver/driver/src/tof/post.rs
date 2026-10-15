//! The steps after the per-pixel decoding that work on whole areas (a flood fill, a percentile):
//! shared by the CPU and the GPU decoder, which runs them on the decoded output (16-bit planes).
//! The infrared fill needs only what stage 1 decided, so a decoder can run it early, beside
//! other work.

use super::TofConfig;
use super::fill::PushPull;
use super::kernels::flags;
use super::pack::{Codec, formats, pack, unpack};
use super::parallel::Workers;
use crate::consts::{HEIGHT, PIXELS, WIDTH};
use crate::error::Result;
use crate::plane::{Confidence, Depth, Infrared, Plane};

const W: usize = WIDTH;

/// The scale of the infrared in f16 ([`formats::IR`]), also for its push-pull pyramid.
const IR_SCALE: f32 = match formats::IR {
    Codec::F16 { scale } => scale,
    _ => 1.0,
};

/// The buffers of the steps, kept by each decoder: they grow once and are reused (the two
/// fills never run at the same time and share them). Nothing here is as large as an `f32`
/// image: the push-pull reads its input row by row and works out only the pixels it fills.
#[derive(Default)]
pub(crate) struct PostScratch {
    /// per pixel: [`OTHER`], [`SOURCE`], [`TARGET`] or [`REACHED`]
    class: Vec<u8>,
    stack: Vec<u32>,
    /// the infrared of the rebuilt pixels as stored (f16 bits, which sort like the values for
    /// positive values)
    repaired: Vec<u16>,
    pp: PushPull,
    /// per thread: the surroundings of a row, a temporary row, the row being filled
    rows: Vec<Rows>,
}

/// Rows a thread fills with.
#[derive(Default)]
struct Rows {
    around: Vec<f32>,
    tmp: Vec<f32>,
    row: Vec<f32>,
}

impl Rows {
    fn size(&mut self) {
        for r in [&mut self.around, &mut self.tmp, &mut self.row] {
            r.resize(W, 0.0);
        }
    }
}

/// Rows of the image per work item of the depth fill.
const BLOCK_ROWS: usize = 8;

/// The rows of the depth fill one work item writes (from row `y0` on).
struct Block<'a> {
    y0: usize,
    class: &'a [u8],
    flags: &'a mut [u32],
    depth: &'a mut [u16],
    confidence: &'a mut [u16],
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
pub(crate) fn fill_saturated_depth(cfg: &TofConfig, depth: &mut Plane<Depth>, confidence: &mut Plane<Confidence>, fl: &mut [u32], s: &mut PostScratch, workers: Option<&Workers>) -> Result<()> {
    // nothing saturated (the usual frame): nothing to fill
    if !any_bits(fl, flags::SATURATED_ANY) {
        return Ok(());
    }
    let PostScratch { class, stack, pp, rows, .. } = s;
    let rejected = flags::EDGE | flags::SPECKLE | flags::OUT_OF_RANGE;
    class.clear();
    // (a stored depth of 0 is no depth; the decoders never store a negative one)
    class.extend(depth.raw().iter().zip(fl.iter()).map(|(d, f)| {
        let sat = f & flags::SATURATED_ANY != 0;
        if !sat {
            OTHER
        } else if *d != 0 {
            SOURCE
        } else if f & rejected == 0 {
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
    // the depth of the sources, spread over the reached targets
    {
        let (d, cl): (&Plane<Depth>, &[u8]) = (depth, class);
        let input = |y: usize, v: &mut [f32], w: &mut [f32]| {
            d.unpack_slice(y * W, v);
            if let Some(cr) = cl.get(y * W..(y + 1) * W) {
                w.iter_mut().zip(cr).for_each(|(w, c)| *w = if *c == SOURCE { 1.0 } else { 0.0 });
            }
        };
        pp.build(W, HEIGHT, 1.0, &input, workers)?;
    }
    // a target has no depth and weight 0: all of it comes from around (the rows with a
    // target, in blocks over the workers)
    let (lo, hi) = (cfg.min_depth, cfg.max_depth);
    let half = pack(formats::CONFIDENCE, 0.5);
    let threads = workers.map_or(1, Workers::threads);
    if rows.len() < threads {
        rows.resize_with(threads, Rows::default);
    }
    rows.iter_mut().for_each(Rows::size);
    let pp: &PushPull = pp;
    let blocks = class
        .chunks(W * BLOCK_ROWS)
        .zip(fl.chunks_mut(W * BLOCK_ROWS))
        .zip(depth.raw_mut().chunks_mut(W * BLOCK_ROWS).zip(confidence.raw_mut().chunks_mut(W * BLOCK_ROWS)))
        .enumerate()
        .map(|(b, ((class, flags), (depth, confidence)))| Block { y0: b * BLOCK_ROWS, class, flags, depth, confidence });
    let work = |r: &mut Rows, b: Block| {
        let rows = b.class.as_chunks::<W>().0.iter().zip(b.flags.as_chunks_mut::<W>().0.iter_mut()).zip(b.depth.as_chunks_mut::<W>().0.iter_mut().zip(b.confidence.as_chunks_mut::<W>().0.iter_mut()));
        for (k, ((cr, fr), (dr, cfr))) in rows.enumerate() {
            if !cr.contains(&REACHED) {
                continue;
            }
            pp.surroundings(b.y0 + k, &mut r.around, &mut r.tmp);
            for (((c, f), v), (d, cf)) in cr.iter().zip(fr.iter_mut()).zip(r.around.iter()).zip(dr.iter_mut().zip(cfr.iter_mut())) {
                if *c == REACHED && *v >= lo && *v <= hi {
                    *d = pack(formats::DEPTH, *v);
                    *cf = half;
                    *f = (*f | flags::DEPTH_FILLED) & !flags::LOW_CONFIDENCE;
                }
            }
        }
    };
    match workers {
        Some(w) => w.for_each_with(rows, blocks, &work)?,
        None => {
            if let Some(r) = rows.first_mut() {
                blocks.for_each(|b| work(r, b));
            }
        }
    }
    Ok(())
}

/// Infrared where every frequency saturated: filled smoothly from the surroundings, but never
/// darker than the level at which this sensor saturates (estimated from the pixels whose
/// saturated sample could be rebuilt: their brightness is known and just at that level).
/// Needs only what stage 1 decided (`IR_FILLED`, the repair bits of `fl`).
pub(crate) fn fill_ir(cfg: &TofConfig, ir: &mut Plane<Infrared>, fl: &[u32], saturation_level: &mut f32, s: &mut PostScratch) {
    // nothing repaired or clipped (the usual frame): no level to learn, nothing to fill
    if !any_bits(fl, flags::REPAIRED_ANY | flags::IR_FILLED) {
        return;
    }
    let PostScratch { repaired, pp, rows, .. } = s;
    repaired.clear();
    let mut clipped = 0usize;
    for (q, f) in ir.raw().iter().zip(fl) {
        clipped += usize::from(*f & flags::IR_FILLED != 0);
        // positive and finite: f16 bits above 0 and below the infinities (no sign bit)
        if *f & flags::REPAIRED_ANY != 0 && *f & flags::IR_FILLED == 0 && *q != 0 && *q < 0x7c00 {
            repaired.push(*q);
        }
    }
    if repaired.len() >= 30 {
        let k = repaired.len() * 3 / 4;
        let (_, level, _) = repaired.select_nth_unstable(k);
        let level = unpack(formats::IR, *level);
        *saturation_level = if *saturation_level > 0.0 { 0.8 * *saturation_level + 0.2 * level } else { level };
    }
    if clipped == 0 {
        return;
    }
    {
        let irr: &Plane<Infrared> = ir;
        let input = |y: usize, v: &mut [f32], w: &mut [f32]| {
            irr.unpack_slice(y * W, v);
            if let Some(fr) = fl.get(y * W..(y + 1) * W) {
                w.iter_mut().zip(fr).for_each(|(w, f)| *w = if *f & flags::IR_FILLED != 0 { 0.0 } else { 1.0 });
            }
        };
        // (serial: cannot fail)
        let _ = pp.build(W, HEIGHT, IR_SCALE, &input, None);
    }
    let gain = cfg.ext.ir_fill_gain;
    let floor = *saturation_level;
    if rows.is_empty() {
        rows.push(Rows::default());
    }
    let Some(r) = rows.first_mut() else { return };
    r.size();
    for (y, fr) in fl.as_chunks::<W>().0.iter().enumerate() {
        if !fr.iter().any(|f| *f & flags::IR_FILLED != 0) {
            continue;
        }
        pp.surroundings(y, &mut r.around, &mut r.tmp);
        ir.unpack_row(y, &mut r.row);
        for ((o, f), v) in r.row.iter_mut().zip(fr).zip(r.around.iter()) {
            if *f & flags::IR_FILLED != 0 {
                *o = v.max(floor) * gain;
            }
        }
        ir.pack_row(y, &r.row);
    }
}

/// True if any pixel has any of `bits`: an OR over the whole plane, which vectorizes (a quick
/// look before the steps that would otherwise walk every pixel for nothing).
fn any_bits(fl: &[u32], bits: u32) -> bool {
    fl.iter().fold(0, |a, f| a | f) & bits != 0
}
