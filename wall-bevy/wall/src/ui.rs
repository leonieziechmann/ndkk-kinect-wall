//! The elements many scenes show: labels and name tags, speech bubbles, a title banner, a score
//! that counts up, a countdown, a progress bar, short messages (toasts), a QR code. All of them draw
//! through Draw (immediate: call them every frame they should be seen); the ones that animate keep
//! their state in a small struct of the scene.

use glam::Vec2;

use crate::draw::{Anchor, Color, Image, Paint, Paints, Text};
use crate::people::Body;

/// Smooth start and end (0..1 -> 0..1).
pub fn smooth(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Fast start, soft end (CSS ease-out).
pub fn ease_out(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t) * (1.0 - t) * (1.0 - t)
}

/// 0 -> 1 over `fade_in` s, 1 until `hold` s, then -> 0 over `fade_out` s (age: s since it began).
pub fn envelope(age: f32, fade_in: f32, hold: f32, fade_out: f32) -> f32 {
    if age < 0.0 {
        0.0
    } else if age < fade_in {
        smooth(age / fade_in.max(1e-3))
    } else if age < hold {
        1.0
    } else {
        1.0 - smooth((age - hold) / fade_out.max(1e-3))
    }
}

/// A visibility that eases to 1 while something holds and back to 0 when it ends (a banner while
/// nobody is there, a hint while nobody raises a hand): `let a = self.fade.update(on, f.dt());`.
#[derive(Clone, Copy, Debug)]
pub struct Fade {
    v: f32,
    /// s to come in / go out
    pub fade_in: f32,
    pub fade_out: f32,
}

impl Default for Fade {
    fn default() -> Self {
        Fade::new(0.5, 0.5)
    }
}

impl Fade {
    pub fn new(fade_in: f32, fade_out: f32) -> Self {
        Fade { v: 0.0, fade_in, fade_out }
    }

    /// Steps by `dt` s towards 1 (`on`) or 0, and returns the eased value.
    pub fn update(&mut self, on: bool, dt: f32) -> f32 {
        let step = if on { dt / self.fade_in.max(1e-3) } else { -dt / self.fade_out.max(1e-3) };
        self.v = (self.v + step).clamp(0.0, 1.0);
        self.value()
    }

    /// The eased value (0..1).
    pub fn value(&self) -> f32 {
        smooth(self.v)
    }
}

/// The elements as methods of everything that draws (a sketch's Frame, Draw): `f.banner(..)`.
pub trait Ui: Paints {
    /// A label: text in a rounded box (dark, slightly transparent), glowing in the text's color.
    fn label(&mut self, text: &str, x: f32, y: f32, size: f32, color: Color) {
        let t = Text::new(size).bold().color(color).glow(size * 0.4).background(Color::BLACK.alpha(0.45)).pad(size * 0.5, size * 0.15).radius(size * 0.35);
        self.text(text, x, y, &t);
    }

    /// A name tag above a person's head (kept on the wall), in the person's color.
    fn name_tag(&mut self, body: &Body, text: &str, size: f32) {
        let c = Color::from_rgb(body.color);
        let t = Text::new(size).bold().color(Color::WHITE).anchor(Anchor::Bottom).background(c.alpha(0.85)).pad(size * 0.5, size * 0.2).radius(size * 0.4);
        let head = body.head().unwrap_or_else(|| body.top());
        let wall = self.size();
        let tag = self.measure(text, &t);
        let s = size * 0.35;
        // above the head (not above a raised hand); the head joint is the head's centre
        let y = (head.y - body.height * 0.07 - s).clamp(tag.y, wall.y);
        let x = head.x.clamp(tag.x / 2.0, (wall.x - tag.x / 2.0).max(tag.x / 2.0));
        self.text(text, x, y, &t);
        // the little point towards the head
        let px = head.x.clamp(x - tag.x / 2.0 + s, x + tag.x / 2.0 - s);
        self.triangle(Vec2::new(px - s, y - 0.5), Vec2::new(px + s, y - 0.5), Vec2::new(px, y + s), c.alpha(0.85));
    }

    /// A speech bubble beside a person's head (right of it, or left near the right edge).
    fn bubble(&mut self, body: &Body, text: &str, size: f32) {
        let Some(head) = body.head() else { return };
        let t = Text::new(size).color(Color::BLACK).background(Color::WHITE).pad(size * 0.6, size * 0.35).radius(size * 0.6);
        let box_size = self.measure(text, &t);
        let right = head.x + size * 2.0 + box_size.x < self.size().x;
        let side = if right { 1.0 } else { -1.0 };
        let bx = head.x + side * size * 1.5;
        let by = head.y - size * 0.5;
        self.text(text, bx, by, &t.anchor(if right { Anchor::BottomLeft } else { Anchor::BottomRight }));
        // the tail towards the head
        let base = Vec2::new(bx + side * size * 0.8, by - 1.0);
        self.triangle(base, base + Vec2::new(side * size * 0.8, 0.0), Vec2::new(head.x + side * size * 0.6, head.y), Color::WHITE);
    }

    /// A title in the middle of the wall, seen by `a` (0..1: fades and rises in). For a title at the
    /// start: `envelope(f.t(), 0.6, 3.5, 0.8)`; while something holds: a Fade.
    fn banner(&mut self, title: &str, subtitle: &str, a: f32, color: Color) {
        if a <= 0.0 {
            return;
        }
        let size = self.size();
        let rise = (1.0 - ease_out(a)) * 12.0;
        let h = size.y;
        self.text(title, size.x / 2.0, h * 0.42 + rise, &Text::new(h * 0.2).weight(900).color(color.fade(a)).glow(h * 0.06).spacing(0.04));
        if !subtitle.is_empty() {
            self.text(subtitle, size.x / 2.0, h * 0.62 + rise, &Text::new(h * 0.08).color(Color::WHITE.fade(a * 0.9)).spacing(0.08));
        }
    }

    /// A countdown number that pulses each second (secs: s left), e.g. before a round starts.
    fn countdown(&mut self, secs: f32, x: f32, y: f32, size: f32, color: Color) {
        if secs <= 0.0 {
            return;
        }
        let n = secs.ceil();
        let f = n - secs;
        let s = size * (1.25 - 0.25 * ease_out(f * 3.0));
        self.text(&format!("{n}"), x, y, &Text::new(s).weight(900).color(color.fade(1.0 - smooth((f - 0.6) / 0.4))).glow(size * 0.2));
    }

    /// A progress bar: value 0..1 in a rounded track.
    fn progress(&mut self, x: f32, y: f32, w: f32, h: f32, value: f32, color: Color) {
        let r = h / 2.0;
        self.rrect(x, y, w, h, r, Paint::fill(Color::WHITE.alpha(0.12)));
        let v = value.clamp(0.0, 1.0);
        if v > 0.0 {
            self.rrect(x, y, (w * v).max(h), h, r, Paint::fill(color).glow(h * 0.6));
        }
    }

    /// A person's skeleton: lines in their color (glowing, added: light on the wall).
    fn skeleton(&mut self, body: &Body, width: f32) {
        let c = Color::from_rgb(body.color);
        for (a, z) in body.bones() {
            self.line(a.x, a.y, z.x, z.y, width, Paint::fill(c).glow(width * 1.5).add());
        }
    }
}

impl<T: Paints + ?Sized> Ui for T {}

/// A number that counts towards its value (a score): draw(..) every frame.
#[derive(Default)]
pub struct Score {
    shown: f32,
    /// s since the value last changed (for a little pop)
    since: f32,
    last: i64,
}

impl Score {
    pub fn draw(&mut self, d: &mut impl Paints, value: i64, x: f32, y: f32, t: &Text, dt: f32) {
        if value != self.last {
            self.last = value;
            self.since = 0.0;
        }
        self.since += dt;
        let target = value as f32;
        let k = 1.0 - (-dt * 10.0).exp();
        self.shown += (target - self.shown) * k;
        if (target - self.shown).abs() < 0.5 {
            self.shown = target;
        }
        let pop = 1.0 + 0.25 * (1.0 - ease_out(self.since / 0.35));
        d.push();
        d.translate(x, y);
        d.scale(pop);
        d.text(&format!("{}", self.shown.round() as i64), 0.0, 0.0, t);
        d.pop();
    }
}

/// Short messages at the bottom of the wall that fade out by themselves.
#[derive(Default)]
pub struct Toasts {
    list: Vec<(String, f32, Color)>,
}

impl Toasts {
    /// A message (shown 2.5 s).
    pub fn push(&mut self, text: impl Into<String>, color: Color) {
        self.list.push((text.into(), 0.0, color));
        if self.list.len() > 4 {
            self.list.remove(0);
        }
    }

    pub fn draw(&mut self, d: &mut impl Paints, dt: f32) {
        for t in &mut self.list {
            t.1 += dt;
        }
        self.list.retain(|t| t.1 < 3.0);
        let size = d.size();
        let h = size.y * 0.075;
        for (i, (text, age, color)) in self.list.iter().rev().enumerate() {
            let a = envelope(*age, 0.25, 2.5, 0.5);
            let y = size.y - h * 1.2 - i as f32 * h * 1.8 + (1.0 - ease_out(age / 0.25)) * h;
            d.label(text, size.x / 2.0, y, h, color.fade(a));
        }
    }
}

/// A QR code (made once per text and size, kept as an image): top left at (x, y), `size` px square.
#[derive(Default)]
pub struct Qr {
    made: Option<(String, u32, Image)>,
}

impl Qr {
    pub fn draw(&mut self, d: &mut impl Paints, text: &str, x: f32, y: f32, size: f32) {
        let Some(q) = (match &self.made {
            Some((t, _, _)) if t == text => None,
            _ => crate::common::qr::encode_qr(text, 'M', 1),
        }) else {
            if let Some((_, _, img)) = self.made {
                d.image(img, x, y, size, size);
            }
            return;
        };
        // whole pixels per module: crisp when drawn at about `size`
        let border = 2;
        let side = q.size as u32 + 2 * border;
        let k = (size / side as f32).ceil().max(1.0) as u32;
        let n = side * k;
        let mut px = vec![255u8; (n * n * 4) as usize];
        for yy in 0..n {
            for xx in 0..n {
                let (mx, my) = (xx / k, yy / k);
                let dark = mx >= border && my >= border && q.get((mx - border) as usize, (my - border) as usize);
                if dark {
                    let i = ((yy * n + xx) * 4) as usize;
                    px[i..i + 3].copy_from_slice(&[0, 0, 0]);
                }
            }
        }
        if let Ok(img) = d.load_image(n, n, &px) {
            self.made = Some((text.to_string(), k, img));
            d.image(img, x, y, size, size);
        }
    }
}
