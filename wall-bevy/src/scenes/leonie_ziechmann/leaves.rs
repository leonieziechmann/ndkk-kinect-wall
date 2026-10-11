//! The autumn leaves (leaves.js), simulated in wall meters (x from the left edge, y above the floor)
//! and drawn as pixel leaves on the LED image (leafpix.rs).
//!
//! Leaves come loose from the crowns (forest.rs `spots`): a few all the time, many where something
//! moves up there (arms reaching into the crowns, a jump: kicks of the body field), and where a
//! gust runs through. In the air they sway and turn, the wind carries them, and a moving outline
//! sweeps them along. They come to rest on the forest floor, on the top edges of the cards (and
//! slide off them after a while), and on the shoulders and heads of people standing still, who
//! carry them along until they move. Feet kick the leaves on the floor up again. Someone arriving
//! sends a gust across the wall; with nobody there, gusts come by themselves. Leaves falling onto
//! the leaf heap join it (heap.rs); the heap's own leaves, blown off, fly in front of everything.

use super::forest::{Rolling, Spot, palettes, pick_color};
use super::heap::Heap;
use super::layout::{TURN, js_round};
use super::leafpix::{FLAT, Palette, ROUND, Raster, Sprite, blit, px};
use super::persp::Place;
use super::bodies::Field;
use crate::scenes::common::rand::Rng;

/// body field results per second (kicks are "cells moved" per result)
const KICK_HZ: f64 = 30.0;
const MAX_LEAVES: usize = 900;
/// m: width of a crown section
const BIN: f64 = 0.5;

/// the motes: core bright, core dim, glow (alpha 254: behind the cards)
fn motes_px() -> [u32; 3] {
    [[0xff, 0xf4, 0xc4], [0xe8, 0xcf, 0x86], [0xa8, 0x92, 0x5a]].map(|c| px(c, 254))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Air,
    OnPerson,
    OnGround,
    OnCard,
}

/// A rect leaves can lie on (LED px): the card, a sign (turned, its top edge), the signpost.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RestRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub angle: f64,
    /// the top edge's middle (signs), else the rect's top middle
    pub top: Option<[f64; 2]>,
    /// the board's width (signs), else w
    pub bw: Option<f64>,
    pub sign: bool,
}

/// Where leaves rest on a card: its top edge (m), sloped if the board is turned.
#[derive(Clone, Copy, Debug)]
struct Card {
    x0: f64,
    x1: f64,
    cx: f64,
    y: f64,
    slope: f64,
    angle: f64,
    sign: bool,
    px: RestRect,
}

struct Gust {
    x0: f64,
    dir: f64,
    str: f64,
    t0: f64,
    speed: f64,
    width: f64,
    life: f64,
}

struct Mote {
    x: f64,
    y: f64,
    vx: f64,
    vy: f64,
    ph: f64,
    sp: f64,
    big: bool,
    glow: f64,
}

struct Leaf {
    x: f64,
    y: f64,
    vx: f64,
    vy: f64,
    rot: f64,
    spin: f64,
    fp: f64,
    fs: f64,
    fall: f64,
    size: f64,
    c: usize,
    state: State,
    ground: f64,
    g_off: f64,
    age: f64,
    life: f64,
    on: u32,
    ox: f64,
    oy: f64,
    flip: f64,
    /// the card it lies on (a copy: as the browser keeps the old card object after a new layout)
    /// and which one it is (layout generation, index)
    card: Option<(Card, (u32, usize))>,
    /// the card it falls in front of now (layout generation, index)
    skip: Option<(u32, usize)>,
    front: bool,
    spr_key: Option<(u8, i64, i64)>,
    spr: Sprite,
}

/// The params the leaves read (once per frame).
#[derive(Clone, Copy)]
pub struct LeafParams {
    pub laub: f64,
    pub shake: f64,
    pub wind: f64,
    pub kick: f64,
    pub stick: bool,
    pub cards: bool,
    pub pile: f64,
}

/// What the layout depends on (leaves.js key).
#[derive(Clone, PartialEq)]
struct Key {
    w: f64,
    h: f64,
    size_w: f32,
    size_h: f32,
    bottom: f32,
    spots: usize,
    rects: Vec<RestRect>,
}

pub struct Leaves {
    list: Vec<Leaf>,
    /// sprite buffers of removed leaves, for new ones (no allocation while it runs)
    pool: Vec<Sprite>,
    gusts: Vec<Gust>,
    next_gust: f64,
    last_arrival: f64,
    field_seq: Option<u64>,
    shake: Vec<f64>,
    acc: Vec<f64>,
    key: Option<Key>,
    w: usize,
    h: usize,
    s: f64,
    wall_w: f64,
    top: f64,
    kx: f64,
    ky: f64,
    ground_top: f64,
    canopy_low: f64,
    cards: Vec<Card>,
    cards_gen: u32,
    bins: Vec<Vec<Spot>>,
    motes: Vec<Mote>,
    ground_fn: Option<Rolling>,
    pal_front: [Palette; 7],
    pal_behind: [Palette; 7],
    pal_sign: [Palette; 7],
    mote_px: [u32; 3],
    ras: Raster,
    rng: Rng,
    /// scratch: the leaves on the floor by age (pile limit)
    by_age: Vec<(f64, usize)>,
    drop: Vec<bool>,
}

impl Leaves {
    pub fn new() -> Self {
        Self {
            list: Vec::with_capacity(MAX_LEAVES + 32),
            pool: Vec::new(),
            gusts: Vec::new(),
            next_gust: 3.0,
            last_arrival: -9.0,
            field_seq: None,
            shake: Vec::new(),
            acc: Vec::new(),
            key: None,
            w: 0,
            h: 0,
            s: 1.0,
            wall_w: 6.0,
            top: 2.0,
            kx: 1.0,
            ky: 1.0,
            ground_top: 0.0,
            canopy_low: 0.0,
            cards: Vec::new(),
            cards_gen: 0,
            bins: Vec::new(),
            motes: Vec::new(),
            ground_fn: None,
            pal_front: palettes(255),
            pal_behind: palettes(254),
            pal_sign: palettes(253),
            mote_px: motes_px(),
            ras: Raster::new(),
            rng: Rng::from_time(),
            by_age: Vec::with_capacity(MAX_LEAVES + 32),
            drop: Vec::with_capacity(MAX_LEAVES + 32),
        }
    }

    fn mx(&self, px: f64) -> f64 {
        px / self.kx
    }

    fn my(&self, py: f64) -> f64 {
        self.top - py / self.ky
    }

    /// Size, crowns and the cards for the layout (call every frame; cheap if nothing changed).
    /// rects: what leaves can lie on (LED px).
    #[allow(clippy::too_many_arguments)]
    pub fn layout(&mut self, w: f64, h: f64, s: f64, ground: f64, canopy: f64, size_w: f32, size_h: f32, bottom: f32, spots: &[Spot], rects: &[RestRect], ground_fn: Option<Rolling>) {
        self.ground_fn = ground_fn;
        let same = self.key.as_ref().is_some_and(|k| k.w == w && k.h == h && k.size_w == size_w && k.size_h == size_h && k.bottom == bottom && k.spots == spots.len() && k.rects == rects);
        if same {
            return;
        }
        self.key = Some(Key { w, h, size_w, size_h, bottom, spots: spots.len(), rects: rects.to_vec() });
        self.w = w.max(0.0) as usize;
        self.h = h.max(0.0) as usize;
        self.s = s;
        self.wall_w = f64::from(size_w);
        self.top = f64::from(bottom) + f64::from(size_h);
        self.kx = w / f64::from(size_w);
        self.ky = h / f64::from(size_h);
        self.ground_top = self.my(ground + 2.0 * s);
        self.canopy_low = self.my(canopy);
        // where leaves can rest: a card's or board's top edge (m), sloped if the board is turned
        self.cards_gen = self.cards_gen.wrapping_add(1);
        self.cards = rects
            .iter()
            .map(|r| {
                let slope = r.angle.tan();
                let [tx, ty] = r.top.unwrap_or([r.x + r.w / 2.0, r.y]);
                let half = (r.bw.unwrap_or(r.w) / 2.0) * r.angle.cos() - 8.0 * s;
                Card { x0: self.mx(tx - half), x1: self.mx(tx + half), cx: self.mx(tx), y: self.my(ty), slope: (-slope * self.kx) / self.ky, angle: r.angle, sign: r.sign, px: *r }
            })
            .collect();
        // the crowns' hanging leaves by section, in m
        let nb = ((self.wall_w / BIN).ceil() as usize).max(1);
        self.bins = (0..nb).map(|_| Vec::new()).collect();
        for &(x, y, c) in spots {
            let b = ((self.mx(x) / BIN).floor().max(0.0) as usize).min(nb - 1);
            let entry = (self.mx(x), self.my(y), c);
            self.bins[b].push(entry);
        }
        self.shake = vec![0.0; nb];
        self.acc = vec![0.0; nb];
        let wall_w = self.wall_w;
        let pool = &mut self.pool;
        self.list.retain_mut(|q| {
            let keep = q.x < wall_w + 0.5;
            if !keep {
                pool.push(std::mem::take(&mut q.spr));
            }
            keep
        });
        // light motes drifting in the air of the wood
        let n = js_round((w / s / 1008.0) * 60.0).max(0.0) as usize;
        let rng = &mut self.rng;
        self.motes = (0..n)
            .map(|_| {
                let x = rng.f64() * w;
                let y = rng.f64() * ground * 0.95;
                let vx = (rng.f64() - 0.5) * 6.0;
                let vy = (rng.f64() - 0.5) * 3.0;
                let ph = rng.f64() * TURN;
                let sp = 0.6 + rng.f64() * 1.8;
                let big = rng.f64() < 0.3;
                Mote { x, y, vx, vy, ph, sp, big, glow: 0.0 }
            })
            .collect();
    }

    /// where a leaf at x (m) lies on the ground (m): the near ground's line, `off` 0..1 deeper in
    fn ground_at(&self, x: f64, off: f64) -> f64 {
        let px = x * self.kx;
        let gy = match &self.ground_fn {
            Some(g) => g.at(px),
            None => (self.top - self.ground_top) * self.ky,
        };
        self.my(gy + 2.0 * self.s + off * (self.h as f64 - 4.0 * self.s - gy).max(0.0))
    }

    /// The air: a slow breeze, gusts running across the wall, and the air walking people push.
    fn wind(&self, x: f64, y: f64, t: f64, p: &LeafParams, places: &[Place]) -> [f64; 2] {
        let mut wx = p.wind * (0.12 + 0.1 * (t * 0.21).sin() + 0.05 * (t * 0.53 + x * 0.7).sin());
        let mut wy = p.wind * 0.05 * (t * 0.37 + x * 1.3).sin();
        for g in &self.gusts {
            let age = t - g.t0;
            let front = g.x0 + g.dir * g.speed * age;
            let env = (age * 3.0).min(1.0) * (1.0 - age / g.life).max(0.0);
            let amp = g.str * env * (-((x - front) / g.width).powi(2)).exp();
            wx += g.dir * amp;
            wy += amp * 0.4 * (y * 3.0 + age * 4.0).sin();
        }
        for pl in places {
            let dx = (x - pl.x).abs();
            if dx > 0.8 || y > pl.top + 0.35 || y < pl.feet - 0.1 {
                continue;
            }
            wx += pl.vx * (1.0 - dx / 0.8) * 0.8 * p.kick;
        }
        [wx, wy]
    }

    fn gust(&mut self, x0: f64, dir: f64, str: f64, t: f64) {
        self.gusts.push(Gust { x0, dir, str, t0: t, speed: 2.6, width: 0.9, life: (self.wall_w + 2.0) / 2.6 });
    }

    /// a leaf from elsewhere (the heap): size in LED px, front: in front of the cards
    #[allow(clippy::too_many_arguments)]
    pub fn spawn_free(&mut self, x: f64, y: f64, vx: f64, vy: f64, c: usize, size: f64, front: bool) {
        if let Some(i) = self.spawn(x, y, vx, vy, Some(c)) {
            let spin = (self.rng.f64() - 0.5) * 10.0;
            let q = &mut self.list[i];
            q.size = size;
            q.front = front;
            q.spin = spin;
        }
    }

    fn spawn(&mut self, x: f64, y: f64, vx: f64, vy: f64, c: Option<usize>) -> Option<usize> {
        if self.list.len() >= MAX_LEAVES {
            // make room: the oldest leaf on the floor goes
            let mut oldest: Option<usize> = None;
            for (i, q) in self.list.iter().enumerate() {
                if q.state == State::OnGround && oldest.is_none_or(|o| q.age > self.list[o].age) {
                    oldest = Some(i);
                }
            }
            let o = oldest?;
            let q = self.list.remove(o);
            self.pool.push(q.spr);
        }
        let r = &mut self.rng;
        let rot = (r.f64() - 0.5) * 1.2;
        let spin = (r.f64() - 0.5) * 3.0;
        let fp = r.f64() * TURN;
        let fs = 2.2 + r.f64() * 2.2;
        let fall = 0.32 + r.f64() * 0.22;
        let size = (8.0 + r.f64() * 4.0) * self.s;
        let c = c.unwrap_or_else(|| pick_color(r.f64()));
        let g_off = r.f64().powf(1.5);
        let spr = self.pool.pop().unwrap_or_default();
        self.list.push(Leaf {
            x,
            y,
            vx,
            vy,
            rot,
            spin,
            fp,
            fs,
            fall,
            size,
            c,
            state: State::Air,
            ground: 0.0,
            g_off,
            age: 0.0,
            life: 0.0,
            on: 0,
            ox: 0.0,
            oy: 0.0,
            flip: 1.0,
            card: None,
            skip: None,
            front: false,
            spr_key: None,
            spr,
        });
        Some(self.list.len() - 1)
    }

    /// The person whose body is at wall point (x, y): the nearest placement around it.
    fn person_at(places: &[Place], x: f64, y: f64) -> Option<&Place> {
        let mut best = None;
        let mut bd = 0.55;
        for pl in places {
            if y > pl.top + 0.25 || y < pl.feet - 0.1 {
                continue;
            }
            let d = (x - pl.x).abs();
            if d < bd {
                bd = d;
                best = Some(pl);
            }
        }
        best
    }

    fn under_card(&self, x: f64, y: f64) -> bool {
        let px = x * self.kx;
        let py = (self.top - y) * self.ky;
        self.cards.iter().any(|c| {
            let r = &c.px;
            px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h
        })
    }

    /// One step. places: the people on the wall this frame (persp.rs), entered: ids of the people
    /// arriving now, t/dt: s.
    #[allow(clippy::too_many_arguments)]
    pub fn update(&mut self, t: f64, dt: f64, p: &LeafParams, field: Option<&Field>, places: &[Place], entered: &[u32], heap: &mut Heap) {
        let dt = dt.min(0.05);
        if self.bins.is_empty() {
            return;
        }
        let someone = !places.is_empty();

        // gusts: someone arrives (from the side they come from), or now and then
        for id in entered {
            if t - self.last_arrival < 2.0 {
                break; // a group arriving is one gust
            }
            self.last_arrival = t;
            let Some(pl) = places.iter().find(|q| q.id == *id) else { continue };
            let dir = if pl.vx.abs() > 0.2 {
                pl.vx.signum()
            } else if pl.x < self.wall_w / 2.0 {
                1.0
            } else {
                -1.0
            };
            let (x, str) = (pl.x - dir * 0.5, 1.1 * p.wind + 0.4);
            self.gust(x, dir, str, t);
        }
        if t > self.next_gust {
            self.next_gust = t + (if someone { 16.0 } else { 8.0 }) * (0.7 + self.rng.f64() * 0.6);
            let dir = if self.rng.f64() < 0.7 { 1.0 } else { -1.0 };
            let x0 = if dir > 0.0 { -1.0 } else { self.wall_w + 1.0 };
            let str = (0.5 + self.rng.f64() * 0.6) * p.wind;
            self.gust(x0, dir, str, t);
        }
        self.gusts.retain(|g| t - g.t0 < g.life);

        // ---- the crowns: shaken by moving bodies up there (arms, jumps) and by gusts
        let field = field.filter(|f| f.w > 0);
        let fresh = field.is_some_and(|f| Some(f.seq) != self.field_seq);
        if let Some(f) = field
            && fresh
        {
            self.field_seq = Some(f.seq);
        }
        let nb = self.bins.len();
        for b in 0..nb {
            self.shake[b] *= (-dt * 2.2).exp();
            if let Some(f) = field
                && fresh
            {
                let cell = f64::from(f.cell);
                let cx0 = ((b as f64 * BIN) / cell).floor().max(0.0) as usize;
                let cx1 = (((b + 1) as f64 * BIN) / cell).floor().min((f.w - 1) as f64).max(-1.0);
                let cy1 = ((self.top - self.canopy_low + 0.12) / cell).floor().min((f.h - 1) as f64);
                let mut sum = 0.0;
                if cx1 >= 0.0 && cy1 >= 0.0 {
                    let (cx1, cy1) = (cx1 as usize, cy1 as usize);
                    let mut cy = 0;
                    while cy <= cy1 {
                        let mut cx = cx0;
                        while cx <= cx1 {
                            let c = cy * f.w + cx;
                            sum += f64::from(f.kx.get(c).copied().unwrap_or(0.0).abs() + f.ky.get(c).copied().unwrap_or(0.0).abs());
                            cx += 2;
                        }
                        cy += 2;
                    }
                }
                self.shake[b] = (self.shake[b] + sum * 0.012 * p.shake).min(2.0);
            }
            let bx = (b as f64 + 0.5) * BIN;
            let w2 = self.wind(bx, self.canopy_low, t, p, places);
            let gusty = (w2[0].abs() - 0.3 * p.wind).max(0.0);
            self.acc[b] += dt * ((p.laub / nb as f64) * (1.0 + gusty * 6.0) + self.shake[b] * 16.0 * p.shake);
            while self.acc[b] >= 1.0 {
                self.acc[b] -= 1.0;
                let len = self.bins[b].len();
                if len == 0 {
                    continue;
                }
                let k = ((self.rng.f64() * len as f64).floor() as usize).min(len - 1);
                let (x, y, c) = self.bins[b][k];
                let sh = self.shake[b];
                let vx = (self.rng.f64() - 0.5) * 0.3 + sh * (self.rng.f64() - 0.5) * 1.2;
                let vy = -0.05 - self.rng.f64() * 0.15;
                self.spawn(x, y, vx, vy, Some(c));
            }
        }

        // ---- the light motes: drifting slowly with the breeze, twinkling
        let mut motes = std::mem::take(&mut self.motes);
        for m in &mut motes {
            let w2 = self.wind(m.x / self.kx, self.my(m.y), t, p, places);
            m.x += (m.vx + w2[0] * 12.0) * dt;
            m.y += (m.vy + (t * 0.7 + m.ph).sin() * 4.0) * dt;
            if m.x < -4.0 {
                m.x += self.w as f64 + 8.0;
            }
            if m.x > self.w as f64 + 4.0 {
                m.x -= self.w as f64 + 8.0;
            }
            if m.y < 2.0 || m.y > self.h as f64 * 0.85 {
                m.vy = -m.vy;
            }
            m.glow = 0.5 + 0.5 * (t * m.sp + m.ph).sin();
        }
        self.motes = motes;

        // ---- the leaves
        let kick_gain = field.map(|f| f64::from(f.cell) * KICK_HZ * 1.3 * p.kick).unwrap_or(0.0);
        let mut list = std::mem::take(&mut self.list);
        let mut on_ground = 0usize;
        let mut keep_n = 0;
        for i in 0..list.len() {
            let keep = self.step(&mut list[i], t, dt, p, field, places, kick_gain, heap, &mut on_ground);
            if keep {
                list.swap(keep_n, i);
                keep_n += 1;
            }
        }
        for q in list.drain(keep_n..) {
            self.pool.push(q.spr);
        }
        // the floor keeps at most `pile` leaves: the oldest go
        if on_ground as f64 > p.pile {
            self.by_age.clear();
            self.by_age.extend(list.iter().enumerate().filter(|(_, q)| q.state == State::OnGround).map(|(i, q)| (q.age, i)));
            self.by_age.sort_by(|a, b| b.0.total_cmp(&a.0));
            let n_drop = (on_ground as f64 - p.pile).max(0.0) as usize;
            self.drop.clear();
            self.drop.resize(list.len(), false);
            for &(_, i) in self.by_age.iter().take(n_drop) {
                self.drop[i] = true;
            }
            let mut k = 0;
            let drop = &self.drop;
            let pool = &mut self.pool;
            list.retain_mut(|q| {
                let d = drop.get(k).copied().unwrap_or(false);
                k += 1;
                if d {
                    pool.push(std::mem::take(&mut q.spr));
                }
                !d
            });
        }
        self.list = list;
    }

    /// One leaf's step; false: it is gone.
    #[allow(clippy::too_many_arguments)]
    fn step(&mut self, q: &mut Leaf, t: f64, dt: f64, p: &LeafParams, field: Option<&Field>, places: &[Place], kick_gain: f64, heap: &mut Heap, on_ground: &mut usize) -> bool {
        let top = self.top;
        q.age += dt;
        q.fp += q.fs * dt;

        if q.state == State::OnPerson {
            match places.iter().find(|pl| pl.id == q.on) {
                None => {
                    q.state = State::Air;
                    q.vy = 0.1;
                }
                Some(pl) => {
                    q.x = pl.x + q.ox;
                    q.y = pl.top + q.oy;
                    let mut release = pl.vx.abs() > 1.1 && self.rng.f64() < dt * 3.0;
                    if let Some(f) = field {
                        let smp = sample(f, q.x, q.y, top);
                        let (kx, ky) = kick_at(f, q.x, q.y, top);
                        if kx.hypot(ky) > 0.3 {
                            release = true;
                            q.vx = kx * kick_gain * 1.4 + (self.rng.f64() - 0.5) * 0.4;
                            q.vy = ky * kick_gain * 1.4 + 0.3 + self.rng.f64() * 0.3;
                        } else if smp[0] > 0.06 {
                            release = true; // the body moved away under it
                        } else if smp[0] < -0.025 {
                            // sank in (the outline changed): ride up to the surface
                            let gl = nonzero(smp[1].hypot(smp[2]));
                            q.ox += (smp[1] / gl) * (-0.012 - smp[0]) * 0.5;
                            q.oy += (smp[2] / gl) * (-0.012 - smp[0]) * 0.5;
                        }
                    }
                    if release || !p.stick || self.under_card(q.x, q.y) {
                        q.state = State::Air;
                        q.vx += pl.vx;
                        q.spin = (self.rng.f64() - 0.5) * 8.0;
                    }
                    if q.state == State::OnPerson {
                        return true;
                    }
                }
            }
        }

        if q.state == State::OnCard {
            // lies on a card's top edge; after a while it slides to the nearer end and drops off
            match q.card {
                None => q.state = State::Air,
                Some((cd, which)) => {
                    let mut go = false;
                    if let Some(f) = field {
                        let (kx, ky) = kick_at(f, q.x, q.y + 0.03, top);
                        if kx.hypot(ky) > 0.25 {
                            go = true;
                            q.vx = kx * kick_gain;
                            q.vy = 0.4 + self.rng.f64() * 0.4;
                        }
                    }
                    if q.age > q.life {
                        let dir = if cd.slope.abs() > 0.02 {
                            if cd.slope > 0.0 { -1.0 } else { 1.0 }
                        } else if q.x - cd.x0 < cd.x1 - q.x {
                            -1.0
                        } else {
                            1.0
                        };
                        q.x += dir * 0.12 * dt;
                        q.y = cd.y + cd.slope * (q.x - cd.cx) + 0.015;
                        q.rot += dir * 0.4 * dt;
                        if q.x < cd.x0 - 0.02 || q.x > cd.x1 + 0.02 {
                            go = true;
                            q.vx = dir * 0.15;
                            q.vy = 0.0;
                        }
                    }
                    if !go {
                        return true;
                    }
                    q.state = State::Air;
                    q.age = 0.0;
                    q.skip = Some(which); // falls in front of that card now, does not land on it again
                }
            }
        }

        if q.state == State::OnGround {
            // on the floor: lies until feet or a strong gust lift it
            let mut lift = false;
            if let Some(f) = field
                && q.age > 0.3
            {
                let (kx, ky) = kick_at(f, q.x, q.y + 0.05, top);
                if kx.hypot(ky) > 0.2 {
                    lift = true;
                    q.vx = kx * kick_gain * 1.2;
                    q.vy = 0.5 + self.rng.f64() * 0.6;
                }
            }
            if !lift && self.rng.f64() < dt * 0.6 {
                let w2 = self.wind(q.x, q.y, t, p, places);
                if w2[0].abs() > 0.8 {
                    lift = true;
                    q.vx = w2[0];
                    q.vy = 0.3 + self.rng.f64() * 0.5;
                }
            }
            if lift {
                q.state = State::Air;
                q.age = 0.0;
            } else {
                *on_ground += 1;
                return true;
            }
        }

        // in the air
        let w2 = self.wind(q.x, q.y, t, p, places);
        let flutter = q.fp.sin() * 0.25;
        q.vx += (w2[0] + flutter - q.vx) * (2.2 * dt).min(1.0);
        q.vy += (w2[1] - q.fall - q.vy) * (1.8 * dt).min(1.0);
        if let Some(f) = field {
            let smp = sample(f, q.x, q.y, top);
            let (kx, ky) = kick_at(f, q.x, q.y, top);
            let km = kx.hypot(ky);
            if km > 0.06 {
                // a moving outline sweeps the leaf along
                let a = (km * 0.8).min(1.0);
                q.vx += (kx * kick_gain - q.vx) * a;
                q.vy += (ky * kick_gain + 0.15 - q.vy) * a;
                q.spin += (self.rng.f64() - 0.5) * km * 6.0;
            }
            if smp[0] < 0.0 {
                let gl = nonzero(smp[1].hypot(smp[2]));
                let nx = smp[1] / gl;
                let ny = smp[2] / gl;
                let pl = if p.stick && km < 0.15 && q.vy < 0.05 && ny > 0.2 && !self.under_card(q.x, q.y) { Self::person_at(places, q.x, q.y) } else { None };
                if let Some(pl) = pl
                    && self.rng.f64() < 0.75
                {
                    // lands on a person standing still: stays on the surface and rides along
                    q.x += nx * (-0.012 - smp[0]);
                    q.y += ny * (-0.012 - smp[0]);
                    q.state = State::OnPerson;
                    q.on = pl.id;
                    q.ox = q.x - pl.x;
                    q.oy = q.y - pl.top;
                    q.vx = 0.0;
                    q.vy = 0.0;
                    q.rot = nx.atan2(-ny) + std::f64::consts::PI / 2.0 + (self.rng.f64() - 0.5) * 0.9;
                    q.flip = (if self.rng.f64() < 0.5 { -1.0 } else { 1.0 }) * (0.55 + self.rng.f64() * 0.35);
                    return true;
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
        let y0 = q.y;
        q.x += q.vx * dt;
        q.y += q.vy * dt;
        q.rot += q.spin * dt;
        q.spin *= (-dt * 0.8).exp();
        // a card's top edge
        if q.vy < 0.0 && p.cards {
            let mut landed = false;
            for (ci, cd) in self.cards.iter().enumerate() {
                let ey = cd.y + cd.slope * (q.x - cd.cx);
                if q.skip == Some((self.cards_gen, ci)) || q.x < cd.x0 || q.x > cd.x1 || y0 < ey || q.y > ey {
                    continue;
                }
                if self.rng.f64() < 0.7 {
                    q.state = State::OnCard;
                    q.card = Some((*cd, (self.cards_gen, ci)));
                    q.y = ey + 0.012 + self.rng.f64() * 0.01;
                    q.vx = 0.0;
                    q.vy = 0.0;
                    q.age = 0.0;
                    q.life = 5.0 + self.rng.f64() * 14.0;
                    q.rot = (if self.rng.f64() < 0.5 { -1.0 } else { 1.0 }) * (std::f64::consts::PI / 2.0 + (self.rng.f64() - 0.5) * 0.5) + cd.angle;
                    q.flip = (if self.rng.f64() < 0.5 { -1.0 } else { 1.0 }) * (0.5 + self.rng.f64() * 0.3);
                    landed = true;
                } else {
                    q.skip = Some((self.cards_gen, ci));
                }
                break;
            }
            if landed {
                return true;
            }
        }
        // onto the leaf heap: joins it
        if !q.front && q.vy <= 0.0 {
            let px = q.x * self.kx;
            let hh = heap.height_at(px);
            if hh > 0.0 && q.y <= self.top - self.h as f64 / self.ky + hh / self.ky {
                heap.feed(px);
                return false;
            }
        }
        if q.vy <= 0.0 && q.y < self.ground_top + 0.2 {
            q.ground = self.ground_at(q.x, q.g_off);
        }
        if q.y <= q.ground && q.vy <= 0.0 {
            q.y = q.ground;
            q.state = State::OnGround;
            q.age = 0.0;
            q.vx = 0.0;
            q.vy = 0.0;
            q.skip = None;
            q.rot = (if self.rng.f64() < 0.5 { -1.0 } else { 1.0 }) * (std::f64::consts::PI / 2.0 + (self.rng.f64() - 0.5) * 1.1);
            q.flip = (if self.rng.f64() < 0.5 { -1.0 } else { 1.0 }) * (0.6 + self.rng.f64() * 0.35);
            *on_ground += 1;
        }
        !(q.x < -0.4 || q.x > self.wall_w + 0.4 || q.y > self.top + 0.6)
    }

    /// Draws the leaves into buf (u32 RGBA over the LED image). ground true: only those lying on
    /// the floor (drawn before the heap); false: all others and the light motes, the air last. The
    /// alpha says where render.rs puts them: 255 in front of the contact card (lying on it), 253 at
    /// the signs' depth (lying on a sign), 254 the rest (in front of the wood, behind the card).
    pub fn draw(&mut self, buf: &mut [u32], ground: bool) -> usize {
        let (w, h) = (self.w, self.h);
        if w == 0 || h == 0 {
            return 0;
        }
        let (kx, ky, top) = (self.kx, self.ky, self.top);
        let mut n = 0;
        if !ground {
            // the light motes: a bright pixel, a little cross of glow when they shine
            for m in &self.motes {
                if m.glow < 0.25 {
                    continue;
                }
                let x = js_round(m.x);
                let y = js_round(m.y);
                if !(x >= 1.0 && y >= 1.0 && x < (w - 1) as f64 && y < (h - 1) as f64) {
                    continue;
                }
                let k = y as usize * w + x as usize;
                if let Some(p) = buf.get_mut(k) {
                    *p = if m.glow > 0.6 { self.mote_px[0] } else { self.mote_px[1] };
                }
                if m.big && m.glow > 0.7 {
                    for d in [k + 1, k - 1, k + w, k - w] {
                        if let Some(p) = buf.get_mut(d)
                            && *p == 0
                        {
                            *p = self.mote_px[2];
                        }
                    }
                }
            }
        }
        let passes: &[State] = if ground { &[State::OnGround] } else { &[State::OnCard, State::OnPerson, State::Air] };
        let Self { list, ras, pal_front, pal_behind, pal_sign, .. } = self;
        for &pass in passes {
            for q in list.iter_mut() {
                if q.state != pass {
                    continue;
                }
                let mut rot = q.rot;
                let mut flip = q.flip;
                if pass == State::Air {
                    // swinging and turning while it falls
                    rot += q.fp.sin() * 0.55;
                    flip = (q.fp * 0.6 + q.fs).cos();
                }
                let pals = if pass == State::OnCard {
                    if q.card.is_some_and(|(c, _)| c.sign) { &*pal_sign } else { &*pal_front }
                } else {
                    &*pal_behind
                };
                let pal = &pals[q.c.min(6)];
                let (x, y) = (q.x * kx, (top - q.y) * ky);
                if pass == State::Air {
                    ras.draw_leaf(buf, w, h, x, y, q.size, rot, flip, pal, ROUND | FLAT);
                } else {
                    // lying still: rasterized once (again if it turned or changed place)
                    let key = (pass as u8, js_round(rot * 20.0) as i64, js_round(flip * 20.0) as i64);
                    if q.spr_key != Some(key) {
                        q.spr_key = Some(key);
                        ras.sprite(&mut q.spr, q.size, rot, flip, pal, ROUND | FLAT);
                    }
                    blit(buf, w, h, x, y, &q.spr);
                }
                n += 1;
            }
        }
        n
    }
}

/// field.sample() as f64: [distance (m), gradient x, gradient y]
fn sample(f: &Field, x: f64, y: f64, top: f64) -> [f64; 3] {
    let s = f.sample(x as f32, y as f32, top as f32);
    [f64::from(s[0]), f64::from(s[1]), f64::from(s[2])]
}

/// the kick of the cell at (x, y), 0 off the grid
fn kick_at(f: &Field, x: f64, y: f64, top: f64) -> (f64, f64) {
    match f.cell_at(x as f32, y as f32, top as f32) {
        Some(c) => (f64::from(f.kx.get(c).copied().unwrap_or(0.0)), f64::from(f.ky.get(c).copied().unwrap_or(0.0))),
        None => (0.0, 0.0),
    }
}

/// `|| 1` of the browser: a zero length counts as 1
fn nonzero(v: f64) -> f64 {
    if v == 0.0 || v.is_nan() { 1.0 } else { v }
}
