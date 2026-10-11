//! Everything painted on the CPU for a layout and its texts: the backdrop (painting.rs) and the
//! text layer (overlay.rs). Fonts and the painting are slow: the setup paints once, later a
//! background thread repaints when a param changes them, and frame() only uploads the result.
//! A new art resolution (pixel size) takes effect when its painting is done, all at once.

use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};

use super::Layout;
use super::overlay::{OverlayCache, OverlayLayers, Texts, paint_overlay};
use super::painting::{Painting, paint_scene};
use crate::scenes::common::qr::Qr;

/// What is painted: the art resolution, the layout and the texts.
#[derive(Clone)]
pub struct ArtSpec {
    pub aw: u32,
    pub ah: u32,
    /// LEDs per art pixel
    pub scale: u32,
    pub layout: Layout,
    pub kicker: String,
    pub line1: String,
    pub line2: String,
    pub subs: String,
    pub url: String,
    pub label: String,
    pub qr: Arc<Qr>,
    pub max_side: u32,
}

/// A painting of a spec: the backdrop if it changed (size or side), the text layer.
pub struct Art {
    pub spec: ArtSpec,
    pub backdrop: Option<Painting>,
    pub overlay: OverlayLayers,
}

/// What the painter keeps between paintings.
#[derive(Default)]
pub struct Caches {
    backdrop: Option<(u32, u32, bool)>,
    overlay: OverlayCache,
}

/// The sublines of the param (main.js: split at |, trimmed, empty ones dropped).
pub fn sub_list(src: &str) -> Vec<&str> {
    src.split('|').map(str::trim).filter(|s| !s.is_empty()).collect()
}

pub fn paint_art(spec: ArtSpec, c: &mut Caches) -> Art {
    let (aw, ah) = (spec.aw as usize, spec.ah as usize);
    // the backdrop: painted once per size and side
    let key = (spec.aw, spec.ah, spec.layout.qr_right);
    let backdrop = (c.backdrop != Some(key)).then(|| {
        c.backdrop = Some(key);
        paint_scene(aw, ah, spec.layout.qr_right)
    });
    let subs = sub_list(&spec.subs);
    let texts = Texts { kicker: &spec.kicker, line1: &spec.line1, line2: &spec.line2, subs: &subs, url: &spec.url, label: &spec.label };
    let overlay = paint_overlay(&mut c.overlay, aw, ah, &spec.layout, &texts, &spec.qr, spec.max_side);
    Art { spec, backdrop, overlay }
}

/// A thread per scene instance that paints what changed (it ends with the instance).
pub struct Painter {
    jobs: Sender<ArtSpec>,
    done: Receiver<Art>,
}

impl Painter {
    /// The thread, with the caches of the setup's painting.
    pub fn new(name: &str, mut caches: Caches) -> Result<Self, String> {
        let (jobs, rx) = channel::<ArtSpec>();
        let (tx, done) = channel::<Art>();
        std::thread::Builder::new()
            .name(format!("{name} paint"))
            .spawn(move || {
                while let Ok(mut spec) = rx.recv() {
                    // only the newest (a glide asks for many)
                    while let Ok(s) = rx.try_recv() {
                        spec = s;
                    }
                    if tx.send(paint_art(spec, &mut caches)).is_err() {
                        return;
                    }
                }
            })
            .map_err(|e| format!("Mal-Thread: {e}"))?;
        Ok(Self { jobs, done })
    }

    pub fn ask(&self, spec: ArtSpec) {
        let _ = self.jobs.send(spec);
    }

    pub fn poll(&self) -> Option<Art> {
        self.done.try_recv().ok()
    }
}
