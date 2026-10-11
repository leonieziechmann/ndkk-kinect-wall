//! Scenes that are one WGSL function (createShaderPass in the browser): wand-spiegel and the 2D
//! templates. Their .wgsl files are the browser scenes' own, included at build time.

use crate::params::{ParamSpec, color, num};
use crate::scene::{FrameCtx, Scene, SceneDef, SetupCtx, live, no_cap, no_projection, no_streams};
use crate::shader_pass::ShaderPass;

struct ShadeScene {
    pass: ShaderPass,
}

impl Scene for ShadeScene {
    fn frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String> {
        self.pass.render(ctx);
        *ctx.status = format!("{} Person(en) auf der Wand", ctx.wall.persons.len());
        Ok(())
    }
}

fn make(ctx: &SetupCtx, shade: &str, feedback: bool) -> Result<Box<dyn Scene>, String> {
    let pass = ShaderPass::new(&ctx.gpu, &ctx.kgpu, &ctx.wall_buf, [ctx.width, ctx.height], ctx.name, &ctx.params.specs, shade, feedback)?;
    Ok(Box::new(ShadeScene { pass }))
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

pub static DEFS: [SceneDef; 1] = [SceneDef {
    name: "wand-spiegel",
    title: "Wand-Spiegel",
    params: wand_spiegel_params,
    projection: no_projection,
    persons: live,
    streams: no_streams,
    max_fps: no_cap,
    make: |ctx| make(ctx, include_str!("../../../web/scenes/wand-spiegel/shade.wgsl"), true),
}];
