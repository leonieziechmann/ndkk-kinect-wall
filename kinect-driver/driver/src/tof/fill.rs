//! Push-pull filling: missing values of an image are interpolated smoothly from what is there,
//! over any distance (used for clipped infrared, inside saturated areas, as the depth
//! expectation of the resolver and for the distance map of the infrared tone mapping).
//! O(pixels), well under a millisecond for the whole image.
//!
//! Memory: the input (level 0) is read row by row where it is needed and never stored; the
//! levels above it keep their premultiplied values and weights as f16 (like the GPU decoder)
//! and their filled values as `f32`; and the result at the input's resolution is not stored
//! either: [`PushPull::surroundings`] and [`PushPull::at`] work it out for the rows and pixels
//! asked for (a fill wants only the pixels it fills). For the whole image that is about 0.6 MB.

use super::pack::{Codec, pack_row, unpack_row};
use super::parallel::Workers;
use crate::error::Result;

/// One pyramid level above the input: premultiplied values (f16 of `v * scale`) and weights
/// (0..1, f16), and the filled values once the pull has reached the level.
#[derive(Clone, Debug, Default)]
struct Level {
    w: usize,
    h: usize,
    vw: Vec<u16>,
    wt: Vec<u16>,
    filled: Vec<f32>,
}

/// The rows a thread works in while level 1 is built from the input.
#[derive(Clone, Debug, Default)]
struct Rows {
    v0: Vec<f32>,
    w0: Vec<f32>,
    v1: Vec<f32>,
    w1: Vec<f32>,
    vw: Vec<f32>,
    wt: Vec<f32>,
    /// some weight of level 1 was above 0 (so some input weight was)
    any: bool,
}

impl Rows {
    /// Room for input rows of `width` and level 1 rows of `half` (grows once).
    fn size(&mut self, width: usize, half: usize) {
        for r in [&mut self.v0, &mut self.w0, &mut self.v1, &mut self.w1] {
            r.resize(width, 0.0);
        }
        self.vw.resize(half, 0.0);
        self.wt.resize(half, 0.0);
        self.any = false;
    }
}

/// The input of a fill, row by row: `input(y, values, weights)` writes row `y` (the slices are
/// as long as the image is wide). Weights are clamped to 0..1; a value of weight 1 stays as it
/// is, one of weight 0 is filled from around it.
pub type Input<'a> = dyn Fn(usize, &mut [f32], &mut [f32]) + Sync + 'a;

/// Push-pull with its buffers kept between calls: once they have grown to the image size, a
/// fill allocates nothing.
#[derive(Clone, Debug, Default)]
pub struct PushPull {
    width: usize,
    height: usize,
    /// values are stored as f16 of `v * scale`
    scale: f32,
    /// level 1 up (the input is level 0)
    levels: Vec<Level>,
    /// levels of the current image
    used: usize,
    /// some input weight was above 0
    any: bool,
    /// per thread while level 1 is built
    rows: Vec<Rows>,
    /// rows of the levels above while they are built and pulled
    a: Vec<f32>,
    b: Vec<f32>,
    c: Vec<f32>,
    d: Vec<f32>,
    /// the row of a level above 1 while it is made, before packing
    next_v: Vec<f32>,
    next_w: Vec<f32>,
    tx: Vec<(usize, usize, f32)>,
    ty: Vec<(usize, usize, f32)>,
    /// the taps of the input's columns in level 1
    tx0: Vec<(usize, usize, f32)>,
    /// the result of [`PushPull::fill`] at the input's resolution, and a row while it is made
    out: Vec<f32>,
    row: Vec<f32>,
}

impl PushPull {
    /// Empty buffers (they grow with the first fill).
    pub fn new() -> PushPull {
        PushPull::default()
    }

    /// Builds the pyramid of a `width` x `height` image read from `input` (row by row; level 1
    /// on `workers` if there are any) and pulls the filled values down to level 1; then
    /// [`PushPull::at`] gives any pixel of the result. Values are kept as f16 of `v * scale`
    /// (choose a power of two that keeps them below 65504). Fails only if a worker panicked.
    pub fn build(&mut self, width: usize, height: usize, scale: f32, input: &Input<'_>, workers: Option<&Workers>) -> Result<()> {
        self.width = width;
        self.height = height;
        self.scale = if scale > 0.0 && scale.is_finite() { scale } else { 1.0 };
        self.used = 0;
        self.any = false;
        if width == 0 || height == 0 || (width <= 1 && height <= 1) {
            return Ok(());
        }
        // the sizes of the levels above the input
        let (mut w, mut h) = (width, height);
        while !(w <= 1 && h <= 1) && self.used < 23 {
            (w, h) = (w.div_ceil(2), h.div_ceil(2));
            if self.used == self.levels.len() {
                self.levels.push(Level::default());
            }
            if let Some(l) = self.levels.get_mut(self.used) {
                l.w = w;
                l.h = h;
                l.vw.resize(w * h, 0);
                l.wt.resize(w * h, 0);
                l.filled.resize(w * h, 0.0);
            }
            self.used += 1;
        }
        self.build_level1(input, workers)?;
        self.push_up();
        self.pull_down();
        if let Some(l1) = self.levels.first() {
            upsample_taps(&mut self.tx0, width, l1.w);
        }
        Ok(())
    }

    /// Level 1 from the input: each pixel the average of its 2 x 2 children.
    fn build_level1(&mut self, input: &Input<'_>, workers: Option<&Workers>) -> Result<()> {
        let (width, height) = (self.width, self.height);
        let codec = Codec::F16 { scale: self.scale };
        let PushPull { levels, rows, .. } = self;
        let Some(l1) = levels.first_mut() else { return Ok(()) };
        let threads = workers.map_or(1, Workers::threads);
        if rows.len() < threads {
            rows.resize(threads, Rows::default());
        }
        // (every scratch sized here: whichever thread takes one, nothing grows inside)
        for r in rows.iter_mut() {
            r.size(width, l1.w);
        }
        let nw = l1.w;
        let blocks = l1.vw.chunks_mut(nw * BLOCK_ROWS).zip(l1.wt.chunks_mut(nw * BLOCK_ROWS)).enumerate();
        let work = |r: &mut Rows, (b, (vw, wt)): (usize, (&mut [u16], &mut [u16]))| {
            for (k, (vrow, wrow)) in vw.chunks_mut(nw).zip(wt.chunks_mut(nw)).enumerate() {
                level1_row(input, width, height, b * BLOCK_ROWS + k, r);
                pack_row(codec, &r.vw, vrow);
                pack_row(Codec::F16 { scale: 1.0 }, &r.wt, wrow);
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
        self.any = self.rows.iter().any(|r| r.any);
        Ok(())
    }

    /// The levels above level 1: sums of 2 x 2 children, averaged as [`average`] does.
    fn push_up(&mut self) {
        let codec = Codec::F16 { scale: self.scale };
        let one = Codec::F16 { scale: 1.0 };
        let PushPull { levels, a, b, c, d, next_v, next_w, used, .. } = self;
        for li in 1..*used {
            let (lower, upper) = levels.split_at_mut(li);
            let (Some(child), Some(l)) = (lower.last(), upper.first_mut()) else { break };
            let (cw, ch) = (child.w, child.h);
            for r in [&mut *a, &mut *b, &mut *c, &mut *d] {
                r.resize(cw, 0.0);
            }
            next_v.resize(l.w, 0.0);
            next_w.resize(l.w, 0.0);
            for y in 0..l.h {
                let child_row = |p, yy| level_row(p, cw, ch, yy);
                if let (Some(v0), Some(w0)) = (child_row(&child.vw, 2 * y), child_row(&child.wt, 2 * y)) {
                    unpack_row(codec, v0, a);
                    unpack_row(one, w0, b);
                }
                let two = match (child_row(&child.vw, 2 * y + 1), child_row(&child.wt, 2 * y + 1)) {
                    (Some(v1), Some(w1)) => {
                        unpack_row(codec, v1, c);
                        unpack_row(one, w1, d);
                        true
                    }
                    _ => false,
                };
                for (x, (ov, ow)) in next_v.iter_mut().zip(next_w.iter_mut()).enumerate() {
                    let at = |r: &[f32], xx: usize| if xx < cw { r.get(xx).copied().unwrap_or(0.0) } else { 0.0 };
                    // in the order of the GPU's loop: row by row, left to right
                    let (mut sv, mut sw) = (at(a, 2 * x) + at(a, 2 * x + 1), at(b, 2 * x) + at(b, 2 * x + 1));
                    if two {
                        sv = sv + at(c, 2 * x) + at(c, 2 * x + 1);
                        sw = sw + at(d, 2 * x) + at(d, 2 * x + 1);
                    }
                    (*ov, *ow) = average(sv, sw);
                }
                if let (Some(vrow), Some(wrow)) = (l.vw.get_mut(y * l.w..(y + 1) * l.w), l.wt.get_mut(y * l.w..(y + 1) * l.w)) {
                    pack_row(codec, next_v, vrow);
                    pack_row(one, next_w, wrow);
                }
            }
        }
    }

    /// The filled values from the top level down to level 1: at each level what is missing
    /// comes from the (filled) level above.
    fn pull_down(&mut self) {
        let codec = Codec::F16 { scale: self.scale };
        let one = Codec::F16 { scale: 1.0 };
        let PushPull { levels, a, b, c, d, tx, ty, used, .. } = self;
        let Some(top) = used.checked_sub(1).and_then(|i| levels.get_mut(i)) else { return };
        a.resize(top.vw.len(), 0.0);
        b.resize(top.wt.len(), 0.0);
        unpack_row(codec, &top.vw, a);
        unpack_row(one, &top.wt, b);
        for ((f, v), t) in top.filled.iter_mut().zip(a.iter()).zip(b.iter()) {
            *f = if *t > 0.0 { v / t } else { 0.0 };
        }
        for li in (0..used.saturating_sub(1)).rev() {
            let (lower, upper) = levels.split_at_mut(li + 1);
            let (Some(l), Some(p)) = (lower.last_mut(), upper.first()) else { break };
            upsample_taps(tx, l.w, p.w);
            upsample_taps(ty, l.h, p.h);
            for r in [&mut *a, &mut *b, &mut *c, &mut *d] {
                r.resize(l.w, 0.0);
            }
            let prow = |yy: usize| p.filled.get(yy * p.w..(yy + 1) * p.w).unwrap_or(&[]);
            for y in 0..l.h {
                let (ya, yb, fy) = ty.get(y).copied().unwrap_or((0, 0, 0.0));
                upsample_row(prow(ya), a, tx);
                upsample_row(prow(yb), b, tx);
                let span = y * l.w..(y + 1) * l.w;
                if let (Some(v), Some(t)) = (l.vw.get(span.clone()), l.wt.get(span.clone())) {
                    unpack_row(codec, v, c);
                    unpack_row(one, t, d);
                }
                let Some(out) = l.filled.get_mut(span) else { continue };
                for ((o, (u, dn)), (v, w)) in out.iter_mut().zip(a.iter().zip(b.iter())).zip(c.iter().zip(d.iter())) {
                    let parent = u + (dn - u) * fy;
                    *o = v + (1.0 - w) * parent;
                }
            }
        }
    }

    /// True if some input weight of the last build was above 0 (otherwise everything is 0).
    pub fn anchored(&self) -> bool {
        self.any
    }

    /// Row `y` of the result where the input's own weight is 0, i.e. all of it from the
    /// surroundings (the level above, upsampled): `out` and `tmp` as long as the image is wide.
    /// The same as [`PushPull::at`] with weight 0, a whole row at a time (vectorized).
    pub fn surroundings(&self, y: usize, out: &mut [f32], tmp: &mut [f32]) {
        let Some(l1) = self.levels.first().filter(|_| self.used > 0) else {
            out.fill(0.0);
            return;
        };
        let (ya, yb, fy) = tap(y, l1.h);
        let row = |yy: usize| l1.filled.get(yy * l1.w..(yy + 1) * l1.w).unwrap_or(&[]);
        upsample_row(row(ya), out, &self.tx0);
        upsample_row(row(yb), tmp, &self.tx0);
        for (u, d) in out.iter_mut().zip(tmp.iter()) {
            *u = *u + (d - *u) * fy;
        }
    }

    /// The result of the last [`PushPull::build`] at pixel (x, y) of the input, whose own value
    /// and weight are `v` and `w`: `v` where `w` is 1, the surroundings where it is 0.
    #[inline]
    pub fn at(&self, x: usize, y: usize, v: f32, w: f32) -> f32 {
        let (v, w) = level0(v, w);
        let Some(l1) = self.levels.first().filter(|_| self.used > 0) else {
            return if w > 0.0 { v / w } else { 0.0 };
        };
        let (xa, xb, fx) = tap(x, l1.w);
        let (ya, yb, fy) = tap(y, l1.h);
        let p = |xx: usize, yy: usize| l1.filled.get(yy * l1.w + xx).copied().unwrap_or(0.0);
        let (a0, a1, b0, b1) = (p(xa, ya), p(xb, ya), p(xa, yb), p(xb, yb));
        let up = a0 + (a1 - a0) * fx;
        let dn = b0 + (b1 - b0) * fx;
        let parent = up + (dn - up) * fy;
        v + (1.0 - w) * parent
    }

    /// Fills pixels with weight 0 (or small weights) from the weighted values around them.
    /// `values` and `weights` are `width * height`; weights are clamped to 0..1. Pixels with
    /// weight 1 keep their value. The result lives until the next call.
    pub fn fill(&mut self, values: &[f32], weights: &[f32], width: usize, height: usize) -> &[f32] {
        // run serially, nothing can fail
        let _ = self.fill_all(values, weights, width, height, None);
        &self.out
    }

    /// [`PushPull::fill`] with level 1 (most of the work) spread over `workers`; the same
    /// result. Fails only if a worker panicked.
    pub fn fill_with(&mut self, values: &[f32], weights: &[f32], width: usize, height: usize, workers: &Workers) -> Result<&[f32]> {
        self.fill_all(values, weights, width, height, Some(workers))?;
        Ok(&self.out)
    }

    fn fill_all(&mut self, values: &[f32], weights: &[f32], width: usize, height: usize, workers: Option<&Workers>) -> Result<()> {
        let n = width * height;
        let (Some(values), Some(weights)) = (values.get(..n), weights.get(..n)) else {
            self.out.clear();
            self.out.extend_from_slice(values);
            return Ok(());
        };
        let input = |y: usize, v: &mut [f32], w: &mut [f32]| {
            if let (Some(vs), Some(ws)) = (values.get(y * width..(y + 1) * width), weights.get(y * width..(y + 1) * width)) {
                v.iter_mut().zip(vs).for_each(|(o, s)| *o = *s);
                w.iter_mut().zip(ws).for_each(|(o, s)| *o = *s);
            }
        };
        self.build(width, height, scale_for(values), &input, workers)?;
        let (mut out, mut row) = (std::mem::take(&mut self.out), std::mem::take(&mut self.row));
        out.clear();
        out.resize(n, 0.0);
        row.resize(width, 0.0);
        if self.used == 0 {
            // a single pixel (or none): its own value where it has weight
            for ((o, v), w) in out.iter_mut().zip(values).zip(weights) {
                *o = self.at(0, 0, *v, *w);
            }
        } else {
            for (y, ((orow, vrow), wrow)) in out.chunks_exact_mut(width).zip(values.chunks_exact(width)).zip(weights.chunks_exact(width)).enumerate() {
                self.surroundings(y, orow, &mut row);
                for ((o, v), w) in orow.iter_mut().zip(vrow).zip(wrow) {
                    let (v, w) = level0(*v, *w);
                    *o = v + (1.0 - w) * *o;
                }
            }
        }
        (self.out, self.row) = (out, row);
        Ok(())
    }
}

/// A power of two that keeps `values` within f16 (with room to spare): 1 for anything up to
/// 32768.
fn scale_for(values: &[f32]) -> f32 {
    let max = values.iter().fold(0f32, |m, v| if v.is_finite() { m.max(v.abs()) } else { m });
    let mut scale = 1.0f32;
    while max * scale > 32768.0 && scale > 1e-30 {
        scale *= 0.5;
    }
    scale
}

/// Rows of level 1 per work item.
const BLOCK_ROWS: usize = 8;

/// The first `n` values of a row as pairs (an odd last one left out).
fn pairs(a: &[f32], n: usize) -> &[[f32; 2]] {
    a.get(..n).unwrap_or(&[]).as_chunks::<2>().0
}

/// Row `y` of a `w` x `h` level (none below the last row).
fn level_row(buf: &[u16], w: usize, h: usize, y: usize) -> Option<&[u16]> {
    if y < h { buf.get(y * w..(y + 1) * w) } else { None }
}

/// The taps of coordinate `x` of a level upsampled by 2 from a parent of `parent` pixels: the
/// two parent coordinates and the weight of the second (bilinear: 0.75 / 0.25 alternate).
#[inline(always)]
fn tap(x: usize, parent: usize) -> (usize, usize, f32) {
    let last = parent.saturating_sub(1);
    if x.is_multiple_of(2) {
        // center at x/2 - 0.25: between x/2 - 1 (0.25) and x/2 (0.75)
        let b = (x / 2).min(last);
        (b.saturating_sub(1), b, 0.75)
    } else {
        // center at (x-1)/2 + 0.25: between (x-1)/2 (0.75) and (x+1)/2 (0.25)
        let a = (x / 2).min(last);
        (a, (a + 1).min(last), 0.25)
    }
}

/// [`tap`] of every coordinate `0..n`.
fn upsample_taps(taps: &mut Vec<(usize, usize, f32)>, n: usize, parent: usize) {
    taps.clear();
    taps.extend((0..n).map(|x| tap(x, parent)));
}

/// One parent row upsampled to `out.len()` columns with the taps of [`upsample_taps`]: the
/// border pixels with the general rule, the rest pairwise from three neighbors (vectorizes).
fn upsample_row(parent: &[f32], out: &mut [f32], taps: &[(usize, usize, f32)]) {
    let lerp = |a: f32, b: f32, f: f32| a + (b - a) * f;
    let n = out.len();
    // pairs (2i, 2i + 1) for 1 <= i <= parent.len() - 2 read parent[i - 1 ..= i + 1] unclamped
    let inner = parent.len().saturating_sub(2).min(n.saturating_sub(2) / 2);
    if let Some(rest) = out.get_mut(2..2 + 2 * inner) {
        for (pair, win) in rest.chunks_exact_mut(2).zip(parent.windows(3)) {
            if let ([e, o], [a, b, c]) = (pair, win) {
                *e = lerp(*a, *b, 0.75);
                *o = lerp(*b, *c, 0.25);
            }
        }
    }
    for x in (0..n.min(2)).chain(2 + 2 * inner..n) {
        let (xa, xb, fx) = taps.get(x).copied().unwrap_or((0, 0, 0.0));
        if let Some(o) = out.get_mut(x) {
            *o = match (parent.get(xa), parent.get(xb)) {
                (Some(a), Some(b)) => lerp(*a, *b, fx),
                _ => 0.0,
            };
        }
    }
}

/// A pixel of the input as level 0 of the pyramid: (premultiplied value, weight); the weight
/// clamped to 0..1, 0 if either is not finite.
#[inline(always)]
fn level0(v: f32, w: f32) -> (f32, f32) {
    let w = if w.is_finite() { w.clamp(0.0, 1.0) } else { 0.0 };
    (if v.is_finite() { v * w } else { 0.0 }, w)
}

/// Row `y` of level 1 from the input rows `2y` and `2y + 1` (the second missing below the last
/// row): the sums of the 2 x 2 children, averaged as [`average`] does, into `r.vw` and `r.wt`.
fn level1_row(input: &Input<'_>, width: usize, height: usize, y: usize, r: &mut Rows) {
    let Rows { v0, w0, v1, w1, vw, wt, any } = r;
    input(2 * y, v0.as_mut_slice(), w0.as_mut_slice());
    let two = 2 * y + 1 < height;
    if two {
        input(2 * y + 1, v1.as_mut_slice(), w1.as_mut_slice());
    }
    let (v0, w0, v1, w1) = (v0.as_slice(), w0.as_slice(), v1.as_slice(), w1.as_slice());
    // the children pairwise (a straight loop that vectorizes)
    let top = vw.iter_mut().zip(wt.iter_mut()).zip(pairs(v0, width).iter().zip(pairs(w0, width)));
    if two {
        for (((ov, ow), (&[va, vb], &[wa, wb])), (&[vc, vd], &[wc, wd])) in top.zip(pairs(v1, width).iter().zip(pairs(w1, width))) {
            let ((va, wa), (vb, wb), (vc, wc), (vd, wd)) = (level0(va, wa), level0(vb, wb), level0(vc, wc), level0(vd, wd));
            (*ov, *ow) = average(va + vb + vc + vd, wa + wb + wc + wd);
        }
    } else {
        for ((ov, ow), (&[va, vb], &[wa, wb])) in top {
            let ((va, wa), (vb, wb)) = (level0(va, wa), level0(vb, wb));
            (*ov, *ow) = average(va + vb, wa + wb);
        }
    }
    let at = |a: &[f32], x: usize| a.get(x).copied().unwrap_or(0.0);
    if width % 2 == 1 {
        let last = width - 1;
        let (va, wa) = level0(at(v0, last), at(w0, last));
        let (vc, wc) = if two { level0(at(v1, last), at(w1, last)) } else { (0.0, 0.0) };
        if let (Some(ov), Some(ow)) = (vw.get_mut(width / 2), wt.get_mut(width / 2)) {
            (*ov, *ow) = average(va + vc, wa + wc);
        }
    }
    // (a level 1 weight is above 0 exactly where an input weight is)
    *any |= wt.iter().any(|t| *t > 0.0);
}

/// A sum of children as a pixel of the next level: their average, the confidence saturating
/// at 1.
#[inline(always)]
fn average(v: f32, t: f32) -> (f32, f32) {
    if t > 0.0 {
        let c = t.min(1.0);
        (v / t * c, c)
    } else {
        (v, t)
    }
}

/// Fills pixels with weight 0 (or small weights) from the weighted values around them.
/// `values` and `weights` are `width * height`; weights are clamped to 0..1. Pixels with weight 1
/// keep their value. (Allocates its buffers: for repeated use keep a [`PushPull`].)
pub fn push_pull(values: &[f32], weights: &[f32], width: usize, height: usize) -> Vec<f32> {
    PushPull::new().fill(values, weights, width, height).to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holes_are_filled_smoothly() {
        let (w, h) = (64, 48);
        let values: Vec<f32> = (0..w * h).map(|i| (i % w) as f32).collect();
        let mut weights = vec![1.0f32; w * h];
        for y in 20..30 {
            for x in 25..40 {
                weights[y * w + x] = 0.0;
            }
        }
        let f = push_pull(&values, &weights, w, h);
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                if weights[i] == 1.0 {
                    assert!((f[i] - values[i]).abs() < 1e-3);
                } else {
                    assert!((f[i] - values[i]).abs() < 6.0, "{x},{y}: {} vs {}", f[i], values[i]);
                }
            }
        }
    }

    #[test]
    fn constant_fill_is_exact() {
        let (w, h) = (37, 23);
        let values = vec![5.0f32; w * h];
        let mut weights = vec![0.0f32; w * h];
        weights[3] = 1.0;
        let f = push_pull(&values, &weights, w, h);
        assert!(f.iter().all(|v| (v - 5.0).abs() < 1e-3), "{f:?}");
    }

    #[test]
    fn upsample_weights_sum_up() {
        let mut taps = Vec::new();
        for (n, p) in [(10, 5), (11, 6), (2, 1), (1, 1)] {
            upsample_taps(&mut taps, n, p);
            assert_eq!(taps.len(), n);
            for &(a, b, f) in &taps {
                assert!(a < p && b < p && (0.0..=1.0).contains(&f));
            }
        }
    }

    #[test]
    fn reused_buffers_give_the_same_result() {
        let (w, h) = (53, 41);
        let mut pp = PushPull::new();
        for k in 0..3 {
            let values: Vec<f32> = (0..w * h).map(|i| ((i * 7 + k) % 97) as f32).collect();
            let weights: Vec<f32> = (0..w * h).map(|i| if (i / w + i % w + k) % 5 == 0 { 0.0 } else { 1.0 }).collect();
            let fresh = push_pull(&values, &weights, w, h);
            assert_eq!(pp.fill(&values, &weights, w, h), &fresh[..]);
            // another size in between
            let small = pp.fill(&values[..12], &weights[..12], 4, 3).to_vec();
            assert_eq!(small.len(), 12);
        }
    }

    #[test]
    fn spread_over_threads_it_is_the_same() {
        let workers = crate::tof::parallel::Workers::new(4);
        let mut pp = PushPull::new();
        for (w, h) in [(512, 424), (53, 41), (2, 1), (1, 7)] {
            let values: Vec<f32> = (0..w * h).map(|i| ((i * 7) % 97) as f32 * 1.5).collect();
            let weights: Vec<f32> = (0..w * h).map(|i| if (i / w + i % w) % 5 == 0 { 0.0 } else { 0.7 }).collect();
            let serial = pp.fill(&values, &weights, w, h).to_vec();
            assert_eq!(pp.fill_with(&values, &weights, w, h, &workers).unwrap(), &serial[..], "{w} x {h}");
        }
    }

    #[test]
    fn empty_input_is_harmless() {
        assert!(push_pull(&[], &[], 0, 0).is_empty());
        let f = push_pull(&[1.0; 12], &[0.0; 12], 4, 3);
        assert!(f.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn large_values_and_pixels_on_demand() {
        // infrared-like values above f16's range: scaled, not clipped
        let (w, h) = (40, 30);
        let values: Vec<f32> = (0..w * h).map(|i| 200_000.0 + (i % w) as f32 * 1000.0).collect();
        let mut weights = vec![1.0f32; w * h];
        weights[15 * w + 20] = 0.0;
        let f = push_pull(&values, &weights, w, h);
        let i = 15 * w + 20;
        assert!((f[i] - values[i]).abs() < 0.002 * values[i], "{} vs {}", f[i], values[i]);
        // the pyramid of a build answers single pixels like the whole fill
        let mut pp = PushPull::new();
        let input = |y: usize, v: &mut [f32], wt: &mut [f32]| {
            v.copy_from_slice(&values[y * w..(y + 1) * w]);
            wt.copy_from_slice(&weights[y * w..(y + 1) * w]);
        };
        pp.build(w, h, 1.0 / 16.0, &input, None).unwrap();
        assert!(pp.anchored());
        assert_eq!(pp.at(20, 15, values[i], 0.0), f[i]);
        let (mut row, mut tmp) = (vec![0.0; w], vec![0.0; w]);
        for y in [0, 15, h - 1] {
            pp.surroundings(y, &mut row, &mut tmp);
            for (x, r) in row.iter().enumerate() {
                assert_eq!(*r, pp.at(x, y, 123.0, 0.0), "{x} {y}");
            }
        }
        assert_eq!(pp.at(3, 4, values[4 * w + 3], 1.0), values[4 * w + 3]);
        // no weight anywhere: nothing to fill from
        pp.build(w, h, 1.0, &|_, v: &mut [f32], wt: &mut [f32]| {
            v.fill(7.0);
            wt.fill(0.0);
        }, None)
        .unwrap();
        assert!(!pp.anchored());
        assert_eq!(pp.at(5, 5, 7.0, 0.0), 0.0);
    }
}
