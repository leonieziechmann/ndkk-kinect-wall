//! What moves (world.js): cherry petals, the blossom crowns, the lanterns, wind gusts, the school's
//! windows and now and then a shooting star. Physics in wall meters (x from the left edge, y above
//! the floor, as ctx.wall and BodyField); drawing in art pixels (pixel art, see render.rs).
//!
//! The people (BodyField, ctx.wall.persons):
//! - moving outlines push the air: petals near a moving arm or a walking body are swept along
//! - petals that fall on someone standing still stay there (head, shoulders, raised arms) and ride
//!   along; moving, shaking or walking fast throws them off again
//! - reaching or jumping into a crown shakes the tree: a burst of petals
//! - a lantern above someone glows brighter and swings when they pass below it
//! - someone arriving sends a gust across the wall; with nobody there gusts and shooting stars
//!   come by themselves

use std::f64::consts::PI;

use super::painting::{Blob, Scenery, Win};
use super::pixel::{Rng32, c::*, rgb};
use super::render::{KIND_ATLAS, KIND_DISC, KIND_GLOW, KIND_PAINT, KIND_RECT, Writer};
use super::sprites::{FLUTTER, Sheet, Spr};
use crate::scenes::common::field::BodyField;
use crate::scenes::common::rand::Rng;

const MAX_PETALS: usize = 1100;
/// BodyField results per second (kicks are "cells moved" per result)
const KICK_HZ: f64 = 30.0;

/// One person on the wall (ctx.wall.persons): what the world needs of it.
#[derive(Clone, Copy, Debug)]
pub struct Pl {
    pub id: u32,
    pub x: f64,
    pub top: f64,
    pub feet: f64,
    pub vx: f64,
    pub dist: f64,
}

/// The params the world reads (main.js p).
#[derive(Clone, Copy, Debug)]
pub struct Knobs {
    pub petals: f64,
    pub wind: f64,
    pub stick: bool,
    pub kick: f64,
    pub shake: f64,
    pub stars: f64,
    pub lanterns: f64,
    pub windows: f64,
    pub windows_bright: f64,
}

/// The wall's size (ctx.wall.setup): m.
#[derive(Clone, Copy, Debug)]
pub struct WallSize {
    pub w: f64,
    pub h: f64,
    pub bottom: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Air,
    On,
    Ground,
}

#[derive(Clone, Debug)]
struct Petal {
    x: f64,
    y: f64,
    vx: f64,
    vy: f64,
    rot: f64,
    spin: f64,
    fp: f64,
    fs: f64,
    size: f64,
    tone: u32,
    fall: f64,
    state: State,
    ground: f64,
    age: f64,
    on: u32,
    ox: f64,
    oy: f64,
}

#[derive(Clone, Copy, Debug)]
struct Gust {
    x0: f64,
    dir: f64,
    str: f64,
    t0: f64,
    speed: f64,
    width: f64,
    life: f64,
}

struct TreeState {
    cx: f64,
    cy: f64,
    rx: f64,
    ry: f64,
    blobs: Vec<Blob>,
    dots: Vec<Blob>,
    shake: f64,
}

struct LanternState {
    x: f64,
    y: f64,
    len: f64,
    phase: f64,
    a: f64,
    av: f64,
    lit: f64,
    kind: usize,
}

struct WinState {
    win: Win,
    lit: f64,
    level: f64,
    cool: bool,
    curtain: i32,
}

#[derive(Clone, Copy, Debug)]
struct Meteor {
    x: f64,
    y: f64,
    dir: f64,
    t0: f64,
    dur: f64,
}

/// How many petals are where.
#[derive(Clone, Copy, Debug, Default)]
pub struct Counts {
    pub air: usize,
    pub on: usize,
    pub ground: usize,
}

const fn col(c: u32) -> [f32; 3] {
    [((c >> 16) & 255) as f32 / 255.0, ((c >> 8) & 255) as f32 / 255.0, (c & 255) as f32 / 255.0]
}

const CROWN: [[f32; 3]; 4] = [col(P3), col(P4), col(P5), col(P7)];
const CROWN_EDGE: [f32; 3] = col(P1);
/// blossom pixels: tone 4, 5, 6
const DOTS: [[f32; 3]; 3] = [col(P6), col(P8), col(P2)];
const STAR: [[f32; 3]; 3] = [col(G5), col(G7), col(W)];
const WIN_LIT: [f32; 3] = col(Y1);
const WIN_COOL: [f32; 3] = col(Y2);
const WIN_SHADE: [f32; 3] = col(O5);
const CURTAIN: [[f32; 3]; 3] = [col(P5), col(C2), col(O5)];
const GLASS: [f32; 3] = col(Y0);
const DOOR: [f32; 3] = col(Y1);
const LANTERN_GLOW: [f32; 3] = col(O4);
const POOL: [f32; 3] = col(O3);
const VEND: [f32; 3] = col(C2);
const RED: [f32; 3] = col(O2);
const EYES: [f32; 3] = col(Y1);
const CORD: [f32; 3] = col(SKY0);
const ANTS: [[f32; 3]; 2] = [col(P5), col(P7)];
const METEOR: [[f32; 3]; 6] = [col(W), col(Y2), col(G7), col(G6), col(G5), col(G4)];

pub struct World {
    r: Rng32,
    /// Math.random() (the cat's blink)
    random: Rng,
    petals: Vec<Petal>,
    spare: Vec<Petal>,
    gusts: Vec<Gust>,
    trees: Vec<TreeState>,
    lanterns: Vec<LanternState>,
    windows: Vec<WinState>,
    scene: Option<Scenery>,
    meteor: Option<Meteor>,
    next_meteor: f64,
    next_gust: f64,
    next_window: f64,
    last_arrival: f64,
    empty: f64,
    acc_tree: Vec<f64>,
    acc_top: f64,
    acc_side: f64,
    field_seq: Option<u64>,
    place: Vec<Pl>,
    blink: f64,
    // coordinates (set every step from the wall setup)
    aw: f64,
    ah: f64,
    wall_w: f64,
    wall_h: f64,
    top: f64,
    bottom: f64,
    kx: f64,
    ky: f64,
}

impl World {
    pub fn new() -> Self {
        Self {
            r: Rng32::new(1996), // the year the partnership with Omiya began
            random: Rng::from_time(),
            petals: Vec::with_capacity(MAX_PETALS + 1),
            spare: Vec::with_capacity(MAX_PETALS + 1),
            gusts: Vec::with_capacity(16),
            trees: Vec::new(),
            lanterns: Vec::new(),
            windows: Vec::new(),
            scene: None,
            meteor: None,
            next_meteor: 12.0,
            next_gust: 6.0,
            next_window: 3.0,
            last_arrival: -10.0,
            empty: 0.0,
            acc_tree: Vec::new(),
            acc_top: 0.0,
            acc_side: 0.0,
            field_seq: None,
            place: Vec::with_capacity(8),
            blink: 4.0,
            aw: 1.0,
            ah: 1.0,
            wall_w: 6.0,
            wall_h: 2.0,
            top: 2.0,
            bottom: 0.0,
            kx: 1.0,
            ky: 1.0,
        }
    }

    /// New painting (layout or LED size changed): take over its trees, lanterns, windows, stars.
    pub fn set_scene(&mut self, sc: Scenery) {
        self.trees = sc.trees.iter().map(|t| TreeState { cx: t.cx, cy: t.cy, rx: t.rx, ry: t.ry, blobs: t.blobs.clone(), dots: t.dots.clone(), shake: 0.0 }).collect();
        self.acc_tree = vec![0.0; self.trees.len()];
        self.lanterns = sc
            .lanterns
            .iter()
            .enumerate()
            .map(|(i, l)| LanternState { x: l.x, y: l.y, len: l.len, phase: l.phase, a: 0.0, av: 0.0, lit: 0.55, kind: usize::from(i % 3 == 1) })
            .collect();
        self.blink = 4.0;
        let r = &mut self.r;
        self.windows = sc
            .windows
            .iter()
            .map(|w| {
                let lit = if w.kind > 0 || r.next() < 0.55 { 1.0 } else { 0.0 };
                let cool = r.next() < 0.3;
                let curtain = if r.next() < 0.3 { (r.next() * 3.0).floor() as i32 } else { -1 };
                WinState { win: w.clone(), lit, level: lit, cool, curtain }
            })
            .collect();
        self.scene = Some(sc);
    }

    fn set_frame(&mut self, aw: f64, ah: f64, s: WallSize) {
        self.aw = aw;
        self.ah = ah;
        self.wall_w = s.w;
        self.wall_h = s.h;
        self.top = s.bottom + s.h;
        self.bottom = s.bottom;
        self.kx = aw / s.w;
        self.ky = ah / s.h;
    }

    fn px_x(&self, x: f64) -> f64 {
        x * self.kx
    }
    fn px_y(&self, y: f64) -> f64 {
        (self.top - y) * self.ky
    }
    fn m_x(&self, px: f64) -> f64 {
        px / self.kx
    }
    fn m_y(&self, py: f64) -> f64 {
        self.top - py / self.ky
    }

    /// The wind at (x, y), m/s.
    fn wind(&self, x: f64, y: f64, t: f64, p: &Knobs) -> [f64; 2] {
        let mut wx = p.wind * (0.16 + 0.1 * (t * 0.21).sin() + 0.05 * (t * 0.53 + x * 0.7).sin());
        let mut wy = p.wind * 0.04 * (t * 0.37 + x * 1.3).sin();
        for g in &self.gusts {
            let age = t - g.t0;
            let front = g.x0 + g.dir * g.speed * age;
            let env = (age * 3.0).min(1.0) * (1.0 - age / g.life).max(0.0);
            let amp = g.str * env * (-((x - front) / g.width).powi(2)).exp();
            wx += g.dir * amp;
            wy += amp * 0.35 * (y * 3.0 + age * 4.0).sin();
        }
        // the air around walking people moves with them
        for pl in &self.place {
            let dx = (x - pl.x).abs();
            if dx > 0.8 || y > pl.top + 0.35 || y < pl.feet - 0.1 {
                continue;
            }
            wx += pl.vx * (1.0 - dx / 0.8) * 0.8 * p.kick;
        }
        [wx, wy]
    }

    fn gust(&mut self, x0: f64, dir: f64, str: f64, t: f64) {
        self.gusts.push(Gust { x0, dir, str, t0: t, speed: 2.4, width: 0.9, life: (self.wall_w + 2.0) / 2.4 });
    }

    fn spawn(&mut self, x: f64, y: f64, vx: f64, vy: f64) {
        if self.petals.len() >= MAX_PETALS {
            // make room: the oldest petal on the ground goes
            let mut oldest: Option<usize> = None;
            for (i, q) in self.petals.iter().enumerate() {
                if q.state == State::Ground && oldest.is_none_or(|o| q.age > self.petals[o].age) {
                    oldest = Some(i);
                }
            }
            let Some(o) = oldest else { return };
            self.petals.remove(o);
        }
        let r = &mut self.r;
        let near = r.next() < 0.18; // a few petals closer to the eye: bigger and brighter
        let rot = r.next() * PI * 2.0;
        let spin = (r.next() - 0.5) * 3.0;
        let fp = r.next() * PI * 2.0;
        let fs = 2.0 + r.next() * 3.0;
        let size = if near { 1.35 } else { 0.85 + r.next() * 0.3 };
        let tone = (r.next() * 4.0).floor() as u32;
        let fall = 0.22 + r.next() * 0.14;
        let ground = self.bottom + 0.03 + r.next().powf(0.8) * 0.52;
        self.petals.push(Petal { x, y, vx, vy, rot, spin, fp, fs, size, tone, fall, state: State::Air, ground, age: 0.0, on: 0, ox: 0.0, oy: 0.0 });
    }

    /// The person whose body is at wall point (x, y): the nearest placement around it.
    fn person_at(&self, x: f64, y: f64) -> Option<Pl> {
        let mut best = None;
        let mut bd = 0.55;
        for pl in &self.place {
            if y > pl.top + 0.25 || y < pl.feet - 0.1 {
                continue;
            }
            let d = (x - pl.x).abs();
            if d < bd {
                bd = d;
                best = Some(*pl);
            }
        }
        best
    }

    fn placed(&self, id: u32) -> Option<Pl> {
        self.place.iter().find(|q| q.id == id).copied()
    }

    /// One step. placements: ctx.wall.persons; entered: the first person seen for the first time
    /// in this update (with its place on the wall, if it has one).
    #[allow(clippy::too_many_arguments)]
    pub fn step(&mut self, t: f64, dt: f64, p: &Knobs, field: &BodyField, placements: &[Pl], entered: Option<Option<Pl>>, aw: f64, ah: f64, wall: WallSize) {
        self.set_frame(aw, ah, wall);
        let dt = dt.min(0.1);
        self.place.clear();
        self.place.extend_from_slice(placements);
        let someone = !placements.is_empty();
        self.empty = if someone { 0.0 } else { self.empty + dt };

        // ---- gusts: arrivals (a group arriving is one gust), and now and then by themselves
        if let Some(pl) = entered
            && t - self.last_arrival >= 2.0
        {
            self.last_arrival = t;
            if let Some(pl) = pl {
                let dir = if pl.vx.abs() > 0.2 { pl.vx.signum() } else if pl.x < self.wall_w / 2.0 { 1.0 } else { -1.0 };
                self.gust(pl.x - dir * 0.5, dir, 1.1 * p.wind + 0.4, t);
            }
        }
        if t > self.next_gust {
            self.next_gust = t + (if someone { 14.0 } else { 9.0 }) * (0.7 + self.r.next() * 0.6);
            let dir = if self.r.next() < 0.75 { 1.0 } else { -1.0 };
            let str = (0.5 + self.r.next() * 0.5) * p.wind;
            self.gust(if dir > 0.0 { -1.0 } else { self.wall_w + 1.0 }, dir, str, t);
        }
        self.gusts.retain(|g| t - g.t0 < g.life);

        // ---- the trees: shaken by moving bodies inside the crown, by gusts
        let fresh = self.field_seq != Some(field.seq);
        if fresh {
            self.field_seq = Some(field.seq);
        }
        for i in 0..self.trees.len() {
            let (cx, cy, rx, ry) = {
                let tr = &mut self.trees[i];
                tr.shake *= (-dt * 2.2).exp();
                (tr.cx, tr.cy, tr.rx, tr.ry)
            };
            if fresh && field.w > 0 {
                // moving outlines in the crown (wall m): arms reaching up, jumping, walking through it
                let cell = f64::from(field.cell);
                let x0 = self.m_x(cx - rx);
                let x1 = self.m_x(cx + rx);
                let y1 = self.m_y(cy - ry);
                let y0 = self.m_y(cy + ry * 0.8);
                let mut sum = 0.0;
                let gx0 = (x0 / cell).floor().max(0.0) as i64;
                let gx1 = ((x1 / cell).floor() as i64).min(field.w as i64 - 1);
                let gy0 = ((self.top - y1) / cell).floor().max(0.0) as i64;
                let gy1 = (((self.top - y0) / cell).floor() as i64).min(field.h as i64 - 1);
                let mut gy = gy0;
                while gy <= gy1 {
                    let mut gx = gx0;
                    while gx <= gx1 {
                        let c = gy as usize * field.w + gx as usize;
                        if let (Some(kx), Some(ky)) = (field.kx.get(c), field.ky.get(c)) {
                            sum += f64::from(kx.abs()) + f64::from(ky.abs());
                        }
                        gx += 2;
                    }
                    gy += 2;
                }
                let tr = &mut self.trees[i];
                tr.shake = (tr.shake + sum * 0.012 * p.shake).min(1.6);
            }
            let w2 = self.wind(self.m_x(cx), self.m_y(cy), t, p);
            let gustiness = (w2[0].abs() - 0.3 * p.wind).max(0.0);
            let shake = {
                let tr = &mut self.trees[i];
                tr.shake = (tr.shake + gustiness * dt * 0.8).min(1.6);
                tr.shake
            };
            // petals from the crown (at most a full set per frame: a param far out of its range
            // must not stall the frame)
            self.acc_tree[i] = (self.acc_tree[i] + dt * p.petals * (0.8 + gustiness * 6.0 + shake * 45.0)).min(MAX_PETALS as f64);
            while self.acc_tree[i] >= 1.0 {
                self.acc_tree[i] -= 1.0;
                let n = self.trees[i].blobs.len();
                let k = (self.r.next() * n as f64).floor() as usize;
                if let Some(b) = self.trees[i].blobs.get(k) {
                    let (bx, by) = (b.x, b.y);
                    let vx = (self.r.next() - 0.5) * 0.3 + shake * (self.r.next() - 0.5) * 1.2;
                    let vy = -0.05 - self.r.next() * 0.2;
                    self.spawn(self.m_x(bx), self.m_y(by), vx, vy);
                }
            }
        }
        // petals from cherry trees beyond the wall: from above, and from the side the wind comes from
        self.acc_top = (self.acc_top + dt * p.petals * 5.0).min(MAX_PETALS as f64);
        while self.acc_top >= 1.0 {
            self.acc_top -= 1.0;
            let x = -0.3 + self.r.next() * (self.wall_w + 0.3);
            self.spawn(x, self.top + 0.05, 0.0, -0.2);
        }
        self.acc_side = (self.acc_side + dt * p.petals * 2.5 * p.wind.min(2.0)).min(MAX_PETALS as f64);
        while self.acc_side >= 1.0 {
            self.acc_side -= 1.0;
            let y = self.bottom + 0.7 + self.r.next() * (self.wall_h - 0.8);
            self.spawn(-0.08, y, 0.3, 0.0);
        }

        // ---- petals
        let has_field = field.w > 0;
        let kick_gain = f64::from(field.cell) * KICK_HZ * 1.3 * p.kick;
        let kick_at = |c: Option<usize>| match c {
            Some(c) => (f64::from(field.kx.get(c).copied().unwrap_or(0.0)), f64::from(field.ky.get(c).copied().unwrap_or(0.0))),
            None => (0.0, 0.0),
        };
        let top = self.top;
        let sample = |x: f64, y: f64| {
            let s = field.sample(x as f32, y as f32, top as f32);
            [f64::from(s[0]), f64::from(s[1]), f64::from(s[2])]
        };
        let cell_at = |x: f64, y: f64| field.cell_at(x as f32, y as f32, top as f32);
        let mut list = std::mem::take(&mut self.petals);
        let mut out = std::mem::take(&mut self.spare);
        out.clear();
        for mut q in list.drain(..) {
            q.age += dt;
            q.fp += q.fs * dt;
            if q.state == State::On {
                match self.placed(q.on) {
                    None => {
                        q.state = State::Air;
                        q.vy = 0.1;
                    }
                    Some(pl) => {
                        q.x = pl.x + q.ox;
                        q.y = pl.top + q.oy;
                        let mut release = pl.vx.abs() > 1.1 && self.r.next() < dt * 3.0;
                        if has_field {
                            let smp = sample(q.x, q.y);
                            let (kx, ky) = kick_at(cell_at(q.x, q.y));
                            if kx.hypot(ky) > 0.3 {
                                release = true;
                                q.vx = kx * kick_gain * 1.4 + (self.r.next() - 0.5) * 0.4;
                                q.vy = ky * kick_gain * 1.4 + 0.3 + self.r.next() * 0.3;
                            } else if smp[0] > 0.06 {
                                release = true; // the body moved away under it
                            } else if smp[0] < -0.025 {
                                // sank in (the outline changed): ride up to the surface
                                let gl = nonzero(smp[1].hypot(smp[2]));
                                q.ox += (smp[1] / gl) * (-0.012 - smp[0]) * 0.5;
                                q.oy += (smp[2] / gl) * (-0.012 - smp[0]) * 0.5;
                            }
                        }
                        if release || !p.stick {
                            q.state = State::Air;
                            q.vx += pl.vx;
                            q.spin = (self.r.next() - 0.5) * 8.0;
                        }
                        if q.state == State::On {
                            out.push(q);
                            continue;
                        }
                    }
                }
            }
            if q.state == State::Ground {
                // on the ground: lie, fade, get swept up by feet or a strong gust
                let mut lift = false;
                if has_field && q.age > 0.3 {
                    let c = cell_at(q.x, q.y + 0.04);
                    let (kx, ky) = kick_at(c);
                    if c.is_some() && kx.hypot(ky) > 0.2 {
                        lift = true;
                        q.vx = kx * kick_gain * 1.2;
                        q.vy = 0.5 + self.r.next() * 0.6;
                    }
                }
                if !lift && self.r.next() < dt * 0.6 {
                    let w2 = self.wind(q.x, q.y, t, p);
                    if w2[0].abs() > 0.75 {
                        lift = true;
                        q.vx = w2[0];
                        q.vy = 0.3 + self.r.next() * 0.5;
                    }
                }
                if lift {
                    q.state = State::Air;
                    q.age = 0.0;
                } else {
                    if q.age < 20.0 {
                        out.push(q);
                    }
                    continue;
                }
            }
            // in the air
            let w2 = self.wind(q.x, q.y, t, p);
            let flutter = q.fp.sin() * 0.22;
            let drag = 2.2;
            q.vx += (w2[0] + flutter - q.vx) * (drag * dt).min(1.0);
            q.vy += (w2[1] - q.fall - q.vy) * (drag * 0.8 * dt).min(1.0);
            if has_field {
                let smp = sample(q.x, q.y);
                let (kx, ky) = kick_at(cell_at(q.x, q.y));
                let km = kx.hypot(ky);
                if km > 0.06 {
                    // a moving outline sweeps the petal along
                    let a = (km * 0.8).min(1.0);
                    q.vx += (kx * kick_gain - q.vx) * a;
                    q.vy += (ky * kick_gain + 0.15 - q.vy) * a;
                    q.spin += (self.r.next() - 0.5) * km * 6.0;
                }
                if smp[0] < 0.0 {
                    let gl = nonzero(smp[1].hypot(smp[2]));
                    let nx = smp[1] / gl;
                    let ny = smp[2] / gl;
                    let pl = if p.stick && km < 0.15 && q.vy < 0.05 && ny > 0.2 { self.person_at(q.x, q.y) } else { None };
                    if let Some(pl) = pl
                        && self.r.next() < 0.75
                    {
                        // lands on a person standing still: stays on the surface and rides along
                        q.x += nx * (-0.012 - smp[0]);
                        q.y += ny * (-0.012 - smp[0]);
                        q.state = State::On;
                        q.on = pl.id;
                        q.ox = q.x - pl.x;
                        q.oy = q.y - pl.top;
                        q.vx = 0.0;
                        q.vy = 0.0;
                        q.rot = nx.atan2(ny) + (self.r.next() - 0.5) * 1.2;
                        q.fp = if self.r.next() < 0.5 { 0.0 } else { PI }; // lies flat: front or back
                        out.push(q);
                        continue;
                    }
                    // else: off the body's surface like off a wall
                    q.x += nx * (-smp[0] + 0.004);
                    q.y += ny * (-smp[0] + 0.004);
                    let vn = q.vx * nx + q.vy * ny;
                    if vn < 0.0 {
                        q.vx -= nx * vn * 1.3;
                        q.vy -= ny * vn * 1.3;
                    }
                }
            }
            q.x += q.vx * dt;
            q.y += q.vy * dt;
            q.rot += q.spin * dt;
            q.spin *= (-dt * 0.8).exp();
            if q.y <= q.ground && q.vy <= 0.0 {
                q.y = q.ground;
                q.state = State::Ground;
                q.age = 0.0;
                q.vx = 0.0;
                q.vy = 0.0;
            }
            if q.x < -0.4 || q.x > self.wall_w + 0.4 || q.y > self.top + 0.6 {
                continue;
            }
            out.push(q);
        }
        self.petals = out;
        self.spare = list;

        // ---- lanterns: glow above people, swing when they pass
        for i in 0..self.lanterns.len() {
            let (lx, ly) = (self.m_x(self.lanterns[i].x), self.m_y(self.lanterns[i].y));
            let mut near: f64 = 0.0;
            let mut push = 0.0;
            for pl in placements {
                let n = (1.0 - (pl.x - lx).abs() / 0.9).max(0.0) * if pl.dist < 4.0 { 1.0 } else { 0.5 };
                near = near.max(n);
                push += pl.vx * n;
            }
            let w2 = self.wind(lx, ly, t, p);
            let l = &mut self.lanterns[i];
            let target = 0.5 + 0.5 * near;
            l.lit += (target - l.lit) * (1.0 - (-dt * if target > l.lit { 5.0 } else { 1.5 }).exp());
            let torque = w2[0] * 1.2 + push * 2.5;
            l.av += (-12.0 * l.a.sin() - 1.4 * l.av + torque) * dt;
            l.a += l.av * dt;
            l.a = l.a.clamp(-0.7, 0.7);
        }

        // ---- windows: now and then a light goes on or off
        if t > self.next_window && !self.windows.is_empty() {
            self.next_window = t + 1.5 + self.r.next() * 4.0;
            let k = (self.r.next() * self.windows.len() as f64).floor() as usize;
            if self.windows.get(k).is_some_and(|w| w.win.kind == 0) {
                let lit = if self.r.next() < p.windows { 1.0 } else { 0.0 };
                if let Some(w) = self.windows.get_mut(k) {
                    w.lit = lit;
                }
            }
        }
        for w in &mut self.windows {
            w.level += (w.lit - w.level) * (dt * 6.0).min(1.0);
        }

        // ---- a shooting star now and then (more often with nobody there)
        if self.meteor.is_none() && t > self.next_meteor && p.stars > 0.0 {
            self.next_meteor = t + (if someone { 40.0 } else { 18.0 }) * (0.6 + self.r.next() * 0.8);
            let dir = if self.r.next() < 0.5 { 1.0 } else { -1.0 };
            let x = self.aw * (0.15 + self.r.next() * 0.7);
            let y = self.ah * (0.04 + self.r.next() * 0.16);
            self.meteor = Some(Meteor { x, y, dir, t0: t, dur: 0.8 });
        }
        if self.meteor.is_some_and(|m| t - m.t0 > m.dur) {
            self.meteor = None;
        }
    }

    // ---------------------------------------------------------------- drawing (art pixels)

    /// Everything behind the people. dt: the frame's (unclamped, for the cat's blink).
    pub fn emit_back(&mut self, w: &mut Writer, t: f64, dt: f64, p: &Knobs, sheet: &Sheet) {
        let Some(sc) = self.scene.as_ref() else { return };
        let (aw, ah) = (self.aw, self.ah);
        let dot = |w: &mut Writer, x: f64, y: f64, c: [f32; 3], a: f64| w.push([x.round_js() + 0.5, y.round_js() + 0.5, 0.5, 0.5], KIND_RECT, [0.0, 0.0], c, a, None);
        let rect = |w: &mut Writer, x: f64, y: f64, bw: f64, bh: f64, c: [f32; 3], a: f64| w.push([x + bw / 2.0, y + bh / 2.0, bw / 2.0, bh / 2.0], KIND_RECT, [0.0, 0.0], c, a, None);
        w.push([aw / 2.0, ah / 2.0, aw / 2.0, ah / 2.0], KIND_PAINT, [0.0, 0.0], [1.0; 3], 1.0, None);

        // stars: twinkling in three steps, the big ones as small crosses
        if p.stars > 0.0 {
            for st in &sc.stars {
                let b = st.b * (0.55 + 0.45 * (t * st.speed + st.phase).sin()) * p.stars;
                let lv = if b > 0.78 {
                    2
                } else if b > 0.5 {
                    1
                } else if b > 0.25 {
                    0
                } else {
                    continue;
                };
                dot(w, st.x, st.y, STAR[lv], 1.0);
                if st.big && lv == 2 {
                    for (dx, dy) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)] {
                        dot(w, st.x + dx, st.y + dy, STAR[0], 1.0);
                    }
                }
            }
            if let Some(m) = self.meteor {
                let u = (t - m.t0) / m.dur;
                let hx = m.x + m.dir * u * 90.0 * sc.scale;
                let hy = m.y + u * 30.0 * sc.scale;
                for i in 0..METEOR.len() * 2 {
                    let k = (i / 2).min(METEOR.len() - 1);
                    dot(w, hx - m.dir * i as f64 * 1.5, hy - i as f64 * 0.5, METEOR[k], 1.0);
                }
            }
        }
        // the antenna light: on for half a second every two
        for l in &sc.lights {
            if (t + l.phase) % 2.0 < 0.5 {
                dot(w, l.x, l.y, RED, 1.0);
            }
        }

        // lit windows: warm, a light corner, some with a curtain
        let a = p.windows_bright;
        for ws in &self.windows {
            if ws.level < 0.5 {
                continue;
            }
            let win = &ws.win;
            match win.kind {
                0 => {
                    rect(w, win.x, win.y, win.w, win.h, if ws.cool { WIN_COOL } else { WIN_LIT }, a);
                    rect(w, win.x, win.y + win.h - 1.0, win.w, 1.0, WIN_SHADE, a);
                    if ws.curtain >= 0 {
                        rect(w, win.x, win.y, 1.0, win.h, CURTAIN[(ws.curtain as usize).min(2)], a);
                    } else {
                        dot(w, win.x + win.w - 1.0, win.y, WIN_COOL, a);
                    }
                }
                1 => {
                    rect(w, win.x, win.y, win.w, win.h, GLASS, a);
                    rect(w, win.x, win.y, win.w, 1.0, WIN_LIT, a);
                    rect(w, win.x, win.y + win.h - 2.0, win.w, 2.0, WIN_SHADE, a);
                }
                2 => {
                    rect(w, win.x, win.y, win.w, win.h, rgb(win.color.unwrap_or(W)), a);
                    rect(w, win.x, win.y, 1.0, win.h, WIN_COOL, 0.5 * a);
                }
                _ => rect(w, win.x, win.y, win.w, win.h, DOOR, a),
            }
        }

        // glows: the vending machine, the lanterns' light on the yard
        let v = sc.vend;
        w.push([v.x + v.w / 2.0, v.y + v.h * 0.4, 16.0 * sc.scale, 14.0 * sc.scale], KIND_GLOW, [0.0, 0.0], VEND, 0.45, None);
        let yard = sc.horizon + (ah - sc.horizon) * 0.42;
        for l in &self.lanterns {
            w.push([l.x + l.a.sin() * 4.0, yard, 24.0 * sc.scale, 5.0 * sc.scale], KIND_GLOW, [0.0, 0.0], POOL, 0.32 * l.lit * p.lanterns, None);
        }

        // blossom crowns: whole pixels, swaying a pixel in the wind, trembling when shaken
        for tr in &self.trees {
            let w2 = self.wind(self.m_x(tr.cx), self.m_y(tr.cy), t, p);
            let sway = w2[0] * 2.2 * sc.scale;
            let off = |b: &Blob| {
                let h = b.h.max(0.0);
                [
                    ((sway * (0.6 + 0.4 * (t * 1.3 + b.phase).sin()) + tr.shake * 2.0 * sc.scale * (t * 23.0 + b.phase * 3.0).sin()) * h).round_js(),
                    (tr.shake * 1.2 * sc.scale * (t * 19.0 + b.phase * 2.0).cos() * h).round_js(),
                ]
            };
            for pass in 0..2 {
                for b in &tr.blobs {
                    if pass == 0 && b.tone != 0 {
                        continue;
                    }
                    let [dx, dy] = off(b);
                    let r = if pass == 0 { b.r + 1.0 } else { b.r };
                    let c = if pass == 0 { CROWN_EDGE } else { CROWN[b.tone.min(3)] };
                    w.push([b.x + dx + 0.5, b.y + dy + 0.5, r + 1.0, r + 1.0], KIND_DISC, [r, 0.0], c, 1.0, None);
                }
            }
            for d in &tr.dots {
                let [dx, dy] = off(d);
                dot(w, d.x + dx, d.y + dy, DOTS[d.tone.clamp(4, 6) - 4], 1.0);
            }
        }

        // lanterns: glow, cord, the lantern (dimmer when nobody is near)
        for l in &self.lanterns {
            let lv = l.lit * p.lanterns;
            let flick = 1.0 + 0.04 * (t * 9.0 + l.phase).sin() * (t * 5.3 + l.phase * 2.0).sin();
            let spr = sheet.lantern[l.kind.min(1)];
            let dx = (l.a.sin() * (l.len + 3.0)).round_js();
            let top = l.y + l.len + 1.0;
            let cx = l.x + dx;
            w.push([cx + 0.5, top + spr.h * 0.45, 13.0 * sc.scale, 13.0 * sc.scale], KIND_GLOW, [0.0, 0.0], LANTERN_GLOW, 0.6 * lv * flick, None);
            let mut i = 0.0;
            while i <= l.len {
                dot(w, l.x + (dx * i / (l.len + 1.0).max(1.0)).round_js(), l.y + i, CORD, 1.0);
                i += 1.0;
            }
            let k = ((0.5 + 0.6 * lv) * flick).min(1.0) as f32;
            let x0 = (cx - spr.w / 2.0 + 0.5).round_js();
            w.push([x0 + spr.w / 2.0, top + spr.h / 2.0, spr.w / 2.0, spr.h / 2.0], KIND_ATLAS, [0.0, 0.0], [k; 3], 1.0, Some(spr.uv));
        }

        // the cat blinks now and then
        let eyes = sc.cat.eyes;
        if t > self.blink + 0.18 {
            if f64::from(self.random.f32()) < dt * 0.3 {
                self.blink = t;
            }
            dot(w, eyes[0], eyes[1], EYES, 1.0);
            dot(w, eyes[2], eyes[3], EYES, 1.0);
        }

        // petals on the ground (behind the people standing on it)
        for q in &self.petals {
            if q.state == State::Ground && q.age < 20.0 {
                self.petal(w, q, sheet, if q.age > 17.0 { 0.6 } else { 0.9 });
            }
        }
    }

    /// Everything in front of the people: petals in the air and on them, the QR card's frame.
    pub fn emit_front(&self, w: &mut Writer, t: f64, card: [f64; 4], pulse: f64, sheet: &Sheet) {
        for q in &self.petals {
            if q.state != State::Ground {
                self.petal(w, q, sheet, 1.0);
            }
        }
        if pulse > 0.3 && card[2] > card[0] {
            // marching dashes around the card while someone stands near it
            let [x0, y0, x1, y1] = card;
            let m = 3.0;
            let (lx, ty, rx, by) = (x0 - m, y0 - m, x1 + m - 1.0, y1 + m - 1.0);
            let shift = (t * 14.0).floor() as i64;
            let mut i: i64 = 0;
            let mut ant = |w: &mut Writer, x: f64, y: f64| {
                let ph = (i + shift).rem_euclid(8);
                if ph < 4 {
                    w.push([x + 0.5, y + 0.5, 0.5, 0.5], KIND_RECT, [0.0, 0.0], ANTS[usize::from(ph < 2)], 1.0, None);
                }
                i += 1;
            };
            let mut x = lx;
            while x <= rx {
                ant(w, x, ty);
                x += 1.0;
            }
            let mut y = ty + 1.0;
            while y <= by {
                ant(w, rx, y);
                y += 1.0;
            }
            let mut x = rx - 1.0;
            while x >= lx {
                ant(w, x, by);
                x -= 1.0;
            }
            let mut y = by - 1.0;
            while y > ty {
                ant(w, lx, y);
                y -= 1.0;
            }
        }
    }

    fn petal(&self, w: &mut Writer, q: &Petal, sheet: &Sheet, k: f64) {
        let frames: &[Spr; 6] = if q.size > 1.2 { &sheet.near } else { &sheet.small };
        let f = match q.state {
            State::On => {
                if q.fp < 1.0 {
                    0
                } else {
                    4
                }
            }
            State::Ground => match q.tone % 3 {
                0 => 0,
                1 => 4,
                _ => 5,
            },
            State::Air => {
                let u = q.fp.rem_euclid(PI * 2.0) / (PI * 2.0);
                FLUTTER[((u * FLUTTER.len() as f64).floor() as usize) % FLUTTER.len()]
            }
        };
        let spr = frames[f];
        let x0 = (self.px_x(q.x) - spr.w / 2.0).round_js();
        let y0 = (self.px_y(q.y) - spr.h / 2.0).round_js();
        let k = k as f32;
        w.push([x0 + spr.w / 2.0, y0 + spr.h / 2.0, spr.w / 2.0, spr.h / 2.0], KIND_ATLAS, [0.0, 0.0], [k; 3], 1.0, Some(spr.uv));
    }

    pub fn counts(&self) -> Counts {
        let mut c = Counts::default();
        for q in &self.petals {
            match q.state {
                State::Air => c.air += 1,
                State::On => c.on += 1,
                State::Ground => c.ground += 1,
            }
        }
        c
    }
}

/// `v || 1` of JS for a length
fn nonzero(v: f64) -> f64 {
    if v == 0.0 || v.is_nan() { 1.0 } else { v }
}

/// Math.round on f64
trait RoundJs {
    fn round_js(self) -> f64;
}

impl RoundJs for f64 {
    fn round_js(self) -> f64 {
        (self + 0.5).floor()
    }
}
