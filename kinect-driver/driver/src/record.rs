//! Raw recordings (`.k2raw`): every raw depth packet plus the device tables, so the decoding can
//! be repeated, compared and tuned offline. The format is that of the repository's
//! fn2/fn2_rawdump.cpp (and fn2/depth_bench.cpp reads ours):
//!
//! ```text
//! NAME.k2raw.head  "K2RAW1\0\0" | u32 p0_len | P0 response | f32 xtable[512*424]
//!                  | f32 ztable[512*424] | i16 lut[2048] | f32 fx fy cx cy k1 k2 k3 p1 p2
//! NAME.k2raw       per packet: u32 sequence | u32 timestamp | u32 length | bytes
//! ```
//!
//! A single file that starts with the header (no `.head` beside it) is read as well.
//! Recordings show the room in infrared: keep them in `recordings/`, never commit them.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::camera::IrCameraParams;
use crate::consts::{PACKET_BYTES, PIXELS};
use crate::error::{Error, Result};
use crate::packet::RawDepthPacket;
use crate::protocol::response::{P0Tables, parse_p0_tables};
use crate::tables::DeviceTables;

const MAGIC: &[u8; 8] = b"K2RAW1\0\0";
/// Packets larger than this are not raw depth packets (corrupt file).
const MAX_PACKET: u32 = 8 << 20;

fn head_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".head");
    PathBuf::from(s)
}

fn read_exact_or(r: &mut impl Read, buf: &mut [u8], what: &str) -> Result<()> {
    r.read_exact(buf).map_err(|e| Error::invalid(format!("{what}: {e}")))
}

fn read_f32s(r: &mut impl Read, n: usize, what: &str) -> Result<Vec<f32>> {
    let mut b = vec![0u8; n * 4];
    read_exact_or(r, &mut b, what)?;
    Ok(b.chunks_exact(4).filter_map(|c| <[u8; 4]>::try_from(c).ok()).map(f32::from_le_bytes).collect())
}

/// The header of a recording.
#[derive(Clone, Debug)]
pub struct RawHeader {
    /// the P0 response as received from the device
    pub p0_raw: Vec<u8>,
    /// x table as recorded
    pub xtable: Vec<f32>,
    /// z table as recorded
    pub ztable: Vec<f32>,
    /// camera parameters
    pub ir_params: IrCameraParams,
}

impl RawHeader {
    /// Device tables for decoding (P0 from the recording; x/z tables recomputed from the camera
    /// parameters, as libfreenect2 would).
    pub fn tables(&self) -> Result<Arc<DeviceTables>> {
        let p0: P0Tables = parse_p0_tables(&self.p0_raw)?;
        DeviceTables::new(self.ir_params, p0, "recording")
    }

    fn read(r: &mut impl Read) -> Result<RawHeader> {
        let mut magic = [0u8; 8];
        read_exact_or(r, &mut magic, "recording header")?;
        if &magic[..6] != b"K2RAW1" {
            return Err(Error::invalid("not a raw Kinect recording (K2RAW1)"));
        }
        let mut l = [0u8; 4];
        read_exact_or(r, &mut l, "P0 length")?;
        let p0_len = u32::from_le_bytes(l);
        if p0_len > MAX_PACKET {
            return Err(Error::invalid(format!("P0 length {p0_len}")));
        }
        let mut p0_raw = vec![0u8; p0_len as usize];
        read_exact_or(r, &mut p0_raw, "P0 tables")?;
        let xtable = read_f32s(r, PIXELS, "x table")?;
        let ztable = read_f32s(r, PIXELS, "z table")?;
        let mut lut = vec![0u8; 2048 * 2];
        read_exact_or(r, &mut lut, "lookup table")?;
        let pr = read_f32s(r, 9, "camera parameters")?;
        let g = |i: usize| pr.get(i).copied().unwrap_or(0.0);
        let ir_params = IrCameraParams { fx: g(0), fy: g(1), cx: g(2), cy: g(3), k1: g(4), k2: g(5), k3: g(6), p1: g(7), p2: g(8) };
        Ok(RawHeader { p0_raw, xtable, ztable, ir_params })
    }

    fn write(&self, w: &mut impl Write) -> Result<()> {
        w.write_all(MAGIC)?;
        w.write_all(&(self.p0_raw.len() as u32).to_le_bytes())?;
        w.write_all(&self.p0_raw)?;
        for v in self.xtable.iter().chain(self.ztable.iter()) {
            w.write_all(&v.to_le_bytes())?;
        }
        for v in crate::packet::lut11to16() {
            w.write_all(&v.to_le_bytes())?;
        }
        let p = self.ir_params;
        for v in [p.fx, p.fy, p.cx, p.cy, p.k1, p.k2, p.k3, p.p1, p.p2] {
            w.write_all(&v.to_le_bytes())?;
        }
        Ok(())
    }

    /// The header of a device (its tables).
    pub fn from_tables(t: &DeviceTables) -> RawHeader {
        let p0_raw = t.p0_raw.clone().unwrap_or_else(|| crate::protocol::response::encode_p0_tables(&t.p0));
        RawHeader { p0_raw, xtable: t.xtable.clone(), ztable: t.ztable.clone(), ir_params: t.ir_params }
    }
}

/// Reads just a header (from a `.head` file or the start of a recording).
pub fn read_header(r: &mut impl Read) -> Result<RawHeader> {
    RawHeader::read(r)
}

/// Writes just a header.
pub fn write_header(w: &mut impl Write, header: &RawHeader) -> Result<()> {
    header.write(w)
}

/// Reads a recording packet by packet.
pub struct RawReader {
    header: RawHeader,
    file: BufReader<File>,
    data_start: u64,
    /// packets read so far
    pub packets_read: u64,
}

impl RawReader {
    /// Opens `path` (with `path.head` beside it, or a single file).
    pub fn open(path: &Path) -> Result<RawReader> {
        let head = head_path(path);
        let mut file = BufReader::with_capacity(4 << 20, File::open(path).map_err(|e| Error::Io(format!("{}: {e}", path.display())))?);
        let (header, data_start) = if head.exists() {
            let mut h = BufReader::new(File::open(&head).map_err(|e| Error::Io(format!("{}: {e}", head.display())))?);
            (RawHeader::read(&mut h)?, 0)
        } else {
            let h = RawHeader::read(&mut file)?;
            let pos = file.stream_position()?;
            (h, pos)
        };
        Ok(RawReader { header, file, data_start, packets_read: 0 })
    }

    /// The header.
    pub fn header(&self) -> &RawHeader {
        &self.header
    }

    /// The next packet, `None` at the end (or at a truncated last packet).
    pub fn next_packet(&mut self) -> Result<Option<RawDepthPacket>> {
        let mut head = [0u8; 12];
        match self.file.read_exact(&mut head) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(e) => return Err(e.into()),
        }
        let w = |i: usize| crate::protocol::bytes::u32_at(&head, i).unwrap_or(0);
        let (seq, ts, len) = (w(0), w(4), w(8));
        if len > MAX_PACKET {
            return Err(Error::invalid(format!("packet of {len} bytes")));
        }
        let mut data = vec![0u8; len as usize];
        match self.file.read_exact(&mut data) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(e) => return Err(e.into()),
        }
        if data.len() < PACKET_BYTES {
            data.resize(PACKET_BYTES, 0);
        }
        self.packets_read += 1;
        RawDepthPacket::from_bytes(data, seq, ts).map(Some)
    }

    /// Back to the first packet.
    pub fn rewind(&mut self) -> Result<()> {
        self.file.seek(SeekFrom::Start(self.data_start))?;
        self.packets_read = 0;
        Ok(())
    }
}

/// Writes a recording (two files, as fn2_rawdump).
pub struct RawWriter {
    file: BufWriter<File>,
    /// packets written
    pub packets: u64,
}

impl RawWriter {
    /// Creates `path` and `path.head`; refuses to overwrite.
    pub fn create(path: &Path, header: &RawHeader) -> Result<RawWriter> {
        let head = head_path(path);
        if path.exists() || head.exists() {
            return Err(Error::Io(format!("{} exists already", path.display())));
        }
        let mut h = BufWriter::new(File::create(&head)?);
        header.write(&mut h)?;
        h.flush()?;
        let file = BufWriter::with_capacity(4 << 20, File::create(path)?);
        Ok(RawWriter { file, packets: 0 })
    }

    /// Appends a packet.
    pub fn write(&mut self, p: &RawDepthPacket) -> Result<()> {
        self.file.write_all(&p.sequence.to_le_bytes())?;
        self.file.write_all(&p.timestamp.to_le_bytes())?;
        self.file.write_all(&(p.data.len() as u32).to_le_bytes())?;
        self.file.write_all(&p.data)?;
        self.packets += 1;
        Ok(())
    }

    /// Flushes to disk.
    pub fn finish(mut self) -> Result<()> {
        self.file.flush()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::{Scene, SimConfig, Simulator};

    #[test]
    fn roundtrip() {
        let dir = std::env::temp_dir().join(format!("k2raw-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.k2raw");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(head_path(&path));
        let mut sim = Simulator::new(SimConfig { supersample: false, ..Default::default() }).unwrap();
        let header = RawHeader::from_tables(sim.tables());
        let mut w = RawWriter::create(&path, &header).unwrap();
        let scene = Scene::preset("room", 0.0).unwrap();
        let mut sent = Vec::new();
        for seq in 0..2 {
            let (p, _) = sim.frame(&scene, seq);
            w.write(&p).unwrap();
            sent.push(p);
        }
        w.finish().unwrap();
        assert!(RawWriter::create(&path, &header).is_err(), "no overwrite");
        let mut r = RawReader::open(&path).unwrap();
        let t = r.header().tables().unwrap();
        assert_eq!(t.p0, sim.tables().p0);
        for p in &sent {
            let got = r.next_packet().unwrap().unwrap();
            assert_eq!(got.sequence, p.sequence);
            assert!(got.data == p.data);
        }
        assert!(r.next_packet().unwrap().is_none());
        r.rewind().unwrap();
        assert!(r.next_packet().unwrap().is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
