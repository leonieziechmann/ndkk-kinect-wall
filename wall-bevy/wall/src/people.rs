//! The persons as a scene draws them: every joint in LED pixels, through the scene's projection
//! (the play field mapped onto the wall, as ctx.wall places them), with their color and slot.

use glam::Vec2;

use crate::persons::{BONES, NPOINTS, j};
use crate::scene::FrameCtx;

/// A person on the wall, in LED pixels.
#[derive(Clone, Debug)]
pub struct Body {
    pub id: u32,
    /// 1.. (the tracking's slot: the person's color in every scene)
    pub slot: u8,
    pub color: [f32; 3],
    /// every joint (persons::j::*), None where it is not seen
    pub joints: [Option<Vec2>; NPOINTS],
    /// the body's centre on the wall
    pub center: Vec2,
    /// px from the highest joint to the lowest (the body's height on the wall)
    pub height: f32,
    /// came in this frame
    pub entered: bool,
    /// s since the tracking first saw this person
    pub age: f32,
    /// px/s across the wall (+ = right)
    pub vx: f32,
    /// 0..1: 1 at the near end of the zone, 0 at the far end
    pub near: f32,
}

impl Body {
    pub fn joint(&self, j: usize) -> Option<Vec2> {
        self.joints.get(j).copied().flatten()
    }

    /// The head, else the neck.
    pub fn head(&self) -> Option<Vec2> {
        self.joint(j::HEAD).or(self.joint(j::NOSE)).or(self.joint(j::NECK))
    }

    /// [left, right] hands (else the wrists).
    pub fn hands(&self) -> [Option<Vec2>; 2] {
        [self.joint(j::LEFT_HAND).or(self.joint(j::LEFT_WRIST)), self.joint(j::RIGHT_HAND).or(self.joint(j::RIGHT_WRIST))]
    }

    /// [left, right] feet.
    pub fn feet(&self) -> [Option<Vec2>; 2] {
        [self.joint(j::LEFT_ANKLE), self.joint(j::RIGHT_ANKLE)]
    }

    /// The highest point (smallest y), for a label above the person.
    pub fn top(&self) -> Vec2 {
        self.joints.iter().flatten().copied().min_by(|a, b| a.y.total_cmp(&b.y)).unwrap_or(self.center)
    }

    /// The bones whose both ends are seen.
    pub fn bones(&self) -> impl Iterator<Item = (Vec2, Vec2)> + '_ {
        BONES.iter().filter_map(|&(a, b)| Some((self.joint(a)?, self.joint(b)?)))
    }

    /// Is a hand above the head (by `margin` px)?
    pub fn hand_up(&self, margin: f32) -> bool {
        let Some(h) = self.head() else { return false };
        self.hands().iter().flatten().any(|p| p.y < h.y - margin)
    }
}

/// The visible persons on the wall, in LED pixels.
pub fn bodies(ctx: &FrameCtx) -> Vec<Body> {
    let view = &ctx.kinect.view;
    let wall = &*ctx.wall;
    view.iter()
        .map(|p| {
            let mut joints = [None; NPOINTS];
            for (k, slot) in joints.iter_mut().enumerate() {
                *slot = wall.joint(p, k).map(|w| {
                    let [x, y] = wall.px(w.x, w.y);
                    Vec2::new(x, y)
                });
            }
            let placed = wall.placed(p.id);
            let center = placed
                .map(|q| {
                    let [x, y] = wall.px(q.x, q.y);
                    Vec2::new(x, y)
                })
                .or(joints[j::CENTER])
                .or(joints[j::PELVIS])
                .unwrap_or(Vec2::ZERO);
            let ys = joints.iter().flatten().map(|v| v.y);
            let (lo, hi) = ys.fold((f32::MAX, f32::MIN), |(lo, hi), y| (lo.min(y), hi.max(y)));
            let px_per_m = wall.setup.led_w as f32 / wall.setup.size_w.max(0.01);
            Body {
                id: p.id,
                slot: p.slot,
                color: p.color,
                joints,
                center,
                height: if hi > lo { hi - lo } else { 0.0 },
                entered: view.entered.contains(&p.id),
                age: p.age,
                vx: placed.map_or(0.0, |q| q.vx * px_per_m),
                near: placed.map_or(0.5, |q| wall.near(q.dist)),
            }
        })
        .collect()
}
