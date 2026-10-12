//! Pixel Jump'n'Run (port of web/scenes/pixel-jump-run) for the LED wall (6 m x 2 m, 1008 x 336
//! LEDs). The wall is a coarse LED mosaic (cells of a few cm with dark joints) and the people in
//! front of it are pixel figures in it: their real silhouette, every person in their own outfit
//! (hair, skin, shirt, pants, shoes from the skeleton). Obstacles roll in along the ground and must
//! be jumped over, others fly in at head height and must be ducked under; coins hang in the air, a
//! rare star makes you invincible. Any number of people play at once, each at their own place on the
//! wall (the wall core maps them: mirrored, the walk stretched over the whole wall). No text, no
//! rules: you find out by trying.
//!
//! people.rs: masks -> pixel figures, jump detection. game.rs: obstacles, collisions, points.
//! art.rs: sprites, outfits, digits, the cell buffer. draw.rs: the mosaic of a frame (CPU, at cell
//! resolution). render.rs: the mosaic onto the LED image with the LED raster and a soft glow (GPU).
//! sound.rs: 8-bit sounds.

mod art;
mod draw;
mod game;
mod people;
mod render;
mod sound;

use std::fmt::Write;

use serde_json::json;

use wall::params::{ParamSpec, Params, boolean, num, select};
use wall::persons::PersonOptions;
use wall::scene::{FrameCtx, Scene, SceneDef, SetupCtx, no_cap, no_streams};
use wall::map::WallMap;

use art::{Cells, js_round};
use game::{Game, Phase};
use people::PeopleLayer;

/// where the obstacles come from
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Right,
    Left,
    /// every round from the other side
    Alternate,
}

/// The params of a frame, read once.
pub struct P {
    speed: f64,
    speed_max: f64,
    density: f64,
    gap: f64,
    from: Side,
    warn: f64,
    grace: f64,
    latency: f64,
    hit_cells: f64,
    safe_time: f64,
    star_time: f64,
    lives: f64,
    round_secs: f64,
    goal_bonus: f64,
    wait_for: f64,
    end_time: f64,
    jump_time: f64,
    jump_height: f64,
    jump_height_max: f64,
    jump_strong: f64,
    assist: bool,
    assist_max: f64,
    headroom: f64,
    jump_vy: f64,
    jump_vy2: f64,
    jump_rise: f64,
    jump_dip: f64,
    feet_up: f64,
    min_rise: f64,
    pelvis_min: f64,
    walk_gate: f64,
    instant: f64,
    jump_rest: f64,
    jump_lead: f64,
    play_near: f64,
    play_far: f64,
    bg_people: f64,
    bg_scale: f64,
    fig_h: f64,
    same_size: bool,
    duck_at: f64,
    wide: f64,
    fill: f64,
    debug: bool,
    cell_cm: f64,
    ground_rows: f64,
    gap_frac: f64,
    round: f64,
    glow: f64,
    bg_level: f64,
    brightness: f64,
    numbers: bool,
    sound: bool,
    volume: f64,
}

impl P {
    fn read(p: &Params) -> Self {
        let f = |k: &str| p.f64(k);
        Self {
            speed: f("speed"),
            speed_max: f("speedMax"),
            density: f("density"),
            gap: f("gap"),
            from: match p.s("from") {
                "links" => Side::Left,
                "abwechselnd" => Side::Alternate,
                _ => Side::Right,
            },
            warn: f("warn"),
            grace: f("grace"),
            latency: f("latency"),
            hit_cells: f("hitCells"),
            safe_time: f("safeTime"),
            star_time: f("starTime"),
            lives: f("lives"),
            round_secs: f("roundSecs"),
            goal_bonus: f("goalBonus"),
            wait_for: f("waitFor"),
            end_time: f("endTime"),
            jump_time: f("jumpTime"),
            jump_height: f("jumpHeight"),
            jump_height_max: f("jumpHeightMax"),
            jump_strong: f("jumpStrong"),
            assist: p.b("assist"),
            assist_max: f("assistMax"),
            headroom: f("headroom"),
            jump_vy: f("jumpVy"),
            jump_vy2: f("jumpVy2"),
            jump_rise: f("jumpRise"),
            jump_dip: f("jumpDip"),
            feet_up: f("feetUp"),
            min_rise: f("minRise"),
            pelvis_min: f("pelvisMin"),
            walk_gate: f("walkGate"),
            instant: f("instant"),
            jump_rest: f("jumpRest"),
            jump_lead: f("jumpLead"),
            play_near: f("playNear"),
            play_far: f("playFar"),
            bg_people: f("bgPeople"),
            bg_scale: f("bgScale"),
            fig_h: f("figH"),
            same_size: p.b("sameSize"),
            duck_at: f("duckAt"),
            wide: f("wide"),
            fill: f("fill"),
            debug: p.b("debug"),
            cell_cm: f("cellCm"),
            ground_rows: f("groundRows"),
            gap_frac: f("gapFrac"),
            round: f("round"),
            glow: f("glow"),
            bg_level: f("bgLevel"),
            brightness: f("brightness"),
            numbers: p.b("numbers"),
            sound: p.b("sound"),
            volume: f("volume"),
        }
    }
}

/// The mosaic on the LED image.
#[derive(Clone, Copy, Debug)]
pub struct Layout {
    /// LED pixels per m across
    px_x: f64,
    /// LED pixels per cell, cells across and down, the mosaic's top left (LED px)
    cell_px: i32,
    gw: i32,
    gh: i32,
    ox: i32,
    oy: i32,
    /// m per cell
    cell_mx: f64,
    cell_my: f64,
    /// the first row of the ground
    ground_row: i32,
    ground_rows: i32,
    /// m
    wall_w: f64,
    w: i32,
    h: i32,
}

impl Layout {
    fn new(wall: &WallMap, w: u32, h: u32, p: &P) -> Self {
        let [px_x, px_y] = wall.px_per_m();
        let (px_x, px_y) = (f64::from(px_x), f64::from(px_y));
        let (w, h) = (w as i32, h as i32);
        let cell_px = (js_round(p.cell_cm / 100.0 * px_x) as i32).max(4);
        let gw = (w / cell_px).max(16);
        let gh = (h / cell_px).max(8);
        let ground_rows = (js_round(p.ground_rows) as i32).clamp(1, 4);
        Self {
            px_x,
            cell_px,
            gw,
            gh,
            ox: (w - gw * cell_px).div_euclid(2),
            oy: (h - gh * cell_px).div_euclid(2),
            cell_mx: f64::from(cell_px) / px_x,
            cell_my: f64::from(cell_px) / px_y,
            ground_row: gh - ground_rows,
            ground_rows,
            wall_w: f64::from(wall.setup.size_w),
            w,
            h,
        }
    }

    /// what the cell buffer and the background depend on
    fn key(&self) -> [i32; 6] {
        [self.w, self.h, self.cell_px, self.gw, self.gh, self.ground_rows]
    }
}

fn params() -> Vec<ParamSpec> {
    vec![
        boolean("live", true, "Live (weniger Verzögerung)"),
        num("speed", 1.4, 0.5, 5.0, 0.05, "Tempo am Anfang (m/s)"),
        num("speedMax", 1.6, 1.0, 3.0, 0.05, "Tempo steigt in der Runde bis (×)"),
        num("density", 1.0, 0.3, 3.0, 0.05, "Dichte"),
        num("gap", 0.9, 0.2, 3.0, 0.05, "Reaktionszeit zwischen Hindernissen (s)"),
        select("from", "rechts", &["rechts", "links", "abwechselnd"], "Hindernisse kommen von (abwechselnd: jede Runde)"),
        num("warn", 0.8, 0.0, 2.0, 0.05, "Vorwarnung am Rand (s)"),
        num("grace", 0.12, 0.0, 0.6, 0.01, "Gnadenfrist: Treffer zählt erst nach (s)"),
        num("latency", 0.2, 0.0, 0.6, 0.01, "Latenzausgleich (s, + Verzögerung des Trackings)"),
        num("hitCells", 3.0, 1.0, 8.0, 1.0, "Treffer ab (Zellen)"),
        num("safeTime", 1.2, 0.0, 4.0, 0.1, "Nach Treffer geschützt (s)"),
        num("starTime", 6.0, 1.0, 20.0, 0.5, "Stern hält (s)"),
        num("lives", 3.0, 1.0, 9.0, 1.0, "Leben pro Person"),
        num("roundSecs", 30.0, 10.0, 180.0, 1.0, "Runde dauert (s, dann kommt das Ziel)"),
        num("goalBonus", 5.0, 0.0, 30.0, 1.0, "Punkte fürs Ziel"),
        num("waitFor", 1.5, 0.0, 10.0, 0.5, "Countdown, wenn jemand so lange da ist (s)"),
        num("endTime", 6.0, 2.0, 20.0, 0.5, "Ergebnis zeigen (s)"),
        num("jumpTime", 0.65, 0.3, 2.0, 0.01, "Zeit in der Luft: kleiner Hüpfer (s)"),
        num("jumpHeight", 0.3, 0.1, 1.4, 0.01, "Höhe: kleiner Hüpfer (m)"),
        num("jumpHeightMax", 0.9, 0.1, 2.0, 0.01, "Höhe: kräftiger Sprung (m)"),
        num("jumpStrong", 3.0, 1.2, 8.0, 0.1, "kräftig heißt: Absprung schneller als (m/s)"),
        boolean("assist", true, "Sprung trägt über das Hindernis, das kommt"),
        num("assistMax", 0.25, 0.0, 1.0, 0.01, "dafür höchstens so hoch darüber (m)"),
        num("headroom", 0.1, 0.0, 1.0, 0.01, "Kopf darf oben aus der Wand (m)"),
        num("jumpVy", 0.45, 0.15, 1.5, 0.01, "Absprung: Körper (Maske) steigt schneller als (m/s)"),
        num("jumpVy2", 0.2, 0.0, 1.5, 0.01, "und der Mittelwert der Maske schneller als (m/s)"),
        num("jumpRise", 0.05, 0.01, 0.25, 0.005, "und würde so hoch fliegen (m über dem Stand)"),
        num("jumpDip", 0.1, 0.0, 0.4, 0.01, "Absprung darf so tief beginnen (m unter dem Stand)"),
        num("feetUp", 0.02, 0.0, 0.15, 0.005, "Bestätigt: Füße heben ab um (m)"),
        num("minRise", 0.06, 0.0, 0.3, 0.005, "und Körper über dem Stand (m)"),
        num("pelvisMin", 0.03, -0.5, 0.3, 0.005, "und Becken (Skelett) über dem Stand (m)"),
        num("walkGate", 0.55, 0.1, 3.0, 0.05, "kein Sprung beim Gehen schneller als (m/s)"),
        num("instant", 2.0, 1.0, 4.0, 0.1, "Figur hebt sofort mit (× echter Hub)"),
        num("jumpRest", 0.15, 0.0, 1.0, 0.01, "Mindestabstand zweier Sprünge (s)"),
        num("jumpLead", 0.04, 0.0, 0.3, 0.01, "Sprung startet schon ein Stück im Bogen (s)"),
        num("playNear", 0.8, 0.3, 6.0, 0.05, "Mitspielen ab (m vom Sensor)"),
        num("playFar", 3.2, 0.5, 8.0, 0.05, "Mitspielen bis (m vom Sensor)"),
        num("bgPeople", 0.4, 0.0, 1.0, 0.05, "Leute dahinter: Helligkeit (0 = aus)"),
        num("bgScale", 0.8, 0.4, 1.0, 0.05, "Leute dahinter: Größe (×)"),
        num("figH", 1.1, 0.6, 1.8, 0.01, "Figurhöhe auf der Wand (m)"),
        boolean("sameSize", true, "Alle gleich groß (Kinder wie Erwachsene)"),
        num("duckAt", 0.72, 0.4, 0.95, 0.01, "Flieger fliegen ab (× Figurhöhe)"),
        num("wide", 1.25, 1.0, 2.0, 0.05, "Figuren breiter (×, Pixel-Look)"),
        num("fill", 0.22, 0.05, 0.9, 0.01, "Zelle gehört zur Figur ab (Anteil)"),
        // the mouse figure is a test of the browser page (the output has no pointer): kept for show entries
        boolean("mouse", false, "Maus-Figur (Test: Klick springt, Taste C duckt)"),
        boolean("debug", false, "Skelett zeigen (Test)"),
        num("cellCm", 6.0, 3.0, 12.0, 0.5, "Mosaik (cm pro Zelle)"),
        num("groundRows", 2.0, 1.0, 4.0, 1.0, "Boden (Zellen)"),
        num("gapFrac", 0.14, 0.0, 0.5, 0.01, "Fuge zwischen den Zellen"),
        num("round", 0.3, 0.0, 0.5, 0.01, "Ecken rund"),
        num("glow", 0.35, 0.0, 1.5, 0.05, "Leuchten"),
        num("bgLevel", 1.0, 0.0, 2.0, 0.05, "Hintergrund"),
        num("brightness", 1.0, 0.2, 1.5, 0.05, "Helligkeit"),
        boolean("numbers", true, "Punkte zeigen"),
        boolean("sound", true, "Ton"),
        num("volume", 0.5, 0.0, 1.0, 0.01, "Lautstärke"),
    ]
}

fn persons(p: &Params) -> Option<PersonOptions> {
    Some(if p.b("live") { PersonOptions::live() } else { PersonOptions::exact() })
}

struct PixelJumpRun {
    render: render::Render,
    sound: sound::Player,
    cells: Cells,
    bg: draw::Background,
    key: [i32; 6],
    people: PeopleLayer,
    game: Game,
    /// this frame's players and the people behind them (indices into people.figures), who joined
    figs: Vec<usize>,
    back: Vec<usize>,
    entered: Vec<usize>,
}

impl Scene for PixelJumpRun {
    fn frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String> {
        let p = P::read(ctx.params);
        let l = Layout::new(ctx.wall, ctx.width, ctx.height, &p);
        if l.key() != self.key {
            self.key = l.key();
            self.cells.resize(l.gw, l.gh);
            self.bg = draw::Background::new(&l);
        }

        let dt = f64::from(ctx.dt).clamp(0.001, 1.0 / 15.0);
        let t = self.game.time + dt;
        let view = ctx.kinect.view.clone();
        let kp = ctx.kinect.persons.clone();
        let rays = ctx.kinect.rays();
        self.people.update(ctx.wall, &view, kp.as_deref(), ctx.x_sign, &rays, &l, &p, t);
        self.figs.clear();
        self.back.clear();
        for &fi in &self.people.list {
            let Some(f) = self.people.figures.get_mut(fi) else { continue };
            if f.player {
                f.lift_hist.push_back(f.lift_rows);
                if f.lift_hist.len() > 8 {
                    f.lift_hist.pop_front();
                }
                self.figs.push(fi);
            } else {
                self.back.push(fi);
            }
        }
        // how far the figures lag behind the people: the set compensation plus the tracker's delay
        let lag = (p.latency + view.delay_ms / 1000.0).min(0.8);
        // ready: Kinect frames and the pose model ran once
        let ready = ctx.kinect.depth.is_some() && kp.as_ref().is_some_and(|k| k.pose_runs > 0);
        self.entered.clear();
        self.entered.extend(self.people.entered.iter().copied().filter(|&i| self.people.figures.get(i).is_some_and(|f| f.player)));
        let input = game::Input { ready, entered: &self.entered, jumped: &self.people.jumped, lag };
        self.game.step(dt, &mut self.people.figures, &self.figs, &l, &p, &input);
        // the show switches between rounds (WALL.md, "Games: switch between rounds"): from the
        // countdown until the crown has dropped and the points have been seen
        let ph = self.game.phase;
        *ctx.hold_switch = Some(ph == Phase::Count || ph == Phase::Run || (ph == Phase::End && self.game.time - self.game.phase_at < 3.0_f64.min(p.end_time - 1.5)));
        if p.sound {
            for &e in &self.game.events {
                self.sound.play(e, ctx.audio, p.volume as f32, ctx.now_ms / 1000.0);
            }
        } else {
            self.sound.stop_all();
        }
        self.game.events.clear();

        draw::draw_scene(&mut self.cells, &self.people.figures, &self.figs, &self.back, &self.game, &self.bg, &l, &p, self.game.time);
        self.render.render(ctx, &self.cells, &l, &p);

        let figures = &self.people.figures;
        let jumps: u32 = self.figs.iter().filter_map(|&i| figures.get(i)).map(|f| f.jumps).sum();
        let alive = self.figs.iter().filter_map(|&i| figures.get(i)).filter(|f| f.alive != Some(false)).count();
        let s = &mut *ctx.status;
        s.clear();
        let _ = write!(s, "Runde {}: ", self.game.round);
        let _ = match self.game.phase {
            Phase::Wait => write!(s, "{}", if ready { "wartet auf Leute" } else { "Tracking lädt" }),
            Phase::Count => write!(s, "Countdown"),
            Phase::Run => write!(s, "läuft {} s", self.game.round_t.floor()),
            Phase::End => write!(s, "Ergebnis"),
        };
        let _ = write!(s, " · {} Spieler ({alive} leben)", self.figs.len());
        if !self.back.is_empty() {
            let _ = write!(s, " +{} dahinter", self.back.len());
        }
        let _ = write!(s, " · {:.2} m/s · {jumps} Sprünge", self.game.speed);
        Ok(())
    }
}

fn make(ctx: &SetupCtx) -> Result<Box<dyn Scene>, String> {
    let render = render::Render::new(&ctx.gpu, ctx.width, ctx.height)?;
    let sound = sound::Player::new();
    std::sync::LazyLock::force(&art::SPRITES);
    let p = P::read(&ctx.params);
    let l = Layout::new(&ctx.wall, ctx.width, ctx.height, &p);
    Ok(Box::new(PixelJumpRun {
        render,
        sound,
        cells: Cells::new(l.gw, l.gh),
        bg: draw::Background::new(&l),
        key: l.key(),
        people: PeopleLayer::default(),
        game: Game::new(),
        figs: Vec::with_capacity(16),
        back: Vec::with_capacity(16),
        entered: Vec::with_capacity(16),
    }))
}

pub static DEF: SceneDef = SceneDef {
    name: "pixel-jump-run",
    title: "Pixel Jump'n'Run",
    params,
    // where one stands hardly matters (the obstacles cross the whole wall), but everybody should find
    // their own figure: right in front of them (1:1), fully on the wall, steady
    projection: || json!({ "field": "real", "edge": "clamp", "margin": 0.45, "smoothing": 0.3 }),
    persons,
    streams: no_streams,
    max_fps: no_cap,
    make,
};

wall::export_scenes!(&DEF);
