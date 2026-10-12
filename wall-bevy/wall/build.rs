//! WALL_BUILD_ID: a hash of this crate's sources, the compiler, target, profile and features. A scene
//! library carries the id it was built against; the output loads only scenes with its own id (a
//! scene built against another build of the framework would not fit it).

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

fn walk(dir: &Path, files: &mut Vec<std::path::PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, files);
        } else {
            files.push(p);
        }
    }
}

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    walk(&root.join("src"), &mut files);
    files.push(root.join("Cargo.toml"));
    files.sort();
    let mut h = DefaultHasher::new();
    for f in &files {
        f.strip_prefix(root).unwrap_or(f).hash(&mut h);
        std::fs::read(f).unwrap_or_default().hash(&mut h);
    }
    let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".into());
    let version = std::process::Command::new(rustc).arg("-vV").output().map(|o| o.stdout).unwrap_or_default();
    version.hash(&mut h);
    let mut env: Vec<(String, String)> = std::env::vars().filter(|(k, _)| k.starts_with("CARGO_FEATURE_") || k == "TARGET" || k == "PROFILE" || k == "OPT_LEVEL").collect();
    env.sort();
    env.hash(&mut h);
    println!("cargo:rustc-env=WALL_BUILD_ID={:016x}", h.finish());
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");
}
