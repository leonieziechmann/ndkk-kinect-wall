//! Presets: the output ready for another place than the LED wall, without setting anything up.
//! `wall-bevy --preset NAME` keeps its documents in a data folder of their own (wall-bevy/data-NAME
//! of the main checkout, unless --data or KINECT_WALL_DIR say otherwise) and fills in what that
//! folder does not have yet from the preset (presets/NAME/*.json, built into the program). What is
//! changed in the control center afterwards stays; the LED wall's own folder is never touched.

use std::path::Path;

#[derive(Debug)]
pub struct Preset {
    pub name: &'static str,
    pub title: &'static str,
    /// file name in the data folder, its content
    pub docs: &'static [(&'static str, &'static str)],
}

pub const PRESETS: &[Preset] = &[Preset {
    name: "beamer",
    title: "Beamer 16:9 (960 × 540, 2× auf Full HD), Spielmodus Fruit Ninja",
    docs: &[
        ("setup.json", include_str!("../presets/beamer/setup.json")),
        ("projection.json", include_str!("../presets/beamer/projection.json")),
        ("show.json", include_str!("../presets/beamer/show.json")),
    ],
}];

pub fn find(name: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.name == name)
}

/// The names, for messages: "beamer, …"
pub fn names() -> String {
    PRESETS.iter().map(|p| p.name).collect::<Vec<_>>().join(", ")
}

/// Writes the preset's documents that `dir` does not have yet; the files written.
pub fn seed(p: &Preset, dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if std::fs::create_dir_all(dir).is_err() {
        return out;
    }
    for (file, text) in p.docs {
        let path = dir.join(file);
        if path.exists() {
            continue;
        }
        if crate::control::write_atomic(&path, text).is_ok() {
            out.push((*file).to_string());
        }
    }
    out
}

/// The preset's version of a document (setup, projection, show), for "Preset wiederherstellen".
pub fn doc(p: &Preset, kind: &str) -> Option<serde_json::Value> {
    let file = format!("{kind}.json");
    p.docs.iter().find(|(f, _)| *f == file).and_then(|(_, text)| serde_json::from_str(text).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_parse() {
        for p in PRESETS {
            for (file, text) in p.docs {
                let v: Result<serde_json::Value, _> = serde_json::from_str(text);
                assert!(v.is_ok_and(|v| v.is_object()), "{}/{file}", p.name);
            }
            let show = crate::show::normalize_show(&doc(p, "show").unwrap_or_default());
            assert!(show.single_entry().is_some(), "{}: show.single", p.name);
        }
    }
}
