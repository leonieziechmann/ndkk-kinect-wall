//! The backdrop as pixel art (painting.js): a spring night at the Ludwig-Leichhardt-Gymnasium,
//! drawn pixel by pixel at the art resolution (one art pixel = 2 x 2 LEDs by default).
//!
//! A dithered twilight sky (navy at the top, violet, a pink glow at the horizon), a crescent moon,
//! flat clouds lit from below, the Plattenbau skyline of Cottbus with a few lit windows, the school
//! (grey panel blocks, the orange tower, "ライヒハルト高校" in orange on the facade as on the real
//! building, ribbon windows, the glass front with colored panels), a vending machine, the paved
//! yard with the granite benches and fallen petals, the cherry trunks and the lantern string.
//! Everything that moves or lights up (stars, windows, crowns, lanterns, petals, the cat's eyes) is
//! drawn on the GPU from the lists returned here.

use std::f64::consts::PI;

use super::pixel::{Pix, Rng32, bayer, c::*, jr, text_mask};

const SKY: [u32; 13] = [SKY0, SKY1, SKY2, SKY3, SKY4, SKY5, SKY6, SKY7, SKY8, SKY9, SKY10, SKY11, SKY12];
const JP_FONT: &str = "\"Yu Gothic UI\", \"Yu Gothic\", Meiryo, \"MS Gothic\", sans-serif";
/// the range of the random phases (painting.js: 6.283, a little less than TAU)
#[allow(clippy::approx_constant)]
const PHASES: f64 = 6.283;

#[derive(Clone, Debug)]
pub struct Star {
    pub x: f64,
    pub y: f64,
    pub big: bool,
    pub phase: f64,
    pub speed: f64,
    pub b: f64,
}

/// A window: kind 0 a lit window, 1 glass front, 2 colored glass, 3 the door.
#[derive(Clone, Debug)]
pub struct Win {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub kind: u8,
    pub color: Option<u32>,
}

/// A blossom blob of a crown (tone 0..3) or a single blossom pixel (tone 4..6).
#[derive(Clone, Debug)]
pub struct Blob {
    pub x: f64,
    pub y: f64,
    pub r: f64,
    pub tone: usize,
    pub phase: f64,
    /// height in the crown (0 at the trunk's foot): how far it sways
    pub h: f64,
}

#[derive(Clone, Debug)]
pub struct Tree {
    pub cx: f64,
    pub cy: f64,
    pub rx: f64,
    pub ry: f64,
    pub blobs: Vec<Blob>,
    pub dots: Vec<Blob>,
}

#[derive(Clone, Debug)]
pub struct Lantern {
    pub x: f64,
    pub y: f64,
    pub len: f64,
    pub phase: f64,
}

#[derive(Clone, Debug)]
pub struct Light {
    pub x: f64,
    pub y: f64,
    pub phase: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Vend {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Cat {
    pub eyes: [f64; 4],
}

/// What the GPU draws on top of the painting.
#[derive(Clone, Debug)]
pub struct Scenery {
    pub stars: Vec<Star>,
    pub windows: Vec<Win>,
    pub trees: Vec<Tree>,
    pub lanterns: Vec<Lantern>,
    pub lights: Vec<Light>,
    pub vend: Vend,
    pub cat: Cat,
    pub horizon: f64,
    pub scale: f64,
}

pub struct Painting {
    pub pix: Pix,
    pub scenery: Scenery,
}

/// A flat cloud from a few ellipses: violet body, lit pink along its underside.
fn cloud(pix: &mut Pix, r: &mut Rng32, cx: f64, cy: f64, w: f64, h: f64) {
    let n = jr(w / (h * 2.2)).max(2.0) as usize;
    let mut parts: Vec<[f64; 4]> = Vec::with_capacity(n);
    for i in 0..n {
        let t = if n == 1 { 0.5 } else { i as f64 / (n - 1) as f64 };
        let bump = (t * PI).sin();
        let py = cy - bump * h * 0.35 - r.next() * h * 0.2;
        let rx = (w / n as f64) * (0.7 + r.next() * 0.3);
        parts.push([cx + (t - 0.5) * w * 0.8, py, rx, h * (0.4 + bump * 0.45)]);
    }
    let inside = |x: i64, y: i64| parts.iter().any(|&[px, py, rx, ry]| ((x as f64 + 0.5 - px) / rx).powi(2) + ((y as f64 + 0.5 - py) / ry).powi(2) <= 1.0);
    pix.shade(cx - w, cy - h * 1.5, cx + w, cy + h * 1.2, |x, y| {
        if !inside(x, y) {
            return None;
        }
        if !inside(x, y + 1) {
            return Some(SKY11);
        }
        if !inside(x, y + 2) {
            return Some(SKY9);
        }
        if !inside(x, y - 1) {
            return Some(SKY7);
        }
        Some(if (x + y).rem_euclid(2) != 0 && !inside(x, y + 3) { SKY7 } else { SKY6 })
    });
}

/// x % k === 0 of JS for whole numbers (x % 0 is NaN there: never 0)
fn on_step(x: i64, k: i64) -> bool {
    k != 0 && x % k == 0
}

/// Paints the backdrop at the art resolution aw x ah; `right`: the QR card is on the right.
pub fn paint_scene(aw: usize, ah: usize, right: bool) -> Painting {
    let mut r = Rng32::new(20_261_010);
    let mut pix = Pix::new(aw, ah);
    let (awf, ahf) = (aw as f64, ah as f64);
    let s = ahf / 168.0; // 1 at 504 x 168
    let x_at = |f: f64| jr((if right { f } else { 1.0 - f }) * awf);
    let span = |f0: f64, f1: f64| {
        let (a, b) = (x_at(f0), x_at(f1));
        (a.min(b), a.max(b))
    };
    // loop steps of at least one pixel (a wall a few pixels high would otherwise never end)
    let step = |v: f64| jr(v).max(1.0);
    let hz = jr(ahf * 0.7); // the horizon: the yard starts here

    // ---- sky: a dithered ramp through the night colors
    pix.shade(0.0, 0.0, awf, hz + 1.0, |x, y| {
        let t = y as f64 / hz;
        let k = (SKY.len() - 1) as f64 * t.powf(1.75);
        let i = (k.floor() as usize).min(SKY.len() - 2);
        Some(if k - i as f64 > bayer(x, y) { SKY[i + 1] } else { SKY[i] })
    });

    // moon: a crescent with a soft dithered halo
    let moon = [x_at(0.705), jr(ahf * 0.13)];
    let mr = 7.0 * s;
    pix.shade(moon[0] - mr * 2.2, moon[1] - mr * 2.2, moon[0] + mr * 2.2, moon[1] + mr * 2.2, |x, y| {
        let (xf, yf) = (x as f64, y as f64);
        let d = (xf + 0.5 - moon[0]).hypot(yf + 0.5 - moon[1]);
        let cut = (xf + 0.5 - moon[0] - mr * 0.45).hypot(yf + 0.5 - moon[1] + mr * 0.3);
        if d <= mr && cut > mr * 0.85 {
            return Some(if cut < mr * 0.98 { Y1 } else { Y2 });
        }
        if d <= mr + 3.0 * s && (x + y).rem_euclid(2) == 0 {
            return Some(SKY3);
        }
        None
    });

    // stars: the upper sky (twinkling on the GPU)
    let mut stars = Vec::new();
    let mut i = 0;
    while i < 200 && stars.len() < 70 {
        i += 1;
        let x = (r.next() * awf).floor();
        let y = (r.next().powf(1.5) * ahf * 0.48).floor();
        if (x - moon[0]).hypot(y - moon[1]) < 16.0 * s {
            continue;
        }
        let big = r.next() < 0.12;
        let phase = r.next() * PHASES;
        let speed = 0.5 + r.next() * 2.5;
        let b = 0.4 + r.next() * 0.6;
        stars.push(Star { x, y, big, phase, speed, b });
    }

    // clouds: long flat streaks in the lower sky
    for (f, y, w, h) in [(0.13, 0.47, 70.0, 7.0), (0.5, 0.33, 54.0, 5.0), (0.6, 0.53, 80.0, 7.0), (0.92, 0.4, 56.0, 6.0), (0.31, 0.25, 40.0, 4.0)] {
        cloud(&mut pix, &mut r, x_at(f), jr(ahf * y), w * s, h * s);
    }

    // ---- the skyline of Cottbus: Plattenbau blocks, their windows a regular grid, a few lit
    let mut bx = -4.0;
    while bx < awf + 4.0 {
        let w = jr((14.0 + r.next() * 30.0) * s);
        let h = jr((5.0 + r.next() * r.next() * 17.0) * s);
        let col = if r.next() < 0.5 { SKY2 } else { SKY3 };
        pix.rect(bx, hz - h, w, h + 1.0, col);
        pix.rect(bx, hz - h, w, 1.0, SKY4);
        let mut wy = hz - h + 2.0;
        while wy < hz - 1.0 {
            let mut wx = bx + 1.0;
            while wx < bx + w - 1.0 {
                let v = r.next();
                if v < 0.07 {
                    pix.set(wx, wy, if v < 0.025 { Y1 } else { O5 });
                } else if v < 0.3 {
                    pix.set(wx, wy, SKY1);
                }
                wx += 2.0;
            }
            wy += 2.0;
        }
        bx += w + if r.next() < 0.3 { jr(r.next() * 8.0 * s) } else { 0.0 };
    }
    // hedges along the horizon
    pix.shade(0.0, hz - 6.0 * s, awf, hz + 1.0, |x, y| {
        let xf = x as f64;
        let top = hz - 2.0 * s - 2.5 * s * (1.0 + (xf * 0.55).sin() * 0.6 + (xf * 0.17 + 1.0).sin() * 0.4);
        if (y as f64) < top {
            return None;
        }
        Some(if (y as f64) < top + 1.0 { SKY3 } else { SKY1 })
    });

    // ---- the school
    let mut windows = Vec::new();
    let mut lights = Vec::new(); // blinking red lights (antenna)
    let base = hz + jr(3.0 * s);
    // the left wing: lower, behind the text column
    {
        let (x0, x1) = span(0.2, 0.43);
        let top = jr(ahf * 0.5);
        pix.rect(x0, top, x1 - x0, base - top, G2);
        pix.rect(x0, top, x1 - x0, 1.0, G5);
        pix.rect(x0, top + 1.0, x1 - x0, 1.0, G1);
        for row in 0..2 {
            let wy = top + jr((5.0 + f64::from(row) * 11.0) * s);
            let mut wx = x0 + 3.0;
            while wx + 5.0 < x1 - 2.0 {
                pix.rect(wx - 1.0, wy - 1.0, 6.0, 8.0, G1);
                pix.rect(wx, wy, 4.0, 6.0, G0);
                pix.set(wx + 3.0, wy, G3);
                windows.push(Win { x: wx, y: wy, w: 4.0, h: 6.0, kind: 0, color: None });
                wx += step(8.0 * s);
            }
        }
    }
    // the main block: concrete panels, roof units, the orange letters, two ribbons of windows,
    // the glass front
    let (mx0, mx1) = span(0.445, 0.765);
    let m_top = jr(ahf * 0.31);
    {
        let (px_step, py_step) = (jr(12.0 * s) as i64, jr(9.0 * s) as i64);
        pix.shade(mx0, m_top, mx1, base, |x, y| {
            let panel_x = on_step(x - mx0 as i64, px_step);
            let panel_y = on_step(y - m_top as i64, py_step);
            if panel_x || panel_y {
                return Some(G2);
            }
            Some(if (y as f64) - m_top < 3.0 { G4 } else { G3 })
        });
        pix.rect(mx0, m_top, mx1 - mx0, 1.0, G6);
        // the side face in shadow (the far end, away from the tower)
        let side = jr(4.0 * s);
        pix.rect(if right { mx1 } else { mx0 - side }, m_top + 1.0, side, base - m_top - 1.0, G1);
        // roof: units, a railing, an antenna with a red light
        for (f, w, h) in [(0.2, 10.0, 4.0), (0.27, 6.0, 3.0), (0.7, 12.0, 5.0)] {
            let ux = jr(mx0 + (mx1 - mx0) * f);
            pix.rect(ux, m_top - h, w, h, G1);
            pix.rect(ux, m_top - h, w, 1.0, G4);
        }
        let mut x = mx0 + 1.0;
        while x < mx1 {
            pix.set(x, m_top - 2.0, G1);
            x += 3.0;
        }
        pix.rect(mx0, m_top - 1.0, mx1 - mx0, 1.0, G1);
        let ax = jr(mx0 + (mx1 - mx0) * 0.86);
        pix.rect(ax, m_top - jr(14.0 * s), 1.0, jr(14.0 * s), G1);
        pix.rect(ax - 2.0, m_top - jr(10.0 * s), 5.0, 1.0, G1);
        lights.push(Light { x: ax, y: m_top - jr(15.0 * s), phase: 0.0 });

        // ライヒハルト高校: orange, shadow below, the upper edge lit
        let letters = text_mask("ライヒハルト高校", JP_FONT, jr(15.0 * s), 800, 0.45, 4, 1.0);
        let lx = jr((mx0 + mx1 - letters.w as f64) / 2.0);
        let ly = m_top + jr(4.0 * s);
        pix.stamp(&letters, lx as i64 + 1, ly as i64 + 1, O0);
        pix.stamp(&letters, lx as i64, ly as i64, O4);
        for j in 0..letters.h {
            for i in 0..letters.w {
                if letters.d[j * letters.w + i] != 0 && (j == 0 || letters.d[(j - 1) * letters.w + i] == 0) {
                    pix.seti(lx as i64 + i as i64, ly as i64 + j as i64, O6);
                }
            }
        }

        let w_top = ly + letters.h as f64 + jr(3.0 * s);
        for row in 0..2 {
            let wy = w_top + jr(f64::from(row) * 10.0 * s);
            let mut wx = mx0 + 4.0;
            while wx + 5.0 < mx1 - 3.0 {
                pix.rect(wx - 1.0, wy - 1.0, 6.0, 8.0, G1);
                pix.rect(wx, wy, 4.0, 6.0, G0);
                pix.set(wx + 3.0, wy, G2);
                pix.set(wx - 1.0, wy + 7.0, G5); // sill
                pix.set(wx + 4.0, wy + 7.0, G5);
                pix.rect(wx, wy + 7.0, 4.0, 1.0, G4);
                windows.push(Win { x: wx, y: wy, w: 4.0, h: 6.0, kind: 0, color: None });
                wx += step(7.0 * s);
            }
        }
        // the glass front: mullions, panels lit from inside, some colored (as on the real building)
        let gy = w_top + jr(21.0 * s);
        let gh = base - gy - 1.0;
        pix.rect(mx0 + 2.0, gy - 2.0, mx1 - mx0 - 4.0, 1.0, G5);
        pix.rect(mx0 + 2.0, gy - 1.0, mx1 - mx0 - 4.0, gh + 2.0, G0);
        let colors = [C2, B0, C3, P4, SKY8, B1];
        let mut ci = 0;
        let door = jr(mx0 + (mx1 - mx0) * 0.38);
        let mut wx = mx0 + 3.0;
        while wx + 6.0 < mx1 - 2.0 {
            let is_door = (wx - door).abs() < 4.0;
            let col = if !is_door && r.next() < 0.4 {
                let c = colors[ci % colors.len()];
                ci += 1;
                Some(c)
            } else {
                None
            };
            let kind = if is_door {
                3
            } else if col.is_some() {
                2
            } else {
                1
            };
            windows.push(Win { x: wx, y: gy, w: 6.0, h: gh, kind, color: col });
            wx += 7.0;
        }
    }
    // the orange tower in front of the main block's near end
    {
        let (tx0, tx1) = span(0.405, 0.452);
        let top = jr(ahf * 0.18);
        let w = tx1 - tx0;
        pix.rect(tx0, top, w, base - top, O3);
        let lit_w = jr(w * 0.3);
        let sh_w = jr(w * 0.2);
        pix.rect(if right { tx0 } else { tx1 - lit_w }, top, lit_w, base - top, O4);
        pix.rect(if right { tx1 - sh_w } else { tx0 }, top, sh_w, base - top, O2);
        pix.rect(tx0, top, w, 1.0, O6);
        pix.rect(tx0, top + 1.0, w, 1.0, O5);
        let mut wy = top + jr(7.0 * s);
        while wy < base - 14.0 * s {
            let wx = jr(tx0 + w / 2.0 - 2.0);
            pix.rect(wx - 1.0, wy - 1.0, 6.0, 7.0, O1);
            pix.rect(wx, wy, 4.0, 5.0, O0);
            windows.push(Win { x: wx, y: wy, w: 4.0, h: 5.0, kind: 0, color: None });
            wy += step(10.0 * s);
        }
    }

    // ---- the yard: paving slabs in perspective, petals, the granite benches
    {
        let mut rows = Vec::new();
        let mut y = hz + 1.0;
        let mut h = 2.0;
        while y < ahf {
            rows.push((y, h));
            y += h + 1.0;
            h = jr(h * 1.32 + 0.6);
        }
        pix.rect(0.0, hz, awf, ahf - hz, SKY3);
        pix.rect(0.0, hz, awf, 1.0, SKY1);
        for (ry, rh) in rows {
            pix.rect(0.0, ry + rh, awf, 1.0, SKY2);
            let st = step((10.0 + rh * 3.2) * s);
            let mut jx = (r.next() * st).floor();
            while jx < awf {
                pix.rect(jx, ry, 1.0, rh, SKY2);
                if r.next() < 0.18 {
                    pix.rect(jx + 1.0, ry, (st - 1.0).min(awf - jx - 1.0), rh, SKY4); // a lighter slab
                }
                jx += st;
            }
            let mut k = 0.0;
            while k < awf * 0.02 * rh {
                let v = r.next();
                let px = (r.next() * awf).floor();
                let py = ry + (r.next() * rh).floor();
                pix.set(px, py, if v < 0.4 { P4 } else if v < 0.7 { P3 } else { P5 });
                k += 1.0;
            }
        }
        for (f0, f1, yy) in [(0.47, 0.58, 0.8), (0.62, 0.74, 0.78), (0.07, 0.19, 0.81)] {
            let (b0, b1) = span(f0, f1);
            let by = jr(ahf * yy);
            pix.rect(b0, by, b1 - b0, 1.0, G7);
            pix.rect(b0, by + 1.0, b1 - b0, 1.0, G6);
            pix.rect(b0, by + 2.0, b1 - b0, jr(4.0 * s), G4);
            pix.rect(b0, by + 2.0, 1.0, jr(4.0 * s), G5);
            pix.rect(b0 + 1.0, by + 2.0 + jr(4.0 * s), b1 - b0 - 2.0, 1.0, SKY0);
        }
    }

    // a vending machine by the entrance (lit on the GPU too)
    let vend = Vend { x: x_at(0.6) - 5.0, y: base - jr(19.0 * s), w: 10.0, h: jr(19.0 * s) };
    {
        let Vend { x, y, w, h } = vend;
        pix.rect(x, y, w, h, C0);
        pix.rect(x, y, w, 1.0, C2);
        pix.rect(x + 1.0, y + 2.0, w - 2.0, 7.0, C3);
        let drinks = [P5, O5, B1, W, C2, O4, P6, Y1];
        for row in 0..3 {
            for col in 0..4 {
                pix.set(x + 2.0 + f64::from(col) * 2.0, y + 3.0 + f64::from(row) * 2.0, drinks[((row * 4 + col) % 8) as usize]);
            }
        }
        pix.rect(x + 1.0, y + 10.0, w - 2.0, 1.0, C1);
        pix.rect(x + 1.0, y + 12.0, 3.0, 2.0, Y1);
        pix.rect(x + 2.0, y + h - 4.0, w - 4.0, 2.0, SKY0);
        pix.rect(x - 1.0, y + h, w + 2.0, 1.0, SKY0);
    }

    // ---- the cherry trees: trunks and branches here, the crowns are blobs on the GPU
    let mut trees = Vec::new();
    for (f, crown_y, rx, ry, trunk_y) in [(0.055, 0.36, 40.0, 27.0, 0.86), (0.355, 0.4, 32.0, 23.0, 0.83), (0.805, 0.37, 33.0, 24.0, 0.85), (0.99, 0.3, 35.0, 26.0, 0.84)] {
        let tx = x_at(f);
        let (cx, cy, rx, ry, tbase) = (tx, jr(ahf * crown_y), rx * s, ry * s, jr(ahf * trunk_y));
        // fallen petals around the trunk
        for _ in 0..60 {
            let a = r.next() * PI * 2.0;
            let d = r.next().sqrt();
            let x = tx + a.cos() * d * rx * 1.2;
            let y = tbase + a.sin() * d * 5.0 * s;
            if y > hz + 1.0 {
                pix.set(x, y, if r.next() < 0.5 { P5 } else { P4 });
            }
        }
        // the trunk: tapering spans, lit on the left edge, a dark right edge; branches as lines
        let top = cy + jr(ry * 0.2);
        let lean = jr((r.next() - 0.5) * 6.0 * s);
        let mut y = top;
        while y <= tbase {
            let u = (y - top) / (tbase - top).max(1.0);
            let w = jr((2.0 + u * 2.6) * s).max(2.0);
            let tcx = jr(tx + lean * (1.0 - u) + (u * 5.0).sin() * 0.8);
            let left = tcx - (w / 2.0).floor();
            pix.rect(left, y, w, 1.0, T1);
            pix.set(left, y, T2);
            pix.set(left + w - 1.0, y, T0);
            y += 1.0;
        }
        pix.rect(tx - 3.0, tbase, 7.0, 1.0, SKY1); // its shadow on the ground
        for i in 0..7 {
            let a = -PI / 2.0 + (f64::from(i) / 6.0 - 0.5) * 2.6 + (r.next() - 0.5) * 0.3;
            let len = (0.55 + r.next() * 0.45) * (a.cos().abs() * rx + a.sin().abs() * ry);
            let x0 = tx + lean;
            let y0 = top + jr(r.next() * 4.0 * s);
            let x1 = x0 + a.cos() * len;
            let y1 = y0 + a.sin() * len * 0.8;
            pix.line(x0, y0, x1, y1, T0);
            if i % 2 == 0 {
                pix.line(x0 + 1.0, y0, (x0 + x1) / 2.0 + 1.0, (y0 + y1) / 2.0, T0);
            }
        }
        // the crown: discs in four tones (cel shading: dark rim below, light upper left), then
        // single blossom pixels on top
        let mut lobes = Vec::with_capacity(5);
        for _ in 0..5 {
            let lx = cx + (r.next() - 0.5) * rx * 1.3;
            let ly = cy + (r.next() - 0.5) * ry * 0.9;
            let lr = 0.45 + r.next() * 0.25;
            lobes.push((lx, ly, lr));
        }
        let in_crown = |x: f64, y: f64| {
            if lobes.iter().any(|&(lx, ly, lr)| ((x - lx) / (rx * lr)).powi(2) + ((y - ly) / (ry * lr * 1.1)).powi(2) < 1.0) {
                return true;
            }
            ((x - cx) / rx).powi(2) + ((y - cy) / ry).powi(2) < 0.75
        };
        let crown_h = |y: f64| (tbase - y) / (tbase - cy + ry);
        let mut blobs = Vec::new();
        let mut sample = |r: &mut Rng32, n: usize, r_min: f64, r_max: f64, tone: usize, bias: Option<[f64; 3]>| {
            let (mut i, mut made) = (0, 0);
            while i < n * 10 && made < n {
                i += 1;
                let x = cx + (r.next() * 2.0 - 1.0) * rx * 1.05;
                let y = cy + (r.next() * 2.0 - 1.0) * ry * 1.05;
                if !in_crown(x, y) {
                    continue;
                }
                let lx = (x - cx) / rx;
                let ly = (y - cy) / ry;
                if let Some(b) = bias
                    && lx * b[0] + ly * b[1] < b[2] + (r.next() - 0.5) * 0.5
                {
                    continue;
                }
                made += 1;
                let rad = jr((r_min + r.next() * (r_max - r_min)) * s * 2.0) / 2.0;
                let phase = r.next() * PHASES;
                blobs.push(Blob { x: jr(x), y: jr(y), r: rad, tone, phase, h: crown_h(y) });
            }
        };
        sample(&mut r, 34, 5.0, 8.5, 0, None);
        sample(&mut r, 36, 4.0, 7.0, 1, Some([-0.6, -0.8, -0.55]));
        sample(&mut r, 28, 2.5, 4.5, 2, Some([-0.6, -0.8, 0.05]));
        sample(&mut r, 14, 1.5, 2.5, 3, Some([-0.5, -0.9, 0.25]));
        let mut dots = Vec::new();
        for _ in 0..90 {
            let x = cx + (r.next() * 2.0 - 1.0) * rx;
            let y = cy + (r.next() * 2.0 - 1.0) * ry;
            if !in_crown(x, y) {
                continue;
            }
            let upper = (x - cx) / rx + (y - cy) / ry < 0.0;
            let tone = if upper {
                if r.next() < 0.5 { 4 } else { 5 }
            } else if r.next() < 0.5 {
                6
            } else {
                4
            };
            let phase = r.next() * PHASES;
            dots.push(Blob { x: jr(x), y: jr(y), r: 0.0, tone, phase, h: crown_h(y) });
        }
        trees.push(Tree { cx, cy, rx, ry, blobs, dots });
    }

    // ---- the lantern string between the middle trees (a sagging line); lanterns hang from it
    let mut lanterns = Vec::new();
    {
        let (a0, a1) = span(0.36, 0.8);
        let y0 = ahf * 0.11;
        let sag = ahf * 0.07;
        let at = |u: f64| [a0 + (a1 - a0) * u, y0 + sag * 4.0 * u * (1.0 - u) + (u - 0.5) * 2.0 * s];
        let mut prev = at(0.0);
        for i in 1..=60 {
            let p = at(f64::from(i) / 60.0);
            pix.line(prev[0], prev[1], p[0], p[1], SKY0);
            prev = p;
        }
        let n = 7;
        for i in 0..n {
            let [x, y] = at((f64::from(i) + 0.5) / f64::from(n));
            let phase = r.next() * PHASES;
            lanterns.push(Lantern { x: jr(x), y: jr(y), len: jr((2.0 + f64::from(i % 2) * 3.0) * s), phase });
        }
    }

    // the cat on the bench in front of the school (its eyes blink on the GPU)
    let (cb0, cb1) = span(0.62, 0.74);
    let (cat_x, cat_y) = (jr(cb0 + (cb1 - cb0) * 0.3) as i64, jr(ahf * 0.78) as i64);
    let cat = {
        let sprite = ["..#...#..", "..##.##..", "..#####..", "..#####..", ".#######.", "########.", "#########", ".########"];
        let tail: i64 = if right { 1 } else { -1 };
        for (j, row) in sprite.iter().enumerate() {
            let len = row.len() as i64;
            for (i, b) in row.bytes().enumerate() {
                if b == b'#' {
                    let i = i as i64;
                    pix.seti(cat_x + if tail > 0 { i } else { len - 1 - i }, cat_y - sprite.len() as i64 + j as i64, SKY0);
                }
            }
        }
        for j in 0..4i64 {
            pix.seti(cat_x + if tail > 0 { 9 } else { -1 } + if j == 0 { 0 } else { tail * j.min(2) }, cat_y - 1 - j, SKY0);
        }
        let (e0, e1) = if tail > 0 { (3, 5) } else { (5, 3) };
        Cat { eyes: [(cat_x + e0) as f64, (cat_y - 5) as f64, (cat_x + e1) as f64, (cat_y - 5) as f64] }
    };

    Painting { pix, scenery: Scenery { stars, windows, trees, lanterns, lights, vend, cat, horizon: hz, scale: s } }
}
