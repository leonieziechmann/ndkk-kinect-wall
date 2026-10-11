//! The kinect-hub client (port of web/lib/kinect-stream.js): one thread owns the WebSocket, parses
//! every message and decodes the persons' masks, and hands the results to the main thread as
//! shared, ready-to-upload arrays. The render loop never waits for the network.
//!
//! Protocol: kinect-hub/README.md (binary header K2H1, streams, subscribe/ping/render).

use std::collections::VecDeque;
use std::io::ErrorKind;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crossbeam_channel::{Receiver, Sender, TryRecvError};
use serde::Deserialize;
use tungstenite::Message;
use tungstenite::client::IntoClientRequest;

use crate::persons::{F, Floor, N, PersonsResult, RawPerson};

// ---------- clocks ----------

static START: OnceLock<(Instant, u64)> = OnceLock::new();

fn start() -> &'static (Instant, u64) {
    START.get_or_init(|| (Instant::now(), SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0)))
}

/// Milliseconds since the app started (monotonic): the time base of the whole output.
pub fn mono_ms() -> f64 {
    start().0.elapsed().as_secs_f64() * 1000.0
}

/// System time (µs since 1970) at a monotonic time.
pub fn system_us_at(mono: f64) -> f64 {
    start().1 as f64 + mono * 1000.0
}

/// Monotonic ms of a system time in µs (with the hub's clock offset: server - local).
pub fn mono_of_system_us(us: f64, offset_us: f64) -> f64 {
    (us - offset_us - start().1 as f64) / 1000.0
}

// ---------- frames ----------

#[allow(dead_code)]
pub struct DepthFrame {
    pub seq: u32,
    pub capture_time_us: u64,
    /// mono ms when it arrived
    pub arrived: f64,
    /// mm, 0 = no measurement (temporally smoothed)
    pub mm: Arc<Vec<u16>>,
    /// meters (GPU depthTexture)
    pub meters: Arc<Vec<f32>>,
}

#[allow(dead_code)]
pub struct IrFrame {
    pub seq: u32,
    pub capture_time_us: u64,
    pub arrived: f64,
    pub data: Arc<Vec<u8>>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[allow(dead_code)]
pub struct HubStatus {
    #[serde(default)]
    pub fps: F,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub sensor: Option<SensorStatus>,
    #[serde(default)]
    pub tracking: Option<StateDetail>,
    #[serde(default)]
    pub pose: Option<StateDetail>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct SensorStatus {
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[allow(dead_code)]
pub struct StateDetail {
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PersonsKind {
    /// delayed output (exact skeletons): stream `persons`, labels kind 5
    Exact,
    /// every frame at once: stream `persons_live`, labels kind 6
    Live,
}

#[allow(dead_code)]
pub enum HubEvent {
    Open,
    Closed,
    Hello { streams: Vec<String>, accepts: Vec<String> },
    Status(Arc<HubStatus>, Arc<serde_json::Value>),
    Depth(Arc<DepthFrame>),
    Ir(Arc<IrFrame>),
    /// ray x, y per pixel: point = (x·z, y·z, z)
    Lut(Arc<Vec<f32>>),
    Meta(Arc<serde_json::Value>),
    Persons(PersonsKind, Arc<PersonsResult>),
    /// server clock - local clock (µs)
    Clock(f64),
}

pub enum HubCommand {
    Subscribe(Vec<String>),
    Render { fps: f64, target: f64, visible: bool, scene: String },
}

/// The client: a thread and the two channels to it.
pub struct HubClient {
    pub events: Receiver<HubEvent>,
    commands: Sender<HubCommand>,
}

impl HubClient {
    pub fn start(ws_url: String) -> Self {
        let (ev_tx, ev_rx) = crossbeam_channel::bounded(1024);
        let (cmd_tx, cmd_rx) = crossbeam_channel::unbounded();
        let _ = std::thread::Builder::new().name("kinect-hub".into()).spawn(move || {
            let mut streams: Vec<String> = vec!["lut".into(), "meta".into(), "status".into()];
            // a panic in the decoding must not end the data: the thread starts over (same streams)
            loop {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&ws_url, &ev_tx, &cmd_rx, &mut streams))) {
                    Ok(()) => return, // the output ended
                    Err(_) => {
                        bevy::log::error!("kinect-hub: Absturz im Empfang, starte neu");
                        let _ = ev_tx.try_send(HubEvent::Closed);
                        std::thread::sleep(Duration::from_millis(500));
                    }
                }
            }
        });
        Self { events: ev_rx, commands: cmd_tx }
    }

    pub fn send(&self, cmd: HubCommand) {
        let _ = self.commands.send(cmd);
    }
}

// ---------- the thread ----------

const MAGIC: u32 = 0x3148_324b; // "K2H1"

/// Reusable big arrays: a buffer comes back once nobody else holds it any more.
struct Pool<T: Clone + Default> {
    free: Vec<Arc<Vec<T>>>,
    len: usize,
}

impl<T: Clone + Default> Pool<T> {
    fn new(len: usize) -> Self {
        Self { free: Vec::new(), len }
    }
    /// A buffer only this pool holds (contents unspecified).
    fn take(&mut self) -> Arc<Vec<T>> {
        if let Some(i) = self.free.iter_mut().position(|a| Arc::get_mut(a).is_some()) {
            return self.free.swap_remove(i);
        }
        Arc::new(vec![T::default(); self.len])
    }
    /// Keeps a clone to reuse it once the others dropped theirs.
    fn keep(&mut self, a: &Arc<Vec<T>>) {
        if self.free.len() < 24 {
            self.free.push(a.clone());
        }
    }
}

struct State {
    ev: Sender<HubEvent>,
    depth_ring: VecDeque<Arc<DepthFrame>>,
    pending: [Option<PendingPersons>; 2],
    best_rtt: f64,
    mm_pool: Pool<u16>,
    m_pool: Pool<f32>,
    label_pool: Pool<u8>,
    pmm_pool: Pool<u16>,
    pm_pool: Pool<f32>,
    idx_pool: Pool<u32>,
}

struct PendingPersons {
    seq: u32,
    capture_time_us: u64,
    list: Vec<RawPerson>,
    floor: Option<Floor>,
    ms: f64,
    pose_ms: f64,
    pose_runs: u64,
}

#[derive(Deserialize)]
struct PersonsMsg {
    seq: u32,
    capture_time_us: u64,
    #[serde(default)]
    persons: Vec<RawPerson>,
    #[serde(default)]
    floor: Option<Floor>,
    #[serde(default)]
    ms: F,
    #[serde(default)]
    pose_ms: F,
    #[serde(default)]
    pose_runs: Option<u64>,
}

fn run(url: &str, ev: &Sender<HubEvent>, cmd: &Receiver<HubCommand>, streams: &mut Vec<String>) {
    let mut st = State {
        ev: ev.clone(),
        depth_ring: VecDeque::new(),
        pending: [None, None],
        best_rtt: f64::INFINITY,
        mm_pool: Pool::new(N),
        m_pool: Pool::new(N),
        label_pool: Pool::new(N),
        pmm_pool: Pool::new(N),
        pm_pool: Pool::new(N),
        idx_pool: Pool::new(N),
    };
    let mut retry = Duration::from_millis(250);
    loop {
        match connect(&url) {
            Ok(mut ws) => {
                retry = Duration::from_millis(250);
                st.best_rtt = f64::INFINITY;
                st.pending = [None, None];
                let _ = st.ev.try_send(HubEvent::Open);
                let opened = mono_ms();
                let mut pings = vec![0.0, 150.0, 400.0, 900.0, 2000.0];
                let mut next_ping = opened + 5000.0;
                let _ = send_json(&mut ws, &serde_json::json!({ "type": "subscribe", "streams": streams }));
                let reason = loop {
                    // commands from the main thread
                    let mut stop = None;
                    loop {
                        match cmd.try_recv() {
                            Ok(HubCommand::Subscribe(s)) => {
                                *streams = s;
                                if let Err(e) = send_json(&mut ws, &serde_json::json!({ "type": "subscribe", "streams": streams })) {
                                    stop = Some(e);
                                }
                            }
                            Ok(HubCommand::Render { fps, target, visible, scene }) => {
                                if let Err(e) = send_json(&mut ws, &serde_json::json!({ "type": "render", "fps": fps, "target": target, "visible": visible, "scene": scene })) {
                                    stop = Some(e);
                                }
                            }
                            Err(TryRecvError::Empty) => break,
                            Err(TryRecvError::Disconnected) => return,
                        }
                    }
                    if let Some(e) = stop {
                        break e;
                    }
                    let now = mono_ms();
                    if pings.first().is_some_and(|t| now - opened >= *t) || now >= next_ping {
                        if pings.first().is_some_and(|t| now - opened >= *t) {
                            pings.remove(0);
                        } else {
                            next_ping = now + 5000.0;
                        }
                        if let Err(e) = send_json(&mut ws, &serde_json::json!({ "type": "ping", "t": now })) {
                            break e;
                        }
                    }
                    match ws.read() {
                        Ok(Message::Binary(b)) => st.binary(&b),
                        Ok(Message::Text(t)) => st.text(t.as_str()),
                        Ok(Message::Close(_)) => break "geschlossen".to_string(),
                        Ok(_) => {}
                        Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                        Err(e) => break e.to_string(),
                    }
                };
                bevy::log::warn!("kinect-hub: Verbindung weg ({reason}), verbinde neu");
                let _ = st.ev.try_send(HubEvent::Closed);
            }
            Err(e) => {
                if retry >= Duration::from_secs(4) {
                    bevy::log::debug!("kinect-hub {url}: {e}");
                }
            }
        }
        if matches!(cmd.try_recv(), Err(TryRecvError::Disconnected)) {
            return;
        }
        std::thread::sleep(retry);
        retry = (retry * 2).min(Duration::from_secs(4));
    }
}

type Ws = tungstenite::WebSocket<TcpStream>;

/// Opens a WebSocket with timeouts (no Origin header; a short read timeout lets the thread send).
pub fn connect_ws(url: &str, protocol: Option<&str>) -> Result<Ws, String> {
    let mut req = url.into_client_request().map_err(|e| e.to_string())?;
    if let Some(p) = protocol {
        req.headers_mut().insert("Sec-WebSocket-Protocol", p.parse().map_err(|_| "protocol")?);
    }
    let host = req.uri().host().unwrap_or("127.0.0.1").to_string();
    let port = req.uri().port_u16().unwrap_or(80);
    let addr = (host.as_str(), port).to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("keine Adresse")?;
    let stream = TcpStream::connect_timeout(&addr, Duration::from_millis(1500)).map_err(|e| e.to_string())?;
    stream.set_nodelay(true).ok();
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(3))).ok();
    let (ws, _) = tungstenite::client(req, stream).map_err(|e| e.to_string())?;
    ws.get_ref().set_read_timeout(Some(Duration::from_millis(20))).ok();
    Ok(ws)
}

fn connect(url: &str) -> Result<Ws, String> {
    connect_ws(url, None)
}

pub fn send_json(ws: &mut Ws, v: &serde_json::Value) -> Result<(), String> {
    ws.send(Message::text(v.to_string())).map_err(|e| e.to_string())
}

fn u16le(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}
fn u32le(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}
fn u64le(b: &[u8], at: usize) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[at..at + 8]);
    u64::from_le_bytes(a)
}

impl State {
    fn send(&self, e: HubEvent) {
        // never blocks: a stalled main thread loses frames, not the connection
        let _ = self.ev.try_send(e);
    }

    fn text(&mut self, t: &str) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(t) else {
            return;
        };
        let kind = v.get("type").and_then(|x| x.as_str()).unwrap_or("").to_string();
        match kind.as_str() {
            "hello" => {
                let streams = v
                    .get("streams")
                    .and_then(|s| s.as_array())
                    .map(|a| a.iter().filter_map(|x| x.get("name").and_then(|n| n.as_str()).or_else(|| x.as_str()).map(String::from)).collect())
                    .unwrap_or_default();
                let accepts = v.get("accepts").and_then(|s| s.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                self.send(HubEvent::Hello { streams, accepts });
            }
            "status" => {
                let s: HubStatus = serde_json::from_value(v.clone()).unwrap_or_default();
                self.send(HubEvent::Status(Arc::new(s), Arc::new(v)));
            }
            "frame" => self.send(HubEvent::Meta(Arc::new(v))),
            "pong" => {
                let now = mono_ms();
                let (Some(t), Some(server)) = (v.get("t").and_then(|x| x.as_f64()), v.get("server_time_us").and_then(|x| x.as_f64())) else {
                    return;
                };
                let rtt = now - t;
                if rtt <= self.best_rtt * 1.5 {
                    self.best_rtt = self.best_rtt.min(rtt);
                    let local_mid = system_us_at(t + rtt / 2.0);
                    self.send(HubEvent::Clock(server - local_mid));
                }
            }
            "persons" | "persons_live" => {
                let Ok(m) = serde_json::from_value::<PersonsMsg>(v) else {
                    return;
                };
                let slot = usize::from(kind == "persons_live");
                self.pending[slot] = Some(PendingPersons {
                    seq: m.seq,
                    capture_time_us: m.capture_time_us,
                    list: m.persons,
                    floor: m.floor,
                    ms: m.ms.0,
                    pose_ms: if m.pose_ms.0.is_finite() { m.pose_ms.0 } else { 0.0 },
                    pose_runs: m.pose_runs.unwrap_or(0),
                });
            }
            "error" => bevy::log::warn!("kinect-hub: {t}"),
            _ => {}
        }
    }

    fn binary(&mut self, b: &[u8]) {
        if b.len() < 32 || u32le(b, 0) != MAGIC {
            return;
        }
        let kind = b[4];
        let header = usize::from(u16le(b, 6));
        let seq = u32le(b, 8);
        let (w, h) = (usize::from(u16le(b, 12)), usize::from(u16le(b, 14)));
        let capture = u64le(b, 16);
        let Some(payload) = b.get(header..) else {
            return;
        };
        let n = w * h;
        let now = mono_ms();
        match kind {
            1 => {
                if n != N || payload.len() < N * 2 {
                    return;
                }
                let mut mm = self.mm_pool.take();
                let mut m = self.m_pool.take();
                {
                    let (mmv, mv) = (Arc::get_mut(&mut mm), Arc::get_mut(&mut m));
                    let (Some(mmv), Some(mv)) = (mmv, mv) else { return };
                    for (i, c) in payload.chunks_exact(2).take(N).enumerate() {
                        let v = u16::from_le_bytes([c[0], c[1]]);
                        mmv[i] = v;
                        mv[i] = f32::from(v) * 0.001;
                    }
                }
                self.mm_pool.keep(&mm);
                self.m_pool.keep(&m);
                let f = Arc::new(DepthFrame { seq, capture_time_us: capture, arrived: now, mm, meters: m });
                self.depth_ring.push_back(f.clone());
                while self.depth_ring.len() > 48 {
                    self.depth_ring.pop_front();
                }
                self.send(HubEvent::Depth(f));
            }
            3 => {
                if n != N || payload.len() < N {
                    return;
                }
                let data = Arc::new(payload[..N].to_vec());
                self.send(HubEvent::Ir(Arc::new(IrFrame { seq, capture_time_us: capture, arrived: now, data })));
            }
            5 | 6 => self.labels(if kind == 5 { 0 } else { 1 }, seq, payload),
            16 => {
                if n != N || payload.len() < N * 8 {
                    return;
                }
                let lut: Vec<f32> = payload.chunks_exact(4).take(N * 2).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
                self.send(HubEvent::Lut(Arc::new(lut)));
            }
            _ => {}
        }
    }

    /// The labels of a persons result (runs: u8 slot, u16 length), with its depth frame.
    fn labels(&mut self, slot: usize, seq: u32, rle: &[u8]) {
        let Some(m) = self.pending[slot].take_if(|m| m.seq == seq) else {
            return;
        };
        let mut labels = self.label_pool.take();
        let mut pmm = self.pmm_pool.take();
        let mut pm = self.pm_pool.take();
        let mut idx = self.idx_pool.take();
        let depth = self.depth_ring.iter().rev().find(|d| d.seq == seq).cloned();
        let count;
        {
            let (Some(l), Some(dmm), Some(dm), Some(ix)) = (Arc::get_mut(&mut labels), Arc::get_mut(&mut pmm), Arc::get_mut(&mut pm), Arc::get_mut(&mut idx)) else {
                return;
            };
            let mut at = 0usize;
            for r in rle.chunks_exact(3) {
                if at >= N {
                    break;
                }
                let end = (at + usize::from(u16::from_le_bytes([r[1], r[2]]))).min(N);
                l[at..end].fill(r[0]);
                at = end;
            }
            if at < N {
                l[at..].fill(0);
            }
            let mut k = 0usize;
            match &depth {
                Some(d) => {
                    for i in 0..N {
                        if l[i] == 0 {
                            dmm[i] = 0;
                            dm[i] = 0.0;
                        } else {
                            dmm[i] = d.mm[i];
                            dm[i] = d.meters[i];
                            ix[k] = i as u32;
                            k += 1;
                        }
                    }
                }
                None => {
                    for i in 0..N {
                        dmm[i] = 0;
                        dm[i] = 0.0;
                        if l[i] != 0 {
                            ix[k] = i as u32;
                            k += 1;
                        }
                    }
                }
            }
            count = k;
        }
        self.label_pool.keep(&labels);
        self.pmm_pool.keep(&pmm);
        self.pm_pool.keep(&pm);
        self.idx_pool.keep(&idx);
        let arrived = depth.as_ref().map(|d| d.arrived).unwrap_or_else(mono_ms);
        let result = PersonsResult {
            seq,
            capture_time_us: m.capture_time_us,
            list: Arc::new(m.list),
            floor: m.floor,
            labels: Some(labels),
            depth: Some(pmm),
            meters: Some(pm),
            indices: Some(idx),
            count,
            ms: m.ms,
            pose_ms: m.pose_ms,
            pose_runs: m.pose_runs,
            arrived,
            lag: 0.0,
        };
        self.send(HubEvent::Persons(if slot == 0 { PersonsKind::Exact } else { PersonsKind::Live }, Arc::new(result)));
    }
}
