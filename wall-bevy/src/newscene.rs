//! --new-scene NAME: a new scene crate from the template (scenes/NAME: Cargo.toml and src/lib.rs, a
//! sketch that already draws the persons), in the workspace this output was built from (or the one
//! --watch names). The workspace takes every folder of scenes/ as a member: no other file changes.

use std::path::Path;

const CARGO_TOML: &str = r#"[package]
name = "wall-scene-{name}"
version = "0.1.0"
edition = "2024"
publish = false

[lib]
crate-type = ["dylib"]

[dependencies]
wall.workspace = true

[lints]
workspace = true
"#;

const LIB_RS: &str = r##"//! {name}: what the scene shows (a sentence or two).

use wall::prelude::*;

wall::scene! {
    name: "{name}",
    title: "{title}",
    // what the control center can change (wall::params: num, boolean, color, select, text)
    params: [
        color("farbe", "#5ad1ff", "Farbe"),
        num("tempo", 1.0, 0.0, 3.0, 0.05, "Tempo"),
    ],
    // the persons as the tracking sees them now (live) or exactly, a little later (exact)
    persons: live,
    sketch: {type},
}

/// The scene's state: made in setup(), changed and drawn in frame().
struct {type} {
    sparks: Particles,
}

impl Sketch for {type} {
    /// Once, in a worker thread (the show keeps playing): images, sounds, state.
    fn setup(_s: &mut Setup) -> Result<Self, String> {
        Ok({type} { sparks: Particles::new(120.0) })
    }

    /// Every frame: f.w() × f.h() LED pixels, f.t() s since the start, f.bodies() the persons.
    fn frame(&mut self, f: &mut Frame) {
        let (w, h, t, dt) = (f.w(), f.h(), f.t(), f.dt());
        let tint = f.color("farbe");
        f.clear(hex("#05060d"));

        // something that moves while nobody is there
        let pulse = (t * f.num("tempo") * 2.0).sin() * 0.5 + 0.5;
        f.circle(w / 2.0, h / 2.0, 30.0 + 20.0 * pulse, Paint::fill(tint.alpha(0.25)).glow(40.0).add());

        // the persons: a glowing skeleton, sparks from raised hands
        for b in f.bodies().iter() {
            f.skeleton(b, 4.0);
            if b.hand_up(0.0) {
                for hand in b.hands().into_iter().flatten() {
                    self.sparks.spray(hand, 2, vec2(0.0, -100.0), 0.6, 1.0, tint);
                }
            }
        }
        self.sparks.draw(f, dt);

        f.text("{title}", w / 2.0, 24.0, &Text::new(20.0).bold().color(tint).glow(8.0));
    }
}
"##;

/// Makes scenes/NAME in `root`; the lines to print (what was made, how to go on).
pub fn create(root: &Path, name: &str) -> Result<String, String> {
    let ok = name.len() >= 2
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && !name.ends_with('-')
        && !name.contains("--")
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !ok {
        return Err(format!("--new-scene {name}: Name aus a-z, 0-9 und -, mit einem Buchstaben am Anfang (wie die Ordner in scenes/)"));
    }
    let scenes = root.join("scenes");
    if !root.join("Cargo.toml").is_file() || !scenes.is_dir() {
        return Err(format!("{} ist nicht der Workspace der Ausgabe (wall-bevy/ mit scenes/); --watch DIR angeben", root.display()));
    }
    let dir = scenes.join(name);
    if dir.exists() {
        return Err(format!("{} gibt es schon", dir.display()));
    }
    // a scene of this name in another crate (several scenes per crate: shader-scenes)
    let needle = format!("\"{name}\"");
    if let Some(other) = std::fs::read_dir(&scenes).into_iter().flatten().flatten().find(|e| {
        let lib = e.path().join("src").join("lib.rs");
        std::fs::read_to_string(lib).is_ok_and(|s| s.lines().any(|l| l.trim_start().starts_with("name:") && l.contains(&needle)))
    }) {
        return Err(format!("eine Szene \"{name}\" gibt es schon in {}", other.path().display()));
    }
    let title = title_of(name);
    let ty = type_of(name);
    let fill = |s: &str| s.replace("{name}", name).replace("{title}", &title).replace("{type}", &ty);
    std::fs::create_dir_all(dir.join("src")).map_err(|e| format!("{}: {e}", dir.display()))?;
    std::fs::write(dir.join("Cargo.toml"), fill(CARGO_TOML)).map_err(|e| format!("Cargo.toml: {e}"))?;
    std::fs::write(dir.join("src").join("lib.rs"), fill(LIB_RS)).map_err(|e| format!("lib.rs: {e}"))?;
    let lib = dir.join("src").join("lib.rs");
    Ok(format!(
        "neue Szene {name}: {}\n\n\
         ansehen und dabei entwickeln (baut beim Speichern neu und tauscht sie im laufenden Bild aus):\n  \
         wall-bevy --watch --scene {name}\n\
         oder einmal bauen (im Workspace {}):\n  \
         cargo build --release\n\
         Wie eine Szene aussieht: SCENES.md",
        lib.display(),
        root.display()
    ))
}

/// "my-scene" -> "My Scene"
fn title_of(name: &str) -> String {
    name.split('-').filter(|w| !w.is_empty()).map(capital).collect::<Vec<_>>().join(" ")
}

/// "my-scene" -> "MyScene"
fn type_of(name: &str) -> String {
    name.split('-').map(capital).collect()
}

fn capital(w: &str) -> String {
    let mut c = w.chars();
    c.next().map(|f| f.to_ascii_uppercase().to_string() + c.as_str()).unwrap_or_default()
}
