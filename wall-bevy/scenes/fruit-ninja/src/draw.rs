//! Drawing the game into the pixel layer (draw.js, pix.rs) and collecting the lights for the
//! renderer. Order: what moves in the scenery (stars, clouds, lanterns), juice on the wall, the
//! ninjas (headband tails and sword hilt behind them), cherry petals, fruit halves, whole fruits,
//! juice and sparks, rings, numbers and crowns, the round bar. The blades and cuts are smooth
//! strokes (strokes.rs). The still scenery is a texture of its own (scenery.rs, render.rs). Wall
//! meters -> art px: x * ppm, (top - y) * ppm.

use std::collections::HashMap;
use std::f64::consts::TAU;

use crossbeam_channel::{Receiver, Sender};

use wall::persons::{SLOTS, j};
use wall::common::rand::Rng;

use super::fruits::{FACE, Kind, flesh, info, skin};
use super::game::{Game, Phase, ember};
use super::ninja::{part, shade};
use super::people::{People, RES, Shown};
use super::pix::{CROWN, Pix, Rgb, TURN, WHITE, js_round, js_sign, num_label, pack, rgb};
use super::scenery::Scenery;
use super::{Layout, P, color_of};

/// fruit blocks: half an art pixel (2 x 2 LEDs)
const UNIT: f64 = 0.5;
const GOLD: Rgb = [1.0, 0.8, 0.15];
const JEWEL: Rgb = [1.0, 0.2, 0.45];

fn mix(a: Rgb, b: Rgb, k: f32) -> Rgb {
    [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

fn scale(a: Rgb, k: f32) -> Rgb {
    [a[0] * k, a[1] * k, a[2] * k]
}

// Fruits turn in steps (like the figures in space-invaders): every kind, size, step and cut is
// computed once into a grid of block colors and kept, so a frame only copies blocks.
const STEPS: f64 = 32.0;

fn step(a: f64) -> i32 {
    let s = js_round(a / TAU * STEPS) % STEPS;
    let s = (s + STEPS) % STEPS;
    if s.is_finite() { s as i32 } else { 0 }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct SpriteKey {
    kind: Kind,
    /// radius in art px, to 0.01
    r: i64,
    rot: i32,
    /// the cut's normal step and side (halves)
    half: Option<(i32, i8)>,
    phase: i32,
}

impl SpriteKey {
    fn new(kind: Kind, r: f64, rot: i32, half: Option<(i32, i8)>, phase: i32) -> Self {
        Self { kind, r: js_round(r * 100.0) as i64, rot, half, phase }
    }

    /// the sprite (r: the radius in art px)
    fn make(&self, r: f64) -> Sprite {
        let (na_q, side) = self.half.unwrap_or((0, 0));
        make_sprite(self.kind, r, self.rot, self.half.is_some(), na_q, f64::from(side), phase_t(self.kind, self.phase))
    }
}

/// what changes with time: the bomb's band pulses, the frost fruit sparkles (the phase at time t)
fn phase_of(kind: Kind, t: f64) -> i32 {
    match kind {
        Kind::Bomb => i32::from((t * 9.0).sin() > -0.2),
        Kind::Frost => ((t * 6.0).floor() % 4.0) as i32,
        _ => 0,
    }
}

/// a time of that phase
fn phase_t(kind: Kind, phase: i32) -> f64 {
    match kind {
        Kind::Frost => f64::from(phase) / 6.0,
        Kind::Bomb if phase == 0 => 1.5 * std::f64::consts::PI / 9.0,
        _ => 0.0,
    }
}

/// the blocks of a fruit: cols[(j + n) * 2n + (i + n)] a packed color or 0; the frame it was last
/// drawn in (PINNED: kept for good)
struct Sprite {
    n: i64,
    cols: Vec<u32>,
    used: u64,
}

const PINNED: u64 = u64::MAX;

/// Builds what the draw thread asks for (the next turns of the halves that spin).
fn builder(ask: Receiver<(SpriteKey, f64)>, built: Sender<(SpriteKey, Sprite)>) {
    while let Ok((key, r)) = ask.recv() {
        if built.send((key, key.make(r))).is_err() {
            break;
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn make_sprite(kind: Kind, r: f64, rot_q: i32, half: bool, na_q: i32, side: f64, t: f64) -> Sprite {
    let n = ((r * 1.4) / UNIT).ceil().clamp(1.0, 200.0) as i64;
    let rot = f64::from(rot_q) / STEPS * TAU;
    let c = (-rot).cos();
    let s = (-rot).sin();
    let na = f64::from(na_q) / STEPS * TAU;
    let nx = na.cos();
    let ny = na.sin();
    let w = 2 * n;
    let mut cols = vec![0u32; (w * w) as usize];
    for jj in -n..n {
        let sy = -((jj as f64 + 0.5) * UNIT) / r;
        for ii in -n..n {
            let sx = ((ii as f64 + 0.5) * UNIT) / r;
            if sx * sx + sy * sy > 2.0 {
                continue;
            }
            let lx = sx * c - sy * s;
            let ly = sx * s + sy * c;
            let col = if half {
                let d = (lx * nx + ly * ny) * side;
                let tg = -lx * ny + ly * nx;
                let v = d / FACE;
                if tg * tg + v * v <= 1.0 {
                    Some(flesh(kind, tg, v * side))
                } else if d >= 0.0 {
                    skin(kind, lx, ly, sx, sy, t)
                } else {
                    continue;
                }
            } else {
                skin(kind, lx, ly, sx, sy, t)
            };
            if let (Some(col), Some(o)) = (col, cols.get_mut(((jj + n) * w + (ii + n)) as usize)) {
                *o = pack(col);
            }
        }
    }
    Sprite { n, cols, used: 0 }
}

/// what drawFruit needs of a whole fruit or a half
struct FruitLook {
    kind: Kind,
    x: f64,
    y: f64,
    r: f64,
    rot: f64,
    /// the cut's normal and side, the spin (halves)
    na: f64,
    side: f64,
    vr: f64,
}

// ---- the ninja costume: [base, lit, dark] per piece (moonlight from the top left, cool shadows)
fn costume(pt: u8) -> [Rgb; 3] {
    const C: [[Rgb; 3]; 13] = [
        [rgb(0x181d36), rgb(0x2a3358), rgb(0x0e1122)], // (none: suit)
        [rgb(0x181d36), rgb(0x2a3358), rgb(0x0e1122)], // suit
        [rgb(0x161b32), rgb(0x2b3459), rgb(0x0d1021)], // hood
        [rgb(0xe8b898), rgb(0xf8d4b8), rgb(0xc8907e)], // skin
        [rgb(0x181d36), rgb(0x2a3358), rgb(0x0e1122)], // (eye)
        [rgb(0x181d36), rgb(0x2a3358), rgb(0x0e1122)], // (band)
        [rgb(0x181d36), rgb(0x2a3358), rgb(0x0e1122)], // (belt)
        [rgb(0x2e375c), rgb(0x46517e), rgb(0x1e2442)], // collar
        [rgb(0x3e4b76), rgb(0x56659a), rgb(0x29325a)], // wrap
        [rgb(0x2b3558), rgb(0x3d4a76), rgb(0x1d2442)], // wrap2
        [rgb(0x0c0f1c), rgb(0x1a1f36), rgb(0x07080f)], // foot
        [rgb(0x4a5684), rgb(0x8a98c8), rgb(0x2c3458)], // plate
        [rgb(0x151a30), rgb(0x252d50), rgb(0x0c0f1e)], // pants
    ];
    C.get(usize::from(pt)).copied().unwrap_or(C[1])
}
const GRIP: Rgb = rgb(0x24243c);
const GUARD: Rgb = rgb(0xe0b030);
const POMMEL: Rgb = rgb(0xa0aad0);

/// The tones of a piece of the costume of a player of color col: [base, lit, dark, rim (the
/// outline towards the light, in the player's color), shaded outline]
fn ninja_tones(col: Rgb, pt: u8, body_edge: f32) -> [Rgb; 5] {
    let tri = if pt == part::BAND || pt == part::BELT {
        let c = if pt == part::BELT { scale(col, 0.8) } else { col };
        [c, mix(c, WHITE, 0.3), scale(c, 0.62)]
    } else if pt == part::EYE {
        let c = mix(col, WHITE, 0.45); // the eyes glow in the player's color
        [c, c, c]
    } else {
        costume(pt)
    };
    let rim = if pt == part::BAND || pt == part::BELT || pt == part::EYE { mix(tri[0], WHITE, 0.35) } else { mix(tri[1], col, body_edge) };
    [tri[0], tri[1], tri[2], rim, mix(tri[2], col, 0.2)]
}

/// wall m -> art px
fn ax(l: &Layout, x: f64) -> f64 {
    x * l.ppm
}
fn ay(l: &Layout, y: f64) -> f64 {
    (l.top - y) * l.ppm
}

/// The sprites made so far (kept: a frame mostly only copies blocks). The browser emptied its
/// cache at 4000 sprites; here only the ones not drawn for a while go (those of every whole fruit
/// stay), so a long show never rebuilds a heap of sprites in one frame.
pub struct Sprites {
    map: HashMap<SpriteKey, Sprite>,
    /// the frame being drawn
    frame: u64,
}

impl Sprites {
    /// The sprites every whole fruit needs in this layout at this size (made in a worker thread).
    pub fn warmed(l: &Layout, size: f64) -> Self {
        let mut s = Self { map: HashMap::with_capacity(4096), frame: 0 };
        for kind in [Kind::Melon, Kind::Orange, Kind::Apple, Kind::Lemon, Kind::Berry, Kind::Plum, Kind::Dragon, Kind::Star, Kind::Frost, Kind::Bomb] {
            let r = info(kind).r * size * l.ppm;
            let phases: &[i32] = match kind {
                Kind::Bomb => &[1, 0],
                Kind::Frost => &[0, 1, 2, 3],
                _ => &[0],
            };
            for &phase in phases {
                for rot in 0..STEPS as i32 {
                    let key = SpriteKey::new(kind, r, rot, None, phase);
                    s.map.insert(key, Sprite { used: PINNED, ..key.make(r) });
                }
            }
        }
        s
    }

    fn contains(&self, key: &SpriteKey) -> bool {
        self.map.contains_key(key)
    }

    /// room for one more: the sprites not drawn for 4 s go
    fn make_room(&mut self) {
        if self.map.len() < 4000 {
            return;
        }
        let frame = self.frame;
        self.map.retain(|_, s| s.used == PINNED || frame.saturating_sub(s.used) < 240);
        if self.map.len() >= 4000 {
            self.map.retain(|_, s| s.used == PINNED);
        }
    }

    /// one the builder thread made
    fn insert(&mut self, key: SpriteKey, sprite: Sprite) {
        if !self.map.contains_key(&key) {
            self.make_room();
            self.map.insert(key, Sprite { used: self.frame, ..sprite });
        }
    }

    /// the sprite of `key` (made now if it is not there), marked as drawn
    fn get(&mut self, key: SpriteKey, r: f64) -> &Sprite {
        if !self.map.contains_key(&key) {
            self.make_room();
        }
        let frame = self.frame;
        let s = self.map.entry(key).or_insert_with(|| key.make(r));
        if s.used != PINNED {
            s.used = frame;
        }
        s
    }
}

pub struct Draw {
    pub sprites: Sprites,
    /// the sprites asked of the builder thread and not back yet
    asked: Vec<SpriteKey>,
    ask: Sender<(SpriteKey, f64)>,
    built: Receiver<(SpriteKey, Sprite)>,
    /// the costume's tones of this frame per slot * 16 + part (packed), valid when the frame matches
    tones: Vec<([u32; 5], u64)>,
    frame: u64,
    rng: Rng,
    /// LED x of the columns of blocks being drawn (scratch)
    xs: Vec<Option<i64>>,
}

impl Draw {
    pub fn new(sprites: Sprites) -> Result<Self, String> {
        let (ask, rx) = crossbeam_channel::bounded(256);
        let (tx, built) = crossbeam_channel::bounded(256);
        std::thread::Builder::new().name("fruit-ninja sprites".into()).spawn(move || builder(rx, tx)).map_err(|e| format!("fruit-ninja: kein Thread für die Früchte: {e}"))?;
        Ok(Self { sprites, asked: Vec::with_capacity(256), ask, built, tones: vec![([0; 5], 0); SLOTS * 16], frame: 0, rng: Rng::from_time(), xs: Vec::with_capacity(1024) })
    }

    /// the sprites of another layout
    pub fn set_sprites(&mut self, sprites: Sprites) {
        self.sprites = sprites;
        self.asked.clear();
    }

    /// asks the builder thread for a sprite that will be needed soon
    fn prefetch(&mut self, key: SpriteKey, r: f64) {
        if self.asked.len() < 256 && !self.sprites.contains(&key) && !self.asked.contains(&key) && self.ask.try_send((key, r)).is_ok() {
            self.asked.push(key);
        }
    }

    /// a fruit (whole, or a half with its na / side)
    fn draw_fruit(&mut self, pix: &mut Pix, l: &Layout, f: &FruitLook, t: f64, half: bool) {
        let ppm = l.ppm;
        let r = f.r * ppm;
        let cx = f.x * ppm;
        let cy = (l.top - f.y) * ppm;
        if !(r > 0.0 && r < 1000.0 && cx.is_finite() && cy.is_finite()) {
            return;
        }
        let phase = phase_of(f.kind, t);
        let halfk = half.then(|| (step(f.na), if f.side > 0.0 { 1 } else { -1 }));
        let rot = step(f.rot);
        if half {
            // the next turns of a half that spins (and the next sparkle of a frost half): made by
            // the builder thread before they are needed
            let dir = if f.vr < 0.0 { -1 } else { 1 };
            for k in [1, 2] {
                self.prefetch(SpriteKey::new(f.kind, r, (rot + k * dir).rem_euclid(STEPS as i32), halfk, phase), r);
            }
            if f.kind == Kind::Frost {
                self.prefetch(SpriteKey::new(f.kind, r, rot, halfk, (phase + 1) % 4), r);
            }
        }
        let sp = self.sprites.get(SpriteKey::new(f.kind, r, rot, halfk, phase), r);
        let n = sp.n;
        let w = (2 * n) as usize;
        // where each column and row of blocks lands (as put() places a block)
        let bn = pix.block_n(UNIT);
        self.xs.clear();
        self.xs.extend((0..w).map(|ii| pix.led(cx + (ii as f64 - n as f64) * UNIT)));
        for (jj, row) in sp.cols.chunks_exact(w).enumerate() {
            let Some(y0) = pix.led(cy + (jj as f64 - n as f64) * UNIT) else { continue };
            for (&col, x0) in row.iter().zip(&self.xs) {
                if let (true, Some(x0)) = (col != 0, *x0) {
                    pix.fill_block(x0, y0, bn, col);
                }
            }
        }
    }

    /// the gear behind a ninja: the two tails of the headband (they flutter against the motion), the sword hilt
    fn draw_gear(pix: &mut Pix, l: &Layout, q: &Shown, real: f64, p: &P) {
        let sk = &q.sk;
        let ppm = l.ppm;
        let top = l.top;
        if let Some(h) = sk[j::HEAD] {
            let [vx, vy] = q.hv;
            let sp = vx.hypot(vy);
            // the knot sits at the back; seen from the front the tails come out on one side and trail behind
            let side = if sp > 0.25 {
                -js_sign(if vx == 0.0 || vx.is_nan() { 1.0 } else { vx })
            } else if q.head_x < l.wall_w / 2.0 {
                1.0
            } else {
                -1.0
            };
            let k = (sp / 1.5).min(1.0);
            let mut dx = side * 0.8 - vx * 0.5;
            let mut dy = -0.45 - vy * 0.4 + k * 0.3;
            let ln = dx.hypot(dy);
            let ln = if ln == 0.0 || ln.is_nan() { 1.0 } else { ln };
            dx /= ln;
            dy /= ln;
            let ox = h[0] + side * 0.075;
            let oy = h[1] + 0.065;
            for (len, ph, shade_k) in [(0.26, 0.0, 1.0), (0.2, 1.7, 0.72)] {
                let c = scale(q.col, shade_k);
                let n = (len / 0.012_f64).ceil() as i32;
                for i in 0..=n {
                    let s = f64::from(i) / f64::from(n) * len;
                    let w = (real * (9.0 + sp * 4.0) + s * 16.0 + ph).sin() * 0.022 * (s / len) * (0.6 + k);
                    let sag = (1.0 - k) * 0.14 * (s / len).powi(2);
                    let x = ox + dx * s - dy * w;
                    let y = oy + dy * s + dx * w - sag;
                    // two blocks wide at the knot, one at the end
                    let u = if f64::from(i) < f64::from(n) * 0.65 { 1.0 } else { 0.5 };
                    pix.put(x * ppm - u / 2.0, (top - y) * ppm - u / 2.0, c, 1.0, u);
                    if f64::from(i) < f64::from(n) * 0.4 {
                        pix.put((x + dy * 0.02) * ppm - u / 2.0, (top - (y - dx * 0.02)) * ppm - u / 2.0, c, 1.0, u);
                    }
                }
            }
        }
        // the hilt of the sword on the back, over the shoulder on the other side
        let sh = match (sk[j::LEFT_SHOULDER], sk[j::RIGHT_SHOULDER]) {
            (Some(ls), Some(rs)) => Some(if ls[0] < rs[0] { rs } else { ls }),
            _ => None,
        };
        if let (Some(sh), Some(neck), true) = (sh, sk[j::NECK], p.sword) {
            let o = js_sign(sh[0] - neck[0]);
            let out = if o == 0.0 { 1.0 } else { o };
            let dx = out * 0.42;
            let dy = 0.91;
            let x0 = sh[0] - out * 0.03;
            let y0 = sh[1] - 0.02;
            let mut s = 0.0_f64;
            while s <= 0.27 {
                let x = x0 + dx * s;
                let y = y0 + dy * s;
                let mut c = GRIP;
                let mut u = 1.0;
                if s > 0.25 {
                    c = POMMEL;
                } else if (s - 0.09).abs() < 0.012 {
                    // the guard: across the blade
                    for o in [-0.03, -0.015, 0.015, 0.03] {
                        pix.put((x - dy * o) * ppm - 0.25, (top - (y + dx * o)) * ppm - 0.25, GUARD, 1.0, 0.5);
                    }
                    c = GUARD;
                } else if s > 0.1 && (s / 0.024).floor() as i64 % 2 == 0 {
                    c = scale(q.col, 0.85);
                } else if s < 0.09 {
                    u = 0.5;
                }
                pix.put(x * ppm - u / 2.0, (top - y) * ppm - u / 2.0, c, 1.0, u);
                s += 0.012;
            }
        }
    }

    /// The pixel layer of this frame.
    pub fn draw_art(&mut self, pix: &mut Pix, l: &Layout, game: &Game, people: &People, scenery: &Scenery, p: &P) {
        let t = game.time;
        let real = game.real;
        let ppm = l.ppm;
        self.frame += 1;
        self.sprites.frame = self.frame;
        // the sprites the builder thread made since
        while let Ok((key, sprite)) = self.built.try_recv() {
            self.asked.retain(|k| *k != key);
            self.sprites.insert(key, sprite);
        }
        pix.clear();

        // ---- the scenery: stars, clouds, a shooting star, the lanterns
        scenery.draw(pix);

        // ---- juice on the wall
        for sp in &game.splats {
            let u = (real - sp.t0) / sp.life;
            let col = pack(scale(sp.col, p.splat as f32));
            let cx = ax(l, sp.x);
            let cy = ay(l, sp.y);
            for b in &sp.blocks {
                if u > b.death {
                    continue;
                }
                if b.run.is_some_and(|r| r > u * 4.0) {
                    continue; // a run grows down over the first quarter
                }
                pix.put_packed(cx + b.x * ppm - b.unit / 2.0, cy - b.y * ppm - b.unit / 2.0, col, b.unit);
            }
        }

        // ---- the ninjas: what is behind them first (headband tails, sword hilt), then the costume
        for q in &people.list {
            if people.shown(q.slot) {
                Self::draw_gear(pix, l, q, real, p);
            }
        }
        if let (true, Some(bb)) = (people.mask.any, people.mask.bbox) {
            self.draw_people(pix, people, bb, game, p);
        }

        // ---- cherry petals, in front of the people
        scenery.draw_petals(pix);

        // ---- fruit
        for h in &game.halves {
            let f = FruitLook { kind: h.kind, x: h.x, y: h.y, r: h.r, rot: h.rot, na: h.na, side: h.side, vr: h.vr };
            self.draw_fruit(pix, l, &f, t, true);
        }
        for f in &game.fruits {
            let k = info(f.kind);
            if let Some(aura) = k.aura {
                // specials and bombs glow: a pulsing ring around them
                let pulse = 0.5 + 0.5 * (real * if f.kind == Kind::Bomb { 10.0 } else { 5.0 } + f64::from(f.id)).sin();
                pix.ring(ax(l, f.x), ay(l, f.y), f.r * ppm * (1.22 + 0.08 * pulse), 0.9, aura, (0.35 + 0.4 * pulse) as f32, UNIT);
            }
            let look = FruitLook { kind: f.kind, x: f.x, y: f.y, r: f.r, rot: f.rot, na: 0.0, side: 0.0, vr: 0.0 };
            self.draw_fruit(pix, l, &look, t, false);
            if f.kind == Kind::Bomb {
                // the spark at the end of the fuse
                let cr = f.rot.cos();
                let sr = f.rot.sin();
                let (lx, ly) = (0.22, 1.34);
                let fx = f.x + f.r * (lx * cr - ly * sr);
                let fy = f.y + f.r * (lx * sr + ly * cr);
                let flick = self.rng.f64();
                pix.put(ax(l, fx) - 0.5, ay(l, fy) - 0.5, if flick > 0.5 { WHITE } else { [1.0, 0.7, 0.2] }, 1.0, 1.0);
                for _ in 0..3 {
                    let a = self.rng.f64() * TURN;
                    let d = 0.6 + self.rng.f64() * 1.2;
                    let c = if self.rng.f64() > 0.5 { [1.0, 0.85, 0.3] } else { [1.0, 0.35, 0.1] };
                    pix.put(ax(l, fx) + a.cos() * d - 0.25, ay(l, fy) + a.sin() * d - 0.25, c, 1.0, UNIT);
                }
            }
        }

        // ---- juice drops and sparks
        for d in &game.drops {
            let u = (t - d.t0) / d.life;
            let col = if d.ember { ember(u) } else { d.col };
            let sz = d.size * if u > 0.7 { 0.5 / d.size } else { 1.0 };
            pix.put(ax(l, d.x) - sz / 2.0, ay(l, d.y) - sz / 2.0, col, 1.0, sz);
        }

        // ---- rings
        for r in &game.rings {
            let u = (real - r.t0) / r.life;
            let rad = r.r0 + (r.r1 - r.r0) * (1.0 - (1.0 - u).powi(3));
            // stays bright and gets thinner: a dim orange or magenta ring would look brown
            let a = if u < 0.75 { 1.0 } else { (1.0 - u) / 0.25 };
            pix.ring(ax(l, r.x), ay(l, r.y), rad * ppm, UNIT.max(r.w * ppm * (1.0 - 0.8 * u)), r.col, a as f32, UNIT);
        }

        // (the blades, the woosh and the cuts are smooth strokes on the GPU: strokes.rs)

        // ---- everyone's points beside the head (the wall is only 2 m high: no room above tall
        // people), the crown on the head of the best of the last round
        let end = game.phase == Phase::End;
        if matches!(game.phase, Phase::Play | Phase::End | Phase::Ready) {
            for q in &people.list {
                if !people.shown(q.slot) {
                    continue;
                }
                let pts = game.score_of(q.id);
                let h = if end { 9.0 } else { 5.0 };
                let hx = ax(l, q.head_x);
                let hy = ay(l, q.head_y);
                let s = num_label(pts);
                let tw = (s.bytes().len() as f64 * 4.0 - 1.0) * (h / 5.0);
                // on the side towards the middle of the wall, where there is room
                let side = if q.head_x < l.wall_w / 2.0 { 1.0 } else { -1.0 };
                let tx = hx + side * (0.2 * ppm + tw / 2.0);
                let ty = (h / 2.0 + 1.0).max((pix.h - h / 2.0 - 1.0).min(hy));
                if pts > 0.0 || end {
                    pix.text(s.bytes(), tx, ty, h, q.col, 1.0);
                }
                if game.crown == Some(q.id) && p.crown {
                    let bob = if end { (real * 5.0).sin().abs() * 1.2 } else { 0.0 };
                    let rows = CROWN.len() as f64;
                    let cw = CROWN[0].len() as f64;
                    let top = (rows * UNIT).max(ay(l, q.head_y + 0.1) - bob);
                    for (jj, row) in CROWN.iter().enumerate() {
                        for (ii, ch) in row.bytes().enumerate() {
                            if ch != b'.' {
                                pix.put(hx - cw * UNIT / 2.0 + ii as f64 * UNIT, top - rows * UNIT + jj as f64 * UNIT, if ch == b'j' { JEWEL } else { GOLD }, 1.0, UNIT);
                            }
                        }
                    }
                }
            }
        }
        for pop in &game.pops {
            let u = (real - pop.t0) / pop.life;
            let h = pop.h * if u < 0.15 { 0.6 + u * 2.7 } else { 1.0 };
            let a = if u < 0.7 { 1.0 } else { (1.0 - u) / 0.3 };
            pix.text(pop.text.bytes(), ax(l, pop.x), ay(l, pop.y + pop.vy * u), h, pop.col, a as f32);
        }

        // ---- the round: a bar along the top edge, it fills before the round and empties during it
        if p.round_time > 0.0 && matches!(game.phase, Phase::Ready | Phase::Play) {
            let k = if game.phase == Phase::Ready { (game.phase_t / 1.8).min(1.0) } else { (game.round_left / game.round_time).max(0.0) };
            let finale = game.phase == Phase::Play && game.round_left < p.finale;
            let col = if finale {
                if (real * 12.0).sin() > 0.0 { [1.0, 0.2, 0.6] } else { [1.0, 0.6, 0.9] }
            } else {
                [0.35, 0.85, 1.0]
            };
            let half = pix.w / 2.0 * k;
            if half.is_finite() {
                let mut x = (pix.w / 2.0 - half).floor();
                while x < pix.w / 2.0 + half {
                    pix.put(x, 0.0, col, 0.85, 1.0);
                    x += 1.0;
                }
            }
        }
    }

    /// the costume of every covered cell
    fn draw_people(&mut self, pix: &mut Pix, people: &People, bb: [i32; 4], game: &Game, p: &P) {
        let (aw, ah) = (people.mask.aw, people.mask.ah);
        let cell = &people.mask.cell;
        if cell.len() != aw * ah || people.mask.part.len() != cell.len() || people.mask.shade.len() != cell.len() {
            return;
        }
        let real = game.real;
        let u = 1.0 / RES as f64; // a cell in art px
        let frame = self.frame;
        // where each column and row of cells lands (as put() places a block)
        let bn = pix.block_n(u);
        let (x_lo, x_hi) = (bb[0].max(0) as usize, (bb[2].max(0) as usize).min(aw.saturating_sub(1)));
        self.xs.clear();
        self.xs.extend((x_lo..=x_hi).map(|x| pix.led(x as f64 * u)));
        for y in bb[1].max(0) as usize..=(bb[3].max(0) as usize).min(ah.saturating_sub(1)) {
            let Some(y0) = pix.led(y as f64 * u) else { continue };
            for x in x_lo..=x_hi {
                let c = y * aw + x;
                let s = cell[c];
                if s == 0 {
                    continue;
                }
                let pt = match people.mask.part[c] {
                    0 => part::SUIT,
                    v => v.min(15),
                };
                let key = usize::from(s) * 16 + usize::from(pt);
                let Some(entry) = self.tones.get_mut(key) else { continue };
                if entry.1 != frame {
                    let mut tn = ninja_tones(color_of(s), pt, p.body_edge as f32);
                    if let Some(&(_, hit)) = game.hurt.iter().find(|h| h.0 == s) {
                        let k = (1.0 - (real - hit) / 0.8).max(0.0) as f32;
                        let flash = if (real * 40.0).sin() > 0.0 { [1.0, 1.0, 1.0] } else { [1.0, 0.15, 0.25] };
                        for col in &mut tn {
                            *col = mix(*col, flash, k);
                        }
                    }
                    *entry = ([pack(tn[0]), pack(tn[1]), pack(tn[2]), pack(tn[3]), pack(tn[4])], frame);
                }
                let tn = entry.0;
                // light from the top left: a rim in the player's color there, darker at the bottom
                // right; inside, the shade of the limb (lit, base, dark)
                let up = if y > 0 { cell[c - aw] } else { 0 };
                let left = if x > 0 { cell[c - 1] } else { 0 };
                let down = if y + 1 < ah { cell[c + aw] } else { 0 };
                let right = if x + 1 < aw { cell[c + 1] } else { 0 };
                let sh = people.mask.shade[c];
                let tone = if up != s || left != s {
                    tn[3]
                } else if down != s || right != s {
                    tn[4]
                } else if sh == shade::LIT {
                    tn[1]
                } else if sh == shade::DARK {
                    tn[2]
                } else {
                    tn[0]
                };
                if let Some(&Some(x0)) = self.xs.get(x - x_lo) {
                    pix.fill_block(x0, y0, bn, tone);
                }
            }
        }
    }

    /// The lights on the wall behind everything: [x, y (art px), r (m), intensity, r, g, b, 0] each.
    pub fn collect_lights(out: &mut [f32], l: &Layout, game: &Game, people: &People, scenery: &Scenery, p: &P) -> usize {
        let mut n = 0;
        let max = out.len() / 8;
        let mut add = |x: f64, y: f64, r: f64, i: f64, col: Rgb| {
            if n >= max || i.is_nan() || i <= 0.01 {
                return;
            }
            if let Some(o) = out.get_mut(n * 8..n * 8 + 8) {
                o.copy_from_slice(&[ax(l, x) as f32, ay(l, y) as f32, r as f32, (i * p.lights) as f32, col[0], col[1], col[2], 0.0]);
                n += 1;
            }
        };
        let fx = &game.fx;
        for li in &fx.lights {
            let u = (fx.time - li.t0) / li.life;
            add(li.x, li.y, li.r * (0.7 + 0.3 * u), li.i * (1.0 - u).powi(2), li.col);
        }
        for f in &game.fruits {
            if let Some(aura) = info(f.kind).aura {
                let bomb = f.kind == Kind::Bomb;
                add(f.x, f.y, if bomb { 0.55 } else { 0.7 }, if bomb { 0.5 + 0.3 * (game.real * 10.0).sin() } else { 0.6 }, aura);
            }
        }
        for b in &people.blades {
            if !b.cutting {
                continue;
            }
            if let Some(x) = b.x {
                add(x, b.y, 0.4, 0.5, b.col);
            }
        }
        scenery.lights(&mut add, l);
        n
    }
}
