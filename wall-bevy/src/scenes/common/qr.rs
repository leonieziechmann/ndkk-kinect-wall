//! QR codes (the browser scenes' qr.js: Project Nayuki's algorithm, byte mode, the error correction
//! raised while the version stays). The qrcodegen crate is Nayuki's own Rust version: the same codes.

use qrcodegen::{QrCode, QrCodeEcc, QrSegment, Version};

pub struct Qr {
    pub size: usize,
    dark: Vec<bool>,
}

impl Qr {
    /// true = dark module
    pub fn get(&self, x: usize, y: usize) -> bool {
        x < self.size && y < self.size && self.dark[y * self.size + x]
    }
}

/// encodeQr(text, ecl, minVersion) of qr.js
pub fn encode_qr(text: &str, ecl: char, min_version: u8) -> Option<Qr> {
    let ecl = match ecl {
        'L' => QrCodeEcc::Low,
        'Q' => QrCodeEcc::Quartile,
        'H' => QrCodeEcc::High,
        _ => QrCodeEcc::Medium,
    };
    let segs = vec![QrSegment::make_bytes(text.as_bytes())];
    let code = QrCode::encode_segments_advanced(&segs, ecl, Version::new(min_version.clamp(1, 40)), Version::MAX, None, true).ok()?;
    let size = code.size() as usize;
    let mut dark = vec![false; size * size];
    for y in 0..size {
        for x in 0..size {
            dark[y * size + x] = code.get_module(x as i32, y as i32);
        }
    }
    Some(Qr { size, dark })
}
