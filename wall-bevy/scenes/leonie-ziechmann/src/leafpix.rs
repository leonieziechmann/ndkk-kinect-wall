//! Birch leaves as crisp pixel art (leafpix.js), rasterized straight into an RGBA buffer (u32 per
//! LED, little-endian RGBA as the browser's Uint32Array over ImageData): a pointed oval, widest near
//! the base like a birch leaf, with a 1-LED darker edge, a light midrib and its stalk. Turning in
//! the air is a squeeze across the leaf (|flip| < 1), and its paler back shows while flip < 0.
//!
//! draw_leaf() rasterizes and draws in one go (leaves in the air change every frame); sprite()
//! keeps the pixels of a leaf that lies still, and blit() draws them again.
//!
//! style flags: STALK (draw the stalk), ROUND (a round coin leaf like an aspen's, for the flat
//! crowns), FLAT (no outline: a lit left half instead, for dense crowns that must not look noisy).

#[allow(dead_code)]
pub const STALK: u8 = 1;
pub const ROUND: u8 = 2;
pub const FLAT: u8 = 4;

const MAX: usize = 64;

/// '#rrggbb' as [r, g, b] bytes
pub fn rgb8(hex: &str) -> [u8; 3] {
    let v = u32::from_str_radix(hex.trim_start_matches('#'), 16).unwrap_or(0);
    [(v >> 16) as u8, (v >> 8) as u8, v as u8]
}

/// a pixel as little-endian RGBA u32
pub fn px(rgb: [u8; 3], a: u8) -> u32 {
    (u32::from(a) << 24) | (u32::from(rgb[2]) << 16) | (u32::from(rgb[1]) << 8) | u32::from(rgb[0])
}

/// u32(hex, a) of leafpix.js
pub fn u32_hex(hex: &str, a: u8) -> u32 {
    px(rgb8(hex), a)
}

/// A leaf color as pixels: front edge/body/rib, back edge/body. Alpha 255 marks a leaf in front of
/// the card, 254 one behind it, 253 one at the signs' depth (render.rs tells them apart).
#[derive(Clone, Copy, Debug, Default)]
pub struct Palette {
    pub edge: u32,
    pub body: u32,
    pub rib: u32,
    pub back_edge: u32,
    pub back_body: u32,
}

/// leafPalette([edge, body, light], alpha)
pub fn leaf_palette(c: [[u8; 3]; 3], alpha: u8) -> Palette {
    let [edge, body, light] = c;
    Palette { edge: px(edge, alpha), body: px(body, alpha), rib: px(light, alpha), back_edge: px(body, alpha), back_body: px(light, alpha) }
}

/// The pixels of a leaf that lies still (0 = transparent), for blit().
#[derive(Clone, Debug, Default)]
pub struct Sprite {
    pub ox: i32,
    pub oy: i32,
    pub w: usize,
    pub h: usize,
    pub px: Vec<u32>,
}

/// The rasterizer: the profiles and one mask (as the module-level mask of leafpix.js; one per
/// thread that draws).
pub struct Raster {
    profile: [f32; 257],
    profile_round: [f32; 257],
    /// 1 leaf, 2 midrib, 3 stalk, 4 lit half
    mask: Box<[u8; MAX * MAX]>,
    mw: usize,
    mh: usize,
    /// offset of the mask from the leaf's integer center
    mx: i32,
    my: i32,
}

impl Raster {
    pub fn new() -> Self {
        // the leaf's half width along its length t (0 base .. 1 tip): a birch leaf is widest at about
        // a third and pointed, a round one nearly a circle with a small tip (Float32Array values)
        let mut profile = [0f32; 257];
        let mut profile_round = [0f32; 257];
        for i in 0..=256 {
            let t = i as f64 / 256.0;
            profile[i] = (std::f64::consts::PI * t.powf(0.62)).sin() as f32;
            profile_round[i] = (std::f64::consts::PI * t.powf(0.85)).sin().max(0.0).sqrt() as f32;
        }
        Self { profile, profile_round, mask: Box::new([0; MAX * MAX]), mw: 0, mh: 0, mx: 0, my: 0 }
    }

    /// rasterizes a leaf centered at (fx, fy) relative to an integer pixel into the mask; false if
    /// empty
    fn raster(&mut self, fx: f64, fy: f64, l: f64, rot: f64, flip: f64, style: u8) -> bool {
        let stalk = style & STALK != 0;
        let round = style & ROUND != 0;
        let flat = style & FLAT != 0;
        let half = l * 0.5;
        let (sn, c) = rot.sin_cos();
        let f = flip.abs().max(0.24);
        let back = flip < 0.0;
        let hw_max = l * if round { 0.44 } else { 0.34 };
        // the box around the leaf: along -half - stalk .. half, across +-(hwMax f) (screen px)
        let a0 = -half - if stalk { 0.24 * l } else { 0.0 } - 1.0;
        let a1 = half + 1.0;
        let b = hw_max * f + 1.0;
        let ex = sn.abs() * (-a0).max(a1) + c.abs() * b;
        let ey = c.abs() * (-a0).max(a1) + sn.abs() * b;
        if !(ex.is_finite() && ey.is_finite() && fx.is_finite() && fy.is_finite()) {
            return false;
        }
        let bx = (fx - ex).floor().max(-31.0);
        let by = (fy - ey).floor().max(-31.0);
        let mw = ((fx + ex).ceil() - bx + 1.0).clamp(0.0, MAX as f64) as usize;
        let mh = ((fy + ey).ceil() - by + 1.0).clamp(0.0, MAX as f64) as usize;
        self.mw = mw;
        self.mh = mh;
        self.mx = bx as i32;
        self.my = by as i32;
        let prof = if round { &self.profile_round } else { &self.profile };
        let rib = !back && !flat && !round && l >= 8.0;
        let mut any = false;
        for j in 0..mh {
            let dy = by + j as f64 + 0.5 - fy;
            for i in 0..mw {
                let dx = bx + i as f64 + 0.5 - fx;
                let v = dx * sn + dy * c; // along the leaf: base -half, tip +half
                let w = dx * c - dy * sn; // across, on the screen
                let t = (v + half) / l;
                let mut m = 0u8;
                if (0.0..=1.0).contains(&t) {
                    let hw = hw_max * f * f64::from(prof[((t * 256.0) as usize).min(256)]);
                    if w.abs() <= hw {
                        m = if rib && w.abs() < 0.5 && t > 0.1 && t < 0.78 {
                            2
                        } else if flat && dx < -hw * 0.2 && dy < hw * 0.6 {
                            4
                        } else {
                            1
                        };
                    }
                } else if stalk && t < 0.0 && t > -0.24 && w.abs() < 0.55 {
                    m = 3;
                }
                self.mask[j * mw + i] = m;
                any |= m != 0;
            }
        }
        any
    }

    /// the color of mask pixel (i, j): the edge where a 4-neighbour is outside the leaf (not when flat)
    fn color(&self, i: usize, j: usize, pal: &Palette, back: bool, flat: bool) -> u32 {
        let (mw, mh) = (self.mw, self.mh);
        let k = j * mw + i;
        let m = self.mask[k];
        if m == 3 {
            return pal.edge;
        }
        if m == 4 {
            return if back { pal.back_body } else { pal.rib };
        }
        if flat {
            return if back { pal.back_edge } else { pal.body };
        }
        let out = i == 0 || j == 0 || i == mw - 1 || j == mh - 1 || self.mask[k - 1] == 0 || self.mask[k + 1] == 0 || self.mask[k - mw] == 0 || self.mask[k + mw] == 0;
        if out {
            return if back { pal.back_edge } else { pal.edge };
        }
        if m == 2 {
            return pal.rib;
        }
        if back { pal.back_body } else { pal.body }
    }

    /// Draws one leaf. (cx, cy): its center in pixels, l: length base to tip (px), rot: 0 = tip
    /// down, flip: -1..1 (squeeze across, < 0 = back side), style: STALK | ROUND | FLAT.
    #[allow(clippy::too_many_arguments)]
    pub fn draw_leaf(&mut self, buf: &mut [u32], w: usize, h: usize, cx: f64, cy: f64, l: f64, rot: f64, flip: f64, pal: &Palette, style: u8) {
        if !(cx.is_finite() && cy.is_finite()) {
            return;
        }
        let (ix, iy) = (cx.floor(), cy.floor());
        if !self.raster(cx - ix, cy - iy, l, rot, flip, style) {
            return;
        }
        let (ix, iy) = (ix as i64, iy as i64);
        let back = flip < 0.0;
        let flat = style & FLAT != 0;
        for j in 0..self.mh {
            let y = iy + i64::from(self.my) + j as i64;
            if y < 0 || y >= h as i64 {
                continue;
            }
            for i in 0..self.mw {
                if self.mask[j * self.mw + i] == 0 {
                    continue;
                }
                let x = ix + i64::from(self.mx) + i as i64;
                if x >= 0 && x < w as i64 {
                    let c = self.color(i, j, pal, back, flat);
                    if let Some(p) = buf.get_mut(y as usize * w + x as usize) {
                        *p = c;
                    }
                }
            }
        }
    }

    /// leafSprite(): the pixels of a leaf that lies still, into `out` (its buffer is reused).
    pub fn sprite(&mut self, out: &mut Sprite, l: f64, rot: f64, flip: f64, pal: &Palette, style: u8) {
        out.px.clear();
        if !self.raster(0.5, 0.5, l, rot, flip, style) {
            out.ox = 0;
            out.oy = 0;
            out.w = 0;
            out.h = 0;
            return;
        }
        let back = flip < 0.0;
        let flat = style & FLAT != 0;
        out.px.resize(self.mw * self.mh, 0);
        for j in 0..self.mh {
            for i in 0..self.mw {
                if self.mask[j * self.mw + i] != 0 {
                    out.px[j * self.mw + i] = self.color(i, j, pal, back, flat);
                }
            }
        }
        out.ox = self.mx;
        out.oy = self.my;
        out.w = self.mw;
        out.h = self.mh;
    }
}

/// Draws a sprite with its center at (cx, cy).
pub fn blit(buf: &mut [u32], w: usize, h: usize, cx: f64, cy: f64, spr: &Sprite) {
    if !(cx.is_finite() && cy.is_finite()) || spr.w == 0 {
        return;
    }
    let x0 = cx.floor() as i64 + i64::from(spr.ox);
    let y0 = cy.floor() as i64 + i64::from(spr.oy);
    // the sprite's columns on the image
    let i0 = (-x0).clamp(0, spr.w as i64) as usize;
    let i1 = (w as i64 - x0).clamp(0, spr.w as i64) as usize;
    if i0 >= i1 {
        return;
    }
    for j in 0..spr.h {
        let y = y0 + j as i64;
        if y < 0 || y >= h as i64 {
            continue;
        }
        let d0 = y as usize * w + (x0 + i0 as i64) as usize;
        let (Some(dst), Some(src)) = (buf.get_mut(d0..d0 + (i1 - i0)), spr.px.get(j * spr.w + i0..j * spr.w + i1)) else { continue };
        for (d, &c) in dst.iter_mut().zip(src) {
            if c != 0 {
                *d = c;
            }
        }
    }
}
