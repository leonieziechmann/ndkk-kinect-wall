//! Where everything sits on the LED image (layout.js). Designed for the 1008 × 336 wall and scaled
//! with its height (s = H / 336), centered if the image is wider. All rects in LED pixels.
//!
//!   canopy   autumn crowns hanging from the top edge (forest.rs)
//!   hero     the contact card, top left
//!   signs    the QR codes on wooden signs stuck in the ground, a little crooked, standing in the
//!            leaf heap at the bottom right, in the wood: between the far and the mid trees
//!            (SIGN_DEPTH m from the sensor), on the ground of that depth
//!   post     the wooden signpost "Mehr von mir hier" pointing at them
//!   heap     the leaf heap around the signs' feet (heap.rs)
//!   ground   the forest floor
//!
//! The numbers are f64 and rounded like Math.round, so everything lands on the same LEDs as in the
//! browser.

pub const DESIGN_W: f64 = 1008.0;
pub const DESIGN_H: f64 = 336.0;

/// Betula, light theme (betula.app, :root)
pub mod c {
    pub const PANEL: &str = "#ffffff";
    pub const TEXT: &str = "#10151f";
    pub const TEXT2: &str = "#4b5565";
    /// rgba(15, 23, 42, 0.08)
    pub const LINE: ([u8; 3], f32) = ([15, 23, 42], 0.08);
    /// rgba(15, 23, 42, 0.15)
    pub const LINE_STRONG: ([u8; 3], f32) = ([15, 23, 42], 0.15);
    /// oklch(.53 .07 149)
    pub const ACCENT: &str = "#4e7755";
    pub const ACCENT_INK: &str = "#3b6342";
    pub const BARK: &str = "#ffffff";
    pub const BARK_INK: &str = "#10151f";
}

/// Autumn leaves: the crown color of Betula's autumn (#d6ab61) and brighter golds for the LEDs, a
/// few oranges and corals; no browns. Per color: [edge, body, light]
pub const LEAF_COLORS: [[&str; 3]; 7] = [
    ["#c9962f", "#f0bb3b", "#f7d27a"],
    ["#c0913f", "#d6ab61", "#e9cb8f"],
    ["#d6a21c", "#f5cc3c", "#fbe38a"],
    ["#d08a1a", "#f29f2a", "#f8c46f"],
    ["#cf6a1f", "#ef7926", "#f6a868"],
    ["#c4523a", "#e76444", "#f09a82"],
    ["#c8a73a", "#f2d76c", "#f8e9a8"],
];
/// how often each color is picked (golds dominate)
pub const LEAF_WEIGHTS: [f64; 7] = [5.0, 4.0, 4.0, 3.0, 2.0, 1.0, 3.0];

/// how far the signs stand from the sensor (m), and the ground there (design px from the top)
pub const SIGN_DEPTH: f64 = 2.85;
const SIGN_GROUND: f64 = 284.0;

/// Inter as on betula.app (Segoe UI where Inter is missing, as in the browser)
pub const FONT: &str = "Inter, \"Inter Variable\", \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif";

/// 6.28 as the browser scene writes it, not 2π: the same random numbers make the same wood
#[allow(clippy::approx_constant)]
pub const TURN: f64 = 6.28;

/// Math.round
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Face {
    pub x0: f64,
    pub x1: f64,
    pub y0: f64,
    pub y1: f64,
}

/// A QR sign: a board turned by `angle` around (cx, cy).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sign {
    pub cx: f64,
    pub cy: f64,
    pub angle: f64,
    pub bw: f64,
    pub bh: f64,
    pub frame: f64,
    pub label_h: f64,
    pub quiet: f64,
    /// the code: side in LEDs and module size
    pub code_size: f64,
    pub code_mod: f64,
    /// the code's middle on the wall (the heap reaches up to it)
    pub code_mid: [f64; 2],
    /// the top edge's middle (for leaves lying on it)
    pub top: [f64; 2],
    /// what nothing may cover: the label and the code with most of its quiet zone
    pub face: Face,
    /// axis-aligned box around the turned board
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Post {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub angle: f64,
    pub face: Face,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SignTree {
    pub x: f64,
    pub w: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HeapRect {
    pub x0: f64,
    pub x1: f64,
    pub base: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Layout {
    pub s: f64,
    pub w: f64,
    pub h: f64,
    /// lower end of the crowns
    pub canopy: f64,
    /// upper end of the forest floor
    pub ground: f64,
    /// the contact card's top left (its size follows its text: cards.rs)
    pub hero: [f64; 2],
    pub signs: Vec<Sign>,
    pub post: Post,
    pub sign_trees: Vec<SignTree>,
    pub heap: HeapRect,
}

/// computeLayout(W, H, p, qrSize, n): `module` the param qrModule, `qr_size` modules per side of
/// the codes (all the same), `n` the number of codes (1 or 2).
pub fn compute(width: u32, height: u32, module: f64, qr_size: usize, n: usize) -> Layout {
    let (w, h) = (f64::from(width), f64::from(height));
    let s = h / DESIGN_H;
    let ox = js_round((w - DESIGN_W * s) / 2.0);
    let x_of = |x: f64| js_round(ox + x * s);
    let y_of = |y: f64| js_round(y * s);

    // the signs: wooden boards stuck in the ground, a little crooked, at different heights. The code
    // sits on a smooth light field of the board; its module size is in LEDs (not scaled: it must
    // stay sharp), so every code has exactly the same size.
    let m = js_round(module).max(2.0);
    let code = qr_size as f64 * m;
    let quiet = 3.0 * m;
    let frame = y_of(5.0);
    let label_h = y_of(31.0);
    let board_w = code + 2.0 * quiet + 2.0 * frame;
    let board_h = frame + label_h + code + 2.0 * quiet + frame;
    let places: &[(f64, f64, f64)] = if n > 1 { &[(714.0, 266.0, -3.0), (914.0, 256.0, 2.5)] } else { &[(860.0, 264.0, -2.0)] };
    let signs: Vec<Sign> = places
        .iter()
        .take(n.max(1))
        .map(|&(pcx, bottom, deg)| {
            let angle = deg * std::f64::consts::PI / 180.0;
            let (sin, cos) = angle.sin_cos();
            let cx = x_of(pcx);
            let cy = y_of(bottom) - board_h / 2.0;
            let turn = |a: f64, b: f64| [cx + a * cos - b * sin, cy + a * sin + b * cos];
            let ly = -board_h / 2.0 + frame + label_h + quiet + code / 2.0;
            let code_mid = turn(0.0, ly);
            let top = [cx + (board_h / 2.0) * sin, cy - (board_h / 2.0) * cos];
            let ext_w = board_w * cos.abs() + board_h * sin.abs();
            let ext_h = board_w * sin.abs() + board_h * cos.abs();
            // what nothing may cover: the label and the code with most of its quiet zone (the
            // board's edges may disappear behind trees)
            let fx = code / 2.0 + quiet * 0.7;
            let y_top = -board_h / 2.0 + frame;
            let y_bot = -board_h / 2.0 + frame + label_h + quiet * 1.3 + code;
            let corners = [turn(-fx, y_top), turn(fx, y_top), turn(-fx, y_bot), turn(fx, y_bot)];
            let face = Face {
                x0: corners.iter().map(|c| c[0]).fold(f64::INFINITY, f64::min),
                x1: corners.iter().map(|c| c[0]).fold(f64::NEG_INFINITY, f64::max),
                y0: corners.iter().map(|c| c[1]).fold(f64::INFINITY, f64::min),
                y1: corners.iter().map(|c| c[1]).fold(f64::NEG_INFINITY, f64::max),
            };
            Sign {
                cx,
                cy,
                angle,
                bw: board_w,
                bh: board_h,
                frame,
                label_h,
                quiet,
                code_size: code,
                code_mod: m,
                code_mid,
                top,
                face,
                x: js_round(cx - ext_w / 2.0),
                y: js_round(cy - ext_h / 2.0),
                w: js_round(ext_w),
                h: js_round(ext_h),
            }
        })
        .collect();
    let ground = y_of(306.0);
    // the signpost left of them, its arrow pointing at the first sign
    let post_w = y_of(134.0);
    let first_x = signs.first().map(|g| g.x).unwrap_or(w * 0.8);
    let (px, py, ph) = (first_x - y_of(26.0) - post_w, y_of(176.0), y_of(24.0));
    let post = Post { x: px, y: py, w: post_w, h: ph, angle: -4.0 * std::f64::consts::PI / 180.0, face: Face { x0: px, x1: px + post_w, y0: py - y_of(6.0), y1: py + ph + y_of(6.0) } };
    // birches of the mid row standing among the signs: one between two signs, one in front of the
    // first sign's left edge (forest.rs adds them; their trunks only cover the boards' edges)
    let mut sign_trees = Vec::new();
    if let (Some(a), Some(b)) = (signs.first(), signs.get(1)) {
        sign_trees.push(SignTree { x: (a.face.x1 + b.face.x0) / 2.0, w: y_of(15.0).min(b.face.x0 - a.face.x1 - 4.0) });
    }
    if let Some(a) = signs.first() {
        sign_trees.push(SignTree { x: a.face.x0 - y_of(8.0), w: y_of(13.0) });
    }
    // the heap: from the signpost's foot to the right edge, up to the codes' middle, on the ground
    // at the signs' depth
    let heap = HeapRect { x0: post.x + js_round(post_w * 0.4), x1: w, base: y_of(SIGN_GROUND) };
    Layout { s, w, h, canopy: y_of(56.0), ground, hero: [x_of(24.0), y_of(70.0)], signs, post, sign_trees, heap }
}
