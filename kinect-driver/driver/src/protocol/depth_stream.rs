//! Reassembles raw depth packets from the isochronous stream of endpoint 0x84.
//!
//! On the wire each of the ten sub-images of a frame is a "subpacket": 298496 bytes of samples
//! and a 152-byte footer (timestamp, frame sequence, sub-image index, length), spread over
//! consecutive isochronous packets and ending exactly at the end of one. Between subpackets the
//! device sends empty packets.
//!
//! Compared with libfreenect2 this parser is forgiving:
//! - A lost isochronous packet inside a subpacket is filled with zeros (if the subpacket then
//!   still ends with a valid footer at the right place) and its rows are marked as damaged,
//!   instead of losing the whole frame. libfreenect2 even shifts all following data of the
//!   transfer after an error; here every packet keeps its own place.
//! - A frame with missing sub-images can still be delivered (the decoder then works with the
//!   frequencies that are complete), instead of being dropped.
//! - A complete frame is delivered as soon as its last sub-image is there, not when the next
//!   frame begins (about 3 ms earlier).
//! - It never reads outside its buffers and resynchronizes on the next gap after any error.

use crate::consts::{ALL_SUBIMAGES, PACKET_BYTES, PHASE_SUBIMAGES, SUBIMAGE_BYTES, SUBIMAGES, SUBPACKET_FOOTER_BYTES};
use crate::packet::{BadRows, RawDepthPacket};
use crate::protocol::bytes::u32_at;

const SUBPACKET_BYTES: usize = SUBIMAGE_BYTES + SUBPACKET_FOOTER_BYTES;
/// While skipping after an error, give up waiting for a gap after this many packets.
const MAX_SKIP_PACKETS: u32 = 64;

/// How forgiving the parser is.
#[derive(Clone, Debug, PartialEq)]
pub struct DepthParserConfig {
    /// deliver frames with missing sub-images (they are marked in `RawDepthPacket::present`)
    pub emit_partial: bool,
    /// ... but only if at least this many of the nine phase sub-images arrived
    pub min_phase_subimages: u32,
    /// fill a lost isochronous packet inside a subpacket with zeros (`Some(size)` = the size of
    /// a full packet, normally the endpoint's bytes per interval); `None` = drop the subpacket
    pub fill_lost_packets: Option<usize>,
}

impl Default for DepthParserConfig {
    fn default() -> Self {
        DepthParserConfig { emit_partial: true, min_phase_subimages: 6, fill_lost_packets: None }
    }
}

/// Counters of the parser (monotonic).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DepthParserStats {
    /// isochronous packets fed
    pub packets: u64,
    /// packets the USB stack reported as failed
    pub packet_errors: u64,
    /// bytes fed
    pub bytes: u64,
    /// subpackets with a valid footer
    pub subpackets: u64,
    /// subpackets whose footer did not make sense
    pub bad_footers: u64,
    /// subpackets that ended early (gap before the footer)
    pub short_subpackets: u64,
    /// subpackets that grew too large (lost synchronization)
    pub overflows: u64,
    /// lost packets filled with zeros inside a valid subpacket
    pub filled_packets: u64,
    /// complete frames delivered
    pub frames: u64,
    /// frames delivered with missing sub-images or damaged rows
    pub partial_frames: u64,
    /// frames dropped because too little of them arrived
    pub dropped_frames: u64,
    /// frames the device sent that never showed up at all (gaps in the sequence numbers)
    pub missing_frames: u64,
    /// subpackets of a frame that was already delivered
    pub late_subpackets: u64,
}

/// Footer of one subpacket.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SubpacketFooter {
    /// unknown, logged for diagnostics
    pub magic0: u32,
    /// unknown, logged for diagnostics
    pub magic1: u32,
    /// device timestamp
    pub timestamp: u32,
    /// frame sequence number
    pub sequence: u32,
    /// sub-image index 0..9
    pub subsequence: u32,
    /// bytes of sample data (298496)
    pub length: u32,
}

/// Reads a footer from its 152 bytes.
pub fn parse_footer(b: &[u8]) -> Option<SubpacketFooter> {
    Some(SubpacketFooter {
        magic0: u32_at(b, 0)?,
        magic1: u32_at(b, 4)?,
        timestamp: u32_at(b, 8)?,
        sequence: u32_at(b, 12)?,
        subsequence: u32_at(b, 16)?,
        length: u32_at(b, 20)?,
    })
}

/// Writes a footer (simulated device).
pub fn encode_footer(f: &SubpacketFooter) -> Vec<u8> {
    let mut out = Vec::with_capacity(SUBPACKET_FOOTER_BYTES);
    for v in [f.magic0, f.magic1, f.timestamp, f.sequence, f.subsequence, f.length] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.resize(SUBPACKET_FOOTER_BYTES, 0);
    out
}

struct Assembly {
    packet: RawDepthPacket,
}

/// The parser. Feed it every isochronous packet in order with [`DepthStreamParser::push`].
pub struct DepthStreamParser {
    cfg: DepthParserConfig,
    work: Vec<u8>,
    holes: Vec<(usize, usize)>,
    skipping: bool,
    skipped: u32,
    frame: Option<Assembly>,
    last_delivered: Option<u32>,
    last_seen: Option<u32>,
    spare: Vec<Vec<u8>>,
    /// counters
    pub stats: DepthParserStats,
    /// the footer magics seen last (diagnostics)
    pub last_footer: Option<SubpacketFooter>,
}

impl DepthStreamParser {
    /// A parser with the given policy.
    pub fn new(cfg: DepthParserConfig) -> DepthStreamParser {
        DepthStreamParser {
            cfg,
            work: Vec::with_capacity(SUBPACKET_BYTES),
            holes: Vec::new(),
            skipping: false,
            skipped: 0,
            frame: None,
            last_delivered: None,
            last_seen: None,
            spare: Vec::new(),
            stats: DepthParserStats::default(),
            last_footer: None,
        }
    }

    /// Hands back the buffer of a packet that is no longer needed (saves a 3 MB allocation).
    pub fn recycle(&mut self, mut buf: Vec<u8>) {
        if self.spare.len() < 3 && buf.capacity() >= PACKET_BYTES {
            buf.clear();
            self.spare.push(buf);
        }
    }

    /// One isochronous packet; `ok == false` if the USB stack reported it as failed. Returns a
    /// frame if this packet finished one.
    pub fn push(&mut self, data: &[u8], ok: bool) -> Option<RawDepthPacket> {
        self.stats.packets += 1;
        self.stats.bytes += data.len() as u64;
        if !ok {
            self.stats.packet_errors += 1;
            self.lost_packet();
            return None;
        }
        if data.is_empty() {
            // a gap: whatever was being assembled ended early
            if !self.work.is_empty() && !self.skipping {
                self.stats.short_subpackets += 1;
            }
            self.reset_work(false);
            return None;
        }
        if self.skipping {
            self.skipped += 1;
            if self.skipped < MAX_SKIP_PACKETS {
                return None;
            }
            // no gap for a long time: try to pick up from here
            self.reset_work(false);
        }
        if self.work.len() + data.len() > SUBPACKET_BYTES {
            self.stats.overflows += 1;
            self.reset_work(true);
            return None;
        }
        self.work.extend_from_slice(data);
        if self.work.len() == SUBPACKET_BYTES {
            let out = self.finish_subpacket();
            self.reset_work(false);
            return out;
        }
        None
    }

    /// Delivers (or drops) whatever frame is being assembled, e.g. when the stream stops.
    pub fn flush(&mut self) -> Option<RawDepthPacket> {
        let a = self.frame.take()?;
        let mut packet = a.packet;
        let complete = packet.present & ALL_SUBIMAGES == ALL_SUBIMAGES;
        let enough = packet.phase_subimages_present() >= self.cfg.min_phase_subimages;
        if complete || (self.cfg.emit_partial && enough) {
            // missing sub-images read as zeros
            for s in 0..SUBIMAGES {
                if packet.present & (1 << s) == 0
                    && let Some(sub) = packet.subimage_mut(s)
                {
                    sub.fill(0);
                }
            }
            self.deliver(&mut packet);
            Some(packet)
        } else {
            self.stats.dropped_frames += 1;
            None
        }
    }

    fn deliver(&mut self, packet: &mut RawDepthPacket) {
        if packet.is_complete() {
            self.stats.frames += 1;
        } else {
            self.stats.partial_frames += 1;
        }
        self.last_delivered = Some(packet.sequence);
    }

    fn reset_work(&mut self, skip: bool) {
        self.work.clear();
        self.holes.clear();
        self.skipping = skip;
        self.skipped = 0;
    }

    fn lost_packet(&mut self) {
        if self.skipping || self.work.is_empty() {
            // between subpackets or already lost: nothing to rescue
            return;
        }
        match self.cfg.fill_lost_packets {
            // the hole must end before the footer, or the subpacket cannot be validated
            Some(size) if size > 0 && self.work.len() + size <= SUBIMAGE_BYTES => {
                self.holes.push((self.work.len(), size));
                self.work.resize(self.work.len() + size, 0);
            }
            _ => {
                self.stats.short_subpackets += 1;
                self.reset_work(true);
            }
        }
    }

    fn take_buffer(&mut self) -> Vec<u8> {
        match self.spare.pop() {
            Some(mut b) => {
                b.resize(PACKET_BYTES, 0);
                b
            }
            None => vec![0; PACKET_BYTES],
        }
    }

    fn finish_subpacket(&mut self) -> Option<RawDepthPacket> {
        let footer = self.work.get(SUBIMAGE_BYTES..).and_then(parse_footer);
        let Some(footer) = footer else {
            self.stats.bad_footers += 1;
            return None;
        };
        let s = footer.subsequence as usize;
        if footer.length as usize != SUBIMAGE_BYTES || s >= SUBIMAGES {
            self.stats.bad_footers += 1;
            return None;
        }
        self.last_footer = Some(footer);
        self.stats.subpackets += 1;
        if !self.holes.is_empty() {
            self.stats.filled_packets += self.holes.len() as u64;
        }
        if self.last_delivered == Some(footer.sequence) {
            self.stats.late_subpackets += 1;
            return None;
        }
        let mut out = None;
        if self.frame.as_ref().is_some_and(|a| a.packet.sequence != footer.sequence) {
            out = self.flush();
        }
        if self.frame.is_none() {
            if let Some(prev) = self.last_seen {
                let gap = footer.sequence.wrapping_sub(prev);
                if gap > 1 && gap < 1000 {
                    self.stats.missing_frames += u64::from(gap - 1);
                }
            }
            self.last_seen = Some(footer.sequence);
            let data = self.take_buffer();
            self.frame = Some(Assembly {
                packet: RawDepthPacket {
                    sequence: footer.sequence,
                    timestamp: footer.timestamp,
                    host_time_us: 0,
                    data,
                    present: 0,
                    bad_rows: None,
                },
            });
        }
        let holes = std::mem::take(&mut self.holes);
        let a = self.frame.as_mut()?;
        let p = &mut a.packet;
        p.timestamp = footer.timestamp;
        if let (Some(dst), Some(src)) = (p.subimage_mut(s), self.work.get(..SUBIMAGE_BYTES)) {
            dst.copy_from_slice(src);
            p.present |= 1 << s;
        }
        if !holes.is_empty() {
            let bad = p.bad_rows.get_or_insert_with(|| Box::new(BadRows::default()));
            for (start, len) in holes {
                bad.mark_bytes(s, start, len);
            }
        }
        if out.is_none() && p.present & ALL_SUBIMAGES == ALL_SUBIMAGES {
            // the last sub-image of a frame: deliver now, do not wait for the next frame
            let a = self.frame.take()?;
            let mut packet = a.packet;
            self.deliver(&mut packet);
            return Some(packet);
        }
        out
    }

    /// The policy in use.
    pub fn config(&self) -> &DepthParserConfig {
        &self.cfg
    }
}

/// Splits a raw packet into the subpackets the device would send (simulated device, tests).
pub fn encode_subpackets(packet: &RawDepthPacket, magic: (u32, u32)) -> Vec<Vec<u8>> {
    (0..SUBIMAGES)
        .filter(|s| packet.present & (1 << s) != 0)
        .filter_map(|s| {
            let mut sub = packet.subimage(s)?.to_vec();
            sub.extend(encode_footer(&SubpacketFooter {
                magic0: magic.0,
                magic1: magic.1,
                timestamp: packet.timestamp.wrapping_add(s as u32 * 33),
                sequence: packet.sequence,
                subsequence: s as u32,
                length: SUBIMAGE_BYTES as u32,
            }));
            Some(sub)
        })
        .collect()
}

/// The phase sub-images are 0..9; re-exported for users of the parser.
pub const PHASE_SUBIMAGE_COUNT: usize = PHASE_SUBIMAGES;

#[cfg(test)]
mod tests {
    use super::*;

    const ISO: usize = 0x8400;

    fn test_packet(seq: u32) -> RawDepthPacket {
        let mut p = RawDepthPacket::zeroed(seq, 1000 + seq);
        for (i, b) in p.data.iter_mut().enumerate() {
            *b = (i.wrapping_mul(31) ^ seq as usize) as u8;
        }
        p.present = ALL_SUBIMAGES;
        p
    }

    /// The isochronous packets of a frame: full packets, a short last one, then gaps.
    fn iso_packets(p: &RawDepthPacket) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        for sub in encode_subpackets(p, (0, 9)) {
            for chunk in sub.chunks(ISO) {
                out.push(chunk.to_vec());
            }
            out.push(Vec::new());
            out.push(Vec::new());
        }
        out
    }

    #[test]
    fn complete_frames_arrive_intact_and_immediately() {
        let mut parser = DepthStreamParser::new(DepthParserConfig::default());
        for seq in 10..13 {
            let p = test_packet(seq);
            let mut got = None;
            let packets = iso_packets(&p);
            let last_data = packets.iter().rposition(|d| !d.is_empty()).unwrap();
            for (i, d) in packets.iter().enumerate() {
                if let Some(f) = parser.push(d, true) {
                    assert_eq!(i, last_data, "delivered at the last data packet");
                    got = Some(f);
                }
            }
            let got = got.expect("frame");
            assert_eq!(got.sequence, seq);
            assert!(got.is_complete());
            assert!(got.data == p.data);
        }
        assert_eq!(parser.stats.frames, 3);
        assert_eq!(parser.stats.dropped_frames, 0);
    }

    #[test]
    fn lost_packet_is_filled_and_marked() {
        let mut parser = DepthStreamParser::new(DepthParserConfig { fill_lost_packets: Some(ISO), ..Default::default() });
        let p = test_packet(5);
        let mut packets = iso_packets(&p);
        // lose the 3rd packet of sub-image 4
        let per_sub = SUBPACKET_BYTES.div_ceil(ISO) + 2;
        let idx = 4 * per_sub + 2;
        let mut out = None;
        for (i, d) in packets.drain(..).enumerate() {
            let r = if i == idx { parser.push(&[], false) } else { parser.push(&d, true) };
            if r.is_some() {
                out = r;
            }
        }
        // the frame is only complete when the next one starts... it is delivered by flush
        let f = out.or_else(|| parser.flush()).expect("frame");
        assert_eq!(f.present, ALL_SUBIMAGES);
        let bad = f.bad_rows.as_ref().expect("damaged rows marked");
        assert!(bad.count() >= 48 && bad.count() <= 50, "{} rows", bad.count());
        assert_eq!(parser.stats.filled_packets, 1);
        // the other sub-images are exact
        assert_eq!(f.subimage(3), p.subimage(3));
    }

    #[test]
    fn lost_packet_without_filling_drops_one_subimage() {
        let mut parser = DepthStreamParser::new(DepthParserConfig::default());
        let p = test_packet(5);
        let per_sub = SUBPACKET_BYTES.div_ceil(ISO) + 2;
        let mut out = None;
        for (i, d) in iso_packets(&p).iter().enumerate() {
            let r = if i == 7 * per_sub + 1 { parser.push(d, false) } else { parser.push(d, true) };
            out = out.or(r);
        }
        assert!(out.is_none(), "incomplete: waits for the next frame");
        let f = parser.flush().expect("partial frame");
        assert_eq!(f.present, ALL_SUBIMAGES & !(1 << 7));
        assert_eq!(f.frequencies_present(), 0b011);
        assert_eq!(parser.stats.partial_frames, 1);
    }

    #[test]
    fn garbage_never_panics_and_resyncs() {
        let mut parser = DepthStreamParser::new(DepthParserConfig { fill_lost_packets: Some(ISO), ..Default::default() });
        let mut seed = 99u32;
        for _ in 0..5000 {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
            let len = (seed >> 8) as usize % (ISO + 100);
            let data: Vec<u8> = (0..len).map(|i| (i as u32 ^ seed) as u8).collect();
            let _ = parser.push(&data, !seed.is_multiple_of(7));
        }
        // a clean frame afterwards still comes through
        let p = test_packet(77);
        let mut got = None;
        parser.push(&[], true);
        for d in iso_packets(&p) {
            got = got.or(parser.push(&d, true));
        }
        let got = got.expect("resynchronized");
        assert_eq!(got.sequence, 77);
        assert!(got.data == p.data);
    }

    #[test]
    fn duplicate_subpackets_after_delivery_are_ignored() {
        let mut parser = DepthStreamParser::new(DepthParserConfig::default());
        let p = test_packet(3);
        let packets = iso_packets(&p);
        let mut n = 0;
        for d in packets.iter().chain(packets.iter()) {
            if parser.push(d, true).is_some() {
                n += 1;
            }
        }
        assert_eq!(n, 1);
        assert!(parser.stats.late_subpackets >= 10);
    }

    #[test]
    fn sequence_gaps_are_counted() {
        let mut parser = DepthStreamParser::new(DepthParserConfig::default());
        for seq in [1u32, 2, 5] {
            for d in iso_packets(&test_packet(seq)) {
                let _ = parser.push(&d, true);
            }
        }
        assert_eq!(parser.stats.missing_frames, 2);
    }
}
