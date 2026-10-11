//! --watch: the output builds its scenes itself. A thread watches the sources of the scenes
//! (scenes/*) and, a moment after a change, runs the build of the whole workspace (cargo, at a low
//! priority, with the output's own target directory and profile: the libraries must fit the running
//! output); scenes.rs then swaps the rebuilt scene libraries in. A change to the framework (wall/)
//! or the output (src/) is not built while it runs: those need a restart, and the build says so.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

use crossbeam_channel::{Receiver, Sender};

/// What the builder reports to the output.
pub enum DevEvent {
    /// a build started: the changed files, when the newest of them was saved (None: the start build)
    Started(Vec<String>, Option<SystemTime>),
    /// a build ended: ok, seconds, the compiler's errors (if any)
    Done { ok: bool, secs: f64, errors: String },
    /// the framework or the output changed: a restart is needed
    Restart(Vec<String>),
}

/// Starts the builder for the workspace `root` (wall-bevy/).
pub fn start(root: PathBuf) -> Receiver<DevEvent> {
    let (tx, rx) = crossbeam_channel::unbounded();
    let _ = std::thread::Builder::new().name("wall-dev".into()).spawn(move || run(&root, &tx));
    rx
}

/// The workspace this output was built from (wall-bevy/), if it is still there.
pub fn default_root() -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.join("Cargo.toml").exists().then_some(p)
}

fn snapshot(root: &Path, dirs: &[&str]) -> HashMap<PathBuf, SystemTime> {
    let mut out = HashMap::new();
    for d in dirs {
        walk(&root.join(d), &mut out);
    }
    out
}

fn walk(dir: &Path, out: &mut HashMap<PathBuf, SystemTime>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || name == "target" {
            continue;
        }
        if p.is_dir() {
            walk(&p, out);
        } else if ["rs", "wgsl", "toml", "png", "json", "ttf", "otf"].iter().any(|x| name.ends_with(&format!(".{x}")))
            && let Ok(t) = e.metadata().and_then(|m| m.modified())
        {
            out.insert(p, t);
        }
    }
}

fn changed(old: &HashMap<PathBuf, SystemTime>, new: &HashMap<PathBuf, SystemTime>, root: &Path) -> Vec<String> {
    let mut v: Vec<String> = new
        .iter()
        .filter(|(p, t)| old.get(*p) != Some(*t))
        .map(|(p, _)| p.clone())
        .chain(old.keys().filter(|p| !new.contains_key(*p)).cloned())
        .map(|p| p.strip_prefix(root).unwrap_or(&p).display().to_string())
        .collect();
    v.sort();
    v
}

/// The cargo invocation that builds the libraries for this output: its target dir and profile.
fn cargo(root: &Path) -> Command {
    let exe_dir = crate::scenes::dir();
    let profile = exe_dir.file_name().and_then(|n| n.to_str()).unwrap_or("debug").to_string();
    let mut c = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()));
    c.current_dir(root).arg("build").arg("--message-format=short");
    match profile.as_str() {
        "release" => {
            c.arg("--release");
        }
        "debug" => {}
        other => {
            c.args(["--profile", other]);
        }
    }
    if let Some(target_dir) = exe_dir.parent() {
        c.arg("--target-dir").arg(target_dir);
    }
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    low_priority(&mut c);
    c
}

#[cfg(windows)]
fn low_priority(c: &mut Command) {
    use std::os::windows::process::CommandExt;
    // BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW: the show keeps the CPU it needs
    c.creation_flags(0x0000_4000 | 0x0800_0000);
}

#[cfg(not(windows))]
fn low_priority(c: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: setpriority is async-signal-safe; it only lowers this child's priority
    unsafe {
        c.pre_exec(|| {
            unsafe extern "C" {
                fn setpriority(which: i32, who: u32, prio: i32) -> i32;
            }
            setpriority(0, 0, 10);
            Ok(())
        });
    }
}

fn build(root: &Path) -> (bool, f64, String) {
    let t0 = Instant::now();
    let out = cargo(root).output();
    let secs = t0.elapsed().as_secs_f64();
    match out {
        Ok(o) => {
            let text = String::from_utf8_lossy(&o.stderr).to_string();
            // the errors and warnings, not cargo's progress lines
            let errors: Vec<&str> = text.lines().filter(|l| !l.trim_start().starts_with("Compiling") && !l.trim_start().starts_with("Finished") && !l.trim_start().starts_with("Blocking")).collect();
            (o.status.success(), secs, errors.join("\n"))
        }
        Err(e) => (false, secs, format!("cargo startet nicht: {e}")),
    }
}

/// Is this a file of the framework or the output (a restart is needed for it)?
fn is_core(file: &str) -> bool {
    file.starts_with("wall") || file.starts_with("src")
}

/// The framework's and the output's files changed since this output was built (newer than its exe).
fn core_newer_than_exe(root: &Path, files: &HashMap<PathBuf, SystemTime>) -> Vec<String> {
    let Some(built) = std::env::current_exe().ok().and_then(|p| std::fs::metadata(p).ok()).and_then(|m| m.modified().ok()) else { return Vec::new() };
    let mut v: Vec<String> = files
        .iter()
        .filter(|(_, t)| **t > built)
        .map(|(p, _)| p.strip_prefix(root).unwrap_or(p).display().to_string())
        .filter(|f| is_core(f))
        .collect();
    v.sort();
    v
}

fn now_saved(root: &Path, file: &str) -> Option<SystemTime> {
    std::fs::metadata(root.join(file)).ok()?.modified().ok()
}

/// Builds and reports it; false: the output is gone.
fn build_and_report(root: &Path, tx: &Sender<DevEvent>, files: Vec<String>, saved: Option<SystemTime>) -> bool {
    if tx.send(DevEvent::Started(files, saved)).is_err() {
        return false;
    }
    let (ok, secs, errors) = build(root);
    tx.send(DevEvent::Done { ok, secs, errors }).is_ok()
}

fn run(root: &Path, tx: &Sender<DevEvent>) {
    let dirs = ["scenes", "wall", "src"];
    let mut last = snapshot(root, &dirs);
    // the framework or the output changed since this output was built: no scene is built until it
    // is restarted (the libraries would not fit it; on Windows its loaded framework blocks the build)
    let mut core = core_newer_than_exe(root, &last);
    if core.is_empty() {
        // what changed while no output ran (a new scene, an edit) is built now
        if !build_and_report(root, tx, vec!["(Start)".into()], None) {
            return;
        }
    } else if tx.send(DevEvent::Restart(core.clone())).is_err() {
        return;
    }
    loop {
        std::thread::sleep(Duration::from_millis(200));
        let now = snapshot(root, &dirs);
        if now == last {
            continue;
        }
        // an editor writes a file in several steps: wait until it stays
        std::thread::sleep(Duration::from_millis(120));
        let now = snapshot(root, &dirs);
        let files = changed(&last, &now, root);
        last = now;
        if files.is_empty() {
            continue;
        }
        core.extend(files.iter().filter(|f| is_core(f)).cloned());
        core.sort();
        core.dedup();
        if !core.is_empty() {
            if tx.send(DevEvent::Restart(core.clone())).is_err() {
                return;
            }
            continue;
        }
        // a change while it builds is built again at the next look
        let saved = files.iter().filter_map(|f| now_saved(root, f)).max();
        if !build_and_report(root, tx, files, saved) {
            return;
        }
    }
}
