//! Blasen platzen (port of web/scenes/blasen-platzen): a game for the LED wall (6 m x 2 m, 1008 x
//! 336 LEDs). Soap bubbles float up the wall, the people pop them with their bodies. No rules to
//! explain, people can join and leave at any time, and it works with one person as with ten.
//!
//! The wall core (ctx.wall) puts every person pixel onto the wall: mirrored, the walk stretched over
//! the whole wall, bodies in real size (meters, not pixels: standing closer to the sensor gives no
//! advantage). Person tracking in live mode. Hits are measured on the masks (grid.rs), the game is in
//! game.rs, the sound in sound.rs. The browser scene's own render.wgsl draws the silhouettes (from the
//! grid) and every sprite (bubbles, rings, droplets, digits) as instanced quads, added onto black.

mod game;
mod grid;
mod sound;

use std::fmt::Write as _;

use serde_json::json;

use wall::gpu::{Gpu, TARGET_FORMAT, layout};
use wall::params::{ParamSpec, Params, boolean, num};
use wall::persons::{PersonOptions, hex_rgb};
use wall::scene::{FrameCtx, Scene, SceneDef, SetupCtx, no_cap, no_streams};

use game::{FxKind, Game, GameParams, Player, World, neon};
use grid::WallGrid;
use sound::Sound;

const RENDER: &str = include_str!("../../../../web/scenes/blasen-platzen/render.wgsl");

/// silhouette colors per slot: neon, no yellow or green (dim, they look olive)
const PALETTE: [&str; 10] = ["#29e6ff", "#ff3fd0", "#9a6bff", "#4d8dff", "#ff5c7a", "#3dffc0", "#c58bff", "#a8e6ff", "#ff8be8", "#00c2b8"];
const SPRITE_FLOATS: usize = 16;
const MAX_SPRITES: usize = 8192;
// sprite kinds of render.wgsl
const FX_BUBBLE: f32 = 0.0;
const FX_RING: f32 = 1.0;
const FX_DOT: f32 = 2.0;
const FX_GLYPH: f32 = 3.0;
// glyphs besides the digits: '+' and '*' (a star)
const PLUS: u8 = 10;
const STAR: u8 = 11;

/// PALETTE and PALETTE_SIZE for render.wgsl (main.js HEAD). Put after the file: WGSL declarations may
/// come in any order, and the file's line numbers stay as they are.
fn palette_wgsl() -> String {
    let cols: Vec<String> = PALETTE
        .iter()
        .map(|h| {
            let c = hex_rgb(h);
            format!("vec3f({:.3}, {:.3}, {:.3})", c[0], c[1], c[2])
        })
        .collect();
    format!("\nconst PALETTE_SIZE = {}u;\nconst PALETTE = array<vec3f, {}>({});\n", PALETTE.len(), PALETTE.len(), cols.join(", "))
}

fn slot_color(s: u8) -> [f32; 3] {
    if s == 0 { [1.0, 1.0, 1.0] } else { hex_rgb(PALETTE[(usize::from(s) - 1) % PALETTE.len()]) }
}

fn ease_out_back(u: f64) -> f64 {
    1.0 + 2.2 * (u - 1.0).powi(3) + 1.2 * (u - 1.0).powi(2)
}

fn params() -> Vec<ParamSpec> {
    vec![
        // Spiel
        boolean("live", true, "Live (weniger Verzögerung)"),
        num("count", 6.0, 0.0, 40.0, 1.0, "Blasen (Grundmenge)"),
        num("perPerson", 4.0, 0.0, 12.0, 1.0, "Blasen pro Person"),
        num("idleCount", 8.0, 0.0, 40.0, 1.0, "Blasen ohne Publikum"),
        num("size", 1.0, 0.4, 2.5, 0.05, "Größe"),
        num("speed", 1.0, 0.2, 3.0, 0.05, "Tempo"),
        num("popSpeed", 0.8, 0.1, 3.0, 0.05, "Platzen ab (m/s)"),
        num("push", 0.6, 0.0, 3.0, 0.05, "Wegschieben"),
        num("starChance", 0.04, 0.0, 0.3, 0.01, "Sterne (Anteil)"),
        num("giantChance", 0.06, 0.0, 0.3, 0.01, "Riesenblasen (Anteil)"),
        num("chainRadius", 1.2, 0.3, 3.0, 0.05, "Stern-Kette (m)"),
        num("waveEvery", 60.0, 10.0, 400.0, 5.0, "Welle alle … Blasen"),
        num("resetAfter", 8.0, 2.0, 60.0, 1.0, "Neue Runde nach (s leer)"),
        boolean("numbers", true, "Punkte zeigen"),
        // Bild
        num("fill", 0.16, 0.0, 1.0, 0.01, "Körper füllen"),
        num("outline", 1.0, 0.0, 2.0, 0.05, "Umriss"),
        num("motionGlow", 0.8, 0.0, 2.0, 0.05, "Bewegung leuchtet"),
        num("brightness", 1.0, 0.2, 2.0, 0.05, "Helligkeit"),
        boolean("sound", true, "Ton"),
        num("volume", 0.5, 0.0, 1.0, 0.01, "Lautstärke"),
        boolean("showFresh", false, "Treffer-Zellen zeigen (Test)"),
    ]
}

fn persons(p: &Params) -> Option<PersonOptions> {
    Some(if p.b("live") { PersonOptions::live() } else { PersonOptions::exact() })
}

fn game_params(p: &Params) -> GameParams {
    GameParams {
        count: p.f64("count"),
        per_person: p.f64("perPerson"),
        idle_count: p.f64("idleCount"),
        size: p.f64("size"),
        speed: p.f64("speed"),
        pop_speed: p.f64("popSpeed"),
        push: p.f64("push"),
        star_chance: p.f64("starChance"),
        giant_chance: p.f64("giantChance"),
        chain_radius: p.f64("chainRadius"),
        wave_every: p.f64("waveEvery"),
        reset_after: p.f64("resetAfter"),
        numbers: p.b("numbers"),
    }
}

/// The glyphs of a number, with a sign before it ('+', '*'), without allocating.
struct Digits {
    g: [u8; 24],
    n: usize,
}

impl Digits {
    fn new(prefix: Option<u8>, v: u64) -> Self {
        let mut g = [0u8; 24];
        let mut n = 0;
        if let Some(p) = prefix {
            g[0] = p;
            n = 1;
        }
        let mut rev = [0u8; 20];
        let (mut k, mut x) = (0, v);
        loop {
            rev[k] = (x % 10) as u8;
            k += 1;
            x /= 10;
            if x == 0 {
                break;
            }
        }
        while k > 0 {
            k -= 1;
            g[n] = rev[k];
            n += 1;
        }
        Self { g, n }
    }

    fn glyphs(&self) -> &[u8] {
        &self.g[..self.n]
    }
}

/// The sprites of a frame (struct Sprite in render.wgsl): a = center (wall m, y up) and half size
/// (m); col = rgb, intensity; k = kind, then per kind; d.w = margin of the quad.
struct Sprites {
    data: Vec<f32>,
    n: usize,
}

impl Sprites {
    #[allow(clippy::too_many_arguments)]
    fn put(&mut self, x: f64, y: f64, sx: f64, sy: f64, col: [f32; 3], a: f64, kind: f32, k: [f32; 3], margin: f32) {
        if self.n >= MAX_SPRITES {
            return;
        }
        let o = self.n * SPRITE_FLOATS;
        self.n += 1;
        if let Some(d) = self.data.get_mut(o..o + SPRITE_FLOATS) {
            d.copy_from_slice(&[x as f32, y as f32, sx as f32, sy as f32, col[0], col[1], col[2], a as f32, kind, k[0], k[1], k[2], 0.0, 0.0, 0.0, margin]);
        }
    }

    /// digits, '+' and '*' (a star); x is the center of the text
    fn text(&mut self, glyphs: &[u8], x: f64, y: f64, h: f64, col: [f32; 3], a: f64) {
        let adv = h * 0.78;
        let x0 = x - adv * (glyphs.len() as f64 - 1.0) / 2.0;
        for (i, g) in glyphs.iter().enumerate() {
            self.put(x0 + i as f64 * adv, y, h * 0.31, h * 0.5, col, a, FX_GLYPH, [f32::from(*g), 0.0, 0.0], 1.35);
        }
    }
}

struct BlasenPlatzen {
    people_pipe: wgpu::RenderPipeline,
    sprite_pipe: wgpu::RenderPipeline,
    bgl: wgpu::BindGroupLayout,
    uniform: wgpu::Buffer,
    sprite_buf: wgpu::Buffer,
    sampler: wgpu::Sampler,
    grid: WallGrid,
    /// the wall size the grid was made for
    grid_key: (u32, u32),
    grid_tex: wgpu::Texture,
    group: wgpu::BindGroup,
    sprites: Sprites,
    game: Game,
    sound: Sound,
    /// the people for the game (in the zone), this frame
    people: Vec<Player>,
    /// ctx.time of the last tracking result, -1 before the first
    last_persons: f32,
    last_seq: Option<u32>,
}

fn grid_texture(gpu: &Gpu, grid: &WallGrid) -> wgpu::Texture {
    gpu.texture("blasen-platzen grid", grid.w as u32, grid.h as u32, wgpu::TextureFormat::Rgba8Unorm, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST)
}

fn bind_group(gpu: &Gpu, bgl: &wgpu::BindGroupLayout, uniform: &wgpu::Buffer, tex: &wgpu::Texture, sampler: &wgpu::Sampler, sprites: &wgpu::Buffer) -> wgpu::BindGroup {
    let view = tex.create_view(&Default::default());
    gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("blasen-platzen"),
        layout: bgl,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&view) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(sampler) },
            wgpu::BindGroupEntry { binding: 3, resource: sprites.as_entire_binding() },
        ],
    })
}

impl BlasenPlatzen {
    /// A new grid (and its texture) when the wall's size changed (control center, wall setup).
    fn ensure_grid(&mut self, gpu: &Gpu, wall_w: f32, wall_h: f32) {
        let key = (wall_w.to_bits(), wall_h.to_bits());
        if key == self.grid_key {
            return;
        }
        self.grid_key = key;
        self.grid = WallGrid::new(wall_w, wall_h);
        self.grid_tex = grid_texture(gpu, &self.grid);
        self.group = bind_group(gpu, &self.bgl, &self.uniform, &self.grid_tex, &self.sampler, &self.sprite_buf);
        gpu.write_texture(&self.grid_tex, &self.grid.tex, 4);
    }

    /// bubbles, effects, numbers
    fn fill_sprites(&mut self, numbers: bool, wall_w: f64, top: f64) {
        let s = &mut self.sprites;
        let game = &self.game;
        s.n = 0;
        let t = game.time;
        for b in &game.bubbles {
            let u = ((t - b.born) / b.grow).min(1.0);
            let sc = ease_out_back(u);
            let wob = (t * 3.1 + b.phase).sin() * 0.035;
            let r = b.r * sc;
            s.put(b.x, b.y, r * (1.0 + wob), r * (1.0 - wob), [1.0, 1.0, 1.0], (u * 2.0).min(1.0), FX_BUBBLE, [b.hue as f32, b.phase as f32, b.kind as u8 as f32], 1.35);
        }
        for f in &game.fx {
            let u = (t - f.t0) / f.life;
            match f.kind {
                FxKind::Ring => {
                    let r = f.r0 + (f.r1 - f.r0) * (1.0 - (1.0 - u).powi(3));
                    // stays bright and gets thinner (a dim magenta ring would look brownish)
                    s.put(f.x, f.y, r, r, f.col, f.a * (1.0 - u).max(0.0).sqrt(), FX_RING, [(f.w * (1.0 - 0.8 * u)) as f32, 0.0, 0.0], (1.0 + 3.0 * f.w) as f32);
                }
                FxKind::Dot => {
                    let size = f.size * (1.0 - 0.5 * u);
                    s.put(f.x, f.y, size, size, f.col, f.a * (1.0 - u), FX_DOT, [0.0; 3], 1.6);
                }
                FxKind::Glyph(points) => {
                    let d = Digits::new(Some(PLUS), u64::from(points));
                    s.text(d.glyphs(), f.x, f.y, f.h, f.col, f.a * if u < 0.6 { 1.0 } else { (1.0 - u) / 0.4 });
                }
            }
        }
        if numbers {
            // the group's score in the top left corner, the record in the top right one: the people
            // stand mostly in the middle (the sensor's view is a wedge). During a wave the score shimmers.
            let big = 0.2;
            let y = top - big * 0.8;
            let score = Digits::new(None, game.score);
            let col = if game.wave > 0.0 { neon(t * 0.8) } else { [0.85, 0.95, 1.0] };
            if !self.people.is_empty() || game.score > 0 {
                s.text(score.glyphs(), 0.25 + (score.n as f64 * big * 0.78) / 2.0, y, big, col, 1.0);
            }
            if game.best > 0 {
                let best = Digits::new(Some(STAR), game.best);
                s.text(best.glyphs(), wall_w - 0.25 - (best.n as f64 * big * 0.6 * 0.78) / 2.0, y, big * 0.6, [1.0, 0.55, 0.95], 0.75);
            }
            // everyone's own count beside their head
            for q in &self.people {
                let Some(&n) = game.per_person.get(&q.id) else { continue };
                if n == 0 {
                    continue;
                }
                let d = Digits::new(None, n);
                s.text(d.glyphs(), q.head_x + 0.2 + (d.n as f64 * 0.12 * 0.78) / 2.0, (q.head_y + 0.05).min(top - 0.1), 0.12, slot_color(q.slot), 0.95);
            }
        }
    }
}

impl Scene for BlasenPlatzen {
    fn frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String> {
        let [wall_w, wall_h] = ctx.wall.size();
        let bottom = ctx.wall.setup.bottom;
        self.ensure_grid(ctx.gpu, wall_w, wall_h);
        let dt = f64::from(ctx.dt).clamp(0.001, 1.0 / 15.0);
        let top = f64::from(bottom + wall_h);

        // the people -> the wall grid, once per tracking result
        let result = ctx.kinect.persons.clone().filter(|_| ctx.kinect.fresh.persons);
        let fresh = result.is_some();
        let mut frame_rate = 1.0; // 1 / Kinect frames since the last grid (normally 1)
        if let Some(r) = result {
            if let Some(last) = self.last_seq {
                frame_rate = 1.0 / (i64::from(r.seq) - i64::from(last)).clamp(1, 3) as f64;
            }
            self.last_seq = Some(r.seq);
            self.last_persons = ctx.time;
            let rays = ctx.kinect.rays();
            self.grid.update(&r, &rays, ctx.x_sign, ctx.wall);
            ctx.gpu.write_texture(&self.grid_tex, &self.grid.tex, 4);
        } else if self.last_persons >= 0.0 && ctx.time - self.last_persons > 0.5 && self.grid.covered > 0 {
            self.grid.clear();
            ctx.gpu.write_texture(&self.grid_tex, &self.grid.tex, 4);
        }

        // the people for the game, in wall meters (placed by the wall core)
        let view = ctx.kinect.view.clone();
        self.people.clear();
        for q in &ctx.wall.persons {
            if !q.in_zone {
                continue;
            }
            let head = view.by_id(q.id).and_then(|p| p.head).map(|h| ctx.wall.from_world(h, usize::from(q.slot)));
            let (hx, hy) = head.map_or((q.x, q.y + 0.6), |h| (h.x, h.y));
            self.people.push(Player { id: q.id, slot: q.slot, x: f64::from(q.x), head_x: f64::from(hx), head_y: f64::from(hy) });
        }

        let p = ctx.params;
        let gp = game_params(p);
        let world = World { wall_w: f64::from(wall_w), top, bottom: f64::from(bottom), grid: &self.grid, fresh, frame_rate, people: &self.people, persons: &view, params: &gp };
        self.game.step(dt, &world);
        if p.b("sound") {
            let volume = p.f("volume");
            let now = ctx.now_ms / 1000.0;
            for e in &self.game.events {
                self.sound.play(e, ctx.audio, volume, now);
            }
        }
        self.game.events.clear();

        self.fill_sprites(gp.numbers, f64::from(wall_w), top);

        // uniforms and drawing
        let flag = |b: bool| if b { 1.0 } else { 0.0 };
        let u: [f32; 16] = [
            ctx.width as f32,
            ctx.height as f32,
            wall_w,
            wall_h,
            bottom,
            self.game.time as f32,
            self.grid.w as f32,
            self.grid.h as f32,
            flag(p.b("showFresh")),
            p.f("fill"),
            p.f("outline"),
            p.f("motionGlow"),
            p.f("brightness"),
            0.0,
            0.0,
            0.0,
        ];
        ctx.gpu.queue.write_buffer(&self.uniform, 0, bytemuck::cast_slice(&u));
        let n = self.sprites.n;
        if n > 0 {
            ctx.gpu.queue.write_buffer(&self.sprite_buf, 0, bytemuck::cast_slice(&self.sprites.data[..n * SPRITE_FLOATS]));
        }
        let mut pass = wall::gpu::begin_pass(ctx.encoder, "blasen-platzen", ctx.target);
        pass.set_bind_group(0, &self.group, &[]);
        pass.set_pipeline(&self.people_pipe);
        pass.draw(0..3, 0..1);
        if n > 0 {
            pass.set_pipeline(&self.sprite_pipe);
            pass.draw(0..6, 0..n as u32);
        }
        drop(pass);

        let wall = &*ctx.wall;
        let s = &mut *ctx.status;
        s.clear();
        let g = &self.game;
        let _ = write!(s, "{} Person(en) · {} Blasen · {} Punkte (Rekord {}) · ", self.people.len(), g.bubbles.len(), g.score, g.best);
        let _ = if wall.room_found { write!(s, "Boden: Kinect {:.2} m", wall.room_height) } else { write!(s, "Boden von Hand: Kinect {} m (Wand-Setup)", wall.room_height) };
        Ok(())
    }
}

fn make(ctx: &SetupCtx) -> Result<Box<dyn Scene>, String> {
    let gpu = &ctx.gpu;
    let module = gpu.shader("blasen-platzen render.wgsl", &format!("{RENDER}{}", palette_wgsl()))?;
    let vf = wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT;
    let f = wgpu::ShaderStages::FRAGMENT;
    let bgl = gpu.bind_group_layout("blasen-platzen", &[layout::uniform(0, vf), layout::float_tex(1, f, true), layout::sampler(2, f, true), layout::storage(3, vf, true)]);
    let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("blasen-platzen"), bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
    let pipeline = |key: &str, vs: &str, fs: &str, blend: Option<wgpu::BlendState>| {
        gpu.render_pipeline(key, |d| {
            d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(key),
                layout: Some(&pl),
                vertex: wgpu::VertexState { module: &module, entry_point: Some(vs), compilation_options: Default::default(), buffers: &[] },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some(fs),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState { format: TARGET_FORMAT, blend, write_mask: wgpu::ColorWrites::ALL })],
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            })
        })
    };
    let people_pipe = pipeline("blasen-platzen people", "fullVs", "people", None)?;
    let add = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add };
    let sprite_pipe = pipeline("blasen-platzen sprites", "spriteVs", "spriteFs", Some(wgpu::BlendState { color: add, alpha: add }))?;
    let uniform = gpu.uniform_buffer("blasen-platzen uniforms", 64);
    let sprite_buf = gpu.storage_buffer("blasen-platzen sprites", (MAX_SPRITES * SPRITE_FLOATS * 4) as u64);
    let sampler = gpu.linear_sampler();
    let [w, h] = ctx.wall.size();
    let grid = WallGrid::new(w, h);
    let grid_tex = grid_texture(gpu, &grid);
    gpu.write_texture(&grid_tex, &grid.tex, 4);
    let group = bind_group(gpu, &bgl, &uniform, &grid_tex, &sampler, &sprite_buf);
    Ok(Box::new(BlasenPlatzen {
        people_pipe,
        sprite_pipe,
        bgl,
        uniform,
        sprite_buf,
        sampler,
        grid,
        grid_key: (w.to_bits(), h.to_bits()),
        grid_tex,
        group,
        sprites: Sprites { data: vec![0.0; MAX_SPRITES * SPRITE_FLOATS], n: 0 },
        game: Game::default(),
        sound: Sound::new(),
        people: Vec::with_capacity(16),
        last_persons: -1.0,
        last_seq: None,
    }))
}

pub static DEF: SceneDef = SceneDef {
    name: "blasen-platzen",
    title: "Blasen platzen",
    params,
    // the whole wall can be reached, yet one stands roughly where one shows: a trapezoid between the
    // view cone and a box (1.8 m wide 0.8 m from the sensor, 5 m at 4 m: from about 2.5 m on the edges
    // of the view reach the wall's edges; in front the middle 4 m), a curve that keeps the middle calm
    // (×1.1-1.5 at 2-3 m) and moves faster towards the edges, a little smoothing. Tuned per site in the
    // control center (tab Projektion).
    projection: || {
        json!({
            "field": { "depth": [0.8, 4], "width": [1.8, 5] },
            "curve.x": [[0.25, 0.29], [0.75, 0.71]],
            "edge": "clamp",
            "margin": 0.2,
            "smoothing": 0.2,
        })
    },
    persons,
    streams: no_streams,
    max_fps: no_cap,
    make,
};

wall::export_scenes!(&DEF);
