//! Everything a scene usually needs: `use wall::prelude::*;`

pub use crate::audio::{Pcm, RATE};
pub use crate::common::rand::{Rng, random};
pub use crate::draw::{Anchor, Blend, Color, Draw, Image, Paint, Paints, Text, hex, hsl, rgb, rgb8, rgba};
pub use crate::glam::{Vec2, Vec3, vec2, vec3};
pub use crate::particles::{Particle, Particles};
pub use crate::people::Body;
pub use crate::persons::j;
pub use crate::scene::{FrameCtx, Scene, SceneDef, SetupCtx};
pub use crate::sketch::{Frame, Setup, Sketch};
pub use crate::ui;
pub use crate::ui::{Fade, Qr, Score, Toasts, Ui, ease_out, envelope, smooth};
pub use crate::{export_scenes, scene};
