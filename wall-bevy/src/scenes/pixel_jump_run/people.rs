//! The people as pixel figures in the LED mosaic, and their jumps (people.js).
//!
//! Every person pixel of the tracking result (ctx.kinect.persons, live masks) goes into the room and
//! onto the wall with the shared wall core (mirror, the walk stretched over the wall, the body in
//! real size, ctx.wall). Then the game scales each figure about its own center so that everybody is
//! the same height on the wall ("figH"): a child and a tall adult duck under the same bat. The floor
//! is the game's ground line. A cell of the mosaic is covered when enough of it is covered by the
//! person (area in m², the same near the sensor or far), and every covered cell gets a body part from
//! the nearest bone of the skeleton: hair, skin, shirt, sleeves, pants, shoes.
//!
//! Jumping: the real hop of a person lifts the body only 10-20 cm. As soon as one is detected (the
//! pelvis rises fast above where it stands, or the feet leave the floor) the figure does a game jump:
//! a fixed arc, high enough to clear the obstacles on the ground. Ducking needs nothing: the figure
//! crouches with the person.
//!
//! Not ported: the test figures (mouse, keyboard, globalThis hooks) and the jump signal log of the
//! calibration tools: the output has neither.

use std::cmp::Ordering;
use std::collections::VecDeque;

use crate::persons::{NPOINTS, Person, PersonsResult, PersonsView, SLOTS, j};
use crate::wall::WallMap;

use super::art::{self, HAIR, Outfit, PANTS, SHIRT, SHOES, SKIN, SLEEVE};
use super::{Layout, P};

const FOCAL: f32 = 366.0; // Kinect v2 depth camera, px: a pixel at z m covers (z / FOCAL)² m²
const HIST_MIN: f32 = -0.5; // m: height histogram per person, 1 cm bins
const HIST_BINS: usize = 300;
const PLAY_HYST: f64 = 0.15; // m
// m: a person's lowest point must have come this near the floor once. The tracker sometimes splits
// off body parts (raised arms, the upper body) as persons of their own for a few seconds: they
// float (lowest point 0.6-1.6 m) and are no people. Someone close to the sensor (0.8 m) shows
// down to about 0.4 m, everyone else down to the floor.
const GROUND_MAX: f64 = 0.45;
// the jump (see Figure::start_jump, Figure::carry)
const V_SMALL: f64 = 1.0; // m/s: the takeoff of a small hop (measured 0.7-1.5, median 1.2); below it jumpHeight
const TA_MIN: f64 = 0.12; // s: the fastest rise (an obstacle is already close)
const TA_MAX: f64 = 0.45; // s: the slowest rise
const G_MIN: f64 = 0.5; // carried over an obstacle the figure may fall this much slower (× the jump's gravity)

/// the figure's gravity (m/s²): a small hop (jumpHeight m) lasts jumpTime s
pub fn jump_gravity(p: &P) -> f64 {
    let t = p.jump_time.max(0.2);
    8.0 * p.jump_height / (t * t)
}

// bones for the body parts: from, to, part (0: the forearm, sleeve or skin by the outfit)
const BONES: [(usize, usize, u8); 15] = [
    (j::NECK, j::PELVIS, SHIRT),
    (j::LEFT_SHOULDER, j::LEFT_HIP, SHIRT),
    (j::RIGHT_SHOULDER, j::RIGHT_HIP, SHIRT),
    (j::LEFT_SHOULDER, j::RIGHT_SHOULDER, SHIRT),
    (j::LEFT_SHOULDER, j::LEFT_ELBOW, SLEEVE),
    (j::RIGHT_SHOULDER, j::RIGHT_ELBOW, SLEEVE),
    (j::LEFT_ELBOW, j::LEFT_WRIST, 0),
    (j::RIGHT_ELBOW, j::RIGHT_WRIST, 0),
    (j::LEFT_WRIST, j::LEFT_HAND, SKIN),
    (j::RIGHT_WRIST, j::RIGHT_HAND, SKIN),
    (j::LEFT_HIP, j::LEFT_KNEE, PANTS),
    (j::RIGHT_HIP, j::RIGHT_KNEE, PANTS),
    (j::LEFT_KNEE, j::LEFT_ANKLE, PANTS),
    (j::RIGHT_KNEE, j::RIGHT_ANKLE, PANTS),
    (j::LEFT_HIP, j::RIGHT_HIP, PANTS),
];
/// the joints of the bones, and the head
const JOINTS: [usize; 17] = [
    j::NECK,
    j::PELVIS,
    j::LEFT_SHOULDER,
    j::LEFT_HIP,
    j::RIGHT_SHOULDER,
    j::RIGHT_HIP,
    j::LEFT_ELBOW,
    j::RIGHT_ELBOW,
    j::LEFT_WRIST,
    j::RIGHT_WRIST,
    j::LEFT_HAND,
    j::RIGHT_HAND,
    j::LEFT_KNEE,
    j::RIGHT_KNEE,
    j::LEFT_ANKLE,
    j::RIGHT_ANKLE,
    j::HEAD,
];

#[derive(Clone, Copy)]
struct Reading {
    stand: f64,
    rise: f64,
    v: f64,
}

/// One height signal of a person: its velocity and its standing level. The standing level is a
/// percentile of the values of the last `win` seconds in which the signal stood still (|v| < 0.25
/// m/s). Not the highest median with a slow decay (the first try): that one got stuck up to 30 cm
/// too high after a few hops in a row or with the arms up, and for a minute no small hop counted.
/// A high percentile over 8 s keeps the level while someone crouches for a few seconds.
struct Signal {
    win: f64,
    pct: f64,
    /// time, value of the still moments
    hist: VecDeque<(f64, f64)>,
    stand: Option<f64>,
    v: f64,
    y: Option<f64>,
    t: f64,
    n: u32,
    sorted: Vec<f64>,
}

impl Signal {
    fn new(win: f64, pct: f64) -> Self {
        Self { win, pct, hist: VecDeque::new(), stand: None, v: 0.0, y: None, t: 0.0, n: 0, sorted: Vec::new() }
    }

    /// adds a value (0/NaN: nothing measured)
    fn add(&mut self, y: f64, time: f64) -> Option<Reading> {
        if y == 0.0 || y.is_nan() {
            return None;
        }
        let dt = time - self.t;
        // velocity by finite difference, lightly smoothed; a gap in the results starts over
        self.v = match self.y {
            Some(prev) if dt > 1e-3 && dt < 0.3 => 0.4 * self.v + 0.6 * ((y - prev) / dt),
            _ => 0.0,
        };
        self.y = Some(y);
        self.t = time;
        self.n = self.n.saturating_add(1);
        if self.v.abs() < 0.25 {
            self.hist.push_back((time, y));
        }
        while self.hist.front().is_some_and(|h| time - h.0 > self.win) {
            self.hist.pop_front();
        }
        if self.hist.len() >= 8 {
            self.sorted.clear();
            self.sorted.extend(self.hist.iter().map(|h| h.1));
            let i = (self.sorted.len() - 1).min((self.sorted.len() as f64 * self.pct).floor() as usize);
            let (_, v, _) = self.sorted.select_nth_unstable_by(i, f64::total_cmp);
            self.stand = Some(*v);
        } else if self.stand.is_none() {
            self.stand = Some(y);
        }
        let stand = self.stand.unwrap_or(y);
        Some(Reading { stand, rise: y - stand, v: self.v })
    }
}

/// distance from (px, py) to the segment a-b
fn seg_dist(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = bx - ax;
    let dy = by - ay;
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 1e-9 { ((px - ax) * dx + (py - ay) * dy) / l2 } else { 0.0 };
    let t = t.clamp(0.0, 1.0);
    let ex = ax + dx * t - px;
    let ey = ay + dy * t - py;
    (ex * ex + ey * ey).sqrt()
}

/// the running jump (Figure::start_jump, Figure::carry)
#[derive(Clone, Copy, Debug)]
pub struct Jump {
    pub t0: f64,
    from: f64,
    apex: f64,
    pub ta: f64,
    g: f64,
    carried: u32,
}

/// what the jump detection reads from the mask (rasterize)
#[derive(Default)]
struct Sig {
    feet_y: f64,
    med_y: f64,
    mean_y: f64,
    raw_y: f64,
}

pub struct Figure {
    pub id: u32,
    pub slot: u8,
    pub outfit: Outfit,
    pub born: f64,
    seen: f64,
    seen_now: bool,
    pub visible: bool,
    /// touched the floor once (GROUND_MAX): before that, no person
    grounded: bool,
    /// plays (within the play distance), else stands in the background
    pub player: bool,
    /// scale real body -> figure on the wall (0 = not known yet)
    pub k: f64,
    /// wall x of the body center (m from the left edge)
    pub cx: f64,
    pub dist: f64,
    /// the standing height (top of the head)
    heights: Signal,
    // the jump signals: the mask's median and mean height, its feet, the raw pelvis
    body: Signal,
    mean: Signal,
    feet: Signal,
    pelvis: Signal,
    /// when the push-off of a possible jump was seen, and the fastest rise of the body since (m/s)
    candidate: f64,
    cand_v: f64,
    stand_h: f64,
    /// m on the wall: how far the real body is above where it stands
    real_rise: f64,
    sig: Sig,
    /// time, m/s over the floor of the last 0.3 s
    walks: VecDeque<(f64, f64)>,
    /// part per cell (before the jump lift)
    pub grid: Vec<u8>,
    pub has_grid: bool,
    /// c0, r0, c1, r1 (inclusive)
    pub bbox: [i32; 4],
    /// col, row of the top of the head (before the lift)
    pub head_cell: Option<[i32; 2]>,
    /// the bones in game m: x0, y0, x1, y1, part
    pub segs: Vec<[f64; 5]>,
    /// jumping (game physics), m above the ground
    pub air: bool,
    h: f64,
    pub jump: Option<Jump>,
    instant: f64,
    headroom: f64,
    /// m above the ground: the top of the head (before the lift)
    head_top: Option<f64>,
    pub air_jumps: u32,
    /// the next hop may trigger a jump
    armed: bool,
    armed_at: f64,
    /// m and cells the figure is drawn higher than the person's mask
    lift: f64,
    pub lift_rows: i32,
    pub jumps: u32,
    pub just_landed: bool,
    // game state
    pub hit_at: f64,
    pub safe_until: f64,
    pub star_until: f64,
    pub streak: i64,
    /// None: never joined a round
    pub alive: Option<bool>,
    /// the round joined (-1: none)
    pub round: i64,
    pub lives: f64,
    pub round_score: f64,
    pub lift_hist: VecDeque<i32>,
    pub puff: f64,
}

impl Figure {
    fn new(id: u32, slot: u8, time: f64) -> Self {
        Self {
            id,
            slot,
            outfit: art::outfit(i64::from(id), i64::from(slot)),
            born: time,
            seen: time,
            seen_now: false,
            visible: true,
            grounded: false,
            player: false,
            k: 0.0,
            cx: 0.0,
            dist: 3.0,
            heights: Signal::new(8.0, 0.8),
            body: Signal::new(8.0, 0.8),
            mean: Signal::new(8.0, 0.8),
            feet: Signal::new(4.0, 0.5),
            pelvis: Signal::new(8.0, 0.8),
            candidate: -9.0,
            cand_v: 0.0,
            stand_h: 0.0,
            real_rise: 0.0,
            sig: Sig::default(),
            walks: VecDeque::new(),
            grid: Vec::new(),
            has_grid: false,
            bbox: [0, 0, -1, -1],
            head_cell: None,
            segs: Vec::new(),
            air: false,
            h: 0.0,
            jump: None,
            instant: 1.0,
            headroom: 0.1,
            head_top: None,
            air_jumps: 0,
            armed: true,
            armed_at: 0.0,
            lift: 0.0,
            lift_rows: 0,
            jumps: 0,
            just_landed: false,
            hit_at: -10.0,
            safe_until: 0.0,
            star_until: 0.0,
            streak: 0,
            alive: None,
            round: -1,
            lives: 0.0,
            round_score: 0.0,
            lift_hist: VecDeque::with_capacity(9),
            puff: 0.0,
        }
    }

    /// A jump: an arc, as high as the person jumped. A small hop (takeoff V_SMALL m/s or slower) goes
    /// jumpHeight m up and lasts jumpTime s, a strong one (jumpStrong m/s) jumpHeightMax m; in between
    /// by the takeoff speed `v` (the fastest rise of the body since the push-off). Rising it slows
    /// down, falling it speeds up with the same gravity (jump_gravity). The game then stretches the
    /// jump over the obstacle that comes (carry). In the air another hop starts again from where the
    /// figure is: air jumps. lead: s of the jump that already passed when it was detected (only on
    /// the ground).
    fn start_jump(&mut self, time: f64, p: &P, lead: f64, v: f64) {
        let strong = (V_SMALL + 0.1).max(p.jump_strong);
        let s = ((v - V_SMALL) / (strong - V_SMALL)).clamp(0.0, 1.0);
        let hh = p.jump_height + (p.jump_height_max - p.jump_height).max(0.0) * s;
        let g = jump_gravity(p);
        self.air_jumps = if self.air { self.air_jumps + 1 } else { 0 };
        // takes off from where the figure is drawn now (the instant lift may have raised it already)
        let from = if self.air { self.h } else { self.h.max(self.real_rise * self.instant) };
        self.jump = Some(Jump { t0: time - if self.air { 0.0 } else { lead }, from, apex: from + hh, ta: (2.0 * hh / g).sqrt(), g, carried: 0 });
        self.air = true;
        self.jumps += 1;
    }

    /// Carries the running jump over an obstacle: the figure is at least `clear` m up from `a` to
    /// `b` s from now (Game::carry: while the obstacle passes below). Planned again from where the
    /// figure is now: the rise time that needs the lowest top (the top over the middle of the
    /// obstacle, rising in TA_MIN-TA_MAX s), never lower than the hop itself. At most `assistMax` m
    /// above the obstacle; if that is not enough (jumped much too early), it falls a little slower
    /// (G_MIN), and then it lands on the obstacle after all.
    pub fn carry(&mut self, time: f64, a: f64, b: f64, clear: f64, p: &P) {
        let Some(j) = self.jump else { return };
        let from = self.h;
        let g = j.g;
        let own = j.apex.max(from); // the hop's own top
        let mut best: Option<(f64, f64)> = None;
        let mut ta = TA_MIN;
        while ta <= TA_MAX + 1e-6 {
            if a < TA_MIN && ta > TA_MIN {
                break; // the obstacle is close: up as fast as possible
            }
            let mut apex = own.max(clear + 0.02);
            if b > ta {
                apex = apex.max(clear + g * (b - ta).powi(2) / 2.0); // still up when it has passed
            }
            if a > 0.0 && a < ta {
                let u = a / ta; // already up when it comes
                apex = apex.max(from + (clear - from) / (u * (2.0 - u)));
            }
            if best.is_none_or(|(_, ba)| apex < ba - 1e-4) {
                best = Some((ta, apex));
            }
            ta += 0.01;
        }
        let Some((bta, mut bapex)) = best else { return };
        let cap = own.max(clear + p.assist_max);
        let mut g_down = g;
        if bapex > cap {
            bapex = cap;
            if b > bta {
                g_down = g.min((g * G_MIN).max(2.0 * (cap - clear) / (b - bta).powi(2)));
            }
        }
        self.jump = Some(Jump { t0: time, from, apex: bapex, ta: bta, g: g_down, carried: j.carried + 1 });
    }

    /// the jump's height at `time`: up (slowing down), down (speeding up), land; the head stays
    /// (about) on the wall
    fn update_lift(&mut self, time: f64, l: &Layout) {
        if self.air
            && let Some(j) = self.jump
        {
            // the ceiling: the head may rise `headroom` m beyond the wall's top edge (raised hands may
            // go further out; they used to be the ceiling, and a hop with the arms up stayed tiny)
            let wall_top = f64::from(l.ground_row) * l.cell_my;
            let head = self.head_top.unwrap_or_else(|| self.head_cell.map_or(1.2, |c| f64::from(l.ground_row - c[1]) * l.cell_my));
            let ceil = (wall_top + self.headroom - head + self.real_rise).max(0.1);
            let t = time - j.t0;
            let h = if t < j.ta {
                let u = t / j.ta;
                j.from + (j.apex - j.from) * u * (2.0 - u)
            } else {
                j.apex - j.g * (t - j.ta).powi(2) / 2.0
            };
            if t >= j.ta && h <= 0.0 {
                self.h = 0.0;
                self.air = false;
                self.jump = None;
                self.just_landed = true;
            } else {
                self.h = h.min(ceil.max(j.from));
            }
        }
        // the figure rises with the real body already (its mask); `instant` lifts it more at once,
        // before the jump is detected; the jump only adds what is missing
        self.lift = (self.h.max(self.real_rise * self.instant) - self.real_rise).max(0.0);
        self.lift_rows = art::js_round(self.lift / l.cell_my) as i32;
    }
}

/// How the points of one person slot land on the mosaic (rasterize).
#[derive(Clone, Copy, Default)]
struct Slot {
    on: bool,
    /// gx = a + b * rx (the person placed as a whole), else through wall.room_x
    linear: bool,
    a: f32,
    b: f32,
    cx: f32,
    /// k * wide, the projection's body scale, the figure's size, area per point at 1 m
    kw: f32,
    body: f32,
    k: f32,
    area: f32,
}

/// The figures, their masks on the mosaic, their jumps.
pub struct PeopleLayer {
    /// every figure (in the order they came), by index for this frame
    pub figures: Vec<Figure>,
    /// the figures on the wall now, far to near
    pub list: Vec<usize>,
    /// covered area per cell, per slot (a mosaic each, for the slots with a figure)
    area: Vec<Vec<f32>>,
    hist: Vec<u32>,
    key: (i32, i32),
    /// the figures that became players / jumped in this frame
    pub entered: Vec<usize>,
    pub jumped: Vec<usize>,
    entered_ids: Vec<u32>,
}

impl Default for PeopleLayer {
    fn default() -> Self {
        Self {
            figures: Vec::new(),
            list: Vec::new(),
            area: (0..SLOTS).map(|_| Vec::new()).collect(),
            hist: vec![0; SLOTS * HIST_BINS],
            key: (0, 0),
            entered: Vec::new(),
            jumped: Vec::new(),
            entered_ids: Vec::new(),
        }
    }
}

impl PeopleLayer {
    /// The figures for this frame; rasterizes the masks when a new tracking result came.
    #[allow(clippy::too_many_arguments)]
    pub fn update(&mut self, wall: &WallMap, view: &PersonsView, kp: Option<&PersonsResult>, x_sign: f32, rays: &[f32], l: &Layout, p: &P, time: f64) {
        let key = (l.gw, l.gh);
        if key != self.key {
            self.key = key;
            for a in &mut self.area {
                *a = Vec::new();
            }
            for f in &mut self.figures {
                f.has_grid = false;
            }
        }
        self.entered.clear();
        self.jumped.clear();
        self.entered_ids.clear();
        let fresh = view.fresh && kp.is_some();

        // who is there
        for f in &mut self.figures {
            f.seen_now = false;
        }
        for q in &wall.persons {
            if !q.in_zone {
                continue;
            }
            let fi = match self.figures.iter().position(|f| f.id == q.id) {
                Some(i) => i,
                None => {
                    self.figures.push(Figure::new(q.id, q.slot, time));
                    self.figures.len() - 1
                }
            };
            let Some(f) = self.figures.get_mut(fi) else { continue };
            f.seen_now = true;
            f.slot = q.slot;
            f.seen = time;
            f.cx = f64::from(q.x);
            f.dist = f64::from(q.dist);
            // plays only within the play distance (further away the tracking is too rough): the others
            // stand in the background, smaller and dim. A little hysteresis against flicker at the edge.
            let m = if f.player { PLAY_HYST } else { -PLAY_HYST };
            let play = f.grounded && f.dist >= p.play_near - m && f.dist <= p.play_far + m;
            if play && !f.player {
                f.born = time; // appears as a player
                self.entered_ids.push(f.id);
            }
            f.player = play;
            if fresh && let Some(person) = view.by_id(q.id) {
                scale(f, person, p, time);
            }
        }
        for f in &mut self.figures {
            f.visible = f.seen_now;
        }
        self.figures.retain(|f| f.visible || time - f.seen <= 1.5);
        for id in &self.entered_ids {
            if let Some(i) = self.figures.iter().position(|f| f.id == *id) {
                self.entered.push(i);
            }
        }

        if fresh {
            if let Some(kp) = kp {
                self.rasterize(wall, view, kp, x_sign, rays, l, p);
            }
            for fi in 0..self.figures.len() {
                let Some(f) = self.figures.get_mut(fi) else { continue };
                if !f.visible {
                    continue;
                }
                let Some(person) = view.by_id(f.id) else { continue };
                if signals(f, person, wall, p, time) {
                    self.jumped.push(fi);
                }
            }
        }

        self.list.clear();
        for (fi, f) in self.figures.iter_mut().enumerate() {
            if !f.visible || !f.has_grid || !f.grounded {
                continue;
            }
            f.instant = p.instant;
            f.headroom = p.headroom;
            f.update_lift(time, l);
            self.list.push(fi);
        }
        let figs = &self.figures;
        self.list.sort_by(|&a, &b| match (figs.get(a), figs.get(b)) {
            (Some(a), Some(b)) => b.dist.partial_cmp(&a.dist).unwrap_or(Ordering::Equal),
            _ => Ordering::Equal,
        });
    }

    /// person pixels -> cells per figure, then the body parts
    #[allow(clippy::too_many_arguments)]
    fn rasterize(&mut self, wall: &WallMap, view: &PersonsView, kp: &PersonsResult, x_sign: f32, rays: &[f32], l: &Layout, p: &P) {
        let (Some(labels), Some(depth), Some(indices)) = (&kp.labels, &kp.depth, &kp.indices) else { return };
        let m = &wall.room;
        let [near, far] = wall.zone(); // the projection's zone, room z (m from the sensor)
        let (gw, gh) = (l.gw, l.gh);
        let n = (gw * gh) as usize;

        let mut by_slot: [Option<usize>; SLOTS] = [None; SLOTS];
        for (fi, f) in self.figures.iter().enumerate() {
            let s = usize::from(f.slot);
            if f.visible && s > 0 && s < SLOTS && f.k != 0.0 && !f.k.is_nan() {
                by_slot[s] = Some(fi);
            }
        }
        // per slot: where a point lands across the mosaic, gx = a + b * rx when the projection places
        // the person as a whole (the usual), else through wall.room_x; the figure's size
        let wide = p.wide as f32;
        let inv_f2 = 1.0 / (FOCAL * FOCAL);
        let (ms, x0) = (wall.mirror_sign(), wall.plan_x0());
        let mut slots = [Slot::default(); SLOTS];
        for s in 0..SLOTS {
            let Some(f) = by_slot[s].and_then(|fi| self.figures.get(fi)) else { continue };
            let (cx, k, body) = (f.cx as f32, f.k as f32, wall.scale[s]);
            let kw = k * wide;
            // wall.room_x of a person placed as a whole: offset + mirror * plan x * scale
            let linear = wall.projection.per_person && wall.visible[s];
            slots[s] = Slot { on: true, linear, a: cx + ((wall.offset[s] - cx) / body + ms * x0) * kw, b: ms * wall.x_sign * kw, cx, kw, body, k, area: inv_f2 * k * k * wide };
        }
        let mut area: [&mut [f32]; SLOTS] = Default::default();
        for ((a, sl), out) in self.area.iter_mut().zip(&slots).zip(area.iter_mut()) {
            if !sl.on {
                continue;
            }
            if a.len() != n {
                a.clear();
                a.resize(n, 0.0);
            } else {
                a.fill(0.0);
            }
            *out = a.as_mut_slice();
        }
        self.hist.fill(0);
        let mut sum_y = [0.0_f64; SLOTS];
        let mut cnt_y = [0_u32; SLOTS];

        let px_x = (l.px_x / f64::from(l.cell_px)) as f32;
        let ox_c = (f64::from(l.ox) / f64::from(l.cell_px)) as f32;
        let row_top = (l.ground_row - 1) as f32;
        let inv_cy = (1.0 / l.cell_my) as f32;
        let (gwf, gwu) = (gw as f32, gw as usize);
        // rows of the mosaic: row = row_top - floor(gy / cell) within 0..gh
        let (rf_lo, rf_hi) = (row_top - gh as f32 + 1.0, row_top + 1.0);
        let (labels, depth, indices): (&[u8], &[u16], &[u32]) = (labels, depth, indices);
        let hist = &mut self.hist[..];
        for &i in indices.iter().take(kp.count) {
            let i = i as usize;
            let Some(&lab) = labels.get(i) else { continue };
            let s = usize::from(lab);
            let Some(sl) = slots.get(s).filter(|sl| sl.on) else { continue };
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
            // (floor of a value >= 0 by truncation: f32::floor is a libm call on plain x86-64)
            let hb = (ry - HIST_MIN) * 100.0;
            if hb >= 0.0 && hb < HIST_BINS as f32 {
                hist[s * HIST_BINS + hb as usize] += 1;
            }
            sum_y[s] += f64::from(ry);
            cnt_y[s] += 1;
            // where the projection puts this point (the figure's own size k replaces the projection's
            // body scale: everybody to figH)
            let gx = if sl.linear { sl.a + sl.b * rx } else { sl.cx + (wall.room_x(rx, rz, s) - sl.cx) / sl.body * sl.kw };
            let col = gx * px_x - ox_c;
            let rf = ry * sl.k * inv_cy;
            if !(col >= 0.0 && col < gwf && rf >= rf_lo && rf < rf_hi) {
                continue;
            }
            let t = rf as i32;
            let row = (row_top as i32 - if t as f32 > rf { t - 1 } else { t }) as usize;
            if let Some(a) = area[s].get_mut(row * gwu + col as usize) {
                *a += z * z * sl.area;
            }
        }

        // feet and top of each person from the height histogram (robust percentiles)
        for s in 1..SLOTS {
            let Some(fi) = by_slot[s] else { continue };
            let h = &self.hist[s * HIST_BINS..(s + 1) * HIST_BINS];
            let total: u32 = h.iter().sum();
            if total < 50 {
                continue;
            }
            // percentiles of the height of all the person's pixels, interpolated inside the 1 cm bins
            let qs = [0.03, 0.1, 0.25, 0.5, 0.99];
            let mut at = [-1.0_f64; 5];
            let mut acc = 0_u32;
            let total = f64::from(total);
            for (b, &c) in h.iter().enumerate() {
                let before = f64::from(acc);
                acc += c;
                for (k, q) in qs.iter().enumerate() {
                    if at[k] < 0.0 && f64::from(acc) >= total * q {
                        at[k] = b as f64 + if c > 0 { (total * q - before) / f64::from(c) } else { 0.5 };
                    }
                }
            }
            let Some(f) = self.figures.get_mut(fi) else { continue };
            f.sig.feet_y = f64::from(HIST_MIN) + at[0] / 100.0;
            if f.sig.feet_y < GROUND_MAX {
                f.grounded = true;
            }
            f.sig.med_y = f64::from(HIST_MIN) + at[3] / 100.0;
            f.sig.mean_y = if cnt_y[s] > 0 { sum_y[s] / f64::from(cnt_y[s]) } else { 0.0 };
        }

        let need = p.fill * l.cell_mx * l.cell_my;
        for (s, fi) in by_slot.iter().enumerate().skip(1) {
            let Some(fi) = *fi else { continue };
            let (Some(f), Some(a)) = (self.figures.get_mut(fi), self.area.get(s)) else { continue };
            let person = view.by_id(f.id);
            parts(f, a, need, wall, person, l, p);
        }
    }
}

/// the person's scale on the wall: everyone the same height (or everyone scaled alike)
fn scale(f: &mut Figure, person: &Person, p: &P, time: f64) {
    let h = if person.height.is_finite() { f64::from(person.height) } else { 0.0 };
    if h > 0.5
        && let Some(r) = f.heights.add(h, time)
    {
        f.stand_h = r.stand;
    }
    let base = if f.stand_h != 0.0 {
        f.stand_h
    } else if h != 0.0 {
        h
    } else {
        1.7
    };
    let stand_h = base.clamp(0.9, 2.2);
    let kt = (if p.same_size { p.fig_h / stand_h } else { p.fig_h / 1.75 }) * if f.player { 1.0 } else { p.bg_scale };
    f.k = if f.k != 0.0 { f.k + (kt - f.k) * 0.08 } else { kt };
}

/// The jump detection, once per tracking result (true: a jump started). Calibrated on two
/// recordings (hops on cue, small, normal, high, several in a row; squats, ducking, tiptoes, arms,
/// bobbing knees, steps, bending, crouching, standing up fast, walking), see calibrate/README.md.
///
/// Everything comes from the person's mask (every frame, exact, not smoothed, independent of the
/// pose model, whose skeleton gets rough when the GPU is busy):
/// 1. Push-off: the median height of the mask moves up fast enough near where it stands that the
///    body would fly (height + v^2 / 2g above the standing level), and the mask's mean rises too.
/// 2. Confirmed within 0.35 s by the feet (lowest 3 % of the mask) leaving the floor by 2 cm, with
///    the body 6 cm above its standing level. Every real hop lifts the feet (3-34 cm); ducking,
///    squats, crouching and raised arms do not (at most 1-3 cm).
/// 3. The skeleton's raw pelvis may veto: when it stays below 3 cm above its standing level, it
///    was the arms that lifted the mask.
fn signals(f: &mut Figure, person: &Person, wall: &WallMap, p: &P, time: f64) -> bool {
    let m = &wall.room;
    // the raw pelvis in the room (the smoothed one lags 0.1-0.2 s)
    f.sig.raw_y = 0.0;
    if let Some(raw) = person.camera.extra.get(1)
        && raw[3].get() > 0.0
    {
        let wx = f64::from(wall.x_sign) * raw[0].get() / 1000.0;
        let wy = -raw[1].get() / 1000.0;
        let wz = raw[2].get() / 1000.0;
        let y = f64::from(m[1]) * wx + f64::from(m[5]) * wy + f64::from(m[9]) * wz + f64::from(m[13]);
        f.sig.raw_y = if y.is_finite() { y } else { 0.0 };
    }
    // how fast the person moves over the floor (walking): the most of the last 0.3 s
    let walk = f64::from(person.velocity.x).hypot(f64::from(person.velocity.z));
    f.walks.push_back((time, walk));
    while f.walks.front().is_some_and(|w| time - w.0 > 0.3) {
        f.walks.pop_front();
    }
    let walking = f.walks.iter().map(|w| w.1).fold(f64::NEG_INFINITY, f64::max);

    let body = f.body.add(f.sig.med_y, time);
    let mean = f.mean.add(f.sig.mean_y, time);
    let feet = f.feet.add(f.sig.feet_y, time);
    let pelv = if f.sig.raw_y != 0.0 { f.pelvis.add(f.sig.raw_y, time) } else { None };
    let Some(body) = body else {
        f.real_rise = 0.0;
        return false;
    };
    // the figure's own rise: the smaller of mask and pelvis (raised arms lift only the mask)
    f.real_rise = body.rise.min(pelv.map_or(body.rise, |q| q.rise)).max(0.0) * f.k;
    let flies = body.rise > -p.jump_dip && body.rise + body.v * body.v / 19.62 > p.jump_rise;
    if body.v > p.jump_vy && mean.is_none_or(|q| q.v > p.jump_vy2) && flies && walking < p.walk_gate {
        f.cand_v = if time - f.candidate < 0.35 { f.cand_v.max(body.v) } else { body.v }; // the takeoff speed
        f.candidate = time;
    }
    let feet_up = feet.is_none_or(|q| q.rise > p.feet_up);
    let pelvis_ok = pelv.is_none_or(|q| q.rise > p.pelvis_min);
    let can = f.player && f.alive != Some(false) && f.armed && time - f.born > 1.0 && f.body.n >= 20;
    // every hop counts, also in the air (air jumps). One hop fires once: the next one needs the body
    // to have stopped rising first.
    if can && time - f.candidate < 0.35 && feet_up && body.rise > p.min_rise && pelvis_ok {
        let v = f.cand_v.max(body.v);
        f.start_jump(time, p, p.jump_lead, v);
        f.armed = false;
        f.armed_at = time;
        f.candidate = -9.0;
        return true;
    }
    if !f.armed && time - f.armed_at > p.jump_rest && (body.v < 0.05 || body.rise < p.jump_rise * 0.35) {
        f.armed = true;
    }
    false
}

/// covered cells of one figure -> body parts (grid, bbox)
fn parts(f: &mut Figure, a: &[f32], need: f64, wall: &WallMap, person: Option<&Person>, l: &Layout, p: &P) {
    let (gw, gh) = (l.gw, l.gh);
    let n = (gw * gh) as usize;
    if f.grid.len() != n {
        f.grid.clear();
        f.grid.resize(n, 0);
    }
    f.has_grid = true;
    let g = &mut f.grid;
    g.fill(0);
    let (mut c0, mut r0, mut c1, mut r1) = (gw, gh, -1, -1);
    for (c, &v) in a.iter().enumerate().take(n) {
        if f64::from(v) < need {
            continue;
        }
        g[c] = 1;
        let x = c as i32 % gw;
        let y = c as i32 / gw;
        c0 = c0.min(x);
        c1 = c1.max(x);
        r0 = r0.min(y);
        r1 = r1.max(y);
    }
    f.bbox = [c0, r0, c1, r1];
    if c1 < 0 {
        return;
    }
    // close single holes, drop lone cells (4 neighbours)
    let at = |g: &[u8], x: i32, y: i32| x >= 0 && y >= 0 && x < gw && y < gh && g.get((y * gw + x) as usize).is_some_and(|&v| v != 0);
    for y in r0..=r1 {
        for x in c0..=c1 {
            let nb = i32::from(at(g, x - 1, y)) + i32::from(at(g, x + 1, y)) + i32::from(at(g, x, y - 1)) + i32::from(at(g, x, y + 1));
            let c = (y * gw + x) as usize;
            let (Some(&v), Some(&ac)) = (g.get(c), a.get(c)) else { continue };
            if v == 0 && nb >= 3 {
                g[c] = 2;
            } else if v == 1 && nb == 0 && f64::from(ac) < need * 2.5 {
                g[c] = 0;
            }
        }
    }

    // the skeleton in game meters
    let slot = usize::from(f.slot);
    let mut jn: [Option<[f64; 2]>; NPOINTS] = [None; NPOINTS];
    if let Some(person) = person {
        let body = f64::from(wall.scale.get(slot).copied().unwrap_or(1.0));
        for &ji in &JOINTS {
            let Some(r) = person.room.joints[ji] else { continue };
            let w = wall.from_room(r, slot);
            let mut v = (f64::from(w.x) - f.cx) / body;
            if v.is_nan() {
                v = 0.0;
            }
            jn[ji] = Some([f.cx + v * f.k * p.wide, f64::from(r.y) * f.k]);
        }
    }
    let segs = &mut f.segs;
    segs.clear();
    let fore = if f.outfit.long_sleeves { SLEEVE } else { SKIN };
    for &(a1, b1, part) in &BONES {
        if let (Some(a), Some(b)) = (jn[a1], jn[b1]) {
            segs.push([a[0], a[1], b[0], b[1], f64::from(if part == 0 { fore } else { part })]);
        }
    }
    let head = jn[j::HEAD];
    let head_r = 0.11 * f.k; // a head is about 22 cm tall
    let neck_y = jn[j::NECK].map_or(-1.0, |q| q[1]);
    let shoes_y = l.cell_my * 1.05;
    let mut count = 0;
    let mut top_row = gh;
    let mut top_col = 0;
    for y in r0..=r1 {
        let gy = (f64::from(l.ground_row - 1 - y) + 0.5) * l.cell_my;
        for x in c0..=c1 {
            let c = (y * gw + x) as usize;
            if g.get(c).is_none_or(|&v| v == 0) {
                continue;
            }
            count += 1;
            if y < top_row {
                top_row = y;
                top_col = x;
            }
            let gx = ((f64::from(x) + 0.5) * f64::from(l.cell_px) + f64::from(l.ox)) / l.px_x;
            let mut best = 1e9;
            let mut part = SHIRT;
            for sg in segs.iter() {
                let d = seg_dist(gx, gy, sg[0], sg[1], sg[2], sg[3]);
                if d < best {
                    best = d;
                    part = sg[4] as u8;
                }
            }
            if let Some(hd) = head {
                let dh = (gx - hd[0]).hypot(gy - hd[1]) - head_r;
                if dh < best && gy > neck_y {
                    part = if gy > hd[1] + head_r * 0.15 { HAIR } else { SKIN };
                }
            } else if segs.is_empty() && y <= r0 + 2 {
                part = HAIR;
            }
            if part == PANTS && gy < shoes_y {
                part = SHOES;
            }
            g[c] = part;
        }
    }
    f.head_cell = if count > 0 { Some([top_col, top_row]) } else { None };
    // the top of the head (the skeleton's head, else the figure's top: then raised hands count)
    f.head_top = match head {
        Some(hd) => Some(hd[1] + head_r),
        None if count > 0 => Some(f64::from(l.ground_row - top_row) * l.cell_my),
        None => None,
    };
}
