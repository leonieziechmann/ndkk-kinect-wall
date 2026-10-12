//! Just enough HTTP/1.1 for the control center: one request per connection (Connection: close), the
//! head parsed by httparse, a small body by Content-Length. Plus a tiny client for the hub's
//! frames (GET, Content-Length or chunked).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

/// The head may be this long; bodies (a pairing code) this long.
const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 16 * 1024;

pub struct Request {
    pub method: String,
    /// the path without the query
    pub path: String,
    pub query: String,
    /// names in lower case
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// bytes after the head that are not the body (a WebSocket's first frames)
    pub rest: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    /// A query parameter (percent-decoded).
    pub fn param(&self, name: &str) -> Option<String> {
        form_value(&self.query, name)
    }

    pub fn cookie(&self, name: &str) -> Option<String> {
        let c = self.header("cookie")?;
        c.split(';').filter_map(|p| p.trim().split_once('=')).find(|(k, _)| *k == name).map(|(_, v)| v.to_string())
    }
}

/// A value of an application/x-www-form-urlencoded string (a query or a form body).
pub fn form_value(s: &str, name: &str) -> Option<String> {
    s.split('&').filter_map(|p| p.split_once('=')).find(|(k, _)| *k == name).map(|(_, v)| percent_decode(v))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b.get(i) {
            Some(b'+') => out.push(b' '),
            Some(b'%') => {
                let hex = b.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
                match hex {
                    Some(v) => {
                        out.push(v);
                        i += 2;
                    }
                    None => out.push(b'%'),
                }
            }
            Some(c) => out.push(*c),
            None => break,
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Reads one request (head and a small body) or says why not.
pub fn read_request(stream: &mut TcpStream) -> Result<Request, String> {
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    let head_len = loop {
        let n = stream.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("closed".into());
        }
        buf.extend_from_slice(chunk.get(..n).unwrap_or_default());
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break p + 4;
        }
        if buf.len() > MAX_HEAD {
            return Err("head too large".into());
        }
    };
    let mut headers = [httparse::EMPTY_HEADER; 48];
    let mut req = httparse::Request::new(&mut headers);
    match req.parse(&buf) {
        Ok(httparse::Status::Complete(_)) => {}
        Ok(httparse::Status::Partial) => return Err("partial head".into()),
        Err(e) => return Err(e.to_string()),
    }
    let method = req.method.unwrap_or("").to_string();
    let target = req.path.unwrap_or("/");
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let headers: Vec<(String, String)> = req.headers.iter().map(|h| (h.name.to_ascii_lowercase(), String::from_utf8_lossy(h.value).into_owned())).collect();
    let len: usize = headers.iter().find(|(k, _)| k == "content-length").and_then(|(_, v)| v.trim().parse().ok()).unwrap_or(0);
    if len > MAX_BODY {
        return Err("body too large".into());
    }
    let mut rest = buf.get(head_len..).unwrap_or_default().to_vec();
    while rest.len() < len {
        let n = stream.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("closed".into());
        }
        rest.extend_from_slice(chunk.get(..n).unwrap_or_default());
    }
    let body: Vec<u8> = rest.drain(..len).collect();
    Ok(Request { method, path: path.to_string(), query: query.to_string(), headers, body, rest })
}

/// Writes a whole response and leaves the connection to be closed.
pub fn respond(stream: &mut TcpStream, status: u16, content_type: &str, headers: &[(&str, String)], body: &[u8]) {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        303 => "See Other",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        429 => "Too Many Requests",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "",
    };
    let mut head = format!("HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n", body.len());
    if !content_type.is_empty() {
        head.push_str(&format!("Content-Type: {content_type}\r\n"));
    }
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

/// The content type of a file name.
pub fn content_type(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

/// GET `url` (http://host:port/path): the content type and the body. For the hub's frames.
pub fn get(url: &str, timeout: Duration) -> Result<(String, Vec<u8>), String> {
    let rest = url.strip_prefix("http://").ok_or("nur http://")?;
    let (host, path) = rest.split_once('/').map_or((rest, "/".to_string()), |(h, p)| (h, format!("/{p}")));
    let addr = std::net::ToSocketAddrs::to_socket_addrs(host).map_err(|e| e.to_string())?.next().ok_or("keine Adresse")?;
    let mut s = TcpStream::connect_timeout(&addr, timeout).map_err(|e| e.to_string())?;
    let _ = s.set_read_timeout(Some(timeout));
    let _ = s.set_write_timeout(Some(timeout));
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nAccept-Encoding: identity\r\n\r\n").as_bytes()).map_err(|e| e.to_string())?;
    let mut all = Vec::new();
    // a reset after the whole answer (some servers close hard) is no error
    if let Err(e) = s.read_to_end(&mut all)
        && all.is_empty()
    {
        return Err(e.to_string());
    }
    let head_len = all.windows(4).position(|w| w == b"\r\n\r\n").ok_or("keine Antwort")? + 4;
    let mut headers = [httparse::EMPTY_HEADER; 48];
    let mut res = httparse::Response::new(&mut headers);
    res.parse(&all).map_err(|e| e.to_string())?;
    let code = res.code.unwrap_or(0);
    let header = |name: &str| res.headers.iter().find(|h| h.name.eq_ignore_ascii_case(name)).map(|h| String::from_utf8_lossy(h.value).into_owned());
    let content_type = header("content-type").unwrap_or_default();
    let chunked = header("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    let raw = all.get(head_len..).unwrap_or_default();
    let body = if chunked { dechunk(raw)? } else { raw.to_vec() };
    if let Some(len) = header("content-length").and_then(|v| v.trim().parse::<usize>().ok())
        && body.len() < len
    {
        return Err(format!("Antwort abgebrochen ({} von {len} Bytes)", body.len()));
    }
    if code != 200 {
        return Err(format!("HTTP {code}: {}", String::from_utf8_lossy(body.get(..200.min(body.len())).unwrap_or_default())));
    }
    Ok((content_type, body))
}

fn dechunk(mut raw: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(raw.len());
    loop {
        let line_end = raw.windows(2).position(|w| w == b"\r\n").ok_or("chunked: Zeile")?;
        let size_text = std::str::from_utf8(raw.get(..line_end).unwrap_or_default()).map_err(|e| e.to_string())?;
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16).map_err(|e| e.to_string())?;
        raw = raw.get(line_end + 2..).unwrap_or_default();
        if size == 0 {
            return Ok(out);
        }
        out.extend_from_slice(raw.get(..size).ok_or("chunked: zu kurz")?);
        raw = raw.get(size + 2..).unwrap_or_default();
    }
}
