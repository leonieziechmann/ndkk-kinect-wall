//! Raw depth packets: ten sub-images of 512 x 424 samples, 11 bits each.
//!
//! Layout of one sub-image (as libfreenect2's decoders read it): 424 packed rows of 704 bytes
//! (352 little-endian u16 words). Image row `y` is stored in packed row `y` for the upper half
//! and `635 - y` for the lower half. Inside a row, the sample of pixel `x` is the
//! `(x % 4) * 128 + x / 4`-th 11-bit field. The first and the last column carry nothing.

use crate::consts::{ALL_SUBIMAGES, HEIGHT, PACKET_BYTES, PHASE_SUBIMAGES, ROW_BYTES, SATURATED_CODE, SUBIMAGE_BYTES, SUBIMAGES, WIDTH};
use crate::error::{Error, Result};
use crate::pool::Pool;

/// One raw depth packet as it comes from the device (all ten sub-images of a frame).
#[derive(Clone, Debug)]
pub struct RawDepthPacket {
    /// frame sequence number from the device
    pub sequence: u32,
    /// device timestamp (units of 0.1 ms in practice)
    pub timestamp: u32,
    /// host clock when the packet was complete: microseconds since 1970
    pub host_time_us: u64,
    /// `PACKET_BYTES` bytes, sub-image after sub-image; missing parts are zero
    pub data: Vec<u8>,
    /// bit `s` set = sub-image `s` arrived
    pub present: u16,
    /// rows whose bytes were lost in transit (USB packet errors), if any
    pub bad_rows: Option<Box<BadRows>>,
    /// where `data` goes back to when the packet is dropped
    pub(crate) home: Option<Pool<Vec<u8>>>,
}

impl Drop for RawDepthPacket {
    fn drop(&mut self) {
        if let Some(pool) = self.home.take() {
            pool.put(std::mem::take(&mut self.data));
        }
    }
}

/// A buffer of `PACKET_BYTES` from the pool (it keeps whatever an earlier packet left in it).
pub(crate) fn packet_buffer(pool: &Pool<Vec<u8>>) -> Vec<u8> {
    let mut b = pool.take_or(|| vec![0; PACKET_BYTES]);
    if b.len() != PACKET_BYTES {
        b.resize(PACKET_BYTES, 0);
    }
    b
}

impl RawDepthPacket {
    /// An empty packet (all sub-images missing).
    pub fn zeroed(sequence: u32, timestamp: u32) -> RawDepthPacket {
        RawDepthPacket { sequence, timestamp, host_time_us: 0, data: vec![0; PACKET_BYTES], present: 0, bad_rows: None, home: None }
    }

    /// A packet whose buffer comes from `pool` and goes back there when the packet is dropped.
    /// The buffer still holds what an earlier packet left in it: fill every sub-image and set
    /// `present` (sources that read whole frames), or zero what is missing.
    pub fn from_pool(pool: &Pool<Vec<u8>>, sequence: u32, timestamp: u32) -> RawDepthPacket {
        RawDepthPacket { sequence, timestamp, host_time_us: 0, data: packet_buffer(pool), present: 0, bad_rows: None, home: Some(pool.clone()) }
    }

    /// A complete packet from bytes (e.g. a recording). Shorter data is rejected.
    pub fn from_bytes(mut data: Vec<u8>, sequence: u32, timestamp: u32) -> Result<RawDepthPacket> {
        if data.len() < PACKET_BYTES {
            return Err(Error::invalid(format!("raw depth packet of {} bytes, expected {PACKET_BYTES}", data.len())));
        }
        data.truncate(PACKET_BYTES);
        Ok(RawDepthPacket { sequence, timestamp, host_time_us: 0, data, present: ALL_SUBIMAGES, bad_rows: None, home: None })
    }

    /// Copies everything of `other` into this packet's buffer (no allocation when the sizes
    /// match): a cheaper `clone` for packets that go round in a pool.
    pub fn copy_from(&mut self, other: &RawDepthPacket) {
        self.sequence = other.sequence;
        self.timestamp = other.timestamp;
        self.host_time_us = other.host_time_us;
        if self.data.len() == other.data.len() {
            self.data.copy_from_slice(&other.data);
        } else {
            self.data.clear();
            self.data.extend_from_slice(&other.data);
        }
        self.present = other.present;
        self.bad_rows.clone_from(&other.bad_rows);
    }

    /// All ten sub-images arrived and nothing was lost.
    pub fn is_complete(&self) -> bool {
        self.present & ALL_SUBIMAGES == ALL_SUBIMAGES && self.bad_rows.is_none()
    }

    /// Bytes of sub-image `s`.
    pub fn subimage(&self, s: usize) -> Option<&[u8]> {
        self.data.get(s * SUBIMAGE_BYTES..(s + 1) * SUBIMAGE_BYTES)
    }

    /// Mutable bytes of sub-image `s`.
    pub fn subimage_mut(&mut self, s: usize) -> Option<&mut [u8]> {
        self.data.get_mut(s * SUBIMAGE_BYTES..(s + 1) * SUBIMAGE_BYTES)
    }

    /// The packed row that holds image row `y` of sub-image `s`.
    pub fn row_bytes(&self, s: usize, y: usize) -> Option<&[u8]> {
        let start = s * SUBIMAGE_BYTES + packed_row(y)? * ROW_BYTES;
        self.data.get(start..start + ROW_BYTES)
    }

    /// True if image row `y` of sub-image `s` holds real data.
    pub fn row_ok(&self, s: usize, y: usize) -> bool {
        if s >= SUBIMAGES || self.present & (1 << s) == 0 {
            return false;
        }
        match (&self.bad_rows, packed_row(y)) {
            (_, None) => false,
            (None, Some(_)) => true,
            (Some(b), Some(r)) => !b.is_bad(s, r),
        }
    }

    /// Bit mask of the three frequencies whose three sub-images are all present (bit k =
    /// frequency k).
    pub fn frequencies_present(&self) -> u8 {
        let mut m = 0u8;
        for k in 0..3 {
            let bits = 0b111u16 << (3 * k);
            if self.present & bits == bits {
                m |= 1 << k;
            }
        }
        m
    }

    /// Number of phase sub-images (0..=9) that arrived.
    pub fn phase_subimages_present(&self) -> u32 {
        (self.present & ((1 << PHASE_SUBIMAGES) - 1)).count_ones()
    }
}

/// Packed rows that are damaged, per sub-image (424 bits each).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BadRows {
    bits: [[u64; 7]; SUBIMAGES],
}

impl BadRows {
    /// Marks packed row `r` of sub-image `s` as damaged.
    pub fn mark(&mut self, s: usize, r: usize) {
        if let Some(words) = self.bits.get_mut(s)
            && let Some(w) = words.get_mut(r / 64)
        {
            *w |= 1 << (r % 64);
        }
    }

    /// Marks the packed rows that a damaged byte range of sub-image `s` touches.
    pub fn mark_bytes(&mut self, s: usize, start: usize, len: usize) {
        if len == 0 {
            return;
        }
        let first = start / ROW_BYTES;
        let last = (start + len - 1) / ROW_BYTES;
        for r in first..=last.min(HEIGHT - 1) {
            self.mark(s, r);
        }
    }

    /// True if packed row `r` of sub-image `s` is damaged.
    pub fn is_bad(&self, s: usize, r: usize) -> bool {
        self.bits.get(s).and_then(|w| w.get(r / 64)).is_some_and(|w| w & (1 << (r % 64)) != 0)
    }

    /// Number of damaged rows over all sub-images.
    pub fn count(&self) -> u32 {
        self.bits.iter().flatten().map(|w| w.count_ones()).sum()
    }
}

/// The packed row of image row `y` (`None` outside the image).
pub fn packed_row(y: usize) -> Option<usize> {
    match y {
        0..212 => Some(y),
        212..HEIGHT => Some(635 - y),
        _ => None,
    }
}

/// Unpacks one packed row (704 bytes) into the 11-bit codes of its 512 pixels, in pixel order.
/// The first and the last column are set to 0, as libfreenect2 does (they carry nothing).
/// A short row leaves `out` untouched where data is missing.
pub fn unpack_row(row: &[u8], out: &mut [u16; WIDTH]) {
    // 16 fields of 11 bits = 22 bytes; all 16 belong to the same column phase q = x % 4
    for (g, chunk) in row.chunks_exact(22).take(32).enumerate() {
        let (Some(lo), Some(hi)) = (chunk.get(0..16), chunk.get(6..22)) else { continue };
        let (Ok(lo), Ok(hi)) = (<[u8; 16]>::try_from(lo), <[u8; 16]>::try_from(hi)) else { continue };
        let lo = u128::from_le_bytes(lo);
        let hi = u128::from_le_bytes(hi); // bit j = bit 48 + j of the group
        let q = g / 8;
        let i0 = (g % 8) * 16;
        for t in 0..8 {
            let code = ((lo >> (11 * t)) & 2047) as u16;
            if let Some(o) = out.get_mut(4 * (i0 + t) + q) {
                *o = code;
            }
            let code = ((hi >> (40 + 11 * t)) & 2047) as u16;
            if let Some(o) = out.get_mut(4 * (i0 + 8 + t) + q) {
                *o = code;
            }
        }
    }
    if let Some(o) = out.first_mut() {
        *o = 0;
    }
    if let Some(o) = out.last_mut() {
        *o = 0;
    }
}

/// Where code `t` (0..16) of a 22-byte group sits: the byte from which a little-endian u64
/// holds all its 11 bits, and the shift within that u64.
// (evaluated by the compiler: an index out of range would not compile)
#[allow(clippy::indexing_slicing)]
const CODE_AT: [(usize, u32); 16] = {
    let mut at = [(0usize, 0u32); 16];
    let mut t = 0;
    while t < 16 {
        let bit = 11 * t;
        let byte = if bit / 8 < 14 { bit / 8 } else { 14 };
        at[t] = (byte, (bit - 8 * byte) as u32);
        t += 1;
    }
    at
};

/// [`unpack_row`] followed by the table `lut` (code -> sample value) in one pass: every code
/// is read with one 64-bit load from its group, and its value goes straight to its pixel.
pub fn unpack_row_values(row: &[u8], lut: &[f32; 2048], out: &mut [f32; WIDTH]) {
    for (g, chunk) in row.chunks_exact(22).take(32).enumerate() {
        let Ok(chunk) = <&[u8; 22]>::try_from(chunk) else { continue };
        let (q, i0) = (g / 8, (g % 8) * 16);
        for (t, &(byte, shift)) in CODE_AT.iter().enumerate() {
            let Some(word) = chunk.get(byte..byte + 8).and_then(|b| <[u8; 8]>::try_from(b).ok()) else { continue };
            let code = (u64::from_le_bytes(word) >> shift) as usize & 2047;
            if let (Some(o), Some(v)) = (out.get_mut(4 * (i0 + t) + q), lut.get(code)) {
                *o = *v;
            }
        }
    }
    // the first and the last column carry nothing (code 0, as in unpack_row)
    let zero = lut.first().copied().unwrap_or(0.0);
    if let Some(o) = out.first_mut() {
        *o = zero;
    }
    if let Some(o) = out.last_mut() {
        *o = zero;
    }
}

/// The inverse of [`unpack_row`]: packs 512 codes (pixel order) into a row of 704 bytes.
pub fn pack_row(codes: &[u16; WIDTH], row: &mut [u8]) {
    for (g, chunk) in row.chunks_exact_mut(22).take(32).enumerate() {
        let q = g / 8;
        let i0 = (g % 8) * 16;
        let mut bits = [0u8; 22];
        let mut acc: u128 = 0;
        // fields 0..8 in the low 88 bits
        for t in 0..8 {
            let c = u128::from(codes.get(4 * (i0 + t) + q).copied().unwrap_or(0) & 2047);
            acc |= c << (11 * t);
        }
        let lo = acc.to_le_bytes();
        let mut acc2: u128 = 0;
        for t in 0..8 {
            let c = u128::from(codes.get(4 * (i0 + 8 + t) + q).copied().unwrap_or(0) & 2047);
            acc2 |= c << (11 * t);
        }
        // fields 8..16 start at bit 88 = byte 11
        let hi = acc2.to_le_bytes();
        for (i, b) in bits.iter_mut().enumerate() {
            let from_lo = if i < 11 { lo.get(i).copied().unwrap_or(0) } else { 0 };
            let from_hi = if i >= 11 { hi.get(i - 11).copied().unwrap_or(0) } else { 0 };
            *b = from_lo | from_hi;
        }
        chunk.copy_from_slice(&bits);
    }
}

/// libfreenect2's table from 11-bit codes to signed sample values: 1 sign bit and 10 bits of
/// a piecewise linear magnitude (steps of 1, 1, 2, 4, ... 64), up to 16320. Code 1024 ("minus
/// zero") marks saturation and maps to 32767.
pub fn lut11to16() -> [i16; 2048] {
    let mut lut = [0i16; 2048];
    let mut y: i32 = 0;
    for x in 0..1024usize {
        let inc = 1i32 << ((x / 128) as i32 - i32::from(x >= 128)).max(0);
        if let Some(v) = lut.get_mut(x) {
            *v = y as i16;
        }
        if let Some(v) = lut.get_mut(1024 + x) {
            *v = (-y) as i16;
        }
        y += inc;
    }
    if let Some(v) = lut.get_mut(usize::from(SATURATED_CODE)) {
        *v = 32767;
    }
    lut
}

/// The 11-bit code whose value is closest to `v` (the inverse of [`lut11to16`]; never returns
/// the saturation code).
pub fn code_for_value(v: f32) -> u16 {
    let mag = v.abs().min(16320.0);
    // magnitude code m: value(m) = 2^(K-1) * (m - 128 (K-1)), K = max(m >> 7, 1)
    let m = if mag < 256.0 {
        mag.round() as u32
    } else {
        // find the segment: values 128 * 2^(K-1) .. 128 * 2^K for K >= 2
        let mut k = 2u32;
        while k < 7 && mag >= (128u32 << k) as f32 {
            k += 1;
        }
        let step = (1u32 << (k - 1)) as f32;
        let base = (128 * (k - 1)) as f32;
        ((mag / step).round() + base).min(1023.0) as u32
    };
    let m = m.min(1023) as u16;
    if v < 0.0 && m > 0 { 1024 + m } else { m }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// libfreenect2's decodePixelMeasurement for one pixel of a row, as a reference.
    fn reference_code(row: &[u8], x: usize) -> u16 {
        if !(1..=510).contains(&x) {
            return 0;
        }
        let words: Vec<u16> = row.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let idx = ((x >> 2) + ((x & 3) << 7)) * 11;
        let col = idx >> 4;
        let shift = idx & 15;
        let w0 = u32::from(words[col]);
        let w1 = u32::from(*words.get(col + 1).unwrap_or(&0));
        (((w0 >> shift) | (w1 << (16 - shift))) & 2047) as u16
    }

    #[test]
    fn unpack_matches_libfreenect2_bit_layout() {
        let mut row = vec![0u8; ROW_BYTES];
        let mut seed = 0x1234_5678u32;
        for b in row.iter_mut() {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *b = (seed >> 24) as u8;
        }
        let mut codes = [0u16; WIDTH];
        unpack_row(&row, &mut codes);
        for (x, c) in codes.iter().enumerate() {
            assert_eq!(*c, reference_code(&row, x), "pixel {x}");
        }
    }

    #[test]
    fn unpacking_to_values_is_unpacking_and_the_table() {
        let mut lut = [0f32; 2048];
        for (i, v) in lut.iter_mut().enumerate() {
            *v = i as f32 * 0.5 - 7.0;
        }
        let mut seed = 0x9e37_79b9u32;
        for _ in 0..20 {
            let mut row = vec![0u8; ROW_BYTES];
            for b in row.iter_mut() {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *b = (seed >> 24) as u8;
            }
            let mut codes = [0u16; WIDTH];
            unpack_row(&row, &mut codes);
            let mut values = [f32::NAN; WIDTH];
            unpack_row_values(&row, &lut, &mut values);
            for (x, (c, v)) in codes.iter().zip(&values).enumerate() {
                assert_eq!(*v, lut[usize::from(*c)], "pixel {x}");
            }
        }
    }

    #[test]
    fn pack_is_the_inverse_of_unpack() {
        let mut codes = [0u16; WIDTH];
        for (x, c) in codes.iter_mut().enumerate() {
            *c = ((x * 37 + 11) % 2048) as u16;
        }
        codes[0] = 0;
        codes[WIDTH - 1] = 0;
        let mut row = vec![0u8; ROW_BYTES];
        pack_row(&codes, &mut row);
        let mut back = [0u16; WIDTH];
        unpack_row(&row, &mut back);
        assert_eq!(codes, back);
    }

    #[test]
    fn lut_matches_libfreenect2() {
        let lut = lut11to16();
        assert_eq!(lut[0], 0);
        assert_eq!(lut[255], 255);
        assert_eq!(lut[256], 256);
        assert_eq!(lut[257], 258);
        assert_eq!(lut[1023], 16320);
        assert_eq!(lut[1024], 32767);
        assert_eq!(lut[1025], -1);
        assert_eq!(lut[2047], -16320);
        // monotone magnitudes
        for x in 1..1024 {
            assert!(lut[x] > lut[x - 1]);
        }
    }

    #[test]
    fn code_for_value_inverts_the_lut() {
        let lut = lut11to16();
        for code in 0..2048u16 {
            if code == SATURATED_CODE {
                continue;
            }
            let v = f32::from(lut[usize::from(code)]);
            assert_eq!(code_for_value(v), code, "value {v}");
        }
        // rounding goes to the nearest representable value
        let c = code_for_value(16000.0);
        assert!((f32::from(lut[usize::from(c)]) - 16000.0).abs() <= 32.0);
    }

    #[test]
    fn row_mapping_is_a_permutation() {
        let mut seen = [false; HEIGHT];
        for y in 0..HEIGHT {
            let r = packed_row(y).unwrap();
            assert!(!seen[r]);
            seen[r] = true;
        }
        assert_eq!(packed_row(HEIGHT), None);
    }

    #[test]
    fn bad_rows_follow_the_bytes() {
        let mut b = BadRows::default();
        b.mark_bytes(3, ROW_BYTES * 10 + 5, ROW_BYTES);
        assert!(b.is_bad(3, 10));
        assert!(b.is_bad(3, 11));
        assert!(!b.is_bad(3, 12));
        assert!(!b.is_bad(2, 10));
        assert_eq!(b.count(), 2);
    }
}
