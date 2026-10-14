//! Parsing the device's answers (and producing them, for the simulated device). Every parser
//! checks lengths and plausibility and returns an error instead of reading out of bounds.

use super::bytes::{PutLe, f32_at, u16_at, u32_at};
use crate::camera::{ColorCameraParams, IrCameraParams};
use crate::consts::PIXELS;
use crate::error::{Error, Result};

/// Bytes of the depth camera parameter page libfreenect2 reads (23 floats).
pub const DEPTH_PARAMS_LEN: usize = 23 * 4;
/// Offset of the first P0 table: an 8-word header and one u16 before the table.
pub const P0_TABLE0_OFFSET: usize = 32 + 2;
/// Distance between the starts of two P0 tables (table, then two u16 between the tables).
pub const P0_TABLE_STRIDE: usize = PIXELS * 2 + 4;
/// Shortest P0 response that holds all three tables.
pub const P0_TABLES_MIN_LEN: usize = P0_TABLE0_OFFSET + 2 * P0_TABLE_STRIDE + PIXELS * 2;
/// The color parameters up to the end of the mapping polynomials.
pub const COLOR_PARAMS_MIN_LEN: usize = 1 + 25 * 4;

/// Main firmware version ("major.minor.revision.build" of entry 3), or "" if the answer is short.
pub fn parse_firmware(b: &[u8]) -> String {
    let entry = |i: usize| -> Option<(u32, u32, u32)> { Some((u32_at(b, i * 16)?, u32_at(b, i * 16 + 4)?, u32_at(b, i * 16 + 8)?)) };
    match entry(3) {
        Some((maj_min, rev, build)) => format!("{}.{}.{}.{}", maj_min >> 16, maj_min & 0xffff, rev, build),
        None => String::new(),
    }
}

/// All firmware entries (for diagnostics).
pub fn parse_firmware_entries(b: &[u8]) -> Vec<String> {
    (0..7)
        .filter_map(|i| {
            let maj_min = u32_at(b, i * 16)?;
            Some(format!("{}.{}.{}.{}", maj_min >> 16, maj_min & 0xffff, u32_at(b, i * 16 + 4)?, u32_at(b, i * 16 + 8)?))
        })
        .collect()
}

/// The serial number: UTF-16 little-endian, up to the first NUL; non-ASCII becomes '?'.
pub fn parse_serial(b: &[u8]) -> String {
    let mut s = String::new();
    for pair in b.chunks_exact(2) {
        let c = u16::from_le_bytes([pair.first().copied().unwrap_or(0), pair.get(1).copied().unwrap_or(0)]);
        if c == 0 {
            break;
        }
        s.push(char::from_u32(u32::from(c)).filter(|c| c.is_ascii_graphic()).unwrap_or('?'));
    }
    s
}

/// Depth camera intrinsics and distortion: fx, fy, (0), cx, cy, k1, k2, p1, p2, k3, ...
pub fn parse_depth_params(b: &[u8]) -> Result<IrCameraParams> {
    let f = |i: usize| f32_at(b, i * 4).ok_or_else(|| Error::invalid(format!("depth parameters too short ({} bytes)", b.len())));
    let p = IrCameraParams { fx: f(0)?, fy: f(1)?, cx: f(3)?, cy: f(4)?, k1: f(5)?, k2: f(6)?, p1: f(7)?, p2: f(8)?, k3: f(9)? };
    p.validate().map_err(Error::InvalidData)?;
    Ok(p)
}

/// The inverse of [`parse_depth_params`] (simulated device, recordings).
pub fn encode_depth_params(p: &IrCameraParams) -> Vec<u8> {
    let mut out = Vec::with_capacity(DEPTH_PARAMS_LEN);
    for v in [p.fx, p.fy, 0.0, p.cx, p.cy, p.k1, p.k2, p.p1, p.p2, p.k3] {
        out.put_f32(v);
    }
    out.resize(DEPTH_PARAMS_LEN, 0);
    out
}

/// Color camera parameters (the packed struct: u8 table id, then floats).
pub fn parse_color_params(b: &[u8]) -> Result<ColorCameraParams> {
    if b.len() < COLOR_PARAMS_MIN_LEN {
        return Err(Error::invalid(format!("color parameters too short ({} bytes)", b.len())));
    }
    let f = |i: usize| f32_at(b, 1 + i * 4).unwrap_or(0.0);
    let mut p = ColorCameraParams { fx: f(0), fy: f(0), cx: f(1), cy: f(2), shift_d: f(3), shift_m: f(4), ..Default::default() };
    for (i, v) in p.mx.iter_mut().enumerate() {
        *v = f(5 + i);
    }
    for (i, v) in p.my.iter_mut().enumerate() {
        *v = f(15 + i);
    }
    Ok(p)
}

/// The three P0 tables: the per-pixel phase offset of each modulation frequency
/// (`phase = -raw * 0.000031 * pi`), in the device's row order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct P0Tables {
    /// one table of 512 x 424 values per frequency
    pub tables: [Vec<u16>; 3],
    /// the response exactly as received (kept for recordings and the calibration cache)
    pub raw: Vec<u8>,
}

/// Parses the P0 tables response.
pub fn parse_p0_tables(b: &[u8]) -> Result<P0Tables> {
    if b.len() < P0_TABLES_MIN_LEN {
        return Err(Error::invalid(format!("P0 tables too short ({} of {P0_TABLES_MIN_LEN} bytes)", b.len())));
    }
    let table = |k: usize| -> Result<Vec<u16>> {
        let start = P0_TABLE0_OFFSET + k * P0_TABLE_STRIDE;
        let bytes = b.get(start..start + PIXELS * 2).ok_or_else(|| Error::invalid("P0 table out of range"))?;
        Ok(bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c.first().copied().unwrap_or(0), c.get(1).copied().unwrap_or(0)])).collect())
    };
    let tables = [table(0)?, table(1)?, table(2)?];
    // a table of all zeros or all equal values is not a calibration
    for (k, t) in tables.iter().enumerate() {
        let first = t.first().copied().unwrap_or(0);
        if t.iter().all(|&v| v == first) {
            return Err(Error::invalid(format!("P0 table {k} is constant ({first})")));
        }
    }
    Ok(P0Tables { tables, raw: b.to_vec() })
}

/// Builds a P0 response from three tables (simulated device).
pub fn encode_p0_tables(tables: &[Vec<u16>; 3]) -> Vec<u8> {
    let mut out = Vec::with_capacity(P0_TABLES_MIN_LEN + 2);
    for w in [0x20u32, 0, 0, (PIXELS * 2) as u32, 0, 0, 0, 0] {
        out.put_u32(w);
    }
    for t in tables {
        out.put_u16(0);
        for i in 0..PIXELS {
            out.put_u16(t.get(i).copied().unwrap_or(0));
        }
        out.put_u16(0);
    }
    out
}

/// The status word of [`super::command::Command::read_status_090000`].
pub fn parse_status(b: &[u8]) -> Result<u32> {
    u32_at(b, 0).ok_or_else(|| Error::invalid("status answer too short"))
}

/// Serial number as the device sends it (simulated device).
pub fn encode_serial(serial: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for c in serial.chars() {
        out.put_u16(c as u16);
    }
    out.put_u16(0);
    out
}

/// Firmware versions as the device sends them (simulated device): entry 3 is the main one.
pub fn encode_firmware(main: (u16, u16, u32, u32)) -> Vec<u8> {
    let mut out = Vec::new();
    for i in 0..7 {
        let (maj, min, rev, build) = if i == 3 { main } else { (1, 0, 0, 0) };
        out.put_u32((u32::from(maj) << 16) | u32::from(min));
        out.put_u32(rev);
        out.put_u32(build);
        out.put_u32(0);
    }
    out
}

/// Reads a u16 of a P0 table response at a pixel (for tests).
pub fn p0_raw_at(b: &[u8], k: usize, pixel: usize) -> Option<u16> {
    u16_at(b, P0_TABLE0_OFFSET + k * P0_TABLE_STRIDE + pixel * 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p0_layout_matches_libfreenect2_struct() {
        // libfreenect2's P0TablesResponse: 8 u32, then (u16, table, u16) per table
        assert_eq!(P0_TABLES_MIN_LEN, 32 + 3 * (2 + PIXELS * 2 + 2) - 2);
        let tables = [
            (0..PIXELS).map(|i| (i % 1000) as u16).collect::<Vec<_>>(),
            (0..PIXELS).map(|i| (i % 777) as u16).collect(),
            (0..PIXELS).map(|i| (i % 333) as u16).collect(),
        ];
        let raw = encode_p0_tables(&tables);
        assert_eq!(p0_raw_at(&raw, 1, 5), Some(5));
        let parsed = parse_p0_tables(&raw).unwrap();
        assert_eq!(parsed.tables, tables);
        assert!(parse_p0_tables(&raw[..raw.len() - 10]).is_err());
    }

    #[test]
    fn constant_p0_is_rejected() {
        let tables = [vec![7u16; PIXELS], vec![1; PIXELS], vec![2; PIXELS]];
        assert!(parse_p0_tables(&encode_p0_tables(&tables)).is_err());
    }

    #[test]
    fn depth_params_roundtrip_and_validation() {
        let p = IrCameraParams::TYPICAL;
        let b = encode_depth_params(&p);
        assert_eq!(parse_depth_params(&b).unwrap(), p);
        assert!(parse_depth_params(&b[..20]).is_err());
        let mut bad = p;
        bad.fx = f32::NAN;
        assert!(parse_depth_params(&encode_depth_params(&bad)).is_err());
    }

    #[test]
    fn serial_and_firmware() {
        assert_eq!(parse_serial(&encode_serial("012345678912")), "012345678912");
        assert_eq!(parse_serial(&[]), "");
        assert_eq!(parse_firmware(&encode_firmware((2, 3, 7697, 0))), "2.3.7697.0");
        assert_eq!(parse_firmware(&[1, 2, 3]), "");
    }
}
