//! Space Invaders (port of web/scenes/space-invaders) for the LED wall (6 m x 2 m, 1008 x 336
//! LEDs), seen from above like a strategy map (Civilization): the wall shows the floor in front of
//! it. x is where people stand along the wall (from the wall core: mirrored, the walk stretched over
//! the whole wall), y is how far they stand from the wall (default: closer to the wall = higher up on
//! the map). Every person is a unit on the map: a top-down figure turned with the body, from the
//! masks (exact every frame), head and hands as bright points.
//!
//! Invader formations come from the left and from the right edge and march towards the city in the
//! middle. The controls rest on what the tracking does well, where people stand (see game.rs):
//! automatic fire, standing still fortifies, a laser between two people, jumping starts the boost,
//! pointing with an arm locks on. A director scales every wave to the crowd and to how well it does;
//! the city can fall. No text on the wall: everybody finds it out by trying.
//!
//! Files: body.rs (bodies from the masks), game.rs (rules, director), draw.rs (the pixel layer and
//! its lights), render.rs (wgpu: lit floor, bloom, ripples; moiré-safe for the LED wall), fx.rs
//! (effects), pixels.rs (sprites, the pixel layer), city.rs (the city's picture), sound.rs.
//!
//! Not ported: the test players and the mouse unit of the browser page (globalThis.__invaders,
//! ctx.wall.pointer): the output has neither.

pub mod body;
pub mod city;
pub mod draw;
pub mod fx;
pub mod game;
pub mod pixels;
pub mod render;
pub mod sound;

use std::f64::consts::PI;
use std::fmt::Write as _;
use std::sync::LazyLock;

use serde_json::json;

use wall::params::{ParamSpec, Params, boolean, num, select};
use wall::persons::PersonOptions;
use wall::scene::{FrameCtx, Scene, SceneDef, SetupCtx, no_streams};
use wall::common::rand::Rng;
use wall::map::WallMap;

use body::Bodies;
use draw::Looks;
use game::{Game, GameLayout, InvCol, Phase, SLOTS, Unit};
use pixels::{ART, Pix, Rgb, WHITE, clamp, hex, jr};
use render::{Frame, MAX_LIGHTS, Renderer};

/// players: cool colors; the invaders are the warm ones (magenta, red, purple), bullets orange
const PALETTE: [Rgb; 10] = [hex(0x29e6ff), hex(0x4d8dff), hex(0x3dffc0), hex(0xb59bff), hex(0xa8e6ff), hex(0x00c2b8), hex(0x7ab8ff), hex(0xe0f4ff), hex(0x6f7dff), hex(0x5ff7e0)];
/// squid, crab, octopus
const INVADERS_NEON: [Rgb; 3] = [hex(0xff3df0), hex(0xff4d7d), hex(0xb45cff)];

fn slot_color(s: u8) -> Rgb {
    if s == 0 { WHITE } else { PALETTE[(usize::from(s) - 1) % PALETTE.len()] }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum JumpHint {
    /// until the first boost
    First,
    Always,
    Off,
}

/// The params of a frame, read once.
#[derive(Clone, Copy, Debug)]
pub struct P {
    point: bool,
    auto: bool,
    auto_every: f64,
    auto_range: f64,
    fortify: bool,
    fortify_after: f64,
    still_speed: f64,
    links: bool,
    link_max: f64,
    link_cooldown: f64,
    point_every: f64,
    assist: f64,
    pub arm_min: f64,
    pub mirror_arm: bool,
    /// armSource 'Maske'
    pub arm_mask: bool,
    pub exact_slow: bool,
    pub exact_below: f64,
    pub live_above: f64,
    homing: f64,
    body_scale: f64,
    /// look 'Silhouette'
    pub silhouette: bool,
    pub turn: bool,
    step_len: f64,
    foot_life: f64,
    jump_boost: bool,
    jump_hint: JumpHint,
    boost_time: f64,
    boost_recharge: f64,
    boost_fire: f64,
    boost_damage: f64,
    jump_vy: f64,
    jump_vy2: f64,
    jump_rise: f64,
    jump_dip: f64,
    walk_gate: f64,
    target_time: f64,
    city_fall: f64,
    rows: f64,
    cols: f64,
    speed: f64,
    advance: f64,
    enemy_fire: f64,
    dive: f64,
    dive_speed: f64,
    bullet_speed: f64,
    laser_speed: f64,
    stun: f64,
    ufo_every: f64,
    telegraph: f64,
    bombs: f64,
    bomb_fuse: f64,
    ship: bool,
    ship_from: f64,
    ship_first: f64,
    ship_every: f64,
    ship_hp: f64,
    ship_charge: f64,
    beam_width: f64,
    edge_lasers: f64,
    edge_from: f64,
    edge_width: f64,
    edge_tele: f64,
    items: bool,
    item_every: f64,
    power_time: f64,
    reset_after: f64,
    /// orient 'zur Wand = oben'
    up: bool,
    pixel_cm: f64,
    city_width: f64,
    hex: f64,
    fog: bool,
    /// colors 'weiß'
    white: bool,
    bloom: f64,
    bloom_wide: f64,
    lights: f64,
    shake: f64,
    chroma: f64,
    flash: f64,
    slowmo: bool,
    brightness: f64,
    sound: bool,
    volume: f64,
}

impl P {
    pub fn read(p: &Params) -> Self {
        let f = |k: &str| p.f64(k);
        let control = p.s("control");
        Self {
            point: control.contains("Zeigen"),
            auto: control.contains("Automatik"),
            auto_every: f("autoEvery"),
            auto_range: f("autoRange"),
            fortify: p.b("fortify"),
            fortify_after: f("fortifyAfter"),
            still_speed: f("stillSpeed"),
            links: p.b("links"),
            link_max: f("linkMax"),
            link_cooldown: f("linkCooldown"),
            point_every: f("pointEvery"),
            assist: f("assist"),
            arm_min: f("armMin"),
            mirror_arm: p.b("mirrorArm"),
            arm_mask: p.s("armSource") == "Maske",
            exact_slow: p.b("exactSlow"),
            exact_below: f("exactBelow"),
            live_above: f("liveAbove"),
            homing: f("homing"),
            body_scale: f("bodyScale"),
            silhouette: p.s("look") == "Silhouette",
            turn: p.b("turn"),
            step_len: f("stepLen"),
            foot_life: f("footLife"),
            jump_boost: p.b("jumpBoost"),
            jump_hint: match p.s("jumpHint") {
                "immer" => JumpHint::Always,
                "aus" => JumpHint::Off,
                _ => JumpHint::First,
            },
            boost_time: f("boostTime"),
            boost_recharge: f("boostRecharge"),
            boost_fire: f("boostFire"),
            boost_damage: f("boostDamage"),
            jump_vy: f("jumpVy"),
            jump_vy2: f("jumpVy2"),
            jump_rise: f("jumpRise"),
            jump_dip: f("jumpDip"),
            walk_gate: f("walkGate"),
            target_time: f("targetTime"),
            city_fall: f("cityFall"),
            rows: f("rows"),
            cols: f("cols"),
            speed: f("speed"),
            advance: f("advance"),
            enemy_fire: f("enemyFire"),
            dive: f("dive"),
            dive_speed: f("diveSpeed"),
            bullet_speed: f("bulletSpeed"),
            laser_speed: f("laserSpeed"),
            stun: f("stun"),
            ufo_every: f("ufoEvery"),
            telegraph: f("telegraph"),
            bombs: f("bombs"),
            bomb_fuse: f("bombFuse"),
            ship: p.b("ship"),
            ship_from: f("shipFrom"),
            ship_first: f("shipFirst"),
            ship_every: f("shipEvery"),
            ship_hp: f("shipHp"),
            ship_charge: f("shipCharge"),
            beam_width: f("beamWidth"),
            edge_lasers: f("edgeLasers"),
            edge_from: f("edgeFrom"),
            edge_width: f("edgeWidth"),
            edge_tele: f("edgeTele"),
            items: p.b("items"),
            item_every: f("itemEvery"),
            power_time: f("powerTime"),
            reset_after: f("resetAfter"),
            up: p.s("orient") != "zur Wand = unten",
            pixel_cm: f("pixelCm"),
            city_width: f("cityWidth"),
            hex: f("hex"),
            fog: p.b("fog"),
            white: p.s("colors") == "weiß",
            bloom: f("bloom"),
            bloom_wide: f("bloomWide"),
            lights: f("lights"),
            shake: f("shake"),
            chroma: f("chroma"),
            flash: f("flash"),
            slowmo: p.b("slowmo"),
            brightness: f("brightness"),
            sound: p.b("sound"),
            volume: f("volume"),
        }
    }
}

/// The map: the art pixel grid on the LED image, wall m -> art px (main.js makeLayout).
#[derive(Clone, Copy, Debug)]
pub struct Layout {
    pub w: i32,
    pub h: i32,
    /// LEDs per art px
    pub s: i32,
    pub aw: i32,
    pub ah: i32,
    pub ox: i32,
    pub oy: i32,
    /// art px per m across, per m of depth
    pub sx: f64,
    pub sy: f64,
    pub z_top: f64,
    pub z_bot: f64,
    pub up: bool,
    /// facing the wall (rad on the map)
    pub wall_face: f64,
    pub city_w: i32,
    pub city_x0: i32,
    f_near: f64,
    f_far: f64,
}

impl Layout {
    pub fn new(wall: &WallMap, w: u32, h: u32, p: &P) -> Self {
        let st = &wall.setup;
        let (w, h) = (w as i32, h as i32);
        let s = jr((p.pixel_cm / 100.0) * f64::from(wall.px_per_m()[0])).max(1.0) as i32;
        let aw = (w / s).max(40);
        let ah = (h / s).max(20);
        let size_w = f64::from(st.size_w);
        let sx = f64::from(aw) / size_w;
        // the map's depth: the projection's play field (control center: tab Projektion), a little
        // more on both sides; its depth curve moves the people (a body keeps its shape around its center)
        let (f_near, f_far) = (f64::from(wall.projection.f_near), f64::from(wall.projection.f_far));
        let z_top = (f_near - 0.25).max(0.0);
        let z_bot = f_far + 0.1;
        let sy = f64::from(ah) / (z_bot - z_top).max(0.5);
        let up = p.up;
        let city_w = clamp(jr(p.city_width * sx), 12.0, f64::from(aw - 60)) as i32;
        let city_x0 = jr((size_w / 2.0 + f64::from(st.sensor_x)) * sx - f64::from(city_w) / 2.0) as i32;
        Self {
            w,
            h,
            s,
            aw,
            ah,
            ox: (w - aw * s).div_euclid(2),
            oy: (h - ah * s).div_euclid(2),
            sx,
            sy,
            z_top,
            z_bot,
            up,
            wall_face: if up { -PI / 2.0 } else { PI / 2.0 },
            city_w,
            city_x0,
            f_near,
            f_far,
        }
    }

    /// what the game and the pixel layer depend on (a new one restarts the game)
    fn game_key(&self) -> [i32; 7] {
        [self.w, self.h, self.s, self.aw, self.ah, self.city_w, self.city_x0]
    }

    fn game(&self) -> GameLayout {
        GameLayout { aw: f64::from(self.aw), ah: f64::from(self.ah), sx: self.sx, sy: self.sy, city_x0: f64::from(self.city_x0), city_w: self.city_w.max(0) as usize, s: self.s.max(1) as usize }
    }

    /// m in front of the wall -> the same through the depth curve (identity while it is linear)
    fn curved(&self, wall: &WallMap, z: f64) -> f64 {
        self.f_near + f64::from(wall.field_z(z as f32)) * (self.f_far - self.f_near)
    }

    /// wall x (m from the left edge), z (m in front of the wall) -> art px
    pub fn map(&self, wall: &WallMap, x: f64, z: f64) -> [f64; 2] {
        let c = self.curved(wall, z);
        [x * self.sx, if self.up { (c - self.z_top) * self.sy } else { (self.z_bot - c) * self.sy }]
    }

    /// art row -> m in front of the wall
    fn row_z(&self, wall: &WallMap, y: f64) -> f64 {
        let c = if self.up { self.z_top + y / self.sy } else { self.z_bot - y / self.sy };
        f64::from(wall.field_depth(((c - self.f_near) / (self.f_far - self.f_near)) as f32))
    }
}

/// where people can be: the sensor's view (a wedge) on the map, a bit wider for the arms; the rest is fog
fn fog_mask(wall: &WallMap, l: &Layout, p: &P, mask: &mut Vec<u8>) {
    let (aw, ah) = (l.aw.max(0) as usize, l.ah.max(0) as usize);
    mask.clear();
    mask.resize(aw * ah, 0);
    if !p.fog {
        mask.fill(255);
        return;
    }
    let s = &wall.setup;
    let pr = &wall.projection;
    let size_w = f64::from(s.size_w);
    let cx = size_w / 2.0 + f64::from(s.sensor_x);
    for y in 0..ah {
        let z = l.row_z(wall, y as f64 + 0.5); // m in front of the wall
        if z < f64::from(pr.zone_near) - 0.15 || z > f64::from(pr.zone_far) + 0.15 {
            continue;
        }
        // the edges of the view there, through the projection
        let half = ((z - f64::from(s.sensor_front)) * f64::from(wall.tan_h)).max(0.0);
        let el = f64::from(wall.map_x((cx - half) as f32, z as f32));
        let er = f64::from(wall.map_x((cx + half) as f32, z as f32));
        let mut xl = el.min(er) - 0.35;
        let mut xr = el.max(er) + 0.35;
        let margin = f64::from(pr.margin);
        if xl < margin + 0.2 {
            xl = 0.0;
        }
        if xr > size_w - margin - 0.2 {
            xr = size_w;
        }
        let a = (xl * l.sx).floor().max(0.0) as usize;
        let b = ((xr * l.sx).ceil().max(0.0) as usize).min(aw);
        if a < b {
            mask[y * aw + a..y * aw + b].fill(255);
        }
    }
}

pub fn params() -> Vec<ParamSpec> {
    vec![
        select("control", "Automatik + Zeigen", &["Automatik + Zeigen", "Automatik", "Zeigen"], "Steuerung"),
        num("autoEvery", 0.6, 0.1, 3.0, 0.05, "Automatik: Schuss alle … s (Fort)"),
        num("autoRange", 2.0, 0.5, 6.0, 0.1, "Automatik: Reichweite (m)"),
        boolean("fortify", true, "Stillstehen = Fort (schneller)"),
        num("fortifyAfter", 0.8, 0.2, 4.0, 0.1, "Fort nach … s still"),
        num("stillSpeed", 0.3, 0.05, 1.0, 0.01, "Still unter (m/s)"),
        boolean("links", true, "Team-Laser zwischen Spielern"),
        num("linkMax", 2.5, 0.5, 6.0, 0.1, "Team-Laser bis (m)"),
        num("linkCooldown", 0.6, 0.0, 3.0, 0.05, "Team-Laser: Pause nach Treffer (s)"),
        num("pointEvery", 0.2, 0.05, 1.0, 0.01, "Zeigen: Schuss alle … s"),
        num("assist", 28.0, 0.0, 60.0, 1.0, "Zeigen: Zielhilfe (Grad)"),
        num("armMin", 0.33, 0.2, 0.6, 0.01, "Zeigen: Arm ab (m vom Körper)"),
        boolean("mirrorArm", true, "Verdeckten Arm ergänzen (gespiegelt)"),
        select("armSource", "Skelett", &["Skelett", "Maske"], "Arme aus"),
        boolean("exactSlow", true, "Skelett: langsam exakt, schnell live"),
        num("exactBelow", 0.35, 0.0, 2.0, 0.05, "Exakt unter (m/s)"),
        num("liveAbove", 0.9, 0.1, 3.0, 0.05, "Live über (m/s)"),
        num("homing", 5.0, 0.0, 20.0, 0.5, "Schüsse lenken nach (rad/s)"),
        num("bodyScale", 0.6, 0.3, 1.0, 0.05, "Personen-Größe"),
        select("look", "Figur", &["Figur", "Silhouette"], "Personen als"),
        boolean("turn", true, "Figuren drehen sich mit (Schultern)"),
        num("stepLen", 0.35, 0.15, 1.0, 0.05, "Fußspur alle … m"),
        num("footLife", 5.0, 0.5, 20.0, 0.5, "Fußspuren bleiben (s)"),
        boolean("jumpBoost", true, "Springen = Boost"),
        select("jumpHint", "bis zum ersten Boost", &["bis zum ersten Boost", "immer", "aus"], "Sprung-Hinweis (Männchen)"),
        num("boostTime", 5.0, 1.0, 20.0, 0.5, "Boost hält (s)"),
        num("boostRecharge", 12.0, 2.0, 60.0, 1.0, "Boost lädt auf (s)"),
        num("boostFire", 2.5, 1.0, 6.0, 0.1, "Boost: Feuer schneller (×)"),
        num("boostDamage", 2.0, 1.0, 5.0, 1.0, "Boost: Schaden pro Schuss"),
        num("jumpVy", 0.45, 0.15, 1.5, 0.01, "Sprung: Körper steigt schneller als (m/s)"),
        num("jumpVy2", 0.35, 0.0, 1.5, 0.01, "Sprung: und das Becken schneller als (m/s)"),
        num("jumpRise", 0.05, 0.01, 0.25, 0.005, "Sprung: würde so hoch fliegen (m)"),
        num("jumpDip", 0.1, 0.0, 0.4, 0.01, "Sprung: darf so tief beginnen (m)"),
        num("walkGate", 0.55, 0.1, 3.0, 0.05, "Sprung: nicht beim Gehen über (m/s)"),
        num("targetTime", 40.0, 10.0, 180.0, 5.0, "Ziel-Dauer einer Welle (s)"),
        num("cityFall", 0.25, 0.0, 0.8, 0.01, "Stadt fällt unter (Anteil)"),
        num("rows", 4.0, 1.0, 8.0, 1.0, "Reihen pro Seite (1 Person)"),
        num("cols", 3.0, 1.0, 6.0, 1.0, "Spalten pro Seite (1 Person)"),
        num("speed", 1.0, 0.2, 3.0, 0.05, "Tempo"),
        num("advance", 8.0, 1.0, 24.0, 1.0, "Vorrücken pro Wende (Pixel)"),
        num("enemyFire", 1.0, 0.0, 4.0, 0.05, "Beschuss"),
        num("dive", 1.0, 0.0, 4.0, 0.05, "Sturzflieger"),
        num("diveSpeed", 1.6, 0.5, 4.0, 0.05, "Sturzflieger (m/s)"),
        num("bulletSpeed", 1.3, 0.3, 4.0, 0.05, "Gegnerschüsse (m/s)"),
        num("laserSpeed", 5.0, 1.0, 15.0, 0.5, "Laser (m/s)"),
        num("stun", 1.0, 0.0, 5.0, 0.1, "Getroffen: Pause (s)"),
        num("ufoEvery", 30.0, 5.0, 120.0, 1.0, "Mutterschiff alle … s"),
        num("telegraph", 0.35, 0.0, 1.5, 0.05, "Vorwarnung vor Schüssen (s)"),
        num("bombs", 1.0, 0.0, 4.0, 0.05, "Minen"),
        num("bombFuse", 1.4, 0.4, 4.0, 0.1, "Minen: Zünder (s)"),
        boolean("ship", true, "Schlachtschiff"),
        num("shipFrom", 2.0, 1.0, 10.0, 1.0, "Schlachtschiff ab Welle"),
        num("shipFirst", 18.0, 3.0, 120.0, 1.0, "Schlachtschiff nach … s der Welle"),
        num("shipEvery", 40.0, 10.0, 180.0, 5.0, "Schlachtschiff wieder nach … s"),
        num("shipHp", 30.0, 5.0, 200.0, 5.0, "Schlachtschiff: Treffer (1 Person)"),
        num("shipCharge", 1.5, 0.5, 4.0, 0.1, "Schlachtschiff: Laden (s)"),
        num("beamWidth", 0.55, 0.2, 1.5, 0.05, "Laser breit (m)"),
        num("edgeLasers", 1.0, 0.0, 4.0, 0.05, "Laser vom Rand"),
        num("edgeFrom", 2.0, 1.0, 10.0, 1.0, "Laser vom Rand ab Welle"),
        num("edgeWidth", 0.3, 0.1, 1.0, 0.05, "Laser vom Rand: breit (m)"),
        num("edgeTele", 1.3, 0.4, 3.0, 0.1, "Laser vom Rand: Vorwarnung (s)"),
        boolean("items", true, "Powerups"),
        num("itemEvery", 16.0, 3.0, 60.0, 1.0, "Powerup alle … s (1 Person)"),
        num("powerTime", 8.0, 2.0, 20.0, 0.5, "Powerups wirken (s)"),
        num("resetAfter", 10.0, 2.0, 60.0, 1.0, "Neue Runde nach (s leer)"),
        select("orient", "zur Wand = oben", &["zur Wand = oben", "zur Wand = unten"], "Karte"),
        num("pixelCm", 2.4, 1.2, 4.0, 0.1, "Pixelgröße (cm)"),
        num("cityWidth", 0.6, 0.2, 2.0, 0.05, "Stadt breit (m)"),
        num("hex", 1.0, 0.0, 3.0, 0.05, "Hex-Raster"),
        boolean("fog", true, "Raster nur wo die Kinect sieht"),
        select("colors", "neon", &["neon", "weiß"], "Invader"),
        num("bloom", 0.9, 0.0, 3.0, 0.05, "Leuchten"),
        num("bloomWide", 0.6, 0.0, 3.0, 0.05, "Leuchten weit"),
        num("lights", 1.0, 0.0, 3.0, 0.05, "Licht auf dem Boden"),
        num("shake", 1.0, 0.0, 3.0, 0.1, "Wackeln"),
        num("chroma", 1.0, 0.0, 3.0, 0.1, "Farbsaum bei Treffern"),
        num("flash", 1.0, 0.0, 2.0, 0.05, "Blitze"),
        boolean("slowmo", true, "Zeitlupe bei großen Momenten"),
        num("brightness", 1.0, 0.2, 1.5, 0.05, "Helligkeit"),
        select("fps", "30", &["30", "60"], "Bildrate (30 = mehr Luft fürs Tracking)"),
        boolean("sound", true, "Ton"),
        num("volume", 0.5, 0.0, 1.0, 0.01, "Lautstärke"),
    ]
}

/// live masks for the bodies; live + exact skeletons (param exactSlow): body.rs takes a joint from
/// the exact skeleton while it moves slowly and from the live one when it is fast
fn persons(p: &Params) -> Option<PersonOptions> {
    Some(if p.b("exactSlow") { PersonOptions::both() } else { PersonOptions::live() })
}

/// 30 fps (param `fps`): the whole frame (tracking analysis, game, drawing) only every second display
/// frame, which leaves CPU and GPU time to the person tracker and the Kinect's depth decoding
fn max_fps(p: &Params) -> f64 {
    if p.s("fps") == "30" { 30.0 } else { 0.0 }
}

struct SpaceInvaders {
    renderer: Renderer,
    sound: sound::Sound,
    pix: Pix,
    body: Bodies,
    game: Game,
    game_key: [i32; 7],
    fog_key: Option<(i32, i32, bool, u64, bool)>,
    fog: Vec<u8>,
    lights: Vec<f32>,
    people: Vec<Unit>,
    looks: Looks,
    ripples: Vec<[f32; 4]>,
    rng: Rng,
}

impl Scene for SpaceInvaders {
    fn frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String> {
        let p = P::read(ctx.params);
        let l = Layout::new(ctx.wall, ctx.width, ctx.height, &p);
        if l.game_key() != self.game_key {
            self.game_key = l.game_key();
            self.pix.resize(l.w, l.h, l.s, l.ox, l.oy);
            self.body.resize(l.aw.max(0) as usize, l.ah.max(0) as usize);
            self.game.set_layout(l.game());
            self.fog_key = None;
        }
        let fog_key = (l.aw, l.ah, l.up, ctx.wall.version, p.fog);
        if self.fog_key != Some(fog_key) {
            self.fog_key = Some(fog_key);
            fog_mask(ctx.wall, &l, &p, &mut self.fog);
            self.renderer.set_fog(ctx.gpu, &l, &self.fog);
            // power-ups only where people can get to
            self.game.reach = Some(self.fog.clone());
        }
        let inv = InvCol(if p.white { [WHITE; 3] } else { INVADERS_NEON });

        let dt = f64::from(ctx.dt).clamp(0.001, 1.0 / 15.0);
        self.game.fx.step(dt);
        if !p.slowmo {
            self.game.fx.slow_until = 0.0;
        }
        // the people for the game: from the masks (real time: slow motion must not change the jump velocities)
        let fx_time = self.game.fx.time;
        self.body.update(ctx.wall, ctx.kinect, ctx.x_sign, &l, &p, fx_time);
        // (the units are kept from frame to frame: no allocation)
        self.people.truncate(self.body.persons.len());
        for (k, b) in self.body.persons.iter().enumerate() {
            if k == self.people.len() {
                self.people.push(Unit { id: 0, slot: 0, col: WHITE, center: [0.0; 2], arms: Vec::with_capacity(4), stomp: false, head: None, hands: [None; 2], face: 0.0 });
            }
            let Some(u) = self.people.get_mut(k) else { break };
            u.id = b.id;
            u.slot = b.slot;
            u.col = slot_color(b.slot);
            u.center = b.center;
            u.arms.clear();
            u.arms.extend_from_slice(&b.arms);
            u.stomp = b.stomp;
            u.head = b.head;
            u.hands = b.hands;
            u.face = b.face;
        }
        let game = &mut self.game;
        game.step(dt, &self.people, &self.body, &p, inv);
        // the show switches between waves (WALL.md, "Games: switch between rounds"): not while people
        // fight one (a tracking gap of a moment does not count as gone), only after the first fireworks
        // of a cleared wave or once the fallen city has crumbled
        let ph = game.phase;
        *ctx.hold_switch = Some(
            (game.empty_for < 2.0 && (ph == Phase::Enter || ph == Phase::Fight)) || (ph == Phase::Clear && game.phase_t < 1.5) || (ph == Phase::Fall && game.phase_t < 2.5),
        );
        let now = ctx.now_ms / 1000.0;
        if p.sound {
            let volume = p.volume as f32;
            for &e in &game.events {
                self.sound.play(e, ctx.audio, volume, now);
            }
            self.sound.tick(ctx.audio, volume, now);
        } else {
            self.sound.stop_all();
        }
        game.events.clear();

        draw::looks(game, &self.people, &mut self.looks);
        draw::draw_art(&mut self.pix, game, &self.body, &l, &p, inv, &self.people, &self.looks);
        let n_lights = draw::collect_lights(game, &self.people, &self.looks, &p, &l, &mut self.lights);
        for i in 0..n_lights {
            self.lights[i * 8 + 3] *= p.lights as f32;
        }
        // ripples in LED pixels
        let fx = &game.fx;
        let pxm = l.sx * f64::from(l.s);
        self.ripples.clear();
        for r in &fx.ripples {
            let u = (fx.time - r.t0) / r.life;
            self.ripples.push([(f64::from(l.ox) + r.x * f64::from(l.s)) as f32, (f64::from(l.oy) + r.y * f64::from(l.s)) as f32, (r.speed * (fx.time - r.t0) * pxm) as f32, (r.amp * (1.0 - u).powi(2)) as f32]);
        }
        let k = fx.shake * p.shake;
        let shake = if k > 0.3 { [jr((self.rng.f64() * 2.0 - 1.0) * k * 1.5) as f32, jr((self.rng.f64() * 2.0 - 1.0) * k) as f32] } else { [0.0, 0.0] };
        let frame = Frame {
            art: &self.pix.buf,
            lights: &self.lights,
            n_lights,
            ripples: &self.ripples,
            shake,
            flash: [fx.flash_col[0] as f32, fx.flash_col[1] as f32, fx.flash_col[2] as f32, (fx.flash_amt * p.flash) as f32],
            chroma: (fx.chroma * p.chroma) as f32,
            pulse: fx.pulse as f32,
            hex: p.hex as f32,
            bloom: p.bloom as f32,
            bloom_wide: p.bloom_wide as f32,
            brightness: p.brightness as f32,
            time: game.time as f32,
        };
        self.renderer.render(ctx, &l, &frame);

        let alive: i32 = game.sides.iter().map(|s| s.count).sum();
        let arms: usize = self.people.iter().map(|q| q.arms.len()).sum();
        let s = &mut *ctx.status;
        s.clear();
        let _ = write!(s, "{} Spieler ({arms} Arme) · Welle {} · Skill {:.2} · {alive} Invader + {} Flieger", self.people.len(), game.level, game.skill, game.divers.len());
        if let Some(sh) = &game.ship {
            let _ = write!(s, " · Schiff {} {}/{}", sh.state.name(), sh.hp, sh.hp_max);
        }
        let _ = write!(s, " · Stadt {} % · {} · {} Punkte", jr(game.city_health() * 100.0), ph.name(), game.score);
        Ok(())
    }
}

fn make(ctx: &SetupCtx) -> Result<Box<dyn Scene>, String> {
    LazyLock::force(&ART);
    let p = P::read(&ctx.params);
    let l = Layout::new(&ctx.wall, ctx.width, ctx.height, &p);
    let renderer = Renderer::new(&ctx.gpu, l.w.max(1) as u32, l.h.max(1) as u32, l.aw.max(1) as u32, l.ah.max(1) as u32)?;
    let sound = sound::Sound::new();
    let mut pix = Pix::new();
    pix.resize(l.w, l.h, l.s, l.ox, l.oy);
    let mut body = Bodies::new();
    body.resize(l.aw.max(0) as usize, l.ah.max(0) as usize);
    let mut rng = Rng::from_time();
    // the game on its layout: the city's picture is painted here, not in the first frame
    let game = Game::new(l.game(), p, rng.next_u64());
    Ok(Box::new(SpaceInvaders {
        renderer,
        sound,
        pix,
        body,
        game,
        game_key: l.game_key(),
        fog_key: None,
        fog: Vec::new(),
        lights: vec![0.0; MAX_LIGHTS * 8],
        people: Vec::with_capacity(16),
        looks: [None; SLOTS],
        ripples: Vec::with_capacity(8),
        rng,
    }))
}

pub static DEF: SceneDef = SceneDef {
    name: "space-invaders",
    title: "Space Invaders (Draufsicht)",
    params,
    // seen from above: a box (straight walks stay straight on the map, footprints line up), 2.9 m of
    // floor across the wall (×2), 0.5-4 m from the sensor as the map's depth; steadier units (forts)
    projection: || json!({ "field": { "depth": [0.5, 4], "width": 2.9 }, "smoothing": 0.25 }),
    persons,
    streams: no_streams,
    max_fps,
    make,
};
