//! Push-pull filling: missing values of an image are interpolated smoothly from what is there,
//! over any distance (used for clipped infrared, inside saturated areas, and as the depth
//! expectation of the resolver). O(pixels), about a millisecond for the whole image.

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
        for (pair, win) in rest.chunks_exact_mut(2).zip(parent.windows(3)) {
            if let ([e, o], [a, b, c]) = (pair, win) {
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

    /// Fills pixels with weight 0 (or small weights) from the weighted values around them.
    /// `values` and `weights` are `width * height`; weights are clamped to 0..1. Pixels with
    /// weight 1 keep their value. The result lives until the next call.
    pub fn fill(&mut self, values: &[f32], weights: &[f32], width: usize, height: usize) -> &[f32] {
        let n = width * height;
        if values.len() < n || weights.len() < n || n == 0 {
            self.out.clear();
            self.out.extend_from_slice(values);
            return &self.out;
        }
        if self.levels.is_empty() {
            self.levels.push(Level::default());
        }
        if let Some(l0) = self.levels.first_mut() {
            l0.w = width;
            l0.h = height;
            l0.wt.clear();
            l0.wt.extend(weights.iter().take(n).map(|w| if w.is_finite() { w.clamp(0.0, 1.0) } else { 0.0 }));
            l0.vw.clear();
            l0.vw.extend(values.iter().zip(&l0.wt).map(|(v, w)| if v.is_finite() { v * w } else { 0.0 }));
        }
        // push: halve until small (each pixel of the next level sums its 2 x 2 children)
        let mut used = 1;
        while let Some(&Level { w, h, .. }) = self.levels.get(used - 1) {
            if (w <= 1 && h <= 1) || used >= 24 {
                break;
            }
            let (nw, nh) = (w.div_ceil(2), h.div_ceil(2));
            if used == self.levels.len() {
                self.levels.push(Level::default());
            }
            let (done, rest) = self.levels.split_at_mut(used);
            let (Some(l), Some(next)) = (done.last(), rest.first_mut()) else { break };
            next.w = nw;
            next.h = nh;
            next.vw.clear();
            next.wt.clear();
            for y in 0..nh {
                let (v0, v1, w0, w1) = (level_row(&l.vw, w, h, 2 * y), level_row(&l.vw, w, h, 2 * y + 1), level_row(&l.wt, w, h, 2 * y), level_row(&l.wt, w, h, 2 * y + 1));
                push_row(v0, v1, nw, &mut next.vw);
                push_row(w0, w1, nw, &mut next.wt);
            }
            // average, keep the confidence saturating at 1
            for (v, t) in next.vw.iter_mut().zip(next.wt.iter_mut()) {
                if *t > 0.0 {
                    let c = t.min(1.0);
                    *v = *v / *t * c;
                    *t = c;
                }
            }
            used += 1;
        }
        // pull: from the coarsest level down, what is missing comes from the level above
        let Some(top) = self.levels.get(used - 1) else {
            self.out.clear();
            self.out.extend_from_slice(values);
            return &self.out;
        };
        self.out.clear();
        self.out.extend(top.vw.iter().zip(&top.wt).map(|(v, w)| if *w > 0.0 { v / w } else { 0.0 }));
        let (mut parent_w, mut parent_h) = (top.w, top.h);
        for li in (0..used - 1).rev() {
            let Some(l) = self.levels.get(li) else { break };
            upsample_taps(&mut self.tx, l.w, parent_w);
            upsample_taps(&mut self.ty, l.h, parent_h);
            // every parent row upsampled horizontally once
            self.wide.clear();
            self.wide.resize(l.w * parent_h, 0.0);
            for (prow, wrow) in self.out.chunks_exact(parent_w).zip(self.wide.chunks_exact_mut(l.w)) {
                upsample_row(prow, wrow, &self.tx);
            }
            self.tmp.clear();
            for y in 0..l.h {
                let (ya, yb, fy) = self.ty.get(y).copied().unwrap_or((0, 0, 0.0));
                let wrow = |r: usize| self.wide.get(r * l.w..(r + 1) * l.w).unwrap_or(&[]);
                let (ra, rb) = (wrow(ya), wrow(yb));
                let (Some(vrow), Some(trow)) = (l.vw.get(y * l.w..(y + 1) * l.w), l.wt.get(y * l.w..(y + 1) * l.w)) else { break };
                self.tmp.extend(ra.iter().zip(rb).zip(vrow.iter().zip(trow)).map(|((u, d), (v, w))| {
                    let parent = u + (d - u) * fy;
                    v + (1.0 - w) * parent
                }));
            }
            self.tmp.resize(l.w * l.h, 0.0);
            std::mem::swap(&mut self.out, &mut self.tmp);
            parent_w = l.w;
            parent_h = l.h;
        }
        &self.out
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
    let p0 = r0.chunks_exact(2);
    if r1.len() == r0.len() {
        out.extend(p0.zip(r1.chunks_exact(2)).map(|(a, b)| match (a, b) {
            ([a0, a1], [b0, b1]) => a0 + a1 + b0 + b1,
            _ => 0.0,
        }));
    } else {
        out.extend(p0.map(|a| match a {
            [a0, a1] => a0 + a1,
            _ => 0.0,
        }));
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
    fn empty_input_is_harmless() {
        assert!(push_pull(&[], &[], 0, 0).is_empty());
        let f = push_pull(&[1.0; 12], &[0.0; 12], 4, 3);
        assert!(f.iter().all(|v| v.is_finite()));
    }
}
