//! Scene parameters (port of web/lib/params.js): the same keys, defaults and ranges as the
//! browser scenes, so the control center's show entries (params per entry) apply unchanged.
//! Values come from the show entry; missing or invalid ones get the scene's default.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Value, json};

#[derive(Clone, Debug)]
pub enum Kind {
    Number { min: f64, max: f64, step: f64 },
    Bool,
    Color,
    /// (label, value) pairs; JS arrays have label = value
    Select(Vec<(String, Value)>),
    Text,
}

#[derive(Clone, Debug)]
pub struct ParamSpec {
    pub key: String,
    pub kind: Kind,
    pub default: Value,
    pub label: String,
}

impl ParamSpec {
    /// The value as this param keeps it, or None if it does not fit: numbers as f64, a select's
    /// own option value (numbers compared by value, as JS does: 4 and 4.0 are the same option).
    pub fn canonical(&self, v: &Value) -> Option<Value> {
        match &self.kind {
            Kind::Number { .. } => v.as_f64().filter(|x| x.is_finite()).map(|x| json!(x)),
            Kind::Bool => v.is_boolean().then(|| v.clone()),
            Kind::Color => v.as_str().filter(|s| is_color(s)).map(|_| v.clone()),
            Kind::Select(opts) => opts.iter().find(|(_, o)| o == v || (o.is_number() && o.as_f64() == v.as_f64())).map(|(_, o)| o.clone()),
            Kind::Text => v.is_string().then(|| v.clone()),
        }
    }
}

pub fn is_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

// ----- builders (as the browser's params: { key: { value, min, max, step, label } }) -----

pub fn num(key: &str, value: f64, min: f64, max: f64, step: f64, label: &str) -> ParamSpec {
    ParamSpec { key: key.into(), kind: Kind::Number { min, max, step }, default: json!(value), label: label.into() }
}

pub fn boolean(key: &str, value: bool, label: &str) -> ParamSpec {
    ParamSpec { key: key.into(), kind: Kind::Bool, default: json!(value), label: label.into() }
}

pub fn color(key: &str, value: &str, label: &str) -> ParamSpec {
    ParamSpec { key: key.into(), kind: Kind::Color, default: json!(value), label: label.into() }
}

/// options given as plain values (JS array)
pub fn select(key: &str, value: &str, options: &[&str], label: &str) -> ParamSpec {
    ParamSpec { key: key.into(), kind: Kind::Select(options.iter().map(|o| (o.to_string(), json!(o))).collect()), default: json!(value), label: label.into() }
}

/// options given as label -> value (JS object)
pub fn select_map(key: &str, value: Value, options: &[(&str, Value)], label: &str) -> ParamSpec {
    ParamSpec { key: key.into(), kind: Kind::Select(options.iter().map(|(l, v)| (l.to_string(), v.clone())).collect()), default: value, label: label.into() }
}

pub fn text(key: &str, value: &str, label: &str) -> ParamSpec {
    ParamSpec { key: key.into(), kind: Kind::Text, default: json!(value), label: label.into() }
}

/// The values of a running scene instance.
#[derive(Clone, Debug)]
pub struct Params {
    pub specs: Arc<Vec<ParamSpec>>,
    pub values: HashMap<String, Value>,
}

impl Params {
    /// The overrides' values (a show entry's params) over the defaults.
    pub fn resolve(specs: Arc<Vec<ParamSpec>>, overrides: &Value) -> Self {
        let mut values = HashMap::new();
        for p in specs.iter() {
            let v = overrides.get(&p.key).and_then(|v| p.canonical(v)).unwrap_or_else(|| p.canonical(&p.default).unwrap_or_else(|| p.default.clone()));
            values.insert(p.key.clone(), v);
        }
        Self { specs, values }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.values.get(key)
    }

    /// a number (checkbox: 0/1)
    pub fn f(&self, key: &str) -> f32 {
        self.f64(key) as f32
    }

    pub fn f64(&self, key: &str) -> f64 {
        match self.values.get(key) {
            Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
            Some(Value::Bool(b)) => f64::from(u8::from(*b)),
            _ => 0.0,
        }
    }

    pub fn b(&self, key: &str) -> bool {
        match self.values.get(key) {
            Some(Value::Bool(b)) => *b,
            Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0) != 0.0,
            _ => false,
        }
    }

    pub fn s(&self, key: &str) -> &str {
        self.values.get(key).and_then(Value::as_str).unwrap_or("")
    }

    /// '#rrggbb' as [r, g, b] 0..1
    pub fn color(&self, key: &str) -> [f32; 3] {
        crate::persons::hex_rgb(self.s(key))
    }

    /// The value for WGSL: numbers and checkboxes as is, colors as rgb, options the value if
    /// numeric, else the index.
    pub fn shader_value(&self, p: &ParamSpec) -> [f32; 3] {
        let v = self.values.get(&p.key).cloned().unwrap_or(Value::Null);
        match &p.kind {
            Kind::Color => crate::persons::hex_rgb(v.as_str().unwrap_or("#000000")),
            Kind::Bool => [if v.as_bool().unwrap_or(false) { 1.0 } else { 0.0 }, 0.0, 0.0],
            Kind::Select(opts) => {
                if let Some(n) = v.as_f64() {
                    [n as f32, 0.0, 0.0]
                } else {
                    [opts.iter().position(|(_, o)| *o == v).unwrap_or(0) as f32, 0.0, 0.0]
                }
            }
            Kind::Number { .. } => [v.as_f64().unwrap_or(0.0) as f32, 0.0, 0.0],
            Kind::Text => [0.0; 3],
        }
    }

    /// JSON of all values (telemetry).
    pub fn to_json(&self) -> Value {
        Value::Object(self.values.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
    }
}

/// A running glide of numbers and colors to a show entry's new values (runtime.js retune()).
pub struct Glide {
    pub from: HashMap<String, Value>,
    pub to: HashMap<String, Value>,
    pub start: f64,
    pub ms: f64,
}

fn rgb_of(s: &str) -> [f64; 3] {
    let c = crate::persons::hex_rgb(s);
    [f64::from(c[0]) * 255.0, f64::from(c[1]) * 255.0, f64::from(c[2]) * 255.0]
}

fn hex_of(c: [f64; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0].round().clamp(0.0, 255.0) as u8, c[1].round().clamp(0.0, 255.0) as u8, c[2].round().clamp(0.0, 255.0) as u8)
}

/// New values for a running instance: with `fade` (s) numbers and colors glide there, the rest
/// switches at once. Returns the keys changed at once and the glide, if any.
pub fn retune(params: &mut Params, overrides: &Value, fade: f64, now: f64) -> (Vec<String>, Option<Glide>) {
    let want = Params::resolve(params.specs.clone(), overrides);
    let mut changed = Vec::new();
    let mut glide = Glide { from: HashMap::new(), to: HashMap::new(), start: now, ms: fade * 1000.0 };
    for p in params.specs.iter() {
        let now_v = params.values.get(&p.key).cloned().unwrap_or(Value::Null);
        let want_v = want.values.get(&p.key).cloned().unwrap_or(Value::Null);
        if now_v == want_v {
            continue;
        }
        let same_type = matches!((&now_v, &want_v), (Value::Number(_), Value::Number(_)) | (Value::String(_), Value::String(_)));
        if fade > 0.0 && same_type && matches!(p.kind, Kind::Number { .. } | Kind::Color) {
            glide.from.insert(p.key.clone(), now_v);
            glide.to.insert(p.key.clone(), want_v);
        } else {
            params.values.insert(p.key.clone(), want_v);
            changed.push(p.key.clone());
        }
    }
    (changed, if glide.to.is_empty() { None } else { Some(glide) })
}

/// One step of a glide; returns the keys it set and whether it is done.
pub fn step_glide(params: &mut Params, g: &Glide, now: f64) -> (Vec<String>, bool) {
    let t = ((now - g.start) / g.ms.max(1.0)).min(1.0);
    let e = t * t * (3.0 - 2.0 * t);
    let mut keys = Vec::new();
    for p in params.specs.iter() {
        let (Some(a), Some(b)) = (g.from.get(&p.key), g.to.get(&p.key)) else {
            continue;
        };
        let v = if t >= 1.0 {
            b.clone()
        } else {
            match (&p.kind, a, b) {
                (Kind::Color, Value::String(a), Value::String(b)) => {
                    let (ca, cb) = (rgb_of(a), rgb_of(b));
                    json!(hex_of([ca[0] + (cb[0] - ca[0]) * e, ca[1] + (cb[1] - ca[1]) * e, ca[2] + (cb[2] - ca[2]) * e]))
                }
                (Kind::Number { step, .. }, Value::Number(a), Value::Number(b)) => {
                    let (a, b) = (a.as_f64().unwrap_or(0.0), b.as_f64().unwrap_or(0.0));
                    let mut v = a + (b - a) * e;
                    if step.fract() == 0.0 && a.fract() == 0.0 && b.fract() == 0.0 {
                        v = v.round();
                    }
                    json!(v)
                }
                _ => b.clone(),
            }
        };
        params.values.insert(p.key.clone(), v);
        keys.push(p.key.clone());
    }
    (keys, t >= 1.0)
}
