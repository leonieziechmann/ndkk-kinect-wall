//! The game's pixel layer (art pixels, crisp) and the lights it casts on the floor (draw.js, for
//! render.rs). Retro sprites, lit like a modern game: everything that glows also lights the map
//! around it.
//!
//! Everything says "seen from above": the light comes from the top left (bright top-left edges, dark
//! bottom-right ones), everything that is up in the air casts a shadow to the bottom right, the
//! people are top-down figures (shoulders, head, feet stepping out when they walk) leaving footprints,
//! the invaders are creatures seen from above facing the city, the city is a night satellite picture
//! (streets with lamps, cars driving, roofs with shadows, parks, a dome).

use std::f64::consts::PI;

use super::body::Bodies;
use super::city::{TOWER, WALL};
use super::game::{BEAM, EMBER, EdgeLaser, Game, InvCol, PState, RED, SHIELD, SLOTS, ShipState, Target, Unit};
use super::pixels::{ARM, ART, BLACK, CELL_BODY, CELL_HEAD, PERSON_H, PERSON_UNIT, POWER_COLORS, Paint, Pix, Power, Rgb, SHIP, SHIP_H, SHIP_W, Sprite, UFO_H, UFO_W, WHITE, facing, hash, hex, jr, mix, neon, scale};
use super::render::MAX_LIGHTS;
use super::{JumpHint, Layout, P};

const BULLET: Rgb = hex(0xff6a2a);
const RUBBLE: Rgb = hex(0x1c1230);
const HULL: Rgb = hex(0x6a1650);
const HULL_EDGE: Rgb = hex(0xe0409e);
const ENGINE: Rgb = hex(0x5ff0ff);
const SHIP_WINDOW: Rgb = hex(0xffd0f0);
const LASER: Rgb = hex(0xff4a1f);

/// glowing embers cool from orange through deep red and magenta to the dark violet rubble (never brown)
fn ember(heat: f64) -> Rgb {
    let h = heat.clamp(0.0, 1.0);
    if h > 0.6 {
        return mix([0.95, 0.12, 0.3], [1.0, 0.45, 0.1], (h - 0.6) / 0.4);
    }
    if h > 0.25 {
        return mix([0.45, 0.06, 0.32], [0.95, 0.12, 0.3], (h - 0.25) / 0.35);
    }
    mix(RUBBLE, [0.45, 0.06, 0.32], h / 0.25)
}

/// corner brackets around a target: what is being aimed at
fn reticle(pix: &mut Pix, x0b: f64, y0b: f64, w: f64, h: f64, col: Rgb, t: f64) {
    let g = 2.0 + ((t * 8.0).floor() % 2.0);
    let x0 = x0b - g;
    let y0 = y0b - g;
    let x1 = x0b + w + g - 1.0;
    let y1 = y0b + h + g - 1.0;
    for (x, y, dx, dy) in [(x0, y0, 1.0, 1.0), (x1, y0, -1.0, 1.0), (x0, y1, 1.0, -1.0), (x1, y1, -1.0, -1.0)] {
        pix.put(x, y, col, 1.0, 1.0);
        pix.put(x + dx, y, col, 1.0, 1.0);
        pix.put(x, y + dy, col, 1.0, 1.0);
    }
}

/// an ellipse outline; dashes > 0 leaves gaps (a turning ring of `dashes` arcs)
#[allow(clippy::too_many_arguments)]
fn ellipse(pix: &mut Pix, cx: f64, cy: f64, rx: f64, ry: f64, col: Rgb, a: f64, dashes: f64, turn: f64) {
    let n = (PI * 2.0 * rx.max(ry) * 1.5).ceil();
    if !(n > 0.0 && n <= 100_000.0 && a > 0.004) {
        return;
    }
    let paint = Paint::new(col, a);
    let (mut lx, mut ly) = (f64::NAN, f64::NAN);
    let n_i = n as i64;
    for k in 0..n_i {
        let ang = (k as f64 / n) * PI * 2.0;
        if dashes != 0.0 && (((ang + turn) / (PI * 2.0)) * dashes * 2.0).floor() as i64 % 2 != 0 {
            continue;
        }
        let x = jr(cx + rx * ang.cos());
        let y = jr(cy + ry * ang.sin());
        if x == lx && y == ly {
            continue;
        }
        lx = x;
        ly = y;
        pix.put_p(x, y, &paint, 1.0);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Hint {
    Full,
    Arrow,
}

/// The jump hint for a unit whose boost is ready: Full (figure and arrow) until its first boost,
/// Arrow (only an arrow) after that, None when not ready or switched off.
fn jump_hint(p: &P, active: bool, charge: f64, ready_at: f64, uses: u32, t: f64) -> Option<Hint> {
    if !p.jump_boost || p.jump_hint == JumpHint::Off || active || charge < 1.0 || t - ready_at < 0.5 {
        return None;
    }
    if p.jump_hint == JumpHint::Always || uses == 0 {
        return Some(Hint::Full);
    }
    Some(Hint::Arrow)
}

/// the corners of a pointy-top hexagon, clockwise from the top
fn hex_points(cx: f64, cy: f64, rx: f64, ry: f64) -> [[f64; 2]; 6] {
    std::array::from_fn(|k| {
        let ang = (PI / 180.0) * (60.0 * k as f64 - 90.0);
        [cx + rx * ang.cos(), cy + ry * ang.sin()]
    })
}

/// the point at u (0..1) along the hexagon's outline, clockwise from the top
fn hex_at(cx: f64, cy: f64, rx: f64, ry: f64, u: f64) -> [f64; 2] {
    let pts = hex_points(cx, cy, rx, ry);
    let f = (u * 6.0).clamp(0.0, 5.9999);
    let k = f.floor() as usize;
    let [x0, y0] = pts[k % 6];
    let [x1, y1] = pts[(k + 1) % 6];
    [x0 + (x1 - x0) * (f - k as f64), y0 + (y1 - y0) * (f - k as f64)]
}

/// the hexagon's outline from the top, clockwise, as far as u (0..1): a bent power bar
#[allow(clippy::too_many_arguments)]
fn hex_arc(pix: &mut Pix, cx: f64, cy: f64, rx: f64, ry: f64, u: f64, col: Rgb, a: f64) {
    if u.is_nan() || u <= 0.0 {
        return;
    }
    let pts = hex_points(cx, cy, rx, ry);
    let f = (u * 6.0).min(6.0);
    let n = f.ceil() as usize;
    for k in 0..n.min(6) {
        let [x0, y0] = pts[k];
        let [x1, y1] = pts[(k + 1) % 6];
        let e = (f - k as f64).min(1.0);
        pix.line(x0, y0, x0 + (x1 - x0) * e, y0 + (y1 - y0) * e, col, a, 1, 1.0);
    }
}

/// a pointy-top hexagon (like the map's tiles): outline, corner posts and a faint fill
#[allow(clippy::too_many_arguments)]
fn hexagon(pix: &mut Pix, cx: f64, cy: f64, rx: f64, ry: f64, col: Rgb, a: f64, fill: f64) {
    let pts = hex_points(cx, cy, rx, ry);
    if fill > 0.0 {
        let mut y = (cy - ry).floor();
        while y <= cy + ry {
            let mut x = (cx - rx).floor();
            while x <= cx + rx {
                let u = (x - cx).abs() / rx;
                let v = (y - cy).abs() / ry;
                if u <= 0.866 && v <= 1.0 - u * 0.577 {
                    pix.put(x, y, col, fill, 1.0);
                }
                x += 1.0;
            }
            y += 1.0;
        }
    }
    for k in 0..6 {
        let [x0, y0] = pts[k];
        let [x1, y1] = pts[(k + 1) % 6];
        pix.line(x0, y0, x1, y1, col, a, 1, 1.0);
        pix.rect(jr(x0) - 1.0, jr(y0) - 1.0, 2.0, 2.0, mix(col, WHITE, 0.5), a);
    }
}

/// An invader seen from above: lit from the top left (bright top-left edges, dark bottom-right
/// ones), missing pixels where it is cracked, glowing eyes at its front. flip: facing left.
#[allow(clippy::too_many_arguments)]
fn invader(pix: &mut Pix, f: &Sprite, x: f64, y: f64, col: Rgb, eye: Option<Rgb>, crack: f64, seed: f64, flip: bool, eyes: &[(i32, i32)]) {
    let lit = Paint::new(mix(col, WHITE, 0.4), 1.0);
    let dark = Paint::new(scale(col, 0.55), 1.0);
    let base = Paint::new(col, 1.0);
    let (w, h) = (f.w as i64, f.h as i64);
    let at = |i: i64, j: i64| i >= 0 && j >= 0 && i < w && j < h && f.at(if flip { (w - 1 - i) as usize } else { i as usize }, j as usize);
    for j in 0..h {
        for i in 0..w {
            if !at(i, j) {
                continue;
            }
            if crack > 0.0 && hash(seed * 97.0 + (j * 13 + i) as f64) < crack {
                continue;
            }
            let k = if !at(i, j - 1) || !at(i - 1, j) {
                &lit
            } else if !at(i, j + 1) || !at(i + 1, j) {
                &dark
            } else {
                &base
            };
            pix.put_p(x + i as f64, y + j as f64, k, 1.0);
        }
    }
    if let Some(eye) = eye {
        for &(ex, ey) in eyes {
            let ex = i64::from(ex);
            pix.put(x + (if flip { w - 1 - ex } else { ex }) as f64, y + f64::from(ey), eye, 1.0, 1.0);
        }
    }
}

/// the battleship: hull with lit edges, windows, engines; the emitter glows while it charges
#[allow(clippy::too_many_arguments)]
fn ship(pix: &mut Pix, x0: f64, y0: f64, flash: f64, hp: f64, hp_max: f64, t: f64, charge: f64) {
    let hit = t - flash < 0.06;
    let worn = 1.0 - hp / hp_max;
    for (j, row) in SHIP.iter().map(|r| r.as_bytes()).enumerate() {
        for (i, &ch) in row.iter().enumerate() {
            if ch == b'.' {
                continue;
            }
            let (fi, fj) = (i as f64, j as f64);
            let col = match ch {
                b'#' => {
                    let edge = j == 0 || i == 0 || row.get(i - 1) == Some(&b'.') || SHIP.get(j - 1).and_then(|r| r.as_bytes().get(i)) == Some(&b'.');
                    let mut c = if edge { HULL_EDGE } else { HULL };
                    if worn > 0.3 && hash(fi * 31.0 + fj * 7.0) < worn * 0.4 {
                        c = mix(c, EMBER, 0.6 + 0.4 * (t * 12.0 + fi).sin());
                    }
                    c
                }
                b'o' => {
                    if hash(fi + (t * 2.0 + fj).floor()) > 0.3 {
                        SHIP_WINDOW
                    } else {
                        HULL
                    }
                }
                b'=' => scale(ENGINE, 0.7 + 0.3 * (t * 30.0 + fi).sin()),
                _ => mix(BEAM, WHITE, charge),
            };
            pix.put(x0 + fi, y0 + fj, if hit { WHITE } else { col }, 1.0, 1.0);
        }
    }
}

/// a thick beam from a to b: a white core, a colored mantle, edges that flicker
#[allow(clippy::too_many_arguments)]
fn beam(pix: &mut Pix, x0: f64, y0: f64, x1: f64, y1: f64, half: f64, col: Rgb, seed: f64) {
    let dx = x1 - x0;
    let dy = y1 - y0;
    let along = dx.abs() >= dy.abs();
    let nz = |v: f64| if v != 0.0 { v } else { 1e-6 };
    let m = if along { dy / nz(dx) } else { dx / nz(dy) };
    let ext = half * (1.0 + m * m).sqrt();
    let (a0, a1) = if along { (x0, x1) } else { (y0, y1) };
    let lim = f64::from(if along { pix.w - 1 } else { pix.h - 1 });
    let start = a0.min(a1).floor().max(0.0);
    let end = lim.min(a0.max(a1));
    if !(start.is_finite() && end.is_finite()) {
        return;
    }
    let side = mix(WHITE, col, 0.5);
    let mut u = start;
    while u <= end {
        let c = (if along { y0 } else { x0 }) + m * (u - a0);
        let e = (ext + (hash(u * 3.0 + seed) - 0.5) * 1.4).max(0.5);
        let mut v = (c - e).floor();
        while v <= c + e {
            let d = (v - c).abs() / e;
            let k = if d < 0.3 { WHITE } else { mix(side, col, (d - 0.3) / 0.7) };
            let a = if d < 0.8 { 1.0 } else { 0.55 };
            if along {
                pix.put(u, v, k, a, 1.0);
            } else {
                pix.put(v, u, k, a, 1.0);
            }
            v += 1.0;
        }
        u += 1.0;
    }
}

/// How each person looks this frame (color, blinking when stunned): by slot.
#[derive(Clone, Copy)]
pub struct Look {
    pub col: Rgb,
    pub a: f64,
    /// the player state (index into game.players)
    pub s: Option<usize>,
    pub lift: f64,
    pub firing: bool,
}

pub type Looks = [Option<Look>; SLOTS];

pub fn looks(game: &Game, people: &[Unit], out: &mut Looks) {
    *out = [None; SLOTS];
    let t = game.time;
    let party = t < game.party;
    for pp in people {
        let si = game.state_index(pp.id);
        let s = si.and_then(|i| game.players.get(i)).map(|x| &x.1);
        let mut col = if party { neon(t * 0.7 + f64::from(pp.slot) * 0.13) } else { pp.col };
        let mut a = 1.0;
        if let Some(s) = s {
            if t - s.hit_at < 0.12 {
                col = WHITE;
            } else if t < s.stun_until {
                col = mix(col, RED, 0.65);
                a = if (t * 10.0).floor() % 2.0 != 0.0 { 0.35 } else { 1.0 };
            }
        }
        // a jump that was seen: the unit hops (in this top-down view: lifted up, its shadow stays below)
        let ju = s.map_or(9.0, |s| (t - s.jump_at) / 0.35);
        let lift = if (0.0..1.0).contains(&ju) { jr((PI * ju).sin() * 5.0) } else { 0.0 };
        let firing = s.is_some_and(|s| pp.arms.iter().any(|arm| t - s.fired(arm.id) < 0.12));
        if let Some(o) = out.get_mut(usize::from(pp.slot)) {
            *o = Some(Look { col, a, s: si, lift, firing });
        }
    }
}

fn state<'a>(game: &'a Game, lk: &Look) -> Option<&'a PState> {
    lk.s.and_then(|i| game.players.get(i)).map(|x| &x.1)
}

/// A person seen from above, a classic top-down figure (a pixel sprite, pixels.rs PERSON), turned
/// the way the body is turned (pp.face): a shadow to the bottom right, feet that step out in the
/// direction of walking (both peek out in front when standing), arms stretched out where the masks
/// show them, shoulders, arms at the sides, the head a little to the front, a dark rim. The light
/// stays at the top left however the figure turns.
fn figure(pix: &mut Pix, pp: &Unit, lk: &Look, s: Option<&PState>) {
    let [cx0, cy0] = pp.center;
    let cx = cx0;
    let cy = cy0 - lk.lift;
    let (f, r) = facing(pp.face);
    let a = lk.a;
    let u = PERSON_UNIT; // half blocks: rounder
    let g = ART.person_turned(pp.face);
    let x0 = cx - g.ox * u;
    let y0 = cy - g.oy * u;
    // the shadow, to the bottom right (it stays on the floor when the figure hops)
    let shadow = Paint::new(BLACK, 0.5);
    for j in 0..g.h {
        for i in 0..g.w {
            if g.at(i, j) != 0 {
                pix.put_p(cx0 - g.ox * u + f64::from(i) * u + 1.5, cy0 - g.oy * u + f64::from(j) * u + 2.0, &shadow, u);
            }
        }
    }
    // the feet: they step out in the direction of walking; standing, both peek out in front
    let shoe = scale(lk.col, 0.4);
    let walking = s.is_some_and(|s| s.speed > 0.15);
    let dir = match s.and_then(|s| s.dir) {
        Some(d) if walking => d,
        _ => f,
    };
    let dn = match dir[0].hypot(dir[1]) {
        n if n > 0.0 => n,
        _ => 1.0,
    };
    let stride = if walking { s.map_or(0.0, |s| s.phase.sin() * 3.0) } else { 0.0 };
    let toe = if walking { 0.0 } else { (PERSON_H * u) / 2.0 - 0.5 };
    for side in [-1.0, 1.0] {
        let reach = stride * side;
        let fx = cx + side * 2.0 * r[0] + (dir[0] / dn) * reach + f[0] * toe;
        let fy = cy + side * 2.0 * r[1] + (dir[1] / dn) * reach + f[1] * toe;
        pix.line(fx - f[0] * 0.65, fy - f[1] * 0.65, fx + f[0] * 0.65, fy + f[1] * 0.65, shoe, a, 2, u);
    }
    // stretched-out arms (from the masks), in the figure's proportions: a round, thick arm in the
    // sleeves' color from the shoulder, a dark rim, a light round hand at its end
    let arm_col = scale(lk.col, 0.55);
    let hand_col = mix(lk.col, WHITE, 0.45);
    for arm in &pp.arms {
        let (sx0, sy0) = (arm.from[0], arm.from[1] - lk.lift);
        let tx = arm.tip[0];
        let ty = arm.tip[1] - lk.lift;
        let n = ((tx - sx0).hypot(ty - sy0) / 0.5).ceil().max(1.0);
        if n > 10_000.0 {
            continue;
        }
        for (rr, col, al) in [(ARM.thick + 0.5, BLACK, 0.8), (ARM.thick, arm_col, 1.0)] {
            let mut k = 0.0;
            while k <= n {
                pix.disc(sx0 + ((tx - sx0) * k) / n, sy0 + ((ty - sy0) * k) / n, rr, col, al * a, u);
                k += 1.0;
            }
        }
        pix.disc(tx, ty, ARM.hand + 0.5, BLACK, 0.8 * a, u);
        pix.disc(tx, ty, ARM.hand, hand_col, a, u);
        pix.put(tx - ARM.hand * 0.5 - 0.25, ty - ARM.hand * 0.5 - 0.25, mix(hand_col, WHITE, 0.6), a, u);
    }
    // the figure: a dark rim, then shirt, arms and hair, lit from the top left
    let rim = Paint::new(BLACK, 0.8 * a);
    // per part (head, shoulders, arms): lit edge, dark edge, the tone itself
    let tones = [mix(lk.col, WHITE, 0.4), scale(lk.col, 0.72), scale(lk.col, 0.55)];
    let paints: [[Paint; 3]; 3] = std::array::from_fn(|k| [Paint::new(mix(tones[k], WHITE, 0.25), a), Paint::new(scale(tones[k], 0.7), a), Paint::new(tones[k], a)]);
    for j in -1..=g.h {
        for i in -1..=g.w {
            let ch = g.at(i, j);
            let (px, py) = (x0 + f64::from(i) * u, y0 + f64::from(j) * u);
            if ch == 0 {
                if g.at(i - 1, j) != 0 || g.at(i + 1, j) != 0 || g.at(i, j - 1) != 0 || g.at(i, j + 1) != 0 {
                    pix.put_p(px, py, &rim, u);
                }
                continue;
            }
            let part = match ch {
                CELL_HEAD => 0,
                CELL_BODY => 1,
                _ => 2,
            };
            let v = if g.at(i, j - 1) != ch || g.at(i - 1, j) != ch {
                0
            } else if g.at(i, j + 1) != ch || g.at(i + 1, j) != ch {
                1
            } else {
                2
            };
            pix.put_p(px, py, &paints[part][v], u);
        }
    }
}

/// The game's pixel layer of this frame.
#[allow(clippy::too_many_arguments)]
pub fn draw_art(pix: &mut Pix, game: &Game, body: &Bodies, l: &Layout, p: &P, inv: InvCol, people: &[Unit], look: &Looks) {
    let t = game.time;
    let party = t < game.party;
    let alarm = if t < game.alarm { (game.alarm - t) / 0.5 } else { 0.0 };
    let (sx, sy, ah) = (l.sx, l.sy, f64::from(l.ah));
    let lk_of = |slot: u8| look.get(usize::from(slot)).copied().flatten();
    let difficulty = game.difficulty();
    pix.clear();

    // ---- the city: its aerial picture (city.rs) where it stands, rubble and embers where it was hit,
    // the energy wall drawn live
    let c = &game.city;
    let wall_hit = (1.0 - (t - c.hit_at) / 0.2).max(0.0);
    let s0 = c.s;
    let x0c = jr(pix.ox + c.x0 * s0 as f64) as i64;
    let y0c = jr(pix.oy) as i64;
    for j in 0..c.h {
        // runs of living picture cells without a flash: copied from the picture row by row
        let mut run: Option<usize> = None;
        for i in 0..=c.w {
            let k = j * c.w + i;
            let kind = if i < c.w { c.alive[k] } else { 0 };
            let plain = i < c.w && kind != 0 && kind != WALL && kind != TOWER && alarm <= 0.0 && t - f64::from(c.born[k]) >= 0.35;
            if plain {
                run.get_or_insert(i);
                continue;
            }
            if let Some(r0) = run.take() {
                pix.blit_rgba(x0c + (r0 * s0) as i64, y0c + (j * s0) as i64, (i - r0) * s0, s0, &c.img8, c.img_w, r0 * s0, j * s0);
            }
            if i == c.w {
                break;
            }
            if kind == 0 {
                if c.base[k] == 0 {
                    continue;
                }
                let age = t - f64::from(c.dead_at[k]);
                let col = if age < 2.5 { ember((1.0 - age / 2.5) * (0.75 + 0.25 * (t * 13.0 + hash(k as f64) * 40.0).sin())) } else { RUBBLE };
                pix.put(c.x0 + i as f64, j as f64, col, if age < 2.5 { 1.0 } else { 0.9 }, 1.0);
                continue;
            }
            let born = t - f64::from(c.born[k]);
            let flash_b = if born < 0.35 { 1.0 - born / 0.35 } else { 0.0 };
            if kind == WALL || kind == TOWER {
                let mut col = if kind == TOWER { [0.37, 0.7, 0.94] } else { scale([0.16, 0.56, 0.85], 0.75 + 0.25 * (t * 5.0 + j as f64 * 0.35).sin()) };
                if wall_hit > 0.0 {
                    col = mix(col, WHITE, wall_hit);
                }
                if party {
                    col = neon(t * 0.6 + j as f64 * 0.02);
                }
                if alarm > 0.0 {
                    col = mix(col, RED, alarm * 0.7);
                }
                pix.put(c.x0 + i as f64, j as f64, mix(col, WHITE, flash_b), 1.0, 1.0);
                continue;
            }
            // copy this art pixel's S x S LEDs from the picture (flashing or tinted red)
            let (bx, by) = (x0c + (i * s0) as i64, y0c + (j * s0) as i64);
            for v in 0..s0 {
                for u in 0..s0 {
                    let o = ((j * s0 + v) * c.img_w + i * s0 + u) * 3;
                    let Some(px) = c.img.get(o..o + 3) else { continue };
                    let mut col = [f64::from(px[0]), f64::from(px[1]), f64::from(px[2])];
                    if flash_b > 0.0 {
                        col = mix(col, WHITE, flash_b);
                    }
                    if alarm > 0.0 {
                        col = mix(col, RED, alarm * 0.5);
                    }
                    pix.dot((bx + u as i64) as i32, (by + v as i64) as i32, col, 1.0);
                }
            }
        }
    }
    let alive_at = |ax: f64, ay: f64| {
        let i = (ax - c.x0).floor();
        let j = ay.floor();
        i >= 0.0 && j >= 0.0 && i < c.w as f64 && j < c.h as f64 && c.alive.get(j as usize * c.w + i as usize).is_some_and(|&a| a > 0)
    };
    // the energy core: ring segments turning both ways, the core pulsing
    let [crx, cry, crr] = c.core;
    if alive_at(c.x0 + crx, cry) {
        for (rr, speed, segs, col) in [(crr * 0.86, 0.9, 3, [0.5, 1.0, 1.0]), (crr * 0.52, -1.6, 2, [0.85, 0.6, 1.0])] {
            for k in 0..segs {
                let a0 = t * speed + (f64::from(k) / f64::from(segs)) * PI * 2.0;
                let mut a = a0;
                while a < a0 + 0.9 {
                    pix.put(c.x0 + crx + a.cos() * rr - 0.25, cry + a.sin() * rr - 0.25, col, 0.9, 0.5);
                    a += 0.12;
                }
            }
        }
        pix.disc(c.x0 + crx, cry, crr * 0.22 * (1.0 + 0.15 * (t * 6.0).sin()), WHITE, 0.9, 0.5);
    }
    // the conduit: light pulses run down from the core
    {
        let [cdx, cdy0, cdy1] = c.conduit;
        let len = cdy1 - cdy0;
        if len > 0.0 {
            for k in 0..3 {
                let y = cdy0 + ((t * 9.0 + (f64::from(k) * len) / 3.0) % len);
                let mut d = 0.0;
                while d < 3.0 {
                    if alive_at(c.x0 + cdx, y - d) {
                        pix.put(c.x0 + cdx - 0.25, y - d, mix([0.3, 0.95, 1.0], WHITE, 1.0 - d / 3.0), 1.0 - d / 3.5, 0.5);
                    }
                    d += 0.5;
                }
            }
        }
    }
    // hover gliders: a bright nose, a colored body, a light trail behind; only on living streets
    for car in &game.cars {
        let Some(ln) = c.lanes.get(car.lane) else { continue };
        let along = jr(car.pos);
        let across = jr(ln.at);
        let s0f = s0 as f64;
        let cell_x = if ln.vertical { (ln.at / s0f).floor() } else { (along / s0f).floor() };
        let cell_y = if ln.vertical { (along / s0f).floor() } else { (ln.at / s0f).floor() };
        if cell_x < 0.0 || cell_y < 0.0 || cell_x >= c.w as f64 || cell_y >= c.h as f64 || c.alive.get(cell_y as usize * c.w + cell_x as usize).is_none_or(|&a| a == 0) {
            continue;
        }
        let trail = s0 * 4;
        for a in 0..trail {
            let back = along - ln.dir * a as f64;
            let k = if a < 2 { WHITE } else { car.col };
            let al = if a < s0 { 1.0 } else { 0.7 * (1.0 - (a - s0) as f64 / (trail - s0) as f64) };
            for b2 in [-1.0, 0.0] {
                if a >= s0 && b2 != 0.0 {
                    continue; // the trail is thinner than the glider
                }
                let x = if ln.vertical { across + b2 } else { back };
                let y = if ln.vertical { back } else { across + b2 };
                pix.dot((x0c as f64 + x) as i32, (y0c as f64 + y) as i32, k, al);
            }
        }
    }

    // ---- scorch marks of the battleship's laser: a glowing trench that fades
    for sc in &game.scorches {
        let u = (t - sc.t0) / 4.0;
        let half = sc.w * 0.15;
        let mut y = sc.y0.floor().max(0.0);
        while y < ah {
            let fl = 0.8 + 0.2 * hash(y * 7.0 + (t * 8.0).floor());
            let mut x = jr(sc.x - half);
            while x <= sc.x + half {
                pix.put(x, y, ember((1.0 - u) * fl), 0.9 * (1.0 - u * u), 1.0);
                x += 1.0;
            }
            y += 1.0;
        }
    }
    // ---- the battleship charging: a warning stripe on the floor where it will fire
    let charge_dur = p.ship_charge / (0.9 + 0.1 * difficulty);
    if let Some(sh) = game.ship.as_ref().filter(|s| s.state == ShipState::Charge) {
        let u = (sh.state_t / charge_dur).min(1.0);
        let half = (p.beam_width * sx) / 2.0;
        let pulse = 0.5 + 0.5 * (t * (8.0 + 30.0 * u)).sin();
        let mut y = jr(sh.y + SHIP_H);
        while y < ah {
            let mut x = jr(sh.beam_x - half);
            while x <= sh.beam_x + half {
                let edge = (x - sh.beam_x).abs() > half - 1.0;
                pix.put(x, y, BEAM, if edge { 0.5 + 0.4 * pulse } else { (0.06 + 0.22 * u) * (0.5 + 0.5 * pulse) }, 1.0);
                x += 1.0;
            }
            y += 1.0;
        }
    }

    // ---- power-ups: dropped with a column of light, a turning ring, blinking before they go
    for it in &game.items {
        let age = t - it.t0;
        if it.life - age < 3.0 && (t * 8.0).floor() % 2.0 != 0.0 {
            continue;
        }
        let col = it.kind.color();
        if age < 0.35 {
            pix.line(it.x, 0.0, it.x, it.y, mix(col, WHITE, 0.5), 1.0 - age / 0.35, 1, 1.0);
        }
        let bob = jr((t * 4.0 + it.x).sin());
        let grow = (age / 0.2).min(1.0);
        ellipse(pix, it.x, it.y + bob, 6.5 * grow, 5.5 * grow, col, 0.9, 6.0, -t * 2.5);
        ellipse(pix, it.x, it.y + bob, 5.0 * grow, 4.2 * grow, col, 0.25, 0.0, 0.0);
        if grow >= 1.0 {
            pix.sprite(&ART.icons[it.kind.idx()], it.x - 3.0, it.y - 3.0 + bob, mix(col, WHITE, 0.35 + 0.25 * (t * 6.0).sin()), 1.0, false, 1.0);
        }
    }

    // ---- a jump: the shadow left on the floor, the landing ring, arrows shooting up
    for pp in people {
        let Some(lk) = lk_of(pp.slot) else { continue };
        let Some(s) = state(game, &lk) else { continue };
        let age = t - s.jump_at;
        if !(0.0..=1.0).contains(&age) {
            continue;
        }
        let [cx, cy] = pp.center;
        let r = 0.2 * p.body_scale + 0.05;
        if lk.lift > 0.0 {
            let shd = lk.lift / 5.0;
            let mut y = -r * sy;
            while y <= r * sy {
                let mut x = -r * sx;
                while x <= r * sx {
                    if (x / (r * sx)).powi(2) + (y / (r * sy)).powi(2) <= 1.0 {
                        pix.put(cx + x, cy + y + 2.0, BLACK, 0.45 * shd, 1.0);
                    }
                    x += 1.0;
                }
                y += 1.0;
            }
        }
        if age > 0.3 {
            let u = (age - 0.3) / 0.7;
            let rr = (0.3 * p.body_scale + 0.15) * (1.0 + u);
            ellipse(pix, cx, cy, rr * sx, rr * sy, mix(lk.col, WHITE, 0.5), 1.0 - u, 0.0, 0.0);
        }
        if age < 0.9 {
            let u = age / 0.9;
            let top = cy - 30.0 >= 0.0; // decided once per jump, so the arrows do not jump around
            for k in 0..3 {
                let kf = f64::from(k);
                // above the unit, or below it near the top edge of the map
                let y = if top { cy - 10.0 - age * 40.0 - kf * 7.0 } else { cy + 8.0 + kf * 7.0 };
                pix.sprite(&ART.chevron, cx - 4.0, y, mix(lk.col, WHITE, 0.8 - kf * 0.2), ((1.0 - u) * 2.0).min(1.0) * (1.0 - kf * 0.2), false, 1.0);
            }
        }
    }

    // ---- footprints: one per step, left and right, turned the way the person walked; they fade
    for f in &game.footprints {
        let u = (t - f.t0) / p.foot_life;
        let a = 0.9 * (1.0 - u).powf(1.2);
        let col = mix(f.col, WHITE, 0.3);
        let [dx, dy] = f.dir;
        // the ball of the foot (bigger) in front, the heel behind
        pix.rect(f.x + dx * 1.1 - 0.6, f.y + dy * 1.1 - 0.6, 1.2, 1.2, col, a);
        pix.rect(f.x - dx * 1.1 - 0.45, f.y - dy * 1.1 - 0.35, 0.9, 0.7, col, a * 0.8);
    }

    // ---- the people as top-down figures (or their real silhouettes, param look)
    if !p.silhouette {
        for pp in people {
            if let Some(lk) = lk_of(pp.slot) {
                figure(pix, pp, &lk, state(game, &lk));
            }
        }
    } else {
        for y in 0..body.h {
            for x in 0..body.w {
                let k = y * body.w + x;
                let s = body.slot[k];
                if s == 0 {
                    continue;
                }
                let Some(lk) = lk_of(s) else { continue };
                let h = (f64::from(body.height[k]) / 180.0).min(1.0);
                let mut col = scale(lk.col, 0.25 + 0.75 * h.powf(1.6));
                if body.kind[k] == 2 && lk.firing {
                    col = mix(col, WHITE, 0.45);
                }
                if lk.lift != 0.0 {
                    col = mix(col, WHITE, lk.lift * 0.06);
                }
                pix.put(x as f64, y as f64 - lk.lift, col, lk.a, 1.0);
            }
        }
    }
    // their base on the floor: a hexagon that is the boost energy (a bent power bar, clockwise from
    // the top): full and pulsing = ready (a jump starts the boost), used up while boosting (bright,
    // double), charged again dimly; standing still adds the fort (a faint fill and corner posts)
    for pp in people {
        let Some(lk) = lk_of(pp.slot) else { continue };
        let s = state(game, &lk);
        let [cx, cy] = pp.center;
        // the boost starts: the hexagon pops up big and snaps back
        let pop = s.map_or(0.0, |s| (1.0 - (t - s.boost.at) / 0.3).max(0.0));
        let r = (0.36 * p.body_scale + 0.1) * (1.0 + 0.6 * pop * pop);
        let rx = r * sx;
        let ry = r * sy;
        let (active, charge, ready_at, uses) = match s {
            Some(s) => (s.boost.active, s.boost.charge, s.boost.ready_at, s.boost.uses),
            None => (false, 1.0, -9.0, 0),
        };
        // ready and not used yet: the hexagon hops along with the jump hint (see below)
        let hint = jump_hint(p, active, charge, ready_at, uses, t);
        let hop = (if hint == Some(Hint::Full) && (t * 1.1) % 1.0 > 0.5 { -2.0 } else { 0.0 }) - lk.lift;
        if let Some(s) = s.filter(|s| s.fortified) {
            let u = ((t - s.fort_at) / 0.25).min(1.0);
            let grow = 1.0 + 0.4 * (1.0 - u).powi(2);
            hexagon(pix, cx, cy, rx * grow, ry * grow, lk.col, 0.0, 0.1);
            for [x, y] in hex_points(cx, cy, rx, ry) {
                pix.rect(jr(x) - 1.0, jr(y) - 1.0, 2.0, 2.0, mix(lk.col, WHITE, 0.5), lk.a);
            }
        }
        // jumped without a full hexagon: its empty track flickers
        let denied = s.is_some_and(|s| t - s.denied_at < 0.4) && (t * 20.0).floor() % 2.0 != 0.0;
        hex_arc(pix, cx, cy + hop, rx, ry, 1.0, if denied { mix(lk.col, RED, 0.6) } else { lk.col }, (if denied { 0.7 } else { 0.12 }) * lk.a);
        if pop > 0.0 {
            hex_arc(pix, cx, cy + hop, rx * 1.15, ry * 1.15, 1.0, WHITE, pop * lk.a);
        }
        let mut col = lk.col;
        let mut a = 0.4;
        if active {
            col = mix(lk.col, WHITE, 0.25 + 0.15 * (t * 20.0).sin());
            a = 1.0;
            hex_arc(pix, cx, cy, rx * 0.85, ry * 0.85, charge, col, lk.a);
        } else if charge >= 1.0 {
            let ready = (1.0 - (t - ready_at) / 0.5).max(0.0);
            col = mix(lk.col, WHITE, 0.15 + 0.15 * (t * 4.0).sin() + ready * 0.7);
            a = 0.75 + 0.25 * (t * 4.0).sin();
        }
        hex_arc(pix, cx, cy + hop, rx, ry, charge, col, a * lk.a);
        // the hint figure that was showing takes off with the boost
        if let Some(s) = s
            && s.launch_full
            && t - s.launch_at < 0.45
        {
            let u = (t - s.launch_at) / 0.45;
            pix.sprite(&ART.jump, jr(cx + rx * 0.75), jr(cy - ry - 13.0 - u * 40.0), WHITE, 1.0 - u, false, 1.0);
        }
        // the jump hint, no text: a little figure crouching and jumping, an arrow up (until the first boost)
        if let Some(hint) = hint {
            let ph = (t * 1.1) % 1.0;
            let hx = jr(cx + rx * 0.75);
            let above = cy - ry - 13.0 >= 0.0;
            let hy = jr(if above { cy - ry - 13.0 } else { cy + ry + 3.0 });
            let hcol = mix(lk.col, WHITE, 0.55);
            if hint == Hint::Full {
                let up = ph > 0.5;
                pix.sprite(if up { &ART.jump } else { &ART.crouch }, hx, hy + if up { -2.0 } else { 1.0 }, hcol, 0.95 * lk.a, false, 1.0);
                if !up && ph < 0.12 {
                    pix.put(hx, hy + 10.0, hcol, 0.6, 1.0);
                    pix.put(hx + 6.0, hy + 10.0, hcol, 0.6, 1.0);
                }
            }
            // the arrow rises and fades, again and again
            let ay = if hint == Hint::Full { hy - 5.0 - jr(ph * 3.0) } else { jr(cy - ry - 5.0 - ph * 3.0 + hop) };
            pix.sprite(&ART.arrow, if hint == Hint::Full { hx } else { jr(cx - 3.0) }, ay, hcol, (1.0 - ph) * lk.a, false, 1.0);
        }
        // the end of the bar
        if charge > 0.0 && charge < 1.0 {
            let [ex, ey] = hex_at(cx, cy, rx, ry, charge);
            pix.rect(jr(ex) - 1.0, jr(ey) - 1.0, 2.0, 2.0, if active { WHITE } else { mix(lk.col, WHITE, 0.4) }, lk.a);
        }
    }

    // ---- team lasers: a lightning beam from one color to the other, white when it cuts
    for ln in &game.links {
        let (Some(a), Some(b)) = (people.get(ln.a), people.get(ln.b)) else { continue };
        let (Some(la), Some(lb)) = (lk_of(a.slot), lk_of(b.slot)) else { continue };
        let Some(st) = game.link_state.iter().find(|q| q.0 == ln.key).map(|q| q.1) else { continue };
        let [ax, ay] = a.center;
        let [bx, by] = b.center;
        let len = (bx - ax).hypot(by - ay);
        let segs = jr(len / 7.0).max(2.0);
        let ld = if len != 0.0 { len } else { 1.0 };
        let nx = -(by - ay) / ld;
        let ny = (bx - ax) / ld;
        let flash = (1.0 - (t - st.flash) / 0.15).max(0.0);
        let born = ((t - st.born) / 0.2).min(1.0);
        let seed = (t * 20.0).floor();
        let (mut px, mut py) = (ax, ay);
        let mut k = 1.0;
        while k <= segs * born {
            let u = k / segs;
            let jit = if k < segs { (hash(seed * 13.0 + k) - 0.5) * 3.0 } else { 0.0 };
            let x = ax + (bx - ax) * u + nx * jit;
            let y = ay + (by - ay) * u + ny * jit;
            let col = mix(mix(la.col, lb.col, u), WHITE, 0.35 + 0.65 * flash);
            pix.line(px, py, x, y, col, 0.95, 1, 1.0);
            px = x;
            py = y;
            k += 1.0;
        }
    }

    // ---- invaders: they hover over the map, their shadows fall to the bottom right; they bob slowly
    let frame = game.frame_anim;
    for (si, side) in game.sides.iter().enumerate() {
        for i in 0..side.n() {
            if side.alive[i] == 0 || t < f64::from(side.spawn[i]) {
                continue;
            }
            let b = game.bx(si, i);
            pix.sprite(ART.frame(b.k, frame), b.x + 3.0, b.y + 4.0, BLACK, 0.6, side.edge > 0.0, 1.0);
        }
    }
    for d in &game.divers {
        let (f, _, flip) = ART.oriented(d.k, frame, d.vx, d.vy);
        pix.sprite(f, d.x - f.w as f64 / 2.0 + 5.0, d.y - f.h as f64 / 2.0 + 6.0, BLACK, 0.5, flip, 1.0);
    }
    if let Some(u) = &game.ufo {
        pix.sprite(&ART.ufo, u.x + 4.0, u.y + 5.0, BLACK, 0.6, false, 1.0);
    }
    for (si, side) in game.sides.iter().enumerate() {
        for i in 0..side.n() {
            if side.alive[i] == 0 || t < f64::from(side.spawn[i]) {
                continue;
            }
            let b = game.bx(si, i);
            let fi = i as f64;
            let kick = (1.0 - (t - f64::from(side.kick_at[i])) / 0.12).max(0.0);
            let bob = jr((t * 2.2 + fi * 0.9 + side.edge).sin() * 0.9);
            let x = b.x + f64::from(side.kick_x[i]) * kick;
            let y = b.y + f64::from(side.kick_y[i]) * kick + bob;
            let storming = side.in_storm[i];
            // a light wave runs through the formation on every beat, from the back to the front
            let outer = if side.edge < 0.0 { i % side.cols } else { side.cols - 1 - (i % side.cols) };
            let wave = (1.0 - (t - game.beat_at - outer as f64 * 0.04).abs() / 0.07).max(0.0);
            let mut col = if storming {
                if (t * 16.0).floor() % 2.0 != 0.0 { RED } else { WHITE }
            } else {
                mix(inv.of(b.k), WHITE, wave * 0.45)
            };
            if t < game.enemy_slow_until {
                col = mix(col, Power::Slow.color(), 0.5);
            }
            let worn = 1.0 - f64::from(side.hp[i]) / f64::from(side.hp_max[i]);
            if t - f64::from(side.flash[i]) < 0.08 || t - f64::from(side.spawn[i]) < 0.12 {
                col = WHITE;
            } else if !storming && worn > 0.0 {
                col = scale(col, 1.0 - worn * 0.35);
            }
            // eyes: bright, red when about to fire, closed now and then
            let charging = f64::from(side.charge[i]) > t;
            let blink = (t * 0.7 + hash(fi + side.edge * 50.0) * 10.0) % 4.0 < 0.12;
            let eye = if charging {
                Some(if (t * 20.0).floor() % 2.0 != 0.0 { RED } else { [1.0, 0.6, 0.4] })
            } else if blink {
                None
            } else {
                Some(mix(col, WHITE, 0.7))
            };
            invader(pix, ART.frame(b.k, frame), x, y, col, eye, worn * 0.35, fi + side.edge * 100.0, side.edge > 0.0, &ART.eyes[b.k.idx()]);
            if side.shield[i] > 0 {
                let hit_s = (1.0 - (t - f64::from(side.shield_hit[i])) / 0.15).max(0.0);
                ellipse(pix, x + b.w / 2.0, y + 4.0, b.w / 2.0 + 2.5, 6.5, mix(SHIELD, WHITE, hit_s), 0.35 + 0.2 * f64::from(side.shield[i]) + hit_s * 0.4, 8.0, t * 2.0 + fi);
            }
        }
    }
    // divers: turned into their direction of flight, afterimages behind them, blinking
    for d in &game.divers {
        let (f, eyes, flip) = ART.oriented(d.k, frame, d.vx, d.vy);
        let (hw, hh) = (f.w as f64 / 2.0, f.h as f64 / 2.0);
        let n = d.trail.len() as f64;
        for (k, &[x, y]) in d.trail.iter().enumerate() {
            pix.sprite(f, x - hw, y - hh, mix(inv.of(d.k), RED, 0.5), 0.45 * (1.0 - k as f64 / n), flip, 1.0);
        }
        let col = if t - d.flash < 0.08 {
            WHITE
        } else if (t * 10.0).floor() % 2.0 != 0.0 {
            RED
        } else {
            inv.of(d.k)
        };
        invader(pix, f, d.x - hw, d.y - hh, col, Some(RED), 0.0, 0.0, flip, eyes);
    }
    // the mothership: a saucer seen from above, its dome lit from the top left, lights running round
    if let Some(u) = &game.ufo {
        invader(pix, &ART.ufo, u.x, u.y, RED, None, 0.0, 0.0, false, &[]);
        let cx = u.x + UFO_W / 2.0 - 0.5;
        let cy = u.y + UFO_H / 2.0 - 0.5;
        for &(dx, dy) in &ART.ufo_dome {
            let (dx, dy) = (f64::from(dx), f64::from(dy));
            let lv = (1.0 - (dx - UFO_W / 2.0 + 2.0).hypot(dy - UFO_H / 2.0 + 2.0) / 5.0).max(0.0);
            pix.put(u.x + dx, u.y + dy, mix([1.0, 0.45, 0.6], WHITE, 0.25 + 0.6 * lv), 1.0, 1.0);
        }
        for k in 0..8 {
            let a = (f64::from(k) / 8.0) * PI * 2.0;
            let on = ((t * 12.0).floor() - f64::from(k) + 80.0) % 8.0 < 2.0;
            pix.put(cx + a.cos() * 6.5, cy + a.sin() * 4.2, if on { WHITE } else { [1.0, 0.6, 0.2] }, 1.0, 1.0);
        }
    }
    // mines: lobbed (a shadow on the floor, the orb above), then a warning pulse that speeds up
    for bm in &game.bombs {
        let u = (t - bm.t0) / bm.flight;
        if u < 1.0 {
            let arc = (PI * u).sin() * 7.0;
            pix.rect(jr(bm.x) - 1.0, jr(bm.y), 2.0, 1.0, BLACK, 0.5);
            pix.rect(jr(bm.x) - 1.0, jr(bm.y - arc) - 1.0, 2.0, 2.0, if (t * 16.0).floor() % 2.0 != 0.0 { WHITE } else { BULLET }, 1.0);
            continue;
        }
        let left = bm.t0 + bm.flight + bm.fuse - t;
        let rate = 2.0 + 10.0 * (1.0 - left / bm.fuse);
        let ph = (t * rate) % 1.0;
        let rx = bm.r * sx;
        let ry = bm.r * sy;
        ellipse(pix, bm.x, bm.y, rx, ry, RED, 0.35, 0.0, 0.0);
        ellipse(pix, bm.x, bm.y, rx * ph, ry * ph, mix(RED, WHITE, ph), 1.0 - ph, 0.0, 0.0);
        pix.rect(jr(bm.x) - 1.0, jr(bm.y) - 1.0, 3.0, 2.0, if ph < 0.5 { WHITE } else { RED }, 1.0);
    }
    if let Some(sh) = &game.ship {
        pix.sprite(&ART.ship, sh.x + 3.0, sh.y + 3.0, BLACK, 0.5, false, 1.0);
        let charge = match sh.state {
            ShipState::Charge => (sh.state_t / charge_dur).min(1.0),
            ShipState::Fire => 1.0,
            _ => 0.0,
        };
        ship(pix, sh.x, sh.y, sh.flash, sh.hp, sh.hp_max, t, charge);
    }

    for bm in &game.booms {
        let u = (t - bm.t0) / 0.25;
        if bm.warp {
            // a star where an invader warps in
            let r = 1.0 + u * 6.0;
            pix.line(bm.x - r, bm.y, bm.x + r, bm.y, WHITE, 1.0 - u, 1, 1.0);
            pix.line(bm.x, bm.y - r * 0.6, bm.x, bm.y + r * 0.6, WHITE, 1.0 - u, 1, 1.0);
            continue;
        }
        let f = if bm.splat { &ART.splat } else { &ART.boom };
        pix.sprite(f, bm.x - f.w as f64 / 2.0, bm.y - f.h as f64 / 2.0, bm.col, 1.0 - u * 0.5, false, 1.0);
    }

    // ---- what is being aimed at
    for pp in people {
        let Some(lk) = lk_of(pp.slot) else { continue };
        let Some(s) = state(game, &lk) else { continue };
        let auto = if s.fortified { s.auto_target } else { None };
        for tg in s.lock.iter().map(|x| x.1).chain(auto) {
            let Some(at) = game.target_pos(Some(tg)) else { continue };
            match tg {
                Target::Ufo(_) => {
                    if let Some(u) = &game.ufo {
                        reticle(pix, jr(u.x), u.y, UFO_W, UFO_H, lk.col, t);
                    }
                }
                Target::Diver(_) => reticle(pix, jr(at[0] - 5.5), jr(at[1] - 4.5), 11.0, 9.0, lk.col, t),
                Target::Ship(_) => {
                    if let Some(sh) = &game.ship {
                        reticle(pix, jr(sh.x), jr(sh.y), SHIP_W, SHIP_H, lk.col, t);
                    }
                }
                Target::Inv { side, i, .. } => {
                    let b = game.bx(side, i);
                    reticle(pix, b.x, b.y, b.w, b.h, lk.col, t);
                }
            }
        }
    }

    // ---- shock waves, debris
    for w in &game.waves {
        let u = (t - w.t0) / 0.45;
        let r = w.r * (1.0 - (1.0 - u).powi(2));
        ellipse(pix, w.x, w.y, r * sx, r * sy, mix(w.col, WHITE, 0.5), 1.0 - u, 0.0, 0.0);
        if r > 0.08 {
            ellipse(pix, w.x, w.y, (r - 0.07) * sx, (r - 0.07) * sy, w.col, (1.0 - u) * 0.7, 0.0, 0.0);
        }
    }
    for q in &game.particles {
        pix.put(q.x, q.y, q.col, 1.0 - (t - q.t0) / q.life, 1.0);
    }

    // ---- active power-ups: a shield bubble, a dot per power circling the unit
    for pp in people {
        let Some(lk) = lk_of(pp.slot) else { continue };
        let Some(s) = state(game, &lk) else { continue };
        let [cx, cy] = pp.center;
        let rr = 0.3 * p.body_scale + 0.12;
        if s.power.shield > 0 && t < s.power.shield_until {
            let hit_s = (1.0 - (t - s.shield_hit) / 0.2).max(0.0);
            hexagon(pix, cx, cy, rr * sx, rr * sy, mix(Power::Shield.color(), WHITE, hit_s), 0.6 + 0.4 * hit_s, 0.06 + 0.04 * f64::from(s.power.shield));
        }
        let mut active = [Power::Rapid; 3];
        let mut n = 0;
        for (k, until) in [(Power::Rapid, s.power.rapid), (Power::Spread, s.power.spread), (Power::Mega, s.power.mega)] {
            if t < until {
                active[n] = k;
                n += 1;
            }
        }
        for (i, k) in active.iter().take(n).enumerate() {
            let ang = t * 5.0 + (i as f64 * PI * 2.0) / n as f64;
            pix.disc(cx + ang.cos() * rr * sx, cy + ang.sin() * rr * sy, 1.2, k.color(), 1.0, 1.0);
        }
    }

    // ---- heads and hands: the bright points of every unit (the figures have their own head; their
    // hands glow only at the end of a stretched-out arm)
    let figures = !p.silhouette;
    for pp in people {
        let Some(lk) = lk_of(pp.slot) else { continue };
        if let Some(hd) = pp.head
            && !figures
        {
            pix.disc(hd[0], hd[1] - lk.lift, 2.2, mix(lk.col, WHITE, 0.75), lk.a, 1.0);
            ellipse(pix, hd[0], hd[1] - lk.lift, 3.6, 3.6, lk.col, 0.8 * lk.a, 0.0, 0.0);
        }
        let mut pts = [None; 4];
        if figures {
            for (k, a) in pp.arms.iter().take(4).enumerate() {
                pts[k] = Some(a.tip);
            }
        } else {
            pts[0] = pp.hands[0];
            pts[1] = pp.hands[1];
        }
        for h in pts.into_iter().flatten() {
            let hy = jr(h[1]) - lk.lift;
            let hx = jr(h[0]);
            pix.rect(hx - 1.0, hy - 1.0, 2.0, 2.0, WHITE, lk.a);
            for (dx, dy) in [(-2.0, -1.0), (1.0, -1.0), (-2.0, 0.0), (1.0, 0.0), (-1.0, -2.0), (0.0, -2.0), (-1.0, 1.0), (0.0, 1.0)] {
                pix.put(hx + dx, hy + dy, lk.col, 0.8 * lk.a, 1.0);
            }
        }
        let Some(s) = state(game, &lk) else { continue };
        for arm in &pp.arms {
            if t - s.fired(arm.id) < 0.06 {
                pix.disc(arm.tip[0], arm.tip[1], 2.0, WHITE, 1.0, 1.0);
            }
        }
        if t - s.fired(super::game::AUTO) < 0.06 {
            pix.disc(pp.center[0], pp.center[1], 2.0, WHITE, 1.0, 1.0);
        }
    }

    // ---- lasers from the edges: the emitter, the marked middle line, then the beam opens up
    for las in &game.edge_lasers {
        edge_laser(pix, game, las, t);
    }
    for pp in people {
        let Some(lk) = lk_of(pp.slot) else { continue };
        if let Some(m) = state(game, &lk).and_then(|s| s.mega) {
            beam(pix, m.x0, m.y0, m.x1, m.y1, m.half * (1.0 + 0.15 * (t * 40.0).sin()), pp.col, (t * 30.0).floor() + f64::from(pp.slot) * 7.0);
        }
    }

    // ---- the battleship's laser: a white core, a magenta mantle, flickering edges
    if let Some(sh) = game.ship.as_ref().filter(|s| s.state == ShipState::Fire) {
        let dur = 1.1;
        let grow = (sh.state_t / 0.08).min(1.0) * ((dur - sh.state_t) / 0.15).min(1.0);
        let half = ((p.beam_width * sx) / 2.0) * grow * (1.0 + 0.08 * (t * 50.0).sin());
        let seed = (t * 30.0).floor();
        let inner = mix(WHITE, BEAM, 0.55);
        let outer = scale(BEAM, 0.8);
        let mut y = jr(sh.y + SHIP_H - 1.0);
        while y < ah {
            let h = half + (hash(y * 3.0 + seed) - 0.5) * 2.0;
            let mut x = jr(sh.beam_x - h);
            while x <= sh.beam_x + h {
                let d = (x - sh.beam_x).abs() / h.max(1.0);
                let col = if d < 0.25 { WHITE } else { mix(inner, outer, (d - 0.25) / 0.75) };
                pix.put(x, y, col, if d < 0.8 { 1.0 } else { 0.55 }, 1.0);
                x += 1.0;
            }
            y += 1.0;
        }
    }

    // ---- shots and bullets on top
    for sh in &game.shots {
        let v = match sh.vx.hypot(sh.vy) {
            v if v > 0.0 => v,
            _ => 1.0,
        };
        let dx = sh.vx / v;
        let dy = sh.vy / v;
        if sh.big {
            // boosted: thick, longer, a white head
            pix.line(sh.x - dx * 10.0, sh.y - dy * 10.0, sh.x - dx * 2.0, sh.y - dy * 2.0, sh.col, 1.0, 2, 1.0);
            pix.rect(jr(sh.x) - 1.0, jr(sh.y) - 1.0, 2.0, 2.0, WHITE, 1.0);
        } else {
            pix.line(sh.x - dx * 7.0, sh.y - dy * 7.0, sh.x - dx * 2.0, sh.y - dy * 2.0, sh.col, 1.0, 1, 1.0);
            pix.line(sh.x - dx, sh.y - dy, sh.x, sh.y, WHITE, 1.0, 1, 1.0);
        }
    }
    for bu in &game.bullets {
        if bu.aimed {
            let on = (t * 14.0 + bu.anim).floor() % 2.0 != 0.0;
            pix.rect(jr(bu.x) - 1.0, jr(bu.y) - 1.0, 2.0, 2.0, if on { WHITE } else { BULLET }, 1.0);
            pix.put(jr(bu.x) - 2.0, jr(bu.y), BULLET, 0.7, 1.0);
            pix.put(jr(bu.x) + 1.0, jr(bu.y), BULLET, 0.7, 1.0);
        } else {
            let k = ((t * 12.0 + bu.anim).floor() % 4.0).max(0.0) as usize;
            let f = &ART.zig[k.min(3)];
            pix.sprite(f, if bu.vx > 0.0 { bu.x - 6.0 } else { bu.x }, bu.y - 1.0, BULLET, 1.0, bu.vx < 0.0, 1.0);
        }
    }
}

/// a laser from the edge: the emitter, the marked middle line, then the beam
fn edge_laser(pix: &mut Pix, game: &Game, l: &EdgeLaser, t: f64) {
    let a = t - l.t0;
    let charge = (a / l.tele).min(1.0);
    let dir = if l.x1 > l.x0 { 1.0 } else { -1.0 };
    // the emitter: a small wedge at the edge, glowing up
    let em = mix(LASER, WHITE, charge * 0.7);
    for j in -3..=3_i32 {
        for i in 0..=(3 - j.abs()) {
            pix.put(l.x0 + dir * f64::from(i) - if dir < 0.0 { 1.0 } else { 0.0 }, l.y0 + f64::from(j), em, 1.0, 1.0);
        }
    }
    let open = game.edge_open(l);
    if a < l.tele {
        // the middle line, pulsing faster; a light runs along it towards the far side
        let pulse = 0.5 + 0.5 * (t * (8.0 + 26.0 * charge)).sin();
        pix.line(l.x0, l.y0, l.x1, l.y1, LASER, 0.25 + 0.55 * charge * pulse, 1, 1.0);
        let u = (a * 1.6) % 1.0;
        for k in -2..=2_i32 {
            let uu = u + f64::from(k) * 0.006;
            pix.put(l.x0 + (l.x1 - l.x0) * uu, l.y0 + (l.y1 - l.y0) * uu, WHITE, 1.0 - f64::from(k.abs()) * 0.3, 1.0);
        }
    } else if open > 0.0 {
        beam(pix, l.x0, l.y0, l.x1, l.y1, (l.half * open).max(0.6), LASER, (t * 30.0).floor() + jr(l.y0));
    }
}

/// The lights on the floor: x, y (art px), radius (m), intensity, rgb; returns how many.
pub fn collect_lights(game: &Game, people: &[Unit], look: &Looks, p: &P, l: &Layout, out: &mut [f32]) -> usize {
    let t = game.time;
    let ah = f64::from(l.ah);
    let mut n = 0;
    let mut add = |x: f64, y: f64, r: f64, i: f64, col: Rgb| {
        if !(n < MAX_LIGHTS && i > 0.01) {
            return;
        }
        if let Some(o) = out.get_mut(n * 8..n * 8 + 7) {
            o.copy_from_slice(&[x as f32, y as f32, r as f32, i as f32, col[0] as f32, col[1] as f32, col[2] as f32]);
            n += 1;
        }
    };
    let fx = &game.fx;
    // flashes first (explosions): they matter most
    for li in &fx.lights {
        let u = (fx.time - li.t0) / li.life;
        add(li.x, li.y, li.r * (1.0 + 0.3 * u), li.i * (1.0 - u).powf(1.5), li.col);
    }
    let lk_of = |slot: u8| look.get(usize::from(slot)).copied().flatten();
    let figures = !p.silhouette;
    for pp in people {
        let Some(lk) = lk_of(pp.slot) else { continue };
        add(pp.center[0], pp.center[1], 0.9, (if figures { 0.16 } else { 0.3 }) * lk.a, lk.col);
        if let Some(hd) = pp.head
            && !figures
        {
            add(hd[0], hd[1], 0.4, 0.55 * lk.a, mix(lk.col, WHITE, 0.4));
        }
        if figures {
            for a in &pp.arms {
                add(a.tip[0], a.tip[1], 0.3, 0.7 * lk.a, lk.col);
            }
        } else {
            for h in pp.hands.iter().flatten() {
                add(h[0], h[1], 0.3, 0.7 * lk.a, lk.col);
            }
        }
        let s = lk.s.and_then(|i| game.players.get(i)).map(|x| &x.1);
        if s.is_some_and(|s| s.fortified) {
            add(pp.center[0], pp.center[1], 0.55, 0.3, lk.col);
        }
        if s.is_some_and(|s| s.boost.active) {
            add(pp.center[0], pp.center[1], 0.75, 0.55 + 0.15 * (t * 20.0).sin(), lk.col);
        }
    }
    for sh in &game.shots {
        add(sh.x, sh.y, 0.35, 0.8, sh.col);
    }
    for d in &game.divers {
        add(d.x, d.y, 0.5, 1.0, RED);
    }
    if let Some(u) = &game.ufo {
        add(u.x + UFO_W / 2.0, u.y + UFO_H / 2.0, 1.0, 1.2, RED);
    }
    for ln in &game.links {
        let (Some(a), Some(b)) = (people.get(ln.a), people.get(ln.b)) else { continue };
        let Some(st) = game.link_state.iter().find(|q| q.0 == ln.key).map(|q| q.1) else { continue };
        let flash = (1.0 - (t - st.flash) / 0.15).max(0.0);
        let (Some(la), Some(lb)) = (lk_of(a.slot), lk_of(b.slot)) else { continue };
        for u in [0.25, 0.5, 0.75] {
            add(a.center[0] + (b.center[0] - a.center[0]) * u, a.center[1] + (b.center[1] - a.center[1]) * u, 0.45, 0.5 + flash, mix(la.col, lb.col, u));
        }
    }
    for bu in &game.bullets {
        add(bu.x, bu.y, 0.25, 0.6, BULLET);
    }
    if let Some(sh) = &game.ship {
        let cx = sh.x + SHIP_W / 2.0;
        add(cx - 9.0, sh.y + 1.0, 0.5, 0.8, ENGINE);
        add(cx + 9.0, sh.y + 1.0, 0.5, 0.8, ENGINE);
        if sh.state == ShipState::Charge {
            let u = (sh.state_t / (p.ship_charge / (0.9 + 0.1 * game.difficulty()))).min(1.0);
            add(cx, sh.y + SHIP_H, 0.4 + 0.6 * u, 1.0 + 2.0 * u, BEAM);
            for k in 1..=3 {
                add(sh.beam_x, sh.y + SHIP_H + ((ah - sh.y - SHIP_H) * f64::from(k)) / 3.5, 0.5, 0.5 * u * (0.5 + 0.5 * (t * 20.0).sin()), RED);
            }
        } else if sh.state == ShipState::Fire {
            for k in 0..7 {
                add(sh.beam_x, sh.y + SHIP_H + ((ah - sh.y - SHIP_H) * f64::from(k)) / 6.0, 0.6, 1.5, BEAM);
            }
        }
    }
    for it in &game.items {
        add(it.x, it.y, 0.5, 0.6 + 0.3 * (t * 6.0).sin(), POWER_COLORS[it.kind.idx()]);
    }
    for las in &game.edge_lasers {
        let charge = ((t - las.t0) / las.tele).min(1.0);
        let open = game.edge_open(las);
        add(las.x0, las.y0, 0.4, 0.4 + charge, LASER);
        if open > 0.0 {
            for k in 0..5 {
                let kf = f64::from(k);
                add(las.x0 + ((las.x1 - las.x0) * (kf + 0.5)) / 5.0, las.y0 + ((las.y1 - las.y0) * (kf + 0.5)) / 5.0, 0.5, 1.5 * open, if k % 2 == 1 { LASER } else { WHITE });
            }
        }
    }
    for pp in people {
        let Some(lk) = lk_of(pp.slot) else { continue };
        let Some(m) = lk.s.and_then(|i| game.players.get(i)).and_then(|x| x.1.mega) else { continue };
        for k in 1..=4 {
            let kf = f64::from(k);
            add(m.x0 + m.dir[0] * kf * 25.0, m.y0 + m.dir[1] * kf * 25.0, 0.5, 1.4, pp.col);
        }
    }
    for bm in &game.bombs {
        if t - bm.t0 < bm.flight {
            add(bm.x, bm.y, 0.25, 0.8, BULLET);
        } else {
            add(bm.x, bm.y, bm.r, 0.6 + 0.6 * (t * 20.0).sin(), RED);
        }
    }
    for sc in &game.scorches {
        let u = (t - sc.t0) / 4.0;
        for k in 0..3 {
            add(sc.x, sc.y0 + ((ah - sc.y0) * (f64::from(k) + 0.5)) / 3.0, 0.45, 0.7 * (1.0 - u), BEAM);
        }
    }
    // the city: the palace, and embers where it burns
    let c = &game.city;
    for li in &c.lights {
        if !li.blink || (t * 1.5).floor() % 2.0 != 0.0 {
            add(c.x0 + li.x, li.y, li.r, li.i, li.col);
        }
    }
    let mut embers = 0;
    for &cell in c.dead.iter().rev() {
        if embers >= 6 {
            break;
        }
        let age = t - f64::from(c.dead_at.get(cell).copied().unwrap_or(-99.0));
        if age > 2.5 {
            continue;
        }
        embers += 1;
        add(c.x0 + (cell % c.w.max(1)) as f64, (cell / c.w.max(1)) as f64, 0.4, 0.8 * (1.0 - age / 2.5), ember(1.0 - age / 2.5));
    }
    if t < game.alarm {
        add(c.x0 + c.w as f64 / 2.0, c.h as f64 / 2.0, 1.2, 1.2 * ((game.alarm - t) / 0.5), RED);
    }
    n
}
