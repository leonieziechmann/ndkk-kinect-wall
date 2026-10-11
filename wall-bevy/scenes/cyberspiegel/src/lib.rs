//! Cyberspiegel (port of web/scenes/cyberspiegel): the LED wall as a dark mirror into cyberspace.
//!
//! Only the people come from the Kinect: their mask pixels (person tracking, delayed mode: exact
//! skeletons) become point clouds like the three.js particles, at their mirrored place. Everything
//! else is virtual and made of particles too: an arena of heaving particle walls (Blackwall) with a
//! glowing tear of light in the middle, dunes of dots, flickering streaks, drifting motes.
//!
//! The wall's size, the Kinect's place and how people are mapped onto the wall (mirrored, the walk
//! stretched over the whole wall) come from the control center, through ctx.wall (mirror.rs). The
//! wall is the mirror plane: a camera at the viewer's place looks through the wall rectangle
//! (off_axis_projection) into the mirrored world, whose floor continues the real floor at the bottom
//! edge of the wall. "Echte Größe" puts the people's picture where the wall mapping puts them (real
//! size, as the calibration test image shows them); at 0 they shrink with their distance as in a
//! real mirror.
//!
//! Things to try, without any hint on the wall (interact.rs reads them from the skeletons):
//!   hands and feet stir a swarm of particles in the air     jump: a quake runs through the floor
//!   both arms up and held: energy gathers, a pillar of light  arms spread: the Blackwall opens
//!   clap: a shock wave                                        stand still: you upload into the core
//!   two people's hands close: a crackling arc                 close to the wall: the mirror cracks
//! And everyone hangs on marionette strings (head and hands) from a puppeteer above (strings.rs).
//!
//! Rendering (render.rs; three.js WebGPURenderer in the browser): the scene at LED resolution x
//! supersampling -> bloom, RGB split, glitches at LED resolution -> the LED image.
//!
//! Files: mirror.rs (wall mapping -> mirror world), world.rs (the surroundings), people.rs (the
//! person point clouds), fx.rs (particles, swarm), interact.rs (gestures), strings.rs (marionette
//! strings), render.rs with scene.wgsl and post.wgsl (the GPU side).

mod fx;
mod interact;
mod mirror;
mod people;
mod render;
mod strings;
mod world;

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::sync::Arc;

use serde_json::json;

use wall::params::{ParamSpec, Params, boolean, color, num, select_map};
use wall::persons::{PersonsView, j};
use wall::scene::{FrameCtx, Scene, SceneDef, SetupCtx, cap30, exact, no_projection, no_streams};
use wall::common::rand::Rng;
use wall::map::{WallMap, off_axis_projection};

use fx::{Kick, Mover, Sparks, Swarm};
use interact::{Interactions, Kind};
use mirror::Mirror;
use people::{BuildOpts, People};
use render::{Draw, Gfx, POST_FLOATS, UNIFORM_FLOATS};
use world::{MAX_MARKS, MAX_QUAKES, Mulberry, View, WorldData};

const FACE: [usize; 2] = [j::LEFT_EYE, j::RIGHT_EYE];
const HANDS: [usize; 2] = [j::LEFT_HAND, j::RIGHT_HAND];
const MOVERS: [usize; 4] = [j::LEFT_HAND, j::RIGHT_HAND, j::LEFT_ANKLE, j::RIGHT_ANKLE]; // what stirs the swarm
const CORE: [f32; 3] = [0.0, 9.0, -68.0]; // the glowing core in the mirror world (uploads fly there)
const WHITE: [f32; 3] = [1.0, 0.85, 0.92];
const NEAR: f32 = 0.05; // the camera's clip planes
const FAR: f32 = 400.0;
const SPARKS: usize = 16000;
const SPARK_EXTRAS: usize = 4000;
const SWARM: usize = 2600;

fn params() -> Vec<ParamSpec> {
    let n = |v: i32| json!(v);
    vec![
        // Spiegel
        num("eyeDist", 3.0, 0.8, 10.0, 0.05, "Blickpunkt vor der Wand (m)"),
        num("eyeH", 1.1, 0.3, 3.0, 0.01, "Augenhöhe (m)"),
        num("real", 1.0, 0.0, 1.0, 0.01, "Echte Größe (0 = perspektivisch)"),
        num("pull", 1.2, 0.0, 3.0, 0.05, "Spiegelbild näher (m)"),
        num("follow", 0.25, 0.0, 1.0, 0.01, "Parallaxe (folgt den Personen)"),
        // Personen
        select_map("density", n(3), &[("jedes Pixel", n(1)), ("jedes 2.", n(2)), ("jedes 3.", n(3))], "Punktdichte"),
        num("dotSize", 1.25, 0.5, 4.0, 0.05, "Punktgröße (LEDs)"),
        color("nearColor", "#ff2d6a", "Farbe nah"),
        color("farColor", "#3d4bff", "Farbe fern"),
        num("nearDist", 1.5, 0.5, 6.0, 0.05, "nah bei (m)"),
        num("farDist", 4.0, 1.0, 8.0, 0.05, "fern bei (m)"),
        num("gain", 1.8, 0.0, 4.0, 0.01, "Helligkeit"),
        num("irGain", 0.9, 0.0, 2.0, 0.01, "IR-Helligkeit"),
        num("rim", 1.0, 0.0, 3.0, 0.01, "Kontur"),
        boolean("occlude", true, "Dunkler Körper"),
        color("body", "#050308", "Körperfarbe"),
        num("eyes", 0.6, 0.0, 3.0, 0.01, "Augen leuchten"),
        num("glitch", 0.5, 0.0, 1.0, 0.01, "Glitch"),
        num("reveal", 1.8, 0.3, 10.0, 0.1, "Einscannen (m/s)"),
        // Partikel
        num("dust", 1.0, 0.0, 4.0, 0.01, "Zerstäuben"),
        num("wind", 0.6, -2.0, 2.0, 0.01, "Wind"),
        num("trails", 1.0, 0.0, 4.0, 0.01, "Handspuren"),
        num("burst", 1.0, 0.0, 3.0, 0.01, "Zerfallen beim Gehen"),
        // Marionette
        num("strings", 1.0, 0.0, 3.0, 0.01, "Fäden"),
        select_map("stringTarget", json!("up"), &[("nach oben (Puppenspieler)", json!("up")), ("zum Kern der Blackwall", json!("core"))], "Fäden führen"),
        color("stringColor", "#ffe0ee", "Farbe der Fäden"),
        num("swing", 1.0, 0.0, 3.0, 0.01, "Schwingen"),
        // Interaktion
        num("swarm", 1.0, 0.0, 3.0, 0.01, "Schwarm (Hände, Füße)"),
        num("quake", 1.0, 0.0, 2.0, 0.01, "Springen: Erdbeben"),
        num("shake", 1.0, 0.0, 3.0, 0.01, "Bild wackelt"),
        num("charge", 1.0, 0.0, 2.0, 0.01, "Arme hoch: Lichtsäule"),
        num("open", 1.0, 0.0, 2.0, 0.01, "Arme ausbreiten: Wand öffnet sich"),
        num("clap", 1.0, 0.0, 2.0, 0.01, "Klatschen: Druckwelle"),
        num("upload", 1.0, 0.0, 1.0, 0.01, "Stillstehen: Hochladen"),
        num("arcs", 1.0, 0.0, 2.0, 0.01, "Hände zweier Personen: Lichtbogen"),
        num("near", 1.0, 0.0, 2.0, 0.01, "Nah an der Wand: Risse"),
        // Welt
        num("wall", 1.0, 0.0, 3.0, 0.01, "Blackwall"),
        num("core", 1.0, 0.0, 3.0, 0.01, "Kern"),
        num("glow", 1.0, 0.0, 3.0, 0.01, "Rotes Glühen"),
        num("floor", 1.0, 0.0, 3.0, 0.01, "Boden"),
        num("ripples", 1.0, 0.0, 3.0, 0.01, "Wellen um die Füße"),
        num("streaks", 1.0, 0.0, 3.0, 0.01, "Lichtstreifen"),
        num("motes", 1.0, 0.0, 3.0, 0.01, "Schwebeteilchen"),
        color("red", "#ff1e3c", "Rot"),
        color("pink", "#ff3fa6", "Pink"),
        color("blue", "#3b4bff", "Blau"),
        // Bild
        num("bloom", 0.8, 0.0, 3.0, 0.01, "Bloom"),
        num("bloomRadius", 0.4, 0.0, 1.0, 0.01, "Bloom-Radius"),
        num("bloomThreshold", 0.3, 0.0, 2.0, 0.01, "Bloom-Schwelle"),
        num("chroma", 0.35, 0.0, 6.0, 0.05, "RGB-Versatz (LEDs)"),
        num("glitchImage", 0.5, 0.0, 1.0, 0.01, "Bild-Glitch"),
        num("vignette", 0.35, 0.0, 1.0, 0.01, "Vignette"),
        num("exposure", 1.5, 0.2, 4.0, 0.01, "Belichtung"),
        select_map("ss", n(2), &[("1×", n(1)), ("2×", n(2)), ("3×", n(3))], "Supersampling"),
    ]
}

/// THREE.Color.set('#rrggbb'): sRGB -> the linear working color space
fn linear(c: [f32; 3]) -> [f32; 3] {
    c.map(|v| if v < 0.04045 { v * 0.077_399_38 } else { (v * 0.947_867_3 + 0.052_132_7).powf(2.4) })
}

fn lerp3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

fn mid3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0, (a[2] + b[2]) / 2.0]
}

fn dist3(a: [f32; 3], b: [f32; 3]) -> f32 {
    ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2) + (b[2] - a[2]).powi(2)).sqrt()
}

/// The params of a frame, read once.
struct P {
    eye_dist: f32,
    eye_h: f32,
    real: f32,
    pull: f32,
    follow: f32,
    density: usize,
    dot_size: f32,
    near_color: [f32; 3],
    far_color: [f32; 3],
    near_dist: f32,
    far_dist: f32,
    gain: f32,
    ir_gain: f32,
    rim: f32,
    occlude: bool,
    body: [f32; 3],
    eyes: f32,
    glitch: f32,
    reveal: f32,
    dust: f32,
    wind: f32,
    trails: f32,
    burst: f32,
    strings: f32,
    string_core: bool,
    string_color: [f32; 3],
    swing: f32,
    swarm: f32,
    quake: f32,
    shake: f32,
    charge: f32,
    open: f32,
    clap: f32,
    upload: f32,
    arcs: f32,
    near: f32,
    wall: f32,
    core: f32,
    glow: f32,
    floor: f32,
    ripples: f32,
    streaks: f32,
    motes: f32,
    red: [f32; 3],
    pink: [f32; 3],
    blue: [f32; 3],
    bloom: f32,
    bloom_radius: f32,
    bloom_threshold: f32,
    chroma: f32,
    glitch_image: f32,
    vignette: f32,
    exposure: f32,
    ss: u32,
}

impl P {
    fn read(p: &Params) -> Self {
        let f = |k: &str| p.f(k);
        // Number(p.density) || 3, Number(p.ss) || 2
        let opt = |k: &str, d: f32| {
            let v = p.f(k);
            if v.is_finite() && v >= 1.0 { v.round() } else { d }
        };
        Self {
            eye_dist: f("eyeDist"),
            eye_h: f("eyeH"),
            real: f("real"),
            pull: f("pull"),
            follow: f("follow"),
            density: opt("density", 3.0).min(3.0) as usize,
            dot_size: f("dotSize"),
            near_color: linear(p.color("nearColor")),
            far_color: linear(p.color("farColor")),
            near_dist: f("nearDist"),
            far_dist: f("farDist"),
            gain: f("gain"),
            ir_gain: f("irGain"),
            rim: f("rim"),
            occlude: p.b("occlude"),
            body: linear(p.color("body")),
            eyes: f("eyes"),
            glitch: f("glitch"),
            reveal: f("reveal"),
            dust: f("dust"),
            wind: f("wind"),
            trails: f("trails"),
            burst: f("burst"),
            strings: f("strings"),
            string_core: p.s("stringTarget") == "core",
            string_color: linear(p.color("stringColor")),
            swing: f("swing"),
            swarm: f("swarm"),
            quake: f("quake"),
            shake: f("shake"),
            charge: f("charge"),
            open: f("open"),
            clap: f("clap"),
            upload: f("upload"),
            arcs: f("arcs"),
            near: f("near"),
            wall: f("wall"),
            core: f("core"),
            glow: f("glow"),
            floor: f("floor"),
            ripples: f("ripples"),
            streaks: f("streaks"),
            motes: f("motes"),
            red: linear(p.color("red")),
            pink: linear(p.color("pink")),
            blue: linear(p.color("blue")),
            bloom: f("bloom"),
            bloom_radius: f("bloomRadius"),
            bloom_threshold: f("bloomThreshold"),
            chroma: f("chroma"),
            glitch_image: f("glitchImage"),
            vignette: f("vignette"),
            exposure: f("exposure"),
            // three.js could not draw more than 3× either (the option's range)
            ss: opt("ss", 2.0).min(3.0) as u32,
        }
    }
}

/// What a frame's helpers share.
struct Fr<'a> {
    t: f32,
    dt: f32,
    led_px: f32,
    p: &'a P,
    m: &'a Mirror<'a>,
    view: &'a PersonsView,
    span: f32,
}

impl Fr<'_> {
    /// color of a point in the mirror world at depth z (as the people's dots)
    fn color_at(&self, z: f32) -> [f32; 3] {
        lerp3(self.p.near_color, self.p.far_color, ((self.m.distance(z) - self.p.near_dist) / self.span).clamp(0.0, 1.0))
    }
}

/// Short glitch bursts every few seconds.
struct Glitch {
    next: f32,
    until: f32,
    seed: f32,
    change: f32,
    image: bool,
}

impl Glitch {
    /// a glitch right now (events)
    fn now(&mut self, t: f32, duration: f32, image: bool) {
        self.until = self.until.max(t + duration);
        self.change = 0.0;
        self.image = self.image || image;
        self.next = self.next.max(self.until + 1.5);
    }
}

/// ripples around the feet of a person
struct Mark {
    x: f32,
    z: f32,
    depth: f32,
    alpha: f32,
    seen: f32,
}

/// The values of world.U, people.U and post that the frame's logic sets.
struct Uniforms {
    ages: [f32; 17],
    dissolve: [f32; 17],
    marks: [[f32; 4]; MAX_MARKS],
    mark_colors: [[f32; 3]; MAX_MARKS],
    quakes: [[f32; 4]; MAX_QUAKES],
    open: f32,
    boost: f32,
    quake: f32,
    glitch: f32,
    glitch_seed: f32,
    slice: f32,
    ca_glitch: f32,
}

/// how many of something with an expected count (fractions on average); never more than the
/// sparks can hold (the params are not clamped to their ranges)
fn poisson(rng: &mut Rng, x: f32) -> usize {
    if x.is_nan() || x <= 0.0 {
        return 0;
    }
    let n = x.min(SPARKS as f32).floor();
    (n + if rng.f32() < x - n { 1.0 } else { 0.0 }) as usize
}

/// particles flying out of a point in all directions
#[allow(clippy::too_many_arguments)]
fn burst(sparks: &mut Sparks, rng: &mut Rng, at: [f32; 3], count: usize, speed: f32, ttl: f32, led_px: f32, color: [f32; 3], bright: f32, gravity: f32) {
    for _ in 0..count.min(SPARKS) {
        let u = rng.f32() * 2.0 - 1.0;
        let a = rng.f32() * std::f32::consts::TAU;
        let r = (1.0 - u * u).sqrt();
        let v = speed * (0.4 + rng.f32() * 0.6);
        let b = bright * (0.6 + rng.f32() * 0.8);
        let life = ttl * (0.6 + rng.f32() * 0.6);
        let size = led_px * (1.3 + rng.f32());
        sparks.spawn(at[0], at[1], at[2], r * a.cos() * v, u * v * 0.8 + 0.2, r * a.sin() * v, life, size, color[0] * b, color[1] * b, color[2] * b, gravity, 0.3);
    }
}

struct Cyberspiegel {
    gfx: Gfx,
    world: WorldData,
    people: People,
    sparks: Sparks,
    swarm: Swarm,
    interact: Interactions,
    strings: strings::Strings,
    rng: Rng,
    /// eyeH, eyeDist, ledPx, wall width the world is built for
    view_key: [f32; 4],
    eye_x: f32,
    energy: f32,
    /// the strings go slack in a jump
    slack: f32,
    /// camera shake 0..1
    shake: f32,
    flash: f32,
    /// somebody close to the wall, 0..1
    near: f32,
    /// person id -> ripples, in the order they came
    marks: Vec<(u32, Mark)>,
    id_slot: HashMap<u32, u8>,
    /// (id, hand) -> last position
    hands: HashMap<(u32, usize), [f32; 3]>,
    hands_seen: HashSet<(u32, usize)>,
    glitch: Glitch,
    last_update: f32,
    quake_index: usize,
    /// (t, s) for the trembling of the wall
    quakes: Vec<(f32, f32)>,
    /// one-frame pushes for the swarm
    kicks: Vec<Kick>,
    movers: Vec<Mover>,
    limbs: Vec<strings::Limbs>,
    last_event: &'static str,
    last_event_at: f32,
    u: Uniforms,
    /// new points for the GPU (a tracking result came)
    people_dirty: bool,
    /// (ray table, fx from it)
    fx: (usize, f32),
}

impl Cyberspiegel {
    /// fx of the depth camera (main.js: the hub's camera params): the ray spacing at the image
    /// center, computed once per ray table; 365.5 as in the browser without params
    fn fx_of(&mut self, rays: &Arc<Vec<f32>>) -> f32 {
        let key = Arc::as_ptr(rays) as usize;
        if self.fx.0 != key {
            let i = 2 * (212 * 512 + 256);
            let fx = match (rays.get(i), rays.get(i + 2)) {
                (Some(a), Some(b)) => 1.0 / (b - a),
                _ => 365.5,
            };
            self.fx = (key, if fx.is_finite() && fx > 100.0 && fx < 2000.0 { fx } else { 365.5 });
        }
        self.fx.1
    }

    /// short glitch bursts every few seconds: bands of the people jump, sometimes the whole image
    fn update_glitch(&mut self, t: f32, p: &P, led_w: f32) {
        let g = &mut self.glitch;
        let rng = &mut self.rng;
        // close to the wall the mirror cracks: more glitches, longer, more often over the whole image
        let near = self.near * p.near;
        let amount = p.glitch.max(p.glitch_image) * (1.0 + 3.0 * near);
        if amount > 0.0 && t >= g.next {
            g.until = t + 0.07 + rng.f32() * (0.2 + 0.2 * near);
            g.next = g.until + (2.5 + rng.f32() * 7.0) / (0.3 + amount);
            g.image = rng.f32() < 0.45 + 0.4 * near;
        }
        let active = amount > 0.0 && t < g.until;
        if active && t >= g.change {
            g.seed = (rng.f32() * 1000.0).floor();
            g.change = t + 0.03 + rng.f32() * 0.05;
        }
        self.u.glitch = if active { p.glitch } else { 0.0 };
        self.u.glitch_seed = g.seed;
        self.u.slice = if active && g.image { p.glitch_image } else { 0.0 };
        self.u.ca_glitch = if active { (4.0 * p.glitch_image) / led_w } else { 0.0 };
    }

    /// particles blown off the contour of everyone
    fn shed_dust(&mut self, f: &Fr, since: f32) {
        let p = f.p;
        let nc = self.people.contour_count;
        if nc == 0 || p.dust <= 0.0 {
            return;
        }
        let persons = self.id_slot.len().max(1) as f32;
        let count = (p.dust * 320.0 * persons * since).round().clamp(0.0, 260.0) as usize;
        for _ in 0..count {
            let k = ((self.rng.f32() * nc as f32) as usize).min(nc - 1);
            let n = self.people.contour[k] as usize;
            let c = lerp3(p.near_color, p.far_color, self.people.info(n, 3));
            let b = 0.6 + self.rng.f32() * 0.8;
            let [x, y, z] = self.people.pos(n);
            let r = &mut self.rng;
            let (vx, vy, vz) = (p.wind * (0.2 + r.f32() * 0.5), 0.03 + r.f32() * 0.12, -0.05 - r.f32() * 0.2);
            let (life, size) = (1.0 + r.f32() * 1.6, f.led_px * (1.0 + r.f32()) * 1.2);
            self.sparks.spawn(x, y, z, vx, vy, vz, life, size, c[0] * b, c[1] * b, c[2] * b, 0.0, 0.6);
        }
    }

    /// light trails behind fast hands
    fn hand_trails(&mut self, f: &Fr, since: f32) {
        let p = f.p;
        self.hands_seen.clear();
        for q in f.view {
            self.id_slot.insert(q.id, q.slot);
            for h in HANDS {
                let Some(jp) = q.joints[h] else {
                    continue;
                };
                let key = (q.id, h);
                self.hands_seen.insert(key);
                let cur = f.m.from_world(jp, q.slot);
                let last = self.hands.insert(key, cur);
                let speed = q.motion[h].map(|v| v.length()).unwrap_or(0.0);
                let Some(last) = last else {
                    continue;
                };
                if p.trails <= 0.0 || speed < 0.6 || q.confidence[h] < 0.3 {
                    continue;
                }
                let count = ((speed - 0.4) * since * 160.0 * p.trails).round().clamp(0.0, 40.0) as usize;
                let c = f.color_at(cur[2]);
                let r = &mut self.rng;
                for _ in 0..count {
                    let fr = r.f32();
                    let b = 1.0 + r.f32() * 1.2;
                    let x = last[0] + (cur[0] - last[0]) * fr + (r.f32() - 0.5) * 0.03;
                    let y = last[1] + (cur[1] - last[1]) * fr + (r.f32() - 0.5) * 0.03;
                    let z = last[2] + (cur[2] - last[2]) * fr + (r.f32() - 0.5) * 0.03;
                    let (vx, vy, vz) = (p.wind * 0.15 + (r.f32() - 0.5) * 0.06, 0.02 + r.f32() * 0.05, -0.02 - r.f32() * 0.05);
                    let (life, size) = (0.6 + r.f32() * 0.9, f.led_px * (1.2 + r.f32()) * 1.3);
                    let tint = |v: f32| (v * 0.8 + 0.2) * b;
                    self.sparks.spawn(x, y, z, vx, vy, vz, life, size, tint(c[0]), tint(c[1]), tint(c[2]), 0.0, 0.35);
                }
            }
        }
        self.hands.retain(|k, _| self.hands_seen.contains(k));
    }

    /// whoever leaves falls apart into particles
    fn leaving(&mut self, f: &Fr) {
        let p = f.p;
        for id in &f.view.left {
            let slot = self.id_slot.remove(id);
            let Some(slot) = slot.filter(|s| *s != 0) else {
                continue;
            };
            if p.burst <= 0.0 {
                continue;
            }
            let Some(r) = self.people.reservoir.get(slot as usize) else {
                continue;
            };
            for i in 0..r.n {
                if self.rng.f32() > p.burst {
                    continue;
                }
                let [x, y, z] = [r.xyz[3 * i], r.xyz[3 * i + 1], r.xyz[3 * i + 2]];
                let c = f.color_at(z);
                let g = &mut self.rng;
                let b = 1.0 + g.f32() * 1.5;
                let (vx, vy, vz) = (p.wind * 0.6 + (g.f32() - 0.5) * 0.5, 0.1 + g.f32() * 0.4, (g.f32() - 0.7) * 0.4);
                let (life, size) = (0.8 + g.f32() * 1.2, f.led_px * (1.2 + g.f32()) * 1.3);
                self.sparks.spawn(x, y, z, vx, vy, vz, life, size, c[0] * b, c[1] * b, c[2] * b, -0.15, 1.4);
            }
        }
    }

    /// ripples on the floor around everyone's feet (where the feet are seen), fading in and out
    fn update_marks(&mut self, f: &Fr) {
        let now = f.t;
        let k = (f.dt * 8.0).min(1.0);
        for q in f.view {
            let Some(ground) = q.ground else {
                continue;
            };
            let depth = f.m.from_world(ground, q.slot)[2]; // the color goes by the distance
            let g = f.m.floor(ground, q.slot);
            let i = match self.marks.iter().position(|(id, _)| *id == q.id) {
                Some(i) => i,
                None => {
                    self.marks.push((q.id, Mark { x: g[0], z: g[2], depth, alpha: 0.0, seen: now }));
                    self.marks.len() - 1
                }
            };
            let m = &mut self.marks[i].1;
            m.x += (g[0] - m.x) * k;
            m.z += (g[2] - m.z) * k;
            m.depth += (depth - m.depth) * k;
            m.seen = now;
        }
        let mut i = 0;
        let dt = f.dt;
        let u = &mut self.u;
        self.marks.retain_mut(|(_, m)| {
            let alive = now - m.seen < 0.1;
            m.alpha = (m.alpha + if alive { dt / 0.5 } else { -dt / 0.8 }).clamp(0.0, 1.0);
            if !alive && m.alpha <= 0.0 {
                return false;
            }
            if i < MAX_MARKS {
                u.marks[i] = [m.x, m.z, m.alpha, 0.0];
                u.mark_colors[i] = f.color_at(m.depth).map(|c| c * f.p.ripples);
                i += 1;
            }
            true
        });
        for m in u.marks.iter_mut().skip(i) {
            *m = [0.0, -100.0, 0.0, 0.0];
        }
    }

    /// events (jumps, claps, eruptions, touches) and the poses held (charge, open, upload)
    fn interaction(&mut self, f: &Fr, front: f32) {
        let (t, dt, p, m, led_px) = (f.t, f.dt, f.p, f.m, f.led_px);
        self.interact.update(f.view, t, dt, front);
        self.kicks.clear();
        for e in &self.interact.events {
            // a touch: between the hands as the wall shows them (each person has their own shift)
            let at = if e.kind == Kind::Touch { mid3(m.from_world(e.a, e.sa), m.from_world(e.b, e.sb)) } else { m.from_world(e.at, e.slot) };
            let c = f.color_at(at[2]);
            let hot = lerp3(c, WHITE, 0.5);
            let label = match e.kind {
                Kind::Jump if p.quake > 0.0 => {
                    let s = e.strength * p.quake;
                    let fl = m.floor(e.at, e.slot); // on the floor where the feet are seen
                    self.u.quakes[self.quake_index % MAX_QUAKES] = [fl[0], fl[2], t, s];
                    self.quake_index += 1;
                    self.quakes.push((t, s));
                    self.shake = self.shake.max(0.2 + 0.8 * s * s).min(1.2);
                    self.slack = self.slack.max(0.4 + 0.6 * e.strength);
                    if s > 0.75 {
                        self.glitch.now(t, 0.1 + 0.15 * s, true);
                    }
                    // dust from the floor around the feet
                    let r = &mut self.rng;
                    for _ in 0..(140.0 * s).ceil().clamp(0.0, SPARKS as f32) as usize {
                        let a = r.f32() * std::f32::consts::TAU;
                        let rr = 0.15 + r.f32() * 0.4;
                        let v = 0.6 + r.f32() * 1.4;
                        let b = 0.8 + r.f32();
                        let vy = 0.8 + r.f32() * 2.2 * s;
                        let (life, size) = (0.6 + r.f32() * 0.6, led_px * (1.2 + r.f32()));
                        self.sparks.spawn(fl[0] + a.cos() * rr, 0.02, fl[2] + a.sin() * rr, a.cos() * v, vy, a.sin() * v, life, size, hot[0] * b, hot[1] * b, hot[2] * b, -6.0, 0.2);
                    }
                    self.kicks.push(Kick { p: [fl[0], 0.3, fl[2]], r: 2.2, s: 2.5 * s, up: 1.0 });
                    "Sprung: Beben"
                }
                Kind::Clap if p.clap > 0.0 => {
                    let s = (0.5 + 0.5 * e.strength) * p.clap;
                    burst(&mut self.sparks, &mut self.rng, at, (170.0 * s).round() as usize, 3.2, 0.5, led_px, hot, 2.2, 0.0);
                    self.flash = self.flash.max(0.45 * s);
                    self.glitch.now(t, 0.1, true);
                    self.kicks.push(Kick { p: at, r: 1.6, s: 4.0 * s, up: 0.0 });
                    "Klatschen"
                }
                Kind::Erupt if p.charge > 0.0 => {
                    burst(&mut self.sparks, &mut self.rng, at, (220.0 * p.charge).round() as usize, 2.5, 0.7, led_px, WHITE, 2.5, 0.0);
                    self.flash = self.flash.max(0.7 * p.charge);
                    self.shake = self.shake.max(0.5);
                    self.glitch.now(t, 0.25, true);
                    self.kicks.push(Kick { p: at, r: 2.0, s: 3.0, up: 1.5 });
                    "Arme hoch: Ausbruch"
                }
                Kind::Touch if p.arcs > 0.0 => {
                    burst(&mut self.sparks, &mut self.rng, at, (200.0 * p.arcs).round() as usize, 2.4, 0.6, led_px, WHITE, 2.4, 0.0);
                    self.flash = self.flash.max(0.5 * p.arcs);
                    self.glitch.now(t, 0.18, true);
                    "Berührung"
                }
                _ => continue,
            };
            self.last_event = label;
            self.last_event_at = t;
        }
        if !self.last_event.is_empty() && t - self.last_event_at > 2.0 {
            self.last_event = "";
        }

        // held poses
        let (mut charge, mut open, mut upload) = (0.0_f32, 0.0_f32, 0.0_f32);
        self.u.dissolve = [0.0; 17];
        for q in &self.interact.people {
            let Some(person) = f.view.visible.get(q.index) else {
                continue;
            };
            open = open.max(q.open);
            charge = charge.max(q.charge);
            upload = upload.max(q.upload);
            if (1..=16).contains(&q.slot) {
                self.u.dissolve[q.slot as usize] = q.upload * p.upload * 0.92;
            }
            // energy gathers in the raised hands; when full, a pillar of light shoots up
            if q.up && q.charge > 0.02 && p.charge > 0.0 {
                for h in HANDS {
                    let Some(jp) = person.joints[h] else {
                        continue;
                    };
                    let mp = m.from_world(jp, person.slot);
                    // particles spiral in from all around (more and brighter the fuller it gets) and a glow in the hand
                    let n = poisson(&mut self.rng, (120.0 + q.charge * 380.0) * p.charge * dt);
                    let r = &mut self.rng;
                    for _ in 0..n {
                        let u = r.f32() * 2.0 - 1.0;
                        let a = r.f32() * std::f32::consts::TAU;
                        let rr = 0.5 + r.f32() * 0.9;
                        let s = (1.0 - u * u).sqrt();
                        let d = [s * a.cos() * rr, u * rr, s * a.sin() * rr];
                        let tt = 0.35 + r.f32() * 0.25;
                        // a tangential part makes them swirl
                        let sw = 0.8;
                        let b = 1.4 + q.charge * 2.0;
                        self.sparks.spawn(
                            mp[0] + d[0],
                            mp[1] + d[1],
                            mp[2] + d[2],
                            -d[0] / tt - d[2] * sw,
                            -d[1] / tt,
                            -d[2] / tt + d[0] * sw,
                            tt,
                            led_px * (1.5 + q.charge),
                            WHITE[0] * b,
                            WHITE[1] * b * 0.7,
                            WHITE[2] * b * 0.85,
                            0.0,
                            0.0,
                        );
                    }
                    // (the browser adds this point before sparks.update(), which takes it back: it is never seen)
                    self.sparks.point(mp[0], mp[1], mp[2] + 0.03, led_px * (2.0 + 5.0 * q.charge), 2.0 + 4.0 * q.charge, (1.0 + 2.0 * q.charge) * 0.6, (1.0 + 2.0 * q.charge) * 0.8);
                    if q.charge >= 1.0 {
                        let k = poisson(&mut self.rng, 700.0 * p.charge * dt);
                        let r = &mut self.rng;
                        for _ in 0..k {
                            let b = 2.5 + r.f32() * 2.0;
                            let sp = 0.06 + r.f32() * 0.1;
                            let a = r.f32() * std::f32::consts::TAU;
                            let vy = 4.0 + r.f32() * 6.0;
                            let (life, size) = (0.5 + r.f32() * 0.6, led_px * (1.8 + r.f32() * 1.5));
                            self.sparks.spawn(mp[0] + a.cos() * sp, mp[1], mp[2] + a.sin() * sp, a.cos() * 0.2, vy, a.sin() * 0.2, life, size, b, b * 0.55, b * 0.7, 0.0, 0.0);
                        }
                    }
                }
            }
            // standing still: the body flows away into the core
            if q.upload > 0.02 && p.upload > 0.0 && self.people.count > 0 {
                let n = poisson(&mut self.rng, q.upload * 700.0 * p.upload * dt);
                let count = self.people.count;
                for _ in 0..n {
                    let mut k = None;
                    for _ in 0..8 {
                        let r = ((self.rng.f32() * count as f32) as usize).min(count - 1);
                        if self.people.info(r, 2).floor() == f32::from(q.slot) {
                            k = Some(r);
                            break;
                        }
                    }
                    let Some(k) = k else {
                        break;
                    };
                    let [x, y, z] = self.people.pos(k);
                    // first up and a little apart, then off into the core: a stream of the body's dots
                    let r = &mut self.rng;
                    let tt = 2.2 + r.f32() * 1.2;
                    let tx = CORE[0] + (r.f32() - 0.5) * 4.0;
                    let ty = CORE[1] + (r.f32() - 0.5) * 10.0;
                    let c = lerp3(f.color_at(z), WHITE, 0.3);
                    let b = 1.6 + r.f32() * 1.4;
                    let vx = (tx - x) / tt + (r.f32() - 0.5) * 0.4;
                    self.sparks.spawn(x, y, z, vx, (ty - y) / tt + 0.4, (CORE[2] - z) / tt, tt * 0.95, led_px * 1.6, c[0] * b, c[1] * b, c[2] * b, 0.0, 0.8);
                }
            }
        }
        self.u.open = open.min(1.0) * p.open;
        self.u.boost = (charge * p.charge + upload * 0.5 * p.upload).min(1.5);
        // the wall trembles after a quake
        self.quakes.retain(|q| t - q.0 < 3.0);
        self.u.quake = self.quakes.iter().map(|q| q.1 * (-(t - q.0) * 2.2).exp()).sum();
        self.shake *= (-dt * 3.5).exp();
        self.slack *= (-dt * 4.0).exp();
        self.flash *= (-dt * 6.0).exp();
        self.near += (self.interact.near - self.near) * (dt * 2.0).min(1.0);
    }

    /// crackling arcs between the hands of two people
    fn arcs(&mut self, f: &Fr) {
        if self.interact.arcs.is_empty() || f.p.arcs <= 0.0 {
            return;
        }
        let led_px = f.led_px;
        for arc in &self.interact.arcs {
            let a = f.m.from_world(arc.a, arc.sa);
            let b = f.m.from_world(arc.b, arc.sb);
            let l = dist3(a, b);
            const N: usize = 40;
            let amp = 0.05 + 0.12 * l.sqrt() * (1.0 - 0.5 * arc.strength);
            let s = arc.strength * f.p.arcs;
            let (mut ox, mut oy, mut oz) = (0.0_f32, 0.0_f32, 0.0_f32);
            let r = &mut self.rng;
            for i in 0..=N {
                let fr = i as f32 / N as f32;
                let env = (std::f32::consts::PI * fr).sin();
                ox = ox * 0.6 + (r.f32() - 0.5) * amp;
                oy = oy * 0.6 + (r.f32() - 0.5) * amp;
                oz = oz * 0.6 + (r.f32() - 0.5) * amp * 0.5;
                let br = (0.8 + 1.8 * s) * (0.6 + 0.4 * r.f32());
                self.sparks.point(a[0] + (b[0] - a[0]) * fr + ox * env, a[1] + (b[1] - a[1]) * fr + oy * env, a[2] + (b[2] - a[2]) * fr + oz * env, led_px * 1.4, br * 0.85, br * 0.7, br);
            }
            if r.f32() < s {
                let at = if r.f32() < 0.5 { a } else { b };
                burst(&mut self.sparks, &mut self.rng, at, 2, 1.0, 0.3, led_px, WHITE, 1.5, 0.0);
            }
        }
    }

    /// glowing eyes: two small lights in the face of everyone looking at the wall
    fn eyes(&mut self, f: &Fr) {
        if f.p.eyes <= 0.0 {
            return;
        }
        for q in f.view {
            if q.confidence[j::NOSE] < 0.4 {
                continue;
            }
            for e in FACE {
                let Some(jp) = q.joints[e] else {
                    continue;
                };
                if q.confidence[e] < 0.45 {
                    continue;
                }
                let mp = f.m.from_world(jp, q.slot);
                let b = 4.0 * f.p.eyes;
                self.sparks.point(mp[0], mp[1], mp[2] + 0.04, f.led_px * 2.4, b, 0.25 * b, 0.35 * b);
            }
        }
    }

    /// strings from head and hands up to the puppeteer
    fn marionette(&mut self, f: &Fr, wall_top: f32) {
        let m = f.m;
        self.limbs.clear();
        for q in f.view {
            let mut limb = strings::Limbs { id: q.id, slot: q.slot, joint: [None; 3], motion: [None; 3] };
            for (i, (k, _)) in strings::ATTACH.iter().enumerate() {
                let at = if *k == j::HEAD { q.head } else { q.joints[*k] };
                limb.joint[i] = at.map(|w| m.from_world(w, q.slot));
                limb.motion[i] = match (q.motion[*k], at) {
                    (Some(v), Some(w)) => Some(m.velocity(w, v, q.slot)),
                    _ => None,
                };
            }
            self.limbs.push(limb);
        }
        let p = f.p;
        let view = strings::View { eye_h: p.eye_h, eye_dist: p.eye_dist, wall_top, led_px: f.led_px };
        let o = strings::Opts { amount: p.strings, core: p.string_core, color: p.string_color, swing: p.swing, slack: self.slack, dissolve: &self.u.dissolve };
        self.strings.update(&self.limbs, f.t, f.dt, &view, &o, &mut self.rng, &mut self.sparks);
    }

    /// the swarm in the air follows hands and feet
    fn swarm_step(&mut self, f: &Fr) {
        self.movers.clear();
        if f.p.swarm > 0.0 {
            for q in f.view {
                for k in MOVERS {
                    let (Some(jp), Some(v)) = (q.joints[k], q.motion[k]) else {
                        continue;
                    };
                    self.movers.push(Mover { p: f.m.from_world(jp, q.slot), v: f.m.velocity(jp, v, q.slot) });
                }
            }
        }
        self.swarm.update(f.dt.min(0.05), f.t, &self.movers, &self.kicks, f.p.swarm);
    }

    /// The uniforms of this frame (struct U in scene.wgsl, struct Post in post.wgsl).
    /// `led`: the LED image (ctx.wall.led), `out`: the size of ctx.target (the same on the wall)
    fn pack(&self, p: &P, proj: &[f32; 16], view: &[f32; 16], frame: [f32; 4], led: [u32; 2], out: [u32; 2]) -> ([f32; UNIFORM_FLOATS], [f32; POST_FLOATS]) {
        let mut u = [0.0_f32; UNIFORM_FLOATS];
        u[0..16].copy_from_slice(proj);
        u[16..32].copy_from_slice(view);
        u[32..36].copy_from_slice(&frame);
        u[36..40].copy_from_slice(&[self.energy, p.floor, p.wall, p.core]);
        u[40..44].copy_from_slice(&[p.glow, p.streaks, p.motes, self.u.quake]);
        u[44..48].copy_from_slice(&[self.u.open, self.u.boost, 0.0, 0.0]);
        for (k, c) in [p.red, p.pink, p.blue].iter().enumerate() {
            u[48 + 4 * k..51 + 4 * k].copy_from_slice(c);
        }
        for i in 0..MAX_MARKS {
            u[60 + 4 * i..64 + 4 * i].copy_from_slice(&self.u.marks[i]);
            u[92 + 4 * i..95 + 4 * i].copy_from_slice(&self.u.mark_colors[i]);
        }
        for i in 0..MAX_QUAKES {
            u[124 + 4 * i..128 + 4 * i].copy_from_slice(&self.u.quakes[i]);
        }
        u[140..143].copy_from_slice(&p.near_color);
        u[144..147].copy_from_slice(&p.far_color);
        u[148..151].copy_from_slice(&p.body);
        u[152..156].copy_from_slice(&[p.gain, p.ir_gain, p.rim, p.reveal]);
        u[156..160].copy_from_slice(&[self.u.glitch, self.u.glitch_seed, 0.0, 0.0]);
        u[160..177].copy_from_slice(&self.u.ages);
        u[180..197].copy_from_slice(&self.u.dissolve);
        let bloom = self.gfx.bloom_size();
        let ca = (p.chroma * (1.0 + 5.0 * self.near * p.near)) / led[0].max(1) as f32;
        let post = [
            out[0] as f32,
            out[1] as f32,
            bloom[0] as f32,
            bloom[1] as f32,
            p.exposure,
            ca,
            self.u.ca_glitch,
            self.u.slice,
            self.glitch.seed,
            p.vignette,
            self.flash,
            p.bloom,
            p.bloom_radius,
            p.bloom_threshold,
            0.01, // BloomNode.smoothWidth
            0.0,
        ];
        (u, post)
    }
}

impl Scene for Cyberspiegel {
    fn frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String> {
        let p = P::read(ctx.params);
        let dt = ctx.dt.clamp(0.001, 0.1);
        let t = ctx.time;
        self.gfx.ensure_targets(ctx.gpu, ctx.width, ctx.height, p.ss);
        let wall: &WallMap = ctx.wall;
        let [size_w, size_h] = wall.size();
        let led = wall.led();
        let wall_top = wall.setup.bottom + size_h;
        let view = ctx.kinect.view.clone();

        // ---------- the mirror geometry (the wall setup: ctx.wall) ----------
        // parallax: the point of view drifts a little towards the people (where the wall shows them)
        let (mut hx, mut hn) = (0.0_f32, 0_u32);
        for q in &*view {
            let Some(head) = q.head else {
                continue;
            };
            hx += wall.mirror(wall.from_world(head, q.slot as usize)).x;
            hn += 1;
        }
        let half = size_w / 2.0;
        let target_x = if hn > 0 { ((hx / hn as f32) * p.follow).min(half).max(-half) } else { 0.0 };
        self.eye_x += (target_x - self.eye_x) * (dt / 1.5).min(1.0);
        let d = p.eye_dist;
        // the people are placed for the steady eye: in a quake they shake with the picture
        let m = Mirror::new(wall, [self.eye_x, p.eye_h, d], p.pull, p.real);
        // a quake shakes the point of view
        let sk = self.shake * self.shake * 0.04 * p.shake;
        let ex = self.eye_x + (t * 57.0).sin() * sk;
        let ey = p.eye_h + (t * 43.0 + 1.0).sin() * sk * 0.7;
        let (proj, cam) = off_axis_projection([ex, ey, d], size_w, size_h, wall.setup.bottom, NEAR, FAR);
        let led_px = size_h / led[1].max(1) as f32; // m per LED on the wall

        // the world's dots are spaced for the view
        let key = [p.eye_h, d, led_px, size_w];
        if key != self.view_key {
            self.view_key = key;
            self.world.build(View { eye_h: p.eye_h, eye_dist: d, led_px, wall_w: size_w });
            self.gfx.upload_world(ctx.gpu, &self.world);
            self.swarm.build(d, led_px, size_w, &mut Mulberry::new(5));
        }

        // ---------- uniforms ----------
        let span = (p.far_dist - p.near_dist).max(0.1);
        self.u.ages = [99.0; 17];
        for q in &view.all {
            if (1..=16).contains(&q.slot) {
                self.u.ages[q.slot as usize] = if q.age.is_finite() { q.age } else { 99.0 };
            }
        }
        self.update_glitch(t, &p, led[0].max(1) as f32);
        // the people's motion makes the wall surge
        let mut moving = 0.0;
        for q in &*view {
            for h in HANDS {
                if let Some(v) = q.motion[h] {
                    moving += v.length();
                }
            }
        }
        let target = (moving / 4.0).min(1.0);
        self.energy += (target - self.energy) * (dt / if target > self.energy { 0.4 } else { 2.5 }).min(1.0);

        let f = Fr { t, dt, led_px, p: &p, m: &m, view: &view, span };

        // ---------- the people ----------
        if ctx.kinect.fresh.persons
            && let Some(k) = ctx.kinect.persons.clone()
        {
            let pr = &wall.projection;
            // the projection draws points wider than real (every point stretched, height or body scaled): no gaps
            let mid = (pr.f_near + pr.f_far) / 2.0 - wall.setup.sensor_front;
            let wide = if pr.per_person { pr.body_scale } else { wall.k(1.0, mid).max(wall.k(-1.0, mid)) };
            let tall = (pr.out_top - pr.out_bottom) / (pr.high - pr.low);
            let rays = ctx.kinect.rays();
            let fx = self.fx_of(&rays);
            let ir = ctx.kinect.ir.clone();
            let o = BuildOpts { fx, step: p.density, near: p.near_dist, far: p.far_dist, dot_led: p.dot_size * led_px, spread: 1.0_f32.max(wide).max(tall) };
            self.people.build(&k, &rays, ir.as_ref().map(|frame| frame.data.as_slice()), &m, &o);
            self.people_dirty = true;
            let gap = t - self.last_update;
            let since = (if gap != 0.0 && !gap.is_nan() { gap } else { 1.0 / 30.0 }).min(0.1);
            self.last_update = t;
            self.shed_dust(&f, since);
            self.hand_trails(&f, since);
            self.leaving(&f);
        }
        self.update_marks(&f);

        // ---------- what the people do ----------
        self.interaction(&f, wall.setup.sensor_front);

        // ---------- particles ----------
        self.sparks.update(dt, t);
        self.eyes(&f);
        self.arcs(&f);
        self.marionette(&f, wall_top);
        self.swarm_step(&f);

        // ---------- render ----------
        let (u, post) = self.pack(&p, &proj, &cam, [t, d, led_px, size_w], led, [ctx.width, ctx.height]);
        self.gfx.write_uniforms(ctx.gpu, &u, &post);
        if self.people_dirty {
            self.people_dirty = false;
            self.gfx.upload_people(ctx.gpu, &self.people.data[..self.people.count * people::FLOATS]);
        }
        let swarm_n = if self.swarm.visible { self.swarm.count } else { 0 };
        if swarm_n > 0 {
            self.gfx.upload_dots(ctx.gpu, 0, &self.swarm.inst);
        }
        let sparks_n = self.sparks.count();
        self.gfx.upload_dots(ctx.gpu, self.swarm.count, &self.sparks.inst[..sparks_n * fx::DOT]);
        let first = (self.swarm.count - swarm_n) as u32;
        let draw = Draw { body: p.occlude && self.people.count > 0, people: self.people.count as u32, dots: first..(self.swarm.count + sparks_n) as u32 };
        self.gfx.render(ctx.encoder, ctx.target, &draw);

        let floor = if wall.room_found { "Boden" } else { "Boden von Hand: Kinect" };
        let status = &mut *ctx.status;
        status.clear();
        let _ = write!(
            status,
            "{} Person(en) · {}k Punkte · {} Partikel · {} {:.2} m · Verzögerung {} ms",
            view.len(),
            (self.people.count as f64 / 1000.0).round(),
            self.sparks.n,
            floor,
            wall.room_height,
            if view.delay_ms.is_finite() { view.delay_ms.round() } else { 0.0 },
        );
        if !self.last_event.is_empty() {
            let _ = write!(status, " · {}", self.last_event);
        }
        Ok(())
    }
}

fn make(ctx: &SetupCtx) -> Result<Box<dyn Scene>, String> {
    let p = P::read(&ctx.params);
    let mut gfx = Gfx::new(&ctx.gpu, SWARM + SPARKS + SPARK_EXTRAS)?;
    // the world and the swarm for the view at the start (the first frame does not build them again)
    let [size_w, size_h] = ctx.wall.size();
    let led_px = size_h / ctx.wall.led()[1].max(1) as f32;
    let mut world = WorldData::default();
    world.build(View { eye_h: p.eye_h, eye_dist: p.eye_dist, led_px, wall_w: size_w });
    gfx.upload_world(&ctx.gpu, &world);
    let mut swarm = Swarm::new(SWARM);
    swarm.build(p.eye_dist, led_px, size_w, &mut Mulberry::new(5));
    gfx.ensure_targets(&ctx.gpu, ctx.width, ctx.height, p.ss);
    Ok(Box::new(Cyberspiegel {
        gfx,
        world,
        people: People::new(),
        sparks: Sparks::new(SPARKS, SPARK_EXTRAS),
        swarm,
        interact: Interactions::default(),
        strings: strings::Strings::default(),
        rng: Rng::from_time(),
        view_key: [p.eye_h, p.eye_dist, led_px, size_w],
        eye_x: 0.0,
        energy: 0.0,
        slack: 0.0,
        shake: 0.0,
        flash: 0.0,
        near: 0.0,
        marks: Vec::new(),
        id_slot: HashMap::new(),
        hands: HashMap::new(),
        hands_seen: HashSet::new(),
        glitch: Glitch { next: 2.0, until: 0.0, seed: 0.0, change: 0.0, image: false },
        last_update: 0.0,
        quake_index: 0,
        quakes: Vec::new(),
        kicks: Vec::new(),
        movers: Vec::new(),
        limbs: Vec::new(),
        last_event: "",
        last_event_at: 0.0,
        u: Uniforms {
            ages: [99.0; 17],
            dissolve: [0.0; 17],
            marks: [[0.0, -100.0, 0.0, 0.0]; MAX_MARKS],
            mark_colors: [[0.0; 3]; MAX_MARKS],
            quakes: [[0.0, 0.0, -100.0, 0.0]; MAX_QUAKES],
            open: 0.0,
            boost: 0.0,
            quake: 0.0,
            glitch: 0.0,
            glitch_seed: 0.0,
            slice: 0.0,
            ca_glitch: 0.0,
        },
        people_dirty: false,
        fx: (0, 365.5),
    }))
}

pub static DEF: SceneDef = SceneDef {
    name: "cyberspiegel",
    title: "Cyberspiegel",
    params,
    projection: no_projection,
    // default delay: exact skeletons; the whole scene shows the same moment
    persons: exact,
    // depth comes with the persons
    streams: no_streams,
    // the pose model and the Kinect's depth decoding share the GPU; the people come at 30 Hz anyway
    max_fps: cap30,
    make,
};

wall::export_scenes!(&DEF);
