//! HTTP + WebSocket server.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::{ConnectInfo, Path, Query, State, WebSocketUpgrade};
use axum::http::header::{self, HeaderMap, HeaderName, HeaderValue};
use axum::http::{Method, StatusCode};
use axum::response::{Html, IntoResponse, Json, Response};
use axum::routing::get;
use axum::serve::ListenerExt;
use bytes::Bytes;
use serde::Deserialize;
use serde_json::json;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::{debug, error, info, warn};

use crate::config::Config;
use crate::pipeline::points_message;
use crate::protocol::{CLIENT_HEADER_LEN, HEIGHT, PROTOCOL_VERSION, Stream, WIDTH, payload};
use crate::state::{FrameSet, Hub, Shutdown};
use crate::ws;

/// Serves until shutdown; if the port cannot be bound (or the server ever stops), it retries.
///
/// `on_first_bind` runs once the port is ours: only then is the Kinect touched. A second hub
/// started by accident therefore waits as a standby instead of fighting over the sensor, and
/// takes over by itself when the first one goes away.
pub async fn serve(hub: Arc<Hub>, shutdown: Shutdown, mut on_first_bind: Option<Box<dyn FnOnce() + Send>>) {
    let app = router(hub.clone());
    let mut delay = Duration::from_secs(1);
    loop {
        if shutdown.is_set() {
            return;
        }
        match tokio::net::TcpListener::bind(hub.cfg.bind).await {
            Ok(listener) => {
                // no Nagle delay: the tail of every frame goes out immediately
                let listener = listener.tap_io(|tcp| {
                    if let Err(e) = tcp.set_nodelay(true) {
                        debug!("cannot set TCP_NODELAY: {e}");
                    }
                });
                info!("listening on http://{}  (WebSocket: ws://{}/ws, API: /api)", hub.cfg.bind, hub.cfg.bind);
                delay = Duration::from_secs(1);
                if let Some(start) = on_first_bind.take() {
                    start();
                }
                let service = app.clone().into_make_service_with_connect_info::<SocketAddr>();
                if let Err(e) = axum::serve(listener, service).with_graceful_shutdown(shutdown.clone().wait()).await {
                    error!("server error: {e}");
                }
                if shutdown.is_set() {
                    return;
                }
                warn!("server stopped unexpectedly, restarting");
            }
            Err(e) if on_first_bind.is_some() => warn!(
                "cannot listen on {}: {e} - is another kinect-hub running? Waiting as standby, the Kinect stays untouched (retry in {} s)",
                hub.cfg.bind,
                delay.as_secs()
            ),
            Err(e) => error!("cannot listen on {}: {e} (retrying in {} s)", hub.cfg.bind, delay.as_secs()),
        }
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = shutdown.clone().wait() => return,
        }
        delay = (delay * 2).min(Duration::from_secs(5));
    }
}

fn router(hub: Arc<Hub>) -> Router {
    let api = Router::new()
        .route("/ws", get(ws_upgrade))
        .route("/api", get(api_index))
        .route("/api/status", get(api_status))
        .route("/api/params", get(api_params))
        .route("/api/lut", get(api_lut))
        .route("/api/frame/{stream}", get(api_frame))
        .route("/api/poses", get(api_poses))
        .route("/api/persons", get(api_persons))
        .route("/", get(|| async { Html(START_PAGE) }))
        .fallback(|| async { error(StatusCode::NOT_FOUND, "not found; the API is described at /api") })
        .with_state(hub.clone());
    let cfg = hub.cfg.clone();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin: &HeaderValue, parts| {
            origin.to_str().is_ok_and(|o| origin_allowed(&cfg, o, parts.headers.get(header::HOST)))
        }))
        .allow_methods([Method::GET, Method::OPTIONS])
        .expose_headers([
            HeaderName::from_static("x-width"),
            HeaderName::from_static("x-height"),
            HeaderName::from_static("x-seq"),
            HeaderName::from_static("x-capture-time-us"),
            HeaderName::from_static("x-publish-time-us"),
            HeaderName::from_static("x-format"),
        ]);
    api.layer(cors).layer(CatchPanicLayer::new())
}

/// Browsers send an Origin header; any website could otherwise read the depth stream of this
/// room. Allowed: non-browser clients (no Origin, like wall-bevy), pages of the hub itself,
/// localhost pages, and origins passed with --allow-origin.
fn origin_allowed(cfg: &Config, origin: &str, host: Option<&HeaderValue>) -> bool {
    if cfg.allow_origins.iter().any(|o| o == "*" || o.eq_ignore_ascii_case(origin)) {
        return true;
    }
    if let Some(host) = host.and_then(|h| h.to_str().ok())
        && (origin.eq_ignore_ascii_case(&format!("http://{host}")) || origin.eq_ignore_ascii_case(&format!("https://{host}"))) {
            return true;
        }
    let Some(rest) = origin.strip_prefix("http://").or_else(|| origin.strip_prefix("https://")) else {
        return false;
    };
    let host = match rest.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or_default(),
        None => rest.split(':').next().unwrap_or_default(),
    };
    matches!(host, "localhost" | "127.0.0.1" | "::1") || host.ends_with(".localhost")
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(hub): State<Arc<Hub>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Some(origin) = headers.get(header::ORIGIN) {
        let ok = origin.to_str().is_ok_and(|o| origin_allowed(&hub.cfg, o, headers.get(header::HOST)));
        if !ok {
            warn!("rejected WebSocket from {addr}: origin {origin:?} not allowed (see --allow-origin)");
            return (StatusCode::FORBIDDEN, "origin not allowed; start kinect-hub with --allow-origin").into_response();
        }
    }
    let Ok(permit) = hub.client_slots.clone().try_acquire_owned() else {
        warn!("rejected WebSocket from {addr}: {} clients connected", hub.cfg.max_clients);
        return (StatusCode::SERVICE_UNAVAILABLE, "too many clients").into_response();
    };
    ws.max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .on_failed_upgrade(move |e| debug!("WebSocket upgrade from {addr} failed: {e}"))
        .on_upgrade(move |socket| ws::run(socket, hub, addr, permit))
}

fn error(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

async fn api_status(State(hub): State<Arc<Hub>>) -> Response {
    Json(hub.status_json()).into_response()
}

async fn api_params(State(hub): State<Arc<Hub>>) -> Response {
    match hub.params.borrow().as_ref() {
        Some(p) => Json(json!(p.params)).into_response(),
        None => error(StatusCode::SERVICE_UNAVAILABLE, "camera parameters not known yet (no sensor started); see /api/status"),
    }
}

async fn api_lut(State(hub): State<Arc<Hub>>) -> Response {
    let lut = hub.params.borrow().as_ref().map(|p| payload(&p.lut_msg));
    match lut {
        Some(body) => binary(body, "application/octet-stream", "f32 x,y per pixel; point = (x*z, y*z, z)", None),
        None => error(StatusCode::SERVICE_UNAVAILABLE, "camera parameters not known yet; see /api/status"),
    }
}

#[derive(Deserialize)]
struct FrameQuery {
    format: Option<String>,
}

async fn api_frame(State(hub): State<Arc<Hub>>, Path(name): Path<String>, Query(q): Query<FrameQuery>) -> Response {
    let Some(stream) = Stream::parse(&name) else {
        return error(StatusCode::NOT_FOUND, format!("unknown stream '{name}'; use depth, depth_raw, ir, points or meta"));
    };
    let png = match q.format.as_deref() {
        None | Some("raw") => false,
        Some("png") => true,
        Some(other) => return error(StatusCode::BAD_REQUEST, format!("format '{other}' unknown; use raw or png")),
    };
    let Some(frame) = hub.frames.borrow().clone() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "no frame yet; see /api/status");
    };
    match stream {
        Stream::Meta => (
            [(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")],
            frame.meta.as_str().to_string(),
        )
            .into_response(),
        Stream::Lut => error(StatusCode::BAD_REQUEST, "use /api/lut"),
        Stream::Status => error(StatusCode::BAD_REQUEST, "use /api/status"),
        Stream::Poses => error(StatusCode::BAD_REQUEST, "use /api/poses"),
        Stream::Persons | Stream::PersonsLive => error(StatusCode::BAD_REQUEST, "use /api/persons"),
        Stream::Points => {
            if png {
                return error(StatusCode::BAD_REQUEST, "points are only available raw (i16 x,y,z in mm)");
            }
            let body = match (&frame.points, &frame.params) {
                (Some(p), _) => payload(p),
                (None, Some(params)) => {
                    // nobody streams points right now: compute them for this request only
                    let (f, rays) = (frame.clone(), params.rays.clone());
                    let computed = tokio::task::spawn_blocking(move || {
                        let depth: Vec<u16> = payload(&f.depth)
                            .as_chunks::<2>().0.iter()
                            .map(|c| u16::from_le_bytes([c.first().copied().unwrap_or(0), c.get(1).copied().unwrap_or(0)]))
                            .collect();
                        payload(&points_message(&depth, &rays, f.seq, f.capture_time_us, f.publish_time_us))
                    })
                    .await;
                    match computed {
                        Ok(b) => b,
                        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, format!("point computation failed: {e}")),
                    }
                }
                (None, None) => return error(StatusCode::SERVICE_UNAVAILABLE, "camera parameters not known yet"),
            };
            binary(body, "application/octet-stream", "i16 x,y,z mm per pixel", Some(&frame))
        }
        Stream::Depth | Stream::DepthRaw | Stream::Ir => {
            let Some(msg) = frame.binary(stream) else {
                return error(StatusCode::SERVICE_UNAVAILABLE, "this frame has no IR data");
            };
            let body = payload(msg);
            let sixteen = stream != Stream::Ir;
            if !png {
                let format = if sixteen { "u16 mm per pixel" } else { "u8 per pixel" };
                return binary(body, "application/octet-stream", format, Some(&frame));
            }
            match tokio::task::spawn_blocking(move || encode_png(&body, sixteen)).await {
                Ok(Ok(png)) => binary(Bytes::from(png), "image/png", if sixteen { "png gray16 mm" } else { "png gray8" }, Some(&frame)),
                Ok(Err(e)) => error(StatusCode::INTERNAL_SERVER_ERROR, format!("png encoding failed: {e}")),
                Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, format!("png encoding failed: {e}")),
            }
        }
    }
}

/// The newest poses. The model only runs while someone wants poses: a request keeps it running for
/// a few seconds, so the first one may find none yet (poll again).
async fn api_poses(State(hub): State<Arc<Hub>>) -> Response {
    hub.pose.touch_http();
    let latest = hub.poses.borrow().clone();
    let fresh = latest.filter(|p| crate::state::now_us().saturating_sub(p.capture_time_us) < 2_000_000);
    match fresh {
        Some(p) => ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")], p.json.as_str().to_string())
            .into_response(),
        None => Json(json!({
            "type": "poses",
            "poses": null,
            "hint": "the pose model starts with this request; ask again in a moment (status below)",
            "pose": hub.pose.status_json(),
        }))
        .into_response(),
    }
}

/// The newest person tracking result (the delayed `persons` stream's JSON, without labels). The
/// tracker only runs while someone wants it: a request keeps it running for a few seconds.
async fn api_persons(State(hub): State<Arc<Hub>>) -> Response {
    hub.tracking.touch_http();
    let latest = hub.persons.borrow().clone();
    match latest {
        Some(p) => ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")], p.json.as_str().to_string())
            .into_response(),
        None => Json(json!({
            "type": "persons",
            "persons": null,
            "hint": "the person tracking starts with this request; ask again in a moment (status below)",
            "tracking": hub.tracking.status_json(),
            "pose": hub.pose.status_json(),
        }))
        .into_response(),
    }
}

fn binary(body: Bytes, content_type: &'static str, format: &'static str, frame: Option<&FrameSet>) -> Response {
    let mut h = HeaderMap::new();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(HeaderName::from_static("x-width"), HeaderValue::from(WIDTH as u64));
    h.insert(HeaderName::from_static("x-height"), HeaderValue::from(HEIGHT as u64));
    h.insert(HeaderName::from_static("x-format"), HeaderValue::from_static(format));
    if let Some(f) = frame {
        h.insert(HeaderName::from_static("x-seq"), HeaderValue::from(f.seq));
        h.insert(HeaderName::from_static("x-capture-time-us"), HeaderValue::from(f.capture_time_us));
        h.insert(HeaderName::from_static("x-publish-time-us"), HeaderValue::from(f.publish_time_us));
    }
    (StatusCode::OK, h, body).into_response()
}

fn encode_png(data: &[u8], sixteen_bit: bool) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, WIDTH as u32, HEIGHT as u32);
        enc.set_color(png::ColorType::Grayscale);
        enc.set_depth(if sixteen_bit { png::BitDepth::Sixteen } else { png::BitDepth::Eight });
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        if sixteen_bit {
            // PNG stores 16-bit samples big-endian
            let be: Vec<u8> = data.as_chunks::<2>().0.iter().flat_map(|c| [c.get(1).copied().unwrap_or(0), c.first().copied().unwrap_or(0)]).collect();
            writer.write_image_data(&be).map_err(|e| e.to_string())?;
        } else {
            writer.write_image_data(data).map_err(|e| e.to_string())?;
        }
        writer.finish().map_err(|e| e.to_string())?;
    }
    Ok(out)
}

async fn api_index(State(hub): State<Arc<Hub>>) -> Response {
    let streams: serde_json::Map<String, serde_json::Value> =
        Stream::ALL.iter().map(|s| (s.name().to_string(), json!({"kind": s.kind(), "description": s.describe()}))).collect();
    Json(json!({
        "name": "kinect-hub",
        "protocol_version": PROTOCOL_VERSION,
        "source": hub.cfg.source.name(),
        "http": {
            "GET /api/status": "sensor state, fps, latency, clients (JSON)",
            "GET /api/params": "depth camera intrinsics + distortion (JSON)",
            "GET /api/lut": "undistortion table: f32 x,y per pixel (binary)",
            "GET /api/frame/{depth|depth_raw|ir|points|meta}": "latest frame; ?format=png for depth/depth_raw (16-bit mm) and ir (8-bit)",
            "GET /api/persons": "newest result of the person tracking as the persons stream sends it (JSON, without the labels); a request keeps the tracker running for 5 s",
            "GET /api/poses": "newest poses of the pose model as the poses stream sends them (JSON); a request keeps the model running for 5 s, the first one may get poses: null",
            "GET /ws": "WebSocket stream (see websocket)",
            "GET /": "start page: hub status and links",
        },
        "websocket": {
            "url": "ws://<host>/ws",
            "client_messages": {
                "subscribe": {"type": "subscribe", "streams": ["depth", "lut"], "max_fps": 30},
                "ping": {"type": "ping", "t": "anything, echoed back"},
                "render": {"type": "render", "fps": 57.3, "target": 60, "visible": true, "scene": "neon-wall", "note": "about once a second from a client that renders scenes (the wall output), no reply; while a visible one renders below 85 % of its target the pose model steps down"},
            },
            "server_text_messages": ["hello", "subscribed", "status", "params", "frame", "poses", "persons", "persons_live", "pong", "error"],
            "binary_header": {
                "bytes": CLIENT_HEADER_LEN,
                "layout": "u32 magic 'K2H1' (0x3148324B) | u8 kind | u8 version | u16 header_len | u32 seq | u16 width | u16 height | u64 capture_time_us | u64 publish_time_us, little-endian; payload follows",
                "kinds": {"1": "depth u16", "2": "depth_raw u16", "3": "ir u8", "4": "points i16 x3", "5": "persons labels, run-length coded (u8 slot, u16 length per run)", "6": "persons_live labels, the same", "16": "lut f32 x2"},
            },
            "streams": streams,
            "notes": [
                "Frames are latest-only: a slow client skips frames instead of falling behind.",
                "Times are microseconds since 1970 (wall clock of the hub machine).",
                "Camera frame: x right, y down, z forward, as seen in the depth image (which comes mirrored from the Kinect).",
            ],
        },
        "frame": {"width": WIDTH, "height": HEIGHT},
    }))
    .into_response()
}

/// The start page: what runs, live from /api/status, and where the rest is.
const START_PAGE: &str = r#"<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>kinect-hub</title>
<body style="font-family:system-ui,sans-serif;background:#18181b;color:#ddd;padding:1.5em;max-width:46em;line-height:1.5">
<h1 style="font-weight:600">kinect-hub läuft</h1>
<p id="s">…</p>
<p>Die LED-Wand steuert die Steuerzentrale von <b>wall-bevy</b>: <a id="c" style="color:#8fc1ff" href="http://127.0.0.1:8095/">http://127.0.0.1:8095/</a> (Standard-Port; im Netz siehe Tab „Fernbedienung“ dort).</p>
<p>Für Programme: <a style="color:#8fc1ff" href="/api">/api</a> (Beschreibung), <a style="color:#8fc1ff" href="/api/status">/api/status</a>, WebSocket <code>/ws</code>.</p>
<script>
const c = document.getElementById('c');
c.href = c.textContent = location.protocol + '//' + location.hostname + ':8095/';
async function tick() {
  try {
    const s = await (await fetch('/api/status')).json();
    const t = s.tracking || {};
    document.getElementById('s').textContent = 'Quelle: ' + s.source + ' · Sensor: ' + ((s.sensor || {}).state || '?') + ' · ' + s.fps + ' fps · Clients: ' + s.clients + (t.state === 'running' ? ' · Personen: ' + t.persons : '');
  } catch (e) { document.getElementById('s').textContent = 'Status nicht lesbar: ' + e; }
}
tick(); setInterval(tick, 2000);
</script>"#;
