//! The players as ninjas (ninja.js): every cell of a person's silhouette (from the mask, exact every
//! frame) gets a piece of the costume from the nearest bone of the skeleton, and a shade from where
//! it lies on that limb (a cylinder lit from the top left: volume instead of a flat cut-out). A dark
//! suit with a crossed collar and a belt with a knot, a hood with an eye slit, glowing eyes and a
//! headband in the player's color, metal guards on the forearms, wraps on the wrists and shins. The
//! tails of the headband and the hilt of a sword on the back are drawn behind the body (draw.rs).

use wall::persons::{NPOINTS, j};
use wall::map::WallMap;

/// the pieces of the costume
pub mod part {
    pub const SUIT: u8 = 1;
    pub const HOOD: u8 = 2;
    pub const SKIN: u8 = 3;
    pub const EYE: u8 = 4;
    pub const BAND: u8 = 5;
    pub const BELT: u8 = 6;
    pub const COLLAR: u8 = 7;
    pub const WRAP: u8 = 8;
    pub const WRAP2: u8 = 9;
    pub const FOOT: u8 = 10;
    pub const PLATE: u8 = 11;
    pub const PANTS: u8 = 12;
}

/// the shade of a cell: base, lit (towards the light), dark (away from it)
pub mod shade {
    pub const BASE: u8 = 0;
    pub const LIT: u8 = 1;
    pub const DARK: u8 = 2;
}

// the kinds of bones
const TORSO: u8 = 0;
const UPPER: u8 = 1;
const FORE: u8 = 2;
const HAND: u8 = 3;
const THIGH: u8 = 4;
const SHIN: u8 = 5;
const NECK: u8 = 6;
// the radius of each kind of limb (m): how far from the bone its surface turns away from the light
const RADIUS: [f64; 7] = [0.17, 0.055, 0.05, 0.045, 0.085, 0.065, 0.06];
const BONES: [(usize, usize, u8); 16] = [
    (j::NECK, j::PELVIS, TORSO),
    (j::LEFT_SHOULDER, j::LEFT_HIP, TORSO),
    (j::RIGHT_SHOULDER, j::RIGHT_HIP, TORSO),
    (j::LEFT_SHOULDER, j::RIGHT_SHOULDER, TORSO),
    (j::LEFT_HIP, j::RIGHT_HIP, TORSO),
    (j::LEFT_SHOULDER, j::LEFT_ELBOW, UPPER),
    (j::RIGHT_SHOULDER, j::RIGHT_ELBOW, UPPER),
    (j::LEFT_ELBOW, j::LEFT_WRIST, FORE),
    (j::RIGHT_ELBOW, j::RIGHT_WRIST, FORE),
    (j::LEFT_WRIST, j::LEFT_HAND, HAND),
    (j::RIGHT_WRIST, j::RIGHT_HAND, HAND),
    (j::LEFT_HIP, j::LEFT_KNEE, THIGH),
    (j::RIGHT_HIP, j::RIGHT_KNEE, THIGH),
    (j::LEFT_KNEE, j::LEFT_ANKLE, SHIN),
    (j::RIGHT_KNEE, j::RIGHT_ANKLE, SHIN),
    (j::NECK, j::HEAD, NECK),
];
/// the joints of the bones
const JOINTS: [usize; 17] = [
    j::NECK,
    j::PELVIS,
    j::LEFT_SHOULDER,
    j::LEFT_HIP,
    j::RIGHT_SHOULDER,
    j::RIGHT_HIP,
    j::LEFT_ELBOW,
    j::RIGHT_ELBOW,
    j::LEFT_WRIST,
    j::RIGHT_WRIST,
    j::LEFT_HAND,
    j::RIGHT_HAND,
    j::LEFT_KNEE,
    j::RIGHT_KNEE,
    j::LEFT_ANKLE,
    j::RIGHT_ANKLE,
    j::HEAD,
];

/// A skeleton on the wall: [x, y] (m) per point (persons::POINTS), only the points that are seen.
pub type Sk = [Option<[f64; 2]>; NPOINTS];

/// the skeleton of a person on the wall
pub fn skeleton_of(wall: &WallMap, person: &wall::persons::Person) -> Sk {
    let mut sk: Sk = [None; NPOINTS];
    for &n in &JOINTS {
        sk[n] = wall.joint(person, n).map(|v| [f64::from(v.x), f64::from(v.y)]).filter(|v| v[0].is_finite() && v[1].is_finite());
    }
    sk
}

/// a bone as a flat segment: ax, ay, bx, by, kind, length
type Seg = [f64; 6];

fn seg(a: [f64; 2], b: [f64; 2], kind: u8) -> Seg {
    let l = (b[0] - a[0]).hypot(b[1] - a[1]);
    [a[0], a[1], b[0], b[1], f64::from(kind), if l == 0.0 || l.is_nan() { 1e-6 } else { l }]
}

/// What dress() needs of one skeleton (prepared once per tracking result).
#[derive(Clone)]
pub struct Prep {
    pub on: bool,
    sk: Sk,
    segs: Vec<Seg>,
    pelvis_y: Option<f64>,
    collar: Option<[Seg; 2]>,
    spine: Option<Seg>,
}

impl Prep {
    pub fn new() -> Self {
        Self { on: false, sk: [None; NPOINTS], segs: Vec::with_capacity(BONES.len()), pelvis_y: None, collar: None, spine: None }
    }

    /// the same as `o` (keeps its own allocation)
    pub fn copy_from(&mut self, o: &Prep) {
        self.on = o.on;
        self.sk = o.sk;
        self.segs.clear();
        self.segs.extend_from_slice(&o.segs);
        self.pelvis_y = o.pelvis_y;
        self.collar = o.collar;
        self.spine = o.spine;
    }

    pub fn fill(&mut self, sk: &Sk) {
        self.on = true;
        self.sk = *sk;
        self.segs.clear();
        for &(a, b, k) in &BONES {
            if let (Some(p), Some(q)) = (sk[a], sk[b]) {
                self.segs.push(seg(p, q, k));
            }
        }
        self.pelvis_y = sk[j::PELVIS].map(|p| p[1]).or(match (sk[j::LEFT_HIP], sk[j::RIGHT_HIP]) {
            (Some(l), Some(r)) => Some((l[1] + r[1]) / 2.0),
            _ => None,
        });
        // the crossed collar: from beside the neck down to the chest
        self.collar = match (sk[j::NECK], sk[j::LEFT_SHOULDER], sk[j::RIGHT_SHOULDER], self.pelvis_y) {
            (Some(n), Some(ls), Some(rs), Some(py)) => {
                let chest = [n[0], n[1] - (n[1] - py) * 0.32];
                let at = |s: [f64; 2]| [n[0] + (s[0] - n[0]) * 0.45, n[1] + (s[1] - n[1]) * 0.45];
                Some([seg(at(ls), chest, 0), seg(at(rs), chest, 0)])
            }
            _ => None,
        };
        self.spine = match (sk[j::NECK], sk[j::PELVIS]) {
            (Some(n), Some(p)) => Some(seg(n, p, TORSO)),
            _ => None,
        };
    }
}

/// squared distance from (px, py) to segment s, where along it the nearest point is (0..1) and the
/// offset of the point from that nearest point (m)
fn seg_dist2(px: f64, py: f64, s: &Seg) -> (f64, f64, f64, f64) {
    let dx = s[2] - s[0];
    let dy = s[3] - s[1];
    let u = (((px - s[0]) * dx + (py - s[1]) * dy) / (s[5] * s[5])).clamp(0.0, 1.0);
    let ox = px - s[0] - dx * u;
    let oy = py - s[1] - dy * u;
    (ox * ox + oy * oy, u, ox, oy)
}

/// light from the top left on a cylinder: the offset from the bone (m) over the radius
fn shade_of(ox: f64, oy: f64, r: f64) -> u8 {
    let l = (-0.62 * ox + 0.55 * oy) / r;
    if l > 0.28 {
        shade::LIT
    } else if l < -0.32 {
        shade::DARK
    } else {
        shade::BASE
    }
}

/// the fine things at one cell: the head (hood, headband, eye slit, eyes), the belt knot; with shade
fn classify_fine(pp: &Prep, x: f64, y: f64) -> Option<(u8, u8)> {
    let sk = &pp.sk;
    // the head: hood, the headband over the eye slit
    if let Some(h) = sk[j::HEAD] {
        let neck_y = sk[j::NECK].map_or(h[1] - 0.15, |n| n[1]);
        if y > neck_y - 0.005 && (x - h[0]).powi(2) + ((y - h[1]) * 0.9).powi(2) < 0.0225 {
            let dy = y - h[1];
            let dx = (x - h[0]).abs();
            let sh = shade_of(x - h[0], dy, 0.11);
            if dy > 0.042 && dy < 0.088 {
                return Some((part::BAND, sh));
            }
            if dy > -0.012 && dy <= 0.042 && dx < 0.072 {
                if dy > 0.002 && dy < 0.026 && (dx - 0.034).abs() < 0.011 {
                    return Some((part::EYE, sh));
                }
                return Some((part::SKIN, sh));
            }
            return Some((part::HOOD, sh));
        }
    }
    // the knot of the belt: two ends hanging in front
    if let (Some(py), Some(pel)) = (pp.pelvis_y, sk[j::PELVIS])
        && y < py - 0.01
        && y > py - 0.1
        && (x - pel[0] + 0.03 + (py - y) * 0.15).abs() < 0.014
    {
        return Some((part::BELT, shade::BASE));
    }
    None
}

/// the costume of the body at (x, y): the piece of the nearest bone, with its shade (`last`: the
/// shade found before, kept when there is no bone)
fn classify(pp: &Prep, x: f64, y: f64, last: &mut u8) -> u8 {
    let sk = &pp.sk;
    let mut best = 1e9;
    let mut bs: Option<&Seg> = None;
    let mut bu = 0.0;
    for s in &pp.segs {
        let (d, u, _, _) = seg_dist2(x, y, s);
        if d < best {
            best = d;
            bs = Some(s);
            bu = u;
        }
    }
    let Some(bs) = bs else { return part::SUIT };
    let kind = bs[4] as u8;
    // the shade: from the spine for the body, else from the nearest bone
    *last = match (kind, &pp.spine) {
        (TORSO, Some(sp)) => {
            let (_, _, ox, oy) = seg_dist2(x, y, sp);
            shade_of(ox, oy, RADIUS[TORSO as usize])
        }
        _ => {
            let (_, _, ox, oy) = seg_dist2(x, y, bs);
            shade_of(ox, oy, RADIUS.get(kind as usize).copied().unwrap_or(RADIUS[0]))
        }
    };
    match kind {
        TORSO => {
            if pp.pelvis_y.is_some_and(|py| (y - py - 0.02).abs() < 0.035) {
                return part::BELT;
            }
            if let Some(c) = &pp.collar
                && (seg_dist2(x, y, &c[0]).0 < 0.017 * 0.017 || seg_dist2(x, y, &c[1]).0 < 0.017 * 0.017)
            {
                return part::COLLAR;
            }
            part::SUIT
        }
        FORE => {
            if bu > 0.88 {
                part::WRAP
            } else if bu > 0.5 {
                part::PLATE
            } else {
                part::SUIT
            }
        }
        THIGH => part::PANTS,
        HAND => part::WRAP,
        SHIN => {
            let feet = match (sk[j::LEFT_ANKLE], sk[j::RIGHT_ANKLE]) {
                (Some(l), Some(r)) => y < l[1].max(r[1]) - 0.01,
                _ => false,
            };
            if bu > 0.97 || feet {
                return part::FOOT;
            }
            // diagonal wraps along the shin
            let along = bu * bs[5];
            let ux = (bs[2] - bs[0]) / bs[5];
            let uy = (bs[3] - bs[1]) / bs[5];
            let across = (x - bs[0]) * -uy + (y - bs[1]) * ux;
            if bu < 0.15 {
                return part::SUIT;
            }
            if ((along + across * 0.7) / 0.032).floor() as i64 % 2 == 0 { part::WRAP } else { part::WRAP2 }
        }
        NECK => part::HOOD,
        _ => part::SUIT,
    }
}

/// The costume for every covered cell: cell (slots, `aw` wide), part and shade (out), bbox ([x0, y0,
/// x1, y1]: where the people are), preps (per slot), inv (m per cell), top (wall y of row 0). Cells
/// of a person without a skeleton are all suit.
#[allow(clippy::too_many_arguments)]
pub fn dress(cell: &[u8], part_out: &mut [u8], shade_out: &mut [u8], aw: usize, bbox: [i32; 4], preps: &[Prep], inv: f64, top: f64, last: &mut u8) {
    if aw == 0 {
        return;
    }
    let ah = (cell.len() / aw) as i32;
    // the body in blocks of 2 x 2 cells (the bones are the costly part, and 2 cells are plenty for
    // the suit, the wraps and the shading); the fine things (the head with its eye slit, the belt
    // knot) per cell
    let mut by = bbox[1];
    while by <= bbox[3] {
        let mut bx = bbox[0];
        while bx <= bbox[2] {
            let mut done = 0u8;
            let mut body_part = 0u8;
            let mut body_shade = 0u8;
            for k in 0..4 {
                let cx = bx + (k & 1);
                let cy = by + (k >> 1);
                if cx > bbox[2] || cy > bbox[3] || cy >= ah || cx < 0 || cy < 0 {
                    continue;
                }
                let c = cy as usize * aw + cx as usize;
                let Some(&s) = cell.get(c) else { continue };
                if s == 0 {
                    continue;
                }
                let (pt, sh) = match preps.get(usize::from(s)).filter(|p| p.on) {
                    None => (part::SUIT, shade::BASE),
                    Some(pp) => match classify_fine(pp, (f64::from(cx) + 0.5) * inv, top - (f64::from(cy) + 0.5) * inv) {
                        Some((f, sh)) => {
                            *last = sh;
                            (f, sh)
                        }
                        None => {
                            if done != s {
                                done = s;
                                body_part = classify(pp, f64::from(bx + 1) * inv, top - f64::from(by + 1) * inv, last);
                                body_shade = *last;
                            }
                            (body_part, body_shade)
                        }
                    },
                };
                if let (Some(p), Some(q)) = (part_out.get_mut(c), shade_out.get_mut(c)) {
                    *p = pt;
                    *q = sh;
                }
            }
            bx += 2;
        }
        by += 2;
    }
}
