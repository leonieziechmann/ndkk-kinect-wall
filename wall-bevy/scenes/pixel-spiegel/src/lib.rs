//! Pixel-Art-Spiegel (port of web/scenes/pixel-spiegel): everybody in front of the wall becomes a
//! pixel-art figure of big LED tiles, mirrored, in real size, with the walk stretched over the wall.
//! Each person gets an outfit by their tracking id; the skeleton decides which body part a tile
//! shows. Fast hands and feet throw off small pixel sparks. By their distance everybody stands on a
//! front, middle or back layer (coarse, middle, fine tiles; front covers back).
//! shade.wgsl (the browser scene's own) draws the tiles, sparks.rs the sparks on top.

mod sparks;

use serde_json::json;

use wall::params::{ParamSpec, Params, boolean, color, num};
use wall::persons::PersonOptions;
use wall::scene::{FrameCtx, Scene, SceneDef, SetupCtx, cap30, no_streams};
use wall::shader_pass::ShaderPass;

/// The outfits (palettes.js): hair, skin, shirt, pants, shoes, short sleeves
pub const PALETTES: [([&str; 5], bool); 10] = [
    (["#1f78a0", "#bff0f5", "#5fd0e6", "#2b6fae", "#7a5cff"], false),
    (["#ff7a1a", "#ffc49a", "#ffaa2b", "#c8452d", "#7a2448"], false),
    (["#e0562b", "#ffd0b0", "#ff6a4d", "#5a6cff", "#7a52a8"], true),
    (["#ffcf5a", "#ffe2c8", "#eafff2", "#3fae8c", "#22707e"], false),
    (["#8a5aff", "#f4d4ff", "#e2d6ff", "#9a6ae0", "#ff3d9a"], true),
    (["#ff2e7e", "#ffd6e6", "#ff7ab8", "#4656ff", "#f4f0ff"], true),
    (["#3a4dff", "#c4eeff", "#2ee6ff", "#2b62e8", "#ff4fa0"], false),
    (["#ff5a2a", "#ffd8b6", "#8cff5a", "#2f86ff", "#ffe14d"], true),
    (["#ffd23a", "#ffcca8", "#ff2a4a", "#4a58e0", "#f4f0ff"], false),
    (["#c45cff", "#c88664", "#ffe14d", "#2fb8ff", "#ff3d6e"], true),
];

/// WGSL constants: PAL[outfit * 5 + part], SLEEVE_SKIN[outfit], PAL_COUNT.
fn palette_wgsl() -> String {
    let mut colors = Vec::new();
    for (p, _) in PALETTES {
        for c in p {
            let v = wall::persons::hex_rgb(c);
            colors.push(format!("vec3f({:.4}, {:.4}, {:.4})", v[0], v[1], v[2]));
        }
    }
    let sleeves: Vec<&str> = PALETTES.iter().map(|(_, s)| if *s { "1.0" } else { "0.0" }).collect();
    format!(
        "\nconst PAL_COUNT = {}u;\nconst PAL = array<vec3f, {}>({});\nconst SLEEVE_SKIN = array<f32, {}>({});\n",
        PALETTES.len(),
        colors.len(),
        colors.join(", "),
        PALETTES.len(),
        sleeves.join(", ")
    )
}

/// The outfit of a person (same rule as the shader: id modulo the number of outfits).
pub fn outfit(id: u32) -> &'static ([&'static str; 5], bool) {
    &PALETTES[id as usize % PALETTES.len()]
}

fn params() -> Vec<ParamSpec> {
    vec![
        num("cell", 11.0, 4.0, 30.0, 0.5, "Pixelgröße (cm)"),
        num("gap", 0.16, 0.0, 0.45, 0.01, "Fuge"),
        num("corner", 0.3, 0.0, 1.0, 0.05, "Ecken rund"),
        num("fill", 0.4, 0.1, 0.9, 0.01, "Schwelle (Anteil bedeckt)"),
        num("relief", 1.0, 0.0, 1.5, 0.05, "Licht und Schatten"),
        num("trail", 0.5, 0.0, 0.95, 0.01, "Nachbild"),
        num("sparks", 1.0, 0.0, 3.0, 0.05, "Pixel-Funken"),
        num("sparkSpeed", 1.3, 0.3, 4.0, 0.05, "Funken ab (m/s)"),
        num("drift", 1.0, 0.0, 4.0, 0.05, "Schwebende Pixel"),
        num("grid", 0.55, 0.0, 1.5, 0.01, "Raster-Helligkeit"),
        num("twinkle", 0.6, 0.0, 2.0, 0.05, "Raster funkeln"),
        color("bg", "#2a1650", "Rasterfarbe"),
        num("layerNear", 2.3, 1.0, 4.0, 0.05, "vorne bis (m)"),
        num("layerFar", 3.3, 1.5, 5.0, 0.05, "hinten ab (m)"),
        num("layerHold", 0.12, 0.0, 0.5, 0.01, "Wechsel erst nach (m)"),
        num("nearScale", 1.35, 1.0, 2.5, 0.05, "Kacheln vorne ×"),
        num("farScale", 0.6, 0.3, 1.0, 0.05, "Kacheln hinten ×"),
        boolean("exact", false, "Exakte Skelette (+150 ms)"),
        boolean("debug", false, "Skelett einblenden (Test)"),
    ]
}

fn persons(p: &Params) -> Option<PersonOptions> {
    Some(if p.b("exact") { PersonOptions::exact() } else { PersonOptions::live() })
}

struct PixelSpiegel {
    pass: ShaderPass,
    sparks: sparks::Sparks,
}

impl Scene for PixelSpiegel {
    fn frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String> {
        self.pass.render(ctx);
        self.sparks.render(ctx);
        *ctx.status = format!("{} Pixel-Person(en), {} Funken", ctx.wall.persons.len(), self.sparks.count());
        Ok(())
    }
}

fn make(ctx: &SetupCtx) -> Result<Box<dyn Scene>, String> {
    let shade = format!("{}{}", palette_wgsl(), include_str!("shade.wgsl"));
    let pass = ShaderPass::new(&ctx.gpu, &ctx.kgpu, &ctx.wall_buf, [ctx.width, ctx.height], ctx.name, &ctx.params.specs, &shade, true)?;
    let sparks = sparks::Sparks::new(&ctx.gpu)?;
    Ok(Box::new(PixelSpiegel { pass, sparks }))
}

pub static DEF: SceneDef = SceneDef {
    name: "pixel-spiegel",
    title: "Pixel-Art-Spiegel",
    params,
    // the mirror of the default projection; the place a little smoothed, so the big tiles do not flicker
    projection: || json!({ "smoothing": 0.2 }),
    persons,
    streams: no_streams,
    max_fps: cap30,
    make,
};

wall::export_scenes!(&DEF);
