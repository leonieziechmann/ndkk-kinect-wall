//! LLG: Kirschblütennacht (port of web/scenes/llg-sakura). The Ludwig-Leichhardt-Gymnasium on a
//! spring night as cozy pixel art, for the Nacht der kreativen Köpfe. Yozakura, cherry blossoms at
//! night under paper lanterns, in front of the school with its orange tower and "ライヒハルト高校"
//! on the facade, because the school teaches Japanese and has been partnered with Omiya High
//! School (Saitama) since 1996.
//!
//! On top: the school's logo rebuilt in pixels, a short headline, rotating facts, and a QR code to
//! llgym.de on a paper card. People in front of the wall become pixel figures (dark outline, cel
//! tones from the infrared image, warm rim light from the lanterns) and play with the night without
//! being told how: moving makes wind for the petals, petals settle on whoever stands still and fly
//! off when they move, reaching or jumping into a crown shakes the tree, the lantern above you
//! glows brighter and swings when you pass, arriving sends a gust across the wall.
//!
//! Everything is drawn at the art resolution (one art pixel = `pixel` x `pixel` LEDs) and snapped
//! to one palette at the end (render.rs). Files: pixel.rs (palette, raster, fonts), painting.rs
//! (the backdrop), sprites.rs (lanterns, petals), world.rs (what moves), overlay.rs (logo, text,
//! QR card), paint.rs (painting them in the background), render.rs (wgpu); the bodies on a wall
//! grid are common::field, the QR encoder common::qr.

mod overlay;
mod paint;
mod painting;
mod pixel;
mod render;
mod sprites;
mod world;

use std::fmt::Write as _;
use std::sync::Arc;
use std::time::Instant;

use crate::gpu::Gpu;
use crate::params::{ParamSpec, Params, boolean, num, select, text};
use crate::scene::{FrameCtx, Scene, SceneDef, SetupCtx, cap30, live, no_projection, no_streams};
use crate::scenes::common::field::BodyField;
use crate::scenes::common::qr::{Qr, encode_qr};

use overlay::{SubSlot, card_size};
use paint::{Art, ArtSpec, Caches, Painter, paint_art};
use pixel::jr;
use render::{KIND_OVER, KIND_OVERLAY, KIND_SUB, Look, Renderer, Writer};
use sprites::Sheet;
use world::{Knobs, Pl, WallSize, World};

pub(super) const FONT: &str = "\"Segoe UI Black\", \"Arial Black\", \"Segoe UI\", sans-serif";
pub(super) const SUB_FONT: &str = "Verdana, Tahoma, \"Segoe UI\", sans-serif";
pub(super) const JP_FONT: &str = "\"Yu Gothic UI\", \"Yu Gothic\", Meiryo, \"Segoe UI\", sans-serif";
/// s: subline change (out, then in)
const SLIDE: f64 = 0.6;
/// empty tracking results after which the body field is settled (kicks below 0.45^40)
const SETTLED: u32 = 40;

fn params() -> Vec<ParamSpec> {
    vec![
        text("kicker", "ようこそ！ Willkommen am LLG", "Zeile oben (klein, rosa)"),
        text("zeile1", "Japan beginnt", "Überschrift Zeile 1 (weiß)"),
        text("zeile2", "in Cottbus.", "Überschrift Zeile 2 (orange)"),
        text(
            "unterzeilen",
            "Japanisch als zweite Fremdsprache, seit 2003 | 30 Jahre Partnerschaft mit der Omiya High School | Schüleraustausch: alle zwei Jahre nach Japan | Eine der wenigen Schulen mit Japanisch",
            "Unterzeilen (mit | getrennt)",
        ),
        num("subEvery", 6.0, 2.0, 30.0, 0.5, "Unterzeile wechselt alle (s)"),
        num("logoSize", 0.38, 0.25, 0.5, 0.01, "Logo-Höhe (Anteil der Wand)"),
        text("url", "https://www.llgym.de", "Link im QR-Code"),
        text("adresse", "llgym.de", "Adresse unter dem Code"),
        num("qrModule", 2.0, 1.0, 4.0, 1.0, "Modulgröße (Pixel)"),
        select("qrSide", "rechts", &["rechts", "links"], "Seite"),
        num("pixel", 2.0, 1.0, 4.0, 1.0, "Pixelgröße (LEDs)"),
        num("dither", 1.0, 0.0, 2.0, 0.05, "Dithering (Lichter)"),
        num("stars", 1.0, 0.0, 1.5, 0.05, "Sterne und Sternschnuppen"),
        num("lanterns", 1.0, 0.0, 1.5, 0.05, "Laternen"),
        num("windows", 0.6, 0.0, 1.0, 0.05, "Fenster mit Licht (Anteil)"),
        num("windowsBright", 1.0, 0.0, 1.0, 0.05, "Helligkeit Fenster"),
        num("petals", 1.0, 0.0, 3.0, 0.05, "Blütenregen"),
        num("wind", 1.0, 0.0, 3.0, 0.05, "Wind"),
        boolean("stick", true, "Blüten bleiben auf Stillstehenden liegen"),
        num("kick", 1.0, 0.0, 3.0, 0.05, "Bewegung macht Wind"),
        num("shake", 1.0, 0.0, 3.0, 0.05, "Bäume schütteln"),
        select("style", "Pixel-Figuren", &["Pixel-Figuren", "Silhouetten"], "Stil"),
        num("rim", 1.0, 0.0, 1.0, 0.05, "Randlicht (Laternen)"),
        num("irGain", 1.6, 0.3, 4.0, 0.05, "IR-Verstärkung (Licht und Schatten)"),
        boolean("outline", true, "Dunkle Kontur"),
    ]
}

/// computeLayout() of main.js: the layout in art pixels.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(super) struct Layout {
    pub qr_right: bool,
    pub module: i64,
    pub quiet: i64,
    pub card_x: i64,
    pub card_y: i64,
    /// the text column on the other side, over the sky
    pub text_x0: i64,
    pub text_x1: i64,
    pub align_left: bool,
    pub logo_h: i64,
    pub logo_y: i64,
    pub kick_size: i64,
    pub head_size: i64,
    pub sub_size: i64,
    pub sub_y: i64,
}

fn compute_layout(aw: i64, ah: i64, p: &Params, qr_size: usize) -> Layout {
    let (awf, ahf) = (aw as f64, ah as f64);
    let m = jr(ahf * 0.045) as i64;
    let right = p.s("qrSide") != "links";
    // the QR card: as large as asked, smaller if it does not fit the height
    let quiet = 3;
    let mut module = (jr(p.f64("qrModule")) as i64).max(1);
    let mut cs = card_size(qr_size, module, quiet);
    while module > 1 && cs.1 > ah - 2 * m {
        module -= 1;
        cs = card_size(qr_size, module, quiet);
    }
    Layout {
        qr_right: right,
        module,
        quiet,
        card_x: if right { aw - m - cs.0 } else { m },
        card_y: jr((m as f64).max((ahf - cs.1 as f64) * 0.5)) as i64,
        text_x0: if right { m + 2 } else { jr(awf * 0.585) as i64 },
        text_x1: if right { jr(awf * 0.415) as i64 } else { aw - m - 2 },
        align_left: right,
        logo_h: jr(ahf * p.f64("logoSize")) as i64,
        logo_y: jr(ahf * 0.03) as i64,
        kick_size: jr(ahf * 0.075) as i64,
        head_size: jr(ahf * 0.15) as i64,
        sub_size: jr(ahf * 0.068) as i64,
        sub_y: ah - m,
    }
}

/// sublines() of main.js: the one shown at t with its change (the old one slides out downwards,
/// then the new one in) as (index, dy art px).
fn subline(count: usize, sub_every: f64, t: f64, size: i64) -> Option<(usize, i64)> {
    match count {
        0 => None,
        1 => Some((0, 0)),
        n => {
            let n = n as i64;
            let every = (SLIDE * 2.0).max(sub_every);
            let i = (t / every).floor();
            let into = t - i * every;
            let i = i as i64;
            if into >= SLIDE {
                return Some((i.rem_euclid(n) as usize, 0));
            }
            let half = SLIDE / 2.0;
            let out = into < half;
            let u = if out { into / half } else { 1.0 - (into - half) / half };
            let k = if out { (i - 1).rem_euclid(n) } else { i.rem_euclid(n) };
            Some((k as usize, jr(u * u * size as f64 * 1.6) as i64))
        }
    }
}

/// The code for `url` as overlay.js code(): ' ' for an empty one or one too long.
fn qr_code(url: &str) -> Qr {
    encode_qr(if url.is_empty() { " " } else { url }, 'M', 1).or_else(|| encode_qr(" ", 'M', 1)).unwrap_or_else(|| Qr::blank(21))
}

/// The QR code of the url param (cached by url).
struct QrCache {
    url: String,
    code: Arc<Qr>,
}

impl QrCache {
    fn new(url: &str) -> Self {
        Self { url: url.to_string(), code: Arc::new(qr_code(url)) }
    }

    fn update(&mut self, url: &str) {
        if url != self.url {
            *self = Self::new(url);
        }
    }
}

/// The art resolution for the params: (LEDs per art pixel, art width, art height).
fn art_size(width: u32, height: u32, p: &Params) -> (u32, u32, u32) {
    let px = jr(p.f64("pixel")).max(1.0) as u32;
    (px, width.div_ceil(px).max(1), height.div_ceil(px).max(1))
}

fn art_spec(width: u32, height: u32, p: &Params, qr: &QrCache, max_side: u32) -> ArtSpec {
    let (scale, aw, ah) = art_size(width, height, p);
    ArtSpec {
        aw,
        ah,
        scale,
        layout: compute_layout(i64::from(aw), i64::from(ah), p, qr.code.size),
        kicker: p.s("kicker").to_string(),
        line1: p.s("zeile1").to_string(),
        line2: p.s("zeile2").to_string(),
        subs: p.s("unterzeilen").to_string(),
        url: qr.url.clone(),
        label: p.s("adresse").to_string(),
        qr: qr.code.clone(),
        max_side,
    }
}

/// Does `s` paint what these params ask for? (no allocation: called every frame)
fn spec_is(s: &ArtSpec, width: u32, height: u32, p: &Params, qr: &QrCache) -> bool {
    let (scale, aw, ah) = art_size(width, height, p);
    s.aw == aw
        && s.ah == ah
        && s.scale == scale
        && s.url == qr.url
        && s.layout == compute_layout(i64::from(aw), i64::from(ah), p, qr.code.size)
        && s.kicker == p.s("kicker")
        && s.line1 == p.s("zeile1")
        && s.line2 == p.s("zeile2")
        && s.subs == p.s("unterzeilen")
        && s.label == p.s("adresse")
}

/// The painting shown now.
struct Shown {
    aw: u32,
    ah: u32,
    scale: u32,
    layout: Layout,
    card: [f64; 4],
    slots: Vec<SubSlot>,
}

struct LlgSakura {
    renderer: Renderer,
    sheet: Sheet,
    world: World,
    field: BodyField,
    /// tracking results in a row without person pixels
    empty_results: u32,
    painter: Painter,
    qr: QrCache,
    /// what was asked for last (shown, or the painter's next result)
    asked: ArtSpec,
    shown: Shown,
    writer: Writer,
    placements: Vec<Pl>,
    pulse: f64,
    /// frame() ms, smoothed (status line)
    ms: f64,
    /// now_ms at the scene's start
    start_ms: Option<f64>,
}

impl LlgSakura {
    /// A painting of the painter (or the setup's): shown from this frame on.
    fn show(&mut self, gpu: &Gpu, art: Art) {
        if let Some(b) = art.backdrop {
            self.renderer.upload_paint(gpu, &b.pix);
            self.world.set_scene(b.scenery);
        }
        let o = art.overlay;
        self.renderer.upload_overlay(gpu, &o.under, &o.subs.pix, &o.over);
        let s = &art.spec;
        self.shown = Shown { aw: s.aw, ah: s.ah, scale: s.scale, layout: s.layout, card: o.card, slots: o.subs.slots };
    }
}

impl Scene for LlgSakura {
    fn frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String> {
        let t0 = Instant::now();
        while let Some(art) = self.painter.poll() {
            self.show(ctx.gpu, art);
        }
        let p = ctx.params;
        // s since the scene started, in f64 as in the browser (smooth however long it runs)
        let start = *self.start_ms.get_or_insert(ctx.now_ms - f64::from(ctx.time) * 1000.0);
        let (t, dt) = ((ctx.now_ms - start) / 1000.0, f64::from(ctx.dt));

        // the painting: asked for again when the size, the layout or a text changed
        self.qr.update(p.s("url"));
        if !spec_is(&self.asked, ctx.width, ctx.height, p, &self.qr) {
            let spec = art_spec(ctx.width, ctx.height, p, &self.qr, ctx.gpu.device.limits().max_texture_dimension_2d);
            self.asked = spec.clone();
            self.painter.ask(spec);
        }

        // the bodies on the wall grid: rebuilt with every tracking result. A run of results
        // without any person pixel leaves the field empty with its kicks faded to nothing (0.45
        // per result): from then on, until somebody comes, another update would change nothing.
        if ctx.kinect.fresh.persons
            && let Some(r) = ctx.kinect.persons.clone()
        {
            self.empty_results = if r.count == 0 { self.empty_results.saturating_add(1) } else { 0 };
            if self.empty_results <= SETTLED {
                let mut rays = ctx.kinect.rays();
                if rays.len() < crate::persons::N * 2 {
                    rays = crate::kinect::pinhole_rays();
                }
                self.field.update(Some(&*r), &rays, ctx.x_sign, ctx.wall, &[], None);
            }
        }

        let place = |q: &crate::wall::Placed| Pl { id: q.id, x: f64::from(q.x), top: f64::from(q.top), feet: f64::from(q.feet), vx: f64::from(q.vx), dist: f64::from(q.dist) };
        self.placements.clear();
        self.placements.extend(ctx.wall.persons.iter().map(place));
        let view = ctx.kinect.view.clone();
        let entered = view.entered_persons().next().map(|person| ctx.wall.place(person).map(|q| place(&q)));
        let knobs = Knobs {
            petals: p.f64("petals"),
            wind: p.f64("wind"),
            stick: p.b("stick"),
            kick: p.f64("kick"),
            shake: p.f64("shake"),
            stars: p.f64("stars"),
            lanterns: p.f64("lanterns"),
            windows: p.f64("windows"),
            windows_bright: p.f64("windowsBright"),
        };
        let setup = &ctx.wall.setup;
        let wall = WallSize { w: f64::from(setup.size_w), h: f64::from(setup.size_h), bottom: f64::from(setup.bottom) };
        let (aw, ah) = (f64::from(self.shown.aw), f64::from(self.shown.ah));
        self.world.step(t, dt, &knobs, &self.field, &self.placements, entered, aw, ah, wall);

        // the QR card's frame runs while someone stands near it
        let card = self.shown.card;
        let card_x = (card[0] + card[2]) / 2.0 / (aw / wall.w);
        let near = self.placements.iter().fold(0.0f64, |n, q| n.max(((1.6 - (q.x - card_x).abs()).max(0.0) / 0.8).min(1.0) * if q.dist < 3.5 { 1.0 } else { 0.5 }));
        self.pulse += (near - self.pulse) * (1.0 - (-dt * 3.0).exp());

        let w = &mut self.writer;
        w.data.clear();
        self.world.emit_back(w, t, dt, &knobs, &self.sheet);
        let back = w.len();
        self.world.emit_front(w, t, card, self.pulse, &self.sheet);
        // the text layer: logo and headline, the subline sliding in and out, cords and card
        let full = [aw / 2.0, ah / 2.0, aw / 2.0, ah / 2.0];
        w.push(full, KIND_OVERLAY, [0.0, 0.0], [1.0; 3], 1.0, None);
        if let Some((i, dy)) = subline(self.shown.slots.len(), p.f64("subEvery"), t, self.shown.layout.sub_size)
            && let Some(s) = self.shown.slots.get(i)
        {
            let (sw, sh) = (f64::from(s.size[0]), f64::from(s.size[1]));
            let (x0, y0) = (s.x0 as f64, (s.y0 + dy) as f64);
            w.push([x0 + sw / 2.0, y0 + sh / 2.0, sw / 2.0, sh / 2.0], KIND_SUB, [f64::from(s.at[0]) - x0, f64::from(s.at[1]) - y0], [1.0; 3], 1.0, None);
        }
        w.push(full, KIND_OVER, [0.0, 0.0], [1.0; 3], 1.0, None);
        let look = Look {
            aw: self.shown.aw,
            ah: self.shown.ah,
            scale: self.shown.scale,
            time: t as f32,
            dither: p.f("dither"),
            style: if p.s("style") == "Silhouetten" { 1.0 } else { 0.0 },
            rim: p.f("rim"),
            ir_gain: p.f("irGain"),
            outline: if p.b("outline") { 1.0 } else { 0.0 },
        };
        self.renderer.render(ctx.gpu, ctx.encoder, ctx.target, ctx.kinect, &self.writer, back, &look);

        let c = self.world.counts();
        self.ms += (t0.elapsed().as_secs_f64() * 1000.0 - self.ms) * 0.05;
        ctx.status.clear();
        let _ = write!(ctx.status, "{} Person(en) · Blüten: {} in der Luft, {} auf Personen, {} am Boden · {:.1} ms", self.placements.len(), c.air, c.on, c.ground, self.ms);
        Ok(())
    }
}

fn make(ctx: &SetupCtx) -> Result<Box<dyn Scene>, String> {
    let p = &ctx.params;
    // everything painted once here (worker thread), later only what a param changes
    let qr = QrCache::new(p.s("url"));
    let spec = art_spec(ctx.width, ctx.height, p, &qr, ctx.gpu.device.limits().max_texture_dimension_2d);
    let mut caches = Caches::default();
    let art = paint_art(spec.clone(), &mut caches);
    let sheet = sprites::build_atlas();
    let o = &art.overlay;
    let renderer = Renderer::new(&ctx.gpu, &ctx.kgpu, &ctx.wall_buf, [ctx.width, ctx.height], &sheet.pix, spec.aw, spec.ah, &o.subs.pix)?;
    let mut scene = LlgSakura {
        renderer,
        sheet,
        world: World::new(),
        field: BodyField::new(0.03),
        empty_results: 0,
        painter: Painter::new(ctx.name, caches)?,
        qr,
        asked: spec,
        shown: Shown { aw: 1, ah: 1, scale: 1, layout: compute_layout(1, 1, p, 21), card: [0.0; 4], slots: Vec::new() },
        writer: Writer::new(),
        placements: Vec::with_capacity(8),
        pulse: 0.0,
        ms: 0.0,
        start_ms: None,
    };
    scene.show(&ctx.gpu, art);
    Ok(Box::new(scene))
}

pub static DEF: SceneDef = SceneDef {
    name: "llg-sakura",
    title: "LLG: Kirschblütennacht",
    params,
    projection: no_projection,
    // live: the petals react at once
    persons: live,
    streams: no_streams,
    max_fps: cap30,
    make,
};
