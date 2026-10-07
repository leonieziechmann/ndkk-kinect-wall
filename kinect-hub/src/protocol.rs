//! Wire formats: the pipe from the capture worker and the messages sent to clients.
//! Everything is little-endian. See README.md for the client side.

use bytes::Bytes;
use serde::Deserialize;

pub const WIDTH: usize = 512;
pub const HEIGHT: usize = 424;
pub const PIXELS: usize = WIDTH * HEIGHT;

// ---- worker -> hub (stdout of fn2_capture.exe) ----

pub const WORKER_MAGIC: u32 = 0x3157_324B; // "K2W1"
pub const WORKER_HEADER_LEN: usize = 32;
/// Upper bound for one worker message; anything larger means the stream is corrupt.
pub const MAX_WORKER_PAYLOAD: usize = 4 << 20;
pub const FLAG_HAS_IR: u16 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkerKind {
    Frame,
    Params,
    Status,
    Heartbeat,
    Unknown(u16),
}

#[derive(Clone, Copy, Debug)]
pub struct WorkerHeader {
    pub kind: WorkerKind,
    pub flags: u16,
    pub payload_len: usize,
    pub seq: u32,
    pub device_ts: u32,
    pub host_time_us: u64,
}

fn le_u16(b: &[u8], at: usize) -> Option<u16> {
    b.get(at..at + 2)?.try_into().ok().map(u16::from_le_bytes)
}

fn le_u32(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4)?.try_into().ok().map(u32::from_le_bytes)
}

fn le_u64(b: &[u8], at: usize) -> Option<u64> {
    b.get(at..at + 8)?.try_into().ok().map(u64::from_le_bytes)
}

pub fn parse_worker_header(b: &[u8; WORKER_HEADER_LEN]) -> Result<WorkerHeader, String> {
    let field = |v: Option<u32>| v.ok_or_else(|| "short header".to_string());
    let magic = field(le_u32(b, 0))?;
    if magic != WORKER_MAGIC {
        return Err(format!("bad magic 0x{magic:08X}"));
    }
    let kind = le_u16(b, 4).ok_or("short header")?;
    let flags = le_u16(b, 6).ok_or("short header")?;
    let payload_len = usize::try_from(field(le_u32(b, 8))?).map_err(|_| "length overflow".to_string())?;
    if payload_len > MAX_WORKER_PAYLOAD {
        return Err(format!("payload of {payload_len} bytes exceeds the limit"));
    }
    Ok(WorkerHeader {
        kind: match kind {
            1 => WorkerKind::Frame,
            2 => WorkerKind::Params,
            3 => WorkerKind::Status,
            4 => WorkerKind::Heartbeat,
            other => WorkerKind::Unknown(other),
        },
        flags,
        payload_len,
        seq: field(le_u32(b, 12))?,
        device_ts: field(le_u32(b, 16))?,
        host_time_us: le_u64(b, 24).ok_or("short header")?,
    })
}

// ---- hub -> clients ----

pub const CLIENT_MAGIC: u32 = 0x3148_324B; // "K2H1"
pub const CLIENT_HEADER_LEN: usize = 32;
pub const PROTOCOL_VERSION: u8 = 1;

/// Everything a client can subscribe to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stream {
    Depth,
    DepthRaw,
    Ir,
    Points,
    Lut,
    Meta,
    Status,
}

impl Stream {
    pub const COUNT: usize = 7;
    pub const ALL: [Stream; Stream::COUNT] = [
        Stream::Depth,
        Stream::DepthRaw,
        Stream::Ir,
        Stream::Points,
        Stream::Lut,
        Stream::Meta,
        Stream::Status,
    ];
    /// Streams that carry one message per sensor frame, in the order they are sent.
    pub const PER_FRAME: [Stream; 5] = [Stream::Depth, Stream::DepthRaw, Stream::Ir, Stream::Points, Stream::Meta];

    pub fn index(self) -> usize {
        match self {
            Stream::Depth => 0,
            Stream::DepthRaw => 1,
            Stream::Ir => 2,
            Stream::Points => 3,
            Stream::Lut => 4,
            Stream::Meta => 5,
            Stream::Status => 6,
        }
    }

    pub fn bit(self) -> u16 {
        1 << self.index()
    }

    pub fn name(self) -> &'static str {
        match self {
            Stream::Depth => "depth",
            Stream::DepthRaw => "depth_raw",
            Stream::Ir => "ir",
            Stream::Points => "points",
            Stream::Lut => "lut",
            Stream::Meta => "meta",
            Stream::Status => "status",
        }
    }

    pub fn parse(s: &str) -> Option<Stream> {
        Stream::ALL.into_iter().find(|st| st.name() == s)
    }

    /// The `kind` byte of the binary header, for binary streams.
    pub fn kind(self) -> Option<u8> {
        match self {
            Stream::Depth => Some(1),
            Stream::DepthRaw => Some(2),
            Stream::Ir => Some(3),
            Stream::Points => Some(4),
            Stream::Lut => Some(16),
            Stream::Meta | Stream::Status => None,
        }
    }

    pub fn describe(self) -> &'static str {
        match self {
            Stream::Depth => "binary kind 1: u16 depth in mm per pixel (0 = no measurement), temporally smoothed",
            Stream::DepthRaw => "binary kind 2: u16 depth in mm, unfiltered",
            Stream::Ir => "binary kind 3: u8 infrared brightness (sqrt tone-mapped)",
            Stream::Points => "binary kind 4: i16 x,y,z in mm per pixel (camera frame: x right, y down, z forward)",
            Stream::Lut => "JSON {type:'params'} + binary kind 16: f32 x,y per pixel; point = (x*z, y*z, z)",
            Stream::Meta => "JSON {type:'frame'} per frame: seq, timestamps, depth statistics",
            Stream::Status => "JSON {type:'status'} once per second: sensor state, fps, latency, clients",
        }
    }
}

/// The 32-byte header of a binary client message:
/// u32 magic "K2H1" | u8 kind | u8 version | u16 header_len | u32 seq | u16 width | u16 height
/// | u64 capture_time_us | u64 publish_time_us
pub fn header(stream: Stream, seq: u32, capture_us: u64, publish_us: u64) -> [u8; CLIENT_HEADER_LEN] {
    let mut h = [0u8; CLIENT_HEADER_LEN];
    let parts: [&[u8]; 9] = [
        &CLIENT_MAGIC.to_le_bytes(),
        &[stream.kind().unwrap_or(0)],
        &[PROTOCOL_VERSION],
        &(CLIENT_HEADER_LEN as u16).to_le_bytes(),
        &seq.to_le_bytes(),
        &(WIDTH as u16).to_le_bytes(),
        &(HEIGHT as u16).to_le_bytes(),
        &capture_us.to_le_bytes(),
        &publish_us.to_le_bytes(),
    ];
    let mut at = 0;
    for part in parts {
        if let Some(dst) = h.get_mut(at..at + part.len()) {
            dst.copy_from_slice(part);
        }
        at += part.len();
    }
    h
}

/// A binary client message under construction: the payload is written in place (no copies),
/// the header is filled in when the frame is published.
pub struct MessageBuf(Vec<u8>);

impl MessageBuf {
    pub fn new(payload_len: usize) -> MessageBuf {
        MessageBuf(vec![0; CLIENT_HEADER_LEN + payload_len])
    }

    pub fn payload_mut(&mut self) -> &mut [u8] {
        self.0.get_mut(CLIENT_HEADER_LEN..).unwrap_or_default()
    }

    pub fn finish(mut self, stream: Stream, seq: u32, capture_us: u64, publish_us: u64) -> Bytes {
        if let Some(dst) = self.0.get_mut(..CLIENT_HEADER_LEN) {
            dst.copy_from_slice(&header(stream, seq, capture_us, publish_us));
        }
        Bytes::from(self.0)
    }
}

pub fn f32_message(stream: Stream, seq: u32, capture_us: u64, publish_us: u64, data: &[f32]) -> Bytes {
    let mut m = MessageBuf::new(data.len() * 4);
    for (dst, v) in m.payload_mut().as_chunks_mut::<4>().0.iter_mut().zip(data) {
        *dst = v.to_le_bytes();
    }
    m.finish(stream, seq, capture_us, publish_us)
}

/// Returns the payload of a binary client message (without the header).
pub fn payload(msg: &Bytes) -> Bytes {
    if msg.len() >= CLIENT_HEADER_LEN { msg.slice(CLIENT_HEADER_LEN..) } else { Bytes::new() }
}

/// JSON control messages a client may send.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientRequest {
    /// Replaces the set of subscribed streams. `max_fps` limits per-frame streams for this client.
    Subscribe {
        streams: Vec<String>,
        #[serde(default)]
        max_fps: Option<f64>,
    },
    /// Answered with `pong`, echoing `t`; useful for round-trip and clock-offset estimates.
    Ping {
        #[serde(default)]
        t: Option<serde_json::Value>,
    },
}
