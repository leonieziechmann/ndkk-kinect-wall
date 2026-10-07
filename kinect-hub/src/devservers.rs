//! Registry of the scene dev servers (Vite, usually one per git worktree) that use this hub.
//!
//! Each dev server announces itself every few seconds with its URL, branch and scene list; an
//! entry that stops announcing expires after `TTL`. The start page reads the list, so one page
//! shows the scenes of every agent. Everything here is advisory: a broken or hostile announcement
//! can at worst add a link to a localhost port, never affect the data streams.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use tracing::info;

/// An entry without a fresh announcement for this long is dropped.
pub const TTL: Duration = Duration::from_secs(15);
/// Upper bound for simultaneously registered dev servers.
pub const MAX_SERVERS: usize = 64;
const MAX_SCENES: usize = 300;
const MAX_TEXT: usize = 300;
const MAX_NAME: usize = 64;

/// What a dev server sends (`POST /api/devservers`). Everything but `url` is optional.
#[derive(Deserialize)]
pub struct Registration {
    pub url: String,
    pub label: Option<String>,
    pub branch: Option<String>,
    pub worktree: Option<String>,
    pub hub: Option<String>,
    pub pid: Option<u32>,
    pub scenes: Option<Vec<SceneAnnouncement>>,
}

#[derive(Deserialize)]
pub struct SceneAnnouncement {
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    pub thumb: Option<String>,
    pub modified_ms: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RegisterError {
    /// The URL is not `http://127.0.0.1|localhost|[::1]:<port>`.
    BadUrl,
    /// `MAX_SERVERS` live entries already.
    Full,
}

struct Scene {
    name: String,
    title: String,
    description: String,
    author: String,
    thumb: Option<String>,
    modified_ms: Option<u64>,
    error: Option<String>,
}

struct Entry {
    url: String,
    label: String,
    branch: String,
    worktree: String,
    hub: String,
    pid: Option<u32>,
    scenes: Vec<Scene>,
    first_seen: Instant,
    last_seen: Instant,
}

#[derive(Default)]
pub struct DevServers {
    map: Mutex<HashMap<String, Entry>>,
}

impl DevServers {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.map.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn purge(map: &mut HashMap<String, Entry>) {
        map.retain(|url, e| {
            let alive = e.last_seen.elapsed() <= TTL;
            if !alive {
                info!("dev server gone: {} ({url})", e.label);
            }
            alive
        });
    }

    /// Adds or refreshes an entry. `Ok(true)` = new dev server.
    pub fn register(&self, reg: Registration) -> Result<bool, RegisterError> {
        let url = normalize_url(&reg.url).ok_or(RegisterError::BadUrl)?;
        let now = Instant::now();
        let scenes: Vec<Scene> = reg
            .scenes
            .unwrap_or_default()
            .into_iter()
            .filter(|s| valid_name(&s.name))
            .take(MAX_SCENES)
            .map(|s| Scene {
                name: s.name,
                title: clean(s.title),
                description: clean(s.description),
                author: clean(s.author),
                thumb: s.thumb.filter(|t| valid_path(t)),
                modified_ms: s.modified_ms,
                error: s.error.map(|e| clean(Some(e))).filter(|e| !e.is_empty()),
            })
            .collect();
        let mut label = clean(reg.label);
        if label.is_empty() {
            label = url.clone();
        }
        let mut map = self.lock();
        Self::purge(&mut map);
        let first_seen = match map.get(&url) {
            Some(old) => old.first_seen,
            None if map.len() >= MAX_SERVERS => return Err(RegisterError::Full),
            None => now,
        };
        let is_new = first_seen == now;
        if is_new {
            info!("dev server registered: {label} ({url}, {} scenes)", scenes.len());
        }
        map.insert(
            url.clone(),
            Entry {
                url,
                label,
                branch: clean(reg.branch),
                worktree: clean(reg.worktree),
                hub: clean(reg.hub),
                pid: reg.pid,
                scenes,
                first_seen,
                last_seen: now,
            },
        );
        Ok(is_new)
    }

    /// Removes an entry (dev server shutting down). `false` = it was not registered.
    pub fn remove(&self, raw_url: &str) -> bool {
        let Some(url) = normalize_url(raw_url) else { return false };
        let removed = self.lock().remove(&url);
        if let Some(e) = &removed {
            info!("dev server signed off: {} ({url})", e.label);
        }
        removed.is_some()
    }

    pub fn count(&self) -> usize {
        let mut map = self.lock();
        Self::purge(&mut map);
        map.len()
    }

    pub fn list_json(&self) -> Value {
        let mut map = self.lock();
        Self::purge(&mut map);
        let mut entries: Vec<&Entry> = map.values().collect();
        entries.sort_by(|a, b| a.label.cmp(&b.label).then_with(|| a.url.cmp(&b.url)));
        let list: Vec<Value> = entries
            .iter()
            .map(|e| {
                let scenes: Vec<Value> = e
                    .scenes
                    .iter()
                    .map(|s| {
                        json!({
                            "name": s.name,
                            "title": s.title,
                            "description": s.description,
                            "author": s.author,
                            "url": format!("{}/scenes/{}/", e.url, s.name),
                            "thumb": s.thumb.as_ref().map(|t| format!("{}{t}", e.url)),
                            "modified_ms": s.modified_ms,
                            "error": s.error,
                        })
                    })
                    .collect();
                json!({
                    "url": e.url,
                    "label": e.label,
                    "branch": e.branch,
                    "worktree": e.worktree,
                    "hub": e.hub,
                    "pid": e.pid,
                    "scenes": scenes,
                    "registered_s": e.first_seen.elapsed().as_secs(),
                    "seen_ms_ago": u64::try_from(e.last_seen.elapsed().as_millis()).unwrap_or(u64::MAX),
                })
            })
            .collect();
        json!({ "ttl_s": TTL.as_secs(), "devservers": list })
    }
}

/// Accepts only dev servers on this machine: `http://127.0.0.1|localhost|[::1]:<port>`, no path.
pub fn normalize_url(raw: &str) -> Option<String> {
    let rest = raw.trim().trim_end_matches('/').strip_prefix("http://")?;
    let (host, port) = match rest.strip_prefix('[') {
        Some(v6) => {
            let (h, p) = v6.split_once("]:")?;
            (format!("[{h}]"), p)
        }
        None => {
            let (h, p) = rest.rsplit_once(':')?;
            (h.to_ascii_lowercase(), p)
        }
    };
    if !matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]") {
        return None;
    }
    let port: u16 = port.parse().ok()?;
    (port != 0).then(|| format!("http://{host}:{port}"))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// A path on the dev server (thumbnail): starts with a single '/', harmless characters only.
fn valid_path(p: &str) -> bool {
    p.starts_with('/')
        && !p.starts_with("//")
        && p.len() <= MAX_TEXT
        && p.chars().all(|c| c.is_ascii_alphanumeric() || "/_-.?=&%".contains(c))
}

fn clean(s: Option<String>) -> String {
    let s: String = s.unwrap_or_default().chars().filter(|c| !c.is_control()).take(MAX_TEXT).collect();
    s.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reg(url: &str) -> Registration {
        Registration { url: url.into(), label: None, branch: None, worktree: None, hub: None, pid: None, scenes: None }
    }

    #[test]
    fn urls() {
        assert_eq!(normalize_url("http://127.0.0.1:5173/"), Some("http://127.0.0.1:5173".into()));
        assert_eq!(normalize_url("http://LOCALHOST:5174"), Some("http://localhost:5174".into()));
        assert_eq!(normalize_url("http://[::1]:5175"), Some("http://[::1]:5175".into()));
        for bad in ["https://127.0.0.1:5173", "http://evil.com:80", "http://127.0.0.1", "http://127.0.0.1:0",
                    "http://127.0.0.1:5173/x", "http://127.0.0.1:99999", "javascript:alert(1)", ""] {
            assert_eq!(normalize_url(bad), None, "{bad}");
        }
    }

    #[test]
    fn register_refresh_remove() {
        let d = DevServers::default();
        assert_eq!(d.register(reg("http://127.0.0.1:5173")), Ok(true));
        assert_eq!(d.register(reg("http://127.0.0.1:5173/")), Ok(false));
        assert_eq!(d.register(reg("http://example.com:5173")), Err(RegisterError::BadUrl));
        assert_eq!(d.count(), 1);
        assert!(d.remove("http://127.0.0.1:5173"));
        assert!(!d.remove("http://127.0.0.1:5173"));
        assert_eq!(d.count(), 0);
    }

    #[test]
    fn limits() {
        let d = DevServers::default();
        for port in 0..MAX_SERVERS {
            assert_eq!(d.register(reg(&format!("http://127.0.0.1:{}", 6000 + port))), Ok(true));
        }
        assert_eq!(d.register(reg("http://127.0.0.1:7999")), Err(RegisterError::Full));
        // known entries can still refresh
        assert_eq!(d.register(reg("http://127.0.0.1:6000")), Ok(false));
    }

    #[test]
    fn sanitizes_scenes() {
        let d = DevServers::default();
        let mut r = reg("http://127.0.0.1:5173");
        let scene = |name: &str, thumb: &str| SceneAnnouncement {
            name: name.into(),
            title: Some("T\u{0}itle".into()),
            description: None,
            author: None,
            thumb: Some(thumb.into()),
            modified_ms: None,
            error: None,
        };
        r.scenes = Some(vec![scene("ok-1", "/__thumb/ok-1.jpg?v=3"), scene("Bad Name", "/x"), scene("evil", "//evil.com/x")]);
        assert_eq!(d.register(r), Ok(true));
        let list = d.list_json();
        let scenes = list.pointer("/devservers/0/scenes").and_then(Value::as_array).cloned().unwrap_or_default();
        assert_eq!(scenes.len(), 2);
        assert_eq!(scenes.first().and_then(|s| s.get("title")), Some(&json!("Title")));
        assert_eq!(scenes.get(1).and_then(|s| s.get("thumb")), Some(&Value::Null));
    }
}
