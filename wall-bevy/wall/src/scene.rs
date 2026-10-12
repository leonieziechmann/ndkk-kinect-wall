//! What a scene is (the Rust form of a browser scene's main.js) and what it sees each frame (ctx).
//!
//! A scene renders the LED image into `ctx.target` (LED pixels, rgba8unorm, values as displayed)
//! with wgpu, as the browser scene rendered into its canvas with WebGPU. Pipelines and shader
//! modules go through `ctx.gpu` (cached by name): a scene that starts again never compiles.

use std::sync::Arc;

use serde_json::Value;

use crate::audio::Audio;
use crate::gpu::Gpu;
use crate::kinect::KinectData;
use crate::kinect_gpu::KinectGpu;
use crate::params::{ParamSpec, Params};
use crate::persons::{PersonOptions, PersonsView};
use crate::map::WallMap;

/// A scene as the registry knows it (main.js: params, projection, persons, maxFps, setup).
pub struct SceneDef {
    pub name: &'static str,
    pub title: &'static str,
    /// the params (same keys and defaults as the browser scene)
    pub params: fn() -> Vec<ParamSpec>,
    /// what the scene asks of the projection (main.js `projection: {...}`), or Null
    pub projection: fn() -> Value,
    /// the persons options (main.js `persons`), None: no 'persons' stream
    pub persons: fn(&Params) -> Option<PersonOptions>,
    /// other streams it needs ('depth', 'ir', 'points')
    pub streams: fn(&Params) -> Vec<&'static str>,
    /// render cap (main.js maxFps), 0 = none
    pub max_fps: fn(&Params) -> f64,
    /// setup(): creates the instance and its GPU resources (runs in a worker thread: the show
    /// keeps playing meanwhile)
    pub make: fn(&SetupCtx) -> Result<Box<dyn Scene>, String>,
}

/// The cache name of a scene's GPU objects: its name and the version of its library (every load of a
/// library has its own SceneDef address), so a scene built anew compiles its shaders anew.
pub fn cache_namespace(def: &'static SceneDef) -> String {
    format!("{}@{:x}", def.name, std::ptr::from_ref(def) as usize)
}

pub fn no_projection() -> Value {
    Value::Null
}
pub fn no_streams(_: &Params) -> Vec<&'static str> {
    Vec::new()
}
pub fn no_cap(_: &Params) -> f64 {
    0.0
}
pub fn cap30(_: &Params) -> f64 {
    30.0
}
pub fn live(_: &Params) -> Option<PersonOptions> {
    Some(PersonOptions::live())
}
pub fn exact(_: &Params) -> Option<PersonOptions> {
    Some(PersonOptions::exact())
}

pub trait Scene: Send {
    /// Every rendered frame: logic, then render into ctx.target.
    fn frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String>;
    /// A param changed (show entry, glide).
    fn on_param(&mut self, _key: &str, _params: &Params) {}
}

/// What setup() gets (owned: setup runs in a worker thread).
pub struct SetupCtx {
    pub gpu: Gpu,
    pub kgpu: Arc<KinectGpu>,
    /// the instance's wall (setup, projection) as it is at the start
    pub wall: WallMap,
    /// the instance's wall uniform buffer (WGSL `wallWgsl()`, struct Wall)
    pub wall_buf: wgpu::Buffer,
    pub params: Params,
    pub width: u32,
    pub height: u32,
    pub name: &'static str,
}

/// What frame() gets (ctx in the browser).
pub struct FrameCtx<'a> {
    pub gpu: &'a Gpu,
    pub encoder: &'a mut wgpu::CommandEncoder,
    /// the scene's output: LED pixels
    pub target: &'a wgpu::TextureView,
    pub width: u32,
    pub height: u32,
    /// s since the scene started, s since the last frame, frame counter
    pub time: f32,
    pub dt: f32,
    pub frame: u64,
    pub params: &'a Params,
    pub kinect: &'a mut KinectData,
    #[allow(dead_code)]
    pub kgpu: &'a KinectGpu,
    pub wall: &'a mut WallMap,
    #[allow(dead_code)]
    pub wall_buf: &'a wgpu::Buffer,
    pub x_sign: f32,
    /// the HUD / telemetry status line
    pub status: &'a mut String,
    /// games: true while a round runs (the show switches between rounds)
    pub hold_switch: &'a mut Option<bool>,
    pub audio: &'a mut Audio,
    /// ms on the monotonic clock (hub::mono_ms) at the start of this frame
    pub now_ms: f64,
}

impl FrameCtx<'_> {
    /// ctx.persons: the visible persons and the rest of the view.
    #[allow(dead_code)]
    pub fn persons(&self) -> Arc<PersonsView> {
        self.kinect.view.clone()
    }
}

impl FrameCtx<'_> {
    /// ctx.kinectToScreen(u, v) of a wall scene: depth image pixel -> LED pixels, as kinectUv()
    /// shows the camera image on the wall (None if its ray does not reach image.distance).
    pub fn kinect_to_screen(&self, u: f32, v: f32) -> Option<[f32; 2]> {
        let rays = self.kinect.rays();
        let [x, y] = self.wall.image_to_wall(u, v, Some(&rays))?;
        let [uu, vv] = self.wall.uv(x, y);
        Some([uu * self.width as f32, vv * self.height as f32])
    }
}
