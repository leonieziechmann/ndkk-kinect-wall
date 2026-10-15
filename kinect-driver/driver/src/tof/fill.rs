//! Push-pull filling: missing values of an image are interpolated smoothly from what is there,
//! over any distance (used for clipped infrared, inside saturated areas, and as the depth
//! expectation of the resolver). O(pixels), about a millisecond for the whole image on one
//! thread.

use super::parallel::Workers;
use crate::error::Result;

/// One pyramid level: premultiplied values and weights (0..1).
#[derive(Clone, Debug, Default)]
struct Level {
    w: usize,
    h: usize,
    vw: Vec<f32>,
    wt: Vec<f32>,
}

/// For each output coordinate of a level, the two parent coordinates and the weight of the
/// second (bilinear upsampling by 2: weights 0.75 / 0.25 alternate).
fn upsample_taps(taps: &mut Vec<(usize, usize, f32)>, n: usize, parent: usize) {
    taps.clear();
    let last = parent.saturating_sub(1);
    taps.extend((0..n).map(|x| {
        if x % 2 == 0 {
            // center at x/2 - 0.25: between x/2 - 1 (0.25) and x/2 (0.75)
            let b = (x / 2).min(last);
            let a = b.saturating_sub(1);
            (a, b, 0.75)
        } else {
            // center at (x-1)/2 + 0.25: between (x-1)/2 (0.75) and (x+1)/2 (0.25)
            let a = (x / 2).min(last);
            let b = (a + 1).min(last);
            (a, b, 0.25)
        }
    }));
}

/// One parent row upsampled to `out.len()` columns with the taps of [`upsample_taps`]: the
/// border pixels with the general rule, the rest pairwise from three neighbors (vectorizes).
fn upsample_row(parent: &[f32], out: &mut [f32], taps: &[(usize, usize, f32)]) {
    let lerp = |a: f32, b: f32, f: f32| a + (b - a) * f;
    let n = out.len();
    // pairs (2i, 2i + 1) for 1 <= i <= parent.len() - 2 read parent[i - 1 ..= i + 1] unclamped
    let inner = parent.len().saturating_sub(2).min(n.saturating_sub(2) / 2);
    if let Some(rest) = out.get_mut(2..2 + 2 * inner) {
        for ([e, o], win) in rest.as_chunks_mut::<2>().0.iter_mut().zip(parent.windows(3)) {
            if let [a, b, c] = win {
                *e = lerp(*a, *b, 0.75);
                *o = lerp(*b, *c, 0.25);
            }
        }
    }
    for x in (0..n.min(2)).chain(2 + 2 * inner..n) {
        let (xa, xb, fx) = taps.get(x).copied().unwrap_or((0, 0, 0.0));
        if let (Some(o), Some(a), Some(b)) = (out.get_mut(x), parent.get(xa), parent.get(xb)) {
            *o = lerp(*a, *b, fx);
        }
    }
}

/// Push-pull with its buffers kept between calls: once they have grown to the image size, a
/// fill allocates nothing.
#[derive(Clone, Debug, Default)]
pub struct PushPull {
    levels: Vec<Level>,
    out: Vec<f32>,
    tmp: Vec<f32>,
    /// the filled parent level, upsampled horizontally (one row per parent row)
    wide: Vec<f32>,
    tx: Vec<(usize, usize, f32)>,
    ty: Vec<(usize, usize, f32)>,
}

impl PushPull {
    /// Empty buffers (they grow with the first fill).
    pub fn new() -> PushPull {
        PushPull::default()
    }

    /// The result of the last [`PushPull::fill`].
    pub fn result(&self) -> &[f32] {
        &self.out
    }

    /// Fills pixels with weight 0 (or small weights) from the weighted values around them.
    /// `values` and `weights` are `width * height`; weights are clamped to 0..1. Pixels with
    /// weight 1 keep their value. The result lives until the next call.
    pub fn fill(&mut self, values: &[f32], weights: &[f32], width: usize, height: usize) -> &[f32] {
        // run serially, nothing can fail
        let _ = self.run(values, weights, width, height, None);
        &self.out
    }

    /// [`PushPull::fill`] with the work at full resolution (most of it) spread over `workers`;
    /// the same result. Fails only if a worker panicked.
    pub fn fill_with(&mut self, values: &[f32], weights: &[f32], width: usize, height: usize, workers: &Workers) -> Result<&[f32]> {
        self.run(values, weights, width, height, Some(workers))?;
        Ok(&self.out)
    }

    fn run(&mut self, values: &[f32], weights: &[f32], width: usize, height: usize, workers: Option<&Workers>) -> Result<()> {
        let n = width * height;
        let (Some(values), Some(weights)) = (values.get(..n), weights.get(..n)) else {
            self.out.clear();
            self.out.extend_from_slice(values);
            return Ok(());
        };
        if n == 0 || (width <= 1 && height <= 1) {
            self.out.clear();
            self.out.extend(values.iter().zip(weights).map(|(v, w)| {
                let (v, w) = level0(*v, *w);
                if w > 0.0 { v / w } else { 0.0 }
            }));
            return Ok(());
        }
        // level 0 is the input itself, read where it is needed (never stored: at full
        // resolution that would be the bulk of the memory traffic); `levels` holds level 1 up
        let mut used = 0;
        let (mut w, mut h) = (width, height);
        while !(w <= 1 && h <= 1) && used < 23 {
            let (nw, nh) = (w.div_ceil(2), h.div_ceil(2));
            if used == self.levels.len() {
                self.levels.push(Level::default());
            }
            let (done, rest) = self.levels.split_at_mut(used);
            let Some(next) = rest.first_mut() else { break };
            next.w = nw;
            next.h = nh;
            match done.last() {
                // each pixel of level 1 sums its 2 x 2 children of the input
                None => {
                    next.vw.resize(nw * nh, 0.0);
                    next.wt.resize(nw * nh, 0.0);
                    let blocks = next.vw.chunks_mut(nw * BLOCK_ROWS).zip(next.wt.chunks_mut(nw * BLOCK_ROWS)).enumerate();
                    rows(workers, blocks, &|(b, (vw, wt)): (usize, (&mut [f32], &mut [f32]))| {
                        for (r, (vrow, wrow)) in vw.chunks_mut(nw).zip(wt.chunks_mut(nw)).enumerate() {
                            push_input_row(values, weights, width, height, b * BLOCK_ROWS + r, vrow, wrow);
                        }
                    })?;
                }
                Some(l) => {
                    next.vw.clear();
                    next.wt.clear();
                    for y in 0..nh {
                        let (v0, v1, w0, w1) = (level_row(&l.vw, w, h, 2 * y), level_row(&l.vw, w, h, 2 * y + 1), level_row(&l.wt, w, h, 2 * y), level_row(&l.wt, w, h, 2 * y + 1));
                        push_row(v0, v1, nw, &mut next.vw);
                        push_row(w0, w1, nw, &mut next.wt);
                    }
                    normalize(&mut next.vw, &mut next.wt);
                }
            }
            (w, h) = (nw, nh);
            used += 1;
        }
        // pull: from the coarsest level down, what is missing comes from the level above
        let Some(top) = used.checked_sub(1).and_then(|i| self.levels.get(i)) else {
            self.out.clear();
            self.out.extend_from_slice(values);
            return Ok(());
        };
        self.out.clear();
        self.out.extend(top.vw.iter().zip(&top.wt).map(|(v, w)| if *w > 0.0 { v / w } else { 0.0 }));
        let (mut parent_w, mut parent_h) = (top.w, top.h);
        for li in (1..used).rev() {
            let Some(l) = self.levels.get(li - 1) else { break };
            let (lw, lh) = (l.w, l.h);
            upsample_taps(&mut self.tx, lw, parent_w);
            upsample_taps(&mut self.ty, lh, parent_h);
            // every parent row upsampled horizontally once
            self.wide.clear();
            self.wide.resize(lw * parent_h, 0.0);
            for (prow, wrow) in self.out.chunks_exact(parent_w).zip(self.wide.chunks_exact_mut(lw)) {
                upsample_row(prow, wrow, &self.tx);
            }
            self.tmp.clear();
            for y in 0..lh {
                let (ya, yb, fy) = self.ty.get(y).copied().unwrap_or((0, 0, 0.0));
                let wrow = |r: usize| self.wide.get(r * lw..(r + 1) * lw).unwrap_or(&[]);
                let (ra, rb) = (wrow(ya), wrow(yb));
                let (vrow, trow) = (l.vw.get(y * lw..(y + 1) * lw).unwrap_or(&[]), l.wt.get(y * lw..(y + 1) * lw).unwrap_or(&[]));
                self.tmp.extend(ra.iter().zip(rb).zip(vrow.iter().zip(trow)).map(|((u, d), (v, w))| {
                    let parent = u + (d - u) * fy;
                    v + (1.0 - w) * parent
                }));
            }
            self.tmp.resize(lw * lh, 0.0);
            std::mem::swap(&mut self.out, &mut self.tmp);
            parent_w = lw;
            parent_h = lh;
        }
        // the last step, to the input's resolution
        upsample_taps(&mut self.tx, width, parent_w);
        upsample_taps(&mut self.ty, height, parent_h);
        self.wide.clear();
        self.wide.resize(width * parent_h, 0.0);
        let (parent, tx) = (&self.out, &self.tx);
        let blocks = self.wide.chunks_mut(width * BLOCK_ROWS).zip(parent.chunks(parent_w * BLOCK_ROWS));
        rows(workers, blocks, &|(wrows, prows): (&mut [f32], &[f32])| {
            for (wrow, prow) in wrows.chunks_mut(width).zip(prows.chunks(parent_w)) {
                upsample_row(prow, wrow, tx);
            }
        })?;
        self.tmp.clear();
        self.tmp.resize(n, 0.0);
        let (wide, ty) = (&self.wide, &self.ty);
        let blocks = self.tmp.chunks_mut(width * BLOCK_ROWS).enumerate();
        rows(workers, blocks, &|(b, orows): (usize, &mut [f32])| {
            for (r, orow) in orows.chunks_mut(width).enumerate() {
                let y = b * BLOCK_ROWS + r;
                let (ya, yb, fy) = ty.get(y).copied().unwrap_or((0, 0, 0.0));
                let wrow = |r: usize| wide.get(r * width..(r + 1) * width).unwrap_or(&[]);
                pull_input_row(level_row(values, width, height, y), level_row(weights, width, height, y), wrow(ya), wrow(yb), fy, orow);
            }
        })?;
        std::mem::swap(&mut self.out, &mut self.tmp);
        Ok(())
    }
}

/// Rows of a level per work item of [`PushPull::fill_with`].
const BLOCK_ROWS: usize = 8;

/// `f` over `items`, on `workers` if there are any.
fn rows<T: Send>(workers: Option<&Workers>, items: impl Iterator<Item = T> + Send, f: &(dyn Fn(T) + Sync)) -> Result<()> {
    match workers {
        Some(w) => w.for_each(items, f),
        None => {
            items.for_each(f);
            Ok(())
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

/// Row `y` of level 1 from the input (the sums of 2 x 2 children, in the order of
/// [`push_row`]), averaged as [`normalize`] does.
fn push_input_row(values: &[f32], weights: &[f32], width: usize, height: usize, y: usize, vw: &mut [f32], wt: &mut [f32]) {
    let row = |a, yy| level_row(a, width, height, yy);
    let (v0, w0, v1, w1) = (row(values, 2 * y), row(weights, 2 * y), row(values, 2 * y + 1), row(weights, 2 * y + 1));
    let two_rows = v1.len() == v0.len();
    let at = |a: &[f32], x: usize| a.get(x).copied().unwrap_or(0.0);
    for (x, (ov, ow)) in vw.iter_mut().zip(wt.iter_mut()).enumerate().take(width / 2) {
        let ((va, wa), (vb, wb)) = (level0(at(v0, 2 * x), at(w0, 2 * x)), level0(at(v0, 2 * x + 1), at(w0, 2 * x + 1)));
        let (sv, sw) = if two_rows {
            let ((vc, wc), (vd, wd)) = (level0(at(v1, 2 * x), at(w1, 2 * x)), level0(at(v1, 2 * x + 1), at(w1, 2 * x + 1)));
            (va + vb + vc + vd, wa + wb + wc + wd)
        } else {
            (va + vb, wa + wb)
        };
        (*ov, *ow) = average(sv, sw);
    }
    if width % 2 == 1 {
        let last = width - 1;
        let (va, wa) = level0(at(v0, last), at(w0, last));
        let (vc, wc) = if two_rows { level0(at(v1, last), at(w1, last)) } else { (0.0, 0.0) };
        if let (Some(ov), Some(ow)) = (vw.get_mut(width / 2), wt.get_mut(width / 2)) {
            (*ov, *ow) = average(va + vc, wa + wc);
        }
    }
}

/// The last pull: a row of the result at the input's resolution, from the input row and the
/// upsampled parent rows above and below.
fn pull_input_row(values: &[f32], weights: &[f32], ra: &[f32], rb: &[f32], fy: f32, out: &mut [f32]) {
    for ((o, (v, w)), (u, d)) in out.iter_mut().zip(values.iter().zip(weights)).zip(ra.iter().zip(rb)) {
        let (v, w) = level0(*v, *w);
        let parent = u + (d - u) * fy;
        *o = v + (1.0 - w) * parent;
    }
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

/// [`average`] over a level.
fn normalize(vw: &mut [f32], wt: &mut [f32]) {
    for (v, t) in vw.iter_mut().zip(wt.iter_mut()) {
        (*v, *t) = average(*v, *t);
    }
}

/// Row `y` of a `w` x `h` level (empty below the last row).
fn level_row(buf: &[f32], w: usize, h: usize, y: usize) -> &[f32] {
    if y < h { buf.get(y * w..(y + 1) * w).unwrap_or(&[]) } else { &[] }
}

/// Appends to `out` one row of the next pyramid level: `nw` sums of 2 x 2 children from the
/// rows `r0` and `r1` (`r1` empty below the last row; a last odd column has one child per
/// row). The order of the sums is that of adding the children row by row.
fn push_row(r0: &[f32], r1: &[f32], nw: usize, out: &mut Vec<f32>) {
    let start = out.len();
    let pairs = r0.len() / 2;
    let p0 = r0.as_chunks::<2>().0.iter();
    if r1.len() == r0.len() {
        out.extend(p0.zip(r1.as_chunks::<2>().0).map(|([a0, a1], [b0, b1])| a0 + a1 + b0 + b1));
    } else {
        out.extend(p0.map(|[a0, a1]| a0 + a1));
    }
    if r0.len() % 2 == 1 {
        let last = r0.last().copied().unwrap_or(0.0) + if r1.len() == r0.len() { r1.last().copied().unwrap_or(0.0) } else { 0.0 };
        out.push(last);
    }
    // (rows of the expected width only; anything else pads with zeros)
    out.resize(start + nw.max(pairs), 0.0);
    out.truncate(start + nw);
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
}
