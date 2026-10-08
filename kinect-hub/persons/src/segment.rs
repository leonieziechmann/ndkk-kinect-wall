//! Step 3: segmentation, and step 4: background (persons-core.js, "3. segmentation" and
//! "4. background").

use crate::skeleton::{BEHIND, fit, seg};
use crate::tracker::{CAP, NJ, NP, PARTS, PersonTracker, Track};
use crate::{H, N, W, hypot2, jround};

/// learned background "nothing measured here": beyond the sensor's range, a window, black velvet.
/// Anything measured there is in front of it.
pub(crate) const FAR: u16 = 65535;

#[inline]
fn is(v: f32) -> bool {
    v != 0.0
}

/// Box around the body parts of a skeleton (x0, y0, z0, x1, y1, z1 in mm).
fn reach_box(t: &Track) -> [f64; 6] {
    let c = &t.capsules;
    let mut b = [f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for p in 0..NP {
        let o = CAP * p;
        if c[o + 8] == 0.0 {
            continue;
        }
        let r = c[o + 6].sqrt();
        for j in 0..3 {
            b[j] = b[j].min(c[o + j] - r).min(c[o + 3 + j] - r);
            b[3 + j] = b[3 + j].max(c[o + j] + r).max(c[o + 3 + j] + r);
        }
    }
    b
}

impl PersonTracker {
    /// Grows all `active` persons (indices into tracks, nearer first) in this depth frame at once;
    /// owner[i] = their index in `active`, -1 = nobody. Returns the number of person pixels.
    pub(crate) fn segment(&mut self, depth: &[u16], active: &[usize]) -> usize {
        let PersonTracker { options: o, rays, owner, part_of, queue, prev_uid, prev_list, prev_count, prev_depth, bg, uid_index: index, tracks, floor, .. } = self;
        let persons: Vec<&Track> = active.iter().map(|&i| &tracks[i]).collect();
        let (min_depth, max_depth) = (o.min_depth, o.max_depth);
        let (join_margin, join_slope, bg_margin, bg_slope) = (o.join_margin, o.join_slope, o.bg_margin, o.bg_slope);
        owner.fill(-1);
        let mut tail = 0_usize;
        let f = floor.as_ref();
        let (fx, fy, fz) = f.map_or((0.0, 0.0, 0.0), |f| (f.normal[0], f.normal[1], f.normal[2]));
        let fd = f.map_or(0.0, |f| (f.d - o.floor_clearance) * 1000.0);
        let has_floor = f.is_some();
        // the depth at a pixel moved less than this: still the same surface
        let same = |d: f64, e: f64| (d - e).abs() <= 60.0 + 0.03 * e;
        for (q, t) in persons.iter().enumerate() {
            index[t.uid as usize] = q as i8;
        }

        // where each person may grow: its skeleton and its last pixels, plus its reach
        let boxes: Vec<[i64; 4]> = persons
            .iter()
            .map(|t| {
                let (mut u0, mut v0, mut u1, mut v1, mut z) = (W as f64, H as f64, -1.0_f64, -1.0_f64, f64::INFINITY);
                for k in 0..NJ {
                    if !is(t.joints[4 * k + 3]) {
                        continue;
                    }
                    let (u, v) = (f64::from(t.uv[3 * k]), f64::from(t.uv[3 * k + 1]));
                    u0 = u0.min(u);
                    u1 = u1.max(u);
                    v0 = v0.min(v);
                    v1 = v1.max(v);
                    z = z.min(f64::from(t.joints[4 * k + 2]));
                }
                if t.pixels > 0
                    && let Some(b) = t.bbox
                {
                    u0 = u0.min(b[0]);
                    v0 = v0.min(b[1]);
                    u1 = u1.max(b[2]);
                    v1 = v1.max(b[3]);
                }
                let pad = ((o.reach + 0.25) * 1000.0 * 370.0 / z.max(500.0)).ceil() + 4.0;
                [
                    (u0 - pad).floor().max(0.0) as i64,
                    (v0 - pad).floor().max(0.0) as i64,
                    ((u1 + pad).ceil() as i64).min(W as i64 - 1),
                    ((v1 + pad).ceil() as i64).min(H as i64 - 1),
                ]
            })
            .collect();

        // a pixel inside a body part of another person (and none of its own) is that person's:
        // touching persons, an arm around someone's shoulder. Cheap first tests: boxes.
        let reach_boxes: Vec<[f64; 6]> = persons.iter().map(|t| reach_box(t)).collect();
        // only persons whose body parts lie within reach of q's can take pixels from q
        let near = o.reach * 1000.0;
        let others: Vec<Vec<usize>> = reach_boxes
            .iter()
            .enumerate()
            .map(|(q, a)| {
                reach_boxes
                    .iter()
                    .enumerate()
                    .filter(|&(r, b)| {
                        r != q
                            && b[0] < a[3] + near
                            && b[3] > a[0] - near
                            && b[1] < a[4] + near
                            && b[4] > a[1] - near
                            && b[2] < a[5] + near
                            && b[5] > a[2] - near
                    })
                    .map(|(r, _)| r)
                    .collect()
            })
            .collect();
        let foreign = |q: usize, x: f64, y: f64, z: f64| -> bool {
            for &r in &others[q] {
                let b = &reach_boxes[r];
                if x < b[0] || x > b[3] || y < b[1] || y > b[4] || z < b[2] || z > b[5] {
                    continue;
                }
                if fit(&persons[r].capsules, 0, x, y, z, true) < 0 {
                    continue;
                }
                return fit(&persons[q].capsules, 0, x, y, z, true) < 0;
            }
            false
        };

        // seeds 1: pixels along the bones that lie inside their body part (nearer persons first)
        // and are no one else's (someone whose surface is still there keeps it)
        for (q, t) in persons.iter().enumerate() {
            let c = &t.capsules;
            let uv = &t.uv;
            for (p, &(a, b, _)) in PARTS.iter().enumerate() {
                if c[CAP * p + 8] == 0.0 {
                    continue;
                }
                let (ua, va, ub, vb) = (f64::from(uv[3 * a]), f64::from(uv[3 * a + 1]), f64::from(uv[3 * b]), f64::from(uv[3 * b + 1]));
                let steps = (hypot2(ub - ua, vb - va) / 2.0).ceil().max(1.0);
                let mut s = 0.0;
                while s <= steps {
                    let u = jround(ua + (ub - ua) * s / steps);
                    let v = jround(va + (vb - va) * s / steps);
                    s += 1.0;
                    if u < 0.0 || v < 0.0 || u >= W as f64 || v >= H as f64 {
                        continue;
                    }
                    let i = v as usize * W + u as usize;
                    if owner[i] != -1 {
                        continue;
                    }
                    let d = f64::from(depth[i]);
                    if d < min_depth || d > max_depth {
                        continue;
                    }
                    let pu = prev_uid[i];
                    if pu != 0 && i32::from(pu) != t.uid && index[pu as usize] >= 0 && same(d, f64::from(prev_depth[i])) {
                        continue;
                    }
                    let bd = f64::from(bg[i]);
                    if bd != 0.0 && (d - bd).abs() <= bg_margin + bg_slope * bd {
                        continue;
                    }
                    let x = f64::from(rays[2 * i]) * d;
                    let y = f64::from(rays[2 * i + 1]) * d;
                    if has_floor && fx * x + fy * y + fz * d + fd < 0.0 {
                        continue;
                    }
                    let (d2, dz) = seg(c, p, x, y, d);
                    if d2 > c[CAP * p + 6] || dz > BEHIND {
                        continue;
                    }
                    owner[i] = q as i8;
                    part_of[i] = p as u8;
                    queue[tail] = i as i32;
                    tail += 1;
                }
            }
        }
        // seeds 2: the persons' pixels of the previous frame where the surface is still there,
        // within the box around the person's reach
        let wide: Vec<[f64; 6]> = reach_boxes.iter().map(|b| [b[0] - near, b[1] - near, b[2] - near, b[3] + near, b[4] + near, b[5] + near]).collect();
        for &pi in &prev_list[..*prev_count] {
            let i = pi as usize;
            if owner[i] != -1 {
                continue;
            }
            let qi = index[prev_uid[i] as usize];
            if qi < 0 {
                continue;
            }
            let q = qi as usize;
            let d = f64::from(depth[i]);
            let e = f64::from(prev_depth[i]);
            if d < min_depth || d > max_depth || (d - e).abs() > 60.0 + 0.03 * e {
                continue;
            }
            let bd = f64::from(bg[i]);
            if bd != 0.0 && (d - bd).abs() <= bg_margin + bg_slope * bd {
                continue;
            }
            let x = f64::from(rays[2 * i]) * d;
            let y = f64::from(rays[2 * i + 1]) * d;
            if has_floor && fx * x + fy * y + fz * d + fd < 0.0 {
                continue;
            }
            let wb = &wide[q];
            if x < wb[0] || x > wb[3] || y < wb[1] || y > wb[4] || d < wb[2] || d > wb[5] {
                continue;
            }
            if !others[q].is_empty() && foreign(q, x, y, d) {
                continue;
            }
            owner[i] = q as i8;
            queue[tail] = i as i32;
            tail += 1;
        }

        // grow all persons at once (breadth first): connected without depth jumps, no background,
        // within reach of the skeleton; where the background is unknown, inside a body part
        let mut head = 0;
        while head < tail {
            let i = queue[head] as usize;
            head += 1;
            let q = owner[i] as usize;
            let di = f64::from(depth[i]);
            let tol = join_margin + join_slope * di;
            let t = persons[q];
            let c = &t.capsules;
            let uid = t.uid;
            let bx = &boxes[q];
            let v = i / W;
            let u = i - v * W;
            for n in 0..4 {
                let jj = match n {
                    0 if u as i64 > bx[0] => i - 1,
                    1 if (u as i64) < bx[2] => i + 1,
                    2 if v as i64 > bx[1] => i - W,
                    3 if (v as i64) < bx[3] => i + W,
                    _ => continue,
                };
                if owner[jj] != -1 {
                    continue;
                }
                let dj = f64::from(depth[jj]);
                if dj < min_depth || dj > max_depth || dj - di > tol || di - dj > tol {
                    continue;
                }
                let bd = bg[jj];
                let bdf = f64::from(bd);
                if bd != 0 && (dj - bdf).abs() <= bg_margin + bg_slope * bdf {
                    continue;
                }
                let x = f64::from(rays[2 * jj]) * dj;
                let y = f64::from(rays[2 * jj + 1]) * dj;
                if has_floor && fx * x + fy * y + fz * dj + fd < 0.0 {
                    continue; // on the floor
                }
                let p = fit(c, i32::from(part_of[i]), x, y, dj, bd == 0 && i32::from(prev_uid[jj]) != uid);
                if p < 0 || (!others[q].is_empty() && foreign(q, x, y, dj)) {
                    continue;
                }
                owner[jj] = q as i8;
                part_of[jj] = p as u8;
                queue[tail] = jj as i32;
                tail += 1;
            }
        }
        for t in &persons {
            index[t.uid as usize] = -1;
        }
        tail
    }

    /// near_person = 1 inside the persons' boxes (with a margin): skeleton mode keeps them out of
    /// the floor estimate.
    pub(crate) fn person_boxes(&mut self) {
        self.near_person.fill(0);
        for t in &self.tracks {
            let (Some(b), Some(pos)) = (t.bbox, t.pos) else { continue };
            mark_box(&mut self.near_person, b, pos[2]);
        }
    }

    /// Learns the background where no person is: what stays in place. Close to a person, an
    /// unknown background takes as long as something new (the person's sleeve or dress that the
    /// segmentation missed must not become background while they stand still).
    pub(crate) fn learn(&mut self, depth: &[u16], active: &[usize]) {
        let PersonTracker { options: o, rays, owner, prev_depth: prev, near_person: near, bg, bg_cand: cand, bg_count: count, still, tracks, frame, .. } = self;
        let (bg_margin, bg_slope) = (o.bg_margin, o.bg_slope);
        // every pixel is visited every second frame (half the work): counts are in visits
        let still_frames = jround(o.static_seconds * o.fps / 2.0);
        let learn_v = (o.learn_frames / 2.0).ceil();
        let far_v = (o.far_frames / 2.0).ceil();
        let near_v = (o.near_frames / 2.0).ceil();
        near.fill(0);
        for t in tracks.iter() {
            if t.pixels == 0 {
                continue;
            }
            let (Some(b), Some(pos)) = (t.bbox, t.pos) else { continue };
            mark_box(near, b, pos[2]);
        }
        let mut i = (*frame & 1) as usize;
        while i < N {
            let q = owner[i];
            if q != -1 {
                count[i] = 0;
                // a person's pixel that has not moved for long: if it lies outside the person's
                // body parts it is a thing the person touched, learned as background
                let dp = depth[i];
                let e = prev[i];
                if q < 0 || dp == 0 || e == 0 {
                    i += 2;
                    continue; // no measurement: the count waits
                }
                let (dpf, ef) = (f64::from(dp), f64::from(e));
                if (dpf - ef).abs() > 20.0 + 0.01 * ef {
                    still[i] = 0;
                    i += 2;
                    continue;
                }
                still[i] = still[i].wrapping_add(1);
                if f64::from(still[i]) < still_frames {
                    i += 2;
                    continue;
                }
                still[i] = 0;
                let t = &tracks[active[q as usize]];
                if fit(&t.capsules, 0, f64::from(rays[2 * i]) * dpf, f64::from(rays[2 * i + 1]) * dpf, dpf, true) < 0 {
                    bg[i] = dp;
                }
                i += 2;
                continue;
            }
            let d = if depth[i] != 0 { depth[i] } else { FAR };
            let b = bg[i];
            let (df, bf) = (f64::from(d), f64::from(b));
            if b != 0 && (df - bf).abs() <= bg_margin + bg_slope * bf {
                if b != FAR {
                    bg[i] = (bf + jround((df - bf) / 8.0)) as u16;
                }
                count[i] = 0;
                i += 2;
                continue;
            }
            let c = cand[i];
            let cf = f64::from(c);
            let n = count[i];
            if n != 0 && (df - cf).abs() <= bg_margin + bg_slope * cf {
                if n < 255 {
                    count[i] = n + 1;
                }
            } else if n > 2 {
                count[i] = n - 2;
            } else {
                cand[i] = d;
                count[i] = 1;
            }
            // a surface that stops answering may just be noisy: as slow as something new
            let need = if b == 0 {
                if near[i] != 0 { near_v } else { learn_v }
            } else if cand[i] == FAR || cand[i] < b {
                near_v
            } else {
                far_v
            };
            if f64::from(count[i]) >= need {
                bg[i] = cand[i];
                count[i] = 0;
            }
            i += 2;
        }
    }
}

/// Marks a person's box (with a margin of 25 cm at its depth) in a per-pixel map.
fn mark_box(map: &mut [u8], b: [f64; 4], z: f64) {
    let pad = (250.0 * 370.0 / z.max(500.0)).ceil();
    let u0 = (b[0] - pad).max(0.0) as usize;
    let u1 = (b[2] + pad).min((W - 1) as f64) as usize;
    let v0 = (b[1] - pad).max(0.0) as usize;
    let v1 = (b[3] + pad).min((H - 1) as f64) as usize;
    for v in v0..=v1 {
        map[v * W + u0..=v * W + u1].fill(1);
    }
}
