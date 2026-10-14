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

use crate::consts::{ALL_SUBIMAGES, PHASE_SUBIMAGES, SUBIMAGE_BYTES, SUBIMAGES, SUBPACKET_FOOTER_BYTES};
use crate::packet::{BadRows, RawDepthPacket, packet_buffer};
use crate::pool::Pool;
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

/// Where the samples of the subpacket being received go.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Dest {
    /// this sub-image slot of the frame being assembled (the one after the last received)
    Frame(usize),
    /// the start of the spare buffer: a subpacket that probably begins a new frame
    Spare,
}

struct Assembly {
    packet: RawDepthPacket,
    /// slot of the sub-image received last
    last: usize,
}

/// The parser. Feed it every isochronous packet in order with [`DepthStreamParser::push`].
///
/// The samples are written straight to their place in the frame's buffer (the slot after the
/// last sub-image, which is where the next one belongs as long as nothing is lost); only the
/// footer, which says where they really belong, is kept aside. If it names another slot, the
/// samples move there (after a lost sub-image, once). The frame buffers come from a [`Pool`]
/// and go back there when the delivered packet is dropped: no allocation, one copy per byte.
pub struct DepthStreamParser {
    cfg: DepthParserConfig,
    /// bytes of the current subpacket received so far (samples and footer)
    filled: usize,
    dest: Dest,
    footer: [u8; SUBPACKET_FOOTER_BYTES],
    holes: Vec<(usize, usize)>,
    skipping: bool,
    skipped: u32,
    frame: Option<Assembly>,
    /// buffer for a subpacket that may begin a new frame
    spare: Option<Vec<u8>>,
    pool: Pool<Vec<u8>>,
    last_delivered: Option<u32>,
    last_seen: Option<u32>,
    /// counters
    pub stats: DepthParserStats,
    /// the footer magics seen last (diagnostics)
    pub last_footer: Option<SubpacketFooter>,
}

/// Lost packets patched in one subpacket at most (a full-size hole is a ninth of it; more holes
/// than this and the subpacket is not worth keeping).
const MAX_HOLES: usize = 32;
/// Frame buffers kept for reuse: the one being assembled, the spare, two in the driver's work
/// queue, one being decoded, and those that stages or the application keep.
const KEEP_BUFFERS: usize = 8;

impl DepthStreamParser {
    /// A parser with the given policy.
    pub fn new(cfg: DepthParserConfig) -> DepthStreamParser {
        DepthStreamParser {
            cfg,
            filled: 0,
            dest: Dest::Spare,
            footer: [0; SUBPACKET_FOOTER_BYTES],
            holes: Vec::with_capacity(MAX_HOLES),
            skipping: false,
            skipped: 0,
            frame: None,
            spare: None,
            pool: Pool::new(KEEP_BUFFERS),
            last_delivered: None,
            last_seen: None,
            stats: DepthParserStats::default(),
            last_footer: None,
        }
    }

    /// The pool the frame buffers come from (counters: how many were made, how often reused).
    pub fn pool(&self) -> &Pool<Vec<u8>> {
        &self.pool
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
            if self.filled > 0 && !self.skipping {
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
        if self.filled + data.len() > SUBPACKET_BYTES {
            self.stats.overflows += 1;
            self.reset_work(true);
            return None;
        }
        if self.filled == 0 {
            self.dest = self.choose_dest();
        }
        self.write(data);
        if self.filled == SUBPACKET_BYTES {
            let out = self.finish_subpacket();
            self.reset_work(false);
            return out;
        }
        None
    }

    /// Delivers (or drops) whatever frame is being assembled, e.g. when the stream stops. A
    /// subpacket still being received is given up.
    pub fn flush(&mut self) -> Option<RawDepthPacket> {
        self.reset_work(false);
        self.flush_frame()
    }

    fn flush_frame(&mut self) -> Option<RawDepthPacket> {
        let a = self.frame.take()?;
        let mut packet = a.packet;
        let complete = packet.present & ALL_SUBIMAGES == ALL_SUBIMAGES;
        let enough = packet.phase_subimages_present() >= self.cfg.min_phase_subimages;
        if complete || (self.cfg.emit_partial && enough) {
            // missing sub-images read as zeros (the reused buffer holds an older frame there)
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
        self.filled = 0;
        self.holes.clear();
        self.skipping = skip;
        self.skipped = 0;
    }

    /// Where a subpacket that starts now goes: the slot after the last one of the frame being
    /// assembled if that is still free, else the spare buffer.
    fn choose_dest(&self) -> Dest {
        if let Some(a) = &self.frame {
            let next = a.last + 1;
            if next < SUBIMAGES && a.packet.present & (1 << next) == 0 {
                return Dest::Frame(next);
            }
        }
        Dest::Spare
    }

    /// The bytes `start..start + len` of the current subpacket's samples, in their buffer.
    fn dest_bytes(&mut self, start: usize, len: usize) -> Option<&mut [u8]> {
        let (buf, base) = match self.dest {
            Dest::Frame(slot) => (&mut self.frame.as_mut()?.packet.data, slot * SUBIMAGE_BYTES),
            Dest::Spare => {
                let pool = &self.pool;
                (self.spare.get_or_insert_with(|| packet_buffer(pool)), 0)
            }
        };
        buf.get_mut(base + start..base + start + len)
    }

    /// The next piece of the subpacket: samples to their buffer, the footer aside.
    fn write(&mut self, data: &[u8]) {
        let start = self.filled;
        let samples = SUBIMAGE_BYTES.saturating_sub(start).min(data.len());
        let (head, tail) = data.split_at_checked(samples).unwrap_or((data, &[]));
        if !head.is_empty()
            && let Some(dst) = self.dest_bytes(start, head.len())
        {
            dst.copy_from_slice(head);
        }
        if !tail.is_empty() {
            let at = start.saturating_sub(SUBIMAGE_BYTES);
            if let Some(dst) = self.footer.get_mut(at..at + tail.len()) {
                dst.copy_from_slice(tail);
            }
        }
        self.filled = start + data.len();
    }

    fn lost_packet(&mut self) {
        if self.skipping || self.filled == 0 {
            // between subpackets or already lost: nothing to rescue
            return;
        }
        match self.cfg.fill_lost_packets {
            // the hole must end before the footer, or the subpacket cannot be validated
            Some(size) if size > 0 && self.filled + size <= SUBIMAGE_BYTES && self.holes.len() < MAX_HOLES => {
                let start = self.filled;
                if let Some(dst) = self.dest_bytes(start, size) {
                    dst.fill(0);
                }
                self.holes.push((start, size));
                self.filled += size;
            }
            _ => {
                self.stats.short_subpackets += 1;
                self.reset_work(true);
            }
        }
    }

    fn finish_subpacket(&mut self) -> Option<RawDepthPacket> {
        let Some(footer) = parse_footer(&self.footer) else {
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
        self.stats.filled_packets += self.holes.len() as u64;
        if self.last_delivered == Some(footer.sequence) {
            self.stats.late_subpackets += 1;
            return None;
        }
        let sub = s * SUBIMAGE_BYTES..(s + 1) * SUBIMAGE_BYTES;
        let mut out = None;
        if self.frame.as_ref().is_some_and(|a| a.packet.sequence == footer.sequence) {
            // a sub-image of the frame being assembled: into its slot
            let a = self.frame.as_mut()?;
            match self.dest {
                Dest::Frame(slot) if slot != s => a.packet.data.copy_within(slot * SUBIMAGE_BYTES..(slot + 1) * SUBIMAGE_BYTES, s * SUBIMAGE_BYTES),
                Dest::Frame(_) => {}
                Dest::Spare => {
                    if let (Some(dst), Some(src)) = (a.packet.data.get_mut(sub.clone()), self.spare.as_ref().and_then(|b| b.get(..SUBIMAGE_BYTES))) {
                        dst.copy_from_slice(src);
                    }
                }
            }
        } else {
            // a new frame: its buffer is the spare one, with the samples in slot s
            let mut buf = match self.spare.take() {
                Some(b) => b,
                None => packet_buffer(&self.pool),
            };
            match self.dest {
                Dest::Spare if s != 0 => buf.copy_within(..SUBIMAGE_BYTES, s * SUBIMAGE_BYTES),
                Dest::Spare => {}
                Dest::Frame(slot) => {
                    // they went into the old frame's free slot: out of there before it is flushed
                    let old = self.frame.as_ref().and_then(|a| a.packet.data.get(slot * SUBIMAGE_BYTES..(slot + 1) * SUBIMAGE_BYTES));
                    if let (Some(dst), Some(src)) = (buf.get_mut(sub.clone()), old) {
                        dst.copy_from_slice(src);
                    }
                }
            }
            if self.frame.is_some() {
                out = self.flush_frame();
            }
            if let Some(prev) = self.last_seen {
                let gap = footer.sequence.wrapping_sub(prev);
                if gap > 1 && gap < 1000 {
                    self.stats.missing_frames += u64::from(gap - 1);
                }
            }
            self.last_seen = Some(footer.sequence);
            self.frame = Some(Assembly {
                packet: RawDepthPacket {
                    sequence: footer.sequence,
                    timestamp: footer.timestamp,
                    host_time_us: 0,
                    data: buf,
                    present: 0,
                    bad_rows: None,
                    home: Some(self.pool.clone()),
                },
                last: s,
            });
        }
        let a = self.frame.as_mut()?;
        let p = &mut a.packet;
        a.last = s;
        p.timestamp = footer.timestamp;
        p.present |= 1 << s;
        if !self.holes.is_empty() {
            let bad = p.bad_rows.get_or_insert_with(|| Box::new(BadRows::default()));
            for &(start, len) in &self.holes {
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
        // the sub-images after the lost one moved to their own slots
        assert_eq!(f.subimage(8), p.subimage(8));
        assert_eq!(f.subimage(9), p.subimage(9));
        assert!(f.subimage(7).unwrap().iter().all(|v| *v == 0));
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

    /// The isochronous packets of the given sub-images, in the given order.
    fn iso_subimages(p: &RawDepthPacket, order: &[usize]) -> Vec<Vec<u8>> {
        let subs = encode_subpackets(p, (0, 9));
        let mut out = Vec::new();
        for &s in order {
            for chunk in subs[s].chunks(ISO) {
                out.push(chunk.to_vec());
            }
            out.push(Vec::new());
        }
        out
    }

    fn feed(parser: &mut DepthStreamParser, packets: &[Vec<u8>]) -> Vec<RawDepthPacket> {
        packets.iter().filter_map(|d| parser.push(d, true)).collect()
    }

    #[test]
    fn subimages_out_of_order_land_in_their_slots() {
        let mut parser = DepthStreamParser::new(DepthParserConfig::default());
        let p = test_packet(8);
        let got = feed(&mut parser, &iso_subimages(&p, &[0, 1, 2, 4, 3, 5, 6, 9, 7, 8]));
        assert_eq!(got.len(), 1);
        assert!(got[0].is_complete());
        assert!(got[0].data == p.data);
    }

    #[test]
    fn reused_buffers_never_show_an_older_frame() {
        let mut parser = DepthStreamParser::new(DepthParserConfig::default());
        let a = test_packet(1);
        let got = feed(&mut parser, &iso_packets(&a));
        assert_eq!(got.len(), 1);
        drop(got); // its buffer goes back to the pool
        // frame 2 loses sub-image 5 entirely, frame 3 is complete
        let b = test_packet(2);
        let c = test_packet(3);
        let mut packets = iso_subimages(&b, &[0, 1, 2, 3, 4, 6, 7, 8, 9]);
        packets.extend(iso_packets(&c));
        let got = feed(&mut parser, &packets);
        assert_eq!(got.len(), 2);
        let (pb, pc) = (&got[0], &got[1]);
        assert_eq!(pb.sequence, 2);
        assert_eq!(pb.present, ALL_SUBIMAGES & !(1 << 5));
        assert!(pb.subimage(5).unwrap().iter().all(|v| *v == 0), "the missing sub-image reads as zeros");
        for s in [0, 4, 6, 9] {
            assert_eq!(pb.subimage(s), b.subimage(s), "sub-image {s}");
        }
        assert!(pc.is_complete() && pc.data == c.data);
        assert!(parser.pool().stats().reused >= 1);
    }

    #[test]
    fn a_new_frame_while_the_last_is_incomplete() {
        let mut parser = DepthStreamParser::new(DepthParserConfig::default());
        let a = test_packet(20);
        let b = test_packet(21);
        let mut packets = iso_subimages(&a, &[0, 1, 2, 3, 4, 5, 6, 7, 8]);
        packets.extend(iso_packets(&b));
        let got = feed(&mut parser, &packets);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].sequence, 20);
        assert_eq!(got[0].present, ALL_SUBIMAGES & !(1 << 9));
        assert_eq!(got[0].subimage(8), a.subimage(8));
        assert!(got[0].subimage(9).unwrap().iter().all(|v| *v == 0));
        assert!(got[1].is_complete() && got[1].data == b.data);
    }

    #[test]
    fn joining_in_the_middle_of_a_frame() {
        let mut parser = DepthStreamParser::new(DepthParserConfig::default());
        let a = test_packet(40);
        let b = test_packet(41);
        let mut packets = iso_subimages(&a, &[6, 7, 8, 9]);
        packets.extend(iso_packets(&b));
        let got = feed(&mut parser, &packets);
        assert_eq!(got.len(), 1, "too little of the first frame");
        assert_eq!(parser.stats.dropped_frames, 1);
        assert!(got[0].is_complete() && got[0].data == b.data);
    }

    #[test]
    fn frame_buffers_go_round() {
        let mut parser = DepthStreamParser::new(DepthParserConfig { fill_lost_packets: Some(ISO), ..Default::default() });
        let p = test_packet(1);
        let mut packets = iso_packets(&p);
        for seq in 1..=30u32 {
            // a new sequence number in every footer
            for sub in packets.chunks_mut(SUBPACKET_BYTES.div_ceil(ISO) + 2) {
                let last = sub.iter_mut().rev().find(|d| !d.is_empty()).unwrap();
                let at = last.len() - SUBPACKET_FOOTER_BYTES + 12;
                last[at..at + 4].copy_from_slice(&seq.to_le_bytes());
            }
            let got = feed(&mut parser, &packets);
            assert_eq!(got.len(), 1);
            assert!(got[0].data == p.data);
        }
        let s = parser.pool().stats();
        assert!(s.made <= 3, "{s:?}");
        assert!(s.reused >= 28, "{s:?}");
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
