//! The strokes of the blades, smooth and on the GPU (strokes.js; render.rs draws them as soft
//! ribbons, added onto the picture before the bloom):
//! - the blade: the live hand, a thin crisp stroke, a white core in a glow of the player's color,
//!   thick at the tip, thin at the tail;
//! - the woosh: the exact skeletons follow 0.1-0.2 s later and draw the same swipe once more, thick
//!   and soft with speed lines in it, like a gust of wind after the blade; it drifts on in the
//!   direction of the swipe, widens and fades;
//! - the slash: the cut through a fruit, a white lens.
//!
//! The tracking points come at 30 per second and wobble by a few cm, so a stroke does not follow
//! them directly. A tracer runs a little behind them (`smoothDelay`, about two points): there the
//! points before and after are known, and a Catmull-Rom spline through them gives a smooth path; the
//! tip follows that path on a damped spring (`inertia`), which takes out what wobble is left. Its
//! trail, sampled every frame, is the stroke. Cutting does not wait for any of this (people.rs,
//! game.rs).

use super::game::Game;
use super::people::{Blade, BladeKey, People, Pt};
use super::pix::Rgb;
use super::{Layout, P};

/// per vertex: x, y (LED px), across (-1..1), along (0..1) | r, g, b, a | core, kind, 0, 0
pub const FLOATS: usize = 12;
pub const MAX_TRAIL_VERTS: usize = 30000;
const BLADE: f32 = 0.0;
const WOOSH: f32 = 1.0;

fn mix_white(c: Rgb, k: f32) -> Rgb {
    [c[0] + (1.0 - c[0]) * k, c[1] + (1.0 - c[1]) * k, c[2] + (1.0 - c[2]) * k]
}

fn smoothstep(a: f64, b: f64, x: f64) -> f64 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn cr(p0: f64, p1: f64, p2: f64, p3: f64, t: f64) -> f64 {
    0.5 * (2.0 * p1 + (-p0 + p2) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t * t + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t * t * t)
}

#[derive(Clone, Copy)]
struct TrailPt {
    x: f64,
    y: f64,
    t: f64,
    v: f64,
}

/// A smooth tip that follows tracked points: at time `now - delay` on a Catmull-Rom spline through
/// them, on a damped spring. Its trail (every frame) is what is drawn.
struct Tracer {
    key: BladeKey,
    x: Option<f64>,
    y: f64,
    vx: f64,
    vy: f64,
    t: f64,
    trail: Vec<TrailPt>,
    seen: f64,
    col: Rgb,
    id: Option<u32>,
    slot: u8,
}

impl Tracer {
    fn new(key: BladeKey) -> Self {
        Self { key, x: None, y: 0.0, vx: 0.0, vy: 0.0, t: 0.0, trail: Vec::with_capacity(128), seen: 0.0, col: [1.0; 3], id: None, slot: 0 }
    }

    /// pts: [x, y, t] (t: when the point counts, ascending)
    fn update(&mut self, pts: &[[f64; 3]], now: f64, delay: f64, omega: f64, keep: f64, max_jump: f64) {
        let (Some(first), Some(_)) = (pts.first(), pts.last()) else { return };
        self.seen = now;
        let tt = now - delay;
        let last = pts.len() - 1;
        let mut k = last;
        while k > 0 && pts[k][2] > tt {
            k -= 1;
        }
        let (tx, ty) = if tt <= first[2] {
            (first[0], first[1])
        } else if k >= last {
            (pts[k][0], pts[k][1]) // past the newest point: hold it
        } else {
            let p0 = pts[k.saturating_sub(1)];
            let p1 = pts[k];
            let p2 = pts[k + 1];
            let p3 = pts[(k + 2).min(last)];
            let u = ((tt - p1[2]) / (p2[2] - p1[2]).max(1e-4)).clamp(0.0, 1.0);
            (cr(p0[0], p1[0], p2[0], p3[0], u), cr(p0[1], p1[1], p2[1], p3[1], u))
        };
        match self.x {
            Some(x) if (tx - x).hypot(ty - self.y) <= max_jump && now - self.t <= 0.5 => {
                // a critically damped spring, in small steps
                let mut x = x;
                let mut dt = (now - self.t).min(0.1);
                while dt > 1e-6 {
                    let h = dt.min(1.0 / 120.0);
                    self.vx += (omega * omega * (tx - x) - 2.0 * omega * self.vx) * h;
                    self.vy += (omega * omega * (ty - self.y) - 2.0 * omega * self.vy) * h;
                    x += self.vx * h;
                    self.y += self.vy * h;
                    dt -= h;
                }
                self.x = Some(x);
            }
            _ => {
                // new, or the hand was lost: start here
                self.x = Some(tx);
                self.y = ty;
                self.vx = 0.0;
                self.vy = 0.0;
                self.trail.clear();
            }
        }
        self.t = now;
        self.trail.push(TrailPt { x: self.x.unwrap_or(tx), y: self.y, t: now, v: self.vx.hypot(self.vy) });
        let mut n = 0;
        while n + 1 < self.trail.len() && now - self.trail[n].t > keep {
            n += 1;
        }
        if n > 0 {
            self.trail.drain(..n);
        }
    }
}

pub struct Strokes {
    /// the vertices of this frame (FLOATS each), `n` of them
    pub buf: Vec<f32>,
    pub n: usize,
    blades: Vec<Tracer>,
    wooshes: Vec<Tracer>,
    // scratch (no allocation per frame)
    pts: Vec<[f64; 3]>,
    raw: Vec<[f64; 4]>,
    side_l: Vec<[f64; 2]>,
    side_r: Vec<[f64; 2]>,
}

/// which time of a blade's points counts: when it was measured (live), when it is shown (woosh)
#[derive(Clone, Copy)]
enum Clock {
    Measured,
    Shown,
}

impl Strokes {
    pub fn new() -> Self {
        Self {
            buf: vec![0.0; MAX_TRAIL_VERTS * FLOATS],
            n: 0,
            blades: Vec::with_capacity(32),
            wooshes: Vec::with_capacity(32),
            pts: Vec::with_capacity(128),
            raw: Vec::with_capacity(128),
            side_l: Vec::with_capacity(128),
            side_r: Vec::with_capacity(128),
        }
    }

    /// The tracers of a set of blades.
    #[allow(clippy::too_many_arguments)]
    fn trace(map: &mut Vec<Tracer>, pts: &mut Vec<[f64; 3]>, blades: &[Blade], now: f64, p: &P, keep: f64, clock: Clock) {
        let omega = p.inertia;
        for b in blades {
            let i = match map.iter().position(|t| t.key == b.key) {
                Some(i) => i,
                None => {
                    map.push(Tracer::new(b.key));
                    map.len() - 1
                }
            };
            let tr = &mut map[i];
            tr.col = b.col;
            tr.id = b.id;
            tr.slot = b.slot;
            pts.clear();
            let time = |q: &Pt| match clock {
                Clock::Measured => q.t,
                Clock::Shown => q.a,
            };
            pts.extend(b.pts.iter().map(|q| [q.x, q.y, time(q)]).filter(|q| q[2] <= now + 1.0));
            tr.update(pts, now, p.smooth_delay, omega, keep, p.max_jump);
        }
        map.retain(|tr| blades.iter().any(|b| b.key == tr.key) && now - tr.seen <= 0.6);
    }

    /// A ribbon along `self.raw` ([x, y, halfWidth, alpha] in LED px), color col, kind, core: the
    /// share of the half width that is the crisp white core (blades).
    fn ribbon(&mut self, col: Rgb, kind: f32, core: f32) {
        let pts = &self.raw;
        let m = pts.len();
        if m < 2 || self.n + (m - 1) * 6 > MAX_TRAIL_VERTS {
            return;
        }
        self.side_l.clear();
        self.side_r.clear();
        for i in 0..m {
            let a = pts[i.saturating_sub(1)];
            let b = pts[(i + 1).min(m - 1)];
            let (mut dx, mut dy) = (b[0] - a[0], b[1] - a[1]);
            let l = dx.hypot(dy);
            let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
            dx /= l;
            dy /= l;
            let w = pts[i][2];
            self.side_l.push([pts[i][0] - dy * w, pts[i][1] + dx * w]);
            self.side_r.push([pts[i][0] + dy * w, pts[i][1] - dx * w]);
        }
        let along = 1.0 / (m - 1) as f64;
        let mut put = |n: &mut usize, q: [f64; 2], across: f32, i: usize| {
            let o = *n * FLOATS;
            if let Some(v) = self.buf.get_mut(o..o + FLOATS) {
                v.copy_from_slice(&[q[0] as f32, q[1] as f32, across, (i as f64 * along) as f32, col[0], col[1], col[2], pts[i][3] as f32, core, kind, 0.0, 0.0]);
                *n += 1;
            }
        };
        let (l, r) = (&self.side_l, &self.side_r);
        let mut n = self.n;
        for i in 0..m - 1 {
            put(&mut n, l[i], 1.0, i);
            put(&mut n, r[i], -1.0, i);
            put(&mut n, l[i + 1], 1.0, i + 1);
            put(&mut n, l[i + 1], 1.0, i + 1);
            put(&mut n, r[i], -1.0, i);
            put(&mut n, r[i + 1], -1.0, i + 1);
        }
        self.n = n;
    }

    /// All strokes of this frame; now: real time (s). Returns the number of vertices.
    pub fn build(&mut self, people: &People, game: &Game, l: &Layout, p: &P, now: f64) -> usize {
        self.n = 0;
        let k = l.ppm * l.s; // LEDs per m
        let top = l.top;
        let px = |x: f64| x * k;
        let py = |y: f64| (top - y) * k;
        let fast0 = p.cut_speed * 0.45;
        let fast1 = p.cut_speed;

        // the live blades: thin, thick at the tip; seen where the tip is fast
        Self::trace(&mut self.blades, &mut self.pts, &people.blades, now, p, p.trail, Clock::Measured);
        for bi in 0..self.blades.len() {
            let tr = &self.blades[bi];
            if tr.slot != 0 && !people.shown(tr.slot) {
                continue;
            }
            let (col, id, tx, ty) = (tr.col, tr.id, tr.x, tr.y);
            let n = tr.trail.len();
            if n >= 2 && tr.trail[n - 1].v >= fast0 * 0.5 {
                self.raw.clear();
                for (i, q) in tr.trail.iter().enumerate() {
                    let age = ((now - q.t) / p.trail).min(1.0);
                    let u = i as f64 / (n - 1) as f64;
                    let on = smoothstep(fast0, fast1, q.v);
                    self.raw.push([px(q.x), py(q.y), (p.blade_width * k * (0.25 + 0.75 * u.powf(0.7))).max(1.4), (1.0 - age).powf(0.9) * on]);
                }
                self.ribbon(col, BLADE, 0.38);
            }
            // the hand itself: a small soft point of light at the tip
            if id.is_some()
                && let Some(x) = tx
            {
                let r = p.blade_width * k * 0.8;
                self.raw.clear();
                self.raw.push([px(x) - r * 0.4, py(ty), r, 0.75]);
                self.raw.push([px(x) + r * 0.4, py(ty), r, 0.75]);
                self.ribbon(col, BLADE, 0.35);
            }
        }

        // the woosh: the exact blades, played back as their frames come in, wide and soft; it drifts on
        if p.woosh > 0.0 {
            let life = p.woosh_life;
            Self::trace(&mut self.wooshes, &mut self.pts, &people.exact_blades, now, p, life, Clock::Shown);
            for wi in 0..self.wooshes.len() {
                let tr = &self.wooshes[wi];
                let n = tr.trail.len();
                if n < 2 {
                    continue;
                }
                let col = mix_white(tr.col, 0.35);
                self.raw.clear();
                for i in 0..n {
                    let q = tr.trail[i];
                    let t = ((now - q.t) / life).min(1.0);
                    // the way the swipe went here: the gust drifts on that way
                    let a = tr.trail[i.saturating_sub(2)];
                    let b = tr.trail[(i + 2).min(n - 1)];
                    let l = (b.x - a.x).hypot(b.y - a.y);
                    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
                    let drift = p.woosh_drift * (1.0 - (1.0 - t).powi(2));
                    let on = smoothstep(fast0, fast1, q.v);
                    let w = p.woosh_width * k * (0.55 + 0.9 * t);
                    self.raw.push([px(q.x + (b.x - a.x) / l * drift), py(q.y + (b.y - a.y) / l * drift), w, p.woosh * on * (1.0 - t).powf(1.3) * 0.7]);
                }
                self.ribbon(col, WOOSH, 0.0);
            }
        }

        // the cuts through the fruit: a white lens along the cut
        for s in &game.slashes {
            let age = (game.real - s.t0) / s.life;
            self.raw.clear();
            for i in 0..=8 {
                let u = f64::from(i) / 8.0;
                let w = p.blade_width * k * 1.3 * (std::f64::consts::PI * u).sin().max(0.0).powf(0.6) * (1.0 + age * 0.6);
                self.raw.push([px(s.x0 + (s.x1 - s.x0) * u), py(s.y0 + (s.y1 - s.y0) * u), w, (1.0 - age).max(0.0).powf(1.5)]);
            }
            self.ribbon([1.0, 0.95, 0.85], BLADE, 0.55);
        }
        self.n
    }
}
