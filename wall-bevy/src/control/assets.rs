//! The control center's page (wall-bevy/control/), built into the program: nothing to install, it
//! comes with the output. With --control-dir the files are read from that folder instead (for work
//! on the page: reload it in the browser, no new build).

use std::borrow::Cow;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::Path;

const FILES: &[(&str, &[u8])] = &[
    ("index.html", include_bytes!("../../control/index.html")),
    ("app.js", include_bytes!("../../control/app.js")),
    ("projection.js", include_bytes!("../../control/projection.js")),
    ("wall.js", include_bytes!("../../control/wall.js")),
    ("show.js", include_bytes!("../../control/show.js")),
    ("params.js", include_bytes!("../../control/params.js")),
    ("gui.js", include_bytes!("../../control/gui.js")),
    ("link.js", include_bytes!("../../control/link.js")),
    ("style.css", include_bytes!("../../control/style.css")),
    ("icon.svg", include_bytes!("../../control/icon.svg")),
];

/// A file of the page by name ("app.js"), from the folder or built in.
pub fn get(name: &str, dir: Option<&Path>) -> Option<Cow<'static, [u8]>> {
    if !FILES.iter().any(|(n, _)| *n == name) {
        return None;
    }
    if let Some(d) = dir
        && let Ok(b) = std::fs::read(d.join(name))
    {
        return Some(Cow::Owned(b));
    }
    FILES.iter().find(|(n, _)| *n == name).map(|(_, b)| Cow::Borrowed(*b))
}

/// A tag for the browser's cache: the same as long as the content is.
pub fn etag(body: &[u8]) -> String {
    let mut h = DefaultHasher::new();
    body.hash(&mut h);
    format!("\"{:016x}\"", h.finish())
}
