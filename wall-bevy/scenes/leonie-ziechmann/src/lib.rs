//! Leonie Ziechmann: Birkenwald (port of web/scenes/leonie-ziechmann): the ad of the one who built
//! this installation, in the look of betula.app (light theme cards): a mystic birch wood in autumn,
//! several layers deep, darker and denser towards the back, a warm light far behind it, golden
//! crowns, mist, rolling ground with heather; Betula's white card, Inter, the green accent.
//!
//! Top left the contact card ("Installation von" / the name / "Softwareentwicklung und IT
//! Solutions" / mail and phone). Bottom right the QR codes to betula.app and GitHub as signs on
//! birch posts, the same size, half buried in a leaf heap, with a signpost "Mehr von mir hier".
//!
//! People in front of the wall walk through the wood as soft, cool shadows, between the trees: in
//! front of the birches farther away than they are, behind the nearer ones. Walking towards a sign
//! blows the heap away and the code comes out whole; reaching into the crowns or jumping shakes
//! leaves loose; moving sweeps the falling leaves along; leaves settle on whoever stands still;
//! feet stir up the leaves on the floor; someone arriving sends a gust across the wall. With nobody
//! there the heap grows back and gusts come by themselves.
//!
//! Files: layout.rs (where things are, Betula's colors), forest.rs (the wood in layers), leafpix.rs
//! (pixel leaves), leaves.rs (what falls and flies), heap.rs (the leaf heap), cards.rs (card, signs,
//! signpost), persp.rs (the people in perspective), render.rs (the compositor), paint.rs (the
//! background painter), bodies.rs (the body field of common::field, in a thread). The QR encoder is
//! common::qr.
//!
//! As in the browser, the wood, the cards and the heap's shape are painted on the CPU (in the setup,
//! later in the background when a param changes them), the leaves and the heap every frame into one
//! layer (the heap only when it changed), and one fullscreen pass composes everything on the GPU.

mod bodies;
mod cards;
mod forest;
mod heap;
mod layout;
mod leafpix;
mod leaves;
mod paint;
mod persp;
mod render;

use std::fmt::Write as _;
use std::sync::Arc;

use serde_json::json;

use wall::params::{ParamSpec, Params, boolean, color, num, select, text};
use wall::scene::{FrameCtx, Scene, SceneDef, SetupCtx, cap30, live, no_streams};
use wall::common::qr::{Qr, encode_qr};
use wall::common::rand::Rng;

use cards::{CardsSpec, Code};
use forest::{DEPTHS, FEET, Rolling, Spot};
use heap::{Heap, HeapSpec};
use layout::{Layout, SIGN_DEPTH, js_round};
use leaves::{LeafParams, Leaves, RestRect};
use paint::{Done, ForestKey, Job, Painter};
use persp::{Perspective, PerspPersons};
use render::{Renderer, Uniforms};

fn params() -> Vec<ParamSpec> {
    vec![
        text("eyebrow", "Installation von", "Kleine Zeile oben"),
        text("name", "Leonie Ziechmann", "Name"),
        text("lead", "Softwareentwicklung und IT Solutions", "Unterzeile"),
        text("mail", "info@leonieziechmann.de", "E-Mail"),
        text("phone", "+49 171 2077119", "Telefon"),
        text("qrTitle", "Mehr von mir hier", "Wegweiser"),
        select("links", "beide", &["beide", "Betula", "GitHub"], "QR-Schilder"),
        text("link1", "https://betula.app", "Link 1"),
        text("label1", "betula.app", "Link 1: Name"),
        text("small1", "BTU-Modulkatalog", "Link 1: Zusatz"),
        text("link2", "https://github.com/leonieziechmann", "Link 2"),
        text("label2", "GitHub", "Link 2: Name"),
        text("small2", "@leonieziechmann", "Link 2: Zusatz"),
        num("qrModule", 3.0, 2.0, 5.0, 1.0, "Modulgröße (LEDs)"),
        boolean("heap", true, "Laubhaufen vor den Schildern"),
        num("blow", 1.0, 0.2, 3.0, 0.05, "Wegpusten (Empfindlichkeit)"),
        num("regrow", 40.0, 5.0, 180.0, 1.0, "Wächst nach in (s)"),
        num("regrowDelay", 6.0, 0.0, 60.0, 1.0, "Wächst erst nach (s) Ruhe"),
        boolean("backWood", true, "Nur im hinteren Wald"),
        num("backNear", 3.0, 1.5, 5.0, 0.05, "Hinterer Wald ab (m Tiefe)"),
        num("backFar", 5.5, 2.0, 9.0, 0.05, "Hinterer Wald bis (m Tiefe)"),
        num("nearSize", 1.0, 0.4, 2.0, 0.01, "Größe (1 = echt bei 1,5 m Tiefe)"),
        num("near", 0.78, 0.0, 1.0, 0.01, "Schatten nah"),
        num("far", 0.45, 0.0, 1.0, 0.01, "Schatten fern"),
        num("soft", 2.2, 0.5, 6.0, 0.1, "Weiche Kante"),
        color("tint", "#0a0c19", "Schattenfarbe"),
        num("depth1", DEPTHS[0], 0.5, 5.0, 0.05, "Bäume hinten (m vom Sensor)"),
        num("depth2", DEPTHS[1], 0.5, 5.0, 0.05, "Bäume Mitte (m)"),
        num("depth3", DEPTHS[2], 0.5, 5.0, 0.05, "Bäume vorn (m)"),
        num("signDepth", SIGN_DEPTH, 0.5, 5.0, 0.05, "Schilder (m)"),
        num("hell", 1.0, 0.3, 1.0, 0.01, "Helligkeit gesamt"),
        num("cardAlpha", 0.97, 0.6, 1.0, 0.01, "Kontaktkarte deckend"),
        num("laub", 3.0, 0.0, 20.0, 0.5, "Blätter pro Sekunde (Ruhe)"),
        num("shake", 1.0, 0.0, 3.0, 0.05, "Kronen schütteln"),
        num("wind", 1.0, 0.0, 2.5, 0.05, "Wind"),
        num("kick", 1.0, 0.0, 3.0, 0.05, "Bewegung wirbelt auf"),
        boolean("stick", true, "Blätter bleiben auf Personen liegen"),
        boolean("cards", true, "Blätter landen auf Karte und Schildern"),
        num("pile", 220.0, 0.0, 600.0, 10.0, "Blätter am Boden (höchstens)"),
    ]
}

/// The links shown and their codes, all in the same version (the same size): main.js codesFor().
struct Links {
    sel: String,
    url1: String,
    url2: String,
    /// (link number 1/2, code) per shown link
    qrs: Vec<(u8, Arc<Qr>)>,
}

impl Links {
    fn new(p: &Params) -> Self {
        let mut l = Self { sel: String::new(), url1: String::new(), url2: String::new(), qrs: Vec::new() };
        l.update(p);
        l
    }

    /// Codes again if the links changed (not every frame).
    fn update(&mut self, p: &Params) {
        if self.sel == p.s("links") && self.url1 == p.s("link1") && self.url2 == p.s("link2") && !self.qrs.is_empty() {
            return;
        }
        self.sel = p.s("links").to_string();
        self.url1 = p.s("link1").to_string();
        self.url2 = p.s("link2").to_string();
        let mut shown: Vec<(u8, &str)> = Vec::new();
        if self.sel != "GitHub" {
            shown.push((1, &self.url1));
        }
        if self.sel != "Betula" {
            shown.push((2, &self.url2));
        }
        let safe = |u: &str, v: u8| encode_qr(if u.is_empty() { " " } else { u }, 'M', v).or_else(|| encode_qr(" ", 'M', v)).unwrap_or_else(|| Qr::blank(17 + 4 * usize::from(v)));
        let version = |q: &Qr| ((q.size.saturating_sub(17)) / 4).clamp(1, 40) as u8;
        let v = shown.iter().map(|(_, u)| version(&safe(u, 1))).max().unwrap_or(1).max(1);
        self.qrs = shown.iter().map(|(i, u)| (*i, Arc::new(safe(u, v)))).collect();
    }

    /// the shown codes with their texts (main.js codes)
    fn codes(&self, p: &Params) -> Vec<Code> {
        self.qrs
            .iter()
            .map(|(i, qr)| {
                let (url, label, small) = if *i == 1 { ("link1", "label1", "small1") } else { ("link2", "label2", "small2") };
                let u = p.s(url);
                let lower = u.to_lowercase();
                Code { url: u.to_string(), label: p.s(label).to_string(), small: p.s(small).to_string(), qr: qr.clone(), mark: lower.contains("betula.app"), github: lower.contains("github.com") }
            })
            .collect()
    }

    /// do these codes still show these params? (no allocation)
    fn codes_are(&self, codes: &[Code], p: &Params) -> bool {
        codes.len() == self.qrs.len()
            && codes.iter().zip(&self.qrs).all(|(c, (i, qr))| {
                let (url, label, small) = if *i == 1 { ("link1", "label1", "small1") } else { ("link2", "label2", "small2") };
                Arc::ptr_eq(&c.qr, qr) && c.url == p.s(url) && c.label == p.s(label) && c.small == p.s(small)
            })
    }

    fn qr_size(&self) -> usize {
        self.qrs.first().map(|(_, q)| q.size).unwrap_or(29)
    }
}

/// Math.round(p.cardAlpha * 100) / 100
fn card_alpha(p: &Params) -> f64 {
    js_round(p.f64("cardAlpha") * 100.0) / 100.0
}

fn cards_spec(l: &Layout, p: &Params, links: &Links) -> CardsSpec {
    CardsSpec {
        layout: l.clone(),
        eyebrow: p.s("eyebrow").to_string(),
        name: p.s("name").to_string(),
        lead: p.s("lead").to_string(),
        mail: p.s("mail").to_string(),
        phone: p.s("phone").to_string(),
        title: p.s("qrTitle").to_string(),
        codes: links.codes(p),
        alpha: card_alpha(p),
    }
}

/// does the spec still show this layout and these params? (no allocation: called every frame)
fn cards_is(s: &CardsSpec, l: &Layout, p: &Params, links: &Links) -> bool {
    s.layout == *l
        && s.eyebrow == p.s("eyebrow")
        && s.name == p.s("name")
        && s.lead == p.s("lead")
        && s.mail == p.s("mail")
        && s.phone == p.s("phone")
        && s.title == p.s("qrTitle")
        && s.alpha == card_alpha(p)
        && links.codes_are(&s.codes, p)
}

/// what computeLayout() depends on: size, module, code size, number of codes
type LayoutKey = (u32, u32, f64, usize, usize);

fn layout_key(w: u32, h: u32, p: &Params, links: &Links) -> LayoutKey {
    (w, h, p.f64("qrModule"), links.qr_size(), links.qrs.len())
}

struct LeonieZiechmann {
    renderer: Renderer,
    persons: PerspPersons,
    painter: Painter,
    links: Links,
    layout_key: LayoutKey,
    layout: Layout,
    /// what was asked for last (shown, or the painter's next result)
    forest_asked: ForestKey,
    cards_asked: CardsSpec,
    heap_asked: HeapSpec,
    /// of the wood shown: where leaves come from, the near ground
    spots: Vec<Spot>,
    ground: Option<Rolling>,
    /// the contact card as painted: x, y, w, h
    hero: [f64; 4],
    persp: Perspective,
    bodies: bodies::Bodies,
    cleared: bool,
    last_persons: f64,
    heap: Heap,
    leaves: Leaves,
    /// the leaves' layer (u32 RGBA per LED)
    buf: Vec<u32>,
    rects: Vec<RestRect>,
    entered: Vec<u32>,
    /// ms of the heap and the leaves (smoothed, for the status line)
    ms: f64,
    rng: Rng,
    /// now_ms at the scene's start (the scene's own clock in f64)
    start_ms: Option<f64>,
}

impl LeonieZiechmann {
    /// What the painter finished: shown from this frame on (one result per frame: the uploads of
    /// several megabytes do not pile up in one frame).
    fn take_painted(&mut self, gpu: &wall::gpu::Gpu) {
        if let Some(done) = self.painter.poll() {
            match done {
                Done::Forest(f) => {
                    self.renderer.set_forest(gpu, &f.layers);
                    self.spots = f.spots;
                    self.ground = f.ground;
                }
                Done::Cards(c) => {
                    self.renderer.set_cards(gpu, &c.pixels);
                    self.hero = c.hero;
                }
                Done::Heap(h) => self.heap.set_shape(*h),
            }
        }
    }
}

impl Scene for LeonieZiechmann {
    fn frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String> {
        let p = ctx.params;
        let (w, h) = (ctx.width, ctx.height);
        // s since the scene started, in f64 (gusts and the heap's clock stay exact however long it runs)
        let start = *self.start_ms.get_or_insert(ctx.now_ms - f64::from(ctx.time) * 1000.0);
        let t = (ctx.now_ms - start) / 1000.0;
        let dt = f64::from(ctx.dt);
        self.take_painted(ctx.gpu);

        // the links shown, their codes all the same size; the layout
        self.links.update(p);
        let lk = layout_key(w, h, p, &self.links);
        if lk != self.layout_key {
            self.layout = layout::compute(w, h, p.f64("qrModule"), self.links.qr_size(), self.links.qrs.len());
            self.layout_key = lk;
        }
        let l = &self.layout;

        // GPU textures for the LED size; a new size paints everything again
        let person_new = self.persons.ensure(ctx.gpu, ctx.wall.led());
        let resized = self.renderer.ensure(ctx.gpu, w, h, &self.persons.view, person_new);
        if resized {
            self.buf = vec![0; w as usize * h as usize];
        }
        // the wood, the cards, the heap's shape: painted in the background when they change
        if resized || !self.forest_asked.is(l) {
            self.forest_asked = ForestKey::new(l);
            self.painter.ask(Job::Forest(Box::new(l.clone())));
        }
        if resized || !cards_is(&self.cards_asked, l, p, &self.links) {
            self.cards_asked = cards_spec(l, p, &self.links);
            self.painter.ask(Job::Cards(Box::new(self.cards_asked.clone())));
        }
        if !self.heap_asked.is(l, &ctx.wall.setup) {
            self.heap_asked = HeapSpec::new(l, &ctx.wall.setup);
            self.painter.ask(Job::Heap(Box::new(self.heap_asked.clone())));
        }

        // the people in perspective: smaller and higher up the farther away, sideways by the view's angle
        self.persp.configure(p, l.w, l.h, l.s, ctx.wall, FEET);
        self.persp.update(ctx.wall, dt);
        // the bodies: rebuilt with every tracking result (bodies.rs: in the background, the newest
        // finished one is used); cleared once nothing came for a second
        self.bodies.poll();
        if ctx.kinect.fresh.persons
            && let Some(r) = ctx.kinect.persons.clone()
        {
            let mut rays = ctx.kinect.rays();
            if rays.len() < wall::persons::N * 2 {
                rays = wall::kinect::pinhole_rays();
            }
            self.bodies.update(r, rays, ctx.x_sign, ctx.wall, &self.persp.place);
            self.last_persons = t;
            self.cleared = false;
        } else if t - self.last_persons > 1.0 && !self.cleared {
            self.cleared = self.bodies.clear();
        }
        let field = self.bodies.field.as_ref().filter(|f| f.w > 0);

        // the heap and the leaves
        let t0 = std::time::Instant::now();
        let setup = &ctx.wall.setup;
        self.rects.clear();
        self.rects.push(RestRect { x: self.hero[0], y: self.hero[1], w: self.hero[2], h: self.hero[3], angle: 0.0, top: None, bw: None, sign: false });
        for g in l.signs.iter().take(self.links.qrs.len()) {
            self.rects.push(RestRect { x: g.x, y: g.y, w: g.w, h: g.h, angle: g.angle, top: Some(g.top), bw: Some(g.bw), sign: true });
        }
        if !p.s("qrTitle").is_empty() {
            let q = &l.post;
            self.rects.push(RestRect { x: q.x, y: q.y, w: q.w, h: q.h, angle: q.angle, top: None, bw: None, sign: true });
        }
        self.leaves.layout(l.w, l.h, l.s, l.ground, l.canopy, setup.size_w, setup.size_h, setup.bottom, &self.spots, &self.rects, self.ground);
        let places = &self.persp.places;
        self.heap.update(t, dt, p.b("heap"), p.f64("blow"), p.f64("regrow"), p.f64("regrowDelay"), places, &mut self.leaves, field, &mut self.rng);
        self.entered.clear();
        self.entered.extend(ctx.kinect.view.entered_persons().map(|q| q.id));
        let lp = LeafParams { laub: p.f64("laub"), shake: p.f64("shake"), wind: p.f64("wind"), kick: p.f64("kick"), stick: p.b("stick"), cards: p.b("cards"), pile: p.f64("pile") };
        self.leaves.update(t, dt, &lp, field, places, &self.entered, &mut self.heap);
        self.buf.fill(0);
        let mut drawn = self.leaves.draw(&mut self.buf, true);
        self.heap.draw(&mut self.buf, w as usize, h as usize);
        drawn += self.leaves.draw(&mut self.buf, false);
        self.renderer.set_leaves(ctx.gpu, bytemuck::cast_slice(&self.buf));
        self.ms = self.ms * 0.95 + t0.elapsed().as_secs_f64() * 1000.0 * 0.05;

        // the person pixels in perspective, then the compositor
        self.persons.update(ctx.gpu, ctx.encoder, ctx.kinect, &self.persp.place.slots);
        let back = if p.b("backWood") { [p.f("backNear"), p.f("backFar")] } else { [1.0, 4.0] };
        let u = Uniforms {
            s: l.s as f32,
            bright: p.f("hell"),
            near: p.f("near"),
            far: p.f("far"),
            soft: p.f("soft"),
            tint: p.color("tint"),
            ground: l.ground as f32,
            depths: [p.f("depth1"), p.f("depth2"), p.f("depth3"), p.f("signDepth")],
            back,
        };
        self.renderer.render(ctx.gpu, ctx.encoder, ctx.target, ctx.time, &u);
        ctx.status.clear();
        let _ = write!(ctx.status, "{} Person(en), {} Blätter, Haufen {} %, Laub {:.1} ms", self.persp.places.len(), drawn, js_round(self.heap.cover() * 100.0), self.ms);
        Ok(())
    }
}

fn make(ctx: &SetupCtx) -> Result<Box<dyn Scene>, String> {
    let (w, h) = (ctx.width, ctx.height);
    let p = &ctx.params;
    let links = Links::new(p);
    let layout_key = layout_key(w, h, p, &links);
    let l = layout::compute(w, h, p.f64("qrModule"), links.qr_size(), links.qrs.len());
    // everything painted once here (worker thread), later only what a param changes (paint.rs)
    let wood = forest::paint(&l);
    let cards_asked = cards_spec(&l, p, &links);
    let painted = cards::paint(&cards_asked);
    let heap_asked = HeapSpec::new(&l, &ctx.wall.setup);
    let mut heap = Heap::new();
    heap.set_shape(heap::shape(&heap_asked));
    let persons = PerspPersons::new(&ctx.gpu, &ctx.kgpu, &ctx.wall_buf, ctx.wall.led())?;
    let renderer = Renderer::new(&ctx.gpu, w, h, &persons.view)?;
    renderer.set_forest(&ctx.gpu, &wood.layers);
    renderer.set_cards(&ctx.gpu, &painted.pixels);
    Ok(Box::new(LeonieZiechmann {
        renderer,
        persons,
        painter: Painter::new(ctx.name)?,
        links,
        layout_key,
        forest_asked: ForestKey::new(&l),
        layout: l,
        cards_asked,
        heap_asked,
        spots: wood.spots,
        ground: wood.ground,
        hero: painted.hero,
        persp: Perspective::new(),
        bodies: bodies::Bodies::new(ctx.name, ctx.wall.clone())?,
        cleared: false,
        last_persons: 0.0,
        heap,
        leaves: Leaves::new(),
        buf: vec![0; w as usize * h as usize],
        rects: Vec::with_capacity(4),
        entered: Vec::new(),
        ms: 0.0,
        rng: Rng::from_time(),
        start_ms: None,
    }))
}

pub static DEF: SceneDef = SceneDef {
    name: "leonie-ziechmann",
    title: "Leonie Ziechmann: Birkenwald",
    params,
    // sideways by the angle in the Kinect's view (the play field is the view cone: far back one walks
    // further to cross the wall); held 0.18 m inside the wall's edges
    projection: || json!({ "field": "cone", "edge": "clamp", "margin": 0.18, "smoothing": 0.15 }),
    // live: the heap and the leaves react at once
    persons: live,
    streams: no_streams,
    max_fps: cap30,
    make,
};

wall::export_scenes!(&DEF);
