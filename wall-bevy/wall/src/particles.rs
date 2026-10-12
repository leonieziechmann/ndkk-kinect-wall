//! Particles: sparks, confetti, dust. A list that moves, ages and draws itself (glowing dots, added:
//! light on the wall); a scene makes bursts and sprays and calls draw() each frame.

use glam::Vec2;

use crate::common::rand::Rng;
use crate::draw::{Color, Paint, Paints};

/// One particle.
#[derive(Clone, Debug)]
pub struct Particle {
    pub p: Vec2,
    /// px/s
    pub v: Vec2,
    /// 1 -> 0 over its life
    pub life: f32,
    /// life lost per s (1 / its life in s)
    pub decay: f32,
    /// radius in px at full life
    pub size: f32,
    pub color: Color,
}

/// A particle system: gravity and drag for all of them.
pub struct Particles {
    pub list: Vec<Particle>,
    /// px/s² downwards (negative: they rise)
    pub gravity: f32,
    /// 0..: share of the speed lost per s
    pub drag: f32,
    /// radius of the glow around each, as a share of its size (0: none)
    pub glow: f32,
    /// at most this many (the oldest go first)
    pub max: usize,
    pub rng: Rng,
}

impl Default for Particles {
    fn default() -> Self {
        Self::new(160.0)
    }
}

impl Particles {
    /// Falling with `gravity` px/s².
    pub fn new(gravity: f32) -> Self {
        Particles { list: Vec::new(), gravity, drag: 0.4, glow: 1.5, max: 4000, rng: Rng::from_time() }
    }

    pub fn len(&self) -> usize {
        self.list.len()
    }

    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    pub fn clear(&mut self) {
        self.list.clear();
    }

    pub fn emit(&mut self, p: Particle) {
        if self.list.len() >= self.max {
            self.list.remove(0);
        }
        self.list.push(p);
    }

    /// `n` particles from `at` in every direction, 0.5..1 × `speed` px/s, living about `secs`.
    pub fn burst(&mut self, at: Vec2, n: usize, speed: f32, secs: f32, color: Color) {
        for _ in 0..n {
            let v = self.rng.unit() * speed * self.rng.range(0.5, 1.0);
            self.spawn(at, v, secs, color);
        }
    }

    /// `n` particles from `at` with velocity `v` px/s, each off by up to `spread` × |v| in a random
    /// direction (a fountain: v pointing up, spread 0.5).
    pub fn spray(&mut self, at: Vec2, n: usize, v: Vec2, spread: f32, secs: f32, color: Color) {
        let s = v.length() * spread;
        for _ in 0..n {
            let dv = self.rng.in_circle(s);
            self.spawn(at, v + dv, secs, color);
        }
    }

    fn spawn(&mut self, at: Vec2, v: Vec2, secs: f32, color: Color) {
        let secs = secs.max(0.05) * self.rng.range(0.7, 1.3);
        let size = self.rng.range(1.5, 3.5);
        self.emit(Particle { p: at, v, life: 1.0, decay: 1.0 / secs, size, color });
    }

    /// Moves and ages them by `dt` s (draw() does it too).
    pub fn update(&mut self, dt: f32) {
        let keep = (1.0 - self.drag * dt).clamp(0.0, 1.0);
        for q in &mut self.list {
            q.v.y += self.gravity * dt;
            q.v *= keep;
            q.p += q.v * dt;
            q.life -= q.decay * dt;
        }
        self.list.retain(|q| q.life > 0.0);
    }

    /// Updates them and draws them: dots that shrink and fade as they age.
    pub fn draw(&mut self, d: &mut impl Paints, dt: f32) {
        self.update(dt);
        let size = d.size();
        for q in &self.list {
            let r = q.size * (0.4 + 0.6 * q.life);
            if q.p.x < -r || q.p.y < -r || q.p.x > size.x + r || q.p.y > size.y + r {
                continue;
            }
            let mut paint = Paint::fill(q.color.fade(q.life)).add();
            if self.glow > 0.0 {
                paint = paint.glow(r * self.glow);
            }
            d.circle(q.p.x, q.p.y, r, paint);
        }
    }
}
