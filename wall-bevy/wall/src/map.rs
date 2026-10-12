//! The LED wall (port of the browser's wall.js, see WALL.md): one setup for every scene, a
//! projection per scene, and the mapping from the Kinect to the wall. The uniform buffer has the
//! same layout as `struct Wall` in WGSL, so the scenes' shaders run unchanged.

use std::collections::HashMap;
use std::sync::Arc;

use glam::Vec3;
use serde_json::{Value, json};

use crate::persons::{Person, PersonsResult, PersonsView, SLOTS};

pub const TAN_H: f32 = 0.708_166; // tan(70.6° / 2)
const KINECT_W: f32 = 512.0;
const KINECT_H: f32 = 424.0;
const MIN_Z: f32 = 0.3;
pub const LUT_N: usize = 33;
const LUT_SEG: usize = LUT_N - 1;
const MAX_CURVE_POINTS: usize = 5;

// ---------- JSON helpers ----------

pub fn get_path<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    let mut o = v;
    for k in key.split('.') {
        o = o.as_object()?.get(k)?;
    }
    Some(o)
}

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|x| x.is_finite())
}

fn clampf(v: f64, lo: f64, hi: f64) -> f64 {
    v.max(lo).min(hi)
}

// ---------- setup ----------

#[derive(Clone, Debug, PartialEq)]
pub struct OutWindow {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Block {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub points: Vec<[f32; 2]>,
}

/// The physical wall (setup.json, normalized as normalizeSetup()).
#[derive(Clone, Debug, PartialEq)]
pub struct Setup {
    pub led_w: u32,
    pub led_h: u32,
    pub size_w: f32,
    pub size_h: f32,
    pub bottom: f32,
    pub cabinet_w: u32,
    pub cabinet_h: u32,
    pub output_x: i32,
    pub output_y: i32,
    /// 'pixel' | 'stretch' | 'fit'
    pub output_fit: String,
    pub output_window: Option<OutWindow>,
    pub sensor_x: f32,
    pub sensor_front: f32,
    pub floor_auto: bool,
    pub sensor_height: f32,
    pub sensor_tilt: f32,
    // legacy (seed the default projection while there is no projection.json)
    pub mirror: bool,
    pub zone_near: f32,
    pub zone_far: f32,
    pub map_mode: String,
    pub map_factor: f32,
    pub map_distance: f32,
    pub map_depth: f32,
    pub map_apply: String,
    pub map_clamp: bool,
    pub map_margin: f32,
    pub map_lift: f32,
    pub map_scale_y: f32,
    pub map_image: String,
    pub brightness: f32,
    pub gamma: f32,
    pub gain: [f32; 3],
    pub blocks: Vec<Block>,
    /// the raw document (telemetry, control center)
    pub raw: Value,
}

impl Default for Setup {
    fn default() -> Self {
        normalize_setup(&Value::Null)
    }
}

pub fn normalize_setup(raw: &Value) -> Setup {
    let n = |key: &str, d: f64, lo: f64, hi: f64| clampf(num(get_path(raw, key)).unwrap_or(d), lo, hi);
    let b = |key: &str, d: bool| get_path(raw, key).and_then(Value::as_bool).unwrap_or(d);
    let sel = |key: &str, d: &str, opts: &[&str]| get_path(raw, key).and_then(Value::as_str).filter(|s| opts.contains(s)).unwrap_or(d).to_string();
    let mut s = Setup {
        led_w: n("led.w", 1008.0, 16.0, 7680.0).round() as u32,
        led_h: n("led.h", 336.0, 16.0, 4320.0).round() as u32,
        size_w: n("size.w", 6.0, 0.5, 30.0) as f32,
        size_h: n("size.h", 2.0, 0.2, 10.0) as f32,
        bottom: n("bottom", 0.0, 0.0, 5.0) as f32,
        cabinet_w: n("cabinet.w", 84.0, 8.0, 1024.0) as u32,
        cabinet_h: n("cabinet.h", 84.0, 8.0, 1024.0) as u32,
        output_x: n("output.x", 0.0, 0.0, 7680.0) as i32,
        output_y: n("output.y", 0.0, 0.0, 4320.0) as i32,
        output_fit: sel("output.fit", "pixel", &["pixel", "stretch", "fit"]),
        output_window: None,
        sensor_x: n("sensor.x", 0.0, -15.0, 15.0) as f32,
        sensor_front: n("sensor.front", 0.2, 0.0, 5.0) as f32,
        floor_auto: sel("sensor.floor", "auto", &["auto", "manual"]) == "auto",
        sensor_height: n("sensor.height", 0.85, 0.0, 4.0) as f32,
        sensor_tilt: n("sensor.tilt", 0.0, -45.0, 45.0) as f32,
        mirror: b("mirror", true),
        zone_near: n("zone.near", 0.5, 0.3, 8.0) as f32,
        zone_far: n("zone.far", 4.5, 0.5, 10.0) as f32,
        map_mode: sel("map.mode", "fit", &["real", "factor", "fit"]),
        map_factor: n("map.factor", 1.5, 0.25, 5.0) as f32,
        map_distance: n("map.distance", 3.0, 0.5, 10.0) as f32,
        map_depth: n("map.depth", 0.0, 0.0, 1.0) as f32,
        map_apply: sel("map.apply", "person", &["person", "points"]),
        map_clamp: b("map.clamp", true),
        map_margin: n("map.margin", 0.3, 0.0, 2.0) as f32,
        map_lift: n("map.lift", 0.0, -3.0, 3.0) as f32,
        map_scale_y: n("map.scaleY", 1.0, 0.25, 4.0) as f32,
        map_image: sel("map.image", "true", &["true", "stretch"]),
        brightness: n("color.brightness", 1.0, 0.0, 2.0) as f32,
        gamma: n("color.gamma", 1.0, 0.3, 3.0) as f32,
        gain: [n("color.r", 1.0, 0.0, 1.5) as f32, n("color.g", 1.0, 0.0, 1.5) as f32, n("color.b", 1.0, 0.0, 1.5) as f32],
        blocks: normalize_blocks(raw.get("blocks")),
        raw: Value::Null,
    };
    if s.zone_far <= s.zone_near {
        s.zone_far = s.zone_near + 0.5;
    }
    if let Some(w) = get_path(raw, "output.window")
        && let (Some(l), Some(t), Some(wd), Some(h)) = (num(w.get("left")), num(w.get("top")), num(w.get("width")), num(w.get("height")))
    {
        s.output_window = Some(OutWindow {
            left: l.round() as i32,
            top: t.round() as i32,
            width: (wd.round() as i32).max(1),
            height: (h.round() as i32).max(1),
            label: w.get("label").and_then(Value::as_str).unwrap_or("").chars().take(80).collect(),
        });
    }
    s.raw = setup_json(&s);
    s
}

fn normalize_blocks(raw: Option<&Value>) -> Vec<Block> {
    let mut out = Vec::new();
    for b in raw.and_then(Value::as_array).map(|a| a.iter().take(32).collect::<Vec<_>>()).unwrap_or_default() {
        let points: Vec<[f32; 2]> = b
            .get("points")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .take(64)
                    .filter_map(|p| {
                        let p = p.as_array()?;
                        let (x, z) = (num(p.first())?, num(p.get(1))?);
                        Some([((x * 1000.0).round() / 1000.0) as f32, ((z * 1000.0).round() / 1000.0) as f32])
                    })
                    .collect()
            })
            .unwrap_or_default();
        if points.len() < 3 {
            continue;
        }
        out.push(Block {
            id: b.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
            name: b.get("name").and_then(Value::as_str).unwrap_or("").chars().take(60).collect(),
            enabled: b.get("enabled").and_then(Value::as_bool) != Some(false),
            points,
        });
    }
    out
}

/// The setup as JSON in the browser's shape (telemetry).
fn setup_json(s: &Setup) -> Value {
    json!({
        "led": { "w": s.led_w, "h": s.led_h },
        "size": { "w": s.size_w, "h": s.size_h },
        "bottom": s.bottom,
        "cabinet": { "w": s.cabinet_w, "h": s.cabinet_h },
        "output": { "x": s.output_x, "y": s.output_y, "fit": s.output_fit, "window": s.output_window.as_ref().map(|w| json!({ "left": w.left, "top": w.top, "width": w.width, "height": w.height, "label": w.label })) },
        "sensor": { "x": s.sensor_x, "front": s.sensor_front, "floor": if s.floor_auto { "auto" } else { "manual" }, "height": s.sensor_height, "tilt": s.sensor_tilt },
        "color": { "brightness": s.brightness, "gamma": s.gamma, "r": s.gain[0], "g": s.gain[1], "b": s.gain[2] },
        "blocks": s.blocks.iter().map(|b| json!({ "id": b.id, "name": b.name, "enabled": b.enabled, "points": b.points })).collect::<Vec<_>>(),
    })
}

/// Is [x, z] inside the polygon?
pub fn in_polygon(x: f32, z: f32, poly: &[[f32; 2]]) -> bool {
    let mut inside = false;
    let mut jj = poly.len() - 1;
    for i in 0..poly.len() {
        let [xi, zi] = poly[i];
        let [xj, zj] = poly[jj];
        if (zi > z) != (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi {
            inside = !inside;
        }
        jj = i;
    }
    inside
}

// ---------- curves ----------

/// Valid inner points of a curve: x strictly inside 0..1 and increasing, y 0..1 and not decreasing.
pub fn normalize_curve(raw: Option<&Value>) -> Vec<[f32; 2]> {
    let mut pts: Vec<[f64; 2]> = raw
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    let p = p.as_array()?;
                    Some([clampf(num(p.first())?, 0.02, 0.98), clampf(num(p.get(1))?, 0.0, 1.0)])
                })
                .collect()
        })
        .unwrap_or_default();
    pts.sort_by(|a, b| a[0].total_cmp(&b[0]));
    let mut out: Vec<[f64; 2]> = Vec::new();
    for p in pts {
        if let Some(l) = out.last()
            && p[0] - l[0] < 0.03
        {
            continue;
        }
        if out.len() >= MAX_CURVE_POINTS {
            break;
        }
        let prev = out.last().map(|l| l[1]).unwrap_or(0.0);
        out.push([(p[0] * 1000.0).round() / 1000.0, (p[1].max(prev) * 1000.0).round() / 1000.0]);
    }
    out.into_iter().map(|p| [p[0] as f32, p[1] as f32]).collect()
}

/// The curve through (0, 0), the inner points and (1, 1) as a table of LUT_N samples (monotone cubic).
pub fn curve_lut(inner: &[[f32; 2]]) -> [f32; LUT_N] {
    let mut p: Vec<[f64; 2]> = vec![[0.0, 0.0]];
    p.extend(inner.iter().map(|q| [f64::from(q[0]), f64::from(q[1])]));
    p.push([1.0, 1.0]);
    let n = p.len();
    let d: Vec<f64> = (0..n - 1).map(|i| (p[i + 1][1] - p[i][1]) / (p[i + 1][0] - p[i][0])).collect();
    let mut m: Vec<f64> = (0..n)
        .map(|i| {
            if i == 0 {
                d[0]
            } else if i == n - 1 {
                d[n - 2]
            } else if d[i - 1] * d[i] <= 0.0 {
                0.0
            } else {
                (d[i - 1] + d[i]) / 2.0
            }
        })
        .collect();
    for i in 0..n - 1 {
        if d[i] == 0.0 {
            m[i] = 0.0;
            m[i + 1] = 0.0;
            continue;
        }
        let a = m[i] / d[i];
        let b = m[i + 1] / d[i];
        let s = a * a + b * b;
        if s > 9.0 {
            let t = 3.0 / s.sqrt();
            m[i] = t * a * d[i];
            m[i + 1] = t * b * d[i];
        }
    }
    let mut out = [0.0_f32; LUT_N];
    let mut seg = 0usize;
    for (k, o) in out.iter_mut().enumerate() {
        let x = k as f64 / LUT_SEG as f64;
        while seg < n - 2 && x > p[seg + 1][0] {
            seg += 1;
        }
        let h = p[seg + 1][0] - p[seg][0];
        let t = (x - p[seg][0]) / h;
        let t2 = t * t;
        let t3 = t2 * t;
        *o = ((2.0 * t3 - 3.0 * t2 + 1.0) * p[seg][1] + (t3 - 2.0 * t2 + t) * h * m[seg] + (-2.0 * t3 + 3.0 * t2) * p[seg + 1][1] + (t3 - t2) * h * m[seg + 1]) as f32;
    }
    out[0] = 0.0;
    out[LUT_SEG] = 1.0;
    for k in 1..LUT_N {
        out[k] = out[k].max(out[k - 1]);
    }
    out
}

/// The inverse of a monotone table.
pub fn invert_lut(lut: &[f32; LUT_N]) -> [f32; LUT_N] {
    let mut out = [0.0_f32; LUT_N];
    let mut jj = 0usize;
    for (k, o) in out.iter_mut().enumerate() {
        let y = k as f32 / LUT_SEG as f32;
        while jj < LUT_SEG - 1 && lut[jj + 1] < y {
            jj += 1;
        }
        let a = lut[jj];
        let b = lut[jj + 1];
        *o = (jj as f32 + if b > a { ((y - a) / (b - a)).clamp(0.0, 1.0) } else { 0.0 }) / LUT_SEG as f32;
    }
    out[0] = 0.0;
    out[LUT_SEG] = 1.0;
    out
}

/// A table at t (beyond 0..1 it goes on along the end segments). Same as wallCurve() in WGSL.
pub fn eval_lut(lut: &[f32; LUT_N], t: f32) -> f32 {
    let seg = LUT_SEG as f32;
    if t <= 0.0 {
        return lut[0] + t * (lut[1] - lut[0]) * seg;
    }
    if t >= 1.0 {
        return lut[LUT_SEG] + (t - 1.0) * (lut[LUT_SEG] - lut[LUT_SEG - 1]) * seg;
    }
    let f = t * seg;
    let i = (f.floor() as usize).min(LUT_SEG);
    lut[i] + (lut[(i + 1).min(LUT_SEG)] - lut[i]) * (f - i as f32)
}

// ---------- projections ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Clamp,
    Soft,
    Free,
}

/// How people are mapped onto the wall (normalizeProfile()).
#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    pub mirror: bool,
    pub f_near: f32,
    pub f_far: f32,
    pub near_l: f32,
    pub near_r: f32,
    pub far_l: f32,
    pub far_r: f32,
    pub low: f32,
    pub high: f32,
    pub out_left: f32,
    pub out_right: f32,
    pub out_bottom: f32,
    pub out_top: f32,
    pub curve_x: Vec<[f32; 2]>,
    pub curve_y: Vec<[f32; 2]>,
    pub curve_z: Vec<[f32; 2]>,
    /// apply 'person' (else 'points')
    pub per_person: bool,
    pub edge: Edge,
    pub margin: f32,
    pub smoothing: f32,
    pub predict: f32,
    pub body_scale: f32,
    /// body.fit 'height'
    pub body_fit_height: bool,
    pub body_height: f32,
    pub zone_near: f32,
    pub zone_far: f32,
    /// image.mode 'stretch'
    pub image_stretch: bool,
    pub image_distance: f32,
}

enum Kind {
    Num(f64, f64),
    Bool,
    Sel(&'static [&'static str]),
    Curve,
}

/// Every projection value (PROJECTION_FIELDS).
const FIELDS: &[(&str, Kind)] = &[
    ("field.near", Kind::Num(0.0, 15.0)),
    ("field.far", Kind::Num(0.2, 20.0)),
    ("field.nearL", Kind::Num(-30.0, 60.0)),
    ("field.nearR", Kind::Num(-30.0, 60.0)),
    ("field.farL", Kind::Num(-30.0, 60.0)),
    ("field.farR", Kind::Num(-30.0, 60.0)),
    ("zone.near", Kind::Num(0.0, 15.0)),
    ("zone.far", Kind::Num(0.2, 20.0)),
    ("out.left", Kind::Num(-10.0, 30.0)),
    ("out.right", Kind::Num(-10.0, 30.0)),
    ("mirror", Kind::Bool),
    ("edge", Kind::Sel(&["clamp", "soft", "free"])),
    ("margin", Kind::Num(0.0, 2.0)),
    ("field.low", Kind::Num(-1.0, 4.0)),
    ("field.high", Kind::Num(0.2, 5.0)),
    ("out.bottom", Kind::Num(-5.0, 10.0)),
    ("out.top", Kind::Num(-4.0, 12.0)),
    ("apply", Kind::Sel(&["person", "points"])),
    ("body.scale", Kind::Num(0.25, 3.0)),
    ("body.fit", Kind::Sel(&["real", "height"])),
    ("body.height", Kind::Num(0.8, 2.6)),
    ("smoothing", Kind::Num(0.0, 1.0)),
    ("predict", Kind::Num(0.0, 0.3)),
    ("image.mode", Kind::Sel(&["true", "stretch"])),
    ("image.distance", Kind::Num(0.3, 15.0)),
    ("curve.x", Kind::Curve),
    ("curve.y", Kind::Curve),
    ("curve.z", Kind::Curve),
];

impl Default for Profile {
    fn default() -> Self {
        Profile {
            mirror: true,
            f_near: 0.8,
            f_far: 4.3,
            near_l: 1.6,
            near_r: 4.4,
            far_l: 1.6,
            far_r: 4.4,
            low: 0.0,
            high: 2.0,
            out_left: 0.0,
            out_right: 0.0,
            out_bottom: 0.0,
            out_top: 2.0,
            curve_x: Vec::new(),
            curve_y: Vec::new(),
            curve_z: Vec::new(),
            per_person: true,
            edge: Edge::Clamp,
            margin: 0.3,
            smoothing: 0.0,
            predict: 0.0,
            body_scale: 1.0,
            body_fit_height: false,
            body_height: 1.7,
            zone_near: 0.7,
            zone_far: 4.7,
            image_stretch: false,
            image_distance: 3.3,
        }
    }
}

/// A validated override value for `key` (None if the key or the value is not accepted).
fn accept(key: &str, v: &Value) -> Option<Value> {
    let (_, kind) = FIELDS.iter().find(|(k, _)| *k == key)?;
    match kind {
        Kind::Num(lo, hi) => num(Some(v)).map(|x| json!(clampf(x, *lo, *hi))),
        Kind::Bool => v.as_bool().map(Value::Bool),
        Kind::Sel(opts) => v.as_str().filter(|s| opts.contains(s)).map(|s| json!(s)),
        Kind::Curve => v.as_array().map(|_| json!(normalize_curve(Some(v)))),
    }
}

impl Profile {
    /// Sets one value by its key (as setPath on the profile).
    pub fn set(&mut self, key: &str, v: &Value) {
        let Some(v) = accept(key, v) else {
            return;
        };
        let f = v.as_f64().unwrap_or(0.0) as f32;
        let s = v.as_str().unwrap_or("");
        match key {
            "field.near" => self.f_near = f,
            "field.far" => self.f_far = f,
            "field.nearL" => self.near_l = f,
            "field.nearR" => self.near_r = f,
            "field.farL" => self.far_l = f,
            "field.farR" => self.far_r = f,
            "zone.near" => self.zone_near = f,
            "zone.far" => self.zone_far = f,
            "out.left" => self.out_left = f,
            "out.right" => self.out_right = f,
            "mirror" => self.mirror = v.as_bool().unwrap_or(true),
            "edge" => self.edge = if s == "soft" { Edge::Soft } else if s == "free" { Edge::Free } else { Edge::Clamp },
            "margin" => self.margin = f,
            "field.low" => self.low = f,
            "field.high" => self.high = f,
            "out.bottom" => self.out_bottom = f,
            "out.top" => self.out_top = f,
            "apply" => self.per_person = s != "points",
            "body.scale" => self.body_scale = f,
            "body.fit" => self.body_fit_height = s == "height",
            "body.height" => self.body_height = f,
            "smoothing" => self.smoothing = f,
            "predict" => self.predict = f,
            "image.mode" => self.image_stretch = s == "stretch",
            "image.distance" => self.image_distance = f,
            "curve.x" => self.curve_x = normalize_curve(Some(&v)),
            "curve.y" => self.curve_y = normalize_curve(Some(&v)),
            "curve.z" => self.curve_z = normalize_curve(Some(&v)),
            _ => {}
        }
    }

    /// From anything: every known key of a nested object (normalizeProfile()).
    pub fn from_json(raw: &Value) -> Self {
        let mut p = Profile::default();
        for (key, _) in FIELDS {
            if let Some(v) = get_path(raw, key) {
                p.set(key, v);
            }
        }
        p.fix();
        p
    }

    /// The constraints of normalizeProfile().
    pub fn fix(&mut self) {
        self.f_far = self.f_far.max(self.f_near + 0.2);
        self.near_r = self.near_r.max(self.near_l + 0.1);
        self.far_r = self.far_r.max(self.far_l + 0.1);
        self.high = self.high.max(self.low + 0.1);
        if (self.out_top - self.out_bottom).abs() < 0.1 {
            self.out_top = self.out_bottom + 0.1;
        }
        self.zone_far = self.zone_far.max(self.zone_near + 0.2);
    }

    /// The browser's nested shape (telemetry, control center).
    pub fn to_json(&self) -> Value {
        json!({
            "mirror": self.mirror,
            "field": { "near": self.f_near, "far": self.f_far, "nearL": self.near_l, "nearR": self.near_r, "farL": self.far_l, "farR": self.far_r, "low": self.low, "high": self.high },
            "out": { "left": self.out_left, "right": self.out_right, "bottom": self.out_bottom, "top": self.out_top },
            "curve": { "x": self.curve_x, "y": self.curve_y, "z": self.curve_z },
            "apply": if self.per_person { "person" } else { "points" },
            "edge": match self.edge { Edge::Clamp => "clamp", Edge::Soft => "soft", Edge::Free => "free" },
            "margin": self.margin,
            "smoothing": self.smoothing,
            "predict": self.predict,
            "body": { "scale": self.body_scale, "fit": if self.body_fit_height { "height" } else { "real" }, "height": self.body_height },
            "zone": { "near": self.zone_near, "far": self.zone_far },
            "image": { "mode": if self.image_stretch { "stretch" } else { "true" }, "distance": self.image_distance },
        })
    }
}

/// Valid per-scene overrides: { key: value } (flat or nested input).
pub fn normalize_overrides(raw: &Value) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    if !raw.is_object() {
        return out;
    }
    for (key, _) in FIELDS {
        let v = raw.get(*key).or_else(|| get_path(raw, key));
        if let Some(v) = v.and_then(|v| accept(key, v)) {
            out.push((key.to_string(), v));
        }
    }
    out
}

/// The view cone at `z` m in front of the wall: plan x of its left and right edge, `inset` m inside.
pub fn cone_at(s: &Setup, tan_h: f32, z: f32, inset: f32) -> [f32; 2] {
    let c = s.size_w / 2.0 + s.sensor_x;
    let half = ((z - s.sensor_front) * tan_h - inset).max(0.05);
    [c - half, c + half]
}

fn cm(v: f32) -> f32 {
    (v * 100.0).round() / 100.0
}

/// The projection that maps like the old setup.map / zone / mirror (to seed the default).
pub fn projection_from_setup(s: &Setup, tan_h: f32) -> Profile {
    let front = s.sensor_front;
    let c = s.size_w / 2.0 + s.sensor_x;
    let near = front + s.zone_near;
    let far = front + s.zone_far;
    let edges = |z: f32| -> [f32; 2] {
        match s.map_mode.as_str() {
            "real" => [0.0, s.size_w],
            "factor" => [c - (s.size_w / 2.0 + s.sensor_x) / s.map_factor, c + (s.size_w / 2.0 - s.sensor_x) / s.map_factor],
            _ => {
                let h = s.map_distance * tan_h * (z.max(MIN_Z) / s.map_distance).powf(s.map_depth);
                [c - h, c + h]
            }
        }
    };
    let [nl, nr] = edges(s.zone_near);
    let [fl, fr] = edges(s.zone_far);
    let mut p = Profile {
        mirror: s.mirror,
        f_near: cm(near),
        f_far: cm(far),
        near_l: cm(nl),
        near_r: cm(nr),
        far_l: cm(fl),
        far_r: cm(fr),
        low: 0.0,
        high: 2.0,
        out_left: 0.0,
        out_right: 0.0,
        out_bottom: s.map_lift,
        out_top: s.map_lift + 2.0 * s.map_scale_y,
        per_person: s.map_apply != "points",
        edge: if s.map_clamp { Edge::Clamp } else { Edge::Free },
        margin: s.map_margin,
        zone_near: cm(near),
        zone_far: cm(far),
        image_stretch: s.map_image == "stretch",
        image_distance: cm(front + s.map_distance),
        ..Profile::default()
    };
    // through the same validation as everything else
    p = Profile::from_json(&p.to_json());
    p
}

/// projection.json: the default for all scenes and the overrides per scene.
#[derive(Clone, Debug, Default)]
pub struct ProjectionDoc {
    /// None: derived from the setup
    pub default: Option<Profile>,
    pub scenes: HashMap<String, Vec<(String, Value)>>,
}

pub fn normalize_projection_doc(raw: &Value) -> ProjectionDoc {
    let mut scenes = HashMap::new();
    if let Some(o) = raw.get("scenes").and_then(Value::as_object) {
        for (name, v) in o {
            if !valid_name(name) {
                continue;
            }
            let ov = normalize_overrides(v);
            if !ov.is_empty() {
                scenes.insert(name.clone(), ov);
            }
        }
    }
    ProjectionDoc { default: raw.get("default").filter(|d| d.is_object()).map(Profile::from_json), scenes }
}

pub fn valid_name(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty() && b.len() <= 64 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// A scene's wish for its play field relative to the sensor (fieldFromWish()).
fn field_from_wish(wish: &Value, p: &mut Profile, s: &Setup, tan_h: f32) {
    let w = match wish {
        Value::String(k) => {
            let mut m = serde_json::Map::new();
            m.insert(k.clone(), if k == "cone" { json!(0) } else { json!(true) });
            Value::Object(m)
        }
        v => v.clone(),
    };
    let c = s.size_w / 2.0 + s.sensor_x;
    let depth = w.get("depth").and_then(Value::as_array).filter(|a| a.len() == 2 && a.iter().all(|x| num(Some(x)).is_some()));
    let (base_near, base_far) = (p.f_near, p.f_far);
    let (near, far) = match depth {
        Some(d) => {
            let (d0, d1) = (num(d.first()).unwrap_or(0.0) as f32, num(d.get(1)).unwrap_or(0.0) as f32);
            (cm(s.sensor_front + 0.3_f32.max(d0.min(d1 - 0.2))), cm(s.sensor_front + d1.max(d0 + 0.2)))
        }
        None => (base_near, base_far),
    };
    if w.get("real").and_then(Value::as_bool) == Some(true) {
        (p.f_near, p.f_far, p.near_l, p.near_r, p.far_l, p.far_r) = (near, far, 0.0, s.size_w, 0.0, s.size_w);
        return;
    }
    if let Some(inset) = num(w.get("cone")) {
        let [nl, nr] = cone_at(s, tan_h, near, inset as f32);
        let [fl, fr] = cone_at(s, tan_h, far, inset as f32);
        (p.f_near, p.f_far, p.near_l, p.near_r, p.far_l, p.far_r) = (near, far, cm(nl), cm(nr), cm(fl), cm(fr));
        return;
    }
    let width = match w.get("width") {
        Some(v) if num(Some(v)).is_some() => num(Some(v)).map(|x| [x as f32, x as f32]),
        Some(Value::Array(a)) if a.len() >= 2 && a.iter().all(|x| num(Some(x)).is_some()) => Some([num(a.first()).unwrap_or(0.0) as f32, num(a.get(1)).unwrap_or(0.0) as f32]),
        _ => None,
    };
    if let Some(wd) = width {
        (p.f_near, p.f_far, p.near_l, p.near_r, p.far_l, p.far_r) = (near, far, cm(c - wd[0] / 2.0), cm(c + wd[0] / 2.0), cm(c - wd[1] / 2.0), cm(c + wd[1] / 2.0));
        return;
    }
    // depth only: the base's edges, carried along to the new depths
    let at = |z: f32, a: f32, b: f32| a + (b - a) * (z - base_near) / (base_far - base_near).max(0.01);
    let (bnl, bnr, bfl, bfr) = (p.near_l, p.near_r, p.far_l, p.far_r);
    (p.f_near, p.f_far, p.near_l, p.near_r, p.far_l, p.far_r) = (near, far, cm(at(near, bnl, bfl)), cm(at(near, bnr, bfr)), cm(at(far, bnl, bfl)), cm(at(far, bnr, bfr)));
}

/// The projection of scene `name`: the default, the scene's wishes, the control center's values.
pub fn resolve_projection(doc: &ProjectionDoc, setup: &Setup, tan_h: f32, name: &str, wishes: &Value) -> Profile {
    let mut p = doc.default.clone().unwrap_or_else(|| projection_from_setup(setup, tan_h));
    for (k, v) in normalize_overrides(wishes) {
        p.set(&k, &v);
    }
    if let Some(wish) = wishes.get("field")
        && (wish.is_string() || ["depth", "width", "cone", "real"].iter().any(|k| wish.get(k).is_some()))
    {
        field_from_wish(wish, &mut p, setup, tan_h);
    }
    if let Some(ov) = doc.scenes.get(name) {
        for (k, v) in ov {
            p.set(k, v);
        }
    }
    p.fix();
    p
}

// ---------- room ----------

/// World -> room without a found floor: the sensor `height` m above the floor, tilted down by `tilt_deg`.
pub fn manual_room(height: f32, tilt_deg: f32) -> [f32; 16] {
    let t = tilt_deg.to_radians();
    let up = [0.0, t.cos(), -t.sin()];
    let fwd = [0.0, t.sin(), t.cos()];
    let mut m = [0.0_f32; 16];
    for jj in 0..3 {
        m[jj * 4] = if jj == 0 { 1.0 } else { 0.0 };
        m[jj * 4 + 1] = up[jj];
        m[jj * 4 + 2] = fwd[jj];
    }
    m[13] = height;
    m[15] = 1.0;
    m
}

fn rigid_inverse(m: &[f32; 16]) -> [f32; 16] {
    let mut out = [0.0_f32; 16];
    for r in 0..3 {
        for c in 0..3 {
            out[c * 4 + r] = m[r * 4 + c];
        }
        out[r * 4 + 3] = 0.0;
    }
    for r in 0..3 {
        out[12 + r] = -(m[r * 4] * m[12] + m[r * 4 + 1] * m[13] + m[r * 4 + 2] * m[14]);
    }
    out[15] = 1.0;
    out
}

pub fn apply_m(m: &[f32; 16], p: Vec3, w: f32) -> Vec3 {
    Vec3::new(
        m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12] * w,
        m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13] * w,
        m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14] * w,
    )
}

/// Off-axis projection through the wall rectangle from an eye (3D mirror scenes): column-major
/// projection (depth 0..1, looking along -z) and view (a translation).
#[allow(dead_code)]
pub fn off_axis_projection(eye: [f32; 3], wall_w: f32, wall_h: f32, bottom: f32, near: f32, far: f32) -> ([f32; 16], [f32; 16]) {
    let d = eye[2].max(1e-3);
    let l = (-wall_w / 2.0 - eye[0]) / d * near;
    let r = (wall_w / 2.0 - eye[0]) / d * near;
    let b = (bottom - eye[1]) / d * near;
    let t = (bottom + wall_h - eye[1]) / d * near;
    let mut p = [0.0_f32; 16];
    p[0] = 2.0 * near / (r - l);
    p[5] = 2.0 * near / (t - b);
    p[8] = (r + l) / (r - l);
    p[9] = (t + b) / (t - b);
    p[10] = far / (near - far);
    p[11] = -1.0;
    p[14] = near * far / (near - far);
    let mut v = [0.0_f32; 16];
    v[0] = 1.0;
    v[5] = 1.0;
    v[10] = 1.0;
    v[15] = 1.0;
    v[12] = -eye[0];
    v[13] = -eye[1];
    v[14] = -eye[2];
    (p, v)
}

// ---------- WGSL ----------

/// WGSL: struct Wall, the binding and the mapping functions (same math as WallMap).
pub fn wall_wgsl(group: u32, binding: u32) -> String {
    WALL_WGSL.replace("@@GROUP@@", &group.to_string()).replace("@@BINDING@@", &binding.to_string())
}

const WALL_WGSL: &str = r"
struct Wall {
  room: mat4x4f,     // world -> room
  roomInv: mat4x4f,  // room -> world
  led: vec2f,        // LED pixels
  size: vec2f,       // m
  bottom: f32, sensorX: f32, front: f32, xSign: f32,
  mirrorSign: f32, perPerson: f32, tanH: f32, ledImage: f32,
  near: f32, far: f32, side: f32, planX0: f32, // zone in room z (m from the sensor); side = wall x per room x
  fNear: f32, fFar: f32, nearL: f32, nearR: f32, // play field (plan m)
  farL: f32, farR: f32, low: f32, high: f32,
  outL: f32, outR: f32, outBottom: f32, outTop: f32,
  inv: vec4f,        // camera ray -> depth image pixel: u = x + y * rx, v = z + w * ry
  imageDist: f32, imageStretch: f32, margin: f32, pad0: f32,
  curves: array<vec4f, 45>, // 5 tables of 33 samples (x, y, z, inverse x, inverse y), 9 vec4 each
  slots: array<vec4f, 17>, // per person slot: x = wall x offset, y = body scale, z = 1 if visible, w = offset per second
};
@group(@@GROUP@@) @binding(@@BINDING@@) var<uniform> WALL: Wall;

fn wallLut(c: u32, i: u32) -> f32 { return WALL.curves[c * 9u + i / 4u][i % 4u]; }
// curve c (0 x, 1 y, 2 z, 3 inverse x, 4 inverse y) at t; beyond 0..1 it goes on along the end segments
fn wallCurve(c: u32, t: f32) -> f32 {
  if (t <= 0.0) { let a = wallLut(c, 0u); return a + t * (wallLut(c, 1u) - a) * 32.0; }
  if (t >= 1.0) { let b = wallLut(c, 32u); return b + (t - 1.0) * (b - wallLut(c, 31u)) * 32.0; }
  let f = t * 32.0;
  let i = min(u32(f), 31u);
  return mix(wallLut(c, i), wallLut(c, i + 1u), f - f32(i));
}
// across the play field at a floor point (plan m): 0 at its left edge, 1 at its right edge (mirror: flipped)
fn wallFieldU(px: f32, pz: f32) -> f32 {
  let v = clamp((pz - WALL.fNear) / max(WALL.fFar - WALL.fNear, 0.01), -1.0, 2.0);
  let l = mix(WALL.nearL, WALL.farL, v);
  let r = mix(WALL.nearR, WALL.farR, v);
  let u = (px - l) / max(r - l, 0.05);
  return select(1.0 - u, u, WALL.mirrorSign > 0.0);
}
// floor point (plan m) -> wall x (m), without a person's place
fn wallMapX(px: f32, pz: f32) -> f32 { return WALL.outL + wallCurve(0u, wallFieldU(px, pz)) * (WALL.outR - WALL.outL); }
// height above the floor (m) -> height on the wall (m)
fn wallMapY(y: f32) -> f32 { return WALL.outBottom + wallCurve(1u, (y - WALL.low) / max(WALL.high - WALL.low, 0.01)) * (WALL.outTop - WALL.outBottom); }
// height on the wall (m) -> height above the floor (m): the inverse of wallMapY
fn wallRoomY(y: f32) -> f32 { return WALL.low + wallCurve(4u, (y - WALL.outBottom) / (WALL.outTop - WALL.outBottom)) * (WALL.high - WALL.low); }
// depth in the play field: 0 at its front edge .. 1 at its back edge (after the curve)
fn wallFieldZ(pz: f32) -> f32 { return wallCurve(2u, (pz - WALL.fNear) / max(WALL.fFar - WALL.fNear, 0.01)); }
// world (m, as ctx.persons) -> room (floor y = 0)
fn wallRoom(world: vec3f) -> vec3f { return (WALL.room * vec4f(world, 1.0)).xyz; }
// room -> floor plan (m): x from the wall's left edge (real place), z in front of the wall
fn wallPlan(r: vec3f) -> vec2f { return vec2f(WALL.planX0 + WALL.xSign * r.x, WALL.front + r.z); }
// stretch factor (wall m per floor m) beside the sensor at `lat` m, `z` m from it
fn wallK(lat: f32, z: f32) -> f32 {
  let px = WALL.planX0 + lat;
  let pz = WALL.front + max(z, 0.3);
  return abs(wallMapX(px + 0.02, pz) - wallMapX(px - 0.02, pz)) / 0.04;
}
// room point of person `slot` (0 = nobody) -> wall: x from the left edge, y above the floor, z in front of the wall (m)
fn wallFromRoom(r: vec3f, slot: u32) -> vec3f {
  let p = wallPlan(r);
  let s = WALL.slots[min(slot, 16u)];
  let person = WALL.perPerson > 0.5 && slot > 0u && s.z > 0.5;
  let x = select(wallMapX(p.x, p.y), s.x + WALL.mirrorSign * p.x * s.y, person);
  return vec3f(x, wallMapY(r.y * select(1.0, s.y, person)), p.y);
}
fn wallFromWorld(world: vec3f, slot: u32) -> vec3f { return wallFromRoom(wallRoom(world), slot); }
// 0..1 in the projection: across the wall's target range, up its height range, front to back of the field
fn wallNorm(r: vec3f, slot: u32) -> vec3f {
  let w = wallFromRoom(r, slot);
  return vec3f((w.x - WALL.outL) / (WALL.outR - WALL.outL), (w.y - WALL.outBottom) / (WALL.outTop - WALL.outBottom), wallFieldZ(w.z));
}
// velocity (room m/s) of the room point r of person `slot` -> on the wall (m/s: x right, y up, z towards
// the audience). The stretched walk moves along: a person walking 1 m/s moves k m/s on the wall.
fn wallVelocity(r: vec3f, v: vec3f, slot: u32) -> vec3f {
  let p = wallPlan(r);
  let s = WALL.slots[min(slot, 16u)];
  let person = WALL.perPerson > 0.5 && slot > 0u && s.z > 0.5;
  let k = select(1.0, s.y, person);
  let gx = (wallMapX(p.x + 0.02, p.y) - wallMapX(p.x - 0.02, p.y)) / 0.04;
  let gz = (wallMapX(p.x, p.y + 0.02) - wallMapX(p.x, p.y - 0.02)) / 0.04;
  let vx = select(gx * WALL.xSign * v.x + gz * v.z, WALL.mirrorSign * WALL.xSign * v.x * s.y + s.w, person);
  let gy = (wallMapY(r.y * k + 0.01) - wallMapY(r.y * k - 0.01)) / 0.02;
  return vec3f(vx, gy * k * v.y, v.z);
}
// the same for a world point and a world velocity (ctx.persons, pointAt())
fn wallVelocityWorld(world: vec3f, v: vec3f, slot: u32) -> vec3f { return wallVelocity(wallRoom(world), (WALL.room * vec4f(v, 0.0)).xyz, slot); }
// Kinect camera point in meters: (ray.x * z, ray.y * z, z) with the ray from lutTex
fn wallFromCamera(c: vec3f, slot: u32) -> vec3f { return wallFromWorld(vec3f(WALL.xSign * c.x, -c.y, c.z), slot); }
// wall (m) -> LED uv (0..1, y down) and LED pixels
fn wallUv(p: vec3f) -> vec2f { return vec2f(p.x / WALL.size.x, (WALL.bottom + WALL.size.y - p.y) / WALL.size.y); }
fn wallPx(p: vec3f) -> vec2f { return wallUv(p) * WALL.led; }
fn wallOnWall(uv: vec2f) -> bool { return all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0)); }
// LED uv -> wall (m): x from the left edge, y above the floor
fn wallAt(uv: vec2f) -> vec2f { return vec2f(uv.x * WALL.size.x, WALL.bottom + (1.0 - uv.y) * WALL.size.y); }
// in the zone (room z = m from the sensor)? and 1 at its near end .. 0 at its far end
fn wallInZone(r: vec3f) -> bool { return r.z >= WALL.near && r.z <= WALL.far; }
fn wallNear(r: vec3f) -> f32 { return saturate((WALL.far - r.z) / max(WALL.far - WALL.near, 0.01)); }
// wall (m) -> mirror world behind the wall for 3D scenes: x from the wall center, y up, z = -distance
fn wallMirror(p: vec3f) -> vec3f { return vec3f(p.x - WALL.size.x * 0.5, p.y, -p.z); }
// LED uv -> depth image uv (as kinectUv()): the camera image as it falls on the wall for things at
// image.distance: in true proportions, or stretched like the people (image.mode).
fn wallToKinect(uv: vec2f) -> vec2f {
  let w = wallAt(uv);
  let pz = WALL.imageDist;
  var px = WALL.planX0 + WALL.mirrorSign * (w.x - WALL.planX0);
  if (WALL.imageStretch > 0.5) {
    var u = wallCurve(3u, (w.x - WALL.outL) / (WALL.outR - WALL.outL));
    u = select(1.0 - u, u, WALL.mirrorSign > 0.0);
    let v = (pz - WALL.fNear) / max(WALL.fFar - WALL.fNear, 0.01);
    let l = mix(WALL.nearL, WALL.farL, v);
    px = l + u * (mix(WALL.nearR, WALL.farR, v) - l);
  }
  let room = vec3f((px - WALL.planX0) * WALL.xSign, wallRoomY(w.y), pz - WALL.front);
  let world = (WALL.roomInv * vec4f(room, 1.0)).xyz;
  let c = vec3f(WALL.xSign * world.x, -world.y, max(world.z, 0.01));
  let p = vec2f(WALL.inv.x + WALL.inv.y * c.x / c.z, WALL.inv.z + WALL.inv.w * c.y / c.z);
  return (p + 0.5) / vec2f(512.0, 424.0);
}
";

/// floats of the uniform (struct Wall)
const U_ROOM: usize = 0;
const U_ROOM_INV: usize = 16;
const U_LED: usize = 32;
const U_BOTTOM: usize = 36;
const U_MIRROR: usize = 40;
const U_ZONE: usize = 44;
const U_FIELD: usize = 48;
const U_FIELD2: usize = 52;
const U_OUT: usize = 56;
const U_INV: usize = 60;
const U_IMAGE: usize = 64;
const U_CURVES: usize = 68;
const U_SLOTS: usize = 68 + 5 * 36;
pub const WALL_UNIFORM_FLOATS: usize = U_SLOTS + SLOTS * 4;

// ---------- the mapping (CPU) ----------

fn alpha(cutoff: f32, dt: f32) -> f32 {
    1.0 / (1.0 + 1.0 / (2.0 * std::f32::consts::PI * cutoff * dt))
}

#[derive(Clone, Copy, Default)]
struct Euro {
    x: Option<Vec3>,
    dx: Vec3,
}

impl Euro {
    fn step(&mut self, x: Vec3, dt: f32, min_cutoff: f32, beta: f32) -> Vec3 {
        let Some(prev) = self.x.filter(|_| dt > 0.0) else {
            self.x = Some(x);
            self.dx = Vec3::ZERO;
            return x;
        };
        let ad = alpha(1.0, dt);
        self.dx += ad * ((x - prev) / dt - self.dx);
        let a = alpha(min_cutoff + beta * self.dx.x.hypot(self.dx.z), dt);
        let nx = prev + a * (x - prev);
        self.x = Some(nx);
        nx
    }
}

const HEIGHT_WINDOW_MS: f64 = 6000.0;
const PERSON_KEEP_MS: f64 = 3000.0;

#[derive(Clone)]
struct Track {
    euro: Euro,
    smooth: Option<Vec3>,
    heights: std::collections::VecDeque<(f64, f32)>,
    est: Option<f32>,
    at: f64,
}

/// Where a person is on the wall (ctx.wall.persons, place()).
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct Placed {
    pub id: u32,
    pub slot: u8,
    pub color: [f32; 3],
    pub css: &'static str,
    /// m from the left edge (mapped)
    pub x: f32,
    /// m above the floor (body center)
    pub y: f32,
    /// m in front of the wall
    pub z: f32,
    /// 0..1: across the target range, up the height range, front to back of the field
    pub norm: Vec3,
    /// where the person really stands on the floor plan
    pub plan: [f32; 2],
    /// m from the sensor along the floor
    pub dist: f32,
    /// m beside the sensor as the audience sees it
    pub lateral: f32,
    /// m from the left edge where the person really stands
    pub real: f32,
    /// body size on the wall
    pub scale: f32,
    /// wall m per floor m across, here
    pub gain: f32,
    pub offset: f32,
    pub rate: f32,
    pub shift: f32,
    pub shift_rate: f32,
    /// m/s across the wall
    pub vx: f32,
    pub vy: f32,
    pub u: f32,
    pub v: f32,
    pub px: f32,
    pub py: f32,
    /// wall y of the feet and of the top of the head
    pub feet: f32,
    pub top: f32,
    pub room: Vec3,
    pub in_zone: bool,
    pub near: f32,
    pub visible: bool,
    pub height: f32,
}

/// ctx.wall: the setup, the scene's projection and the mapping.
#[derive(Clone)]
pub struct WallMap {
    pub setup: Setup,
    pub projection: Profile,
    luts: [[f32; LUT_N]; 5],
    inv_z: [f32; LUT_N],
    pub active: bool,
    pub output: bool,
    pub x_sign: f32,
    pub room: [f32; 16],
    pub room_inv: [f32; 16],
    pub room_found: bool,
    pub room_height: f32,
    pub room_source: &'static str,
    pub tan_h: f32,
    pub inv: [f32; 4],
    pub offset: [f32; SLOTS],
    pub scale: [f32; SLOTS],
    pub rate: [f32; SLOTS],
    pub shift: [f32; SLOTS],
    pub shift_rate: [f32; SLOTS],
    pub visible: [bool; SLOTS],
    pub persons: Vec<Placed>,
    /// persons removed by a block zone in the last result: (id, slot, x, z)
    pub blocked: Vec<(u32, u8, f32, f32)>,
    pub version: u64,
    track: HashMap<u32, Track>,
    t: f64,
    rays_from: Option<Arc<Vec<f32>>>,
    data: Vec<f32>,
}

const LX: usize = 0;
const LY: usize = 1;
const LZ: usize = 2;
const LIX: usize = 3;
const LIY: usize = 4;

// the API of wall.js for the scene ports, used or not
#[allow(dead_code)]
impl WallMap {
    pub fn new(setup: Setup, projection: Option<Profile>) -> Self {
        let room = manual_room(0.85, 0.0);
        let mut w = Self {
            projection: Profile::default(),
            luts: [[0.0; LUT_N]; 5],
            inv_z: [0.0; LUT_N],
            active: false,
            output: false,
            x_sign: -1.0,
            room,
            room_inv: rigid_inverse(&room),
            room_found: false,
            room_height: 0.85,
            room_source: "manual",
            tan_h: TAN_H,
            inv: [255.5, 365.5, 205.5, 365.5],
            offset: [0.0; SLOTS],
            scale: [1.0; SLOTS],
            rate: [0.0; SLOTS],
            shift: [0.0; SLOTS],
            shift_rate: [0.0; SLOTS],
            visible: [false; SLOTS],
            persons: Vec::new(),
            blocked: Vec::new(),
            version: 0,
            track: HashMap::new(),
            t: 0.0,
            rays_from: None,
            data: vec![0.0; WALL_UNIFORM_FLOATS],
            setup,
        };
        let p = projection.unwrap_or_else(|| projection_from_setup(&w.setup, TAN_H));
        w.set_projection(p);
        w
    }

    pub fn set_setup(&mut self, s: Setup) {
        self.setup = s;
        self.version += 1;
    }

    pub fn set_projection(&mut self, p: Profile) {
        self.luts[LX] = curve_lut(&p.curve_x);
        self.luts[LY] = curve_lut(&p.curve_y);
        self.luts[LZ] = curve_lut(&p.curve_z);
        self.luts[LIX] = invert_lut(&self.luts[LX]);
        self.luts[LIY] = invert_lut(&self.luts[LY]);
        self.inv_z = invert_lut(&self.luts[LZ]);
        self.projection = p;
        self.version += 1;
    }

    pub fn led(&self) -> [u32; 2] {
        [self.setup.led_w, self.setup.led_h]
    }

    pub fn size(&self) -> [f32; 2] {
        [self.setup.size_w, self.setup.size_h]
    }

    /// LED pixels per meter
    pub fn px_per_m(&self) -> [f32; 2] {
        [self.setup.led_w as f32 / self.setup.size_w, self.setup.led_h as f32 / self.setup.size_h]
    }

    pub fn mirror_sign(&self) -> f32 {
        if self.projection.mirror { 1.0 } else { -1.0 }
    }

    pub fn side(&self) -> f32 {
        self.mirror_sign() * self.x_sign
    }

    pub fn plan_x0(&self) -> f32 {
        self.setup.size_w / 2.0 + self.setup.sensor_x
    }

    /// The zone in room z (m from the sensor): [near, far].
    pub fn zone(&self) -> [f32; 2] {
        let f = self.setup.sensor_front;
        [self.projection.zone_near - f, self.projection.zone_far - f]
    }

    /// The wall x range the play field maps onto.
    pub fn target(&self) -> [f32; 2] {
        [self.projection.out_left, self.setup.size_w - self.projection.out_right]
    }

    /// The camera's real view from the hub's ray table.
    pub fn set_rays(&mut self, lut: &Arc<Vec<f32>>) {
        if self.rays_from.as_ref().is_some_and(|r| Arc::ptr_eq(r, lut)) || lut.len() < 512 * 424 * 2 {
            return;
        }
        self.rays_from = Some(lut.clone());
        let at = |u: usize, v: usize| (lut[(v * 512 + u) * 2], lut[(v * 512 + u) * 2 + 1]);
        let row = 424 >> 1;
        let col = 512 >> 1;
        let (x0, _) = at(8, row);
        let (x1, _) = at(512 - 9, row);
        let (_, y0) = at(col, 8);
        let (_, y1) = at(col, 424 - 9);
        if ![x0, x1, y0, y1].iter().all(|v| v.is_finite()) || (x1 - x0).abs() < 1e-3 || (y1 - y0).abs() < 1e-3 {
            return;
        }
        let bx = (512.0 - 17.0) / (x1 - x0);
        let by = (424.0 - 17.0) / (y1 - y0);
        self.inv = [8.0 - bx * x0, bx, 8.0 - by * y0, by];
        let e0 = at(0, row).0.abs();
        let e1 = at(511, row).0.abs();
        if (e0 + e1).is_finite() && e0 + e1 > 0.2 {
            self.tan_h = (e0 + e1) / 2.0;
        }
    }

    /// Once per frame before the scene: the room, the people's places on the wall.
    pub fn update(&mut self, view: &PersonsView, x_sign: f32, now: f64) {
        self.x_sign = x_sign;
        if self.setup.floor_auto && view.room.found {
            self.room = view.room.matrix;
            self.room_found = true;
            self.room_height = view.room.height;
            self.room_source = "floor";
        } else {
            self.room = manual_room(self.setup.sensor_height, self.setup.sensor_tilt);
            self.room_found = false;
            self.room_height = self.setup.sensor_height;
            self.room_source = "manual";
        }
        self.room_inv = rigid_inverse(&self.room);
        let dt = if self.t > 0.0 { ((now - self.t) / 1000.0).clamp(0.0, 0.25) as f32 } else { 0.0 };
        self.t = now;
        self.offset = [0.0; SLOTS];
        self.scale = [1.0; SLOTS];
        self.rate = [0.0; SLOTS];
        self.shift = [0.0; SLOTS];
        self.shift_rate = [0.0; SLOTS];
        self.visible = [false; SLOTS];
        let mut list = Vec::with_capacity(view.visible.len());
        for p in &view.visible {
            let Some(info) = self.place_inner(p, dt, now, true) else {
                continue;
            };
            let s = p.slot as usize;
            if (1..SLOTS).contains(&s) {
                self.offset[s] = info.offset;
                self.scale[s] = info.scale;
                self.rate[s] = info.rate;
                self.shift[s] = info.shift;
                self.shift_rate[s] = info.shift_rate;
                self.visible[s] = true;
            }
            list.push(info);
        }
        self.track.retain(|_, st| now - st.at <= PERSON_KEEP_MS);
        self.persons = list;
        self.write_uniform();
    }

    // ----- the projection, step by step -----

    pub fn field_u(&self, px: f32, pz: f32) -> f32 {
        let p = &self.projection;
        let v = ((pz - p.f_near) / (p.f_far - p.f_near).max(0.01)).clamp(-1.0, 2.0);
        let l = p.near_l + (p.far_l - p.near_l) * v;
        let r = p.near_r + (p.far_r - p.near_r) * v;
        let u = (px - l) / (r - l).max(0.05);
        if p.mirror { u } else { 1.0 - u }
    }

    pub fn field_at(&self, pz: f32) -> [f32; 2] {
        let p = &self.projection;
        let v = (pz - p.f_near) / (p.f_far - p.f_near).max(0.01);
        [p.near_l + (p.far_l - p.near_l) * v, p.near_r + (p.far_r - p.near_r) * v]
    }

    pub fn map_x(&self, px: f32, pz: f32) -> f32 {
        let [l, r] = self.target();
        l + eval_lut(&self.luts[LX], self.field_u(px, pz)) * (r - l)
    }

    pub fn map_y(&self, y: f32) -> f32 {
        let p = &self.projection;
        p.out_bottom + eval_lut(&self.luts[LY], (y - p.low) / (p.high - p.low).max(0.01)) * (p.out_top - p.out_bottom)
    }

    pub fn unmap_y(&self, y: f32) -> f32 {
        let p = &self.projection;
        p.low + eval_lut(&self.luts[LIY], (y - p.out_bottom) / (p.out_top - p.out_bottom)) * (p.high - p.low)
    }

    pub fn field_z(&self, pz: f32) -> f32 {
        let p = &self.projection;
        eval_lut(&self.luts[LZ], (pz - p.f_near) / (p.f_far - p.f_near).max(0.01))
    }

    pub fn field_depth(&self, t: f32) -> f32 {
        let p = &self.projection;
        p.f_near + eval_lut(&self.inv_z, t) * (p.f_far - p.f_near)
    }

    pub fn edge(&self, x: f32) -> f32 {
        let p = &self.projection;
        if p.edge == Edge::Free {
            return x;
        }
        let lo = p.margin.min(self.setup.size_w / 2.0);
        let hi = lo.max(self.setup.size_w - p.margin);
        if p.edge == Edge::Clamp {
            return x.clamp(lo, hi);
        }
        let k = 0.6_f32.min((hi - lo) / 4.0);
        if x > hi - k {
            return hi - k + k * ((x - (hi - k)) / k).tanh();
        }
        if x < lo + k {
            return lo + k - k * ((lo + k - x) / k).tanh();
        }
        x
    }

    pub fn gain(&self, px: f32, pz: f32) -> f32 {
        (self.map_x(px + 0.02, pz) - self.map_x(px - 0.02, pz)).abs() / 0.04
    }

    pub fn k(&self, lat: f32, z: f32) -> f32 {
        self.gain(self.plan_x0() + lat, self.setup.sensor_front + z.max(MIN_Z))
    }

    // ----- points -----

    pub fn to_room(&self, world: Vec3) -> Vec3 {
        apply_m(&self.room, world, 1.0)
    }

    fn person_slot(&self, slot: usize) -> bool {
        self.projection.per_person && slot > 0 && slot < SLOTS && self.visible[slot]
    }

    /// Room x, z of person `slot` -> wall x (m), for per-pixel loops over the masks.
    pub fn room_x(&self, rx: f32, rz: f32, slot: usize) -> f32 {
        let px = self.plan_x0() + self.x_sign * rx;
        if self.person_slot(slot) {
            return self.offset[slot] + self.mirror_sign() * px * self.scale[slot];
        }
        self.map_x(px, self.setup.sensor_front + rz)
    }

    /// Room height of person `slot` -> wall y (m).
    pub fn room_y(&self, ry: f32, slot: usize) -> f32 {
        let k = if self.person_slot(slot) { self.scale[slot] } else { 1.0 };
        self.map_y(ry * k)
    }

    pub fn from_room(&self, r: Vec3, slot: usize) -> Vec3 {
        Vec3::new(self.room_x(r.x, r.z, slot), self.room_y(r.y, slot), self.setup.sensor_front + r.z)
    }

    pub fn from_world(&self, world: Vec3, slot: usize) -> Vec3 {
        self.from_room(self.to_room(world), slot)
    }

    /// Kinect camera point (mm or m) -> wall
    pub fn from_camera(&self, c: Vec3, slot: usize, mm: bool) -> Vec3 {
        let f = if mm { 0.001 } else { 1.0 };
        self.from_world(Vec3::new(self.x_sign * c.x * f, -c.y * f, c.z * f), slot)
    }

    pub fn norm(&self, world: Vec3, slot: usize) -> Vec3 {
        let w = self.from_world(world, slot);
        self.norm_of(w.x, w.y, w.z)
    }

    fn norm_of(&self, x: f32, y: f32, z: f32) -> Vec3 {
        let [l, r] = self.target();
        let o = &self.projection;
        Vec3::new((x - l) / (r - l), (y - o.out_bottom) / (o.out_top - o.out_bottom), self.field_z(z))
    }

    /// Velocity on the wall (m/s) of a world point with a world velocity of person `slot`.
    pub fn velocity(&self, world: Vec3, vel: Vec3, slot: usize) -> Vec3 {
        let r = self.to_room(world);
        let v = apply_m(&self.room, vel, 0.0);
        let px = self.plan_x0() + self.x_sign * r.x;
        let pz = self.setup.sensor_front + r.z;
        let person = self.person_slot(slot);
        let k = if person { self.scale[slot] } else { 1.0 };
        let x = if person {
            self.mirror_sign() * self.x_sign * v.x * k + self.rate[slot]
        } else {
            let gx = (self.map_x(px + 0.02, pz) - self.map_x(px - 0.02, pz)) / 0.04;
            let gz = (self.map_x(px, pz + 0.02) - self.map_x(px, pz - 0.02)) / 0.04;
            gx * self.x_sign * v.x + gz * v.z
        };
        let y = (self.map_y(r.y * k + 0.01) - self.map_y(r.y * k - 0.01)) / 0.02 * k * v.y;
        Vec3::new(x, y, v.z)
    }

    pub fn joint_velocity(&self, p: &Person, j: usize) -> Option<Vec3> {
        let w = p.joints[j]?;
        let m = p.motion[j]?;
        Some(self.velocity(w, m, p.slot as usize))
    }

    /// wall [x, y] (m) -> LED uv
    pub fn uv(&self, x: f32, y: f32) -> [f32; 2] {
        [x / self.setup.size_w, (self.setup.bottom + self.setup.size_h - y) / self.setup.size_h]
    }

    /// wall [x, y] (m) -> LED pixels
    pub fn px(&self, x: f32, y: f32) -> [f32; 2] {
        let [u, v] = self.uv(x, y);
        [u * self.setup.led_w as f32, v * self.setup.led_h as f32]
    }

    pub fn from_uv(&self, u: f32, v: f32) -> [f32; 2] {
        [u * self.setup.size_w, self.setup.bottom + (1.0 - v) * self.setup.size_h]
    }

    pub fn from_px(&self, x: f32, y: f32) -> [f32; 2] {
        self.from_uv(x / self.setup.led_w as f32, y / self.setup.led_h as f32)
    }

    pub fn on_wall(&self, x: f32, y: f32) -> bool {
        let s = &self.setup;
        x >= 0.0 && x < s.size_w && y >= s.bottom && y < s.bottom + s.size_h
    }

    /// 1 at the zone's near end .. 0 at its far end (dist: m from the sensor)
    pub fn near(&self, dist: f32) -> f32 {
        let [n, f] = self.zone();
        ((f - dist) / (f - n).max(0.01)).clamp(0.0, 1.0)
    }

    /// a joint of a person on the wall
    pub fn joint(&self, p: &Person, j: usize) -> Option<Vec3> {
        p.joints[j].map(|w| self.from_world(w, p.slot as usize))
    }

    /// Depth image pixel -> wall [x, y] as kinectUv() shows the camera image on the LED image.
    pub fn image_to_wall(&self, u: f32, v: f32, rays: Option<&[f32]>) -> Option<[f32; 2]> {
        let s = &self.setup;
        let p = &self.projection;
        let i = ((v.round().clamp(0.0, KINECT_H - 1.0) as usize) * 512 + u.round().clamp(0.0, KINECT_W - 1.0) as usize) * 2;
        let (rx, ry) = match rays {
            Some(r) => (r[i], r[i + 1]),
            None => ((u - self.inv[0]) / self.inv[1], (v - self.inv[2]) / self.inv[3]),
        };
        let m = &self.room;
        let d = apply_m(m, Vec3::new(self.x_sign * rx, -ry, 1.0), 0.0);
        if d.z <= 1e-4 {
            return None;
        }
        let rz = p.image_distance - s.sensor_front;
        let t = (rz - m[14]) / d.z;
        let room = Vec3::new(m[12] + t * d.x, m[13] + t * d.y, rz);
        let px = self.plan_x0() + self.x_sign * room.x;
        let x = if p.image_stretch { self.map_x(px, p.image_distance) } else { self.plan_x0() + self.mirror_sign() * (px - self.plan_x0()) };
        Some([x, self.map_y(room.y)])
    }

    /// where a person is on the wall (computed once per frame for the visible ones)
    pub fn place(&mut self, p: &Person) -> Option<Placed> {
        if let Some(x) = self.persons.iter().find(|q| q.id == p.id) {
            return Some(x.clone());
        }
        self.place_inner(p, 0.0, 0.0, false)
    }

    pub fn placed(&self, id: u32) -> Option<&Placed> {
        self.persons.iter().find(|q| q.id == id)
    }

    pub fn mirror(&self, p: Vec3) -> Vec3 {
        Vec3::new(p.x - self.setup.size_w / 2.0, p.y, -p.z)
    }

    /// room point -> floor plan [x, z]
    pub fn plan(&self, r: Vec3) -> [f32; 2] {
        [self.plan_x0() + self.x_sign * r.x, self.setup.sensor_front + r.z]
    }

    pub fn block_at(&self, x: f32, z: f32) -> Option<&Block> {
        self.setup.blocks.iter().find(|b| b.enabled && in_polygon(x, z, &b.points))
    }

    /// Removes everybody standing in a block zone from a tracking result (their feet decide).
    pub fn filter_persons(&mut self, result: Arc<PersonsResult>, exact: bool) -> Arc<PersonsResult> {
        if result.list.is_empty() || !self.setup.blocks.iter().any(|b| b.enabled) {
            if !exact {
                self.blocked.clear();
            }
            return result;
        }
        let mut blocked = [false; 256];
        let mut gone = Vec::new();
        for c in result.list.iter() {
            let Some(p) = crate::persons::RawPerson::pt3(&c.ground).or_else(|| crate::persons::RawPerson::pt3(&c.centroid)) else {
                continue;
            };
            let r = self.to_room(Vec3::new(self.x_sign * p[0] as f32 / 1000.0, -p[1] as f32 / 1000.0, p[2] as f32 / 1000.0));
            let [x, z] = self.plan(r);
            if self.block_at(x, z).is_none() {
                continue;
            }
            blocked[c.slot as usize] = true;
            gone.push((c.id, c.slot, x, z));
        }
        if !exact {
            self.blocked = gone.clone();
        }
        if gone.is_empty() {
            return result;
        }
        let mut r = (*result).clone();
        r.list = Arc::new(result.list.iter().filter(|c| !blocked[c.slot as usize]).cloned().collect());
        if let (Some(labels), Some(depth), Some(meters), Some(indices)) = (&result.labels, &result.depth, &result.meters, &result.indices) {
            let mut l = (**labels).clone();
            let mut d = (**depth).clone();
            let mut m = (**meters).clone();
            let mut ix = Vec::with_capacity(result.count);
            for &i in &indices[..result.count] {
                let iu = i as usize;
                if blocked[l[iu] as usize] {
                    l[iu] = 0;
                    d[iu] = 0;
                    m[iu] = 0.0;
                } else {
                    ix.push(i);
                }
            }
            r.count = ix.len();
            ix.resize(indices.len(), 0);
            r.labels = Some(Arc::new(l));
            r.depth = Some(Arc::new(d));
            r.meters = Some(Arc::new(m));
            r.indices = Some(Arc::new(ix));
        }
        Arc::new(r)
    }

    fn standing(&self, st: &mut Track, p: &Person, now: f64) -> f32 {
        let mut h = Some(p.height).filter(|h| h.is_finite() && *h > 0.3);
        if h.is_none() {
            h = p.head.map(|hd| self.to_room(hd).y + 0.1);
        }
        if let Some(h) = h {
            st.heights.push_back((now, h));
            while st.heights.front().is_some_and(|x| now - x.0 > HEIGHT_WINDOW_MS) {
                st.heights.pop_front();
            }
        }
        if st.heights.is_empty() {
            return st.est.unwrap_or(self.projection.body_height);
        }
        let mut sorted: Vec<f32> = st.heights.iter().map(|x| x.1).collect();
        sorted.sort_by(f32::total_cmp);
        let want = sorted[(sorted.len() - 1).min((sorted.len() as f32 * 0.8).floor() as usize)];
        let est = match st.est {
            Some(e) => e + (want - e) * 0.05,
            None => want,
        };
        st.est = Some(est);
        est
    }

    fn place_inner(&mut self, person: &Person, dt: f32, now: f64, track: bool) -> Option<Placed> {
        let c = person.center.or(person.joints[crate::persons::j::CENTER]).or(person.ground)?;
        let front = self.setup.sensor_front;
        let r = self.to_room(c);
        if track && !self.track.contains_key(&person.id) {
            self.track.insert(person.id, Track { euro: Euro::default(), smooth: None, heights: Default::default(), est: None, at: now });
        }
        let mut st = self.track.remove(&person.id);
        if track && let Some(s) = st.as_mut() {
            s.at = now;
        }
        let p = self.projection.clone();
        // the place on the floor that is mapped: smoothed, and looked ahead along the walk
        let mut m = r;
        if p.smoothing > 0.0
            && let Some(s) = st.as_mut()
        {
            if track {
                s.smooth = Some(s.euro.step(r, dt, 6.0 * 0.04_f32.powf(p.smoothing), 0.8));
            }
            if let Some(sm) = s.smooth {
                m = sm;
            }
        }
        let v = apply_m(&self.room, person.velocity, 0.0);
        let speed = v.x.hypot(v.z);
        let vs = if speed > 3.0 { 3.0 / speed } else { 1.0 };
        if p.predict > 0.0 {
            m = Vec3::new(m.x + v.x * vs * p.predict, m.y, m.z + v.z * vs * p.predict);
        }
        let real_x = self.plan_x0() + self.x_sign * r.x;
        let px = self.plan_x0() + self.x_sign * m.x;
        let pz = front + m.z;
        let per_person = p.per_person;
        let edge = |w: &Self, x: f32| if per_person { w.edge(x) } else { x };
        let x = edge(self, self.map_x(px, pz));
        let mut k = p.body_scale;
        if p.body_fit_height
            && let Some(s) = st.as_mut()
        {
            let standing = if track { self.standing(s, person, now) } else { s.est.unwrap_or(p.body_height) };
            k *= (p.body_height / standing.max(0.5)).clamp(0.55, 1.8);
        }
        let ms = self.mirror_sign();
        let offset = x - ms * real_x * k;
        let ahead = 0.05;
        let vx = (edge(self, self.map_x(px + self.x_sign * v.x * vs * ahead, pz + v.z * vs * ahead)) - x) / ahead;
        let rate = vx - ms * self.x_sign * v.x * k;
        let y = self.map_y(r.y * if per_person { k } else { 1.0 });
        let ground = person.ground.map(|g| self.to_room(g)).unwrap_or(Vec3::new(r.x, 0.0, r.z));
        let head = person.head.map(|h| self.to_room(h));
        let kk = if per_person { k } else { 1.0 };
        let [u, vv] = self.uv(x, y);
        let lat = self.side() * r.x;
        if let Some(s) = st {
            self.track.insert(person.id, s);
        }
        Some(Placed {
            id: person.id,
            slot: person.slot,
            color: person.color,
            css: person.css,
            x,
            y,
            z: front + r.z,
            norm: self.norm_of(x, y, pz),
            plan: [real_x, front + r.z],
            dist: r.z,
            lateral: self.x_sign * r.x,
            real: real_x,
            scale: kk,
            gain: self.gain(px, pz),
            offset,
            rate,
            shift: if per_person { x - (self.plan_x0() + lat) } else { 0.0 },
            shift_rate: if per_person { vx - self.side() * v.x } else { 0.0 },
            vx,
            vy: (self.map_y(r.y * kk + 0.01) - self.map_y(r.y * kk - 0.01)) / 0.02 * kk * v.y,
            u,
            v: vv,
            px: u * self.setup.led_w as f32,
            py: vv * self.setup.led_h as f32,
            feet: self.map_y(ground.y * kk),
            top: match head {
                Some(h) => self.map_y((h.y + 0.12) * kk),
                None => y + 0.8 * kk,
            },
            room: r,
            in_zone: front + r.z >= p.zone_near && front + r.z <= p.zone_far,
            near: self.near(r.z),
            visible: person.visible,
            height: person.height,
        })
    }

    // ---------- GPU ----------

    fn write_uniform(&mut self) {
        let s = &self.setup;
        let p = &self.projection;
        let [out_l, out_r] = self.target();
        let zone = self.zone();
        let d = &mut self.data;
        d[U_ROOM..U_ROOM + 16].copy_from_slice(&self.room);
        d[U_ROOM_INV..U_ROOM_INV + 16].copy_from_slice(&self.room_inv);
        d[U_LED..U_LED + 4].copy_from_slice(&[s.led_w as f32, s.led_h as f32, s.size_w, s.size_h]);
        d[U_BOTTOM..U_BOTTOM + 4].copy_from_slice(&[s.bottom, s.sensor_x, s.sensor_front, self.x_sign]);
        let ms = if p.mirror { 1.0 } else { -1.0 };
        d[U_MIRROR..U_MIRROR + 4].copy_from_slice(&[ms, if p.per_person { 1.0 } else { 0.0 }, self.tan_h, if self.active { 1.0 } else { 0.0 }]);
        d[U_ZONE..U_ZONE + 4].copy_from_slice(&[zone[0], zone[1], ms * self.x_sign, s.size_w / 2.0 + s.sensor_x]);
        d[U_FIELD..U_FIELD + 4].copy_from_slice(&[p.f_near, p.f_far, p.near_l, p.near_r]);
        d[U_FIELD2..U_FIELD2 + 4].copy_from_slice(&[p.far_l, p.far_r, p.low, p.high]);
        d[U_OUT..U_OUT + 4].copy_from_slice(&[out_l, out_r, p.out_bottom, p.out_top]);
        d[U_INV..U_INV + 4].copy_from_slice(&self.inv);
        d[U_IMAGE..U_IMAGE + 4].copy_from_slice(&[p.image_distance, if p.image_stretch { 1.0 } else { 0.0 }, p.margin, 0.0]);
        for c in 0..5 {
            d[U_CURVES + c * 36..U_CURVES + c * 36 + LUT_N].copy_from_slice(&self.luts[c]);
        }
        for i in 0..SLOTS {
            d[U_SLOTS + i * 4..U_SLOTS + i * 4 + 4].copy_from_slice(&[self.offset[i], self.scale[i], if self.visible[i] { 1.0 } else { 0.0 }, self.rate[i]]);
        }
    }

    /// The uniform data for `struct Wall` (written by the runtime to the scene's wall buffer).
    pub fn uniform_bytes(&mut self) -> &[u8] {
        self.write_uniform();
        bytemuck::cast_slice(&self.data)
    }
}
