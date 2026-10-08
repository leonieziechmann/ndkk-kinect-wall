//! The tracker's state, and step 1: poses -> tracks (persons-core.js, "1. poses -> tracks").

use crate::floor::FloorJob;
use crate::flow::{FlowOptions, FlowTracker};
use crate::skeleton::{UidMap, capsules, covers, depth_near, keypoint_box, keypoint_similarity, lift, ref_z};
use crate::{Floor, H, Mode, N, Options, PoseIn, W, hypot2, hypot3, jround, pinhole_rays};

// virtual joints after the 17: shoulder center, hip center, head, left hand, right hand
pub(crate) const SC: usize = 17;
pub(crate) const HC: usize = 18;
pub(crate) const HEAD: usize = 19;
pub(crate) const LH: usize = 20;
pub(crate) const RH: usize = 21;
pub(crate) const NJ: usize = 22;
/// body parts: joint a, joint b, radius (m) of the capsule around them
pub(crate) const PARTS: [(usize, usize, f64); 19] = [
    (HEAD, HEAD, 0.15),
    (HEAD, SC, 0.1),
    (5, 6, 0.1),
    (SC, HC, 0.17),
    (5, 11, 0.13),
    (6, 12, 0.13),
    (11, 12, 0.13),
    (5, 7, 0.09),
    (7, 9, 0.08),
    (9, LH, 0.09),
    (6, 8, 0.09),
    (8, 10, 0.08),
    (10, RH, 0.09),
    (11, 13, 0.11),
    (13, 15, 0.1),
    (15, 15, 0.12),
    (12, 14, 0.11),
    (14, 16, 0.1),
    (16, 16, 0.12),
];
pub(crate) const NP: usize = PARTS.len();
/// per capsule: ax, ay, az, bx, by, bz (mm), radius², reach radius², valid
pub(crate) const CAP: usize = 9;
pub(crate) const MAX_TRACKS: usize = 32;
/// a keypoint the flow could not follow for more frames is not used until the next pose
pub(crate) const MAX_LOST: u8 = 8;
/// frames a keyframe is kept after a newer one (finalize() looks back that far)
pub(crate) const KEEP_KEYS: i64 = 60;
/// mm from the far end of an arm in the mask to the wrist (pose agreement, see arms.rs)
pub(crate) const ARM_TRUST: f64 = 120.0;
/// keypoints the optical flow follows with lower demands (elbows, wrists: little texture, fast)
const RELAX_ARMS: [u8; 17] = [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0];
/// bones whose middle is sampled to see whose pixels a pose lies on (SKELETON's first 12)
const BODY_BONES: [[usize; 2]; 12] = [[5, 6], [5, 7], [7, 9], [6, 8], [8, 10], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16]];

pub(crate) type Joints = [f32; NJ * 4];
pub(crate) type Uvs = [f32; NJ * 3];
pub(crate) type Capsules = [f64; NP * CAP];

/// A pose of a person: a keyframe of its skeleton.
#[derive(Clone)]
pub(crate) struct Key {
    /// identity (the JavaScript compares the key objects)
    pub id: u64,
    pub seq: i64,
    pub kp: [f32; 51],
}

/// Depth damping and learned bone lengths of one skeleton (`steady` in the JavaScript).
#[derive(Clone)]
pub(crate) struct Steady {
    /// the joints of the last frame
    pub prev: Option<Joints>,
    pub z: [f32; 17],
    pub n: [u8; 17],
    /// learned lengths of LIMBS (a Float32Array in the JavaScript)
    pub bones: Option<[f32; 8]>,
}

impl Steady {
    pub fn new() -> Steady {
        Steady { prev: None, z: [0.0; 17], n: [0; 17], bones: None }
    }
}

#[derive(Clone)]
pub(crate) struct ArmHist {
    pub seq: i64,
    /// per side: the wrist of the mask's arm as [u, v, depth]
    pub w: [Option<[f64; 3]>; 2],
}

#[derive(Clone)]
pub(crate) struct ArmLast {
    pub seq: i64,
    pub p: [f64; 3],
}

/// One tracked person.
#[derive(Clone)]
pub(crate) struct Track {
    pub id: u32,
    pub uid: i32,
    pub slot: u8,
    pub poses: u32,
    pub last_pose: i64,
    pub score: f64,
    /// the poses, oldest first (kept while needed)
    pub keys: Vec<Key>,
    /// keypoints (u, v, conf) in frame kp_seq
    pub kp: [f32; 51],
    pub kp_seq: Option<i64>,
    /// the keyframe kp was followed from
    pub kp_key: Option<u64>,
    /// frames in a row the flow could not follow a keypoint (Uint8Array: wraps)
    pub lost: [u8; 17],
    /// frames in a row a joint was carried over (Uint16Array: wraps)
    pub joint_age: [u16; NJ],
    /// has had a skeleton
    pub lifted: bool,
    /// 3D skeleton (mm) of the current frame
    pub joints: Joints,
    pub uv: Uvs,
    pub capsules: Capsules,
    pub pos: Option<[f64; 3]>,
    pub c2: Option<[f64; 2]>,
    /// how its pixels moved in the image in the last frame
    pub dc2: Option<[f64; 2]>,
    pub dpos: Option<[f64; 3]>,
    pub vel: [f64; 3],
    pub pixels: u32,
    pub area: f64,
    pub bbox: Option<[f64; 4]>,
    pub since: Option<i64>,
    pub visible: bool,
    pub h_min: f64,
    pub h_max: f64,
    pub steady: Option<Steady>,
    /// finalize()'s damping, and the joints it made last
    pub steady_final: Option<Steady>,
    pub arm_hist: Vec<ArmHist>,
    pub arm_trust: [u8; 2],
    pub arm_last: [Option<ArmLast>; 2],
}

/// Labels and depth of the frame the pose model looks at.
pub(crate) struct Snap {
    pub seq: i64,
    pub uid: Vec<i16>,
    pub depth: Vec<u16>,
    /// the tracks with pixels then: uid -> (pos, c2)
    pub tracks: Vec<(i32, [f64; 3], [f64; 2])>,
}

impl Snap {
    pub fn has(&self, uid: i32) -> bool {
        self.tracks.iter().any(|t| t.0 == uid)
    }
}

pub struct PersonTracker {
    pub(crate) options: Options,
    pub(crate) rays: Vec<f32>,
    /// solid angle of a pixel: area in mm² = depth² * pix_area
    pub(crate) pix_area: Vec<f32>,
    /// index of the person per pixel this frame, -1 = nobody
    pub(crate) owner: Vec<i8>,
    /// body part that admitted the pixel
    pub(crate) part_of: Vec<u8>,
    pub(crate) queue: Vec<i32>,
    /// the person (uid) per pixel in the previous frame, 0 = nobody
    pub(crate) prev_uid: Vec<i16>,
    pub(crate) prev_list: Vec<i32>,
    pub(crate) prev_count: usize,
    pub(crate) prev_depth: Vec<u16>,
    /// learned background depth (mm), 0 = not known yet
    pub(crate) bg: Vec<u16>,
    pub(crate) bg_cand: Vec<u16>,
    pub(crate) bg_count: Vec<u8>,
    /// 1 = close to a person: unknown background is learned slowly
    pub(crate) near_person: Vec<u8>,
    pub(crate) uid_index: Vec<i8>,
    pub(crate) still: Vec<u16>,
    pub(crate) flow: FlowTracker,
    pub(crate) last_seq: Option<i64>,
    pub(crate) tracks: Vec<Track>,
    pub(crate) uids: i32,
    pub(crate) next_id: u32,
    pub(crate) frame: i64,
    pub(crate) pose_results: u64,
    pub(crate) snap: Option<Snap>,
    pub(crate) snap_seq: Option<i64>,
    pub(crate) last_depth: Option<Vec<u16>>,
    /// seen (RANSAC): heights, and the feet are cut off the floor
    pub(crate) floor: Option<Floor>,
    /// fallback: level, at the ankles
    pub(crate) feet_floor: Option<Floor>,
    pub(crate) feet: Vec<f64>,
    pub(crate) floor_at: i64,
    pub(crate) floor_job: Option<FloorJob>,
    pub(crate) samples: Vec<f32>,
    pub(crate) rng: u32,
    pub(crate) next_key: u64,
    // arms (arms.rs), on a grid of every second row and column
    pub(crate) arm_side: Vec<i8>,
    pub(crate) arm_dist: Vec<f32>,
    pub(crate) arm_queue: Vec<i32>,
    pub(crate) arm_tip_dist: Vec<f32>,
    pub(crate) arm_cells: [Vec<i32>; 2],
}

impl Default for PersonTracker {
    fn default() -> Self {
        PersonTracker::new(Options::default())
    }
}

impl PersonTracker {
    pub fn new(options: Options) -> PersonTracker {
        let g = (W >> 1) * (H >> 1);
        let mut t = PersonTracker {
            options,
            rays: Vec::new(),
            pix_area: vec![0.0; N],
            owner: vec![0; N],
            part_of: vec![0; N],
            queue: vec![0; N],
            prev_uid: vec![0; N],
            prev_list: vec![0; N],
            prev_count: 0,
            prev_depth: vec![0; N],
            bg: vec![0; N],
            bg_cand: vec![0; N],
            bg_count: vec![0; N],
            near_person: vec![0; N],
            uid_index: vec![-1; 32768],
            still: vec![0; N],
            flow: FlowTracker::new(W, H, FlowOptions { history: 24, relax_texture: 10.0, relax_error: 2.0, ..FlowOptions::default() }),
            last_seq: None,
            tracks: Vec::new(),
            uids: 0,
            next_id: 1,
            frame: 0,
            pose_results: 0,
            snap: None,
            snap_seq: None,
            last_depth: None,
            floor: None,
            feet_floor: None,
            feet: Vec::new(),
            floor_at: -1_000_000_000,
            floor_job: None,
            samples: Vec::new(),
            rng: 0x2545_f491,
            next_key: 0,
            arm_side: vec![0; g],
            arm_dist: vec![0.0; g],
            arm_queue: vec![0; g],
            arm_tip_dist: vec![0.0; g],
            arm_cells: [vec![0; g], vec![0; g]],
        };
        t.options.max_persons = jround(t.options.max_persons).clamp(1.0, crate::MAX_PERSONS as f64);
        t.set_rays(&pinhole_rays());
        t
    }

    pub fn options(&self) -> &Options {
        &self.options
    }

    /// Changes options (Options::set for single ones by their JavaScript name).
    pub fn options_mut(&mut self) -> &mut Options {
        &mut self.options
    }

    /// The undistortion table of the hub (f32 x,y per pixel): point = (x*z, y*z, z).
    pub fn set_rays(&mut self, rays: &[f32]) {
        if rays.len() < N * 2 {
            return;
        }
        self.rays = rays.get(..N * 2).unwrap_or(rays).to_vec();
        let r = &self.rays;
        for v in 0..H {
            for u in 0..W {
                let i = v * W + u;
                let l = if u > 0 { i - 1 } else { i };
                let rr = if u < W - 1 { i + 1 } else { i };
                let t = if v > 0 { i - W } else { i };
                let b = if v < H - 1 { i + W } else { i };
                let du = hypot2(f64::from(r[2 * rr]) - f64::from(r[2 * l]), f64::from(r[2 * rr + 1]) - f64::from(r[2 * l + 1])) / (rr - l) as f64;
                let dv = hypot2(f64::from(r[2 * b]) - f64::from(r[2 * t]), f64::from(r[2 * b + 1]) - f64::from(r[2 * t + 1])) / ((b - t) / W) as f64;
                self.pix_area[i] = (du * dv) as f32;
            }
        }
    }

    /// Forgets all persons (the next poses start new ones).
    pub fn reset(&mut self) {
        self.tracks.clear();
        self.prev_uid.fill(0);
        self.prev_count = 0;
    }

    /// Forgets the learned background (after the sensor was moved, say).
    pub fn reset_background(&mut self) {
        self.bg.fill(0);
        self.bg_count.fill(0);
    }

    /// Whether the optical flow has the infrared image of frame `seq`.
    pub fn has_ir(&self, seq: i64) -> bool {
        self.flow.has(seq)
    }

    // ---------- 1. poses -> tracks ----------

    /// The pose model starts on this frame: keep its labels and depth to match the poses against.
    pub fn mark_pose_frame(&mut self, seq: i64) {
        self.snap_seq = Some(seq);
    }

    /// Poses of the pose model, computed on frame `seq` (as passed to mark_pose_frame and
    /// process). Each becomes a keyframe of its person, matched through the labels of the frame it
    /// was computed on (mark_pose_frame, before that frame's process()).
    pub fn set_poses(&mut self, poses: &[PoseIn], seq: Option<i64>) {
        let use_snap = matches!((&self.snap, seq), (Some(s), Some(q)) if s.seq == q);
        // the labels and depth of that frame (copied out: the tracks change meanwhile)
        let (uid_map, depth): (Vec<i16>, Vec<u16>) = match (use_snap, &self.snap, &self.last_depth) {
            (true, Some(s), _) => (s.uid.clone(), s.depth.clone()),
            (_, _, Some(d)) => (self.prev_uid.clone(), d.clone()),
            _ => return,
        };
        self.pose_results += 1;
        if self.options.mode == Mode::Skeleton {
            self.match_skeletons(poses, seq, &depth, &uid_map, use_snap);
            return;
        }
        let o = self.options.clone();
        // whose pixels each pose lies on, in the frame it was computed on
        let hits: Vec<Hits> = poses.iter().map(|p| hits(p, &uid_map, o.min_keypoint)).collect();
        let mut pairs: Vec<(usize, usize, f64)> = Vec::new();
        for (pi, h) in hits.iter().enumerate() {
            for ti in 0..self.tracks.len() {
                let t = &self.tracks[ti];
                let mut s = if h.n > 0 { f64::from(h.count(t.uid)) / f64::from(h.n) } else { 0.0 };
                let seen_then = if use_snap { self.snap.as_ref().is_some_and(|sn| sn.has(t.uid)) } else { t.pixels > 0 };
                if s < 0.25
                    && let Some(pos) = t.pos
                    && !seen_then
                {
                    // hidden then (behind someone, or not yet segmented): near where it was seen last
                    if let Some(c) = self.pose_center(&poses[pi], &depth, &uid_map, t.uid) {
                        let dist = hypot3(c[0] - pos[0], c[1] - pos[1], c[2] - pos[2]);
                        if dist < 700.0 {
                            s = 0.25 + 0.25 * (1.0 - dist / 700.0);
                        }
                    }
                }
                if s >= 0.25 {
                    pairs.push((pi, ti, s));
                }
            }
        }
        sort_desc(&mut pairs);
        let mut used_p = vec![false; poses.len()];
        let mut used_t = vec![false; self.tracks.len()];
        for &(pi, ti, _) in &pairs {
            if used_p[pi] || used_t[ti] {
                continue;
            }
            used_p[pi] = true;
            used_t[ti] = true;
            self.apply_pose(ti, &poses[pi], &depth, &uid_map, use_snap, seq);
        }
        for (pi, p) in poses.iter().enumerate() {
            if used_p[pi] || p.score < o.min_score || self.tracks.len() >= MAX_TRACKS {
                continue;
            }
            // mostly on someone's pixels: a second pose of a known person, not a new one
            if hits[pi].n > 0 && f64::from(hits[pi].any) > 0.5 * f64::from(hits[pi].n) {
                continue;
            }
            let ti = self.new_track(p);
            self.apply_pose(ti, p, &depth, &uid_map, use_snap, seq);
        }
    }

    /// Skeleton mode (no labels): poses go to the person whose keypoints are most alike or whose
    /// keypoint box overlaps most; the others start new persons unless they overlap someone.
    fn match_skeletons(&mut self, poses: &[PoseIn], seq: Option<i64>, depth: &[u16], uid_map: &[i16], use_snap: bool) {
        let mk = self.options.min_keypoint;
        let min_score = self.options.min_score;
        let boxes: Vec<Option<[f64; 4]>> =
            self.tracks.iter().map(|t| if t.kp_seq.is_none() { None } else { keypoint_box(&t.kp, mk) }).collect();
        let mut pairs: Vec<(usize, usize, f64)> = Vec::new();
        for (pi, p) in poses.iter().enumerate() {
            let scale = ((p.bbox[2] - p.bbox[0]) * (p.bbox[3] - p.bbox[1])).max(1.0).sqrt();
            for (ti, b) in boxes.iter().enumerate() {
                let Some(b) = b else { continue };
                let s = keypoint_similarity(&p.kp, &self.tracks[ti].kp, scale, mk) + 0.5 * iou(&p.bbox, b);
                if s >= 0.3 {
                    pairs.push((pi, ti, s));
                }
            }
        }
        sort_desc(&mut pairs);
        let mut used_p = vec![false; poses.len()];
        let mut used_t = vec![false; self.tracks.len()];
        for &(pi, ti, _) in &pairs {
            if used_p[pi] || used_t[ti] {
                continue;
            }
            used_p[pi] = true;
            used_t[ti] = true;
            self.apply_pose(ti, &poses[pi], depth, uid_map, use_snap, seq);
        }
        for (pi, p) in poses.iter().enumerate() {
            if used_p[pi] || p.score < min_score || self.tracks.len() >= MAX_TRACKS {
                continue;
            }
            if boxes.iter().any(|b| b.is_some_and(|b| iou(&p.bbox, &b) > 0.3)) {
                continue; // a second pose of someone known
            }
            let ti = self.new_track(p);
            self.apply_pose(ti, p, depth, uid_map, use_snap, seq);
        }
    }

    fn new_track(&mut self, p: &PoseIn) -> usize {
        self.uids = (self.uids % 32000) + 1;
        self.tracks.push(Track {
            id: 0,
            uid: self.uids,
            slot: 0,
            poses: 0,
            last_pose: self.frame,
            score: p.score,
            keys: Vec::new(),
            kp: [0.0; 51],
            kp_seq: None,
            kp_key: None,
            lost: [0; 17],
            joint_age: [0; NJ],
            lifted: false,
            joints: [0.0; NJ * 4],
            uv: [0.0; NJ * 3],
            capsules: [0.0; NP * CAP],
            pos: None,
            c2: None,
            dc2: None,
            dpos: None,
            vel: [0.0; 3],
            pixels: 0,
            area: 0.0,
            bbox: None,
            since: None,
            visible: false,
            h_min: 0.0,
            h_max: 0.0,
            steady: None,
            steady_final: None,
            arm_hist: Vec::new(),
            arm_trust: [0; 2],
            arm_last: [None, None],
        });
        self.tracks.len() - 1
    }

    /// Median 3D position (mm) of a pose's keypoints that are no one else's pixels, None if none.
    fn pose_center(&self, p: &PoseIn, depth: &[u16], uid_map: &[i16], uid: i32) -> Option<[f64; 3]> {
        let (mut xs, mut ys, mut zs) = (Vec::new(), Vec::new(), Vec::new());
        let rays = &self.rays;
        for k in 0..17 {
            if f64::from(p.kp[3 * k + 2]) < self.options.min_keypoint {
                continue;
            }
            let u = jround(f64::from(p.kp[3 * k]));
            let v = jround(f64::from(p.kp[3 * k + 1]));
            if u < 0.0 || v < 0.0 || u > (W - 1) as f64 || v > (H - 1) as f64 {
                continue;
            }
            let i = v as usize * W + u as usize;
            let owner = i32::from(uid_map[i]);
            if owner != 0 && owner != uid {
                continue;
            }
            let d = depth_near(&self.options, depth, u, v, None, 0, 3, false);
            if d == 0.0 {
                continue;
            }
            xs.push(f64::from(rays[2 * i]) * d);
            ys.push(f64::from(rays[2 * i + 1]) * d);
            zs.push(d);
        }
        if zs.is_empty() {
            return None;
        }
        let med = |a: &mut Vec<f64>| {
            a.sort_by(f64::total_cmp);
            a[a.len() >> 1]
        };
        Some([med(&mut xs), med(&mut ys), med(&mut zs)])
    }

    fn apply_pose(&mut self, ti: usize, p: &PoseIn, depth: &[u16], uid_map: &[i16], use_snap: bool, seq: Option<i64>) {
        let skeleton = self.options.mode == Mode::Skeleton;
        let seen = !skeleton
            && if use_snap { self.snap.as_ref().is_some_and(|s| s.has(self.tracks[ti].uid)) } else { self.tracks[ti].pixels > 0 };
        let frame = self.frame;
        let refz = ref_z(&self.tracks[ti]);
        {
            let t = &mut self.tracks[ti];
            t.score = p.score;
            t.poses += 1;
            t.last_pose = frame;
        }
        let uid = self.tracks[ti].uid;
        // a pose that does not lift (all keypoints hidden), or a skeleton that does not cover the
        // person's pixels of that frame (keypoints on the background next to it): the person
        // keeps its keypoints
        let mut j: crate::tracker::Joints = [0.0; NJ * 4];
        let mut uv: Uvs = [0.0; NJ * 3];
        if !lift(&self.options, &self.rays, &p.kp, depth, &UidMap::Uid(uid_map), uid, seen, &mut j, &mut uv, refz, None, false) {
            return;
        }
        if seen && self.tracks[ti].lifted {
            let mut c: Capsules = [0.0; NP * CAP];
            capsules(&self.options, &j, &mut c);
            if covers(&c, &self.rays, uid_map, depth, uid) < 0.7 {
                return;
            }
        }
        let key_seq = if use_snap { seq.unwrap_or(0) } else { self.last_seq.unwrap_or(0) };
        self.add_key(ti, key_seq, &p.kp);
    }

    fn add_key(&mut self, ti: usize, seq: i64, kp: &[f32; 51]) {
        self.next_key += 1;
        let mk = self.options.min_keypoint;
        let t = &mut self.tracks[ti];
        t.keys.push(Key { id: self.next_key, seq, kp: *kp });
        t.keys.sort_by_key(|k| k.seq);
        t.lifted = true;
        // the arms the mask had in that frame (arms.rs): where the pose has them? Then they are used.
        let Some(h) = t.arm_hist.iter().find(|a| a.seq == seq).cloned() else { return };
        for s in 0..2 {
            let k = 9 + s;
            let Some(w) = h.w[s] else { continue };
            if f64::from(kp[3 * k + 2]) < mk {
                continue;
            }
            let tol = (ARM_TRUST * 370.0 / w[2]).max(8.0);
            t.arm_trust[s] = u8::from(hypot2(w[0] - f64::from(kp[3 * k]), w[1] - f64::from(kp[3 * k + 1])) < tol);
        }
    }

    /// The keypoints of a person in frame seq: from its newest keyframe up to it, followed by the
    /// optical flow (finalize() makes them exact later, between the keyframes before and after).
    pub(crate) fn keypoints_at(&mut self, ti: usize, seq: i64) {
        let t = &mut self.tracks[ti];
        let mut i0: isize = -1;
        for (i, k) in t.keys.iter().enumerate() {
            if k.seq <= seq {
                i0 = i as isize;
            }
        }
        if i0 < 0 {
            return; // no pose up to this frame yet
        }
        while i0 > 0 && t.keys.first().is_some_and(|k| k.seq < seq - KEEP_KEYS) {
            t.keys.remove(0);
            i0 -= 1;
        }
        let k0 = &t.keys[i0 as usize];
        if t.kp_key != Some(k0.id) {
            t.kp = k0.kp;
            t.kp_seq = Some(k0.seq);
            t.kp_key = Some(k0.id);
            t.lost = [0; 17];
        }
        self.advance(ti, seq);
    }

    /// Moves the keypoints of a person to frame seq (optical flow on the infrared image).
    fn advance(&mut self, ti: usize, seq: i64) {
        let mk = self.options.min_keypoint;
        let t = &mut self.tracks[ti];
        let from = match t.kp_seq {
            Some(s) if s != seq => s,
            _ => {
                t.kp_seq = Some(seq);
                return;
            }
        };
        let mut pts = [0.0_f32; 34];
        let mut use_ = [0_u8; 17];
        for k in 0..17 {
            pts[2 * k] = t.kp[3 * k];
            pts[2 * k + 1] = t.kp[3 * k + 1];
            use_[k] = u8::from(f64::from(t.kp[3 * k + 2]) >= mk);
        }
        // a visible person's arms are followed with lower demands; a hidden person's points get
        // lost (they would follow the background)
        let relax = if t.pixels > 0 { Some(&RELAX_ARMS[..]) } else { None };
        if self.flow.track(from, seq, &mut pts, 17, &use_, &mut t.lost, true, relax) {
            for k in 0..17 {
                t.kp[3 * k] = pts[2 * k];
                t.kp[3 * k + 1] = pts[2 * k + 1];
            }
        } else if let Some(d) = t.dc2 {
            // no infrared for these frames: the keypoints move with the person's pixels
            for k in 0..17 {
                t.kp[3 * k] = (f64::from(t.kp[3 * k]) + d[0]) as f32;
                t.kp[3 * k + 1] = (f64::from(t.kp[3 * k + 1]) + d[1]) as f32;
            }
        }
        t.kp_seq = Some(seq);
    }
}

/// Samples along a pose (keypoints, middles of the bones): how many lie on whose pixels.
struct Hits {
    n: u32,
    any: u32,
    /// uid -> count, in the order first seen
    by: Vec<(i32, u32)>,
}

impl Hits {
    fn count(&self, uid: i32) -> u32 {
        self.by.iter().find(|b| b.0 == uid).map_or(0, |b| b.1)
    }
}

fn hits(p: &PoseIn, uid_map: &[i16], mk: f64) -> Hits {
    let kp = &p.kp;
    let mut h = Hits { n: 0, any: 0, by: Vec::new() };
    let mut sample = |u: f64, v: f64| {
        h.n += 1;
        let ui = jround(u) as i64;
        let vi = jround(v) as i64;
        let mut id = 0_i32;
        for k in 0..5 {
            if id != 0 {
                break;
            }
            let x = ui + if k == 1 { -2 } else if k == 2 { 2 } else { 0 };
            let y = vi + if k == 3 { -2 } else if k == 4 { 2 } else { 0 };
            if x >= 0 && y >= 0 && x < W as i64 && y < H as i64 {
                id = i32::from(uid_map[y as usize * W + x as usize]);
            }
        }
        if id == 0 {
            return;
        }
        h.any += 1;
        match h.by.iter_mut().find(|b| b.0 == id) {
            Some(b) => b.1 += 1,
            None => h.by.push((id, 1)),
        }
    };
    for k in 0..17 {
        if f64::from(kp[3 * k + 2]) >= mk {
            sample(f64::from(kp[3 * k]), f64::from(kp[3 * k + 1]));
        }
    }
    for [a, b] in BODY_BONES {
        if f64::from(kp[3 * a + 2]) >= mk && f64::from(kp[3 * b + 2]) >= mk {
            sample(
                (f64::from(kp[3 * a]) + f64::from(kp[3 * b])) / 2.0,
                (f64::from(kp[3 * a + 1]) + f64::from(kp[3 * b + 1])) / 2.0,
            );
        }
    }
    h
}

pub(crate) fn iou(a: &[f64; 4], b: &[f64; 4]) -> f64 {
    let x0 = a[0].max(b[0]);
    let y0 = a[1].max(b[1]);
    let x1 = a[2].min(b[2]);
    let y1 = a[3].min(b[3]);
    let inter = (x1 - x0).max(0.0) * (y1 - y0).max(0.0);
    let area = |r: &[f64; 4]| (r[2] - r[0]).max(0.0) * (r[3] - r[1]).max(0.0);
    inter / (area(a) + area(b) - inter).max(1e-6)
}

/// Stable sort by score, highest first (JavaScript: pairs.sort((a, b) => b.s - a.s)).
fn sort_desc(pairs: &mut [(usize, usize, f64)]) {
    pairs.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
}
