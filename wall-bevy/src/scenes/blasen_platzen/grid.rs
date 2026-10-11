//! The people on the wall as a grid of cells in meters (port of grid.js): every person pixel is put
//! into the room and mapped onto the wall by the scene's projection (ctx.wall: mirror, the play field
//! stretched over the wall, each person's place and body size). A person covers as much wall as they
//! are wide, at the place the mapping gives them, whether near the sensor or far.
//!
//! Per cell: the slot of the front-most person (0 = nobody), whether it was covered in this frame for
//! the first time (an edge of a body moved in) and a fading "activity" for the picture (moving edges
//! glow). "First time" is measured in real meters: the stretched walk moves a person's silhouette
//! faster than the person (their offset on the wall changes as they walk), and that part is taken out.
//! Each person's offset (wall x = offset + mirrorSign·planX·scale) is snapped to whole cells, so this
//! comparison is exact. Someone held at the wall's edge keeps their exact offset: their silhouette
//! stands still there while they walk on, and that is what counts for them.

use crate::persons::PersonsResult;
use crate::wall::{Edge, LUT_N, WallMap};

/// m: 400 x 133 cells on a 6 x 2 m wall, finer than the depth pixels at 2-4 m
pub const CELL: f32 = 0.015;
const EMPTY_MM: u16 = 0xffff;
const SLOTS: usize = 17;
// how a slot's pixels are placed: stretched like points (no shift), shifted as a whole, held at the edge
const STRETCHED: u8 = 0;
const SNAPPED: u8 = 1;
const HELD: u8 = 2;
/// segments of the projection's curve tables
const SEG: f32 = (LUT_N - 1) as f32;

/// JS Math.round (halves up)
fn js_round(x: f32) -> f32 {
    (x + 0.5).floor()
}

/// wall.map_y() as a table of its own 33 knots: the same piecewise-linear curve (and its straight
/// continuation beyond the ends), evaluated inline for the per-pixel loop
struct YCurve {
    low: f32,
    inv: f32,
    v: [f32; LUT_N],
}

impl YCurve {
    fn new(wall: &WallMap) -> Self {
        let p = &wall.projection;
        let span = (p.high - p.low).max(0.01);
        let mut v = [0.0; LUT_N];
        for (i, o) in v.iter_mut().enumerate() {
            *o = wall.map_y(p.low + span * i as f32 / SEG);
        }
        Self { low: p.low, inv: 1.0 / span, v }
    }

    /// (the end segments go on beyond 0..1 by themselves: no branches)
    #[inline(always)]
    fn at(&self, y: f32) -> f32 {
        let v = &self.v;
        let f = (y - self.low) * self.inv * SEG;
        let i = (f.max(0.0) as usize).min(LUT_N - 2);
        v[i] + (v[i + 1] - v[i]) * (f - i as f32)
    }
}

/// Contact of a circle with the people (see `WallGrid::probe`).
#[derive(Clone, Copy, Debug, Default)]
pub struct Probe {
    /// m² of the circle covered by a person
    pub covered: f64,
    /// m² newly covered in this frame
    pub fresh: f64,
    /// m of body outline inside the circle
    pub edge: f64,
    /// from the covered part to the center (m, y up)
    pub dx: f64,
    pub dy: f64,
    /// who moved into it (most fresh cells), 0 = nobody
    pub slot: u8,
}

pub struct WallGrid {
    pub w: usize,
    pub h: usize,
    /// mm of the front-most person point
    front: Vec<u16>,
    slot: Vec<u8>,
    /// slot of the last update
    prev: Vec<u8>,
    /// covered now, not covered before (compensated, see above)
    is_fresh: Vec<u8>,
    act: Vec<f32>,
    tmp: Vec<u8>,
    /// rgba8: covered, slot, activity, fresh
    pub tex: Vec<u8>,
    /// cells covered in the last update
    pub covered: u32,
    // per slot: how it is placed (STRETCHED, SNAPPED, HELD), its offset in whole cells (SNAPPED) or m
    // (HELD), the person's id; the same of the last update; the cells the offset moved by since then
    mode: [u8; SLOTS],
    shift_cells: [i32; SLOTS],
    shift_m: [f32; SLOTS],
    ids: [u32; SLOTS],
    prev_mode: [u8; SLOTS],
    prev_shift: [i32; SLOTS],
    prev_ids: [u32; SLOTS],
    moved: [i32; SLOTS],
}

impl WallGrid {
    pub fn new(wall_w: f32, wall_h: f32) -> Self {
        let w = (js_round(wall_w / CELL) as usize).max(8);
        let h = (js_round(wall_h / CELL) as usize).max(8);
        let n = w * h;
        Self {
            w,
            h,
            front: vec![0; n],
            slot: vec![0; n],
            prev: vec![0; n],
            is_fresh: vec![0; n],
            act: vec![0.0; n],
            tmp: vec![0; n],
            tex: vec![0; n * 4],
            covered: 0,
            mode: [STRETCHED; SLOTS],
            shift_cells: [0; SLOTS],
            shift_m: [0.0; SLOTS],
            ids: [0; SLOTS],
            prev_mode: [STRETCHED; SLOTS],
            prev_shift: [0; SLOTS],
            prev_ids: [0; SLOTS],
            moved: [0; SLOTS],
        }
    }

    /// Rebuilds the grid from one person tracking result (ctx.kinect.persons) with the mapping of the
    /// wall core (ctx.wall, updated for the same result).
    pub fn update(&mut self, persons: &PersonsResult, rays: &[f32], x_sign: f32, wall: &WallMap) {
        let (w, h) = (self.w, self.h);
        let s = &wall.setup;
        let p = &wall.projection;
        let m = &wall.room;
        let plan_x0 = wall.plan_x0(); // plan x of the sensor
        let ms = wall.mirror_sign();
        let top = s.bottom + s.size_h;
        let [near, far] = wall.zone(); // room z (m from the sensor)
        let inv = 1.0 / CELL;

        // the persons' offsets as wall.from_room(r, slot) applies them: snapped to cells, exact when held
        self.mode = [STRETCHED; SLOTS];
        self.ids = [0; SLOTS];
        let lo = p.margin.min(s.size_w / 2.0) + 1e-6;
        let hi = s.size_w - p.margin - 1e-6;
        for q in &wall.persons {
            let sl = usize::from(q.slot);
            if !(1..SLOTS).contains(&sl) {
                continue;
            }
            self.ids[sl] = q.id;
            if !p.per_person || !wall.visible[sl] {
                continue;
            }
            self.mode[sl] = if p.edge == Edge::Clamp && (q.x <= lo || q.x >= hi) { HELD } else { SNAPPED };
            self.shift_cells[sl] = js_round(wall.offset[sl] * inv) as i32;
            self.shift_m[sl] = wall.offset[sl];
        }
        // how many cells each silhouette was moved by the change of its shift: not the person's motion
        for sl in 1..SLOTS {
            let same = self.mode[sl] == SNAPPED && self.prev_mode[sl] == SNAPPED && self.ids[sl] == self.prev_ids[sl];
            self.moved[sl] = if same { self.shift_cells[sl] - self.prev_shift[sl] } else { 0 };
        }

        // per label (a u8: no lookup can miss): how its pixels are placed, the body scale on the wall,
        // the height scale of wall.room_y() and the shift
        let mut how = [STRETCHED; 256];
        let mut scale = [1.0_f32; 256];
        let mut ky = [1.0_f32; 256];
        let mut shift_c = [0.0_f32; 256];
        let mut shift_m = [0.0_f32; 256];
        for sl in 1..SLOTS {
            how[sl] = self.mode[sl];
            scale[sl] = wall.scale[sl];
            ky[sl] = if p.per_person && wall.visible[sl] { wall.scale[sl] } else { 1.0 };
            shift_c[sl] = self.shift_cells[sl] as f32;
            shift_m[sl] = self.shift_m[sl];
        }
        let map_y = YCurve::new(wall);
        let (wf, hf) = (w as f32, h as f32);
        self.front.fill(EMPTY_MM);
        self.slot.fill(0);
        if let (Some(indices), Some(labels), Some(depth)) = (&persons.indices, &persons.labels, &persons.depth) {
            let n = depth.len().min(labels.len()).min(rays.len() / 2);
            let count = persons.count.min(indices.len());
            for &iu in &indices[..count] {
                let i = iu as usize;
                if i >= n {
                    continue;
                }
                let mm = depth[i];
                if mm < 100 {
                    continue;
                }
                let z = f32::from(mm) * 0.001;
                let wx = x_sign * rays[2 * i] * z;
                let wy = -rays[2 * i + 1] * z;
                let rz = m[2] * wx + m[6] * wy + m[10] * z + m[14];
                if rz < near || rz > far {
                    continue;
                }
                let rx = m[0] * wx + m[4] * wy + m[8] * z + m[12];
                let ry = m[1] * wx + m[5] * wy + m[9] * z + m[13];
                let sl = labels[i];
                let si = usize::from(sl);
                // wall.room_x(): the body around the person's place (offset + mirrorSign·planX·scale), or
                // every point through the projection. The cell before its floor: floor(u) is in 0..n
                // exactly when u is, and then it is u's integer part (floor(v) + shift = floor(v + shift))
                let gx = match how[si] {
                    SNAPPED => ms * (plan_x0 + x_sign * rx) * scale[si] * inv + shift_c[si],
                    HELD => (ms * (plan_x0 + x_sign * rx) * scale[si] + shift_m[si]) * inv,
                    _ => wall.room_x(rx, rz, 0) * inv,
                };
                let gy = (top - map_y.at(ry * ky[si])) * inv;
                // (written so that NaN fails too)
                if !(gx >= 0.0 && gx < wf && gy >= 0.0 && gy < hf) {
                    continue;
                }
                let c = gy as usize * w + gx as usize;
                if mm < self.front[c] {
                    self.front[c] = mm;
                    self.slot[c] = sl;
                }
            }
        }

        // close single holes and drop single specks (8 neighbours: >= 6 covered fills, <= 1 clears);
        // the neighbours counted from rolling column sums
        self.tmp.copy_from_slice(&self.slot);
        for y in 1..h - 1 {
            let up = &self.tmp[(y - 1) * w..y * w];
            let mid = &self.tmp[y * w..(y + 1) * w];
            let dn = &self.tmp[(y + 1) * w..(y + 2) * w];
            let out = &mut self.slot[y * w..(y + 1) * w];
            let col = |x: usize| u8::from(up[x] != 0) + u8::from(mid[x] != 0) + u8::from(dn[x] != 0);
            let (mut a, mut b) = (col(0), col(1));
            for x in 1..w - 1 {
                let c = col(x + 1);
                let here = mid[x] != 0;
                let n = a + b + c - u8::from(here);
                if !here && n >= 6 {
                    // the same as the browser: the last covered neighbour in reading order gives its slot
                    out[x] = [dn[x + 1], dn[x], dn[x - 1], mid[x + 1], mid[x - 1], up[x + 1], up[x], up[x - 1]].into_iter().find(|v| *v != 0).unwrap_or(0);
                } else if here && n <= 1 {
                    out[x] = 0;
                }
                a = b;
                b = c;
            }
        }

        // compare with the last update where the same piece of body was then: `moved` cells to the side
        // for the person here now (or, where nobody is now, the one who was here); a label that is no
        // slot never was there (NaN in the browser)
        let mut moved = [i32::MAX / 2; 256];
        moved[..SLOTS].copy_from_slice(&self.moved);
        let mut covered = 0u32;
        for y in 0..h {
            let row = y * w;
            let slot_row = &self.slot[row..row + w];
            let prev_row = &self.prev[row..row + w];
            let fresh_row = &mut self.is_fresh[row..row + w];
            let act_row = &mut self.act[row..row + w];
            let tex_row = &mut self.tex[row * 4..(row + w) * 4];
            for (x, (((&sc, fr), act), px)) in slot_row.iter().zip(fresh_row.iter_mut()).zip(act_row.iter_mut()).zip(tex_row.as_chunks_mut::<4>().0.iter_mut()).enumerate() {
                let is = sc != 0;
                let who = if is { sc } else { prev_row[x] };
                let xp = x as i64 - i64::from(moved[usize::from(who)]);
                let was = xp >= 0 && xp < w as i64 && prev_row[xp as usize] != 0;
                let f = is && !was;
                *fr = u8::from(f);
                *act = (*act * 0.82).max(if was != is { 1.0 } else { 0.0 });
                covered += u32::from(is);
                px[0] = if is { 255 } else { 0 };
                px[1] = sc;
                px[2] = (*act * 255.0 + 0.5) as u8; // Math.round of 0..255
                px[3] = if f { 255 } else { 0 };
            }
        }
        self.prev.copy_from_slice(&self.slot);
        self.prev_mode = self.mode;
        self.prev_shift = self.shift_cells;
        self.prev_ids = self.ids;
        self.covered = covered;
    }

    /// Clears everything (nobody there, or no data for a while).
    pub fn clear(&mut self) {
        self.slot.fill(0);
        self.prev.fill(0);
        self.is_fresh.fill(0);
        self.act.fill(0.0);
        self.tex.fill(0);
        self.prev_mode = [STRETCHED; SLOTS];
        self.covered = 0;
    }

    /// Contact of a circle (wall m: x from the left edge, y = height above the floor) with the people.
    /// covered/fresh: m² of the circle covered by a person / newly covered in this frame;
    /// edge: m of body outline inside the circle; fresh / edge is how far the outline moved in this
    /// frame (a still body's outline flickers by single cells: thin, so it moves "slowly");
    /// dx, dy: from the covered part to the center (m), slot: who moved into it (most fresh cells).
    pub fn probe(&self, x: f64, y: f64, r: f64, top: f64) -> Probe {
        let (w, h) = (self.w as i64, self.h as i64);
        let inv = 1.0 / f64::from(CELL);
        let cx = x * inv;
        let cy = (top - y) * inv;
        let rc = r * inv;
        if !(cx.is_finite() && cy.is_finite() && rc.is_finite()) {
            return Probe::default();
        }
        let x0 = ((cx - rc).floor() as i64).max(0);
        let x1 = ((cx + rc).ceil() as i64).min(w - 1);
        let y0 = ((cy - rc).floor() as i64).max(0);
        let y1 = ((cy + rc).ceil() as i64).min(h - 1);
        let (mut cov, mut fresh, mut edge) = (0u32, 0u32, 0u32);
        let (mut sx, mut sy) = (0.0_f64, 0.0_f64);
        let mut votes = [0u16; SLOTS];
        let wu = self.w;
        for gy in y0..=y1 {
            let ddy = gy as f64 + 0.5 - cy;
            for gx in x0..=x1 {
                let ddx = gx as f64 + 0.5 - cx;
                if ddx * ddx + ddy * ddy > rc * rc {
                    continue;
                }
                let c = gy as usize * wu + gx as usize;
                let s = self.slot[c];
                if s == 0 {
                    continue;
                }
                cov += 1;
                if gx == 0 || gx == w - 1 || gy == 0 || gy == h - 1 || self.slot[c - 1] == 0 || self.slot[c + 1] == 0 || self.slot[c - wu] == 0 || self.slot[c + wu] == 0 {
                    edge += 1;
                }
                sx += ddx;
                sy += ddy;
                if self.is_fresh[c] != 0 {
                    fresh += 1;
                    if let Some(v) = votes.get_mut(usize::from(s)) {
                        *v += 1;
                    }
                }
            }
        }
        let mut who = 0usize;
        for s in 1..SLOTS {
            if votes[s] > votes[who] {
                who = s;
            }
        }
        let cell = f64::from(CELL);
        let area = cell * cell;
        // (sx, sy) points from the center to the covered part, in cells, y down
        let n = f64::from(cov);
        Probe {
            covered: n * area,
            fresh: f64::from(fresh) * area,
            edge: f64::from(edge) * cell,
            dx: if cov > 0 { -sx / n * cell } else { 0.0 },
            dy: if cov > 0 { sy / n * cell } else { 0.0 },
            slot: who as u8,
        }
    }
}
