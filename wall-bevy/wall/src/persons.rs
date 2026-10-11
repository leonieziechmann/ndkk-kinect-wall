//! The tracked persons as scenes see them (port of web/lib/persons.js, personView/makePerson):
//! named points in world, room and image space, smoothed with a One-Euro filter, plus the raw
//! entries of the hub (camera frame, mm). See web/PERSONS.md.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use glam::{Vec2, Vec3};
use serde::Deserialize;

pub const MAX_PERSONS: usize = 16;
pub const SLOTS: usize = 17;
pub const W: usize = 512;
pub const H: usize = 424;
pub const N: usize = W * H;

/// Every point of a person: the 17 COCO joints, then neck, pelvis, head, leftHand, rightHand, center, ground.
pub const POINTS: [&str; 24] = [
    "nose", "leftEye", "rightEye", "leftEar", "rightEar", "leftShoulder", "rightShoulder", "leftElbow", "rightElbow", "leftWrist", "rightWrist",
    "leftHip", "rightHip", "leftKnee", "rightKnee", "leftAnkle", "rightAnkle", "neck", "pelvis", "head", "leftHand", "rightHand", "center", "ground",
];
pub const NPOINTS: usize = 24;

#[allow(dead_code)]
pub mod j {
    pub const NOSE: usize = 0;
    pub const LEFT_EYE: usize = 1;
    pub const RIGHT_EYE: usize = 2;
    pub const LEFT_EAR: usize = 3;
    pub const RIGHT_EAR: usize = 4;
    pub const LEFT_SHOULDER: usize = 5;
    pub const RIGHT_SHOULDER: usize = 6;
    pub const LEFT_ELBOW: usize = 7;
    pub const RIGHT_ELBOW: usize = 8;
    pub const LEFT_WRIST: usize = 9;
    pub const RIGHT_WRIST: usize = 10;
    pub const LEFT_HIP: usize = 11;
    pub const RIGHT_HIP: usize = 12;
    pub const LEFT_KNEE: usize = 13;
    pub const RIGHT_KNEE: usize = 14;
    pub const LEFT_ANKLE: usize = 15;
    pub const RIGHT_ANKLE: usize = 16;
    pub const NECK: usize = 17;
    pub const PELVIS: usize = 18;
    pub const HEAD: usize = 19;
    pub const LEFT_HAND: usize = 20;
    pub const RIGHT_HAND: usize = 21;
    pub const CENTER: usize = 22;
    pub const GROUND: usize = 23;
}

/// POINTS index of a name.
pub fn point(name: &str) -> Option<usize> {
    POINTS.iter().position(|p| *p == name)
}

/// A clean stick figure: pairs of POINTS indices.
pub const BONES: [(usize, usize); 16] = [
    (j::HEAD, j::NECK),
    (j::NECK, j::LEFT_SHOULDER),
    (j::NECK, j::RIGHT_SHOULDER),
    (j::LEFT_SHOULDER, j::LEFT_ELBOW),
    (j::LEFT_ELBOW, j::LEFT_WRIST),
    (j::LEFT_WRIST, j::LEFT_HAND),
    (j::RIGHT_SHOULDER, j::RIGHT_ELBOW),
    (j::RIGHT_ELBOW, j::RIGHT_WRIST),
    (j::RIGHT_WRIST, j::RIGHT_HAND),
    (j::NECK, j::PELVIS),
    (j::PELVIS, j::LEFT_HIP),
    (j::PELVIS, j::RIGHT_HIP),
    (j::LEFT_HIP, j::LEFT_KNEE),
    (j::LEFT_KNEE, j::LEFT_ANKLE),
    (j::RIGHT_HIP, j::RIGHT_KNEE),
    (j::RIGHT_KNEE, j::RIGHT_ANKLE),
];

/// The 18 COCO pairs with the face.
#[allow(dead_code)]
pub const SKELETON: [(usize, usize); 18] = [
    (5, 6), (5, 7), (7, 9), (6, 8), (8, 10), (5, 11), (6, 12), (11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (0, 1), (0, 2), (1, 3), (2, 4), (3, 5), (4, 6),
];

/// One color per slot (1..16), neon on dark; index 0 is unused.
pub const PERSON_COLORS: [&str; 17] = [
    "#ffffff", "#29e6ff", "#ff3fd0", "#ffc23a", "#7dff5c", "#9a6bff", "#ff7a3d", "#4d8dff", "#3dffc0", "#ff5c7a", "#d4ff3a", "#c58bff", "#00c2b8", "#ff9a6b",
    "#a8e6ff", "#ff8be8", "#ffe08a",
];

/// '#rrggbb' -> [r, g, b] 0..1
pub fn hex_rgb(hex: &str) -> [f32; 3] {
    let v = u32::from_str_radix(hex.trim_start_matches('#'), 16).unwrap_or(0);
    [((v >> 16) & 255) as f32 / 255.0, ((v >> 8) & 255) as f32 / 255.0, (v & 255) as f32 / 255.0]
}

pub fn person_color(slot: u8) -> [f32; 3] {
    let s = slot as usize;
    hex_rgb(PERSON_COLORS[if (1..=MAX_PERSONS).contains(&s) { s } else { 0 }])
}

// ---------- the hub's result (JSON, camera frame in mm) ----------

/// A number that may be null in the JSON (NaN in the hub): NaN then.
#[derive(Clone, Copy, Debug, Default)]
pub struct F(pub f64);

impl<'de> Deserialize<'de> for F {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v: Option<f64> = Option::deserialize(d)?;
        Ok(F(v.unwrap_or(f64::NAN)))
    }
}

impl F {
    pub fn get(self) -> f64 {
        self.0
    }
    pub fn f(self) -> f32 {
        self.0 as f32
    }
}

/// One person as the hub sends it (PERSONS.md, ctx.kinect.persons.list).
#[derive(Clone, Debug, Deserialize)]
#[allow(dead_code)]
pub struct RawPerson {
    pub id: u32,
    pub slot: u8,
    pub visible: bool,
    #[serde(default)]
    pub age: F,
    #[serde(default)]
    pub score: F,
    #[serde(default)]
    pub pixels: u32,
    #[serde(default)]
    pub area: F,
    pub centroid: Option<[F; 3]>,
    pub head: Option<[F; 3]>,
    pub ground: Option<[F; 3]>,
    #[serde(default)]
    pub height: F,
    pub velocity: Option<[F; 3]>,
    pub bbox: Option<[F; 4]>,
    /// 17 × [x, y, z, confidence] mm
    pub joints: Vec<[F; 4]>,
    /// 17 × [u, v, confidence] depth image pixels
    pub keypoints: Vec<[F; 3]>,
    #[serde(default)]
    pub extra: Vec<[F; 4]>,
    #[serde(default, rename = "extraKeypoints")]
    pub extra_keypoints: Vec<[F; 3]>,
}

impl RawPerson {
    pub fn pt3(p: &Option<[F; 3]>) -> Option<[f64; 3]> {
        p.map(|a| [a[0].0, a[1].0, a[2].0]).filter(|a| a.iter().all(|v| v.is_finite()))
    }
}

/// The floor the tracker found (camera frame: normal, d in m).
#[derive(Clone, Debug, Deserialize)]
#[allow(dead_code)]
pub struct Floor {
    pub normal: [F; 3],
    pub d: F,
    pub height: F,
    #[serde(default, rename = "pitchDeg")]
    pub pitch_deg: F,
    #[serde(default, rename = "rollDeg")]
    pub roll_deg: F,
    #[serde(default)]
    pub source: Option<String>,
}

/// One tracking result with its masks (ctx.kinect.persons). Arrays shared, never changed.
#[derive(Clone)]
#[allow(dead_code)]
pub struct PersonsResult {
    pub seq: u32,
    pub capture_time_us: u64,
    pub list: Arc<Vec<RawPerson>>,
    pub floor: Option<Floor>,
    /// slot per pixel (512×424), None for exact results of live + exact
    pub labels: Option<Arc<Vec<u8>>>,
    /// mm of the person pixels, 0 elsewhere
    pub depth: Option<Arc<Vec<u16>>>,
    /// meters of the person pixels (GPU personDepthTexture)
    pub meters: Option<Arc<Vec<f32>>>,
    /// the person pixels in raster order: the first `count` entries
    pub indices: Option<Arc<Vec<u32>>>,
    pub count: usize,
    pub ms: f64,
    pub pose_ms: f64,
    pub pose_runs: u64,
    /// ms on the monotonic clock (see kinect.rs) when its depth frame arrived
    pub arrived: f64,
    /// ms it is shown after its depth frame arrived
    pub lag: f64,
}

// ---------- room frame ----------

/// World (m, x·xSign, y up, z forward) -> room (floor y = 0, origin below the sensor).
#[derive(Clone, Copy, Debug)]
pub struct RoomFrame {
    /// column-major mat4 (WGSL mat4x4f)
    pub matrix: [f32; 16],
    pub height: f32,
    pub up: Vec3,
    pub forward: Vec3,
    pub right: Vec3,
    pub found: bool,
}

impl RoomFrame {
    pub fn apply(&self, w: Vec3) -> Vec3 {
        Vec3::new(self.right.dot(w), self.up.dot(w) + self.height, self.forward.dot(w))
    }
}

pub fn room_frame(floor: Option<&Floor>, x_sign: f32, fallback_height: f32) -> RoomFrame {
    let mut up = Vec3::Y;
    let mut height = fallback_height;
    let mut found = false;
    if let Some(f) = floor
        && f.normal.iter().all(|v| v.0.is_finite())
        && f.d.0.is_finite()
    {
        up = Vec3::new(x_sign * f.normal[0].f(), -f.normal[1].f(), f.normal[2].f());
        height = f.d.f();
        found = true;
    }
    let k = up.z;
    let mut fwd = Vec3::new(-k * up.x, -k * up.y, 1.0 - k * up.z);
    let lf = fwd.length();
    fwd /= if lf > 0.0 { lf } else { 1.0 };
    let right = Vec3::new(up.y * fwd.z - up.z * fwd.y, up.z * fwd.x - up.x * fwd.z, up.x * fwd.y - up.y * fwd.x);
    let mut m = [0.0_f32; 16];
    for (jj, (r, (u, f))) in [right.x, right.y, right.z].into_iter().zip([up.x, up.y, up.z].into_iter().zip([fwd.x, fwd.y, fwd.z])).enumerate() {
        m[jj * 4] = r;
        m[jj * 4 + 1] = u;
        m[jj * 4 + 2] = f;
    }
    m[13] = height;
    m[15] = 1.0;
    RoomFrame { matrix: m, height, up, forward: fwd, right, found }
}

// ---------- One-Euro ----------

#[derive(Clone, Copy, Debug)]
pub struct Smoothing {
    pub min_cutoff: f32,
    pub beta: f32,
    pub d_cutoff: f32,
}

pub const SMOOTHING: Smoothing = Smoothing { min_cutoff: 1.2, beta: 0.6, d_cutoff: 1.0 };

fn alpha_of(cutoff: f32, dt: f32) -> f32 {
    1.0 / (1.0 + 1.0 / (2.0 * std::f32::consts::PI * cutoff * dt))
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Euro {
    x: Option<Vec3>,
    dx: Vec3,
}

impl Euro {
    pub fn step(&mut self, x: Vec3, dt: f32, cfg: &Smoothing) -> Vec3 {
        let Some(prev) = self.x else {
            self.x = Some(x);
            self.dx = Vec3::ZERO;
            return x;
        };
        if !(dt > 0.0) || dt > 0.5 {
            self.x = Some(x);
            self.dx = Vec3::ZERO;
            return x;
        }
        let a = alpha_of(cfg.d_cutoff, dt);
        self.dx += a * ((x - prev) / dt - self.dx);
        let speed = self.dx.length();
        let b = alpha_of(cfg.min_cutoff + cfg.beta * speed, dt);
        let nx = prev + b * (x - prev);
        self.x = Some(nx);
        nx
    }
}

// ---------- Person ----------

#[derive(Clone, Debug)]
pub struct RoomPoints {
    pub center: Option<Vec3>,
    pub head: Option<Vec3>,
    pub ground: Option<Vec3>,
    pub joints: [Option<Vec3>; NPOINTS],
}

#[derive(Clone, Debug)]
pub struct ImagePoints {
    /// [u0, v0, u1, v1] depth image pixels
    pub bbox: [f32; 4],
    pub center: Option<Vec2>,
    pub joints: [Option<Vec2>; NPOINTS],
}

#[derive(Clone, Debug)]
pub struct Person {
    pub id: u32,
    pub slot: u8,
    pub color: [f32; 3],
    pub css: &'static str,
    pub visible: bool,
    pub age: f32,
    pub score: f32,
    /// m: top of the head above the floor (NaN if unknown)
    pub height: f32,
    pub pixels: u32,
    pub area: f32,
    pub center: Option<Vec3>,
    pub head: Option<Vec3>,
    pub ground: Option<Vec3>,
    /// m/s, world
    pub velocity: Vec3,
    /// world m, smoothed; None = not seen
    pub joints: [Option<Vec3>; NPOINTS],
    pub confidence: [f32; NPOINTS],
    /// m/s of every point, None if unknown
    pub motion: [Option<Vec3>; NPOINTS],
    pub room: RoomPoints,
    pub image: ImagePoints,
    /// the raw entry (camera frame, mm)
    pub camera: RawPerson,
    filters: Box<[Euro; NPOINTS]>,
    x_sign: f32,
}

impl Person {
    pub fn joint(&self, name: &str) -> Option<Vec3> {
        point(name).and_then(|i| self.joints[i])
    }
}

fn make_person(c: &RawPerson, x_sign: f32, room: &RoomFrame, prev: Option<&Person>, dt: f32, smooth: Option<&Smoothing>) -> Person {
    let w = |p: [f64; 3]| Vec3::new(x_sign * p[0] as f32 / 1000.0, -p[1] as f32 / 1000.0, p[2] as f32 / 1000.0);
    let mut filters: Box<[Euro; NPOINTS]> = match prev {
        Some(p) if p.x_sign == x_sign => p.filters.clone(),
        _ => Box::new([Euro::default(); NPOINTS]),
    };
    let mut steady = |i: usize, p: Option<Vec3>| -> Option<Vec3> {
        match p {
            None => {
                filters[i] = Euro::default();
                None
            }
            Some(v) => Some(match smooth {
                Some(s) => filters[i].step(v, dt, s),
                None => v,
            }),
        }
    };
    let mut joints: [Option<Vec3>; NPOINTS] = [None; NPOINTS];
    let mut confidence = [0.0_f32; NPOINTS];
    let mut image_joints: [Option<Vec2>; NPOINTS] = [None; NPOINTS];
    let cam: Vec<[F; 4]> = c.joints.iter().chain(c.extra.iter()).copied().collect();
    let img: Vec<[F; 3]> = c.keypoints.iter().chain(c.extra_keypoints.iter()).copied().collect();
    for k in 0..cam.len().min(NPOINTS - 2) {
        let conf = cam[k][3].f();
        let ok = conf > 0.0 && cam[k][..3].iter().all(|v| v.0.is_finite());
        joints[k] = steady(k, if ok { Some(w([cam[k][0].0, cam[k][1].0, cam[k][2].0])) } else { None });
        confidence[k] = if conf.is_finite() { conf } else { 0.0 };
        image_joints[k] = match img.get(k) {
            Some(q) if conf > 0.0 && q[0].0.is_finite() && q[1].0.is_finite() => Some(Vec2::new(q[0].f(), q[1].f())),
            _ => None,
        };
    }
    let center = steady(j::CENTER, RawPerson::pt3(&c.centroid).map(w));
    let ground = steady(j::GROUND, RawPerson::pt3(&c.ground).map(w));
    let head = joints[j::HEAD].or_else(|| RawPerson::pt3(&c.head).map(w));
    joints[j::CENTER] = center;
    joints[j::GROUND] = ground;
    confidence[j::CENTER] = if c.visible { 1.0 } else { 0.0 };
    confidence[j::GROUND] = if c.visible { 1.0 } else { 0.0 };
    let bbox = c.bbox.map(|b| [b[0].f(), b[1].f(), b[2].f(), b[3].f()]).unwrap_or([0.0; 4]);
    image_joints[j::CENTER] = c.bbox.map(|_| Vec2::new((bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0));
    image_joints[j::GROUND] = None;
    let mut motion: [Option<Vec3>; NPOINTS] = [None; NPOINTS];
    if let Some(p) = prev
        && dt > 0.0
        && dt < 0.5
    {
        for i in 0..NPOINTS {
            if let (Some(a), Some(b)) = (p.joints[i], joints[i]) {
                motion[i] = Some((b - a) / dt);
            }
        }
    }
    let mut room_joints: [Option<Vec3>; NPOINTS] = [None; NPOINTS];
    for i in 0..NPOINTS {
        room_joints[i] = joints[i].map(|v| room.apply(v));
    }
    let velocity = RawPerson::pt3(&c.velocity).map(|v| Vec3::new(x_sign * v[0] as f32 / 1000.0, -v[1] as f32 / 1000.0, v[2] as f32 / 1000.0)).unwrap_or(Vec3::ZERO);
    let slot = c.slot;
    Person {
        id: c.id,
        slot,
        color: person_color(slot),
        css: PERSON_COLORS.get(slot as usize).copied().unwrap_or(PERSON_COLORS[0]),
        visible: c.visible,
        age: c.age.f(),
        score: c.score.f(),
        height: c.height.f(),
        pixels: c.pixels,
        area: c.area.f(),
        center,
        head,
        ground,
        velocity,
        joints,
        confidence,
        motion,
        room: RoomPoints { center: room_joints[j::CENTER], head: head.map(|h| room.apply(h)), ground: room_joints[j::GROUND], joints: room_joints },
        image: ImagePoints { bbox, center: image_joints[j::CENTER], joints: image_joints },
        camera: c.clone(),
        filters,
        x_sign,
    }
}

/// ctx.persons: the visible persons and the rest of the view (see persons.js, personView).
#[derive(Clone)]
#[allow(dead_code)]
pub struct PersonsView {
    /// the visible persons, by slot
    pub visible: Vec<Person>,
    /// every tracked person (also hidden ones)
    pub all: Vec<Person>,
    /// ids of the persons seen for the first time in this update
    pub entered: Vec<u32>,
    /// ids gone in this update
    pub left: Vec<u32>,
    /// true in the animation frame of an update
    pub fresh: bool,
    pub room: RoomFrame,
    pub floor: Option<Floor>,
    pub seq: Option<u32>,
    pub capture_time_us: u64,
    pub delay_ms: f64,
    seen_ids: VecDeque<u32>,
}

impl PersonsView {
    pub fn empty() -> Self {
        Self {
            visible: Vec::new(),
            all: Vec::new(),
            entered: Vec::new(),
            left: Vec::new(),
            fresh: false,
            room: room_frame(None, -1.0, 1.0),
            floor: None,
            seq: None,
            capture_time_us: 0,
            delay_ms: 0.0,
            seen_ids: VecDeque::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.visible.len()
    }

    pub fn is_empty(&self) -> bool {
        self.visible.is_empty()
    }

    pub fn iter(&self) -> std::slice::Iter<'_, Person> {
        self.visible.iter()
    }

    pub fn by_id(&self, id: u32) -> Option<&Person> {
        self.all.iter().find(|p| p.id == id)
    }

    pub fn by_slot(&self, slot: u8) -> Option<&Person> {
        self.all.iter().find(|p| p.slot == slot)
    }

    /// the persons seen for the first time in this update
    pub fn entered_persons(&self) -> impl Iterator<Item = &Person> {
        self.visible.iter().filter(|p| self.entered.contains(&p.id))
    }

    /// The view of a result, carrying the filters of `previous` (persons.js personView).
    pub fn build(result: &PersonsResult, x_sign: f32, previous: Option<&PersonsView>) -> PersonsView {
        let room = room_frame(result.floor.as_ref(), x_sign, 1.0);
        let before: HashMap<u32, &Person> = previous.map(|p| p.all.iter().map(|q| (q.id, q)).collect()).unwrap_or_default();
        let dt = match previous {
            Some(p) if p.capture_time_us > 0 => (result.capture_time_us as f64 - p.capture_time_us as f64) as f32 / 1e6,
            _ => 0.0,
        };
        let all: Vec<Person> = result.list.iter().map(|c| make_person(c, x_sign, &room, before.get(&c.id).copied(), dt, Some(&SMOOTHING))).collect();
        let mut visible: Vec<Person> = all.iter().filter(|p| p.visible).cloned().collect();
        visible.sort_by_key(|p| p.slot);
        let ids: HashSet<u32> = all.iter().map(|p| p.id).collect();
        let seen_before: HashSet<u32> = previous.map(|p| p.seen_ids.iter().copied().collect()).unwrap_or_default();
        let entered = visible.iter().filter(|p| !before.contains_key(&p.id) && !seen_before.contains(&p.id)).map(|p| p.id).collect();
        let left = before.keys().filter(|id| !ids.contains(id)).copied().collect();
        let mut seen_ids = previous.map(|p| p.seen_ids.clone()).unwrap_or_default();
        for p in &visible {
            if !seen_ids.contains(&p.id) {
                seen_ids.push_back(p.id);
            }
        }
        while seen_ids.len() > 256 {
            seen_ids.pop_front();
        }
        PersonsView {
            visible,
            all,
            entered,
            left,
            fresh: true,
            room,
            floor: result.floor.clone(),
            seq: Some(result.seq),
            capture_time_us: result.capture_time_us,
            delay_ms: result.lag,
            seen_ids,
        }
    }
}

impl<'a> IntoIterator for &'a PersonsView {
    type Item = &'a Person;
    type IntoIter = std::slice::Iter<'a, Person>;
    fn into_iter(self) -> Self::IntoIter {
        self.visible.iter()
    }
}

/// What a scene asks of the tracking (`persons: {...}` in the browser).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PersonOptions {
    /// frames the output waits for a later pose; 0 = live
    pub delay: u32,
    /// live and exact together (with delay > 0)
    pub live: bool,
    /// 'skeleton' only (the hub computes full masks anyway; kept for the scene's own logic)
    pub skeleton: bool,
}

impl Default for PersonOptions {
    fn default() -> Self {
        Self { delay: 12, live: false, skeleton: false }
    }
}

impl PersonOptions {
    pub fn live() -> Self {
        Self { delay: 0, live: false, skeleton: false }
    }
    pub fn exact() -> Self {
        Self::default()
    }
    pub fn both() -> Self {
        Self { delay: 12, live: true, skeleton: false }
    }
    /// live + exact (onExact / exactUpdates)
    pub fn dual(&self) -> bool {
        self.live && self.delay > 0
    }
    pub fn delayed(&self) -> bool {
        self.delay > 0 && !self.dual()
    }
}

/// How the persons of a frame are shown: exact (delayed), live, or both.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ViewMode {
    Exact,
    Live,
    Both,
}
