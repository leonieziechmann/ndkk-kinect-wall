//! What the pages that render scenes report about themselves: about once a second
//! `{"type":"render","fps":57.3,"target":60,"visible":true,"scene":"neon-wall"}`. While a visible
//! page renders slower than it wants, the pose model steps down to a cheaper model and does not
//! try better ones (pose.rs): the scene gets the GPU first.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// A report counts this long.
const FRESH: Duration = Duration::from_secs(3);
/// A page renders too slowly below this share of the rate it wants ...
const SLOW: f64 = 0.85;
/// ... but not below this rate: such a page is throttled (a hidden window or pane), its GPU is
/// not too busy.
const THROTTLED_FPS: f64 = 5.0;
/// At most this many pages are remembered.
const MAX_PAGES: usize = 256;

#[derive(Clone, Debug)]
struct Report {
    at: Instant,
    fps: f64,
    target: f64,
    visible: bool,
    scene: String,
}

#[derive(Default)]
pub struct RenderReports(Mutex<HashMap<u64, Report>>);

impl RenderReports {
    fn lock(&self) -> MutexGuard<'_, HashMap<u64, Report>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The newest report of a client (WebSocket session).
    pub fn report(&self, client: u64, fps: f64, target: Option<f64>, visible: Option<bool>, scene: Option<String>) {
        if !fps.is_finite() || fps < 0.0 {
            return;
        }
        let target = target.filter(|t| t.is_finite() && *t >= 1.0).unwrap_or(60.0).min(240.0);
        let scene: String = scene.unwrap_or_default().chars().take(64).collect();
        let mut m = self.lock();
        if m.len() >= MAX_PAGES && !m.contains_key(&client) {
            m.retain(|_, r| r.at.elapsed() < FRESH);
            if m.len() >= MAX_PAGES {
                return;
            }
        }
        m.insert(client, Report { at: Instant::now(), fps: fps.min(1000.0), target, visible: visible.unwrap_or(true), scene });
    }

    pub fn forget(&self, client: u64) {
        self.lock().remove(&client);
    }

    /// The visible page that renders slowest for its target, if one is too slow: "neon-wall 41 of
    /// 60 fps".
    pub fn pressure(&self) -> Option<String> {
        let m = self.lock();
        m.values()
            .filter(|r| r.at.elapsed() < FRESH && r.visible && r.fps >= THROTTLED_FPS && r.fps < SLOW * r.target)
            .min_by(|a, b| (a.fps / a.target).total_cmp(&(b.fps / b.target)))
            .map(|r| format!("{} {:.0} of {:.0} fps", if r.scene.is_empty() { "a page" } else { &r.scene }, r.fps, r.target))
    }

    pub fn status_json(&self) -> Value {
        let m = self.lock();
        let list: Vec<Value> = m
            .iter()
            .filter(|(_, r)| r.at.elapsed() < FRESH)
            .map(|(id, r)| json!({"client": id, "scene": r.scene, "fps": (r.fps * 10.0).round() / 10.0, "target": r.target, "visible": r.visible}))
            .collect();
        json!(list)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_visible_pages_that_are_slow_but_not_throttled_count() {
        let r = RenderReports::default();
        r.report(1, 59.0, Some(60.0), Some(true), Some("a".into()));
        assert!(r.pressure().is_none());
        r.report(2, 1.0, Some(60.0), Some(true), Some("hidden pane".into()));
        assert!(r.pressure().is_none());
        r.report(3, 20.0, Some(60.0), Some(false), Some("background tab".into()));
        assert!(r.pressure().is_none());
        r.report(4, 26.0, Some(30.0), Some(true), Some("wall".into()));
        assert!(r.pressure().is_none(), "26 of 30 is fine");
        r.report(5, 40.0, None, Some(true), Some("busy".into()));
        assert_eq!(r.pressure().as_deref(), Some("busy 40 of 60 fps"));
        r.forget(5);
        assert!(r.pressure().is_none());
    }
}
