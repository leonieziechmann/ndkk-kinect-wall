//! HTTP + WebSocket server.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State, WebSocketUpgrade};
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
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;
use tracing::{debug, error, info, warn};

use crate::config::Config;
use crate::devservers::{self, RegisterError, Registration};
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
        .route(
            "/api/devservers",
            get(devservers_list).post(devservers_register).delete(devservers_remove).layer(DefaultBodyLimit::max(64 * 1024)),
        )
        .with_state(hub.clone());
    let files = match &hub.cfg.web_dir {
        Some(dir) => {
            info!("serving web clients from {}", dir.display());
            Router::new()
                .fallback_service(ServeDir::new(dir).append_index_html_on_directories(true))
                // agents edit these files while the hub runs: always revalidate
                .layer(SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("no-cache")))
        }
        None => {
            warn!("no web/ directory found, serving only the API");
            Router::new().fallback(|| async { Html(NO_WEB_DIR_PAGE) })
        }
    };
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
    api.merge(files).layer(cors).layer(CatchPanicLayer::new())
}

/// Browsers send an Origin header; any website could otherwise read the depth stream of this
/// room. Allowed: non-browser clients (no Origin), pages served by the hub itself, localhost
/// pages (other dev servers on this machine), and origins passed with --allow-origin.
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

async fn devservers_list(State(hub): State<Arc<Hub>>) -> Response {
    Json(hub.devservers.list_json()).into_response()
}

/// Dev servers announce themselves from this machine. Browser pages have no business here: a
/// website could otherwise plant links on the start page.
fn registry_rejection(addr: &SocketAddr, headers: &HeaderMap) -> Option<Response> {
    if !addr.ip().is_loopback() {
        return Some(error(StatusCode::FORBIDDEN, "dev servers can only register from this machine"));
    }
    if headers.contains_key(header::ORIGIN) {
        return Some(error(StatusCode::FORBIDDEN, "browser pages cannot register dev servers"));
    }
    None
}

async fn devservers_register(
    State(hub): State<Arc<Hub>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Json<Registration>, JsonRejection>,
) -> Response {
    if let Some(rejection) = registry_rejection(&addr, &headers) {
        return rejection;
    }
    let reg = match body {
        Ok(Json(reg)) => reg,
        Err(e) => return error(e.status(), format!("invalid registration: {}", e.body_text())),
    };
    match hub.devservers.register(reg) {
        Ok(new) => Json(json!({ "ok": true, "new": new, "ttl_s": devservers::TTL.as_secs() })).into_response(),
        Err(RegisterError::BadUrl) => {
            error(StatusCode::BAD_REQUEST, "url must be http://127.0.0.1:<port> (or localhost, [::1]) without a path")
        }
        Err(RegisterError::Full) => {
            error(StatusCode::SERVICE_UNAVAILABLE, format!("{} dev servers are registered already", devservers::MAX_SERVERS))
        }
    }
}

#[derive(Deserialize)]
struct RemoveQuery {
    url: String,
}

async fn devservers_remove(
    State(hub): State<Arc<Hub>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    query: Result<Query<RemoveQuery>, QueryRejection>,
) -> Response {
    if let Some(rejection) = registry_rejection(&addr, &headers) {
        return rejection;
    }
    let Ok(Query(q)) = query else {
        return error(StatusCode::BAD_REQUEST, "use DELETE /api/devservers?url=http://127.0.0.1:<port>");
    };
    if hub.devservers.remove(&q.url) {
        Json(json!({ "ok": true })).into_response()
    } else {
        error(StatusCode::NOT_FOUND, "no dev server registered under this url")
    }
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
            "GET /api/poses": "newest poses of the pose model as the poses stream sends them (JSON); a request keeps the model running for 5 s, the first one may get poses: null",
            "GET /ws": "WebSocket stream (see websocket)",
            "GET /api/devservers": "scene dev servers (Vite, one per worktree) that announced themselves, with their scenes (JSON)",
            "POST /api/devservers": "announce a dev server: {url: 'http://127.0.0.1:<port>', label, branch, worktree, hub, pid, scenes: [{name, title, description, author, thumb, modified_ms, error}]}; repeat every few seconds, entries expire after ttl_s; only from this machine, not from browsers",
            "DELETE /api/devservers?url=...": "sign a dev server off",
            "GET /": "start page from the web/ directory: hub status and the scenes of all dev servers",
        },
        "websocket": {
            "url": "ws://<host>/ws",
            "client_messages": {
                "subscribe": {"type": "subscribe", "streams": ["depth", "lut"], "max_fps": 30},
                "ping": {"type": "ping", "t": "anything, echoed back"},
            },
            "server_text_messages": ["hello", "subscribed", "status", "params", "frame", "poses", "pong", "error"],
            "binary_header": {
                "bytes": CLIENT_HEADER_LEN,
                "layout": "u32 magic 'K2H1' (0x3148324B) | u8 kind | u8 version | u16 header_len | u32 seq | u16 width | u16 height | u64 capture_time_us | u64 publish_time_us, little-endian; payload follows",
                "kinds": {"1": "depth u16", "2": "depth_raw u16", "3": "ir u8", "4": "points i16 x3", "16": "lut f32 x2"},
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

const NO_WEB_DIR_PAGE: &str = "<!doctype html><meta charset=utf-8><title>kinect-hub</title>\
<body style='font-family:system-ui;background:#222;color:#ddd;padding:2em'>\
<h1>kinect-hub läuft</h1><p>Kein <code>web/</code>-Verzeichnis gefunden. API-Beschreibung: <a style='color:#9cf' href='/api'>/api</a></p>";
