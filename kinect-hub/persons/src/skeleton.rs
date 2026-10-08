//! Step 2: the skeleton in 3D (persons-core.js, "2. skeleton in 3D"), and the body part capsules.

use crate::tracker::{CAP, Capsules, HC, HEAD, Joints, LH, MAX_LOST, NJ, NP, PARTS, PersonTracker, RH, SC, Steady, Track, Uvs};
use crate::{H, Options, W, hypot3, jround};

/// how far a joint center lies behind the visible surface where the keypoint is seen (m)
pub(crate) const INSET: [f64; 17] = [0.07, 0.07, 0.07, 0.07, 0.07, 0.05, 0.05, 0.035, 0.035, 0.03, 0.03, 0.07, 0.07, 0.05, 0.05, 0.04, 0.04];
/// mm: a keypoint this far in front of the person's joints of a moment ago is hidden
const HIDDEN: f64 = 800.0;
/// limb bones (parent, child) and their typical length (mm, joint center to joint center)
pub(crate) const LIMBS: [(usize, usize); 8] = [(5, 7), (7, 9), (6, 8), (8, 10), (11, 13), (13, 15), (12, 14), (14, 16)];
pub(crate) const LIMB_LENGTHS: [f32; 8] = [290.0, 250.0, 290.0, 250.0, 430.0, 420.0, 430.0, 420.0];
/// arms (elbow, wrist, hand): their depth is measured on the person's own pixels, a window of this
/// many pixels around them
pub(crate) const ARM_WINDOW: i64 = 5;
/// mm: the hand point lies this far behind the surface it is seen on
pub(crate) const HAND_INSET: f64 = 30.0;
/// mm: how far behind its bone a pixel of a body may lie (the far rim of a limb)
pub(crate) const BEHIND: f64 = 70.0;
/// the JavaScript's `window` (a Float32Array of 169): writes beyond it are dropped
const WINDOW: usize = 169;

/// Whose a pixel is: the uids of a frame (Int16Array) or the slots of its labels (Uint8Array).
pub(crate) enum UidMap<'a> {
    Uid(&'a [i16]),
    Labels(&'a [u8]),
}

impl UidMap<'_> {
    #[inline]
    pub fn at(&self, i: usize) -> i32 {
        match self {
            UidMap::Uid(m) => i32::from(m[i]),
            UidMap::Labels(m) => i32::from(m[i]),
        }
    }
}

/// The near cluster of the depths in `w[..n]` (all `n` counted, only the first WINDOW kept, as
/// the JavaScript's typed array does): the median of those within 120 mm of the nearest.
fn near_cluster(w: &mut [f32; WINDOW], n: usize, lo: f64) -> f64 {
    if n < 3 {
        return 0.0;
    }
    let mut m = 0;
    for k in 0..n.min(WINDOW) {
        if f64::from(w[k]) <= lo + 120.0 {
            w[m] = w[k];
            m += 1;
        }
    }
    if m == 0 {
        return 0.0; // the nearest was beyond the window: undefined in the JavaScript
    }
    let sub = &mut w[..m];
    sub.sort_by(f32::total_cmp);
    f64::from(sub[m >> 1])
}

/// Depth at a keypoint: the near cluster of a small window (radius r; the person, not what is
/// behind). With `uid_map`, only the pixels of person `uid` count if the window has any (strict:
/// only they), and never the pixels of someone else (the person in front of it).
#[allow(clippy::too_many_arguments)]
pub(crate) fn depth_near(o: &Options, depth: &[u16], u: f64, v: f64, uid_map: Option<&UidMap>, uid: i32, r: i64, strict: bool) -> f64 {
    let mut w = [0.0_f32; WINDOW];
    let mut n = 0_usize;
    let mut lo = f64::INFINITY;
    let u0 = (jround(u) as i64 - r).max(0);
    let u1 = (jround(u) as i64 + r).min(W as i64 - 1);
    let v0 = (jround(v) as i64 - r).max(0);
    let v1 = (jround(v) as i64 + r).min(H as i64 - 1);
    let mut pass = if uid_map.is_some() { 0 } else { 1 };
    while pass < (if strict { 1 } else { 2 }) && n < 3 {
        n = 0;
        lo = f64::INFINITY;
        for y in v0..=v1 {
            for x in u0..=u1 {
                let i = y as usize * W + x as usize;
                let d = f64::from(depth[i]);
                if d < o.min_depth || d > o.max_depth {
                    continue;
                }
                if let Some(m) = uid_map {
                    let id = m.at(i);
                    if if pass == 0 { id != uid } else { id != 0 && id != uid } {
                        continue;
                    }
                }
                if n < WINDOW {
                    w[n] = d as f32;
                }
                n += 1;
                if d < lo {
                    lo = d;
                }
            }
        }
        pass += 1;
    }
    near_cluster(&mut w, n, lo)
}

/// Depth (mm) at an image point from the pixels of person q in this frame's mask (owner): the
/// near cluster of a small window, 0 if it has too few.
pub(crate) fn mask_depth(owner: &[i8], depth: &[u16], u: f64, v: f64, q: usize, r: i64) -> f64 {
    let mut w = [0.0_f32; WINDOW];
    let mut n = 0_usize;
    let mut lo = f64::INFINITY;
    let u0 = (jround(u) as i64 - r).max(0);
    let u1 = (jround(u) as i64 + r).min(W as i64 - 1);
    let v0 = (jround(v) as i64 - r).max(0);
    let v1 = (jround(v) as i64 + r).min(H as i64 - 1);
    for y in v0..=v1 {
        for x in u0..=u1 {
            let i = y as usize * W + x as usize;
            if i64::from(owner[i]) != q as i64 || depth[i] == 0 {
                continue;
            }
            let d = f64::from(depth[i]);
            if n < WINDOW {
                w[n] = d as f32;
            }
            n += 1;
            if d < lo {
                lo = d;
            }
        }
    }
    near_cluster(&mut w, n, lo)
}

/// How a hand's depth is measured (`depthAt` in the JavaScript).
pub(crate) enum DepthAt<'a> {
    /// depth_near on the person's own pixels of these labels
    Near { o: &'a Options, depth: &'a [u16], uid_map: &'a UidMap<'a>, uid: i32 },
    /// mask_depth of person q
    Mask { owner: &'a [i8], depth: &'a [u16], q: usize },
}

impl DepthAt<'_> {
    fn at(&self, u: f64, v: f64) -> f64 {
        match self {
            DepthAt::Near { o, depth, uid_map, uid } => depth_near(o, depth, u, v, Some(uid_map), *uid, ARM_WINDOW, true),
            DepthAt::Mask { owner, depth, q } => mask_depth(owner, depth, u, v, *q, ARM_WINDOW),
        }
    }
}

#[inline]
fn is(v: f32) -> bool {
    v != 0.0
}

#[inline]
fn pix(uv: &Uvs, k: usize) -> usize {
    jround(f64::from(uv[3 * k + 1])) as usize * W + jround(f64::from(uv[3 * k])) as usize
}

/// Keypoints (u, v, conf) -> 3D joints J (x, y, z mm, valid) and image points UV (u, v, conf).
/// seen: the person has pixels in uid_map (their depth is preferred). ref_z: median depth of its
/// joints a moment ago (0 = unknown). steady damps implausible depth jumps; measured: uid_map are
/// the labels of this very frame, the arms are measured on the person's own pixels only.
#[allow(clippy::too_many_arguments)]
pub(crate) fn lift(
    o: &Options,
    rays: &[f32],
    kp: &[f32; 51],
    depth: &[u16],
    uid_map: &UidMap,
    uid: i32,
    seen: bool,
    j: &mut Joints,
    uv: &mut Uvs,
    ref_z: f64,
    mut steady: Option<&mut Steady>,
    measured: bool,
) -> bool {
    j.fill(0.0);
    uv.fill(0.0);
    let mut ds: Vec<f64> = Vec::new();
    for k in 0..17 {
        let c = f64::from(kp[3 * k + 2]);
        let u = f64::from(kp[3 * k]);
        let v = f64::from(kp[3 * k + 1]);
        uv[3 * k] = kp[3 * k];
        uv[3 * k + 1] = kp[3 * k + 1];
        if c < o.min_keypoint || u < 0.0 || v < 0.0 || u > (W - 1) as f64 || v > (H - 1) as f64 {
            continue;
        }
        // hidden behind someone else (that person owns the pixel): its depth is not ours
        let owner = uid_map.at(jround(v) as usize * W + jround(u) as usize);
        if owner != 0 && owner != uid {
            continue;
        }
        let arm = measured && (7..=10).contains(&k);
        let mut d = if arm {
            depth_near(o, depth, u, v, Some(uid_map), uid, ARM_WINDOW, true)
        } else {
            depth_near(o, depth, u, v, if seen { Some(uid_map) } else { None }, uid, 3, false)
        };
        if d == 0.0 && arm {
            d = depth_near(o, depth, u, v, Some(uid_map), uid, 8, true);
        }
        if d == 0.0 {
            continue;
        }
        // far in front of where the person was a moment ago: something (someone) in front of it
        if ref_z != 0.0 && d + INSET[k] * 1000.0 < ref_z - HIDDEN {
            continue;
        }
        uv[3 * k + 2] = kp[3 * k + 2];
        j[4 * k + 2] = d as f32;
        j[4 * k + 3] = 1.0;
        ds.push(d);
    }
    // keypoints that hit the background through a gap: far from the rest of the body
    if !ds.is_empty() {
        ds.sort_by(f64::total_cmp);
        let med = ds[ds.len() >> 1];
        for k in 0..17 {
            if is(j[4 * k + 3]) && (f64::from(j[4 * k + 2]) - med).abs() > 900.0 {
                j[4 * k + 3] = 0.0;
                uv[3 * k + 2] = 0.0;
            }
        }
    }
    for k in 0..17 {
        if !is(j[4 * k + 3]) {
            continue;
        }
        // the joint center lies a few cm behind the surface the keypoint is seen on
        let i = pix(uv, k);
        let mut z = f64::from(j[4 * k + 2]) + INSET[k] * 1000.0;
        if let Some(st) = steady.as_deref_mut()
            && let Some(prev) = &st.prev
            && is(prev[4 * k + 3])
            && !(measured && (7..=10).contains(&k))
        {
            let zp = f64::from(prev[4 * k + 2]);
            let lim = 150.0 + 0.05 * zp;
            if (z - zp).abs() > lim {
                if st.n[k] != 0 && (z - f64::from(st.z[k])).abs() < lim / 2.0 {
                    st.n[k] = st.n[k].wrapping_add(1);
                } else {
                    st.z[k] = z as f32;
                    st.n[k] = 1;
                }
                if st.n[k] < 3 {
                    z = zp;
                } else {
                    st.n[k] = 0;
                }
            } else {
                st.n[k] = 0;
            }
        }
        j[4 * k] = (f64::from(rays[2 * i]) * z) as f32;
        j[4 * k + 1] = (f64::from(rays[2 * i + 1]) * z) as f32;
        j[4 * k + 2] = z as f32;
    }
    if let Some(st) = steady {
        limbs(rays, j, uv, st, measured);
    }
    let mid = |j: &mut Joints, uv: &mut Uvs, a: usize, b: usize, out: usize| {
        if !is(j[4 * a + 3]) || !is(j[4 * b + 3]) {
            return;
        }
        for c in 0..3 {
            j[4 * out + c] = ((f64::from(j[4 * a + c]) + f64::from(j[4 * b + c])) / 2.0) as f32;
        }
        j[4 * out + 3] = 1.0;
        uv[3 * out] = ((f64::from(uv[3 * a]) + f64::from(uv[3 * b])) / 2.0) as f32;
        uv[3 * out + 1] = ((f64::from(uv[3 * a + 1]) + f64::from(uv[3 * b + 1])) / 2.0) as f32;
        uv[3 * out + 2] = uv[3 * a + 2].min(uv[3 * b + 2]);
    };
    mid(j, uv, 5, 6, SC);
    mid(j, uv, 11, 12, HC);
    // head: the face keypoints that were found
    let mut n = 0_u32;
    for k in 0..5 {
        if !is(j[4 * k + 3]) {
            continue;
        }
        for c in 0..3 {
            j[4 * HEAD + c] = (f64::from(j[4 * HEAD + c]) + f64::from(j[4 * k + c])) as f32;
        }
        uv[3 * HEAD] = (f64::from(uv[3 * HEAD]) + f64::from(uv[3 * k])) as f32;
        uv[3 * HEAD + 1] = (f64::from(uv[3 * HEAD + 1]) + f64::from(uv[3 * k + 1])) as f32;
        n += 1;
    }
    if n > 0 {
        let nf = f64::from(n);
        for c in 0..3 {
            j[4 * HEAD + c] = (f64::from(j[4 * HEAD + c]) / nf) as f32;
        }
        uv[3 * HEAD] = (f64::from(uv[3 * HEAD]) / nf) as f32;
        uv[3 * HEAD + 1] = (f64::from(uv[3 * HEAD + 1]) / nf) as f32;
        uv[3 * HEAD + 2] = 1.0;
        j[4 * HEAD + 3] = 1.0;
    }
    // hands: beyond the wrist, along the forearm (their depth measured where they are)
    let at = measured.then_some(DepthAt::Near { o, depth, uid_map, uid });
    if is(j[4 * 7 + 3]) && is(j[4 * 9 + 3]) {
        hand(rays, j, uv, 7, 9, LH, at.as_ref());
    }
    if is(j[4 * 8 + 3]) && is(j[4 * 10 + 3]) {
        hand(rays, j, uv, 8, 10, RH, at.as_ref());
    }
    // legs that leave the image at the bottom: the shin continues the thigh to the image border
    let shin = |j: &mut Joints, uv: &mut Uvs, hip: usize, knee: usize, ankle: usize| {
        if is(j[4 * ankle + 3]) || !is(j[4 * hip + 3]) || !is(j[4 * knee + 3]) {
            return;
        }
        let u = f64::from(uv[3 * knee]) + 0.9 * (f64::from(uv[3 * knee]) - f64::from(uv[3 * hip]));
        let v = f64::from(uv[3 * knee + 1]) + 0.9 * (f64::from(uv[3 * knee + 1]) - f64::from(uv[3 * hip + 1]));
        if v < (H - 12) as f64 {
            return; // the ankle would be in the image: not found for a reason
        }
        for c in 0..3 {
            j[4 * ankle + c] = (f64::from(j[4 * knee + c]) + 0.9 * (f64::from(j[4 * knee + c]) - f64::from(j[4 * hip + c]))) as f32;
        }
        j[4 * ankle + 3] = 1.0;
        uv[3 * ankle] = u as f32;
        uv[3 * ankle + 1] = v as f32;
    };
    shin(j, uv, 11, 13, 15);
    shin(j, uv, 12, 14, 16);
    PARTS.iter().any(|&(a, b, _)| is(j[4 * a + 3]) && is(j[4 * b + 3]))
}

/// The hand: beyond the wrist w along the forearm (from elbow e), into J/UV point `out`. Its depth
/// measured there (`at`) is used if it fits the wrist.
pub(crate) fn hand(rays: &[f32], j: &mut Joints, uv: &mut Uvs, e: usize, w: usize, out: usize, at: Option<&DepthAt>) {
    for c in 0..3 {
        j[4 * out + c] = (f64::from(j[4 * w + c]) + 0.45 * (f64::from(j[4 * w + c]) - f64::from(j[4 * e + c]))) as f32;
    }
    j[4 * out + 3] = 1.0;
    let u = f64::from(uv[3 * w]) + 0.45 * (f64::from(uv[3 * w]) - f64::from(uv[3 * e]));
    let v = f64::from(uv[3 * w + 1]) + 0.45 * (f64::from(uv[3 * w + 1]) - f64::from(uv[3 * e + 1]));
    uv[3 * out] = u as f32;
    uv[3 * out + 1] = v as f32;
    uv[3 * out + 2] = 1.0;
    let Some(at) = at else { return };
    if u < 0.0 || v < 0.0 || u > (W - 1) as f64 || v > (H - 1) as f64 {
        return;
    }
    let d = at.at(u, v);
    if d == 0.0 || (d + HAND_INSET - f64::from(j[4 * w + 2])).abs() > 250.0 {
        return;
    }
    let i = jround(v) as usize * W + jround(u) as usize;
    let z = d + HAND_INSET;
    j[4 * out] = (f64::from(rays[2 * i]) * z) as f32;
    j[4 * out + 1] = (f64::from(rays[2 * i + 1]) * z) as f32;
    j[4 * out + 2] = z as f32;
}

/// Limbs: each elbow, wrist, knee and ankle must lie its bone's length from its parent joint. A
/// joint whose measured depth does not fit moves along its ray to the point at that distance
/// nearest to where it was a moment ago. The lengths are learned per person; arms measured on the
/// person's own pixels (`arms`) only teach their lengths.
fn limbs(rays: &[f32], j: &mut Joints, uv: &Uvs, st: &mut Steady, arms: bool) {
    let bones = st.bones.get_or_insert(LIMB_LENGTHS);
    for (b, &(a, c)) in LIMBS.iter().enumerate() {
        if !is(j[4 * a + 3]) || !is(j[4 * c + 3]) {
            continue;
        }
        let l = f64::from(bones[b]);
        let px = f64::from(j[4 * a]);
        let py = f64::from(j[4 * a + 1]);
        let pz = f64::from(j[4 * a + 2]);
        let len = hypot3(f64::from(j[4 * c]) - px, f64::from(j[4 * c + 1]) - py, f64::from(j[4 * c + 2]) - pz);
        if (len - l).abs() < 0.3 * l {
            if (len - l).abs() < 0.15 * l {
                bones[b] = (0.97 * l + 0.03 * len) as f32; // learn the length
            }
            continue;
        }
        if arms && b < 4 {
            continue;
        }
        // the ray through the joint's pixel: point = z * (rx, ry, 1)
        let i = pix(uv, c);
        let rx = f64::from(rays[2 * i]);
        let ry = f64::from(rays[2 * i + 1]);
        let rr = rx * rx + ry * ry + 1.0;
        // |z r - P| = L  ->  rr z² - 2 (r·P) z + |P|² - L² = 0
        let rp = rx * px + ry * py + pz;
        let disc = rp * rp - rr * (px * px + py * py + pz * pz - l * l);
        let z = if disc <= 0.0 {
            rp / rr // the bone cannot reach the ray: the nearest point on it
        } else {
            // of the two points at that distance: the one nearer to where the joint was
            let z1 = (rp - disc.sqrt()) / rr;
            let z2 = (rp + disc.sqrt()) / rr;
            let m = match &st.prev {
                Some(prev) if is(prev[4 * c + 3]) => f64::from(prev[4 * c + 2]),
                _ => pz,
            };
            if (z1 - m).abs() < (z2 - m).abs() { z1 } else { z2 }
        };
        j[4 * c] = (rx * z) as f32;
        j[4 * c + 1] = (ry * z) as f32;
        j[4 * c + 2] = z as f32;
    }
}

/// Median depth (mm) of a person's joints in the last frame, 0 if none.
pub(crate) fn ref_z(t: &Track) -> f64 {
    if !t.lifted {
        return 0.0;
    }
    let mut zs: Vec<f64> = (0..17).filter(|&k| is(t.joints[4 * k + 3])).map(|k| f64::from(t.joints[4 * k + 2])).collect();
    if zs.is_empty() {
        return 0.0;
    }
    zs.sort_by(f64::total_cmp);
    zs[zs.len() >> 1]
}

/// Body part capsules of a skeleton; false if it has none.
pub(crate) fn capsules(o: &Options, j: &Joints, c: &mut Capsules) -> bool {
    let mut any = false;
    for (p, &(a, b, r)) in PARTS.iter().enumerate() {
        let ok = is(j[4 * a + 3]) && is(j[4 * b + 3]);
        c[CAP * p + 8] = if ok { 1.0 } else { 0.0 };
        if !ok {
            continue;
        }
        any = true;
        for k in 0..3 {
            c[CAP * p + k] = f64::from(j[4 * a + k]);
            c[CAP * p + 3 + k] = f64::from(j[4 * b + k]);
        }
        let rr = (r + o.margin) * 1000.0;
        let rr2 = (r + o.margin + o.reach) * 1000.0;
        c[CAP * p + 6] = rr * rr;
        c[CAP * p + 7] = rr2 * rr2;
    }
    any
}

/// Squared distance of a point (mm) to the bone of capsule p, and how far it lies behind the bone.
#[inline]
pub(crate) fn seg(c: &Capsules, p: usize, x: f64, y: f64, z: f64) -> (f64, f64) {
    let o = CAP * p;
    let (ax, ay, az) = (c[o], c[o + 1], c[o + 2]);
    let bx = c[o + 3] - ax;
    let by = c[o + 4] - ay;
    let bz = c[o + 5] - az;
    let px = x - ax;
    let py = y - ay;
    let pz = z - az;
    let len2 = bx * bx + by * by + bz * bz;
    let s = if len2 > 0.0 { ((px * bx + py * by + pz * bz) / len2).clamp(0.0, 1.0) } else { 0.0 };
    let dx = px - s * bx;
    let dy = py - s * by;
    let dz = pz - s * bz;
    (dx * dx + dy * dy + dz * dz, dz)
}

/// The body part a point (mm) belongs to, -1 if none; `hint` is tried first. strict: inside the
/// part, and not clearly behind its bone. Otherwise: within reach of the part.
#[inline]
pub(crate) fn fit(c: &Capsules, hint: i32, x: f64, y: f64, z: f64, strict: bool) -> i32 {
    for k in -1..NP as i32 {
        let p = if k < 0 { hint } else { k };
        if k == hint {
            continue;
        }
        let o = CAP * p as usize;
        if c[o + 8] == 0.0 {
            continue;
        }
        let (d2, dz) = seg(c, p as usize, x, y, z);
        if if strict { d2 <= c[o + 6] && dz <= BEHIND } else { d2 <= c[o + 7] } {
            return p;
        }
    }
    -1
}

/// Share of the pixels of person `uid` (every 3rd row and column) within reach of capsules C.
pub(crate) fn covers(c: &Capsules, rays: &[f32], uid_map: &[i16], depth: &[u16], uid: i32) -> f64 {
    let (mut n, mut ok, mut hint) = (0_u32, 0_u32, 0_i32);
    for v in (1..H).step_by(3) {
        for u in (1..W).step_by(3) {
            let i = v * W + u;
            if i32::from(uid_map[i]) != uid {
                continue;
            }
            let d = f64::from(depth[i]);
            if d == 0.0 {
                continue;
            }
            n += 1;
            let p = fit(c, hint, f64::from(rays[2 * i]) * d, f64::from(rays[2 * i + 1]) * d, d, false);
            if p >= 0 {
                ok += 1;
                hint = p;
            }
        }
    }
    if n > 0 { f64::from(ok) / f64::from(n) } else { 1.0 }
}

/// Image point of a camera point (mm), the rays linearized around pixel (u0, v0).
pub(crate) fn project(rays: &[f32], x: f64, y: f64, z: f64, u0: f64, v0: f64) -> (f64, f64) {
    let uc = jround(u0).max(1.0).min((W - 2) as f64) as usize;
    let vc = jround(v0).max(1.0).min((H - 2) as f64) as usize;
    let i = vc * W + uc;
    let r = |k: usize| f64::from(rays[k]);
    let fx = 2.0 / (r(2 * (i + 1)) - r(2 * (i - 1)));
    let fy = 2.0 / (r(2 * (i + W) + 1) - r(2 * (i - W) + 1));
    (uc as f64 + (x / z - r(2 * i)) * fx, vc as f64 + (y / z - r(2 * i + 1)) * fy)
}

/// Box around the confident keypoints, None if there are fewer than two.
pub(crate) fn keypoint_box(kp: &[f32; 51], min_conf: f64) -> Option<[f64; 4]> {
    let (mut u0, mut v0, mut u1, mut v1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    let mut n = 0;
    for k in 0..17 {
        if f64::from(kp[3 * k + 2]) < min_conf {
            continue;
        }
        let (u, v) = (f64::from(kp[3 * k]), f64::from(kp[3 * k + 1]));
        u0 = u0.min(u);
        v0 = v0.min(v);
        u1 = u1.max(u);
        v1 = v1.max(v);
        n += 1;
    }
    (n >= 2).then_some([u0, v0, u1, v1])
}

/// Similarity of two keypoint sets (0..1), like COCO's OKS with a fixed tolerance.
pub(crate) fn keypoint_similarity(a: &[f32; 51], b: &[f32; 51], scale: f64, min_conf: f64) -> f64 {
    let (mut s, mut n) = (0.0_f64, 0_u32);
    let t = 0.15 * scale;
    let k2 = 2.0 * (t * t);
    for k in 0..17 {
        if f64::from(a[3 * k + 2]) < min_conf || f64::from(b[3 * k + 2]) < min_conf {
            continue;
        }
        let du = f64::from(a[3 * k]) - f64::from(b[3 * k]);
        let dv = f64::from(a[3 * k + 1]) - f64::from(b[3 * k + 1]);
        s += (-(du * du + dv * dv) / k2).exp();
        n += 1;
    }
    if n > 0 { s / f64::from(n) } else { 0.0 }
}

impl PersonTracker {
    /// The skeleton of the current frame: its keypoints (followed by the flow) lifted with this
    /// frame's depth, the person's own pixels of the last frame preferred; its body parts. A joint
    /// that cannot be placed keeps its place, moved along with the person's pixels, until the
    /// person is gone.
    pub(crate) fn place(&mut self, ti: usize) -> bool {
        let refz = ref_z(&self.tracks[ti]);
        let keep = jround(self.options.keep_seconds * self.options.fps);
        let Some(depth) = self.last_depth.as_deref() else { return false };
        let t = &mut self.tracks[ti];
        if !t.lifted || t.kp_seq.is_none() {
            return false;
        }
        let mut kp = t.kp;
        for k in 0..17 {
            if t.lost[k] > MAX_LOST {
                kp[3 * k + 2] = 0.0;
            }
        }
        let mut j: Joints = [0.0; NJ * 4];
        let mut u: Uvs = [0.0; NJ * 3];
        let joints_before = t.joints;
        let steady = t.steady.get_or_insert_with(Steady::new);
        steady.prev = Some(joints_before); // t.lifted is true here
        if !lift(&self.options, &self.rays, &kp, depth, &UidMap::Uid(&self.prev_uid), t.uid, t.pixels > 0, &mut j, &mut u, refz, Some(steady), false) {
            j.fill(0.0);
            u.fill(0.0);
        }
        let p = t.joints;
        let pu = t.uv;
        let d3 = t.dpos.unwrap_or([0.0; 3]);
        let d2 = t.dc2.unwrap_or([0.0; 2]);
        for k in 0..NJ {
            if is(j[4 * k + 3]) {
                t.joint_age[k] = 0;
            } else if is(p[4 * k + 3]) && {
                t.joint_age[k] = t.joint_age[k].wrapping_add(1);
                f64::from(t.joint_age[k]) <= keep
            } {
                for c in 0..3 {
                    j[4 * k + c] = (f64::from(p[4 * k + c]) + d3[c]) as f32;
                }
                j[4 * k + 3] = 1.0;
                u[3 * k] = (f64::from(pu[3 * k]) + d2[0]) as f32;
                u[3 * k + 1] = (f64::from(pu[3 * k + 1]) + d2[1]) as f32;
                u[3 * k + 2] = pu[3 * k + 2];
            }
        }
        t.joints = j;
        t.uv = u;
        capsules(&self.options, &t.joints, &mut t.capsules)
    }
}

/// One body part of a Body: the capsule prepared for many point tests.
#[derive(Clone, Copy)]
struct Part {
    p: i32,
    a: [f64; 3],
    /// bone vector b - a and 1 / its squared length (0 for a point)
    d: [f64; 3],
    inv_len2: f64,
    r2: f64,
    reach2: f64,
    /// boxes around the capsule, inflated by its radius and by its reach: a point outside is no
    /// part of it (a few comparisons instead of the distance)
    lo: [f64; 3],
    hi: [f64; 3],
    rlo: [f64; 3],
    rhi: [f64; 3],
}

/// The body parts of a skeleton prepared once per frame for the segmentation's many point tests
/// (fit() with a precomputed 1 / bone length² and a quick box test first).
pub(crate) struct Body {
    parts: Vec<Part>,
    /// index into parts by capsule number, -1 = not valid
    at: [i8; NP],
}

impl Body {
    pub fn new(c: &Capsules) -> Body {
        let mut parts = Vec::with_capacity(NP);
        let mut at = [-1_i8; NP];
        for (p, slot) in at.iter_mut().enumerate() {
            let o = CAP * p;
            if c[o + 8] == 0.0 {
                continue;
            }
            let a = [c[o], c[o + 1], c[o + 2]];
            let b = [c[o + 3], c[o + 4], c[o + 5]];
            let d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
            let (r, rr) = (c[o + 6].sqrt(), c[o + 7].sqrt());
            let lo = [0, 1, 2].map(|k| a[k].min(b[k]));
            let hi = [0, 1, 2].map(|k| a[k].max(b[k]));
            *slot = parts.len() as i8;
            parts.push(Part {
                p: p as i32,
                a,
                d,
                inv_len2: if len2 > 0.0 { 1.0 / len2 } else { 0.0 },
                r2: c[o + 6],
                reach2: c[o + 7],
                lo: lo.map(|v| v - r),
                hi: hi.map(|v| v + r),
                rlo: lo.map(|v| v - rr),
                rhi: hi.map(|v| v + rr),
            });
        }
        Body { parts, at }
    }

    #[inline]
    fn test(q: &Part, x: f64, y: f64, z: f64, strict: bool) -> bool {
        let (lo, hi) = if strict { (&q.lo, &q.hi) } else { (&q.rlo, &q.rhi) };
        if x < lo[0] || x > hi[0] || y < lo[1] || y > hi[1] || z < lo[2] || z > hi[2] {
            return false;
        }
        let (px, py, pz) = (x - q.a[0], y - q.a[1], z - q.a[2]);
        let s = ((px * q.d[0] + py * q.d[1] + pz * q.d[2]) * q.inv_len2).clamp(0.0, 1.0);
        let dx = px - s * q.d[0];
        let dy = py - s * q.d[1];
        let dz = pz - s * q.d[2];
        let d2 = dx * dx + dy * dy + dz * dz;
        if strict { d2 <= q.r2 && dz <= BEHIND } else { d2 <= q.reach2 }
    }

    /// As fit(): the body part a point (mm) belongs to, -1 if none; `hint` is tried first.
    #[inline]
    pub fn fit(&self, hint: i32, x: f64, y: f64, z: f64, strict: bool) -> i32 {
        if let Some(&h) = usize::try_from(hint).ok().and_then(|h| self.at.get(h))
            && h >= 0
            && Body::test(&self.parts[h as usize], x, y, z, strict)
        {
            return hint;
        }
        for q in &self.parts {
            if q.p != hint && Body::test(q, x, y, z, strict) {
                return q.p;
            }
        }
        -1
    }
}
