//! One WebSocket client session. Every client runs in its own task, and a slow or misbehaving
//! client can only hurt itself:
//! - frames come from a latest-only channel: a slow client skips frames, delay never builds up
//! - every send has a timeout; a client that stops reading is disconnected
//! - control messages are size-limited (at the upgrade) and rate-limited here
//! - counters are restored by a drop guard however the session ends (even on panic)

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket};
use bytes::Bytes;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::OwnedSemaphorePermit;
use tokio::time::{MissedTickBehavior, timeout};
use tracing::{debug, info};

use crate::protocol::{CLIENT_HEADER_LEN, ClientRequest, HEIGHT, PROTOCOL_VERSION, Stream, WIDTH};
use crate::state::{FrameSet, Hub, ParamSet, now_us};

const SEND_TIMEOUT: Duration = Duration::from_secs(5);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const PING_INTERVAL: Duration = Duration::from_secs(15);
const CONTROL_BURST: f64 = 40.0;
const CONTROL_PER_SECOND: f64 = 20.0;

type Tx = SplitSink<WebSocket, Message>;

/// Keeps the hub's client and subscriber counters right, however the session ends.
struct Session {
    hub: Arc<Hub>,
    id: u64,
    addr: SocketAddr,
    subs: u16,
}

impl Session {
    fn new(hub: Arc<Hub>, addr: SocketAddr) -> Session {
        hub.clients.fetch_add(1, Ordering::Relaxed);
        let id = hub.next_client_id();
        let mut s = Session { hub, id, addr, subs: 0 };
        s.set_subscriptions(Stream::Status.bit());
        s
    }

    fn has(&self, stream: Stream) -> bool {
        self.subs & stream.bit() != 0
    }

    fn wants_frames(&self) -> bool {
        Stream::PER_FRAME.iter().any(|s| self.has(*s))
    }

    fn set_subscriptions(&mut self, new: u16) {
        for s in Stream::ALL {
            let (was, will) = (self.subs & s.bit() != 0, new & s.bit() != 0);
            if will && !was {
                self.hub.subscribe(s);
            } else if was && !will {
                self.hub.unsubscribe(s);
            }
        }
        self.subs = new;
    }

    fn subscribed_names(&self) -> Vec<&'static str> {
        Stream::ALL.iter().filter(|s| self.has(**s)).map(|s| s.name()).collect()
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.set_subscriptions(0);
        let _ = self.hub.clients.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| Some(v.saturating_sub(1)));
        info!("client {} ({}) disconnected", self.id, self.addr);
    }
}

pub async fn run(socket: WebSocket, hub: Arc<Hub>, addr: SocketAddr, _permit: OwnedSemaphorePermit) {
    let mut session = Session::new(hub.clone(), addr);
    info!("client {} ({addr}) connected", session.id);
    let (mut tx, mut rx) = socket.split();
    let mut frames = hub.frames.subscribe();
    let mut params = hub.params.subscribe();
    frames.mark_unchanged(); // the first frame sent is a fresh one
    params.mark_unchanged(); // params are sent when `lut` gets subscribed

    if send(&hub, &mut tx, Message::Text(hello(&hub, session.id).into())).await.is_err() {
        return;
    }

    let mut status_tick = tokio::time::interval(Duration::from_secs(1));
    status_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut ping_tick = tokio::time::interval(PING_INTERVAL);
    ping_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut last_rx = Instant::now();
    let (mut tokens, mut tokens_at) = (CONTROL_BURST, Instant::now());
    let mut min_frame_interval: Option<Duration> = None;
    let mut last_frame_sent: Option<Instant> = None;

    let reason = loop {
        tokio::select! {
            biased;
            incoming = rx.next() => {
                let msg = match incoming {
                    None => break "closed by client".to_string(),
                    Some(Err(e)) => break format!("connection error: {e}"),
                    Some(Ok(m)) => m,
                };
                last_rx = Instant::now();
                match msg {
                    Message::Text(text) => {
                        let now = Instant::now();
                        tokens = (tokens + now.duration_since(tokens_at).as_secs_f64() * CONTROL_PER_SECOND).min(CONTROL_BURST);
                        tokens_at = now;
                        if tokens < 1.0 {
                            close(&mut tx, 1008, "too many control messages").await;
                            break "rate limited".to_string();
                        }
                        tokens -= 1.0;
                        if handle_request(&hub, &mut session, &mut tx, text.as_str(), &mut min_frame_interval).await.is_err() {
                            break "send failed".to_string();
                        }
                    }
                    Message::Binary(_) => {
                        let err = json!({"type": "error", "message": "binary messages are not accepted, send JSON text"});
                        if send_json(&hub, &mut tx, &err).await.is_err() {
                            break "send failed".to_string();
                        }
                    }
                    Message::Ping(_) | Message::Pong(_) => {} // pings are answered automatically
                    Message::Close(_) => break "closed by client".to_string(),
                }
            }
            changed = frames.changed(), if session.wants_frames() => {
                if changed.is_err() {
                    break "hub shutting down".to_string();
                }
                let frame = frames.borrow_and_update().clone();
                let Some(frame) = frame else { continue };
                if let (Some(min), Some(last)) = (min_frame_interval, last_frame_sent)
                    && last.elapsed() < min {
                        continue;
                    }
                last_frame_sent = Some(Instant::now());
                if send_frame(&hub, &session, &mut tx, &frame).await.is_err() {
                    break "client too slow or gone (send timed out)".to_string();
                }
            }
            changed = params.changed(), if session.has(Stream::Lut) => {
                if changed.is_err() {
                    break "hub shutting down".to_string();
                }
                let p = params.borrow_and_update().clone();
                if let Some(p) = p
                    && send_params(&hub, &mut tx, &p).await.is_err() {
                        break "send failed".to_string();
                    }
            }
            _ = status_tick.tick(), if session.has(Stream::Status) => {
                if send_json(&hub, &mut tx, &hub.status_json()).await.is_err() {
                    break "send failed".to_string();
                }
            }
            _ = ping_tick.tick() => {
                if last_rx.elapsed() > IDLE_TIMEOUT {
                    close(&mut tx, 1001, "idle timeout").await;
                    break "idle timeout".to_string();
                }
                if send(&hub, &mut tx, Message::Ping(Bytes::new())).await.is_err() {
                    break "send failed".to_string();
                }
            }
        }
    };
    debug!("client {} session ended: {reason}", session.id);
}

async fn handle_request(
    hub: &Hub,
    session: &mut Session,
    tx: &mut Tx,
    text: &str,
    min_frame_interval: &mut Option<Duration>,
) -> Result<(), ()> {
    let req = match serde_json::from_str::<ClientRequest>(text) {
        Ok(r) => r,
        Err(e) => {
            let err = json!({
                "type": "error",
                "message": format!("invalid request: {e}"),
                "hint": "send {\"type\":\"subscribe\",\"streams\":[\"depth\",\"lut\"]} or {\"type\":\"ping\"}",
            });
            return send_json(hub, tx, &err).await;
        }
    };
    match req {
        ClientRequest::Subscribe { streams, max_fps } => {
            let mut bits = 0u16;
            let mut unknown = Vec::new();
            for name in streams.iter().take(32) {
                match Stream::parse(name) {
                    Some(s) => bits |= s.bit(),
                    None => unknown.push(name.chars().take(40).collect::<String>()),
                }
            }
            let lut_added = bits & Stream::Lut.bit() != 0 && !session.has(Stream::Lut);
            session.set_subscriptions(bits);
            *min_frame_interval = max_fps
                .filter(|f| f.is_finite() && *f > 0.0)
                .and_then(|f| Duration::try_from_secs_f64(1.0 / f.clamp(0.1, 1000.0)).ok());
            let reply = json!({
                "type": "subscribed",
                "streams": session.subscribed_names(),
                "unknown": unknown,
                "max_fps": max_fps,
                "valid": Stream::ALL.iter().map(|s| s.name()).collect::<Vec<_>>(),
            });
            send_json(hub, tx, &reply).await?;
            if lut_added {
                let p = hub.params.borrow().clone();
                if let Some(p) = p {
                    send_params(hub, tx, &p).await?;
                }
            }
            Ok(())
        }
        ClientRequest::Ping { t } => {
            send_json(hub, tx, &json!({"type": "pong", "t": t, "server_time_us": now_us()})).await
        }
    }
}

fn hello(hub: &Hub, id: u64) -> String {
    let streams: Vec<Value> = Stream::ALL
        .iter()
        .map(|s| json!({"name": s.name(), "kind": s.kind(), "description": s.describe()}))
        .collect();
    let sensor = hub.sensor.borrow().clone();
    let params = hub.params.borrow().as_ref().map(|p| p.params.clone());
    json!({
        "type": "hello",
        "protocol_version": PROTOCOL_VERSION,
        "client_id": id,
        "server_time_us": now_us(),
        "frame": {"width": WIDTH, "height": HEIGHT, "header_bytes": CLIENT_HEADER_LEN},
        "streams": streams,
        "subscribed": ["status"],
        "sensor": sensor,
        "params": params,
        "usage": "send {\"type\":\"subscribe\",\"streams\":[\"depth\",\"lut\"]}; protocol details: GET /api",
    })
    .to_string()
}

fn byte_len(msg: &Message) -> u64 {
    match msg {
        Message::Text(t) => t.len() as u64,
        Message::Binary(b) => b.len() as u64,
        _ => 0,
    }
}

async fn send(hub: &Hub, tx: &mut Tx, msg: Message) -> Result<(), ()> {
    let len = byte_len(&msg);
    match timeout(SEND_TIMEOUT, tx.send(msg)).await {
        Ok(Ok(())) => {
            hub.messages_sent.fetch_add(1, Ordering::Relaxed);
            hub.bytes_sent.fetch_add(len, Ordering::Relaxed);
            Ok(())
        }
        _ => Err(()),
    }
}

async fn send_json(hub: &Hub, tx: &mut Tx, v: &Value) -> Result<(), ()> {
    send(hub, tx, Message::Text(v.to_string().into())).await
}

async fn send_params(hub: &Hub, tx: &mut Tx, p: &ParamSet) -> Result<(), ()> {
    send(hub, tx, Message::Text(p.json.clone())).await?;
    send(hub, tx, Message::Binary(p.lut_msg.clone())).await
}

/// Sends all subscribed per-frame messages, flushing once at the end.
async fn send_frame(hub: &Hub, session: &Session, tx: &mut Tx, frame: &FrameSet) -> Result<(), ()> {
    let mut msgs = Vec::with_capacity(Stream::PER_FRAME.len());
    for s in Stream::PER_FRAME {
        if !session.has(s) {
            continue;
        }
        if s == Stream::Meta {
            msgs.push(Message::Text(frame.meta.clone()));
        } else if let Some(b) = frame.binary(s) {
            msgs.push(Message::Binary(b.clone())); // shared buffer, no copy
        }
    }
    let total: u64 = msgs.iter().map(byte_len).sum();
    let count = msgs.len() as u64;
    let result = timeout(SEND_TIMEOUT, async {
        for m in msgs {
            tx.feed(m).await?;
        }
        tx.flush().await
    })
    .await;
    match result {
        Ok(Ok(())) => {
            hub.messages_sent.fetch_add(count, Ordering::Relaxed);
            hub.bytes_sent.fetch_add(total, Ordering::Relaxed);
            Ok(())
        }
        _ => Err(()),
    }
}

async fn close(tx: &mut Tx, code: u16, reason: &'static str) {
    let frame = CloseFrame { code, reason: Utf8Bytes::from_static(reason) };
    let _ = timeout(Duration::from_secs(1), tx.send(Message::Close(Some(frame)))).await;
}
