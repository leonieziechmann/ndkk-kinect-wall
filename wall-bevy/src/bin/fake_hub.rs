//! A stand-in for kinect-hub (same WebSocket protocol, kinect-hub/README.md) with synthetic people:
//! a room (floor, back wall) and up to four figures walking, waving, jumping, with masks, depth and
//! skeletons as the hub's person tracking sends them. For testing the output without a Kinect.
//!
//!   fake-hub [--bind 127.0.0.1:8099] [--persons 3] [--fps 30] [--jitter 6] [--freeze 4.2]
//!
//! --jitter adds random delay (ms) to every frame, like a busy network or hub; --freeze shows the
//! moment t (s) in every frame (the same picture for comparisons).

use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tungstenite::Message;

const W: usize = 512;
const H: usize = 424;
const N: usize = W * H;
const F: f32 = 365.5;
const CX: f32 = 256.0;
const CY: f32 = 206.0;
const SENSOR_H: f32 = 0.85;
static FROZEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn now_us() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0)
}

/// One frame of the synthetic world.
struct Frame {
    seq: u32,
    capture_us: u64,
    depth: Vec<u16>,
    labels: Vec<u8>,
    persons: Vec<Value>,
}

#[derive(Clone, Copy)]
struct V3 {
    x: f32,
    y: f32,
    z: f32,
}

fn v3(x: f32, y: f32, z: f32) -> V3 {
    V3 { x, y, z }
}

fn project(p: V3) -> (f32, f32) {
    (CX + F * p.x / p.z, CY + F * p.y / p.z)
}

/// The 17 COCO joints of a figure in the camera frame (m; y down), its id-dependent motion at time t.
fn skeleton(i: usize, t: f32) -> [V3; 17] {
    let fi = i as f32;
    let speed = 0.25 + 0.12 * fi;
    let z = 1.7 + 0.75 * fi + 0.35 * (t * 0.21 + fi).sin();
    let x = 1.9 * (t * speed + fi * 1.7).sin() * (z / 3.0).min(1.2);
    let hgt = 1.55 + 0.12 * ((fi * 2.3).sin() + 1.0);
    let jump = if i == 1 { ((t * 1.3).sin().max(0.0)).powi(4) * 0.35 } else { 0.0 };
    let floor_y = SENSOR_H; // camera y of the floor (down)
    let base = floor_y - jump;
    let s = hgt / 1.7;
    let wave = (t * (3.0 + fi)).sin();
    let step = (t * 4.0 * speed * 3.0).sin();
    let p = |dx: f32, up: f32, dz: f32| v3(x + dx * s, base - up * s, z + dz * s);
    let arm_up = if i % 2 == 0 { 0.45 + 0.35 * wave } else { 0.1 };
    [
        p(0.0, 1.62, -0.08),                         // nose
        p(-0.03, 1.66, -0.06),                       // left eye
        p(0.03, 1.66, -0.06),                        // right eye
        p(-0.07, 1.64, 0.0),                         // left ear
        p(0.07, 1.64, 0.0),                          // right ear
        p(-0.19, 1.42, 0.0),                         // left shoulder
        p(0.19, 1.42, 0.0),                          // right shoulder
        p(-0.27, 1.15 + arm_up * 0.4, 0.02),         // left elbow
        p(0.26, 1.15, 0.02 * step),                  // right elbow
        p(-0.33, 0.92 + arm_up * 1.4, -0.05),        // left wrist
        p(0.3, 0.9 + 0.1 * step, -0.08 * step),      // right wrist
        p(-0.11, 0.95, 0.0),                         // left hip
        p(0.11, 0.95, 0.0),                          // right hip
        p(-0.12, 0.5, 0.1 * step),                   // left knee
        p(0.12, 0.5, -0.1 * step),                   // right knee
        p(-0.12, 0.06, 0.15 * step),                 // left ankle
        p(0.12, 0.06, -0.15 * step),                 // right ankle
    ]
}

/// Body parts as capsules: (joint a, joint b, radius m)
const PARTS: [(usize, usize, f32); 13] = [
    (5, 6, 0.09),
    (5, 11, 0.13),
    (6, 12, 0.13),
    (11, 12, 0.13),
    (5, 7, 0.05),
    (7, 9, 0.045),
    (6, 8, 0.05),
    (8, 10, 0.045),
    (11, 13, 0.075),
    (13, 15, 0.06),
    (12, 14, 0.075),
    (14, 16, 0.06),
    (0, 0, 0.11), // head (sphere around the nose, moved back)
];

fn render(seq: u32, t: f32, persons: usize) -> Frame {
    let mut depth = vec![0u16; N];
    let mut labels = vec![0u8; N];
    // the room: floor and a back wall at 5.5 m
    for v in 0..H {
        for u in 0..W {
            let rx = (u as f32 - CX) / F;
            let ry = (v as f32 - CY) / F;
            let mut z = 5.5_f32;
            if ry > 0.0 {
                z = z.min(SENSOR_H / ry);
            }
            let noise = (((u * 7 + v * 13 + if FROZEN.load(std::sync::atomic::Ordering::Relaxed) { 0 } else { seq as usize * 3 }) % 17) as f32 - 8.0) * 2.0;
            depth[v * W + u] = if rx.abs() > 1.2 { 0 } else { (z * 1000.0 + noise).clamp(500.0, 8000.0) as u16 };
        }
    }
    let mut list = Vec::new();
    for i in 0..persons {
        let j = skeleton(i, t);
        let slot = (i + 1) as u8;
        let mut pixels = 0u32;
        let (mut u0, mut v0, mut u1, mut v1) = (W as f32, H as f32, 0.0_f32, 0.0_f32);
        for &(a, b, r) in &PARTS {
            let (pa, pb) = if a == 0 && b == 0 {
                let c = v3((j[3].x + j[4].x) / 2.0, j[0].y - 0.02, (j[3].z + j[4].z) / 2.0 + 0.02);
                (c, c)
            } else {
                (j[a], j[b])
            };
            let (ua, va) = project(pa);
            let (ub, vb) = project(pb);
            let ra = F * r / pa.z;
            let rb = F * r / pb.z;
            let (bx0, bx1) = ((ua.min(ub) - ra.max(rb)).floor().max(0.0) as usize, ((ua.max(ub) + ra.max(rb)).ceil() as usize).min(W - 1));
            let (by0, by1) = ((va.min(vb) - ra.max(rb)).floor().max(0.0) as usize, ((va.max(vb) + ra.max(rb)).ceil() as usize).min(H - 1));
            for v in by0..=by1 {
                for u in bx0..=bx1 {
                    let (px, py) = (u as f32 + 0.5, v as f32 + 0.5);
                    let (dx, dy) = (ub - ua, vb - va);
                    let len2 = dx * dx + dy * dy;
                    let k = if len2 > 1e-6 { (((px - ua) * dx + (py - va) * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
                    let (cx, cy) = (ua + dx * k, va + dy * k);
                    let rr = ra + (rb - ra) * k;
                    let d2 = (px - cx).powi(2) + (py - cy).powi(2);
                    if d2 > rr * rr {
                        continue;
                    }
                    let zc = pa.z + (pb.z - pa.z) * k;
                    let bulge = r * (1.0 - d2 / (rr * rr)).sqrt();
                    let zz = ((zc - bulge) * 1000.0) as u16;
                    let i2 = v * W + u;
                    if labels[i2] == 0 || zz < depth[i2] || labels[i2] == slot {
                        if labels[i2] != slot {
                            pixels += 1;
                        }
                        if labels[i2] == 0 || zz < depth[i2] {
                            depth[i2] = zz;
                            labels[i2] = slot;
                        }
                    }
                    u0 = u0.min(u as f32);
                    v0 = v0.min(v as f32);
                    u1 = u1.max(u as f32);
                    v1 = v1.max(v as f32);
                }
            }
        }
        let mm = |p: V3| json!([p.x * 1000.0, p.y * 1000.0, p.z * 1000.0]);
        let joints: Vec<Value> = j.iter().map(|p| json!([p.x * 1000.0, p.y * 1000.0, p.z * 1000.0, 0.9])).collect();
        let kps: Vec<Value> = j
            .iter()
            .map(|p| {
                let (u, v) = project(*p);
                json!([u, v, 0.9])
            })
            .collect();
        let mid = |a: V3, b: V3| v3((a.x + b.x) / 2.0, (a.y + b.y) / 2.0, (a.z + b.z) / 2.0);
        let neck = mid(j[5], j[6]);
        let pelvis = mid(j[11], j[12]);
        let head = mid(j[1], j[2]);
        let ext = |a: V3, b: V3| v3(b.x + (b.x - a.x) * 0.3, b.y + (b.y - a.y) * 0.3, b.z + (b.z - a.z) * 0.3);
        let lh = ext(j[7], j[9]);
        let rh = ext(j[8], j[10]);
        let extra = [neck, pelvis, head, lh, rh];
        let centroid = mid(neck, pelvis);
        let ground = v3(pelvis.x, SENSOR_H, pelvis.z);
        let jt = skeleton(i, t + 0.033);
        let vel = v3((jt[11].x - j[11].x) / 0.033 * 1000.0, (jt[11].y - j[11].y) / 0.033 * 1000.0, (jt[11].z - j[11].z) / 0.033 * 1000.0);
        list.push(json!({
            "id": 100 + i, "slot": slot, "visible": true, "age": t, "score": 0.9, "pixels": pixels, "area": pixels as f32 * 0.0001,
            "centroid": mm(centroid), "head": mm(head), "ground": mm(ground), "height": SENSOR_H - j[0].y + 0.1,
            "velocity": [vel.x, vel.y, vel.z], "bbox": [u0, v0, u1, v1],
            "joints": joints, "keypoints": kps,
            "extra": extra.iter().map(|p| json!([p.x * 1000.0, p.y * 1000.0, p.z * 1000.0, 0.9])).collect::<Vec<_>>(),
            "extraKeypoints": extra.iter().map(|p| { let (u, v) = project(*p); json!([u, v, 0.9]) }).collect::<Vec<_>>(),
        }));
    }
    Frame { seq, capture_us: now_us(), depth, labels, persons: list }
}

fn header(kind: u8, seq: u32, capture: u64, payload: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(32 + payload.len());
    b.extend_from_slice(&0x3148_324bu32.to_le_bytes());
    b.push(kind);
    b.push(1);
    b.extend_from_slice(&32u16.to_le_bytes());
    b.extend_from_slice(&seq.to_le_bytes());
    b.extend_from_slice(&(W as u16).to_le_bytes());
    b.extend_from_slice(&(H as u16).to_le_bytes());
    b.extend_from_slice(&capture.to_le_bytes());
    b.extend_from_slice(&now_us().to_le_bytes());
    b.extend_from_slice(payload);
    b
}

fn rle(labels: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut it = labels.iter().copied();
    let Some(mut value) = it.next() else { return out };
    let mut len: u16 = 1;
    for v in it {
        if v == value && len < u16::MAX {
            len += 1;
            continue;
        }
        out.push(value);
        out.extend_from_slice(&len.to_le_bytes());
        value = v;
        len = 1;
    }
    out.push(value);
    out.extend_from_slice(&len.to_le_bytes());
    out
}

fn lut_payload() -> Vec<u8> {
    let mut b = Vec::with_capacity(N * 8);
    for v in 0..H {
        for u in 0..W {
            b.extend_from_slice(&((u as f32 - CX) / F).to_le_bytes());
            b.extend_from_slice(&((v as f32 - CY) / F).to_le_bytes());
        }
    }
    b
}

type Shared = Arc<Mutex<Option<Arc<Frame>>>>;

fn client(stream: TcpStream, frame: Shared, jitter: f32) {
    stream.set_nodelay(true).ok();
    let Ok(mut ws) = tungstenite::accept(stream) else { return };
    ws.get_ref().set_read_timeout(Some(Duration::from_millis(2))).ok();
    let names = ["depth", "depth_raw", "ir", "points", "lut", "meta", "status", "poses", "persons", "persons_live"];
    let list: Vec<Value> = names.iter().map(|s| json!({ "name": s })).collect();
    let hello = json!({
        "type": "hello", "accepts": ["subscribe", "ping", "render"],
        "streams": list,
        "params": { "fx": F, "fy": F, "cx": CX, "cy": CY },
    });
    let _ = ws.send(Message::text(hello.to_string()));
    let mut streams: Vec<String> = vec!["status".into()];
    let mut last_seq = u32::MAX;
    let mut last_status = Instant::now() - Duration::from_secs(2);
    let mut rng = 12345u32;
    loop {
        match ws.read() {
            Ok(Message::Text(t)) => {
                let v: Value = serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
                match v.get("type").and_then(Value::as_str) {
                    Some("subscribe") => {
                        streams = v.get("streams").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                        if streams.iter().any(|s| s == "lut") {
                            let _ = ws.send(Message::text(json!({ "type": "params", "params": { "fx": F, "fy": F, "cx": CX, "cy": CY } }).to_string()));
                            let _ = ws.send(Message::binary(header(16, 0, now_us(), &lut_payload())));
                        }
                    }
                    Some("ping") => {
                        let _ = ws.send(Message::text(json!({ "type": "pong", "t": v.get("t"), "server_time_us": now_us() }).to_string()));
                    }
                    _ => {}
                }
            }
            Ok(Message::Close(_)) => return,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => return,
        }
        if last_status.elapsed() > Duration::from_secs(1) {
            last_status = Instant::now();
            let st = json!({ "type": "status", "fps": 30.0, "source": "synthetic", "sensor": { "state": "streaming" }, "tracking": { "state": "running" }, "pose": { "state": "running" } });
            if ws.send(Message::text(st.to_string())).is_err() {
                return;
            }
        }
        let f = frame.lock().ok().and_then(|g| g.clone());
        let Some(f) = f else { continue };
        if f.seq == last_seq {
            continue;
        }
        last_seq = f.seq;
        if jitter > 0.0 {
            rng ^= rng << 13;
            rng ^= rng >> 17;
            rng ^= rng << 5;
            std::thread::sleep(Duration::from_secs_f32((rng % 1000) as f32 / 1000.0 * jitter / 1000.0));
        }
        let has = |s: &str| streams.iter().any(|x| x == s);
        if has("meta") {
            let _ = ws.send(Message::text(json!({ "type": "frame", "seq": f.seq, "capture_time_us": f.capture_us, "stats": { "median_mm": 3000 } }).to_string()));
        }
        if has("depth") || has("depth_raw") {
            let payload: Vec<u8> = f.depth.iter().flat_map(|d| d.to_le_bytes()).collect();
            if ws.send(Message::binary(header(1, f.seq, f.capture_us, &payload))).is_err() {
                return;
            }
        }
        if has("ir") {
            let ir: Vec<u8> = f.depth.iter().zip(&f.labels).map(|(d, l)| if *l > 0 { 200 } else { (255 - (*d / 40).min(255) as u8) / 2 }).collect();
            let _ = ws.send(Message::binary(header(3, f.seq, f.capture_us, &ir)));
        }
        for (name, kind) in [("persons_live", 6u8), ("persons", 5u8)] {
            if !has(name) {
                continue;
            }
            let floor = json!({ "normal": [0.0, -1.0, 0.0], "d": SENSOR_H, "height": SENSOR_H, "pitchDeg": 0.0, "rollDeg": 0.0, "support": 1.0, "source": "floor" });
            let msg = json!({ "type": name, "seq": f.seq, "capture_time_us": f.capture_us, "publish_time_us": now_us(), "count": 0, "persons": f.persons, "floor": floor, "ms": 3.0, "waited": 0, "pose_ms": 12.0, "pose_runs": f.seq / 2 });
            let _ = ws.send(Message::text(msg.to_string()));
            if ws.send(Message::binary(header(kind, f.seq, f.capture_us, &rle(&f.labels)))).is_err() {
                return;
            }
        }
    }
}

fn main() {
    let mut bind = "127.0.0.1:8099".to_string();
    let mut persons = 3usize;
    let mut fps = 30.0_f32;
    let mut jitter = 0.0_f32;
    let mut freeze: Option<f32> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--bind" => bind = args.next().unwrap_or(bind),
            "--persons" => persons = args.next().and_then(|v| v.parse().ok()).unwrap_or(persons).min(4),
            "--fps" => fps = args.next().and_then(|v| v.parse().ok()).unwrap_or(fps),
            "--jitter" => jitter = args.next().and_then(|v| v.parse().ok()).unwrap_or(jitter),
            "--freeze" => freeze = args.next().and_then(|v| v.parse().ok()),
            _ => {
                eprintln!("fake-hub [--bind 127.0.0.1:8099] [--persons 3] [--fps 30] [--jitter ms] [--freeze t]");
                return;
            }
        }
    }
    FROZEN.store(freeze.is_some(), std::sync::atomic::Ordering::Relaxed);
    let shared: Shared = Arc::new(Mutex::new(None));
    let s2 = shared.clone();
    std::thread::spawn(move || {
        let start = Instant::now();
        let period = Duration::from_secs_f32(1.0 / fps);
        let mut next = Instant::now();
        let mut seq = 0u32;
        loop {
            let f = render(seq, freeze.unwrap_or_else(|| start.elapsed().as_secs_f32()), persons);
            if let Ok(mut g) = s2.lock() {
                *g = Some(Arc::new(f));
            }
            seq += 1;
            next += period;
            let now = Instant::now();
            if next > now {
                std::thread::sleep(next - now);
            } else {
                next = now;
            }
        }
    });
    let Ok(listener) = TcpListener::bind(&bind) else {
        eprintln!("{bind} ist belegt");
        return;
    };
    eprintln!("fake-hub auf ws://{bind}/ws ({persons} Personen, {fps} fps)");
    for stream in listener.incoming().flatten() {
        let f = shared.clone();
        std::thread::spawn(move || client(stream, f, jitter));
    }
}
