//! What the people do (interact.js), read from their skeletons (ctx.persons, delayed mode: exact
//! joints):
//!   jump      the pelvis goes up (at least 6 cm) and comes down again: an event on landing; jumping
//!             jacks count too (strength: takeoff speed and height)
//!   charge    both hands above the head: fills in about a second when held, drains slowly, so many
//!             jumping jacks fill it too; 'erupt' when it is full
//!   open      the arms spread wide at shoulder height: 0..1 while held
//!   clap      the hands meet fast: an event between the hands
//!   upload    standing still for a few seconds: 0..1, back to 0 quickly when moving
//!   arcs      hands of two people close to each other: a link, 'touch' when they meet
//!   near      how close the nearest person is to the wall: 0..1
//! Events and positions are in the world space of ctx.persons (m), with the slot of the person they
//! belong to; mod.rs maps them to the mirror (each person is shifted on the wall on their own).

use std::collections::{HashMap, HashSet, VecDeque};

use wall::glam::Vec3;

use wall::persons::{Person, PersonsView, j};

fn clamp01(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}

fn smooth(a: f32, b: f32, x: f32) -> f32 {
    let t = clamp01((x - a) / (b - a));
    t * t * (3.0 - 2.0 * t)
}

fn len(v: Option<Vec3>) -> f32 {
    v.map(|v| v.length()).unwrap_or(0.0)
}

/// a joint seen with some confidence
fn ok(p: &Person, k: usize) -> Option<Vec3> {
    p.joints[k].filter(|_| p.confidence[k] >= 0.3)
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Jump,
    Clap,
    Erupt,
    Touch,
}

#[derive(Clone, Copy)]
pub struct Event {
    pub kind: Kind,
    pub at: Vec3,
    pub strength: f32,
    pub slot: u8,
    /// a touch: the two hands and their slots
    pub a: Vec3,
    pub b: Vec3,
    pub sa: u8,
    pub sb: u8,
}

/// the poses of one person (index into the visible persons)
pub struct Pose {
    pub index: usize,
    pub slot: u8,
    pub charge: f32,
    pub up: bool,
    pub open: f32,
    pub upload: f32,
}

/// hands of two people close together
#[derive(Clone, Copy)]
pub struct Link {
    pub a: Vec3,
    pub b: Vec3,
    pub sa: u8,
    pub sb: u8,
    pub strength: f32,
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum Phase {
    Ground,
    Up,
    Down,
}

struct State {
    phase: Phase,
    peak: f32,
    base: f32,
    top: f32,
    since: f32,
    cool: f32,
    pelvis: VecDeque<(f32, f32)>,
    charge: f32,
    up: bool,
    erupted: bool,
    open: f32,
    still: f32,
    upload: f32,
    hands: VecDeque<(f32, f32)>,
    clap_cool: f32,
    seen: f32,
}

impl State {
    fn new(t: f32) -> Self {
        Self {
            phase: Phase::Ground,
            peak: 0.0,
            base: 0.0,
            top: 0.0,
            since: t,
            cool: 0.0,
            pelvis: VecDeque::new(),
            charge: 0.0,
            up: false,
            erupted: false,
            open: 0.0,
            still: 0.0,
            upload: 0.0,
            hands: VecDeque::new(),
            clap_cool: 0.0,
            seen: t,
        }
    }
}

#[derive(Default)]
pub struct Interactions {
    states: HashMap<u32, State>,
    /// (idA, idB) pairs whose hands touch
    touching: HashSet<(u32, u32)>,
    pub events: Vec<Event>,
    pub people: Vec<Pose>,
    pub arcs: Vec<Link>,
    pub near: f32,
}

impl Interactions {
    /// persons: ctx.persons; front: the Kinect's distance from the wall (m). Fills events, people,
    /// arcs and near.
    pub fn update(&mut self, persons: &PersonsView, t: f32, dt: f32, front: f32) {
        self.events.clear();
        self.people.clear();
        self.arcs.clear();
        let fresh = persons.fresh;
        let mut near = 0.0_f32;
        for (index, p) in persons.visible.iter().enumerate() {
            let s = self.states.entry(p.id).or_insert_with(|| State::new(t));
            s.seen = t;
            let head = p.room.head.or(p.room.joints[j::NOSE]);
            let rl = p.room.joints[j::LEFT_HAND];
            let rr = p.room.joints[j::RIGHT_HAND];
            let lh = ok(p, j::LEFT_HAND);
            let rh = ok(p, j::RIGHT_HAND);

            // ---- jump: the pelvis goes up, then down, then stops (on fresh results; spikes ignored)
            let vy = p.motion[j::PELVIS].or(p.motion[j::CENTER]).unwrap_or(Vec3::ZERO).y;
            let py = p.room.joints[j::PELVIS].map(|v| v.y);
            if let Some(py) = py
                && fresh
                && vy.abs() < 4.0
            {
                s.pelvis.push_back((t, py));
                while s.pelvis.front().is_some_and(|h| h.0 < t - 0.6) {
                    s.pelvis.pop_front();
                }
                if s.phase == Phase::Ground && vy > 0.45 && t > s.cool {
                    s.phase = Phase::Up;
                    s.peak = vy;
                    s.base = s.pelvis.iter().map(|h| h.1).fold(f32::INFINITY, f32::min);
                    s.top = py;
                    s.since = t;
                } else if s.phase == Phase::Up {
                    s.peak = s.peak.max(vy);
                    s.top = s.top.max(py);
                    if vy < -0.35 {
                        s.phase = Phase::Down;
                    } else if t - s.since > 1.0 {
                        s.phase = Phase::Ground;
                    }
                } else if s.phase == Phase::Down {
                    s.top = s.top.max(py);
                    if vy > -0.12 || t - s.since > 1.4 {
                        s.phase = Phase::Ground;
                        s.cool = t + 0.25;
                        let rise = s.top - s.base;
                        if rise > 0.06
                            && rise < 0.9
                            && let Some(ground) = p.ground
                        {
                            let strength = clamp01(0.25 + (s.peak - 0.4) / 1.4 + rise * 1.2);
                            self.events.push(Event { kind: Kind::Jump, at: ground, strength, slot: p.slot, a: Vec3::ZERO, b: Vec3::ZERO, sa: 0, sb: 0 });
                        }
                    }
                }
            }

            // ---- both hands above the head: charge, then erupt
            let up = match (head, rl, rr, lh, rh) {
                (Some(head), Some(rl), Some(rr), Some(_), Some(_)) => rl.y > head.y + 0.05 && rr.y > head.y + 0.05,
                _ => false,
            };
            s.up = up;
            s.charge = clamp01(s.charge + if up { dt / 1.1 } else { -dt / 3.0 });
            if s.charge >= 1.0
                && !s.erupted
                && let (Some(lh), Some(rh)) = (lh, rh)
            {
                s.erupted = true;
                self.events.push(Event { kind: Kind::Erupt, at: (lh + rh) / 2.0, strength: 1.0, slot: p.slot, a: Vec3::ZERO, b: Vec3::ZERO, sa: 0, sb: 0 });
            }
            if s.charge < 0.3 {
                s.erupted = false;
            }

            // ---- arms spread wide at shoulder height
            let ls = p.room.joints[j::LEFT_SHOULDER];
            let rs = p.room.joints[j::RIGHT_SHOULDER];
            let mut wide = false;
            if let (Some(rl), Some(rr), Some(ls), Some(rs), Some(_), Some(_)) = (rl, rr, ls, rs, lh, rh) {
                let span = (rl.x - rr.x).hypot(rl.z - rr.z);
                let shoulders = (ls.x - rs.x).hypot(ls.z - rs.z);
                let sh = (ls.y + rs.y) / 2.0;
                wide = span > 1.15_f32.max(2.6 * shoulders) && (rl.y - sh).abs() < 0.3 && (rr.y - sh).abs() < 0.3;
            }
            s.open = clamp01(s.open + if wide { dt / 0.7 } else { -dt / 1.2 });

            // ---- clap: the hands were apart and meet fast
            if let (Some(lh), Some(rh)) = (lh, rh)
                && fresh
            {
                let d = lh.distance(rh);
                s.hands.push_back((t, d));
                while s.hands.front().is_some_and(|h| h.0 < t - 0.45) {
                    s.hands.pop_front();
                }
                let before = s.hands.iter().map(|h| h.1).fold(f32::NEG_INFINITY, f32::max);
                if d < 0.2 && before > 0.5 && t > s.clap_cool {
                    s.clap_cool = t + 0.5;
                    self.events.push(Event { kind: Kind::Clap, at: (lh + rh) / 2.0, strength: clamp01((before - 0.3) / 0.8), slot: p.slot, a: Vec3::ZERO, b: Vec3::ZERO, sa: 0, sb: 0 });
                }
            }

            // ---- standing still: upload
            let moving = p.velocity.length().max(len(p.motion[j::LEFT_HAND])).max(len(p.motion[j::RIGHT_HAND])).max(len(p.motion[j::HEAD]));
            s.still = if moving < 0.3 { s.still + dt } else { (s.still - dt * 4.0).max(0.0) };
            s.upload = smooth(2.5, 7.0, s.still);

            // ---- close to the wall
            if let Some(c) = p.room.center {
                near = near.max(smooth(1.5, 0.9, c.z + front));
            }

            self.people.push(Pose { index, slot: p.slot, charge: s.charge, up: s.up, open: s.open, upload: s.upload });
        }

        // ---- hands of two people close together
        let list = &persons.visible;
        for i in 0..list.len() {
            for k in i + 1..list.len() {
                let (pa, pb) = (&list[i], &list[k]);
                let mut best: Option<(Vec3, Vec3, f32)> = None;
                for ha in [j::LEFT_HAND, j::RIGHT_HAND] {
                    for hb in [j::LEFT_HAND, j::RIGHT_HAND] {
                        let (Some(a), Some(b)) = (ok(pa, ha), ok(pb, hb)) else {
                            continue;
                        };
                        let d = a.distance(b);
                        if best.is_none_or(|(_, _, bd)| d < bd) {
                            best = Some((a, b, d));
                        }
                    }
                }
                let key = (pa.id.min(pb.id), pa.id.max(pb.id));
                let Some((a, b, d)) = best.filter(|(_, _, d)| *d <= 1.1) else {
                    self.touching.remove(&key);
                    continue;
                };
                let arc = Link { a, b, sa: pa.slot, sb: pb.slot, strength: smooth(1.1, 0.25, d) };
                self.arcs.push(arc);
                if d < 0.15 && !self.touching.contains(&key) {
                    self.touching.insert(key);
                    self.events.push(Event { kind: Kind::Touch, at: (a + b) / 2.0, strength: 1.0, slot: pa.slot, a, b, sa: pa.slot, sb: pb.slot });
                } else if d > 0.3 {
                    self.touching.remove(&key);
                }
            }
        }

        self.states.retain(|_, s| t - s.seen <= 3.0);
        self.near = near;
    }
}
