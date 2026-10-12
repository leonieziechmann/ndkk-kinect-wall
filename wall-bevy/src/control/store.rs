//! The wall's documents: setup.json (the LED wall, the Kinect, block zones), projection.json (the
//! default projection and one per scene) and show.json (the playlist), in the data folder. The
//! control center changes them; they are written a moment after the last change (not for every
//! step of a slider), atomically, by the server's own thread (never while the output waits). A file
//! changed by someone else (by hand) is read again.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;

pub const KINDS: [&str; 3] = ["setup", "projection", "show"];

/// Written this long after the last change.
const SAVE_AFTER: Duration = Duration::from_millis(400);

struct Doc {
    value: Value,
    /// changed, not yet written: since when
    dirty: Option<Instant>,
    /// the file's time when we last read or wrote it
    stamp: Option<SystemTime>,
}

pub struct Store {
    dir: PathBuf,
    docs: HashMap<&'static str, Doc>,
}

pub fn file_of(dir: &Path, kind: &str) -> PathBuf {
    dir.join(format!("{kind}.json"))
}

pub fn stamp(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// A document from its file; missing or broken: an empty one (the defaults apply).
pub fn read(path: &Path) -> Value {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(Value::is_object).unwrap_or(Value::Null)
}

/// Writes `text` to `path` through a temporary file (a crash never leaves half a document).
pub fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

/// Takes over what the data folder does not have yet from the old place (web/.cache/wall of the
/// main checkout, where the browser's dev server kept it): once.
pub fn migrate(dir: &Path, legacy: &[PathBuf]) {
    let _ = std::fs::create_dir_all(dir);
    for name in ["setup.json", "projection.json", "show.json", "bevy-store.json", "bevy-current.txt"] {
        let target = dir.join(name);
        if target.exists() {
            continue;
        }
        if let Some(src) = legacy.iter().map(|d| d.join(name)).find(|p| p.is_file()) {
            match std::fs::copy(&src, &target) {
                Ok(_) => bevy::log::info!("übernommen: {} -> {}", src.display(), target.display()),
                Err(e) => bevy::log::warn!("{} nicht übernommen: {e}", src.display()),
            }
        }
    }
}

impl Store {
    /// The documents of `dir` as they are on disk.
    pub fn open(dir: &Path) -> Self {
        let mut docs = HashMap::new();
        for kind in KINDS {
            let path = file_of(dir, kind);
            docs.insert(kind, Doc { value: read(&path), dirty: None, stamp: stamp(&path) });
        }
        Self { dir: dir.to_path_buf(), docs }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn get(&self, kind: &str) -> Value {
        self.docs.get(kind).map(|d| d.value.clone()).unwrap_or(Value::Null)
    }

    /// All three as { setup, projection, show }.
    pub fn all(&self) -> Value {
        let mut o = serde_json::Map::new();
        for kind in KINDS {
            o.insert(kind.into(), self.get(kind));
        }
        Value::Object(o)
    }

    /// A new version of a document (an object). False: not one of ours, or not an object.
    pub fn set(&mut self, kind: &str, value: Value) -> bool {
        if !value.is_object() {
            return false;
        }
        let Some(d) = self.docs.get_mut(kind) else { return false };
        d.value = value;
        d.dirty = Some(Instant::now());
        true
    }

    /// The documents to write now (their last change a moment ago, or every changed one: `all`):
    /// (kind, file, text). They count as written; `written` notes the file's new time.
    pub fn due(&mut self, all: bool) -> Vec<(&'static str, PathBuf, String)> {
        let mut out = Vec::new();
        for (kind, d) in &mut self.docs {
            let Some(since) = d.dirty else { continue };
            if !all && since.elapsed() < SAVE_AFTER {
                continue;
            }
            d.dirty = None;
            out.push((*kind, file_of(&self.dir, kind), serde_json::to_string_pretty(&d.value).unwrap_or_default() + "\n"));
        }
        out
    }

    pub fn written(&mut self, kind: &str, at: Option<SystemTime>) {
        if let Some(d) = self.docs.get_mut(kind) {
            d.stamp = at;
        }
    }

    /// A write failed: tried again a moment later.
    pub fn retry(&mut self, kind: &str) {
        if let Some(d) = self.docs.get_mut(kind) {
            d.dirty.get_or_insert_with(Instant::now);
        }
    }

    /// The file times we know (for looking whether someone else changed a file).
    pub fn stamps(&self) -> Vec<(&'static str, Option<SystemTime>, bool)> {
        self.docs.iter().map(|(k, d)| (*k, d.stamp, d.dirty.is_some())).collect()
    }

    /// A file changed by someone else, read again: true if its content differs from ours.
    pub fn reread(&mut self, kind: &str, value: Value, at: Option<SystemTime>) -> bool {
        let Some(d) = self.docs.get_mut(kind) else { return false };
        d.stamp = at;
        if d.dirty.is_some() || d.value == value {
            return false;
        }
        d.value = value;
        true
    }
}
