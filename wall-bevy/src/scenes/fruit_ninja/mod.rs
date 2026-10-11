//! Fruit Ninja (port of web/scenes/fruit-ninja) for the LED wall (6 m x 2 m, 1008 x 336 LEDs).
//! Fruit flies up in arcs, a fast hand cuts it: two halves with the inside showing, juice, a splash
//! on the wall. Several in one swipe are a combo, bombs hurt, the star fruit starts a frenzy, the
//! frost fruit slows time. Rounds with a bar at the top, everyone's points beside their head, a crown
//! for the best of the last round. No text, no sound.
//!
//! The people: their silhouettes from the masks (exact every frame), the blades from the skeleton's
//! hands (people.rs), on the wall as the shared wall core maps them (mirrored, the walk stretched
//! over the whole wall, bodies in real size), dressed as ninjas (ninja.rs). Tracking from the hub,
//! live and exact together: cuts happen at once on the live hands (their arms come from the mask of
//! every frame), and the exact skeletons that follow 150-250 ms later still cut what live missed.
//! Behind it all a Japanese moon night (scenery.rs): moon, pagoda, Fuji, cherry tree, petals. Look
//! and renderer from space-invaders: a pixel layer at LED resolution, bloom, ripples, flashes, slow
//! motion; moiré-safe for the LED wall.
//!
//! Files: people.rs (silhouettes, blades), ninja.rs (the costume), game.rs (rules), fruits.rs (the
//! fruit as pixel art), scenery.rs (the background), draw.rs (the pixel layer, lights), render.rs
//! (wgpu), fx.rs (effects), pix.rs (blocks, font), strokes.rs (the blades as smooth ribbons).
//!
//! The still scenery is painted in a worker thread (in make, and again when the layout changes:
//! until it is ready the old layout stays), so a change of the pixel size never stalls a frame.

mod draw;
mod fruits;
mod fx;
mod game;
mod ninja;
mod people;
mod pix;
mod render;
mod scenery;
mod strokes;

use std::fmt::Write as _;
use std::thread::JoinHandle;

use serde_json::json;

use crate::gpu::Gpu;
use crate::params::{ParamSpec, Params, boolean, num, select};
use crate::persons::{PersonOptions, ViewMode};
use crate::scene::{FrameCtx, Scene, SceneDef, SetupCtx, no_streams};
use crate::scenes::common::rand::Rng;
use crate::wall::WallMap;

use draw::{Draw, Sprites};
use game::{Game, Phase, World};
use people::{People, RES};
use pix::{Pix, Rgb, WHITE, js_round, rgb};
use render::{MAX_LIGHTS, Renderer};
use scenery::{Scenery, Still};
use strokes::Strokes;

// the people in cool colors; the fruit is the warm, vivid part of the picture
const PALETTE: [u32; 10] = [0x29e6ff, 0x4d8dff, 0xb59bff, 0x3dffc0, 0xa8e6ff, 0x7ab8ff, 0xe0f4ff, 0x6f7dff, 0x5ff7e0, 0xff8be8];

pub fn color_of(s: u8) -> Rgb {
    if s == 0 { WHITE } else { rgb(PALETTE[(usize::from(s) - 1) % PALETTE.len()]) }
}

/// The params of a frame, read once.
pub struct P {
    round_time: f64,
    finale: f64,
    end_time: f64,
    reset_after: f64,
    tempo: f64,
    gravity: f64,
    every: f64,
    amount: f64,
    size: f64,
    bombs: f64,
    bomb_after: f64,
    bomb_penalty: f64,
    specials: f64,
    frenzy_time: f64,
    freeze_time: f64,
    crown: bool,
    cut_speed: f64,
    hit: f64,
    blade_r: f64,
    combo_gap: f64,
    max_jump: f64,
    max_speed: f64,
    min_conf: f64,
    trail: f64,
    smooth_delay: f64,
    inertia: f64,
    blade_width: f64,
    woosh: f64,
    woosh_width: f64,
    woosh_life: f64,
    woosh_drift: f64,
    hit_stop: f64,
    late_cuts: bool,
    raw_hands: bool,
    pixel_cm: f64,
    cover: f64,
    body_edge: f64,
    sword: bool,
    splat: f64,
    scenery: f64,
    scenery_light: f64,
    scenery_bloom: f64,
    petals: f64,
    shooting_stars: bool,
    birds: bool,
    lights: f64,
    bloom: f64,
    bloom_wide: f64,
    shake: f64,
    chroma: f64,
    flash: f64,
    slowmo: bool,
    brightness: f64,
}

impl P {
    fn read(p: &Params) -> Self {
        let f = |k: &str| p.f64(k);
        Self {
            round_time: f("roundTime"),
            finale: f("finale"),
            end_time: f("endTime"),
            reset_after: f("resetAfter"),
            tempo: f("tempo"),
            gravity: f("gravity"),
            every: f("every"),
            amount: f("amount"),
            size: f("size"),
            bombs: f("bombs"),
            bomb_after: f("bombAfter"),
            bomb_penalty: f("bombPenalty"),
            specials: f("specials"),
            frenzy_time: f("frenzyTime"),
            freeze_time: f("freezeTime"),
            crown: p.b("crown"),
            cut_speed: f("cutSpeed"),
            hit: f("hit"),
            blade_r: f("bladeR"),
            combo_gap: f("comboGap"),
            max_jump: f("maxJump"),
            max_speed: f("maxSpeed"),
            min_conf: f("minConf"),
            trail: f("trail"),
            smooth_delay: f("smoothDelay"),
            inertia: f("inertia"),
            blade_width: f("bladeWidth"),
            woosh: f("woosh"),
            woosh_width: f("wooshWidth"),
            woosh_life: f("wooshLife"),
            woosh_drift: f("wooshDrift"),
            hit_stop: f("hitStop"),
            late_cuts: p.b("lateCuts"),
            raw_hands: p.b("rawHands"),
            pixel_cm: f("pixelCm"),
            cover: f("cover"),
            body_edge: f("bodyEdge"),
            sword: p.b("sword"),
            splat: f("splat"),
            scenery: f("scenery"),
            scenery_light: f("sceneryLight"),
            scenery_bloom: f("sceneryBloom"),
            petals: f("petals"),
            shooting_stars: p.b("shootingStars"),
            birds: p.b("birds"),
            lights: f("lights"),
            bloom: f("bloom"),
            bloom_wide: f("bloomWide"),
            shake: f("shake"),
            chroma: f("chroma"),
            flash: f("flash"),
            slowmo: p.b("slowmo"),
            brightness: f("brightness"),
        }
    }
}

/// How the art pixels sit on the LED image (makeLayout()).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Layout {
    /// LEDs across, down
    w: usize,
    h: usize,
    /// LEDs per art pixel
    s: f64,
    /// art pixels across, down
    aw: usize,
    ah: usize,
    /// art px per m
    ppm: f64,
    /// wall y of the top and the bottom edge, the wall's width (m)
    top: f64,
    bottom: f64,
    wall_w: f64,
}

impl Layout {
    fn new(wall: &WallMap, w: u32, h: u32, p: &P) -> Self {
        let s = &wall.setup;
        let (wf, hf) = (f64::from(w), f64::from(h));
        let px = js_round(p.pixel_cm / 100.0 * f64::from(wall.px_per_m()[0]));
        let sz = if px.is_finite() { px.clamp(1.0, 1e4) } else { 1.0 };
        Self {
            w: w as usize,
            h: h as usize,
            s: sz,
            aw: (wf / sz).floor().max(40.0) as usize,
            ah: (hf / sz).floor().max(20.0) as usize,
            ppm: (wf / sz) / f64::from(s.size_w),
            top: f64::from(s.bottom + s.size_h),
            bottom: f64::from(s.bottom),
            wall_w: f64::from(s.size_w),
        }
    }

    /// what the pixel layer and the cells depend on
    fn key(&self) -> (usize, usize, i64) {
        (self.w, self.h, self.s as i64)
    }
}

fn params() -> Vec<ParamSpec> {
    vec![
        // Spiel
        num("roundTime", 60.0, 0.0, 300.0, 5.0, "Runde (s, 0 = endlos)"),
        num("finale", 10.0, 0.0, 30.0, 1.0, "Finale: letzte … s"),
        num("endTime", 5.0, 1.0, 15.0, 0.5, "Pause nach der Runde (s)"),
        num("resetAfter", 6.0, 2.0, 60.0, 1.0, "Runde abbrechen nach (s leer)"),
        num("tempo", 1.0, 0.5, 2.0, 0.05, "Tempo"),
        num("gravity", 3.2, 1.0, 9.81, 0.1, "Schwerkraft (m/s²)"),
        num("every", 1.4, 0.4, 5.0, 0.1, "Wurf alle … s"),
        num("amount", 1.0, 0.2, 3.0, 0.05, "Früchte pro Person und Wurf"),
        num("size", 1.0, 0.5, 2.0, 0.05, "Fruchtgröße"),
        num("bombs", 0.1, 0.0, 0.5, 0.01, "Bomben (Anteil)"),
        num("bombAfter", 8.0, 0.0, 60.0, 1.0, "Bomben ab … s der Runde"),
        num("bombPenalty", 10.0, 0.0, 50.0, 1.0, "Bombe: Punkte weg"),
        num("specials", 0.05, 0.0, 0.3, 0.01, "Sternfrucht/Frostfrucht (Anteil)"),
        num("frenzyTime", 4.0, 1.0, 10.0, 0.5, "Sternfrucht: Fruchtregen (s)"),
        num("freezeTime", 4.0, 1.0, 10.0, 0.5, "Frostfrucht: Zeitlupe (s)"),
        boolean("crown", true, "Krone für die/den Besten"),
        // Klinge
        num("cutSpeed", 1.3, 0.3, 4.0, 0.05, "Schneiden ab (m/s)"),
        num("hit", 1.2, 0.6, 2.0, 0.05, "Trefferzone (× Fruchtradius)"),
        num("bladeR", 0.08, 0.0, 0.3, 0.01, "Klinge breit (m)"),
        num("comboGap", 0.35, 0.1, 1.0, 0.05, "Combo: Pause höchstens (s)"),
        num("maxJump", 0.9, 0.2, 3.0, 0.05, "Sprung der Hand ignorieren ab (m)"),
        num("maxSpeed", 12.0, 3.0, 40.0, 0.5, "Hand schneller als … m/s = Messfehler"),
        num("minConf", 0.2, 0.0, 1.0, 0.05, "Hand: Mindest-Konfidenz"),
        num("trail", 0.2, 0.05, 0.8, 0.01, "Spur (s)"),
        num("smoothDelay", 0.07, 0.0, 0.3, 0.005, "Klinge: wartet auf Punkte (s, glatter)"),
        num("inertia", 26.0, 5.0, 80.0, 1.0, "Klinge: Federhärte (kleiner = träger)"),
        num("bladeWidth", 0.022, 0.005, 0.08, 0.001, "Klinge: Strich breit (m)"),
        num("woosh", 1.0, 0.0, 2.0, 0.05, "Woosh (exakt, nachher): Stärke"),
        num("wooshWidth", 0.07, 0.02, 0.2, 0.005, "Woosh: breit (m)"),
        num("wooshLife", 0.5, 0.15, 1.5, 0.05, "Woosh: bleibt (s)"),
        num("wooshDrift", 0.15, 0.0, 0.6, 0.01, "Woosh: weht weiter (m)"),
        num("hitStop", 0.06, 0.0, 0.2, 0.01, "Treffer: kurzes Anhalten (s)"),
        select("tracking", "live + exakt", &["live + exakt", "live", "exakt"], "Tracking (exakt = +150–250 ms)"),
        boolean("lateCuts", true, "Exakte Skelette schneiden nach, was live verpasst hat"),
        boolean("rawHands", true, "Hände ungeglättet (schneller)"),
        // Bild
        num("pixelCm", 2.4, 1.2, 4.0, 0.1, "Pixelgröße (cm)"),
        num("cover", 0.35, 0.1, 0.9, 0.05, "Körper: Pixel bedeckt ab (Anteil)"),
        num("bodyEdge", 0.75, 0.0, 1.0, 0.05, "Ninja: Kante in Spielerfarbe"),
        boolean("sword", true, "Ninja: Schwert auf dem Rücken"),
        num("splat", 0.85, 0.0, 1.0, 0.05, "Saftflecken"),
        num("scenery", 1.0, 0.0, 2.0, 0.05, "Szenerie: Helligkeit"),
        num("sceneryLight", 2.0, 0.0, 6.0, 0.1, "Szenerie: Licht vom Spiel"),
        num("sceneryBloom", 0.25, 0.0, 1.0, 0.05, "Szenerie: Leuchten (Mond, Laternen)"),
        num("petals", 40.0, 0.0, 150.0, 1.0, "Kirschblüten-Blätter"),
        boolean("shootingStars", true, "Sternschnuppen"),
        boolean("birds", true, "Vogelschwärme"),
        num("lights", 1.0, 0.0, 3.0, 0.05, "Licht"),
        num("bloom", 0.7, 0.0, 3.0, 0.05, "Leuchten"),
        num("bloomWide", 0.5, 0.0, 3.0, 0.05, "Leuchten weit"),
        num("shake", 1.0, 0.0, 3.0, 0.1, "Wackeln"),
        num("chroma", 1.0, 0.0, 3.0, 0.1, "Farbsaum"),
        num("flash", 1.0, 0.0, 2.0, 0.05, "Blitze"),
        boolean("slowmo", true, "Zeitlupe (Combos, Frostfrucht)"),
        num("brightness", 1.0, 0.2, 1.5, 0.05, "Helligkeit"),
        select("fps", "60", &["60", "30"], "Bildrate (30 = mehr Luft fürs Tracking)"),
    ]
}

fn persons(p: &Params) -> Option<PersonOptions> {
    Some(match p.s("tracking") {
        "live" => PersonOptions::live(),
        "exakt" => PersonOptions::exact(),
        _ => PersonOptions::both(),
    })
}

/// the render cap of the param `fps`
fn max_fps(p: &Params) -> f64 {
    if p.s("fps") == "30" { 30.0 } else { 0.0 }
}

/// What a worker thread makes for a layout: the still scenery and the sprites of the whole fruits.
type Painted = (Layout, Still, Sprites);

fn paint(l: Layout, size: f64) -> Painted {
    let still = scenery::paint(&l);
    let sprites = Sprites::warmed(&l, size);
    (l, still, sprites)
}

struct FruitNinja {
    renderer: Renderer,
    pix: Pix,
    people: People,
    game: Game,
    scenery: Scenery,
    strokes: Strokes,
    draw: Draw,
    /// [x, y, r, intensity, r, g, b, 0] per light
    lights: Vec<f32>,
    /// [x, y, r, amp] in LED px
    ripples: Vec<[f32; 4]>,
    entered: Vec<u32>,
    /// the layout in use
    layout: Layout,
    /// the scenery of another layout, being painted; one that failed (not tried again)
    job: Option<(Layout, JoinHandle<Painted>)>,
    failed: Option<scenery::Key>,
    rng: Rng,
}

impl FruitNinja {
    /// A layout with its still scenery takes over.
    fn apply(&mut self, gpu: &Gpu, painted: Painted) {
        let (l, still, sprites) = painted;
        if l.key() != self.layout.key() {
            self.pix.resize(l.w, l.h, l.s);
            self.people.resize(l.aw * RES, l.ah * RES);
        }
        self.renderer.ensure(gpu, l.w as u32, l.h as u32, l.aw as u32, l.ah as u32);
        self.renderer.set_scenery(gpu, &still.buf);
        self.scenery.set_still(still);
        self.draw.set_sprites(sprites);
        self.layout = l;
    }

    /// The layout the params and the wall ask for: at once if the scenery stays, else when its new
    /// scenery is painted (in a worker thread; meanwhile the old layout stays).
    fn relayout(&mut self, gpu: &Gpu, want: Layout, size: f64) {
        if self.job.as_ref().is_some_and(|j| j.1.is_finished())
            && let Some((l, h)) = self.job.take()
        {
            match h.join() {
                Ok(painted) => self.apply(gpu, painted),
                Err(_) => self.failed = Some(scenery::key_of(&l)),
            }
        }
        if want == self.layout {
            return;
        }
        let key = scenery::key_of(&want);
        if key == scenery::key_of(&self.layout) {
            // the same picture (only the wall's height changed)
            self.layout = want;
            return;
        }
        if self.job.is_some() || self.failed == Some(key) {
            return;
        }
        if let Ok(h) = std::thread::Builder::new().name("fruit-ninja scenery".into()).spawn(move || paint(want, size)) {
            self.job = Some((want, h));
        }
    }
}

impl Scene for FruitNinja {
    fn frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String> {
        let p = P::read(ctx.params);
        let want = Layout::new(ctx.wall, ctx.width, ctx.height, &p);
        self.relayout(ctx.gpu, want, p.size);
        let l = self.layout;
        let dt = f64::from(ctx.dt).clamp(0.001, 1.0 / 15.0);
        self.game.fx.step(dt);
        self.scenery.step(dt, &p);
        if !p.slowmo {
            self.game.fx.slow_until = 0.0;
        }

        // the people and their blades (real time: slow motion must not slow the hands)
        self.people.update(ctx.wall, ctx.kinect, &l, &p, self.game.real + dt);
        self.entered.clear();
        self.entered.extend_from_slice(&ctx.kinect.view.entered);
        let world = World {
            wall_w: l.wall_w,
            top: l.top,
            bottom: l.bottom,
            people: &self.people.list,
            segs: &self.people.segs,
            late_segs: &self.people.late_segs,
            entered: &self.entered,
            cell: 1.0 / l.ppm,
            p: &p,
        };
        self.game.step(dt, &world);
        if let Some(pts) = self.game.script.take() {
            self.people.script(pts, 0.22);
        }
        // the show switches between rounds (WALL.md, "Games: switch between rounds"): from the
        // countdown until the crown has been seen; endless rounds have no end to wait for
        let ph = self.game.phase;
        *ctx.hold_switch = (p.round_time > 0.0).then(|| ph == Phase::Ready || ph == Phase::Play || (ph == Phase::End && self.game.phase_t < 2.5_f64.min(p.end_time - 1.0)));

        self.draw.draw_art(&mut self.pix, &l, &self.game, &self.people, &self.scenery, &p);
        let n_lights = Draw::collect_lights(&mut self.lights, &l, &self.game, &self.people, &self.scenery, &p);
        let n_trail = self.strokes.build(&self.people, &self.game, &l, &p, self.game.real);
        // ripples in LED pixels
        let led_per_m = l.ppm * l.s;
        let fx = &self.game.fx;
        self.ripples.clear();
        for r in &fx.ripples {
            let u = (fx.time - r.t0) / r.life;
            self.ripples.push([(r.x * led_per_m) as f32, ((l.top - r.y) * led_per_m) as f32, (r.speed * (fx.time - r.t0) * led_per_m) as f32, (r.amp * (1.0 - u).powi(2)) as f32]);
        }
        let k = fx.shake * p.shake;
        let shake = if k > 0.3 {
            let a = js_round((self.rng.f64() * 2.0 - 1.0) * k * 1.5);
            let b = js_round((self.rng.f64() * 2.0 - 1.0) * k);
            [a as f32, b as f32]
        } else {
            [0.0, 0.0]
        };
        let frame = render::Frame {
            art: self.pix.bytes(),
            lights: &self.lights,
            n_lights,
            trail: &self.strokes.buf,
            n_trail,
            ripples: &self.ripples,
            shake,
            flash: [fx.flash_col[0], fx.flash_col[1], fx.flash_col[2], (fx.flash_amt * p.flash) as f32],
            chroma: (fx.chroma * p.chroma) as f32,
            scenery: p.scenery as f32,
            scenery_light: p.scenery_light as f32,
            scenery_bloom: p.scenery_bloom as f32,
            bloom: p.bloom as f32,
            bloom_wide: p.bloom_wide as f32,
            brightness: p.brightness as f32,
            time: self.game.time as f32,
        };
        self.renderer.render(ctx.gpu, ctx.encoder, ctx.target, &frame, &l);

        let game = &self.game;
        let best = game.scores.iter().fold(0.0_f64, |b, s| b.max(s.pts));
        let s = &mut *ctx.status;
        s.clear();
        let _ = write!(s, "{} Person(en) · {}", self.people.list.len(), game.phase.name());
        if game.phase == Phase::Play && p.round_time > 0.0 {
            let _ = write!(s, " · noch {} s", game.round_left.ceil() + 0.0);
        }
        let mode = match ctx.kinect.mode {
            ViewMode::Exact => "exact",
            ViewMode::Live => "live",
            ViewMode::Both => "both",
        };
        let _ = write!(s, " · {} Früchte · {} geschnitten ({} exakt nachgeschnitten) · Bestwert {} · Tracking {mode}", game.fruits.len(), game.stats.cut, game.stats.late, best + 0.0);
        Ok(())
    }
}

fn make(ctx: &SetupCtx) -> Result<Box<dyn Scene>, String> {
    let renderer = Renderer::new(&ctx.gpu)?;
    let p = P::read(&ctx.params);
    let l = Layout::new(&ctx.wall, ctx.width, ctx.height, &p);
    let (l, still, sprites) = paint(l, p.size);
    let people = People::new(l.aw * RES, l.ah * RES)?;
    let mut s = FruitNinja {
        renderer,
        pix: Pix::new(l.w, l.h, l.s),
        people,
        game: Game::new(),
        scenery: Scenery::new(still),
        strokes: Strokes::new(),
        draw: Draw::new(sprites)?,
        lights: vec![0.0; MAX_LIGHTS * 8],
        ripples: Vec::with_capacity(8),
        entered: Vec::with_capacity(16),
        layout: l,
        job: None,
        failed: None,
        rng: Rng::from_time(),
    };
    s.renderer.ensure(&ctx.gpu, l.w as u32, l.h as u32, l.aw as u32, l.ah as u32);
    s.renderer.set_scenery(&ctx.gpu, &s.scenery.still.buf);
    Ok(Box::new(s))
}

pub static DEF: SceneDef = SceneDef {
    name: "fruit-ninja",
    title: "Fruit Ninja",
    params,
    // the ninja stays near where one stands (the fruit is thrown to the players, nobody has to reach
    // the whole wall): a box 4.8 m wide around the sensor (×1.25; a box, so stepping closer or back
    // does not move one sideways), soft at the edges, the place a little smoothed (the hands stay live)
    projection: || json!({ "field": { "depth": [0.6, 4], "width": 4.8 }, "edge": "soft", "margin": 0.35, "smoothing": 0.25 }),
    persons,
    streams: no_streams,
    max_fps,
    make,
};
