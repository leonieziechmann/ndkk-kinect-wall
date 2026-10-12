//! Windows: the programs link Rust's standard library dynamically (.cargo/config.toml: one std for
//! the output and every scene library). Linux finds it through the rpath; Windows looks next to the
//! exe, so std-*.dll is copied there (with the gnu toolchain also the libgcc_s_seh-1.dll it needs).

use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.contains("windows") {
        return;
    }
    // OUT_DIR is <target dir>/[<triple>/]<profile>/build/<package>-<hash>/out: the exe is 3 up
    let Some(exe_dir) = std::env::var_os("OUT_DIR").map(PathBuf::from).and_then(|o| o.ancestors().nth(3).map(Path::to_path_buf)) else {
        return;
    };
    let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".into());
    let sysroot = Command::new(&rustc).args(["--print", "sysroot"]).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    let lib = Path::new(&sysroot).join("lib").join("rustlib").join(&target).join("lib");
    let mut copied = false;
    for e in std::fs::read_dir(&lib).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with("std-") && name.ends_with(".dll") {
            copied |= copy(&e.path(), &exe_dir.join(&name));
        }
    }
    if !copied {
        println!("cargo:warning=std-*.dll nicht gefunden in {}: wall-bevy.exe startet so nicht", lib.display());
    }
    if target.ends_with("-gnu") {
        // the gnu std links the shared unwinder of MinGW's gcc
        let dll = "libgcc_s_seh-1.dll";
        let gcc = std::env::var("CC").unwrap_or_else(|_| "x86_64-w64-mingw32-gcc".into());
        let found = [lib.parent().map(|l| l.join("bin").join(dll)), lib.parent().map(|l| l.join("bin").join("self-contained").join(dll))]
            .into_iter()
            .flatten()
            .chain([gcc.as_str(), "gcc"].iter().filter_map(|cc| {
                let out = Command::new(cc).arg(format!("-print-file-name={dll}")).output().ok()?;
                let p = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
                p.is_absolute().then_some(p)
            }))
            .find(|p| p.is_file());
        match found {
            Some(p) => {
                copy(&p, &exe_dir.join(dll));
            }
            None => println!("cargo:warning={dll} nicht gefunden (MinGW-gcc im PATH?): wall-bevy.exe braucht ihn neben sich"),
        }
    }
}

/// Copies when the target is missing or differs in size; true: it is there now.
fn copy(from: &Path, to: &Path) -> bool {
    let same = std::fs::metadata(from).ok().map(|m| m.len()) == std::fs::metadata(to).ok().map(|m| m.len());
    same || std::fs::copy(from, to).is_ok()
}
