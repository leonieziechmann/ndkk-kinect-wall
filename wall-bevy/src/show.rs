//! The show (port of web/lib/wall-show.js): a playlist of scenes with their own param values,
//! edited in the control center, saved in web/.cache/wall/show.json.

use serde_json::{Value, json};

use crate::wall::valid_name;

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    pub scene: String,
    pub label: String,
    /// s
    pub duration: f64,
    pub enabled: bool,
    /// may run over its duration (waitForEmpty, waitForRound); false: on time (ads)
    pub wait: bool,
    pub params: Value,
}

impl Entry {
    /// a scene to look at, not in the show (▶ in the control center)
    pub fn adhoc(scene: &str) -> Self {
        Entry { id: "adhoc".into(), scene: scene.into(), label: String::new(), duration: 300.0, enabled: true, wait: true, params: json!({}) }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transition {
    Cross,
    Black,
    Cut,
}

impl Transition {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "cross" => Some(Transition::Cross),
            "black" => Some(Transition::Black),
            "cut" => Some(Transition::Cut),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Show {
    pub entries: Vec<Entry>,
    pub auto: bool,
    pub wait_for_empty: bool,
    pub max_wait: f64,
    pub max_wait_many: f64,
    pub many_persons: f64,
    pub wait_for_round: bool,
    pub max_round_wait: f64,
    pub transition: Transition,
    pub fade: f64,
}

fn num(v: Option<&Value>, min: f64, max: f64, fallback: f64) -> f64 {
    v.and_then(Value::as_f64).filter(|x| x.is_finite()).map(|x| x.clamp(min, max)).unwrap_or(fallback)
}

fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(1);
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
    format!("{:x}", t ^ N.fetch_add(1, Ordering::Relaxed).wrapping_mul(0x9e37_79b9_7f4a_7c15)).chars().take(8).collect()
}

pub fn normalize_show(raw: &Value) -> Show {
    let mut entries = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for e in raw.get("entries").and_then(Value::as_array).cloned().unwrap_or_default() {
        let Some(scene) = e.get("scene").and_then(Value::as_str).filter(|s| valid_name(s)) else {
            continue;
        };
        let mut id = e.get("id").and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 32 && s.chars().all(|c| c.is_ascii_alphanumeric())).map(String::from).unwrap_or_else(new_id);
        if ids.contains(&id) {
            id = new_id();
        }
        ids.insert(id.clone());
        entries.push(Entry {
            id,
            scene: scene.to_string(),
            label: e.get("label").and_then(Value::as_str).unwrap_or("").chars().take(120).collect(),
            duration: num(e.get("duration"), 5.0, 86400.0, 300.0),
            enabled: e.get("enabled").and_then(Value::as_bool) != Some(false),
            wait: e.get("wait").and_then(Value::as_bool) != Some(false),
            params: e.get("params").filter(|p| p.is_object()).cloned().unwrap_or_else(|| json!({})),
        });
    }
    let max_wait = num(raw.get("maxWait"), 0.0, 3600.0, 120.0);
    Show {
        entries,
        auto: raw.get("auto").and_then(Value::as_bool) == Some(true),
        wait_for_empty: raw.get("waitForEmpty").and_then(Value::as_bool) != Some(false),
        max_wait,
        max_wait_many: num(raw.get("maxWaitMany"), 0.0, 3600.0, max_wait),
        many_persons: num(raw.get("manyPersons"), 2.0, 50.0, 10.0).round(),
        wait_for_round: raw.get("waitForRound").and_then(Value::as_bool) != Some(false),
        max_round_wait: num(raw.get("maxRoundWait"), 0.0, 3600.0, 120.0),
        transition: raw.get("transition").and_then(Value::as_str).and_then(Transition::parse).unwrap_or(Transition::Cross),
        fade: num(raw.get("fade"), 0.0, 10.0, 1.5),
    }
}

/// s an entry may run over while `crowd` people stand in front: from maxWait (1) to maxWaitMany.
pub fn crowd_wait(show: &Show, crowd: usize) -> f64 {
    let u = ((crowd as f64 - 1.0) / (show.many_persons - 1.0).max(1.0)).clamp(0.0, 1.0);
    show.max_wait + (show.max_wait_many - show.max_wait) * u
}

/// The next enabled entry after `id` (dir +1) or before it (-1).
pub fn step_entry<'a>(show: &'a Show, id: Option<&str>, dir: i32) -> Option<&'a Entry> {
    let list = &show.entries;
    if list.is_empty() {
        return None;
    }
    let n = list.len() as i64;
    let at = id.and_then(|id| list.iter().position(|e| e.id == id)).map(|i| i as i64).unwrap_or(if dir > 0 { -1 } else { 0 });
    for i in 1..=n {
        let k = ((at + i64::from(dir) * i) % n + n) % n;
        let e = &list[k as usize];
        if e.enabled {
            return Some(e);
        }
    }
    None
}

