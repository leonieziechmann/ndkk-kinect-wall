//! Modern Events (port of web/scenes/modern-events): the sponsor's ad on the LED wall, a little
//! interactive.
//!
//! The layout (LED image): the Modern Events logo as an LED panel of dots on top, the message below
//! it ("Diese LED-Wand können Sie mieten."), a rotating subline, and the QR code to
//! modern-events.de/led-wand-mieten on a yellow card at the side. The QR card never moves and
//! nothing is drawn over it.
//!
//! The people in front of the wall appear as LED dots in a blue-violet-magenta gradient (the browser
//! scene's people.wgsl: mirrored, real size, through the shared wall core). In the logo panel they
//! light up its dots while the letters stay white, so the logo stays readable with a crowd in front.
//! Moving through the logo or waving in it splashes its dots, which spring back when one stands
//! still (panel.rs, on a grid of the bodies: common::field). Someone arriving sends a ripple
//! through the logo; with nobody there, ripples and a glint run by themselves. Near the QR card its
//! frame lights up. The texts and the link are params, so the control center can change them per
//! show entry.
//!
//! Text, letters and the QR card are painted on the CPU (paint.rs): in the setup, later in a
//! background thread when a param changes them, so a frame never waits for fonts.

mod overlay;
mod paint;
mod panel;

use std::fmt::Write as _;
use std::sync::Arc;

use wall::params::{ParamSpec, Params, boolean, num, select, text};
use wall::persons::j;
use wall::scene::{FrameCtx, Scene, SceneDef, SetupCtx, cap30, live, no_projection, no_streams};
use wall::common::field::BodyField;
use wall::common::rand::Rng;
use wall::shader_pass::ShaderPass;

use overlay::{Overlay, SubShown};
use paint::{Done, Job, LayerSpec, Painter, QrCode, SubsSpec};
use panel::LogoPanel;

const FONT: &str = "\"Segoe UI\", \"Helvetica Neue\", Arial, sans-serif";
/// s: subline change (out, then in)
const FADE: f64 = 0.8;

/// empty tracking results after which the body field is settled (kicks below 0.45^40)
const SETTLED: u32 = 40;

const PEOPLE: &str = include_str!("../../../../web/scenes/modern-events/people.wgsl");

/// Math.round
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

// the people's gradient across the wall, the same as brand() in people.wgsl
const BLUE: [f32; 3] = [0.24, 0.36, 1.0];
const VIOLET: [f32; 3] = [0.58, 0.3, 1.0];
const MAGENTA: [f32; 3] = [1.0, 0.24, 0.62];

fn brand(t: f32) -> [f32; 3] {
    let (a, b, u) = if t < 0.5 { (BLUE, VIOLET, t * 2.0) } else { (VIOLET, MAGENTA, t * 2.0 - 1.0) };
    let v = u.clamp(0.0, 1.0);
    [a[0] + (b[0] - a[0]) * v, a[1] + (b[1] - a[1]) * v, a[2] + (b[2] - a[2]) * v]
}

fn params() -> Vec<ParamSpec> {
    vec![
        text("zeile1", "Diese LED-Wand", "Zeile 1 (weiß)"),
        text("zeile2", "können Sie mieten.", "Zeile 2 (gelb)"),
        text(
            "unterzeilen",
            "Für Konzerte, Festivals, Messen und Firmenfeiern | Inklusive Anlieferung, Aufbau und Betreuung | Cottbus · Lausitz · Berlin · Dresden",
            "Unterzeilen (mit | getrennt)",
        ),
        num("subEvery", 6.0, 2.0, 30.0, 0.5, "Unterzeile wechselt alle (s)"),
        text("url", "https://modern-events.de/led-wand-mieten", "Link im QR-Code"),
        text("adresse", "modern-events.de", "Adresse unter dem Code"),
        num("qrModule", 7.0, 3.0, 10.0, 1.0, "Modulgröße (LEDs)"),
        select("qrSide", "rechts", &["rechts", "links"], "Seite"),
        num("qrBright", 1.0, 0.4, 1.0, 0.01, "Helligkeit der Karte"),
        text("logo", "MODERN EVENTS", "Logo-Text"),
        num("pitch", 6.0, 4.0, 12.0, 1.0, "Punktabstand (LEDs)"),
        num("dotSize", 0.8, 0.4, 1.0, 0.02, "Punktgröße"),
        num("logoHeight", 0.36, 0.2, 0.5, 0.01, "Höhe (Anteil der Wand)"),
        num("panel", 0.85, 0.0, 1.5, 0.01, "Helligkeit Fläche"),
        num("letters", 1.0, 0.3, 1.0, 0.01, "Helligkeit Schrift"),
        num("glint", 1.0, 0.0, 2.0, 0.05, "Glanz"),
        num("backing", 1.0, 0.0, 1.0, 0.05, "Verdeckt Personen dahinter"),
        num("kick", 1.0, 0.0, 3.0, 0.05, "Bewegung wirbelt Punkte auf"),
        num("push", 0.0, 0.0, 3.0, 0.05, "Punkte weichen Körpern aus"),
        num("springHz", 1.1, 0.2, 3.0, 0.05, "Zurückfedern (Hz)"),
        boolean("ripples", true, "Wellen (Ankunft, Leerlauf)"),
        num("attractEvery", 9.0, 3.0, 60.0, 1.0, "Welle ohne Publikum alle (s)"),
        num("people", 0.85, 0.0, 1.5, 0.01, "Helligkeit Personen"),
        num("rim", 0.45, 0.0, 1.0, 0.01, "Umriss hell"),
        num("ir", 0.5, 0.0, 1.0, 0.01, "IR-Struktur"),
        num("grid", 0.0, 0.0, 1.0, 0.01, "Raster im Hintergrund"),
    ]
}

/// computeLayout() of main.js: px on the LED image (whole numbers as in the browser).
#[derive(Clone, Copy, PartialEq, Debug)]
struct Layout {
    module: f64,
    card_bright: f64,
    card_x: f64,
    card_y: f64,
    /// x, y, w, h
    panel: [f64; 4],
    pitch: f64,
    text_x: f64,
    text_w: f64,
    head_size: f64,
    line1_y: f64,
    line2_y: f64,
    sub_size: f64,
    sub_y: f64,
}

fn layout(width: u32, height: u32, p: &Params, qr_size: usize) -> Layout {
    let (w, h) = (f64::from(width), f64::from(height));
    let m = js_round(h * 0.055);
    let pitch = js_round(p.f64("pitch")).max(3.0);
    // the QR card: as large as asked, smaller if it does not fit the height
    let card = |module: f64| {
        let side = (qr_size as f64 + 8.0) * module;
        (side, side + js_round(module * 4.6))
    };
    let mut module = js_round(p.f64("qrModule")).max(2.0);
    let mut cs = card(module);
    while module > 2.0 && cs.1 > h - 2.0 * js_round(h * 0.04) {
        module -= 1.0;
        cs = card(module);
    }
    let right = p.s("qrSide") != "links";
    let card_x = if right { w - m - cs.0 } else { m };
    let card_y = js_round((h - cs.1) / 2.0);
    // the column left (or right) of it: logo panel on top, snapped to the dot grid, text below
    let gap = js_round(m * 1.6);
    let x0 = if right { m } else { card_x + cs.0 + gap };
    let x1 = if right { card_x - gap } else { w - m };
    let px0 = (x0 / pitch).ceil() * pitch;
    let px1 = (x1 / pitch).floor() * pitch;
    let py0 = (m / pitch).ceil() * pitch;
    let rows = (h * p.f64("logoHeight") / pitch).floor().max(3.0);
    let panel = [px0, py0, px1 - px0, rows * pitch];
    let head_size = js_round(h * 0.168);
    let sub_size = js_round(h * 0.07);
    let line1_y = js_round(panel[1] + panel[3] + h * 0.03 + head_size * 0.74);
    let line2_y = js_round(line1_y + head_size * 1.04);
    let sub_y = js_round(h - m - sub_size * 0.15);
    Layout {
        module,
        card_bright: js_round(p.f64("qrBright") * 100.0) / 100.0,
        card_x,
        card_y,
        panel,
        pitch,
        text_x: panel[0] + 2.0,
        text_w: panel[2] - 4.0,
        head_size,
        line1_y,
        line2_y,
        sub_size,
        sub_y,
    }
}

/// sublines() of main.js: the one shown at t with its change (the old one fades out upwards,
/// then the new one in from below) as (index, alpha, dy px).
fn subline(count: usize, sub_every: f64, t: f64, size: f64) -> Option<(usize, f32, f32)> {
    match count {
        0 => None,
        1 => Some((0, 1.0, 0.0)),
        n => {
            let n = n as i64;
            let every = (FADE * 2.0).max(sub_every);
            let i = (t / every).floor();
            let into = t - i * every;
            let i = i as i64;
            if into >= FADE {
                return Some((i.rem_euclid(n) as usize, 1.0, 0.0));
            }
            let half = FADE / 2.0;
            let out = into < half;
            let u = if out { into / half } else { (into - half) / half };
            let e = u * u * (3.0 - 2.0 * u);
            let k = if out { (i - 1).rem_euclid(n) } else { i.rem_euclid(n) };
            let a = js_round((if out { 1.0 - e } else { e }) * 50.0) / 50.0;
            let dy = js_round((if out { -e } else { 1.0 - e }) * size * 0.5);
            Some((k as usize, a as f32, dy as f32))
        }
    }
}

/// p.logo || ' '
fn logo_text(p: &Params) -> &str {
    match p.s("logo") {
        "" => " ",
        s => s,
    }
}

/// The QR code of the url param (overlay.js code(): cached by url).
struct Qr {
    url: String,
    code: Arc<QrCode>,
}

impl Qr {
    fn new(url: &str) -> Self {
        Self { url: url.to_string(), code: Arc::new(paint::qr_code(url)) }
    }

    fn update(&mut self, url: &str) {
        if url != self.url {
            *self = Self::new(url);
        }
    }
}

fn layer_spec(width: u32, height: u32, l: &Layout, p: &Params, qr: &Qr) -> LayerSpec {
    LayerSpec {
        w: width,
        h: height,
        text_x: l.text_x,
        text_w: l.text_w,
        head_size: l.head_size,
        line1_y: l.line1_y,
        line2_y: l.line2_y,
        card_x: l.card_x,
        card_y: l.card_y,
        module: l.module,
        bright: l.card_bright,
        line1: p.s("zeile1").to_string(),
        line2: p.s("zeile2").to_string(),
        label: p.s("adresse").to_string(),
        url: qr.url.clone(),
        qr: qr.code.clone(),
    }
}

/// Does `s` show this layout and these texts? (no allocation: called every frame)
fn layer_is(s: &LayerSpec, width: u32, height: u32, l: &Layout, p: &Params, qr: &Qr) -> bool {
    s.w == width
        && s.h == height
        && s.text_x == l.text_x
        && s.text_w == l.text_w
        && s.head_size == l.head_size
        && s.line1_y == l.line1_y
        && s.line2_y == l.line2_y
        && s.card_x == l.card_x
        && s.card_y == l.card_y
        && s.module == l.module
        && s.bright == l.card_bright
        && s.line1 == p.s("zeile1")
        && s.line2 == p.s("zeile2")
        && s.label == p.s("adresse")
        && s.url == qr.url
}

fn subs_spec(l: &Layout, p: &Params, max_side: u32) -> SubsSpec {
    SubsSpec { src: p.s("unterzeilen").to_string(), size: l.sub_size, text_w: l.text_w, max_side }
}

fn subs_is(s: &SubsSpec, l: &Layout, p: &Params) -> bool {
    s.size == l.sub_size && s.text_w == l.text_w && s.src == p.s("unterzeilen")
}

struct ModernEvents {
    pass: ShaderPass,
    panel: LogoPanel,
    overlay: Overlay,
    painter: Painter,
    qr: Qr,
    field: BodyField,
    has_field: bool,
    /// tracking results in a row without person pixels
    empty_results: u32,
    pulse: f32,
    empty: f32,
    next_attract: f64,
    next_welcome: f64,
    /// now_ms at the scene's start
    start_ms: Option<f64>,
    rng: Rng,
}

impl ModernEvents {
    /// What the painter finished: shown from this frame on.
    fn take_painted(&mut self, ctx: &FrameCtx) {
        while let Some(done) = self.painter.poll() {
            match done {
                Done::Letters(spec, cells) => self.panel.set_cells(spec, cells),
                Done::Layer(layer) => self.overlay.set_layer(ctx.gpu, layer),
                Done::Subs(atlas) => self.overlay.set_subs(ctx.gpu, atlas),
            }
        }
    }

    /// Asks the painter for what the params and the layout changed.
    fn ask_painter(&mut self, ctx: &FrameCtx, p: &Params, l: &Layout) {
        if !layer_is(&self.overlay.layer_wanted, ctx.width, ctx.height, l, p, &self.qr) {
            let spec = layer_spec(ctx.width, ctx.height, l, p, &self.qr);
            self.overlay.layer_wanted = spec.clone();
            self.painter.ask(Job::Layer(Box::new(spec)));
        }
        if !subs_is(&self.overlay.subs_wanted, l, p) {
            let spec = subs_spec(l, p, ctx.gpu.device.limits().max_texture_dimension_2d);
            self.overlay.subs_wanted = spec.clone();
            self.painter.ask(Job::Subs(spec));
        }
    }
}

impl Scene for ModernEvents {
    fn frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String> {
        self.take_painted(ctx);
        let p = ctx.params;
        // s since the scene started, in f64 as in the browser (ripples and fades stay smooth however long it runs)
        let start = *self.start_ms.get_or_insert(ctx.now_ms - f64::from(ctx.time) * 1000.0);
        let (t, dt) = ((ctx.now_ms - start) / 1000.0, ctx.dt);
        self.qr.update(p.s("url"));
        let l = layout(ctx.width, ctx.height, p, self.qr.code.size);
        self.panel.want(ctx.gpu, l.panel, l.pitch, logo_text(p), Some(&self.painter));
        self.ask_painter(ctx, p, &l);

        // the bodies: rebuilt with every tracking result. A run of results without any person
        // pixel leaves the field empty with its kicks faded to nothing (0.45 per result): from then
        // on, until somebody comes, another update would change nothing that is used.
        if ctx.kinect.fresh.persons
            && let Some(r) = ctx.kinect.persons.clone()
        {
            self.empty_results = if r.count == 0 { self.empty_results.saturating_add(1) } else { 0 };
            if self.empty_results <= SETTLED {
                let mut rays = ctx.kinect.rays();
                if rays.len() < wall::persons::N * 2 {
                    rays = wall::kinect::pinhole_rays();
                }
                self.field.update(Some(&*r), &rays, ctx.x_sign, ctx.wall, &[], None);
                self.has_field = self.field.covered > 0.0;
            }
        }

        // ripples: someone arrives (from their head), or nobody there for a while
        let panel_bottom = (l.panel[1] + l.panel[3]) as f32;
        if p.b("ripples") {
            let view = ctx.kinect.view.clone();
            for person in view.entered_persons() {
                if t < self.next_welcome {
                    break; // a group arriving is one wave
                }
                self.next_welcome = t + 1.5;
                let head = match ctx.wall.joint(person, j::HEAD) {
                    Some(h) => [h.x, h.y],
                    None => [ctx.wall.place(person).map(|q| q.x).unwrap_or(3.0), 1.5],
                };
                let [x, y] = ctx.wall.px(head[0], head[1]);
                self.panel.ripple(x, y.min(panel_bottom), 0.6, t);
            }
            self.empty = if ctx.wall.persons.is_empty() { self.empty + dt } else { 0.0 };
            if self.empty > 3.0 && t > self.next_attract {
                let [rx, ry, rw, rh] = l.panel;
                let x = rx as f32 + self.rng.f32() * rw as f32;
                let y = if self.rng.f32() < 0.5 { (ry + rh) as f32 } else { ry as f32 };
                self.panel.ripple(x, y, 0.8, t);
                self.next_attract = t + p.f64("attractEvery") * (0.8 + self.rng.f64() * 0.4);
            }
        }
        let field = if self.has_field { Some(&self.field) } else { None };
        let moved = self.panel.step(field, p, ctx.wall, ctx.width, ctx.height, dt, t);

        // the subline shown now
        let shown = subline(self.overlay.sub_count(), p.f64("subEvery"), t, l.sub_size).map(|(index, alpha, dy)| SubShown {
            index,
            alpha,
            dy,
            x: l.text_x as f32,
            y: l.sub_y as f32,
            clip: [
                (l.text_x - 10.0) as f32,
                (l.sub_y - l.sub_size * 1.3) as f32,
                (l.text_x - 10.0 + l.text_w + 20.0) as f32,
                (l.sub_y - l.sub_size * 1.3 + l.sub_size * 1.75) as f32,
            ],
        });

        // the QR card's frame lights up while someone stands near it (wall m, up to 1.6 m beside it)
        let [cx0, _, cx1, _] = self.overlay.card();
        let card_x = (cx0 + cx1) / 2.0 * ctx.wall.setup.size_w / ctx.width.max(1) as f32;
        let near = ctx.wall.persons.iter().fold(0.0f32, |n, q| n.max(((1.6 - (q.x - card_x).abs()).max(0.0) / 0.8).min(1.0) * if q.dist < 3.5 { 1.0 } else { 0.5 }));
        self.pulse += (near - self.pulse) * (1.0 - (-dt * 3.0).exp());

        self.pass.render(ctx);
        self.panel.prepare(ctx.gpu, p, t, ctx.width, ctx.height, brand);
        self.overlay.prepare(ctx.gpu, [ctx.width as f32, ctx.height as f32], t as f32, self.pulse, shown);
        {
            let mut pass = ctx.encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("modern-events"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: ctx.target,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            self.panel.draw(&mut pass);
            self.overlay.draw(&mut pass);
        }
        ctx.status.clear();
        let _ = write!(ctx.status, "{} Person(en), {} Logo-Punkte unterwegs", ctx.wall.persons.len(), moved);
        Ok(())
    }
}

fn make(ctx: &SetupCtx) -> Result<Box<dyn Scene>, String> {
    let (w, h) = (ctx.width, ctx.height);
    let p = &ctx.params;
    let pass = ShaderPass::new(&ctx.gpu, &ctx.kgpu, &ctx.wall_buf, [w, h], ctx.name, &p.specs, PEOPLE, false)?;
    // everything painted once here (worker thread), later only what a param changes
    let qr = Qr::new(p.s("url"));
    let l = layout(w, h, p, qr.code.size);
    let (cols, rows) = panel::grid(l.panel, l.pitch);
    let mut panel = LogoPanel::new(&ctx.gpu, cols * rows)?;
    panel.want(&ctx.gpu, l.panel, l.pitch, logo_text(p), None);
    let lspec = layer_spec(w, h, &l, p, &qr);
    let layer = paint::paint_layer(&lspec);
    let sspec = subs_spec(&l, p, ctx.gpu.device.limits().max_texture_dimension_2d);
    let atlas = paint::paint_subs(&sspec);
    let overlay = Overlay::new(&ctx.gpu, lspec, layer, sspec, atlas)?;
    Ok(Box::new(ModernEvents {
        pass,
        panel,
        overlay,
        painter: Painter::new(ctx.name)?,
        qr,
        field: BodyField::new(0.03),
        has_field: false,
        empty_results: 0,
        pulse: 0.0,
        empty: 0.0,
        next_attract: 2.0,
        next_welcome: 0.0,
        start_ms: None,
        rng: Rng::from_time(),
    }))
}

pub static DEF: SceneDef = SceneDef {
    name: "modern-events",
    title: "Modern Events: LED-Wand mieten",
    params,
    projection: no_projection,
    // live: the logo reacts at once
    persons: live,
    streams: no_streams,
    max_fps: cap30,
    make,
};

wall::export_scenes!(&DEF);
