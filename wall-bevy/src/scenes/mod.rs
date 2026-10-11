//! The scenes of the Bevy output: Rust ports of web/scenes/<name>/ with the same name, params and
//! projection wishes, so the control center's show plays them unchanged.

use crate::scene::SceneDef;

mod shader_scenes;

/// Every scene this output can play.
pub fn registry() -> Vec<&'static SceneDef> {
    let mut v: Vec<&'static SceneDef> = Vec::new();
    v.extend(shader_scenes::DEFS.iter());
    v
}
