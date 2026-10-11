//! Marionette strings (strings.js): thin threads of light from the top of everyone's head and from
//! both hands up out of the picture, to an invisible puppeteer above them (or, as an option, all to
//! the core of the Blackwall). The puppeteer follows the person with a lag, so the strings lean when
//! someone walks. Fast hands make their string bow and swing, a jump makes the strings go slack and
//! twang. Whoever comes in is let down on the strings; whoever leaves, their strings snap up and away.
//!
//! Everything is in the mirror world (m); the strings are drawn as dots of about one LED.

use crate::persons::j;
use crate::scenes::common::rand::Rng;

use super::fx::Sparks;

/// the top of the head (from the middle of the control bar), the hands (from its ends)
pub const ATTACH: [(usize, f32); 3] = [(j::HEAD, 0.0), (j::LEFT_HAND, -1.0), (j::RIGHT_HAND, 1.0)];
const CORE: [f32; 3] = [0.0, 26.0, -66.0]; // where all strings meet in "Kern" mode

#[derive(Clone, Copy, Default)]
struct Str {
    end: Option<[f32; 3]>,
    vel: [f32; 3],
    bow: [f32; 3],
    vib: f32,
    phase: f32,
}

struct Puppet {
    attach: f32,
    seen: f32,
    leaving: bool,
    anchor: Option<[f32; 3]>,
    strings: [Str; 3],
    slot: u8,
}

/// one person this frame: id, slot, and per ATTACH entry the mirror position and velocity
pub struct Limbs {
    pub id: u32,
    pub slot: u8,
    pub joint: [Option<[f32; 3]>; 3],
    pub motion: [Option<[f32; 3]>; 3],
}

/// eyeH, eyeDist, the top edge of the wall (m), m per LED
pub struct View {
    pub eye_h: f32,
    pub eye_dist: f32,
    pub wall_top: f32,
    pub led_px: f32,
}

/// amount, target 'core', color, swing, slack (0..1, a jump just now), dissolve per slot
pub struct Opts<'a> {
    pub amount: f32,
    pub core: bool,
    pub color: [f32; 3],
    pub swing: f32,
    pub slack: f32,
    pub dissolve: &'a [f32; 17],
}

#[derive(Default)]
pub struct Strings {
    /// person id -> state, in the order they came (a Map in the browser)
    puppets: Vec<(u32, Puppet)>,
}

fn hypot3(v: [f32; 3]) -> f32 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

impl Strings {
    #[allow(clippy::too_many_arguments)]
    pub fn update(&mut self, persons: &[Limbs], t: f32, dt: f32, view: &View, o: &Opts, rng: &mut Rng, sparks: &mut Sparks) {
        let k = (dt * 6.0).min(1.0);
        for q in persons {
            let s = match self.puppets.iter().position(|(id, _)| *id == q.id) {
                Some(i) => &mut self.puppets[i].1,
                None => {
                    let mut strings = [Str::default(); 3];
                    for st in &mut strings {
                        #[allow(clippy::approx_constant)] // the browser's number
                        let phase = rng.f32() * 6.28;
                        st.phase = phase;
                    }
                    self.puppets.push((q.id, Puppet { attach: 0.0, seen: t, leaving: false, anchor: None, strings, slot: q.slot }));
                    let last = self.puppets.len() - 1;
                    &mut self.puppets[last].1
                }
            };
            s.seen = t;
            s.leaving = false;
            s.slot = q.slot;
            // let down on the strings when someone comes in
            s.attach = (s.attach + dt / 0.9).min(1.0);
            if let Some(head) = q.joint[0] {
                let above = if o.core { CORE } else { [head[0], head[1] + 4.5, head[2] - 0.2] };
                let anchor = s.anchor.get_or_insert(above);
                // the puppeteer follows slowly
                let rate = (dt * if o.core { 4.0 } else { 1.4 }).min(1.0);
                for c in 0..3 {
                    anchor[c] += (above[c] - anchor[c]) * rate;
                }
            }
            for (i, (name, _)) in ATTACH.iter().enumerate() {
                let st = &mut s.strings[i];
                let Some(mut jp) = q.joint[i] else {
                    continue;
                };
                if *name == j::HEAD {
                    jp[1] += 0.12; // the crown, not the face
                }
                let v = q.motion[i].unwrap_or([0.0; 3]);
                let dv = hypot3([v[0] - st.vel[0], v[1] - st.vel[1], v[2] - st.vel[2]]);
                for (vel, vc) in st.vel.iter_mut().zip(v) {
                    *vel += (vc - *vel) * k;
                }
                // a jerk makes the string swing
                st.vib = (st.vib * (-dt * 3.5).exp()).max((dv * 0.012).min(0.035) * o.swing);
                st.end = Some(jp);
                // the middle of the string lags behind the hand
                for (bow, vel) in st.bow.iter_mut().zip(st.vel) {
                    let target = (-vel * 0.12 * o.swing).clamp(-0.35, 0.35);
                    *bow += (target - *bow) * k;
                }
            }
        }
        // strings of those who left snap up
        for (_, s) in &mut self.puppets {
            if t - s.seen < 0.05 {
                continue;
            }
            s.leaving = true;
            s.attach -= dt / 0.45;
        }
        self.puppets.retain(|(_, s)| !(s.leaving && s.attach <= 0.0));

        if o.amount <= 0.0 {
            return;
        }
        let View { eye_h, eye_dist, wall_top, led_px } = *view;
        for (_, s) in &self.puppets {
            let Some(anchor) = s.anchor else {
                continue;
            };
            let dissolve = o.dissolve.get(s.slot as usize).copied().unwrap_or(0.0);
            let fade = (s.attach * 1.5).clamp(0.0, 1.0) * (1.0 - 0.8 * dissolve);
            for (i, (_, bar)) in ATTACH.iter().enumerate() {
                let st = &s.strings[i];
                let Some(end) = st.end else {
                    continue;
                };
                let top = if o.core { CORE } else { [anchor[0] + bar * 0.3, anchor[1], anchor[2]] };
                // the lower end: on the joint, or on the way up (coming in, leaving)
                let ease = s.attach * s.attach * (3.0 - 2.0 * s.attach);
                let lo = [top[0] + (end[0] - top[0]) * ease, top[1] + (end[1] - top[1]) * ease, top[2] + (end[2] - top[2]) * ease];
                let d = [top[0] - lo[0], top[1] - lo[1], top[2] - lo[2]];
                let l = hypot3(d);
                let l = if l > 0.0 { l } else { 1.0 };
                // only the part that is in view: up to the top edge of the wall at that depth (+ margin)
                let dz = eye_dist - lo[2];
                let y_top = eye_h + ((wall_top - eye_h) * dz) / eye_dist + 0.3;
                let f_max = if d[1] > 0.01 { ((y_top - lo[1]) / d[1]).clamp(0.02, 1.0) } else { 1.0 };
                let step = (led_px * 1.05 * dz) / eye_dist;
                let n = ((f_max * l) / step).ceil().min(400.0);
                // (the browser draws nothing visible for n < 1 either: its points land at NaN)
                let n = if n >= 1.0 { n as usize } else { 0 };
                let slack = 1.0 + 2.5 * o.slack; // a jump: the strings bow out
                let tension = (hypot3(st.vel) * 0.4).min(1.0);
                let b = (0.75 + 0.7 * tension + 0.6 * st.vib * 10.0) * o.amount * fade;
                let size = led_px * 1.15;
                for m in (0..=n).filter(|_| n > 0) {
                    let f = (m as f32 / n as f32) * f_max;
                    let env = (std::f32::consts::PI * f).sin();
                    // a standing wave (still at both ends), long enough not to look like a zigzag
                    let wave = (f * l * 4.0 - t * 28.0 + st.phase).sin() * st.vib * env;
                    let x = lo[0] + d[0] * f + st.bow[0] * env * slack + wave;
                    let y = lo[1] + d[1] * f + st.bow[1] * env * 0.3;
                    let z = lo[2] + d[2] * f + st.bow[2] * env * slack + wave * 0.5;
                    let depth = (eye_dist - z) / eye_dist;
                    // brighter near the body, a little flicker like a thread catching light
                    let lit = b * (0.7 + 0.3 * (1.0 - f / f_max)) * (0.85 + 0.15 * (f * 40.0 + t * 7.0 + i as f32).sin());
                    sparks.point(x, y, z, size * depth, o.color[0] * lit, o.color[1] * lit, o.color[2] * lit);
                }
                // a small knot where it holds on
                if s.attach > 0.95 && !s.leaving {
                    let kb = 1.6 * o.amount * fade;
                    sparks.point(lo[0], lo[1], lo[2] + 0.02, led_px * 2.0 * (dz / eye_dist), o.color[0] * kb, o.color[1] * kb, o.color[2] * kb);
                }
            }
        }
    }
}
