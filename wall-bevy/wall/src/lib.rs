//! wall: the framework of the LED wall scenes. A scene is its own crate (a dynamic library); the
//! output (wall-bevy) loads every scene library it finds next to itself and swaps one while it runs
//! when the library is built anew. Everything a scene sees and builds on lives here, once.

pub mod audio;
pub mod canvas;
pub mod common;
pub mod draw;
pub mod gpu;
pub mod hub;
pub mod kinect;
pub mod kinect_gpu;
pub mod map;
pub mod params;
pub mod particles;
pub mod people;
pub mod persons;
pub mod prelude;
pub mod scene;
pub mod shader_pass;
pub mod sketch;
pub mod store;
pub mod ui;
pub mod wall_persons;

// the crates scenes build on, in the versions (and the one copy) the framework uses
pub use {bytemuck, crossbeam_channel, glam, parking_lot, serde_json, tiny_skia, tracing, wgpu};

pub use map::WallMap;
pub use scene::{FrameCtx, Scene, SceneDef, SetupCtx};

/// This build of the framework (sources, compiler, target, profile, features).
pub const BUILD_ID: &str = env!("WALL_BUILD_ID");

/// The id of the framework actually loaded in this process (not inlined into the caller).
#[inline(never)]
pub fn build_id() -> &'static str {
    BUILD_ID
}

/// What a scene library exports: its scenes, and the framework build it was made with.
pub struct SceneLibrary {
    pub build_id: &'static str,
    pub scenes: Vec<&'static SceneDef>,
}

/// The entry points of a scene library: `wall::export_scenes!(&DEF);` (several: `&A, &B`).
#[macro_export]
macro_rules! export_scenes {
    ($($def:expr),+ $(,)?) => {
        /// The framework build this library was made with (checked before anything else is called).
        #[unsafe(no_mangle)]
        pub fn wall_scene_build_id() -> &'static str {
            $crate::BUILD_ID
        }

        /// The scenes of this library.
        #[unsafe(no_mangle)]
        pub fn wall_scene_library() -> $crate::SceneLibrary {
            $crate::SceneLibrary { build_id: $crate::BUILD_ID, scenes: vec![$($def),+] }
        }
    };
}

/// A scene in a few lines: its declaration and the sketch (sketch.rs) that draws it; exports it.
///
/// ```ignore
/// wall::scene! {
///     name: "hallo-wand",
///     title: "Hallo Wand",
///     params: [num("speed", 1.0, 0.0, 3.0, 0.05, "Tempo"), color("tint", "#5ad1ff", "Farbe")],
///     persons: live,
///     sketch: Hallo,
/// }
/// ```
/// `params` (wall::params helpers), `persons` (live | exact), `streams` (["depth", "ir"]), `max_fps`
/// (30) and `projection` (a serde_json::json!-able value, the browser scene's projection wishes)
/// are optional and come in this order.
#[macro_export]
macro_rules! scene {
    (
        name: $name:literal,
        title: $title:literal,
        $(params: [$($param:expr),* $(,)?],)?
        $(persons: $persons:ident,)?
        $(streams: [$($stream:literal),* $(,)?],)?
        $(max_fps: $fps:expr,)?
        $(projection: $proj:tt,)?
        sketch: $sketch:ty $(,)?
    ) => {
        /// This scene's declaration.
        pub static SCENE: $crate::SceneDef = $crate::SceneDef {
            name: $name,
            title: $title,
            params: || {
                #[allow(unused_imports)]
                use $crate::params::*;
                vec![$($($param),*)?]
            },
            projection: || $crate::__scene_projection!($($proj)?),
            persons: |_p| $crate::__scene_persons!($($persons)?),
            streams: |_p| vec![$($($stream),*)?],
            max_fps: |_p| $crate::__scene_fps!($($fps)?),
            make: $crate::sketch::make::<$sketch>,
        };
        $crate::export_scenes!(&SCENE);
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __scene_projection {
    () => {
        $crate::serde_json::Value::Null
    };
    ($p:tt) => {
        $crate::serde_json::json!($p)
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __scene_persons {
    () => {
        None
    };
    (live) => {
        Some($crate::persons::PersonOptions::live())
    };
    (exact) => {
        Some($crate::persons::PersonOptions::exact())
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __scene_fps {
    () => {
        0.0
    };
    ($f:expr) => {
        f64::from($f)
    };
}
