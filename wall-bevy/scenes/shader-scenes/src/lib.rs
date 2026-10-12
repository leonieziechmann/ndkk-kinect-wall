//! Scenes that are one WGSL function (createShaderPass in the browser): wand-spiegel and the 2D
//! templates. Their .wgsl files are the browser scenes' own, included at build time, so a change
//! there reaches both outputs.

use serde_json::json;

use wall::canvas::Font;
use wall::params::{ParamSpec, Params, boolean, color, num, select};
use wall::persons::{PersonOptions, j};
use wall::scene::{FrameCtx, Scene, SceneDef, SetupCtx, exact, live, no_cap, no_projection, no_streams};
use wall::common::overlay::{LabelStyle, TextOverlay, ease_out};
use wall::shader_pass::ShaderPass;

/// The HTML a scene puts over its canvas in the browser.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Labels {
    None,
    /// person-mask: id and height above everybody
    Tags,
    /// person-skeleton: "Hallo #id" for everyone who comes in
    Greetings,
}

struct Greeting {
    text: String,
    color: [f32; 3],
    x: f32,
    y: f32,
    start: f64,
}

struct ShadeScene {
    pass: ShaderPass,
    status: fn(&FrameCtx) -> String,
    labels: Labels,
    overlay: Option<TextOverlay>,
    style: Option<LabelStyle>,
    greetings: Vec<Greeting>,
}

impl Scene for ShadeScene {
    fn frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String> {
        self.pass.render(ctx);
        match self.labels {
            Labels::Tags => self.tags(ctx),
            Labels::Greetings => self.greet(ctx),
            Labels::None => {}
        }
        *ctx.status = (self.status)(ctx);
        Ok(())
    }
}

impl ShadeScene {
    /// person-mask: `#id · height m` above each person's box
    fn tags(&mut self, ctx: &mut FrameCtx) {
        let (Some(o), Some(style)) = (self.overlay.as_mut(), self.style.as_ref()) else { return };
        if ctx.params.b("labels") {
            let view = ctx.kinect.view.clone();
            for p in &*view {
                let b = p.image.bbox;
                let Some([x, y]) = ctx.kinect_to_screen((b[0] + b[2]) / 2.0, b[1]) else { continue };
                o.label(&format!("#{} · {:.2} m", p.id, p.height), style, p.color, x, y - 10.0, 1.0);
            }
        }
        o.draw(ctx);
    }

    /// person-skeleton: a greeting rising and fading over 2.4 s (CSS animation sk-hello)
    fn greet(&mut self, ctx: &mut FrameCtx) {
        let (Some(o), Some(style)) = (self.overlay.as_mut(), self.style.as_ref()) else { return };
        let now = ctx.now_ms;
        if ctx.params.b("greet") {
            let view = ctx.kinect.view.clone();
            for p in view.entered_persons() {
                let Some(at) = p.image.joints[j::HEAD].or(p.image.center) else { continue };
                let Some([x, y]) = ctx.kinect_to_screen(at.x, at.y) else { continue };
                self.greetings.push(Greeting { text: format!("Hallo #{}", p.id), color: p.color, x, y, start: now });
            }
        }
        self.greetings.retain(|g| now - g.start < 2400.0);
        for g in &self.greetings {
            let t = ((now - g.start) / 2400.0) as f32;
            // keyframes: 0 % opacity 0, margin 12 px; 15 % opacity 1, margin 0; 70 % opacity 1;
            // 100 % opacity 0, margin -18 px; each step ease-out
            let opacity = if t < 0.15 { ease_out(t / 0.15) } else if t < 0.7 { 1.0 } else { 1.0 - ease_out((t - 0.7) / 0.3) };
            let margin = if t < 0.15 { 12.0 - 12.0 * ease_out(t / 0.15) } else { -18.0 * ease_out((t - 0.15) / 0.85) };
            o.label(&g.text, style, g.color, g.x, g.y - 40.0 + margin, opacity);
        }
        o.draw(ctx);
    }
}

fn make(ctx: &SetupCtx, shade: &str, feedback: bool, status: fn(&FrameCtx) -> String, labels: Labels) -> Result<Box<dyn Scene>, String> {
    let pass = ShaderPass::new(&ctx.gpu, &ctx.kgpu, &ctx.wall_buf, [ctx.width, ctx.height], ctx.name, &ctx.params.specs, shade, feedback)?;
    let mono = "ui-monospace, Consolas, monospace";
    let style = match labels {
        // .pm-tag: 600 14px/1.3, letter-spacing 0.04em, padding 2px 8px, radius 4px, rgba(0,0,0,0.45), text-shadow 0 0 8px
        Labels::Tags => Some(LabelStyle { font: Font::new(mono, 14.0, 600), spacing: 0.04, line_height: 1.3, pad: [8.0, 2.0], radius: 4.0, background: Some([0.0, 0.0, 0.0, 0.45]), glow: 8.0 }),
        // .sk-hello: 700 22px/1, letter-spacing 0.06em, text-shadow 0 0 12px
        Labels::Greetings => Some(LabelStyle { font: Font::new(mono, 22.0, 700), spacing: 0.06, line_height: 1.0, pad: [0.0, 0.0], radius: 0.0, background: None, glow: 12.0 }),
        Labels::None => None,
    };
    let overlay = if style.is_some() { Some(TextOverlay::new(&ctx.gpu, ctx.width, ctx.height)?) } else { None };
    Ok(Box::new(ShadeScene { pass, status, labels, overlay, style, greetings: Vec::new() }))
}

fn on_wall(ctx: &FrameCtx) -> String {
    format!("{} Person(en) auf der Wand", ctx.wall.persons.len())
}

// ---------- wand-spiegel ----------

fn wand_spiegel_params() -> Vec<ParamSpec> {
    vec![
        num("fill", 0.35, 0.0, 1.5, 0.01, "Körper füllen"),
        num("outline", 1.4, 0.0, 4.0, 0.05, "Umriss"),
        num("glow", 0.7, 0.0, 3.0, 0.05, "Glühen"),
        num("ir", 0.6, 0.0, 1.0, 0.01, "IR-Struktur"),
        num("trail", 0.88, 0.0, 0.98, 0.01, "Nachleuchten"),
        num("rise", 1.5, -6.0, 6.0, 0.1, "Spuren steigen (LEDs/Bild)"),
        color("nearColor", "#ff2d6a", "Farbe nah"),
        color("farColor", "#3d4bff", "Farbe fern"),
    ]
}

// ---------- person-mask ----------

fn person_mask_params() -> Vec<ParamSpec> {
    vec![
        num("room", 0.0, 0.0, 1.0, 0.01, "Raum (Kamerabild)"),
        num("shading", 0.7, 0.0, 1.0, 0.01, "Relief"),
        num("ir", 0.45, 0.0, 1.0, 0.01, "IR-Details"),
        num("outline", 1.0, 0.0, 3.0, 0.05, "Kontur"),
        boolean("labels", true, "ID und Größe zeigen"),
    ]
}

fn person_mask_status(ctx: &FrameCtx) -> String {
    match ctx.kinect.persons.as_ref().and_then(|p| p.floor.clone()) {
        Some(f) => format!("Boden {:.2} m ({})", f.height.0, if f.source.as_deref() == Some("feet") { "aus Füßen" } else { "gesehen" }),
        None => String::new(),
    }
}

fn ir_stream(_: &Params) -> Vec<&'static str> {
    vec!["ir"]
}

// ---------- person-skeleton ----------

fn person_skeleton_params() -> Vec<ParamSpec> {
    vec![
        select("mode", "Skelett", &["Skelett", "Silhouette", "Beides"], "Darstellung"),
        num("line", 2.5, 0.5, 8.0, 0.1, "Linien (px)"),
        num("dots", 4.0, 0.0, 12.0, 0.5, "Gelenke (px)"),
        num("hands", 12.0, 0.0, 40.0, 0.5, "Hände (px)"),
        num("glow", 0.35, 0.0, 1.0, 0.01, "Glühen"),
        num("trails", 0.8, 0.0, 0.97, 0.01, "Spuren"),
        num("fill", 0.35, 0.0, 1.0, 0.01, "Silhouette"),
        boolean("greet", true, "Neue Personen begrüßen"),
    ]
}

fn skeleton_persons(p: &Params) -> Option<PersonOptions> {
    Some(PersonOptions { skeleton: p.s("mode") == "Skelett", ..PersonOptions::exact() })
}

fn person_skeleton_status(ctx: &FrameCtx) -> String {
    let n = ctx.kinect.view.len();
    if n == 0 { "niemand im Bild".into() } else { format!("{n} {}", if n == 1 { "Skelett" } else { "Skelette" }) }
}

// ---------- depth-shader ----------

fn depth_shader_params() -> Vec<ParamSpec> {
    vec![
        num("spacing", 0.12, 0.02, 0.5, 0.005, "Linienabstand (m)"),
        num("lineWidth", 0.18, 0.02, 0.9, 0.01, "Linienbreite"),
        num("speed", 0.25, -2.0, 2.0, 0.01, "Drift"),
        num("irFill", 0.22, 0.0, 1.0, 0.01, "IR-Füllung"),
        num("trail", 0.86, 0.0, 0.98, 0.01, "Nachleuchten"),
        color("nearColor", "#ffd27a", "Farbe nah"),
        color("farColor", "#3b6cff", "Farbe fern"),
    ]
}

fn depth_streams(_: &Params) -> Vec<&'static str> {
    vec!["depth", "ir"]
}

fn no_persons(_: &Params) -> Option<PersonOptions> {
    None
}

fn empty(_: &FrameCtx) -> String {
    String::new()
}

pub static DEFS: [SceneDef; 4] = [
    SceneDef {
        name: "wand-spiegel",
        title: "Wand-Spiegel",
        params: wand_spiegel_params,
        projection: no_projection,
        persons: live,
        streams: no_streams,
        max_fps: no_cap,
        make: |ctx| make(ctx, include_str!("wand-spiegel.wgsl"), true, on_wall, Labels::None),
    },
    SceneDef {
        name: "person-mask",
        title: "Personen-Maske",
        params: person_mask_params,
        projection: no_projection,
        persons: exact,
        streams: ir_stream,
        max_fps: no_cap,
        make: |ctx| make(ctx, include_str!("person-mask.wgsl"), false, person_mask_status, Labels::Tags),
    },
    SceneDef {
        name: "person-skeleton",
        title: "Strichmännchen",
        params: person_skeleton_params,
        projection: no_projection,
        persons: skeleton_persons,
        streams: no_streams,
        max_fps: no_cap,
        make: |ctx| make(ctx, include_str!("person-skeleton.wgsl"), true, person_skeleton_status, Labels::Greetings),
    },
    SceneDef {
        name: "depth-shader",
        title: "Höhenlinien",
        params: depth_shader_params,
        projection: || json!(null),
        persons: no_persons,
        streams: depth_streams,
        max_fps: no_cap,
        make: |ctx| make(ctx, include_str!("depth-shader.wgsl"), true, empty, Labels::None),
    },
];

wall::export_scenes!(&DEFS[0], &DEFS[1], &DEFS[2], &DEFS[3]);
