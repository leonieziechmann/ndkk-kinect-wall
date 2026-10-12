//! The people of the mirror (people.js), as point clouds from the original depth data (like the
//! three.js particles): every person pixel (or every 2nd/3rd, so the rows stay visible on the LEDs)
//! is a glowing dot where the wall mapping puts it (mirror.rs: ctx.wall with the stretched walk, then
//! into the mirror world), colored by its distance from the wall and brightened by the infrared
//! image. Behind the dots an almost black body hides the world, so everyone stands in front of it as
//! a dark self. The contour is brighter, bands of the body glitch sideways now and then, and whoever
//! comes in is scanned in from the head down (scene.wgsl: vs_people, vs_body).
//!
//! build() runs once per person tracking result on the CPU.

use wall::persons::PersonsResult;

use super::mirror::Mirror;

const W: usize = 512;
const H: usize = 424;
const N: usize = W * H;
pub const MAX_POINTS: usize = 150_000;
/// floats per point: x y z | contour, ir, slot + random / 2, distance 0..1 (near..far) | dot, body (m)
pub const FLOATS: usize = 9;
const JUMP: i32 = 110; // mm: a larger depth step between neighbors is an edge
const BORDER: usize = 14; // px: people dissolve towards the image border instead of being cut off straight
pub const RES: usize = 256; // contour points kept per slot (for the burst when someone leaves)
const CONTOUR: usize = 16384;

/// Contour points of one slot (reservoir sampling).
pub struct Reservoir {
    pub n: usize,
    seen: u32,
    pub xyz: Vec<f32>,
}

/// fx, step (1..3), near, far (m from the wall, colors), dot size on the wall (m), spread (how much
/// wider than real the mapping draws the points: closes the gaps)
pub struct BuildOpts {
    pub fx: f32,
    pub step: usize,
    pub near: f32,
    pub far: f32,
    pub dot_led: f32,
    pub spread: f32,
}

pub struct People {
    /// the instance data of the points (FLOATS each)
    pub data: Vec<f32>,
    pub count: usize,
    /// point indices on the contour, to shed particles from
    pub contour: Vec<u32>,
    pub contour_count: usize,
    pub reservoir: Vec<Reservoir>,
    seed: u32,
}

/// A neighbor that is not the same person, or clearly farther away, makes a silhouette edge;
/// something clearly nearer (an arm in front of the body) does not make an edge here.
/// (lab and dep hold N values: build() checks it, and the neighbors stay inside the image)
#[inline(always)]
fn far(lab: &[u8], dep: &[u16], j: usize, s: u8, d: i32) -> bool {
    let d2 = i32::from(dep[j]);
    if lab[j] == s && d2 != 0 {
        return d2 - d > JUMP;
    }
    !(d2 != 0 && d2 < d - JUMP)
}

#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn edge_at(lab: &[u8], dep: &[u16], i: usize, u: usize, v: usize, s: u8, d: i32, e: usize) -> bool {
    (u >= e && far(lab, dep, i - e, s, d)) || (u + e < W && far(lab, dep, i + e, s, d)) || (v >= e && far(lab, dep, i - e * W, s, d)) || (v + e < H && far(lab, dep, i + e * W, s, d))
}

impl People {
    pub fn new() -> Self {
        Self {
            data: vec![0.0; MAX_POINTS * FLOATS],
            count: 0,
            contour: vec![0; CONTOUR],
            contour_count: 0,
            reservoir: (0..17).map(|_| Reservoir { n: 0, seen: 0, xyz: vec![0.0; RES * 3] }).collect(),
            seed: 12345,
        }
    }

    fn rand(&mut self) -> f64 {
        self.seed = self.seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        f64::from(self.seed) / 4_294_967_296.0
    }

    /// the mirror position of point n
    pub fn pos(&self, n: usize) -> [f32; 3] {
        let o = n * FLOATS;
        match self.data.get(o..o + 3) {
            Some(p) => [p[0], p[1], p[2]],
            None => [0.0; 3],
        }
    }

    /// info value k (0 contour, 1 ir, 2 slot + random, 3 distance) of point n
    pub fn info(&self, n: usize, k: usize) -> f32 {
        self.data.get(n * FLOATS + 3 + k).copied().unwrap_or(0.0)
    }

    /// One person tracking result -> particles. rays: ctx.kinect.rays, ir: the infrared image or None,
    /// m: camera frame (m) -> mirror world for this frame.
    pub fn build(&mut self, k: &PersonsResult, rays: &[f32], ir: Option<&[u8]>, m: &Mirror, o: &BuildOpts) {
        for r in &mut self.reservoir {
            r.n = 0;
            r.seen = 0;
        }
        self.count = 0;
        self.contour_count = 0;
        let (Some(lab), Some(dep), Some(idx)) = (k.labels.as_deref(), k.depth.as_deref(), k.indices.as_deref()) else {
            return;
        };
        if lab.len() < N || dep.len() < N || rays.len() < 2 * N {
            return;
        }
        let ir = ir.filter(|d| d.len() >= N);
        let idx = &idx[..k.count.min(idx.len())];
        let st = o.step.clamp(1, 3);
        let span = (o.far - o.near).max(0.1);
        let d_eye = m.eye[2];
        let mut n = 0;
        let mut nc = 0;
        for &i in idx {
            if n >= MAX_POINTS {
                break;
            }
            let i = i as usize;
            if i >= N {
                continue;
            }
            let v = i / W;
            let u = i - v * W;
            if st > 1 && (!u.is_multiple_of(st) || !v.is_multiple_of(st)) {
                continue;
            }
            let s = lab[i];
            let d = dep[i];
            if s == 0 || d == 0 {
                continue;
            }
            let border = u.min(W - 1 - u).min(v).min(H - 1 - v);
            if border < BORDER && self.rand() * BORDER as f64 > border as f64 {
                continue;
            }
            let d = i32::from(d);
            let edge = if edge_at(lab, dep, i, u, v, s, d, st) {
                1.0
            } else if edge_at(lab, dep, i, u, v, s, d, 2 * st) {
                0.45
            } else {
                0.0
            };

            let z = d as f32 * 0.001;
            // a fixed jitter per pixel (up to a third of the spacing): no moire with the LED grid
            let h = (i as u32).wrapping_mul(2_654_435_761); // fixed random bits per pixel
            let jx = ((h & 1023) as f32 / 1023.0 - 0.5) * 0.66 * st as f32;
            let jy = (((h >> 10) & 1023) as f32 / 1023.0 - 0.5) * 0.66 * st as f32;
            let r0 = rays[2 * i];
            let r1 = rays[2 * i + 1];
            // the next ray to the right (JS: `|| 0.0027` for 0 or a missing one)
            let step_x = rays.get(2 * i + 2).map(|r| r - r0).filter(|dx| *dx != 0.0 && !dx.is_nan()).unwrap_or(0.0027);
            let step_y = if v + 1 < H { rays[2 * i + 2 * W + 1] - r1 } else { 0.0027 };
            let rx = r0 + jx * step_x;
            let ry = r1 + jy * step_y;
            let [x, y, zz] = m.from_camera(rx * z, ry * z, z, s as usize);
            let ir_v = match ir {
                Some(ir) => (f32::from(ir[i]) / 160.0).min(1.0),
                None => 0.5,
            };
            let o9 = n * FLOATS;
            let Some(out) = self.data.get_mut(o9..o9 + FLOATS) else {
                break;
            };
            out[0] = x;
            out[1] = y;
            out[2] = zz;
            out[3] = edge;
            out[4] = ir_v;
            out[5] = f32::from(s) + ((h >> 20) as f32 / 4095.0) * 0.49;
            out[6] = ((m.distance(zz) - o.near) / span).clamp(0.0, 1.0);
            // dot: a fixed size on the wall; body: closes the gaps between the dots
            out[7] = (o.dot_led * (d_eye - zz)) / d_eye;
            out[8] = (1.9 * st as f32 * z * o.spread * m.scale(zz)) / o.fx;
            if edge >= 1.0 {
                if nc < self.contour.len() {
                    self.contour[nc] = n as u32;
                    nc += 1;
                }
                let s = s as usize;
                if s < self.reservoir.len() {
                    self.reservoir[s].seen += 1;
                    let at = if self.reservoir[s].n < RES {
                        let a = self.reservoir[s].n;
                        self.reservoir[s].n += 1;
                        a
                    } else {
                        let seen = f64::from(self.reservoir[s].seen);
                        (self.rand() * seen).floor() as usize
                    };
                    if at < RES {
                        self.reservoir[s].xyz[at * 3..at * 3 + 3].copy_from_slice(&[x, y, zz]);
                    }
                }
            }
            n += 1;
        }
        self.count = n;
        self.contour_count = nc;
    }
}
