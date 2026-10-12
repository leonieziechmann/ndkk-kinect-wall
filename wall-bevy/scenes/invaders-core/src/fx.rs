//! Screen effects that the game triggers and the renderer shows (fx.js): lights on the floor,
//! distortion ripples, flashes, color fringes (chroma), shake and slow motion. Positions in art px of
//! the map, sizes in meters (the renderer converts). Everything decays in real time, also during
//! slow motion.

use std::collections::VecDeque;

use super::pixels::Rgb;

pub struct Light {
    pub x: f64,
    pub y: f64,
    /// m
    pub r: f64,
    pub i: f64,
    pub col: Rgb,
    pub t0: f64,
    pub life: f64,
}

pub struct Ripple {
    pub x: f64,
    pub y: f64,
    /// LED px
    pub amp: f64,
    /// m/s
    pub speed: f64,
    pub t0: f64,
    pub life: f64,
}

pub struct Fx {
    pub lights: VecDeque<Light>,
    pub ripples: VecDeque<Ripple>,
    pub flash_col: Rgb,
    pub flash_amt: f64,
    pub chroma: f64,
    pub shake: f64,
    pub slow_until: f64,
    pub slow_scale: f64,
    /// the march beat: the hex grid pulses
    pub pulse: f64,
    pub time: f64,
}

impl Default for Fx {
    fn default() -> Self {
        Self::new()
    }
}

impl Fx {
    pub fn new() -> Self {
        Self {
            lights: VecDeque::with_capacity(170),
            ripples: VecDeque::with_capacity(10),
            flash_col: [1.0, 1.0, 1.0],
            flash_amt: 0.0,
            chroma: 0.0,
            shake: 0.0,
            slow_until: 0.0,
            slow_scale: 1.0,
            pulse: 0.0,
            time: 0.0,
        }
    }

    /// a light that fades out over `life` s
    pub fn light(&mut self, x: f64, y: f64, r: f64, i: f64, col: Rgb, life: f64) {
        if self.lights.len() > 160 {
            self.lights.pop_front();
        }
        self.lights.push_back(Light { x, y, r, i, col, t0: self.time, life });
    }

    pub fn ripple(&mut self, x: f64, y: f64, amp: f64, speed: f64, life: f64) {
        if self.ripples.len() >= 8 {
            self.ripples.pop_front();
        }
        self.ripples.push_back(Ripple { x, y, amp, speed, t0: self.time, life });
    }

    pub fn flash(&mut self, col: Rgb, amt: f64) {
        if amt >= self.flash_amt {
            self.flash_col = col;
        }
        self.flash_amt = self.flash_amt.max(amt);
    }

    pub fn kick(&mut self, shake: f64, chroma: f64) {
        self.shake = self.shake.max(shake);
        self.chroma = self.chroma.max(chroma);
    }

    /// slow motion: game time runs at `scale` until `secs` from now
    pub fn slow(&mut self, secs: f64, scale: f64) {
        self.slow_until = self.slow_until.max(self.time + secs);
        let cur = if self.slow_scale < 1.0 && self.time < self.slow_until { self.slow_scale } else { 1.0 };
        self.slow_scale = cur.min(scale);
    }

    /// the factor for the game's dt (eases back to 1)
    pub fn time_scale(&self) -> f64 {
        if self.time >= self.slow_until {
            return 1.0;
        }
        let left = self.slow_until - self.time;
        if left < 0.15 { self.slow_scale + (1.0 - self.slow_scale) * (1.0 - left / 0.15) } else { self.slow_scale }
    }

    pub fn step(&mut self, dt: f64) {
        self.time += dt;
        let t = self.time;
        self.lights.retain(|l| t - l.t0 < l.life);
        self.ripples.retain(|r| t - r.t0 < r.life);
        self.flash_amt *= (-dt * 12.0).exp();
        self.chroma *= (-dt * 6.0).exp();
        self.shake = (self.shake - dt * 10.0).max(0.0);
        self.pulse *= (-dt * 7.0).exp();
        if t >= self.slow_until {
            self.slow_scale = 1.0;
        }
    }
}
