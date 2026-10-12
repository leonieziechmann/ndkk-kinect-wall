//! The scene libraries. Every scene is a crate of its own (scenes/*), built into a dynamic library
//! next to the output (wall_scene_<name>.dll, libwall_scene_<name>.so). All of them are loaded at
//! the start; a thread watches the files and loads a library again as soon as it is built anew, so a
//! scene is developed while the output runs (output.rs swaps the running instance).
//!
//! A library is loaded from a copy: the original stays free for the next build (Windows locks a
//! loaded DLL). It is never unloaded: an instance, a param function or a sound of it may still be in
//! use (a reload during development costs a few MB of address space).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use crossbeam_channel::{Receiver, Sender};
use wall::{SceneDef, SceneLibrary};

const PREFIX: &str = if cfg!(windows) { "wall_scene_" } else { "libwall_scene_" };

/// What a (re)load brought: the library file and its scenes, or why it could not be used.
pub struct Update {
    pub file: PathBuf,
    pub result: Result<Vec<&'static SceneDef>, String>,
    /// ms the load took (copy, load, entry)
    pub ms: f64,
}

/// The directory of the scene libraries: the output's own.
pub fn dir() -> PathBuf {
    std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_else(|| PathBuf::from("."))
}

/// The scene library files in `dir`, sorted.
fn files(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(PREFIX) && n.ends_with(std::env::consts::DLL_SUFFIX)))
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

fn stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let m = std::fs::metadata(path).ok()?;
    Some((m.modified().ok()?, m.len()))
}

static COPIES: AtomicU64 = AtomicU64::new(0);

/// Loads a scene library (from a copy). Err: why not; nothing of it is used then.
pub fn load(path: &Path) -> Result<Vec<&'static SceneDef>, String> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_string();
    let copies = copies_root().join(std::process::id().to_string());
    std::fs::create_dir_all(&copies).map_err(|e| format!("{name}: {e}"))?;
    let n = COPIES.fetch_add(1, Ordering::Relaxed);
    let stem = name.strip_suffix(std::env::consts::DLL_SUFFIX).unwrap_or(&name);
    let copy = copies.join(format!("{stem}-{n}{}", std::env::consts::DLL_SUFFIX));
    std::fs::copy(path, &copy).map_err(|e| format!("{name}: nicht kopiert ({e})"))?;
    let lib = open(&copy).map_err(|e| format!("{name}: nicht geladen ({e}); alles neu bauen (cargo build --release)"))?;
    let id = {
        // SAFETY: the exported fn of export_scenes! (fn() -> &'static str)
        let f: libloading::Symbol<fn() -> &'static str> = unsafe { lib.get(b"wall_scene_build_id") }.map_err(|_| format!("{name}: keine Szenen-Bibliothek (wall::export_scenes! fehlt)"))?;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(*f)).map_err(|_| format!("{name}: Absturz beim Lesen der Build-ID"))?
    };
    if id != wall::build_id() {
        // stays loaded (unloading Rust code is not safe), but nothing of it is called
        std::mem::forget(lib);
        return Err(format!("{name}: gegen einen anderen Stand des Frameworks gebaut ({id} statt {}); das Framework hat sich geändert: wall-bevy neu starten (cargo build --release)", wall::build_id()));
    }
    let exported: SceneLibrary = {
        // SAFETY: as above; same framework build, so SceneLibrary is the same type on both sides
        let f: libloading::Symbol<fn() -> SceneLibrary> = unsafe { lib.get(b"wall_scene_library") }.map_err(|_| format!("{name}: wall_scene_library fehlt"))?;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(*f)).map_err(|_| format!("{name}: Absturz beim Lesen der Szenen"))?
    };
    // never unloaded (see the module doc)
    std::mem::forget(lib);
    Ok(exported.scenes)
}

/// Opens a library with every symbol bound at once: one the running framework lacks (a library built
/// against another state of it) fails here, safely, not at its first call (Windows always binds so).
fn open(path: &Path) -> Result<libloading::Library, libloading::Error> {
    // SAFETY (both): a scene library is built in this workspace, with this compiler, against the
    // framework this output links (its build id is checked before its scenes are asked for); loading
    // it runs no code of it but Rust's (empty) initializers
    #[cfg(unix)]
    {
        use libloading::os::unix::{Library, RTLD_LOCAL, RTLD_NOW};
        unsafe { Library::open(Some(path), RTLD_NOW | RTLD_LOCAL) }.map(Into::into)
    }
    #[cfg(not(unix))]
    {
        unsafe { libloading::Library::new(path) }
    }
}

/// The folder of the loaded copies (one per process).
fn copies_root() -> PathBuf {
    std::env::temp_dir().join("wall-bevy-scenes")
}

/// Copies left by earlier runs (Windows keeps the ones of a running output locked: they stay).
fn clean_old_copies() {
    let me = std::process::id().to_string();
    for e in std::fs::read_dir(copies_root()).into_iter().flatten().flatten() {
        if e.file_name().to_str() != Some(me.as_str()) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// Every scene library in the output's directory, loaded; the errors of the ones that failed.
pub fn load_all() -> (Vec<&'static SceneDef>, Vec<String>, HashMap<PathBuf, (SystemTime, u64)>) {
    clean_old_copies();
    let mut defs: Vec<&'static SceneDef> = Vec::new();
    let mut errors = Vec::new();
    let mut seen = HashMap::new();
    for f in files(&dir()) {
        if let Some(s) = stamp(&f) {
            seen.insert(f.clone(), s);
        }
        match load(&f) {
            Ok(v) => defs.extend(v),
            Err(e) => errors.push(e),
        }
    }
    defs.sort_by_key(|d| d.name);
    defs.dedup_by_key(|d| d.name);
    (defs, errors, seen)
}

/// Watches the scene libraries: a new or rebuilt one is loaded (when its file has stopped changing)
/// and sent to the output.
pub fn watch(mut seen: HashMap<PathBuf, (SystemTime, u64)>) -> Receiver<Update> {
    let (tx, rx) = crossbeam_channel::unbounded();
    let _ = std::thread::Builder::new().name("wall-scenes".into()).spawn(move || watcher(&mut seen, &tx));
    rx
}

fn watcher(seen: &mut HashMap<PathBuf, (SystemTime, u64)>, tx: &Sender<Update>) {
    let dir = dir();
    // a file seen changed once: loaded when it is the same on the next look (written completely)
    let mut settling: HashMap<PathBuf, (SystemTime, u64)> = HashMap::new();
    loop {
        std::thread::sleep(Duration::from_millis(150));
        for f in files(&dir) {
            let Some(s) = stamp(&f) else { continue };
            if seen.get(&f) == Some(&s) {
                settling.remove(&f);
                continue;
            }
            if settling.get(&f) != Some(&s) {
                settling.insert(f.clone(), s);
                continue;
            }
            settling.remove(&f);
            seen.insert(f.clone(), s);
            let t0 = std::time::Instant::now();
            let result = load(&f);
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            if tx.send(Update { file: f, result, ms }).is_err() {
                return;
            }
        }
    }
}

/// Every scene's declaration as the browser scenes write theirs (wall-bevy --list-scenes): to
/// check a port against its browser scene.
/// Every scene as the control center lists it: name, title, params (in their order, with ranges and
/// options), what it asks of the projection, its persons options, streams, render cap.
pub fn catalog(defs: &[&'static SceneDef]) -> serde_json::Value {
    use serde_json::json;
    use wall::params::Kind;
    let list: Vec<serde_json::Value> = defs
        .iter()
        .map(|d| {
            let specs = (d.params)();
            let params = wall::params::Params::resolve(std::sync::Arc::new(specs.clone()), &json!({}));
            let persons = (d.persons)(&params).map(|o| json!({ "delay": o.delay, "live": o.live, "skeleton": o.skeleton }));
            let list: Vec<serde_json::Value> = specs
                .iter()
                .map(|s| {
                    let mut o = json!({ "key": s.key, "value": s.default, "label": s.label });
                    match &s.kind {
                        Kind::Number { min, max, step } => {
                            o["min"] = json!(min);
                            o["max"] = json!(max);
                            o["step"] = json!(step);
                        }
                        Kind::Select(opts) => {
                            // labels of their own: { label: value }, else the values
                            let plain = opts.iter().all(|(l, v)| v.as_str() == Some(l.as_str()));
                            o["options"] = if plain {
                                serde_json::Value::Array(opts.iter().map(|(_, v)| v.clone()).collect())
                            } else {
                                serde_json::Value::Object(opts.iter().map(|(l, v)| (l.clone(), v.clone())).collect())
                            };
                        }
                        Kind::Bool | Kind::Color | Kind::Text => {}
                    }
                    o
                })
                .collect();
            json!({
                "name": d.name,
                "title": d.title,
                "params": list,
                "projection": (d.projection)(),
                "persons": persons,
                "streams": (d.streams)(&params),
                "maxFps": (d.max_fps)(&params),
            })
        })
        .collect();
    serde_json::Value::Array(list)
}

/// The catalog as text (--list-scenes).
pub fn declarations(defs: &[&'static SceneDef]) -> String {
    serde_json::to_string_pretty(&catalog(defs)).unwrap_or_default()
}
