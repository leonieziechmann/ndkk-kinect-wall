//! The mosaic of a frame (main.js drawScene): the world, the people, the things, the particles, the
//! badges and the round's numbers, drawn into the cell buffer.

use super::art::{Cells, HAIR, PANTS, Rgb, SHIRT, SHOES, SKIN, SLEEVE, SPRITES, Spr, digits, hash2, js_round, mix, rainbow, scale, text_width};
use super::game::{GOAL_W, Game, Kind, Phase, flip_of};
use super::people::Figure;
use super::{Layout, P};

const WHITE: Rgb = [255.0, 255.0, 255.0];
const RED: Rgb = [255.0, 45.0, 85.0];
const GOLD: Rgb = [255.0, 210.0, 63.0];

/// the static part of the background: a dark violet LED field with a little noise, the stars
pub struct Background {
    base: Vec<f32>,
    /// x, y, phase, rate
    stars: Vec<[f64; 4]>,
}

impl Background {
    pub fn new(l: &Layout) -> Self {
        let (gw, gh) = (i64::from(l.gw), i64::from(l.gh));
        let mut base = vec![0.0_f32; (gw * gh * 3) as usize];
        let mut stars = Vec::new();
        for y in 0..gh {
            let v = y as f64 / (gh - 1).max(1) as f64;
            let c = mix([10.0, 5.0, 26.0], [34.0, 14.0, 58.0], v);
            for x in 0..gw {
                let n = 0.82 + 0.36 * hash2(x, y);
                let o = ((y * gw + x) * 3) as usize;
                for k in 0..3 {
                    base[o + k] = (c[k] * n) as f32;
                }
                if (y as f64) < gh as f64 * 0.6 && hash2(x + 911, y + 37) < 0.022 {
                    // (the browser's 6.28, not quite 2 pi)
                    #[allow(clippy::approx_constant)]
                    let ph = hash2(x, y + 5) * 6.28;
                    stars.push([x as f64, y as f64, ph, 0.8 + hash2(y, x) * 2.5]);
                }
            }
        }
        Self { base, stars }
    }
}

/// a skyline far away: buildings with a few lit windows (height, building)
fn skyline(i: i64) -> (i64, i64) {
    let b = i.div_euclid(6);
    if i.rem_euclid(6) == 5 {
        return (0, b);
    }
    (3 + (hash2(b, 77) * 8.0).floor() as i64, b)
}

fn hills(i: i64) -> i64 {
    let i = i as f64;
    (js_round(2.6 + 1.6 * (i * 0.11).sin() + 1.1 * (i * 0.29 + 1.3).sin()) as i64).max(1)
}

fn put(cells: &mut Cells, x: i64, y: i64, c: Rgb) {
    cells.put(x as f64, y as f64, c, 1.0);
}

fn draw_world(cells: &mut Cells, game: &Game, bg: &Background, l: &Layout, p: &P, t: f64) {
    let (gw, gh, ground_row) = (i64::from(l.gw), i64::from(l.gh), i64::from(l.ground_row));
    let k = p.bg_level;
    cells.fill_from(&bg.base, k);
    for &[x, y, ph, rate] in &bg.stars {
        let a = 0.18 + 0.22 * (t * rate + ph).sin();
        cells.add(x, y, [150.0, 190.0, 255.0], a * k);
    }
    // a crescent moon
    let mx = js_round(gw as f64 * 0.62) as i64;
    let my = js_round(gh as f64 * 0.17) as i64;
    for y in -3_i64..=3 {
        for x in -3_i64..=3 {
            let (xf, yf) = (x as f64, y as f64);
            if x * x + y * y > 10 || (xf - 1.6).powi(2) + (yf + 0.8).powi(2) < 6.5 {
                continue;
            }
            put(cells, mx + x, my + y, scale([215.0, 190.0, 255.0], 0.55 * k));
        }
    }
    // far skyline and near hills, scrolling slower than the ground
    let dir = game.dir as i64;
    // (cells scrolled: far below any overflow, also after weeks)
    let scrolled = |k: f64| (game.dist * k / l.cell_mx).floor().clamp(-1e15, 1e15) as i64 * dir;
    let off1 = scrolled(0.15);
    let off2 = scrolled(0.4);
    for x in 0..gw {
        let (sh, sb) = skyline(x + off1);
        for j in 0..sh {
            let y = ground_row - 1 - j;
            let lit = j > 0 && j < sh - 1 && (x + off1) % 2 == 0 && j % 2 == 1 && hash2(sb * 13 + j, (x + off1) * 3) < 0.35;
            put(cells, x, y, scale(if lit { [120.0, 90.0, 200.0] } else { [36.0, 18.0, 74.0] }, k));
        }
        let h = hills(x + off2);
        for j in 0..h {
            put(cells, x, ground_row - 1 - j, scale(if j == h - 1 { [44.0, 40.0, 120.0] } else { [24.0, 22.0, 80.0] }, k));
        }
    }
    // the ground: a bright edge and bricks, scrolling with the game
    let off = scrolled(1.0);
    for y in ground_row..gh {
        for x in 0..gw {
            let i = x + off;
            let col = if y == ground_row {
                if i.rem_euclid(4) == 0 { [190.0, 140.0, 255.0] } else { [130.0, 80.0, 255.0] }
            } else {
                let row = y - ground_row;
                let mortar = (i + (row % 2) * 2).rem_euclid(4) == 0;
                if mortar {
                    [30.0, 12.0, 60.0]
                } else if row % 2 != 0 {
                    [74.0, 34.0, 150.0]
                } else {
                    [62.0, 28.0, 128.0]
                }
            };
            put(cells, x, y, scale(col, k));
        }
    }
}

fn part_color(f: &Figure, part: u8) -> Rgb {
    let o = &f.outfit;
    match part {
        HAIR => o.hair,
        SKIN => o.skin,
        PANTS => o.pants,
        SHOES => o.shoes,
        _ => o.shirt,
    }
}

/// someone too far away to play: a violet silhouette (dimmed outfit colors would turn olive/brown)
fn back_lum(part: u8) -> f64 {
    match part {
        HAIR => 0.55,
        SKIN => 0.95,
        SHIRT | SLEEVE => 0.8,
        PANTS => 0.6,
        SHOES => 0.5,
        _ => 0.8,
    }
}

/// the part of cell (x, y), 0 outside
fn cell(f: &Figure, l: &Layout, x: i32, y: i32) -> u8 {
    if x < 0 || y < 0 || x >= l.gw || y >= l.gh {
        return 0;
    }
    f.grid.get((y * l.gw + x) as usize).copied().unwrap_or(0)
}

fn draw_back_figure(cells: &mut Cells, f: &Figure, l: &Layout, p: &P) {
    let [c0, r0, c1, r1] = f.bbox;
    for y in r0..=r1 {
        for x in c0..=c1 {
            let part = cell(f, l, x, y);
            if part == 0 {
                continue;
            }
            let lum = back_lum(part) * (0.9 + 0.16 * hash2(i64::from(x) * 3 + i64::from(f.slot), i64::from(y) * 7));
            cells.put(f64::from(x), f64::from(y), scale([150.0, 120.0, 255.0], p.bg_people * lum), 1.0);
        }
    }
}

/// the figure (lifted by lift_rows); ghost > 0: a see-through afterimage of the jump in the shirt color
fn draw_figure(cells: &mut Cells, f: &Figure, l: &Layout, t: f64, lift_rows: i32, ghost: f64) {
    let [c0, r0, c1, r1] = f.bbox;
    if c1 < c0 {
        return;
    }
    let age = t - f.born;
    let star = t < f.star_until && (f.star_until - t > 1.5 || (t * 10.0).floor() as i64 % 2 == 0);
    let flash = t - f.hit_at < 0.1;
    let hurt = !flash && t < f.safe_until;
    if hurt && ghost == 0.0 && (t * 14.0).floor() as i64 % 2 == 0 {
        return; // flickers after a hit
    }
    let reveal = if age < 0.45 { f64::from(r1) - f64::from(r1 - r0 + 1) * (age / 0.45) } else { -1.0 }; // appears from the feet up
    for y in r0..=r1 {
        if f64::from(y) < reveal {
            continue;
        }
        let yy = y - lift_rows;
        if yy < 0 || yy >= l.gh {
            continue;
        }
        for x in c0..=c1 {
            let part = cell(f, l, x, y);
            if part == 0 {
                continue;
            }
            if ghost != 0.0 {
                cells.put(f64::from(x), f64::from(yy), scale(f.outfit.shirt, ghost), 0.9);
                continue;
            }
            // pixel-art light from above: a bright top edge, a darker bottom edge, a little grain
            let above = y > 0 && cell(f, l, x, y - 1) != 0;
            let below = y < l.gh - 1 && cell(f, l, x, y + 1) != 0;
            let mut lum = 0.9 + 0.16 * hash2(i64::from(x) * 3 + i64::from(f.slot), i64::from(y) * 7);
            if !above {
                lum *= 1.15;
            } else if !below && part != SHOES {
                lum *= 0.8;
            }
            let mut col = scale(part_color(f, part), lum);
            if star {
                col = mix(col, rainbow(t * 1.6 - f64::from(y) * 0.06 + f64::from(x) * 0.02), 0.75);
            }
            if flash {
                col = WHITE;
            } else if hurt {
                col = mix(col, RED, 0.45);
            }
            if age < 0.6 {
                col = mix(WHITE, col, (age / 0.6).min(1.0));
            }
            cells.put(f64::from(x), f64::from(yy), col, 1.0);
        }
    }
}

/// rows a figure is drawn higher than its person: the jump, or a ghost floating and bobbing
fn raised(f: &Figure, l: &Layout, t: f64) -> i32 {
    if f.alive != Some(false) {
        return f.lift_rows;
    }
    let ph = f64::from(f.id) * 1.7;
    js_round((0.22 + 0.08 * (t * 2.2 + ph).sin()) / l.cell_my) as i32 + f.lift_rows
}

/// a ghost (no lives left): the person's silhouette, pale and see-through, floating and bobbing
fn draw_ghost(cells: &mut Cells, f: &Figure, l: &Layout, t: f64) {
    let [c0, r0, c1, r1] = f.bbox;
    if c1 < c0 {
        return;
    }
    let ph = f64::from(f.id) * 1.7;
    let up = raised(f, l, t);
    let dx = js_round((t * 1.3 + ph).sin() * 1.2);
    let tail = r1 - js_round(f64::from(r1 - r0) * 0.3) as i32;
    let blink = (t * 6.0).floor() as i64;
    for y in r0..=r1 {
        let yy = y - up;
        if yy < 0 || yy >= l.gh {
            continue;
        }
        for x in c0..=c1 {
            if cell(f, l, x, y) == 0 {
                continue;
            }
            // a wavy, thinning tail at the bottom
            if y > tail && (i64::from(x) + i64::from(y) + blink) % 2 != 0 {
                continue;
            }
            let k = 0.55 + 0.15 * (t * 3.0 + f64::from(y) * 0.4).sin() - if y > tail { 0.15 } else { 0.0 };
            cells.put(f64::from(x) + dx, f64::from(yy), [170.0, 225.0, 255.0], k);
        }
    }
    if let Some([hx, hy]) = f.head_cell {
        for ex in [hx - 1, hx + 1] {
            // the eyes (as the browser, a raw index into the grid)
            let i = i64::from(hy + 2) * i64::from(l.gw) + i64::from(ex);
            if i >= 0 && f.grid.get(i as usize).is_some_and(|&v| v != 0) {
                cells.put(f64::from(ex) + dx, f64::from(hy + 2 - up), [20.0, 10.0, 50.0], 1.0);
            }
        }
    }
}

/// hearts (lives) and the crown of last round's best above a figure
fn draw_badges(cells: &mut Cells, f: &Figure, game: &Game, l: &Layout, p: &P, t: f64, crown: bool) {
    let Some([_, hy]) = f.head_cell else { return };
    let [b0, _, b1, _] = f.bbox;
    let cx = js_round(f64::from(b0 + b1) / 2.0);
    let mut y = f64::from(hy - raised(f, l, t) - 4);
    if f.alive == Some(true) && matches!(game.phase, Phase::Run | Phase::Count) && f.round == game.round {
        if let Some(heart) = SPRITES.frame(Spr::Heart, 0) {
            let mut i = 0.0;
            while i < p.lives {
                let lost = i >= f.lives;
                let just_lost = lost && i == f.lives && t - f.hit_at < 0.8;
                if !(just_lost && (t * 12.0).floor() as i64 % 2 != 0) {
                    let tint = if just_lost {
                        Some((WHITE, 1.0))
                    } else if lost {
                        Some(([60.0, 22.0, 80.0], 1.0))
                    } else {
                        None
                    };
                    cells.sprite(heart, cx - (p.lives * 4.0 - 1.0) / 2.0 + i * 4.0, y, false, tint);
                }
                i += 1.0;
            }
        }
        y -= 4.0;
    }
    if crown && let Some(cr) = SPRITES.frame(Spr::Crown, 0) {
        cells.sprite(cr, cx - 2.0, y - 1.0 + js_round((t * 5.0).sin() * 0.45), false, None);
    }
}

/// test: the bones the body parts come from, as white cells
fn draw_skeletons(cells: &mut Cells, figures: &[Figure], figs: &[usize], l: &Layout) {
    for f in figs.iter().filter_map(|&i| figures.get(i)) {
        for sg in &f.segs {
            let n = 12.0;
            let mut i = 0.0;
            while i <= n {
                let x = sg[0] + (sg[2] - sg[0]) * i / n;
                let y = sg[1] + (sg[3] - sg[1]) * i / n;
                let c = ((x * l.px_x - f64::from(l.ox)) / f64::from(l.cell_px)).floor();
                let r = f64::from(l.ground_row - 1) - (y / l.cell_my).floor() - f64::from(f.lift_rows);
                cells.put(c, r, WHITE, 1.0);
                i += 1.0;
            }
        }
    }
}

/// the score as text (digits; as String() for an odd fraction)
fn score_text<'a>(score: f64, buf: &'a mut [u8; 20], spare: &'a mut String) -> &'a [u8] {
    if score >= 0.0 && score.fract() == 0.0 && score < 1e15 {
        return digits(score as u64, buf);
    }
    spare.clear();
    use std::fmt::Write;
    let _ = write!(spare, "{score}");
    spare.as_bytes()
}

#[allow(clippy::too_many_arguments)]
pub fn draw_scene(cells: &mut Cells, figures: &[Figure], figs: &[usize], back: &[usize], game: &Game, bg: &Background, l: &Layout, p: &P, t: f64) {
    let gw = l.gw;
    draw_world(cells, game, bg, l, p, t);
    if p.bg_people > 0.0 {
        for f in back.iter().filter_map(|&i| figures.get(i)) {
            draw_back_figure(cells, f, l, p);
        }
    }
    let players = || figs.iter().filter_map(|&i| figures.get(i));

    // shadows of figures in the air on the ground edge
    for f in players() {
        if f.lift_rows <= 0 || f.alive == Some(false) {
            continue;
        }
        let [c0, _, c1, _] = f.bbox;
        let shrink = (f.lift_rows / 4).min(2);
        for x in c0 + shrink..=c1 - shrink {
            cells.put(f64::from(x), f64::from(l.ground_row), [40.0, 20.0, 90.0], 1.0);
        }
    }

    // the ghosts behind, the living in front; obstacles and items over them (they hit you)
    for f in players() {
        if f.alive == Some(false) {
            draw_ghost(cells, f, l, t);
        }
    }
    for f in players() {
        if f.alive == Some(false) {
            continue;
        }
        let h = &f.lift_hist;
        if f.lift_rows > 1 {
            let at = |back: usize| if h.len() >= back { h.get(h.len() - back).copied().unwrap_or(0) } else { 0 };
            draw_figure(cells, f, l, t, at(6), 0.16);
            draw_figure(cells, f, l, t, at(3), 0.28);
        }
        draw_figure(cells, f, l, t, f.lift_rows, 0.0);
    }

    // obstacles, coins, the star; warnings at the edge where something is about to come in
    for th in &game.things {
        let Some(fr) = th.sprite() else { continue };
        let flip = flip_of(game.dir, th.kind);
        let visible = th.c0 + fr.w > 0 && th.c0 < gw;
        if visible {
            if th.kind == Kind::Star {
                cells.sprite(fr, f64::from(th.c0), f64::from(th.r0), false, Some((rainbow(t * 2.0), 0.85)));
            } else {
                cells.sprite(fr, f64::from(th.c0), f64::from(th.r0), flip, None);
            }
        } else if th.kind == Kind::Obstacle && (t * 7.0).floor() as i64 % 2 == 0 {
            let ex = if game.dir > 0.0 { gw - 1 } else { 0 };
            let step = if game.dir > 0.0 { -1 } else { 1 };
            let mid = th.r0 + fr.h / 2;
            // a chevron pointing into the wall
            cells.put(f64::from(ex), f64::from(mid - 1), RED, 1.0);
            cells.put(f64::from(ex), f64::from(mid + 1), RED, 1.0);
            cells.put(f64::from(ex + step), f64::from(mid), RED, 1.0);
        }
    }

    // the goal: a checkered gate with a flag
    if let Some(g) = &game.goal {
        let gc = Game::col(l, g.x);
        for y in 4..l.ground_row {
            for i in 0..GOAL_W {
                cells.put(f64::from(gc + i), f64::from(y), if (y + i) % 2 != 0 { [255.0, 63.0, 208.0] } else { [240.0, 240.0, 255.0] }, 1.0);
            }
        }
        if let Some(fl) = SPRITES.frame(Spr::Flag, 0) {
            let x = if game.dir > 0.0 { gc } else { gc + GOAL_W - 1 - fl.w + 1 };
            cells.sprite(fl, f64::from(x), 0.0, game.dir < 0.0, None);
        }
    }

    // particles keep their color and blink out (fading yellow or red on violet looks brownish)
    for q in &game.particles {
        let u = (t - q.t0) / q.life;
        if u > 0.55 && ((t - q.t0) * 24.0).floor() as i64 % 2 != 0 {
            continue;
        }
        cells.put(q.x, q.y, q.col, 1.0);
    }
    if p.debug {
        draw_skeletons(cells, figures, figs, l);
    }

    // lives and crowns; at the end of a round everybody's points, the crown drops onto the best
    let ended = game.phase == Phase::End;
    let et = t - game.phase_at;
    let mut buf = [0u8; 20];
    let mut spare = String::new();
    for f in players() {
        let crowned = game.crowns.contains(&f.id) && (!ended || et > 1.2);
        draw_badges(cells, f, game, l, p, t, crowned);
        if !ended || !p.numbers {
            continue;
        }
        let Some([_, hy]) = f.head_cell else { continue };
        let Some(r) = game.results.iter().find(|q| q.id == f.id) else { continue };
        let text = score_text(r.score, &mut buf, &mut spare);
        let [b0, _, b1, _] = f.bbox;
        let cx = js_round(f64::from(b0 + b1) / 2.0);
        // above the head; the best ones' above their crown (it lies 5 rows above the head, see draw_badges)
        let crown_y = f64::from(hy - raised(f, l, t) - 5);
        let mut x = js_round(f64::from(b0 + b1) / 2.0 - f64::from(text_width(text.len(), 1)) / 2.0);
        let mut y = if r.best { crown_y - 6.0 } else { crown_y - 2.0 };
        if y < 0.0 && r.best {
            x = cx + 4.0; // no room above the crown: beside it
            y = (crown_y - 1.0).max(0.0);
        }
        y = y.max(0.0);
        let col = if r.best { if (t * 6.0).floor() as i64 % 2 != 0 { GOLD } else { WHITE } } else { f.outfit.shirt };
        cells.text(text, x, y, col, 1);
        if r.best && et <= 1.2 {
            // the crown falls from the sky onto the winner
            if let Some(cr) = SPRITES.frame(Spr::Crown, 0) {
                let u = (et / 1.2).min(1.0);
                cells.sprite(cr, cx - 2.0, js_round(-3.0 + (crown_y + 3.0) * (1.0 - (1.0 - u).powi(3))), false, None);
            }
        }
    }

    // the round: countdown, GO, the way to the goal along the top
    match game.phase {
        Phase::Count => {
            let pt = t - game.phase_at;
            let n = (3.0 - pt).ceil().clamp(1.0, 3.0) as usize;
            let cols = [WHITE, [255.0, 210.0, 63.0], [255.0, 122.0, 26.0], [255.0, 45.0, 85.0]];
            let fresh = pt - pt.floor() < 0.15;
            let x = js_round(f64::from(gw) / 2.0 - f64::from(text_width(1, 2)) / 2.0);
            cells.text(&[b'0' + n as u8], x, 1.0, if fresh { WHITE } else { cols[n] }, 2);
        }
        Phase::Run => {
            if game.round_t < 0.9 && (game.round_t * 8.0).floor() as i64 % 2 == 0 {
                cells.text(b"GO!", js_round(f64::from(gw) / 2.0 - f64::from(text_width(3, 2)) / 2.0), 2.0, [41.0, 230.0, 255.0], 2);
            }
            let x0 = 6;
            let x1 = gw - 7;
            let u = (game.round_t / p.round_secs.max(1.0)).min(1.0);
            let head = js_round(f64::from(x0) + f64::from(x1 - x0) * if game.dir > 0.0 { u } else { 1.0 - u }) as i32;
            for x in x0..=x1 {
                let done = if game.dir > 0.0 { x <= head } else { x >= head };
                cells.put(f64::from(x), 1.0, if done { [120.0, 80.0, 255.0] } else { [36.0, 18.0, 70.0] }, 1.0);
            }
            cells.put(f64::from(head), 1.0, WHITE, 1.0);
            cells.put(f64::from(head), 0.0, WHITE, 1.0);
            let fx = if game.dir > 0.0 { x1 + 1 } else { x0 - 2 };
            for j in 0..2 {
                for i in 0..2 {
                    cells.put(f64::from(fx + i), f64::from(j), if (i + j) % 2 != 0 { [255.0, 63.0, 208.0] } else { [240.0, 240.0, 255.0] }, 1.0);
                }
            }
        }
        _ => {}
    }
}
