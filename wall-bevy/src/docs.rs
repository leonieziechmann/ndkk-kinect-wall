//! The wall's documents on disk (as the dev server keeps them, web/tools/vite-plugin-kinect.js):
//! setup.json and projection.json of the main checkout, show.json of this checkout. A thread
//! watches them (once a second) and hands changed ones to the main thread already parsed.

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use crossbeam_channel::{Receiver, Sender};
use serde_json::Value;

pub struct Docs {
    pub changed: Receiver<(String, Value)>,
    reload: Sender<String>,
}

impl Docs {
    pub fn start(files: Vec<(String, PathBuf)>) -> Self {
        let (tx, rx) = crossbeam_channel::bounded(64);
        let (rtx, rrx) = crossbeam_channel::unbounded::<String>();
        let _ = std::thread::Builder::new().name("wall-docs".into()).spawn(move || run(files, tx, rrx));
        Self { changed: rx, reload: rtx }
    }

    /// Reads `kind` again now (the bus said it changed).
    pub fn reload(&self, kind: &str) {
        let _ = self.reload.send(kind.to_string());
    }
}

fn run(files: Vec<(String, PathBuf)>, tx: Sender<(String, Value)>, reload: Receiver<String>) {
    let mut stamps: Vec<Option<SystemTime>> = vec![None; files.len()];
    let mut first = true;
    loop {
        let mut force: Vec<String> = Vec::new();
        while let Ok(k) = reload.try_recv() {
            force.push(k);
        }
        for (i, (kind, path)) in files.iter().enumerate() {
            let m = std::fs::metadata(path).and_then(|m| m.modified()).ok();
            if !first && m == stamps[i] && !force.contains(kind) {
                continue;
            }
            stamps[i] = m;
            // missing or broken: an empty document (the defaults apply)
            let doc = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(Value::is_object).unwrap_or(Value::Null);
            if tx.send((kind.clone(), doc)).is_err() {
                return;
            }
        }
        first = false;
        // wakes early for a reload request
        if let Ok(k) = reload.recv_timeout(Duration::from_secs(1)) {
            let _ = k;
            // handled in the next round (also forced)
            let mut again = vec![k];
            while let Ok(k) = reload.try_recv() {
                again.push(k);
            }
            for (i, (kind, path)) in files.iter().enumerate() {
                if !again.contains(kind) {
                    continue;
                }
                stamps[i] = std::fs::metadata(path).and_then(|m| m.modified()).ok();
                let doc = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(Value::is_object).unwrap_or(Value::Null);
                if tx.send((kind.clone(), doc)).is_err() {
                    return;
                }
            }
        }
    }
}
