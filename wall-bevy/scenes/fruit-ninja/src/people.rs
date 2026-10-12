//! The people (people.js): their silhouettes on the wall (from the masks, exact every frame) and
//! their blades.
//!
//! Silhouettes: every person pixel of the tracking result goes into the room and onto the wall as
//! the wall core maps it (mirrored, the walk stretched over the wall, the body in real size), into a
//! grid of cells (RES per art pixel). A cell is covered when enough of it is covered by the person
//! (area in m², the same near the sensor and far away). Each cell then gets a piece of the ninja
//! costume from the skeleton (ninja.rs). This is the costly part (every person pixel of every
//! result), so a worker thread of the scene makes it (Mask::make) while the frames go on: a result's
//! silhouettes show from the frame after it came, the frame never waits for them.
//!
//! Blades: the hands of the skeleton (on the wall, in meters). A hand cuts while it got far fast:
//! its way over the last WIN s, faster than `cutSpeed`, with this update going the same way. That
//! holds through an update in which the live skeleton stalls (it loses fast wrists now and then and
//! catches up with the next pose), while a point that jumps out and back gets nowhere and never
//! cuts. One that teleports (more than `maxJump` in one update, or faster than `maxSpeed`) starts a
//! new blade. The cut is the swept segment between two updates, so a fast hand also cuts what lies
//! between two tracking results; when a swipe starts, its way within the window cuts too.
//!
//! The hands are the raw points of the tracker (p.camera): the smoothed joints lag about 5 cm
//! behind on fast arms, and the rule above does not mind a little jitter. With live + exact tracking
//! the blades run on the live skeletons, and the exact skeletons of the same frames, 150-250 ms
//! later, run blades of their own: a swipe that live missed still cuts then (game.rs, late cuts),
//! against where the fruit was at that moment.
//!
//! Not ported: the test players, the mouse blade and the globalThis hooks of the browser page (the
//! output has no pointer and no console).

use std::collections::VecDeque;
use std::sync::Arc;

use wall::glam::Vec3;
use crossbeam_channel::{Receiver, Sender, TrySendError};

use wall::kinect::KinectData;
use wall::persons::{Person, PersonsResult, SLOTS, ViewMode, j};
use wall::map::WallMap;

use super::ninja::{Prep, Sk, dress, skeleton_of};
use super::pix::Rgb;
use super::{Layout, P, color_of};

const FOCAL: f32 = 366.0; // Kinect v2 depth camera, px: a pixel at z m covers (z / FOCAL)² m²
const HANDS: [usize; 2] = [j::LEFT_HAND, j::RIGHT_HAND];
const WIN: f64 = 0.1; // s
/// cells of the silhouettes per art pixel: 1.2 cm, as fine as the fruit
pub const RES: usize = 2;
/// index in p.camera.extra (neck, pelvis, head, leftHand, rightHand)
const EXTRA_HAND: [usize; 2] = [3, 4];

/// Who a blade belongs to: a hand of a live person, the same hand in the exact skeletons, a
/// scripted blade (the demo of the attract mode).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BladeKey {
    Hand(u32, u8),
    Exact(u32, u8),
    Script(u32),
}

#[derive(Clone, Copy)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
    pub t: f64,
    /// when it is shown (exact blades: the woosh starts when their frame comes in)
    pub a: f64,
}

/// A cutting segment: wall m, s, m/s.
#[derive(Clone, Copy)]
pub struct Seg {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub t0: f64,
    pub t1: f64,
    pub v: f64,
    pub key: BladeKey,
    pub id: Option<u32>,
    pub slot: u8,
}

pub struct Blade {
    pub key: BladeKey,
    /// the key of its cuts (combos): the exact blade of a hand cuts as its live one
    seg_key: BladeKey,
    /// person id (None: a demo)
    pub id: Option<u32>,
    pub slot: u8,
    pub col: Rgb,
    pub pts: Vec<Pt>,
    pub x: Option<f64>,
    pub y: f64,
    pub t: f64,
    pub cutting: bool,
    seen: f64,
}

impl Blade {
    fn new(key: BladeKey, seg_key: BladeKey, id: Option<u32>, slot: u8, col: Rgb) -> Self {
        Self { key, seg_key, id, slot, col, pts: Vec::with_capacity(32), x: None, y: 0.0, t: 0.0, cutting: false, seen: 0.0 }
    }

    /// A new position (wall m) at time t (s); pushes the segments that cut into `segs`. arrive:
    /// when it is shown (exact blades: their frame is older, the woosh starts when it comes in).
    fn sample(&mut self, x: f64, y: f64, t: f64, p: &P, segs: &mut Vec<Seg>, arrive: f64) {
        self.seen = t;
        let Some(bx) = self.x else {
            self.x = Some(x);
            self.y = y;
            self.t = t;
            self.pts.push(Pt { x, y, t, a: arrive });
            return;
        };
        let dt = t - self.t;
        if dt <= 1e-4 {
            return;
        }
        let dx = x - bx;
        let dy = y - self.y;
        let d = dx.hypot(dy);
        if dt > 0.3 || d > p.max_jump || d / dt > p.max_speed {
            // lost for a while, or a jump of the skeleton: start over here
            self.x = Some(x);
            self.y = y;
            self.t = t;
            self.cutting = false;
            self.pts.clear();
            self.pts.push(Pt { x, y, t, a: arrive });
            return;
        }
        // how far the hand got over the last WIN s: a swipe gets far, also when the skeleton stalls
        // for an update and then catches up; a point that jumps out and back gets nowhere
        let mut r = 0;
        for k in (0..self.pts.len()).rev() {
            if t - self.pts[k].t >= WIN {
                r = k;
                break;
            }
        }
        let Some(&rp) = self.pts.get(r) else { return };
        let wx = x - rp.x;
        let wy = y - rp.y;
        let wd = wx.hypot(wy);
        let vw = wd / (t - rp.t).max(WIN);
        let along = if d > 1e-6 && wd > 1e-6 { (dx * wx + dy * wy) / (d * wd) } else { 0.0 };
        let was = self.cutting;
        self.cutting = (vw >= p.cut_speed && along > 0.3) || (was && vw >= p.cut_speed * 0.6 && along > -0.2);
        if self.cutting && d > 0.005 {
            let seg = |a: (f64, f64, f64), b: (f64, f64, f64)| Seg { x0: a.0, y0: a.1, x1: b.0, y1: b.1, t0: a.2, t1: b.2, v: vw, key: self.seg_key, id: self.id, slot: self.slot };
            // the swipe began before this update: its path within the window cuts too
            if !was {
                for k in r + 1..self.pts.len() {
                    let (a, b) = (self.pts[k - 1], self.pts[k]);
                    segs.push(seg((a.x, a.y, a.t), (b.x, b.y, b.t)));
                }
            }
            segs.push(seg((bx, self.y, self.t), (x, y, t)));
        }
        self.x = Some(x);
        self.y = y;
        self.t = t;
        self.pts.push(Pt { x, y, t, a: arrive });
    }

    /// forget points older than `keep` s
    fn trim(&mut self, now: f64, keep: f64) {
        let mut n = 0;
        while n + 1 < self.pts.len() && now - self.pts[n].t > keep {
            n += 1;
        }
        if n > 0 {
            self.pts.drain(..n);
        }
    }
}

/// the blade of `key` (made by `make` if there is none yet)
fn blade_mut(list: &mut Vec<Blade>, key: BladeKey, make: impl FnOnce() -> Blade) -> &mut Blade {
    let i = match list.iter().position(|b| b.key == key) {
        Some(i) => i,
        None => {
            list.push(make());
            list.len() - 1
        }
    };
    &mut list[i]
}

/// The silhouettes on the wall: per cell the slot of the front-most person (0 = nobody), the piece
/// of the costume (ninja::part) and its shade (ninja::shade).
pub struct Mask {
    /// cells across, down (art pixels * RES)
    pub aw: usize,
    pub ah: usize,
    area: Vec<f32>,
    front: Vec<u16>,
    pub cell: Vec<u8>,
    pub part: Vec<u8>,
    pub shade: Vec<u8>,
    tmp: Vec<u8>,
    /// sums of 3 across of the rows above, at and below a cell (the cleanup of the cells)
    sums: [Vec<u8>; 3],
    pub any: bool,
    /// x0, y0, x1, y1 (cells, inclusive): where the people are
    pub bbox: Option<[i32; 4]>,
    /// cells per slot
    count: [u32; 256],
    last_shade: u8,
}

impl Mask {
    fn new(aw: usize, ah: usize) -> Self {
        let n = aw * ah;
        Self {
            aw,
            ah,
            area: vec![0.0; n],
            front: vec![0; n],
            cell: vec![0; n],
            part: vec![0; n],
            shade: vec![0; n],
            tmp: vec![0; n],
            sums: [Vec::with_capacity(aw), Vec::with_capacity(aw), Vec::with_capacity(aw)],
            any: false,
            bbox: None,
            count: [0; 256],
            last_shade: 0,
        }
    }

    /// whether the person of `slot` has a body on the wall
    fn shown(&self, slot: u8) -> bool {
        self.count[usize::from(slot)] >= 150
    }

    /// The cells of a tracking result and their costume (in the worker thread).
    fn make(&mut self, job: &JobIn) {
        self.build(&job.kp, &job.rays, job.x_sign, &job.wall, job.ppm, job.cover);
        self.count_cells();
        if let Some(bb) = self.bbox {
            dress(&self.cell, &mut self.part, &mut self.shade, self.aw, bb, &job.preps, 1.0 / job.ppm, job.top, &mut self.last_shade);
        }
    }

    /// how many cells each slot covers (a track with a skeleton but no body on the wall shows nothing)
    fn count_cells(&mut self) {
        self.count.fill(0);
        let (Some(bb), true) = (self.bbox, self.any) else { return };
        for y in bb[1]..=bb[3] {
            let row = y as usize * self.aw;
            let Some(cells) = self.cell.get(row + bb[0] as usize..=row + bb[2] as usize) else { continue };
            for &c in cells {
                self.count[usize::from(c)] += 1;
            }
        }
    }

    /// the masks -> the cells of the wall (ppm: cells per m)
    fn build(&mut self, kp: &PersonsResult, rays: &[f32], x_sign: f32, wall: &WallMap, ppm: f64, cover: f64) {
        let (aw, ah) = (self.aw, self.ah);
        let n = aw * ah;
        if self.area.len() != n || self.front.len() != n || self.cell.len() != n || self.tmp.len() != n || aw < 3 || ah < 3 {
            return;
        }
        self.area.fill(0.0);
        self.front.fill(0xffff);
        self.cell.fill(0);
        let s = &wall.setup;
        let per_person = wall.projection.per_person;
        let top = s.bottom + s.size_h;
        let [near, far] = wall.zone(); // the projection's zone, room z (m from the sensor)
        let ppm = ppm as f32;
        // the area of a point: its size on the wall is the person's (× the body scale)
        let mut size = [1.0_f32; 256];
        for (s, k) in size.iter_mut().enumerate().take(SLOTS) {
            if per_person && wall.visible[s] {
                *k = wall.scale[s];
            }
        }
        let (awf, ahf) = (aw as f32, ah as f32);
        // only the box around the people is worked on afterwards
        let (mut bx0, mut by0, mut bx1, mut by1) = (aw, ah, 0_usize, 0_usize);
        let mut seen = false;
        if let (Some(labels), Some(depth), Some(indices)) = (&kp.labels, &kp.depth, &kp.indices) {
            let (labels, depth, indices): (&[u8], &[u16], &[u32]) = (labels, depth, indices);
            let indices = &indices[..kp.count.min(indices.len())];
            let (area, front, tmp) = (&mut self.area[..], &mut self.front[..], &mut self.tmp[..]);
            let [m0, m1, m2, _, m4, m5, m6, _, m8, m9, m10, _, m12, m13, m14, _] = wall.room;
            for &i in indices {
                let i = i as usize;
                let Some(&mm) = depth.get(i) else { continue };
                if mm < 100 {
                    continue;
                }
                let (Some(&sl), Some(&rx0), Some(&ry0)) = (labels.get(i), rays.get(2 * i), rays.get(2 * i + 1)) else { continue };
                let z = f32::from(mm) * 0.001;
                let wx = x_sign * rx0 * z;
                let wy = -ry0 * z;
                let rz = m2 * wx + m6 * wy + m10 * z + m14;
                if rz < near || rz > far {
                    continue;
                }
                let rx = m0 * wx + m4 * wy + m8 * z + m12;
                let ry = m1 * wx + m5 * wy + m9 * z + m13;
                let si = usize::from(sl);
                // the scene's projection: the body around the person's place (its size × scale), or every point
                let ax = wall.room_x(rx, rz, si) * ppm;
                let ay = (top - wall.room_y(ry, si)) * ppm;
                // (a value >= 0 truncates to its floor)
                if !(ax >= 0.0 && ax < awf && ay >= 0.0 && ay < ahf) {
                    continue;
                }
                let (ax, ay) = (ax as usize, ay as usize);
                let c = ay * aw + ax;
                let (Some(a), Some(fr), Some(tm)) = (area.get_mut(c), front.get_mut(c), tmp.get_mut(c)) else { continue };
                let f = (z / FOCAL) * size[si];
                *a += f * f;
                seen = true;
                bx0 = bx0.min(ax);
                bx1 = bx1.max(ax);
                by0 = by0.min(ay);
                by1 = by1.max(ay);
                if mm < *fr {
                    *fr = mm;
                    *tm = sl;
                }
            }
        }
        let need = cover as f32 / (ppm * ppm);
        self.bbox = None;
        if !seen {
            self.any = false;
            return;
        }
        let bx0 = bx0.saturating_sub(1).max(1);
        let by0 = by0.saturating_sub(1).max(1);
        let bx1 = (bx1 + 1).min(aw - 2);
        let by1 = (by1 + 1).min(ah - 2);
        self.bbox = Some([(bx0 - 1) as i32, (by0 - 1) as i32, (bx1 + 1) as i32, (by1 + 1) as i32]);
        let mut any = false;
        for y in by0 - 1..=by1 + 1 {
            for c in y * aw + bx0 - 1..=y * aw + bx1 + 1 {
                if self.area[c] >= need {
                    self.cell[c] = self.tmp[c];
                    any = true;
                }
            }
        }
        // close single holes, drop single specks: the covered cells among the 8 neighbors (in a copy),
        // from sums of 3 across that roll down the rows
        self.tmp.copy_from_slice(&self.cell);
        let (tmp, cell) = (&self.tmp[..], &mut self.cell[..]);
        let [up, mid, dn] = &mut self.sums;
        let sums = |row: usize, out: &mut Vec<u8>| {
            out.clear();
            if let Some(r) = tmp.get(row * aw + bx0 - 1..=row * aw + bx1 + 1) {
                out.extend(r.windows(3).map(|w| u8::from(w[0] != 0) + u8::from(w[1] != 0) + u8::from(w[2] != 0)));
            }
        };
        sums(by0 - 1, up);
        sums(by0, mid);
        for y in by0..=by1 {
            sums(y + 1, dn);
            for (k, x) in (bx0..=bx1).enumerate() {
                let c = y * aw + x;
                let me = tmp[c];
                let (Some(&a), Some(&b), Some(&d)) = (up.get(k), mid.get(k), dn.get(k)) else { continue };
                let n = a + b + d - u8::from(me != 0);
                if me == 0 && n >= 6 {
                    // the slot of the last covered neighbor (rows top down, each left to right)
                    let order = [c + aw + 1, c + aw, c + aw - 1, c + 1, c - 1, c - aw + 1, c - aw, c - aw - 1];
                    cell[c] = order.iter().map(|&o| tmp[o]).find(|&v| v != 0).unwrap_or(0);
                } else if me != 0 && n <= 1 {
                    cell[c] = 0;
                }
            }
            std::mem::swap(up, mid);
            std::mem::swap(mid, dn);
        }
        self.tmp.fill(0);
        self.any = any;
    }
}

/// What the worker makes a mask from: a tracking result, the wall as it maps it, the skeletons.
struct JobIn {
    kp: Arc<PersonsResult>,
    rays: Arc<Vec<f32>>,
    x_sign: f32,
    wall: WallMap,
    /// cells per m, wall y of the top edge, the cover param
    ppm: f64,
    top: f64,
    cover: f64,
    /// per slot
    preps: Vec<Prep>,
}

/// A job for the worker: the mask to fill and what to fill it from (both come back).
struct Job {
    mask: Mask,
    input: JobIn,
}

fn worker(jobs: Receiver<Job>, done: Sender<Job>) {
    while let Ok(mut job) = jobs.recv() {
        job.mask.make(&job.input);
        if done.send(job).is_err() {
            break;
        }
    }
}

/// A person on the wall this frame.
#[derive(Clone)]
pub struct Shown {
    pub id: u32,
    pub slot: u8,
    pub col: Rgb,
    /// wall x of the body center, the head (m)
    pub x: f64,
    pub head_x: f64,
    pub head_y: f64,
    /// the skeleton (wall m)
    pub sk: Sk,
    /// the head's velocity (m/s), for the headband
    pub hv: [f64; 2],
}

struct Head {
    x: f64,
    y: f64,
    t: f64,
    vx: f64,
    vy: f64,
}

struct Script {
    key: u32,
    pts: [[f64; 2]; 5],
    t0: Option<f64>,
    dur: f64,
}

pub struct People {
    /// the silhouettes shown: the newest the worker made
    pub mask: Mask,
    /// a free mask and the skeletons for the next result (None while the worker has them)
    spare: Option<(Mask, Vec<Prep>)>,
    jobs: Sender<Job>,
    done: Receiver<Job>,
    /// this frame's skeletons per slot
    preps: Vec<Prep>,
    pub blades: Vec<Blade>,
    pub exact_blades: Vec<Blade>,
    /// the persons on the wall
    pub list: Vec<Shown>,
    heads: Vec<(u32, Head)>,
    /// the cutting segments of this frame, those of the exact skeletons that came in this frame
    pub segs: Vec<Seg>,
    pub late_segs: Vec<Seg>,
    /// live frame seq -> when it was shown (s): the time of an exact frame
    seq_time: VecDeque<(u32, f64)>,
    scripts: Vec<Script>,
    next_script: u32,
    last_data: f64,
}

impl People {
    pub fn new(aw: usize, ah: usize) -> Result<Self, String> {
        let (jobs, rx) = crossbeam_channel::bounded::<Job>(1);
        let (tx, done) = crossbeam_channel::bounded::<Job>(1);
        std::thread::Builder::new().name("fruit-ninja people".into()).spawn(move || worker(rx, tx)).map_err(|e| format!("fruit-ninja: kein Thread für die Silhouetten: {e}"))?;
        Ok(Self {
            mask: Mask::new(aw, ah),
            spare: Some((Mask::new(aw, ah), vec![Prep::new(); SLOTS])),
            jobs,
            done,
            preps: vec![Prep::new(); SLOTS],
            blades: Vec::with_capacity(32),
            exact_blades: Vec::with_capacity(32),
            list: Vec::with_capacity(16),
            heads: Vec::with_capacity(70),
            segs: Vec::with_capacity(64),
            late_segs: Vec::with_capacity(64),
            seq_time: VecDeque::with_capacity(250),
            scripts: Vec::with_capacity(4),
            next_script: 0,
            last_data: -1.0,
        })
    }

    /// another size of the cells (the layout changed)
    pub fn resize(&mut self, aw: usize, ah: usize) {
        self.mask = Mask::new(aw, ah);
        if let Some((m, _)) = &mut self.spare {
            *m = Mask::new(aw, ah);
        }
    }

    /// a scripted blade along the points (wall m) over `dur` s (the demo in the attract mode)
    pub fn script(&mut self, pts: [[f64; 2]; 5], dur: f64) {
        self.next_script = self.next_script.wrapping_add(1);
        self.scripts.push(Script { key: self.next_script, pts, t0: None, dur });
    }

    /// whether the person of `slot` has a body on the wall
    pub fn shown(&self, slot: u8) -> bool {
        self.mask.shown(slot)
    }

    /// The people of this frame: masks, skeletons, blades. now: real time (s).
    pub fn update(&mut self, wall: &WallMap, k: &KinectData, l: &Layout, p: &P, now: f64) {
        self.segs.clear();
        // a mask the worker made: shown from now on (one made for another size is dropped)
        if let Ok(job) = self.done.try_recv() {
            let Job { mask, input } = job;
            let (aw, ah) = (self.mask.aw, self.mask.ah);
            let old = if mask.aw == aw && mask.ah == ah { std::mem::replace(&mut self.mask, mask) } else { Mask::new(aw, ah) };
            self.spare = Some((old, input.preps));
        }
        let view = &*k.view;
        let fresh = view.fresh && k.persons.is_some();
        if fresh {
            self.last_data = now;
            if let Some(seq) = view.seq {
                match self.seq_time.iter_mut().find(|e| e.0 == seq) {
                    Some(e) => e.1 = now,
                    None => {
                        self.seq_time.push_back((seq, now));
                        if self.seq_time.len() > 240 {
                            self.seq_time.pop_front();
                        }
                    }
                }
            }
        } else if self.mask.any && now - self.last_data > 0.5 {
            self.mask.cell.fill(0);
            self.mask.any = false;
        }

        // the persons, their skeletons and their hands
        self.list.clear();
        for pp in &mut self.preps {
            pp.on = false;
        }
        for q in &wall.persons {
            if !q.in_zone {
                continue;
            }
            let Some(person) = view.by_id(q.id) else { continue };
            let col = color_of(q.slot);
            let head = match person.head {
                Some(h) => {
                    let w = wall.from_world(h, usize::from(q.slot));
                    [f64::from(w.x), f64::from(w.y)]
                }
                None => [f64::from(q.x), f64::from(q.y) + 0.6],
            };
            let sk = skeleton_of(wall, person);
            if let Some(pp) = self.preps.get_mut(usize::from(q.slot)) {
                pp.fill(&sk);
            }
            let hv = self.head_vel(q.id, sk[j::HEAD].unwrap_or(head), now);
            self.list.push(Shown { id: q.id, slot: q.slot, col, x: f64::from(q.x), head_x: head[0], head_y: head[1], sk, hv });
            // a track with a skeleton but no body on the wall (a ghost of the tracker) does not cut
            if !fresh || !self.mask.shown(q.slot) {
                continue;
            }
            for h in 0..2u8 {
                let Some(pt) = hand(wall, person, usize::from(h), p) else { continue };
                let key = BladeKey::Hand(q.id, h);
                let b = blade_mut(&mut self.blades, key, || Blade::new(key, key, Some(q.id), q.slot, col));
                b.slot = q.slot;
                b.col = col;
                b.sample(pt[0], pt[1], now, p, &mut self.segs, now);
            }
        }
        // the new result's silhouettes, with these skeletons: to the worker (busy: skipped, the next
        // result comes in 33 ms)
        if fresh
            && let Some(kp) = &k.persons
            && let Some((mut mask, mut preps)) = self.spare.take()
        {
            let (aw, ah) = (self.mask.aw, self.mask.ah);
            if mask.aw != aw || mask.ah != ah {
                mask = Mask::new(aw, ah);
            }
            for (to, from) in preps.iter_mut().zip(&self.preps) {
                to.copy_from(from);
            }
            let input = JobIn { kp: kp.clone(), rays: k.rays(), x_sign: k.x_sign, wall: wall.clone(), ppm: l.ppm * RES as f64, top: l.top, cover: p.cover, preps };
            match self.jobs.try_send(Job { mask, input }) {
                Ok(()) => {}
                Err(TrySendError::Full(job) | TrySendError::Disconnected(job)) => self.spare = Some((job.mask, job.input.preps)),
            }
        }

        // the exact skeletons (live + exact): blades of their own, at the time their frame was live
        self.late_segs.clear();
        if k.mode == ViewMode::Both && p.late_cuts {
            // the frames of one burst come in together: they are shown one after the other, as a sweep
            let mut first: Option<f64> = None;
            for ex in &k.exact_updates {
                let Some(seq) = ex.seq else { continue };
                let Some(t) = self.seq_time.iter().find(|e| e.0 == seq).map(|e| e.1) else { continue };
                let first = *first.get_or_insert(t);
                let arrive = now + (t - first) * 0.6;
                for person in &ex.visible {
                    for h in 0..2u8 {
                        let Some(pt) = hand(wall, person, usize::from(h), p) else { continue };
                        let key = BladeKey::Exact(person.id, h);
                        let b = blade_mut(&mut self.exact_blades, key, || Blade::new(key, BladeKey::Hand(person.id, h), Some(person.id), person.slot, color_of(person.slot)));
                        b.slot = person.slot;
                        if t > b.t {
                            b.sample(pt[0], pt[1], t, p, &mut self.late_segs, arrive);
                        }
                    }
                }
            }
            for b in &mut self.exact_blades {
                b.trim(now, (2.0 * WIN).max(now - b.t + p.woosh_life));
            }
            self.exact_blades.retain(|b| now - b.seen <= 1.5);
        }

        // scripted blades
        let mut i = self.scripts.len();
        while i > 0 {
            i -= 1;
            let Some(s) = self.scripts.get_mut(i) else { continue };
            let t0 = *s.t0.get_or_insert(now);
            let u = ((now - t0) / s.dur).min(1.0);
            let last = s.pts.len() - 1;
            let f = u * last as f64;
            let fl = if f.is_finite() { f.floor().max(0.0) as usize } else { 0 };
            let ia = fl.min(last - 1);
            let a = s.pts[ia];
            let c = s.pts[(fl + 1).min(last)];
            let w = f - ia as f64;
            let key = BladeKey::Script(s.key);
            let done = u >= 1.0;
            let b = blade_mut(&mut self.blades, key, || Blade::new(key, key, None, 0, [1.0; 3]));
            b.sample(a[0] + (c[0] - a[0]) * w, a[1] + (c[1] - a[1]) * w, now, p, &mut self.segs, now);
            if done {
                self.scripts.remove(i);
            }
        }

        for b in &mut self.blades {
            b.trim(now, p.trail.max(2.0 * WIN));
        }
        self.blades.retain(|b| now - b.seen <= 0.6);
    }

    /// the head's velocity (smoothed, m/s) of person `id`
    fn head_vel(&mut self, id: u32, head: [f64; 2], now: f64) -> [f64; 2] {
        let i = match self.heads.iter().position(|h| h.0 == id) {
            Some(i) => i,
            None => {
                self.heads.push((id, Head { x: head[0], y: head[1], t: now, vx: 0.0, vy: 0.0 }));
                self.heads.len() - 1
            }
        };
        let h = &mut self.heads[i].1;
        let dt = now - h.t;
        if dt > 1e-3 {
            let k = 1.0 - (-dt / 0.15).exp();
            h.vx += ((head[0] - h.x) / dt - h.vx) * k;
            h.vy += ((head[1] - h.y) / dt - h.vy) * k;
            if dt > 0.5 {
                h.vx = 0.0;
                h.vy = 0.0;
            }
            h.x = head[0];
            h.y = head[1];
            h.t = now;
        }
        let v = [h.vx, h.vy];
        if self.heads.len() > 64 {
            self.heads.remove(0);
        }
        v
    }
}

/// a hand of a person on the wall [x, y] (m), or None: raw (p.camera) or smoothed
fn hand(wall: &WallMap, person: &Person, h: usize, p: &P) -> Option<[f64; 2]> {
    let finite = |v: Vec3| (v.x.is_finite() && v.y.is_finite()).then(|| [f64::from(v.x), f64::from(v.y)]);
    if p.raw_hands
        && let Some(c) = EXTRA_HAND.get(h).and_then(|&e| person.camera.extra.get(e))
    {
        let conf = c[3].get();
        if conf.is_nan() || conf < p.min_conf {
            return None;
        }
        return finite(wall.from_camera(Vec3::new(c[0].f(), c[1].f(), c[2].f()), usize::from(person.slot), true));
    }
    let jj = *HANDS.get(h)?;
    if f64::from(person.confidence[jj]) >= p.min_conf { wall.joint(person, jj).and_then(finite) } else { None }
}
