//! A small persistent key-value store for the scenes: the browser's localStorage (per dev server,
//! i.e. per checkout). Kept in web/.cache/wall/bevy-store.json; read once, written by a thread of
//! its own a moment after a change (a scene's frame never waits for the disk).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender};
use parking_lot::Mutex;

struct Store {
    values: Mutex<BTreeMap<String, String>>,
    dirty: Sender<()>,
}

static STORE: OnceLock<Store> = OnceLock::new();

/// Opens the store (once, at the start of the output); None: only in memory (tests).
pub fn init(path: Option<PathBuf>) {
    let values: BTreeMap<String, String> = path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let (tx, rx) = crossbeam_channel::bounded(1);
    if STORE.set(Store { values: Mutex::new(values), dirty: tx }).is_ok()
        && let Some(path) = path
    {
        let _ = std::thread::Builder::new().name("wall-store".into()).spawn(move || writer(path, rx));
    }
}

/// localStorage.getItem(key)
pub fn get(key: &str) -> Option<String> {
    STORE.get()?.values.lock().get(key).cloned()
}

/// localStorage.setItem(key, value); kept for this run even if the store could not be opened
pub fn set(key: &str, value: &str) {
    let Some(s) = STORE.get() else { return };
    let changed = s.values.lock().insert(key.to_string(), value.to_string()).as_deref() != Some(value);
    if changed {
        let _ = s.dirty.try_send(());
    }
}

fn writer(path: PathBuf, dirty: Receiver<()>) {
    while dirty.recv().is_ok() {
        // a burst of changes: one write
        std::thread::sleep(Duration::from_millis(500));
        while dirty.try_recv().is_ok() {}
        let Some(s) = STORE.get() else { return };
        let text = serde_json::to_string_pretty(&*s.values.lock()).unwrap_or_default();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // whole or not at all: a temporary file, then renamed over the old one
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() && std::fs::rename(&tmp, &path).is_err() {
            bevy::log::warn!("Speicher {}: nicht geschrieben", path.display());
        }
    }
}
