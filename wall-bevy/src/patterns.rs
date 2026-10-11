//! Test images and the play field assistant on the LED image (port of the drawing in
//! web/lib/wall-output.js): raster, calibration (people as the mapping puts them), color bars,
//! gray steps, a moving bar, full colors, and the floor plan of the assistant.

use std::f32::consts::{PI, TAU};

use serde_json::Value;

use crate::canvas::{Align, Baseline, Canvas, Font, Rgba};
use crate::kinect::KinectData;
use crate::persons::{BONES, j};
use crate::wall::WallMap;

fn px(n: f32) -> f32 {
    n.round().max(1.0)
}

/// Draws test image `name` (over: on top of the scene, transparent background).
pub fn draw_pattern(g: &mut Canvas, name: &str, over: bool, now: f64, wall: &WallMap, kinect: &KinectData) {
    let (w, h) = (g.width() as f32, g.height() as f32);
    g.clear();
    g.alpha = 1.0;
    g.line_width = 1.0;
    g.dash.clear();
    if !(over && (name == "people" || name == "grid")) {
        g.fill_rect(0.0, 0.0, w, h, Rgba(0.0, 0.0, 0.0, 1.0));
    }
    match name {
        "grid" => draw_grid(g, w, h, wall),
        "people" => draw_people(g, w, h, wall, kinect),
        "bars" => draw_bars(g, w, h),
        "ramp" => draw_ramp(g, w, h),
        "sweep" => draw_sweep(g, w, h, now),
        "white" => g.fill_rect(0.0, 0.0, w, h, Rgba(1.0, 1.0, 1.0, 1.0)),
        "red" => g.fill_rect(0.0, 0.0, w, h, Rgba(1.0, 0.0, 0.0, 1.0)),
        "green" => g.fill_rect(0.0, 0.0, w, h, Rgba(0.0, 1.0, 0.0, 1.0)),
        "blue" => g.fill_rect(0.0, 0.0, w, h, Rgba(0.0, 0.0, 1.0, 1.0)),
        _ => {}
    }
}

fn draw_grid(g: &mut Canvas, w: f32, h: f32, wall: &WallMap) {
    let s = &wall.setup;
    let (cw, ch) = (s.cabinet_w as f32, s.cabinet_h as f32);
    let line = Rgba::hex("#3a3a44");
    let mut x = cw;
    while x < w {
        g.fill_rect(x, 0.0, 1.0, h, line);
        x += cw;
    }
    let mut y = ch;
    while y < h {
        g.fill_rect(0.0, y, w, 1.0, line);
        y += ch;
    }
    // cabinet numbers (column.row)
    let f = Font::sans(px(cw.min(ch) / 6.0), 400);
    let mut r = 0;
    while (r as f32) * ch < h {
        let mut c = 0;
        while (c as f32) * cw < w {
            g.fill_text(&format!("{}.{}", c + 1, r + 1), c as f32 * cw + 3.0, r as f32 * ch + 3.0, &f, Align::Left, Baseline::Top, Rgba::hex("#6a6a78"), None);
            c += 1;
        }
        r += 1;
    }
    // a circle: round on the wall if the pixels are mapped right
    g.line_width = 1.0;
    g.stroke_arc(w / 2.0, h / 2.0, h * 0.42, 0.0, TAU, Rgba::hex("#2bd4ff"));
    g.fill_rect((w / 2.0).floor(), 0.0, 1.0, h, Rgba::hex("#2bd4ff"));
    g.fill_rect(0.0, (h / 2.0).floor(), w, 1.0, Rgba::hex("#2bd4ff"));
    // corners: red top left, green top right, blue bottom left, yellow bottom right
    let k = px(w.min(h) * 0.12);
    g.fill_poly(&[(0.0, 0.0), (k, 0.0), (0.0, k)], Rgba::hex("#ff2030"));
    g.fill_poly(&[(w, 0.0), (w - k, 0.0), (w, k)], Rgba::hex("#20ff40"));
    g.fill_poly(&[(0.0, h), (k, h), (0.0, h - k)], Rgba::hex("#3050ff"));
    g.fill_poly(&[(w, h), (w - k, h), (w, h - k)], Rgba::hex("#ffe020"));
    // meters along the bottom
    let ppm = w / s.size_w;
    let f = Font::sans(px(h / 22.0), 400);
    let mut m = 0.0_f32;
    while m <= s.size_w + 1e-6 {
        let x = (w - 1.0).min((m * ppm).round());
        let big = (m - m.round()).abs() < 1e-6;
        let len = px(if big { h / 14.0 } else { h / 28.0 });
        g.fill_rect(x, h - len, 1.0, len, Rgba::hex("#dddddd"));
        if big && m > 0.0 && m < s.size_w - 0.01 {
            g.fill_text(&format!("{} m", m as i32), x + 3.0, h - 3.0, &f, Align::Left, Baseline::Bottom, Rgba::hex("#dddddd"), None);
        }
        m += 0.5;
    }
    // the outermost LEDs: a 1-pixel white frame
    let white = Rgba(1.0, 1.0, 1.0, 1.0);
    g.fill_rect(0.0, 0.0, w, 1.0, white);
    g.fill_rect(0.0, h - 1.0, w, 1.0, white);
    g.fill_rect(0.0, 0.0, 1.0, h, white);
    g.fill_rect(w - 1.0, 0.0, 1.0, h, white);
    g.fill_text(&format!("{} × {}", w as u32, h as u32), w / 2.0, h / 2.0 - h * 0.1, &Font::sans(px(h / 9.0), 600), Align::Center, Baseline::Middle, white, None);
    g.fill_text(
        &format!("{} × {} m · {:.2} mm", fmt_m(s.size_w), fmt_m(s.size_h), 1000.0 * s.size_w / w),
        w / 2.0,
        h / 2.0 + h * 0.08,
        &Font::sans(px(h / 16.0), 400),
        Align::Center,
        Baseline::Middle,
        Rgba::hex("#bbbbbb"),
        None,
    );
}

fn fmt_m(v: f32) -> String {
    let s = format!("{v:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn draw_bars(g: &mut Canvas, w: f32, h: f32) {
    let cols = ["#ffffff", "#ffff00", "#00ffff", "#00ff00", "#ff00ff", "#ff0000", "#0000ff", "#000000"];
    let bw = w / cols.len() as f32;
    for (i, c) in cols.iter().enumerate() {
        g.fill_rect((i as f32 * bw).round(), 0.0, bw.ceil(), (h * 0.7).round(), Rgba::hex(c));
    }
    for i in 0..16 {
        let v = (i as f32 / 15.0 * 255.0).round() / 255.0;
        g.fill_rect((i as f32 * w / 16.0).round(), (h * 0.7).round(), (w / 16.0).ceil(), h, Rgba(v, v, v, 1.0));
    }
}

fn draw_ramp(g: &mut Canvas, w: f32, h: f32) {
    g.fill_rect_gradient_x(0.0, 0.0, w, h / 2.0, 0.0, w, Rgba(0.0, 0.0, 0.0, 1.0), Rgba(1.0, 1.0, 1.0, 1.0));
    let steps = 32;
    for i in 0..steps {
        let v = (i as f32 / (steps - 1) as f32 * 255.0).round() / 255.0;
        g.fill_rect((i as f32 * w / steps as f32).round(), (h / 2.0).round(), (w / steps as f32).ceil(), (h / 4.0).ceil(), Rgba(v, v, v, 1.0));
    }
    // the darkest steps, where LED walls lose detail
    for i in 0..16 {
        let v = i as f32 / 255.0;
        g.fill_rect((i as f32 * w / 16.0).round(), (h * 3.0 / 4.0).round(), (w / 16.0).ceil(), h, Rgba(v, v, v, 1.0));
    }
}

fn draw_sweep(g: &mut Canvas, w: f32, h: f32, now: f64) {
    let t = now / 1000.0;
    let x = ((t * 0.25) % 1.0 * f64::from(w)).floor() as f32;
    let y = ((t * 0.4) % 1.0 * f64::from(h)).floor() as f32;
    g.fill_rect(x, 0.0, 4.0, h, Rgba(1.0, 1.0, 1.0, 1.0));
    g.fill_rect(0.0, y, w, 2.0, Rgba::hex("#2bd4ff"));
}

/// The highest a person reaches (m above the floor): a hand, else the head.
pub fn reach_of(p: &crate::persons::Person) -> Option<f32> {
    let mut top: Option<f32> = None;
    for jj in [j::LEFT_HAND, j::RIGHT_HAND, j::LEFT_WRIST, j::RIGHT_WRIST, j::HEAD] {
        if let Some(r) = p.room.joints[jj] {
            top = Some(top.map_or(r.y, |t| t.max(r.y)));
        }
    }
    top
}

fn draw_people(g: &mut Canvas, w: f32, h: f32, sw: &WallMap, kinect: &KinectData) {
    let s = &sw.setup;
    let ppm = w / s.size_w;
    let to_px = |x: f32, y: f32| sw.px(x, y);
    // a 1 m grid on the wall, heights every 0.5 m
    let grid = Rgba(70.0 / 255.0, 110.0 / 255.0, 1.0, 0.55);
    let mut m = 0.0;
    while m <= s.size_w + 1e-6 {
        g.fill_rect((w - 1.0).min((m * ppm).round()), 0.0, 1.0, h, grid);
        m += 1.0;
    }
    let mut y = (s.bottom * 2.0).ceil() / 2.0;
    while y <= s.bottom + s.size_h {
        let [_, py] = to_px(0.0, y);
        g.fill_rect(0.0, (h - 1.0).min(py.round()), w, 1.0, grid);
        y += 0.5;
    }
    let f = Font::sans(px(h / 22.0), 400);
    let mut m = 1;
    while (m as f32) < s.size_w {
        g.fill_text(&format!("{m} m"), (m as f32 * ppm).round() + 3.0, h - 3.0, &f, Align::Left, Baseline::Bottom, Rgba(150.0 / 255.0, 175.0 / 255.0, 1.0, 0.9), None);
        m += 1;
    }
    // the sensor
    let sx = (s.size_w / 2.0 + s.sensor_x) * ppm;
    let [_, sy] = to_px(0.0, sw.room_height);
    g.fill_poly(&[(sx, sy - h * 0.03), (sx - h * 0.03, sy + h * 0.03), (sx + h * 0.03, sy + h * 0.03)], Rgba(1.0, 1.0, 1.0, 1.0));
    // the projection's target range and its quarters
    let [tl, tr] = sw.target();
    for q in 0..=4 {
        let x = (tl + (tr - tl) * q as f32 / 4.0) * ppm;
        g.dash = if q % 4 != 0 { vec![2.0, 6.0] } else { vec![6.0, 4.0] };
        g.line(x, 0.0, x, h, Rgba(1.0, 220.0 / 255.0, 120.0 / 255.0, 0.75));
    }
    g.dash.clear();
    for info in &sw.persons {
        let Some(p) = kinect.view.by_id(info.id) else { continue };
        let col = Rgba::hex(p.css);
        g.alpha = if info.in_zone { 1.0 } else { 0.35 };
        let rx = info.real * ppm;
        let mx = info.x * ppm;
        g.dash = vec![3.0, 3.0];
        g.line_width = 1.0;
        g.line(rx, 0.0, rx, h, Rgba(1.0, 1.0, 1.0, 0.6));
        g.dash.clear();
        g.line_width = 2.0;
        g.line(rx, h * 0.06, mx, h * 0.06, col);
        g.fill_rect(mx.round(), 0.0, 1.0, h, col);
        // the skeleton as the wall maps it
        g.line_width = 3.0;
        g.cap = tiny_skia::LineCap::Round;
        for (a, b) in BONES {
            let (Some(ja), Some(jb)) = (sw.joint(p, a), sw.joint(p, b)) else { continue };
            let [ax, ay] = to_px(ja.x, ja.y);
            let [bx, by] = to_px(jb.x, jb.y);
            g.line(ax, ay, bx, by, col);
        }
        if let Some(head) = sw.joint(p, j::HEAD) {
            let [hx, hy] = to_px(head.x, head.y);
            g.stroke_arc(hx, hy, 0.11 * ppm, 0.0, TAU, col);
        }
        let [_, fy] = to_px(0.0, info.feet);
        g.stroke_ellipse(mx, fy, 0.25 * ppm, 0.05 * ppm, col);
        let [_, ty] = to_px(0.0, info.top + 0.08);
        g.fill_text(
            &format!("{:.1} m · {:.2} / {:.2}", info.dist, info.norm.x, info.norm.z),
            mx,
            px(h / 14.0).max(ty),
            &Font::sans(px(h / 16.0), 600),
            Align::Center,
            Baseline::Bottom,
            col,
            None,
        );
        g.alpha = 1.0;
        g.line_width = 1.0;
        g.cap = tiny_skia::LineCap::Butt;
    }
}

/// The play field assistant: a small floor plan, so somebody alone in front of the wall sees where to go.
pub fn draw_wizard(g: &mut Canvas, wz: &Value, now: f64, wall: &WallMap) {
    let (w, h) = (g.width() as f32, g.height() as f32);
    let s = &wall.setup;
    g.clear();
    g.alpha = 1.0;
    g.fill_rect(0.0, 0.0, w, h, Rgba(0.0, 0.0, 0.0, 1.0));
    let far = wz.get("far").and_then(Value::as_f64).unwrap_or(4.5) as f32;
    let depth = (far + 0.6).max(4.0);
    let half = (s.size_w / 2.0 + 0.3).max((depth - s.sensor_front) * wall.tan_h + 0.3);
    let cx = s.size_w / 2.0 + s.sensor_x;
    let scale = (h * 0.9 / depth).min(w * 0.42 / (2.0 * half));
    let ox = w / 2.0 - cx * scale;
    let oy = h * 0.05;
    let p = |x: f32, z: f32| (ox + x * scale, oy + z * scale);
    // the wall and a 1 m grid
    g.line_width = 1.0;
    let gc = Rgba(80.0 / 255.0, 110.0 / 255.0, 200.0 / 255.0, 0.35);
    let mut x = (cx - half).ceil();
    while x <= cx + half {
        let (a, b) = p(x, 0.0);
        g.line(a, b, a, oy + depth * scale, gc);
        x += 1.0;
    }
    let mut z = 1.0;
    while z < depth {
        let (_, b) = p(0.0, z);
        g.line(ox + (cx - half) * scale, b, ox + (cx + half) * scale, b, gc);
        z += 1.0;
    }
    let (wx0, wy) = p(0.0, 0.0);
    g.fill_rect(wx0, wy - 3.0, s.size_w * scale, 3.0, Rgba::hex("#8fc1ff"));
    // the view cone
    let (sx, sy) = p(cx, s.sensor_front);
    let reach = depth - s.sensor_front;
    let (lx, ly) = p(cx - reach * wall.tan_h, depth);
    let (rx, ry) = p(cx + reach * wall.tan_h, depth);
    g.fill_poly(&[(sx, sy), (lx, ly), (rx, ry)], Rgba(120.0 / 255.0, 170.0 / 255.0, 1.0, 0.12));
    g.fill_rect(sx - 4.0, sy - 2.0, 8.0, 4.0, Rgba(1.0, 1.0, 1.0, 1.0));
    // the play field so far
    let pts: Vec<(f32, f32)> = wz
        .get("corners")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|c| Some((c.get(0)?.as_f64()? as f32, c.get(1)?.as_f64()? as f32))).collect())
        .unwrap_or_default();
    if pts.len() >= 2 {
        g.line_width = 2.0;
        let pp: Vec<(f32, f32)> = pts.iter().map(|(x, z)| p(*x, *z)).collect();
        g.polyline(&pp, pts.len() == 4, Rgba(1.0, 220.0 / 255.0, 120.0 / 255.0, 0.9));
    }
    for (x, z) in &pts {
        let (a, b) = p(*x, *z);
        g.fill_circle(a, b, 5.0, Rgba::hex("#ffdc78"));
    }
    // where to go: a blinking ring at the corner's rough place
    if let Some(hint) = wz.get("hint").and_then(Value::as_array)
        && let (Some(hx), Some(hz)) = (hint.first().and_then(Value::as_f64), hint.get(1).and_then(Value::as_f64))
    {
        let (a, b) = p(hx as f32, hz as f32);
        g.line_width = 2.0;
        g.dash = vec![5.0, 4.0];
        g.stroke_arc(a, b, 16.0, 0.0, TAU, Rgba(1.0, 1.0, 1.0, 0.45 + 0.4 * ((now / 180.0).sin() as f32)));
        g.dash.clear();
    }
    // the people
    let me = wz.get("person").and_then(Value::as_u64).map(|v| v as u32);
    let progress = wz.get("progress").and_then(Value::as_f64).unwrap_or(0.0) as f32;
    for q in &wall.persons {
        let (a, b) = p(q.real, q.z);
        let mine = Some(q.id) == me;
        g.fill_circle(a, b, if mine { 9.0 } else { 6.0 }, Rgba::hex(q.css));
        if mine && progress > 0.0 {
            g.line_width = 4.0;
            g.stroke_arc(a, b, 17.0, -PI / 2.0, -PI / 2.0 + TAU * progress.min(1.0), Rgba(1.0, 1.0, 1.0, 1.0));
        }
    }
    // the text, left and right of the plan
    let left = w * 0.03;
    let max_w = ox + (cx - half) * scale - left - w * 0.02;
    let title = wz.get("title").and_then(Value::as_str).unwrap_or("");
    g.fill_text(title, left, h * 0.08, &Font::sans(px(h / 13.0), 600), Align::Left, Baseline::Top, Rgba(1.0, 1.0, 1.0, 1.0), Some(max_w));
    let text = wz.get("text").and_then(Value::as_str).unwrap_or("");
    g.wrap_text(text, left, h * 0.08 + h / 9.0, max_w, h / 15.0, &Font::sans(px(h / 20.0), 400), Rgba::hex("#c8c8d4"));
    let right = ox + (cx + half) * scale + w * 0.02;
    let ok = wz.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let status = wz.get("status").and_then(Value::as_str).unwrap_or("");
    g.wrap_text(status, right, h * 0.1, w - right - w * 0.02, h / 13.0, &Font::sans(px(h / 16.0), 600), if ok { Rgba::hex("#8fe0a0") } else { Rgba::hex("#ffcf6b") });
}
