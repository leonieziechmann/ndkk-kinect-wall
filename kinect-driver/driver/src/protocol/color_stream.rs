//! Reassembles JPEG color frames from the bulk stream of endpoint 0x83.
//!
//! A frame on the wire: `u32 sequence | "BBBB" | JPEG | 0-3 bytes 0xA5 | filler "ZZZZ..." |
//! footer` (56 bytes: "9999", sequence, filler length, 2 x 0, timestamp, exposure, gain,
//! "BBBB", packet size, gamma, 3 x 0), as libfreenect2 found it. A frame ends at the end of a
//! bulk transfer; a new one starts at the beginning of the next. After any inconsistency the
//! parser waits for a transfer that starts with a frame header, so one damaged frame never
//! takes the following ones with it.

use crate::protocol::bytes::{f32_at, u32_at};

const HEADER_MAGIC: u32 = 0x4242_4242; // "BBBB"
const FOOTER_MAGIC: u32 = 0x3939_3939; // "9999"
const HEADER_BYTES: usize = 8;
const FOOTER_BYTES: usize = 56;
/// Largest frame accepted (libfreenect2 uses 2 MB buffers).
pub const MAX_COLOR_FRAME: usize = 4 << 20;

/// One color frame: a JPEG of 1920 x 1080 and what the camera reports about it.
#[derive(Clone, Debug, PartialEq)]
pub struct ColorFrame {
    /// frame sequence number
    pub sequence: u32,
    /// device timestamp
    pub timestamp: u32,
    /// host clock when the frame was complete: microseconds since 1970
    pub host_time_us: u64,
    /// exposure as reported (roughly 0.5 .. 60)
    pub exposure: f32,
    /// gain as reported (1.0 .. 1.5)
    pub gain: f32,
    /// gamma as reported (1.0 .. 6.4)
    pub gamma: f32,
    /// the JPEG file (starts with FF D8, ends with FF D9)
    pub jpeg: Vec<u8>,
}

/// Counters of the color parser.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ColorParserStats {
    /// bulk transfers fed
    pub transfers: u64,
    /// bytes fed
    pub bytes: u64,
    /// frames delivered
    pub frames: u64,
    /// frames dropped (bad size, sequence, filler, no JPEG end)
    pub bad_frames: u64,
    /// frames that grew beyond the limit
    pub overflows: u64,
    /// transfers skipped while waiting for a frame start
    pub skipped: u64,
}

/// The color stream parser.
pub struct ColorStreamParser {
    buf: Vec<u8>,
    synced: bool,
    /// counters
    pub stats: ColorParserStats,
}

impl Default for ColorStreamParser {
    fn default() -> Self {
        ColorStreamParser::new()
    }
}

impl ColorStreamParser {
    /// A new parser, waiting for the start of a frame.
    pub fn new() -> ColorStreamParser {
        ColorStreamParser { buf: Vec::with_capacity(1 << 20), synced: false, stats: ColorParserStats::default() }
    }

    /// One completed bulk transfer. Returns a frame if it ended one.
    pub fn push(&mut self, data: &[u8]) -> Option<ColorFrame> {
        self.stats.transfers += 1;
        self.stats.bytes += data.len() as u64;
        if data.is_empty() {
            return None;
        }
        if self.buf.is_empty() {
            // a frame starts here, or we wait for one
            if u32_at(data, 4) != Some(HEADER_MAGIC) {
                self.stats.skipped += 1;
                self.synced = false;
                return None;
            }
            self.synced = true;
        }
        if !self.synced {
            return None;
        }
        if self.buf.len() + data.len() > MAX_COLOR_FRAME {
            self.stats.overflows += 1;
            self.buf.clear();
            self.synced = false;
            return None;
        }
        self.buf.extend_from_slice(data);
        if self.buf.len() <= HEADER_BYTES + FOOTER_BYTES {
            return None;
        }
        let f = self.buf.len() - FOOTER_BYTES;
        if u32_at(&self.buf, f) != Some(FOOTER_MAGIC) || u32_at(&self.buf, f + 32) != Some(HEADER_MAGIC) {
            return None; // the frame goes on in the next transfer
        }
        let frame = self.finish(f);
        self.buf.clear();
        match frame {
            Some(fr) => {
                self.stats.frames += 1;
                Some(fr)
            }
            None => {
                self.stats.bad_frames += 1;
                None
            }
        }
    }

    fn finish(&self, f: usize) -> Option<ColorFrame> {
        let b = &self.buf;
        let sequence = u32_at(b, 0)?;
        let footer_sequence = u32_at(b, f + 4)?;
        let filler = u32_at(b, f + 8)? as usize;
        let packet_size = u32_at(b, f + 36)? as usize;
        if packet_size != b.len() || footer_sequence != sequence {
            return None;
        }
        let payload = b.len().checked_sub(HEADER_BYTES + FOOTER_BYTES)?;
        let without_filler = payload.checked_sub(filler)?;
        let jpeg_area = b.get(HEADER_BYTES..HEADER_BYTES + without_filler)?;
        // the JPEG end marker FF D9, followed by 0..3 alignment bytes
        let mut jpeg_len = None;
        for pad in 0..4 {
            let Some(end) = without_filler.checked_sub(pad) else { break };
            if end >= 2 && jpeg_area.get(end - 2) == Some(&0xFF) && jpeg_area.get(end - 1) == Some(&0xD9) {
                jpeg_len = Some(end);
            }
        }
        let jpeg_len = jpeg_len?;
        Some(ColorFrame {
            sequence,
            timestamp: u32_at(b, f + 20)?,
            host_time_us: 0,
            exposure: f32_at(b, f + 24)?,
            gain: f32_at(b, f + 28)?,
            gamma: f32_at(b, f + 40)?,
            jpeg: jpeg_area.get(..jpeg_len)?.to_vec(),
        })
    }
}

/// Builds the wire form of a color frame (simulated device, tests).
pub fn encode_color_frame(sequence: u32, timestamp: u32, jpeg: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&sequence.to_le_bytes());
    out.extend_from_slice(&HEADER_MAGIC.to_le_bytes());
    out.extend_from_slice(jpeg);
    while out.len() % 4 != 0 {
        out.push(0xA5);
    }
    let filler = 16usize;
    out.extend(std::iter::repeat_n(b'Z', filler));
    let packet_size = out.len() + FOOTER_BYTES;
    for v in [FOOTER_MAGIC, sequence, filler as u32, 0, 0, timestamp] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&10.0f32.to_le_bytes());
    out.extend_from_slice(&1.0f32.to_le_bytes());
    out.extend_from_slice(&HEADER_MAGIC.to_le_bytes());
    out.extend_from_slice(&(packet_size as u32).to_le_bytes());
    out.extend_from_slice(&1.0f32.to_le_bytes());
    out.extend_from_slice(&[0u8; 12]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_jpeg(n: usize) -> Vec<u8> {
        let mut j = vec![0xFF, 0xD8];
        j.extend((0..n).map(|i| (i % 200) as u8));
        j.extend([0xFF, 0xD9]);
        j
    }

    #[test]
    fn frames_split_over_transfers() {
        let mut p = ColorStreamParser::new();
        for seq in 0..3u32 {
            let jpeg = fake_jpeg(100_000 + seq as usize * 7);
            let wire = encode_color_frame(seq, 5, &jpeg);
            let mut got = None;
            for chunk in wire.chunks(0x4000) {
                got = got.or(p.push(chunk));
            }
            let f = got.expect("frame");
            assert_eq!(f.sequence, seq);
            assert_eq!(f.jpeg, jpeg);
        }
        assert_eq!(p.stats.frames, 3);
    }

    #[test]
    fn lost_transfer_costs_one_frame() {
        let mut p = ColorStreamParser::new();
        let a = encode_color_frame(1, 5, &fake_jpeg(50_000));
        let b = encode_color_frame(2, 5, &fake_jpeg(50_000));
        let mut frames = 0;
        for (i, chunk) in a.chunks(0x4000).enumerate() {
            if i != 1 && p.push(chunk).is_some() {
                frames += 1;
            }
        }
        for chunk in b.chunks(0x4000) {
            if p.push(chunk).is_some() {
                frames += 1;
            }
        }
        assert_eq!(frames, 1);
        assert_eq!(p.stats.bad_frames, 1);
    }

    #[test]
    fn garbage_is_skipped() {
        let mut p = ColorStreamParser::new();
        for i in 0..100u32 {
            let junk: Vec<u8> = (0..0x4000u32).map(|j| (j ^ i) as u8).collect();
            assert!(p.push(&junk).is_none());
        }
        let wire = encode_color_frame(9, 5, &fake_jpeg(1000));
        assert!(p.push(&wire).is_some());
    }
}
