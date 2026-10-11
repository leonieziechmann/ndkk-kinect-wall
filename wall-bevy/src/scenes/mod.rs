//! The scenes of the Bevy output: Rust ports of web/scenes/<name>/ with the same name, params and
//! projection wishes, so the control center's show plays them unchanged.

use crate::scene::SceneDef;

mod blasen_platzen;
pub mod common;
mod fluid_simulation;
mod llg_sakura;
mod leonie_ziechmann;
mod live_exakt;
mod modern_events;
mod pixel_jump_run;
mod pixel_spiegel;
mod shader_scenes;

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
    v
}
