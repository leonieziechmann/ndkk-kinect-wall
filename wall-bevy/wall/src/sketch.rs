//! Sketch: the short way to write a scene. A sketch has a setup (once, in a worker thread) and a
//! frame (every frame); the frame draws with Draw (shapes, images, text, ui.rs) and reads the
//! persons on the wall, the params, the time. The framework clears the picture, draws what the
//! frame asked for and hands it to the output. With wall::scene! the whole scene is these two
//! functions and its declaration.
//!
//! A scene that needs its own GPU work (compute, feedback, 3D) implements scene::Scene instead, or
//! draws with Draw on top of its own passes (Draw::finish_into).

use std::ops::{Deref, DerefMut};
use std::sync::Arc;

use crate::audio::Pcm;
use crate::draw::{Color, Draw, Paints};
use crate::people::{Body, bodies};
use crate::scene::{FrameCtx, Scene, SetupCtx};

/// What a sketch is: its state, made in setup, drawn each frame.
pub trait Sketch: Send + Sized + 'static {
    /// Once, in a worker thread (the show keeps playing): load images, make sounds, set up state.
    fn setup(s: &mut Setup) -> Result<Self, String>;

    /// Every frame: logic and drawing (f derefs to Draw: f.circle(..), f.text(..)).
    fn frame(&mut self, f: &mut Frame);
}

/// What setup gets: the scene's context and its painter (for images).
pub struct Setup<'a> {
    pub ctx: &'a SetupCtx,
    pub draw: &'a mut Draw,
}

impl Setup<'_> {
    /// LED pixels
    pub fn w(&self) -> f32 {
        self.ctx.width as f32
    }
    pub fn h(&self) -> f32 {
        self.ctx.height as f32
    }
    pub fn num(&self, key: &str) -> f32 {
        self.ctx.params.f(key)
    }
    pub fn flag(&self, key: &str) -> bool {
        self.ctx.params.b(key)
    }
    /// A text or choice param.
    pub fn string(&self, key: &str) -> String {
        self.ctx.params.s(key).to_string()
    }
}

/// What a frame gets: the drawing (Deref to Draw), the persons, the params, the time.
pub struct Frame<'f, 'c> {
    pub ctx: &'f mut FrameCtx<'c>,
    draw: &'f mut Draw,
    bodies: Option<Arc<Vec<Body>>>,
}

impl Frame<'_, '_> {
    /// LED pixels
    pub fn w(&self) -> f32 {
        self.ctx.width as f32
    }
    pub fn h(&self) -> f32 {
        self.ctx.height as f32
    }
    /// s since the scene started
    pub fn t(&self) -> f32 {
        self.ctx.time
    }
    /// s since the last frame
    pub fn dt(&self) -> f32 {
        self.ctx.dt
    }
    /// the frame counter
    pub fn frame(&self) -> u64 {
        self.ctx.frame
    }

    /// A number param.
    pub fn num(&self, key: &str) -> f32 {
        self.ctx.params.f(key)
    }
    /// A switch param.
    pub fn flag(&self, key: &str) -> bool {
        self.ctx.params.b(key)
    }
    /// A color param.
    pub fn color(&self, key: &str) -> Color {
        Color::from_rgb(self.ctx.params.color(key))
    }
    /// A text or choice param.
    pub fn string(&self, key: &str) -> String {
        self.ctx.params.s(key).to_string()
    }

    /// The persons on the wall (LED pixels, through the scene's projection), the same all frame.
    pub fn bodies(&mut self) -> Arc<Vec<Body>> {
        if self.bodies.is_none() {
            self.bodies = Some(Arc::new(bodies(self.ctx)));
        }
        self.bodies.clone().unwrap_or_default()
    }

    /// Ids of the persons that came / left in this frame.
    pub fn entered(&self) -> Vec<u32> {
        self.ctx.kinect.view.entered.clone()
    }
    pub fn left(&self) -> Vec<u32> {
        self.ctx.kinect.view.left.clone()
    }

    /// Plays a sound once (volume 0..1).
    pub fn play(&mut self, pcm: &Pcm, volume: f32) {
        self.ctx.audio.play(pcm, volume);
    }

    /// The status line in the control center.
    pub fn status(&mut self, s: impl Into<String>) {
        *self.ctx.status = s.into();
    }

    /// Games: true while a round runs (the show waits for its end before it switches).
    pub fn hold(&mut self, running: bool) {
        *self.ctx.hold_switch = Some(running);
    }
}

impl Paints for Frame<'_, '_> {
    fn painter(&mut self) -> &mut Draw {
        self.draw
    }
}

impl Deref for Frame<'_, '_> {
    type Target = Draw;
    fn deref(&self) -> &Draw {
        self.draw
    }
}

impl DerefMut for Frame<'_, '_> {
    fn deref_mut(&mut self) -> &mut Draw {
        self.draw
    }
}

/// A sketch as a scene.
pub struct SketchScene<S: Sketch> {
    sketch: S,
    draw: Draw,
}

impl<S: Sketch> Scene for SketchScene<S> {
    fn frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String> {
        self.draw.begin();
        {
            let mut f = Frame { ctx: &mut *ctx, draw: &mut self.draw, bodies: None };
            self.sketch.frame(&mut f);
        }
        self.draw.finish(ctx);
        Ok(())
    }
}

/// setup() of a sketch scene (wall::scene! uses it as SceneDef::make).
pub fn make<S: Sketch>(ctx: &SetupCtx) -> Result<Box<dyn Scene>, String> {
    let mut draw = Draw::new(&ctx.gpu, ctx.width, ctx.height)?;
    let sketch = S::setup(&mut Setup { ctx, draw: &mut draw })?;
    Ok(Box::new(SketchScene { sketch, draw }))
}
