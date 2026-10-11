//! Scenes that are one WGSL function (createShaderPass in the browser): wand-spiegel and the 2D
//! templates. Their .wgsl files are the browser scenes' own, included at build time, so a change
//! there reaches both outputs.

use serde_json::json;

use crate::params::{ParamSpec, Params, boolean, color, num, select};
use crate::persons::PersonOptions;
use crate::scene::{FrameCtx, Scene, SceneDef, SetupCtx, exact, live, no_cap, no_projection, no_streams};
use crate::shader_pass::ShaderPass;

struct ShadeScene {
    pass: ShaderPass,
    status: fn(&FrameCtx) -> String,
}

impl Scene for ShadeScene {
    fn frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String> {
        self.pass.render(ctx);
        *ctx.status = (self.status)(ctx);
        Ok(())
    }
}

fn make(ctx: &SetupCtx, shade: &str, feedback: bool, status: fn(&FrameCtx) -> String) -> Result<Box<dyn Scene>, String> {
    let pass = ShaderPass::new(&ctx.gpu, &ctx.kgpu, &ctx.wall_buf, [ctx.width, ctx.height], ctx.name, &ctx.params.specs, shade, feedback)?;
    Ok(Box::new(ShadeScene { pass, status }))
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
        make: |ctx| make(ctx, include_str!("../../../web/scenes/wand-spiegel/shade.wgsl"), true, on_wall),
    },
    SceneDef {
        name: "person-mask",
        title: "Personen-Maske",
        params: person_mask_params,
        projection: no_projection,
        persons: exact,
        streams: ir_stream,
        max_fps: no_cap,
        make: |ctx| make(ctx, include_str!("../../../web/scenes/person-mask/shade.wgsl"), false, person_mask_status),
    },
    SceneDef {
        name: "person-skeleton",
        title: "Strichmännchen",
        params: person_skeleton_params,
        projection: no_projection,
        persons: skeleton_persons,
        streams: no_streams,
        max_fps: no_cap,
        make: |ctx| make(ctx, include_str!("../../../web/scenes/person-skeleton/shade.wgsl"), true, person_skeleton_status),
    },
    SceneDef {
        name: "depth-shader",
        title: "Höhenlinien",
        params: depth_shader_params,
        projection: || json!(null),
        persons: no_persons,
        streams: depth_streams,
        max_fps: no_cap,
        make: |ctx| make(ctx, include_str!("../../../web/scenes/depth-shader/shade.wgsl"), true, empty),
    },
];
