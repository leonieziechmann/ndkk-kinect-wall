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

/// Push-pull with its buffers kept between calls: once they have grown to the image size, a
/// fill allocates nothing.
#[derive(Clone, Debug, Default)]
pub struct PushPull {
    levels: Vec<Level>,
    out: Vec<f32>,
    tmp: Vec<f32>,
    upper: Vec<f32>,
    lower: Vec<f32>,
    tx: Vec<(usize, usize, f32)>,
    ty: Vec<(usize, usize, f32)>,
}

impl PushPull {
    /// Empty buffers (they grow with the first fill).
    pub fn new() -> PushPull {
        PushPull::default()
    }

    /// Level `i` with the size `w` x `h`, zeroed.
    fn level(&mut self, i: usize, w: usize, h: usize) -> Option<&mut Level> {
        if i == self.levels.len() {
            self.levels.push(Level::default());
        }
        let l = self.levels.get_mut(i)?;
        l.w = w;
        l.h = h;
        l.vw.clear();
        l.vw.resize(w * h, 0.0);
        l.wt.clear();
        l.wt.resize(w * h, 0.0);
        Some(l)
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
        if let Some(l0) = self.level(0, width, height) {
            for ((vw, wt), (v, w)) in l0.vw.iter_mut().zip(l0.wt.iter_mut()).zip(values.iter().zip(weights)) {
                let w = if w.is_finite() { w.clamp(0.0, 1.0) } else { 0.0 };
                *wt = w;
                *vw = if v.is_finite() { v * w } else { 0.0 };
            }
        }
        // push: halve until small
        let mut used = 1;
        while let Some(&Level { w, h, .. }) = self.levels.get(used - 1) {
            if (w <= 1 && h <= 1) || used >= 24 {
                break;
            }
            let (nw, nh) = (w.div_ceil(2), h.div_ceil(2));
            if self.level(used, nw, nh).is_none() {
                break;
            }
            let (done, rest) = self.levels.split_at_mut(used);
            let (Some(l), Some(next)) = (done.last(), rest.first_mut()) else { break };
            for (y, (vrow, wrow)) in l.vw.chunks_exact(l.w).zip(l.wt.chunks_exact(l.w)).enumerate() {
                let start = (y / 2) * nw;
                let (Some(dv), Some(dw)) = (next.vw.get_mut(start..start + nw), next.wt.get_mut(start..start + nw)) else { continue };
                for (x, (v, w)) in vrow.iter().zip(wrow).enumerate() {
                    if let (Some(a), Some(b)) = (dv.get_mut(x / 2), dw.get_mut(x / 2)) {
                        *a += v;
                        *b += w;
                    }
                }
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
            self.tmp.clear();
            self.tmp.resize(l.w * l.h, 0.0);
            self.upper.clear();
            self.upper.resize(l.w, 0.0);
            self.lower.clear();
            self.lower.resize(l.w, 0.0);
            let filled = &self.out;
            for (y, orow) in self.tmp.chunks_exact_mut(l.w).enumerate() {
                let (ya, yb, fy) = self.ty.get(y).copied().unwrap_or((0, 0, 0.0));
                let (Some(ra), Some(rb)) = (filled.get(ya * parent_w..(ya + 1) * parent_w), filled.get(yb * parent_w..(yb + 1) * parent_w)) else { continue };
                for (x, (u, d)) in self.upper.iter_mut().zip(self.lower.iter_mut()).enumerate() {
                    let (xa, xb, fx) = self.tx.get(x).copied().unwrap_or((0, 0, 0.0));
                    let (a0, a1) = (ra.get(xa).copied().unwrap_or(0.0), ra.get(xb).copied().unwrap_or(0.0));
                    let (b0, b1) = (rb.get(xa).copied().unwrap_or(0.0), rb.get(xb).copied().unwrap_or(0.0));
                    *u = a0 + (a1 - a0) * fx;
                    *d = b0 + (b1 - b0) * fx;
                }
                let (Some(vrow), Some(wrow)) = (l.vw.get(y * l.w..(y + 1) * l.w), l.wt.get(y * l.w..(y + 1) * l.w)) else { continue };
                for ((o, (u, d)), (v, w)) in orow.iter_mut().zip(self.upper.iter().zip(&self.lower)).zip(vrow.iter().zip(wrow)) {
                    let parent = u + (d - u) * fy;
                    *o = v + (1.0 - w) * parent;
                }
            }
            std::mem::swap(&mut self.out, &mut self.tmp);
            parent_w = l.w;
            parent_h = l.h;
        }
        &self.out
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
    fn empty_input_is_harmless() {
        assert!(push_pull(&[], &[], 0, 0).is_empty());
        let f = push_pull(&[1.0; 12], &[0.0; 12], 4, 3);
        assert!(f.iter().all(|v| v.is_finite()));
    }
}
