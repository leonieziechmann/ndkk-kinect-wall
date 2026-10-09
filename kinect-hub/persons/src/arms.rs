//! Step 2b: the arms from the mask (persons-core.js, "2b. arms from the mask").
//!
//! Between two poses the optical flow often loses a fast wrist (little texture, motion blur), and
//! the arm then stays behind while the mask has it. The person's pixels outside its trunk, head and
//! legs that connect to a shoulder are its arm; when it reaches out, its far end (from the shoulder)
//! is the fingertips, and wrist, hand and elbow are cut out of it at their distances from there.
//! Such an arm is used once a pose has confirmed it (the mask's arm of that pose's frame was where
//! the pose had it) and while it does not jump. Otherwise the arm stays as the flow has it, with
//! this frame's depth; a wrist the flow lost that lies off the body hangs down along it.

use crate::skeleton::{DepthAt, HAND_INSET, INSET, LIMB_LENGTHS, capsules, hand, mask_depth, project, ref_z, seg};
use crate::tracker::{ArmHist, ArmLast, CAP, Capsules, HC, Joints, LH, PersonTracker, SC, Uvs};
use crate::{H, W, hypot3, jround};

/// mm from the far end of an arm in the mask (the fingertips) to the wrist and to the hand point
const WRIST_TIP: f64 = 140.0;
const HAND_TIP: f64 = 50.0;
/// mm from one frame to the next: a mask's arm that jumps is not trusted
const ARM_JUMP: f64 = 300.0;
/// frames the mask's arms are remembered for the poses that come later
const KEEP_ARMS: usize = 40;
/// mm: nearer persons keep the arms of the flow
const ARM_NEAR: f64 = 900.0;
/// the body parts that are no arm, the trunk first (an arm is what lies outside them)
const CORE_PARTS: [usize; 13] = [3, 4, 5, 6, 2, 1, 0, 13, 14, 15, 16, 17, 18];
const GW: usize = W >> 1;
const GH: usize = H >> 1;

#[inline]
fn is(v: f32) -> bool {
    v != 0.0
}

#[inline]
fn cell_index(g: usize) -> usize {
    let gy = g / GW;
    2 * gy * W + 2 * (g - gy * GW)
}

/// One arm cut out of the mask: wrist, hand and (if found) elbow as [u, v, depth].
struct Arm {
    w: [f64; 3],
    h: [f64; 3],
    e: Option<[f64; 3]>,
}

impl PersonTracker {
    /// The arms of this frame from its mask (after the segmentation), for the persons `active`
    /// (indices into tracks, in the order of the owner values). Corrects joints, image points and
    /// the followed keypoints (the flow goes on from there).
    pub(crate) fn arms(&mut self, depth: &[u16], active: &[usize], seq: i64) {
        let PersonTracker { tracks, owner, rays, options: o, floor, feet_floor, arm_side, arm_dist, arm_queue, arm_tip_dist, arm_cells, .. } = self;
        let mk = o.min_keypoint;
        let floor = floor.as_ref().or(feet_floor.as_ref());
        for (q, &ti) in active.iter().enumerate() {
            let t = &mut tracks[ti];
            // hidden a moment ago, or too near (little depth, holes in the mask): the arms stay
            if t.pixels == 0 || ref_z(t) < ARM_NEAR {
                continue;
            }
            let bones: [f32; 8] = t.steady.as_ref().and_then(|s| s.bones).unwrap_or(LIMB_LENGTHS);
            let bone = |k: usize| f64::from(bones[k]);
            let j = &mut t.joints;
            let u = &mut t.uv;
            let sh: [Option<[f64; 3]>; 2] = [5, 6].map(|k| is(j[4 * k + 3]).then(|| [f64::from(j[4 * k]), f64::from(j[4 * k + 1]), f64::from(j[4 * k + 2])]));
            let mut arm: [Option<Arm>; 2] = [None, None];
            if sh[0].is_some() || sh[1].is_some() {
                // the box the arms can reach, within the person's box of the last frame
                let reach = [0, 1].map(|s| bone(2 * s) + bone(2 * s + 1) + 250.0);
                let (mut u0, mut v0, mut u1, mut v1) = (W as f64, H as f64, 0.0_f64, 0.0_f64);
                for s in 0..2 {
                    let Some(shs) = sh[s] else { continue };
                    let k = 5 + s;
                    let px = reach[s] * 370.0 / (shs[2] - 0.7 * reach[s]).max(400.0);
                    u0 = u0.min(f64::from(u[3 * k]) - px);
                    u1 = u1.max(f64::from(u[3 * k]) + px);
                    v0 = v0.min(f64::from(u[3 * k + 1]) - px);
                    v1 = v1.max(f64::from(u[3 * k + 1]) + px);
                }
                if let Some(b) = t.bbox {
                    u0 = u0.max(b[0] - 24.0);
                    v0 = v0.max(b[1] - 24.0);
                    u1 = u1.min(b[2] + 24.0);
                    v1 = v1.min(b[3] + 24.0);
                }
                let g0 = (u0 / 2.0).floor().max(0.0) as i64;
                let g1 = ((u1 / 2.0).ceil() as i64).min(GW as i64 - 1);
                let h0 = (v0 / 2.0).floor().max(0.0) as i64;
                let h1 = ((v1 / 2.0).ceil() as i64).min(GH as i64 - 1);
                // below this height (mm above the floor) a pixel is a leg: on the floor, and below
                // the hips of someone crouching or sitting
                let fnorm = floor.map_or([0.0, -1.0, 0.0], |f| f.normal);
                let fd = floor.map_or(0.0, |f| f.d * 1000.0);
                let mut low = f64::NEG_INFINITY;
                if floor.is_some() {
                    low = 120.0;
                    if is(j[4 * HC + 3]) {
                        let hip = fnorm[0] * f64::from(j[4 * HC]) + fnorm[1] * f64::from(j[4 * HC + 1]) + fnorm[2] * f64::from(j[4 * HC + 2]) + fd;
                        if hip < 700.0 {
                            low = low.max(hip + 100.0);
                        }
                    }
                }
                let side = &mut arm_side[..];
                let dist = &mut arm_dist[..];
                let gq = &mut arm_queue[..];
                let mut tail = if g0 <= g1 && h0 <= h1 {
                    candidates(depth, owner, rays, q, &t.capsules, &sh, &reach, &bones, (g0 as usize, g1 as usize, h0 as usize, h1 as usize), low, fnorm, fd, side, dist, gq)
                } else {
                    0
                };
                // each arm: the candidates connected to its shoulder's seeds without a depth jump
                let mut nc = [0_usize; 2];
                let mut head = 0;
                while head < tail {
                    let g = gq[head] as usize;
                    head += 1;
                    let s = (side[g] - 3) as usize;
                    arm_cells[s][nc[s]] = g as i32;
                    nc[s] += 1;
                    let gy = g / GW;
                    let gx = g - gy * GW;
                    let di = f64::from(depth[2 * gy * W + 2 * gx]);
                    let tol = 2.0 * (o.join_margin + o.join_slope * di);
                    for n in 0..4 {
                        let nx = gx as i64 + if n == 0 { -1 } else if n == 1 { 1 } else { 0 };
                        let ny = gy as i64 + if n == 2 { -1 } else if n == 3 { 1 } else { 0 };
                        if nx < g0 || nx > g1 || ny < h0 || ny > h1 {
                            continue;
                        }
                        let h = ny as usize * GW + nx as usize;
                        if side[h] != s as i8 + 1 {
                            continue;
                        }
                        let dj = f64::from(depth[2 * ny as usize * W + 2 * nx as usize]);
                        if dj - di > tol || di - dj > tol {
                            continue;
                        }
                        side[h] = s as i8 + 3;
                        gq[tail] = h as i32;
                        tail += 1;
                    }
                }
                for s in 0..2 {
                    let n = nc[s];
                    let list = &arm_cells[s][..n];
                    if n < 12 {
                        continue;
                    }
                    let dmax = list.iter().fold(0.0_f64, |m, &g| m.max(f64::from(dist[g as usize])));
                    // the hand reaches out: farther from the shoulder than the elbow could be
                    if dmax < bone(2 * s) + 0.5 * bone(2 * s + 1) {
                        continue;
                    }
                    // mean u, v, depth of the arm's cells whose key lies in [a, b]
                    let slice = |key: &[f32], a: f64, b: f64| -> Option<[f64; 3]> {
                        let (mut su, mut sv, mut sd, mut m) = (0.0_f64, 0.0_f64, 0.0_f64, 0_u32);
                        for &g in list {
                            let kv = f64::from(key[g as usize]);
                            if kv < a || kv > b {
                                continue;
                            }
                            let i = cell_index(g as usize);
                            su += (i % W) as f64;
                            sv += (i / W) as f64;
                            sd += f64::from(depth[i]);
                            m += 1;
                        }
                        (m >= 3).then(|| {
                            let mf = f64::from(m);
                            [su / mf, sv / mf, sd / mf]
                        })
                    };
                    let Some(tip) = slice(dist, dmax - 40.0, f64::INFINITY) else { continue };
                    let ti = jround(tip[1]) as usize * W + jround(tip[0]) as usize;
                    let tx = f64::from(rays[2 * ti]) * tip[2];
                    let ty = f64::from(rays[2 * ti + 1]) * tip[2];
                    for &g in list {
                        let i = cell_index(g as usize);
                        let d = f64::from(depth[i]);
                        let dx = f64::from(rays[2 * i]) * d - tx;
                        let dy = f64::from(rays[2 * i + 1]) * d - ty;
                        arm_tip_dist[g as usize] = (dx * dx + dy * dy + (d - tip[2]) * (d - tip[2])).sqrt() as f32;
                    }
                    let (Some(w), Some(h)) =
                        (slice(arm_tip_dist, WRIST_TIP - 20.0, WRIST_TIP + 20.0), slice(arm_tip_dist, HAND_TIP - 20.0, HAND_TIP + 20.0))
                    else {
                        continue;
                    };
                    let fore = bone(2 * s + 1);
                    let e = slice(arm_tip_dist, WRIST_TIP + fore - 20.0, WRIST_TIP + fore + 20.0);
                    arm[s] = Some(Arm { w, h, e });
                }
            }
            // remembered: the next pose tells whether the mask's arms were right in this frame
            t.arm_hist.push(ArmHist { seq, w: [arm[0].as_ref().map(|a| a.w), arm[1].as_ref().map(|a| a.w)] });
            if t.arm_hist.len() > KEEP_ARMS {
                t.arm_hist.remove(0);
            }
            let kp = &mut t.kp;
            let lost = &mut t.lost;
            let age = &mut t.joint_age;
            let place = |j: &mut Joints, u: &mut Uvs, kp: &mut [f32; 51], lost: &mut [u8; 17], age: &mut [u16], k: usize, p: [f64; 3], inset: f64| {
                let i = jround(p[1]) as usize * W + jround(p[0]) as usize;
                let z = p[2] + inset;
                j[4 * k] = (f64::from(rays[2 * i]) * z) as f32;
                j[4 * k + 1] = (f64::from(rays[2 * i + 1]) * z) as f32;
                j[4 * k + 2] = z as f32;
                j[4 * k + 3] = 1.0;
                u[3 * k] = p[0] as f32;
                u[3 * k + 1] = p[1] as f32;
                age[k] = 0;
                if k >= 17 {
                    u[3 * k + 2] = 1.0;
                    return;
                }
                u[3 * k + 2] = f64::from(u[3 * k + 2]).max(mk) as f32;
                kp[3 * k] = p[0] as f32;
                kp[3 * k + 1] = p[1] as f32;
                kp[3 * k + 2] = f64::from(kp[3 * k + 2]).max(mk) as f32;
                lost[k] = 0;
            };
            // the depth of a joint from this frame's mask, where it is
            let measured = |j: &mut Joints, u: &Uvs, k: usize| {
                let (uu, vv) = (f64::from(u[3 * k]), f64::from(u[3 * k + 1]));
                if !is(j[4 * k + 3]) || !(uu >= 0.0 && vv >= 0.0 && uu <= (W - 1) as f64 && vv <= (H - 1) as f64) {
                    return;
                }
                let d = mask_depth(owner, depth, uu, vv, q, 5);
                if d == 0.0 {
                    return;
                }
                let i = jround(vv) as usize * W + jround(uu) as usize;
                let z = d + INSET[k] * 1000.0;
                j[4 * k] = (f64::from(rays[2 * i]) * z) as f32;
                j[4 * k + 1] = (f64::from(rays[2 * i + 1]) * z) as f32;
                j[4 * k + 2] = z as f32;
            };
            for s in 0..2 {
                let ke = 7 + s;
                let kw = 9 + s;
                let kh = LH + s;
                if let Some(a) = &arm[s] {
                    // a mask's arm that jumps from one frame to the next is something else (a leg,
                    // the hair) until the next pose says otherwise
                    let i = jround(a.w[1]) as usize * W + jround(a.w[0]) as usize;
                    let p = [f64::from(rays[2 * i]) * a.w[2], f64::from(rays[2 * i + 1]) * a.w[2], a.w[2]];
                    if let Some(last) = &t.arm_last[s]
                        && seq - last.seq <= 2
                        && hypot3(p[0] - last.p[0], p[1] - last.p[1], p[2] - last.p[2]) > ARM_JUMP
                    {
                        t.arm_trust[s] = 0;
                    }
                    t.arm_last[s] = Some(ArmLast { seq, p });
                } else {
                    t.arm_last[s] = None;
                }
                if let Some(a) = &arm[s]
                    && t.arm_trust[s] != 0
                {
                    place(j, u, kp, lost, age, kw, a.w, INSET[kw] * 1000.0);
                    place(j, u, kp, lost, age, kh, a.h, HAND_INSET);
                    // the elbow where the mask has it, if it fits the bones
                    let mut ok = false;
                    if let (Some(e), Some(shs)) = (a.e, sh[s]) {
                        let i = jround(e[1]) as usize * W + jround(e[0]) as usize;
                        let z = e[2] + INSET[ke] * 1000.0;
                        let ex = f64::from(rays[2 * i]) * z;
                        let ey = f64::from(rays[2 * i + 1]) * z;
                        let lu = hypot3(ex - shs[0], ey - shs[1], z - shs[2]);
                        let lf = hypot3(ex - f64::from(j[4 * kw]), ey - f64::from(j[4 * kw + 1]), z - f64::from(j[4 * kw + 2]));
                        ok = (lu - bone(2 * s)).abs() < 0.4 * bone(2 * s) && (lf - bone(2 * s + 1)).abs() < 0.4 * bone(2 * s + 1);
                    }
                    match a.e {
                        Some(e) if ok => place(j, u, kp, lost, age, ke, e, INSET[ke] * 1000.0),
                        _ => measured(j, u, ke),
                    }
                    continue;
                }
                measured(j, u, ke);
                measured(j, u, kw);
                // the flow lost the wrist and it lies off the body: the arm is not out (the mask
                // would have it), it hangs down along the body
                if let Some(shs) = sh[s]
                    && is(j[4 * kw + 3])
                    && is(j[4 * SC + 3])
                    && is(j[4 * HC + 3])
                    && lost[kw] != 0
                    && mask_depth(owner, depth, f64::from(u[3 * kw]), f64::from(u[3 * kw + 1]), q, 6) == 0.0
                {
                    let mut dir = [0, 1, 2].map(|c| f64::from(j[4 * HC + c]) - f64::from(j[4 * SC + c]));
                    let out = [0, 1, 2].map(|c| shs[c] - f64::from(j[4 * SC + c]));
                    let ld = hypot3(dir[0], dir[1], dir[2]);
                    let ld = if ld == 0.0 { 1.0 } else { ld };
                    let lo = hypot3(out[0], out[1], out[2]);
                    let lo = if lo == 0.0 { 1.0 } else { lo };
                    for c in 0..3 {
                        dir[c] = dir[c] / ld + 0.15 * out[c] / lo;
                    }
                    let l = hypot3(dir[0], dir[1], dir[2]);
                    for (k, len) in [(ke, bone(2 * s)), (kw, bone(2 * s) + bone(2 * s + 1))] {
                        let pp = [0, 1, 2].map(|c| shs[c] + len * dir[c] / l);
                        let (pu, pv) = project(rays, pp[0], pp[1], pp[2], f64::from(u[3 * (5 + s)]), f64::from(u[3 * (5 + s) + 1]));
                        if pu < 0.0 || pv < 0.0 || pu > (W - 1) as f64 || pv > (H - 1) as f64 {
                            continue;
                        }
                        let d = mask_depth(owner, depth, pu, pv, q, 5);
                        let dd = if d != 0.0 { d } else { pp[2] - INSET[k] * 1000.0 };
                        place(j, u, kp, lost, age, k, [pu, pv, dd], INSET[k] * 1000.0);
                    }
                }
                if is(j[4 * ke + 3]) && is(j[4 * kw + 3]) {
                    hand(rays, j, u, ke, kw, kh, Some(&DepthAt::Mask { owner, depth, q }));
                }
            }
            capsules(o, &t.joints, &mut t.capsules);
        }
    }
}

/// The candidates for the arms in the grid (every second row and column) of box g0..g1, h0..h1:
/// the person's pixels within reach of a shoulder, above `low` (mm over the floor fn·p + fd),
/// outside the other body parts. side = 1, 2 for the left, right arm (the nearer shoulder), 3, 4
/// for the seeds on the upper arm next to it (also in queue); dist = the distance from that
/// shoulder (mm). Returns the number of seeds.
#[allow(clippy::too_many_arguments)]
fn candidates(
    depth: &[u16],
    owner: &[i8],
    rays: &[f32],
    q: usize,
    c: &Capsules,
    sh: &[Option<[f64; 3]>; 2],
    reach: &[f64; 2],
    bones: &[f32; 8],
    (g0, g1, h0, h1): (usize, usize, usize, usize),
    low: f64,
    fnorm: [f64; 3],
    fd: f64,
    side: &mut [i8],
    dist: &mut [f32],
    gq: &mut [i32],
) -> usize {
    let [nx, ny, nz] = fnorm;
    let (sx0, sy0, sz0) = sh[0].map_or((0.0, 0.0, -1e9), |s| (s[0], s[1], s[2]));
    let (sx1, sy1, sz1) = sh[1].map_or((0.0, 0.0, -1e9), |s| (s[0], s[1], s[2]));
    let r0 = reach[0] * reach[0];
    let r1 = reach[1] * reach[1];
    let seed0 = (0.75 * f64::from(bones[0]) + 100.0).powi(2);
    let seed1 = (0.75 * f64::from(bones[2]) + 100.0).powi(2);
    let mut tail = 0;
    for gy in h0..=h1 {
        for gx in g0..=g1 {
            let g = gy * GW + gx;
            side[g] = 0;
            let i = 2 * gy * W + 2 * gx;
            if i64::from(owner[i]) != q as i64 || depth[i] == 0 {
                continue;
            }
            let d = f64::from(depth[i]);
            let x = f64::from(rays[2 * i]) * d;
            let y = f64::from(rays[2 * i + 1]) * d;
            let dl = (x - sx0) * (x - sx0) + (y - sy0) * (y - sy0) + (d - sz0) * (d - sz0);
            let dr = (x - sx1) * (x - sx1) + (y - sy1) * (y - sy1) + (d - sz1) * (d - sz1);
            let s = usize::from(dl > dr);
            let ds = if s == 1 { dr } else { dl };
            if ds > (if s == 1 { r1 } else { r0 }) || nx * x + ny * y + nz * d + fd < low {
                continue;
            }
            let core = CORE_PARTS.iter().any(|&p| c[CAP * p + 8] != 0.0 && seg(c, p, x, y, d).0 <= c[CAP * p + 6]);
            if core {
                continue;
            }
            side[g] = s as i8 + 1;
            dist[g] = ds.sqrt() as f32;
            if ds < (if s == 1 { seed1 } else { seed0 }) {
                side[g] = s as i8 + 3;
                gq[tail] = g as i32;
                tail += 1;
            }
        }
    }
    tail
}
