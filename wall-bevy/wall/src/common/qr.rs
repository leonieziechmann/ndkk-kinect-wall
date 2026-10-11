//! QR codes as the browser scenes' qr.js makes them: Project Nayuki's algorithm (byte mode, the
//! error correction raised while the version stays; the qrcodegen crate is Nayuki's own Rust
//! version), but the mask chosen with qr.js's own penalty. qr.js counts finder-like patterns only
//! inside the code, Nayuki's also against the quiet zone: about a quarter of all texts would get
//! another mask, another picture than in the browser.

use qrcodegen::{Mask, QrCode, QrCodeEcc, QrSegment, Version};

pub struct Qr {
    pub size: usize,
    dark: Vec<bool>,
}

impl Qr {
    /// true = dark module
    pub fn get(&self, x: usize, y: usize) -> bool {
        x < self.size && y < self.size && self.dark.get(y * self.size + x).copied().unwrap_or(false)
    }

    /// An empty code of this size (a fallback that never fails).
    pub fn blank(size: usize) -> Self {
        Self { size, dark: vec![false; size * size] }
    }
}

/// encodeQr(text, ecl, minVersion) of qr.js; None if the text does not fit.
pub fn encode_qr(text: &str, ecl: char, min_version: u8) -> Option<Qr> {
    let ecl = match ecl {
        'L' => QrCodeEcc::Low,
        'Q' => QrCodeEcc::Quartile,
        'H' => QrCodeEcc::High,
        _ => QrCodeEcc::Medium,
    };
    let segs = [QrSegment::make_bytes(text.as_bytes())];
    let min = Version::new(min_version.clamp(1, 40));
    let mut best: Option<(i64, Qr)> = None;
    for m in 0..8u8 {
        let code = QrCode::encode_segments_advanced(&segs, ecl, min, Version::MAX, Some(Mask::new(m)), true).ok()?;
        let size = usize::try_from(code.size()).ok()?;
        let dark: Vec<bool> = (0..size * size).map(|i| code.get_module((i % size) as i32, (i / size) as i32)).collect();
        let score = penalty(&dark, size);
        // the first mask with the lowest penalty, as qr.js
        if best.as_ref().is_none_or(|(b, _)| score < *b) {
            best = Some((score, Qr { size, dark }));
        }
    }
    best.map(|(_, q)| q)
}

/// qr.js penalty (ISO 18004 7.8.3): runs, finder-like patterns, 2x2 blocks, dark balance.
fn penalty(dark: &[bool], size: usize) -> i64 {
    const FINDER: [[bool; 11]; 2] = [
        [true, false, true, true, true, false, true, false, false, false, false],
        [false, false, false, false, true, false, true, true, true, false, true],
    ];
    let at = |x: usize, y: usize| dark.get(y * size + x).copied().unwrap_or(false);
    let mut p = 0i64;
    let mut line = vec![false; size];
    for pass in 0..2 {
        for a in 0..size {
            for (b, v) in line.iter_mut().enumerate() {
                *v = if pass == 1 { at(a, b) } else { at(b, a) };
            }
            let mut run = 1i64;
            for b in 1..=size {
                if b < size && line[b] == line[b - 1] {
                    run += 1;
                } else {
                    if run >= 5 {
                        p += 3 + run - 5;
                    }
                    run = 1;
                }
            }
            // every occurrence, overlapping ones too (indexOf from k + 1)
            for pat in &FINDER {
                p += 40 * line.windows(11).filter(|w| *w == pat).count() as i64;
            }
        }
    }
    for y in 0..size.saturating_sub(1) {
        for x in 0..size - 1 {
            let c = at(x, y);
            if c == at(x + 1, y) && c == at(x, y + 1) && c == at(x + 1, y + 1) {
                p += 3;
            }
        }
    }
    let n = dark.iter().filter(|d| **d).count() as i64;
    let total = (size * size).max(1) as i64;
    p += (((n * 20 - total * 10).abs() + total - 1) / total - 1) * 10;
    p
}
