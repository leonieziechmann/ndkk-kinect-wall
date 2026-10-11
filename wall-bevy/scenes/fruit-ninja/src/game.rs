//! The game (game.js), in wall meters (x from the left edge of the wall, y above the floor, up).
//!
//! Fruit is thrown up from below the wall in arcs that peak where the people can reach them. A fast
//! hand cuts it (people.rs: blades): two halves fly apart and show the inside, juice sprays, a splash
//! stays on the wall for a moment. Several fruits in one swipe are a combo. Bombs hurt (points off, a
//! big bang), the star fruit starts a frenzy (fruit flies in from both sides), the frost fruit slows
//! time down.
//!
//! Cuts happen at once on the live hands. With live + exact tracking the exact skeletons follow
//! 150-250 ms later: a swipe that live missed still cuts then, tested against where the fruit was at
//! that moment (every fruit keeps its way of the last second). Only fruit: a bomb goes off on live
//! hits alone, so a late correction never punishes anybody.
//!
//! Rounds like the jump'n'run: as soon as people are there a round starts (the bar at the top
//! fills), runs `roundTime` s (the bar empties), the last seconds get wild, then the remaining fruit
//! bursts and the best of the round wears the crown in the next one. Nobody there: now and then a
//! fruit flies and a ghost blade cuts it, to show what happens. No text: everyone finds out by trying.
//! (The browser's event list for sounds is left out: the scene has no sound.)

use std::collections::VecDeque;
use std::f64::consts::PI;
use std::fmt::Write as _;

use wall::common::rand::Rng;

use super::fruits::{Kind, NORMAL, info};
use super::fx::Fx;
use super::people::{BladeKey, Seg, Shown};
use super::pix::{Label, Rgb, TURN};
use super::{P, color_of};

/// Math.min(b, Math.max(a, x)) (never panics, unlike f64::clamp)
fn clamp(x: f64, a: f64, b: f64) -> f64 {
    b.min(a.max(x))
}

fn seg_dist(px: f64, py: f64, s: &Seg) -> f64 {
    let dx = s.x1 - s.x0;
    let dy = s.y1 - s.y0;
    let l2 = dx * dx + dy * dy;
    let h = if l2 > 1e-9 { clamp(((px - s.x0) * dx + (py - s.y0) * dy) / l2, 0.0, 1.0) } else { 0.0 };
    (px - s.x0 - dx * h).hypot(py - s.y0 - dy * h)
}

/// where a fruit was at real time t: its way is [t, x, y] per frame; None if not yet thrown
fn way_at(way: &VecDeque<[f64; 3]>, t: f64) -> Option<[f64; 2]> {
    let (first, last) = (way.front()?, way.back()?);
    if t < first[0] || t > last[0] + 0.05 {
        return None;
    }
    for i in 1..way.len() {
        let (a, b) = (way[i - 1], way[i]);
        if b[0] < t {
            continue;
        }
        let w = (t - a[0]) / (b[0] - a[0]).max(1e-6);
        return Some([a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w]);
    }
    Some([last[1], last[2]])
}

// embers: orange -> deep red -> magenta -> violet (never brown)
const EMBERS: [Rgb; 5] = [[1.0, 0.85, 0.4], [1.0, 0.45, 0.1], [1.0, 0.1, 0.2], [0.9, 0.1, 0.6], [0.5, 0.15, 0.9]];
pub fn ember(u: f64) -> Rgb {
    let f = clamp(u, 0.0, 0.999) * (EMBERS.len() - 1) as f64;
    let i = (f.floor() as usize).min(EMBERS.len() - 2);
    let w = (f - i as f64) as f32;
    let (a, b) = (EMBERS[i], EMBERS[i + 1]);
    [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w]
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    Idle,
    Ready,
    Play,
    End,
}

impl Phase {
    pub fn name(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Ready => "ready",
            Phase::Play => "play",
            Phase::End => "end",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum From {
    Below,
    Left,
    Right,
}

pub struct Fruit {
    pub id: u32,
    pub kind: Kind,
    pub x: f64,
    pub y: f64,
    vx: f64,
    pub vy: f64,
    pub r: f64,
    g: f64,
    pub rot: f64,
    vr: f64,
    born: f64,
    /// its way (real time, as the blades): where it was when a late exact frame was live
    way: VecDeque<[f64; 3]>,
}

pub struct Half {
    pub kind: Kind,
    pub x: f64,
    pub y: f64,
    vx: f64,
    vy: f64,
    pub r: f64,
    g: f64,
    pub rot: f64,
    pub vr: f64,
    /// the cut's normal in the fruit's frame, which side this is
    pub na: f64,
    pub side: f64,
    born: f64,
}

/// juice and sparks
pub struct Drop {
    pub x: f64,
    pub y: f64,
    vx: f64,
    vy: f64,
    pub col: Rgb,
    pub ember: bool,
    /// art px
    pub size: f64,
    pub t0: f64,
    pub life: f64,
}

/// a block of a splash: offset (m), size (art px), when it dies (share of the life), how far down
/// a run it is (runs grow down over the first quarter)
#[derive(Clone, Copy)]
pub struct SplatBlock {
    pub x: f64,
    pub y: f64,
    pub unit: f64,
    pub death: f64,
    pub run: Option<f64>,
}

/// juice on the wall
pub struct Splat {
    pub x: f64,
    pub y: f64,
    pub col: Rgb,
    pub blocks: Vec<SplatBlock>,
    pub t0: f64,
    pub life: f64,
}

/// the white flash of a cut
pub struct Slash {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub t0: f64,
    pub life: f64,
}

/// a shock wave
pub struct Ring {
    pub x: f64,
    pub y: f64,
    pub r0: f64,
    pub r1: f64,
    pub col: Rgb,
    pub t0: f64,
    pub life: f64,
    pub w: f64,
}

/// a number on the wall
pub struct Pop {
    pub text: Label,
    pub x: f64,
    pub y: f64,
    pub h: f64,
    pub col: Rgb,
    pub t0: f64,
    pub life: f64,
    pub vy: f64,
}

/// a fruit to throw a moment later (target: a person id)
struct Queued {
    at: f64,
    kind: Kind,
    target: Option<u32>,
}

struct Combo {
    key: BladeKey,
    n: u32,
    last: f64,
    x: f64,
    y: f64,
    id: Option<u32>,
    slot: u8,
}

pub struct Score {
    pub id: u32,
    pub pts: f64,
}

#[derive(Default)]
pub struct Stats {
    pub thrown: u64,
    pub cut: u64,
    pub late: u64,
    pub bombs: u64,
    pub missed: u64,
    pub combos: u64,
    pub rounds: u64,
    pub segs: u64,
    pub late_segs: u64,
}

/// What a step sees of the world.
pub struct World<'a> {
    pub wall_w: f64,
    pub top: f64,
    pub bottom: f64,
    pub people: &'a [Shown],
    pub segs: &'a [Seg],
    pub late_segs: &'a [Seg],
    pub entered: &'a [u32],
    /// m per art pixel
    pub cell: f64,
    pub p: &'a P,
}

pub struct Game {
    pub fx: Fx,
    pub fruits: Vec<Fruit>,
    pub halves: Vec<Half>,
    pub drops: Vec<Drop>,
    pub splats: Vec<Splat>,
    pub slashes: Vec<Slash>,
    pub rings: Vec<Ring>,
    pub pops: Vec<Pop>,
    queue: Vec<Queued>,
    combos: Vec<Combo>,
    pub scores: Vec<Score>,
    /// slot -> real time of a bomb hit
    pub hurt: Vec<(u8, f64)>,
    /// id of the best of the last round
    pub crown: Option<u32>,
    /// game time (slows down in slow motion and frost)
    pub time: f64,
    pub real: f64,
    pub phase: Phase,
    pub phase_t: f64,
    pub round_left: f64,
    pub round_time: f64,
    round_age: f64,
    empty_for: f64,
    next_volley: f64,
    next_demo: f64,
    frenzy: f64,
    frenzy_next: f64,
    /// round robin over the people
    rr: usize,
    next_id: u32,
    pub stats: Stats,
    rng: Rng,
    /// fruit ids to go through (cuts change the list)
    ids: Vec<u32>,
    ids2: Vec<u32>,
    /// the blocks of splashes that are gone (reused)
    spare: Vec<Vec<SplatBlock>>,
    /// the ghost blade the attract mode asked for (People::script)
    pub script: Option<[[f64; 2]; 5]>,
}

impl Game {
    pub fn new() -> Self {
        Self {
            fx: Fx::new(),
            fruits: Vec::with_capacity(64),
            halves: Vec::with_capacity(64),
            drops: Vec::with_capacity(1024),
            splats: Vec::with_capacity(48),
            slashes: Vec::with_capacity(32),
            rings: Vec::with_capacity(32),
            pops: Vec::with_capacity(16),
            queue: Vec::with_capacity(32),
            combos: Vec::with_capacity(16),
            scores: Vec::with_capacity(16),
            hurt: Vec::with_capacity(8),
            crown: None,
            time: 0.0,
            real: 0.0,
            phase: Phase::Idle,
            phase_t: 0.0,
            round_left: 0.0,
            round_time: 60.0,
            round_age: 0.0,
            empty_for: 0.0,
            next_volley: 1.0,
            next_demo: 4.0,
            frenzy: 0.0,
            frenzy_next: 0.0,
            rr: 0,
            next_id: 1,
            stats: Stats::default(),
            rng: Rng::from_time(),
            ids: Vec::with_capacity(64),
            ids2: Vec::with_capacity(64),
            spare: Vec::new(),
            script: None,
        }
    }

    fn rand(&mut self, a: f64, b: f64) -> f64 {
        a + self.rng.f64() * (b - a)
    }

    fn random(&mut self) -> f64 {
        self.rng.f64()
    }

    fn pick_normal(&mut self) -> Kind {
        NORMAL[self.rng.int(NORMAL.len())]
    }

    pub fn score_of(&self, id: u32) -> f64 {
        self.scores.iter().find(|s| s.id == id).map_or(0.0, |s| s.pts)
    }

    fn award(&mut self, id: Option<u32>, pts: f64) {
        let Some(id) = id else { return };
        let i = match self.scores.iter().position(|s| s.id == id) {
            Some(i) => i,
            None => {
                self.scores.push(Score { id, pts: 0.0 });
                self.scores.len() - 1
            }
        };
        let s = &mut self.scores[i];
        s.pts = (s.pts + pts).max(0.0);
    }

    /// throws a fruit; target: the person it is for (x, head height)
    fn launch(&mut self, w: &World, kind: Option<Kind>, target: Option<(f64, f64)>, from: From) {
        let p = w.p;
        let ww = w.wall_w;
        let kind = kind.unwrap_or_else(|| self.pick_normal());
        let r = info(kind).r * p.size;
        let g = p.gravity * p.tempo * p.tempo;
        let (x, y, vx, vy);
        if from == From::Left || from == From::Right {
            // frenzy: in from the side, across the wall
            let s = if from == From::Left { 1.0 } else { -1.0 };
            x = if s > 0.0 { -r } else { ww + r };
            y = self.rand(w.bottom + 0.35, w.bottom + 1.1);
            vx = s * self.rand(1.5, 2.6) * p.tempo;
            vy = self.rand(1.2, 2.3) * p.tempo;
        } else {
            // from below the wall, the top of the arc where the target can reach it
            let top = w.top - r - 0.04;
            let hi = target.map_or(top - 0.1, |t| top.min(t.1 + 0.3));
            let lo = (w.bottom + 0.6).max(target.map_or(w.bottom + 0.8, |t| t.1 - 0.95));
            let apex_y = self.rand(lo.min(hi - 0.05), hi);
            let ax = match target {
                Some(t) => t.0 + self.rand(-0.75, 0.75),
                None => self.rand(0.5, ww - 0.5),
            };
            let apex_x = clamp(ax, r + 0.1, ww - r - 0.1);
            y = w.bottom - r - 0.02;
            let t_up = (2.0 * (apex_y - y).max(0.2) / g).sqrt();
            let mut v = self.rand(-0.35, 0.35) * p.tempo;
            // towards the middle near the edges, so it stays on the wall
            if apex_x < 1.0 {
                v = v.abs();
            }
            if apex_x > ww - 1.0 {
                v = -v.abs();
            }
            vx = v;
            x = apex_x - vx * t_up;
            vy = g * t_up;
        }
        let rot = self.rand(0.0, PI * 2.0);
        let vr = self.rand(-2.6, 2.6) * if kind == Kind::Melon { 0.6 } else { 1.0 };
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        self.fruits.push(Fruit { id, kind, x, y, vx, vy, r, g, rot, vr, born: self.time, way: VecDeque::with_capacity(72) });
        self.stats.thrown += 1;
    }

    /// what to throw next
    fn kind_for(&mut self, w: &World, allow_special: bool) -> Kind {
        let p = w.p;
        if self.phase == Phase::Play && self.round_age > p.bomb_after && self.random() < p.bombs {
            return Kind::Bomb;
        }
        if allow_special && self.phase == Phase::Play && self.frenzy <= 0.0 && self.fx.time_scale() >= 1.0 && self.random() < p.specials {
            return if self.random() < 0.55 { Kind::Star } else { Kind::Frost };
        }
        self.pick_normal()
    }

    fn volley(&mut self, w: &World) {
        let p = w.p;
        let people = w.people;
        let n = people.len();
        let nf = n as f64;
        let mut count = {
            let v = self.rand(1.0, 1.0 + p.amount * nf.powf(0.85));
            (v + 0.5).floor()
        };
        if self.phase == Phase::Play && self.round_left < p.finale {
            count += 1.0 + (nf / 2.0).floor();
        }
        let count = clamp(count, 1.0, 9.0) as u32;
        let mut bombs = 0.0;
        let mut special = false;
        for k in 0..count {
            let target = if n > 0 {
                let t = people.get(self.rr % n).map(|q| q.id);
                self.rr = self.rr.wrapping_add(1);
                t
            } else {
                None
            };
            let mut kind = self.kind_for(w, !special);
            // never only bombs, and at most one per two people in a volley
            if kind == Kind::Bomb && (bombs >= (nf / 2.0).floor().max(1.0) || (count == 1 && self.random() < 0.5)) {
                kind = self.pick_normal();
            }
            if kind == Kind::Bomb {
                bombs += 1.0;
            }
            if info(kind).special {
                special = true;
            }
            let at = self.time + f64::from(k) * self.rand(0.07, 0.17);
            self.queue.push(Queued { at, kind, target });
        }
    }

    /// a fruit is cut by segment s (or burst: s = None, no points)
    fn cut(&mut self, id: u32, s: Option<&Seg>, w: &World, scored: bool) {
        let Some(i) = self.fruits.iter().position(|f| f.id == id) else { return };
        let f = self.fruits.remove(i);
        self.cut_fruit(f, s, w, scored);
    }

    fn cut_fruit(&mut self, f: Fruit, s: Option<&Seg>, w: &World, scored: bool) {
        let p = w.p;
        let k = info(f.kind);
        let (ux, uy) = match s {
            Some(s) => {
                let l = (s.x1 - s.x0).hypot(s.y1 - s.y0);
                let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
                ((s.x1 - s.x0) / l, (s.y1 - s.y0) / l)
            }
            None => {
                let a = self.rand(0.0, PI * 2.0);
                (a.cos(), a.sin())
            }
        };
        if f.kind == Kind::Bomb {
            self.boom(&f, s, w, scored);
            return;
        }
        let nx = -uy;
        let ny = ux;
        let speed = s.map_or(2.0, |s| s.v.min(5.0));
        let sep = 0.45 + speed * 0.08;
        let na = ny.atan2(nx) - f.rot; // the cut's normal in the fruit's frame
        for side in [1.0, -1.0] {
            let vr = f.vr * 0.5 + side * self.rand(1.5, 3.5);
            self.halves.push(Half {
                kind: f.kind,
                x: f.x,
                y: f.y,
                vx: f.vx * 0.6 + nx * side * sep + ux * speed * 0.12,
                vy: f.vy * 0.4 + ny * side * sep + uy * speed * 0.12 + 0.3,
                r: f.r,
                g: f.g,
                rot: f.rot,
                vr,
                na,
                side,
                born: self.time,
            });
        }
        // juice: along the cut and out of both sides
        let n = (14.0 + f.r * 70.0 + 0.5).floor() as u32;
        for _ in 0..n {
            let along = self.rand(-1.0, 1.0);
            let side = if self.random() < 0.5 { 1.0 } else { -1.0 };
            let sp = self.rand(0.6, 2.4);
            let vx = ux * sp * self.rand(0.3, 1.1) + nx * side * sp * self.rand(0.2, 0.8) + f.vx * 0.3;
            let vy = uy * sp * self.rand(0.3, 1.1) + ny * side * sp * self.rand(0.2, 0.8) + f.vy * 0.2 + 0.4;
            let size = if self.random() < 0.3 { 1.0 } else { 0.5 };
            let life = self.rand(0.4, 0.9);
            self.drops.push(Drop { x: f.x + ux * along * f.r, y: f.y + uy * along * f.r, vx, vy, col: k.juice, ember: false, size, t0: self.time, life });
        }
        self.splat(f.x, f.y, f.r, k.juice, w.cell);
        self.slashes.push(Slash { x0: f.x - ux * f.r * 2.0, y0: f.y - uy * f.r * 2.0, x1: f.x + ux * f.r * 2.0, y1: f.y + uy * f.r * 2.0, t0: self.real, life: 0.22 });
        self.fx.light(f.x, f.y, 0.7, 1.1, k.juice, 0.35);
        self.fx.ripple(f.x, f.y, 2.5, 2.5, 0.35);
        // a short hit stop: the halves hang for a moment before they fly (the blades go on in real time)
        if scored && p.hit_stop > 0.0 {
            self.fx.slow(p.hit_stop, 0.12);
        }
        if !scored {
            return;
        }
        self.stats.cut += 1;
        if let Some(s) = s {
            self.award(s.id, 1.0);
            let real = self.real;
            match self.combos.iter_mut().find(|c| c.key == s.key) {
                Some(c) if real - c.last < p.combo_gap => {
                    c.n += 1;
                    c.last = real;
                    c.x = f.x;
                    c.y = f.y;
                }
                Some(c) => *c = Combo { key: s.key, n: 1, last: real, x: f.x, y: f.y, id: s.id, slot: s.slot },
                None => self.combos.push(Combo { key: s.key, n: 1, last: real, x: f.x, y: f.y, id: s.id, slot: s.slot }),
            }
        }
        if f.kind == Kind::Star {
            self.frenzy = p.frenzy_time;
            self.frenzy_next = 0.0;
            self.fx.flash([1.0, 0.75, 0.2], 0.35);
            self.fx.kick(0.4, 0.6);
            self.rings.push(Ring { x: f.x, y: f.y, r0: f.r, r1: 1.6, col: k.aura.unwrap_or(k.juice), t0: self.real, life: 0.6, w: 0.05 });
        } else if f.kind == Kind::Frost {
            if p.slowmo {
                self.fx.slow(p.freeze_time, 0.4);
            }
            self.fx.flash([0.5, 0.85, 1.0], 0.4);
            self.rings.push(Ring { x: f.x, y: f.y, r0: f.r, r1: 2.4, col: k.aura.unwrap_or(k.juice), t0: self.real, life: 0.8, w: 0.05 });
        }
    }

    /// Juice on the wall: a solid blob with a frayed edge, droplets around and a few runs downwards.
    /// Every block dies on its own (the edge first), so the splash breaks up instead of getting dim
    /// (dim yellow would look olive). cell: m per art pixel.
    fn splat(&mut self, x: f64, y: f64, r: f64, col: Rgb, cell: f64) {
        let mut blocks = self.spare.pop().unwrap_or_default();
        blocks.clear();
        let rr = r * 1.05;
        let lobes = [self.rand(0.0, TURN), self.rand(0.0, TURN), self.rand(0.0, TURN)];
        let n = ((rr * 1.3) / cell).ceil();
        if n.is_finite() && n >= 0.0 {
            let n = n.min(400.0) as i64;
            for j in -n..=n {
                for i in -n..=n {
                    let xx = i as f64 * cell;
                    let yy = j as f64 * cell;
                    let a = yy.atan2(xx);
                    let edge = rr * (0.7 + 0.16 * (a * 3.0 + lobes[0]).sin() + 0.1 * (a * 5.0 + lobes[1]).sin() + 0.06 * (a * 8.0 + lobes[2]).sin());
                    let d = xx.hypot(yy);
                    if d > edge {
                        continue;
                    }
                    let death = (0.45 + 0.55 * self.random()) * (1.0 - 0.6 * (d / edge).powi(2));
                    blocks.push(SplatBlock { x: xx, y: yy, unit: 1.0, death, run: None });
                }
            }
        }
        for _ in 0..12 {
            let a = self.rand(0.0, TURN);
            let d = rr * self.rand(1.05, 2.0);
            let unit = if self.random() < 0.5 { 1.0 } else { 0.5 };
            let death = self.rand(0.2, 0.6);
            blocks.push(SplatBlock { x: a.cos() * d, y: a.sin() * d, unit, death, run: None });
        }
        // runs: columns of blocks below the blob that grow down over the first part of its life
        for _ in 0..3 {
            let xx = self.rand(-0.6, 0.6) * rr;
            let len = self.rand(0.4, 1.1) * rr;
            let mut yy = -rr * 0.5;
            while yy > -rr * 0.5 - len && blocks.len() < 100_000 {
                let death = self.rand(0.35, 0.75);
                blocks.push(SplatBlock { x: xx, y: yy, unit: 1.0, death, run: Some((-rr * 0.5 - yy) / len) });
                yy -= cell;
            }
        }
        if self.splats.len() > 40 {
            let old = self.splats.remove(0);
            self.spare.push(old.blocks);
        }
        self.splats.push(Splat { x, y, col, blocks, t0: self.real, life: 2.0 });
    }

    fn boom(&mut self, f: &Fruit, s: Option<&Seg>, w: &World, scored: bool) {
        let p = w.p;
        self.stats.bombs += 1;
        self.fx.flash([1.0, 1.0, 1.0], if scored { 0.9 } else { 0.4 });
        self.fx.kick(if scored { 1.3 } else { 0.5 }, if scored { 1.2 } else { 0.4 });
        self.fx.ripple(f.x, f.y, 9.0, 3.5, 0.9);
        self.fx.light(f.x, f.y, 2.2, 2.0, [1.0, 0.5, 0.15], 0.8);
        self.rings.push(Ring { x: f.x, y: f.y, r0: f.r, r1: 1.4, col: [1.0, 0.75, 0.4], t0: self.real, life: 0.5, w: 0.08 });
        self.rings.push(Ring { x: f.x, y: f.y, r0: f.r, r1: 0.9, col: [1.0, 0.2, 0.4], t0: self.real, life: 0.7, w: 0.05 });
        for _ in 0..46 {
            let a = self.rand(0.0, PI * 2.0);
            let sp = self.rand(0.8, 4.0);
            let size = if self.random() < 0.35 { 1.0 } else { 0.5 };
            let life = self.rand(0.5, 1.2);
            self.drops.push(Drop { x: f.x, y: f.y, vx: a.cos() * sp, vy: a.sin() * sp + 0.6, col: [1.0; 3], ember: true, size, t0: self.time, life });
        }
        if !scored {
            return;
        }
        // everything close by bursts, no points
        let mut ids = std::mem::take(&mut self.ids2);
        ids.clear();
        ids.extend(self.fruits.iter().map(|o| o.id));
        for &id in &ids {
            let near = self.fruits.iter().find(|o| o.id == id).is_some_and(|o| (o.x - f.x).hypot(o.y - f.y) < 0.9 && o.kind != Kind::Bomb);
            if near {
                self.cut(id, None, w, false);
            }
        }
        self.ids2 = ids;
        if let Some(s) = s {
            self.award(s.id, -p.bomb_penalty);
            if s.slot != 0 {
                match self.hurt.iter_mut().find(|h| h.0 == s.slot) {
                    Some(h) => h.1 = self.real,
                    None => self.hurt.push((s.slot, self.real)),
                }
            }
            self.combos.retain(|c| c.key != s.key);
            if s.id.is_some() {
                let mut text = Label::new();
                let _ = write!(text, "-{}", p.bomb_penalty + 0.0);
                self.pops.push(Pop { text, x: f.x, y: f.y + 0.15, h: 9.0, col: [1.0, 0.25, 0.35], t0: self.real, life: 1.2, vy: 0.25 });
            }
        }
    }

    /// the end of a round: everything bursts, the best gets the crown
    fn end_round(&mut self, w: &World) {
        self.phase = Phase::End;
        self.phase_t = 0.0;
        self.stats.rounds += 1;
        let mut best: Option<(u32, f64)> = None;
        for s in &self.scores {
            if s.pts > 0.0 && best.is_none_or(|b| s.pts > b.1) {
                best = Some((s.id, s.pts));
            }
        }
        self.crown = best.map(|b| b.0);
        let mut fruits = std::mem::take(&mut self.fruits);
        for f in fruits.drain(..) {
            if f.kind == Kind::Bomb {
                self.boom(&f, None, w, false);
            } else {
                self.cut_fruit(f, None, w, false);
            }
        }
        self.fruits = fruits;
        self.fruits.clear();
        self.queue.clear();
        self.frenzy = 0.0;
        self.fx.flash([1.0, 0.85, 0.6], 0.3);
    }

    fn start_round(&mut self, w: &World) {
        let p = w.p;
        self.phase = if p.round_time > 0.0 { Phase::Ready } else { Phase::Play };
        self.phase_t = 0.0;
        self.round_time = p.round_time;
        self.round_left = p.round_time;
        self.round_age = 0.0;
        self.scores.clear();
        self.combos.clear();
        self.next_volley = 0.6;
    }

    /// One frame. dt: real seconds.
    pub fn step(&mut self, dt: f64, w: &World) {
        let p = w.p;
        let gdt = dt * self.fx.time_scale();
        self.time += gdt;
        self.real += dt;
        let t = self.time;
        let people = w.people;
        let n = people.len();
        if n > 0 {
            self.empty_for = 0.0;
        } else {
            self.empty_for += dt;
        }

        // ---- rounds
        self.phase_t += dt;
        match self.phase {
            Phase::Idle => {
                if n > 0 {
                    self.start_round(w);
                }
            }
            Phase::Ready => {
                if self.phase_t >= 1.8 {
                    self.phase = Phase::Play;
                    self.phase_t = 0.0;
                }
                if self.empty_for > 2.0 {
                    self.phase = Phase::Idle;
                }
            }
            Phase::Play => {
                self.round_age += dt;
                if p.round_time > 0.0 {
                    self.round_left -= dt;
                    if self.round_left <= 0.0 {
                        self.end_round(w);
                    }
                }
                if self.empty_for > p.reset_after {
                    self.phase = Phase::Idle;
                    self.scores.clear();
                }
            }
            Phase::End => {
                if self.phase_t >= p.end_time {
                    if n > 0 {
                        self.start_round(w);
                    } else {
                        self.phase = Phase::Idle;
                    }
                }
            }
        }

        // ---- throwing
        if self.phase == Phase::Play {
            if self.frenzy > 0.0 {
                self.frenzy -= dt;
                self.frenzy_next -= gdt;
                if self.frenzy_next <= 0.0 {
                    self.frenzy_next = self.rand(0.12, 0.22);
                    let kind = self.pick_normal();
                    let from = if self.random() < 0.5 { From::Left } else { From::Right };
                    self.launch(w, Some(kind), None, from);
                }
            }
            self.next_volley -= gdt;
            if self.next_volley <= 0.0 {
                self.volley(w);
                let crowd = clamp((n as f64 - 1.0) / 5.0, 0.0, 1.0);
                let mut every = p.every * (1.0 - 0.35 * crowd) * self.rand(0.8, 1.2);
                if p.round_time > 0.0 && self.round_left < p.finale {
                    every *= 0.6;
                }
                if self.frenzy > 0.0 {
                    every *= 1.6;
                }
                self.next_volley = every / p.tempo;
            }
            // newcomers get two fruits right in front of them
            for &id in w.entered {
                if people.iter().any(|q| q.id == id) {
                    for k in 0..2 {
                        let kind = self.pick_normal();
                        self.queue.push(Queued { at: t + 0.3 + f64::from(k) * 0.25, kind, target: Some(id) });
                    }
                }
            }
        } else if self.phase == Phase::Idle {
            // attract: a fruit now and then, and a ghost blade cuts one at the top of its arc
            self.next_volley -= gdt;
            if self.next_volley <= 0.0 {
                self.next_volley = self.rand(1.6, 3.0);
                let k = if self.random() < 0.3 { 2 } else { 1 };
                for i in 0..k {
                    let kind = if self.random() < 0.06 { Kind::Bomb } else { self.pick_normal() };
                    self.queue.push(Queued { at: t + f64::from(i) * 0.2, kind, target: None });
                }
            }
            self.next_demo -= dt;
            if self.next_demo <= 0.0
                && let Some((fx, fy)) = self.fruits.iter().find(|o| o.kind != Kind::Bomb && o.vy.abs() < 0.5 && o.y > w.bottom + 0.6).map(|o| (o.x, o.y))
            {
                self.next_demo = self.rand(3.5, 6.0);
                let a = self.rand(-0.6, 0.6) + if self.random() < 0.5 { 0.0 } else { PI };
                let (dx, dy) = (a.cos(), a.sin());
                let l = 0.8;
                let sag = 0.12;
                let mut pts = [[0.0; 2]; 5];
                for (i, q) in pts.iter_mut().enumerate() {
                    let u = i as f64 * 0.25;
                    let ww = (u - 0.5) * 2.0 * l;
                    let bend = (1.0 - (u - 0.5).powi(2) * 4.0) * sag;
                    *q = [fx + dx * ww - dy * bend, fy + dy * ww + dx * bend];
                }
                self.script = Some(pts);
            }
        }
        let mut i = self.queue.len();
        while i > 0 {
            i -= 1;
            let Some(q) = self.queue.get(i) else { continue };
            if t < q.at {
                continue;
            }
            let q = self.queue.remove(i);
            // a target that left is replaced by anybody (or nobody)
            let target = match q.target {
                Some(id) => match people.iter().find(|p| p.id == id) {
                    Some(me) => Some(me),
                    None if n > 0 => people.get(self.rng.int(n)),
                    None => None,
                },
                None => None,
            };
            self.launch(w, Some(q.kind), target.map(|q| (q.x, q.head_y)), From::Below);
        }

        // ---- motion
        let real = self.real;
        for f in &mut self.fruits {
            f.vy -= f.g * gdt;
            f.x += f.vx * gdt;
            f.y += f.vy * gdt;
            f.rot += f.vr * gdt;
            // its way (real time, as the blades): where it was when a late exact frame was live
            f.way.push_back([real, f.x, f.y]);
            if f.way.len() > 1 && f.way.front().is_some_and(|w| real - w[0] > 1.0) {
                f.way.pop_front();
            }
        }
        for h in &mut self.halves {
            h.vy -= h.g * 1.25 * gdt;
            h.x += h.vx * gdt;
            h.y += h.vy * gdt;
            h.rot += h.vr * gdt;
        }
        for d in &mut self.drops {
            d.vy -= 5.5 * gdt;
            d.vx *= 1.0 - gdt * 1.2;
            d.x += d.vx * gdt;
            d.y += d.vy * gdt;
        }

        // ---- cuts
        let mut ids = std::mem::take(&mut self.ids);
        self.stats.segs += w.segs.len() as u64;
        for s in w.segs {
            ids.clear();
            ids.extend(self.fruits.iter().map(|f| f.id));
            for &id in &ids {
                let Some(f) = self.fruits.iter().find(|f| f.id == id) else { continue };
                if t - f.born < 0.05 || f.y + f.r < w.bottom {
                    continue;
                }
                if seg_dist(f.x, f.y, s) <= f.r * p.hit + p.blade_r {
                    let scored = self.phase != Phase::Idle || s.id.is_some();
                    self.cut(id, Some(s), w, scored);
                }
            }
        }
        // late cuts: the exact skeletons of frames that are 150-250 ms old, against where the fruit was then
        self.stats.late_segs += w.late_segs.len() as u64;
        for s in w.late_segs {
            let tm = (s.t0 + s.t1) / 2.0;
            ids.clear();
            ids.extend(self.fruits.iter().map(|f| f.id));
            for &id in &ids {
                let Some(f) = self.fruits.iter().find(|f| f.id == id) else { continue };
                if f.kind == Kind::Bomb {
                    continue;
                }
                let Some(at) = way_at(&f.way, tm) else { continue };
                if at[1] + f.r < w.bottom {
                    continue;
                }
                if seg_dist(at[0], at[1], s) <= f.r * p.hit + p.blade_r {
                    self.stats.late += 1;
                    let scored = self.phase != Phase::Idle;
                    self.cut(id, Some(s), w, scored);
                }
            }
        }
        self.ids = ids;
        // combos end when the swipe pauses
        let mut i = 0;
        while i < self.combos.len() {
            let c = &self.combos[i];
            if self.real - c.last < p.combo_gap {
                i += 1;
                continue;
            }
            let c = self.combos.remove(i);
            if c.n < 3 {
                continue;
            }
            self.stats.combos += 1;
            self.award(c.id, f64::from(c.n));
            let col = color_of(c.slot);
            let mut text = Label::new();
            let _ = write!(text, "{}x", c.n);
            self.pops.push(Pop { text, x: c.x, y: c.y + 0.12, h: 8.0 + f64::from(c.n.min(6)), col, t0: self.real, life: 1.3, vy: 0.3 });
            self.rings.push(Ring { x: c.x, y: c.y, r0: 0.1, r1: 0.5 + 0.08 * f64::from(c.n), col, t0: self.real, life: 0.45, w: 0.04 });
            self.fx.flash(col, 0.25);
            self.fx.kick(0.3, 0.8);
            if p.slowmo && c.n >= 4 {
                self.fx.slow(0.5, 0.35);
            }
        }

        // ---- gone
        let ww = w.wall_w;
        let bottom = w.bottom;
        let mut missed = 0;
        self.fruits.retain(|f| {
            let gone = (f.vy < 0.0 && f.y < bottom - f.r - 0.15) || f.x < -1.0 || f.x > ww + 1.0;
            if gone && f.kind != Kind::Bomb {
                missed += 1;
            }
            !gone
        });
        self.stats.missed += missed;
        self.halves.retain(|h| h.y > bottom - h.r - 0.3 && t - h.born < 4.0);
        self.drops.retain(|d| t - d.t0 < d.life);
        let real = self.real;
        let mut i = 0;
        while i < self.splats.len() {
            if real - self.splats[i].t0 < self.splats[i].life {
                i += 1;
            } else {
                let old = self.splats.remove(i);
                if self.spare.len() < 48 {
                    self.spare.push(old.blocks);
                }
            }
        }
        self.slashes.retain(|s| real - s.t0 < s.life);
        self.rings.retain(|r| real - r.t0 < r.life);
        self.pops.retain(|p| real - p.t0 < p.life);
        self.hurt.retain(|h| real - h.1 <= 0.8);
    }
}
