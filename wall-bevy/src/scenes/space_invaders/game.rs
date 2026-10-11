//! The game (game.js), in "art pixels" of the map (x right along the wall, y = the depth of the room
//! in front of the wall; see mod.rs for the mapping). Space Invaders turned by 90 degrees, twice: one
//! formation comes from the left edge, one from the right one. They march up and down the map and
//! step closer to the city in the middle whenever they reach the top or the bottom; at the city they
//! storm it.
//!
//! The people (body.rs, from the masks) defend it. Control schemes (param `control`):
//!   Automatik   every unit fires at the nearest invader on its own: you aim by where you stand;
//!               standing still builds a fort (fires faster, draws fire)
//!   Zeigen      an arm that sticks out fires; the shot locks onto what it points at
//!   both        automatic fire, and pointing takes over while an arm points
//! Always: a laser between people standing close together, arms block bullets and destroy invaders
//! they touch, a body hit stuns for a moment. Jumping starts the boost: faster fire, double damage,
//! more range, full fire also on the move; the hexagon around the unit is its energy, used up while
//! boosting and charged again afterwards (a bent power bar).
//!
//! Balance: a director, as in Left 4 Dead.
//!   - The crowd (people present, smoothed) sizes every wave: more rows and columns, more hit points,
//!     more fire, more divers. Changes in the crowd act live on fire and divers.
//!   - A skill rating learns how the crowd does: a wave cleared fast and clean raises it, a storm on
//!     the city or a fallen city lowers it. difficulty = (1 + 0.1 * (wave - 1)) * skill.
//!   - The city heals only as a reward: after a wave (more after a clean one), or by shooting the
//!     mothership. When it falls below `cityFall` it collapses (a lost game): chain explosions, the
//!     invaders dance, then everything starts over from wave 1 with a lower skill rating.
//!   - Mercy: a city below 40 % brings the mothership (it repairs the city when shot). Pressure: a
//!     crowd that wipes out a wave fast gets divers.
//!   - Alone it is easier: `ease` (0.65 with one person, 1 from three on) scales the enemies' fire,
//!     divers, mines, edge lasers, hit points and the battleship.
//!
//! Threats that make people move: invaders glow red in the eyes before they shoot; bombers lob mines
//! that explode after a warning pulse; from wave `shipFrom` on a battleship comes, flies over a
//! person (forts first), charges with a warning stripe on the floor and fires a thick laser across the
//! whole map: whoever stands in it is hit hard, the city gets a trench, and invaders in it burn too
//! (lure it into them). Shot down, it explodes in a chain and repairs the city. From wave `edgeFrom`
//! on, emitters at the left and right edge fire lasers across the map at an angle, through somebody's
//! place: first only the middle line shows, then the beam opens up.
//!
//! Power-ups (walk onto them; dropped where the Kinect can see people, away from everybody): repair,
//! rapid fire, a fan of three shots, a shield for three hits, a nova (a big shock wave), a mega laser
//! of one's own, slow motion for every enemy. More of them when the crowd struggles (the director),
//! repairs more likely when the city is low; the mothership and the battleship drop some.
//!
//! Rust: targets are handles (an invader of the current wave, a diver, the mothership, the ship by
//! id) instead of object references; the player states live in insertion order (as the JS Map).

use std::collections::VecDeque;
use std::f64::consts::PI;

use crate::scenes::common::rand::Rng;

use super::body::Bodies;
use super::city::{self, CityLight, Lane};
use super::fx::Fx;
use super::pixels::{ART, INVADER_TYPES, Kind, POWERS, Power, Rgb, SHIP_H, SHIP_W, UFO_H, UFO_W, WHITE, clamp, jr, jsign, neon};
use super::{JumpHint, P};

/// formation cell (art px)
const PX: f64 = 15.0;
const PY: f64 = 12.0;
const SPRITE_H: f64 = 9.0;
pub const RED: Rgb = [1.0, 0.16, 0.24];
pub const ORANGE: Rgb = [1.0, 0.42, 0.12];
pub const EMBER: Rgb = [1.0, 0.35, 0.08];
pub const SHIELD: Rgb = [0.55, 0.95, 1.0];
pub const BEAM: Rgb = [1.0, 0.25, 0.55];
/// the fire map key of the automatic fire (arm ids are other numbers)
pub const AUTO: i64 = i64::MIN;
/// slots of the tracking (1..16)
pub const SLOTS: usize = 17;

fn points(k: Kind) -> i64 {
    match k {
        Kind::Squid => 30,
        Kind::Crab => 20,
        Kind::Octopus => 10,
        _ => 0,
    }
}

fn hp_of(k: Kind) -> f64 {
    match k {
        Kind::Octopus => 1.0,
        _ => 2.0,
    }
}

/// distance from (px, py) to the infinite line through a and b
fn line_dist(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = bx - ax;
    let dy = by - ay;
    (dy * (px - ax) - dx * (py - ay)).abs() / 1e-6_f64.max(dx.hypot(dy))
}

fn seg_dist(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = bx - ax;
    let dy = by - ay;
    let t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy).max(1e-6), 0.0, 1.0);
    (px - ax - dx * t).hypot(py - ay - dy * t)
}

/// does the segment a-b cross the box (x0, y0)-(x1, y1)? (Liang-Barsky)
#[allow(clippy::too_many_arguments)]
fn seg_box(ax: f64, ay: f64, bx: f64, by: f64, x0: f64, y0: f64, x1: f64, y1: f64) -> bool {
    let mut t0 = 0.0_f64;
    let mut t1 = 1.0_f64;
    let dx = bx - ax;
    let dy = by - ay;
    for (p, q) in [(-dx, ax - x0), (dx, x1 - ax), (-dy, ay - y0), (dy, y1 - ay)] {
        if p == 0.0 {
            if q < 0.0 {
                return false;
            }
        } else {
            let r = q / p;
            if p < 0.0 {
                t0 = t0.max(r);
            } else {
                t1 = t1.min(r);
            }
            if t0 > t1 {
                return false;
            }
        }
    }
    true
}

/// The invaders' colors by type (main.js INVADER_COLORS), WHITE for anything else.
#[derive(Clone, Copy)]
pub struct InvCol(pub [Rgb; 3]);

impl InvCol {
    pub fn of(&self, k: Kind) -> Rgb {
        match k {
            Kind::Squid | Kind::Crab | Kind::Octopus => self.0[k.idx()],
            _ => WHITE,
        }
    }
}

/// What the sounds hear of the game (sound.rs).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Ev {
    March(usize),
    Laser,
    Kill(i32),
    Warp,
    Dive,
    Fall,
    Rebuild,
    Shield,
    ShieldBreak,
    BombThrow,
    BombLand,
    BombBeep,
    Bomb,
    ShipEnter,
    Charge,
    Beam(bool),
    ShipHit,
    ShipKill,
    Item,
    Pickup(Power),
    EdgeCharge,
    EdgeFire,
    Jump,
    JumpEmpty,
    Boost,
    BoostEnd,
    BoostReady,
    Ping,
    Fortify,
    Link,
    Zap,
    Block,
    Hit,
    City,
    Crash,
    Storm,
    Ufo(bool),
    UfoKill,
    Clear,
    Firework,
    Enter,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    Enter,
    Fight,
    Clear,
    Fall,
    Rebuild,
}

impl Phase {
    pub fn name(self) -> &'static str {
        match self {
            Phase::Enter => "enter",
            Phase::Fight => "fight",
            Phase::Clear => "clear",
            Phase::Fall => "fall",
            Phase::Rebuild => "rebuild",
        }
    }
}

/// a target: an invader of a formation (of wave `wave_no`), a diver, the mothership, the battleship
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Target {
    Inv { wave_no: u32, side: usize, i: usize },
    Diver(u32),
    Ufo(u32),
    Ship(u32),
}

/// an arm of a unit: art px
#[derive(Clone, Copy, Debug)]
pub struct UArm {
    pub id: i64,
    pub from: [f64; 2],
    pub tip: [f64; 2],
    pub dir: [f64; 2],
}

/// A person as the game sees it (main.js collectPeople): art px of the map.
#[derive(Clone, Debug)]
pub struct Unit {
    pub id: u32,
    pub slot: u8,
    pub col: Rgb,
    pub center: [f64; 2],
    pub arms: Vec<UArm>,
    pub stomp: bool,
    pub head: Option<[f64; 2]>,
    pub hands: [Option<[f64; 2]>; 2],
    pub face: f64,
}

/// the layout of the map as the game needs it
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GameLayout {
    pub aw: f64,
    pub ah: f64,
    pub sx: f64,
    pub sy: f64,
    pub city_x0: f64,
    pub city_w: usize,
    pub s: usize,
}

/// the box of an invader: x, y, w, h, type
#[derive(Clone, Copy, Debug)]
pub struct Bx {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub k: Kind,
}

pub struct Side {
    /// -1 comes from the left edge, +1 from the right one
    pub edge: f64,
    /// the way to the city
    pub dir_x: f64,
    pub rows: usize,
    pub cols: usize,
    pub fx: f64,
    pub fy: f64,
    pub ydir: f64,
    pub alive: Vec<u8>,
    pub hp: Vec<u8>,
    pub hp_max: Vec<u8>,
    pub flash: Vec<f32>,
    pub kick_x: Vec<f32>,
    pub kick_y: Vec<f32>,
    pub kick_at: Vec<f32>,
    pub shield: Vec<u8>,
    pub shield_hit: Vec<f32>,
    pub charge: Vec<f32>,
    pub spawn: Vec<f32>,
    pub count: i32,
    /// storming the city: one after the other dives in (and whether i is still waiting in it)
    pub storm: Option<VecDeque<usize>>,
    pub in_storm: Vec<bool>,
    pub storm_t: f64,
}

impl Side {
    pub fn n(&self) -> usize {
        self.alive.len()
    }
}

pub enum DiverTarget {
    Person(u32),
    Point(f64, f64),
}

pub struct Diver {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub v: f64,
    pub k: Kind,
    pub hp: f64,
    pub flash: f64,
    pub t0: f64,
    pub target: DiverTarget,
    pub trail: VecDeque<[f64; 2]>,
    pub trail_t: f64,
    /// its formation's way to the city
    pub dir_x: f64,
}

pub struct Ufo {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub vx: f64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ShipState {
    Aim,
    Charge,
    Fire,
    Leave,
}

impl ShipState {
    pub fn name(self) -> &'static str {
        match self {
            ShipState::Aim => "aim",
            ShipState::Charge => "charge",
            ShipState::Fire => "fire",
            ShipState::Leave => "leave",
        }
    }
}

pub struct Ship {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub hp: f64,
    pub hp_max: f64,
    pub state: ShipState,
    pub state_t: f64,
    pub shots: f64,
    pub beam_x: f64,
    pub target_x: f64,
    pub flash: f64,
}

pub struct ShipDeath {
    pub x: f64,
    pub y: f64,
    pub t0: f64,
    pub next: f64,
    pub done: bool,
}

pub struct Shot {
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub col: Rgb,
    pub slot: u8,
    pub target: Option<Target>,
    pub dmg: f64,
    pub big: bool,
}

pub struct Bullet {
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub aimed: bool,
    pub anim: f64,
}

pub struct Particle {
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub col: Rgb,
    pub t0: f64,
    pub life: f64,
}

pub struct Boom {
    pub x: f64,
    pub y: f64,
    pub t0: f64,
    pub col: Rgb,
    pub warp: bool,
    pub splat: bool,
}

/// what a shock wave already hit (an invader by side and index: JS keyed it by edge * 10000 + i)
#[derive(Clone, Copy, PartialEq)]
enum DoneKey {
    Inv(usize, usize),
    Diver(u32),
    Ufo(u32),
    Ship(u32),
}

pub struct Wave {
    pub x: f64,
    pub y: f64,
    pub t0: f64,
    pub slot: u8,
    pub col: Rgb,
    pub r: f64,
    done: Vec<DoneKey>,
    pub dmg: f64,
}

#[derive(Clone, Copy)]
pub struct LinkState {
    pub ready: f64,
    pub flash: f64,
    pub born: f64,
    pub seen: f64,
}

/// a team laser of this frame: the units (indices into people) and its state's key
pub struct Link {
    pub key: (u32, u32),
    pub a: usize,
    pub b: usize,
}

struct Pending {
    wave_no: u32,
    side: usize,
    i: usize,
    at: f64,
    aimed: bool,
    target_id: Option<u32>,
    speed: f64,
}

pub struct Bomb {
    x0: f64,
    y0: f64,
    pub x: f64,
    pub y: f64,
    tx: f64,
    ty: f64,
    pub t0: f64,
    pub flight: f64,
    pub fuse: f64,
    /// m
    pub r: f64,
    landed: bool,
    beep: f64,
}

pub struct Scorch {
    pub x: f64,
    pub w: f64,
    pub y0: f64,
    pub t0: f64,
}

pub struct Item {
    pub kind: Power,
    pub x: f64,
    pub y: f64,
    pub t0: f64,
    pub life: f64,
    taken: bool,
}

pub struct EdgeLaser {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub t0: f64,
    pub tele: f64,
    pub half: f64,
    hit: Vec<u32>,
    fired: bool,
}

pub struct Footprint {
    pub x: f64,
    pub y: f64,
    pub dir: [f64; 2],
    pub t0: f64,
    pub col: Rgb,
}

pub struct Car {
    pub lane: usize,
    pub pos: f64,
    pub speed: f64,
    pub col: Rgb,
}

#[derive(Clone, Copy, Default)]
pub struct Boost {
    pub charge: f64,
    pub active: bool,
    pub at: f64,
    pub ready_at: f64,
    pub uses: u32,
}

#[derive(Clone, Copy, Default)]
pub struct Powers {
    pub rapid: f64,
    pub spread: f64,
    pub mega: f64,
    pub shield: i32,
    pub shield_until: f64,
    pub mega_tick: f64,
}

#[derive(Clone, Copy)]
pub struct Mega {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub dir: [f64; 2],
    pub half: f64,
}

/// A player's state (by person id).
#[derive(Clone)]
pub struct PState {
    pub slot: u8,
    /// when each arm (or AUTO) fired last
    fire: Vec<(i64, f64)>,
    /// what each pointing arm locks onto
    pub lock: Vec<(i64, Target)>,
    auto: f64,
    pub auto_target: Option<Target>,
    pub speed: f64,
    pub fortified: bool,
    pub fort_at: f64,
    pub stun_until: f64,
    pub hit_at: f64,
    combo: i32,
    last_kill: f64,
    seen: f64,
    pub power: Powers,
    pub mega: Option<Mega>,
    pub shield_hit: f64,
    pub boost: Boost,
    pub jump_at: f64,
    pub denied_at: f64,
    pub launch_at: f64,
    pub launch_full: bool,
    pos: Option<[f64; 2]>,
    still_since: f64,
    pub dir: Option<[f64; 2]>,
    pub phase: f64,
    step_acc: f64,
    foot: u8,
}

impl PState {
    fn new(slot: u8, time: f64) -> Self {
        Self {
            slot,
            fire: Vec::with_capacity(4),
            lock: Vec::with_capacity(4),
            auto: -9.0,
            auto_target: None,
            speed: 0.0,
            fortified: false,
            fort_at: -9.0,
            stun_until: -1.0,
            hit_at: -1.0,
            combo: 0,
            last_kill: -9.0,
            seen: time,
            power: Powers { rapid: -9.0, spread: -9.0, mega: -9.0, shield: 0, shield_until: -9.0, mega_tick: 0.0 },
            mega: None,
            shield_hit: -9.0,
            boost: Boost { charge: 1.0, active: false, at: -9.0, ready_at: -9.0, uses: 0 },
            jump_at: -9.0,
            denied_at: -9.0,
            launch_at: -9.0,
            launch_full: false,
            pos: None,
            still_since: 0.0,
            dir: None,
            phase: 0.0,
            step_acc: 0.0,
            foot: 0,
        }
    }

    /// when `key` fired last (-9: never)
    pub fn fired(&self, key: i64) -> f64 {
        self.fire.iter().find(|f| f.0 == key).map_or(-9.0, |f| f.1)
    }

    fn set_fired(&mut self, key: i64, t: f64) {
        match self.fire.iter_mut().find(|f| f.0 == key) {
            Some(f) => f.1 = t,
            None => self.fire.push((key, t)),
        }
    }
}

struct Stats {
    t0: f64,
    dead0: usize,
    hits: f64,
    storms: i32,
    mercy: bool,
    pressure: bool,
}

pub struct City {
    pub x0: f64,
    pub w: usize,
    pub h: usize,
    pub s: usize,
    pub base: Vec<u8>,
    /// the picture (rgb per LED) and the same as RGBA bytes (×255, as Pix stores it, opaque)
    pub img: Vec<f32>,
    pub img8: Vec<u8>,
    pub img_w: usize,
    pub lanes: Vec<Lane>,
    pub lights: Vec<CityLight>,
    /// art px: x, y, r
    pub core: [f64; 3],
    /// art px: x, y0, y1
    pub conduit: [f64; 3],
    pub alive: Vec<u8>,
    pub dead: Vec<usize>,
    pub dead_at: Vec<f32>,
    pub born: Vec<f32>,
    pub hit_at: f64,
    pub total: usize,
}

/// Uint8ClampedArray of a picture value
fn byte(v: f32) -> u8 {
    let v = f64::from(v) * 255.0;
    if v.is_nan() || v <= 0.0 {
        0
    } else if v >= 255.0 {
        255
    } else {
        let r = (v + 0.5) as i32;
        (if f64::from(r) - v == 0.5 && r & 1 == 1 { r - 1 } else { r }) as u8
    }
}

pub struct Game {
    pub rng: Rng,
    pub fx: Fx,
    pub events: Vec<Ev>,
    pub time: f64,
    p: P,
    /// false until the first step (startWave then uses its own defaults, as the JS before this.P)
    p_set: bool,
    pub skill: f64,
    pub crowd: f64,
    pub l: GameLayout,
    pub city: City,
    pub cars: Vec<Car>,
    pub footprints: VecDeque<Footprint>,
    pub level: i32,
    pub score: i64,
    pub players: Vec<(u32, PState)>,
    pub link_state: Vec<((u32, u32), LinkState)>,
    pub empty_for: f64,
    dirty: bool,
    pub shots: Vec<Shot>,
    pub bullets: Vec<Bullet>,
    pub divers: Vec<Diver>,
    pub particles: Vec<Particle>,
    pub booms: Vec<Boom>,
    pub waves: Vec<Wave>,
    pub links: Vec<Link>,
    pub ufo: Option<Ufo>,
    next_ufo: f64,
    pending: Vec<Pending>,
    pub bombs: Vec<Bomb>,
    pub scorches: Vec<Scorch>,
    pub ship: Option<Ship>,
    ship_death: Option<ShipDeath>,
    pub beat_at: f64,
    pub items: Vec<Item>,
    pub edge_lasers: Vec<EdgeLaser>,
    next_item: f64,
    pub enemy_slow_until: f64,
    edge_acc: f64,
    pub party: f64,
    pub alarm: f64,
    pub sides: Vec<Side>,
    total: usize,
    pub phase: Phase,
    pub phase_t: f64,
    beat_t: f64,
    beat: usize,
    pub frame_anim: usize,
    fire_acc: f64,
    dive_acc: f64,
    stats: Stats,
    bomb_acc: f64,
    camp: f64,
    next_ship: f64,
    repair: f64,
    drop_later: i32,
    dt_last: f64,
    fall_t: f64,
    /// where people can get to (the fog mask, AW x AH: 255 = seen)
    pub reach: Option<Vec<u8>>,
    /// the wave (its formations); targets of older waves are gone
    wave_no: u32,
    next_id: u32,
    /// scratch lists (no allocation per frame)
    scratch: Vec<(Target, f64, f64, f64, f64)>,
}

impl Game {
    /// a game on a layout (game.js constructor + setLayout)
    pub fn new(l: GameLayout, p: P, seed: u64) -> Self {
        let mut g = Self {
            rng: Rng::new(seed),
            fx: Fx::new(),
            events: Vec::with_capacity(64),
            time: 0.0,
            p,
            p_set: false,
            skill: 1.0,
            crowd: 0.0,
            l,
            city: City {
                x0: 0.0,
                w: 0,
                h: 0,
                s: 1,
                base: Vec::new(),
                img: Vec::new(),
                img8: Vec::new(),
                img_w: 0,
                lanes: Vec::new(),
                lights: Vec::new(),
                core: [0.0; 3],
                conduit: [0.0; 3],
                alive: Vec::new(),
                dead: Vec::new(),
                dead_at: Vec::new(),
                born: Vec::new(),
                hit_at: -9.0,
                total: 0,
            },
            cars: Vec::new(),
            footprints: VecDeque::new(),
            level: 1,
            score: 0,
            players: Vec::new(),
            link_state: Vec::new(),
            empty_for: 0.0,
            dirty: false,
            shots: Vec::new(),
            bullets: Vec::new(),
            divers: Vec::new(),
            particles: Vec::with_capacity(2048),
            booms: Vec::new(),
            waves: Vec::new(),
            links: Vec::new(),
            ufo: None,
            next_ufo: 18.0,
            pending: Vec::new(),
            bombs: Vec::new(),
            scorches: Vec::new(),
            ship: None,
            ship_death: None,
            beat_at: -9.0,
            items: Vec::new(),
            edge_lasers: Vec::new(),
            next_item: 10.0,
            enemy_slow_until: 0.0,
            edge_acc: 0.0,
            party: 0.0,
            alarm: 0.0,
            sides: Vec::new(),
            total: 0,
            phase: Phase::Enter,
            phase_t: 0.0,
            beat_t: 0.0,
            beat: 0,
            frame_anim: 0,
            fire_acc: 0.0,
            dive_acc: 0.0,
            stats: Stats { t0: 0.0, dead0: 0, hits: 0.0, storms: 0, mercy: false, pressure: false },
            bomb_acc: 0.0,
            camp: 0.0,
            next_ship: 0.0,
            repair: 0.0,
            drop_later: 0,
            dt_last: 0.0,
            fall_t: 0.0,
            reach: None,
            wave_no: 0,
            next_id: 1,
            scratch: Vec::with_capacity(128),
        };
        g.set_layout(l);
        g
    }

    fn rand(&mut self, a: f64, b: f64) -> f64 {
        a + self.rng.f64() * (b - a)
    }

    fn random(&mut self) -> f64 {
        self.rng.f64()
    }

    /// Math.floor(Math.random() * n)
    fn pick_index(&mut self, n: usize) -> usize {
        ((self.rng.f64() * n as f64).floor() as usize).min(n.saturating_sub(1))
    }

    fn new_id(&mut self) -> u32 {
        self.next_id = self.next_id.wrapping_add(1);
        self.next_id
    }

    /// layout: the map (art px); a new layout restarts the game
    pub fn set_layout(&mut self, l: GameLayout) {
        self.l = l;
        let built = city::build_city(l.city_w, l.ah.max(0.0) as usize, l.s, &mut self.rng);
        let n = built.base.len();
        let img8 = built.img.as_chunks::<3>().0.iter().flat_map(|c| [byte(c[0]), byte(c[1]), byte(c[2]), 255]).collect();
        self.city = City {
            x0: l.city_x0,
            w: l.city_w,
            h: l.ah.max(0.0) as usize,
            s: l.s.max(1),
            alive: built.base.clone(),
            base: built.base,
            img: built.img,
            img8,
            img_w: built.img_w,
            lanes: built.lanes,
            lights: built.lights,
            core: built.core,
            conduit: built.conduit,
            dead: Vec::new(),
            dead_at: vec![-99.0; n],
            born: vec![-99.0; n],
            hit_at: -9.0,
            total: 0,
        };
        // hover gliders on the maglev streets (LED px along their lane)
        const CAR_COLORS: [Rgb; 4] = [[0.3, 0.95, 1.0], [1.0, 0.35, 0.85], [0.7, 0.55, 1.0], [0.9, 0.95, 1.0]];
        self.cars.clear();
        for li in 0..self.city.lanes.len() {
            let (from, len) = (self.city.lanes[li].from, self.city.lanes[li].to - self.city.lanes[li].from);
            let n = 1.0_f64.max(jr(len / 70.0)) as usize;
            for _ in 0..n {
                let pos = from + self.random() * len;
                let speed = self.rand(35.0, 70.0);
                let col = CAR_COLORS[self.pick_index(CAR_COLORS.len())];
                self.cars.push(Car { lane: li, pos, speed, col });
            }
        }
        self.footprints.clear();
        self.city.total = self.city.base.iter().filter(|&&t| t != 0).count();
        self.reset_all();
    }

    pub fn reset_all(&mut self) {
        self.level = 1;
        self.skill = 1.0;
        self.score = 0;
        self.clear_field();
        self.heal_city(1.0, true);
        self.players.clear();
        self.link_state.clear();
        self.empty_for = 0.0;
        self.dirty = false;
        self.start_wave();
    }

    fn clear_field(&mut self) {
        self.shots.clear();
        self.bullets.clear();
        self.divers.clear();
        self.particles.clear();
        self.booms.clear();
        self.waves.clear();
        self.links.clear();
        if self.ufo.is_some() {
            self.events.push(Ev::Ufo(false));
        }
        self.ufo = None;
        self.next_ufo = self.time + 18.0;
        self.pending.clear();
        self.bombs.clear();
        self.scorches.clear();
        if self.ship.is_some() {
            self.events.push(Ev::Beam(false));
        }
        self.ship = None;
        self.ship_death = None;
        self.beat_at = -9.0;
        self.items.clear();
        self.edge_lasers.clear();
        self.next_item = self.time + 10.0;
        self.enemy_slow_until = 0.0;
        self.edge_acc = 0.0;
        self.party = 0.0;
        self.alarm = 0.0;
    }

    /// the director's difficulty: wave and skill
    pub fn difficulty(&self) -> f64 {
        (1.0 + 0.1 * f64::from(self.level - 1)) * self.skill
    }

    fn crowd_n(&self) -> f64 {
        self.crowd.max(1.0)
    }

    /// alone it is easier: 0.65 with one person, 1 from three on
    fn ease(&self) -> f64 {
        0.65 + 0.35 * clamp((self.crowd_n() - 1.0) / 2.0, 0.0, 1.0)
    }

    fn start_wave(&mut self) {
        let l = self.l;
        let (p_rows, p_cols, p_ship_first) = if self.p_set { (self.p.rows, self.p.cols, self.p.ship_first) } else { (4.0, 3.0, 18.0) };
        let n = jr(self.crowd).max(1.0);
        let d = self.difficulty();
        let max_rows = ((l.ah - 6.0) / PY).floor().max(1.0);
        let rows = clamp(jr(p_rows) + ((n - 1.0) / 2.0).floor(), 2.0, max_rows) as usize;
        let cols = clamp(jr(p_cols) + ((n - 1.0) / 3.0).floor() + ((d - 1.0).max(0.0) * 1.5).floor(), 1.0, 6.0) as usize;
        let hp_mul = (0.75 + 0.25 * d) * (1.0 + 0.15 * (n - 1.0)) * (0.75 + 0.25 * self.ease());
        let height = rows as f64 * PY - (PY - SPRITE_H);
        let width = cols as f64 * PX;
        let fy = jr((l.ah - height) / 2.0);
        let t = self.time;
        self.wave_no = self.wave_no.wrapping_add(1);
        self.sides.clear();
        for edge in [-1.0_f64, 1.0] {
            let cnt = rows * cols;
            let mut side = Side {
                edge,
                dir_x: -edge,
                rows,
                cols,
                fx: if edge < 0.0 { 2.0 } else { l.aw - 2.0 - width },
                fy,
                ydir: if edge < 0.0 { 1.0 } else { -1.0 },
                alive: vec![1; cnt],
                hp: vec![0; cnt],
                hp_max: Vec::new(),
                flash: vec![-9.0; cnt],
                kick_x: vec![0.0; cnt],
                kick_y: vec![0.0; cnt],
                kick_at: vec![-9.0; cnt],
                shield: vec![0; cnt],
                shield_hit: vec![-9.0; cnt],
                charge: vec![-9.0; cnt],
                spawn: vec![0.0; cnt],
                count: cnt as i32,
                storm: None,
                in_storm: vec![false; cnt],
                storm_t: 0.0,
            };
            for i in 0..cnt {
                let c = i % cols;
                let r = i / cols;
                side.hp[i] = jr(hp_of(type_of(edge, cols, c)) * hp_mul).clamp(1.0, 255.0) as u8;
                // they warp in column by column, from the outside in
                let outer = if edge < 0.0 { c } else { cols - 1 - c };
                side.spawn[i] = (t + 0.5 + outer as f64 * 0.22 + r as f64 * 0.06 + self.random() * 0.05) as f32;
            }
            side.hp_max = side.hp.clone();
            // shields from wave 2 on: the front column first, more with difficulty
            let shield_chance = if self.level >= 2 { clamp(0.15 + (d - 1.0) * 0.5, 0.0, 0.7) } else { 0.0 };
            for i in 0..cnt {
                let outer = if edge < 0.0 { i % cols } else { cols - 1 - (i % cols) };
                if outer + 2 >= cols && self.random() < shield_chance {
                    side.shield[i] = 2 + u8::from(d > 1.6);
                }
            }
            self.sides.push(side);
        }
        self.total = rows * cols * 2;
        self.phase = Phase::Enter;
        self.phase_t = 0.0;
        self.beat_t = 0.0;
        self.beat = 0;
        self.frame_anim = 0;
        self.fire_acc = 0.0;
        self.dive_acc = 0.0;
        self.stats = Stats { t0: t, dead0: self.city.dead.len(), hits: 0.0, storms: 0, mercy: false, pressure: false };
        self.bomb_acc = 0.0;
        self.camp = 0.0;
        self.next_ship = t + p_ship_first * self.rand(0.9, 1.2);
        self.events.push(Ev::Enter);
    }

    // ---- geometry of the formations

    /// the box of invader i of a side
    pub fn bx(&self, si: usize, i: usize) -> Bx {
        let Some(side) = self.sides.get(si) else {
            return Bx { x: 0.0, y: 0.0, w: 0.0, h: 0.0, k: Kind::Octopus };
        };
        let c = i % side.cols.max(1);
        let r = i / side.cols.max(1);
        let k = type_of(side.edge, side.cols, c);
        let w = ART.frame(k, 0).w as f64;
        // they dance
        let bob = if self.phase == Phase::Fall { jr((self.time * 9.0 + c as f64 * 1.3 + r as f64).sin() * 1.5) } else { 0.0 };
        Bx { x: jr(side.fx + c as f64 * PX + (PX - w) / 2.0), y: jr(side.fy + r as f64 * PY) + bob, w, h: SPRITE_H, k }
    }

    /// is invader i there (alive, warped in, not storming)?
    pub fn present(&self, si: usize, i: usize) -> bool {
        let Some(s) = self.sides.get(si) else { return false };
        s.alive.get(i).is_some_and(|&a| a != 0) && s.spawn.get(i).is_some_and(|&v| self.time >= f64::from(v)) && !s.in_storm.get(i).copied().unwrap_or(false)
    }

    /// minY, maxY, front of the living invaders of a side
    fn bounds(&self, si: usize) -> (f64, f64, f64) {
        let Some(side) = self.sides.get(si) else { return (1e9, -1e9, 0.0) };
        let mut min_y = 1e9_f64;
        let mut max_y = -1e9_f64;
        let mut front = if side.dir_x > 0.0 { -1e9_f64 } else { 1e9 };
        for i in 0..side.n() {
            if side.alive[i] == 0 {
                continue;
            }
            let b = self.bx(si, i);
            min_y = min_y.min(b.y);
            max_y = max_y.max(b.y + b.h);
            front = if side.dir_x > 0.0 { front.max(b.x + b.w) } else { front.min(b.x) };
        }
        (min_y, max_y, front)
    }

    /// every target: formation invaders, divers, the mothership, the battleship; f returns false to stop
    pub fn for_targets(&self, mut f: impl FnMut(Target, f64, f64, f64, f64) -> bool) {
        for (si, side) in self.sides.iter().enumerate() {
            if side.count == 0 {
                continue;
            }
            for i in 0..side.n() {
                if !self.present(si, i) {
                    continue;
                }
                let b = self.bx(si, i);
                if !f(Target::Inv { wave_no: self.wave_no, side: si, i }, b.x, b.y, b.w, b.h) {
                    return;
                }
            }
        }
        for d in &self.divers {
            if !f(Target::Diver(d.id), d.x - 5.5, d.y - 4.5, 11.0, 9.0) {
                return;
            }
        }
        if let Some(u) = &self.ufo
            && !f(Target::Ufo(u.id), u.x, u.y, UFO_W, UFO_H)
        {
            return;
        }
        if let Some(s) = &self.ship {
            f(Target::Ship(s.id), s.x, s.y, SHIP_W, SHIP_H);
        }
    }

    fn target_at(&self, x: f64, y: f64, pad: f64) -> Option<Target> {
        let mut hit = None;
        self.for_targets(|tg, bx, by, bw, bh| {
            if x >= bx - pad && x < bx + bw + pad && y >= by - pad && y < by + bh + pad {
                hit = Some(tg);
                return false;
            }
            true
        });
        hit
    }

    /// where a target is now (its center), or None when it is gone
    pub fn target_pos(&self, tg: Option<Target>) -> Option<[f64; 2]> {
        match tg? {
            Target::Ufo(id) => self.ufo.as_ref().filter(|u| u.id == id).map(|u| [u.x + UFO_W / 2.0, u.y + UFO_H / 2.0]),
            Target::Ship(id) => self.ship.as_ref().filter(|s| s.id == id).map(|s| [s.x + SHIP_W / 2.0, s.y + SHIP_H / 2.0]),
            Target::Diver(id) => self.divers.iter().find(|d| d.id == id).map(|d| [d.x, d.y]),
            Target::Inv { wave_no, side, i } => {
                if wave_no != self.wave_no || !self.present(side, i) {
                    return None;
                }
                let b = self.bx(side, i);
                Some([b.x + b.w / 2.0, b.y + b.h / 2.0])
            }
        }
    }

    /// aim assist: the target closest to the direction dir from (x, y), within cone (rad)
    fn lock_on(&self, x: f64, y: f64, dir: [f64; 2], cone: f64) -> Option<Target> {
        let mut best = None;
        let mut best_score = f64::INFINITY;
        let aw = self.l.aw;
        self.for_targets(|tg, bx, by, bw, bh| {
            let dx = bx + bw / 2.0 - x;
            let dy = by + bh / 2.0 - y;
            let d = dx.hypot(dy);
            if d < 1.0 {
                return true;
            }
            let ang = clamp((dx * dir[0] + dy * dir[1]) / d, -1.0, 1.0).acos();
            if ang > cone {
                return true;
            }
            let score = ang + (d / aw) * 0.6 - if matches!(tg, Target::Diver(_)) { 0.3 } else { 0.0 }; // divers first
            if score < best_score {
                best_score = score;
                best = Some(tg);
            }
            true
        });
        best
    }

    /// automatic fire: the nearest target within range (m); divers count double near
    fn nearest(&self, x: f64, y: f64, range: f64) -> Option<Target> {
        let (sx, sy) = (self.l.sx, self.l.sy);
        let mut best = None;
        let mut bd = range;
        self.for_targets(|tg, bx, by, bw, bh| {
            let d = ((bx + bw / 2.0 - x) / sx).hypot((by + bh / 2.0 - y) / sy) * if matches!(tg, Target::Diver(_)) { 0.6 } else { 1.0 };
            if d < bd {
                bd = d;
                best = Some(tg);
            }
            true
        });
        best
    }

    // ---- effects

    #[allow(clippy::too_many_arguments)]
    fn burst(&mut self, x: f64, y: f64, n: usize, col: Rgb, speed: f64, life: f64, col2: Option<Rgb>) {
        for _ in 0..n {
            let a = self.random() * PI * 2.0;
            let v = speed * (0.3 + self.random() * 0.9);
            let c = match col2 {
                Some(c2) if self.random() < 0.4 => c2,
                _ => col,
            };
            let life = life * self.rand(0.6, 1.2);
            self.particles.push(Particle { x, y, vx: a.cos() * v, vy: a.sin() * v, col: c, t0: self.time, life });
        }
    }

    /// a sprite goes to pieces: its own pixels fly apart, away from where the hit came from
    #[allow(clippy::too_many_arguments)]
    fn shatter(&mut self, x0: f64, y0: f64, k: Kind, col: Rgb, col2: Rgb, push: Option<[f64; 2]>, power: f64) {
        let f = ART.frame(k, self.frame_anim);
        let cx = x0 + f.w as f64 / 2.0;
        let cy = y0 + f.h as f64 / 2.0;
        for j in 0..f.h {
            for i in 0..f.w {
                if !f.at(i, j) {
                    continue;
                }
                let dx = x0 + i as f64 - cx + self.rand(-1.5, 1.5);
                let dy = y0 + j as f64 - cy + self.rand(-1.5, 1.5);
                let v = self.rand(10.0, 38.0) * power;
                let d = match dx.hypot(dy) {
                    d if d > 0.0 => d,
                    _ => 1.0,
                };
                let px = match push {
                    Some(p) => p[0] * self.rand(12.0, 40.0),
                    None => 0.0,
                };
                let py = match push {
                    Some(p) => p[1] * self.rand(12.0, 40.0),
                    None => 0.0,
                };
                let c = if self.random() < 0.35 { col2 } else { col };
                let life = self.rand(0.5, 1.2);
                self.particles.push(Particle { x: x0 + i as f64, y: y0 + j as f64, vx: (dx / d) * v + px, vy: (dy / d) * v + py, col: c, t0: self.time, life });
            }
        }
        self.booms.push(Boom { x: cx, y: cy, t0: self.time, col: WHITE, warp: false, splat: false });
    }

    /// combo of a person: kills in quick succession
    fn combo(&mut self, slot: u8) -> i32 {
        let t = self.time;
        let mut combo = 0;
        for (_, s) in self.players.iter_mut() {
            if s.slot != slot {
                continue;
            }
            s.combo = if t - s.last_kill < 0.9 { s.combo + 1 } else { 0 };
            s.last_kill = t;
            combo = s.combo;
        }
        combo
    }

    /// a hit on a target: damage; white flash and a tick, destroyed at 0 hit points
    #[allow(clippy::too_many_arguments)]
    fn damage(&mut self, tg: Target, amount: f64, slot: u8, col: Rgb, inv: InvCol, push: Option<[f64; 2]>) {
        let t = self.time;
        match tg {
            Target::Ufo(_) => self.kill_ufo(col),
            Target::Ship(id) => self.damage_ship(id, amount, col),
            Target::Diver(id) => {
                let Some(di) = self.divers.iter().position(|d| d.id == id) else { return };
                let d = &mut self.divers[di];
                d.hp -= amount;
                d.flash = t;
                if d.hp > 0.0 {
                    self.events.push(Ev::Ping);
                    return;
                }
                let d = self.divers.remove(di);
                self.explode_diver(&d, Some(col), slot, inv);
            }
            Target::Inv { wave_no, side: si, i } => {
                if wave_no != self.wave_no || !self.sides.get(si).is_some_and(|s| s.alive.get(i).is_some_and(|&a| a != 0)) {
                    return;
                }
                let b = self.bx(si, i);
                let cx = b.x + b.w / 2.0;
                let cy = b.y + b.h / 2.0;
                let side = &mut self.sides[si];
                // knocked back a little, away from the hit
                match push {
                    Some(p) => {
                        let kd = match p[0].hypot(p[1]) {
                            d if d > 0.0 => d,
                            _ => 1.0,
                        };
                        side.kick_x[i] = ((p[0] / kd) * 2.0) as f32;
                        side.kick_y[i] = ((p[1] / kd) * 2.0) as f32;
                    }
                    None => {
                        side.kick_x[i] = (side.dir_x * -2.0) as f32;
                        side.kick_y[i] = 0.0;
                    }
                }
                side.kick_at[i] = t as f32;
                // a shield takes the hits first
                if side.shield[i] > 0 && amount < 9.0 {
                    side.shield[i] -= 1;
                    side.shield_hit[i] = t as f32;
                    let broken = side.shield[i] == 0;
                    self.burst(cx, cy, if broken { 26 } else { 6 }, SHIELD, if broken { 45.0 } else { 25.0 }, if broken { 0.6 } else { 0.25 }, Some(WHITE));
                    self.fx.light(cx, cy, if broken { 0.6 } else { 0.35 }, if broken { 2.0 } else { 1.0 }, SHIELD, if broken { 0.3 } else { 0.12 });
                    self.events.push(if broken { Ev::ShieldBreak } else { Ev::Shield });
                    return;
                }
                if f64::from(side.hp[i]) > amount {
                    side.hp[i] = (f64::from(side.hp[i]) - amount) as u8;
                    side.flash[i] = t as f32;
                    let (px, py) = push.map_or((0.0, 0.0), |p| (p[0], p[1]));
                    self.burst(cx - px * 4.0, cy - py * 3.0, 5, WHITE, 22.0, 0.25, Some(col));
                    self.fx.light(cx, cy, 0.3, 0.9, WHITE, 0.1);
                    self.events.push(Ev::Ping);
                    return;
                }
                side.alive[i] = 0;
                side.count -= 1;
                self.score += points(b.k);
                self.dirty = true;
                let combo = self.combo(slot);
                let icol = inv.of(b.k);
                let c8 = f64::from(combo.min(8));
                self.shatter(b.x, b.y, b.k, icol, col, push, 1.0 + c8 * 0.08);
                self.fx.light(cx, cy, 0.6 + c8 * 0.05, 1.8, icol, 0.35);
                self.fx.light(cx, cy, 0.25, 2.5, WHITE, 0.08);
                if combo >= 4 {
                    self.fx.ripple(cx, cy, 2.0 + f64::from(combo) * 0.3, 5.0, 0.4);
                }
                self.fx.kick(0.5 + f64::from(combo.min(6)) * 0.1, 0.0);
                self.events.push(Ev::Kill(combo));
            }
        }
    }

    fn explode_diver(&mut self, d: &Diver, col: Option<Rgb>, slot: u8, inv: InvCol) {
        let icol = inv.of(d.k);
        self.shatter(d.x - 5.5, d.y - 4.5, d.k, icol, col.unwrap_or(RED), None, 1.4);
        self.burst(d.x, d.y, 20, ORANGE, 45.0, 0.6, Some(WHITE));
        self.fx.light(d.x, d.y, 0.9, 2.2, ORANGE, 0.4);
        self.fx.ripple(d.x, d.y, 3.0, 5.0, 0.45);
        self.fx.kick(1.0, 0.0);
        if slot != 0 {
            if self.random() < 0.08 {
                self.drop_later += 1;
            }
            self.score += 50;
            let combo = self.combo(slot);
            self.events.push(Ev::Kill(combo));
        } else {
            self.events.push(Ev::Crash);
        }
    }

    fn kill_ufo(&mut self, col: Rgb) {
        let Some(u) = self.ufo.take() else { return };
        self.score += 100 + 50 * (self.random() * 5.0).floor() as i64;
        let (cx, cy) = (u.x + UFO_W / 2.0, u.y + UFO_H / 2.0);
        self.shatter(u.x, u.y, Kind::Ufo, RED, col, None, 2.0);
        self.burst(cx, cy, 80, WHITE, 80.0, 1.3, Some(col));
        self.burst(cx, cy, 40, ORANGE, 50.0, 1.0, Some(RED));
        self.party = self.time + 1.5;
        // the reward: the city is repaired
        self.repair += jr(self.city.total as f64 * 0.18);
        self.fx.flash(WHITE, 0.35);
        self.fx.kick(3.0, 1.6);
        self.fx.ripple(cx, cy, 9.0, 7.0, 1.0);
        self.fx.light(cx, cy, 2.2, 3.0, RED, 0.8);
        self.fx.slow(0.6, 0.25);
        self.events.push(Ev::Ufo(false));
        self.events.push(Ev::UfoKill);
        self.drop_later += 1;
    }

    // ---- the city

    pub fn city_at(&self, x: f64, y: f64) -> bool {
        let c = &self.city;
        let i = x.floor() - c.x0;
        let j = y.floor();
        if !(i >= 0.0 && j >= 0.0 && i < c.w as f64 && j < c.h as f64) {
            return false;
        }
        c.alive.get(j as usize * c.w + i as usize).is_some_and(|&a| a > 0)
    }

    fn erode(&mut self, x: f64, y: f64, r: f64) -> usize {
        let mut n = 0;
        let big_r = r.ceil() as i64;
        for j in -big_r..=big_r {
            for i in -big_r..=big_r {
                let d = (i as f64).hypot(j as f64);
                if d > r || self.random() < (d / r).powi(2) * 0.8 {
                    continue;
                }
                let c = &mut self.city;
                let cx = x.floor() - c.x0 + i as f64;
                let cy = y.floor() + j as f64;
                if !(cx >= 0.0 && cy >= 0.0 && cx < c.w as f64 && cy < c.h as f64) {
                    continue;
                }
                let k = cy as usize * c.w + cx as usize;
                if c.alive.get(k).is_none_or(|&a| a == 0) {
                    continue;
                }
                c.alive[k] = 0;
                c.dead_at[k] = self.time as f32;
                c.dead.push(k);
                n += 1;
            }
        }
        if n > 0 {
            self.dirty = true;
            self.city.hit_at = self.time;
        }
        n
    }

    /// the city grows back: n cells (random order, so it looks like building)
    fn regrow(&mut self, n: f64) {
        let mut n = n;
        while n > 0.0 && !self.city.dead.is_empty() {
            n -= 1.0;
            let j = self.pick_index(self.city.dead.len());
            let c = &mut self.city;
            let k = c.dead.swap_remove(j);
            if c.alive.get(k).is_none_or(|&a| a != 0) {
                continue;
            }
            c.alive[k] = c.base[k];
            c.born[k] = self.time as f32;
        }
    }

    /// heal a part of what is missing (now: at once, else queued and built up over time)
    fn heal_city(&mut self, fraction: f64, now: bool) {
        let n = jr(self.city.dead.len() as f64 * fraction);
        if now {
            self.regrow(n);
        } else {
            self.repair += n;
        }
    }

    pub fn city_health(&self) -> f64 {
        let c = &self.city;
        if c.total > 0 { 1.0 - c.dead.len() as f64 / c.total as f64 } else { 1.0 }
    }

    // ---- players

    pub fn state_index(&self, id: u32) -> Option<usize> {
        self.players.iter().position(|(pid, _)| *pid == id)
    }

    pub fn state_of(&self, id: u32) -> Option<&PState> {
        self.players.iter().find(|(pid, _)| *pid == id).map(|(_, s)| s)
    }

    fn state(&mut self, u: &Unit) -> usize {
        let i = match self.state_index(u.id) {
            Some(i) => i,
            None => {
                self.players.push((u.id, PState::new(u.slot, self.time)));
                self.players.len() - 1
            }
        };
        let t = self.time;
        let s = &mut self.players[i].1;
        s.slot = u.slot;
        s.seen = t;
        // arms that fired more than a few s ago are as good as never (bounded map)
        s.fire.retain(|f| t - f.1 < 5.0);
        i
    }

    fn hit_player(&mut self, si: usize, x: f64, y: f64) {
        let t = self.time;
        let stun = self.p.stun;
        let Some((_, s)) = self.players.get_mut(si) else { return };
        if t < s.stun_until {
            return;
        }
        if s.power.shield > 0 && t < s.power.shield_until {
            s.power.shield -= 1;
            s.shield_hit = t;
            self.burst(x, y, 14, Power::Shield.color(), 35.0, 0.4, Some(WHITE));
            self.fx.light(x, y, 0.5, 1.6, Power::Shield.color(), 0.2);
            self.events.push(Ev::Shield);
            return;
        }
        s.hit_at = t;
        s.stun_until = t + stun;
        s.combo = 0;
        self.stats.hits += 1.0;
        self.burst(x, y, 22, RED, 34.0, 0.6, Some(WHITE));
        self.fx.light(x, y, 0.8, 2.0, RED, 0.35);
        self.fx.kick(1.2, 0.6);
        self.fx.ripple(x, y, 2.5, 4.0, 0.4);
        self.events.push(Ev::Hit);
    }

    /// a shot of unit u (state si) from `from` in `dir`, homing in on target
    fn fire(&mut self, u: &Unit, si: usize, from: [f64; 2], dir: [f64; 2], target: Option<Target>) {
        let v = self.p.laser_speed * self.l.sx;
        let mut d = dir;
        if let Some(at) = self.target_pos(target) {
            let dx = at[0] - from[0];
            let dy = at[1] - from[1];
            let n = match dx.hypot(dy) {
                n if n > 0.0 => n,
                _ => 1.0,
            };
            d = [dx / n, dy / n];
        }
        let (boosted, spread) = match self.players.get(si) {
            Some((_, s)) => (s.boost.active, self.time < s.power.spread),
            None => (false, false),
        };
        let k = if boosted { 1.2 } else { 1.0 };
        self.shots.push(Shot {
            x: from[0],
            y: from[1],
            vx: d[0] * v * k,
            vy: d[1] * v * k,
            col: u.col,
            slot: u.slot,
            target,
            dmg: if boosted { self.p.boost_damage } else { 1.0 },
            big: boosted,
        });
        // the fan: two more, 14 degrees to each side
        if spread {
            for a in [-0.25_f64, 0.25] {
                let (sn, c) = a.sin_cos();
                self.shots.push(Shot {
                    x: from[0],
                    y: from[1],
                    vx: (d[0] * c - d[1] * sn) * v,
                    vy: (d[0] * sn + d[1] * c) * v,
                    col: Power::Spread.color(),
                    slot: u.slot,
                    target: None,
                    dmg: 1.0,
                    big: false,
                });
            }
        }
        self.events.push(Ev::Laser);
    }

    fn fortified(&self, id: u32) -> bool {
        self.state_of(id).is_some_and(|s| s.fortified)
    }

    /// a person to aim at: forts first with probability `fort_share`
    fn pick_target(&mut self, people: &[Unit], fort_share: f64) -> Option<usize> {
        if people.is_empty() {
            return None;
        }
        let forts: Vec<usize> = (0..people.len()).filter(|&i| self.fortified(people[i].id)).collect();
        if !forts.is_empty() && self.random() < fort_share {
            let k = self.pick_index(forts.len());
            return forts.get(k).copied();
        }
        Some(self.pick_index(people.len()))
    }

    // ---- the invaders' attacks

    fn enemy_shot(&mut self, people: &[Unit], speed: f64, aimed_share: f64) {
        let sides: Vec<usize> = (0..self.sides.len()).filter(|&i| self.sides[i].count != 0 && self.sides[i].storm.is_none()).collect();
        if sides.is_empty() {
            return;
        }
        let si = sides[self.pick_index(sides.len())];
        // aim at somebody's row most of the time; forts first (they stand still)
        let mut target: Option<usize> = None;
        if !people.is_empty() && self.random() < 0.75 {
            target = self.pick_target(people, 0.7);
        }
        let (rows, cols, fy, dir_x) = {
            let s = &self.sides[si];
            (s.rows, s.cols, s.fy, s.dir_x)
        };
        let mut rows_alive = Vec::with_capacity(rows);
        for r in 0..rows {
            if (0..cols).any(|c| self.present(si, r * cols + c)) {
                rows_alive.push(r);
            }
        }
        if rows_alive.is_empty() {
            return;
        }
        let mut row = match target.and_then(|ti| people.get(ti)) {
            Some(tp) => clamp(jr((tp.center[1] - fy - SPRITE_H / 2.0) / PY), 0.0, (rows - 1) as f64) as usize,
            None => rows_alive[self.pick_index(rows_alive.len())],
        };
        if !rows_alive.contains(&row) {
            let mut best = rows_alive[0];
            for &b in &rows_alive[1..] {
                if (b as f64 - row as f64).abs() < (best as f64 - row as f64).abs() {
                    best = b;
                }
            }
            row = best;
        }
        // the front-most invader of that row fires
        let mut best: Option<usize> = None;
        for c in 0..cols {
            let i = row * cols + c;
            if !self.present(si, i) {
                continue;
            }
            let better = match best {
                None => true,
                Some(b) => {
                    if dir_x > 0.0 {
                        c > b % cols
                    } else {
                        c < b % cols
                    }
                }
            };
            if better {
                best = Some(i);
            }
        }
        let Some(best) = best else { return };
        // announced: the eyes glow red for a moment, then it fires (some aimed straight at a person)
        if f64::from(self.sides[si].charge[best]) > self.time {
            return;
        }
        let aimed = target.is_some() && self.random() < aimed_share;
        let at = self.time + self.p.telegraph;
        self.sides[si].charge[best] = at as f32;
        let target_id = target.and_then(|ti| people.get(ti)).map(|u| u.id);
        self.pending.push(Pending { wave_no: self.wave_no, side: si, i: best, at, aimed, target_id, speed });
    }

    /// the announced shots that are due
    fn fire_pending(&mut self, people: &[Unit]) {
        let t = self.time;
        let mut pending = std::mem::take(&mut self.pending);
        pending.retain(|q| {
            if q.at > t {
                return true;
            }
            if q.wave_no != self.wave_no {
                return false;
            }
            if let Some(c) = self.sides.get_mut(q.side).and_then(|s| s.charge.get_mut(q.i)) {
                *c = -9.0;
            }
            if !self.present(q.side, q.i) {
                return false;
            }
            let b = self.bx(q.side, q.i);
            let dir_x = self.sides[q.side].dir_x;
            let x = if dir_x > 0.0 { b.x + b.w + 1.0 } else { b.x - 1.0 };
            let y = b.y + 4.0;
            let target = if q.aimed { q.target_id.and_then(|id| people.iter().find(|u| u.id == id)) } else { None };
            let anim = self.random() * 4.0;
            match target {
                Some(tp) => {
                    let dx = tp.center[0] - x;
                    let dy = tp.center[1] - y;
                    let d = match dx.hypot(dy) {
                        d if d > 0.0 => d,
                        _ => 1.0,
                    };
                    self.bullets.push(Bullet { x, y, vx: (dx / d) * q.speed * 0.9, vy: (dy / d) * q.speed * 0.9, aimed: true, anim });
                }
                None => self.bullets.push(Bullet { x, y, vx: dir_x * q.speed, vy: 0.0, aimed: false, anim }),
            }
            self.fx.light(x, y, 0.3, 1.2, [1.0, 0.4, 0.2], 0.12);
            false
        });
        self.pending.append(&mut pending);
    }

    // ---- bombs: a squid lobs a mine at a person; it lands, pulses and explodes

    fn spawn_bomb(&mut self, people: &[Unit]) {
        let Some(ti) = self.pick_target(people, 0.6) else { return };
        let Some(target) = people.get(ti) else { return };
        let sides: Vec<usize> = (0..self.sides.len()).filter(|&i| self.sides[i].count != 0 && self.sides[i].storm.is_none()).collect();
        if sides.is_empty() {
            return;
        }
        let si = sides[self.pick_index(sides.len())];
        let (n, cols, edge) = (self.sides[si].n(), self.sides[si].cols, self.sides[si].edge);
        let mut from: Option<usize> = None;
        for i in 0..n {
            if from.is_some() {
                break;
            }
            let outer = if edge < 0.0 { i % cols } else { cols - 1 - (i % cols) };
            if outer == 0 && self.present(si, i) && self.random() < 0.5 {
                from = Some(i);
            }
        }
        let Some(from) = from else { return };
        let b = self.bx(si, from);
        let l = self.l;
        let tx = target.center[0] + self.rand(-0.15, 0.15) * l.sx;
        let ty = target.center[1] + self.rand(-0.15, 0.15) * l.sy;
        let (x, y) = (b.x + b.w / 2.0, b.y + 4.0);
        self.bombs.push(Bomb { x0: x, y0: y, x, y, tx, ty, t0: self.time, flight: 0.9, fuse: self.p.bomb_fuse, r: 0.45, landed: false, beep: 0.0 });
        self.events.push(Ev::BombThrow);
    }

    fn update_bombs(&mut self, people: &[Unit], by_slot: &[Option<usize>; SLOTS]) {
        let t = self.time;
        let l = self.l;
        let mut bombs = std::mem::take(&mut self.bombs);
        bombs.retain_mut(|bm| {
            let u = (t - bm.t0) / bm.flight;
            if u < 1.0 {
                bm.x = bm.x0 + (bm.tx - bm.x0) * u;
                bm.y = bm.y0 + (bm.ty - bm.y0) * u;
                return true;
            }
            if !bm.landed {
                bm.landed = true;
                bm.x = bm.tx;
                bm.y = bm.ty;
                self.fx.light(bm.x, bm.y, 0.4, 1.2, RED, 0.2);
                self.events.push(Ev::BombLand);
            }
            let left = bm.t0 + bm.flight + bm.fuse - t;
            if left > 0.0 {
                // beeps faster and faster
                bm.beep -= self.dt_last;
                if bm.beep <= 0.0 {
                    bm.beep = (left * 0.3).max(0.08);
                    self.events.push(Ev::BombBeep);
                }
                return true;
            }
            // boom
            let rx = bm.r * l.sx;
            let ry = bm.r * l.sy;
            for p in people {
                let [cx, cy] = p.center;
                if ((cx - bm.x) / rx).powi(2) + ((cy - bm.y) / ry).powi(2) <= 1.0
                    && let Some(si) = by_slot.get(usize::from(p.slot)).copied().flatten().and_then(|ui| people.get(ui)).and_then(|w| self.state_index(w.id))
                {
                    self.hit_player(si, cx, cy);
                }
            }
            let c = &self.city;
            if bm.x > c.x0 - rx && bm.x < c.x0 + c.w as f64 + rx {
                self.erode(bm.x, bm.y, bm.r * l.sy * 1.2);
            }
            self.burst(bm.x, bm.y, 40, ORANGE, 60.0, 0.8, Some(RED));
            self.booms.push(Boom { x: bm.x, y: bm.y, t0: t, col: ORANGE, warp: false, splat: false });
            self.fx.light(bm.x, bm.y, bm.r * 2.2, 3.0, ORANGE, 0.45);
            self.fx.ripple(bm.x, bm.y, 5.0, 5.0, 0.5);
            self.fx.kick(1.6, 0.4);
            self.events.push(Ev::Bomb);
            false
        });
        bombs.append(&mut self.bombs);
        self.bombs = bombs;
    }

    // ---- the battleship

    fn spawn_ship(&mut self) {
        let l = self.l;
        let n = self.crowd_n();
        let d = self.difficulty();
        let from_left = self.random() < 0.5;
        let ease = self.ease();
        let hp = jr(self.p.ship_hp * (0.6 + 0.4 * n) * (0.8 + 0.2 * d) * ease);
        let id = self.new_id();
        self.ship = Some(Ship {
            id,
            x: if from_left { -SHIP_W - 2.0 } else { l.aw + 2.0 },
            y: 1.0,
            hp,
            hp_max: hp,
            state: ShipState::Aim,
            state_t: 0.0,
            shots: jr((2.0 + n / 2.0 + (d - 1.0) * 2.0) * ease).max(1.0),
            beam_x: 0.0,
            target_x: l.aw / 2.0,
            flash: -9.0,
        });
        self.events.push(Ev::ShipEnter);
        self.fx.flash(BEAM, 0.08);
    }

    /// where the ship aims next: a person standing still first (forts), else anyone
    fn ship_target(&mut self, people: &[Unit]) -> f64 {
        match self.pick_target(people, 0.7).and_then(|i| people.get(i)) {
            Some(p) => p.center[0],
            None => self.l.aw / 2.0,
        }
    }

    fn update_ship(&mut self, people: &[Unit], by_slot: &[Option<usize>; SLOTS], inv: InvCol, dt: f64) {
        let Some(mut sh) = self.ship.take() else { return };
        let t = self.time;
        let l = self.l;
        let d = self.difficulty();
        let ship_charge = self.p.ship_charge;
        let beam_width = self.p.beam_width;
        sh.state_t += dt;
        let cx = sh.x + SHIP_W / 2.0;
        let speed = 1.8 * l.sx;
        let move_to = |sh: &mut Ship, x: f64| {
            let dd = x - cx;
            sh.x += clamp(dd, -speed * dt, speed * dt);
            dd.abs() < 1.0
        };
        let mut keep = true;
        match sh.state {
            ShipState::Aim => {
                if sh.state_t < dt * 1.5 {
                    sh.target_x = self.ship_target(people);
                }
                let tx = sh.target_x;
                if (move_to(&mut sh, tx) && sh.state_t > 0.4) || sh.state_t > 3.0 {
                    sh.state = ShipState::Charge;
                    sh.state_t = 0.0;
                    sh.beam_x = cx;
                    self.events.push(Ev::Charge);
                }
            }
            ShipState::Charge => {
                let dur = ship_charge / (0.9 + 0.1 * d);
                // sparks are sucked into the emitter
                let ex = cx;
                let ey = sh.y + SHIP_H;
                if self.random() < dt * 40.0 {
                    let a = self.random() * PI * 2.0;
                    let r = self.rand(10.0, 22.0);
                    let x = ex + a.cos() * r;
                    let y = ey + a.sin() * r * 0.6;
                    let col = if self.random() < 0.5 { WHITE } else { BEAM };
                    self.particles.push(Particle { x, y, vx: (ex - x) * 2.2, vy: (ey - y) * 2.2, col, t0: t, life: 0.45 });
                }
                if sh.state_t >= dur {
                    sh.state = ShipState::Fire;
                    sh.state_t = 0.0;
                    self.fx.flash(BEAM, 0.18);
                    self.fx.kick(2.5, 1.2);
                    self.fx.ripple(ex, ey, 6.0, 6.0, 0.6);
                    self.events.push(Ev::Beam(true));
                }
            }
            ShipState::Fire => {
                let dur = 1.1;
                let half = (beam_width * l.sx) / 2.0;
                let x0 = sh.beam_x - half;
                let x1 = sh.beam_x + half;
                let y0 = sh.y + SHIP_H - 1.0;
                self.fx.kick(1.3, 0.5);
                // everything in it burns: people, invaders, bullets, mines, the city
                let stun = self.p.stun;
                for p in people {
                    let body_half = 0.12 * l.sx;
                    if p.center[0] + body_half > x0 && p.center[0] - body_half < x1 {
                        let who = by_slot.get(usize::from(p.slot)).copied().flatten().and_then(|ui| people.get(ui)).and_then(|w| self.state_index(w.id));
                        if let Some(si) = who
                            && t >= self.players[si].1.stun_until
                        {
                            self.hit_player(si, p.center[0], p.center[1]);
                            self.players[si].1.stun_until = t + stun * 1.6;
                        }
                    }
                }
                // (the ship is taken out of self while it updates: it does not burn itself)
                let mut burned = std::mem::take(&mut self.scratch);
                burned.clear();
                self.for_targets(|tg, bx, by, bw, _| {
                    if matches!(tg, Target::Ship(_) | Target::Ufo(_)) {
                        return true;
                    }
                    if bx + bw > x0 && bx < x1 && by + 8.0 > y0 {
                        burned.push((tg, 0.0, 0.0, 0.0, 0.0));
                    }
                    true
                });
                for &(tg, ..) in &burned {
                    self.damage(tg, 99.0, 0, BEAM, inv, None);
                }
                self.scratch = burned;
                self.bullets.retain(|b| b.x < x0 || b.x > x1);
                self.bombs.retain(|b| b.x < x0 || b.x > x1);
                let (cx0, cw, ch) = (self.city.x0, self.city.w, self.city.h);
                let xa = cx0.max(x0.floor());
                let xb = (cx0 + cw as f64).min(x1.ceil());
                let mut x = xa;
                while x < xb {
                    for y in 0..ch {
                        let k = y * cw + (x - cx0) as usize;
                        if self.city.alive.get(k).is_none_or(|&a| a == 0) || self.random() > dt * 2.5 {
                            continue;
                        }
                        let c = &mut self.city;
                        c.alive[k] = 0;
                        c.dead_at[k] = t as f32;
                        c.dead.push(k);
                        c.hit_at = t;
                    }
                    x += 1.0;
                }
                // sparks spray off the beam's edges
                for _ in 0..3 {
                    let y = self.rand(y0, l.ah);
                    let side = if self.random() < 0.5 { -1.0 } else { 1.0 };
                    let vx = side * self.rand(20.0, 70.0);
                    let vy = self.rand(-15.0, 15.0);
                    let col = if self.random() < 0.5 { WHITE } else { BEAM };
                    let life = self.rand(0.25, 0.6);
                    self.particles.push(Particle { x: sh.beam_x + side * half, y, vx, vy, col, t0: t, life });
                }
                if sh.state_t >= dur {
                    self.scorches.push(Scorch { x: sh.beam_x, w: half * 2.0, y0, t0: t });
                    self.events.push(Ev::Beam(false));
                    sh.shots -= 1.0;
                    sh.state = if sh.shots > 0.0 && self.phase == Phase::Fight { ShipState::Aim } else { ShipState::Leave };
                    sh.state_t = 0.0;
                }
            }
            ShipState::Leave => {
                let out = if cx < l.aw / 2.0 { -SHIP_W } else { l.aw + SHIP_W };
                if move_to(&mut sh, out) {
                    keep = false;
                    let r = self.rand(0.8, 1.2);
                    self.next_ship = t + self.p.ship_every * r / d.max(0.7).powf(0.5);
                }
            }
        }
        // (it was taken out while it updated: nothing else could hit or replace it meanwhile)
        if keep {
            self.ship = Some(sh);
        }
    }

    fn damage_ship(&mut self, id: u32, amount: f64, col: Rgb) {
        if self.ship_death.is_some() {
            return;
        }
        let Some(sh) = self.ship.as_mut().filter(|s| s.id == id) else { return };
        sh.hp -= amount;
        sh.flash = self.time;
        let (dead, firing, sx, sy) = (sh.hp <= 0.0, sh.state == ShipState::Fire, sh.x, sh.y);
        let x = sx + SHIP_W / 2.0 + self.rand(-SHIP_W / 3.0, SHIP_W / 3.0);
        let y = sy + self.rand(3.0, SHIP_H - 3.0);
        self.burst(x, y, 6, WHITE, 30.0, 0.3, Some(col));
        self.fx.light(x, y, 0.35, 1.2, col, 0.1);
        self.events.push(Ev::Ping);
        if !dead {
            return;
        }
        // it goes down: explosions along the hull, then the big one
        self.ship_death = Some(ShipDeath { x: sx, y: sy, t0: self.time, next: 0.0, done: false });
        if firing {
            self.events.push(Ev::Beam(false));
        }
        self.ship = None;
        self.score += 1000;
        self.fx.slow(1.2, 0.2);
        self.fx.flash(WHITE, 0.25);
        self.events.push(Ev::ShipHit);
    }

    fn update_ship_death(&mut self, dt: f64) {
        let Some(mut d) = self.ship_death.take() else { return };
        let t = self.time;
        d.next -= dt;
        let age = t - d.t0;
        if age < 1.0 && d.next <= 0.0 {
            d.next = self.rand(0.05, 0.11);
            let x = d.x + self.rand(2.0, SHIP_W - 2.0);
            let y = d.y + self.rand(2.0, SHIP_H - 2.0);
            self.burst(x, y, 24, ORANGE, 50.0, 0.7, Some(WHITE));
            self.booms.push(Boom { x, y, t0: t, col: ORANGE, warp: false, splat: false });
            let r = self.rand(0.6, 1.1);
            let col = if self.random() < 0.5 { ORANGE } else { BEAM };
            self.fx.light(x, y, r, 2.5, col, 0.4);
            self.fx.kick(2.0, 0.8);
            self.events.push(Ev::Crash);
        }
        if age >= 1.0 && !d.done {
            d.done = true;
            let cx = d.x + SHIP_W / 2.0;
            let cy = d.y + SHIP_H / 2.0;
            self.shatter(d.x, d.y, Kind::Ship, BEAM, WHITE, None, 2.5);
            self.burst(cx, cy, 160, WHITE, 120.0, 1.6, Some(BEAM));
            self.burst(cx, cy, 80, ORANGE, 70.0, 1.4, Some(RED));
            self.fx.flash(WHITE, 0.5);
            self.fx.kick(4.0, 2.5);
            self.fx.ripple(cx, cy, 12.0, 7.0, 1.2);
            self.fx.ripple(cx, cy, 7.0, 4.0, 1.4);
            self.fx.light(cx, cy, 3.0, 4.0, BEAM, 1.2);
            self.fx.light(cx, cy, 1.5, 4.0, WHITE, 0.5);
            self.fx.slow(0.9, 0.3);
            self.party = t + 2.0;
            self.repair += jr(self.city.total as f64 * 0.25);
            for _ in 0..3 {
                self.firework();
            }
            self.drop_later += 2;
            self.events.push(Ev::ShipKill);
        }
        if age <= 1.5 {
            self.ship_death = Some(d);
        }
    }

    /// an invader of the front column breaks out and dives at a person or the city
    fn spawn_diver(&mut self, people: &[Unit]) {
        let sides: Vec<usize> = (0..self.sides.len()).filter(|&i| self.sides[i].count > 1 && self.sides[i].storm.is_none()).collect();
        if sides.is_empty() {
            return;
        }
        let si = sides[self.pick_index(sides.len())];
        let (n, cols, rows, dir_x) = (self.sides[si].n(), self.sides[si].cols, self.sides[si].rows, self.sides[si].dir_x);
        let mut cand: Vec<usize> = (0..n).filter(|&i| self.present(si, i)).collect();
        if cand.is_empty() {
            return;
        }
        // the front-most first
        let front = |i: usize| if dir_x > 0.0 { i % cols } else { cols - 1 - (i % cols) };
        cand.sort_by_key(|&a| std::cmp::Reverse(front(a)));
        let i = cand[self.pick_index(cand.len().min(rows))];
        let b = self.bx(si, i);
        let hp = {
            let side = &mut self.sides[si];
            side.alive[i] = 0;
            side.count -= 1;
            f64::from(side.hp[i])
        };
        let v = self.p.dive_speed * self.l.sx;
        let to_player = !people.is_empty() && self.random() < 0.6;
        let target = if to_player {
            let k = self.pick_index(people.len());
            DiverTarget::Person(people[k].id)
        } else {
            let y = self.rand(6.0, self.l.ah - 6.0);
            DiverTarget::Point(if dir_x > 0.0 { self.city.x0 } else { self.city.x0 + self.city.w as f64 }, y)
        };
        let up = if b.y + 4.0 < self.l.ah / 2.0 { -1.0 } else { 1.0 };
        let id = self.new_id();
        self.divers.push(Diver {
            id,
            x: b.x + b.w / 2.0,
            y: b.y + 4.0,
            vx: dir_x * v * 0.2,
            vy: up * v,
            v,
            k: b.k,
            hp,
            flash: -9.0,
            t0: self.time,
            target,
            trail: VecDeque::with_capacity(8),
            trail_t: 0.0,
            dir_x,
        });
        self.fx.light(b.x + b.w / 2.0, b.y + 4.0, 0.5, 1.5, RED, 0.3);
        self.events.push(Ev::Dive);
    }

    // ---- power-ups

    /// a free place where the Kinect sees people (the fog mask), off the city, away from everybody
    fn item_spot(&mut self, people: &[Unit]) -> Option<[f64; 2]> {
        let l = self.l;
        let (cx0, cw) = (self.city.x0, self.city.w as f64);
        for _ in 0..60 {
            let x = self.rand(4.0, l.aw - 4.0);
            let y = self.rand(4.0, l.ah - 4.0);
            let mx = 0.35 * l.sx;
            let my = 0.2 * l.sy;
            let ok = |x: f64, y: f64| {
                let Some(reach) = &self.reach else { return true };
                let xi = jr(x);
                let yi = jr(y);
                xi >= 0.0 && yi >= 0.0 && xi < l.aw && yi < l.ah && reach.get((yi * l.aw + xi) as usize).is_some_and(|&v| v == 255)
            };
            if !ok(x, y) || !ok(x - mx, y) || !ok(x + mx, y) || !ok(x, y - my) || !ok(x, y + my) {
                continue;
            }
            if x > cx0 - 6.0 && x < cx0 + cw + 6.0 {
                continue;
            }
            let mut min = f64::INFINITY;
            let mut close = false;
            for p in people {
                let d = ((p.center[0] - x) / l.sx).hypot((p.center[1] - y) / l.sy);
                close |= d < 0.6;
                min = min.min(d);
            }
            if close {
                continue;
            }
            if !people.is_empty() && min > 3.0 {
                continue;
            }
            return Some([x, y]);
        }
        None
    }

    fn drop_item(&mut self, kind: Power, people: &[Unit]) {
        let Some(spot) = self.item_spot(people) else { return };
        let t = self.time;
        self.items.push(Item { kind, x: spot[0], y: spot[1], t0: t, life: 11.0, taken: false });
        self.fx.light(spot[0], spot[1], 0.6, 2.0, kind.color(), 0.5);
        self.fx.ripple(spot[0], spot[1], 2.5, 4.0, 0.4);
        self.events.push(Ev::Item);
    }

    /// a random power-up: repairs more likely when the city is low, slow motion when it is hard
    fn pick_power(&mut self) -> Power {
        let w = [0.6 + 3.0 * (1.0 - self.city_health()), 2.0, 2.0, 1.4, 1.2, 1.0, 0.6 + (self.difficulty() - 1.2).max(0.0)];
        let mut r = self.random() * w.iter().sum::<f64>();
        for (k, wk) in POWERS.iter().zip(w) {
            r -= wk;
            if r <= 0.0 {
                return *k;
            }
        }
        Power::Rapid
    }

    fn collect(&mut self, ii: usize, u: &Unit, si: usize) {
        let t = self.time;
        let Some(item) = self.items.get(ii) else { return };
        let (kind, x, y) = (item.kind, item.x, item.y);
        let col = kind.color();
        let power_time = self.p.power_time;
        match kind {
            Power::Repair => self.repair += jr(self.city.total as f64 * 0.2),
            Power::Rapid => self.players[si].1.power.rapid = t + power_time,
            Power::Spread => self.players[si].1.power.spread = t + power_time,
            Power::Shield => {
                let s = &mut self.players[si].1;
                s.power.shield = 3;
                s.power.shield_until = t + power_time * 1.5;
            }
            Power::Nova => {
                self.waves.push(Wave { x: u.center[0], y: u.center[1], t0: t, slot: u.slot, col, r: 1.8, done: Vec::new(), dmg: 3.0 });
                self.fx.ripple(u.center[0], u.center[1], 10.0, 6.0, 0.9);
                self.fx.kick(3.0, 1.4);
                self.fx.flash(col, 0.2);
            }
            Power::Mega => self.players[si].1.power.mega = t + 3.0,
            Power::Slow => {
                self.enemy_slow_until = t + 6.0;
                self.fx.flash(col, 0.15);
            }
        }
        self.burst(x, y, 40, col, 55.0, 0.8, Some(WHITE));
        self.fx.light(x, y, 1.2, 2.5, col, 0.6);
        self.fx.ripple(x, y, 4.0, 5.0, 0.5);
        self.fx.kick(0.8, 0.4);
        self.events.push(Ev::Pickup(kind));
    }

    /// a player's own mega laser: from the body to the edge of the map, at the nearest target
    fn update_mega(&mut self, u: &Unit, si: usize, dt: f64, inv: InvCol) {
        let t = self.time;
        let (mega_until, stun_until) = {
            let s = &self.players[si].1;
            (s.power.mega, s.stun_until)
        };
        if t >= mega_until || t < stun_until {
            self.players[si].1.mega = None;
            return;
        }
        let l = self.l;
        let [cx, cy] = u.center;
        let dir = match u.arms.first() {
            Some(a) => a.dir,
            None => {
                let tg = self.nearest(cx, cy, 8.0);
                match self.target_pos(tg) {
                    Some(at) => {
                        let d = match (at[0] - cx).hypot(at[1] - cy) {
                            d if d > 0.0 => d,
                            _ => 1.0,
                        };
                        [(at[0] - cx) / d, (at[1] - cy) / d]
                    }
                    None => [if cx < l.aw / 2.0 { -1.0 } else { 1.0 }, 0.0],
                }
            }
        };
        // smooth turning
        let old = self.players[si].1.mega.map_or(dir, |m| m.dir);
        let k = (dt * 8.0).min(1.0);
        let nd = [old[0] + (dir[0] - old[0]) * k, old[1] + (dir[1] - old[1]) * k];
        let n = match nd[0].hypot(nd[1]) {
            n if n > 0.0 => n,
            _ => 1.0,
        };
        let dir = [nd[0] / n, nd[1] / n];
        let len = l.aw * 1.5;
        let m = Mega { x0: cx, y0: cy, x1: cx + dir[0] * len, y1: cy + dir[1] * len, dir, half: 0.12 * (l.sx + l.sy) * 0.5 };
        let tick = {
            let s = &mut self.players[si].1;
            s.mega = Some(m);
            s.power.mega_tick -= dt;
            s.power.mega_tick
        };
        self.fx.kick(0.6, 0.2);
        if tick > 0.0 {
            return;
        }
        self.players[si].1.power.mega_tick = 0.08;
        let mut hits = std::mem::take(&mut self.scratch);
        hits.clear();
        self.for_targets(|tg, bx, by, bw, bh| {
            let ccx = bx + bw / 2.0;
            let ccy = by + bh / 2.0;
            // in front of the player and close to the beam
            if (ccx - cx) * dir[0] + (ccy - cy) * dir[1] < 0.0 {
                return true;
            }
            if line_dist(ccx, ccy, m.x0, m.y0, m.x1, m.y1) < m.half + bw.max(bh) / 2.0 {
                hits.push((tg, 0.0, 0.0, 0.0, 0.0));
            }
            true
        });
        let any = !hits.is_empty();
        for &(tg, ..) in &hits {
            self.damage(tg, 1.0, u.slot, u.col, inv, Some(dir));
        }
        self.scratch = hits;
        self.bullets.retain(|b| (b.x - cx) * dir[0] + (b.y - cy) * dir[1] < 0.0 || line_dist(b.x, b.y, m.x0, m.y0, m.x1, m.y1) > m.half + 1.0);
        if any {
            self.events.push(Ev::Zap);
        }
    }

    // ---- lasers from the left and right edge

    fn spawn_edge_laser(&mut self, people: &[Unit]) {
        let Some(target) = self.pick_target(people, 0.6).and_then(|i| people.get(i)) else { return };
        let l = self.l;
        let from_left = self.random() < 0.5;
        let [px, py] = target.center;
        let x0 = if from_left { 0.0 } else { l.aw };
        let x1 = if from_left { l.aw } else { 0.0 };
        let mut m = self.rand(-0.5, 0.5).tan();
        let mut y0 = py + m * (x0 - px);
        if y0 < 3.0 || y0 > l.ah - 3.0 {
            y0 = clamp(y0, 3.0, l.ah - 3.0);
            let dx = match px - x0 {
                d if d != 0.0 && !d.is_nan() => d,
                _ => 1.0,
            };
            m = (py - y0) / dx;
        }
        let y1 = y0 + m * (x1 - x0);
        let half = (self.p.edge_width / 2.0) * (l.sx + l.sy) * 0.5;
        let tele = self.p.edge_tele / (0.9 + 0.1 * self.difficulty());
        self.edge_lasers.push(EdgeLaser { x0, y0, x1, y1, t0: self.time, tele, half, hit: Vec::new(), fired: false });
        self.events.push(Ev::EdgeCharge);
    }

    /// how far a laser is open: 0 (only the middle line) .. 1
    pub fn edge_open(&self, l: &EdgeLaser) -> f64 {
        let a = self.time - l.t0 - l.tele;
        if a < 0.0 {
            return 0.0;
        }
        if a < 0.1 {
            return a / 0.1;
        }
        if a < 0.65 {
            return 1.0;
        }
        (1.0 - (a - 0.65) / 0.15).max(0.0)
    }

    fn update_edge_lasers(&mut self, people: &[Unit], by_slot: &[Option<usize>; SLOTS], inv: InvCol, dt: f64) {
        let t = self.time;
        let lay = self.l;
        let mut lasers = std::mem::take(&mut self.edge_lasers);
        lasers.retain_mut(|l| {
            let a = t - l.t0 - l.tele;
            if a > 0.8 {
                return false;
            }
            if a < 0.0 {
                return true;
            }
            if !l.fired {
                l.fired = true;
                self.fx.kick(1.6, 0.6);
                self.fx.ripple(l.x0, l.y0, 5.0, 6.0, 0.5);
                self.fx.flash([1.0, 0.3, 0.15], 0.06);
                self.events.push(Ev::EdgeFire);
            }
            let open = self.edge_open(l);
            if open < 0.5 {
                return true;
            }
            let half = l.half * open;
            let body_half = 0.1 * (lay.sx + lay.sy) * 0.5;
            for p in people {
                if l.hit.contains(&p.id) {
                    continue;
                }
                if line_dist(p.center[0], p.center[1], l.x0, l.y0, l.x1, l.y1) < half + body_half {
                    l.hit.push(p.id);
                    if let Some(si) = by_slot.get(usize::from(p.slot)).copied().flatten().and_then(|ui| people.get(ui)).and_then(|w| self.state_index(w.id)) {
                        self.hit_player(si, p.center[0], p.center[1]);
                    }
                }
            }
            let mut burned = std::mem::take(&mut self.scratch);
            burned.clear();
            self.for_targets(|tg, bx, by, bw, bh| {
                if matches!(tg, Target::Ship(_) | Target::Ufo(_)) {
                    return true;
                }
                if line_dist(bx + bw / 2.0, by + bh / 2.0, l.x0, l.y0, l.x1, l.y1) < half + 4.0 {
                    burned.push((tg, 0.0, 0.0, 0.0, 0.0));
                }
                true
            });
            for &(tg, ..) in &burned {
                self.damage(tg, 99.0, 0, ORANGE, inv, None);
            }
            self.scratch = burned;
            self.bullets.retain(|b| line_dist(b.x, b.y, l.x0, l.y0, l.x1, l.y1) > half + 1.0);
            // a scratch across the city
            let (cx0, cw, ch) = (self.city.x0, self.city.w, self.city.h);
            let mm = (l.y1 - l.y0) / (l.x1 - l.x0);
            let ext = half * 0.4 * (1.0 + mm * mm).sqrt(); // only the core scratches (a few %)
            for xi in 0..cw {
                let x = cx0 + xi as f64;
                let yc = l.y0 + mm * (x - l.x0);
                let ya = (yc - ext).floor().max(0.0);
                let yb = (ch as f64 - 1.0).min(yc + ext);
                let mut y = ya;
                while y <= yb {
                    let k = y as usize * cw + xi;
                    y += 1.0;
                    if self.city.alive.get(k).is_none_or(|&a| a == 0) || self.random() > dt * 0.6 {
                        continue;
                    }
                    let c = &mut self.city;
                    c.alive[k] = 0;
                    c.dead_at[k] = t as f32;
                    c.dead.push(k);
                    c.hit_at = t;
                }
            }
            if self.random() < 0.6 {
                let u = self.random();
                let x = l.x0 + (l.x1 - l.x0) * u;
                let y = l.y0 + (l.y1 - l.y0) * u;
                let side = if self.random() < 0.5 { -1.0 } else { 1.0 };
                let vx = self.rand(-20.0, 20.0);
                let vy = side * self.rand(15.0, 50.0);
                let col = if self.random() < 0.5 { WHITE } else { ORANGE };
                let life = self.rand(0.2, 0.5);
                self.particles.push(Particle { x, y: y + side * half, vx, vy, col, t0: t, life });
            }
            true
        });
        lasers.append(&mut self.edge_lasers);
        self.edge_lasers = lasers;
    }

    fn start_storm(&mut self, si: usize) {
        let Some(side) = self.sides.get(si) else { return };
        let cols = side.cols.max(1);
        let dir_x = side.dir_x;
        let alive: Vec<usize> = (0..side.n()).filter(|&i| side.alive[i] != 0).collect();
        // by column, front first; a random order within a column
        let mut idx: Vec<(usize, f64)> = alive.into_iter().map(|i| (i, self.rng.f64())).collect();
        idx.sort_by(|a, b| {
            let (ca, cb) = (a.0 % cols, b.0 % cols);
            let by_col = if dir_x > 0.0 { cb.cmp(&ca) } else { ca.cmp(&cb) };
            by_col.then(a.1.total_cmp(&b.1))
        });
        let side = &mut self.sides[si];
        for &(i, _) in &idx {
            side.in_storm[i] = true;
        }
        side.storm = Some(idx.into_iter().map(|(i, _)| i).collect());
        side.storm_t = 0.0;
        self.stats.storms += 1;
        self.fx.flash(RED, 0.12);
        self.events.push(Ev::Storm);
    }

    /// the city falls: the game is lost
    fn start_fall(&mut self) {
        self.phase = Phase::Fall;
        self.phase_t = 0.0;
        self.fall_t = 0.0;
        self.skill = clamp(self.skill * 0.75, 0.5, 3.0);
        let divers = std::mem::take(&mut self.divers);
        for d in &divers {
            self.explode_diver(d, None, 0, InvCol([RED; 3]));
        }
        self.bullets.clear();
        self.shots.clear();
        self.fx.flash(RED, 0.45);
        self.fx.kick(3.0, 2.0);
        self.fx.slow(0.8, 0.3);
        self.bombs.clear();
        if let Some(sh) = self.ship.as_mut() {
            if sh.state == ShipState::Fire {
                self.events.push(Ev::Beam(false));
            }
            sh.state = ShipState::Leave;
        }
        let c = &self.city;
        let (x, y) = (c.x0 + c.w as f64 / 2.0, c.h as f64 / 2.0);
        self.fx.ripple(x, y, 10.0, 6.0, 1.2);
        self.events.push(Ev::Fall);
    }

    fn firework(&mut self) {
        let l = self.l;
        let x = self.rand(10.0, l.aw - 10.0);
        let y = self.rand(8.0, l.ah - 8.0);
        let col = neon(self.random());
        let n = 40;
        for k in 0..n {
            let a = (f64::from(k) / f64::from(n)) * PI * 2.0;
            let v = self.rand(40.0, 55.0);
            let life = self.rand(0.8, 1.2);
            self.particles.push(Particle { x, y, vx: a.cos() * v, vy: a.sin() * v, col, t0: self.time, life });
        }
        self.fx.light(x, y, 1.2, 2.2, col, 0.6);
        self.events.push(Ev::Firework);
    }

    /// the wave is over: the director rates it
    fn end_wave(&mut self) {
        let t = self.time;
        let l = self.l;
        if let Some(sh) = self.ship.as_mut() {
            sh.state = ShipState::Leave;
        }
        let dur = t - self.stats.t0;
        let lost = self.city.dead.len().saturating_sub(self.stats.dead0) as f64 / (self.city.total.max(1)) as f64;
        let won = self.stats.storms == 0;
        if won {
            self.level += 1;
            let r = self.p.target_time / dur.max(5.0);
            self.skill *= clamp(r.powf(0.3), 0.92, 1.15);
            if lost < 0.03 && self.stats.hits <= self.crowd_n() * 2.0 {
                self.skill *= 1.05;
            }
            self.heal_city(if lost < 0.03 { 0.6 } else { 0.3 }, false);
            self.party = t + 2.5;
            for _ in 0..5 {
                self.firework();
            }
            self.fx.slow(0.8, 0.35);
            let c = neon(self.random());
            self.fx.flash(c, 0.15);
            self.fx.ripple(self.city.x0 + self.city.w as f64 / 2.0, l.ah / 2.0, 7.0, 6.0, 1.0);
            self.events.push(Ev::Clear);
        } else {
            self.skill *= 0.9_f64.powi(self.stats.storms);
            self.heal_city(0.12, false);
        }
        self.skill = clamp(self.skill, 0.5, 3.0);
        self.phase = Phase::Clear;
        self.phase_t = 0.0;
    }

    /// the unit index and the state index of the person in slot s (bySlot)
    fn who(&self, people: &[Unit], by_slot: &[Option<usize>; SLOTS], slot: u8) -> Option<(usize, usize)> {
        let ui = by_slot.get(usize::from(slot)).copied().flatten()?;
        let si = self.state_index(people.get(ui)?.id)?;
        Some((ui, si))
    }

    /// One step. people: the units (art px); body: the map grid of the bodies (body.rs); p: the
    /// params; inv: the invaders' colors.
    pub fn step(&mut self, dt_real: f64, people: &[Unit], body: &Bodies, p: &P, inv: InvCol) {
        self.p = *p;
        self.p_set = true;
        let l = self.l;
        let dt = dt_real * self.fx.time_scale();
        self.time += dt;
        let t = self.time;
        let n = people.len();
        let present = n > 0;
        // the crowd, smoothed over about two seconds
        self.crowd += (n as f64 - self.crowd) * (dt_real / 2.0).min(1.0);
        self.empty_for = if present { 0.0 } else { self.empty_for + dt_real };
        if !present && self.empty_for > p.reset_after && self.dirty {
            self.reset_all();
            return;
        }
        if present {
            self.dirty = true;
        }
        let sx = l.sx;
        let nn = self.crowd_n();
        let d = self.difficulty();
        let mercy = self.city_health() < 0.4;
        let edt = if t < self.enemy_slow_until { dt * 0.4 } else { dt }; // the slow-motion power-up

        // ---- the city: rewards are built up over time
        if self.repair > 0.0 {
            let k = self.repair.min((dt * if self.phase == Phase::Rebuild { 1500.0 } else { 300.0 }).ceil());
            self.regrow(k);
            self.repair -= k;
            if self.city.dead.is_empty() {
                self.repair = 0.0;
            }
        }

        // ---- phases
        self.phase_t += dt;
        match self.phase {
            Phase::Enter => {
                // warp-in: a flash where each one appears
                for si in 0..self.sides.len() {
                    for i in 0..self.sides[si].n() {
                        let s = f64::from(self.sides[si].spawn[i]);
                        if s <= t && s > t - dt {
                            let b = self.bx(si, i);
                            self.fx.light(b.x + b.w / 2.0, b.y + 4.0, 0.35, 1.6, inv.of(b.k), 0.25);
                            self.booms.push(Boom { x: b.x + b.w / 2.0, y: b.y + 4.0, t0: t, col: WHITE, warp: true, splat: false });
                            self.events.push(Ev::Warp);
                        }
                    }
                }
                if self.sides.iter().all(|s| s.spawn.iter().all(|&v| f64::from(v) <= t - 0.4)) {
                    self.phase = Phase::Fight;
                    self.phase_t = 0.0;
                }
            }
            Phase::Fight => {
                // the beat: every formation steps at once, faster with fewer invaders left and later waves
                let alive: i32 = self.sides.iter().map(|s| s.count).sum();
                let interval = 0.035_f64.max((0.3 / (p.speed * (0.85 + 0.15 * d))) * (0.12 + 0.88 * (f64::from(alive) / (self.total.max(1)) as f64).powf(1.2)));
                self.beat_t += edt;
                if self.beat_t >= interval && alive != 0 {
                    self.beat_t = 0.0;
                    self.beat += 1;
                    self.frame_anim ^= 1;
                    self.fx.pulse = 1.0;
                    self.beat_at = t;
                    self.events.push(Ev::March(self.beat % 4));
                    for si in 0..self.sides.len() {
                        if self.sides[si].count == 0 || self.sides[si].storm.is_some() {
                            continue;
                        }
                        let (min_y, max_y, _) = self.bounds(si);
                        let step_y = 3.0;
                        let side = &mut self.sides[si];
                        let hits_edge = if side.ydir > 0.0 { max_y + step_y > l.ah - 1.0 } else { min_y - step_y < 1.0 };
                        if hits_edge {
                            side.ydir = -side.ydir;
                            if present {
                                side.fx += side.dir_x * jr(p.advance * (0.8 + 0.2 * d));
                            }
                        } else {
                            side.fy += side.ydir * step_y;
                        }
                        let dir_x = side.dir_x;
                        let (_, _, front) = self.bounds(si);
                        let c = &self.city;
                        let reached = if dir_x > 0.0 { front >= c.x0 - 1.0 } else { front <= c.x0 + c.w as f64 + 1.0 };
                        if reached {
                            self.start_storm(si);
                        }
                    }
                }
                if present {
                    // their fire: more with more people and higher difficulty, less when the city is about to fall
                    let ease = self.ease();
                    let rate = p.enemy_fire * 0.45 * (0.6 + 0.4 * nn) * d * if mercy { 0.7 } else { 1.0 } * ease;
                    self.fire_acc += dt * rate;
                    let max_bullets = 3.0 + jr(3.0 * nn);
                    let aimed = clamp((d - 0.9) * 0.5, 0.0, 0.6) * ease;
                    while self.fire_acc >= 1.0 {
                        self.fire_acc -= 1.0;
                        if (self.bullets.len() as f64) < max_bullets {
                            self.enemy_shot(people, p.bullet_speed * (0.85 + 0.15 * d) * sx, aimed);
                        }
                    }
                    // divers
                    let dive_rate = p.dive * 0.05 * nn * (d - 0.6).max(0.0) * if mercy { 0.5 } else { 1.0 } * ease;
                    self.dive_acc += dt * dive_rate;
                    while self.dive_acc >= 1.0 {
                        self.dive_acc -= 1.0;
                        if (self.divers.len() as f64) < 1.0 + (nn / 2.0).floor() {
                            self.spawn_diver(people);
                        }
                    }
                    // bombers: from wave 2, more with difficulty
                    let bomb_rate = p.bombs * 0.06 * nn * (d - 0.8).max(0.0) * if self.level >= 2 { 1.0 } else { 0.0 } * ease;
                    self.bomb_acc += dt * bomb_rate;
                    while self.bomb_acc >= 1.0 {
                        self.bomb_acc -= 1.0;
                        if (self.bombs.len() as f64) < 1.0 + jr(nn) {
                            self.spawn_bomb(people);
                        }
                    }
                    // the battleship: from wave shipFrom; sooner when everybody camps in forts
                    let forts = people.iter().filter(|u| self.fortified(u.id)).count() as f64;
                    self.camp = if forts >= (people.len() as f64 * 0.7).max(1.0) { self.camp + dt } else { (self.camp - dt).max(0.0) };
                    if self.camp > 10.0 {
                        self.next_ship = self.next_ship.min(t + 2.0);
                    }
                    if self.ship.is_none() && self.ship_death.is_none() && f64::from(self.level) >= p.ship_from && t > self.next_ship && p.ship {
                        self.spawn_ship();
                    }
                    // lasers from the edges: from wave edgeFrom, more with people and difficulty
                    if f64::from(self.level) >= p.edge_from {
                        self.edge_acc += dt * p.edge_lasers * 0.05 * (0.6 + 0.4 * nn) * d * ease;
                        while self.edge_acc >= 1.0 {
                            self.edge_acc -= 1.0;
                            if (self.edge_lasers.len() as f64) < 1.0 + (nn / 3.0).floor() {
                                self.spawn_edge_laser(people);
                            }
                        }
                    }
                    // power-ups: more often when the crowd struggles (low skill, low city) and with more people
                    if p.items && t > self.next_item {
                        if (self.items.len() as f64) < 1.0 + (nn / 2.0).floor() {
                            let k = self.pick_power();
                            self.drop_item(k, people);
                        }
                        let every = (p.item_every * clamp(self.skill, 0.6, 1.6) * ease) / (0.7 + 0.3 * nn) / if self.city_health() < 0.5 { 1.6 } else { 1.0 };
                        self.next_item = t + every * self.rand(0.75, 1.25);
                    }
                    // mercy: a city about to fall brings the mothership (shooting it repairs the city)
                    if mercy && !self.stats.mercy {
                        self.stats.mercy = true;
                        self.next_ufo = self.next_ufo.min(t + 3.0);
                    }
                    // pressure: a crowd that wipes out the wave fast gets divers
                    let killed = 1.0 - f64::from(alive) / (self.total.max(1)) as f64;
                    if !self.stats.pressure && t - self.stats.t0 < 15.0 && killed > 0.55 {
                        self.stats.pressure = true;
                        let k = 4.0_f64.min(1.0 + jr(nn)) as usize;
                        for _ in 0..k {
                            self.spawn_diver(people);
                        }
                    }
                }
                // the mothership
                if self.ufo.is_none() && t > self.next_ufo {
                    let from_left = self.random() < 0.5;
                    let y = jr(self.rand(4.0, l.ah - UFO_H - 3.0));
                    let id = self.new_id();
                    self.ufo = Some(Ufo { id, x: if from_left { -UFO_W } else { l.aw }, y, vx: if from_left { 1.0 } else { -1.0 } * 1.1 * sx });
                    self.next_ufo = t + p.ufo_every * self.rand(0.7, 1.3) * if present { 1.0 } else { 2.0 };
                    self.events.push(Ev::Ufo(true));
                }
                // the city falls
                if present && self.city_health() < p.city_fall {
                    self.start_fall();
                } else if self.sides.iter().all(|s| s.count == 0 && s.storm.is_none()) && self.divers.is_empty() {
                    // the wave is over when both formations are gone (shot down or crashed into the city)
                    self.end_wave();
                }
            }
            Phase::Clear => {
                if t < self.party && self.random() < dt * 6.0 {
                    self.firework();
                }
                if self.phase_t > 3.0 && self.repair <= 0.0 {
                    self.start_wave();
                }
            }
            Phase::Fall => {
                // chain explosions through the city, then the rebuild
                self.fall_t -= dt;
                if self.phase_t < 3.0 && self.fall_t <= 0.0 {
                    self.fall_t = self.rand(0.06, 0.16);
                    let x = self.city.x0 + self.rand(0.0, self.city.w as f64);
                    let y = self.rand(0.0, self.city.h as f64);
                    let r = self.rand(4.0, 8.0);
                    self.erode(x, y, r);
                    self.burst(x, y, 24, EMBER, 50.0, 0.9, Some(RED));
                    self.booms.push(Boom { x, y, t0: t, col: ORANGE, warp: false, splat: false });
                    let lr = self.rand(0.8, 1.4);
                    let col = if self.random() < 0.5 { EMBER } else { RED };
                    self.fx.light(x, y, lr, 2.5, col, 0.5);
                    if self.random() < 0.3 {
                        self.fx.ripple(x, y, 4.0, 5.0, 0.5);
                    }
                    self.fx.kick(1.5, 0.0);
                    self.events.push(Ev::Crash);
                }
                if self.phase_t > 4.0 {
                    self.phase = Phase::Rebuild;
                    self.phase_t = 0.0;
                    self.level = 1;
                    self.score = 0;
                    self.clear_field();
                    self.repair = self.city.dead.len() as f64;
                    self.events.push(Ev::Rebuild);
                }
            }
            Phase::Rebuild => {
                if self.phase_t > 2.5 && self.city.dead.is_empty() {
                    self.start_wave();
                }
            }
        }

        // ---- storming formations: one invader after the other dives into the city
        for si in 0..self.sides.len() {
            if self.sides[si].storm.is_none() {
                continue;
            }
            self.sides[si].storm_t -= dt;
            loop {
                let side = &mut self.sides[si];
                let Some(q) = side.storm.as_mut() else { break };
                if q.is_empty() || side.storm_t > 0.0 {
                    break;
                }
                side.storm_t += 0.07;
                let Some(i) = q.pop_front() else { break };
                side.in_storm[i] = false;
                if side.alive[i] == 0 {
                    continue;
                }
                let b = self.bx(si, i);
                let side = &mut self.sides[si];
                side.alive[i] = 0;
                side.count -= 1;
                let dir_x = side.dir_x;
                let c = (self.city.x0, self.city.w as f64);
                let ex = if dir_x > 0.0 { c.0 + self.rand(0.0, 3.0) } else { c.0 + c.1 - self.rand(0.0, 3.0) };
                let r = self.rand(4.5, 7.0);
                self.erode(ex, b.y + 4.0, r);
                self.burst(ex, b.y + 4.0, 18, RED, 42.0, 0.7, Some(inv.of(b.k)));
                self.booms.push(Boom { x: ex, y: b.y + 4.0, t0: t, col: RED, warp: false, splat: false });
                self.fx.light(ex, b.y + 4.0, 1.0, 2.2, ORANGE, 0.45);
                self.fx.kick(1.4, 0.0);
                self.events.push(Ev::Crash);
                self.alarm = t + 0.5;
            }
            let side = &mut self.sides[si];
            if side.storm.as_ref().is_some_and(|q| q.is_empty()) {
                side.storm = None;
            }
        }

        // ---- the people: automatic fire (stronger when fortified), pointing, stomping
        let point = p.point;
        let auto = p.auto;
        let cone = (p.assist * PI) / 180.0;
        let mut by_slot: [Option<usize>; SLOTS] = [None; SLOTS];
        let fighting = self.phase == Phase::Fight || self.phase == Phase::Enter;
        for (ui, u) in people.iter().enumerate() {
            let si = self.state(u);
            if let Some(b) = by_slot.get_mut(usize::from(u.slot)) {
                *b = Some(ui);
            }
            let stunned = t < self.players[si].1.stun_until;
            // standing still (the position is what the tracking does best): a fort after a moment
            let [cx, cy] = u.center;
            let fortified = {
                let s = &mut self.players[si].1;
                let [opx, opy] = match s.pos {
                    Some(q) => q,
                    None => {
                        s.still_since = t;
                        [cx, cy]
                    }
                };
                let moved = ((cx - opx) / l.sx).hypot((cy - opy) / l.sy);
                let v = moved / dt.max(1e-3);
                s.speed += (v - s.speed) * (dt * 5.0).min(1.0);
                // walking (seen from above): the direction, the step phase of the feet, a footprint per step
                if moved > 1e-4 {
                    let dx = (cx - opx) / moved;
                    let dy = (cy - opy) / moved;
                    s.dir = Some(match s.dir {
                        Some(o) => [o[0] + (dx - o[0]) * 0.2, o[1] + (dy - o[1]) * 0.2],
                        None => [dx, dy],
                    });
                }
                s.phase += (moved / p.step_len) * PI;
                s.step_acc += moved;
                if s.step_acc >= p.step_len && s.speed > 0.15 {
                    s.step_acc = 0.0;
                    s.foot = if s.foot != 0 { 0 } else { 1 };
                    let dd = s.dir.unwrap_or([0.0, -1.0]);
                    let nd = match dd[0].hypot(dd[1]) {
                        n if n > 0.0 => n,
                        _ => 1.0,
                    };
                    let side = if s.foot != 0 { 1.0 } else { -1.0 };
                    let off = 0.07 * p.body_scale * 1.6 * l.sx;
                    self.footprints.push_back(Footprint { x: cx - (dd[1] / nd) * side * off, y: cy + (dd[0] / nd) * side * off, dir: [dd[0] / nd, dd[1] / nd], t0: t, col: u.col });
                    if self.footprints.len() > 400 {
                        self.footprints.pop_front();
                    }
                }
                s.pos = Some([cx, cy]);
                if s.speed > p.still_speed || stunned {
                    s.still_since = t;
                }
                p.fortify && t - s.still_since >= p.fortify_after
            };
            if fortified && !self.players[si].1.fortified {
                self.players[si].1.fort_at = t;
                self.fx.light(cx, cy, 0.6, 1.2, u.col, 0.3);
                self.events.push(Ev::Fortify);
            }
            self.players[si].1.fortified = fortified;

            self.players[si].1.lock.clear();
            let mut pointed = false;
            if point && fighting {
                for a in &u.arms {
                    let target = self.lock_on(a.tip[0], a.tip[1], a.dir, cone);
                    if let Some(tg) = target {
                        self.players[si].1.lock.push((a.id, tg));
                    }
                    pointed = true;
                    if stunned {
                        continue;
                    }
                    let s = &self.players[si].1;
                    let every = p.point_every / if t < s.power.rapid { 2.5 } else { 1.0 } / if s.boost.active { p.boost_fire } else { 1.0 };
                    if t - s.fired(a.id) < every {
                        continue;
                    }
                    self.players[si].1.set_fired(a.id, t);
                    self.fire(u, si, a.tip, a.dir, target);
                }
            }
            self.players[si].1.auto_target = None;
            if auto && fighting && !stunned && !pointed {
                // boosted: full fire also on the move, faster, farther
                let s = &self.players[si].1;
                let boosted = s.boost.active;
                let every = (if fortified || boosted { p.auto_every } else { p.auto_every * 3.0 }) / if t < s.power.rapid { 2.5 } else { 1.0 } / if boosted { p.boost_fire } else { 1.0 };
                let last = s.auto;
                let target = self.nearest(cx, cy, p.auto_range * if fortified { 1.2 } else { 1.0 } * if boosted { 1.5 } else { 1.0 });
                self.players[si].1.auto_target = target;
                if target.is_some() && t - last >= every {
                    let s = &mut self.players[si].1;
                    s.auto = t;
                    s.set_fired(AUTO, t);
                    self.fire(u, si, u.center, [1.0, 0.0], target);
                }
            }
            self.update_mega(u, si, dt, inv);
            // walk onto a power-up to take it
            for ii in 0..self.items.len() {
                let it = &self.items[ii];
                if it.taken || ((it.x - cx) / l.sx).hypot((it.y - cy) / l.sy) > 0.32 {
                    continue;
                }
                self.items[ii].taken = true;
                self.collect(ii, u, si);
            }
            // the boost: a jump starts it when the hexagon is full; it is used up, then charged again
            let bo = self.players[si].1.boost;
            if bo.active {
                self.players[si].1.boost.charge -= dt_real / p.boost_time;
                if self.random() < dt_real * 14.0 {
                    let a = self.random() * PI * 2.0;
                    let col = if self.random() < 0.5 { WHITE } else { u.col };
                    self.particles.push(Particle { x: cx + a.cos() * 3.0, y: cy + a.sin() * 2.0, vx: a.cos() * 18.0, vy: a.sin() * 12.0, col, t0: t, life: 0.4 });
                }
                let b = &mut self.players[si].1.boost;
                if b.charge <= 0.0 {
                    b.charge = 0.0;
                    b.active = false;
                    self.events.push(Ev::BoostEnd);
                }
            } else if bo.charge < 1.0 {
                let b = &mut self.players[si].1.boost;
                b.charge = (b.charge + dt_real / p.boost_recharge).min(1.0);
                if b.charge >= 1.0 {
                    b.ready_at = t;
                    self.fx.light(cx, cy, 0.6, 1.5, u.col, 0.3);
                    self.events.push(Ev::BoostReady);
                }
            }
            // every jump that is seen gets an answer (the unit hops, arrows, a "boing"), so people learn
            // that jumping is read; with a full hexagon it starts the boost, else the bar flickers
            let bo = self.players[si].1.boost;
            if u.stomp && p.jump_boost && !stunned {
                self.players[si].1.jump_at = t;
                self.events.push(Ev::Jump);
                if !bo.active && bo.charge < 1.0 {
                    self.players[si].1.denied_at = t;
                    self.events.push(Ev::JumpEmpty);
                }
            }
            if u.stomp && p.jump_boost && !stunned && !bo.active && bo.charge >= 1.0 {
                // the jump hint figure (if it was showing) takes off and bursts into sparks
                let full = p.jump_hint == JumpHint::Always || (p.jump_hint != JumpHint::Off && bo.uses == 0);
                {
                    let s = &mut self.players[si].1;
                    s.launch_full = full;
                    s.launch_at = t;
                }
                if full {
                    let r = 0.36 * p.body_scale + 0.1;
                    self.burst(cx + r * l.sx * 0.75 + 3.0, cy - r * l.sy - 9.0, 24, WHITE, 45.0, 0.5, Some(u.col));
                }
                {
                    let b = &mut self.players[si].1.boost;
                    b.active = true;
                    b.at = t;
                    b.uses += 1;
                }
                self.burst(cx, cy, 40, u.col, 60.0, 0.7, Some(WHITE));
                self.fx.ripple(cx, cy, 6.0, 5.0, 0.5);
                self.fx.light(cx, cy, 1.2, 2.5, u.col, 0.5);
                self.fx.flash(u.col, 0.08);
                self.fx.kick(2.0, 0.8);
                self.events.push(Ev::Boost);
            }
        }
        self.players.retain(|(_, s)| t - s.seen <= 5.0);
        self.items.retain(|it| !it.taken && t - it.t0 < it.life);
        while self.drop_later > 0 && present {
            self.drop_later -= 1;
            let k = self.pick_power();
            self.drop_item(k, people);
        }

        // ---- team lasers: everybody connects to the nearest other person within linkMax; a beam cuts
        // through invaders (one hit per linkCooldown) and through every bullet
        self.links.clear();
        if p.links && people.len() > 1 {
            let mut pairs: Vec<((u32, u32), usize, usize)> = Vec::with_capacity(people.len());
            for (ai, a) in people.iter().enumerate() {
                let mut best: Option<usize> = None;
                let mut bd = p.link_max;
                for (bi, b) in people.iter().enumerate() {
                    if bi == ai {
                        continue;
                    }
                    let dd = ((a.center[0] - b.center[0]) / l.sx).hypot((a.center[1] - b.center[1]) / l.sy);
                    if dd < bd {
                        bd = dd;
                        best = Some(bi);
                    }
                }
                let Some(bi) = best else { continue };
                let (ia, ib) = (a.id, people[bi].id);
                let key = if ia < ib { (ia, ib) } else { (ib, ia) };
                if !pairs.iter().any(|q| q.0 == key) {
                    pairs.push((key, ai, bi));
                }
            }
            for (key, ai, bi) in pairs {
                let (a, b) = (&people[ai], &people[bi]);
                let sa = self.who(people, &by_slot, a.slot).map(|w| self.players[w.1].1.stun_until);
                let sb = self.who(people, &by_slot, b.slot).map(|w| self.players[w.1].1.stun_until);
                let (Some(sa), Some(sb)) = (sa, sb) else { continue };
                if t < sa || t < sb {
                    continue;
                }
                let li = match self.link_state.iter().position(|q| q.0 == key) {
                    Some(i) => i,
                    None => {
                        self.link_state.push((key, LinkState { ready: t, flash: -9.0, born: t, seen: t }));
                        self.events.push(Ev::Link);
                        self.link_state.len() - 1
                    }
                };
                self.link_state[li].1.seen = t;
                let [ax, ay] = a.center;
                let [bx, by] = b.center;
                self.links.push(Link { key, a: ai, b: bi });
                if t >= self.link_state[li].1.ready && fighting {
                    let mut hit = None;
                    self.for_targets(|tg, x0, y0, w, h| {
                        if !seg_box(ax, ay, bx, by, x0 - 1.0, y0 - 1.0, x0 + w + 1.0, y0 + h + 1.0) {
                            return true;
                        }
                        hit = Some(tg);
                        false
                    });
                    if let Some(hit) = hit {
                        let mix_col = [(a.col[0] + b.col[0]) / 2.0, (a.col[1] + b.col[1]) / 2.0, (a.col[2] + b.col[2]) / 2.0];
                        let at = self.target_pos(Some(hit));
                        self.damage(hit, 1.0, a.slot, mix_col, inv, None);
                        if let Some(st) = self.link_state.iter_mut().find(|q| q.0 == key) {
                            st.1.ready = t + p.link_cooldown;
                            st.1.flash = t;
                        }
                        if let Some(at) = at {
                            self.fx.light(at[0], at[1], 0.5, 1.6, WHITE, 0.15);
                        }
                        self.events.push(Ev::Zap);
                    }
                }
                let mut bullets = std::mem::take(&mut self.bullets);
                let mut flashed = false;
                bullets.retain(|bu| {
                    if seg_dist(bu.x, bu.y, ax, ay, bx, by) > 1.6 {
                        return true;
                    }
                    self.burst(bu.x, bu.y, 6, WHITE, 25.0, 0.3, Some(a.col));
                    flashed = true;
                    false
                });
                self.bullets = bullets;
                if flashed && let Some(st) = self.link_state.iter_mut().find(|q| q.0 == key) {
                    st.1.flash = t;
                }
            }
        }
        self.link_state.retain(|(_, st)| t - st.seen <= 0.5);

        // ---- formation invaders and divers that touch a body: an arm destroys them, the body is stunned
        {
            let mut touched = std::mem::take(&mut self.scratch);
            touched.clear();
            self.for_targets(|tg, x0, y0, w, h| {
                let mut arm_slot = 0u8;
                let mut body_slot = 0u8;
                let mut y = y0;
                while y < y0 + h && arm_slot == 0 {
                    let mut x = x0.floor();
                    while x < x0 + w {
                        let s = body.slot_at(x, y);
                        x += 1.0;
                        if s == 0 {
                            continue;
                        }
                        if body.kind_at(x - 1.0, y) == 2 {
                            arm_slot = s;
                            break;
                        }
                        body_slot = s;
                    }
                    y += 1.0;
                }
                if arm_slot != 0 || body_slot != 0 {
                    touched.push((tg, f64::from(arm_slot), f64::from(body_slot), x0 + w / 2.0, y0 + h / 2.0));
                }
                true
            });
            for &(tg, arm_slot, body_slot, x, y) in &touched {
                let (arm_slot, body_slot) = (arm_slot as u8, body_slot as u8);
                let Some((ui, si)) = self.who(people, &by_slot, if arm_slot != 0 { arm_slot } else { body_slot }) else { continue };
                let wp = &people[ui];
                if arm_slot != 0 && t >= self.players[si].1.stun_until {
                    self.damage(tg, 9.0, wp.slot, wp.col, inv, None);
                } else if body_slot != 0 && !matches!(tg, Target::Ufo(_)) {
                    self.hit_player(si, x, y);
                    // a diver that hits a body explodes
                    if let Target::Diver(id) = tg
                        && let Some(di) = self.divers.iter().position(|d| d.id == id)
                    {
                        let dv = self.divers.remove(di);
                        self.explode_diver(&dv, None, 0, inv);
                    }
                }
            }
            self.scratch = touched;
        }

        // ---- divers: steer at their target, explode on the city or a person
        {
            let mut divers = std::mem::take(&mut self.divers);
            let (cx0, cw) = (self.city.x0, self.city.w as f64);
            divers.retain_mut(|dv| {
                let age = t - dv.t0;
                let who = match dv.target {
                    DiverTarget::Person(id) => people.iter().find(|u| u.id == id),
                    DiverTarget::Point(..) => None,
                };
                let (tx, ty) = match who {
                    Some(w) => (w.center[0], w.center[1]),
                    None => {
                        // at the city (also when the person left)
                        if let DiverTarget::Person(_) = dv.target {
                            dv.target = DiverTarget::Point(if dv.dir_x > 0.0 { cx0 } else { cx0 + cw }, dv.y);
                        }
                        match dv.target {
                            DiverTarget::Point(x, y) => (x, y),
                            DiverTarget::Person(_) => (dv.x, dv.y),
                        }
                    }
                };
                let cur = dv.vy.atan2(dv.vx);
                let mut dd = (ty - dv.y).atan2(tx - dv.x) - cur;
                while dd > PI {
                    dd -= PI * 2.0;
                }
                while dd < -PI {
                    dd += PI * 2.0;
                }
                let turn = (if age < 0.5 { 1.2 } else { 2.6 }) * dt;
                let ang = cur + clamp(dd, -turn, turn);
                let v = dv.v * if age < 0.4 { 0.7 } else { 1.0 };
                dv.vx = ang.cos() * v;
                dv.vy = ang.sin() * v;
                dv.x += dv.vx * edt;
                dv.y += dv.vy * edt;
                dv.trail_t -= dt_real;
                if dv.trail_t <= 0.0 {
                    dv.trail_t = 0.035;
                    dv.trail.push_front([dv.x, dv.y]);
                    if dv.trail.len() > 7 {
                        dv.trail.pop_back();
                    }
                }
                if self.city_at(dv.x, dv.y) {
                    self.erode(dv.x, dv.y, 5.5);
                    self.explode_diver(dv, None, 0, inv);
                    return false;
                }
                if age > 9.0 || dv.x < -20.0 || dv.x > l.aw + 20.0 || dv.y < -20.0 || dv.y > l.ah + 20.0 {
                    if age > 9.0 {
                        self.explode_diver(dv, None, 0, inv);
                    }
                    return false;
                }
                true
            });
            // (no diver is added while they move)
            divers.append(&mut self.divers);
            self.divers = divers;
        }

        // ---- shock waves: a ring runs out from where somebody landed
        {
            let mut waves = std::mem::take(&mut self.waves);
            waves.retain_mut(|w| {
                let u = (t - w.t0) / 0.45;
                if u >= 1.0 {
                    return false;
                }
                let r = w.r * (1.0 - (1.0 - u).powi(2));
                let rx = (r * l.sx).max(1e-3);
                let ry = (r * l.sy).max(1e-3);
                let inside = |x: f64, y: f64| ((x - w.x) / rx).powi(2) + ((y - w.y) / ry).powi(2) <= 1.0;
                let mut hits: Vec<(Target, [f64; 2])> = Vec::new();
                self.for_targets(|tg, x0, y0, bw, bh| {
                    let cx = x0 + bw / 2.0;
                    let cy = y0 + bh / 2.0;
                    let key = match tg {
                        Target::Diver(id) => DoneKey::Diver(id),
                        Target::Ufo(id) => DoneKey::Ufo(id),
                        Target::Ship(id) => DoneKey::Ship(id),
                        Target::Inv { side, i, .. } => DoneKey::Inv(side, i),
                    };
                    if inside(cx, cy) && !w.done.contains(&key) {
                        w.done.push(key);
                        let d = match (cx - w.x).hypot(cy - w.y) {
                            d if d > 0.0 => d,
                            _ => 1.0,
                        };
                        hits.push((tg, [(cx - w.x) / d, (cy - w.y) / d]));
                    }
                    true
                });
                for (tg, push) in hits {
                    self.damage(tg, w.dmg, w.slot, w.col, inv, Some(push));
                }
                let mut bullets = std::mem::take(&mut self.bullets);
                bullets.retain(|bu| {
                    if !inside(bu.x, bu.y) {
                        return true;
                    }
                    self.burst(bu.x, bu.y, 6, WHITE, 25.0, 0.3, Some(w.col));
                    false
                });
                self.bullets = bullets;
                true
            });
            waves.append(&mut self.waves);
            self.waves = waves;
        }

        // ---- the players' shots: locked ones steer after their target
        let (w, h) = (l.aw, l.ah);
        let turn = p.homing * dt;
        {
            let mut shots = std::mem::take(&mut self.shots);
            shots.retain_mut(|sh| {
                if let Some(at) = self.target_pos(sh.target) {
                    let v = sh.vx.hypot(sh.vy);
                    let cur = sh.vy.atan2(sh.vx);
                    let mut dd = (at[1] - sh.y).atan2(at[0] - sh.x) - cur;
                    while dd > PI {
                        dd -= PI * 2.0;
                    }
                    while dd < -PI {
                        dd += PI * 2.0;
                    }
                    let a = cur + clamp(dd, -turn, turn);
                    sh.vx = a.cos() * v;
                    sh.vy = a.sin() * v;
                }
                let k = 1.0_f64.max(((sh.vx.hypot(sh.vy) * dt) / 1.5).ceil()).min(1000.0);
                let mut j = 0.0;
                while j < k {
                    j += 1.0;
                    sh.x += (sh.vx * dt) / k;
                    sh.y += (sh.vy * dt) / k;
                    if sh.x < -4.0 || sh.y < -4.0 || sh.x > w + 4.0 || sh.y > h + 4.0 {
                        return false;
                    }
                    if let Some(hit) = self.target_at(sh.x, sh.y, 1.0) {
                        let v = match sh.vx.hypot(sh.vy) {
                            v if v > 0.0 => v,
                            _ => 1.0,
                        };
                        self.damage(hit, sh.dmg, sh.slot, sh.col, inv, Some([sh.vx / v, sh.vy / v]));
                        return false;
                    }
                    if let Some(m) = self.bullets.iter().position(|b| (b.x - sh.x).abs() < 3.5 && (b.y - sh.y).abs() < 2.5) {
                        self.bullets.remove(m);
                        self.burst(sh.x, sh.y, 8, WHITE, 25.0, 0.35, Some(sh.col));
                        self.fx.light(sh.x, sh.y, 0.3, 1.2, sh.col, 0.12);
                        self.events.push(Ev::Block);
                        return false;
                    }
                }
                true
            });
            // (no shot is fired while they fly)
            shots.append(&mut self.shots);
            self.shots = shots;
        }

        // ---- the invaders' bullets: arms block them, a body hit stuns, the city loses a bit
        let harmless = !present; // with nobody there they only splash
        {
            let mut bullets = std::mem::take(&mut self.bullets);
            bullets.retain_mut(|b| {
                let k = 1.0_f64.max((b.vx.hypot(b.vy) * dt).ceil()).min(1000.0);
                let mut j = 0.0;
                while j < k {
                    j += 1.0;
                    b.x += (b.vx * edt) / k;
                    b.y += (b.vy * edt) / k;
                    let hx = b.x;
                    let hy = b.y;
                    if hx < -8.0 || hx > w + 8.0 || hy < -8.0 || hy > h + 8.0 {
                        return false;
                    }
                    let s = match body.slot_at(hx, hy) {
                        0 => match body.slot_at(hx, hy - 1.0) {
                            0 => body.slot_at(hx, hy + 1.0),
                            s => s,
                        },
                        s => s,
                    };
                    if s != 0
                        && let Some((ui, si)) = self.who(people, &by_slot, s)
                    {
                        let kind = body.kind_at(hx, hy).max(body.kind_at(hx, hy - 1.0)).max(body.kind_at(hx, hy + 1.0));
                        let col = people[ui].col;
                        if kind == 2 {
                            self.burst(hx, hy, 10, WHITE, 28.0, 0.4, Some(col));
                            self.fx.light(hx, hy, 0.35, 1.4, col, 0.15);
                            self.events.push(Ev::Block);
                        } else {
                            self.hit_player(si, hx, hy);
                        }
                        return false;
                    }
                    if self.city_at(hx, hy) {
                        if !harmless {
                            let r = self.rand(1.6, 2.6);
                            self.erode(hx + jsign(b.vx) * 1.5, hy, r);
                        }
                        self.booms.push(Boom { x: hx, y: hy, t0: t, col: [1.0, 0.55, 0.3], warp: false, splat: true });
                        self.fx.light(hx, hy, 0.4, 1.4, ORANGE, 0.2);
                        self.events.push(Ev::City);
                        return false;
                    }
                }
                true
            });
            bullets.append(&mut self.bullets);
            self.bullets = bullets;
        }

        // ---- announced shots, bombs, the battleship
        self.dt_last = dt;
        self.fire_pending(people);
        self.update_bombs(people, &by_slot);
        self.update_ship(people, &by_slot, inv, edt);
        self.update_edge_lasers(people, &by_slot, inv, dt);
        self.update_ship_death(dt);
        self.scorches.retain(|sc| t - sc.t0 < 4.0);
        // damaged invaders spark now and then
        for si in 0..self.sides.len() {
            for i in 0..self.sides[si].n() {
                let side = &self.sides[si];
                if side.alive[i] == 0 || side.hp[i] >= side.hp_max[i] || self.random() > dt * 3.0 {
                    continue;
                }
                let b = self.bx(si, i);
                let x = b.x + self.rand(1.0, b.w - 1.0);
                let y = b.y + self.rand(1.0, 7.0);
                let vx = self.rand(-12.0, 12.0);
                let vy = self.rand(-12.0, 12.0);
                let col = if self.random() < 0.5 { ORANGE } else { WHITE };
                self.particles.push(Particle { x, y, vx, vy, col, t0: t, life: 0.3 });
            }
        }

        // ---- the mothership
        if let Some(u) = self.ufo.as_mut() {
            u.x += u.vx * dt;
            if u.x < -20.0 || u.x > w + 4.0 {
                self.ufo = None;
                self.events.push(Ev::Ufo(false));
            }
        }

        // ---- cars drive along the streets; footprints fade
        for car in &mut self.cars {
            let Some(ln) = self.city.lanes.get(car.lane) else { continue };
            let len = ln.to - ln.from;
            if len > 0.0 {
                car.pos = ln.from + ((((car.pos - ln.from + car.speed * ln.dir * dt) % len) + len) % len);
            }
        }
        let foot_life = p.foot_life;
        self.footprints.retain(|f| t - f.t0 < foot_life);

        // ---- debris slides over the floor and stops (seen from above: no gravity)
        let damp = (-3.2 * dt).exp();
        self.particles.retain_mut(|q| {
            if t - q.t0 >= q.life {
                return false;
            }
            q.vx *= damp;
            q.vy *= damp;
            q.x += q.vx * dt;
            q.y += q.vy * dt;
            true
        });
        if self.particles.len() > 6000 {
            let extra = self.particles.len() - 6000;
            self.particles.drain(..extra);
        }
        self.booms.retain(|b| t - b.t0 < 0.25);
    }
}

/// typeOf: 0 = the column farthest from the city
fn type_of(edge: f64, cols: usize, c: usize) -> Kind {
    let outer = if edge < 0.0 { c } else { cols.saturating_sub(1).saturating_sub(c) };
    let k = if cols > 1 { jr((outer as f64 / (cols - 1) as f64) * 2.0) as usize } else { 2 };
    INVADER_TYPES[k.min(2)]
}
