//! The mirror world (mirror.js), from the shared LED wall core (ctx.wall): a point of a person goes
//! through the wall mapping (mirrored, the walk stretched over the whole wall, the person's shift)
//! onto the wall, then behind it (wall.mirror: x from the wall center, y up, z = -distance from the
//! wall) and `pull` m closer.
//!
//! The camera looks from the eye through the wall rectangle (off_axis_projection), so far things get
//! small, as in a mirror. `real` (0..1) moves the picture of the people towards where the wall setup
//! puts them, like every other wall scene and the calibration test image: real size, at their mapped
//! place. Their points slide along the eye's rays for it, so the depth stays: they still stand in
//! front of and behind things of the world, and the world keeps its parallax around them.

use bevy::math::Vec3;

use crate::wall::WallMap;

/// MirrorMap after its update() for this frame.
pub struct Mirror<'a> {
    pub wall: &'a WallMap,
    /// x from the wall center, height, distance in front of the wall (m)
    pub eye: [f32; 3],
    pub pull: f32,
    pub real: f32,
    /// camera frame (m) -> room, three rows of x y z 1
    cam: [f32; 12],
}

// the names of mirror.js (fromWall, fromWorld, fromCamera)
#[allow(clippy::wrong_self_convention)]
impl<'a> Mirror<'a> {
    /// The eye [x, y, distance] the people are placed for, pull (m), real 0..1.
    pub fn new(wall: &'a WallMap, eye: [f32; 3], pull: f32, real: f32) -> Self {
        // camera (x right, y down, z forward) -> world (xSign x, -y, z) -> room
        let m = &wall.room;
        let mut cam = [0.0_f32; 12];
        for i in 0..3 {
            cam[4 * i] = m[i] * wall.x_sign;
            cam[4 * i + 1] = -m[4 + i];
            cam[4 * i + 2] = m[8 + i];
            cam[4 * i + 3] = m[12 + i];
        }
        Self { wall, eye: [eye[0], eye[1], eye[2].max(0.1)], pull, real: real.clamp(0.0, 1.0), cam }
    }

    /// How much bigger than on the wall a placed thing is in the world, at mirror depth z.
    pub fn scale(&self, z: f32) -> f32 {
        let d = self.eye[2];
        1.0 - (self.real * z.min(0.9 * d)) / d
    }

    /// wall point (m) -> mirror world, placed
    pub fn from_wall(&self, w: Vec3) -> [f32; 3] {
        let m = self.wall.mirror(w);
        let z = m.z + self.pull;
        // along the eye's ray: the picture on the wall goes from the mirror's perspective to the mapping
        let s = self.scale(z);
        [self.eye[0] + (m.x - self.eye[0]) * s, self.eye[1] + (m.y - self.eye[1]) * s, z]
    }

    /// world point (m, as ctx.persons) of person `slot` -> mirror world
    pub fn from_world(&self, world: Vec3, slot: u8) -> [f32; 3] {
        self.from_wall(self.wall.from_world(world, slot as usize))
    }

    /// Kinect camera point (m) of person `slot` -> mirror world
    pub fn from_camera(&self, x: f32, y: f32, z: f32, slot: usize) -> [f32; 3] {
        let c = &self.cam;
        let r = Vec3::new(c[0] * x + c[1] * y + c[2] * z + c[3], c[4] * x + c[5] * y + c[6] * z + c[7], c[8] * x + c[9] * y + c[10] * z + c[11]);
        self.from_wall(self.wall.from_room(r, slot))
    }

    /// m from the wall of a point at mirror depth z (the people's colors go by it)
    pub fn distance(&self, z: f32) -> f32 {
        self.pull - z
    }

    /// world velocity (m/s) of a world point of person `slot` -> mirror world (stretched walk included)
    pub fn velocity(&self, world: Vec3, vel: Vec3, slot: u8) -> [f32; 3] {
        let z = self.pull - self.wall.from_world(world, slot as usize).z;
        let v = self.wall.velocity(world, vel, slot as usize);
        let s = self.scale(z);
        [v.x * s, v.y * s, -v.z]
    }

    /// A point on the floor of the mirror world (y = 0) that is seen where the world point (the feet,
    /// person.ground) is seen: for ripples and quakes around the feet. Always behind the wall.
    pub fn floor(&self, world: Vec3, slot: u8) -> [f32; 3] {
        let p = self.from_world(world, slot);
        let [ex, ey, d] = self.eye;
        let t_min = (d + 0.05) / (d - p[2]).max(1e-3); // the floor starts behind the wall
        let t = if p[1] < ey - 1e-3 { t_min.max(ey / (ey - p[1])) } else { t_min };
        [ex + (p[0] - ex) * t, 0.0, d - (d - p[2]) * t]
    }
}
