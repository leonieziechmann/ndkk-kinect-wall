//! Push-pull filling: missing values of an image are interpolated smoothly from what is there,
//! over any distance (used for clipped infrared, inside saturated areas, and as the depth
//! expectation of the resolver). O(pixels), about a millisecond for the whole image.

/// One pyramid level: premultiplied values and weights (0..1).
struct Level {
    w: usize,
    h: usize,
    vw: Vec<f32>,
    wt: Vec<f32>,
}

/// For each output coordinate of a level, the two parent coordinates and the weight of the
/// second (bilinear upsampling by 2: weights 0.75 / 0.25 alternate).
fn upsample_taps(n: usize, parent: usize) -> Vec<(usize, usize, f32)> {
    (0..n)
        .map(|x| {
            let last = parent.saturating_sub(1);
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
        })
        .collect()
}

/// Fills pixels with weight 0 (or small weights) from the weighted values around them.
/// `values` and `weights` are `width * height`; weights are clamped to 0..1. Pixels with weight 1
/// keep their value.
pub fn push_pull(values: &[f32], weights: &[f32], width: usize, height: usize) -> Vec<f32> {
    let n = width * height;
    if values.len() < n || weights.len() < n || n == 0 {
        return values.to_vec();
    }
    let wt: Vec<f32> = weights.iter().take(n).map(|w| if w.is_finite() { w.clamp(0.0, 1.0) } else { 0.0 }).collect();
    let vw: Vec<f32> = values.iter().zip(&wt).map(|(v, w)| if v.is_finite() { v * w } else { 0.0 }).collect();
    let mut levels = vec![Level { w: width, h: height, vw, wt }];
    // push: halve until small
    while let Some(l) = levels.last() {
        if (l.w <= 1 && l.h <= 1) || levels.len() >= 24 {
            break;
        }
        let (nw, nh) = (l.w.div_ceil(2), l.h.div_ceil(2));
        let mut nvw = vec![0f32; nw * nh];
        let mut nwt = vec![0f32; nw * nh];
        for (y, (vrow, wrow)) in l.vw.chunks_exact(l.w).zip(l.wt.chunks_exact(l.w)).enumerate() {
            let start = (y / 2) * nw;
            let (Some(dv), Some(dw)) = (nvw.get_mut(start..start + nw), nwt.get_mut(start..start + nw)) else { continue };
            for (x, (v, w)) in vrow.iter().zip(wrow).enumerate() {
                if let (Some(a), Some(b)) = (dv.get_mut(x / 2), dw.get_mut(x / 2)) {
                    *a += v;
                    *b += w;
                }
            }
        }
        // average, keep the confidence saturating at 1
        for (v, t) in nvw.iter_mut().zip(nwt.iter_mut()) {
            if *t > 0.0 {
                let c = t.min(1.0);
                *v = *v / *t * c;
                *t = c;
            }
        }
        levels.push(Level { w: nw, h: nh, vw: nvw, wt: nwt });
    }
    // pull: from the coarsest level down, what is missing comes from the level above
    let Some(top) = levels.last() else { return values.to_vec() };
    let mut filled: Vec<f32> = top.vw.iter().zip(&top.wt).map(|(v, w)| if *w > 0.0 { v / w } else { 0.0 }).collect();
    let mut parent_w = top.w;
    let mut parent_h = top.h;
    for l in levels.iter().rev().skip(1) {
        let tx = upsample_taps(l.w, parent_w);
        let ty = upsample_taps(l.h, parent_h);
        let mut out = vec![0f32; l.w * l.h];
        let mut upper = vec![0f32; l.w];
        let mut lower = vec![0f32; l.w];
        for (y, orow) in out.chunks_exact_mut(l.w).enumerate() {
            let (ya, yb, fy) = ty.get(y).copied().unwrap_or((0, 0, 0.0));
            let (Some(ra), Some(rb)) = (filled.get(ya * parent_w..(ya + 1) * parent_w), filled.get(yb * parent_w..(yb + 1) * parent_w)) else { continue };
            for (x, (u, d)) in upper.iter_mut().zip(lower.iter_mut()).enumerate() {
                let (xa, xb, fx) = tx.get(x).copied().unwrap_or((0, 0, 0.0));
                let (a0, a1) = (ra.get(xa).copied().unwrap_or(0.0), ra.get(xb).copied().unwrap_or(0.0));
                let (b0, b1) = (rb.get(xa).copied().unwrap_or(0.0), rb.get(xb).copied().unwrap_or(0.0));
                *u = a0 + (a1 - a0) * fx;
                *d = b0 + (b1 - b0) * fx;
            }
            let (Some(vrow), Some(wrow)) = (l.vw.get(y * l.w..(y + 1) * l.w), l.wt.get(y * l.w..(y + 1) * l.w)) else { continue };
            for ((o, (u, d)), (v, w)) in orow.iter_mut().zip(upper.iter().zip(&lower)).zip(vrow.iter().zip(wrow)) {
                let parent = u + (d - u) * fy;
                *o = v + (1.0 - w) * parent;
            }
        }
        filled = out;
        parent_w = l.w;
        parent_h = l.h;
    }
    filled
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
        for (n, p) in [(10, 5), (11, 6), (2, 1), (1, 1)] {
            for (a, b, f) in upsample_taps(n, p) {
                assert!(a < p && b < p && (0.0..=1.0).contains(&f));
            }
        }
    }

    #[test]
    fn empty_input_is_harmless() {
        assert!(push_pull(&[], &[], 0, 0).is_empty());
        let f = push_pull(&[1.0; 12], &[0.0; 12], 4, 3);
        assert!(f.iter().all(|v| v.is_finite()));
    }
}
