//! kinect-hub-probe: measures and abuses a running kinect-hub, and records from it.
//!
//!   kinect-hub-probe stream [--url ws://127.0.0.1:8090/ws] [--clients N] [--seconds S] [--streams depth,ir]
//!       N clients subscribe; prints frames/s, latency (sensor capture -> client) and sequence gaps
//!   kinect-hub-probe abuse [--url ...]
//!       one healthy client keeps measuring while others misbehave (garbage, flooding, oversized
//!       messages, a client that stops reading, connection churn, too many clients, PNG requests,
//!       junk and floods against the dev server registry)
//!   kinect-hub-probe record --out recordings/NAME.k2rec [--url ...] [--seconds S]
//!       records depth_raw + ir with their capture timestamps from the running hub (never from the
//!       sensor itself) for `kinect-hub --source replay FILE`; the format is in src/recording.rs

#[path = "../recording.rs"]
mod recording;

use std::collections::HashMap;
use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

fn now_us() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0)
}

struct Args {
    mode: String,
    url: String,
    clients: usize,
    seconds: u64,
    streams: Vec<String>,
    out: Option<PathBuf>,
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args {
        mode: "stream".into(),
        url: "ws://127.0.0.1:8090/ws".into(),
        clients: 1,
        seconds: 10,
        streams: vec!["depth".into()],
        out: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut val = || it.next().ok_or(format!("{arg} needs a value"));
        match arg.as_str() {
            "stream" | "abuse" | "record" => a.mode = arg.clone(),
            "--url" => a.url = val()?,
            "--clients" => a.clients = val()?.parse().map_err(|e| format!("--clients: {e}"))?,
            "--seconds" => a.seconds = val()?.parse().map_err(|e| format!("--seconds: {e}"))?,
            "--streams" => a.streams = val()?.split(',').map(str::to_string).collect(),
            "--out" => a.out = Some(PathBuf::from(val()?)),
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(a)
}

/// Statistics of one measuring client.
#[derive(Default)]
struct Measure {
    frames: HashMap<u8, u64>,
    latency_sum_ms: f64,
    latency_max_ms: f64,
    latency_n: u64,
    gaps: u64,
    last_seq: Option<u32>,
    bytes: u64,
    texts: u64,
}

impl Measure {
    fn on_binary(&mut self, b: &[u8]) {
        self.bytes += b.len() as u64;
        let (Some(kind), Some(seq), Some(cap)) = (
            b.get(4).copied(),
            b.get(8..12).and_then(|s| s.try_into().ok()).map(u32::from_le_bytes),
            b.get(16..24).and_then(|s| s.try_into().ok()).map(u64::from_le_bytes),
        ) else {
            return;
        };
        *self.frames.entry(kind).or_default() += 1;
        if kind == 1 || (kind == 2 && !self.frames.contains_key(&1)) {
            let lat = now_us().saturating_sub(cap) as f64 / 1000.0;
            self.latency_sum_ms += lat;
            self.latency_max_ms = self.latency_max_ms.max(lat);
            self.latency_n += 1;
            if let Some(last) = self.last_seq
                && seq > last + 1 {
                    self.gaps += u64::from(seq - last - 1);
                }
            self.last_seq = Some(seq);
        }
    }

    fn summary(&self, secs: f64) -> String {
        let mut kinds: Vec<_> = self.frames.iter().collect();
        kinds.sort();
        let rates: Vec<String> = kinds.iter().map(|(k, n)| format!("kind{k} {:.1}/s", **n as f64 / secs)).collect();
        format!(
            "{} | latency avg {:.1} ms max {:.1} ms | skipped frames {} | {:.1} MB/s | {} text msgs",
            rates.join(", "),
            if self.latency_n > 0 { self.latency_sum_ms / self.latency_n as f64 } else { 0.0 },
            self.latency_max_ms,
            self.gaps,
            self.bytes as f64 / secs / 1e6,
            self.texts
        )
    }
}

async fn measuring_client(url: String, streams: Vec<String>, seconds: u64, stop: Arc<AtomicBool>) -> Result<(Measure, f64), String> {
    let (ws, _) = connect_async(url.as_str()).await.map_err(|e| format!("connect: {e}"))?;
    let (mut tx, mut rx) = ws.split();
    let sub = serde_json::json!({"type": "subscribe", "streams": streams}).to_string();
    tx.send(Message::text(sub)).await.map_err(|e| format!("subscribe: {e}"))?;
    let mut m = Measure::default();
    let start = Instant::now();
    let end = start + Duration::from_secs(seconds);
    while Instant::now() < end && !stop.load(Ordering::Relaxed) {
        match tokio::time::timeout(Duration::from_millis(500), rx.next()).await {
            Ok(Some(Ok(Message::Binary(b)))) => m.on_binary(&b),
            Ok(Some(Ok(Message::Text(_)))) => m.texts += 1,
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(format!("receive: {e}")),
            Ok(None) => return Err("closed by server".into()),
            Err(_) => {}
        }
    }
    let _ = tx.send(Message::Close(None)).await;
    Ok((m, start.elapsed().as_secs_f64()))
}

async fn http_get(url: &str, path: &str) -> Result<(u16, Vec<u8>), String> {
    http_request(url, "GET", path, "", b"").await
}

/// Minimal HTTP/1.1 client; `headers` are extra header lines, each ending in \r\n.
async fn http_request(url: &str, method: &str, path: &str, headers: &str, body: &[u8]) -> Result<(u16, Vec<u8>), String> {
    let host = url.trim_start_matches("ws://").split('/').next().unwrap_or("127.0.0.1:8090").to_string();
    let mut s = TcpStream::connect(&host).await.map_err(|e| e.to_string())?;
    let req = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n", body.len());
    s.write_all(req.as_bytes()).await.map_err(|e| e.to_string())?;
    // the server may answer (413) and close before the whole body is sent: still read the answer
    let _ = s.write_all(body).await;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.map_err(|e| e.to_string())?;
    let code = std::str::from_utf8(buf.get(9..12).unwrap_or_default()).ok().and_then(|c| c.parse().ok()).unwrap_or(0);
    let body = match buf.windows(4).position(|w| w == b"\r\n\r\n") {
        Some(i) => buf.get(i + 4..).unwrap_or_default().to_vec(),
        None => Vec::new(),
    };
    Ok((code, body))
}

async fn run_stream(a: &Args) {
    let stop = Arc::new(AtomicBool::new(false));
    let tasks: Vec<_> = (0..a.clients)
        .map(|_| tokio::spawn(measuring_client(a.url.clone(), a.streams.clone(), a.seconds, stop.clone())))
        .collect();
    for (i, t) in tasks.into_iter().enumerate() {
        match t.await {
            Ok(Ok((m, secs))) => println!("client {i:2}: {}", m.summary(secs)),
            Ok(Err(e)) => println!("client {i:2}: FAILED {e}"),
            Err(e) => println!("client {i:2}: task failed {e}"),
        }
    }
}

/// Sends a message and reports how the server reacts within `wait`.
async fn reaction(url: &str, msgs: Vec<Message>, wait: Duration) -> String {
    let Ok((ws, _)) = connect_async(url).await else { return "connect failed".into() };
    let (mut tx, mut rx) = ws.split();
    for m in msgs {
        if let Err(e) = tx.send(m).await {
            return format!("send failed: {e}");
        }
    }
    let mut errors = 0;
    let end = Instant::now() + wait;
    while Instant::now() < end {
        match tokio::time::timeout(Duration::from_millis(200), rx.next()).await {
            Ok(Some(Ok(Message::Text(t)))) if t.as_str().contains("\"error\"") => errors += 1,
            Ok(Some(Ok(Message::Close(f)))) => return format!("server closed: {:?} (after {errors} error replies)", f.map(|f| f.code)),
            Ok(Some(Err(e))) => return format!("connection ended: {e} (after {errors} error replies)"),
            Ok(None) => return format!("connection ended (after {errors} error replies)"),
            _ => {}
        }
    }
    format!("still connected, {errors} error replies")
}

async fn run_abuse(a: &Args) {
    let url = a.url.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let healthy_secs = 50;
    println!("healthy client measures for {healthy_secs} s while the attacks run ...");
    let healthy = tokio::spawn(measuring_client(url.clone(), vec!["depth".into(), "ir".into(), "meta".into()], healthy_secs, stop.clone()));
    tokio::time::sleep(Duration::from_secs(2)).await;

    let garbage = vec![
        Message::text("not json"),
        Message::text("{\"type\":\"subscribe\"}"),
        Message::text("{\"type\":\"subscribe\",\"streams\":\"depth\"}"),
        Message::text("{\"type\":\"subscribe\",\"streams\":[\"depth\",\"nope\",\"../../etc\"]}"),
        Message::text("{\"type\":\"launch_missiles\"}"),
        Message::text("{\"type\":\"subscribe\",\"streams\":[],\"max_fps\":-5}"),
        Message::text("{\"type\":\"subscribe\",\"streams\":[\"depth\"],\"max_fps\":1e308}"),
        Message::text("{\"type\":\"subscribe\",\"streams\":[\"depth\"],\"max_fps\":0}"),
        Message::binary(vec![0u8; 1000]),
        Message::text("[]"),
        Message::text("\u{0}\u{1}\u{2}"),
    ];
    println!("garbage messages:      {}", reaction(&url, garbage, Duration::from_secs(2)).await);
    let flood: Vec<Message> = (0..200).map(|_| Message::text("{\"type\":\"ping\"}")).collect();
    println!("flood (200 msgs):      {}", reaction(&url, flood, Duration::from_secs(2)).await);
    println!("oversized (200 KB):    {}", reaction(&url, vec![Message::text("x".repeat(200_000))], Duration::from_secs(2)).await);

    // a client that subscribes to everything and never reads again
    let slow = {
        let url = url.clone();
        tokio::spawn(async move {
            let Ok((mut ws, _)) = connect_async(url.as_str()).await else { return "connect failed".to_string() };
            let sub = "{\"type\":\"subscribe\",\"streams\":[\"depth\",\"depth_raw\",\"ir\",\"points\",\"meta\",\"lut\"]}";
            if ws.send(Message::text(sub)).await.is_err() {
                return "subscribe failed".into();
            }
            tokio::time::sleep(Duration::from_secs(20)).await; // not reading: TCP buffers fill up
            let mut received = 0u64;
            let verdict = loop {
                match tokio::time::timeout(Duration::from_secs(3), ws.next()).await {
                    Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_))) => break "disconnected by the server (as intended)",
                    Ok(Some(Ok(_))) => received += 1,
                    Err(_) => break "still connected, nothing arrives",
                }
                if received > 100_000 {
                    break "still connected and streaming";
                }
            };
            format!("{verdict}; drained {received} buffered messages")
        })
    };

    // connection churn, half of them dropped without a close handshake
    let churn_ok = Arc::new(AtomicU64::new(0));
    let churn: Vec<_> = (0..300)
        .map(|i| {
            let (url, ok) = (url.clone(), churn_ok.clone());
            tokio::spawn(async move {
                if let Ok((mut ws, _)) = connect_async(url.as_str()).await {
                    let _ = ws.send(Message::text("{\"type\":\"subscribe\",\"streams\":[\"depth\",\"points\"]}")).await;
                    let _ = tokio::time::timeout(Duration::from_millis(100), ws.next()).await;
                    if i % 2 == 0 {
                        let _ = ws.close(None).await;
                    }
                    ok.fetch_add(1, Ordering::Relaxed);
                }
            })
        })
        .collect();
    for t in churn {
        let _ = t.await;
    }
    println!("connection churn:      {} of 300 connected", churn_ok.load(Ordering::Relaxed));

    // more clients than allowed
    let mut held = Vec::new();
    let mut rejected = 0;
    for _ in 0..80 {
        match connect_async(url.as_str()).await {
            Ok((ws, _)) => held.push(ws),
            Err(_) => rejected += 1,
        }
    }
    println!("80 extra connections:  {} accepted, {rejected} rejected", held.len());
    drop(held);

    // heavy HTTP in parallel
    let pngs: Vec<_> = (0..40).map(|_| { let u = url.clone(); tokio::spawn(async move { http_get(&u, "/api/frame/depth?format=png").await }) }).collect();
    let mut ok = 0;
    for p in pngs {
        if let Ok(Ok((200, body))) = p.await
            && body.starts_with(b"\x89PNG") {
                ok += 1;
            }
    }
    println!("40 parallel PNGs:      {ok} ok");

    println!("dev server registry:   {}", abuse_registry(&url).await);

    match slow.await {
        Ok(v) => println!("client that never reads: {v}"),
        Err(e) => println!("client that never reads: task failed {e}"),
    }

    match healthy.await {
        Ok(Ok((m, secs))) => println!("healthy client:        {}", m.summary(secs)),
        Ok(Err(e)) => println!("healthy client:        FAILED {e}"),
        Err(e) => println!("healthy client:        task failed {e}"),
    }
    stop.store(true, Ordering::Relaxed);
    tokio::time::sleep(Duration::from_secs(1)).await;
    match http_get(&url, "/api/status").await {
        Ok((code, body)) => {
            let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
            println!(
                "hub afterwards: HTTP {code}, fps {}, clients {}, errors {}",
                v.get("fps").cloned().unwrap_or_default(),
                v.get("clients").cloned().unwrap_or_default(),
                v.get("errors").cloned().unwrap_or_default()
            );
        }
        Err(e) => println!("hub afterwards: UNREACHABLE {e}"),
    }
}

/// Junk, foreign URLs, browser origins, oversized bodies and more registrations than allowed.
async fn abuse_registry(url: &str) -> String {
    const JSON: &str = "Content-Type: application/json\r\n";
    let code = |r: Result<(u16, Vec<u8>), String>| r.map(|(c, _)| c.to_string()).unwrap_or_else(|e| format!("closed ({e})"));
    let post = |headers: &'static str, body: String| async move { http_request(url, "POST", "/api/devservers", headers, body.as_bytes()).await };
    let mut unexpected = Vec::new();
    let mut check = |what: &str, got: String, ok: &[&str]| {
        if !ok.iter().any(|o| got.starts_with(o)) {
            unexpected.push(format!("{what}: {got}"));
        }
        format!("{what} {got}")
    };
    let valid = r#"{"url":"http://127.0.0.1:1"}"#.to_string();
    let huge = format!(r#"{{"url":"http://127.0.0.1:1","label":"{}"}}"#, "x".repeat(200_000));
    let mut parts = vec![
        check("text/plain", code(post("Content-Type: text/plain\r\n", valid.clone()).await), &["415"]),
        check("broken json", code(post(JSON, r#"{"url":"#.to_string()).await), &["400"]),
        check("foreign url", code(post(JSON, r#"{"url":"http://evil.example:80"}"#.to_string()).await), &["400"]),
        check("browser origin", code(post("Content-Type: application/json\r\nOrigin: http://evil.example\r\n", valid).await), &["403"]),
        check("200 KB", code(post(JSON, huge).await), &["413", "closed"]),
    ];
    // more registrations than allowed, then sign all of them off again
    let (mut accepted, mut full) = (0, 0);
    for port in 41000..41070 {
        let body = format!(r#"{{"url":"http://127.0.0.1:{port}","label":"probe","scenes":[{{"name":"x","title":"<script>"}}]}}"#);
        match post(JSON, body).await {
            Ok((200, _)) => accepted += 1,
            Ok((503, _)) => full += 1,
            other => unexpected.push(format!("registration: {}", code(other))),
        }
    }
    let listed = match http_get(url, "/api/devservers").await {
        Ok((200, body)) => serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| {
                let list = v.get("devservers")?.as_array()?;
                Some(list.iter().filter(|e| e.get("label").and_then(|l| l.as_str()) == Some("probe")).count())
            })
            .unwrap_or(0),
        _ => 0,
    };
    let mut removed = 0;
    for port in 41000..41070 {
        if let Ok((200, _)) = http_request(url, "DELETE", &format!("/api/devservers?url=http://127.0.0.1:{port}"), "", b"").await {
            removed += 1;
        }
    }
    if full == 0 || accepted != listed || removed != accepted {
        unexpected.push(format!("70 registrations: {accepted} accepted, {full} full, {listed} listed, {removed} removed"));
    }
    parts.push(format!("70 registrations: {accepted} ok / {full} full / {listed} listed / {removed} removed"));
    let verdict = if unexpected.is_empty() { "OK".to_string() } else { format!("UNEXPECTED: {}", unexpected.join("; ")) };
    format!("{} -> {verdict}", parts.join(", "))
}

/// State of `record`: camera parameters and LUT come first, then frames as depth_raw + ir pairs.
struct Recorder {
    url: String,
    part: PathBuf,
    hub_source: Option<Value>,
    hub_sensor: Option<Value>,
    params: Option<Value>,
    /// width, height and the payload of the `lut` message
    lut: Option<(u16, u16, Bytes)>,
    writer: Option<recording::Writer<BufWriter<File>>>,
    /// A depth_raw frame waiting for the ir of the same frame: seq, capture time, pixels.
    pending: Option<(u32, u64, Bytes)>,
    started: Option<Instant>,
    frames: u64,
    with_ir: u64,
    /// Why the recording has to end early.
    stop: Option<String>,
}

impl Recorder {
    fn on_text(&mut self, text: &str) {
        let Ok(v) = serde_json::from_str::<Value>(text) else { return };
        let params = v.get("params").filter(|p| p.is_object()).cloned();
        match v.get("type").and_then(Value::as_str) {
            Some("hello") => {
                self.hub_sensor = v.get("sensor").cloned();
                self.params = self.params.take().or(params);
            }
            // once recording, a change shows in the LUT that follows
            Some("params") if self.writer.is_none() && params.is_some() => self.params = params,
            Some("error") => eprintln!("hub: {text}"),
            _ => {}
        }
    }

    fn on_binary(&mut self, b: &Bytes) -> Result<(), String> {
        let (Some(magic), Some(kind), Some(header_len), Some(seq), Some(w), Some(h), Some(capture)) = (
            b.get(0..4).and_then(|s| s.try_into().ok()).map(u32::from_le_bytes),
            b.get(4).copied(),
            b.get(6..8).and_then(|s| s.try_into().ok()).map(u16::from_le_bytes),
            b.get(8..12).and_then(|s| s.try_into().ok()).map(u32::from_le_bytes),
            b.get(12..14).and_then(|s| s.try_into().ok()).map(u16::from_le_bytes),
            b.get(14..16).and_then(|s| s.try_into().ok()).map(u16::from_le_bytes),
            b.get(16..24).and_then(|s| s.try_into().ok()).map(u64::from_le_bytes),
        ) else {
            return Ok(());
        };
        if magic != 0x3148_324B || usize::from(header_len) > b.len() {
            return Ok(());
        }
        let payload = b.slice(usize::from(header_len)..);
        let pixels = usize::from(w) * usize::from(h);
        match kind {
            16 if payload.len() == pixels * 8 => {
                if self.writer.is_none() {
                    self.lut = Some((w, h, payload));
                } else if self.lut.as_ref().is_some_and(|(_, _, old)| *old != payload) {
                    self.stop = Some("the camera parameters changed".to_string());
                }
            }
            2 if payload.len() == pixels * 2 => {
                if self.writer.is_none() && !self.start()? {
                    return Ok(()); // parameters or LUT still missing
                }
                if let Some((s, c, depth)) = self.pending.take() {
                    self.write(s, c, &depth, None)?;
                }
                self.pending = Some((seq, capture, payload));
            }
            3 if payload.len() == pixels => {
                if let Some((s, c, depth)) = self.pending.take() {
                    self.write(s, c, &depth, (s == seq).then_some(payload.as_ref()))?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Creates the file once the camera parameters and the LUT are known.
    fn start(&mut self) -> Result<bool, String> {
        let (Some(params), Some((w, h, lut))) = (&self.params, &self.lut) else { return Ok(false) };
        let info = json!({
            "params": params,
            "recorded_at_us": now_us(),
            "source_url": self.url,
            "hub_source": self.hub_source,
            "hub_sensor": self.hub_sensor,
            "recorder": concat!("kinect-hub-probe ", env!("CARGO_PKG_VERSION")),
            "depth": "u16 mm per pixel from the depth_raw stream (unfiltered)",
            "ir": "u8 per pixel from the ir stream (sqrt tone-mapped)",
        });
        let fail = |e: std::io::Error| format!("cannot write {}: {e}", self.part.display());
        let file = File::create(&self.part).map_err(fail)?;
        self.writer = Some(recording::Writer::new(BufWriter::with_capacity(1 << 20, file), *w, *h, &info, lut).map_err(fail)?);
        self.started = Some(Instant::now());
        println!("recording ...");
        Ok(true)
    }

    fn write(&mut self, seq: u32, capture: u64, depth: &[u8], ir: Option<&[u8]>) -> Result<(), String> {
        let Some(w) = self.writer.as_mut() else { return Ok(()) };
        w.frame(seq, capture, depth, ir).map_err(|e| format!("cannot write {}: {e}", self.part.display()))?;
        self.frames += 1;
        self.with_ir += u64::from(ir.is_some());
        Ok(())
    }
}

/// Records from a running hub into `--out` (written as `<out>.part`, renamed when complete).
async fn run_record(a: &Args) -> Result<String, String> {
    let out = a.out.clone().ok_or("record needs --out FILE, e.g. --out recordings/people.k2rec")?;
    if out.exists() {
        return Err(format!("{} exists already: choose another name or delete it first", out.display()));
    }
    if let Some(dir) = out.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let mut part = out.clone().into_os_string();
    part.push(".part");
    let part = PathBuf::from(part);
    let result = record_into(a, &part).await;
    let reason = match result {
        Ok((frames, reason)) if frames > 0 => reason,
        other => {
            let _ = std::fs::remove_file(&part);
            return Err(match other {
                Err(e) => e,
                Ok((_, reason)) => format!("no frames recorded ({reason}); is the hub streaming? see /api/status"),
            });
        }
    };
    std::fs::rename(&part, &out).map_err(|e| format!("cannot rename {} to {}: {e}", part.display(), out.display()))?;
    let rec = recording::Recording::open(&out).map_err(|e| format!("{} was written but does not read back: {e}", out.display()))?;
    let secs = rec.duration_us() as f64 / 1e6;
    let ir = rec.frames.iter().filter(|f| f.has_ir).count();
    let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    Ok(format!(
        "{}: {} frames ({ir} with IR), {secs:.1} s, {:.1} fps, {} skipped by the hub stream, {:.0} MB ({reason})\n\
         replay: kinect-hub --source replay {} --bind 127.0.0.1:8091",
        out.display(),
        rec.frames.len(),
        if secs > 0.0 { (rec.frames.len() as f64 - 1.0) / secs } else { 0.0 },
        rec.skipped_frames(),
        size as f64 / 1e6,
        out.display()
    ))
}

/// Returns the number of frames written and why the recording ended.
async fn record_into(a: &Args, part: &Path) -> Result<(u64, String), String> {
    let hub_source = match http_get(&a.url, "/api/status").await {
        Ok((200, body)) => serde_json::from_slice::<Value>(&body).ok().and_then(|v| v.get("source").cloned()),
        _ => None,
    };
    let (ws, _) = connect_async(a.url.as_str()).await.map_err(|e| format!("cannot connect to {}: {e}", a.url))?;
    let (mut tx, mut rx) = ws.split();
    let sub = json!({"type": "subscribe", "streams": ["depth_raw", "ir", "lut"]}).to_string();
    tx.send(Message::text(sub)).await.map_err(|e| format!("subscribe: {e}"))?;
    println!(
        "{}: {} s from {} (hub source {}), about 20 MB per second",
        part.display(),
        a.seconds,
        a.url,
        hub_source.as_ref().and_then(Value::as_str).unwrap_or("?")
    );

    let mut r = Recorder {
        url: a.url.clone(),
        part: part.to_path_buf(),
        hub_source,
        hub_sensor: None,
        params: None,
        lut: None,
        writer: None,
        pending: None,
        started: None,
        frames: 0,
        with_ir: 0,
        stop: None,
    };
    let ctrl_c = async {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    tokio::pin!(ctrl_c);
    let mut keepalive = tokio::time::interval(Duration::from_secs(10)); // the hub drops clients silent for 60 s
    keepalive.tick().await;
    let connected = Instant::now();
    let mut reported = Instant::now();
    let reason = loop {
        if let Some(reason) = r.stop.take() {
            break reason;
        }
        match r.started {
            Some(t) if t.elapsed() >= Duration::from_secs(a.seconds) => break format!("{} s recorded", a.seconds),
            Some(t) if reported.elapsed() >= Duration::from_secs(5) => {
                println!("  {:4.1} s, {} frames", t.elapsed().as_secs_f64(), r.frames);
                reported = Instant::now();
            }
            None if connected.elapsed() > Duration::from_secs(15) => {
                let state = r.hub_sensor.as_ref().and_then(|s| s.get("state")).and_then(Value::as_str).unwrap_or("?");
                break format!("nothing to record within 15 s (sensor {state})");
            }
            _ => {}
        }
        let msg = tokio::select! {
            m = rx.next() => m,
            _ = &mut ctrl_c => break "stopped with Ctrl+C".to_string(),
            _ = keepalive.tick() => {
                let _ = tx.send(Message::text("{\"type\":\"ping\"}")).await;
                continue;
            }
            _ = tokio::time::sleep(Duration::from_millis(500)) => continue,
        };
        match msg {
            Some(Ok(Message::Binary(b))) => r.on_binary(&b)?,
            Some(Ok(Message::Text(t))) => r.on_text(t.as_str()),
            Some(Ok(_)) => {}
            Some(Err(e)) => break format!("connection lost: {e}"),
            None => break "the hub closed the connection".to_string(),
        }
    };
    let _ = tx.send(Message::Close(None)).await;
    // an unpaired depth frame at the end is dropped: every frame either has its IR or never had one
    if let Some(w) = r.writer.take() {
        w.finish().map_err(|e| format!("cannot write {}: {e}", part.display()))?;
    }
    if r.frames > 0 && r.with_ir > 0 && r.with_ir < r.frames {
        println!("note: {} of {} frames came without IR", r.frames - r.with_ir, r.frames);
    }
    Ok((r.frames, reason))
}

#[tokio::main]
async fn main() {
    let a = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    match a.mode.as_str() {
        "abuse" => run_abuse(&a).await,
        "record" => match run_record(&a).await {
            Ok(summary) => println!("{summary}"),
            Err(e) => {
                eprintln!("record failed: {e}");
                std::process::exit(1);
            }
        },
        _ => run_stream(&a).await,
    }
}
