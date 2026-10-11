//! The virtual world of the mirror (world.js), made of particles like a Kinect point cloud (rows of
//! dots):
//!   floor     rows of dots that continue the real floor and roll into dunes far away; it ripples
//!             around the feet of everyone in front of the wall
//!   blackwall an arena of heaving particle columns, far in the middle and nearer at the sides (red
//!             ridges, blue grooves); particles come loose, it surges when the people move, trembles
//!             when someone jumps and opens in the middle when someone spreads the arms
//!   core      a glowing tear of light in the middle of the wall, the people stand in front of it
//!   streaks   thin vertical lines of light flickering in the distance
//!   motes     particles drifting in the air
//! Everything is additive dots of about one LED, on black. Units: meters; the wall (the mirror) is
//! the plane Z = 0, the mirror world lies at Z < 0, the eye looks along -Z.
//!
//! Here: the static instance data, built on the CPU when the view changes (the same random numbers
//! as the browser: mulberry(11)); the animation is in scene.wgsl.

pub const MAX_MARKS: usize = 8; // persons whose feet ripple the floor
pub const MAX_QUAKES: usize = 4; // quake rings at the same time
pub const CORE_COUNT: usize = 44;
pub const STREAK_COUNT: usize = 40;
pub const MOTE_COUNT: usize = 1400;
/// a safety cap for absurd wall setups (a real one has some 30000 blackwall dots)
const MAX_WALL: usize = 400_000;

/// Small deterministic random generator (the world looks the same on every load).
pub struct Mulberry(u32);

impl Mulberry {
    pub fn new(seed: u32) -> Self {
        Self(seed)
    }

    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

/// What the dot spacing depends on: { eyeH, eyeDist, ledPx, wallW }
#[derive(Clone, Copy)]
pub struct View {
    pub eye_h: f32,
    pub eye_dist: f32,
    pub led_px: f32,
    pub wall_w: f32,
}

/// The instance data of every part (4 floats per instance, the blackwall 8).
#[derive(Default)]
pub struct WorldData {
    /// X, Z, row, random
    pub floor: Vec<f32>,
    /// x, y, z, column random | angle, random, top, 0
    pub wall: Vec<f32>,
    /// x, height, width, random
    pub core: Vec<f32>,
    /// x, z, height, random
    pub streaks: Vec<f32>,
    /// x, y, z, random
    pub motes: Vec<f32>,
}

impl WorldData {
    /// (Re)builds everything for the view.
    pub fn build(&mut self, view: View) {
        let mut rnd = Mulberry::new(11);
        let eye_h = f64::from(view.eye_h);
        let eye_dist = f64::from(view.eye_dist);
        let led_px = f64::from(view.led_px);
        let wall_w = f64::from(view.wall_w);
        let px = |z: f64| (led_px * (eye_dist - z)) / eye_dist; // world meters per LED at depth Z
        let half_view = |z: f64| ((wall_w / 2.0 + 1.5) * (eye_dist - z)) / eye_dist + 1.0;
        let push = |v: &mut Vec<f32>, a: [f64; 4]| v.extend(a.iter().map(|x| *x as f32));

        // ---------- floor: rows of dots, about 2.4 LEDs apart on the wall ----------
        self.floor.clear();
        let mut z = -0.03;
        while eye_dist - z < 75.0 && self.floor.len() < 4 * 90_000 {
            let dz = eye_dist - z;
            let dx = 2.6 * px(z);
            let half = half_view(z);
            if !(dx > 1e-5 && half.is_finite()) {
                break; // a view out of range (the params are not clamped): no endless rows
            }
            let row = rnd.next();
            let mut x = -half;
            while x <= half {
                let jx = x + (rnd.next() - 0.5) * dx * 0.5;
                let w = rnd.next();
                push(&mut self.floor, [jx, z, row, w]);
                x += dx;
            }
            z -= 0.02_f64.max((2.4 * led_px * dz * dz) / (eye_h.max(0.3) * eye_dist));
        }

        // ---------- the blackwall: an arena of particle columns, far in the middle, near at the sides ----------
        // an ellipse around the scene: Z = -15 - 57 cos(th), X = 46 sin(th); seen at a slant at the sides
        self.wall.clear();
        let (a, b) = (46.0_f64, 57.0_f64);
        for sgn in [1.0_f64, -1.0] {
            let mut th: f64 = if sgn > 0.0 { 0.0 } else { -1e-6 };
            while th.abs() < std::f64::consts::FRAC_PI_2 && self.wall.len() < 8 * MAX_WALL {
                let x = a * th.sin();
                let z = -15.0 - b * th.cos();
                let dist = eye_dist - z;
                if x.abs() / dist > (wall_w / 2.0 + 2.0) / eye_dist + 0.25 {
                    break;
                }
                let gap = (2.4 * led_px * dist.hypot(x)) / eye_dist;
                if !(gap > 1e-5 && gap.is_finite()) {
                    break;
                }
                let top = 9.0 + rnd.next().powi(2) * 28.0;
                let col = rnd.next();
                let mut y = -1.5;
                while y <= top {
                    let r = rnd.next();
                    push(&mut self.wall, [x, y, z, col]);
                    push(&mut self.wall, [th, r, top, 0.0]);
                    y += gap;
                }
                th += sgn * (gap / (a * th.cos()).hypot(b * th.sin()));
            }
        }

        // ---------- the core: a glowing tear of light in the middle of the wall ----------
        self.core.clear();
        for _ in 0..CORE_COUNT {
            let g = (rnd.next() + rnd.next() + rnd.next()) / 3.0 - 0.5; // more of them in the middle
            let height = (6.0 + rnd.next().powf(1.5) * 30.0) * (1.0 - g.abs() * 1.2);
            let width = 0.15 + rnd.next().powi(2) * 0.7;
            let w = rnd.next();
            push(&mut self.core, [g * 7.0, height, width, w]);
        }

        // ---------- streaks: thin vertical lines of light in the distance ----------
        self.streaks.clear();
        for _ in 0..STREAK_COUNT {
            let z = -14.0 - rnd.next() * 50.0;
            let x = (rnd.next() * 2.0 - 1.0) * half_view(z);
            let height = 4.0 + rnd.next().powi(2) * 40.0;
            let w = rnd.next();
            push(&mut self.streaks, [x, z, height, w]);
        }

        // ---------- motes drifting in the air ----------
        self.motes.clear();
        for _ in 0..MOTE_COUNT {
            let z = -0.3 - rnd.next().powf(1.4) * 22.0;
            let x = (rnd.next() * 2.0 - 1.0) * half_view(z);
            let y = rnd.next() * (eye_h + (2.2 * (eye_dist - z)) / eye_dist);
            let w = rnd.next();
            push(&mut self.motes, [x, y, z, w]);
        }
    }
}
