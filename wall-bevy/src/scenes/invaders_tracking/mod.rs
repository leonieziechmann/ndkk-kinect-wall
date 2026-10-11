//! Space Invaders: Tracking-Check (port of web/scenes/invaders-tracking): is it the tracking or the
//! game? Left the Kinect view as the game gets it (live, masks + skeletons, the same tracker
//! settings), right the floor from above exactly as the game reads it (the same code:
//! space_invaders::body): the mask points by height, the torso, the arms it found, the turn from the
//! shoulders, jumps.
//!
//! Left:  the person mask (colored per person), the stick figure (dim joints: low confidence), the
//!        shoulders as a thick line.
//! Right: the wall (top) and the zone; per person the mask points from above (brighter = higher), the
//!        torso (ring), every arm found (line: real direction and length), the turn (arrow), a jump
//!        (flash). Bottom: tracker numbers.
//!
//! The browser page draws with Canvas 2D into a canvas of its own, which the output shows at LED
//! size (pixel ratio 1); this port draws the same calls on the GPU (paint.rs).

mod paint;

use std::collections::{HashMap, VecDeque};
use std::f64::consts::PI;
use std::fmt::Write as _;
use std::sync::Arc;

use serde_json::Value;

use crate::canvas::{Font, Rgba};
use crate::params::{ParamSpec, Params, boolean, num, select};
use crate::persons::{BONES, PersonOptions, SLOTS, ViewMode, j, person_color};
use crate::scene::{FrameCtx, Scene, SceneDef, SetupCtx, no_cap, no_streams};

use super::space_invaders::body::Bodies;
use super::space_invaders::{self, Layout, P};
use paint::{Painter, Pass};

pub static DEF: SceneDef = SceneDef {
    name: "invaders-tracking",
    title: "Space Invaders: Tracking-Check",
    params,
    projection,
    persons,
    streams: no_streams,
    max_fps: no_cap,
    make,
};

/// the Kinect image
const W: f32 = 512.0;
const H: f32 = 424.0;
/// device px per CSS px of the page's canvas (the output shows it at LED size)
const DPR: f32 = 1.0;
const FONT: &str = "ui-monospace, Consolas, monospace";
const LEGEND: &str = "links: Tracking (Maske, Strichfigur live, gestrichelt exakt, Schultern L/R)   rechts: was das Spiel daraus liest (Arme orange, ergänzt gestrichelt, Drehung grün, Sprung = Ring)";
const WHITE: Rgba = Rgba(1.0, 1.0, 1.0, 1.0);

/// '#rgb'
const fn rgb3(r: u8, g: u8, b: u8) -> Rgba {
    Rgba(r as f32 / 15.0, g as f32 / 15.0, b as f32 / 15.0, 1.0)
}

/// '#rrggbb'
const fn rgb6(v: u32) -> Rgba {
    Rgba(((v >> 16) & 255) as f32 / 255.0, ((v >> 8) & 255) as f32 / 255.0, (v & 255) as f32 / 255.0, 1.0)
}

/// Math.round
fn jr(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// the font size: Math.max(11, Math.round(13 * dpr))
fn font_size() -> f32 {
    (13.0 * DPR).round().max(11.0)
}

/// the same as the game it checks
fn projection() -> Value {
    (space_invaders::DEF.projection)()
}

fn params() -> Vec<ParamSpec> {
    // the game's parameters (defaults) for the ones this page shares with it
    let game = space_invaders::params();
    let def = |k: &str| game.iter().find(|s| s.key == k).map_or(Value::Null, |s| s.default.clone());
    let n = |k: &str, or: f64| def(k).as_f64().unwrap_or(or);
    vec![
        select("timing", "live (wie das Spiel)", &["live (wie das Spiel)", "verzögert (genau)"], "Tracking"),
        num("mask", 0.45, 0.0, 1.0, 0.01, "Maske"),
        boolean("raw", false, "Rohe Keypoints (ungeglättet)"),
        boolean("ghost", true, "Exaktes Skelett dazu (hängt etwas hinterher)"),
        select("armSource", def("armSource").as_str().unwrap_or("Skelett"), &["Skelett", "Maske"], "Arme aus"),
        boolean("exactSlow", def("exactSlow").as_bool().unwrap_or(true), "Skelett: langsam exakt, schnell live"),
        num("exactBelow", n("exactBelow", 0.35), 0.0, 2.0, 0.05, "Exakt unter (m/s)"),
        num("liveAbove", n("liveAbove", 0.9), 0.1, 3.0, 0.05, "Live über (m/s)"),
        num("armMin", n("armMin", 0.33), 0.2, 0.6, 0.01, "Arm ab (m vom Körper)"),
        boolean("mirrorArm", true, "Verdeckten Arm ergänzen (gestrichelt)"),
    ]
}

/// as the game: live masks, live + exact skeletons (or the delayed output alone, for comparison)
fn persons(p: &Params) -> Option<PersonOptions> {
    Some(if p.s("timing") == "verzögert (genau)" {
        PersonOptions::exact()
    } else if p.b("exactSlow") {
        PersonOptions::both()
    } else {
        PersonOptions::live()
    })
}

/// the game's params with the ones of this page on top (and its bodies as silhouettes, turning)
fn page_params(game: &P, cp: &Params) -> P {
    let mut p = *game;
    p.arm_min = cp.f64("armMin");
    p.mirror_arm = cp.b("mirrorArm");
    p.arm_mask = cp.s("armSource") == "Maske";
    p.exact_slow = cp.b("exactSlow");
    p.exact_below = cp.f64("exactBelow");
    p.live_above = cp.f64("liveAbove");
    p.silhouette = true;
    p.turn = true;
    p
}

struct Tracking {
    pass: Pass,
    /// the page's canvas: its calls of this frame and its state
    g: Painter,
    /// its size (LED px)
    size: (u32, u32),
    /// a string being written (reused)
    text: String,
    body: Bodies,
    /// the game's params (defaults)
    game: P,
    t0: Option<f64>,
    /// when new tracking results came (ms), the last 2 s
    seqs: VecDeque<f64>,
    last_seq: Option<u32>,
    /// (ms, pose runs) of the frames of the last 2 s
    poses: VecDeque<(f64, u64)>,
    /// the last jump per person (s)
    jumps: HashMap<u32, f64>,
    /// the page's frame rate (status().fps): frames counted since `fps_since`
    fps: f64,
    frames: u32,
    fps_since: Option<f64>,
}

fn make(s: &SetupCtx) -> Result<Box<dyn Scene>, String> {
    let g = Painter::new(&Font::new(FONT, font_size(), 400));
    let game = P::read(&Params::resolve(Arc::new(space_invaders::params()), &Value::Null));
    let l = Layout::new(&s.wall, s.wall.setup.led_w, s.wall.setup.led_h, &page_params(&game, &s.params));
    let (aw, ah) = (l.aw.max(0) as usize, l.ah.max(0) as usize);
    let mut body = Bodies::new();
    body.resize(aw, ah);
    // room for every cell of the map and the rest of a busy frame
    let pass = Pass::new(&s.gpu, &s.kgpu, &g, aw * ah + 4096)?;
    Ok(Box::new(Tracking {
        pass,
        g,
        size: (s.width, s.height),
        text: String::with_capacity(256),
        body,
        game,
        t0: None,
        seqs: VecDeque::with_capacity(128),
        last_seq: None,
        poses: VecDeque::with_capacity(256),
        jumps: HashMap::new(),
        fps: 0.0,
        frames: 0,
        fps_since: None,
    }))
}

impl Scene for Tracking {
    fn frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String> {
        let now = ctx.now_ms;
        let time = (now - *self.t0.get_or_insert(now)) / 1000.0;
        let (cw, ch) = (ctx.width as f32, ctx.height as f32);
        let g = &mut self.g;
        if (ctx.width, ctx.height) != self.size {
            // a new size (canvas.width = ...) resets the canvas' state
            self.size = (ctx.width, ctx.height);
            g.reset();
        }
        g.clear();
        let r = ctx.kinect.persons.clone();
        let view = ctx.kinect.view.clone();
        let fs = font_size();
        let gray3 = rgb3(3, 3, 3);

        // ---- left: the Kinect view (as the hub sends it: mirrored, like a mirror)
        let lw = (cw * 0.46).min((ch - 3.0 * fs) * W / H);
        let lh = lw * H / W;
        let (lx, ly) = (0.0, 0.0);
        let (sx, sy) = (lw / W, lh / H);
        // the masks: drawn first, by the GPU (paint.rs)
        let mask = if r.as_ref().is_some_and(|r| r.indices.is_some()) { (jr(ctx.params.f64("mask") * 255.0) / 255.0) as f32 } else { 0.0 };
        g.stroke_rect(lx + 0.5, ly + 0.5, lw - 1.0, lh - 1.0, gray3);
        // the exact skeletons (live + exact): dim and dashed, where they were a few frames ago
        if ctx.params.b("ghost")
            && ctx.kinect.mode == ViewMode::Both
            && let Some(ex) = ctx.kinect.exact_view.clone()
        {
            g.dash = [4.0 * DPR, 4.0 * DPR];
            g.line_width = 2.0 * DPR;
            for p in &*ex {
                for &(a, b) in &BONES {
                    let (Some(pa), Some(pb)) = (p.image.joints[a], p.image.joints[b]) else { continue };
                    g.line(lx + pa.x * sx, ly + pa.y * sy, lx + pb.x * sx, ly + pb.y * sy, Rgba(1.0, 1.0, 1.0, 0.45));
                }
            }
            g.dash = [0.0; 2];
        }
        let raw = ctx.params.b("raw");
        for p in &*view {
            let css = Rgba::rgb(p.color);
            let c = &p.confidence;
            let at = |n: usize| p.image.joints[n].map(|q| (lx + q.x * sx, ly + q.y * sy));
            g.round = true;
            for &(a, b) in &BONES {
                let (Some(pa), Some(pb)) = (at(a), at(b)) else { continue };
                let conf = c[a].min(c[b]);
                g.line_width = 2.5 * DPR;
                g.line(pa.0, pa.1, pb.0, pb.1, if conf < 0.3 { Rgba(1.0, 1.0, 1.0, 0.25) } else { WHITE });
            }
            // the shoulders: what the turn is made of
            if let (Some(ls), Some(rs)) = (at(j::LEFT_SHOULDER), at(j::RIGHT_SHOULDER)) {
                g.line_width = 6.0 * DPR;
                g.line(ls.0, ls.1, rs.0, rs.1, css);
                g.text("L", ls.0 - fs * 0.3, ls.1 - fs * 0.6, rgb3(15, 4, 4));
                g.text("R", rs.0 - fs * 0.3, rs.1 - fs * 0.6, rgb3(4, 10, 15));
            }
            for (k, &conf) in c.iter().enumerate() {
                let Some(q) = at(k) else { continue };
                g.fill_circle(q.0, q.1, 3.5 * DPR, if conf < 0.3 { Rgba(1.0, 1.0, 1.0, 0.3) } else { css });
            }
            // the raw keypoints of the tracker (not smoothed)
            if raw {
                for kp in p.camera.keypoints.iter().chain(&p.camera.extra_keypoints) {
                    // (!(kp[2] > 0): also null)
                    if kp[2].get().is_nan() || kp[2].get() <= 0.0 {
                        continue;
                    }
                    g.fill_rect(lx + kp[0].f() * sx - 2.0 * DPR, ly + kp[1].f() * sy - 2.0 * DPR, 4.0 * DPR, 4.0 * DPR, rgb3(15, 15, 0));
                }
            }
            if let Some(head) = at(j::HEAD).or_else(|| at(j::NOSE)) {
                self.text.clear();
                let _ = write!(self.text, "#{}", p.id);
                g.text(&self.text, head.0 + 8.0 * DPR, head.1 - 10.0 * DPR, css);
            }
        }

        // ---- right: the floor from above, read by the game's code
        let cp = ctx.params;
        let pp = page_params(&self.game, cp);
        let l = Layout::new(ctx.wall, ctx.wall.setup.led_w, ctx.wall.setup.led_h, &pp);
        let (aw, ah) = (l.aw.max(0) as usize, l.ah.max(0) as usize);
        if self.body.w != aw || self.body.h != ah {
            self.body.resize(aw, ah);
        }
        self.body.update(ctx.wall, ctx.kinect, ctx.x_sign, &l, &pp, time);
        let b = &self.body;
        let rx = lw + 16.0 * DPR;
        let rw = cw - rx - 8.0 * DPR;
        let k = (rw / l.aw as f32).min((ch - 3.0 * fs) / l.ah as f32);
        let ry = 0.0;
        let (zw, zh) = (l.aw as f32 * k, l.ah as f32 * k);
        // the zone and the wall side
        g.stroke_rect(rx + 0.5, ry + 0.5, zw, zh, gray3);
        let blue = rgb6(0x2299ff);
        g.fill_rect(rx, if l.up { ry } else { ry + zh - 3.0 * DPR }, zw, 3.0 * DPR, blue);
        g.text("Wand", rx + 4.0 * DPR, if l.up { ry + fs + 4.0 * DPR } else { ry + zh - 6.0 * DPR }, blue);
        // a 1 m grid
        g.line_width = 1.0;
        let mut x = 0.0;
        while x <= ctx.wall.setup.size_w {
            let gx = rx + x * l.sx as f32 * k;
            g.line(gx, ry, gx, ry + zh, rgb6(0x151515));
            x += 1.0;
        }
        // the mask points from above (the game's grid): brighter = higher, arms orange
        let cell = k.ceil();
        let cols: [[f32; 3]; SLOTS] = std::array::from_fn(|s| person_color(s as u8));
        for (c, ((&s, &kind), &cm)) in b.slot.iter().zip(&b.kind).zip(&b.height).enumerate() {
            if s == 0 || b.w == 0 {
                continue;
            }
            let (x, y) = ((c % b.w) as f32, (c / b.w) as f32);
            let hgt = (f32::from(cm) / 200.0).min(1.0);
            let col = if kind == 2 {
                Rgba(1.0, 150.0 / 255.0, 40.0 / 255.0, 0.5 + 0.5 * hgt)
            } else {
                let p = cols.get(usize::from(s)).copied().unwrap_or([1.0; 3]).map(|v| (v * 255.0 * (0.35 + 0.65 * hgt) + 0.5).floor() / 255.0);
                Rgba(p[0], p[1], p[2], 1.0)
            };
            g.fill_rect(rx + x * k, ry + y * k, cell, cell, col);
        }
        let (green, orange) = (rgb6(0x00ff88), rgb6(0xffaa22));
        for bp in &b.persons {
            let (bx, by) = (rx + bp.center[0] as f32 * k, ry + bp.center[1] as f32 * k);
            // the torso
            g.line_width = 2.0 * DPR;
            g.stroke_circle(bx, by, 5.0 * DPR, WHITE);
            // the turn: an arrow where the body faces
            let f = (bp.face.cos() as f32, bp.face.sin() as f32);
            let len = 0.45 * l.sx as f32 * k;
            g.line_width = 3.0 * DPR;
            g.line(bx, by, bx + f.0 * len, by + f.1 * len, green);
            g.fill_circle(bx + f.0 * len, by + f.1 * len, 4.0 * DPR, green);
            // the arms the game found (real direction and length; the figure on the wall draws them shorter)
            for a in &bp.arms {
                let (tx, ty) = (rx + a.tip[0] as f32 * k, ry + a.tip[1] as f32 * k);
                g.line_width = 4.0 * DPR;
                g.dash = if a.virt { [6.0 * DPR, 5.0 * DPR] } else { [0.0; 2] };
                g.line(bx, by, tx, ty, orange);
                g.dash = [0.0; 2];
                self.text.clear();
                let _ = write!(self.text, "{}{:.2} m", if a.virt { "ergänzt " } else { "" }, a.len);
                g.text(&self.text, tx + 6.0 * DPR, ty, orange);
            }
            if bp.stomp {
                self.jumps.insert(bp.id, time);
            }
            let jt = time - self.jumps.get(&bp.id).copied().unwrap_or(-9.0);
            if jt < 0.6 {
                g.line_width = 3.0 * DPR;
                g.stroke_circle(bx, by, (10.0 + jt as f32 * 60.0) * DPR, Rgba(1.0, 1.0, 1.0, 1.0 - jt as f32 / 0.6));
            }
            let deg = (jr((bp.face - l.wall_face) * 180.0 / PI + 360.0 + 180.0) as i64).rem_euclid(360) - 180;
            self.text.clear();
            let _ = write!(self.text, "#{} {deg}°", bp.id);
            g.text(&self.text, bx + 10.0 * DPR, by + 18.0 * DPR, WHITE);
        }
        // (a jump older than its ring counts as none)
        self.jumps.retain(|_, t| time - *t < 0.6);

        // ---- numbers: tracker results per second, poses, delay
        if let Some(r) = &r
            && self.last_seq != Some(r.seq)
        {
            self.last_seq = Some(r.seq);
            self.seqs.push_back(now);
        }
        while self.seqs.front().is_some_and(|&t| now - t > 2000.0) {
            self.seqs.pop_front();
        }
        // status().persons.poseRuns: the newest result's (0 before the first one)
        self.poses.push_back((now, r.as_ref().map_or(0, |r| r.pose_runs)));
        while self.poses.front().is_some_and(|&(t, _)| now - t > 2000.0) {
            self.poses.pop_front();
        }
        let pose_rate = match (self.poses.front(), self.poses.back()) {
            (Some(a), Some(z)) if self.poses.len() > 1 => (z.1 as f64 - a.1 as f64) * 1000.0 / (z.0 - a.0).max(1.0),
            _ => 0.0,
        };
        let t = &mut self.text;
        t.clear();
        let _ = write!(t, "Masken {}/s   Posen {pose_rate:.1}/s (", jr(self.seqs.len() as f64 / 2.0) as i64);
        // status().persons.poseMs: rounded to 0.1 ms
        match r.as_ref().map(|r| jr(r.pose_ms * 10.0) / 10.0) {
            Some(ms) if ms != 0.0 => {
                let _ = write!(t, "{}", jr(ms) as i64);
            }
            _ => t.push('–'),
        }
        let mode = ctx.kinect.mode;
        let _ = write!(
            t,
            " ms)   Verzögerung {} ms   Personen {}   Modus {}",
            jr(view.delay_ms) as i64,
            view.len(),
            match mode {
                ViewMode::Both => "both",
                ViewMode::Live => "live",
                ViewMode::Exact => "exact",
            }
        );
        if mode == ViewMode::Both
            && let Some(e) = &ctx.kinect.exact_view
        {
            let back = (f64::from(view.seq.unwrap_or(0)) - f64::from(e.seq.unwrap_or(0))) * 33.0;
            let _ = write!(t, " (exakt {} ms zurück, Anteil {} %)", jr(back) as i64, jr(b.exact_share * 100.0) as i64);
        }
        let _ = write!(t, "   Arme aus {}   Seite ", cp.s("armSource"));
        // status().fps: rounded to 0.1
        let fps = jr(self.fps * 10.0) / 10.0;
        if fps != 0.0 {
            let _ = write!(t, "{}", jr(fps) as i64);
        } else {
            t.push('–');
        }
        t.push_str(" fps");
        g.text(t, 8.0 * DPR, ch - fs * 0.8, rgb3(10, 10, 10));
        g.text(LEGEND, 8.0 * DPR, ch - fs * 2.1, rgb3(6, 6, 6));
        ctx.status.clear();
        let _ = write!(ctx.status, "{} Personen", view.len());

        // the page's frame rate, once a second
        let since = *self.fps_since.get_or_insert(now);
        self.frames += 1;
        if now - since >= 1000.0 {
            self.fps = f64::from(self.frames) * 1000.0 / (now - since);
            self.frames = 0;
            self.fps_since = Some(now);
        }

        self.pass.render(ctx, &self.g, [lx, ly, lx + lw, ly + lh], mask);
        Ok(())
    }
}
