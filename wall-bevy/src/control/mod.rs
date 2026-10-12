//! The control center, built into the output: a small web server (HTTP and WebSocket) that serves the
//! control center's page (wall-bevy/control/, built into the program) to this computer and to phones
//! and tablets in the same network, keeps the wall's documents (setup, projections, show), passes the
//! control centers' commands to the output and the output's state (telemetry, preview pictures, the
//! scenes) to every open control center.
//!
//! Who may control the wall: this computer always (a request from 127.0.0.1 to 127.0.0.1); another
//! device once it is paired: the pairing link (QR code in the control center) or the code typed in
//! sets a cookie. A new code (control center, "Fernbedienung") unpairs every other device.
//!
//! Threads: one takes connections, one per connection (a control center's WebSocket lives as long as
//! its page), one writes the documents. The output's main thread only queues messages (try_lock: it
//! never waits for the server).

mod assets;
mod http;
mod net;
mod store;

use std::collections::HashMap;
use std::io::{ErrorKind, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use bevy::log::{info, warn};
use crossbeam_channel::{Receiver, Sender};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tungstenite::protocol::{Role, WebSocketConfig};
use tungstenite::{Message, WebSocket};

use store::write_atomic;

/// Connections at a time (control centers, page loads).
const MAX_CONNECTIONS: usize = 64;
const COOKIE: &str = "wand";
/// Wrong codes per address before it has to wait.
const MAX_TRIES: u32 = 10;
const TRIES_RESET: Duration = Duration::from_secs(600);
/// A control center that asked for preview pictures gets them this long.
const FRAMES_FOR: Duration = Duration::from_secs(3);

/// From the control centers to the output.
pub enum ControlIn {
    /// a command: play, next, prev, stop, blackout, pattern, preview, wizard, ping
    Cmd(String, Value),
    /// a document changed (setup, projection, show): kept and saved already
    Doc(String, Value),
}

/// How the server runs.
pub struct Options {
    /// 0: no server (tests); taken: the next free one of the following nine
    pub port: u16,
    pub bind: IpAddr,
    /// setup.json, projection.json, show.json, the pairing code
    pub data_dir: PathBuf,
    /// where the documents were before (taken over once)
    pub legacy: Vec<PathBuf>,
    /// the page's files from this folder instead of the built-in ones
    pub page_dir: Option<PathBuf>,
    /// the kinect-hub (http://host:port), for the room's floor plan
    pub hub: String,
    /// the show's output (not a test window): says where its control center is (control.json, for
    /// start-wand.ps1)
    pub announce: bool,
    /// tests: nothing is written
    pub read_only: bool,
}

struct Client {
    id: u64,
    tx: Sender<Message>,
    local: bool,
    frames_until: Option<Instant>,
    /// a message did not fit into its queue: the session ends, the page connects again and gets
    /// everything anew
    stale: Arc<AtomicBool>,
}

struct State {
    store: store::Store,
    clients: Vec<Client>,
    /// the scenes the output has (name, title, params, projection wishes)
    catalog: Value,
    telemetry: Value,
    code: String,
    lan: Vec<std::net::Ipv4Addr>,
    tries: HashMap<IpAddr, (u32, Instant)>,
    next_id: u64,
}

struct Shared {
    st: Mutex<State>,
    to_output: Sender<ControlIn>,
    port: u16,
    /// reachable in the network (not bound to loopback): the LAN addresses are worth looking up
    lan_ok: bool,
    /// control.json, written while the show's output runs (Options::announce)
    note: Option<PathBuf>,
    page_dir: Option<PathBuf>,
    hub: String,
    read_only: bool,
    connections: AtomicUsize,
}

pub struct Control {
    shared: Arc<Shared>,
    pub incoming: Receiver<ControlIn>,
}

impl Control {
    pub fn start(opts: Options) -> Self {
        if !opts.read_only {
            store::migrate(&opts.data_dir, &opts.legacy);
        }
        let store = store::Store::open(&opts.data_dir);
        let code = load_code(&opts.data_dir, opts.read_only);
        let (to_output, incoming) = crossbeam_channel::bounded(1024);
        let listener = if opts.port == 0 { None } else { bind(opts.bind, opts.port) };
        let port = listener.as_ref().and_then(|l| l.local_addr().ok()).map_or(0, |a| a.port());
        let lan_ok = port != 0 && !opts.bind.is_loopback();
        let lan = if lan_ok { net::lan_ips() } else { Vec::new() };
        let shared = Arc::new(Shared {
            st: Mutex::new(State { store, clients: Vec::new(), catalog: json!([]), telemetry: Value::Null, code, lan, tries: HashMap::new(), next_id: 1 }),
            to_output,
            port,
            lan_ok,
            note: (port != 0 && opts.announce && !opts.read_only).then(|| opts.data_dir.join("control.json")),
            page_dir: opts.page_dir,
            hub: opts.hub,
            read_only: opts.read_only,
            connections: AtomicUsize::new(0),
        });
        if let Some(l) = listener {
            let lan = shared.st.lock().lan.clone();
            let urls = write_note(&shared, &lan);
            info!("Steuerzentrale: http://127.0.0.1:{port}/{}", if urls.is_empty() { String::new() } else { format!(" · im Netz: {}", urls.join(", ")) });
            let s = shared.clone();
            let _ = std::thread::Builder::new().name("control".into()).spawn(move || accept(&s, &l));
        }
        let s = shared.clone();
        let _ = std::thread::Builder::new().name("control-docs".into()).spawn(move || keep_docs(&s));
        Self { shared, incoming }
    }

    /// The documents as they are now: { setup, projection, show }.
    pub fn docs(&self) -> Value {
        self.shared.st.lock().store.all()
    }

    /// Is a control center open (else the output need not put its state together)?
    pub fn has_clients(&self) -> bool {
        self.shared.st.try_lock().is_none_or(|st| !st.clients.is_empty())
    }

    /// The output's state for every control center (kept for the ones that connect later). Skipped
    /// when the server is busy: the next one comes in a moment.
    pub fn telemetry(&self, data: Value) {
        let Some(mut st) = self.shared.st.try_lock() else { return };
        if !st.clients.is_empty() {
            let text = json!({ "type": "telemetry", "data": data }).to_string();
            broadcast(&mut st, &Message::text(text), None, false);
        }
        st.telemetry = data;
    }

    /// A preview picture (JPEG) for the control centers that asked for one.
    pub fn frame(&self, jpeg: Vec<u8>) {
        let Some(st) = self.shared.st.try_lock() else { return };
        let now = Instant::now();
        let msg = Message::binary(jpeg);
        for c in &st.clients {
            // a picture that does not fit is skipped (not worth a reconnect)
            if c.frames_until.is_some_and(|t| t > now) {
                let _ = c.tx.try_send(msg.clone());
            }
        }
    }

    /// The scenes the output has (after the start and whenever a scene library was built anew).
    pub fn set_catalog(&self, scenes: Value) {
        let mut st = self.shared.st.lock();
        st.catalog = scenes.clone();
        let msg = Message::text(json!({ "type": "catalog", "data": { "scenes": scenes } }).to_string());
        broadcast(&mut st, &msg, None, true);
    }

    /// A short message in every control center (a build failed, a scene came new).
    pub fn note(&self, text: &str, bad: bool) {
        let Some(mut st) = self.shared.st.try_lock() else { return };
        let msg = Message::text(json!({ "type": "note", "data": { "text": text, "bad": bad } }).to_string());
        broadcast(&mut st, &msg, None, false);
    }

}

impl Drop for Control {
    /// At the end: what is not written yet.
    fn drop(&mut self) {
        save_due(&self.shared, true);
    }
}

fn bind(ip: IpAddr, port: u16) -> Option<TcpListener> {
    for p in port..port.saturating_add(10) {
        match TcpListener::bind(SocketAddr::new(ip, p)) {
            Ok(l) => {
                if p != port {
                    warn!("Steuerzentrale: Port {port} ist belegt, nehme {p}");
                }
                return Some(l);
            }
            Err(e) if e.kind() == ErrorKind::AddrInUse => continue,
            Err(e) => {
                warn!("Steuerzentrale: {ip}:{p} geht nicht ({e})");
                return None;
            }
        }
    }
    warn!("Steuerzentrale: Ports {port}–{} sind belegt: keine Steuerzentrale", port.saturating_add(9));
    None
}

/// The pairing code (data folder control-code.txt), made once.
fn load_code(dir: &Path, read_only: bool) -> String {
    let file = dir.join("control-code.txt");
    if let Ok(t) = std::fs::read_to_string(&file) {
        let t = t.trim().to_string();
        if t.len() >= 8 {
            return t;
        }
    }
    let code = net::new_code();
    if !read_only {
        let _ = write_atomic(&file, &format!("{code}\n"));
    }
    code
}

/// Sends `msg` to every control center (but `except`). A lost document update would leave a page
/// with an old state: such a page reconnects instead (`must`).
fn broadcast(st: &mut State, msg: &Message, except: Option<u64>, must: bool) {
    for c in &st.clients {
        if Some(c.id) == except {
            continue;
        }
        if c.tx.try_send(msg.clone()).is_err() && must {
            c.stale.store(true, Ordering::Relaxed);
        }
    }
}

// ---------- documents ----------

fn save_due(shared: &Shared, all: bool) {
    if shared.read_only {
        return;
    }
    let due = shared.st.lock().store.due(all);
    for (kind, path, text) in due {
        // written without the lock: the output never waits for the disk
        let ok = write_atomic(&path, &text);
        let mut st = shared.st.lock();
        match ok {
            Ok(()) => st.store.written(kind, store::stamp(&path)),
            Err(e) => {
                warn!("{} nicht gespeichert: {e}", path.display());
                st.store.retry(kind);
            }
        }
    }
}

/// Writes changed documents a moment after their last change; reads the ones someone else changed
/// on disk; looks again for this computer's addresses now and then (Wi-Fi changes).
fn keep_docs(shared: &Arc<Shared>) {
    let mut n = 0u64;
    loop {
        std::thread::sleep(Duration::from_millis(250));
        n += 1;
        save_due(shared, false);
        if n.is_multiple_of(8) {
            let (dir, stamps) = {
                let st = shared.st.lock();
                (st.store.dir().to_path_buf(), st.store.stamps())
            };
            for (kind, known, dirty) in stamps {
                let path = store::file_of(&dir, kind);
                let now = store::stamp(&path);
                if dirty || now.is_none() || now == known {
                    continue;
                }
                let value = store::read(&path);
                let mut st = shared.st.lock();
                if st.store.reread(kind, value.clone(), now) {
                    info!("{} von außen geändert: neu gelesen", path.display());
                    let msg = Message::text(json!({ "type": "doc", "data": { "kind": kind, "doc": value } }).to_string());
                    broadcast(&mut st, &msg, None, true);
                    let _ = shared.to_output.try_send(ControlIn::Doc(kind.to_string(), value));
                }
            }
        }
        if shared.lan_ok && n.is_multiple_of(120) {
            let lan = net::lan_ips();
            let mut st = shared.st.lock();
            if lan != st.lan {
                st.lan = lan.clone();
                let msg = Message::text(json!({ "type": "pairing", "data": pairing(&st, shared.port) }).to_string());
                broadcast(&mut st, &msg, None, false);
                drop(st);
                let urls = write_note(shared, &lan);
                info!("Steuerzentrale im Netz jetzt: {}", if urls.is_empty() { "nicht erreichbar".to_string() } else { urls.join(", ") });
            }
        }
    }
}

/// Writes control.json (if this output announces itself): where its control center is, for
/// start-wand.ps1. Returns the network addresses.
fn write_note(shared: &Shared, lan: &[std::net::Ipv4Addr]) -> Vec<String> {
    let port = shared.port;
    let urls: Vec<String> = lan.iter().map(|ip| format!("http://{ip}:{port}/")).collect();
    if let Some(path) = &shared.note {
        let note = json!({ "url": format!("http://127.0.0.1:{port}/"), "port": port, "lan": urls, "pid": std::process::id() });
        let _ = write_atomic(path, &(note.to_string() + "\n"));
    }
    urls
}

fn pairing(st: &State, port: u16) -> Value {
    json!({
        "code": st.code,
        "urls": st.lan.iter().map(|ip| format!("http://{ip}:{port}/?k={}", st.code)).collect::<Vec<_>>(),
        "local": format!("http://127.0.0.1:{port}/"),
    })
}

// ---------- connections ----------

fn accept(shared: &Arc<Shared>, listener: &TcpListener) {
    for conn in listener.incoming() {
        let Ok(stream) = conn else { continue };
        if shared.connections.load(Ordering::Relaxed) >= MAX_CONNECTIONS {
            continue; // dropped: closed at once
        }
        let Ok(peer) = stream.peer_addr() else { continue };
        shared.connections.fetch_add(1, Ordering::Relaxed);
        let s = shared.clone();
        let spawned = std::thread::Builder::new().name("control-conn".into()).spawn(move || {
            handle(&s, stream, peer);
            s.connections.fetch_sub(1, Ordering::Relaxed);
        });
        if spawned.is_err() {
            shared.connections.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

/// The host of a Host header without its port, in lower case ("[::1]" keeps its brackets).
fn host_name(host: &str) -> String {
    let h = host.trim().to_ascii_lowercase();
    if h.starts_with('[') {
        return h.split(']').next().map(|s| format!("{s}]")).unwrap_or(h);
    }
    h.rsplit_once(':').map_or(h.clone(), |(name, _)| name.to_string())
}

struct Auth {
    ok: bool,
    /// this computer (it may make a new pairing code)
    local: bool,
}

impl Shared {
    /// This computer, by a name that only it uses (not a DNS name that points here: a web page
    /// could rename itself to 127.0.0.1); else a paired device.
    fn auth(&self, req: &http::Request, peer: &SocketAddr) -> Auth {
        let host = host_name(req.header("host").unwrap_or(""));
        let local = peer.ip().is_loopback() && matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]");
        if local {
            return Auth { ok: true, local: true };
        }
        let code = self.st.lock().code.clone();
        let ok = req.cookie(COOKIE).is_some_and(|c| net::same_code(&c, &code));
        Auth { ok, local: false }
    }

    /// A code typed in or from a pairing link: right, wrong, or too many tries from there.
    fn try_code(&self, given: &str, ip: IpAddr) -> Result<String, &'static str> {
        let given: String = given.chars().filter(char::is_ascii_alphanumeric).collect::<String>().to_ascii_uppercase();
        let mut st = self.st.lock();
        let now = Instant::now();
        st.tries.retain(|_, (_, at)| now.duration_since(*at) < TRIES_RESET);
        if st.tries.get(&ip).is_some_and(|(n, _)| *n >= MAX_TRIES) {
            return Err("Zu viele falsche Versuche – bitte in zehn Minuten noch einmal.");
        }
        if net::same_code(&given, &st.code) {
            st.tries.remove(&ip);
            return Ok(st.code.clone());
        }
        let e = st.tries.entry(ip).or_insert((0, now));
        e.0 += 1;
        e.1 = now;
        Err("Der Code stimmt nicht.")
    }
}

fn cookie_header(code: &str) -> String {
    format!("{COOKIE}={code}; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax")
}

fn handle(shared: &Arc<Shared>, mut stream: TcpStream, peer: SocketAddr) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let Ok(req) = http::read_request(&mut stream) else { return };
    let auth = shared.auth(&req, &peer);
    let method = req.method.as_str();
    match (method, req.path.as_str()) {
        ("GET", "/ws") => {
            if !auth.ok {
                return http::respond(&mut stream, 401, "text/plain", &[], b"nicht gekoppelt");
            }
            // a page of another site in this browser must not reach the wall
            if let Some(origin) = req.header("origin")
                && origin.split_once("://").map(|(_, rest)| rest) != req.header("host")
            {
                return http::respond(&mut stream, 403, "text/plain", &[], b"fremde Seite");
            }
            websocket(shared, stream, req, auth.local);
        }
        ("GET" | "HEAD", "/" | "/index.html") => {
            if let Some(k) = req.param("k") {
                // the pairing link (QR code): the cookie, then the page without the code in its address
                return match shared.try_code(&k, peer.ip()) {
                    Ok(code) => http::respond(&mut stream, 303, "", &[("Location", "/".into()), ("Set-Cookie", cookie_header(&code))], b""),
                    Err(why) => pair_page(&mut stream, Some(why)),
                };
            }
            if !auth.ok {
                return pair_page(&mut stream, None);
            }
            serve_asset(shared, &mut stream, &req, "index.html");
        }
        ("POST", "/pair") => {
            let body = String::from_utf8_lossy(&req.body).into_owned();
            let given = http::form_value(&body, "code").unwrap_or_default();
            match shared.try_code(&given, peer.ip()) {
                Ok(code) => http::respond(&mut stream, 303, "", &[("Location", "/".into()), ("Set-Cookie", cookie_header(&code))], b""),
                Err(why) => pair_page(&mut stream, Some(why)),
            }
        }
        // still paired? (a page asks after its connection failed)
        ("GET", "/api/ping") => http::respond(&mut stream, if auth.ok { 204 } else { 401 }, "", &[("Cache-Control", "no-store".into())], b""),
        ("GET", "/api/points") => {
            if !auth.ok {
                return http::respond(&mut stream, 401, "text/plain", &[], b"nicht gekoppelt");
            }
            // the room's floor plan: one point cloud of the hub (a phone cannot reach the hub itself)
            match http::get(&format!("{}/api/frame/points", shared.hub), Duration::from_secs(4)) {
                Ok((_, body)) => http::respond(&mut stream, 200, "application/octet-stream", &[("Cache-Control", "no-store".into())], &body),
                Err(e) => http::respond(&mut stream, 502, "text/plain; charset=utf-8", &[], format!("kinect-hub: {e}").as_bytes()),
            }
        }
        ("GET", "/api/pair.svg") => {
            if !auth.ok {
                return http::respond(&mut stream, 401, "text/plain", &[], b"nicht gekoppelt");
            }
            let url = req.param("url").unwrap_or_default();
            // only our own pairing links (the page asks for one of them)
            let allowed = {
                let st = shared.st.lock();
                pairing(&st, shared.port).get("urls").and_then(Value::as_array).is_some_and(|u| u.iter().any(|x| x.as_str() == Some(url.as_str())))
            };
            match allowed.then(|| net::qr_svg(&url)).flatten() {
                Some(svg) => http::respond(&mut stream, 200, "image/svg+xml", &[("Cache-Control", "no-store".into())], svg.as_bytes()),
                None => http::respond(&mut stream, 404, "text/plain", &[], b"kein Link"),
            }
        }
        ("GET" | "HEAD", path) => {
            let name = path.trim_start_matches('/');
            if name == "favicon.ico" {
                return serve_asset(shared, &mut stream, &req, "icon.svg");
            }
            serve_asset(shared, &mut stream, &req, name);
        }
        _ => http::respond(&mut stream, 405, "text/plain", &[], b"GET oder POST"),
    }
}

fn serve_asset(shared: &Shared, stream: &mut TcpStream, req: &http::Request, name: &str) {
    let Some(body) = assets::get(name, shared.page_dir.as_deref()) else {
        return http::respond(stream, 404, "text/plain", &[], b"nicht gefunden");
    };
    let tag = assets::etag(&body);
    if req.header("if-none-match") == Some(tag.as_str()) {
        return http::respond(stream, 304, "", &[("ETag", tag)], b"");
    }
    let mut headers = vec![("ETag", tag), ("Cache-Control", "no-cache".to_string())];
    if name.ends_with(".html") {
        headers.push(("Content-Security-Policy", "default-src 'self'; img-src 'self' blob: data:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'".into()));
    }
    let body: &[u8] = if req.method == "HEAD" { b"" } else { &body };
    http::respond(stream, 200, http::content_type(name), &headers, body);
}

/// The page a device that is not paired yet sees: the code, or scan the QR code.
fn pair_page(stream: &mut TcpStream, error: Option<&str>) {
    let error = error.map(|e| format!("<p class=\"bad\">{e}</p>")).unwrap_or_default();
    let html = format!(
        r#"<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>LED-Wand · koppeln</title><style>
body{{font:16px system-ui,sans-serif;background:#0d0d11;color:#e8e8ee;margin:0;display:grid;place-items:center;min-height:100vh}}
main{{max-width:24rem;padding:1.5rem}}h1{{font-size:1.3rem}}p{{color:#a9a9b6;line-height:1.45}}.bad{{color:#ff7b8a}}
input{{font:600 1.4rem ui-monospace,monospace;letter-spacing:.12em;width:100%;box-sizing:border-box;padding:.6rem;border-radius:.5rem;border:1px solid #3a3a46;background:#16161c;color:#fff;text-transform:uppercase}}
button{{margin-top:.8rem;width:100%;padding:.7rem;font-size:1.05rem;border:0;border-radius:.5rem;background:#5ad1ff;color:#000;font-weight:600}}
</style></head><body><main><h1>LED-Wand · Steuerzentrale</h1>
<p>Dieses Gerät ist noch nicht gekoppelt. Am einfachsten: in der Steuerzentrale am Notebook unter <b>Fernbedienung</b> den QR-Code scannen. Oder den Code von dort eingeben:</p>
{error}<form method="post" action="/pair"><input name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Code" autofocus><button>Koppeln</button></form>
</main></body></html>"#
    );
    http::respond(stream, 200, "text/html; charset=utf-8", &[("Cache-Control", "no-store".into())], html.as_bytes());
}

// ---------- a control center's WebSocket ----------

fn websocket(shared: &Arc<Shared>, mut stream: TcpStream, req: http::Request, local: bool) {
    let key = req.header("sec-websocket-key").unwrap_or("").to_string();
    if key.is_empty() || !req.header("upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket")) {
        return http::respond(&mut stream, 400, "text/plain", &[], b"WebSocket erwartet");
    }
    let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());
    let head = format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n");
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(Duration::from_millis(40)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let config = WebSocketConfig::default().max_message_size(Some(8 << 20)).max_frame_size(Some(8 << 20));
    let mut ws = WebSocket::from_partially_read(stream, req.rest, Role::Server, Some(config));
    let (tx, rx) = crossbeam_channel::bounded::<Message>(512);
    let stale = Arc::new(AtomicBool::new(false));
    let (id, hello) = {
        let mut st = shared.st.lock();
        let id = st.next_id;
        st.next_id += 1;
        st.clients.push(Client { id, tx, local, frames_until: None, stale: stale.clone() });
        let hello = json!({ "type": "hello", "data": {
            "client": id,
            "local": local,
            "docs": st.store.all(),
            "catalog": st.catalog,
            "telemetry": st.telemetry,
            "pairing": pairing(&st, shared.port),
            "server": { "version": env!("CARGO_PKG_VERSION"), "build": wall::build_id(), "hub": shared.hub, "data": st.store.dir().display().to_string() },
        }});
        (id, Message::text(hello.to_string()))
    };
    let _ = shared.to_output.try_send(ControlIn::Cmd("ping".into(), json!({})));
    let mut alive = ws.send(hello).is_ok();
    let mut last_in = Instant::now();
    let mut last_ping = Instant::now();
    while alive && !stale.load(Ordering::Relaxed) {
        match ws.read() {
            Ok(Message::Text(t)) => {
                last_in = Instant::now();
                on_message(shared, id, local, t.as_str());
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => last_in = Instant::now(),
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => break,
        }
        while let Ok(m) = rx.try_recv() {
            if ws.write(m).is_err() {
                alive = false;
                break;
            }
        }
        if last_ping.elapsed() > Duration::from_secs(20) {
            last_ping = Instant::now();
            let _ = ws.write(Message::Ping(tungstenite::Bytes::new()));
        }
        match ws.flush() {
            Ok(()) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => alive = false,
        }
        // a page that went away without closing (a phone that slept)
        if last_in.elapsed() > Duration::from_secs(75) {
            break;
        }
    }
    let _ = ws.close(None);
    let _ = ws.flush();
    shared.st.lock().clients.retain(|c| c.id != id);
}

/// What a control center says.
fn on_message(shared: &Arc<Shared>, id: u64, local: bool, text: &str) {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return };
    let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
    let data = v.get("data").cloned().unwrap_or_else(|| json!({}));
    match kind {
        "doc" => {
            let Some(k) = data.get("kind").and_then(Value::as_str).filter(|k| store::KINDS.contains(k)) else { return };
            let Some(doc) = data.get("doc").filter(|d| d.is_object()).cloned() else { return };
            let mut st = shared.st.lock();
            if !st.store.set(k, doc.clone()) {
                return;
            }
            // the other control centers follow at once
            let msg = Message::text(json!({ "type": "doc", "data": { "kind": k, "doc": doc } }).to_string());
            broadcast(&mut st, &msg, Some(id), true);
            drop(st);
            let _ = shared.to_output.try_send(ControlIn::Doc(k.to_string(), doc));
        }
        "preview" => {
            let on = data.get("on") != Some(&Value::Bool(false));
            {
                let mut st = shared.st.lock();
                if let Some(c) = st.clients.iter_mut().find(|c| c.id == id) {
                    c.frames_until = on.then(|| Instant::now() + FRAMES_FOR);
                }
            }
            if on {
                let _ = shared.to_output.try_send(ControlIn::Cmd("preview".into(), json!({ "on": true })));
            }
        }
        "pairing.renew" if local && !shared.read_only => {
            let code = net::new_code();
            let dir = shared.st.lock().store.dir().to_path_buf();
            let _ = write_atomic(&dir.join("control-code.txt"), &format!("{code}\n"));
            let mut st = shared.st.lock();
            st.code = code;
            // the paired devices are not any more: their pages end
            for c in &st.clients {
                if !c.local {
                    c.stale.store(true, Ordering::Relaxed);
                }
            }
            let msg = Message::text(json!({ "type": "pairing", "data": pairing(&st, shared.port) }).to_string());
            broadcast(&mut st, &msg, None, false);
            info!("Steuerzentrale: neuer Kopplungscode, andere Geräte sind entkoppelt");
        }
        "play" | "next" | "prev" | "stop" | "blackout" | "pattern" | "wizard" | "ping" => {
            let _ = shared.to_output.try_send(ControlIn::Cmd(kind.to_string(), data));
        }
        _ => {}
    }
}
