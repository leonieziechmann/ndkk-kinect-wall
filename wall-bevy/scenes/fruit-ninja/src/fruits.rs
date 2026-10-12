//! The fruits as pixel art (fruits.js): every kind is a shape (signed distance in units of its
//! radius, y up) and a color per point of its skin and of its cut face. draw.rs samples them once
//! per block (2 x 2 LEDs), so a fruit can turn and still looks blocky and crisp.
//!
//! Light comes from the top left and stays there while a fruit spins (shading uses the unturned
//! position). Every kind has a ramp of four tones; the shadows shift towards red and violet, never
//! to a darker yellow or green (dim yellow and green look olive on the LED wall).

use std::f64::consts::PI;

use super::pix::{Rgb, js_round, js_sign, rgb};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Kind {
    Melon,
    Orange,
    Apple,
    Lemon,
    Berry,
    Plum,
    Dragon,
    Star,
    Frost,
    Bomb,
}

pub const NORMAL: [Kind; 7] = [Kind::Melon, Kind::Orange, Kind::Apple, Kind::Lemon, Kind::Berry, Kind::Plum, Kind::Dragon];

pub struct KindInfo {
    /// m
    pub r: f64,
    pub skin: [Rgb; 4],
    /// the melon's stripes (the others: their skin)
    pub stripe: [Rgb; 4],
    pub juice: Rgb,
    pub hi: Rgb,
    pub aura: Option<Rgb>,
    pub special: bool,
}

const fn ramp(h: [u32; 4]) -> [Rgb; 4] {
    [rgb(h[0]), rgb(h[1]), rgb(h[2]), rgb(h[3])]
}

const fn kind(r: f64, skin: [u32; 4], juice: u32, hi: u32) -> KindInfo {
    KindInfo { r, skin: ramp(skin), stripe: ramp(skin), juice: rgb(juice), hi: rgb(hi), aura: None, special: false }
}

static KINDS: [KindInfo; 10] = [
    KindInfo { stripe: ramp([0x032a22, 0x05482c, 0x0b6633, 0x2f9443]), ..kind(0.2, [0x073f33, 0x0b6b3c, 0x23a447, 0x76dc66], 0xff2d55, 0xc8ffb8) },
    kind(0.15, [0xc23200, 0xf05e00, 0xff8c00, 0xffc04a], 0xff9a1a, 0xfff1c8),
    kind(0.14, [0x6a0030, 0xc0002e, 0xff1f3d, 0xff7070], 0xfff0b8, 0xffe4e4),
    kind(0.13, [0xe05a00, 0xffa800, 0xffe01a, 0xfff59a], 0xfff04a, 0xffffff),
    kind(0.13, [0x80003a, 0xd0083c, 0xff2a48, 0xff8090], 0xff2050, 0xffe0e6),
    kind(0.14, [0x2a0866, 0x5412a8, 0x8a2cf0, 0xbd90ff], 0xc050ff, 0xf2e2ff),
    kind(0.16, [0x80004a, 0xd0006a, 0xff2a9a, 0xff90cf], 0xff3aa8, 0xffe6f4),
    // specials: the star fruit starts a frenzy, the frost fruit slows everything down
    KindInfo { aura: Some(rgb(0xffb21a)), special: true, ..kind(0.16, [0xe05a00, 0xffa400, 0xffd84a, 0xfff4a8], 0xffd21a, 0xffffff) },
    KindInfo { aura: Some(rgb(0x5ad8ff)), special: true, ..kind(0.15, [0x1a34d0, 0x3a74ff, 0x7ac4ff, 0xd8f4ff], 0x9ae8ff, 0xffffff) },
    KindInfo { aura: Some(rgb(0xff1a3a)), ..kind(0.15, [0x05050a, 0x10121e, 0x21263e, 0x465078], 0xff8a2a, 0xb8c6ff) },
];

pub fn info(k: Kind) -> &'static KindInfo {
    &KINDS[k as usize]
}

mod c {
    use super::super::pix::{Rgb, rgb};
    use super::ramp;
    pub const LEAF: [Rgb; 4] = ramp([0x05603e, 0x0a8a4a, 0x2fc456, 0x7cf080]);
    pub const STEM: Rgb = rgb(0x9a5a22);
    pub const SEED_Y: Rgb = rgb(0xffe14a);
    pub const SEED_O: Rgb = rgb(0xff9a2a);
    pub const GREEN: Rgb = rgb(0x3aff8a);
    pub const GREEN_D: Rgb = rgb(0x14b860);
    pub const RED: Rgb = rgb(0xff1a3a);
    pub const RED_D: Rgb = rgb(0xa0002a);
    pub const FUSE: Rgb = rgb(0xd09858);
    pub const CAP: Rgb = rgb(0x5a6488);
    // cut faces
    pub const MELON_RIND: Rgb = rgb(0x0b6633);
    pub const MELON_PALE: Rgb = rgb(0xd8ffc0);
    pub const MELON_PINK: Rgb = rgb(0xff7a90);
    pub const MELON_RED: Rgb = rgb(0xff2d55);
    pub const MELON_SEED: Rgb = rgb(0x200010);
    pub const OR_PEEL: Rgb = rgb(0xff8c00);
    pub const OR_PITH: Rgb = rgb(0xfff0d0);
    pub const OR_IN: Rgb = rgb(0xffb02a);
    pub const OR_OUT: Rgb = rgb(0xff9410);
    pub const OR_DOT: Rgb = rgb(0xffcc55);
    pub const AP_SKIN: Rgb = rgb(0xff1f3d);
    pub const AP_FLESH: Rgb = rgb(0xfff6cc);
    pub const AP_CORE: Rgb = rgb(0xffe49a);
    pub const AP_SEED: Rgb = rgb(0x7a3000);
    pub const LE_PEEL: Rgb = rgb(0xffe01a);
    pub const LE_PITH: Rgb = rgb(0xfffbe8);
    pub const LE_IN: Rgb = rgb(0xfff27a);
    pub const LE_OUT: Rgb = rgb(0xffe84a);
    pub const BE_SKIN: Rgb = rgb(0xff2a48);
    pub const BE_FLESH: Rgb = rgb(0xff5a7a);
    pub const BE_CORE: Rgb = rgb(0xffd4de);
    pub const PL_SKIN: Rgb = rgb(0x7a20d0);
    pub const PL_FLESH: Rgb = rgb(0xffcf3a);
    pub const PL_EDGE: Rgb = rgb(0xffa82a);
    pub const PL_PIT: Rgb = rgb(0xe88a2a);
    pub const DR_SKIN: Rgb = rgb(0xff2a9a);
    pub const DR_FLESH: Rgb = rgb(0xffffff);
    pub const DR_EDGE: Rgb = rgb(0xffe0f2);
    pub const DR_SEED: Rgb = rgb(0x1a1430);
    pub const ST_FLESH: Rgb = rgb(0xfff6c0);
    pub const ST_LINE: Rgb = rgb(0xffcc3a);
    pub const FR_FLESH: Rgb = rgb(0xe8fbff);
    pub const FR_LINE: Rgb = rgb(0x7ac8ff);
}

pub fn hash(x: f64, y: f64) -> f64 {
    let s = (x * 127.1 + y * 311.7).sin() * 43758.5453;
    s - s.floor()
}

fn ellipse(x: f64, y: f64, a: f64, b: f64) -> f64 {
    ((x / a).hypot(y / b) - 1.0) * a.min(b)
}

fn seg_dist(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = bx - ax;
    let dy = by - ay;
    let h = (((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
    (px - ax - dx * h).hypot(py - ay - dy * h)
}

/// fract of a turn: ((v % 1) + 1) % 1
fn turn(v: f64) -> f64 {
    ((v % 1.0) + 1.0) % 1.0
}

// five-pointed star (Inigo Quilez), pointing up: r outer radius, rf inner ratio
const K1: [f64; 2] = [0.809_016_994_375, -0.587_785_252_292];
pub fn star5(x0: f64, y0: f64, r: f64, rf: f64) -> f64 {
    let mut px = x0.abs();
    let mut py = y0;
    let mut d = (px * K1[0] + py * K1[1]).max(0.0);
    px -= 2.0 * d * K1[0];
    py -= 2.0 * d * K1[1];
    d = (-px * K1[0] + py * K1[1]).max(0.0);
    px += 2.0 * d * K1[0];
    py -= 2.0 * d * K1[1];
    px = px.abs();
    py -= r;
    let bax = rf * -K1[1];
    let bay = rf * K1[0] - 1.0;
    let h = ((px * bax + py * bay) / (bax * bax + bay * bay)).max(0.0).min(r);
    let ex = px - bax * h;
    let ey = py - bay * h;
    ex.hypot(ey) * js_sign(py * bax - px * bay)
}

/// the light on a sphere at (sx, sy) (unturned, units of the radius): 0 dark .. 1 bright
fn lambert(sx: f64, sy: f64) -> f64 {
    let zz = 1.0 - sx * sx - sy * sy;
    let nz = if zz > 0.0 { zz.sqrt() } else { 0.0 };
    -0.5 * sx + 0.62 * sy + 0.6 * nz
}

fn tone(rmp: &[Rgb; 4], sx: f64, sy: f64, k: i32) -> Rgb {
    let l = lambert(sx, sy);
    let i = if l > 0.8 {
        3
    } else if l > 0.45 {
        2
    } else if l > 0.1 {
        1
    } else {
        0
    };
    // one brighter than the brightest: the brightest (the apple's streak)
    rmp[(i - k).clamp(0, 3) as usize]
}

fn glint(sx: f64, sy: f64) -> bool {
    (sx + 0.4).powi(2) + (sy - 0.44).powi(2) < 0.028
}

/// the shape: signed distance (units of the radius, < 0 inside) incl. stems and leaves
pub fn shape(k: Kind, x: f64, y: f64) -> f64 {
    match k {
        Kind::Melon => ellipse(x, y, 1.0, 0.84),
        Kind::Apple => {
            let body = ellipse(x, y + 0.03, 1.04, 1.0).max(0.27 - x.hypot(y - 1.0));
            let stem = seg_dist(x, y, 0.0, 0.7, 0.1, 1.18) - 0.07;
            let leaf = ellipse((x - 0.33) * 0.88 + (y - 1.04) * 0.47, -(x - 0.33) * 0.47 + (y - 1.04) * 0.88, 0.3, 0.13);
            body.min(stem).min(leaf)
        }
        Kind::Lemon => ellipse(x, y, 1.0, 0.76).min((x - 0.95).hypot(y).min((x + 0.95).hypot(y)) - 0.16),
        Kind::Berry => {
            let w = 0.74 + 0.24 * y.clamp(-1.0, 1.0);
            (((x / w).hypot(y + 0.02) - 1.0) * w).min(star5(x, y - 0.86, 0.48, 0.42))
        }
        Kind::Plum => ellipse(x, y, 0.92, 1.0).min(seg_dist(x, y, 0.04, 0.9, 0.12, 1.14) - 0.06),
        Kind::Dragon => ellipse(x, y, 0.84, 1.0),
        Kind::Star => star5(x, y, 1.05, 0.55) - 0.06,
        Kind::Frost => {
            let a = y.atan2(x);
            let tri = (turn(a / (2.0 * PI) * 8.0) - 0.5).abs() * 2.0;
            x.hypot(y) - (0.88 + 0.12 * tri)
        }
        Kind::Bomb => (x.hypot(y) - 0.9).min(seg_dist(x, y, 0.0, 0.9, 0.0, 1.02) - 0.17).min(seg_dist(x, y, 0.0, 1.05, 0.2, 1.3) - 0.055),
        Kind::Orange => x.hypot(y) - 1.0,
    }
}

/// The skin at (x, y) (turned with the fruit) and (sx, sy) (unturned, for the light), units of the
/// radius; t: time (s) for what sparkles. None outside the shape.
pub fn skin(k: Kind, x: f64, y: f64, sx: f64, sy: f64, t: f64) -> Option<Rgb> {
    if shape(k, x, y) > 0.0 {
        return None;
    }
    let ki = info(k);
    if glint(sx, sy) && k != Kind::Star {
        return Some(ki.hi);
    }
    Some(match k {
        Kind::Melon => {
            let m = y / (1.0 - x * x * 0.92).max(0.0).sqrt().max(0.3);
            let s = turn(m * 2.3 + 0.07 * (x * 15.0).sin());
            tone(if s < 0.42 { &ki.stripe } else { &ki.skin }, sx, sy, 0)
        }
        Kind::Orange => {
            if (x - 0.06).hypot(y - 0.9) < 0.1 {
                return Some(c::LEAF[2]);
            }
            let pore = hash((x * 8.0).floor(), (y * 8.0).floor()) < 0.16;
            tone(&ki.skin, sx, sy, i32::from(pore))
        }
        Kind::Apple => {
            if seg_dist(x, y, 0.0, 0.7, 0.1, 1.18) < 0.075 && y > 0.72 {
                return Some(c::STEM);
            }
            if y > 0.88 && x > 0.08 {
                return Some(tone(&c::LEAF, sx, sy, 0));
            }
            // a lighter streak down one side
            let streak = (x + 0.35 - 0.15 * y).abs() < 0.1 && y < 0.6;
            tone(&ki.skin, sx, sy, if streak { -1 } else { 0 })
        }
        Kind::Lemon => {
            let pore = hash((x * 9.0).floor(), (y * 9.0).floor()) < 0.1;
            tone(&ki.skin, sx, sy, i32::from(pore))
        }
        Kind::Berry => {
            if y > 0.62 && star5(x, y - 0.86, 0.48, 0.42) < 0.0 {
                return Some(tone(&c::LEAF, sx, sy, 0));
            }
            let w = 0.74 + 0.24 * y.clamp(-1.0, 1.0);
            // seeds on a diagonal lattice
            let u = (x / w + y) * 2.4;
            let v = (x / w - y) * 2.4;
            let du = u - js_round(u);
            let dv = v - js_round(v);
            if du * du + dv * dv < 0.035 {
                return Some(if lambert(sx, sy) > 0.2 { c::SEED_Y } else { c::SEED_O });
            }
            tone(&ki.skin, sx, sy, 0)
        }
        Kind::Plum => {
            if y > 0.88 {
                return Some(c::STEM);
            }
            let crease = (x - 0.16 * y - 0.04).abs() < 0.05 && y > -0.7;
            tone(&ki.skin, sx, sy, i32::from(crease))
        }
        Kind::Dragon => {
            // green-tipped scales: rows of leaves around the fruit
            let a = y.atan2(x);
            let rr = (x / 0.84).hypot(y);
            let row = (rr * 3.2).floor();
            let u = turn(a / (2.0 * PI) * (5.0 + row * 2.0) + row * 0.37);
            let v = rr * 3.2 - row;
            if row >= 1.0 && (u - 0.5).abs() < 0.18 * (1.0 - v) && v > 0.35 {
                return Some(if v > 0.7 { c::GREEN } else { c::GREEN_D });
            }
            tone(&ki.skin, sx, sy, 0)
        }
        Kind::Star => {
            // a ridge from the middle to each tip
            let a = x.atan2(y);
            let kk = (turn(a / (2.0 * PI) * 5.0) - 0.5).abs();
            if kk > 0.47 && x.hypot(y) > 0.15 {
                return Some(ki.skin[1]);
            }
            if glint(sx, sy) {
                return Some(ki.hi);
            }
            tone(&ki.skin, sx, sy, 0)
        }
        Kind::Frost => {
            let a = y.atan2(x);
            let facet = (turn(a / (2.0 * PI) * 8.0) * 2.0).floor() as i32;
            let sparkle = hash((x * 6.0).floor(), (y * 6.0).floor() + (t * 6.0).floor()) > 0.95;
            if sparkle {
                return Some(ki.hi);
            }
            tone(&ki.skin, sx, sy, facet)
        }
        Kind::Bomb => {
            if y > 1.03 {
                return Some(c::FUSE);
            }
            if y > 0.86 {
                return Some(c::CAP);
            }
            // a red band that pulses: "danger"
            if (y + 0.05).abs() < 0.13 {
                return Some(if (t * 9.0).sin() > -0.2 { c::RED } else { c::RED_D });
            }
            tone(&ki.skin, sx, sy, 0)
        }
    })
}

/// the cut face: (u, v) in the unit disc of the cross-section
pub fn flesh(k: Kind, u: f64, v: f64) -> Rgb {
    let d = u.hypot(v);
    let a = v.atan2(u);
    match k {
        Kind::Melon => {
            if d > 0.92 {
                return c::MELON_RIND;
            }
            if d > 0.82 {
                return c::MELON_PALE;
            }
            if d > 0.75 {
                return c::MELON_PINK;
            }
            for i in 0..8 {
                let b = f64::from(i) / 8.0 * PI * 2.0 + 0.2;
                if (u - 0.5 * b.cos()).hypot(v - 0.5 * b.sin()) < 0.075 {
                    return c::MELON_SEED;
                }
            }
            c::MELON_RED
        }
        Kind::Orange | Kind::Lemon => {
            let o = k == Kind::Orange;
            if d > 0.93 {
                return if o { c::OR_PEEL } else { c::LE_PEEL };
            }
            if d > 0.84 {
                return if o { c::OR_PITH } else { c::LE_PITH };
            }
            let sector = turn(a / (2.0 * PI) * 10.0);
            if sector < 0.09 || d < 0.12 {
                return if o { c::OR_PITH } else { c::LE_PITH };
            }
            if hash((u * 9.0).floor(), (v * 9.0).floor()) < 0.15 {
                return if o { c::OR_DOT } else { c::LE_PITH };
            }
            match (d < 0.55, o) {
                (true, true) => c::OR_IN,
                (true, false) => c::LE_IN,
                (false, true) => c::OR_OUT,
                (false, false) => c::LE_OUT,
            }
        }
        Kind::Apple => {
            if d > 0.93 {
                return c::AP_SKIN;
            }
            for i in 0..5 {
                let b = f64::from(i) / 5.0 * PI * 2.0 + PI / 2.0;
                if (u - 0.2 * b.cos()).hypot(v - 0.2 * b.sin()) < 0.065 {
                    return c::AP_SEED;
                }
            }
            if star5(u, v, 0.36, 0.5) < 0.0 {
                return c::AP_CORE;
            }
            c::AP_FLESH
        }
        Kind::Berry => {
            if d > 0.88 {
                return c::BE_SKIN;
            }
            let streak = (turn(a / (2.0 * PI) * 12.0) - 0.5).abs() < 0.06 && d > 0.3;
            if d < 0.3 || streak { c::BE_CORE } else { c::BE_FLESH }
        }
        Kind::Plum => {
            if d > 0.92 {
                return c::PL_SKIN;
            }
            if (u / 0.3).powi(2) + (v / 0.42).powi(2) < 1.0 {
                return c::PL_PIT;
            }
            if d > 0.75 { c::PL_EDGE } else { c::PL_FLESH }
        }
        Kind::Dragon => {
            if d > 0.9 {
                return c::DR_SKIN;
            }
            if d > 0.8 {
                return c::DR_EDGE;
            }
            if hash((u * 7.5).floor(), (v * 7.5).floor()) < 0.22 && hash((u * 15.0).floor(), (v * 15.0).floor()) < 0.5 { c::DR_SEED } else { c::DR_FLESH }
        }
        Kind::Star => {
            if d > 0.9 {
                return info(Kind::Star).skin[2];
            }
            let s = star5(u, v, 0.55, 0.5);
            if s < 0.0 && s > -0.06 { c::ST_LINE } else { c::ST_FLESH }
        }
        Kind::Frost => {
            let kk = (turn(a / PI * 3.0) - 0.5).abs();
            if kk > 0.44 { c::FR_LINE } else { c::FR_FLESH }
        }
        Kind::Bomb => c::AP_FLESH,
    }
}

/// the face of a cut: how deep the cut surface shows, seen a little from the side (units of the radius)
pub const FACE: f64 = 0.42;
