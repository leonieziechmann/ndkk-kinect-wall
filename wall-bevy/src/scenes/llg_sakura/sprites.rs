//! Hand-made pixel sprites (sprites.js): two paper lanterns (red, pale pink) and the petal animation
//! frames, in one atlas. Each sprite is a list of rows; every letter is a palette color, '.' is empty.

use super::pixel::{Pix, c::*};

const LANTERN: [&str; 15] = [
    "...kkkkk...",
    "..kKKKKKk..",
    ".rRoooooRr.",
    "rRRRRRRRRRr",
    "rRoyyYyyoRr",
    "rRRoyyyoRRr",
    "rRoyYYYyoRr",
    "rRRoyYyoRRr",
    "rRoyyYyyoRr",
    "rRRRRRRRRRr",
    ".rRoooooRr.",
    "..kKKKKKk..",
    "...kkkkk...",
    ".....K.....",
    "....KrK....",
];

fn red(ch: u8) -> u32 {
    match ch {
        b'k' => SKY0,
        b'K' => O0,
        b'r' => O1,
        b'R' => O2,
        b'o' => O3,
        b'y' => O5,
        _ => Y1,
    }
}

fn pink(ch: u8) -> u32 {
    match ch {
        b'k' => SKY0,
        b'K' => P1,
        b'r' => P3,
        b'R' => P4,
        b'o' => P5,
        b'y' => P7,
        _ => Y2,
    }
}

// petals: small (3 x 3) and near (4 x 4) frames of one flutter
fn petal(ch: u8) -> u32 {
    match ch {
        b'L' => P7,
        b'P' => P5,
        b'p' => P4,
        _ => P3,
    }
}

const SMALL: [[&str; 3]; 6] = [
    ["...", ".LP", ".Pp"],
    ["L..", ".Pp", "..."],
    [".L.", ".P.", ".p."],
    ["..L", ".P.", "p.."],
    ["...", "LPp", "..."],
    ["...", ".P.", "..."],
];
const NEAR: [[&str; 4]; 6] = [
    [".LP.", "LPPp", "PPpd", ".pd."],
    ["....", "LPPp", ".Ppd", "...."],
    [".L..", ".PP.", "..Pp", "...d"],
    ["....", ".LP.", ".Pd.", "...."],
    ["..L.", ".PP.", "Pp..", "d..."],
    ["....", "LPPd", "....", "...."],
];
/// the order of frames as a petal turns over once
pub const FLUTTER: [usize; 10] = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1];

/// A sprite in the atlas: its size (px) and uv rect.
#[derive(Clone, Copy, Debug, Default)]
pub struct Spr {
    pub w: f64,
    pub h: f64,
    pub uv: [f32; 4],
}

/// The atlas: its pixels and the sprites' rects.
pub struct Sheet {
    pub pix: Pix,
    pub lantern: [Spr; 2],
    pub small: [Spr; 6],
    pub near: [Spr; 6],
}

/// A sprite to build: its rows and its colors.
type Item = (Vec<&'static str>, fn(u8) -> u32);

/// Builds the atlas: every sprite in one row, 2 px apart.
pub fn build_atlas() -> Sheet {
    let mut items: Vec<Item> = vec![(LANTERN.to_vec(), red), (LANTERN.to_vec(), pink)];
    items.extend(SMALL.iter().map(|r| (r.to_vec(), petal as fn(u8) -> u32)));
    items.extend(NEAR.iter().map(|r| (r.to_vec(), petal as fn(u8) -> u32)));
    let mut x = 1;
    let rects: Vec<[usize; 4]> = items
        .iter()
        .map(|(rows, _)| {
            let (w, h) = (rows.first().map_or(0, |r| r.len()), rows.len());
            let r = [x, 1, w, h];
            x += w + 2;
            r
        })
        .collect();
    let mut pix = Pix::new(x, rects.iter().map(|r| r[3]).max().unwrap_or(1) + 2);
    for ((rows, colors), r) in items.iter().zip(&rects) {
        for (j, row) in rows.iter().enumerate() {
            for (k, ch) in row.bytes().enumerate() {
                if ch != b'.' {
                    pix.seti((r[0] + k) as i64, (r[1] + j) as i64, colors(ch));
                }
            }
        }
    }
    let (pw, ph) = (pix.w as f32, pix.h as f32);
    let uv = |i: usize| {
        let r = rects.get(i).copied().unwrap_or([0; 4]);
        Spr { w: r[2] as f64, h: r[3] as f64, uv: [r[0] as f32 / pw, r[1] as f32 / ph, (r[0] + r[2]) as f32 / pw, (r[1] + r[3]) as f32 / ph] }
    };
    Sheet { lantern: [uv(0), uv(1)], small: std::array::from_fn(|i| uv(2 + i)), near: std::array::from_fn(|i| uv(8 + i)), pix }
}
