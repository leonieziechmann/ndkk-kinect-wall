//! The game (game.js): rounds of about 30 s. Obstacles roll in along the ground (jump over them) or
//! fly in at head height (duck under them), coins hang in the air, now and then a star makes you
//! invincible. Everything moves across the wall from one edge to the other and passes every figure
//! on its way, so it works for one person as for ten.
//!
//! A round: the game waits until the tracking runs and somebody stands in the play zone, counts down
//! 3-2-1-GO, then the obstacles come. Everybody has 3 lives; whoever loses the last one becomes a
//! ghost and floats around until the next round. At the end the goal comes through. The round is
//! over when the goal has crossed the wall or everybody is a ghost. Then everybody's points show
//! above their heads, and the best one wears a crown in the next round.
//!
//! Points per round: +1 per obstacle you get past, +1 per coin, a bonus for reaching the goal alive.
//!
//! Positions: x in m from the wall's left edge, y in m above the game's ground line. Collisions are
//! exact on the mosaic: an obstacle's cells against the figure's cells (lifted by its jump).

use std::cmp::Ordering;
use std::f64::consts::{PI, TAU};

use wall::common::rand::Rng;

use super::art::{HIGH, LOW, Rgb, SPRITES, Spr, Sprite, js_round, rainbow};
use super::people::Figure;
use super::{Layout, P, Side};

const COUNT: f64 = 3.0; // s of countdown
pub const GOAL_W: i32 = 2; // cells
const AIR: f64 = 0.9; // s: a jump over an obstacle lasts about this long (spacing of the obstacles)
// the jump assist (carry)
const CLEAR_CELLS: f64 = 1.0; // the feet pass this many cells above an obstacle
const LEG_ROWS: i32 = 7; // the figure's lowest rows: what a ground obstacle can touch
const CARRY_AHEAD: f64 = 0.8; // s: obstacles that come within this time of the jump are carried over
const MERGE_GAP: f64 = 0.2; // s: two obstacles this close after each other: one long jump over both
const PAD: f64 = 0.03; // s before and after

const GOLD: Rgb = [255.0, 210.0, 63.0];
const WHITE: Rgb = [255.0, 255.0, 255.0];
const RED: Rgb = [255.0, 45.0, 85.0];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    Wait,
    Count,
    Run,
    End,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Obstacle,
    Coin,
    Star,
}

/// an obstacle or an item
pub struct Thing {
    pub kind: Kind,
    pub ty: Spr,
    high: bool,
    /// m: left edge, bottom above the ground
    x: f64,
    y: f64,
    base_y: f64,
    /// figure ids: hit by it, got past it, came near it
    hit: Vec<u32>,
    passed: Vec<u32>,
    near: Vec<u32>,
    /// figure id -> first contact (grace), from when it is checked where it is seen (carry)
    contact: Vec<(u32, f64)>,
    visual_from: Vec<(u32, f64)>,
    phase: f64,
    /// the frame drawn, its top left cell (set every step)
    pub frame: Option<usize>,
    pub c0: i32,
    pub r0: i32,
    dead: bool,
}

impl Thing {
    fn new(kind: Kind, ty: Spr, high: bool, x: f64, y: f64, phase: f64) -> Self {
        Self { kind, ty, high, x, y, base_y: y, hit: Vec::new(), passed: Vec::new(), near: Vec::new(), contact: Vec::new(), visual_from: Vec::new(), phase, frame: None, c0: 0, r0: 0, dead: false }
    }

    pub fn sprite(&self) -> Option<&'static Sprite> {
        self.frame.and_then(|i| SPRITES.of(self.ty).get(i))
    }
}

/// a cell that flies and falls
pub struct Particle {
    pub x: f64,
    pub y: f64,
    vx: f64,
    vy: f64,
    g: f64,
    pub col: Rgb,
    pub t0: f64,
    pub life: f64,
}

pub struct Goal {
    /// m, left edge
    pub x: f64,
    finished: Vec<u32>,
}

pub struct Score {
    pub id: u32,
    pub score: f64,
    pub best: bool,
}

/// what happened in a step (sounds)
#[derive(Clone, Copy, Debug)]
pub enum Event {
    Count,
    Go,
    GoalIn,
    Finish,
    End,
    Enter,
    Jump,
    AirJump,
    Clear(i64),
    Coin,
    Star,
    Smash,
    Hit,
    Die,
}

/// The inputs of a step besides the figures: tracking runs, who entered or jumped, the latency.
pub struct Input<'a> {
    pub ready: bool,
    pub entered: &'a [usize],
    pub jumped: &'a [usize],
    /// s the figures lag behind the people (latency compensation)
    pub lag: f64,
}

#[derive(Clone, Copy)]
struct Win {
    th: usize,
    a: f64,
    up: f64,
    b: f64,
    clear: f64,
}

#[derive(Clone, Copy)]
enum Spawn {
    Low,
    Low2,
    High,
    Coins,
    LowCoins,
    HighLow,
    Star,
}

pub struct Game {
    pub time: f64,
    pub phase: Phase,
    pub phase_at: f64,
    pub round: i64,
    /// s since GO
    pub round_t: f64,
    ready_for: f64,
    empty_for: f64,
    pub speed: f64,
    /// m scrolled
    pub dist: f64,
    pub things: Vec<Thing>,
    pub goal: Option<Goal>,
    pub particles: Vec<Particle>,
    pub events: Vec<Event>,
    next_spawn: f64,
    /// 1: from the right to the left, -1: from the left
    pub dir: f64,
    star_done: bool,
    /// ids of the best of the last round
    pub crowns: Vec<u32>,
    /// the last round's points
    pub results: Vec<Score>,
    all_dead_at: f64,
    last_count: i64,
    rng: Rng,
    // scratch
    players: Vec<usize>,
    others: Vec<usize>,
    wins: Vec<Win>,
    carried: Vec<usize>,
}

/// a figure takes part in this round: all lives, no points yet
fn join(f: &mut Figure, p: &P, round: i64) {
    f.round = round;
    f.lives = p.lives;
    f.alive = Some(true);
    f.round_score = 0.0;
    f.safe_until = 0.0;
    f.star_until = 0.0;
    f.streak = 0;
}

/// cells where a thing overlaps a figure (lifted by its jump): count and one of them
fn overlap(r0: i32, fr: &Sprite, f: &Figure, l: &Layout, flip: bool, c0: i32) -> (u32, i32, i32) {
    let (mut n, mut hc, mut hr) = (0, 0, 0);
    for &(sx, sy, _) in &fr.px {
        let c = c0 + if flip { fr.w - 1 - sx } else { sx };
        let r = r0 + sy + f.lift_rows;
        if c < 0 || c >= l.gw || r < 0 || r >= l.gh {
            continue;
        }
        if f.grid.get((r * l.gw + c) as usize).is_some_and(|&v| v != 0) {
            n += 1;
            hc = c;
            hr = r;
        }
    }
    (n, hc, hr)
}

/// sprites face left (coming from the right); from the left they are mirrored
pub fn flip_of(dir: f64, kind: Kind) -> bool {
    dir < 0.0 && kind == Kind::Obstacle
}

impl Game {
    pub fn new() -> Self {
        Self {
            time: 0.0,
            phase: Phase::Wait,
            phase_at: 0.0,
            round: 0,
            round_t: 0.0,
            ready_for: 0.0,
            empty_for: 0.0,
            speed: 1.0,
            dist: 0.0,
            things: Vec::new(),
            goal: None,
            particles: Vec::new(),
            events: Vec::new(),
            next_spawn: 2.0,
            dir: 1.0,
            star_done: false,
            crowns: Vec::new(),
            results: Vec::new(),
            all_dead_at: -1.0,
            last_count: 0,
            rng: Rng::from_time(),
            players: Vec::new(),
            others: Vec::new(),
            wins: Vec::new(),
            carried: Vec::new(),
        }
    }

    fn rand(&mut self, a: f64, b: f64) -> f64 {
        a + self.rng.f64() * (b - a)
    }

    fn pick<T: Copy>(&mut self, list: &[T]) -> Option<T> {
        let i = (self.rng.f64() * list.len() as f64).floor() as usize;
        list.get(i).or(list.first()).copied()
    }

    /// the cell column of the left edge of a thing
    pub fn col(l: &Layout, x: f64) -> i32 {
        ((x * l.px_x - f64::from(l.ox)) / f64::from(l.cell_px)).floor() as i32
    }

    /// the cell row of the bottom of a thing at y m above the ground
    fn row(l: &Layout, y: f64) -> i32 {
        l.ground_row - 1 - (y / l.cell_my + 1e-6).floor() as i32
    }

    fn set_phase(&mut self, phase: Phase) {
        self.phase = phase;
        self.phase_at = self.time;
    }

    fn spawn(&mut self, l: &Layout, p: &P) {
        let tt = self.round_t;
        let wall_w = l.wall_w;
        let cell = l.cell_mx;
        let w = |n: f64| n * cell;
        // where things start: out of sight beyond the edge, so the warning shows a moment before
        let lead = self.speed * p.warn;
        let dir = self.dir;
        let enter = |width: f64| if dir > 0.0 { wall_w + lead } else { -lead - width };
        let along = |x: f64, d: f64| x + dir * d; // further back in the line
        let duck_y = p.fig_h * p.duck_at; // bottom of a flyer: you must be lower than this
        let running = self.phase == Phase::Run;
        // waiting: only coins drift by (something to catch while nothing has started)
        let run = [
            (Spawn::Low, 5.0),
            (Spawn::Low2, if tt > 12.0 { 1.2 } else { 0.0 }),
            (Spawn::High, if tt > 5.0 { 2.8 } else { 0.0 }),
            (Spawn::Coins, 1.2),
            (Spawn::LowCoins, 1.6),
            (Spawn::HighLow, if tt > 16.0 { 0.9 } else { 0.0 }),
            (Spawn::Star, if tt > 8.0 && !self.star_done { 0.35 } else { 0.0 }),
        ];
        let wait = [(Spawn::Coins, 1.0)];
        let opts: &[(Spawn, f64)] = if running { &run } else { &wait };
        let sum: f64 = opts.iter().map(|o| o.1).sum();
        let mut r = self.rng.f64() * sum;
        let mut kind = opts.first().map_or(Spawn::Coins, |o| o.0);
        for &(k, wgt) in opts {
            r -= wgt;
            if r <= 0.0 {
                kind = k;
                break;
            }
        }
        let air = AIR * self.speed; // m covered during one jump
        let len = match kind {
            Spawn::Low => self.low(enter(w(8.0)), cell),
            Spawn::Low2 => {
                let x = enter(w(8.0));
                let a = self.low(x, cell);
                a + air * 0.35 + self.low(along(x, a + air * 0.35), cell)
            }
            Spawn::High => self.high(enter(w(11.0)), duck_y, p, cell),
            Spawn::Coins => {
                let n = 5;
                // over the heads: reach up or jump
                let y0 = self.pick(&[1.0, 1.1, 1.2]).unwrap_or(1.0) * p.fig_h;
                let x = enter(w(4.0));
                for i in 0..n {
                    let ph = self.rng.f64() * 10.0;
                    let y = y0 + (f64::from(i) / f64::from(n - 1) * PI).sin() * 0.08 * p.fig_h;
                    self.things.push(Thing::new(Kind::Coin, Spr::Coin, false, along(x, f64::from(i) * w(6.0)), y, ph));
                }
                f64::from(n) * w(6.0)
            }
            Spawn::LowCoins => {
                // an arc of coins over an obstacle: where the jump goes
                let x = enter(w(8.0));
                let ow = self.low(x, cell);
                let n = 5;
                let span = air * 0.8;
                for i in 0..n {
                    let u = f64::from(i) / f64::from(n - 1);
                    let ph = self.rng.f64() * 10.0;
                    let y = p.fig_h * 0.9 + p.jump_height * 0.5 * (u * PI).sin();
                    self.things.push(Thing::new(Kind::Coin, Spr::Coin, false, along(x, ow / 2.0 - span / 2.0 + u * span), y, ph));
                }
                ow.max(span)
            }
            Spawn::HighLow => {
                let x = enter(w(11.0));
                let a = self.high(x, duck_y, p, cell);
                a + air * 1.6 + self.low(along(x, a + air * 1.6), cell)
            }
            Spawn::Star => {
                let x = enter(w(7.0));
                self.things.push(Thing::new(Kind::Star, Spr::Star, false, x, p.fig_h * 0.9, 0.0));
                self.star_done = true;
                w(7.0)
            }
        };
        // the gap to the next one: everybody must be able to land and look again
        let gap = air + self.speed * p.gap;
        let k = self.rand(1.0, 1.7);
        self.next_spawn = self.dist + len + gap * k / (if running { p.density } else { 0.5 }).max(0.2);
    }

    /// an obstacle on the ground; its width in m
    fn low(&mut self, x: f64, cell: f64) -> f64 {
        let ty = self.pick(&LOW).unwrap_or(Spr::Crawler);
        let w = SPRITES.frame(ty, 0).map_or(0, |s| s.w);
        let ph = self.rng.f64() * 10.0;
        self.things.push(Thing::new(Kind::Obstacle, ty, false, x, 0.0, ph));
        f64::from(w) * cell
    }

    /// an obstacle at head height; its width in m
    fn high(&mut self, x: f64, duck_y: f64, p: &P, cell: f64) -> f64 {
        let ty = self.pick(&HIGH).unwrap_or(Spr::Bat);
        let w = SPRITES.frame(ty, 0).map_or(0, |s| s.w);
        let y = duck_y + self.rand(0.0, 0.12) * p.fig_h;
        let ph = self.rng.f64() * 10.0;
        self.things.push(Thing::new(Kind::Obstacle, ty, true, x, y, ph));
        f64::from(w) * cell
    }

    /// the round is over: points, the crown for the best
    fn finish(&mut self, figures: &[Figure], figs: &[usize]) {
        self.results.clear();
        for f in figs.iter().filter_map(|&i| figures.get(i)) {
            if f.round == self.round {
                self.results.push(Score { id: f.id, score: f.round_score, best: false });
            }
        }
        let best = self.results.iter().map(|r| r.score).fold(0.0, f64::max);
        self.crowns.clear();
        if best > 0.0 {
            self.crowns.extend(self.results.iter().filter(|r| r.score == best).map(|r| r.id));
        }
        for r in &mut self.results {
            r.best = self.crowns.contains(&r.id);
        }
        for f in figs.iter().filter_map(|&i| figures.get(i)) {
            if self.crowns.contains(&f.id) {
                self.confetti(f, 60);
            }
        }
        self.set_phase(Phase::End);
        self.events.push(Event::End);
        self.goal = None;
    }

    /// One step. figures/figs: the players (people.rs) on the wall now, l: the mosaic layout, p: the
    /// params, o: tracking runs, who entered or jumped, the latency.
    pub fn step(&mut self, dt: f64, figures: &mut [Figure], figs: &[usize], l: &Layout, p: &P, o: &Input) {
        self.time += dt;
        let t = self.time;
        let pt = t - self.phase_at;
        let people = !figs.is_empty();
        self.empty_for = if people { 0.0 } else { self.empty_for + dt };

        // ---- the round ----
        match self.phase {
            Phase::Wait => {
                self.ready_for = if o.ready && people { self.ready_for + dt } else { 0.0 };
                if self.ready_for > p.wait_for {
                    self.start_count(figures, figs, p);
                }
            }
            Phase::Count => {
                if !people {
                    self.set_phase(Phase::Wait);
                } else {
                    let n = (COUNT - pt).ceil() as i64;
                    if n != self.last_count && n > 0 {
                        self.events.push(Event::Count);
                    }
                    self.last_count = n;
                    if pt >= COUNT {
                        self.set_phase(Phase::Run);
                        self.round_t = 0.0;
                        self.next_spawn = self.dist + 0.5;
                        self.events.push(Event::Go);
                    }
                }
            }
            Phase::Run => {
                self.round_t += dt;
                if self.empty_for > 3.0 {
                    self.set_phase(Phase::Wait); // everybody left: no result
                }
                let alive = figs.iter().filter_map(|&i| figures.get(i)).any(|f| f.alive == Some(true) && f.round == self.round);
                if people && !alive {
                    if self.all_dead_at < 0.0 {
                        self.all_dead_at = t;
                    }
                    if t - self.all_dead_at > 1.2 {
                        self.finish(figures, figs);
                    }
                } else {
                    self.all_dead_at = -1.0;
                }
            }
            Phase::End => {
                if pt > p.end_time {
                    if people {
                        self.start_count(figures, figs, p);
                    } else {
                        self.set_phase(Phase::Wait);
                    }
                }
            }
        }
        for &fi in o.entered {
            let Some(f) = figures.get_mut(fi) else { continue };
            // joins the running round (once per round: stepping out of the zone does not revive a ghost)
            if f.round != self.round {
                join(f, p, self.round);
            }
            self.burst(f, false);
            self.events.push(Event::Enter);
        }

        // ---- speed and direction ----
        let running = self.phase == Phase::Run;
        let ramp = (self.round_t / p.round_secs.max(5.0)).min(1.0);
        let target = if running { p.speed * (1.0 + (p.speed_max - 1.0) * ramp) } else { p.speed * 0.6 };
        self.speed += (target - self.speed) * (dt * 0.8).min(1.0);
        let mv = self.speed * dt;
        self.dist += mv;
        let want = match p.from {
            Side::Left => -1.0,
            Side::Right => 1.0,
            Side::Alternate => 0.0,
        };
        if want != 0.0 && want != self.dir && self.things.is_empty() && self.goal.is_none() {
            self.dir = want;
        }

        // ---- spawning: obstacles while the round runs, then the goal ----
        let goal_lead = l.wall_w / 2.0 / self.speed.max(0.3); // the goal reaches the middle at roundSecs
        if running && self.goal.is_none() && self.round_t >= p.round_secs - goal_lead {
            let x = if self.dir > 0.0 { l.wall_w + self.speed * 0.3 } else { -self.speed * 0.3 - f64::from(GOAL_W) * l.cell_mx };
            self.goal = Some(Goal { x, finished: Vec::new() });
            self.events.push(Event::GoalIn);
        }
        let spawn_until = p.round_secs - goal_lead - 1.2;
        if self.dist >= self.next_spawn && (self.phase == Phase::Wait || (running && self.round_t < spawn_until)) {
            self.spawn(l, p);
        } else if self.dist >= self.next_spawn {
            self.next_spawn = self.dist + 0.5;
        }

        for &fi in o.jumped {
            let Some(f) = figures.get(fi) else { continue };
            self.dust(f, l);
            self.events.push(if f.air_jumps > 0 { Event::AirJump } else { Event::Jump });
        }
        for &fi in figs {
            let Some(f) = figures.get_mut(fi) else { continue };
            if f.just_landed {
                f.just_landed = false;
                if f.alive != Some(false) {
                    self.dust(f, l);
                }
            }
            // running: a puff of dust behind the feet now and then (the figures run towards what comes)
            if f.alive != Some(false) && !f.air && t - f.puff > 0.32 && f.bbox[2] >= f.bbox[0] {
                f.puff = t + self.rng.f64() * 0.1;
                let x = f64::from(if self.dir > 0.0 { f.bbox[0] - 1 } else { f.bbox[2] + 1 });
                let vx = -self.dir * self.rand(2.0, 5.0);
                let vy = -self.rand(1.0, 3.0);
                let life = self.rand(0.25, 0.4);
                self.particles.push(Particle { x, y: f64::from(l.ground_row - 1), vx, vy, g: 6.0, col: [120.0, 100.0, 210.0], t0: t, life });
            }
        }

        // ---- the goal: crosses the wall; whoever it passes alive has made it ----
        if let Some(mut g) = self.goal.take() {
            g.x -= self.dir * mv;
            let gc = Self::col(l, g.x);
            for &fi in figs {
                let Some(f) = figures.get_mut(fi) else { continue };
                if f.alive != Some(true) || f.round != self.round || g.finished.contains(&f.id) {
                    continue;
                }
                let mid = f64::from(f.bbox[0] + f.bbox[2]) / 2.0;
                let passed = if self.dir > 0.0 { f64::from(gc) <= mid } else { f64::from(gc + GOAL_W - 1) >= mid };
                if passed {
                    g.finished.push(f.id);
                    f.round_score += p.goal_bonus;
                    self.confetti(f, 30);
                    self.events.push(Event::Finish);
                }
            }
            let over = running && if self.dir > 0.0 { gc + GOAL_W < 0 } else { gc > l.gw };
            self.goal = Some(g);
            if over {
                self.finish(figures, figs);
            }
        }

        self.collide(dt, figures, figs, l, p, o.lag, mv);
        if p.assist {
            for &fi in o.jumped {
                self.carry(fi, figures, l, p, o.lag);
            }
        }

        // particles: cells that fly and fall
        let (gw, gh) = (f64::from(l.gw), f64::from(l.gh));
        self.particles.retain_mut(|q| {
            if (t - q.t0) / q.life >= 1.0 {
                return false;
            }
            q.vy += q.g * dt;
            q.x += q.vx * dt;
            q.y += q.vy * dt;
            !(q.x < -2.0 || q.x > gw + 2.0 || q.y > gh + 2.0)
        });
    }

    fn start_count(&mut self, figures: &mut [Figure], figs: &[usize], p: &P) {
        self.round += 1;
        self.set_phase(Phase::Count);
        self.last_count = 0;
        self.things.clear();
        if p.from == Side::Alternate && self.round > 1 {
            self.dir = -self.dir; // every round from the other side
        }
        self.goal = None;
        self.star_done = false;
        self.all_dead_at = -1.0;
        for &fi in figs {
            if let Some(f) = figures.get_mut(fi) {
                join(f, p, self.round);
            }
        }
    }

    /// Move the things and check them against the players. Latency compensation: a figure shows the
    /// person as they were `lag` seconds ago (tracking, jump detection, display). So the figures are
    /// checked against where the obstacles were back then: shifted `back` cells towards where they
    /// come from. Whoever jumped or ducked in time on the obstacles they saw is safe, even if the
    /// figure goes up a moment late. Coins and stars count at either place (generous).
    #[allow(clippy::too_many_arguments)]
    fn collide(&mut self, dt: f64, figures: &mut [Figure], figs: &[usize], l: &Layout, p: &P, lag: f64, mv: f64) {
        let back = js_round(self.dir * self.speed * lag.max(0.0) / l.cell_mx) as i32;
        let round = self.round;
        let mut players = std::mem::take(&mut self.players);
        let mut others = std::mem::take(&mut self.others);
        players.clear();
        others.clear();
        for &fi in figs {
            let Some(f) = figures.get(fi) else { continue };
            if f.alive == Some(true) && f.round == round {
                players.push(fi);
            }
            if f.alive != Some(false) {
                others.push(fi);
            }
        }
        let mut things = std::mem::take(&mut self.things);
        things.retain_mut(|th| self.collide_one(th, dt, figures, &players, &others, l, p, back, mv));
        self.things = things;
        self.players = players;
        self.others = others;
    }

    /// One thing: moves, animates; false when it is gone. Then the figures it meets.
    #[allow(clippy::too_many_arguments)]
    fn collide_one(&mut self, th: &mut Thing, dt: f64, figures: &mut [Figure], players: &[usize], others: &[usize], l: &Layout, p: &P, back: i32, mv: f64) -> bool {
        let t = self.time;
        let gw = l.gw;
        th.x -= self.dir * mv;
        th.phase += dt;
        if th.ty == Spr::Bat {
            th.y = th.base_y + (th.phase * 5.0).sin() * l.cell_my * 1.2;
        }
        let c0 = Self::col(l, th.x);
        let frames = SPRITES.of(th.ty);
        let fi = ((th.phase * if th.kind == Kind::Coin { 8.0 } else { 7.0 }).floor() as i64).rem_euclid(frames.len().max(1) as i64) as usize;
        let Some(fr) = frames.get(fi) else { return false };
        th.frame = Some(fi);
        th.c0 = c0;
        th.r0 = Self::row(l, th.y) - fr.h + 1;
        let gone = if self.dir > 0.0 { c0 + fr.w < -2 } else { c0 > gw + 2 };
        if gone || th.dead {
            return false;
        }
        let obstacle = th.kind == Kind::Obstacle;
        if c0.max(c0 + back) + fr.w - 1 < 0 || c0.min(c0 + back) >= gw {
            return true;
        }
        let flip = flip_of(self.dir, th.kind);
        // obstacles only hit while the round runs; coins can be caught any time (count while it runs)
        let playing = matches!(self.phase, Phase::Run | Phase::Count);
        let targets: &[usize] = if self.phase == Phase::Run {
            players
        } else if obstacle {
            &[]
        } else {
            others
        };
        for &fi in targets {
            let Some(f) = figures.get_mut(fi) else { continue };
            let [b0, _, b1, _] = f.bbox;
            // where it is checked: shifted back (latency); for a figure carried over it (see carry),
            // from the top of the jump on where it is now, so the figure lands right behind it
            let cc = if obstacle { c0 + if th.visual_from.iter().any(|v| v.0 == f.id && v.1 <= t) { 0 } else { back } } else { c0 };
            let lo = if obstacle { cc } else { c0.min(c0 + back) };
            let hi = (if obstacle { cc } else { c0.max(c0 + back) }) + fr.w - 1;
            if lo > b1 || hi < b0 {
                // past this figure without a hit: it cleared the obstacle
                if obstacle && !th.hit.contains(&f.id) && !th.passed.contains(&f.id) {
                    let past = if self.dir > 0.0 { hi < b0 } else { lo > b1 };
                    if past && th.near.contains(&f.id) {
                        th.passed.push(f.id);
                        f.streak += 1;
                        f.round_score += 1.0;
                        if let Some([hx, hy]) = f.head_cell {
                            self.sparkle(f64::from(hx), f64::from(hy - f.lift_rows - 2), f.outfit.shirt, 6, false);
                        }
                        self.events.push(Event::Clear(f.streak));
                    }
                }
                continue;
            }
            if obstacle && th.passed.contains(&f.id) {
                continue; // already past it
            }
            if obstacle && !th.near.contains(&f.id) {
                th.near.push(f.id);
            }
            let mut hits = overlap(th.r0, fr, f, l, flip, cc);
            let mut at = cc;
            if !obstacle && hits.0 == 0 && back != 0 {
                hits = overlap(th.r0, fr, f, l, flip, c0 + back);
                at = c0 + back;
            }
            let (n, hc, hr) = hits;
            if n == 0 {
                continue;
            }
            let vc = f64::from(hc - (at - c0)); // the cell on the wall now (for effects)
            let vr = f64::from(hr - f.lift_rows);
            match th.kind {
                Kind::Coin => {
                    th.dead = true;
                    if playing && f.round == self.round {
                        f.round_score += 1.0;
                    }
                    self.sparkle(vc, vr, GOLD, 10, false);
                    self.events.push(Event::Coin);
                    break;
                }
                Kind::Star => {
                    th.dead = true;
                    f.star_until = t + p.star_time;
                    self.sparkle(vc, vr, WHITE, 24, true);
                    self.events.push(Event::Star);
                    break;
                }
                Kind::Obstacle => {}
            }
            if t < f.star_until {
                th.dead = true;
                f.round_score += 2.0;
                self.explode(th, fr);
                self.events.push(Event::Smash);
                break;
            }
            if th.hit.contains(&f.id) || f64::from(n) < p.hit_cells || t < f.safe_until {
                continue;
            }
            // grace: a contact only counts when the figure still touches the obstacle a moment later;
            // a jump (or duck) in between saves it
            match th.contact.iter_mut().find(|c| c.0 == f.id) {
                Some(c) if t - c.1 <= 1.0 => {
                    if t - c.1 < p.grace {
                        continue;
                    }
                }
                Some(c) => {
                    c.1 = t;
                    if p.grace > 0.0 {
                        continue;
                    }
                }
                None => {
                    th.contact.push((f.id, t));
                    if p.grace > 0.0 {
                        continue;
                    }
                }
            }
            th.hit.push(f.id);
            f.hit_at = t;
            f.safe_until = t + p.safe_time;
            f.streak = 0;
            f.lives -= 1.0;
            self.sparkle(vc, vr, RED, 14, false);
            if f.lives <= 0.0 {
                f.alive = Some(false);
                self.burst(f, true);
                self.events.push(Event::Die);
            } else {
                self.events.push(Event::Hit);
            }
        }
        true
    }

    /// Jump assist: whoever jumps with the right timing comes over the obstacle well, without flying
    /// much more than needed. The jump that just started is stretched over the ground obstacles that
    /// will pass below the figure's legs. Rising, the figure is checked against where the obstacle
    /// was `lag` s ago (the takeoff was late by the latency, not the person); from the top on against
    /// where it is on the wall, so the figure lands right behind it and does not hang in the air for
    /// the latency (a moment less: half the grace). Two close after each other make one long jump.
    /// See Figure::carry.
    fn carry(&mut self, fi: usize, figures: &mut [Figure], l: &Layout, p: &P, lag: f64) {
        let Some(f) = figures.get_mut(fi) else { return };
        if f.jump.is_none() || !f.has_grid || f.bbox[2] < f.bbox[0] {
            return;
        }
        // the columns of the legs: the lowest rows of the figure (before the lift)
        let gw = l.gw;
        let [c0, _, c1, r1] = f.bbox;
        let (mut l0, mut l1) = (gw, -1);
        for r in (r1 - LEG_ROWS + 1).max(0)..=r1 {
            for c in c0..=c1 {
                if f.grid.get((r * gw + c) as usize).is_none_or(|&v| v == 0) {
                    continue;
                }
                l0 = l0.min(c);
                l1 = l1.max(c);
            }
        }
        if l1 < l0 {
            return;
        }
        let vc = self.speed.max(0.1) / l.cell_mx; // cells per s
        let late = lag.max(0.0).min(p.grace * 0.5); // s: the end may use half the grace
        self.wins.clear();
        for (ti, th) in self.things.iter().enumerate() {
            if th.kind != Kind::Obstacle || th.high || th.dead || th.hit.contains(&f.id) || th.passed.contains(&f.id) {
                continue;
            }
            let Some(fr) = th.sprite() else { continue };
            let lo = (th.x * l.px_x - f64::from(l.ox)) / f64::from(l.cell_px); // its left edge on the wall now (cells)
            let hi = lo + f64::from(fr.w);
            // reaches the legs and leaves them, on the wall now
            let a = (if self.dir > 0.0 { lo - f64::from(l1 + 1) } else { f64::from(l0) - hi }) / vc;
            let b = (if self.dir > 0.0 { hi - f64::from(l0) } else { f64::from(l1 + 1) - lo }) / vc;
            if b - late <= 0.0 {
                continue;
            }
            self.wins.push(Win { th: ti, a, up: a + lag.max(0.0) - PAD, b: b - late + PAD, clear: (f64::from(fr.h) + CLEAR_CELLS) * l.cell_my });
        }
        self.wins.sort_by(|x, y| x.a.partial_cmp(&y.a).unwrap_or(Ordering::Equal));
        let mut w: Option<Win> = None;
        self.carried.clear();
        for x in &self.wins {
            match w.as_mut() {
                None => {
                    if x.a > CARRY_AHEAD {
                        break;
                    }
                    w = Some(*x);
                    self.carried.push(x.th);
                }
                Some(cur) => {
                    if x.a - cur.b <= MERGE_GAP {
                        cur.b = cur.b.max(x.b);
                        cur.clear = cur.clear.max(x.clear);
                        self.carried.push(x.th);
                    } else {
                        break;
                    }
                }
            }
        }
        let Some(w) = w else { return };
        // up when it comes where it is checked while rising (the takeoff counts with the latency
        // compensation), still up when it has left the legs where it is seen
        f.carry(self.time, w.up, w.b, w.clear, p);
        let Some(j) = f.jump else { return };
        let top = j.t0 + j.ta;
        let id = f.id;
        for &ti in &self.carried {
            let Some(th) = self.things.get_mut(ti) else { continue };
            match th.visual_from.iter_mut().find(|v| v.0 == id) {
                Some(v) => v.1 = top,
                None => th.visual_from.push((id, top)),
            }
        }
    }

    /// a burst of cells (coin, hit)
    fn sparkle(&mut self, c: f64, r: f64, col: Rgb, n: usize, rainbow_colors: bool) {
        for i in 0..n {
            let a = self.rng.f64() * TAU;
            let v = self.rand(4.0, 14.0);
            let life = self.rand(0.35, 0.7);
            let col = if rainbow_colors { rainbow(i as f64 / n as f64) } else { col };
            self.particles.push(Particle { x: c, y: r, vx: a.cos() * v, vy: a.sin() * v - 6.0, g: 30.0, col, t0: self.time, life });
        }
    }

    /// confetti over a figure that reached the goal (and for the winner)
    fn confetti(&mut self, f: &Figure, n: usize) {
        let [b0, r0, b1, _] = f.bbox;
        for _ in 0..n {
            let x = self.rand(f64::from(b0 - 3), f64::from(b1 + 4));
            let y = f64::from(r0 - f.lift_rows) - self.rand(2.0, 8.0);
            let vx = self.rand(-6.0, 6.0);
            let vy = -self.rand(4.0, 14.0);
            let col = rainbow(self.rng.f64());
            let life = self.rand(0.8, 1.4);
            self.particles.push(Particle { x, y, vx, vy, g: 22.0, col, t0: self.time, life });
        }
    }

    /// an obstacle falls apart into its cells
    fn explode(&mut self, th: &Thing, fr: &Sprite) {
        for &(sx, sy, col) in &fr.px {
            let a = self.rng.f64() * TAU;
            let v = self.rand(3.0, 12.0);
            let life = self.rand(0.4, 0.9);
            self.particles.push(Particle { x: f64::from(th.c0 + sx), y: f64::from(th.r0 + sy), vx: a.cos() * v, vy: a.sin() * v - 8.0, g: 35.0, col, t0: self.time, life });
        }
    }

    /// dust at the feet when a figure jumps or lands
    fn dust(&mut self, f: &Figure, l: &Layout) {
        let [b0, _, b1, _] = f.bbox;
        let r = f64::from(l.ground_row - 1 - if f.air { f.lift_rows } else { 0 });
        for i in 0..8 {
            let left = i % 2 == 0;
            let vx = (if left { -1.0 } else { 1.0 }) * self.rand(3.0, 9.0);
            let vy = -self.rand(1.0, 5.0) * if f.air { -0.5 } else { 1.0 };
            let life = self.rand(0.25, 0.45);
            self.particles.push(Particle { x: if left { f64::from(b0) - 0.5 } else { f64::from(b1) + 0.5 }, y: r, vx, vy, g: 12.0, col: [190.0, 170.0, 255.0], t0: self.time, life });
        }
    }

    /// a figure appears (sparkles all over it) or turns into a ghost (pale puffs rising)
    fn burst(&mut self, f: &Figure, ghost: bool) {
        let [b0, r0, b1, r1] = f.bbox;
        if b1 < b0 {
            return;
        }
        for _ in 0..(if ghost { 40 } else { 26 }) {
            let x = self.rand(f64::from(b0), f64::from(b1 + 1));
            let y = self.rand(f64::from(r0), f64::from(r1 + 1)) - f64::from(f.lift_rows);
            let vx = self.rand(-2.0, 2.0);
            let vy = -self.rand(2.0, if ghost { 12.0 } else { 8.0 });
            let life = self.rand(0.4, if ghost { 1.2 } else { 0.9 });
            let col = if ghost { [170.0, 225.0, 255.0] } else { [210.0, 240.0, 255.0] };
            self.particles.push(Particle { x, y, vx, vy, g: 0.0, col, t0: self.time, life });
        }
    }
}
