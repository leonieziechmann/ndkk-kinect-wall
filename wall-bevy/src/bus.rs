//! The wall bus (port of web/lib/wall-bus.js, the output's side): messages between the control
//! center (/control/) and this output, relayed by the dev server over its HMR WebSocket (event
//! 'kinect:wall', web/tools/vite-plugin-kinect.js). A native client sends no Origin header, so the
//! dev server lets it in without the page token. Its own thread; the main thread only polls.

use std::collections::{HashSet, VecDeque};
use std::io::ErrorKind;
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender, TryRecvError};
use serde_json::{Value, json};
use tungstenite::Message;

use crate::hub::{connect_ws, mono_ms, send_json};

pub struct BusMsg {
    pub kind: String,
    pub data: Value,
    /// the sender's page id
    #[allow(dead_code)]
    pub from: String,
}

pub enum BusIn {
    Msg(BusMsg),
    /// a document changed on disk (setup, projection, show)
    File(String),
    Connected(String),
    Disconnected,
}

struct Out {
    kind: String,
    data: Value,
    to: Option<String>,
}

pub struct Bus {
    /// this output's page id on the bus
    #[allow(dead_code)]
    pub id: String,
    pub incoming: Receiver<BusIn>,
    out: Sender<Out>,
    pub connected: bool,
}

impl Bus {
    /// `dev` is called now and then for the dev server's URL (it may restart on another port).
    pub fn start(dev: impl Fn() -> Option<String> + Send + 'static) -> Self {
        let id = format!("output-{:08x}", (mono_ms() * 1e6) as u64 ^ u64::from(std::process::id()).rotate_left(17));
        let (in_tx, in_rx) = crossbeam_channel::bounded(512);
        let (out_tx, out_rx) = crossbeam_channel::bounded(64);
        let me = id.clone();
        let _ = std::thread::Builder::new().name("wall-bus".into()).spawn(move || run(me, dev, in_tx, out_rx));
        Self { id, incoming: in_rx, out: out_tx, connected: false }
    }

    /// Sends to every other page (or only to `to`: a role or a page id). Dropped when the
    /// connection is slow: nothing here may wait.
    pub fn send(&self, kind: &str, data: Value, to: Option<&str>) {
        let _ = self.out.try_send(Out { kind: kind.into(), data, to: to.map(String::from) });
    }
}

fn run(id: String, dev: impl Fn() -> Option<String>, tx: Sender<BusIn>, rx: Receiver<Out>) {
    let mut n = 0u64;
    let mut seen: VecDeque<String> = VecDeque::new();
    let mut seen_set: HashSet<String> = HashSet::new();
    loop {
        let Some(url) = dev() else {
            // no dev server: drop what is queued, look again later
            while let Ok(_o) = rx.try_recv() {}
            std::thread::sleep(Duration::from_secs(2));
            continue;
        };
        let ws_url = format!("{}/?token=", url.replacen("http", "ws", 1));
        match connect_ws(&ws_url, Some("vite-hmr")) {
            Ok(mut ws) => {
                let _ = tx.try_send(BusIn::Connected(url.clone()));
                let hello = json!({ "type": "custom", "event": "kinect:wall", "data": { "id": format!("{id}:0"), "from": id, "role": "output", "type": "hello", "data": {}, "t": now_ms() } });
                let _ = send_json(&mut ws, &hello);
                let mut next_ping = mono_ms() + 25_000.0;
                let reason = loop {
                    let mut err = None;
                    loop {
                        match rx.try_recv() {
                            Ok(o) => {
                                n += 1;
                                let msg = json!({ "type": "custom", "event": "kinect:wall", "data": { "id": format!("{id}:{n}"), "from": id, "role": "output", "to": o.to, "type": o.kind, "data": o.data, "t": now_ms() } });
                                if let Err(e) = send_json(&mut ws, &msg) {
                                    err = Some(e);
                                    break;
                                }
                            }
                            Err(TryRecvError::Empty) => break,
                            Err(TryRecvError::Disconnected) => return,
                        }
                    }
                    if let Some(e) = err {
                        break e;
                    }
                    if mono_ms() > next_ping {
                        next_ping = mono_ms() + 25_000.0;
                        if let Err(e) = send_json(&mut ws, &json!({ "type": "ping" })) {
                            break e;
                        }
                    }
                    match ws.read() {
                        Ok(Message::Text(t)) => {
                            let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                            if v.get("type").and_then(Value::as_str) != Some("custom") {
                                continue;
                            }
                            match v.get("event").and_then(Value::as_str) {
                                Some("kinect:wall") => {
                                    let Some(m) = v.get("data") else { continue };
                                    let from = m.get("from").and_then(Value::as_str).unwrap_or("");
                                    let kind = m.get("type").and_then(Value::as_str).unwrap_or("");
                                    if kind.is_empty() || from == id {
                                        continue;
                                    }
                                    if let Some(to) = m.get("to").and_then(Value::as_str)
                                        && to != id
                                        && to != "output"
                                    {
                                        continue;
                                    }
                                    let mid = m.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                                    if !mid.is_empty() {
                                        if seen_set.contains(&mid) {
                                            continue;
                                        }
                                        seen_set.insert(mid.clone());
                                        seen.push_back(mid);
                                        if seen.len() > 512
                                            && let Some(old) = seen.pop_front()
                                        {
                                            seen_set.remove(&old);
                                        }
                                    }
                                    let _ = tx.try_send(BusIn::Msg(BusMsg { kind: kind.into(), data: m.get("data").cloned().unwrap_or(json!({})), from: from.into() }));
                                }
                                Some("kinect:wall-file") => {
                                    let kind = v.get("data").and_then(|d| d.get("kind")).and_then(Value::as_str).unwrap_or("");
                                    let _ = tx.try_send(BusIn::File(kind.into()));
                                }
                                _ => {}
                            }
                        }
                        Ok(Message::Close(_)) => break "geschlossen".into(),
                        Ok(_) => {}
                        Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                        Err(e) => break e.to_string(),
                    }
                };
                bevy::log::info!("Steuerzentrale ({url}): Verbindung weg ({reason})");
                let _ = tx.try_send(BusIn::Disconnected);
            }
            Err(_) => std::thread::sleep(Duration::from_secs(2)),
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}
