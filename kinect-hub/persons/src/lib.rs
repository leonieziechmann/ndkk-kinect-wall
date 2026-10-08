//! The people in the Kinect depth image: found by their skeletons, cut out of every depth frame.
//! A port of web/lib/persons-core.js (and persons-flow.js) to Rust, so that kinect-hub can track
//! once for all clients; the JavaScript stays the reference (web/PERSONS.md explains the method,
//! examples/backtest.rs compares both frame by frame).
//!
//! The 2D poses come from a pose model on the infrared image (YOLO-pose): a few frames late, and
//! only every few frames. Every depth frame is segmented on its own:
//!   1. background: what stays in place is learned, only where no person is
//!   2. segmentation: region growing from the person pixels of the previous frame and the bones of
//!      the skeletons, without depth jumps, within reach of the skeleton
//!   3. output: labels, the depth of the person pixels, the list of person pixels, per person
//!      position, head, ground point, height, velocity, joints (3D) and keypoints (2D)
//!   4. every 2 s: the floor (RANSAC on everything that is no person), else from the ankles
//!
//! Coordinates: Kinect camera frame, x right, y down, z forward. Depth and points in mm, the floor
//! plane in meters: n·p + d = height above the floor (n points up, d = height of the sensor).
//!
//! The logic is the JavaScript's, step by step (doubles, `Math.round` as `jround`, stable sorts in
//! the same order), so both track alike; examples/backtest.rs checks it on the backtest recordings
//! (same keypoint error, flicker and ids). Where it pays, the work is done differently with the same
//! result: precomputed body parts with a box test (Body), an optical flow on bilinear patches in
//! f32 with AVX2, integer background tests. 2-5 ms per frame instead of 12-30 ms in the browser.

mod arms;
mod floor;
pub mod flow;
mod frame;
mod segment;
mod skeleton;
mod tracker;

pub use frame::{FrameResult, PersonOut, STAGES};
pub use tracker::PersonTracker;

pub const W: usize = 512;
pub const H: usize = 424;
pub const N: usize = W * H;
/// Persons are labeled 1..MAX_PERSONS (slots); 0 = no person.
pub const MAX_PERSONS: usize = 16;

/// The 17 joints (COCO order) of `joints` and `keypoints`; left/right are the person's own sides.
pub const JOINTS: [&str; 17] = [
    "nose", "leftEye", "rightEye", "leftEar", "rightEar", "leftShoulder", "rightShoulder", "leftElbow", "rightElbow", "leftWrist",
    "rightWrist", "leftHip", "rightHip", "leftKnee", "rightKnee", "leftAnkle", "rightAnkle",
];
/// The points after the 17 joints in `extra` / `extra_keypoints`: derived from the joints.
pub const EXTRA: [&str; 5] = ["neck", "pelvis", "head", "leftHand", "rightHand"];
/// Joint pairs to draw a skeleton.
pub const SKELETON: [[usize; 2]; 18] = [
    [5, 6], [5, 7], [7, 9], [6, 8], [8, 10], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
    [0, 1], [0, 2], [1, 3], [2, 4], [3, 5], [4, 6],
];

/// What the tracker makes: masks and skeletons, or skeletons only (a fraction of the work).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Full,
    Skeleton,
}

/// The thresholds of persons-core.js (DEFAULTS there; numbers are doubles as in JavaScript).
#[derive(Clone, Debug)]
pub struct Options {
    pub mode: Mode,
    /// mm
    pub min_depth: f64,
    /// mm: farther pixels never belong to a person
    pub max_depth: f64,
    /// pose confidence for a new person
    pub min_score: f64,
    /// keypoints below this confidence are not used
    pub min_keypoint: f64,
    /// m added to every body part (clothes, hair, keypoint error)
    pub margin: f64,
    /// m: how far a person's pixel may lie from its body parts where the background is known
    pub reach: f64,
    /// mm: neighbor pixels connect if their depths differ by less than join_margin + join_slope * depth
    pub join_margin: f64,
    pub join_slope: f64,
    /// mm: a pixel is background if its depth is within bg_margin + bg_slope * depth of the learned one
    pub bg_margin: f64,
    pub bg_slope: f64,
    /// where the background is unknown, a depth that stays this many frames is learned
    pub learn_frames: f64,
    /// ... a depth farther than the background (what was there has left)
    pub far_frames: f64,
    /// ... a depth nearer than the background (something new that is no person)
    pub near_frames: f64,
    /// a person's pixel outside its body parts that has not moved for this long is background
    pub static_seconds: f64,
    /// m: pixels this close to the floor are floor, not feet
    pub floor_clearance: f64,
    /// a new person shows after this many pose detections
    pub confirm_poses: f64,
    /// a visible person the pose model does not find any more is kept this long
    pub keep_seconds: f64,
    /// a hidden person (no pixels) without a matching pose for this long is gone
    pub lost_seconds: f64,
    /// skeleton mode: a person without a pose for this long is not visible (but kept)
    pub stale_seconds: f64,
    /// estimate the floor plane
    pub floor: bool,
    pub max_persons: f64,
    pub fps: f64,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            mode: Mode::Full,
            min_depth: 400.0,
            max_depth: 4500.0,
            min_score: 0.45,
            min_keypoint: 0.35,
            margin: 0.045,
            reach: 0.6,
            join_margin: 50.0,
            join_slope: 0.035,
            bg_margin: 40.0,
            bg_slope: 0.02,
            learn_frames: 15.0,
            far_frames: 6.0,
            near_frames: 150.0,
            static_seconds: 8.0,
            floor_clearance: 0.025,
            confirm_poses: 2.0,
            keep_seconds: 4.0,
            lost_seconds: 1.5,
            stale_seconds: 0.5,
            floor: true,
            max_persons: MAX_PERSONS as f64,
            fps: 30.0,
        }
    }
}

impl Options {
    /// Sets an option by its JavaScript name (as scenes pass them); false if unknown or of the
    /// wrong kind. maxPersons is clamped to 1..16.
    pub fn set(&mut self, name: &str, value: OptionValue) -> bool {
        let num = |v: &OptionValue| if let OptionValue::Number(x) = v { Some(*x) } else { None };
        let ok = match (name, &value) {
            ("mode", OptionValue::Text(m)) => match m.as_str() {
                "full" => {
                    self.mode = Mode::Full;
                    true
                }
                "skeleton" => {
                    self.mode = Mode::Skeleton;
                    true
                }
                _ => false,
            },
            ("floor", OptionValue::Bool(b)) => {
                self.floor = *b;
                true
            }
            _ => {
                let Some(x) = num(&value) else { return false };
                let slot = match name {
                    "minDepth" => &mut self.min_depth,
                    "maxDepth" => &mut self.max_depth,
                    "minScore" => &mut self.min_score,
                    "minKeypoint" => &mut self.min_keypoint,
                    "margin" => &mut self.margin,
                    "reach" => &mut self.reach,
                    "joinMargin" => &mut self.join_margin,
                    "joinSlope" => &mut self.join_slope,
                    "bgMargin" => &mut self.bg_margin,
                    "bgSlope" => &mut self.bg_slope,
                    "learnFrames" => &mut self.learn_frames,
                    "farFrames" => &mut self.far_frames,
                    "nearFrames" => &mut self.near_frames,
                    "staticSeconds" => &mut self.static_seconds,
                    "floorClearance" => &mut self.floor_clearance,
                    "confirmPoses" => &mut self.confirm_poses,
                    "keepSeconds" => &mut self.keep_seconds,
                    "lostSeconds" => &mut self.lost_seconds,
                    "staleSeconds" => &mut self.stale_seconds,
                    "maxPersons" => &mut self.max_persons,
                    "fps" => &mut self.fps,
                    _ => return false,
                };
                *slot = x;
                true
            }
        };
        self.max_persons = jround(self.max_persons).clamp(1.0, MAX_PERSONS as f64);
        ok
    }
}

/// A value for Options::set.
#[derive(Clone, Debug)]
pub enum OptionValue {
    Number(f64),
    Bool(bool),
    Text(String),
}

/// One pose of the pose model, in depth image pixels (mirrored, as the hub sends the frames):
/// box u0, v0, u1, v1 and 17 keypoints (u, v, confidence), COCO order.
#[derive(Clone, Debug)]
pub struct PoseIn {
    pub score: f64,
    pub bbox: [f64; 4],
    /// stored as the JavaScript's Float32Array
    pub kp: [f32; 51],
}

/// The floor plane: n·p + d = height above the floor in m (camera frame, n points up).
#[derive(Clone, Debug, PartialEq)]
pub struct Floor {
    pub normal: [f64; 3],
    pub d: f64,
    pub height: f64,
    /// > 0: the sensor looks down
    pub pitch_deg: f64,
    pub roll_deg: f64,
    /// share of the samples on it
    pub support: f64,
    /// "seen" (RANSAC) or "feet" (level, below the ankles)
    pub source: &'static str,
}

/// JavaScript's Math.round: halves round up (towards +∞), -2.5 -> -2.
#[inline]
pub fn jround(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// Length of a vector (mm and pixels never overflow the plain formula).
#[inline]
pub(crate) fn hypot3(a: f64, b: f64, c: f64) -> f64 {
    (a * a + b * b + c * c).sqrt()
}

#[inline]
pub(crate) fn hypot2(a: f64, b: f64) -> f64 {
    (a * a + b * b).sqrt()
}

/// Rays of an ideal pinhole Kinect, until the real undistortion table is known.
pub fn pinhole_rays() -> Vec<f32> {
    let mut r = vec![0.0_f32; N * 2];
    for v in 0..H {
        for u in 0..W {
            r[(v * W + u) * 2] = ((u as f64 - 256.0) / 365.5) as f32;
            r[(v * W + u) * 2 + 1] = ((v as f64 - 206.0) / 365.5) as f32;
        }
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_like_javascript() {
        assert_eq!(jround(2.5), 3.0);
        assert_eq!(jround(-2.5), -2.0);
        assert_eq!(jround(-2.6), -3.0);
        assert_eq!(jround(0.49999999999999994), 0.0);
        assert_eq!(jround(-0.4), -0.0);
    }

    #[test]
    fn options_by_javascript_name() {
        let mut o = Options::default();
        assert!(o.set("maxDepth", OptionValue::Number(3500.0)));
        assert!(o.set("mode", OptionValue::Text("skeleton".into())));
        assert!(o.set("maxPersons", OptionValue::Number(40.0)));
        assert!(!o.set("maxDepth", OptionValue::Bool(true)));
        assert!(!o.set("nope", OptionValue::Number(1.0)));
        assert_eq!((o.max_depth, o.mode, o.max_persons), (3500.0, Mode::Skeleton, 16.0));
    }
}
