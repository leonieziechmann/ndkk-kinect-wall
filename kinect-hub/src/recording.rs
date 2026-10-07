//! The `.k2rec` recording format: `kinect-hub-probe record` writes it from a running hub,
//! `kinect-hub --source replay FILE` plays it back. Both binaries include this file (the probe via
//! `#[path]`), so it depends only on std and serde_json.
//!
//! Little-endian throughout:
//!
//! ```text
//! file header, 32 bytes:
//!   u32 magic "K2RC" | u32 version (1) | u32 header_len (offset of the first frame)
//!   | u16 width | u16 height | u32 info_len | u32 lut_len | u64 reserved (0)
//! info:  info_len bytes of JSON, {"params": {camera parameters as the hub sent them}, ...}
//! lut:   lut_len bytes, the payload of the hub's `lut` message: f32 x,y per pixel
//! frames until the end of the file, each a 24-byte header followed by the pixels:
//!   u32 magic "K2RF" | u32 seq | u64 capture_time_us | u16 flags (1 = IR follows) | u16 reserved
//!   | u32 payload_len | u16 depth[width*height] in mm (`depth_raw`) | u8 ir[width*height] (`ir`)
//! ```
//!
//! There is no frame count: a recording that was cut off stays readable up to its last whole frame.

// each binary uses one half: the probe writes, the hub reads
#![allow(dead_code)]

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

use serde_json::Value;

pub const VERSION: u32 = 1;
const FILE_MAGIC: u32 = 0x4352_324B; // "K2RC"
const FRAME_MAGIC: u32 = 0x4652_324B; // "K2RF"
const FILE_HEADER_LEN: usize = 32;
const FRAME_HEADER_LEN: usize = 24;
const MAX_INFO_LEN: usize = 1 << 20;
pub const FLAG_IR: u16 = 1;

fn le_u16(b: &[u8], at: usize) -> u16 {
    b.get(at..at + 2).and_then(|s| s.try_into().ok()).map_or(0, u16::from_le_bytes)
}

fn le_u32(b: &[u8], at: usize) -> u32 {
    b.get(at..at + 4).and_then(|s| s.try_into().ok()).map_or(0, u32::from_le_bytes)
}

fn le_u64(b: &[u8], at: usize) -> u64 {
    b.get(at..at + 8).and_then(|s| s.try_into().ok()).map_or(0, u64::from_le_bytes)
}

fn invalid(msg: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, msg)
}

/// Writes a recording: the header first, then one frame at a time.
pub struct Writer<W: Write> {
    out: W,
    pixels: usize,
}

impl<W: Write> Writer<W> {
    /// `info` must contain `params`; `lut` is the payload of the hub's `lut` message.
    pub fn new(mut out: W, width: u16, height: u16, info: &Value, lut: &[u8]) -> io::Result<Writer<W>> {
        let pixels = usize::from(width) * usize::from(height);
        if pixels == 0 || lut.len() != pixels * 8 {
            return Err(invalid(format!("LUT has {} bytes, expected {} for {width}x{height}", lut.len(), pixels * 8)));
        }
        let info = serde_json::to_vec(info).map_err(io::Error::other)?;
        if info.len() > MAX_INFO_LEN {
            return Err(invalid(format!("info JSON has {} bytes, the limit is {MAX_INFO_LEN}", info.len())));
        }
        let len32 = |n: usize| u32::try_from(n).map_err(|_| invalid(format!("{n} bytes do not fit the header")));
        let mut h = Vec::with_capacity(FILE_HEADER_LEN);
        h.extend_from_slice(&FILE_MAGIC.to_le_bytes());
        h.extend_from_slice(&VERSION.to_le_bytes());
        h.extend_from_slice(&len32(FILE_HEADER_LEN + info.len() + lut.len())?.to_le_bytes());
        h.extend_from_slice(&width.to_le_bytes());
        h.extend_from_slice(&height.to_le_bytes());
        h.extend_from_slice(&len32(info.len())?.to_le_bytes());
        h.extend_from_slice(&len32(lut.len())?.to_le_bytes());
        h.extend_from_slice(&0u64.to_le_bytes());
        out.write_all(&h)?;
        out.write_all(&info)?;
        out.write_all(lut)?;
        Ok(Writer { out, pixels })
    }

    /// `depth` is the payload of a `depth_raw` message, `ir` the payload of the `ir` message of the
    /// same frame (if there is one).
    pub fn frame(&mut self, seq: u32, capture_time_us: u64, depth: &[u8], ir: Option<&[u8]>) -> io::Result<()> {
        if depth.len() != self.pixels * 2 || ir.is_some_and(|ir| ir.len() != self.pixels) {
            return Err(invalid(format!(
                "frame of {} + {} bytes does not match the image size",
                depth.len(),
                ir.map_or(0, <[u8]>::len)
            )));
        }
        let payload_len = depth.len() + ir.map_or(0, <[u8]>::len);
        let payload_len = u32::try_from(payload_len).map_err(|_| invalid("frame too large".to_string()))?;
        let mut h = Vec::with_capacity(FRAME_HEADER_LEN);
        h.extend_from_slice(&FRAME_MAGIC.to_le_bytes());
        h.extend_from_slice(&seq.to_le_bytes());
        h.extend_from_slice(&capture_time_us.to_le_bytes());
        h.extend_from_slice(&(if ir.is_some() { FLAG_IR } else { 0 }).to_le_bytes());
        h.extend_from_slice(&0u16.to_le_bytes());
        h.extend_from_slice(&payload_len.to_le_bytes());
        self.out.write_all(&h)?;
        self.out.write_all(depth)?;
        if let Some(ir) = ir {
            self.out.write_all(ir)?;
        }
        Ok(())
    }

    pub fn finish(mut self) -> io::Result<W> {
        self.out.flush()?;
        Ok(self.out)
    }
}

/// Where one frame lies in the file.
#[derive(Clone, Debug)]
pub struct FrameInfo {
    pub seq: u32,
    /// When the hub got the frame from the sensor, µs since 1970 on the recording machine.
    pub capture_time_us: u64,
    pub has_ir: bool,
    /// File offset of the frame header.
    pos: u64,
    payload_len: usize,
}

/// An opened recording: header, LUT and the index of all whole frames. Pixels are read on demand,
/// so even long recordings need little memory.
pub struct Recording<R> {
    src: R,
    pub width: u16,
    pub height: u16,
    pub info: Value,
    /// f32 x,y per pixel.
    pub lut: Vec<f32>,
    pub frames: Vec<FrameInfo>,
    /// Why the frames end before the file does (cut off or damaged); the frames before are fine.
    pub damaged_tail: Option<String>,
}

impl Recording<File> {
    pub fn open(path: &Path) -> Result<Recording<File>, String> {
        let file = File::open(path).map_err(|e| format!("cannot open: {e}"))?;
        Recording::read(file)
    }
}

impl<R: Read + Seek> Recording<R> {
    /// Checks the header and indexes the frames (reading only the frame headers).
    pub fn read(mut src: R) -> Result<Recording<R>, String> {
        let read_err = |e: io::Error| format!("read error: {e}");
        let file_len = src.seek(SeekFrom::End(0)).map_err(read_err)?;
        src.seek(SeekFrom::Start(0)).map_err(read_err)?;
        let mut h = [0u8; FILE_HEADER_LEN];
        src.read_exact(&mut h).map_err(|_| "not a recording (file too short)".to_string())?;
        if le_u32(&h, 0) != FILE_MAGIC {
            return Err("not a kinect-hub recording (.k2rec)".to_string());
        }
        let version = le_u32(&h, 4);
        if version != VERSION {
            return Err(format!("recording format version {version}, this build reads version {VERSION}"));
        }
        let header_len = u64::from(le_u32(&h, 8));
        let (width, height) = (le_u16(&h, 12), le_u16(&h, 14));
        let (info_len, lut_len) = (le_u32(&h, 16) as usize, le_u32(&h, 20) as usize);
        let pixels = usize::from(width) * usize::from(height);
        if pixels == 0 {
            return Err("damaged header (image size 0)".to_string());
        }
        if info_len > MAX_INFO_LEN || lut_len != pixels * 8 {
            return Err(format!("damaged header (info {info_len} bytes, LUT {lut_len} bytes)"));
        }
        if header_len < (FILE_HEADER_LEN + info_len + lut_len) as u64 || header_len > file_len {
            return Err(format!("damaged or cut-off header ({file_len} bytes in the file, header claims {header_len})"));
        }
        let mut info = vec![0u8; info_len];
        src.read_exact(&mut info).map_err(read_err)?;
        let info: Value = serde_json::from_slice(&info).map_err(|e| format!("damaged info JSON: {e}"))?;
        let mut lut_bytes = vec![0u8; lut_len];
        src.read_exact(&mut lut_bytes).map_err(read_err)?;
        let lut: Vec<f32> = lut_bytes.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect();
        // the rays of a real lens stay well inside +-10 (that would be a 168 degree field of view)
        if !lut.iter().all(|v| v.is_finite() && v.abs() < 10.0) {
            return Err("damaged LUT (values out of range)".to_string());
        }

        let mut frames = Vec::new();
        let mut damaged_tail = None;
        let mut pos = header_len;
        while pos < file_len {
            match frame_at(&mut src, pos, file_len, pixels) {
                Ok(f) => {
                    pos = f.pos + (FRAME_HEADER_LEN + f.payload_len) as u64;
                    frames.push(f);
                }
                Err(e) => {
                    damaged_tail = Some(format!("last {} bytes ignored: {e}", file_len - pos));
                    break;
                }
            }
        }
        if frames.is_empty() {
            return Err(match damaged_tail {
                Some(e) => format!("no whole frame ({e})"),
                None => "no frames".to_string(),
            });
        }
        Ok(Recording { src, width, height, info, lut, frames, damaged_tail })
    }

    /// Reads the pixels of frame `index` into `buf`: u16 depth, then u8 IR if `has_ir`.
    pub fn read_frame(&mut self, index: usize, buf: &mut Vec<u8>) -> Result<&FrameInfo, String> {
        let f = self.frames.get(index).ok_or_else(|| format!("frame {index} does not exist"))?;
        let mut h = [0u8; FRAME_HEADER_LEN];
        let read = |src: &mut R, h: &mut [u8], buf: &mut Vec<u8>| -> io::Result<()> {
            src.seek(SeekFrom::Start(f.pos))?;
            src.read_exact(h)?;
            buf.resize(f.payload_len, 0);
            src.read_exact(buf)
        };
        read(&mut self.src, &mut h, buf).map_err(|e| format!("cannot read frame {index}: {e}"))?;
        // the file may have been replaced since it was indexed
        if le_u32(&h, 0) != FRAME_MAGIC || le_u32(&h, 20) as usize != f.payload_len {
            return Err(format!("frame {index} changed since the file was opened"));
        }
        Ok(f)
    }

    /// Time between the first and the last frame.
    pub fn duration_us(&self) -> u64 {
        match (self.frames.first(), self.frames.last()) {
            (Some(a), Some(b)) => b.capture_time_us.saturating_sub(a.capture_time_us),
            _ => 0,
        }
    }

    /// Frames the hub produced during the recording that are missing in it (sequence gaps).
    pub fn skipped_frames(&self) -> u64 {
        self.frames
            .iter()
            .zip(self.frames.iter().skip(1))
            .map(|(a, b)| u64::from(b.seq.wrapping_sub(a.seq).saturating_sub(1)))
            .filter(|&gap| gap < 1000) // a restarted hub starts counting anew
            .sum()
    }
}

fn frame_at<R: Read + Seek>(src: &mut R, pos: u64, file_len: u64, pixels: usize) -> Result<FrameInfo, String> {
    if file_len - pos < FRAME_HEADER_LEN as u64 {
        return Err("frame header cut off".to_string());
    }
    let mut h = [0u8; FRAME_HEADER_LEN];
    src.seek(SeekFrom::Start(pos)).and_then(|_| src.read_exact(&mut h)).map_err(|e| format!("read error: {e}"))?;
    if le_u32(&h, 0) != FRAME_MAGIC {
        return Err("no frame marker".to_string());
    }
    let flags = le_u16(&h, 16);
    if flags & !FLAG_IR != 0 {
        return Err(format!("unknown frame flags 0x{flags:04X}"));
    }
    let has_ir = flags & FLAG_IR != 0;
    let payload_len = le_u32(&h, 20) as usize;
    let expected = if has_ir { pixels * 3 } else { pixels * 2 };
    if payload_len != expected {
        return Err(format!("frame of {payload_len} bytes, expected {expected}"));
    }
    if file_len - pos - (FRAME_HEADER_LEN as u64) < payload_len as u64 {
        return Err("frame cut off".to_string());
    }
    Ok(FrameInfo { seq: le_u32(&h, 4), capture_time_us: le_u64(&h, 8), has_ir, pos, payload_len })
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use serde_json::json;

    use super::*;

    const W: u16 = 4;
    const H: u16 = 3;
    const PX: usize = (W as usize) * (H as usize);

    fn sample(frames: u32) -> Result<Vec<u8>, String> {
        let lut: Vec<u8> = (0..PX * 2).flat_map(|i| (i as f32 * 0.01).to_le_bytes()).collect();
        let info = json!({"params": {"fx": 365.5}});
        let mut w = Writer::new(Vec::new(), W, H, &info, &lut).map_err(|e| e.to_string())?;
        for i in 0..frames {
            let depth: Vec<u8> = (0..PX).flat_map(|p| (1000 + i as u16 * 10 + p as u16).to_le_bytes()).collect();
            let ir = vec![i as u8; PX];
            let ir = if i % 2 == 0 { Some(ir.as_slice()) } else { None };
            w.frame(100 + i, 1_000_000 + u64::from(i) * 33_333, &depth, ir).map_err(|e| e.to_string())?;
        }
        w.finish().map_err(|e| e.to_string())
    }

    #[test]
    fn round_trip() -> Result<(), String> {
        let mut rec = Recording::read(Cursor::new(sample(5)?))?;
        assert_eq!((rec.width, rec.height, rec.frames.len()), (W, H, 5));
        assert_eq!(rec.info.get("params").and_then(|p| p.get("fx")), Some(&json!(365.5)));
        assert_eq!(rec.lut.get(3), Some(&(3.0 * 0.01)));
        assert_eq!(rec.duration_us(), 4 * 33_333);
        assert!(rec.damaged_tail.is_none());
        let mut buf = Vec::new();
        let f = rec.read_frame(2, &mut buf)?.clone();
        assert_eq!((f.seq, f.has_ir, buf.len()), (102, true, PX * 3));
        assert_eq!(buf.get(..2), Some(&1020u16.to_le_bytes()[..]));
        assert_eq!(buf.last(), Some(&2));
        let f = rec.read_frame(3, &mut buf)?.clone();
        assert_eq!((f.has_ir, buf.len()), (false, PX * 2));
        Ok(())
    }

    #[test]
    fn cut_off_recording_keeps_whole_frames() -> Result<(), String> {
        let mut data = sample(4)?;
        data.truncate(data.len() - 5);
        let rec = Recording::read(Cursor::new(data))?;
        assert_eq!(rec.frames.len(), 3);
        assert!(rec.damaged_tail.is_some());
        Ok(())
    }

    #[test]
    fn rejects_garbage() -> Result<(), String> {
        assert!(Recording::read(Cursor::new(b"hello".to_vec())).is_err());
        assert!(Recording::read(Cursor::new(vec![0u8; 4096])).is_err());
        let mut data = sample(1)?;
        if let Some(b) = data.get_mut(4) {
            *b = 9; // version 9
        }
        assert!(Recording::read(Cursor::new(data)).is_err_and(|e| e.contains("version 9")));
        let header_only = sample(0)?;
        assert!(Recording::read(Cursor::new(header_only)).is_err_and(|e| e.contains("no frames")));
        Ok(())
    }
}
