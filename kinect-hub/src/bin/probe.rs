//! kinect-hub-probe: measures and abuses a running kinect-hub.
//!
//!   kinect-hub-probe stream [--url ws://127.0.0.1:8090/ws] [--clients N] [--seconds S] [--streams depth,ir]
//!       N clients subscribe; prints frames/s, latency (sensor capture -> client) and sequence gaps
//!   kinect-hub-probe abuse [--url ...]
//!       one healthy client keeps measuring while others misbehave (garbage, flooding, oversized
//!       messages, a client that stops reading, connection churn, too many clients, PNG requests,
//!       junk and floods against the dev server registry)

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
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
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args {
        mode: "stream".into(),
        url: "ws://127.0.0.1:8090/ws".into(),
        clients: 1,
        seconds: 10,
        streams: vec!["depth".into()],
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut val = || it.next().ok_or(format!("{arg} needs a value"));
        match arg.as_str() {
            "stream" | "abuse" => a.mode = arg.clone(),
            "--url" => a.url = val()?,
            "--clients" => a.clients = val()?.parse().map_err(|e| format!("--clients: {e}"))?,
            "--seconds" => a.seconds = val()?.parse().map_err(|e| format!("--seconds: {e}"))?,
            "--streams" => a.streams = val()?.split(',').map(str::to_string).collect(),
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
        _ => run_stream(&a).await,
    }
}
