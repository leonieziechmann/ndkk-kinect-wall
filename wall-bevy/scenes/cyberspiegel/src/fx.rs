//! Particles (fx.js), simulated on the CPU (a few thousand, cheap) and drawn as additive, world-sized
//! dots (scene.wgsl: vs_spark):
//!   Sparks  short-lived: dust blown off everyone's contour, trails of fast hands, bursts (claps,
//!           quakes, eruptions, leaving), the upload stream; plus one-frame points (eyes, arcs)
//!   Swarm   particles resting in the air around the people, stirred by hands and feet

use super::world::Mulberry;

const F: usize = 14; // floats per spark: x y z vx vy vz life ttl size r g b gravity turbulence
/// floats per drawn dot: x y z size r g b
pub const DOT: usize = 7;

pub struct Sparks {
    max: usize,
    cap: usize,
    d: Vec<f32>,
    /// simulated sparks
    pub n: usize,
    /// one-frame points after them
    pub extra: usize,
    /// the instance data (DOT floats each)
    pub inst: Vec<f32>,
}

impl Sparks {
    pub fn new(max: usize, extras: usize) -> Self {
        let cap = max + extras;
        Self { max, cap, d: vec![0.0; max * F], n: 0, extra: 0, inst: vec![0.0; cap * DOT] }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn spawn(&mut self, x: f32, y: f32, z: f32, vx: f32, vy: f32, vz: f32, ttl: f32, size: f32, r: f32, g: f32, b: f32, gravity: f32, turbulence: f32) {
        if self.n >= self.max {
            return;
        }
        let o = self.n * F;
        self.n += 1;
        self.d[o..o + F].copy_from_slice(&[x, y, z, vx, vy, vz, 0.0, ttl, size, r, g, b, gravity, turbulence]);
    }

    /// Moves everything, drops the dead, writes the GPU data. Then add extras (eyes) with point().
    pub fn update(&mut self, dt: f32, t: f32) {
        let mut j = 0;
        for i in 0..self.n {
            let o = i * F;
            let life = self.d[o + 6] + dt;
            let ttl = self.d[o + 7];
            if life >= ttl {
                continue;
            }
            let turb = self.d[o + 13];
            let mut vx = self.d[o + 3];
            let mut vy = self.d[o + 4];
            let mut vz = self.d[o + 5];
            if turb != 0.0 {
                let (x, y, z) = (self.d[o], self.d[o + 1], self.d[o + 2]);
                vx += (y * 3.1 + t * 0.9 + z * 1.7).sin() * turb * dt;
                vz += (x * 2.7 - t * 0.7 + y * 2.3).cos() * turb * dt * 0.6;
                vy += (z * 2.2 + x * 1.9 + t * 1.3).sin() * turb * dt * 0.3;
            }
            vy += self.d[o + 12] * dt;
            let o2 = j * F;
            if o2 != o {
                self.d.copy_within(o..o + F, o2);
            }
            let s = &mut self.d[o2..o2 + F];
            s[3] = vx;
            s[4] = vy;
            s[5] = vz;
            s[0] += vx * dt;
            s[1] += vy * dt;
            s[2] += vz * dt;
            s[6] = life;
            // bounce off the floor
            if s[1] < 0.0 {
                s[1] = -s[1];
                s[4] = vy.abs() * 0.35;
            }
            let f = life / ttl;
            let a = (1.0 - f) * (1.0 - f) * (f * 10.0).min(1.0);
            let k = j * DOT;
            self.inst[k..k + DOT].copy_from_slice(&[s[0], s[1], s[2], s[8] * (0.55 + 0.45 * (1.0 - f)), s[9] * a, s[10] * a, s[11] * a]);
            j += 1;
        }
        self.n = j;
        self.extra = 0;
    }

    /// A sprite for this frame only (not simulated).
    #[allow(clippy::too_many_arguments)]
    pub fn point(&mut self, x: f32, y: f32, z: f32, size: f32, r: f32, g: f32, b: f32) {
        if self.extra >= self.cap - self.max {
            return;
        }
        let k = (self.n + self.extra) * DOT;
        self.extra += 1;
        if let Some(o) = self.inst.get_mut(k..k + DOT) {
            o.copy_from_slice(&[x, y, z, size, r, g, b]);
        }
    }

    /// what is drawn (upload())
    pub fn count(&self) -> usize {
        (self.n + self.extra).min(self.cap)
    }
}

// ---------- the swarm: particles in the air around the people, stirred by hands and feet ----------

/// a hand or foot (mirror world, m and m/s)
pub struct Mover {
    pub p: [f32; 3],
    pub v: [f32; 3],
}

/// a one-frame push (claps, jumps)
pub struct Kick {
    pub p: [f32; 3],
    pub r: f32,
    pub s: f32,
    pub up: f32,
}

const REST: [f32; 3] = [0.9, 0.2, 0.45]; // color at rest
const HOT: [f32; 3] = [1.0, 0.75, 0.9]; // color when stirred

pub struct Swarm {
    pub count: usize,
    home: Vec<f32>,
    p: Vec<f32>,
    v: Vec<f32>,
    seed: Vec<f32>,
    size: Vec<f32>,
    /// the instance data (DOT floats each)
    pub inst: Vec<f32>,
    pub visible: bool,
}

impl Swarm {
    pub fn new(count: usize) -> Self {
        Self {
            count,
            home: vec![0.0; count * 3],
            p: vec![0.0; count * 3],
            v: vec![0.0; count * 3],
            seed: vec![0.0; count],
            size: vec![0.0; count],
            inst: vec![0.0; count * DOT],
            visible: true,
        }
    }

    /// Places the particles for the view.
    pub fn build(&mut self, eye_dist: f32, led_px: f32, wall_w: f32, rnd: &mut Mulberry) {
        let (eye_dist, led_px, wall_w) = (f64::from(eye_dist), f64::from(led_px), f64::from(wall_w));
        for i in 0..self.count {
            let z = -0.2 - rnd.next().powf(1.2) * 5.0;
            let depth = (eye_dist - z) / eye_dist;
            let x = (rnd.next() * 2.0 - 1.0) * (wall_w / 2.0 + 0.3) * depth;
            let y = 0.05 + rnd.next() * 2.3;
            let p = [x as f32, y as f32, z as f32];
            self.home[3 * i..3 * i + 3].copy_from_slice(&p);
            self.p[3 * i..3 * i + 3].copy_from_slice(&p);
            self.v[3 * i..3 * i + 3].fill(0.0);
            self.seed[i] = rnd.next() as f32;
            self.size[i] = (led_px * (1.0 + rnd.next() * 0.6) * depth) as f32;
        }
    }

    /// movers: hands and feet; kicks: one-frame pushes.
    pub fn update(&mut self, dt: f32, t: f32, movers: &[Mover], kicks: &[Kick], gain: f32) {
        const R: f32 = 0.45;
        for i in 0..self.count {
            let o = 3 * i;
            #[allow(clippy::approx_constant)] // the browser's number
            let s = self.seed[i] * 6.283;
            let (p, v) = (&mut self.p, &mut self.v);
            // drift around its home, come back slowly when pushed away
            let tx = self.home[o] + (t * 0.31 + s).sin() * 0.06;
            let ty = self.home[o + 1] + (t * 0.23 + s * 2.0).sin() * 0.05;
            let tz = self.home[o + 2] + (t * 0.27 + s * 3.0).cos() * 0.06;
            let mut ax = (tx - p[o]) * 1.2 - v[o] * 1.6;
            let mut ay = (ty - p[o + 1]) * 1.2 - v[o + 1] * 1.6;
            let mut az = (tz - p[o + 2]) * 1.2 - v[o + 2] * 1.6;
            for m in movers {
                let dx = p[o] - m.p[0];
                let dy = p[o + 1] - m.p[1];
                let dz = p[o + 2] - m.p[2];
                let d2 = dx * dx + dy * dy + dz * dz;
                if d2 > R * R {
                    continue;
                }
                let d = if d2 > 0.0 { d2.sqrt() } else { 1e-3 };
                let w = (1.0 - d / R).powi(2);
                ax += m.v[0] * w * 16.0 + (dx / d) * w * 5.0;
                ay += m.v[1] * w * 16.0 + (dy / d) * w * 5.0;
                az += m.v[2] * w * 16.0 + (dz / d) * w * 5.0;
            }
            for k in kicks {
                let dx = p[o] - k.p[0];
                let dy = p[o + 1] - k.p[1];
                let dz = p[o + 2] - k.p[2];
                let d = (dx * dx + dy * dy + dz * dz).sqrt();
                let d = if d > 0.0 { d } else { 1e-3 };
                if d > k.r {
                    continue;
                }
                let w = (1.0 - d / k.r) * k.s;
                v[o] += (dx / d) * w;
                v[o + 1] += (dy / d) * w + k.up * w;
                v[o + 2] += (dz / d) * w;
            }
            v[o] += ax * dt;
            v[o + 1] += ay * dt;
            v[o + 2] += az * dt;
            p[o] += v[o] * dt;
            p[o + 1] = (p[o + 1] + v[o + 1] * dt).max(0.01);
            p[o + 2] += v[o + 2] * dt;
            let speed = ((v[o] * v[o] + v[o + 1] * v[o + 1] + v[o + 2] * v[o + 2]).sqrt() * 0.9).min(1.0);
            let twinkle = 0.5 + 0.5 * (t * (0.7 + self.seed[i]) + s * 9.0).sin();
            let b = (0.06 + 0.06 * twinkle + speed * 1.6) * gain;
            let h = speed;
            let k = DOT * i;
            self.inst[k..k + DOT].copy_from_slice(&[
                p[o],
                p[o + 1],
                p[o + 2],
                self.size[i] * (1.0 + speed * 0.6),
                (REST[0] + (HOT[0] - REST[0]) * h) * b,
                (REST[1] + (HOT[1] - REST[1]) * h) * b,
                (REST[2] + (HOT[2] - REST[2]) * h) * b,
            ]);
        }
        self.visible = gain > 0.0;
    }
}
