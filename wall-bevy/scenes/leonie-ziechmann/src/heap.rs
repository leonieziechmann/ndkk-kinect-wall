//! The leaf heap around the signs' feet (heap.js): the QR codes peek out only halfway. Whoever walks
//! towards a sign blows the heap in front of it away, and the code comes out whole; standing in
//! front of it keeps it clear. Feet and hands stirring in the heap scatter it too. With nobody
//! there for a while it grows back, also from the leaves that fall onto it.
//!
//! The heap is a height per column (`level` 0..1 times its full shape, highest at the codes'
//! middle), filled with packed leaves below its surface and loose leaves (cached pixel sprites) up
//! to it. Lowering the surface uncovers leaves: those fly off as leaves of leaves.rs, in front of
//! everything, in the direction the person walks.
//!
//! The shape (packed leaves, sprites) is built in the background (shape(): paint.rs) when the
//! layout or the wall changes; level, shape and lastBlow are f32 as the browser's Float32Arrays.

use super::forest::{Mulberry, palettes, pick_color};
use super::layout::{Layout, TURN, js_round};
use super::leafpix::{FLAT, ROUND, Raster, Sprite, blit, u32_hex};
use super::leaves::Leaves;
use super::persp::Place;
use super::bodies::Field;
use wall::common::rand::Rng;
use wall::map::Setup;

/// leaves sent flying per frame at most
const MAX_FLY: usize = 28;

/// What the heap's shape depends on (heap.js layout key).
#[derive(Clone, Debug, PartialEq)]
pub struct HeapSpec {
    pub w: f64,
    pub h: f64,
    pub s: f64,
    pub x0: f64,
    pub x1: f64,
    pub base: f64,
    /// per sign: cx, board width, the code's middle (y)
    pub signs: Vec<[f64; 3]>,
    pub size_w: f32,
    pub size_h: f32,
    pub bottom: f32,
}

impl HeapSpec {
    pub fn new(l: &Layout, s: &Setup) -> Self {
        Self { w: l.w, h: l.h, s: l.s, x0: l.heap.x0, x1: l.heap.x1, base: l.heap.base, signs: l.signs.iter().map(|g| [g.cx, g.bw, g.code_mid[1]]).collect(), size_w: s.size_w, size_h: s.size_h, bottom: s.bottom }
    }

    /// does it still describe this layout and wall? (no allocation)
    pub fn is(&self, l: &Layout, s: &Setup) -> bool {
        self.w == l.w
            && self.h == l.h
            && self.x0 == l.heap.x0
            && self.x1 == l.heap.x1
            && self.base == l.heap.base
            && self.signs.len() == l.signs.len()
            && self.signs.iter().zip(&l.signs).all(|(a, g)| a[0] == g.cx && a[1] == g.bw && a[2] == g.code_mid[1])
            && self.size_w == s.size_w
            && self.size_h == s.size_h
            && self.bottom == s.bottom
    }
}

struct HeapSign {
    cx: f64,
    w: f64,
    peak: f64,
    last_blow: f64,
    dir: f64,
    str: f64,
}

/// A loose leaf of the heap, lying at column i, h px above the bottom.
pub struct HeapLeaf {
    i: usize,
    h: f64,
    c: usize,
    size: f64,
    spr: Sprite,
    on: bool,
}

/// The heap's full shape for one layout (built in the background).
pub struct HeapShape {
    s: f64,
    kx: f64,
    ky: f64,
    top: f64,
    x0: f64,
    bottom: f64,
    n: usize,
    signs: Vec<HeapSign>,
    shape: Vec<f32>,
    fill_h: usize,
    fill: Vec<u32>,
    leaves: Vec<HeapLeaf>,
}

/// layout() of heap.js: the full heap, its packed leaves and its loose leaves.
pub fn shape(spec: &HeapSpec) -> HeapShape {
    let s = spec.s;
    let mut r = Mulberry::new(1789);
    let mut ras = Raster::new();
    let pals = palettes(253);
    let kx = spec.w / f64::from(spec.size_w);
    let ky = spec.h / f64::from(spec.size_h);
    let top = f64::from(spec.bottom) + f64::from(spec.size_h);
    let x0 = spec.x0.max(0.0);
    let x1 = spec.x1.min(spec.w);
    let bottom = spec.base;
    let n = (x1 - x0).max(0.0) as usize;
    let signs: Vec<HeapSign> = spec.signs.iter().map(|g| HeapSign { cx: g[0], w: g[1], peak: spec.base - g[2], last_blow: -99.0, dir: 1.0, str: 0.0 }).collect();
    // the full heap: a mound under every sign up to the code's middle, a saddle between them
    let peak = signs.iter().map(|g| g.peak).fold(1.0, f64::max);
    let mut shape = vec![0f32; n];
    for (i, v) in shape.iter_mut().enumerate() {
        let x = x0 + i as f64;
        let mut h: f64 = 0.0;
        for g in &signs {
            let u = (x - g.cx).abs() / (g.w * 0.78);
            h = h.max(g.peak * (-(u.powf(3.0))).exp());
        }
        let edge = ((x - x0) / (40.0 * s)).min((x1 - x) / (14.0 * s)).min(1.0);
        let e = edge.max(0.0);
        h *= e * e * (3.0 - 2.0 * e);
        h += ((x * 0.21).sin() * 2.0 + (x * 0.07 + 1.0).sin() * 3.0) * s * (h / (20.0 * s)).min(1.0);
        *v = h.max(0.0) as f32;
    }
    // packed leaves below the surface: an opaque base, densely covered with leaves; the base gets
    // darker towards the bottom (the heap's volume), leaves packed on top of it
    let fh = (peak + 14.0 * s).ceil().max(1.0) as usize;
    let mut fill = vec![0u32; n * fh];
    let shades = ["#f2c25a", "#eab04a", "#e0a043", "#d5923d"].map(|h| u32_hex(h, 253));
    for y in 0..fh {
        let t = y as f64 / fh as f64;
        for x in 0..n {
            let d = t * 3.0 + ((((x * 7 + y * 13) % 4) as f64) / 4.0 - 0.4) * 0.6;
            fill[y * n + x] = shades[(d.floor().clamp(0.0, 3.0)) as usize];
        }
    }
    let dense = js_round((n * fh) as f64 / (34.0 * s * s));
    let mut i = 0.0;
    while i < dense {
        let y = r.next() * fh as f64;
        // fewer reds and oranges deep inside
        let mut c = pick_color(r.next());
        if c >= 4 && r.next() < y / fh as f64 {
            c = 0;
        }
        let cx = r.next() * n as f64;
        let size = (10.0 + r.next() * 4.0) * s;
        let rot = r.next() * TURN;
        let sign = if r.next() < 0.5 { -1.0 } else { 1.0 };
        let flip = sign * (0.6 + r.next() * 0.4);
        ras.draw_leaf(&mut fill, n, fh, cx, y, size, rot, flip, &pals[c], ROUND | FLAT);
        i += 1.0;
    }
    // loose leaves up to the surface, bottom first (the top ones are drawn last)
    let area: f64 = shape.iter().map(|v| f64::from(*v)).sum();
    let count = js_round(area / (40.0 * s * s)).max(0.0) as usize;
    let mut leaves: Vec<HeapLeaf> = Vec::new();
    let mut k = 0;
    while k < count * 4 && leaves.len() < count {
        k += 1;
        let i = ((r.next() * n as f64).floor() as usize).min(n.saturating_sub(1));
        let h = r.next() * peak;
        if n == 0 || h > f64::from(shape[i]) - 2.0 * s {
            continue;
        }
        let c = pick_color(r.next());
        let size = (10.0 + r.next() * 4.5) * s;
        let rot = r.next() * TURN;
        let sign = if r.next() < 0.5 { -1.0 } else { 1.0 };
        let flip = sign * (0.55 + r.next() * 0.45);
        let mut spr = Sprite::default();
        ras.sprite(&mut spr, size, rot, flip, &pals[c], ROUND | FLAT);
        leaves.push(HeapLeaf { i, h, c, size, spr, on: true });
    }
    leaves.sort_by(|a, b| a.h.total_cmp(&b.h));
    HeapShape { s, kx, ky, top, x0, bottom, n, signs, shape, fill_h: fh, fill, leaves }
}

/// The heap as last drawn (it is drawn again only when it changed): its pixels over the image,
/// the rows they use, and what they show (the top row of every column; the loose leaves lying).
#[derive(Default)]
struct Drawn {
    w: usize,
    h: usize,
    px: Vec<u32>,
    rows: (usize, usize),
    tops: Vec<i64>,
    valid: bool,
}

/// The heap: its shape and how far it stands right now.
pub struct Heap {
    lay: Option<HeapShape>,
    level: Vec<f32>,
    last_blow: Vec<f32>,
    before: Vec<f32>,
    /// per person: distance from the sensor and its smoothed change
    approach: Vec<(u32, f64, f64)>,
    seen: Vec<u32>,
    drawn: Drawn,
    tops: Vec<i64>,
}

impl Heap {
    pub fn new() -> Self {
        Self { lay: None, level: Vec::new(), last_blow: Vec::new(), before: Vec::new(), approach: Vec::new(), seen: Vec::new(), drawn: Drawn::default(), tops: Vec::new() }
    }

    /// A new shape (a new layout): the heap stands full again.
    pub fn set_shape(&mut self, lay: HeapShape) {
        self.level = vec![1.0; lay.n];
        self.last_blow = vec![-99.0; lay.n];
        self.before = vec![0.0; lay.n];
        self.lay = Some(lay);
        self.drawn.valid = false;
    }

    /// The heap's surface at LED column px (height above the bottom, px), or 0 outside it.
    pub fn height_at(&self, px: f64) -> f64 {
        let Some(l) = &self.lay else { return 0.0 };
        let i = js_round(px - l.x0);
        if i < 0.0 || i >= l.n as f64 {
            return 0.0;
        }
        let i = i as usize;
        f64::from(self.level[i]) * f64::from(l.shape[i])
    }

    /// a leaf landed on the heap at column px: it grows a little there
    pub fn feed(&mut self, px: f64) {
        let Some(l) = &self.lay else { return };
        let i0 = js_round(px - l.x0) as i64;
        for d in -6i64..=6 {
            let i = i0 + d;
            if i >= 0 && (i as usize) < l.n {
                let v = &mut self.level[i as usize];
                *v = (f64::from(*v) + 0.01 * (1.0 - d.abs() as f64 / 7.0)).min(1.0) as f32;
            }
        }
    }

    /// places: the people on the wall, leaves: the Leaves to send the uncovered ones flying, field:
    /// the bodies (kicks), t/dt: time, p: (heap, blow, regrow, regrowDelay).
    #[allow(clippy::too_many_arguments)]
    pub fn update(&mut self, t: f64, dt: f64, on: bool, blow: f64, regrow: f64, regrow_delay: f64, places: &[Place], leaves: &mut Leaves, field: Option<&Field>, rng: &mut Rng) {
        let Some(l) = self.lay.as_mut() else { return };
        let dt = dt.min(0.05);
        let mx = |px: f64| px / l.kx;
        if !on {
            self.level.fill(0.0);
            for q in &mut l.leaves {
                if q.on {
                    q.on = false;
                    self.drawn.valid = false;
                }
            }
            return;
        }

        // how hard each sign gets blown: walking towards it, standing in front of it, stepping closer
        for sg in &mut l.signs {
            let cx = mx(sg.cx);
            let mut str = 0.0;
            let mut push = 0.0;
            for pl in places {
                let dx = cx - pl.x;
                let ad = dx.abs();
                if ad > 3.2 {
                    continue;
                }
                let sgn = if dx == 0.0 { 1.0 } else { dx.signum() };
                let close = 1.0 - ad / 3.2;
                let toward = pl.vx * sgn;
                let walk = (toward - 0.2).max(0.0) * close * 2.2;
                let stand = (1.0 - ad / 0.7).max(0.0) * 0.45 * if pl.dist < 3.0 { 1.0 } else { 0.4 };
                let closer = match self.approach.iter().find(|a| a.0 == pl.id) {
                    Some(a) => (a.2 - 0.25).max(0.0) * (1.0 - ad / 1.2).max(0.0) * 1.5,
                    None => 0.0,
                };
                str += walk + stand + closer;
                push += (walk + closer) * sgn + stand * 0.2 * sgn;
            }
            // feet and hands stirring in the heap
            if let Some(f) = field
                && f.w > 0
            {
                let half = sg.w * 0.6;
                let cell = f64::from(f.cell);
                let c0 = (mx(sg.cx - half) / cell).floor().max(0.0) as usize;
                let c1 = ((mx(sg.cx + half) / cell).floor()).min((f.w - 1) as f64);
                let i = js_round(sg.cx - l.x0);
                let h_here = if i >= 0.0 && i < l.n as f64 { f64::from(self.level[i as usize]) * f64::from(l.shape[i as usize]) } else { 0.0 };
                let h_top = h_here / l.ky + 0.05;
                let r0 = ((l.top - h_top) / cell).floor().max(0.0) as usize;
                let mut k = 0.0;
                if c1 >= 0.0 {
                    let c1 = c1 as usize;
                    let mut cy = r0;
                    while cy < f.h {
                        let mut cx2 = c0;
                        while cx2 <= c1 {
                            k += f64::from(f.kx.get(cy * f.w + cx2).copied().unwrap_or(0.0)).abs();
                            cx2 += 2;
                        }
                        cy += 2;
                    }
                }
                str += (k * 0.004).min(0.6);
            }
            sg.str = str * blow;
            if push.abs() > 0.05 {
                sg.dir = push.signum();
            }
            if sg.str > 0.05 {
                sg.last_blow = t;
            }
        }
        // stepping closer to the wall: the change of the distance, smoothed over about half a second
        self.seen.clear();
        for pl in places {
            self.seen.push(pl.id);
            match self.approach.iter_mut().find(|a| a.0 == pl.id) {
                None => self.approach.push((pl.id, pl.dist, 0.0)),
                Some(a) => {
                    let k = 1.0 - (-dt / 0.45).exp();
                    a.2 += ((a.1 - pl.dist) / dt.max(1e-3) - a.2) * k;
                    a.1 = pl.dist;
                }
            }
        }
        let seen = &self.seen;
        self.approach.retain(|a| seen.contains(&a.0));

        // the surface: blown down around a sign, grows back where nothing blew for a while
        self.before.clear();
        self.before.extend_from_slice(&self.level);
        for i in 0..l.n {
            let x = l.x0 + i as f64;
            let mut down = 0.0;
            for sg in &l.signs {
                if sg.str <= 0.05 {
                    continue;
                }
                let u = (x - sg.cx) / (sg.w * 0.55);
                let f = (-u * u).exp();
                down += sg.str * f;
                if f > 0.3 {
                    self.last_blow[i] = t as f32;
                }
            }
            if down > 0.0 {
                self.level[i] = (f64::from(self.level[i]) - down * 1.3 * dt).max(0.0) as f32;
            } else if t - f64::from(self.last_blow[i]) > regrow_delay {
                self.level[i] = (f64::from(self.level[i]) + dt / regrow.max(1.0)).min(1.0) as f32;
            }
        }

        // uncovered leaves fly off (the top ones first: they are the last in the list)
        let mut flying = 0;
        for k in (0..l.leaves.len()).rev() {
            let q = &mut l.leaves[k];
            let lim = f64::from(self.level[q.i]) * f64::from(l.shape[q.i]);
            if q.on && q.h > lim + 1.0 {
                q.on = false;
                self.drawn.valid = false;
                if f64::from(self.before[q.i]) * f64::from(l.shape[q.i]) >= q.h && flying < MAX_FLY {
                    flying += 1;
                    let px = l.x0 + q.i as f64;
                    // the nearest sign
                    let mut best = 0;
                    for (j, g) in l.signs.iter().enumerate() {
                        if (g.cx - px).abs() < (l.signs[best].cx - px).abs() {
                            best = j;
                        }
                    }
                    let (dir, sstr) = l.signs.get(best).map(|g| (g.dir, g.str)).unwrap_or((1.0, 0.0));
                    let py = l.bottom - q.h;
                    let kick = (0.8 + sstr).min(3.0);
                    let vx = dir * kick * (0.6 + rng.f64() * 0.9) + (rng.f64() - 0.5) * 0.5;
                    let vy = 0.5 + rng.f64() * 1.3 * kick.min(1.5);
                    leaves.spawn_free(mx(px), l.top - py / l.ky, vx, vy, q.c, q.size, false);
                }
            } else if !q.on && q.h <= lim - 1.0 {
                q.on = true;
                self.drawn.valid = false;
            }
        }
    }

    /// the share of the codes covered (0..1), for the status line
    pub fn cover(&self) -> f64 {
        let Some(l) = &self.lay else { return 0.0 };
        let mut sum = 0.0;
        for g in &l.signs {
            let i = js_round(g.cx - l.x0);
            if i >= 0.0 && (i as usize) < self.level.len() {
                sum += f64::from(self.level[i as usize]);
            }
        }
        sum / (l.signs.len().max(1) as f64)
    }

    /// Draws the heap into buf: the packed leaves below the surface, the loose ones up to it. It is
    /// painted again only when a column's surface or a loose leaf changed, else copied.
    pub fn draw(&mut self, buf: &mut [u32], w: usize, h: usize) {
        let Some(l) = &self.lay else { return };
        let inset = js_round(5.0 * l.s);
        let (n, fh) = (l.n, l.fill_h as i64);
        // rows top ..= y1 per column: down to a little below the base (the nearer hills cover the
        // rest); the fill row of image row y is fh - (bottom - y), at most fh - 1
        let y1 = ((h as f64).min(l.bottom + 10.0 * l.s).ceil() as i64 - 1).min(h as i64 - 1);
        let bottom = l.bottom as i64;
        self.tops.clear();
        for i in 0..n {
            let hh = f64::from(self.level[i]) * f64::from(l.shape[i]) - inset;
            let x = (l.x0 + i as f64) as usize;
            self.tops.push(if hh <= 0.0 || x >= w { -1 } else { (js_round(l.bottom - hh).max(0.0) as i64).max(bottom - fh) });
        }
        let d = &mut self.drawn;
        if !d.valid || d.w != w || d.h != h || d.tops != self.tops {
            if d.w != w || d.h != h || d.px.len() != w * h {
                d.px = vec![0; w * h];
                (d.w, d.h, d.rows) = (w, h, (0, 0));
            } else if let Some(used) = d.px.get_mut(d.rows.0 * w..d.rows.1 * w) {
                used.fill(0);
            }
            let (mut r0, mut r1) = (h as i64, 0i64);
            for (i, &top) in self.tops.iter().enumerate() {
                if top < 0 {
                    continue;
                }
                let x = (l.x0 + i as f64) as usize;
                for y in top..=y1 {
                    let fy = (fh - 1).min(fh - (bottom - y));
                    if let (Some(p), Some(c)) = (d.px.get_mut(y as usize * w + x), l.fill.get(fy as usize * n + i)) {
                        *p = *c;
                    }
                }
                (r0, r1) = (r0.min(top), r1.max(y1 + 1));
            }
            for q in &l.leaves {
                if q.on {
                    let (cx, cy) = (l.x0 + q.i as f64, l.bottom - q.h);
                    blit(&mut d.px, w, h, cx, cy, &q.spr);
                    let sy = cy.floor() as i64 + i64::from(q.spr.oy);
                    (r0, r1) = (r0.min(sy), r1.max(sy + q.spr.h as i64));
                }
            }
            let (r0, r1) = (r0.clamp(0, h as i64) as usize, r1.clamp(0, h as i64) as usize);
            d.rows = (r0.min(r1), r1);
            std::mem::swap(&mut d.tops, &mut self.tops);
            d.valid = true;
        }
        let (Some(dst), Some(src)) = (buf.get_mut(d.rows.0 * w..d.rows.1 * w), d.px.get(d.rows.0 * w..d.rows.1 * w)) else { return };
        for (o, &c) in dst.iter_mut().zip(src) {
            if c != 0 {
                *o = c;
            }
        }
    }
}
