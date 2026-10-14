//! Simple 3D scenes for the simulator: planes, boxes, spheres and capsules in camera space
//! (mm; x right, y down, z forward, the camera at the origin looking along +z).

/// A 3D vector.
pub type V3 = [f32; 3];

fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn scale(a: V3, s: f32) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn norm(a: V3) -> V3 {
    let l = dot(a, a).sqrt();
    if l > 0.0 { scale(a, 1.0 / l) } else { [0.0, 0.0, 1.0] }
}

/// Geometry of an object.
#[derive(Clone, Debug, PartialEq)]
pub enum Shape {
    /// infinite plane through `point` with `normal`
    Plane {
        /// a point on the plane
        point: V3,
        /// its normal
        normal: V3,
    },
    /// a finite rectangle: center, two half-axes
    Rect {
        /// center
        center: V3,
        /// half of one side
        half_u: V3,
        /// half of the other side
        half_v: V3,
    },
    /// a sphere
    Sphere {
        /// center
        center: V3,
        /// radius
        radius: f32,
    },
    /// a capsule (cylinder with round ends) from `a` to `b`
    Capsule {
        /// one end
        a: V3,
        /// the other end
        b: V3,
        /// radius
        radius: f32,
    },
    /// an axis-aligned box
    Cuboid {
        /// smallest corner
        min: V3,
        /// largest corner
        max: V3,
    },
}

/// An object: shape and how it reflects the Kinect's infrared light.
#[derive(Clone, Debug, PartialEq)]
pub struct Object {
    /// geometry
    pub shape: Shape,
    /// diffuse reflectivity 0..1 at 850 nm (skin ~0.5, white wall ~0.8, black cloth ~0.05)
    pub albedo: f32,
    /// extra factor for retroreflective material (1 = none, 50 = reflective tape)
    pub retro: f32,
}

impl Object {
    /// A diffuse object.
    pub fn new(shape: Shape, albedo: f32) -> Object {
        Object { shape, albedo, retro: 1.0 }
    }
}

/// What a ray hit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hit {
    /// distance along the (unit) ray, mm
    pub t: f32,
    /// cosine between the ray and the surface normal
    pub cos_incidence: f32,
    /// albedo times retroreflection
    pub reflect: f32,
}

/// A scene.
#[derive(Clone, Debug, PartialEq)]
pub struct Scene {
    /// the objects
    pub objects: Vec<Object>,
    /// ambient infrared (sunlight, lamps) in raw sensor units per tap; 0 in the dark
    pub ambient: f32,
    /// infrared value (libfreenect2 scale) of a white (albedo 1) surface facing the camera at 1 m
    pub brightness: f32,
}

impl Scene {
    /// Casts a ray (unit direction from the camera) and returns the nearest hit.
    pub fn cast(&self, dir: V3) -> Option<Hit> {
        let mut best: Option<Hit> = None;
        for o in &self.objects {
            if let Some((t, n)) = intersect(&o.shape, dir)
                && t > 1.0
                && best.is_none_or(|b| t < b.t)
            {
                let c = dot(n, dir).abs().clamp(0.0, 1.0);
                best = Some(Hit { t, cos_incidence: c, reflect: o.albedo * o.retro });
            }
        }
        best
    }

    /// One of the built-in scenes at time `t` (seconds; objects move), or `None` for an unknown
    /// name. Names: `room`, `near`, `far`, `ramp`, `sun`, `hall`, `flat`.
    pub fn preset(name: &str, t: f32) -> Option<Scene> {
        Some(match name {
            "room" => room(t, 150.0),
            "sun" => room(t, 2500.0),
            "near" => near(t),
            "far" => far(t),
            "ramp" => ramp(),
            "hall" => hall(t),
            "flat" => flat(2000.0),
            _ => return None,
        })
    }

    /// Names of the built-in scenes.
    pub const PRESETS: [&'static str; 7] = ["room", "near", "far", "ramp", "sun", "hall", "flat"];
}

fn person(x: f32, z: f32, floor_y: f32, albedo: f32) -> Vec<Object> {
    let head_y = floor_y - 1600.0;
    vec![
        Object::new(Shape::Capsule { a: [x, floor_y - 900.0, z], b: [x, head_y + 380.0, z], radius: 190.0 }, albedo),
        Object::new(Shape::Capsule { a: [x - 90.0, floor_y - 60.0, z], b: [x - 90.0, floor_y - 850.0, z], radius: 85.0 }, albedo * 0.8),
        Object::new(Shape::Capsule { a: [x + 90.0, floor_y - 60.0, z], b: [x + 90.0, floor_y - 850.0, z], radius: 85.0 }, albedo * 0.8),
        Object::new(Shape::Sphere { center: [x, head_y + 120.0, z], radius: 115.0 }, 0.55),
        // arms
        Object::new(Shape::Capsule { a: [x - 230.0, head_y + 420.0, z], b: [x - 330.0, head_y + 980.0, z - 120.0], radius: 55.0 }, albedo),
        Object::new(Shape::Capsule { a: [x + 230.0, head_y + 420.0, z], b: [x + 520.0, head_y + 600.0, z - 380.0], radius: 55.0 }, albedo),
    ]
}

fn walls(floor_y: f32, back_z: f32, half_width: f32, ceiling_y: f32) -> Vec<Object> {
    vec![
        Object::new(Shape::Plane { point: [0.0, floor_y, 0.0], normal: [0.0, -1.0, 0.0] }, 0.35),
        Object::new(Shape::Plane { point: [0.0, ceiling_y, 0.0], normal: [0.0, 1.0, 0.0] }, 0.75),
        Object::new(Shape::Plane { point: [0.0, 0.0, back_z], normal: [0.0, 0.0, -1.0] }, 0.7),
        Object::new(Shape::Plane { point: [-half_width, 0.0, 0.0], normal: [1.0, 0.0, 0.0] }, 0.6),
        Object::new(Shape::Plane { point: [half_width, 0.0, 0.0], normal: [-1.0, 0.0, 0.0] }, 0.6),
    ]
}

/// A living room: back wall at 4.5 m, two people, a table, a dark sofa.
fn room(t: f32, ambient: f32) -> Scene {
    let floor = 1000.0;
    let mut objects = walls(floor, 4500.0, 2600.0, -1500.0);
    let walk = (t * 0.6).sin() * 700.0;
    objects.extend(person(-700.0 + walk, 2100.0, floor, 0.5));
    objects.extend(person(900.0, 3300.0 + walk * 0.5, floor, 0.3));
    objects.push(Object::new(Shape::Cuboid { min: [600.0, 250.0, 1300.0], max: [1500.0, 300.0, 2100.0] }, 0.6));
    objects.push(Object::new(Shape::Cuboid { min: [-2500.0, 300.0, 3900.0], max: [-600.0, 1000.0, 4500.0] }, 0.06));
    Scene { objects, ambient, brightness: 16000.0 }
}

/// A hand right in front of the sensor (saturates), a forearm, a wall at 1.2 m.
fn near(t: f32) -> Scene {
    let z = 260.0 + 140.0 * (t * 0.8).sin();
    let objects = vec![
        Object::new(Shape::Plane { point: [0.0, 0.0, 1200.0], normal: [0.0, 0.0, -1.0] }, 0.8),
        Object::new(Shape::Sphere { center: [-40.0, -20.0, z], radius: 55.0 }, 0.55),
        Object::new(Shape::Capsule { a: [-40.0, 30.0, z + 20.0], b: [-120.0, 380.0, z + 260.0], radius: 38.0 }, 0.5),
        Object::new(Shape::Capsule { a: [60.0, -60.0, z - 10.0], b: [130.0, -150.0, z - 30.0], radius: 11.0 }, 0.55),
        Object::new(Shape::Sphere { center: [260.0, 120.0, 650.0], radius: 90.0 }, 0.9),
    ];
    Scene { objects, ambient: 150.0, brightness: 16000.0 }
}

/// A long hall: people at 6, 9 and 12.5 m, the end wall at 16 m.
fn far(t: f32) -> Scene {
    let floor = 900.0;
    let mut objects = walls(floor, 16000.0, 1600.0, -2200.0);
    objects.extend(person(-500.0, 6000.0 + 300.0 * t.sin(), floor, 0.5));
    objects.extend(person(450.0, 9000.0, floor, 0.5));
    objects.extend(person(-200.0, 12500.0, floor, 0.6));
    Scene { objects, ambient: 150.0, brightness: 16000.0 }
}

/// A floor that runs from the sensor to beyond the unambiguous range, with a step pattern.
fn ramp() -> Scene {
    let mut objects = vec![Object::new(Shape::Plane { point: [0.0, 700.0, 0.0], normal: [0.0, -1.0, 0.0] }, 0.6)];
    objects.push(Object::new(Shape::Plane { point: [0.0, 0.0, 30000.0], normal: [0.0, 0.0, -1.0] }, 0.8));
    for i in 0..9 {
        let z = 1000.0 + 2000.0 * i as f32;
        objects.push(Object::new(Shape::Cuboid { min: [-1800.0 + 400.0 * i as f32, -600.0, z], max: [-1400.0 + 400.0 * i as f32, 700.0, z + 300.0] }, 0.7));
    }
    Scene { objects, ambient: 100.0, brightness: 16000.0 }
}

/// A big room with a retroreflective safety vest and black clothes.
fn hall(t: f32) -> Scene {
    let floor = 1000.0;
    let mut objects = walls(floor, 9000.0, 4000.0, -2500.0);
    objects.extend(person(-1200.0, 2500.0 + 500.0 * (t * 0.5).sin(), floor, 0.05));
    objects.extend(person(1000.0, 5000.0, floor, 0.5));
    let mut vest = Object::new(Shape::Rect { center: [1000.0, -350.0, 4790.0], half_u: [150.0, 0.0, 0.0], half_v: [0.0, 40.0, 0.0] }, 0.9);
    vest.retro = 60.0;
    objects.push(vest);
    Scene { objects, ambient: 300.0, brightness: 16000.0 }
}

/// A flat wall facing the camera at `distance` mm (tests).
pub fn flat(distance: f32) -> Scene {
    Scene { objects: vec![Object::new(Shape::Plane { point: [0.0, 0.0, distance], normal: [0.0, 0.0, -1.0] }, 0.7)], ambient: 150.0, brightness: 16000.0 }
}

/// Ray from the origin along unit `d`: hit distance and surface normal.
fn intersect(shape: &Shape, d: V3) -> Option<(f32, V3)> {
    match shape {
        Shape::Plane { point, normal } => {
            let n = norm(*normal);
            let den = dot(n, d);
            if den.abs() < 1e-6 {
                return None;
            }
            let t = dot(n, *point) / den;
            (t > 0.0).then_some((t, n))
        }
        Shape::Rect { center, half_u, half_v } => {
            let n = norm(cross(*half_u, *half_v));
            let den = dot(n, d);
            if den.abs() < 1e-6 {
                return None;
            }
            let t = dot(n, *center) / den;
            if t <= 0.0 {
                return None;
            }
            let p = sub(scale(d, t), *center);
            let (lu, lv) = (dot(*half_u, *half_u), dot(*half_v, *half_v));
            let inside = lu > 0.0 && lv > 0.0 && (dot(p, *half_u) / lu).abs() <= 1.0 && (dot(p, *half_v) / lv).abs() <= 1.0;
            inside.then_some((t, n))
        }
        Shape::Sphere { center, radius } => {
            let b = dot(d, *center);
            let c = dot(*center, *center) - radius * radius;
            let disc = b * b - c;
            if disc < 0.0 {
                return None;
            }
            let s = disc.sqrt();
            let t = if b - s > 0.0 { b - s } else { b + s };
            if t <= 0.0 {
                return None;
            }
            Some((t, norm(sub(scale(d, t), *center))))
        }
        Shape::Capsule { a, b, radius } => capsule(d, *a, *b, *radius),
        Shape::Cuboid { min, max } => {
            let mut t0 = f32::NEG_INFINITY;
            let mut t1 = f32::INFINITY;
            let mut axis = 0;
            for (i, ((lo, hi), di)) in min.iter().zip(max).zip(d).enumerate() {
                let (lo, hi, di) = (*lo, *hi, di);
                if di.abs() < 1e-9 {
                    if 0.0 < lo || 0.0 > hi {
                        return None;
                    }
                    continue;
                }
                let (mut a, mut b) = (lo / di, hi / di);
                if a > b {
                    std::mem::swap(&mut a, &mut b);
                }
                if a > t0 {
                    t0 = a;
                    axis = i;
                }
                t1 = t1.min(b);
            }
            if t0 > t1 || t0 <= 0.0 {
                return None;
            }
            let mut n = [0.0; 3];
            let dir = d.get(axis).copied().unwrap_or(0.0);
            if let Some(v) = n.get_mut(axis) {
                *v = if dir > 0.0 { -1.0 } else { 1.0 };
            }
            Some((t0, n))
        }
    }
}

fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// Capsule intersection (after Inigo Quilez), ray origin at 0.
fn capsule(rd: V3, pa: V3, pb: V3, r: f32) -> Option<(f32, V3)> {
    let ro = [0.0f32; 3];
    let ba = sub(pb, pa);
    let oa = sub(ro, pa);
    let baba = dot(ba, ba);
    let bard = dot(ba, rd);
    let baoa = dot(ba, oa);
    let rdoa = dot(rd, oa);
    let oaoa = dot(oa, oa);
    let a = baba - bard * bard;
    let b = baba * rdoa - baoa * bard;
    let c = baba * oaoa - baoa * baoa - r * r * baba;
    let h = b * b - a * c;
    if h >= 0.0 && a.abs() > 1e-9 {
        let t = (-b - h.sqrt()) / a;
        let y = baoa + t * bard;
        if y > 0.0 && y < baba && t > 0.0 {
            let p = scale(rd, t);
            let q = add(pa, scale(ba, y / baba));
            return Some((t, norm(sub(p, q))));
        }
        // caps
        let oc = if y <= 0.0 { oa } else { sub(ro, pb) };
        let b2 = dot(rd, oc);
        let c2 = dot(oc, oc) - r * r;
        let h2 = b2 * b2 - c2;
        if h2 > 0.0 {
            let t = -b2 - h2.sqrt();
            if t > 0.0 {
                let cap = if y <= 0.0 { pa } else { pb };
                return Some((t, norm(sub(scale(rd, t), cap))));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_wall_distance() {
        let s = flat(2000.0);
        let h = s.cast([0.0, 0.0, 1.0]).unwrap();
        assert!((h.t - 2000.0).abs() < 1e-3);
        assert!((h.cos_incidence - 1.0).abs() < 1e-6);
        let d = norm([0.3, 0.0, 1.0]);
        let h = s.cast(d).unwrap();
        assert!((h.t * d[2] - 2000.0).abs() < 1e-2);
    }

    #[test]
    fn presets_hit_something_in_the_middle() {
        for name in Scene::PRESETS {
            let s = Scene::preset(name, 0.0).unwrap();
            assert!(s.cast([0.0, 0.0, 1.0]).is_some(), "{name}");
        }
        assert!(Scene::preset("nope", 0.0).is_none());
    }

    #[test]
    fn capsule_and_box_hits() {
        let c = Shape::Capsule { a: [0.0, -500.0, 2000.0], b: [0.0, 500.0, 2000.0], radius: 200.0 };
        let (t, _) = intersect(&c, [0.0, 0.0, 1.0]).unwrap();
        assert!((t - 1800.0).abs() < 1e-2);
        let b = Shape::Cuboid { min: [-100.0, -100.0, 1000.0], max: [100.0, 100.0, 1200.0] };
        let (t, n) = intersect(&b, [0.0, 0.0, 1.0]).unwrap();
        assert!((t - 1000.0).abs() < 1e-3);
        assert_eq!(n, [0.0, 0.0, -1.0]);
    }
}
