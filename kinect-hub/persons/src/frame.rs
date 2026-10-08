//! Step 5: one frame (persons-core.js, "5. per frame"): process(), the person list, finalize().

use std::time::Instant;

use crate::skeleton::{UidMap, lift};
use crate::tracker::{HC, HEAD, Joints, LH, MAX_LOST, NJ, PersonTracker, RH, SC, Snap, Steady, Track, Uvs};
use crate::{Floor, H, Mode, N, W, jround};

#[inline]
fn is(v: f32) -> bool {
    v != 0.0
}

/// One person of a result, as the JavaScript's person list (mm, camera frame).
#[derive(Clone, Debug, PartialEq)]
pub struct PersonOut {
    pub id: u32,
    /// 1..16, the label value of its pixels
    pub slot: u8,
    /// false while briefly hidden
    pub visible: bool,
    /// s since it got its slot
    pub age: f64,
    pub score: f64,
    pub pixels: u32,
    /// m²
    pub area: f64,
    pub centroid: [f64; 3],
    pub head: [f64; 3],
    pub ground: [f64; 3],
    /// m above the floor (top of the head; without a floor: visible height)
    pub height: f64,
    /// mm/s
    pub velocity: [f64; 3],
    /// u0, v0, u1, v1 in pixels
    pub bbox: [f64; 4],
    /// 17 x [x, y, z, confidence]
    pub joints: [[f64; 4]; 17],
    /// 17 x [u, v, confidence]
    pub keypoints: [[f64; 3]; 17],
    /// neck, pelvis, head, leftHand, rightHand: [x, y, z, confidence]
    pub extra: [[f64; 4]; 5],
    pub extra_keypoints: [[f64; 3]; 5],
}

/// What process() returns besides the per-pixel outputs.
#[derive(Clone, Debug)]
pub struct FrameResult {
    pub frame: i64,
    /// person pixels (the length of `indices`)
    pub count: usize,
    pub persons: Vec<PersonOut>,
    pub floor: Option<Floor>,
    /// ms process() took
    pub ms: f64,
    /// ms per stage: keypoints (optical flow), skeletons, segmentation, arms, output pass,
    /// background, floor and person list
    pub stages: [f64; 8],
    pub tracks: usize,
}

/// Names of FrameResult::stages.
pub const STAGES: [&str; 8] = ["flow", "skeleton", "segment", "arms", "output", "background", "floor", "list"];

#[derive(Clone, Copy)]
struct Stats {
    all: u32,
    n: u32,
    area: f64,
    sx: f64,
    sy: f64,
    sz: f64,
    su: f64,
    sv: f64,
    u0: f64,
    v0: f64,
    u1: f64,
    v1: f64,
    h_min: f64,
    h_max: f64,
}

impl Default for Stats {
    fn default() -> Self {
        Stats {
            all: 0,
            n: 0,
            area: 0.0,
            sx: 0.0,
            sy: 0.0,
            sz: 0.0,
            su: 0.0,
            sv: 0.0,
            u0: W as f64,
            v0: H as f64,
            u1: -1.0,
            v1: -1.0,
            h_min: f64::INFINITY,
            h_max: f64::NEG_INFINITY,
        }
    }
}

fn mm3(p: [f64; 3]) -> [f64; 3] {
    p.map(jround)
}

impl PersonTracker {
    /// One depth frame (mm, 0 = no measurement) with the poses set so far. Writes `labels` (slot
    /// per pixel), `masked` (the depth of the person pixels only) and `indices` (the person
    /// pixels, `count` of them). seq: the frame's number (mark_pose_frame and set_poses refer to
    /// it); ir: its infrared image, which lets the keypoints follow the persons between two poses.
    pub fn process(&mut self, depth: &[u16], labels: &mut [u8], masked: &mut [u16], indices: &mut [u32], seq: i64, ir: Option<&[u8]>) -> FrameResult {
        let t0 = Instant::now();
        let o = self.options.clone();
        self.frame += 1;
        match self.last_depth.as_mut() {
            Some(d) => d.copy_from_slice(&depth[..N]),
            None => self.last_depth = Some(depth[..N].to_vec()),
        }
        if let Some(ir) = ir
            && !self.flow.has(seq)
        {
            self.flow.push(seq, ir);
        }

        // persons without a pose for too long are gone; the others get a slot once confirmed
        let lost = jround(o.lost_seconds * o.fps);
        let keep = jround(o.keep_seconds * o.fps);
        let frame = self.frame;
        self.tracks.retain(|t| ((frame - t.last_pose) as f64) <= if t.pixels > 0 { keep } else { lost });
        if o.mode == Mode::Skeleton {
            for t in &mut self.tracks {
                t.pixels = 0;
            }
        }
        let mut used = [false; crate::MAX_PERSONS + 1];
        for t in &self.tracks {
            used[usize::from(t.slot)] = t.slot != 0;
        }
        for t in &mut self.tracks {
            if t.slot == 0
                && f64::from(t.poses) >= o.confirm_poses
                && let Some(s) = (1..=o.max_persons as usize).find(|&s| !used[s])
            {
                t.slot = s as u8;
                t.id = self.next_id;
                self.next_id += 1;
                t.since = Some(frame);
                used[s] = true;
            }
        }
        let mut stages = [0.0_f64; 8];
        let mut lap = Instant::now();
        let mut mark = |k: usize, stages: &mut [f64; 8]| {
            let now = Instant::now();
            stages[k] += (now - lap).as_secs_f64() * 1000.0;
            lap = now;
        };
        for ti in 0..self.tracks.len() {
            self.keypoints_at(ti, seq);
        }
        mark(0, &mut stages);
        self.last_seq = Some(seq);
        let mut active: Vec<usize> = Vec::new();
        for ti in 0..self.tracks.len() {
            if self.place(ti) {
                active.push(ti);
            }
        }
        mark(1, &mut stages);
        // nearer persons first: their seeds win where persons overlap in the image
        let near = |t: &Track| (0..17).filter(|&k| is(t.joints[4 * k + 3])).fold(f64::INFINITY, |z, k| z.min(f64::from(t.joints[4 * k + 2])));
        active.sort_by(|&a, &b| near(&self.tracks[a]).partial_cmp(&near(&self.tracks[b])).unwrap_or(std::cmp::Ordering::Equal));
        let masks = o.mode != Mode::Skeleton;
        if masks {
            self.segment(depth, &active);
            mark(2, &mut stages);
            self.arms(depth, &active, seq);
            mark(3, &mut stages);
        } else {
            self.owner.fill(-1);
        }

        // labels, statistics, the list of person pixels and the seeds of the next frame: one pass
        // in raster order
        let mut stats = vec![Stats::default(); active.len()];
        let f = self.floor.as_ref().or(self.feet_floor.as_ref());
        let (upx, upy, upz) = f.map_or((0.0, -1.0, 0.0), |f| (f.normal[0], f.normal[1], f.normal[2]));
        let up0 = f.map_or(0.0, |f| f.d * 1000.0);
        let slots: Vec<u8> = active.iter().map(|&i| self.tracks[i].slot).collect();
        let uids: Vec<i16> = active.iter().map(|&i| self.tracks[i].uid as i16).collect();
        let count;
        {
            let PersonTracker { rays, pix_area: pa, owner, prev_uid, prev_list, prev_count, .. } = self;
            for &c in &prev_list[..*prev_count] {
                prev_uid[c as usize] = 0;
            }
            let mut k = 0;
            let mut pc = 0;
            for i in 0..N {
                let q = owner[i];
                if q < 0 {
                    labels[i] = 0;
                    masked[i] = 0;
                    continue;
                }
                let q = q as usize;
                let d = depth[i];
                let slot = slots[q];
                labels[i] = slot;
                masked[i] = if slot != 0 { d } else { 0 };
                if slot != 0 {
                    indices[k] = i as u32;
                    k += 1;
                }
                prev_uid[i] = uids[q];
                prev_list[pc] = i as i32;
                pc += 1;
                let s = &mut stats[q];
                s.all += 1;
                if pc & 1 == 1 {
                    continue; // the statistics from every second pixel
                }
                let d = f64::from(d);
                let x = f64::from(rays[2 * i]) * d;
                let y = f64::from(rays[2 * i + 1]) * d;
                let v = (i / W) as f64;
                let u = (i % W) as f64;
                s.n += 1;
                s.area += d * d * f64::from(pa[i]);
                s.sx += x;
                s.sy += y;
                s.sz += d;
                s.su += u;
                s.sv += v;
                s.u0 = s.u0.min(u);
                s.u1 = s.u1.max(u);
                s.v0 = s.v0.min(v);
                s.v1 = s.v1.max(v);
                let h = upx * x + upy * y + upz * d + up0;
                s.h_min = s.h_min.min(h);
                s.h_max = s.h_max.max(h);
            }
            *prev_count = pc;
            count = k;
        }
        mark(4, &mut stages);
        let stale = jround(o.stale_seconds * o.fps);
        for ti in 0..self.tracks.len() {
            let q = active.iter().position(|&a| a == ti);
            if masks {
                update(&mut self.tracks[ti], q.map(|q| stats[q]));
            } else {
                self.update_skeleton(ti, q.is_some());
            }
            let t = &mut self.tracks[ti];
            t.visible = if masks { t.pixels > 0 } else { q.is_some() && ((frame - t.last_pose) as f64) <= stale };
        }
        // the background is learned once the pose model runs (before, a person could become part of it)
        if masks && self.pose_results > 0 {
            self.learn(depth, &active);
        } else if !masks {
            self.person_boxes(); // keeps the persons out of the floor estimate
        }
        self.prev_depth.copy_from_slice(&depth[..N]);
        if Some(seq) == self.snap_seq {
            self.snapshot(seq, depth);
        }
        mark(5, &mut stages);
        if o.floor {
            self.floor_step(depth);
            if self.floor.is_none() && self.frame % 15 == 0 {
                self.feet_step();
            }
        } else {
            self.floor = None;
            self.feet_floor = None;
        }
        mark(6, &mut stages);
        let persons = self.tracks.iter().filter(|t| t.slot != 0 && t.pos.is_some()).map(|t| self.describe(t)).collect();
        mark(7, &mut stages);
        FrameResult {
            frame: self.frame,
            count,
            persons,
            floor: self.floor.clone().or_else(|| self.feet_floor.clone()),
            ms: t0.elapsed().as_secs_f64() * 1000.0,
            stages,
            tracks: self.tracks.len(),
        }
    }

    fn snapshot(&mut self, seq: i64, depth: &[u16]) {
        let tracks = self.tracks.iter().filter(|t| t.pixels > 0).filter_map(|t| Some((t.uid, t.pos?, t.c2?))).collect();
        match &mut self.snap {
            Some(s) => {
                s.seq = seq;
                s.uid.copy_from_slice(&self.prev_uid);
                s.depth.copy_from_slice(&depth[..N]);
                s.tracks = tracks;
            }
            None => self.snap = Some(Snap { seq, uid: self.prev_uid.clone(), depth: depth[..N].to_vec(), tracks }),
        }
        self.snap_seq = None;
    }

    /// Skeleton mode: position, motion, box and heights from the joints (there are no pixels).
    fn update_skeleton(&mut self, ti: usize, placed: bool) {
        let f = self.floor.as_ref().or(self.feet_floor.as_ref());
        let (upx, upy, upz) = f.map_or((0.0, -1.0, 0.0), |f| (f.normal[0], f.normal[1], f.normal[2]));
        let up0 = f.map_or(0.0, |f| f.d * 1000.0);
        let t = &mut self.tracks[ti];
        t.pixels = 0;
        t.area = 0.0;
        if !placed {
            t.dpos = None;
            t.dc2 = None;
            return;
        }
        let j = &t.joints;
        let u = &t.uv;
        let mut pick: Vec<usize> = [5, 6, 11, 12].into_iter().filter(|&k| is(j[4 * k + 3])).collect();
        if pick.is_empty() {
            pick = (0..NJ).filter(|&k| is(j[4 * k + 3])).collect();
        }
        if pick.is_empty() {
            return;
        }
        let n = pick.len() as f64;
        let c = [0, 1, 2].map(|c| pick.iter().fold(0.0, |a, &k| a + f64::from(j[4 * k + c])) / n);
        let c2 = [0, 1].map(|c| pick.iter().fold(0.0, |a, &k| a + f64::from(u[3 * k + c])) / n);
        if let Some(pos) = t.pos {
            for k in 0..3 {
                t.vel[k] = 0.7 * t.vel[k] + 0.3 * (c[k] - pos[k]);
            }
        }
        t.dpos = t.pos.map(|p| [c[0] - p[0], c[1] - p[1], c[2] - p[2]]);
        t.dc2 = t.c2.map(|p| [c2[0] - p[0], c2[1] - p[1]]);
        t.pos = Some(c);
        t.c2 = Some(c2);
        let (mut u0, mut v0, mut u1, mut v1) = (W as f64, H as f64, 0.0_f64, 0.0_f64);
        let (mut h_min, mut h_max) = (f64::INFINITY, f64::NEG_INFINITY);
        for k in 0..NJ {
            if !is(j[4 * k + 3]) {
                continue;
            }
            let (uu, vv) = (f64::from(u[3 * k]), f64::from(u[3 * k + 1]));
            u0 = u0.min(uu);
            v0 = v0.min(vv);
            u1 = u1.max(uu);
            v1 = v1.max(vv);
            let h = upx * f64::from(j[4 * k]) + upy * f64::from(j[4 * k + 1]) + upz * f64::from(j[4 * k + 2]) + up0;
            h_min = h_min.min(h);
            h_max = h_max.max(h);
        }
        let pu = 0.1 * (u1 - u0) + 4.0;
        let pv = 0.06 * (v1 - v0) + 4.0;
        t.bbox = Some([
            jround(u0 - pu).max(0.0),
            jround(v0 - pv).max(0.0),
            jround(u1 + pu).min((W - 1) as f64),
            jround(v1 + pv).min((H - 1) as f64),
        ]);
        // the joints are inside the body: the top of the head lies above its center, the soles below the ankles
        t.h_min = h_min - 60.0;
        t.h_max = h_max + if is(j[4 * HEAD + 3]) { 110.0 } else { 0.0 };
    }

    /// joints, keypoints, head and ground point of a skeleton for the person list.
    #[allow(clippy::too_many_arguments, clippy::type_complexity)]
    fn skeleton_out(
        &self,
        j: &Joints,
        u: &Uvs,
        kp: &[f32; 51],
        lost: Option<&[u8; 17]>,
        pos: [f64; 3],
        h_min: f64,
        visible: bool,
    ) -> ([[f64; 4]; 17], [[f64; 3]; 17], [[f64; 4]; 5], [[f64; 3]; 5], [f64; 3], [f64; 3]) {
        let f = self.floor.as_ref().or(self.feet_floor.as_ref());
        // where it stands: below the ankles (else below the center)
        let ankles: Vec<usize> = [15, 16].into_iter().filter(|&k| is(j[4 * k + 3])).collect();
        let base = if ankles.is_empty() {
            pos
        } else {
            [0, 1, 2].map(|c| ankles.iter().fold(0.0, |a, &k| a + f64::from(j[4 * k + c])) / ankles.len() as f64)
        };
        let ground = match f {
            Some(f) => {
                let h = f.normal[0] * base[0] + f.normal[1] * base[1] + f.normal[2] * base[2] + f.d * 1000.0;
                [base[0] - f.normal[0] * h, base[1] - f.normal[1] * h, base[2] - f.normal[2] * h]
            }
            // no floor known: straight below the center, at the lowest point of the person
            None => [pos[0], -h_min, pos[2]],
        };
        let r100 = |v: f64| jround(v * 100.0) / 100.0;
        let r10 = |v: f64| jround(v * 10.0) / 10.0;
        let mut joints = [[0.0; 4]; 17];
        let mut keypoints = [[0.0; 3]; 17];
        for k in 0..17 {
            let ok = is(j[4 * k + 3]) && visible;
            joints[k] = [
                jround(f64::from(j[4 * k])),
                jround(f64::from(j[4 * k + 1])),
                jround(f64::from(j[4 * k + 2])),
                if ok { r100(f64::from(u[3 * k + 2])) } else { 0.0 },
            ];
            let conf = if lost.is_some_and(|l| l[k] > MAX_LOST) { 0.0 } else { f64::from(kp[3 * k + 2]) };
            keypoints[k] = [r10(f64::from(kp[3 * k])), r10(f64::from(kp[3 * k + 1])), r100(conf)];
        }
        let mut extra = [[0.0; 4]; 5];
        let mut extra_kp = [[0.0; 3]; 5];
        for (e, k) in [SC, HC, HEAD, LH, RH].into_iter().enumerate() {
            let ok = is(j[4 * k + 3]) && visible;
            let conf = if ok { r100(f64::from(u[3 * k + 2]).max(0.01)) } else { 0.0 };
            extra[e] = [jround(f64::from(j[4 * k])), jround(f64::from(j[4 * k + 1])), jround(f64::from(j[4 * k + 2])), conf];
            extra_kp[e] = [r10(f64::from(u[3 * k])), r10(f64::from(u[3 * k + 1])), conf];
        }
        let head = if is(j[4 * HEAD + 3]) { [f64::from(j[4 * HEAD]), f64::from(j[4 * HEAD + 1]), f64::from(j[4 * HEAD + 2])] } else { pos };
        (joints, keypoints, extra, extra_kp, mm3(head), mm3(ground))
    }

    fn describe(&self, t: &Track) -> PersonOut {
        let f = self.floor.as_ref().or(self.feet_floor.as_ref());
        let pos = t.pos.unwrap_or_default();
        let (joints, keypoints, extra, extra_keypoints, head, ground) = self.skeleton_out(&t.joints, &t.uv, &t.kp, Some(&t.lost), pos, t.h_min, t.visible);
        let fps = self.options.fps;
        PersonOut {
            id: t.id,
            slot: t.slot,
            visible: t.visible,
            age: (self.frame - t.since.unwrap_or(self.frame)) as f64 / fps,
            score: jround(t.score * 100.0) / 100.0,
            pixels: t.pixels,
            area: jround(t.area * 1000.0) / 1000.0,
            centroid: mm3(pos),
            head,
            ground,
            height: jround(if f.is_some() { t.h_max } else { t.h_max - t.h_min }) / 1000.0,
            velocity: mm3(t.vel.map(|v| v * fps)),
            bbox: t.bbox.unwrap_or([0.0; 4]),
            joints,
            keypoints,
            extra,
            extra_keypoints,
        }
    }

    /// The skeletons of a result of an earlier frame `seq`, now that the pose of a later frame is
    /// in: keypoints interpolated between the poses before and after it, lifted to 3D with that
    /// frame's depth and labels (delayed output). Changes joints, keypoints, head and ground of
    /// the persons in `result`.
    pub fn finalize(&mut self, result: &mut FrameResult, seq: i64, depth: &[u16], labels: &[u8]) {
        let mk = self.options.min_keypoint;
        for p in result.persons.iter_mut() {
            if !p.visible {
                continue;
            }
            let Some(ti) = self.tracks.iter().position(|x| x.id == p.id) else { continue };
            let t = &self.tracks[ti];
            let mut k0 = None;
            let mut k1 = None;
            for k in &t.keys {
                if k.seq <= seq {
                    k0 = Some(k);
                } else if k1.is_none() {
                    k1 = Some(k);
                }
            }
            let Some(k0) = k0 else { continue };
            if k1.is_none() && k0.seq != seq {
                continue; // no pose after it: the skeleton made at once stays
            }
            let mut kp = [0.0_f32; 51];
            match k1 {
                Some(k1) if k0.seq != seq => {
                    let w = (seq - k0.seq) as f64 / (k1.seq - k0.seq) as f64;
                    let (a, b) = (&k0.kp, &k1.kp);
                    for j in (0..51).step_by(3) {
                        if f64::from(a[j + 2]) >= mk && f64::from(b[j + 2]) >= mk {
                            kp[j] = (f64::from(a[j]) + w * (f64::from(b[j]) - f64::from(a[j]))) as f32;
                            kp[j + 1] = (f64::from(a[j + 1]) + w * (f64::from(b[j + 1]) - f64::from(a[j + 1]))) as f32;
                            kp[j + 2] = a[j + 2].min(b[j + 2]);
                        } else {
                            let c = if w < 0.5 { a } else { b };
                            kp[j] = c[j];
                            kp[j + 1] = c[j + 1];
                            kp[j + 2] = c[j + 2];
                        }
                    }
                }
                _ => kp = k0.kp,
            }
            let mut zs: Vec<f64> = p.joints.iter().filter(|j| j[3] > 0.0).map(|j| j[2]).collect();
            zs.sort_by(f64::total_cmp);
            let refz = if zs.is_empty() { 0.0 } else { zs[zs.len() >> 1] };
            let mut j: Joints = [0.0; NJ * 4];
            let mut u: Uvs = [0.0; NJ * 3];
            let lifted = {
                let t = &mut self.tracks[ti];
                let st = t.steady_final.get_or_insert_with(Steady::new);
                lift(&self.options, &self.rays, &kp, depth, &UidMap::Labels(labels), i32::from(p.slot), true, &mut j, &mut u, refz, Some(st), true)
            };
            if !lifted {
                continue;
            }
            // joints that do not lift in that frame keep the ones made at once
            for k in 0..17 {
                if is(j[4 * k + 3]) || p.joints[k][3] == 0.0 {
                    continue;
                }
                j[4 * k] = p.joints[k][0] as f32;
                j[4 * k + 1] = p.joints[k][1] as f32;
                j[4 * k + 2] = p.joints[k][2] as f32;
                j[4 * k + 3] = 1.0;
                u[3 * k + 2] = p.joints[k][3] as f32;
            }
            if let Some(st) = self.tracks[ti].steady_final.as_mut() {
                st.prev = Some(j);
            }
            let (joints, keypoints, extra, extra_keypoints, head, ground) = self.skeleton_out(&j, &u, &kp, None, p.centroid, -p.ground[1], true);
            p.joints = joints;
            p.keypoints = keypoints;
            p.extra = extra;
            p.extra_keypoints = extra_keypoints;
            p.head = head;
            p.ground = ground;
        }
    }
}

/// A person's position, motion, size and box from its pixels of this frame (None: it has none).
fn update(t: &mut Track, s: Option<Stats>) {
    let Some(s) = s.filter(|s| s.n > 0 && s.all > 0) else {
        t.pixels = 0;
        t.dpos = None;
        t.dc2 = None;
        return;
    };
    let n = f64::from(s.n);
    let c = [s.sx / n, s.sy / n, s.sz / n];
    if let Some(pos) = t.pos
        && t.pixels > 0
    {
        for k in 0..3 {
            t.vel[k] = 0.7 * t.vel[k] + 0.3 * (c[k] - pos[k]);
        }
    }
    t.dpos = match t.pos {
        Some(p) if t.pixels > 0 => Some([c[0] - p[0], c[1] - p[1], c[2] - p[2]]),
        _ => None,
    };
    t.pos = Some(c);
    let c2 = [s.su / n, s.sv / n];
    t.dc2 = match t.c2 {
        Some(p) if t.pixels > 0 => Some([c2[0] - p[0], c2[1] - p[1]]),
        _ => None,
    };
    t.c2 = Some(c2);
    t.pixels = s.all;
    t.area = s.area * f64::from(s.all) / n * 1e-6; // sampled on every second pixel
    t.bbox = Some([s.u0, s.v0, s.u1, s.v1]);
    t.h_min = s.h_min;
    t.h_max = s.h_max;
}
