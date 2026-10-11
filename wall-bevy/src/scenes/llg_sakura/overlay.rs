//! The text layer as pixel art (overlay.js), on top of everything: the school's logo rebuilt in
//! pixels (three orange arches, "LUDWIG-LEICHHARDT-" in a hand-made 5x7 font, "GYMNASIUM" as serif
//! capitals), a small Japanese line, the headline like a pixel game's title, the rotating subline,
//! and the QR code on a paper card hanging from two cords. The QR never moves.
//!
//! The browser painted it all into one canvas, again whenever the subline moved. Here it is
//! painted once per change of layout or texts (paint.rs, in a background thread) as three layers
//! the GPU stacks in the browser's drawing order: logo, kicker and headline; the subline (every
//! subline once in an atlas, the shader shows the current one at its offset); cords and card.

use std::collections::HashMap;

use tiny_skia::{FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap, Stroke, Transform};

use super::pixel::{Mask, Pix, Title, c::*, font57, grow, jr, stamp_title, text_mask};
use super::{FONT, JP_FONT, Layout, SUB_FONT};
use crate::scenes::common::qr::Qr;

/// The three sails of the logo (they recall the Sydney Opera House: Ludwig Leichhardt explored
/// Australia), each a mask of the same box: a thick band sweeping up from its foot to a pointed
/// tip, a short edge dropping on the right, a thin line inside. Coordinates from the original
/// logo, in units of the sails' height.
struct Sail {
    foot: f32,
    thick: f32,
    tip: [f32; 2],
    hook: [f32; 2],
    inner: f32,
}

const SAILS: [Sail; 3] = [
    Sail { foot: 0.0, thick: 0.2, tip: [0.96, 0.03], hook: [1.06, 0.47], inner: 0.4 },
    Sail { foot: 0.46, thick: 0.18, tip: [1.27, 0.23], hook: [1.35, 0.66], inner: 0.82 },
    Sail { foot: 0.76, thick: 0.16, tip: [1.47, 0.44], hook: [1.58, 0.9], inner: 1.08 },
];

/// Canvas 2D drawing in sail units, 6x supersampled, box-filtered and thresholded (0.45).
fn sail_mask(w: usize, h: usize, draw: impl Fn(&mut Pixmap, Transform, &Paint)) -> Mask {
    const S: usize = 6;
    let mut m = Mask::new(w, h);
    let Some(mut pm) = Pixmap::new((w * S).max(1) as u32, (h * S).max(1) as u32) else { return m };
    let mut paint = Paint::default();
    paint.set_color_rgba8(255, 255, 255, 255);
    paint.anti_alias = true;
    let k = (S * h) as f32;
    draw(&mut pm, Transform::from_scale(k, k), &paint);
    let data = pm.data();
    let cw = w * S;
    for y in 0..h {
        for x in 0..w {
            let mut sum = 0u32;
            for j in 0..S {
                for i in 0..S {
                    sum += u32::from(data[((y * S + j) * cw + x * S + i) * 4 + 3]);
                }
            }
            m.d[y * w + x] = u8::from(f64::from(sum) / (S * S * 255) as f64 >= 0.45);
        }
    }
    m
}

fn stroke(width: f32) -> Stroke {
    Stroke { width, line_cap: LineCap::Round, line_join: LineJoin::Miter, miter_limit: 10.0, ..Default::default() }
}

/// [band, line] per sail, h px high.
fn sail_masks(h: usize) -> Vec<[Mask; 2]> {
    let w = jr(h as f64 * 1.64) as usize;
    SAILS
        .iter()
        .map(|sl| {
            let [tx, ty] = sl.tip;
            let f = sl.foot;
            let band = sail_mask(w, h, |pm, tr, paint| {
                // the band: outer edge up to the tip, inner edge back down
                let mut pb = PathBuilder::new();
                pb.move_to(f, 1.0);
                pb.cubic_to(f + 0.02, 0.45, f + 0.3, ty - 0.03, tx, ty);
                pb.cubic_to(tx - 0.12, ty + 0.2, f + sl.thick + 0.01, 0.62, f + sl.thick, 1.0);
                pb.close();
                if let Some(p) = pb.finish() {
                    pm.fill_path(&p, paint, FillRule::Winding, tr, None);
                }
                // the back edge dropping from the tip
                let mut pb = PathBuilder::new();
                pb.move_to(tx - 0.02, ty + 0.02);
                pb.quad_to(sl.hook[0] - 0.02, (ty + sl.hook[1]) / 2.0 - 0.05, sl.hook[0], sl.hook[1]);
                if let Some(p) = pb.finish() {
                    pm.stroke_path(&p, paint, &stroke(0.085), tr, None);
                }
            });
            let line = sail_mask(w, h, |pm, tr, paint| {
                // the thin line inside
                let mut pb = PathBuilder::new();
                pb.move_to(sl.inner, 1.0);
                pb.cubic_to(sl.inner + 0.03, 0.62, tx - 0.2, ty + 0.24, tx - 0.07, ty + 0.13);
                if let Some(p) = pb.finish() {
                    pm.stroke_path(&p, paint, &stroke(0.05), tr, None);
                }
            });
            [band, line]
        })
        .collect()
}

/// The mask without its empty rows at the top and bottom.
pub fn trim_rows(m: &Mask) -> Mask {
    let row = |y: usize| m.d[y * m.w..(y + 1) * m.w].iter().any(|&v| v != 0);
    let (mut y0, mut y1) = (0, m.h);
    while y0 < y1 && !row(y0) {
        y0 += 1;
    }
    while y1 > y0 && !row(y1 - 1) {
        y1 -= 1;
    }
    let mut o = Mask::new(m.w, (y1 - y0).max(1));
    o.d[..(y1 - y0) * m.w].copy_from_slice(&m.d[y0 * m.w..y1 * m.w]);
    o.base = m.base - y0 as i64;
    o
}

/// The logo lockup, h art pixels high (transparent around it).
fn build_logo(h: i64) -> Pix {
    let arch_h = jr(h as f64 * 0.72).max(1.0) as usize;
    let sails = sail_masks(arch_h);
    let aw = sails.first().map_or(1, |s| s[0].w);
    let small = font57("LUDWIG-LEICHHARDT-");
    let cap_h = (h - arch_h as i64 - 3).max(7);
    let big = trim_rows(&text_mask("GYMNASIUM", "\"Times New Roman\", Georgia, serif", jr(cap_h as f64 / 0.66), 700, 0.5, 6, 1.0));
    let w = (aw + 3).max(jr(aw as f64 * 0.62) as usize + small.w + 3).max(big.w + 3);
    let mut pix = Pix::new(w, arch_h + big.h + 5);
    // sails back to front, each with a dark outline over the one behind; lit upper edge, shaded
    // lower edge
    for m in sails.iter().flatten() {
        pix.stamp(&grow(m), 0, 0, SKY0);
        for y in 0..m.h {
            for x in 0..m.w {
                if m.d[y * m.w + x] == 0 {
                    continue;
                }
                let up = y > 0 && m.d[(y - 1) * m.w + x] != 0;
                let down = y < m.h - 1 && m.d[(y + 1) * m.w + x] != 0;
                pix.seti(1 + x as i64, 1 + y as i64, if !up { O6 } else if !down { O2 } else { O4 });
            }
        }
    }
    // the name: the small line at the sails' feet, GYMNASIUM below, both to the right edge
    let wi = w as i64;
    stamp_title(&mut pix, &small, wi - small.w as i64 - 2, arch_h as i64 - small.h as i64 + 1, &Title::fill(W));
    stamp_title(&mut pix, &big, wi - big.w as i64 - 2, arch_h as i64 + 3, &Title::fill(W));
    pix
}

/// A five-petal blossom, 5 x 5.
fn blossom(pix: &mut Pix, x: i64, y: i64) {
    let rows = [".p.p.", "pPPPp", ".PyP.", "pPPPp", "..p.."];
    for (j, r) in rows.iter().enumerate() {
        for (i, ch) in r.bytes().enumerate() {
            let c = match ch {
                b'p' => P4,
                b'P' => P5,
                b'y' => Y1,
                _ => continue,
            };
            pix.seti(x + i as i64, y + j as i64, c);
        }
    }
}

/// The QR card's height below the code (the address).
pub const LABEL_H: i64 = 11;

/// The QR card: paper, the code with its quiet zone, the address with two blossoms.
fn draw_card(qr: &Qr, module: i64, quiet: i64, label: &str) -> Pix {
    let side = ((qr.size as i64 + quiet * 2) * module).max(1);
    let (w, h) = (side as usize, (side + LABEL_H) as usize);
    let mut pix = Pix::new(w, h);
    pix.rect(0.0, 0.0, w as f64, h as f64, Y2);
    // rounded corners, one pixel
    for (x, y) in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)] {
        pix.clear_px(x, y);
    }
    for y in 0..qr.size {
        for x in 0..qr.size {
            if qr.get(x, y) {
                let (px, py) = ((x as i64 + quiet) * module, (y as i64 + quiet) * module);
                pix.rect(px as f64, py as f64, module as f64, module as f64, SKY2);
            }
        }
    }
    let t = font57(label);
    let tx = jr((side as f64 - t.w as f64) / 2.0) as i64;
    let ty = side - 2;
    pix.stamp(&t, tx, ty, SKY2);
    if tx >= 9 {
        blossom(&mut pix, tx - 8, ty + 1);
        blossom(&mut pix, tx + t.w as i64 + 3, ty + 1);
    }
    pix
}

/// Card size (w, h) for a module size and quiet zone (for the layout).
pub fn card_size(qr_size: usize, module: i64, quiet: i64) -> (i64, i64) {
    let side = (qr_size as i64 + quiet * 2) * module;
    (side, side + LABEL_H)
}

/// What the overlay keeps between paintings: the card, the logo and the text masks.
#[derive(Default)]
pub struct OverlayCache {
    card: Option<(String, Pix)>,
    logo: Option<(i64, Pix)>,
    masks: HashMap<(&'static str, i64, u16, i64, String), Mask>,
}

impl OverlayCache {
    /// A text as a mask that fits max_w: too wide, squeezed a little, then smaller.
    fn text(&mut self, s: &str, font: &'static str, size: i64, weight: u16, max_w: i64) -> Mask {
        let key = (font, size, weight, max_w, s.to_string());
        if let Some(m) = self.masks.get(&key) {
            return m.clone();
        }
        if self.masks.len() > 64 {
            self.masks.clear();
        }
        let mw = max_w as f64;
        let mut size = size;
        let mut m = text_mask(s, font, size as f64, weight, 0.5, 6, 1.0);
        if m.w as f64 > mw {
            m = text_mask(s, font, size as f64, weight, 0.5, 6, (mw / m.w as f64).max(0.82));
        }
        while m.w as f64 > mw && size > 6 {
            size -= 1;
            m = text_mask(s, font, size as f64, weight, 0.5, 6, 0.82);
        }
        self.masks.insert(key, m.clone());
        m
    }
}

/// A subline in the atlas: its rect there, and where its top left goes on the art canvas before
/// the slide offset.
#[derive(Clone, Copy, Debug)]
pub struct SubSlot {
    pub at: [u32; 2],
    pub size: [u32; 2],
    pub x0: i64,
    pub y0: i64,
}

pub struct SubAtlas {
    pub pix: Pix,
    pub slots: Vec<SubSlot>,
}

/// The painted text layer.
pub struct OverlayLayers {
    /// logo, kicker, headline
    pub under: Pix,
    /// cords and the card
    pub over: Pix,
    /// the card: x0, y0, x1, y1 (art px)
    pub card: [f64; 4],
    pub subs: SubAtlas,
}

/// The texts the layer shows.
pub struct Texts<'a> {
    pub kicker: &'a str,
    pub line1: &'a str,
    pub line2: &'a str,
    pub subs: &'a [&'a str],
    pub url: &'a str,
    pub label: &'a str,
}

/// overlay.js update(): the layer at the art resolution for this layout and these texts.
pub fn paint_overlay(cache: &mut OverlayCache, aw: usize, ah: usize, l: &Layout, t: &Texts, qr: &Qr, max_side: u32) -> OverlayLayers {
    let ck = format!("{},{},{},{}", t.url, l.module, l.quiet, t.label);
    if cache.card.as_ref().is_none_or(|(k, _)| *k != ck) {
        cache.card = Some((ck, draw_card(qr, l.module, l.quiet, &t.label.to_uppercase())));
    }
    if cache.logo.as_ref().is_none_or(|(k, _)| *k != l.logo_h) {
        cache.logo = Some((l.logo_h, build_logo(l.logo_h)));
    }
    let mut under = Pix::new(aw, ah);
    let max_w = l.text_x1 - l.text_x0;
    let left = l.align_left;
    let at = |w: usize| if left { l.text_x0 } else { l.text_x1 - w as i64 };

    // the logo
    let mut y = l.logo_y;
    if let Some((_, logo)) = &cache.logo {
        let lx = if left { l.text_x0 - 2 } else { l.text_x1 - logo.w as i64 + 2 };
        under.paste(logo, lx, l.logo_y);
        y = l.logo_y + logo.h as i64 + 1;
    }

    // under the logo: the small Japanese line in pink, then the headline
    if !t.kicker.is_empty() {
        let m = trim_rows(&cache.text(t.kicker, JP_FONT, l.kick_size, 700, max_w));
        stamp_title(&mut under, &m, at(m.w), y, &Title::fill(P6));
        y += m.h as i64 + 3;
    }
    // the headline: white, then orange, each with a dark outline and a pink drop shadow
    let hs: Vec<Mask> = [t.line1, t.line2].iter().filter(|s| !s.is_empty()).map(|s| cache.text(s, FONT, l.head_size, 900, max_w - 3)).collect();
    let b1 = y + jr(l.head_size as f64 * 0.74) as i64;
    let ys = [b1, b1 + jr(l.head_size as f64 * 1.02) as i64];
    let fills = [(W, P7), (O4, O6)];
    for (i, m) in hs.iter().enumerate() {
        let title = Title { fill: fills[i].0, top: Some(fills[i].1), outline: SKY0, shadow: Some(P3), shadow_off: 2 };
        stamp_title(&mut under, m, at(m.w), ys[i] - m.base, &title);
    }

    // the sublines: each with its outline in the atlas, stacked in columns no higher than the
    // device allows; the shader slides the current one (whole pixels, as stamped)
    let max = max_side.max(64) as usize;
    let sprites: Vec<(Mask, i64, i64)> = t
        .subs
        .iter()
        .map(|s| {
            let m = cache.text(s, SUB_FONT, l.sub_size, 700, max_w);
            let (x0, y0) = (at(m.w) - 1, l.sub_y - m.base - 1);
            (m, x0, y0)
        })
        .collect();
    let mut slots = Vec::with_capacity(sprites.len());
    let (mut cx, mut cy, mut col_w, mut aw_sub, mut ah_sub) = (0usize, 0usize, 0usize, 1usize, 1usize);
    for (m, x0, y0) in &sprites {
        let (sw, sh) = ((m.w + 2).min(max), (m.h + 2).min(max));
        if cy + sh > max {
            cx += col_w;
            cy = 0;
            col_w = 0;
        }
        if cx + sw > max {
            break; // no room left (thousands of sublines)
        }
        slots.push(SubSlot { at: [cx as u32, cy as u32], size: [sw as u32, sh as u32], x0: *x0, y0: *y0 });
        cy += sh;
        col_w = col_w.max(sw);
        aw_sub = aw_sub.max(cx + col_w);
        ah_sub = ah_sub.max(cy);
    }
    let mut sub_pix = Pix::new(aw_sub, ah_sub);
    for ((m, _, _), slot) in sprites.iter().zip(&slots) {
        let (ax, ay) = (i64::from(slot.at[0]), i64::from(slot.at[1]));
        // stamp_title(fill p8): the outline one pixel around, the text over it
        let mut one = Pix::new(slot.size[0] as usize, slot.size[1] as usize);
        stamp_title(&mut one, m, 1, 1, &Title::fill(P8));
        sub_pix.paste(&one, ax, ay);
    }

    // the QR card on two cords from the top edge
    let mut over = Pix::new(aw, ah);
    let mut card = [0.0; 4];
    if let Some((_, cp)) = &cache.card {
        for fx in [0.2, 0.8] {
            let cx = jr(l.card_x as f64 + cp.w as f64 * fx);
            over.line(cx + if fx < 0.5 { -4.0 } else { 4.0 }, 0.0, cx, l.card_y as f64 - 1.0, G6);
            over.set(cx, l.card_y as f64 - 1.0, P5);
        }
        over.rect(l.card_x as f64 - 1.0, l.card_y as f64 - 1.0, cp.w as f64 + 2.0, cp.h as f64 + 2.0, SKY0);
        over.paste(cp, l.card_x, l.card_y);
        card = [l.card_x as f64, l.card_y as f64, (l.card_x + cp.w as i64) as f64, (l.card_y + cp.h as i64) as f64];
    }
    OverlayLayers { under, over, card, subs: SubAtlas { pix: sub_pix, slots } }
}
