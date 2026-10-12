//! The city in the middle of the map, seen from above (city.js): a futuristic city at night with a
//! few landmarks one recognizes at once. Drawn once per layout into a picture at LED resolution, in
//! half blocks (S/2 x S/2 LEDs: blocky, but fine enough for shapes); what moves is drawn live in
//! draw.rs:
//!   - the energy core at the top (where the Kinect stands): neon rings around a glowing core (live:
//!     turning ring segments, a pulse), conduits that run down the middle of the avenue (live: light
//!     pulses travelling down) and power the energy wall;
//!   - maglev streets: dark and glossy, neon lane edges, light nodes; hover gliders with light trails;
//!   - landmarks between them: hex towers with a neon edge and a lit spire, a landing pad (a light ring,
//!     chevrons pointing in, beacons), an arena (a neon rim, a glowing field), a biodome (a garden under
//!     a glass dome with a reflection), office towers with light strips;
//!   - every building casts its shadow to the bottom right (the light of the whole map comes from the
//!     top left).
//!
//! For the game the city is a grid of art pixels (alive or destroyed); the picture shows each living
//! one, a destroyed one shows rubble.

use std::f64::consts::PI;

use wall::common::rand::Rng;

use super::pixels::{Rgb, jr};

pub const WALL: u8 = 1;
pub const TOWER: u8 = 2;
pub const GROUND: u8 = 3;

const NEON: [Rgb; 3] = [[0.2, 0.9, 1.0], [1.0, 0.28, 0.8], [0.62, 0.42, 1.0]];
const GROUND_C: Rgb = [0.018, 0.02, 0.042];
const PLATING: Rgb = [0.03, 0.033, 0.065];
const ROAD: Rgb = [0.03, 0.034, 0.06];
const LANE: Rgb = [0.18, 0.75, 0.9];
const NODE: Rgb = [0.75, 0.95, 1.0];
const SHADOW: Rgb = [0.004, 0.004, 0.012];
const METAL: [Rgb; 3] = [[0.11, 0.13, 0.22], [0.14, 0.11, 0.22], [0.1, 0.15, 0.2]];
const PANEL: Rgb = [0.35, 0.65, 0.85];
const GARDEN: Rgb = [0.02, 0.2, 0.13];
const PLANT: Rgb = [0.05, 0.42, 0.3];
const PLANT_LIT: Rgb = [0.2, 0.7, 0.5];
const GLASS: Rgb = [0.55, 0.85, 1.0];
const FIELD: Rgb = [0.03, 0.2, 0.28];
const FIELD_LINE: Rgb = [0.4, 0.95, 1.0];
const CORE: Rgb = [0.75, 0.95, 1.0];

/// a glider lane (LED px)
pub struct Lane {
    pub vertical: bool,
    pub at: f64,
    pub dir: f64,
    pub from: f64,
    pub to: f64,
}

/// a light for the floor: art px, color, radius m, intensity, blink
pub struct CityLight {
    pub x: f64,
    pub y: f64,
    pub col: Rgb,
    pub r: f64,
    pub i: f64,
    pub blink: bool,
}

pub struct Built {
    /// type per art px
    pub base: Vec<u8>,
    /// rgb per LED, w*S x h*S
    pub img: Vec<f32>,
    pub img_w: usize,
    pub lanes: Vec<Lane>,
    pub lights: Vec<CityLight>,
    /// art px: x, y, r
    pub core: [f64; 3],
    /// art px: x, y0, y1
    pub conduit: [f64; 3],
}

fn sc(c: Rgb, k: f64) -> Rgb {
    [c[0] * k, c[1] * k, c[2] * k]
}

fn pick<T: Copy>(rng: &mut Rng, a: &[T]) -> T {
    a[((rng.f64() * a.len() as f64).floor() as usize).min(a.len() - 1)]
}

fn rand(rng: &mut Rng, a: f64, b: f64) -> f64 {
    a + rng.f64() * (b - a)
}

/// drawing in half blocks
struct Paper {
    img: Vec<f32>,
    q: usize,
    w_led: usize,
    gw: i64,
    gh: i64,
    s: f64,
    lights: Vec<CityLight>,
}

impl Paper {
    fn cell(&mut self, x: f64, y: f64, c: Rgb) {
        let (x, y) = (jr(x), jr(y));
        if !(x >= 0.0 && y >= 0.0 && x < self.gw as f64 && y < self.gh as f64) {
            return;
        }
        let (x, y) = (x as usize, y as usize);
        for j in 0..self.q {
            for i in 0..self.q {
                let k = ((y * self.q + j) * self.w_led + x * self.q + i) * 3;
                if let Some(p) = self.img.get_mut(k..k + 3) {
                    p[0] = c[0] as f32;
                    p[1] = c[1] as f32;
                    p[2] = c[2] as f32;
                }
            }
        }
    }

    fn rect(&mut self, x: f64, y: f64, rw: f64, rh: f64, c: Rgb) {
        let mut j = 0.0;
        while j < rh {
            let mut i = 0.0;
            while i < rw {
                self.cell(x + i, y + j, c);
                i += 1.0;
            }
            j += 1.0;
        }
    }

    fn ellipse(&mut self, cx: f64, cy: f64, rx: f64, ry: f64, c: Rgb, ring: f64) {
        let mut y = (cy - ry).floor();
        while y <= cy + ry {
            let mut x = (cx - rx).floor();
            while x <= cx + rx {
                let d = ((x + 0.5 - cx) / rx).powi(2) + ((y + 0.5 - cy) / ry).powi(2);
                let skip = d > 1.0 || (ring != 0.0 && d < (1.0 - ring / rx.min(ry)).powi(2));
                if !skip {
                    self.cell(x, y, c);
                }
                x += 1.0;
            }
            y += 1.0;
        }
    }

    /// a pointy-top hexagon, filled (or only its outline, `ring` half blocks wide)
    fn hexagon(&mut self, cx: f64, cy: f64, r: f64, c: Rgb, ring: f64) {
        let inside = |x: f64, y: f64, rr: f64| {
            let u = x.abs() / (rr * 0.866);
            let v = y.abs() / rr;
            u <= 1.0 && v <= 1.0 - u * 0.5
        };
        let mut y = (cy - r).floor();
        while y <= cy + r {
            let mut x = (cx - r).floor();
            while x <= cx + r {
                let dx = x + 0.5 - cx;
                let dy = y + 0.5 - cy;
                if inside(dx, dy, r) && !(ring != 0.0 && inside(dx, dy, r - ring)) {
                    self.cell(x, y, c);
                }
                x += 1.0;
            }
            y += 1.0;
        }
    }

    fn to_art(&self, x: f64, y: f64) -> [f64; 2] {
        let q = self.q as f64;
        [(x * q) / self.s, (y * q) / self.s]
    }

    fn light(&mut self, x: f64, y: f64, col: Rgb, r: f64, i: f64, blink: bool) {
        let [ax, ay] = self.to_art(x, y);
        self.lights.push(CityLight { x: ax, y: ay, col, r, i, blink });
    }
}

/// w x h art px, S LEDs per art px.
pub fn build_city(w: usize, h: usize, s: usize, rng: &mut Rng) -> Built {
    let s = s.max(1);
    let q = (s / 2).max(1); // LEDs per half block
    let w_led = w * s;
    let h_led = h * s;
    let gw = (w_led / q) as i64; // the picture in half blocks
    let gh = (h_led / q) as i64;
    let mut base = vec![GROUND; w * h];
    let mut lanes = Vec::new();
    let mut p = Paper { img: vec![0.0; w_led * h_led * 3], q, w_led, gw, gh, s: s as f64, lights: Vec::new() };
    let (gwf, ghf, qf, sf) = (gw as f64, gh as f64, q as f64, s as f64);

    // ---- the ground: dark plating in big tiles (no fine pattern)
    p.rect(0.0, 0.0, gwf, ghf, GROUND_C);
    let mut y = 0;
    while y < gh {
        let mut x = if (y / 12) % 2 == 1 { 0 } else { 6 };
        while x < gw {
            p.rect(x as f64, y as f64, 6.0, 6.0, PLATING);
            x += 12;
        }
        y += 12;
    }
    let inner0 = (sf / qf).ceil();
    let inner1 = gwf - (sf / qf).ceil();
    let cx = (gwf / 2.0).floor();
    let road_w = 6.0_f64.max(jr(gwf * 0.16));
    let r0 = cx - (road_w / 2.0).floor();
    let r1 = r0 + road_w;
    let top = jr((ghf * 0.17).min(gwf * 0.62));

    // ---- the energy core: rings around a glowing center, on a dark platform
    let dr = ((inner1 - inner0) / 2.0 - 2.0).min(top / 2.0 - 1.0);
    let dcy = top / 2.0;
    p.ellipse(cx + 1.5, dcy + 1.5, dr, dr, SHADOW, 0.0);
    p.ellipse(cx, dcy, dr, dr, sc(METAL[0], 0.9), 0.0);
    p.ellipse(cx, dcy, dr, dr, NEON[0], 1.0);
    p.ellipse(cx, dcy, dr * 0.7, dr * 0.7, sc(NEON[2], 0.7), 1.0);
    for k in 0..8 {
        let a = (f64::from(k) / 8.0) * PI * 2.0;
        let mut r = dr * 0.35;
        while r < dr * 0.7 {
            p.cell(cx + a.cos() * r, dcy + a.sin() * r, sc(NEON[0], 0.45));
            r += 0.7;
        }
    }
    p.ellipse(cx, dcy, dr * 0.3, dr * 0.3, CORE, 0.0);
    p.light(cx, dcy, NEON[0], 0.8, 0.7, false);

    // ---- maglev streets: the avenue, cross streets, neon lane edges, light nodes
    p.rect(r0, top, road_w, ghf - top, ROAD);
    p.rect(r0, top, 1.0, ghf - top, LANE);
    p.rect(r1 - 1.0, top, 1.0, ghf - top, LANE);
    p.rect(cx - 0.5, top, 1.0, ghf - top, sc(NEON[0], 0.35)); // the conduit (pulses live)
    let cross_h = 4.0_f64.max(jr(road_w * 0.6));
    let mut streets: Vec<f64> = Vec::new();
    let n_blocks = 2.0_f64.max(jr((ghf - top) / 30.0_f64.max(gwf * 0.9)));
    let block_h = (ghf - top - cross_h * (n_blocks - 1.0)) / n_blocks;
    let mut k = 1.0;
    while k < n_blocks {
        let y = jr(top + k * block_h + (k - 1.0) * cross_h);
        streets.push(y);
        p.rect(inner0, y, inner1 - inner0, cross_h, ROAD);
        p.rect(inner0, y, inner1 - inner0, 1.0, sc(LANE, 0.8));
        p.rect(inner0, y + cross_h - 1.0, inner1 - inner0, 1.0, sc(LANE, 0.8));
        k += 1.0;
    }
    let mut y = top + 6.0;
    while y < ghf {
        p.cell(r0 - 1.0, y, NODE);
        p.cell(r1, y + 7.0, NODE);
        y += 14.0;
    }
    let mut y = top + 6.0;
    while y < ghf {
        p.light(r0 - 1.0, y, NEON[0], 0.3, 0.45, false);
        y += 42.0;
    }
    lanes.push(Lane { vertical: true, at: (cx - road_w / 4.0) * qf, dir: -1.0, from: top * qf, to: h_led as f64 });
    lanes.push(Lane { vertical: true, at: (cx + road_w / 4.0) * qf, dir: 1.0, from: top * qf, to: h_led as f64 });
    for (i, &y) in streets.iter().enumerate() {
        lanes.push(Lane { vertical: false, at: (y + cross_h / 2.0) * qf, dir: if i % 2 == 1 { 1.0 } else { -1.0 }, from: inner0 * qf, to: inner1 * qf });
    }

    // ---- the landmarks
    let kinds = ["pad", "offices", "biodome", "arena", "hexTower", "offices", "biodome", "hexTower"];
    let mut n = 0;
    let mut rows = vec![top];
    rows.extend(streets.iter().map(|y| y + cross_h));
    for r in 0..rows.len() {
        let y0 = rows[r] + 2.0;
        let y1 = (if r + 1 < rows.len() { streets[r] } else { ghf }) - 2.0;
        for (x0, x1) in [(inner0 + 2.0, r0 - 2.0), (r1 + 2.0, inner1 - 2.0)] {
            let bw = x1 - x0;
            let bh = y1 - y0;
            if bw < 4.0 || bh < 4.0 {
                continue;
            }
            let kind = kinds[n % kinds.len()];
            n += 1;
            let sq = (bw - 3.0).min(bh - 3.0);
            match kind {
                "pad" => pad(&mut p, x0 + 1.0, y0 + 1.0, sq, sq),
                "arena" => arena(&mut p, rng, x0, y0, bw, bh.min(bw * 1.5)),
                "biodome" => biodome(&mut p, rng, x0, y0, bw, bh.min(bw)),
                "hexTower" => hex_tower(&mut p, rng, x0, y0, bw, bh.min(bw)),
                _ => offices(&mut p, rng, x0, y0, bw, bh),
            }
        }
    }

    // ---- the energy wall with its towers (drawn live, see draw.rs; only marked here)
    if w > 0 {
        for y in 0..h {
            base[y * w] = WALL;
            base[y * w + w - 1] = WALL;
        }
        let mut y = 4;
        while y + 3 < h {
            for j in 0..3 {
                if y + j < h {
                    base[(y + j) * w] = TOWER;
                    base[(y + j) * w + w - 1] = TOWER;
                }
            }
            y += 13;
        }
    }
    let [corex, corey] = p.to_art(cx, dcy);
    let [condx, cond0] = p.to_art(cx, top);
    Built { base, img: p.img, img_w: w_led, lanes, lights: p.lights, core: [corex, corey, (dr * qf) / sf], conduit: [condx, cond0, h as f64] }
}

/// a tower with a hexagonal roof, a neon edge, a lit spire
fn hex_tower(p: &mut Paper, rng: &mut Rng, x: f64, y: f64, bw: f64, bh: f64) {
    let r = bw.min(bh) / 2.0 - 1.0;
    let tcx = x + bw / 2.0;
    let tcy = y + bh / 2.0;
    let neon = pick(rng, &NEON);
    p.hexagon(tcx + 2.0, tcy + 2.0, r, SHADOW, 0.0);
    let m = pick(rng, &METAL);
    p.hexagon(tcx, tcy, r, m, 0.0);
    p.hexagon(tcx, tcy, r, neon, 1.0);
    let m2 = pick(rng, &METAL);
    p.hexagon(tcx, tcy, r * 0.55, sc(m2, 1.4), 0.0);
    p.hexagon(tcx, tcy, r * 0.55, sc(neon, 0.6), 1.0);
    p.ellipse(tcx, tcy, 1.2, 1.2, CORE, 0.0);
    p.light(tcx, tcy, neon, 0.35, 0.6, true);
}

/// a landing pad: a light ring, chevrons pointing in, beacons at the corners
fn pad(p: &mut Paper, x: f64, y: f64, bw: f64, bh: f64) {
    p.rect(x + 3.0, y + 3.0, bw, bh, SHADOW);
    p.rect(x, y, bw, bh, sc(METAL[0], 1.2));
    p.rect(x, y, bw, 1.0, sc(METAL[0], 2.0));
    p.rect(x, y, 1.0, bh, sc(METAL[0], 1.7));
    let r = bw.min(bh) / 2.0 - 1.5;
    let pcx = x + bw / 2.0;
    let pcy = y + bh / 2.0;
    p.ellipse(pcx, pcy, r, r, NEON[0], 1.0);
    p.ellipse(pcx, pcy, r * 0.35, r * 0.35, sc(NEON[0], 0.6), 1.0);
    // chevrons from four sides
    for (dx, dy) in [(0.0, -1.0), (0.0, 1.0), (-1.0, 0.0), (1.0, 0.0)] {
        for k in -1..=1 {
            let k = f64::from(k);
            let along = r * 0.62 - k.abs();
            p.cell(pcx + dx * along + dy * k, pcy + dy * along + dx * k, NEON[1]);
        }
    }
    for (lx, ly) in [(x, y), (x + bw - 1.0, y), (x, y + bh - 1.0), (x + bw - 1.0, y + bh - 1.0)] {
        p.cell(lx, ly, NEON[1]);
        p.light(lx, ly, NEON[1], 0.25, 0.8, true);
    }
}

/// an arena: a neon rim, a glowing field with its middle line and circle, pylons
fn arena(p: &mut Paper, rng: &mut Rng, x: f64, y: f64, bw: f64, bh: f64) {
    let scx = x + bw / 2.0;
    let scy = y + bh / 2.0;
    p.ellipse(scx + 2.0, scy + 2.0, bw / 2.0, bh / 2.0, SHADOW, 0.0);
    let m = pick(rng, &METAL);
    p.ellipse(scx, scy, bw / 2.0, bh / 2.0, m, 0.0);
    p.ellipse(scx, scy, bw / 2.0, bh / 2.0, NEON[1], 1.0);
    let fw = bw / 2.0 - 3.0;
    let fh = bh / 2.0 - 3.0;
    p.ellipse(scx, scy, fw, fh, FIELD, 0.0);
    p.ellipse(scx, scy, fw, fh, sc(FIELD_LINE, 0.6), 1.0);
    p.rect(scx - fw * 0.8, scy - 0.5, fw * 1.6, 1.0, FIELD_LINE);
    let cr = 1.5_f64.max(fh * 0.35);
    p.ellipse(scx, scy, cr, cr, FIELD_LINE, 1.0);
    for (lx, ly) in [(x + 1.0, y + 1.0), (x + bw - 2.0, y + 1.0), (x + 1.0, y + bh - 2.0), (x + bw - 2.0, y + bh - 2.0)] {
        p.cell(lx, ly, NODE);
        p.light(lx, ly, [0.7, 0.9, 1.0], 0.4, 0.55, false);
    }
    p.light(scx, scy, FIELD_LINE, 0.6, 0.35, false);
}

/// a biodome: a garden under a glass dome, its reflection at the top left
fn biodome(p: &mut Paper, rng: &mut Rng, x: f64, y: f64, bw: f64, bh: f64) {
    let r = bw.min(bh) / 2.0 - 0.5;
    let dcx = x + bw / 2.0;
    let dcy2 = y + bh / 2.0;
    p.ellipse(dcx + 2.0, dcy2 + 2.0, r, r, SHADOW, 0.0);
    p.ellipse(dcx, dcy2, r, r, GARDEN, 0.0);
    let trees = jr(r * r * 0.25);
    let mut k = 0.0;
    while k < trees {
        let a = rng.f64() * PI * 2.0;
        let d = rng.f64().sqrt() * (r - 2.5);
        let tx = dcx + a.cos() * d;
        let ty = dcy2 + a.sin() * d;
        let tr = rand(rng, 1.2, 2.2);
        p.ellipse(tx, ty, tr, tr, PLANT, 0.0);
        p.ellipse(tx - tr * 0.35, ty - tr * 0.35, tr * 0.45, tr * 0.45, PLANT_LIT, 0.0);
        k += 1.0;
    }
    p.ellipse(dcx, dcy2, r * 0.3, r * 0.2, sc(NEON[0], 0.5), 0.0); // a pool
    p.ellipse(dcx, dcy2, r, r, sc(GLASS, 0.8), 1.0);
    // the reflection: an arc at the top left
    let mut a = PI * 1.05;
    while a < PI * 1.45 {
        p.cell(dcx + a.cos() * (r - 1.5), dcy2 + a.sin() * (r - 1.5), GLASS);
        a += 0.08;
    }
    p.light(dcx, dcy2, PLANT_LIT, 0.5, 0.3, false);
}

/// office towers: dark metal, a neon strip along one edge, light panels on the roof
fn offices(p: &mut Paper, rng: &mut Rng, x: f64, y: f64, bw: f64, bh: f64) {
    let n = if bh > bw * 1.2 { 2.0 } else { 1.0 };
    let gap = 2.0;
    let each = (bh - gap * (n - 1.0)) / n;
    let mut k = 0.0;
    while k < n {
        let by = y + k * (each + gap) + 1.0;
        let tw = 3.0_f64.max(bw - 4.0);
        let th = 3.0_f64.max(each.floor() - 3.0);
        let tx = x + 1.0;
        let hgt = if rng.f64() < 0.5 { 2.0 } else { 3.0 };
        let metal = pick(rng, &METAL);
        let neon = pick(rng, &NEON);
        p.rect(tx + hgt, by + hgt, tw, th, SHADOW);
        p.rect(tx, by, tw, th, metal);
        p.rect(tx, by, tw, 1.0, sc(metal, 1.8));
        p.rect(tx, by, 1.0, th, sc(metal, 1.5));
        p.rect(tx + tw - 1.0, by, 1.0, th, neon);
        if tw > 5.0 && th > 4.0 {
            p.rect(tx + 2.0, by + 2.0, 3.0_f64.min(tw - 4.0), 1.0, PANEL);
            p.rect(tx + 2.0, by + th - 3.0, 3.0_f64.min(tw - 4.0), 1.0, sc(PANEL, 0.7));
        }
        k += 1.0;
    }
}
