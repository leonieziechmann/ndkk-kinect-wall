//! The scenes of the Bevy output: Rust ports of web/scenes/<name>/ with the same name, params and
//! projection wishes, so the control center's show plays them unchanged.

use crate::scene::SceneDef;

mod blasen_platzen;
pub mod common;
mod cyberspiegel;
mod fluid_simulation;
mod fruit_ninja;
mod invaders_tracking;
mod llg_sakura;
mod leonie_ziechmann;
mod live_exakt;
mod modern_events;
mod neon_room;
mod pixel_jump_run;
mod pixel_spiegel;
mod pointcloud;
mod shader_scenes;
mod three_points;
mod space_invaders;

/// Every scene's declaration as the browser scenes write theirs (wall-bevy --list-scenes): to
/// check a port against its browser scene.
pub fn declarations() -> String {
    let list: Vec<serde_json::Value> = registry()
        .iter()
        .map(|d| {
            let specs = (d.params)();
            let params = crate::params::Params::resolve(std::sync::Arc::new(specs.clone()), &serde_json::json!({}));
            let persons = (d.persons)(&params).map(|o| serde_json::json!({ "delay": o.delay, "live": o.live, "skeleton": o.skeleton }));
            serde_json::json!({
                "name": d.name,
                "title": d.title,
                "params": serde_json::Value::Object(specs.iter().map(|s| (s.key.clone(), s.declaration())).collect()),
                "order": specs.iter().map(|s| s.key.clone()).collect::<Vec<_>>(),
                "projection": (d.projection)(),
                "persons": persons,
                "streams": (d.streams)(&params),
                "maxFps": (d.max_fps)(&params),
            })
        })
        .collect();
    serde_json::to_string_pretty(&list).unwrap_or_default()
}

/// Every scene this output can play.
pub fn registry() -> Vec<&'static SceneDef> {
    let mut v: Vec<&'static SceneDef> = Vec::new();
    v.extend(shader_scenes::DEFS.iter());
    v.push(&pixel_spiegel::DEF);
    v.push(&fluid_simulation::DEF);
    v.push(&modern_events::DEF);
    v.push(&pixel_jump_run::DEF);
    v.push(&blasen_platzen::DEF);
    v.push(&llg_sakura::DEF);
    v.push(&leonie_ziechmann::DEF);
    v.push(&live_exakt::DEF);
    v.push(&cyberspiegel::DEF);
    v.push(&neon_room::DEF);
    v.push(&pointcloud::DEF);
    v.push(&three_points::DEF);
    v.push(&fruit_ninja::DEF);
    v.push(&space_invaders::DEF);
    v.push(&invaders_tracking::DEF);
    v
}
