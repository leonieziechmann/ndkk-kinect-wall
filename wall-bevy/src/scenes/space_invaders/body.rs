//! The bodies seen from above, from the person masks (body.js): every person pixel of the Kinect
//! (its measured depth, every frame, live) goes into the room and onto the map. Nothing here uses
//! the skeleton's hands for the masks: in live mode their depth is guessed and jumps around. The
//! masks are exact.
//!
//! Per person:
//!   center   the torso (mean of the points between hip and chest height, outliers dropped)
//!   arms     up to two arms that stick out of the body: points above 55 % of the body height, more
//!            than rMin from the torso, collected in an angle histogram seen from above; a peak with
//!            enough points is an arm, its direction the mean angle, its reach the 90th percentile.
//!            Followed from frame to frame (smoothed, on after 2 frames, off after 4).
//!            The hidden arm (param mirrorArm): one arm stretched out along the shoulders, the other
//!            not seen, and the body turned so far (50°+) that the body hides it from the sensor (it
//!            would point away from the wall): it is stretched out to the other side too (virtual).
//!   skeleton the skeleton as the game reads it (fused()): with live + exact persons every joint is
//!            the live one, moved towards the exact one the slower it moves (slow = exact, brought to
//!            now; fast = live, the exact one is 100-250 ms old). The turn and, with armSource
//!            'Skelett', the arms come from it: an arm counts when its hand is above half the body
//!            height and more than armMin from the torso (on after 2 results, off after 4); its
//!            direction from the shoulder to the hand, seen from above.
//!   head     the top of the body seen from above (the points within 22 cm of the highest), smoothed
//!   hands    the outermost points to the left and right at hand height (2.5 cm bins with enough
//!            points, so single stray pixels do not count), or the tip of an arm; smoothed
//!   face     the turn of the body seen from above (rad on the map), from the skeleton's shoulders
//!            (turn() below), smoothed and in steps of 360° / TURNS
//!   stomp    a jump, at the push-off (the same detection as the scene pixel-jump-run had then): the
//!            median height of the whole mask and the raw pelvis of the skeleton both rise fast
//!            enough, and the body would fly at least `jumpRise` above where it stands (height +
//!            v² / 2g); not while walking. Raised arms lift the mask but not the pelvis, so they never
//!            count.
//! The map grid (art px): per cell the slot of the highest point, whether it is an arm, its height.
//! Everything shown and hit is drawn `bodyScale` times smaller around the torso (the units should not
//! cover the map); the analysis itself works in real meters.

use std::collections::{HashMap, VecDeque};
use std::f64::consts::{PI, TAU};

use crate::kinect::KinectData;
use crate::persons::{NPOINTS, Person, PersonsView, ViewMode, j};
use crate::wall::WallMap;

use super::game::{SLOTS, UArm};
use super::pixels::{ARM, TURNS, facing, jr, jsign};
use super::{Layout, P};

const BINS: usize = 36;
/// reach histogram: 5 cm steps up to 1.4 m
const RB: usize = 28;
const RSTEP: f64 = 0.05;
/// hand bins: 2.5 cm from -1.2 to 1.2 m beside the torso
const HB: usize = 96;
const HSTEP: f64 = 0.025;
/// height histogram per person: 1 cm bins
const YMIN: f64 = -0.5;
const YB: usize = 300;

/// floor of an f32 without a libm call
#[inline]
fn ffloor(x: f32) -> i32 {
    let t = x as i32;
    if (t as f32) > x { t - 1 } else { t }
}

/// a ring of the last n values; stand(): the standing level, the highest 1 s median, sinking slowly
struct Ring {
    v: [f32; 30],
    n: usize,
    i: usize,
    last: Option<f64>,
    level: Option<f64>,
}

impl Ring {
    fn new() -> Self {
        Self { v: [0.0; 30], n: 0, i: 0, last: None, level: None }
    }

    fn push(&mut self, x: f64) {
        self.v[self.i] = x as f32;
        self.i = (self.i + 1) % self.v.len();
        self.n = (self.n + 1).min(self.v.len());
    }

    fn median(&self) -> f64 {
        let mut s = self.v;
        let s = &mut s[..self.n];
        s.sort_by(f32::total_cmp);
        s.get(self.n / 2).map_or(0.0, |&v| f64::from(v))
    }

    fn stand(&mut self, x: f64, time: f64, decay: f64) -> f64 {
        self.push(x);
        let m = self.median();
        let dt = self.last.map_or(0.0, |l| (time - l).max(0.0));
        self.last = Some(time);
        let level = match self.level {
            Some(l) if m <= l => l - decay * dt,
            _ => m,
        };
        self.level = Some(level);
        level
    }
}

#[derive(Clone, Copy)]
struct Reading {
    rise: f64,
    v: f64,
    n: usize,
}

/// one height signal: its standing level, the rise above it, its velocity (lightly smoothed)
struct Signal {
    ring: Ring,
    v: f64,
    y: Option<f64>,
    t: f64,
}

impl Signal {
    fn new() -> Self {
        Self { ring: Ring::new(), v: 0.0, y: None, t: 0.0 }
    }

    fn add(&mut self, y: f64, time: f64) -> Reading {
        let dt = time - self.t;
        self.v = match self.y {
            Some(prev) if dt > 1e-3 && dt < 0.3 => 0.4 * self.v + 0.6 * ((y - prev) / dt),
            _ => 0.0,
        };
        self.y = Some(y);
        self.t = time;
        let stand = self.ring.stand(y, time, 0.003);
        Reading { rise: y - stand, v: self.v, n: self.ring.n }
    }
}

/// an arm followed over time (mask peaks, the skeleton's arms, the hidden one)
#[derive(Clone, Copy)]
struct ArmT {
    id: i64,
    ang: f64,
    len: f64,
    hits: u32,
    miss: u32,
    on: bool,
    /// the shoulder it hangs on (0: not chosen yet)
    side: f64,
}

/// the hidden arm and the id of the arm it mirrors
#[derive(Clone, Copy)]
struct Hidden {
    arm: ArmT,
    of: i64,
}

/// which arm of a person's state
#[derive(Clone, Copy)]
enum ArmRef {
    Mask(usize),
    Sk(usize),
    Hidden,
}

/// the state of a person (by id)
struct St {
    h: f64,
    body: Signal,
    pelvis: Signal,
    armed: bool,
    armed_at: f64,
    born: f64,
    walks: VecDeque<(f64, f64)>,
    stomp_at: f64,
    arms: Vec<ArmT>,
    seen: f64,
    face: f64,
    face_q: Option<f64>,
    face_at: f64,
    sk: [Option<ArmT>; 2],
    hidden: Option<Hidden>,
    right: Option<[f64; 2]>,
    right_at: f64,
    head: Option<[f64; 2]>,
    hands: [Option<[f64; 2]>; 2],
}

impl St {
    fn arm(&mut self, r: ArmRef) -> Option<&mut ArmT> {
        match r {
            ArmRef::Mask(i) => self.arms.get_mut(i),
            ArmRef::Sk(k) => self.sk.get_mut(k).and_then(Option::as_mut),
            ArmRef::Hidden => self.hidden.as_mut().map(|h| &mut h.arm),
        }
    }
}

/// what pass 1 and 2 gather per slot
#[derive(Clone, Copy, Default)]
struct Info {
    on: bool,
    id: u32,
    dist: f64,
    /// the standing height (st.H)
    h: f32,
    n: u32,
    top: f32,
    cx: f64,
    cz: f64,
    x0: f64,
    hx: f64,
    hzs: f64,
    hn: u32,
    gy0: f64,
    /// metricX of a mask point as a + b * rx (the person placed as a whole), else through room_x
    linear: bool,
    a: f32,
    b: f32,
    scale: f32,
}

/// the constants of pass 1 per slot
#[derive(Clone, Copy, Default)]
struct Pass1 {
    on: bool,
    lo: f32,
    hi: f32,
    linear: bool,
    a: f32,
    b: f32,
    x0: f32,
    scale: f32,
}

/// the constants of pass 2 per slot
#[derive(Clone, Copy, Default)]
struct Pass2 {
    on: bool,
    cx: f32,
    cz: f32,
    /// heights: the head (within 22 cm of the top), the hands' band, the arms' band
    head: f32,
    hand: f32,
    hi: f32,
    arm: f32,
    /// the grid cell: gx = floor(gx_a + dx * gx_b), gy = floor(gy_a + dz * gy_b)
    gx_a: f32,
    gx_b: f32,
    gy_a: f32,
    gy_b: f32,
}

/// atan2 without a libm call, max error 1e-5 rad (Abramowitz-Stegun 4.4.49; the arm bins are 10° wide)
#[inline]
fn atan2f(y: f32, x: f32) -> f32 {
    use std::f32::consts::{FRAC_PI_2, PI};
    let (ax, ay) = (x.abs(), y.abs());
    let (mx, mn) = (ax.max(ay), ax.min(ay));
    if mx == 0.0 {
        let r = if x.is_sign_negative() { PI } else { 0.0 };
        return if y.is_sign_negative() { -r } else { r };
    }
    let a = mn / mx;
    let s = a * a;
    let mut r = a * (0.999_866 + s * (-0.330_299_5 + s * (0.180_141 + s * (-0.085_133 + s * 0.020_835_1))));
    if ay > ax {
        r = FRAC_PI_2 - r;
    }
    if x < 0.0 {
        r = PI - r;
    }
    if y < 0.0 { -r } else { r }
}

/// the skeleton as the game reads it
struct Sk {
    joints: [Option<[f64; 3]>; NPOINTS],
    conf: [f64; NPOINTS],
    /// the part of the joints taken from exact (0..1)
    exact_share: f64,
}

/// One person of the bodies: map art px.
pub struct BodyPerson {
    pub id: u32,
    pub slot: u8,
    pub center: [f64; 2],
    pub arms: Vec<UArm>,
    pub stomp: bool,
    pub head: Option<[f64; 2]>,
    pub hands: [Option<[f64; 2]>; 2],
    pub face: f64,
}

pub struct Bodies {
    cache: Vec<f32>,
    state: HashMap<u32, St>,
    pub persons: Vec<BodyPerson>,
    pub w: usize,
    pub h: usize,
    hist: Vec<f32>,
    rhist: Vec<u32>,
    hcount: Vec<u32>,
    hz: Vec<f32>,
    yhist: Vec<u32>,
    ycount: [u32; SLOTS],
    last_result: Option<u32>,
    /// per cell: slot of the highest point, 1 body / 2 arm, its height (cm)
    pub slot: Vec<u8>,
    pub kind: Vec<u8>,
    pub height: Vec<u8>,
    arm_ids: i64,
    /// the cache entries in a torso band
    band_pts: Vec<u32>,
    /// the largest part of a person's arm joints taken from the exact skeleton in the last result (0..1)
    pub exact_share: f64,
}

impl Bodies {
    pub fn new() -> Self {
        Self {
            cache: vec![0.0; 512 * 424 * 4],
            state: HashMap::new(),
            persons: Vec::new(),
            w: 0,
            h: 0,
            hist: vec![0.0; SLOTS * BINS],
            rhist: vec![0; SLOTS * BINS * RB],
            hcount: vec![0; SLOTS * HB],
            hz: vec![0.0; SLOTS * HB],
            yhist: vec![0; SLOTS * YB],
            ycount: [0; SLOTS],
            last_result: None,
            slot: Vec::new(),
            kind: Vec::new(),
            height: Vec::new(),
            arm_ids: 1,
            band_pts: Vec::with_capacity(32 * 1024),
            exact_share: 0.0,
        }
    }

    pub fn resize(&mut self, w: usize, h: usize) {
        self.w = w;
        self.h = h;
        self.slot = vec![0; w * h];
        self.kind = vec![0; w * h];
        self.height = vec![0; w * h];
    }

    fn clear(&mut self) {
        self.slot.fill(0);
        self.kind.fill(0);
        self.height.fill(0);
    }

    #[inline]
    fn cell(&self, x: f64, y: f64) -> Option<usize> {
        let (x, y) = (x.floor(), y.floor());
        if !(x >= 0.0 && y >= 0.0 && x < self.w as f64 && y < self.h as f64) {
            return None;
        }
        Some(y as usize * self.w + x as usize)
    }

    pub fn slot_at(&self, x: f64, y: f64) -> u8 {
        self.cell(x, y).and_then(|c| self.slot.get(c).copied()).unwrap_or(0)
    }

    pub fn kind_at(&self, x: f64, y: f64) -> u8 {
        self.cell(x, y).and_then(|c| self.kind.get(c).copied()).unwrap_or(0)
    }

    /// the top-down figure of a person into the grid: shoulders and head (body), stretched-out arms
    fn stamp_figure(&mut self, center: [f64; 2], face: f64, arms: &[UArm], slot: u8) {
        let [cx, cy] = center;
        let rx = 6.5; // the figure sprite (pixels.rs PERSON): 26 x 13 half px = 13 x 6.5 art px
        let ry = 3.3;
        let (f, r) = facing(face);
        let mut y = -rx;
        while y <= rx {
            let mut x = -rx;
            while x <= rx {
                let u = x * r[0] + y * r[1];
                let v = x * f[0] + y * f[1];
                if (u / rx).powi(2) + (v / ry).powi(2) <= 1.0 {
                    self.stamp(cx + x, cy + y, slot, 1, 150);
                }
                x += 1.0;
            }
            y += 1.0;
        }
        for a in arms {
            let [sx, sy] = a.from;
            let n = (a.tip[0] - sx).hypot(a.tip[1] - sy).ceil();
            if !n.is_finite() || n > 10_000.0 {
                continue;
            }
            let mut i = 0.0;
            while i <= n {
                let x = sx + ((a.tip[0] - sx) * i) / n.max(1.0);
                let y = sy + ((a.tip[1] - sy) * i) / n.max(1.0);
                self.stamp(x, y, slot, 2, 140);
                self.stamp(x, y + 1.0, slot, 2, 140);
                i += 1.0;
            }
        }
    }

    /// a cell of a figure
    fn stamp(&mut self, x: f64, y: f64, slot: u8, kind: u8, cm: u8) {
        let Some(c) = self.cell(x, y) else { return };
        if self.height.get(c).is_none_or(|&h| cm < h) {
            return;
        }
        self.slot[c] = slot;
        self.kind[c] = kind;
        self.height[c] = cm;
    }

    /// One person tracking result -> the grid and self.persons. time: the effects' real time (s).
    /// Keeps the last result between Kinect frames.
    pub fn update(&mut self, wall: &WallMap, kinect: &mut KinectData, x_sign: f32, l: &Layout, p: &P, time: f64) {
        let Some(r) = kinect.persons.clone() else {
            self.persons.clear();
            self.clear();
            return;
        };
        let view: std::sync::Arc<PersonsView> = kinect.view.clone();
        if !view.fresh && self.last_result == Some(r.seq) {
            for q in &mut self.persons {
                q.stomp = false;
            }
            return;
        }
        self.last_result = Some(r.seq);
        self.clear();
        self.hist.fill(0.0);
        self.rhist.fill(0);
        self.hcount.fill(0);
        self.hz.fill(0.0);
        self.yhist.fill(0);
        self.ycount = [0; SLOTS];

        let front = wall.setup.sensor_front;
        let m = wall.room;
        let [near, far] = wall.zone(); // the projection's zone, room z (m from the sensor)
        let rays = kinect.rays();

        // live + exact: the newest exact skeletons and the live ones of that same frame, to see what
        // live got wrong then (fused())
        let exact = if kinect.mode == ViewMode::Both { kinect.exact_view.clone() } else { None };
        let live_then = match exact.as_ref().and_then(|e| e.seq) {
            Some(seq) => kinect.live_at(seq),
            None => None,
        };
        self.exact_share = 0.0;

        // who is who: the visible persons in the zone, by slot
        let mut info = [Info::default(); SLOTS];
        let ms = wall.mirror_sign();
        let x0p = wall.plan_x0();
        for q in &wall.persons {
            let s = usize::from(q.slot);
            if !q.in_zone || !(1..SLOTS).contains(&s) {
                continue;
            }
            let st = self.state.entry(q.id).or_insert_with(|| St {
                h: if q.height > 0.8 { f64::from(q.height) } else { 1.7 },
                body: Signal::new(),
                pelvis: Signal::new(),
                armed: true,
                armed_at: 0.0,
                born: time,
                walks: VecDeque::new(),
                stomp_at: -9.0,
                arms: Vec::new(),
                seen: time,
                face: l.wall_face,
                face_q: None,
                face_at: time,
                sk: [None, None],
                hidden: None,
                right: None,
                right_at: 0.0,
                head: None,
                hands: [None, None],
            });
            st.seen = time;
            let qx = f64::from(q.x);
            let k = wall.scale[s];
            let linear = wall.projection.per_person && wall.visible[s] && k != 0.0;
            // metricX = x0 + (roomX - x0) / scale with roomX = offset + ms * (planX0 + xSign * rx) * scale
            let (a, b) = if linear { (q.x + (wall.offset[s] - q.x) / k + ms * x0p, ms * wall.x_sign) } else { (0.0, 0.0) };
            info[s] = Info { on: true, id: q.id, dist: f64::from(q.dist), h: st.h as f32, cx: qx, cz: f64::from(q.z), x0: qx, linear, a, b, scale: k, ..Info::default() };
        }

        // pass 1: every person pixel into the room and onto the wall's x; the torso band per slot
        let (Some(labels), Some(depth), Some(indices)) = (&r.labels, &r.depth, &r.indices) else {
            self.finish(wall, &view, exact.as_deref(), live_then.as_deref(), &info, l, p, time, x_sign);
            return;
        };
        let (labels, depth, indices): (&[u8], &[u16], &[u32]) = (labels, depth, indices);
        let rays: &[f32] = &rays;
        // per slot, compact: on, the torso band (0.35 .. 0.68 of the height), the wall x mapping
        let mut band = [Pass1::default(); SLOTS];
        for (b, inf) in band.iter_mut().zip(&info) {
            *b = Pass1 { on: inf.on, lo: 0.35 * inf.h, hi: 0.68 * inf.h, linear: inf.linear, a: inf.a, b: inf.b, x0: inf.x0 as f32, scale: inf.scale };
        }
        self.band_pts.clear();
        let mut cnt = [0_u32; SLOTS];
        let mut sum_x = [0.0_f64; SLOTS];
        let mut sum_z = [0.0_f64; SLOTS];
        let cache = &mut self.cache;
        let mut n = 0usize;
        let (near, far) = (near - 0.3, far + 0.3);
        for &i in indices.iter().take(r.count) {
            let i = i as usize;
            let Some(&lab) = labels.get(i) else { continue };
            let s = usize::from(lab);
            let Some(q) = band.get(s) else { continue };
            if !q.on {
                continue;
            }
            let Some(&mm) = depth.get(i) else { continue };
            if mm < 100 {
                continue;
            }
            let (Some(&rx0), Some(&ry0)) = (rays.get(2 * i), rays.get(2 * i + 1)) else { continue };
            let z = f32::from(mm) * 0.001;
            let wx = x_sign * rx0 * z;
            let wy = -ry0 * z;
            let rz = m[2] * wx + m[6] * wy + m[10] * z + m[14];
            if rz < near || rz > far {
                continue;
            }
            let rx = m[0] * wx + m[4] * wy + m[8] * z + m[12];
            let ry = m[1] * wx + m[5] * wy + m[9] * z + m[13];
            let x = if q.linear { q.a + q.b * rx } else { q.x0 + (wall.room_x(rx, rz, s) - q.x0) / q.scale };
            let zw = front + rz;
            let Some(c) = cache.get_mut(n * 4..n * 4 + 4) else { break };
            c[0] = x;
            c[1] = ry;
            c[2] = zw;
            c[3] = s as f32;
            if ry > q.lo && ry < q.hi {
                cnt[s] += 1;
                sum_x[s] += f64::from(x);
                sum_z[s] += f64::from(zw);
                self.band_pts.push(n as u32);
            }
            n += 1;
        }
        // the torso: mean of the band, then again without what lies more than 35 cm from it
        let mut near_c = [(false, 0.0_f32, 0.0_f32); SLOTS];
        for (k, inf) in info.iter_mut().enumerate() {
            inf.n = cnt[k];
            if !inf.on || inf.n < 20 {
                continue;
            }
            inf.cx = sum_x[k] / f64::from(inf.n);
            inf.cz = sum_z[k] / f64::from(inf.n);
            near_c[k] = (true, inf.cx as f32, inf.cz as f32);
        }
        let mut cnt2 = [0_u32; SLOTS];
        let mut sum_x = [0.0_f64; SLOTS];
        let mut sum_z = [0.0_f64; SLOTS];
        // (only the points of the band)
        for &j in &self.band_pts {
            let j = j as usize * 4;
            let Some(c) = self.cache.get(j..j + 4) else { continue };
            let s = c[3] as usize;
            let Some(&(on, cx, cz)) = near_c.get(s) else { continue };
            if !on {
                continue;
            }
            let dx = c[0] - cx;
            let dz = c[2] - cz;
            if dx * dx + dz * dz > 0.35 * 0.35 {
                continue;
            }
            cnt2[s] += 1;
            sum_x[s] += f64::from(c[0]);
            sum_z[s] += f64::from(c[2]);
        }
        for (k, inf) in info.iter_mut().enumerate() {
            if !inf.on || inf.n < 20 || cnt2[k] < 10 {
                continue;
            }
            inf.cx = sum_x[k] / f64::from(cnt2[k]);
            inf.cz = sum_z[k] / f64::from(cnt2[k]);
        }

        // pass 2: arms (angle histogram), head height, jump signal, the map grid
        let r_min = p.arm_min as f32;
        let (sx, sy, up) = (l.sx as f32, l.sy as f32, l.up);
        let up_k = if up { 1.0 } else { -1.0 };
        let body_scale = p.body_scale as f32;
        // each torso's row on the map (through the projection's depth curve): the body around it;
        // per slot the constants of the loop
        let mut q2 = [Pass2::default(); SLOTS];
        for (q, inf) in q2.iter_mut().zip(info.iter_mut()) {
            if !inf.on {
                continue;
            }
            inf.gy0 = l.map(wall, inf.cx, inf.cz)[1];
            let h = inf.h;
            let ks = body_scale * inf.scale;
            *q = Pass2 { on: true, cx: inf.cx as f32, cz: inf.cz as f32, head: h - 0.22, hand: 0.3 * h, hi: h + 0.45, arm: 0.55 * h, gx_a: inf.cx as f32 * sx, gx_b: ks * sx, gy_a: inf.gy0 as f32, gy_b: ks * sy * up_k };
        }
        let mut hx = [0.0_f64; SLOTS];
        let mut hzs = [0.0_f64; SLOTS];
        let mut hn = [0_u32; SLOTS];
        let mut top = [0.0_f32; SLOTS];
        let (gw, gh) = (self.w as i32, self.h as i32);
        // the grid shows the masks only as silhouettes: as figures it is stamped anew in finish()
        let grid = p.silhouette;
        let r_min2 = r_min * r_min;
        for c in self.cache.get(..n * 4).unwrap_or_default().as_chunks::<4>().0 {
            let s = c[3] as usize;
            let Some(q) = q2.get(s) else { continue };
            if !q.on {
                continue;
            }
            let (x, ry, zw) = (c[0], c[1], c[2]);
            let dx = x - q.cx;
            let dz = zw - q.cz; // + = farther from the wall
            let r2 = dx * dx + dz * dz;
            if r2 < 0.35 * 0.35 && ry > q.head {
                hx[s] += f64::from(x);
                hzs[s] += f64::from(zw);
                hn[s] += 1;
            }
            if r2 > 0.18 * 0.18 && ry > q.hand && ry < q.hi {
                let hb = ffloor((dx + 1.2) / HSTEP as f32);
                if hb >= 0 && (hb as usize) < HB {
                    let k = s * HB + hb as usize;
                    if let (Some(hc), Some(hzv)) = (self.hcount.get_mut(k), self.hz.get_mut(k)) {
                        *hc += 1;
                        *hzv += zw;
                    }
                }
            }
            if r2 < 0.3 * 0.3 && ry > top[s] {
                top[s] = ry;
            }
            let yb = ffloor((ry - YMIN as f32) * 100.0);
            if yb >= 0 && (yb as usize) < YB {
                if let Some(v) = self.yhist.get_mut(s * YB + yb as usize) {
                    *v += 1;
                }
                self.ycount[s] += 1;
            }
            // an arm: high enough, away from the torso, not behind it (the sensor cannot see behind
            // a body: points there are mixed pixels at the edges)
            let arm = ry > q.arm && ry < q.hi && r2 > r_min2 && dz < 0.25;
            if arm {
                let a = atan2f(dz, dx);
                let b = (ffloor(((a + std::f32::consts::PI) / std::f32::consts::TAU) * BINS as f32).max(0) as usize) % BINS;
                if let Some(v) = self.hist.get_mut(s * BINS + b) {
                    *v += 1.0;
                }
                let rb = (RB - 1).min(ffloor(r2.sqrt() / RSTEP as f32).max(0) as usize);
                if let Some(v) = self.rhist.get_mut((s * BINS + b) * RB + rb) {
                    *v += 1;
                }
            }
            if !grid {
                continue;
            }
            // the grid: the highest point per cell
            let gx = ffloor(q.gx_a + dx * q.gx_b);
            let gy = ffloor(q.gy_a + dz * q.gy_b);
            if gx < 0 || gy < 0 || gx >= gw || gy >= gh {
                continue;
            }
            let cell = gy as usize * self.w + gx as usize;
            let cm = (ry * 100.0 + 0.5).floor().clamp(1.0, 255.0) as u8;
            if let Some(hc) = self.height.get_mut(cell)
                && cm >= *hc
            {
                *hc = cm;
                self.slot[cell] = s as u8;
                self.kind[cell] = if arm { 2 } else { 1 };
            }
        }
        for (k, inf) in info.iter_mut().enumerate() {
            inf.hx = hx[k];
            inf.hzs = hzs[k];
            inf.hn = hn[k];
            inf.top = top[k];
        }
        self.finish(wall, &view, exact.as_deref(), live_then.as_deref(), &info, l, p, time, x_sign);
    }

    /// per person: arms, stomps, head, hands, turn; then the figures into the grid
    #[allow(clippy::too_many_arguments)]
    fn finish(&mut self, wall: &WallMap, view: &PersonsView, exact: Option<&PersonsView>, live_then: Option<&PersonsView>, info: &[Info; SLOTS], l: &Layout, p: &P, time: f64, x_sign: f32) {
        let m = wall.room;
        let side = f64::from(wall.side());
        let front = f64::from(wall.setup.sensor_front);
        let (sx, sy, up) = (l.sx, l.sy, l.up);
        self.persons.clear();
        for (s, inf) in info.iter().enumerate().skip(1) {
            if !inf.on {
                continue;
            }
            let Some(mut st) = self.state.remove(&inf.id) else { continue };
            let person = view.by_id(inf.id);
            // standing height: follows the head slowly, ignores hands above it
            let top = f64::from(inf.top);
            if top > 0.8 && (top - st.h).abs() < 0.25 {
                st.h += (top - st.h) * 0.05;
            }
            let dist = inf.dist.max(0.5);
            let min_pts = 150.0_f64.min((300.0 / (dist * dist)).max(25.0));
            let found = peaks(&self.hist, &self.rhist, s, min_pts, p.arm_min + 0.12);
            track_arms(&mut st, &found, &mut self.arm_ids);
            // a jump at the push-off (see the top of this file)
            let mut stomp = false;
            let yc = self.ycount.get(s).copied().unwrap_or(0);
            if yc > 100 {
                let mut acc = 0u32;
                let mut med = 0.0;
                for b in 0..YB {
                    acc += self.yhist.get(s * YB + b).copied().unwrap_or(0);
                    if f64::from(acc) >= f64::from(yc) / 2.0 {
                        med = YMIN + (b as f64 + 0.5) / 100.0;
                        break;
                    }
                }
                let body = st.body.add(med, time);
                // the raw pelvis (not the smoothed one, which lags)
                let mut pelv = None;
                if let Some(raw) = person.and_then(|q| q.camera.extra.get(1))
                    && raw[3].get() > 0.0
                {
                    let wx = f64::from(x_sign) * raw[0].get() / 1000.0;
                    let wy = -raw[1].get() / 1000.0;
                    let wz = raw[2].get() / 1000.0;
                    let y = f64::from(m[1]) * wx + f64::from(m[5]) * wy + f64::from(m[9]) * wz + f64::from(m[13]);
                    pelv = Some(st.pelvis.add(y, time));
                }
                // walking: the fastest of the last 0.3 s over the floor
                let vel = person.map_or(0.0, |q| f64::from(q.velocity.x).hypot(f64::from(q.velocity.z)));
                st.walks.push_back((time, vel));
                while st.walks.front().is_some_and(|w| time - w.0 > 0.3) {
                    st.walks.pop_front();
                }
                let walking = st.walks.iter().map(|w| w.1).fold(0.0_f64, f64::max);
                let flies = body.rise > -p.jump_dip && body.rise + (body.v * body.v) / 19.62 > p.jump_rise;
                let pelvis_up = pelv.is_none_or(|q| q.v > p.jump_vy2);
                if st.armed && time - st.born > 1.0 && body.n >= 20 && body.v > p.jump_vy && pelvis_up && flies && walking < p.walk_gate {
                    st.armed = false;
                    st.armed_at = time;
                    if time - st.stomp_at > 0.4 {
                        stomp = true;
                        st.stomp_at = time;
                    }
                } else if !st.armed && time - st.armed_at > 0.15 && (body.v < 0.05 || body.rise < p.jump_rise * 0.35) {
                    st.armed = true;
                }
            }
            let center = l.map(wall, inf.cx, inf.cz);
            let sk = fused(person, exact, live_then, p);
            self.exact_share = self.exact_share.max(sk.exact_share);
            let face = if p.turn { turn(&mut st, &sk, &m, side, l, time) } else { l.wall_face };
            let (_, across) = facing(face);
            let ks = p.body_scale * f64::from(wall.scale[s]);
            let shrink = |q: Option<[f64; 2]>| q.map(|q| l.map(wall, inf.cx + (q[0] - inf.cx) * ks, inf.cz + (q[1] - inf.cz) * ks));
            // head and hands seen from above, smoothed (they are only shown, nothing is aimed with them)
            let ema = |old: Option<[f64; 2]>, v: Option<[f64; 2]>, a: f64| match (old, v) {
                (Some(o), Some(v)) => Some([o[0] + (v[0] - o[0]) * a, o[1] + (v[1] - o[1]) * a]),
                _ => v,
            };
            let head_now = if inf.hn > 8 { Some([inf.hx / f64::from(inf.hn), inf.hzs / f64::from(inf.hn)]) } else { None };
            st.head = ema(st.head, head_now, 0.6);
            let hand_min = (30.0 / (dist * dist)).max(3.0);
            let hand = |from: i64, step: i64, sign: f64| {
                let mut b = from;
                while b >= 0 && (b as usize) < HB {
                    let k = s * HB + b as usize;
                    let c = self.hcount.get(k).copied().unwrap_or(0);
                    if f64::from(c) >= hand_min {
                        let dx = (b as f64 + 0.5) * HSTEP - 1.2;
                        return if sign * dx > 0.15 { Some([inf.cx + dx, f64::from(self.hz.get(k).copied().unwrap_or(0.0)) / f64::from(c)]) } else { None };
                    }
                    b += step;
                }
                None
            };
            let hl = hand(0, 1, -1.0);
            let hr = hand(HB as i64 - 1, -1, 1.0);
            st.hands = [ema(st.hands[0], hl, 0.5), ema(st.hands[1], hr, 0.5)];
            // a skeleton point -> wall x, height, z (as the mask pixels above)
            let to_wall = |w: [f64; 3]| {
                let (w0, w1, w2) = (w[0] as f32, w[1] as f32, w[2] as f32);
                let rx = m[0] * w0 + m[4] * w1 + m[8] * w2 + m[12];
                let ry = m[1] * w0 + m[5] * w1 + m[9] * w2 + m[13];
                let rz = m[2] * w0 + m[6] * w1 + m[10] * w2 + m[14];
                let x = if inf.linear { inf.a + inf.b * rx } else { inf.x0 as f32 + (wall.room_x(rx, rz, s) - inf.x0 as f32) / inf.scale };
                [f64::from(x), f64::from(ry), front + f64::from(rz)]
            };
            let mut seen: Vec<ArmRef> = Vec::with_capacity(3);
            if p.arm_mask {
                seen.extend(st.arms.iter().enumerate().filter(|(_, a)| a.on).map(|(i, _)| ArmRef::Mask(i)));
            } else {
                skeleton_arms(&mut st, &sk, &to_wall, inf, p, &mut self.arm_ids, &mut seen);
            }
            if hidden_arm(&seen, &mut st, p, time) {
                seen.push(ArmRef::Hidden);
            }
            let mut arms = Vec::with_capacity(seen.len());
            for &ar in &seen {
                let Some(a) = st.arm(ar) else { continue };
                let dx = a.ang.cos() * sx;
                let dy = a.ang.sin() * sy * if up { 1.0 } else { -1.0 };
                let d = match dx.hypot(dy) {
                    d if d > 0.0 => d,
                    _ => 1.0,
                };
                let dir = [dx / d, dy / d];
                // drawn as figures: the arm in the figure's proportions (from the shoulder, longer the
                // more it is stretched); as silhouettes: where it really is (scaled like the body)
                let (from, tip) = if !p.silhouette {
                    // the shoulder on the arm's side of the turned figure (kept while the arm is up)
                    let dd = dir[0] * across[0] + dir[1] * across[1];
                    if a.side == 0.0 || (dd.abs() > 0.35 && jsign(dd) != a.side) {
                        a.side = if dd < 0.0 { -1.0 } else { 1.0 };
                    }
                    let from = [center[0] + a.side * ARM.shoulder * across[0], center[1] + a.side * ARM.shoulder * across[1]];
                    let reach = ARM.reach * ((a.len - 0.3) / 0.4).clamp(0.35, 1.0);
                    (from, [from[0] + dir[0] * reach, from[1] + dir[1] * reach])
                } else {
                    (center, l.map(wall, inf.cx + a.ang.cos() * a.len * ks, inf.cz + a.ang.sin() * a.len * ks))
                };
                arms.push(UArm { id: a.id, from, tip, dir, len: a.len, virt: matches!(ar, ArmRef::Hidden) });
            }
            // an arm that points: its hand is at the tip
            let mut hands = [shrink(st.hands[0]), shrink(st.hands[1])];
            for a in &arms {
                hands[usize::from(a.dir[0] >= 0.0)] = Some(a.tip);
            }
            let head = shrink(st.head);
            self.state.insert(inf.id, st);
            self.persons.push(BodyPerson { id: inf.id, slot: s as u8, center, arms, stomp, head, hands, face });
        }
        self.state.retain(|_, st| time - st.seen <= 3.0);
        // drawn as top-down figures (mod.rs, draw.rs): what can be hit is the figure, not the mask
        if !p.silhouette {
            self.clear();
            let persons = std::mem::take(&mut self.persons);
            for q in &persons {
                self.stamp_figure(q.center, q.face, &q.arms, q.slot);
            }
            self.persons = persons;
        }
    }
}

fn wrap(a: f64) -> f64 {
    let mut a = a;
    if !a.is_finite() {
        return a;
    }
    while a > PI {
        a -= TAU;
    }
    while a < -PI {
        a += TAU;
    }
    a
}

/// The turn of a body seen from above (rad on the map), from the skeleton: the line from the left to
/// the right shoulder on the floor (wall x, z). Facing the wall, it points to the audience's right;
/// the body faces 90° to its left. (Offline on the multi recordings: 6° median error for people
/// walking towards the sensor.) A shoulder line shorter than 8 cm (seen exactly from the side) or
/// longer than 60 cm (a depth outlier) keeps the last turn. The face settles front or back if the
/// pose mixed up left and right: a visible face looks towards the sensor, a back without a face away
/// from it. Smoothed, then held in steps of 360° / TURNS until it is almost a step away (no flicker).
fn turn(st: &mut St, sk: &Sk, m: &[f32; 16], side: f64, l: &Layout, time: f64) -> f64 {
    let jn = &sk.joints;
    let c = &sk.conf;
    let dt = (time - st.face_at).clamp(0.0, 0.5);
    st.face_at = time;
    if let (Some(ls), Some(rs)) = (jn[j::LEFT_SHOULDER], jn[j::RIGHT_SHOULDER])
        && c[j::LEFT_SHOULDER] > 0.3
        && c[j::RIGHT_SHOULDER] > 0.3
    {
        let mm = |k: usize| f64::from(m[k]);
        let to_wall = |w: [f64; 3]| [side * (mm(0) * w[0] + mm(4) * w[1] + mm(8) * w[2] + mm(12)), mm(2) * w[0] + mm(6) * w[1] + mm(10) * w[2] + mm(14)];
        let lw = to_wall(ls);
        let rw = to_wall(rs);
        let mut a = rw[0] - lw[0];
        let mut b = rw[1] - lw[1];
        let len = a.hypot(b);
        let eyes = c[j::LEFT_EYE].max(c[j::RIGHT_EYE]);
        let face = c[j::NOSE] > 0.5 && eyes > 0.5;
        let back = c[j::NOSE] < 0.2 && eyes < 0.2 && c[j::LEFT_SHOULDER].min(c[j::RIGHT_SHOULDER]) > 0.5;
        if (face && a < -0.1) || (back && a > 0.1) {
            a = -a;
            b = -b;
        }
        if len > 0.08 && len < 0.6 {
            // the line to the right shoulder (wall x, z), smoothed: the hidden arm needs it
            let k = 1.0 - (-dt / 0.2).exp();
            let rn = [a / len, b / len];
            let r = match st.right {
                Some(o) => [o[0] + (rn[0] - o[0]) * k, o[1] + (rn[1] - o[1]) * k],
                None => rn,
            };
            let n = match r[0].hypot(r[1]) {
                n if n > 0.0 => n,
                _ => 1.0,
            };
            st.right = Some([r[0] / n, r[1] / n]);
            st.right_at = time;
            // facing: the shoulder line turned by -90° seen from above (wall x to the right, z away
            // from it), at its real angle (the map is wider than deep: scaled, small turns would look bigger)
            let phi = ((if l.up { 1.0 } else { -1.0 }) * -a).atan2(b);
            st.face = wrap(st.face + wrap(phi - st.face) * (1.0 - (-dt / 0.25).exp()));
        }
    }
    let step = TAU / TURNS as f64;
    let need = match st.face_q {
        None => true,
        Some(q) => wrap(st.face - q * step).abs() > 0.9 * step,
    };
    if need {
        st.face_q = Some(jr(st.face / step));
    }
    wrap(st.face_q.unwrap_or(0.0) * step)
}

#[derive(Clone, Copy)]
struct Found {
    bin: usize,
    ang: f64,
    len: f64,
}

/// up to two arms in the angle histogram of slot s
fn peaks(hist: &[f32], rhist: &[u32], s: usize, min_pts: f64, min_len: f64) -> Vec<Found> {
    let o = s * BINS;
    let hv = |b: usize| f64::from(hist.get(o + b).copied().unwrap_or(0.0));
    let mut sm = [0.0_f64; BINS];
    for (b, v) in sm.iter_mut().enumerate() {
        *v = hv((b + BINS - 1) % BINS) + 2.0 * hv(b) + hv((b + 1) % BINS);
    }
    let mut cands: Vec<usize> = Vec::with_capacity(8);
    for b in 0..BINS {
        let v = sm[b];
        if v < min_pts * 2.0 || v < sm[(b + BINS - 1) % BINS] || v < sm[(b + 1) % BINS] {
            continue;
        }
        cands.push(b);
    }
    cands.sort_by(|&a, &b| sm[b].total_cmp(&sm[a]));
    let mut res: Vec<Found> = Vec::with_capacity(2);
    for &b in &cands {
        if res.len() >= 2 {
            break;
        }
        if res.iter().any(|r| (ang_diff(r.bin as f64, b as f64) * (TAU / BINS as f64)).abs() < 0.9) {
            continue;
        }
        // mean angle and the 90th percentile of the reach over the peak and its neighbours
        let mut cs = 0.0;
        let mut sn = 0.0;
        let mut cnt = 0.0;
        let mut rh = [0u32; RB];
        for d in [-1_i64, 0, 1] {
            let bb = ((b as i64 + d + BINS as i64) % BINS as i64) as usize;
            let c = hv(bb);
            let a = ((bb as f64 + 0.5) / BINS as f64) * TAU - PI;
            cs += a.cos() * c;
            sn += a.sin() * c;
            cnt += c;
            for (r, v) in rh.iter_mut().enumerate() {
                *v += rhist.get((o + bb) * RB + r).copied().unwrap_or(0);
            }
        }
        let mut acc = 0.0;
        let mut len = 0.0;
        for (r, &v) in rh.iter().enumerate() {
            acc += f64::from(v);
            if acc >= 0.9 * cnt {
                len = (r + 1) as f64 * RSTEP;
                break;
            }
        }
        if len < min_len {
            continue;
        }
        res.push(Found { bin: b, ang: sn.atan2(cs), len });
    }
    res
}

fn ang_diff(a: f64, b: f64) -> f64 {
    let half = BINS as f64 / 2.0;
    let mut d = a - b;
    while d > half {
        d -= BINS as f64;
    }
    while d < -half {
        d += BINS as f64;
    }
    d
}

/// the arm joints the skeleton fusion reads
const SKELETON: [usize; 8] = [j::LEFT_SHOULDER, j::RIGHT_SHOULDER, j::LEFT_ELBOW, j::RIGHT_ELBOW, j::LEFT_WRIST, j::RIGHT_WRIST, j::LEFT_HAND, j::RIGHT_HAND];

fn smoothstep(a: f64, b: f64, x: f64) -> f64 {
    let t = ((x - a) / (b - a).max(1e-6)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn v3(v: bevy::math::Vec3) -> [f64; 3] {
    [f64::from(v.x), f64::from(v.y), f64::from(v.z)]
}

/// The skeleton as the game reads it. Per joint of SKELETON the live point, moved by what live got
/// wrong in the newest exact frame (exact minus live of that frame), fully below `exactBelow` m/s,
/// not at all above `liveAbove`: slow = exact (brought to now), fast = live. Without exact data (or
/// exactSlow off): the live person. exact_share: the part of the joints taken from exact (0..1).
fn fused(person: Option<&Person>, exact: Option<&PersonsView>, live_then: Option<&PersonsView>, p: &P) -> Sk {
    let mut sk = Sk { joints: [None; NPOINTS], conf: [0.0; NPOINTS], exact_share: 0.0 };
    let Some(q) = person else { return sk };
    for k in 0..NPOINTS {
        sk.joints[k] = q.joints[k].map(v3);
        sk.conf[k] = f64::from(q.confidence[k]);
    }
    let e = if p.exact_slow { exact.and_then(|v| v.by_id(q.id)) } else { None };
    let Some(e) = e else { return sk };
    let lt = live_then.and_then(|v| v.by_id(q.id));
    for &k in &SKELETON {
        let (Some(now), Some(ex)) = (q.joints[k].map(v3), e.joints[k].map(v3)) else { continue };
        let v = q.motion[k].map_or(0.0, |m| f64::from(m.length()));
        let w = 1.0 - smoothstep(p.exact_below, p.live_above, v);
        sk.exact_share += w / SKELETON.len() as f64;
        if w <= 0.0 {
            continue;
        }
        let then = lt.and_then(|l| l.joints[k]).map(v3);
        sk.joints[k] = Some(match then {
            Some(th) => [now[0] + w * (ex[0] - th[0]), now[1] + w * (ex[1] - th[1]), now[2] + w * (ex[2] - th[2])],
            None => [now[0] + w * (ex[0] - now[0]), now[1] + w * (ex[1] - now[1]), now[2] + w * (ex[2] - now[2])],
        });
        if w > 0.5 {
            sk.conf[k] = f64::from(e.confidence[k]);
        }
    }
    sk
}

/// The arms from the skeleton (armSource 'Skelett'): per side the hand (or the wrist) above half the
/// body height and more than armMin from the torso (a bit less to stay on); its direction from the
/// shoulder to the hand seen from above. On after 2 results in a row, off after 4; an id per time up.
fn skeleton_arms(st: &mut St, sk: &Sk, to_wall: &dyn Fn([f64; 3]) -> [f64; 3], inf: &Info, p: &P, ids: &mut i64, out: &mut Vec<ArmRef>) {
    for (key, (sh, wr, hd)) in [(j::LEFT_SHOULDER, j::LEFT_WRIST, j::LEFT_HAND), (j::RIGHT_SHOULDER, j::RIGHT_WRIST, j::RIGHT_HAND)].into_iter().enumerate() {
        let on_now = st.sk[key].is_some_and(|a| a.on);
        let mut want: Option<(f64, f64)> = None;
        let tip_w = if sk.conf[wr] > 0.25 { sk.joints[hd].or(sk.joints[wr]) } else { None };
        if let (Some(tw), Some(shw)) = (tip_w, sk.joints[sh]) {
            let t = to_wall(tw);
            let s0 = to_wall(shw);
            let len = (t[0] - inf.cx).hypot(t[2] - inf.cz);
            if t[1] > 0.5 * st.h && len > p.arm_min - if on_now { 0.05 } else { 0.0 } {
                let mut dx = t[0] - s0[0];
                let mut dz = t[2] - s0[2];
                if dx.hypot(dz) < 0.1 {
                    dx = t[0] - inf.cx;
                    dz = t[2] - inf.cz;
                }
                want = Some((dz.atan2(dx), len));
            }
        }
        match want {
            Some((ang, len)) => {
                let arm = st.sk[key].get_or_insert_with(|| {
                    let id = *ids;
                    *ids += 1;
                    ArmT { id, ang, len, hits: 0, miss: 0, on: false, side: 0.0 }
                });
                arm.ang = ang;
                arm.len = len;
                arm.miss = 0;
                arm.hits += 1;
                if arm.hits >= 2 {
                    arm.on = true;
                }
            }
            None => {
                if let Some(arm) = st.sk[key].as_mut() {
                    arm.hits = 0;
                    arm.miss += 1;
                    if arm.miss >= 4 {
                        st.sk[key] = None;
                    }
                }
            }
        }
        if st.sk[key].is_some_and(|a| a.on) {
            out.push(ArmRef::Sk(key));
        }
    }
}

/// The arm the sensor cannot see (see the top of this file): whether the virtual arm is on. On after
/// 2 frames in a row, off after 4, its direction smoothed; it keeps its id while the visible arm stays.
fn hidden_arm(real: &[ArmRef], st: &mut St, p: &P, time: f64) -> bool {
    let mut want: Option<(i64, f64, f64)> = None; // of (id), angle, len
    if p.mirror_arm
        && real.len() == 1
        && let Some(right) = st.right
        && time - st.right_at < 0.5
        && let Some(a) = real.first().and_then(|&r| st.arm(r)).copied()
    {
        let along = a.ang.cos() * right[0] + a.ang.sin() * right[1];
        let v = [-jsign(along) * right[0], -jsign(along) * right[1]];
        // stretched out along the shoulders (within 30°), the body turned by 50° or more, so the other
        // side lies behind it (a hand pointing ahead turns the shoulders a little: that is no reason)
        if along.abs() > 0.87 && a.len > p.arm_min + 0.15 && v[1] > 0.77 {
            want = Some((a.id, v[1].atan2(v[0]), a.len));
        }
    }
    match want {
        Some((of, ang, len)) => {
            let h = match st.hidden.as_mut() {
                Some(h) if h.of == of => h,
                _ => st.hidden.insert(Hidden { arm: ArmT { id: -of, ang, len, hits: 0, miss: 0, on: false, side: 0.0 }, of }),
            };
            h.arm.ang = wrap(h.arm.ang + wrap(ang - h.arm.ang) * 0.5);
            h.arm.len = len;
            h.arm.miss = 0;
            h.arm.hits += 1;
            if h.arm.hits >= 2 {
                h.arm.on = true;
            }
        }
        None => {
            if let Some(h) = st.hidden.as_mut() {
                h.arm.hits = 0;
                h.arm.miss += 1;
                if h.arm.miss >= 4 {
                    st.hidden = None;
                }
            }
        }
    }
    st.hidden.is_some_and(|h| h.arm.on)
}

/// follows the arms from frame to frame: matched by angle, smoothed, with hysteresis
fn track_arms(st: &mut St, found: &[Found], ids: &mut i64) {
    let mut used = [false; 2];
    for a in st.arms.iter_mut() {
        let mut best: Option<usize> = None;
        let mut bd = 0.7; // rad
        for (fi, f) in found.iter().enumerate() {
            if used.get(fi).copied().unwrap_or(true) {
                continue;
            }
            let d = wrap(f.ang - a.ang).abs();
            if d < bd {
                bd = d;
                best = Some(fi);
            }
        }
        match best.and_then(|fi| found.get(fi).map(|f| (fi, f))) {
            Some((fi, f)) => {
                used[fi] = true;
                a.ang = wrap(a.ang + wrap(f.ang - a.ang) * 0.55);
                a.len += (f.len - a.len) * 0.5;
                a.hits += 1;
                a.miss = 0;
                if a.hits >= 2 {
                    a.on = true;
                }
            }
            None => {
                a.miss += 1;
                a.hits = 0;
                if a.miss >= 4 {
                    a.on = false;
                }
            }
        }
    }
    st.arms.retain(|a| a.miss < 6);
    for (fi, f) in found.iter().enumerate() {
        if used.get(fi).copied().unwrap_or(true) || st.arms.len() >= 2 {
            continue;
        }
        let id = *ids;
        *ids += 1;
        st.arms.push(ArmT { id, ang: f.ang, len: f.len, hits: 1, miss: 0, on: false, side: 0.0 });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_stand_level() {
        let mut r = Ring::new();
        assert_eq!(r.stand(1.0, 0.0, 0.003), 1.0);
        // a higher median raises the level at once, a lower one lets it sink slowly
        for k in 0..30 {
            r.stand(1.2, 0.033 * f64::from(k), 0.003);
        }
        let l = r.stand(0.5, 2.0, 0.003);
        assert!(l > 1.1 && l <= 1.2 + 1e-6, "{l}");
    }

    #[test]
    fn fast_atan2() {
        for k in 0..1000 {
            let a = -PI + TAU * f64::from(k) / 1000.0;
            let (y, x) = (a.sin() as f32 * 0.7, a.cos() as f32 * 0.7);
            let d = f64::from(atan2f(y, x)) - f64::from(y).atan2(f64::from(x));
            let d = (d + PI).rem_euclid(TAU) - PI;
            assert!(d.abs() < 2e-5, "{a}: {d}");
        }
    }

    #[test]
    fn peak_of_one_arm() {
        let mut hist = vec![0.0_f32; SLOTS * BINS];
        let mut rhist = vec![0_u32; SLOTS * BINS * RB];
        let s = 1;
        hist[s * BINS + 18] = 100.0;
        rhist[(s * BINS + 18) * RB + 12] = 100;
        let f = peaks(&hist, &rhist, s, 25.0, 0.45);
        assert_eq!(f.len(), 1);
        assert!((f[0].len - 0.65).abs() < 1e-9);
        assert!((f[0].ang - (18.5 / 36.0 * TAU - PI)).abs() < 1e-9);
    }
}
