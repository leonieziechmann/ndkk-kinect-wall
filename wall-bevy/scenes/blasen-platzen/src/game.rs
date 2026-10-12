//! The game (port of game.js): soap bubbles float up the wall, the people pop them. In wall meters:
//! x from the left edge of the wall, y = height above the floor (up). Numbers are f64 as in JS.
//!
//! A bubble pops when a body moves into it (wall cells newly covered in this frame, see grid.rs):
//! a slap or a swipe pops, a hand held still only pushes it away, so bubbles can rest on a head or
//! slide around a shoulder. Kinds: normal, star (pops everything around it in a chain), giant
//! (splits into four). The score is the group's; everyone also gets their own count above the head.

use std::collections::HashMap;
use std::f64::consts::PI;

use wall::persons::PersonsView;
use wall::common::rand::Rng;

use super::grid::WallGrid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Normal = 0,
    Star = 1,
    Giant = 2,
}

/// The record: the browser keeps it in localStorage, here in the output's store (the same key)
const BEST_KEY: &str = "blasen-platzen:best";

fn load_best() -> u64 {
    wall::store::get(BEST_KEY).and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| v.is_finite() && *v > 0.0).map_or(0, |v| v as u64)
}

fn save_best(v: u64) {
    wall::store::set(BEST_KEY, &v.to_string());
}

/// neon: cyan, blue, violet, magenta, pink and back (no yellow or green, they fade to olive)
pub fn neon(x: f64) -> [f32; 3] {
    let tri = (x.rem_euclid(1.0) * 2.0 - 1.0).abs();
    let h = 0.5 + 0.47 * tri;
    let s = 0.8;
    let mut out = [0.0_f32; 3];
    for (o, off) in out.iter_mut().zip([0.0, 2.0 / 3.0, 1.0 / 3.0]) {
        let k = (((h + off) % 1.0) * 6.0 - 3.0).abs();
        *o = (1.0 - s + s * (k - 1.0_f64).clamp(0.0, 1.0)) as f32;
    }
    out
}

pub struct Bubble {
    pub id: u32,
    pub kind: Kind,
    pub x: f64,
    pub y: f64,
    pub r: f64,
    vx: f64,
    vy: f64,
    rise: f64,
    drift: f64,
    pub hue: f64,
    pub phase: f64,
    pub born: f64,
    /// s to full size
    pub grow: f64,
    grace_until: f64,
    life: f64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FxKind {
    Ring,
    Dot,
    /// "+points"
    Glyph(u32),
}

/// An effect with a life: rings, droplets, flashes, "+1".
pub struct Fx {
    pub kind: FxKind,
    pub x: f64,
    pub y: f64,
    vx: f64,
    vy: f64,
    pub r0: f64,
    pub r1: f64,
    pub w: f64,
    pub size: f64,
    pub h: f64,
    pub col: [f32; 3],
    pub t0: f64,
    pub life: f64,
    pub a: f64,
    gravity: bool,
}

impl Fx {
    fn new(kind: FxKind, x: f64, y: f64, col: [f32; 3], t0: f64, life: f64, a: f64) -> Self {
        Self { kind, x, y, vx: 0.0, vy: 0.0, r0: 0.0, r1: 0.0, w: 0.0, size: 0.0, h: 0.0, col, t0, life, a, gravity: false }
    }
}

/// A scheduled pop of a star's chain.
#[derive(Clone, Copy)]
struct Chain {
    at: f64,
    bubble: u32,
    slot: u8,
}

/// For the sound (the browser also kept the place on the wall, for panning: see sound.rs).
#[derive(Clone, Copy, Debug)]
pub enum Event {
    Pop { r: f64, kind: Kind, quiet: bool },
    Star,
    Wave,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Cause {
    Hit,
    Chain,
    Age,
    Demo,
}

/// The game's params, read once per frame.
#[derive(Clone, Copy, Debug, Default)]
pub struct GameParams {
    pub count: f64,
    pub per_person: f64,
    pub idle_count: f64,
    pub size: f64,
    pub speed: f64,
    pub pop_speed: f64,
    pub push: f64,
    pub star_chance: f64,
    pub giant_chance: f64,
    pub chain_radius: f64,
    pub wave_every: f64,
    pub reset_after: f64,
    pub numbers: bool,
}

/// A person for the game, in wall meters (placed by the wall core).
#[derive(Clone, Copy, Debug)]
pub struct Player {
    pub id: u32,
    pub slot: u8,
    pub x: f64,
    pub head_x: f64,
    pub head_y: f64,
}

/// One frame's world (game.js step(dt, world)).
pub struct World<'a> {
    pub wall_w: f64,
    pub top: f64,
    pub bottom: f64,
    pub grid: &'a WallGrid,
    /// a new grid this frame
    pub fresh: bool,
    /// 1, or less when Kinect frames were skipped since the last grid
    pub frame_rate: f64,
    pub people: &'a [Player],
    /// ctx.persons
    pub persons: &'a PersonsView,
    pub params: &'a GameParams,
}

#[derive(Default)]
struct SpawnOpts {
    kind: Option<Kind>,
    r: Option<f64>,
    x: Option<f64>,
    y: Option<f64>,
    vx: Option<f64>,
    vy: Option<f64>,
    grace: Option<f64>,
}

pub struct Game {
    pub bubbles: Vec<Bubble>,
    /// effects with a life: rings, droplets, flashes, "+1"
    pub fx: Vec<Fx>,
    /// scheduled pops of a star's chain
    chain: Vec<Chain>,
    /// for the sound
    pub events: Vec<Event>,
    pub score: u64,
    pub best: u64,
    best_at_start: u64,
    /// person id -> points
    pub per_person: HashMap<u32, u64>,
    since_wave: u32,
    /// seconds left of a bubble wave
    pub wave: f64,
    empty_for: f64,
    demo_at: f64,
    pub time: f64,
    next_id: u32,
    rng: Rng,
}

impl Default for Game {
    fn default() -> Self {
        let best = load_best();
        Self {
            bubbles: Vec::with_capacity(256),
            fx: Vec::with_capacity(1024),
            chain: Vec::with_capacity(64),
            events: Vec::with_capacity(64),
            score: 0,
            best,
            best_at_start: best,
            per_person: HashMap::new(),
            since_wave: 0,
            wave: 0.0,
            empty_for: 0.0,
            demo_at: 0.0,
            time: 0.0,
            next_id: 1,
            rng: Rng::from_time(),
        }
    }
}

impl Game {
    fn rand(&mut self, a: f64, b: f64) -> f64 {
        a + self.rng.f64() * (b - a)
    }

    /// points for someone (slot 0 = nobody: only the group score)
    fn award(&mut self, points: u64, slot: u8, persons: &PersonsView) {
        self.score += points;
        if self.score > self.best {
            self.best = self.score;
        }
        if slot != 0
            && let Some(p) = persons.by_slot(slot)
        {
            *self.per_person.entry(p.id).or_insert(0) += points;
        }
    }

    fn spawn(&mut self, world: &World, o: SpawnOpts) {
        let p = world.params;
        let people = world.people;
        let w = world.wall_w;
        let mut kind = Kind::Normal;
        if !people.is_empty() && o.kind.is_none() {
            let r = self.rng.f64();
            if r < p.star_chance {
                kind = Kind::Star;
            } else if r < p.star_chance + p.giant_chance {
                kind = Kind::Giant;
            }
        }
        if let Some(k) = o.kind {
            kind = k;
        }
        let r = match o.r {
            Some(r) => r,
            None => {
                (match kind {
                    Kind::Giant => self.rand(0.28, 0.34),
                    Kind::Star => 0.13,
                    Kind::Normal => self.rand(0.08, 0.16),
                }) * p.size
            }
        };
        // near the people more often, so everyone gets some; else anywhere on the wall
        let mut x = self.rand(r, w - r);
        if !people.is_empty() && self.rng.f64() < 0.7 {
            let px = people[self.rng.int(people.len())].x;
            x = (px + self.rand(-1.3, 1.3)).max(r).min(w - r);
        }
        // most rise from below the wall, some appear in the air (not inside a person)
        let mut y = world.bottom - r;
        let mut grow = 0.5;
        if self.rng.f64() < 0.4 {
            for _ in 0..4 {
                let yy = self.rand(world.bottom + 0.5, world.top - 0.3);
                if world.grid.probe(x, yy, r * 1.5, world.top).covered == 0.0 {
                    y = yy;
                    grow = 0.35;
                    break;
                }
                x = self.rand(r, w - r);
            }
        }
        let vx = match o.vx {
            Some(v) => v,
            None => self.rand(-0.05, 0.05),
        };
        let rise = if kind == Kind::Giant { self.rand(0.07, 0.1) } else { self.rand(0.12, 0.26) } * p.speed;
        let drift = self.rand(-0.06, 0.06);
        let hue = self.rng.f64();
        #[allow(clippy::approx_constant)] // the browser's range, not quite TAU
        let phase = self.rand(0.0, 6.28);
        let life = self.rand(22.0, 30.0);
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        self.bubbles.push(Bubble {
            id,
            kind,
            x: o.x.unwrap_or(x),
            y: o.y.unwrap_or(y),
            r,
            vx,
            vy: o.vy.unwrap_or(0.0),
            rise,
            drift,
            hue,
            phase,
            born: self.time,
            grow,
            grace_until: self.time + o.grace.unwrap_or(0.0),
            life,
        });
    }

    fn pop_id(&mut self, id: u32, slot: u8, world: &World, cause: Cause) {
        if let Some(i) = self.bubbles.iter().position(|b| b.id == id) {
            self.pop(i, slot, world, cause);
        }
    }

    fn pop(&mut self, i: usize, slot: u8, world: &World, cause: Cause) {
        if i >= self.bubbles.len() {
            return;
        }
        let b = self.bubbles.remove(i);
        let t = self.time;
        let col = neon(b.hue + 0.3);
        let scored = !matches!(cause, Cause::Age | Cause::Demo);
        let points: u32 = match b.kind {
            Kind::Star => 5,
            Kind::Giant => 3,
            Kind::Normal => 1,
        };
        if scored {
            self.award(u64::from(points), slot, world.persons);
        }

        // the burst: a ring, droplets flying out, a flash
        let mut ring = Fx::new(FxKind::Ring, b.x, b.y, col.map(|c| 0.45 + 0.55 * c), t, 0.3, 1.0);
        (ring.r0, ring.r1, ring.w) = (b.r, b.r * 1.9, 0.06);
        self.fx.push(ring);
        let n = if b.kind == Kind::Giant { 22 } else { (9.0 + b.r * 30.0 + 0.5).floor() as usize };
        for _ in 0..n {
            let ang = self.rand(0.0, PI * 2.0);
            let sp = self.rand(0.6, 2.2) * (0.6 + b.r * 3.0);
            let size = self.rand(0.012, 0.026);
            let col = neon(b.hue + self.rand(-0.25, 0.25));
            let life = self.rand(0.35, 0.75);
            let mut d = Fx::new(FxKind::Dot, b.x + ang.cos() * b.r, b.y + ang.sin() * b.r, col, t, life, 1.0);
            (d.vx, d.vy, d.size, d.gravity) = (ang.cos() * sp + b.vx, ang.sin() * sp + b.vy, size, true);
            self.fx.push(d);
        }
        let mut flash = Fx::new(FxKind::Dot, b.x, b.y, [1.0, 1.0, 1.0], t, 0.12, 0.7);
        flash.size = b.r * 0.9;
        self.fx.push(flash);
        if scored && world.params.numbers {
            let pc = if slot != 0 { world.persons.by_slot(slot).map(|p| p.color) } else { None };
            let mut g = Fx::new(FxKind::Glyph(points), b.x, b.y + b.r * 0.3, pc.unwrap_or(col), t, 0.9, 1.0);
            (g.vy, g.h) = (0.45, 0.09 + f64::from(points) * 0.006);
            self.fx.push(g);
        }
        self.events.push(Event::Pop { r: b.r, kind: b.kind, quiet: !scored });

        if b.kind == Kind::Giant {
            // four children fly out; they cannot be popped for a moment, else the same slap takes them all
            for k in 0..4 {
                let ang = f64::from(k) / 4.0 * PI * 2.0 + self.rand(-0.3, 0.3) + PI / 4.0;
                self.spawn(
                    world,
                    SpawnOpts {
                        kind: Some(Kind::Normal),
                        r: Some(b.r * 0.45),
                        x: Some(b.x + ang.cos() * b.r * 0.5),
                        y: Some(b.y + ang.sin() * b.r * 0.5),
                        vx: Some(ang.cos() * 0.9),
                        vy: Some(ang.sin() * 0.9),
                        grace: Some(0.5),
                    },
                );
            }
        }
        if b.kind == Kind::Star {
            // chain: everything around pops, nearer ones first
            let big = world.params.chain_radius;
            let mut ring = Fx::new(FxKind::Ring, b.x, b.y, [1.0, 0.6, 1.0], t, 0.55, 1.0);
            (ring.r0, ring.r1, ring.w) = (b.r, big, 0.04);
            self.fx.push(ring);
            for o in &self.bubbles {
                let d = (o.x - b.x).hypot(o.y - b.y);
                if d < big + o.r && !self.chain.iter().any(|c| c.bubble == o.id) {
                    self.chain.push(Chain { at: t + 0.05 + (d / big) * 0.45, bubble: o.id, slot });
                }
            }
            self.events.push(Event::Star);
        }
        if scored {
            self.since_wave = self.since_wave.saturating_add(1);
            if f64::from(self.since_wave) >= world.params.wave_every {
                self.since_wave = 0;
                self.wave = 6.0;
                self.events.push(Event::Wave);
            }
        }
    }

    /// One animation frame.
    pub fn step(&mut self, dt: f64, world: &World) {
        self.time += dt;
        let t = self.time;
        let p = world.params;
        let people = world.people;

        // group session: a few seconds after the last person left, the score starts again
        if !people.is_empty() {
            self.empty_for = 0.0;
        } else {
            self.empty_for += dt;
            if self.empty_for > p.reset_after && self.score > 0 {
                if self.best > self.best_at_start {
                    save_best(self.best);
                }
                self.best_at_start = self.best;
                self.score = 0;
                self.since_wave = 0;
                self.per_person.clear();
            }
        }
        for id in &world.persons.left {
            self.per_person.remove(id);
        }
        self.wave = (self.wave - dt).max(0.0);

        // spawning: more people, more bubbles; a wave triples them for a few seconds
        let mut target = if people.is_empty() { p.idle_count } else { p.count + p.per_person * people.len() as f64 };
        if self.wave > 0.0 {
            target *= 2.5;
        }
        let rate = if people.is_empty() {
            0.5
        } else if self.wave > 0.0 {
            8.0
        } else {
            2.5
        };
        if (self.bubbles.len() as f64) < target && self.rng.f64() < rate * dt {
            self.spawn(world, SpawnOpts::default());
        }
        // a welcome: newcomers get a few bubbles right around them
        for id in &world.persons.entered {
            let Some(me) = people.iter().find(|q| q.id == *id) else { continue };
            for _ in 0..3 {
                let x = me.x + self.rand(-0.6, 0.6);
                let y = self.rand(0.9, 1.6);
                self.spawn(world, SpawnOpts { x: Some(x), y: Some(y), grace: Some(0.6), ..Default::default() });
            }
        }

        // motion: rise towards their speed, drift, sway
        let k = 1.0 - (-dt * 0.9).exp();
        for b in &mut self.bubbles {
            let tvx = b.drift + (t * 0.37 + b.phase).sin() * 0.05;
            b.vx += (tvx - b.vx) * k;
            b.vy += (b.rise - b.vy) * k;
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            if b.x < b.r {
                b.x = b.r;
                b.vx = b.vx.abs() * 0.5;
            } else if b.x > world.wall_w - b.r {
                b.x = world.wall_w - b.r;
                b.vx = -b.vx.abs() * 0.5;
            }
        }
        // bubbles do not overlap: push pairs apart
        let n = self.bubbles.len();
        for i in 0..n {
            for j in i + 1..n {
                let (a, b) = (&self.bubbles[i], &self.bubbles[j]);
                let dx = b.x - a.x;
                let dy = b.y - a.y;
                let d = dx.hypot(dy);
                let min = (a.r + b.r) * 0.95;
                if d >= min || d < 1e-6 {
                    continue;
                }
                let push = (min - d) * 0.5;
                let (nx, ny) = (dx / d, dy / d);
                let a = &mut self.bubbles[i];
                a.x -= nx * push;
                a.y -= ny * push;
                let b = &mut self.bubbles[j];
                b.x += nx * push;
                b.y += ny * push;
            }
        }

        // the people: a body moving into a bubble pops it, else it is pushed away from the body.
        // How fast the outline moved in: the newly covered area over the length of the outline in the
        // bubble, per frame (30/s). A still body's outline flickers by single cells: that is slow.
        if world.fresh {
            let min_area = 3.0 * 2.25e-4; // three cells, against single specks
            // the bubbles of the frame's start (children of a popped giant come after them)
            let mut end = self.bubbles.len();
            let mut i = 0;
            while i < end {
                let b = &self.bubbles[i];
                let scale = ((t - b.born) / b.grow).min(1.0);
                let pr = world.grid.probe(b.x, b.y, b.r * scale, world.top);
                if pr.covered == 0.0 {
                    i += 1;
                    continue;
                }
                let speed = pr.fresh / pr.edge.max(0.05) * 30.0 * world.frame_rate;
                let need = p.pop_speed * if b.kind == Kind::Giant { 1.3 } else { 1.0 };
                if pr.fresh >= min_area && speed >= need && t >= b.grace_until {
                    self.pop(i, pr.slot, world, Cause::Hit);
                    end -= 1;
                    continue;
                }
                let b = &mut self.bubbles[i];
                let frac = pr.covered / (PI * b.r * b.r);
                let len = pr.dx.hypot(pr.dy);
                let (nx, ny) = if len > 1e-4 { (pr.dx / len, pr.dy / len) } else { (0.0, 1.0) };
                let len = frac * b.r * 0.35; // out of the body, a part of the overlap per frame
                b.x += nx * len;
                b.y += ny * len;
                b.vx += nx * p.push * frac;
                b.vy += ny * p.push * frac;
                i += 1;
            }
        }
        // (the browser's mouse popping is left out: the LED wall has no pointer)

        // chains of the stars
        let mut i = self.chain.len();
        while i > 0 {
            i -= 1;
            let c = self.chain[i];
            if t < c.at {
                continue;
            }
            self.chain.remove(i);
            self.pop_id(c.bubble, c.slot, world, Cause::Chain);
        }

        // gone: out at the top, too old
        let mut end = self.bubbles.len();
        let mut i = 0;
        while i < end {
            let b = &self.bubbles[i];
            if b.y - b.r > world.top {
                self.bubbles.remove(i);
                end -= 1;
            } else if t - b.born > b.life {
                self.pop(i, 0, world, Cause::Age);
                end -= 1;
            } else {
                i += 1;
            }
        }
        // nobody there: now and then a bubble pops by itself, to show what happens
        if people.is_empty() && t > self.demo_at && !self.bubbles.is_empty() {
            self.demo_at = t + self.rand(4.0, 7.0);
            let i = self.rng.int(self.bubbles.len());
            if self.bubbles[i].y > world.bottom + 0.3 {
                self.pop(i, 0, world, Cause::Demo);
            }
        }

        // effects
        self.fx.retain_mut(|f| {
            if t - f.t0 > f.life {
                return false;
            }
            if f.gravity {
                f.vy -= 3.0 * dt;
                f.vx *= 1.0 - dt * 1.5;
            }
            f.x += f.vx * dt;
            f.y += f.vy * dt;
            true
        });
    }
}
