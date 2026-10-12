//! What a remote control needs to find the wall: this computer's addresses in the local network, a
//! pairing code, the pairing link as a QR code.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::net::{IpAddr, Ipv4Addr, UdpSocket};

/// This computer's IPv4 addresses in the local network (the ones a route to the outside or to the
/// usual private networks leaves from; a UDP "connect" sends nothing).
pub fn lan_ips() -> Vec<Ipv4Addr> {
    let mut out: Vec<Ipv4Addr> = Vec::new();
    for target in ["8.8.8.8:80", "192.168.0.1:80", "192.168.1.1:80", "10.0.0.1:80", "172.16.0.1:80"] {
        let ip = UdpSocket::bind("0.0.0.0:0").ok().and_then(|s| s.connect(target).ok().and_then(|()| s.local_addr().ok())).map(|a| a.ip());
        if let Some(IpAddr::V4(v4)) = ip
            && !v4.is_loopback()
            && !v4.is_unspecified()
            && !out.contains(&v4)
        {
            out.push(v4);
        }
    }
    // private ranges first (the ones phones on the same Wi-Fi reach)
    out.sort_by_key(|ip| !ip.is_private());
    out
}

/// A pairing code: 10 letters and digits that cannot be mixed up when typed (no 0/O, 1/I/L).
pub fn new_code() -> String {
    const ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    let mut out = String::new();
    while out.len() < 10 {
        // RandomState is seeded from the operating system's random source
        let mut h = RandomState::new().build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        h.write_u32(std::process::id());
        let mut v = h.finish();
        for _ in 0..6 {
            let i = (v % ALPHABET.len() as u64) as usize;
            v /= ALPHABET.len() as u64;
            if let Some(c) = ALPHABET.get(i) {
                out.push(char::from(*c));
            }
        }
    }
    out.truncate(10);
    out
}

/// Compares two codes in constant time (no timing hints for guessing).
pub fn same_code(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `text` as a QR code in SVG (black modules on white, a quiet zone of 4).
pub fn qr_svg(text: &str) -> Option<String> {
    let q = wall::common::qr::encode_qr(text, 'M', 1)?;
    let n = q.size;
    let side = n + 8;
    let mut path = String::new();
    for y in 0..n {
        for x in 0..n {
            if q.get(x, y) {
                path.push_str(&format!("M{} {}h1v1h-1z", x + 4, y + 4));
            }
        }
    }
    Some(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {side} {side}\" shape-rendering=\"crispEdges\"><rect width=\"{side}\" height=\"{side}\" fill=\"#fff\"/><path d=\"{path}\" fill=\"#000\"/></svg>"
    ))
}
